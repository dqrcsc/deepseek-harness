import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageDomainPlugin from '@deepseek-ai/dsh-storage-domain'
import * as storageSqlitePlugin from '@deepseek-ai/dsh-storage-sqlite'
import VpnTunnelRuntime from '@deepseek-ai/dsh-vpn-tunnel'
import { afterEach, describe, expect, it } from 'vitest'
import NetworkProxyService from '../src/index.ts'

const USER_ENV_PATH = join(homedir(), '.env')
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()
    if (fn !== undefined) await fn()
  }
})

describe('NetworkProxyService live ~/.env SUB_VPN_* e2e', () => {
  it.skipIf(!existsSync(USER_ENV_PATH))(
    'imports ~/.env subscription, activates smart mode, routes DeepSeek direct and overseas targets via proxy, and leaks zero secrets',
    async () => {
      const rootDir = await mkdtemp(join(tmpdir(), 'dsh-network-live-e2e-'))
      cleanups.push(() => rm(rootDir, { recursive: true, force: true }))

      const ctx = new Context()
      cleanups.push(async () => {
        await ctx.fiber.dispose()
      })
      await ctx.plugin(Storage)
      await ctx.plugin(storageSqlitePlugin, { path: join(rootDir, 'storage.sqlite') })
      await ctx.plugin(storageDomainPlugin, { backend: 'sqlite' })
      await ctx.plugin(LocalCredentialProvider, {
        path: join(rootDir, '.credentials.yaml'),
        dshHome: rootDir,
        watch: false,
      })
      await ctx.plugin(VpnTunnelRuntime)
      await ctx.plugin(NetworkProxyService, {
        dshHome: rootDir,
        userEnvPath: USER_ENV_PATH,
        diagnosticTimeoutMs: 12_000,
      })

      const preStatus = await ctx.networkProxy.status()
      if (preStatus.ambientEnvCandidates.length === 0) {
        return
      }

      const imported = await ctx.networkProxy.importEnvSubscriptions()
      expect(imported.importedCount).toBeGreaterThanOrEqual(1)
      expect(imported.status.nodes.length).toBeGreaterThan(0)
      for (const sub of imported.status.subscriptions) {
        expect(sub.maskedUrl).toMatch(/^https?:\/\/[^/]+\/\*\*\*$/u)
      }

      const smartStatus = await ctx.networkProxy.setMode({ mode: 'smart' })
      expect(smartStatus.mode).toBe('smart')
      expect(smartStatus.gateway?.httpProxyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u)

      const probed = await ctx.networkProxy.probeNodes({ limit: 4 })
      expect(probed.results.length).toBeGreaterThan(0)

      const report = await ctx.networkProxy.runDiagnostics()
      expect(report.mode).toBe('smart')

      const deepseekTarget = report.targets.find(t => t.id === 'deepseek')
      expect(deepseekTarget?.route).toBe('direct')
      expect(deepseekTarget?.ok).toBe(true)

      const overseasTargets = report.targets.filter(t => t.id !== 'deepseek')
      for (const target of overseasTargets) {
        expect(target.route).toBe('proxy')
      }
      const reachableOverseas = overseasTargets.filter(t => t.ok)
      expect(reachableOverseas.length).toBeGreaterThanOrEqual(2)
    },
    45_000,
  )
})
