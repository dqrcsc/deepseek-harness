/**
 * Prompt framing and strict JSON response validation for auxiliary post-turn memory extraction.
 * @module @deepseek-ai/dsh-memory-extractor/parser
 */

import { z } from 'zod'
import type { MemoryCategory, MemoryRecord, MemoryScope } from '@deepseek-ai/dsh-memory'

const MAX_OPERATIONS_PER_EXTRACT = 5
const MAX_EXISTING_MEMORIES_IN_PROMPT = 40

/** Single validated extraction operation emitted by the background extractor model. */
export type ExtractedMemoryOperation =
  | { readonly op: 'NOOP' }
  | {
    readonly op: 'ADD'
    readonly content: string
    readonly category: MemoryCategory
    readonly scope: 'global' | 'workspace'
  }
  | {
    readonly op: 'UPDATE'
    readonly targetId: string
    readonly content: string
    readonly category: MemoryCategory
    readonly scope: 'global' | 'workspace'
  }
  | {
    readonly op: 'SUPERSEDE'
    readonly targetId: string
    readonly content: string
    readonly category: MemoryCategory
    readonly scope: 'global' | 'workspace'
  }

const categorySchema = z.enum(['profile', 'preference', 'workflow', 'fact', 'constraint'])
const scopeKindSchema = z.enum(['global', 'workspace'])

const operationSchema: z.ZodType<ExtractedMemoryOperation> = z.discriminatedUnion('op', [
  z.object({ op: z.literal('NOOP') }).strict(),
  z.object({
    op: z.literal('ADD'),
    content: z.string().min(1),
    category: categorySchema,
    scope: scopeKindSchema,
  }).strict(),
  z.object({
    op: z.literal('UPDATE'),
    targetId: z.string().min(1),
    content: z.string().min(1),
    category: categorySchema,
    scope: scopeKindSchema,
  }).strict(),
  z.object({
    op: z.literal('SUPERSEDE'),
    targetId: z.string().min(1),
    content: z.string().min(1),
    category: categorySchema,
    scope: scopeKindSchema,
  }).strict(),
])

const extractionPayloadSchema = z.object({
  operations: z.array(operationSchema).max(MAX_OPERATIONS_PER_EXTRACT),
}).strict()

/** Fixed system instruction governing background memory extraction and conflict resolution. */
export const EXTRACTION_SYSTEM_PROMPT = [
  'You maintain atomic, durable user and workspace memories across sessions for a general-purpose AI assistant.',
  'Extract ONLY standing facts that remain useful in future sessions: user role/domain ("profile"), communication or deliverable preferences ("preference"), recurring workflows or conventions ("workflow"), persistent background context ("fact"), or standing prohibitions ("constraint").',
  'NEVER extract transient task requests, one-off debugging details, greetings, or sensitive credentials (API keys, passwords, tokens, private keys).',
  'Write each memory in the user\'s primary language as one concise, self-contained sentence.',
  'Choose scope "global" for cross-project user traits and preferences; choose scope "workspace" ONLY when workspaceAvailable is true AND the statement applies specifically to the active workspace.',
  'Reconcile against existingMemories:',
  '- Emit {"operations": []} when no new durable memory is present or existingMemories already capture it.',
  '- Emit {"op": "ADD", "content": "...", "category": "...", "scope": "global"|"workspace"} for a distinct new durable fact.',
  '- Emit {"op": "UPDATE", "targetId": "<id>", "content": "...", "category": "...", "scope": "global"|"workspace"} to refine an existing memory in place.',
  '- Emit {"op": "SUPERSEDE", "targetId": "<id>", "content": "...", "category": "...", "scope": "global"|"workspace"} when the user explicitly reverses or replaces a prior preference.',
  'Respond with a single JSON object {"operations": [...]} and no surrounding prose.',
].join('\n')

/**
 * Truncate UTF-8 text cleanly to a maximum byte budget without splitting surrogate pairs.
 * @param text - input UTF-8 string.
 * @param maxBytes - positive byte ceiling.
 * @returns string whose UTF-8 byte length is at most `maxBytes`.
 */
export function truncateUtf8Bytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let result = ''
  let used = 0
  for (const codePoint of text) {
    const bytes = Buffer.byteLength(codePoint, 'utf8')
    if (used + bytes > maxBytes) break
    result += codePoint
    used += bytes
  }
  return result
}

/**
 * Build bounded JSON input framing recent turn exchanges alongside existing memories.
 * @param exchanges - recent user/assistant exchanges collected in the session.
 * @param existing - active and paused memories applicable to the session.
 * @param workspaceAvailable - whether the session has a workspace path eligible for `"workspace"` scope.
 * @param maxInputBytes - maximum UTF-8 byte length of the returned string.
 * @returns bounded JSON input text ready for the extraction model call.
 */
export function buildExtractionInput(
  exchanges: readonly { readonly user: string; readonly assistant: string }[],
  existing: readonly MemoryRecord[],
  workspaceAvailable: boolean,
  maxInputBytes: number,
): string {
  const existingCompact = existing.slice(0, MAX_EXISTING_MEMORIES_IN_PROMPT).map(item => ({
    id: item.id,
    category: item.category,
    scope: item.scope.kind,
    content: item.content,
  }))
  const wrapperBudget = Math.max(128, Math.floor(maxInputBytes * 0.45))
  const existingJson = truncateUtf8Bytes(JSON.stringify(existingCompact), wrapperBudget)
  const remainingBudget = Math.max(128, maxInputBytes - Buffer.byteLength(existingJson, 'utf8') - 128)
  const perExchangeBudget = Math.max(64, Math.floor(remainingBudget / Math.max(1, exchanges.length)))
  const trimmedExchanges = exchanges.map(item => ({
    user: truncateUtf8Bytes(item.user, Math.max(32, Math.floor(perExchangeBudget * 0.65))),
    assistant: truncateUtf8Bytes(item.assistant, Math.max(32, Math.floor(perExchangeBudget * 0.35))),
  }))
  const full = JSON.stringify({
    workspaceAvailable,
    existingMemoriesJson: existingJson,
    exchanges: trimmedExchanges,
  })
  return truncateUtf8Bytes(full, maxInputBytes)
}

/**
 * Resolve a model-selected scope kind to a concrete {@link MemoryScope}, falling back to `global` when no workspace path exists.
 * @param requested - `"global"` or `"workspace"` from model output.
 * @param workspacePath - session workspace directory, if any.
 * @returns concrete {@link MemoryScope}.
 */
export function resolveExtractedScope(
  requested: 'global' | 'workspace',
  workspacePath: string | undefined,
): MemoryScope {
  const trimmed = workspacePath?.trim()
  if (requested === 'workspace' && trimmed !== undefined && trimmed.length > 0) {
    return { kind: 'workspace', workspacePath: trimmed }
  }
  return { kind: 'global' }
}

/** Actionable non-NOOP extraction operation. */
export type ActionableMemoryOperation = Exclude<ExtractedMemoryOperation, { readonly op: 'NOOP' }>

/**
 * Parse and validate untrusted model text into bounded {@link ActionableMemoryOperation} items.
 * @param rawText - raw text assembled from the extraction model response.
 * @returns validated operations (excluding `NOOP` placeholders).
 * @throws {Error} when the output is not valid JSON matching the extraction schema.
 */
export function parseExtractionResponse(rawText: string): ActionableMemoryOperation[] {
  const trimmed = rawText.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed)
  const candidate = fenced?.[1] ?? trimmed
  const parsed: unknown = JSON.parse(candidate)
  const validated = extractionPayloadSchema.parse(parsed)
  return validated.operations.filter((item): item is ActionableMemoryOperation => item.op !== 'NOOP')
}
