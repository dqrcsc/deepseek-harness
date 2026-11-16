/**
 * Pure-TypeScript VPN subscription parser, encrypted proxy protocol dialer (`ss2022`, `ss`, `trojan`, `vless`, `vmess`,
 * `socks5`, `http` over TCP, TLS, `simple-obfs`, or WebSocket), anti-FakeIP DNS resolver, region-tier health router,
 * and loopback proxy gateway (`ctx.vpnTunnel`).
 * @module @deepseek-ai/dsh-vpn-tunnel
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { isPrivateNetworkHost } from '@deepseek-ai/dsh-http-proxy'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_CLEAN_DNS_SERVERS,
  RealDnsResolver,
  type RealDnsResolverOptions,
} from './dns.ts'
import {
  redactNetworkError,
  VpnTunnelError,
  type VpnTunnelErrorCode,
} from './error.ts'
import {
  LoopbackProxyGateway,
  type LoopbackGatewayRoutePlan,
  type LoopbackProxyGatewayOptions,
} from './gateway.ts'
import { probeNodeThroughTunnel, type ProbeNodeOptions } from './probe.ts'
import type { DialProxyNodeOptions } from './protocols/dial.ts'
import type { DialShadowsocksAeadOptions } from './protocols/ss-aead.ts'
import type { DialShadowsocks2022Options } from './protocols/ss2022.ts'
import {
  NodeHealthTracker,
  type NodeHealthTrackerOptions,
} from './router.ts'
import {
  DEFAULT_SMART_ROUTING_RULES,
  RuleMatcher,
  type RuleMatchResult,
} from './rules.ts'
import {
  discoverEnvSubscriptionCandidates,
  fetchSubscription,
  maskSubscriptionUrl,
  parseClashRuleLine,
  parseSubscriptionContent,
  type FetchSubscriptionOptions,
  type ParseSubscriptionOptions,
} from './subscription.ts'
import {
  vpnNodeId,
  vpnSubscriptionId,
  type EnvSubscriptionCandidate,
  type EnvSubscriptionSource,
  type NodeHealthSnapshot,
  type ObfsPluginConfig,
  type ParsedSubscription,
  type ProxyNodeConfig,
  type ProxyProtocol,
  type RegionTier,
  type RoutingRule,
  type RuleAction,
  type RuleKind,
  type SubscriptionUserInfo,
  type TlsTransportConfig,
  type VpnGatewayEndpoint,
  type VpnNodeId,
  type VpnProbeResult,
  type VpnRouteAction,
  type VpnRouteDecision,
  type VpnSubscriptionId,
  type VpnTunnelStateSnapshot,
  type WsTransportConfig,
} from './types.ts'

export { VpnTunnelError }

export type {
  DialProxyNodeOptions,
  DialShadowsocks2022Options,
  DialShadowsocksAeadOptions,
  EnvSubscriptionCandidate,
  EnvSubscriptionSource,
  FetchSubscriptionOptions,
  LoopbackGatewayRoutePlan,
  LoopbackProxyGatewayOptions,
  NodeHealthSnapshot,
  NodeHealthTrackerOptions,
  ObfsPluginConfig,
  ParsedSubscription,
  ParseSubscriptionOptions,
  ProbeNodeOptions,
  ProxyNodeConfig,
  ProxyProtocol,
  RealDnsResolverOptions,
  RegionTier,
  RoutingRule,
  RuleAction,
  RuleKind,
  RuleMatchResult,
  SubscriptionUserInfo,
  TlsTransportConfig,
  VpnGatewayEndpoint,
  VpnNodeId,
  VpnProbeResult,
  VpnRouteAction,
  VpnRouteDecision,
  VpnSubscriptionId,
  VpnTunnelErrorCode,
  VpnTunnelStateSnapshot,
  WsTransportConfig,
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Pure-TypeScript VPN tunnel dialer, health router, and loopback gateway runtime. */
    vpnTunnel: VpnTunnelRuntime
  }
}

/** Gateway routing mode applied to traffic arriving on the loopback listener. */
export type VpnGatewayMode = 'smart' | 'global'

/** Policy update applied to {@link VpnTunnelRuntime.setRoutingPolicy}. */
export interface VpnRoutingPolicyInput {
  /** Loopback gateway disposition mode (`smart` evaluates rules; `global` proxies all non-private hosts). */
  readonly gatewayMode?: VpnGatewayMode
  /** Region-tier preference expression (for example `美国|新加坡, 日本`). */
  readonly preferRegion?: string
  /** Latency ceiling in milliseconds above which preferred-region nodes yield to faster fallback tiers. */
  readonly maxPreferredLatencyMs?: number
  /** User-supplied high-priority routing rules evaluated ahead of subscription or default smart rules. */
  readonly customRules?: readonly RoutingRule[]
}

/** Options controlling batch node probing via {@link VpnTunnelRuntime.probeNodes}. */
export interface ProbeNodesOptions {
  /** Explicit subset of node IDs to probe; defaults to ranked candidates. */
  readonly nodeIds?: readonly VpnNodeId[]
  /** Optional subscription ID filter applied to ranked candidates when `nodeIds` is omitted. */
  readonly subscriptionId?: VpnSubscriptionId
  /** Maximum number of nodes to probe when `nodeIds` is omitted. */
  readonly limit?: number
  /** Target HTTP(S) URL requested through each probed tunnel. */
  readonly probeUrl?: string
  /** Per-node probe timeout in milliseconds. */
  readonly timeoutMs?: number
  /** Maximum concurrent tunnel probes. */
  readonly concurrency?: number
  /** Optional caller cancellation signal. */
  readonly signal?: AbortSignal
  /** Disable target X.509 certificate verification (loopback test targets only). */
  readonly skipTargetCertVerify?: boolean
}

/** Options controlling single-URL tunnel probing via {@link VpnTunnelRuntime.probeUrl}. */
export interface ProbeUrlOptions {
  /** Explicit node ID to tunnel through; defaults to the highest-ranked candidate node. */
  readonly nodeId?: VpnNodeId
  /** Probe timeout in milliseconds. */
  readonly timeoutMs?: number
  /** Optional caller cancellation signal. */
  readonly signal?: AbortSignal
  /** Disable target X.509 certificate verification (loopback test targets only). */
  readonly skipTargetCertVerify?: boolean
}

/** Validated configuration for {@link VpnTunnelRuntime}. */
export interface Config {
  /** Loopback port bound on `127.0.0.1` (`0` picks an OS-assigned ephemeral port). */
  bindPort?: number
  /** Upstream TCP/TLS + proxy handshake timeout in milliseconds. */
  connectTimeoutMs?: number
  /** Per-node probe deadline in milliseconds. */
  probeTimeoutMs?: number
  /** Maximum concurrent tunnel probes executed by `probeNodes`. */
  probeConcurrency?: number
  /** Default HTTP(S) endpoint used for node latency benchmarking. */
  defaultProbeUrl?: string
  /** Direct HTTP(S) subscription fetch timeout in milliseconds. */
  subscriptionFetchTimeoutMs?: number
  /** Maximum accepted subscription response size in bytes. */
  subscriptionMaxBytes?: number
  /** Clean UDP DNS servers queried when OS hostname lookup returns a `198.18.0.0/15` FakeIP. */
  dnsServers?: string[]
  /** Per-server UDP DNS query timeout in milliseconds. */
  dnsTimeoutMs?: number
  /** Initial region-tier preference expression (`新加坡|日本|美国, 台湾`). */
  preferRegion?: string
  /** Initial preferred-region latency ceiling in milliseconds. */
  maxPreferredLatencyMs?: number
  /** Consecutive dial/probe failures before opening a node's circuit breaker. */
  circuitFailureThreshold?: number
  /** Initial circuit-breaker cooldown in milliseconds. */
  circuitBaseCooldownMs?: number
  /** Maximum exponential-backoff circuit-breaker cooldown in milliseconds. */
  circuitMaxCooldownMs?: number
}

/**
 * Pure-TypeScript VPN tunnel runtime (`ctx.vpnTunnel`). Mounting opens no socket until {@link ensureGateway},
 * {@link fetchSubscription}, {@link probeNodes}, or {@link probeUrl} is called.
 */
export default class VpnTunnelRuntime extends Service {
  static Config: z<Config, Required<Config>> = z.object({
    bindPort: z.natural().max(65_535).default(0),
    connectTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(10_000),
    probeTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(8_000),
    probeConcurrency: z.natural().min(1).max(32).default(12),
    defaultProbeUrl: z.string().default('https://www.gstatic.com/generate_204'),
    subscriptionFetchTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(15_000),
    subscriptionMaxBytes: z.natural().min(1024).default(16 * 1024 * 1024),
    dnsServers: z.array(z.string()).min(1).default([...DEFAULT_CLEAN_DNS_SERVERS]),
    dnsTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(2_000),
    preferRegion: z.string().default('新加坡|日本|美国, 台湾'),
    maxPreferredLatencyMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(4_000),
    circuitFailureThreshold: z.natural().min(1).max(20).default(2),
    circuitBaseCooldownMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(15_000),
    circuitMaxCooldownMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(180_000),
  })

  private readonly resolvedConfig: Required<Config>
  private readonly lifetime = new AbortController()
  private readonly dnsResolver: RealDnsResolver
  private readonly healthTracker: NodeHealthTracker
  private gateway: LoopbackProxyGateway | null = null
  private gatewayMode: VpnGatewayMode = 'smart'
  private customRules: readonly RoutingRule[] = []
  private subscriptionRules: readonly RoutingRule[] = []
  private ruleMatcher: RuleMatcher

  constructor(ctx: Context, config: Config) {
    super(ctx, 'vpnTunnel')
    const resolved = VpnTunnelRuntime.Config(config)
    this.resolvedConfig = resolved
    this.dnsResolver = new RealDnsResolver({
      servers: resolved.dnsServers,
      timeoutMs: resolved.dnsTimeoutMs,
    })
    this.healthTracker = new NodeHealthTracker({
      failureThreshold: resolved.circuitFailureThreshold,
      baseCooldownMs: resolved.circuitBaseCooldownMs,
      maxCooldownMs: resolved.circuitMaxCooldownMs,
      preferRegion: resolved.preferRegion,
      maxPreferredLatencyMs: resolved.maxPreferredLatencyMs,
    })
    this.ruleMatcher = new RuleMatcher(DEFAULT_SMART_ROUTING_RULES)

    ctx.effect(() => async () => {
      this.lifetime.abort(new VpnTunnelError('VPN_GATEWAY_CLOSED', 'VPN tunnel runtime disposed'))
      await this.stopGateway()
    })
  }

  private rebuildRuleMatcher(): void {
    const baseRules = this.subscriptionRules.length > 0
      ? this.subscriptionRules
      : DEFAULT_SMART_ROUTING_RULES
    this.ruleMatcher = new RuleMatcher([...this.customRules, ...baseRules])
  }

  private decideGatewayTarget(host: string, forceProxy = false): LoopbackGatewayRoutePlan {
    if (forceProxy) {
      return {
        action: 'proxy',
        candidates: this.healthTracker.rankCandidates(),
      }
    }
    const decision = this.decideRoute(host, this.gatewayMode)
    if (decision.action === 'reject') {
      return { action: 'reject' }
    }
    if (decision.action === 'direct') {
      return { action: 'direct' }
    }
    return {
      action: 'proxy',
      candidates: this.healthTracker.rankCandidates(),
    }
  }

  /**
   * Return a redacted snapshot of the gateway endpoint, node health metrics, and active selection preferences.
   * @returns current {@link VpnTunnelStateSnapshot}.
   */
  state(): VpnTunnelStateSnapshot {
    const best = this.healthTracker.rankCandidates()[0]
    return {
      gateway: this.gateway?.endpoint() ?? null,
      nodes: this.healthTracker.snapshots(),
      selectedNodeId: best?.id ?? null,
      lastRoutedNodeId: this.healthTracker.getLastRoutedNodeId(),
      pinnedNodeId: this.healthTracker.getPinnedNodeId(),
      preferRegion: this.healthTracker.getPreferRegion(),
      maxPreferredLatencyMs: this.healthTracker.getMaxPreferredLatencyMs(),
    }
  }

  /**
   * Start the loopback HTTP/CONNECT + SOCKS5 gateway on `127.0.0.1` if not already running.
   * @returns bound loopback proxy endpoint.
   */
  async ensureGateway(): Promise<VpnGatewayEndpoint> {
    if (this.gateway === null) {
      this.gateway = new LoopbackProxyGateway({
        bindPort: this.resolvedConfig.bindPort,
        connectTimeoutMs: this.resolvedConfig.connectTimeoutMs,
        dnsResolver: this.dnsResolver,
        decideTarget: (host, _port, forceProxy) => this.decideGatewayTarget(host, forceProxy),
        onNodeDialSuccess: (nodeId, rttMs) => { this.healthTracker.recordSuccess(nodeId, rttMs) },
        onNodeDialFailure: (nodeId, reason) => { this.healthTracker.recordFailure(nodeId, reason) },
        onConnectionOpen: (nodeId) => { this.healthTracker.markConnectionStart(nodeId) },
        onConnectionClose: (nodeId) => { this.healthTracker.markConnectionEnd(nodeId) },
      })
    }
    return this.gateway.start()
  }

  /**
   * Stop the loopback gateway and close any in-flight tunnel streams.
   */
  async stopGateway(): Promise<void> {
    const active = this.gateway
    this.gateway = null
    if (active !== null) {
      await active.close()
    }
  }

  /**
   * Replace the active parsed subscriptions, merging their proxy nodes and Clash routing rules.
   * @param subscriptions - active parsed subscription documents.
   */
  setSubscriptions(subscriptions: readonly ParsedSubscription[]): void {
    const mergedNodes: ProxyNodeConfig[] = []
    const mergedRules: RoutingRule[] = []
    for (const sub of subscriptions) {
      mergedNodes.push(...sub.nodes)
      mergedRules.push(...sub.rules)
    }
    this.healthTracker.setNodes(mergedNodes)
    this.subscriptionRules = mergedRules
    this.rebuildRuleMatcher()
  }

  /**
   * Update gateway mode, region-tier preferences, latency ceiling, or custom high-priority routing rules.
   * @param policy - partial routing policy fields to update.
   */
  setRoutingPolicy(policy: VpnRoutingPolicyInput): void {
    if (policy.gatewayMode !== undefined) {
      this.gatewayMode = policy.gatewayMode
    }
    if (policy.preferRegion !== undefined || policy.maxPreferredLatencyMs !== undefined) {
      this.healthTracker.setRoutingPreferences(
        policy.preferRegion ?? this.healthTracker.getPreferRegion(),
        policy.maxPreferredLatencyMs ?? this.healthTracker.getMaxPreferredLatencyMs(),
      )
    }
    if (policy.customRules !== undefined) {
      this.customRules = [...policy.customRules]
      this.rebuildRuleMatcher()
    }
  }

  /**
   * Pin traffic to `nodeId`, or pass `null` to restore automatic region-tier and latency selection.
   * @param nodeId - target node identifier, or `null` for automatic mode.
   */
  selectNode(nodeId: VpnNodeId | null): void {
    this.healthTracker.setPinnedNode(nodeId)
  }

  /**
   * Quarantine `nodeId` immediately when an upstream service rejects its exit IP or region despite transport reachability.
   * @param nodeId - node identifier to quarantine.
   * @param reason - redacted quarantine reason recorded on the node snapshot.
   * @param cooldownMs - quarantine duration in milliseconds (defaults to `1_800_000`, 30 minutes).
   */
  penalizeNode(nodeId: VpnNodeId, reason: string, cooldownMs?: number): void {
    this.healthTracker.penalizeNode(nodeId, reason, cooldownMs)
  }

  /**
   * Evaluate the routing disposition (`proxy`, `direct`, or `reject`) for `host` under `mode`.
   * @param host - destination hostname or IP literal.
   * @param mode - routing mode (`direct`, `smart`, or `global`; defaults to the active gateway mode).
   * @returns computed {@link VpnRouteDecision}.
   */
  decideRoute(host: string, mode: 'direct' | 'smart' | 'global' = this.gatewayMode): VpnRouteDecision {
    if (isPrivateNetworkHost(host)) {
      return { action: 'direct', matchedRule: 'PRIVATE-NETWORK' }
    }
    if (mode === 'direct') {
      return { action: 'direct', matchedRule: 'MODE-DIRECT' }
    }
    const best = this.healthTracker.rankCandidates()[0]
    if (mode === 'global') {
      for (const custom of this.customRules) {
        const customEval = new RuleMatcher([custom]).match(host)
        if (customEval.matchedRule !== 'FALLBACK-DIRECT') {
          if (customEval.action === 'REJECT') return { action: 'reject', matchedRule: customEval.matchedRule }
          if (customEval.action === 'DIRECT') return { action: 'direct', matchedRule: customEval.matchedRule }
          return {
            action: 'proxy',
            matchedRule: customEval.matchedRule,
            ...(best !== undefined ? { nodeId: best.id } : {}),
          }
        }
      }
      return {
        action: 'proxy',
        matchedRule: 'MODE-GLOBAL',
        ...(best !== undefined ? { nodeId: best.id } : {}),
      }
    }

    const match = this.ruleMatcher.match(host)
    if (match.action === 'REJECT') {
      return { action: 'reject', matchedRule: match.matchedRule }
    }
    if (match.action === 'DIRECT') {
      return { action: 'direct', matchedRule: match.matchedRule }
    }
    return {
      action: 'proxy',
      matchedRule: match.matchedRule,
      ...(best !== undefined ? { nodeId: best.id } : {}),
    }
  }

  /**
   * Fetch and parse a remote VPN subscription URL directly (bypassing global proxy dispatchers and FakeIP DNS).
   * @param url - HTTP(S) subscription URL.
   * @param subscriptionId - nominal identifier assigned to parsed nodes.
   * @param signal - optional caller cancellation signal.
   * @returns validated {@link ParsedSubscription}.
   */
  async fetchSubscription(
    url: string,
    subscriptionId: VpnSubscriptionId,
    signal?: AbortSignal,
  ): Promise<ParsedSubscription> {
    const combinedSignal = signal
      ? AbortSignal.any([this.lifetime.signal, signal])
      : this.lifetime.signal
    return fetchSubscription(url, {
      subscriptionId,
      dnsResolver: this.dnsResolver,
      timeoutMs: this.resolvedConfig.subscriptionFetchTimeoutMs,
      maxBytes: this.resolvedConfig.subscriptionMaxBytes,
      signal: combinedSignal,
    })
  }

  /**
   * Benchmark candidate or specified proxy nodes in bounded parallel batches and update node health metrics.
   * @param options - optional node ID filter, count limit, probe URL, concurrency, and deadline.
   * @returns per-node {@link VpnProbeResult} list in input/candidate order.
   */
  async probeNodes(options: ProbeNodesOptions = {}): Promise<VpnProbeResult[]> {
    const rankedCandidates = options.subscriptionId !== undefined
      ? this.healthTracker.rankCandidates().filter(node => node.subscriptionId === options.subscriptionId)
      : this.healthTracker.rankCandidates()
    const targetNodes: ProxyNodeConfig[] = options.nodeIds !== undefined
      ? options.nodeIds
        .map(id => this.healthTracker.getNode(id))
        .filter((node): node is ProxyNodeConfig => node !== undefined)
      : rankedCandidates.slice(0, options.limit ?? rankedCandidates.length)

    if (targetNodes.length === 0) return []

    const probeUrl = options.probeUrl ?? this.resolvedConfig.defaultProbeUrl
    const timeoutMs = options.timeoutMs ?? this.resolvedConfig.probeTimeoutMs
    const concurrency = Math.max(1, Math.min(options.concurrency ?? this.resolvedConfig.probeConcurrency, targetNodes.length))
    const combinedSignal = options.signal
      ? AbortSignal.any([this.lifetime.signal, options.signal])
      : this.lifetime.signal

    const results: VpnProbeResult[] = Array.from({ length: targetNodes.length })
    let nextIndex = 0

    const worker = async (): Promise<void> => {
      while (true) {
        const idx = nextIndex
        nextIndex += 1
        const node = targetNodes[idx]
        if (node === undefined) return
        const res = await probeNodeThroughTunnel(node, probeUrl, {
          dnsResolver: this.dnsResolver,
          timeoutMs,
          signal: combinedSignal,
          ...(options.skipTargetCertVerify !== undefined ? { skipTargetCertVerify: options.skipTargetCertVerify } : {}),
        })
        this.recordProbeOutcome(node.id, res)
        results[idx] = res
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()))
    return results
  }

  /**
   * Probe `targetUrl` through an explicit `nodeId` or the currently highest-ranked proxy node.
   * @param targetUrl - HTTP(S) URL to request through the tunnel.
   * @param options - optional node ID, deadline, and cancellation signal.
   * @returns redacted {@link VpnProbeResult}.
   */
  async probeUrl(targetUrl: string, options: ProbeUrlOptions = {}): Promise<VpnProbeResult> {
    const selectedNode = options.nodeId !== undefined
      ? this.healthTracker.getNode(options.nodeId)
      : this.healthTracker.rankCandidates()[0]
    if (selectedNode === undefined) {
      throw new VpnTunnelError('VPN_NO_HEALTHY_NODE', 'No proxy node available to probe target URL')
    }

    const combinedSignal = options.signal
      ? AbortSignal.any([this.lifetime.signal, options.signal])
      : this.lifetime.signal
    const res = await probeNodeThroughTunnel(selectedNode, targetUrl, {
      dnsResolver: this.dnsResolver,
      timeoutMs: options.timeoutMs ?? this.resolvedConfig.probeTimeoutMs,
      signal: combinedSignal,
      ...(options.skipTargetCertVerify !== undefined ? { skipTargetCertVerify: options.skipTargetCertVerify } : {}),
    })
    this.recordProbeOutcome(selectedNode.id, res)
    return res
  }

  private recordProbeOutcome(nodeId: VpnNodeId, res: VpnProbeResult): void {
    if (res.ok && res.latencyMs !== null) {
      this.healthTracker.recordSuccess(nodeId, res.latencyMs)
    } else {
      this.healthTracker.recordFailure(nodeId, res.error as string)
    }
  }

  /**
   * Parse raw Clash YAML or Base64/plain URI subscription content offline.
   * @param text - raw subscription payload text.
   * @param options - subscription ID, optional quota header, and server Date header.
   * @returns validated {@link ParsedSubscription}.
   */
  parseSubscription(text: string, options: ParseSubscriptionOptions): ParsedSubscription {
    return parseSubscriptionContent(text, options)
  }

  /**
   * Discover `SUB_VPN_*` and `VPN_SUB_*` candidate URLs across `env` and `.env` file layers.
   * @param env - process environment record.
   * @param fileLayers - ordered `.env` file contents (`dsh-env` and `user-env`).
   * @returns deduplicated {@link EnvSubscriptionCandidate} list.
   */
  discoverEnvSubscriptions(
    env: Readonly<Record<string, string | undefined>>,
    fileLayers: readonly { readonly source: 'dsh-env' | 'user-env'; readonly content: string }[] = [],
  ): EnvSubscriptionCandidate[] {
    return discoverEnvSubscriptionCandidates(env, fileLayers)
  }

  /**
   * Mask path and query tokens in a subscription URL for display (`https://host/***`).
   * @param url - raw subscription URL.
   * @returns masked display URL.
   */
  maskUrl(url: string): string {
    return maskSubscriptionUrl(url)
  }

  /**
   * Redact URLs, hostnames, IP literals, and credentials from an error or message.
   * @param err - thrown error or diagnostic value.
   * @returns redacted single-line summary.
   */
  redactError(err: unknown): string {
    return redactNetworkError(err)
  }

  /**
   * Brand a raw identifier as a {@link VpnSubscriptionId}.
   * @param raw - non-empty subscription identifier string.
   * @returns branded {@link VpnSubscriptionId}.
   */
  subscriptionId(raw: string): VpnSubscriptionId {
    return vpnSubscriptionId(raw)
  }

  /**
   * Brand a raw identifier as a {@link VpnNodeId}.
   * @param raw - non-empty node identifier string.
   * @returns branded {@link VpnNodeId}.
   */
  nodeId(raw: string): VpnNodeId {
    return vpnNodeId(raw)
  }

  /**
   * Parse a single Clash-style routing rule line (`DOMAIN-SUFFIX,openai.com,PROXY`).
   * @param line - rule line text.
   * @returns parsed {@link RoutingRule}, or `null` when blank, comment, or unsupported.
   */
  parseRuleLine(line: string): RoutingRule | null {
    return parseClashRuleLine(line)
  }
}
