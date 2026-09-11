#!/usr/bin/env bash
# Launch DSH dev process with all env vars loaded.
# §7.43 (2026-09-05): 默认 profile = dsh-tui；legacy `dsh-edge-agent` 名已废弃（§7.33 P-structural）。
cd /home/etsme/cy/agent/dsh-edge-agent || exit 1
source .env.sh > /tmp/envsh.out 2>&1
exec /home/etsme/.npm-global/bin/dsh --profile dsh-tui
