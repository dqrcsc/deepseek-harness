/**
 * Pure-TypeScript classic Shadowsocks AEAD (`aes-128-gcm`, `aes-256-gcm`, `chacha20-ietf-poly1305`)
 * stream client using OpenSSL `EVP_BytesToKey` (MD5) and RFC 5869 `HKDF-SHA1` (`info = "ss-subkey"`).
 */

import { createHash, hkdfSync, randomBytes } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { VpnTunnelError } from '../error.ts'
import type { ProxyNodeConfig } from '../types.ts'
import { encodeSocks5TargetAddress } from './address.ts'
import {
  aeadSeal,
  createShadowsocksAeadDuplex,
  nonce12LittleEndian,
  type NodeAeadAlgorithm,
} from './aead.ts'
import { writeAll } from './stream-io.ts'

interface SsAeadCipherSpec {
  readonly keySize: 16 | 32
  readonly saltSize: 16 | 32
  readonly algorithm: NodeAeadAlgorithm
}

const SS_AEAD_CIPHERS: Readonly<Record<string, SsAeadCipherSpec>> = {
  'aes-128-gcm': { keySize: 16, saltSize: 16, algorithm: 'aes-128-gcm' },
  'aes-256-gcm': { keySize: 32, saltSize: 32, algorithm: 'aes-256-gcm' },
  'chacha20-ietf-poly1305': { keySize: 32, saltSize: 32, algorithm: 'chacha20-poly1305' },
  'chacha20-poly1305': { keySize: 32, saltSize: 32, algorithm: 'chacha20-poly1305' },
}

const SS_SUBKEY_INFO = Buffer.from('ss-subkey', 'ascii')

/**
 * Derive a Shadowsocks master key from a UTF-8 password via iterative MD5 (`EVP_BytesToKey`).
 * @param password - node password string.
 * @param keySize - target key length (`16` or `32` bytes).
 * @returns derived master key buffer.
 */
export function evpBytesToKey(password: string, keySize: number): Buffer {
  const passBytes = Buffer.from(password, 'utf8')
  const chunks: Buffer[] = []
  let total = 0
  let prev: Buffer = Buffer.alloc(0)
  while (total < keySize) {
    const md5 = createHash('md5')
    if (prev.length > 0) md5.update(prev)
    md5.update(passBytes)
    prev = md5.digest()
    chunks.push(prev)
    total += prev.length
  }
  return Buffer.concat(chunks).subarray(0, keySize)
}

/**
 * Derive a per-direction Shadowsocks AEAD session subkey via `HKDF-SHA1(ikm = masterKey, salt, info = "ss-subkey")`.
 * @param masterKey - master key from {@link evpBytesToKey}.
 * @param salt - per-direction random salt.
 * @param keySize - session subkey length in bytes.
 * @returns derived session subkey buffer.
 */
export function deriveSsSubkey(masterKey: Uint8Array, salt: Uint8Array, keySize: number): Buffer {
  return Buffer.from(hkdfSync('sha1', masterKey, salt, SS_SUBKEY_INFO, keySize))
}

/** Handshake options for {@link dialShadowsocksAead}. */
export interface DialShadowsocksAeadOptions {
  /** Defer emitting the salt and encrypted target header until the first outbound plaintext write. */
  readonly deferHandshakeWrite?: boolean
}

/**
 * Send (or defer onto the first outbound write) the classic Shadowsocks AEAD salt and encrypted SOCKS5
 * target-address chunk over `transport` and return an authenticated `Duplex` stream.
 * @param transport - underlying TCP, TLS, `simple-obfs`, or WebSocket duplex.
 * @param node - classic Shadowsocks AEAD node configuration.
 * @param targetHost - destination hostname or IP literal.
 * @param targetPort - destination TCP port.
 * @param options - optional deferred handshake coalescing configuration.
 * @returns plaintext `Duplex` tunnel stream.
 */
export async function dialShadowsocksAead(
  transport: Duplex,
  node: ProxyNodeConfig,
  targetHost: string,
  targetPort: number,
  options?: DialShadowsocksAeadOptions,
): Promise<Duplex> {
  const rawCipher = node.cipher ?? ''
  const spec = SS_AEAD_CIPHERS[rawCipher.toLowerCase()]
  if (spec === undefined) {
    throw new VpnTunnelError('VPN_UNSUPPORTED_PROTOCOL', `Unsupported Shadowsocks AEAD cipher: ${rawCipher}`)
  }
  if (!node.password || node.password.length === 0) {
    throw new VpnTunnelError('VPN_INVALID_CONFIG', 'Shadowsocks AEAD password must be non-empty')
  }

  const masterKey = evpBytesToKey(node.password, spec.keySize)
  const reqSalt = randomBytes(spec.saltSize)
  const c2sKey = deriveSsSubkey(masterKey, reqSalt, spec.keySize)

  const addrBytes = encodeSocks5TargetAddress(targetHost, targetPort)
  const lenBuf = Buffer.allocUnsafe(2)
  lenBuf.writeUInt16BE(addrBytes.length, 0)
  const encAddrLen = aeadSeal(spec.algorithm, c2sKey, nonce12LittleEndian(0n), lenBuf)
  const encAddr = aeadSeal(spec.algorithm, c2sKey, nonce12LittleEndian(1n), addrBytes)
  const headerPrefix = Buffer.concat([reqSalt, encAddrLen, encAddr])

  const deferWrite = options?.deferHandshakeWrite ?? false
  if (!deferWrite) {
    await writeAll(transport, headerPrefix)
  }

  return createShadowsocksAeadDuplex({
    transport,
    algorithm: spec.algorithm,
    encodeKey: c2sKey,
    initialEncodeCounter: 2n,
    maxChunkPayload: 0x3fff,
    lengthMask: 0x3fff,
    ...(deferWrite ? { firstWritePrefix: headerPrefix } : {}),
    initDecoder(buffered: Buffer) {
      if (buffered.length < spec.saltSize) return null
      const respSalt = buffered.subarray(0, spec.saltSize)
      const s2cKey = deriveSsSubkey(masterKey, respSalt, spec.keySize)
      return {
        decodeKey: s2cKey,
        initialDecodeCounter: 0n,
        consumedBytes: spec.saltSize,
      }
    },
  })
}
