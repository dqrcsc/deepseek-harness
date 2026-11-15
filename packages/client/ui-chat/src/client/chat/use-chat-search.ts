/** Coordinates sidebar search-result locate intents, In-Session Find, highlights, and Turn Rail match markers. */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { SessionEventSearchItem, SessionSearchMode } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionLocateRequest } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { isBehindModal } from '@deepseek-ai/dsh-client-ui-primitives'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import {
  findTurnForSeq,
  resolveMatchedTurns,
  resolveTurnSeqBounds,
  type TurnRailItem,
} from './turn-rail-items.ts'
import type { ChatNavigation } from './use-chat-navigation.ts'
import { useChatSearchHighlights } from './use-chat-search-highlights.ts'

const SEARCH_DEBOUNCE_MS = 150
const LOCATE_PULSE_MS = 1200

interface PassiveLocateState {
  readonly query: string
  readonly mode: SessionSearchMode
  readonly seq: number
}

/** Input parameters for {@link useChatSearch}. */
export interface UseChatSearchInput {
  readonly isOpen: boolean
  readonly hasContent: boolean
  readonly canSearchEvents: boolean
  readonly listRef: RefObject<HTMLDivElement>
  readonly columnRef: RefObject<HTMLDivElement>
  readonly contentVersion: unknown
  readonly railItems: readonly TurnRailItem[]
  readonly nodeStore: { readonly get: (key: string) => { readonly anchorSeq: number } | undefined }
  readonly locateRequest: SessionLocateRequest | null
  readonly acknowledgeLocate: ChatViewSlotProps['acknowledgeLocate']
  readonly searchEvents: ChatViewSlotProps['searchEvents']
  readonly navigateToEvent: ChatNavigation['navigateToEvent']
  readonly actions: ChatViewSlotProps['actions']
}

/** State and callbacks exposed by {@link useChatSearch} to `ChatView`. */
export interface ChatSearchState {
  readonly open: boolean
  readonly focusVersion: number
  readonly query: string
  readonly mode: SessionSearchMode
  readonly searching: boolean
  readonly matchCount: number
  readonly activeIndex: number
  readonly hasMore: boolean
  readonly matchedTurns: ReadonlySet<number>
  readonly activeMatchTurn: number | null
  readonly setQuery: (next: string) => void
  readonly toggleMode: () => void
  readonly previous: () => void
  readonly next: () => void
  readonly close: () => void
}

function isPrimaryFindShortcut(event: KeyboardEvent): boolean {
  if (event.code !== 'KeyF' || event.altKey || event.shiftKey) return false
  const mac = /Mac|iPhone|iPad|iPod/iu.test(navigator.platform)
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}

/**
 * Own per-Session search navigation, lossless `CSS.highlights`, and Turn Rail match projection.
 * @param input - Committed Chat window, injected RPCs, and navigation controls.
 * @returns Controlled props for `ChatSearchBar` and `TurnNavigator`.
 */
export function useChatSearch(input: UseChatSearchInput): ChatSearchState {
  const {
    isOpen,
    hasContent,
    canSearchEvents,
    listRef,
    columnRef,
    contentVersion,
    railItems,
    nodeStore,
    locateRequest,
    acknowledgeLocate,
    searchEvents,
    navigateToEvent,
    actions,
  } = input
  const [open, setOpen] = useState(false)
  const [focusVersion, setFocusVersion] = useState(0)
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<SessionSearchMode>('hybrid')
  const [searching, setSearching] = useState(false)
  const [hits, setHits] = useState<readonly SessionEventSearchItem[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [passiveLocate, setPassiveLocate] = useState<PassiveLocateState | null>(null)
  const pulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const locatedSeqRef = useRef<number | null>(null)
  const semanticSeqRef = useRef<number | null>(null)

  const updateLocatedSeq = useCallback((seq: number | null) => {
    if (locatedSeqRef.current === seq) return
    locatedSeqRef.current = seq
    actions.setLocatedSeq(seq)
  }, [actions])

  const setSemanticMatchSeq = useCallback((seq: number | null) => {
    if (semanticSeqRef.current === seq) return
    semanticSeqRef.current = seq
    actions.setSemanticMatchSeq(seq)
  }, [actions])

  const clearPulse = useCallback(() => {
    if (pulseTimerRef.current !== null) {
      clearTimeout(pulseTimerRef.current)
      pulseTimerRef.current = null
    }
    updateLocatedSeq(null)
  }, [updateLocatedSeq])

  const triggerPulse = useCallback((seq: number) => {
    if (pulseTimerRef.current !== null) clearTimeout(pulseTimerRef.current)
    updateLocatedSeq(seq)
    pulseTimerRef.current = setTimeout(() => {
      pulseTimerRef.current = null
      updateLocatedSeq(null)
    }, LOCATE_PULSE_MS)
  }, [updateLocatedSeq])

  useEffect(() => () => {
    if (pulseTimerRef.current !== null) clearTimeout(pulseTimerRef.current)
  }, [])

  const hasSearchOrLocate = open || passiveLocate !== null || locateRequest !== null
  const turnBounds = useMemo(
    () => (hasSearchOrLocate ? resolveTurnSeqBounds(railItems, key => nodeStore.get(key)?.anchorSeq) : []),
    [hasSearchOrLocate, railItems, nodeStore],
  )
  const turnBoundsRef = useRef(turnBounds)
  turnBoundsRef.current = turnBounds

  const jumpToSeq = useCallback((seq: number) => {
    const turnHint = findTurnForSeq(turnBoundsRef.current, seq)
    navigateToEvent(SessionSeq(seq), turnHint, (landed) => {
      triggerPulse(landed)
    })
  }, [navigateToEvent, triggerPulse])

  useLayoutEffect(() => {
    if (locateRequest === null || !isOpen) return
    acknowledgeLocate(locateRequest.requestId)
    setOpen(false)
    setSearching(false)
    if (locateRequest.query !== undefined && locateRequest.query.trim() !== '') {
      setPassiveLocate({
        query: locateRequest.query,
        mode: locateRequest.mode ?? 'hybrid',
        seq: locateRequest.seq,
      })
    } else {
      setPassiveLocate(null)
    }
    jumpToSeq(locateRequest.seq)
  }, [locateRequest, isOpen, acknowledgeLocate, jumpToSeq])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const root = listRef.current
      if (root === null || isBehindModal(root)) return
      if (isPrimaryFindShortcut(event)) {
        if (!canSearchEvents || !hasContent) return
        event.preventDefault()
        if (!open && passiveLocate !== null && query.trim() === '') {
          setQuery(passiveLocate.query)
          setMode(passiveLocate.mode)
        }
        setOpen(true)
        setFocusVersion(version => version + 1)
        return
      }
      if (!open && passiveLocate !== null && event.key === 'Escape' && !event.defaultPrevented) {
        setPassiveLocate(null)
        clearPulse()
        setSemanticMatchSeq(null)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [canSearchEvents, hasContent, listRef, open, passiveLocate, query, clearPulse, setSemanticMatchSeq])

  useEffect(() => {
    if (!open || !canSearchEvents) return
    const trimmed = query.trim()
    if (trimmed === '') {
      setSearching(false)
      setHits([])
      setHasMore(false)
      setActiveIndex(-1)
      clearPulse()
      setSemanticMatchSeq(null)
      return
    }
    setSearching(true)
    const controller = new AbortController()
    const timer = setTimeout(() => {
      void searchEvents(trimmed, { mode }, controller.signal).then(
        (result) => {
          if (controller.signal.aborted) return
          setSearching(false)
          if (!result.ok) {
            setHits([])
            setHasMore(false)
            setActiveIndex(-1)
            return
          }
          const sorted = [...result.value.items].sort((left, right) => left.seq - right.seq)
          setHits(sorted)
          setHasMore(result.value.hasMore)
          if (sorted.length === 0) {
            setActiveIndex(-1)
            clearPulse()
            return
          }
          const initialIndex = sorted.length - 1
          setActiveIndex(initialIndex)
          jumpToSeq((sorted[initialIndex] as SessionEventSearchItem).seq)
        },
        () => {
          if (controller.signal.aborted) return
          setSearching(false)
          setHits([])
          setHasMore(false)
          setActiveIndex(-1)
        },
      )
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [open, canSearchEvents, query, mode, searchEvents, clearPulse, setSemanticMatchSeq, jumpToSeq])

  const activeSeq = open
    ? (hits[activeIndex]?.seq ?? null)
    : passiveLocate?.seq ?? null
  const highlightQuery = open ? query : passiveLocate?.query ?? ''
  const highlightMode = open ? mode : passiveLocate?.mode ?? 'hybrid'

  useChatSearchHighlights({
    columnRef,
    query: highlightQuery,
    mode: highlightMode,
    activeSeq,
    contentVersion,
    onSemanticMatchSeq: setSemanticMatchSeq,
  })

  const matchedSeqs = useMemo<readonly number[]>(() => {
    if (open) return hits.map(hit => hit.seq)
    return passiveLocate === null ? [] : [passiveLocate.seq]
  }, [open, hits, passiveLocate])

  const matchedTurns = useMemo(
    () => resolveMatchedTurns(turnBounds, matchedSeqs),
    [turnBounds, matchedSeqs],
  )
  const activeMatchTurn = useMemo(
    () => (activeSeq === null ? null : findTurnForSeq(turnBounds, activeSeq)),
    [turnBounds, activeSeq],
  )

  const next = useCallback(() => {
    if (hits.length === 0) return
    const nextIndex = (activeIndex + 1) % hits.length
    setActiveIndex(nextIndex)
    jumpToSeq((hits[nextIndex] as SessionEventSearchItem).seq)
  }, [hits, activeIndex, jumpToSeq])

  const previous = useCallback(() => {
    if (hits.length === 0) return
    const prevIndex = (activeIndex - 1 + hits.length) % hits.length
    setActiveIndex(prevIndex)
    jumpToSeq((hits[prevIndex] as SessionEventSearchItem).seq)
  }, [hits, activeIndex, jumpToSeq])

  const toggleMode = useCallback(() => {
    setMode(current => (current === 'hybrid' ? 'phrase' : 'hybrid'))
  }, [])

  const close = useCallback(() => {
    setOpen(false)
    setPassiveLocate(null)
    setSearching(false)
    clearPulse()
    setSemanticMatchSeq(null)
  }, [clearPulse, setSemanticMatchSeq])

  return {
    open,
    focusVersion,
    query,
    mode,
    searching,
    matchCount: hits.length,
    activeIndex,
    hasMore,
    matchedTurns,
    activeMatchTurn,
    setQuery,
    toggleMode,
    previous,
    next,
    close,
  }
}
