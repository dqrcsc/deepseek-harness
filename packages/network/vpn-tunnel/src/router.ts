/**
 * Multi-region tier compiler (`美国|新加坡, 日本`), EWMA latency scorer, `maxPreferredLatencyMs` latency-ceiling
 * tier failover, and exponential-backoff circuit-breaker node health tracker.
 */

import type {
  NodeHealthSnapshot,
  ProxyNodeConfig,
  RegionTier,
  VpnNodeId,
} from './types.ts'

const REGION_ALIAS_GROUPS: readonly (readonly string[])[] = [
  ['us', 'usa', 'united states', 'america', '美国', '美西', '美东', '洛杉矶', '圣何塞', '西雅图', '硅谷'],
  ['sg', 'sgp', 'singapore', '新加坡', '狮城'],
  ['jp', 'jpn', 'japan', '日本', '东京', '大阪'],
  ['hk', 'hkg', 'hong kong', 'hongkong', '香港'],
  ['tw', 'twn', 'taiwan', '台湾', '台北'],
  ['kr', 'kor', 'korea', '韩国', '首尔'],
  ['gb', 'uk', 'united kingdom', '英国', '伦敦'],
  ['de', 'deu', 'germany', '德国', '法兰克福'],
]

const SHORT_ASCII_CODE = /^[a-z]{2,3}$/

function expandRegionToken(token: string): readonly string[] {
  const lower = token.trim().toLowerCase()
  if (lower.length === 0) return []
  for (const group of REGION_ALIAS_GROUPS) {
    if (group.includes(lower)) return group
  }
  return [lower]
}

/**
 * Compile a region preference expression (`"美国|新加坡, 日本"` -> ordered tiers of equal-weight aliases).
 * `,` or `;` separates ordered priority tiers; `|` or `/` groups equal-priority regions inside one tier.
 * @param spec - user-configured region preference expression.
 * @returns ordered array of {@link RegionTier} definitions.
 */
export function compileRegionTiers(spec: string): readonly RegionTier[] {
  const tiers: RegionTier[] = []
  for (const rawTier of spec.split(/[,;，；]/)) {
    const patterns = new Set<string>()
    for (const token of rawTier.split(/[|/｜]/)) {
      for (const alias of expandRegionToken(token)) {
        patterns.add(alias)
      }
    }
    if (patterns.size > 0) {
      tiers.push({ patterns: [...patterns] })
    }
  }
  return tiers
}

/**
 * Compute the 0-based region tier index matched by `nodeName`, or `tiers.length` when no preferred tier matches.
 * Short 2–3 letter ASCII codes (`us`, `sg`, `jp`, `hk`) match on non-letter boundaries so `"plus"` does not match `"us"`.
 * @param nodeName - human-readable proxy node label.
 * @param tiers - compiled region preference tiers.
 * @returns matching tier index (`0 .. tiers.length`).
 */
export function nodeRegionTierIndex(nodeName: string, tiers: readonly RegionTier[]): number {
  const lower = nodeName.toLowerCase()
  for (let t = 0; t < tiers.length; t += 1) {
    const tier = tiers[t] as RegionTier
    for (const pattern of tier.patterns) {
      if (SHORT_ASCII_CODE.test(pattern)) {
        const boundaryRegex = new RegExp(`(?:^|[^a-z])${pattern}(?:$|[^a-z])`)
        if (boundaryRegex.test(lower)) return t
      } else if (lower.includes(pattern)) {
        return t
      }
    }
  }
  return tiers.length
}

/** Options configuring {@link NodeHealthTracker} scoring, latency failover, and circuit breaking. */
export interface NodeHealthTrackerOptions {
  /** Consecutive failures before opening the node's circuit breaker (defaults to `2`). */
  readonly failureThreshold?: number
  /** Initial circuit-breaker cooldown in milliseconds (defaults to `15_000`). */
  readonly baseCooldownMs?: number
  /** Maximum exponential-backoff cooldown in milliseconds (defaults to `180_000`). */
  readonly maxCooldownMs?: number
  /** Latency ceiling in milliseconds above which preferred-region nodes yield to faster fallback tiers (defaults to `4000`). */
  readonly maxPreferredLatencyMs?: number
  /** Initial region preference string (defaults to `'美国|新加坡'`). */
  readonly preferRegion?: string
}

interface MutableNodeStats {
  latencyMs: number | null
  consecutiveFailures: number
  circuitOpenUntilMs: number | null
  activeConnections: number
  totalSuccesses: number
  totalFailures: number
  lastError: string | null
}

/** Tracks EWMA latency, active connections, exponential-backoff circuit state, and region-tier node ranking. */
export class NodeHealthTracker {
  private nodes: ProxyNodeConfig[] = []
  private readonly nodeById = new Map<VpnNodeId, ProxyNodeConfig>()
  private readonly stats = new Map<VpnNodeId, MutableNodeStats>()
  private preferRegion: string
  private tiers: readonly RegionTier[]
  private maxPreferredLatencyMs: number
  private pinnedNodeId: VpnNodeId | null = null
  private readonly failureThreshold: number
  private readonly baseCooldownMs: number
  private readonly maxCooldownMs: number

  constructor(options: NodeHealthTrackerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 2
    this.baseCooldownMs = options.baseCooldownMs ?? 15_000
    this.maxCooldownMs = options.maxCooldownMs ?? 180_000
    this.maxPreferredLatencyMs = options.maxPreferredLatencyMs ?? 4000
    this.preferRegion = options.preferRegion ?? '美国|新加坡'
    this.tiers = compileRegionTiers(this.preferRegion)
  }

  /**
   * Replace the active proxy node catalog while preserving telemetry for surviving `nodeId`s.
   * @param nodes - updated proxy node catalog.
   */
  setNodes(nodes: readonly ProxyNodeConfig[]): void {
    this.nodes = [...nodes]
    this.nodeById.clear()
    const validIds = new Set<VpnNodeId>()
    for (const node of nodes) {
      this.nodeById.set(node.id, node)
      validIds.add(node.id)
      if (!this.stats.has(node.id)) {
        this.stats.set(node.id, {
          latencyMs: null,
          consecutiveFailures: 0,
          circuitOpenUntilMs: null,
          activeConnections: 0,
          totalSuccesses: 0,
          totalFailures: 0,
          lastError: null,
        })
      }
    }
    for (const existingId of [...this.stats.keys()]) {
      if (!validIds.has(existingId)) this.stats.delete(existingId)
    }
    if (this.pinnedNodeId !== null && !validIds.has(this.pinnedNodeId)) {
      this.pinnedNodeId = null
    }
  }

  /**
   * Update region preference tiers and maximum preferred-tier latency ceiling.
   * @param preferRegion - pipe-separated region preference expression.
   * @param maxPreferredLatencyMs - latency ceiling in milliseconds before demoting a preferred tier.
   */
  setRoutingPreferences(preferRegion: string, maxPreferredLatencyMs: number): void {
    this.preferRegion = preferRegion
    this.tiers = compileRegionTiers(preferRegion)
    this.maxPreferredLatencyMs = maxPreferredLatencyMs
  }

  /**
   * Pin routing to a specific `nodeId`, or pass `null` to restore automatic tier/latency selection.
   * @param nodeId - target node identifier to pin, or `null` for automatic selection.
   */
  setPinnedNode(nodeId: VpnNodeId | null): void {
    this.pinnedNodeId = nodeId !== null && this.nodeById.has(nodeId) ? nodeId : null
  }

  /**
   * Return current pinned `nodeId`, or `null` in automatic mode.
   * @returns pinned node identifier, or `null` when automatic selection is active.
   */
  getPinnedNodeId(): VpnNodeId | null {
    return this.pinnedNodeId
  }

  /**
   * Return current region preference expression.
   * @returns pipe-separated region preference expression.
   */
  getPreferRegion(): string {
    return this.preferRegion
  }

  /**
   * Return current preferred-region latency ceiling in milliseconds.
   * @returns latency ceiling in milliseconds.
   */
  getMaxPreferredLatencyMs(): number {
    return this.maxPreferredLatencyMs
  }

  /**
   * Look up a `ProxyNodeConfig` by `nodeId`.
   * @param nodeId - node identifier to look up.
   * @returns matching node configuration, or `undefined` when absent.
   */
  getNode(nodeId: VpnNodeId): ProxyNodeConfig | undefined {
    return this.nodeById.get(nodeId)
  }

  /**
   * Return all currently registered proxy nodes.
   * @returns snapshot array of registered proxy nodes.
   */
  listNodes(): readonly ProxyNodeConfig[] {
    return this.nodes
  }

  /**
   * Increment active stream count on `nodeId`.
   * @param nodeId - node identifier whose active connection count increases.
   */
  markConnectionStart(nodeId: VpnNodeId): void {
    const entry = this.stats.get(nodeId)
    if (entry !== undefined) entry.activeConnections += 1
  }

  /**
   * Decrement active stream count on `nodeId`.
   * @param nodeId - node identifier whose active connection count decreases.
   */
  markConnectionEnd(nodeId: VpnNodeId): void {
    const entry = this.stats.get(nodeId)
    if (entry !== undefined && entry.activeConnections > 0) {
      entry.activeConnections -= 1
    }
  }

  /**
   * Record a successful dial or probe round-trip time in milliseconds, closing any open circuit.
   * @param nodeId - node identifier that succeeded.
   * @param rttMs - measured round-trip latency in milliseconds.
   */
  recordSuccess(nodeId: VpnNodeId, rttMs: number): void {
    const entry = this.stats.get(nodeId)
    if (entry === undefined) return
    const clamped = Math.max(1, Math.round(rttMs))
    entry.latencyMs = entry.latencyMs === null
      ? clamped
      : Math.round(entry.latencyMs * 0.65 + clamped * 0.35)
    entry.consecutiveFailures = 0
    entry.circuitOpenUntilMs = null
    entry.totalSuccesses += 1
    entry.lastError = null
  }

  /**
   * Record a failed dial or probe, opening the exponential-backoff circuit breaker once threshold is reached.
   * @param nodeId - node identifier that failed.
   * @param reason - redacted failure summary.
   * @param nowMs - current epoch timestamp in milliseconds.
   */
  recordFailure(nodeId: VpnNodeId, reason: string, nowMs = Date.now()): void {
    const entry = this.stats.get(nodeId)
    if (entry === undefined) return
    entry.consecutiveFailures += 1
    entry.totalFailures += 1
    entry.lastError = reason
    if (entry.consecutiveFailures >= this.failureThreshold) {
      const exp = Math.min(6, entry.consecutiveFailures - this.failureThreshold)
      const cooldown = Math.min(this.maxCooldownMs, this.baseCooldownMs * (2 ** exp))
      entry.circuitOpenUntilMs = nowMs + cooldown
    }
  }

  /**
   * Return candidate nodes ordered from best to fallback at `nowMs`.
   * Pinned nodes come first (unless excluded); otherwise healthy nodes with latency `<= maxPreferredLatencyMs`
   * sort by `(regionTier, effectiveScore)` ahead of slow nodes (`latencyMs > maxPreferredLatencyMs`), and open-circuit
   * nodes appear only as last-resort recovery candidates if every circuit is currently open.
   * @param excludeIds - optional node IDs already attempted on the current request.
   * @param nowMs - current epoch timestamp in milliseconds.
   * @returns ordered list of candidate proxy nodes.
   */
  rankCandidates(excludeIds?: ReadonlySet<VpnNodeId>, nowMs = Date.now()): ProxyNodeConfig[] {
    const available = this.nodes.filter(node => !excludeIds?.has(node.id))
    if (available.length === 0) return []

    const scoreOf = (node: ProxyNodeConfig): {
      readonly isOpenCircuit: number
      readonly exceedsLatencyCeiling: number
      readonly tier: number
      readonly score: number
    } => {
      const st = this.stats.get(node.id) as MutableNodeStats
      const isOpen = st.circuitOpenUntilMs !== null && st.circuitOpenUntilMs > nowMs ? 1 : 0
      const exceeds = st.latencyMs !== null && st.latencyMs > this.maxPreferredLatencyMs ? 1 : 0
      const tier = nodeRegionTierIndex(node.name, this.tiers)
      const baseLatency = st.latencyMs ?? (this.maxPreferredLatencyMs + 500)
      const score = baseLatency + st.activeConnections * 15 + st.consecutiveFailures * 250
      return { isOpenCircuit: isOpen, exceedsLatencyCeiling: exceeds, tier, score }
    }

    const sorted = [...available].sort((a, b) => {
      if (this.pinnedNodeId !== null) {
        if (a.id === this.pinnedNodeId) return -1
        if (b.id === this.pinnedNodeId) return 1
      }
      const sa = scoreOf(a)
      const sb = scoreOf(b)
      if (sa.isOpenCircuit !== sb.isOpenCircuit) return sa.isOpenCircuit - sb.isOpenCircuit
      if (sa.exceedsLatencyCeiling !== sb.exceedsLatencyCeiling) {
        return sa.exceedsLatencyCeiling - sb.exceedsLatencyCeiling
      }
      if (sa.tier !== sb.tier) return sa.tier - sb.tier
      return sa.score - sb.score
    })

    const closedOnly = sorted.filter((node) => {
      if (this.pinnedNodeId !== null && node.id === this.pinnedNodeId) return true
      const st = this.stats.get(node.id) as MutableNodeStats
      return st.circuitOpenUntilMs === null || st.circuitOpenUntilMs <= nowMs
    })
    return closedOnly.length > 0 ? closedOnly : sorted
  }

  /**
   * Return redacted telemetry snapshots for all registered nodes.
   * @param nowMs - current epoch timestamp in milliseconds.
   * @returns ordered telemetry snapshots for all registered nodes.
   */
  snapshots(nowMs = Date.now()): NodeHealthSnapshot[] {
    return this.nodes.map((node) => {
      const st = this.stats.get(node.id) as MutableNodeStats
      const openUntil = st.circuitOpenUntilMs !== null && st.circuitOpenUntilMs > nowMs
        ? st.circuitOpenUntilMs
        : null
      return {
        nodeId: node.id,
        subscriptionId: node.subscriptionId,
        name: node.name,
        protocol: node.protocol,
        latencyMs: st.latencyMs,
        consecutiveFailures: st.consecutiveFailures,
        circuitOpenUntilMs: openUntil,
        activeConnections: st.activeConnections,
        totalSuccesses: st.totalSuccesses,
        totalFailures: st.totalFailures,
        ...(st.lastError !== null ? { lastError: st.lastError } : {}),
      }
    })
  }
}
