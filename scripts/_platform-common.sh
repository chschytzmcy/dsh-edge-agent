#!/usr/bin/env bash
# _platform-common.sh — shared helpers for the three platform build scripts.
#
# Sourced by build-windows.sh / build-macos.sh / build-linux.sh.
#
# The platform scripts differ ONLY in:
#   - where the DSH runtime lives
#   - the deployment target (desktop profile vs CLI profile)
# The actual compile / stage / tar work lives in scripts/_pack-core.mjs (plain
# Node), so all three produce byte-identical artifacts.
#
# §A: a command must never be a shell STRING that gets word-split. Windows
#     paths contain spaces in BOTH halves ("C:\Program Files\nodejs\node" and
#     "…\DeepSeek Harness\…\pnpm.mjs"). The old build-desktop-bundle.sh
#     stored "$NODE_BIN $cand" in one string and expanded it unquoted — bash
#     split it on spaces and tried to exec "/c/Program". All argv handling
#     now lives in _pack-core.mjs, where arrays are native; this file only
#     ever invokes node with a FIXED script path (no interpolation of
#     user-controlled paths into a command string).

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$REPO/dist"

dsh_log() { echo "==> $*"; }
dsh_warn() { echo "warning: $*" >&2; }
dsh_err() { echo "error: $*" >&2; }

# Locate a usable node. Everything else (pnpm, tar, sha256) is resolved
# inside _pack-core.mjs, which knows the per-platform layouts.
dsh_find_node() {
  NODE_BIN="${NODE_BIN:-}"
  if [ -n "$NODE_BIN" ] && [ -f "$NODE_BIN" ]; then
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    NODE_BIN="$(command -v node)"
    return 0
  fi
  # Fall back to the DSH App runtime (Windows / macOS).
  local local_appdata="${LOCALAPPDATA:-}"
  local_appdata="${local_appdata//\\//}"
  for cand in \
    "$local_appdata/Programs/DeepSeek Harness/resources/runtime/bin/node.exe" \
    "$local_appdata/Programs/DeepSeek Harness/resources/runtime/primary-runtime/dependencies/node/bin/node.exe" \
    "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/bin/node" \
    "$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node" \
    "$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe"; do
    if [ -n "$cand" ] && [ -f "$cand" ]; then
      NODE_BIN="$cand"
      return 0
    fi
  done
  dsh_err "找不到 node。设置 NODE_BIN=/path/to/node"
  return 1
}

# Compile: tsc → lib/, esbuild → lib/client.js. Both halves are required.
dsh_compile() {
  dsh_log "compile (tsc → lib/, esbuild → lib/client.js)"
  "$NODE_BIN" "$REPO/scripts/_pack-core.mjs" compile
}

# Package: installable dirs (link mode) + tarballs (file mode), from ONE
# staging tree so the two artifacts can never drift. Then run the gate.
#
# §7.157: verify-installable walks dist/installable/ ONLY — the tarball was
# never checked by it, so a stale/broken tarball shipped with the whole chain
# green (that is exactly how the pre-§7.153 artifact survived: the preset
# layer was silently missing). verify-tarball is the gate for the OTHER
# artifact, so both are mandatory here.
dsh_package() {
  dsh_log "package (installable dirs + tarballs)"
  "$NODE_BIN" "$REPO/scripts/_pack-core.mjs" all
  "$NODE_BIN" "$REPO/scripts/verify-installable.mjs"
  "$NODE_BIN" "$REPO/scripts/verify-tarball.mjs"
}

# Artifact paths in the form the CONSUMER can paste.
#
# §D: the shell's $DIST is an MSYS2 path on Windows ("/c/Users/…"). The
# desktop App is a native Windows app and rejects that with "a local path
# must be absolute" — it wants "C:\Users\…". Node's path.join produces the
# native form, so the paths come from _pack-core.mjs, not from $DIST.
dsh_load_paths() {
  local out
  out="$("$NODE_BIN" "$REPO/scripts/_pack-core.mjs" paths)"
  INSTALLABLE_DIR="$(printf '%s\n' "$out" | sed -n 's/^INSTALLABLE_DIR=//p' | head -1)"
  INSTALLABLE_DIR_FULL="$(printf '%s\n' "$out" | sed -n 's/^INSTALLABLE_DIR_FULL=//p' | head -1)"
  TARBALL="$(printf '%s\n' "$out" | sed -n 's/^TARBALL=//p' | head -1)"
  TARBALL_FULL="$(printf '%s\n' "$out" | sed -n 's/^TARBALL_FULL=//p' | head -1)"
  export INSTALLABLE_DIR INSTALLABLE_DIR_FULL TARBALL TARBALL_FULL
}

# Artifact summary.
dsh_summary() {
  dsh_load_paths
  cat <<EOF

产物（两种模式同源，均通过 verify-installable + verify-tarball 门禁）：
  tar（分发）  $TARBALL (+ .sha256)
                $TARBALL_FULL (+ .sha256)
  link（开发） $INSTALLABLE_DIR
                $INSTALLABLE_DIR_FULL
EOF
}

# Is the desktop App running? Best-effort — never fails the build.
dsh_app_running() {
  if command -v pgrep >/dev/null 2>&1; then
    pgrep -f 'DeepSeek Harness.app/Contents/MacOS' >/dev/null 2>&1 && return 0
    pgrep -f 'DeepSeek Harness.exe' >/dev/null 2>&1 && return 0
    return 1
  fi
  if command -v tasklist >/dev/null 2>&1; then
    tasklist 2>/dev/null | grep -i 'DeepSeek Harness' >/dev/null && return 0
    return 1
  fi
  return 1
}
