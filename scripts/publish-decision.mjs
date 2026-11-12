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
 * ## `--wait-seconds`（§7.202，2026-11-12）
 *
 * registry 的**写路径**与**读路径**不同步：发布成功后，`GET /<name>` 的
 * `versions` 数组要过 **~1–2 分钟**才看到这个新版本。
 *
 * 实测（2026-11-12 发 0.1.4）：本机 `pnpm publish` 15:26:35 报「✅ Published」，
 * 而 registry 的 `versions` 数组 **15:28:06** 才出现 `0.1.4`（≈91 秒）。
 * 期间 `npm view <pkg> versions` 里**看不到**这一版。
 *
 * ⇒ 「本机发完立刻推 tag」这条路径下，CI 的 decide 步**很可能正好落在这 91 秒
 * 的窗口里** ⇒ 判「未发过」⇒ CI 真的去 publish ⇒ 而 registry 的**写路径**
 * 早已拒收这一版（409）⇒ job 红。**实测 run #4 就是这样红的**（§7.202）。
 *
 * ⇒ `--wait-seconds N`：当「包存在、但这一版还不在 `versions` 里」时（这正是
 * 传播延迟的 signature），最多等 N 秒再决定（每 15 秒重查一次）。默认 0 = 不等
 * （保持既有行为与自证不变）。
 *
 * 「包压根不存在」（首次发布）时**不等** —— 那不是传播延迟，等也没有意义。
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

  // §7.202: 传播延迟的判定表（纯函数、不联网）
  {
    expect(
      '包存在但这一版不在 versions 里 ⇒ 该等（传播延迟的 signature）',
      shouldWaitForVisibility({ state: 'absent', versions: ['0.1.1', '0.1.2'] }, 180),
      true,
    )
    expect(
      '包压根不存在（首次发布）⇒ 不等',
      shouldWaitForVisibility({ state: 'absent' }, 180),
      false,
    )
    expect(
      '这一版已经在了 ⇒ 不等',
      shouldWaitForVisibility({ state: 'published', versions: ['0.1.4'] }, 180),
      false,
    )
    expect(
      'registry 状态未知（网络失败）⇒ 不等',
      shouldWaitForVisibility({ state: 'unknown' }, 180),
      false,
    )
    expect(
      '等待秒数为 0（默认）⇒ 不等',
      shouldWaitForVisibility({ state: 'absent', versions: ['0.1.1'] }, 0),
      false,
    )
  }

  if (failures > 0) {
    console.error(`\nselftest FAILED: ${failures} assertion(s)`)
    process.exit(2)
  }
  console.log('\nselftest OK — stdout 只有 5 个 key=value，值都是单行，人类可读的部分在 stderr 上')
}

const log = (msg) => process.stderr.write(`${msg}\n`)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ── 参数 ────────────────────────────────────────────────────────────────── */

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

/**
 * 最多等多少秒去「等 registry 看到这一版」（§7.202）。默认 0 = 不等。
 *
 * 解析成数字且不为负；给成非数字时按 0 处理（不因为参数写错就等 3 分钟）。
 */
export const WAIT_SECONDS = Math.max(0, Number(opt('--wait-seconds', '0')) || 0)

/** 重查间隔（秒）。15 秒 ≈ 传播延迟（91 秒）的 1/6，够细也不把 registry 刷爆。 */
export const POLL_INTERVAL_MS = 15_000

/**
 * §7.202: 该不该为「registry 还没看到这一版」而等一等？
 *
 * **传播延迟的 signature** = 「包存在、但这一版还不在 `versions` 数组里」：
 *   - 包**压根不存在**（`versions` 压根没有这个字段）⇒ 首次发布 ⇒ 等也没用；
 *   - 状态 `unknown`（网络失败）⇒ 等也没用（重查同样会失败）；
 *   - 已经 `published` ⇒ 不用等。
 *
 * 纯函数、不联网 ⇒ 自证可以直接断言它。
 *
 * @param {{state?: string, versions?: string[]}} probe `probeVersion` 的返回
 * @param {number} waitSeconds 允许等待的秒数
 * @returns {boolean}
 */
export function shouldWaitForVisibility(probe, waitSeconds) {
  if (!(waitSeconds > 0)) return false
  if (probe?.state !== 'absent') return false
  return Array.isArray(probe.versions) && probe.versions.length > 0
}

if (process.argv.includes('--selftest')) {
  console.log('publish-decision --selftest')
  selftest()
  process.exit(0)
}

log(`publish-decision: ${NAME}@${VERSION}  registry=${REGISTRY}  visibility=${VISIBILITY || '(未知)'}`)

// ── 决策 1：这个版本发过没有？────────────────────────────────────────────
//
// §7.202：「本机发完立刻推 tag」时，registry 的**读路径**可能还没追上
// （实测：发布成功 → `versions` 里可见，≈91 秒）⇒ 这一版会被判成「未发过」
// ⇒ CI 真的去 publish ⇒ 而**写路径**早已拒收它（409）⇒ job 红。
// ⇒ 这里给它一个等待窗口（默认 0 = 不等；workflow 传 180）。
let versionProbe = await probeVersion(NAME, VERSION, { registry: REGISTRY })

if (shouldWaitForVisibility(versionProbe, WAIT_SECONDS)) {
  log(
    `  ⇒ 包存在、但版本 ${VERSION} 还没进 versions 数组`
    + `（registry 传播延迟，§7.202）⇒ 最多等 ${WAIT_SECONDS}s`,
  )
  const deadline = Date.now() + WAIT_SECONDS * 1000
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS)
    versionProbe = await probeVersion(NAME, VERSION, { registry: REGISTRY })
    if (versionProbe.state === 'published') {
      log(`  ⇒ 等到了：版本 ${VERSION} 已出现在 registry 上`)
      break
    }
    if (versionProbe.state !== 'absent') {
      log(`  ⇒ registry 状态变成「${versionProbe.state}」⇒ 不再等`)
      break
    }
  }
  if (versionProbe.state === 'absent') {
    log(`  ⇒ 等满 ${WAIT_SECONDS}s 仍未看到这一版 ⇒ 按「未发过」处理，交给 publish 步骤自己报错`)
  }
}

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
