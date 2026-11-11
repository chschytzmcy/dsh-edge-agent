#!/usr/bin/env node
/**
 * publish-npm.mjs —— 本地一键发布到 npm registry（§7.172）
 *
 * ## 为什么要有本地这条路径
 *
 * CI 的 `publish.yml`（推 `v*` tag 触发）**早就建好了**，但它是「代码上去了之后
 * 才跑」的那条链 —— 主人说过：CI 红不拦 push。而 npm 这条链**从来没被走通过**
 * （本仓至今 0 个 tag、registry 上 404），所以第一次发布不该拿它当试验品。
 *
 * 本脚本给的是**发布前**的那扇门：
 *
 *   1. 先查 registry：这个版本发过没有？（发过 ⇒ 立刻停，不浪费一次构建）
 *   2. 跑**完整的 canonical 构建链**（与 CI 一字不差 —— `verify-ci-build-chain`
 *      门禁就管这件事）；
 *   3. **认证预检**（仅 `--yes`；离线读 `.npmrc` / 环境变量，找不到 token 就停）；
 *   4. 跑**全部 28 道门禁**（验的是**产物**，不是源码）；
 *   4. `pnpm publish --dry-run` —— **默认不发**，只把「将要发出去的东西」摊开给你看；
 *   5. 真的发要显式加 `--yes`。
 *
 * ⇒ **不带 `--yes` 永远不会碰 registry。** 这一条是这个脚本的默认值，也是它能
 * 第一次就被信任的原因。
 *
 * ## 从暂存目录发布（§7.188，2026-11-11）
 *
 * 发布**不在仓库根**跑 —— 而在 `dist/.npm-stage/` 跑。那个目录里摆的是
 * 「真正要发给 registry 的那个包」：内容 = `dist/installable/dsh-edge-agent-desktop-safe/`
 * + README + LICENSE，清单 = **去掉 `scripts` / `devDependencies` / `packageManager`**
 * 的那份（0.1.1 的毛病：清单声明了 50 余条脚本和一整套 devDeps，而它们指向的文件
 * 根本不在 tarball 里）。
 *
 * ⇒ **CI 也从同一个目录发**（`publish.yml` 的 Publish 步骤带 `working-directory`）
 * ⇒ 「本地 dry-run 与 CI 真发是同一条命令」这条纪律仍然成立，只是 cwd 换了个目录。
 * 暂存目录由构建链里的 `stage:npm` 产出，由 `verify:npm-stage` 门禁守着。
 *
 * ## 用法
 *
 * ```bash
 * npm run publish:npm                    # 构建 + 门禁 + dry-run（安全默认，不发）
 * npm run publish:npm -- --yes           # 真发
 * npm run publish:npm -- --selftest       # 认证预检的判定表自证（离线、不碰凭据）
 * npm run publish:npm -- --yes --tag     # 发完打 v<version> tag 并推上去
 * ```
 *
 * 前置：`npm login` 一次（凭据写在 `~/.npmrc`，pnpm 与 npm 共用）。
 *
 * **方案 B（2026-11-10 裁决，§7.173 更新 scope 名）**：npmjs.com 上有一个**同名账号或组织**
 * `@dsh-edge`，而**发包用的是主人自己的账号**（必须是该账号/组织的
 * 成员、角色含 publish —— npm 的 token 权限不能超过签发者本人的权限）：
 *
 * ```bash
 * npm login --scope=@dsh-edge
 * ```
 *
 * 真发布（`--yes`）会先做一次**认证预检**（离线读文件，3 秒内出结果）：找不到
 * token 就直接停 —— 而不是等构建链 + 28 道门禁跑完才在最后一步失败。
 *
 * ## 关于 provenance（溯源徽章）
 *
 * **首次发布一定不能带 `--provenance`。** 实测（2026-11-10）：
 *
 * ```
 * GET https://registry.npmjs.org/-/package/<name>/visibility
 *   尚不存在的包 → HTTP 200 {"public":false}
 *   已存在的公开包 → HTTP 200 {"public":true}
 * ```
 *
 * pnpm 的 provenance 生成器要问 registry「这包是不是 public」—— 首次发布时包还不
 * 存在 ⇒ registry 答 `false` ⇒ pnpm 拒绝做 provenance ⇒ 整个发布失败。
 *
 * ⇒ 本脚本**只在这个版本已经发过一次之后**才加 `--provenance`；首次发布走不带
 * 徽章的那支（发得出去）。详见 `scripts/registry-version.mjs` 的文件头。
 *
 * **⚠️ §7.188 再加一维：环境。** 「要不要带」与「带得了带不了」是两件事 ——
 * pnpm 的 provenance 生成器**只在受支持的 CI 里**能工作（GitHub Actions / GitLab CI）。
 * 本机跑 `pnpm publish --provenance` 必炸（实测 2026-11-11 发 0.1.2 时撞到）：
 *
 * ```
 * Error: ERR_PNPM_PROVENANCE_UNSUPPORTED_PROVIDER
 *   × Automatic provenance generation is not supported for this CI provider
 * ```
 *
 * ⇒ 本脚本的判定 = **「判定说带」AND「环境带得了」**；不在 CI 里一律 `--no-provenance`
 * （本地拿不到徽章，但发得出去）。CI 那条路（`publish.yml`）不受影响 ——
 * 它在 GitHub Actions 里，环境这一维是满足的。
 *
 * ## 关于 pnpm 的 git 检查（`--no-git-checks`）
 *
 * `pnpm publish` 默认会做 git 检查（工作树干净 + HEAD 挂在 `master|main` 上）。
 * 本脚本传 `--no-git-checks`，理由与 CI 那条完全一样：**tag push 时 CI 必然是
 * detached HEAD**，pnpm 会直接报 `ERR_PNPM_GIT_UNKNOWN_BRANCH`（实测 2026-11-10，
 * 详见下面 0.2 的注释）。本地路径与 CI 路径必须**同一条命令** —— 否则本地 dry-run
 * 验的不是 CI 真发的那条命令。
 *
 * 绕开 pnpm 的检查之后，这道检查由本脚本自己接住：
 *
 *   | pnpm 原本会查的 | 谁来接住 |
 *   |---|---|
 *   | 工作树干净 | 本脚本 0.1（`--allow-dirty` 可强行越过）|
 *   | HEAD 挂在默认分支上 | 本脚本 0.2（本地必须 attached；CI 天然 detached，跳过）|
 *   | HEAD 指向默认分支 | 不再需要 —— 本地不强制分支名，`--tag` 会把 tag 打在当前 HEAD 上 |
 *
 * ⇒ **本地 dry-run 与 CI 真发是同一条命令**：
 *
 * ```
 * pnpm publish --access public --ignore-scripts --no-git-checks [--provenance|--no-provenance]
 * ```
 *
 * ## 为什么只认 pnpm，不退回 npm
 *
 * 1. **CI 的 publish job 用的就是 `pnpm publish`** —— 本地 dry-run 必须与 CI 真发
 *    同一条命令，否则验的不是要发的那条。
 * 2. **npm CLI ≥ 11.5.1 在公开来源仓库上会自动生成 provenance** ⇒ 首次发布
 *    （包在 registry 上还不存在）必然失败 —— 正是 `decideProvenance` 要绕开的
 *    那个坑。退回 npm 等于把它又挖回来。
 *
 * ⇒ PATH 上没有 pnpm 就**明确报错**，不静默换一支。
 *
 * ## Windows 上调用 pnpm 的坑（实测 2026-11-10）
 *
 * Windows 上 `pnpm` 是 **`.cmd` shim**。Node 20.12+ 出于 CVE-2024-27980 直接拒绝
 * spawn `.cmd`/`.bat`，也不会给无扩展名的命令名补 PATHEXT ⇒
 * `spawnSync('pnpm', [...], { shell: false })` 必然 ENOENT（实测返回
 * `status === null`）。解法与 `scripts/verify-git-install.mjs` 同源：按**裸名**走
 * shell 跑，让 cmd.exe 自己按 PATHEXT 找 `pnpm.cmd`；代价是参数要自己保证没有
 * shell 元字符（见 `assertShellSafe()`）。
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { decideProvenance, probeVersion } from './registry-version.mjs'
import { STAGE_DIR } from './stage-npm-publish.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const YES = flag('--yes')
const TAG = flag('--tag')
const ALLOW_DIRTY = flag('--allow-dirty')
const SKIP_REGISTRY = flag('--skip-registry-check')
const REGISTRY = opt('--registry', 'https://registry.npmjs.org')

/* ── 自证（--selftest）：认证预检的判定表 ─────────────────────────────────── */

/**
 * pnpm 能不能生成**溯源徽章**（provenance）？
 *
 * §7.188 实测踩到（2026-11-11 发 0.1.2 时）：pnpm 的 provenance 生成器只支持少数
 * 几个 CI 提供商（GitHub Actions / GitLab CI）。在**本机**跑
 * `pnpm publish --provenance` 必炸：
 *
 * ```
 * Error: ERR_PNPM_PROVENANCE_UNSUPPORTED_PROVIDER
 *   × Automatic provenance generation is not supported for this CI provider
 * ```
 *
 * 而「要不要带 provenance」这个判定（`decideProvenance`）只看**仓库公开性**与
 * **registry 上的可见性** —— 第一次发布之后（包已存在且公开）它就判「带」。
 * ⇒ 本机发 0.1.2 时正好撞上这个组合：**判定说带，环境说带不了**。
 *
 * ⇒ 环境这一维必须单独判：不在受支持的 CI 里 ⇒ 一律 `--no-provenance`。
 * （CI 那条路 `publish.yml` 直接跑 `pnpm publish --provenance`，它在 GitHub Actions
 *  里，环境这一维是满足的 ⇒ 两边行为一致，只是本地拿不到徽章。）
 */
function provenanceEnv(env = process.env) {
  if (env.GITHUB_ACTIONS === 'true') return { capable: true, reason: 'GitHub Actions' }
  if (env.GITLAB_CI === 'true') return { capable: true, reason: 'GitLab CI' }
  return { capable: false, reason: '不在受支持的 CI 里（pnpm 只能在 CI 生成溯源徽章）' }
}

/**
 * `--selftest`：把「凭据检测」这张判定表自己证一遍。
 *
 * 为什么单独立一个入口：认证预检是**「能不能发出去」**这件事的守门人 ——
 * 一旦它给出**假阴性**（明明有凭据却说没有），主人就会在最后一步才看到失败，
 * 那正是这个预检存在的理由（2026-11-11 实测踩过：带 registry 前缀的 token 行
 * 被漏认 ⇒ 第一次发布被自己挡住）。
 *
 * 纯离线、纯只读、不碰真实凭据（用例里的 token 都是假的）。
 */
function selftest() {
  let failures = 0
  const expect = (label, actual, wanted) => {
    const ok = actual === wanted
    if (!ok) failures++
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label} — expected ${wanted}, got ${actual}`)
  }

  console.log('publish-npm --selftest')

  // 1. 不带前缀的写法（CI / 手写 .npmrc 常见）。
  expect('无前缀 _authToken', hasLiteralToken('_authToken=npm_fake\n'), true)
  // 2. 带 registry 前缀的写法 —— `npm login --auth-type=web` 实际写的就是它。
  expect('带前缀 //registry.npmjs.org/:_authToken', hasLiteralToken('//registry.npmjs.org/:_authToken=npm_fake\n'), true)
  // 3. 占位符不是字面量 ⇒ 真正的值在环境变量里 ⇒ 预检不认（由 env 分支接住）。
  expect('占位符 ${NPM_TOKEN}', hasLiteralToken('//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n'), false)
  // 4. 空值 / 无关行 / 空文件都不算凭据。
  expect('空值', hasLiteralToken('_authToken=\n'), false)
  expect('无关行', hasLiteralToken('registry=https://registry.npmjs.org/\n'), false)
  expect('空文件', hasLiteralToken(''), false)

  // 5. §7.188：溯源徽章（provenance）**只能在受支持的 CI 里**生成。
  expect('本机环境不支持 provenance', provenanceEnv({}).capable, false)
  expect('GitHub Actions 支持', provenanceEnv({ GITHUB_ACTIONS: 'true' }).capable, true)
  expect('GitLab CI 支持', provenanceEnv({ GITLAB_CI: 'true' }).capable, true)
  expect('GITHUB_ACTIONS=false 不算', provenanceEnv({ GITHUB_ACTIONS: 'false' }).capable, false)

  if (failures > 0) {
    console.error(`\nselftest FAILED: ${failures} assertion(s)`)
    process.exit(2)
  }
  console.log('\nselftest OK —— 带前缀 / 不带前缀的 token 行都认得出来')
}

if (flag('--selftest')) {
  selftest()
  process.exit(0)
}

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const NAME = manifest.name
const VERSION = manifest.version

/* ── 小工具 ─────────────────────────────────────────────────────────────── */

const IS_WINDOWS = process.platform === 'win32'

/**
 * Windows 上 `pnpm` / `npm` 是 **`.cmd` shim**。Node 20.12+ 出于 CVE-2024-27980
 * 直接拒绝 spawn `.cmd`/`.bat`，且**不会**给无扩展名的命令名补 PATHEXT ⇒
 * `spawnSync('pnpm', [...], { shell: false })` 在 Windows 上必然 ENOENT。
 *
 * 实测（2026-11-10）：`spawnSync('npm', [...], { shell: false })` 返回
 * `status === null` ⇒ 整个发布调用链静默断掉（脚本只报出一句「退出码 null」）。
 * 这就是「本地 dry-run 绿、真发才炸」的经典形态。
 *
 * 解法与 `scripts/verify-git-install.mjs` 同源：按**裸名**走 shell 跑
 * （cmd.exe 按 PATHEXT 自己找 `pnpm.cmd`），且**不传 args 数组**
 * （Node 20+ 对「shell + args」会打 DEP0190 警告：参数不转义只拼接）。
 *
 * 代价：参数得自己保证没有 shell 元字符 —— 见 `assertShellSafe()`。
 */
const SHELL_SAFE = /^[A-Za-z0-9@._:/=+-]+$/

function assertShellSafe(args) {
  const bad = args.filter((arg) => !SHELL_SAFE.test(arg))
  if (bad.length === 0) return
  console.error(`\n✗ 参数含有 shell 元字符，拒绝执行：${bad.join(' ')}`)
  console.error('  Windows 上 .cmd shim 由 cmd.exe 解析，元字符会被当成命令注入。')
  process.exit(1)
}

function run(cmd, cmdArgs, { allowFail = false, cwd = ROOT } = {}) {
  assertShellSafe(cmdArgs)
  console.log(`\n$ ${cmd} ${cmdArgs.join(' ')}`)
  const res = IS_WINDOWS
    ? spawnSync(`${cmd} ${cmdArgs.join(' ')}`, [], { cwd, stdio: 'inherit', shell: true })
    : spawnSync(cmd, cmdArgs, { cwd, stdio: 'inherit', shell: false })
  if (res.status !== 0 && !allowFail) {
    console.error(`\n✗ ${cmd} 退出码 ${res.status ?? 'null（进程没起来）'}`)
    process.exit(res.status ?? 1)
  }
  return res.status ?? 1
}

function git(...gitArgs) {
  return execFileSync('git', gitArgs, { cwd: ROOT, encoding: 'utf8' }).trim()
}

function gitStatus() {
  try {
    return git('status', '--porcelain')
  } catch {
    return ''
  }
}

/**
 * 在 PATH 上找可执行文件，**按 Windows 的规矩补扩展名**。
 *
 * 与 `scripts/verify-git-install.mjs` 的 `resolveOnPath()` 同源：PATH 逐目录 ×
 * PATHEXT 逐扩展名。存在的意义是**不要**用 `execFileSync('pnpm', ...)` 去探 ——
 * 那会误报「PATH 上没有 pnpm」（本机 `pnpm.cmd` 明明在 PATH 上）。
 */
function resolveOnPath(name) {
  const directories = (process.env.PATH ?? '').split(delimiter).filter((entry) => entry !== '')
  const extensions = IS_WINDOWS
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((entry) => entry !== '')
    : ['']
  for (const directory of directories) {
    for (const extension of extensions) {
      for (const suffix of extension === '' ? [''] : [extension.toLowerCase(), extension]) {
        const candidate = join(directory, name + suffix)
        if (existsSync(candidate)) return candidate
      }
    }
    const bare = join(directory, name)
    if (existsSync(bare)) return bare
  }
  return undefined
}

/**
 * 找到可用的 pnpm —— **不退回 npm**。
 *
 * 为什么没有 npm 兜底（实测 2026-11-10）：
 *   1. CI 的 publish job 用的就是 `pnpm publish` —— 本地 dry-run 必须与 CI 真发
 *      **同一条命令**，否则验的根本不是要发的那条。
 *   2. npm CLI ≥ 11.5.1 在**公开来源仓库**上会**自动**生成 provenance ⇒ 首次发布
 *      （包在 registry 上还不存在）必然失败 —— 正是 `decideProvenance` 要绕开的
 *      那个坑。退回 npm 等于把它又挖回来。
 */
function resolvePnpm() {
  const found = resolveOnPath('pnpm')
  const probe = IS_WINDOWS
    ? spawnSync('pnpm --version', [], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: true })
    : spawnSync('pnpm', ['--version'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  if (!found || probe.status !== 0) {
    console.error('\n✗ PATH 上没有可用的 pnpm。')
    console.error('  补救：`npm i -g pnpm`（本仓 packageManager 锁的是 pnpm@11.7.0）。')
    console.error('  不用 npm 兜底是有原因的：')
    console.error('    · CI 的 publish job 用的就是 `pnpm publish` —— 本地必须是同一条命令；')
    console.error('    · npm ≥ 11.5.1 在公开仓库上会自动带 provenance ⇒ 首次发布必失败。')
    process.exit(1)
  }
  return (probe.stdout ?? '').trim()
}

/* ── 第 0 步：前置检查 ─────────────────────────────────────────────────── */

console.log('publish-npm')
console.log(`  包名 : ${NAME}`)
console.log(`  版本 : ${VERSION}`)
console.log(`  源   : ${REGISTRY}`)
console.log(`  模式 : ${YES ? '真发布（--yes）' : 'dry-run（不发）'}`)

if (!YES && !TAG) {
  console.log('\n  ℹ 默认是 dry-run：只把将要发布的 tarball 摊开给你看，不碰 registry。')
  console.log('    真的要发 ⇒ 加 --yes。')
}

// 0.1 工作树必须干净 —— 发的必须是 git 里有的东西（tag 要能复现它）
const dirty = gitStatus()
if (dirty.length > 0 && !ALLOW_DIRTY) {
  console.error('\n✗ 工作树不干净（下面这些改动还没提交）：')
  for (const line of dirty.split(/\r?\n/).slice(0, 20)) console.error(`    ${line}`)
  console.error('\n  发出去的必须是 git 里有的东西 —— 否则 tag 复现不出来。')
  console.error('  先提交（或用 --allow-dirty 强行发，不推荐）。')
  process.exit(1)
}

// 0.2 HEAD 必须附着在一个分支上 —— detached HEAD 在本地几乎一定是走错路。
//
//     为什么这道检查在这里、而 CI 里没有：CI 在 tag push 时**必然**是 detached HEAD
//     （actions/checkout 检出的是 tag），所以 CI 那边只能 `pnpm publish
//     --no-git-checks` 绕开 pnpm 的 git 检查 —— 实测（2026-11-10）：
//
//       $ pnpm publish --dry-run --ignore-scripts            # detached HEAD
//       Error: ERR_PNPM_GIT_UNKNOWN_BRANCH
//         × The Git HEAD may not attached to any branch, but your
//           "publish-branch" is set to "master|main".
//       exit 1
//       $ pnpm publish --dry-run --ignore-scripts --no-git-checks
//       exit 0
//
//     绕开之后 pnpm 就**不再**检查分支了 ⇒ 本地这条路得自己补上：HEAD 不在任何
//     分支上 ⇒ 拒绝（本地完全可以站在一个分支上，没有理由 detached）。
const currentBranch = (() => {
  try {
    return git('branch', '--show-current')
  } catch {
    return ''
  }
})()
if (!currentBranch) {
  console.error('\n✗ HEAD 是 detached（不在任何分支上）。')
  console.error('  本地发布必须站在一个分支上 —— detached HEAD 发出去的版本既没法追责，')
  console.error('  也没法用一个 tag 复现。先 checkout 到你的分支再发。')
  process.exit(1)
}

// 0.3 版本发过没有？
if (!SKIP_REGISTRY) {
  console.log('\n── registry 预检 ──')
  const v = await probeVersion(NAME, VERSION, { registry: REGISTRY })
  if (v.state === 'published') {
    console.error(`\n✗ 版本 ${VERSION} 已经在 registry 上（409 会跟着来）。`)
    console.error('  改 package.json#version 再发，或者用 dist-tag 发一个别名版本。')
    process.exit(1)
  }
  if (v.state === 'absent') {
    console.log(`  ✓ 版本 ${VERSION} 未发过（包在 registry 上还不存在）`)
  } else {
    console.log(`  ? registry 状态未知（${v.error ?? '网络失败'}）—— 继续，但真发时可能撞 409`)
  }
}

// 0.3 能不能带 provenance？
let provenance = false
if (!SKIP_REGISTRY) {
  const repoIsPublic = await (async () => {
    try {
      const res = await fetch('https://api.github.com/repos/chschytzmcy/dsh-edge-agent', {
        headers: { 'user-agent': 'dsh-edge-agent-publish' },
        signal: AbortSignal.timeout(10000),
      })
      if (!res.ok) return false
      const body = await res.json()
      return body.visibility === 'public'
    } catch {
      return false
    }
  })()
  const decision = await decideProvenance(NAME, { repositoryIsPublic: repoIsPublic, registry: REGISTRY })
  const env = provenanceEnv()
  // §7.188：判定（要不要带）与环境（带得了带不了）**是两维** —— 必须同时满足。
  provenance = decision.provenance && env.capable
  const provenanceReason = decision.provenance && !env.capable ? env.reason : decision.reason
  console.log(`  · provenance: ${provenance ? '带（会有溯源徽章）' : '不带'} —— ${provenanceReason}`)
}

/* ── 第 1 步：canonical 构建链（与 CI 一字不差）───────────────────────── */

/**
 * 真发布前的**认证预检** —— 纯离线读文件，**不调 npm、不联网**。
 *
 * 为什么要有：真发布要跑完 canonical 构建链 + 27 道门禁（好几分钟）才轮到
 * `pnpm publish`；若那时才发现「没登录」，前面那几十分钟全白跑。
 *
 * 找 token 的四个来源（与 npm/pnpm 的实际查找顺序一致）：
 *   1. `NPM_TOKEN` 环境变量
 *   2. `NODE_AUTH_TOKEN` 环境变量（CI 用这个 —— setup-node 写的 .npmrc 引用它）
 *   3. 用户级 `.npmrc`（`~/.npmrc`）里的 `_authToken=`
 *   4. 仓库级 `.npmrc` 里的 `_authToken=`
 *
 * **只在 `--yes` 时查** —— dry-run 必须能在没凭据的机器上跑（它压根不碰 registry）。
 */
function findAuthSources() {
  const found = []
  if (process.env.NPM_TOKEN) found.push('NPM_TOKEN 环境变量')
  if (process.env.NODE_AUTH_TOKEN) found.push('NODE_AUTH_TOKEN 环境变量')
  for (const [label, path] of [
    ['~/.npmrc', join(homedir(), '.npmrc')],
    ['仓库的 .npmrc', join(ROOT, '.npmrc')],
  ]) {
    try {
      if (existsSync(path) && hasLiteralToken(readFileSync(path, 'utf8'))) found.push(label)
    } catch {
      // 读不到就当没有
    }
  }
  return found
}

/**
 * `.npmrc` 里有没有**字面量** token（`${NPM_TOKEN}` 这种占位符不算）。
 *
 * ## 为什么带 registry 前缀的写法也要认（2026-11-11 实测修的 bug）
 *
 * `npm login --auth-type=web` 往 `~/.npmrc` 里写的是**带前缀**的那一行：
 *
 * ```
 * //registry.npmjs.org/:_authToken=npm_xxxxxxxx
 * ```
 *
 * 当时的正则只认**不带前缀**的 `_authToken=`（`^\s*_authToken\s*=`）⇒ **假阴性**
 * ⇒ 明明 `npm whoami` 有身份、`~/.npmrc` 里有 token，预检却报「没找到凭据」
 * ⇒ 第一次发布被自己的预检挡在门外。
 *
 * ⇒ 现在两种写法都认：`(//registry/:)?_authToken=`。
 */
function hasLiteralToken(text) {
  for (const line of text.split(/\r?\n/u)) {
    const m = line.match(/^\s*(?:\/\/[^\s=]*:)?_authToken\s*=\s*(.+?)\s*$/u)
    if (!m) continue
    const value = m[1].trim()
    if (value.length === 0) continue
    if (/^\$\{.*\}$/u.test(value)) continue // 占位符 ⇒ 真正的值在环境变量里
    return true
  }
  return false
}

if (YES) {
  const sources = findAuthSources()
  if (sources.length === 0) {
    console.error('\n✗ 没找到 npm 凭据 —— 这一趟真发布会在**最后一步**才失败，')
    console.error('  前面的 canonical 构建链 + 27 道门禁全白跑。')
    console.error('\n  补救（方案 B：主人自己的账号 + npmjs.com 上那个同名账号/组织的成员身份）：')
    console.error('    npm login --scope=@dsh-edge')
    console.error('\n  或把 granular token 写进 ~/.npmrc / 存成环境变量 NPM_TOKEN。')
    console.error('  ⚠ 账号必须是那个账号/组织的**成员**（角色含 publish）——')
    console.error('    npm 的 token 权限不能超过签发者本人的权限。')
    process.exit(1)
  }
  console.log(`  ✓ 找到 npm 凭据（${sources.join(' / ')}）`)
}

console.log('\n── 构建（与 CI 同链）──')
run('node', ['scripts/run.mjs', 'compile', 'typecheck:client', 'build:client', 'build:installable', 'pack:tarball', 'stage:npm'])

/* ── 第 2 步：门禁（验产物，不验源码）─────────────────────────────────── */

console.log('\n── 门禁 ──')
run('node', ['scripts/run.mjs', 'verify:build'])

/* ── 第 3 步：发布 ─────────────────────────────────────────────────────── */

const pnpmVersion = resolvePnpm()
console.log(`\n── 发布（pnpm ${pnpmVersion}，cwd = ${STAGE_DIR}）──`)

const publishArgs = ['publish', '--access', 'public', '--ignore-scripts', '--no-git-checks', '--registry', REGISTRY]
if (provenance) publishArgs.push('--provenance')
else publishArgs.push('--no-provenance')

if (!YES) {
  // dry-run：pnpm 的 dry-run 只打印，不联网写 registry
  publishArgs.push('--dry-run')
  run('pnpm', publishArgs, { cwd: STAGE_DIR })
  console.log('\n────────────────────────────────────────')
  console.log('  dry-run 完成 —— 上面是**将要**发出去的 tarball。')
  console.log(`  真的要发：npm run publish:npm -- --yes${TAG ? ' --tag' : ''}`)
  console.log('────────────────────────────────────────')
  process.exit(0)
}

// 真发
run('pnpm', publishArgs, { cwd: STAGE_DIR })

console.log('\n────────────────────────────────────────')
console.log(`  ✓ 已发布：${NAME}@${VERSION}`)
console.log(`    registry : https://www.npmjs.com/package/${NAME}`)
console.log(`    安装     : ${NAME}@${VERSION}`)
console.log('────────────────────────────────────────')

/* ── 第 4 步（可选）：打 tag ──────────────────────────────────────────── */

if (TAG) {
  const tagName = `v${VERSION}`
  console.log(`\n── tag ──`)
  try {
    git('tag', tagName)
    console.log(`  ✓ 已打 tag ${tagName}`)
  } catch {
    console.log(`  ℹ tag ${tagName} 已存在（跳过）`)
  }
  console.log(`  推送 tag：git push origin ${tagName}`)
  console.log('  ⇒ CI 的 publish job 会发现该版本已发过并跳过（不会 409），')
  console.log('    但 release job 仍会建 GitHub Release。')
}
