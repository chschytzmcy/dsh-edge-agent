#!/usr/bin/env node
/**
 * verify-npm-stage.mjs — §7.188：验「要发给 registry 的那个包」摆对了没有。
 *
 * 门禁链的第 28 道（`verify:build` 的最后一位）。它验的是**暂存目录**
 * （`dist/.npm-stage/`），不是源码 —— 与 `verify:tarball` / `verify:installable`
 * 同一个纪律：**门禁验的是产物**。
 *
 * ## 它守的是什么
 *
 * 1. **清单与内容一致**：发布出去的 `package.json` 不得再声明不在包里的
 *    `scripts` / `devDependencies`（0.1.1 的实际毛病）；
 * 2. **出货内容与构建产物一致**：暂存目录里的文件必须**逐个等于**
 *    `dist/installable/dsh-edge-agent-desktop-safe/` 里的文件 + README + LICENSE
 *    ⇒ npm 包里不会出现「构建时没有、发布时冒出来」的文件；
 * 3. **凭据绝不随包走**：暂存目录里没有 `config/edge.json`；
 * 4. **装后校验的三个前提**还在：`dsh.bundle.patch` 列出的文件都在、
 *    `engines.dsh` 已声明、`peerDependencies` 非空。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/verify-npm-stage.mjs             # 验暂存目录
 * node scripts/verify-npm-stage.mjs --selftest  # 自证（纯函数，不碰 dist/）
 * ```
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STAGE_DIR = join(ROOT, 'dist', '.npm-stage')
const VARIANT_DIR = join(ROOT, 'dist', 'installable', 'dsh-edge-agent-desktop-safe')

/** 递归列出目录下所有文件（相对路径，正斜杠）。 */
export function listFiles(dir, base = dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...listFiles(full, base))
    else out.push(relative(base, full).split(sep).join('/'))
  }
  return out.sort()
}

/**
 * 「应该出货的文件集合」= 变体目录里的全部文件 + README + LICENSE。
 *
 * README / LICENSE 是 npm **永远自动带**的（前提是目录里有），所以它们不在
 * 变体目录里，但一定在包里。
 */
export function expectedShipSet(variantFiles) {
  const set = new Set(variantFiles)
  set.add('README.md')
  set.add('LICENSE')
  return set
}

/** 两个集合的差集（仅在 a 里的 / 仅在 b 里的）。 */
export function diffSets(a, b) {
  const onlyA = [...a].filter((x) => !b.has(x)).sort()
  const onlyB = [...b].filter((x) => !a.has(x)).sort()
  return { onlyA, onlyB }
}

/* ── 自证（纯函数）────────────────────────────────────────────────────────── */

function selftest() {
  const failures = []
  const check = (name, ok, detail) => {
    if (ok) console.log(`  ok   ${name}`)
    else {
      console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`)
      failures.push(name)
    }
  }

  check('空变体 ⇒ 期望集合含 README+LICENSE', (() => {
    const s = expectedShipSet([])
    return s.has('README.md') && s.has('LICENSE') && s.size === 2
  })())

  check('变体文件原样进入期望集合', (() => {
    const s = expectedShipSet(['lib/index.js', 'config/edge.example.json'])
    return s.has('lib/index.js') && s.has('config/edge.example.json') && s.size === 4
  })())

  check('两个相同集合无差集', (() => {
    const d = diffSets(new Set(['a', 'b']), new Set(['b', 'a']))
    return d.onlyA.length === 0 && d.onlyB.length === 0
  })())

  check('多出/缺少都能看出来', (() => {
    const d = diffSets(new Set(['a', 'x']), new Set(['a', 'b']))
    return d.onlyA.length === 1 && d.onlyA[0] === 'x' && d.onlyB.length === 1 && d.onlyB[0] === 'b'
  })())

  if (failures.length > 0) {
    console.error(`selftest: ${failures.length} check(s) failed`)
    process.exit(1)
  }
  console.log('selftest: all checks passed')
}

/* ── 主流程 ───────────────────────────────────────────────────────────────── */

if (process.argv.includes('--selftest')) {
  selftest()
} else {
  const failures = []
  const fail = (msg) => failures.push(msg)

  if (!existsSync(STAGE_DIR)) {
    console.error('verify-npm-stage')
    console.error(`  暂存目录不存在：${STAGE_DIR}`)
    console.error('  ⇒ 先跑 node scripts/stage-npm-publish.mjs（构建链里有 stage:npm）')
    process.exit(1)
  }
  if (!existsSync(VARIANT_DIR)) {
    console.error(`  变体目录不存在：${VARIANT_DIR} —— 先跑 build:installable`)
    process.exit(1)
  }

  const manifest = JSON.parse(readFileSync(join(STAGE_DIR, 'package.json'), 'utf8'))
  const repoManifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

  // 1. 版本
  if (manifest.version !== repoManifest.version) {
    fail(`清单版本 ${manifest.version} ≠ 仓库版本 ${repoManifest.version}`)
  }
  if (manifest.version === '0.0.0') fail('清单版本是 0.0.0')

  // 2. 清单不得声明不在包里的东西
  if (manifest.scripts !== undefined) fail('清单里还有 scripts —— 它们指向不在包里的 scripts/')
  if (manifest.devDependencies !== undefined) fail('清单里还有 devDependencies —— 消费者不会安装它们')
  if (manifest.packageManager !== undefined) fail('清单里还有 packageManager —— npm 发布时会剥掉它，写着只会与产物不一致')

  // 3. 装后校验的三个前提
  const patchList = manifest.dsh?.bundle?.patch ?? []
  for (const entry of patchList) {
    const rel = String(entry).replace(/^\.\//u, '')
    if (!existsSync(join(STAGE_DIR, rel))) fail(`dsh.bundle.patch 列出的 "${rel}" 不在暂存目录里 ⇒ 装后校验会回滚整个安装`)
  }
  if (!manifest.engines?.dsh) fail('清单没有 engines.dsh ⇒ 宿主无法独断兼容性')
  if (!manifest.peerDependencies || Object.keys(manifest.peerDependencies).length === 0) fail('清单没有 peerDependencies')
  if (manifest.publishConfig?.access !== 'public') fail('清单没有 publishConfig.access=public ⇒ 会发成 private')

  // 4. exports 与仓库根一致（装后按 subpath 解析）
  const stageExports = Object.keys(manifest.exports ?? {}).length
  const repoExports = Object.keys(repoManifest.exports ?? {}).length
  if (stageExports !== repoExports) fail(`exports 条数 ${stageExports} ≠ 仓库的 ${repoExports}`)

  // 5. 凭据绝不随包走
  const files = manifest.files ?? []
  if (files.some((f) => String(f).replace(/^\.\//u, '') === 'config/edge.json')) {
    fail('清单的 files 包含 config/edge.json —— 那是明文凭据文件')
  }
  if (existsSync(join(STAGE_DIR, 'config', 'edge.json'))) {
    fail('暂存目录里有 config/edge.json —— 明文凭据会被发到 registry')
  }

  // 6. 不该出现的目录
  for (const d of ['scripts', 'src', 'tests', '.git']) {
    if (existsSync(join(STAGE_DIR, d))) fail(`暂存目录里有 ${d}/ —— 它不在 files 白名单内，但摆进去就是给自己埋雷`)
  }

  // 7. 出货内容必须逐个等于「变体目录 + README + LICENSE」
  const stagedFiles = listFiles(STAGE_DIR)
  const variantFiles = listFiles(VARIANT_DIR)
  const expected = expectedShipSet(variantFiles)
  const actual = new Set(stagedFiles)
  const { onlyA, onlyB } = diffSets(expected, actual)
  if (onlyA.length > 0) fail(`暂存目录缺了 ${onlyA.length} 个文件：${onlyA.slice(0, 5).join(', ')}`)
  if (onlyB.length > 0) fail(`暂存目录多出 ${onlyB.length} 个文件：${onlyB.slice(0, 5).join(', ')}`)

  console.log('verify-npm-stage')
  console.log(`  暂存目录        : ${STAGE_DIR}`)
  console.log(`  清单版本        : ${manifest.version}（仓库 ${repoManifest.version}）`)
  console.log(`  scripts         : ${manifest.scripts ? '有（不该有！）' : '无 ✓'}`)
  console.log(`  devDependencies : ${manifest.devDependencies ? '有（不该有！）' : '无 ✓'}`)
  console.log(`  bundle.patch    : ${patchList.length} 个文件，都在 ✓`)
  console.log(`  exports         : ${stageExports} 条（与仓库一致 ✓）`)
  console.log(`  config/edge.json: 不在 ✓`)
  console.log(`  出货文件        : ${stagedFiles.length} 个（= 变体 ${variantFiles.length} + README + LICENSE）`)
  console.log(`  失败            : ${failures.length}`)

  if (failures.length > 0) {
    console.log('\n失败明细：')
    for (const f of failures) console.log(`  - ${f}`)
    console.error('\nFAIL')
    process.exit(1)
  }
  console.log('\nPASS')
}
