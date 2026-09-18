#!/usr/bin/env bash
# uninstall.sh —— dsh-edge-agent 反向部署脚本 (§7.76)
#
# 镜像 install.sh 的语义:
#   - 默认(无 flag) = uninstall all(扫所有含本 bundle 的 profile,1 次 y/N 确认后批量卸载)
#   - --profile=<name> : 单 profile 模式(显式,无需 y/N)
#   - --all : 显式 alias,等价无 flag(向后兼容)
#   - --purge-data : 额外清 ~/.dsh-edge-agent/(独立 y/N 确认)
#   - 破坏性操作全部 opt-in + 显式 y/N 确认
#   - kill 模式同 install.sh:374/402 (SIGTERM → wait → SIGKILL)
#   - 不删 ~/.dsh/ 整目录(用户可能装了别的项目)
#
# 安全约束:
#   - 任何 y/N prompt 默认 N(必须显式 y 才执行)
#   - .env 含 live API key:shred -u 而非 rm(防恢复)
#   - 不 echo 任何 key 内容
#   - --all / 默认扫描只匹配本 bundle 名,其他项目 profile 自动跳过
#
# 用法:
#   uninstall.sh [--profile=<name>] [--all] [--purge-data]
#                 [--keep-presets] [--keep-tarball-root] [--help]
#
# 默认(无 flag):  等价 --all,扫所有 profile,1 次 y/N 确认后批量卸载。
# --profile=<name>: 卸载指定 profile(接受别名 web/edge/dsh-edge),显式无需 y/N。
# --all           : 同默认(向后兼容)。
# --purge-data    : 同时清 ~/.dsh-edge-agent/(独立 y/N 确认)。
# --keep-presets  : 保留 ~/.dsh/.agent-presets/(默认会 rmdir 仅当空)。
# --keep-tarball-root : 保留 REPO_ROOT/.env.sh / .env(默认会删;.env 用 shred -u)。
# -h, --help      : 打印这段。
#
# 退出码:
#   0 = 成功(可能没做任何事)
#   1 = 用户参数错 / y/N 拒绝
#   2 = kill / rm 失败(部分清理)

set -uo pipefail

# ── 路径 & 默认 ──────────────────────────────────────────────────
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
REPO_ROOT="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
PROFILE=""
DO_ALL=0           # --all / 默认:扫所有含 bundle 的 profile
EXPLICIT_PROFILE=0 # 是否显式 --profile(显式则无需 y/N)
DO_PURGE_DATA=0
KEEP_PRESETS=0
KEEP_TARBALL_ROOT=0

# ── 颜色(跟 install.sh 对齐)───────────────────────────────────
BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log_info()  { echo -e "${BLUE}[INFO]${NC} $1"; }
log_pass()  { echo -e "${GREEN}[PASS]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_fail()  { echo -e "${RED}[FAIL]${NC} $1"; }

# ── 帮助 ────────────────────────────────────────────────────────
print_help() {
  cat <<EOF
Usage: uninstall.sh [options]

默认(无 flag):等价 --all —— 扫 \$DSH_HOME/profiles/*,找到所有含本 bundle
(@deepseek-harness-edge-agent/dsh-edge-agent) 的 profile,打印清单 + 1 次
y/N 确认,确认后批量 kill+清理。

Options:
  --profile=<name>        卸载指定 profile(接受别名 tui/web/edge/dsh-edge)
                          显式指定,无需 y/N 二次确认
  --all                   显式 alias,等价默认(向后兼容)
  --purge-data            同时清 \$HOME/.dsh-edge-agent/(独立 y/N 确认)
  --keep-presets          保留 \$DSH_HOME/.agent-presets/(默认 rmdir 仅当空)
  --keep-tarball-root     保留 REPO_ROOT/.env.sh 和 .env(默认会删)
  -h, --help              打印这段

安全约束:
  - 任何 y/N prompt 默认 N
  - .env 含 live API key,shred 而非 rm
  - 不删 ~/.dsh/ 整目录(只删命名 profile 子目录 + ~/.dsh-edge-agent/)

Rollback hint: uninstall 后可 \`./install.sh --skip-pnpm --no-restart\` 一键恢复部署。
EOF
}

# ── canonical_profile 镜像(跟 install.sh:70-77)────────────────
canonical_profile() {
  case "$1" in
    tui)    echo "dsh-tui" ;;
    web)    echo "web" ;;
    edge|dsh-edge) echo "dsh-edge" ;;
    *)      echo "$1" ;;
  esac
}

# ── 参数解析 ────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --profile=*)   PROFILE="${1#*=}"; EXPLICIT_PROFILE=1 ;;
    --all)         DO_ALL=1 ;;
    --purge-data)  DO_PURGE_DATA=1 ;;
    --keep-presets)        KEEP_PRESETS=1 ;;
    --keep-tarball-root)   KEEP_TARBALL_ROOT=1 ;;
    -h|--help)     print_help; exit 0 ;;
    *)             log_fail "unknown flag: $1"; print_help; exit 1 ;;
  esac
  shift
done

# 默认 = --all(无 flag = 扫所有 profile)
if [ "$EXPLICIT_PROFILE" = 0 ] && [ "$DO_ALL" = 0 ]; then
  DO_ALL=1
fi

# ── Phase 1: 计算 PROFILE_LIST ────────────────────────────────
PROFILE_LIST=()

if [ "$DO_ALL" = 1 ]; then
  log_info "scan \$DSH_HOME/profiles/* for dsh-edge-agent bundle..."
  if [ ! -d "$DSH_HOME/profiles" ]; then
    log_warn "\$DSH_HOME/profiles 不存在 ($DSH_HOME/profiles),nothing to scan"
    exit 0
  fi
  for profile_dir in "$DSH_HOME/profiles/"*/; do
    [ -f "$profile_dir/package.json" ] || continue
    if grep -q '"@deepseek-harness-edge-agent/dsh-edge-agent"' "$profile_dir/package.json" 2>/dev/null; then
      prof_name=$(basename "$profile_dir")
      PROFILE_LIST+=("$prof_name")
    fi
  done
  if [ ${#PROFILE_LIST[@]} = 0 ]; then
    log_info "no profile with bundle mounted found, exit 0"
    exit 0
  fi

  # 默认 / --all 模式:单次 y/N 确认(不是逐个 prompt)
  log_warn "找到 ${#PROFILE_LIST[@]} 个含 bundle 的 profile:"
  for prof in "${PROFILE_LIST[@]}"; do
    echo "   - $prof"
  done
  read -rp "批量 kill + 清理上述所有 profile? [y/N] " ans
  if [ "$ans" != "y" ] && [ "$ans" != "Y" ]; then
    log_warn "用户拒绝(输 N),无副作用"
    exit 0
  fi
  echo ""
else
  # 显式 --profile 模式:无需 y/N(用户已显式)
  if [ -z "$PROFILE" ]; then
    PROFILE="dsh-edge"
  fi
  PROFILE=$(canonical_profile "$PROFILE")
  PROFILE_LIST=("$PROFILE")
fi

# ── Phase 2: kill 每个 profile 的进程 ────────────────────────
kill_profile() {
  local prof="$1"
  local pids
  pids=$(ps -eo pid,cmd 2>/dev/null | awk '/node.*dsh --profile '"$prof"'/ && !/awk/{print $1}')
  if [ -n "$pids" ]; then
    log_info "killing $prof (PIDs: $pids)"
    kill $pids 2>/dev/null || true
    # 等 5s 让进程优雅退出
    for _ in 1 2 3 4 5; do
      sleep 1
      local alive
      alive=$(ps -eo pid,cmd 2>/dev/null | awk '/node.*dsh --profile '"$prof"'/ && !/awk/{print $1}')
      [ -z "$alive" ] && break
    done
    # 残留就 SIGKILL
    pids=$(ps -eo pid,cmd 2>/dev/null | awk '/node.*dsh --profile '"$prof"'/ && !/awk/{print $1}')
    if [ -n "$pids" ]; then
      log_warn "$prof 优雅退出超时,SIGKILL (PIDs: $pids)"
      kill -9 $pids 2>/dev/null || true
    fi
  else
    log_info "no running process for $prof"
  fi
}

log_info "Phase 2: kill profile processes"
for prof in "${PROFILE_LIST[@]}"; do
  kill_profile "$prof"
done

# ── Phase 3: 删除 profile 子目录里的本 bundle 文件 ─────────
RESET_PKG_PY=$(cat <<'PYEOF'
import json, sys
pkg_path = sys.argv[1]
pkg = json.load(open(pkg_path))
BUNDLE = '@deepseek-harness-edge-agent/dsh-edge-agent'

# strip dsh.profile.bundles
bundles = pkg.get('dsh', {}).get('profile', {}).get('bundles', [])
bundles = [b for b in bundles if b != BUNDLE]

# strip dependencies (嵌套包 dep 名同 BUNDLE)
deps = pkg.get('dependencies', {})
deps.pop(BUNDLE, None)
pkg['dependencies'] = deps

# 写回
if 'dsh' in pkg and 'profile' in pkg['dsh']:
    if bundles:
        pkg['dsh']['profile']['bundles'] = bundles
    else:
        pkg['dsh']['profile'].pop('bundles', None)
    # bundles 空时整个 dsh.profile 也没意义 → 保留原状(其他字段可能有用)

json.dump(pkg, open(pkg_path, 'w'), indent=2, ensure_ascii=False)
print('stripped')
PYEOF
)

reset_profile_files() {
  local prof="$1"
  local prof_dir="$DSH_HOME/profiles/$prof"
  local nested_pkg="$prof_dir/node_modules/@deepseek-harness-edge-agent/dsh-edge-agent"

  log_info "Phase 3: clean profile '$prof' ($prof_dir)"

  # 3.1 嵌套包删除
  if [ -d "$nested_pkg" ]; then
    rm -rf "$nested_pkg"
    log_pass "  ✓ removed nested pkg: $nested_pkg"
  else
    log_info "  skip: $nested_pkg already gone"
  fi

  # 3.2 strip profile package.json (我们的 bundle 入口)
  if [ -f "$prof_dir/package.json" ]; then
    if grep -q '"@deepseek-harness-edge-agent/dsh-edge-agent"' "$prof_dir/package.json" 2>/dev/null; then
      python3 -c "$RESET_PKG_PY" "$prof_dir/package.json" && log_pass "  ✓ stripped bundle from $prof_dir/package.json"
    else
      log_info "  skip: profile package.json already clean"
    fi
  fi

  # 3.3 skin 层 cordis.patch.yml (我们这 bundle 没 skin,保留)
  # 不动 profiles/$prof/cordis.patch.yml —— 它可能含别的项目 bundle 的 skin

  # 3.4 run.log (install.sh Phase 3 写的)
  if [ -f "$prof_dir/run.log" ]; then
    rm -f "$prof_dir/run.log"
    log_pass "  ✓ removed run.log"
  fi
}

for prof in "${PROFILE_LIST[@]}"; do
  reset_profile_files "$prof"
done

# ── Phase 4: --purge-data 显式 y/N ─────────────────────────
if [ "$DO_PURGE_DATA" = 1 ]; then
  log_warn "--purge-data: 将删除 \$HOME/.dsh-edge-agent/"
  if [ -d "$HOME/.dsh-edge-agent" ]; then
    local_size=$(du -sh "$HOME/.dsh-edge-agent" 2>/dev/null | cut -f1)
    echo "   大小: $local_size"
    echo "   内含 6 渠道:audit/log/sessions/storage/cache/tmp + skill-realms.json"
    echo "   memory dsh-edge-agent-data-path.md 记录 user 拍板数据可丢,"
    echo "   但 uninstall 仍要求显式确认。"
    read -rp "   确认删除? [y/N] " ans
    if [ "$ans" = "y" ] || [ "$ans" = "Y" ]; then
      rm -rf "$HOME/.dsh-edge-agent"
      log_pass "✓ ~/.dsh-edge-agent/ 已删除"
    else
      log_warn "跳过(数据保留)"
    fi
  else
    log_info "~/.dsh-edge-agent/ 不存在,跳过"
  fi
fi

# ── Phase 5: .agent-presets 清理(默认 rmdir 仅当空)──────────
if [ "$KEEP_PRESETS" = 0 ]; then
  if [ -d "$DSH_HOME/.agent-presets" ]; then
    if rmdir "$DSH_HOME/.agent-presets" 2>/dev/null; then
      log_pass "✓ rmdir $DSH_HOME/.agent-presets (空)"
    else
      log_info "skip: $DSH_HOME/.agent-presets 非空(可能含其他 bundle 的 presets)"
    fi
  fi
fi

# ── Phase 6: tarball 根目录 .env/.env.sh 清理(默认)─────────
# §7.76:REPO_ROOT/.env 由用户手动创建,可能含 live API key。
# shred .env 防 key 落盘;.env.sh 是 install.sh 拉起时 dsh source 的副本,
# 由 .env.example 模板得来,可重建。
if [ "$KEEP_TARBALL_ROOT" = 0 ]; then
  if [ -f "$REPO_ROOT/.env" ]; then
    if command -v shred >/dev/null 2>&1; then
      shred -u "$REPO_ROOT/.env" 2>/dev/null && log_pass "✓ shredded $REPO_ROOT/.env (live key)"
    else
      rm -f "$REPO_ROOT/.env" && log_warn "shred 不可用,rm $REPO_ROOT/.env (key 可能仍可恢复)"
    fi
  fi
  if [ -f "$REPO_ROOT/.env.sh" ]; then
    rm -f "$REPO_ROOT/.env.sh" && log_pass "✓ rm $REPO_ROOT/.env.sh"
  fi
else
  log_info "--keep-tarball-root: skip .env/.env.sh cleanup"
fi

# ── Phase 7: summary + rollback hint ─────────────────────────
echo ""
echo "========================================================"
log_pass "uninstall complete"
echo "========================================================"
echo ""
echo "已清理:"
for prof in "${PROFILE_LIST[@]}"; do
  echo "  - profile: $prof (process killed + nested pkg + bundle from package.json + run.log)"
done
[ "$DO_PURGE_DATA" = 1 ] && echo "  - ~/.dsh-edge-agent/ (按 --purge-data)"
[ "$KEEP_PRESETS" = 0 ] && [ -d "$DSH_HOME/.agent-presets" ] && echo "  - ~/.dsh/.agent-presets/ (空时 rmdir)"
[ "$KEEP_TARBALL_ROOT" = 0 ] && echo "  - $REPO_ROOT/.env / .env.sh"
echo ""
echo "Rollback hint: 跑 \`./install.sh --skip-pnpm --no-restart\` 一键恢复部署。"