/**
 * Validation rules, branded constructors, credential-key helpers, and domestic baseline rules for `dsh-network-proxy`.
 * @module @deepseek-ai/dsh-network-proxy/domain
 */

import { createHash, randomBytes } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import { credentialKey, type CredentialKey } from '@deepseek-ai/dsh-credentials'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { RoutingRule } from '@deepseek-ai/dsh-vpn-tunnel'
import type {
  CapabilityRoutingOverrides,
  EnvSubscriptionSource,
  NetworkProxyInputErrorCode,
  NetworkProxyMode,
  NetworkRoutingSettings,
  RouteOverridePolicy,
  SubscriptionSummary,
  SubscriptionUserInfo,
  VpnNodeId,
  VpnSubscriptionId,
} from './types.ts'

/** Credential scope owning subscription URLs and the local cache encryption key. */
export const NETWORK_CREDENTIALS_SCOPE = 'network-proxy'

/** Credential record identifier holding the 256-bit AES-GCM cache encryption key. */
export const CACHE_KEY_RECORD_ID = 'cache-key'

/** Default preferred region-tier expression matching the user's US/SG equal-priority routing tier. */
export const DEFAULT_PREFER_REGION = '美国|新加坡'

/** Default preferred-region latency ceiling in milliseconds before yielding to faster fallback regions. */
export const DEFAULT_MAX_PREFERRED_LATENCY_MS = 4_000

/** Default automatic subscription refresh interval in minutes (6 hours). */
export const DEFAULT_AUTO_REFRESH_MINUTES = 360

/** Maximum automatic subscription refresh interval in minutes (7 days). */
export const MAX_AUTO_REFRESH_MINUTES = 10_080

/** Maximum display-label length for a subscription. */
export const MAX_SUBSCRIPTION_NAME_LENGTH = 80

/** Built-in high-priority direct rules applied in `smart` mode ahead of subscription `MATCH,PROXY` catch-alls. */
export const SMART_DOMESTIC_BASELINE_RULES: readonly RoutingRule[] = Object.freeze([
  { kind: 'DOMAIN-SUFFIX', pattern: 'deepseek.com', action: 'DIRECT' },
  { kind: 'DOMAIN-SUFFIX', pattern: 'aliyuncs.com', action: 'DIRECT' },
  { kind: 'DOMAIN-SUFFIX', pattern: 'volces.com', action: 'DIRECT' },
  { kind: 'DOMAIN-SUFFIX', pattern: 'minimaxi.com', action: 'DIRECT' },
  { kind: 'DOMAIN-SUFFIX', pattern: 'npmmirror.com', action: 'DIRECT' },
  { kind: 'DOMAIN-SUFFIX', pattern: 'cn', action: 'DIRECT' },
])

/** Persisted global settings shape stored in the `network` storage domain. */
export interface StoredNetworkGlobal {
  /** Active outbound routing mode. */
  readonly mode: NetworkProxyMode
  /** Region-tier preference expression. */
  readonly preferRegion: string
  /** Preferred-region latency ceiling in milliseconds. */
  readonly maxPreferredLatencyMs: number
  /** Whether child processes inherit the loopback proxy environment variables. */
  readonly proxySubprocesses: boolean
  /** Whether Desktop Electron `<webview>` guests use the loopback proxy. */
  readonly proxyBrowserGuests: boolean
  /** Explicit per-provider LLM routing overrides. */
  readonly providerOverrides: Record<string, RouteOverridePolicy>
  /** Explicit per-capability routing overrides. */
  readonly capabilityOverrides: CapabilityRoutingOverrides
  /** Validated Clash-compatible custom rule lines. */
  readonly customRules: readonly string[]
  /** Explicitly pinned node identifier, or `null` for automatic selection. */
  readonly pinnedNodeId: VpnNodeId | null
}

/** Persisted subscription metadata row stored in the `network` storage domain (never contains raw URLs). */
export interface StoredSubscriptionRecord {
  /** Nominal subscription identifier (`sub-<hex>`). */
  readonly id: VpnSubscriptionId
  /** User-facing display label. */
  readonly name: string
  /** Masked URL preview (`https://host/***`). */
  readonly maskedUrl: string
  /** SHA-256 hex digest of the normalized URL used internally for duplicate detection. */
  readonly urlDigest: string
  /** Whether this subscription is active. */
  readonly enabled: boolean
  /** Automatic refresh cadence in minutes (`0` disables). */
  readonly autoRefreshMinutes: number
  /** Cached parsed node count. */
  readonly nodeCount: number
  /** RFC 3339 millisecond UTC timestamp of the last successful fetch, or `null`. */
  readonly lastUpdatedAt: string | null
  /** Optional quota and expiration metadata. */
  readonly userInfo?: SubscriptionUserInfo
  /** Redacted error summary from the latest failed refresh, if any. */
  readonly lastError?: string
  /** Ambient environment source layer when imported via `importEnvSubscriptions`. */
  readonly envSource?: EnvSubscriptionSource
  /** Ambient environment variable key when imported via `importEnvSubscriptions`. */
  readonly envKey?: string
  /** RFC 3339 millisecond UTC creation timestamp. */
  readonly createdAt: string
  /** RFC 3339 millisecond UTC latest update timestamp. */
  readonly updatedAt: string
}

/** Initial `network` domain global state (`direct` mode with zero active sockets). */
export const DEFAULT_NETWORK_GLOBAL: StoredNetworkGlobal = Object.freeze({
  mode: 'direct',
  preferRegion: DEFAULT_PREFER_REGION,
  maxPreferredLatencyMs: DEFAULT_MAX_PREFERRED_LATENCY_MS,
  proxySubprocesses: true,
  proxyBrowserGuests: true,
  providerOverrides: {},
  capabilityOverrides: {},
  customRules: [],
  pinnedNodeId: null,
})

/** Validation failure raised before mutating `network` domain storage or credentials. */
export class NetworkProxyInputError extends HarnessError {
  /** Narrow machine-readable validation failure reason. */
  readonly reason: NetworkProxyInputErrorCode

  /**
   * @param reason - narrow input validation discriminator.
   * @param message - redacted actionable diagnostic message.
   * @param options - optional underlying cause.
   */
  constructor(reason: NetworkProxyInputErrorCode, message: string, options?: ErrorOptions) {
    super(message, `NETWORK_PROXY_${reason.toUpperCase()}`, options)
    this.name = 'NetworkProxyInputError'
    this.reason = reason
  }
}

/**
 * Brand a raw string as a {@link VpnSubscriptionId}.
 * @param value - non-empty subscription identifier.
 * @returns branded {@link VpnSubscriptionId}.
 */
export function asSubscriptionId(value: string): VpnSubscriptionId {
  return brandString<VpnSubscriptionId>(value)
}

/**
 * Brand a raw string as a {@link VpnNodeId}.
 * @param value - non-empty node identifier.
 * @returns branded {@link VpnNodeId}.
 */
export function asNodeId(value: string): VpnNodeId {
  return brandString<VpnNodeId>(value)
}

/**
 * Generate a fresh lowercase-hyphenated subscription identifier compatible with {@link credentialKey}.
 * @returns fresh {@link VpnSubscriptionId} (`sub-<12 hex chars>`).
 */
export function generateSubscriptionId(): VpnSubscriptionId {
  return asSubscriptionId(`sub-${randomBytes(6).toString('hex')}`)
}

/**
 * Construct the `ctx.credentials` record key holding `subscriptionId`'s secret URL.
 * @param subscriptionId - subscription identifier (`sub-<hex>`).
 * @returns scoped {@link CredentialKey}.
 */
export function subscriptionCredentialKey(subscriptionId: VpnSubscriptionId): CredentialKey {
  const sanitized = subscriptionId.toLowerCase().replace(/[^a-z0-9-]/gu, '-')
  const idSegment = /^[a-z]/u.test(sanitized) ? sanitized : `s-${sanitized}`
  return credentialKey(NETWORK_CREDENTIALS_SCOPE, idSegment)
}

/**
 * Construct the `ctx.credentials` record key holding the 256-bit AES-GCM cache encryption key.
 * @returns scoped {@link CredentialKey}.
 */
export function cacheEncryptionCredentialKey(): CredentialKey {
  return credentialKey(NETWORK_CREDENTIALS_SCOPE, CACHE_KEY_RECORD_ID)
}

/**
 * Validate and trim a subscription display name.
 * @param raw - candidate display label.
 * @returns trimmed non-empty display label.
 */
export function normalizeSubscriptionName(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_SUBSCRIPTION_NAME_LENGTH) {
    throw new NetworkProxyInputError(
      'invalid_name',
      `Subscription name must be between 1 and ${String(MAX_SUBSCRIPTION_NAME_LENGTH)} characters.`,
    )
  }
  return trimmed
}

/**
 * Validate and normalize an HTTP(S) subscription URL without echoing secret tokens on failure.
 * @param raw - candidate subscription URL.
 * @returns trimmed normalized HTTP(S) URL string.
 */
export function normalizeSubscriptionUrl(raw: string): string {
  const trimmed = raw.trim()
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new NetworkProxyInputError('invalid_url', 'Subscription URL must be a valid http:// or https:// URL.')
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.hostname.length === 0) {
    throw new NetworkProxyInputError('invalid_url', 'Subscription URL must use the http:// or https:// scheme.')
  }
  return trimmed
}

/**
 * Compute the hex SHA-256 digest of a normalized subscription URL for internal deduplication.
 * @param normalizedUrl - validated subscription URL.
 * @returns 64-character lowercase hex SHA-256 digest.
 */
export function computeUrlDigest(normalizedUrl: string): string {
  return createHash('sha256').update(normalizedUrl, 'utf8').digest('hex')
}

/**
 * Validate an automatic refresh interval in minutes (`0..10080`).
 * @param minutes - candidate refresh interval.
 * @returns validated integer refresh interval.
 */
export function validateRefreshMinutes(minutes: number): number {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_AUTO_REFRESH_MINUTES) {
    throw new NetworkProxyInputError(
      'invalid_refresh_interval',
      `Auto-refresh interval must be an integer between 0 and ${String(MAX_AUTO_REFRESH_MINUTES)} minutes.`,
    )
  }
  return minutes
}

/**
 * Validate a preferred-region latency ceiling in milliseconds (`50..60000`).
 * @param latencyMs - candidate latency ceiling in milliseconds.
 * @returns validated integer latency ceiling.
 */
export function validateLatencyCeiling(latencyMs: number): number {
  if (!Number.isInteger(latencyMs) || latencyMs < 50 || latencyMs > 60_000) {
    throw new NetworkProxyInputError(
      'invalid_latency_ceiling',
      'Preferred-region latency ceiling must be an integer between 50 and 60000 ms.',
    )
  }
  return latencyMs
}

/**
 * Canonicalize per-provider routing overrides, omitting `'auto'` entries so default state stays compact.
 * @param input - raw provider overrides dictionary.
 * @returns normalized dictionary containing only `'direct'` and `'proxy'` overrides.
 */
export function normalizeProviderOverrides(
  input: Readonly<Record<string, RouteOverridePolicy>>,
): Record<string, RouteOverridePolicy> {
  const out: Record<string, RouteOverridePolicy> = {}
  for (const [rawKey, policy] of Object.entries(input)) {
    const key = rawKey.trim()
    if (key.length === 0 || policy === 'auto') continue
    out[key] = policy
  }
  return out
}

/**
 * Canonicalize per-capability routing overrides, omitting `'auto'` entries.
 * @param input - raw capability overrides object.
 * @returns normalized {@link CapabilityRoutingOverrides}.
 */
export function normalizeCapabilityOverrides(input: CapabilityRoutingOverrides): CapabilityRoutingOverrides {
  return {
    ...(input.web === 'direct' || input.web === 'proxy' ? { web: input.web } : {}),
    ...(input.mcp === 'direct' || input.mcp === 'proxy' ? { mcp: input.mcp } : {}),
    ...(input.plugin === 'direct' || input.plugin === 'proxy' ? { plugin: input.plugin } : {}),
    ...(input.embedding === 'direct' || input.embedding === 'proxy' ? { embedding: input.embedding } : {}),
  }
}

/**
 * Validate and parse Clash-compatible custom rule lines, stripping blank lines and `#` comments.
 * @param lines - user-supplied rule lines.
 * @param parseLine - rule-line parser from `ctx.vpnTunnel.parseRuleLine`.
 * @returns canonicalized rule lines and parsed {@link RoutingRule} objects.
 */
export function parseCustomRules(
  lines: readonly string[],
  parseLine: (line: string) => RoutingRule | null,
): { readonly normalizedLines: string[]; readonly rules: RoutingRule[] } {
  const normalizedLines: string[] = []
  const rules: RoutingRule[] = []
  for (const rawLine of lines) {
    const trimmed = rawLine.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const parsed = parseLine(trimmed)
    if (parsed === null) {
      throw new NetworkProxyInputError(
        'invalid_custom_rule',
        `Unsupported custom routing rule: "${trimmed.slice(0, 80)}"`,
      )
    }
    normalizedLines.push(trimmed)
    rules.push(parsed)
  }
  return { normalizedLines, rules }
}

/**
 * Project a stored subscription row into a browser-safe {@link SubscriptionSummary}.
 * @param record - stored metadata record.
 * @returns redacted {@link SubscriptionSummary}.
 */
export function toSubscriptionSummary(record: StoredSubscriptionRecord): SubscriptionSummary {
  return {
    id: record.id,
    name: record.name,
    maskedUrl: record.maskedUrl,
    enabled: record.enabled,
    autoRefreshMinutes: record.autoRefreshMinutes,
    nodeCount: record.nodeCount,
    lastUpdatedAt: record.lastUpdatedAt,
    ...(record.userInfo !== undefined ? { userInfo: record.userInfo } : {}),
    ...(record.lastError !== undefined ? { lastError: record.lastError } : {}),
    ...(record.envSource !== undefined ? { envSource: record.envSource } : {}),
    ...(record.envKey !== undefined ? { envKey: record.envKey } : {}),
  }
}

/**
 * Project global domain fields into {@link NetworkRoutingSettings}.
 * @param globalState - stored global state.
 * @returns cloned {@link NetworkRoutingSettings}.
 */
export function toRoutingSettings(globalState: StoredNetworkGlobal): NetworkRoutingSettings {
  return {
    preferRegion: globalState.preferRegion,
    maxPreferredLatencyMs: globalState.maxPreferredLatencyMs,
    proxySubprocesses: globalState.proxySubprocesses,
    proxyBrowserGuests: globalState.proxyBrowserGuests,
    providerOverrides: { ...globalState.providerOverrides },
    capabilityOverrides: { ...globalState.capabilityOverrides },
    customRules: [...globalState.customRules],
  }
}
