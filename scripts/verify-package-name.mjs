#!/usr/bin/env node
/**
 * verify-package-name.mjs —— npm 包名一致性门禁（§7.173）
 *
 * ## 为什么需要它
 *
 * 本包的身份在仓库里被**复制**到了几十个地方，而且这些副本**没有一处会自检**：
 *
 *   - `cordis.patch.yml` / `cordis.desktop-safe.patch.yml` / `presets/edge.patch.yml` /
 *     `profiles/dsh-edge-agent/cordis.patch.yml` 里的
 *     `name: '@<scope>/dsh-edge-agent/...'` 行 ——
 *     **宿主运行时解析**。scope 写错 ⇒ 宿主按名字找不到包 ⇒ **插件静默挂不上** ⇒
 *     Edge tab 直接消失，**零报错、零日志**。
 *   - `src/dsh-adapter/invariant.ts` 的 `PACKAGE_NAME` /
 *     `src/dsh-adapter/invariant-install.ts` 的 `packageName` —— 注册 invariant 时的包名。
 *   - `scripts/verify-preset-isolate.ts` / `scripts/verify-patch-surface.ts` 的
 *     `BUNDLE_PKG` —— 门禁自己认包的依据；写错 ⇒ 门禁**对着空气断言**（恒绿）。
 *
 * 2026-11-10 scope 迁到 `@dsh-edge`（见 `docs/PROGRESS.md` §7.173）时，这道缺口是
 * 真实存在的：漏改任何一处都不会报错，只会在装机后表现为「Edge tab 不见了」。
 *
 * ## 检查项
 *
 *   1. **单一事实源**：`package.json#name` 必须是 `@<scope>/<base>` 形态，scope/base 合法。
 *   2. **点名的副本**：4 个已知副本常量必须字面等于 `package.json#name`。
 *   3. **残留 scope（本项目的包）**：全仓任何 `@<scope>/<base>` 形态的 token，其 scope 段
 *      必须 === 事实源的 scope。（覆盖 patch YAML 的 `name:` 行、`node_modules/...` 路径、
 *      `npm view`、`grep`、依赖键、文档。）
 *   4. **残留 scope（单独出现）**：`node_modules/@<scope>` / `--scope=@<scope>` 两种形态，
 *      其 scope 段必须 === 事实源的 scope（第三方 scope 走白名单）。
 *
 * ## 为什么第 3/4 条只认这两种形态
 *
 * 仓库里 `@` 开头的 token 绝大多数**不是 npm scope**：JSDoc 标签（`@module` / `@param` /
 * `@returns`）、Makefile 配方前缀（`@echo` / `@rm` / `@mkdir`）、脱敏后的邮箱
 * （`t***@gmail.com`）、文档占位符（`@scope/pkg`）。
 * 通用扫描会把它们全当 scope ⇒ 门禁天天误报 ⇒ 没人看 ⇒ 门禁等于没有。
 * 所以这里只认**本项目包的真实写法**，其余一律不碰。
 *
 * ## 为什么事实源只有一个
 *
 * 事实源 = `package.json#name`。门禁自己**不硬编码**包名：
 * scope/base 都从事实源派生，副本点按「文件 + 常量名」定位。
 * 以后再改 scope，只需要改 `package.json#name` + 改被门禁点名的那些副本，
 * 漏掉任何一个都会在这里红。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/verify-package-name.mjs              # 查当前树
 * node scripts/verify-package-name.mjs --selftest   # 自证 + 反向证伪
 * ```
 *
 * 退出码：0 = 通过；1 = 有问题；2 = 自证失败或参数错误。
 *
 * 只读：不写仓库内任何文件，不联网。
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** npm 的 scope / 包名片段的合法字符集（比 npm 自己严一点：不允许大写）。 */
const SCOPE_RE = /^@([a-z0-9][a-z0-9._~-]*)$/
const BASE_RE = /^([a-z0-9][a-z0-9._~-]*)$/

/**
 * 事实源解析：把 `package.json#name` 拆成 scope / base。
 * @returns {{name: string, scope: string, base: string} | null}
 */
export function parsePackageName(name) {
  if (typeof name !== 'string') return null
  const m = /^@([^/]+)\/([^/]+)$/.exec(name)
  if (!m) return null
  const scope = '@' + m[1]
  const base = m[2]
  if (!SCOPE_RE.test(scope)) return null
  if (!BASE_RE.test(base)) return null
  return { name, scope, base }
}

/**
 * 已知副本点：**按「文件 + 常量形状」定位，不硬编码包名**。
 *
 * 这些是本仓里已知的、**必须跟着 `package.json#name` 走**的包名副本。
 * 新增副本点时在这里加一行即可 —— 门禁会自动开始盯它。
 */
export const COPY_SITES = [
  { file: 'src/dsh-adapter/invariant.ts', re: /export const PACKAGE_NAME = '([^']+)'/ },
  { file: 'src/dsh-adapter/invariant-install.ts', re: /packageName: '([^']+)'/ },
  { file: 'scripts/verify-preset-isolate.ts', re: /const BUNDLE_PKG = '([^']+)'/ },
  { file: 'scripts/verify-patch-surface.ts', re: /const BUNDLE_PKG = '([^']+)'/ },
]

/**
 * 第三方 scope 白名单（`node_modules/@X` 形态下允许出现的非本项目 scope）。
 *
 * - `@deepseek-ai/*` / `@types/*` / `@vitest/*` / `@eslint/*` / `@typescript-eslint/*`
 *   —— 宿主运行时提供的 peer 家族 + 本地构建用到的工具链。
 * - `@deepseek-harness-tui` —— 上游 DSH TUI 家族（`scripts/reinstall-dsh.sh` 全局装，
 *   不在本仓 dependencies 里，所以不能靠 package.json 自动推导）。
 */
export const THIRD_PARTY_SCOPES = [
  '@deepseek-ai',
  '@types',
  '@vitest',
  '@eslint',
  '@typescript-eslint',
  '@deepseek-harness-tui',
]

/**
 * **已退役**的 scope（历史值）：本仓 2026-11-10 把包 scope 从
 * `@deepseek-harness-edge-agent` 迁到 `@dsh-edge`（§7.173）。
 *
 * 为什么允许它们出现在 `docs/` 下：改名迁移指南**必须写出旧 scope 是什么**
 * —— 否则读者无从判断自己的已部署 profile 是不是需要改
 * （`docs/load-into-local-dsh.md` §8.10 的「4 处要同步」就是这件事）。
 * 这些字面量是**历史记录**，不是当前用法。
 *
 * 豁免范围严格受限（§7.175 补）：
 *   · 只在 `docs/` 下的文件里放行；
 *   · 只放行下面这张表里的 scope（其它陌生 scope 在 docs 里照样红）；
 *   · 代码 / 配置（`cordis.patch.yml` / `presets/` / `src/` / `scripts/` …）
 *     里出现一律照旧报错 —— 那才是真正会让插件静默挂不上的漂移。
 */
export const RETIRED_SCOPES = ['@deepseek-harness-edge-agent']

/**
 * 这个 scope 是不是「已退役的旧 scope 的一次提及」。
 *
 * 除了精确相等，还认一种形态：迁移文档里的「旧目录改名」写法
 * `@<retired>.old-<timestamp>`（scope 的合法字符集含 `.` 与 `-`，
 * 所以扫描出来的是 `@deepseek-harness-edge-agent.old-`）。
 *
 * @param {string} s - 扫描到的 scope 串（含 @）
 * @param {Iterable<string>} retired - 已退役 scope 集合
 */
export function isRetiredScopeMention(s, retired) {
  for (const r of retired) {
    if (s === r) return true
    if (s.startsWith(r + '.old')) return true
  }
  return false
}

/**
 * 这个文件是不是文档（迁移指南所在的地方）。
 * @param {string} rel - 仓库相对路径
 */
export function isDocPath(rel) {
  return rel.startsWith('docs/')
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 核心检查（纯函数：便于自证时注入合成数据）。
 *
 * @param {{files: Array<{rel: string, text: string}>, facts: {name:string,scope:string,base:string}|null,
 *          copySites?: typeof COPY_SITES, thirdParty?: Iterable<string>}} input
 * @returns {{failures: Array<{code: string, where: string, detail: string}>}}
 */
export function checkPackageName(input) {
  const { files, facts } = input
  const copySites = input.copySites ?? COPY_SITES
  const thirdParty = new Set(input.thirdParty ?? THIRD_PARTY_SCOPES)
  const retired = new Set(input.retiredScopes ?? RETIRED_SCOPES)
  const failures = []

  if (!facts) {
    failures.push({
      code: 'E-NAME-FORMAT',
      where: 'package.json',
      detail: 'name 不是合法的 @<scope>/<base> 形态',
    })
    return { failures }
  }
  const { name, scope, base } = facts

  // ── 2. 点名的副本必须 === 事实源 ───────────────────────────────────────
  for (const site of copySites) {
    const f = files.find((x) => x.rel === site.file)
    if (!f) {
      failures.push({ code: 'E-COPY-MISSING', where: site.file, detail: '副本点所在文件不存在' })
      continue
    }
    const m = site.re.exec(f.text)
    if (!m) {
      failures.push({ code: 'E-COPY-PATTERN', where: site.file, detail: '副本常量没找到（写法变了？）' })
      continue
    }
    if (m[1] !== name) {
      failures.push({ code: 'E-COPY-DRIFT', where: site.file, detail: `副本 ${m[1]} ≠ 事实源 ${name}` })
    }
  }

  // ── 3. `@<scope>/<base>` 形态：scope 段必须 === 事实源的 scope ────────────
  const ownRe = new RegExp('@([a-z0-9][a-z0-9._~-]*)/' + escapeRe(base) + '(?![a-z0-9._~-])', 'g')

  // ── 4. scope 单独出现的两种形态 ─────────────────────────────────────────
  const scopeOnlyRes = [
    { code: 'E-SCOPE-ONLY-PATH', re: /node_modules\/(?:\.ignored\/)?@([a-z0-9][a-z0-9._~-]*)/g },
    { code: 'E-SCOPE-ONLY-FLAG', re: /--scope=@([a-z0-9][a-z0-9._~-]*)/g },
  ]

  for (const f of files) {
    // §7.175: 文档里的「已退役 scope 的一次提及」不算漂移 —— 迁移指南必须
    // 写出旧 scope 是什么，否则读者无从判断自己的 profile 要不要改。
    // 代码 / 配置里出现旧 scope 仍然是漂移（插件会静默挂不上）⇒ 不豁免。
    const docExempt = isDocPath(f.rel)

    ownRe.lastIndex = 0
    let m
    while ((m = ownRe.exec(f.text)) !== null) {
      const s = '@' + m[1]
      if (s !== scope) {
        if (docExempt && isRetiredScopeMention(s, retired)) continue
        failures.push({
          code: 'E-OWN-SCOPE-DRIFT',
          where: f.rel,
          detail: `${s}/${base} 的 scope ≠ 事实源 ${scope}`,
        })
      }
    }

    for (const { code, re } of scopeOnlyRes) {
      re.lastIndex = 0
      while ((m = re.exec(f.text)) !== null) {
        const s = '@' + m[1]
        if (s === scope) continue
        if (thirdParty.has(s)) continue
        if (docExempt && isRetiredScopeMention(s, retired)) continue
        failures.push({
          code,
          where: f.rel,
          detail: `${s} 既不是本项目 scope（${scope}）也不在第三方白名单里`,
        })
      }
    }
  }

  return { failures }
}

/** 读取事实源。 */
export function readFacts(root) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  return parsePackageName(pkg.name)
}

/** 收集 git 已跟踪的文本文件。 */
export function collectFiles(root) {
  const out = []
  const list = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  for (const rel of list.split('\0')) {
    if (!rel) continue
    let buf
    try {
      buf = readFileSync(join(root, rel))
    } catch {
      continue
    }
    // 二进制（含 NUL）跳过
    if (buf.includes(0)) continue
    out.push({ rel, text: buf.toString('utf8') })
  }
  return out
}

// ── CLI ───────────────────────────────────────────────────────────────────

function isEntryPoint() {
  const entry = process.argv[1]
  if (!entry) return false
  return resolve(entry) === resolve(fileURLToPath(import.meta.url))
}

function runSelfTest() {
  let passed = 0
  let failed = 0
  const ok = (label, cond) => {
    if (cond) {
      passed++
      console.log(`  ✓ ${label}`)
    } else {
      failed++
      console.error(`  ✗ ${label}`)
    }
  }

  console.log('verify-package-name --selftest')

  // ── 事实源解析 ─────────────────────────────────────────────────────────
  ok('合法 scoped 名能拆出 scope/base', (() => {
    const p = parsePackageName('@selftest-scope/selftest-pkg')
    return p && p.scope === '@selftest-scope' && p.base === 'selftest-pkg'
  })())
  ok('非 scoped 名被判 null', parsePackageName('selftest-pkg') === null)
  ok('大写 scope 被判 null', parsePackageName('@Selftest-Scope/selftest-pkg') === null)
  ok('缺 base 被判 null', parsePackageName('@selftest-scope/') === null)
  ok('多斜杠被判 null', parsePackageName('@selftest-scope/a/b') === null)

  // ── 合成树：干净 / 各种漂移 ────────────────────────────────────────────
  //
  // ⚠️ 这里**刻意不写死** `@<scope>/<base>` 字面量：门禁会扫自己（零例外），
  // 写死的话，改一次 scope 就会把门禁自己判成漂移。所有包名一律由事实源拼出来。
  const facts = readFacts(ROOT)
  if (!facts) {
    ok('事实源可解析', false)
    console.log(`\n  ${passed} passed, ${failed} failed`)
    return false
  }
  const PKG = facts.scope + '/' + facts.base
  const OTHER = '@other-scope'
  const good = [
    { rel: 'package.json', text: '{"name":"' + PKG + '"}' },
    { rel: 'src/dsh-adapter/invariant.ts', text: "export const PACKAGE_NAME = '" + PKG + "'" },
    { rel: 'src/dsh-adapter/invariant-install.ts', text: "packageName: '" + PKG + "'," },
    { rel: 'scripts/verify-preset-isolate.ts', text: "const BUNDLE_PKG = '" + PKG + "'" },
    { rel: 'scripts/verify-patch-surface.ts', text: "const BUNDLE_PKG = '" + PKG + "'" },
    { rel: 'cordis.patch.yml', text: "  name: '" + PKG + "'\n  name: '" + PKG + "/file-logger'" },
    { rel: 'install.sh', text: 'NESTED="$p/node_modules/' + PKG + '"' },
  ]
  const codes = (files) => checkPackageName({ files, facts }).failures.map((f) => f.code)

  ok('干净树零失败', codes(good).length === 0)

  ok('patch YAML 里残留旧 scope 会失败', (() => {
    const bad = good.map((f) =>
      f.rel === 'cordis.patch.yml' ? { ...f, text: f.text.replace(facts.scope + '/', OTHER + '/') } : f,
    )
    return codes(bad).includes('E-OWN-SCOPE-DRIFT')
  })())

  ok('node_modules/@旧scope 会失败', (() => {
    const bad = good.map((f) =>
      f.rel === 'install.sh' ? { ...f, text: 'NESTED="$p/node_modules/' + OTHER + '"' } : f,
    )
    return codes(bad).includes('E-SCOPE-ONLY-PATH')
  })())

  ok('--scope=@旧scope 会失败', (() => {
    const bad = good.map((f) =>
      f.rel === 'install.sh' ? { ...f, text: 'npm login --scope=' + OTHER } : f,
    )
    return codes(bad).includes('E-SCOPE-ONLY-FLAG')
  })())

  ok('第三方 scope 在 node_modules 下不误报', (() => {
    const bad = good.map((f) =>
      f.rel === 'install.sh' ? { ...f, text: 'X="$p/node_modules/' + THIRD_PARTY_SCOPES[0] + '/x"' } : f,
    )
    return codes(bad).length === 0
  })())

  ok('副本漂移会被抓到', (() => {
    const bad = good.map((f) =>
      f.rel === 'src/dsh-adapter/invariant.ts'
        ? { ...f, text: "export const PACKAGE_NAME = '" + OTHER + '/' + facts.base + "'" }
        : f,
    )
    return codes(bad).includes('E-COPY-DRIFT')
  })())

  ok('副本点缺失会被抓到', (() => {
    const bad = good.filter((f) => f.rel !== 'scripts/verify-patch-surface.ts')
    return codes(bad).includes('E-COPY-MISSING')
  })())

  ok('事实源非法时 fail-closed', (() => {
    const r = checkPackageName({ files: good, facts: null })
    return r.failures.length > 0 && r.failures[0].code === 'E-NAME-FORMAT'
  })())

  // ── §7.175 豁免：已退役 scope 在 docs/ 下不算漂移 ──────────────────────
  //
  // 迁移指南必须写出旧 scope 是什么（否则读者判断不了自己的 profile 要不要
  // 改）。豁免**严格受限**，下面四条逐条把它钉住。
  const RETIRED = RETIRED_SCOPES[0]
  const docWithRetired = good.concat([
    { rel: 'docs/migrate.md', text: '旧包名是 ' + RETIRED + '/' + facts.base + '\n' },
    { rel: 'docs/migrate2.md', text: 'mv node_modules/' + RETIRED + ' node_modules/' + RETIRED + '.old-2026\n' },
  ])

  ok('docs/ 里提及已退役 scope 不误报', codes(docWithRetired).length === 0)

  ok('已退役 scope 出现在代码/配置里仍然被抓到', (() => {
    const bad = good.map((f) =>
      f.rel === 'cordis.patch.yml' ? { ...f, text: f.text.replace(facts.scope + '/', RETIRED + '/') } : f,
    )
    return codes(bad).includes('E-OWN-SCOPE-DRIFT')
  })())

  ok('docs/ 里出现陌生 scope 仍然被抓到（豁免只认已退役那几个）', (() => {
    const bad = docWithRetired.concat([
      { rel: 'docs/other.md', text: '别的包 ' + OTHER + '/' + facts.base + '\n' },
    ])
    return codes(bad).includes('E-OWN-SCOPE-DRIFT')
  })())

  ok('非 docs 目录的已退役 scope 仍然被抓到', (() => {
    const bad = good.concat([
      { rel: 'src/x.ts', text: 'const p = "' + RETIRED + '/' + facts.base + '"\n' },
    ])
    return codes(bad).includes('E-OWN-SCOPE-DRIFT')
  })())

  ok('JSDoc 标签 / Makefile 配方不误报', (() => {
    const noisy = good.concat([
      { rel: 'src/x.ts', text: '/** @module dsh-edge-agent/x\n * @param value - 东西\n * @returns 结果\n */' },
      { rel: 'Makefile', text: '@echo "hi"\n@rm -rf lib/\n@mkdir -p out\n' },
      { rel: 'tests/x.test.ts', text: "assert.ok(redacted.includes('t***@gmail.com'))" },
      { rel: 'docs/d.md', text: "subpath rows like '@scope/pkg/audit-log' can never surface" },
    ])
    return codes(noisy).length === 0
  })())

  // ── 反向证伪：对**真实树**注入一处漏改，必须被抓到 ──────────────────────
  const realFiles = collectFiles(ROOT)
  const realFacts = readFacts(ROOT)
  const realCodes = checkPackageName({ files: realFiles, facts: realFacts }).failures.map((f) => f.code)
  ok('真实树当前零失败', realCodes.length === 0)

  const victim = realFiles.find((f) => f.rel === 'cordis.patch.yml')
  if (victim) {
    const staleRe = new RegExp(
      '@([a-z0-9][a-z0-9._~-]*)/' + escapeRe(realFacts.base) + '(?![a-z0-9._~-])',
      'g',
    )
    const mutated = realFiles.map((f) =>
      f.rel === 'cordis.patch.yml'
        ? { ...f, text: f.text.replace(staleRe, '@stale-scope/' + realFacts.base) }
        : f,
    )
    const mutatedCodes = checkPackageName({ files: mutated, facts: realFacts }).failures.map((f) => f.code)
    ok('真实树注入旧 scope 后被抓到（反向证伪）', mutatedCodes.includes('E-OWN-SCOPE-DRIFT'))
  } else {
    ok('真实树注入旧 scope 后被抓到（反向证伪）', false)
  }

  console.log(`\n  ${passed} passed, ${failed} failed`)
  return failed === 0
}

if (isEntryPoint()) {
  const args = process.argv.slice(2)
  const selftest = args.includes('--selftest')
  const unknown = args.filter((a) => a !== '--selftest')
  if (unknown.length > 0) {
    console.error(`未知参数：${unknown.join(' ')}`)
    process.exit(2)
  }

  if (selftest) {
    const okAll = runSelfTest()
    process.exit(okAll ? 0 : 2)
  }

  const facts = readFacts(ROOT)
  const files = collectFiles(ROOT)
  const { failures } = checkPackageName({ files, facts })

  console.log('verify-package-name')
  console.log(`  事实源 package.json#name = ${facts ? facts.name : '(非法)'}`)
  console.log(`  scope = ${facts ? facts.scope : '(非法)'}    base = ${facts ? facts.base : '(非法)'}`)
  console.log(`  扫描 ${files.length} 个已跟踪文本文件，${COPY_SITES.length} 个已知副本点`)

  if (failures.length === 0) {
    console.log('\n────────────────────────────────────────')
    console.log('  PASS —— 包名在全仓一致')
    console.log('────────────────────────────────────────')
    process.exit(0)
  }

  console.error('')
  for (const f of failures) {
    console.error(`  ✗ [${f.code}] ${f.where}\n      ${f.detail}`)
  }
  console.error('\n────────────────────────────────────────')
  console.error(`  FAIL —— ${failures.length} 处包名不一致`)
  console.error('────────────────────────────────────────')
  process.exit(1)
}
