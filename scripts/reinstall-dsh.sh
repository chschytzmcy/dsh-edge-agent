#!/usr/bin/env bash
# 干净卸载 dsh + 重装到项目契约版本 0.1.2-rc.1
#
# 目标版本（来自 src/dsh-adapter/contract.ts:12 UPSTREAM_VALIDATED_VERSION）
#   @deepseek-ai/dsh          = 0.1.2-rc.1
#   @deepseek-harness-tui/dsh-tui = 0.10.0-beta.4（npm 上唯一 available tag）
#
# 流程：
#   1. 停所有 dsh 进程
#   2. 备份 ~/.dsh / ~/.dsh-edge-agent 到带时间戳目录
#   3. 卸载全局 @deepseek-ai/dsh 和 @deepseek-harness-tui/dsh-tui
#   4. 重装 dsh@0.1.2-rc.1 + dsh-tui@0.10.0-beta.4
#   5. 跑项目 ./install.sh（§7.43 默认并存装 dsh-tui + web）
#   6. 验证 dsh-tui（primary，mandatory）+ web（并存部署后默认也启）
#
# 用法：
#   bash scripts/reinstall-dsh.sh              # 跑全流程
#   bash scripts/reinstall-dsh.sh --dry-run    # 只打印命令不执行
#   bash scripts/reinstall-dsh.sh --with-web   # 已 deprecated，等价无 flag（install.sh 默认并存）

set -euo pipefail

DSH_VERSION="0.1.2-rc.1"
DSH_TUI_VERSION="0.10.0-beta.4"
BACKUP_TS="$(date +%Y%m%d-%H%M%S)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
DSH_EDGE_HOME="${HOME}/.dsh-edge-agent"

log()  { printf '\033[1;34m[step]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[ ok ]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[ err]\033[0m %s\n' "$*" >&2; }

DRY_RUN=0
DO_WEB=0
for _arg in "$@"; do
  case "$_arg" in
    --dry-run) DRY_RUN=1 ;;
    --with-web) DO_WEB=1 ;;  # backward-compat shim: 现在 install.sh --profiles=dsh-tui,web 等价
  esac
done
if (( DRY_RUN )); then
  warn "dry-run 模式：只打印命令，不实际执行"
fi

run() {
  if (( DRY_RUN )); then
    echo "  $*"
  else
    "$@"
  fi
}

# ── 1. 停 dsh 进程 ─────────────────────────────────────────────────────────
log "1/6 停止所有 dsh 进程"
if pgrep -f "dsh --profile" >/dev/null 2>&1; then
  run pkill -f "dsh --profile" || true
  sleep 1
  ok "已停止"
else
  ok "无 dsh 进程在跑"
fi

# ── 2. 备份数据目录 ────────────────────────────────────────────────────────
log "2/6 备份用户数据"
for d in "$DSH_HOME" "$DSH_EDGE_HOME"; do
  if [[ -d "$d" ]]; then
    target="${d}.bak-${BACKUP_TS}"
    run mv "$d" "$target"
    ok "已备份 $d → $target ($(du -sh "$target" 2>/dev/null | cut -f1))"
  else
    warn "$d 不存在，跳过备份"
  fi
done

# ── 3. 卸载全局 dsh + dsh-tui ──────────────────────────────────────────────
log "3/6 卸载全局 @deepseek-ai/dsh + @deepseek-harness-tui/dsh-tui"
run npm uninstall -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui
ok "已卸载（npm 自带清理）"

# npm uninstall 对嵌套 node_modules 的清理常常不干净（残留 ENOTEMPTY 空
# 目录会让下次 install 直接 ENOENT）。手工再清一次残留目录。
_NPM_GLOBAL_PREFIX="$(npm config get prefix 2>/dev/null)"
_NPM_GLOBAL_PREFIX="${_NPM_GLOBAL_PREFIX:-$HOME/.npm-global}"
for stale in \
  "${_NPM_GLOBAL_PREFIX}/lib/node_modules/@deepseek-ai/dsh" \
  "${_NPM_GLOBAL_PREFIX}/lib/node_modules/@deepseek-harness-tui/dsh-tui"; do
  if [[ -d "$stale" ]]; then
    run rm -rf "$stale"
    ok "已清残留：$stale"
  fi
done

# 清 npm cache（避免陈年 cache 影响重装）
log "清理 npm 缓存"
run npm cache clean --force 2>/dev/null || true

# ── 4. 重装目标版本 ────────────────────────────────────────────────────────
log "4/6 安装 @deepseek-ai/dsh@${DSH_VERSION}"
run npm install -g "@deepseek-ai/dsh@${DSH_VERSION}"

log "4/6 安装 @deepseek-harness-tui/dsh-tui@${DSH_TUI_VERSION}"
run npm install -g "@deepseek-harness-tui/dsh-tui@${DSH_TUI_VERSION}"

# 验证安装
if command -v dsh >/dev/null 2>&1; then
  ok "dsh 已安装：$(dsh --version 2>&1)"
else
  err "dsh 安装后仍找不到二进制，请检查 npm 全局 bin 是否在 PATH"
  exit 1
fi

# ── 5. 重装 dsh-edge-agent bundle ──────────────────────────────────────────
log "5/6 跑项目 ./install.sh（§7.43 默认 --profiles=dsh-tui,web 并存部署）"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ ! -x "$SCRIPT_DIR/install.sh" ]]; then
  err "找不到 $SCRIPT_DIR/install.sh"
  exit 1
fi
if (( DO_WEB )); then
  run bash "$SCRIPT_DIR/install.sh" --profiles=dsh-tui,web
else
  run bash "$SCRIPT_DIR/install.sh" --profiles=dsh-tui
fi

# ── 6. 验证 ────────────────────────────────────────────────────────────────
log "6/6 验证"
echo
ok "dsh 版本：$(dsh --version 2>&1)"
echo
log "尝试 dump dsh-tui profile 配置（§7.43 primary；mandatory）"
if run timeout 15 dsh --profile dsh-tui --dump-config >/dev/null 2>&1; then
  ok "dsh-tui profile 配置树加载成功"
else
  warn "dsh-tui profile dump-config 失败，请手工检查："
  echo "  dsh --profile dsh-tui --dump-config | head -30"
fi
# Web（secondary；best-effort；仅当 profile dir 存在时验证）
if [[ -f "$DSH_HOME/profiles/web/package.json" ]]; then
  echo
  log "尝试 dump web profile 配置（secondary；web 已装则验证）"
  if run timeout 15 dsh --profile web --dump-config >/dev/null 2>&1; then
    ok "web profile 配置树加载成功"
  else
    warn "web profile dump-config 失败，请手工检查："
    echo "  dsh --profile web --dump-config | head -30"
  fi
else
  echo
  warn "web profile 未初始化；如需启用，跑：./install.sh --profiles=web"
fi
echo
ok "完成。下一步可手工试："
echo "  source .env.sh"
echo "  dsh --profile dsh-tui   # TUI 起来（§7.43 primary）"
echo "  dsh --profile web       # webui :3080（§7.43 默认并存启动，21017 在听）"
echo
warn "如需回滚：mv ${DSH_HOME}.bak-${BACKUP_TS} ${DSH_HOME}"
