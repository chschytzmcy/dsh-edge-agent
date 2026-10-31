#!/usr/bin/env bash
# deploy-profile.sh — one-shot deployment of a repo-owned profile.
#
# §7.107 (2026-10-24): the desktop deployment had grown into a pile of
# hand-run steps (build → repackage → move the installed package aside →
# `dsh plugin install` → copy config files → restart → verify). Each step
# was individually necessary and collectively unreproducible — the "pnpm
# does not re-extract a changed tarball" trap in particular silently kept
# the OLD bundle in the profile. This script is the one command.
#
# Usage:
#   bash scripts/deploy-profile.sh dsh-edge-agent [options]
#
# Options:
#   --no-build     reuse the existing lib/ (skip the TS compile)
#   --no-restart   deploy the files but do not (re)start the profile
#   --help
#
# What it does, in order:
#   1. build the desktop-safe bundle (lib/ → dist/*.tar.gz) if needed
#   2. create/update ~/.dsh/profiles/<name>/ from profiles/<name>/
#      (package.json skeleton + the profile's own cordis.patch.yml overlay)
#   3. install the bundle INTO the profile (and force the re-extract that
#      pnpm will not do on its own for a changed `file:` tarball)
#   4. sync the shipped runtime config:
#        config/privacy-policy.json → ~/.dsh-edge-agent/privacy-policy.json
#        config/edge.json            → ~/.dsh-edge-agent/edge.json
#      The operator's LIVE secrets in ~/.dsh-edge-agent/edge.json always
#      win — a deploy must never clobber a rotated API key.
#   5. (re)start the profile: `dsh --profile <name>` detached
#   6. verify: the profile is up, and — if it serves HTTP — /v1/health
#      answers with the configured bearer token
#
# The profile's bundle variant: repo-owned profiles get the DESKTOP-SAFE
# bundle (insert-only, no host rewrites) plus their own cordis.patch.yml
# overlay. That is what makes `dsh-edge-agent` the same edge logic as the
# desktop, exposed over HTTP — see profiles/dsh-edge-agent/cordis.patch.yml.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE=""
DO_BUILD=1
DO_RESTART=1
VARIANT="desktop-safe"

for arg in "$@"; do
  case "$arg" in
    --no-build)   DO_BUILD=0 ;;
    --no-restart) DO_RESTART=0 ;;
    --help|-h)    sed -n '2,40p' "$0"; exit 0 ;;
    -*)           echo "unknown option: $arg" >&2; exit 2 ;;
    *)            PROFILE="$arg" ;;
  esac
done
if [ -z "$PROFILE" ]; then
  echo "usage: bash scripts/deploy-profile.sh <profile> [--no-build] [--no-restart]" >&2
  echo "repo-owned profiles: $(ls "$REPO/profiles" 2>/dev/null | tr '\n' ' ')" >&2
  exit 2
fi

PROFILE_DIR="$HOME/.dsh/profiles/$PROFILE"
PROFILE_SRC="$REPO/profiles/$PROFILE"
TARBALL="$REPO/dist/dsh-edge-agent-$VARIANT.tar.gz"
LOG="$PROFILE_DIR/run.log"

# ── 0. preflight ───────────────────────────────────────────────────────
DSH_BIN="${DSH_EDGE_BIN:-}"
if [ -z "$DSH_BIN" ]; then
  for cand in \
    "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
    "$HOME/.npm-global/bin/dsh" \
    "$(command -v dsh 2>/dev/null || true)"; do
    [ -n "$cand" ] && [ -x "$cand" ] && DSH_BIN="$cand" && break
  done
fi
[ -n "$DSH_BIN" ] && [ -x "$DSH_BIN" ] || { echo "error: dsh CLI not found (set DSH_EDGE_BIN)" >&2; exit 1; }
NODE_BIN="${NODE_BIN:-}"
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node 2>/dev/null || true)"
  [ -z "$NODE_BIN" ] && for cand in \
    "$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node" \
    "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/bin/node"; do
    [ -x "$cand" ] && NODE_BIN="$cand" && break
  done
fi
[ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || { echo "error: node not found (set NODE_BIN)" >&2; exit 1; }
export PATH="$(dirname "$NODE_BIN"):$PATH"

echo "==> profile : $PROFILE"
echo "==> dsh     : $DSH_BIN"
echo "==> node    : $NODE_BIN"

# ── 1. build the bundle ────────────────────────────────────────────────
if [ "$DO_BUILD" = 1 ]; then
  echo "==> [1/5] build"
  ( cd "$REPO" && node "$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs" run build ) \
    || { echo "error: build failed" >&2; exit 1; }
fi
echo "==> [1/5] packaging the $VARIANT bundle"
( cd "$REPO" && bash scripts/build-desktop-bundle.sh --no-build --emit-dir >/dev/null )
[ -f "$TARBALL" ] || { echo "error: $TARBALL not produced" >&2; exit 1; }

# ── 2. profile skeleton + overlay ──────────────────────────────────────
echo "==> [2/5] profile files → $PROFILE_DIR"
mkdir -p "$PROFILE_DIR"
if [ -f "$PROFILE_SRC/cordis.patch.yml" ]; then
  cp "$PROFILE_SRC/cordis.patch.yml" "$PROFILE_DIR/cordis.patch.yml"
  echo "        cordis.patch.yml ← profiles/$PROFILE/cordis.patch.yml"
else
  echo "        (no profiles/$PROFILE/cordis.patch.yml — keeping the profile's own)"
fi
if [ -f "$PROFILE_SRC/package.json" ]; then
  # Merge the repo skeleton into the profile's package.json without
  # clobbering what the plugin manager wrote (the dependency spec).
  "$NODE_BIN" - "$PROFILE_SRC/package.json" "$PROFILE_DIR/package.json" <<'NODEEOF'
const fs = require('node:fs')
const [src, dst] = process.argv.slice(2)
const skeleton = JSON.parse(fs.readFileSync(src, 'utf8'))
let profile = { name: skeleton.name, private: true, dependencies: {} }
try { profile = JSON.parse(fs.readFileSync(dst, 'utf8')) } catch { /* first deploy */ }
profile.name = skeleton.name
profile.private = true
profile.dsh = profile.dsh ?? {}
profile.dsh.profile = { ...(profile.dsh.profile ?? {}), ...(skeleton.dsh?.profile ?? {}) }
fs.writeFileSync(dst, JSON.stringify(profile, null, 2) + '\n')
NODEEOF
  echo "        package.json ← profiles/$PROFILE/package.json (bundles merged)"
fi

# ── 3. install the bundle (and force the re-extract) ───────────────────
echo "==> [3/5] install bundle → $PROFILE_DIR"
NESTED="$PROFILE_DIR/node_modules/@deepseek-harness-edge-agent/dsh-edge-agent"
# pnpm does NOT re-extract a `file:` tarball whose CONTENT changed — it
# updates the lockfile's integrity and then says "Already up to date",
# leaving the profile running the old bundle. Moving the installed copy
# aside first is what forces the re-extract.
if [ -d "$NESTED" ]; then
  mv "$NESTED" "$NESTED.old-$(date +%s)"
fi
"$DSH_BIN" plugin --profile "$PROFILE" add "file:$TARBALL" >/dev/null 2>&1 \
  || { echo "error: dsh plugin add failed" >&2; exit 1; }
rm -rf "$PROFILE_DIR/node_modules/.ignored/@deepseek-harness-edge-agent"
# The mv-aside trick is NOT enough: pnpm keys its content store by the file:
# SPEC PATH + version, and our version string never changes (0.1.1-desktop-safe
# / 0.1.1-full), so a rebuilt tarball at the same path "reuses" the OLD bytes
# (measured 2026-10-30: the §7.153 array-form patch fix never reached the live
# profile — `reused 1` + an extraction dated three days earlier). Override the
# install dir with the bytes of THIS tarball, bypassing every pnpm cache layer.
TMPX="$(mktemp -d)"
tar -xzf "$TARBALL" -C "$TMPX"
rm -rf "$NESTED"
mv "$TMPX/package" "$NESTED"
rmdir "$TMPX"
# Drift guard: what landed in the profile must equal what we packaged.
if ! diff <(tar -xzf "$TARBALL" -O package/package.json) "$NESTED/package.json" >/dev/null; then
  echo "error: installed package.json diverges from the tarball" >&2; exit 1
fi
[ -d "$NESTED/lib" ] || { echo "error: bundle not installed at $NESTED" >&2; exit 1; }
echo "        installed: $NESTED (bytes forced from tarball, package.json drift-checked)"

# ── 4. shipped runtime config ──────────────────────────────────────────
echo "==> [4/5] runtime config"
EDGE_HOME="$HOME/.dsh-edge-agent"
mkdir -p "$EDGE_HOME"
if [ -f "$REPO/config/privacy-policy.json" ]; then
  cp "$REPO/config/privacy-policy.json" "$EDGE_HOME/privacy-policy.json"
  echo "        privacy-policy.json → $EDGE_HOME/"
fi
if [ -f "$REPO/config/edge.json" ]; then
  # The operator's LIVE secrets win: a deploy must not clobber a rotated
  # API key. Everything else follows the repo copy.
  "$NODE_BIN" - "$REPO/config/edge.json" "$EDGE_HOME/edge.json" <<'NODEEOF'
const fs = require('node:fs')
const [src, dst] = process.argv.slice(2)
const repo = JSON.parse(fs.readFileSync(src, 'utf8'))
let home = {}
try { home = JSON.parse(fs.readFileSync(dst, 'utf8')) } catch { /* first deploy */ }
const secrets = { ...(repo.secrets ?? {}) }
for (const [k, v] of Object.entries(home.secrets ?? {})) {
  if (v !== undefined && v !== null && v !== '') secrets[k] = v
}
repo.secrets = secrets
fs.writeFileSync(dst, JSON.stringify(repo, null, 2) + '\n')
NODEEOF
  echo "        edge.json → $EDGE_HOME/ (live secrets preserved)"
fi

# ── 5. (re)start + verify ──────────────────────────────────────────────
if [ "$DO_RESTART" = 0 ]; then
  echo "==> [5/5] --no-restart — start it with: $DSH_BIN --profile $PROFILE"
  exit 0
fi

echo "==> [5/5] restart"
# §7.100/§DELEGATE (2026-10-24): the DELEGATE chain resolves to the HOST
# provider route (deepseek-official), whose key lives in the host adapter's
# credentials service — which a headless profile has NOT populated (the web
# Models page writes it; the CLI cannot). Inject DEEPSEEK_API_KEY from
# edge.json secrets into the launch environment; an explicitly exported
# value wins.
if [ -z "${DEEPSEEK_API_KEY:-}" ] && [ -f "$EDGE_HOME/edge.json" ]; then
  DEEPSEEK_API_KEY="$("$NODE_BIN" -p "JSON.parse(require('fs').readFileSync('$EDGE_HOME/edge.json','utf8')).secrets?.deepseekApiKey || ''" 2>/dev/null || true)"
  [ -n "$DEEPSEEK_API_KEY" ] && export DEEPSEEK_API_KEY && echo "        DEEPSEEK_API_KEY ← edge.json secrets (headless DELEGATE credential)"
fi
pids="$(ps -eo pid,command 2>/dev/null | grep -F -- "--profile $PROFILE" | grep -v grep | awk '{print $1}' || true)"
if [ -n "$pids" ]; then
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  for _ in 1 2 3 4 5; do
    sleep 1
    ps -eo pid,command 2>/dev/null | grep -F -- "--profile $PROFILE" | grep -qv grep || break
  done
fi
mkdir -p "$(dirname "$LOG")"
DSH_EDGE_LOG_FILE=force nohup "$DSH_BIN" --profile "$PROFILE" > "$LOG" 2>&1 &
disown 2>/dev/null || true

up=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  # The app's `dsh` CLI IS the "DeepSeek Harness" binary — the command line
  # has no "node" in it, so a "node.*dsh --profile X" pattern never matched
  # and the script reported a healthy profile as "did not come up".
  if ps -eo pid,command 2>/dev/null | grep -F -- "--profile $PROFILE" | grep -qv grep; then up=1; break; fi
done
[ "$up" = 1 ] || { echo "error: the profile did not come up (see $LOG)" >&2; tail -20 "$LOG" >&2; exit 1; }
echo "        up (log: $LOG)"

# HTTP verification — only meaningful if the profile serves HTTP.
HTTP_HOST="127.0.0.1"
HTTP_PORT=""
if [ -f "$EDGE_HOME/edge.json" ]; then
  HTTP_HOST="$("$NODE_BIN" -p "JSON.parse(require('fs').readFileSync('$EDGE_HOME/edge.json','utf8')).http?.host || '127.0.0.1'")"
  HTTP_PORT="$("$NODE_BIN" -p "JSON.parse(require('fs').readFileSync('$EDGE_HOME/edge.json','utf8')).http?.port || ''")"
fi
if [ -n "$HTTP_PORT" ]; then
  TOKEN="$("$NODE_BIN" -p "JSON.parse(require('fs').readFileSync('$EDGE_HOME/edge.json','utf8')).secrets?.edgeApiKey || ''")"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 1
    code="$(curl -s -o /tmp/dsh-health.$$ -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://$HTTP_HOST:$HTTP_PORT/v1/health" 2>/dev/null || echo 000)"
    [ "$code" = "200" ] && break
  done
  if [ "$code" = "200" ]; then
    echo "        GET /v1/health → 200 $(cat /tmp/dsh-health.$$)"
  else
    echo "        GET /v1/health → $code (no listener? the profile may not mount http-api)"
  fi
  rm -f /tmp/dsh-health.$$
fi
echo "==> done: $PROFILE"
