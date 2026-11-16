/**
 * Shared AEAD encryption/decryption primitives (`aes-128-gcm`, `aes-256-gcm`, `chacha20-poly1305`)
 * and chunk-framed Shadowsocks AEAD duplex stream helpers built strictly on `node:crypto`.
 */

import { createCipheriv, createDecipheriv } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { VpnTunnelError } from '../error.ts'
import { createCarrierTransformDuplex } from './stream-io.ts'

/** Supported Node `node:crypto` AEAD algorithm identifiers used by proxy protocols. */
export type NodeAeadAlgorithm = 'aes-128-gcm' | 'aes-256-gcm' | 'chacha20-poly1305'

/** Authentication tag length in bytes for all supported AEAD ciphers. */
export const AEAD_TAG_LEN = 16

/** Nonce length in bytes for all supported AEAD ciphers. */
export const AEAD_NONCE_LEN = 12

/**
 * Encode a 64-bit counter into a 12-byte little-endian AEAD nonce (used by Shadowsocks AEAD and Shadowsocks 2022).
 * @param counter - monotonically increasing frame counter.
 * @returns 12-byte little-endian nonce buffer.
 */
export function nonce12LittleEndian(counter: bigint): Buffer {
  const buf = Buffer.alloc(AEAD_NONCE_LEN)
  buf.writeBigUInt64LE(counter & 0xffffffffffffffffn, 0)
  return buf
}

/**
 * Encrypt `plaintext` with an AEAD cipher and append the 16-byte authentication tag.
 * @param algorithm - Node AEAD cipher name.
 * @param key - symmetric session subkey (`16` or `32` bytes).
 * @param nonce - 12-byte unique nonce.
 * @param plaintext - plaintext slice to seal.
 * @param aad - optional additional authenticated data.
 * @returns `ciphertext || tag` buffer (`plaintext.length + 16` bytes).
 */
export function aeadSeal(
  algorithm: NodeAeadAlgorithm,
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad?: Uint8Array,
): Buffer {
  const cipher = algorithm === 'chacha20-poly1305'
    ? createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: AEAD_TAG_LEN })
    : createCipheriv(algorithm, key, nonce, { authTagLength: AEAD_TAG_LEN })
  if (aad !== undefined) {
    cipher.setAAD(aad, { plaintextLength: plaintext.length })
  }
  const encrypted = cipher.update(plaintext)
  const final = cipher.final()
  const tag = cipher.getAuthTag()
  return Buffer.concat([encrypted, final, tag])
}

/**
 * Decrypt and authenticate `ciphertextWithTag` (`ciphertext || 16B tag`) with an AEAD cipher.
 * @param algorithm - Node AEAD cipher name.
 * @param key - symmetric session subkey (`16` or `32` bytes).
 * @param nonce - 12-byte nonce matching encryption.
 * @param ciphertextWithTag - sealed payload ending in a 16-byte authentication tag.
 * @param aad - optional additional authenticated data.
 * @returns verified plaintext buffer.
 */
export function aeadOpen(
  algorithm: NodeAeadAlgorithm,
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertextWithTag: Uint8Array,
  aad?: Uint8Array,
): Buffer {
  if (ciphertextWithTag.length < AEAD_TAG_LEN) {
    throw new VpnTunnelError('VPN_AUTH_FAILED', 'AEAD frame shorter than 16-byte authentication tag')
  }
  const body = ciphertextWithTag.subarray(0, ciphertextWithTag.length - AEAD_TAG_LEN)
  const tag = ciphertextWithTag.subarray(ciphertextWithTag.length - AEAD_TAG_LEN)
  try {
    const decipher = algorithm === 'chacha20-poly1305'
      ? createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: AEAD_TAG_LEN })
      : createDecipheriv(algorithm, key, nonce, { authTagLength: AEAD_TAG_LEN })
    if (aad !== undefined) {
      decipher.setAAD(aad, { plaintextLength: body.length })
    }
    decipher.setAuthTag(tag)
    const decrypted = decipher.update(body)
    const final = decipher.final()
    return Buffer.concat([decrypted, final])
  } catch (err) {
    throw new VpnTunnelError('VPN_AUTH_FAILED', 'AEAD authentication tag verification failed', { cause: err })
  }
}

/** Parameters configuring a chunk-framed Shadowsocks AEAD duplex stream after handshake completion. */
export interface ShadowsocksAeadStreamSpec {
  /** Underlying transport stream (`net.Socket`, `TLSSocket`, `simple-obfs`, or `WebSocket` duplex). */
  readonly transport: Duplex
  /** Negotiated Node AEAD cipher name. */
  readonly algorithm: NodeAeadAlgorithm
  /** Client-to-server session subkey. */
  readonly encodeKey: Uint8Array
  /** Starting client-to-server nonce counter (`2n` for SS-2022, `0n` for classic SS-AEAD). */
  readonly initialEncodeCounter: bigint
  /** Maximum plaintext bytes per encrypted chunk (`0xffff` for SS-2022, `0x3fff` for classic SS-AEAD). */
  readonly maxChunkPayload: number
  /** Maximum bitmask applied to decoded 16-bit length headers (`0xffff` for SS-2022, `0x3fff` for classic SS-AEAD). */
  readonly lengthMask: number
  /** Optional prefix bytes prepended to the very first client write (used by classic SS-AEAD salt emission). */
  readonly firstWritePrefix?: Buffer
  /** Optional hook packing part or all of the first plaintext write into a protocol greeting frame (used by SS-2022 `varPlain`). */
  readonly encodeFirstChunk?: (chunk: Buffer) => {
    readonly prefixWire: Buffer
    readonly remainingPlaintext: Buffer
  }
  /** Callback deriving the server-to-client subkey and starting nonce once the response salt/header arrives. */
  readonly initDecoder: (buffered: Buffer) => {
    readonly decodeKey: Uint8Array
    readonly initialDecodeCounter: bigint
    readonly consumedBytes: number
    readonly initialPlaintext?: Buffer
  } | null
}

/**
 * Wrap `spec.transport` in a Node `Duplex` implementing Shadowsocks AEAD chunk framing (`encLen(2+16) || encPayload(N+16)`).
 * @param spec - cipher, key, counter, and response-header decoder specification.
 * @returns plaintext `Duplex` tunnel stream.
 */
export function createShadowsocksAeadDuplex(spec: ShadowsocksAeadStreamSpec): Duplex {
  let encodeCounter = spec.initialEncodeCounter
  let decodeCounter = 0n
  let decodeKey: Uint8Array | null = null
  let pendingRead: Buffer = Buffer.alloc(0)
  let expectedPayloadLen: number | null = null
  let firstChunkEncoded = spec.encodeFirstChunk === undefined
  let prefixSent = spec.firstWritePrefix === undefined

  const encodePlaintext = (chunk: Buffer): Buffer => {
    const frames: Buffer[] = []
    let remaining = chunk
    if (!firstChunkEncoded && spec.encodeFirstChunk !== undefined) {
      firstChunkEncoded = true
      const packed = spec.encodeFirstChunk(chunk)
      frames.push(packed.prefixWire)
      remaining = packed.remainingPlaintext
    } else if (!prefixSent && spec.firstWritePrefix !== undefined) {
      prefixSent = true
      frames.push(spec.firstWritePrefix)
    }
    let offset = 0
    while (offset < remaining.length) {
      const slice = remaining.subarray(offset, Math.min(offset + spec.maxChunkPayload, remaining.length))
      const lenBuf = Buffer.allocUnsafe(2)
      lenBuf.writeUInt16BE(slice.length, 0)
      const encLen = aeadSeal(spec.algorithm, spec.encodeKey, nonce12LittleEndian(encodeCounter), lenBuf)
      encodeCounter += 1n
      const encPayload = aeadSeal(spec.algorithm, spec.encodeKey, nonce12LittleEndian(encodeCounter), slice)
      encodeCounter += 1n
      frames.push(encLen, encPayload)
      offset += slice.length
    }
    return Buffer.concat(frames)
  }

  return createCarrierTransformDuplex(spec.transport, {
    encodeChunk: encodePlaintext,
    onData(incoming, push) {
      pendingRead = pendingRead.length === 0 ? incoming : Buffer.concat([pendingRead, incoming])
      if (decodeKey === null) {
        const init = spec.initDecoder(pendingRead)
        if (init === null) return
        decodeKey = init.decodeKey
        decodeCounter = init.initialDecodeCounter
        pendingRead = pendingRead.subarray(init.consumedBytes)
        if (init.initialPlaintext !== undefined && init.initialPlaintext.length > 0) {
          push(init.initialPlaintext)
        }
      }

      while (true) {
        if (expectedPayloadLen === null) {
          if (pendingRead.length < 2 + AEAD_TAG_LEN) break
          const rawLenBlock = pendingRead.subarray(0, 2 + AEAD_TAG_LEN)
          const lenPlain = aeadOpen(spec.algorithm, decodeKey, nonce12LittleEndian(decodeCounter), rawLenBlock)
          decodeCounter += 1n
          expectedPayloadLen = lenPlain.readUInt16BE(0) & spec.lengthMask
          pendingRead = pendingRead.subarray(2 + AEAD_TAG_LEN)
        }

        const needed = expectedPayloadLen + AEAD_TAG_LEN
        if (pendingRead.length < needed) break
        const rawPayloadBlock = pendingRead.subarray(0, needed)
        pendingRead = pendingRead.subarray(needed)
        expectedPayloadLen = null
        const plain = aeadOpen(spec.algorithm, decodeKey, nonce12LittleEndian(decodeCounter), rawPayloadBlock)
        decodeCounter += 1n
        if (plain.length > 0) {
          push(plain)
        }
      }
    },
  })
}
