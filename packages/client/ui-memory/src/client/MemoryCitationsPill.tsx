/** Turn-tail memory citation pill with inline inspect, edit, pause, and delete popover. */
import { useId, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  Button,
  IconContextInjectionOutlineRegular,
  IconEditOutlineRegular,
  IconRightUpOutlineRegular,
  IconTrashOutlineRegular,
  Switch,
  Tag,
  useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  MemoryCitationItem,
  MemoryId,
  MemoryUpdatePatch,
} from '@deepseek-ai/dsh-memory/client'
import {
  workspaceFolderName,
  type MemoryActionOutcome,
  type MemoryCatalogSnapshot,
  type MemoryErrorKey,
} from './catalog-source.ts'
import type { NS } from './locales.ts'
import { selectTurnMemoryCitations } from './memory-turn.ts'
import css from './MemoryCitationsPill.module.css'

/** Injected catalog observable and quick-action handlers for the Turn-tail citation pill. */
export interface MemoryCitationsInjected {
  readonly hooks: { readonly catalog: HostObservable<MemoryCatalogSnapshot> }
  readonly onUpdateEntry: (
    id: MemoryId,
    patch: MemoryUpdatePatch,
    expectedUpdatedAt?: string,
  ) => Promise<MemoryActionOutcome>
  readonly onDeleteEntry: (id: MemoryId) => Promise<MemoryActionOutcome>
  readonly onOpenMemoryCenter: () => void
}

/** Props of the Turn-tail memory citation pill. */
export type MemoryCitationsPillProps =
  PropsRuntime<'conversation.chat.turnTail'>
  & InjectFace<MemoryCitationsInjected>
  & PropsLocale<typeof NS>

/**
 * Render a subtle citation pill beneath a Turn's closing prose whenever that Turn
 * injected `<user_memory>` items, with an inline popover to inspect, pause, edit, or delete them.
 * @param props - Turn-tail owner currency, catalog actions, and localized copy.
 * @returns citation pill and anchored popover, or null when the Turn cited no memories.
 */
export function MemoryCitationsPill(props: MemoryCitationsPillProps) {
  const cited = selectTurnMemoryCitations(props)
  if (cited.length === 0) return null
  return <CitedMemoriesRow cited={cited} {...props} />
}

function CitedMemoriesRow({
  cited,
  useCatalog,
  onUpdateEntry,
  onDeleteEntry,
  onOpenMemoryCenter,
  t,
}: MemoryCitationsPillProps & { readonly cited: readonly MemoryCitationItem[] }) {
  const catalog = useCatalog(snapshot => snapshot)
  const [open, setOpen] = useState(false)
  const [editingId, setEditingId] = useState<MemoryId | null>(null)
  const [draftText, setDraftText] = useState('')
  const [busyId, setBusyId] = useState<MemoryId | null>(null)
  const [errorKey, setErrorKey] = useState<MemoryErrorKey | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const anchorName = `--dsh-memory-citations-${useId().replaceAll(':', '')}`

  useDismissOnOutsidePointer(rootRef, open, setOpen, popoverRef)

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape' || !open) return
    event.preventDefault()
    setOpen(false)
    setEditingId(null)
    triggerRef.current?.focus()
  }

  const label = t(cited.length === 1 ? 'citations.one' : 'citations.other', { count: cited.length })

  return (
    <div ref={rootRef} className={css.root} onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        style={{ anchorName }}
        className={css.pill}
        data-memory-citations-pill=""
        aria-expanded={open}
        onClick={() => {
          setErrorKey(null)
          setOpen(current => !current)
        }}
      >
        <IconContextInjectionOutlineRegular size={14} />
        <span>{label}</span>
      </button>
      {open && createPortal(
        <div
          ref={popoverRef}
          style={{ positionAnchor: anchorName }}
          className={css.popover}
          role="dialog"
          aria-label={t('citations.heading')}
          onKeyDown={onKeyDown}
        >
          <div className={css.popoverHeader}>
            <span className={css.popoverTitle}>{t('citations.heading')}</span>
            <button
              type="button"
              className={css.centerLink}
              onClick={() => {
                setOpen(false)
                onOpenMemoryCenter()
              }}
            >
              <span>{t('citations.openCenter')}</span>
              <IconRightUpOutlineRegular size={13} />
            </button>
          </div>
          {errorKey !== null && (
            <p className={css.errorNotice} role="alert">{t(errorKey)}</p>
          )}
          <ul className={css.list}>
            {cited.map((citation) => {
              const live = catalog.settled
                ? catalog.items.find(item => item.id === citation.id)
                : undefined
              const deleted = catalog.settled && live === undefined
              const displayContent = live?.content ?? citation.content
              const category = live?.category ?? citation.category
              const scope = live?.scope ?? citation.scope
              const isPaused = live?.status === 'paused'
              const isEditing = editingId === citation.id
              const isBusy = busyId === citation.id
              const scopeText = scope.kind === 'global'
                ? t('scope.badge.global')
                : t('scope.badge.workspace', { name: workspaceFolderName(scope.workspacePath) })

              return (
                <li key={citation.id} className={css.item}>
                  <div className={css.itemMeta}>
                    <Tag>{t(`category.${category}`)}</Tag>
                    <span className={css.scopeBadge}>{scopeText}</span>
                    {deleted && <Tag tone="neutral">{t('status.deleted')}</Tag>}
                    {!deleted && isPaused && <Tag tone="neutral">{t('status.paused')}</Tag>}
                  </div>
                  {isEditing ? (
                    <div className={css.editForm}>
                      <textarea
                        className={css.textarea}
                        rows={2}
                        aria-label={t('form.contentLabel')}
                        value={draftText}
                        onChange={(event) => { setDraftText(event.target.value) }}
                      />
                      <div className={css.editActions}>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={isBusy}
                          onClick={() => {
                            setEditingId(null)
                            setErrorKey(null)
                          }}
                        >
                          {t('action.cancel')}
                        </Button>
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={isBusy}
                          onClick={() => {
                            setBusyId(citation.id)
                            setErrorKey(null)
                            void onUpdateEntry(
                              citation.id,
                              { content: draftText },
                              live?.updatedAt,
                            ).then((outcome) => {
                              setBusyId(null)
                              if (outcome.ok) {
                                setEditingId(null)
                              } else {
                                setErrorKey(outcome.errorKey)
                              }
                            })
                          }}
                        >
                          {t('action.save')}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className={css.itemBody}>
                      <p className={deleted ? css.contentDeleted : css.contentText}>{displayContent}</p>
                      {!deleted && (
                        <div className={css.itemActions}>
                          <Switch
                            checked={!isPaused}
                            disabled={isBusy}
                            label={isPaused ? t('action.enable') : t('action.pause')}
                            onChange={(nextActive) => {
                              setBusyId(citation.id)
                              setErrorKey(null)
                              void onUpdateEntry(
                                citation.id,
                                { status: nextActive ? 'active' : 'paused' },
                                live?.updatedAt,
                              ).then((outcome) => {
                                setBusyId(null)
                                if (!outcome.ok) setErrorKey(outcome.errorKey)
                              })
                            }}
                          />
                          <button
                            type="button"
                            className={css.iconAction}
                            aria-label={t('action.edit')}
                            disabled={isBusy}
                            onClick={() => {
                              setEditingId(citation.id)
                              setDraftText(displayContent)
                              setErrorKey(null)
                            }}
                          >
                            <IconEditOutlineRegular size={14} />
                          </button>
                          <button
                            type="button"
                            className={css.iconAction}
                            aria-label={t('action.delete')}
                            disabled={isBusy}
                            onClick={() => {
                              setBusyId(citation.id)
                              setErrorKey(null)
                              void onDeleteEntry(citation.id).then((outcome) => {
                                setBusyId(null)
                                if (!outcome.ok) setErrorKey(outcome.errorKey)
                              })
                            }}
                          >
                            <IconTrashOutlineRegular size={14} />
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </div>,
        document.body,
      )}
    </div>
  )
}
