import { describe, expect, it } from 'vitest'
import {
  compileRegionTiers,
  NodeHealthTracker,
  nodeRegionTierIndex,
} from '../src/router.ts'
import { DEFAULT_SMART_ROUTING_RULES, RuleMatcher } from '../src/rules.ts'
import { vpnNodeId, vpnSubscriptionId, type ProxyNodeConfig } from '../src/types.ts'

const SUB_ID = vpnSubscriptionId('sub_1')

function makeNode(idSuffix: string, name: string): ProxyNodeConfig {
  return {
    id: vpnNodeId(`sub_1:${idSuffix}`),
    subscriptionId: SUB_ID,
    name,
    protocol: 'ss2022',
    server: '192.0.2.10',
    port: 8388,
  }
}

describe('RuleMatcher and DEFAULT_SMART_ROUTING_RULES', () => {
  it('routes built-in developer/AI domains and bypasses private/loopback addresses first', () => {
    const defaultMatcher = new RuleMatcher(DEFAULT_SMART_ROUTING_RULES)
    expect(defaultMatcher.match('127.0.0.1')).toEqual({ action: 'DIRECT', matchedRule: 'PRIVATE-NETWORK' })
    expect(defaultMatcher.match('[::1]')).toEqual({ action: 'DIRECT', matchedRule: 'PRIVATE-NETWORK' })
    expect(defaultMatcher.match('192.168.1.25')).toEqual({ action: 'DIRECT', matchedRule: 'PRIVATE-NETWORK' })
    expect(defaultMatcher.match('printer.local.')).toEqual({ action: 'DIRECT', matchedRule: 'PRIVATE-NETWORK' })

    expect(defaultMatcher.match('api.deepseek.com')).toEqual({
      action: 'DIRECT',
      matchedRule: 'DOMAIN-SUFFIX:deepseek.com',
    })
    expect(defaultMatcher.match('tsinghua.edu.cn')).toEqual({
      action: 'DIRECT',
      matchedRule: 'DOMAIN-SUFFIX:cn',
    })
    expect(defaultMatcher.match('api.anthropic.com.')).toEqual({
      action: 'PROXY',
      matchedRule: 'DOMAIN-SUFFIX:anthropic.com',
    })
    expect(defaultMatcher.match('generativelanguage.googleapis.com')).toEqual({
      action: 'PROXY',
      matchedRule: 'DOMAIN-SUFFIX:googleapis.com',
    })
    expect(defaultMatcher.match('unlisted.example.org')).toEqual({
      action: 'DIRECT',
      matchedRule: 'MATCH',
    })
  })

  it('evaluates DOMAIN, DOMAIN-SUFFIX, DOMAIN-KEYWORD, IP-CIDR, IP-CIDR6, invalid CIDRs, and FALLBACK-DIRECT', () => {
    const matcher = new RuleMatcher([
      { kind: 'DOMAIN', pattern: 'exact.example.com', action: 'REJECT' },
      { kind: 'DOMAIN-SUFFIX', pattern: '.openai.com', action: 'PROXY' },
      { kind: 'DOMAIN-KEYWORD', pattern: 'telemetry', action: 'REJECT' },
      { kind: 'IP-CIDR', pattern: 'invalid-cidr', action: 'PROXY' },
      { kind: 'IP-CIDR', pattern: '/24', action: 'PROXY' },
      { kind: 'IP-CIDR', pattern: '203.0.113.0/33', action: 'PROXY' },
      { kind: 'IP-CIDR', pattern: '203.0.113.0/24', action: 'PROXY' },
      { kind: 'IP-CIDR6', pattern: 'invalid-v6', action: 'PROXY' },
      { kind: 'IP-CIDR6', pattern: '/64', action: 'PROXY' },
      { kind: 'IP-CIDR6', pattern: '2001:db8::/129', action: 'PROXY' },
      { kind: 'IP-CIDR6', pattern: '2001:db8:abcd::/48', action: 'DIRECT' },
    ])

    expect(matcher.match('exact.example.com')).toEqual({ action: 'REJECT', matchedRule: 'DOMAIN:exact.example.com' })
    expect(matcher.match('openai.com')).toEqual({ action: 'PROXY', matchedRule: 'DOMAIN-SUFFIX:openai.com' })
    expect(matcher.match('api.openai.com')).toEqual({ action: 'PROXY', matchedRule: 'DOMAIN-SUFFIX:openai.com' })
    expect(matcher.match('app-telemetry.vendor.io')).toEqual({ action: 'REJECT', matchedRule: 'DOMAIN-KEYWORD:telemetry' })
    expect(matcher.match('203.0.113.99')).toEqual({ action: 'PROXY', matchedRule: 'IP-CIDR:203.0.113.0/24' })
    expect(matcher.match('198.51.100.5')).toEqual({ action: 'DIRECT', matchedRule: 'FALLBACK-DIRECT' })
    expect(matcher.match('[2001:db8:abcd:0001::1]')).toEqual({
      action: 'DIRECT',
      matchedRule: 'IP-CIDR6:2001:db8:abcd::/48',
    })
    expect(matcher.match('2001:db8:ffff::1')).toEqual({ action: 'DIRECT', matchedRule: 'FALLBACK-DIRECT' })

    // Catch-all /0 CIDR masks for IPv4 and IPv6
    const zeroPrefixMatcher = new RuleMatcher([
      { kind: 'IP-CIDR', pattern: '0.0.0.0/0', action: 'PROXY' },
      { kind: 'IP-CIDR6', pattern: '::/0', action: 'REJECT' },
    ])
    expect(zeroPrefixMatcher.match('8.8.8.8')).toEqual({ action: 'PROXY', matchedRule: 'IP-CIDR:0.0.0.0/0' })
    expect(zeroPrefixMatcher.match('2606:4700:4700::1111')).toEqual({ action: 'REJECT', matchedRule: 'IP-CIDR6:::/0' })
  })
})

describe('compileRegionTiers, nodeRegionTierIndex, and NodeHealthTracker', () => {
  it('compiles multi-region alias tiers and enforces ASCII word-boundary matching', () => {
    const tiers = compileRegionTiers('美国 | 新加坡, 日本; 香港 / 台湾，韩国；英国, 德国, zurich,   ')
    expect(tiers.length).toBe(7)
    expect(nodeRegionTierIndex('[US] San Jose IEPL', tiers)).toBe(0)
    expect(nodeRegionTierIndex('狮城 BGP 02', tiers)).toBe(0)
    expect(nodeRegionTierIndex('VIP Plus Node', tiers)).toBe(tiers.length)
    expect(nodeRegionTierIndex('东京 IPLC 01', tiers)).toBe(1)
    expect(nodeRegionTierIndex('台北 Hinet 01', tiers)).toBe(2)
    expect(nodeRegionTierIndex('Zurich Edge', tiers)).toBe(6)
  })

  it('ranks nodes by pin, circuit state, latency ceiling, region tier, and EWMA score', () => {
    const tracker = new NodeHealthTracker({
      failureThreshold: 2,
      baseCooldownMs: 10_000,
      maxCooldownMs: 30_000,
      maxPreferredLatencyMs: 4000,
      preferRegion: '新加坡|美国, 日本',
    })
    expect(tracker.getPreferRegion()).toBe('新加坡|美国, 日本')
    expect(tracker.getMaxPreferredLatencyMs()).toBe(4000)
    expect(tracker.rankCandidates()).toEqual([])

    const usSlow = makeNode('us1', '美国 圣何塞 01')
    const sgFast = makeNode('sg1', '新加坡 01')
    const sgMedium = makeNode('sg2', '新加坡 02')
    const jpFast = makeNode('jp1', '日本 东京 01')
    const other = makeNode('fr1', 'Paris 01')
    const ghostId = vpnNodeId('sub_1:ghost')

    tracker.setNodes([usSlow, sgMedium, sgFast, jpFast, other])
    expect(tracker.listNodes().length).toBe(5)
    expect(tracker.getNode(sgFast.id)).toEqual(sgFast)

    // Safe no-ops for unknown node IDs
    tracker.markConnectionStart(ghostId)
    tracker.markConnectionEnd(ghostId)
    tracker.markConnectionEnd(sgFast.id)
    tracker.recordSuccess(ghostId, 50)
    tracker.recordFailure(ghostId, 'ignored')

    // EWMA smoothing + active connection weight + same-tier score tie-breaking
    tracker.recordSuccess(sgFast.id, 100)
    tracker.recordSuccess(sgFast.id, 200)
    tracker.recordSuccess(sgMedium.id, 350)
    tracker.markConnectionStart(sgFast.id)
    tracker.markConnectionEnd(sgFast.id)
    tracker.recordSuccess(jpFast.id, 0) // clamped to 1ms
    tracker.recordSuccess(usSlow.id, 4500) // exceeds 4000ms ceiling -> yields to healthy tiers!

    const ranked1 = tracker.rankCandidates()
    expect(ranked1.map(n => n.id)).toEqual([sgFast.id, sgMedium.id, jpFast.id, other.id, usSlow.id])

    // Pinning overrides tier/latency ordering (testing both comparator branches and unknown pin ID)
    tracker.setPinnedNode(ghostId)
    expect(tracker.getPinnedNodeId()).toBeNull()
    tracker.setPinnedNode(other.id)
    expect(tracker.getPinnedNodeId()).toBe(other.id)
    expect(tracker.rankCandidates().map(n => n.id)[0]).toBe(other.id)

    // Circuit breaker exponential backoff + pinned open-circuit retention + all-open fallback
    const t0 = 1_000_000
    tracker.setPinnedNode(null)
    tracker.recordFailure(sgFast.id, 'timeout-1', t0)
    expect(tracker.snapshots(t0).find(s => s.nodeId === sgFast.id)?.circuitOpenUntilMs).toBeNull()
    tracker.recordFailure(sgFast.id, 'timeout-2', t0)
    expect(tracker.snapshots(t0).find(s => s.nodeId === sgFast.id)?.circuitOpenUntilMs).toBe(t0 + 10_000)

    // While sgFast circuit is open at t0 + 1000, sgMedium leads; after cooldown (t0 + 15000), sgFast re-enters closed candidates
    expect(tracker.rankCandidates(undefined, t0 + 1000).map(n => n.id)).not.toContain(sgFast.id)
    expect(tracker.rankCandidates(undefined, t0 + 15_000).map(n => n.id)).toContain(sgFast.id)

    // Pinned node stays included even when its circuit is open
    tracker.setPinnedNode(sgFast.id)
    expect(tracker.rankCandidates(undefined, t0 + 1000).map(n => n.id)[0]).toBe(sgFast.id)
    tracker.setPinnedNode(null)

    // Open every node's circuit -> rankCandidates falls back to sorted recovery order instead of empty array
    for (const node of [usSlow, sgMedium, jpFast, other]) {
      tracker.recordFailure(node.id, 'down', t0)
      tracker.recordFailure(node.id, 'down', t0)
    }
    expect(tracker.rankCandidates(undefined, t0 + 1000).length).toBe(5)
    expect(tracker.rankCandidates(new Set([usSlow.id, sgMedium.id, sgFast.id, jpFast.id, other.id]), t0 + 1000)).toEqual([])

    // Application-layer quarantine (penalizeNode) survives generic probes until cooldown expires
    tracker.penalizeNode(ghostId, 'ignored')
    const defaultQuarantineTracker = new NodeHealthTracker()
    defaultQuarantineTracker.setNodes([sgMedium, jpFast])
    defaultQuarantineTracker.penalizeNode(sgMedium.id, 'geo-blocked')
    expect(defaultQuarantineTracker.rankCandidates().map(n => n.id)).toEqual([jpFast.id])
    const qTime = Date.now()
    // Open transport circuit AND quarantine simultaneously to exercise combined ceiling selection
    defaultQuarantineTracker.recordFailure(sgMedium.id, 'dial-err-1', qTime)
    defaultQuarantineTracker.recordFailure(sgMedium.id, 'dial-err-2', qTime)
    defaultQuarantineTracker.penalizeNode(sgMedium.id, 'geo-blocked-extended', 3_600_000, qTime)
    expect(defaultQuarantineTracker.snapshots(qTime).find(s => s.nodeId === sgMedium.id)?.circuitOpenUntilMs)
      .toBe(qTime + 3_600_000)
    // Generic probe success updates latencyMs and clears transient circuit, but preserves active quarantine & lastError
    defaultQuarantineTracker.recordSuccess(sgMedium.id, 95, qTime + 1_000)
    const duringQuarantine = defaultQuarantineTracker.snapshots(qTime + 1_000).find(s => s.nodeId === sgMedium.id)
    expect(duringQuarantine?.latencyMs).toBe(95)
    expect(duringQuarantine?.circuitOpenUntilMs).toBe(qTime + 3_600_000)
    expect(duringQuarantine?.lastError).toBe('geo-blocked-extended')
    // Once quarantine expires, recordSuccess clears quarantine state and lastError
    defaultQuarantineTracker.recordSuccess(sgMedium.id, 90, qTime + 3_600_001)
    const afterQuarantine = defaultQuarantineTracker.snapshots(qTime + 3_600_001).find(s => s.nodeId === sgMedium.id)
    expect(afterQuarantine?.circuitOpenUntilMs).toBeNull()
    expect(afterQuarantine?.lastError).toBeUndefined()

    // Updating routing preferences and pruning removed nodes/pins/lastRouted in setNodes
    tracker.setRoutingPreferences('日本', 2000)
    expect(tracker.getPreferRegion()).toBe('日本')
    expect(tracker.getMaxPreferredLatencyMs()).toBe(2000)
    tracker.setPinnedNode(other.id)
    tracker.markConnectionStart(other.id)
    expect(tracker.getLastRoutedNodeId()).toBe(other.id)
    tracker.setNodes([jpFast])
    expect(tracker.getPinnedNodeId()).toBeNull()
    expect(tracker.getLastRoutedNodeId()).toBeNull()
    tracker.markConnectionStart(jpFast.id)
    expect(tracker.getLastRoutedNodeId()).toBe(jpFast.id)
    tracker.penalizeNode(jpFast.id, 'geo-rejected')
    expect(tracker.getLastRoutedNodeId()).toBeNull()
    expect(tracker.snapshots().length).toBe(1)

    // Default constructor options
    const defaultTracker = new NodeHealthTracker()
    expect(defaultTracker.getPreferRegion()).toBe('新加坡|日本|美国, 台湾')
  })
})
