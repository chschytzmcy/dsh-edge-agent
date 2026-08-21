#!/usr/bin/env bash
# dsh-edge-agent 一键部署（编译 + 安装 + 同步 + 重启）。
#
# 走官方 dsh CLI 的 profile 插件机制：`add` 自动初始化 profile（首层
# dsh-base），pnpm 安装后按 dsh.bundle.patch 元数据把本包追加为 bundle
# 层；本包的 patch 会一并 insert 全部 19 个核心插件。本地代码改动会
# 编译 + rsync 到 ~/.dsh/profiles/<name>/ 下的嵌套包，然后重启 DSH。
#
# 前置：
#   - dsh CLI 已安装（npm install -g @deepseek-ai/dsh）
#   - pnpm 已安装（npm install -g pnpm 或 corepack enable pnpm）
#
# 用法：
#   ./install.sh                                # 默认 profile dsh-edge-agent
#   DSH_EDGE_PROFILE=my-edge ./install.sh       # 自定义 profile 名
#   DSH_HOME=~/.dsh ./install.sh                # 自定义 DSH home
#   DSH_EDGE_LOG=./run.log ./install.sh         # 自定义日志路径
#   ./install.sh --no-restart                   # 装完不重启
#   ./install.sh --skip-pnpm                    # 跳过 npm install（假设已装过）
#   ./install.sh --force-install                # 强制重装本包（覆盖 rsync）

set -euo pipefail

# 把常见 npm/pnpm/yarn 全局 bin 目录加到 PATH，让 dsh / pnpm / corepack
# 在干净环境下也能找到（CI / nohup 启动时常见）。
_NPM_BIN=""
for _cand in "$HOME/.npm-global/bin" "$HOME/.local/share/npm/bin" "/usr/local/bin" "$HOME/.nvm/versions/node/$(node -p 'process.version' 2>/dev/null || echo vX.Y.Z 2>/dev/null)/bin" "$HOME/.local/share/pnpm" "$HOME/.bun/bin"; do
  [ -d "$_cand" ] && _NPM_BIN="$_NPM_BIN:$_cand"
done
[ -n "$_NPM_BIN" ] && export PATH="${PATH}$_NPM_BIN"

PROFILE="${DSH_EDGE_PROFILE:-dsh-edge-agent}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
LOG="${DSH_EDGE_LOG:-/tmp/dsh-edge-agent.log}"
REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
NESTED_PKG="$PROFILE_DIR/node_modules/@deepseek-harness-edge-agent/dsh-edge-agent"

DO_RESTART=1
DO_PNPM=1
FORCE_INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --no-restart) DO_RESTART=0 ;;
    --skip-pnpm)  DO_PNPM=0 ;;
    --force-install) FORCE_INSTALL=1 ;;
    -h|--help)
      sed -n '2,32p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

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

# ── 1. 编译 ────────────────────────────────────────────────────────────
echo "==> [1/5] compile TypeScript"
cd "$REPO_ROOT"
npm run compile >/dev/null

# ── 2. dsh plugin add（首次或升级时初始化 profile + 装包）─────────────
# 如果嵌套包已存在（本地 rsync / 预装 / 旧版 install 留下），默认跳过
# `dsh plugin add`（包不在 npm registry 上时 pnpm 会 404）。
# 需要强制重装时传 --force-install。
if [ "$DO_PNPM" = 1 ]; then
  if [ -d "$NESTED_PKG/lib" ] && [ "$FORCE_INSTALL" = 0 ]; then
    echo "==> [2/5] skip dsh plugin add (nested package already at $NESTED_PKG)"
    echo "         pass --force-install to force a re-install from npm."
  else
    echo "==> [2/5] dsh plugin add @deepseek-harness-edge-agent/dsh-edge-agent  (profile=$PROFILE)"
    dsh plugin --profile "$PROFILE" add @deepseek-harness-edge-agent/dsh-edge-agent
  fi
else
  echo "==> [2/5] skip pnpm install (--skip-pnpm)"
fi

# ── 2.5. 安装上游 agent-loop 包（DSH 官方方案）────────────────────────
# dsh-base 的 cordis.patch.yml 声明了 `@deepseek-ai/dsh-agent-loop`，但
# 该包不在 npm registry 上 dsh-base 的依赖里。第一次部署 profile 时
# 必须显式 `dsh plugin add`，否则运行期报 "no agent factory registered"，
# LLM 工具调用全部失败（agent loop 无法分发工具）。
# 重复运行时 `dsh plugin add` 是幂等的（pnpm 检测已安装就跳过）。
if [ "$DO_PNPM" = 1 ]; then
  echo "==> [2.5/5] dsh plugin add @deepseek-ai/dsh-agent-loop  (profile=$PROFILE)"
  dsh plugin --profile "$PROFILE" add @deepseek-ai/dsh-agent-loop || {
    echo "warning: failed to add dsh-agent-loop; tool calling may not work." >&2
  }
fi

# ── 3. 同步编译产物到 DSH 实际加载的嵌套包 ───────────────────────────
if [ ! -d "$NESTED_PKG" ]; then
  echo "error: nested package copy not found: $NESTED_PKG" >&2
  echo "       did step 2 fail? Re-run without --skip-pnpm." >&2
  exit 1
fi
echo "==> [3/5] rsync lib/ → $NESTED_PKG/lib/"
rsync -a --delete "$REPO_ROOT/lib/" "$NESTED_PKG/lib/"

# ── 4. 同步 cordis.patch.yml（如果仓库里有）──────────────────────────
if [ -f "$REPO_ROOT/profiles/$PROFILE/cordis.patch.yml" ]; then
  if ! diff -q "$REPO_ROOT/profiles/$PROFILE/cordis.patch.yml" "$PROFILE_DIR/cordis.patch.yml" >/dev/null 2>&1; then
    echo "==> [4/5] sync profiles/$PROFILE/cordis.patch.yml → $PROFILE_DIR/cordis.patch.yml"
    cp "$REPO_ROOT/profiles/$PROFILE/cordis.patch.yml" "$PROFILE_DIR/cordis.patch.yml"
  else
    echo "==> [4/5] cordis.patch.yml unchanged — skip"
  fi
else
  echo "==> [4/5] no profiles/$PROFILE/cordis.patch.yml — skip"
fi

# ── 5. 重启 DSH ───────────────────────────────────────────────────────
if [ "$DO_RESTART" = 0 ]; then
  echo "==> [5/5] --no-restart set; DSH not restarted"
  exit 0
fi

echo "==> [5/5] restart DSH (profile=$PROFILE, log=$LOG)"
# 只匹配真正的 dsh node 进程（PID 为数字，命令行含 'node' 和 'dsh'），
# 避免把 pgrep 自身或包装 shell 一起杀掉。
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

DSH_BIN="${DSH_EDGE_BIN:-$(command -v dsh 2>/dev/null || echo /home/etsme/.npm-global/bin/dsh)}"
if [ ! -x "$DSH_BIN" ]; then
  echo "error: dsh binary not found (tried \$DSH_EDGE_BIN, PATH, /home/etsme/.npm-global/bin/dsh)" >&2
  exit 1
fi

nohup bash -c "source '$REPO_ROOT/.env.sh' && exec '$DSH_BIN' --profile $PROFILE" \
  > "$LOG" 2>&1 &
NEW_PID=$!
disown 2>/dev/null || true
echo "      launched PID=$NEW_PID"

# 等 DSH 完全启动
for _ in 1 2 3 4 5 6 7 8; do
  sleep 1
  ps -eo pid,cmd 2>/dev/null | grep -q "node.*dsh --profile $PROFILE" || continue
  grep -q 'http-api.*found and valid\|intentRouter: found' "$LOG" 2>/dev/null && break
done

if ps -eo pid,cmd 2>/dev/null | grep -q "node.*dsh --profile $PROFILE"; then
  echo
  echo "deploy OK. tail of $LOG:"
  tail -n 6 "$LOG"
  echo
  echo "Try a request:"
  echo "  curl -s -X POST http://127.0.0.1:\${DSH_EDGE_HTTP_PORT:-21017}/v1/chat \\"
  echo "    -H 'Authorization: Bearer \${EDGE_API_KEY}' \\"
  echo "    -H 'Content-Type: application/json' \\"
  echo "    -d '{\"message\":\"帮我计算 7 * 8\"}'"
else
  echo
  echo "warning: DSH did not stay up. tail of $LOG:" >&2
  tail -n 20 "$LOG" >&2 || true
  exit 1
fi