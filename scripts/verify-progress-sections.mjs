#!/usr/bin/env node
/**
 * verify-progress-sections.mjs — 门禁：`docs/PROGRESS.md` 的**章节唯一性**与
 * **引用不断链**。
 *
 * ## 为什么需要它（§7.218）
 *
 * §7.216 那一轮撞上一个**真实的文档事故**：追加 PROGRESS 章节的探针脚本把
 * **源文件路径写死**成 `sec-7.213.md` ⇒ 后面两次调用（§7.214 / §7.215）原样
 * 又把 §7.213 的内容追加了一遍。后果是：
 *
 *   - `docs/PROGRESS.md` 里 `## §7.213` 出现**三份**（每份 76 行）；
 *   - **§7.214 与 §7.215 根本没进去** —— 而 `README.md` / `docs/privacy-policy.md` /
 *     `CHANGELOG.md` 都在引用 §7.214 ⇒ **单一事实源与引用方断链**。
 *
 * 事故是「手滑」，但**手滑能被机器挡住**：
 *
 *   - 重复的章节号 ⇒ 门禁一眼可见（读者只会读到第一份，后两份是幽灵）；
 *   - 引用了一个**不存在的章节** ⇒ 断链（本节第三条断言）。
 *
 * §7.208 已经给「文档口径漂移」装过机器看守（`verify:doc-links` /
 * `verify:config-hints` / `verify:doc-gate-count`）—— 本门禁补的是**同一个家族
 * 里缺的那一块**：**章节身份**。
 *
 * ## 三条不变量
 *
 *   1. **编号唯一**：`## §7.N`（二级标题）的 N 不得出现两次。
 *      （`### §7.N.M` 这样的**子节**不算 —— 它们是父节的展开，同一父号下
 *      本来就该有多条。）
 *   2. **编号递增**：二级标题的 N 必须**严格递增** ⇒ 章节不能插错位置。
 *   3. **引用不断链**：仓库其它 markdown（`README.md` / `CHANGELOG.md` /
 *      `docs/**`）里出现的 `§7.N` 引用，N 必须**在本文件里存在**。
 *
 * ### 第三条断言的**水位**（为什么只查 N ≥ 200）
 *
 * §7.200 之前，PROGRESS 里的 `§7.x` 是**条目号**（散在正文里，没有标题）——
 * 例如 §7.31、§7.42、§7.107 在 `docs/architecture.md` 里被引用，而 PROGRESS 里
 * 它们是**正文条目**而不是 `## §7.31` 这样的章节。那套编号后来被重组成
 * 「§7.200 起 = 章节号」的新体系 ⇒ **N ≥ 200 才落在新体系里**。
 *
 * ⇒ 水位以下的引用**不查**（它们指的是条目，不是章节；查了会误报一大片）。
 * 水位这个常量写在下面，改体系时记得跟着改。
 *
 * 用法：
 *   node scripts/verify-progress-sections.mjs              # 查当前树
 *   node scripts/verify-progress-sections.mjs --selftest   # 自证 + 反向证伪（纯内存）
 *
 * 退出码：0 = 通过；1 = 有问题；2 = 自证失败或参数错误。
 *
 * 只读：不写仓库内任何文件，不回显凭据。
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, resolve, dirname, relative, sep } from 'node:path'

/** 仓库根（本文件位于 `<root>/scripts/`）。 */
const ROOT = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')

/** 单一事实源。 */
const PROGRESS_REL = 'docs/PROGRESS.md'

/**
 * 「章节号」体系的水位：N ≥ SECTION_ERA_START 的 `§7.N` 指**章节**（有标题），
 * 更小的号指的是**条目**（散在正文里）⇒ 只对前者断言「必须存在」。
 */
const SECTION_ERA_START = 200

/**
 * 抽出 PROGRESS 里的二级章节标题。
 *
 * 只认 `## §7.N`（恰好两个 `#`）—— `### §7.N.M` 是子节，不参与唯一性判定；
 * `#### ` 及更深的是子子节。
 *
 * @param {string} text
 * @returns {{ n: number, line: number, title: string }[]}
 */
export function parseSections(text) {
  const out = []
  const lines = text.split(/\r?\n/u)
  lines.forEach((line, i) => {
    const m = /^##\s+§7\.(\d+)\b/u.exec(line)
    if (m) out.push({ n: Number(m[1]), line: i + 1, title: line.replace(/^##\s+/u, '') })
  })
  return out
}

/**
 * 找出文本里出现的所有 `§7.N` 引用（去重、升序）。
 *
 * @param {string} text
 * @returns {number[]}
 */
export function parseRefs(text) {
  const set = new Set()
  for (const m of text.matchAll(/§7\.(\d+)/gu)) set.add(Number(m[1]))
  return [...set].sort((a, b) => a - b)
}

/**
 * 跑三条断言。**纯函数** —— 不碰文件系统 ⇒ 自证可以用内存 fixture 喂。
 *
 * @param {string} progressText  PROGRESS.md 的正文
 * @param {Map<string,string>} otherFiles  其它 markdown：路径 → 正文
 * @returns {string[]} 违规描述；空数组 = 通过
 */
export function audit(progressText, otherFiles) {
  const failures = []
  const sections = parseSections(progressText)

  // ── 断言 1：编号唯一
  const seen = new Map()
  for (const s of sections) {
    if (seen.has(s.n)) {
      failures.push(
        `duplicate section number: §7.${s.n} appears at line ${seen.get(s.n)} and line ${s.line}`
        + ` — "${s.title}"`,
      )
    } else {
      seen.set(s.n, s.line)
    }
  }

  // ── 断言 2：编号严格递增
  for (let i = 1; i < sections.length; i++) {
    if (sections[i].n <= sections[i - 1].n) {
      failures.push(
        `section numbers must strictly increase: §7.${sections[i - 1].n} (line ${sections[i - 1].line})`
        + ` is followed by §7.${sections[i].n} (line ${sections[i].line})`,
      )
    }
  }

  // ── 断言 3：引用不断链（只查 N ≥ 水位）
  const defined = new Set(sections.map(s => s.n))
  for (const [path, text] of otherFiles) {
    for (const n of parseRefs(text)) {
      if (n < SECTION_ERA_START) continue
      if (!defined.has(n)) {
        failures.push(`dangling reference: ${path} references §7.${n}, which has no section in ${PROGRESS_REL}`)
      }
    }
  }

  return failures
}

/** 列出仓库里除 PROGRESS.md 外的 markdown（已跟踪的优先；退化时走文件系统）。 */
function listOtherMarkdown(root) {
  const files = new Map()
  const skipDirs = new Set(['node_modules', '.git', 'dist', 'coverage', '.pnpm-store'])
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (skipDirs.has(entry)) continue
      const p = join(dir, entry)
      const st = statSync(p)
      if (st.isDirectory()) { walk(p); continue }
      if (!entry.endsWith('.md')) continue
      const rel = relative(root, p).split(sep).join('/')
      if (rel === PROGRESS_REL) continue
      files.set(rel, readFileSync(p, 'utf8'))
    }
  }
  walk(root)
  return files
}

/** ── 自证 ─────────────────────────────────────────────────────────────── */

function selftest() {
  const failures = []
  const check = (name, cond, detail) => {
    if (!cond) failures.push(`selftest: ${name}${detail ? ` — ${detail}` : ''}`)
  }

  const good = [
    '## §7.210 first',
    '',
    'body',
    '',
    '## §7.211 second',
    '',
    '### 6.1 a subsection',
    '',
    '## §7.212 third',
    '',
  ].join('\n')

  // 1) 正常输入 ⇒ 全绿
  check('clean tree passes', audit(good, new Map()).length === 0,
    JSON.stringify(audit(good, new Map())))

  // 2) 重复编号 ⇒ 红（这正是 §7.218 修的那个事故）
  const dup = good + '\n## §7.210 again\n'
  const dupFail = audit(dup, new Map())
  check('duplicate section number is caught', dupFail.some(f => f.includes('duplicate section number')),
    JSON.stringify(dupFail))

  // 3) 乱序 ⇒ 红
  const unordered = '## §7.211 a\n\n## §7.210 b\n'
  check('out-of-order sections are caught',
    audit(unordered, new Map()).some(f => f.includes('strictly increase')),
    JSON.stringify(audit(unordered, new Map())))

  // 4) 子节不算重复（`### §7.210.1` 与 `## §7.210` 共存是合法的）
  const withSub = '## §7.210 a\n\n### 7.210.1 sub\n\n### 7.210.2 sub\n'
  check('subsections do not count as duplicates', audit(withSub, new Map()).length === 0,
    JSON.stringify(audit(withSub, new Map())))

  // 5) 悬空引用 ⇒ 红（本节断言 3）
  const dangling = audit(good, new Map([['README.md', '见 §7.213 的说明']]))
  check('dangling reference is caught', dangling.some(f => f.includes('dangling reference')),
    JSON.stringify(dangling))

  // 6) 水位以下的引用**不**查（那些是条目号，不是章节）
  const oldRef = audit(good, new Map([['README.md', '见 §7.31 的说明']]))
  check('pre-era references are not flagged', oldRef.length === 0, JSON.stringify(oldRef))

  // 7) 指向已存在章节的引用 ⇒ 通过
  const okRef = audit(good, new Map([['README.md', '见 §7.212 的说明']]))
  check('valid reference passes', okRef.length === 0, JSON.stringify(okRef))

  if (failures.length > 0) {
    console.error('SELFTEST FAILED')
    for (const f of failures) console.error('  x ' + f)
    process.exit(2)
  }
  console.log('selftest OK (7 checks)')
}

/** ── 主流程 ───────────────────────────────────────────────────────────── */

const selftestMode = process.argv.includes('--selftest')
if (selftestMode) {
  selftest()
} else {
  const progressPath = join(ROOT, PROGRESS_REL)
  if (!existsSync(progressPath)) {
    console.error(`FAIL: ${PROGRESS_REL} not found`)
    process.exit(1)
  }
  const failures = audit(readFileSync(progressPath, 'utf8'), listOtherMarkdown(ROOT))
  if (failures.length > 0) {
    console.error(`FAIL: ${failures.length} problem(s)`)
    for (const f of failures) console.error('  x ' + f)
    process.exit(1)
  }
  const sections = parseSections(readFileSync(progressPath, 'utf8'))
  console.log(`verify-progress-sections OK (${sections.length} top-level sections, refs intact)`)
}
