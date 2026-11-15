import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import EmbeddingRuntime, { EmbeddingError } from '@deepseek-ai/dsh-embedding'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { type SessionQueryErrorCode, type SessionSearchRequest } from '@deepseek-ai/dsh-session-query'
import SqliteSessionQueryEngine, { type Config } from '../src/index.ts'
import {
  LIVE_EMBEDDING_CACHE_LIMIT,
  decodeFloat32Vector,
  dotProduct,
  encodeFloat32Vector,
  hashDocumentText,
} from '../src/hybrid.ts'
import {
  MAX_LEXICAL_QUERY_TERMS,
  buildLexicalMatchQuery,
  extractSearchTerms,
  markSnippetMatch,
  segmentDocumentText,
} from '../src/segmenter.ts'
import {
  FTS_HIGHLIGHT_END,
  FTS_HIGHLIGHT_START,
  normalizeEventRequest,
  normalizeSessionRequest,
  requestFingerprint,
} from '../src/query.ts'
import { openSearchDatabase } from '../src/schema.ts'
import { afterEach, describe, expect, it } from 'vitest'

const tempDirs: string[] = []

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-hybrid-search-'))
  tempDirs.push(dir)
  return dir
}

function expectCode(code: SessionQueryErrorCode): Error {
  return expect.objectContaining({ code }) as Error
}

describe('multilingual segmenter and snippet marker helpers', () => {
  it('segments Latin words, single-character CJK runs, and multi-character CJK bigrams', () => {
    const singleCjk = extractSearchTerms('慢 query')
    expect(singleCjk).toContain('慢')
    expect(singleCjk).toContain('query')

    const cjkCompound = segmentDocumentText('今天配置了PostgreSQL连接池超时参数')
    expect(cjkCompound).toContain('postgresql')
    expect(cjkCompound).toContain('连接')
    expect(cjkCompound).toContain('接池')
    expect(cjkCompound).toContain('超时')
  })

  it('compiles lexical FTS5 queries, handles symbol-only queries, and caps term count', () => {
    const symbolOnly = buildLexicalMatchQuery('::')
    expect(symbolOnly.expression).toBe('text : "::"')
    expect(symbolOnly.highlightTerms).toEqual(['::'])

    const manyWords = Array.from({ length: MAX_LEXICAL_QUERY_TERMS + 10 }, (_, idx) => `tok${String(idx)} tok0`).join(' ')
    const capped = buildLexicalMatchQuery(manyWords)
    expect(capped.highlightTerms.length).toBeLessThanOrEqual(MAX_LEXICAL_QUERY_TERMS + 1)
    expect(capped.expression).toContain('segmented_text : (')

    expect(markSnippetMatch('今天排查了连接池耗尽问题', ['连接池 超时', '连接池'])).toBe(
      `今天排查了${FTS_HIGHLIGHT_START}连接池${FTS_HIGHLIGHT_END}耗尽问题`,
    )
    expect(markSnippetMatch('pure semantic vector match', ['连接池'])).toBe('pure semantic vector match')
  })

  it('encodes/decodes float32 blobs, computes dot products, and validates search modes', () => {
    const unit = new Float32Array([0.6, 0.8])
    const blob = encodeFloat32Vector(unit)
    const decoded = decodeFloat32Vector(blob, 2)
    expect(decoded).toBeDefined()
    expect(dotProduct(unit, decoded as Float32Array)).toBeCloseTo(1, 5)
    expect(decodeFloat32Vector(blob, 0)).toBeUndefined()
    expect(decodeFloat32Vector(blob, 3)).toBeUndefined()
    expect(dotProduct(unit, new Float32Array([1, 0, 0]))).toBe(0)
    expect(hashDocumentText('abc')).toBe(hashDocumentText('abc'))

    const limits = { defaultLimit: 5, maxLimit: 10 }
    const normSession = normalizeSessionRequest({ query: 'test', mode: 'hybrid' }, limits)
    expect(normSession.mode).toBe('hybrid')
    const normEvent = normalizeEventRequest({ sessionId: SessionId('s1'), query: 'test', mode: 'lexical' }, limits)
    expect(normEvent.mode).toBe('lexical')
    expect(requestFingerprint(normSession, 'mock:v1')).not.toBe(requestFingerprint(normSession, 'mock:v2'))
    expect(requestFingerprint(normEvent, 'mock:v1')).toContain('mock:v1')
    expect(() => normalizeSessionRequest(
      JSON.parse('{ "query": "x", "mode": "bad" }') as SessionSearchRequest,
      limits,
    )).toThrow(expectCode('SESSION_QUERY_INVALID_QUERY'))
  })
})

describe('SqliteSessionQueryEngine busy_timeout, lexical CJK, and hybrid RRF', () => {
  it('applies busyTimeoutMs and validates new hybrid configuration bounds', async () => {
    const dir = await makeTempDir()
    const dbPath = join(dir, 'busy.db')
    const db = await openSearchDatabase(dbPath, 'wal', 7_500)
    try {
      const row = db.prepare('PRAGMA busy_timeout').get() as { timeout: number }
      expect(row.timeout).toBe(7_500)
    } finally {
      db.close()
    }

    const defaultDb = await openSearchDatabase(':memory:', 'wal')
    defaultDb.close()

    const makeInvalid = (extra: Partial<Config>) => {
      const ctx = new Context()
      new SessionStore(ctx)
      return new SqliteSessionQueryEngine(ctx, { path: ':memory:', openAt: 'never', ...extra })
    }
    expect(() => makeInvalid({ busyTimeoutMs: -1 })).toThrow(expectCode('SESSION_QUERY_INVALID_CONFIG'))
    expect(() => makeInvalid({ maxEmbedDocsPerSearch: -1 })).toThrow(expectCode('SESSION_QUERY_INVALID_CONFIG'))
    expect(() => makeInvalid({ maxSemanticCandidates: 0 })).toThrow(expectCode('SESSION_QUERY_INVALID_CONFIG'))
    expect(() => makeInvalid({ minVectorScore: 1.5 })).toThrow(expectCode('SESSION_QUERY_INVALID_CONFIG'))
    expect(() => makeInvalid({ minVectorScore: Number.NaN })).toThrow(expectCode('SESSION_QUERY_INVALID_CONFIG'))
  })

  it('recalls Chinese compounds and multi-word queries in lexical and zero-config hybrid modes', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SqliteSessionQueryEngine, { path: ':memory:', openAt: 'first-search' })

    try {
      const s1 = ctx.sessions.create(SessionId('zh-pool'), { meta: { cwd: '/projects/backend' } })
      s1.append('user/message', createUserMessage({
        content: [{ type: 'text', text: '今天配置了PostgreSQL数据库连接池超时重试参数' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      s1.append('user/message', createUserMessage({
        content: [{ type: 'text', text: '连接池超时已经修复并上线' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })

      const s2 = ctx.sessions.create(SessionId('en-retry'), { meta: { cwd: '/projects/worker' } })
      s2.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'configured exponential retry backoff after socket timeout' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })

      // Phrase mode (default) finds 0 hits for non-contiguous "连接池 超时".
      const phraseMiss = await ctx.sessionQuery.searchSessions({ query: '连接池 超时' })
      expect(phraseMiss.items).toHaveLength(0)

      // Lexical mode recalls CJK compound terms and highlights the snippet.
      const lexicalHits = await ctx.sessionQuery.searchSessions({ query: '连接池 超时', mode: 'lexical' })
      expect(lexicalHits.items).toHaveLength(1)
      expect(lexicalHits.items[0]?.header.id).toBe(SessionId('zh-pool'))
      expect(lexicalHits.items[0]?.bestMatch.snippet).toContain('连接池超时')

      // Hybrid mode without an embedding provider cleanly executes lexical BM25.
      const hybridFallback = await ctx.sessionQuery.searchSessions({ query: 'timeout retry', mode: 'hybrid' })
      expect(hybridFallback.items).toHaveLength(1)
      expect(hybridFallback.items[0]?.header.id).toBe(SessionId('en-retry'))

      const eventPage = await ctx.sessionQuery.searchEvents({
        sessionId: SessionId('zh-pool'),
        query: '连接池 超时',
        mode: 'lexical',
        limit: 1,
      })
      expect(eventPage.items).toHaveLength(1)
      expect(eventPage.nextCursor).toBeDefined()
      const eventPage2 = await ctx.sessionQuery.searchEvents({
        sessionId: SessionId('zh-pool'),
        query: '连接池 超时',
        mode: 'lexical',
        limit: 1,
        ...(eventPage.nextCursor !== undefined ? { cursor: eventPage.nextCursor } : {}),
      })
      expect(eventPage2.items).toHaveLength(1)

      const hybridEventFallback = await ctx.sessionQuery.searchEvents({
        sessionId: SessionId('zh-pool'),
        query: '连接池',
        mode: 'hybrid',
      })
      expect(hybridEventFallback.items).toHaveLength(2)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fuses BM25 and dense vectors via RRF, caches persisted/live embeddings, and degrades gracefully on provider failure', async () => {
    const dir = await makeTempDir()
    const sessionsDir = join(dir, 'sessions')
    const dbPath = join(dir, 'index.db')

    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(JsonlSessionPersistence, { root: sessionsDir })
    const embeddingFiber = await ctx.plugin(EmbeddingRuntime)
    await ctx.plugin(SqliteSessionQueryEngine, {
      path: dbPath,
      openAt: 'startup',
      maxEmbedDocsPerSearch: 10,
      maxSemanticCandidates: 50,
      minVectorScore: 0.5,
    })

    try {
      // Create two persisted sessions (closed from live store so they come from persisted_docs)
      // and one live session.
      const writerSemanticOnly = await ctx.sessionPersistence.create({
        version: SESSION_FORMAT_VERSION,
        id: SessionId('persisted-semantic'),
        createdAt: 10,
        cwd: '/work/alpha',
        isSeeded: false,
      })
      await writerSemanticOnly.append([
        {
          type: 'user/message',
          seq: SessionSeq(0),
          time: 10,
          data: createUserMessage({
            content: [{ type: 'text', text: '数据库连接池耗尽导致线上请求排队阻塞' }],
            source: { kind: 'user' },
          }),
          surfaceOp: 'append',
        },
      ])
      await writerSemanticOnly.close()

      const writerDual = await ctx.sessionPersistence.create({
        version: SESSION_FORMAT_VERSION,
        id: SessionId('persisted-dual'),
        createdAt: 20,
        cwd: '/work/beta',
        isSeeded: false,
      })
      await writerDual.append([
        {
          type: 'user/message',
          seq: SessionSeq(0),
          time: 20,
          data: createUserMessage({
            content: [{ type: 'text', text: 'investigated database pool exhaustion under load' }],
            source: { kind: 'user' },
          }),
          surfaceOp: 'append',
        },
      ])
      await writerDual.close()

      const writerEmpty = await ctx.sessionPersistence.create({
        version: SESSION_FORMAT_VERSION,
        id: SessionId('persisted-empty'),
        createdAt: 5,
        cwd: '/work/empty',
        isSeeded: false,
      })
      await writerEmpty.close()

      const liveLexicalOnly = ctx.sessions.create(SessionId('live-lexical'), { meta: { cwd: '/work/gamma' } })
      liveLexicalOnly.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'swimming pool schedule for weekend' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      liveLexicalOnly.append('user/message', createUserMessage({
        content: [{ type: 'text', text: '   ' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })

      let embedCalls = 0
      const embedTextsSeen: string[][] = []
      const semanticVectorFor = (text: string): number[] => {
        if (text === 'database pool' || text.includes('连接池耗尽')) {
          return [1, 0]
        }
        if (text.includes('pool exhaustion')) {
          return [0.9, 0.4]
        }
        return [0, 1]
      }

      const unregister = ctx.embedding.registerProvider({
        modelId: 'mock:semantic-v1',
        embed: async (texts) => {
          embedCalls += 1
          embedTextsSeen.push([...texts])
          return texts.map(semanticVectorFor)
        },
      })

      // Search in English:
      // - 'persisted-dual' matches BOTH lexical ("database", "pool") AND semantic ([1, 0]) -> highest RRF!
      // - 'persisted-semantic' has ZERO English words, recalled purely via dense vector ([1, 0])!
      // - 'live-lexical' matches lexical ("pool") with orthogonal vector ([0, 1])!
      const hybridPage = await ctx.sessionQuery.searchSessions({
        query: 'database pool',
        mode: 'hybrid',
      })
      expect(hybridPage.items.map(item => item.header.id)).toEqual([
        SessionId('persisted-dual'),
        SessionId('persisted-semantic'),
        SessionId('live-lexical'),
      ])
      const callsAfterFirst = embedCalls
      expect(callsAfterFirst).toBe(2) // 1 query embed + 1 batch backfill

      // Second search reuses cached persisted_embeddings + liveEmbeddingCache (only 1 query embed call, 0 doc backfill!)
      const hybridPageCached = await ctx.sessionQuery.searchSessions({
        query: 'database pool',
        mode: 'hybrid',
        sessionFilters: [{ kind: 'cwd', values: ['/work/alpha', '/work/beta'] }],
      })
      expect(hybridPageCached.items.map(item => item.header.id)).toEqual([
        SessionId('persisted-dual'),
        SessionId('persisted-semantic'),
      ])
      expect(embedCalls).toBe(callsAfterFirst + 1)

      // Within-session hybrid search on persisted-semantic (0 lexical hits, 1 semantic hit!)
      const semanticEvents = await ctx.sessionQuery.searchEvents({
        sessionId: SessionId('persisted-semantic'),
        query: 'database pool',
        mode: 'hybrid',
      })
      expect(semanticEvents.items).toHaveLength(1)
      expect(semanticEvents.items[0]?.snippet).toContain('数据库连接池耗尽')

      // Updating persisted-dual appends seq 1 while keeping cached seq 0 vector.
      const writerDualAppend = await ctx.sessionPersistence.open(SessionId('persisted-dual'), 'write')
      await writerDualAppend.append([
        {
          type: 'user/message',
          seq: SessionSeq(1),
          time: 40,
          data: createUserMessage({
            content: [{ type: 'text', text: 'follow-up note on metrics' }],
            source: { kind: 'user' },
          }),
          surfaceOp: 'append',
        },
      ])
      await writerDualAppend.close()

      embedTextsSeen.length = 0
      await ctx.sessionQuery.searchSessions({ query: 'database pool', mode: 'hybrid' })
      // Backfill embeds only the newly appended event, not seq 0!
      expect(embedTextsSeen[1]).toEqual(['follow-up note on metrics'])

      // Deleting persisted-semantic removes its persisted_embeddings rows upon reconciliation.
      await rm(join(sessionsDir, '--work-alpha--'), { recursive: true, force: true })
      const afterDelete = await ctx.sessionQuery.searchSessions({ query: 'database pool', mode: 'hybrid' })
      expect(afterDelete.items.map(item => item.header.id)).not.toContain(SessionId('persisted-semantic'))

      // Provider transient error on query or backfill falls back cleanly without failing search.
      unregister()
      let failPhase: 'query' | 'backfill' | 'model-switch' | 'abort-query' | 'abort-backfill' = 'query'
      const abortController = new AbortController()
      ctx.embedding.registerProvider({
        modelId: 'mock:flaky',
        embed: async (texts) => {
          if (failPhase === 'query') throw new Error('endpoint offline')
          if (failPhase === 'abort-query') {
            abortController.abort()
            throw new EmbeddingError('aborted', 'EMBEDDING_ABORTED')
          }
          if (texts.length === 1 && texts[0] === 'swimming pool') {
            return [[1, 0]]
          }
          if (failPhase === 'backfill') throw new Error('batch timeout')
          if (failPhase === 'abort-backfill') {
            abortController.abort()
            throw new Error('socket closed')
          }
          return texts.map(() => [1, 0])
        },
      })

      const degradedSessionHits = await ctx.sessionQuery.searchSessions({
        query: 'swimming pool',
        mode: 'hybrid',
      })
      expect(degradedSessionHits.items.map(item => item.header.id)).toEqual([
        SessionId('live-lexical'),
        SessionId('persisted-dual'),
      ])

      const degradedEventHits = await ctx.sessionQuery.searchEvents({
        sessionId: SessionId('live-lexical'),
        query: 'swimming pool',
        mode: 'hybrid',
      })
      expect(degradedEventHits.items).toHaveLength(1)

      failPhase = 'backfill'
      const backfillDegraded = await ctx.sessionQuery.searchSessions({
        query: 'swimming pool',
        mode: 'hybrid',
      })
      expect(backfillDegraded.items.map(item => item.header.id)).toContain(SessionId('live-lexical'))

      failPhase = 'abort-backfill'
      await expect(ctx.sessionQuery.searchSessions(
        { query: 'swimming pool', mode: 'hybrid' },
        { signal: abortController.signal },
      )).rejects.toThrow(expectCode('SESSION_QUERY_ABORTED'))

      const queryAbort = new AbortController()
      failPhase = 'abort-query'
      await expect(ctx.sessionQuery.searchEvents(
        { sessionId: SessionId('live-lexical'), query: 'swimming pool', mode: 'hybrid' },
        { signal: queryAbort.signal },
      )).rejects.toThrow(expectCode('SESSION_QUERY_ABORTED'))

      // Disposing the optional embedding plugin unbinds cleanly and falls back to lexical BM25.
      await embeddingFiber.dispose()
      const afterUnbind = await ctx.sessionQuery.searchSessions({
        query: 'swimming pool',
        mode: 'hybrid',
      })
      expect(afterUnbind.items.map(item => item.header.id)).toEqual([
        SessionId('live-lexical'),
        SessionId('persisted-dual'),
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('handles corrupted persisted_embeddings blobs, maxEmbedDocsPerSearch=0, model-switch mid-backfill, and live cache eviction', async () => {
    const dir = await makeTempDir()
    const sessionsDir = join(dir, 'sessions')
    const dbPath = join(dir, 'edge.db')

    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(JsonlSessionPersistence, { root: sessionsDir })
    await ctx.plugin(EmbeddingRuntime)
    const engineFiber = await ctx.plugin(SqliteSessionQueryEngine, {
      path: dbPath,
      openAt: 'startup',
      maxEmbedDocsPerSearch: 0,
    })

    try {
      const writer = await ctx.sessionPersistence.create({
        version: SESSION_FORMAT_VERSION,
        id: SessionId('p1'),
        createdAt: 1,
        isSeeded: false,
      })
      await writer.append([
        {
          type: 'user/message',
          seq: SessionSeq(0),
          time: 1,
          data: createUserMessage({
            content: [{ type: 'text', text: 'cached persisted message' }],
            source: { kind: 'user' },
          }),
          surfaceOp: 'append',
        },
      ])
      await writer.close()

      ctx.embedding.registerProvider({
        modelId: 'mock:edge',
        embed: async texts => texts.map(() => [1, 0]),
      })

      // maxEmbedDocsPerSearch: 0 skips backfill without error.
      const zeroBackfill = await ctx.sessionQuery.searchSessions({ query: 'cached persisted', mode: 'hybrid' })
      expect(zeroBackfill.items).toHaveLength(1)

      await engineFiber.dispose()

      // Seed malformed rows directly into persisted_embeddings to exercise defensive validation branches.
      const rawDb = new DatabaseSync(dbPath)
      const validHash = hashDocumentText('cached persisted message')
      rawDb.prepare(`
        INSERT OR REPLACE INTO persisted_embeddings (session_id, seq, model_id, text_hash, dims, vector)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('p1', 0, 'mock:edge', validHash, 2, new Uint8Array([1, 2, 3])) // wrong byteLength for 2 floats
      rawDb.prepare(`
        INSERT OR REPLACE INTO persisted_embeddings (session_id, seq, model_id, text_hash, dims, vector)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('p1', 999, 'mock:edge', validHash, 2, encodeFloat32Vector(new Float32Array([1, 0]))) // non-existent seq
      rawDb.prepare(`
        INSERT OR REPLACE INTO persisted_embeddings (session_id, seq, model_id, text_hash, dims, vector)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('p1', 0, 'mock:wrong-hash', 'stale-hash', 2, encodeFloat32Vector(new Float32Array([1, 0])))
      rawDb.close()

      await ctx.plugin(SqliteSessionQueryEngine, {
        path: dbPath,
        openAt: 'startup',
        maxEmbedDocsPerSearch: LIVE_EMBEDDING_CACHE_LIMIT + 5,
        maxSemanticCandidates: LIVE_EMBEDDING_CACHE_LIMIT + 10,
      })

      const liveSession = ctx.sessions.create(SessionId('live-many'))
      for (let i = 0; i < LIVE_EMBEDDING_CACHE_LIMIT + 2; i += 1) {
        liveSession.append('user/message', createUserMessage({
          content: [{ type: 'text', text: `live doc number ${String(i)}` }],
          source: { kind: 'user' },
        }), { surfaceOp: 'append' })
      }

      // First run populates > LIVE_EMBEDDING_CACHE_LIMIT entries (evicting oldest) and repairs p1's malformed blob.
      const repaired = await ctx.sessionQuery.searchSessions({ query: 'cached persisted', mode: 'hybrid' })
      expect(repaired.items.length).toBeGreaterThanOrEqual(1)

      // Second run hits both live cache update (existing key refresh) and stale-hash skip under mock:wrong-hash.
      ctx.embedding.registerProvider({
        modelId: 'mock:wrong-hash',
        embed: async texts => texts.map(() => [1, 0]),
      })
      const refreshed = await ctx.sessionQuery.searchSessions({ query: 'live doc number 5', mode: 'hybrid' })
      expect(refreshed.items.length).toBeGreaterThanOrEqual(1)

      // Exercise provider switching during backfill (embedResult.modelId !== query modelId).
      let switched = false
      let unregisterSecond: (() => void) | undefined
      ctx.embedding.registerProvider({
        modelId: 'mock:before-switch',
        embed: async (texts) => {
          if (!switched) {
            switched = true
            unregisterSecond = ctx.embedding.registerProvider({
              modelId: 'mock:after-switch',
              embed: async innerTexts => innerTexts.map(() => [1, 0]),
            })
          }
          return texts.map(() => [1, 0])
        },
      })
      const switchHits = await ctx.sessionQuery.searchSessions({ query: 'cached persisted', mode: 'hybrid' })
      expect(switchHits.items.length).toBeGreaterThanOrEqual(1)
      unregisterSecond?.()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('supports live-only corpora, maxEmbedDocsPerSearch caps, and deterministic RRF/vector tie-breaking', async () => {
    const dir = await makeTempDir()
    const dbPath = join(dir, 'live-only.db')

    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(EmbeddingRuntime)
    const firstFiber = await ctx.plugin(SqliteSessionQueryEngine, {
      path: dbPath,
      openAt: 'startup',
      maxEmbedDocsPerSearch: 1,
    })

    try {
      const sA = ctx.sessions.create(SessionId('live-a'), { meta: { cwd: '/a', createdAt: 10 } })
      sA.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'alpha target keyword' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      sA.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'semantic twin one' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      sA.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'semantic twin three' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })

      const sB = ctx.sessions.create(SessionId('live-b'), { meta: { cwd: '/b', createdAt: 10 } })
      sB.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'semantic twin two' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })

      // Filtered lexical search over live-only corpus (`persistenceVisible === false` + `where.length > 0`).
      const filteredLexical = await ctx.sessionQuery.searchSessions({
        query: 'alpha target',
        mode: 'lexical',
        sessionFilters: [{ kind: 'cwd', values: ['/a'] }],
      })
      expect(filteredLexical.items.map(item => item.header.id)).toEqual([SessionId('live-a')])

      let batchSizes: number[] = []
      ctx.embedding.registerProvider({
        modelId: 'mock:live-ties',
        embed: async (texts) => {
          batchSizes.push(texts.length)
          return texts.map((text) => {
            if (text === 'alpha target') return [1, 0]
            // sA seq 0 is lexical #1 (`[0, 1]` -> below minVectorScore), while semantic twins get `[1, 0]` (vector #1/#2).
            if (text.includes('alpha target')) return [0, 1]
            return [1, 0]
          })
        },
      })

      // First hybrid search embeds query (1) + at most maxEmbedDocsPerSearch=1 doc!
      await ctx.sessionQuery.searchSessions({ query: 'alpha target', mode: 'hybrid' })
      expect(batchSizes).toEqual([1, 1])

      // Re-mount with larger batch cap so all 3 live docs are embedded and tie-broken deterministically.
      await firstFiber.dispose()
      await ctx.plugin(SqliteSessionQueryEngine, {
        path: dbPath,
        openAt: 'startup',
        maxEmbedDocsPerSearch: 10,
      })
      batchSizes = []
      const symmetricTie = await ctx.sessionQuery.searchSessions({ query: 'alpha target', mode: 'hybrid' })
      // sA seq 0 has lex #1 (rrf = 1/61) and sA seq 1 / sB seq 0 tie on vector score=1 & time=100;
      // lexicalRank #1 beats pure-semantic rank #1 on symmetric 1/61 RRF tie!
      expect(symmetricTie.items.map(item => item.header.id)).toEqual([
        SessionId('live-a'),
        SessionId('live-b'),
      ])
      expect(symmetricTie.items.map(item => item.matchCount)).toEqual([3, 1])

      const phraseCounts = await ctx.sessionQuery.searchSessions({ query: 'alpha', mode: 'phrase' })
      expect(phraseCounts.items[0]?.matchCount).toBe(1)

      const lexicalCounts = await ctx.sessionQuery.searchSessions({ query: 'alpha target', mode: 'lexical' })
      expect(lexicalCounts.items[0]?.matchCount).toBe(1)

      // Within-session hybrid search exercises intra-session vectorScored seq tie-breaker (same time=100, same session_id).
      const intraSession = await ctx.sessionQuery.searchEvents({
        sessionId: SessionId('live-a'),
        query: 'alpha target',
        mode: 'hybrid',
      })
      expect(intraSession.items.map(item => item.seq)).toEqual([SessionSeq(0), SessionSeq(2), SessionSeq(1)])
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
