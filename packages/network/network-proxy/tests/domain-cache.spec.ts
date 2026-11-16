import { createCipheriv, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ParsedSubscription } from '@deepseek-ai/dsh-vpn-tunnel'
import { afterEach, describe, expect, it } from 'vitest'
import * as clientExports from '../src/client.ts'
import { EncryptedSubscriptionCache } from '../src/cache.ts'
import { runConnectivityDiagnostics } from '../src/diagnostics.ts'
import {
  DEFAULT_NETWORK_GLOBAL,
  MAX_AUTO_REFRESH_MINUTES,
  MAX_SUBSCRIPTION_NAME_LENGTH,
  NetworkProxyInputError,
  SMART_DOMESTIC_BASELINE_RULES,
  asNodeId,
  asSubscriptionId,
  cacheEncryptionCredentialKey,
  computeUrlDigest,
  generateSubscriptionId,
  normalizeCapabilityOverrides,
  normalizeProviderOverrides,
  normalizeSubscriptionName,
  normalizeSubscriptionUrl,
  parseCustomRules,
  subscriptionCredentialKey,
  toRoutingSettings,
  toSubscriptionSummary,
  validateLatencyCeiling,
  validateRefreshMinutes,
} from '../src/domain.ts'
import { networkDomain, networkGlobalSchema, storedSubscriptionSchema } from '../src/storage.ts'

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true })
    }
  }
})

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-network-cache-'))
  tempDirs.push(dir)
  return dir
}

describe('network-proxy domain & storage schemas', () => {
  it('validates names, URLs, refresh intervals, latency ceilings, overrides, custom rules, and credential keys', () => {
    expect(clientExports).toBeDefined()
    expect(SMART_DOMESTIC_BASELINE_RULES.length).toBeGreaterThanOrEqual(6)

    const inputErr = new NetworkProxyInputError('invalid_url', 'bad url', { cause: new Error('inner') })
    expect(inputErr.reason).toBe('invalid_url')
    expect(inputErr.code).toBe('NETWORK_PROXY_INVALID_URL')

    const generated = generateSubscriptionId()
    expect(generated).toMatch(/^sub-[0-9a-f]{12}$/u)
    expect(subscriptionCredentialKey(generated)).toContain('network-proxy/sub-')
    expect(subscriptionCredentialKey(asSubscriptionId('123_weird!'))).toBe('network-proxy/s-123-weird-')
    expect(cacheEncryptionCredentialKey()).toBe('network-proxy/cache-key')

    expect(normalizeSubscriptionName('  Main Airport  ')).toBe('Main Airport')
    expect(() => normalizeSubscriptionName('   ')).toThrow(NetworkProxyInputError)
    expect(() => normalizeSubscriptionName('x'.repeat(MAX_SUBSCRIPTION_NAME_LENGTH + 1))).toThrow(NetworkProxyInputError)

    expect(normalizeSubscriptionUrl('  https://sub.example.test/api/v1?token=abc  '))
      .toBe('https://sub.example.test/api/v1?token=abc')
    expect(normalizeSubscriptionUrl('http://127.0.0.1:8080/sub')).toBe('http://127.0.0.1:8080/sub')
    expect(() => normalizeSubscriptionUrl('not a url')).toThrow(NetworkProxyInputError)
    expect(() => normalizeSubscriptionUrl('socks5://127.0.0.1:1080')).toThrow(NetworkProxyInputError)
    expect(() => normalizeSubscriptionUrl('http://')).toThrow(NetworkProxyInputError)

    expect(computeUrlDigest('https://sub.example.test/a')).toHaveLength(64)

    expect(validateRefreshMinutes(0)).toBe(0)
    expect(validateRefreshMinutes(MAX_AUTO_REFRESH_MINUTES)).toBe(MAX_AUTO_REFRESH_MINUTES)
    expect(() => validateRefreshMinutes(-1)).toThrow(NetworkProxyInputError)
    expect(() => validateRefreshMinutes(1.5)).toThrow(NetworkProxyInputError)
    expect(() => validateRefreshMinutes(MAX_AUTO_REFRESH_MINUTES + 1)).toThrow(NetworkProxyInputError)

    expect(validateLatencyCeiling(50)).toBe(50)
    expect(validateLatencyCeiling(60_000)).toBe(60_000)
    expect(() => validateLatencyCeiling(49)).toThrow(NetworkProxyInputError)
    expect(() => validateLatencyCeiling(60_001)).toThrow(NetworkProxyInputError)
    expect(() => validateLatencyCeiling(120.5)).toThrow(NetworkProxyInputError)

    expect(normalizeProviderOverrides({
      '  openai  ': 'proxy',
      'deepseek-official': 'direct',
      anthropic: 'auto',
      '   ': 'proxy',
    })).toEqual({
      openai: 'proxy',
      'deepseek-official': 'direct',
    })

    expect(normalizeCapabilityOverrides({
      web: 'proxy',
      mcp: 'direct',
      plugin: 'auto',
      embedding: 'proxy',
    })).toEqual({
      web: 'proxy',
      mcp: 'direct',
      embedding: 'proxy',
    })
    expect(normalizeCapabilityOverrides({
      web: 'auto',
      mcp: 'auto',
      plugin: 'direct',
      embedding: 'auto',
    })).toEqual({
      plugin: 'direct',
    })

    const parsedRules = parseCustomRules(
      ['', '  # comment  ', '  DOMAIN-SUFFIX,openai.com,PROXY  '],
      line => line.startsWith('DOMAIN-SUFFIX,')
        ? { kind: 'DOMAIN-SUFFIX', pattern: 'openai.com', action: 'PROXY' }
        : null,
    )
    expect(parsedRules.normalizedLines).toEqual(['DOMAIN-SUFFIX,openai.com,PROXY'])
    expect(parsedRules.rules).toHaveLength(1)
    expect(() => parseCustomRules(['INVALID_RULE'], () => null)).toThrow(NetworkProxyInputError)

    const now = '2026-11-15T12:00:00.000Z'
    const fullRecord = storedSubscriptionSchema.parse({
      id: 'sub-aabbccddeeff',
      name: 'Primary',
      maskedUrl: 'https://sub.example.test/***',
      urlDigest: 'a'.repeat(64),
      enabled: true,
      autoRefreshMinutes: 360,
      nodeCount: 12,
      lastUpdatedAt: now,
      userInfo: { uploadBytes: 10, downloadBytes: 20, totalBytes: 100, expireUnixSeconds: 1_900_000_000 },
      lastError: 'timeout',
      envSource: 'user-env',
      envKey: 'SUB_VPN_1',
      createdAt: now,
      updatedAt: now,
    })
    const summary = toSubscriptionSummary(fullRecord)
    expect(summary.userInfo?.totalBytes).toBe(100)
    expect(summary.lastError).toBe('timeout')
    expect(summary.envSource).toBe('user-env')
    expect(summary.envKey).toBe('SUB_VPN_1')

    const minimalSummary = toSubscriptionSummary({
      id: asSubscriptionId('sub-000000000001'),
      name: 'Minimal',
      maskedUrl: 'https://sub.example.test/***',
      urlDigest: 'b'.repeat(64),
      enabled: false,
      autoRefreshMinutes: 0,
      nodeCount: 0,
      lastUpdatedAt: null,
      createdAt: now,
      updatedAt: now,
    })
    expect(minimalSummary.userInfo).toBeUndefined()
    expect(minimalSummary.lastError).toBeUndefined()

    const globalParsed = networkGlobalSchema.parse({
      ...DEFAULT_NETWORK_GLOBAL,
      pinnedNodeId: asNodeId('node-123456'),
    })
    expect(toRoutingSettings(globalParsed).preferRegion).toBe('新加坡|日本|美国, 台湾')
    expect(networkDomain.name).toBe('network')
  })
})

describe('EncryptedSubscriptionCache', () => {
  it('encrypts with AES-256-GCM 0600 permissions, binds subscriptionId AAD, and cleans up corrupted files', async () => {
    const dir = await makeTempDir()
    const key = randomBytes(32)
    const cache = new EncryptedSubscriptionCache({
      cacheDir: dir,
      resolveSecretKey: async () => key,
    })
    const subA = asSubscriptionId('sub-cache-alpha')
    const subB = asSubscriptionId('sub-cache-beta')

    // Missing file returns null without throwing.
    expect(await cache.read(subA)).toBeNull()

    const payload: ParsedSubscription = {
      nodes: [
        {
          id: asNodeId('node-1'),
          subscriptionId: subA,
          name: 'US-01',
          protocol: 'ss',
          server: 'us.example.test',
          port: 8388,
          cipher: 'aes-128-gcm',
          password: 'secret-password-never-plaintext',
        },
      ],
      rules: [{ kind: 'MATCH', pattern: '', action: 'PROXY' }],
      clockOffsetSeconds: 0,
    }

    await cache.write(subA, payload)
    const encFile = join(dir, 'sub-cache-alpha.enc')
    const rawCiphertext = await readFile(encFile)
    expect(rawCiphertext.toString('utf8')).not.toContain('secret-password-never-plaintext')
    expect(rawCiphertext.toString('utf8')).not.toContain('us.example.test')
    const st = await stat(encFile)
    expect(st.mode & 0o777).toBe(0o600)

    const restored = await cache.read(subA)
    expect(restored).toEqual(payload)

    // Copying subA's ciphertext under subB's filename fails GCM AAD verification and deletes the file.
    const encFileB = join(dir, 'sub-cache-beta.enc')
    await writeFile(encFileB, rawCiphertext)
    expect(await cache.read(subB)).toBeNull()
    await expect(stat(encFileB)).rejects.toThrow()

    // Truncated / bad-header file returns null and deletes residue.
    await writeFile(encFile, Buffer.from('short'))
    expect(await cache.read(subA)).toBeNull()
    await expect(stat(encFile)).rejects.toThrow()

    // Valid AES-GCM envelope carrying non-object / schema-invalid JSON returns null and deletes residue.
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from(subA, 'utf8'))
    const ct = Buffer.concat([cipher.update(Buffer.from('"not-an-object"', 'utf8')), cipher.final()])
    const badSchemaEnvelope = Buffer.concat([Buffer.from('DSHN', 'ascii'), Buffer.from([1]), iv, cipher.getAuthTag(), ct])
    await writeFile(encFile, badSchemaEnvelope)
    expect(await cache.read(subA)).toBeNull()

    const iv2 = randomBytes(12)
    const cipher2 = createCipheriv('aes-256-gcm', key, iv2)
    cipher2.setAAD(Buffer.from(subA, 'utf8'))
    const ct2 = Buffer.concat([cipher2.update(Buffer.from('{"nodes":[],"rules":[]}', 'utf8')), cipher2.final()])
    const missingClockEnvelope = Buffer.concat([Buffer.from('DSHN', 'ascii'), Buffer.from([1]), iv2, cipher2.getAuthTag(), ct2])
    await writeFile(encFile, missingClockEnvelope)
    expect(await cache.read(subA)).toBeNull()

    // Non-ENOENT filesystem error (e.g. EISDIR when cache target is a directory) rethrows.
    const subDirId = asSubscriptionId('sub-is-dir')
    await mkdir(join(dir, 'sub-is-dir.enc'))
    await expect(cache.read(subDirId)).rejects.toThrow()
  })

  it('runs connectivity diagnostics without an external AbortSignal and records nodeName on proxy transport errors', async () => {
    const report = await runConnectivityDiagnostics({
      mode: 'smart',
      selectedNodeName: 'US-01',
      timeoutMs: 1_000,
      targets: [
        {
          id: 'proxied-unreachable',
          label: 'Proxied Unreachable',
          url: 'http://127.0.0.1:1/fail',
          trafficContext: { category: 'web' },
        },
      ],
      evaluateRoute: () => ({ route: 'proxy', nodeName: 'US-01' }),
      redactError: error => `redacted:${error instanceof Error ? error.message : String(error)}`,
    })
    expect(report.targets).toHaveLength(1)
    expect(report.targets[0]?.ok).toBe(false)
    expect(report.targets[0]?.nodeName).toBe('US-01')
    expect(report.targets[0]?.error).toContain('redacted:')
  })
})
