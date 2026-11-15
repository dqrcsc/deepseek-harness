/**
 * Durable `ctx.storageDomain` schema declarations for the `network` domain (`v1`).
 * @module @deepseek-ai/dsh-network-proxy/storage
 */

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import {
  asNodeId,
  asSubscriptionId,
  DEFAULT_NETWORK_GLOBAL,
  type StoredNetworkGlobal,
  type StoredSubscriptionRecord,
} from './domain.ts'
import type { CapabilityRoutingOverrides, SubscriptionUserInfo, VpnSubscriptionId } from './types.ts'

const instantSchema = z.iso.datetime({ precision: 3 })
const subscriptionIdSchema = z.string().min(1).transform(asSubscriptionId)
const nodeIdSchema = z.string().min(1).transform(asNodeId)
const routeOverrideSchema = z.enum(['auto', 'direct', 'proxy'])

const capabilityOverridesSchema: z.ZodType<CapabilityRoutingOverrides> = z.object({
  web: routeOverrideSchema.exactOptional(),
  mcp: routeOverrideSchema.exactOptional(),
  plugin: routeOverrideSchema.exactOptional(),
  embedding: routeOverrideSchema.exactOptional(),
}).strict()

const subscriptionUserInfoSchema: z.ZodType<SubscriptionUserInfo> = z.object({
  uploadBytes: z.number().nonnegative().exactOptional(),
  downloadBytes: z.number().nonnegative().exactOptional(),
  totalBytes: z.number().nonnegative().exactOptional(),
  expireUnixSeconds: z.number().nonnegative().exactOptional(),
}).strict()

/** Zod validation schema for stored {@link StoredNetworkGlobal}. */
export const networkGlobalSchema: z.ZodType<StoredNetworkGlobal> = z.object({
  mode: z.enum(['direct', 'smart', 'global']),
  preferRegion: z.string(),
  maxPreferredLatencyMs: z.number().int().min(50).max(60_000),
  proxySubprocesses: z.boolean(),
  proxyBrowserGuests: z.boolean(),
  providerOverrides: z.record(z.string(), routeOverrideSchema),
  capabilityOverrides: capabilityOverridesSchema,
  customRules: z.array(z.string()),
  pinnedNodeId: z.union([nodeIdSchema, z.null()]),
}).strict()

/** Zod validation schema for stored {@link StoredSubscriptionRecord} rows. */
export const storedSubscriptionSchema: z.ZodType<StoredSubscriptionRecord> = z.object({
  id: subscriptionIdSchema,
  name: z.string().min(1),
  maskedUrl: z.string().min(1),
  urlDigest: z.string().length(64),
  enabled: z.boolean(),
  autoRefreshMinutes: z.number().int().min(0).max(10_080),
  nodeCount: z.number().int().min(0),
  lastUpdatedAt: z.union([instantSchema, z.null()]),
  userInfo: subscriptionUserInfoSchema.exactOptional(),
  lastError: z.string().exactOptional(),
  envSource: z.enum(['env', 'dsh-env', 'user-env']).exactOptional(),
  envKey: z.string().min(1).exactOptional(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
}).strict()

/** Authoritative Host-wide `network` storage domain persisted under `$DSH_HOME/storages`. */
export const networkDomain = defineDomain({
  name: 'network',
  version: 1,
  global: {
    schema: networkGlobalSchema,
    initial: DEFAULT_NETWORK_GLOBAL,
  },
  tables: {
    subscriptions: domainTable<VpnSubscriptionId, StoredSubscriptionRecord>(storedSubscriptionSchema),
  },
})
