// @vitest-environment jsdom
import { useRef } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionSearchMode } from '@deepseek-ai/dsh-api-session-controller/client'
import {
  applySearchHighlights,
  clearSearchHighlights,
  collectElementTermRanges,
  extractHighlightTerms,
  SEARCH_ACTIVE_HIGHLIGHT,
  SEARCH_MATCH_HIGHLIGHT,
  supportsCustomHighlights,
  useChatSearchHighlights,
} from '../src/client/chat/use-chat-search-highlights.ts'

class FakeHighlight {
  readonly ranges: Range[]
  priority = 0

  constructor(...ranges: Range[]) {
    this.ranges = ranges
  }
}

function installFakeCustomHighlights() {
  const registry = new Map<string, FakeHighlight>()
  vi.stubGlobal('Highlight', FakeHighlight)
  vi.stubGlobal('CSS', { highlights: registry })
  return registry
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('CSS Custom Highlight search engine', () => {
  it('detects CSS Custom Highlight API support across partial and complete environments', () => {
    vi.stubGlobal('CSS', undefined)
    expect(supportsCustomHighlights()).toBe(false)
    clearSearchHighlights()

    vi.stubGlobal('CSS', {})
    expect(supportsCustomHighlights()).toBe(false)

    vi.stubGlobal('CSS', { highlights: new Map() })
    vi.stubGlobal('Highlight', undefined)
    expect(supportsCustomHighlights()).toBe(false)

    const registry = installFakeCustomHighlights()
    expect(supportsCustomHighlights()).toBe(true)
    registry.set(SEARCH_MATCH_HIGHLIGHT, new FakeHighlight())
    registry.set(SEARCH_ACTIVE_HIGHLIGHT, new FakeHighlight())
    clearSearchHighlights()
    expect(registry.size).toBe(0)
  })

  it('extracts literal highlight terms for empty, phrase, and hybrid CJK + Latin queries', () => {
    expect(extractHighlightTerms('   ', 'hybrid')).toEqual([])
    expect(extractHighlightTerms('  foo + bar  ', 'phrase')).toEqual(['foo + bar'])
    expect(extractHighlightTerms('foo bar FOO', 'hybrid')).toEqual(['foo bar FOO', 'foo', 'bar'])
    const cjk = extractHighlightTerms('检索定位 engine', 'hybrid')
    expect(cjk[0]).toBe('检索定位 engine')
    expect(cjk).toContain('engine')
    expect(cjk.length).toBeGreaterThan(2)
  })

  it('collects visible text-node ranges via TreeWalker without mutating DOM or scanning excluded chrome', () => {
    const root = document.createElement('div')
    const emptyText = document.createTextNode('')
    const code = document.createElement('pre')
    code.innerHTML = '<span>const [a] = fn(x + y)</span>'
    const hiddenBlock = document.createElement('div')
    hiddenBlock.hidden = true
    hiddenBlock.textContent = 'fn(x + y)'
    const badge = document.createElement('div')
    badge.dataset.searchSemanticBadge = ''
    badge.textContent = 'fn(x + y)'
    const searchBar = document.createElement('div')
    searchBar.dataset.chatSearchBar = ''
    searchBar.textContent = 'fn(x + y)'
    const script = document.createElement('script')
    script.textContent = 'fn(x + y)'
    const style = document.createElement('style')
    style.textContent = '.x { content: "fn(x + y)"; }'
    root.append(emptyText, code, hiddenBlock, badge, searchBar, script, style)

    expect(collectElementTermRanges(root, [])).toEqual([])
    const snapshotHtml = root.innerHTML
    const ranges = collectElementTermRanges(root, ['fn(x + y)', '[a]'])
    expect(ranges.map(range => range.toString())).toEqual(['[a]', 'fn(x + y)'])
    expect(root.innerHTML).toBe(snapshotHtml)
  })

  it('registers match/active CSS.highlights with priorities and reports semantic-only hybrid matches', () => {
    const column = document.createElement('div')
    const row1 = document.createElement('div')
    row1.dataset.chatFlowKind = 'user'
    row1.dataset.chatEventSeq = '2'
    row1.textContent = 'Alpha token and alpha again'
    const row2 = document.createElement('div')
    row2.dataset.chatFlowKind = 'assistant-step'
    row2.dataset.chatEventSeq = '5'
    row2.textContent = 'Conceptually related reply without that keyword'
    const tail = document.createElement('div')
    tail.dataset.chatFlowKind = 'turn-tail'
    tail.textContent = 'Alpha in synthetic turn tail must be ignored'
    column.append(row1, row2, tail)

    expect(applySearchHighlights(null, 'alpha', 'hybrid', 2)).toEqual({
      totalLiteralRanges: 0,
      activeLiteralRanges: 0,
      targetMounted: false,
      semanticOnlyMatch: false,
    })

    // Without CSS.highlights (feature-detection fallback): still computes summary cleanly.
    vi.stubGlobal('CSS', undefined)
    expect(applySearchHighlights(column, 'alpha', 'hybrid', 2)).toEqual({
      totalLiteralRanges: 2,
      activeLiteralRanges: 2,
      targetMounted: true,
      semanticOnlyMatch: false,
    })

    const registry = installFakeCustomHighlights()
    const hitSummary = applySearchHighlights(column, 'alpha', 'hybrid', 2)
    expect(hitSummary).toEqual({
      totalLiteralRanges: 2,
      activeLiteralRanges: 2,
      targetMounted: true,
      semanticOnlyMatch: false,
    })
    expect(registry.get(SEARCH_MATCH_HIGHLIGHT)?.priority).toBe(0)
    expect(registry.get(SEARCH_MATCH_HIGHLIGHT)?.ranges).toHaveLength(2)
    expect(registry.get(SEARCH_ACTIVE_HIGHLIGHT)?.priority).toBe(1)
    expect(registry.get(SEARCH_ACTIVE_HIGHLIGHT)?.ranges).toHaveLength(2)

    // Semantic-only target in hybrid mode deletes active highlight and sets semanticOnlyMatch=true.
    const semanticSummary = applySearchHighlights(column, 'alpha', 'hybrid', 5)
    expect(semanticSummary).toEqual({
      totalLiteralRanges: 2,
      activeLiteralRanges: 0,
      targetMounted: true,
      semanticOnlyMatch: true,
    })
    expect(registry.has(SEARCH_MATCH_HIGHLIGHT)).toBe(true)
    expect(registry.has(SEARCH_ACTIVE_HIGHLIGHT)).toBe(false)

    // Phrase mode never claims semanticOnlyMatch even when active row has zero matches.
    const phraseSummary = applySearchHighlights(column, 'nonexistent', 'phrase', 5)
    expect(phraseSummary).toEqual({
      totalLiteralRanges: 0,
      activeLiteralRanges: 0,
      targetMounted: true,
      semanticOnlyMatch: false,
    })
    expect(registry.has(SEARCH_MATCH_HIGHLIGHT)).toBe(false)
    expect(registry.has(SEARCH_ACTIVE_HIGHLIGHT)).toBe(false)

    // Null activeSeq scans passive matches without an active target.
    expect(applySearchHighlights(column, 'alpha', 'hybrid', null)).toEqual({
      totalLiteralRanges: 2,
      activeLiteralRanges: 0,
      targetMounted: false,
      semanticOnlyMatch: false,
    })

    // Clearing query removes highlights.
    expect(applySearchHighlights(column, '   ', 'hybrid', 2)).toEqual({
      totalLiteralRanges: 0,
      activeLiteralRanges: 0,
      targetMounted: false,
      semanticOnlyMatch: false,
    })
    expect(registry.size).toBe(0)
  })

  it('synchronizes highlights across DOM mutations with rAF coalescing and cleans up on unmount', async () => {
    vi.useFakeTimers()
    const registry = installFakeCustomHighlights()
    const onSemanticMatchSeq = vi.fn<(seq: number | null) => void>()

    function Harness({
      query,
      mode = 'hybrid',
      activeSeq = 5,
      attachRef = true,
    }: {
      readonly query: string
      readonly mode?: SessionSearchMode
      readonly activeSeq?: number | null
      readonly attachRef?: boolean
    }) {
      const columnRef = useRef<HTMLDivElement>(null)
      useChatSearchHighlights({
        columnRef,
        query,
        mode,
        activeSeq,
        contentVersion: 1,
        onSemanticMatchSeq,
      })
      if (!attachRef) return <div />
      return (
        <div ref={columnRef} data-testid="col">
          <div data-chat-flow-kind="assistant-step" data-chat-event-seq="5">
            initial semantic content
          </div>
        </div>
      )
    }

    const unattached = render(<Harness query="needle" attachRef={false} />)
    expect(onSemanticMatchSeq).toHaveBeenCalledWith(null)
    unattached.unmount()

    onSemanticMatchSeq.mockClear()
    const view = render(<Harness query="needle" />)
    expect(onSemanticMatchSeq).toHaveBeenLastCalledWith(5)
    expect(registry.has(SEARCH_ACTIVE_HIGHLIGHT)).toBe(false)

    // Mutate DOM twice before the animation frame fires to exercise rAF coalescing.
    const row = view.getByTestId('col').firstElementChild as HTMLElement
    await act(async () => {
      row.textContent = 'updated with needle one'
      row.append(document.createTextNode(' and needle two'))
      await Promise.resolve()
    })
    act(() => {
      vi.advanceTimersToNextFrame()
    })
    expect(onSemanticMatchSeq).toHaveBeenLastCalledWith(null)
    expect(registry.get(SEARCH_ACTIVE_HIGHLIGHT)?.ranges).toHaveLength(2)

    // Trigger another mutation, then unmount before the queued rAF runs to exercise cancelAnimationFrame cleanup.
    await act(async () => {
      row.textContent = 'mutated right before unmount'
      await Promise.resolve()
    })
    view.unmount()
    expect(registry.size).toBe(0)
  })
})
