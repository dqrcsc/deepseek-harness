/**
 * Pure-TypeScript loopback proxy gateway (`127.0.0.1`) speaking HTTP `CONNECT`, plain HTTP proxy, and RFC 1928 SOCKS5
 * on a single port, routing traffic either directly, through ranked encrypted proxy tunnels with failover, or `REJECT`.
 */

import net from 'node:net'
import { performance } from 'node:perf_hooks'
import type { Duplex } from 'node:stream'
import type { RealDnsResolver } from './dns.ts'
import { redactNetworkError, VpnTunnelError } from './error.ts'
import { parseSocks5TargetAddress } from './protocols/address.ts'
import { dialProxyNode } from './protocols/dial.ts'
import { BufferedStreamReader, connectTransportSocket, writeAll } from './protocols/stream-io.ts'
import type { ProxyNodeConfig, VpnGatewayEndpoint, VpnNodeId } from './types.ts'

const CRLF_DOUBLE = Buffer.from('\r\n\r\n', 'ascii')
const SOCKS5_NO_AUTH_REPLY = Buffer.from([0x05, 0x00])
const SOCKS5_NO_ACCEPTABLE_AUTH = Buffer.from([0x05, 0xff])
const SOCKS5_SUCCEEDED = Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
const SOCKS5_DISALLOWED = Buffer.from([0x05, 0x02, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
const SOCKS5_FAILURE = Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
const SOCKS5_CMD_UNSUPPORTED = Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
const SOCKS5_ATYP_UNSUPPORTED = Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0])

const HTTP_200_ESTABLISHED = Buffer.from('HTTP/1.1 200 Connection Established\r\n\r\n', 'ascii')
const HTTP_400_BAD_REQUEST = Buffer.from('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n', 'ascii')
const HTTP_403_FORBIDDEN = Buffer.from('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n', 'ascii')
const HTTP_502_BAD_GATEWAY = Buffer.from('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n', 'ascii')
const FORCE_PROXY_TOKEN = Buffer.from('force-proxy:1', 'utf8').toString('base64')

function hasForceProxyHeader(headerLines: readonly string[]): boolean {
  for (const line of headerLines.slice(1)) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    if (line.slice(0, colon).trim().toLowerCase() !== 'proxy-authorization') continue
    const parts = line.slice(colon + 1).trim().split(/\s+/)
    if (parts[0]?.toLowerCase() === 'basic' && parts[1] === FORCE_PROXY_TOKEN) {
      return true
    }
  }
  return false
}

/** Per-connection routing plan returned to {@link LoopbackProxyGateway} for a target `host:port`. */
export type LoopbackGatewayRoutePlan =
  | { readonly action: 'reject' }
  | { readonly action: 'direct' }
  | { readonly action: 'proxy'; readonly candidates: readonly ProxyNodeConfig[] }

/** Configuration callbacks and transport settings for {@link LoopbackProxyGateway}. */
export interface LoopbackProxyGatewayOptions {
  /** Loopback port on `127.0.0.1` (`0` selects an OS-assigned ephemeral port). */
  readonly bindPort?: number
  /** Upstream TCP/TLS + proxy handshake timeout in milliseconds (defaults to `10_000`). */
  readonly connectTimeoutMs?: number
  /** Anti-FakeIP DNS resolver for direct and proxy dials. */
  readonly dnsResolver: RealDnsResolver
  /** Compute the routing plan and ordered proxy nodes for `host:port` (`forceProxy` bypasses smart `DIRECT` rules). */
  readonly decideTarget: (host: string, port: number, forceProxy?: boolean) => LoopbackGatewayRoutePlan
  /** Invoked when a proxied stream receives its first verified upstream response byte. */
  readonly onNodeDialSuccess?: (nodeId: VpnNodeId, rttMs: number) => void
  /** Invoked when dialing or first-byte verification fails on a candidate proxy node. */
  readonly onNodeDialFailure?: (nodeId: VpnNodeId, reason: string) => void
  /** Invoked when a tunnel stream opens on `nodeId`. */
  readonly onConnectionOpen?: (nodeId: VpnNodeId) => void
  /** Invoked when a tunnel stream closes on `nodeId`. */
  readonly onConnectionClose?: (nodeId: VpnNodeId) => void
}

function parseConnectAuthority(authority: string): { readonly host: string; readonly port: number } | null {
  const trimmed = authority.trim()
  if (trimmed.startsWith('[')) {
    const closeBracket = trimmed.indexOf(']')
    if (closeBracket <= 1) return null
    const host = trimmed.slice(1, closeBracket)
    const rest = trimmed.slice(closeBracket + 1)
    const port = rest.startsWith(':') ? Number(rest.slice(1)) : 443
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null
    return { host, port }
  }
  const colon = trimmed.lastIndexOf(':')
  if (colon < 0) {
    return { host: trimmed, port: 443 }
  }
  const host = trimmed.slice(0, colon)
  const port = Number(trimmed.slice(colon + 1))
  if (host.length === 0 || !Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host, port }
}

function rewritePlainHttpRequestHeader(
  headerLines: readonly string[],
  method: string,
  originPath: string,
  httpVersion: string,
): Buffer {
  const outLines: string[] = [`${method} ${originPath} ${httpVersion}`]
  for (const line of headerLines.slice(1)) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const lowerName = line.slice(0, colon).trim().toLowerCase()
    if (lowerName === 'proxy-connection' || lowerName === 'proxy-authorization' || lowerName === 'connection') {
      continue
    }
    outLines.push(line)
  }
  outLines.push('Connection: close')
  return Buffer.from(`${outLines.join('\r\n')}\r\n\r\n`, 'utf8')
}

interface DialedUpstream {
  readonly upstream: Duplex
  readonly node?: ProxyNodeConfig
  readonly startedAtMs: number
  readonly initialFromUpstream?: Buffer
}

/** Mixed HTTP/CONNECT + SOCKS5 loopback gateway bound strictly on `127.0.0.1`. */
export class LoopbackProxyGateway {
  private server: net.Server | null = null
  private currentEndpoint: VpnGatewayEndpoint | null = null
  private readonly openStreams = new Set<Duplex>()
  private readonly bindPort: number
  private readonly connectTimeoutMs: number

  constructor(private readonly options: LoopbackProxyGatewayOptions) {
    this.bindPort = options.bindPort ?? 0
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000
  }

  /**
   * Return the active loopback endpoint, or `null` when stopped.
   * @returns active loopback endpoint URLs and port, or `null` when stopped.
   */
  endpoint(): VpnGatewayEndpoint | null {
    return this.currentEndpoint
  }

  /**
   * Bind the loopback server on `127.0.0.1` if not already listening.
   * @returns bound loopback HTTP and SOCKS5 proxy URLs.
   */
  async start(): Promise<VpnGatewayEndpoint> {
    if (this.currentEndpoint !== null) {
      return this.currentEndpoint
    }

    const server = net.createServer((socket) => {
      socket.setNoDelay(true)
      this.trackStream(socket)
      void this.handleClientSocket(socket)
    })

    const boundPort = await new Promise<number>((resolve, reject) => {
      const onError = (err: Error): void => {
        reject(new VpnTunnelError('VPN_GATEWAY_CLOSED', redactNetworkError(err), { cause: err }))
      }
      server.once('error', onError)
      server.listen(this.bindPort, '127.0.0.1', () => {
        server.off('error', onError)
        resolve((server.address() as net.AddressInfo).port)
      })
    })

    /* v8 ignore next 3 -- post-listen OS listener errors occur only under kernel descriptor exhaustion */
    server.on('error', () => {
      // Runtime listener errors are isolated from crashing the Host process.
    })

    this.server = server
    this.currentEndpoint = {
      host: '127.0.0.1',
      port: boundPort,
      httpProxyUrl: `http://127.0.0.1:${boundPort}`,
      socksProxyUrl: `socks5://127.0.0.1:${boundPort}`,
    }
    return this.currentEndpoint
  }

  /** Destroy all active client/upstream streams and close the loopback listener. */
  async close(): Promise<void> {
    const srv = this.server
    this.server = null
    this.currentEndpoint = null

    for (const stream of [...this.openStreams]) {
      stream.destroy()
    }
    this.openStreams.clear()

    if (srv !== null) {
      await new Promise<void>((resolve) => {
        srv.close(() => { resolve() })
      })
    }
  }

  private trackStream(stream: Duplex): void {
    this.openStreams.add(stream)
    stream.once('close', () => {
      this.openStreams.delete(stream)
    })
  }

  private async handleClientSocket(client: net.Socket): Promise<void> {
    const reader = new BufferedStreamReader(client)
    const handshakeSignal = AbortSignal.timeout(this.connectTimeoutMs)
    try {
      const first = await reader.readExact(1, handshakeSignal)
      if (first[0] === 0x05) {
        await this.handleSocks5Client(client, reader, handshakeSignal)
      } else {
        await this.handleHttpClient(client, reader, first, handshakeSignal)
      }
    } catch {
      reader.detach()
      client.destroy()
    }
  }

  private async handleSocks5Client(
    client: net.Socket,
    reader: BufferedStreamReader,
    signal: AbortSignal,
  ): Promise<void> {
    const nmethodsBuf = await reader.readExact(1, signal)
    const nmethods = nmethodsBuf[0] as number
    const methods = await reader.readExact(nmethods, signal)
    if (!methods.includes(0x00)) {
      reader.detach()
      await writeAll(client, SOCKS5_NO_ACCEPTABLE_AUTH)
      client.destroy()
      return
    }
    await writeAll(client, SOCKS5_NO_AUTH_REPLY)

    const reqHead = await reader.readExact(4, signal)
    if (reqHead[0] !== 0x05 || reqHead[1] !== 0x01) {
      reader.detach()
      await writeAll(client, SOCKS5_CMD_UNSUPPORTED)
      client.destroy()
      return
    }

    const atyp = reqHead[3] as number
    let addrRaw: Buffer
    if (atyp === 0x01) {
      const tail = await reader.readExact(6, signal)
      addrRaw = Buffer.concat([Buffer.from([0x01]), tail])
    } else if (atyp === 0x03) {
      const lenBuf = await reader.readExact(1, signal)
      const domainAndPort = await reader.readExact((lenBuf[0] as number) + 2, signal)
      addrRaw = Buffer.concat([Buffer.from([0x03]), lenBuf, domainAndPort])
    } else if (atyp === 0x04) {
      const tail = await reader.readExact(18, signal)
      addrRaw = Buffer.concat([Buffer.from([0x04]), tail])
    } else {
      reader.detach()
      await writeAll(client, SOCKS5_ATYP_UNSUPPORTED)
      client.destroy()
      return
    }

    const parsedTarget = parseSocks5TargetAddress(addrRaw, 0)
    const bufferedPayload = reader.detach()
    if (parsedTarget === null || parsedTarget.port < 1) {
      await writeAll(client, SOCKS5_ATYP_UNSUPPORTED)
      client.destroy()
      return
    }

    const plan = this.options.decideTarget(parsedTarget.host, parsedTarget.port)
    if (plan.action === 'reject') {
      await writeAll(client, SOCKS5_DISALLOWED)
      client.destroy()
      return
    }

    let dialed: DialedUpstream
    try {
      dialed = await this.openUpstreamForPlan(plan, parsedTarget.host, parsedTarget.port)
    } catch {
      await writeAll(client, SOCKS5_FAILURE)
      client.destroy()
      return
    }

    this.trackStream(dialed.upstream)
    await writeAll(client, SOCKS5_SUCCEEDED)
    this.bridgeStreams(client, dialed, bufferedPayload)
  }

  private async handleHttpClient(
    client: net.Socket,
    reader: BufferedStreamReader,
    firstByte: Buffer,
    signal: AbortSignal,
  ): Promise<void> {
    const restHeader = await reader.readUntil(CRLF_DOUBLE, 32_768, signal)
    const bufferedPayload = reader.detach()
    const rawHeader = Buffer.concat([firstByte, restHeader]).toString('utf8')
    const lines = rawHeader.split('\r\n')
    const reqLineParts = (lines[0] as string).trim().split(/\s+/)
    const method = (reqLineParts[0] as string).toUpperCase()
    const target = reqLineParts[1] ?? ''
    const httpVersion = reqLineParts[2] ?? 'HTTP/1.1'

    if (method.length === 0 || target.length === 0) {
      await writeAll(client, HTTP_400_BAD_REQUEST)
      client.destroy()
      return
    }

    const forceProxy = hasForceProxyHeader(lines)

    if (method === 'CONNECT') {
      const parsedAuthority = parseConnectAuthority(target)
      if (parsedAuthority === null) {
        await writeAll(client, HTTP_400_BAD_REQUEST)
        client.destroy()
        return
      }
      const plan = this.options.decideTarget(parsedAuthority.host, parsedAuthority.port, forceProxy)
      if (plan.action === 'reject') {
        await writeAll(client, HTTP_403_FORBIDDEN)
        client.destroy()
        return
      }
      let dialed: DialedUpstream
      try {
        dialed = await this.openUpstreamForPlan(plan, parsedAuthority.host, parsedAuthority.port, bufferedPayload, true)
      } catch {
        await writeAll(client, HTTP_502_BAD_GATEWAY)
        client.destroy()
        return
      }
      await writeAll(client, HTTP_200_ESTABLISHED)

      if (
        plan.action === 'proxy'
        && dialed.initialFromUpstream === undefined
        && plan.candidates.length > 1
      ) {
        const payloadReader = new BufferedStreamReader(client)
        let firstClientPayload: Buffer
        try {
          firstClientPayload = await payloadReader.readSome(
            Number.MAX_SAFE_INTEGER,
            AbortSignal.timeout(this.connectTimeoutMs),
          )
          payloadReader.detach()
        } catch {
          payloadReader.detach()
          dialed.upstream.destroy()
          client.destroy()
          return
        }
        if (firstClientPayload.length === 0) {
          dialed.upstream.destroy()
          client.destroy()
          return
        }
        const firstNode = dialed.node as ProxyNodeConfig
        try {
          const firstReply = await this.sendAndReadFirstUpstreamChunk(dialed.upstream, firstClientPayload)
          this.options.onNodeDialSuccess?.(firstNode.id, performance.now() - dialed.startedAtMs)
          dialed = { ...dialed, initialFromUpstream: firstReply }
        } catch (err) {
          dialed.upstream.destroy()
          this.options.onNodeDialFailure?.(firstNode.id, redactNetworkError(err, [firstNode.server]))
          const remaining = plan.candidates.filter(c => c.id !== firstNode.id)
          try {
            dialed = await this.openUpstreamForPlan(
              { action: 'proxy', candidates: remaining },
              parsedAuthority.host,
              parsedAuthority.port,
              firstClientPayload,
              true,
            )
          } catch {
            client.destroy()
            return
          }
        }
      }

      this.trackStream(dialed.upstream)
      this.bridgeStreams(
        client,
        dialed,
        dialed.initialFromUpstream !== undefined ? Buffer.alloc(0) : bufferedPayload,
      )
      return
    }

    let parsedUrl: URL
    try {
      parsedUrl = new URL(target)
    } catch {
      await writeAll(client, HTTP_400_BAD_REQUEST)
      client.destroy()
      return
    }
    if (parsedUrl.protocol !== 'http:') {
      await writeAll(client, HTTP_400_BAD_REQUEST)
      client.destroy()
      return
    }

    const host = parsedUrl.hostname
    const port = Number(parsedUrl.port || 80)
    const originPath = `${parsedUrl.pathname}${parsedUrl.search}`
    const plan = this.options.decideTarget(host, port, forceProxy)
    if (plan.action === 'reject') {
      await writeAll(client, HTTP_403_FORBIDDEN)
      client.destroy()
      return
    }

    const rewrittenHeader = rewritePlainHttpRequestHeader(lines, method, originPath, httpVersion)
    const initialUpstreamPayload = bufferedPayload.length > 0
      ? Buffer.concat([rewrittenHeader, bufferedPayload])
      : rewrittenHeader

    let dialed: DialedUpstream
    try {
      dialed = await this.openUpstreamForPlan(plan, host, port, initialUpstreamPayload, true)
    } catch {
      await writeAll(client, HTTP_502_BAD_GATEWAY)
      client.destroy()
      return
    }
    this.trackStream(dialed.upstream)
    this.bridgeStreams(
      client,
      dialed,
      dialed.initialFromUpstream !== undefined ? Buffer.alloc(0) : initialUpstreamPayload,
    )
  }

  private async sendAndReadFirstUpstreamChunk(
    upstream: Duplex,
    initialPayload: Buffer,
  ): Promise<Buffer> {
    const reader = new BufferedStreamReader(upstream)
    const signal = AbortSignal.timeout(this.connectTimeoutMs)
    try {
      await writeAll(upstream, initialPayload)
      const first = await reader.readSome(Number.MAX_SAFE_INTEGER, signal)
      reader.detach()
      if (first.length === 0) {
        throw new VpnTunnelError('VPN_PROTOCOL_ERROR', 'Upstream closed tunnel before sending response bytes')
      }
      return first
    } catch (err) {
      reader.detach()
      throw err
    }
  }

  private async openUpstreamForPlan(
    plan: Exclude<LoopbackGatewayRoutePlan, { readonly action: 'reject' }>,
    host: string,
    port: number,
    initialPayload?: Buffer,
    deferHandshakeWrite = false,
  ): Promise<DialedUpstream> {
    if (plan.action === 'direct') {
      const startedAtMs = performance.now()
      const upstream = await connectTransportSocket({
        host,
        port,
        dnsResolver: this.options.dnsResolver,
        timeoutMs: this.connectTimeoutMs,
      })
      return { upstream, startedAtMs }
    }

    if (plan.candidates.length === 0) {
      throw new VpnTunnelError('VPN_NO_HEALTHY_NODE', 'No proxy nodes available for tunnel routing')
    }

    const maxAttempts = Math.min(4, plan.candidates.length)
    let lastError: unknown
    for (let i = 0; i < maxAttempts; i += 1) {
      const candidate = plan.candidates[i] as ProxyNodeConfig
      const startedAtMs = performance.now()
      let upstream: Duplex | null = null
      try {
        upstream = await dialProxyNode(candidate, host, port, {
          dnsResolver: this.options.dnsResolver,
          timeoutMs: this.connectTimeoutMs,
          deferHandshakeWrite,
        })
        if (initialPayload !== undefined && initialPayload.length > 0) {
          const firstReply = await this.sendAndReadFirstUpstreamChunk(upstream, initialPayload)
          this.options.onNodeDialSuccess?.(candidate.id, performance.now() - startedAtMs)
          return { upstream, node: candidate, startedAtMs, initialFromUpstream: firstReply }
        }
        return { upstream, node: candidate, startedAtMs }
      } catch (err) {
        upstream?.destroy()
        lastError = err
        this.options.onNodeDialFailure?.(candidate.id, redactNetworkError(err, [candidate.server]))
      }
    }

    throw lastError as Error
  }

  private bridgeStreams(client: net.Socket, dialed: DialedUpstream, initialToUpstream: Buffer): void {
    const { upstream, node, startedAtMs, initialFromUpstream } = dialed
    const alreadyVerified = initialFromUpstream !== undefined
    let closed = false
    let firstUpstreamByteSeen = alreadyVerified
    let clientBytesSent = initialToUpstream.length + (alreadyVerified ? 1 : 0)
    let nodeFailureReported = false

    if (node !== undefined) {
      this.options.onConnectionOpen?.(node.id)
    }

    const reportEarlyNodeFailure = (errOrReason: unknown): void => {
      if (node === undefined || firstUpstreamByteSeen || nodeFailureReported) return
      nodeFailureReported = true
      const reason = typeof errOrReason === 'string'
        ? errOrReason
        : redactNetworkError(errOrReason, [node.server])
      this.options.onNodeDialFailure?.(node.id, reason)
    }

    const cleanup = (): void => {
      if (closed) return
      closed = true
      if (node !== undefined) {
        this.options.onConnectionClose?.(node.id)
      }
      client.destroy()
      upstream.destroy()
    }

    if (initialFromUpstream !== undefined) {
      client.write(initialFromUpstream)
    }
    if (initialToUpstream.length > 0) {
      upstream.write(initialToUpstream)
    }

    client.on('data', (chunk: Buffer) => {
      clientBytesSent += chunk.length
    })
    if (!alreadyVerified) {
      upstream.once('data', () => {
        firstUpstreamByteSeen = true
        if (node !== undefined) {
          this.options.onNodeDialSuccess?.(node.id, performance.now() - startedAtMs)
        }
      })
    }

    client.pipe(upstream)
    upstream.pipe(client)

    client.once('error', cleanup)
    upstream.once('error', (err: Error) => {
      reportEarlyNodeFailure(err)
      cleanup()
    })
    client.once('close', cleanup)
    upstream.once('close', () => {
      if (clientBytesSent > 0) {
        reportEarlyNodeFailure('Upstream closed tunnel before sending response bytes')
      }
      cleanup()
    })
  }
}
