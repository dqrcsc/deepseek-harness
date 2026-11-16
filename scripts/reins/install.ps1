# Zero-admin one-line installer for Reins (Windows x64).
# Usage: irm https://github.com/dqrcsc/deepseek-harness/releases/latest/download/install.ps1 | iex

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$ReinsRepo = if ($env:REINS_REPO) { $env:REINS_REPO.Trim() } else { 'dqrcsc/deepseek-harness' }
$ReinsHome = if ($env:REINS_HOME) {
  $env:REINS_HOME.Trim()
} elseif ($env:LOCALAPPDATA) {
  Join-Path $env:LOCALAPPDATA 'Reins'
} else {
  Join-Path $HOME 'AppData\Local\Reins'
}
$Mirror = if ($env:REINS_GITHUB_MIRROR) { $env:REINS_GITHUB_MIRROR.Trim().TrimEnd('/') } else { '' }
$RequestedVersion = if ($env:REINS_VERSION) { $env:REINS_VERSION.Trim() } else { '' }
$Target = 'win32-x64'

function Write-ReinsStep([string]$Message) {
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Get-AssetUrl([string]$AssetPath) {
  $Clean = $AssetPath.TrimStart('/')
  $Canonical = "https://github.com/$ReinsRepo/$Clean"
  if (-not $Mirror) { return $Canonical }
  if ($Mirror.Contains('{url}')) { return $Mirror.Replace('{url}', $Canonical) }
  if ($Mirror.EndsWith("/$ReinsRepo")) { return "$Mirror/$Clean" }
  return "$Mirror/$Canonical"
}

function ConvertTo-NormalizedVersion([string]$Raw) {
  $Stripped = $Raw -replace '^(?i)reins-', ''
  $Stripped = $Stripped -replace '^(?i)v', ''
  return "v$Stripped"
}

$ManifestPath = if ($RequestedVersion) {
  $Norm = ConvertTo-NormalizedVersion $RequestedVersion
  "releases/download/reins-$Norm/latest.json"
} else {
  'releases/latest/download/latest.json'
}

$TempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("reins-install-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $TempRoot -Force | Out-Null

try {
  $ManifestUrl = Get-AssetUrl $ManifestPath
  Write-ReinsStep "正在获取发布清单 ($ReinsRepo, target=$Target)..."
  $ManifestFile = Join-Path $TempRoot 'latest.json'
  Invoke-WebRequest -Uri $ManifestUrl -OutFile $ManifestFile -UseBasicParsing

  $Manifest = Get-Content -LiteralPath $ManifestFile -Raw -Encoding UTF8 | ConvertFrom-Json
  $EditionVersion = [string]$Manifest.editionVersion
  $ReleaseTag = [string]$Manifest.tag
  $Asset = $Manifest.assets.$Target
  if (-not $EditionVersion -or -not $ReleaseTag -or -not $Asset) {
    throw "latest.json 中未包含 $Target 架构的发行包。"
  }

  $AssetFile = [string]$Asset.file
  $ExpectedSha256 = ([string]$Asset.sha256).ToLowerInvariant()
  $ArchiveUrl = Get-AssetUrl "releases/download/$ReleaseTag/$AssetFile"
  $ArchivePath = Join-Path $TempRoot $AssetFile

  Write-ReinsStep "正在下载 执辔 Reins $EditionVersion ($AssetFile)..."
  Invoke-WebRequest -Uri $ArchiveUrl -OutFile $ArchivePath -UseBasicParsing

  Write-ReinsStep "正在校验 SHA-256 完整性..."
  $ActualSha256 = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($ActualSha256 -ne $ExpectedSha256) {
    throw "SHA-256 校验失败: 期望 $ExpectedSha256，实际 $ActualSha256"
  }

  $ExtractDir = Join-Path $TempRoot 'extracted'
  New-Item -ItemType Directory -Path $ExtractDir -Force | Out-Null
  $SystemTar = Join-Path $env:SystemRoot 'System32\tar.exe'
  $ExtractedByTar = $false
  if (Test-Path -LiteralPath $SystemTar) {
    & $SystemTar -xf $ArchivePath -C $ExtractDir
    if ($LASTEXITCODE -eq 0) { $ExtractedByTar = $true }
  }
  if (-not $ExtractedByTar) {
    Expand-Archive -LiteralPath $ArchivePath -DestinationPath $ExtractDir -Force
  }

  $PayloadDir = $ExtractDir
  if (-not (Test-Path -LiteralPath (Join-Path $PayloadDir 'release.json'))) {
    $SubDirs = @(Get-ChildItem -LiteralPath $ExtractDir -Directory)
    if ($SubDirs.Count -eq 1 -and (Test-Path -LiteralPath (Join-Path $SubDirs[0].FullName 'release.json'))) {
      $PayloadDir = $SubDirs[0].FullName
    }
  }

  $ReleasesDir = Join-Path $ReinsHome 'releases'
  New-Item -ItemType Directory -Path $ReleasesDir -Force | Out-Null

  $CurrentFile = Join-Path $ReinsHome 'current'
  if (Test-Path -LiteralPath $CurrentFile) {
    $PrevVer = (Get-Content -LiteralPath $CurrentFile -Raw -Encoding UTF8).Trim()
    $PrevNode = Join-Path $ReleasesDir "$PrevVer\node\bin\node.exe"
    $PrevCli = Join-Path $ReleasesDir "$PrevVer\supervisor\cli.mjs"
    if ($PrevVer -eq $EditionVersion -and (Test-Path -LiteralPath $PrevNode) -and (Test-Path -LiteralPath $PrevCli)) {
      & $PrevNode $PrevCli --root $ReinsHome stop *> $null
    }
  }

  $SlotDir = Join-Path $ReleasesDir $EditionVersion
  if (Test-Path -LiteralPath $SlotDir) {
    Remove-Item -LiteralPath $SlotDir -Recurse -Force
  }
  Move-Item -LiteralPath $PayloadDir -Destination $SlotDir

  [System.IO.File]::WriteAllText($CurrentFile, "$EditionVersion`n", [System.Text.UTF8Encoding]::new($false))

  Write-ReinsStep "正在初始化命令入口、桌面快捷方式与后台常驻服务..."
  $NodeExe = Join-Path $SlotDir 'node\bin\node.exe'
  $CliMjs = Join-Path $SlotDir 'supervisor\cli.mjs'
  & $NodeExe $CliMjs --invoked-as reins --root $ReinsHome internal-postinstall
  if ($LASTEXITCODE -ne 0) {
    throw "初始化失败 (exit code $LASTEXITCODE)"
  }
} finally {
  if (Test-Path -LiteralPath $TempRoot) {
    Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
