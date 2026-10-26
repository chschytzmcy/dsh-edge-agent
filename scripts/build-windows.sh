#!/usr/bin/env bash
# build-windows.sh — Windows 构建打包（Git Bash / MSYS2）
#
# 支持矩阵：Windows **仅支持桌面版**（DSH 桌面 App）。桌面 App 是
# Electron 独占管理 `desktop` profile 的，CLI 碰不了它；所以 Windows
# 上没有"独立 dsh-cli / dsh-web / dsh-edge-agent http profile"的部署
# 路径 —— 那三条属于 macOS / Linux（见 build-macos.sh / build-linux.sh）。
#
# 产物：
#   tar（分发）  dist/dsh-edge-agent-{desktop-safe,full}.tar.gz (+ .sha256)
#   link（开发）  dist/installable/dsh-edge-agent-{desktop-safe,full}/
#
# 两种模式同源（同一 staging 树），由 scripts/_pack-core.mjs 保证。
#
# 用法：
#   bash scripts/build-windows.sh                          # 全量构建两种产物
#   bash scripts/build-windows.sh --no-build               # 复用现有 lib/
#   bash scripts/build-windows.sh --install-desktop=link    # 构建 + 切 link:（开发）
#   bash scripts/build-windows.sh --install-desktop=tar     # 构建 + 切 file:（分发）
#   bash scripts/build-windows.sh --desktop-profile=name    # 目标 profile（默认 desktop）
#
# Windows 专属说明：
#   - Git Bash 自带 GNU tar 1.35（--no-xattrs 可用）+ shasum
#   - make / rsync / setsid / ss 都没有 → make package / install.sh 不可用
#   - App 开着也能构建：rebuild 撞活句柄锁时自动降级为就地同步
#     （rename EPERM 且重试救不了，一天撞过 3 次）
#   - 路径含空格（"C:\Program Files\" / "DeepSeek Harness\"）—— 所有 argv
#     处理在 Node 侧完成，不经 shell 单词切分
#
# 找不到 node / dsh 时用 NODE_BIN / DSH_BIN 覆盖。

set -euo pipefail

# shellcheck source=_platform-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/_platform-common.sh"

DO_BUILD=1
INSTALL_DESKTOP=""
DESKTOP_PROFILE="desktop"

for arg in "$@"; do
  case "$arg" in
    --no-build) DO_BUILD=0 ;;
    --install-desktop=link|--install-desktop=tar) INSTALL_DESKTOP="${arg#*=}" ;;
    --install-desktop) INSTALL_DESKTOP="link" ;;
    --desktop-profile=*) DESKTOP_PROFILE="${arg#*=}" ;;
    --emit-dir) : ;;  # 历史用法（no-op）：installable 目录每次都重建
    -h|--help)
      sed -n '2,26p' "$0"
      exit 0
      ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

dsh_find_node
echo "==> node:  $NODE_BIN ($("$NODE_BIN" -v))"

# ── 1. 编译 ────────────────────────────────────────────────────────────
if [ "$DO_BUILD" = 1 ] || [ ! -f "$REPO/lib/index.js" ] || [ ! -f "$REPO/lib/client.js" ]; then
  dsh_compile
else
  echo "==> 复用现有 lib/（--no-build 且 index.js + client.js 都在）"
fi

# ── 2. 打包 + 门禁 ─────────────────────────────────────────────────────
dsh_package

# ── 3. 可选：把桌面 profile 切到 link / tar 模式 ──────────────────────
#
# dsh plugin 是 pnpm 转发器，两种模式就是 pnpm 语义：
#   link: `add <目录>`      → dependencies 记 "link:<abs>"，node_modules 里
#                             是符号链接；改 dist/installable/ 里的文件 +
#                             重启 App 即生效，无需重装
#   tar:  `add file:<tgz>`  → dependencies 记 "file:<abs>"，解包成冻结副本
dsh_resolve_dsh() {
  if [ -n "${DSH_BIN:-}" ]; then printf '%s' "$DSH_BIN"; return 0; fi
  local cand
  cand="$(command -v dsh 2>/dev/null || true)"
  [ -n "$cand" ] && { printf '%s' "$cand"; return 0; }
  cand="$(command -v dsh.cmd 2>/dev/null || true)"
  [ -n "$cand" ] && { printf '%s' "$cand"; return 0; }
  local local_appdata="${LOCALAPPDATA:-}"
  local_appdata="${local_appdata//\\//}"
  cand="$local_appdata/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd"
  [ -f "$cand" ] && { printf '%s' "$cand"; return 0; }
  cand="$HOME/.npm-global/bin/dsh"
  [ -x "$cand" ] && { printf '%s' "$cand"; return 0; }
  return 1
}

if [ -n "$INSTALL_DESKTOP" ]; then
  DSH="$(dsh_resolve_dsh)" || {
    dsh_err "找不到 dsh CLI。设置 DSH_BIN=/path/to/dsh.cmd"
    dsh_err '       （Windows Git Bash：DSH_BIN="$LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"）'
    exit 1
  }
  dsh_load_paths
  # §E: the spec PREFIX decides how the plugin manager reads the argument
  # (docs/load-into-local-dsh.md §8.5):
  #   link:<dir>  → directory mount, symlinked into node_modules
  #   file:<tgz>  → tarball, unpacked into a frozen copy
  # Without a prefix the manager treats the argument as a directory even
  # when it is a .tar.gz — it would mount the tarball FILE as if it were
  # a package directory.
  if [ "$INSTALL_DESKTOP" = "link" ]; then
    SPEC="link:$INSTALLABLE_DIR"
  else
    SPEC="file:$TARBALL"
  fi
  if dsh_app_running; then
    echo "  note: 桌面 App 正在运行——改 profile 一般安全，装完重启 App 生效；"
    echo "        想要零风险（尤其 tar 模式解包换副本），先退 App 再跑本脚本"
  fi
  dsh_log "install-desktop($INSTALL_DESKTOP, profile=$DESKTOP_PROFILE)"
  "$DSH" plugin --profile "$DESKTOP_PROFILE" add "$SPEC"
fi

dsh_summary

cat <<EOF

装进桌面版（路径必须是原生 Windows 形式 —— 下面已是）：
  1. 桌面 App 侧边栏 Plugins → Add plugin → Install a third-party plugin
  2. 本地目录通道（link，开发）：填
     $INSTALLABLE_DIR
     tarball 通道（tar，分发）：填
     $TARBALL
  3. 安装 → 启用 → 重启 DSH

命令行验证（另建 profile，不碰 desktop）：
  export DSH_BIN="\$LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
  export DSH_HOME=/tmp/dsh-edge-load
  "\$DSH_BIN" plugin --profile edge add "file:$TARBALL"
EOF
