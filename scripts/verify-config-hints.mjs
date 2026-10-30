// scripts/verify-config-hints.mjs — §7.159: the gate on USER-VISIBLE config hints.
//
// ## The failure it exists to prevent
//
// On 2026-10-30 the edge-mode fail-closed error told the operator:
//
//   请配置本地 LLM 端点（设置 DSH_EDGE_LOCAL_LLM_BASEURL；若端点需要鉴权，
//   再用 DSH_EDGE_LOCAL_LLM_KEY_ENV 指定存放密钥的环境变量名）后重试。
//
// Two things were wrong, and BOTH of them cost the operator a whole round-trip:
//
//   1. It pointed at process environment variables. Since §7.102 the pool
//      lives in `config/edge.json` (`llm.local.*`), and the desktop GUI starts
//      the host WITHOUT sourcing any .env — so `process.env` has no
//      DSH_EDGE_* at all. Measured on a clean Windows device: the operator
//      followed the hint, set the env var, and the route still did not
//      register (the local-LLM route is registered ONLY from the file).
//
//   2. It called `keyRef` "an env-slot name". Since §7.102 `keyRef` is the
//      LITERAL key under the same file's `secrets` section. Setting
//      `DSH_EDGE_LOCAL_LLM_KEY_ENV=<name>` then looks right but resolves to
//      a secrets lookup that does not exist.
//
// So this gate pins two things:
//   · the fail-closed hint names the FILE and the `llm.local` / `secrets`
//     keys, and does not describe keyRef as an env-slot name;
//   · any USER-VISIBLE (template-literal) mention of the legacy env vars in
//     src/ sits next to the file-based instruction.
//
// Plus a documentation half: a bundle that is handed to a machine with no
// configuration yet must come with instructions, or "install the tarball" is
// a dead end.
//
// Run via:
//   node scripts/verify-config-hints.mjs             # audit the real tree
//   node scripts/verify-config-hints.mjs --selftest  # self-proof + refutation
//
// Exit codes: 0 = pass; 1 = a hint is misleading; 2 = selftest failed.
//
// Read-only: writes nothing inside the repository.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src')
const DOCS = join(ROOT, 'docs')

/** The fail-closed hint lives here. */
const HINT_FILE = join(SRC, 'dsh-adapter', 'input-guard.ts')

/** Legacy env names that must no longer be the FIRST thing a user is told. */
const LEGACY_ENV = ['DSH_EDGE_LOCAL_LLM_BASEURL', 'DSH_EDGE_LOCAL_LLM_KEY_ENV']

/** Phrases that describe keyRef with the pre-§7.102 (env-slot) semantics. */
const STALE_KEYREF_PHRASES = ['指定存放密钥的环境变量名', '存放密钥的环境变量']

/**
 * Extract the user-visible fail-closed hint from input-guard.ts.
 *
 * It is a template literal thrown as `new Error(...)`. The end of the call is
 * found by bracket balancing (ASCII parens only — the Chinese text uses
 * full-width ones) so the extraction does not depend on any wording inside
 * the message.
 */
export function extractHint(text) {
  const marker = '本轮 intent 判定为 LOCAL'
  const at = text.indexOf(marker)
  if (at < 0) return null
  const start = text.lastIndexOf('throw new Error(', at)
  if (start < 0) return null
  const open = text.indexOf('(', start)
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const ch = text[i]
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return text.slice(start, start + 2000)
}

/**
 * Audit the hint text.
 *
 * @param {string|null} hint
 * @returns {string[]} failures
 */
export function auditHint(hint) {
  const failures = []
  if (!hint) {
    failures.push('找不到 fail-closed 报错文案（input-guard.ts 里没有「本轮 intent 判定为 LOCAL」）')
    return failures
  }
  if (!hint.includes('~/.dsh-edge-agent/edge.json')) {
    failures.push('报错文案没有指向 ~/.dsh-edge-agent/edge.json —— 桌面 GUI 读不到进程 env，用户照着 env 提示做会白做')
  }
  if (!hint.includes('llm.local')) {
    failures.push('报错文案没有点名 llm.local 段（baseUrl / model 在那里）')
  }
  if (!hint.includes('secrets')) {
    failures.push('报错文案没有提到 secrets 段 —— 端点要鉴权时密钥写在那里')
  }
  for (const phrase of STALE_KEYREF_PHRASES) {
    if (hint.includes(phrase)) {
      failures.push(`报错文案仍把 keyRef 说成「${phrase}」—— §7.102 起它是 secrets 里的键名，不是环境变量名`)
    }
  }
  // The env vars may still be mentioned as a fallback, but never as the only
  // way: the file instruction has to be there too (checked above), and the
  // wording must not tell the user to SET them.
  for (const env of LEGACY_ENV) {
    if (hint.includes(env) && /设置\s*`?DSH_EDGE_/.test(hint)) {
      failures.push(`报错文案把 ${env} 写成「设置」步骤 —— 桌面 GUI 启动的宿主读不到进程 env`)
    }
  }
  return failures
}

/**
 * Every USER-VISIBLE (template-literal) mention of a legacy env var in src/
 * must sit next to the file-based instruction.
 */
export function auditSrcEnvMentions(files) {
  const failures = []
  for (const { rel, text } of files) {
    const lines = text.split(/\r?\n/u)
    lines.forEach((line, i) => {
      const mentions = LEGACY_ENV.filter((e) => line.includes(e))
      if (mentions.length === 0) return
      // A COMMENT that quotes the legacy name is documentation, not a hint —
      // edge-config.ts's file header explains the whole env→file migration
      // and must keep naming the old variables. Only real code can reach the
      // user.
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('#')) return
      // Only a template literal (backtick) can reach the user. The internal
      // ENV_OVERRIDES table uses plain quotes — that is implementation, not a
      // hint, and it is allowed to name the env var.
      if (!line.includes('`')) return
      const around = lines.slice(Math.max(0, i - 6), i + 7).join('\n')
      if (!around.includes('edge.json')) {
        failures.push(
          `${rel}:${i + 1} 用户可见文案提到 ${mentions.join('/')}，但同段没有指向 edge.json 的配置入口`,
        )
      }
    })
  }
  return failures
}

/**
 * The tarball guide must tell a fresh machine how to configure itself.
 */
export function auditDocs(files) {
  const failures = []
  const tarball = files.find((f) => f.rel === 'docs/deploy-tarball.md')
  if (!tarball) {
    failures.push('缺少 docs/deploy-tarball.md')
    return failures
  }
  if (!tarball.text.includes('~/.dsh-edge-agent/edge.json')) {
    failures.push('docs/deploy-tarball.md 没写配置落位 ~/.dsh-edge-agent/edge.json —— 拿到 tarball 的机器不知道去哪儿填端点')
  }
  if (!tarball.text.includes('llm.local')) {
    failures.push('docs/deploy-tarball.md 没写 llm.local 段 —— 没有本地端点时边缘模式会被隐私裁决拦下（§7.159 实测）')
  }
  return failures
}

/* ── self-proof + refutation ───────────────────────────────────────────── */

function selftest() {
  let failures = 0
  const expect = (label, actual, wanted) => {
    const ok = Array.isArray(actual) ? actual.length === wanted : actual === wanted
    if (!ok) failures++
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label} — expected ${wanted}, got ${Array.isArray(actual) ? actual.length : actual}${Array.isArray(actual) && actual.length ? ` (${actual[0]})` : ''}`)
  }

  const GOOD = [
    'throw new Error(',
    '  `input-guard: 本轮 intent 判定为 LOCAL，按隐私裁决必须使用本地模型，`',
    '  + `请配置本地 LLM 端点：编辑 ~/.dsh-edge-agent/edge.json 的 llm.local 段，`',
    '  + `填 baseUrl（OpenAI 兼容端点，必须含 /v1）与 model；`',
    '  + `端点需要鉴权时，把密钥写进同一文件的 secrets 段，`',
    '  + `并把 llm.local.keyRef 指向那个键名（keyRef 是 secrets 里的键名，不是环境变量名）。`',
    '  + `若能设置进程环境变量，也可用 DSH_EDGE_LOCAL_LLM_BASEURL / DSH_EDGE_LOCAL_LLM_MODEL / `',
    '  + `DSH_EDGE_LOCAL_LLM_KEY_ENV 覆盖，但桌面 GUI 启动的宿主读不到它们。`,',
    ')',
  ].join('\n')

  const OLD = [
    'throw new Error(',
    '  `input-guard: 本轮 intent 判定为 LOCAL，按隐私裁决必须使用本地模型，`',
    '  + `请配置本地 LLM 端点（设置 DSH_EDGE_LOCAL_LLM_BASEURL；若端点需要鉴权，`',
    '  + `再用 DSH_EDGE_LOCAL_LLM_KEY_ENV 指定存放密钥的环境变量名）后重试。`,',
    ')',
  ].join('\n')

  console.log('verify-config-hints --selftest')

  // 1. the current shape passes.
  expect('正确文案 ⇒ 无失败', auditHint(extractHint(GOOD)), 0)

  // 2. the pre-§7.159 shape is caught — and for BOTH reasons.
  {
    const f = auditHint(extractHint(OLD))
    expect('旧文案 ⇒ 报失败', f.length > 0, true)
    expect('旧文案被指为缺 edge.json 指引', f.some((x) => x.includes('edge.json')), true)
    expect('旧文案被指为 keyRef 语义过时', f.some((x) => x.includes('键名')), true)
  }

  // 3. a hint that names the env var as the way to set it is caught.
  {
    const f = auditHint(extractHint(GOOD.replace('若能设置进程环境变量，也可用', '请设置 DSH_EDGE_LOCAL_LLM_BASEURL 环境变量，也可用')))
    expect('把 env 写成「设置」步骤 ⇒ 报失败', f.length > 0, true)
  }

  // 4. a user-visible env mention without the file instruction nearby.
  expect(
    'src 里孤立的 env 提示 ⇒ 报失败',
    auditSrcEnvMentions([{ rel: 'x.ts', text: 'const hint = `请设置 DSH_EDGE_LOCAL_LLM_BASEURL 后重试`\n' }]).length > 0,
    true,
  )

  // 5. the internal ENV_OVERRIDES table is NOT a hint ⇒ allowed.
  expect(
    '内部实现里的 env 名（普通引号）⇒ 不报',
    auditSrcEnvMentions([{ rel: 'y.ts', text: "    env: 'DSH_EDGE_LOCAL_LLM_BASEURL',\n" }]).length,
    0,
  )

  // 6. docs must carry the fresh-machine instructions.
  expect(
    '文档缺 llm.local ⇒ 报失败',
    auditDocs([{ rel: 'docs/deploy-tarball.md', text: 'nothing useful' }]).length > 0,
    true,
  )
  expect(
    '文档齐全 ⇒ 无失败',
    auditDocs([{ rel: 'docs/deploy-tarball.md', text: '~/.dsh-edge-agent/edge.json 与 llm.local 都在' }]).length,
    0,
  )

  if (failures > 0) {
    console.error(`\nselftest FAILED: ${failures} assertion(s)`)
    process.exit(2)
  }
  console.log('\nselftest OK — 门禁能抓住把用户指向进程 env 的旧文案，也能放过指向配置文件的正确文案')
}

/* ── entry ───────────────────────────────────────────────────────────────── */

const args = process.argv.slice(2)
if (args.includes('--selftest')) {
  selftest()
} else if (args.length > 0) {
  console.error('usage: node scripts/verify-config-hints.mjs [--selftest]')
  process.exit(2)
} else {
  // `require` inside an ESM module is not available — use the static import.
  const { readdirSync: rd, statSync: st } = await import('node:fs')
  const walk = (dir, filter, acc = []) => {
    if (!existsSync(dir)) return acc
    for (const entry of rd(dir)) {
      const p = join(dir, entry)
      if (st(p).isDirectory()) walk(p, filter, acc)
      else if (filter(p)) acc.push({ rel: p.slice(ROOT.length + 1).replace(/\\/gu, '/'), text: readFileSync(p, 'utf8') })
    }
    return acc
  }

  const hintText = readFileSync(HINT_FILE, 'utf8')
  const hintFailures = auditHint(extractHint(hintText))
  const srcFiles = walk(SRC, (p) => p.endsWith('.ts') && !p.endsWith('.d.ts'))
  const envFailures = auditSrcEnvMentions(srcFiles)
  const docFiles = walk(DOCS, (p) => p.endsWith('.md'))
  const docFailures = auditDocs(docFiles)

  const all = [...hintFailures, ...envFailures, ...docFailures]
  if (all.length > 0) {
    console.error('verify-config-hints: 用户可见的配置提示有误导：')
    for (const f of all) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log(
    `verify-config-hints OK (hint: ${HINT_FILE.slice(ROOT.length + 1)}；src 扫描 ${srcFiles.length} 个文件；docs 扫描 ${docFiles.length} 个文件)`,
  )
}
