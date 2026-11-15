/**
 * VPN subscription parser (Clash YAML and Base64 / plain proxy URIs), HTTP `Date` clock-skew calibrator,
 * Subconverter fallback unwrapper, direct anti-FakeIP HTTP(S) subscription fetcher, and `.env` `SUB_VPN_*` scanner.
 */

import { createHash } from 'node:crypto'
import { load as loadYaml, JSON_SCHEMA } from 'js-yaml'
import type { RealDnsResolver } from './dns.ts'
import { redactNetworkError, VpnTunnelError } from './error.ts'
import { BufferedStreamReader, connectTransportSocket, writeAll } from './protocols/stream-io.ts'
import {
  vpnNodeId,
  type EnvSubscriptionCandidate,
  type EnvSubscriptionSource,
  type ObfsPluginConfig,
  type ParsedSubscription,
  type ProxyNodeConfig,
  type ProxyProtocol,
  type RoutingRule,
  type RuleAction,
  type RuleKind,
  type SubscriptionUserInfo,
  type TlsTransportConfig,
  type VpnSubscriptionId,
  type WsTransportConfig,
} from './types.ts'

const ENV_SUB_KEY_PATTERN = /^(?:SUB_VPN|VPN_SUB)[A-Z0-9_]*$/i
const CRLF_DOUBLE = Buffer.from('\r\n\r\n', 'ascii')
const MAX_CLOCK_SKEW_ABS_SECONDS = 86_400

/**
 * Redact userinfo, path, query, and fragment components from a subscription URL for safe UI display.
 * @param rawUrl - raw HTTP(S) subscription URL.
 * @returns redacted preview (`https://example.com/***`).
 */
export function maskSubscriptionUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl)
    const portSuffix = parsed.port.length > 0 ? `:${parsed.port}` : ''
    return `${parsed.protocol}//${parsed.hostname}${portSuffix}/***`
  } catch {
    return 'invalid-url/***'
  }
}

/**
 * Compute server-minus-local clock offset in seconds from an HTTP `Date` response header.
 * @param dateHeader - raw HTTP `Date` header value, if present.
 * @param nowMs - local epoch milliseconds (defaults to `Date.now()`).
 * @returns integer clock offset in seconds (`0` when absent, unparseable, or exceeding `±86400`s).
 */
export function computeClockOffsetSeconds(dateHeader: string | null | undefined, nowMs = Date.now()): number {
  if (!dateHeader) return 0
  const parsedMs = Date.parse(dateHeader)
  if (!Number.isFinite(parsedMs)) return 0
  const diffSec = Math.round((parsedMs - nowMs) / 1000)
  return Math.abs(diffSec) <= MAX_CLOCK_SKEW_ABS_SECONDS ? diffSec : 0
}

/**
 * Parse a `Subscription-Userinfo` HTTP header (`upload=...; download=...; total=...; expire=...`).
 * @param headerValue - raw `Subscription-Userinfo` header string.
 * @returns parsed byte and expiration counters, or `undefined` when no valid numeric fields exist.
 */
export function parseSubscriptionUserInfo(headerValue: string | null | undefined): SubscriptionUserInfo | undefined {
  if (!headerValue) return undefined
  let uploadBytes: number | undefined
  let downloadBytes: number | undefined
  let totalBytes: number | undefined
  let expireUnixSeconds: number | undefined

  for (const part of headerValue.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const key = part.slice(0, eq).trim().toLowerCase()
    const num = Number(part.slice(eq + 1).trim())
    if (!Number.isFinite(num) || num < 0) continue
    if (key === 'upload') uploadBytes = Math.floor(num)
    else if (key === 'download') downloadBytes = Math.floor(num)
    else if (key === 'total') totalBytes = Math.floor(num)
    else if (key === 'expire') expireUnixSeconds = Math.floor(num)
  }

  if (
    uploadBytes === undefined
    && downloadBytes === undefined
    && totalBytes === undefined
    && expireUnixSeconds === undefined
  ) {
    return undefined
  }
  return {
    ...(uploadBytes !== undefined ? { uploadBytes } : {}),
    ...(downloadBytes !== undefined ? { downloadBytes } : {}),
    ...(totalBytes !== undefined ? { totalBytes } : {}),
    ...(expireUnixSeconds !== undefined ? { expireUnixSeconds } : {}),
  }
}

function unwrapSubconverterRawUrls(subscriptionUrl: string): string[] {
  try {
    const outer = new URL(subscriptionUrl)
    const rawParam = outer.searchParams.get('url')
    if (!rawParam) return []
    const out: string[] = []
    for (const part of rawParam.split('|')) {
      const trimmed = part.trim()
      if (/^https?:\/\//i.test(trimmed) && trimmed !== subscriptionUrl && !out.includes(trimmed)) {
        out.push(trimmed)
      }
    }
    return out
  } catch {
    return []
  }
}

/**
 * Extract the inner upstream subscription URL when `subscriptionUrl` wraps a Subconverter endpoint (`?url=https%3A...`).
 * @param subscriptionUrl - outer subscription URL.
 * @returns first inner HTTP(S) URL when present and distinct from `subscriptionUrl`, otherwise `null`.
 */
export function unwrapSubconverterRawUrl(subscriptionUrl: string): string | null {
  return unwrapSubconverterRawUrls(subscriptionUrl)[0] ?? null
}

/**
 * Parse `SUB_VPN_*` and `VPN_SUB_*` HTTP(S) subscription candidates from `.env` file text (stripping UTF-8 BOM).
 * @param content - UTF-8 `.env` file contents.
 * @param source - trusted host environment layer identifier (`'dsh-env'` or `'user-env'`).
 * @returns discovered subscription candidates in file order.
 */
export function parseDotEnvSubscriptions(
  content: string,
  source: Exclude<EnvSubscriptionSource, 'env'>,
): EnvSubscriptionCandidate[] {
  const clean = content.startsWith('\ufeff') ? content.slice(1) : content
  const results: EnvSubscriptionCandidate[] = []

  for (const rawLine of clean.split(/\r?\n/)) {
    const trimmed = rawLine.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const withoutExport = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed
    const eqIdx = withoutExport.indexOf('=')
    if (eqIdx <= 0) continue
    const key = withoutExport.slice(0, eqIdx).trim()
    if (!ENV_SUB_KEY_PATTERN.test(key)) continue
    let val = withoutExport.slice(eqIdx + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith('\'') && val.endsWith('\''))) {
      val = val.slice(1, -1).trim()
    }
    if (/^https?:\/\//i.test(val)) {
      results.push({
        envKey: key,
        source,
        url: val,
        maskedUrl: maskSubscriptionUrl(val),
      })
    }
  }
  return results
}

/**
 * Merge and deduplicate `SUB_VPN_*` / `VPN_SUB_*` subscription candidates across process env and trusted `.env` files.
 * @param envRecord - process environment key-value map.
 * @param dotEnvLayers - ordered trusted `.env` contents (`dsh-env` then `user-env`).
 * @returns deduplicated candidates preserving precedence (`env` -> `dsh-env` -> `user-env`).
 */
export function discoverEnvSubscriptionCandidates(
  envRecord: Readonly<Record<string, string | undefined>>,
  dotEnvLayers: readonly { readonly source: Exclude<EnvSubscriptionSource, 'env'>; readonly content: string }[],
): EnvSubscriptionCandidate[] {
  const seenKeys = new Set<string>()
  const out: EnvSubscriptionCandidate[] = []

  for (const [key, rawVal] of Object.entries(envRecord)) {
    if (!ENV_SUB_KEY_PATTERN.test(key) || !rawVal) continue
    const val = rawVal.trim()
    if (!/^https?:\/\//i.test(val)) continue
    seenKeys.add(key)
    out.push({
      envKey: key,
      source: 'env',
      url: val,
      maskedUrl: maskSubscriptionUrl(val),
    })
  }

  for (const layer of dotEnvLayers) {
    for (const item of parseDotEnvSubscriptions(layer.content, layer.source)) {
      if (seenKeys.has(item.envKey)) continue
      seenKeys.add(item.envKey)
      out.push(item)
    }
  }
  return out
}

function makeOpaqueNodeId(
  subscriptionId: VpnSubscriptionId,
  index: number,
  name: string,
  protocol: ProxyProtocol,
  port: number,
): ReturnType<typeof vpnNodeId> {
  const digest = createHash('sha256')
    .update(`${subscriptionId}:${String(index)}:${name}:${protocol}:${String(port)}`)
    .digest('hex')
    .slice(0, 12)
  return vpnNodeId(`${subscriptionId}:${digest}`)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

function decodeLooseBase64Utf8(input: string): string | null {
  const compact = input.replaceAll(/\s+/g, '').replaceAll('-', '+').replaceAll('_', '/')
  if (compact.length === 0 || !/^[A-Za-z0-9+/=]+$/.test(compact)) return null
  const padded = compact + '='.repeat((4 - (compact.length % 4)) % 4)
  try {
    return Buffer.from(padded, 'base64').toString('utf8')
  } catch {
    /* v8 ignore next */
    return null
  }
}

function classifyShadowsocksProtocol(cipher: string): ProxyProtocol {
  return cipher.toLowerCase().startsWith('2022-blake3-') ? 'ss2022' : 'ss'
}

function parseClashProxyEntry(
  raw: Record<string, unknown>,
  subscriptionId: VpnSubscriptionId,
  index: number,
  clockOffsetSeconds: number,
): ProxyNodeConfig | null {
  const type = (asString(raw.type) ?? '').toLowerCase()
  const name = (asString(raw.name) ?? `node-${String(index + 1)}`).trim()
  const server = (asString(raw.server) ?? '').trim()
  const port = Number(raw.port)
  if (server.length === 0 || !Number.isInteger(port) || port < 1 || port > 65535) return null

  const udp = raw.udp === true
  const network = (asString(raw.network) ?? 'tcp').toLowerCase()

  let ws: WsTransportConfig | undefined
  if (network === 'ws') {
    const wsOpts = isPlainRecord(raw['ws-opts']) ? raw['ws-opts'] : undefined
    const wsPath = asString(wsOpts?.path) ?? '/'
    const rawHeaders = isPlainRecord(wsOpts?.headers) ? wsOpts.headers : undefined
    const headers: Record<string, string> = {}
    if (rawHeaders !== undefined) {
      for (const [k, v] of Object.entries(rawHeaders)) {
        const str = asString(v)
        if (str !== undefined) headers[k] = str
      }
    }
    ws = {
      path: wsPath,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    }
  }

  let obfs: ObfsPluginConfig | undefined
  const pluginName = (asString(raw.plugin) ?? '').toLowerCase()
  if (pluginName === 'obfs' || pluginName === 'obfs-local' || pluginName === 'simple-obfs') {
    const opts = isPlainRecord(raw['plugin-opts']) ? raw['plugin-opts'] : undefined
    const modeRaw = (asString(opts?.mode) ?? 'http').toLowerCase()
    if (modeRaw === 'http' || modeRaw === 'tls') {
      const host = asString(opts?.host) ?? 'www.bing.com'
      const uri = asString(opts?.path)
      obfs = {
        mode: modeRaw,
        host,
        ...(uri !== undefined ? { uri } : {}),
      }
    }
  }

  const tlsEnabled = raw.tls === true || type === 'trojan'
  const sni = asString(raw.sni) ?? asString(raw.servername)
  const skipCertVerify = raw['skip-cert-verify'] === true
  const rawAlpn: readonly unknown[] | undefined = Array.isArray(raw.alpn) ? raw.alpn : undefined
  const alpn = rawAlpn?.map(asString).filter((item): item is string => item !== undefined)
  const tls: TlsTransportConfig | undefined = tlsEnabled
    ? {
      enabled: true,
      ...(sni !== undefined ? { servername: sni } : {}),
      ...(skipCertVerify ? { skipCertVerify: true } : {}),
      ...(alpn && alpn.length > 0 ? { alpn } : {}),
    }
    : undefined

  const commonTransport = {
    udp,
    clockOffsetSeconds,
    ...(tls !== undefined ? { tls } : {}),
    ...(ws !== undefined ? { ws } : {}),
  }

  if (type === 'ss') {
    const cipher = asString(raw.cipher) ?? ''
    const password = asString(raw.password) ?? ''
    if (cipher.length === 0 || password.length === 0) return null
    const protocol = classifyShadowsocksProtocol(cipher)
    return {
      id: makeOpaqueNodeId(subscriptionId, index, name, protocol, port),
      subscriptionId,
      name,
      protocol,
      server,
      port,
      cipher,
      password,
      ...commonTransport,
      ...(obfs !== undefined ? { obfs } : {}),
    }
  }

  if (type === 'trojan') {
    const password = asString(raw.password) ?? ''
    if (password.length === 0) return null
    return {
      id: makeOpaqueNodeId(subscriptionId, index, name, 'trojan', port),
      subscriptionId,
      name,
      protocol: 'trojan',
      server,
      port,
      password,
      ...commonTransport,
    }
  }

  if (type === 'vless') {
    const uuid = asString(raw.uuid) ?? ''
    if (uuid.length === 0) return null
    return {
      id: makeOpaqueNodeId(subscriptionId, index, name, 'vless', port),
      subscriptionId,
      name,
      protocol: 'vless',
      server,
      port,
      uuid,
      ...commonTransport,
    }
  }

  if (type === 'vmess') {
    const uuid = asString(raw.uuid) ?? ''
    if (uuid.length === 0) return null
    const cipher = asString(raw.cipher) ?? 'auto'
    const alterId = typeof raw.alterId === 'number' ? raw.alterId : 0
    return {
      id: makeOpaqueNodeId(subscriptionId, index, name, 'vmess', port),
      subscriptionId,
      name,
      protocol: 'vmess',
      server,
      port,
      uuid,
      cipher,
      alterId,
      ...commonTransport,
    }
  }

  if (type === 'socks5' || type === 'http') {
    const protocol: ProxyProtocol = type === 'socks5' ? 'socks5' : 'http'
    const username = asString(raw.username)
    const password = asString(raw.password)
    return {
      id: makeOpaqueNodeId(subscriptionId, index, name, protocol, port),
      subscriptionId,
      name,
      protocol,
      server,
      port,
      ...(username !== undefined ? { username } : {}),
      ...(password !== undefined ? { password } : {}),
      ...commonTransport,
    }
  }

  return null
}

function classifyRuleAction(rawTarget: string): RuleAction {
  const upper = rawTarget.trim().toUpperCase()
  if (upper === 'DIRECT' || upper.includes('直连')) return 'DIRECT'
  if (upper === 'REJECT' || upper === 'REJECT-DROP' || upper.includes('拦截')) return 'REJECT'
  return 'PROXY'
}

/**
 * Parse one Clash rule line (`DOMAIN-SUFFIX,anthropic.com,PROXY`) into a structured {@link RoutingRule}.
 * @param line - raw Clash rule string.
 * @returns parsed rule, or `null` for unsupported rule predicates (such as `GEOIP` or `PROCESS-NAME`).
 */
export function parseClashRuleLine(line: string): RoutingRule | null {
  const trimmed = line.trim()
  if (trimmed.length === 0 || trimmed.startsWith('#')) return null
  const parts = trimmed.split(',').map(part => part.trim())
  const kindUpper = (parts[0] as string).toUpperCase()

  if (kindUpper === 'MATCH' || kindUpper === 'FINAL') {
    const rawTarget = parts[1]
    if (rawTarget === undefined) return null
    return { kind: 'MATCH', pattern: '', action: classifyRuleAction(rawTarget) }
  }

  const supportedKinds: ReadonlySet<string> = new Set([
    'DOMAIN',
    'DOMAIN-SUFFIX',
    'DOMAIN-KEYWORD',
    'IP-CIDR',
    'IP-CIDR6',
  ])
  const rawPattern = parts[1]
  const rawTarget = parts[2]
  if (!supportedKinds.has(kindUpper) || rawPattern === undefined || rawTarget === undefined) return null
  const pattern = rawPattern.toLowerCase()
  if (pattern.length === 0) return null
  return {
    kind: kindUpper as RuleKind,
    pattern,
    action: classifyRuleAction(rawTarget),
  }
}

function parsePluginQueryParam(pluginParam: string | null): ObfsPluginConfig | undefined {
  if (!pluginParam) return undefined
  const segments = pluginParam.split(';')
  const head = (segments[0] as string).toLowerCase()
  if (!head.includes('obfs')) return undefined
  let mode: 'http' | 'tls' = 'http'
  let host = 'www.bing.com'
  let uri: string | undefined
  for (const seg of segments.slice(1)) {
    const eq = seg.indexOf('=')
    if (eq <= 0) continue
    const k = seg.slice(0, eq).trim().toLowerCase()
    const v = seg.slice(eq + 1).trim()
    if ((k === 'obfs' || k === 'mode') && (v === 'http' || v === 'tls')) mode = v
    else if (k === 'obfs-host' || k === 'host') host = v
    else if (k === 'obfs-uri' || k === 'path') uri = v
  }
  return { mode, host, ...(uri !== undefined ? { uri } : {}) }
}

function parseProxyUriLine(
  uri: string,
  subscriptionId: VpnSubscriptionId,
  index: number,
  clockOffsetSeconds: number,
): ProxyNodeConfig | null {
  if (uri.startsWith('vmess://')) {
    const decoded = decodeLooseBase64Utf8(uri.slice('vmess://'.length))
    if (!decoded) return null
    let obj: unknown
    try {
      obj = JSON.parse(decoded)
    } catch {
      return null
    }
    if (!isPlainRecord(obj)) return null
    const server = (asString(obj.add) ?? '').trim()
    const port = Number(obj.port)
    const uuid = (asString(obj.id) ?? '').trim()
    if (!server || !uuid || !Number.isInteger(port) || port < 1 || port > 65535) return null
    const name = (asString(obj.ps) ?? `vmess-${String(index + 1)}`).trim()
    const netType = (asString(obj.net) ?? 'tcp').toLowerCase()
    const tlsMode = (asString(obj.tls) ?? '').toLowerCase()
    const sni = asString(obj.sni) ?? asString(obj.host)
    const wsHost = asString(obj.host)
    return {
      id: makeOpaqueNodeId(subscriptionId, index, name, 'vmess', port),
      subscriptionId,
      name,
      protocol: 'vmess',
      server,
      port,
      uuid,
      cipher: asString(obj.scy) ?? 'auto',
      alterId: Number(obj.aid ?? 0) || 0,
      clockOffsetSeconds,
      ...(tlsMode === 'tls' ? { tls: { enabled: true, ...(sni ? { servername: sni } : {}) } } : {}),
      ...(netType === 'ws'
        ? {
          ws: {
            path: asString(obj.path) ?? '/',
            ...(wsHost ? { headers: { Host: wsHost } } : {}),
          },
        }
        : {}),
    }
  }

  if (uri.startsWith('ss://')) {
    const hashIdx = uri.indexOf('#')
    const rawFragment = hashIdx >= 0 ? uri.slice(hashIdx + 1) : ''
    const name = rawFragment.length > 0 ? decodeURIComponent(rawFragment) : `ss-${String(index + 1)}`
    const withoutFrag = hashIdx >= 0 ? uri.slice(5, hashIdx) : uri.slice(5)

    let normalizedBody = withoutFrag
    if (!withoutFrag.includes('@')) {
      const decodedWhole = decodeLooseBase64Utf8(withoutFrag)
      if (!decodedWhole || !decodedWhole.includes('@')) return null
      normalizedBody = decodedWhole
    }

    const atIdx = normalizedBody.lastIndexOf('@')
    const rawUserInfo = normalizedBody.slice(0, atIdx)
    const hostAndRest = normalizedBody.slice(atIdx + 1)
    let userInfo = decodeURIComponent(rawUserInfo)
    if (!userInfo.includes(':')) {
      const decodedUser = decodeLooseBase64Utf8(rawUserInfo)
      if (!decodedUser || !decodedUser.includes(':')) return null
      userInfo = decodedUser
    }

    const colonIdx = userInfo.indexOf(':')
    const cipher = userInfo.slice(0, colonIdx).trim()
    const password = userInfo.slice(colonIdx + 1)

    let parsedHostUrl: URL
    try {
      parsedHostUrl = new URL(`http://${hostAndRest}`)
    } catch {
      return null
    }
    const server = parsedHostUrl.hostname
    const port = Number(parsedHostUrl.port)
    if (!server || !cipher || !password || !Number.isInteger(port) || port < 1 || port > 65535) return null
    const protocol = classifyShadowsocksProtocol(cipher)
    const obfs = parsePluginQueryParam(parsedHostUrl.searchParams.get('plugin'))
    return {
      id: makeOpaqueNodeId(subscriptionId, index, name, protocol, port),
      subscriptionId,
      name,
      protocol,
      server,
      port,
      cipher,
      password,
      clockOffsetSeconds,
      ...(obfs !== undefined ? { obfs } : {}),
    }
  }

  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch {
    return null
  }
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase()
  const server = parsed.hostname
  const port = Number(parsed.port || (scheme === 'https' || scheme === 'trojan' ? 443 : 80))
  if (!server || port < 1) return null
  const name = parsed.hash.length > 1 ? decodeURIComponent(parsed.hash.slice(1)) : `${scheme}-${String(index + 1)}`

  if (scheme === 'trojan' || scheme === 'vless') {
    const credential = decodeURIComponent(parsed.username)
    if (!credential) return null
    const protocol: ProxyProtocol = scheme
    const tlsEnabled = scheme === 'trojan' || (parsed.searchParams.get('security') ?? 'none').toLowerCase() === 'tls'
    const sni = parsed.searchParams.get('sni') ?? parsed.searchParams.get('peer') ?? undefined
    const skipCertVerify = parsed.searchParams.get('allowInsecure') === '1'
    const transportType = (parsed.searchParams.get('type') ?? 'tcp').toLowerCase()
    const wsHost = parsed.searchParams.get('host')
    return {
      id: makeOpaqueNodeId(subscriptionId, index, name, protocol, port),
      subscriptionId,
      name,
      protocol,
      server,
      port,
      ...(scheme === 'trojan' ? { password: credential } : { uuid: credential }),
      clockOffsetSeconds,
      ...(tlsEnabled
        ? {
          tls: {
            enabled: true,
            ...(sni !== undefined ? { servername: sni } : {}),
            ...(skipCertVerify ? { skipCertVerify: true } : {}),
          },
        }
        : {}),
      ...(transportType === 'ws'
        ? {
          ws: {
            path: parsed.searchParams.get('path') ?? '/',
            ...(wsHost ? { headers: { Host: wsHost } } : {}),
          },
        }
        : {}),
    }
  }

  if (scheme === 'socks5' || scheme === 'socks' || scheme === 'http' || scheme === 'https') {
    const protocol: ProxyProtocol = scheme.startsWith('socks') ? 'socks5' : 'http'
    const username = parsed.username.length > 0 ? decodeURIComponent(parsed.username) : undefined
    const password = parsed.password.length > 0 ? decodeURIComponent(parsed.password) : undefined
    return {
      id: makeOpaqueNodeId(subscriptionId, index, name, protocol, port),
      subscriptionId,
      name,
      protocol,
      server,
      port,
      ...(username !== undefined ? { username } : {}),
      ...(password !== undefined ? { password } : {}),
      clockOffsetSeconds,
      ...(scheme === 'https' ? { tls: { enabled: true } } : {}),
    }
  }

  return null
}

/** Options controlling {@link parseSubscriptionContent}. */
export interface ParseSubscriptionOptions {
  /** Owning subscription identifier assigned to every parsed node. */
  readonly subscriptionId: VpnSubscriptionId
  /** Optional HTTP `Date` response header for SS-2022 / VMess clock-skew calibration. */
  readonly dateHeader?: string | null
  /** Optional `Subscription-Userinfo` response header. */
  readonly userInfoHeader?: string | null
  /** Optional local reference clock in epoch milliseconds. */
  readonly nowMs?: number
}

/**
 * Parse a Clash YAML document or Base64 / plain URI subscription list into normalized nodes and rules.
 * @param rawText - raw UTF-8 response body.
 * @param options - subscription identifier and optional HTTP response headers.
 * @returns validated nodes, routing rules, clock offset, and optional quota counters.
 */
export function parseSubscriptionContent(
  rawText: string,
  options: ParseSubscriptionOptions,
): ParsedSubscription {
  const text = rawText.startsWith('\ufeff') ? rawText.slice(1).trim() : rawText.trim()
  if (text.length === 0) {
    throw new VpnTunnelError('VPN_SUBSCRIPTION_PARSE_FAILED', 'Subscription body is empty')
  }

  const clockOffsetSeconds = computeClockOffsetSeconds(options.dateHeader, options.nowMs)
  const userInfo = parseSubscriptionUserInfo(options.userInfoHeader)

  if (text.includes('proxies:')) {
    let doc: unknown
    try {
      doc = loadYaml(text, { schema: JSON_SCHEMA })
    } catch (err) {
      throw new VpnTunnelError('VPN_SUBSCRIPTION_PARSE_FAILED', 'Malformed Clash YAML subscription document', {
        cause: err,
      })
    }
    if (!isPlainRecord(doc) || !Array.isArray(doc.proxies)) {
      throw new VpnTunnelError('VPN_SUBSCRIPTION_PARSE_FAILED', 'Clash YAML subscription contains no proxies list')
    }

    const nodes: ProxyNodeConfig[] = []
    const rawProxies: readonly unknown[] = doc.proxies
    for (let i = 0; i < rawProxies.length; i += 1) {
      const entry = rawProxies[i]
      if (!isPlainRecord(entry)) continue
      const parsed = parseClashProxyEntry(entry, options.subscriptionId, i, clockOffsetSeconds)
      if (parsed !== null) nodes.push(parsed)
    }

    const rules: RoutingRule[] = []
    if (Array.isArray(doc.rules)) {
      const rawRules: readonly unknown[] = doc.rules
      for (const ruleEntry of rawRules) {
        if (typeof ruleEntry !== 'string') continue
        const parsedRule = parseClashRuleLine(ruleEntry)
        if (parsedRule !== null) rules.push(parsedRule)
      }
    }

    if (nodes.length === 0) {
      throw new VpnTunnelError('VPN_SUBSCRIPTION_PARSE_FAILED', 'No supported proxy nodes found in Clash YAML')
    }
    return {
      nodes,
      rules,
      clockOffsetSeconds,
      ...(userInfo !== undefined ? { userInfo } : {}),
    }
  }

  const candidateText = text.includes('://') ? text : (decodeLooseBase64Utf8(text) ?? '')
  const lines = candidateText.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0)
  const nodes: ProxyNodeConfig[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const parsed = parseProxyUriLine(lines[i] as string, options.subscriptionId, i, clockOffsetSeconds)
    if (parsed !== null) nodes.push(parsed)
  }

  if (nodes.length === 0) {
    throw new VpnTunnelError('VPN_SUBSCRIPTION_PARSE_FAILED', 'No supported proxy nodes found in subscription body')
  }
  return {
    nodes,
    rules: [],
    clockOffsetSeconds,
    ...(userInfo !== undefined ? { userInfo } : {}),
  }
}

/** Options controlling {@link fetchSubscription}. */
export interface FetchSubscriptionOptions {
  /** Owning subscription identifier. */
  readonly subscriptionId: VpnSubscriptionId
  /** Anti-FakeIP DNS resolver used to dial the subscription server directly. */
  readonly dnsResolver: RealDnsResolver
  /** Per-request timeout in milliseconds. */
  readonly timeoutMs: number
  /** Maximum response body size in bytes. */
  readonly maxBytes: number
  /** Maximum retry attempts per candidate URL on transient TCP/TLS socket resets (defaults to `2`). */
  readonly maxRetries?: number
  /** Backoff delay in milliseconds before retrying a transient socket error (defaults to `120`). */
  readonly retryDelayMs?: number
  /** Optional caller cancellation signal. */
  readonly signal?: AbortSignal
  /** Disable TLS X.509 certificate verification (for local self-signed loopback tests only). */
  readonly skipCertVerify?: boolean
}

interface RawHttpFetchResult {
  readonly statusCode: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: Buffer
}

function decodeChunkedTransferBody(raw: Buffer, maxBytes: number): Buffer {
  const parts: Buffer[] = []
  let total = 0
  let offset = 0
  while (offset < raw.length) {
    const lineEnd = raw.indexOf('\r\n', offset, 'ascii')
    if (lineEnd < 0) break
    const sizeHex = (raw.subarray(offset, lineEnd).toString('ascii').split(';')[0] as string).trim()
    const chunkSize = Number.parseInt(sizeHex, 16)
    if (!Number.isFinite(chunkSize) || chunkSize < 0) {
      throw new VpnTunnelError('VPN_SUBSCRIPTION_FETCH_FAILED', 'Invalid HTTP chunked transfer size')
    }
    offset = lineEnd + 2
    if (chunkSize === 0) break
    if (offset + chunkSize > raw.length) {
      throw new VpnTunnelError('VPN_SUBSCRIPTION_FETCH_FAILED', 'Truncated HTTP chunked subscription body')
    }
    total += chunkSize
    if (total > maxBytes) {
      throw new VpnTunnelError('VPN_SUBSCRIPTION_FETCH_FAILED', 'Subscription body exceeded maximum byte limit')
    }
    parts.push(raw.subarray(offset, offset + chunkSize))
    offset += chunkSize + 2
  }
  return Buffer.concat(parts)
}

async function fetchDirectHttpOnce(
  targetUrl: string,
  options: FetchSubscriptionOptions,
): Promise<RawHttpFetchResult> {
  let currentUrl = new URL(targetUrl)
  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    const isHttps = currentUrl.protocol === 'https:'
    if (!isHttps && currentUrl.protocol !== 'http:') {
      throw new VpnTunnelError('VPN_SUBSCRIPTION_FETCH_FAILED', 'Subscription URL must use http: or https:')
    }
    const port = Number(currentUrl.port || (isHttps ? 443 : 80))
    const deadlineSignal = AbortSignal.timeout(options.timeoutMs)
    const combinedSignal = options.signal
      ? AbortSignal.any([options.signal, deadlineSignal])
      : deadlineSignal

    const socket = await connectTransportSocket({
      host: currentUrl.hostname,
      port,
      dnsResolver: options.dnsResolver,
      timeoutMs: options.timeoutMs,
      ...(isHttps
        ? {
          tls: {
            enabled: true,
            servername: currentUrl.hostname,
            ...(options.skipCertVerify ? { skipCertVerify: true } : {}),
          },
        }
        : {}),
      signal: combinedSignal,
    })

    const reader = new BufferedStreamReader(socket)
    try {
      const pathAndQuery = `${currentUrl.pathname}${currentUrl.search}`
      const reqBytes = Buffer.from(
        `GET ${pathAndQuery} HTTP/1.1\r\n`
        + `Host: ${currentUrl.host}\r\n`
        + 'User-Agent: ClashMetaForAndroid/2.10.1\r\n'
        + 'Accept: */*\r\n'
        + 'Accept-Encoding: identity\r\n'
        + 'Connection: close\r\n\r\n',
        'utf8',
      )
      await writeAll(socket, reqBytes)

      const rawHeader = await reader.readUntil(CRLF_DOUBLE, 32_768, combinedSignal)
      const headerLines = rawHeader.toString('utf8').split('\r\n')
      const statusMatch = /^HTTP\/1\.[01]\s+(\d{3})\b/i.exec(headerLines[0] as string)
      const statusCode = statusMatch ? Number(statusMatch[1]) : 0
      if (statusCode === 0) {
        throw new VpnTunnelError('VPN_SUBSCRIPTION_FETCH_FAILED', 'Malformed HTTP status line from subscription server')
      }

      const headers: Record<string, string> = {}
      for (const line of headerLines.slice(1)) {
        const colon = line.indexOf(':')
        if (colon > 0) {
          headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
        }
      }

      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        reader.detach()
        socket.destroy()
        currentUrl = new URL(headers.location, currentUrl)
        continue
      }

      const chunks: Buffer[] = []
      let total = 0
      while (true) {
        const chunk = await reader.readSome(65_536, combinedSignal)
        if (chunk.length === 0) break
        total += chunk.length
        if (total > options.maxBytes + 65_536) {
          throw new VpnTunnelError('VPN_SUBSCRIPTION_FETCH_FAILED', 'Subscription body exceeded maximum byte limit')
        }
        chunks.push(chunk)
      }
      reader.detach()
      socket.destroy()

      const rawBody = Buffer.concat(chunks)
      const isChunked = (headers['transfer-encoding'] ?? '').toLowerCase().includes('chunked')
      const body = isChunked ? decodeChunkedTransferBody(rawBody, options.maxBytes) : rawBody
      if (body.length > options.maxBytes) {
        throw new VpnTunnelError('VPN_SUBSCRIPTION_FETCH_FAILED', 'Subscription body exceeded maximum byte limit')
      }

      return { statusCode, headers, body }
    } catch (err) {
      reader.detach()
      socket.destroy()
      throw err
    }
  }

  throw new VpnTunnelError('VPN_SUBSCRIPTION_FETCH_FAILED', 'Subscription URL exceeded maximum HTTP redirect hops')
}

function isRetryableFetchError(err: unknown): boolean {
  if (err instanceof VpnTunnelError) {
    return err.code === 'VPN_CONNECT_FAILED' || err.code === 'VPN_PROTOCOL_ERROR'
  }
  return !(err instanceof TypeError)
}

function waitBeforeRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs)
    timer.unref()
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

/**
 * Fetch and parse a remote VPN subscription directly (bypassing process-global proxy dispatchers and FakeIP DNS),
 * retrying transient TCP/TLS socket resets and falling back to unwrapped `url=` candidates when a Subconverter frontend fails.
 * @param url - HTTP(S) subscription URL.
 * @param options - subscription ID, DNS resolver, timeout, byte ceiling, retry policy, and optional cancellation signal.
 * @returns parsed subscription nodes, routing rules, clock offset, and optional quota counters.
 */
export async function fetchSubscription(url: string, options: FetchSubscriptionOptions): Promise<ParsedSubscription> {
  const candidates = [url, ...unwrapSubconverterRawUrls(url)]
  const maxRetries = options.maxRetries ?? 2
  const retryDelayMs = options.retryDelayMs ?? 120

  let lastError: unknown
  for (const candidateUrl of candidates) {
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const resp = await fetchDirectHttpOnce(candidateUrl, options)
        if (resp.statusCode < 200 || resp.statusCode >= 300) {
          throw new VpnTunnelError(
            'VPN_SUBSCRIPTION_FETCH_FAILED',
            `Subscription server answered HTTP ${String(resp.statusCode)}`,
          )
        }
        return parseSubscriptionContent(resp.body.toString('utf8'), {
          subscriptionId: options.subscriptionId,
          dateHeader: resp.headers.date ?? null,
          userInfoHeader: resp.headers['subscription-userinfo'] ?? null,
        })
      } catch (err) {
        lastError = err
        if (attempt >= maxRetries || options.signal?.aborted || !isRetryableFetchError(err)) {
          break
        }
        await waitBeforeRetry(retryDelayMs, options.signal)
      }
    }
  }

  const sensitiveLiterals = [...candidates]
  for (const candidateUrl of candidates) {
    try {
      sensitiveLiterals.push(new URL(candidateUrl).hostname)
    } catch {
      // Malformed URLs have no hostname component to extract.
    }
  }
  const code = lastError instanceof VpnTunnelError ? lastError.code : 'VPN_SUBSCRIPTION_FETCH_FAILED'
  throw new VpnTunnelError(code, redactNetworkError(lastError, sensitiveLiterals))
}
