/**
 * Cross-platform packager for Reins green distributions (`darwin-arm64`, `darwin-x64`, `win32-x64`),
 * assembling locked Node 24, symlink-free `@deepseek-ai/dsh` Web closures, supervisor bundles,
 * `latest.json`, `SHA256SUMS.txt`, and zero-admin installers.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { chmod, copyFile, cp, glob, mkdir, readdir, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { c as createTar } from 'tar'
import { build as bundle } from 'tsdown'
import { deduplicateStagedWorkspacePackages, materializeStagedLinks } from './build-exe-for-python-sdk-staging.ts'
import { resolveWindowsNodePtyAddons } from './executable-native-pty.ts'
import { pnpmInvocation, verifyStagedDependencies } from './executable-packaging.ts'
import primaryLock from './primary-runtime/lock.json' with { type: 'json' }
import { downloadNodeRuntime, type PrimaryRuntimeTarget } from './primary-runtime/prepare.ts'
import {
  DEFAULT_GITHUB_REPO,
  atomicWriteText,
  isExecutedAsMain,
  isJsonRecord,
  isReleaseTarget,
  normalizeVersionTag,
  parseLatestReleaseManifest,
  resolveHostReleaseTarget,
  resolveReleaseSlotPaths,
  sha256File,
  writeReinsConfig,
  type LatestReleaseManifest,
  type ReleaseAssetDescriptor,
  type ReleaseManifest,
  type ReleaseTarget,
} from './reins/shared.ts'
import { validateExtractedSlot } from './reins/upgrader.ts'

const repoRoot = resolve(import.meta.dirname, '..')

interface TargetAssetMetadata {
  readonly target: ReleaseTarget
  readonly editionVersion: string
  readonly dshCoreVersion: string
  readonly commit: string
  readonly file: string
  readonly sha256: string
  readonly bytes: number
}

function toPrimaryRuntimeTarget(target: ReleaseTarget): PrimaryRuntimeTarget {
  switch (target) {
    case 'darwin-arm64':
      return 'mac-arm64'
    case 'darwin-x64':
      return 'mac-x64'
    case 'win32-x64':
      return 'win-x64'
    default: {
      const exhaustive: never = target
      throw new Error(`Unsupported release target: ${String(exhaustive)}`)
    }
  }
}

function archiveFilenameForTarget(editionVersion: string, target: ReleaseTarget): string {
  const ext = target === 'win32-x64' ? 'zip' : 'tar.gz'
  return `reins-${editionVersion}-${target}.${ext}`
}

function runCommand(label: string, command: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, [...args], {
      cwd: repoRoot,
      env: env ?? process.env,
      stdio: 'inherit',
      windowsHide: true,
    })
    child.once('error', rejectPromise)
    child.once('close', (code) => {
      if (code === 0) resolvePromise()
      else rejectPromise(new Error(`build-reins-release: ${label} exited with status ${String(code)}`))
    })
  })
}

function resolveGitCommitShort(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim()
  } catch (error) {
    // Source archives without .git fall back to "unknown".
    void error
    return 'unknown'
  }
}

async function assertSymlinkFree(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name)
    const stat = lstatSync(fullPath)
    if (stat.isSymbolicLink()) {
      throw new Error(`build-reins-release: unexpected symbolic link in packaged slot: ${fullPath}`)
    }
    if (stat.isDirectory()) {
      await assertSymlinkFree(fullPath)
    }
  }
}

async function pruneStagedAppPayload(appDir: string, target: ReleaseTarget): Promise<void> {
  const topLevelCleanup = [
    'README.md',
    'README.zh.md',
    'README.i18n.yaml',
    'platforms.json',
    'runtime-bootstrap.mjs',
  ]
  for (const name of topLevelCleanup) {
    await rm(join(appDir, name), { recursive: true, force: true })
  }

  for await (const relPath of glob('node_modules/**/*.{map,d.ts,d.mts,d.cts}', {
    cwd: appDir,
    exclude: ['node_modules/**/assets/**'],
  })) {
    await rm(join(appDir, relPath), { force: true })
  }

  await rm(join(appDir, 'node_modules', '@deepseek-ai', 'dsh', 'src'), { recursive: true, force: true })
  await rm(join(appDir, 'node_modules', '@deepseek-ai', 'dsh', 'docs'), { recursive: true, force: true })
  for await (const relDir of glob('node_modules/@deepseek-ai/dsh-*/src', { cwd: appDir })) {
    await rm(join(appDir, relDir), { recursive: true, force: true })
  }

  const deepseekScopeDir = join(appDir, 'node_modules', '@deepseek-ai')
  const nativeOfficeDir = join(deepseekScopeDir, `libreoffice-kit-${target}`)
  if (existsSync(nativeOfficeDir)) {
    for (const entry of readdirSync(deepseekScopeDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('libreoffice-kit-') && entry.name !== `libreoffice-kit-${target}`) {
        await rm(join(deepseekScopeDir, entry.name), { recursive: true, force: true })
      }
    }
  }

  const ptyRoot = join(appDir, 'node_modules', 'node-pty')
  await rm(join(ptyRoot, 'build'), { recursive: true, force: true })
  const sourcePrebuild = join(
    repoRoot,
    'packages',
    'subprocess',
    'subprocess-local',
    'node_modules',
    'node-pty',
    'prebuilds',
    target,
  )
  const ptyPrebuildsDir = join(ptyRoot, 'prebuilds')
  if (existsSync(sourcePrebuild)) {
    await mkdir(ptyPrebuildsDir, { recursive: true })
    await cp(sourcePrebuild, join(ptyPrebuildsDir, target), { recursive: true })
  }
  if (existsSync(ptyPrebuildsDir)) {
    for (const entry of readdirSync(ptyPrebuildsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== target) {
        await rm(join(ptyPrebuildsDir, entry.name), { recursive: true, force: true })
      }
    }
  }
  if (target === 'win32-x64') {
    resolveWindowsNodePtyAddons(ptyRoot, 'x64')
  } else {
    const spawnHelper = join(ptyPrebuildsDir, target, 'spawn-helper')
    if (existsSync(spawnHelper)) await chmod(spawnHelper, 0o755)
    const rgBin = join(appDir, 'node_modules', '@vscode', `ripgrep-${target}`, 'bin', 'rg')
    if (existsSync(rgBin)) await chmod(rgBin, 0o755)
  }
}

async function allocateEphemeralPort(): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer()
    server.once('error', rejectPromise)
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        rejectPromise(new Error('Failed to allocate ephemeral TCP port'))
        return
      }
      const chosenPort = address.port
      server.close((closeErr) => {
        if (closeErr !== undefined) rejectPromise(closeErr)
        else resolvePromise(chosenPort)
      })
    })
  })
}

async function runPackagedSlotSmokeTest(slotDir: string, editionVersion: string): Promise<void> {
  const smokeHome = mkdtempSync(join(tmpdir(), 'reins-release-smoke-'))
  const slotCopyDir = join(smokeHome, 'releases', editionVersion)
  mkdirSync(join(smokeHome, 'releases'), { recursive: true })
  const port = await allocateEphemeralPort()

  const slot = resolveReleaseSlotPaths(join(smokeHome, 'releases'), editionVersion)
  cpSync(slotDir, slotCopyDir, { recursive: true })

  const readSmokeDiagnostics = (stdout: string, stderr: string): string => {
    const statusJson = existsSync(join(smokeHome, 'run', 'status.json'))
      ? readFileSync(join(smokeHome, 'run', 'status.json'), 'utf8')
      : '(no status.json)'
    const daemonLog = existsSync(join(smokeHome, 'run', 'daemon.log'))
      ? readFileSync(join(smokeHome, 'run', 'daemon.log'), 'utf8')
      : '(no daemon.log)'
    return `stdout:\n${stdout}\nstderr:\n${stderr}\nstatus.json:\n${statusJson}\ndaemon.log:\n${daemonLog}`
  }

  try {
    validateExtractedSlot(slot)
    atomicWriteText(join(smokeHome, 'current'), `${editionVersion}\n`)
    writeReinsConfig(join(smokeHome, 'config.json'), {
      port,
      host: '127.0.0.1',
      enabledAliases: ['loom', 'lumen'],
      repo: DEFAULT_GITHUB_REPO,
    })

    console.log(`build-reins-release: running loopback Web smoke check on 127.0.0.1:${String(port)}...`)
    const startRes = spawnSync(
      slot.nodeExecutable,
      [slot.cliScript, '--invoked-as', 'reins', '--root', smokeHome, 'start'],
      { encoding: 'utf8', timeout: 60_000, windowsHide: true },
    )
    if (startRes.status !== 0) {
      throw new Error(
        `Smoke test failed to start daemon (status=${String(startRes.status)}):\n${readSmokeDiagnostics(startRes.stdout, startRes.stderr)}`,
      )
    }

    const webUrlFile = join(smokeHome, 'run', 'web-url.txt')
    if (!existsSync(webUrlFile)) {
      throw new Error(
        `Smoke test: run/web-url.txt was not written by supervisor:\n${readSmokeDiagnostics(startRes.stdout, startRes.stderr)}`,
      )
    }
    const launchUrl = readFileSync(webUrlFile, 'utf8').trim()
    const authRes = await fetch(launchUrl, {
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    })
    const setCookie = authRes.headers.get('set-cookie')
    const sessionCookie = setCookie?.split(';', 1)[0]
    if (authRes.status !== 303 || sessionCookie === undefined || sessionCookie === '') {
      throw new Error(`Smoke test token exchange at ${launchUrl} returned HTTP ${String(authRes.status)}`)
    }
    const shellRes = await fetch(new URL(launchUrl).origin, {
      headers: { Cookie: sessionCookie },
      signal: AbortSignal.timeout(15_000),
    })
    if (!shellRes.ok) {
      throw new Error(`Smoke test authenticated shell probe returned HTTP ${String(shellRes.status)}`)
    }
    const html = await shellRes.text()
    if (!html.toLowerCase().includes('<!doctype html')) {
      throw new Error(`Smoke test HTTP probe to ${launchUrl} did not return the Web shell HTML`)
    }
  } finally {
    if (existsSync(slot.nodeExecutable) && existsSync(slot.cliScript)) {
      spawnSync(
        slot.nodeExecutable,
        [slot.cliScript, '--invoked-as', 'reins', '--root', smokeHome, 'stop'],
        { stdio: 'ignore', timeout: 15_000, windowsHide: true },
      )
    }
    rmSync(smokeHome, { recursive: true, force: true })
  }
}

async function packSlotArchive(slotDir: string, archivePath: string, target: ReleaseTarget): Promise<void> {
  await mkdir(join(archivePath, '..'), { recursive: true })
  await rm(archivePath, { force: true })
  const entries = readdirSync(slotDir)
  if (target === 'win32-x64') {
    const tarZip = spawnSync('tar', ['-a', '-cf', archivePath, '-C', slotDir, ...entries], {
      encoding: 'utf8',
      windowsHide: true,
    })
    if (tarZip.status !== 0) {
      if (process.platform === 'win32') {
        const ps = spawnSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `Compress-Archive -Path (Join-Path ${JSON.stringify(slotDir)} '*') -DestinationPath ${JSON.stringify(archivePath)} -Force`,
          ],
          { encoding: 'utf8', windowsHide: true },
        )
        if (ps.status === 0) return
      }
      throw new Error(`Failed to create zip archive ${archivePath}: ${tarZip.stderr || 'tar -a failed'}`)
    }
    return
  }

  await createTar(
    {
      gzip: true,
      cwd: slotDir,
      file: archivePath,
      portable: true,
    },
    entries,
  )
}

/** Options controlling `buildReinsReleaseTarget`. */
export interface BuildReinsReleaseOptions {
  /** Target platform-arch triple. */
  readonly target: ReleaseTarget
  /** Edition version (`v1.0.0` or `reins-v1.0.0`). */
  readonly editionVersion: string
  /** Source GitHub repository (`owner/repo`). */
  readonly repo: string
  /** Output directory receiving archives and manifests (defaults to `.reins-dist`). */
  readonly outDir: string
  /** Scratch staging directory (defaults to `.reins-build`). */
  readonly workDir: string
  /** Node runtime download cache directory. */
  readonly cacheDir: string
  /** Skip `pnpm run build:artifacts` when artifacts are already built. */
  readonly skipBuild: boolean
  /** Skip live loopback startup smoke check. */
  readonly skipSmoke: boolean
  /** Emit `latest.json`, `SHA256SUMS.txt`, and installer copies immediately after packaging. */
  readonly writeManifest: boolean
}

/**
 * Build, stage, smoke-verify, and compress a Reins release archive for one target platform.
 * @param options - Target, version, staging paths, and build/smoke toggles.
 * @returns Built archive file path and SHA-256 descriptor.
 */
export async function buildReinsReleaseTarget(options: BuildReinsReleaseOptions): Promise<TargetAssetMetadata> {
  const editionVersion = normalizeVersionTag(options.editionVersion)
  const outDir = resolve(options.outDir)
  const workDir = resolve(options.workDir)

  if (workDir === repoRoot || repoRoot.startsWith(workDir + sep)) {
    throw new Error(`Refusing unsafe workDir ${workDir} overlapping repository root`)
  }

  const [closureCmd, closureArgs] = pnpmInvocation(['run', 'verify-runtime-closure'])
  await runCommand('verify-runtime-closure', closureCmd, closureArgs)

  if (!options.skipBuild) {
    const [pnpmCmd, pnpmArgs] = pnpmInvocation(['run', 'build:artifacts'])
    await runCommand('build:artifacts', pnpmCmd, pnpmArgs, {
      ...process.env,
      DSH_CLIENT_EDITION_VERSION: editionVersion,
      DSH_TELEMETRY_DISABLED: '1',
    })
  }

  const slotFolderName = `slot-${options.target}-${editionVersion}`
  const slotDir = join(workDir, slotFolderName)
  await rm(slotDir, { recursive: true, force: true })
  await mkdir(slotDir, { recursive: true })

  const nodeDir = join(slotDir, 'node')
  const supervisorDir = join(slotDir, 'supervisor')
  const appDir = join(slotDir, 'app')

  console.log(`build-reins-release: preparing locked Node ${primaryLock.nodeVersion} for ${options.target}...`)
  await downloadNodeRuntime(toPrimaryRuntimeTarget(options.target), nodeDir, resolve(options.cacheDir))
  if (options.target !== 'win32-x64') {
    await chmod(join(nodeDir, 'bin', 'node'), 0o755)
  }

  console.log('build-reins-release: bundling supervisor and CLI entrypoints...')
  await mkdir(supervisorDir, { recursive: true })
  for (const entryName of ['cli', 'supervisor'] as const) {
    await bundle({
      config: false,
      tsconfig: false,
      inputOptions: { tsconfig: false },
      target: 'es2024',
      entry: { [entryName]: join(repoRoot, 'scripts', 'reins', `${entryName}.ts`) },
      outDir: supervisorDir,
      clean: false,
      format: 'esm',
      platform: 'node',
      dts: false,
      shims: false,
      outExtensions: () => ({ js: '.mjs' }),
    })
  }

  const desktopTrayIcon = join(repoRoot, 'apps', 'desktop', 'resources', 'tray-windows.ico')
  if (existsSync(desktopTrayIcon)) {
    await copyFile(desktopTrayIcon, join(supervisorDir, 'reins.ico'))
  }

  console.log('build-reins-release: deploying symlink-free runtime closure...')
  const [pnpmDeployCmd, pnpmDeployArgs] = pnpmInvocation([
    '--filter',
    'dsh-python-runtime-closure',
    'deploy',
    '--prod',
    '--config.allow-unused-patches=true',
    '--config.node-linker=hoisted',
    `--config.pnpmfile=${join(repoRoot, 'scripts/python-runtime-deploy.pnpmfile.mjs')}`,
    '--config.link-workspace-packages=true',
    '--config.hoist-workspace-packages=false',
    appDir,
  ])
  await runCommand('pnpm deploy dsh-python-runtime-closure', pnpmDeployCmd, pnpmDeployArgs, {
    ...process.env,
    CI: 'true',
  })

  await materializeStagedLinks(appDir)
  await deduplicateStagedWorkspacePackages(appDir, appDir)
  await verifyStagedDependencies(appDir)
  await pruneStagedAppPayload(appDir, options.target)

  const rootPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version: string }
  const commit = resolveGitCommitShort()
  const releaseManifest: ReleaseManifest = {
    schemaVersion: 1,
    editionVersion,
    dshCoreVersion: rootPkg.version,
    commit,
    nodeVersion: primaryLock.nodeVersion,
    target: options.target,
    builtAt: new Date().toISOString(),
    repo: options.repo,
  }
  writeFileSync(join(slotDir, 'release.json'), `${JSON.stringify(releaseManifest, null, 2)}\n`, 'utf8')

  const targetPlatform: NodeJS.Platform = options.target === 'win32-x64' ? 'win32' : 'darwin'
  validateExtractedSlot(resolveReleaseSlotPaths(workDir, slotFolderName, targetPlatform))
  await assertSymlinkFree(slotDir)

  let hostTarget: ReleaseTarget | undefined
  try {
    hostTarget = resolveHostReleaseTarget()
  } catch (error) {
    // Cross-building on Linux skips native macOS/Windows execution smoke.
    void error
  }
  if (!options.skipSmoke && hostTarget === options.target) {
    await runPackagedSlotSmokeTest(slotDir, editionVersion)
  }

  const archiveFilename = archiveFilenameForTarget(editionVersion, options.target)
  const archivePath = join(outDir, archiveFilename)
  console.log(`build-reins-release: packing ${archiveFilename}...`)
  await packSlotArchive(slotDir, archivePath, options.target)

  const sha256 = await sha256File(archivePath)
  const bytes = statSync(archivePath).size
  const assetMeta: TargetAssetMetadata = {
    target: options.target,
    editionVersion,
    dshCoreVersion: rootPkg.version,
    commit,
    file: archiveFilename,
    sha256,
    bytes,
  }
  writeFileSync(
    join(outDir, `${archiveFilename}.asset.json`),
    `${JSON.stringify(assetMeta, null, 2)}\n`,
    'utf8',
  )

  if (options.writeManifest) {
    await finalizeReleaseDirectory(outDir, { editionVersion })
  }

  console.log(`build-reins-release: built ${archivePath} (${(bytes / (1024 * 1024)).toFixed(1)} MiB, sha256=${sha256})`)
  return assetMeta
}

/**
 * Assemble `latest.json`, `SHA256SUMS.txt`, `install.sh`, and `install.ps1` from built `*.asset.json` records in `outDir`.
 * @param outDir - Directory containing built release archives and `.asset.json` sidecars.
 * @param options - Optional expected edition version and required targets check.
 * @returns Validated `LatestReleaseManifest` written to `<outDir>/latest.json`.
 */
export async function finalizeReleaseDirectory(
  outDir: string,
  options: {
    readonly editionVersion?: string | undefined
    readonly requireTargets?: readonly ReleaseTarget[] | undefined
  } = {},
): Promise<LatestReleaseManifest> {
  const resolvedOut = resolve(outDir)
  const sidecars = readdirSync(resolvedOut).filter(name => name.endsWith('.asset.json')).sort()
  if (sidecars.length === 0) {
    throw new Error(`No *.asset.json metadata files found in ${resolvedOut}`)
  }

  const assets: Partial<Record<ReleaseTarget, ReleaseAssetDescriptor>> = {}
  let editionVersion: string | undefined = options.editionVersion !== undefined
    ? normalizeVersionTag(options.editionVersion)
    : undefined
  let dshCoreVersion: string | undefined
  let commit: string | undefined

  for (const sidecar of sidecars) {
    const parsed: unknown = JSON.parse(readFileSync(join(resolvedOut, sidecar), 'utf8'))
    if (
      !isJsonRecord(parsed)
      || typeof parsed.target !== 'string'
      || !isReleaseTarget(parsed.target)
      || typeof parsed.editionVersion !== 'string'
      || typeof parsed.dshCoreVersion !== 'string'
      || typeof parsed.commit !== 'string'
      || typeof parsed.file !== 'string'
      || typeof parsed.sha256 !== 'string'
      || typeof parsed.bytes !== 'number'
    ) {
      throw new Error(`Invalid asset metadata sidecar: ${sidecar}`)
    }
    const normalizedEdition = normalizeVersionTag(parsed.editionVersion)
    if (editionVersion === undefined) editionVersion = normalizedEdition
    else if (editionVersion !== normalizedEdition) {
      throw new Error(`Mismatched editionVersion across sidecars: ${editionVersion} vs ${normalizedEdition}`)
    }
    dshCoreVersion ??= parsed.dshCoreVersion
    commit ??= parsed.commit

    const archiveFile = join(resolvedOut, basename(parsed.file))
    if (!existsSync(archiveFile)) {
      throw new Error(`Missing release archive ${archiveFile} referenced by ${sidecar}`)
    }
    const actualSha = await sha256File(archiveFile)
    const actualBytes = statSync(archiveFile).size
    if (actualSha !== parsed.sha256.toLowerCase() || actualBytes !== parsed.bytes) {
      throw new Error(`Archive ${archiveFile} does not match ${sidecar} digest/size`)
    }
    assets[parsed.target] = {
      file: basename(parsed.file),
      sha256: actualSha,
      bytes: actualBytes,
    }
  }

  if (editionVersion === undefined || dshCoreVersion === undefined || commit === undefined) {
    throw new Error(`Failed to resolve release metadata from ${resolvedOut}`)
  }

  if (options.requireTargets !== undefined) {
    for (const reqTarget of options.requireTargets) {
      if (assets[reqTarget] === undefined) {
        throw new Error(`Missing required target archive for ${reqTarget} in ${resolvedOut}`)
      }
    }
  }

  const installShDest = join(resolvedOut, 'install.sh')
  const installPs1Dest = join(resolvedOut, 'install.ps1')
  await copyFile(join(repoRoot, 'scripts', 'reins', 'install.sh'), installShDest)
  await chmod(installShDest, 0o755)
  await copyFile(join(repoRoot, 'scripts', 'reins', 'install.ps1'), installPs1Dest)

  const latestManifest = parseLatestReleaseManifest({
    schemaVersion: 1,
    editionVersion,
    tag: `reins-${editionVersion}`,
    dshCoreVersion,
    commit,
    publishedAt: new Date().toISOString(),
    assets,
  })
  const latestJsonPath = join(resolvedOut, 'latest.json')
  writeFileSync(latestJsonPath, `${JSON.stringify(latestManifest, null, 2)}\n`, 'utf8')

  const checksumFiles = [
    ...Object.values(assets).map(item => item.file),
    'install.sh',
    'install.ps1',
    'latest.json',
  ].sort()

  const checksumLines: string[] = []
  for (const name of checksumFiles) {
    const digest = await sha256File(join(resolvedOut, name))
    checksumLines.push(`${digest}  ${name}`)
  }
  writeFileSync(join(resolvedOut, 'SHA256SUMS.txt'), `${checksumLines.join('\n')}\n`, 'utf8')

  return latestManifest
}

function usage(): string {
  return [
    'Usage:',
    '  pnpm exec tsx scripts/build-reins-release.ts [options]',
    '  pnpm exec tsx scripts/build-reins-release.ts --finalize-manifest <dir> [--edition-version <ver>] [--require-all-targets]',
    '',
    'Options:',
    '  --target <triple>          darwin-arm64 | darwin-x64 | win32-x64 (defaults to host)',
    '  --edition-version <ver>    Edition version tag such as v1.0.0 or reins-v1.0.0',
    '  --repo <owner/repo>        GitHub repository slug (default: dqrcsc/deepseek-harness)',
    '  --out-dir <dir>            Output directory (default: .reins-dist)',
    '  --work-dir <dir>           Staging directory (default: .reins-build)',
    '  --cache-dir <dir>          Node runtime download cache directory',
    '  --skip-build               Skip pnpm run build:artifacts',
    '  --skip-smoke               Skip live loopback Web startup smoke test',
    '  --no-manifest              Skip writing latest.json / SHA256SUMS.txt during target build',
    '  --finalize-manifest <dir>  Generate latest.json, SHA256SUMS.txt, install.sh, and install.ps1 in <dir>',
    '  --require-all-targets      With --finalize-manifest, require darwin-arm64, darwin-x64, and win32-x64',
    '  --help                     Show this help message',
  ].join('\n')
}

function parseCliTarget(rawTarget: string | undefined): ReleaseTarget {
  const trimmed = rawTarget?.trim()
  if (trimmed === undefined || trimmed === '') {
    return resolveHostReleaseTarget()
  }
  if (!isReleaseTarget(trimmed)) {
    throw new Error(`Unsupported --target ${JSON.stringify(trimmed)}; expected darwin-arm64, darwin-x64, or win32-x64`)
  }
  return trimmed
}

if (isExecutedAsMain(import.meta.url)) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      target: { type: 'string' },
      'edition-version': { type: 'string' },
      repo: { type: 'string' },
      'out-dir': { type: 'string' },
      'work-dir': { type: 'string' },
      'cache-dir': { type: 'string' },
      'skip-build': { type: 'boolean', default: false },
      'skip-smoke': { type: 'boolean', default: false },
      'no-manifest': { type: 'boolean', default: false },
      'finalize-manifest': { type: 'string' },
      'require-all-targets': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  })

  if (values.help) {
    console.log(usage())
    process.exit(0)
  }

  if (values['finalize-manifest'] !== undefined) {
    const manifest = await finalizeReleaseDirectory(values['finalize-manifest'], {
      editionVersion: values['edition-version'],
      requireTargets: values['require-all-targets']
        ? ['darwin-arm64', 'darwin-x64', 'win32-x64']
        : undefined,
    })
    console.log(`build-reins-release: finalized ${manifest.tag} (${Object.keys(manifest.assets).join(', ')})`)
  } else {
    const target = parseCliTarget(values.target)
    const editionVersion = values['edition-version']
      ?? process.env.DSH_CLIENT_EDITION_VERSION
      ?? 'v1.0.0'
    await buildReinsReleaseTarget({
      target,
      editionVersion,
      repo: values.repo ?? DEFAULT_GITHUB_REPO,
      outDir: values['out-dir'] ?? join(repoRoot, '.reins-dist'),
      workDir: values['work-dir'] ?? join(repoRoot, '.reins-build'),
      cacheDir: values['cache-dir'] ?? join(tmpdir(), 'dsh-primary-runtime-downloads'),
      skipBuild: values['skip-build'],
      skipSmoke: values['skip-smoke'],
      writeManifest: !values['no-manifest'],
    })
  }
}
