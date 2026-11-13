import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import EmbeddingRuntime, {
  EmbeddingError,
  type Config,
  type EmbeddingProvider,
} from '../src/index.ts'
import { createHttpEmbeddingProvider, resolveEmbeddingsEndpoint } from '../src/http-provider.ts'
import { cosineSimilarity, normalizeVector } from '../src/math.ts'

class BrokenBodyResponse extends Response {
  override text(): Promise<string> {
    return Promise.reject(new Error('stream broken'))
  }
}

async function mountEmbedding(config: Config = {}): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const ctx = new Context()
  await ctx.plugin(EmbeddingRuntime, config)
  return {
    ctx,
    dispose: () => ctx.fiber.dispose(),
  }
}

describe('vector math helpers', () => {
  it('normalizes positive vectors to unit length and preserves zero vectors', () => {
    const unit = normalizeVector([3, 4])
    expect(unit[0]).toBeCloseTo(0.6, 5)
    expect(unit[1]).toBeCloseTo(0.8, 5)

    const zero = normalizeVector(new Float32Array([0, 0, 0]))
    expect(Array.from(zero)).toEqual([0, 0, 0])
  })

  it('rejects empty or non-finite vectors', () => {
    expect(() => normalizeVector([])).toThrow(EmbeddingError)
    expect(() => normalizeVector([1, Number.NaN])).toThrow(/non-finite/)
    expect(() => normalizeVector([1, Number.POSITIVE_INFINITY])).toThrow(/non-finite/)
  })

  it('computes bounded cosine similarity and handles mismatched or empty vectors', () => {
    const a = normalizeVector([1, 0])
    const b = normalizeVector([1, 1])
    const opposite = normalizeVector([-1, 0])
    expect(cosineSimilarity(a, a)).toBeCloseTo(1, 5)
    expect(cosineSimilarity(a, b)).toBeCloseTo(Math.SQRT1_2, 5)
    expect(cosineSimilarity(a, opposite)).toBeCloseTo(-1, 5)
    expect(cosineSimilarity(new Float32Array([]), new Float32Array([]))).toBe(0)
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([1, 0, 0]))).toBe(0)
  })
})

describe('resolveEmbeddingsEndpoint', () => {
  it('appends /embeddings when missing and preserves explicit /embeddings paths', () => {
    expect(resolveEmbeddingsEndpoint('http://127.0.0.1:11434/v1/')).toBe('http://127.0.0.1:11434/v1/embeddings')
    expect(resolveEmbeddingsEndpoint('https://api.example.com/v1/embeddings')).toBe('https://api.example.com/v1/embeddings')
  })

  it('rejects malformed or non-HTTP URLs', () => {
    expect(() => resolveEmbeddingsEndpoint('not a url')).toThrow(/not a valid URL/)
    expect(() => resolveEmbeddingsEndpoint('ftp://example.com/v1')).toThrow(/http: or https:/)
  })
})

describe('createHttpEmbeddingProvider', () => {
  it('sends OpenAI-compatible requests, forwards optional headers/dimensions, and reorders indexed results', async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = []
    const provider = createHttpEmbeddingProvider({
      baseUrl: 'https://api.example.com/v1',
      model: 'text-embedding-3-small',
      apiKey: 'secret-token',
      dimensions: 2,
      timeoutMs: 5_000,
      fetchImpl: async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        seen.push({ url, init })
        return new Response(JSON.stringify({
          data: [
            { index: 1, embedding: [0, 2] },
            { index: 0, embedding: [3, 0] },
          ],
        }), { status: 200 })
      },
    })

    expect(provider.modelId).toBe('http:https://api.example.com/v1/embeddings#text-embedding-3-small:2')
    const vectors = await provider.embed(['first', 'second'])
    expect(vectors).toEqual([[3, 0], [0, 2]])
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe('https://api.example.com/v1/embeddings')
    const headers = new Headers(seen[0]?.init?.headers)
    expect(headers.get('authorization')).toBe('Bearer secret-token')
    const rawBody = seen[0]?.init?.body
    expect(JSON.parse(typeof rawBody === 'string' ? rawBody : '{}')).toEqual({
      model: 'text-embedding-3-small',
      input: ['first', 'second'],
      encoding_format: 'float',
      dimensions: 2,
    })
  })

  it('omits authorization and dimensions when unconfigured and handles caller cancellation', async () => {
    const preAborted = new AbortController()
    preAborted.abort(new Error('stop'))
    const provider = createHttpEmbeddingProvider({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'nomic-embed-text',
      timeoutMs: 5_000,
      fetchImpl: async (_input, init) => {
        if (init?.signal?.aborted) throw new Error('aborted')
        return new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }), { status: 200 })
      },
    })

    await expect(provider.embed(['hello'], { signal: preAborted.signal })).rejects.toMatchObject({
      code: 'EMBEDDING_ABORTED',
    })

    const midAbort = new AbortController()
    const abortingProvider = createHttpEmbeddingProvider({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'nomic-embed-text',
      timeoutMs: 5_000,
      fetchImpl: async () => {
        midAbort.abort()
        throw new Error('socket closed')
      },
    })
    await expect(abortingProvider.embed(['hello'], { signal: midAbort.signal })).rejects.toMatchObject({
      code: 'EMBEDDING_ABORTED',
    })

    const okVectors = await provider.embed(['hello'])
    expect(okVectors).toEqual([[1, 0]])
  })

  it('maps transport, HTTP status, invalid JSON, and malformed payload shapes to EMBEDDING_PROVIDER_FAILED', async () => {
    const networkFail = createHttpEmbeddingProvider({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'm',
      timeoutMs: 5_000,
      fetchImpl: async () => {
        throw 'raw string network failure'
      },
    })
    await expect(networkFail.embed(['a'])).rejects.toMatchObject({ code: 'EMBEDDING_PROVIDER_FAILED' })

    const errorFail = createHttpEmbeddingProvider({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'm',
      timeoutMs: 5_000,
      fetchImpl: async () => {
        throw new Error('connection refused')
      },
    })
    await expect(errorFail.embed(['a'])).rejects.toThrow(/connection refused/)

    const statusWithBody = createHttpEmbeddingProvider({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'm',
      timeoutMs: 5_000,
      fetchImpl: async () => new Response('rate limit exceeded', { status: 429 }),
    })
    await expect(statusWithBody.embed(['a'])).rejects.toThrow(/429: rate limit exceeded/)

    const statusUnreadableBody = createHttpEmbeddingProvider({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'm',
      timeoutMs: 5_000,
      fetchImpl: async () => new BrokenBodyResponse(null, { status: 502 }),
    })
    await expect(statusUnreadableBody.embed(['a'])).rejects.toThrow(/returned 502$/)

    const badJson = createHttpEmbeddingProvider({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'm',
      timeoutMs: 5_000,
      fetchImpl: async () => new Response('{not-json', { status: 200 }),
    })
    await expect(badJson.embed(['a'])).rejects.toThrow(/invalid JSON/)

    const badPayloads: unknown[] = [
      null,
      { data: 'nope' },
      { data: [] },
      { data: [null] },
      { data: [{ index: 5, embedding: [1] }] },
      { data: [{ index: 0, embedding: ['bad'] }] },
    ]
    for (const payload of badPayloads) {
      const p = createHttpEmbeddingProvider({
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'm',
        timeoutMs: 5_000,
        fetchImpl: async () => new Response(JSON.stringify(payload), { status: 200 }),
      })
      await expect(p.embed(['a'])).rejects.toMatchObject({ code: 'EMBEDDING_PROVIDER_FAILED' })
    }

    const duplicateIndex = createHttpEmbeddingProvider({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'm',
      timeoutMs: 5_000,
      fetchImpl: async () => new Response(JSON.stringify({
        data: [
          { index: 0, embedding: [1, 0] },
          { index: 0, embedding: [0, 1] },
        ],
      }), { status: 200 }),
    })
    await expect(duplicateIndex.embed(['a', 'b'])).rejects.toThrow(/duplicate item index/)
  })
})

describe('EmbeddingRuntime service', () => {
  it('starts unavailable with zero config, supports HMR-safe provider registration, and batches requests', async () => {
    const { ctx, dispose } = await mountEmbedding({ maxBatchSize: 2 })
    try {
      expect(ctx.embedding.isAvailable()).toBe(false)
      expect(ctx.embedding.activeModelId()).toBeUndefined()
      await expect(ctx.embedding.embed(['hello'])).rejects.toMatchObject({ code: 'EMBEDDING_UNAVAILABLE' })

      expect(() => ctx.embedding.registerProvider({
        modelId: '   ',
        embed: async () => [],
      })).toThrow(/modelId must be a non-empty string/)

      const batches: string[][] = []
      const providerA: EmbeddingProvider = {
        modelId: 'mock:a',
        embed: async (texts) => {
          batches.push([...texts])
          return texts.map((_, idx) => [idx + 1, 0])
        },
      }
      const unregisterA = ctx.embedding.registerProvider(providerA)
      expect(ctx.embedding.isAvailable()).toBe(true)
      expect(ctx.embedding.activeModelId()).toBe('mock:a')

      const result = await ctx.embedding.embed([' alpha ', 'beta', 'gamma'])
      expect(batches).toEqual([['alpha', 'beta'], ['gamma']])
      expect(result.modelId).toBe('mock:a')
      expect(result.dimensions).toBe(2)
      expect(result.vectors).toHaveLength(3)
      expect(result.vectors[0]?.[0]).toBeCloseTo(1, 5)

      const providerB: EmbeddingProvider = {
        modelId: 'mock:b',
        embed: async texts => texts.map(() => new Float32Array([0, 3])),
      }
      const unregisterB = ctx.embedding.registerProvider(providerB)
      expect(ctx.embedding.activeModelId()).toBe('mock:b')

      unregisterA()
      unregisterA()
      expect(ctx.embedding.activeModelId()).toBe('mock:b')
      unregisterB()
      expect(ctx.embedding.isAvailable()).toBe(false)
    } finally {
      await dispose()
    }
  })

  it('validates config, inputs, batch cancellation, and provider failures', async () => {
    expect(new EmbeddingRuntime(new Context()).isAvailable()).toBe(false)
    expect(new EmbeddingRuntime(new Context(), {
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'nomic-embed-text',
    }).activeModelId()).toBe('http:http://127.0.0.1:11434/v1/embeddings#nomic-embed-text')
    expect(() => new EmbeddingRuntime(new Context(), { baseUrl: 'http://127.0.0.1:11434/v1' })).toThrow(
      /provided together/,
    )
    expect(() => new EmbeddingRuntime(new Context(), JSON.parse('{"baseUrl":123}') as Config)).toThrow(
      /baseUrl must be a string/,
    )
    expect(() => new EmbeddingRuntime(new Context(), {
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'm',
      dimensions: 0,
    })).toThrow(/dimensions must be a positive safe integer/)
    expect(() => new EmbeddingRuntime(new Context(), { maxBatchSize: 0 })).toThrow(
      /maxBatchSize must be a positive safe integer/,
    )
    expect(() => new EmbeddingRuntime(new Context(), { timeoutMs: 0 })).toThrow(
      /timeoutMs must be a positive integer/,
    )

    const { ctx: configuredCtx, dispose: disposeConfigured } = await mountEmbedding({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'nomic-embed-text',
      apiKey: 'secret',
      dimensions: 4,
    })
    expect(configuredCtx.embedding.isAvailable()).toBe(true)
    expect(configuredCtx.embedding.activeModelId()).toContain('nomic-embed-text:4')
    await disposeConfigured()

    const { ctx: blankCtx, dispose: disposeBlank } = await mountEmbedding({
      baseUrl: '   ',
      model: '   ',
    })
    expect(blankCtx.embedding.isAvailable()).toBe(false)
    await disposeBlank()

    const { ctx, dispose } = await mountEmbedding({ maxBatchSize: 1 })
    try {
      let mode: 'ok' | 'wrong-count' | 'non-array' | 'dim-mismatch' | 'throw-error' | 'throw-string' | 'embedding-error' | 'abort-mid' = 'ok'
      const controller = new AbortController()
      let callIndex = 0
      ctx.embedding.registerProvider({
        modelId: 'mock:edge',
        embed: async () => {
          callIndex += 1
          if (mode === 'wrong-count') return []
          if (mode === 'non-array') return JSON.parse('null') as number[][]
          if (mode === 'dim-mismatch') return callIndex === 1 ? [[1, 0]] : [[1, 0, 0]]
          if (mode === 'throw-error') throw new Error('boom')
          if (mode === 'throw-string') throw 'plain-failure'
          if (mode === 'embedding-error') throw new EmbeddingError('custom', 'EMBEDDING_PROVIDER_FAILED')
          if (mode === 'abort-mid') {
            if (callIndex === 1) {
              controller.abort()
              return [[1, 0]]
            }
            return [[1, 0]]
          }
          return [[1, 0]]
        },
      })

      await expect(ctx.embedding.embed([])).rejects.toMatchObject({ code: 'EMBEDDING_INVALID_INPUT' })
      await expect(ctx.embedding.embed(['   '])).rejects.toMatchObject({ code: 'EMBEDDING_INVALID_INPUT' })

      const preAborted = new AbortController()
      preAborted.abort()
      await expect(ctx.embedding.embed(['ok'], { signal: preAborted.signal })).rejects.toMatchObject({
        code: 'EMBEDDING_ABORTED',
      })

      mode = 'wrong-count'
      await expect(ctx.embedding.embed(['ok'])).rejects.toThrow(/0 vectors for batch of 1/)

      mode = 'non-array'
      await expect(ctx.embedding.embed(['ok'])).rejects.toThrow(/non-array vectors/)

      mode = 'dim-mismatch'
      callIndex = 0
      await expect(ctx.embedding.embed(['first', 'second'])).rejects.toThrow(/inconsistent vector dimensions/)

      mode = 'throw-error'
      await expect(ctx.embedding.embed(['ok'])).rejects.toThrow(/boom/)

      mode = 'throw-string'
      await expect(ctx.embedding.embed(['ok'])).rejects.toThrow(/plain-failure/)

      mode = 'embedding-error'
      await expect(ctx.embedding.embed(['ok'])).rejects.toThrow(/custom/)

      mode = 'abort-mid'
      callIndex = 0
      await expect(ctx.embedding.embed(['first', 'second'], { signal: controller.signal })).rejects.toMatchObject({
        code: 'EMBEDDING_ABORTED',
      })

      const throwAbort = new AbortController()
      ctx.embedding.registerProvider({
        modelId: 'mock:throw-abort',
        embed: async () => {
          throwAbort.abort()
          throw new Error('cancelled')
        },
      })
      await expect(ctx.embedding.embed(['ok'], { signal: throwAbort.signal })).rejects.toMatchObject({
        code: 'EMBEDDING_ABORTED',
      })
    } finally {
      await dispose()
    }
  })
})
