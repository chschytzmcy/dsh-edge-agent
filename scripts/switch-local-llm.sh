#!/usr/bin/env bash
# switch-local-llm.sh — 一键切换 local LLM 池配置(§7.87.6 配套)
#
# 用途: 避免手动编辑 .env 的 LOCAL_LLM_* 块来回切 LAN 模型。
# 流程:  cp .env.local-<name> .env  &&  bash scripts/dev-restart.sh
# 前提:  .env.local-<name> 快照已存在(repo root)
#
# 用法:
#   bash scripts/switch-local-llm.sh                 # 列可用快照
#   bash scripts/switch-local-llm.sh qwen3.5-9b      # 切到 qwen3.5-9b
#   bash scripts/switch-local-llm.sh minicpm5-2b     # 切到 minicpm5-2b
#
# 不传参 → 打印当前 .env 激活的 LOCAL_LLM_BASEURL + 列出所有快照

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# 当前激活的 LOCAL baseUrl
current_url=$(grep '^LOCAL_LLM_BASEURL=' .env 2>/dev/null | cut -d= -f2- || echo '<unset>')

# 列所有 .env.local-* 快照
snapshots=(.env.local-*)
names=()
for f in "${snapshots[@]}"; do
  if [[ -f "$f" ]]; then
    n="${f#.env.local-}"
    names+=("$n")
  fi
done

usage_and_list() {
  echo "Current LOCAL_LLM_BASEURL: ${current_url}"
  echo
  echo "Available snapshots:"
  for n in "${names[@]}"; do
    snap_url=$(grep '^LOCAL_LLM_BASEURL=' ".env.local-$n" | cut -d= -f2-)
    snap_model=$(grep '^LOCAL_LLM_MODEL=' ".env.local-$n" | cut -d= -f2-)
    marker=""
    if [[ "$snap_url" == "$current_url" ]]; then marker=" ← current"; fi
    echo "  $n  →  $snap_url  ($snap_model)$marker"
  done
  echo
  echo "Usage: bash scripts/switch-local-llm.sh <name>"
  exit 0
}

# 无参 → 列快照
if [[ $# -eq 0 ]]; then
  usage_and_list
fi

target="$1"
snap_file=".env.local-${target}"

# 快照必须存在
if [[ ! -f "$snap_file" ]]; then
  echo "✗ snapshot not found: $snap_file" >&2
  echo "available: ${names[*]}" >&2
  exit 1
fi

# §7.76 destructive default backup (memory `destructive-default-backup`)
backup=".env.uninstall-backup.$(date +%Y%m%d-%H%M%S)"
cp .env "$backup"
echo "✓ backup: .env → $backup"

# 切快照
cp "$snap_file" .env
echo "✓ switched: .env ← $snap_file"

# 触发 dev-restart(改 env 必须重启进程才生效,见 memory `env-default-restart-required`)
echo
echo "→ running scripts/dev-restart.sh (env changes need process restart)"
bash scripts/dev-restart.sh