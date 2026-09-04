#!/usr/bin/env bash
# dev-restart.sh — thin wrapper around install.sh for fast iteration.
#
# Skips the pnpm install step (assumes the package is already mounted in
# $DSH_HOME/profiles/web/node_modules) and runs compile + rsync +
# patch-sync + restart via the shared deploy pipeline.
#
# 2026-09-03 (§7.31): dsh-edge-agent bundle 仅装 web profile；positional
# arg 已废弃（dev-restart.sh 默认 web profile）。

set -euo pipefail
exec "$(cd "$(dirname "$0")/.." && pwd)/install.sh" --skip-pnpm
