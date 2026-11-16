/**
 * Command shim generation, external PATH conflict detection, user-level PATH registration, and Windows shortcut helpers.
 */

import { spawnSync } from 'node:child_process'
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import {
  SUPPORTED_ALIASES,
  atomicWriteText,
  type BrandAliasName,
  type BrandCommandName,
  type ReinsConfig,
  type ReinsPaths,
} from './shared.ts'

const POSIX_BLOCK_START = '# >>> reins initialize >>>'
const POSIX_BLOCK_END = '# <<< reins initialize <<<'

/**
 * Render the POSIX shell launcher shim placed in `<root>/bin/<command>`.
 * @param command - Brand command name (`reins`, `loom`, or `lumen`).
 * @returns Executable POSIX `sh` script text.
 */
export function renderPosixShim(command: BrandCommandName): string {
  return [
    '#!/usr/bin/env sh',
    'set -eu',
    'SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"',
    'REINS_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"',
    'CURRENT_FILE="$REINS_ROOT/current"',
    'if [ ! -f "$CURRENT_FILE" ]; then',
    `  echo "${command}: active release pointer is missing at $CURRENT_FILE" >&2`,
    '  exit 1',
    'fi',
    'REINS_VER="$(tr -d \'\\r\\n \' < "$CURRENT_FILE")"',
    'NODE_BIN="$REINS_ROOT/releases/$REINS_VER/node/bin/node"',
    'CLI_MJS="$REINS_ROOT/releases/$REINS_VER/supervisor/cli.mjs"',
    'if [ ! -x "$NODE_BIN" ] || [ ! -f "$CLI_MJS" ]; then',
    `  echo "${command}: release slot $REINS_VER is incomplete under $REINS_ROOT/releases/$REINS_VER" >&2`,
    '  exit 1',
    'fi',
    `exec "$NODE_BIN" "$CLI_MJS" --invoked-as "${command}" --root "$REINS_ROOT" "$@"`,
    '',
  ].join('\n')
}

/**
 * Render the Windows `.cmd` launcher shim placed in `<root>\bin\<command>.cmd`.
 * @param command - Brand command name (`reins`, `loom`, or `lumen`).
 * @returns Windows batch script text.
 */
export function renderWindowsCmdShim(command: BrandCommandName): string {
  return [
    '@echo off',
    'setlocal EnableExtensions',
    'for %%I in ("%~dp0..") do set "REINS_ROOT=%%~fI"',
    'set "CURRENT_FILE=%REINS_ROOT%\\current"',
    'if not exist "%CURRENT_FILE%" (',
    `  echo ${command}: active release pointer is missing at %CURRENT_FILE% 1>&2`,
    '  exit /b 1',
    ')',
    'set /p REINS_VER=<"%CURRENT_FILE%"',
    'set "REINS_VER=%REINS_VER: =%"',
    'set "NODE_BIN=%REINS_ROOT%\\releases\\%REINS_VER%\\node\\bin\\node.exe"',
    'set "CLI_MJS=%REINS_ROOT%\\releases\\%REINS_VER%\\supervisor\\cli.mjs"',
    'if not exist "%NODE_BIN%" (',
    `  echo ${command}: Node runtime is missing at %NODE_BIN% 1>&2`,
    '  exit /b 1',
    ')',
    `"%NODE_BIN%" "%CLI_MJS%" --invoked-as "${command}" --root "%REINS_ROOT%" %*`,
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n')
}

/**
 * Render the windowless VBScript launcher used by Windows Desktop and Start Menu shortcuts.
 * @returns VBScript source placed at `<root>\bin\reins-open.vbs`.
 */
export function renderWindowsHiddenOpenVbs(): string {
  return [
    'Option Explicit',
    'Dim fso, shell, binDir, rootDir, currentFile, stream, ver, nodeExe, cliMjs, cmd',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'Set shell = CreateObject("WScript.Shell")',
    'binDir = fso.GetParentFolderName(WScript.ScriptFullName)',
    'rootDir = fso.GetParentFolderName(binDir)',
    'currentFile = fso.BuildPath(rootDir, "current")',
    'If Not fso.FileExists(currentFile) Then WScript.Quit 1',
    'Set stream = fso.OpenTextFile(currentFile, 1, False)',
    'ver = Trim(Replace(Replace(stream.ReadAll(), vbCr, ""), vbLf, ""))',
    'stream.Close',
    'nodeExe = fso.BuildPath(rootDir, "releases\\" & ver & "\\node\\bin\\node.exe")',
    'cliMjs = fso.BuildPath(rootDir, "releases\\" & ver & "\\supervisor\\cli.mjs")',
    'If Not fso.FileExists(nodeExe) Or Not fso.FileExists(cliMjs) Then WScript.Quit 1',
    'cmd = """" & nodeExe & """ """ & cliMjs & """ --invoked-as reins --root """ & rootDir & """ open"',
    'shell.Run cmd, 0, False',
    '',
  ].join('\r\n')
}

function normalizePathForCompare(dir: string, platform: NodeJS.Platform): string {
  const resolved = resolve(dir).replace(/[\\/]+$/u, '')
  return platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * Check whether an alias command name already resolves to an executable outside `binDir` on `PATH`.
 * @param aliasName - Candidate alias (`loom` or `lumen`).
 * @param binDir - Reins `bin/` directory to ignore during lookup.
 * @param env - Environment supplying `PATH` and optional `PATHEXT`.
 * @param platform - Target OS platform rules.
 * @returns Conflicting executable path if found outside `binDir`, otherwise `undefined`.
 */
export function detectExternalCommandConflict(
  aliasName: BrandAliasName,
  binDir: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const pathVar = env.PATH ?? env.Path ?? ''
  const sep = platform === 'win32' ? ';' : delimiter
  const normalizedOwnBin = normalizePathForCompare(binDir, platform)
  const extensions = platform === 'win32'
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD;.PS1').split(';').filter(ext => ext !== '')
    : ['']

  for (const rawEntry of pathVar.split(sep)) {
    const trimmed = rawEntry.trim().replace(/^"+|"+$/gu, '')
    if (trimmed === '') continue
    if (normalizePathForCompare(trimmed, platform) === normalizedOwnBin) continue
    for (const ext of extensions) {
      const candidate = join(trimmed, platform === 'win32' ? `${aliasName}${ext}` : aliasName)
      if (!existsSync(candidate)) continue
      if (platform === 'win32') return candidate
      try {
        accessSync(candidate, constants.X_OK)
        return candidate
      } catch (error) {
        // Non-executable files on POSIX PATH do not shadow commands.
        void error
      }
    }
  }
  return undefined
}

/** Summary of command shims written and any skipped conflicting aliases. */
export interface ShimSyncResult {
  /** Command names installed in `bin/`. */
  readonly installed: readonly BrandCommandName[]
  /** Aliases skipped because an external command with the same name exists on `PATH`. */
  readonly skippedConflicts: ReadonlyArray<{ readonly alias: BrandAliasName; readonly conflictPath: string }>
}

function writeShimFile(binDir: string, command: BrandCommandName, platform: NodeJS.Platform): void {
  if (platform === 'win32') {
    const target = join(binDir, `${command}.cmd`)
    atomicWriteText(target, renderWindowsCmdShim(command))
  } else {
    const target = join(binDir, command)
    atomicWriteText(target, renderPosixShim(command), 0o755)
    chmodSync(target, 0o755)
  }
}

function removeShimFile(binDir: string, command: BrandAliasName, platform: NodeJS.Platform): void {
  const target = join(binDir, platform === 'win32' ? `${command}.cmd` : command)
  rmSync(target, { force: true })
}

/**
 * Synchronize `<root>/bin/` shims for `reins` and enabled non-conflicting brand aliases.
 * @param paths - Resolved Reins installation paths.
 * @param config - Active Reins configuration listing `enabledAliases`.
 * @param options - Optional environment, platform, and force-overwrite controls.
 * @returns Installed command list and any skipped external conflicts.
 */
export function syncCommandShims(
  paths: ReinsPaths,
  config: ReinsConfig,
  options: {
    readonly env?: NodeJS.ProcessEnv
    readonly platform?: NodeJS.Platform
    readonly ignoreConflicts?: boolean
  } = {},
): ShimSyncResult {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  mkdirSync(paths.binDir, { recursive: true })
  writeShimFile(paths.binDir, 'reins', platform)
  if (platform === 'win32') {
    atomicWriteText(join(paths.binDir, 'reins-open.vbs'), renderWindowsHiddenOpenVbs())
  }

  const installed: BrandCommandName[] = ['reins']
  const skippedConflicts: Array<{ readonly alias: BrandAliasName; readonly conflictPath: string }> = []
  const enabledSet = new Set(config.enabledAliases)

  for (const alias of SUPPORTED_ALIASES) {
    if (!enabledSet.has(alias)) {
      removeShimFile(paths.binDir, alias, platform)
      continue
    }
    const conflict = options.ignoreConflicts === true
      ? undefined
      : detectExternalCommandConflict(alias, paths.binDir, env, platform)
    if (conflict !== undefined) {
      removeShimFile(paths.binDir, alias, platform)
      skippedConflicts.push({ alias, conflictPath: conflict })
      continue
    }
    writeShimFile(paths.binDir, alias, platform)
    installed.push(alias)
  }
  return { installed, skippedConflicts }
}

function renderPosixPathBlock(binDir: string): string {
  const escaped = binDir.replace(/"/gu, '\\"')
  return [
    POSIX_BLOCK_START,
    'case ":$PATH:" in',
    `  *":${escaped}:"*) ;;`,
    `  *) export PATH="${escaped}:$PATH" ;;`,
    'esac',
    POSIX_BLOCK_END,
  ].join('\n')
}

function stripPosixPathBlock(content: string): string {
  const lines = content.split('\n')
  const kept: string[] = []
  let insideBlock = false
  for (const line of lines) {
    if (line.trim() === POSIX_BLOCK_START) {
      insideBlock = true
      continue
    }
    if (line.trim() === POSIX_BLOCK_END) {
      insideBlock = false
      continue
    }
    if (!insideBlock) kept.push(line)
  }
  return kept.join('\n').replace(/\n{3,}/gu, '\n\n')
}

/**
 * Idempotently register `binDir` in user-level POSIX shell startup files without requiring root.
 * @param binDir - Absolute `<root>/bin` directory.
 * @param userHome - User home directory containing `.zshrc` / `.bash_profile` / `.bashrc`.
 * @returns List of shell profile files updated.
 */
export function upsertPosixShellPath(binDir: string, userHome: string = homedir()): string[] {
  const candidates = ['.zshrc', '.bash_profile', '.bashrc']
  const existing = candidates.map(name => join(userHome, name)).filter(file => existsSync(file))
  const targets = existing.length > 0 ? existing : [join(userHome, '.zshrc')]
  const block = renderPosixPathBlock(binDir)
  for (const file of targets) {
    const previous = existsSync(file) ? readFileSync(file, 'utf8') : ''
    const cleaned = stripPosixPathBlock(previous).trimEnd()
    const updated = cleaned === '' ? `${block}\n` : `${cleaned}\n\n${block}\n`
    writeFileSync(file, updated, 'utf8')
  }
  return targets
}

/**
 * Remove the Reins `PATH` block from user-level POSIX shell startup files during uninstall.
 * @param userHome - User home directory containing shell profiles.
 * @returns List of shell profile files cleaned.
 */
export function removePosixShellPath(userHome: string = homedir()): string[] {
  const cleanedFiles: string[] = []
  for (const name of ['.zshrc', '.bash_profile', '.bashrc']) {
    const file = join(userHome, name)
    if (!existsSync(file)) continue
    const previous = readFileSync(file, 'utf8')
    if (!previous.includes(POSIX_BLOCK_START)) continue
    const cleaned = stripPosixPathBlock(previous).trimEnd()
    writeFileSync(file, cleaned === '' ? '' : `${cleaned}\n`, 'utf8')
    cleanedFiles.push(file)
  }
  return cleanedFiles
}

/**
 * Add `binDir` to the current Windows user's `HKCU\Environment` `Path` without administrator privileges.
 * @param binDir - Absolute `<root>\bin` directory.
 * @returns True when PowerShell completed the user-PATH registration.
 */
export function upsertWindowsUserPath(binDir: string): boolean {
  const script = [
    '$ErrorActionPreference = "Stop"',
    `$target = ${JSON.stringify(binDir)}`,
    '$current = [Environment]::GetEnvironmentVariable("Path", "User")',
    '$parts = @()',
    'if ($current) { $parts = $current.Split(";", [System.StringSplitOptions]::RemoveEmptyEntries) }',
    '$exists = $false',
    'foreach ($p in $parts) { if ($p.TrimEnd("\\") -ieq $target.TrimEnd("\\")) { $exists = $true; break } }',
    'if (-not $exists) {',
    '  $next = (@($target) + $parts) -join ";"',
    '  [Environment]::SetEnvironmentVariable("Path", $next, "User")',
    '}',
  ].join('\n')
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    stdio: 'ignore',
  })
  return res.status === 0
}

/**
 * Remove `binDir` from the current Windows user's `HKCU\Environment` `Path`.
 * @param binDir - Absolute `<root>\bin` directory.
 * @returns True when PowerShell completed the cleanup.
 */
export function removeWindowsUserPath(binDir: string): boolean {
  const script = [
    '$ErrorActionPreference = "Stop"',
    `$target = ${JSON.stringify(binDir)}`,
    '$current = [Environment]::GetEnvironmentVariable("Path", "User")',
    'if ($current) {',
    '  $rawParts = $current.Split(";", [System.StringSplitOptions]::RemoveEmptyEntries)',
    '  $parts = $rawParts | Where-Object { $_.TrimEnd("\\") -ine $target.TrimEnd("\\") }',
    '  [Environment]::SetEnvironmentVariable("Path", ($parts -join ";"), "User")',
    '}',
  ].join('\n')
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    stdio: 'ignore',
  })
  return res.status === 0
}

/**
 * Create non-admin Windows Desktop and Start Menu `Reins.lnk` shortcuts launching `reins-open.vbs` without a console flash.
 * @param paths - Resolved Reins installation paths.
 * @param iconFile - Optional `.ico` file path for the shortcut icon.
 * @returns Created shortcut file paths.
 */
export function createWindowsShortcuts(paths: ReinsPaths, iconFile?: string): string[] {
  const vbsPath = join(paths.binDir, 'reins-open.vbs')
  const iconSpec = iconFile !== undefined && existsSync(iconFile) ? iconFile : ''
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$ws = New-Object -ComObject WScript.Shell',
    '$locations = @([Environment]::GetFolderPath("Desktop"), [Environment]::GetFolderPath("Programs"))',
    '$created = @()',
    'foreach ($dir in $locations) {',
    '  if (-not $dir -or -not (Test-Path -LiteralPath $dir)) { continue }',
    '  $lnkPath = Join-Path $dir "Reins.lnk"',
    '  $sc = $ws.CreateShortcut($lnkPath)',
    '  $sc.TargetPath = Join-Path $env:SystemRoot "System32\\wscript.exe"',
    `  $sc.Arguments = '//B //NoLogo "${vbsPath.replace(/"/gu, '""')}"'`,
    '  $sc.WorkingDirectory = [Environment]::GetFolderPath("UserProfile")',
    '  $sc.Description = "Start Reins in the background and open Web UI"',
    ...(iconSpec !== '' ? [`  $sc.IconLocation = ${JSON.stringify(`${iconSpec},0`)}`] : []),
    '  $sc.Save()',
    '  $created += $lnkPath',
    '}',
    '$created -join "`n"',
  ].join('\n')
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    encoding: 'utf8',
  })
  if (res.status !== 0 || typeof res.stdout !== 'string') return []
  return res.stdout.split(/\r?\n/u).map(line => line.trim()).filter(line => line !== '')
}

/**
 * Remove Windows Desktop and Start Menu `Reins.lnk` shortcuts created during installation.
 */
export function removeWindowsShortcuts(): void {
  const script = [
    '$ErrorActionPreference = "SilentlyContinue"',
    'foreach ($dir in @([Environment]::GetFolderPath("Desktop"), [Environment]::GetFolderPath("Programs"))) {',
    '  if ($dir) {',
    '    $lnk = Join-Path $dir "Reins.lnk"',
    '    if (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk -Force }',
    '  }',
    '}',
  ].join('\n')
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    stdio: 'ignore',
  })
}
