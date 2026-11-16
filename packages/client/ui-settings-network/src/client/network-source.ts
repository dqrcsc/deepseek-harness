/**
 * React-free observable store and command controller over `ctx.remote.networkProxy`.
 * @module @deepseek-ai/dsh-client-ui-settings-network/client/network-source
 */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  AddSubscriptionRequest,
  ImportEnvSubscriptionsResult,
  NetworkDiagnosticReport,
  NetworkProxyMode,
  NetworkProxyStatus,
  NodeHealthSnapshot,
  ProbeNetworkNodesRequest,
  ProbeNetworkNodesResult,
  RefreshSubscriptionsRequest,
  RefreshSubscriptionsResult,
  RemoveSubscriptionResult,
  SubscriptionUserInfo,
  UpdateNetworkRoutingRequest,
  UpdateSubscriptionRequest,
  VpnNodeId,
  VpnSubscriptionId,
} from '@deepseek-ai/dsh-network-proxy/client'

const DEFAULT_ROUTING_SNAPSHOT: NetworkProxyStatus['routing'] = Object.freeze({
  preferRegion: '新加坡|日本|美国, 台湾',
  maxPreferredLatencyMs: 4_000,
  proxySubprocesses: true,
  proxyBrowserGuests: true,
  providerOverrides: {},
  capabilityOverrides: {},
  customRules: [],
})

/** Default initial status snapshot before the first Host response settles. */
export const EMPTY_NETWORK_STATUS: NetworkProxyStatus = Object.freeze({
  mode: 'direct',
  routing: DEFAULT_ROUTING_SNAPSHOT,
  subscriptions: [],
  gateway: null,
  nodes: [],
  selectedNodeId: null,
  pinnedNodeId: null,
  ambientEnvCandidates: [],
})

/** Immutable browser view state published to Settings and sidebar subscribers. */
export interface NetworkProxyViewSnapshot {
  /** True after the initial `networkProxy/status` read completes or fails. */
  readonly settled: boolean
  /** True while a status read or configuration mutation is in flight. */
  readonly loading: boolean
  /** True while `probeNodes` is benchmarking tunnel latency. */
  readonly probing: boolean
  /** True while `runDiagnostics` is testing representative endpoints. */
  readonly diagnosing: boolean
  /** Latest redacted error message from a failed operation, or `null`. */
  readonly error: string | null
  /** Current Host `NetworkProxyStatus` projection. */
  readonly status: NetworkProxyStatus
  /** Latest 1-click connectivity diagnostic matrix report, or `null`. */
  readonly diagnostics: NetworkDiagnosticReport | null
}

/** Remote operations and event subscriptions injected from `apply(ctx)`. */
export interface NetworkProxyRemoteDeps {
  readonly status: () => Promise<NetworkProxyStatus>
  readonly setMode: (mode: NetworkProxyMode) => Promise<NetworkProxyStatus>
  readonly importEnvSubscriptions: () => Promise<ImportEnvSubscriptionsResult>
  readonly addSubscription: (request: AddSubscriptionRequest) => Promise<RefreshSubscriptionsResult>
  readonly updateSubscription: (request: UpdateSubscriptionRequest) => Promise<NetworkProxyStatus>
  readonly removeSubscription: (
    id: VpnSubscriptionId,
  ) => Promise<RemoveSubscriptionResult & { readonly status: NetworkProxyStatus }>
  readonly refreshSubscriptions: (request: RefreshSubscriptionsRequest) => Promise<RefreshSubscriptionsResult>
  readonly updateRouting: (request: UpdateNetworkRoutingRequest) => Promise<NetworkProxyStatus>
  readonly selectNode: (nodeId: VpnNodeId | null) => Promise<NetworkProxyStatus>
  readonly probeNodes: (request: ProbeNetworkNodesRequest) => Promise<ProbeNetworkNodesResult>
  readonly runDiagnostics: () => Promise<NetworkDiagnosticReport>
  readonly subscribeChanged: (listener: () => void) => () => void
  readonly subscribeReset: (listener: () => void) => () => void
}

/** Shared browser controller exposing `hooks.network` and typed actions. */
export interface NetworkProxyController {
  readonly hooks: {
    readonly network: HostObservable<NetworkProxyViewSnapshot>
  }
  readonly clearError: () => void
  readonly refresh: () => Promise<boolean>
  readonly setMode: (mode: NetworkProxyMode) => Promise<boolean>
  readonly importEnv: () => Promise<boolean>
  readonly addSubscription: (request: AddSubscriptionRequest) => Promise<boolean>
  readonly updateSubscription: (request: UpdateSubscriptionRequest) => Promise<boolean>
  readonly removeSubscription: (id: VpnSubscriptionId) => Promise<boolean>
  readonly refreshSubscriptions: (id?: VpnSubscriptionId) => Promise<boolean>
  readonly updateRouting: (request: UpdateNetworkRoutingRequest) => Promise<boolean>
  readonly selectNode: (nodeId: VpnNodeId | null) => Promise<boolean>
  readonly probeNodes: (request?: ProbeNetworkNodesRequest) => Promise<boolean>
  readonly runDiagnostics: () => Promise<boolean>
}

/**
 * Format optional byte-level subscription quota counters as fixed 2-decimal GiB strings.
 * @param userInfo - optional `Subscription-Userinfo` counters.
 * @returns formatted `{ usedGib, totalGib }`, or `null` when total quota is absent or zero.
 */
export function formatByteQuota(
  userInfo: SubscriptionUserInfo | undefined,
): { readonly usedGib: string; readonly totalGib: string } | null {
  if (userInfo === undefined || userInfo.totalBytes === undefined || userInfo.totalBytes <= 0) {
    return null
  }
  const usedBytes = (userInfo.uploadBytes ?? 0) + (userInfo.downloadBytes ?? 0)
  const gib = 1024 ** 3
  return {
    usedGib: (usedBytes / gib).toFixed(2),
    totalGib: (userInfo.totalBytes / gib).toFixed(2),
  }
}

/**
 * Resolve the currently active `NodeHealthSnapshot` from `status`, if any.
 * @param status - current Host proxy status snapshot.
 * @returns matching node health record or `null`.
 */
export function findSelectedNode(status: NetworkProxyStatus): NodeHealthSnapshot | null {
  if (status.selectedNodeId === null) return null
  return status.nodes.find(node => node.nodeId === status.selectedNodeId) ?? null
}

function extractErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Create a lazy-subscribing observable store and command controller over `ctx.remote.networkProxy`.
 * @param deps - Host RPC delegates and invalidation event subscriptions.
 * @returns {@link NetworkProxyController} shared by `settings.section` and `sidebar.footer.action`.
 */
export function createNetworkProxySource(deps: NetworkProxyRemoteDeps): NetworkProxyController {
  let state: NetworkProxyViewSnapshot = {
    settled: false,
    loading: false,
    probing: false,
    diagnosing: false,
    error: null,
    status: EMPTY_NETWORK_STATUS,
    diagnostics: null,
  }
  let generation = 0
  let unwatchChanged: (() => void) | null = null
  let unwatchReset: (() => void) | null = null
  const listeners = new Set<() => void>()

  const publish = (patch: Partial<NetworkProxyViewSnapshot>): void => {
    state = { ...state, ...patch }
    for (const listener of listeners) listener()
  }

  const runStatusCall = async (
    op: () => Promise<NetworkProxyStatus>,
    clearErrorBefore: boolean,
  ): Promise<boolean> => {
    const gen = ++generation
    publish(clearErrorBefore ? { loading: true, error: null } : { loading: true })
    try {
      const status = await op()
      if (gen !== generation) return true
      publish({ settled: true, loading: false, error: null, status })
      return true
    } catch (err: unknown) {
      if (gen !== generation) return false
      publish({ settled: true, loading: false, error: extractErrorMessage(err) })
      return false
    }
  }

  const refresh = (): Promise<boolean> => runStatusCall(deps.status, false)
  const runStatusMutation = (op: () => Promise<NetworkProxyStatus>): Promise<boolean> =>
    runStatusCall(op, true)

  const startWatching = (): void => {
    unwatchChanged = deps.subscribeChanged(() => {
      void refresh()
    })
    unwatchReset = deps.subscribeReset(() => {
      void refresh()
    })
    void refresh()
  }

  const stopWatching = (): void => {
    generation += 1
    unwatchChanged?.()
    unwatchChanged = null
    unwatchReset?.()
    unwatchReset = null
  }

  const observable: HostObservable<NetworkProxyViewSnapshot> = {
    getSnapshot: () => state,
    subscribe: (listener) => {
      const wasEmpty = listeners.size === 0
      listeners.add(listener)
      if (wasEmpty) startWatching()
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) stopWatching()
      }
    },
  }

  return {
    hooks: { network: observable },
    clearError: () => {
      publish({ error: null })
    },
    refresh,
    setMode: mode => runStatusMutation(() => deps.setMode(mode)),
    importEnv: () => runStatusMutation(async () => {
      const result = await deps.importEnvSubscriptions()
      return result.status
    }),
    addSubscription: request => runStatusMutation(async () => {
      const result = await deps.addSubscription(request)
      return result.status
    }),
    updateSubscription: request => runStatusMutation(() => deps.updateSubscription(request)),
    removeSubscription: id => runStatusMutation(async () => {
      const result = await deps.removeSubscription(id)
      return result.status
    }),
    refreshSubscriptions: id => runStatusMutation(async () => {
      const req: RefreshSubscriptionsRequest = id === undefined ? {} : { id }
      const result = await deps.refreshSubscriptions(req)
      return result.status
    }),
    updateRouting: request => runStatusMutation(() => deps.updateRouting(request)),
    selectNode: nodeId => runStatusMutation(() => deps.selectNode(nodeId)),
    probeNodes: async (request = {}): Promise<boolean> => {
      const gen = ++generation
      publish({ probing: true, error: null })
      try {
        const result = await deps.probeNodes(request)
        if (gen !== generation) return true
        publish({ settled: true, probing: false, error: null, status: result.status })
        return true
      } catch (err: unknown) {
        if (gen !== generation) return false
        publish({ probing: false, error: extractErrorMessage(err) })
        return false
      }
    },
    runDiagnostics: async (): Promise<boolean> => {
      publish({ diagnosing: true, error: null })
      try {
        const diagnostics = await deps.runDiagnostics()
        publish({ diagnosing: false, error: null, diagnostics })
        return true
      } catch (err: unknown) {
        publish({ diagnosing: false, error: extractErrorMessage(err) })
        return false
      }
    },
  }
}
