#!/usr/bin/env node
/**
 * publish-decision.mjs —— 给 CI 的发布决策（§7.172）
 *
 * 输出**只有 `key=value` 行**（给 `$GITHUB_OUTPUT` 用），人类可读的部分走 stderr
 * （留在 CI 日志里）。于是 workflow 里可以一行搞定：
 *
 * ```yaml
 * - name: Decide
 *   id: decide
 *   run: node scripts/publish-decision.mjs >> "$GITHUB_OUTPUT"
 * ```
 *
 * ## 两个决策
 *
 *   1. **skip** —— 这个版本是不是已经发过了？
 *      发过就跳过整个 publish 步骤（而不是撞 409 让 job 红）。
 *      这让**两条发布路径可以共存**：本地 `npm run publish:npm -- --yes --tag`
 *      发完再推 tag ⇒ CI 看到这个版本已在 registry 上 ⇒ 跳过 publish，
 *      但 release job 仍会建 GitHub Release。
 *
 *   2. **provenance** —— 这次要不要带溯源徽章？
 *
 *      | 仓库可见性 | 包在 registry 上 | 结论 |
 *      |---|---|---|
 *      | 私有 | 任意 | ❌ 不带（npm 不接受私有来源仓库的 provenance）|
 *      | 公开 | **还不存在** | ❌ 不带（**首次发布**）—— registry 的 visibility 端点此时答 `{"public":false}` |
 *      | 公开 | 存在且 public | ✅ 带 |
 *      | 公开 | 存在但不是 public | ❌ 不带 |
 *      | 任意 | 查不到（网络失败）| ❌ 不带（宁可少一个徽章，也不让整个发布失败）|
 *
 *      首次发布那条是实测来的（2026-11-10）：
 *
 *      ```
 *      GET https://registry.npmjs.org/-/package/<name>/visibility
 *        尚不存在的包 → HTTP 200 {"public":false}
 *        已存在的公开包 → HTTP 200 {"public":true}
 *      ```
 *
 *      ⇒ **不是 404**（`docs/deploy-npm.md` §8.5.1 当时猜的是 404，形态猜错了，
 *      但结论一样：首次发布带 `--provenance` 必失败）。
 *
 * ## 环境变量
 *
 *   - `REPOSITORY_VISIBILITY` —— `public` / `private` / `internal`；取不到时按
 *     **不公开**处理（宁可少一个徽章）。
 *   - `NPM_REGISTRY` —— 默认 `https://registry.npmjs.org`。
 *
 * 退出码恒为 0 —— **决策失败不该让 job 红**：决策本身只影响「发不发 / 带不带
 * 徽章」，真正的发布错误由 publish 步骤自己报。
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { decideProvenance, probeVersion } from './registry-version.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const NAME = manifest.name
const VERSION = manifest.version
const REGISTRY = process.env.NPM_REGISTRY ?? 'https://registry.npmjs.org'
const VISIBILITY = (process.env.REPOSITORY_VISIBILITY ?? '').trim()

/* ── 自证：stdout 契约 ──────────────────────────────────────────────────── */

/**
 * `$GITHUB_OUTPUT` **只吃 `key=value` 行**。stdout 里多一行说明、或有一行不是
 * `key=value`，workflow 就会把它当成一个叫「那一行」的输出（或直接解析失败）
 * ⇒ publish job 在一个跟发布毫无关系的地方红掉。
 *
 * 这条契约**只能靠真跑一遍来验**（没法用纯函数断言）⇒ 自证里把本脚本 spawn
 * 一次，registry 指向一个**连不上的端口** ⇒ 走「查不到」那条支 ⇒ 一样会输出
 * 那 5 个键 ⇒ 断言在**离线**环境下也成立。
 */
function selftest() {
  let failures = 0
  const expect = (label, actual, wanted) => {
    const ok = actual === wanted
    if (!ok) failures++
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label} — expected ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`)
  }

  const res = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    encoding: 'utf8',
    env: { ...process.env, NPM_REGISTRY: 'http://127.0.0.1:1', REPOSITORY_VISIBILITY: 'public' },
  })

  expect('退出码恒为 0（决策失败不该让 job 红）', res.status, 0)

  const lines = (res.stdout ?? '').split(/\r?\n/u).filter((l) => l.length > 0)
  expect('stdout 至少 5 行', lines.length >= 5, true)
  expect(
    'stdout 每行都是 key=value',
    lines.every((l) => /^[a-z_]+=/u.test(l)),
    true,
  )

  const keys = lines.map((l) => l.slice(0, l.indexOf('=')))
  expect('skip 出现且只出现一次', keys.filter((k) => k === 'skip').length, 1)
  expect('provenance 出现且只出现一次', keys.filter((k) => k === 'provenance').length, 1)
  expect('provenance_reason 出现且只出现一次', keys.filter((k) => k === 'provenance_reason').length, 1)
  expect('package 出现且只出现一次', keys.filter((k) => k === 'package').length, 1)
  expect('version 出现且只出现一次', keys.filter((k) => k === 'version').length, 1)
  expect('没有多余的键', keys.length, 5)

  // 值必须是单行（$GITHUB_OUTPUT 的多行值要 heredoc 分隔符）
  const values = lines.map((l) => l.slice(l.indexOf('=') + 1))
  expect('每个值都是单行（不含换行）', values.every((v) => !/[\r\n]/u.test(v)), true)
  expect('package 的值是本仓包名', values[keys.indexOf('package')], NAME)
  expect('version 的值是本仓版本', values[keys.indexOf('version')], VERSION)

  // 人类可读的部分必须走 stderr（留在 CI 日志里），不能混进 stdout
  expect('stderr 非空（人类可读的判断在 stderr 上）', (res.stderr ?? '').trim().length > 0, true)
  expect('stderr 不含 key=value 行（那是 stdout 的专属格式）', /^[a-z_]+=/mu.test(res.stderr ?? ''), false)

  if (failures > 0) {
    console.error(`\nselftest FAILED: ${failures} assertion(s)`)
    process.exit(2)
  }
  console.log('\nselftest OK — stdout 只有 5 个 key=value，值都是单行，人类可读的部分在 stderr 上')
}

const log = (msg) => process.stderr.write(`${msg}\n`)

if (process.argv.includes('--selftest')) {
  console.log('publish-decision --selftest')
  selftest()
  process.exit(0)
}

log(`publish-decision: ${NAME}@${VERSION}  registry=${REGISTRY}  visibility=${VISIBILITY || '(未知)'}`)

// ── 决策 1：这个版本发过没有？────────────────────────────────────────────
const versionProbe = await probeVersion(NAME, VERSION, { registry: REGISTRY })
const skip = versionProbe.state === 'published'
if (skip) {
  log(`  ⇒ 版本 ${VERSION} 已在 registry 上 ⇒ 跳过 publish（不会撞 409）`)
} else if (versionProbe.state === 'absent') {
  log(`  ⇒ 版本 ${VERSION} 未发过 ⇒ 正常发布`)
} else {
  log(`  ⇒ registry 状态未知（${versionProbe.error ?? '网络失败'}）⇒ 按「未发过」处理，交给 publish 步骤自己报错`)
}

// ── 决策 2：要不要带 provenance？────────────────────────────────────────
const decision = await decideProvenance(NAME, {
  repositoryIsPublic: VISIBILITY === 'public',
  registry: REGISTRY,
})
log(`  ⇒ provenance: ${decision.provenance ? '带' : '不带'} —— ${decision.reason}`)

// ── 输出（stdout 只有 key=value，给 $GITHUB_OUTPUT）─────────────────────
//
// $GITHUB_OUTPUT 是 `key=value` 的行格式：值必须**单行**（多行要 heredoc 分隔符），
// 且不能含换行。provenance_reason 是给人看的日志文案 —— 这里压成单行并去掉引号，
// 免得它在 workflow 的 `run:` 插值里把 shell 语法带歪。
const oneLine = (text) => String(text).replace(/[\r\n]+/gu, ' ').replace(/"/gu, "'").trim()

console.log(`skip=${skip}`)
console.log(`provenance=${decision.provenance}`)
console.log(`provenance_reason=${oneLine(decision.reason)}`)
console.log(`package=${NAME}`)
console.log(`version=${VERSION}`)
