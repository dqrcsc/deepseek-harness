/** Vocabulary types and branded identifiers for VPN subscriptions, proxy nodes, routing rules, and tunnel health. */

import { brandString, type Branded } from '@deepseek-ai/dsh-brand'

/** Nominal identifier of one configured VPN subscription source. */
export type VpnSubscriptionId = Branded<'VpnSubscriptionId'>

/**
 * Construct a branded {@link VpnSubscriptionId} from a non-empty string.
 * @param value - raw subscription identifier.
 * @returns branded subscription identifier.
 */
export function vpnSubscriptionId(value: string): VpnSubscriptionId {
  return brandString<VpnSubscriptionId>(value)
}

/** Nominal identifier of one parsed proxy node within a subscription. */
export type VpnNodeId = Branded<'VpnNodeId'>

/**
 * Construct a branded {@link VpnNodeId} from a non-empty string.
 * @param value - raw proxy node identifier.
 * @returns branded proxy node identifier.
 */
export function vpnNodeId(value: string): VpnNodeId {
  return brandString<VpnNodeId>(value)
}

/** Supported outbound tunnel protocols implemented in pure TypeScript. */
export type ProxyProtocol = 'ss2022' | 'ss' | 'trojan' | 'vless' | 'vmess' | 'socks5' | 'http'

/** SIP003 `simple-obfs` transport parameters layered beneath Shadowsocks streams. */
export interface ObfsPluginConfig {
  /** Obfuscation framing mode (`http` request/response header or `tls` ClientHello/ApplicationData records). */
  readonly mode: 'http' | 'tls'
  /** Spoofed HTTP `Host` header or TLS SNI hostname. */
  readonly host: string
  /** Request target path used by `http` obfuscation; defaults to `/`. */
  readonly uri?: string
}

/** RFC 6455 client WebSocket carrier parameters layered beneath proxy protocols. */
export interface WsTransportConfig {
  /** HTTP Upgrade request path (for example `/ws`). */
  readonly path: string
  /** Optional additional HTTP headers sent during the WebSocket Upgrade request. */
  readonly headers?: Readonly<Record<string, string>>
}

/** TLS client socket parameters for protocols running over TLS or HTTPS. */
export interface TlsTransportConfig {
  /** Whether to negotiate TLS before starting the proxy protocol handshake. */
  readonly enabled: boolean
  /** Explicit SNI server name; falls back to the node server hostname when omitted. */
  readonly servername?: string
  /** Whether to disable X.509 certificate chain verification when explicitly declared by a subscription node. */
  readonly skipCertVerify?: boolean
  /** Optional ALPN protocol list offered during TLS negotiation. */
  readonly alpn?: readonly string[]
}

/** Normalized outbound proxy node configuration parsed from Clash YAML or proxy URIs. */
export interface ProxyNodeConfig {
  /** Stable node identifier scoped to its owning subscription. */
  readonly id: VpnNodeId
  /** Owning subscription identifier. */
  readonly subscriptionId: VpnSubscriptionId
  /** Human-readable node label (for example `- US 美国 4 -`). */
  readonly name: string
  /** Wire protocol spoken with the remote proxy server. */
  readonly protocol: ProxyProtocol
  /** Remote proxy server hostname or IP literal (never logged in diagnostics). */
  readonly server: string
  /** Remote proxy server TCP port (`1..65535`). */
  readonly port: number
  /** AEAD cipher name for `ss2022`, `ss`, or `vmess`. */
  readonly cipher?: string
  /** Secret password or colon-delimited Base64 PSK chain (`iPSK:uPSK`) for `ss2022`, `ss`, `trojan`, `socks5`, or `http`. */
  readonly password?: string
  /** User UUID for `vless` or `vmess`. */
  readonly uuid?: string
  /** Legacy VMess alterId parsed for metadata inspection; AEAD mode (`0`) is always used on the wire. */
  readonly alterId?: number
  /** Optional username for `socks5` or `http` upstream proxies. */
  readonly username?: string
  /** Whether the subscription advertised UDP relay support on this node. */
  readonly udp?: boolean
  /** Optional outer TLS transport parameters. */
  readonly tls?: TlsTransportConfig
  /** Optional WebSocket carrier parameters. */
  readonly ws?: WsTransportConfig
  /** Optional `simple-obfs` plugin parameters. */
  readonly obfs?: ObfsPluginConfig
  /** Server-minus-local clock offset in seconds derived from the subscription HTTP `Date` header. */
  readonly clockOffsetSeconds?: number
}

/** Target disposition declared by a Clash-compatible routing rule. */
export type RuleAction = 'PROXY' | 'DIRECT' | 'REJECT'

/** Supported Clash-compatible routing rule matchers. */
export type RuleKind = 'DOMAIN' | 'DOMAIN-SUFFIX' | 'DOMAIN-KEYWORD' | 'IP-CIDR' | 'IP-CIDR6' | 'MATCH'

/** One parsed routing rule evaluated in declaration order. */
export interface RoutingRule {
  /** Rule predicate kind. */
  readonly kind: RuleKind
  /** Normalized lowercase hostname, keyword, CIDR string, or empty string for `MATCH`. */
  readonly pattern: string
  /** Disposition taken when the predicate matches. */
  readonly action: RuleAction
}

/** Quota and expiration counters parsed from a `Subscription-Userinfo` HTTP response header. */
export interface SubscriptionUserInfo {
  /** Uploaded bytes reported by the provider. */
  readonly uploadBytes?: number
  /** Downloaded bytes reported by the provider. */
  readonly downloadBytes?: number
  /** Total quota bytes reported by the provider. */
  readonly totalBytes?: number
  /** Subscription expiration Unix timestamp in seconds. */
  readonly expireUnixSeconds?: number
}

/** Validated nodes, routing rules, and metadata produced by parsing one subscription document. */
export interface ParsedSubscription {
  /** Parsed outbound proxy nodes in provider order. */
  readonly nodes: readonly ProxyNodeConfig[]
  /** Parsed routing rules in declaration order. */
  readonly rules: readonly RoutingRule[]
  /** Server-minus-local clock offset in seconds derived from the HTTP `Date` header (`0` when absent or out of range). */
  readonly clockOffsetSeconds: number
  /** Optional quota metadata parsed from `Subscription-Userinfo`. */
  readonly userInfo?: SubscriptionUserInfo
}

/** Environment source layer where a `SUB_VPN_*` or `VPN_SUB_*` subscription URL was discovered. */
export type EnvSubscriptionSource = 'env' | 'dsh-env' | 'user-env'

/** Redacted preview and raw value of one subscription variable discovered in trusted host environment layers. */
export interface EnvSubscriptionCandidate {
  /** Environment variable name (for example `SUB_VPN_1`). */
  readonly envKey: string
  /** Trusted host environment layer supplying the variable. */
  readonly source: EnvSubscriptionSource
  /** Raw HTTP(S) subscription URL used only inside the Host when importing into `ctx.credentials`. */
  readonly url: string
  /** Redacted URL preview (`https://host/***`) safe to return to UI callers. */
  readonly maskedUrl: string
}

/** One equal-priority region preference tier whose patterns match node names case-insensitively. */
export interface RegionTier {
  /** Expanded lowercase region keywords and ISO/English/Chinese aliases belonging to this tier. */
  readonly patterns: readonly string[]
}

/** Redacted runtime health and telemetry snapshot for one proxy node (omits server hostnames, IPs, and secrets). */
export interface NodeHealthSnapshot {
  /** Node identifier. */
  readonly nodeId: VpnNodeId
  /** Owning subscription identifier. */
  readonly subscriptionId: VpnSubscriptionId
  /** Human-readable node label. */
  readonly name: string
  /** Wire protocol spoken by the node. */
  readonly protocol: ProxyProtocol
  /** Exponentially smoothed round-trip latency in milliseconds, or `null` before the first successful probe/tunnel. */
  readonly latencyMs: number | null
  /** Consecutive dial or probe failures since the last success. */
  readonly consecutiveFailures: number
  /** Epoch timestamp in milliseconds until which the circuit breaker excludes this node, or `null` when closed. */
  readonly circuitOpenUntilMs: number | null
  /** Number of currently open tunnel streams through this node. */
  readonly activeConnections: number
  /** Cumulative successful dials/probes recorded in this session. */
  readonly totalSuccesses: number
  /** Cumulative failed dials/probes recorded in this session. */
  readonly totalFailures: number
  /** Redacted error summary from the most recent failure, if any. */
  readonly lastError?: string
}

/** Address and proxy URLs of the active loopback proxy gateway bound on `127.0.0.1`. */
export interface VpnGatewayEndpoint {
  /** Loopback bind address (`127.0.0.1`). */
  readonly host: string
  /** Bound TCP port (`1..65535`). */
  readonly port: number
  /** Local HTTP/CONNECT proxy URL (`http://127.0.0.1:<port>`) for `undici`, child processes, and `<webview>`. */
  readonly httpProxyUrl: string
  /** Local SOCKS5 proxy URL (`socks5://127.0.0.1:<port>`). */
  readonly socksProxyUrl: string
}

/** Lowercase routing action returned by {@link VpnRouteDecision}. */
export type VpnRouteAction = 'proxy' | 'direct' | 'reject'

/** Routing decision computed for a target hostname/port under the active rule list and node health table. */
export interface VpnRouteDecision {
  /** Selected disposition (`proxy`, `direct`, or `reject`). */
  readonly action: VpnRouteAction
  /** Human-readable rule label that matched (for example `DOMAIN-SUFFIX:anthropic.com`). */
  readonly matchedRule?: string
  /** Candidate proxy node selected when `action === 'proxy'`. */
  readonly nodeId?: VpnNodeId
}

/** Outcome of probing one proxy node or target URL through the pure-TypeScript tunnel engine. */
export interface VpnProbeResult {
  /** Probed proxy node identifier. */
  readonly nodeId: VpnNodeId
  /** Whether the HTTP probe completed with an HTTP status below `500`. */
  readonly ok: boolean
  /** Measured end-to-end handshake + HTTP round-trip time in milliseconds, or `null` on failure. */
  readonly latencyMs: number | null
  /** HTTP status code returned by the probe target when reached. */
  readonly statusCode?: number
  /** Redacted failure message when `ok` is `false`. */
  readonly error?: string
}

/** Complete redacted state snapshot of the {@link VpnTunnelRuntime}. */
export interface VpnTunnelStateSnapshot {
  /** Active loopback gateway endpoint, or `null` when stopped. */
  readonly gateway: VpnGatewayEndpoint | null
  /** Health snapshots for all currently loaded subscription nodes. */
  readonly nodes: readonly NodeHealthSnapshot[]
  /** Currently best auto-selected or pinned node identifier, or `null` when no node is available. */
  readonly selectedNodeId: VpnNodeId | null
  /** Most recent node identifier opened by the loopback tunnel gateway, or `null` when none has routed yet. */
  readonly lastRoutedNodeId: VpnNodeId | null
  /** Explicitly pinned node identifier, or `null` when automatic tier/latency selection is active. */
  readonly pinnedNodeId: VpnNodeId | null
  /** Active region-tier preference expression (for example `美国|新加坡`). */
  readonly preferRegion: string
  /** Latency ceiling in milliseconds above which preferred-region nodes yield to faster fallback tiers. */
  readonly maxPreferredLatencyMs: number
}
