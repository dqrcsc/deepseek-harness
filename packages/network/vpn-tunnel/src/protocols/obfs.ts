/**
 * Pure-TypeScript SIP003 `simple-obfs` (`http` and `tls`) transport wrappers over `Duplex` streams.
 */

import { randomBytes, randomInt } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { VpnTunnelError } from '../error.ts'
import { createCarrierTransformDuplex } from './stream-io.ts'

const CRLF_DOUBLE = Buffer.from('\r\n\r\n', 'ascii')
const OBFS_HTTP_MAX_HEADER = 16_384
const OBFS_TLS_MAX_APP_CHUNK = 16_384
const OBFS_TLS_CIPHER_SUITES = Buffer.from(
  'c02bc02fcca9cca8cc14cc13c00ac014c009c013009c009d002f0035',
  'hex',
)
const OBFS_TLS_STATIC_EXTS = Buffer.from(
  'ff01000100' // renegotiation_info
  + '000a00080006001d00170018' // elliptic_curves
  + '000b00020100', // ec_point_formats
  'hex',
)

function buildTlsClientHelloRecord(obfsHost: string, payload: Buffer): Buffer {
  const sniBytes = Buffer.from(obfsHost, 'utf8')
  const randomField = Buffer.allocUnsafe(32)
  randomField.writeUInt32BE(Math.floor(Date.now() / 1000) >>> 0, 0)
  randomBytes(28).copy(randomField, 4)
  const sessionId = randomBytes(32)

  const extTicket = Buffer.allocUnsafe(4 + payload.length)
  extTicket.writeUInt16BE(0x0023, 0)
  extTicket.writeUInt16BE(payload.length, 2)
  payload.copy(extTicket, 4)

  const sniItemLen = 3 + sniBytes.length
  const extSni = Buffer.allocUnsafe(4 + 2 + sniItemLen)
  extSni.writeUInt16BE(0x0000, 0)
  extSni.writeUInt16BE(2 + sniItemLen, 2)
  extSni.writeUInt16BE(sniItemLen, 4)
  extSni[6] = 0x00
  extSni.writeUInt16BE(sniBytes.length, 7)
  sniBytes.copy(extSni, 9)

  const extensions = Buffer.concat([extTicket, extSni, OBFS_TLS_STATIC_EXTS])
  const cipherSuitesLen = Buffer.allocUnsafe(2)
  cipherSuitesLen.writeUInt16BE(OBFS_TLS_CIPHER_SUITES.length, 0)
  const extensionsLen = Buffer.allocUnsafe(2)
  extensionsLen.writeUInt16BE(extensions.length, 0)

  const helloBody = Buffer.concat([
    Buffer.from([0x03, 0x03]),
    randomField,
    Buffer.from([sessionId.length]),
    sessionId,
    cipherSuitesLen,
    OBFS_TLS_CIPHER_SUITES,
    Buffer.from([0x01, 0x00]),
    extensionsLen,
    extensions,
  ])

  const handshake = Buffer.allocUnsafe(4 + helloBody.length)
  handshake[0] = 0x01
  handshake[1] = (helloBody.length >>> 16) & 0xff
  handshake[2] = (helloBody.length >>> 8) & 0xff
  handshake[3] = helloBody.length & 0xff
  helloBody.copy(handshake, 4)

  const record = Buffer.allocUnsafe(5 + handshake.length)
  record[0] = 0x16
  record[1] = 0x03
  record[2] = 0x01
  record.writeUInt16BE(handshake.length, 3)
  handshake.copy(record, 5)
  return record
}

function wrapTlsAppDataFrames(data: Buffer): Buffer {
  const parts: Buffer[] = []
  let offset = 0
  while (offset < data.length) {
    const slice = data.subarray(offset, Math.min(offset + OBFS_TLS_MAX_APP_CHUNK, data.length))
    const hdr = Buffer.allocUnsafe(5)
    hdr[0] = 0x17
    hdr[1] = 0x03
    hdr[2] = 0x03
    hdr.writeUInt16BE(slice.length, 3)
    parts.push(hdr, slice)
    offset += slice.length
  }
  return Buffer.concat(parts)
}

/**
 * Wrap `transport` in SIP003 `simple-obfs` HTTP mode (`obfs=http`).
 * @param transport - underlying raw TCP duplex.
 * @param obfsHost - spoofed HTTP `Host` header domain.
 * @param port - remote proxy server port.
 * @param uri - request path (defaults to `/`).
 * @returns obfuscated `Duplex` passing inner proxy bytes transparently.
 */
export function wrapSimpleObfsHttp(
  transport: Duplex,
  obfsHost: string,
  port: number,
  uri = '/',
): Duplex {
  let reqSent = false
  let respStripped = false
  let headerBuf: Buffer = Buffer.alloc(0)

  return createCarrierTransformDuplex(transport, {
    encodeChunk(chunk) {
      if (reqSent) return chunk
      reqSent = true
      const hostHeader = port === 80 || port === 443 ? obfsHost : `${obfsHost}:${String(port)}`
      const wsKey = randomBytes(16).toString('base64')
      const verMajor = randomInt(70, 89)
      const verMinor = randomInt(0, 4)
      const requestPath = uri.startsWith('/') ? uri : `/${uri}`
      const hdr = Buffer.from(
        `GET ${requestPath} HTTP/1.1\r\n`
        + `Host: ${hostHeader}\r\n`
        + `User-Agent: curl/7.${String(verMajor)}.${String(verMinor)}\r\n`
        + 'Upgrade: websocket\r\n'
        + 'Connection: Upgrade\r\n'
        + `Sec-WebSocket-Key: ${wsKey}\r\n`
        + `Content-Length: ${String(chunk.length)}\r\n`
        + '\r\n',
        'ascii',
      )
      return Buffer.concat([hdr, chunk])
    },
    onData(chunk, push) {
      if (respStripped) {
        push(chunk)
        return
      }
      headerBuf = headerBuf.length === 0 ? chunk : Buffer.concat([headerBuf, chunk])
      const idx = headerBuf.indexOf(CRLF_DOUBLE)
      if (idx < 0) {
        if (headerBuf.length > OBFS_HTTP_MAX_HEADER) {
          throw new VpnTunnelError('VPN_PROTOCOL_ERROR', 'obfs-http response header exceeded 16 KiB')
        }
        return
      }
      respStripped = true
      const remainder = headerBuf.subarray(idx + CRLF_DOUBLE.length)
      headerBuf = Buffer.alloc(0)
      if (remainder.length > 0) {
        push(remainder)
      }
    },
    onEnd() {
      if (!respStripped && headerBuf.length > 0) {
        throw new VpnTunnelError('VPN_PROTOCOL_ERROR', 'Connection closed before obfs-http response header')
      }
    },
  })
}

/**
 * Wrap `transport` in SIP003 `simple-obfs` TLS mode (`obfs=tls`).
 * @param transport - underlying raw TCP duplex.
 * @param obfsHost - spoofed TLS SNI hostname.
 * @returns obfuscated `Duplex` passing inner proxy bytes transparently.
 */
export function wrapSimpleObfsTls(transport: Duplex, obfsHost: string): Duplex {
  const host = obfsHost.length > 0 ? obfsHost : 'www.bing.com'
  let reqSent = false
  let stage: 'server-hello' | 'ccs' | 'post-ccs' | 'app-data' = 'server-hello'
  let rawBuf: Buffer = Buffer.alloc(0)

  return createCarrierTransformDuplex(transport, {
    encodeChunk(chunk) {
      if (!reqSent) {
        reqSent = true
        const head = chunk.subarray(0, 8192)
        const tail = chunk.subarray(8192)
        const hello = buildTlsClientHelloRecord(host, head)
        return tail.length > 0 ? Buffer.concat([hello, wrapTlsAppDataFrames(tail)]) : hello
      }
      return wrapTlsAppDataFrames(chunk)
    },
    onData(chunk, push) {
      rawBuf = rawBuf.length === 0 ? chunk : Buffer.concat([rawBuf, chunk])
      while (rawBuf.length >= 5) {
        const recType = rawBuf[0] as number
        const recLen = rawBuf.readUInt16BE(3)
        if (rawBuf.length < 5 + recLen) break
        const recBody = rawBuf.subarray(5, 5 + recLen)
        rawBuf = rawBuf.subarray(5 + recLen)

        if (stage === 'server-hello' && recType === 0x16) {
          stage = 'ccs'
          continue
        }
        if ((stage === 'server-hello' || stage === 'ccs') && recType === 0x14) {
          stage = 'post-ccs'
          continue
        }
        if (stage === 'post-ccs' && (recType === 0x16 || recType === 0x17)) {
          stage = 'app-data'
          if (recBody.length > 0) push(recBody)
          continue
        }
        if (recType === 0x17) {
          stage = 'app-data'
          if (recBody.length > 0) push(recBody)
        }
      }
    },
    onEnd() {
      if (rawBuf.length > 0) {
        throw new VpnTunnelError('VPN_PROTOCOL_ERROR', 'Truncated obfs-tls record on EOF')
      }
    },
  })
}
