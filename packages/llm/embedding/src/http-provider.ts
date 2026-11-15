/**
 * OpenAI-compatible `/embeddings` HTTP provider implementation.
 *
 * @module @deepseek-ai/dsh-embedding/http-provider
 */

import { runWithTrafficContext } from '@deepseek-ai/dsh-http-proxy'
import { EmbeddingError, type EmbedOptions, type EmbeddingProvider } from './types.ts'

/** Validated parameters for an OpenAI-compatible `/embeddings` endpoint. */
export interface HttpEmbeddingProviderOptions {
  /** Base URL without a trailing slash; `/embeddings` is appended when not already present. */
  readonly baseUrl: string
  /** Model name sent in the request payload. */
  readonly model: string
  /** Optional bearer token for `Authorization: Bearer <token>`. */
  readonly apiKey?: string
  /** Optional positive vector dimensionality requested from models that support truncation. */
  readonly dimensions?: number
  /** Positive per-request deadline in milliseconds. */
  readonly timeoutMs: number
  /** Optional `fetch` implementation override for deterministic testing. */
  readonly fetchImpl?: typeof globalThis.fetch
}

/**
 * Resolve the canonical embeddings endpoint URL from a configured base URL.
 * @param baseUrl - validated non-empty HTTP or HTTPS URL.
 * @returns endpoint URL ending with `/embeddings`.
 */
export function resolveEmbeddingsEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/u, '')
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch (error: unknown) {
    throw new EmbeddingError(
      `embedding config: baseUrl "${baseUrl}" is not a valid URL`,
      'EMBEDDING_INVALID_CONFIG',
      { cause: error },
    )
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new EmbeddingError(
      `embedding config: baseUrl "${baseUrl}" must use http: or https:`,
      'EMBEDDING_INVALID_CONFIG',
    )
  }
  return trimmed.endsWith('/embeddings') ? trimmed : `${trimmed}/embeddings`
}

/**
 * Create an {@link EmbeddingProvider} speaking the OpenAI `POST /v1/embeddings` JSON wire format.
 * @param options - validated endpoint URL, model, credentials, and timeout settings.
 * @returns an embedding provider keyed by `http:<endpoint>#<model>[/<dimensions>]`.
 */
export function createHttpEmbeddingProvider(options: HttpEmbeddingProviderOptions): EmbeddingProvider {
  const endpoint = resolveEmbeddingsEndpoint(options.baseUrl)
  const fetchFn = options.fetchImpl ?? globalThis.fetch
  const dimSuffix = options.dimensions === undefined ? '' : `:${String(options.dimensions)}`
  const modelId = `http:${endpoint}#${options.model}${dimSuffix}`

  return {
    modelId,
    async embed(texts: readonly string[], embedOptions?: EmbedOptions): Promise<readonly number[][]> {
      const callerSignal = embedOptions?.signal
      if (callerSignal?.aborted) {
        throw new EmbeddingError('embedding request aborted', 'EMBEDDING_ABORTED', { cause: callerSignal.reason })
      }
      const timeoutSignal = AbortSignal.timeout(options.timeoutMs)
      const combinedSignal = callerSignal === undefined
        ? timeoutSignal
        : AbortSignal.any([callerSignal, timeoutSignal])

      const headers: Record<string, string> = {
        'content-type': 'application/json',
      }
      if (options.apiKey !== undefined && options.apiKey.length > 0) {
        headers['authorization'] = `Bearer ${options.apiKey}`
      }
      const body: Record<string, unknown> = {
        model: options.model,
        input: texts,
        encoding_format: 'float',
      }
      if (options.dimensions !== undefined) {
        body['dimensions'] = options.dimensions
      }

      let response: Response
      try {
        response = await runWithTrafficContext({ category: 'embedding' }, () => fetchFn(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: combinedSignal,
        }))
      } catch (error: unknown) {
        if (callerSignal?.aborted) {
          throw new EmbeddingError('embedding request aborted', 'EMBEDDING_ABORTED', { cause: error })
        }
        throw new EmbeddingError(
          `embedding HTTP request to "${endpoint}" failed: ${error instanceof Error ? error.message : String(error)}`,
          'EMBEDDING_PROVIDER_FAILED',
          { cause: error },
        )
      }

      if (!response.ok) {
        let detail = ''
        try {
          detail = (await response.text()).slice(0, 240).trim()
        } catch (_readError: unknown) {
          // Transport failure while reading an error body keeps the HTTP status diagnostic primary.
        }
        const suffix = detail.length > 0 ? `: ${detail}` : ''
        throw new EmbeddingError(
          `embedding HTTP endpoint "${endpoint}" returned ${String(response.status)}${suffix}`,
          'EMBEDDING_PROVIDER_FAILED',
        )
      }

      let payload: unknown
      try {
        payload = await response.json()
      } catch (error: unknown) {
        throw new EmbeddingError(
          `embedding HTTP endpoint "${endpoint}" returned invalid JSON`,
          'EMBEDDING_PROVIDER_FAILED',
          { cause: error },
        )
      }
      return parseEmbeddingsResponse(payload, texts.length, endpoint)
    },
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseEmbeddingsResponse(
  payload: unknown,
  expectedCount: number,
  endpoint: string,
): readonly number[][] {
  if (!isPlainRecord(payload) || !Array.isArray(payload['data'])) {
    throw new EmbeddingError(
      `embedding HTTP endpoint "${endpoint}" response is missing a data array`,
      'EMBEDDING_PROVIDER_FAILED',
    )
  }
  const items: readonly unknown[] = payload['data']
  if (items.length !== expectedCount) {
    throw new EmbeddingError(
      `embedding HTTP endpoint "${endpoint}" returned ${String(items.length)} vectors for ${String(expectedCount)} inputs`,
      'EMBEDDING_PROVIDER_FAILED',
    )
  }
  const ordered: Array<number[] | undefined> = Array.from({ length: expectedCount })
  for (let pos = 0; pos < items.length; pos += 1) {
    const entry = items[pos]
    if (!isPlainRecord(entry) || !Array.isArray(entry['embedding'])) {
      throw new EmbeddingError(
        `embedding HTTP endpoint "${endpoint}" returned a malformed data item at position ${String(pos)}`,
        'EMBEDDING_PROVIDER_FAILED',
      )
    }
    const rawIndex = entry['index']
    const targetIndex = typeof rawIndex === 'number' && Number.isInteger(rawIndex) ? rawIndex : pos
    if (targetIndex < 0 || targetIndex >= expectedCount || ordered[targetIndex] !== undefined) {
      throw new EmbeddingError(
        `embedding HTTP endpoint "${endpoint}" returned invalid or duplicate item index ${String(targetIndex)}`,
        'EMBEDDING_PROVIDER_FAILED',
      )
    }
    const rawVector: readonly unknown[] = entry['embedding']
    const vector: number[] = []
    for (const component of rawVector) {
      if (typeof component !== 'number' || !Number.isFinite(component)) {
        throw new EmbeddingError(
          `embedding HTTP endpoint "${endpoint}" returned a non-finite vector component`,
          'EMBEDDING_PROVIDER_FAILED',
        )
      }
      vector.push(component)
    }
    ordered[targetIndex] = vector
  }
  return ordered.map((vec, idx) => {
    /* v8 ignore next -- duplicate/range check above guarantees bijective assignment */
    if (vec === undefined) throw new EmbeddingError(`missing vector at index ${String(idx)}`, 'EMBEDDING_PROVIDER_FAILED')
    return vec
  })
}
