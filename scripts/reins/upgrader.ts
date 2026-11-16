/**
 * GitHub Releases manifest lookup, archive SHA-256 verification, dual-slot extraction,
 * atomic upgrade, automatic health-check rollback, and slot pruning.
 */

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  compareVersions,
  normalizeVersionTag,
  parseLatestReleaseManifest,
  parseReleaseManifest,
  readCurrentVersion,
  resolveHostReleaseTarget,
  resolveReleaseSlotPaths,
  sha256File,
  writeCurrentVersion,
  type LatestReleaseManifest,
  type ReinsConfig,
  type ReinsPaths,
  type ReleaseManifest,
  type ReleaseSlotPaths,
  type ReleaseTarget,
} from './shared.ts'

/** Default health-check timeout before an upgrade automatically rolls back (15 seconds). */
export const DEFAULT_UPGRADE_HEALTH_TIMEOUT_MS = 15_000

/** Minimal fetch function signature accepted by network helpers for deterministic testing. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/**
 * Construct a GitHub Release download URL with optional mirror acceleration.
 * @param repo - GitHub `owner/repo` slug.
 * @param releaseAssetPath - Path below the repository root (for example `releases/latest/download/latest.json`).
 * @param mirror - Optional mirror URL prefix or `{url}` template.
 * @returns Complete HTTP(S) URL string.
 */
export function buildReleaseAssetUrl(
  repo: string,
  releaseAssetPath: string,
  mirror?: string,
): string {
  const cleanAssetPath = releaseAssetPath.replace(/^\/+/u, '')
  const canonicalUrl = `https://github.com/${repo}/${cleanAssetPath}`
  const trimmedMirror = mirror?.trim().replace(/\/+$/u, '')
  if (trimmedMirror === undefined || trimmedMirror === '') return canonicalUrl
  if (trimmedMirror.includes('{url}')) return trimmedMirror.replaceAll('{url}', canonicalUrl)
  if (trimmedMirror.endsWith(`/${repo}`)) return `${trimmedMirror}/${cleanAssetPath}`
  return `${trimmedMirror}/${canonicalUrl}`
}

/** Options for fetching `latest.json` from GitHub Releases or a mirror. */
export interface FetchReleaseManifestOptions {
  /** GitHub `owner/repo` slug. */
  readonly repo: string
  /** Optional mirror URL prefix. */
  readonly mirror?: string | undefined
  /** Optional target version (`v1.2.0` or `reins-v1.2.0`); omit to query `releases/latest`. */
  readonly version?: string | undefined
  /** Optional request timeout in milliseconds. */
  readonly timeoutMs?: number | undefined
  /** Optional fetch implementation override for unit tests. */
  readonly fetchImpl?: FetchLike | undefined
}

/**
 * Fetch and validate `latest.json` for either the latest release or a specific `reins-v*` tag.
 * @param options - Repository, optional mirror, optional pinned version, and fetch implementation.
 * @returns Validated `LatestReleaseManifest`.
 */
export async function fetchReleaseManifest(options: FetchReleaseManifestOptions): Promise<LatestReleaseManifest> {
  const fetchFn: FetchLike = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 20_000
  const assetPath = options.version !== undefined && options.version.trim() !== ''
    ? `releases/download/reins-${normalizeVersionTag(options.version).slice(1)}/latest.json`
    : 'releases/latest/download/latest.json'
  const url = buildReleaseAssetUrl(options.repo, assetPath, options.mirror)
  const response = await fetchFn(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    throw new Error(`Failed to fetch release manifest (${String(response.status)} ${response.statusText}): ${url}`)
  }
  const rawJson: unknown = await response.json()
  return parseLatestReleaseManifest(rawJson)
}

/**
 * Read `<slot>/release.json` if present and valid.
 * @param slot - Resolved slot paths.
 * @returns Validated `ReleaseManifest`, or `undefined` when missing or unreadable.
 */
export function readSlotReleaseManifest(slot: ReleaseSlotPaths): ReleaseManifest | undefined {
  if (!existsSync(slot.releaseManifestFile)) return undefined
  try {
    return parseReleaseManifest(JSON.parse(readFileSync(slot.releaseManifestFile, 'utf8')))
  } catch (error) {
    // Partially unpacked or corrupted slot directories return undefined so callers reject or skip them.
    void error
    return undefined
  }
}

/**
 * Verify that an unpacked release slot contains every required runtime file and a valid `release.json`.
 * @param slot - Slot paths to inspect.
 * @returns Parsed `ReleaseManifest` from `<slot>/release.json`.
 */
export function validateExtractedSlot(slot: ReleaseSlotPaths): ReleaseManifest {
  const requiredFiles: ReadonlyArray< readonly [label: string, path: string] > = [
    ['release.json', slot.releaseManifestFile],
    ['Node runtime', slot.nodeExecutable],
    ['DSH CLI entry', slot.dshBinScript],
    ['Reins CLI bundle', slot.cliScript],
    ['Reins supervisor bundle', slot.supervisorScript],
  ]
  for (const [label, filePath] of requiredFiles) {
    if (!existsSync(filePath)) {
      throw new Error(`Incomplete release archive: missing ${label} at ${filePath}`)
    }
  }
  return parseReleaseManifest(JSON.parse(readFileSync(slot.releaseManifestFile, 'utf8')))
}

/**
 * Extract a `.tar.gz` or `.zip` release archive into `destinationDir` and strip macOS quarantine attributes.
 * @param archivePath - Local verified archive path.
 * @param destinationDir - Target slot directory.
 * @param platform - Active OS platform.
 */
export function extractReleaseArchive(
  archivePath: string,
  destinationDir: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const parentDir = join(destinationDir, '..')
  mkdirSync(parentDir, { recursive: true })
  const tempExtractDir = join(parentDir, `.extract-${randomUUID()}`)
  mkdirSync(tempExtractDir, { recursive: true })

  try {
    if (archivePath.toLowerCase().endsWith('.zip')) {
      const tarRes = spawnSync('tar', ['-xf', archivePath, '-C', tempExtractDir], {
        windowsHide: true,
        encoding: 'utf8',
      })
      if (tarRes.status !== 0) {
        if (platform !== 'win32') {
          throw new Error(`Failed to extract zip archive ${archivePath}: ${tarRes.stderr || 'tar exited non-zero'}`)
        }
        const psScript = `Expand-Archive -LiteralPath ${JSON.stringify(archivePath)} -DestinationPath ${JSON.stringify(tempExtractDir)} -Force`
        const psRes = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
          windowsHide: true,
          encoding: 'utf8',
        })
        if (psRes.status !== 0) {
          throw new Error(`Failed to extract zip archive ${archivePath}: ${psRes.stderr || 'Expand-Archive failed'}`)
        }
      }
    } else {
      const tarRes = spawnSync('tar', ['-xzf', archivePath, '-C', tempExtractDir], {
        windowsHide: true,
        encoding: 'utf8',
      })
      if (tarRes.status !== 0) {
        throw new Error(`Failed to extract tar.gz archive ${archivePath}: ${tarRes.stderr || 'tar exited non-zero'}`)
      }
    }

    let payloadRoot = tempExtractDir
    if (!existsSync(join(tempExtractDir, 'release.json'))) {
      const entries = readdirSync(tempExtractDir, { withFileTypes: true })
      const singleDir = entries.length === 1 && entries[0]?.isDirectory() === true
        ? join(tempExtractDir, entries[0].name)
        : undefined
      if (singleDir !== undefined && existsSync(join(singleDir, 'release.json'))) {
        payloadRoot = singleDir
      }
    }

    if (platform === 'darwin') {
      spawnSync('xattr', ['-dr', 'com.apple.quarantine', payloadRoot], { stdio: 'ignore' })
    }
    if (platform !== 'win32') {
      const nodeBin = join(payloadRoot, 'node', 'bin', 'node')
      if (existsSync(nodeBin)) chmodSync(nodeBin, 0o755)
    }

    rmSync(destinationDir, { recursive: true, force: true })
    renameSync(payloadRoot, destinationDir)
  } finally {
    rmSync(tempExtractDir, { recursive: true, force: true })
  }
}

/**
 * List valid unpacked release slot versions under `releases/`, sorted newest SemVer first.
 * @param releasesDir - `<root>/releases` directory.
 * @param platform - Target OS platform selecting `node` vs `node.exe`.
 * @returns Validated slot version strings (`vX.Y.Z`).
 */
export function listInstalledVersions(
  releasesDir: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (!existsSync(releasesDir)) return []
  const versions: string[] = []
  for (const entry of readdirSync(releasesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    let normalized: string
    try {
      normalized = normalizeVersionTag(entry.name)
    } catch (error) {
      // Non-version directories inside releases/ are ignored during slot enumeration.
      void error
      continue
    }
    if (normalized !== entry.name) continue
    const slot = resolveReleaseSlotPaths(releasesDir, normalized, platform)
    if (existsSync(slot.nodeExecutable) && existsSync(slot.cliScript)) {
      versions.push(normalized)
    }
  }
  versions.sort((left, right) => compareVersions(right, left))
  return versions
}

/**
 * Select the local fallback slot for `reins rollback` (most recently modified valid slot distinct from `current`).
 * @param paths - Resolved installation paths.
 * @param platform - Active OS platform.
 * @returns Fallback version string, or `undefined` when no alternate slot exists.
 */
export function resolveRollbackTarget(
  paths: ReinsPaths,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const current = readCurrentVersion(paths.currentFile)
  const candidates = listInstalledVersions(paths.releasesDir, platform).filter(ver => ver !== current)
  if (candidates.length === 0) return undefined
  candidates.sort((left, right) => {
    const leftMtime = statSync(join(paths.releasesDir, left)).mtimeMs
    const rightMtime = statSync(join(paths.releasesDir, right)).mtimeMs
    if (leftMtime !== rightMtime) return rightMtime - leftMtime
    return compareVersions(right, left)
  })
  return candidates[0]
}

/**
 * Prune obsolete slot directories under `releases/`, retaining only `keepVersions` (with bounded retries for Windows handle release).
 * @param paths - Resolved installation paths.
 * @param keepVersions - Set of slot directory names to preserve.
 * @returns Removed directory names.
 */
export async function pruneReleaseSlots(
  paths: ReinsPaths,
  keepVersions: ReadonlySet<string>,
): Promise<string[]> {
  if (!existsSync(paths.releasesDir)) return []
  const removed: string[] = []
  for (const entry of readdirSync(paths.releasesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || keepVersions.has(entry.name)) continue
    const fullPath = join(paths.releasesDir, entry.name)
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        rmSync(fullPath, { recursive: true, force: true })
        removed.push(entry.name)
        break
      } catch (error) {
        if (attempt === 3) {
          // Best-effort pruning never aborts a healthy upgrade if an antivirus scanner holds an old directory.
          void error
        } else {
          await new Promise(resolveSleep => setTimeout(resolveSleep, 200))
        }
      }
    }
  }
  return removed
}

/** Daemon control callbacks injected by the CLI into upgrade and rollback transactions. */
export interface DaemonTransactionHooks {
  /** Return whether the background daemon is currently alive. */
  readonly isRunning: () => boolean
  /** Gracefully stop the background daemon and wait for process exit. */
  readonly stop: () => Promise<void>
  /** Start the background daemon from the current slot and await readiness. */
  readonly startAndVerify: (timeoutMs: number) => Promise<void>
  /** Refresh `<root>/bin/` shims after switching slots. */
  readonly syncShims: () => void
}

/** Options controlling `performUpgrade`. */
export interface PerformUpgradeOptions {
  /** Resolved installation paths. */
  readonly paths: ReinsPaths
  /** Current host configuration. */
  readonly config: ReinsConfig
  /** Daemon lifecycle hooks. */
  readonly hooks: DaemonTransactionHooks
  /** Check for updates without downloading or modifying slots. */
  readonly checkOnly?: boolean | undefined
  /** Pin a specific release version (`v1.2.0` or `reins-v1.2.0`). */
  readonly requestedVersion?: string | undefined
  /** Reinstall even when the target version matches or predates `current`. */
  readonly force?: boolean | undefined
  /** Optional mirror override (for example `REINS_GITHUB_MIRROR`). */
  readonly mirrorOverride?: string | undefined
  /** Optional platform-arch triple override for cross-platform unit tests. */
  readonly targetOverride?: ReleaseTarget | undefined
  /** Optional health-check timeout in milliseconds (defaults to 15,000 ms). */
  readonly healthTimeoutMs?: number | undefined
  /** Optional fetch implementation override for offline unit tests. */
  readonly fetchImpl?: FetchLike | undefined
  /** Optional platform override for shim/binary resolution in unit tests. */
  readonly platform?: NodeJS.Platform | undefined
}

/** Outcome returned by `performUpgrade`. */
export interface UpgradeResult {
  /** Whether an update was applied, available (`--check`), or already current. */
  readonly outcome: 'upgraded' | 'up-to-date' | 'update-available'
  /** Previously active slot version, if any. */
  readonly previousVersion?: string | undefined
  /** Target slot version evaluated or installed. */
  readonly targetVersion: string
  /** Remote manifest used for the check or upgrade. */
  readonly manifest: LatestReleaseManifest
  /** Obsolete slot names pruned after a successful upgrade. */
  readonly prunedSlots: readonly string[]
}

async function downloadVerifiedArchive(
  url: string,
  expectedSha256: string,
  destinationFile: string,
  fetchFn: FetchLike,
): Promise<void> {
  const response = await fetchFn(url, { signal: AbortSignal.timeout(300_000) })
  if (!response.ok) {
    throw new Error(`Failed to download release archive (${String(response.status)} ${response.statusText}): ${url}`)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  mkdirSync(join(destinationFile, '..'), { recursive: true })
  writeFileSync(destinationFile, bytes)
  const actualSha256 = await sha256File(destinationFile)
  if (actualSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
    rmSync(destinationFile, { force: true })
    throw new Error(
      `SHA-256 checksum mismatch for ${url}: expected ${expectedSha256.toLowerCase()}, got ${actualSha256}`,
    )
  }
}

/**
 * Execute a release check or atomic dual-slot upgrade with automatic rollback on failed health verification.
 * @param options - Paths, config, daemon hooks, and version/mirror flags.
 * @returns Structured upgrade outcome.
 */
export async function performUpgrade(options: PerformUpgradeOptions): Promise<UpgradeResult> {
  const platform = options.platform ?? process.platform
  const mirror = options.mirrorOverride ?? options.config.mirror
  const fetchFn: FetchLike = options.fetchImpl ?? fetch
  const healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_UPGRADE_HEALTH_TIMEOUT_MS
  const previousVersion = readCurrentVersion(options.paths.currentFile)

  const manifest = await fetchReleaseManifest({
    repo: options.config.repo,
    mirror,
    version: options.requestedVersion,
    fetchImpl: fetchFn,
  })
  const targetVersion = manifest.editionVersion

  const isUpToDate = previousVersion !== undefined && (
    options.requestedVersion !== undefined
      ? compareVersions(targetVersion, previousVersion) === 0
      : compareVersions(targetVersion, previousVersion) <= 0
  )

  if (options.checkOnly === true) {
    return {
      outcome: isUpToDate ? 'up-to-date' : 'update-available',
      previousVersion,
      targetVersion,
      manifest,
      prunedSlots: [],
    }
  }

  if (isUpToDate && options.force !== true) {
    return {
      outcome: 'up-to-date',
      previousVersion,
      targetVersion,
      manifest,
      prunedSlots: [],
    }
  }

  const target = options.targetOverride ?? resolveHostReleaseTarget(platform, process.arch)
  const asset = manifest.assets[target]
  if (asset === undefined) {
    throw new Error(`Release ${manifest.tag} does not publish an archive for target ${target}`)
  }

  mkdirSync(options.paths.releasesDir, { recursive: true })
  const tempArchive = join(options.paths.releasesDir, `.download-${randomUUID()}-${asset.file}`)
  const stagingSlotDir = join(options.paths.releasesDir, `.staging-${targetVersion}-${randomUUID()}`)

  try {
    const assetUrl = buildReleaseAssetUrl(
      options.config.repo,
      `releases/download/${manifest.tag}/${asset.file}`,
      mirror,
    )
    await downloadVerifiedArchive(assetUrl, asset.sha256, tempArchive, fetchFn)
    extractReleaseArchive(tempArchive, stagingSlotDir, platform)
    validateExtractedSlot({
      slotDir: stagingSlotDir,
      releaseManifestFile: join(stagingSlotDir, 'release.json'),
      nodeExecutable: join(stagingSlotDir, 'node', 'bin', platform === 'win32' ? 'node.exe' : 'node'),
      dshBinScript: join(stagingSlotDir, 'app', 'lib', 'bin.js'),
      cliScript: join(stagingSlotDir, 'supervisor', 'cli.mjs'),
      supervisorScript: join(stagingSlotDir, 'supervisor', 'supervisor.mjs'),
    })
  } finally {
    rmSync(tempArchive, { force: true })
  }

  const finalSlot = resolveReleaseSlotPaths(options.paths.releasesDir, targetVersion, platform)
  const wasRunning = options.hooks.isRunning()

  try {
    if (wasRunning || previousVersion === targetVersion) {
      await options.hooks.stop()
    }
    rmSync(finalSlot.slotDir, { recursive: true, force: true })
    renameSync(stagingSlotDir, finalSlot.slotDir)

    writeCurrentVersion(options.paths.currentFile, targetVersion)
    options.hooks.syncShims()

    try {
      await options.hooks.startAndVerify(healthTimeoutMs)
    } catch (healthError) {
      await options.hooks.stop()
      rmSync(finalSlot.slotDir, { recursive: true, force: true })
      if (previousVersion !== undefined && previousVersion !== targetVersion) {
        const previousSlot = resolveReleaseSlotPaths(options.paths.releasesDir, previousVersion, platform)
        if (existsSync(previousSlot.nodeExecutable)) {
          writeCurrentVersion(options.paths.currentFile, previousVersion)
          options.hooks.syncShims()
          if (wasRunning) {
            await options.hooks.startAndVerify(healthTimeoutMs)
          }
          const detail = healthError instanceof Error ? healthError.message : String(healthError)
          throw new Error(
            `Upgrade to ${targetVersion} failed health verification and automatically rolled back to ${previousVersion}: ${detail}`,
            { cause: healthError },
          )
        }
      }
      throw healthError
    }
  } finally {
    rmSync(stagingSlotDir, { recursive: true, force: true })
  }

  const keep = new Set<string>([targetVersion])
  if (previousVersion !== undefined) keep.add(previousVersion)
  const prunedSlots = await pruneReleaseSlots(options.paths, keep)

  return {
    outcome: 'upgraded',
    previousVersion,
    targetVersion,
    manifest,
    prunedSlots,
  }
}

/** Outcome returned by `performRollback`. */
export interface RollbackResult {
  /** Version deactivated by the rollback. */
  readonly fromVersion?: string | undefined
  /** Version activated by the rollback. */
  readonly toVersion: string
}

/**
 * Atomically switch `current` back to the retained previous slot and restart the daemon if active.
 * @param paths - Resolved installation paths.
 * @param hooks - Daemon lifecycle hooks.
 * @param options - Optional health timeout and platform override.
 * @returns Activated fallback version details.
 */
export async function performRollback(
  paths: ReinsPaths,
  hooks: DaemonTransactionHooks,
  options: { readonly healthTimeoutMs?: number; readonly platform?: NodeJS.Platform } = {},
): Promise<RollbackResult> {
  const platform = options.platform ?? process.platform
  const healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_UPGRADE_HEALTH_TIMEOUT_MS
  const fromVersion = readCurrentVersion(paths.currentFile)
  const targetVersion = resolveRollbackTarget(paths, platform)
  if (targetVersion === undefined) {
    throw new Error('No previous release slot is available for rollback under releases/')
  }
  const targetSlot = resolveReleaseSlotPaths(paths.releasesDir, targetVersion, platform)
  validateExtractedSlot(targetSlot)

  const wasRunning = hooks.isRunning()
  if (wasRunning) {
    await hooks.stop()
  }
  writeCurrentVersion(paths.currentFile, targetVersion)
  hooks.syncShims()
  if (wasRunning) {
    await hooks.startAndVerify(healthTimeoutMs)
  }
  return { fromVersion, toVersion: targetVersion }
}
