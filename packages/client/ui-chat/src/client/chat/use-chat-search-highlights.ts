/** Lossless in-DOM search highlighting via the CSS Custom Highlight API (`CSS.highlights`). */
import { useLayoutEffect, type RefObject } from 'react'
import type { SessionSearchMode } from '@deepseek-ai/dsh-api-session-controller/client'

/** Highlight registry name for all passive literal matches in the loaded Chat window. */
export const SEARCH_MATCH_HIGHLIGHT = 'dsh-search-match'

/** Highlight registry name for literal matches inside the active target event row. */
export const SEARCH_ACTIVE_HIGHLIGHT = 'dsh-search-active'

/** Outcome of scanning the mounted Chat column for literal query matches. */
export interface SearchHighlightSummary {
  readonly totalLiteralRanges: number
  readonly activeLiteralRanges: number
  readonly targetMounted: boolean
  readonly semanticOnlyMatch: boolean
}

const wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' })

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * Check whether the host runtime supports the CSS Custom Highlight API.
 * @returns `true` when `CSS.highlights` and `Highlight` are both available.
 */
export function supportsCustomHighlights(): boolean {
  return typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight === 'function'
}

/**
 * Remove both Chat search highlight registrations when supported.
 */
export function clearSearchHighlights(): void {
  if (!supportsCustomHighlights()) return
  CSS.highlights.delete(SEARCH_MATCH_HIGHLIGHT)
  CSS.highlights.delete(SEARCH_ACTIVE_HIGHLIGHT)
}

/**
 * Derive non-empty literal terms to highlight for a search query and mode.
 * @param query - Raw user search query.
 * @param mode - `'phrase'` for exact continuous substrings, `'hybrid'` for phrase plus word segments.
 * @returns Unique terms ordered longest-first so alternation prefers longer matches.
 */
export function extractHighlightTerms(query: string, mode: SessionSearchMode): string[] {
  const trimmed = query.trim()
  if (trimmed === '') return []
  if (mode === 'phrase') return [trimmed]
  const seen = new Set<string>([trimmed.toLocaleLowerCase()])
  const terms = [trimmed]
  for (const part of wordSegmenter.segment(trimmed)) {
    if (!part.isWordLike) continue
    const token = part.segment
    const key = token.toLocaleLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      terms.push(token)
    }
  }
  terms.sort((left, right) => right.length - left.length)
  return terms
}

/**
 * Walk visible text nodes under `root` via `TreeWalker` without mutating DOM structure.
 * @param root - Subtree root to scan.
 * @param terms - Non-empty literal terms ordered longest-first.
 * @returns Character `Range` instances covering every literal match in `root`.
 */
export function collectElementTermRanges(root: HTMLElement, terms: readonly string[]): Range[] {
  if (terms.length === 0) return []
  const pattern = new RegExp(terms.map(escapeRegExp).join('|'), 'giu')
  const ranges: Range[] = []
  const doc = root.ownerDocument
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = (node as Text).parentElement as HTMLElement
      if (parent.closest('[hidden], [data-search-semantic-badge], [data-chat-search-bar], script, style') !== null) {
        return NodeFilter.FILTER_REJECT
      }
      return NodeFilter.FILTER_ACCEPT
    },
  })
  for (let current = walker.nextNode(); current !== null; current = walker.nextNode()) {
    const text = (current as Text).data
    if (text === '') continue
    pattern.lastIndex = 0
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
      const range = doc.createRange()
      range.setStart(current, match.index)
      range.setEnd(current, match.index + match[0].length)
      ranges.push(range)
    }
  }
  return ranges
}

/**
 * Scan the mounted Chat column, register `CSS.highlights` ranges, and classify semantic-only targets.
 * @param column - Mounted Chat column element, or `null` while unmounted.
 * @param query - Active search query.
 * @param mode - Active search mode (`'hybrid'` or `'phrase'`).
 * @param activeSeq - Durable event `seq` of the focused match, or `null`.
 * @returns Match range counts and whether the mounted active target has zero literal occurrences.
 */
export function applySearchHighlights(
  column: HTMLElement | null,
  query: string,
  mode: SessionSearchMode,
  activeSeq: number | null,
): SearchHighlightSummary {
  const terms = extractHighlightTerms(query, mode)
  if (column === null || terms.length === 0) {
    clearSearchHighlights()
    return { totalLiteralRanges: 0, activeLiteralRanges: 0, targetMounted: false, semanticOnlyMatch: false }
  }
  const activeRow = activeSeq === null
    ? null
    : column.querySelector<HTMLElement>(`[data-chat-event-seq="${activeSeq}"]:not([hidden]):not([hidden] *)`)
  const rows = column.querySelectorAll<HTMLElement>(
    '[data-chat-flow-kind]:not([data-chat-flow-kind="turn-tail"]):not([data-chat-flow-kind="turn-process"]):not([hidden]):not([hidden] *)',
  )
  const allRanges: Range[] = []
  const activeRanges: Range[] = []
  for (const row of rows) {
    const rowRanges = collectElementTermRanges(row, terms)
    allRanges.push(...rowRanges)
    if (activeRow !== null && (row === activeRow || activeRow.contains(row))) {
      activeRanges.push(...rowRanges)
    }
  }
  if (supportsCustomHighlights()) {
    if (allRanges.length > 0) {
      const matchHighlight = new Highlight(...allRanges)
      matchHighlight.priority = 0
      CSS.highlights.set(SEARCH_MATCH_HIGHLIGHT, matchHighlight)
    } else {
      CSS.highlights.delete(SEARCH_MATCH_HIGHLIGHT)
    }
    if (activeRanges.length > 0) {
      const activeHighlight = new Highlight(...activeRanges)
      activeHighlight.priority = 1
      CSS.highlights.set(SEARCH_ACTIVE_HIGHLIGHT, activeHighlight)
    } else {
      CSS.highlights.delete(SEARCH_ACTIVE_HIGHLIGHT)
    }
  }
  return {
    totalLiteralRanges: allRanges.length,
    activeLiteralRanges: activeRanges.length,
    targetMounted: activeRow !== null,
    semanticOnlyMatch: mode === 'hybrid' && activeRow !== null && activeRanges.length === 0,
  }
}

/** Input parameters for {@link useChatSearchHighlights}. */
export interface UseChatSearchHighlightsInput {
  readonly columnRef: RefObject<HTMLDivElement>
  readonly query: string
  readonly mode: SessionSearchMode
  readonly activeSeq: number | null
  readonly contentVersion: unknown
  readonly onSemanticMatchSeq: (seq: number | null) => void
}

/**
 * Synchronize `CSS.highlights` and semantic-fallback state with rendered Chat DOM mutations.
 * @param input - Column ref, active search state, and semantic-fallback callback.
 */
export function useChatSearchHighlights(input: UseChatSearchHighlightsInput): void {
  const {
    columnRef,
    query,
    mode,
    activeSeq,
    contentVersion,
    onSemanticMatchSeq,
  } = input
  const effectiveVersion = query.trim() === '' ? null : contentVersion
  useLayoutEffect(() => {
    const column = columnRef.current
    if (column === null || query.trim() === '') {
      clearSearchHighlights()
      onSemanticMatchSeq(null)
      return
    }
    const sync = (): void => {
      const summary = applySearchHighlights(column, query, mode, activeSeq)
      onSemanticMatchSeq(summary.semanticOnlyMatch ? activeSeq : null)
    }
    sync()
    let frame: number | null = null
    const observer = new MutationObserver(() => {
      if (frame !== null) return
      frame = requestAnimationFrame(() => {
        frame = null
        sync()
      })
    })
    observer.observe(column, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['hidden'],
    })
    return () => {
      observer.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
      clearSearchHighlights()
    }
  }, [columnRef, query, mode, activeSeq, effectiveVersion, onSemanticMatchSeq])
}
