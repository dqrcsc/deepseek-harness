/**
 * Pure-TypeScript Shadowsocks 2022 (`2022-blake3-aes-128-gcm`, `2022-blake3-aes-256-gcm`, `2022-blake3-chacha20-poly1305`)
 * stream client with SIP023 Multi-PSK Extended Identity Header (EIH) and server timestamp / salt verification.
 */

import { createCipheriv, randomBytes, randomInt } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { blake3DeriveKey, blake3Hash } from '../blake3.ts'
import { VpnTunnelError } from '../error.ts'
import type { ProxyNodeConfig } from '../types.ts'
import { encodeSocks5TargetAddress } from './address.ts'
import {
  AEAD_TAG_LEN,
  aeadOpen,
  aeadSeal,
  createShadowsocksAeadDuplex,
  nonce12LittleEndian,
  type NodeAeadAlgorithm,
} from './aead.ts'
import { writeAll } from './stream-io.ts'

interface Ss2022CipherSpec {
  readonly keySize: 16 | 32
  readonly algorithm: NodeAeadAlgorithm
  readonly eihCipher: 'aes-128-ecb' | 'aes-256-ecb' | null
}

const SS2022_CIPHERS: Readonly<Record<string, Ss2022CipherSpec>> = {
  '2022-blake3-aes-128-gcm': {
    keySize: 16,
    algorithm: 'aes-128-gcm',
    eihCipher: 'aes-128-ecb',
  },
  '2022-blake3-aes-256-gcm': {
    keySize: 32,
    algorithm: 'aes-256-gcm',
    eihCipher: 'aes-256-ecb',
  },
  '2022-blake3-chacha20-poly1305': {
    keySize: 32,
    algorithm: 'chacha20-poly1305',
    eihCipher: null,
  },
}

const SS2022_MAX_TIME_SKEW_SECONDS = 30
const SS2022_MAX_INLINE_INITIAL_PAYLOAD = 0x8000

/** Handshake options for {@link dialShadowsocks2022}. */
export interface DialShadowsocks2022Options {
  /** Defer emitting the SS-2022 greeting until the first outbound plaintext write so initial payload packs into `varPlain`. */
  readonly deferGreeting?: boolean
}

function decodeBase64PskList(password: string, keySize: number): Buffer[] {
  const parts = password.split(':').map(part => part.trim()).filter(part => part.length > 0)
  if (parts.length === 0) {
    throw new VpnTunnelError('VPN_INVALID_CONFIG', 'Shadowsocks 2022 password contains no Base64 PSK')
  }
  return parts.map((segment) => {
    const padded = segment + '='.repeat((4 - (segment.length % 4)) % 4)
    const buf = Buffer.from(padded, 'base64')
    if (buf.length !== keySize) {
      throw new VpnTunnelError(
        'VPN_INVALID_CONFIG',
        `Shadowsocks 2022 PSK decoded to ${String(buf.length)} bytes; expected ${String(keySize)}`,
      )
    }
    return buf
  })
}

function buildEihHeaders(
  psks: readonly Buffer[],
  reqSalt: Buffer,
  keySize: number,
  eihCipher: 'aes-128-ecb' | 'aes-256-ecb' | null,
): Buffer {
  if (psks.length <= 1) return Buffer.alloc(0)
  if (eihCipher === null) {
    throw new VpnTunnelError('VPN_PROTOCOL_ERROR', 'SIP023 EIH requires an AES-GCM Shadowsocks 2022 cipher')
  }
  const blocks: Buffer[] = []
  for (let i = 0; i < psks.length - 1; i += 1) {
    const currentPsk = psks[i] as Buffer
    const nextPsk = psks[i + 1] as Buffer
    const idSubkey = blake3DeriveKey(
      'shadowsocks 2022 identity subkey',
      Buffer.concat([currentPsk, reqSalt]),
      keySize,
    )
    const pskHash = blake3Hash(nextPsk, 16)
    const cipher = createCipheriv(eihCipher, idSubkey, null)
    cipher.setAutoPadding(false)
    blocks.push(Buffer.concat([cipher.update(pskHash), cipher.final()]))
  }
  return Buffer.concat(blocks)
}

/**
 * Send (or defer onto the first outbound write) the Shadowsocks 2022 client stream greeting
 * (including optional SIP023 Multi-PSK EIH) over `transport` and return an authenticated AEAD-2022 `Duplex` stream.
 * @param transport - underlying TCP, TLS, `simple-obfs`, or WebSocket duplex.
 * @param node - SS-2022 proxy node configuration.
 * @param targetHost - destination hostname or IP literal.
 * @param targetPort - destination TCP port.
 * @param options - optional deferred greeting coalescing configuration.
 * @returns plaintext `Duplex` tunnel stream.
 */
export async function dialShadowsocks2022(
  transport: Duplex,
  node: ProxyNodeConfig,
  targetHost: string,
  targetPort: number,
  options?: DialShadowsocks2022Options,
): Promise<Duplex> {
  const rawCipher = node.cipher ?? ''
  const spec = SS2022_CIPHERS[rawCipher.toLowerCase()]
  if (spec === undefined) {
    throw new VpnTunnelError('VPN_UNSUPPORTED_PROTOCOL', `Unsupported Shadowsocks 2022 cipher: ${rawCipher}`)
  }

  const psks = decodeBase64PskList(node.password ?? '', spec.keySize)
  const uPsk = psks[psks.length - 1] as Buffer
  const reqSalt = randomBytes(spec.keySize)
  const c2sKey = blake3DeriveKey(
    'shadowsocks 2022 session subkey',
    Buffer.concat([uPsk, reqSalt]),
    spec.keySize,
  )

  const eihBytes = buildEihHeaders(psks, reqSalt, spec.keySize, spec.eihCipher)
  const addrBytes = encodeSocks5TargetAddress(targetHost, targetPort)
  const clockOffset = node.clockOffsetSeconds ?? 0

  const buildGreetingFrame = (initialHead: Buffer): Buffer => {
    const padLen = initialHead.length > 0 ? randomInt(0, 33) : randomInt(32, 97)
    const padHeader = Buffer.allocUnsafe(2)
    padHeader.writeUInt16BE(padLen, 0)
    const varPlain = Buffer.concat([addrBytes, padHeader, randomBytes(padLen), initialHead])

    const nowSec = Math.floor(Date.now() / 1000) + clockOffset
    const fixedPlain = Buffer.allocUnsafe(11)
    fixedPlain[0] = 0x00
    fixedPlain.writeBigUInt64BE(BigInt(nowSec), 1)
    fixedPlain.writeUInt16BE(varPlain.length, 9)

    const encFixed = aeadSeal(spec.algorithm, c2sKey, nonce12LittleEndian(0n), fixedPlain)
    const encVar = aeadSeal(spec.algorithm, c2sKey, nonce12LittleEndian(1n), varPlain)
    return Buffer.concat([reqSalt, eihBytes, encFixed, encVar])
  }

  const deferGreeting = options?.deferGreeting ?? false
  if (!deferGreeting) {
    await writeAll(transport, buildGreetingFrame(Buffer.alloc(0)))
  }

  const fixedRespPlainLen = 1 + 8 + spec.keySize + 2
  const minRespHeaderBytes = spec.keySize + fixedRespPlainLen + AEAD_TAG_LEN

  return createShadowsocksAeadDuplex({
    transport,
    algorithm: spec.algorithm,
    encodeKey: c2sKey,
    initialEncodeCounter: 2n,
    maxChunkPayload: 0xffff,
    lengthMask: 0xffff,
    ...(deferGreeting
      ? {
        encodeFirstChunk: chunk => ({
          prefixWire: buildGreetingFrame(chunk.subarray(0, SS2022_MAX_INLINE_INITIAL_PAYLOAD)),
          remainingPlaintext: chunk.subarray(SS2022_MAX_INLINE_INITIAL_PAYLOAD),
        }),
      }
      : {}),
    initDecoder(buffered: Buffer) {
      if (buffered.length < minRespHeaderBytes) return null
      const respSalt = buffered.subarray(0, spec.keySize)
      const s2cKey = blake3DeriveKey(
        'shadowsocks 2022 session subkey',
        Buffer.concat([uPsk, respSalt]),
        spec.keySize,
      )
      const encRespFixed = buffered.subarray(spec.keySize, minRespHeaderBytes)
      const respFixed = aeadOpen(spec.algorithm, s2cKey, nonce12LittleEndian(0n), encRespFixed)

      const respType = respFixed[0] as number
      const serverTs = Number(respFixed.readBigUInt64BE(1))
      const echoedSalt = respFixed.subarray(9, 9 + spec.keySize)
      const firstChunkLen = respFixed.readUInt16BE(9 + spec.keySize)

      if (respType !== 0x01 || !echoedSalt.equals(reqSalt)) {
        throw new VpnTunnelError('VPN_AUTH_FAILED', 'Shadowsocks 2022 server response header verification failed')
      }
      const expectedNow = Math.floor(Date.now() / 1000) + clockOffset
      if (Math.abs(expectedNow - serverTs) > SS2022_MAX_TIME_SKEW_SECONDS) {
        throw new VpnTunnelError('VPN_AUTH_FAILED', 'Shadowsocks 2022 server timestamp exceeded 30s replay window')
      }

      if (firstChunkLen === 0) {
        return {
          decodeKey: s2cKey,
          initialDecodeCounter: 1n,
          consumedBytes: minRespHeaderBytes,
        }
      }

      const totalNeeded = minRespHeaderBytes + firstChunkLen + AEAD_TAG_LEN
      if (buffered.length < totalNeeded) return null

      const encFirstChunk = buffered.subarray(minRespHeaderBytes, totalNeeded)
      const firstPlain = aeadOpen(spec.algorithm, s2cKey, nonce12LittleEndian(1n), encFirstChunk)
      return {
        decodeKey: s2cKey,
        initialDecodeCounter: 2n,
        consumedBytes: totalNeeded,
        initialPlaintext: firstPlain,
      }
    },
  })
}
