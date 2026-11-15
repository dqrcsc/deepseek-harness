/**
 * AES-256-GCM encrypted on-disk cache for parsed VPN subscription nodes and Clash routing rules (`0600` files).
 * Allows `smart` and `global` modes to restore proxy nodes immediately on startup before background refresh finishes,
 * while keeping server hostnames, ports, and protocol secrets encrypted at rest under a `ctx.credentials`-managed key.
 * @module @deepseek-ai/dsh-network-proxy/cache
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { ParsedSubscription } from '@deepseek-ai/dsh-vpn-tunnel'
import type { VpnSubscriptionId } from './types.ts'

const CACHE_MAGIC = Buffer.from('DSHN', 'ascii')
const CACHE_VERSION = 1
const GCM_IV_BYTES = 12
const GCM_TAG_BYTES = 16
const HEADER_BYTES = CACHE_MAGIC.length + 1 + GCM_IV_BYTES + GCM_TAG_BYTES

/** Construction parameters for {@link EncryptedSubscriptionCache}. */
export interface EncryptedSubscriptionCacheOptions {
  /** Private directory (`0700`) holding `<subscriptionId>.enc` files. */
  readonly cacheDir: string
  /** Provider returning the 32-byte AES-256-GCM symmetric key stored in `ctx.credentials`. */
  readonly resolveSecretKey: () => Promise<Buffer>
}

function cacheFilenameFor(subscriptionId: VpnSubscriptionId): string {
  const safe = subscriptionId.replace(/[^a-zA-Z0-9_-]/gu, '_')
  return `${safe}.enc`
}

function isValidCachedSubscription(value: unknown): value is ParsedSubscription {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    Array.isArray(candidate.nodes)
    && Array.isArray(candidate.rules)
    && typeof candidate.clockOffsetSeconds === 'number'
  )
}

/** AES-256-GCM encrypted file cache for {@link ParsedSubscription} payloads. */
export class EncryptedSubscriptionCache {
  private readonly cacheDir: string
  private readonly resolveSecretKey: () => Promise<Buffer>

  /**
   * @param options - cache directory path and 32-byte key resolver.
   */
  constructor(options: EncryptedSubscriptionCacheOptions) {
    this.cacheDir = options.cacheDir
    this.resolveSecretKey = options.resolveSecretKey
  }

  /**
   * Encrypt and atomically persist `parsed` for `subscriptionId` with `0600` file permissions.
   * @param subscriptionId - owning subscription identifier bound into GCM AAD.
   * @param parsed - parsed subscription nodes, rules, and metadata.
   */
  async write(subscriptionId: VpnSubscriptionId, parsed: ParsedSubscription): Promise<void> {
    const key = await this.resolveSecretKey()
    const iv = randomBytes(GCM_IV_BYTES)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from(subscriptionId, 'utf8'))
    const plaintext = Buffer.from(JSON.stringify(parsed), 'utf8')
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const tag = cipher.getAuthTag()
    const envelope = Buffer.concat([
      CACHE_MAGIC,
      Buffer.from([CACHE_VERSION]),
      iv,
      tag,
      ciphertext,
    ])
    const filePath = join(this.cacheDir, cacheFilenameFor(subscriptionId))
    await writeFileAtomic(filePath, envelope, { mode: 0o600, dirMode: 0o700 })
  }

  /**
   * Read and authenticate the cached {@link ParsedSubscription} for `subscriptionId`.
   * Missing, truncated, tampered, or schema-invalid files return `null` and remove corrupted residue.
   * @param subscriptionId - owning subscription identifier verified against GCM AAD.
   * @returns decrypted {@link ParsedSubscription}, or `null` when absent or invalid.
   */
  async read(subscriptionId: VpnSubscriptionId): Promise<ParsedSubscription | null> {
    const filePath = join(this.cacheDir, cacheFilenameFor(subscriptionId))
    let raw: Buffer
    try {
      raw = await readFile(filePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }

    if (
      raw.length < HEADER_BYTES
      || !raw.subarray(0, 4).equals(CACHE_MAGIC)
      || raw[4] !== CACHE_VERSION
    ) {
      await this.delete(subscriptionId)
      return null
    }

    const key = await this.resolveSecretKey()
    const iv = raw.subarray(5, 5 + GCM_IV_BYTES)
    const tag = raw.subarray(5 + GCM_IV_BYTES, HEADER_BYTES)
    const ciphertext = raw.subarray(HEADER_BYTES)
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv)
      decipher.setAAD(Buffer.from(subscriptionId, 'utf8'))
      decipher.setAuthTag(tag)
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
      const decoded: unknown = JSON.parse(plaintext)
      if (!isValidCachedSubscription(decoded)) {
        await this.delete(subscriptionId)
        return null
      }
      return decoded
    } catch (_authOrJsonError) {
      await this.delete(subscriptionId)
      return null
    }
  }

  /**
   * Remove the encrypted cache file for `subscriptionId` if present.
   * @param subscriptionId - owning subscription identifier.
   */
  async delete(subscriptionId: VpnSubscriptionId): Promise<void> {
    const filePath = join(this.cacheDir, cacheFilenameFor(subscriptionId))
    await rm(filePath, { force: true })
  }
}
