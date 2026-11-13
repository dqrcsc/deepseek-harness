/**
 * Model-facing session-history search, trace, and event read tools.
 *
 * @module @deepseek-ai/dsh-tool-session-query
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SessionSearchMode } from '@deepseek-ai/dsh-session-query'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { toolInput } from './input.ts'
import { operations, type ResolvedSearchPolicy } from './operations.ts'
import { presentation } from './presentation.ts'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'tool-session-query'

/** Capability services required by the model-facing consumer. */
export const inject = ['tools', 'systemPrompt', 'sessionQuery', 'agents']

/** Workspace boundary applied to cross-session search, trace, and read tools. */
export type WorkspaceScope = 'cross-workspace' | 'same-workspace'

/** Default maximum number of authorized search hits returned by one call. */
export const DEFAULT_MAX_SEARCH_RESULTS = 100

/** Default cooperative deadline for either full-text search tool. */
export const DEFAULT_SEARCH_TIMEOUT_MS = 30_000

const DEFAULT_WORKSPACE_SCOPE: WorkspaceScope = 'cross-workspace'
const DEFAULT_SEARCH_MODE: SessionSearchMode = 'hybrid'

/** Deployment-owned search count, timeout, workspace scope, and search mode bounds. */
export interface Config {
  /** Maximum authorized hits returned by one search call. Defaults to 100. */
  maxSearchResults?: number
  /** Cooperative full-text search deadline in milliseconds. Defaults to 30000. */
  searchTimeoutMs?: number
  /** Cross-session workspace boundary (`cross-workspace` or `same-workspace`). Defaults to `cross-workspace`. */
  workspaceScope?: WorkspaceScope
  /** Query ranking mode (`phrase`, `lexical`, or `hybrid`). Defaults to `hybrid`. */
  searchMode?: SessionSearchMode
}

/** Schemastery config for Loader defaults and generated configuration docs. */
export const Config: z<Config> = z.object({
  maxSearchResults: z.number().step(1).min(1).default(DEFAULT_MAX_SEARCH_RESULTS),
  searchTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_SEARCH_TIMEOUT_MS),
  workspaceScope: z.union([z.const('cross-workspace'), z.const('same-workspace')]).default(DEFAULT_WORKSPACE_SCOPE),
  searchMode: z.union([z.const('phrase'), z.const('lexical'), z.const('hybrid')]).default(DEFAULT_SEARCH_MODE),
})

interface ResolvedConfig extends ResolvedSearchPolicy {
  readonly searchTimeoutMs: number
}

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

const CROSS_WORKSPACE_PROMPT_TEXT =
  'Use session_search to find relevant work from prior sessions across projects, or session_event_search to search '
  + 'earlier events in one session. Search results are cursor-free and include each session\'s workspace. Follow a '
  + 'useful hit with session_trace, session_event_trace, or session_event_read when you need lineage, relationships, '
  + 'or exact data.'

const SAME_WORKSPACE_PROMPT_TEXT =
  'Use session_search to find relevant work from prior sessions, or session_event_search to search earlier '
  + 'events in one session. Search results are cursor-free and workspace-scoped. Follow a useful hit with '
  + 'session_trace, session_event_trace, or session_event_read when you need lineage, relationships, or exact data.'

/**
 * Register all five tools and their shared model guidance.
 * @param ctx - active Cordis context with tools, systemPrompt, sessionQuery, and agents.
 * @param config - deployment search bounds, workspace scope, and ranking mode.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  ctx.systemPrompt.section({
    name: 'tool:session-query',
    order: ctx.systemPrompt.getSectionOrder('TOOL_SESSION_QUERY'),
    text: resolved.workspaceScope === 'cross-workspace' ? CROSS_WORKSPACE_PROMPT_TEXT : SAME_WORKSPACE_PROMPT_TEXT,
  })

  ctx.tools.register(defineTool({
    name: 'session_search',
    description: resolved.workspaceScope === 'cross-workspace'
      ? 'Search prior sessions across workspaces and return the strongest matching event from each session.'
      : 'Search prior sessions in the caller workspace and return the strongest matching event from each session.',
    parameters: toolInput.sessionSearchParameters,
    output: TEXT_OUTPUT,
    timeoutMs: resolved.searchTimeoutMs,
    execute: (args, exec) => operations.executeSessionSearch(ctx, args, exec, resolved),
    presentCall: presentation.presentSessionSearchCall,
  }))

  ctx.tools.register(defineTool({
    name: 'session_event_search',
    description: 'Search prior events in one authorized session; the current session excludes the step performing this call.',
    parameters: toolInput.eventSearchParameters,
    output: TEXT_OUTPUT,
    timeoutMs: resolved.searchTimeoutMs,
    execute: (args, exec) => operations.executeEventSearch(ctx, args, exec, resolved),
    presentCall: presentation.presentEventSearchCall,
  }))

  ctx.tools.register(defineTool({
    name: 'session_trace',
    description: 'Read the authorized session lineage around one session, including complete visible ancestor and descendant relationships.',
    parameters: toolInput.targetSessionParameter,
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: (args, exec) => operations.executeSessionTrace(ctx, args, exec, resolved.workspaceScope),
    presentCall: presentation.presentSessionTraceCall,
  }))

  ctx.tools.register(defineTool({
    name: 'session_event_trace',
    description: 'Read every direct replacement and relationship to a cited source event for one event in an authorized session.',
    parameters: {
      ...toolInput.targetSessionParameter,
      seq: { type: 'integer', required: true, description: 'Target event sequence number.' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: (args, exec) => operations.executeEventTrace(ctx, args, exec, resolved.workspaceScope),
    presentCall: args => presentation.presentEventTargetCall('Trace event', args),
  }))

  ctx.tools.register(defineTool({
    name: 'session_event_read',
    description: 'Read one full unabridged event and optional neighboring raw-event summaries from an authorized session.',
    parameters: {
      ...toolInput.targetSessionParameter,
      seq: { type: 'integer', required: true, description: 'Target event sequence number.' },
      before: { type: 'integer', description: 'Number of preceding raw events to summarize. Omit for none.' },
      after: { type: 'integer', description: 'Number of following raw events to summarize. Omit for none.' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: (args, exec) => operations.executeEventRead(ctx, args, exec, resolved.workspaceScope),
    presentCall: args => presentation.presentEventTargetCall('Read event', args),
  }))
}

function resolveConfig(config: Config): ResolvedConfig {
  const maxSearchResults = config.maxSearchResults ?? DEFAULT_MAX_SEARCH_RESULTS
  const searchTimeoutMs = config.searchTimeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS
  const workspaceScope: unknown = config.workspaceScope ?? DEFAULT_WORKSPACE_SCOPE
  const searchMode: unknown = config.searchMode ?? DEFAULT_SEARCH_MODE
  if (!Number.isSafeInteger(maxSearchResults) || maxSearchResults < 1) {
    throw new TypeError('tool-session-query: maxSearchResults must be a positive safe integer')
  }
  if (!Number.isInteger(searchTimeoutMs) || searchTimeoutMs < 1 || searchTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new TypeError(
      `tool-session-query: searchTimeoutMs must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  if (workspaceScope !== 'cross-workspace' && workspaceScope !== 'same-workspace') {
    throw new TypeError('tool-session-query: workspaceScope must be "cross-workspace" or "same-workspace"')
  }
  if (searchMode !== 'phrase' && searchMode !== 'lexical' && searchMode !== 'hybrid') {
    throw new TypeError('tool-session-query: searchMode must be "phrase", "lexical", or "hybrid"')
  }
  return { maxSearchResults, searchTimeoutMs, workspaceScope, searchMode }
}
