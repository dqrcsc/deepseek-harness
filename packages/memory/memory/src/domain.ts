/**
 * Validation rules, secret-redaction guards, branded constructors, and ordering helpers for persistent memory.
 * @module @deepseek-ai/dsh-memory/domain
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import type {
  MemoryCategory,
  MemoryId as MemoryIdType,
  MemoryInputErrorCode,
  MemoryPreferences,
  MemoryRecord,
  MemoryScope,
} from './types.ts'

/** Default maximum number of active + paused entries retained in the Host memory store. */
export const DEFAULT_MAX_ENTRIES = 500

/** Default maximum UTF-8 byte length of a single memory entry's `content`. */
export const DEFAULT_MAX_ENTRY_BYTES = 1_024

/** Default maximum number of memories injected into a single agent context snapshot. */
export const DEFAULT_MAX_INJECT_ENTRIES = 25

/** Default maximum UTF-8 byte length of a rendered `<user_memory>` context block. */
export const DEFAULT_MAX_INJECT_BYTES = 8_192

/** Initial Host-wide memory preferences before any explicit user change. */
export const DEFAULT_MEMORY_PREFERENCES: MemoryPreferences = Object.freeze({
  autoExtractEnabled: true,
  autoInjectEnabled: true,
  incognitoIsolatesRead: false,
})

/** Valid semantic memory categories. */
export const MEMORY_CATEGORIES: ReadonlySet<MemoryCategory> = new Set<MemoryCategory>([
  'profile',
  'preference',
  'workflow',
  'fact',
  'constraint',
])

const CATEGORY_ORDER: Readonly<Record<MemoryCategory, number>> = {
  profile: 0,
  constraint: 1,
  preference: 2,
  workflow: 3,
  fact: 4,
}

/** High-confidence credential patterns that must never be persisted as user memories. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{24,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/,
  /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{16,}\b/,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|private[_-]?key)\s*[:=]\s*['"]?[^\s'"]{8,}/i,
]

/** Validation or capacity failure raised before mutating persistent memory storage. */
export class MemoryInputError extends HarnessError {
  /** Narrow input failure discriminator forwarded to Remote and tool consumers. */
  readonly reason: MemoryInputErrorCode

  /**
   * @param reason - narrow input validation discriminator.
   * @param message - actionable diagnostic message.
   * @param options - optional underlying cause.
   */
  constructor(reason: MemoryInputErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, `MEMORY_${reason.toUpperCase()}`, options)
    this.name = 'MemoryInputError'
    this.reason = reason
  }
}

/**
 * Brand a raw memory identifier string without runtime allocation.
 * @param value - non-empty memory identifier.
 * @returns branded {@link MemoryIdType}.
 */
export function MemoryId(value: string): MemoryIdType {
  return value as MemoryIdType
}

/**
 * Detect whether candidate text contains API keys, private keys, bearer tokens, or inline secrets.
 * @param text - candidate memory text.
 * @returns `true` when any high-confidence secret pattern matches.
 */
export function containsSensitiveSecret(text: string): boolean {
  return SECRET_PATTERNS.some(pattern => pattern.test(text))
}

/**
 * Collapse redundant whitespace, reject empty or secret-bearing text, and enforce UTF-8 byte limits.
 * @param raw - untrusted memory content string.
 * @param maxEntryBytes - configured maximum UTF-8 bytes per entry.
 * @returns normalized non-empty content string.
 */
export function normalizeMemoryContent(raw: string, maxEntryBytes: number): string {
  const collapsed = raw.replaceAll(/\r\n?/g, '\n').trim()
  if (collapsed.length === 0) {
    throw new MemoryInputError('invalid_content', 'Memory content must be a non-empty string.')
  }
  const byteLength = Buffer.byteLength(collapsed, 'utf8')
  if (byteLength > maxEntryBytes) {
    throw new MemoryInputError(
      'invalid_content',
      `Memory content is ${String(byteLength)} UTF-8 bytes, exceeding the ${String(maxEntryBytes)}-byte limit.`,
    )
  }
  if (containsSensitiveSecret(collapsed)) {
    throw new MemoryInputError(
      'sensitive_content',
      'Memory content appears to contain an API key, token, private key, or password and cannot be stored.',
    )
  }
  return collapsed
}

/**
 * Validate a semantic memory category at runtime boundaries.
 * @param category - candidate category string.
 * @returns validated {@link MemoryCategory}.
 */
export function validateMemoryCategory(category: MemoryCategory): MemoryCategory {
  if (!MEMORY_CATEGORIES.has(category)) {
    throw new MemoryInputError('invalid_category', `Unsupported memory category "${category}".`)
  }
  return category
}

/**
 * Canonicalize a workspace directory path by trimming surrounding whitespace and trailing path separators.
 * @param workspacePath - raw workspace directory string.
 * @returns normalized non-empty workspace path.
 */
export function normalizeWorkspacePath(workspacePath: string): string {
  const trimmed = workspacePath.trim()
  if (trimmed.length === 0) {
    throw new MemoryInputError('invalid_scope', 'Workspace memory scope requires a non-empty workspacePath.')
  }
  if (trimmed === '/' || /^[A-Za-z]:[\\/]$/.test(trimmed)) return trimmed
  return trimmed.replace(/[\\/]+$/, '')
}

/**
 * Validate and canonicalize a {@link MemoryScope}.
 * @param scope - candidate scope object.
 * @returns normalized {@link MemoryScope}.
 */
export function normalizeMemoryScope(scope: MemoryScope): MemoryScope {
  switch (scope.kind) {
    case 'global':
      return { kind: 'global' }
    case 'workspace':
      return { kind: 'workspace', workspacePath: normalizeWorkspacePath(scope.workspacePath) }
    default:
      throw new MemoryInputError('invalid_scope', 'Memory scope kind must be "global" or "workspace".')
  }
}

/**
 * Produce a strictly monotonic RFC 3339 millisecond UTC timestamp relative to an existing timestamp.
 * @param previousIso - previous ISO timestamp when updating an existing record.
 * @param nowMs - current wall-clock reading in milliseconds.
 * @returns monotonic ISO timestamp string.
 */
export function monotonicTimestamp(previousIso: string | undefined, nowMs: number): string {
  const floor = previousIso === undefined ? nowMs : Math.max(nowMs, Date.parse(previousIso) + 1)
  return new Date(floor).toISOString()
}

/**
 * Normalize text for duplicate-statement detection within the same scope.
 * @param content - normalized memory statement.
 * @returns lowercase whitespace-collapsed key.
 */
export function deduplicationKey(content: string): string {
  return content.replaceAll(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Check whether two memory scopes refer to the exact same visibility target.
 * @param left - first normalized scope.
 * @param right - second normalized scope.
 * @returns `true` when both are global or both name the same workspace path.
 */
export function sameMemoryScope(left: MemoryScope, right: MemoryScope): boolean {
  if (left.kind === 'global' && right.kind === 'global') return true
  return left.kind === 'workspace' && right.kind === 'workspace' && left.workspacePath === right.workspacePath
}

/**
 * Deterministic catalog display comparator: active before paused before superseded, pinned first, newest updated first.
 * @param left - first memory record.
 * @param right - second memory record.
 * @returns negative when `left` precedes `right`.
 */
export function compareCatalogRecords(left: MemoryRecord, right: MemoryRecord): number {
  const statusRank = (status: MemoryRecord['status']): number =>
    status === 'active' ? 0 : status === 'paused' ? 1 : 2
  const byStatus = statusRank(left.status) - statusRank(right.status)
  if (byStatus !== 0) return byStatus
  if (left.pinned !== right.pinned) return left.pinned ? -1 : 1
  return right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)
}

/**
 * Canonical context-snapshot comparator ensuring identical selected sets hash to the exact same KV-cache digest.
 * @param left - first selected memory record.
 * @param right - second selected memory record.
 * @returns negative when `left` precedes `right`.
 */
export function compareCanonicalContextOrder(left: MemoryRecord, right: MemoryRecord): number {
  if (left.pinned !== right.pinned) return left.pinned ? -1 : 1
  const leftScope = left.scope.kind === 'global' ? 0 : 1
  const rightScope = right.scope.kind === 'global' ? 0 : 1
  if (leftScope !== rightScope) return leftScope - rightScope
  const byCategory = CATEGORY_ORDER[left.category] - CATEGORY_ORDER[right.category]
  if (byCategory !== 0) return byCategory
  return left.id.localeCompare(right.id)
}
