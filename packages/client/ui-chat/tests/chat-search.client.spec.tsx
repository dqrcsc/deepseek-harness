// @vitest-environment jsdom
import { useRef } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { SessionEventSearchResult } from '@deepseek-ai/dsh-api-session-controller/client'
import { useModalLayer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionLocateRequest } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import { ChatSearchBar, type ChatSearchBarProps } from '../src/client/chat/ChatSearchBar.tsx'
import { resolveNodeEventSeq } from '../src/client/chat/ChatNodeSeat.tsx'
import { ChatNavigation, type ChatNavigationInput } from '../src/client/chat/use-chat-navigation.ts'
import { ChatReading } from '../src/client/chat/use-chat-reading.ts'
import { useChatSearch, type ChatSearchState, type UseChatSearchInput } from '../src/client/chat/use-chat-search.ts'
import { ChatViewport } from '../src/client/chat/use-chat-viewport.ts'
import { ScrollFollow } from '../src/client/chat/use-scroll-follow.ts'
import { zh } from '../src/client/locale.ts'
import { createChatStore } from '../src/client/stores.ts'

const t = makeTranslate(zh, commonZh)

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('resolveNodeEventSeq and Chat store locate state', () => {
  it('resolves durable event sequences only for primary message and step seats', () => {
    expect(resolveNodeEventSeq(undefined)).toBeUndefined()
    const userNode = { kind: 'user' as const, anchorSeq: 3 }
    expect(resolveNodeEventSeq(userNode)).toBe(3)
    expect(resolveNodeEventSeq(userNode, 'reasoning')).toBeUndefined()
    expect(resolveNodeEventSeq({ kind: 'turn-tail', anchorSeq: 4 })).toBeUndefined()
    expect(resolveNodeEventSeq({ kind: 'turn-process', anchorSeq: 4 })).toBeUndefined()
    expect(resolveNodeEventSeq({
      kind: 'assistant-step',
      anchorSeq: 6,
      data: { finalNode: { seq: 8 } },
    })).toBe(8)
    expect(resolveNodeEventSeq({
      kind: 'assistant-step',
      anchorSeq: 6,
      data: { finalNode: undefined },
    })).toBe(6)
    expect(resolveNodeEventSeq({
      kind: 'assistant-step',
      anchorSeq: 6,
      data: {
        blocks: [{ kind: 'reasoning', text: 'think' }, { kind: 'text', text: 'reply' }],
        finalNode: { seq: 8 },
      },
    }, 'reasoning')).toBeUndefined()
    expect(resolveNodeEventSeq({
      kind: 'assistant-step',
      anchorSeq: 6,
      data: {
        blocks: [{ kind: 'reasoning', text: 'think' }],
        finalNode: { seq: 8 },
      },
    }, 'reasoning')).toBe(8)
  })

  it('updates locatedSeq and semanticMatchSeq idempotently in ChatStore', () => {
    const store = createChatStore().create()
    expect(store.getSnapshot()).toEqual({
      turnProcesses: [],
      locatedSeq: null,
      semanticMatchSeq: null,
    })
    store.actions.setLocatedSeq(null)
    store.actions.setLocatedSeq(12)
    store.actions.setLocatedSeq(12)
    store.actions.setSemanticMatchSeq(null)
    store.actions.setSemanticMatchSeq(12)
    store.actions.setSemanticMatchSeq(12)
    expect(store.getSnapshot()).toEqual({
      turnProcesses: [],
      locatedSeq: 12,
      semanticMatchSeq: 12,
    })
    store.actions.setLocatedSeq(null)
    store.actions.setSemanticMatchSeq(null)
    expect(store.getSnapshot().locatedSeq).toBeNull()
    expect(store.getSnapshot().semanticMatchSeq).toBeNull()
  })
})

describe('ChatSearchBar', () => {
  function baseProps(overrides: Partial<ChatSearchBarProps> = {}): ChatSearchBarProps {
    return {
      open: true,
      focusVersion: 0,
      query: '',
      mode: 'hybrid',
      searching: false,
      locating: false,
      matchCount: 0,
      activeIndex: -1,
      hasMore: false,
      onQueryChange: vi.fn(),
      onToggleMode: vi.fn(),
      onPrevious: vi.fn(),
      onNext: vi.fn(),
      onClose: vi.fn(),
      t,
      ...overrides,
    }
  }

  it('renders null when closed and idle, or a locating status pill during sidebar jumps', () => {
    const view = render(<ChatSearchBar {...baseProps({ open: false, locating: false })} />)
    expect(view.container.firstChild).toBeNull()

    view.rerender(<ChatSearchBar {...baseProps({ open: false, locating: true })} />)
    expect(view.container.querySelector('[data-chat-locate-status]')?.textContent).toBe('正在定位历史消息…')
  })

  it('renders status transitions, focuses on focusVersion bumps, and handles keyboard + button controls', () => {
    const onQueryChange = vi.fn()
    const onToggleMode = vi.fn()
    const onPrevious = vi.fn()
    const onNext = vi.fn()
    const onClose = vi.fn()

    const view = render(
      <ChatSearchBar
        {...baseProps({
          focusVersion: 0,
          query: '   ',
          onQueryChange,
          onToggleMode,
          onPrevious,
          onNext,
          onClose,
        })}
      />,
    )
    const input = view.getByRole('searchbox', { name: '在当前会话中查找' }) as HTMLInputElement
    const selectSpy = vi.spyOn(input, 'select')
    expect(document.activeElement).not.toBe(input)
    expect(view.container.querySelector('[data-chat-search-status]')).toBeNull()

    // Focuses and selects when focusVersion > 0
    view.rerender(
      <ChatSearchBar
        {...baseProps({
          focusVersion: 1,
          query: 'needle',
          searching: true,
          matchCount: 0,
          onQueryChange,
          onToggleMode,
          onPrevious,
          onNext,
          onClose,
        })}
      />,
    )
    expect(document.activeElement).toBe(input)
    expect(selectSpy).toHaveBeenCalledOnce()
    expect(view.container.querySelector('[data-chat-search-status]')?.textContent).toBe('查找中…')

    // Locating overrides status inside open bar too
    view.rerender(
      <ChatSearchBar
        {...baseProps({
          focusVersion: 1,
          query: 'needle',
          locating: true,
          matchCount: 2,
          activeIndex: 0,
        })}
      />,
    )
    expect(view.container.querySelector('[data-chat-search-status]')?.textContent).toBe('正在定位历史消息…')

    // Zero matches state + keyboard keys when matchCount === 0
    view.rerender(
      <ChatSearchBar
        {...baseProps({
          focusVersion: 1,
          query: 'needle',
          searching: false,
          matchCount: 0,
          onQueryChange,
          onToggleMode,
          onPrevious,
          onNext,
          onClose,
        })}
      />,
    )
    expect(view.container.querySelector('[data-chat-search-status]')?.textContent).toBe('无匹配')
    const currentInput = view.getByRole('searchbox', { name: '在当前会话中查找' })
    fireEvent.keyDown(currentInput, { key: 'Enter' })
    fireEvent.keyDown(currentInput, { key: 'ArrowDown' })
    fireEvent.keyDown(currentInput, { key: 'ArrowUp' })
    expect(onNext).not.toHaveBeenCalled()
    expect(onPrevious).not.toHaveBeenCalled()

    // Populated matches (exact count and countPlus) + phrase mode + keyboard navigation + IME guard
    view.rerender(
      <ChatSearchBar
        {...baseProps({
          focusVersion: 1,
          query: 'needle',
          mode: 'phrase',
          matchCount: 8,
          activeIndex: 1,
          hasMore: false,
          onQueryChange,
          onToggleMode,
          onPrevious,
          onNext,
          onClose,
        })}
      />,
    )
    expect(view.container.querySelector('[data-chat-search-status]')?.textContent).toBe('第 2 / 8 处')
    const modeBtn = view.getByRole('button', { name: '精确' })
    expect(modeBtn.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(modeBtn)
    expect(onToggleMode).toHaveBeenCalledOnce()

    view.rerender(
      <ChatSearchBar
        {...baseProps({
          focusVersion: 1,
          query: 'needle',
          mode: 'hybrid',
          matchCount: 50,
          activeIndex: 4,
          hasMore: true,
          onQueryChange,
          onToggleMode,
          onPrevious,
          onNext,
          onClose,
        })}
      />,
    )
    expect(view.container.querySelector('[data-chat-search-status]')?.textContent).toBe('第 5 / 50+ 处')

    const activeInput = view.getByRole('searchbox', { name: '在当前会话中查找' })
    fireEvent.change(activeInput, { target: { value: 'updated' } })
    expect(onQueryChange).toHaveBeenCalledWith('updated')

    // IME composing ignores Enter / Escape
    fireEvent.keyDown(activeInput, { key: 'Enter', isComposing: true })
    expect(onNext).not.toHaveBeenCalled()

    fireEvent.keyDown(activeInput, { key: 'a' })
    fireEvent.keyDown(activeInput, { key: 'Enter' })
    expect(onNext).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(activeInput, { key: 'Enter', shiftKey: true })
    expect(onPrevious).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(activeInput, { key: 'ArrowDown' })
    expect(onNext).toHaveBeenCalledTimes(2)
    fireEvent.keyDown(activeInput, { key: 'ArrowUp' })
    expect(onPrevious).toHaveBeenCalledTimes(2)

    fireEvent.click(view.getByRole('button', { name: '上一处匹配' }))
    expect(onPrevious).toHaveBeenCalledTimes(3)
    fireEvent.click(view.getByRole('button', { name: '下一处匹配' }))
    expect(onNext).toHaveBeenCalledTimes(3)

    fireEvent.keyDown(activeInput, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(view.getByRole('button', { name: '关闭查找' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})

describe('ChatViewport.scrollToEventSeq and ChatNavigation.navigateToEvent', () => {
  it('reveals hidden ancestors via beforematch without triggering reader intent, clears active motion, and aligns inner step bodies', () => {
    const detached = new ChatViewport()
    expect(detached.scrollToEventSeq(1)).toEqual({ status: 'missing' })

    const scroller = document.createElement('div')
    const column = document.createElement('div')
    column.dataset.chatFlow = ''
    scroller.append(column)
    document.body.append(scroller)
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 2_000 },
    })
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 600, 300))

    const viewport = new ChatViewport()
    const intent = vi.fn()
    const interact = vi.fn()
    viewport.attach(scroller, column)
    viewport.connect({
      scroll: () => {},
      scrollEnd: () => {},
      resize: () => {},
      interact,
      intent,
    })

    // Missing event seq (with and without fallbackTurn)
    expect(viewport.scrollToEventSeq(99)).toEqual({ status: 'missing' })
    expect(viewport.scrollToEventSeq(99, 72, 2)).toEqual({ status: 'missing' })

    // Search bar pointerdown / keydown inside scroller does not count as reader scroll intent
    const searchBar = document.createElement('div')
    searchBar.dataset.chatSearchBar = ''
    const searchButton = document.createElement('button')
    searchBar.append(searchButton)
    scroller.append(searchBar)
    searchButton.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    searchButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }))
    expect(intent).not.toHaveBeenCalled()

    // Nested hidden ancestors dispatch beforematch outermost-first while suppressing intent
    const outerHidden = document.createElement('div')
    outerHidden.setAttribute('hidden', 'until-found')
    const innerBody = document.createElement('div')
    innerBody.dataset.stepProcessBody = ''
    innerBody.setAttribute('hidden', 'until-found')
    const row = document.createElement('div')
    row.dataset.chatEventSeq = '14'
    row.dataset.chatAnchorKey = 'node-14'
    row.dataset.chatTurn = '2'
    innerBody.append(row)
    outerHidden.append(innerBody)
    column.append(outerHidden)

    const revealOrder: string[] = []
    outerHidden.addEventListener('beforematch', () => {
      revealOrder.push('outer')
      outerHidden.removeAttribute('hidden')
    })
    innerBody.addEventListener('beforematch', () => {
      revealOrder.push('inner')
      innerBody.removeAttribute('hidden')
    })

    expect(viewport.scrollToEventSeq(14)).toEqual({ status: 'revealing' })
    expect(revealOrder).toEqual(['outer', 'inner'])
    expect(intent).not.toHaveBeenCalled()

    // Clear active motion and align inner step-process-body (without ScrollFollow, then with ScrollFollow)
    vi.spyOn(viewport.motion, 'active').mockReturnValueOnce(true)
    const clearMotion = vi.spyOn(viewport.motion, 'clear')
    Object.defineProperties(innerBody, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 400 },
    })
    vi.spyOn(innerBody, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 120, 600, 100))
    vi.spyOn(row, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(0, 320 - innerBody.scrollTop - scroller.scrollTop, 600, 40),
    )

    const landed1 = viewport.scrollToEventSeq(14)
    expect(clearMotion).toHaveBeenCalledOnce()
    expect(innerBody.scrollTop).toBe(184)
    expect(landed1.status).toBe('landed')
    if (landed1.status === 'landed') {
      expect(landed1.landing.turn).toBe(2)
    }

    const earlierRow = document.createElement('div')
    earlierRow.dataset.chatEventSeq = '10'
    earlierRow.dataset.chatTurn = '2'
    const laterRow = document.createElement('div')
    laterRow.dataset.chatEventSeq = '20'
    laterRow.dataset.chatTurn = '2'
    column.append(earlierRow, laterRow)
    expect(viewport.scrollToEventSeq(13, 72, 2).status).toBe('landed')

    // Second call when innerBody.scrollTop already matches target, and row has no valid data-chat-turn
    delete row.dataset.chatTurn
    innerBody.scrollTop = 184
    scroller.scrollTop = 0
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 136, 600, 40))
    const landedSameInner = viewport.scrollToEventSeq(14)
    expect(landedSameInner.status).toBe('landed')
    if (landedSameInner.status === 'landed') {
      expect(landedSameInner.landing.turn).toBeNull()
    }

    // Inner body with bound ScrollFollow + non-scrollable inner body (floor === 0)
    const follow = new ScrollFollow(true, 24)
    follow.bind(innerBody)
    const jumpSpy = vi.spyOn(follow, 'jump')
    const setFollowingSpy = vi.spyOn(follow, 'setFollowing')
    innerBody.scrollTop = 0
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 260, 600, 40))
    viewport.scrollToEventSeq(14)
    expect(jumpSpy).toHaveBeenCalledOnce()
    expect(setFollowingSpy).toHaveBeenCalledWith(false)

    Object.defineProperty(innerBody, 'scrollHeight', { configurable: true, value: 100 })
    viewport.scrollToEventSeq(14)

    viewport.detach()
    scroller.remove()
  })

  it('drives loaded, revealing, unloaded, early-commit, interrupted, and fallback event jumps in ChatNavigation', async () => {
    const landing = {
      metrics: { top: 120, floor: 800, height: 300 },
      turn: 2,
      position: { anchorKey: 'n-5', anchorTop: 72, scrollTop: 120 },
    }
    const fallbackLanding = {
      metrics: { top: 40, floor: 800, height: 300 },
      turn: 3,
      position: { anchorKey: 'n-9', anchorTop: 24, scrollTop: 40 },
    }
    const follow = new ScrollFollow(true, 24)
    const viewport = new ChatViewport()
    const reading = new ChatReading(
      viewport,
      { save: vi.fn(), read: () => null },
      { initialized: true, followingTail: true, activeTurn: null },
      vi.fn(),
      follow,
    )
    let preserving = false
    vi.spyOn(viewport, 'preserving', 'get').mockImplementation(() => preserving)
    const beginPreserving = vi.spyOn(viewport, 'beginPreserving').mockImplementation(() => { preserving = true })
    vi.spyOn(viewport, 'stopPreserving').mockImplementation(() => { preserving = false })
    vi.spyOn(viewport, 'cancelHistoryPrepend').mockImplementation(() => {})
    vi.spyOn(viewport, 'preserve').mockReturnValue(null)
    vi.spyOn(viewport, 'scrollToTurn').mockReturnValue(null)
    const scrollToTurnAtOrAfter = vi.spyOn(viewport, 'scrollToTurnAtOrAfter').mockReturnValue(fallbackLanding)
    const scrollToEventSeq = vi.spyOn(viewport, 'scrollToEventSeq').mockReturnValue({
      status: 'landed',
      landing,
    })
    const acceptNavigation = vi.spyOn(reading, 'acceptNavigation').mockImplementation(() => {})
    const pauseFollowing = vi.spyOn(reading, 'pauseFollowing').mockImplementation(() => {})
    vi.spyOn(reading, 'preservePosition').mockImplementation(() => {})
    let resolveLoad: (() => void) | undefined
    const input: ChatNavigationInput = {
      firstSeq: 5,
      hasMore: true,
      loadingOlder: true,
      historyLoadStatus: 'idle',
      isOpen: true,
      loadOlder: vi.fn(),
      consumeOlder: vi.fn(() => false),
      loadThrough: vi.fn(() => new Promise<void>((resolve) => { resolveLoad = resolve })),
    }
    const busyTurns: (number | null)[] = []
    const locatingSeqs: (number | null)[] = []
    const nav = new ChatNavigation(
      viewport,
      reading,
      input,
      turn => busyTurns.push(turn),
      () => {},
      seq => locatingSeqs.push(seq),
    )

    // 1. Loaded window covers target -> immediate landing + beginPreserving when loadingOlder=true
    const onLanded1 = vi.fn()
    nav.navigateToEvent(SessionSeq(6), 2, onLanded1)
    expect(acceptNavigation).toHaveBeenCalledWith(landing)
    expect(beginPreserving).toHaveBeenCalledWith(landing.position)
    expect(onLanded1).toHaveBeenCalledWith(6)

    // 2. Loaded window covers target -> revealing -> settles on reconcile()
    nav.setInput({ ...input, loadingOlder: false })
    scrollToEventSeq.mockReturnValueOnce({ status: 'revealing' })
    const onLandedReveal = vi.fn()
    nav.navigateToEvent(SessionSeq(7), null, onLandedReveal)
    expect(pauseFollowing).toHaveBeenCalled()
    expect(onLandedReveal).not.toHaveBeenCalled()
    scrollToEventSeq.mockReturnValueOnce({ status: 'landed', landing })
    nav.reconcile()
    expect(onLandedReveal).toHaveBeenCalledWith(7)

    // 3. Loaded window covers target -> missing with fallbackTurn vs without fallbackTurn
    acceptNavigation.mockClear()
    scrollToEventSeq.mockReturnValue({ status: 'missing' })
    nav.navigateToEvent(SessionSeq(7), null)
    expect(acceptNavigation).not.toHaveBeenCalled()
    nav.navigateToEvent(SessionSeq(7), 3)
    expect(acceptNavigation).toHaveBeenCalledWith(fallbackLanding)
    scrollToTurnAtOrAfter.mockReturnValueOnce(null)
    nav.navigateToEvent(SessionSeq(7), 3)

    // 4. Unloaded target when hasMore=false -> uses fallbackTurn when provided
    acceptNavigation.mockClear()
    nav.setInput({ ...input, firstSeq: 10, hasMore: false, loadingOlder: false })
    nav.navigateToEvent(SessionSeq(2), null)
    expect(acceptNavigation).not.toHaveBeenCalled()
    nav.navigateToEvent(SessionSeq(2), 3)
    expect(acceptNavigation).toHaveBeenCalledWith(fallbackLanding)
    scrollToTurnAtOrAfter.mockReturnValueOnce(null)
    nav.navigateToEvent(SessionSeq(2), 3)

    // 5. Unloaded target when hasMore=true -> early contentCommitted (revealing then landed), then settled without duplicate onLanded
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 1
    })
    nav.setInput({ ...input, firstSeq: 10, hasMore: true, loadingOlder: false })
    const onLandedPaged = vi.fn()
    nav.navigateToEvent(SessionSeq(2), 1, onLandedPaged)
    expect(locatingSeqs.at(-1)).toBe(2)
    expect(busyTurns.at(-1)).toBe(1)

    scrollToEventSeq.mockReturnValueOnce({ status: 'revealing' })
    expect(nav.contentCommitted()).toBe(true)
    expect(onLandedPaged).not.toHaveBeenCalled()

    scrollToEventSeq.mockReturnValue({ status: 'landed', landing })
    expect(nav.contentCommitted()).toBe(true)
    expect(onLandedPaged).toHaveBeenCalledTimes(1)

    // Reader moves after early landing -> marks interrupted -> settlement cancels cleanly
    nav.readerSampled({ position: null, movedByReader: true, followingTail: false })
    resolveLoad?.()
    await Promise.resolve()
    expect(locatingSeqs.at(-1)).toBeNull()
    expect(busyTurns.at(-1)).toBeNull()
    expect(onLandedPaged).toHaveBeenCalledTimes(1)

    // 6. Unloaded target with fallbackTurn=null when loadThrough never covers seq -> repages once then cancels without fallback
    scrollToEventSeq.mockReturnValue({ status: 'missing' })
    let autoResolve = true
    nav.setInput({
      ...input,
      firstSeq: 10,
      hasMore: true,
      loadingOlder: false,
      loadThrough: vi.fn(async () => {
        if (!autoResolve) await new Promise<void>(() => {})
      }),
    })
    nav.navigateToEvent(SessionSeq(2), null)
    await Promise.resolve()
    await Promise.resolve()
    expect(locatingSeqs.at(-1)).toBeNull()

    autoResolve = false
    nav.navigateToEvent(SessionSeq(2), 1)
    nav.readerInteracted()
    expect(locatingSeqs.at(-1)).toBeNull()
    nav.dispose()
  })
})

describe('useChatSearch controller hook', () => {
  function makeNodeStore(entries: readonly [string, number][]): UseChatSearchInput['nodeStore'] {
    const map = new Map(entries.map(([key, anchorSeq]) => [key, { anchorSeq }]))
    return {
      get: (key: string) => map.get(key),
    }
  }

  function mountSearchHook(initial: Partial<UseChatSearchInput> = {}) {
    const store = createChatStore().create()
    const acknowledgeLocate = vi.fn<(requestId: number) => void>()
    const searchEvents = vi.fn<UseChatSearchInput['searchEvents']>(async () => ({
      ok: true,
      value: { items: [], hasMore: false },
    }))
    const navigateToEvent = vi.fn<UseChatSearchInput['navigateToEvent']>((seq, _turn, onLanded) => {
      onLanded?.(seq)
    })
    const nodeStore = makeNodeStore([['k1', 1], ['k2', 10]])
    const railItems = [
      { turn: 1, prompt: 'p1', response: 'r1', anchor: { kind: 'loaded' as const, key: 'k1' } },
      { turn: 2, prompt: 'p2', response: 'r2', anchor: { kind: 'loaded' as const, key: 'k2' } },
    ]
    let latest!: ChatSearchState

    function Probe({
      overrides,
      attachRefs = true,
    }: {
      readonly overrides: Partial<UseChatSearchInput>
      readonly attachRefs?: boolean
    }) {
      const listRef = useRef<HTMLDivElement>(null)
      const columnRef = useRef<HTMLDivElement>(null)
      latest = useChatSearch({
        isOpen: true,
        hasContent: true,
        canSearchEvents: true,
        listRef,
        columnRef,
        contentVersion: 1,
        railItems,
        nodeStore,
        locateRequest: null,
        acknowledgeLocate,
        searchEvents,
        navigateToEvent,
        actions: store.actions,
        ...overrides,
      })
      if (!attachRefs) return <div />
      return (
        <div ref={listRef} data-testid="list">
          <div ref={columnRef} data-testid="column">
            <div data-chat-flow-kind="user" data-chat-event-seq="2">alpha query text</div>
            <div data-chat-flow-kind="assistant-step" data-chat-event-seq="12">semantic answer</div>
          </div>
        </div>
      )
    }

    const view = render(<Probe overrides={initial} />)
    return {
      view,
      store,
      acknowledgeLocate,
      searchEvents,
      navigateToEvent,
      get state() { return latest },
      rerender: (overrides: Partial<UseChatSearchInput>, attachRefs = true) => {
        view.rerender(<Probe overrides={{ ...initial, ...overrides }} attachRefs={attachRefs} />)
      },
    }
  }

  it('waits for open state before consuming sidebar locateRequest, pulses locatedSeq, and clears on Escape', () => {
    vi.useFakeTimers()
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
    const request: SessionLocateRequest = {
      requestId: 3,
      seq: SessionSeq(12),
      query: 'alpha',
      mode: 'hybrid',
    }
    const h = mountSearchHook({ isOpen: false, locateRequest: request })
    expect(h.acknowledgeLocate).not.toHaveBeenCalled()
    expect(h.navigateToEvent).not.toHaveBeenCalled()

    // Once session finishes opening, consumes request, triggers pulse, and marks semantic match + Turn 2
    h.rerender({ isOpen: true, locateRequest: request })
    expect(h.acknowledgeLocate).toHaveBeenCalledWith(3)
    expect(h.navigateToEvent).toHaveBeenCalledWith(12, 2, expect.any(Function))
    expect(h.store.getSnapshot().locatedSeq).toBe(12)
    expect(h.store.getSnapshot().semanticMatchSeq).toBe(12)
    expect([...h.state.matchedTurns]).toEqual([2])
    expect(h.state.activeMatchTurn).toBe(2)

    // Second locateRequest while pulse timer is still pending resets the timer cleanly
    const request2: SessionLocateRequest = {
      requestId: 4,
      seq: SessionSeq(2),
      query: 'alpha',
      mode: 'hybrid',
    }
    h.rerender({ isOpen: true, locateRequest: request2 })
    expect(h.store.getSnapshot().locatedSeq).toBe(2)
    expect(h.store.getSnapshot().semanticMatchSeq).toBeNull()

    act(() => {
      vi.advanceTimersByTime(1200)
    })
    expect(h.store.getSnapshot().locatedSeq).toBeNull()

    // Escape clears passive locate when not defaultPrevented
    const preventedEscape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    preventedEscape.preventDefault()
    act(() => { document.dispatchEvent(preventedEscape) })
    expect(h.state.activeMatchTurn).toBe(1)

    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(h.state.activeMatchTurn).toBeNull()
    expect([...h.state.matchedTurns]).toEqual([])

    // Locate request omitting mode defaults to hybrid; omitting query jumps without passive highlights
    h.rerender({ isOpen: true, locateRequest: { requestId: 5, seq: SessionSeq(2), query: 'alpha' } })
    expect(h.state.activeMatchTurn).toBe(1)
    h.rerender({ isOpen: true, locateRequest: { requestId: 6, seq: SessionSeq(2) } })
    expect(h.state.activeMatchTurn).toBeNull()
  })

  it('handles platform Cmd/Ctrl+F shortcuts, modal/access/empty guards, debounced RPCs, cycling, and cleanup', async () => {
    vi.useFakeTimers()
    const platformSpy = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
    const h = mountSearchHook()

    // Unattached listRef ignores keydown
    h.rerender({}, false)
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyF', metaKey: true })) })
    expect(h.state.open).toBe(false)

    // Disabled access or empty transcript ignores Cmd+F
    h.rerender({ canSearchEvents: false })
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyF', metaKey: true })) })
    expect(h.state.open).toBe(false)

    h.rerender({ canSearchEvents: true, hasContent: false })
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyF', metaKey: true })) })
    expect(h.state.open).toBe(false)

    // Behind a modal dialog ignores Cmd+F
    h.rerender({ canSearchEvents: true, hasContent: true })
    function ForegroundModal() {
      const dialogRef = useRef<HTMLDivElement>(null)
      useModalLayer(dialogRef, true, () => {})
      return <div ref={dialogRef} role="dialog" aria-modal="true" />
    }
    const modalView = render(<ForegroundModal />)
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyF', metaKey: true })) })
    expect(h.state.open).toBe(false)
    modalView.unmount()

    // Wrong modifiers ignored on Mac (Ctrl+F, Alt+Cmd+F, Shift+Cmd+F)
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyF', ctrlKey: true }))
      document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyF', metaKey: true, altKey: true }))
      document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyF', metaKey: true, shiftKey: true }))
    })
    expect(h.state.open).toBe(false)

    // Pre-fills from passiveLocate when opening Cmd+F with empty query
    h.rerender({
      locateRequest: { requestId: 9, seq: SessionSeq(2), query: 'seeded', mode: 'phrase' },
    })
    h.rerender({ locateRequest: null })
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyF', metaKey: true, cancelable: true }))
    })
    expect(h.state.open).toBe(true)
    expect(h.state.query).toBe('seeded')
    expect(h.state.mode).toBe('phrase')

    // Windows/Linux Ctrl+F re-focuses open bar without overwriting non-empty query
    platformSpy.mockReturnValue('Win32')
    const prevFocusVersion = h.state.focusVersion
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyF', metaKey: true }))
    })
    expect(h.state.focusVersion).toBe(prevFocusVersion)
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyF', ctrlKey: true }))
    })
    expect(h.state.focusVersion).toBe(prevFocusVersion + 1)

    // next / previous with zero hits are safe no-ops
    act(() => {
      h.state.next()
      h.state.previous()
    })

    // Rapid query changes abort in-flight requests (both late resolve and late reject)
    let resolveFirst!: (res: SessionEventSearchResult) => void
    let rejectSecond!: (err: Error) => void
    h.searchEvents
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectSecond = reject }))
      .mockResolvedValueOnce({
        ok: true,
        value: {
          items: [
            { seq: 12, role: 'assistant', snippet: 'hit 2', time: 2 },
            { seq: 2, role: 'user', snippet: 'hit 1', time: 1 },
          ],
          hasMore: true,
        },
      })

    act(() => { h.state.setQuery('first') })
    act(() => { vi.advanceTimersByTime(150) })
    act(() => { h.state.setQuery('second') })
    act(() => { vi.advanceTimersByTime(150) })
    act(() => { h.state.setQuery('alpha') })
    resolveFirst({ ok: true, value: { items: [{ seq: 99, role: 'user', snippet: 'stale', time: 3 }], hasMore: false } })
    rejectSecond(new Error('aborted error'))
    await act(async () => {
      vi.advanceTimersByTime(150)
      await Promise.resolve()
    })

    // Sorted ascending [2, 12], jumps initially to latest hit (index 1 -> seq 12)
    expect(h.state.matchCount).toBe(2)
    expect(h.state.hasMore).toBe(true)
    expect(h.state.activeIndex).toBe(1)
    expect([...h.state.matchedTurns]).toEqual([1, 2])
    expect(h.state.activeMatchTurn).toBe(2)

    // Wrap-around next -> index 0 (seq 2), previous -> index 1 (seq 12)
    act(() => { h.state.next() })
    expect(h.state.activeIndex).toBe(0)
    expect(h.state.activeMatchTurn).toBe(1)
    act(() => { h.state.previous() })
    expect(h.state.activeIndex).toBe(1)

    // Toggle mode ('phrase' -> 'hybrid' -> 'phrase') triggers empty result handling
    h.searchEvents.mockResolvedValueOnce({ ok: true, value: { items: [], hasMore: false } })
    act(() => { h.state.toggleMode() })
    await act(async () => {
      vi.advanceTimersByTime(150)
      await Promise.resolve()
    })
    expect(h.state.mode).toBe('hybrid')
    expect(h.state.matchCount).toBe(0)
    expect(h.state.activeIndex).toBe(-1)

    // Error result (`ok: false`) and rejected promise reset hits cleanly
    h.searchEvents.mockResolvedValueOnce({
      ok: false,
      error: { code: 'E', message: 'failed' } as never,
    })
    act(() => { h.state.toggleMode() })
    await act(async () => {
      vi.advanceTimersByTime(150)
      await Promise.resolve()
    })
    expect(h.state.matchCount).toBe(0)

    h.searchEvents.mockRejectedValueOnce(new Error('network failure'))
    act(() => { h.state.setQuery('boom') })
    await act(async () => {
      vi.advanceTimersByTime(150)
      await Promise.resolve()
    })
    expect(h.state.searching).toBe(false)
    expect(h.state.matchCount).toBe(0)

    // Clearing query to whitespace resets state immediately
    act(() => { h.state.setQuery('   ') })
    expect(h.state.searching).toBe(false)

    // Re-trigger pulse then close & unmount while timer is active
    h.rerender({ locateRequest: { requestId: 10, seq: SessionSeq(2), query: 'alpha', mode: 'hybrid' } })
    expect(h.store.getSnapshot().locatedSeq).toBe(2)
    act(() => { h.state.close() })
    expect(h.state.open).toBe(false)
    expect(h.store.getSnapshot().locatedSeq).toBeNull()

    h.rerender({ locateRequest: { requestId: 11, seq: SessionSeq(2), query: 'alpha', mode: 'hybrid' } })
    h.view.unmount()
  })
})
