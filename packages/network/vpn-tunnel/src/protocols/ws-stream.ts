/**
 * Pure-TypeScript RFC 6455 client WebSocket `Duplex` carrier over an established TCP or TLS stream.
 */

import { createHash, randomBytes } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { VpnTunnelError } from '../error.ts'
import type { WsTransportConfig } from '../types.ts'
import { BufferedStreamReader, createCarrierTransformDuplex, writeAll } from './stream-io.ts'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const CRLF_DOUBLE = Buffer.from('\r\n\r\n', 'ascii')
const MAX_WS_CHUNK = 32_768

function encodeMaskedClientFrame(opcode: number, payload: Uint8Array): Buffer {
  const mask = randomBytes(4)
  let headerLen = 2
  if (payload.length >= 126 && payload.length <= 0xffff) headerLen += 2
  else if (payload.length > 0xffff) headerLen += 8

  const frame = Buffer.allocUnsafe(headerLen + 4 + payload.length)
  frame[0] = 0x80 | (opcode & 0x0f)
  let maskOffset = 2
  if (payload.length < 126) {
    frame[1] = 0x80 | payload.length
  } else if (payload.length <= 0xffff) {
    frame[1] = 0x80 | 126
    frame.writeUInt16BE(payload.length, 2)
    maskOffset = 4
  } else {
    frame[1] = 0x80 | 127
    frame.writeBigUInt64BE(BigInt(payload.length), 2)
    maskOffset = 10
  }

  mask.copy(frame, maskOffset)
  const dataOffset = maskOffset + 4
  for (let i = 0; i < payload.length; i += 1) {
    frame[dataOffset + i] = (payload[i] as number) ^ (mask[i & 3] as number)
  }
  return frame
}

/**
 * Perform an RFC 6455 HTTP/1.1 Upgrade handshake over `transport` and return a binary-framed `Duplex` stream.
 * @param transport - connected TCP or TLS stream.
 * @param defaultHost - fallback `Host` header hostname.
 * @param port - remote TCP port.
 * @param config - WebSocket path and custom headers.
 * @param signal - optional handshake cancellation signal.
 * @returns binary WebSocket `Duplex` stream.
 */
export async function connectWebSocketStream(
  transport: Duplex,
  defaultHost: string,
  port: number,
  config: WsTransportConfig,
  signal?: AbortSignal,
): Promise<Duplex> {
  const wsKey = randomBytes(16).toString('base64')
  const expectedAccept = createHash('sha1').update(`${wsKey}${WS_GUID}`).digest('base64')
  const path = config.path.startsWith('/') ? config.path : `/${config.path}`

  let customHost: string | undefined
  const extraHeaderLines: string[] = []
  if (config.headers !== undefined) {
    for (const [key, value] of Object.entries(config.headers)) {
      if (key.toLowerCase() === 'host') {
        customHost = value
      } else {
        extraHeaderLines.push(`${key}: ${value}\r\n`)
      }
    }
  }
  const hostHeader = customHost ?? (port === 80 || port === 443 ? defaultHost : `${defaultHost}:${String(port)}`)
  const upgradeRequest = Buffer.from(
    `GET ${path} HTTP/1.1\r\n`
    + `Host: ${hostHeader}\r\n`
    + 'Upgrade: websocket\r\n'
    + 'Connection: Upgrade\r\n'
    + `Sec-WebSocket-Key: ${wsKey}\r\n`
    + 'Sec-WebSocket-Version: 13\r\n'
    + extraHeaderLines.join('')
    + '\r\n',
    'utf8',
  )

  const reader = new BufferedStreamReader(transport)
  let remainder: Buffer
  try {
    await writeAll(transport, upgradeRequest)
    const rawHeader = await reader.readUntil(CRLF_DOUBLE, 16_384, signal)
    const headerText = rawHeader.toString('utf8')
    const lines = headerText.split('\r\n')
    const statusLine = lines[0] as string
    if (!/^HTTP\/1\.[01]\s+101\b/i.test(statusLine)) {
      throw new VpnTunnelError('VPN_PROTOCOL_ERROR', `WebSocket upgrade rejected: ${statusLine}`)
    }
    const acceptLine = lines.find(line => line.toLowerCase().startsWith('sec-websocket-accept:'))
    const acceptValue = acceptLine?.slice(acceptLine.indexOf(':') + 1).trim()
    if (acceptValue !== expectedAccept) {
      throw new VpnTunnelError('VPN_PROTOCOL_ERROR', 'WebSocket Sec-WebSocket-Accept mismatch')
    }
    remainder = reader.detach()
  } catch (err) {
    reader.detach()
    transport.destroy()
    throw err
  }

  let frameBuf: Buffer = Buffer.alloc(0)
  let fragmentChunks: Buffer[] = []
  let closeSent = false

  return createCarrierTransformDuplex(
    transport,
    {
      encodeChunk(chunk) {
        const frames: Buffer[] = []
        let offset = 0
        while (offset < chunk.length) {
          const slice = chunk.subarray(offset, Math.min(offset + MAX_WS_CHUNK, chunk.length))
          frames.push(encodeMaskedClientFrame(0x02, slice))
          offset += slice.length
        }
        return frames.length === 1 ? (frames[0] as Buffer) : Buffer.concat(frames)
      },
      buildFinalFrame() {
        if (closeSent) return 'already-closed'
        closeSent = true
        return encodeMaskedClientFrame(0x08, Buffer.alloc(0))
      },
      onData(incoming, push) {
        frameBuf = frameBuf.length === 0 ? incoming : Buffer.concat([frameBuf, incoming])
        while (frameBuf.length >= 2) {
          const b0 = frameBuf[0] as number
          const b1 = frameBuf[1] as number
          const fin = (b0 & 0x80) !== 0
          const opcode = b0 & 0x0f
          const masked = (b1 & 0x80) !== 0
          let payloadLen = b1 & 0x7f
          let offset = 2

          if (payloadLen === 126) {
            if (frameBuf.length < 4) break
            payloadLen = frameBuf.readUInt16BE(2)
            offset = 4
          } else if (payloadLen === 127) {
            if (frameBuf.length < 10) break
            const len64 = frameBuf.readBigUInt64BE(2)
            if (len64 > 16_777_216n) {
              throw new VpnTunnelError('VPN_PROTOCOL_ERROR', 'WebSocket frame exceeds 16 MiB limit')
            }
            payloadLen = Number(len64)
            offset = 10
          }

          const maskLen = masked ? 4 : 0
          if (frameBuf.length < offset + maskLen + payloadLen) break

          let payload = frameBuf.subarray(offset + maskLen, offset + maskLen + payloadLen)
          if (masked) {
            const mask = frameBuf.subarray(offset, offset + 4)
            const unmasked = Buffer.allocUnsafe(payloadLen)
            for (let i = 0; i < payloadLen; i += 1) {
              unmasked[i] = (payload[i] as number) ^ (mask[i & 3] as number)
            }
            payload = unmasked
          }
          frameBuf = frameBuf.subarray(offset + maskLen + payloadLen)

          if (opcode === 0x08) {
            push(null)
            if (!closeSent) {
              closeSent = true
              transport.end(encodeMaskedClientFrame(0x08, Buffer.alloc(0)))
            }
            return
          }
          if (opcode === 0x09) {
            transport.write(encodeMaskedClientFrame(0x0a, payload))
            continue
          }
          if (opcode === 0x0a) {
            continue
          }
          if (opcode === 0x01 || opcode === 0x02 || opcode === 0x00) {
            if (!fin) {
              fragmentChunks.push(Buffer.from(payload))
              continue
            }
            const message = fragmentChunks.length > 0
              ? Buffer.concat([...fragmentChunks, payload])
              : payload
            fragmentChunks = []
            if (message.length > 0) {
              push(message)
            }
          }
        }
      },
    },
    remainder,
  )
}
