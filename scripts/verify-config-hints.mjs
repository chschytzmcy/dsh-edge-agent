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
  return extractHintByMarker(text, '本轮 intent 判定为 LOCAL')
}

/**
 * §7.210: 同一份抽取逻辑，按**标记**取某一段报错文案。
 *
 * 为什么要有第二个标记：input-guard 现在有**两处**用户可见的 fail-closed
 * 提示 —— 「本地路由不可用」（§7.159，抽取靠「本轮 intent 判定为 LOCAL」）
 * 与「本地池是 DELEGATE、要求直连端点」（§7.210，抽取靠「本地池处于 DELEGATE
 * 模式」）。两处都要受同一套「配置指引不许误导」的纪律约束。
 *
 * @param {string} text
 * @param {string} marker 出现在报错文案里的字面量
 * @returns {string|null}
 */
export function extractHintByMarker(text, marker) {
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
 * §7.210: DELEGATE 严格档（`llm.local.requireLocalEndpoint`）的提示文案。
 *
 * 与 §7.159 那段**同一套纪律**（文件优先、点名 llm.local / secrets、
 * keyRef 不许说成环境变量名），外加一条**这个功能特有的**：
 * 必须点名 `requireLocalEndpoint` —— operator 读到的必须是「改哪个开关」，
 * 而不是一段没有落点的说明。
 */
export function auditDelegateHint(hint) {
  const failures = auditHint(hint)
  if (!hint) return failures
  if (!hint.includes('requireLocalEndpoint')) {
    failures.push('报错文案没有点名 requireLocalEndpoint —— operator 读完不知道要改哪个开关')
  }
  return failures
}

/**
 * §7.210: 配置模板里必须有 `llm.local.requireLocalEndpoint`，且默认 **false**。
 *
 * 为什么盯默认值：这个开关**默认开着**就等于把默认部署（本地池留空 = DELEGATE）
 * 全部拒收 ⇒ 边缘模式全线不可用。默认 false ⇒ 零行为变化。
 * ⇒ 「默认是 false」这件事必须有一道门禁钉住，不能只靠代码里的 `?? false`。
 */
export function auditEdgeExample(files) {
  const failures = []
  const example = files.find((f) => f.rel === 'config/edge.example.json')
  if (!example) {
    failures.push('缺少 config/edge.example.json —— operator 照着抄的那份模板里没有这个开关')
    return failures
  }
  let parsed
  try {
    parsed = JSON.parse(example.text)
  } catch (e) {
    failures.push(`config/edge.example.json 不是合法 JSON：${String(e?.message ?? e)}`)
    return failures
  }
  const value = parsed?.llm?.local?.requireLocalEndpoint
  if (value === undefined) {
    failures.push('config/edge.example.json 的 llm.local 段没有 requireLocalEndpoint —— '
      + 'operator 照着抄模板时看不到这个开关')
  } else if (value !== false) {
    failures.push(`config/edge.example.json 的 llm.local.requireLocalEndpoint 是 ${JSON.stringify(value)} —— `
      + '默认必须是 false（默认开着会把「本地池留空 = DELEGATE」的默认部署全部拒收）')
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

  // 7. §7.210：DELEGATE 严格档那段提示。
  {
    const GOOD_DELEGATE = [
      'throw new Error(',
      '  `input-guard: 本轮 intent 判定为 LOCAL，但本地池处于 DELEGATE 模式`',
      '  + `请配置本地 LLM 端点：编辑 ~/.dsh-edge-agent/edge.json 的 llm.local 段，`',
      '  + `填 baseUrl（OpenAI 兼容端点，必须含 /v1）与 model；`',
      '  + `端点需要鉴权时，把密钥写进同一文件的 secrets 段，`',
      '  + `并把 llm.local.keyRef 指向那个键名（keyRef 是 secrets 里的键名，不是环境变量名）。`',
      '  + `（要恢复旧语义，把 llm.local.requireLocalEndpoint 设为 false。）`,',
      ')',
    ].join('\n')
    expect('DELEGATE 提示正确 ⇒ 无失败', auditDelegateHint(extractHintByMarker(GOOD_DELEGATE, '本地池处于 DELEGATE 模式')).length, 0)
    expect(
      'DELEGATE 提示不点名 requireLocalEndpoint ⇒ 报失败',
      auditDelegateHint(extractHintByMarker(GOOD_DELEGATE.replace('llm.local.requireLocalEndpoint', '那个开关'), '本地池处于 DELEGATE 模式')).length > 0,
      true,
    )
    expect(
      'DELEGATE 提示缺 edge.json 指引 ⇒ 报失败',
      auditDelegateHint(extractHintByMarker(GOOD_DELEGATE.replace('~/.dsh-edge-agent/edge.json', '配置文件'), '本地池处于 DELEGATE 模式')).length > 0,
      true,
    )
    expect(
      'DELEGATE 提示找不着 ⇒ 报失败',
      auditDelegateHint(extractHintByMarker('这里没有 throw new Error(', '本地池处于 DELEGATE 模式')).length > 0,
      true,
    )
  }

  // 8. §7.210：模板里的默认值必须是 false。
  {
    const mkExample = (v) => JSON.stringify({ llm: { local: { requireLocalEndpoint: v } } })
    expect('模板缺这个键 ⇒ 报失败', auditEdgeExample([{ rel: 'config/edge.example.json', text: JSON.stringify({ llm: { local: {} } }) }]).length > 0, true)
    expect('模板默认 true ⇒ 报失败', auditEdgeExample([{ rel: 'config/edge.example.json', text: mkExample(true) }]).length > 0, true)
    expect('模板默认 false ⇒ 无失败', auditEdgeExample([{ rel: 'config/edge.example.json', text: mkExample(false) }]).length, 0)
    expect('模板文件缺失 ⇒ 报失败', auditEdgeExample([]).length > 0, true)
  }

  if (failures > 0) {
    console.error(`\nselftest FAILED: ${failures} assertion(s)`)
    process.exit(2)
  }
  console.log('\nselftest OK — 门禁能抓住把用户指向进程 env 的旧文案，也能放过指向配置文件的正确文案；'
    + '并能抓住 §7.210 的 DELEGATE 严格档提示漏点名开关、模板默认值被改成 true')
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
  // §7.210: DELEGATE 严格档那段提示也受同一套纪律约束。
  const delegateHintFailures = auditDelegateHint(
    extractHintByMarker(hintText, '本地池处于 DELEGATE 模式'),
  )
  const srcFiles = walk(SRC, (p) => p.endsWith('.ts') && !p.endsWith('.d.ts'))
  const envFailures = auditSrcEnvMentions(srcFiles)
  const docFiles = walk(DOCS, (p) => p.endsWith('.md'))
  const docFailures = auditDocs(docFiles)
  // §7.210: 模板里的默认值（false）必须有门禁钉住。
  const examplePath = join(ROOT, 'config', 'edge.example.json')
  const exampleFiles = existsSync(examplePath)
    ? [{ rel: 'config/edge.example.json', text: readFileSync(examplePath, 'utf8') }]
    : []
  const exampleFailures = auditEdgeExample(exampleFiles)

  const all = [
    ...hintFailures,
    ...delegateHintFailures,
    ...envFailures,
    ...docFailures,
    ...exampleFailures,
  ]
  if (all.length > 0) {
    console.error('verify-config-hints: 用户可见的配置提示有误导：')
    for (const f of all) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log(
    `verify-config-hints OK (hint: ${HINT_FILE.slice(ROOT.length + 1)}；src 扫描 ${srcFiles.length} 个文件；docs 扫描 ${docFiles.length} 个文件)`,
  )
}
