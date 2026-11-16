/**
 * Unified proxy node dialer composing TCP/TLS sockets, `simple-obfs` or WebSocket carriers, and tunnel handshakes.
 */

import type { Duplex } from 'node:stream'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { RealDnsResolver } from '../dns.ts'
import type { ProxyNodeConfig } from '../types.ts'
import { wrapSimpleObfsHttp, wrapSimpleObfsTls } from './obfs.ts'
import { dialShadowsocksAead } from './ss-aead.ts'
import { dialShadowsocks2022 } from './ss2022.ts'
import { connectTransportSocket } from './stream-io.ts'
import { dialTrojan } from './trojan.ts'
import { dialHttpConnectUpstream, dialSocks5Upstream } from './upstream-proxy.ts'
import { dialVless } from './vless.ts'
import { dialVmess } from './vmess.ts'
import { connectWebSocketStream } from './ws-stream.ts'

/** Options governing one outbound proxy tunnel dial attempt. */
export interface DialProxyNodeOptions {
  /** Anti-FakeIP DNS resolver for proxy server hostnames. */
  readonly dnsResolver: RealDnsResolver
  /** Overall TCP/TLS + carrier + protocol handshake timeout in milliseconds. */
  readonly timeoutMs: number
  /** Optional caller cancellation signal. */
  readonly signal?: AbortSignal
  /** Coalesce client-first Shadowsocks (`ss2022`/`ss`) greetings into the first outbound payload write. */
  readonly deferHandshakeWrite?: boolean
}

/**
 * Dial `node` and establish an encrypted tunnel to `targetHost:targetPort`.
 * @param node - proxy node configuration.
 * @param targetHost - destination hostname or IP literal.
 * @param targetPort - destination TCP port (`1..65535`).
 * @param options - DNS resolver, deadline, and optional cancellation signal.
 * @returns connected plaintext `Duplex` tunnel stream to `targetHost:targetPort`.
 */
export async function dialProxyNode(
  node: ProxyNodeConfig,
  targetHost: string,
  targetPort: number,
  options: DialProxyNodeOptions,
): Promise<Duplex> {
  const deadlineSignal = AbortSignal.timeout(options.timeoutMs)
  const combinedSignal = options.signal
    ? AbortSignal.any([options.signal, deadlineSignal])
    : deadlineSignal

  const tlsConfig = node.tls ?? (node.protocol === 'trojan' ? { enabled: true } : undefined)
  let carrier = await connectTransportSocket({
    host: node.server,
    port: node.port,
    dnsResolver: options.dnsResolver,
    timeoutMs: options.timeoutMs,
    ...(tlsConfig !== undefined ? { tls: tlsConfig } : {}),
    signal: combinedSignal,
  })

  try {
    if (node.obfs !== undefined) {
      carrier = node.obfs.mode === 'http'
        ? wrapSimpleObfsHttp(carrier, node.obfs.host, node.port, node.obfs.uri)
        : wrapSimpleObfsTls(carrier, node.obfs.host)
    } else if (node.ws !== undefined) {
      carrier = await connectWebSocketStream(carrier, node.server, node.port, node.ws, combinedSignal)
    }

    switch (node.protocol) {
      case 'ss2022':
        return await dialShadowsocks2022(carrier, node, targetHost, targetPort, {
          deferGreeting: Boolean(options.deferHandshakeWrite),
        })
      case 'ss':
        return await dialShadowsocksAead(carrier, node, targetHost, targetPort, {
          deferHandshakeWrite: Boolean(options.deferHandshakeWrite),
        })
      case 'trojan':
        return await dialTrojan(carrier, node, targetHost, targetPort)
      case 'vless':
        return await dialVless(carrier, node, targetHost, targetPort)
      case 'vmess':
        return await dialVmess(carrier, node, targetHost, targetPort)
      case 'socks5':
        return await dialSocks5Upstream(carrier, node, targetHost, targetPort, combinedSignal)
      case 'http':
        return await dialHttpConnectUpstream(carrier, node, targetHost, targetPort, combinedSignal)
      /* v8 ignore next -- closed ProxyProtocol union exhaustiveness guard */
      default: return assertNever(node.protocol)
    }
  } catch (err) {
    carrier.destroy()
    throw err
  }
}
