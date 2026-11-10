#!/usr/bin/env bash
# uninstall.sh —— dsh-edge-agent 反向部署脚本 (§7.76)
#
# 默认行为 (无 flag) = FULL uninstall (用户拍板: 不用加任何参数,默认请全部)
#   - **Phase 1.7 backup .env / .env.sh / config/edge.json** → $REPO_ROOT/.env.uninstall-backup.<ts>/
#     (§7.102: live key 文件 = config/edge.json;.env 分支保留给老部署)
#     (chmod 600 防 live key 落盘;--no-backup opt-out,**与 --keep-env 独立**)
#   - kill + clean 所有含本 bundle fingerprint 的 profile
#   - shred REPO_ROOT/.env (含 live API key) + rm .env.sh
#   - rm -rf ~/.dsh-edge-agent/ (6 渠道数据)
#   - rmdir ~/.dsh/.agent-presets/ (仅当空)
# Opt-out flags: --keep-data / --keep-env / --keep-presets / --no-backup
#
# 显式单 profile 模式 (--profile=X) = 精准手术,无需 y/N
#   (CLI 即确认;但 data/env/presets 默认仍清,用 --keep-* opt-out;backup 仍跑)
#
# 安全约束:
#   - **Phase 1.7 backup 默认 ON** (任何 destructive 前先 cp 一份到 $REPO_ROOT 子目录)
#   - 任何 y/N prompt 默认 N (必须显式 y 才执行)
#   - 不删 ~/.dsh/ 整目录 (用户可能装了别的项目)
#   - 不动 user skin (diff -q 不一致时跳过)
#   - .env 用 shred -u 防 live key 落盘恢复(backup 仍保留原文件,chmod 600)
#
# 用法:
#   uninstall.sh                  # 默认: 全清 (kill + env + data + presets)
#   uninstall.sh --profile=<name> # 显式单 profile 模式 (不需 y/N)
#   uninstall.sh --keep-data      # 保留 ~/.dsh-edge-agent/ 数据
#   uninstall.sh --keep-env       # 保留 REPO_ROOT/.env / .env.sh
#   uninstall.sh --keep-presets   # 保留 ~/.dsh/.agent-presets/
#   uninstall.sh --no-backup      # 不备份 .env / .env.sh
#   uninstall.sh --help           # 打印帮助
#
# 退出码:
#   0 = 成功 (可能没做任何事)
#   1 = 用户参数错 / y/N 拒绝
#   2 = kill / rm 失败 (部分清理)

set -uo pipefail

# ── 路径 & 默认 ──────────────────────────────────────────────────
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
REPO_ROOT="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
PROFILE=""
EXPLICIT_PROFILE=0
DO_ALL=0           # 默认 --all: 扫所有含 bundle fingerprint 的 profile
DO_KEEP_DATA=0     # 默认 = 清 ~/.dsh-edge-agent/ ;--keep-data 保留
DO_KEEP_ENV=0      # 默认 = shred .env + rm .env.sh ;--keep-env 保留
DO_KEEP_PRESETS=0  # 默认 = rmdir ~/.dsh/.agent-presets/ 仅当空
DO_BACKUP=1        # 默认 ON: 先 cp .env/.env.sh 到 .env.uninstall-backup.<ts>/ ;--no-backup 跳过

# ── 颜色 (跟 install.sh 对齐) ──────────────────────────────────
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

默认 (无 flag): FULL uninstall —— 扫所有含本 bundle 的 profile,1 次 y/N
确认后批量 kill + 清理,同时清 REPO_ROOT 环境文件 + ~/.dsh-edge-agent/ 数据
+ ~/.dsh/.agent-presets/。Opt-out 用 --keep-* flags。

Options:
  --profile=<name>     显式单 profile 模式 (接受别名 tui/web/edge/dsh-edge)
                       CLI 即确认,无需 y/N。data/env/presets 默认仍清。
  --keep-data          保留 ~/.dsh-edge-agent/ (默认 rm -rf)
  --keep-env           保留 REPO_ROOT/.env (shred) 和 .env.sh
                       (alias: --keep-tarball-root,向后兼容)
  --keep-presets       保留 ~/.dsh/.agent-presets/ (默认 rmdir 仅当空)
  --no-backup          不备份 .env / .env.sh (默认: cp 到
                       $REPO_ROOT/.env.uninstall-backup.<ts>/,chmod 600)
  --all                显式 alias,等价默认 (向后兼容)
  -h, --help           打印这段

安全约束:
  - **Phase 1.7 backup 默认 ON** (任何 destructive 前先 cp 一份,即使 --keep-env)
  - 任何 y/N prompt 默认 N
  - .env 含 live API key,shred 而非 rm (backup 副本保留原内容)
  - 不删 ~/.dsh/ 整目录 (只删命名 profile 子目录 + ~/.dsh-edge-agent/)
  - 不动 user skin (diff 不一致时跳过)
  - kill SIGTERM→5s wait→SIGKILL9,镜像 install.sh:374/402

Rollback hint: uninstall 后可 \`./install.sh --skip-pnpm --no-restart\` 一键恢复部署;
.env live 内容可从 $REPO_ROOT/.env.uninstall-backup.<ts>/.env 恢复 (chmod 600)。
EOF
}

# ── canonical_profile 镜像 (跟 install.sh:70-77) ────────────────
canonical_profile() {
  case "$1" in
    tui|dsh-tui)   echo "dsh-tui" ;;
    web)           echo "web" ;;
    edge|dsh-edge) echo "dsh-edge" ;;
    *)             echo "$1" ;;
  esac
}

# ── 参数解析 ────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --profile=*)   PROFILE="${1#*=}"; EXPLICIT_PROFILE=1 ;;
    --all)         DO_ALL=1 ;;
    --keep-data)        DO_KEEP_DATA=1 ;;
    --keep-env|--keep-tarball-root) DO_KEEP_ENV=1 ;;
    --keep-presets)     DO_KEEP_PRESETS=1 ;;
    --no-backup)        DO_BACKUP=0 ;;
    -h|--help)     print_help; exit 0 ;;
    *)             log_fail "unknown flag: $1"; print_help; exit 1 ;;
  esac
  shift
done

# 默认 = full mode (无 flag = --all)
if [ "$EXPLICIT_PROFILE" = 0 ] && [ "$DO_ALL" = 0 ]; then
  DO_ALL=1
fi

# ── fingerprint: profile 含本 bundle 的两种 trace ─────────────
# 任一命中即认为装了,支持 nested pkg 与 package.json 任意 stale 残留。
profile_has_bundle() {
  local prof_dir="$1"
  local pkg_json="$prof_dir/package.json"
  local nested_pkg="$prof_dir/node_modules/@dsh-edge/dsh-edge-agent"
  if [ -f "$pkg_json" ] && grep -q '@dsh-edge/dsh-edge-agent' "$pkg_json" 2>/dev/null; then
    return 0  # fingerprint 1 命中
  fi
  if [ -d "$nested_pkg" ]; then
    return 0  # fingerprint 2 命中
  fi
  return 1
}

# ── Phase 1: 计算 PROFILE_LIST ────────────────────────────────
PROFILE_LIST=()

if [ "$DO_ALL" = 1 ]; then
  log_info "scan \$DSH_HOME/profiles/* for dsh-edge-agent bundle fingerprints..."
  if [ ! -d "$DSH_HOME/profiles" ]; then
    log_warn "\$DSH_HOME/profiles 不存在 ($DSH_HOME/profiles),nothing to scan"
    exit 0
  fi
  for profile_dir in "$DSH_HOME/profiles/"*/; do
    [ -d "$profile_dir" ] || continue
    prof_name=$(basename "$profile_dir")
    if profile_has_bundle "$profile_dir"; then
      PROFILE_LIST+=("$prof_name")
    fi
  done
  if [ ${#PROFILE_LIST[@]} = 0 ]; then
    log_info "no profile with bundle fingerprint found, exit 0"
    exit 0
  fi
else
  # 显式 --profile 模式: 无需 y/N (用户已显式)
  if [ -z "$PROFILE" ]; then
    PROFILE="dsh-edge"
  fi
  PROFILE=$(canonical_profile "$PROFILE")
  PROFILE_LIST=("$PROFILE")
fi

# ── Phase 1.5: 默认 / --all 模式 — 完整 summary + 1 次 y/N ──
if [ "$EXPLICIT_PROFILE" = 0 ]; then
  # 计算 ~/.dsh-edge-agent/ 大小 (供 prompt 显示)
  local_data_size=""
  if [ -d "$HOME/.dsh-edge-agent" ]; then
    local_data_size=$(du -sh "$HOME/.dsh-edge-agent" 2>/dev/null | cut -f1)
  fi

  # 计算 backup destination (Phase 1.7 用;prompt 也 preview 一遍)
  BACKUP_TS=$(date +%Y%m%d-%H%M%S)
  BACKUP_DIR="$REPO_ROOT/.env.uninstall-backup.$BACKUP_TS"

  echo ""
  echo "═══════════════════════════════════════════════════"
  echo "  uninstall 将执行以下操作 (full mode)"
  echo "═══════════════════════════════════════════════════"
  echo ""
  echo "  [1] backup .env / .env.sh / config/edge.json (默认 ON):"
  if [ "$DO_BACKUP" = 1 ]; then
    if [ -f "$REPO_ROOT/.env" ] || [ -f "$REPO_ROOT/.env.sh" ] || [ -f "$REPO_ROOT/config/edge.json" ]; then
      echo "      - cp → $BACKUP_DIR/ (chmod 700;含 key 的文件会 chmod 600)"
    else
      echo "      - skip (.env / .env.sh / config/edge.json 都不存在)"
    fi
  else
    echo "      - skip (--no-backup)"
  fi
  echo ""

  echo "  [2] kill + clean profile (${#PROFILE_LIST[@]} 个):"
  for prof in "${PROFILE_LIST[@]}"; do
    echo "      - $prof"
  done
  echo ""

  echo "  [3] REPO_ROOT 环境文件:"
  if [ "$DO_KEEP_ENV" = 0 ]; then
    [ -f "$REPO_ROOT/.env" ]   && echo "      - shred $REPO_ROOT/.env (含 live API key)"
    [ -f "$REPO_ROOT/config/edge.json" ] && echo "      - shred $REPO_ROOT/config/edge.json (含 live API key,§7.102)"
    [ -f "$REPO_ROOT/.env.sh" ] && echo "      - rm $REPO_ROOT/.env.sh"
    if [ ! -f "$REPO_ROOT/.env" ] && [ ! -f "$REPO_ROOT/.env.sh" ] && [ ! -f "$REPO_ROOT/config/edge.json" ]; then
      echo "      - skip (都不存在)"
    fi
  else
    echo "      - skip (--keep-env)"
  fi
  echo ""

  echo "  [4] ~/.dsh-edge-agent/ 数据:"
  if [ "$DO_KEEP_DATA" = 0 ]; then
    if [ -d "$HOME/.dsh-edge-agent" ]; then
      echo "      - rm -rf $HOME/.dsh-edge-agent/ (大小: ${local_data_size:-?})"
    else
      echo "      - skip (目录不存在)"
    fi
  else
    echo "      - skip (--keep-data)"
  fi
  echo ""

  echo "  [5] ~/.dsh/.agent-presets/:"
  if [ "$DO_KEEP_PRESETS" = 0 ]; then
    echo "      - rmdir (仅当空)"
  else
    echo "      - skip (--keep-presets)"
  fi

  echo ""
  echo "═══════════════════════════════════════════════════"
  read -rp "确认全部执行? [y/N] " ans
  if [ "$ans" != "y" ] && [ "$ans" != "Y" ]; then
    log_warn "用户拒绝(输 N),无副作用"
    exit 0
  fi
  echo ""
fi

# ── Phase 1.7: backup .env / .env.sh / config/edge.json → $BACKUP_DIR (默认 ON) ──
# 必须在 Phase 2 kill 之前完成(防数据丢失:即使后续 rm -rf / shred 出错,
# backup 已留副本)。--no-backup opt-out;--keep-env 不影响 backup(独立
# safety net,即便不 shred 也留一份)。
# §7.102 (2026-10-21): 含 live key 的文件从 .env 换成 config/edge.json;
# .env/.env.sh 分支保留 —— 老部署升级卸载时它们可能还在。
backup_env_files() {
  if [ ! -f "$REPO_ROOT/.env" ] && [ ! -f "$REPO_ROOT/.env.sh" ] \
     && [ ! -f "$REPO_ROOT/config/edge.json" ]; then
    log_info "Phase 1.7: backup skip (.env / .env.sh / config/edge.json 都不存在)"
    return 0
  fi

  if ! mkdir -p "$BACKUP_DIR" 2>/dev/null; then
    log_warn "Phase 1.7: backup 目录创建失败 ($BACKUP_DIR),跳过 backup"
    return 0
  fi
  chmod 700 "$BACKUP_DIR" 2>/dev/null || true

  local backed=0
  if [ -f "$REPO_ROOT/.env" ]; then
    if cp -p "$REPO_ROOT/.env" "$BACKUP_DIR/.env" 2>/dev/null; then
      chmod 600 "$BACKUP_DIR/.env" 2>/dev/null || true
      log_pass "  ✓ backup .env → $BACKUP_DIR/.env (chmod 600)"
      backed=1
    else
      log_warn "  ✗ cp .env 失败,跳过(继续 uninstall)"
    fi
  fi

  if [ -f "$REPO_ROOT/config/edge.json" ]; then
    if cp -p "$REPO_ROOT/config/edge.json" "$BACKUP_DIR/edge.json" 2>/dev/null; then
      chmod 600 "$BACKUP_DIR/edge.json" 2>/dev/null || true
      log_pass "  ✓ backup config/edge.json → $BACKUP_DIR/edge.json (chmod 600)"
      backed=1
    else
      log_warn "  ✗ cp config/edge.json 失败,跳过(继续 uninstall)"
    fi
  fi

  if [ -f "$REPO_ROOT/.env.sh" ]; then
    if cp -p "$REPO_ROOT/.env.sh" "$BACKUP_DIR/.env.sh" 2>/dev/null; then
      log_pass "  ✓ backup .env.sh → $BACKUP_DIR/.env.sh"
      backed=1
    else
      log_warn "  ✗ cp .env.sh 失败,跳过(继续 uninstall)"
    fi
  fi

  if [ "$backed" = 1 ]; then
    echo ""
    log_warn "备份位置: $BACKUP_DIR"
    echo "  卸载后如需恢复 live API key:"
    echo "    cp $BACKUP_DIR/.env $REPO_ROOT/.env 2>/dev/null; cp $BACKUP_DIR/edge.json $REPO_ROOT/config/edge.json 2>/dev/null"
    echo "    chmod 600 $REPO_ROOT/config/edge.json"
    echo ""
  fi
}

if [ "$DO_BACKUP" = 1 ]; then
  log_info "Phase 1.7: backup .env / .env.sh → $BACKUP_DIR"
  backup_env_files
else
  log_info "Phase 1.7: --no-backup,skip"
fi

# ── Phase 2: kill 每个 profile 的进程 ────────────────────────
kill_profile() {
  local prof="$1"
  local pids
  pids=$(ps -eo pid,cmd 2>/dev/null | awk '/node.*dsh --profile '"$prof"'/ && !/awk/{print $1}')
  if [ -n "$pids" ]; then
    log_info "killing $prof (PIDs: $pids)"
    kill $pids 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      sleep 1
      local alive
      alive=$(ps -eo pid,cmd 2>/dev/null | awk '/node.*dsh --profile '"$prof"'/ && !/awk/{print $1}')
      [ -z "$alive" ] && break
    done
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
BUNDLE = '@dsh-edge/dsh-edge-agent'

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
  local nested_pkg="$prof_dir/node_modules/@dsh-edge/dsh-edge-agent"
  local nested_parent="$prof_dir/node_modules/@dsh-edge"

  log_info "Phase 3: clean profile '$prof' ($prof_dir)"

  # 3.1 嵌套包删除
  if [ -d "$nested_pkg" ]; then
    rm -rf "$nested_pkg"
    log_pass "  ✓ removed nested pkg: $nested_pkg"
  else
    log_info "  skip: $nested_pkg already gone"
  fi

  # 3.1.1 父目录 @dsh-edge/(空时 rmdir,留 trace 不必要)
  if [ -d "$nested_parent" ]; then
    if rmdir "$nested_parent" 2>/dev/null; then
      log_pass "  ✓ rmdir empty parent: $nested_parent"
    else
      log_info "  skip: $nested_parent 非空(可能含别的 scope 包)"
    fi
  fi

  # 3.2 strip profile package.json (我们的 bundle 入口)
  if [ -f "$prof_dir/package.json" ]; then
    if grep -q '@dsh-edge/dsh-edge-agent' "$prof_dir/package.json" 2>/dev/null; then
      python3 -c "$RESET_PKG_PY" "$prof_dir/package.json" && log_pass "  ✓ stripped bundle from $prof_dir/package.json"
    else
      log_info "  skip: profile package.json already clean"
    fi
  fi

  # 3.3 skin 层 cordis.patch.yml (install.sh §2.5 sync 的)
  # 只删 **与 REPO_ROOT 一致** 的版本(user 改过的不动,可能是 user skin)
  local repo_skin="$REPO_ROOT/profiles/$prof/cordis.patch.yml"
  local dsh_skin="$prof_dir/cordis.patch.yml"
  if [ -f "$dsh_skin" ]; then
    if [ -f "$repo_skin" ] && diff -q "$repo_skin" "$dsh_skin" >/dev/null 2>&1; then
      rm -f "$dsh_skin"
      log_pass "  ✓ removed install.sh-synced skin: $dsh_skin (matches REPO_ROOT)"
    else
      log_info "  skip: $dsh_skin 跟 REPO_ROOT 不一致(或 REPO_ROOT 无),可能是 user skin 保留"
    fi
  fi

  # 3.4 privacy-policy.json (install.sh §2.5 sync 的,同 cordis.patch.yml 原则)
  local repo_policy="$REPO_ROOT/profiles/$prof/privacy-policy.json"
  local dsh_policy="$prof_dir/privacy-policy.json"
  if [ -f "$dsh_policy" ]; then
    if [ -f "$repo_policy" ] && diff -q "$repo_policy" "$dsh_policy" >/dev/null 2>&1; then
      rm -f "$dsh_policy"
      log_pass "  ✓ removed install.sh-synced privacy-policy: $dsh_policy (matches REPO_ROOT)"
    else
      log_info "  skip: $dsh_policy 跟 REPO_ROOT 不一致(或 REPO_ROOT 无),可能是 user 编辑保留"
    fi
  fi

  # 3.5 run.log (install.sh Phase 3 写的)
  if [ -f "$prof_dir/run.log" ]; then
    rm -f "$prof_dir/run.log"
    log_pass "  ✓ removed run.log"
  fi
}

for prof in "${PROFILE_LIST[@]}"; do
  reset_profile_files "$prof"
done

# ── Phase 3.5: 清理 install.sh §2.5 sync 的 profile-无关资产 ──
# ~/.dsh/.agent-presets/dsh-edge-agent/(含 agent.cordis.yml + preset.yml,
# install.sh §2.5 从 REPO_ROOT/agent-presets/ rsync 过去)。
log_info "Phase 3.5: clean install.sh §2.5 shared assets (profile-agnostic)"
PRESET_DIR="$DSH_HOME/.agent-presets/dsh-edge-agent"
if [ -d "$PRESET_DIR" ]; then
  rm -rf "$PRESET_DIR"
  log_pass "  ✓ removed preset dir: $PRESET_DIR"
else
  log_info "  skip: $PRESET_DIR 不存在"
fi

# ── Phase 4: ~/.dsh-edge-agent/ 数据 purge (默认 ON,除非 --keep-data) ──
if [ "$DO_KEEP_DATA" = 0 ]; then
  if [ -d "$HOME/.dsh-edge-agent" ]; then
    rm -rf "$HOME/.dsh-edge-agent"
    log_pass "✓ ~/.dsh-edge-agent/ 已删除"
  else
    log_info "skip: ~/.dsh-edge-agent/ 不存在"
  fi
else
  log_info "--keep-data: skip ~/.dsh-edge-agent/"
fi

# ── Phase 5: .agent-presets 父目录 rmdir (仅当空) ──────────
if [ "$DO_KEEP_PRESETS" = 0 ]; then
  if [ -d "$DSH_HOME/.agent-presets" ]; then
    if rmdir "$DSH_HOME/.agent-presets" 2>/dev/null; then
      log_pass "✓ rmdir $DSH_HOME/.agent-presets (空)"
    else
      log_info "skip: $DSH_HOME/.agent-presets 非空(可能含其他 bundle 的 presets)"
    fi
  fi
else
  log_info "--keep-presets: skip ~/.dsh/.agent-presets/"
fi

# ── Phase 6: REPO_ROOT .env/.env.sh/config/edge.json 清理 (默认 ON,除非 --keep-env) ──
# §7.102: config/edge.json 含 live key,与旧 .env 同等待遇 —— shred。
if [ "$DO_KEEP_ENV" = 0 ]; then
  if [ -f "$REPO_ROOT/.env" ]; then
    if command -v shred >/dev/null 2>&1; then
      shred -u "$REPO_ROOT/.env" 2>/dev/null && log_pass "✓ shredded $REPO_ROOT/.env (live key)"
    else
      rm -f "$REPO_ROOT/.env" && log_warn "shred 不可用,rm $REPO_ROOT/.env (key 可能仍可恢复)"
    fi
  fi
  if [ -f "$REPO_ROOT/config/edge.json" ]; then
    if command -v shred >/dev/null 2>&1; then
      shred -u "$REPO_ROOT/config/edge.json" 2>/dev/null && log_pass "✓ shredded $REPO_ROOT/config/edge.json (live key)"
    else
      rm -f "$REPO_ROOT/config/edge.json" && log_warn "shred 不可用,rm $REPO_ROOT/config/edge.json (key 可能仍可恢复)"
    fi
  fi
  if [ -f "$REPO_ROOT/.env.sh" ]; then
    rm -f "$REPO_ROOT/.env.sh" && log_pass "✓ rm $REPO_ROOT/.env.sh"
  fi
else
  log_info "--keep-env: skip .env/.env.sh/config-edge.json cleanup"
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
[ "$DO_KEEP_PRESETS" = 0 ] && [ -d "$DSH_HOME/.agent-presets" ] && echo "  - ~/.dsh/.agent-presets/ (空时 rmdir)"
[ "$DO_KEEP_DATA" = 0 ]   && echo "  - ~/.dsh-edge-agent/ (6 渠道数据)"
[ "$DO_KEEP_ENV" = 0 ]    && echo "  - $REPO_ROOT/.env + config/edge.json (shred) + .env.sh"
echo ""
if [ "$DO_BACKUP" = 1 ] && [ -d "$BACKUP_DIR" ]; then
  echo "备份保留: $BACKUP_DIR"
  echo "  含 .env (live key 副本,chmod 600) + .env.sh"
  echo "  恢复: cp $BACKUP_DIR/.env $REPO_ROOT/.env && chmod 600 $REPO_ROOT/.env"
  echo "  旧备份: $(ls -d $REPO_ROOT/.env.uninstall-backup.* 2>/dev/null | tr '\n' ' ') 自行清理"
else
  echo "备份: --no-backup 或 backup 失败,无副本"
fi
echo ""
echo "Rollback hint: 跑 \`./install.sh --skip-pnpm --no-restart\` 一键恢复部署。"