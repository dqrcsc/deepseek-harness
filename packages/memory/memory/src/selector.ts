/**
 * Multilingual `Intl.Segmenter` lexical scoring, optional dense vector RRF fusion, and budget-bounded snapshot rendering.
 * @module @deepseek-ai/dsh-memory/selector
 */

import { createHash } from 'node:crypto'
import type { EmbeddingRuntime } from '@deepseek-ai/dsh-embedding'
import { compareCanonicalContextOrder } from './domain.ts'
import type {
  MemoryCitationItem,
  MemoryContextSelection,
  MemoryRecord,
} from './types.ts'

const RRF_K = 60
const WORKSPACE_MATCH_BONUS = 0.002

const wordSegmenter = new Intl.Segmenter('und', { granularity: 'word' })
const CJK_CHAR_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

/** Options controlling relevance selection and snapshot byte/entry budgets. */
export interface SelectMemoriesOptions {
  /** Latest user prompt text used for lexical and optional dense relevance ranking. */
  readonly queryText?: string
  /** Optional embedding runtime used when `isAvailable()` reports an active provider. */
  readonly embedding?: EmbeddingRuntime
  /** Optional cancellation signal forwarded to dense embedding calls. */
  readonly signal?: AbortSignal
  /** Maximum number of entries admitted into the snapshot. */
  readonly maxInjectEntries: number
  /** Maximum UTF-8 byte length of the rendered `<user_memory>` block. */
  readonly maxInjectBytes: number
}

/**
 * Segment multilingual text into normalized word tokens plus CJK character bigrams for resilient recall.
 * @param text - input query or memory content.
 * @returns deduplicated set of lowercase tokens.
 */
export function tokenizeForRelevance(text: string): ReadonlySet<string> {
  const trimmed = text.trim().toLowerCase()
  if (trimmed.length === 0) return new Set()
  const tokens = new Set<string>()
  const cjkRun: string[] = []
  const flushCjk = (): void => {
    if (cjkRun.length === 1) {
      for (const char of cjkRun) tokens.add(char)
    } else if (cjkRun.length > 1) {
      let prev = ''
      for (const char of cjkRun) {
        if (prev !== '') tokens.add(`${prev}${char}`)
        prev = char
      }
    }
    cjkRun.length = 0
  }
  for (const segment of wordSegmenter.segment(trimmed)) {
    const part = segment.segment.trim()
    if (part.length === 0) {
      flushCjk()
      continue
    }
    if (CJK_CHAR_RE.test(part)) {
      tokens.add(part)
      for (const char of part) cjkRun.push(char)
      continue
    }
    flushCjk()
    if (segment.isWordLike) tokens.add(part)
  }
  flushCjk()
  return tokens
}

function lexicalOverlapScore(queryTokens: ReadonlySet<string>, record: MemoryRecord): number {
  if (queryTokens.size === 0) return 0
  const docTokens = tokenizeForRelevance(record.content)
  if (docTokens.size === 0) return 0
  let hits = 0
  for (const token of queryTokens) {
    if (docTokens.has(token)) hits += 1
  }
  if (hits === 0) return 0
  return hits / Math.sqrt(queryTokens.size * docTokens.size)
}

function dotProduct(left: Float32Array, right: Float32Array): number {
  const length = Math.min(left.length, right.length)
  let sum = 0
  for (let index = 0; index < length; index += 1) {
    sum += (left[index] as number) * (right[index] as number)
  }
  return sum
}

async function computeDenseScores(
  queryText: string,
  candidates: readonly MemoryRecord[],
  embedding: EmbeddingRuntime | undefined,
  signal: AbortSignal | undefined,
): Promise<ReadonlyMap<MemoryRecord['id'], number> | undefined> {
  if (embedding === undefined || !embedding.isAvailable()) return undefined
  const trimmed = queryText.trim()
  if (trimmed.length === 0 || candidates.length === 0) return undefined
  try {
    const result = await embedding.embed(
      [trimmed, ...candidates.map(item => item.content)],
      signal === undefined ? undefined : { signal },
    )
    const queryVector = result.vectors[0] as Float32Array
    const scores = new Map<MemoryRecord['id'], number>()
    for (const [index, candidate] of candidates.entries()) {
      scores.set(candidate.id, dotProduct(queryVector, result.vectors[index + 1] as Float32Array))
    }
    return scores
  } catch {
    // Transient embedding failures degrade cleanly to lexical scoring without failing the agent step.
    return undefined
  }
}

function rankGroup(
  group: readonly MemoryRecord[],
  queryTokens: ReadonlySet<string>,
  denseScores: ReadonlyMap<MemoryRecord['id'], number> | undefined,
): MemoryRecord[] {
  if (group.length <= 1) return [...group]
  const lexicalEntries = group.map(item => ({
    item,
    score: lexicalOverlapScore(queryTokens, item),
  }))
  const positiveLexical = lexicalEntries.filter(entry => entry.score > 0)
  const rrfById = new Map<MemoryRecord['id'], number>()
  if (positiveLexical.length > 0) {
    positiveLexical.sort((a, b) =>
      b.score - a.score
      || b.item.updatedAt.localeCompare(a.item.updatedAt)
      || a.item.id.localeCompare(b.item.id))
    for (const [index, entry] of positiveLexical.entries()) {
      const id = entry.item.id
      rrfById.set(id, (rrfById.get(id) ?? 0) + 1 / (RRF_K + index + 1))
    }
  }
  if (denseScores !== undefined) {
    const denseSorted = [...group].sort((a, b) =>
      (denseScores.get(b.id) ?? -1) - (denseScores.get(a.id) ?? -1)
      || b.updatedAt.localeCompare(a.updatedAt)
      || a.id.localeCompare(b.id))
    for (const [index, item] of denseSorted.entries()) {
      rrfById.set(item.id, (rrfById.get(item.id) ?? 0) + 1 / (RRF_K + index + 1))
    }
  }
  return [...group].sort((left, right) => {
    const leftScore = (rrfById.get(left.id) ?? 0) + (left.scope.kind === 'workspace' ? WORKSPACE_MATCH_BONUS : 0)
    const rightScore = (rrfById.get(right.id) ?? 0) + (right.scope.kind === 'workspace' ? WORKSPACE_MATCH_BONUS : 0)
    if (Math.abs(rightScore - leftScore) > 1e-9) return rightScore - leftScore
    return right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)
  })
}

const SNAPSHOT_HEADER = [
  '<user_memory>',
  'Durable user and workspace memories persisted across sessions. Apply them naturally when relevant without repeating them verbatim unless asked:',
].join('\n')

const SNAPSHOT_FOOTER = '</user_memory>'

function formatMemoryLine(record: MemoryRecord): string {
  const scopeTag = record.scope.kind === 'global' ? 'global' : 'workspace'
  const pinTag = record.pinned ? ', pinned' : ''
  return `- [${record.category} | ${scopeTag}${pinTag}] ${record.content.replaceAll('\n', ' ')}`
}

/**
 * Render canonical selected memories into a deterministic `<user_memory>` snapshot block.
 * @param canonicalRecords - selected memories sorted in canonical order.
 * @returns rendered snapshot text, or empty string when `canonicalRecords` is empty.
 */
export function renderMemorySnapshot(canonicalRecords: readonly MemoryRecord[]): string {
  if (canonicalRecords.length === 0) return ''
  const lines = canonicalRecords.map(formatMemoryLine)
  return `${SNAPSHOT_HEADER}\n${lines.join('\n')}\n${SNAPSHOT_FOOTER}`
}

function toCitationItem(record: MemoryRecord): MemoryCitationItem {
  const sourceSessionId = record.source.kind === 'auto'
    ? record.source.sessionId
    : record.source.kind === 'tool'
      ? record.source.sessionId
      : undefined
  return {
    id: record.id,
    content: record.content,
    category: record.category,
    scope: record.scope,
    pinned: record.pinned,
    sourceKind: record.source.kind,
    ...(sourceSessionId === undefined ? {} : { sourceSessionId }),
  }
}

/**
 * Rank applicable active memories, enforce entry/byte budgets, and return a KV-cache-stable canonical selection.
 * @param candidates - active memories matching global or current workspace scope.
 * @param options - query text, optional embedding service, and configured budgets.
 * @returns canonical digest, rendered `<user_memory>` block, and citation items.
 */
export async function selectMemoriesForContext(
  candidates: readonly MemoryRecord[],
  options: SelectMemoriesOptions,
): Promise<MemoryContextSelection> {
  if (candidates.length === 0) {
    return { digest: '', formattedText: '', items: [] }
  }
  const queryText = options.queryText ?? ''
  const queryTokens = tokenizeForRelevance(queryText)
  const denseScores = await computeDenseScores(queryText, candidates, options.embedding, options.signal)

  const pinned = candidates.filter(record => record.pinned)
  const unpinned = candidates.filter(record => !record.pinned)
  const ranked = [
    ...rankGroup(pinned, queryTokens, denseScores),
    ...rankGroup(unpinned, queryTokens, denseScores),
  ]

  const wrapperBytes = Buffer.byteLength(`${SNAPSHOT_HEADER}\n\n${SNAPSHOT_FOOTER}`, 'utf8')
  let usedBytes = wrapperBytes
  const admitted: MemoryRecord[] = []
  for (const record of ranked) {
    if (admitted.length >= options.maxInjectEntries) break
    const lineBytes = Buffer.byteLength(formatMemoryLine(record), 'utf8') + (admitted.length > 0 ? 1 : 0)
    if (usedBytes + lineBytes > options.maxInjectBytes) continue
    admitted.push(record)
    usedBytes += lineBytes
  }

  if (admitted.length === 0) {
    return { digest: '', formattedText: '', items: [] }
  }

  const canonical = [...admitted].sort(compareCanonicalContextOrder)
  const formattedText = renderMemorySnapshot(canonical)
  const digest = createHash('sha256').update(formattedText, 'utf8').digest('hex')
  return {
    digest,
    formattedText,
    items: canonical.map(toCitationItem),
  }
}
