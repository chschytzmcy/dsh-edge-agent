#!/usr/bin/env bash
# dsh-edge-agent 本地一键部署（编译 + 安装 + 同步 + 重启）。
#
# 单 profile 架构（§7.69, 2026-09-17）：一次只跑一个 profile —— 部署
# 目标前 install.sh 先停掉其他 profile 进程（避免端口冲突 + audit
# TOCTOU race）。HTTP 端口统一为 21017（http-api 默认；.env.sh 兜底）。
#   - dsh-edge : 项目自有 headless  (HTTP API :21017, 无 UI, §7.61)
#   - web      : 浏览器宿主          (UI :3080 + http-api :21017)
#   - dsh-tui  : 终端宿主            (http-api :21017)
# 任何自定义 profile 也可以走 --profile=<name>（profile-agnostic bundle）。
#
# §7.71 (2026-09-17) 部署流水线整合：install.sh 内部调用 `make package`
# 完成 build + tarball(lib/ 在 REPO_ROOT 给本地 install 用,*.tar.gz 在
# dist/ 给 release 分发用,§7.77),然后直 rsync REPO_ROOT/lib/ 到目标 profile
# node_modules。Makefile 不再管 install —— `make install` 已删(§7.71)。
#
# 前置：
#   - make 已安装（POSIX make；install.sh Phase 1 内部 'make package'）
#   - dsh CLI 已安装（npm install -g @deepseek-ai/dsh）
#   - pnpm 已安装（npm install -g pnpm 或 corepack enable pnpm）
#
# 用法：
#   ./install.sh                              # 默认：停 dsh-tui + web，部署 + 启 dsh-edge
#   ./install.sh --profile=web                # 切到 web：停 dsh-tui + dsh-edge，部署 + 启 web
#   ./install.sh --profile=tui                # 切到 dsh-tui：停 web + dsh-edge，部署 + 启 dsh-tui
#   ./install.sh --profile=dsh-edge           # 显式（与默认等价）
#   ./install.sh --no-restart                 # 只同步不启（开发改代码反复迭代时,避免重启打搅）
#   ./install.sh --skip-pnpm                  # 跳过 npm install（假设已装过）
#   ./install.sh --force-install              # 强制重装本包（覆盖 rsync）
#   ./install.sh --check [--profile=<name>]   # 探测 dsh CLI + bundle + REPO source 版本 + npm latest
#                                            #   不做改动;exit 0=in sync,1=需更新/缺装
#   ./install.sh -h | --help                  # 打印本帮助
#
# §7.74 部署语义双分支(tarball 模式也适用):
#   - profile=dsh-edge:从 tarball 自带 profiles/dsh-edge/(package.json skeleton
#     + cordis.patch.yml skin)做完整部署 —— §2.7 bootstrap skeleton + §2.5 sync
#     skin + §2.6 rsync lib/ + bundle-level patch overlay;本项目自有 headless
#     profile,适合"装一个能用的完整 dsh-edge daemon"场景。
#   - profile=web|dsh-tui:tarball 没有 profiles/web/ 或 profiles/tui/(这两个
#     不是本项目自有 profile,而是 DSH 平台默认宿主)—— install.sh 自动 fallback
#     到"仅部署 bundle":§2.7 只注册 bundle 到已有 profile 的 package.json
#     (bundles + dependencies),§2.5 不动(无 skin overlay);适合"我已有 web/
#     tui 在跑,只把 dsh-edge-agent bundle 挂上去"的场景。
# 两种部署都从 $REPO_ROOT/lib/ rsync 到 ~/.dsh/profiles/<name>/node_modules/
# @deepseek-harness-edge-agent/dsh-edge-agent/lib/。

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

DO_RESTART=1  # §7.65 默认重启:同步+启/重启 target profile(开发迭代场景);--no-restart opt-out
DO_PNPM=1
FORCE_INSTALL=0
DO_CHECK=0     # §7.78 --check:只探测版本,不改任何东西;默认 0(部署模式)
# §7.69 单 profile 架构:CLI 收敛到 --profile=<name>(单数),默认 dsh-edge
PROFILE=""

print_help() {
  sed -n '2,30p' "$0"
}

# 别名规范化：把 user-friendly 短名(tui/edge)映射到 DSH profile 真名
# (dsh-tui/dsh-edge)。
canonical_profile() {
  case "$1" in
    tui|dsh-tui)   echo "dsh-tui" ;;
    web)           echo "web" ;;
    edge|dsh-edge) echo "dsh-edge" ;;
    *)             echo "$1" ;;
  esac
}

# ── --check (§7.78) ───────────────────────────
# 探测 dsh CLI + 指定 profile bundle + REPO source 版本,best-effort 拿
# npm registry latest,不做任何改动。
# 退出码:
#   0 = deployed = REPO source(in sync, 无需动作)
#   1 = deployed ≠ REPO source / 未装 / dsh CLI 缺失(需 ./install.sh 重部署)
#   npm 拿不到 / node 不可用等 —— 内部 tool error,不参与 rc 累积
check_versions() {
  local prof="$PROFILE"
  local prof_dir="$DSH_HOME/profiles/$prof"
  local nested_pkg_json="$prof_dir/node_modules/@deepseek-harness-edge-agent/dsh-edge-agent/package.json"
  local repo_pkg_json="$REPO_ROOT/package.json"
  local rc=0

  # 从 JSON 取 version 字段 —— 优先 node(精准),fallback grep+sed
  read_json_version() {
    local f="$1"
    if [ ! -f "$f" ]; then echo "(file not found)"; return; fi
    if command -v node >/dev/null 2>&1; then
      node -e "try { console.log(require('$f').version || '(no version)') } catch(e) { console.log('(parse error: '+e.message+')') }" 2>/dev/null || echo "(node parse failed)"
    else
      grep -m1 '"version"' "$f" 2>/dev/null | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/' || echo "(grep failed)"
    fi
  }

  echo "==> [check] dsh CLI"
  local dsh_local
  if command -v dsh >/dev/null 2>&1; then
    dsh_local=$(dsh --version 2>&1 | head -1 | sed -E 's/^[Vv]//; s/[[:space:]].*$//')
    [ -z "$dsh_local" ] && dsh_local="(parse error)"
    echo "  local:      $dsh_local  (\`dsh --version\`)"
  else
    dsh_local="(not installed)"
    echo "  local:      $dsh_local  ✗ run: npm install -g @deepseek-ai/dsh"
    rc=1
  fi
  if command -v npm >/dev/null 2>&1; then
    local dsh_remote
    # `npm view 404` 在 set -e 下会 exit;用 || true 包住,且 timeout 防
    # 网络卡死(registry 偶尔会 hang)。
    dsh_remote=$(timeout 5 npm view @deepseek-ai/dsh version 2>/dev/null) || true
    if [ -n "$dsh_remote" ]; then
      echo "  npm latest: $dsh_remote  (registry.npmjs.org)"
      if [ "$dsh_local" != "(not installed)" ] && [ "$dsh_local" != "$dsh_remote" ]; then
        echo "  status:     ⚠ outdated → npm i -g @deepseek-ai/dsh@latest"
      fi
    else
      echo "  npm latest: (network unavailable / 5s timeout)"
    fi
  else
    echo "  npm latest: (npm not installed)"
  fi
  echo ""

  echo "==> [check] profile '$prof' bundle"
  local bundle_local
  bundle_local=$(read_json_version "$nested_pkg_json")
  if [ "$bundle_local" = "(file not found)" ]; then
    echo "  deployed:   (not installed at $prof_dir)"
    rc=1
  else
    echo "  deployed:   $bundle_local  ($nested_pkg_json)"
  fi
  local repo_version
  repo_version=$(read_json_version "$repo_pkg_json")
  echo "  REPO src:   $repo_version  ($repo_pkg_json)"
  if command -v npm >/dev/null 2>&1; then
    local bundle_remote
    bundle_remote=$(timeout 5 npm view @deepseek-harness-edge-agent/dsh-edge-agent version 2>/dev/null) || true
    if [ -n "$bundle_remote" ]; then
      echo "  npm latest: $bundle_remote"
    else
      echo "  npm latest: (404 / not published / network 5s timeout)"
    fi
  fi
  echo ""

  echo "==> [check] summary"
  if [ "$bundle_local" = "(file not found)" ]; then
    echo "  ✗ profile '$prof' 未装 bundle → ./install.sh --profile=$prof"
  elif [ "$repo_version" != "(file not found)" ] && [ "$bundle_local" != "$repo_version" ]; then
    echo "  ⚠ deployed ($bundle_local) ≠ REPO src ($repo_version) → ./install.sh --profile=$prof"
    rc=1
  else
    echo "  ✓ deployed ($bundle_local) = REPO src ($repo_version)"
  fi
  return $rc
}

for arg in "$@"; do
  case "$arg" in
    --profile=*)      PROFILE="$(canonical_profile "${arg#*=}")" ;;
    --profile)        shift; PROFILE="$(canonical_profile "${1:-}")" ;;
    --no-restart)     DO_RESTART=0 ;;
    --skip-pnpm)      DO_PNPM=0 ;;
    --force-install)  FORCE_INSTALL=1 ;;
    --check)          DO_CHECK=1 ;;
    -h|--help)        print_help; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

# §7.69 默认 dsh-edge —— 项目自有 headless,HTTP-only,无 UI 干扰
if [ -z "$PROFILE" ]; then
  PROFILE="dsh-edge"
fi

# ── --check 短路 (§7.78) ───────────────────────────
# 只探测版本,不改任何东西;exit 0 = in sync,1 = 需更新/缺装。
# 注意:放在 dsh CLI 存在性检查之前 —— --check 应该能报告 "dsh 未装"
# 而不是直接 fail。
if [ "$DO_CHECK" = 1 ]; then
  check_versions
  exit $?
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

# §7.72 检测上下文(repo 模式 vs tarball 模式):
# - 有 tsconfig.json → repo 模式,Phase 1 内部 'make package' 重 build
# - 无 tsconfig.json → tarball 模式,Phase 1 直接用预编译 lib/(无需 make)
# 两种模式都从 $REPO_ROOT/lib/ 读部署源;后续 Phase 2-4 不变。
REPO_MODE=0
if [ -f "$REPO_ROOT/tsconfig.json" ]; then
  REPO_MODE=1
  if ! command -v make >/dev/null 2>&1; then
    echo "未检测到 make,repo 模式 install.sh 内部调 'make package',请先安装：" >&2
    echo "  apt install make       # Debian/Ubuntu" >&2
    echo "  dnf install make       # Fedora/RHEL" >&2
    exit 1
  fi
fi

# ── Phase 1: 准备部署源(REPO_ROOT/lib/)──────────────────────────
# §7.72 (2026-09-17): 单 install.sh 双模式:
#   - repo 模式(有 tsconfig.json):内部 'make package' —— 重 build + 出 tarball
#     给 release 分发用。
#   - tarball 模式(无 tsconfig.json,解开 release tarball 跑):直接用预编译
#     lib/(无需 make,无需 tsconfig),把包里的内容部署到本地 DSH profile。
# 两种模式都从 $REPO_ROOT/lib/ 读;Phase 2-4 共享同一份部署逻辑。
if [ "$REPO_MODE" = 1 ]; then
  echo "==> [1/4] repo mode: make package (build + tarball)"
  cd "$REPO_ROOT"
  # §7.81 (2026-09-18): repo 模式 Phase 1 加 timeout + fallback
  # 根因: pnpm 11.7 lockfile sync hang (PROGRESS §7.80), `make package`
  # 卡 pnpm install 时 set -e 触发 SIGUSR1 (exit 144), 即使 deploy + 启
  # dsh-edge 都成功。修法: timeout 120s 包 make package, 失败时 fallback
  # 用现有 lib/ (加 stale warning, 不 abort install.sh)。install.sh 的
  # exit code 反映 deploy 是否成功, 不反映 make package 是否成功。
  if [ -d "$REPO_ROOT/lib" ]; then
    _LIB_BEFORE_MTIME=$(stat -c %Y "$REPO_ROOT/lib" 2>/dev/null || echo 0)
  else
    _LIB_BEFORE_MTIME=0
  fi
  if timeout 120 make package 2>&1 | tail -30; then
    echo "  ✓ make package ok (lib/ 重 build + dist/ tarball)"
  else
    _PHASE1_RC=$?
    echo "  ⚠ make package 失败 (exit $_PHASE1_RC), §7.81 fallback 用现有 lib/" >&2
    if [ ! -d "$REPO_ROOT/lib" ] || [ ! -f "$REPO_ROOT/lib/types/index.js" ]; then
      echo "  ✗ lib/ 不存在或残缺, 无法 fallback; 建议手动 'make package' 排查" >&2
      exit 1
    fi
    _LIB_AFTER_MTIME=$(stat -c %Y "$REPO_ROOT/lib" 2>/dev/null || echo 0)
    if [ "$_LIB_AFTER_MTIME" -lt "$_LIB_BEFORE_MTIME" ]; then
      echo "  ⚠ lib/ 似乎被破坏 (mtime 倒退), fallback 风险高" >&2
    fi
    echo "  → 继续 Phase 2-4 用现有 lib/ (可能 stale); exit 0 让 deploy 跑通" >&2
  fi
else
  echo "==> [1/4] tarball mode: using pre-built lib/ (no tsconfig.json, no make needed)"
  if [ ! -d "$REPO_ROOT/lib" ]; then
    echo "error: tarball 缺 lib/ —— 解包不完整或 release 流程坏了。" >&2
    exit 1
  fi
fi

# ── Phase 2: 同步到 target profile ─────────────────────────────────
# §7.69 单 profile 架构 —— 一次只部署 + 重启一个 profile(target)。
# 每个 profile 独立走 §2-§3.7 全套（plugin add 上游包 + rsync + 嵌套
# pkg bootstrap）。编译已经做一次，重复执行 plugin add 是幂等的。
PROFILES=("$PROFILE")
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

# ── Phase 3: 启动 target profile（单 profile 架构 §7.69）───────────
# §7.69: 一次只跑一个 profile —— 部署前先杀掉其他 profile 的 dsh 进程,
# 避免端口冲突(都吃 :21017)+ audit TOCTOU race。target profile 本身
# 也要重启(确保拿新代码)。
#
# §7.65: DO_RESTART=1 时启;--no-restart opt-out,跳过整个 Phase 3。
if [ "$DO_RESTART" = 0 ]; then
  echo "==> [3/4] 不启动(--no-restart opt-out;去掉 --no-restart 重跑即启)"
  echo "    已同步 profile: $PROFILE"
  echo "    手动启动: cd \$DSH_HOME/profiles/$PROFILE && source .env.sh && dsh --profile $PROFILE"
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
echo "==> [3/4] restart DSH (profile: $PROFILE)"

# §7.69 单 profile 架构 — 杀掉其他 profile 的 dsh 进程。
# 所有 profile 都吃 :21017,并发跑两个会 EADDRINUSE + 触发 §7.68 audit
# TOCTOU race;切 profile 前必杀旧的。target profile 自己下面也重启拿新代码。
OTHER_PROFILES=()
for _p in dsh-tui web dsh-edge; do
  [ "$_p" != "$PROFILE" ] && OTHER_PROFILES+=("$_p")
done

_killed_any=0
for OTHER in "${OTHER_PROFILES[@]}"; do
  pids=$(ps -eo pid,cmd 2>/dev/null | awk '/node.*dsh --profile '"$OTHER"'/{print $1}') || true
  pids=$(echo "$pids" | tr -s '[:space:]' ' ' | sed 's/^ *//;s/ *$//')
  if [ -n "$pids" ]; then
    echo "      killing other profile: $OTHER (PIDs: $pids)"
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    _killed_any=1
  fi
done

if [ "$_killed_any" = 1 ]; then
  echo "      waiting for other profiles to exit ..."
  for _ in 1 2 3 4 5; do
    sleep 1
    _any_left=0
    for OTHER in "${OTHER_PROFILES[@]}"; do
      if ps -eo pid,cmd 2>/dev/null | grep -q "node.*dsh --profile $OTHER"; then
        _any_left=1
        break
      fi
    done
    [ "$_any_left" = 0 ] && break
  done
fi

# §7.69 — kill target profile 的旧进程（拿新代码）
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
LOG="${DSH_EDGE_LOG:-$DSH_HOME/profiles/$PROFILE/run.log}"
pids=$(ps -eo pid,cmd 2>/dev/null | awk '/node.*dsh --profile '"$PROFILE"'/{print $1}') || true
pids=$(echo "$pids" | tr -s '[:space:]' ' ' | sed 's/^ *//;s/ *$//')
if [ -n "$pids" ]; then
  echo "      killing $PROFILE (PIDs: $pids)"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
fi
for _ in 1 2 3 4 5; do
  sleep 1
  ps -eo pid,cmd 2>/dev/null | grep -q "node.*dsh --profile $PROFILE" || break
done

# §7.43: 等待端口真正空闲。TIME_WAIT 会把 TCP 端口挂 ~60s,必须探测端口
# 而非只看进程退出,否则会 EADDRINUSE。§7.69 端口统一 :21017。
echo "      waiting for port 21017 to be free ..."
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if port_is_free 21017; then
    echo "      port 21017 is free"
    break
  fi
  sleep 1
done

mkdir -p "$(dirname "$LOG")"

# §7.69 — 端口统一 :21017,不再 inline force。source chain 自兜底:
#   profile-local .env.sh(若有) → repo .env.sh → bundle patch 默认(21017)。
PROFILE_ENV_SH="$PROFILE_DIR/.env.sh"
if [ -f "$PROFILE_ENV_SH" ]; then
  _LAUNCH_ENV="source '$PROFILE_ENV_SH' 2>/dev/null || true"
else
  _LAUNCH_ENV="source '$REPO_ROOT/.env.sh' 2>/dev/null || true"
fi
echo "      DSH_EDGE_HTTP_PORT=\${DSH_EDGE_HTTP_PORT:-21017} (profile=$PROFILE, source chain 兜底)"

# 启动（后台,detach）。nohup + disown 双保险,让进程不被 shell 退出
# 时的 SIGHUP 杀掉。
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
  START_OK=1
  echo "      ✓ $PROFILE up"
else
  START_OK=0
  echo "      ✗ $PROFILE did not stay up. tail of $LOG:" >&2
  tail -n 15 "$LOG" >&2 || true
fi

# ── Phase 4: 汇总报告 ───────────────────────────────────────────
echo
echo "==> [4/4] deploy summary"

if [ "$START_OK" = 1 ]; then
  echo "  ✓ $PROFILE :21017"
else
  echo "  ✗ $PROFILE FAILED — see $DSH_HOME/profiles/$PROFILE/run.log"
  echo
  echo "deploy FAILED. 排查: tail -f \$DSH_HOME/profiles/$PROFILE/run.log"
  exit 1
fi

echo
echo "deploy OK: $PROFILE"
echo "  访问入口:"
case "$PROFILE" in
  web)      echo "    web:    http://127.0.0.1:21017/  (web UI at :3080 if dsh-web-app installed)" ;;
  dsh-tui)  echo "    dsh-tui: 终端已在运行;HTTP API http://127.0.0.1:21017/v1/chat" ;;
  dsh-edge) echo "    dsh-edge: HTTP API http://127.0.0.1:21017/v1/chat (GET /v1/health; 无 UI)" ;;
  *)        echo "    $PROFILE: http://127.0.0.1:21017/" ;;
esac
