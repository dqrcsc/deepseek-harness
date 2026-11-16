import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer as createNetServer, connect as netConnect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import {
  currentTrafficContext,
  proxyEnvironmentForChild,
  proxyRouteFor,
  runWithTrafficContext,
} from '@deepseek-ai/dsh-http-proxy'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageDomainPlugin from '@deepseek-ai/dsh-storage-domain'
import * as storageSqlitePlugin from '@deepseek-ai/dsh-storage-sqlite'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import VpnTunnelRuntime, { type Config as VpnTunnelConfig } from '@deepseek-ai/dsh-vpn-tunnel'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import NetworkProxyService, { type Config as NetworkProxyConfig } from '../src/index.ts'
import {
  asNodeId,
  asSubscriptionId,
  cacheEncryptionCredentialKey,
  subscriptionCredentialKey,
} from '../src/domain.ts'

const cleanups: Array<() => Promise<void>> = []
let savedSubEnv: Array<readonly [string, string | undefined]> = []

beforeEach(() => {
  savedSubEnv = []
  for (const key of Object.keys(process.env)) {
    if (/^(?:SUB_VPN_|VPN_SUB_)/iu.test(key)) {
      savedSubEnv.push([key, process.env[key]])
      Reflect.deleteProperty(process.env, key)
    }
  }
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const key of Object.keys(process.env)) {
    if (/^(?:SUB_VPN_|VPN_SUB_)/iu.test(key)) {
      Reflect.deleteProperty(process.env, key)
    }
  }
  for (const [key, value] of savedSubEnv) {
    if (value !== undefined) process.env[key] = value
  }
  savedSubEnv = []
  while (cleanups.length > 0) {
    const fn = cleanups.pop()
    if (fn !== undefined) await fn()
  }
})

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-network-svc-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function startHttpServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ readonly server: Server; readonly port: number; readonly url: string }> {
  const server = createServer(handler)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { resolve() })
  })
  cleanups.push(() => new Promise<void>((resolve) => {
    server.close(() => { resolve() })
    server.closeAllConnections()
  }))
  const addr = server.address()
  if (addr === null || typeof addr === 'string') throw new Error('expected TCP server address')
  return { server, port: addr.port, url: `http://127.0.0.1:${String(addr.port)}` }
}

/** Minimal loopback SOCKS5 proxy forwarding all streams to a fixed local HTTP target port. */
async function startFixedTargetSocks5Server(targetPort: number): Promise<{ readonly port: number; hits: number }> {
  const state = { port: 0, hits: 0 }
  const sockets = new Set<Socket>()
  const server = createNetServer((client) => {
    sockets.add(client)
    client.once('close', () => sockets.delete(client))
    let stage: 'greeting' | 'request' | 'streaming' = 'greeting'
    let buf = Buffer.alloc(0)
    client.on('data', (chunk: Buffer) => {
      if (stage === 'streaming') return
      buf = Buffer.concat([buf, chunk])
      if (stage === 'greeting') {
        if (buf.length < 2) return
        const nmethods = buf[1] ?? 0
        if (buf.length < 2 + nmethods) return
        buf = buf.subarray(2 + nmethods)
        client.write(Buffer.from([0x05, 0x00]))
        stage = 'request'
      }
      if (stage === 'request') {
        if (buf.length < 5) return
        const atyp = buf[3]
        let reqLen = 0
        if (atyp === 0x01) reqLen = 4 + 4 + 2
        else if (atyp === 0x03) reqLen = 4 + 1 + (buf[4] ?? 0) + 2
        else if (atyp === 0x04) reqLen = 4 + 16 + 2
        if (reqLen === 0 || buf.length < reqLen) return
        const leftover = buf.subarray(reqLen)
        buf = Buffer.alloc(0)
        stage = 'streaming'
        state.hits += 1

        const upstream = netConnect({ host: '127.0.0.1', port: targetPort }, () => {
          sockets.add(upstream)
          upstream.once('close', () => sockets.delete(upstream))
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x00, 0x00]))
          if (leftover.length > 0) upstream.write(leftover)
          client.pipe(upstream)
          upstream.pipe(client)
        })
        upstream.on('error', () => client.destroy())
        client.on('error', () => upstream.destroy())
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { resolve() })
  })
  cleanups.push(() => new Promise<void>((resolve) => {
    for (const sock of sockets) sock.destroy()
    server.close(() => { resolve() })
  }))
  const addr = server.address()
  if (addr === null || typeof addr === 'string') throw new Error('expected SOCKS5 TCP address')
  state.port = addr.port
  return state
}

function buildClashYaml(socksPort: number, extraNodeName?: string): string {
  const extra = extraNodeName !== undefined
    ? `\n  - { name: "${extraNodeName}", type: socks5, server: 127.0.0.1, port: ${String(socksPort)} }`
    : ''
  return [
    'proxies:',
    `  - { name: "美国 US-01", type: socks5, server: 127.0.0.1, port: ${String(socksPort)} }${extra}`,
    'rules:',
    '  - DOMAIN-SUFFIX,openai.com,PROXY',
    '  - DOMAIN-SUFFIX,overseas.example,PROXY',
    '  - MATCH,PROXY',
    '',
  ].join('\n')
}

let stubLlmDispatch: (
  options: { readonly provider: string; readonly signal?: AbortSignal },
) => AsyncIterable<Record<string, unknown>> = async function* () {
  yield { type: 'finish', reason: { kind: 'stop' } }
}

class StubLlmService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'llm')
  }

  stream(options: { readonly provider: string; readonly signal?: AbortSignal }): AsyncIterable<Record<string, unknown>> {
    return this.ctx.waterfall(
      'llm/stream',
      options as never,
      (() => stubLlmDispatch(options)) as never,
    ) as AsyncIterable<Record<string, unknown>>
  }
}

async function bootHarness(options: {
  readonly rootDir: string
  readonly proxyConfig?: NetworkProxyConfig
  readonly vpnTunnelConfig?: VpnTunnelConfig
  readonly withLlm?: boolean
  readonly directInstantiate?: boolean
}): Promise<Context> {
  const ctx = new Context()
  cleanups.push(async () => {
    await ctx.fiber.dispose()
  })
  await ctx.plugin(Storage)
  await ctx.plugin(storageSqlitePlugin, { path: join(options.rootDir, 'storage.sqlite') })
  await ctx.plugin(storageDomainPlugin, { backend: 'sqlite' })
  await ctx.plugin(LocalCredentialProvider, {
    path: join(options.rootDir, '.credentials.yaml'),
    dshHome: options.rootDir,
    watch: false,
  })
  await ctx.plugin(VpnTunnelRuntime, options.vpnTunnelConfig)
  if (options.withLlm === true) {
    await ctx.plugin(StubLlmService)
  }
  if (options.directInstantiate === true) {
    ctx.inject(['vpnTunnel', 'storageDomain', 'credentials'], (scope) => {
      new NetworkProxyService(scope, options.proxyConfig)
    })
  } else {
    await ctx.plugin(NetworkProxyService, {
      dshHome: options.rootDir,
      userEnvPath: join(options.rootDir, 'user.env'),
      autoProbeOnActivate: false,
      ...options.proxyConfig,
    })
  }
  return ctx
}

describe('NetworkProxyService lifecycle, subscriptions, smart routing, and diagnostics', () => {
  it('starts idle in direct mode, validates inputs, manages subscriptions & encrypted caches, and isolates credentials', async () => {
    const rootDir = await makeTempDir()
    const origin = await startHttpServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(`origin:${req.headers.host ?? 'unknown'}:${req.url ?? '/'}`)
    })
    const socksA = await startFixedTargetSocks5Server(origin.port)
    const socksB = await startFixedTargetSocks5Server(origin.port)

    let serveError = false
    const subServer = await startHttpServer((req, res) => {
      if (serveError) {
        res.writeHead(502)
        res.end('bad gateway')
        return
      }
      if (req.url?.startsWith('/sub-b')) {
        res.writeHead(200, { 'content-type': 'text/yaml' })
        res.end(buildClashYaml(socksB.port, '新加坡 SG-01'))
        return
      }
      res.writeHead(200, {
        'content-type': 'text/yaml',
        'subscription-userinfo': 'upload=1024; download=2048; total=1048576; expire=1900000000',
      })
      res.end(buildClashYaml(socksA.port))
    })

    const ctx = await bootHarness({
      rootDir,
      withLlm: true,
      proxyConfig: {
        diagnosticTargets: [
          {
            id: 'fast-overseas',
            label: 'Fast Overseas',
            url: 'http://overseas.invalid/ping',
            category: 'web',
          },
        ],
      },
    })
    const initial = await ctx.networkProxy.status()
    expect(initial.mode).toBe('direct')
    expect(initial.gateway).toBeNull()
    expect(ctx.networkProxy.browserGuestProxyUrl()).toBeNull()
    expect(proxyEnvironmentForChild().HTTP_PROXY).toBeUndefined()

    // Input validation surfaces RemoteError('network-proxy/input-invalid')
    await expect(ctx.networkProxy.addSubscription({ name: '  ', url: 'https://example.com/sub' }))
      .rejects.toThrow(RemoteError)
    await expect(ctx.networkProxy.addSubscription({ name: 'Bad', url: 'ftp://example.com/sub' }))
      .rejects.toThrow(RemoteError)
    await expect(ctx.networkProxy.updateRouting({ maxPreferredLatencyMs: 10 }))
      .rejects.toThrow(RemoteError)
    await expect(ctx.networkProxy.updateRouting({ customRules: ['NOT_A_RULE'] }))
      .rejects.toThrow(RemoteError)

    // Partial routing updates leave omitted fields unchanged
    const partialRouting = await ctx.networkProxy.updateRouting({ proxySubprocesses: true })
    expect(partialRouting.routing.preferRegion).toBe('新加坡|日本|美国, 台湾')
    const partialRouting2 = await ctx.networkProxy.updateRouting({ preferRegion: '新加坡|日本|美国, 台湾' })
    expect(partialRouting2.routing.proxySubprocesses).toBe(true)

    // Smart mode BEFORE any subscriptions exist: gateway stays null, diagnostics & child proxy degrade safely
    await ctx.networkProxy.setMode({ mode: 'smart' })
    expect(ctx.networkProxy.browserGuestProxyUrl()).toBeNull()
    expect(proxyEnvironmentForChild().HTTP_PROXY).toBeUndefined()
    const emptySmartDiag = await ctx.networkProxy.runDiagnostics()
    expect(emptySmartDiag.selectedNodeName).toBeNull()
    expect(emptySmartDiag.targets[0]?.route).toBe('direct')
    expect(proxyRouteFor(new URL('http://10.0.0.1/lan')).proxied).toBe(false)
    await expect(fetch('http://overseas.invalid/no-gateway')).rejects.toThrow()
    await ctx.networkProxy.setMode({ mode: 'direct' })

    // Add disabled subscription (no upstream fetch yet)
    const addedDisabled = await ctx.networkProxy.addSubscription({
      name: 'Disabled Backup',
      url: `${subServer.url}/sub-b?secret=token-b`,
      enabled: false,
      autoRefreshMinutes: 120,
    })
    expect(addedDisabled.outcomes[0]?.nodeCount).toBe(0)
    const subBId = addedDisabled.outcomes[0]?.id
    if (subBId === undefined) throw new Error('expected subBId')

    // Add enabled subscription -> fetches, parses userinfo, masks URL, stores secret only in credentials
    const addedPrimary = await ctx.networkProxy.addSubscription({
      name: 'Primary Airport',
      url: `${subServer.url}/sub-a?secret=super-secret-token-a`,
    })
    expect(addedPrimary.outcomes[0]?.ok).toBe(true)
    expect(addedPrimary.outcomes[0]?.nodeCount).toBe(1)
    const subAId = addedPrimary.outcomes[0]?.id
    if (subAId === undefined) throw new Error('expected subAId')

    const subASummary = addedPrimary.status.subscriptions.find(item => item.id === subAId)
    expect(subASummary?.maskedUrl).toBe(`http://127.0.0.1:${String(subServer.port)}/***`)
    expect(JSON.stringify(addedPrimary.status)).not.toContain('super-secret-token-a')
    expect(subASummary?.userInfo?.totalBytes).toBe(1_048_576)

    // Duplicate URL is rejected on both addSubscription and updateSubscription
    await expect(ctx.networkProxy.addSubscription({
      name: 'Duplicate',
      url: `${subServer.url}/sub-a?secret=super-secret-token-a`,
    })).rejects.toThrow(RemoteError)
    await expect(ctx.networkProxy.updateSubscription({
      id: subBId,
      url: `${subServer.url}/sub-a?secret=super-secret-token-a`,
    })).rejects.toThrow(RemoteError)
    await expect(ctx.networkProxy.updateSubscription({
      id: asSubscriptionId('sub-missing'),
      name: 'Missing',
    })).rejects.toThrow(RemoteError)

    // Enabling subB via updateSubscription triggers its initial fetch, and rotating URL updates credentials
    const afterEnableB = await ctx.networkProxy.updateSubscription({
      id: subBId,
      name: 'Enabled Backup',
      enabled: true,
      autoRefreshMinutes: 240,
    })
    expect(afterEnableB.nodes.length).toBe(3)

    const afterRotateB = await ctx.networkProxy.updateSubscription({
      id: subBId,
      url: `${subServer.url}/sub-b?secret=rotated-token-b`,
    })
    expect(JSON.stringify(afterRotateB)).not.toContain('rotated-token-b')

    // Rename enabled subscription without changing URL (skips network re-fetch)
    const afterRenameA = await ctx.networkProxy.updateSubscription({
      id: subAId,
      name: 'Renamed Primary',
    })
    expect(afterRenameA.subscriptions.find(s => s.id === subAId)?.name).toBe('Renamed Primary')

    // Pin a node from subA, remove subB -> pinnedNodeId from subA is preserved; then pin subB on re-add & remove -> resets!
    const usNodeA = afterRotateB.nodes.find(n => n.subscriptionId === subAId)
    if (usNodeA === undefined) throw new Error('expected usNodeA')
    await ctx.networkProxy.selectNode({ nodeId: usNodeA.nodeId })
    const removedBKeepPin = await ctx.networkProxy.removeSubscription({ id: subBId })
    expect(removedBKeepPin.removed).toBe(true)
    expect(removedBKeepPin.status.pinnedNodeId).toBe(usNodeA.nodeId)

    // Re-add subB, pin its SG node, then remove subB -> pinnedNodeId resets to null automatically!
    const readdedB = await ctx.networkProxy.addSubscription({
      name: 'Temp Sub B',
      url: `${subServer.url}/sub-b?secret=readd`,
    })
    const readdedBId = readdedB.outcomes[0]?.id
    if (readdedBId === undefined) throw new Error('expected readdedBId')
    const sgNode = readdedB.status.nodes.find(n => n.name.includes('SG-01'))
    if (sgNode === undefined) throw new Error('expected SG-01 node')
    const pinnedStatus = await ctx.networkProxy.selectNode({ nodeId: sgNode.nodeId })
    expect(pinnedStatus.pinnedNodeId).toBe(sgNode.nodeId)

    await expect(ctx.networkProxy.selectNode({ nodeId: asNodeId('node-nonexistent') }))
      .rejects.toThrow(RemoteError)

    const removedB = await ctx.networkProxy.removeSubscription({ id: readdedBId })
    expect(removedB.removed).toBe(true)
    expect(removedB.status.pinnedNodeId).toBeNull()

    const removedAgain = await ctx.networkProxy.removeSubscription({ id: readdedBId })
    expect(removedAgain.removed).toBe(false)

    // Upstream refresh error preserves previously loaded nodes and records redacted lastError
    serveError = true
    const failedRefresh = await ctx.networkProxy.refreshSubscriptions({ id: subAId })
    expect(failedRefresh.outcomes[0]?.ok).toBe(false)
    expect(failedRefresh.outcomes[0]?.nodeCount).toBe(1)
    expect(failedRefresh.status.subscriptions[0]?.lastError).toBeDefined()

    await expect(ctx.networkProxy.refreshSubscriptions({ id: asSubscriptionId('sub-unknown') }))
      .rejects.toThrow(RemoteError)

    // Missing credential record reports a clear message without crashing (and enabling a disabled sub without cred is safe)
    await ctx.credentials.deleteRecord(
      `network-proxy/${subAId}` as Parameters<typeof ctx.credentials.deleteRecord>[0],
    )
    const missingCredRefresh = await ctx.networkProxy.refreshSubscriptions({})
    expect(missingCredRefresh.outcomes[0]?.ok).toBe(false)
    expect(missingCredRefresh.outcomes[0]?.error).toContain('credential is missing')

    const disabledNoCred = await ctx.networkProxy.addSubscription({
      name: 'Disabled No Cred',
      url: `${subServer.url}/nocred`,
      enabled: false,
    })
    const noCredId = disabledNoCred.outcomes[0]?.id
    if (noCredId === undefined) throw new Error('missing noCredId')
    await ctx.credentials.deleteRecord(subscriptionCredentialKey(noCredId))
    expect(await ctx.credentials.readRecord(subscriptionCredentialKey(noCredId))).toBeUndefined()
    const afterEnableNoCred = await ctx.networkProxy.updateSubscription({ id: noCredId, enabled: true })
    expect(afterEnableNoCred.subscriptions.find(s => s.id === noCredId)?.enabled).toBe(true)
  })

  it('routes smart/global traffic, honors provider & capability overrides, probes nodes, and runs diagnostics', async () => {
    const rootDir = await makeTempDir()
    const directServer = await startHttpServer((req, res) => {
      if (req.url === '/fail500') {
        res.writeHead(500)
        res.end('internal error')
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('via-direct')
    })
    const proxiedOrigin = await startHttpServer((_req, res) => {
      res.writeHead(204)
      res.end()
    })
    const socks = await startFixedTargetSocks5Server(proxiedOrigin.port)
    const subServer = await startHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/yaml' })
      res.end(buildClashYaml(socks.port, '新加坡 SG-Fast'))
    })

    const ctx = await bootHarness({
      rootDir,
      withLlm: true,
      proxyConfig: {
        diagnosticTimeoutMs: 250,
        defaultProbeLimit: 4,
        diagnosticTargets: [
          {
            id: 'local-direct',
            label: 'Local Direct',
            url: `${directServer.url}/ok`,
            category: 'web',
          },
          {
            id: 'local-500',
            label: 'Local 500',
            url: `${directServer.url}/fail500`,
            category: 'mcp',
          },
          {
            id: 'overseas-llm',
            label: 'Overseas LLM',
            url: 'http://api.openai.com/v1/models',
            category: 'llm',
            providerId: 'openai',
          },
          {
            id: 'domestic-deepseek',
            label: 'DeepSeek Domestic',
            url: `http://127.0.0.1:${String(directServer.port)}/ok`,
            category: 'llm',
            providerId: 'deepseek-official',
          },
          {
            id: 'rejected-host',
            label: 'Rejected Host',
            url: 'http://ads.blocked.example/banner',
            category: 'plugin',
          },
          {
            id: 'unreachable-port',
            label: 'Unreachable Port',
            url: 'http://127.0.0.1:1/unreachable',
            category: 'embedding',
          },
          {
            id: 'forced-direct-anthropic',
            label: 'Forced Direct Anthropic',
            url: 'http://api.anthropic.invalid/v1/messages',
            category: 'llm',
            providerId: 'anthropic',
          },
          {
            id: 'forced-proxy-deepseek',
            label: 'Forced Proxy DeepSeek',
            url: 'http://api.deepseek.com/models',
            category: 'llm',
            providerId: 'deepseek-official',
          },
          {
            id: 'smart-direct-rule',
            label: 'Smart Direct Rule',
            url: 'http://portal.direct-custom.invalid/ping',
            category: 'plugin',
          },
        ],
      },
    })

    // Verify llm/stream waterfall tags async generator pulls with provider TrafficContext
    let observedProvider: string | undefined
    const waterfallGen = ctx.waterfall(
      'llm/stream',
      { provider: 'anthropic' } as never,
      (async function* () {
        observedProvider = currentTrafficContext()?.providerId
        yield { type: 'done' }
      }) as never,
    ) as AsyncIterable<unknown>
    for await (const _chunk of waterfallGen) {
      // drain
    }
    expect(observedProvider).toBe('anthropic')

    const added = await ctx.networkProxy.addSubscription({
      name: 'Smart Sub',
      url: `${subServer.url}/clash.yaml`,
    })
    const subId = added.outcomes[0]?.id
    if (subId === undefined) throw new Error('missing subId')

    // Switch to smart mode -> loopback gateway starts
    const smartStatus = await ctx.networkProxy.setMode({ mode: 'smart' })
    expect(smartStatus.mode).toBe('smart')
    expect(smartStatus.gateway?.httpProxyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u)
    expect(ctx.networkProxy.browserGuestProxyUrl()).toBe(smartStatus.gateway?.httpProxyUrl)
    expect(proxyEnvironmentForChild().HTTPS_PROXY).toBe(smartStatus.gateway?.httpProxyUrl)

    // Probe nodes (filtered and unfiltered, plus invalid probeUrl validation)
    await expect(ctx.networkProxy.probeNodes({ probeUrl: 'not-a-url' })).rejects.toThrow(RemoteError)
    const probedFiltered = await ctx.networkProxy.probeNodes({
      subscriptionId: subId,
      limit: 2,
      probeUrl: 'http://overseas.example/generate_204',
    })
    expect(probedFiltered.results).toHaveLength(2)
    expect(probedFiltered.results[0]?.ok).toBe(true)

    const probeSignal = new AbortController()
    const probedAll = await ctx.networkProxy.probeNodes(
      { probeUrl: 'http://overseas.example/generate_204' },
      probeSignal.signal,
    )
    expect(probedAll.results.length).toBeGreaterThanOrEqual(2)

    // Configure overrides and custom rules
    await ctx.networkProxy.updateRouting({
      preferRegion: '新加坡|美国',
      maxPreferredLatencyMs: 3_500,
      proxySubprocesses: false,
      proxyBrowserGuests: false,
      providerOverrides: {
        'deepseek-official': 'proxy',
        anthropic: 'direct',
        google: 'auto',
      },
      capabilityOverrides: {
        web: 'proxy',
        mcp: 'direct',
        plugin: 'auto',
      },
      customRules: [
        'DOMAIN-SUFFIX,blocked.example,REJECT',
        'DOMAIN-SUFFIX,direct-custom.invalid,DIRECT',
      ],
    })
    expect(ctx.networkProxy.browserGuestProxyUrl()).toBeNull()
    expect(proxyEnvironmentForChild().HTTPS_PROXY).toBeUndefined()

    // Test live dynamic fetch routing under smart mode:
    // 1. Overseas domain routes through our SOCKS5 tunnel -> hits proxiedOrigin (204)
    const hitsBefore = socks.hits
    const overseasResp = await runWithTrafficContext({ category: 'llm', providerId: 'openai' }, () =>
      fetch('http://api.openai.com/v1/models'))
    expect(overseasResp.status).toBe(204)
    expect(socks.hits).toBeGreaterThan(hitsBefore)

    // 2. Domestic baseline (`api.deepseek.com`) normally routes DIRECT, UNLESS providerOverride forces `proxy`!
    const hitsBeforeOverride = socks.hits
    const forcedProxyResp = await runWithTrafficContext(
      { category: 'llm', providerId: 'deepseek-official' },
      () => fetch('http://api.deepseek.com/models'),
    )
    expect(forcedProxyResp.status).toBe(204)
    expect(socks.hits).toBeGreaterThan(hitsBeforeOverride)

    // 3. capabilityOverrides `mcp: 'direct'`, `plugin: 'auto'`, `general` category, and unattributed fetch
    const directCustomResp = await runWithTrafficContext(
      { category: 'mcp' },
      () => fetch(`${directServer.url}/ok`),
    )
    expect(await directCustomResp.text()).toBe('via-direct')
    expect(
      runWithTrafficContext({ category: 'mcp' }, () => proxyRouteFor(new URL('http://overseas.example/mcp')).proxied),
    ).toBe(false)
    expect(
      runWithTrafficContext({ category: 'web' }, () => proxyRouteFor(new URL('http://overseas.example/web')).proxied),
    ).toBe(true)
    await expect(
      fetch('http://portal.direct-custom.invalid/unattributed', { signal: AbortSignal.timeout(250) }),
    ).rejects.toThrow()
    await expect(
      runWithTrafficContext({ category: 'general' }, () =>
        fetch('http://portal.direct-custom.invalid/general', { signal: AbortSignal.timeout(250) })),
    ).rejects.toThrow()
    await expect(
      runWithTrafficContext({ category: 'plugin' }, () =>
        fetch('http://portal.direct-custom.invalid/plugin-auto', { signal: AbortSignal.timeout(250) })),
    ).rejects.toThrow()

    // Probe without explicit probeUrl (filtering to an empty subscription ID so no external network call occurs)
    const emptyProbe = await ctx.networkProxy.probeNodes({ subscriptionId: asSubscriptionId('sub-none') })
    expect(emptyProbe.results).toHaveLength(0)

    // Run 1-click connectivity diagnostics (both without signal and with signal)
    const diagReport = await ctx.networkProxy.runDiagnostics()
    expect(diagReport.mode).toBe('smart')
    expect(diagReport.targets.length).toBeGreaterThanOrEqual(6)
    expect(diagReport.targets.find(t => t.id === 'local-direct')?.ok).toBe(true)
    expect(diagReport.targets.find(t => t.id === 'local-500')?.ok).toBe(false)
    expect(diagReport.targets.find(t => t.id === 'overseas-llm')?.route).toBe('proxy')
    expect(diagReport.targets.find(t => t.id === 'overseas-llm')?.ok).toBe(true)
    expect(diagReport.targets.find(t => t.id === 'forced-proxy-deepseek')?.route).toBe('proxy')
    expect(diagReport.targets.find(t => t.id === 'rejected-host')?.route).toBe('reject')
    expect(diagReport.targets.find(t => t.id === 'unreachable-port')?.ok).toBe(false)

    const ac = new AbortController()
    const diagWithSignal = await ctx.networkProxy.runDiagnostics(ac.signal)
    expect(diagWithSignal.targets.length).toBeGreaterThanOrEqual(6)

    // Exercise gateway port rotation eviction when underlying gateway was stopped externally
    await ctx.vpnTunnel.stopGateway()

    // Switch to global mode, exercise global routing & diagnostics, then unpin & switch back to direct mode
    const globalStatus = await ctx.networkProxy.setMode({ mode: 'global' })
    expect(globalStatus.mode).toBe('global')
    const globalResp = await fetch('http://api.openai.com/v1/models')
    expect(globalResp.status).toBe(204)
    const globalDiag = await ctx.networkProxy.runDiagnostics()
    expect(globalDiag.mode).toBe('global')

    const unpinned = await ctx.networkProxy.selectNode({ nodeId: null })
    expect(unpinned.pinnedNodeId).toBeNull()

    const directStatus = await ctx.networkProxy.setMode({ mode: 'direct' })
    expect(directStatus.mode).toBe('direct')
    expect(directStatus.gateway).toBeNull()

    const directDiag = await ctx.networkProxy.runDiagnostics()
    expect(directDiag.mode).toBe('direct')
    expect(directDiag.targets.find(t => t.id === 'overseas-llm')?.route).toBe('direct')
  })

  it('imports ambient .env subscriptions, restores encrypted caches on cold restart, and handles auto-refresh & edge faults', async () => {
    const rootDir = await makeTempDir()
    const origin = await startHttpServer((_req, res) => {
      res.writeHead(204)
      res.end()
    })
    const socks = await startFixedTargetSocks5Server(origin.port)
    let subOnline = true
    const subServer = await startHttpServer((_req, res) => {
      if (!subOnline) {
        res.socket?.destroy()
        return
      }
      res.writeHead(200, { 'content-type': 'text/yaml' })
      res.end(buildClashYaml(socks.port))
    })

    // Seed process.env, $DSH_HOME/.env, and user.env (including an invalid URL candidate to exercise skip path)
    process.env.SUB_VPN_PROC = `${subServer.url}/proc-sub?token=secret0`
    await writeFile(
      join(rootDir, '.env'),
      `SUB_VPN_DSH=${subServer.url}/dsh-sub?token=secret1\nVPN_SUB_INVALID=http://[invalid-url\n`,
      'utf8',
    )
    await writeFile(
      join(rootDir, 'user.env'),
      `SUB_VPN_USER=${subServer.url}/user-sub?token=secret2\n`,
      'utf8',
    )

    const ctx1 = await bootHarness({
      rootDir,
      proxyConfig: {
        autoRefreshCheckIntervalMs: 60,
      },
    })

    // Listener error in network-proxy/changed is contained and logged
    const warnSpy = vi.spyOn(ctx1.logger, 'warn').mockImplementation(() => {})
    ctx1.on('network-proxy/changed', () => {
      throw new Error('boom-listener')
    })

    const initialStatus = await ctx1.networkProxy.status()
    expect(initialStatus.ambientEnvCandidates.length).toBeGreaterThanOrEqual(3)

    const imported1 = await ctx1.networkProxy.importEnvSubscriptions()
    expect(imported1.importedCount).toBe(3)
    expect(imported1.skippedCount).toBeGreaterThanOrEqual(1)
    expect(warnSpy).toHaveBeenCalled()

    // Second import skips already-imported digests without emitting changes
    const imported2 = await ctx1.networkProxy.importEnvSubscriptions()
    expect(imported2.importedCount).toBe(0)
    expect(imported2.skippedCount).toBeGreaterThanOrEqual(3)

    // Enable smart mode, disable one subscription, and let the 60ms auto-refresh timer fire
    const svc1 = ctx1.networkProxy
    const subZeroId = imported2.status.subscriptions[0]?.id
    const subOneId = imported2.status.subscriptions[1]?.id
    if (subZeroId !== undefined) {
      await svc1.updateSubscription({ id: subZeroId, enabled: false })
    }
    if (subOneId !== undefined) {
      await svc1.updateSubscription({ id: subOneId, autoRefreshMinutes: 1 })
    }
    await svc1.refreshSubscriptions({})
    if (subOneId !== undefined) {
      await ctx1.credentials.deleteRecord(
        `network-proxy/${subOneId}` as Parameters<typeof ctx1.credentials.deleteRecord>[0],
      )
    }
    await svc1.setMode({ mode: 'smart' })
    await new Promise(resolve => setTimeout(resolve, 90))
    await ctx1.fiber.dispose()

    // Rejections and safe null reads after stopping
    expect(svc1.browserGuestProxyUrl()).toBeNull()
    await expect(svc1.setMode({ mode: 'direct' })).rejects.toThrow('stopping')

    // Take subscription server OFFLINE, delete one cache file to exercise missing-cache cold boot + due auto-refresh!
    subOnline = false
    if (subOneId !== undefined) {
      await rm(join(rootDir, 'cache', 'network-proxy', `${subOneId}.enc`), { force: true })
    }
    const ctx2 = await bootHarness({
      rootDir,
      proxyConfig: {
        dshHome: rootDir,
        userEnvPath: join(rootDir, '.env'),
        autoRefreshCheckIntervalMs: 50,
      },
    })
    const coldBootStatus = await ctx2.networkProxy.status()
    expect(coldBootStatus.mode).toBe('smart')
    expect(coldBootStatus.nodes.length).toBeGreaterThanOrEqual(1)
    expect(coldBootStatus.gateway).not.toBeNull()

    // Also add an enabled subscription while offline (exercises refreshOneRecord catch when uncached + lastUpdatedAt === null),
    // delete another subscription's credential (exercises secretUrl === null in background refresh),
    // then bring subServer back ONLINE and let the 45ms timer refresh automatically!
    const offlineAdded = await ctx2.networkProxy.addSubscription({
      name: 'Initially Offline',
      url: `${subServer.url}/offline-first`,
    })
    expect(offlineAdded.outcomes[0]?.ok).toBe(false)
    const subTwoId = imported2.status.subscriptions[2]?.id
    if (subTwoId !== undefined) {
      await rm(join(rootDir, 'cache', 'network-proxy', `${subTwoId}.enc`), { force: true })
      await ctx2.credentials.deleteRecord(
        `network-proxy/${subTwoId}` as Parameters<typeof ctx2.credentials.deleteRecord>[0],
      )
    }
    // Inject one transient readRecord error during background refresh to cover background catch logging
    const warnSpy2 = vi.spyOn(ctx2.logger, 'warn').mockImplementation(() => {})
    vi.spyOn(ctx2.credentials, 'readRecord').mockRejectedValueOnce(new Error('transient cred error'))
    await expect.poll(() => warnSpy2.mock.calls.length, { timeout: 2_000 }).toBeGreaterThanOrEqual(1)

    subOnline = true
    await expect.poll(
      async () => (await ctx2.networkProxy.status()).subscriptions.find(s => s.name === 'Initially Offline')?.nodeCount ?? 0,
      { timeout: 2_000 },
    ).toBeGreaterThanOrEqual(1)
    await ctx2.fiber.dispose()

    // Also cover direct constructor defaults & corrupted cache-key recovery / failure
    const rootDir3 = await makeTempDir()
    const ctx3 = await bootHarness({
      rootDir: rootDir3,
      directInstantiate: true,
      proxyConfig: { dshHome: rootDir3 },
    })
    // Seed an invalid short cache-key in credentials so getOrCreateCacheSecretKey regenerates it
    await ctx3.credentials.modifyRecord(cacheEncryptionCredentialKey(), async () => ({
      kind: 'api-key',
      key: 'short',
    }))
    subOnline = true
    const recoveredAdd = await ctx3.networkProxy.addSubscription({
      name: 'Recovered Key Sub',
      url: `${subServer.url}/rec`,
    })
    expect(recoveredAdd.outcomes[0]?.ok).toBe(true)

    // If credentials.modifyRecord unexpectedly returns undefined, refreshOneRecord catches and records redacted error
    vi.spyOn(ctx3.credentials, 'modifyRecord').mockResolvedValueOnce(undefined)
    const brokenKeyRefresh = await ctx3.networkProxy.refreshSubscriptions({})
    expect(brokenKeyRefresh.outcomes[0]?.ok).toBe(false)

    // Unexpected non-input error inside updateSubscription rethrows through throwRemoteInputIfInvalid
    vi.spyOn(ctx3.credentials, 'modifyRecord').mockRejectedValueOnce(new Error('disk full'))
    const recId = recoveredAdd.outcomes[0]?.id
    if (recId === undefined) throw new Error('missing recId')
    await expect(ctx3.networkProxy.updateSubscription({
      id: recId,
      url: `${subServer.url}/other`,
    })).rejects.toThrow('disk full')
  })

  it('auto-probes unprobed nodes on activation, evicts pooled agents on node rotation, and retries LLM geo-restrictions', async () => {
    const rootDir = await makeTempDir()
    const slowOrigin = await startHttpServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(204)
        res.end()
      }, 65)
    })
    const fastOrigin = await startHttpServer((_req, res) => {
      res.writeHead(204)
      res.end()
    })
    const socksUsSlow = await startFixedTargetSocks5Server(slowOrigin.port)
    const socksSgFast = await startFixedTargetSocks5Server(fastOrigin.port)
    const socksJpFast = await startFixedTargetSocks5Server(fastOrigin.port)

    const multiNodeYaml = [
      'proxies:',
      `  - { name: "美国 US-04", type: socks5, server: 127.0.0.1, port: ${String(socksUsSlow.port)} }`,
      `  - { name: "新加坡 SG-01", type: socks5, server: 127.0.0.1, port: ${String(socksSgFast.port)} }`,
      `  - { name: "台湾 TW-01", type: socks5, server: 127.0.0.1, port: ${String(socksJpFast.port)} }`,
      `  - { name: "台湾 TW-02", type: socks5, server: 127.0.0.1, port: ${String(socksJpFast.port)} }`,
      'rules:',
      '  - DOMAIN-SUFFIX,googleapis.com,PROXY',
      '  - MATCH,PROXY',
      '',
    ].join('\n')

    let serveSingleNode = false
    const subServer = await startHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/yaml' })
      if (serveSingleNode) {
        res.end([
          'proxies:',
          `  - { name: "美国 US-Only", type: socks5, server: 127.0.0.1, port: ${String(socksSgFast.port)} }`,
          'rules:',
          '  - MATCH,PROXY',
          '',
        ].join('\n'))
        return
      }
      res.end(multiNodeYaml)
    })

    const ctx = await bootHarness({
      rootDir,
      withLlm: true,
      vpnTunnelConfig: {
        defaultProbeUrl: 'http://probe.example/generate_204',
      },
      proxyConfig: {
        autoProbeOnActivate: true,
      },
    })

    const added = await ctx.networkProxy.addSubscription({
      name: 'AutoProbe Sub',
      url: `${subServer.url}/sub.yaml`,
    })
    const subId = added.outcomes[0]?.id
    if (subId === undefined) throw new Error('missing subId')
    const initialUsNode = added.status.nodes.find(n => n.name.includes('US-04'))
    const sgNode = added.status.nodes.find(n => n.name.includes('SG-01'))
    if (initialUsNode === undefined || sgNode === undefined) throw new Error('missing nodes')
    // Before probing, all Tier-0 nodes tie at unprobed score and index 0 (US-04) leads
    expect(added.status.selectedNodeId).toBe(initialUsNode.nodeId)

    // Activate smart mode -> schedules background initial probe; calling updateRouting mid-probe skips duplicate probe
    await ctx.networkProxy.setMode({ mode: 'smart' })
    await ctx.networkProxy.updateRouting({ maxPreferredLatencyMs: 3_900 })

    // Background probe completes -> SG-01 (~1ms) beats US-04 (~65ms) and becomes selectedNodeId
    await expect.poll(
      async () => (await ctx.networkProxy.status()).nodes.every(n => n.latencyMs !== null),
      { timeout: 3_000 },
    ).toBe(true)
    const afterProbe = await ctx.networkProxy.status()
    expect(afterProbe.selectedNodeId).toBe(sgNode.nodeId)

    // Subsequent updateRouting when all nodes are already probed hits unprobedIds.length === 0 cleanly
    await ctx.networkProxy.updateRouting({ maxPreferredLatencyMs: 4_000 })

    const collectWaterfall = async (
      opts: { readonly provider: string; readonly signal?: AbortSignal },
      factory: () => AsyncIterable<Record<string, unknown>>,
    ): Promise<unknown[]> => {
      stubLlmDispatch = () => factory()
      const out: unknown[] = []
      const stream = ctx.llm.stream({
        provider: opts.provider,
        model: 'test-model',
        messages: [],
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      })
      for await (const item of stream) out.push(item)
      return out
    }

    // 1. Two consecutive geo-restricted nodes (including pi-ai pre-finish usage chunks & real routed tunnel tracking)
    //    quarantine automatically, evict pooled sockets, and succeed on 3rd node!
    let dispatchCalls = 0
    const failoverChunks = await collectWaterfall(
      { provider: 'google', signal: new AbortController().signal },
      async function* () {
        dispatchCalls += 1
        if (dispatchCalls === 1) {
          const r = await fetch('http://googleapis.com/generate_204')
          expect(r.status).toBe(204)
          yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }
          yield {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: { message: 'User location is not supported for the API use.', code: 'INVALID_REQUEST', status: 400 },
            },
          }
          return
        }
        if (dispatchCalls === 2) {
          yield {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: { message: 'Country, region, or territory not supported', code: 'INVALID_REQUEST', status: 403 },
            },
          }
          return
        }
        yield { type: 'text-delta', index: 0, text: 'Gemini OK' }
        yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    )
    expect(dispatchCalls).toBe(3)
    expect(failoverChunks).toEqual([
      { type: 'text-delta', index: 0, text: 'Gemini OK' },
      { type: 'usage', usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const postFailover = await ctx.networkProxy.status()
    expect(postFailover.nodes.find(n => n.nodeId === sgNode.nodeId)?.circuitOpenUntilMs).not.toBeNull()
    expect(postFailover.nodes.find(n => n.nodeId === initialUsNode.nodeId)?.circuitOpenUntilMs).not.toBeNull()

    // 2. Refresh fresh nodes and exhaust all 3 attempts on geo-restriction -> flushes buffered usage + terminal error on 3rd attempt
    await ctx.networkProxy.removeSubscription({ id: subId })
    const readded = await ctx.networkProxy.addSubscription({
      name: 'Fresh 4 Nodes',
      url: `${subServer.url}/sub2.yaml`,
    })
    const sub2Id = readded.outcomes[0]?.id
    if (sub2Id === undefined) throw new Error('missing sub2Id')
    await expect.poll(
      async () => (await ctx.networkProxy.status()).nodes.every(n => n.latencyMs !== null),
      { timeout: 3_000 },
    ).toBe(true)

    let exhaustedCalls = 0
    const exhaustedChunks = await collectWaterfall(
      { provider: 'openai' },
      async function* () {
        exhaustedCalls += 1
        yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: { message: 'unsupported_country_region_territory', code: 'INVALID_REQUEST', status: 403 },
          },
        }
      },
    )
    expect(exhaustedCalls).toBe(3)
    expect(exhaustedChunks).toHaveLength(2)

    // 3. Guard checks: aborted signal, non-geo error, mid-stream error after text-delta, pinned node, direct override, stopped gateway
    let guardCalls = 0
    await collectWaterfall(
      { provider: 'google', signal: AbortSignal.abort() },
      async function* () {
        guardCalls += 1
        yield {
          type: 'finish',
          reason: { kind: 'error', failure: { message: 'User location is not supported', code: 'ABORTED' } },
        }
      },
    )
    expect(guardCalls).toBe(1)

    await collectWaterfall(
      { provider: 'google' },
      async function* () {
        guardCalls += 1
        yield {
          type: 'finish',
          reason: { kind: 'error', failure: { message: 'API key not valid', code: 'AUTH_FAILED', status: 401 } },
        }
      },
    )
    expect(guardCalls).toBe(2)

    await collectWaterfall(
      { provider: 'google' },
      async function* () {
        guardCalls += 1
        yield { type: 'text-delta', index: 0, text: 'partial' }
        yield {
          type: 'finish',
          reason: { kind: 'error', failure: { message: 'User location is not supported', code: 'INVALID_REQUEST' } },
        }
      },
    )
    expect(guardCalls).toBe(3)

    const anyNodeId = (await ctx.networkProxy.status()).nodes[0]?.nodeId
    if (anyNodeId === undefined) throw new Error('missing anyNodeId')
    await ctx.networkProxy.selectNode({ nodeId: anyNodeId })
    await collectWaterfall(
      { provider: 'google' },
      async function* () {
        guardCalls += 1
        yield {
          type: 'finish',
          reason: { kind: 'error', failure: { message: 'User location is not supported', code: 'INVALID_REQUEST' } },
        }
      },
    )
    expect(guardCalls).toBe(4)
    await ctx.networkProxy.selectNode({ nodeId: null })

    await ctx.networkProxy.updateRouting({ providerOverrides: { anthropic: 'direct' } })
    await collectWaterfall(
      { provider: 'anthropic' },
      async function* () {
        guardCalls += 1
        yield {
          type: 'finish',
          reason: { kind: 'error', failure: { message: 'region is not supported', code: 'INVALID_REQUEST' } },
        }
      },
    )
    expect(guardCalls).toBe(5)

    // Single-node subscription: penalizeNode runs, nextSelected === candidateBefore -> stops after 1 attempt
    await ctx.networkProxy.removeSubscription({ id: sub2Id })
    serveSingleNode = true
    await ctx.networkProxy.addSubscription({
      name: 'Single Node Sub',
      url: `${subServer.url}/single.yaml`,
    })
    let singleCalls = 0
    await collectWaterfall(
      { provider: 'google' },
      async function* () {
        singleCalls += 1
        yield {
          type: 'finish',
          reason: { kind: 'error', failure: { message: 'region is not supported', code: 'INVALID_REQUEST' } },
        }
      },
    )
    expect(singleCalls).toBe(1)

    // Stopped gateway while smart mode is active -> canAutoRotateLlmNode returns false
    await ctx.vpnTunnel.stopGateway()
    await collectWaterfall(
      { provider: 'google' },
      async function* () {
        singleCalls += 1
        yield {
          type: 'finish',
          reason: { kind: 'error', failure: { message: 'region is not supported', code: 'INVALID_REQUEST' } },
        }
      },
    )
    expect(singleCalls).toBe(2)

    // Pre-open waterfall call (while storageDomain.open is still pending and liveDomain === undefined) hits fallback safely
    await ctx.fiber.dispose()
    const rootDirEarly = await makeTempDir()
    const ctxEarly = new Context()
    cleanups.push(async () => {
      await ctxEarly.fiber.dispose()
    })
    await ctxEarly.plugin(Storage)
    await ctxEarly.plugin(storageSqlitePlugin, { path: join(rootDirEarly, 'storage.sqlite') })
    await ctxEarly.plugin(storageDomainPlugin, { backend: 'sqlite' })
    await ctxEarly.plugin(LocalCredentialProvider, {
      path: join(rootDirEarly, '.credentials.yaml'),
      dshHome: rootDirEarly,
      watch: false,
    })
    await ctxEarly.plugin(VpnTunnelRuntime)
    await ctxEarly.plugin(StubLlmService)
    stubLlmDispatch = async function* () {
      singleCalls += 1
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    let releaseDomainOpen = () => {}
    const domainOpenGate = new Promise<void>((resolve) => {
      releaseDomainOpen = resolve
    })
    const realOpen = ctxEarly.storageDomain.open.bind(ctxEarly.storageDomain)
    vi.spyOn(ctxEarly.storageDomain, 'open').mockImplementationOnce(async (definition) => {
      await domainOpenGate
      return realOpen(definition)
    })
    const initPromise = ctxEarly.plugin(NetworkProxyService, { dshHome: rootDirEarly, autoProbeOnActivate: false })
    await new Promise(resolve => setTimeout(resolve, 10))
    for await (const _chunk of ctxEarly.llm.stream({ provider: 'google', model: 'test-model', messages: [] })) {
      // drain while liveDomain is still undefined
    }
    releaseDomainOpen()
    await initPromise
    expect(singleCalls).toBe(3)

    // Disposing while an initial background probe is in flight aborts cleanly without post-stop emission
    const rootDirDispose = await makeTempDir()
    const ctxDispose = await bootHarness({
      rootDir: rootDirDispose,
      vpnTunnelConfig: {
        defaultProbeUrl: 'http://probe.example/generate_204',
      },
      proxyConfig: {
        autoProbeOnActivate: true,
      },
    })
    serveSingleNode = false
    await ctxDispose.networkProxy.addSubscription({
      name: 'Dispose Mid-Probe',
      url: `${subServer.url}/dispose.yaml`,
    })
    await ctxDispose.networkProxy.setMode({ mode: 'smart' })
    await ctxDispose.fiber.dispose()
  })
})
