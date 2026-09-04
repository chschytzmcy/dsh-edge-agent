#!/usr/bin/env bash
# ── sync-bundle.sh ────────────────────────────────────────────────
# 把 dsh-edge-agent bundle 同步到所有已装 bundle 的 profile。
#
# 适用场景：
#   改了 src/ 后，一次同步到 web + tui + 任何自定义 profile。
#   等价于：for p in web dsh-tui; do ./install.sh --to-profile=$p --skip-pnpm --no-restart; done
#
# 用法：
#   bash scripts/sync-bundle.sh                     # 同步到所有已装 profile
#   bash scripts/sync-bundle.sh --restart           # 同步后重启所有运行中的 profile
#   bash scripts/sync-bundle.sh --profile=web       # 只同步指定 profile（必须已装 bundle）
#
# 与 install.sh 的区别：
#   - install.sh：首次安装 / 加依赖 / 改 package.json → 完整 5 步流程
#   - sync-bundle.sh：纯代码同步 → 只跑 [1] 编译 + [3] rsync + [3.5] patch 同步
# ───────────────────────────────────────────────────────────────────
set -euo pipefail

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DO_RESTART=0
SPECIFIC_PROFILE=""

for arg in "$@"; do
  case "$arg" in
    --restart) DO_RESTART=1 ;;
    --profile=*) SPECIFIC_PROFILE="${arg#*=}" ;;
    -h|--help)
      sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "未知参数: $arg" >&2; exit 2 ;;
  esac
done

# ── 1. 编译 ────────────────────────────────────────────────────────
echo "==> [1/3] compile TypeScript"
cd "$REPO_ROOT"
npm run compile >/dev/null 2>&1 || { npm run compile; exit 1; }
echo "    ✓ 编译完成"

# ── 2. 找所有已装 bundle 的 profile ────────────────────────────────
echo
echo "==> [2/3] 扫描已装 bundle 的 profile"

PROFILES=()
if [ -n "$SPECIFIC_PROFILE" ]; then
  # 指定 profile 模式
  TARGET="$DSH_HOME/profiles/$SPECIFIC_PROFILE/node_modules/@deepseek-harness-edge-agent/dsh-edge-agent"
  if [ -d "$TARGET" ]; then
    PROFILES+=("$SPECIFIC_PROFILE")
  else
    echo "  ✗ profile '$SPECIFIC_PROFILE' 没有安装 dsh-edge-agent bundle" >&2
    echo "    先用 install.sh --to-profile=$SPECIFIC_PROFILE 安装" >&2
    exit 1
  fi
else
  # 自动扫描所有已装 profile
  for d in "$DSH_HOME/profiles"/*/; do
    [ -d "$d" ] || continue
    name="$(basename "$d")"
    [ "$name" = "node_modules" ] && continue
    [ "$name" = ".cache" ] && continue
    TARGET="$d/node_modules/@deepseek-harness-edge-agent/dsh-edge-agent"
    if [ -d "$TARGET" ]; then
      PROFILES+=("$name")
    fi
  done
fi

if [ ${#PROFILES[@]} -eq 0 ]; then
  echo "  ✗ 没有找到任何已装 bundle 的 profile" >&2
  echo "    先跑: ./install.sh --to-profile=web" >&2
  exit 1
fi

echo "  发现 ${#PROFILES[@]} 个 profile: ${PROFILES[*]}"

# ── 3. 同步到每个 profile ──────────────────────────────────────────
echo
echo "==> [3/3] rsync + patch 同步"

for PROFILE in "${PROFILES[@]}"; do
  echo
  echo "  ── profile: $PROFILE ──"
  PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
  NESTED_PKG="$PROFILE_DIR/node_modules/@deepseek-harness-edge-agent/dsh-edge-agent"

  # rsync lib/
  echo "    rsync lib/ → $NESTED_PKG/lib/"
  rsync -a --delete "$REPO_ROOT/lib/" "$NESTED_PKG/lib/"

  # sync cordis.patch.yml (diff-based)
  if [ -f "$REPO_ROOT/cordis.patch.yml" ]; then
    if ! diff -q "$REPO_ROOT/cordis.patch.yml" "$NESTED_PKG/cordis.patch.yml" >/dev/null 2>&1; then
      echo "    sync cordis.patch.yml (bundle patch)"
      cp "$REPO_ROOT/cordis.patch.yml" "$NESTED_PKG/cordis.patch.yml"
    else
      echo "    ✓ cordis.patch.yml 已是最新"
    fi
  fi

  # sync agent-presets/ (diff-based)
  if [ -d "$REPO_ROOT/agent-presets" ]; then
    PRESET_DIR="$DSH_HOME/.agent-presets"
    mkdir -p "$PRESET_DIR"
    if ! diff -rq "$REPO_ROOT/agent-presets/" "$PRESET_DIR/" >/dev/null 2>&1; then
      echo "    sync agent-presets/"
      rsync -a --delete "$REPO_ROOT/agent-presets/" "$PRESET_DIR/"
    else
      echo "    ✓ agent-presets/ 已是最新"
    fi
  fi

  echo "    ✓ 同步完成"
done

# ── 4. 重启（可选）────────────────────────────────────────────────
if [ $DO_RESTART -eq 1 ]; then
  echo
  echo "==> [4/4] 重启运行中的 profile"
  for PROFILE in "${PROFILES[@]}"; do
    # 检查是否有该 profile 的 dsh 进程
    if pgrep -f "dsh --profile $PROFILE" >/dev/null 2>&1; then
      echo "  重启 $PROFILE..."
      pkill -f "dsh --profile $PROFILE" 2>/dev/null || true
      sleep 1
      # 重启（后台）
      cd "$REPO_ROOT"
      if [ -f ".env.sh" ]; then
        (source .env.sh 2>/dev/null && nohup dsh --profile "$PROFILE" > /dev/null 2>&1 &)
      else
        (nohup dsh --profile "$PROFILE" > /dev/null 2>&1 &)
      fi
      echo "    ✓ $PROFILE 已重启"
    else
      echo "  跳过 $PROFILE（未运行）"
    fi
  done
fi

echo
echo "╔════════════════════════════════════════════════════════════╗"
echo "║                 sync-bundle 完成                         ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo
echo "  同步 profiles:  ${PROFILES[*]}"
echo "  重启:           $([ $DO_RESTART -eq 1 ] && echo ✓ || echo ✗)"
echo
echo "  下一步:"
echo "    启动:  dsh --profile <name>"
echo "    健康:  bash scripts/dsh-systemic-health.sh --all"
