#!/usr/bin/env bash
# build-macos.sh — macOS 构建打包
#
# 支持矩阵：macOS **桌面版 + CLI profile** 都支持。
#
#   桌面版      DSH 桌面 App（Electron 独占 desktop profile）
#               → dist/installable/…（link 开发）或 …tar.gz（file 分发）
#
#   CLI profile dsh-tui / dsh-web / dsh-edge-agent（独立 HTTP profile）
#               → deploy-profile.sh 走 tarball 装进 ~/.dsh/profiles/<name>/
#
# 产物：
#   tar（分发）  dist/dsh-edge-agent-{desktop-safe,full}.tar.gz (+ .sha256)
#   link（开发）  dist/installable/dsh-edge-agent-{desktop-safe,full}/
#
# macOS 专属说明：
#   - /usr/bin/tar 是 bsdtar —— 不认 GNU 的 --no-xattrs（libarchive 默认就
#     不写 xattr，COPYFILE_DISABLE=1 防 AppleDouble 即可）
#   - sha256 用 shasum（无 sha256sum）
#   - dsh CLI 在 App 内：/Applications/DeepSeek Harness.app/Contents/
#     Resources/runtime/cli/bin/dsh
#
# 用法：
#   bash scripts/build-macos.sh                          # 全量构建
#   bash scripts/build-macos.sh --no-build               # 复用现有 lib/
#   bash scripts/build-macos.sh --install-desktop=link|tar
#   bash scripts/build-macos.sh --deploy-profile=dsh-edge-agent
#   bash scripts/build-macos.sh --deploy-profile=dsh-web --no-restart

set -euo pipefail

# shellcheck source=_platform-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/_platform-common.sh"

DO_BUILD=1
INSTALL_DESKTOP=""
DESKTOP_PROFILE="desktop"
DEPLOY_PROFILE=""
DEPLOY_RESTART=1

for arg in "$@"; do
  case "$arg" in
    --no-build) DO_BUILD=0 ;;
    --no-restart) DEPLOY_RESTART=0 ;;
    --install-desktop=link|--install-desktop=tar) INSTALL_DESKTOP="${arg#*=}" ;;
    --install-desktop) INSTALL_DESKTOP="link" ;;
    --desktop-profile=*) DESKTOP_PROFILE="${arg#*=}" ;;
    --deploy-profile=*) DEPLOY_PROFILE="${arg#*=}" ;;
    --emit-dir) : ;;  # 历史用法（no-op）
    -h|--help)
      sed -n '2,24p' "$0"
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

# ── 3. 可选：切桌面 profile 模式 ───────────────────────────────────────
dsh_resolve_dsh() {
  if [ -n "${DSH_BIN:-}" ]; then printf '%s' "$DSH_BIN"; return 0; fi
  local cand
  cand="$(command -v dsh 2>/dev/null || true)"
  [ -n "$cand" ] && { printf '%s' "$cand"; return 0; }
  cand="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
  [ -x "$cand" ] && { printf '%s' "$cand"; return 0; }
  cand="$HOME/.npm-global/bin/dsh"
  [ -x "$cand" ] && { printf '%s' "$cand"; return 0; }
  return 1
}

if [ -n "$INSTALL_DESKTOP" ]; then
  DSH="$(dsh_resolve_dsh)" || {
    dsh_err "找不到 dsh CLI。设置 DSH_BIN=/path/to/dsh"
    exit 1
  }
  dsh_load_paths
  # §E: the spec PREFIX decides how the plugin manager reads the argument
  # (docs/load-into-local-dsh.md §8.5): link:<dir> → directory mount,
  # file:<tgz> → tarball unpacked into a frozen copy.
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

# ── 4. 可选：部署 CLI profile（dsh-tui / dsh-web / dsh-edge-agent）──────
if [ -n "$DEPLOY_PROFILE" ]; then
  DEPLOY_ARGS=("$DEPLOY_PROFILE" "--no-build")
  [ "$DEPLOY_RESTART" = 0 ] && DEPLOY_ARGS+=("--no-restart")
  dsh_log "deploy-profile($DEPLOY_PROFILE)"
  DSH_EDGE_BIN="${DSH_EDGE_BIN:-$(dsh_resolve_dsh || true)}" \
    bash "$REPO/scripts/deploy-profile.sh" "${DEPLOY_ARGS[@]}"
fi

dsh_summary

cat <<EOF

桌面版安装：
  1. App 侧边栏 Plugins → Add plugin → Install a third-party plugin
  2. 本地目录（link，开发）：$INSTALLABLE_DIR
     tarball（tar，分发）：$TARBALL

CLI profile 部署（dsh-tui / dsh-web / dsh-edge-agent）：
  bash scripts/build-macos.sh --deploy-profile=dsh-edge-agent
  bash scripts/build-macos.sh --deploy-profile=dsh-web
EOF
