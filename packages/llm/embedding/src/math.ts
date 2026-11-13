/**
 * Vector normalization and similarity utilities for dense text embeddings.
 *
 * @module @deepseek-ai/dsh-embedding/src/math
 */

import { EmbeddingError } from './types.ts'

/** Default maximum number of strings sent per provider `embed()` call. */
export const DEFAULT_EMBEDDING_BATCH_SIZE = 32

/** Default HTTP provider timeout in milliseconds. */
export const DEFAULT_EMBEDDING_TIMEOUT_MS = 30_000

/**
 * Compute cosine similarity between two L2-normalized vectors of identical length.
 * @param left - normalized vector A.
 * @param right - normalized vector B.
 * @returns dot-product similarity in `[-1, 1]`, or `0` when lengths differ or are empty.
 */
export function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  if (left.length === 0 || left.length !== right.length) return 0
  let dot = 0
  for (let index = 0; index < left.length; index += 1) {
    dot += (left[index] as number) * (right[index] as number)
  }
  return Math.max(-1, Math.min(1, dot))
}

/**
 * Normalize a vector to unit L2 length so dot product equals cosine similarity.
 * Zero-magnitude vectors remain all-zero instead of producing `NaN`.
 * @param raw - finite numeric vector of positive length.
 * @returns newly allocated `Float32Array` normalized to unit length.
 */
export function normalizeVector(raw: readonly number[] | Float32Array): Float32Array {
  if (raw.length === 0) {
    throw new EmbeddingError('embedding provider returned an empty vector', 'EMBEDDING_PROVIDER_FAILED')
  }
  const out = new Float32Array(raw.length)
  let sumSquares = 0
  for (let index = 0; index < raw.length; index += 1) {
    const value = raw[index] as number
    if (!Number.isFinite(value)) {
      throw new EmbeddingError('embedding provider returned a non-finite component', 'EMBEDDING_PROVIDER_FAILED')
    }
    out[index] = value
    sumSquares += value * value
  }
  if (sumSquares > 0) {
    const invNorm = 1 / Math.sqrt(sumSquares)
    for (let index = 0; index < out.length; index += 1) {
      out[index] = (out[index] as number) * invNorm
    }
  }
  return out
}
