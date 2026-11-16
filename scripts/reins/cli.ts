/**
 * User-facing CLI (`reins` / `loom` / `lumen`) managing on-demand background daemon lifecycle,
 * browser launch, logs, GitHub upgrades, aliases, diagnostics, and uninstallation.
 */

import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, closeSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import {
  DEFAULT_GITHUB_REPO,
  SUPPORTED_ALIASES,
  atomicWriteText,
  isBrandAliasName,
  isExecutedAsMain,
  isProcessAlive,
  probePortAvailable,
  readCurrentVersion,
  readDaemonStatus,
  readReinsConfig,
  resolveBrandIdentity,
  resolveHostReleaseTarget,
  resolveReinsPaths,
  resolveReleaseSlotPaths,
  validatePort,
  writeDaemonStatus,
  writeReinsConfig,
  type BrandAliasName,
  type BrandIdentity,
  type DaemonStatus,
  type ReinsConfig,
  type ReinsPaths,
} from './shared.ts'
import {
  createWindowsShortcuts,
  detectExternalCommandConflict,
  removePosixShellPath,
  removeWindowsShortcuts,
  removeWindowsUserPath,
  syncCommandShims,
  upsertPosixShellPath,
  upsertWindowsUserPath,
} from './shims.ts'
import {
  DEFAULT_UPGRADE_HEALTH_TIMEOUT_MS,
  fetchReleaseManifest,
  listInstalledVersions,
  performRollback,
  performUpgrade,
  readSlotReleaseManifest,
  type DaemonTransactionHooks,
  type FetchLike,
} from './upgrader.ts'

const DAEMON_STOP_TIMEOUT_MS = 6_000
const DAEMON_START_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 120

/** Injectable I/O and environment hooks for `runReinsCli`. */
export interface CliExecutionContext {
  /** Environment variables (defaults to `process.env`). */
  readonly env?: NodeJS.ProcessEnv | undefined
  /** OS platform override for cross-platform unit tests. */
  readonly platform?: NodeJS.Platform | undefined
  /** User home directory override for shell-profile tests. */
  readonly userHome?: string | undefined
  /** Standard output line sink. */
  readonly stdout?: ((text: string) => void) | undefined
  /** Standard error line sink. */
  readonly stderr?: ((text: string) => void) | undefined
  /** Browser opener override (receives target URL). */
  readonly openBrowser?: ((url: string) => void) | undefined
  /** Network fetch override for `upgrade` / `doctor` tests. */
  readonly fetchImpl?: FetchLike | undefined
  /** Override Node executable used when spawning the background supervisor in tests. */
  readonly supervisorNodeOverride?: string | undefined
  /** Override supervisor script path used when spawning the background supervisor in tests. */
  readonly supervisorScriptOverride?: string | undefined
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms))
}

/**
 * Inspect whether the background supervisor for `paths` is currently alive.
 * @param paths - Resolved installation paths.
 * @returns Active `DaemonStatus` when the supervisor PID is alive, otherwise `undefined`.
 */
export function getLiveDaemonStatus(paths: ReinsPaths): DaemonStatus | undefined {
  const status = readDaemonStatus(paths.statusFile)
  if (status === undefined) return undefined
  if (status.state === 'stopped' || status.state === 'failed' || status.state === 'port-conflict') {
    return undefined
  }
  return isProcessAlive(status.pid) ? status : undefined
}

/**
 * Read the best available browser URL (`run/web-url.txt` with `?token=`, falling back to `baseUrl`).
 * @param paths - Resolved installation paths.
 * @param config - Active host configuration.
 * @returns Authenticated or origin URL string.
 */
export function resolveLaunchUrl(paths: ReinsPaths, config: ReinsConfig): string {
  if (existsSync(paths.webUrlFile)) {
    const url = readFileSync(paths.webUrlFile, 'utf8').trim()
    if (url !== '') return url
  }
  const live = getLiveDaemonStatus(paths)
  if (live !== undefined) return live.baseUrl
  return `http://${config.host}:${String(config.port)}/`
}

/**
 * Open an HTTP(S) URL in the user's default browser without invoking a command shell or flashing a console window.
 * @param url - Destination URL.
 * @param platform - Active OS platform.
 */
export function openBrowserUrl(url: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') {
    const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    })
    child.on('error', () => {})
    child.unref()
    return
  }
  const opener = platform === 'darwin' ? 'open' : 'xdg-open'
  const child = spawn(opener, [url], {
    detached: true,
    stdio: 'ignore',
  })
  child.on('error', () => {})
  child.unref()
}

/**
 * Spawn the detached background supervisor process and wait until `run/web-url.txt` is ready.
 * @param paths - Resolved installation paths.
 * @param options - Optional timeout and test executable overrides.
 * @returns Launch URL with token once healthy.
 */
export async function startDaemonAndWait(
  paths: ReinsPaths,
  options: {
    readonly timeoutMs?: number
    readonly platform?: NodeJS.Platform
    readonly nodeOverride?: string
    readonly supervisorScriptOverride?: string
  } = {},
): Promise<string> {
  const platform = options.platform ?? process.platform
  const timeoutMs = options.timeoutMs ?? DAEMON_START_TIMEOUT_MS
  const existing = getLiveDaemonStatus(paths)
  if (existing !== undefined && existing.state === 'running') {
    const config = readReinsConfig(paths.configFile)
    return resolveLaunchUrl(paths, config)
  }

  const version = readCurrentVersion(paths.currentFile)
  if (version === undefined) {
    throw new Error(`Active version pointer is missing at ${paths.currentFile}; re-run the installer.`)
  }
  const slot = resolveReleaseSlotPaths(paths.releasesDir, version, platform)
  const nodeExe = options.nodeOverride ?? slot.nodeExecutable
  const supervisorScript = options.supervisorScriptOverride ?? slot.supervisorScript
  if (!existsSync(nodeExe)) {
    throw new Error(`Bundled Node runtime is missing at ${nodeExe}`)
  }
  if (!existsSync(supervisorScript)) {
    throw new Error(`Supervisor bundle is missing at ${supervisorScript}`)
  }

  mkdirSync(paths.runDir, { recursive: true, mode: 0o700 })
  rmSync(paths.stopSignalFile, { force: true })

  const startedBeforeMs = Date.now()
  if (existing === undefined) {
    const child = spawn(nodeExe, [supervisorScript, '--root', paths.rootDir, '--version', version], {
      cwd: existsSync(homedir()) ? homedir() : paths.rootDir,
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    })
    child.unref()
  }

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const status = readDaemonStatus(paths.statusFile)
    if (status !== undefined && Date.parse(status.updatedAt) >= startedBeforeMs - 1_000) {
      if (status.state === 'port-conflict' || status.state === 'failed') {
        throw new Error(status.error ?? `Background daemon failed (${status.state}); inspect ${paths.daemonLogFile}`)
      }
      if (status.state === 'running' && isProcessAlive(status.pid) && existsSync(paths.webUrlFile)) {
        const launchUrl = readFileSync(paths.webUrlFile, 'utf8').trim()
        if (launchUrl !== '') return launchUrl
      }
    }
    await sleep(POLL_INTERVAL_MS)
  }

  throw new Error(
    `Timed out after ${String(Math.round(timeoutMs / 1000))}s waiting for Web service readiness; inspect ${paths.daemonLogFile}`,
  )
}

/**
 * Gracefully stop the running background supervisor and wait for its OS processes to exit.
 * @param paths - Resolved installation paths.
 * @param platform - Active OS platform.
 * @returns True when a running daemon was stopped, false when already stopped.
 */
export async function stopDaemonGracefully(
  paths: ReinsPaths,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  const status = readDaemonStatus(paths.statusFile)
  const supervisorPid = status?.pid
  const childPid = status?.childPid
  const wasAlive = supervisorPid !== undefined && isProcessAlive(supervisorPid)

  mkdirSync(paths.runDir, { recursive: true, mode: 0o700 })
  atomicWriteText(paths.stopSignalFile, `${new Date().toISOString()}\n`, 0o600)

  if (wasAlive && platform !== 'win32') {
    try {
      process.kill(supervisorPid, 'SIGTERM')
    } catch (error) {
      // Supervisor exited between liveness probe and SIGTERM delivery.
      void error
    }
  }

  if (wasAlive) {
    const deadline = Date.now() + DAEMON_STOP_TIMEOUT_MS
    while (Date.now() < deadline) {
      const supAlive = isProcessAlive(supervisorPid)
      const webAlive = childPid !== undefined && isProcessAlive(childPid)
      if (!supAlive && !webAlive) break
      await sleep(POLL_INTERVAL_MS)
    }

    for (const pid of [childPid, supervisorPid]) {
      if (pid === undefined || !isProcessAlive(pid)) continue
      if (platform === 'win32') {
        spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        })
      } else {
        try {
          process.kill(pid, 'SIGKILL')
        } catch (error) {
          // Process exited just before SIGKILL escalation.
          void error
        }
      }
    }
  }

  rmSync(paths.webUrlFile, { force: true })
  rmSync(paths.stopSignalFile, { force: true })
  rmSync(paths.supervisorLockFile, { force: true })
  if (status !== undefined && status.state !== 'stopped') {
    writeDaemonStatus(paths.statusFile, {
      ...status,
      state: 'stopped',
      updatedAt: new Date().toISOString(),
    })
  }
  return wasAlive
}

function formatDuration(startedAtIso: string): string {
  const elapsedSec = Math.max(0, Math.floor((Date.now() - Date.parse(startedAtIso)) / 1000))
  if (!Number.isFinite(elapsedSec)) return 'unknown'
  const hours = Math.floor(elapsedSec / 3600)
  const minutes = Math.floor((elapsedSec % 3600) / 60)
  const seconds = elapsedSec % 60
  if (hours > 0) return `${String(hours)}h ${String(minutes)}m ${String(seconds)}s`
  if (minutes > 0) return `${String(minutes)}m ${String(seconds)}s`
  return `${String(seconds)}s`
}

function readTailLines(logFile: string, count: number): string[] {
  const collected: string[] = []
  const rotated = `${logFile}.1`
  if (existsSync(rotated)) {
    collected.push(...readFileSync(rotated, 'utf8').split(/\r?\n/u).filter(line => line !== ''))
  }
  if (existsSync(logFile)) {
    collected.push(...readFileSync(logFile, 'utf8').split(/\r?\n/u).filter(line => line !== ''))
  }
  return collected.slice(-Math.max(1, count))
}

async function followLogFile(logFile: string, writeOut: (text: string) => void): Promise<void> {
  let offset = existsSync(logFile) ? statSync(logFile).size : 0
  let active = true
  const stopFollow = (): void => { active = false }
  process.once('SIGINT', stopFollow)
  process.once('SIGTERM', stopFollow)
  try {
    while (active) {
      if (existsSync(logFile)) {
        const size = statSync(logFile).size
        if (size < offset) offset = 0
        if (size > offset) {
          const length = size - offset
          const buffer = Buffer.alloc(length)
          const fd = openSync(logFile, 'r')
          try {
            const bytesRead = readSync(fd, buffer, 0, length, offset)
            offset += bytesRead
            writeOut(buffer.subarray(0, bytesRead).toString('utf8'))
          } finally {
            closeSync(fd)
          }
        }
      }
      await sleep(250)
    }
  } finally {
    process.off('SIGINT', stopFollow)
    process.off('SIGTERM', stopFollow)
  }
}

function copySlotIconIfPresent(paths: ReinsPaths, version: string | undefined): string | undefined {
  if (version === undefined) return undefined
  const iconSource = join(paths.releasesDir, version, 'supervisor', 'reins.ico')
  if (!existsSync(iconSource)) return undefined
  mkdirSync(paths.binDir, { recursive: true })
  const iconTarget = join(paths.binDir, 'reins.ico')
  cpSync(iconSource, iconTarget)
  return iconTarget
}

function renderHelpText(brand: BrandIdentity, subcommand?: string): string {
  const cmd = brand.command
  if (subcommand === 'upgrade' || subcommand === 'update') {
    return [
      `${brand.displayName} — upgrade / update`,
      '',
      `用法 / Usage: ${cmd} upgrade [--check] [--version <tag>] [--force] [--mirror <url>]`,
      '',
      '选项 / Options:',
      '  --check            仅检查 GitHub Releases 是否有新版本，不下载安装',
      '  --version <ver>    指定安装特定版本（如 v1.1.0 或 reins-v1.1.0）',
      '  --force            即使当前已是该版本也重新下载校验并覆盖槽位',
      '  --mirror <url>     本次升级临时指定 GitHub Release 加速镜像前缀',
      '',
    ].join('\n')
  }
  if (subcommand === 'config') {
    return [
      `${brand.displayName} — config`,
      '',
      '用法 / Usage:',
      `  ${cmd} config list`,
      `  ${cmd} config get <port|host|mirror|repo>`,
      `  ${cmd} config set port <1024-65535>`,
      `  ${cmd} config set mirror <https://mirror.example.com | clear>`,
      '',
    ].join('\n')
  }
  return [
    `${brand.displayName}  ·  ${brand.motto}`,
    '',
    `用法 / Usage: ${cmd} [command] [options]`,
    '',
    '日常使用 / Quick Start:',
    `  ${cmd}                   按需在后台拉起服务并打开默认浏览器（等同于 ${cmd} open）`,
    `  ${cmd} open              确保后台服务运行并在默认浏览器打开工作台`,
    '',
    '后台服务控制 / Service Control:',
    `  ${cmd} start             仅在后台无黑框静默启动服务（不自动弹出浏览器）`,
    `  ${cmd} stop              优雅停止后台守护进程并释放监听端口`,
    `  ${cmd} restart           平滑重启后台守护进程（修改端口或配置后生效）`,
    `  ${cmd} status [--check]  查看运行状态、监听地址、PID、当前版本与数据目录`,
    `  ${cmd} logs [-f] [-n N]  查看后台运行日志（-f 实时追踪，默认最近 100 行）`,
    '',
    '版本同步与回滚 / GitHub Release Sync:',
    `  ${cmd} upgrade           从 GitHub Releases 拉取最新版本并无损热升级（别名 update）`,
    `  ${cmd} upgrade --check   仅检查远程是否有新版本`,
    `  ${cmd} rollback          秒级切回本地保留的上一版本槽位并重启`,
    '',
    '配置、品牌别名与维护 / Configuration & Maintenance:',
    `  ${cmd} config            查看或修改端口（port）与镜像源（mirror）`,
    `  ${cmd} alias             查看或开关同构品牌命令别名（loom / lumen）`,
    `  ${cmd} doctor            自检内置运行时、端口、数据隔离与更新源连通性`,
    `  ${cmd} version           查看定制版版本号、DSH 内核版本与构建 Commit`,
    `  ${cmd} uninstall         停止服务并清理程序与快捷方式（默认保留 data/ 会话数据）`,
    `  ${cmd} help [command]    显示帮助说明`,
    '',
  ].join('\n')
}

interface ParsedCliInvocation {
  readonly invokedAs: string | undefined
  readonly rootOverride: string | undefined
  readonly positionals: readonly string[]
  readonly flags: Readonly<Record<string, string | boolean>>
}

function parseCliInvocation(argv: readonly string[]): ParsedCliInvocation {
  let invokedAs: string | undefined
  let rootOverride: string | undefined
  const positionals: string[] = []
  const flags: Record<string, string | boolean> = {}

  const valueFlags = new Set(['--invoked-as', '--root', '--version', '--mirror', '-n', '--lines'])
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === undefined) continue
    if (token.startsWith('--') && token.includes('=')) {
      const eq = token.indexOf('=')
      const key = token.slice(0, eq)
      const val = token.slice(eq + 1)
      if (key === '--invoked-as') invokedAs = val
      else if (key === '--root') rootOverride = val
      else flags[key] = val
      continue
    }
    if (valueFlags.has(token)) {
      const next = argv[i + 1]
      if (next === undefined) {
        throw new Error(`Option ${token} requires a value`)
      }
      i += 1
      if (token === '--invoked-as') invokedAs = next
      else if (token === '--root') rootOverride = next
      else flags[token] = next
      continue
    }
    if (token.startsWith('-')) {
      flags[token] = true
      continue
    }
    positionals.push(token)
  }

  return { invokedAs, rootOverride, positionals, flags }
}

function createTransactionHooks(
  paths: ReinsPaths,
  platform: NodeJS.Platform,
  ctx: CliExecutionContext,
): DaemonTransactionHooks {
  return {
    isRunning: () => getLiveDaemonStatus(paths) !== undefined,
    stop: async () => {
      await stopDaemonGracefully(paths, platform)
    },
    startAndVerify: async (timeoutMs: number) => {
      await startDaemonAndWait(paths, {
        timeoutMs,
        platform,
        ...(ctx.supervisorNodeOverride !== undefined ? { nodeOverride: ctx.supervisorNodeOverride } : {}),
        ...(ctx.supervisorScriptOverride !== undefined ? { supervisorScriptOverride: ctx.supervisorScriptOverride } : {}),
      })
    },
    syncShims: () => {
      const config = readReinsConfig(paths.configFile)
      const activeVer = readCurrentVersion(paths.currentFile)
      copySlotIconIfPresent(paths, activeVer)
      syncCommandShims(paths, config, { env: ctx.env ?? process.env, platform })
    },
  }
}

function scheduleWindowsDelayedCleanup(targetDir: string): void {
  const escaped = targetDir.replace(/"/gu, '""')
  const child = spawn(
    'cmd.exe',
    ['/d', '/s', '/c', `ping 127.0.0.1 -n 3 > nul & rmdir /s /q "${escaped}"`],
    { detached: true, windowsHide: true, stdio: 'ignore' },
  )
  child.on('error', () => {})
  child.unref()
}

/**
 * Execute one Reins CLI invocation and return its process exit status code.
 * @param argv - Command-line arguments excluding `node` and `cli.mjs` (`process.argv.slice(2)`).
 * @param ctx - Injectable environment, I/O sinks, browser opener, and network hooks.
 * @returns Exit status (`0` on success, `1` on operational or validation error).
 */
export async function runReinsCli(
  argv: readonly string[],
  ctx: CliExecutionContext = {},
): Promise<number> {
  const env = ctx.env ?? process.env
  const platform = ctx.platform ?? process.platform
  const out = (line: string): void => {
    if (ctx.stdout !== undefined) ctx.stdout(`${line}\n`)
    else process.stdout.write(`${line}\n`)
  }
  const err = (line: string): void => {
    if (ctx.stderr !== undefined) ctx.stderr(`${line}\n`)
    else process.stderr.write(`${line}\n`)
  }
  const openBrowser = ctx.openBrowser ?? ((url: string): void => {
    openBrowserUrl(url, platform)
  })

  let parsed: ParsedCliInvocation
  try {
    parsed = parseCliInvocation(argv)
  } catch (parseError) {
    err(`reins: ${parseError instanceof Error ? parseError.message : String(parseError)}`)
    return 1
  }

  const brand = resolveBrandIdentity(parsed.invokedAs ?? process.argv[1])
  const paths = resolveReinsPaths(parsed.rootOverride, env, platform)

  if (parsed.flags['-h'] === true || parsed.flags['--help'] === true) {
    out(renderHelpText(brand, parsed.positionals[0]))
    return 0
  }
  if ((parsed.flags['-v'] === true || parsed.flags['--version'] === true) && parsed.positionals.length === 0) {
    return handleVersionCommand(paths, brand, platform, out)
  }

  const subcommand = (parsed.positionals[0] ?? 'open').toLowerCase()
  const subArgs = parsed.positionals.slice(1)

  try {
    switch (subcommand) {
      case 'open': {
        const wasRunning = getLiveDaemonStatus(paths)?.state === 'running'
        const url = await startDaemonAndWait(paths, {
          platform,
          ...(ctx.supervisorNodeOverride !== undefined ? { nodeOverride: ctx.supervisorNodeOverride } : {}),
          ...(ctx.supervisorScriptOverride !== undefined ? { supervisorScriptOverride: ctx.supervisorScriptOverride } : {}),
        })
        const config = readReinsConfig(paths.configFile)
        const browserUrl = resolveLaunchUrl(paths, config) || url
        if (parsed.flags['--no-open'] !== true && env.REINS_NO_OPEN !== '1') {
          openBrowser(browserUrl)
        }
        out(
          wasRunning
            ? `${brand.displayName} 已在后台运行，正在打开浏览器: http://${config.host}:${String(config.port)}/`
            : `${brand.displayName} 已在后台启动并常驻，正在打开浏览器: http://${config.host}:${String(config.port)}/`,
        )
        return 0
      }

      case 'start': {
        const live = getLiveDaemonStatus(paths)
        const config = readReinsConfig(paths.configFile)
        if (live?.state === 'running') {
          out(`${brand.displayName} 已在后台运行 (PID ${String(live.pid)}, 版本 ${live.version}) -> ${live.baseUrl}`)
          return 0
        }
        await startDaemonAndWait(paths, {
          platform,
          ...(ctx.supervisorNodeOverride !== undefined ? { nodeOverride: ctx.supervisorNodeOverride } : {}),
          ...(ctx.supervisorScriptOverride !== undefined ? { supervisorScriptOverride: ctx.supervisorScriptOverride } : {}),
        })
        const started = getLiveDaemonStatus(paths)
        out(
          `${brand.displayName} 后台服务已启动 (PID ${String(started?.pid ?? 'unknown')}, 版本 ${started?.version ?? readCurrentVersion(paths.currentFile) ?? 'unknown'}) -> http://${config.host}:${String(config.port)}/`,
        )
        return 0
      }

      case 'stop': {
        const stopped = await stopDaemonGracefully(paths, platform)
        out(stopped ? `${brand.displayName} 后台服务已停止。` : `${brand.displayName} 当前未运行。`)
        return 0
      }

      case 'restart': {
        await stopDaemonGracefully(paths, platform)
        await startDaemonAndWait(paths, {
          platform,
          ...(ctx.supervisorNodeOverride !== undefined ? { nodeOverride: ctx.supervisorNodeOverride } : {}),
          ...(ctx.supervisorScriptOverride !== undefined ? { supervisorScriptOverride: ctx.supervisorScriptOverride } : {}),
        })
        const live = getLiveDaemonStatus(paths)
        const config = readReinsConfig(paths.configFile)
        out(
          `${brand.displayName} 已平滑重启 (PID ${String(live?.pid ?? 'unknown')}, 版本 ${live?.version ?? readCurrentVersion(paths.currentFile) ?? 'unknown'}) -> http://${config.host}:${String(config.port)}/`,
        )
        return 0
      }

      case 'status': {
        return await handleStatusCommand(paths, brand, platform, parsed.flags, ctx, out)
      }

      case 'logs': {
        const rawLines = parsed.flags['-n'] ?? parsed.flags['--lines']
        const lineCount = typeof rawLines === 'string' ? Math.max(1, Number.parseInt(rawLines, 10) || 100) : 100
        if (!existsSync(paths.daemonLogFile) && !existsSync(`${paths.daemonLogFile}.1`)) {
          out(`暂无日志文件 (${paths.daemonLogFile})`)
          return 0
        }
        const tail = readTailLines(paths.daemonLogFile, lineCount)
        if (tail.length > 0) out(tail.join('\n'))
        if (parsed.flags['-f'] === true || parsed.flags['--follow'] === true) {
          await followLogFile(paths.daemonLogFile, (chunk) => {
            if (ctx.stdout !== undefined) ctx.stdout(chunk)
            else process.stdout.write(chunk)
          })
        }
        return 0
      }

      case 'upgrade':
      case 'update': {
        const config = readReinsConfig(paths.configFile)
        const checkOnly = parsed.flags['--check'] === true
        const force = parsed.flags['--force'] === true
        const requestedVersion = typeof parsed.flags['--version'] === 'string' ? parsed.flags['--version'] : undefined
        const mirrorOverride = typeof parsed.flags['--mirror'] === 'string'
          ? parsed.flags['--mirror']
          : env.REINS_GITHUB_MIRROR
        const hooks = createTransactionHooks(paths, platform, ctx)

        out(checkOnly ? `正在检查 ${config.repo} 的最新发布版本...` : `正在同步 ${config.repo} 发布版本...`)
        const result = await performUpgrade({
          paths,
          config,
          hooks,
          checkOnly,
          force,
          requestedVersion,
          mirrorOverride,
          fetchImpl: ctx.fetchImpl,
          platform,
        })

        if (result.outcome === 'up-to-date') {
          out(`${brand.displayName} 当前已是最新版本 (${result.targetVersion})。`)
          return 0
        }
        if (result.outcome === 'update-available') {
          out(
            `发现新版本: ${result.previousVersion ?? '未安装'} -> ${result.targetVersion} (DSH Core ${result.manifest.dshCoreVersion}, Commit ${result.manifest.commit})`,
          )
          out(`执行 "${brand.command} upgrade" 即可一键完成后台无损升级。`)
          return 0
        }
        out(
          `${brand.displayName} 已升级完成: ${result.previousVersion ?? 'initial'} -> ${result.targetVersion} (健康检查通过，服务已在后台就绪)`,
        )
        return 0
      }

      case 'rollback': {
        const hooks = createTransactionHooks(paths, platform, ctx)
        const result = await performRollback(paths, hooks, {
          healthTimeoutMs: DEFAULT_UPGRADE_HEALTH_TIMEOUT_MS,
          platform,
        })
        out(`${brand.displayName} 已回滚版本: ${result.fromVersion ?? 'unknown'} -> ${result.toVersion}`)
        return 0
      }

      case 'config': {
        return handleConfigCommand(paths, brand, subArgs, out)
      }

      case 'alias': {
        return handleAliasCommand(paths, subArgs, parsed.flags, env, platform, out)
      }

      case 'doctor': {
        return await handleDoctorCommand(paths, brand, env, platform, ctx, out)
      }

      case 'version': {
        return handleVersionCommand(paths, brand, platform, out)
      }

      case 'uninstall': {
        return await handleUninstallCommand(paths, brand, parsed.flags, env, platform, ctx, out)
      }

      case 'help': {
        out(renderHelpText(brand, subArgs[0]))
        return 0
      }

      case 'internal-postinstall': {
        return await handleInternalPostinstall(paths, brand, env, platform, ctx, out)
      }

      default: {
        err(`${brand.command}: 未知子命令 "${subcommand}"。执行 "${brand.command} help" 查看可用命令。`)
        return 1
      }
    }
  } catch (commandError) {
    err(`${brand.command} error: ${commandError instanceof Error ? commandError.message : String(commandError)}`)
    return 1
  }
}

function handleVersionCommand(
  paths: ReinsPaths,
  brand: BrandIdentity,
  platform: NodeJS.Platform,
  out: (line: string) => void,
): number {
  const activeVersion = readCurrentVersion(paths.currentFile)
  if (activeVersion === undefined) {
    out(`${brand.displayName} (uninstalled / no active slot)`)
    return 0
  }
  const slot = resolveReleaseSlotPaths(paths.releasesDir, activeVersion, platform)
  const manifest = readSlotReleaseManifest(slot)
  if (manifest === undefined) {
    out(`${brand.displayName} ${activeVersion}`)
    return 0
  }
  out(`${brand.displayName} ${manifest.editionVersion}`)
  out(`  DSH Core : v${manifest.dshCoreVersion} (${manifest.commit})`)
  out(`  Node.js  : v${manifest.nodeVersion}`)
  out(`  Target   : ${manifest.target}`)
  out(`  Built At : ${manifest.builtAt}`)
  return 0
}

async function handleStatusCommand(
  paths: ReinsPaths,
  brand: BrandIdentity,
  platform: NodeJS.Platform,
  flags: Readonly<Record<string, string | boolean>>,
  ctx: CliExecutionContext,
  out: (line: string) => void,
): Promise<number> {
  const config = readReinsConfig(paths.configFile)
  const activeVersion = readCurrentVersion(paths.currentFile) ?? 'none'
  const slot = resolveReleaseSlotPaths(paths.releasesDir, activeVersion, platform)
  const manifest = readSlotReleaseManifest(slot)
  const persisted = readDaemonStatus(paths.statusFile)
  const live = getLiveDaemonStatus(paths)
  const installedSlots = listInstalledVersions(paths.releasesDir, platform)

  let stateLabel = '未运行 (stopped)'
  if (live !== undefined) {
    stateLabel = live.state === 'running' ? '运行中 (running)' : '启动中 (starting)'
  } else if (persisted?.state === 'port-conflict') {
    stateLabel = '端口被占用 (port-conflict)'
  } else if (persisted?.state === 'failed') {
    stateLabel = '异常退出 (failed)'
  }

  out(`${brand.displayName} 状态概览`)
  out(`  运行状态 : ${stateLabel}`)
  out(`  当前版本 : ${activeVersion}${manifest !== undefined ? ` (DSH Core v${manifest.dshCoreVersion}, ${manifest.commit})` : ''}`)
  out(`  本地槽位 : ${installedSlots.length > 0 ? installedSlots.join(', ') : activeVersion}`)
  out(`  监听地址 : http://${config.host}:${String(config.port)}/`)
  if (live !== undefined) {
    out(`  守护 PID : ${String(live.pid)}${live.childPid !== undefined ? ` (Web Host PID ${String(live.childPid)})` : ''}`)
    out(`  运行时长 : ${formatDuration(live.startedAt)}`)
  } else if (persisted?.error !== undefined && (persisted.state === 'port-conflict' || persisted.state === 'failed')) {
    out(`  最近诊断 : ${persisted.error}`)
  }
  out(`  安装目录 : ${paths.rootDir}`)
  out(`  数据目录 : ${paths.dataDir}`)
  out(`  命令入口 : ${['reins', ...config.enabledAliases].join(', ')}`)

  if (flags['--check'] === true || flags['--check-update'] === true) {
    try {
      const remote = await fetchReleaseManifest({
        repo: config.repo,
        mirror: config.mirror,
        fetchImpl: ctx.fetchImpl,
        timeoutMs: 8_000,
      })
      out(`  远程最新 : ${remote.editionVersion} (${remote.tag})`)
    } catch (checkErr) {
      out(`  远程最新 : 检查失败 (${checkErr instanceof Error ? checkErr.message : String(checkErr)})`)
    }
  }
  return 0
}

function handleConfigCommand(
  paths: ReinsPaths,
  brand: BrandIdentity,
  subArgs: readonly string[],
  out: (line: string) => void,
): number {
  const action = (subArgs[0] ?? 'list').toLowerCase()
  const config = readReinsConfig(paths.configFile)

  if (action === 'list') {
    out(`配置文件: ${paths.configFile}`)
    out(`  port           = ${String(config.port)}`)
    out(`  host           = ${config.host}`)
    out(`  mirror         = ${config.mirror ?? '(direct GitHub)'}`)
    out(`  repo           = ${config.repo}`)
    out(`  enabledAliases = ${config.enabledAliases.join(', ') || '(none)'}`)
    return 0
  }

  if (action === 'get') {
    const key = subArgs[1]
    if (key === 'port') out(String(config.port))
    else if (key === 'host') out(config.host)
    else if (key === 'mirror') out(config.mirror ?? '')
    else if (key === 'repo') out(config.repo)
    else throw new Error(`Unsupported config key ${JSON.stringify(key)}; expected port, host, mirror, or repo`)
    return 0
  }

  if (action === 'set') {
    const key = subArgs[1]
    const rawValue = subArgs[2]
    if (key === undefined || rawValue === undefined) {
      throw new Error(`Usage: ${brand.command} config set <port|host|mirror|repo> <value>`)
    }
    let updated: ReinsConfig
    if (key === 'port') {
      const nextPort = validatePort(Number.parseInt(rawValue, 10))
      updated = { ...config, port: nextPort }
    } else if (key === 'host') {
      const trimmed = rawValue.trim()
      if (trimmed === '') throw new Error('Host cannot be empty')
      updated = { ...config, host: trimmed }
    } else if (key === 'mirror') {
      const cleared = rawValue.trim() === '' || rawValue.trim().toLowerCase() === 'clear' || rawValue.trim().toLowerCase() === 'none'
      const { mirror: _prevMirror, ...rest } = config
      updated = cleared ? rest : { ...rest, mirror: rawValue.trim().replace(/\/+$/u, '') }
    } else if (key === 'repo') {
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(rawValue.trim())) {
        throw new Error(`Invalid GitHub repository slug ${JSON.stringify(rawValue)}; expected owner/repo`)
      }
      updated = { ...config, repo: rawValue.trim() }
    } else {
      throw new Error(`Unsupported config key ${JSON.stringify(key)}; expected port, host, mirror, or repo`)
    }

    writeReinsConfig(paths.configFile, updated)
    out(`已更新配置 ${key} = ${key === 'mirror' ? (updated.mirror ?? '(cleared)') : String(updated[key])}`)
    if ((key === 'port' || key === 'host') && getLiveDaemonStatus(paths) !== undefined) {
      out(`提示: 后台服务正在运行，请执行 "${brand.command} restart" 使新监听地址生效。`)
    }
    return 0
  }

  throw new Error(`Unknown config action ${JSON.stringify(action)}; expected list, get, or set`)
}

function handleAliasCommand(
  paths: ReinsPaths,
  subArgs: readonly string[],
  flags: Readonly<Record<string, string | boolean>>,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  out: (line: string) => void,
): number {
  const action = (subArgs[0] ?? 'list').toLowerCase()
  const config = readReinsConfig(paths.configFile)

  if (action === 'list') {
    out('命令入口与多品牌同构别名:')
    out('  reins  (执辔 Reins)  — 主命令 [始终启用]')
    for (const alias of SUPPORTED_ALIASES) {
      const aliasBrand = resolveBrandIdentity(alias)
      const enabled = config.enabledAliases.includes(alias)
      const shimFile = join(paths.binDir, platform === 'win32' ? `${alias}.cmd` : alias)
      const conflict = detectExternalCommandConflict(alias, paths.binDir, env, platform)
      const state = enabled && existsSync(shimFile)
        ? '已启用'
        : conflict !== undefined
          ? `存在外部同名命令冲突 (${conflict})`
          : '已禁用'
      out(`  ${alias.padEnd(6, ' ')} (${aliasBrand.displayName}) — ${state}`)
    }
    return 0
  }

  if (action === 'enable' || action === 'disable') {
    const rawTarget = subArgs[1]?.toLowerCase() ?? ''
    if (!isBrandAliasName(rawTarget)) {
      throw new Error(`仅支持开关内置品牌别名 loom 或 lumen；收到 ${JSON.stringify(subArgs[1] ?? '')}`)
    }
    const nextAliases = action === 'enable'
      ? [...new Set<BrandAliasName>([...config.enabledAliases, rawTarget])]
      : config.enabledAliases.filter(item => item !== rawTarget)
    const nextConfig: ReinsConfig = { ...config, enabledAliases: nextAliases }
    writeReinsConfig(paths.configFile, nextConfig)
    const syncRes = syncCommandShims(paths, nextConfig, {
      env,
      platform,
      ignoreConflicts: flags['--force'] === true,
    })
    const conflict = syncRes.skippedConflicts.find(item => item.alias === rawTarget)
    if (action === 'enable' && conflict !== undefined) {
      out(
        `检测到系统 PATH 中已存在外部命令 ${conflict.conflictPath}，已跳过创建 ${rawTarget} 垫片（如确需覆盖请加 --force）。`,
      )
      return 1
    }
    out(
      action === 'enable'
        ? `已启用品牌命令别名 "${rawTarget}" (${resolveBrandIdentity(rawTarget).displayName})。`
        : `已禁用品牌命令别名 "${rawTarget}"。`,
    )
    return 0
  }

  throw new Error(`Unknown alias action ${JSON.stringify(action)}; expected list, enable, or disable`)
}

async function handleDoctorCommand(
  paths: ReinsPaths,
  brand: BrandIdentity,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  ctx: CliExecutionContext,
  out: (line: string) => void,
): Promise<number> {
  const config = readReinsConfig(paths.configFile)
  const activeVersion = readCurrentVersion(paths.currentFile)
  let failures = 0

  out(`${brand.displayName} 环境自检 (doctor)`)

  if (activeVersion === undefined) {
    out(`  [FAIL] 激活版本槽位: 缺少 ${paths.currentFile}`)
    failures += 1
  } else {
    const slot = resolveReleaseSlotPaths(paths.releasesDir, activeVersion, platform)
    if (existsSync(slot.nodeExecutable) && existsSync(slot.dshBinScript) && existsSync(slot.supervisorScript)) {
      const probe = spawnSync(slot.nodeExecutable, ['--version'], { windowsHide: true, encoding: 'utf8' })
      if (probe.status === 0) {
        out(`  [OK]   运行时完整性: 槽位 ${activeVersion}, 内置 Node ${probe.stdout.trim()}`)
      } else {
        out(`  [FAIL] 运行时完整性: 内置 Node 无法启动 (${slot.nodeExecutable})`)
        failures += 1
      }
    } else {
      out(`  [FAIL] 运行时完整性: 槽位 ${activeVersion} 缺少关键文件 (${slot.slotDir})`)
      failures += 1
    }
  }

  try {
    mkdirSync(paths.dataDir, { recursive: true })
    const probeFile = join(paths.dataDir, '.doctor-write-check.tmp')
    atomicWriteText(probeFile, 'ok\n', 0o600)
    rmSync(probeFile, { force: true })
    const globalDshHome = env.DSH_HOME?.trim()
    if (globalDshHome !== undefined && globalDshHome !== '') {
      out(`  [WARN] 数据隔离检查: 当前终端环境变量设置了全局 DSH_HOME=${globalDshHome}（建议移除以免影响源码模式；${brand.command} 守护进程内部会自动隔离至 ${paths.dataDir}）`)
    } else {
      out(`  [OK]   数据目录与源码隔离: ${paths.dataDir} 可读写，且未污染全局 DSH_HOME`)
    }
  } catch (dataErr) {
    out(`  [FAIL] 数据目录读写失败: ${dataErr instanceof Error ? dataErr.message : String(dataErr)}`)
    failures += 1
  }

  const live = getLiveDaemonStatus(paths)
  if (live !== undefined) {
    out(`  [OK]   监听端口状态: ${config.host}:${String(config.port)} 已由当前守护进程持有 (PID ${String(live.pid)})`)
  } else {
    const portFree = await probePortAvailable(config.host, config.port)
    if (portFree) {
      out(`  [OK]   监听端口状态: ${config.host}:${String(config.port)} 空闲可用`)
    } else {
      out(`  [FAIL] 监听端口状态: ${config.host}:${String(config.port)} 被其他外部进程占用，可执行 "${brand.command} config set port <新端口>"`)
      failures += 1
    }
  }

  const pathEntries = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : delimiter)
  const normalizedBin = resolve(paths.binDir).toLowerCase()
  const inPath = pathEntries.some(entry => entry.trim() !== '' && resolve(entry.trim()).toLowerCase() === normalizedBin)
  if (inPath) {
    out(`  [OK]   用户 PATH 配置: ${paths.binDir} 已在当前终端生效`)
  } else {
    out(`  [WARN] 用户 PATH 配置: 当前终端尚未加载 ${paths.binDir}（重开终端窗口或刷新 Shell 配置后生效）`)
  }

  try {
    const manifest = await fetchReleaseManifest({
      repo: config.repo,
      mirror: config.mirror,
      fetchImpl: ctx.fetchImpl,
      timeoutMs: 8_000,
    })
    out(`  [OK]   GitHub 更新源连通性: 可访问 ${config.repo} (最新发版 ${manifest.editionVersion})`)
  } catch (netErr) {
    out(
      `  [WARN] GitHub 更新源连通性: 无法连接 (${netErr instanceof Error ? netErr.message : String(netErr)})；可通过 "${brand.command} config set mirror <加速前缀>" 配置镜像`,
    )
  }

  return failures === 0 ? 0 : 1
}

async function handleUninstallCommand(
  paths: ReinsPaths,
  brand: BrandIdentity,
  flags: Readonly<Record<string, string | boolean>>,
  _env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  ctx: CliExecutionContext,
  out: (line: string) => void,
): Promise<number> {
  const purgeData = flags['--purge-data'] === true
  const confirmed = flags['--yes'] === true || flags['-y'] === true

  if (purgeData && !confirmed) {
    if (!process.stdin.isTTY) {
      throw new Error(`卸载并彻底删除会话与记忆数据 (${paths.dataDir}) 需要显式附加 --yes 确认。`)
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    try {
      const answer = (await rl.question(`确认彻底删除 ${paths.dataDir} 下的所有会话、记忆与凭据吗？输入 yes 确认: `)).trim()
      if (answer !== 'yes') {
        out('已取消卸载。')
        return 0
      }
    } finally {
      rl.close()
    }
  }

  await stopDaemonGracefully(paths, platform)

  if (platform === 'win32') {
    removeWindowsShortcuts()
    removeWindowsUserPath(paths.binDir)
  } else {
    removePosixShellPath(ctx.userHome ?? homedir())
  }

  for (const target of [paths.binDir, paths.runDir, paths.currentFile, paths.configFile]) {
    rmSync(target, { recursive: true, force: true })
  }

  if (platform === 'win32') {
    scheduleWindowsDelayedCleanup(purgeData ? paths.rootDir : paths.releasesDir)
    if (purgeData) {
      rmSync(paths.dataDir, { recursive: true, force: true })
    }
  } else {
    rmSync(paths.releasesDir, { recursive: true, force: true })
    if (purgeData) {
      rmSync(paths.rootDir, { recursive: true, force: true })
    }
  }

  if (purgeData) {
    out(`${brand.displayName} 程序及全部本地数据已彻底卸载 (${paths.rootDir})。`)
  } else {
    out(`${brand.displayName} 程序、快捷方式与 PATH 条目已清理完毕。`)
    out(`您的本地会话、记忆库与凭据已安全保留于: ${paths.dataDir}`)
  }
  return 0
}

async function handleInternalPostinstall(
  paths: ReinsPaths,
  brand: BrandIdentity,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  ctx: CliExecutionContext,
  out: (line: string) => void,
): Promise<number> {
  const existingConfig = readReinsConfig(paths.configFile)
  const port = env.REINS_PORT !== undefined && env.REINS_PORT.trim() !== ''
    ? validatePort(Number.parseInt(env.REINS_PORT.trim(), 10))
    : existingConfig.port
  const host = env.REINS_HOST?.trim() || existingConfig.host
  const mirror = env.REINS_GITHUB_MIRROR?.trim() || existingConfig.mirror
  const repo = env.REINS_REPO?.trim() || existingConfig.repo || DEFAULT_GITHUB_REPO

  const nextConfig: ReinsConfig = {
    port,
    host,
    ...(mirror !== undefined && mirror !== '' ? { mirror } : {}),
    enabledAliases: existingConfig.enabledAliases,
    repo,
  }
  mkdirSync(paths.dataDir, { recursive: true })
  mkdirSync(paths.runDir, { recursive: true, mode: 0o700 })
  writeReinsConfig(paths.configFile, nextConfig)

  const activeVersion = readCurrentVersion(paths.currentFile)
  const iconPath = copySlotIconIfPresent(paths, activeVersion)
  const shimResult = syncCommandShims(paths, nextConfig, { env, platform })

  if (env.REINS_SKIP_PATH !== '1') {
    if (platform === 'win32') {
      upsertWindowsUserPath(paths.binDir)
    } else {
      upsertPosixShellPath(paths.binDir, ctx.userHome ?? homedir())
    }
  }

  let shortcuts: string[] = []
  if (platform === 'win32' && env.REINS_SKIP_SHORTCUTS !== '1') {
    shortcuts = createWindowsShortcuts(paths, iconPath)
  }

  if (env.REINS_NO_START !== '1') {
    if (getLiveDaemonStatus(paths) !== undefined) {
      await stopDaemonGracefully(paths, platform)
    }
    const launchUrl = await startDaemonAndWait(paths, {
      platform,
      ...(ctx.supervisorNodeOverride !== undefined ? { nodeOverride: ctx.supervisorNodeOverride } : {}),
      ...(ctx.supervisorScriptOverride !== undefined ? { supervisorScriptOverride: ctx.supervisorScriptOverride } : {}),
    })
    if (env.REINS_NO_OPEN !== '1') {
      const openFn = ctx.openBrowser ?? ((url: string): void => {
        openBrowserUrl(url, platform)
      })
      openFn(launchUrl)
    }
  }

  const target = (() => {
    try {
      return resolveHostReleaseTarget(platform, process.arch)
    } catch (error) {
      // Non-standard test platforms omit target label gracefully.
      void error
      return `${platform}-${process.arch}`
    }
  })()

  out('')
  out(`${brand.displayName} (${activeVersion ?? 'latest'}, ${target}) 安装就绪！`)
  out(`  访问地址 : http://${nextConfig.host}:${String(nextConfig.port)}/`)
  out(`  可用命令 : ${shimResult.installed.join(', ')}`)
  for (const skipped of shimResult.skippedConflicts) {
    out(`  别名提示 : 已跳过 "${skipped.alias}"（检测到外部同名命令 ${skipped.conflictPath}）`)
  }
  if (shortcuts.length > 0) {
    out('  快捷入口 : 已在桌面与开始菜单创建 Reins 图标（双击即无黑框启动并打开浏览器）')
  }
  out(`  数据隔离 : ${paths.dataDir}（与源码开发模式 100% 独立互不干扰）`)
  out('')
  return 0
}

if (isExecutedAsMain(import.meta.url)) {
  void runReinsCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
