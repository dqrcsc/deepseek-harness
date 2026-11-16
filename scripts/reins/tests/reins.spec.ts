/**
 * Unit and integration tests for the Reins distribution runtime, shims, supervisor, dual-slot upgrader, CLI, and POSIX installer.
 */

import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { createServer as createNetServer, type Server as NetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { c as createTar } from 'tar'
import { afterEach, describe, expect, it } from 'vitest'
import { runReinsCli } from '../cli.ts'
import {
  RotatingLogWriter,
  compareVersions,
  extractWebLaunchUrl,
  normalizeVersionTag,
  readCurrentVersion,
  readDaemonStatus,
  readReinsConfig,
  resolveBrandIdentity,
  resolveReinsPaths,
  resolveReleaseSlotPaths,
  sha256File,
  writeCurrentVersion,
  writeReinsConfig,
  type LatestReleaseManifest,
  type ReleaseManifest,
  type ReleaseTarget,
} from '../shared.ts'
import {
  detectExternalCommandConflict,
  removePosixShellPath,
  renderPosixShim,
  renderWindowsCmdShim,
  renderWindowsHiddenOpenVbs,
  syncCommandShims,
  upsertPosixShellPath,
} from '../shims.ts'
import { buildDaemonChildEnv, runSupervisor } from '../supervisor.ts'
import {
  buildReleaseAssetUrl,
  performRollback,
  performUpgrade,
  type DaemonTransactionHooks,
  type FetchLike,
} from '../upgrader.ts'

const repoRoot = resolve(import.meta.dirname, '../../..')
const cleanupTasks: Array<() => Promise<void> | void> = []

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanupTasks.push(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })
  return dir
}

async function allocateTestPort(): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createNetServer()
    server.once('error', rejectPromise)
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        rejectPromise(new Error('Expected TCP port address'))
        return
      }
      const chosen = address.port
      server.close((err) => {
        if (err !== undefined) rejectPromise(err)
        else resolvePromise(chosen)
      })
    })
  })
}

function seedSyntheticSlot(
  releasesDir: string,
  version: string,
  target: ReleaseTarget = 'darwin-arm64',
  platform: NodeJS.Platform = process.platform,
): string {
  const slot = resolveReleaseSlotPaths(releasesDir, version, platform)
  mkdirSync(join(slot.slotDir, 'node', 'bin'), { recursive: true })
  mkdirSync(join(slot.slotDir, 'app', 'lib'), { recursive: true })
  mkdirSync(join(slot.slotDir, 'supervisor'), { recursive: true })

  if (platform === 'win32') {
    writeFileSync(slot.nodeExecutable, 'stub-node-exe', 'utf8')
  } else {
    writeFileSync(
      slot.nodeExecutable,
      `#!/usr/bin/env sh\nexec "${process.execPath}" "$@"\n`,
      { encoding: 'utf8', mode: 0o755 },
    )
    chmodSync(slot.nodeExecutable, 0o755)
  }

  writeFileSync(slot.dshBinScript, 'console.log("stub dsh")\n', 'utf8')
  writeFileSync(
    slot.cliScript,
    'process.stdout.write("postinstall-stub-ok\\n")\n',
    'utf8',
  )
  writeFileSync(slot.supervisorScript, 'console.log("stub supervisor")\n', 'utf8')

  const manifest: ReleaseManifest = {
    schemaVersion: 1,
    editionVersion: version,
    dshCoreVersion: '0.2.2-rc.2',
    commit: 'abcdef123456',
    nodeVersion: '24.21.0',
    target,
    builtAt: '2026-11-16T00:00:00.000Z',
    repo: 'dqrcsc/deepseek-harness',
  }
  writeFileSync(slot.releaseManifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return slot.slotDir
}

afterEach(async () => {
  while (cleanupTasks.length > 0) {
    const task = cleanupTasks.pop()
    if (task !== undefined) await task()
  }
})

describe('Reins shared metadata, SemVer, brand personas, and log rotation', () => {
  it('normalizes and orders release tags including prereleases', () => {
    expect(normalizeVersionTag('1.0.0')).toBe('v1.0.0')
    expect(normalizeVersionTag('v1.2.3')).toBe('v1.2.3')
    expect(normalizeVersionTag('reins-v2.0.0-rc.1')).toBe('v2.0.0-rc.1')
    expect(() => normalizeVersionTag('invalid-tag')).toThrow(/Invalid edition version/u)

    expect(compareVersions('v1.0.0', 'v1.0.0')).toBe(0)
    expect(compareVersions('v1.1.0', 'v1.0.9')).toBe(1)
    expect(compareVersions('v1.0.0-rc.1', 'v1.0.0')).toBe(-1)
    expect(compareVersions('v1.0.0-rc.2', 'v1.0.0-rc.10')).toBe(-1)
  })

  it('resolves brand identities from invoked command paths and extensions', () => {
    expect(resolveBrandIdentity(undefined).displayName).toBe('执辔 Reins')
    expect(resolveBrandIdentity('/Users/demo/.reins/bin/reins').command).toBe('reins')
    expect(resolveBrandIdentity('C:\\Users\\demo\\AppData\\Local\\Reins\\bin\\loom.cmd').displayName).toBe('灵枢 Loom')
    expect(resolveBrandIdentity('/Users/demo/.reins/bin/lumen').displayName).toBe('澄明 Lumen')
    expect(resolveBrandIdentity('custom-wrapper.sh').command).toBe('reins')
  })

  it('resolves isolated platform roots without touching ~/.dsh', () => {
    const macPaths = resolveReinsPaths(undefined, {}, 'darwin')
    expect(macPaths.rootDir.endsWith('.reins')).toBe(true)
    expect(macPaths.dataDir).toBe(join(macPaths.rootDir, 'data'))

    const winPaths = resolveReinsPaths(undefined, { LOCALAPPDATA: 'C:\\Users\\Alice\\AppData\\Local' }, 'win32')
    expect(winPaths.rootDir).toContain('Reins')

    const customRoot = createTempDir('reins-paths-')
    const overridden = resolveReinsPaths(undefined, { REINS_HOME: customRoot }, 'darwin')
    expect(overridden.rootDir).toBe(resolve(customRoot))
  })

  it('extracts authenticated launch URLs and rotates daemon logs at maxBytes', () => {
    expect(extractWebLaunchUrl('  dsh web: http://127.0.0.1:3180/?token=secret_123  ')).toBe(
      'http://127.0.0.1:3180/?token=secret_123',
    )
    expect(extractWebLaunchUrl('unrelated console output')).toBeUndefined()

    const dir = createTempDir('reins-log-')
    const logFile = join(dir, 'daemon.log')
    const writer = new RotatingLogWriter(logFile, 48)
    writer.writeLine('first-line-0123456789')
    writer.writeLine('second-line-0123456789')
    writer.writeLine('third-line-after-roll')

    expect(existsSync(`${logFile}.1`)).toBe(true)
    expect(readFileSync(logFile, 'utf8')).toContain('third-line-after-roll')
    expect(readFileSync(`${logFile}.1`, 'utf8')).toContain('first-line-0123456789')
  })
})

describe('Reins command shims, external PATH conflict detection, and shell PATH blocks', () => {
  it('generates shims and skips aliases colliding with external executables on PATH', () => {
    const rootDir = createTempDir('reins-shims-')
    const externalBin = createTempDir('external-bin-')
    const paths = resolveReinsPaths(rootDir, {}, process.platform)
    const config = readReinsConfig(paths.configFile)

    if (process.platform === 'win32') {
      writeFileSync(join(externalBin, 'loom.exe'), 'external', 'utf8')
    } else {
      const externalLoom = join(externalBin, 'loom')
      writeFileSync(externalLoom, '#!/bin/sh\necho external\n', { encoding: 'utf8', mode: 0o755 })
      chmodSync(externalLoom, 0o755)
    }

    const simulatedEnv: NodeJS.ProcessEnv = {
      PATH: [paths.binDir, externalBin].join(process.platform === 'win32' ? ';' : delimiter),
      PATHEXT: '.EXE;.CMD',
    }
    expect(detectExternalCommandConflict('loom', paths.binDir, simulatedEnv, process.platform)).toBeDefined()
    expect(detectExternalCommandConflict('lumen', paths.binDir, simulatedEnv, process.platform)).toBeUndefined()

    const syncResult = syncCommandShims(paths, config, { env: simulatedEnv, platform: process.platform })
    expect(syncResult.installed).toEqual(['reins', 'lumen'])
    expect(syncResult.skippedConflicts).toHaveLength(1)
    expect(syncResult.skippedConflicts[0]?.alias).toBe('loom')

    expect(renderPosixShim('reins')).toContain('--invoked-as "reins"')
    expect(renderWindowsCmdShim('loom')).toContain('--invoked-as "loom"')
    expect(renderWindowsHiddenOpenVbs()).toContain('shell.Run cmd, 0, False')
  })

  it('upserts and cleanly removes POSIX shell profile PATH blocks idempotently', () => {
    const fakeHome = createTempDir('reins-fake-home-')
    const zshrc = join(fakeHome, '.zshrc')
    writeFileSync(zshrc, 'export EDITOR=vim\n', 'utf8')

    upsertPosixShellPath('/Users/demo/.reins/bin', fakeHome)
    const afterFirst = readFileSync(zshrc, 'utf8')
    upsertPosixShellPath('/Users/demo/.reins/bin', fakeHome)
    const afterSecond = readFileSync(zshrc, 'utf8')

    expect(afterSecond).toBe(afterFirst)
    expect(afterSecond).toContain('/Users/demo/.reins/bin')
    expect(afterSecond).toContain('export EDITOR=vim')

    removePosixShellPath(fakeHome)
    const afterRemove = readFileSync(zshrc, 'utf8')
    expect(afterRemove).toBe('export EDITOR=vim\n')
  })
})

describe('Reins background supervisor isolation, crash recovery, and port-conflict guard', () => {
  it('strips ambient DSH_* and REINS_* variables while isolating DSH_HOME to <root>/data', () => {
    const rootDir = createTempDir('reins-env-')
    const paths = resolveReinsPaths(rootDir, {}, 'linux')
    const childEnv = buildDaemonChildEnv(
      paths,
      {
        PATH: '/usr/local/bin:/usr/bin',
        DSH_HOME: '/Users/dev/.dsh-custom',
        DSH_PROFILE: 'headless',
        REINS_HOME: rootDir,
        HOME: '/Users/dev',
      },
      'linux',
    )
    expect(childEnv.DSH_HOME).toBe(paths.dataDir)
    expect(childEnv.DSH_PROFILE).toBeUndefined()
    expect(childEnv.REINS_HOME).toBeUndefined()
    expect(childEnv.DSH_TELEMETRY_DISABLED).toBe('1')
    expect(childEnv.HOME).toBe('/Users/dev')
  })

  it('reports port-conflict immediately when the configured loopback port is already bound', async () => {
    const blocker: NetServer = createNetServer()
    const occupiedPort = await new Promise<number>((resolvePort, rejectPort) => {
      blocker.once('error', rejectPort)
      blocker.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
        const addr = blocker.address()
        if (addr === null || typeof addr === 'string') {
          rejectPort(new Error('Expected TCP address'))
          return
        }
        resolvePort(addr.port)
      })
    })
    cleanupTasks.push(
      () =>
        new Promise<void>((resolveClose) => {
          blocker.close(() => {
            resolveClose()
          })
        }),
    )

    const rootDir = createTempDir('reins-port-busy-')
    const paths = resolveReinsPaths(rootDir)
    seedSyntheticSlot(paths.releasesDir, 'v1.0.0')
    writeCurrentVersion(paths.currentFile, 'v1.0.0')
    writeReinsConfig(paths.configFile, {
      port: occupiedPort,
      host: '127.0.0.1',
      enabledAliases: ['loom', 'lumen'],
      repo: 'dqrcsc/deepseek-harness',
    })

    const code = await runSupervisor({
      rootDir,
      nodeExecutableOverride: process.execPath,
      childArgsOverride: ['-e', 'setTimeout(() => {}, 10000)'],
      childEnvOverride: buildDaemonChildEnv(paths, { PATH: process.env.PATH ?? '' }, 'linux'),
    })
    expect(code).toBe(1)
    const status = readDaemonStatus(paths.statusFile)
    expect(status?.state).toBe('port-conflict')
    expect(status?.error).toContain('reins config set port')
  })

  it('captures launch URL tokens, recovers from a child crash, enforces single-instance lock, and stops cleanly', async () => {
    const rootDir = createTempDir('reins-sup-live-')
    const paths = resolveReinsPaths(rootDir)
    const port = await allocateTestPort()
    seedSyntheticSlot(paths.releasesDir, 'v1.0.0')
    writeCurrentVersion(paths.currentFile, 'v1.0.0')
    writeReinsConfig(paths.configFile, {
      port,
      host: '127.0.0.1',
      enabledAliases: ['loom', 'lumen'],
      repo: 'dqrcsc/deepseek-harness',
    })

    const attemptCounterFile = join(rootDir, 'child-attempts.txt')
    const mockChildScript = join(rootDir, 'mock-web-child.mjs')
    writeFileSync(
      mockChildScript,
      [
        'import { existsSync, readFileSync, writeFileSync } from "node:fs"',
        `const counterFile = ${JSON.stringify(attemptCounterFile)}`,
        'const prev = existsSync(counterFile) ? Number.parseInt(readFileSync(counterFile, "utf8"), 10) : 0',
        'const attempt = prev + 1',
        'writeFileSync(counterFile, String(attempt), "utf8")',
        'if (process.env.DSH_HOME === undefined) process.exit(2)',
        'if (attempt === 1) {',
        `  console.log("  dsh web: http://127.0.0.1:${String(port)}/?token=first_attempt")`,
        '  setTimeout(() => process.exit(1), 60)',
        '} else {',
        `  console.log("  dsh web: http://127.0.0.1:${String(port)}/?token=recovered_attempt_" + String(attempt))`,
        '  const timer = setInterval(() => {}, 1000)',
        '  process.on("SIGTERM", () => { clearInterval(timer); process.exit(0) })',
        '}',
        '',
      ].join('\n'),
      'utf8',
    )

    const supervisorPromise = runSupervisor({
      rootDir,
      nodeExecutableOverride: process.execPath,
      childArgsOverride: [mockChildScript],
      childEnvOverride: buildDaemonChildEnv(paths, { PATH: process.env.PATH ?? '' }, 'linux'),
      backoffDelaysMs: [80],
    })
    cleanupTasks.push(async () => {
      mkdirSync(paths.runDir, { recursive: true })
      writeFileSync(paths.stopSignalFile, 'stop\n', 'utf8')
      await supervisorPromise
    })

    await expect.poll(
      () => {
        if (!existsSync(paths.webUrlFile)) return ''
        return readFileSync(paths.webUrlFile, 'utf8').trim()
      },
      { timeout: 8_000 },
    ).toBe(`http://127.0.0.1:${String(port)}/?token=recovered_attempt_2`)

    const duplicateExit = await runSupervisor({
      rootDir,
      nodeExecutableOverride: process.execPath,
      childArgsOverride: [mockChildScript],
    })
    expect(duplicateExit).toBe(0)

    writeFileSync(paths.stopSignalFile, 'stop\n', 'utf8')
    const exitCode = await supervisorPromise
    expect(exitCode).toBe(0)
    expect(existsSync(paths.webUrlFile)).toBe(false)
    expect(existsSync(paths.supervisorLockFile)).toBe(false)
    expect(readDaemonStatus(paths.statusFile)?.state).toBe('stopped')
  })
})

describe('Reins dual-slot upgrader, automatic rollback, CLI personas, and POSIX installer', () => {
  it('builds mirror URLs across prefix proxies, repository mirrors, and templates', () => {
    expect(buildReleaseAssetUrl('dqrcsc/deepseek-harness', 'releases/latest/download/latest.json')).toBe(
      'https://github.com/dqrcsc/deepseek-harness/releases/latest/download/latest.json',
    )
    expect(
      buildReleaseAssetUrl('dqrcsc/deepseek-harness', 'releases/latest/download/latest.json', 'https://ghfast.top/'),
    ).toBe('https://ghfast.top/https://github.com/dqrcsc/deepseek-harness/releases/latest/download/latest.json')
    expect(
      buildReleaseAssetUrl(
        'dqrcsc/deepseek-harness',
        'releases/latest/download/latest.json',
        'http://127.0.0.1:9000/dqrcsc/deepseek-harness',
      ),
    ).toBe('http://127.0.0.1:9000/dqrcsc/deepseek-harness/releases/latest/download/latest.json')
    expect(
      buildReleaseAssetUrl(
        'dqrcsc/deepseek-harness',
        'releases/latest/download/latest.json',
        'https://proxy.internal/fetch?target={url}',
      ),
    ).toBe(
      'https://proxy.internal/fetch?target=https://github.com/dqrcsc/deepseek-harness/releases/latest/download/latest.json',
    )
  })

  it('upgrades atomically, prunes third-oldest slots, auto-rolls back on failed health check, and supports manual rollback', async () => {
    const rootDir = createTempDir('reins-upgrade-')
    const archiveBuildDir = createTempDir('reins-archives-')
    const paths = resolveReinsPaths(rootDir, {}, 'darwin')

    seedSyntheticSlot(paths.releasesDir, 'v0.9.0', 'darwin-arm64', 'darwin')
    seedSyntheticSlot(paths.releasesDir, 'v1.0.0', 'darwin-arm64', 'darwin')
    writeCurrentVersion(paths.currentFile, 'v1.0.0')
    const config = readReinsConfig(paths.configFile)

    const buildArchive = async (ver: string): Promise<{ file: string; path: string; sha256: string; bytes: number }> => {
      const stageParent = join(archiveBuildDir, `stage-${ver}`)
      const slotDir = seedSyntheticSlot(stageParent, ver, 'darwin-arm64', 'darwin')
      const file = `reins-${ver}-darwin-arm64.tar.gz`
      const archivePath = join(archiveBuildDir, file)
      await createTar({ gzip: true, cwd: slotDir, file: archivePath, portable: true }, ['release.json', 'node', 'app', 'supervisor'])
      const sha256 = await sha256File(archivePath)
      const bytes = readFileSync(archivePath).byteLength
      return { file, path: archivePath, sha256, bytes }
    }

    const v110 = await buildArchive('v1.1.0')
    const v120Bad = await buildArchive('v1.2.0')

    let activeManifest: LatestReleaseManifest = {
      schemaVersion: 1,
      editionVersion: 'v1.1.0',
      tag: 'reins-v1.1.0',
      dshCoreVersion: '0.2.2-rc.2',
      commit: '111111111111',
      publishedAt: '2026-11-16T01:00:00.000Z',
      assets: {
        'darwin-arm64': { file: v110.file, sha256: v110.sha256, bytes: v110.bytes },
      },
    }

    const archiveMap = new Map<string, string>([
      [v110.file, v110.path],
      [v120Bad.file, v120Bad.path],
    ])

    const mockFetch: FetchLike = async (url: string): Promise<Response> => {
      if (url.endsWith('/latest.json')) {
        return new Response(JSON.stringify(activeManifest), { status: 200 })
      }
      const matched = [...archiveMap.entries()].find(([name]) => url.endsWith(`/${name}`))
      if (matched !== undefined) {
        return new Response(readFileSync(matched[1]), { status: 200 })
      }
      return new Response('not found', { status: 404 })
    }

    const bootState: {
      runningVersion: string | undefined
      failVersionBoot: string | undefined
    } = {
      runningVersion: 'v1.0.0',
      failVersionBoot: undefined,
    }
    const hooks: DaemonTransactionHooks = {
      isRunning: () => bootState.runningVersion !== undefined,
      stop: async () => {
        bootState.runningVersion = undefined
      },
      startAndVerify: async () => {
        const current = readCurrentVersion(paths.currentFile)
        if (current !== undefined && current === bootState.failVersionBoot) {
          throw new Error(`Simulated startup failure in ${current}`)
        }
        bootState.runningVersion = current
      },
      syncShims: () => {
        syncCommandShims(paths, config, { env: { PATH: '' }, platform: 'darwin' })
      },
    }

    const checkRes = await performUpgrade({
      paths,
      config,
      hooks,
      checkOnly: true,
      targetOverride: 'darwin-arm64',
      fetchImpl: mockFetch,
      platform: 'darwin',
    })
    expect(checkRes.outcome).toBe('update-available')
    expect(readCurrentVersion(paths.currentFile)).toBe('v1.0.0')

    const upgradeRes = await performUpgrade({
      paths,
      config,
      hooks,
      targetOverride: 'darwin-arm64',
      fetchImpl: mockFetch,
      platform: 'darwin',
    })
    expect(upgradeRes.outcome).toBe('upgraded')
    expect(readCurrentVersion(paths.currentFile)).toBe('v1.1.0')
    expect(bootState.runningVersion).toBe('v1.1.0')
    expect(existsSync(join(paths.releasesDir, 'v0.9.0'))).toBe(false)
    expect(existsSync(join(paths.releasesDir, 'v1.0.0'))).toBe(true)
    expect(existsSync(join(paths.releasesDir, 'v1.1.0'))).toBe(true)

    // Simulate a broken v1.2.0 release failing the 15s health check -> must auto-rollback to v1.1.0!
    activeManifest = {
      schemaVersion: 1,
      editionVersion: 'v1.2.0',
      tag: 'reins-v1.2.0',
      dshCoreVersion: '0.2.2-rc.2',
      commit: '222222222222',
      publishedAt: '2026-11-16T02:00:00.000Z',
      assets: {
        'darwin-arm64': { file: v120Bad.file, sha256: v120Bad.sha256, bytes: v120Bad.bytes },
      },
    }
    bootState.failVersionBoot = 'v1.2.0'
    await expect(
      performUpgrade({
        paths,
        config,
        hooks,
        targetOverride: 'darwin-arm64',
        fetchImpl: mockFetch,
        platform: 'darwin',
      }),
    ).rejects.toThrow(/automatically rolled back to v1\.1\.0/u)
    expect(readCurrentVersion(paths.currentFile)).toBe('v1.1.0')
    expect(bootState.runningVersion).toBe('v1.1.0')
    expect(existsSync(join(paths.releasesDir, 'v1.2.0'))).toBe(false)

    // Manual rollback from v1.1.0 -> v1.0.0
    const rollbackRes = await performRollback(paths, hooks, { platform: 'darwin' })
    expect(rollbackRes.fromVersion).toBe('v1.1.0')
    expect(rollbackRes.toVersion).toBe('v1.0.0')
    expect(readCurrentVersion(paths.currentFile)).toBe('v1.0.0')
    expect(bootState.runningVersion).toBe('v1.0.0')
  })

  it('adapts CLI output to brand aliases, updates config/aliases, and preserves data/ on default uninstall', async () => {
    const rootDir = createTempDir('reins-cli-')
    const fakeHome = createTempDir('reins-cli-home-')
    const paths = resolveReinsPaths(rootDir, {}, 'darwin')
    seedSyntheticSlot(paths.releasesDir, 'v1.0.0', 'darwin-arm64', 'darwin')
    writeCurrentVersion(paths.currentFile, 'v1.0.0')
    mkdirSync(paths.dataDir, { recursive: true })
    const sessionSentinel = join(paths.dataDir, 'keep-session.jsonl')
    writeFileSync(sessionSentinel, '{"ok":true}\n', 'utf8')

    const runCapture = async (argv: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
      let stdout = ''
      let stderr = ''
      const code = await runReinsCli(argv, {
        env: { PATH: paths.binDir },
        platform: 'darwin',
        userHome: fakeHome,
        stdout: (t) => { stdout += t },
        stderr: (t) => { stderr += t },
      })
      return { code, stdout, stderr }
    }

    const loomVer = await runCapture(['--invoked-as', 'loom', '--root', rootDir, 'version'])
    expect(loomVer.code).toBe(0)
    expect(loomVer.stdout).toContain('灵枢 Loom v1.0.0')

    const lumenHelp = await runCapture(['--invoked-as', 'lumen', '--root', rootDir, 'help'])
    expect(lumenHelp.code).toBe(0)
    expect(lumenHelp.stdout).toContain('澄明 Lumen')
    expect(lumenHelp.stdout).toContain('lumen upgrade')

    const setPort = await runCapture(['--root', rootDir, 'config', 'set', 'port', '3290'])
    expect(setPort.code).toBe(0)
    const getPort = await runCapture(['--root', rootDir, 'config', 'get', 'port'])
    expect(getPort.stdout.trim()).toBe('3290')

    const disableAlias = await runCapture(['--root', rootDir, 'alias', 'disable', 'lumen'])
    expect(disableAlias.code).toBe(0)
    expect(existsSync(join(paths.binDir, 'reins'))).toBe(true)
    expect(existsSync(join(paths.binDir, 'loom'))).toBe(true)
    expect(existsSync(join(paths.binDir, 'lumen'))).toBe(false)

    // Default uninstall preserves data/
    const uninstallKeep = await runCapture(['--root', rootDir, 'uninstall'])
    expect(uninstallKeep.code).toBe(0)
    expect(existsSync(sessionSentinel)).toBe(true)
    expect(existsSync(paths.releasesDir)).toBe(false)

    // --purge-data without --yes on non-TTY refuses destructive deletion
    seedSyntheticSlot(paths.releasesDir, 'v1.0.0', 'darwin-arm64', 'darwin')
    writeCurrentVersion(paths.currentFile, 'v1.0.0')
    if (!process.stdin.isTTY) {
      const refused = await runCapture(['--root', rootDir, 'uninstall', '--purge-data'])
      expect(refused.code).toBe(1)
      expect(existsSync(sessionSentinel)).toBe(true)
    }

    // --purge-data --yes deletes rootDir including data/
    const purged = await runCapture(['--root', rootDir, 'uninstall', '--purge-data', '--yes'])
    expect(purged.code).toBe(0)
    expect(existsSync(sessionSentinel)).toBe(false)
  })

  it.skipIf(process.platform === 'win32')(
    'executes install.sh end-to-end against a local HTTP release mirror with SHA-256 verification',
    async () => {
      const installRoot = createTempDir('reins-sh-home-')
      const buildDir = createTempDir('reins-sh-build-')
      const slotSource = seedSyntheticSlot(join(buildDir, 'slots'), 'v1.0.0', 'darwin-arm64', 'darwin')
      const archiveName = 'reins-v1.0.0-darwin-arm64.tar.gz'
      const archivePath = join(buildDir, archiveName)
      await createTar(
        { gzip: true, cwd: slotSource, file: archivePath, portable: true },
        ['release.json', 'node', 'app', 'supervisor'],
      )
      const archiveSha = await sha256File(archivePath)
      const archiveBytes = readFileSync(archivePath).byteLength

      const latest: LatestReleaseManifest = {
        schemaVersion: 1,
        editionVersion: 'v1.0.0',
        tag: 'reins-v1.0.0',
        dshCoreVersion: '0.2.2-rc.2',
        commit: 'abcdef123456',
        publishedAt: '2026-11-16T03:00:00.000Z',
        assets: {
          'darwin-arm64': { file: archiveName, sha256: archiveSha, bytes: archiveBytes },
        },
      }

      const server: HttpServer = createHttpServer((req, res) => {
        if (req.url?.endsWith('/latest.json') === true) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(latest, null, 2))
          return
        }
        if (req.url?.endsWith(`/${archiveName}`) === true) {
          res.writeHead(200, { 'Content-Type': 'application/gzip' })
          res.end(readFileSync(archivePath))
          return
        }
        res.writeHead(404)
        res.end('not found')
      })

      const serverPort = await new Promise<number>((resolvePort, rejectPort) => {
        server.once('error', rejectPort)
        server.listen({ host: '127.0.0.1', port: 0 }, () => {
          const addr = server.address()
          if (addr === null || typeof addr === 'string') {
            rejectPort(new Error('Expected TCP port'))
            return
          }
          resolvePort(addr.port)
        })
      })
      cleanupTasks.push(
        () =>
          new Promise<void>((resolveClose) => {
            server.close(() => {
              resolveClose()
            })
          }),
      )

      const run = await new Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }>(
        (resolveRun, rejectRun) => {
          const child = spawn('bash', [join(repoRoot, 'scripts', 'reins', 'install.sh')], {
            env: {
              ...process.env,
              REINS_HOME: installRoot,
              REINS_TARGET: 'darwin-arm64',
              REINS_GITHUB_MIRROR: `http://127.0.0.1:${String(serverPort)}/dqrcsc/deepseek-harness`,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          })
          let stdout = ''
          let stderr = ''
          child.stdout.setEncoding('utf8')
          child.stderr.setEncoding('utf8')
          child.stdout.on('data', (chunk: string) => {
            stdout += chunk
          })
          child.stderr.on('data', (chunk: string) => {
            stderr += chunk
          })
          child.once('error', rejectRun)
          child.once('close', (status) => {
            resolveRun({ status, stdout, stderr })
          })
        },
      )
      expect(run.status, `install.sh failed:\nstdout=${run.stdout}\nstderr=${run.stderr}`).toBe(0)
      expect(run.stdout).toContain('postinstall-stub-ok')
      expect(readCurrentVersion(join(installRoot, 'current'))).toBe('v1.0.0')
      expect(existsSync(join(installRoot, 'releases', 'v1.0.0', 'release.json'))).toBe(true)
    },
  )
})
