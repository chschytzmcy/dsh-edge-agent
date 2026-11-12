/**
 * npm pack dry-run verifier: runs `npm pack --dry-run --json` and checks
 * the resulting file list against the manifest's `exports`, `main`,
 * `types`, and `bin` entries.
 *
 * Reads stdin (npm pack's JSON output) so the caller can pipe it.
 *
 * Run via:
 *   npm pack --dry-run --json --ignore-scripts | node scripts/verify-package.mjs
 *   node scripts/verify-package.mjs --selftest      # 只跑自证
 *
 * §7.196 (2026-11-12): **不能假设 npm pack 的 stdout 是纯 JSON**。
 *
 * 这道门禁此前直接把整条 stdin 当 JSON 解析（`JSON.parse(input)`）⇒ 同一道门禁
 * 在本机全绿、在 CI 全红。根因是 npm 版本差异（源码级，已核对）：
 *
 *   - npm 10.9.4（Node 22.20 自带，**CI 用的就是这个**）：
 *     `pacote/lib/dir.js` 的 `DirFetcher.#prepareDir()` **完全不看 `ignoreScripts`** ——
 *     只要 `package.json` 里有 `scripts.prepare` 就照跑不误 ⇒
 *     `npm pack --dry-run --json --ignore-scripts` 里的 `--ignore-scripts` **形同虚设**，
 *     `prepare`（= `node scripts/run.mjs compile build:client`）的 stdout 混进同一条流。
 *   - npm 11.6.2（本机，Node 24.13 自带）：同一处多了一行
 *     `if (this.opts.ignoreScripts) { return }` ⇒ prepare 不跑 ⇒ stdout 干净 ⇒ 门禁通过。
 *
 * ⇒ **同一个 `--ignore-scripts`，两代 npm 的行为不一样** ⇒ 这就是「本地全绿、CI 全红」。
 *
 * 修法：**不再假设 stdout 是纯 JSON**，而是在里面找「第一个能解析、且长得像 pack
 * 报告」的 JSON 值；找不到就抛错（fail-closed），绝不猜、绝不拿半截数据糊过去。
 * 自证（`--selftest`）把 npm 10 的噪声形状、伪装成 JSON 的噪声行、纯垃圾三种情况
 * 都钉住 —— 门禁自己必须先证明「它不会被噪声骗过」。
 *
 * 附带效果：npm 10 上 prepare 仍会跑（拦不住，upstream 的行为），于是门禁期间
 * `lib/` 会被重编译一次（clean-lib + tsc + build:client）—— 内容与构建链产出
 * 一致，链内后续门禁读 `lib/`/`dist/` 不受影响。
 */
import { readFile } from 'node:fs/promises'

import { configShipViolations, describeConfigViolation } from './_config-ship-policy.mjs'

/**
 * 从 `start` 处的 `[` 或 `{` 起，找到配对的结束位置。
 *
 * 尊重字符串字面量与转义（JSON 里 `"a]b"` 不能把括号计数带偏）。
 * 找不到配对 ⇒ 返回 -1。
 */
function findJsonEnd(text, start) {
  const open = text[start]
  const close = open === '[' ? ']' : '}'
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) { escaped = false; continue }
      if (ch === '\\') { escaped = true; continue }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * 从一段「可能混着 lifecycle 噪声」的输出里抠出 npm pack 的报告。
 *
 * 判据不是「能解析就行」，而是「能解析 **且** 长得像 pack 报告」——
 * 噪声里可能混着 `[1,2,3]` 这种合法 JSON 数组，它不是报告，得跳过。
 *
 * @param {string} text npm pack 的原始 stdout
 * @returns {{ files: Array<{ path: string }> }}
 */
export function extractPackReport(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) throw new Error('npm pack 没有输出任何东西')
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (ch !== '[' && ch !== '{') continue
    const end = findJsonEnd(trimmed, i)
    if (end < 0) continue
    let value
    try {
      value = JSON.parse(trimmed.slice(i, end + 1))
    } catch {
      continue // 不是合法 JSON ⇒ 试下一个起点
    }
    const report = Array.isArray(value)
      ? value[0]
      : (value && typeof value === 'object' ? Object.values(value)[0] : undefined)
    if (report && Array.isArray(report.files)) return report
  }
  throw new Error(
    'npm pack did not return a package file list'
    + `（输出里既没有可解析的 JSON，也没有长得像 pack 报告的段落；收到的前 200 字：${JSON.stringify(trimmed.slice(0, 200))}）`,
  )
}

/* ── 自证：门禁自己必须先证明「不会被噪声骗过」 ───────────────────────── */

function selftest() {
  let failures = 0
  const expect = (label, actual, wanted) => {
    const ok = actual === wanted
    if (!ok) failures++
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label} — expected ${wanted}, got ${actual}`)
  }
  const throws = (fn) => {
    try { fn(); return false } catch { return true }
  }

  const clean = JSON.stringify([
    { id: 'x@1.0.0', files: [{ path: 'lib/index.js' }, { path: 'lib/client.js' }] },
  ])

  // 1) 纯 JSON（npm 11 的形状：prepare 不跑）
  expect('纯 JSON ⇒ 抠出报告', extractPackReport(clean).files.length, 2)

  // 2) npm 10 的形状：prepare 脚本的 stdout 排在 JSON 前面（CI 实测形状）
  const npm10 = [
    '> compile: node scripts/clean-lib.mjs && tsc -p tsconfig.json',
    'cleaned /home/runner/work/dsh-edge-agent/dsh-edge-agent/lib/',
    '> build:client: node scripts/build-client.mjs',
    '[build-client] lib/client.js = 52 KB (module-loader format, id=@dsh-edge/dsh-edge-agent)',
    clean,
  ].join('\n')
  expect('npm 10 噪声 + JSON ⇒ 抠出报告', extractPackReport(npm10).files.length, 2)

  // 3) JSON 后面还有噪声
  expect('JSON 之后有噪声 ⇒ 仍抠出报告', extractPackReport(`${clean}\n> done\n`).files.length, 2)

  // 4) 对象形状（npm 对 publish 用对象形，pack 用数组形，两种都认）
  const obj = JSON.stringify({ 'x@1.0.0': { files: [{ path: 'lib/index.js' }] } })
  expect('对象形状 ⇒ 抠出报告', extractPackReport(obj).files.length, 1)

  // 5) 噪声里混着合法 JSON 数组 ⇒ 不能把它当报告
  expect('噪声里有合法 JSON 数组 ⇒ 仍取真报告', extractPackReport(`[1,2,3]\n${clean}`).files.length, 2)

  // 6) 纯垃圾 / 空 ⇒ fail-closed（抛错，不猜）
  expect('纯垃圾 ⇒ 抛错', throws(() => extractPackReport('npm ERR! something went wrong\n')), true)
  expect('空输出 ⇒ 抛错', throws(() => extractPackReport('   ')), true)

  return failures
}

/* ── 入口 ──────────────────────────────────────────────────────────────── */

const args = process.argv.slice(2)

if (args.includes('--selftest')) {
  console.log('verify-package --selftest')
  const failures = selftest()
  if (failures > 0) {
    console.error(`\nselftest FAILED: ${failures} assertion(s)`)
    process.exit(2)
  }
  console.log('\nselftest OK — npm 10 的 prepare 噪声能抠出来，纯垃圾会 fail-closed')
  process.exit(0)
}

// 自证先跑（纯内存、毫秒级）—— 这道门禁的解析逻辑必须每次都被证明一遍。
{
  const failures = selftest()
  if (failures > 0) {
    console.error(`verify-package: selftest FAILED (${failures} assertion(s))`)
    process.exit(2)
  }
  console.log('verify-package selftest OK')
}

const input = await new Promise((resolve, reject) => {
  let value = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => { value += chunk })
  process.stdin.on('end', () => resolve(value))
  process.stdin.on('error', reject)
})

const report = extractPackReport(input)

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const packed = new Set(report.files.map((file) => file.path.replaceAll('\\', '/')))
const targets = new Set()

const addTarget = (value) => {
  if (typeof value === 'string') targets.add(value.replace(/^\.\//u, ''))
}

addTarget(manifest.main)
addTarget(manifest.types)
for (const target of Object.values(manifest.bin ?? {})) addTarget(target)

const collectExports = (value) => {
  if (typeof value === 'string') {
    addTarget(value)
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const nested of Object.values(value)) collectExports(nested)
}
collectExports(manifest.exports)

const missing = [...targets].filter((target) => !packed.has(target))
if (missing.length > 0) {
  throw new Error(`package exports missing from tarball: ${missing.join(', ')}`)
}

if ([...packed].some((path) => path.startsWith('src/'))) {
  throw new Error('npm package unexpectedly contains TypeScript sources')
}
if (packed.has('lib/invariant.js')) {
  throw new Error('npm package contains the obsolete hand-built invariant entry')
}

// §7.102 security: the runtime config holds the plaintext provider keys
// (deepseek / dashscope / tavily / bocha / edge). It must never reach a
// distributable tarball.
//
// The subtlety this guard exists for: npm pack honours .npmignore INSTEAD
// of .gitignore whenever .npmignore exists — so the `config/edge.json`
// rule in .gitignore does NOT keep the file out of the package. The
// .npmignore rule does; this gate proves it still holds.
//
// config/edge.example.json (the template) and config/privacy-policy.json
// are expected to ship.
const FORBIDDEN_IN_PACKAGE = [
  'config/edge.json',
  '.env',
  '.env.sh',
  '.env.example',
]
const leaked = FORBIDDEN_IN_PACKAGE.filter((path) => packed.has(path))
if (leaked.length > 0) {
  throw new Error(
    `package would ship plaintext credentials: ${leaked.join(', ')}. `
    + 'Add them to .npmignore (npm pack ignores .gitignore when .npmignore exists).',
  )
}

// §7.189: the exact-name list above cannot see the live config's BACKUP —
// `config/edge.json.bak-<timestamp>` carries the same plaintext keys (measured
// 2026-11-11: 5 real API keys) and slips past any `config/edge.json` rule —
// nor editor junk like `config/.DS_Store`. Check the whole config/ subtree
// against the shipping allowlist instead.
const configViolations = configShipViolations([...packed])
if (configViolations.length > 0) {
  throw new Error(
    `package would ship ${configViolations.map((v) => describeConfigViolation(v)).join('；')}. `
    + 'Add them to .npmignore (npm pack ignores .gitignore when .npmignore exists).',
  )
}

await import(new URL(`../${manifest.main}`, import.meta.url))
const invariant = await import(new URL('../lib/dsh-adapter/invariant.js', import.meta.url))
if (invariant.name !== 'dsh-edge-agent-invariant' || typeof invariant.apply !== 'function') {
  throw new Error('compiled invariant entry does not expose the expected contract')
}

console.log(`package surface OK (${packed.size} files, ${targets.size} entry targets)`)
