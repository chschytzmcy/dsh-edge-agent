#!/usr/bin/env bash
# dev-restart.sh — thin wrapper around install.sh for fast iteration.
#
# Skips the pnpm install step (assumes the package is already mounted in
# $DSH_HOME/profiles/dsh-tui/node_modules) and runs compile + rsync +
# patch-sync + restart via the shared deploy pipeline.
#
# 2026-09-11 (§7.43): 默认从 --profiles=dsh-tui,web 并存启动取代 --with-web。
# dev-restart.sh 直接继承 install.sh 默认（--profiles=dsh-tui,web）。

set -euo pipefail
exec "$(cd "$(dirname "$0")/.." && pwd)/install.sh" --skip-pnpm "$@"
