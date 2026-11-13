// @vitest-environment jsdom
import { contextMenuHook } from '@deepseek-ai/dsh-client-test-runtime'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { allowAllAccess, bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { AppearanceRow } from '../src/client/AppearanceRow.tsx'
import type { AppearanceRowComponentProps } from '../src/client/AppearanceRow.tsx'
import { createAppearanceRowStore } from '../src/client/settings-store.ts'
import type { ThemePreference, ThemeStyle } from '../src/client/index.ts'

// Every fixture carries the resource hook the resources plugin merges into GlobalStandardProps.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })

afterEach(cleanup)

const COPY: Record<string, string> = {
  'appearance.title': 'Appearance',
  'appearance.light': 'Light',
  'appearance.dark': 'Dark',
  'appearance.system': 'System',
  'appearance.style.title': 'Theme gallery',
  'appearance.style.antigravity': 'Antigravity',
  'appearance.style.antigravity.description': 'Electric sapphire and nebula glow',
  'appearance.style.codex': 'Codex studio',
  'appearance.style.codex.description': 'Crisp architectural corners',
  'appearance.style.warm': 'Claude editorial',
  'appearance.style.warm.description': 'Warm linen parchment',
  'appearance.style.linear': 'Linear titanium',
  'appearance.style.linear.description': 'Brushed graphite layers',
  'appearance.style.craft': 'Crisp craft',
  'appearance.style.craft.description': 'Cool micro-layered surfaces',
  'appearance.style.aurora': 'Luminous aurora',
  'appearance.style.aurora.description': 'Generous whitespace',
  'appearance.style.nord': 'Nordic frost',
  'appearance.style.nord.description': 'Low-glare arctic blue-grey',
  'appearance.style.classic': 'Classic',
  'appearance.style.classic.description': 'Original neutral palette',
}

function emptySessions() {
  const store = createSnapshotStore<SessionListState>(
    { ids: [], byId: {}, phase: 'ready', projectionsBySession: {} })
  return bindSnapshotSelector(store)
}
function emptyWorkspaces() {
  const store = createSnapshotStore<WorkspaceSnapshot>({
    items: [], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null,
  })
  return bindSnapshotSelector(store)
}

type AttentionSnapshot = Parameters<Parameters<AppearanceRowComponentProps['useSessionStatus']>[0]>[0]
const noAttention: AttentionSnapshot = new Map()
const useSessionStatus: AppearanceRowComponentProps['useSessionStatus'] = selector => selector(noAttention)

function mount(preference: ThemePreference = 'system', style: ThemeStyle = 'craft') {
  // Real store instance — the sanctioned zero-machinery path for tests.
  const store = createAppearanceRowStore().create()
  store.actions.sync(preference, style, 0)
  const setTheme = vi.fn()
  const setStyle = vi.fn()
  const props: AppearanceRowComponentProps = {
    useSessions: emptySessions(),
    useSessionStatus,
    usePanelInfo, useSessionRetainInfo: () => undefined, useResource,
    useWorkspaces: emptyWorkspaces(),
    ...allowAllAccess,
    useContextMenu: contextMenuHook(),
    useStore: bindSnapshotSelector(store),
    actions: store.actions,
    t: (key: string) => COPY[key] ?? key,
    setTheme,
    setStyle,
  }
  render(<AppearanceRow {...props} />)
  return { store, setTheme, setStyle }
}

const pressed = (name: RegExp): string | null =>
  screen.getByRole('button', { name }).getAttribute('aria-pressed')

describe('AppearanceRow', () => {
  it('renders the title, three cubes, and eight gallery cards with active selections', () => {
    mount('dark', 'codex')
    expect(screen.getByText('Appearance')).toBeDefined()
    expect(screen.getByText('Theme gallery')).toBeDefined()
    expect(pressed(/Dark/)).toBe('true')
    expect(pressed(/Light/)).toBe('false')
    expect(pressed(/System/)).toBe('false')
    expect(pressed(/Antigravity/)).toBe('false')
    expect(pressed(/Codex studio/)).toBe('true')
    expect(pressed(/Claude editorial/)).toBe('false')
    expect(pressed(/Linear titanium/)).toBe('false')
    expect(pressed(/Crisp craft/)).toBe('false')
    expect(pressed(/Luminous aurora/)).toBe('false')
    expect(pressed(/Nordic frost/)).toBe('false')
    expect(pressed(/Classic/)).toBe('false')
  })

  it('click drives setTheme and setStyle; selection follows the store mirror, not the click echo', () => {
    const b = mount('dark', 'antigravity')
    fireEvent.click(screen.getByRole('button', { name: /Light/ }))
    expect(b.setTheme).toHaveBeenCalledWith('light')
    fireEvent.click(screen.getByRole('button', { name: /Codex studio/ }))
    expect(b.setStyle).toHaveBeenCalledWith('codex')
    // No store write yet: selection is unchanged.
    expect(pressed(/Dark/)).toBe('true')
    expect(pressed(/Antigravity/)).toBe('true')
    act(() => { b.store.actions.sync('light', 'codex', 1) })
    expect(pressed(/Light/)).toBe('true')
    expect(pressed(/Dark/)).toBe('false')
    expect(pressed(/Codex studio/)).toBe('true')
    expect(pressed(/Antigravity/)).toBe('false')
  })
})
