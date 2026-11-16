/**
 * Background daemon supervisor managing `dsh --profile web`, single-instance locking, URL token capture, log rotation, and crash recovery.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync, closeSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import {
  RotatingLogWriter,
  atomicWriteText,
  extractWebLaunchUrl,
  isJsonRecord,
  isProcessAlive,
  readCurrentVersion,
  readReinsConfig,
  resolveReinsPaths,
  resolveReleaseSlotPaths,
  writeDaemonStatus,
  type DaemonLifecycleState,
  type ReinsPaths,
} from './shared.ts'

const BACKOFF_DELAYS_MS = [1_500, 4_000, 10_000] as const
const HEALTHY_UPTIME_RESET_MS = 30_000
const MAX_CONSECUTIVE_CRASHES = 5
const STOP_POLL_INTERVAL_MS = 150
const CHILD_EXIT_GRACE_MS = 4_000

/**
 * Probe whether `host:port` can be bound on the local loopback interface.
 * @param host - Loopback IP address (such as `127.0.0.1`).
 * @param port - Candidate TCP port.
 * @returns True when the port is free to bind, false when already in use.
 */
export function probePortAvailable(host: string, port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const server = createServer()
    server.unref()
    server.once('error', () => {
      resolvePromise(false)
    })
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => {
        resolvePromise(true)
      })
    })
  })
}

/**
 * Enrich `PATH` on macOS using the user's login shell so Agent commands find Homebrew, pyenv, nvm, and cargo.
 * @param env - Current process environment.
 * @param platform - Active OS platform.
 * @returns Merged `PATH` string preserving order without empty entries.
 */
export function resolveEnrichedPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const currentPath = env.PATH ?? env.Path ?? ''
  if (platform !== 'darwin') return currentPath
  const shell = env.SHELL?.trim() || '/bin/zsh'
  const probe = spawnSync(shell, ['-lic', 'printf "__REINS_LOGIN_PATH__=%s\\n" "$PATH"'], {
    encoding: 'utf8',
    timeout: 3_000,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  if (probe.status !== 0 || typeof probe.stdout !== 'string') return currentPath
  const marker = '__REINS_LOGIN_PATH__='
  const matchedLine = probe.stdout.split(/\r?\n/u).find(line => line.startsWith(marker))
  if (matchedLine === undefined) return currentPath
  const loginPath = matchedLine.slice(marker.length).trim()
  if (loginPath === '') return currentPath
  const seen = new Set<string>()
  const merged: string[] = []
  for (const segment of [...loginPath.split(':'), ...currentPath.split(':')]) {
    const trimmed = segment.trim()
    if (trimmed !== '' && !seen.has(trimmed)) {
      seen.add(trimmed)
      merged.push(trimmed)
    }
  }
  return merged.join(':')
}

/**
 * Construct the child environment for `dsh --profile web`, isolating `DSH_HOME` to `<root>/data`.
 * @param paths - Resolved Reins installation paths.
 * @param baseEnv - Parent supervisor environment.
 * @param platform - Active OS platform.
 * @returns Clean environment passed to the `dsh` child process.
 */
export function buildDaemonChildEnv(
  paths: ReinsPaths,
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue
    if (key.toUpperCase().startsWith('DSH_')) continue
    if (key.toUpperCase().startsWith('REINS_')) continue
    childEnv[key] = value
  }
  const enrichedPath = resolveEnrichedPath(baseEnv, platform)
  if (platform === 'win32') {
    childEnv.Path = enrichedPath
  } else {
    childEnv.PATH = enrichedPath
  }
  childEnv.DSH_HOME = paths.dataDir
  childEnv.DSH_TELEMETRY_DISABLED = '1'
  return childEnv
}

function tryAcquireLock(lockFile: string, pid: number): boolean {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockFile, 'wx', 0o600)
      try {
        writeSync(fd, `${JSON.stringify({ pid, acquiredAt: new Date().toISOString() })}\n`, undefined, 'utf8')
      } finally {
        closeSync(fd)
      }
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let holderPid: number | undefined
      try {
        const raw: unknown = JSON.parse(readFileSync(lockFile, 'utf8'))
        if (isJsonRecord(raw) && typeof raw.pid === 'number') holderPid = raw.pid
      } catch (readError) {
        // Corrupt or mid-write lock file is treated as stale when unparseable.
        void readError
      }
      if (holderPid !== undefined && isProcessAlive(holderPid)) {
        return false
      }
      rmSync(lockFile, { force: true })
    }
  }
  return false
}

function terminateChildTree(child: ChildProcess, platform: NodeJS.Platform): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolvePromise) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(escalationTimer)
      resolvePromise()
    }
    child.once('close', finish)
    const escalationTimer = setTimeout(() => {
      if (child.pid !== undefined) {
        if (platform === 'win32') {
          spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          })
        } else {
          try {
            child.kill('SIGKILL')
          } catch (killError) {
            // Child already exited between timeout scheduling and SIGKILL.
            void killError
          }
        }
      }
      finish()
    }, CHILD_EXIT_GRACE_MS)

    if (platform === 'win32' && child.pid !== undefined) {
      spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
    } else {
      try {
        child.kill('SIGTERM')
      } catch (killError) {
        // Child exited concurrently before SIGTERM delivery.
        void killError
        finish()
      }
    }
  })
}

/** Options controlling one supervisor execution (including injectable overrides for unit tests). */
export interface SupervisorRunOptions {
  /** Explicit installation root (`~/.reins` or `%LOCALAPPDATA%\Reins`). */
  readonly rootDir?: string | undefined
  /** Explicit version slot override (defaults to reading `current`). */
  readonly version?: string | undefined
  /** Optional override for the Node executable path (used by isolated unit tests). */
  readonly nodeExecutableOverride?: string | undefined
  /** Optional override for the child script path and arguments (used by isolated unit tests). */
  readonly childArgsOverride?: readonly string[] | undefined
  /** Optional override for the child environment (used by isolated unit tests). */
  readonly childEnvOverride?: NodeJS.ProcessEnv | undefined
  /** Optional maximum log file size before rotation. */
  readonly maxLogBytes?: number | undefined
  /** Optional backoff delays in milliseconds for crash-recovery tests. */
  readonly backoffDelaysMs?: readonly number[] | undefined
}

interface ChildExitOutcome {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly spawnError?: Error
}

/**
 * Run the foreground supervisor loop (invoked inside a detached background process by `reins start`).
 * @param options - Root path, version slot, and optional test overrides.
 * @returns Exit status code (`0` on clean stop or duplicate-instance skip, `1` on fatal startup failure).
 */
export async function runSupervisor(options: SupervisorRunOptions = {}): Promise<number> {
  const paths = resolveReinsPaths(options.rootDir)
  mkdirSync(paths.runDir, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') {
    chmodSync(paths.runDir, 0o700)
  }
  mkdirSync(paths.dataDir, { recursive: true })

  if (!tryAcquireLock(paths.supervisorLockFile, process.pid)) {
    return 0
  }

  rmSync(paths.stopSignalFile, { force: true })
  rmSync(paths.webUrlFile, { force: true })

  const logger = new RotatingLogWriter(paths.daemonLogFile, options.maxLogBytes)
  const startedAt = new Date().toISOString()
  const config = readReinsConfig(paths.configFile)
  const activeVersion = options.version ?? readCurrentVersion(paths.currentFile)
  if (activeVersion === undefined) {
    logger.writeLine(`[${new Date().toISOString()}] fatal: missing active version pointer at ${paths.currentFile}`)
    rmSync(paths.supervisorLockFile, { force: true })
    return 1
  }

  const slot = resolveReleaseSlotPaths(paths.releasesDir, activeVersion)
  const nodeExe = options.nodeExecutableOverride ?? slot.nodeExecutable
  const childArgs = options.childArgsOverride ?? [
    slot.dshBinScript,
    '--profile',
    'web',
    '--no-open',
    '--host',
    config.host,
    '--port',
    String(config.port),
  ]
  const baseUrl = `http://${config.host}:${String(config.port)}/`

  const updateStatus = (
    state: DaemonLifecycleState,
    extra: { readonly childPid?: number; readonly error?: string } = {},
  ): void => {
    writeDaemonStatus(paths.statusFile, {
      state,
      pid: process.pid,
      ...(extra.childPid !== undefined ? { childPid: extra.childPid } : {}),
      host: config.host,
      port: config.port,
      version: activeVersion,
      baseUrl,
      startedAt,
      updatedAt: new Date().toISOString(),
      ...(extra.error !== undefined ? { error: extra.error } : {}),
    })
  }

  const portFree = await probePortAvailable(config.host, config.port)
  if (!portFree) {
    const message = `Port ${config.host}:${String(config.port)} is already occupied by another process. Run "reins config set port <port>" to select a different port.`
    logger.writeLine(`[${new Date().toISOString()}] ${message}`)
    updateStatus('port-conflict', { error: message })
    rmSync(paths.supervisorLockFile, { force: true })
    return 1
  }

  const control: { stopRequested: boolean } = { stopRequested: false }
  const isStopRequested = (): boolean => control.stopRequested || existsSync(paths.stopSignalFile)
  let activeChild: ChildProcess | undefined
  let sleepWake: (() => void) | undefined

  const requestStop = (): void => {
    if (control.stopRequested) return
    control.stopRequested = true
    sleepWake?.()
    if (activeChild !== undefined) {
      void terminateChildTree(activeChild, process.platform)
    }
  }

  const onSigTerm = (): void => { requestStop() }
  const onSigInt = (): void => { requestStop() }
  process.on('SIGTERM', onSigTerm)
  process.on('SIGINT', onSigInt)

  const stopPoller = setInterval(() => {
    if (existsSync(paths.stopSignalFile)) {
      requestStop()
    }
  }, STOP_POLL_INTERVAL_MS)
  stopPoller.unref()

  const backoffSchedule = options.backoffDelaysMs ?? BACKOFF_DELAYS_MS
  let consecutiveCrashes = 0
  let exitCode = 0

  try {
    updateStatus('starting')
    const childEnv = options.childEnvOverride ?? buildDaemonChildEnv(paths)
    const workingDir = existsSync(homedir()) ? homedir() : paths.rootDir

    while (!control.stopRequested) {
      const childStartedMs = Date.now()
      logger.writeLine(`[${new Date().toISOString()}] supervisor: launching Web host (${activeVersion}) on ${baseUrl}`)

      const child = spawn(nodeExe, [...childArgs], {
        cwd: workingDir,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      activeChild = child

      const attachLineLogger = (stream: NodeJS.ReadableStream | null, inspectUrl: boolean): void => {
        if (stream === null) return
        let remainder = ''
        stream.setEncoding('utf8')
        stream.on('data', (chunk: string) => {
          const combined = remainder + chunk
          const lines = combined.split(/\r?\n/u)
          remainder = lines.pop() ?? ''
          for (const line of lines) {
            logger.writeLine(line)
            if (inspectUrl) {
              const launchUrl = extractWebLaunchUrl(line)
              if (launchUrl !== undefined) {
                atomicWriteText(paths.webUrlFile, `${launchUrl}\n`, 0o600)
                updateStatus('running', child.pid !== undefined ? { childPid: child.pid } : {})
              }
            }
          }
        })
        stream.once('end', () => {
          if (remainder !== '') {
            logger.writeLine(remainder)
            if (inspectUrl) {
              const launchUrl = extractWebLaunchUrl(remainder)
              if (launchUrl !== undefined) {
                atomicWriteText(paths.webUrlFile, `${launchUrl}\n`, 0o600)
              }
            }
          }
        })
      }

      attachLineLogger(child.stdout, true)
      attachLineLogger(child.stderr, false)

      const outcome = await new Promise<ChildExitOutcome>((resolvePromise) => {
        child.once('error', (err) => {
          resolvePromise({ code: 1, signal: null, spawnError: err })
        })
        child.once('close', (code, signal) => {
          resolvePromise({ code, signal })
        })
      })
      activeChild = undefined
      rmSync(paths.webUrlFile, { force: true })

      if (isStopRequested()) {
        control.stopRequested = true
        break
      }

      if (outcome.spawnError !== undefined) {
        const errMsg = `Failed to execute Node host (${nodeExe}): ${outcome.spawnError.message}`
        logger.writeLine(`[${new Date().toISOString()}] supervisor error: ${errMsg}`)
        updateStatus('failed', { error: errMsg })
        exitCode = 1
        break
      }

      const ranMs = Date.now() - childStartedMs
      if (ranMs >= HEALTHY_UPTIME_RESET_MS) {
        consecutiveCrashes = 0
      } else {
        consecutiveCrashes += 1
      }

      logger.writeLine(
        `[${new Date().toISOString()}] supervisor: child exited unexpectedly (code=${String(outcome.code)}, signal=${String(outcome.signal)}, consecutive=${String(consecutiveCrashes)})`,
      )

      if (consecutiveCrashes >= MAX_CONSECUTIVE_CRASHES) {
        const fatalMsg = `Web host crashed ${String(consecutiveCrashes)} times consecutively; check ${paths.daemonLogFile}`
        logger.writeLine(`[${new Date().toISOString()}] supervisor fatal: ${fatalMsg}`)
        updateStatus('failed', { error: fatalMsg })
        exitCode = 1
        break
      }

      updateStatus('starting')
      const delayMs = backoffSchedule[Math.min(consecutiveCrashes - 1, backoffSchedule.length - 1)] ?? 2_000
      await new Promise<void>((resolveSleep) => {
        const timer = setTimeout(() => {
          sleepWake = undefined
          resolveSleep()
        }, delayMs)
        sleepWake = () => {
          clearTimeout(timer)
          sleepWake = undefined
          resolveSleep()
        }
      })
    }

    if (exitCode === 0) {
      logger.writeLine(`[${new Date().toISOString()}] supervisor: stopped cleanly`)
      updateStatus('stopped')
    }
  } finally {
    clearInterval(stopPoller)
    process.off('SIGTERM', onSigTerm)
    process.off('SIGINT', onSigInt)
    rmSync(paths.webUrlFile, { force: true })
    rmSync(paths.stopSignalFile, { force: true })
    rmSync(paths.supervisorLockFile, { force: true })
  }
  return exitCode
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      root: { type: 'string' },
      version: { type: 'string' },
    },
    strict: false,
  })
  const rootOpt = typeof values.root === 'string' ? values.root : undefined
  const versionOpt = typeof values.version === 'string' ? values.version : undefined
  void runSupervisor({ rootDir: rootOpt, version: versionOpt }).then((code) => {
    process.exitCode = code
  })
}
