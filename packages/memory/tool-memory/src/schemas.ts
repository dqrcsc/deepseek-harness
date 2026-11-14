/**
 * Parameter schemas, system-prompt guidance, and output formatting for `dsh-tool-memory`.
 * @module @deepseek-ai/dsh-tool-memory/schemas
 */

import type { MemoryCategory, MemoryRecord } from '@deepseek-ai/dsh-memory'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'

/** Fixed system-prompt guidance teaching explicit memory tool discipline. */
export const MEMORY_PROMPT_TEXT = [
  'Use memory_save when the user explicitly asks you to remember, update, or enforce a standing preference, workflow, role fact, or prohibition across future sessions; pass supersedes_id when replacing an outdated memory.',
  'Use memory_delete when the user asks you to forget a stored memory, and memory_list to inspect existing memories before editing or when asked.',
  'Never pass API keys, passwords, tokens, or one-off task details to memory_save.',
].join(' ')

const CATEGORY_VALUES: readonly MemoryCategory[] = ['profile', 'preference', 'workflow', 'fact', 'constraint']

/** Parameters accepted by `memory_save`. */
export const memorySaveParameters = {
  content: {
    type: 'string' as const,
    required: true as const,
    description: 'Single concise, self-contained statement to persist across sessions (never include secrets or credentials).',
  },
  category: {
    type: 'string' as const,
    required: true as const,
    enum: CATEGORY_VALUES,
    description: 'Semantic category: profile, preference, workflow, fact, or constraint.',
  },
  scope: {
    type: 'string' as const,
    enum: ['global', 'workspace'] as const,
    description: 'Visibility scope: "global" (default, shared across projects) or "workspace" (restricted to the current workspace directory).',
  },
  supersedes_id: {
    type: 'string' as const,
    description: 'Optional existing memory id (mem-...) to mark superseded when replacing an outdated preference or fact.',
  },
  pinned: {
    type: 'boolean' as const,
    description: 'Optional flag to pin core rules for priority context injection.',
  },
} as const

/** Parameters accepted by `memory_delete`. */
export const memoryDeleteParameters = {
  id: {
    type: 'string' as const,
    required: true as const,
    description: 'Identifier of the memory item (mem-...) to permanently remove.',
  },
} as const

/** Parameters accepted by `memory_list`. */
export const memoryListParameters = {
  scope: {
    type: 'string' as const,
    enum: ['applicable', 'global', 'workspace', 'all'] as const,
    description: 'Scope filter: "applicable" (default, global plus current workspace), "global", "workspace", or "all".',
  },
  category: {
    type: 'string' as const,
    enum: CATEGORY_VALUES,
    description: 'Optional category filter.',
  },
  query: {
    type: 'string' as const,
    description: 'Optional search terms matched against memory content.',
  },
} as const

/**
 * Format one saved or superseded memory record into plain-text tool output.
 * @param record - committed memory record.
 * @param supersededId - optional superseded target id.
 * @returns plain-text confirmation message.
 */
export function formatSavedMemory(record: MemoryRecord, supersededId?: string): string {
  const scopeLabel = record.scope.kind === 'global' ? 'global' : `workspace:${record.scope.workspacePath}`
  const pinLabel = record.pinned ? ', pinned' : ''
  const prefix = supersededId === undefined
    ? `Saved memory ${record.id}`
    : `Saved memory ${record.id} (superseding ${supersededId})`
  return `${prefix} [${record.category} | ${scopeLabel}${pinLabel}]: ${record.content}`
}

/**
 * Format a memory catalog list into plain-text tool output.
 * @param items - matching memory records.
 * @returns plain-text summary of matching entries.
 */
export function formatMemoryList(items: readonly MemoryRecord[]): string {
  if (items.length === 0) return 'No stored memories matched the filter.'
  const lines = [`Stored memories (${String(items.length)}):`]
  for (const [index, item] of items.entries()) {
    const scopeLabel = item.scope.kind === 'global' ? 'global' : `workspace:${item.scope.workspacePath}`
    const flags = [
      item.category,
      scopeLabel,
      item.status,
      ...(item.pinned ? ['pinned'] : []),
    ].join(' | ')
    lines.push(`${String(index + 1)}. ${item.id} [${flags}] — ${item.content}`)
  }
  return lines.join('\n')
}

/**
 * Pure call-card presenter for `memory_save`.
 * @param args - parsed tool arguments.
 * @returns generic call-card view.
 */
export function presentSaveCall(args: { readonly content: string; readonly supersedes_id?: string }): GenericCallView {
  return {
    card: 'generic',
    kind: 'other',
    title: args.supersedes_id === undefined ? 'Save memory' : 'Update memory',
    rawInput: args.content,
  }
}

/**
 * Pure call-card presenter for `memory_delete`.
 * @param args - parsed tool arguments.
 * @returns generic call-card view.
 */
export function presentDeleteCall(args: { readonly id: string }): GenericCallView {
  return {
    card: 'generic',
    kind: 'other',
    title: 'Delete memory',
    rawInput: args.id,
  }
}

/**
 * Pure call-card presenter for `memory_list`.
 * @param args - parsed tool arguments.
 * @returns generic call-card view.
 */
export function presentListCall(args: { readonly query?: string }): GenericCallView {
  return {
    card: 'generic',
    kind: 'read',
    title: 'List memories',
    ...(args.query === undefined ? {} : { rawInput: args.query }),
  }
}
