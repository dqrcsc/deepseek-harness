/**
 * Pure-TypeScript VLESS v0 TCP stream client over TCP, TLS, or WebSocket carriers.
 */

import type { Duplex } from 'node:stream'
import { VpnTunnelError } from '../error.ts'
import type { ProxyNodeConfig } from '../types.ts'
import { encodePortFirstTargetAddress } from './address.ts'
import { createCarrierTransformDuplex, writeAll } from './stream-io.ts'

/**
 * Parse a canonical or unhyphenated UUID string into 16 raw bytes.
 * @param rawUuid - UUID string (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`).
 * @returns 16-byte UUID buffer.
 */
export function parseUuidBytes(rawUuid: string): Buffer {
  const hex = rawUuid.replaceAll('-', '').trim()
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new VpnTunnelError('VPN_INVALID_CONFIG', 'Invalid proxy node UUID format')
  }
  return Buffer.from(hex, 'hex')
}

/**
 * Send the VLESS v0 request header over `transport` and strip the server's `[version, addonsLen, ...addons]` prefix on first read.
 * @param transport - underlying TCP, TLS, or WebSocket duplex.
 * @param node - VLESS proxy node configuration.
 * @param targetHost - destination hostname or IP literal.
 * @param targetPort - destination TCP port.
 * @returns plaintext `Duplex` tunnel stream.
 */
export async function dialVless(
  transport: Duplex,
  node: ProxyNodeConfig,
  targetHost: string,
  targetPort: number,
): Promise<Duplex> {
  const uuidBytes = parseUuidBytes(node.uuid ?? '')
  const targetAddr = encodePortFirstTargetAddress(targetHost, targetPort)
  const reqHeader = Buffer.concat([
    Buffer.from([0x00]), // VLESS version 0
    uuidBytes,
    Buffer.from([0x00, 0x01]), // addons length = 0, command = 0x01 (TCP)
    targetAddr,
  ])

  await writeAll(transport, reqHeader)

  let respStripped = false
  let pending: Buffer = Buffer.alloc(0)

  return createCarrierTransformDuplex(transport, {
    encodeChunk: chunk => chunk,
    onData(chunk, push) {
      if (respStripped) {
        push(chunk)
        return
      }
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])
      if (pending.length < 2) return
      const addonsLen = pending[1] as number
      if (pending.length < 2 + addonsLen) return
      respStripped = true
      const remainder = pending.subarray(2 + addonsLen)
      pending = Buffer.alloc(0)
      if (remainder.length > 0) {
        push(remainder)
      }
    },
    onEnd() {
      if (!respStripped && pending.length > 0) {
        throw new VpnTunnelError('VPN_PROTOCOL_ERROR', 'Truncated VLESS response header')
      }
    },
  })
}
