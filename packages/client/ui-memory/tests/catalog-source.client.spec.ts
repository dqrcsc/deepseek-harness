/**
 * Unit tests for `createMemoryCatalogSource`, `mapMemoryRemoteError`,
 * `workspaceFolderName`, and `isSessionAvailable`.
 */

import { describe, expect, it, vi } from 'vitest'
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type {
  MemoryCatalogResult,
  MemoryId,
  MemoryInputErrorCode,
  MemoryPreferences,
  MemoryRecord,
} from '@deepseek-ai/dsh-memory/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  createMemoryCatalogSource,
  isSessionAvailable,
  mapMemoryRemoteError,
  workspaceFolderName,
  type MemoryCatalogDependencies,
} from '../src/client/catalog-source.ts'

const SESSION_A = 'sess-a' as SessionId
const SESSION_B = 'sess-b' as SessionId
const MEM_1 = 'mem-1' as MemoryId

const PREFS: MemoryPreferences = {
  autoExtractEnabled: true,
  autoInjectEnabled: true,
  incognitoIsolatesRead: false,
}

const SAMPLE_RECORD: MemoryRecord = {
  id: MEM_1,
  content: 'Prefer concise Chinese responses.',
  category: 'preference',
  scope: { kind: 'global' },
  source: { kind: 'user' },
  status: 'active',
  pinned: true,
  createdAt: '2026-11-14T00:00:00.000Z',
  updatedAt: '2026-11-14T00:00:00.000Z',
}

function inputInvalidFailure(code: MemoryInputErrorCode): RemoteFailure {
  return new RemoteError('memory/input-invalid', `invalid: ${code}`, { code })
}

function genericFailure(): RemoteFailure {
  return new RemoteError('gateway/internal', 'unavailable', {})
}

function makeDeps(overrides: Partial<MemoryCatalogDependencies> = {}): MemoryCatalogDependencies {
  return {
    catalog: vi.fn(async (): Promise<RemoteResult<MemoryCatalogResult>> => ({
      ok: true,
      value: { items: [SAMPLE_RECORD], preferences: PREFS },
    })),
    create: vi.fn<MemoryCatalogDependencies['create']>(async () => ({ ok: true, value: SAMPLE_RECORD })),
    update: vi.fn<MemoryCatalogDependencies['update']>(async () => ({
      ok: true,
      value: SAMPLE_RECORD,
    })),
    remove: vi.fn<MemoryCatalogDependencies['remove']>(async id => ({ ok: true, value: { id, deleted: true } })),
    clearScope: vi.fn<MemoryCatalogDependencies['clearScope']>(async () => ({ ok: true, value: { deleted: 1 } })),
    setPreferences: vi.fn<MemoryCatalogDependencies['setPreferences']>(async patch => ({
      ok: true,
      value: { ...PREFS, ...patch },
    })),
    getSessionPolicy: vi.fn<MemoryCatalogDependencies['getSessionPolicy']>(async sessionId => ({
      ok: true,
      value: { sessionId, incognito: false, updatedAt: '2026-11-14T00:00:00.000Z' },
    })),
    setSessionPolicy: vi.fn<MemoryCatalogDependencies['setSessionPolicy']>(async (sessionId, incognito) => ({
      ok: true,
      value: { sessionId, incognito, updatedAt: '2026-11-14T00:00:00.000Z' },
    })),
    subscribeChanged: vi.fn(() => () => {}),
    subscribeReset: vi.fn(() => () => {}),
    ...overrides,
  }
}

describe('mapMemoryRemoteError', () => {
  it('maps each memory/input-invalid detail code and falls back for generic failures', () => {
    expect(mapMemoryRemoteError(genericFailure())).toBe('error.save')
    expect(mapMemoryRemoteError(inputInvalidFailure('sensitive_content'))).toBe('error.sensitive')
    expect(mapMemoryRemoteError(inputInvalidFailure('capacity_exceeded'))).toBe('error.capacity')
    expect(mapMemoryRemoteError(inputInvalidFailure('invalid_scope'))).toBe('error.invalidScope')
    expect(mapMemoryRemoteError(inputInvalidFailure('invalid_content'))).toBe('error.empty')
    expect(mapMemoryRemoteError(inputInvalidFailure('empty_patch'))).toBe('error.save')
    expect(mapMemoryRemoteError(inputInvalidFailure('invalid_category'))).toBe('error.save')
  })
})

describe('workspaceFolderName', () => {
  it('extracts leaf folder names across POSIX, Windows, trailing slashes, and root paths', () => {
    expect(workspaceFolderName('/Users/alice/projects/app')).toBe('app')
    expect(workspaceFolderName('C:\\Users\\alice\\projects\\app\\')).toBe('app')
    expect(workspaceFolderName('/Users/alice/projects/app///')).toBe('app')
    expect(workspaceFolderName('/')).toBe('/')
    expect(workspaceFolderName('standalone')).toBe('standalone')
  })
})

describe('isSessionAvailable', () => {
  const readySessions: SessionListState = {
    ids: [SESSION_A],
    byId: {},
    phase: 'ready',
    projectionsBySession: {},
  }
  const readyWorkspaces: WorkspaceSnapshot = {
    items: [],
    archivedSessionIds: [],
    pinnedSessionIds: [],
    state: 'idle',
    phase: 'ready',
    error: null,
  }

  it('checks error states, pending phases, archived status, and Session membership', () => {
    expect(isSessionAvailable(SESSION_A, readySessions, readyWorkspaces)).toBe(true)
    expect(isSessionAvailable(SESSION_B, readySessions, readyWorkspaces)).toBe(false)
    expect(
      isSessionAvailable(SESSION_A, readySessions, { ...readyWorkspaces, state: 'error' }),
    ).toBe(false)
    expect(
      isSessionAvailable(SESSION_A, { ...readySessions, phase: 'pending' }, readyWorkspaces),
    ).toBe(false)
    expect(
      isSessionAvailable(SESSION_A, readySessions, { ...readyWorkspaces, phase: 'pending' }),
    ).toBe(false)
    expect(
      isSessionAvailable(SESSION_A, readySessions, { ...readyWorkspaces, archivedSessionIds: [SESSION_A] }),
    ).toBe(false)
  })
})

describe('createMemoryCatalogSource', () => {
  it('manages subscriber lifecycle, event invalidation, and stale-epoch cancellation', async () => {
    let onChanged: (() => void) | undefined
    let onReset: (() => void) | undefined
    const disposeChanged = vi.fn()
    const disposeReset = vi.fn()
    let resolveFirstCatalog: ((res: RemoteResult<MemoryCatalogResult>) => void) | undefined

    const catalogMock = vi.fn()
      .mockImplementationOnce(() => new Promise<RemoteResult<MemoryCatalogResult>>((resolve) => {
        resolveFirstCatalog = resolve
      }))
      .mockResolvedValue({
        ok: true,
        value: { items: [SAMPLE_RECORD], preferences: PREFS },
      })

    const source = createMemoryCatalogSource(makeDeps({
      catalog: catalogMock,
      subscribeChanged: (listener) => {
        onChanged = listener
        return disposeChanged
      },
      subscribeReset: (listener) => {
        onReset = listener
        return disposeReset
      },
    }))

    expect(source.hooks.catalog.getSnapshot().status).toBe('loading')
    expect(source.hooks.catalog.getSnapshot().settled).toBe(false)

    const sub1 = vi.fn()
    const sub2 = vi.fn()
    const unsub1 = source.hooks.catalog.subscribe(sub1)
    const unsub2 = source.hooks.catalog.subscribe(sub2)
    expect(catalogMock).toHaveBeenCalledTimes(1)

    // Unsubscribing only one listener keeps subscriptions active.
    unsub1()
    expect(disposeChanged).not.toHaveBeenCalled()

    // Unsubscribing the final listener disposes upstream listeners and bumps epoch.
    unsub2()
    expect(disposeChanged).toHaveBeenCalledTimes(1)
    expect(disposeReset).toHaveBeenCalledTimes(1)

    // Late resolution of the superseded read is ignored.
    resolveFirstCatalog?.({
      ok: true,
      value: { items: [SAMPLE_RECORD], preferences: PREFS },
    })
    await Promise.resolve()
    expect(source.hooks.catalog.getSnapshot().settled).toBe(false)

    // Re-subscribing starts a fresh read and reacts to changed/reset events.
    const unsub3 = source.hooks.catalog.subscribe(sub1)
    await vi.waitFor(() => {
      expect(source.hooks.catalog.getSnapshot().settled).toBe(true)
    })
    expect(source.hooks.catalog.getSnapshot().items).toEqual([SAMPLE_RECORD])

    onChanged?.()
    onReset?.()
    await vi.waitFor(() => {
      expect(catalogMock).toHaveBeenCalledTimes(4)
    })
    unsub3()
  })

  it('handles catalog refresh failures and transport rejections cleanly', async () => {
    const catalogMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: genericFailure() })
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ ok: true, value: { items: [], preferences: PREFS } })

    const source = createMemoryCatalogSource(makeDeps({ catalog: catalogMock }))
    await source.refresh()
    expect(source.hooks.catalog.getSnapshot().status).toBe('error')
    expect(source.hooks.catalog.getSnapshot().settled).toBe(false)

    await source.refresh()
    expect(source.hooks.catalog.getSnapshot().status).toBe('error')

    await source.refresh()
    expect(source.hooks.catalog.getSnapshot().status).toBe('ready')
    expect(source.hooks.catalog.getSnapshot().settled).toBe(true)
  })

  it('handles createEntry, updateEntry, deleteEntry, clearScope, and updatePreferences outcomes', async () => {
    const createMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: SAMPLE_RECORD })
      .mockResolvedValueOnce({ ok: false, error: inputInvalidFailure('sensitive_content') })
      .mockRejectedValueOnce(new Error('offline'))

    const updateMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: SAMPLE_RECORD })
      .mockResolvedValueOnce({ ok: true, value: { id: MEM_1, code: 'memory_conflict' } })
      .mockResolvedValueOnce({ ok: true, value: { id: MEM_1, code: 'memory_not_found' } })
      .mockResolvedValueOnce({ ok: false, error: inputInvalidFailure('invalid_content') })
      .mockRejectedValueOnce(new Error('offline'))

    const removeMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: { id: MEM_1, deleted: true } })
      .mockResolvedValueOnce({ ok: false, error: genericFailure() })
      .mockRejectedValueOnce(new Error('offline'))

    const clearMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: { deleted: 2 } })
      .mockResolvedValueOnce({ ok: false, error: inputInvalidFailure('invalid_scope') })
      .mockRejectedValueOnce(new Error('offline'))

    const prefsMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        value: { autoExtractEnabled: false, autoInjectEnabled: true, incognitoIsolatesRead: true },
      })
      .mockResolvedValueOnce({ ok: false, error: genericFailure() })
      .mockRejectedValueOnce(new Error('offline'))

    const source = createMemoryCatalogSource(makeDeps({
      create: createMock,
      update: updateMock,
      remove: removeMock,
      clearScope: clearMock,
      setPreferences: prefsMock,
    }))

    expect(await source.createEntry({ content: 'hello', category: 'fact', scope: { kind: 'global' } }))
      .toEqual({ ok: true })
    expect(await source.createEntry({ content: 'sk-secret', category: 'fact', scope: { kind: 'global' } }))
      .toEqual({ ok: false, errorKey: 'error.sensitive' })
    expect(await source.createEntry({ content: 'hello', category: 'fact', scope: { kind: 'global' } }))
      .toEqual({ ok: false, errorKey: 'error.save' })

    expect(await source.updateEntry(MEM_1, { pinned: false }, '2026-11-14T00:00:00.000Z'))
      .toEqual({ ok: true })
    expect(updateMock).toHaveBeenNthCalledWith(1, {
      id: MEM_1,
      patch: { pinned: false },
      expectedUpdatedAt: '2026-11-14T00:00:00.000Z',
    })
    expect(await source.updateEntry(MEM_1, { content: 'next' }))
      .toEqual({ ok: false, errorKey: 'error.conflict' })
    expect(updateMock).toHaveBeenNthCalledWith(2, {
      id: MEM_1,
      patch: { content: 'next' },
    })
    expect(await source.updateEntry(MEM_1, { content: 'gone' }))
      .toEqual({ ok: false, errorKey: 'error.save' })
    expect(await source.updateEntry(MEM_1, { content: '' }))
      .toEqual({ ok: false, errorKey: 'error.empty' })
    expect(await source.updateEntry(MEM_1, { content: 'offline' }))
      .toEqual({ ok: false, errorKey: 'error.save' })

    expect(await source.deleteEntry(MEM_1)).toEqual({ ok: true })
    expect(await source.deleteEntry(MEM_1)).toEqual({ ok: false, errorKey: 'error.save' })
    expect(await source.deleteEntry(MEM_1)).toEqual({ ok: false, errorKey: 'error.save' })

    expect(await source.clearScope({ kind: 'all' })).toEqual({ ok: true })
    expect(await source.clearScope({ kind: 'workspace', workspacePath: 'rel' }))
      .toEqual({ ok: false, errorKey: 'error.invalidScope' })
    expect(await source.clearScope({ kind: 'global' })).toEqual({ ok: false, errorKey: 'error.save' })

    expect(await source.updatePreferences({ autoExtractEnabled: false, incognitoIsolatesRead: true }))
      .toEqual({ ok: true })
    expect(source.hooks.catalog.getSnapshot().preferences.autoExtractEnabled).toBe(false)
    expect(await source.updatePreferences({ autoInjectEnabled: false }))
      .toEqual({ ok: false, errorKey: 'error.save' })
    expect(await source.updatePreferences({ autoInjectEnabled: false }))
      .toEqual({ ok: false, errorKey: 'error.save' })
  })

  it('tracks per-Session incognito policies across ensureSessionPolicy, setSessionIncognito, toggleSessionIncognito, and refresh', async () => {
    const SESSION_C = 'sess-c' as SessionId
    const getPolicyMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: genericFailure() })
      .mockResolvedValueOnce({ ok: true, value: { sessionId: SESSION_A, incognito: true } })
      .mockResolvedValueOnce({ ok: true, value: { sessionId: SESSION_A, incognito: true } })
      .mockResolvedValueOnce({ ok: true, value: { sessionId: SESSION_A, incognito: false } })
      .mockResolvedValueOnce({ ok: true, value: { sessionId: SESSION_C, incognito: false } })

    const setPolicyMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: { sessionId: SESSION_B, incognito: true } })
      .mockResolvedValueOnce({ ok: false, error: genericFailure() })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ok: true, value: { sessionId: SESSION_C, incognito: true } })
      .mockResolvedValueOnce({ ok: true, value: { sessionId: SESSION_C, incognito: false } })
      .mockResolvedValueOnce({ ok: false, error: genericFailure() })
      .mockRejectedValueOnce(new Error('offline'))

    const source = createMemoryCatalogSource(makeDeps({
      getSessionPolicy: getPolicyMock,
      setSessionPolicy: setPolicyMock,
    }))

    // Failed initial policy read leaves cache unset so retry can succeed.
    await source.ensureSessionPolicy(SESSION_A)
    expect(source.hooks.catalog.getSnapshot().sessionIncognito[SESSION_A]).toBeUndefined()

    await source.ensureSessionPolicy(SESSION_A)
    expect(source.hooks.catalog.getSnapshot().sessionIncognito[SESSION_A]).toBe(true)

    // Cached session policy skips redundant RPC until refresh.
    await source.ensureSessionPolicy(SESSION_A)
    expect(getPolicyMock).toHaveBeenCalledTimes(2)

    // Refresh reloads tracked Session policies (first unchanged -> no extra publish, second flips to false).
    await source.refresh()
    expect(source.hooks.catalog.getSnapshot().sessionIncognito[SESSION_A]).toBe(true)
    await source.refresh()
    expect(source.hooks.catalog.getSnapshot().sessionIncognito[SESSION_A]).toBe(false)

    // setSessionIncognito updates cache on ok and reports error.save on failure/throw.
    expect(await source.setSessionIncognito(SESSION_B, true)).toEqual({ ok: true })
    expect(source.hooks.catalog.getSnapshot().sessionIncognito[SESSION_B]).toBe(true)
    expect(await source.setSessionIncognito(SESSION_B, false)).toEqual({ ok: false, errorKey: 'error.save' })
    expect(await source.setSessionIncognito(SESSION_B, false)).toEqual({ ok: false, errorKey: 'error.save' })

    // toggleSessionIncognito loads uncached policy first, flips cached policy directly, and handles errors.
    expect(await source.toggleSessionIncognito(SESSION_C)).toEqual({ ok: true })
    expect(getPolicyMock).toHaveBeenCalledTimes(5)
    expect(setPolicyMock).toHaveBeenCalledWith(SESSION_C, true)
    expect(source.hooks.catalog.getSnapshot().sessionIncognito[SESSION_C]).toBe(true)

    expect(await source.toggleSessionIncognito(SESSION_C)).toEqual({ ok: true })
    expect(getPolicyMock).toHaveBeenCalledTimes(5)
    expect(setPolicyMock).toHaveBeenCalledWith(SESSION_C, false)
    expect(source.hooks.catalog.getSnapshot().sessionIncognito[SESSION_C]).toBe(false)

    expect(await source.toggleSessionIncognito(SESSION_C)).toEqual({ ok: false, errorKey: 'error.save' })
    expect(await source.toggleSessionIncognito(SESSION_C)).toEqual({ ok: false, errorKey: 'error.save' })
  })
})
