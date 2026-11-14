/**
 * Cross-project persistent memory service (`ctx.memory`) with durable storage, session privacy policies,
 * Remote management methods, and hybrid budget-bounded context selection.
 * @module @deepseek-ai/dsh-memory
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-embedding'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_ENTRY_BYTES,
  DEFAULT_MAX_INJECT_BYTES,
  DEFAULT_MAX_INJECT_ENTRIES,
  DEFAULT_MEMORY_PREFERENCES,
  MemoryId,
  MemoryInputError,
  compareCatalogRecords,
  containsSensitiveSecret,
  deduplicationKey,
  monotonicTimestamp,
  normalizeMemoryContent,
  normalizeMemoryScope,
  normalizeWorkspacePath,
  sameMemoryScope,
  validateMemoryCategory,
} from './domain.ts'
import { selectMemoriesForContext, tokenizeForRelevance } from './selector.ts'
import { memoryDomain } from './storage.ts'
import type {
  MemoryCatalogRequest,
  MemoryCatalogResult,
  MemoryClearScopeRequest,
  MemoryClearScopeResult,
  MemoryContextSelectRequest,
  MemoryContextSelection,
  MemoryCreateRequest,
  MemoryDeleteRequest,
  MemoryDeleteResult,
  MemoryPreferences,
  MemoryPreferencesPatch,
  MemoryRecord,
  MemorySupersedeRequest,
  MemoryUpdateRequest,
  MemoryUpdateResult,
  SessionMemoryPolicy,
  SessionMemoryPolicyRequest,
  SetSessionMemoryPolicyRequest,
} from './types.ts'

export { MemoryInputError } from './domain.ts'
export type * from './client.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Cross-project persistent user and workspace memory service. */
    memory: MemoryService
  }
}

/** Configuration bounds for Host-wide memory storage and context snapshot selection. */
export interface Config {
  /** Maximum active and paused memory entries retained; defaults to 500. */
  maxEntries?: number
  /** Maximum UTF-8 bytes allowed in a single memory entry's `content`; defaults to 1024. */
  maxEntryBytes?: number
  /** Maximum number of memory entries injected into one context snapshot; defaults to 25. */
  maxInjectEntries?: number
  /** Maximum UTF-8 bytes of the rendered `<user_memory>` context snapshot; defaults to 8192. */
  maxInjectBytes?: number
}

interface ResolvedLimits {
  readonly maxEntries: number
  readonly maxEntryBytes: number
  readonly maxInjectEntries: number
  readonly maxInjectBytes: number
}

function throwRemoteMemoryInput(error: unknown): never {
  if (error instanceof MemoryInputError) {
    throw new RemoteError('memory/input-invalid', error.message, { code: error.reason })
  }
  throw error
}

function matchesQuery(record: MemoryRecord, rawQuery: string | undefined): boolean {
  const trimmed = rawQuery?.trim().toLowerCase()
  if (trimmed === undefined || trimmed.length === 0) return true
  if (record.content.toLowerCase().includes(trimmed)) return true
  const queryTokens = tokenizeForRelevance(trimmed)
  if (queryTokens.size === 0) return true
  const docTokens = tokenizeForRelevance(record.content)
  for (const token of queryTokens) {
    if (!docTokens.has(token)) return false
  }
  return true
}

/**
 * Host-wide persistent memory service backed by `ctx.storageDomain` (`memory` domain).
 */
export class MemoryService extends TypertRemoteService {
  static inject = ['storageDomain']

  static Config: z<Config> = z.object({
    maxEntries: z.number().step(1).min(1).max(10_000).default(DEFAULT_MAX_ENTRIES),
    maxEntryBytes: z.number().step(1).min(64).max(16_384).default(DEFAULT_MAX_ENTRY_BYTES),
    maxInjectEntries: z.number().step(1).min(1).max(200).default(DEFAULT_MAX_INJECT_ENTRIES),
    maxInjectBytes: z.number().step(1).min(256).max(65_536).default(DEFAULT_MAX_INJECT_BYTES),
  })

  private readonly limits: ResolvedLimits
  private readonly ready: Promise<Domain<typeof memoryDomain>>
  private readonly initialized: PromiseLike<unknown>
  private liveDomain: Domain<typeof memoryDomain> | undefined
  private chain: Promise<unknown> = Promise.resolve()
  private stopping = false

  /**
   * @param ctx - Host context owning `storageDomain` and optional `embedding`.
   * @param config - validated capacity and context-budget limits.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'memory')
    this.limits = {
      maxEntries: config.maxEntries ?? DEFAULT_MAX_ENTRIES,
      maxEntryBytes: config.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES,
      maxInjectEntries: config.maxInjectEntries ?? DEFAULT_MAX_INJECT_ENTRIES,
      maxInjectBytes: config.maxInjectBytes ?? DEFAULT_MAX_INJECT_BYTES,
    }
    this.ready = ctx.storageDomain.open(memoryDomain).then((domain) => {
      this.liveDomain = domain
      return domain
    })
    this.initialized = ctx.effect(async () => {
      const domain = await this.ready
      const offChanged = ctx.on('domain/changed', (change) => {
        if (change.domain === 'memory') this.emitChanged()
      })
      return async () => {
        this.stopping = true
        offChanged()
        await this.chain
        this.liveDomain = undefined
        await domain.close()
      }
    })
  }

  async [Service.init](): Promise<void> {
    await this.initialized
  }

  /**
   * Synchronously inspect whether candidate text matches secret-redaction patterns.
   * @param text - candidate string to inspect.
   * @returns `true` when `text` contains a high-confidence credential or secret pattern.
   */
  containsSensitiveContent(text: string): boolean {
    return containsSensitiveSecret(text)
  }

  /**
   * Synchronously report whether a session is currently marked incognito.
   * @param sessionId - target session identifier.
   * @returns `true` when the session suppresses automatic extraction and cross-session recall.
   */
  isSessionIncognito(sessionId: SessionId): boolean {
    if (this.liveDomain === undefined) return false
    return this.liveDomain.table('session_policies').get(sessionId)?.incognito === true
  }

  /**
   * Read current Host-wide memory preferences synchronously from authoritative in-memory state.
   * @returns current {@link MemoryPreferences}.
   */
  @Remote('getPreferences')
  getPreferences(): MemoryPreferences {
    if (this.liveDomain === undefined) return DEFAULT_MEMORY_PREFERENCES
    return { ...this.liveDomain.global.get() }
  }

  /**
   * Read one session's memory privacy policy synchronously.
   * @param request - target session identifier.
   * @returns stored policy, or `{ incognito: false, updatedAt: '' }` when unset.
   */
  @Remote('getSessionPolicy')
  getSessionPolicy(request: SessionMemoryPolicyRequest): SessionMemoryPolicy {
    const existing = this.liveDomain?.table('session_policies').get(request.sessionId)
    if (existing !== undefined) return { ...existing }
    return { sessionId: request.sessionId, incognito: false, updatedAt: '' }
  }

  /**
   * Update Host-wide memory preferences durably.
   * @param patch - partial preference fields to update.
   * @param signal - optional cancellation checked before writing.
   * @returns committed {@link MemoryPreferences}.
   */
  @Remote('setPreferences')
  async setPreferences(patch: MemoryPreferencesPatch, signal?: AbortSignal): Promise<MemoryPreferences> {
    return this.serialize(async () => {
      const domain = await this.getDomain()
      signal?.throwIfAborted()
      const current = domain.global.get()
      const next: MemoryPreferences = {
        autoExtractEnabled: patch.autoExtractEnabled ?? current.autoExtractEnabled,
        autoInjectEnabled: patch.autoInjectEnabled ?? current.autoInjectEnabled,
        incognitoIsolatesRead: patch.incognitoIsolatesRead ?? current.incognitoIsolatesRead,
      }
      await domain.global.set(next)
      return { ...next }
    })
  }

  /**
   * Set or clear incognito mode for one session durably.
   * @param request - session identifier and desired `incognito` flag.
   * @param signal - optional cancellation checked before writing.
   * @returns committed {@link SessionMemoryPolicy}.
   */
  @Remote('setSessionPolicy')
  async setSessionPolicy(
    request: SetSessionMemoryPolicyRequest,
    signal?: AbortSignal,
  ): Promise<SessionMemoryPolicy> {
    return this.serialize(async () => {
      const domain = await this.getDomain()
      signal?.throwIfAborted()
      const policies = domain.table('session_policies')
      const previous = policies.get(request.sessionId)
      const next: SessionMemoryPolicy = {
        sessionId: request.sessionId,
        incognito: request.incognito,
        updatedAt: monotonicTimestamp(previous?.updatedAt, Date.now()),
      }
      await policies.put(request.sessionId, next)
      return { ...next }
    })
  }

  /**
   * Read filtered memory entries and current Host preferences.
   * @param request - optional scope, category, query, and superseded filters.
   * @returns matching records sorted in catalog order alongside current preferences.
   */
  async catalog(request: MemoryCatalogRequest = {}): Promise<MemoryCatalogResult> {
    const domain = await this.getDomain()
    const scopeKind = request.scopeKind ?? 'all'
    const normalizedWorkspace = request.workspacePath !== undefined && request.workspacePath.trim().length > 0
      ? normalizeWorkspacePath(request.workspacePath)
      : undefined
    const includeSuperseded = request.includeSuperseded === true
    const items = [...domain.table('entries').entries()]
      .map(([, record]) => record)
      .filter((record) => {
        if (!includeSuperseded && record.status === 'superseded') return false
        if (request.category !== undefined && record.category !== request.category) return false
        if (scopeKind === 'global' && record.scope.kind !== 'global') return false
        if (scopeKind === 'workspace') {
          if (record.scope.kind !== 'workspace') return false
          if (normalizedWorkspace !== undefined && record.scope.workspacePath !== normalizedWorkspace) return false
        }
        if (scopeKind === 'applicable') {
          if (record.scope.kind === 'workspace' && record.scope.workspacePath !== normalizedWorkspace) return false
        }
        return matchesQuery(record, request.query)
      })
      .sort(compareCatalogRecords)
    return {
      items,
      preferences: { ...domain.global.get() },
    }
  }

  /**
   * Remote entry point for {@link catalog}, translating validation errors to `memory/input-invalid`.
   * @param request - scope, category, query, and superseded filters.
   * @returns matching records alongside current preferences.
   */
  @Remote('catalog')
  async remoteCatalog(request: MemoryCatalogRequest): Promise<MemoryCatalogResult> {
    try {
      return await this.catalog(request)
    } catch (error: unknown) {
      throwRemoteMemoryInput(error)
    }
  }

  /**
   * Create a persistent memory item, deduplicating exact statements within the same scope.
   * @param request - statement content, category, scope, optional pin state, and source.
   * @param signal - optional cancellation checked before writing.
   * @returns created or deduplicated {@link MemoryRecord}.
   */
  async create(request: MemoryCreateRequest, signal?: AbortSignal): Promise<MemoryRecord> {
    const content = normalizeMemoryContent(request.content, this.limits.maxEntryBytes)
    const category = validateMemoryCategory(request.category)
    const scope = normalizeMemoryScope(request.scope)
    const source = request.source ?? { kind: 'user' as const }
    return this.serialize(async () => {
      const domain = await this.getDomain()
      signal?.throwIfAborted()
      const entries = domain.table('entries')
      const dedup = deduplicationKey(content)
      for (const [, existing] of entries.entries()) {
        if (existing.status === 'superseded') continue
        if (sameMemoryScope(existing.scope, scope) && deduplicationKey(existing.content) === dedup) {
          const updated: MemoryRecord = {
            ...existing,
            content,
            category,
            pinned: request.pinned ?? existing.pinned,
            status: 'active',
            updatedAt: monotonicTimestamp(existing.updatedAt, Date.now()),
          }
          await entries.put(existing.id, updated)
          return updated
        }
      }
      const liveCount = [...entries.entries()].filter(([, item]) => item.status !== 'superseded').length
      if (liveCount >= this.limits.maxEntries) {
        throw new MemoryInputError(
          'capacity_exceeded',
          `Memory store holds ${String(liveCount)} entries, reaching the ${String(this.limits.maxEntries)}-entry limit.`,
        )
      }
      const id = MemoryId(`mem-${randomUUID()}`)
      const createdAt = new Date().toISOString()
      const record: MemoryRecord = {
        id,
        content,
        category,
        scope,
        source,
        status: 'active',
        pinned: request.pinned === true,
        createdAt,
        updatedAt: createdAt,
      }
      await entries.put(id, record)
      return record
    })
  }

  /**
   * Remote entry point for {@link create} attributing new memories to `{ kind: 'user' }`.
   * @param request - statement content, category, scope, and optional pin state.
   * @param signal - optional cancellation checked before writing.
   * @returns committed {@link MemoryRecord}.
   */
  @Remote('create')
  async remoteCreate(request: MemoryCreateRequest, signal?: AbortSignal): Promise<MemoryRecord> {
    try {
      return await this.create({ ...request, source: { kind: 'user' } }, signal)
    } catch (error: unknown) {
      throwRemoteMemoryInput(error)
    }
  }

  /**
   * Update fields of one existing active or paused memory item.
   * @param request - target id, non-empty patch, and optional `expectedUpdatedAt` guard.
   * @param signal - optional cancellation checked before writing.
   * @returns updated record, or a non-mutating miss/conflict outcome.
   */
  async update(request: MemoryUpdateRequest, signal?: AbortSignal): Promise<MemoryUpdateResult> {
    const patch = request.patch
    if (
      patch.content === undefined
      && patch.category === undefined
      && patch.scope === undefined
      && patch.pinned === undefined
      && patch.status === undefined
    ) {
      throw new MemoryInputError('empty_patch', 'Memory update patch requires at least one field.')
    }
    const nextContent = patch.content === undefined
      ? undefined
      : normalizeMemoryContent(patch.content, this.limits.maxEntryBytes)
    const nextCategory = patch.category === undefined ? undefined : validateMemoryCategory(patch.category)
    const nextScope = patch.scope === undefined ? undefined : normalizeMemoryScope(patch.scope)

    return this.serialize(async () => {
      const domain = await this.getDomain()
      signal?.throwIfAborted()
      const entries = domain.table('entries')
      const current = entries.get(request.id)
      if (current === undefined) return { id: request.id, code: 'memory_not_found' }
      if (current.status === 'superseded') return { id: request.id, code: 'memory_superseded' }
      if (request.expectedUpdatedAt !== undefined && request.expectedUpdatedAt !== current.updatedAt) {
        return { id: request.id, code: 'memory_conflict' }
      }
      const updated: MemoryRecord = {
        ...current,
        content: nextContent ?? current.content,
        category: nextCategory ?? current.category,
        scope: nextScope ?? current.scope,
        pinned: patch.pinned ?? current.pinned,
        status: patch.status ?? current.status,
        updatedAt: monotonicTimestamp(current.updatedAt, Date.now()),
      }
      await entries.put(request.id, updated)
      return updated
    })
  }

  /**
   * Remote entry point for {@link update}.
   * @param request - target id, non-empty patch, and optional `expectedUpdatedAt` guard.
   * @param signal - optional cancellation checked before writing.
   * @returns updated record, or a non-mutating miss/conflict outcome.
   */
  @Remote('update')
  async remoteUpdate(request: MemoryUpdateRequest, signal?: AbortSignal): Promise<MemoryUpdateResult> {
    try {
      return await this.update(request, signal)
    } catch (error: unknown) {
      throwRemoteMemoryInput(error)
    }
  }

  /**
   * Supersede an outdated memory entry with a newly evolved entry in one serialized operation.
   * When `targetId` is missing or already superseded, creates the replacement entry directly.
   * @param request - target entry id and replacement attributes.
   * @param signal - optional cancellation checked before writing.
   * @returns newly stored replacement {@link MemoryRecord}.
   */
  async supersede(request: MemorySupersedeRequest, signal?: AbortSignal): Promise<MemoryRecord> {
    const content = normalizeMemoryContent(request.content, this.limits.maxEntryBytes)
    const category = validateMemoryCategory(request.category)
    const scope = normalizeMemoryScope(request.scope)
    return this.serialize(async () => {
      const domain = await this.getDomain()
      signal?.throwIfAborted()
      const entries = domain.table('entries')
      const target = entries.get(request.targetId)
      const liveCount = [...entries.entries()].filter(([, item]) => item.status !== 'superseded').length
      const replacingLive = target !== undefined && target.status !== 'superseded'
      if (!replacingLive && liveCount >= this.limits.maxEntries) {
        throw new MemoryInputError(
          'capacity_exceeded',
          `Memory store holds ${String(liveCount)} entries, reaching the ${String(this.limits.maxEntries)}-entry limit.`,
        )
      }
      const nowMs = Date.now()
      const createdAt = monotonicTimestamp(target?.updatedAt, nowMs)
      const replacementId = MemoryId(`mem-${randomUUID()}`)
      const replacement: MemoryRecord = {
        id: replacementId,
        content,
        category,
        scope,
        source: request.source,
        status: 'active',
        pinned: request.pinned ?? target?.pinned ?? false,
        createdAt,
        updatedAt: createdAt,
      }
      if (replacingLive) {
        await entries.put(target.id, {
          ...target,
          status: 'superseded',
          supersededBy: replacementId,
          updatedAt: createdAt,
        })
      }
      await entries.put(replacementId, replacement)
      return replacement
    })
  }

  /**
   * Permanently delete one memory entry by identifier.
   * @param request - target memory identifier.
   * @param signal - optional cancellation checked before writing.
   * @returns deletion outcome indicating whether the entry existed.
   */
  @Remote('delete')
  async delete(request: MemoryDeleteRequest, signal?: AbortSignal): Promise<MemoryDeleteResult> {
    return this.serialize(async () => {
      const domain = await this.getDomain()
      signal?.throwIfAborted()
      const deleted = await domain.table('entries').delete(request.id)
      return { id: request.id, deleted }
    })
  }

  /**
   * Delete all memory entries matching one scope or across the entire store.
   * @param request - scope selector (`global`, `workspace`, or `all`).
   * @param signal - optional cancellation checked before writing.
   * @returns count of deleted entries.
   */
  async clearScope(request: MemoryClearScopeRequest, signal?: AbortSignal): Promise<MemoryClearScopeResult> {
    const targetScope = request.scope.kind === 'all' ? request.scope : normalizeMemoryScope(request.scope)
    return this.serialize(async () => {
      const domain = await this.getDomain()
      signal?.throwIfAborted()
      const entries = domain.table('entries')
      const ids = [...entries.entries()]
        .filter(([, record]) => targetScope.kind === 'all' || sameMemoryScope(record.scope, targetScope))
        .map(([id]) => id)
      const deleted = await entries.deleteMany(ids)
      return { deleted }
    })
  }

  /**
   * Remote entry point for {@link clearScope}.
   * @param request - scope selector (`global`, `workspace`, or `all`).
   * @param signal - optional cancellation checked before writing.
   * @returns count of deleted entries.
   */
  @Remote('clearScope')
  async remoteClearScope(request: MemoryClearScopeRequest, signal?: AbortSignal): Promise<MemoryClearScopeResult> {
    try {
      return await this.clearScope(request, signal)
    } catch (error: unknown) {
      throwRemoteMemoryInput(error)
    }
  }

  /**
   * Select budget-bounded active memories for an upcoming agent model step.
   * @param request - optional session id, workspace path, latest user query text, and abort signal.
   * @returns canonical SHA-256 digest, rendered `<user_memory>` snapshot, and citation items.
   */
  async selectForContext(request: MemoryContextSelectRequest = {}): Promise<MemoryContextSelection> {
    const domain = await this.getDomain()
    const prefs = domain.global.get()
    if (!prefs.autoInjectEnabled) {
      return { digest: '', formattedText: '', items: [] }
    }
    if (
      request.sessionId !== undefined
      && prefs.incognitoIsolatesRead
      && domain.table('session_policies').get(request.sessionId)?.incognito === true
    ) {
      return { digest: '', formattedText: '', items: [] }
    }
    const normalizedWorkspace = request.workspacePath !== undefined && request.workspacePath.trim().length > 0
      ? normalizeWorkspacePath(request.workspacePath)
      : undefined
    const candidates = [...domain.table('entries').entries()]
      .map(([, record]) => record)
      .filter(record =>
        record.status === 'active'
        && (record.scope.kind === 'global'
          || (normalizedWorkspace !== undefined && record.scope.workspacePath === normalizedWorkspace)))
    const embedding = this.ctx.get('embedding')
    return selectMemoriesForContext(candidates, {
      ...(request.queryText === undefined ? {} : { queryText: request.queryText }),
      ...(embedding === undefined ? {} : { embedding }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      maxInjectEntries: this.limits.maxInjectEntries,
      maxInjectBytes: this.limits.maxInjectBytes,
    })
  }

  private emitChanged(): void {
    try {
      this.ctx.emit('memory/changed')
    } catch (error: unknown) {
      this.ctx.logger.warn(`memory: memory/changed listener failed: ${String(error)}`)
    }
  }

  private async getDomain(): Promise<Domain<typeof memoryDomain>> {
    await this.initialized
    return this.ready
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    if (this.stopping) return Promise.reject(new Error('Memory service is stopping'))
    const pending = this.chain.then(work)
    this.chain = pending.catch(() => undefined)
    return pending
  }
}

export default MemoryService
