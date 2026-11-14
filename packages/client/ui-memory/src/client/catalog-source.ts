/**
 * Authoritative Host memory catalog, preferences, and per-Session incognito
 * policy observable shared across the Memory center page, Session header
 * incognito switch, and Turn-tail citation popovers.
 */

import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  MemoryCatalogResult,
  MemoryClearScopeRequest,
  MemoryClearScopeResult,
  MemoryCreateRequest,
  MemoryDeleteResult,
  MemoryId,
  MemoryPreferences,
  MemoryPreferencesPatch,
  MemoryRecord,
  MemoryUpdatePatch,
  MemoryUpdateResult,
  SessionMemoryPolicy,
} from '@deepseek-ai/dsh-memory/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MemoryCenterKey } from './locales.ts'

/** Localized error key returned when a Remote memory mutation fails. */
export type MemoryErrorKey = Extract<
  MemoryCenterKey,
  | 'error.save'
  | 'error.conflict'
  | 'error.sensitive'
  | 'error.empty'
  | 'error.tooLong'
  | 'error.capacity'
  | 'error.invalidScope'
>

/** Settled outcome of a memory or preference mutation. */
export type MemoryActionOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly errorKey: MemoryErrorKey }

/** Immutable snapshot published by {@link createMemoryCatalogSource}. */
export interface MemoryCatalogSnapshot {
  /** Authoritative active and paused memory entries from the latest settled read. */
  readonly items: readonly MemoryRecord[]
  /** Host-wide memory preferences from the latest settled read or update. */
  readonly preferences: MemoryPreferences
  /** Catalog fetch status. */
  readonly status: 'loading' | 'ready' | 'error'
  /** Whether at least one authoritative catalog read has succeeded. */
  readonly settled: boolean
  /** Cached incognito flags keyed by `SessionId`. */
  readonly sessionIncognito: Readonly<Record<string, boolean>>
}

/** Remote endpoints and invalidation subscriptions consumed by {@link createMemoryCatalogSource}. */
export interface MemoryCatalogDependencies {
  readonly catalog: () => Promise<RemoteResult<MemoryCatalogResult>>
  readonly create: (request: MemoryCreateRequest) => Promise<RemoteResult<MemoryRecord>>
  readonly update: (request: {
    readonly id: MemoryId
    readonly patch: MemoryUpdatePatch
    readonly expectedUpdatedAt?: string
  }) => Promise<RemoteResult<MemoryUpdateResult>>
  readonly remove: (id: MemoryId) => Promise<RemoteResult<MemoryDeleteResult>>
  readonly clearScope: (request: MemoryClearScopeRequest) => Promise<RemoteResult<MemoryClearScopeResult>>
  readonly setPreferences: (patch: MemoryPreferencesPatch) => Promise<RemoteResult<MemoryPreferences>>
  readonly getSessionPolicy: (sessionId: SessionId) => Promise<RemoteResult<SessionMemoryPolicy>>
  readonly setSessionPolicy: (sessionId: SessionId, incognito: boolean) => Promise<RemoteResult<SessionMemoryPolicy>>
  readonly subscribeChanged: (listener: () => void) => () => void
  readonly subscribeReset: (listener: () => void) => () => void
}

/** Shared catalog hooks and actions injected into Memory UI surfaces. */
export interface MemoryCatalogController {
  readonly hooks: { readonly catalog: HostObservable<MemoryCatalogSnapshot> }
  readonly refresh: () => Promise<void>
  readonly createEntry: (request: MemoryCreateRequest) => Promise<MemoryActionOutcome>
  readonly updateEntry: (
    id: MemoryId,
    patch: MemoryUpdatePatch,
    expectedUpdatedAt?: string,
  ) => Promise<MemoryActionOutcome>
  readonly deleteEntry: (id: MemoryId) => Promise<MemoryActionOutcome>
  readonly clearScope: (scope: MemoryClearScopeRequest['scope']) => Promise<MemoryActionOutcome>
  readonly updatePreferences: (patch: MemoryPreferencesPatch) => Promise<MemoryActionOutcome>
  readonly ensureSessionPolicy: (sessionId: SessionId) => Promise<void>
  readonly setSessionIncognito: (sessionId: SessionId, incognito: boolean) => Promise<MemoryActionOutcome>
  readonly toggleSessionIncognito: (sessionId: SessionId) => Promise<MemoryActionOutcome>
}

const DEFAULT_PREFERENCES: MemoryPreferences = {
  autoExtractEnabled: true,
  autoInjectEnabled: true,
  incognitoIsolatesRead: false,
}

/**
 * Map a structured `RemoteFailure` from `remote.memory.*` onto a localized error message key.
 * @param failure - Remote error returned by the Gateway.
 * @returns matching localized error key.
 */
export function mapMemoryRemoteError(failure: RemoteFailure): MemoryErrorKey {
  if (failure.code !== 'memory/input-invalid') return 'error.save'
  switch (failure.details.code) {
    case 'sensitive_content':
      return 'error.sensitive'
    case 'capacity_exceeded':
      return 'error.capacity'
    case 'invalid_scope':
      return 'error.invalidScope'
    case 'invalid_content':
      return 'error.empty'
    case 'empty_patch':
    case 'invalid_category':
      return 'error.save'
  }
}

/**
 * Extract the trailing directory name of a POSIX or Windows workspace path for compact badges.
 * @param workspacePath - normalized or raw workspace directory path.
 * @returns leaf folder name, or the trimmed path itself for a root directory.
 */
export function workspaceFolderName(workspacePath: string): string {
  const trimmed = workspacePath.replace(/[\\/]+$/u, '')
  const splitIndex = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (splitIndex < 0 || splitIndex === trimmed.length - 1) return workspacePath
  return trimmed.slice(splitIndex + 1)
}

/**
 * Check whether a recorded source Session is currently unarchived and present in the Host list.
 * @param id - source Session identifier recorded on a memory item.
 * @param sessions - current Session list projection.
 * @param workspaces - current Workspace and archive projection.
 * @returns `true` when `uiWorkspace.openSession(id)` can navigate to the Session.
 */
export function isSessionAvailable(
  id: SessionId,
  sessions: SessionListState,
  workspaces: WorkspaceSnapshot,
): boolean {
  if (workspaces.state === 'error') return false
  if (sessions.phase === 'pending' || workspaces.phase === 'pending') return false
  if (workspaces.archivedSessionIds.includes(id)) return false
  return sessions.ids.includes(id)
}

async function safeCall<T>(work: () => Promise<RemoteResult<T>>): Promise<RemoteResult<T> | undefined> {
  try {
    return await work()
  } catch (_error: unknown) {
    // Transport rejections use the same localized failure recovery as structured Remote errors.
    return undefined
  }
}

/**
 * Create the shared observable catalog and mutation controller for all Memory UI surfaces.
 * @param deps - Remote endpoints and event subscriptions.
 * @returns observable catalog hook plus mutation and per-Session policy methods.
 */
export function createMemoryCatalogSource(deps: MemoryCatalogDependencies): MemoryCatalogController {
  let snapshot: MemoryCatalogSnapshot = {
    items: [],
    preferences: DEFAULT_PREFERENCES,
    status: 'loading',
    settled: false,
    sessionIncognito: {},
  }
  const listeners = new Set<() => void>()
  const trackedSessions = new Set<SessionId>()
  let disposers: readonly (() => void)[] = []
  let epoch = 0

  const publish = (next: MemoryCatalogSnapshot): void => {
    snapshot = next
    for (const listener of listeners) listener()
  }

  const loadSessionPolicy = async (sessionId: SessionId, currentEpoch: number): Promise<void> => {
    const result = await safeCall(() => deps.getSessionPolicy(sessionId))
    if (currentEpoch !== epoch || result?.ok !== true) return
    if (snapshot.sessionIncognito[sessionId] === result.value.incognito) return
    publish({
      ...snapshot,
      sessionIncognito: {
        ...snapshot.sessionIncognito,
        [sessionId]: result.value.incognito,
      },
    })
  }

  const refresh = async (): Promise<void> => {
    const currentEpoch = ++epoch
    if (!snapshot.settled) {
      publish({ ...snapshot, status: 'loading' })
    }
    const [catalogResult] = await Promise.all([
      safeCall(() => deps.catalog()),
      ...[...trackedSessions].map(sessionId => loadSessionPolicy(sessionId, currentEpoch)),
    ])
    if (currentEpoch !== epoch) return
    if (catalogResult?.ok === true) {
      publish({
        ...snapshot,
        items: catalogResult.value.items,
        preferences: catalogResult.value.preferences,
        status: 'ready',
        settled: true,
      })
      return
    }
    publish({ ...snapshot, status: 'error' })
  }

  const observable: HostObservable<MemoryCatalogSnapshot> = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      const wasEmpty = listeners.size === 0
      listeners.add(listener)
      if (wasEmpty) {
        const reload = (): void => {
          void refresh()
        }
        disposers = [deps.subscribeChanged(reload), deps.subscribeReset(reload)]
        void refresh()
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          epoch += 1
          for (const dispose of disposers) dispose()
          disposers = []
        }
      }
    },
  }

  return {
    hooks: { catalog: observable },
    refresh,
    createEntry: async (request) => {
      const result = await safeCall(() => deps.create(request))
      if (result === undefined) return { ok: false, errorKey: 'error.save' }
      if (!result.ok) return { ok: false, errorKey: mapMemoryRemoteError(result.error) }
      await refresh()
      return { ok: true }
    },
    updateEntry: async (id, patch, expectedUpdatedAt) => {
      const result = await safeCall(() => deps.update({
        id,
        patch,
        ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
      }))
      if (result === undefined) return { ok: false, errorKey: 'error.save' }
      if (!result.ok) return { ok: false, errorKey: mapMemoryRemoteError(result.error) }
      if ('code' in result.value) {
        await refresh()
        return {
          ok: false,
          errorKey: result.value.code === 'memory_conflict' ? 'error.conflict' : 'error.save',
        }
      }
      await refresh()
      return { ok: true }
    },
    deleteEntry: async (id) => {
      const result = await safeCall(() => deps.remove(id))
      if (result === undefined || !result.ok) return { ok: false, errorKey: 'error.save' }
      await refresh()
      return { ok: true }
    },
    clearScope: async (scope) => {
      const result = await safeCall(() => deps.clearScope({ scope }))
      if (result === undefined) return { ok: false, errorKey: 'error.save' }
      if (!result.ok) return { ok: false, errorKey: mapMemoryRemoteError(result.error) }
      await refresh()
      return { ok: true }
    },
    updatePreferences: async (patch) => {
      const result = await safeCall(() => deps.setPreferences(patch))
      if (result === undefined || !result.ok) return { ok: false, errorKey: 'error.save' }
      publish({ ...snapshot, preferences: result.value })
      return { ok: true }
    },
    ensureSessionPolicy: async (sessionId) => {
      trackedSessions.add(sessionId)
      if (Object.hasOwn(snapshot.sessionIncognito, sessionId)) return
      await loadSessionPolicy(sessionId, epoch)
    },
    setSessionIncognito: async (sessionId, incognito) => {
      trackedSessions.add(sessionId)
      const result = await safeCall(() => deps.setSessionPolicy(sessionId, incognito))
      if (result === undefined || !result.ok) return { ok: false, errorKey: 'error.save' }
      publish({
        ...snapshot,
        sessionIncognito: {
          ...snapshot.sessionIncognito,
          [sessionId]: result.value.incognito,
        },
      })
      return { ok: true }
    },
    toggleSessionIncognito: async (sessionId) => {
      trackedSessions.add(sessionId)
      if (!Object.hasOwn(snapshot.sessionIncognito, sessionId)) {
        await loadSessionPolicy(sessionId, epoch)
      }
      const next = snapshot.sessionIncognito[sessionId] !== true
      const result = await safeCall(() => deps.setSessionPolicy(sessionId, next))
      if (result === undefined || !result.ok) return { ok: false, errorKey: 'error.save' }
      publish({
        ...snapshot,
        sessionIncognito: {
          ...snapshot.sessionIncognito,
          [sessionId]: result.value.incognito,
        },
      })
      return { ok: true }
    },
  }
}
