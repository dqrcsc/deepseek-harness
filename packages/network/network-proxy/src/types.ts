/**
 * Browser-safe durable, Remote, and diagnostics value types for Host-wide VPN subscriptions and smart routing.
 * @module @deepseek-ai/dsh-network-proxy/types
 */

import type {} from '@deepseek-ai/dsh-typert-protocol'
import type {
  EnvSubscriptionSource,
  NodeHealthSnapshot,
  ProxyProtocol,
  SubscriptionUserInfo,
  VpnGatewayEndpoint,
  VpnNodeId,
  VpnProbeResult,
  VpnSubscriptionId,
} from '@deepseek-ai/dsh-vpn-tunnel/types'

export type {
  EnvSubscriptionSource,
  NodeHealthSnapshot,
  ProxyProtocol,
  SubscriptionUserInfo,
  VpnGatewayEndpoint,
  VpnNodeId,
  VpnProbeResult,
  VpnSubscriptionId,
}

/** Outbound network routing disposition mode. */
export type NetworkProxyMode = 'direct' | 'smart' | 'global'

/** Explicit per-provider or per-capability routing override evaluated before domain rules in `smart` mode. */
export type RouteOverridePolicy = 'auto' | 'direct' | 'proxy'

/** Outbound non-LLM capability categories addressable by explicit routing overrides. */
export type RoutingCapabilityKey = 'web' | 'mcp' | 'plugin' | 'embedding'

/** Machine-readable validation error discriminator for network-proxy operations. */
export type NetworkProxyInputErrorCode =
  | 'invalid_url'
  | 'invalid_name'
  | 'invalid_refresh_interval'
  | 'invalid_latency_ceiling'
  | 'invalid_custom_rule'
  | 'subscription_not_found'
  | 'node_not_found'
  | 'duplicate_subscription'

/** Per-capability outbound routing policy overrides evaluated before domain rules in `smart` mode. */
export interface CapabilityRoutingOverrides {
  /** Web search and HTTP fetch tool traffic (`dsh-web-fetch-http`, `dsh-web-deepseek-api`, `dsh-web-search-deepseek`). */
  readonly web?: RouteOverridePolicy
  /** Remote MCP client traffic (`dsh-mcp-client`). */
  readonly mcp?: RouteOverridePolicy
  /** Plugin marketplace traffic (`dsh-plugin-market`). */
  readonly plugin?: RouteOverridePolicy
  /** Dense embedding provider traffic (`dsh-embedding`). */
  readonly embedding?: RouteOverridePolicy
}

/** Host-wide routing policy persisted in the `network` storage domain. */
export interface NetworkRoutingSettings {
  /** Region-tier preference expression (for example `美国|新加坡, 日本`). */
  readonly preferRegion: string
  /** Latency ceiling in milliseconds above which preferred-region nodes yield to faster fallback tiers. */
  readonly maxPreferredLatencyMs: number
  /** Whether spawned child processes receive loopback `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` when active. */
  readonly proxySubprocesses: boolean
  /** Whether Desktop Electron `<webview>` guest partitions route through the loopback proxy when active. */
  readonly proxyBrowserGuests: boolean
  /** Per-provider LLM routing overrides keyed by provider identifier (`deepseek-official`, `openai`, `anthropic`, etc.). */
  readonly providerOverrides: Record<string, RouteOverridePolicy>
  /** Per-capability outbound routing overrides (`web`, `mcp`, `plugin`, `embedding`). */
  readonly capabilityOverrides: CapabilityRoutingOverrides
  /** User-supplied Clash-compatible routing rule lines (`DOMAIN-SUFFIX,example.com,PROXY`) evaluated first. */
  readonly customRules: readonly string[]
}

/** Redacted metadata summary of one configured VPN subscription safe for UI display. */
export interface SubscriptionSummary {
  /** Nominal subscription identifier. */
  readonly id: VpnSubscriptionId
  /** User-assigned display label. */
  readonly name: string
  /** Redacted URL preview (`https://host/***`); never contains tokens or query parameters. */
  readonly maskedUrl: string
  /** Whether this subscription contributes nodes and routing rules to the active pool. */
  readonly enabled: boolean
  /** Automatic background refresh interval in minutes (`0` disables periodic refresh). */
  readonly autoRefreshMinutes: number
  /** Number of parsed proxy nodes currently cached for this subscription. */
  readonly nodeCount: number
  /** RFC 3339 millisecond UTC timestamp of the last successful subscription fetch, or `null` before the first fetch. */
  readonly lastUpdatedAt: string | null
  /** Optional provider quota and expiration counters parsed from `Subscription-Userinfo`. */
  readonly userInfo?: SubscriptionUserInfo
  /** Redacted error summary from the latest failed fetch attempt, if any. */
  readonly lastError?: string
  /** Environment layer where this subscription was originally discovered when imported via `importEnvSubscriptions`. */
  readonly envSource?: EnvSubscriptionSource
  /** Environment variable name (for example `SUB_VPN_1`) when imported from ambient environment layers. */
  readonly envKey?: string
}

/** Redacted preview of one `SUB_VPN_*` or `VPN_SUB_*` candidate discovered in host environment layers. */
export interface AmbientEnvSubscriptionPreview {
  /** Environment variable name (for example `SUB_VPN_1`). */
  readonly envKey: string
  /** Trusted host environment layer supplying the variable (`env`, `dsh-env`, or `user-env`). */
  readonly source: EnvSubscriptionSource
  /** Redacted URL preview (`https://host/***`). */
  readonly maskedUrl: string
  /** True when a configured subscription already holds the same normalized URL. */
  readonly alreadyImported: boolean
}

/** Complete redacted status snapshot of `ctx.networkProxy`. */
export interface NetworkProxyStatus {
  /** Current outbound routing mode (`direct`, `smart`, or `global`). */
  readonly mode: NetworkProxyMode
  /** Current routing preferences, overrides, and custom rule lines. */
  readonly routing: NetworkRoutingSettings
  /** Configured VPN subscription summaries in creation order. */
  readonly subscriptions: readonly SubscriptionSummary[]
  /** Active loopback gateway endpoint (`127.0.0.1:<port>`), or `null` when stopped (`direct` mode or zero nodes). */
  readonly gateway: VpnGatewayEndpoint | null
  /** Live node health and latency snapshots across all enabled subscriptions. */
  readonly nodes: readonly NodeHealthSnapshot[]
  /** Currently selected (auto-best or pinned) proxy node identifier, or `null` when unavailable. */
  readonly selectedNodeId: VpnNodeId | null
  /** Explicitly pinned proxy node identifier, or `null` when automatic tier/latency selection is active. */
  readonly pinnedNodeId: VpnNodeId | null
  /** Discoverable `SUB_VPN_*` / `VPN_SUB_*` environment candidates for 1-click import. */
  readonly ambientEnvCandidates: readonly AmbientEnvSubscriptionPreview[]
}

/** Request payload for switching outbound proxy mode. */
export interface SetNetworkModeRequest {
  /** Target outbound routing mode (`direct`, `smart`, or `global`). */
  readonly mode: NetworkProxyMode
}

/** Partial update applied to {@link NetworkRoutingSettings}. */
export interface UpdateNetworkRoutingRequest {
  /** Updated region-tier preference expression. */
  readonly preferRegion?: string
  /** Updated preferred-region latency ceiling in milliseconds. */
  readonly maxPreferredLatencyMs?: number
  /** Updated child-subprocess proxy injection toggle. */
  readonly proxySubprocesses?: boolean
  /** Updated Desktop Electron `<webview>` guest proxy toggle. */
  readonly proxyBrowserGuests?: boolean
  /** Replacement per-provider LLM routing overrides map. */
  readonly providerOverrides?: Record<string, RouteOverridePolicy>
  /** Replacement per-capability outbound routing overrides. */
  readonly capabilityOverrides?: CapabilityRoutingOverrides
  /** Replacement Clash-compatible custom rule lines. */
  readonly customRules?: readonly string[]
}

/** Request payload for adding a new VPN subscription URL. */
export interface AddSubscriptionRequest {
  /** Display label for the subscription. */
  readonly name: string
  /** Raw HTTP(S) subscription URL stored exclusively in `ctx.credentials`. */
  readonly url: string
  /** Whether to enable the subscription immediately; defaults to `true`. */
  readonly enabled?: boolean
  /** Automatic background refresh interval in minutes (`0` disables); defaults to `360` (6 hours). */
  readonly autoRefreshMinutes?: number
}

/** Request payload for updating an existing VPN subscription's metadata or URL. */
export interface UpdateSubscriptionRequest {
  /** Target subscription identifier. */
  readonly id: VpnSubscriptionId
  /** Revised display label. */
  readonly name?: string
  /** Revised raw HTTP(S) subscription URL; when provided, updates `ctx.credentials` and re-fetches immediately. */
  readonly url?: string
  /** Revised enabled toggle. */
  readonly enabled?: boolean
  /** Revised automatic refresh interval in minutes (`0` disables). */
  readonly autoRefreshMinutes?: number
}

/** Request payload for deleting one configured subscription and purging its stored credential and encrypted cache. */
export interface RemoveSubscriptionRequest {
  /** Target subscription identifier. */
  readonly id: VpnSubscriptionId
}

/** Outcome of removing one subscription. */
export interface RemoveSubscriptionResult {
  /** Target subscription identifier. */
  readonly id: VpnSubscriptionId
  /** True when an existing subscription was removed; false when already absent. */
  readonly removed: boolean
}

/** Request payload for refreshing one or all enabled subscriptions. */
export interface RefreshSubscriptionsRequest {
  /** Optional single subscription identifier to refresh; refreshes all enabled subscriptions when omitted. */
  readonly id?: VpnSubscriptionId
}

/** Redacted fetch outcome for one refreshed subscription. */
export interface SubscriptionRefreshOutcome {
  /** Subscription identifier. */
  readonly id: VpnSubscriptionId
  /** Subscription display label. */
  readonly name: string
  /** True when the remote subscription fetched and parsed with at least one node. */
  readonly ok: boolean
  /** Number of active nodes after refresh (retains cached nodes on transient fetch failure). */
  readonly nodeCount: number
  /** Redacted error summary when `ok` is `false`. */
  readonly error?: string
}

/** Combined refresh outcome list and resulting {@link NetworkProxyStatus}. */
export interface RefreshSubscriptionsResult {
  /** Per-subscription fetch outcomes in execution order. */
  readonly outcomes: readonly SubscriptionRefreshOutcome[]
  /** Updated status snapshot after applying refreshed nodes and rules. */
  readonly status: NetworkProxyStatus
}

/** Outcome of importing `SUB_VPN_*` / `VPN_SUB_*` URLs from host environment layers. */
export interface ImportEnvSubscriptionsResult {
  /** Number of newly imported subscriptions. */
  readonly importedCount: number
  /** Number of discovered candidates skipped because an identical URL was already configured. */
  readonly skippedCount: number
  /** Initial fetch outcomes for newly imported subscriptions. */
  readonly outcomes: readonly SubscriptionRefreshOutcome[]
  /** Updated status snapshot after import. */
  readonly status: NetworkProxyStatus
}

/** Request payload for pinning a specific proxy node or restoring automatic selection (`null`). */
export interface SelectNetworkNodeRequest {
  /** Target node identifier to pin, or `null` for automatic region-tier and latency selection. */
  readonly nodeId: VpnNodeId | null
}

/** Request payload for benchmarking proxy nodes through the pure-TypeScript tunnel engine. */
export interface ProbeNetworkNodesRequest {
  /** Optional subscription filter; probes nodes across all enabled subscriptions when omitted. */
  readonly subscriptionId?: VpnSubscriptionId
  /** Optional custom HTTP(S) probe target URL. */
  readonly probeUrl?: string
  /** Optional maximum number of candidate nodes to benchmark; defaults to `12`. */
  readonly limit?: number
}

/** Combined node probe results and updated {@link NetworkProxyStatus}. */
export interface ProbeNetworkNodesResult {
  /** Individual node probe results in execution order. */
  readonly results: readonly VpnProbeResult[]
  /** Updated status snapshot reflecting fresh latency and circuit-breaker metrics. */
  readonly status: NetworkProxyStatus
}

/** End-to-end connectivity diagnostic result for one representative domestic or overseas endpoint. */
export interface DiagnosticTargetResult {
  /** Stable target key (`deepseek`, `openai`, `anthropic`, `gemini`, `github`, `google`). */
  readonly id: string
  /** Human-readable target label. */
  readonly label: string
  /** Probed HTTPS URL. */
  readonly url: string
  /** Evaluated routing path (`direct`, `proxy`, or `reject`) under the current mode and overrides. */
  readonly route: 'direct' | 'proxy' | 'reject'
  /** Active proxy node name used when `route === 'proxy'`. */
  readonly nodeName?: string
  /** True when the HTTPS endpoint answered with a non-5xx, non-407 HTTP status before timeout. */
  readonly ok: boolean
  /** HTTP response status code when received. */
  readonly statusCode?: number
  /** End-to-end round-trip latency in milliseconds, or `null` when unreachable. */
  readonly latencyMs: number | null
  /** Redacted failure message when `ok` is `false`. */
  readonly error?: string
}

/** Complete 1-click connectivity diagnostic matrix report. */
export interface NetworkDiagnosticReport {
  /** RFC 3339 millisecond UTC timestamp when diagnostics completed. */
  readonly checkedAt: string
  /** Routing mode active during the diagnostic run. */
  readonly mode: NetworkProxyMode
  /** Selected proxy node label at diagnostic time, or `null` when none was active. */
  readonly selectedNodeName: string | null
  /** Per-endpoint reachability, route attribution, and latency results. */
  readonly targets: readonly DiagnosticTargetResult[]
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** A Remote network-proxy request failed validation before mutating state. */
    'network-proxy/input-invalid': { readonly code: NetworkProxyInputErrorCode }
    /** A Remote network-proxy refresh or probe operation failed. */
    'network-proxy/operation-failed': { readonly reason: string }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Network proxy mode, subscriptions, routing preferences, selected node, or gateway endpoint changed.
     * @mode emit
     */
    'network-proxy/changed'(): void
  }
}
