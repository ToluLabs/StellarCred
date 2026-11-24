#!/usr/bin/env bash
# scripts/ci-cache-helpers.sh
#
# Centralized CI cache helpers and common presteps for Soroban contract builds.
# Used by .github/workflows/contracts-ci.yml and the Makefile so local runs and
# CI share one code path.
#
# Usage:
#   bash scripts/ci-cache-helpers.sh <command>
#
# Commands:
#   prepare      run common presteps (wasm target + toolchain info)
#   cache-key    print the Cargo target cache key
#   cache-paths  print the cache paths, one per line
#   restore      restore the local target cache archive, if present
#   save         save the target directory to a local cache archive
#   invalidate   remove the target directory and its cache archive
#   build-fast   quick Soroban wasm build reusing the local cargo cache
#   report       print a short cache status summary
#
# The functions can also be sourced: `source scripts/ci-cache-helpers.sh`.

set -euo pipefail

REPO_ROOT_DIR="${REPO_ROOT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
CI_CACHE_ROOT="${CI_CACHE_ROOT:-${RUNNER_TEMP:-/tmp}/contracts-ci-cache}"
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-target}"
case "$CARGO_TARGET_DIR" in
  /*) ;;
  *) CARGO_TARGET_DIR="${REPO_ROOT_DIR}/${CARGO_TARGET_DIR}" ;;
esac
CI_TOOLCHAIN_FILE="${CI_TOOLCHAIN_FILE:-${REPO_ROOT_DIR}/rust-toolchain.toml}"

ci_log() {
  printf '[ci-cache] %s\n' "$*" >&2
}

# Rust toolchain used in the cache key: rust-toolchain.toml channel, else rustc.
ci_toolchain_version() {
  if [ -f "$CI_TOOLCHAIN_FILE" ]; then
    local channel
    channel="$(sed -nE 's/^[[:space:]]*channel[[:space:]]*=[[:space:]]*"?([^"[:space:]]+)"?.*$/\1/p' "$CI_TOOLCHAIN_FILE" | head -n1)"
    if [ -n "$channel" ]; then
      echo "$channel"
      return 0
    fi
  fi
  if command -v rustc >/dev/null 2>&1; then
    rustc --version | awk '{print $2}'
    return 0
  fi
  echo "unknown"
}

# Cargo.lock fingerprint used in the cache key.
ci_lockfile_hash() {
  local lock="${REPO_ROOT_DIR}/Cargo.lock"
  if [ ! -f "$lock" ]; then
    echo "nolock"
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$lock" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$lock" | awk '{print $1}'
  else
    echo "nohash"
  fi
}

ci_cache_key() {
  echo "cargo-target-$(ci_toolchain_version)-$(ci_lockfile_hash)"
}

ci_cache_paths() {
  echo "$CARGO_TARGET_DIR"
  echo "${CARGO_HOME:-$HOME/.cargo}/registry"
  echo "${CARGO_HOME:-$HOME/.cargo}/git"
}

ci_cache_archive() {
  echo "${CI_CACHE_ROOT}/$(ci_cache_key).tar.gz"
}

ci_cache_restore() {
  local archive
  archive="$(ci_cache_archive)"
  if [ ! -f "$archive" ]; then
    ci_log "no cache archive at $archive (miss)"
    return 0
  fi
  ci_log "cache hit: restoring $archive"
  mkdir -p "$CARGO_TARGET_DIR"
  tar -xzf "$archive" -C "$CARGO_TARGET_DIR"
  ci_log "cache restored"
}

ci_cache_save() {
  local archive
  archive="$(ci_cache_archive)"
  if [ ! -d "$CARGO_TARGET_DIR" ]; then
    ci_log "no target directory to save at $CARGO_TARGET_DIR"
    return 0
  fi
  mkdir -p "$CI_CACHE_ROOT"
  ci_log "saving cache to $archive"
  tar -czf "$archive" -C "$CARGO_TARGET_DIR" .
  ci_log "cache saved"
}

ci_cache_invalidate() {
  ci_log "invalidating local cargo cache"
  rm -rf "$CARGO_TARGET_DIR"
  rm -f "$(ci_cache_archive)"
}

ci_prestep() {
  ci_log "running presteps"
  if command -v rustup >/dev/null 2>&1; then
    rustup target add wasm32v1-none >/dev/null 2>&1 || ci_log "could not add wasm32v1-none target (will be installed by toolchain step)"
  fi
  if command -v cargo >/dev/null 2>&1; then
    cargo --version >&2
  fi
  ci_log "cache key: $(ci_cache_key)"
  ci_log "presteps complete"
}

ci_build_fast() {
  ci_log "quick Soroban build (reusing cache at $CARGO_TARGET_DIR)"
  (cd "$REPO_ROOT_DIR" && cargo build --release --target wasm32v1-none --locked)
}

ci_report() {
  local size="empty"
  if [ -d "$CARGO_TARGET_DIR" ]; then
    size="$(du -sh "$CARGO_TARGET_DIR" 2>/dev/null | awk '{print $1}')"
  fi
  ci_log "cache key: $(ci_cache_key)"
  ci_log "target dir: $CARGO_TARGET_DIR ($size)"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      echo "### Contracts cargo cache"
      echo "- key: \`$(ci_cache_key)\`"
      echo "- target dir size: $size"
    } >> "$GITHUB_STEP_SUMMARY"
  fi
}

# Dispatch when executed directly.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  cmd="${1:-}"
  case "$cmd" in
    prepare|prestep) ci_prestep ;;
    cache-key) ci_cache_key ;;
    cache-paths) ci_cache_paths ;;
    restore|cache-restore) ci_cache_restore ;;
    save|cache-save) ci_cache_save ;;
    invalidate|cache-invalidate) ci_cache_invalidate ;;
    build-fast) ci_build_fast ;;
    report) ci_report ;;
    *)
      echo "Usage: $0 {prepare|cache-key|cache-paths|restore|save|invalidate|build-fast|report}" >&2
      exit 1
      ;;
  esac
fi
