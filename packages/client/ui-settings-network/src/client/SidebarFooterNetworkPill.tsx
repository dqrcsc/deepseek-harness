/**
 * Compact sidebar footer proxy status pill & quick switcher menu.
 * @module @deepseek-ai/dsh-client-ui-settings-network/client/SidebarFooterNetworkPill
 */

import clsx from 'clsx'
import { useState } from 'react'
import {
  IconGlobeOutlineRegular,
  IconRefreshOutlineRegular,
  Menu,
  StateDot,
  Tooltip,
  type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { NetworkProxyMode, VpnNodeId } from '@deepseek-ai/dsh-network-proxy/client'
import type { NS } from './locales.ts'
import { findSelectedNode, type NetworkProxyViewSnapshot } from './network-source.ts'
import css from './SidebarFooterNetworkPill.module.css'

/** Maximum quick-switch candidate nodes shown inside the compact sidebar menu. */
const QUICK_NODE_LIMIT = 6

/** Raw slot `inject()` payload for {@link SidebarFooterNetworkPill}. */
export interface SidebarFooterNetworkInjected {
  /** Observable network proxy view source bound by the slot renderer as `useNetwork`. */
  readonly hooks: {
    /** Network proxy view source. */
    readonly network: HostObservable<NetworkProxyViewSnapshot>
  }
  /** Switch outbound proxy mode (`direct`, `smart`, or `global`). */
  readonly onSetMode: (mode: NetworkProxyMode) => Promise<boolean>
  /** Pin a specific VPN node or pass `null` to restore automatic selection. */
  readonly onSelectNode: (nodeId: VpnNodeId | null) => Promise<boolean>
  /** Probe active VPN nodes for TCP/TLS latency. */
  readonly onProbeNodes: () => Promise<boolean>
}

/** Runtime props delivered to {@link SidebarFooterNetworkPill}. */
export type SidebarFooterNetworkProps =
  PropsRuntime<'sidebar.footer.action'> &
  PropsLocale<typeof NS> &
  InjectFace<SidebarFooterNetworkInjected>

/**
 * Render the sidebar footer network proxy status pill when `mode` is `smart` or `global`.
 * Renders `null` in `direct` mode so default deployments incur zero visual chrome.
 * @param props - sidebar column state, localized copy binder, and network controller hooks.
 * @returns status pill menu or `null`.
 */
export function SidebarFooterNetworkPill({
  wide,
  t,
  useNetwork,
  onSetMode,
  onSelectNode,
  onProbeNodes,
}: SidebarFooterNetworkProps) {
  const view = useNetwork(s => s)
  const [open, setOpen] = useState(false)

  if (!view.settled || view.status.mode === 'direct') {
    return null
  }

  const { status } = view
  const modeText = status.mode === 'smart' ? t('mode.smart') : t('mode.global')
  const selectedNode = findSelectedNode(status)
  const dotState = view.probing
    ? 'ongoing'
    : status.gateway !== null && selectedNode !== null
      ? 'done'
      : 'warning'
  const detailText = selectedNode !== null ? selectedNode.name : t('gateway.noNode')
  const gatewayDetail = status.gateway !== null ? status.gateway.httpProxyUrl : t('gateway.stopped')
  const rttMs = selectedNode?.latencyMs ?? null

  const items: MenuEntry[] = [
    { type: 'label', id: 'lbl-gateway', text: t('sidebar.menuGateway', { detail: gatewayDetail }) },
    { id: 'mode:direct', label: t('mode.direct') },
    { id: 'mode:smart', label: t('mode.smart') },
    { id: 'mode:global', label: t('mode.global') },
    { type: 'separator', id: 'sep-nodes' },
    { id: 'node:auto', label: t('sidebar.menuAutoNode') },
    ...status.nodes.slice(0, QUICK_NODE_LIMIT).map((node): MenuEntry => {
      const nodeRtt = node.latencyMs
      const suffix = nodeRtt !== null ? ` (${t('nodes.latencyMs', { ms: String(Math.round(nodeRtt)) })})` : ''
      return {
        id: `node:${node.nodeId}`,
        label: `${node.name}${suffix}`,
      }
    }),
    { type: 'separator', id: 'sep-actions' },
    {
      id: 'action:probe',
      label: view.probing ? t('nodes.probing') : t('sidebar.menuProbe'),
      icon: <IconRefreshOutlineRegular size={16} />,
      disabled: view.probing || status.nodes.length === 0,
    },
  ]

  const selectedIds: string[] = [
    `mode:${status.mode}`,
    status.pinnedNodeId === null ? 'node:auto' : `node:${status.pinnedNodeId}`,
  ]

  const handleSelect = (itemId: string): void => {
    setOpen(false)
    if (itemId === 'mode:direct') {
      void onSetMode('direct')
      return
    }
    if (itemId === 'mode:smart') {
      void onSetMode('smart')
      return
    }
    if (itemId === 'mode:global') {
      void onSetMode('global')
      return
    }
    if (itemId === 'node:auto') {
      void onSelectNode(null)
      return
    }
    if (itemId.startsWith('node:')) {
      const rawId = itemId.slice('node:'.length) as VpnNodeId
      void onSelectNode(rawId)
      return
    }
    void onProbeNodes()
  }

  const buttonElement = (
    <button
      type="button"
      className={clsx(css.trigger, !wide && css.triggerRail)}
      aria-label={t('sidebar.pillAria', { mode: modeText })}
      aria-expanded={open}
      onClick={() => { setOpen(prev => !prev) }}
    >
      {wide ? (
        <>
          <span className={css.leading}>
            <StateDot state={dotState} size={8} />
            <IconGlobeOutlineRegular size={16} />
          </span>
          <span className={css.label}>
            {selectedNode !== null ? `${modeText} · ${selectedNode.name}` : modeText}
          </span>
          {rttMs !== null && (
            <span className={css.latency}>
              {t('nodes.latencyMs', { ms: String(Math.round(rttMs)) })}
            </span>
          )}
        </>
      ) : (
        <>
          <IconGlobeOutlineRegular size={18} />
          <StateDot state={dotState} size={8} className={css.railDot} />
        </>
      )}
    </button>
  )

  const anchor = wide ? (
    buttonElement
  ) : (
    <Tooltip
      side="right"
      portal
      disabled={open}
      label={t('sidebar.tooltip', { mode: modeText, detail: detailText })}
    >
      {buttonElement}
    </Tooltip>
  )

  return (
    <div className={clsx(css.wrapper, !wide && css.wrapperRail)}>
      <Menu
        open={open}
        anchor={anchor}
        onClose={() => { setOpen(false) }}
        onSelect={handleSelect}
        items={items}
        selectedIds={selectedIds}
        side="top"
        align="start"
        portal
        className={clsx(css.menuAnchor, !wide && css.menuAnchorRail)}
      />
    </div>
  )
}
