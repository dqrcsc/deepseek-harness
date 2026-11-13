/**
 * Dense text-embedding runtime (`ctx.embedding`) with HMR-safe provider registration,
 * batching, L2 normalization, and optional OpenAI-compatible HTTP endpoint support.
 *
 * @module @deepseek-ai/dsh-embedding
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { createHttpEmbeddingProvider, resolveEmbeddingsEndpoint } from './http-provider.ts'
import {
  DEFAULT_EMBEDDING_BATCH_SIZE,
  DEFAULT_EMBEDDING_TIMEOUT_MS,
  normalizeVector,
} from './math.ts'
import {
  EmbeddingError,
  type Config,
  type EmbedOptions,
  type EmbeddingErrorCode,
  type EmbeddingProvider,
  type EmbeddingResult,
} from './types.ts'

export { EmbeddingError }
export type {
  Config,
  EmbedOptions,
  EmbeddingErrorCode,
  EmbeddingProvider,
  EmbeddingResult,
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Dense text-embedding runtime for hybrid retrieval and semantic similarity. */
    embedding: EmbeddingRuntime
  }
}

interface ResolvedConfig {
  readonly baseUrl?: string
  readonly model?: string
  readonly apiKey?: string
  readonly dimensions?: number
  readonly maxBatchSize: number
  readonly timeoutMs: number
}

/** Runtime service coordinating dense text embedding providers and batch normalization. */
export class EmbeddingRuntime extends Service {
  static Config: z<Config> = z.object({
    baseUrl: z.string(),
    model: z.string(),
    apiKey: z.string().role('secret'),
    dimensions: z.number().step(1).min(1),
    maxBatchSize: z.number().step(1).min(1).default(DEFAULT_EMBEDDING_BATCH_SIZE),
    timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_EMBEDDING_TIMEOUT_MS),
  })

  private readonly _config: ResolvedConfig
  private readonly _providers: EmbeddingProvider[] = []
  private readonly _configuredProvider: EmbeddingProvider | undefined

  /**
   * @param ctx - owning Cordis context.
   * @param config - optional HTTP endpoint and batching settings.
   */
  constructor(ctx: Context, config: Config = {}) {
    const resolved = resolveConfig(config)
    const configuredProvider = resolved.baseUrl !== undefined && resolved.model !== undefined
      ? createHttpEmbeddingProvider({
        baseUrl: resolved.baseUrl,
        model: resolved.model,
        ...(resolved.apiKey === undefined ? {} : { apiKey: resolved.apiKey }),
        ...(resolved.dimensions === undefined ? {} : { dimensions: resolved.dimensions }),
        timeoutMs: resolved.timeoutMs,
      })
      : undefined
    super(ctx, 'embedding')
    this._config = resolved
    this._configuredProvider = configuredProvider
  }

  /**
   * Report whether an active embedding provider is registered or configured.
   * @returns `true` when {@link embed} can serve requests; `false` when callers should fall back to lexical ranking.
   */
  isAvailable(): boolean {
    return this._activeProvider() !== undefined
  }

  /**
   * Return the active provider's stable model identifier, or `undefined` when unavailable.
   * @returns active `modelId` string, or `undefined`.
   */
  activeModelId(): string | undefined {
    return this._activeProvider()?.modelId
  }

  /**
   * Register a custom {@link EmbeddingProvider} bound to the caller's fiber lifetime.
   * The most recently registered live provider takes precedence over the configured HTTP fallback.
   * @param provider - provider implementation to activate.
   * @returns disposer removing this provider registration.
   */
  registerProvider(provider: EmbeddingProvider): () => void {
    if (provider.modelId.trim().length === 0) {
      throw new EmbeddingError('embedding provider modelId must be a non-empty string', 'EMBEDDING_INVALID_CONFIG')
    }
    const dispose = this.ctx.effect(() => {
      this._providers.push(provider)
      return () => {
        const index = this._providers.lastIndexOf(provider)
        this._providers.splice(index, 1)
      }
    }, `embedding.provider:${provider.modelId}`)
    return () => { void dispose() }
  }

  /**
   * Embed an ordered list of non-empty texts in bounded batches and L2-normalize every vector.
   * @param texts - non-empty list of non-whitespace texts to embed.
   * @param options - optional cancellation signal.
   * @returns normalized `Float32Array` vectors and their shared model/dimension metadata.
   * @throws {@link EmbeddingError} when no provider is configured, input is invalid, aborted, or the provider fails.
   */
  async embed(texts: readonly string[], options?: EmbedOptions): Promise<EmbeddingResult> {
    const provider = this._activeProvider()
    if (provider === undefined) {
      throw new EmbeddingError(
        'text embedding is unavailable: configure baseUrl and model on dsh-embedding or register a provider',
        'EMBEDDING_UNAVAILABLE',
      )
    }
    if (texts.length === 0) {
      throw new EmbeddingError('embed() requires a non-empty array of strings', 'EMBEDDING_INVALID_INPUT')
    }
    const cleaned = texts.map((text, index) => {
      const trimmed = text.trim()
      if (trimmed.length === 0) {
        throw new EmbeddingError(
          `embed() input at index ${String(index)} must be a non-whitespace string`,
          'EMBEDDING_INVALID_INPUT',
        )
      }
      return trimmed
    })

    const signal = options?.signal
    if (signal?.aborted) {
      throw new EmbeddingError('embedding request aborted', 'EMBEDDING_ABORTED', { cause: signal.reason })
    }

    const normalizedVectors: Float32Array[] = []
    let expectedDimensions: number | undefined
    const batchSize = this._config.maxBatchSize

    for (let start = 0; start < cleaned.length; start += batchSize) {
      if (signal?.aborted) {
        throw new EmbeddingError('embedding request aborted', 'EMBEDDING_ABORTED', { cause: signal.reason })
      }
      const batch = cleaned.slice(start, start + batchSize)
      let rawBatch: readonly (readonly number[] | Float32Array)[]
      try {
        rawBatch = await provider.embed(batch, options)
      } catch (error: unknown) {
        if (error instanceof EmbeddingError) throw error
        if (signal?.aborted) {
          throw new EmbeddingError('embedding request aborted', 'EMBEDDING_ABORTED', { cause: error })
        }
        throw new EmbeddingError(
          `embedding provider "${provider.modelId}" failed: ${error instanceof Error ? error.message : String(error)}`,
          'EMBEDDING_PROVIDER_FAILED',
          { cause: error },
        )
      }
      const rawCandidate: unknown = rawBatch
      if (!Array.isArray(rawCandidate) || rawCandidate.length !== batch.length) {
        throw new EmbeddingError(
          `embedding provider "${provider.modelId}" returned ${String(Array.isArray(rawCandidate) ? rawCandidate.length : 'non-array')} vectors for batch of ${String(batch.length)}`,
          'EMBEDDING_PROVIDER_FAILED',
        )
      }
      for (const rawVec of rawBatch) {
        const unit = normalizeVector(rawVec)
        expectedDimensions ??= unit.length
        if (unit.length !== expectedDimensions) {
          throw new EmbeddingError(
            `embedding provider "${provider.modelId}" returned inconsistent vector dimensions (${String(unit.length)} vs ${String(expectedDimensions)})`,
            'EMBEDDING_PROVIDER_FAILED',
          )
        }
        normalizedVectors.push(unit)
      }
    }

    return {
      modelId: provider.modelId,
      dimensions: expectedDimensions as number,
      vectors: normalizedVectors,
    }
  }

  private _activeProvider(): EmbeddingProvider | undefined {
    return this._providers.at(-1) ?? this._configuredProvider
  }
}

function resolveConfig(config: Config): ResolvedConfig {
  const baseUrl = normalizeOptionalString('baseUrl', config.baseUrl)
  const model = normalizeOptionalString('model', config.model)
  const apiKey = normalizeOptionalString('apiKey', config.apiKey)
  if ((baseUrl === undefined) !== (model === undefined)) {
    throw new EmbeddingError(
      'embedding config: baseUrl and model must be provided together or both omitted',
      'EMBEDDING_INVALID_CONFIG',
    )
  }
  if (baseUrl !== undefined) {
    resolveEmbeddingsEndpoint(baseUrl)
  }
  if (config.dimensions !== undefined && (!Number.isSafeInteger(config.dimensions) || config.dimensions < 1)) {
    throw new EmbeddingError('embedding config: dimensions must be a positive safe integer', 'EMBEDDING_INVALID_CONFIG')
  }
  const maxBatchSize = config.maxBatchSize ?? DEFAULT_EMBEDDING_BATCH_SIZE
  if (!Number.isSafeInteger(maxBatchSize) || maxBatchSize < 1) {
    throw new EmbeddingError('embedding config: maxBatchSize must be a positive safe integer', 'EMBEDDING_INVALID_CONFIG')
  }
  const timeoutMs = config.timeoutMs ?? DEFAULT_EMBEDDING_TIMEOUT_MS
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new EmbeddingError(
      `embedding config: timeoutMs must be a positive integer no greater than ${String(MAX_TIMER_DELAY_MS)}`,
      'EMBEDDING_INVALID_CONFIG',
    )
  }
  return {
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(model === undefined ? {} : { model }),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(config.dimensions === undefined ? {} : { dimensions: config.dimensions }),
    maxBatchSize,
    timeoutMs,
  }
}

function normalizeOptionalString(name: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new EmbeddingError(`embedding config: ${name} must be a string`, 'EMBEDDING_INVALID_CONFIG')
  }
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

export default EmbeddingRuntime
