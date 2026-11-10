#!/usr/bin/env node
/**
 * verify-doc-links.mjs — 门禁：`docs/` 目录的「可达性 + 链接完整性」。
 *
 * 为什么需要它（§7.146 文档全量审计）：
 *
 *   审计 `docs/` 时发现 **10 份文件处于「孤儿态」**——文件确实存在、内容也确实
 *   有价值，但**没有任何入口能找到它们**（按路径统计的引用数 = 0）。其中
 *   `bench/snapshots/` 那批是 §7.87 模型选型的**唯一实测存档**（原始 `dist/`
 *   已被 `make package` 的一行 `rm -rf $(DIST_DIR)` 擦掉，端点也早已换代 ⇒
 *   不可再生）。
 *
 *   根因不是「写错了」，是**没有门禁**：新增文档不登记 ⇒ 没人发现；改目录名
 *   ⇒ 引用不更新 ⇒ 链接断掉也没人发现。本门禁把这两件事变成机器可查。
 *
 * 两条不变量：
 *
 *   1. **链接不���**：任何 `.md` 里的相对链接，指向的文件必须真实存在。
 *   2. **可达不孤儿**：`docs/` 下每个文件（含 `results.json` / `diff.txt` 等
 *      数据产物）都必须能被某个**导航面**（`docs/` 下任一 `README.md` + 仓库根
 *      `README.md`）上的显式 markdown 链接到达。
 *
 *   判据是**显式链接**而不是「字符串出现过」——`PROGRESS.md` 里提到过一个文件名
 *   不等于读者能走到它。这条也是本轮审计用过的判据（引用统计必须**按路径**
 *   匹配，不按文件名：`SKILL.md` / `report.md` 重名会互判成假阳性）。
 *
 * 用法：
 *   node scripts/verify-doc-links.mjs              # 查当前树
 *   node scripts/verify-doc-links.mjs --selftest   # 自证 + 反向证伪（纯内存/临时目录）
 *
 * 退出码：0 = 通过；1 = 有问题；2 = 自证失败或参数错误。
 *
 * 只读：不写仓库内任何文件，不回显凭据。
 */

import { readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve, dirname, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'

/** 仓库根（本文件位于 `<root>/scripts/`）。 */
const ROOT = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')

/** 扫描根：`docs/` 下的全部文件 + 仓库根 README.md（它是导航面之一）。 */
const DOC_ROOT = 'docs'

/** 导航面：文件名恰为 `README.md` 的文件（含仓库根那个）。 */
function isNavSurface(relPath) {
  return relPath === 'README.md' || /(^|[\\/])README\.md$/.test(relPath)
}

/**
 * 列出 git **已跟踪** 的 `docs/` 文件（仓库相对，正斜杠）。
 *
 * 门禁问的是「随仓库发布出去的文档，导航完整吗」——所以只该看已跟踪的文件。
 * `docs/` 里同时躺着 gitignored 的本地产物（bench 的 `.env` 快照、.DS_Store）：
 * 它们不会进仓库，却会被文件系统遍历当成「待发布的孤儿文档」。
 *
 * 这不只是误报：`docs/bench/snapshots/*.env` 装的是**真 API key**
 * （见 .gitignore 的 `docs/bench/snapshots/*.env` 规则）。把它们登记成
 * 「仓库里的一篇文档」，等于在本机把一份含凭据的文件表登记为待发布内容。
 *
 * 不在 git 仓库里时返回 null，调用方退回文件系统遍历（selftest 的临时目录走这条路）。
 */
function listTrackedDocs(root) {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--', DOC_ROOT], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.split('\0').filter(Boolean)
  } catch {
    return null
  }
}

/** 递归列出 `docs/` 下的文件（仓库相对，正斜杠）。 */
export function collectDocFiles(root = ROOT) {
  const tracked = listTrackedDocs(root)
  if (tracked) return tracked.sort()
  const out = []
  const base = join(root, DOC_ROOT)
  if (!existsSync(base)) return out
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // 跳过点开头的隐藏文件（.DS_Store 等系统产物，.gitignore 已排除）。
      // 它们不是文档，被当成「孤儿」会让门禁在 macOS 本地误报。
      if (entry.name.startsWith('.')) continue
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) walk(abs)
      else out.push(relative(root, abs).split(sep).join('/'))
    }
  }
  walk(base)
  return out.sort()
}

/** 取出文本里的相对 markdown 链接（跳过 http/mailto/纯锚点）。 */
export function extractRelativeLinks(text) {
  const out = []
  const re = /\[[^\]]*\]\(([^)]+)\)/g
  let m
  while ((m = re.exec(text)) !== null) {
    const raw = m[1].trim()
    if (/^(https?:|mailto:|#)/i.test(raw)) continue
    const clean = raw.replace(/^</, '').replace(/>$/, '').split('#')[0].trim()
    if (!clean) continue
    out.push(clean)
  }
  return out
}

/**
 * 不变量 1：断链。
 * @returns {Array<{source:string, href:string}>}
 */
export function findBrokenLinks(root = ROOT) {
  const broken = []
  const sources = collectDocFiles(root).filter((f) => f.endsWith('.md'))
  sources.push('README.md')
  for (const src of sources) {
    const abs = join(root, src)
    if (!existsSync(abs)) continue
    const text = readFileSync(abs, 'utf8')
    for (const href of extractRelativeLinks(text)) {
      const target = resolve(dirname(abs), href)
      if (!existsSync(target)) broken.push({ source: src, href })
    }
  }
  return broken
}

/**
 * 不变量 2：孤儿——`docs/` 下每个文件都必须能从某个导航面**用显式链接**到达。
 *
 * 可达性按**传递闭包**判定：从导航面出发、沿 markdown 链接逐层走，能走到就算
 * 可达。所以 `docs/README.md` → `bench/needle-cn-en/report.md` → `results.json`
 * 成立——索引不必把每个产物都重复列一遍，只要链条不断。
 *
 * @returns {Array<{file:string}>} 不可达的文件
 */
export function findUnreachable(root = ROOT) {
  const docFiles = collectDocFiles(root)
  const docSet = new Set(docFiles)
  const navFiles = docFiles.filter(isNavSurface).concat(['README.md'])

  // 邻接表：source → 它链接到的、仍在 docs/ 内的目标
  const adjacency = new Map()
  const readTargets = (src) => {
    const abs = join(root, src)
    if (!existsSync(abs)) return []
    const out = []
    for (const href of extractRelativeLinks(readFileSync(abs, 'utf8'))) {
      const target = resolve(dirname(abs), href)
      if (!existsSync(target)) continue
      const rel = relative(root, target).split(sep).join('/')
      if (docSet.has(rel)) out.push(rel)
    }
    return out
  }

  // BFS：从所有导航面出发
  const seen = new Set()
  const queue = []
  for (const nav of navFiles) {
    if (!existsSync(join(root, nav))) continue
    seen.add(nav)
    queue.push(nav)
  }
  while (queue.length > 0) {
    const cur = queue.shift()
    if (!adjacency.has(cur)) adjacency.set(cur, readTargets(cur))
    for (const next of adjacency.get(cur)) {
      if (seen.has(next)) continue
      seen.add(next)
      queue.push(next)
    }
  }

  return docFiles.filter((f) => !seen.has(f)).map((f) => ({ file: f }))
}

/** 汇总一次检查。 */
export function audit(root = ROOT) {
  const docFiles = collectDocFiles(root)
  const broken = findBrokenLinks(root)
  const unreachable = findUnreachable(root)
  const navs = docFiles.filter(isNavSurface).concat(['README.md'])
  return { docFiles, broken, unreachable, navs }
}

/* ── 自证 + 反向证伪 ───────────────────────────────────────────────────── */

/**
 * 在临时目录里造一棵最小文档树，逐条断言门禁会红 / 会绿。
 * 反向证伪：把「坏」造出来，门禁必须**报出来**；造回「好」，门禁必须**放过**。
 */
function selftest() {
  let failures = 0
  const expect = (label, actual, wanted) => {
    const ok = actual === wanted
    if (!ok) failures++
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label} — expected ${wanted}, got ${actual}`)
  }

  const dir = mkdtempSync(join(tmpdir(), 'dsh-doclinks-'))
  try {
    const write = (rel, body) => {
      const abs = join(dir, rel)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, body, 'utf8')
    }

    // 1) 干净树：一份索引 + 一份被索引的文档 + 一个数据产物
    write('docs/README.md', '[a](a.md)\n[data](data/results.json)\n')
    write('docs/a.md', '# a\n\n[b](b.md)\n')
    write('docs/b.md', '# b\n')
    write('docs/data/results.json', '{}\n')
    write('README.md', '[index](docs/README.md)\n')

    let r = audit(dir)
    expect('干净树：无断链', r.broken.length, 0)
    expect('干净树：无孤儿', r.unreachable.length, 0)

    // 2) 断链：把 a.md 的链接指向不存在的文件
    write('docs/a.md', '# a\n\n[b](nope.md)\n')
    r = audit(dir)
    expect('断链被抓住', r.broken.length, 1)
    expect('断链来源标对', r.broken[0]?.source, 'docs/a.md')
    expect('断链目标标对', r.broken[0]?.href, 'nope.md')

    // 3) 孤儿：b.md 不再被任何导航面链接到（a.md 还在，但 a.md 不是导航面）
    write('docs/a.md', '# a\n\n[missing](nope.md)\n')
    r = audit(dir)
    expect('孤儿被抓住', r.unreachable.length, 1)
    expect('孤儿文件标对', r.unreachable[0]?.file, 'docs/b.md')

    // 4) 孤儿：数据产物没被链接也要抓
    write('docs/a.md', '# a\n\n[b](b.md)\n')
    write('docs/README.md', '[a](a.md)\n') // 故意去掉 data/results.json 的链接
    r = audit(dir)
    expect('未链接的数据产物被抓住', r.unreachable.length, 1)
    expect('数据产物标对', r.unreachable[0]?.file, 'docs/data/results.json')

    // 5) 恢复：数据产物重新有链接 ⇒ 全绿
    write('docs/README.md', '[a](a.md)\n[data](data/results.json)\n')
    r = audit(dir)
    expect('修复后：无断链', r.broken.length, 0)
    expect('修复后：无孤儿', r.unreachable.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  if (failures > 0) {
    console.error(`\nselftest FAILED: ${failures} assertion(s)`)
    process.exit(2)
  }
  console.log('\nselftest OK — 门禁能抓住断链与孤儿，也能放过干净的树')
}

/* ── 入口 ──────────────────────────────────────────────────────────────── */

const args = process.argv.slice(2)
if (args.includes('--selftest')) {
  console.log('verify-doc-links --selftest')
  selftest()
} else if (args.length > 0) {
  console.error(`usage: node scripts/verify-doc-links.mjs [--selftest]`)
  process.exit(2)
} else {
  const r = audit(ROOT)
  const navList = r.navs.map((n) => `  ${n}`).join('\n')
  console.log('verify-doc-links')
  console.log(`  docs/ 文件数     : ${r.docFiles.length}`)
  console.log(`  导航面           :\n${navList}`)
  console.log(`  断链             : ${r.broken.length}`)
  console.log(`  不可达（孤儿）   : ${r.unreachable.length}`)
  if (r.broken.length) {
    console.log('\n断链明细：')
    for (const b of r.broken) console.log(`  ${b.source} -> ${b.href}`)
  }
  if (r.unreachable.length) {
    console.log('\n不可达明细（这些文件没有任何导航面能走到它们）：')
    for (const u of r.unreachable) console.log(`  ${u.file}`)
    console.log('\n修法二选一：')
    console.log('  ① 在 docs/README.md 的对应表格里补一行（首选——它就是总索引）')
    console.log('  ② 确认它确实该删 ⇒ 删掉，并到 docs/README.md「已被删除的文档」留一行档')
  }
  if (r.broken.length || r.unreachable.length) {
    console.error('\nFAIL')
    process.exit(1)
  }
  console.log('\nPASS')
}
