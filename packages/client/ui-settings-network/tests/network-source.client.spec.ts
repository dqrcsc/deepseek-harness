// @vitest-environment jsdom
/**
 * Unit tests for `createNetworkProxySource`, `formatByteQuota`, and `findSelectedNode`.
 */

import { describe, expect, it, vi } from 'vitest'
import type {
  NetworkDiagnosticReport,
  NetworkProxyMode,
  NetworkProxyStatus,
  VpnNodeId,
  VpnSubscriptionId,
} from '@deepseek-ai/dsh-network-proxy/client'
import {
  createNetworkProxySource,
  EMPTY_NETWORK_STATUS,
  findSelectedNode,
  formatByteQuota,
  type NetworkProxyRemoteDeps,
} from '../src/client/network-source.ts'

const SUB_1 = 'sub-alpha' as VpnSubscriptionId
const NODE_1 = 'node-us-1' as VpnNodeId
const NODE_2 = 'node-sg-1' as VpnNodeId

function makeStatus(overrides: Partial<NetworkProxyStatus> = {}): NetworkProxyStatus {
  return {
    ...EMPTY_NETWORK_STATUS,
    ...overrides,
  }
}

describe('network-source helpers and controller', () => {
  it('formats byte quotas and resolves selected nodes across edge cases', () => {
    expect(formatByteQuota(undefined)).toBeNull()
    expect(formatByteQuota({})).toBeNull()
    expect(formatByteQuota({ totalBytes: 0 })).toBeNull()
    expect(formatByteQuota({ totalBytes: 1024 ** 3 })).toEqual({
      usedGib: '0.00',
      totalGib: '1.00',
    })
    expect(
      formatByteQuota({
        uploadBytes: 512 * 1024 ** 2,
        downloadBytes: 1536 * 1024 ** 2,
        totalBytes: 10 * 1024 ** 3,
      }),
    ).toEqual({
      usedGib: '2.00',
      totalGib: '10.00',
    })

    expect(findSelectedNode(EMPTY_NETWORK_STATUS)).toBeNull()
    expect(findSelectedNode(makeStatus({ selectedNodeId: NODE_1, nodes: [] }))).toBeNull()
    const matched = findSelectedNode(
      makeStatus({
        selectedNodeId: NODE_2,
        nodes: [
          {
            nodeId: NODE_1,
            name: 'US-01',
            protocol: 'ss2022',
            subscriptionId: SUB_1,
            latencyMs: 80,
            consecutiveFailures: 0,
            circuitOpenUntilMs: null,
            activeConnections: 0,
            totalSuccesses: 1,
            totalFailures: 0,
          },
          {
            nodeId: NODE_2,
            name: 'SG-01',
            protocol: 'vless',
            subscriptionId: SUB_1,
            latencyMs: 45,
            consecutiveFailures: 0,
            circuitOpenUntilMs: null,
            activeConnections: 0,
            totalSuccesses: 1,
            totalFailures: 0,
          },
        ],
      }),
    )
    expect(matched?.name).toBe('SG-01')
  })

  it('subscribes lazily, handles mutations & errors, and discards stale epochs after teardown', async () => {
    let onChanged: (() => void) | undefined
    let onReset: (() => void) | undefined
    const offChanged = vi.fn()
    const offReset = vi.fn()

    const smartStatus = makeStatus({
      mode: 'smart',
      gateway: {
        host: '127.0.0.1',
        port: 17890,
        httpProxyUrl: 'http://127.0.0.1:17890',
        socksProxyUrl: 'socks5://127.0.0.1:17890',
      },
    })

    const diagReport: NetworkDiagnosticReport = {
      checkedAt: '2026-11-16T00:00:00.000Z',
      mode: 'smart',
      selectedNodeName: 'SG-01',
      targets: [
        {
          id: 'deepseek',
          label: 'DeepSeek',
          url: 'https://api.deepseek.com/models',
          route: 'direct',
          ok: true,
          statusCode: 200,
          latencyMs: 28,
        },
      ],
    }

    const deps: NetworkProxyRemoteDeps = {
      status: vi.fn(async () => smartStatus),
      setMode: vi.fn(async (mode: NetworkProxyMode) => makeStatus({ mode })),
      importEnvSubscriptions: vi.fn(async () => ({
        importedCount: 1,
        skippedCount: 0,
        outcomes: [],
        status: smartStatus,
      })),
      addSubscription: vi.fn(async () => ({ outcomes: [], status: smartStatus })),
      updateSubscription: vi.fn(async () => smartStatus),
      removeSubscription: vi.fn(async (id: VpnSubscriptionId) => ({ id, removed: true, status: EMPTY_NETWORK_STATUS })),
      refreshSubscriptions: vi.fn(async () => ({ outcomes: [], status: smartStatus })),
      updateRouting: vi.fn(async () => smartStatus),
      selectNode: vi.fn(async (nodeId: VpnNodeId | null) => makeStatus({ pinnedNodeId: nodeId, selectedNodeId: nodeId })),
      probeNodes: vi.fn(async () => ({ results: [], status: smartStatus })),
      runDiagnostics: vi.fn(async () => diagReport),
      subscribeChanged: vi.fn((cb: () => void) => {
        onChanged = cb
        return offChanged
      }),
      subscribeReset: vi.fn((cb: () => void) => {
        onReset = cb
        return offReset
      }),
    }

    const ctrl = createNetworkProxySource(deps)
    expect(ctrl.hooks.network.getSnapshot().settled).toBe(false)
    expect(deps.status).not.toHaveBeenCalled()

    const listenerA = vi.fn()
    const listenerB = vi.fn()
    const unsubA = ctrl.hooks.network.subscribe(listenerA)
    const unsubB = ctrl.hooks.network.subscribe(listenerB)
    await vi.waitFor(() => {
      expect(ctrl.hooks.network.getSnapshot().settled).toBe(true)
    })
    expect(deps.status).toHaveBeenCalledTimes(1)
    expect(ctrl.hooks.network.getSnapshot().status.mode).toBe('smart')

    // Event and connection reset callbacks trigger background refreshes
    onChanged?.()
    onReset?.()
    await vi.waitFor(() => {
      expect(deps.status).toHaveBeenCalledTimes(3)
    })

    // Exercise every controller action
    expect(await ctrl.setMode('global')).toBe(true)
    expect(ctrl.hooks.network.getSnapshot().status.mode).toBe('global')
    expect(await ctrl.importEnv()).toBe(true)
    expect(await ctrl.addSubscription({ name: 'Sub', url: 'https://example.com/sub' })).toBe(true)
    expect(await ctrl.updateSubscription({ id: SUB_1, name: 'Sub Renamed' })).toBe(true)
    expect(await ctrl.refreshSubscriptions()).toBe(true)
    expect(deps.refreshSubscriptions).toHaveBeenLastCalledWith({})
    expect(await ctrl.refreshSubscriptions(SUB_1)).toBe(true)
    expect(deps.refreshSubscriptions).toHaveBeenLastCalledWith({ id: SUB_1 })
    expect(await ctrl.updateRouting({ preferRegion: '日本' })).toBe(true)
    expect(await ctrl.selectNode(NODE_1)).toBe(true)
    expect(ctrl.hooks.network.getSnapshot().status.pinnedNodeId).toBe(NODE_1)
    expect(await ctrl.probeNodes()).toBe(true)
    expect(await ctrl.probeNodes({ limit: 4 })).toBe(true)
    expect(await ctrl.runDiagnostics()).toBe(true)
    expect(ctrl.hooks.network.getSnapshot().diagnostics).toEqual(diagReport)
    expect(await ctrl.removeSubscription(SUB_1)).toBe(true)

    // Error handling for Error instances and non-Error values + clearError()
    vi.mocked(deps.status).mockRejectedValueOnce(new Error('status failed'))
    expect(await ctrl.refresh()).toBe(false)
    expect(ctrl.hooks.network.getSnapshot().error).toBe('status failed')
    ctrl.clearError()
    expect(ctrl.hooks.network.getSnapshot().error).toBeNull()

    vi.mocked(deps.setMode).mockRejectedValueOnce('raw mode error')
    expect(await ctrl.setMode('direct')).toBe(false)
    expect(ctrl.hooks.network.getSnapshot().error).toBe('raw mode error')

    vi.mocked(deps.probeNodes).mockRejectedValueOnce(new Error('probe timeout'))
    expect(await ctrl.probeNodes()).toBe(false)
    expect(ctrl.hooks.network.getSnapshot().error).toBe('probe timeout')

    vi.mocked(deps.runDiagnostics).mockRejectedValueOnce(new Error('diag error'))
    expect(await ctrl.runDiagnostics()).toBe(false)
    expect(ctrl.hooks.network.getSnapshot().error).toBe('diag error')

    // Unsubscribing only one listener keeps watch alive; unsubscribing the last stops watching
    unsubA()
    expect(offChanged).not.toHaveBeenCalled()
    unsubB()
    expect(offChanged).toHaveBeenCalledTimes(1)
    expect(offReset).toHaveBeenCalledTimes(1)

    // Stale generation drops for refresh (resolve & reject), mutation (resolve & reject), and probeNodes (resolve & reject)
    const deferredRefreshOk = Promise.withResolvers<NetworkProxyStatus>()
    vi.mocked(deps.status).mockImplementationOnce(() => deferredRefreshOk.promise)
    const pRefreshOk = ctrl.refresh()
    void ctrl.refresh()
    deferredRefreshOk.resolve(smartStatus)
    expect(await pRefreshOk).toBe(true)

    const deferredRefreshErr = Promise.withResolvers<NetworkProxyStatus>()
    vi.mocked(deps.status).mockImplementationOnce(() => deferredRefreshErr.promise)
    const pRefreshErr = ctrl.refresh()
    void ctrl.refresh()
    deferredRefreshErr.reject(new Error('stale refresh err'))
    expect(await pRefreshErr).toBe(false)

    const deferredMutOk = Promise.withResolvers<NetworkProxyStatus>()
    vi.mocked(deps.setMode).mockImplementationOnce(() => deferredMutOk.promise)
    const pMutOk = ctrl.setMode('smart')
    void ctrl.refresh()
    deferredMutOk.resolve(smartStatus)
    expect(await pMutOk).toBe(true)

    const deferredMutErr = Promise.withResolvers<NetworkProxyStatus>()
    vi.mocked(deps.setMode).mockImplementationOnce(() => deferredMutErr.promise)
    const pMutErr = ctrl.setMode('smart')
    void ctrl.refresh()
    deferredMutErr.reject(new Error('stale mut err'))
    expect(await pMutErr).toBe(false)

    const deferredProbeOk = Promise.withResolvers<{ results: []; status: NetworkProxyStatus }>()
    vi.mocked(deps.probeNodes).mockImplementationOnce(() => deferredProbeOk.promise)
    const pProbeOk = ctrl.probeNodes()
    void ctrl.refresh()
    deferredProbeOk.resolve({ results: [], status: smartStatus })
    expect(await pProbeOk).toBe(true)

    const deferredProbeErr = Promise.withResolvers<{ results: []; status: NetworkProxyStatus }>()
    vi.mocked(deps.probeNodes).mockImplementationOnce(() => deferredProbeErr.promise)
    const pProbeErr = ctrl.probeNodes()
    void ctrl.refresh()
    deferredProbeErr.reject(new Error('stale probe err'))
    expect(await pProbeErr).toBe(false)
  })
})
