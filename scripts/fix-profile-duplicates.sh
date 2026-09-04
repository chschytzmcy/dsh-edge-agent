#!/usr/bin/env bash
# ── fix-profile-duplicates.sh ─────────────────────────────────────
# 诊断 + 修复 dsh profile 里 @deepseek-ai/* 重复包导致的
# "agent-presets: refusing to compose an unscoped context" 崩溃。
#
# 根因：dsh 全局二进制内嵌 @deepseek-ai/*，profile 再装一份 →
#       两个 Symbol('dsh.scope') → preset 系统 scope 检查失败。
#
# 用法：
#   bash scripts/fix-profile-duplicates.sh                  # 默认修 dsh-tui
#   bash scripts/fix-profile-duplicates.sh --profile=web    # 指定 profile
#   bash scripts/fix-profile-duplicates.sh --check          # 只诊断，不修
#
# 幂等：已经干净的 profile 跑这个脚本是 no-op。
# ───────────────────────────────────────────────────────────────────
set -euo pipefail

PROFILE="dsh-tui"
CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --profile=*) PROFILE="${arg#*=}" ;;
    --check)     CHECK_ONLY=1 ;;
    -h|--help)
      sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "未知参数: $arg" >&2; exit 2 ;;
  esac
done

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
PKG_JSON="$PROFILE_DIR/package.json"

if [ ! -f "$PKG_JSON" ]; then
  echo "✗ profile 不存在: $PROFILE_DIR" >&2
  exit 1
fi

echo "═══ 诊断 profile: $PROFILE ═══"
echo "路径: $PROFILE_DIR"
echo

# ── 1. 找出 profile 里的 @deepseek-ai/* deps ────────────────────
DUPLICATES=$(python3 -c "
import json
with open('$PKG_JSON') as f:
    d = json.load(f)
deps = d.get('dependencies', {})
dups = sorted(k for k in deps if k.startswith('@deepseek-ai/'))
print('\n'.join(dups))
")

if [ -z "$DUPLICATES" ]; then
  echo "✓ profile 里没有 @deepseek-ai/* 重复包（已干净）"
else
  COUNT=$(echo "$DUPLICATES" | wc -l | tr -d ' ')
  echo "⚠ 发现 $COUNT 个 @deepseek-ai/* 重复包："
  echo "$DUPLICATES" | sed 's/^/    /'
  echo
  echo "  这些包会导致 Symbol('dsh.scope') 双实例，"
  echo "  触发 agent-presets: refusing to compose an unscoped context"
fi

# ── 2. 检查 node_modules 里 dsh-scope 实例数 ────────────────────
if [ -d "$PROFILE_DIR/node_modules" ]; then
  SCOPE_COUNT=$(find "$PROFILE_DIR/node_modules" -path '*/@deepseek-ai/dsh-scope/package.json' 2>/dev/null | wc -l | tr -d ' ')
  echo
  if [ "$SCOPE_COUNT" -gt 0 ]; then
    echo "⚠ node_modules 里有 $SCOPE_COUNT 个 dsh-scope 实例（应为 0）"
    echo "  位置："
    find "$PROFILE_DIR/node_modules" -path '*/@deepseek-ai/dsh-scope/package.json' 2>/dev/null | sed 's/^/    /'
  else
    echo "✓ node_modules 里 dsh-scope 实例数 = 0（正确）"
  fi
fi

# ── 3. 检查 bundle 完整性 ──────────────────────────────────────
echo
BUNDLE_PATH="$PROFILE_DIR/node_modules/@deepseek-harness-edge-agent/dsh-edge-agent"
if [ -d "$BUNDLE_PATH" ]; then
  echo "✓ dsh-edge-agent bundle 在位"
else
  echo "⚠ dsh-edge-agent bundle 缺失！"
  echo "  需要重跑: cd $(pwd) && ./install.sh --to-profile=$PROFILE"
fi

# ── 4. 修复 ──────────────────────────────────────────────────────
if [ "$CHECK_ONLY" = 1 ] || [ -z "$DUPLICATES" ]; then
  if [ "$CHECK_ONLY" = 1 ] && [ -n "$DUPLICATES" ]; then
    echo
    echo "──check 模式：不修改。去掉 --check 执行修复──"
  fi
  exit 0
fi

echo
echo "═══ 修复 ═══"

# 备份
cp "$PKG_JSON" "$PKG_JSON.bak-$(date +%s)"
echo "  备份: $PKG_JSON.bak-*"

# strip
python3 - "$PKG_JSON" <<'PYEOF'
import json, sys
path = sys.argv[1]
with open(path) as f:
    d = json.load(f)
before = list(d.get('dependencies', {}).keys())
d['dependencies'] = {k: v for k, v in d['dependencies'].items()
                     if not k.startswith('@deepseek-ai/')}
after = list(d['dependencies'].keys())
removed = [k for k in before if k not in after]
with open(path, 'w') as f:
    json.dump(d, f, indent=2)
    f.write('\n')
print(f"  移除 {len(removed)} 个 @deepseek-ai/*:")
for k in removed:
    print(f"    - {k}")
print(f"  保留 {len(after)} 个 deps:")
for k in after:
    print(f"    + {k}")
PYEOF

# reconcile（不删 node_modules，保留 dsh-edge-agent bundle）
echo
echo "  pnpm reconcile（保留 bundle）..."
cd "$PROFILE_DIR"
if pnpm install --no-frozen-lockfile 2>&1 | tail -5; then
  echo
  echo "═══ 修复完成 ═══"
  echo
  echo "启动 TUI："
  echo "  cd $(pwd) && source .env.sh && dsh --profile $PROFILE"
else
  echo
  echo "✗ pnpm install 失败。检查网络 / 看上方错误。" >&2
  echo "  还原备份: mv $PKG_JSON.bak-* $PKG_JSON" >&2
  exit 1
fi
