#!/usr/bin/env node
/**
 * registry-version.mjs —— npm registry 探针（§7.172）
 *
 * ## 为什么需要它
 *
 * 发布这条链**从来没被走通过**（本仓至今 0 个 tag、registry 上 404）。于是有两件事
 * 只能靠「读文档猜」：
 *
 *   1. 这个版本发过没有？—— 发过再发是 409，而 409 出现在 `pnpm publish` 的最后
 *      一步，前面的构建 + 门禁全白跑。
 *   2. **能不能带 `--provenance`？** —— 这一条更要命，见下。
 *
 * ## provenance 的首次发布陷阱（实测，2026-11-10）
 *
 * pnpm 的 provenance 生成器（`crates/publish/src/oidc/provenance.rs`）会**自己**去问
 * registry「这个包是不是 public」：
 *
 * ```
 * GET https://registry.npmjs.org/-/package/<name>/visibility
 * ```
 *
 * 实测结果：
 *
 * | 目标 | HTTP | body |
 * |---|---|---|
 * | `@dsh-edge/dsh-edge-agent`（**尚不存在**）| **200** | `{"public":false}` |
 * | `@deepseek-ai/cordis`（已存在的公开包）| 200 | `{"public":true}` |
 *
 * ⇒ **不是 404**。`docs/deploy-npm.md` §8.5.1 当时猜的是「包不存在时端点返回 404 ⇒
 * `ProvenanceFailedToFetchVisibilityError`」—— 猜错了形态，但结论一样：**首次发布
 * 一定失败**。真实形态是 registry 答 `{"public":false}`（包还不存在，自然不是
 * public）⇒ pnpm 认为「这包不是 public，不给它做 provenance」⇒ 抛错。
 *
 * ⇒ **首次发布不能带 `--provenance`**；发完（必要时 `pnpm access set status=public
 * @scope/pkg`）之后，registry 才会答 `{"public":true}`，之后的版本才能带溯源徽章。
 *
 * 这条判定逻辑是本模块存在的**唯一理由** —— 它把「能不能带徽章」从猜测变成事实。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/registry-version.mjs                       # 查本仓包的发布态
 * node scripts/registry-version.mjs <pkg> [<version>]     # 查任意包
 * node scripts/registry-version.mjs --selftest            # 判定表自证（不联网）
 * ```
 *
 * 退出码：0 = 查到了（看 JSON 里的 state）；2 = 参数错。
 * 网络失败**不算失败** —— 返回 `state: "unknown"` 并以 0 退出（离线也要能跑）。
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
const DEFAULT_TIMEOUT_MS = 10000

/** 包名 → registry 上的路径（scoped 包要把 `/` 编码成 `%2f`）。 */
export function registryPath(name) {
  return `/${name.startsWith('@') ? name.replace('/', '%2f') : name}`
}

/**
 * GET 一个 registry 端点。
 *
 * @returns {Promise<{ok: boolean, status: number, body: unknown, error?: string}>}
 */
async function getJson(url, timeoutMs) {
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    let body
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
    return { ok: res.ok, status: res.status, body }
  } catch (err) {
    return { ok: false, status: 0, body: undefined, error: err?.message ?? String(err) }
  }
}

/**
 * 这个包在 registry 上存在吗？
 *
 * 用**整包**端点（`GET /<name>`）而不是 visibility 端点 —— 因为 visibility 对
 * 「不存在的包」也返回 200（见文件头），分不出「没发过」与「发了但 restricted」。
 *
 * @returns {Promise<{state:'present'|'absent'|'unknown', versions?:string[], status?:number, error?:string}>}
 */
export async function probePackage(name, { registry = DEFAULT_REGISTRY, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const res = await getJson(`${registry}${registryPath(name)}`, timeoutMs)
  if (res.status === 404) return { state: 'absent', status: 404 }
  if (!res.ok && res.status !== 0) return { state: 'unknown', status: res.status, error: res.error }
  if (res.status === 0) return { state: 'unknown', status: 0, error: res.error }
  const versions = res.body && typeof res.body === 'object' ? Object.keys(res.body.versions ?? {}) : []
  return { state: 'present', versions, status: res.status }
}

/**
 * 这个包是不是 public？（provenance 的前提）
 *
 * @returns {Promise<{public:boolean|null, status:number, error?:string}>}
 */
export async function probeVisibility(name, { registry = DEFAULT_REGISTRY, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const res = await getJson(`${registry}/-/package/${registryPath(name).slice(1)}/visibility`, timeoutMs)
  if (res.status === 0) return { public: null, status: 0, error: res.error }
  if (res.body && typeof res.body === 'object' && typeof res.body.public === 'boolean') {
    return { public: res.body.public, status: res.status }
  }
  return { public: null, status: res.status, error: 'failed to parse the package-visibility response' }
}

/**
 * 这个**版本**发过没有？
 *
 * @returns {Promise<{state:'published'|'absent'|'unknown', versions?:string[]}>}
 */
export async function probeVersion(name, version, options = {}) {
  const pkg = await probePackage(name, options)
  if (pkg.state !== 'present') return { state: pkg.state, versions: pkg.versions }
  return {
    state: pkg.versions.includes(version) ? 'published' : 'absent',
    versions: pkg.versions,
  }
}

/**
 * 能不能带 `--provenance`？
 *
 * 三个条件同时成立才可以（与 pnpm 的判定对齐）：
 *   1. 来源仓库是**公开**的（npm 只接受公共来源仓库的溯源）；
 *   2. 这个包在 registry 上**已经存在**（首次发布时它不存在 ⇒ registry 答
 *      `{"public":false}` ⇒ pnpm 拒绝做 provenance）；
 *   3. registry 明确说它是 public。
 *
 * `probePackage` / `probeVisibility` 可注入 ⇒ 自证时**不联网**（见文件末的
 * `--selftest`）。注入是本函数唯一的测试接缝，不影响默认行为。
 *
 * @returns {Promise<{provenance:boolean, reason:string, packageState:string, public:boolean|null}>}
 */
export async function decideProvenance(name, {
  repositoryIsPublic,
  registry = DEFAULT_REGISTRY,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  probePackage: probePackageImpl = probePackage,
  probeVisibility: probeVisibilityImpl = probeVisibility,
} = {}) {
  if (!repositoryIsPublic) {
    return {
      provenance: false,
      reason: '来源仓库不是 public —— npm 不接受私有来源仓库的 provenance（ProvenanceInsufficientInformationError / E422）',
      packageState: 'unknown',
      public: null,
    }
  }
  const pkg = await probePackageImpl(name, { registry, timeoutMs })
  if (pkg.state === 'absent') {
    return {
      provenance: false,
      reason: '首次发布：包在 registry 上还不存在 ⇒ registry 的 visibility 端点会答 {"public":false} ⇒ pnpm 拒绝做 provenance',
      packageState: 'absent',
      public: false,
    }
  }
  if (pkg.state === 'unknown') {
    return {
      provenance: false,
      reason: `查不到 registry 状态（${pkg.error ?? '网络失败'}）⇒ 宁可少一个徽章，也不让整个发布失败`,
      packageState: 'unknown',
      public: null,
    }
  }
  const vis = await probeVisibilityImpl(name, { registry, timeoutMs })
  if (vis.public !== true) {
    return {
      provenance: false,
      reason: 'registry 说这个包不是 public ⇒ pnpm 不会给它做 provenance',
      packageState: 'present',
      public: vis.public,
    }
  }
  return {
    provenance: true,
    reason: '仓库公开 + 包已存在 + registry 说 public ⇒ 带溯源徽章',
    packageState: 'present',
    public: true,
  }
}

/* ── 自证 + 反向证伪 ─────────────────────────────────────────────────────── */

/**
 * 判定表的五行，逐行断言。
 *
 * 为什么必须有：**这段逻辑是整个发布链里最脆弱的一环** —— 它决定首次发布带不带
 * `--provenance`。判错方向一：
 *   - 该带不带 ⇒ 首次发布被 pnpm 拒绝（registry 答 `{"public":false}`）；
 *   - 不该带却带 ⇒ 后续版本白白丢掉溯源徽章。
 * 而它**只在 CI 的 publish job 里跑**（`publish.yml` 的 Decide 步）⇒ build job
 * 里的任何门禁都够不着它 ⇒ 只能靠它自己的自证。
 *
 * 用**注入的假探针**，不联网、不碰 registry。
 */
async function selftest() {
  let failures = 0
  const expect = (label, actual, wanted) => {
    const ok = actual === wanted
    if (!ok) failures++
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label} — expected ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`)
  }

  const ABSENT = { state: 'absent', status: 404 }
  const PRESENT = { state: 'present', versions: ['0.1.1'], status: 200 }
  const UNKNOWN = { state: 'unknown', status: 0, error: 'network down' }
  const vis = (public_) => async () => ({ public: public_, status: 200 })

  const decide = (opts) => decideProvenance('pkg', {
    probePackage: async () => ABSENT,
    probeVisibility: vis(false),
    ...opts,
  })

  // ① 私有仓库 ⇒ ①步就抛错 ⇒ 不带
  {
    const d = await decide({ repositoryIsPublic: false, probePackage: async () => PRESENT, probeVisibility: vis(true) })
    expect('私有仓库 ⇒ 不带 provenance', d.provenance, false)
  }
  // ② 公开 + 包还不存在 ⇒ 首次发布 ⇒ 不带（这是实测出来的那个坑）
  {
    const d = await decide({ repositoryIsPublic: true })
    expect('公开 + 包不存在 ⇒ 不带（首次发布）', d.provenance, false)
    expect('公开 + 包不存在 ⇒ packageState=absent', d.packageState, 'absent')
  }
  // ③ 公开 + 包存在 + registry 说 public ⇒ 带
  {
    const d = await decide({ repositoryIsPublic: true, probePackage: async () => PRESENT, probeVisibility: vis(true) })
    expect('公开 + 已存在 + registry 说 public ⇒ 带', d.provenance, true)
    expect('公开 + 已存在 + registry 说 public ⇒ packageState=present', d.packageState, 'present')
  }
  // ④ 公开 + 包存在但 registry 说不是 public ⇒ 不带
  {
    const d = await decide({ repositoryIsPublic: true, probePackage: async () => PRESENT, probeVisibility: vis(false) })
    expect('公开 + 已存在但 registry 说非 public ⇒ 不带', d.provenance, false)
  }
  // ⑤ 查不到 ⇒ 不带（宁可少一个徽章，也不让整个发布失败）
  {
    const d = await decide({ repositoryIsPublic: true, probePackage: async () => UNKNOWN })
    expect('查不到 registry ⇒ 不带', d.provenance, false)
    expect('查不到 registry ⇒ packageState=unknown', d.packageState, 'unknown')
  }
  // ⑥ registry 路径编码（scoped 包的斜杠要编码成 %2f）
  expect('scoped 包名：斜杠编码成 %2f', registryPath('@scope/pkg'), '/@scope%2fpkg')
  expect('非 scoped 包名：原样', registryPath('plain-pkg'), '/plain-pkg')

  if (failures > 0) {
    console.error(`\nselftest FAILED: ${failures} assertion(s)`)
    process.exit(2)
  }
  console.log('\nselftest OK — 判定表的五行都判对了（不联网）')
}

/* ── CLI ────────────────────────────────────────────────────────────────── */

function repoPackageName() {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  return manifest.name
}

/**
 * 只在「本文件被直接执行」时才跑 CLI —— 被别的脚本 import 时不该打印东西。
 *
 * 判据用 `import.meta.url` 对比 argv[1] 的 file URL（Windows 上 argv[1] 是路径，
 * `pathToFileURL` 才能正确转）。
 */
function isEntryPoint() {
  if (!process.argv[1]) return false
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  const args = process.argv.slice(2)
  if (args.includes('--selftest')) {
    console.log('registry-version --selftest')
    await selftest()
    process.exit(0)
  }
  if (args.length > 0 && (args.includes('--help') || args.includes('-h'))) {
    console.log('usage: node scripts/registry-version.mjs [--selftest] [<pkg> [<version>]]')
    console.log('  不带参数 ⇒ 查本仓 package.json#name')
    console.log('  --selftest ⇒ 判定表自证（不联网）')
    process.exit(0)
  }

  const name = args[0] ?? repoPackageName()
  const version = args[1]

  const pkg = await probePackage(name)
  const out = { name, packageState: pkg.state, versions: pkg.versions }
  if (version) {
    const v = await probeVersion(name, version)
    out.version = version
    out.versionState = v.state
  }
  const vis = await probeVisibility(name)
  out.public = vis.public

  console.log(JSON.stringify(out, null, 2))
  if (pkg.state === 'unknown') {
    console.error(`\nregistry 不可达：${pkg.error ?? '未知错误'}（网络失败不算发布失败）`)
  }
}
