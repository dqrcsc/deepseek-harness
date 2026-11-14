// @vitest-environment jsdom
/**
 * Integration and component tests for `@deepseek-ai/dsh-client-ui-memory`:
 * plugin registration (`src/index.ts`, `src/client/index.ts`), `MemoryCenterIcon`,
 * `SessionIncognitoAction`, `MemoryCitationsPill`, and `MemoryCenterPage`.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId, WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import {
  bindSnapshotSelector,
  makeTranslate,
  StaticRemoteAccess,
  stubConfigForm,
} from '@deepseek-ai/dsh-client-test-runtime'
import {
  UiConversation,
  type ConversationLocationDataSource,
  type ConversationLocationDataStore,
  type ConversationTurnDataMap,
  type TurnLocation,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { CommandContribution } from '@deepseek-ai/dsh-client-ui-commands/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import {
  resolveSlotLabel,
  type HostObservable,
  type PropsRuntime,
  type StoredEntry,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {
  MemoryCatalogResult,
  MemoryCitationItem,
  MemoryId,
  MemoryPreferences,
  MemoryRecord,
} from '@deepseek-ai/dsh-memory/client'
import { SessionSeq, type SessionId } from '@deepseek-ai/dsh-session/types'
import { apply as applyNode } from '../src/index.ts'
import { apply, inject, PANEL_ID } from '../src/client/index.ts'
import type { MemoryActionOutcome, MemoryCatalogSnapshot } from '../src/client/catalog-source.ts'
import { en } from '../src/client/locales.ts'
import { MemoryCenterIcon } from '../src/client/MemoryCenterIcon.tsx'
import {
  MemoryCenterPage,
  type MemoryCenterInjected,
  type MemoryCenterPageProps,
} from '../src/client/MemoryCenterPage.tsx'
import {
  MemoryCitationsPill,
  type MemoryCitationsInjected,
  type MemoryCitationsPillProps,
} from '../src/client/MemoryCitationsPill.tsx'
import type { MemoryTurnData } from '../src/client/memory-turn.ts'
import {
  SessionIncognitoAction,
  type SessionIncognitoActionProps,
} from '../src/client/SessionIncognitoAction.tsx'

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

const t = makeTranslate(en)
const SESSION_OPEN = 'sess-open' as SessionId
const SESSION_GONE = 'sess-gone' as SessionId
const MEM_GLOBAL = 'mem-global' as MemoryId
const MEM_WS = 'mem-ws' as MemoryId
const MEM_DELETED = 'mem-deleted' as MemoryId

const PREFS: MemoryPreferences = {
  autoExtractEnabled: true,
  autoInjectEnabled: true,
  incognitoIsolatesRead: false,
}

const GLOBAL_RECORD: MemoryRecord = {
  id: MEM_GLOBAL,
  content: 'Always summarize architecture decisions concisely.',
  category: 'preference',
  scope: { kind: 'global' },
  source: { kind: 'user' },
  status: 'active',
  pinned: true,
  createdAt: '2026-11-14T01:00:00.000Z',
  updatedAt: '2026-11-14T01:00:00.000Z',
}

const WORKSPACE_RECORD: MemoryRecord = {
  id: MEM_WS,
  content: 'Run pnpm test:docs after editing Markdown.',
  category: 'workflow',
  scope: { kind: 'workspace', workspacePath: '/Users/dev/repo-alpha' },
  source: { kind: 'auto', sessionId: SESSION_OPEN },
  status: 'paused',
  pinned: false,
  createdAt: '2026-11-14T02:00:00.000Z',
  updatedAt: '2026-11-14T02:00:00.000Z',
}

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

class StubTurnStore implements ConversationLocationDataStore<ConversationTurnDataMap> {
  private readonly map = new Map<string, unknown>()

  get<K extends Extract<keyof ConversationTurnDataMap, string>>(
    key: K,
  ): Readonly<ConversationTurnDataMap[K]> | undefined {
    return this.map.get(key) as Readonly<ConversationTurnDataMap[K]> | undefined
  }

  source<K extends Extract<keyof ConversationTurnDataMap, string>>(
    key: K,
  ): ConversationLocationDataSource<Readonly<ConversationTurnDataMap[K]> | undefined> {
    return {
      getSnapshot: () => this.get(key),
      subscribe: () => () => {},
    }
  }

  set(data: MemoryTurnData): void {
    this.map.set('memory-citations', data)
  }
}

function makeTurn(items?: readonly MemoryCitationItem[]): TurnLocation {
  const store = new StubTurnStore()
  if (items !== undefined) store.set({ items })
  return {
    turn: 1,
    start: undefined,
    status: 'closed',
    steps: [],
    data: store,
    end: undefined,
  }
}

class RemoteServiceStub extends Service {
  constructor(
    ctx: Context,
    readonly $on: (event: 'memory/changed', listener: () => void) => () => void,
  ) {
    super(ctx, 'remote')
  }
}

const EmptySlotOwner = () => null

function injectedFace(entry: StoredEntry | undefined): object {
  if (entry === undefined) throw new Error('missing slot entry')
  const face = entry.inject?.()
  if (face === undefined) throw new Error('slot entry injected no face')
  return face
}

describe('ui-memory node and browser plugin wiring', () => {
  it('runs the node stub and gates browser slot contributions by memory/catalog access', async () => {
    applyNode()
    expect(inject).toContain('remote.memory')

    const selectPanel = vi.fn()
    const openSession = vi.fn()
    const memoryRemote = {
      catalog: vi.fn(async (): Promise<RemoteResult<MemoryCatalogResult>> => ({
        ok: true,
        value: { items: [GLOBAL_RECORD], preferences: PREFS },
      })),
      create: vi.fn(async () => ({ ok: true, value: GLOBAL_RECORD } as const)),
      update: vi.fn(async () => ({ ok: true, value: { updated: true, record: GLOBAL_RECORD } } as const)),
      delete: vi.fn(async ({ id }: { id: MemoryId }) => ({ ok: true, value: { id, deleted: true } } as const)),
      clearScope: vi.fn(async () => ({ ok: true, value: { deletedCount: 1 } } as const)),
      setPreferences: vi.fn(async (patch: Partial<MemoryPreferences>) => ({
        ok: true,
        value: { ...PREFS, ...patch },
      } as const)),
      getSessionPolicy: vi.fn(async ({ sessionId }: { sessionId: SessionId }) => ({
        ok: true,
        value: { sessionId, incognito: true },
      } as const)),
      setSessionPolicy: vi.fn(async ({ sessionId, incognito }: { sessionId: SessionId; incognito: boolean }) => ({
        ok: true,
        value: { sessionId, incognito },
      } as const)),
    }

    const setup = async (allowCatalog: boolean) => {
      const ctx = new Context()
      await ctx.plugin(SlotRegistry).await()
      new StaticRemoteAccess(ctx, action => (action === 'memory/catalog' ? allowCatalog : true))
      new UiConversation(ctx, { binding: () => undefined } as never)
      new RemoteServiceStub(ctx, () => () => {})
      await ctx.plugin({
        apply(provider: Context) {
          provider.provide('remote.memory', memoryRemote as never)
        },
      }).await()
      ctx.provide('configForms', { get: () => stubConfigForm().scope } as never)
      ctx.provide('layout', { selectPanel } as never)
      ctx.provide('uiWorkspace', { openSession } as never)
      const sessions: SessionListState = {
        ids: [SESSION_OPEN],
        byId: {
          [SESSION_OPEN]: {
            id: SESSION_OPEN,
            displayTitle: SESSION_OPEN,
            running: false,
            blank: false,
            updatedAt: 0,
            retainedBy: {},
          },
        },
        phase: 'ready',
        projectionsBySession: {},
      }
      const workspaces: WorkspaceSnapshot = {
        items: [],
        archivedSessionIds: [],
        pinnedSessionIds: [],
        state: 'idle',
        phase: 'ready',
        error: null,
      }
      let registeredCommand: CommandContribution | undefined
      ctx.provide('sessions', {
        list: { getSnapshot: () => sessions, subscribe: () => () => {} },
        binding: (id: SessionId) => (
          id === SESSION_OPEN
            ? { session: { getSnapshot: () => ({ openState: 'open' }) } }
            : undefined
        ),
      } as never)
      ctx.provide('commandUi', {
        register: (contribution: CommandContribution) => {
          registeredCommand = contribution
          return () => {
            registeredCommand = undefined
          }
        },
      } as never)
      ctx.provide('workspaces', {
        list: { getSnapshot: () => workspaces, subscribe: () => () => {} },
      } as never)
      await ctx.plugin({ inject: [...localeInject], apply: applyLocale }).await()
      ctx.slots.register({
        name: 'root',
        children: {
          main: { kind: 'keyed', scope: 'root' },
          'sidebar.panellist': { kind: 'list', scope: 'root' },
          'conversation.input.left': { kind: 'list', scope: 'session' },
          'conversation.chat.turnTail': { kind: 'list', scope: 'session' },
        },
      } as never, EmptySlotOwner)
      const fiber = await ctx.plugin({ inject: [...inject], apply }).await()
      return { ctx, fiber, getRegisteredCommand: () => registeredCommand }
    }

    // Denied access mounts no memory slots or slash commands.
    const denied = await setup(false)
    expect(denied.ctx.slots.entries('main')).toHaveLength(0)
    expect(denied.ctx.slots.entries('sidebar.panellist')).toHaveLength(0)
    expect(denied.getRegisteredCommand()).toBeUndefined()
    await denied.fiber.dispose()

    // Allowed access mounts all four slots, registers /incognito, and wires every Remote endpoint.
    const allowed = await setup(true)
    const mainEntry = allowed.ctx.slots.entries('main').find(e => e.options.key === PANEL_ID)
    const navEntry = allowed.ctx.slots.entries('sidebar.panellist').find(e => e.options.id === PANEL_ID)
    const headerEntry = allowed.ctx.slots.entries('conversation.input.left')
      .find(e => e.options.id === 'memory-incognito')
    const tailEntry = allowed.ctx.slots.entries('conversation.chat.turnTail')
      .find(e => e.options.id === 'memory-citations')

    expect(mainEntry).toBeDefined()
    expect(navEntry).toBeDefined()
    expect(resolveSlotLabel(navEntry?.options.label)).toBeTruthy()
    expect(headerEntry).toBeDefined()
    expect(tailEntry).toBeDefined()

    const incognitoCmd = allowed.getRegisteredCommand()
    expect(incognitoCmd?.name).toBe('incognito')
    expect(incognitoCmd?.label?.()).toBeTruthy()
    expect(incognitoCmd?.description?.()).toBeTruthy()
    expect(incognitoCmd?.available?.({ sessionId: SESSION_OPEN })).toBe(true)
    expect(incognitoCmd?.available?.({ sessionId: SESSION_GONE })).toBe(false)
    if (incognitoCmd?.ui.kind === 'action') {
      incognitoCmd.ui.run({ sessionId: SESSION_OPEN })
    }

    const mainFace = injectedFace(mainEntry) as MemoryCenterInjected
    const unsub = mainFace.hooks.catalog.subscribe(() => {})
    await mainFace.onRefresh()
    await mainFace.onCreateEntry({ content: 'a', category: 'fact', scope: { kind: 'global' } })
    await mainFace.onUpdateEntry(MEM_GLOBAL, { pinned: false }, GLOBAL_RECORD.updatedAt)
    await mainFace.onDeleteEntry(MEM_GLOBAL)
    await mainFace.onClearScope({ kind: 'all' })
    await mainFace.onUpdatePreferences({ autoExtractEnabled: false })
    mainFace.onOpenSession(SESSION_OPEN)
    mainFace.onOpenSession(SESSION_GONE)
    expect(openSession).toHaveBeenCalledTimes(1)
    expect(openSession).toHaveBeenCalledWith(SESSION_OPEN)
    unsub()

    const headerFace = injectedFace(headerEntry) as {
      ensureSessionPolicy: (id: SessionId) => Promise<void>
      setSessionIncognito: (id: SessionId, next: boolean) => Promise<MemoryActionOutcome>
    }
    await headerFace.ensureSessionPolicy(SESSION_OPEN)
    await headerFace.setSessionIncognito(SESSION_OPEN, false)
    expect(memoryRemote.getSessionPolicy).toHaveBeenCalledWith({ sessionId: SESSION_OPEN })
    expect(memoryRemote.setSessionPolicy).toHaveBeenCalledWith({ sessionId: SESSION_OPEN, incognito: false })

    const tailFace = injectedFace(tailEntry) as MemoryCitationsInjected
    tailFace.onOpenMemoryCenter()
    expect(selectPanel).toHaveBeenCalledWith(PANEL_ID)

    await allowed.fiber.dispose()
    expect(allowed.getRegisteredCommand()).toBeUndefined()
  })

  it('renders MemoryCenterIcon with requested size', () => {
    const iconProps: PropsRuntime<'sidebar.panellist'> = {
      ...({} as PropsRuntime<'sidebar.panellist'>),
      size: 18,
    }
    const { container } = render(<MemoryCenterIcon {...iconProps} />)
    expect(container.querySelector('svg')).not.toBeNull()
  })
})

describe('SessionIncognitoAction', () => {
  it('hides when unauthorized, closed, or non-incognito, and disables incognito when active badge is clicked', async () => {
    const catalogObs = makeObservable<MemoryCatalogSnapshot>({
      items: [],
      preferences: PREFS,
      status: 'ready',
      settled: true,
      sessionIncognito: { [SESSION_OPEN]: false },
    })
    const ensureSessionPolicy = vi.fn(async () => {})
    const setSessionIncognito = vi.fn(async (_id: SessionId, next: boolean): Promise<MemoryActionOutcome> => {
      catalogObs.set({
        ...catalogObs.source.getSnapshot(),
        sessionIncognito: { [SESSION_OPEN]: next },
      })
      return { ok: true }
    })

    const baseProps = (openState: 'open' | 'opening', allowed: boolean): SessionIncognitoActionProps => ({
      ...({} as PropsRuntime<'conversation.input.left'>),
      sessionId: SESSION_OPEN,
      useAccess: () => allowed,
      useSession: selector => selector({ openState } as never),
      useCatalog: bindSnapshotSelector(catalogObs.source),
      ensureSessionPolicy,
      setSessionIncognito,
      t,
    })

    const unauthorized = render(<SessionIncognitoAction {...baseProps('open', false)} />)
    expect(unauthorized.container.firstChild).toBeNull()
    unauthorized.unmount()

    const opening = render(<SessionIncognitoAction {...baseProps('opening', true)} />)
    expect(opening.container.firstChild).toBeNull()
    expect(ensureSessionPolicy).not.toHaveBeenCalled()
    opening.unmount()

    const active = render(<SessionIncognitoAction {...baseProps('open', true)} />)
    expect(ensureSessionPolicy).toHaveBeenCalledWith(SESSION_OPEN)
    expect(active.container.firstChild).toBeNull()

    act(() => {
      catalogObs.set({
        ...catalogObs.source.getSnapshot(),
        sessionIncognito: { [SESSION_OPEN]: true },
      })
    })
    const activeButton = screen.getByRole('button', { name: en['incognito.disableLabel'] })
    expect(activeButton.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText(en['incognito.badge'])).toBeTruthy()

    await act(async () => {
      fireEvent.click(activeButton)
    })
    expect(setSessionIncognito).toHaveBeenCalledWith(SESSION_OPEN, false)
    expect(active.container.firstChild).toBeNull()
  })
})

describe('MemoryCitationsPill', () => {
  const CITATION_GLOBAL: MemoryCitationItem = {
    id: MEM_GLOBAL,
    content: GLOBAL_RECORD.content,
    category: 'preference',
    scope: { kind: 'global' },
    pinned: true,
    sourceKind: 'user',
  }
  const CITATION_WS: MemoryCitationItem = {
    id: MEM_WS,
    content: WORKSPACE_RECORD.content,
    category: 'workflow',
    scope: { kind: 'workspace', workspacePath: '/Users/dev/repo-alpha' },
    pinned: false,
    sourceKind: 'auto',
    sourceSessionId: SESSION_OPEN,
  }
  const CITATION_DELETED: MemoryCitationItem = {
    id: MEM_DELETED,
    content: 'Obsolete note.',
    category: 'fact',
    scope: { kind: 'global' },
    pinned: false,
    sourceKind: 'user',
  }

  function renderPill(
    items: readonly MemoryCitationItem[],
    snapshot: MemoryCatalogSnapshot,
    overrides: Partial<Pick<MemoryCitationsInjected, 'onUpdateEntry' | 'onDeleteEntry' | 'onOpenMemoryCenter'>> = {},
  ) {
    const obs = makeObservable(snapshot)
    const onUpdateEntry = overrides.onUpdateEntry ?? vi.fn(async () => ({ ok: true } as const))
    const onDeleteEntry = overrides.onDeleteEntry ?? vi.fn(async () => ({ ok: true } as const))
    const onOpenMemoryCenter = overrides.onOpenMemoryCenter ?? vi.fn()
    const props: MemoryCitationsPillProps = {
      ...({} as PropsRuntime<'conversation.chat.turnTail'>),
      seq: SessionSeq(10),
      openFile: vi.fn(),
      turn: makeTurn(items),
      useCatalog: bindSnapshotSelector(obs.source),
      onUpdateEntry,
      onDeleteEntry,
      onOpenMemoryCenter,
      t,
    }
    return { ...render(<MemoryCitationsPill {...props} />), obs, onUpdateEntry, onDeleteEntry, onOpenMemoryCenter }
  }

  it('returns null without citations and supports singular/plural labels, Escape, and Memory center jump', () => {
    const empty = renderPill([], {
      items: [],
      preferences: PREFS,
      status: 'loading',
      settled: false,
      sessionIncognito: {},
    })
    expect(empty.container.firstChild).toBeNull()
    empty.unmount()

    const single = renderPill([CITATION_GLOBAL], {
      items: [],
      preferences: PREFS,
      status: 'loading',
      settled: false,
      sessionIncognito: {},
    })
    const pill = screen.getByRole('button', { name: 'Used 1 memory' })
    fireEvent.keyDown(pill, { key: 'Escape' })
    fireEvent.click(pill)
    expect(screen.getByRole('dialog', { name: en['citations.heading'] })).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' })
    expect(screen.queryByRole('dialog')).not.toBeNull()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(pill)
    fireEvent.click(screen.getByRole('button', { name: en['citations.openCenter'] }))
    expect(single.onOpenMemoryCenter).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('reconciles live active, paused, and deleted cited entries and handles inline pause, edit, and delete', async () => {
    const onUpdateEntry = vi.fn()
      .mockResolvedValueOnce({ ok: false, errorKey: 'error.conflict' })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, errorKey: 'error.sensitive' })
      .mockResolvedValueOnce({ ok: true })
    const onDeleteEntry = vi.fn()
      .mockResolvedValueOnce({ ok: false, errorKey: 'error.save' })
      .mockResolvedValueOnce({ ok: true })

    renderPill(
      [CITATION_GLOBAL, CITATION_WS, CITATION_DELETED],
      {
        items: [GLOBAL_RECORD, WORKSPACE_RECORD],
        preferences: PREFS,
        status: 'ready',
        settled: true,
        sessionIncognito: {},
      },
      { onUpdateEntry, onDeleteEntry },
    )

    fireEvent.click(screen.getByRole('button', { name: 'Used 3 memories' }))
    const dialog = screen.getByRole('dialog', { name: en['citations.heading'] })
    expect(within(dialog).getByText(en['status.paused'])).toBeTruthy()
    expect(within(dialog).getByText(en['status.deleted'])).toBeTruthy()
    expect(within(dialog).getByText('Workspace: repo-alpha')).toBeTruthy()

    // Toggle active -> paused (first fails with conflict, second succeeds on paused -> active).
    const switches = within(dialog).getAllByRole('switch')
    await act(async () => {
      fireEvent.click(switches[0]!)
    })
    expect(within(dialog).getByRole('alert').textContent).toBe(en['error.conflict'])

    await act(async () => {
      fireEvent.click(switches[1]!)
    })
    expect(onUpdateEntry).toHaveBeenNthCalledWith(
      2,
      MEM_WS,
      { status: 'active' },
      WORKSPACE_RECORD.updatedAt,
    )

    // Inline edit: open, cancel, re-open, fail save, succeed save.
    const editButtons = within(dialog).getAllByRole('button', { name: en['action.edit'] })
    fireEvent.click(editButtons[0]!)
    fireEvent.click(within(dialog).getByRole('button', { name: en['action.cancel'] }))

    fireEvent.click(within(dialog).getAllByRole('button', { name: en['action.edit'] })[0]!)
    const textarea = within(dialog).getByRole('textbox', { name: en['form.contentLabel'] })
    fireEvent.change(textarea, { target: { value: 'Updated concise preference.' } })

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: en['action.save'] }))
    })
    expect(within(dialog).getByRole('alert').textContent).toBe(en['error.sensitive'])

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: en['action.save'] }))
    })
    expect(within(dialog).queryByRole('textbox', { name: en['form.contentLabel'] })).toBeNull()

    // Delete: first fails, second succeeds.
    const deleteButtons = within(dialog).getAllByRole('button', { name: en['action.delete'] })
    await act(async () => {
      fireEvent.click(deleteButtons[0]!)
    })
    expect(within(dialog).getByRole('alert').textContent).toBe(en['error.save'])

    await act(async () => {
      fireEvent.click(deleteButtons[0]!)
    })
    expect(onDeleteEntry).toHaveBeenCalledTimes(2)
  })
})

describe('MemoryCenterPage', () => {
  function mountPage(
    initialCatalog: MemoryCatalogSnapshot,
    overrides: Partial<MemoryCenterInjected> = {},
    workspaceItems: WorkspaceSnapshot['items'] = [
      {
        workspaceId: 'ws-1' as WorkspaceId,
        title: 'Alpha',
        path: '/Users/dev/repo-alpha',
        sessionIds: [SESSION_OPEN],
        createdAt: '2026-11-14T00:00:00.000Z',
        updatedAt: '2026-11-14T00:00:00.000Z',
      },
      {
        workspaceId: 'ws-2' as WorkspaceId,
        title: 'Beta',
        path: '/Users/dev/repo-beta',
        sessionIds: [],
        createdAt: '2026-11-14T00:00:00.000Z',
        updatedAt: '2026-11-14T00:00:00.000Z',
      },
      {
        workspaceId: 'ws-blank' as WorkspaceId,
        title: 'Blank',
        path: '   ',
        sessionIds: [],
        createdAt: '2026-11-14T00:00:00.000Z',
        updatedAt: '2026-11-14T00:00:00.000Z',
      },
    ],
  ) {
    const catalogObs = makeObservable(initialCatalog)
    const sessionsObs = makeObservable<SessionListState>({
      ids: [SESSION_OPEN],
      byId: {},
      phase: 'ready',
      projectionsBySession: {},
    })
    const workspacesObs = makeObservable<WorkspaceSnapshot>({
      items: workspaceItems,
      archivedSessionIds: [],
      pinnedSessionIds: [],
      state: 'idle',
      phase: 'ready',
      error: null,
    })

    const onRefresh = overrides.onRefresh ?? vi.fn(async () => {})
    const onCreateEntry = overrides.onCreateEntry ?? vi.fn(async () => ({ ok: true } as const))
    const onUpdateEntry = overrides.onUpdateEntry ?? vi.fn(async () => ({ ok: true } as const))
    const onDeleteEntry = overrides.onDeleteEntry ?? vi.fn(async () => ({ ok: true } as const))
    const onClearScope = overrides.onClearScope ?? vi.fn(async () => ({ ok: true } as const))
    const onUpdatePreferences = overrides.onUpdatePreferences ?? vi.fn(async () => ({ ok: true } as const))
    const onOpenSession = overrides.onOpenSession ?? vi.fn()

    const props: MemoryCenterPageProps = {
      ...({} as PropsRuntime<'main'>),
      useCatalog: bindSnapshotSelector(catalogObs.source),
      useSessions: bindSnapshotSelector(sessionsObs.source),
      useWorkspaces: bindSnapshotSelector(workspacesObs.source),
      onRefresh,
      onCreateEntry,
      onUpdateEntry,
      onDeleteEntry,
      onClearScope,
      onUpdatePreferences,
      onOpenSession,
      t,
    }

    return {
      ...render(<MemoryCenterPage {...props} />),
      catalogObs,
      onRefresh,
      onCreateEntry,
      onUpdateEntry,
      onDeleteEntry,
      onClearScope,
      onUpdatePreferences,
      onOpenSession,
    }
  }

  it('renders loading, load error + retry, and empty catalog + Add memory modal validation and creation', async () => {
    const onCreateEntry = vi.fn()
      .mockResolvedValueOnce({ ok: false, errorKey: 'error.sensitive' })
      .mockResolvedValueOnce({ ok: true })

    const view = mountPage(
      {
        items: [],
        preferences: PREFS,
        status: 'loading',
        settled: false,
        sessionIncognito: {},
      },
      { onCreateEntry },
      [],
    )

    expect(screen.getByText(en.loading)).toBeTruthy()

    await act(async () => {
      view.catalogObs.set({
        items: [],
        preferences: PREFS,
        status: 'error',
        settled: false,
        sessionIncognito: {},
      })
    })
    fireEvent.click(screen.getByRole('button', { name: en['action.retry'] }))
    expect(view.onRefresh).toHaveBeenCalledTimes(1)

    await act(async () => {
      view.catalogObs.set({
        items: [],
        preferences: PREFS,
        status: 'ready',
        settled: true,
        sessionIncognito: {},
      })
    })
    expect(screen.getByText(en['empty.title'])).toBeTruthy()

    // Open Add modal from Workspace tab with no workspaceChoices -> default workspace path is ''
    fireEvent.click(screen.getByRole('button', { name: 'Workspace (0)' }))
    const addButtons = screen.getAllByRole('button', { name: en.add })
    fireEvent.click(addButtons[1]!)

    const modal = screen.getByRole('dialog', { name: en['form.addTitle'] })
    // Saving workspace scope with blank path shows invalidScope error without calling RPC.
    fireEvent.click(within(modal).getByRole('button', { name: en['action.save'] }))
    expect(within(modal).getByRole('alert').textContent).toBe(en['error.invalidScope'])
    expect(onCreateEntry).not.toHaveBeenCalled()

    // Fill fields, toggle pin, change category/scope, trigger error then succeed.
    fireEvent.change(within(modal).getByPlaceholderText(en['form.contentPlaceholder']), {
      target: { value: 'Prefer dark high-contrast diagrams.' },
    })
    const selects = within(modal).getAllByRole('combobox')
    fireEvent.change(selects[0]!, { target: { value: 'fact' } })
    fireEvent.change(within(modal).getByPlaceholderText(en['form.workspacePlaceholder']), {
      target: { value: '/Users/dev/new-ws' },
    })
    fireEvent.click(within(modal).getByRole('switch', { name: en['form.pinLabel'] }))

    await act(async () => {
      fireEvent.click(within(modal).getByRole('button', { name: en['action.save'] }))
    })
    expect(within(modal).getByRole('alert').textContent).toBe(en['error.sensitive'])

    // Switch to global scope and save successfully.
    fireEvent.change(selects[1]!, { target: { value: 'global' } })
    await act(async () => {
      fireEvent.click(within(modal).getByRole('button', { name: en['action.save'] }))
    })
    expect(onCreateEntry).toHaveBeenNthCalledWith(2, {
      content: 'Prefer dark high-contrast diagrams.',
      category: 'fact',
      scope: { kind: 'global' },
      pinned: true,
    })
    expect(screen.queryByRole('dialog', { name: en['form.addTitle'] })).toBeNull()

    // Open and close Add modal via Cancel and Escape/close button.
    fireEvent.click(screen.getAllByRole('button', { name: en.add })[0]!)
    fireEvent.click(within(screen.getByRole('dialog', { name: en['form.addTitle'] }))
      .getByRole('button', { name: en['action.cancel'] }))
    expect(screen.queryByRole('dialog', { name: en['form.addTitle'] })).toBeNull()

    fireEvent.click(screen.getAllByRole('button', { name: en.add })[0]!)
    fireEvent.click(within(screen.getByRole('dialog', { name: en['form.addTitle'] }))
      .getByRole('button', { name: en['action.close'] }))
    expect(screen.queryByRole('dialog', { name: en['form.addTitle'] })).toBeNull()

    // Edit a global record when workspaceChoices is empty so fallback '' is exercised.
    act(() => {
      view.catalogObs.set({
        items: [GLOBAL_RECORD],
        preferences: PREFS,
        status: 'ready',
        settled: true,
        sessionIncognito: {},
      })
    })
    fireEvent.click(screen.getByRole('button', { name: 'All (1)' }))
    fireEvent.click(screen.getByRole('button', { name: en['action.edit'] }))
    fireEvent.click(screen.getByRole('button', { name: en['action.cancel'] }))
  })

  it('supports preference switches, scope/workspace/category/search filters, card actions, inline edit, and clear scopes', async () => {
    const onUpdatePreferences = vi.fn()
      .mockResolvedValueOnce({ ok: false, errorKey: 'error.save' })
      .mockResolvedValue({ ok: true })
    const onUpdateEntry = vi.fn()
      .mockResolvedValueOnce({ ok: false, errorKey: 'error.conflict' }) // pin fail
      .mockResolvedValueOnce({ ok: true }) // unpin ok
      .mockResolvedValueOnce({ ok: false, errorKey: 'error.save' }) // switch fail
      .mockResolvedValueOnce({ ok: true }) // switch ok
      .mockResolvedValueOnce({ ok: false, errorKey: 'error.tooLong' }) // inline edit fail
      .mockResolvedValueOnce({ ok: true }) // inline edit ok
    const onDeleteEntry = vi.fn()
      .mockResolvedValueOnce({ ok: false, errorKey: 'error.save' })
      .mockResolvedValueOnce({ ok: true })
    const onClearScope = vi.fn()
      .mockResolvedValueOnce({ ok: false, errorKey: 'error.save' })
      .mockResolvedValue({ ok: true })

    const view = mountPage(
      {
        items: [GLOBAL_RECORD, WORKSPACE_RECORD],
        preferences: PREFS,
        status: 'ready',
        settled: true,
        sessionIncognito: {},
      },
      { onUpdatePreferences, onUpdateEntry, onDeleteEntry, onClearScope },
    )

    // Preference switches (3 switches in prefs panel).
    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: en['prefs.autoExtract.label'] }))
    })
    expect(screen.getByRole('alert').textContent).toBe(en['error.save'])

    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: en['prefs.autoInject.label'] }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: en['prefs.incognitoIsolatesRead.label'] }))
    })
    expect(onUpdatePreferences).toHaveBeenCalledTimes(3)

    // Scope + workspace dropdown + category + search filtering.
    fireEvent.click(screen.getByRole('button', { name: 'Global (1)' }))
    expect(screen.queryByText(WORKSPACE_RECORD.content)).toBeNull()
    // Open Add modal while on Global tab so default scope is 'global' and workspaceChoices[0] is prefilled.
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    fireEvent.click(within(screen.getByRole('dialog', { name: en['form.addTitle'] }))
      .getByRole('button', { name: en['action.cancel'] }))

    fireEvent.click(screen.getByRole('button', { name: 'Workspace (1)' }))
    expect(screen.getByText(WORKSPACE_RECORD.content)).toBeTruthy()
    const wsSelect = screen.getByRole('combobox', { name: en['form.workspaceLabel'] })
    fireEvent.change(wsSelect, { target: { value: '/Users/dev/repo-beta' } })
    expect(screen.queryByText(WORKSPACE_RECORD.content)).toBeNull()
    fireEvent.change(wsSelect, { target: { value: '/Users/dev/repo-alpha' } })
    expect(screen.getByText(WORKSPACE_RECORD.content)).toBeTruthy()

    // Open Add modal while workspace filter is selected so addWorkspacePath picks workspaceFilter.
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    fireEvent.click(within(screen.getByRole('dialog', { name: en['form.addTitle'] }))
      .getByRole('button', { name: en['action.cancel'] }))

    // Clear modal for specific workspace -> clearModal.titleWorkspace.
    fireEvent.click(screen.getByRole('button', { name: en.clear }))
    const clearWsDialog = screen.getByRole('dialog', { name: en['clearModal.titleWorkspace'] })
    await act(async () => {
      fireEvent.click(within(clearWsDialog).getByRole('button', { name: en['clearModal.confirm'] }))
    })
    expect(onClearScope).toHaveBeenNthCalledWith(1, {
      kind: 'workspace',
      workspacePath: '/Users/dev/repo-alpha',
    })
    expect(screen.getByRole('alert').textContent).toBe(en['error.save'])

    // Reset filters back to All + test category chips & search.
    fireEvent.change(wsSelect, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'All (2)' }))
    fireEvent.click(screen.getByRole('button', { name: en['category.workflow'] }))
    expect(screen.queryByText(GLOBAL_RECORD.content)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en['category.all'] }))

    const searchInput = screen.getByRole('searchbox', { name: en['search.label'] })
    fireEvent.change(searchInput, { target: { value: 'repo-alpha' } })
    expect(screen.getByText(WORKSPACE_RECORD.content)).toBeTruthy()
    fireEvent.change(searchInput, { target: { value: 'nonexistent-xyz' } })
    expect(screen.getByText(en['empty.filtered'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['action.clearSearch'] }))
    expect(screen.getByText(GLOBAL_RECORD.content)).toBeTruthy()

    // Card actions: Pin/Unpin, Enable/Pause switch, Open source session, Delete, Inline edit.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en['action.pin'] }))
    })
    expect(screen.getByRole('alert').textContent).toBe(en['error.conflict'])
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en['action.unpin'] }))
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: en['action.pause'] }))
    })
    expect(screen.getByRole('alert').textContent).toBe(en['error.save'])
    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: en['action.enable'] }))
    })

    fireEvent.click(screen.getByRole('button', { name: en['action.openSession'] }))
    expect(view.onOpenSession).toHaveBeenCalledWith(SESSION_OPEN)

    // Inline edit on global record -> cancel -> edit on workspace record -> blank path error -> fail save -> ok save.
    fireEvent.click(screen.getAllByRole('button', { name: en['action.edit'] })[0]!)
    fireEvent.click(screen.getByRole('button', { name: en['action.cancel'] }))

    fireEvent.click(screen.getAllByRole('button', { name: en['action.edit'] })[1]!)
    const pathInput = screen.getByLabelText(en['form.workspaceLabel'])
    fireEvent.change(pathInput, { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: en['action.save'] }))
    expect(screen.getByRole('alert').textContent).toBe(en['error.invalidScope'])

    fireEvent.change(pathInput, { target: { value: '/Users/dev/repo-beta' } })
    fireEvent.change(screen.getByRole('textbox', { name: en['form.contentLabel'] }), {
      target: { value: 'Run test:docs and oxlint.' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: en['form.categoryLabel'] }), {
      target: { value: 'constraint' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en['action.save'] }))
    })
    expect(screen.getByRole('alert').textContent).toBe(en['error.tooLong'])

    fireEvent.change(screen.getByRole('combobox', { name: en['form.scopeLabel'] }), {
      target: { value: 'global' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en['action.save'] }))
    })
    expect(screen.queryByRole('textbox', { name: en['form.contentLabel'] })).toBeNull()

    // Delete card: fail then succeed.
    const delButtons = screen.getAllByRole('button', { name: en['action.delete'] })
    await act(async () => {
      fireEvent.click(delButtons[0]!)
    })
    expect(screen.getByRole('alert').textContent).toBe(en['error.save'])
    await act(async () => {
      fireEvent.click(delButtons[0]!)
    })
    expect(onDeleteEntry).toHaveBeenCalledTimes(2)

    // Clear modal for Global and All, plus Cancel and close.
    fireEvent.click(screen.getByRole('button', { name: 'Global (1)' }))
    fireEvent.click(screen.getByRole('button', { name: en.clear }))
    const clearGlobalDialog = screen.getByRole('dialog', { name: en['clearModal.titleGlobal'] })
    fireEvent.click(within(clearGlobalDialog).getByRole('button', { name: en['action.cancel'] }))
    expect(screen.queryByRole('dialog', { name: en['clearModal.titleGlobal'] })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: en.clear }))
    fireEvent.click(within(screen.getByRole('dialog', { name: en['clearModal.titleGlobal'] }))
      .getByRole('button', { name: en['action.close'] }))
    expect(screen.queryByRole('dialog', { name: en['clearModal.titleGlobal'] })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: en.clear }))
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog', { name: en['clearModal.titleGlobal'] }))
        .getByRole('button', { name: en['clearModal.confirm'] }))
    })
    expect(onClearScope).toHaveBeenLastCalledWith({ kind: 'global' })

    fireEvent.click(screen.getByRole('button', { name: 'All (2)' }))
    fireEvent.click(screen.getByRole('button', { name: en.clear }))
    const clearAllDialog = screen.getByRole('dialog', { name: en['clearModal.titleAll'] })
    await act(async () => {
      fireEvent.click(within(clearAllDialog).getByRole('button', { name: en['clearModal.confirm'] }))
    })
    expect(onClearScope).toHaveBeenLastCalledWith({ kind: 'all' })
  })
})
