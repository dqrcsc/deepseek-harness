/**
 * Pure-TypeScript Trojan tunnel handshake (`SHA224(password)` hex + `\r\n` + `0x01` + SOCKS5 address + `\r\n`).
 */

import { createHash } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { VpnTunnelError } from '../error.ts'
import type { ProxyNodeConfig } from '../types.ts'
import { encodeSocks5TargetAddress } from './address.ts'
import { writeAll } from './stream-io.ts'

const CRLF = Buffer.from('\r\n', 'ascii')

/**
 * Send the Trojan authentication and target-address header over `transport` and return the connected `Duplex`.
 * @param transport - underlying TLS or WebSocket duplex.
 * @param node - Trojan proxy node configuration.
 * @param targetHost - destination hostname or IP literal.
 * @param targetPort - destination TCP port.
 * @returns connected `Duplex` tunnel stream.
 */
export async function dialTrojan(
  transport: Duplex,
  node: ProxyNodeConfig,
  targetHost: string,
  targetPort: number,
): Promise<Duplex> {
  if (!node.password || node.password.length === 0) {
    throw new VpnTunnelError('VPN_INVALID_CONFIG', 'Trojan node password must be non-empty')
  }
  const passwordHex = createHash('sha224').update(node.password, 'utf8').digest('hex')
  const targetAddr = encodeSocks5TargetAddress(targetHost, targetPort)
  const header = Buffer.concat([
    Buffer.from(passwordHex, 'ascii'),
    CRLF,
    Buffer.from([0x01]),
    targetAddr,
    CRLF,
  ])
  await writeAll(transport, header)
  return transport
}
