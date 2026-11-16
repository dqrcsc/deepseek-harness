#!/usr/bin/env bash
# Zero-admin one-line installer for Reins (macOS arm64 / x64).
# Usage: curl -fsSL https://github.com/dqrcsc/deepseek-harness/releases/latest/download/install.sh | bash

set -euo pipefail

REINS_REPO="${REINS_REPO:-dqrcsc/deepseek-harness}"
REINS_HOME="${REINS_HOME:-$HOME/.reins}"
REINS_GITHUB_MIRROR="${REINS_GITHUB_MIRROR:-}"
REINS_VERSION="${REINS_VERSION:-}"

log_info() {
  printf '\033[1;36m==>\033[0m %s\n' "$*"
}

log_error() {
  printf '\033[1;31merror:\033[0m %s\n' "$*" >&2
}

build_asset_url() {
  local asset_path="${1#/}"
  local canonical="https://github.com/${REINS_REPO}/${asset_path}"
  if [ -n "$REINS_GITHUB_MIRROR" ]; then
    local mirror_trimmed="${REINS_GITHUB_MIRROR%/}"
    case "$mirror_trimmed" in
      *"/${REINS_REPO}") printf '%s/%s' "$mirror_trimmed" "$asset_path" ;;
      *) printf '%s/%s' "$mirror_trimmed" "$canonical" ;;
    esac
  else
    printf '%s' "$canonical"
  fi
}

compute_sha256() {
  local target_file="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$target_file" | awk '{print tolower($1)}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$target_file" | awk '{print tolower($1)}'
  else
    log_error "Neither shasum nor sha256sum is available to verify archive integrity."
    exit 1
  fi
}

resolve_target() {
  if [ -n "${REINS_TARGET:-}" ]; then
    printf '%s' "$REINS_TARGET"
    return
  fi
  local os_name
  os_name="$(uname -s)"
  if [ "$os_name" != "Darwin" ]; then
    log_error "install.sh supports macOS (Darwin); detected ${os_name}. On Windows use install.ps1."
    exit 1
  fi
  local arch_raw
  arch_raw="$(uname -m)"
  if [ "$arch_raw" = "arm64" ] || [ "$arch_raw" = "aarch64" ]; then
    printf 'darwin-arm64'
    return
  fi
  if [ "$arch_raw" = "x86_64" ]; then
    if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || printf '0')" = "1" ]; then
      printf 'darwin-arm64'
    else
      printf 'darwin-x64'
    fi
    return
  fi
  log_error "Unsupported CPU architecture: ${arch_raw}"
  exit 1
}

normalize_version_tag() {
  local raw="$1"
  raw="${raw#reins-}"
  raw="${raw#REINS-}"
  raw="${raw#v}"
  raw="${raw#V}"
  printf 'v%s' "$raw"
}

TARGET="$(resolve_target)"

if [ -n "$REINS_VERSION" ]; then
  NORM_VER="$(normalize_version_tag "$REINS_VERSION")"
  MANIFEST_PATH="releases/download/reins-${NORM_VER}/latest.json"
else
  MANIFEST_PATH="releases/latest/download/latest.json"
fi

MANIFEST_URL="$(build_asset_url "$MANIFEST_PATH")"
TMP_WORK="$(mktemp -d "${TMPDIR:-/tmp}/reins-install.XXXXXX")"
cleanup() {
  rm -rf "$TMP_WORK"
}
trap cleanup EXIT

log_info "正在获取发布清单 (${REINS_REPO}, target=${TARGET})..."
MANIFEST_FILE="$TMP_WORK/latest.json"
curl -fsSL --retry 3 --connect-timeout 15 "$MANIFEST_URL" -o "$MANIFEST_FILE"

COMPACT_JSON="$(tr -d '\r\n\t ' < "$MANIFEST_FILE")"
EDITION_VERSION="$(printf '%s' "$COMPACT_JSON" | sed -n 's/.*"editionVersion":"\([^"]*\)".*/\1/p')"
RELEASE_TAG="$(printf '%s' "$COMPACT_JSON" | sed -n 's/.*"tag":"\([^"]*\)".*/\1/p')"
TARGET_OBJECT="$(printf '%s' "$COMPACT_JSON" | sed -n "s/.*\"${TARGET}\":{\([^}]*\)}.*/\1/p")"
ASSET_FILE="$(printf '%s' "$TARGET_OBJECT" | sed -n 's/.*"file":"\([^"]*\)".*/\1/p')"
EXPECTED_SHA256="$(printf '%s' "$TARGET_OBJECT" | sed -n 's/.*"sha256":"\([^"]*\)".*/\1/p' | tr '[:upper:]' '[:lower:]')"

if [ -z "$EDITION_VERSION" ] || [ -z "$RELEASE_TAG" ] || [ -z "$ASSET_FILE" ] || [ -z "$EXPECTED_SHA256" ]; then
  log_error "无法在 latest.json 中找到适配 ${TARGET} 的发行包记录。"
  exit 1
fi

ARCHIVE_URL="$(build_asset_url "releases/download/${RELEASE_TAG}/${ASSET_FILE}")"
ARCHIVE_PATH="$TMP_WORK/$ASSET_FILE"

log_info "正在下载 执辔 Reins ${EDITION_VERSION} (${ASSET_FILE})..."
curl -fL --retry 3 --connect-timeout 20 "$ARCHIVE_URL" -o "$ARCHIVE_PATH"

log_info "正在校验 SHA-256 完整性..."
ACTUAL_SHA256="$(compute_sha256 "$ARCHIVE_PATH")"
if [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
  log_error "SHA-256 校验失败: 期望 ${EXPECTED_SHA256}，实际 ${ACTUAL_SHA256}"
  exit 1
fi

mkdir -p "$REINS_HOME/releases"
EXTRACT_DIR="$TMP_WORK/extracted"
mkdir -p "$EXTRACT_DIR"
tar -xzf "$ARCHIVE_PATH" -C "$EXTRACT_DIR"

PAYLOAD_DIR="$EXTRACT_DIR"
if [ ! -f "$PAYLOAD_DIR/release.json" ]; then
  FIRST_SUBDIR="$(find "$EXTRACT_DIR" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  if [ -n "$FIRST_SUBDIR" ] && [ -f "$FIRST_SUBDIR/release.json" ]; then
    PAYLOAD_DIR="$FIRST_SUBDIR"
  fi
fi

if command -v xattr >/dev/null 2>&1; then
  xattr -dr com.apple.quarantine "$PAYLOAD_DIR" 2>/dev/null || true
fi
chmod 755 "$PAYLOAD_DIR/node/bin/node"

if [ -f "$REINS_HOME/current" ]; then
  PREV_VER="$(tr -d '\r\n ' < "$REINS_HOME/current")"
  PREV_NODE="$REINS_HOME/releases/$PREV_VER/node/bin/node"
  PREV_CLI="$REINS_HOME/releases/$PREV_VER/supervisor/cli.mjs"
  if [ "$PREV_VER" = "$EDITION_VERSION" ] && [ -x "$PREV_NODE" ] && [ -f "$PREV_CLI" ]; then
    "$PREV_NODE" "$PREV_CLI" --root "$REINS_HOME" stop >/dev/null 2>&1 || true
  fi
fi

SLOT_DIR="$REINS_HOME/releases/$EDITION_VERSION"
rm -rf "$SLOT_DIR"
mv "$PAYLOAD_DIR" "$SLOT_DIR"
printf '%s\n' "$EDITION_VERSION" > "$REINS_HOME/current"

log_info "正在初始化命令入口与后台常驻服务..."
"$SLOT_DIR/node/bin/node" "$SLOT_DIR/supervisor/cli.mjs" --invoked-as reins --root "$REINS_HOME" internal-postinstall
