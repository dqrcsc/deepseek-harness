/**
 * Public types, provider protocol, and typed failure codes for dense text embeddings.
 *
 * @module @deepseek-ai/dsh-embedding/types
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Stable machine-routable failure codes emitted by {@link EmbeddingError}. */
export type EmbeddingErrorCode =
  | 'EMBEDDING_ABORTED'
  | 'EMBEDDING_INVALID_CONFIG'
  | 'EMBEDDING_INVALID_INPUT'
  | 'EMBEDDING_PROVIDER_FAILED'
  | 'EMBEDDING_UNAVAILABLE'

/** Typed failure thrown when embedding configuration, input validation, or provider execution fails. */
export class EmbeddingError extends HarnessError {
  declare readonly code: EmbeddingErrorCode

  // The base stores the value; this signature narrows its open string code.
  // oxlint-disable-next-line typescript/no-useless-constructor
  constructor(message: string, code: EmbeddingErrorCode, options?: ErrorOptions) {
    super(message, code, options)
  }
}

/** Caller cancellation and batch execution controls for one embedding call. */
export interface EmbedOptions {
  /** Cancels in-flight provider requests and stops remaining batches. */
  readonly signal?: AbortSignal
}

/** Validated, L2-normalized dense vectors returned in input order. */
export interface EmbeddingResult {
  /** Stable identifier of the provider and model that produced the vectors. */
  readonly modelId: string
  /** Positive vector length shared by every element of `vectors`. */
  readonly dimensions: number
  /** One L2-normalized dense vector per input text, in input order. */
  readonly vectors: readonly Float32Array[]
}

/** Pluggable dense-embedding backend registered on `ctx.embedding`. */
export interface EmbeddingProvider {
  /** Unique provider and model identifier stored alongside persisted vectors. */
  readonly modelId: string
  /**
   * Compute one dense vector per non-empty input string.
   * @param texts - non-empty batch of UTF-8 strings to embed.
   * @param options - optional caller cancellation control.
   * @returns raw or normalized vectors of uniform positive length in input order.
   */
  embed(texts: readonly string[], options?: EmbedOptions): Promise<readonly (readonly number[] | Float32Array)[]>
}

/** Deployment configuration for `ctx.embedding` and its optional OpenAI-compatible HTTP endpoint. */
export interface Config {
  /** Base URL of an OpenAI-compatible HTTP API (for example `http://127.0.0.1:11434/v1`). Omit to leave HTTP embeddings unconfigured. */
  readonly baseUrl?: string
  /** Embedding model identifier sent to `POST {baseUrl}/embeddings`. Required when `baseUrl` is set. */
  readonly model?: string
  /** Optional bearer token sent in the `Authorization` header. */
  readonly apiKey?: string
  /** Optional explicit output dimensionality passed as `dimensions` in the JSON body. */
  readonly dimensions?: number
  /** Maximum number of texts sent in a single provider batch. Defaults to 32. */
  readonly maxBatchSize?: number
  /** Per-batch HTTP timeout in milliseconds. Defaults to 30000. */
  readonly timeoutMs?: number
}
