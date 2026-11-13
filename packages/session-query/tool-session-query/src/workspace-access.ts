/**
 * Caller identity, workspace and incognito authorization, and visible lineage projection.
 *
 * @module @deepseek-ai/dsh-tool-session-query/workspace-access
 */

import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import {
  type SessionHeader,
  type SessionId as SessionIdValue,
} from '@deepseek-ai/dsh-session'
import type { TurnBoundaryProjection } from '@deepseek-ai/dsh-agent'
import type {
  SessionLineageNode,
  SessionRecord,
  SessionResultFilter,
} from '@deepseek-ai/dsh-session-query'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { WorkspaceScope } from './index.ts'
import { serviceBoundary } from './service-boundary.ts'

interface SessionPrivacyChecker {
  readonly isSessionIncognito?: (sessionId: SessionIdValue) => boolean
}

interface Caller {
  readonly id: SessionIdValue
  readonly header: SessionHeader
  /** The caller's own-session boundary fold (the `turnBoundary` projection). */
  readonly boundary: TurnBoundaryProjection
  readonly scope: WorkspaceScope
  readonly callerIncognito: boolean
  readonly isIncognito: (sessionId: SessionIdValue) => boolean
}

interface TitleView {
  readonly text: string
  readonly unavailableCode?: string
}

interface CompleteTitleMap extends ReadonlyMap<SessionIdValue, TitleView> {
  get(id: SessionIdValue): TitleView
}

interface AuthorizedDescendant {
  readonly record: SessionRecord
  readonly descendants: Array<AuthorizedDescendant | null>
}

interface DescendantProjectionFrame {
  readonly node: SessionLineageNode
  readonly target: Array<AuthorizedDescendant | null>
  readonly next: DescendantProjectionFrame | undefined
}

interface DescendantVisit {
  readonly node: AuthorizedDescendant | null
  readonly depth: number
  readonly next: DescendantVisit | undefined
}

function isSessionIncognito(ctx: Context, sessionId: SessionIdValue): boolean {
  const candidate: unknown = ctx.get('memory')
  if (typeof candidate !== 'object' || candidate === null) return false
  const checker = candidate as SessionPrivacyChecker
  return typeof checker.isSessionIncognito === 'function' && checker.isSessionIncognito(sessionId)
}

function callerOf(exec: ToolRunContext, ctx: Context, scope: WorkspaceScope): Caller {
  const agent = exec.agent
  if (agent === undefined) {
    throw new HarnessError(
      'session query tools require an agent-bound caller',
      'SESSION_QUERY_TOOL_MISSING_AGENT',
    )
  }
  const id = agent.session.id
  const isIncognito = (sessionId: SessionIdValue): boolean => isSessionIncognito(ctx, sessionId)
  return {
    id,
    header: agent.session.header,
    boundary: ctx.agents.turnBoundaryOf(agent.session),
    scope,
    callerIncognito: isIncognito(id),
    isIncognito,
  }
}

function targetId(args: { readonly session_id?: string }, caller: Caller): SessionIdValue {
  return args.session_id === undefined ? caller.id : brandString<SessionIdValue>(args.session_id)
}

async function authorizeTarget(
  ctx: Context,
  caller: Caller,
  target: SessionIdValue,
  signal: AbortSignal,
): Promise<void> {
  if (target === caller.id) return
  if (caller.callerIncognito || caller.isIncognito(target)) throw serviceBoundary.unauthorizedTarget()
  const filters: SessionResultFilter[] = [{ kind: 'id', values: [target] }]
  if (caller.scope === 'same-workspace') {
    const cwd = caller.header.cwd
    if (cwd === undefined) throw serviceBoundary.unauthorizedTarget()
    filters.push({ kind: 'cwd', values: [cwd] })
  }
  const records = await serviceBoundary.call(ctx, signal, 'target authorization', () =>
    ctx.sessionQuery.filterSessions(filters, signal))
  if (records.length !== 1) throw serviceBoundary.unauthorizedTarget()
}

function recordAuthorized(record: SessionRecord, caller: Caller): boolean {
  return headerAuthorized(record.header, caller)
}

function headerAuthorized(header: SessionHeader, caller: Caller): boolean {
  if (header.id === caller.id) {
    return caller.scope === 'cross-workspace' || header.cwd === caller.header.cwd
  }
  if (caller.callerIncognito || caller.isIncognito(header.id)) return false
  if (caller.scope === 'cross-workspace') return true
  return caller.header.cwd !== undefined && header.cwd === caller.header.cwd
}

function assertObservedTargetAuthorized(
  caller: Caller,
  target: SessionIdValue,
  observed: SessionHeader,
): void {
  if (observed.id !== target || !headerAuthorized(observed, caller)) {
    throw serviceBoundary.unauthorizedTarget()
  }
}

async function authorizeSessionIds(
  ctx: Context,
  caller: Caller,
  ids: readonly SessionIdValue[],
  sameWorkspaceCwd: string | undefined,
  signal: AbortSignal,
): Promise<ReadonlySet<SessionIdValue>> {
  const unique = [...new Set(ids)]
  const authorized = new Set<SessionIdValue>()
  if (unique.includes(caller.id)) authorized.add(caller.id)
  const other = unique.filter(id => id !== caller.id && !caller.isIncognito(id))
  if (other.length === 0) return authorized
  const filters: SessionResultFilter[] = [{ kind: 'id', values: other }]
  if (sameWorkspaceCwd !== undefined) {
    filters.push({ kind: 'cwd', values: [sameWorkspaceCwd] })
  }
  const records = await serviceBoundary.call(ctx, signal, 'session-id authorization', () =>
    ctx.sessionQuery.filterSessions(filters, signal))
  const requested = new Set(other)
  for (const record of records) {
    if (requested.has(record.header.id) && recordAuthorized(record, caller)) {
      authorized.add(record.header.id)
    }
  }
  return authorized
}

async function readTitles(
  ctx: Context,
  caller: Caller,
  ids: readonly SessionIdValue[],
  signal: AbortSignal,
): Promise<CompleteTitleMap> {
  const result = new Map<SessionIdValue, TitleView>()
  const observations = await serviceBoundary.call(ctx, signal, 'title observation', () =>
    ctx.sessionQuery.readTitleSnapshots(ids, signal))
  for (const observation of observations) {
    if (observation.status === 'rejected') {
      result.set(observation.sessionId, unavailableTitle(ctx, observation.reason))
      continue
    }
    assertObservedTargetAuthorized(caller, observation.sessionId, observation.value.session)
    result.set(observation.sessionId, { text: observation.value.title?.title ?? 'untitled' })
  }
  return result as CompleteTitleMap
}

async function readTitle(
  ctx: Context,
  caller: Caller,
  id: SessionIdValue,
  signal: AbortSignal,
): Promise<TitleView> {
  return (await readTitles(ctx, caller, [id], signal)).get(id)
}

function unavailableTitle(
  ctx: Context,
  error: unknown,
): TitleView {
  const sanitized = serviceBoundary.sanitizeError(ctx, 'title observation item', error)
  if (sanitized.code === 'SESSION_QUERY_TOOL_UNAUTHORIZED') throw sanitized
  return { text: 'untitled', unavailableCode: sanitized.code }
}

function authorizeDescendants(
  nodes: readonly SessionLineageNode[],
  caller: Caller,
): Array<AuthorizedDescendant | null> {
  const result: Array<AuthorizedDescendant | null> = []
  let pending: DescendantProjectionFrame | undefined
  for (const node of [...nodes].reverse()) {
    pending = { node, target: result, next: pending }
  }
  while (pending !== undefined) {
    const current = pending
    pending = current.next
    if (!recordAuthorized(current.node.session, caller)) {
      current.target.push(null)
      continue
    }
    const projected: AuthorizedDescendant = {
      record: current.node.session,
      descendants: [],
    }
    current.target.push(projected)
    for (const child of [...current.node.descendants].reverse()) {
      pending = {
        node: child,
        target: projected.descendants,
        next: pending,
      }
    }
  }
  return result
}

function * visitDescendants(
  nodes: readonly (AuthorizedDescendant | null)[],
): Generator<DescendantVisit> {
  let pending: DescendantVisit | undefined
  for (const node of [...nodes].reverse()) {
    pending = { node, depth: 0, next: pending }
  }
  while (pending !== undefined) {
    const current = pending
    pending = current.next
    yield current
    if (current.node === null) continue
    for (const child of [...current.node.descendants].reverse()) {
      pending = {
        node: child,
        depth: current.depth + 1,
        next: pending,
      }
    }
  }
}

function descendantIds(nodes: readonly (AuthorizedDescendant | null)[]): SessionIdValue[] {
  const ids: SessionIdValue[] = []
  for (const { node } of visitDescendants(nodes)) {
    if (node !== null) ids.push(node.record.header.id)
  }
  return ids
}

function titleText(view: TitleView): string {
  return view.unavailableCode === undefined
    ? view.text
    : `${view.text} (title unavailable: ${view.unavailableCode})`
}

/** Workspace- and privacy-scoped caller authorization, title access, and lineage projection. */
export const workspaceAccess = {
  callerOf,
  targetId,
  authorizeTarget,
  recordAuthorized,
  assertObservedTargetAuthorized,
  authorizeSessionIds,
  readTitles,
  readTitle,
  authorizeDescendants,
  visitDescendants,
  descendantIds,
  titleText,
}
