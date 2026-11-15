/** Pure query-token segmentation and case-insensitive snippet highlight splitting. */

const WORD_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'word' })
const CJK_TOKEN_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

/** Contiguous plain or matched span inside a rendered search snippet. */
export interface SnippetSegment {
  readonly text: string
  readonly match: boolean
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function keepSubToken(token: string): boolean {
  return token.length >= 2 || CJK_TOKEN_CHAR.test(token)
}

/**
 * Extract unique highlight candidate terms ordered longest-first from a raw query.
 * @param query - user search input.
 * @returns deduplicated candidate terms ordered longest-first, or empty for blank input.
 */
export function extractSearchHighlightTerms(query: string): readonly string[] {
  const trimmed = query.trim()
  if (trimmed === '') return []
  const byFolded = new Map<string, string>()
  const record = (term: string): void => {
    const key = term.toLowerCase()
    if (!byFolded.has(key)) byFolded.set(key, term)
  }
  record(trimmed)
  for (const part of trimmed.split(/\s+/u)) {
    if (keepSubToken(part)) record(part)
  }
  for (const { segment, isWordLike } of WORD_SEGMENTER.segment(trimmed)) {
    if (isWordLike === true && keepSubToken(segment)) record(segment)
  }
  return [...byFolded.values()].sort((left, right) => right.length - left.length)
}

/**
 * Split a plain-text search snippet into alternating unmatched and matched spans.
 * @param snippet - plain-text snippet returned by session search.
 * @param query - active search query.
 * @returns ordered spans whose concatenated `text` equals `snippet`.
 */
export function splitSnippetHighlights(snippet: string, query: string): readonly SnippetSegment[] {
  if (snippet === '') return []
  const terms = extractSearchHighlightTerms(query)
  if (terms.length === 0) return [{ text: snippet, match: false }]
  const pattern = new RegExp(terms.map(escapeRegExp).join('|'), 'giu')
  const segments: SnippetSegment[] = []
  let cursor = 0
  for (const hit of snippet.matchAll(pattern)) {
    const matched = hit[0]
    const index = hit.index
    if (index > cursor) segments.push({ text: snippet.slice(cursor, index), match: false })
    segments.push({ text: matched, match: true })
    cursor = index + matched.length
  }
  if (segments.length === 0) return [{ text: snippet, match: false }]
  if (cursor < snippet.length) segments.push({ text: snippet.slice(cursor), match: false })
  return segments
}
