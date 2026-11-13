/**
 * Multilingual word and CJK bigram segmentation for SQLite FTS5 indexing and snippet highlighting.
 *
 * @module @deepseek-ai/dsh-session-query-sqlite/segmenter
 */

import { FTS_HIGHLIGHT_END, FTS_HIGHLIGHT_START, quoteFtsData } from './query.ts'

/** Maximum distinct query terms compiled into one lexical FTS5 disjunction. */
export const MAX_LEXICAL_QUERY_TERMS = 64

const WORD_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'word' })
const CJK_RUN_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu

/** Compiled lexical FTS5 expression and ordered plain-text highlight candidates. */
export interface CompiledLexicalQuery {
  /** Safe FTS5 `MATCH` expression over `text` and `segmented_text`. */
  readonly expression: string
  /** Non-empty plain-text substrings ordered from most specific to individual tokens. */
  readonly highlightTerms: readonly string[]
}

/**
 * Extract lowercased word segments and CJK character bigrams in encounter order.
 * @param text - sanitized document or query text.
 * @returns ordered search tokens suitable for FTS5 indexing or query expansion.
 */
export function extractSearchTerms(text: string): string[] {
  const tokens: string[] = []
  for (const part of WORD_SEGMENTER.segment(text)) {
    if (part.isWordLike) {
      tokens.push(part.segment.toLowerCase())
    }
  }
  for (const match of text.matchAll(CJK_RUN_RE)) {
    const chars = Array.from(match[0].toLowerCase())
    if (chars.length === 1) {
      tokens.push(chars[0] as string)
      continue
    }
    for (let index = 0; index < chars.length - 1; index += 1) {
      tokens.push(`${chars[index] as string}${chars[index + 1] as string}`)
    }
  }
  return tokens
}

/**
 * Segment sanitized document text into space-delimited FTS5 tokens.
 * @param text - sanitized semantic document text.
 * @returns space-separated token stream for the `segmented_text` FTS5 column.
 */
export function segmentDocumentText(text: string): string {
  return extractSearchTerms(text).join(' ')
}

/**
 * Build a syntax-inert FTS5 query combining exact phrase boost on `text` with BM25 disjunction on `segmented_text`.
 * @param query - normalized non-empty caller query.
 * @returns compiled FTS5 `MATCH` expression and highlight candidate terms.
 */
export function buildLexicalMatchQuery(query: string): CompiledLexicalQuery {
  const seen = new Set<string>()
  const uniqueTerms: string[] = []
  for (const term of extractSearchTerms(query)) {
    if (seen.has(term)) continue
    seen.add(term)
    uniqueTerms.push(term)
    if (uniqueTerms.length >= MAX_LEXICAL_QUERY_TERMS) break
  }

  const phraseExpr = `text : ${quoteFtsData(query)}`
  if (uniqueTerms.length === 0) {
    return {
      expression: phraseExpr,
      highlightTerms: [query],
    }
  }

  const termDisjunction = uniqueTerms.map(quoteFtsData).join(' OR ')
  const highlightSet = new Set<string>([query, ...uniqueTerms])
  return {
    expression: `(${phraseExpr} OR segmented_text : (${termDisjunction}))`,
    highlightTerms: [...highlightSet],
  }
}

/**
 * Insert collision-free highlight markers around the strongest literal term occurrence in `rawText`.
 * When a hit comes purely from dense vector similarity with zero literal overlap, `rawText` is returned unmarked.
 * @param rawText - sanitized plain document text.
 * @param highlightTerms - candidate substrings ordered by specificity.
 * @returns marked text ready for `makeSnippet()`.
 */
export function markSnippetMatch(rawText: string, highlightTerms: readonly string[]): string {
  const lowerText = rawText.toLowerCase()
  for (const candidate of highlightTerms) {
    const needle = candidate.toLowerCase()
    const index = lowerText.indexOf(needle)
    if (index === -1) continue
    return `${rawText.slice(0, index)}${FTS_HIGHLIGHT_START}${rawText.slice(index, index + needle.length)}${FTS_HIGHLIGHT_END}${rawText.slice(index + needle.length)}`
  }
  return rawText
}
