#!/usr/bin/env bash
# dsh-edge-agent 本地一键部署（编译 + 安装 + 同步 + 重启）。
#
# 把 bundle 装到 DSH profile 的嵌套包目录、重启对应 dsh 进程。一个
# 命令可以同时部署多个 profile 并存运行：
#   - dsh-tui：终端宿主 (port 21018，配套 @deepseek-harness-tui/dsh-tui)
#   - web    ：浏览器宿主 (port 21017，配套 @deepseek-ai/dsh-web-app)
#   - dsh-edge：项目自有 headless (port 21019，HTTP-only 入口·无 UI 宿主，§7.61)
# 任何自定义 profile 也可以加入 PROFILES 列表（profile-agnostic bundle）。
#
# 前置：
#   - dsh CLI 已安装（npm install -g @deepseek-ai/dsh）
#   - pnpm 已安装（npm install -g pnpm 或 corepack enable pnpm）
#
# 用法：
#   ./install.sh                              # 默认：同步 + 启动 dsh-tui + web（§7.65 web 不再 opt-in）
#   ./install.sh --with                       # 同上（deprecated alias，保留兼容）
#   ./install.sh --with=web                   # 只启 web（同步两个 + 启 web）
#   ./install.sh --with=tui                   # 只启 dsh-tui（同步两个 + 启 dsh-tui）
#   ./install.sh --with=web,tui               # 显式指定启动子集
#   ./install.sh --no-restart                 # 只同步不启（开发改代码反复迭代时,避免重启打搅）
#   ./install.sh --profiles=dsh-tui           # 只同步 dsh-tui + 启 dsh-tui（默认重启语义）
#   ./install.sh --profiles=dsh-edge --with=dsh-edge  # §7.61 headless（HTTP-only :21019，无 UI）
#   ./install.sh --skip-pnpm                  # 跳过 npm install（假设已装过）
#   ./install.sh --force-install              # 强制重装本包（覆盖 rsync）
#   ./install.sh -h | --help                  # 打印本帮助

set -euo pipefail

# 把常见 npm/pnpm/yarn 全局 bin 目录加到 PATH，让 dsh / pnpm / corepack
# 在干净环境下也能找到（CI / nohup 启动时常见）。
_NPM_BIN=""
for _cand in "$HOME/.npm-global/bin" "$HOME/.local/share/npm/bin" "/usr/local/bin" "$HOME/.nvm/versions/node/$(node -p 'process.version' 2>/dev/null || echo vX.Y.Z 2>/dev/null)/bin" "$HOME/.local/share/pnpm" "$HOME/.bun/bin"; do
  [ -d "$_cand" ] && _NPM_BIN="$_NPM_BIN:$_cand"
done
[ -n "$_NPM_BIN" ] && export PATH="${PATH}$_NPM_BIN"

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"

DO_RESTART=1  # §7.65 默认重启:同步+启/重启 PROFILES(开发迭代场景);--no-restart opt-out
DO_PNPM=1
FORCE_INSTALL=0
# PROFILES 是这次新部署的目标 profile 数组。每 profile 走一份独立
# pkill → port-wait → nohup launch 流水线，互不干扰（除了端口本身）。
# 默认 (dsh-tui web) — web 不再 opt-in,跟着默认启(2026-09-17 §7.65)。
PROFILES=()
# START_PROFILES 是这次要启动的 profile 子集。默认空（全不启）；
# --with=web 启 web，--with=tui 启 dsh-tui，--with=web,tui 都启，
# --with 等价 --with=<所有 PROFILES>。
START_PROFILES=()

print_help() {
  sed -n '2,28p' "$0"
}

# 别名规范化：--with=tui 是 --with=dsh-tui 的简写。把 user-friendly
# 短名映射到 DSH profile 真名。
canonical_profile() {
  case "$1" in
    tui|dsh-tui)   echo "dsh-tui" ;;
    web)           echo "web" ;;
    edge|dsh-edge) echo "dsh-edge" ;;
    *)             echo "$1" ;;
  esac
}

for arg in "$@"; do
  case "$arg" in
    --all)             PROFILES=(dsh-tui web) ;;
    --profiles=*)      IFS=',' read -ra PROFILES <<< "${arg#*=}" ;;
    --profiles)        shift; IFS=',' read -ra PROFILES <<< "${1:-}" ;;
    --to-profile)      shift; echo "warning: --to-profile is deprecated, use --profiles= or --all" >&2; PROFILES=("${1:-}") ;;
    --to-profile=*)    echo "warning: --to-profile is deprecated, use --profiles= or --all" >&2; PROFILES=("${arg#*=}") ;;
    --with)            DO_RESTART=1; START_PROFILES=() ;;  # 全启占位，下文按 PROFILES 解析
    --with=*)          DO_RESTART=1; IFS=',' read -ra START_PROFILES <<< "${arg#*=}" ;;
    --no-restart)      DO_RESTART=0; START_PROFILES=() ;;
    --restart)         DO_RESTART=1; START_PROFILES=() ;;  # deprecated alias，等价 --with
    --skip-pnpm)       DO_PNPM=0 ;;
    --force-install)   FORCE_INSTALL=1 ;;
    -h|--help)         print_help; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

# 默认：同步 dsh-tui + web,且都启动(§7.65 web 不再 opt-in)
if [ ${#PROFILES[@]} -eq 0 ]; then
  PROFILES=(dsh-tui web)
fi

# --with 不带值 → 启动全部 PROFILES;默认 DO_RESTART=1 时也走这条
if [ "$DO_RESTART" = 1 ] && [ ${#START_PROFILES[@]} -eq 0 ]; then
  START_PROFILES=("${PROFILES[@]}")
fi

# Canonical 化：tui → dsh-tui 等；同时检测同一 profile 被多次列出的 dup
_canonical=()
declare -A _seen=()
for _p in "${PROFILES[@]}"; do
  _c="$(canonical_profile "$_p")"
  if [ -z "${_seen[$_c]:-}" ]; then
    _canonical+=("$_c")
    _seen[$_c]=1
  fi
done
PROFILES=("${_canonical[@]}")

_canonical=()
unset _seen
declare -A _seen=()
for _p in "${START_PROFILES[@]}"; do
  _c="$(canonical_profile "$_p")"
  if [ -z "${_seen[$_c]:-}" ]; then
    _canonical+=("$_c")
    _seen[$_c]=1
  fi
done
START_PROFILES=("${_canonical[@]}")

# 验证 START_PROFILES ⊆ PROFILES（启动范围不能超出同步范围）
for _p in "${START_PROFILES[@]}"; do
  _ok=0
  for _q in "${PROFILES[@]}"; do
    [ "$_p" = "$_q" ] && _ok=1 && break
  done
  if [ "$_ok" = 0 ]; then
    echo "error: --with=$_p not in --profiles=${PROFILES[*]}" >&2
    echo "       先 --profiles=$_p 或 --all 把 profile 加入同步范围" >&2
    exit 2
  fi
done

# PROFILE → port 映射。新增 profile 时在这里加一行；同一台机器多个
# profile 共存时端口必须互不相同。
port_for_profile() {
  case "$(canonical_profile "$1")" in
    dsh-tui)  echo 21018 ;;
    web)      echo 21017 ;;
    dsh-edge) echo 21019 ;;
    *)        echo 21017 ;;
  esac
}

if ! command -v dsh >/dev/null 2>&1; then
  echo "未检测到 dsh CLI。先安装官方客户端：" >&2
  echo "  npm install -g @deepseek-ai/dsh" >&2
  exit 1
fi

if [ "$DO_PNPM" = 1 ] && ! command -v pnpm >/dev/null 2>&1; then
  echo "未检测到 pnpm。dsh plugin 把安装转发给 pnpm，请先安装：" >&2
  echo "  npm install -g pnpm   （或启用 corepack：corepack enable pnpm）" >&2
  exit 1
fi

# ── Phase 1: 编译（一次性）────────────────────────────────────────
echo "==> [1/4] compile TypeScript"
cd "$REPO_ROOT"
npm run compile >/dev/null

# ── Phase 2: 同步到每个 profile ─────────────────────────────────
# 每个 profile 独立走 §2-§3.7 全套（plugin add 上游包 + rsync + 嵌套
# pkg bootstrap）。编译已经做一次，重复执行 plugin add 是幂等的。
for PROFILE in "${PROFILES[@]}"; do
  PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
  NESTED_PKG="$PROFILE_DIR/node_modules/@deepseek-harness-edge-agent/dsh-edge-agent"

  echo
  echo "==> [2/4] sync bundle → profile=$PROFILE ($PROFILE_DIR)"

  # ── 2.1 dsh plugin add（首次或升级时初始化 profile + 装包）─────────
  # 如果嵌套包已存在（本地 rsync / 预装 / 旧版 install 留下），默认跳过
  # `dsh plugin add`（包不在 npm registry 上时 pnpm 会 404）。
  if [ "$DO_PNPM" = 1 ]; then
    if [ -d "$NESTED_PKG/lib" ] && [ "$FORCE_INSTALL" = 0 ]; then
      echo "        skip dsh plugin add (nested package already at $NESTED_PKG)"
      echo "         pass --force-install to force a re-install from npm."
    else
      echo "        dsh plugin add @deepseek-harness-edge-agent/dsh-edge-agent"
      dsh plugin --profile "$PROFILE" add @deepseek-harness-edge-agent/dsh-edge-agent || {
        echo "        (npm 404 预期：bundle 未发布；§3.5 兜底本地 install)"
      }
    fi
  else
    echo "        skip pnpm install (--skip-pnpm)"
  fi

  # ── 2.2-2.4 上游 @deepseek-ai 包（agent-loop / web-search / skill，仅不可解析时 add）─
  # §7.57: 原实现无条件执行且不带版本参数 —— npm latest 可能低于验证版本，hoist
  # 已提供 0.1.2-rc.1 时照样装出 profile-local 旧副本并遮蔽之：2026-09-15 实翻车，
  # 一次全量 install 把 dsh-agent-loop@0.1.0-rc.6 / dsh-web@0.0.1-rc.1 等 7 个旧包
  # 塞进 web profile，shadow 掉 hoist 验证链路（profile-node-modules-version-skew /
  # tui-unscoped-context-diagnosis 同族）。可解析（local 或 profiles/ hoist）即跳过；
  # 真新环境（两处都没有）仍走 plugin add 拉一份，行为不回退。
  if [ "$DO_PNPM" = 1 ]; then
    for _pkg in \
      @deepseek-ai/dsh-agent-loop \
      @deepseek-ai/dsh-tool-web \
      @deepseek-ai/dsh-web \
      @deepseek-ai/dsh-web-search-deepseek \
      @deepseek-ai/dsh-skill \
      @deepseek-ai/dsh-tool-skill \
      @deepseek-ai/dsh-skill-filesystem; do
      if [ -d "$PROFILE_DIR/node_modules/$_pkg" ] || [ -d "$DSH_HOME/profiles/node_modules/$_pkg" ]; then
        echo "        skip upstream $_pkg (already resolvable)"
        continue
      fi
      dsh plugin --profile "$PROFILE" add "$_pkg" >/dev/null 2>&1 || \
        echo "  warning: failed to add $_pkg — tool/skill/web-search capability may be missing." >&2
    done
  fi

  # ── 2.5 同步编译产物到 DSH 实际加载的嵌套包 ─────────────────
  mkdir -p "$NESTED_PKG"
  echo "        rsync lib/ → $NESTED_PKG/lib/"
  rsync -a --delete "$REPO_ROOT/lib/" "$NESTED_PKG/lib/"

  # ── 2.6 同步 repo 根的 cordis.patch.yml 到嵌套包（bundle-level patch）
  if [ -f "$REPO_ROOT/cordis.patch.yml" ]; then
    if ! diff -q "$REPO_ROOT/cordis.patch.yml" "$NESTED_PKG/cordis.patch.yml" >/dev/null 2>&1; then
      echo "        sync cordis.patch.yml → $NESTED_PKG/cordis.patch.yml (bundle patch)"
      cp "$REPO_ROOT/cordis.patch.yml" "$NESTED_PKG/cordis.patch.yml"
    fi
  fi

  # ── 2.7 确保 profile 的 dsh.profile.bundles 包含本 bundle ─────
  # profile 骨架（package.json）本体由 dsh CLI 首启自动生成（dsh-app-boot
  # initProfile / PROFILE_TEMPLATES），不归本 repo；这里只做增量改写。
  # §7.57: 原来整段被 if [ -f 骨架 ] 包住 —— 新环境 + --skip-pnpm 时骨架还不
  # 存在，静默 no-op：bundle 永不注册也不报错。注册是挂载的硬前提，缺骨架 /
  # 缺 python3 / JSON 改写失败三种情形现在全部 fail-fast。
  _PROFILE_PKG="$PROFILE_DIR/package.json"
  if ! command -v python3 >/dev/null 2>&1; then
    echo "  error: §2.7 需要 python3 改写 $_PROFILE_PKG，未找到 python3。" >&2
    exit 1
  fi
  # §7.61: 仓库拥有的 profile（profiles/$PROFILE/package.json 在仓库里）→
  # skeleton 自愈：直接拷仓库骨架引导容器，救活「新机器 + --skip-pnpm 时
  # §2.1 不跑、骨架永不生成」的死结（勘查实证 boot 不 auto-init 未知名，
  # 旧文案指路的 `dsh --profile X` 在新机上是死路）。
  if [ ! -f "$_PROFILE_PKG" ] && [ -f "$REPO_ROOT/profiles/$PROFILE/package.json" ]; then
    echo "        bootstrap profile skeleton from repo profiles/$PROFILE/package.json"
    mkdir -p "$PROFILE_DIR"
    cp "$REPO_ROOT/profiles/$PROFILE/package.json" "$_PROFILE_PKG"
  fi
  if [ ! -f "$_PROFILE_PKG" ]; then
    echo "  error: $_PROFILE_PKG 不存在 — profile \"$PROFILE\" 尚未初始化。" >&2
    echo "       去掉 --skip-pnpm 重跑（§2.1 的 dsh plugin add 会初始化容器），" >&2
    echo "       或先手动引导一次：" >&2
    echo "       dsh plugin --profile $PROFILE add @deepseek-harness-edge-agent/dsh-edge-agent" >&2
    exit 1
  fi
  python3 - "$_PROFILE_PKG" "$NESTED_PKG" <<'PYEOF' || { echo "  error: §2.7 注册改写失败（$_PROFILE_PKG 非法 JSON 或不可写）。" >&2; exit 1; }
import json, sys, os
path, nested = sys.argv[1], sys.argv[2]
with open(path) as f:
    d = json.load(f)
target = "@deepseek-harness-edge-agent/dsh-edge-agent"
bundles = d.setdefault("dsh", {}).setdefault("profile", {}).setdefault("bundles", [])
deps = d.setdefault("dependencies", {})
changed = False
if target not in bundles:
    bundles.append(target)
    changed = True
if target not in deps:
    rel = os.path.relpath(nested, os.path.dirname(path))
    deps[target] = f"file:{rel}"
    changed = True
if changed:
    with open(path, "w") as f:
        json.dump(d, f, indent=2)
        f.write("\n")
    print(f"  added {target} to bundles + dependencies")
PYEOF

  # ── 2.8 嵌套 package.json 同步（repo 根镜像）──────────────────
  # §7.57: 原实现是"缺才拷"（copy-once bootstrap）—— 之后 repo 根 package.json
  # 演进（如 2026-09-11 peerDeps 0.1.2-alpha.2 → 0.1.2-rc.1），嵌套拷贝永远停在
  # 首次 bootstrap 的快照。peerDeps 只是声明性提示（运行时解析走 profiles
  # hoist 链）所以至今没炸；但 exports 是真消费面 —— 哪天新增 subpath 导出，
  # §2.6 同步过去的新 patch 引用旧 package.json 里不存在的导出 →
  # ERR_MODULE_NOT_FOUND 且极难排查。改为与 §2.6 同款 diff-then-copy；
  # pnpm 链线只在首次 bootstrap 跑（日常只换文件内容，无需重装）。
  _NESTED_BOOTSTRAP=0
  if [ -f "$REPO_ROOT/package.json" ] && ! diff -q "$REPO_ROOT/package.json" "$NESTED_PKG/package.json" >/dev/null 2>&1; then
    if [ ! -f "$NESTED_PKG/package.json" ]; then
      _NESTED_BOOTSTRAP=1
      echo "        bootstrap nested pkg: cp package.json"
    else
      echo "        sync package.json → $NESTED_PKG/ (mirror repo root)"
    fi
    cp "$REPO_ROOT/package.json" "$NESTED_PKG/package.json"
  fi
  if [ "$_NESTED_BOOTSTRAP" = 1 ] && command -v pnpm >/dev/null 2>&1; then
    (cd "$PROFILE_DIR" && pnpm install --offline --ignore-scripts 2>&1 | tail -3) || \
      echo "  warning: pnpm install --offline failed; bundle may not be linked" >&2
  fi
done

# ── Phase 2.5: 同步共享资产（profile 无关）──────────────────────────
echo
echo "==> [2.5/4] sync shared assets"

# profiles/$PROFILE/cordis.patch.yml overlay（legacy）
for PROFILE in "${PROFILES[@]}"; do
  PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
  if [ -f "$REPO_ROOT/profiles/$PROFILE/cordis.patch.yml" ]; then
    if ! diff -q "$REPO_ROOT/profiles/$PROFILE/cordis.patch.yml" "$PROFILE_DIR/cordis.patch.yml" >/dev/null 2>&1; then
      echo "        sync profiles/$PROFILE/cordis.patch.yml → $PROFILE_DIR/cordis.patch.yml"
      cp "$REPO_ROOT/profiles/$PROFILE/cordis.patch.yml" "$PROFILE_DIR/cordis.patch.yml"
    fi
  fi
  if [ -f "$REPO_ROOT/profiles/$PROFILE/privacy-policy.json" ]; then
    if ! diff -q "$REPO_ROOT/profiles/$PROFILE/privacy-policy.json" "$PROFILE_DIR/privacy-policy.json" >/dev/null 2>&1; then
      echo "        sync profiles/$PROFILE/privacy-policy.json → $PROFILE_DIR/privacy-policy.json"
      cp "$REPO_ROOT/profiles/$PROFILE/privacy-policy.json" "$PROFILE_DIR/privacy-policy.json"
    fi
  fi
done

# agent-presets（一次性，profile 共享）
USER_PRESET_SRC="$REPO_ROOT/agent-presets"
USER_PRESET_DST="$DSH_HOME/.agent-presets"
if [ -d "$USER_PRESET_SRC" ]; then
  mkdir -p "$USER_PRESET_DST"
  if diff -qr "$USER_PRESET_SRC" "$USER_PRESET_DST" >/dev/null 2>&1; then
    echo "        agent-presets unchanged — skip"
  else
    echo "        sync agent-presets/ → $USER_PRESET_DST/"
    rsync -a --delete "$USER_PRESET_SRC/" "$USER_PRESET_DST/"
  fi
fi

# ── Phase 3: 启动 START_PROFILES 里的 profile ─────────────────────
# 顺序而非并行的原因：每个 profile 启动后端口立刻占用，下一个
# profile 起来时能通过 port_is_free 校验确认没撞。若并行启动，
# 第一个启动的还没 bind 之前第二个会以为端口空闲然后 EADDRINUSE。
#
# 默认 DO_RESTART=1 + START_PROFILES=PROFILES → 启动所有 PROFILES(§7.65 默认重启语义)
# --no-restart opt-out,跳过整个 Phase 3。
if [ "$DO_RESTART" = 0 ] || [ ${#START_PROFILES[@]} -eq 0 ]; then
  echo "==> [3/4] 不启动（--no-restart opt-out；显式启：--with=web 或 --with=tui 或 --with）"
  echo "    已同步 profiles: ${PROFILES[*]}"
  echo "    手动启动: cd \$DSH_HOME/profiles/<name> && source .env.sh && dsh --profile <name>"
  echo "    或:      ./install.sh --with=web,tui"
  exit 0
fi

# port_is_free: ss / netstat / python3 三档 fallback
port_is_free() {
  local _p="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -tln 2>/dev/null | awk '{print $4}' | grep -qE "(127\.0\.0\.1|0\.0\.0\.0|\*):${_p}$" && return 1
    return 0
  elif command -v netstat >/dev/null 2>&1; then
    netstat -tln 2>/dev/null | awk '{print $4}' | grep -qE "(127\.0\.0\.1|0\.0\.0\.0|\*):${_p}$" && return 1
    return 0
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$_p" <<'PYEOF' || return 1
import socket, sys
p = int(sys.argv[1])
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
try:
    s.bind(("127.0.0.1", p))
    s.close()
    sys.exit(0)
except OSError:
    sys.exit(1)
PYEOF
  fi
  return 0
}

DSH_BIN="${DSH_EDGE_BIN:-$(command -v dsh 2>/dev/null || echo /home/etsme/.npm-global/bin/dsh)}"
if [ ! -x "$DSH_BIN" ]; then
  echo "error: dsh binary not found (tried \$DSH_EDGE_BIN, PATH, /home/etsme/.npm-global/bin/dsh)" >&2
  exit 1
fi

echo
echo "==> [3/4] restart DSH (profiles: ${PROFILES[*]})"

# 记录每个 profile 的启动结果，最后汇总报告
declare -A START_RESULT
START_ORDER=()

for PROFILE in "${START_PROFILES[@]}"; do
  PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
  INLINE_PORT="$(port_for_profile "$PROFILE")"
  LOG="${DSH_EDGE_LOG:-$DSH_HOME/profiles/$PROFILE/run.log}"

  echo
  echo "  ── profile: $PROFILE (port=$INLINE_PORT, log=$LOG) ──"

  # 只匹配真正的 dsh node 进程（命令行含 'node' 和 'dsh'），避免
  # 把 pgrep 自身或包装 shell 一起杀掉。
  pids=$(ps -eo pid,cmd 2>/dev/null | awk '/node.*dsh --profile '"$PROFILE"'/{print $1}') || true
  pids=$(echo "$pids" | tr -s '[:space:]' ' ' | sed 's/^ *//;s/ *$//')
  if [ -n "$pids" ]; then
    echo "      killing PIDs: $pids"
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      sleep 1
      ps -eo pid,cmd 2>/dev/null | grep -q "node.*dsh --profile $PROFILE" || break
    done
  fi

  # §7.43: 等待端口真正空闲。TIME_WAIT 会把 TCP 端口挂 ~60s，必须
  # 探测端口而非只看进程退出，否则会 EADDRINUSE。
  echo "      waiting for port $INLINE_PORT to be free …"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if port_is_free "$INLINE_PORT"; then
      echo "      port $INLINE_PORT is free"
      break
    fi
    sleep 1
  done

  mkdir -p "$(dirname "$LOG")"

  # 优先 source profile-local .env.sh（web profile 自带），fallback repo .env.sh
  PROFILE_ENV_SH="$PROFILE_DIR/.env.sh"
  if [ -f "$PROFILE_ENV_SH" ]; then
    _LAUNCH_ENV="source '$PROFILE_ENV_SH' 2>/dev/null || true; export DSH_EDGE_HTTP_PORT=${INLINE_PORT}"
  else
    _LAUNCH_ENV="source '$REPO_ROOT/.env.sh' 2>/dev/null || true; export DSH_EDGE_HTTP_PORT=${INLINE_PORT}"
  fi
  echo "      DSH_EDGE_HTTP_PORT=${INLINE_PORT} (profile=${PROFILE}, forced inline)"

  # 启动（后台，detach）。nohup + disown 双保险，让进程不被 shell
  # 退出时的 SIGHUP 杀掉。
  nohup bash -c "$_LAUNCH_ENV && exec '$DSH_BIN' --profile $PROFILE" \
    > "$LOG" 2>&1 &
  NEW_PID=$!
  disown 2>/dev/null || true
  echo "      launched PID=$NEW_PID"

  # 等 dsh 真正启动（grep intentRouter: found 或 dsh web: http:// 行）
  for _ in 1 2 3 4 5 6 7 8; do
    sleep 1
    ps -eo pid,cmd 2>/dev/null | grep -q "node.*dsh --profile $PROFILE" || continue
    grep -q 'dsh web: http://\|intentRouter: found' "$LOG" 2>/dev/null && break
  done

  if ps -eo pid,cmd 2>/dev/null | grep -q "node.*dsh --profile $PROFILE"; then
    START_RESULT["$PROFILE"]="OK"
    START_ORDER+=("$PROFILE")
    echo "      ✓ $PROFILE up"
  else
    START_RESULT["$PROFILE"]="FAIL"
    START_ORDER+=("$PROFILE")
    echo "      ✗ $PROFILE did not stay up. tail of $LOG:" >&2
    tail -n 15 "$LOG" >&2 || true
  fi
done

# ── Phase 4: 汇总报告 ───────────────────────────────────────────
echo
echo "==> [4/4] deploy summary"

OK_COUNT=0
FAIL_COUNT=0
for PROFILE in "${START_ORDER[@]}"; do
  PORT="$(port_for_profile "$PROFILE")"
  case "${START_RESULT[$PROFILE]}" in
    OK)   echo "  ✓ $PROFILE :$PORT"
          OK_COUNT=$((OK_COUNT + 1)) ;;
    FAIL) echo "  ✗ $PROFILE FAILED — see $DSH_HOME/profiles/$PROFILE/run.log"
          FAIL_COUNT=$((FAIL_COUNT + 1)) ;;
  esac
done

echo
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "deploy PARTIAL: $OK_COUNT up, $FAIL_COUNT failed."
  echo "  排查: tail -f \$DSH_HOME/profiles/<name>/run.log"
  exit 1
fi

echo "deploy OK: ${START_PROFILES[*]} (sync 范围: ${PROFILES[*]})."
echo "  访问入口:"
for PROFILE in "${START_PROFILES[@]}"; do
  PORT="$(port_for_profile "$PROFILE")"
  case "$PROFILE" in
    web)      echo "    web:    http://127.0.0.1:$PORT/  (web UI at :3080 if dsh-web-app installed)" ;;
    dsh-tui)  echo "    dsh-tui: 终端已在运行；HTTP API http://127.0.0.1:$PORT/v1/chat" ;;
    dsh-edge) echo "    dsh-edge: HTTP API http://127.0.0.1:$PORT/v1/chat (GET /v1/health; 无 UI)" ;;
    *)        echo "    $PROFILE: http://127.0.0.1:$PORT/" ;;
  esac
done
