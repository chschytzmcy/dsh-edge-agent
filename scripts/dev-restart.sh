#!/usr/bin/env bash
# dev-restart.sh — thin wrapper around install.sh for fast iteration.
#
# Skips the pnpm install step (assumes the package is already mounted in
# $DSH_HOME/profiles/<name>/node_modules) and runs compile + rsync +
# patch-sync + restart via the shared deploy pipeline.
#
# Usage: ./scripts/dev-restart.sh [profile-name]

set -euo pipefail
PROFILE="${1:-dsh-edge-profile}"
PROFILE="${PROFILE/dsh-edge-profile/dsh-edge-agent}"
exec "$(cd "$(dirname "$0")/.." && pwd)/install.sh" --skip-pnpm "$PROFILE"