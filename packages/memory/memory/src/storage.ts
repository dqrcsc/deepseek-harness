/**
 * Durable `ctx.storageDomain` schema declarations for Host-wide memories, preferences, and session policies.
 * @module @deepseek-ai/dsh-memory/storage
 */

import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { DEFAULT_MEMORY_PREFERENCES, MemoryId } from './domain.ts'
import type {
  MemoryId as MemoryIdType,
  MemoryPreferences,
  MemoryRecord,
  SessionMemoryPolicy,
} from './types.ts'

const instantSchema = z.iso.datetime({ precision: 3 })
const memoryIdSchema = z.string().min(1).transform(MemoryId)
const sessionIdSchema = z.string().min(1).transform(SessionId)

const memoryScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('global') }).strict(),
  z.object({ kind: z.literal('workspace'), workspacePath: z.string().min(1) }).strict(),
])

const memorySourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user') }).strict(),
  z.object({ kind: z.literal('tool'), sessionId: sessionIdSchema.exactOptional() }).strict(),
  z.object({ kind: z.literal('auto'), sessionId: sessionIdSchema }).strict(),
])

/** Zod validation schema for stored {@link MemoryPreferences}. */
export const memoryPreferencesSchema: z.ZodType<MemoryPreferences> = z.object({
  autoExtractEnabled: z.boolean(),
  autoInjectEnabled: z.boolean(),
  incognitoIsolatesRead: z.boolean(),
}).strict()

/** Zod validation schema for stored {@link MemoryRecord} rows. */
export const memoryRecordSchema: z.ZodType<MemoryRecord> = z.object({
  id: memoryIdSchema,
  content: z.string().min(1),
  category: z.enum(['profile', 'preference', 'workflow', 'fact', 'constraint']),
  scope: memoryScopeSchema,
  source: memorySourceSchema,
  status: z.enum(['active', 'paused', 'superseded']),
  pinned: z.boolean(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
  supersededBy: memoryIdSchema.exactOptional(),
}).strict()

/** Zod validation schema for stored {@link SessionMemoryPolicy} rows. */
export const sessionMemoryPolicySchema: z.ZodType<SessionMemoryPolicy> = z.object({
  sessionId: sessionIdSchema,
  incognito: z.boolean(),
  updatedAt: instantSchema,
}).strict()

/** Authoritative Host-wide `memory` domain persisted under `$DSH_HOME/storages`. */
export const memoryDomain = defineDomain({
  name: 'memory',
  version: 1,
  global: {
    schema: memoryPreferencesSchema,
    initial: DEFAULT_MEMORY_PREFERENCES,
  },
  tables: {
    entries: domainTable<MemoryIdType, MemoryRecord>(memoryRecordSchema),
    session_policies: domainTable<SessionId, SessionMemoryPolicy>(sessionMemoryPolicySchema),
  },
})
