// scripts/verify-doc-gate-count.mjs — §7.208: 文档里写的门禁数必须等于链内实际道数。
//
// ## 它防的是什么
//
// 门禁链每加一道，文档里的「N 道门禁」就会变成一个**没人维护的承诺**。
// §7.208 实测（2026-11-12）：链里的道数与文档里写的**对不上** —— docs/ 里有 8 处、
// `scripts/publish-npm.mjs` 里还有 4 处（那 4 处是主人每次发版都会看到的终端输出），
// 而且全仓搜「与链长一致的那个数」是 **0 命中** ⇒ 从来没有一份文档写对过这个数。
//
// 为什么没人发现？因为现有门禁里没有一道管「数字口径」：
//   · `verify:doc-links` 只查文档树的**可达性 + 断链**；
//   · `verify:ci-build-chain` 只查**构建链**的步骤完整性；
//   · 其余各道门禁查的是**产物**。
// ⇒ 「文档里写的数字与实际一致」这件事**结构性无人看守**。
//
// ## 门禁不扫自己
//
// 本文件的自证 fixture 里**故意**写着错的数（29 / 3 之类）⇒ 它把自己排除在扫描范围外。
//
// ## 口径
//
//   · **总数主张**：出现「N 道/项/个门禁」或「门禁 … N 道/项/个」⇒ N 必须等于链长。
//   · **位次主张**：出现「第 N 道/位/项」且**点名了某个门禁**⇒ 该门禁在链里的
//     实际位次必须等于 N。
//   · 出现「第 N …」但**没点名门禁** ⇒ 无法核对，记一条 note，不算失败
//     （「第 16 道门禁」这类历史叙述不该把门禁打红）。
//
// ## 扫描范围（有意收窄）
//
//   · `docs/*.md`（**顶层**）+ `README.md` + `scripts/*.mjs`（顶层）
//     + `.github/workflows/*.yml`
//   · **排除**（附理由，理由写在这里就是为了让人能推翻它）：
//     - `docs/PROGRESS.md` —— §7.x 历史记录，门禁数随时间变，历史值合法；
//     - `docs/TEST-REPORT.md` —— 历史测试报告，记录的是当时的门禁数。
//   · `docs/` 的**子目录**（bench/ dev-notes/ decisions/ snapshots/）不扫：
//     它们是专项材料，数字口径各不相同。
//
// Run via:
//   node scripts/verify-doc-gate-count.mjs             # audit the real tree
//   node scripts/verify-doc-gate-count.mjs --selftest  # self-proof + refutation
//
// Exit codes: 0 = pass; 1 = a claim is wrong; 2 = selftest failed.
//
// Read-only: writes nothing inside the repository.

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')

/** 不扫描的文件 + 理由（理由要能被推翻 ⇒ 必须写清楚为什么排除） */
const EXCLUDE_REASON = {
  'PROGRESS.md': '§7.x 历史记录 —— 门禁数随时间变，历史值合法',
  'TEST-REPORT.md': '历史测试报告 —— 记录的是当时的门禁数',
}

/** 本门禁自己不扫自己：它的自证 fixture 里**故意**写着错的数字 */
const SELF_NAME = 'verify-doc-gate-count.mjs'

/* ── 链 ───────────────────────────────────────────────────────────────────── */

/**
 * 链内门禁，顺序 = `package.json#scripts['verify:build']` 里 `run.mjs` 之后的
 * 实参顺序。**单一事实源就是 package.json** —— 本门禁不另存一份清单。
 */
export function gateChain(root = ROOT) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const cmd = pkg.scripts?.['verify:build']
  if (!cmd) throw new Error("package.json#scripts['verify:build'] 不存在")
  const m = /run\.mjs\s+(.+)$/.exec(cmd.trim())
  if (!m) throw new Error(`verify:build 不是 run.mjs 形态：${cmd}`)
  return m[1].trim().split(/\s+/).filter(Boolean)
}

/* ── 扫描范围 ─────────────────────────────────────────────────────────────── */

export function collectScanFiles(root = ROOT) {
  const out = []
  const docsDir = join(root, 'docs')
  if (existsSync(docsDir)) {
    for (const name of readdirSync(docsDir).sort()) {
      if (!name.endsWith('.md')) continue
      if (EXCLUDE_REASON[name]) continue
      out.push(join(docsDir, name))
    }
  }
  const scriptsDir = join(root, 'scripts')
  if (existsSync(scriptsDir)) {
    for (const name of readdirSync(scriptsDir).sort()) {
      if (!name.endsWith('.mjs')) continue
      if (name === SELF_NAME) continue // 自证 fixture 里故意写着错的数
      out.push(join(scriptsDir, name))
    }
  }
  const wfDir = join(root, '.github', 'workflows')
  if (existsSync(wfDir)) {
    for (const name of readdirSync(wfDir).sort()) {
      if (!/\.ya?ml$/.test(name)) continue
      out.push(join(wfDir, name))
    }
  }
  const readme = join(root, 'README.md')
  if (existsSync(readme)) out.push(readme)
  return out
}

/* ── 主张抽取 ─────────────────────────────────────────────────────────────── */

// 位次主张：「第 N 道 / 第 N 位 / 第 N 项」
const POS_RE = /第\s*(\d+)\s*(?:道|项|位)/g
// 总数主张（数字在前）：「29 道门禁」
const TOTAL_BEFORE_RE = /(\d+)\s*(?:道|项|个)\s*门禁/g
// 总数主张（门禁在前）：「全部门禁（…，29 项，…）」—— 中间允许标点与短句。
// 负向断言排除「门禁（9 项静态断言）」这类**量词指的不是门禁**的句子。
const TOTAL_AFTER_RE = /门禁[^。\n]{0,24}?(\d+)\s*(?:道|项|个)(?![^\n]{0,6}?(?:断言|自证|条|文件|处))/g
// 门禁名字（两种写法都认）
const GATE_RE = /(?:verify:[a-z0-9-]+|scripts\/verify-[a-z0-9-]+(?:\.(?:mjs|ts))?)/g

function normalizeGate(tok) {
  if (tok.startsWith('scripts/')) {
    return 'verify:' + tok.slice('scripts/verify-'.length).replace(/\.(?:mjs|ts)$/, '')
  }
  return tok
}

/** 某一行在全文里的 [起, 止) 区间 */
function lineRange(text, index) {
  const start = text.lastIndexOf('\n', index - 1) + 1
  let end = text.indexOf('\n', index)
  if (end < 0) end = text.length
  return [start, end]
}

function lineOf(text, index) {
  let line = 1
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++
  return line
}

/* ── 审计 ─────────────────────────────────────────────────────────────────── */

/**
 * 审计一个文本里的门禁数主张。
 *
 * @param {string} text   文件全文
 * @param {string[]} chain 链内门禁（顺序即位次）
 * @param {string} label  文件名（用于报错定位）
 */
export function auditText(text, chain, label = '<text>') {
  const failures = []
  const notes = []
  const chainIndex = new Map(chain.map((g, i) => [g, i + 1]))

  // ── 位次主张 ──
  const positions = []
  POS_RE.lastIndex = 0
  let m
  while ((m = POS_RE.exec(text)) !== null) {
    positions.push({ n: Number(m[1]), start: m.index, end: m.index + m[0].length })
  }

  const gates = []
  GATE_RE.lastIndex = 0
  while ((m = GATE_RE.exec(text)) !== null) {
    gates.push({
      name: normalizeGate(m[0]),
      start: m.index,
      end: m.index + m[0].length,
      center: m.index + m[0].length / 2,
    })
  }

  for (const p of positions) {
    // 位次主张只与**同一行**里最近的门禁名字配对。
    //
    // 为什么必须限同一行：实测（2026-11-12）第一版按「整篇文本就近配对」，
    // 结果 `docs/deploy-npm.md:273` 的「第 22 位」被**下一行**的
    // `verify:npm-publish` 认领 ⇒ 报了一条「位次写错」的假失败。
    // 位次主张是**逐句**的说法 ⇒ 配对也必须逐句。
    const [ls, le] = lineRange(text, p.start)
    const lineGates = gates.filter((g) => g.start >= ls && g.end <= le)
    if (lineGates.length === 0) {
      notes.push(`「第 ${p.n} …」同一行里没有门禁名字 ⇒ 无法核对位次（第 ${lineOf(text, p.start)} 行）`)
      continue
    }
    const pc = (p.start + p.end) / 2
    let g = lineGates[0]
    for (const cand of lineGates) {
      const d = Math.abs(cand.center - pc)
      const bd = Math.abs(g.center - pc)
      if (d < bd || (d === bd && cand.start > p.start)) g = cand
    }
    const actual = chainIndex.get(g.name)
    if (actual === undefined) {
      notes.push(`「第 ${p.n} …」点名 ${g.name}，但它不在 verify:build 链里 ⇒ 不核对（第 ${lineOf(text, p.start)} 行）`)
      continue
    }
    if (actual !== p.n) {
      failures.push(
        `${label}:${lineOf(text, p.start)} 位次写错 —— 文档说「第 ${p.n} 道」，`
        + `但链里 ${g.name} 实际是第 ${actual} 道`,
      )
    }
  }

  // ── 总数主张 ──
  // 先把位次主张挖掉（位次里的数字不是总数）
  let rest = text
  for (const p of positions) {
    rest = rest.slice(0, p.start) + ' '.repeat(p.end - p.start) + rest.slice(p.end)
  }
  const totals = []
  TOTAL_BEFORE_RE.lastIndex = 0
  while ((m = TOTAL_BEFORE_RE.exec(rest)) !== null) totals.push({ n: Number(m[1]), at: m.index })
  TOTAL_AFTER_RE.lastIndex = 0
  while ((m = TOTAL_AFTER_RE.exec(rest)) !== null) totals.push({ n: Number(m[1]), at: m.index })
  for (const { n, at } of totals) {
    if (n !== chain.length) {
      failures.push(
        `${label}:${lineOf(text, at)} 门禁总数写错 —— 文档说 ${n} 道，链里实际 ${chain.length} 道`,
      )
    }
  }

  return { failures, notes }
}

/** 审计整棵树（真实仓库用这个） */
export function auditRepo(root = ROOT) {
  const chain = gateChain(root)
  const files = collectScanFiles(root)
  const failures = []
  const notes = []
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const r = auditText(text, chain, relative(root, file).split('\\').join('/'))
    failures.push(...r.failures)
    notes.push(...r.notes)
  }
  return { chain, files, failures, notes }
}

/* ── self-proof + refutation ─────────────────────────────────────────────── */

function selftest() {
  let failures = 0
  const expect = (label, actual, wanted) => {
    const ok = actual === wanted
    if (!ok) failures++
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label} — expected ${wanted}, got ${actual}`)
  }

  const TMP = join(ROOT, 'dist', 'probe', 'doc-gate-count-selftest')
  if (existsSync(TMP)) {
    // 上一次自证留下的残渣（自证目录在 dist/probe 下，gitignored）
    rmSync(TMP, { recursive: true, force: true })
  }

  const CHAIN = ['verify:a', 'verify:b', 'verify:c']
  const mk = (name, body) => {
    const p = join(TMP, name)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, body)
    return p
  }

  console.log('verify-doc-gate-count --selftest')

  // 1. 正确的总数 ⇒ 无失败
  {
    const r = auditText('这条链一共 3 道门禁，跑完才发版。', CHAIN, 'x.md')
    expect('正确的总数 ⇒ 无失败', r.failures.length, 0)
  }

  // 2. 错误的总数 ⇒ 报失败，且点名行号
  {
    const r = auditText('这条链一共 29 道门禁，跑完才发版。', CHAIN, 'x.md')
    expect('错误的总数 ⇒ 报失败', r.failures.length, 1)
    expect('失败信息点出文件与行号', /x\.md:1/.test(r.failures[0] ?? ''), true)
    expect('失败信息同时给出链内真值', (r.failures[0] ?? '').includes('实际 3 道'), true)
  }

  // 3. 错误的位次 ⇒ 报失败
  {
    const r = auditText('`verify:npm-readiness`（链内第 29 位）', CHAIN, 'x.md')
    // verify:npm-readiness 不在这条假链里 ⇒ 只记 note，不算失败
    expect('链外的门禁名 ⇒ 不判失败', r.failures.length, 0)
    expect('链外的门禁名 ⇒ 记 note', r.notes.length > 0, true)
  }
  {
    const r = auditText('`verify:b`（链内第 5 位）', CHAIN, 'x.md')
    expect('链内门禁名 + 错误位次 ⇒ 报失败', r.failures.length, 1)
    expect('失败信息同时给出真实位次', (r.failures[0] ?? '').includes('第 2 道'), true)
  }
  {
    const r = auditText('`verify:c`（链内第 3 位）', CHAIN, 'x.md')
    expect('链内门禁名 + 正确位次 ⇒ 无失败', r.failures.length, 0)
  }

  // 4. 位次主张但没点名门禁 ⇒ 只记 note（历史叙述不该把门禁打红）
  {
    const r = auditText('新增第 16 道门禁。', CHAIN, 'x.md')
    expect('没点名门禁的位次 ⇒ 不判失败', r.failures.length, 0)
  }

  // 5. 无关的数字不该被当成主张（「29 个适配器插件」不是门禁数）
  {
    const r = auditText('本项目由 29 个适配器插件 + 1 个可选 http-api 组成。', CHAIN, 'x.md')
    expect('无关数字 ⇒ 不判失败', r.failures.length, 0)
  }

  // 6. 跨行的主张也能抓到（「… + 29 道\n门禁 …」这种断行）
  {
    const r = auditText('不能等构建链 + 29 道\n门禁跑完才失败。', CHAIN, 'x.md')
    expect('跨行的总数主张 ⇒ 报失败', r.failures.length, 1)
  }

  // 7. 整棵树：排除文件不参与扫描
  {
    const root = join(TMP, 'tree')
    mkdirSync(join(root, 'docs'), { recursive: true })
    mkdirSync(join(root, 'scripts'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      scripts: { 'verify:build': 'node scripts/run.mjs verify:a verify:b verify:c' },
    }))
    writeFileSync(join(root, 'docs', 'live.md'), '一共 3 道门禁。\n')
    writeFileSync(join(root, 'docs', 'PROGRESS.md'), '历史上是 29 道门禁。\n')
    writeFileSync(join(root, 'scripts', 'x.mjs'), '一共 29 道门禁。\n')
    const r = auditRepo(root)
    expect('排除文件（PROGRESS.md）里的旧数字 ⇒ 不判失败', r.failures.length, 1)
    expect('唯一的一条失败来自 scripts/x.mjs', r.failures[0]?.includes('scripts/x.mjs'), true)
  }

  if (failures > 0) {
    console.error(`\nselftest FAILED: ${failures} assertion(s)`)
    process.exit(2)
  }
  console.log('\nselftest OK — 门禁能抓住写错的总数与位次，也能放过正确的数字与无关的历史叙述')
}

/* ── entry ───────────────────────────────────────────────────────────────── */

const args = process.argv.slice(2)
if (args.includes('--selftest')) {
  selftest()
} else {
  const { chain, files, failures, notes } = auditRepo()
  console.log('verify-doc-gate-count')
  console.log(`  链内门禁 : ${chain.length} 道（${chain[0]} … ${chain[chain.length - 1]}）`)
  console.log(`  扫描文件 : ${files.length} 个`)
  if (notes.length) {
    console.log(`  备注     : ${notes.length} 条（无法核对的位次主张等）`)
    for (const n of notes.slice(0, 10)) console.log(`    · ${n}`)
    if (notes.length > 10) console.log(`    … 另有 ${notes.length - 10} 条`)
  }
  if (failures.length) {
    console.error(`\n  失败 : ${failures.length} 处`)
    for (const f of failures) console.error(`    ✗ ${f}`)
    console.error('\n文档里的门禁数与链内实际道数不一致 ⇒ 改文档，或改链（两者必须一致）。')
    process.exit(1)
  }
  console.log('  失败 : 0')
  console.log('\nPASS')
}
