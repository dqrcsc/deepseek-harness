/**
 * Host VPN subscription manager, smart-routing policy controller, encrypted subscription cache,
 * dynamic `dsh-http-proxy` router installer, and 1-click connectivity diagnostics service (`ctx.networkProxy`).
 * @module @deepseek-ai/dsh-network-proxy
 */

import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { dshCachePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import {
  installDynamicProxyRouter,
  isPrivateNetworkHost,
  streamWithTrafficContext,
  type DynamicProxyDecision,
  type DynamicProxyRouterHandle,
  type TrafficContext,
} from '@deepseek-ai/dsh-http-proxy'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { ParsedSubscription, RoutingRule } from '@deepseek-ai/dsh-vpn-tunnel'
import z from '@deepseek-ai/schemastery'
import { EncryptedSubscriptionCache } from './cache.ts'
import {
  DEFAULT_DIAGNOSTIC_TARGETS,
  runConnectivityDiagnostics,
  type DiagnosticTargetSpec,
  type EvaluatedDiagnosticRoute,
} from './diagnostics.ts'
import {
  cacheEncryptionCredentialKey,
  computeUrlDigest,
  DEFAULT_AUTO_REFRESH_MINUTES,
  DEFAULT_NETWORK_GLOBAL,
  generateSubscriptionId,
  NetworkProxyInputError,
  normalizeCapabilityOverrides,
  normalizeProviderOverrides,
  normalizeSubscriptionName,
  normalizeSubscriptionUrl,
  parseCustomRules,
  SMART_DOMESTIC_BASELINE_RULES,
  subscriptionCredentialKey,
  toRoutingSettings,
  toSubscriptionSummary,
  validateLatencyCeiling,
  validateRefreshMinutes,
  type StoredNetworkGlobal,
  type StoredSubscriptionRecord,
} from './domain.ts'
import { networkDomain } from './storage.ts'
import type {
  AddSubscriptionRequest,
  AmbientEnvSubscriptionPreview,
  ImportEnvSubscriptionsResult,
  NetworkDiagnosticReport,
  NetworkProxyStatus,
  ProbeNetworkNodesRequest,
  ProbeNetworkNodesResult,
  RefreshSubscriptionsRequest,
  RefreshSubscriptionsResult,
  RemoveSubscriptionRequest,
  RemoveSubscriptionResult,
  SelectNetworkNodeRequest,
  SetNetworkModeRequest,
  SubscriptionRefreshOutcome,
  UpdateNetworkRoutingRequest,
  UpdateSubscriptionRequest,
  VpnNodeId,
  VpnSubscriptionId,
} from './types.ts'

export { NetworkProxyInputError } from './domain.ts'
export type * from './client.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host VPN subscription manager, smart-routing policy controller, and diagnostics service. */
    networkProxy: NetworkProxyService
  }
}

/** Configurable diagnostic target entry accepted in {@link Config.diagnosticTargets}. */
export interface ConfiguredDiagnosticTarget {
  /** Stable target identifier. */
  id: string
  /** Human-readable target label. */
  label: string
  /** HTTP(S) target URL. */
  url: string
  /** Outbound traffic category (`llm`, `web`, `mcp`, `plugin`, or `embedding`). */
  category: 'llm' | 'web' | 'mcp' | 'plugin' | 'embedding'
  /** Optional LLM provider identifier when `category === 'llm'`. */
  providerId?: string
}

/** Validated configuration for {@link NetworkProxyService}. */
export interface Config {
  /** Explicit DeepSeek Harness home directory override used for cache and `$DSH_HOME/.env` lookup. */
  dshHome?: string
  /** Explicit OS user `.env` file path override (`~/.env` by default). */
  userEnvPath?: string
  /** Per-target timeout in milliseconds for `runDiagnostics`; defaults to `8000`. */
  diagnosticTimeoutMs?: number
  /** Background timer interval in milliseconds checking subscriptions due for `autoRefreshMinutes`; defaults to `60000`. */
  autoRefreshCheckIntervalMs?: number
  /** Default node-probe limit when `probeNodes` omits `limit`; defaults to `64`. */
  defaultProbeLimit?: number
  /** Automatically benchmark unprobed subscription nodes in the background when proxy routing activates; defaults to `true`. */
  autoProbeOnActivate?: boolean
  /** Optional custom diagnostic target list overriding built-in domestic/overseas targets. */
  diagnosticTargets?: ConfiguredDiagnosticTarget[]
}

const ConfiguredDiagnosticTargetSchema: z<ConfiguredDiagnosticTarget> = z.object({
  id: z.string().required(),
  label: z.string().required(),
  url: z.string().required(),
  category: z.union([
    z.const('llm'),
    z.const('web'),
    z.const('mcp'),
    z.const('plugin'),
    z.const('embedding'),
  ]).required(),
  providerId: z.string(),
})

function toDiagnosticSpecs(configured: readonly ConfiguredDiagnosticTarget[] | undefined): readonly DiagnosticTargetSpec[] {
  if (configured === undefined || configured.length === 0) return DEFAULT_DIAGNOSTIC_TARGETS
  return configured.map(item => ({
    id: item.id,
    label: item.label,
    url: item.url,
    trafficContext: {
      category: item.category,
      ...(item.providerId !== undefined ? { providerId: item.providerId } : {}),
    },
  }))
}

async function readOptionalTextFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8')
  } catch (_missingOrUnreadable) {
    return null
  }
}

const UPSTREAM_GEO_RESTRICTION_PATTERN = new RegExp(
  [
    'user location is not supported',
    'unsupported_country_region_territory',
    String.raw`country,\s*region,\s*or\s*territory\s+not\s+supported`,
    'region is not supported',
  ].join('|'),
  'iu',
)

function isUpstreamGeoRestrictionChunk(chunk: StreamChunk): boolean {
  return chunk.type === 'finish'
    && chunk.reason.kind === 'error'
    && UPSTREAM_GEO_RESTRICTION_PATTERN.test(chunk.reason.failure.message)
}

function throwRemoteInputIfInvalid(error: unknown): never {
  if (error instanceof NetworkProxyInputError) {
    throw new RemoteError('network-proxy/input-invalid', error.message, { code: error.reason })
  }
  throw error
}

/**
 * Host-wide VPN subscription manager and smart-routing policy controller (`ctx.networkProxy`).
 */
export class NetworkProxyService extends TypertRemoteService {
  static inject = ['vpnTunnel', 'storageDomain', 'credentials']

  static Config: z<Config> = z.object({
    dshHome: z.string(),
    userEnvPath: z.string(),
    diagnosticTimeoutMs: z.natural().min(100).max(MAX_TIMER_DELAY_MS).default(8_000),
    autoRefreshCheckIntervalMs: z.natural().min(50).max(MAX_TIMER_DELAY_MS).default(60_000),
    defaultProbeLimit: z.natural().min(1).max(64).default(64),
    autoProbeOnActivate: z.boolean().default(true),
    diagnosticTargets: z.array(ConfiguredDiagnosticTargetSchema),
  })

  private readonly resolvedDshHome: string
  private readonly resolvedUserEnvPath: string
  private readonly diagnosticTimeoutMs: number
  private readonly autoRefreshCheckIntervalMs: number
  private readonly defaultProbeLimit: number
  private readonly autoProbeOnActivate: boolean
  private readonly diagnosticTargets: readonly DiagnosticTargetSpec[]
  private readonly cache: EncryptedSubscriptionCache
  private readonly parsedBySubscription = new Map<VpnSubscriptionId, ParsedSubscription>()
  private readonly llmGeoRetryDepths = new WeakMap<GenerateOptions, number>()
  private readonly lifetime = new AbortController()
  private readonly ready: Promise<Domain<typeof networkDomain>>
  private readonly initialized: PromiseLike<unknown>
  private liveDomain: Domain<typeof networkDomain> | undefined
  private routerHandle!: DynamicProxyRouterHandle
  private activeGatewayUrl: string | null = null
  private activeSelectedNodeId: VpnNodeId | null = null
  private backgroundProbePromise: Promise<void> | null = null
  private parsedUserCustomRules: readonly RoutingRule[] = []
  private autoRefreshTimer: ReturnType<typeof setInterval> | null = null
  private autoRefreshRunning = false
  private chain: Promise<unknown> = Promise.resolve()
  private stopping = false

  /**
   * @param ctx - Host context owning `vpnTunnel`, `storageDomain`, `credentials`, and optional `llm`.
   * @param config - validated path, timeout, and diagnostic target settings.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'networkProxy')
    this.resolvedDshHome = resolveDshHome(config.dshHome)
    this.resolvedUserEnvPath = config.userEnvPath !== undefined
      ? resolve(config.userEnvPath)
      : join(homedir(), '.env')
    this.diagnosticTimeoutMs = config.diagnosticTimeoutMs ?? 8_000
    this.autoRefreshCheckIntervalMs = config.autoRefreshCheckIntervalMs ?? 60_000
    this.defaultProbeLimit = config.defaultProbeLimit ?? 64
    this.autoProbeOnActivate = config.autoProbeOnActivate ?? true
    this.diagnosticTargets = toDiagnosticSpecs(config.diagnosticTargets)

    this.cache = new EncryptedSubscriptionCache({
      cacheDir: dshCachePath({ dshHome: this.resolvedDshHome }, 'network-proxy'),
      resolveSecretKey: () => this.getOrCreateCacheSecretKey(),
    })

    ctx.inject(['llm'], (llmCtx) => {
      llmCtx.on('llm/stream', (options, next) =>
        this.streamLlmWithRouting(options, next, retryOptions => llmCtx.llm.stream(retryOptions)))
    })

    this.ready = ctx.storageDomain.open(networkDomain).then((domain) => {
      this.liveDomain = domain
      return domain
    })

    this.initialized = ctx.effect(async () => {
      const domain = await this.ready
      const routerHandle = await installDynamicProxyRouter({
        resolve: (url, trafficContext) => this.resolveDynamicRoute(domain, url, trafficContext),
        childProxyUrl: () => this.resolveChildProxyUrl(domain),
      })
      this.routerHandle = routerHandle

      await this.restoreCachedSubscriptions(domain)
      await this.applyStateToRuntime(domain)

      this.startAutoRefreshLoop()

      return async () => {
        this.stopping = true
        this.lifetime.abort(new Error('NetworkProxyService disposed'))
        this.stopAutoRefreshLoop()
        await this.chain
        await this.backgroundProbePromise
        await routerHandle.dispose()
        await this.ctx.vpnTunnel.stopGateway()
        this.liveDomain = undefined
        await domain.close()
      }
    })
  }

  async [Service.init](): Promise<void> {
    await this.initialized
  }

  /**
   * Return the loopback HTTP proxy URL (`http://127.0.0.1:<port>`) for Desktop Electron `<webview>` partitions,
   * or `null` when `direct` mode is active, `proxyBrowserGuests` is disabled, or no gateway is running.
   * @returns loopback proxy URL or `null`.
   */
  browserGuestProxyUrl(): string | null {
    const globalState = this.liveDomain?.global.get() ?? DEFAULT_NETWORK_GLOBAL
    if (globalState.mode === 'direct' || !globalState.proxyBrowserGuests) {
      return null
    }
    return this.ctx.vpnTunnel.state().gateway?.httpProxyUrl ?? null
  }

  /**
   * Read the complete redacted status snapshot including subscriptions, node telemetry, and discoverable `.env` candidates.
   * @returns current {@link NetworkProxyStatus}.
   */
  @Remote('status')
  async status(): Promise<NetworkProxyStatus> {
    const domain = await this.getDomain()
    return this.buildStatusSnapshot(domain)
  }

  /**
   * Switch outbound routing mode (`direct`, `smart`, or `global`) durably and start or stop the loopback gateway as needed.
   * @param request - target {@link NetworkProxyMode}.
   * @param signal - optional cancellation signal.
   * @returns updated {@link NetworkProxyStatus}.
   */
  @Remote('setMode')
  async setMode(request: SetNetworkModeRequest, signal?: AbortSignal): Promise<NetworkProxyStatus> {
    return this.serialize(async () => {
      const domain = await this.getDomain()
      signal?.throwIfAborted()
      const current = domain.global.get()
      const next: StoredNetworkGlobal = {
        ...current,
        mode: request.mode,
      }
      await domain.global.set(next)
      await this.applyStateToRuntime(domain)
      this.emitChanged()
      return this.buildStatusSnapshot(domain)
    })
  }

  /**
   * Update region-tier preferences, latency ceiling, subprocess/guest toggles, provider/capability overrides, or custom rules.
   * @param request - partial routing settings update.
   * @param signal - optional cancellation signal.
   * @returns updated {@link NetworkProxyStatus}.
   */
  @Remote('updateRouting')
  async updateRouting(request: UpdateNetworkRoutingRequest, signal?: AbortSignal): Promise<NetworkProxyStatus> {
    try {
      const validatedCeiling = request.maxPreferredLatencyMs !== undefined
        ? validateLatencyCeiling(request.maxPreferredLatencyMs)
        : undefined
      const parsedCustom = request.customRules !== undefined
        ? parseCustomRules(request.customRules, line => this.ctx.vpnTunnel.parseRuleLine(line))
        : undefined
      const normalizedProviders = request.providerOverrides !== undefined
        ? normalizeProviderOverrides(request.providerOverrides)
        : undefined
      const normalizedCapabilities = request.capabilityOverrides !== undefined
        ? normalizeCapabilityOverrides(request.capabilityOverrides)
        : undefined

      return await this.serialize(async () => {
        const domain = await this.getDomain()
        signal?.throwIfAborted()
        const current = domain.global.get()
        const next: StoredNetworkGlobal = {
          ...current,
          preferRegion: request.preferRegion !== undefined ? request.preferRegion.trim() : current.preferRegion,
          maxPreferredLatencyMs: validatedCeiling ?? current.maxPreferredLatencyMs,
          proxySubprocesses: request.proxySubprocesses ?? current.proxySubprocesses,
          proxyBrowserGuests: request.proxyBrowserGuests ?? current.proxyBrowserGuests,
          providerOverrides: normalizedProviders ?? current.providerOverrides,
          capabilityOverrides: normalizedCapabilities ?? current.capabilityOverrides,
          customRules: parsedCustom !== undefined ? parsedCustom.normalizedLines : current.customRules,
        }
        await domain.global.set(next)
        await this.applyStateToRuntime(domain)
        this.emitChanged()
        return this.buildStatusSnapshot(domain)
      })
    } catch (error: unknown) {
      throwRemoteInputIfInvalid(error)
    }
  }

  /**
   * Add a VPN subscription URL, store its secret URL in `ctx.credentials`, fetch & encrypt-cache its nodes, and activate it.
   * @param request - display label, secret URL, optional enabled toggle, and optional auto-refresh interval.
   * @param signal - optional cancellation signal.
   * @returns refresh outcome and updated {@link NetworkProxyStatus}.
   */
  @Remote('addSubscription')
  async addSubscription(request: AddSubscriptionRequest, signal?: AbortSignal): Promise<RefreshSubscriptionsResult> {
    try {
      const name = normalizeSubscriptionName(request.name)
      const normalizedUrl = normalizeSubscriptionUrl(request.url)
      const autoRefreshMinutes = validateRefreshMinutes(request.autoRefreshMinutes ?? DEFAULT_AUTO_REFRESH_MINUTES)
      const enabled = request.enabled ?? true
      const urlDigest = computeUrlDigest(normalizedUrl)

      return await this.serialize(async () => {
        const domain = await this.getDomain()
        signal?.throwIfAborted()
        const table = domain.table('subscriptions')
        for (const [, existing] of table.entries()) {
          if (existing.urlDigest === urlDigest) {
            throw new NetworkProxyInputError(
              'duplicate_subscription',
              `Subscription "${existing.name}" already uses this URL.`,
            )
          }
        }

        const id = generateSubscriptionId()
        const nowIso = new Date().toISOString()
        await this.storeSubscriptionSecretUrl(id, normalizedUrl)

        const initialRecord: StoredSubscriptionRecord = {
          id,
          name,
          maskedUrl: this.ctx.vpnTunnel.maskUrl(normalizedUrl),
          urlDigest,
          enabled,
          autoRefreshMinutes,
          nodeCount: 0,
          lastUpdatedAt: null,
          createdAt: nowIso,
          updatedAt: nowIso,
        }
        await table.put(id, initialRecord)

        const outcomes: SubscriptionRefreshOutcome[] = enabled
          ? [await this.refreshOneRecord(domain, initialRecord, normalizedUrl, signal)]
          : [{ id, name, ok: true, nodeCount: 0 }]

        await this.applyStateToRuntime(domain)
        this.emitChanged()
        return {
          outcomes,
          status: await this.buildStatusSnapshot(domain),
        }
      })
    } catch (error: unknown) {
      throwRemoteInputIfInvalid(error)
    }
  }

  /**
   * Update an existing subscription's name, URL, enabled state, or auto-refresh interval.
   * @param request - subscription ID and fields to revise.
   * @param signal - optional cancellation signal.
   * @returns updated {@link NetworkProxyStatus}.
   */
  @Remote('updateSubscription')
  async updateSubscription(request: UpdateSubscriptionRequest, signal?: AbortSignal): Promise<NetworkProxyStatus> {
    try {
      const nextName = request.name !== undefined ? normalizeSubscriptionName(request.name) : undefined
      const nextUrl = request.url !== undefined ? normalizeSubscriptionUrl(request.url) : undefined
      const nextRefresh = request.autoRefreshMinutes !== undefined
        ? validateRefreshMinutes(request.autoRefreshMinutes)
        : undefined

      return await this.serialize(async () => {
        const domain = await this.getDomain()
        signal?.throwIfAborted()
        const table = domain.table('subscriptions')
        const existing = table.get(request.id)
        if (existing === undefined) {
          throw new NetworkProxyInputError('subscription_not_found', 'Subscription was not found.')
        }

        let updatedUrlDigest = existing.urlDigest
        let updatedMaskedUrl = existing.maskedUrl
        if (nextUrl !== undefined) {
          updatedUrlDigest = computeUrlDigest(nextUrl)
          for (const [otherId, other] of table.entries()) {
            if (otherId !== request.id && other.urlDigest === updatedUrlDigest) {
              throw new NetworkProxyInputError(
                'duplicate_subscription',
                `Subscription "${other.name}" already uses this URL.`,
              )
            }
          }
          await this.storeSubscriptionSecretUrl(request.id, nextUrl)
          updatedMaskedUrl = this.ctx.vpnTunnel.maskUrl(nextUrl)
        }

        const nextEnabled = request.enabled ?? existing.enabled
        const updatedRecord: StoredSubscriptionRecord = {
          ...existing,
          name: nextName ?? existing.name,
          maskedUrl: updatedMaskedUrl,
          urlDigest: updatedUrlDigest,
          enabled: nextEnabled,
          autoRefreshMinutes: nextRefresh ?? existing.autoRefreshMinutes,
          updatedAt: new Date().toISOString(),
        }
        await table.put(request.id, updatedRecord)

        if (nextEnabled && (nextUrl !== undefined || (!existing.enabled && !this.parsedBySubscription.has(request.id)))) {
          await this.refreshEnabledSubscription(domain, updatedRecord, nextUrl, signal)
        }

        await this.applyStateToRuntime(domain)
        this.emitChanged()
        return this.buildStatusSnapshot(domain)
      })
    } catch (error: unknown) {
      throwRemoteInputIfInvalid(error)
    }
  }

  private async refreshEnabledSubscription(
    domain: Domain<typeof networkDomain>,
    record: StoredSubscriptionRecord,
    explicitUrl: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const resolvedUrl = explicitUrl ?? await this.readSubscriptionSecretUrl(record.id)
    if (resolvedUrl === null) return
    await this.refreshOneRecord(domain, record, resolvedUrl, signal)
  }

  /**
   * Remove a subscription, deleting its metadata row, `ctx.credentials` secret record, and encrypted cache file.
   * @param request - target subscription identifier.
   * @param signal - optional cancellation signal.
   * @returns removal flag and updated {@link NetworkProxyStatus}.
   */
  @Remote('removeSubscription')
  async removeSubscription(
    request: RemoveSubscriptionRequest,
    signal?: AbortSignal,
  ): Promise<RemoveSubscriptionResult & { readonly status: NetworkProxyStatus }> {
    return this.serialize(async () => {
      const domain = await this.getDomain()
      signal?.throwIfAborted()
      const removed = await domain.table('subscriptions').delete(request.id)
      this.parsedBySubscription.delete(request.id)
      await this.ctx.credentials.deleteRecord(subscriptionCredentialKey(request.id))
      await this.cache.delete(request.id)

      const currentGlobal = domain.global.get()
      if (currentGlobal.pinnedNodeId !== null) {
        const remainingIds = new Set(
          [...this.parsedBySubscription.values()].flatMap(sub => sub.nodes.map(node => node.id)),
        )
        if (!remainingIds.has(currentGlobal.pinnedNodeId)) {
          await domain.global.set({ ...currentGlobal, pinnedNodeId: null })
        }
      }

      await this.applyStateToRuntime(domain)
      if (removed) {
        this.emitChanged()
      }
      return {
        id: request.id,
        removed,
        status: await this.buildStatusSnapshot(domain),
      }
    })
  }

  /**
   * Refresh one subscription (`request.id`) or all enabled subscriptions, updating encrypted caches and active nodes.
   * @param request - optional single subscription filter.
   * @param signal - optional cancellation signal.
   * @returns per-subscription outcomes and updated {@link NetworkProxyStatus}.
   */
  @Remote('refreshSubscriptions')
  async refreshSubscriptions(
    request: RefreshSubscriptionsRequest,
    signal?: AbortSignal,
  ): Promise<RefreshSubscriptionsResult> {
    try {
      return await this.serialize(async () => {
        const domain = await this.getDomain()
        signal?.throwIfAborted()
        const table = domain.table('subscriptions')
        const targets: StoredSubscriptionRecord[] = []

        if (request.id !== undefined) {
          const single = table.get(request.id)
          if (single === undefined) {
            throw new NetworkProxyInputError('subscription_not_found', 'Subscription was not found.')
          }
          targets.push(single)
        } else {
          for (const [, record] of table.entries()) {
            if (record.enabled) targets.push(record)
          }
        }

        const outcomes: SubscriptionRefreshOutcome[] = []
        for (const record of targets) {
          signal?.throwIfAborted()
          const secretUrl = await this.readSubscriptionSecretUrl(record.id)
          if (secretUrl === null) {
            const missingMsg = 'Subscription credential is missing; re-enter the subscription URL.'
            await table.put(record.id, {
              ...record,
              lastError: missingMsg,
              updatedAt: new Date().toISOString(),
            })
            outcomes.push({
              id: record.id,
              name: record.name,
              ok: false,
              nodeCount: record.nodeCount,
              error: missingMsg,
            })
            continue
          }
          outcomes.push(await this.refreshOneRecord(domain, record, secretUrl, signal))
        }

        await this.applyStateToRuntime(domain)
        this.emitChanged()
        return {
          outcomes,
          status: await this.buildStatusSnapshot(domain),
        }
      })
    } catch (error: unknown) {
      throwRemoteInputIfInvalid(error)
    }
  }

  /**
   * Discover `SUB_VPN_*` and `VPN_SUB_*` URLs from `process.env`, `$DSH_HOME/.env`, and `~/.env`,
   * store new URLs in `ctx.credentials`, and fetch their initial node lists.
   * @param signal - optional cancellation signal.
   * @returns counts of imported/skipped candidates, fetch outcomes, and updated {@link NetworkProxyStatus}.
   */
  @Remote('importEnvSubscriptions')
  async importEnvSubscriptions(signal?: AbortSignal): Promise<ImportEnvSubscriptionsResult> {
    return this.serialize(async () => {
      const domain = await this.getDomain()
      signal?.throwIfAborted()
      const candidates = await this.discoverHostEnvCandidates()
      const table = domain.table('subscriptions')
      const knownDigests = new Set<string>()
      for (const [, existing] of table.entries()) {
        knownDigests.add(existing.urlDigest)
      }

      let importedCount = 0
      let skippedCount = 0
      const outcomes: SubscriptionRefreshOutcome[] = []

      for (const candidate of candidates) {
        signal?.throwIfAborted()
        let normalizedUrl: string
        try {
          normalizedUrl = normalizeSubscriptionUrl(candidate.url)
        } catch {
          skippedCount += 1
          continue
        }
        const digest = computeUrlDigest(normalizedUrl)
        if (knownDigests.has(digest)) {
          skippedCount += 1
          continue
        }

        knownDigests.add(digest)
        importedCount += 1
        const id = generateSubscriptionId()
        const nowIso = new Date().toISOString()
        await this.storeSubscriptionSecretUrl(id, normalizedUrl)

        const initialRecord: StoredSubscriptionRecord = {
          id,
          name: candidate.envKey,
          maskedUrl: candidate.maskedUrl,
          urlDigest: digest,
          enabled: true,
          autoRefreshMinutes: DEFAULT_AUTO_REFRESH_MINUTES,
          nodeCount: 0,
          lastUpdatedAt: null,
          envSource: candidate.source,
          envKey: candidate.envKey,
          createdAt: nowIso,
          updatedAt: nowIso,
        }
        await table.put(id, initialRecord)
        outcomes.push(await this.refreshOneRecord(domain, initialRecord, normalizedUrl, signal))
      }

      if (importedCount > 0) {
        await this.applyStateToRuntime(domain)
        this.emitChanged()
      }
      return {
        importedCount,
        skippedCount,
        outcomes,
        status: await this.buildStatusSnapshot(domain),
      }
    })
  }

  /**
   * Pin traffic to `request.nodeId`, or pass `null` to restore automatic region-tier and latency selection.
   * @param request - target node identifier or `null`.
   * @param signal - optional cancellation signal.
   * @returns updated {@link NetworkProxyStatus}.
   */
  @Remote('selectNode')
  async selectNode(request: SelectNetworkNodeRequest, signal?: AbortSignal): Promise<NetworkProxyStatus> {
    try {
      return await this.serialize(async () => {
        const domain = await this.getDomain()
        signal?.throwIfAborted()
        if (request.nodeId !== null) {
          const exists = this.ctx.vpnTunnel.state().nodes.some(node => node.nodeId === request.nodeId)
          if (!exists) {
            throw new NetworkProxyInputError('node_not_found', 'Requested proxy node is not loaded.')
          }
        }
        const current = domain.global.get()
        await domain.global.set({
          ...current,
          pinnedNodeId: request.nodeId,
        })
        this.ctx.vpnTunnel.selectNode(request.nodeId)
        await this.syncSelectedNodePool()
        this.emitChanged()
        return this.buildStatusSnapshot(domain)
      })
    } catch (error: unknown) {
      throwRemoteInputIfInvalid(error)
    }
  }

  /**
   * Benchmark candidate or subscription-filtered proxy nodes through the pure-TypeScript tunnel engine.
   * @param request - optional subscription filter, custom probe URL, and node count limit.
   * @param signal - optional cancellation signal.
   * @returns node probe results and updated {@link NetworkProxyStatus}.
   */
  @Remote('probeNodes')
  async probeNodes(
    request: ProbeNetworkNodesRequest,
    signal?: AbortSignal,
  ): Promise<ProbeNetworkNodesResult> {
    try {
      if (request.probeUrl !== undefined) {
        normalizeSubscriptionUrl(request.probeUrl)
      }
      const domain = await this.getDomain()
      const limit = request.limit ?? this.defaultProbeLimit
      const results = await this.ctx.vpnTunnel.probeNodes({
        ...(request.subscriptionId !== undefined ? { subscriptionId: request.subscriptionId } : {}),
        limit,
        ...(request.probeUrl !== undefined ? { probeUrl: request.probeUrl } : {}),
        ...(signal !== undefined ? { signal } : {}),
      })
      await this.syncSelectedNodePool()
      this.emitChanged()
      return {
        results,
        status: await this.buildStatusSnapshot(domain),
      }
    } catch (error: unknown) {
      throwRemoteInputIfInvalid(error)
    }
  }

  /**
   * Run concurrent end-to-end connectivity diagnostics across domestic and overseas endpoints using the active router.
   * @param signal - optional cancellation signal.
   * @returns structured {@link NetworkDiagnosticReport}.
   */
  @Remote('runDiagnostics')
  async runDiagnostics(signal?: AbortSignal): Promise<NetworkDiagnosticReport> {
    const domain = await this.getDomain()
    const globalState = domain.global.get()
    const tunnelState = this.ctx.vpnTunnel.state()
    const selectedNodeName = this.findSelectedNodeName(tunnelState)
    const combinedSignal = signal !== undefined
      ? AbortSignal.any([this.lifetime.signal, signal])
      : this.lifetime.signal

    return runConnectivityDiagnostics({
      mode: globalState.mode,
      selectedNodeName,
      targets: this.diagnosticTargets,
      timeoutMs: this.diagnosticTimeoutMs,
      evaluateRoute: (url, trafficContext) => this.evaluateDiagnosticRoute(globalState, url, trafficContext),
      redactError: error => this.ctx.vpnTunnel.redactError(error),
      signal: combinedSignal,
    })
  }

  private findSelectedNodeName(tunnelState: ReturnType<Context['vpnTunnel']['state']>): string | null {
    return tunnelState.nodes.find(item => item.nodeId === tunnelState.selectedNodeId)?.name ?? null
  }

  private evaluateDiagnosticRoute(
    globalState: StoredNetworkGlobal,
    url: URL,
    context: TrafficContext | undefined,
  ): EvaluatedDiagnosticRoute {
    if (isPrivateNetworkHost(url.hostname) || globalState.mode === 'direct') {
      return { route: 'direct' }
    }
    const tunnelState = this.ctx.vpnTunnel.state()
    if (tunnelState.gateway === null) {
      return { route: 'direct' }
    }
    const nodeName = this.findSelectedNodeName(tunnelState) as string

    if (globalState.mode === 'smart') {
      const override = this.lookupTrafficOverride(globalState, context)
      if (override === 'direct') return { route: 'direct' }
      if (override === 'proxy') return { route: 'proxy', nodeName }
    }

    const decision = this.ctx.vpnTunnel.decideRoute(url.hostname, globalState.mode)
    if (decision.action === 'reject') return { route: 'reject' }
    if (decision.action === 'direct') return { route: 'direct' }
    return { route: 'proxy', nodeName }
  }

  private resolveDynamicRoute(
    domain: Domain<typeof networkDomain>,
    url: URL,
    context: TrafficContext | undefined,
  ): DynamicProxyDecision {
    if (isPrivateNetworkHost(url.hostname)) {
      return { kind: 'direct' }
    }
    const globalState = domain.global.get()
    if (globalState.mode === 'direct') {
      return { kind: 'fallback' }
    }

    const gateway = this.ctx.vpnTunnel.state().gateway
    if (gateway === null) {
      return { kind: 'fallback' }
    }

    if (globalState.mode === 'smart') {
      const override = this.lookupTrafficOverride(globalState, context)
      if (override === 'direct') return { kind: 'direct' }
      if (override === 'proxy') {
        return {
          kind: 'proxy',
          proxyUrl: gateway.httpProxyUrl.replace('http://', 'http://force-proxy:1@'),
        }
      }
    }

    const decision = this.ctx.vpnTunnel.decideRoute(url.hostname, globalState.mode)
    if (decision.action === 'direct') {
      return { kind: 'direct' }
    }
    return { kind: 'proxy', proxyUrl: gateway.httpProxyUrl }
  }

  private lookupTrafficOverride(
    globalState: StoredNetworkGlobal,
    context: TrafficContext | undefined,
  ): 'direct' | 'proxy' | null {
    if (context === undefined) return null
    if (context.category === 'llm' && context.providerId !== undefined) {
      const providerPolicy = globalState.providerOverrides[context.providerId]
      return providerPolicy === 'direct' || providerPolicy === 'proxy' ? providerPolicy : null
    }
    if (
      context.category === 'web'
      || context.category === 'mcp'
      || context.category === 'plugin'
      || context.category === 'embedding'
    ) {
      const capPolicy = globalState.capabilityOverrides[context.category]
      return capPolicy === 'direct' || capPolicy === 'proxy' ? capPolicy : null
    }
    return null
  }

  private resolveChildProxyUrl(domain: Domain<typeof networkDomain>): string | undefined {
    const globalState = domain.global.get()
    if (globalState.mode === 'direct' || !globalState.proxySubprocesses) {
      return undefined
    }
    return this.ctx.vpnTunnel.state().gateway?.httpProxyUrl ?? undefined
  }

  private async restoreCachedSubscriptions(domain: Domain<typeof networkDomain>): Promise<void> {
    const records = [...domain.table('subscriptions').entries()].map(([, row]) => row)
    await Promise.all(records.map(async (record) => {
      if (!record.enabled) return
      const cached = await this.cache.read(record.id)
      if (cached !== null) {
        this.parsedBySubscription.set(record.id, cached)
      }
    }))
  }

  private async applyStateToRuntime(domain: Domain<typeof networkDomain>): Promise<void> {
    const globalState = domain.global.get()
    const orderedSubscriptions: ParsedSubscription[] = []
    for (const [, record] of domain.table('subscriptions').entries()) {
      if (!record.enabled) continue
      const parsed = this.parsedBySubscription.get(record.id)
      if (parsed !== undefined) {
        orderedSubscriptions.push(parsed)
      }
    }

    this.parsedUserCustomRules = parseCustomRules(
      globalState.customRules,
      line => this.ctx.vpnTunnel.parseRuleLine(line),
    ).rules

    const effectiveCustomRules = globalState.mode === 'smart'
      ? [...this.parsedUserCustomRules, ...SMART_DOMESTIC_BASELINE_RULES]
      : this.parsedUserCustomRules

    this.ctx.vpnTunnel.setSubscriptions(orderedSubscriptions)
    this.ctx.vpnTunnel.setRoutingPolicy({
      gatewayMode: globalState.mode === 'global' ? 'global' : 'smart',
      preferRegion: globalState.preferRegion,
      maxPreferredLatencyMs: globalState.maxPreferredLatencyMs,
      customRules: effectiveCustomRules,
    })
    this.ctx.vpnTunnel.selectNode(globalState.pinnedNodeId)

    const hasNodes = orderedSubscriptions.some(sub => sub.nodes.length > 0)
    if (globalState.mode !== 'direct' && hasNodes) {
      const endpoint = await this.ctx.vpnTunnel.ensureGateway()
      if (this.activeGatewayUrl !== null && this.activeGatewayUrl !== endpoint.httpProxyUrl) {
        await this.evictGatewayAgents(this.activeGatewayUrl)
      }
      this.activeGatewayUrl = endpoint.httpProxyUrl
      await this.syncSelectedNodePool()
      this.scheduleInitialNodeProbe()
    } else {
      const previousUrl = this.activeGatewayUrl
      this.activeGatewayUrl = null
      this.activeSelectedNodeId = null
      await this.ctx.vpnTunnel.stopGateway()
      if (previousUrl !== null) {
        await this.evictGatewayAgents(previousUrl)
      }
    }
  }

  private async evictGatewayAgents(gatewayHttpUrl: string): Promise<void> {
    const forcedUrl = gatewayHttpUrl.replace('http://', 'http://force-proxy:1@')
    await Promise.all([
      this.routerHandle.evictProxy(gatewayHttpUrl),
      this.routerHandle.evictProxy(forcedUrl),
    ])
  }

  private async syncSelectedNodePool(): Promise<void> {
    const nextSelectedNodeId = this.ctx.vpnTunnel.state().selectedNodeId
    const changed = this.activeSelectedNodeId !== null && this.activeSelectedNodeId !== nextSelectedNodeId
    this.activeSelectedNodeId = nextSelectedNodeId
    if (changed && this.activeGatewayUrl !== null) {
      await this.evictGatewayAgents(this.activeGatewayUrl)
    }
  }

  private scheduleInitialNodeProbe(): void {
    if (!this.autoProbeOnActivate || this.backgroundProbePromise !== null) {
      return
    }
    const unprobedIds = this.ctx.vpnTunnel
      .state()
      .nodes
      .filter(node => node.latencyMs === null && node.totalSuccesses === 0 && node.totalFailures === 0)
      .map(node => node.nodeId)
      .slice(0, this.defaultProbeLimit)
    if (unprobedIds.length === 0) {
      return
    }
    const task = (async () => {
      try {
        await this.ctx.vpnTunnel.probeNodes({
          nodeIds: unprobedIds,
          signal: this.lifetime.signal,
        })
        if (!this.stopping) {
          await this.syncSelectedNodePool()
          this.emitChanged()
        }
      } finally {
        this.backgroundProbePromise = null
      }
    })()
    this.backgroundProbePromise = task
  }

  private streamLlmWithRouting(
    options: GenerateOptions,
    next: () => AsyncIterable<StreamChunk>,
    retryStream: (options: GenerateOptions) => AsyncIterable<StreamChunk>,
  ): AsyncIterable<StreamChunk> {
    return streamWithTrafficContext(
      { category: 'llm', providerId: options.provider },
      () => this.streamLlmWithGeoFailover(options, next, retryStream),
    )
  }

  private resolveAutoRotateGatewayUrl(providerId: string): string | null {
    const globalState = this.liveDomain?.global.get() ?? DEFAULT_NETWORK_GLOBAL
    if (globalState.mode === 'direct' || globalState.pinnedNodeId !== null) {
      return null
    }
    if (globalState.mode === 'smart' && globalState.providerOverrides[providerId] === 'direct') {
      return null
    }
    return this.ctx.vpnTunnel.state().gateway?.httpProxyUrl ?? null
  }

  private async * streamLlmWithGeoFailover(
    options: GenerateOptions,
    next: () => AsyncIterable<StreamChunk>,
    retryStream: (options: GenerateOptions) => AsyncIterable<StreamChunk>,
  ): AsyncGenerator<StreamChunk, void, undefined> {
    const maxRetries = 2
    const depth = this.llmGeoRetryDepths.get(options) ?? 0
    const gatewayUrl = this.resolveAutoRotateGatewayUrl(options.provider)
    const candidateBefore = gatewayUrl !== null
      ? this.ctx.vpnTunnel.state().selectedNodeId
      : null
    let emittedContent = false
    let rotated = false
    const bufferedUsage: StreamChunk[] = []

    for await (const chunk of next()) {
      if (!emittedContent && chunk.type === 'usage') {
        bufferedUsage.push(chunk)
        continue
      }
      if (
        !emittedContent
        && depth < maxRetries
        && gatewayUrl !== null
        && candidateBefore !== null
        && !options.signal?.aborted
        && isUpstreamGeoRestrictionChunk(chunk)
      ) {
        const rejectedNodeId = this.ctx.vpnTunnel.state().lastRoutedNodeId ?? candidateBefore
        this.ctx.vpnTunnel.penalizeNode(
          rejectedNodeId,
          'Upstream API rejected node region; switched node automatically',
        )
        const nextSelected = this.ctx.vpnTunnel.state().selectedNodeId
        this.activeSelectedNodeId = nextSelected
        await this.evictGatewayAgents(gatewayUrl)
        this.emitChanged()
        if (nextSelected !== null && nextSelected !== rejectedNodeId) {
          rotated = true
          break
        }
      }
      for (const usageChunk of bufferedUsage) {
        yield usageChunk
      }
      bufferedUsage.length = 0
      if (chunk.type !== 'finish') {
        emittedContent = true
      }
      yield chunk
    }

    if (rotated) {
      this.llmGeoRetryDepths.set(options, depth + 1)
      try {
        yield* retryStream(options)
      } finally {
        if (depth === 0) {
          this.llmGeoRetryDepths.delete(options)
        }
      }
    }
  }

  private async refreshOneRecord(
    domain: Domain<typeof networkDomain>,
    record: StoredSubscriptionRecord,
    secretUrl: string,
    signal?: AbortSignal,
  ): Promise<SubscriptionRefreshOutcome> {
    const table = domain.table('subscriptions')
    try {
      const parsed = await this.ctx.vpnTunnel.fetchSubscription(secretUrl, record.id, signal)
      this.parsedBySubscription.set(record.id, parsed)
      await this.cache.write(record.id, parsed)
      const nowIso = new Date().toISOString()
      const updatedRecord: StoredSubscriptionRecord = {
        id: record.id,
        name: record.name,
        maskedUrl: record.maskedUrl,
        urlDigest: record.urlDigest,
        enabled: record.enabled,
        autoRefreshMinutes: record.autoRefreshMinutes,
        nodeCount: parsed.nodes.length,
        lastUpdatedAt: nowIso,
        ...(parsed.userInfo !== undefined ? { userInfo: parsed.userInfo } : {}),
        ...(record.envSource !== undefined ? { envSource: record.envSource } : {}),
        ...(record.envKey !== undefined ? { envKey: record.envKey } : {}),
        createdAt: record.createdAt,
        updatedAt: nowIso,
      }
      await table.put(record.id, updatedRecord)
      return {
        id: record.id,
        name: record.name,
        ok: true,
        nodeCount: parsed.nodes.length,
      }
    } catch (error: unknown) {
      const redacted = this.ctx.vpnTunnel.redactError(error)
      const nowIso = new Date().toISOString()
      const cachedCount = this.parsedBySubscription.get(record.id)?.nodes.length ?? record.nodeCount
      await table.put(record.id, {
        ...record,
        nodeCount: cachedCount,
        lastError: redacted,
        updatedAt: nowIso,
      })
      return {
        id: record.id,
        name: record.name,
        ok: false,
        nodeCount: cachedCount,
        error: redacted,
      }
    }
  }

  private async discoverHostEnvCandidates() {
    const dshEnvPath = join(this.resolvedDshHome, '.env')
    const [dshEnvText, userEnvText] = await Promise.all([
      readOptionalTextFile(dshEnvPath),
      this.resolvedUserEnvPath === dshEnvPath ? Promise.resolve(null) : readOptionalTextFile(this.resolvedUserEnvPath),
    ])
    const fileLayers: { readonly source: 'dsh-env' | 'user-env'; readonly content: string }[] = []
    if (dshEnvText !== null) {
      fileLayers.push({ source: 'dsh-env', content: dshEnvText })
    }
    if (userEnvText !== null) {
      fileLayers.push({ source: 'user-env', content: userEnvText })
    }
    return this.ctx.vpnTunnel.discoverEnvSubscriptions(process.env, fileLayers)
  }

  private async buildStatusSnapshot(domain: Domain<typeof networkDomain>): Promise<NetworkProxyStatus> {
    const globalState = domain.global.get()
    const tunnelState = this.ctx.vpnTunnel.state()
    const subscriptions = [...domain.table('subscriptions').entries()]
      .map(([, record]) => record)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    const configuredDigests = new Set(subscriptions.map(item => item.urlDigest))
    const rawCandidates = await this.discoverHostEnvCandidates()
    const ambientEnvCandidates: AmbientEnvSubscriptionPreview[] = rawCandidates.map(candidate => ({
      envKey: candidate.envKey,
      source: candidate.source,
      maskedUrl: candidate.maskedUrl,
      alreadyImported: configuredDigests.has(computeUrlDigest(candidate.url.trim())),
    }))

    return {
      mode: globalState.mode,
      routing: toRoutingSettings(globalState),
      subscriptions: subscriptions.map(toSubscriptionSummary),
      gateway: tunnelState.gateway,
      nodes: tunnelState.nodes,
      selectedNodeId: tunnelState.selectedNodeId,
      pinnedNodeId: tunnelState.pinnedNodeId,
      ambientEnvCandidates,
    }
  }

  private startAutoRefreshLoop(): void {
    this.stopAutoRefreshLoop()
    const timer = setInterval(() => {
      void this.triggerDueBackgroundRefresh()
    }, this.autoRefreshCheckIntervalMs)
    timer.unref()
    this.autoRefreshTimer = timer
  }

  private stopAutoRefreshLoop(): void {
    if (this.autoRefreshTimer !== null) {
      clearInterval(this.autoRefreshTimer)
      this.autoRefreshTimer = null
    }
  }

  private async triggerDueBackgroundRefresh(): Promise<void> {
    const domain = this.liveDomain
    if (this.stopping || this.autoRefreshRunning || domain === undefined) return
    this.autoRefreshRunning = true
    try {
      await this.serialize(async () => {
        const nowMs = Date.now()
        let changed = false
        for (const [, record] of domain.table('subscriptions').entries()) {
          if (!record.enabled) continue
          const missingParsed = !this.parsedBySubscription.has(record.id)
          const intervalMs = record.autoRefreshMinutes * 60_000
          const lastMs = record.lastUpdatedAt !== null ? Date.parse(record.lastUpdatedAt) : 0
          const isDue = missingParsed || (intervalMs > 0 && nowMs - lastMs >= intervalMs)
          if (!isDue) continue

          const secretUrl = await this.readSubscriptionSecretUrl(record.id)
          if (secretUrl === null) continue
          await this.refreshOneRecord(domain, record, secretUrl, this.lifetime.signal)
          changed = true
        }
        if (changed) {
          await this.applyStateToRuntime(domain)
          this.emitChanged()
        }
      })
    } catch (error: unknown) {
      this.ctx.logger.warn(`network-proxy: background subscription refresh failed: ${this.ctx.vpnTunnel.redactError(error)}`)
    } finally {
      this.autoRefreshRunning = false
    }
  }

  private async storeSubscriptionSecretUrl(id: VpnSubscriptionId, url: string): Promise<void> {
    await this.ctx.credentials.modifyRecord(
      subscriptionCredentialKey(id),
      () => Promise.resolve({ kind: 'api-key', key: url }),
    )
  }

  private async readSubscriptionSecretUrl(id: VpnSubscriptionId): Promise<string | null> {
    const key = readApiKeyValue(await this.ctx.credentials.readRecord(subscriptionCredentialKey(id)))
    return key !== undefined && key.length > 0 ? key : null
  }

  private async getOrCreateCacheSecretKey(): Promise<Buffer> {
    const keyAddress = cacheEncryptionCredentialKey()
    const committed = await this.ctx.credentials.modifyRecord(keyAddress, (current) => {
      const existingKey = readApiKeyValue(current)
      if (existingKey !== undefined && Buffer.from(existingKey, 'base64url').length === 32) {
        return Promise.resolve(undefined)
      }
      return Promise.resolve({
        kind: 'api-key',
        key: randomBytes(32).toString('base64url'),
      })
    })
    const committedKey = readApiKeyValue(committed)
    if (committedKey === undefined) {
      throw new Error('network-proxy: failed to initialize 256-bit cache encryption key in credentials')
    }
    return Buffer.from(committedKey, 'base64url')
  }

  private emitChanged(): void {
    try {
      this.ctx.emit('network-proxy/changed')
    } catch (error: unknown) {
      this.ctx.logger.warn(`network-proxy: network-proxy/changed listener failed: ${String(error)}`)
    }
  }

  private async getDomain(): Promise<Domain<typeof networkDomain>> {
    await this.initialized
    return this.ready
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    if (this.stopping) return Promise.reject(new Error('NetworkProxyService is stopping'))
    const pending = this.chain.then(work)
    this.chain = pending.catch(() => undefined)
    return pending
  }
}

function readApiKeyValue(record: CredentialRecord | undefined): string | undefined {
  return record?.kind === 'api-key' ? record.key : undefined
}

export default NetworkProxyService
