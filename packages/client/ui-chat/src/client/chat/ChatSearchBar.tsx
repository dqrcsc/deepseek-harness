/** Floating In-Session Find bar and lightweight history-locate status pill. */
import { memo, useEffect, useRef, type KeyboardEvent } from 'react'
import type { SessionSearchMode } from '@deepseek-ai/dsh-api-session-controller/client'
import {
  IconChevronDownOutlineRegular,
  IconChevronUpOutlineRegular,
  IconCloseOutlineRegular,
  IconSearchOutlineRegular,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import css from './ChatSearchBar.module.css'

/** Controlled props for the floating In-Session Find bar. */
export interface ChatSearchBarProps {
  readonly open: boolean
  readonly focusVersion: number
  readonly query: string
  readonly mode: SessionSearchMode
  readonly searching: boolean
  readonly locating: boolean
  readonly matchCount: number
  readonly activeIndex: number
  readonly hasMore: boolean
  readonly onQueryChange: (next: string) => void
  readonly onToggleMode: () => void
  readonly onPrevious: () => void
  readonly onNext: () => void
  readonly onClose: () => void
  readonly t: ChatViewSlotProps['t']
}

/**
 * Render the floating In-Session Find bar when open, or a compact locating pill during sidebar jumps.
 * @param props - Controlled search state and navigation callbacks.
 * @returns Sticky overlay anchored above the Chat transcript, or `null` when idle.
 */
export const ChatSearchBar = memo(function ChatSearchBar({
  open,
  focusVersion,
  query,
  mode,
  searching,
  locating,
  matchCount,
  activeIndex,
  hasMore,
  onQueryChange,
  onToggleMode,
  onPrevious,
  onNext,
  onClose,
  t,
}: ChatSearchBarProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!open || focusVersion === 0) return
    const input = inputRef.current as HTMLInputElement
    input.focus()
    input.select()
  }, [open, focusVersion])

  if (!open) {
    if (!locating) return null
    return (
      <div className={css.anchor}>
        <div className={css.locatePill} role="status" data-chat-locate-status="">
          {t('find.locating')}
        </div>
      </div>
    )
  }

  const trimmed = query.trim()
  const statusText = locating
    ? t('find.locating')
    : trimmed === ''
      ? ''
      : searching && matchCount === 0
        ? t('find.searching')
        : matchCount === 0
          ? t('find.noMatches')
          : t(hasMore ? 'find.countPlus' : 'find.count', {
            current: activeIndex + 1,
            total: matchCount,
          })

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      if (matchCount > 0) {
        if (event.shiftKey) onPrevious()
        else onNext()
      }
      return
    }
    if (event.key === 'ArrowDown' && matchCount > 0) {
      event.preventDefault()
      onNext()
      return
    }
    if (event.key === 'ArrowUp' && matchCount > 0) {
      event.preventDefault()
      onPrevious()
    }
  }

  const modeLabel = mode === 'hybrid' ? t('find.mode.hybrid') : t('find.mode.phrase')
  const modeHint = mode === 'hybrid' ? t('find.mode.hybridHint') : t('find.mode.phraseHint')

  return (
    <div className={css.anchor}>
      <div
        className={css.bar}
        role="search"
        aria-label={t('find.aria')}
        data-chat-search-bar=""
      >
        <span className={css.searchIcon} aria-hidden="true">
          <IconSearchOutlineRegular size={14} />
        </span>
        <input
          ref={inputRef}
          type="search"
          className={css.input}
          value={query}
          aria-label={t('find.aria')}
          placeholder={t('find.placeholder')}
          onChange={(event) => { onQueryChange(event.target.value) }}
          onKeyDown={handleKeyDown}
        />
        {statusText !== '' && (
          <span className={css.status} role="status" aria-live="polite" data-chat-search-status="">
            {statusText}
          </span>
        )}
        <Tooltip label={modeHint}>
          <button
            type="button"
            className={`${css.modeToggle}${mode === 'phrase' ? ` ${css.modeToggleActive}` : ''}`}
            aria-pressed={mode === 'phrase'}
            onClick={onToggleMode}
          >
            {modeLabel}
          </button>
        </Tooltip>
        <span className={css.divider} aria-hidden="true" />
        <Tooltip label={t('find.previous')}>
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('find.previous')}
            disabled={matchCount === 0}
            onClick={onPrevious}
          >
            <IconChevronUpOutlineRegular size={14} />
          </button>
        </Tooltip>
        <Tooltip label={t('find.next')}>
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('find.next')}
            disabled={matchCount === 0}
            onClick={onNext}
          >
            <IconChevronDownOutlineRegular size={14} />
          </button>
        </Tooltip>
        <Tooltip label={t('find.close')}>
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('find.close')}
            onClick={onClose}
          >
            <IconCloseOutlineRegular size={14} />
          </button>
        </Tooltip>
      </div>
    </div>
  )
})
