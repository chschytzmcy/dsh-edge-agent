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
#   ./install.sh                                # 默认 profile web（2026-09-03 后默认）
#   DSH_EDGE_PROFILE=my-edge ./install.sh       # 自定义 profile 名（仅 back-compat）
#   DSH_HOME=~/.dsh ./install.sh                # 自定义 DSH home
#   DSH_EDGE_LOG=./run.log ./install.sh         # 自定义日志路径
#   DSH_EDGE_LOG_ROOT=/var/log/dsh ./install.sh # 自定义日志根目录
#   ./install.sh --no-restart                   # 装完不重启
#   ./install.sh --skip-pnpm                    # 跳过 npm install（假设已装过）
#   ./install.sh --force-install                # 强制重装本包（覆盖 rsync）
#   ./install.sh --to-profile <name>           # 把 dsh-edge-agent 作为 bundle
#                                                #   装到 <name> profile；profile 名
#                                                #   可为 web / tui / 任何自定义

set -euo pipefail

# 把常见 npm/pnpm/yarn 全局 bin 目录加到 PATH，让 dsh / pnpm / corepack
# 在干净环境下也能找到（CI / nohup 启动时常见）。
_NPM_BIN=""
for _cand in "$HOME/.npm-global/bin" "$HOME/.local/share/npm/bin" "/usr/local/bin" "$HOME/.nvm/versions/node/$(node -p 'process.version' 2>/dev/null || echo vX.Y.Z 2>/dev/null)/bin" "$HOME/.local/share/pnpm" "$HOME/.bun/bin"; do
  [ -d "$_cand" ] && _NPM_BIN="$_NPM_BIN:$_cand"
done
[ -n "$_NPM_BIN" ] && export PATH="${PATH}$_NPM_BIN"

PROFILE="${DSH_EDGE_PROFILE:-web}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
# 默认日志路径写到 web profile 的 run.log（dsh host stdout 也被 file-logger 接管
# 写到 DSH_EDGE_LOG_ROOT 指向的 channel root，profile run.log 只看 host boot 行）。
# 可被 DSH_EDGE_LOG 完全覆盖（写到任何位置）。
LOG="${DSH_EDGE_LOG:-${DSH_EDGE_LOG_ROOT:-$DSH_HOME/profiles/$PROFILE/run.log}}"
REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
NESTED_PKG="$PROFILE_DIR/node_modules/@deepseek-harness-edge-agent/dsh-edge-agent"

DO_RESTART=1
DO_PNPM=1
FORCE_INSTALL=0
# --to-profile flag 指定宿主 profile 名；dsh-edge-agent 是 profile-agnostic
# bundle，可装到 web / tui / 任何自定义 profile。
TO_PROFILE=""
for arg in "$@"; do
  case "$arg" in
    --no-restart) DO_RESTART=0 ;;
    --skip-pnpm)  DO_PNPM=0 ;;
    --force-install) FORCE_INSTALL=1 ;;
    --to-profile) TO_PROFILE="$2"; shift 2 ;;
    --to-profile=*) TO_PROFILE="${arg#*=}"; shift ;;
    -h|--help)
      sed -n '2,35p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

# 应用 --to-profile（任意 profile 名都接受；profile-agnostic bundle）
if [ -n "$TO_PROFILE" ]; then
  PROFILE="$TO_PROFILE"
  PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
  NESTED_PKG="$PROFILE_DIR/node_modules/@deepseek-harness-edge-agent/dsh-edge-agent"
  # 共享目标 profile 的日志约定（多数 profile 没有自定义就回退到 dsh-home 默认）
  if [ -z "${DSH_EDGE_LOG:-}" ]; then
    LOG="$DSH_HOME/profiles/$PROFILE/run.log"
  fi
fi

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
    # 本 bundle 不发布到 npm registry（pnpm 404 是预期）；失败时依赖 §3.5/§3.6
    # 本地兜底：拷贝 nested pkg + 编辑 profile/package.json 注册 bundles。
    dsh plugin --profile "$PROFILE" add @deepseek-harness-edge-agent/dsh-edge-agent || {
      echo "        (npm 404 预期：bundle 未发布；§3.5/§3.6 兜底本地 install)"
    }
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

# ── 2.6. 安装上游 web search 包（tool-web / web / web-search-deepseek）──
# cordis.patch.yml 的 tool-web / web / dsh-web / web-search-deepseek 行
# 需要以下包在 profile 的 node_modules 里。缺任何一个都会导致 web_search
# 工具注册失败（ctx.tools 看不到 web_search / web_fetch），cloud LLM 也就
# 无法调用搜索工具。`dsh plugin add` 是幂等的。
if [ "$DO_PNPM" = 1 ]; then
  echo "==> [2.6/5] install upstream web-search packages  (profile=$PROFILE)"
  for _pkg in \
    @deepseek-ai/dsh-tool-web \
    @deepseek-ai/dsh-web \
    @deepseek-ai/dsh-web-search-deepseek; do
    dsh plugin --profile "$PROFILE" add "$_pkg" >/dev/null 2>&1 || {
      echo "  warning: failed to add $_pkg — web search may not work." >&2
    }
  done
fi

# ── 2.7. 安装上游 skill 包（dsh-skill / dsh-tool-skill / dsh-skill-filesystem）──
# cordis.patch.yml 中 tool-skill + skill-filesystem 已 enabled，但需要
# 这些包在 profile 的 node_modules 中。缺任何一个都会导致 skill catalog
# 为空、LLM 看不到 <available_skills>、skill tool 不可用。
# `dsh plugin add` 是幂等的。
if [ "$DO_PNPM" = 1 ]; then
  echo "==> [2.7/5] install upstream skill packages  (profile=$PROFILE)"
  for _pkg in \
    @deepseek-ai/dsh-skill \
    @deepseek-ai/dsh-tool-skill \
    @deepseek-ai/dsh-skill-filesystem; do
    dsh plugin --profile "$PROFILE" add "$_pkg" >/dev/null 2>&1 || {
      echo "  warning: failed to add $_pkg — skill system may not work." >&2
    }
  done
fi

# ── 2.8. Web UI 家族 ─────────────────────────────────────
# dsh-edge-agent bundle 是 profile-agnostic 的安全插件层。宿主 profile
# 决定 webui 是否存在；web profile 自带 dsh-web-app / dsh-web-ui-all /
# dsh-im（先有 webui，再加 dsh-edge-agent bundle），本步骤不主动拉 webui。
#
# 加入本 bundle 的标准操作：
#   ./install.sh                                  # 默认 PROFILE=web
#   ./install.sh --to-profile web                 # 等价
#   ./install.sh --to-profile tui                 # tui 宿主（如有）
#   DSH_EDGE_PROFILE=my-edge ./install.sh         # 任意自定义 profile
echo "==> [2.8/5] webui is owned by the host profile; this bundle rides on top of it"

# ── 3. 同步编译产物到 DSH 实际加载的嵌套包 ───────────────────────────
# Clean state（嵌套包不存在，例如 fresh profile 或上次 install 失败留下）
# 时，§2 的 dsh plugin add 会因 npm 404 失败但被容忍；这里 mkdir 本地
# 嵌套包，让 rsync + §3.5 cordis.patch.yml 同步能跑。
mkdir -p "$NESTED_PKG"
echo "==> [3/5] rsync lib/ → $NESTED_PKG/lib/"
rsync -a --delete "$REPO_ROOT/lib/" "$NESTED_PKG/lib/"

# ── 3.5. 同步 repo 根的 cordis.patch.yml 到嵌套包（bundle-level patch）──
# 2026-09-03：发现 b1c11e0 commit 把 profile-level patch 改成空 stub（7 行
# 注释 + []），意图让 repo 根的 cordis.patch.yml（484 行，19 个 plugin 定义）
# 通过 `dsh.profile.bundles` 加载。但 install.sh 之前**只**同步
# profiles/$PROFILE/cordis.patch.yml 到 $PROFILE_DIR/cordis.patch.yml
# （profile overlay 层），从未同步根 patch 到嵌套包（bundle-level）。结果
# dsh 启动只加载 dsh-base 的 30 个 plugin，19 个 dsh-edge-agent plugin
# 全部未注册，:21017 不 listen、file-logger 不接管 stdout、audit-log
# 不写。修复：在嵌套包根同步 cordis.patch.yml（diff 避免每次都写）。
if [ -f "$REPO_ROOT/cordis.patch.yml" ]; then
  if ! diff -q "$REPO_ROOT/cordis.patch.yml" "$NESTED_PKG/cordis.patch.yml" >/dev/null 2>&1; then
    echo "==> [3.5/5] sync cordis.patch.yml → $NESTED_PKG/cordis.patch.yml (bundle patch)"
    cp "$REPO_ROOT/cordis.patch.yml" "$NESTED_PKG/cordis.patch.yml"
  fi
fi

# ── 3.6. 确保 profile 的 dsh.profile.bundles 包含本 bundle ────────────
# 2026-09-03：手动创建的 profile（不在 PROFILE_TEMPLATES 里）初始
# bundles 列表只有 [@deepseek-ai/dsh-base]，dsh plugin add 本包会因
# npm 404 静默失败（包不在 registry），导致 bundles 永远不增。手动
# 加 @deepseek-harness-edge-agent/dsh-edge-agent 到 bundles + dependencies。
# 用 python3 JSON 编辑（profile/package.json 不是标准 JSON 但兼容）。
if command -v python3 >/dev/null 2>&1; then
  _PROFILE_PKG="$PROFILE_DIR/package.json"
  if [ -f "$_PROFILE_PKG" ]; then
    python3 - "$_PROFILE_PKG" "$NESTED_PKG" <<'PYEOF' || true
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
    # Use a relative file: link so pnpm symlinks to the nested package dir
    # we already rsync'd into. The nested package's package.json must
    # exist for pnpm to resolve the file: reference (§3.7 bootstraps it
    # if dsh plugin add was skipped due to npm 404).
    rel = os.path.relpath(nested, os.path.dirname(path))
    deps[target] = f"file:{rel}"
    changed = True
if changed:
    with open(path, "w") as f:
        json.dump(d, f, indent=2)
        f.write("\n")
    print(f"  added {target} to bundles + dependencies")
PYEOF
  fi
fi

# ── 3.7. Bootstrap nested pkg（clean reinstall 路径）────────────
# 2026-09-03：clean reinstall（嵌套包被 rm 掉 + profile bundles 清空）
# 时，§2 的 `dsh plugin add` 因 npm 404 失败但被容忍；§3 mkdir 了嵌套
# 包目录，但缺 package.json — pnpm 无法识别 file: 引用目标，profile
# 启动时 dsh 找不到 bundle。这里 cp repo 根的 package.json 进嵌套包，
# 然后 `pnpm install --offline` 在 profile 目录让 pnpm 把 file: 引用
# 解析为本地软链接（web profile 已有 pnpm store 缓存，不需要网络）。
if [ ! -f "$NESTED_PKG/package.json" ] && [ -f "$REPO_ROOT/package.json" ]; then
  echo "==> [3.7/5] bootstrap nested pkg: cp package.json + pnpm wire file: dep"
  cp "$REPO_ROOT/package.json" "$NESTED_PKG/package.json"
  if command -v pnpm >/dev/null 2>&1; then
    (cd "$PROFILE_DIR" && pnpm install --offline --ignore-scripts 2>&1 | tail -5) || {
      echo "warning: pnpm install --offline failed; bundle may not be linked" >&2
    }
  else
    echo "warning: pnpm not on PATH; nested pkg created but file: dep not wired" >&2
  fi
fi

# ── 4. 同步 profile overlay（legacy, no-op for web profile）────────
# 2026-09-03 (§7.31): bundle profile-agnostic（user 反馈 2026-09-03）；
# 任何 profile 都不依赖 profiles/$PROFILE/ overlay，bundle 自带完整
# cordis.patch.yml 在 §3.5 已同步。No-op 路径走 else 分支。
if [ -f "$REPO_ROOT/profiles/$PROFILE/cordis.patch.yml" ]; then
  if ! diff -q "$REPO_ROOT/profiles/$PROFILE/cordis.patch.yml" "$PROFILE_DIR/cordis.patch.yml" >/dev/null 2>&1; then
    echo "==> [4/5] sync profiles/$PROFILE/cordis.patch.yml → $PROFILE_DIR/cordis.patch.yml"
    cp "$REPO_ROOT/profiles/$PROFILE/cordis.patch.yml" "$PROFILE_DIR/cordis.patch.yml"
  else
    echo "==> [4/5] cordis.patch.yml unchanged — skip"
  fi
else
  echo "==> [4/5] no profiles/$PROFILE/cordis.patch.yml — skip (bundle-level patch synced at §3.5)"
fi
if [ -f "$REPO_ROOT/profiles/$PROFILE/privacy-policy.json" ]; then
  if ! diff -q "$REPO_ROOT/profiles/$PROFILE/privacy-policy.json" "$PROFILE_DIR/privacy-policy.json" >/dev/null 2>&1; then
    echo "==> [4/5] sync profiles/$PROFILE/privacy-policy.json → $PROFILE_DIR/privacy-policy.json"
    cp "$REPO_ROOT/profiles/$PROFILE/privacy-policy.json" "$PROFILE_DIR/privacy-policy.json"
  fi
else
  echo "==> [4/5] no profiles/$PROFILE/privacy-policy.json — skip (privacy policy lives at DSH_EDGE_PRIVACY_POLICY_PATH)"
fi

# 2026-08-31: 同步自定义 agent-preset 到 $DSH_HOME/.agent-presets/
# 2026-09-03 (§7.31): agent-presets 改放 repo 根 `agent-presets/`，不再走
# profiles/$PROFILE/ overlay（overlay 已删除）。从 repo 根同步到用户级
# $DSH_HOME/.agent-presets/，dsh CLI 的 includeUserRoot 自动发现。
USER_PRESET_SRC="$REPO_ROOT/agent-presets"
USER_PRESET_DST="$DSH_HOME/.agent-presets"
if [ -d "$USER_PRESET_SRC" ]; then
  mkdir -p "$USER_PRESET_DST"
  if diff -qr "$USER_PRESET_SRC" "$USER_PRESET_DST" >/dev/null 2>&1; then
    echo "==> [4/5] agent-presets unchanged — skip"
  else
    echo "==> [4/5] sync agent-presets/ → $USER_PRESET_DST/"
    rsync -a --delete "$USER_PRESET_SRC/" "$USER_PRESET_DST/"
  fi
fi

# ── 5. 重启 DSH ───────────────────────────────────────────────────────
if [ "$DO_RESTART" = 0 ]; then
  echo "==> [5/5] --no-restart set; DSH not restarted"
  exit 0
fi

echo "==> [5/5] restart DSH (profile=$PROFILE, log=$LOG)"
echo "      (file-logger plugin owns this path; see src/dsh-adapter/file-logger.ts)"
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

# §7.43 (2026-09-07): inline DSH_EDGE_HTTP_PORT per profile + port-wait loop.
# Three failure modes that the previous code allowed when restarting a
# profile whose port collided with a sibling:
#   1. PROFILE_ENV_SH missing → fell back to repo .env.sh → port default
#      21017 (caused EADDRINUSE when another profile already on 21017).
#   2. PROFILE_ENV_SH present but had a bash syntax error → `source` returned
#      non-zero, port override never applied.
#   3. Old process killed but port still in TIME_WAIT → new process binds,
#      EADDRINUSE on the next restart.
# We (a) FORCE the port per-profile after the source, and (b) wait for
# the actual port to be free (not just the process exit) before launching.
# Map: dsh-tui → 21018 (the tui host lives here; web/others stay on 21017).
INLINE_PORT=21017
case "$PROFILE" in
  dsh-tui) INLINE_PORT=21018 ;;
esac

# Wait for the target port to actually be free. TIME_WAIT can hold a
# TCP port for ~60s after the socket closes; net.Server has no graceful
# close, so kill → close lag is typically 1-5s. We poll the port (not
# just the process) for up to 10s before launching.
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
  return 0  # can't probe — assume free
}
echo "      waiting for port $INLINE_PORT to be free …"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if port_is_free "$INLINE_PORT"; then
    echo "      port $INLINE_PORT is free"
    break
  fi
  sleep 1
done

DSH_BIN="${DSH_EDGE_BIN:-$(command -v dsh 2>/dev/null || echo /home/etsme/.npm-global/bin/dsh)}"
if [ ! -x "$DSH_BIN" ]; then
  echo "error: dsh binary not found (tried \$DSH_EDGE_BIN, PATH, /home/etsme/.npm-global/bin/dsh)" >&2
  exit 1
fi

# 确保日志目录存在（file-logger 也会兜底 mkdir，但提前创建能更早暴露
# 权限错误，避免 nohup 启动后才发现写不进文件）。
mkdir -p "$(dirname "$LOG")"

# web profile 自带 .env.sh（设 6 个 channel env override + source repo .env）；
# 优先 source 它（web profile 常见 case），fallback 到 repo .env.sh。其他 profile
# 如果有自己 .env.sh 也会被优先 source。
# §7.43: after sourcing, FORCE DSH_EDGE_HTTP_PORT to the per-profile value.
# Source may fail (syntax error, missing file) or apply the wrong default;
# the inline export below is the last word and prevents EADDRINUSE on
# restart of a profile whose sibling is already bound to the default port.
PROFILE_ENV_SH="$PROFILE_DIR/.env.sh"
if [ -f "$PROFILE_ENV_SH" ]; then
  _LAUNCH_ENV="source '$PROFILE_ENV_SH' 2>/dev/null || true; export DSH_EDGE_HTTP_PORT=${INLINE_PORT}"
else
  _LAUNCH_ENV="source '$REPO_ROOT/.env.sh' 2>/dev/null || true; export DSH_EDGE_HTTP_PORT=${INLINE_PORT}"
fi
echo "      DSH_EDGE_HTTP_PORT=${INLINE_PORT} (profile=${PROFILE}, forced inline)"
nohup bash -c "$_LAUNCH_ENV && exec '$DSH_BIN' --profile $PROFILE" \
  > "$LOG" 2>&1 &
NEW_PID=$!
disown 2>/dev/null || true
echo "      launched PID=$NEW_PID"

# 等 DSH 完全启动
for _ in 1 2 3 4 5 6 7 8; do
  sleep 1
  ps -eo pid,cmd 2>/dev/null | grep -q "node.*dsh --profile $PROFILE" || continue
  grep -q 'dsh web: http://\|intentRouter: found' "$LOG" 2>/dev/null && break
done

if ps -eo pid,cmd 2>/dev/null | grep -q "node.*dsh --profile $PROFILE"; then
  echo
  echo "deploy OK. tail of $LOG:"
  tail -n 6 "$LOG"
  echo
  echo "Open web UI:"
  echo "  http://127.0.0.1:3080/"
  echo
  echo "Or tail bundle channel logs:"
  echo "  tail -f \$DSH_EDGE_LOG_ROOT/dsh-edge-agent.log   # (path set by web profile .env.sh)"
else
  echo
  echo "warning: DSH did not stay up. tail of $LOG:" >&2
  tail -n 20 "$LOG" >&2 || true
  exit 1
fi