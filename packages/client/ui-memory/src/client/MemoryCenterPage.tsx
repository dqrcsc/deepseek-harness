/**
 * WorkBuddy-style cross-project and workspace-scoped Memory center main panel.
 */

import { useId, useMemo, useState } from 'react'
import clsx from 'clsx'
import {
  Button,
  IconCloseOutlineRegular,
  IconEditOutlineRegular,
  IconFolderOpenOutlineRegular,
  IconGlobeOutlineRegular,
  IconPinFillRegular,
  IconPinOutlineRegular,
  IconPlusOutlineRegular,
  IconRightUpOutlineRegular,
  IconSearchOutlineRegular,
  IconTrashOutlineRegular,
  Modal,
  Switch,
  Tag,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {
  MemoryCategory,
  MemoryClearScopeRequest,
  MemoryCreateRequest,
  MemoryId,
  MemoryPreferencesPatch,
  MemoryRecord,
  MemoryScope,
  MemoryUpdatePatch,
} from '@deepseek-ai/dsh-memory/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  isSessionAvailable,
  workspaceFolderName,
  type MemoryActionOutcome,
  type MemoryCatalogSnapshot,
  type MemoryErrorKey,
} from './catalog-source.ts'
import type { NS } from './locales.ts'
import css from './MemoryCenterPage.module.css'

/** Injected catalog state and actions for the Memory center page. */
export interface MemoryCenterInjected {
  readonly hooks: { readonly catalog: HostObservable<MemoryCatalogSnapshot> }
  readonly onRefresh: () => Promise<void>
  readonly onCreateEntry: (request: MemoryCreateRequest) => Promise<MemoryActionOutcome>
  readonly onUpdateEntry: (
    id: MemoryId,
    patch: MemoryUpdatePatch,
    expectedUpdatedAt?: string,
  ) => Promise<MemoryActionOutcome>
  readonly onDeleteEntry: (id: MemoryId) => Promise<MemoryActionOutcome>
  readonly onClearScope: (scope: MemoryClearScopeRequest['scope']) => Promise<MemoryActionOutcome>
  readonly onUpdatePreferences: (patch: MemoryPreferencesPatch) => Promise<MemoryActionOutcome>
  readonly onOpenSession: (sessionId: SessionId) => void
}

/** Full props of the Memory center main panel. */
export type MemoryCenterPageProps =
  PropsRuntime<'main'>
  & InjectFace<MemoryCenterInjected>
  & PropsLocale<typeof NS>

type ScopeFilter = 'all' | 'global' | 'workspace'
type CategoryFilter = 'all' | MemoryCategory

const CATEGORIES: readonly MemoryCategory[] = ['profile', 'preference', 'workflow', 'fact', 'constraint']

function resolveEntryScope(scopeKind: 'global' | 'workspace', workspacePath: string): MemoryScope | null {
  if (scopeKind === 'global') return { kind: 'global' }
  const trimmed = workspacePath.trim()
  if (trimmed.length === 0) return null
  return { kind: 'workspace', workspacePath: trimmed }
}

function sourceSessionIdOf(record: MemoryRecord): SessionId | undefined {
  return record.source.kind === 'user' ? undefined : record.source.sessionId
}

/**
 * Render the cross-project Memory center page with preferences, filters, search,
 * manual creation, bulk scope clearing, and atomic entry controls.
 * @param props - framework standard hooks, catalog actions, and localized dictionary.
 * @returns Memory center panel markup.
 */
export function MemoryCenterPage(props: MemoryCenterPageProps) {
  const {
    useCatalog,
    useSessions,
    useWorkspaces,
    onRefresh,
    onCreateEntry,
    onUpdateEntry,
    onDeleteEntry,
    onClearScope,
    onUpdatePreferences,
    onOpenSession,
    t,
  } = props

  const catalog = useCatalog(snapshot => snapshot)
  const sessions = useSessions(snapshot => snapshot)
  const workspaces = useWorkspaces(snapshot => snapshot)

  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('all')
  const [workspaceFilter, setWorkspaceFilter] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all')
  const [search, setSearch] = useState('')
  const [pageError, setPageError] = useState<MemoryErrorKey | null>(null)
  const [prefBusy, setPrefBusy] = useState(false)

  const [addOpen, setAddOpen] = useState(false)
  const [addContent, setAddContent] = useState('')
  const [addCategory, setAddCategory] = useState<MemoryCategory>('preference')
  const [addScopeKind, setAddScopeKind] = useState<'global' | 'workspace'>('global')
  const [addWorkspacePath, setAddWorkspacePath] = useState('')
  const [addPinned, setAddPinned] = useState(false)
  const [addError, setAddError] = useState<MemoryErrorKey | null>(null)
  const [addSaving, setAddSaving] = useState(false)

  const [clearOpen, setClearOpen] = useState(false)
  const [clearing, setClearing] = useState(false)

  const [editingId, setEditingId] = useState<MemoryId | null>(null)
  const [editContent, setEditContent] = useState('')
  const [editCategory, setEditCategory] = useState<MemoryCategory>('fact')
  const [editScopeKind, setEditScopeKind] = useState<'global' | 'workspace'>('global')
  const [editWorkspacePath, setEditWorkspacePath] = useState('')
  const [busyEntryId, setBusyEntryId] = useState<MemoryId | null>(null)

  const workspaceDatalistId = useId()

  const workspaceChoices = useMemo(() => {
    const paths = new Set<string>()
    for (const ws of workspaces.items) {
      if (ws.path.trim().length > 0) paths.add(ws.path)
    }
    for (const item of catalog.items) {
      if (item.scope.kind === 'workspace') paths.add(item.scope.workspacePath)
    }
    return [...paths].sort()
  }, [catalog.items, workspaces.items])

  const counts = useMemo(() => {
    let globalCount = 0
    let workspaceCount = 0
    for (const item of catalog.items) {
      if (item.scope.kind === 'global') globalCount += 1
      else workspaceCount += 1
    }
    return { all: catalog.items.length, global: globalCount, workspace: workspaceCount }
  }, [catalog.items])

  const filteredItems = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return catalog.items.filter((item) => {
      if (scopeFilter === 'global' && item.scope.kind !== 'global') return false
      if (scopeFilter === 'workspace') {
        if (item.scope.kind !== 'workspace') return false
        if (workspaceFilter !== '' && item.scope.workspacePath !== workspaceFilter) return false
      }
      if (categoryFilter !== 'all' && item.category !== categoryFilter) return false
      if (needle === '') return true
      const wsText = item.scope.kind === 'workspace' ? item.scope.workspacePath.toLowerCase() : ''
      return item.content.toLowerCase().includes(needle) || wsText.includes(needle)
    })
  }, [catalog.items, categoryFilter, scopeFilter, search, workspaceFilter])

  const openAddModal = (): void => {
    setAddContent('')
    setAddCategory('preference')
    setAddScopeKind(scopeFilter === 'workspace' ? 'workspace' : 'global')
    setAddWorkspacePath(workspaceFilter !== '' ? workspaceFilter : (workspaceChoices[0] ?? ''))
    setAddPinned(false)
    setAddError(null)
    setAddOpen(true)
  }

  const togglePreference = (patch: MemoryPreferencesPatch): void => {
    setPrefBusy(true)
    setPageError(null)
    void onUpdatePreferences(patch).then((outcome) => {
      setPrefBusy(false)
      if (!outcome.ok) setPageError(outcome.errorKey)
    })
  }

  const clearTargetScope = (): MemoryClearScopeRequest['scope'] => {
    if (scopeFilter === 'global') return { kind: 'global' }
    if (scopeFilter === 'workspace' && workspaceFilter !== '') {
      return { kind: 'workspace', workspacePath: workspaceFilter }
    }
    return { kind: 'all' }
  }

  const clearModalTitleKey = scopeFilter === 'global'
    ? 'clearModal.titleGlobal'
    : (scopeFilter === 'workspace' && workspaceFilter !== '' ? 'clearModal.titleWorkspace' : 'clearModal.titleAll')

  return (
    <div className={css.page} data-memory-center-page="">
      <div className={css.pageScroll}>
        <div className={css.pageContent}>
          <header className={css.pageHeading}>
            <div className={css.headingText}>
              <h1>{t('title')}</h1>
              <p className={css.subtitle}>{t('subtitle')}</p>
            </div>
            <div className={css.headerActions}>
              <Button
                variant="outline"
                size="sm"
                disabled={catalog.items.length === 0}
                onClick={() => {
                  setPageError(null)
                  setClearOpen(true)
                }}
              >
                {t('clear')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                icon={<IconPlusOutlineRegular size={15} />}
                onClick={openAddModal}
              >
                {t('add')}
              </Button>
            </div>
          </header>

          <section className={css.prefsPanel}>
            <div className={css.prefRow}>
              <div className={css.prefCopy}>
                <span className={css.prefTitle}>{t('prefs.autoExtract.label')}</span>
                <span className={css.prefHint}>{t('prefs.autoExtract.hint')}</span>
              </div>
              <Switch
                checked={catalog.preferences.autoExtractEnabled}
                disabled={prefBusy}
                label={t('prefs.autoExtract.label')}
                onChange={(next) => { togglePreference({ autoExtractEnabled: next }) }}
              />
            </div>
            <div className={css.prefRow}>
              <div className={css.prefCopy}>
                <span className={css.prefTitle}>{t('prefs.autoInject.label')}</span>
                <span className={css.prefHint}>{t('prefs.autoInject.hint')}</span>
              </div>
              <Switch
                checked={catalog.preferences.autoInjectEnabled}
                disabled={prefBusy}
                label={t('prefs.autoInject.label')}
                onChange={(next) => { togglePreference({ autoInjectEnabled: next }) }}
              />
            </div>
            <div className={css.prefRow}>
              <div className={css.prefCopy}>
                <span className={css.prefTitle}>{t('prefs.incognitoIsolatesRead.label')}</span>
                <span className={css.prefHint}>{t('prefs.incognitoIsolatesRead.hint')}</span>
              </div>
              <Switch
                checked={catalog.preferences.incognitoIsolatesRead}
                disabled={prefBusy}
                label={t('prefs.incognitoIsolatesRead.label')}
                onChange={(next) => { togglePreference({ incognitoIsolatesRead: next }) }}
              />
            </div>
          </section>

          <div className={css.toolbar}>
            <div className={css.scopeRow}>
              <div className={css.filterGroup}>
                {(['all', 'global', 'workspace'] as const).map(kind => (
                  <button
                    key={kind}
                    type="button"
                    className={clsx(css.filterChip, scopeFilter === kind && css.filterChipActive)}
                    aria-pressed={scopeFilter === kind}
                    onClick={() => { setScopeFilter(kind) }}
                  >
                    {t(`scope.${kind}`, { count: counts[kind] })}
                  </button>
                ))}
              </div>
              {scopeFilter === 'workspace' && workspaceChoices.length > 0 && (
                <select
                  className={css.selectControl}
                  aria-label={t('form.workspaceLabel')}
                  value={workspaceFilter}
                  onChange={(event) => { setWorkspaceFilter(event.target.value) }}
                >
                  <option value="">{t('scope.allWorkspaces')}</option>
                  {workspaceChoices.map(path => (
                    <option key={path} value={path}>{path}</option>
                  ))}
                </select>
              )}
            </div>

            <div className={css.filterGroup}>
              <button
                type="button"
                className={clsx(css.filterChip, categoryFilter === 'all' && css.filterChipActive)}
                aria-pressed={categoryFilter === 'all'}
                onClick={() => { setCategoryFilter('all') }}
              >
                {t('category.all')}
              </button>
              {CATEGORIES.map(cat => (
                <button
                  key={cat}
                  type="button"
                  className={clsx(css.filterChip, categoryFilter === cat && css.filterChipActive)}
                  aria-pressed={categoryFilter === cat}
                  onClick={() => { setCategoryFilter(cat) }}
                >
                  {t(`category.${cat}`)}
                </button>
              ))}
            </div>

            <div className={css.searchBox}>
              <IconSearchOutlineRegular size={15} className={css.searchIcon} />
              <input
                type="search"
                className={css.searchInput}
                aria-label={t('search.label')}
                placeholder={t('search.placeholder')}
                value={search}
                onChange={(event) => { setSearch(event.target.value) }}
              />
              {search !== '' && (
                <button
                  type="button"
                  className={css.searchClear}
                  aria-label={t('action.clearSearch')}
                  onClick={() => { setSearch('') }}
                >
                  <IconCloseOutlineRegular size={14} />
                </button>
              )}
            </div>
          </div>

          {pageError !== null && (
            <div className={css.errorBanner} role="alert">
              <span>{t(pageError)}</span>
            </div>
          )}

          {!catalog.settled && catalog.status === 'loading' && (
            <p className={css.stateMessage}>{t('loading')}</p>
          )}

          {!catalog.settled && catalog.status === 'error' && (
            <div className={css.errorState}>
              <p className={css.stateMessage}>{t('error.load')}</p>
              <Button size="sm" variant="outline" onClick={() => { void onRefresh() }}>
                {t('action.retry')}
              </Button>
            </div>
          )}

          {catalog.settled && catalog.items.length === 0 && (
            <div className={css.emptyState}>
              <h2 className={css.emptyTitle}>{t('empty.title')}</h2>
              <p className={css.emptyDescription}>{t('empty.description')}</p>
              <Button variant="primary" size="sm" icon={<IconPlusOutlineRegular size={15} />} onClick={openAddModal}>
                {t('add')}
              </Button>
            </div>
          )}

          {catalog.settled && catalog.items.length > 0 && filteredItems.length === 0 && (
            <p className={css.stateMessage}>{t('empty.filtered')}</p>
          )}

          {filteredItems.length > 0 && (
            <ul className={css.cardList}>
              {filteredItems.map((record) => {
                const isEditing = editingId === record.id
                const isBusy = busyEntryId === record.id
                const sourceSessionId = sourceSessionIdOf(record)
                const canOpenSession = sourceSessionId !== undefined
                  && isSessionAvailable(sourceSessionId, sessions, workspaces)

                return (
                  <li key={record.id} className={clsx(css.card, record.status === 'paused' && css.cardPaused)}>
                    <div className={css.cardHeader}>
                      <div className={css.cardBadges}>
                        <Tag tone="info">{t(`category.${record.category}`)}</Tag>
                        {record.scope.kind === 'global' ? (
                          <span className={css.metaBadge}>
                            <IconGlobeOutlineRegular size={13} />
                            <span>{t('scope.badge.global')}</span>
                          </span>
                        ) : (
                          <Tooltip label={record.scope.workspacePath} side="top" portal>
                            <span className={css.metaBadge}>
                              <IconFolderOpenOutlineRegular size={13} />
                              <span>
                                {t('scope.badge.workspace', { name: workspaceFolderName(record.scope.workspacePath) })}
                              </span>
                            </span>
                          </Tooltip>
                        )}
                        <span className={css.sourceBadge}>{t(`source.${record.source.kind}`)}</span>
                        {record.status === 'paused' && <Tag tone="neutral">{t('status.paused')}</Tag>}
                      </div>

                      <div className={css.cardControls}>
                        <Tooltip label={record.pinned ? t('action.unpin') : t('action.pin')} side="top" portal>
                          <button
                            type="button"
                            className={clsx(css.cardIconBtn, record.pinned && css.cardIconBtnPinned)}
                            aria-pressed={record.pinned}
                            aria-label={record.pinned ? t('action.unpin') : t('action.pin')}
                            disabled={isBusy}
                            onClick={() => {
                              setBusyEntryId(record.id)
                              setPageError(null)
                              void onUpdateEntry(record.id, { pinned: !record.pinned }, record.updatedAt).then((res) => {
                                setBusyEntryId(null)
                                if (!res.ok) setPageError(res.errorKey)
                              })
                            }}
                          >
                            {record.pinned ? <IconPinFillRegular size={14} /> : <IconPinOutlineRegular size={14} />}
                          </button>
                        </Tooltip>

                        <Switch
                          checked={record.status === 'active'}
                          disabled={isBusy}
                          label={record.status === 'active' ? t('action.pause') : t('action.enable')}
                          onChange={(nextActive) => {
                            setBusyEntryId(record.id)
                            setPageError(null)
                            void onUpdateEntry(
                              record.id,
                              { status: nextActive ? 'active' : 'paused' },
                              record.updatedAt,
                            ).then((res) => {
                              setBusyEntryId(null)
                              if (!res.ok) setPageError(res.errorKey)
                            })
                          }}
                        />

                        <Tooltip label={t('action.edit')} side="top" portal>
                          <button
                            type="button"
                            className={css.cardIconBtn}
                            aria-label={t('action.edit')}
                            disabled={isBusy}
                            onClick={() => {
                              setEditingId(record.id)
                              setEditContent(record.content)
                              setEditCategory(record.category)
                              setEditScopeKind(record.scope.kind)
                              setEditWorkspacePath(
                                record.scope.kind === 'workspace'
                                  ? record.scope.workspacePath
                                  : (workspaceChoices[0] ?? ''),
                              )
                              setPageError(null)
                            }}
                          >
                            <IconEditOutlineRegular size={14} />
                          </button>
                        </Tooltip>

                        {sourceSessionId !== undefined && canOpenSession && (
                          <Tooltip label={t('action.openSession')} side="top" portal>
                            <button
                              type="button"
                              className={css.cardIconBtn}
                              aria-label={t('action.openSession')}
                              onClick={() => { onOpenSession(sourceSessionId) }}
                            >
                              <IconRightUpOutlineRegular size={14} />
                            </button>
                          </Tooltip>
                        )}

                        <Tooltip label={t('action.delete')} side="top" portal>
                          <button
                            type="button"
                            className={css.cardIconBtn}
                            aria-label={t('action.delete')}
                            disabled={isBusy}
                            onClick={() => {
                              setBusyEntryId(record.id)
                              setPageError(null)
                              void onDeleteEntry(record.id).then((res) => {
                                setBusyEntryId(null)
                                if (!res.ok) setPageError(res.errorKey)
                              })
                            }}
                          >
                            <IconTrashOutlineRegular size={14} />
                          </button>
                        </Tooltip>
                      </div>
                    </div>

                    {isEditing ? (
                      <div className={css.inlineEditor}>
                        <textarea
                          className={css.editorTextarea}
                          rows={3}
                          aria-label={t('form.contentLabel')}
                          value={editContent}
                          onChange={(event) => { setEditContent(event.target.value) }}
                        />
                        <div className={css.editorControlsRow}>
                          <select
                            className={css.selectControl}
                            aria-label={t('form.categoryLabel')}
                            value={editCategory}
                            onChange={(event) => { setEditCategory(event.target.value as MemoryCategory) }}
                          >
                            {CATEGORIES.map(cat => (
                              <option key={cat} value={cat}>{t(`category.${cat}`)}</option>
                            ))}
                          </select>
                          <select
                            className={css.selectControl}
                            aria-label={t('form.scopeLabel')}
                            value={editScopeKind}
                            onChange={(event) => {
                              setEditScopeKind(event.target.value as 'global' | 'workspace')
                            }}
                          >
                            <option value="global">{t('form.scopeGlobal')}</option>
                            <option value="workspace">{t('form.scopeWorkspace')}</option>
                          </select>
                          {editScopeKind === 'workspace' && (
                            <input
                              type="text"
                              list={workspaceDatalistId}
                              className={css.pathInput}
                              aria-label={t('form.workspaceLabel')}
                              placeholder={t('form.workspacePlaceholder')}
                              value={editWorkspacePath}
                              onChange={(event) => { setEditWorkspacePath(event.target.value) }}
                            />
                          )}
                        </div>
                        <div className={css.editorButtons}>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={isBusy}
                            onClick={() => {
                              setEditingId(null)
                              setPageError(null)
                            }}
                          >
                            {t('action.cancel')}
                          </Button>
                          <Button
                            size="sm"
                            variant="primary"
                            disabled={isBusy}
                            onClick={() => {
                              const nextScope = resolveEntryScope(editScopeKind, editWorkspacePath)
                              if (nextScope === null) {
                                setPageError('error.invalidScope')
                                return
                              }
                              setBusyEntryId(record.id)
                              setPageError(null)
                              void onUpdateEntry(
                                record.id,
                                {
                                  content: editContent,
                                  category: editCategory,
                                  scope: nextScope,
                                },
                                record.updatedAt,
                              ).then((res) => {
                                setBusyEntryId(null)
                                if (res.ok) {
                                  setEditingId(null)
                                } else {
                                  setPageError(res.errorKey)
                                }
                              })
                            }}
                          >
                            {t('action.save')}
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <p className={css.statement}>{record.content}</p>
                    )}
                  </li>
                )
              })}
            </ul>
          )}

          <datalist id={workspaceDatalistId}>
            {workspaceChoices.map(path => (
              <option key={path} value={path} />
            ))}
          </datalist>
        </div>
      </div>

      <Modal
        open={addOpen}
        onClose={() => { setAddOpen(false) }}
        title={t('form.addTitle')}
        closeLabel={t('action.close')}
        footer={(
          <div className={css.modalFooter}>
            <Button variant="ghost" size="sm" disabled={addSaving} onClick={() => { setAddOpen(false) }}>
              {t('action.cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={addSaving}
              onClick={() => {
                const scope = resolveEntryScope(addScopeKind, addWorkspacePath)
                if (scope === null) {
                  setAddError('error.invalidScope')
                  return
                }
                setAddSaving(true)
                setAddError(null)
                void onCreateEntry({
                  content: addContent,
                  category: addCategory,
                  scope,
                  pinned: addPinned,
                }).then((outcome) => {
                  setAddSaving(false)
                  if (outcome.ok) {
                    setAddOpen(false)
                  } else {
                    setAddError(outcome.errorKey)
                  }
                })
              }}
            >
              {t('action.save')}
            </Button>
          </div>
        )}
      >
        <div className={css.modalForm}>
          {addError !== null && (
            <p className={css.errorBanner} role="alert">{t(addError)}</p>
          )}
          <label className={css.fieldBlock}>
            <span className={css.fieldLabel}>{t('form.contentLabel')}</span>
            <textarea
              data-modal-autofocus=""
              className={css.editorTextarea}
              rows={3}
              placeholder={t('form.contentPlaceholder')}
              value={addContent}
              onChange={(event) => { setAddContent(event.target.value) }}
            />
          </label>
          <div className={css.fieldRow}>
            <label className={css.fieldBlock}>
              <span className={css.fieldLabel}>{t('form.categoryLabel')}</span>
              <select
                className={css.selectControl}
                value={addCategory}
                onChange={(event) => { setAddCategory(event.target.value as MemoryCategory) }}
              >
                {CATEGORIES.map(cat => (
                  <option key={cat} value={cat}>{t(`category.${cat}`)}</option>
                ))}
              </select>
            </label>
            <label className={css.fieldBlock}>
              <span className={css.fieldLabel}>{t('form.scopeLabel')}</span>
              <select
                className={css.selectControl}
                value={addScopeKind}
                onChange={(event) => { setAddScopeKind(event.target.value as 'global' | 'workspace') }}
              >
                <option value="global">{t('form.scopeGlobal')}</option>
                <option value="workspace">{t('form.scopeWorkspace')}</option>
              </select>
            </label>
          </div>
          {addScopeKind === 'workspace' && (
            <label className={css.fieldBlock}>
              <span className={css.fieldLabel}>{t('form.workspaceLabel')}</span>
              <input
                type="text"
                list={workspaceDatalistId}
                className={css.pathInput}
                placeholder={t('form.workspacePlaceholder')}
                value={addWorkspacePath}
                onChange={(event) => { setAddWorkspacePath(event.target.value) }}
              />
            </label>
          )}
          <div className={css.pinRow}>
            <span className={css.fieldLabel}>{t('form.pinLabel')}</span>
            <Switch
              checked={addPinned}
              disabled={addSaving}
              label={t('form.pinLabel')}
              onChange={setAddPinned}
            />
          </div>
        </div>
      </Modal>

      <Modal
        open={clearOpen}
        onClose={() => { setClearOpen(false) }}
        title={t(clearModalTitleKey)}
        description={t('clearModal.description')}
        tone="warning"
        closeLabel={t('action.close')}
        footer={(
          <div className={css.modalFooter}>
            <Button variant="ghost" size="sm" disabled={clearing} onClick={() => { setClearOpen(false) }}>
              {t('action.cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={clearing}
              onClick={() => {
                setClearing(true)
                void onClearScope(clearTargetScope()).then((outcome) => {
                  setClearing(false)
                  setClearOpen(false)
                  if (!outcome.ok) setPageError(outcome.errorKey)
                })
              }}
            >
              {t('clearModal.confirm')}
            </Button>
          </div>
        )}
      />
    </div>
  )
}
