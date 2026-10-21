#!/usr/bin/env bash
# edge-config-env.sh — source config/edge.json into the shell as env vars.
#
# §7.102 (2026-10-21): the repo's `.env` / `.env.sh` pair is gone — runtime
# configuration lives in config/edge.json. The e2e / bench scripts still
# need plain shell variables (they call curl / python / the dsh CLI
# directly), so this helper exports the file's values under the SAME
# DSH_EDGE_* names the plugins already understand (edge-config.ts's
# ENV_OVERRIDES layer maps them back onto the file view).
#
# Usage:
#   source scripts/edge-config-env.sh                  # default config/edge.json
#   source scripts/edge-config-env.sh /path/to/edge.json
#
# Nothing is exported when the file is absent — callers keep their own
# fallbacks (the bench scripts print a WARN in that case).

_edge_config_env_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)"

if command -v node >/dev/null 2>&1; then
  _edge_config_env_exports="$(
    node "${_edge_config_env_dir}/edge-config-env.mjs" "${1:-}" 2>/dev/null
  )"
  if [ -n "$_edge_config_env_exports" ]; then
    eval "$_edge_config_env_exports"
    unset _edge_config_env_exports
  else
    unset _edge_config_env_exports
  fi
else
  echo "[edge-config-env] node not found — config/edge.json not exported" >&2
fi

unset _edge_config_env_dir
