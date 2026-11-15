/**
 * Pure-TypeScript VMess AEAD (`aes-128-gcm`, `chacha20-poly1305`) stream client implementing V2Ray / mihomo / sing-box
 * nested HMAC-SHA256 KDF, AES-ECB `AuthID`, AEAD command/response headers, and chunk-stream framing.
 */

import { createCipheriv, createHash, randomBytes, randomInt } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { crc32 } from 'node:zlib'
import { VpnTunnelError } from '../error.ts'
import type { ProxyNodeConfig } from '../types.ts'
import { encodePortFirstTargetAddress } from './address.ts'
import { AEAD_TAG_LEN, aeadOpen, aeadSeal, type NodeAeadAlgorithm } from './aead.ts'
import { createCarrierTransformDuplex, writeAll } from './stream-io.ts'
import { parseUuidBytes } from './vless.ts'

const VMESS_MAGIC_UUID_SUFFIX = Buffer.from('c48619fe-8f02-49e0-b9e9-edf763e17e21', 'ascii')
const VMESS_KDF_SALT = Buffer.from('VMess AEAD KDF', 'ascii')
const HMAC_BLOCK_SIZE = 64
const VMESS_MAX_CHUNK_PLAIN = 16_384

type HashFn = (input: Uint8Array) => Buffer

function sha256Fn(input: Uint8Array): Buffer {
  return createHash('sha256').update(input).digest()
}

function md5Bytes(input: Uint8Array): Buffer {
  return createHash('md5').update(input).digest()
}

function createNestedHmacFn(innerHash: HashFn, key: Uint8Array): HashFn {
  const keyBlock = Buffer.alloc(HMAC_BLOCK_SIZE)
  if (key.length > HMAC_BLOCK_SIZE) {
    innerHash(key).copy(keyBlock, 0)
  } else {
    Buffer.from(key.buffer, key.byteOffset, key.byteLength).copy(keyBlock, 0)
  }
  const ipad = Buffer.allocUnsafe(HMAC_BLOCK_SIZE)
  const opad = Buffer.allocUnsafe(HMAC_BLOCK_SIZE)
  for (let i = 0; i < HMAC_BLOCK_SIZE; i += 1) {
    const kb = keyBlock[i] as number
    ipad[i] = kb ^ 0x36
    opad[i] = kb ^ 0x5c
  }
  return (message: Uint8Array): Buffer => {
    const innerDigest = innerHash(Buffer.concat([ipad, message]))
    return innerHash(Buffer.concat([opad, innerDigest]))
  }
}

/**
 * Derive a VMess AEAD subkey via V2Ray's nested HMAC-SHA256 construction.
 * @param key - base command or body key.
 * @param paths - domain-separation path components.
 * @returns 32-byte derived KDF digest.
 */
export function vmessKdf(key: Uint8Array, paths: readonly (string | Uint8Array)[]): Buffer {
  let hashFn: HashFn = createNestedHmacFn(sha256Fn, VMESS_KDF_SALT)
  for (const segment of paths) {
    const bytes = typeof segment === 'string' ? Buffer.from(segment, 'ascii') : segment
    hashFn = createNestedHmacFn(hashFn, bytes)
  }
  return hashFn(key)
}

function fnv1a32(data: Uint8Array): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < data.length; i += 1) {
    hash ^= data[i] as number
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

function vmessChunkNonce(counter: number, iv16: Uint8Array): Buffer {
  const nonce = Buffer.allocUnsafe(12)
  nonce.writeUInt16BE(counter & 0xffff, 0)
  Buffer.from(iv16.buffer, iv16.byteOffset + 2, 10).copy(nonce, 2)
  return nonce
}

function expandChachaKey32(key16: Uint8Array): Buffer {
  const first = md5Bytes(key16)
  const second = md5Bytes(first)
  return Buffer.concat([first, second])
}

/**
 * Send a VMess AEAD TCP request header over `transport` and return a chunk-framed plaintext `Duplex` stream.
 * @param transport - underlying TCP, TLS, or WebSocket duplex.
 * @param node - VMess proxy node configuration.
 * @param targetHost - destination hostname or IP literal.
 * @param targetPort - destination TCP port.
 * @returns plaintext `Duplex` tunnel stream.
 */
export async function dialVmess(
  transport: Duplex,
  node: ProxyNodeConfig,
  targetHost: string,
  targetPort: number,
): Promise<Duplex> {
  const uuidBytes = parseUuidBytes(node.uuid ?? '')
  const cmdKey = md5Bytes(Buffer.concat([uuidBytes, VMESS_MAGIC_UUID_SUFFIX]))

  const rawCipher = node.cipher ?? 'auto'
  const lowerCipher = rawCipher.toLowerCase()
  let securityId: number
  let algorithm: NodeAeadAlgorithm
  if (lowerCipher === 'auto' || lowerCipher === 'aes-128-gcm') {
    securityId = 0x03
    algorithm = 'aes-128-gcm'
  } else if (lowerCipher === 'chacha20-poly1305' || lowerCipher === 'chacha20-ietf-poly1305') {
    securityId = 0x04
    algorithm = 'chacha20-poly1305'
  } else {
    throw new VpnTunnelError('VPN_UNSUPPORTED_PROTOCOL', `Unsupported VMess AEAD cipher: ${rawCipher}`)
  }

  const dataBodyIV = randomBytes(16)
  const dataBodyKey = randomBytes(16)
  const respAuthV = randomInt(0, 256)
  const padLen = randomInt(0, 16)
  const targetAddr = encodePortFirstTargetAddress(targetHost, targetPort)

  const headerBody = Buffer.concat([
    Buffer.from([0x01]), // version = 1
    dataBodyIV,
    dataBodyKey,
    Buffer.from([
      respAuthV,
      0x01, // OptionChunkStream
      (padLen << 4) | securityId,
      0x00, // reserved
      0x01, // command = TCP
    ]),
    targetAddr,
    randomBytes(padLen),
  ])
  const fnvBuf = Buffer.allocUnsafe(4)
  fnvBuf.writeUInt32BE(fnv1a32(headerBody), 0)
  const cmdHeader = Buffer.concat([headerBody, fnvBuf])

  const nowSec = BigInt(Math.floor(Date.now() / 1000) + (node.clockOffsetSeconds ?? 0))
  const authPlain = Buffer.allocUnsafe(16)
  authPlain.writeBigUInt64BE(nowSec, 0)
  randomBytes(4).copy(authPlain, 8)
  authPlain.writeUInt32BE(crc32(authPlain.subarray(0, 12)) >>> 0, 12)

  const authKey = vmessKdf(cmdKey, ['AES Auth ID Encryption']).subarray(0, 16)
  const authCipher = createCipheriv('aes-128-ecb', authKey, null)
  authCipher.setAutoPadding(false)
  const authId = Buffer.concat([authCipher.update(authPlain), authCipher.final()])

  const connectionNonce = randomBytes(8)
  const lenKey = vmessKdf(cmdKey, ['VMess Header AEAD Key_Length', authId, connectionNonce]).subarray(0, 16)
  const lenNonce = vmessKdf(cmdKey, ['VMess Header AEAD Nonce_Length', authId, connectionNonce]).subarray(0, 12)
  const hdrLenBuf = Buffer.allocUnsafe(2)
  hdrLenBuf.writeUInt16BE(cmdHeader.length, 0)
  const encHeaderLen = aeadSeal('aes-128-gcm', lenKey, lenNonce, hdrLenBuf, authId)

  const hdrKey = vmessKdf(cmdKey, ['VMess Header AEAD Key', authId, connectionNonce]).subarray(0, 16)
  const hdrNonce = vmessKdf(cmdKey, ['VMess Header AEAD Nonce', authId, connectionNonce]).subarray(0, 12)
  const encHeader = aeadSeal('aes-128-gcm', hdrKey, hdrNonce, cmdHeader, authId)

  await writeAll(transport, Buffer.concat([authId, encHeaderLen, connectionNonce, encHeader]))

  const respBodyKey = sha256Fn(dataBodyKey).subarray(0, 16)
  const respBodyIV = sha256Fn(dataBodyIV).subarray(0, 16)
  const c2sCipherKey = algorithm === 'chacha20-poly1305' ? expandChachaKey32(dataBodyKey) : dataBodyKey
  const s2cCipherKey = algorithm === 'chacha20-poly1305' ? expandChachaKey32(respBodyKey) : respBodyKey

  let writeCount = 0
  let readCount = 0
  let respHeaderVerified = false
  let pendingRead: Buffer = Buffer.alloc(0)
  let expectedChunkCipherLen: number | null = null

  return createCarrierTransformDuplex(transport, {
    encodeChunk(chunk) {
      const frames: Buffer[] = []
      let offset = 0
      while (offset < chunk.length) {
        const slice = chunk.subarray(offset, Math.min(offset + VMESS_MAX_CHUNK_PLAIN, chunk.length))
        const sealed = aeadSeal(algorithm, c2sCipherKey, vmessChunkNonce(writeCount, dataBodyIV), slice)
        writeCount += 1
        const sizePrefix = Buffer.allocUnsafe(2)
        sizePrefix.writeUInt16BE(sealed.length, 0)
        frames.push(sizePrefix, sealed)
        offset += slice.length
      }
      return Buffer.concat(frames)
    },
    buildFinalFrame() {
      const eofChunk = aeadSeal(algorithm, c2sCipherKey, vmessChunkNonce(writeCount, dataBodyIV), Buffer.alloc(0))
      writeCount += 1
      const sizePrefix = Buffer.allocUnsafe(2)
      sizePrefix.writeUInt16BE(eofChunk.length, 0)
      return Buffer.concat([sizePrefix, eofChunk])
    },
    onData(incoming, push) {
      pendingRead = pendingRead.length === 0 ? incoming : Buffer.concat([pendingRead, incoming])
      if (!respHeaderVerified) {
        const encLenBytes = 2 + AEAD_TAG_LEN
        if (pendingRead.length < encLenBytes) return
        const respLenKey = vmessKdf(respBodyKey, ['AEAD Resp Header Len Key']).subarray(0, 16)
        const respLenNonce = vmessKdf(respBodyIV, ['AEAD Resp Header Len IV']).subarray(0, 12)
        const plainLenBuf = aeadOpen('aes-128-gcm', respLenKey, respLenNonce, pendingRead.subarray(0, encLenBytes))
        const respHdrLen = plainLenBuf.readUInt16BE(0)
        const totalHdrBytes = encLenBytes + respHdrLen + AEAD_TAG_LEN
        if (pendingRead.length < totalHdrBytes) return

        const respKey = vmessKdf(respBodyKey, ['AEAD Resp Header Key']).subarray(0, 16)
        const respNonce = vmessKdf(respBodyIV, ['AEAD Resp Header IV']).subarray(0, 12)
        const respHdr = aeadOpen(
          'aes-128-gcm',
          respKey,
          respNonce,
          pendingRead.subarray(encLenBytes, totalHdrBytes),
        )
        if (respHdr.length < 4 || respHdr[0] !== respAuthV) {
          throw new VpnTunnelError('VPN_AUTH_FAILED', 'VMess AEAD response verification byte mismatch')
        }
        respHeaderVerified = true
        pendingRead = pendingRead.subarray(totalHdrBytes)
      }

      while (true) {
        if (expectedChunkCipherLen === null) {
          if (pendingRead.length < 2) break
          expectedChunkCipherLen = pendingRead.readUInt16BE(0)
          pendingRead = pendingRead.subarray(2)
        }
        if (pendingRead.length < expectedChunkCipherLen) break
        const cipherChunk = pendingRead.subarray(0, expectedChunkCipherLen)
        pendingRead = pendingRead.subarray(expectedChunkCipherLen)
        expectedChunkCipherLen = null

        const plain = aeadOpen(algorithm, s2cCipherKey, vmessChunkNonce(readCount, respBodyIV), cipherChunk)
        readCount += 1
        if (plain.length === 0) {
          push(null)
          return
        }
        push(plain)
      }
    },
  })
}
