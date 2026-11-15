// @vitest-environment jsdom
/**
 * Integration and component tests for `@deepseek-ai/dsh-client-ui-settings-network`:
 * Host/Browser `apply`, `NetworkSectionIcon`, `SidebarFooterNetworkPill`, and `NetworkSettingsSection`.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply as applyLocale, inject as injectLocale } from '@deepseek-ai/dsh-client-locale/client'
import {
  bindSnapshotSelector,
  makeTranslate,
  StaticRemoteAccess,
  stubConfigForm,
} from '@deepseek-ai/dsh-client-test-runtime'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import {
  resolveSlotLabel,
  type GlobalStandardProps,
  type HostObservable,
  type StoredEntry,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {
  NetworkDiagnosticReport,
  NetworkProxyStatus,
  VpnNodeId,
  VpnSubscriptionId,
} from '@deepseek-ai/dsh-network-proxy/client'
import { apply as applyNode } from '../src/index.ts'
import { apply, inject } from '../src/client/index.ts'
import { de, en, es, fr, ja, NS, pt, ru, zh } from '../src/client/locales.ts'
import {
  EMPTY_NETWORK_STATUS,
  type NetworkProxyViewSnapshot,
} from '../src/client/network-source.ts'
import { NetworkSectionIcon } from '../src/client/NetworkSectionIcon.tsx'
import {
  NetworkSettingsSection,
  type NetworkSettingsInjected,
} from '../src/client/NetworkSettingsSection.tsx'
import {
  SidebarFooterNetworkPill,
  type SidebarFooterNetworkInjected,
} from '../src/client/SidebarFooterNetworkPill.tsx'

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

const t = makeTranslate(en)
const SUB_A = 'sub-a' as VpnSubscriptionId
const SUB_B = 'sub-b' as VpnSubscriptionId
const NODE_US = 'node-us' as VpnNodeId
const NODE_SG = 'node-sg' as VpnNodeId

function makeObservable<T>(initial: T): {
  source: HostObservable<T>
  set: (next: T) => void
} {
  let current = initial
  const listeners = new Set<() => void>()
  return {
    source: {
      getSnapshot: () => current,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
    set: (next) => {
      current = next
      for (const listener of listeners) listener()
    },
  }
}

function makeView(overrides: Partial<NetworkProxyViewSnapshot> = {}): NetworkProxyViewSnapshot {
  return {
    settled: true,
    loading: false,
    probing: false,
    diagnosing: false,
    error: null,
    status: EMPTY_NETWORK_STATUS,
    diagnostics: null,
    ...overrides,
  }
}

class RemoteServiceStub extends Service {
  constructor(
    ctx: Context,
    readonly $on: (event: 'network-proxy/changed', listener: () => void) => () => void,
    readonly networkProxy: Record<string, unknown>,
  ) {
    super(ctx, 'remote')
  }
}

const EmptySlotOwner = () => null

function requireSectionFace(entry: StoredEntry | undefined): NetworkSettingsInjected {
  if (entry === undefined) throw new Error('missing slot entry')
  const face = entry.inject?.()
  if (face === undefined || !('onClearError' in face)) throw new Error('unexpected section face')
  return face as never
}

function requireFooterFace(entry: StoredEntry | undefined): SidebarFooterNetworkInjected {
  if (entry === undefined) throw new Error('missing slot entry')
  const face = entry.inject?.()
  if (face === undefined || !('onSetMode' in face)) throw new Error('unexpected footer face')
  return face as never
}

describe('ui-settings-network plugin registration and locales', () => {
  it('exposes complete 8-locale dictionaries and gates slot registrations on networkProxy/status access', async () => {
    applyNode()
    expect(inject).toContain('remote.networkProxy')
    expect(NS).toBe('settings.network')
    for (const dict of [zh, en, ja, es, fr, de, ru, pt]) {
      expect(Object.keys(dict)).toEqual(Object.keys(zh))
    }

    const okEnvelope = <T,>(value: T) => ({ ok: true as const, value })
    const remoteApi = {
      status: vi.fn(async () => okEnvelope(EMPTY_NETWORK_STATUS)),
      setMode: vi.fn<() => Promise<{ ok: true; value: NetworkProxyStatus } | { ok: false; error: { message: string } }>>(
        async () => okEnvelope(EMPTY_NETWORK_STATUS),
      ),
      importEnvSubscriptions: vi.fn(async () => okEnvelope({
        importedCount: 0,
        skippedCount: 0,
        outcomes: [],
        status: EMPTY_NETWORK_STATUS,
      })),
      addSubscription: vi.fn(async () => okEnvelope({ outcomes: [], status: EMPTY_NETWORK_STATUS })),
      updateSubscription: vi.fn(async () => okEnvelope(EMPTY_NETWORK_STATUS)),
      removeSubscription: vi.fn(async (req: { id: VpnSubscriptionId }) => okEnvelope({
        id: req.id,
        removed: true,
        status: EMPTY_NETWORK_STATUS,
      })),
      refreshSubscriptions: vi.fn(async () => okEnvelope({ outcomes: [], status: EMPTY_NETWORK_STATUS })),
      updateRouting: vi.fn(async () => okEnvelope(EMPTY_NETWORK_STATUS)),
      selectNode: vi.fn(async () => okEnvelope(EMPTY_NETWORK_STATUS)),
      probeNodes: vi.fn(async () => okEnvelope({ results: [], status: EMPTY_NETWORK_STATUS })),
      runDiagnostics: vi.fn(async () => okEnvelope<NetworkDiagnosticReport>({
        checkedAt: '2026-11-16T00:00:00.000Z',
        mode: 'direct',
        selectedNodeName: null,
        targets: [],
      })),
    }

    let triggerChanged: (() => void) | undefined
    const setup = async (allow: boolean) => {
      const ctx = new Context()
      await ctx.plugin(SlotRegistry).await()
      ctx.slots.register(
        {
          name: 'root',
          children: {
            'sidebar.footer.action': { kind: 'list', scope: 'root' },
            'settings.section': { kind: 'list', scope: 'root' },
            'settings.section.icon': { kind: 'list', scope: 'root', inline: true },
          },
        } as never,
        EmptySlotOwner,
      )
      new StaticRemoteAccess(ctx, action => (action === 'networkProxy/status' ? allow : true))
      new RemoteServiceStub(
        ctx,
        (_ev, cb) => {
          triggerChanged = cb
          return () => {}
        },
        remoteApi,
      )
      await ctx.plugin({
        apply(provider: Context) {
          provider.provide('remote.networkProxy', remoteApi as never)
        },
      }).await()
      ctx.provide('configForms', { get: () => stubConfigForm().scope } as never)
      await ctx.plugin({ inject: injectLocale, apply: applyLocale }).await()
      await ctx.plugin({ inject, apply }).await()
      return ctx
    }

    const denied = await setup(false)
    expect(denied.slots.entries('settings.section')).toHaveLength(0)
    expect(denied.slots.entries('settings.section.icon')).toHaveLength(0)
    expect(denied.slots.entries('sidebar.footer.action')).toHaveLength(0)
    await denied.fiber.dispose()

    const allowed = await setup(true)
    const sectionEntry = allowed.slots.entries('settings.section')[0]
    const iconEntry = allowed.slots.entries('settings.section.icon')[0]
    const footerEntry = allowed.slots.entries('sidebar.footer.action')[0]
    expect(sectionEntry?.options.id).toBe('network')
    expect(resolveSlotLabel(sectionEntry?.options.label)).toBe('Network and proxy')
    expect(iconEntry?.options.id).toBe('network')
    expect(footerEntry?.options.id).toBe('network-status')
    expect(resolveSlotLabel(footerEntry?.options.label)).toBe('Network and proxy')

    // Exercise every injected callback on both faces
    const sectionFace = requireSectionFace(sectionEntry)
    const footerFace = requireFooterFace(footerEntry)
    const unsub = sectionFace.hooks.network.subscribe(() => {})
    triggerChanged?.()
    allowed.emit('connection/reset')
    sectionFace.onClearError()
    await sectionFace.onSetMode('smart')
    remoteApi.setMode.mockResolvedValueOnce({ ok: false, error: { message: 'Host refused mode switch' } })
    expect(await sectionFace.onSetMode('global')).toBe(false)
    expect(sectionFace.hooks.network.getSnapshot().error).toBe('Host refused mode switch')
    await sectionFace.onImportEnv()
    await sectionFace.onAddSubscription({ name: 'A', url: 'https://example.com/a' })
    await sectionFace.onUpdateSubscription({ id: SUB_A, name: 'B' })
    await sectionFace.onRemoveSubscription(SUB_A)
    await sectionFace.onRefreshSubscriptions()
    await sectionFace.onUpdateRouting({ preferRegion: '日本' })
    await sectionFace.onSelectNode(NODE_US)
    await sectionFace.onProbeNodes()
    await sectionFace.onRunDiagnostics()
    await footerFace.onSetMode('direct')
    await footerFace.onSelectNode(null)
    await footerFace.onProbeNodes()
    unsub()

    const globals = {} as GlobalStandardProps
    const { container } = render(<NetworkSectionIcon {...globals} size={16} active />)
    expect(container.querySelector('svg')).not.toBeNull()
    await allowed.fiber.dispose()
  })
})

describe('SidebarFooterNetworkPill', () => {
  it('stays hidden until settled or while in direct mode, and supports wide/rail switching & quick menu actions', () => {
    const globals = {} as GlobalStandardProps
    const onSetMode = vi.fn(async () => true)
    const onSelectNode = vi.fn(async () => true)
    const onProbeNodes = vi.fn(async () => true)

    const obs = makeObservable<NetworkProxyViewSnapshot>(makeView({ settled: false }))
    const { rerender } = render(
      <SidebarFooterNetworkPill
        {...globals}
        wide
        t={t}
        useNetwork={bindSnapshotSelector(obs.source)}
        onSetMode={onSetMode}
        onSelectNode={onSelectNode}
        onProbeNodes={onProbeNodes}
      />,
    )
    expect(screen.queryByRole('button')).toBeNull()

    // Settled in direct mode -> still hidden
    act(() => {
      obs.set(makeView({ settled: true, status: EMPTY_NETWORK_STATUS }))
    })
    expect(screen.queryByRole('button')).toBeNull()

    // Smart mode without gateway/nodes (warning dot, no latency badge)
    const smartNoNode: NetworkProxyStatus = {
      ...EMPTY_NETWORK_STATUS,
      mode: 'smart',
    }
    act(() => {
      obs.set(makeView({ status: smartNoNode }))
    })
    expect(screen.getByRole('button', { name: 'Network proxy status: Smart routing' })).toBeTruthy()

    // Global mode with gateway, pinned node, latency, and probing spinner
    const globalWithNodes: NetworkProxyStatus = {
      ...EMPTY_NETWORK_STATUS,
      mode: 'global',
      gateway: {
        host: '127.0.0.1',
        port: 17890,
        httpProxyUrl: 'http://127.0.0.1:17890',
        socksProxyUrl: 'socks5://127.0.0.1:17890',
      },
      selectedNodeId: NODE_US,
      pinnedNodeId: NODE_US,
      nodes: [
        {
          nodeId: NODE_US,
          name: 'US-01',
          protocol: 'ss2022',
          subscriptionId: SUB_A,
          latencyMs: 92,
          consecutiveFailures: 0,
          circuitOpenUntilMs: null,
          activeConnections: 0,
          totalSuccesses: 1,
          totalFailures: 0,
        },
        {
          nodeId: NODE_SG,
          name: 'SG-01',
          protocol: 'trojan',
          subscriptionId: SUB_A,
          latencyMs: null,
          consecutiveFailures: 0,
          circuitOpenUntilMs: null,
          activeConnections: 0,
          totalSuccesses: 0,
          totalFailures: 0,
        },
      ],
    }
    act(() => {
      obs.set(makeView({ status: globalWithNodes }))
    })
    expect(screen.getByText('Global proxy · US-01')).toBeTruthy()
    expect(screen.getByText('92 ms')).toBeTruthy()

    // Probing spinner state in rail mode (`wide={false}`)
    act(() => {
      obs.set(makeView({ probing: true, status: globalWithNodes }))
    })
    rerender(
      <SidebarFooterNetworkPill
        {...globals}
        wide={false}
        t={t}
        useNetwork={bindSnapshotSelector(obs.source)}
        onSetMode={onSetMode}
        onSelectNode={onSelectNode}
        onProbeNodes={onProbeNodes}
      />,
    )
    act(() => {
      obs.set(makeView({ probing: false, status: globalWithNodes }))
    })

    // Open menu and trigger every item type + Escape close
    const trigger = screen.getByRole('button', { name: 'Network proxy status: Global proxy' })
    fireEvent.click(trigger)
    fireEvent.keyDown(document, { key: 'Escape' })

    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Direct' }))
    expect(onSetMode).toHaveBeenCalledWith('direct')

    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Smart routing' }))
    expect(onSetMode).toHaveBeenCalledWith('smart')

    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Global proxy' }))
    expect(onSetMode).toHaveBeenCalledWith('global')

    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Auto-select best regional node' }))
    expect(onSelectNode).toHaveBeenCalledWith(null)

    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: 'US-01 (92 ms)' }))
    expect(onSelectNode).toHaveBeenCalledWith(NODE_US)

    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Probe node latency' }))
    expect(onProbeNodes).toHaveBeenCalledTimes(1)
  })
})

describe('NetworkSettingsSection', () => {
  it('renders and drives modes, subscriptions, .env import, routing overrides, node pinning, and diagnostics', async () => {
    const onClearError = vi.fn()
    const onSetMode = vi.fn(async () => true)
    const onImportEnv = vi.fn(async () => true)
    const onAddSubscription = vi.fn<NetworkSettingsInjected['onAddSubscription']>(async () => true)
    const onUpdateSubscription = vi.fn<NetworkSettingsInjected['onUpdateSubscription']>(async () => true)
    const onRemoveSubscription = vi.fn(async () => true)
    const onRefreshSubscriptions = vi.fn(async () => true)
    const onUpdateRouting = vi.fn(async () => true)
    const onSelectNode = vi.fn(async () => true)
    const onProbeNodes = vi.fn(async () => true)
    const onRunDiagnostics = vi.fn(async () => true)

    const obs = makeObservable<NetworkProxyViewSnapshot>(
      makeView({
        error: 'Subscription URL rejected',
        status: {
          ...EMPTY_NETWORK_STATUS,
          ambientEnvCandidates: [
            {
              envKey: 'SUB_VPN_1',
              source: 'user-env',
              maskedUrl: 'https://airport.example/***',
              alreadyImported: false,
            },
            {
              envKey: 'SUB_VPN_2',
              source: 'env',
              maskedUrl: 'https://dup.example/***',
              alreadyImported: true,
            },
          ],
        },
      }),
    )

    const globals = {} as GlobalStandardProps
    render(
      <NetworkSettingsSection
        {...globals}
        close={() => {}}
        t={t}
        useNetwork={bindSnapshotSelector(obs.source)}
        onClearError={onClearError}
        onSetMode={onSetMode}
        onImportEnv={onImportEnv}
        onAddSubscription={onAddSubscription}
        onUpdateSubscription={onUpdateSubscription}
        onRemoveSubscription={onRemoveSubscription}
        onRefreshSubscriptions={onRefreshSubscriptions}
        onUpdateRouting={onUpdateRouting}
        onSelectNode={onSelectNode}
        onProbeNodes={onProbeNodes}
        onRunDiagnostics={onRunDiagnostics}
      />,
    )

    // Error banner & dismiss
    expect(screen.getByRole('alert').textContent).toContain('Subscription URL rejected')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss error notice' }))
    expect(onClearError).toHaveBeenCalledTimes(1)

    // Empty states for subscriptions, nodes, and diagnostics
    expect(screen.getByText(/No subscriptions configured yet/u)).toBeTruthy()
    expect(screen.getByText(/Enable and refresh a subscription/u)).toBeTruthy()
    expect(screen.getByText(/Run diagnostics to verify/u)).toBeTruthy()

    // 1-click .env import banner shows only unimported candidate
    expect(screen.getByText('SUB_VPN_1 (https://airport.example/***)')).toBeTruthy()
    expect(screen.queryByText(/SUB_VPN_2/u)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Import from .env' }))
    expect(onImportEnv).toHaveBeenCalledTimes(1)

    // Mode switching across direct -> smart -> global
    fireEvent.click(screen.getByRole('tab', { name: 'Smart routing' }))
    expect(onSetMode).toHaveBeenCalledWith('smart')

    // Add subscription form: test failed save (keeps draft open) then valid save (closes draft), plus Cancel
    fireEvent.click(screen.getByRole('button', { name: 'Add subscription' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText('Add VPN subscription')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Add subscription' }))
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Main Airport' } })
    fireEvent.change(screen.getByLabelText('Auto-refresh interval (minutes, 0 disables)'), {
      target: { value: 'invalid-num' },
    })
    fireEvent.change(screen.getByLabelText('Subscription URL (stored in credentials only)'), {
      target: { value: 'https://sub.example/v1' },
    })
    fireEvent.click(screen.getByRole('switch', { name: 'Enable subscription' }))

    onAddSubscription.mockResolvedValueOnce(false)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save subscription' }))
    })
    expect(onAddSubscription).toHaveBeenCalledWith({
      name: 'Main Airport',
      url: 'https://sub.example/v1',
      enabled: false,
      autoRefreshMinutes: -1,
    })
    // Draft remains open on false
    expect(screen.getByText('Add VPN subscription')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Auto-refresh interval (minutes, 0 disables)'), {
      target: { value: '180' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save subscription' }))
    })
    expect(screen.queryByText('Add VPN subscription')).toBeNull()

    // Populate rich smart/global states with subscriptions, nodes, and diagnostics
    const populatedStatus: NetworkProxyStatus = {
      mode: 'smart',
      routing: {
        preferRegion: '美国|新加坡',
        maxPreferredLatencyMs: 3_000,
        proxySubprocesses: true,
        proxyBrowserGuests: false,
        providerOverrides: { openai: 'proxy' },
        capabilityOverrides: { web: 'proxy' },
        customRules: ['DOMAIN-SUFFIX,huggingface.co,PROXY'],
      },
      subscriptions: [
        {
          id: SUB_A,
          name: 'Airport Alpha',
          maskedUrl: 'https://alpha.example/***',
          enabled: true,
          autoRefreshMinutes: 360,
          nodeCount: 2,
          lastUpdatedAt: '2026-11-16T00:00:00.000Z',
          userInfo: {
            uploadBytes: 1024 ** 3,
            downloadBytes: 2 * 1024 ** 3,
            totalBytes: 100 * 1024 ** 3,
          },
          envKey: 'SUB_VPN_1',
        },
        {
          id: SUB_B,
          name: 'Backup Beta',
          maskedUrl: 'https://beta.example/***',
          enabled: false,
          autoRefreshMinutes: 0,
          nodeCount: 0,
          lastUpdatedAt: null,
          lastError: 'HTTP 502 from upstream',
        },
      ],
      gateway: {
        host: '127.0.0.1',
        port: 17891,
        httpProxyUrl: 'http://127.0.0.1:17891',
        socksProxyUrl: 'socks5://127.0.0.1:17891',
      },
      nodes: [
        {
          nodeId: NODE_US,
          name: 'US-West-01',
          protocol: 'ss2022',
          subscriptionId: SUB_A,
          latencyMs: 110,
          consecutiveFailures: 0,
          circuitOpenUntilMs: null,
          activeConnections: 1,
          totalSuccesses: 4,
          totalFailures: 0,
        },
        {
          nodeId: NODE_SG,
          name: 'SG-02',
          protocol: 'vless',
          subscriptionId: SUB_A,
          latencyMs: null,
          consecutiveFailures: 3,
          circuitOpenUntilMs: Date.now() + 30_000,
          activeConnections: 0,
          totalSuccesses: 0,
          totalFailures: 3,
        },
      ],
      selectedNodeId: NODE_US,
      pinnedNodeId: null,
      ambientEnvCandidates: [],
    }

    const diagReport: NetworkDiagnosticReport = {
      checkedAt: '2026-11-16T00:01:00.000Z',
      mode: 'smart',
      selectedNodeName: 'US-West-01',
      targets: [
        {
          id: 'deepseek',
          label: 'DeepSeek API',
          url: 'https://api.deepseek.com/models',
          route: 'direct',
          ok: true,
          statusCode: 200,
          latencyMs: 25,
        },
        {
          id: 'openai',
          label: 'OpenAI API',
          url: 'https://api.openai.com/v1/models',
          route: 'proxy',
          nodeName: 'US-West-01',
          ok: true,
          statusCode: 401,
          latencyMs: 140,
        },
        {
          id: 'blocked',
          label: 'Blocked Host',
          url: 'https://ads.example/ping',
          route: 'reject',
          ok: false,
          statusCode: 403,
          latencyMs: null,
          error: 'Rejected by custom rule',
        },
      ],
    }

    act(() => {
      obs.set(
        makeView({
          error: null,
          status: populatedStatus,
          diagnostics: diagReport,
        }),
      )
    })

    // Also verify global mode description + pinned node badges + busy probing/diagnosing labels
    act(() => {
      obs.set(
        makeView({
          probing: true,
          diagnosing: true,
          status: {
            ...populatedStatus,
            mode: 'global',
            pinnedNodeId: NODE_US,
          },
          diagnostics: diagReport,
        }),
      )
    })
    expect(screen.getByText('Probing…')).toBeTruthy()
    expect(screen.getByText('Running…')).toBeTruthy()
    expect(screen.getByText('Pinned')).toBeTruthy()

    act(() => {
      obs.set(
        makeView({
          probing: false,
          diagnosing: false,
          status: populatedStatus,
          diagnostics: diagReport,
        }),
      )
    })

    // Subscription row controls: Refresh all, per-row Switch, Refresh, Edit (blank & rotated URL), Remove
    fireEvent.click(screen.getByRole('button', { name: 'Refresh all' }))
    expect(onRefreshSubscriptions).toHaveBeenCalledWith()

    fireEvent.click(screen.getByRole('switch', { name: 'Enable subscription Airport Alpha' }))
    expect(onUpdateSubscription).toHaveBeenCalledWith({ id: SUB_A, enabled: false })

    const refreshButtons = screen.getAllByRole('button', { name: 'Refresh' })
    fireEvent.click(refreshButtons[0]!)
    expect(onRefreshSubscriptions).toHaveBeenCalledWith(SUB_A)

    const editButtons = screen.getAllByRole('button', { name: 'Edit' })
    fireEvent.click(editButtons[0]!)
    expect(screen.getByText('Edit subscription: Airport Alpha')).toBeTruthy()

    // Save edit without changing URL (and first test failed update keeping draft open)
    onUpdateSubscription.mockResolvedValueOnce(false)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save subscription' }))
    })
    expect(screen.getByText('Edit subscription: Airport Alpha')).toBeTruthy()

    // Now supply a rotated URL and save successfully
    fireEvent.change(screen.getByLabelText('Subscription URL (stored in credentials only)'), {
      target: { value: 'https://rotated.example/sub' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save subscription' }))
    })
    expect(onUpdateSubscription).toHaveBeenLastCalledWith({
      id: SUB_A,
      name: 'Airport Alpha',
      url: 'https://rotated.example/sub',
      enabled: true,
      autoRefreshMinutes: 360,
    })

    const removeButtons = screen.getAllByRole('button', { name: 'Remove' })
    fireEvent.click(removeButtons[1]!)
    expect(onRemoveSubscription).toHaveBeenCalledWith(SUB_B)

    // Smart routing form controls
    fireEvent.click(
      screen.getByRole('switch', { name: 'Inject loopback proxy into Bash, MCP, and plugin subprocesses' }),
    )
    expect(onUpdateRouting).toHaveBeenCalledWith({ proxySubprocesses: false })

    fireEvent.click(
      screen.getByRole('switch', { name: 'Route Desktop embedded browser views through loopback proxy' }),
    )
    expect(onUpdateRouting).toHaveBeenCalledWith({ proxyBrowserGuests: true })

    // Provider & capability SegmentedControl overrides
    const deepseekGroup = screen.getByRole('tablist', { name: 'DeepSeek' })
    fireEvent.click(deepseekGroup.querySelectorAll('[role="tab"]')[2]!)
    expect(onUpdateRouting).toHaveBeenCalledWith({
      providerOverrides: { openai: 'proxy', 'deepseek-official': 'proxy' },
    })

    const mcpGroup = screen.getByRole('tablist', { name: 'Remote MCP servers' })
    fireEvent.click(mcpGroup.querySelectorAll('[role="tab"]')[1]!)
    expect(onUpdateRouting).toHaveBeenCalledWith({
      capabilityOverrides: { web: 'proxy', mcp: 'direct' },
    })

    // Save routing policy (both invalid ceiling and valid ceiling + custom rules)
    fireEvent.change(screen.getByLabelText('Preferred region tiers (comma separates tiers, pipe shares priority)'), {
      target: { value: '日本, 美国' },
    })
    fireEvent.change(screen.getByLabelText('Preferred-region latency ceiling (ms)'), {
      target: { value: 'bad-ms' },
    })
    fireEvent.change(
      screen.getByLabelText('Custom Clash rules (one rule per line, evaluated before subscription rules)'),
      { target: { value: '  DOMAIN-SUFFIX,github.com,PROXY \n\n DOMAIN-SUFFIX,cn,DIRECT  ' } },
    )
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save routing policy' }))
    })
    expect(onUpdateRouting).toHaveBeenLastCalledWith({
      preferRegion: '日本, 美国',
      maxPreferredLatencyMs: -1,
      customRules: ['DOMAIN-SUFFIX,github.com,PROXY', 'DOMAIN-SUFFIX,cn,DIRECT'],
    })

    fireEvent.change(screen.getByLabelText('Preferred-region latency ceiling (ms)'), {
      target: { value: '2500' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save routing policy' }))
    })
    expect(onUpdateRouting).toHaveBeenLastCalledWith({
      preferRegion: '日本, 美国',
      maxPreferredLatencyMs: 2500,
      customRules: ['DOMAIN-SUFFIX,github.com,PROXY', 'DOMAIN-SUFFIX,cn,DIRECT'],
    })

    // Node selection & probing + diagnostics button
    fireEvent.click(screen.getByRole('button', { name: 'Probe latency' }))
    expect(onProbeNodes).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: /Auto-select best regional node/u }))
    expect(onSelectNode).toHaveBeenCalledWith(null)

    fireEvent.click(screen.getByRole('button', { name: /SG-02/u }))
    expect(onSelectNode).toHaveBeenCalledWith(NODE_SG)

    fireEvent.click(screen.getByRole('button', { name: 'Run diagnostics' }))
    expect(onRunDiagnostics).toHaveBeenCalledTimes(1)
  })
})
