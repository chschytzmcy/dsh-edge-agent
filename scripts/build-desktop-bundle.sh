#!/usr/bin/env bash
# build-desktop-bundle.sh — 把本仓编译产物打成可安装的 bundle（tarball；--emit-dir 另落可安装目录），
# 用于在 DSH 桌面版 / 任意 profile 里通过 Plugins 页或 `dsh plugin add` 加载。
#
# 为什么用打包产物而不是直接指源码目录：
#   源码 package.json 带 `prepare`（编译 TypeScript）。桌面 App 的执行环境里
#   不一定有 npm（只有 app 自带的 node/pnpm），直接装源码目录会让安装卡在
#   prepare 脚本。产物（tarball / --emit-dir 目录）预置 lib/ 且删掉
#   scripts/devDependencies，安装即用。
#
# 产出（都落在 dist/，dist/ 已被 .gitignore 忽略）：
#   dsh-edge-agent-desktop-safe.tar.gz            推荐：只 insert 隐私栈，不改桌面全局配置
#   dsh-edge-agent-full.tar.gz                    全量：与独立 dsh-edge profile 行为一致
#   installable/dsh-edge-agent-desktop-safe/      （--emit-dir）桌面「本地目录」通道用
#   installable/dsh-edge-agent-full/              （--emit-dir）
#
# 用法：
#   bash scripts/build-desktop-bundle.sh               # 需要 lib/ 时自动编译
#   bash scripts/build-desktop-bundle.sh --no-build    # 用现有 lib/，不重编译
#   bash scripts/build-desktop-bundle.sh --emit-dir    # 额外产出 dist/installable/ 可安装目录

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$REPO/dist"
DO_BUILD=1
EMIT_DIR=0
for arg in "$@"; do
  case "$arg" in
    --no-build) DO_BUILD=0 ;;
    --emit-dir) EMIT_DIR=1 ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# ── 0. 定位 node / pnpm（桌面版环境里常常都不在 PATH）────────────────
NODE_BIN="${NODE_BIN:-}"
PNPM="${PNPM:-}"
if [ -z "$NODE_BIN" ]; then
  if command -v node >/dev/null 2>&1; then
    NODE_BIN="$(command -v node)"
  else
    for cand in \
      "$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node" \
      "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/bin/node"; do
      [ -x "$cand" ] && NODE_BIN="$cand" && break
    done
  fi
fi
[ -n "$NODE_BIN" ] || { echo "error: 找不到 node。设置 NODE_BIN=/path/to/node" >&2; exit 1; }

if [ -z "$PNPM" ]; then
  if command -v pnpm >/dev/null 2>&1; then
    PNPM="pnpm"
  else
    for cand in \
      "$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs" \
      "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs"; do
      [ -f "$cand" ] && PNPM="$NODE_BIN $cand" && break
    done
  fi
fi

echo "==> node:  $NODE_BIN ($("$NODE_BIN" -v))"
echo "==> pnpm:  ${PNPM:-<none>}"

# ── 1. 确保编译产物存在 ───────────────────────────────────────────
if [ "$DO_BUILD" = 1 ] || [ ! -f "$REPO/lib/index.js" ]; then
  if [ -z "$PNPM" ]; then
    echo "error: 需要编译但没有可用的 pnpm。设置 PNPM 或先手工 compile 后用 --no-build" >&2
    exit 1
  fi
  echo "==> compile (pnpm run compile)"
  ( cd "$REPO" && PATH="$(dirname "$NODE_BIN"):$PATH" $PNPM run compile )
else
  echo "==> 复用现有 lib/（--no-build 且 lib/index.js 存在）"
fi
[ -f "$REPO/lib/index.js" ] || { echo "error: lib/index.js 不存在" >&2; exit 1; }

# ── 2. 打包两个变体 ───────────────────────────────────────────────
mkdir -p "$DIST"
STAGE_ROOT="$(mktemp -d)"
trap 'rm -rf "$STAGE_ROOT"' EXIT

"$NODE_BIN" - "$REPO" "$STAGE_ROOT" <<'NODEEOF'
const fs = require('node:fs')
const path = require('node:path')

const repo = process.argv[2]
const stageRoot = process.argv[3]
const base = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'))

const variants = [
  {
    name: 'dsh-edge-agent-desktop-safe',
    version: `${base.version}-desktop-safe`,
    patch: './cordis.desktop-safe.patch.yml',
    description: 'dsh-edge-agent bundle — desktop-safe overlay (inserts the privacy stack, does NOT rewrite host defaults: model / persona / approval / sandbox / session root / http-api)',
  },
  {
    name: 'dsh-edge-agent-full',
    version: `${base.version}-full`,
    patch: './cordis.patch.yml',
    description: 'dsh-edge-agent bundle — full production patch (same behaviour as the standalone dsh-edge profile; rewrites host defaults)',
  },
]

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
  console.log(`staged ${v.name} -> ${v.patch}`)
}
NODEEOF

for v in dsh-edge-agent-desktop-safe dsh-edge-agent-full; do
  OUT="$DIST/$v.tar.gz"
  # npm/pnpm 期望 tarball 顶层目录名是 `package`。
  # macOS 是 bsdtar（没有 GNU --transform），所以显式改名后再打包。
  mv "$STAGE_ROOT/$v" "$STAGE_ROOT/package"
  COPYFILE_DISABLE=1 tar --no-xattrs -czf "$OUT" -C "$STAGE_ROOT" package
  mv "$STAGE_ROOT/package" "$STAGE_ROOT/$v"
  ( cd "$DIST" && shasum -a 256 "$v.tar.gz" > "$v.tar.gz.sha256" )
  echo "==> $OUT ($(du -h "$OUT" | cut -f1 | tr -d ' '))"
done

# ── 3. --emit-dir：落成「可安装目录」（桌面 Plugins 本地目录通道）──────────
#
# §7.107 (2026-10-23): this used to copy the tarball staging over
# dist/installable/<variant>/. The two artifacts are NOT the same thing —
# the installable directory also carries config/ (the operator's
# config/edge.json and the shipped templates), and the tarball deliberately
# does not. Copying the staging over the installable directory silently
# deleted config/ (and flipped the version to the tarball's), so a
# `pnpm run build` followed by `build-desktop-bundle.sh --emit-dir` undid
# the work of the previous step.
#
# scripts/rebuild-installable.mjs is the single source of truth for the
# installable directories — it stages, swaps and keeps the `link:` target
# continuously valid (§7.103). Call it instead of copying.
if [ "$EMIT_DIR" = 1 ]; then
  "$NODE_BIN" "$REPO/scripts/rebuild-installable.mjs"
  for v in dsh-edge-agent-desktop-safe dsh-edge-agent-full; do
    echo "==> $DIST/installable/$v"
  done
fi

if [ "$EMIT_DIR" = 1 ]; then
cat <<EOF

下一步 —— 装进当前桌面版（本地目录通道）：
  1. 打开 DSH 桌面版侧边栏 Plugins → Add plugin → Install a third-party plugin
  2. 选择「本地目录」，填入：
     $DIST/installable/dsh-edge-agent-desktop-safe
  3. 安装 → 启用 → 按提示重启 DSH
  （dist/installable/ 下的 package.json 已删 scripts/devDeps，不会触发构建链。）

想用命令行验证（不碰桌面 profile，另建一个 profile）：
  export DSH_BIN="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
  export DSH_HOME=/tmp/dsh-edge-load
  "\$DSH_BIN" plugin --profile edge add $DIST/dsh-edge-agent-desktop-safe.tar.gz
EOF
else
cat <<EOF

下一步 —— 装进当前桌面版：
  1. 打开 DSH 桌面版侧边栏 Plugins → Add plugin → Install a third-party plugin
  2. 填入绝对路径：
     $DIST/dsh-edge-agent-desktop-safe.tar.gz
     （若走「本地目录」通道，重跑本脚本加 --emit-dir，填
      $DIST/installable/dsh-edge-agent-desktop-safe）
  3. 安装 → 启用 → 按提示重启 DSH

想用命令行验证（不碰桌面 profile，另建一个 profile）：
  export DSH_BIN="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
  export DSH_HOME=/tmp/dsh-edge-load
  "\$DSH_BIN" plugin --profile edge add $DIST/dsh-edge-agent-desktop-safe.tar.gz
EOF
fi
