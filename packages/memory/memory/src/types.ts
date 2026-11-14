/**
 * Durable, Remote, and context-selection value types for Host-wide persistent memory.
 * @module @deepseek-ai/dsh-memory/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ContextSnapshotSection } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-typert-protocol'

/** Globally unique persistent memory entry identifier. */
export type MemoryId = Branded<'MemoryId'>

/** Semantic classification of a stored memory item. */
export type MemoryCategory = 'profile' | 'preference' | 'workflow' | 'fact' | 'constraint'

/** Visibility scope of a stored memory item. */
export type MemoryScope =
  | { readonly kind: 'global' }
  | { readonly kind: 'workspace'; readonly workspacePath: string }

/** Creation origin recorded with a stored memory item. */
export type MemorySource =
  | { readonly kind: 'user' }
  | { readonly kind: 'tool'; readonly sessionId?: SessionId }
  | { readonly kind: 'auto'; readonly sessionId: SessionId }

/** Lifecycle status of a stored memory item. */
export type MemoryStatus = 'active' | 'paused' | 'superseded'

/** Machine-readable validation error discriminator for memory operations. */
export type MemoryInputErrorCode =
  | 'invalid_content'
  | 'invalid_scope'
  | 'invalid_category'
  | 'empty_patch'
  | 'sensitive_content'
  | 'capacity_exceeded'

/** Authoritative stored memory record. */
export interface MemoryRecord {
  /** Globally unique memory identifier. */
  readonly id: MemoryId
  /** Trimmed single-concept statement. */
  readonly content: string
  /** Semantic category used for grouping and presentation. */
  readonly category: MemoryCategory
  /** Global or workspace-pinned scope. */
  readonly scope: MemoryScope
  /** Creation origin for user transparency and source-session navigation. */
  readonly source: MemorySource
  /** Current lifecycle status (`active`, `paused`, or `superseded`). */
  readonly status: MemoryStatus
  /** Whether the user pinned this memory for priority context injection. */
  readonly pinned: boolean
  /** RFC 3339 millisecond UTC creation timestamp. */
  readonly createdAt: string
  /** RFC 3339 millisecond UTC latest update timestamp. */
  readonly updatedAt: string
  /** Replacement memory identifier when `status` is `'superseded'`. */
  readonly supersededBy?: MemoryId
}

/** Host-wide user preferences controlling automatic memory extraction and context injection. */
export interface MemoryPreferences {
  /** Whether completed turns automatically extract durable memories in the background. */
  readonly autoExtractEnabled: boolean
  /** Whether active memories are automatically injected into eligible agent steps. */
  readonly autoInjectEnabled: boolean
  /** Whether incognito sessions also suppress read-only injection of existing memories. */
  readonly incognitoIsolatesRead: boolean
}

/** Partial update applied to {@link MemoryPreferences}. */
export interface MemoryPreferencesPatch {
  /** Updated automatic extraction toggle. */
  readonly autoExtractEnabled?: boolean
  /** Updated automatic context-injection toggle. */
  readonly autoInjectEnabled?: boolean
  /** Updated incognito read-isolation toggle. */
  readonly incognitoIsolatesRead?: boolean
}

/** Per-session privacy policy stored in the Host memory domain. */
export interface SessionMemoryPolicy {
  /** Target session identifier. */
  readonly sessionId: SessionId
  /** True when the session suppresses automatic memory extraction and cross-session recall. */
  readonly incognito: boolean
  /** RFC 3339 millisecond UTC update timestamp, or empty string before the first explicit write. */
  readonly updatedAt: string
}

/** Filter parameters for reading the Host memory catalog. */
export interface MemoryCatalogRequest {
  /** Optional workspace path used when `scopeKind` is `'workspace'` or `'applicable'`. */
  readonly workspacePath?: string
  /** Scope filter (`'all'` by default; `'applicable'` returns global plus `workspacePath` matches). */
  readonly scopeKind?: 'all' | 'global' | 'workspace' | 'applicable'
  /** Optional category filter. */
  readonly category?: MemoryCategory
  /** Optional case-insensitive substring or token query. */
  readonly query?: string
  /** Whether superseded entries are included; defaults to `false`. */
  readonly includeSuperseded?: boolean
}

/** Catalog snapshot combining matching memory items with current preferences. */
export interface MemoryCatalogResult {
  /** Matching memory entries in deterministic display order. */
  readonly items: readonly MemoryRecord[]
  /** Current Host-wide memory preferences. */
  readonly preferences: MemoryPreferences
}

/** Parameters for creating a persistent memory item. */
export interface MemoryCreateRequest {
  /** Atomic memory statement to store. */
  readonly content: string
  /** Semantic category. */
  readonly category: MemoryCategory
  /** Global or workspace scope. */
  readonly scope: MemoryScope
  /** Optional initial pin state; defaults to `false`. */
  readonly pinned?: boolean
  /** Creation origin; defaults to `{ kind: 'user' }` on Remote calls. */
  readonly source?: MemorySource
}

/** Atomic mutable fields of an existing memory item. */
export interface MemoryUpdatePatch {
  /** Revised memory text. */
  readonly content?: string
  /** Revised semantic category. */
  readonly category?: MemoryCategory
  /** Revised global or workspace scope. */
  readonly scope?: MemoryScope
  /** Revised pin state. */
  readonly pinned?: boolean
  /** Revised active or paused state. */
  readonly status?: 'active' | 'paused'
}

/** Compare-and-update request for an existing memory item. */
export interface MemoryUpdateRequest {
  /** Target memory identifier. */
  readonly id: MemoryId
  /** Fields to revise; at least one field is required. */
  readonly patch: MemoryUpdatePatch
  /** Optional optimistic-concurrency timestamp guard. */
  readonly expectedUpdatedAt?: string
}

/** Non-mutating miss or concurrency refusal returned by {@link MemoryUpdateResult}. */
export interface MemoryUpdateMiss {
  /** Requested memory identifier. */
  readonly id: MemoryId
  /** Refusal discriminator. */
  readonly code: 'memory_not_found' | 'memory_conflict' | 'memory_superseded'
}

/** Outcome of updating one memory item. */
export type MemoryUpdateResult = MemoryRecord | MemoryUpdateMiss

/** Request to permanently delete one memory item. */
export interface MemoryDeleteRequest {
  /** Target memory identifier. */
  readonly id: MemoryId
}

/** Outcome of deleting one memory item. */
export interface MemoryDeleteResult {
  /** Requested memory identifier. */
  readonly id: MemoryId
  /** True when a stored entry was removed; false when already absent. */
  readonly deleted: boolean
}

/** Request to delete all entries within one scope or across the entire store. */
export interface MemoryClearScopeRequest {
  /** Target scope or `'all'` for full store reset. */
  readonly scope: MemoryScope | { readonly kind: 'all' }
}

/** Count of entries removed by a scope clear operation. */
export interface MemoryClearScopeResult {
  /** Number of deleted entries. */
  readonly deleted: number
}

/** Request to replace an outdated memory entry with a newly evolved entry. */
export interface MemorySupersedeRequest {
  /** Existing active or paused entry to mark `'superseded'`. */
  readonly targetId: MemoryId
  /** Replacement statement text. */
  readonly content: string
  /** Replacement semantic category. */
  readonly category: MemoryCategory
  /** Replacement global or workspace scope. */
  readonly scope: MemoryScope
  /** Origin of the replacement entry. */
  readonly source: MemorySource
  /** Optional pin override; defaults to the superseded target's pin state (or false). */
  readonly pinned?: boolean
}

/** Lookup parameters for reading one session's privacy policy. */
export interface SessionMemoryPolicyRequest {
  /** Target session identifier. */
  readonly sessionId: SessionId
}

/** Mutation parameters for setting one session's privacy policy. */
export interface SetSessionMemoryPolicyRequest {
  /** Target session identifier. */
  readonly sessionId: SessionId
  /** Desired incognito state. */
  readonly incognito: boolean
}

/** Compact citation summary recorded in `MemoryContextSource` for turn-tail UI inspection. */
export interface MemoryCitationItem {
  /** Referenced memory identifier. */
  readonly id: MemoryId
  /** Injected memory statement snapshot. */
  readonly content: string
  /** Semantic category at injection time. */
  readonly category: MemoryCategory
  /** Scope at injection time. */
  readonly scope: MemoryScope
  /** Whether the entry was pinned at injection time. */
  readonly pinned: boolean
  /** Origin kind (`'user'`, `'tool'`, or `'auto'`). */
  readonly sourceKind: 'user' | 'tool' | 'auto'
  /** Originating session identifier when created via tool or automatic extraction. */
  readonly sourceSessionId?: SessionId
}

/** Parameters for selecting budget-bounded memories before an agent model step. */
export interface MemoryContextSelectRequest {
  /** Calling session identifier used for incognito policy evaluation. */
  readonly sessionId?: SessionId
  /** Active workspace directory used to include workspace-scoped memories. */
  readonly workspacePath?: string
  /** Latest user prompt text used for lexical and optional dense relevance ranking. */
  readonly queryText?: string
  /** Optional cancellation signal forwarded to dense embedding providers. */
  readonly signal?: AbortSignal
}

/** Deterministic context selection produced for `dsh-memory-context`. */
export interface MemoryContextSelection {
  /** Hex SHA-256 digest of the canonical selected set, or empty string when `items` is empty. */
  readonly digest: string
  /** Rendered `<user_memory>` snapshot text, or empty string when `items` is empty. */
  readonly formattedText: string
  /** Canonical list of cited memories included in `formattedText`. */
  readonly items: readonly MemoryCitationItem[]
}

/** Durable message source recorded on injected `memory-context` snapshot user messages. */
export interface MemoryContextSource {
  /** Producer discriminator in `MessageSourceMap`. */
  readonly kind: 'memory-context'
  /** Snapshot context presentation form. */
  readonly form: 'snapshot'
  /** Named snapshot contribution carrying the assembled `<user_memory>` text. */
  readonly sections: readonly ContextSnapshotSection[]
  /** One-based turn index entered when this snapshot was injected. */
  readonly turn: number
  /** Canonical SHA-256 digest used to skip redundant re-injections and preserve KV cache hits. */
  readonly digest: string
  /** Cited memories rendered in this snapshot for turn-tail UI inspection. */
  readonly items: readonly MemoryCitationItem[]
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Durable `<user_memory>` context snapshot injected by `dsh-memory-context`.
     * Readers preserve the message content without this producer; its projection uses the kind to suppress unchanged snapshots.
     * @persistenceAttribution
     */
    'memory-context': MemoryContextSource
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** A Remote memory request failed input or capacity validation before mutating storage. */
    'memory/input-invalid': { readonly code: MemoryInputErrorCode }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Durable memory entries, preferences, or session privacy policies changed.
     * @mode emit
     */
    'memory/changed'(): void
  }
}
