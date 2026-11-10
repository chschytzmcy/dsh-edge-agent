#!/usr/bin/env bash
# Launch DSH dev process with all env vars loaded.
# §7.43 (2026-09-05): 默认 profile = dsh-tui；legacy `dsh-edge-agent` 名已废弃（§7.33 P-structural）。
# 2026-11-10: 仓库路径从硬编码绝对路径改为脚本相对定位；dsh 二进制走 PATH 优先、
# 再退到 ~/.npm-global/bin —— 换机不必再改脚本。
cd "$(dirname "$(readlink -f "$0")")/.." || exit 1
source .env.sh > /tmp/envsh.out 2>&1
DSH_BIN="${DSH_EDGE_BIN:-$(command -v dsh 2>/dev/null || echo "$HOME/.npm-global/bin/dsh")}"
exec "$DSH_BIN" --profile dsh-tui
