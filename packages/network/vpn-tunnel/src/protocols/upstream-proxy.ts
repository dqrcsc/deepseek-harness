/**
 * Pure-TypeScript upstream `SOCKS5` (RFC 1928 / RFC 1929) and `HTTP CONNECT` proxy handshakes.
 */

import type { Duplex } from 'node:stream'
import { VpnTunnelError } from '../error.ts'
import type { ProxyNodeConfig } from '../types.ts'
import { encodeSocks5TargetAddress } from './address.ts'
import { BufferedStreamReader, wrapWithBufferedPrefix, writeAll } from './stream-io.ts'

const CRLF_DOUBLE = Buffer.from('\r\n\r\n', 'ascii')

/**
 * Negotiate an RFC 1928 SOCKS5 `CONNECT` tunnel (with optional RFC 1929 username/password authentication) over `transport`.
 * @param transport - connected TCP or TLS stream.
 * @param node - upstream SOCKS5 node configuration.
 * @param targetHost - destination hostname or IP literal.
 * @param targetPort - destination TCP port.
 * @param signal - optional handshake cancellation signal.
 * @returns connected `Duplex` tunnel stream.
 */
export async function dialSocks5Upstream(
  transport: Duplex,
  node: ProxyNodeConfig,
  targetHost: string,
  targetPort: number,
  signal?: AbortSignal,
): Promise<Duplex> {
  const hasAuth = Boolean(node.username && node.username.length > 0)
  const greeting = hasAuth ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00])
  const reader = new BufferedStreamReader(transport)

  try {
    await writeAll(transport, greeting)
    const methodChoice = await reader.readExact(2, signal)
    if (methodChoice[0] !== 0x05) {
      throw new VpnTunnelError('VPN_PROTOCOL_ERROR', 'Invalid SOCKS5 version in upstream greeting')
    }

    if (methodChoice[1] === 0x02) {
      const userBytes = Buffer.from(node.username ?? '', 'utf8')
      const passBytes = Buffer.from(node.password ?? '', 'utf8')
      if (userBytes.length > 255 || passBytes.length > 255) {
        throw new VpnTunnelError('VPN_INVALID_CONFIG', 'SOCKS5 credentials exceed 255 bytes')
      }
      const authReq = Buffer.concat([
        Buffer.from([0x01, userBytes.length]),
        userBytes,
        Buffer.from([passBytes.length]),
        passBytes,
      ])
      await writeAll(transport, authReq)
      const authResp = await reader.readExact(2, signal)
      if (authResp[1] !== 0x00) {
        throw new VpnTunnelError('VPN_AUTH_FAILED', 'SOCKS5 username/password authentication rejected')
      }
    } else if (methodChoice[1] !== 0x00) {
      throw new VpnTunnelError('VPN_AUTH_FAILED', 'SOCKS5 server rejected offered authentication methods')
    }

    const connectReq = Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00]),
      encodeSocks5TargetAddress(targetHost, targetPort),
    ])
    await writeAll(transport, connectReq)

    const head = await reader.readExact(4, signal)
    if (head[0] !== 0x05 || head[1] !== 0x00) {
      throw new VpnTunnelError('VPN_CONNECT_FAILED', `SOCKS5 CONNECT failed with reply code ${String(head[1])}`)
    }

    const atyp = head[3] as number
    if (atyp === 0x01) {
      await reader.readExact(6, signal)
    } else if (atyp === 0x04) {
      await reader.readExact(18, signal)
    } else if (atyp === 0x03) {
      const lenBuf = await reader.readExact(1, signal)
      await reader.readExact((lenBuf[0] as number) + 2, signal)
    } else {
      throw new VpnTunnelError('VPN_PROTOCOL_ERROR', `Unknown SOCKS5 bound address type: ${String(atyp)}`)
    }

    const remainder = reader.detach()
    return wrapWithBufferedPrefix(transport, remainder)
  } catch (err) {
    reader.detach()
    transport.destroy()
    throw err
  }
}

/**
 * Negotiate an HTTP `CONNECT` tunnel (with optional `Proxy-Authorization: Basic` credentials) over `transport`.
 * @param transport - connected TCP or TLS stream.
 * @param node - upstream HTTP(S) proxy node configuration.
 * @param targetHost - destination hostname or IP literal.
 * @param targetPort - destination TCP port.
 * @param signal - optional handshake cancellation signal.
 * @returns connected `Duplex` tunnel stream.
 */
export async function dialHttpConnectUpstream(
  transport: Duplex,
  node: ProxyNodeConfig,
  targetHost: string,
  targetPort: number,
  signal?: AbortSignal,
): Promise<Duplex> {
  const bracketHost = targetHost.includes(':') && !targetHost.startsWith('[') ? `[${targetHost}]` : targetHost
  const authority = `${bracketHost}:${String(targetPort)}`
  let authHeader = ''
  if (node.username !== undefined || node.password !== undefined) {
    const token = Buffer.from(`${node.username ?? ''}:${node.password ?? ''}`, 'utf8').toString('base64')
    authHeader = `Proxy-Authorization: Basic ${token}\r\n`
  }

  const req = Buffer.from(
    `CONNECT ${authority} HTTP/1.1\r\n`
    + `Host: ${authority}\r\n`
    + authHeader
    + 'Proxy-Connection: keep-alive\r\n\r\n',
    'utf8',
  )

  const reader = new BufferedStreamReader(transport)
  try {
    await writeAll(transport, req)
    const rawResp = await reader.readUntil(CRLF_DOUBLE, 16_384, signal)
    const statusLine = rawResp.toString('utf8').split('\r\n')[0] as string
    const match = /^HTTP\/1\.[01]\s+(\d{3})\b/i.exec(statusLine)
    const statusCode = match ? Number(match[1]) : 0
    if (statusCode === 407) {
      throw new VpnTunnelError('VPN_AUTH_FAILED', 'Upstream HTTP proxy returned 407 Proxy Authentication Required')
    }
    if (statusCode < 200 || statusCode >= 300) {
      throw new VpnTunnelError('VPN_CONNECT_FAILED', `Upstream HTTP CONNECT failed: ${statusLine}`)
    }
    const remainder = reader.detach()
    return wrapWithBufferedPrefix(transport, remainder)
  } catch (err) {
    reader.detach()
    transport.destroy()
    throw err
  }
}
