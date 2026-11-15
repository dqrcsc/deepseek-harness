/**
 * End-to-end HTTP(S) reachability and latency prober over encrypted pure-TypeScript proxy tunnels.
 */

import { isIP } from 'node:net'
import { performance } from 'node:perf_hooks'
import type { Duplex } from 'node:stream'
import tls from 'node:tls'
import type { RealDnsResolver } from './dns.ts'
import { redactNetworkError, VpnTunnelError } from './error.ts'
import { dialProxyNode } from './protocols/dial.ts'
import { BufferedStreamReader, writeAll } from './protocols/stream-io.ts'
import type { ProxyNodeConfig, VpnProbeResult } from './types.ts'

const CRLF_DOUBLE = Buffer.from('\r\n\r\n', 'ascii')

/** Options governing {@link probeNodeThroughTunnel}. */
export interface ProbeNodeOptions {
  /** Anti-FakeIP DNS resolver for proxy server hostnames. */
  readonly dnsResolver: RealDnsResolver
  /** Overall dial + TLS + HTTP response deadline in milliseconds. */
  readonly timeoutMs: number
  /** Optional caller cancellation signal. */
  readonly signal?: AbortSignal
  /** Disable target X.509 certificate verification (for local self-signed loopback test targets only; defaults to `false`). */
  readonly skipTargetCertVerify?: boolean
}

function upgradeTunnelToTls(
  tunnel: Duplex,
  hostname: string,
  skipCertVerify: boolean,
  signal: AbortSignal,
): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const servername = isIP(hostname) === 0 ? hostname : undefined
    const tlsSocket = tls.connect({
      socket: tunnel,
      ...(servername !== undefined ? { servername } : {}),
      rejectUnauthorized: !skipCertVerify,
    })

    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort)
      tlsSocket.off('error', onError)
    }
    const onAbort = (): void => {
      cleanup()
      tlsSocket.destroy()
      reject(new VpnTunnelError('VPN_CONNECT_FAILED', 'Probe TLS upgrade aborted'))
    }
    const onError = (err: Error): void => {
      cleanup()
      tlsSocket.destroy()
      reject(err)
    }

    signal.addEventListener('abort', onAbort, { once: true })
    tlsSocket.once('error', onError)
    tlsSocket.once('secureConnect', () => {
      cleanup()
      resolve(tlsSocket)
    })
  })
}

/**
 * Probe `targetUrl` through `node` and measure end-to-end tunnel + HTTP status-line round-trip latency.
 * Never throws on network or protocol failure; returns a redacted {@link VpnProbeResult}.
 * @param node - proxy node to benchmark.
 * @param targetUrl - HTTP or HTTPS target URL (for example `https://www.gstatic.com/generate_204`).
 * @param options - DNS resolver, deadline, and optional cancellation signal.
 * @returns redacted probe outcome with RTT in milliseconds.
 */
export async function probeNodeThroughTunnel(
  node: ProxyNodeConfig,
  targetUrl: string,
  options: ProbeNodeOptions,
): Promise<VpnProbeResult> {
  let parsedUrl: URL
  try {
    parsedUrl = new URL(targetUrl)
  } catch (err) {
    return {
      nodeId: node.id,
      ok: false,
      latencyMs: null,
      error: redactNetworkError(err, [node.server, targetUrl]),
    }
  }

  const isHttps = parsedUrl.protocol === 'https:'
  if (!isHttps && parsedUrl.protocol !== 'http:') {
    return {
      nodeId: node.id,
      ok: false,
      latencyMs: null,
      error: 'Probe target URL must use http: or https:',
    }
  }

  const targetHost = parsedUrl.hostname
  const targetPort = Number(parsedUrl.port || (isHttps ? 443 : 80))
  const deadlineSignal = AbortSignal.timeout(options.timeoutMs)
  const combinedSignal = options.signal
    ? AbortSignal.any([options.signal, deadlineSignal])
    : deadlineSignal

  const startedAt = performance.now()
  let tunnel: Duplex | null = null
  let activeStream: Duplex | null = null
  let reader: BufferedStreamReader | null = null

  try {
    tunnel = await dialProxyNode(node, targetHost, targetPort, {
      dnsResolver: options.dnsResolver,
      timeoutMs: options.timeoutMs,
      signal: combinedSignal,
    })

    activeStream = isHttps
      ? await upgradeTunnelToTls(tunnel, targetHost, options.skipTargetCertVerify ?? false, combinedSignal)
      : tunnel

    reader = new BufferedStreamReader(activeStream)
    const pathAndQuery = `${parsedUrl.pathname}${parsedUrl.search}`
    const requestBytes = Buffer.from(
      `GET ${pathAndQuery} HTTP/1.1\r\n`
      + `Host: ${parsedUrl.host}\r\n`
      + 'User-Agent: curl/8.7.1\r\n'
      + 'Accept: */*\r\n'
      + 'Connection: close\r\n\r\n',
      'utf8',
    )
    await writeAll(activeStream, requestBytes)

    const rawHeaders = await reader.readUntil(CRLF_DOUBLE, 16_384, combinedSignal)
    const firstLine = rawHeaders.toString('utf8').split('\r\n')[0] as string
    const match = /^HTTP\/1\.[01]\s+(\d{3})\b/i.exec(firstLine)
    if (match === null) {
      return {
        nodeId: node.id,
        ok: false,
        latencyMs: null,
        error: 'Malformed HTTP status line from probe target',
      }
    }

    const statusCode = Number(match[1])
    const latencyMs = Math.max(1, Math.round(performance.now() - startedAt))
    const ok = statusCode >= 100 && statusCode < 500
    return {
      nodeId: node.id,
      ok,
      latencyMs,
      statusCode,
      ...(ok ? {} : { error: `Probe target answered HTTP ${statusCode}` }),
    }
  } catch (err) {
    return {
      nodeId: node.id,
      ok: false,
      latencyMs: null,
      error: redactNetworkError(err, [node.server]),
    }
  } finally {
    reader?.detach()
    activeStream?.destroy()
    tunnel?.destroy()
  }
}
