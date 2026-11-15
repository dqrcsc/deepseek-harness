/** Cold-safe Session list and search projection. */

import { performance } from 'node:perf_hooks'
import { scheduler } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle, ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import {
  SessionQueryError,
  type SessionEventMetadataFilter,
  type SessionRecord,
  type SessionSearchCursor,
} from '@deepseek-ai/dsh-session-query'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import {
  SESSION_EVENT_SEARCH_RESULT_LIMIT,
  SESSION_SEARCH_RESULT_LIMIT,
  SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS,
} from './types.ts'
import type {
  SessionListMetadata, SessionProjectionHints, SessionSearchEventItem,
  SessionSearchEventsMode, SessionSearchEventsRequest, SessionSearchEventsValue,
  SessionSearchItem, SessionSearchMessageRole, SessionSearchValue, SessionSummary,
} from './types.ts'

const SEARCH_PROVIDER_CALL_LIMIT = 100
const SESSION_SEARCH_QUERY_MAX_CHARS = 500
const MESSAGE_TYPES = new Set(['user/message', 'assistant/message'])
const MESSAGE_SEARCH_FILTERS: readonly SessionEventMetadataFilter[] = [
  { kind: 'type', values: ['user/message', 'assistant/message'] },
  { kind: 'surface', values: ['current'] },
]

const sessionListMetadataSchema: z.ZodType<SessionListMetadata> = z.object({
  blank: z.boolean(),
  lastPromptAt: z.number().nullable(),
})

const imageLimitsSchema = z.object({
  maxImageBytes: z.number().int().positive(),
  maxImagesPerMessage: z.number().int().positive(),
  maxMessageImageBytes: z.number().int().positive(),
  maxImagePixels: z.number().int().positive(),
  maxImageDimension: z.number().int().positive(),
  mediaTypes: z.array(z.string()),
}) as unknown as z.ZodType<ImageAttachmentLimits>

/**
 * Advance the Session-list metadata projection by one committed event.
 * @param state - metadata before the event.
 * @param event - next committed Session event.
 * @returns the original or advanced metadata value.
 */
export function applySessionListMetadata(
  state: SessionListMetadata,
  event: SessionEvent,
): SessionListMetadata {
  const blank = state.blank && event.type !== 'turn/start'
  const lastPromptAt = event.type === 'user/message' && event.data.source.kind === 'user'
    ? event.time
    : state.lastPromptAt
  return blank === state.blank && lastPromptAt === state.lastPromptAt
    ? state
    : { blank, lastPromptAt }
}

/**
 * Return the longest prefix containing at most `maximum` Unicode code points.
 * @param value - source text.
 * @param maximum - maximum number of Unicode code points.
 * @returns the source text or its longest allowed prefix.
 */
export function truncateUnicodeCodePoints(value: string, maximum: number): string {
  let count = 0
  let end = 0
  for (const codePoint of value) {
    if (count === maximum) return value.slice(0, end)
    count++
    end += codePoint.length
  }
  return value
}

/** Owns list projection registration, bounded cold summaries, and authorized search. */
export class ApiSessionList {
  private listMetadata!: ProjectionHandle<SessionListMetadata>

  /**
   * @param ctx - Host context carrying Session, query, persistence, and projection services.
   * @param workSliceMs - Resolved positive integral list-work budget in milliseconds.
   */
  constructor(private readonly ctx: Context, private readonly workSliceMs: number) {}

  /**
   * Acquire projection readers before exposing dependent operations.
   * @returns when all required registrations are ready.
   */
  async initialize(): Promise<void> {
    this.listMetadata = await this.ctx.sessionProjections.register<'sessionListMetadata', SessionListMetadata>({
      key: 'sessionListMetadata',
      stateSchema: sessionListMetadataSchema,
      init: () => ({ blank: true, lastPromptAt: null }),
      apply: applySessionListMetadata,
      wire: { viewSchema: sessionListMetadataSchema, view: state => state },
      stateVersion: 1,
    })
    await this.ctx.sessionProjections.register<'imageLimits', null>({
      key: 'imageLimits',
      stateSchema: z.null(),
      init: () => null,
      apply: state => state,
      wire: {
        viewSchema: imageLimitsSchema,
        view: () => this.ctx.attachments.imageLimits,
        summary: false,
      },
      stateVersion: 1,
    })
  }

  /**
   * Build one current attached-Session summary.
   * Blankness and recency come from the `sessionListMetadata` handle; projection
   * hints carry every summary key computed through `snapshot`. The first call
   * for a Session computes these projections over its whole in-memory log, and
   * later calls advance them incrementally. The handle read and the hint with
   * the same key come from one cell; the handle read does not depend on any
   * other unit's view.
   * @param session - attached Session to summarize.
   * @returns current list metadata and available projections.
   */
  summaryFor(session: Session): SessionSummary {
    const metadata = this.listMetadata.stateOf(session)
    const projections = this.projectionsFor(session.header, session)
    return {
      sessionId: session.id,
      updatedAt: updatedAt(session.header, metadata),
      agentAvailable: this.ctx.agents.get(session.id)?.session === session,
      formatStatus: 'current',
      running: this.ctx.agents.get(session.id)?.status === 'running',
      blank: metadata.blank,
      ...listFields(session.header),
      ...(projections === undefined ? {} : { projections }),
    }
  }

  /**
   * Read every visible attached and persisted Session without activating an Agent.
   * @param signal - optional cancellation for persistence reads and summary generation.
   * @returns visible Session summaries ordered by activity.
   */
  async list(signal?: AbortSignal): Promise<SessionSummary[]> {
    signal?.throwIfAborted()
    const records = await this.ctx.sessionQuery.listSessions(signal)
    signal?.throwIfAborted()
    const items: SessionSummary[] = []
    const cold: SessionRecord[] = []
    let yieldDeadline = performance.now() + this.workSliceMs
    for (const record of records) {
      signal?.throwIfAborted()
      const live = this.ctx.sessions.get(record.header.id)
      if (live !== undefined) {
        items.push(this.summaryFor(live))
      } else if (record.header.cwd !== undefined) {
        cold.push(record)
      }
      if (performance.now() >= yieldDeadline) {
        await scheduler.yield()
        signal?.throwIfAborted()
        yieldDeadline = performance.now() + this.workSliceMs
      }
    }
    for (const record of cold) {
      signal?.throwIfAborted()
      items.push(this.summarizeCold(record))
      if (performance.now() >= yieldDeadline) {
        await scheduler.yield()
        signal?.throwIfAborted()
        yieldDeadline = performance.now() + this.workSliceMs
      }
    }
    signal?.throwIfAborted()
    items.sort((left, right) => right.updatedAt - left.updatedAt)
    return items
  }

  private summarizeCold({ header, formatStatus }: SessionRecord): SessionSummary {
    const projections = this.projectionsFor(header, undefined)
    const metadata = projections?.values.sessionListMetadata
    return {
      sessionId: header.id,
      updatedAt: updatedAt(header, metadata),
      agentAvailable: false,
      ...(formatStatus === undefined ? {} : { formatStatus }),
      running: false,
      // A large, metadata-less, or inaccessible cache miss remains unknown and visible.
      blank: metadata?.blank ?? false,
      ...listFields(header),
      ...(projections === undefined ? {} : { projections }),
    }
  }

  /**
   * Search current visible message content without activating any matching Session.
   * @param query - literal message-content query.
   * @param signal - cancellation for list and search reads.
   * @returns authorized bounded Session search results.
   */
  async search(query: string, signal: AbortSignal): Promise<SessionSearchValue> {
    const normalizedQuery = normalizeSearchQuery(query)
    signal.throwIfAborted()
    const provider = requireSessionQuery(this.ctx)
    try {
      const visible = await provider.listSessions(signal)
      signal.throwIfAborted()
      const visibleIds = new Set(visible
        .filter(record => record.header.cwd !== undefined)
        .map(record => record.header.id))
      if (visibleIds.size === 0) return { items: [], hasMore: false }
      return await paginateAuthorizedSearch({
        label: 'session search provider',
        targetLimit: SESSION_SEARCH_RESULT_LIMIT,
        signal,
        fetchPage: (limit, cursor) => provider.searchSessions({
          query: normalizedQuery,
          mode: 'hybrid',
          eventFilters: MESSAGE_SEARCH_FILTERS,
          limit,
          ...(cursor === undefined ? {} : { cursor }),
        }, { signal }),
        acceptHit: (hit): { readonly key: SessionId; readonly item: SessionSearchItem } | undefined => {
          if (!visibleIds.has(hit.header.id)
            || hit.bestMatch.sessionId !== hit.header.id
            || hit.bestMatch.surface !== 'current'
            || !MESSAGE_TYPES.has(hit.bestMatch.type)) return undefined
          return {
            key: hit.header.id,
            item: {
              sessionId: hit.header.id,
              snippet: truncateUnicodeCodePoints(hit.bestMatch.snippet, SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS),
              seq: hit.bestMatch.seq,
              role: messageRoleOf(hit.bestMatch.type),
              time: hit.bestMatch.time,
              ...(hit.matchCount === undefined ? {} : { matchCount: hit.matchCount }),
            },
          }
        },
      })
    } catch (error: unknown) {
      signal.throwIfAborted()
      if (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_ABORTED') {
        throw new RemoteError('gateway/cancelled', 'session search was aborted', {})
      }
      throw new RemoteError('gateway/internal', `session search failed: ${String(error)}`, {})
    }
  }

  /**
   * Search current message content inside one Session without activating an Agent,
   * returning up to `limit` relevance-ranked matches ordered chronologically by ascending `seq`.
   * @param request - target Session, query text, optional ranking mode, and optional result bound.
   * @param signal - cancellation for index reconciliation and query execution.
   * @returns bounded chronological event search hits for the Session.
   */
  async searchEvents(request: SessionSearchEventsRequest, signal: AbortSignal): Promise<SessionSearchEventsValue> {
    if (request.sessionId.trim().length === 0 || request.sessionId.includes('\0')) {
      throw new RemoteError('gateway/bad-request', 'session search sessionId must not be empty or contain NUL', {})
    }
    const normalizedQuery = normalizeSearchQuery(request.query)
    const mode: SessionSearchEventsMode = request.mode ?? 'hybrid'
    const targetLimit = normalizeEventSearchLimit(request.limit)
    signal.throwIfAborted()
    const provider = requireSessionQuery(this.ctx)
    try {
      const page = await paginateAuthorizedSearch({
        label: 'session event search provider',
        targetLimit,
        signal,
        fetchPage: (limit, cursor) => provider.searchEvents({
          sessionId: request.sessionId,
          query: normalizedQuery,
          mode,
          filters: MESSAGE_SEARCH_FILTERS,
          limit,
          ...(cursor === undefined ? {} : { cursor }),
        }, { signal }),
        acceptHit: (hit): { readonly key: number; readonly item: SessionSearchEventItem } | undefined => {
          if (hit.sessionId !== request.sessionId
            || hit.surface !== 'current'
            || !MESSAGE_TYPES.has(hit.type)) return undefined
          return {
            key: hit.seq,
            item: {
              seq: hit.seq,
              role: messageRoleOf(hit.type),
              time: hit.time,
              snippet: truncateUnicodeCodePoints(hit.snippet, SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS),
            },
          }
        },
      })
      return {
        items: [...page.items].sort((left, right) => left.seq - right.seq),
        hasMore: page.hasMore,
      }
    } catch (error: unknown) {
      signal.throwIfAborted()
      if (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
        throw new RemoteError('session/not-found', `session "${request.sessionId}" not found`, {
          sessionId: request.sessionId,
        })
      }
      if (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_ABORTED') {
        throw new RemoteError('gateway/cancelled', 'session event search was aborted', {})
      }
      throw new RemoteError('gateway/internal', `session event search failed: ${String(error)}`, {})
    }
  }

  private projectionsFor(
    header: SessionHeader,
    session: Session | undefined,
  ): SessionProjectionHints | undefined {
    try {
      // The registry derives the summary key set from its registrations and
      // hands back one stable set until the key table changes; both faces below
      // serve only those keys, so a list row cannot carry a unit that declares
      // itself summary-excluded.
      const keys = this.ctx.sessionProjections.summaryKeys()
      if (session !== undefined) {
        // The live registry computes the block for this Session: its watermark
        // shares the sequence space of the Session's baselines and frames.
        return hintsOf('sequenced', this.ctx.sessionProjections.snapshot(session, keys))
      }
      // A cold row reads the persisted cache by header alone; the cache serves
      // seeded and unseeded lifecycles alike because a listing never seeds a
      // fold. The watermark is the stored record's own.
      const cache = this.ctx.get('sessionProjectionCache')
      return hintsOf('cached', cache?.cachedSnapshot(header, keys) ?? cache?.cachedPredecessorTitle(header))
    } catch (error) {
      this.ctx.logger.warn(
        `api-session.list: projection column for "${header.id}" failed; serving the row without it: ${String(error)}`,
      )
      return undefined
    }
  }
}

/**
 * Wrap one summary projection block as Session-list hints of the named sequence space.
 * The block is the summary key set's values, not every value the source holds.
 * @param kind - which sequence space the block's watermark belongs to.
 * @param block - the block, or `undefined` when no source served one.
 * @returns the hints, or `undefined` when the block is absent or carries no value.
 */
function hintsOf(
  kind: SessionProjectionHints['kind'],
  block: ProjectionSnapshot | undefined,
): SessionProjectionHints | undefined {
  if (block === undefined || Object.keys(block.values).length === 0) return undefined
  // Listing hints contain every summary wire value the source holds; cached
  // hints remain partial because missing cache rows are never folded here.
  return { kind, asOfSeq: block.asOfSeq, values: block.values }
}

function requireSessionQuery(ctx: Context): NonNullable<Context['sessionQuery']> {
  const provider = ctx.get('sessionQuery')
  if (provider === undefined) {
    throw new RemoteError(
      'gateway/internal',
      'session search is unavailable: this deployment does not mount @deepseek-ai/dsh-session-query',
      {},
    )
  }
  return provider
}

async function paginateAuthorizedSearch<THit, TItem>(options: {
  readonly label: string
  readonly targetLimit: number
  readonly signal: AbortSignal
  readonly fetchPage: (
    limit: number,
    cursor: SessionSearchCursor | undefined,
  ) => Promise<{ readonly items: readonly THit[]; readonly nextCursor?: SessionSearchCursor }>
  readonly acceptHit: (hit: THit) => { readonly key: string | number; readonly item: TItem } | undefined
}): Promise<{ readonly items: TItem[]; readonly hasMore: boolean }> {
  const authorized: TItem[] = []
  const acceptedKeys = new Set<string | number>()
  const seenCursors = new Set<SessionSearchCursor>()
  let cursor: SessionSearchCursor | undefined
  let providerCalls = 0
  let pageLimit = options.targetLimit
  while (authorized.length <= options.targetLimit) {
    options.signal.throwIfAborted()
    if (providerCalls >= SEARCH_PROVIDER_CALL_LIMIT) {
      throw new Error(`${options.label} exceeded the ${SEARCH_PROVIDER_CALL_LIMIT}-call work budget`)
    }
    providerCalls++
    const requestedCursor = cursor
    const requestedLimit = pageLimit
    let page: { readonly items: readonly THit[]; readonly nextCursor?: SessionSearchCursor }
    try {
      page = await options.fetchPage(requestedLimit, requestedCursor)
      options.signal.throwIfAborted()
    } catch (error: unknown) {
      options.signal.throwIfAborted()
      if (requestedCursor === undefined
        && error instanceof SessionQueryError
        && error.code === 'SESSION_QUERY_INVALID_LIMIT'
        && requestedLimit > 1) {
        pageLimit = Math.max(1, Math.floor(requestedLimit / 2))
        continue
      }
      if (requestedCursor !== undefined
        && error instanceof SessionQueryError
        && error.code === 'SESSION_QUERY_STALE_CURSOR') {
        authorized.length = 0
        acceptedKeys.clear()
        seenCursors.clear()
        cursor = undefined
        continue
      }
      throw error
    }
    if (page.items.length > requestedLimit) {
      throw new Error(`${options.label} returned ${String(page.items.length)} items; maximum is ${String(requestedLimit)}`)
    }
    for (const hit of page.items) {
      if (authorized.length > options.targetLimit) continue
      const candidate = options.acceptHit(hit)
      if (candidate === undefined || acceptedKeys.has(candidate.key)) continue
      acceptedKeys.add(candidate.key)
      authorized.push(candidate.item)
    }
    if (page.nextCursor !== undefined) {
      if (seenCursors.has(page.nextCursor)) {
        throw new Error(`${options.label} repeated a continuation cursor`)
      }
      seenCursors.add(page.nextCursor)
    }
    if (authorized.length > options.targetLimit || page.nextCursor === undefined) break
    cursor = page.nextCursor
  }
  return {
    items: authorized.slice(0, options.targetLimit),
    hasMore: authorized.length > options.targetLimit,
  }
}

function normalizeSearchQuery(query: string): string {
  const normalized = query.trim()
  if (normalized.length === 0) {
    throw new RemoteError('gateway/bad-request', 'session search query must not be empty', {})
  }
  if (normalized.length > SESSION_SEARCH_QUERY_MAX_CHARS) {
    throw new RemoteError(
      'gateway/bad-request',
      `session search query must contain at most ${SESSION_SEARCH_QUERY_MAX_CHARS} UTF-16 code units`,
      {},
    )
  }
  if (normalized.includes('\0')) {
    throw new RemoteError('gateway/bad-request', 'session search query must not contain NUL', {})
  }
  return normalized
}

function normalizeEventSearchLimit(limit: number | undefined): number {
  if (limit === undefined) return SESSION_EVENT_SEARCH_RESULT_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SESSION_EVENT_SEARCH_RESULT_LIMIT) {
    throw new RemoteError(
      'gateway/bad-request',
      `session event search limit must be an integer between 1 and ${SESSION_EVENT_SEARCH_RESULT_LIMIT}`,
      {},
    )
  }
  return limit
}

function messageRoleOf(type: string): SessionSearchMessageRole {
  return type === 'user/message' ? 'user' : 'assistant'
}

function updatedAt(header: SessionHeader, metadata: SessionListMetadata | undefined): number {
  return Math.max(header.createdAt, metadata?.lastPromptAt ?? 0)
}

function listFields(header: SessionHeader): {
  readonly parentSessionId?: SessionId
  readonly origin?: 'subagent'
  readonly cwd?: string
} {
  return {
    ...(header.parentSession === undefined ? {} : { parentSessionId: header.parentSession }),
    ...(header.origin === undefined ? {} : { origin: header.origin }),
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
  }
}
