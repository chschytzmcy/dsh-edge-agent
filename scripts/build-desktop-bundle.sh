#!/usr/bin/env bash
# build-desktop-bundle.sh — 构建桌面版两种产物（三平台：macOS / Windows Git Bash / Linux），
# 并可选直接把桌面 profile 切到对应模式。
#
#   tar 模式（分发）   dist/dsh-edge-agent-desktop-safe.tar.gz        profile 记 file:，安装时解包成冻结副本
#   link 模式（开发）  dist/installable/dsh-edge-agent-desktop-safe/  profile 记 link:，改文件重启 App 即生效
#
# 为什么用打包产物而不是直接指源码目录：
#   源码 package.json 带 `prepare`（编译 TypeScript）。桌面 App 的执行环境里
#   不一定有 npm（只有 app 自带的 node/pnpm），直接装源码目录会让安装卡在
#   prepare 脚本。两种产物都预置 lib/ 且删掉 scripts/devDependencies，安装即用。
#
# 每次运行全量重建两种产物 + 门禁校验（tar 和 link 永远同源）：
#   1. pnpm run compile                      tsc → lib/
#   2. node scripts/build-client.mjs         esbuild → lib/client.js（Edge tab 客户端 bundle；
#                                            compile 不产它——漏了这步 tarball 照样能打出来，
#                                            但装上后 Edge tab 静默不出现，2026-10-24 实测）
#   3. node scripts/rebuild-installable.mjs  → dist/installable/<variant>/（原子换入保 link: 不断；
#                                            Windows 撞活句柄锁自动降级就地同步）
#   4. node scripts/verify-installable.mjs   门禁：manifest 引用的文件必须都在盘上
#   5. tarball 打包（bsdtar / GNU tar 自动识别 + sha256）
#   6. node scripts/verify-tarball.mjs       门禁：tarball 本体（verify-installable 不管它，
#                                            §7.157：门禁没接线 == 没有门禁）
#
# 用法：
#   bash scripts/build-desktop-bundle.sh                          # 全量构建两种产物
#   bash scripts/build-desktop-bundle.sh --no-build               # 复用现有 lib/，不重编译
#   bash scripts/build-desktop-bundle.sh --install-desktop=link   # 构建后把桌面 profile 切到 link:（开发模式）
#   bash scripts/build-desktop-bundle.sh --install-desktop=tar    # 构建后切回 file: tarball（分发模式）
#   bash scripts/build-desktop-bundle.sh --desktop-profile=name   # 安装目标 profile（默认 desktop）
#
# 平台差异（脚本自动处理，无需前置安装）：
#   macOS    /usr/bin/tar 是 bsdtar → 自动去掉 --no-xattrs（不必再装 gnu-tar）；
#            dsh 用 App 内嵌 CLI；sha256 用 shasum
#   Windows  Git Bash：自带 GNU tar（--no-xattrs 可用）+ shasum；make/rsync 不可用但
#            本脚本不依赖；dsh 用 App 内嵌 dsh.cmd
#            （%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd）
#   Linux    GNU tar；sha256 用 shasum 或 sha256sum；dsh 走 PATH 或 ~/.npm-global/bin
#
# 找不到 dsh / node / pnpm 时分别用 DSH_BIN / NODE_BIN / PNPM 覆盖（Windows 的
# DSH_BIN 指向 dsh.cmd）。App 运行中切模式一般安全，脚本会检测并提示；想零风险
# 先退 App。--emit-dir 仍被接受（历史用法，现为 no-op）：installable 目录每次都重建。

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$REPO/dist"
DO_BUILD=1
EMIT_DIR=0
INSTALL_DESKTOP=""
DESKTOP_PROFILE="desktop"
for arg in "$@"; do
  case "$arg" in
    --no-build) DO_BUILD=0 ;;
    --emit-dir) EMIT_DIR=1 ;;
    --install-desktop=link|--install-desktop=tar) INSTALL_DESKTOP="${arg#*=}" ;;
    --install-desktop) INSTALL_DESKTOP="link" ;;
    --desktop-profile=*) DESKTOP_PROFILE="${arg#*=}" ;;
    -h|--help)
      sed -n '2,40p' "$0"
      exit 0
      ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# ── 0. 定位 node / pnpm（桌面版环境里常常都不在 PATH；三平台候选链）────
#
# 2026-10-26 fix: PNPM 之前是一个**字符串**（"$NODE_BIN $cand"），调用处
# 用未加引号的 `$PNPM run compile` 展开 —— bash 按空格切词，于是 Windows
# 上 "/c/Program Files/nodejs/node" 被切成 "/c/Program" + "Files/…"，脚本
# 去执行 "/c/Program" → "No such file or directory"。macOS/Linux 路径通常
# 无空格，所以一直没暴露。
#
# 现在 PNPM_CMD 是一个 bash **数组**：调用处 "${PNPM_CMD[@]}" 传参，argv
# 按元素传递，不依赖单词分割。
#
# 数组 + `set -u` 的坑：bash 3.2（macOS 的 /bin/bash 至今还是 3.2）在
# 展开空数组时报 "unbound variable"。所以数组的判空一律用 ${#arr[@]}（3.2
# 安全），实际调用统一走 pnpm_run()。
PNPM_CMD=()

# Git Bash 把 LOCALAPPDATA 导成 Windows 风格（"C:\Users\<user>\AppData\Local"），
# 直接拼 "/Programs/…" 会得到混合分隔符路径 —— 有些工具处理不好。统一
# 转成正斜杠。
if [ -n "${LOCALAPPDATA:-}" ]; then
  LOCALAPPDATA="${LOCALAPPDATA//\\//}"
fi

NODE_BIN="${NODE_BIN:-}"
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node 2>/dev/null || true)"
fi
if [ -z "$NODE_BIN" ]; then
  for cand in \
    "$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node" \
    "$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe" \
    "${LOCALAPPDATA:-}/Programs/DeepSeek Harness/resources/runtime/bin/node.exe" \
    "${LOCALAPPDATA:-}/Programs/DeepSeek Harness/resources/runtime/primary-runtime/dependencies/node/bin/node.exe" \
    "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/bin/node"; do
    [ -n "$cand" ] && [ -x "$cand" ] && NODE_BIN="$cand" && break
  done
fi
[ -n "$NODE_BIN" ] || { echo "error: 找不到 node。设置 NODE_BIN=/path/to/node" >&2; exit 1; }

if [ -n "${PNPM:-}" ]; then
  # 用户显式覆盖：PNPM 必须是**可执行文件的路径**（可以含空格，因为环境
  # 变量值本身是一个整体）。旧的 "node script.mjs" 双词形式不再支持 ——
  # 它正是切词 bug 的来源。
  if [ -x "$PNPM" ]; then
    PNPM_CMD=("$PNPM")
  else
    echo "error: PNPM 覆盖值不是可执行文件：$PNPM" >&2
    exit 1
  fi
elif command -v pnpm >/dev/null 2>&1; then
  PNPM_CMD=("$(command -v pnpm)")
else
  for cand in \
    "$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs" \
    "${LOCALAPPDATA:-}/Programs/DeepSeek Harness/resources/runtime/dependencies/pnpm/bin/pnpm.mjs" \
    "${LOCALAPPDATA:-}/Programs/DeepSeek Harness/resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs" \
    "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs"; do
    if [ -n "$cand" ] && [ -f "$cand" ]; then
      PNPM_CMD=("$NODE_BIN" "$cand")
      break
    fi
  done
fi

# 用数组调用 pnpm。${#PNPM_CMD[@]} 在 bash 3.2 下对空数组也安全（返回 0），
# 而 "${PNPM_CMD[@]}" 在空数组 + set -u 下会炸 —— 所以判空和调用都在这里。
pnpm_run() {
  if [ "${#PNPM_CMD[@]}" -eq 0 ]; then
    echo "error: 没有可用的 pnpm。设置 PNPM=/path/to/pnpm" >&2
    return 1
  fi
  "${PNPM_CMD[@]}" "$@"
}

echo "==> node:  $NODE_BIN ($("$NODE_BIN" -v))"
echo "==> pnpm:  ${PNPM_CMD[*]:-<none>}"

# ── 0.5 三平台工具探测：tar 口味 / sha256 / 桌面 App 是否在运行 ─────────
# macOS 自带 bsdtar 不认 GNU 的 --no-xattrs（libarchive 默认就不写 xattr，
# COPYFILE_DISABLE=1 防 AppleDouble 即可）；Git Bash / Linux 的 GNU tar 要它。
TAR_NOXATTRS="--no-xattrs"
if tar --version 2>/dev/null | grep -qi bsdtar; then
  TAR_NOXATTRS=""
fi

sha256_file() {
  # $1 = 文件；校验文件写在旁边（<file>.sha256）
  if command -v shasum >/dev/null 2>&1; then
    ( cd "$(dirname "$1")" && shasum -a 256 "$(basename "$1")" > "$(basename "$1").sha256" )
  else
    ( cd "$(dirname "$1")" && sha256sum "$(basename "$1")" > "$(basename "$1").sha256" )
  fi
}

app_running() {
  # 尽力而为的探测，任何一步拿不到工具都按"没在运行"处理（绝不因此失败）
  if command -v pgrep >/dev/null 2>&1; then
    pgrep -f 'DeepSeek Harness.app/Contents/MacOS' >/dev/null 2>&1 && return 0
    pgrep -f 'DeepSeek Harness.exe' >/dev/null 2>&1 && return 0
    return 1
  fi
  if command -v tasklist >/dev/null 2>&1; then
    tasklist 2>/dev/null | grep -i 'DeepSeek Harness' >/dev/null && return 0
    return 1
  fi
  return 1
}

# ── 1. 确保编译产物成套（lib/ = tsc 输出 + esbuild client bundle 两件都齐）──
if [ "$DO_BUILD" = 1 ] || [ ! -f "$REPO/lib/index.js" ] || [ ! -f "$REPO/lib/client.js" ]; then
  if [ "${#PNPM_CMD[@]}" -eq 0 ]; then
    echo "error: 需要编译但没有可用的 pnpm。设置 PNPM 或先手工 compile 后用 --no-build" >&2
    exit 1
  fi
  echo "==> compile (pnpm run compile + build:client)"
  # dirname 出来的路径可能含空格（"C:\Program Files\nodejs"）—— 整串作为一个
  # PATH 元素，冒号分隔，Windows 上分号是分隔符但 Git Bash 的 PATH 沿用
  # 冒号语义，这里保持与既有脚本一致。
  ( cd "$REPO" && export PATH="$(dirname "$NODE_BIN"):$PATH" && pnpm_run run compile )
  "$NODE_BIN" "$REPO/scripts/build-client.mjs"
else
  echo "==> 复用现有 lib/（--no-build 且 index.js + client.js 都在）"
fi
[ -f "$REPO/lib/index.js" ] || { echo "error: lib/index.js 不存在" >&2; exit 1; }
[ -f "$REPO/lib/client.js" ] || { echo "error: lib/client.js 不存在（Edge tab 客户端 bundle，compile 不产它）——跑 node scripts/build-client.mjs" >&2; exit 1; }

# ── 2. installable 目录（link 模式产物）+ 门禁：两种产物同源 ────────
"$NODE_BIN" "$REPO/scripts/rebuild-installable.mjs"
"$NODE_BIN" "$REPO/scripts/verify-installable.mjs"

# ── 3. 打包 tarball（tar 模式产物）──────────────────────────────────
mkdir -p "$DIST"
STAGE_ROOT="$(mktemp -d)"
trap 'rm -rf "$STAGE_ROOT"' EXIT

"$NODE_BIN" - "$REPO" "$STAGE_ROOT" <<'NODEEOF'
const fs = require('node:fs')
const path = require('node:path')

const repo = process.argv[2]
const stageRoot = process.argv[3]
const base = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'))

// §7.153: the variant table + the `dsh.bundle.patch` declaration come from
// the shared module (require() of an ESM module — Node ≥22.12). This block
// used to write the STRING form, which silently drops the Agent Preset layer
// ⇒ the 边缘模式 work mode was never registered in the desktop.
const { BUNDLE_VARIANTS, bundlePatchDeclaration } = require(path.join(repo, 'scripts', '_bundle-variants.mjs'))

const variants = BUNDLE_VARIANTS.map((v) => ({
  name: v.dir,
  version: `${base.version}${v.versionSuffix}`,
  description: v.description,
  patch: bundlePatchDeclaration(v),
}))

const copyTree = (src, dest) => {
  fs.cpSync(src, dest, { recursive: true })
}

for (const v of variants) {
  const dir = path.join(stageRoot, v.name)
  fs.mkdirSync(dir, { recursive: true })

  const pkg = { ...base }
  pkg.version = v.version
  pkg.description = v.description
  // 安装时不跑 prepare/compile：产物已经在包里
  delete pkg.scripts
  delete pkg.devDependencies
  // `config` ships with the bundle (minus the operator's secret
  // config/edge.json — see below), so the runtime finds the shipped
  // config/edge.example.json as its last-resort configuration source
  // instead of falling back to the in-code defaults.
  pkg.files = ['lib', 'config', 'cordis.patch.yml', 'cordis.desktop-safe.patch.yml', 'cordis.yml', 'presets']
  pkg.dsh = { ...(pkg.dsh || {}), bundle: { ...(pkg.dsh.bundle || {}), patch: v.patch } }

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
  copyTree(path.join(repo, 'lib'), path.join(dir, 'lib'))
  copyTree(path.join(repo, 'presets'), path.join(dir, 'presets'))
  for (const f of ['cordis.yml', 'cordis.patch.yml', 'cordis.desktop-safe.patch.yml']) {
    fs.copyFileSync(path.join(repo, f), path.join(dir, f))
  }
  // config/ ships WITHOUT config/edge.json — that file holds the
  // operator's real endpoints and API keys in plaintext and must never
  // reach a distributable artifact. (The local installable directory does
  // keep it; see scripts/rebuild-installable.mjs.)
  const configSrc = path.join(repo, 'config')
  if (fs.existsSync(configSrc)) {
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true })
    for (const f of fs.readdirSync(configSrc)) {
      if (f === 'edge.json') continue
      fs.cpSync(path.join(configSrc, f), path.join(dir, 'config', f), { recursive: true })
    }
  }
  console.log(`staged ${v.name} -> ${v.patch.join(' + ')}`)
}
NODEEOF

for v in dsh-edge-agent-desktop-safe dsh-edge-agent-full; do
  OUT="$DIST/$v.tar.gz"
  # npm/pnpm 期望 tarball 顶层目录名是 `package`。
  # GNU tar 有 --transform 但 macOS/Linux 常见配置各异，统一显式改名后再打包
  #（bsdtar / GNU tar / Git Bash 自带 tar 都这么走）。
  mv "$STAGE_ROOT/$v" "$STAGE_ROOT/package"
  COPYFILE_DISABLE=1 tar $TAR_NOXATTRS -czf "$OUT" -C "$STAGE_ROOT" package
  mv "$STAGE_ROOT/package" "$STAGE_ROOT/$v"
  sha256_file "$OUT"
  echo "==> $OUT ($(du -h "$OUT" | cut -f1 | tr -d ' '))"
done

# ── 3.1 tarball 门禁（§7.157）─────────────────────────────────────────
#
# verify-installable 只走 dist/installable/，**不管 tarball**。上面这段又
# 是本脚本自己实现的打包（跟 _pack-core.mjs 是两份实现），所以产物必须
# 单独验一遍：顶层目录名、patch 列表形态、presets 层、engines.dsh、
# lib/index.js + lib/client.js、不含 config/edge.json、与 installable 目录
# 不陈旧。
"$NODE_BIN" "$REPO/scripts/verify-tarball.mjs"

# ── 4. --install-desktop：构建后直接把桌面 profile 切到 link / tar 模式 ──
#
# dsh plugin 是 pnpm 转发器（help 原文：forwarding the remaining arguments to
# pnpm in the profile directory），两种模式就是 pnpm 语义：
#   link: `add <目录>`      → dependencies 记 "link:<abs>"，node_modules 里是符号链接，
#                             之后改 dist/installable/ 里的文件 + 重启 App 即生效，无需重装
#   tar:  `add file:<tgz>`  → dependencies 记 "file:<abs>"，解包成冻结副本；
#                             add 会重新解析 spec（坑 1 只影响对同 path 跑 `pnpm install`）
resolve_dsh() {
  # 探测顺序：显式 DSH_BIN → PATH（dsh / dsh.cmd）→ macOS App 内嵌 →
  # Windows App 内嵌 dsh.cmd → npm-global；全部落空返回 1
  if [ -n "${DSH_BIN:-}" ]; then
    printf '%s' "$DSH_BIN"
    return 0
  fi
  local cand
  cand="$(command -v dsh 2>/dev/null || true)"
  [ -n "$cand" ] && { printf '%s' "$cand"; return 0; }
  cand="$(command -v dsh.cmd 2>/dev/null || true)"
  [ -n "$cand" ] && { printf '%s' "$cand"; return 0; }
  cand="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
  [ -x "$cand" ] && { printf '%s' "$cand"; return 0; }
  cand="${LOCALAPPDATA:-}/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd"
  [ -f "$cand" ] && { printf '%s' "$cand"; return 0; }
  cand="$HOME/.npm-global/bin/dsh"
  [ -x "$cand" ] && { printf '%s' "$cand"; return 0; }
  return 1
}

install_desktop() {
  local mode="$1" prof="$2" spec dsh_bin
  dsh_bin="$(resolve_dsh)" || {
    echo "error: 找不到 dsh CLI。设置 DSH_BIN=/path/to/dsh" >&2
    echo "       （Windows Git Bash：DSH_BIN=\"\$LOCALAPPDATA/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd\"）" >&2
    exit 1
  }
  if [ "$mode" = "link" ]; then
    spec="$DIST/installable/dsh-edge-agent-desktop-safe"
  else
    # file: 前缀与桌面 GUI / deploy-profile.sh 的记录一致（file:<abs>）
    spec="file:$DIST/dsh-edge-agent-desktop-safe.tar.gz"
  fi
  echo "==> dsh:    $dsh_bin"
  if app_running; then
    echo "  note: 桌面 App 正在运行——改 profile 一般安全，装完重启 App 生效；"
    echo "        想要零风险（尤其 tar 模式解包换副本），先退 App 再跑本脚本"
  fi
  echo "==> install-desktop($mode, profile=$prof): $dsh_bin plugin --profile $prof add $spec"
  "$dsh_bin" plugin --profile "$prof" add "$spec"
}

if [ -n "$INSTALL_DESKTOP" ]; then
  install_desktop "$INSTALL_DESKTOP" "$DESKTOP_PROFILE"
fi

cat <<EOF

产物（两种模式同源，均通过 verify-installable + verify-tarball 门禁）：
  tar（分发）  $DIST/dsh-edge-agent-desktop-safe.tar.gz (+ .sha256)
  link（开发） $DIST/installable/dsh-edge-agent-desktop-safe/
EOF

if [ -n "$INSTALL_DESKTOP" ]; then
  cat <<EOF

已把 profile "$DESKTOP_PROFILE" 切到 $INSTALL_DESKTOP 模式 —— 重启 DeepSeek Harness 生效。
link 模式迭代循环：改代码 → 重跑本脚本 → 重启 App（pnpm 不用再动）。
换模式：--install-desktop=tar（分发）或 --install-desktop=link（开发）。
EOF
else
  cat <<EOF

装进桌面版（或构建时直接加 --install-desktop=link|tar 自动装入）：
  1. 桌面 App 侧边栏 Plugins → Add plugin → Install a third-party plugin
  2. 本地目录通道（link，开发）：填 $DIST/installable/dsh-edge-agent-desktop-safe
     tarball 通道（tar，分发）：填 $DIST/dsh-edge-agent-desktop-safe.tar.gz
  3. 安装 → 启用 → 按提示重启 DSH

想用命令行验证（不碰桌面 profile，另建一个 profile）：
  export DSH_BIN="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"   # macOS
  # Windows Git Bash: export DSH_BIN="\$LOCALAPPDATA/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd"
  export DSH_HOME=/tmp/dsh-edge-load
  "\$DSH_BIN" plugin --profile edge add $DIST/dsh-edge-agent-desktop-safe.tar.gz
EOF
fi
