/**
 * Lexical BM25 and hybrid dense-vector Reciprocal Rank Fusion (RRF) execution over SQLite FTS5.
 *
 * @module @deepseek-ai/dsh-session-query-sqlite/hybrid
 */

import { createHash } from 'node:crypto'
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import type EmbeddingRuntime from '@deepseek-ai/dsh-embedding'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import {
  type NormalizedEventRequest,
  type NormalizedSessionRequest,
  assertFts5OuterPredicateCount,
  assertPortableBindingCount,
  buildEventWhere,
  buildSessionWhere,
} from './query.ts'
import { buildLexicalMatchQuery, markSnippetMatch } from './segmenter.ts'

/** Standard Reciprocal Rank Fusion constant smoothing top-rank dominance. */
export const HYBRID_RRF_K = 60

/** Maximum live-session document vectors retained in process memory. */
export const LIVE_EMBEDDING_CACHE_LIMIT = 2_048

/** Session header columns shared across SQLite search projections. */
export interface SessionHeaderRow {
  session_id: string
  version: number
  created_at: number
  cwd: string | null
  parent_session: string | null
  seed_length: number | null
  delegation_depth: number | null
  agent_preset: string | null
}

/** Selected event hit row ready for snippet formatting and pagination. */
export interface SearchRow extends SessionHeaderRow {
  live: number
  persisted: number
  seq: number
  type: string
  time: number
  surface: string
  marked_text: string
  match_count: number
  document_length: number
}

/** Validated hybrid search tuning parameters. */
export interface HybridQueryOptions {
  readonly db: DatabaseSync
  readonly persistenceVisible: boolean
  readonly embedding?: EmbeddingRuntime
  readonly liveEmbeddingCache: Map<string, Float32Array>
  readonly maxEmbedDocsPerSearch: number
  readonly maxSemanticCandidates: number
  readonly minVectorScore: number
  readonly signal?: AbortSignal
}

interface RawCandidateRow extends SessionHeaderRow {
  live: number
  persisted: number
  live_fingerprint: string | null
  seq: number
  type: string
  time: number
  surface: string
  raw_text: string
  document_length: number
  phrase_hit: number
  lexical_score: number
}

interface ScoredCandidate {
  row: RawCandidateRow
  lexicalRank: number
  rrfScore: number
}

/**
 * Serialize a normalized `Float32Array` into a compact little-endian byte buffer for SQLite `BLOB` storage.
 * @param vector - unit-normalized float32 vector.
 * @returns detached `Uint8Array` view over a dedicated `ArrayBuffer`.
 */
export function encodeFloat32Vector(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength))
}

/**
 * Decode a persisted SQLite `BLOB` back into a `Float32Array` when its byte length matches `expectedDims`.
 * @param blob - raw SQLite blob bytes.
 * @param expectedDims - expected float32 element count.
 * @returns aligned `Float32Array`, or `undefined` when dimensions do not match.
 */
export function decodeFloat32Vector(blob: Uint8Array, expectedDims: number): Float32Array | undefined {
  if (expectedDims < 1 || blob.byteLength !== expectedDims * 4) return undefined
  const aligned = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength)
  return new Float32Array(aligned)
}

/**
 * Compute cosine similarity between two unit-normalized vectors via dot product.
 * @param a - first unit vector.
 * @param b - second unit vector.
 * @returns inner product, or `0` when vector lengths differ.
 */
export function dotProduct(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0
  let sum = 0
  for (let index = 0; index < a.length; index += 1) {
    sum += (a[index] as number) * (b[index] as number)
  }
  return sum
}

/**
 * Compute a compact SHA-256 content digest guarding cached persisted embeddings against text changes.
 * @param text - sanitized document text.
 * @returns URL-safe base64 SHA-256 digest.
 */
export function hashDocumentText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('base64url')
}

/**
 * Execute cross-session multilingual BM25 + phrase-boost search.
 * @param request - normalized session search request.
 * @param offset - validated pagination offset.
 * @param db - open SQLite search database.
 * @param persistenceVisible - whether persisted sessions participate in the corpus.
 * @returns `limit + 1` ranked session best-match rows starting at `offset`.
 */
export function queryLexicalSessions(
  request: NormalizedSessionRequest,
  offset: number,
  db: DatabaseSync,
  persistenceVisible: boolean,
): SearchRow[] {
  const compiled = buildLexicalMatchQuery(request.query)
  const sessionWhere = buildSessionWhere(request.sessionFilters)
  const eventWhere = buildEventWhere(request.eventFilters)
  assertFts5OuterPredicateCount(sessionWhere.predicateCount + eventWhere.predicateCount)
  const where = [sessionWhere.sql, eventWhere.sql].filter(Boolean).join(' AND ')
  const visible = persistenceVisible ? 1 : 0
  const bindings: Array<string | number> = [
    compiled.expression,
    visible,
    visible,
    compiled.expression,
    request.query,
    ...sessionWhere.params,
    ...eventWhere.params,
    request.limit + 1,
    offset,
  ]
  assertPortableBindingCount(bindings.length)
  const rawRows = db.prepare(`
    ${lexicalCandidatesCte()},
    filtered AS (
      SELECT * FROM matched ${where.length === 0 ? '' : `WHERE ${where}`}
    ),
    ranked AS (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY session_id
        ORDER BY phrase_hit DESC, lexical_score DESC, document_length ASC, time DESC, seq DESC
      ) AS event_rank
      FROM filtered
    )
    SELECT * FROM ranked
    WHERE event_rank = 1
    ORDER BY phrase_hit DESC, lexical_score DESC, document_length ASC, time DESC, session_id ASC, seq DESC
    LIMIT ? OFFSET ?
  `).all(...bindings)
  return rawRows.map(record => toSearchRow(parseRawCandidateRow(record), compiled.highlightTerms))
}

/**
 * Execute within-session multilingual BM25 + phrase-boost search.
 * @param request - normalized event search request.
 * @param offset - validated pagination offset.
 * @param db - open SQLite search database.
 * @param persistenceVisible - whether persisted sessions participate in the corpus.
 * @returns `limit + 1` ranked event rows starting at `offset`.
 */
export function queryLexicalEvents(
  request: NormalizedEventRequest,
  offset: number,
  db: DatabaseSync,
  persistenceVisible: boolean,
): SearchRow[] {
  const compiled = buildLexicalMatchQuery(request.query)
  const eventWhere = buildEventWhere(request.filters)
  assertFts5OuterPredicateCount(1 + eventWhere.predicateCount)
  const where = ['session_id = ?', eventWhere.sql].filter(Boolean).join(' AND ')
  const visible = persistenceVisible ? 1 : 0
  const bindings: Array<string | number> = [
    compiled.expression,
    visible,
    visible,
    compiled.expression,
    request.query,
    request.sessionId,
    ...eventWhere.params,
    request.limit + 1,
    offset,
  ]
  assertPortableBindingCount(bindings.length)
  const rawRows = db.prepare(`
    ${lexicalCandidatesCte()}
    SELECT * FROM matched
    WHERE ${where}
    ORDER BY phrase_hit DESC, lexical_score DESC, document_length ASC, time DESC, seq DESC
    LIMIT ? OFFSET ?
  `).all(...bindings)
  return rawRows.map(record => toSearchRow(parseRawCandidateRow(record), compiled.highlightTerms))
}

/**
 * Execute cross-session hybrid search (BM25 + dense vector RRF when `embedding` is active, lexical BM25 otherwise).
 * @param request - normalized session search request.
 * @param offset - validated pagination offset.
 * @param options - database, optional embedding runtime, and hybrid tuning bounds.
 * @returns `limit + 1` ranked session best-match rows starting at `offset`.
 */
export async function queryHybridSessions(
  request: NormalizedSessionRequest,
  offset: number,
  options: HybridQueryOptions,
): Promise<SearchRow[]> {
  const embedding = options.embedding
  if (embedding === undefined || !embedding.isAvailable()) {
    return queryLexicalSessions(request, offset, options.db, options.persistenceVisible)
  }

  const queryVectorResult = await tryEmbedQuery(embedding, request.query, options.signal)
  if (queryVectorResult === undefined) {
    return queryLexicalSessions(request, offset, options.db, options.persistenceVisible)
  }

  const sessionWhere = buildSessionWhere(request.sessionFilters)
  const eventWhere = buildEventWhere(request.eventFilters)
  assertFts5OuterPredicateCount(sessionWhere.predicateCount + eventWhere.predicateCount)
  const where = [sessionWhere.sql, eventWhere.sql].filter(Boolean).join(' AND ')
  const whereParams = [...sessionWhere.params, ...eventWhere.params]
  const { fused, highlightTerms } = await runFusedHybridPool(
    request.query,
    request.limit,
    offset,
    where,
    whereParams,
    queryVectorResult,
    embedding,
    options,
  )

  // `fused` is already strictly ordered strongest-first; the first appearance of
  // each `session_id` is its strongest event in exact session rank order.
  const seenSessions = new Set<string>()
  const rankedSessions: ScoredCandidate[] = []
  for (const candidate of fused) {
    if (seenSessions.has(candidate.row.session_id)) continue
    seenSessions.add(candidate.row.session_id)
    rankedSessions.push(candidate)
  }
  return rankedSessions
    .slice(offset, offset + request.limit + 1)
    .map(item => toSearchRow(item.row, highlightTerms))
}

/**
 * Execute within-session hybrid search (BM25 + dense vector RRF when `embedding` is active, lexical BM25 otherwise).
 * @param request - normalized event search request.
 * @param offset - validated pagination offset.
 * @param options - database, optional embedding runtime, and hybrid tuning bounds.
 * @returns `limit + 1` ranked event rows starting at `offset`.
 */
export async function queryHybridEvents(
  request: NormalizedEventRequest,
  offset: number,
  options: HybridQueryOptions,
): Promise<SearchRow[]> {
  const embedding = options.embedding
  if (embedding === undefined || !embedding.isAvailable()) {
    return queryLexicalEvents(request, offset, options.db, options.persistenceVisible)
  }

  const queryVectorResult = await tryEmbedQuery(embedding, request.query, options.signal)
  if (queryVectorResult === undefined) {
    return queryLexicalEvents(request, offset, options.db, options.persistenceVisible)
  }

  const eventWhere = buildEventWhere(request.filters)
  assertFts5OuterPredicateCount(1 + eventWhere.predicateCount)
  const where = ['session_id = ?', eventWhere.sql].filter(Boolean).join(' AND ')
  const whereParams: Array<string | number> = [request.sessionId, ...eventWhere.params]
  const { fused, highlightTerms } = await runFusedHybridPool(
    request.query,
    request.limit,
    offset,
    where,
    whereParams,
    queryVectorResult,
    embedding,
    options,
  )

  return fused
    .slice(offset, offset + request.limit + 1)
    .map(item => toSearchRow(item.row, highlightTerms))
}

async function runFusedHybridPool(
  query: string,
  limit: number,
  offset: number,
  where: string,
  whereParams: readonly (string | number)[],
  queryVectorResult: { modelId: string; vector: Float32Array },
  embedding: EmbeddingRuntime,
  options: HybridQueryOptions,
): Promise<{ fused: ScoredCandidate[]; highlightTerms: readonly string[] }> {
  const compiled = buildLexicalMatchQuery(query)
  const poolCap = Math.max(options.maxSemanticCandidates, offset + limit + 1)
  const lexicalRows = fetchAllLexicalMatches(
    options.db,
    compiled.expression,
    query,
    options.persistenceVisible,
    where,
    whereParams,
    poolCap,
  )
  const semanticPool = fetchRecentSemanticCandidates(
    options.db,
    options.persistenceVisible,
    where,
    whereParams,
    options.maxSemanticCandidates,
  )
  const fused = await scoreAndFuseCandidates(
    lexicalRows,
    semanticPool,
    queryVectorResult.modelId,
    queryVectorResult.vector,
    embedding,
    options,
  )
  return { fused, highlightTerms: compiled.highlightTerms }
}

async function tryEmbedQuery(
  embedding: EmbeddingRuntime,
  query: string,
  signal: AbortSignal | undefined,
): Promise<{ modelId: string; vector: Float32Array } | undefined> {
  try {
    const result = await embedding.embed([query], signal === undefined ? undefined : { signal })
    const vector = result.vectors[0]
    /* v8 ignore next -- EmbeddingRuntime.embed([query]) guarantees exactly 1 normalized vector */
    if (vector === undefined) return undefined
    return { modelId: result.modelId, vector }
  } catch (error: unknown) {
    rethrowIfSearchAborted(error, signal)
    return undefined
  }
}

async function scoreAndFuseCandidates(
  lexicalRows: readonly RawCandidateRow[],
  semanticPool: readonly RawCandidateRow[],
  modelId: string,
  queryVector: Float32Array,
  embedding: EmbeddingRuntime,
  options: HybridQueryOptions,
): Promise<ScoredCandidate[]> {
  const byKey = new Map<string, { row: RawCandidateRow; lexicalRank?: number }>()
  for (let idx = 0; idx < lexicalRows.length; idx += 1) {
    const row = lexicalRows[idx] as RawCandidateRow
    byKey.set(candidateKey(row.session_id, row.seq), { row, lexicalRank: idx + 1 })
  }
  for (const row of semanticPool) {
    const key = candidateKey(row.session_id, row.seq)
    if (!byKey.has(key)) {
      byKey.set(key, { row })
    }
  }

  const allEntries = [...byKey.values()]
  const vectorsByKey = loadCachedCandidateVectors(
    options.db,
    allEntries.map(entry => entry.row),
    modelId,
    queryVector.length,
    options.liveEmbeddingCache,
  )

  if (options.maxEmbedDocsPerSearch > 0) {
    const missingRows: RawCandidateRow[] = []
    for (const entry of allEntries) {
      const key = candidateKey(entry.row.session_id, entry.row.seq)
      if (vectorsByKey.has(key)) continue
      missingRows.push(entry.row)
      if (missingRows.length >= options.maxEmbedDocsPerSearch) break
    }
    if (missingRows.length > 0) {
      await backfillCandidateVectors(
        missingRows,
        modelId,
        embedding,
        vectorsByKey,
        options,
      )
    }
  }

  const vectorScored: Array<{ key: string; score: number; row: RawCandidateRow }> = []
  for (const entry of allEntries) {
    const key = candidateKey(entry.row.session_id, entry.row.seq)
    const docVec = vectorsByKey.get(key)
    if (docVec === undefined) continue
    const score = dotProduct(queryVector, docVec)
    if (score >= options.minVectorScore) {
      vectorScored.push({ key, score, row: entry.row })
    }
  }
  vectorScored.sort((a, b) => (
    (b.score - a.score)
    || (b.row.time - a.row.time)
    || a.row.session_id.localeCompare(b.row.session_id)
    || (b.row.seq - a.row.seq)
  ))

  const vectorRankByKey = new Map<string, number>()
  for (let idx = 0; idx < vectorScored.length; idx += 1) {
    const item = vectorScored[idx] as { key: string; score: number }
    vectorRankByKey.set(item.key, idx + 1)
  }

  const fused: ScoredCandidate[] = []
  for (const entry of allEntries) {
    const key = candidateKey(entry.row.session_id, entry.row.seq)
    const vectorRank = vectorRankByKey.get(key)
    if (entry.lexicalRank === undefined && vectorRank === undefined) continue
    const lexTerm = entry.lexicalRank === undefined ? 0 : 1 / (HYBRID_RRF_K + entry.lexicalRank)
    const vecTerm = vectorRank === undefined ? 0 : 1 / (HYBRID_RRF_K + vectorRank)
    fused.push({
      row: entry.row,
      lexicalRank: entry.lexicalRank ?? Number.MAX_SAFE_INTEGER,
      rrfScore: lexTerm + vecTerm,
    })
  }

  fused.sort(compareCandidates)
  return fused
}

function loadCachedCandidateVectors(
  db: DatabaseSync,
  rows: readonly RawCandidateRow[],
  modelId: string,
  expectedDims: number,
  liveEmbeddingCache: Map<string, Float32Array>,
): Map<string, Float32Array> {
  const result = new Map<string, Float32Array>()
  const persistedSessionIds = new Set<string>()
  for (const row of rows) {
    if (row.live === 1) {
      const cacheKey = liveCacheKey(modelId, String(row.live_fingerprint), row.seq)
      const cached = liveEmbeddingCache.get(cacheKey)
      if (cached !== undefined && cached.length === expectedDims) {
        result.set(candidateKey(row.session_id, row.seq), cached)
      }
    } else {
      persistedSessionIds.add(row.session_id)
    }
  }

  if (persistedSessionIds.size === 0) return result

  const textByKey = new Map<string, string>()
  for (const row of rows) {
    if (row.live === 0) {
      textByKey.set(candidateKey(row.session_id, row.seq), row.raw_text)
    }
  }

  const selectStmt = db.prepare(`
    SELECT seq, text_hash, dims, vector
    FROM persisted_embeddings
    WHERE session_id = ? AND model_id = ?
  `)
  for (const sessionId of persistedSessionIds) {
    const storedRows = selectStmt.all(sessionId, modelId)
    for (const stored of storedRows) {
      const seq = Number(stored['seq'])
      const key = candidateKey(sessionId, seq)
      const expectedText = textByKey.get(key)
      if (expectedText === undefined) continue
      const storedHash = String(stored['text_hash'])
      const dims = Number(stored['dims'])
      if (dims !== expectedDims || storedHash !== hashDocumentText(expectedText)) continue
      const rawVector = stored['vector'] as Uint8Array
      const decoded = decodeFloat32Vector(rawVector, expectedDims)
      if (decoded !== undefined) {
        result.set(key, decoded)
      }
    }
  }
  return result
}

async function backfillCandidateVectors(
  missingRows: readonly RawCandidateRow[],
  modelId: string,
  embedding: EmbeddingRuntime,
  vectorsByKey: Map<string, Float32Array>,
  options: HybridQueryOptions,
): Promise<void> {
  let embedResult
  try {
    embedResult = await embedding.embed(
      missingRows.map(row => row.raw_text),
      options.signal === undefined ? undefined : { signal: options.signal },
    )
  } catch (error: unknown) {
    rethrowIfSearchAborted(error, options.signal)
    return
  }
  if (embedResult.modelId !== modelId) return

  const persistedWrites: Array<{ row: RawCandidateRow; vector: Float32Array }> = []
  for (let idx = 0; idx < missingRows.length; idx += 1) {
    const row = missingRows[idx] as RawCandidateRow
    const vec = embedResult.vectors[idx] as Float32Array
    vectorsByKey.set(candidateKey(row.session_id, row.seq), vec)
    if (row.live === 1) {
      rememberLiveVector(options.liveEmbeddingCache, liveCacheKey(modelId, String(row.live_fingerprint), row.seq), vec)
    } else {
      persistedWrites.push({ row, vector: vec })
    }
  }

  if (persistedWrites.length === 0) return

  const insertStmt = options.db.prepare(`
    INSERT OR REPLACE INTO persisted_embeddings (session_id, seq, model_id, text_hash, dims, vector)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  let began = false
  try {
    options.db.exec('BEGIN IMMEDIATE')
    began = true
    for (const { row, vector } of persistedWrites) {
      insertStmt.run(
        row.session_id,
        row.seq,
        modelId,
        hashDocumentText(row.raw_text),
        vector.length,
        encodeFloat32Vector(vector),
      )
    }
    options.db.exec('COMMIT')
  } catch (_error: unknown) {
    /* v8 ignore next 6 -- defensive rollback on SQLite write fault during optional vector caching */
    if (began) {
      try {
        options.db.exec('ROLLBACK')
      } catch (_rollbackError: unknown) {
        // Keep primary write error or degrade gracefully without failing lexical/in-memory results.
      }
    }
  }
}

function rememberLiveVector(cache: Map<string, Float32Array>, key: string, vector: Float32Array): void {
  cache.delete(key)
  while (cache.size >= LIVE_EMBEDDING_CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    /* v8 ignore next -- LIVE_EMBEDDING_CACHE_LIMIT >= 1 guarantees a first key */
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  cache.set(key, vector)
}

function fetchAllLexicalMatches(
  db: DatabaseSync,
  expression: string,
  rawQuery: string,
  persistenceVisible: boolean,
  where: string,
  whereParams: readonly (string | number)[],
  limit: number,
): RawCandidateRow[] {
  const visible = persistenceVisible ? 1 : 0
  const bindings: Array<string | number> = [
    expression,
    visible,
    visible,
    expression,
    rawQuery,
    ...whereParams,
    limit,
  ]
  assertPortableBindingCount(bindings.length)
  const rows = db.prepare(`
    ${lexicalCandidatesCte()}
    SELECT * FROM matched
    ${where.length === 0 ? '' : `WHERE ${where}`}
    ORDER BY phrase_hit DESC, lexical_score DESC, document_length ASC, time DESC, seq DESC
    LIMIT ?
  `).all(...bindings)
  return rows.map(parseRawCandidateRow)
}

function fetchRecentSemanticCandidates(
  db: DatabaseSync,
  persistenceVisible: boolean,
  where: string,
  whereParams: readonly (string | number)[],
  limit: number,
): RawCandidateRow[] {
  const visible = persistenceVisible ? 1 : 0
  const bindings: Array<string | number> = [
    visible,
    visible,
    ...whereParams,
    limit,
  ]
  assertPortableBindingCount(bindings.length)
  const rows = db.prepare(`
    WITH pool AS (
      SELECT
        pd.session_id AS session_id,
        ps.version AS version,
        ps.created_at AS created_at,
        ps.cwd AS cwd,
        ps.parent_session AS parent_session,
        ps.seed_length AS seed_length,
        ps.delegation_depth AS delegation_depth,
        ps.agent_preset AS agent_preset,
        0 AS live,
        1 AS persisted,
        NULL AS live_fingerprint,
        CAST(pd.seq AS INTEGER) AS seq,
        pd.type AS type,
        CAST(pd.time AS INTEGER) AS time,
        pd.surface AS surface,
        pd.text AS raw_text,
        CAST(pd.codepoint_length AS INTEGER) AS document_length,
        0 AS phrase_hit,
        0.0 AS lexical_score
      FROM persisted_docs AS pd
      JOIN persisted_sessions AS ps ON ps.id = pd.session_id
      WHERE ? = 1
        AND NOT EXISTS (SELECT 1 FROM temp.live_sessions AS ls WHERE ls.id = pd.session_id)
      UNION ALL
      SELECT
        ld.session_id AS session_id,
        ls.version AS version,
        ls.created_at AS created_at,
        ls.cwd AS cwd,
        ls.parent_session AS parent_session,
        ls.seed_length AS seed_length,
        ls.delegation_depth AS delegation_depth,
        ls.agent_preset AS agent_preset,
        1 AS live,
        CASE WHEN ? = 1 THEN ls.persisted ELSE 0 END AS persisted,
        ls.fingerprint AS live_fingerprint,
        CAST(ld.seq AS INTEGER) AS seq,
        ld.type AS type,
        CAST(ld.time AS INTEGER) AS time,
        ld.surface AS surface,
        ld.text AS raw_text,
        CAST(ld.codepoint_length AS INTEGER) AS document_length,
        0 AS phrase_hit,
        0.0 AS lexical_score
      FROM temp.live_docs AS ld
      JOIN temp.live_sessions AS ls ON ls.id = ld.session_id
    )
    SELECT * FROM pool
    ${where.length === 0 ? '' : `WHERE ${where}`}
    ORDER BY time DESC, seq DESC, session_id ASC
    LIMIT ?
  `).all(...bindings)
  return rows.map(parseRawCandidateRow)
}

function lexicalCandidatesCte(): string {
  return `WITH candidates AS (
    SELECT
      pd.session_id AS session_id,
      ps.version AS version,
      ps.created_at AS created_at,
      ps.cwd AS cwd,
      ps.parent_session AS parent_session,
      ps.seed_length AS seed_length,
      ps.delegation_depth AS delegation_depth,
      ps.agent_preset AS agent_preset,
      0 AS live,
      1 AS persisted,
      NULL AS live_fingerprint,
      CAST(pd.seq AS INTEGER) AS seq,
      pd.type AS type,
      CAST(pd.time AS INTEGER) AS time,
      pd.surface AS surface,
      pd.text AS raw_text,
      CAST(pd.codepoint_length AS INTEGER) AS document_length,
      -bm25(persisted_docs, 2.0, 1.0) AS lexical_score
    FROM persisted_docs AS pd
    JOIN persisted_sessions AS ps ON ps.id = pd.session_id
    WHERE persisted_docs MATCH ?
      AND ? = 1
      AND NOT EXISTS (SELECT 1 FROM temp.live_sessions AS ls WHERE ls.id = pd.session_id)
    UNION ALL
    SELECT
      ld.session_id AS session_id,
      ls.version AS version,
      ls.created_at AS created_at,
      ls.cwd AS cwd,
      ls.parent_session AS parent_session,
      ls.seed_length AS seed_length,
      ls.delegation_depth AS delegation_depth,
      ls.agent_preset AS agent_preset,
      1 AS live,
      CASE WHEN ? = 1 THEN ls.persisted ELSE 0 END AS persisted,
      ls.fingerprint AS live_fingerprint,
      CAST(ld.seq AS INTEGER) AS seq,
      ld.type AS type,
      CAST(ld.time AS INTEGER) AS time,
      ld.surface AS surface,
      ld.text AS raw_text,
      CAST(ld.codepoint_length AS INTEGER) AS document_length,
      -bm25(live_docs, 2.0, 1.0) AS lexical_score
    FROM temp.live_docs AS ld
    JOIN temp.live_sessions AS ls ON ls.id = ld.session_id
    WHERE live_docs MATCH ?
  ), matched AS (
    SELECT *,
      CASE WHEN instr(lower(raw_text), lower(?)) > 0 THEN 1 ELSE 0 END AS phrase_hit
    FROM candidates
  )`
}

function compareCandidates(a: ScoredCandidate, b: ScoredCandidate): number {
  return (b.rrfScore - a.rrfScore) || (a.lexicalRank - b.lexicalRank)
}

function toSearchRow(raw: RawCandidateRow, highlightTerms: readonly string[]): SearchRow {
  const marked = markSnippetMatch(raw.raw_text, highlightTerms)
  return {
    session_id: raw.session_id,
    version: raw.version,
    created_at: raw.created_at,
    cwd: raw.cwd,
    parent_session: raw.parent_session,
    seed_length: raw.seed_length,
    delegation_depth: raw.delegation_depth,
    agent_preset: raw.agent_preset,
    live: raw.live,
    persisted: raw.persisted,
    seq: raw.seq,
    type: raw.type,
    time: raw.time,
    surface: raw.surface,
    marked_text: marked,
    match_count: raw.phrase_hit > 0 ? 1 : 0,
    document_length: raw.document_length,
  }
}

function parseRawCandidateRow(record: Record<string, SQLOutputValue>): RawCandidateRow {
  return {
    session_id: String(record['session_id']),
    version: Number(record['version']),
    created_at: Number(record['created_at']),
    cwd: record['cwd'] as string | null,
    parent_session: record['parent_session'] as string | null,
    seed_length: record['seed_length'] as number | null,
    delegation_depth: record['delegation_depth'] as number | null,
    agent_preset: record['agent_preset'] as string | null,
    live: Number(record['live']),
    persisted: Number(record['persisted']),
    live_fingerprint: record['live_fingerprint'] as string | null,
    seq: Number(record['seq']),
    type: String(record['type']),
    time: Number(record['time']),
    surface: String(record['surface']),
    raw_text: String(record['raw_text']),
    document_length: Number(record['document_length']),
    phrase_hit: Number(record['phrase_hit']),
    lexical_score: Number(record['lexical_score']),
  }
}

function candidateKey(sessionId: string, seq: number): string {
  return `${sessionId}\0${String(seq)}`
}

function liveCacheKey(modelId: string, fingerprint: string, seq: number): string {
  return `${modelId}\0${fingerprint}\0${String(seq)}`
}

function rethrowIfSearchAborted(error: unknown, signal: AbortSignal | undefined): void {
  if (signal?.aborted || (error instanceof Error && (error as { code?: unknown }).code === 'EMBEDDING_ABORTED')) {
    throw new SessionQueryError('session-search aborted', 'SESSION_QUERY_ABORTED', { cause: error })
  }
}
