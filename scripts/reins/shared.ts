/**
 * Shared constants, path layout, validated manifests, SemVer comparison, and rotating log writer for the Reins distribution runtime.
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createReadStream } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'

/** Default GitHub repository hosting public Reins releases. */
export const DEFAULT_GITHUB_REPO = 'dqrcsc/deepseek-harness'

/** Default loopback host bound by the background Web daemon. */
export const DEFAULT_REINS_HOST = '127.0.0.1'

/** Default loopback port bound by the background Web daemon (distinct from source mode's 3080). */
export const DEFAULT_REINS_PORT = 3180

/** Maximum bytes per rotating daemon log file before rolling to `.1` (10 MiB). */
export const DEFAULT_MAX_LOG_BYTES = 10 * 1024 * 1024

/** Optional command aliases mapping to the custom brand presets. */
export const SUPPORTED_ALIASES = ['loom', 'lumen'] as const

/** Optional brand alias command name. */
export type BrandAliasName = (typeof SUPPORTED_ALIASES)[number]

/** Supported CLI command entry names (`reins` primary plus optional brand aliases). */
export type BrandCommandName = 'reins' | BrandAliasName

/** Release target triples published to GitHub Releases. */
export const RELEASE_TARGETS = ['darwin-arm64', 'darwin-x64', 'win32-x64'] as const

/** Supported prebuilt release target triple. */
export type ReleaseTarget = (typeof RELEASE_TARGETS)[number]

/** Display strings for the active CLI brand persona. */
export interface BrandIdentity {
  /** Canonical CLI command name (`reins`, `loom`, or `lumen`). */
  readonly command: BrandCommandName
  /** Bilingual brand title matching the Web UI preset. */
  readonly displayName: string
  /** English brand title for compact ASCII contexts. */
  readonly englishName: string
  /** Brand motto matching the Web UI Hero preset. */
  readonly motto: string
}

const BRAND_IDENTITIES: Readonly<Record<BrandCommandName, BrandIdentity>> = {
  reins: {
    command: 'reins',
    displayName: '执辔 Reins',
    englishName: 'Reins',
    motto: '执辔在手，算力随心驰骋',
  },
  loom: {
    command: 'loom',
    displayName: '灵枢 Loom',
    englishName: 'Loom',
    motto: '经纬既定，万象皆可编织',
  },
  lumen: {
    command: 'lumen',
    displayName: '澄明 Lumen',
    englishName: 'Lumen',
    motto: '心境澄明，繁杂皆有解法',
  },
}

/**
 * Resolve the brand persona from the invoked executable or shim basename.
 * @param invokedAs - Raw argv command name or file path.
 * @returns Matching brand identity, defaulting to `reins`.
 */
export function resolveBrandIdentity(invokedAs: string | undefined): BrandIdentity {
  if (invokedAs === undefined || invokedAs.trim() === '') return BRAND_IDENTITIES.reins
  const leaf = invokedAs.trim().split(/[/\\]+/u).pop() ?? ''
  const stem = leaf.replace(/\.(?:cmd|bat|exe|ps1|sh|mjs|js)$/iu, '').toLowerCase()
  if (stem === 'loom') return BRAND_IDENTITIES.loom
  if (stem === 'lumen') return BRAND_IDENTITIES.lumen
  return BRAND_IDENTITIES.reins
}

/**
 * Check whether a string names a supported optional brand alias (`loom` or `lumen`).
 * @param value - Candidate alias name.
 * @returns True when `value` is a supported brand alias.
 */
export function isBrandAliasName(value: string): value is BrandAliasName {
  return value === 'loom' || value === 'lumen'
}

/**
 * Check whether a string names a supported release target triple.
 * @param value - Candidate target string.
 * @returns True when `value` is `darwin-arm64`, `darwin-x64`, or `win32-x64`.
 */
export function isReleaseTarget(value: string): value is ReleaseTarget {
  return (RELEASE_TARGETS as readonly string[]).includes(value)
}

/**
 * Resolve the release target triple for a platform and CPU architecture.
 * @param platform - Node platform identifier.
 * @param arch - Node CPU architecture identifier.
 * @returns Matching release target triple.
 */
export function resolveHostReleaseTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ReleaseTarget {
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64'
  if (platform === 'darwin' && arch === 'x64') return 'darwin-x64'
  if (platform === 'win32' && arch === 'x64') return 'win32-x64'
  throw new Error(`Unsupported Reins platform/arch ${platform}-${arch}; supported targets: ${RELEASE_TARGETS.join(', ')}`)
}

/** Complete filesystem layout under one Reins installation root. */
export interface ReinsPaths {
  /** Installation root (`~/.reins` on macOS, `%LOCALAPPDATA%\Reins` on Windows). */
  readonly rootDir: string
  /** Plain-text file holding the active version directory name (for example `v1.0.0`). */
  readonly currentFile: string
  /** JSON host configuration file (`port`, `host`, `mirror`, `enabledAliases`). */
  readonly configFile: string
  /** User-PATH command directory holding `reins`, `loom`, and `lumen` shims. */
  readonly binDir: string
  /** Immutable versioned slots directory (`releases/<version>/`). */
  readonly releasesDir: string
  /** Runtime state directory (`0700` on POSIX) holding PID/status, URL token, and logs. */
  readonly runDir: string
  /** Persistent user data directory passed as `DSH_HOME` exclusively to the daemon child. */
  readonly dataDir: string
  /** Single-instance supervisor lock file inside `runDir`. */
  readonly supervisorLockFile: string
  /** Stop-request control signal file inside `runDir`. */
  readonly stopSignalFile: string
  /** JSON daemon state record inside `runDir`. */
  readonly statusFile: string
  /** Mode-0600 file holding the current process launch URL with `?token=...`. */
  readonly webUrlFile: string
  /** Rotating daemon stdout/stderr log file inside `runDir`. */
  readonly daemonLogFile: string
}

/**
 * Resolve all filesystem paths for a Reins installation without mutating disk.
 * @param explicitRoot - Optional installation root override.
 * @param env - Environment mapping checked for `REINS_HOME` and `LOCALAPPDATA`.
 * @param platform - Target OS platform determining the default root location.
 * @returns Normalized absolute paths for the installation.
 */
export function resolveReinsPaths(
  explicitRoot?: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ReinsPaths {
  const envRoot = env.REINS_HOME?.trim()
  let baseRoot: string
  if (explicitRoot !== undefined && explicitRoot.trim() !== '') {
    baseRoot = explicitRoot.trim()
  } else if (envRoot !== undefined && envRoot !== '') {
    baseRoot = envRoot
  } else if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA?.trim()
    baseRoot = localAppData !== undefined && localAppData !== ''
      ? join(localAppData, 'Reins')
      : join(homedir(), 'AppData', 'Local', 'Reins')
  } else {
    baseRoot = join(homedir(), '.reins')
  }
  const rootDir = resolve(baseRoot)
  const runDir = join(rootDir, 'run')
  return {
    rootDir,
    currentFile: join(rootDir, 'current'),
    configFile: join(rootDir, 'config.json'),
    binDir: join(rootDir, 'bin'),
    releasesDir: join(rootDir, 'releases'),
    runDir,
    dataDir: join(rootDir, 'data'),
    supervisorLockFile: join(runDir, 'supervisor.lock'),
    stopSignalFile: join(runDir, 'stop.signal'),
    statusFile: join(runDir, 'status.json'),
    webUrlFile: join(runDir, 'web-url.txt'),
    daemonLogFile: join(runDir, 'daemon.log'),
  }
}

/** Slot-internal paths for one unpacked version under `releases/<version>/`. */
export interface ReleaseSlotPaths {
  /** Root directory of the version slot (`releases/<version>`). */
  readonly slotDir: string
  /** Release build metadata file (`release.json`). */
  readonly releaseManifestFile: string
  /** Bundled standalone Node 24 executable (`node/bin/node` or `node/bin/node.exe`). */
  readonly nodeExecutable: string
  /** Deployed `@deepseek-ai/dsh` launcher (`app/lib/bin.js`). */
  readonly dshBinScript: string
  /** Bundled CLI entrypoint (`supervisor/cli.mjs`). */
  readonly cliScript: string
  /** Bundled background supervisor entrypoint (`supervisor/supervisor.mjs`). */
  readonly supervisorScript: string
}

/**
 * Resolve the executable and metadata paths within one unpacked release slot.
 * @param releasesDir - Parent `releases/` directory.
 * @param version - Normalized version directory name (such as `v1.0.0`).
 * @param platform - Target OS platform selecting `node` vs `node.exe`.
 * @returns Absolute paths inside the version slot.
 */
export function resolveReleaseSlotPaths(
  releasesDir: string,
  version: string,
  platform: NodeJS.Platform = process.platform,
): ReleaseSlotPaths {
  const slotDir = join(releasesDir, version)
  const nodeBinaryName = platform === 'win32' ? 'node.exe' : 'node'
  return {
    slotDir,
    releaseManifestFile: join(slotDir, 'release.json'),
    nodeExecutable: join(slotDir, 'node', 'bin', nodeBinaryName),
    dshBinScript: join(slotDir, 'app', 'lib', 'bin.js'),
    cliScript: join(slotDir, 'supervisor', 'cli.mjs'),
    supervisorScript: join(slotDir, 'supervisor', 'supervisor.mjs'),
  }
}

/** User-editable host configuration persisted in `config.json`. */
export interface ReinsConfig {
  /** Loopback port bound by `dsh --profile web`. */
  readonly port: number
  /** Bind address passed to `--host` (defaults to `127.0.0.1`). */
  readonly host: string
  /** Optional mirror base prefix prepended to GitHub Release URLs. */
  readonly mirror?: string | undefined
  /** Enabled optional brand command aliases (`loom`, `lumen`). */
  readonly enabledAliases: readonly BrandAliasName[]
  /** GitHub repository slug (`owner/repo`) supplying release updates. */
  readonly repo: string
}

/**
 * Check whether an arbitrary JSON value is a non-array object record.
 * @param value - Parsed JSON value.
 * @returns True when `value` is a plain object record.
 */
export function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate a TCP port integer in the non-privileged user range `1024..65535`.
 * @param port - Candidate port number.
 * @returns Validated port integer.
 */
export function validatePort(port: number): number {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`Port must be an integer between 1024 and 65535; received ${String(port)}`)
  }
  return port
}

/**
 * Atomically write UTF-8 text to `filePath` via a sibling temporary file.
 * @param filePath - Destination file path.
 * @param content - UTF-8 text content.
 * @param mode - Optional POSIX file mode (such as `0o600`).
 */
export function atomicWriteText(filePath: string, content: string, mode?: number): void {
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true })
  const tempPath = join(dir, `.${basename(filePath)}.${randomUUID()}.tmp`)
  try {
    writeFileSync(tempPath, content, mode !== undefined ? { encoding: 'utf8', mode } : { encoding: 'utf8' })
    if (mode !== undefined && process.platform !== 'win32') {
      chmodSync(tempPath, mode)
    }
    renameSync(tempPath, filePath)
  } finally {
    rmSync(tempPath, { force: true })
  }
}

/**
 * Read `config.json`, returning defaults when absent.
 * @param configFile - Path to `config.json`.
 * @returns Validated host configuration.
 */
export function readReinsConfig(configFile: string): ReinsConfig {
  if (!existsSync(configFile)) {
    return {
      port: DEFAULT_REINS_PORT,
      host: DEFAULT_REINS_HOST,
      enabledAliases: [...SUPPORTED_ALIASES],
      repo: DEFAULT_GITHUB_REPO,
    }
  }
  const parsed: unknown = JSON.parse(readFileSync(configFile, 'utf8'))
  if (!isJsonRecord(parsed)) throw new Error(`Invalid Reins config file at ${configFile}: expected JSON object`)
  const port = parsed.port === undefined ? DEFAULT_REINS_PORT : validatePort(Number(parsed.port))
  const host = typeof parsed.host === 'string' && parsed.host.trim() !== '' ? parsed.host.trim() : DEFAULT_REINS_HOST
  const mirror = typeof parsed.mirror === 'string' && parsed.mirror.trim() !== ''
    ? parsed.mirror.trim().replace(/\/+$/u, '')
    : undefined
  const repo = typeof parsed.repo === 'string' && parsed.repo.trim() !== ''
    ? parsed.repo.trim()
    : DEFAULT_GITHUB_REPO
  let enabledAliases: BrandAliasName[] = [...SUPPORTED_ALIASES]
  if (Array.isArray(parsed.enabledAliases)) {
    enabledAliases = parsed.enabledAliases.filter((item): item is BrandAliasName =>
      typeof item === 'string' && isBrandAliasName(item))
  }
  return {
    port,
    host,
    ...(mirror !== undefined ? { mirror } : {}),
    enabledAliases,
    repo,
  }
}

/**
 * Persist validated `ReinsConfig` to `config.json`.
 * @param configFile - Path to `config.json`.
 * @param config - Configuration fields to write.
 */
export function writeReinsConfig(configFile: string, config: ReinsConfig): void {
  validatePort(config.port)
  const payload: Record<string, unknown> = {
    port: config.port,
    host: config.host,
    ...(config.mirror !== undefined && config.mirror !== '' ? { mirror: config.mirror.replace(/\/+$/u, '') } : {}),
    enabledAliases: [...new Set(config.enabledAliases)],
    repo: config.repo,
  }
  atomicWriteText(configFile, `${JSON.stringify(payload, null, 2)}\n`)
}

/**
 * Read the active version slot name from `current`, or `undefined` when absent.
 * @param currentFile - Path to the `current` pointer file.
 * @returns Normalized version directory name, or `undefined`.
 */
export function readCurrentVersion(currentFile: string): string | undefined {
  if (!existsSync(currentFile)) return undefined
  const value = readFileSync(currentFile, 'utf8').trim()
  return value === '' ? undefined : value
}

/**
 * Atomically update the active version pointer file `current`.
 * @param currentFile - Path to the `current` pointer file.
 * @param version - Target version directory name (such as `v1.1.0`).
 */
export function writeCurrentVersion(currentFile: string, version: string): void {
  const normalized = normalizeVersionTag(version)
  atomicWriteText(currentFile, `${normalized}\n`)
}

/**
 * Normalize a version string or `reins-v*` Git tag to `v<major>.<minor>.<patch>[-prerelease]`.
 * @param raw - Raw version or Git tag (for example `reins-v1.2.0`, `v1.2.0`, or `1.2.0`).
 * @returns Canonical `v`-prefixed version string.
 */
export function normalizeVersionTag(raw: string): string {
  const trimmed = raw.trim().replace(/^reins-/iu, '')
  const withoutV = trimmed.startsWith('v') || trimmed.startsWith('V') ? trimmed.slice(1) : trimmed
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(withoutV)) {
    throw new Error(`Invalid edition version ${JSON.stringify(raw)}; expected semver such as v1.0.0 or reins-v1.0.0`)
  }
  return `v${withoutV}`
}

interface ParsedSemver {
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly prerelease: readonly string[]
}

function parseSemverParts(raw: string): ParsedSemver {
  const normalized = normalizeVersionTag(raw).slice(1)
  const hyphenIndex = normalized.indexOf('-')
  const core = hyphenIndex >= 0 ? normalized.slice(0, hyphenIndex) : normalized
  const prerelease = hyphenIndex >= 0 ? normalized.slice(hyphenIndex + 1).split('.') : []
  const parts = core.split('.').map(part => Number.parseInt(part, 10))
  return {
    major: parts[0] ?? 0,
    minor: parts[1] ?? 0,
    patch: parts[2] ?? 0,
    prerelease,
  }
}

/**
 * Compare two SemVer edition versions (`-1` when `left < right`, `0` when equal, `1` when `left > right`).
 * @param left - First version string.
 * @param right - Second version string.
 * @returns `-1`, `0`, or `1`.
 */
export function compareVersions(left: string, right: string): -1 | 0 | 1 {
  const a = parseSemverParts(left)
  const b = parseSemverParts(right)
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  const len = Math.max(a.prerelease.length, b.prerelease.length)
  for (let i = 0; i < len; i += 1) {
    const leftId = a.prerelease[i]
    const rightId = b.prerelease[i]
    if (leftId === undefined) return -1
    if (rightId === undefined) return 1
    if (leftId === rightId) continue
    const leftNumeric = /^\d+$/u.test(leftId)
    const rightNumeric = /^\d+$/u.test(rightId)
    if (leftNumeric && rightNumeric) {
      return Number.parseInt(leftId, 10) < Number.parseInt(rightId, 10) ? -1 : 1
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftId < rightId ? -1 : 1
  }
  return 0
}

/** Build metadata written to `<slot>/release.json`. */
export interface ReleaseManifest {
  /** Schema version (`1`). */
  readonly schemaVersion: 1
  /** Canonical `v`-prefixed Reins edition version (for example `v1.0.0`). */
  readonly editionVersion: string
  /** Upstream DSH core version from root `package.json`. */
  readonly dshCoreVersion: string
  /** Short Git commit hash built into this slot. */
  readonly commit: string
  /** Bundled Node.js version string. */
  readonly nodeVersion: string
  /** Target platform-arch triple (`darwin-arm64`, `darwin-x64`, or `win32-x64`). */
  readonly target: ReleaseTarget
  /** ISO-8601 build timestamp. */
  readonly builtAt: string
  /** Source GitHub repository slug (`owner/repo`). */
  readonly repo: string
}

/**
 * Parse and validate a `release.json` manifest payload.
 * @param value - Parsed JSON input.
 * @returns Validated `ReleaseManifest`.
 */
export function parseReleaseManifest(value: unknown): ReleaseManifest {
  if (!isJsonRecord(value) || value.schemaVersion !== 1) {
    throw new Error('Invalid release.json: expected schemaVersion 1')
  }
  const { editionVersion, dshCoreVersion, commit, nodeVersion, target, builtAt, repo } = value
  if (
    typeof editionVersion !== 'string'
    || typeof dshCoreVersion !== 'string'
    || typeof commit !== 'string'
    || typeof nodeVersion !== 'string'
    || typeof target !== 'string'
    || !isReleaseTarget(target)
    || typeof builtAt !== 'string'
    || typeof repo !== 'string'
  ) {
    throw new Error('Invalid release.json: missing required string fields or unsupported target')
  }
  return {
    schemaVersion: 1,
    editionVersion: normalizeVersionTag(editionVersion),
    dshCoreVersion,
    commit,
    nodeVersion,
    target,
    builtAt,
    repo,
  }
}

/** Single platform archive descriptor inside `latest.json`. */
export interface ReleaseAssetDescriptor {
  /** Archive filename attached to the GitHub Release. */
  readonly file: string
  /** Lowercase hexadecimal SHA-256 digest of the archive bytes. */
  readonly sha256: string
  /** Archive size in bytes. */
  readonly bytes: number
}

/** Public release index `latest.json` uploaded to GitHub Releases for API-free update checks. */
export interface LatestReleaseManifest {
  /** Schema version (`1`). */
  readonly schemaVersion: 1
  /** Canonical `v`-prefixed edition version (such as `v1.1.0`). */
  readonly editionVersion: string
  /** Git tag carrying the release assets (such as `reins-v1.1.0`). */
  readonly tag: string
  /** Upstream DSH core version bundled in this release. */
  readonly dshCoreVersion: string
  /** Short Git commit hash. */
  readonly commit: string
  /** ISO-8601 publication timestamp. */
  readonly publishedAt: string
  /** Per-target archive descriptors. */
  readonly assets: Partial<Record<ReleaseTarget, ReleaseAssetDescriptor>>
}

/**
 * Parse and validate a `latest.json` manifest fetched during installation or upgrade.
 * @param value - Parsed JSON value.
 * @returns Validated `LatestReleaseManifest`.
 */
export function parseLatestReleaseManifest(value: unknown): LatestReleaseManifest {
  if (!isJsonRecord(value) || value.schemaVersion !== 1) {
    throw new Error('Invalid latest.json: expected schemaVersion 1')
  }
  const { editionVersion, tag, dshCoreVersion, commit, publishedAt, assets } = value
  if (
    typeof editionVersion !== 'string'
    || typeof tag !== 'string'
    || typeof dshCoreVersion !== 'string'
    || typeof commit !== 'string'
    || typeof publishedAt !== 'string'
    || !isJsonRecord(assets)
  ) {
    throw new Error('Invalid latest.json: missing required metadata fields')
  }
  const parsedAssets: Partial<Record<ReleaseTarget, ReleaseAssetDescriptor>> = {}
  for (const [key, rawAsset] of Object.entries(assets)) {
    if (!isReleaseTarget(key) || !isJsonRecord(rawAsset)) continue
    const { file, sha256, bytes } = rawAsset
    if (
      typeof file === 'string' && file !== ''
      && typeof sha256 === 'string' && /^[0-9a-f]{64}$/iu.test(sha256)
      && typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0
    ) {
      parsedAssets[key] = { file, sha256: sha256.toLowerCase(), bytes }
    }
  }
  return {
    schemaVersion: 1,
    editionVersion: normalizeVersionTag(editionVersion),
    tag,
    dshCoreVersion,
    commit,
    publishedAt,
    assets: parsedAssets,
  }
}

/** Observable lifecycle states written to `run/status.json` by the supervisor. */
export type DaemonLifecycleState = 'starting' | 'running' | 'stopped' | 'port-conflict' | 'failed'

/** Daemon state snapshot persisted in `run/status.json`. */
export interface DaemonStatus {
  /** Lifecycle state of the background daemon. */
  readonly state: DaemonLifecycleState
  /** Supervisor OS process ID. */
  readonly pid: number
  /** Child `dsh --profile web` OS process ID when running. */
  readonly childPid?: number | undefined
  /** Bound loopback host. */
  readonly host: string
  /** Bound loopback port. */
  readonly port: number
  /** Active slot version (`v1.0.0`). */
  readonly version: string
  /** Clean origin URL without credentials (`http://127.0.0.1:3180/`). */
  readonly baseUrl: string
  /** ISO-8601 timestamp when this supervisor started. */
  readonly startedAt: string
  /** ISO-8601 timestamp of the latest status update. */
  readonly updatedAt: string
  /** Actionable failure or port-conflict diagnostic when `state` is `port-conflict` or `failed`. */
  readonly error?: string | undefined
}

/**
 * Read `run/status.json` if present and syntactically valid.
 * @param statusFile - Path to `run/status.json`.
 * @returns Parsed `DaemonStatus`, or `undefined` when missing or unreadable.
 */
export function readDaemonStatus(statusFile: string): DaemonStatus | undefined {
  if (!existsSync(statusFile)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(statusFile, 'utf8'))
  } catch (error) {
    // Concurrent writes or truncated crashes yield undefined so callers treat status as absent.
    void error
    return undefined
  }
  if (!isJsonRecord(parsed)) return undefined
  const { state, pid, childPid, host, port, version, baseUrl, startedAt, updatedAt, error } = parsed
  if (
    (state !== 'starting' && state !== 'running' && state !== 'stopped' && state !== 'port-conflict' && state !== 'failed')
    || typeof pid !== 'number'
    || typeof host !== 'string'
    || typeof port !== 'number'
    || typeof version !== 'string'
    || typeof baseUrl !== 'string'
    || typeof startedAt !== 'string'
    || typeof updatedAt !== 'string'
  ) {
    return undefined
  }
  return {
    state,
    pid,
    ...(typeof childPid === 'number' ? { childPid } : {}),
    host,
    port,
    version,
    baseUrl,
    startedAt,
    updatedAt,
    ...(typeof error === 'string' ? { error } : {}),
  }
}

/**
 * Persist `DaemonStatus` atomically with user-only `0o600` permissions on POSIX.
 * @param statusFile - Path to `run/status.json`.
 * @param status - Status record to write.
 */
export function writeDaemonStatus(statusFile: string, status: DaemonStatus): void {
  atomicWriteText(statusFile, `${JSON.stringify(status, null, 2)}\n`, 0o600)
}

/**
 * Probe whether an OS process ID currently exists.
 * @param pid - Process ID to test.
 * @returns True when the process is alive (`kill(pid, 0)` succeeds or reports `EPERM`).
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Compute the lowercase hexadecimal SHA-256 digest of a file via streaming reads.
 * @param filePath - Path of the file to hash.
 * @returns 64-character lowercase SHA-256 hex digest.
 */
export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(filePath), hash)
  return hash.digest('hex')
}

/**
 * Extract the authenticated startup URL from a `dsh web:` console line.
 * @param line - Single stdout line emitted by `dsh --profile web`.
 * @returns Trimmed HTTP(S) launch URL when matched, otherwise `undefined`.
 */
export function extractWebLaunchUrl(line: string): string | undefined {
  const match = /^\s*dsh web:\s*(https?:\/\/\S+)\s*$/u.exec(line)
  return match?.[1]
}

/** Size-bounded log writer that rolls `daemon.log` to `daemon.log.1` at `maxBytes`. */
export class RotatingLogWriter {
  private currentBytes: number

  /**
   * Create a rotating log writer targeting `logFile`.
   * @param logFile - Primary log file path (`run/daemon.log`).
   * @param maxBytes - Byte threshold triggering rotation to `<logFile>.1`.
   */
  constructor(
    private readonly logFile: string,
    private readonly maxBytes: number = DEFAULT_MAX_LOG_BYTES,
  ) {
    mkdirSync(dirname(logFile), { recursive: true })
    this.currentBytes = existsSync(logFile) ? statSync(logFile).size : 0
  }

  /**
   * Append a log line (automatically newline-terminated) and rotate if needed.
   * @param line - Text line to write.
   */
  writeLine(line: string): void {
    const formatted = line.endsWith('\n') ? line : `${line}\n`
    const byteLength = Buffer.byteLength(formatted, 'utf8')
    if (this.currentBytes > 0 && this.currentBytes + byteLength > this.maxBytes) {
      this.rotate()
    }
    appendFileSync(this.logFile, formatted, { encoding: 'utf8', mode: 0o600 })
    this.currentBytes += byteLength
  }

  private rotate(): void {
    const backup = `${this.logFile}.1`
    rmSync(backup, { force: true })
    if (existsSync(this.logFile)) {
      renameSync(this.logFile, backup)
    }
    this.currentBytes = 0
  }
}
