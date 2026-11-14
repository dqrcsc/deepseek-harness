/**
 * Browser Memory center plugin: left-sidebar Memory center panel, Session-header
 * incognito switch, and Turn-tail memory citation pill over `ctx.remote.memory`.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remote-access/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-commands/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { IconEyeOffOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createMemoryCatalogSource, isSessionAvailable } from './catalog-source.ts'
import { de, en, es, fr, ja, NS, pt, ru, zh, type MemoryCenterKey } from './locales.ts'
import { MemoryCenterIcon } from './MemoryCenterIcon.tsx'
import { MemoryCenterPage, type MemoryCenterInjected } from './MemoryCenterPage.tsx'
import { MemoryCitationsPill, type MemoryCitationsInjected } from './MemoryCitationsPill.tsx'
import { memoryTurnDefinition } from './memory-turn.ts'
import { SessionIncognitoAction, type SessionIncognitoInjected } from './SessionIncognitoAction.tsx'

/** Sidebar and `main`-slot panel identifier for the Memory center page. */
export const PANEL_ID = 'memories' as MainPanelId

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Cross-project Memory center, Session incognito toggle, and Turn citation copy. */
    'memory.center': MemoryCenterKey
  }
}

/** Browser services required by the Memory center, Session incognito control, and Turn citations. */
export const inject = [
  'commandUi',
  'slots',
  'locale',
  'layout',
  'remote',
  'remote.memory',
  'remoteAccess',
  'uiConversation',
  'uiWorkspace',
  'sessions',
  'workspaces',
]

/**
 * Register the Memory center panel, Session incognito header toggle, and Turn-tail
 * citation pill while the active Peer is authorized to read `memory/catalog`.
 * @param ctx - browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }),
    'ui-memory: dictionaries',
  )
  const t = ctx.locale.bind(NS)
  ctx.effect(
    () => ctx.uiConversation.events.register(memoryTurnDefinition),
    'ui-memory: conversation definition',
  )

  ctx.remoteAccess.whenAccess('memory/catalog', function* () {
    const controller = createMemoryCatalogSource({
      catalog: () => ctx.remote.memory.catalog({}),
      create: request => ctx.remote.memory.create(request),
      update: request => ctx.remote.memory.update(request),
      remove: id => ctx.remote.memory.delete({ id }),
      clearScope: request => ctx.remote.memory.clearScope(request),
      setPreferences: patch => ctx.remote.memory.setPreferences(patch),
      getSessionPolicy: sessionId => ctx.remote.memory.getSessionPolicy({ sessionId }),
      setSessionPolicy: (sessionId, incognito) => ctx.remote.memory.setSessionPolicy({ sessionId, incognito }),
      subscribeChanged: listener => ctx.remote.$on('memory/changed', listener),
      subscribeReset: listener => ctx.on('connection/reset', listener),
    })

    const openSourceSession = (id: SessionId): void => {
      if (isSessionAvailable(id, ctx.sessions.list.getSnapshot(), ctx.workspaces.list.getSnapshot())) {
        ctx.uiWorkspace.openSession(id)
      }
    }

    yield ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main',
      key: PANEL_ID,
      locale: NS,
      inject: (): MemoryCenterInjected => ({
        hooks: controller.hooks,
        onRefresh: controller.refresh,
        onCreateEntry: controller.createEntry,
        onUpdateEntry: controller.updateEntry,
        onDeleteEntry: controller.deleteEntry,
        onClearScope: controller.clearScope,
        onUpdatePreferences: controller.updatePreferences,
        onOpenSession: openSourceSession,
      }),
    }, MemoryCenterPage))

    yield ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist',
      id: PANEL_ID,
      order: 15,
      locale: NS,
      label: () => t('panel'),
    }, MemoryCenterIcon))

    yield ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
      name: 'conversation.input.left',
      id: 'memory-incognito',
      order: 0,
      locale: NS,
      inject: (): SessionIncognitoInjected => ({
        hooks: controller.hooks,
        ensureSessionPolicy: controller.ensureSessionPolicy,
        setSessionIncognito: controller.setSessionIncognito,
      }),
    }, SessionIncognitoAction))

    yield ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
      name: 'conversation.chat.turnTail',
      id: 'memory-citations',
      order: 15,
      locale: NS,
      inject: (): MemoryCitationsInjected => ({
        hooks: controller.hooks,
        onUpdateEntry: controller.updateEntry,
        onDeleteEntry: controller.deleteEntry,
        onOpenMemoryCenter: () => {
          ctx.layout.selectPanel(PANEL_ID)
        },
      }),
    }, MemoryCitationsPill))

    yield ctx.remoteAccess.whenAccess('memory/setSessionPolicy', () => ctx.commandUi.register({
      name: 'incognito',
      label: () => t('incognito.badge'),
      description: () => t('incognito.tooltipOff'),
      icon: IconEyeOffOutlineRegular,
      available: session => ctx.sessions.binding(session.sessionId)?.session.getSnapshot().openState === 'open',
      ui: {
        kind: 'action',
        run: ({ sessionId }) => {
          void controller.toggleSessionIncognito(sessionId)
        },
      },
    }))
  })
}
