#!/usr/bin/env bash
# ── dsh-systemic-health.sh ────────────────────────────────────────
# 检查 dsh 系统性兼容问题（跨 profile）。
#
# 检查项（每类独立打分，最后汇总）：
#   [A] @deepseek-ai/* 重复包 → Symbol('dsh.scope') 双实例
#   [B] profile 包版本 vs dsh 全局版本 skew
#   [C] Session API 迁移（events → snapshotEvents）
#   [D] dsh-edge-agent bundle 完整性
#   [E] audit-log minLevel drop 陷阱
#   [F] cordis.patch.yml 同步状态
#   [G] upstream validated version 一致性
#
# 部署场景校验（--scenario）：
#   dsh-system    — dsh 全局安装 + 版本一致性
#   tui-deploy    — TUI profile 部署后兼容性（Symbol 双实例、bundle 完整）
#   web-deploy    — Web profile 部署后兼容性（bundle 完整、版本一致）
#
# 用法：
#   bash scripts/dsh-systemic-health.sh                          # 默认只查 tui
#   bash scripts/dsh-systemic-health.sh --profile=web            # 指定 profile
#   bash scripts/dsh-systemic-health.sh --all                    # 扫所有 profile
#   bash scripts/dsh-systemic-health.sh --scenario=tui-deploy    # TUI 部署校验
#   bash scripts/dsh-systemic-health.sh --scenario=web-deploy    # Web 部署校验
#   bash scripts/dsh-systemic-health.sh --scenario=dsh-system    # dsh 系统校验
#   bash scripts/dsh-systemic-health.sh --fix                    # 自动修可修项
# ───────────────────────────────────────────────────────────────────
set -euo pipefail

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILES=()
AUTOFIX=0
SCENARIO=""
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

for arg in "$@"; do
  case "$arg" in
    --profile=*) PROFILES+=("${arg#*=}") ;;
    --scenario=*) SCENARIO="${arg#*=}" ;;
    --all)
      for d in "$DSH_HOME/profiles"/*/; do
        [ -d "$d" ] || continue
        name="$(basename "$d")"
        # 跳过非 profile 目录（node_modules、.cache 等）
        [ "$name" = "node_modules" ] && continue
        [ "$name" = ".cache" ] && continue
        # 必须有 package.json 才算 profile
        [ -f "$d/package.json" ] && PROFILES+=("$name")
      done ;;
    --fix) AUTOFIX=1 ;;
    -h|--help)
      sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "未知参数: $arg" >&2; exit 2 ;;
  esac
done

# Scenario 模式：设置 profile 列表 + 打印场景头
case "$SCENARIO" in
  dsh-system)
    # dsh 系统校验：只查全局，不查 profile
    PROFILES=()
    ;;
  tui-deploy)
    PROFILES=("dsh-tui")
    ;;
  web-deploy)
    PROFILES=("web")
    ;;
  "")
    [ ${#PROFILES[@]} -eq 0 ] && PROFILES=("dsh-tui")
    ;;
  *)
    echo "未知 scenario: $SCENARIO（可选：dsh-system, tui-deploy, web-deploy）" >&2
    exit 2
    ;;
esac

# ── 全局变量 ──────────────────────────────────────────────────
declare -i TOTAL_ISSUES=0
declare -i TOTAL_WARNINGS=0
declare -A PROFILE_ISSUES

# 项目声明的 upstream 兼容窗口（不锁版本：最低 / 最后实测）
UPSTREAM_MIN_VERSION=$(grep -oP "UPSTREAM_MIN_VERSION\s*=\s*'\K[^']+" \
  "$REPO_ROOT/src/dsh-adapter/contract.ts" 2>/dev/null || echo "unknown")
UPSTREAM_TESTED_VERSION=$(grep -oP "UPSTREAM_TESTED_VERSION\s*=\s*'\K[^']+" \
  "$REPO_ROOT/src/dsh-adapter/contract.ts" 2>/dev/null || echo "unknown")

# dsh 全局实际版本
DSH_GLOBAL_VERSION=$(dsh --version 2>/dev/null | grep -oP '\d+\.\d+\.\d+[^ ]*' | head -1 || echo "unknown")

echo "╔════════════════════════════════════════════════════════════╗"
if [ -n "$SCENARIO" ]; then
  printf "║          DSH 部署校验 · %-14s · %s  ║\n" "$SCENARIO" "$(date '+%F %H:%M:%S')"
else
  printf "║          DSH 系统性健康检查 · %-22s  ║\n" "$(date '+%F %H:%M:%S')"
fi
echo "╚════════════════════════════════════════════════════════════╝"
echo
echo "dsh 全局版本:     $DSH_GLOBAL_VERSION"
echo "项目最低版本:     $UPSTREAM_MIN_VERSION"
echo "项目实测版本:     $UPSTREAM_TESTED_VERSION"
echo "扫描 profiles:    ${PROFILES[*]}"
echo "自动修复:         $([ $AUTOFIX -eq 1 ] && echo ✓ 开启 || echo ✗ 关闭)"
echo

# ── [G] 版本一致性 ──────────────────────────────────────────
echo "═══ [G] Upstream 版本一致性 ═══"
if [ "$UPSTREAM_MIN_VERSION" != "unknown" ] && [ "$DSH_GLOBAL_VERSION" != "unknown" ]; then
  LOWEST=$(printf '%s\n%s\n' "$UPSTREAM_MIN_VERSION" "$DSH_GLOBAL_VERSION" | sort -V | head -1)
  if [ "$LOWEST" != "$UPSTREAM_MIN_VERSION" ]; then
    echo "  ✗ dsh 全局版本低于最低兼容线！"
    echo "    contract.ts min: $UPSTREAM_MIN_VERSION"
    echo "    dsh --version:   $DSH_GLOBAL_VERSION"
    echo "    → 升级 dsh：npm install -g @deepseek-ai/dsh@next"
    TOTAL_ISSUES+=1
  elif [ "$DSH_GLOBAL_VERSION" = "$UPSTREAM_TESTED_VERSION" ]; then
    echo "  ✓ dsh 全局 ($DSH_GLOBAL_VERSION) = 项目实测版本"
  else
    echo "  ✓ dsh 全局 ($DSH_GLOBAL_VERSION) ≥ 最低线 ($UPSTREAM_MIN_VERSION)"
    echo "    提示：高于实测版本 ($UPSTREAM_TESTED_VERSION)，按“跟随最新”策略允许；"
    echo "    发布前请跑一次 boot smoke。"
  fi
else
  echo "  ? 无法获取版本信息"
fi
echo

# ── dsh-system scenario: 全局环境校验 ─────────────────────────
if [ "$SCENARIO" = "dsh-system" ]; then
  echo "═══ dsh-system 场景：全局环境校验 ═══"
  echo

  # [S1] dsh binary
  echo "  ── [S1] dsh binary ──"
  if command -v dsh >/dev/null 2>&1; then
    DSH_PATH=$(which dsh)
    echo "  ✓ dsh 存在: $DSH_PATH"
  else
    echo "  ✗ dsh 未安装！"
    echo "    → npm install -g @deepseek-ai/dsh@next"
    TOTAL_ISSUES+=1
  fi

  # [S2] pnpm
  echo
  echo "  ── [S2] pnpm ──"
  if command -v pnpm >/dev/null 2>&1; then
    PNPM_VER=$(pnpm --version)
    echo "  ✓ pnpm $PNPM_VER"
  else
    echo "  ✗ pnpm 未安装！"
    echo "    → npm install -g pnpm"
    TOTAL_ISSUES+=1
  fi

  # [S3] dsh 全局 @deepseek-ai/* 包
  echo
  echo "  ── [S3] dsh 全局 @deepseek-ai/* 包 ──"
  if [ -n "${DSH_PATH:-}" ]; then
    DSH_ROOT=$(dirname "$(dirname "$DSH_PATH")")
    SCOPE_PKG="$DSH_ROOT/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-scope/package.json"
    if [ -f "$SCOPE_PKG" ]; then
      SCOPE_VER=$(python3 -c "import json; print(json.load(open('$SCOPE_PKG'))['version'])")
      echo "  ✓ dsh-scope 在 dsh 内嵌: $SCOPE_VER"
    else
      echo "  ⚠ dsh-scope 未在 dsh 内嵌找到（可能影响 profile 启动）"
      TOTAL_WARNINGS+=1
    fi
  fi

  echo
  echo "╔════════════════════════════════════════════════════════════╗"
  echo "║                   dsh-system 校验汇总                    ║"
  echo "╚════════════════════════════════════════════════════════════╝"
  echo
  echo "  严重问题:  $TOTAL_ISSUES"
  echo "  警告:      $TOTAL_WARNINGS"
  echo
  if [ $TOTAL_ISSUES -gt 0 ]; then
    echo "  ✗ dsh 系统部署有问题，修复后再继续"
    exit 1
  else
    echo "  ✓ dsh 系统就绪"
    exit 0
  fi
fi

# ── 逐 profile 检查 ──────────────────────────────────────────
for PROFILE in "${PROFILES[@]}"; do
  PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
  PKG_JSON="$PROFILE_DIR/package.json"

  echo "═══════════════════════════════════════════════════════════"
  echo "  Profile: $PROFILE"
  echo "  路径:    $PROFILE_DIR"
  echo "═══════════════════════════════════════════════════════════"

  if [ ! -f "$PKG_JSON" ]; then
    echo "  ✗ package.json 不存在！跳过"
    TOTAL_ISSUES+=1
    continue
  fi

  # ── [A] @deepseek-ai/* 重复包 ────────────────────────────
  echo
  echo "  ── [A] @deepseek-ai/* 重复包 ──"
  DUPS=$(python3 -c "
import json
with open('$PKG_JSON') as f: d = json.load(f)
dups = sorted(k for k in d.get('dependencies',{}) if k.startswith('@deepseek-ai/'))
print('\n'.join(dups))
" 2>/dev/null)

  if [ -z "$DUPS" ]; then
    echo "    ✓ 无重复"
  else
    COUNT=$(echo "$DUPS" | wc -l | tr -d ' ')
    # web profile 有重复是预期（web harness 不走 roster.mount，不会崩）
    # tui / 自定义 profile 用 preset 系统会崩
    if [ "$PROFILE" = "web" ]; then
      echo "    ℹ $COUNT 个 @deepseek-ai/*（web profile 预期，harness 不走 roster.mount）"
    else
      echo "    ⚠ $COUNT 个重复（会制造 Symbol 双实例，触发 unscoped context 崩溃）："
      echo "$DUPS" | sed 's/^/      - /'
      TOTAL_ISSUES+=1
    fi
    if [ $AUTOFIX -eq 1 ] && [ "$PROFILE" != "web" ]; then
      cp "$PKG_JSON" "$PKG_JSON.bak-$(date +%s)"
      python3 -c "
import json
p='$PKG_JSON'
d=json.load(open(p))
d['dependencies']={k:v for k,v in d['dependencies'].items() if not k.startswith('@deepseek-ai/')}
json.dump(d, open(p,'w'), indent=2); print('    → 已 strip（备份: ${PKG_JSON}.bak-*)')
"
      cd "$PROFILE_DIR"
      pnpm install --no-frozen-lockfile >/dev/null 2>&1 || echo "    ! pnpm reconcile 失败"
    elif [ "$PROFILE" != "web" ]; then
      echo "    → 修复: bash scripts/fix-profile-duplicates.sh --profile=$PROFILE"
    fi
  fi

  # ── [A.2] dsh-scope 实例数 ──────────────────────────────
  if [ -d "$PROFILE_DIR/node_modules" ]; then
    SCOPE_COUNT=$(find "$PROFILE_DIR/node_modules" -path '*/@deepseek-ai/dsh-scope/package.json' 2>/dev/null | wc -l | tr -d ' ')
    if [ "$SCOPE_COUNT" -gt 0 ]; then
      if [ "$PROFILE" = "web" ]; then
        echo "    ℹ dsh-scope 实例数 = $SCOPE_COUNT（web profile 预期，不影响运行）"
      else
        echo "    ⚠ dsh-scope 实例数 = $SCOPE_COUNT（应为 0）"
        find "$PROFILE_DIR/node_modules" -path '*/@deepseek-ai/dsh-scope/package.json' 2>/dev/null | sed 's/^/      /'
        TOTAL_ISSUES+=1
      fi
    else
      echo "    ✓ dsh-scope 实例数 = 0"
    fi
  fi

  # ── [B] 版本 skew ────────────────────────────────────────
  echo
  echo "  ── [B] 包版本 skew ──"
  python3 - "$PKG_JSON" <<'PYEOF'
import json, sys
path = sys.argv[1]
d = json.load(open(path))
versions = {}
for pkg, ver in d.get('dependencies', {}).items():
    if pkg.startswith('@deepseek-ai/') and not ver.startswith('file:'):
        versions[pkg] = ver
uniq = sorted(set(versions.values()))
if len(uniq) <= 1:
    print(f"    ✓ 所有 @deepseek-ai/* 使用同一条版本线（{uniq[0] if uniq else 'none'}）")
else:
    print(f"    ⚠ {len(uniq)} 条不同版本线（允许不锁版本，但同一 profile 内应保持一条）：")
    for pkg, ver in sorted(versions.items()):
        print(f"      {pkg}: {ver}")
PYEOF
  [ $? -eq 0 ] || true  # python exit code handled

  # ── [C] Session API 迁移 ────────────────────────────────
  echo
  echo "  ── [C] Session API 迁移（events → snapshotEvents） ──"
  # 检查 bundle 源码里有没有直接 session.events 调用
  # 排除：
  #   - snapshotSessionEvents helper 自身的 fallback（合法）
  #   - 注释行
  #   - 类型定义 (.d.ts)
  BUNDLE_SRC="$REPO_ROOT/src/dsh-adapter"
  if [ -d "$BUNDLE_SRC" ]; then
    RAW_EVENTS=$(grep -rn "session\.events\b" "$BUNDLE_SRC" 2>/dev/null \
      | grep -v snapshotEvents \
      | grep -v "//.*session\.events" \
      | grep -v "Array\.isArray(session\.events)" \
      | grep -v "session\.events?:" \
      | grep -v "\.d\.ts" \
      | grep -v "\.bak" \
      || true)
    if [ -z "$RAW_EVENTS" ]; then
      echo "    ✓ bundle 源码无直接 session.events 调用"
    else
      echo "    ⚠ 发现直接 session.events 调用（应改用 snapshotSessionEvents helper）："
      echo "$RAW_EVENTS" | sed 's/^/      /'
      TOTAL_WARNINGS+=1
    fi
  fi

  # ── [D] Bundle 完整性 ───────────────────────────────────
  echo
  echo "  ── [D] dsh-edge-agent bundle 完整性 ──"
  BUNDLE_PATH="$PROFILE_DIR/node_modules/@deepseek-harness-edge-agent/dsh-edge-agent"
  if [ ! -d "$BUNDLE_PATH" ]; then
    echo "    ✗ bundle 缺失！"
    echo "      → 重跑: cd $REPO_ROOT && ./install.sh --to-profile=$PROFILE"
    TOTAL_ISSUES+=1
  else
    [ -d "$BUNDLE_PATH/lib" ] && echo "    ✓ lib/ 存在" || { echo "    ✗ lib/ 缺失"; TOTAL_ISSUES+=1; }
    [ -f "$BUNDLE_PATH/package.json" ] && echo "    ✓ package.json 存在" || { echo "    ✗ package.json 缺失"; TOTAL_ISSUES+=1; }
    [ -f "$BUNDLE_PATH/cordis.patch.yml" ] && echo "    ✓ cordis.patch.yml 存在" || { echo "    ⚠ cordis.patch.yml 缺失"; TOTAL_WARNINGS+=1; }

    # 检查 bundle lib 是否是最新编译
    if [ -d "$REPO_ROOT/lib" ] && [ -d "$BUNDLE_PATH/lib" ]; then
      REPO_MTIME=$(stat -c %Y "$REPO_ROOT/lib" 2>/dev/null || echo 0)
      BUNDLE_MTIME=$(stat -c %Y "$BUNDLE_PATH/lib" 2>/dev/null || echo 0)
      if [ "$REPO_MTIME" -gt "$BUNDLE_MTIME" ]; then
        echo "    ⚠ bundle lib 过时（repo 编译产物更新）"
        echo "      → 跑 ./install.sh --skip-pnpm 同步"
        TOTAL_WARNINGS+=1
      else
        echo "    ✓ bundle lib 是最新"
      fi
    fi
  fi

  # ── [E] audit-log minLevel 陷阱 ─────────────────────────
  echo
  echo "  ── [E] audit-log minLevel 配置 ──"
  # audit-log.ts:163 会静默 drop debug 级别事件。minLevel 在 cordis.patch.yml
  # 的 audit-log plugin 段里（不是 file-logger）。
  PATCH_FILE="$BUNDLE_PATH/cordis.patch.yml"
  if [ -f "$PATCH_FILE" ]; then
    # 用 awk 提取 audit-log plugin 段内的 minLevel（段落以 `- id:` 开头）
    AUDIT_LEVEL=$(awk '
      /- id: audit-log/ { in_audit=1; next }
      in_audit && /^[[:space:]]*- id:/ { exit }
      in_audit && /minLevel:/ { print; exit }
    ' "$PATCH_FILE" | sed -E "s/.*minLevel:[[:space:]]*//; s/[\"']//g; s/.*\?\?[[:space:]]*//; s/[\"']//g")

    if [ -z "$AUDIT_LEVEL" ]; then
      echo "    ? audit-log minLevel 未显式配置（默认 info）"
    elif [ "$AUDIT_LEVEL" = "debug" ]; then
      echo "    ⚠ audit-log minLevel = debug（会被静默 drop！应为 info 或以上）"
      echo "      → 改 cordis.patch.yml 或设 DSH_EDGE_AUDIT_MIN_LEVEL=info"
      TOTAL_WARNINGS+=1
    else
      echo "    ✓ audit-log minLevel = $AUDIT_LEVEL"
    fi
  else
    echo "    ? 无 cordis.patch.yml，跳过"
  fi

  # ── [F] cordis.patch.yml 同步状态 ───────────────────────
  echo
  echo "  ── [F] cordis.patch.yml 同步 ──"
  REPO_PATCH="$REPO_ROOT/cordis.patch.yml"
  if [ -f "$REPO_PATCH" ] && [ -f "$BUNDLE_PATH/cordis.patch.yml" ]; then
    if diff -q "$REPO_PATCH" "$BUNDLE_PATH/cordis.patch.yml" >/dev/null 2>&1; then
      echo "    ✓ bundle patch = repo patch"
    else
      echo "    ⚠ bundle patch 与 repo 不一致"
      echo "      → 跑 ./install.sh --skip-pnpm 同步"
      TOTAL_WARNINGS+=1
    fi
  elif [ -f "$REPO_PATCH" ]; then
    echo "    ⚠ repo 有 patch 但 bundle 没有"
    TOTAL_WARNINGS+=1
  fi

done

# ── tui-deploy / web-deploy scenario: 场景特定检查 ────────────
if [ "$SCENARIO" = "tui-deploy" ]; then
  echo
  echo "═══ tui-deploy 场景：TUI 兼容性校验 ═══"
  echo
  # TUI 源码编译状态
  TUI_SRC="/home/etsme/cy/agent/dsh-TUI"
  TUI_LIB="$TUI_SRC/lib"
  if [ -d "$TUI_LIB" ]; then
    FILE_COUNT=$(find "$TUI_LIB" -name "*.js" | wc -l | tr -d ' ')
    echo "  ✓ dsh-TUI 已编译: $FILE_COUNT 个 .js 文件"
  else
    echo "  ✗ dsh-TUI 未编译！"
    echo "    → cd $TUI_SRC && pnpm run compile"
    TOTAL_ISSUES+=1
  fi

  # TUI profile 的 @deepseek-ai/* 必须为 0
  TUI_PKG="$DSH_HOME/profiles/dsh-tui/package.json"
  if [ -f "$TUI_PKG" ]; then
    TUI_DUPS=$(python3 -c "
import json
with open('$TUI_PKG') as f: d = json.load(f)
print(len([k for k in d.get('dependencies',{}) if k.startswith('@deepseek-ai/')]))
")
    if [ "$TUI_DUPS" -eq 0 ]; then
      echo "  ✓ tui profile 无 @deepseek-ai/* 重复（Symbol 安全）"
    else
      echo "  ✗ tui profile 有 $TUI_DUPS 个 @deepseek-ai/* 重复（会触发 unscoped context 崩溃）"
      echo "    → bash scripts/fix-profile-duplicates.sh --profile=dsh-tui"
      TOTAL_ISSUES+=1
    fi
  fi
fi

if [ "$SCENARIO" = "web-deploy" ]; then
  echo
  echo "═══ web-deploy 场景：Web 兼容性校验 ═══"
  echo
  WEB_PKG="$DSH_HOME/profiles/web/package.json"
  if [ -f "$WEB_PKG" ]; then
    # Web profile 允许 @deepseek-ai/* 重复（harness 不走 roster.mount）
    WEB_DUPS=$(python3 -c "
import json
with open('$WEB_PKG') as f: d = json.load(f)
print(len([k for k in d.get('dependencies',{}) if k.startswith('@deepseek-ai/')]))
")
    echo "  ℹ web profile 有 $WEB_DUPS 个 @deepseek-ai/*（预期，harness 不走 roster.mount）"
  else
    echo "  ✗ web profile 不存在！"
    TOTAL_ISSUES+=1
  fi
fi

# ── 汇总 ──────────────────────────────────────────────────────
echo
if [ -n "$SCENARIO" ]; then
  echo "╔════════════════════════════════════════════════════════════╗"
  printf "║              %-20s 校验汇总                  ║\n" "$SCENARIO"
  echo "╚════════════════════════════════════════════════════════════╝"
else
  echo "╔════════════════════════════════════════════════════════════╗"
  echo "║                      检查汇总                            ║"
  echo "╚════════════════════════════════════════════════════════════╝"
fi
echo
echo "  严重问题:  $TOTAL_ISSUES"
echo "  警告:      $TOTAL_WARNINGS"
echo

if [ $TOTAL_ISSUES -gt 0 ]; then
  if [ -n "$SCENARIO" ]; then
    echo "  ✗ $SCENARIO 校验失败，发现严重问题"
    case "$SCENARIO" in
      tui-deploy)
        echo
        echo "  快速修复 TUI:"
        echo "    bash scripts/fix-profile-duplicates.sh --profile=dsh-tui"
        echo "    dsh --profile dsh-tui   # 配置读 config/edge.json (§7.102)"
        ;;
      web-deploy)
        echo
        echo "  快速修复 Web:"
        echo "    ./install.sh --skip-pnpm"
        echo "    dsh --profile web        # 配置读 config/edge.json (§7.102)"
        ;;
    esac
  else
    echo "  ✗ 发现严重问题，建议修复后重启 dsh"
    echo
    echo "  快速修复:"
    echo "    bash scripts/fix-profile-duplicates.sh --profile=<name>"
    echo "    ./install.sh --skip-pnpm"
  fi
  exit 1
elif [ $TOTAL_WARNINGS -gt 0 ]; then
  if [ -n "$SCENARIO" ]; then
    echo "  ⚠ $SCENARIO 有警告项，建议关注"
  else
    echo "  ⚠ 有警告项，建议关注"
  fi
  exit 0
else
  if [ -n "$SCENARIO" ]; then
    echo "  ✓ $SCENARIO 校验通过"
  else
    echo "  ✓ 所有检查通过"
  fi
  exit 0
fi
