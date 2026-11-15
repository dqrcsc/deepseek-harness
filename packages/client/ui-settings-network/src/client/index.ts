/**
 * Browser Network & Proxy plugin: contributes `Settings -> Network and proxy` (`id: 'network'`),
 * its navigation icon, and the sidebar footer proxy status switcher (`sidebar.footer.action`)
 * while the active Peer is authorized to read `networkProxy/status`.
 * @module @deepseek-ai/dsh-client-ui-settings-network/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remote-access/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { de, en, es, fr, ja, NS, pt, ru, zh, type NetworkSettingsLocaleKey } from './locales.ts'
import { createNetworkProxySource } from './network-source.ts'
import { NetworkSectionIcon } from './NetworkSectionIcon.tsx'
import { NetworkSettingsSection, type NetworkSettingsInjected, type NetworkSettingsProps } from './NetworkSettingsSection.tsx'
import {
  SidebarFooterNetworkPill,
  type SidebarFooterNetworkInjected,
  type SidebarFooterNetworkProps,
} from './SidebarFooterNetworkPill.tsx'

export type { NetworkSettingsLocaleKey } from './locales.ts'
export type {
  NetworkProxyController,
  NetworkProxyRemoteDeps,
  NetworkProxyViewSnapshot,
} from './network-source.ts'
export type { NetworkSettingsInjected, NetworkSettingsProps }
export type { SidebarFooterNetworkInjected, SidebarFooterNetworkProps }

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Network & Proxy settings page and sidebar status pill copy. */
    'settings.network': NetworkSettingsLocaleKey
  }
}

/** Browser services required by `ui-settings-network`. */
export const inject = [
  'slots',
  'locale',
  'remote',
  'remote.networkProxy',
  'remoteAccess',
]

type RemoteEnvelope<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly message: string } }

async function unwrapRemote<T>(call: Promise<RemoteEnvelope<T>>): Promise<T> {
  const response = await call
  if (response.ok) return response.value
  throw new Error(response.error.message)
}

/**
 * Register localized dictionaries and mount the Settings section, navigation icon,
 * and sidebar footer status pill while `networkProxy/status` is accessible.
 * @param ctx - browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }),
    'ui-settings-network: dictionaries',
  )
  const t = ctx.locale.bind(NS)

  ctx.remoteAccess.whenAccess('networkProxy/status', function* () {
    const controller = createNetworkProxySource({
      status: () => unwrapRemote(ctx.remote.networkProxy.status()),
      setMode: mode => unwrapRemote(ctx.remote.networkProxy.setMode({ mode })),
      importEnvSubscriptions: () => unwrapRemote(ctx.remote.networkProxy.importEnvSubscriptions()),
      addSubscription: request => unwrapRemote(ctx.remote.networkProxy.addSubscription(request)),
      updateSubscription: request => unwrapRemote(ctx.remote.networkProxy.updateSubscription(request)),
      removeSubscription: id => unwrapRemote(ctx.remote.networkProxy.removeSubscription({ id })),
      refreshSubscriptions: request => unwrapRemote(ctx.remote.networkProxy.refreshSubscriptions(request)),
      updateRouting: request => unwrapRemote(ctx.remote.networkProxy.updateRouting(request)),
      selectNode: nodeId => unwrapRemote(ctx.remote.networkProxy.selectNode({ nodeId })),
      probeNodes: request => unwrapRemote(ctx.remote.networkProxy.probeNodes(request)),
      runDiagnostics: () => unwrapRemote(ctx.remote.networkProxy.runDiagnostics()),
      subscribeChanged: listener => ctx.remote.$on('network-proxy/changed', listener),
      subscribeReset: listener => ctx.on('connection/reset', listener),
    })

    yield ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'network',
      order: 25,
      label: () => t('section.title'),
      locale: NS,
      inject: (): NetworkSettingsInjected => ({
        hooks: controller.hooks,
        onClearError: controller.clearError,
        onSetMode: controller.setMode,
        onImportEnv: controller.importEnv,
        onAddSubscription: controller.addSubscription,
        onUpdateSubscription: controller.updateSubscription,
        onRemoveSubscription: controller.removeSubscription,
        onRefreshSubscriptions: controller.refreshSubscriptions,
        onUpdateRouting: controller.updateRouting,
        onSelectNode: controller.selectNode,
        onProbeNodes: () => controller.probeNodes(),
        onRunDiagnostics: controller.runDiagnostics,
      }),
    }, NetworkSettingsSection))

    yield ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
      name: 'settings.section.icon',
      id: 'network',
    }, NetworkSectionIcon))

    yield ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'network-status',
      order: 10,
      label: () => t('section.title'),
      locale: NS,
      inject: (): SidebarFooterNetworkInjected => ({
        hooks: controller.hooks,
        onSetMode: controller.setMode,
        onSelectNode: controller.selectNode,
        onProbeNodes: () => controller.probeNodes(),
      }),
    }, SidebarFooterNetworkPill))
  })
}
