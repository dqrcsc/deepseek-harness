import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  installDynamicProxyRouter,
  runWithTrafficContext,
  type TrafficContext,
} from '@deepseek-ai/dsh-http-proxy'
import { describe, expect, it } from 'vitest'
import VpnTunnelRuntime, {
  type EnvSubscriptionCandidate,
  type ProxyNodeConfig,
} from '../src/index.ts'
import { discoverEnvSubscriptionCandidates } from '../src/subscription.ts'
import { vpnNodeId, vpnSubscriptionId } from '../src/types.ts'

function loadLiveSubscriptionCandidates(): readonly EnvSubscriptionCandidate[] {
  const layers: { readonly source: 'dsh-env' | 'user-env'; readonly content: string }[] = []
  const userEnvPath = join(homedir(), '.env')
  if (existsSync(userEnvPath)) {
    layers.push({ source: 'user-env', content: readFileSync(userEnvPath, 'utf8') })
  }
  return discoverEnvSubscriptionCandidates(process.env, layers)
}

const LIVE_CANDIDATES = loadLiveSubscriptionCandidates()

describe('VpnTunnelRuntime live encrypted tunnel & smart routing e2e', () => {
  it.skipIf(LIVE_CANDIDATES.length === 0)(
    'fetches live SUB_VPN_* subscription, benchmarks 美国|新加坡 nodes, routes fetch() over pure-TS tunnel, fails over, and redacts all secrets',
    async () => {
      const candidate = LIVE_CANDIDATES[0] as EnvSubscriptionCandidate
      expect(candidate.maskedUrl).not.toBe(candidate.url)
      expect(candidate.maskedUrl.endsWith('/***')).toBe(true)

      const ctx = new Context()
      const scope = await ctx.plugin(VpnTunnelRuntime, {
        preferRegion: '美国|新加坡',
        maxPreferredLatencyMs: 4000,
        probeConcurrency: 6,
        probeTimeoutMs: 8000,
      })

      let routerHandle: Awaited<ReturnType<typeof installDynamicProxyRouter>> | undefined

      try {
        const subId = vpnSubscriptionId('sub_live_1')
        const parsed = await ctx.vpnTunnel.fetchSubscription(candidate.url, subId)
        expect(parsed.nodes.length).toBeGreaterThan(0)

        const protocols = new Set(parsed.nodes.map(n => n.protocol))
        expect(protocols.size).toBeGreaterThan(0)

        ctx.vpnTunnel.setSubscriptions([parsed])
        ctx.vpnTunnel.setRoutingPolicy({
          gatewayMode: 'smart',
          preferRegion: '美国|新加坡',
          maxPreferredLatencyMs: 4000,
        })

        // Benchmark top candidate nodes in parallel so health tracker locks onto the fastest healthy 美国|新加坡 node
        const probeResults = await ctx.vpnTunnel.probeNodes({
          limit: 8,
          probeUrl: 'https://www.google.com/generate_204',
          timeoutMs: 8000,
        })
        const healthyProbes = probeResults.filter(r => r.ok && r.latencyMs !== null)
        expect(healthyProbes.length).toBeGreaterThan(0)

        // Direct tunnel probe verification against Google 204 and GitHub Zen API
        const googleProbe = await ctx.vpnTunnel.probeUrl('https://www.google.com/generate_204', {
          timeoutMs: 10_000,
        })
        expect(googleProbe.ok).toBe(true)
        expect(googleProbe.statusCode).toBe(204)

        const githubProbe = await ctx.vpnTunnel.probeUrl('https://api.github.com/zen', {
          timeoutMs: 10_000,
        })
        expect(githubProbe.ok).toBe(true)
        expect(githubProbe.statusCode).toBe(200)

        // Start loopback HTTP/SOCKS5 gateway and bind dynamic process-wide fetch() router
        const endpoint = await ctx.vpnTunnel.ensureGateway()
        const observedContexts: (TrafficContext | undefined)[] = []

        routerHandle = await installDynamicProxyRouter({
          resolve: (url, trafficCtx) => {
            observedContexts.push(trafficCtx)
            const decision = ctx.vpnTunnel.decideRoute(url.hostname, 'smart')
            if (decision.action === 'proxy') {
              return { kind: 'proxy', proxyUrl: endpoint.httpProxyUrl }
            }
            return { kind: 'direct' }
          },
        })

        const googleFetchResp = await runWithTrafficContext(
          { category: 'web' },
          () => fetch('https://www.google.com/generate_204', { signal: AbortSignal.timeout(12_000) }),
        )
        expect(googleFetchResp.status).toBe(204)

        const githubFetchResp = await runWithTrafficContext(
          { category: 'llm', providerId: 'anthropic' },
          () => fetch('https://api.github.com/zen', {
            headers: { 'User-Agent': 'deepseek-harness-e2e' },
            signal: AbortSignal.timeout(12_000),
          }),
        )
        expect(githubFetchResp.status).toBe(200)
        const zenText = (await githubFetchResp.text()).trim()
        expect(zenText.length).toBeGreaterThan(0)
        expect(observedContexts).toContainEqual({ category: 'web' })
        expect(observedContexts).toContainEqual({ category: 'llm', providerId: 'anthropic' })

        // Verify automatic gateway failover when candidate #1 is dead/unreachable (fresh origin bypasses keep-alive pool)
        const selectedId = ctx.vpnTunnel.state().selectedNodeId
        const winningNode = parsed.nodes.find(n => n.id === selectedId) ?? parsed.nodes[0]
        if (winningNode === undefined) throw new Error('Expected at least one parsed node')
        const deadLeader: ProxyNodeConfig = {
          ...winningNode,
          id: vpnNodeId('sub_live_1:dead_leader'),
          name: '美国 Dead Leader 00',
          server: '127.0.0.1',
          port: 1,
        }
        ctx.vpnTunnel.setSubscriptions([
          {
            ...parsed,
            nodes: [deadLeader, ...parsed.nodes],
          },
        ])
        ctx.vpnTunnel.selectNode(deadLeader.id)
        const failoverResp = await fetch('https://www.gstatic.com/generate_204', {
          signal: AbortSignal.timeout(12_000),
        })
        expect(failoverResp.status).toBe(204)
        const deadSnapshot = ctx.vpnTunnel.state().nodes.find(n => n.nodeId === deadLeader.id)
        expect(deadSnapshot?.totalFailures).toBeGreaterThanOrEqual(1)

        // Strict zero-secret leakage audit across serialized runtime state
        const serializedState = JSON.stringify(ctx.vpnTunnel.state())
        expect(serializedState).not.toContain(candidate.url)
        for (const node of parsed.nodes) {
          if (node.server.length >= 4) {
            expect(serializedState).not.toContain(node.server)
          }
          if (node.password && node.password.length >= 4) {
            expect(serializedState).not.toContain(node.password)
          }
          if (node.uuid && node.uuid.length >= 4) {
            expect(serializedState).not.toContain(node.uuid)
          }
        }
      } finally {
        await routerHandle?.dispose()
        await scope.dispose()
      }
    },
  )
})
