/**
 * Anti-FakeIP DNS resolver that detects `198.18.0.0/15` synthetic TUN addresses and resolves real IPv4 A records
 * over direct UDP DNS datagrams when a local proxy client's FakeIP intercepts OS hostname resolution.
 */

import { randomInt } from 'node:crypto'
import dgram from 'node:dgram'
import dns from 'node:dns/promises'
import { isIP } from 'node:net'
import { VpnTunnelError } from './error.ts'

/** Default public UDP DNS resolvers used when OS lookup returns a FakeIP (`198.18.0.0/15`) or fails. */
export const DEFAULT_CLEAN_DNS_SERVERS = ['223.5.5.5', '119.29.29.29', '1.1.1.1'] as const

/**
 * Report whether `ip` falls inside the RFC 2544 benchmark / Clash & Surge FakeIP range `198.18.0.0/15`.
 * @param ip - IPv4 or IPv6 literal string.
 * @returns `true` when `ip` is an IPv4 address in `198.18.0.0` through `198.19.255.255`.
 */
export function isFakeIpAddress(ip: string): boolean {
  if (isIP(ip) !== 4) return false
  const parts = ip.split('.')
  const first = Number(parts[0])
  const second = Number(parts[1])
  return first === 198 && (second === 18 || second === 19)
}

/**
 * Build a minimal RFC 1035 DNS A-record query datagram (`QTYPE = A`, `QCLASS = IN`, recursion desired).
 * @param hostname - domain name to query.
 * @param txId - 16-bit DNS transaction identifier.
 * @returns wire-format DNS query packet.
 */
export function buildDnsARecordQuery(hostname: string, txId: number): Buffer {
  const normalized = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname
  const labels = normalized.split('.').filter(label => label.length > 0)
  if (labels.length === 0 || labels.some(label => Buffer.byteLength(label, 'utf8') > 63)) {
    throw new VpnTunnelError('VPN_DNS_FAILED', `Invalid DNS query hostname: ${hostname}`)
  }

  const labelBuffers = labels.map(label => Buffer.from(label, 'utf8'))
  const qnameBytes = labelBuffers.reduce((sum, item) => sum + 1 + item.length, 1)
  const packet = Buffer.allocUnsafe(12 + qnameBytes + 4)

  packet.writeUInt16BE(txId & 0xffff, 0)
  packet.writeUInt16BE(0x0100, 2) // standard query, RD=1
  packet.writeUInt16BE(1, 4) // QDCOUNT = 1
  packet.writeUInt16BE(0, 6) // ANCOUNT = 0
  packet.writeUInt16BE(0, 8) // NSCOUNT = 0
  packet.writeUInt16BE(0, 10) // ARCOUNT = 0

  let offset = 12
  for (const label of labelBuffers) {
    packet[offset] = label.length
    offset += 1
    label.copy(packet, offset)
    offset += label.length
  }
  packet[offset] = 0
  offset += 1
  packet.writeUInt16BE(1, offset) // QTYPE = A
  packet.writeUInt16BE(1, offset + 2) // QCLASS = IN
  return packet
}

function skipDnsName(packet: Buffer, startOffset: number): number | null {
  let offset = startOffset
  let jumps = 0
  while (offset < packet.length) {
    const len = packet[offset] as number
    if (len === 0) return offset + 1
    if ((len & 0xc0) === 0xc0) {
      return offset + 2 <= packet.length ? offset + 2 : null
    }
    if ((len & 0xc0) !== 0) return null
    offset += 1 + len
    jumps += 1
    if (jumps > 128 || offset > packet.length) return null
  }
  return null
}

/**
 * Parse the first non-FakeIP IPv4 A record and its TTL from an RFC 1035 DNS response packet.
 * @param packet - raw UDP response datagram.
 * @param expectedTxId - expected 16-bit transaction identifier.
 * @returns resolved IPv4 string and bounded TTL in seconds, or `null` when no clean A record is present.
 */
export function parseDnsARecordResponse(
  packet: Buffer,
  expectedTxId: number,
): { readonly ip: string; readonly ttlSeconds: number } | null {
  if (packet.length < 12) return null
  const txId = packet.readUInt16BE(0)
  const flags = packet.readUInt16BE(2)
  if (txId !== (expectedTxId & 0xffff)) return null
  if ((flags & 0x8000) === 0 || (flags & 0x000f) !== 0) return null

  const qdCount = packet.readUInt16BE(4)
  const anCount = packet.readUInt16BE(6)
  let offset = 12

  for (let q = 0; q < qdCount; q += 1) {
    const afterName = skipDnsName(packet, offset)
    if (afterName === null || afterName + 4 > packet.length) return null
    offset = afterName + 4
  }

  for (let a = 0; a < anCount; a += 1) {
    const afterName = skipDnsName(packet, offset)
    if (afterName === null || afterName + 10 > packet.length) return null
    const rrType = packet.readUInt16BE(afterName)
    const rrClass = packet.readUInt16BE(afterName + 2)
    const ttl = packet.readUInt32BE(afterName + 4)
    const rdLength = packet.readUInt16BE(afterName + 8)
    const rdataOffset = afterName + 10
    if (rdataOffset + rdLength > packet.length) return null
    if (rrType === 1 && rrClass === 1 && rdLength === 4) {
      const ip = `${String(packet[rdataOffset])}.${String(packet[rdataOffset + 1])}.${String(packet[rdataOffset + 2])}.${String(packet[rdataOffset + 3])}`
      if (!isFakeIpAddress(ip)) {
        return { ip, ttlSeconds: Math.max(30, Math.min(ttl, 3600)) }
      }
    }
    offset = rdataOffset + rdLength
  }

  return null
}

/** Options configuring {@link RealDnsResolver}. */
export interface RealDnsResolverOptions {
  /** Clean UDP DNS server IPv4 addresses (optionally `ip:port`, defaulting to port `53`). */
  readonly servers?: readonly string[]
  /** Per-server UDP query timeout in milliseconds. */
  readonly timeoutMs?: number
  /** Optional override for system hostname lookup (used in deterministic unit tests). */
  readonly systemLookup?: (hostname: string) => Promise<string>
}

interface CachedDnsEntry {
  readonly ip: string
  readonly expiresAtMs: number
}

function parseDnsServerEndpoint(spec: string): { readonly host: string; readonly port: number } {
  const colonIdx = spec.lastIndexOf(':')
  if (colonIdx > 0 && isIP(spec) === 0) {
    const host = spec.slice(0, colonIdx)
    const port = Number(spec.slice(colonIdx + 1))
    if (isIP(host) === 4 && Number.isInteger(port) && port >= 1 && port <= 65535) {
      return { host, port }
    }
  }
  return { host: spec, port: 53 }
}

/** Resolves proxy server hostnames while bypassing `198.18.0.0/15` FakeIP responses via direct UDP DNS queries. */
export class RealDnsResolver {
  private readonly servers: readonly { readonly host: string; readonly port: number }[]
  private readonly timeoutMs: number
  private readonly systemLookup: (hostname: string) => Promise<string>
  private readonly cache = new Map<string, CachedDnsEntry>()

  constructor(options: RealDnsResolverOptions = {}) {
    const serverSpecs = options.servers && options.servers.length > 0
      ? options.servers
      : DEFAULT_CLEAN_DNS_SERVERS
    this.servers = serverSpecs.map(parseDnsServerEndpoint)
    this.timeoutMs = options.timeoutMs ?? 2000
    this.systemLookup = options.systemLookup ?? (async (hostname: string) => {
      const result = await dns.lookup(hostname, { family: 4 })
      return result.address
    })
  }

  /** Clear cached hostname-to-IP mappings. */
  clearCache(): void {
    this.cache.clear()
  }

  /**
   * Resolve `host` to a real IP address, bypassing `198.18.0.0/15` FakeIP intercepts when needed.
   * @param host - IPv4/IPv6 literal or domain name.
   * @returns resolved IPv4 or IPv6 literal string.
   */
  async resolveHost(host: string): Promise<string> {
    const cleanHost = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
    if (isIP(cleanHost) !== 0) {
      return cleanHost
    }

    const key = cleanHost.toLowerCase()
    const now = Date.now()
    const cached = this.cache.get(key)
    if (cached !== undefined && cached.expiresAtMs > now) {
      return cached.ip
    }

    try {
      const sysIp = await this.systemLookup(key)
      if (!isFakeIpAddress(sysIp)) {
        this.cache.set(key, { ip: sysIp, expiresAtMs: now + 300_000 })
        return sysIp
      }
    } catch {
      // Fall through to clean UDP DNS servers when system lookup fails.
    }

    for (const server of this.servers) {
      const resolved = await this.queryUdpServer(cleanHost, server.host, server.port)
      if (resolved !== null) {
        this.cache.set(key, { ip: resolved.ip, expiresAtMs: Date.now() + resolved.ttlSeconds * 1000 })
        return resolved.ip
      }
    }

    throw new VpnTunnelError('VPN_DNS_FAILED', 'Unable to resolve proxy server hostname via system or clean UDP DNS')
  }

  private queryUdpServer(
    hostname: string,
    serverHost: string,
    serverPort: number,
  ): Promise<{ readonly ip: string; readonly ttlSeconds: number } | null> {
    const txId = randomInt(1, 0x10000)
    const packet = buildDnsARecordQuery(hostname, txId)

    return new Promise((resolve) => {
      const socket = dgram.createSocket('udp4')

      const finish = (value: { readonly ip: string; readonly ttlSeconds: number } | null): void => {
        clearTimeout(timer)
        socket.removeAllListeners()
        socket.close()
        resolve(value)
      }

      const timer = setTimeout(() => { finish(null) }, this.timeoutMs)
      timer.unref()

      socket.on('error', () => { finish(null) })
      socket.on('message', (msg) => {
        const parsed = parseDnsARecordResponse(msg, txId)
        if (parsed !== null) finish(parsed)
      })
      socket.send(packet, serverPort, serverHost)
    })
  }
}
