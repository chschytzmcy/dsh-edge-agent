#!/usr/bin/env node
/**
 * verify-npm-publish.mjs —— 发布面就绪门禁（§7.172）
 *
 * ## 为什么需要它
 *
 * `docs/deploy-npm.md` §7 有一张「作者侧义务」表（逐条对照宿主 `publish.md` + 宿主
 * 源码），但那张表**是人读的，不会拦人**。而这条发布链**从来没被走通过**（本仓至今
 * 0 个 tag、registry 上 404）—— 于是表里每一条都只是「看起来对」。
 *
 * 本门禁把那张表变成**机器检查**：任何一条被破坏，push 之前就红。
 *
 * 宿主侧的真实后果（不是危言耸听，是源码里的硬失败）：
 *
 *   - `dsh.bundle.patch` 列出的文件不在包里 ⇒ 装后校验报
 *     `failed to read overlay <file>` ⇒ **整个安装回滚**（package.json + 锁文件都还原）。
 *   - 包没声明 `dsh.bundle` ⇒ 宿主判它 `not-bundle` ⇒ 拒绝安装。
 *   - `engines.dsh` 不满足 ⇒ `incompatible-version` ⇒ **在 pnpm 跑之前就拒绝**。
 *   - scoped 包没写 `publishConfig.access: "public"` ⇒ 默认 restricted ⇒ 公众装不了。
 *
 * ## 检查项
 *
 *   1. 包名符合**宿主**的正则（比 npm 自己还严：只允许小写、长度 ≤ 214）
 *   2. version 是合法 semver，且不是 `0.0.0`
 *   3. `publishConfig.access === "public"`
 *   4. `dsh.bundle.patch` 非空；每个列出的文件**存在**且**会被打进包里**
 *   5. `engines.dsh` 已声明
 *   6. `peerDependencies` 全部也在 `devDependencies`（宿主运行时提供 peer，本地构建要它们）
 *   7. `repository.url` 指向的仓库 = 实际 git remote（路径不同 ⇒ 失败；大小写不同 ⇒ 警告）
 *   8. `CHANGELOG.md` 存在、提到当前版本、且在 `files` 白名单里（npm 不会自动带）
 *   9. `files` 里排除了 `config/edge.json`（明文凭据）
 *  10. `prepare` 脚本存在且会构建 `lib/`（git 通道靠它现场编译）
 *  11. `main` / `types` 会被打进包里（否则 tarball 没有入口）
 *
 * ## 用法
 *
 * ```bash
 * node scripts/verify-npm-publish.mjs              # 查当前树
 * node scripts/verify-npm-publish.mjs --selftest   # 自证 + 反向证伪
 * ```
 *
 * 退出码：0 = 通过；1 = 有问题；2 = 自证失败或参数错误。
 *
 * 只读：不写仓库内任何文件，不回显凭据，不联网。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 宿主的包名正则（`install-spec.ts:32-33`）—— 比 npm 自己还严。 */
const HOST_PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u
const MAX_NAME_LENGTH = 214

/** semver 的最小形状（不引 semver 依赖：够用即可，完整校验交给 npm）。 */
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u

/**
 * 一个路径会不会被 `files` 白名单打进包里？
 *
 * npm 的 `files` 语义（简化到够用的程度）：
 *   - 正条目：路径 / 目录（前缀匹配）/ glob
 *   - `!` 开头是排除，且**排除优先**
 *   - `package.json` / `README*` / `LICENSE*` 永远进包（与 files 无关）
 *
 * @param {string} path 仓库相对路径（正斜杠）
 * @param {string[]} files package.json#files
 */
export function isCoveredByFiles(path, files) {
  const clean = path.replace(/^\.\//u, '').replaceAll('\\', '/')
  // 永远进包的文件
  if (clean === 'package.json') return true
  if (/^(readme|license|copying|notice)(\.[^/]*)?$/iu.test(clean)) return true
  if (/^readme\/|^license\//iu.test(clean)) return true

  const positives = []
  const negatives = []
  for (const raw of files ?? []) {
    const entry = String(raw).replaceAll('\\', '/')
    if (entry.startsWith('!')) negatives.push(entry.slice(1).replace(/^\.\//u, ''))
    else positives.push(entry.replace(/^\.\//u, ''))
  }

  const matches = (pattern, target) => {
    if (pattern === target) return true
    // 目录条目 ⇒ 前缀匹配（npm 的目录语义）
    if (!pattern.includes('*') && target.startsWith(`${pattern}/`)) return true
    // glob：只支持 `*`（不跨 `/`）与 `**`
    const re = new RegExp(
      `^${pattern
        .replace(/[.+?^${}()|[\]\\]/gu, '\\$&')
        .replace(/\*\*/gu, '\u0000')
        .replace(/\*/gu, '[^/]*')
        .replace(/\u0000/gu, '.*')}$`,
      'u',
    )
    return re.test(target)
  }

  if (negatives.some((n) => matches(n, clean))) return false
  return positives.some((p) => matches(p, clean))
}

/** 从各种 git remote 写法里取出 `owner/repo`。 */
export function repoPathFromUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return undefined
  const trimmed = url.trim().replace(/\.git$/u, '').replace(/\/+$/u, '')
  const patterns = [
    /^git@[^:]+:(.+)$/u,        // git@github.com:owner/repo
    /^ssh:\/\/git@[^/]+\/(.+)$/u, // ssh://git@github.com/owner/repo
    /^https?:\/\/[^/]+\/(.+)$/u,  // https://github.com/owner/repo
  ]
  for (const re of patterns) {
    const m = re.exec(trimmed)
    if (m?.[1]) return m[1].replace(/\.git$/u, '').replace(/\/+$/u, '')
  }
  return undefined
}

/** 实际 git remote 的 `owner/repo`（读不到就返回 undefined —— 不是失败）。 */
export function gitRemotePath(cwd = ROOT) {
  try {
    const out = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return repoPathFromUrl(out.trim())
  } catch {
    return undefined
  }
}

/**
 * CHANGELOG 里有没有当前版本的条目？
 *
 * **唯一实现** —— `publish.yml` 的 CHANGELOG 断言步也调它（`--check-changelog`）。
 * 两边各写一份正则 ⇒ 迟早漂移（而且漂移的方向是「workflow 那份更松」）。
 *
 * 边界用 `\b`：`0.1.1` **不能**被 `0.1.10` 满足（`\b` 后紧跟数字 ⇒ 不是词边界）。
 * 这也是为什么不能用 `grep -qE "^#{1,3} .*${VER}"` —— 那里 `.` 是通配符、且没有边界，
 * `0.1.1` 会误匹配 `0.1.10`。
 *
 * @param {string} changelog CHANGELOG.md 全文
 * @param {string} version 当前版本
 */
export function changelogCoversVersion(changelog, version) {
  const escaped = String(version).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const heading = new RegExp(`^#{1,3}\\s+.*?\\b${escaped}\\b`, 'mu')
  return heading.test(changelog)
}

/**
 * 审一个 manifest + 文件系统视图。
 *
 * @param {object} manifest package.json 的内容
 * @param {{exists:(p:string)=>boolean, remotePath?:string, changelog?:string}} fsView
 * @returns {{failures: string[], warnings: string[]}}
 */
export function auditManifest(manifest, fsView) {
  const failures = []
  const warnings = []
  const files = manifest.files ?? []

  // 1. 包名
  const name = manifest.name ?? ''
  if (!HOST_PACKAGE_NAME_RE.test(name)) {
    failures.push(`包名 "${name}" 不符合宿主的正则 /^(?:@[a-z0-9][a-z0-9._~-]*\\/)?[a-z0-9][a-z0-9._~-]*$/ —— 宿主会判它不是包名（只允许小写）`)
  }
  if (name.length > MAX_NAME_LENGTH) {
    failures.push(`包名长度 ${name.length} > ${MAX_NAME_LENGTH} —— 宿主拒绝`)
  }

  // 2. version
  const version = manifest.version ?? ''
  if (!SEMVER_RE.test(version)) {
    failures.push(`version "${version}" 不是合法 semver`)
  }
  if (version === '0.0.0') {
    failures.push('version 是 0.0.0 —— npm 会拒（占位版本）')
  }

  // 3. publishConfig.access
  if (manifest.publishConfig?.access !== 'public') {
    failures.push(
      'publishConfig.access 不是 "public" —— scoped 包默认 restricted，'
      + '公众装不到（宿主预检只看得到 registry 上有没有这个包）',
    )
  }

  // 4. dsh.bundle.patch
  const patch = manifest.dsh?.bundle?.patch
  const patchList = typeof patch === 'string' ? [patch] : Array.isArray(patch) ? patch : []
  if (patchList.length === 0) {
    failures.push('dsh.bundle.patch 为空 —— 宿主判它 not-bundle ⇒ 拒绝安装')
  }
  for (const entry of patchList) {
    const rel = String(entry).replace(/^\.\//u, '')
    if (!fsView.exists(rel)) {
      failures.push(`dsh.bundle.patch 列出的 "${rel}" 在仓库里不存在 —— 装后校验会报 failed to read overlay ⇒ 整个安装回滚`)
      continue
    }
    if (!isCoveredByFiles(rel, files)) {
      failures.push(`dsh.bundle.patch 列出的 "${rel}" 不在 package.json#files 白名单里 ⇒ 不会进 tarball ⇒ 装后校验失败并回滚`)
    }
  }

  // 5. engines.dsh
  if (!manifest.engines?.dsh) {
    failures.push('engines.dsh 未声明 —— 宿主无法独断兼容性，会逐个查 peer 范围；缺失即判不兼容')
  }

  // 6. peer ⊆ dev
  const peers = Object.keys(manifest.peerDependencies ?? {})
  const devs = new Set(Object.keys(manifest.devDependencies ?? {}))
  const missingDev = peers.filter((p) => !devs.has(p))
  if (missingDev.length > 0) {
    failures.push(
      `peerDependencies 里的 ${missingDev.join(', ')} 不在 devDependencies —— `
      + '宿主运行时提供 peer，但本地构建/编译需要它们（CI 装 devDeps）',
    )
  }

  // 7. repository.url ↔ git remote
  const declared = repoPathFromUrl(manifest.repository?.url)
  const actual = fsView.remotePath
  if (declared && actual) {
    if (declared.toLowerCase() !== actual.toLowerCase()) {
      failures.push(
        `repository.url 指向 "${declared}"，实际 git remote 是 "${actual}" —— `
        + '包会挂在别的仓库名下，provenance 的溯源校验也会对不上',
      )
    } else if (declared !== actual) {
      warnings.push(
        `repository.url 的大小写与 git remote 不同（"${declared}" vs "${actual}"）—— `
        + 'npm 的 provenance 校验对仓库路径是大小写敏感的，建议改成 GitHub 上的规范写法',
      )
    }
  }

  // 8. CHANGELOG
  const changelog = fsView.changelog
  if (changelog === undefined) {
    failures.push('CHANGELOG.md 不存在 —— publish.yml 的前置清单要求它，npm 包页也用它渲染变更记录')
  } else {
    if (!changelogCoversVersion(changelog, version)) {
      failures.push(`CHANGELOG.md 里找不到当前版本 ${version} 的条目 —— 发出去的包没有对应的变更记录`)
    }
    if (!isCoveredByFiles('CHANGELOG.md', files)) {
      failures.push('CHANGELOG.md 不在 package.json#files 里 —— npm 不会自动带它 ⇒ 包页看不到变更记录')
    }
  }

  // 9. 真凭据不进包
  if (files.some((f) => f.replace(/^\.\//u, '') === 'config/edge.json')) {
    failures.push('package.json#files 包含 config/edge.json —— 那是明文凭据文件，绝不能进包')
  }
  if (!files.some((f) => f.replace(/^\.\//u, '') === '!config/edge.json')) {
    warnings.push('package.json#files 没有显式排除 config/edge.json（靠 .npmignore 也行，但显式更清楚）')
  }

  // 10. prepare（git 通道靠它现场编译）
  const prepare = manifest.scripts?.prepare ?? ''
  if (prepare.trim().length === 0) {
    failures.push('scripts.prepare 为空 —— git 安装通道不会编译 lib/ ⇒ 装出来的是空壳')
  } else if (!prepare.includes('compile') || !prepare.includes('build:client')) {
    failures.push(
      `scripts.prepare 没有同时跑 compile 与 build:client —— git 通道要的是「Node 半侧 + 浏览器半侧」都在（现在: "${prepare}"）`,
    )
  }

  // 11. 入口在包里
  for (const [label, target] of [['main', manifest.main], ['types', manifest.types]]) {
    if (!target) continue
    const rel = String(target).replace(/^\.\//u, '')
    if (!isCoveredByFiles(rel, files)) {
      failures.push(`${label} 指向的 "${rel}" 不在 files 白名单里 ⇒ tarball 没有入口`)
    }
  }

  return { failures, warnings }
}

/* ── 自证 + 反向证伪 ───────────────────────────────────────────────────── */

/**
 * 造一份最小 manifest，逐条断言门禁会红 / 会绿。
 * 反向证伪：把「坏」造出来，门禁必须**报出来**；造回「好」，门禁必须**放过**。
 */
function selftest() {
  let failures = 0
  const expect = (label, actual, wanted) => {
    const ok = actual === wanted
    if (!ok) failures++
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label} — expected ${wanted}, got ${actual}`)
  }

  const good = {
    name: '@dsh-edge/dsh-edge-agent',
    version: '0.1.1',
    publishConfig: { access: 'public' },
    repository: { url: 'https://github.com/chschytzmcy/dsh-edge-agent.git' },
    engines: { dsh: '>=0.2.1-rc.2' },
    main: 'lib/index.js',
    types: 'lib/index.d.ts',
    files: ['lib', 'config', 'cordis.desktop-safe.patch.yml', 'presets', 'CHANGELOG.md', '!config/edge.json'],
    scripts: { prepare: 'node scripts/run.mjs compile build:client' },
    dsh: { bundle: { patch: ['./cordis.desktop-safe.patch.yml'] } },
    peerDependencies: { '@deepseek-ai/cordis': '>=4.0.5' },
    devDependencies: { '@deepseek-ai/cordis': '>=4.0.5' },
  }
  const view = {
    exists: (p) => p === 'cordis.desktop-safe.patch.yml',
    remotePath: 'chschytzmcy/dsh-edge-agent',
    changelog: '# Changelog\n\n## 0.1.1\n\n- first release\n',
  }

  // 1. 好树全绿
  {
    const r = auditManifest(good, view)
    expect('好树 ⇒ 无失败', r.failures.length, 0)
    expect('好树 ⇒ 无警告', r.warnings.length, 0)
  }

  // 2. 包名带大写（宿主的正则拒绝）
  {
    const r = auditManifest({ ...good, name: '@Deepseek-Harness/dsh-edge-agent' }, view)
    expect('大写包名 ⇒ 报失败', r.failures.length, 1)
  }

  // 3. scoped 包没写 access: public
  {
    const r = auditManifest({ ...good, publishConfig: { access: 'restricted' } }, view)
    expect('access=restricted ⇒ 报失败', r.failures.length, 1)
    expect('失败信息点名 access', r.failures[0].includes('publishConfig.access'), true)
  }

  // 4. patch 文件不在 files 白名单里
  {
    const r = auditManifest({ ...good, files: good.files.filter((f) => f !== 'cordis.desktop-safe.patch.yml') }, view)
    expect('patch 文件不在白名单 ⇒ 报失败', r.failures.length, 1)
    expect('失败信息点名该文件', r.failures[0].includes('cordis.desktop-safe.patch.yml'), true)
  }

  // 5. patch 文件在仓库里不存在
  {
    const r = auditManifest(good, { ...view, exists: () => false })
    expect('patch 文件不存在 ⇒ 报失败', r.failures.length, 1)
  }

  // 6. peer 不在 dev 里
  {
    const r = auditManifest({ ...good, devDependencies: {} }, view)
    expect('peer 不在 dev ⇒ 报失败', r.failures.length, 1)
  }

  // 7. repository 指向别的仓库
  {
    const r = auditManifest({ ...good, repository: { url: 'https://github.com/someone/else.git' } }, view)
    expect('repository 不匹配 ⇒ 报失败', r.failures.length, 1)
    expect('失败信息点名仓库路径', r.failures[0].includes('someone/else'), true)
  }

  // 8. 大小写不同 ⇒ 警告不是失败（同样的字母，只改大小写）
  {
    const r = auditManifest({ ...good, repository: { url: 'https://github.com/CHSCHYTZMCY/dsh-edge-agent.git' } }, view)
    expect('仓库大小写不同 ⇒ 不算失败', r.failures.length, 0)
    expect('仓库大小写不同 ⇒ 报警告', r.warnings.length, 1)
  }

  // 9. CHANGELOG 缺当前版本
  {
    const r = auditManifest(good, { ...view, changelog: '# Changelog\n\n## 0.0.9\n' })
    expect('CHANGELOG 无当前版本 ⇒ 报失败', r.failures.length, 1)
  }

  // 10. CHANGELOG 不在 files 里
  {
    const r = auditManifest({ ...good, files: good.files.filter((f) => f !== 'CHANGELOG.md') }, view)
    expect('CHANGELOG 不在白名单 ⇒ 报失败', r.failures.length, 1)
  }

  // 11. prepare 为空
  {
    const r = auditManifest({ ...good, scripts: { prepare: '' } }, view)
    expect('prepare 为空 ⇒ 报失败', r.failures.length, 1)
  }

  // 12. files 里有真凭据
  {
    const r = auditManifest({ ...good, files: [...good.files, 'config/edge.json'] }, view)
    expect('files 含 edge.json ⇒ 报失败', r.failures.length, 1)
    expect('失败信息点名 edge.json', r.failures[0].includes('edge.json'), true)
  }

  // 13. dsh.bundle.patch 缺失
  {
    const r = auditManifest({ ...good, dsh: { bundle: {} } }, view)
    expect('dsh.bundle.patch 缺失 ⇒ 报失败', r.failures.length, 1)
  }

  // 15. CHANGELOG 的版本边界：`0.1.1` 不能被 `0.1.10` 满足
  //     （这正是 workflow 里那个 grep 会踩的坑：`.` 是通配符、且没有词边界）
  {
    expect('0.1.10 的标题不能满足 0.1.1', changelogCoversVersion('# Changelog\n\n## [0.1.10]\n', '0.1.1'), false)
    expect('0.1.1 的标题能满足 0.1.1', changelogCoversVersion('# Changelog\n\n## [0.1.1]\n', '0.1.1'), true)
  }

  // 14. files 覆盖判据本身：目录条目 / glob / 排除优先
  {
    expect('目录条目前缀命中', isCoveredByFiles('presets/edge.patch.yml', ['presets']), true)
    expect('目录条目前缀不命中别的目录', isCoveredByFiles('other/x.yml', ['presets']), false)
    expect('排除优先于包含', isCoveredByFiles('config/edge.json', ['config', '!config/edge.json']), false)
    expect('package.json 永远进包', isCoveredByFiles('package.json', ['lib']), true)
    expect('README 永远进包', isCoveredByFiles('README.md', ['lib']), true)
    expect('glob 命中', isCoveredByFiles('lib/dsh-adapter/x.js', ['lib/**/*.js']), true)
  }

  if (failures > 0) {
    console.error(`\nselftest FAILED: ${failures} assertion(s)`)
    process.exit(2)
  }
  console.log('\nselftest OK — 门禁能抓住破坏发布面的每一处，也能放过干净的面')
}

/* ── 入口 ──────────────────────────────────────────────────────────────── */

const args = process.argv.slice(2)
if (args.includes('--selftest')) {
  console.log('verify-npm-publish --selftest')
  selftest()
} else if (args.includes('--check-changelog')) {
  // publish.yml 的 CHANGELOG 断言步 —— **与门禁共用同一个实现**
  // （changelogCoversVersion）。两边各写一份正则 ⇒ 迟早漂移，而且漂移的方向
  // 一定是「workflow 那份更松」（grep 的 `.` 是通配符、`0.1.1` 会误匹配 `0.1.10`）。
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const changelogPath = join(ROOT, 'CHANGELOG.md')
  if (!existsSync(changelogPath)) {
    console.error('::error::CHANGELOG.md is missing (publish pre-publish checklist)')
    process.exit(1)
  }
  const changelog = readFileSync(changelogPath, 'utf8')
  if (!changelogCoversVersion(changelog, manifest.version)) {
    console.error(`::error::CHANGELOG.md has no entry for version ${manifest.version}`)
    process.exit(1)
  }
  console.log(`CHANGELOG.md covers version ${manifest.version}`)
} else if (args.length > 0) {
  console.error('usage: node scripts/verify-npm-publish.mjs [--selftest | --check-changelog]')
  process.exit(2)
} else {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const changelogPath = join(ROOT, 'CHANGELOG.md')
  const result = auditManifest(manifest, {
    exists: (rel) => existsSync(join(ROOT, rel)),
    remotePath: gitRemotePath(ROOT),
    changelog: existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : undefined,
  })

  console.log('verify-npm-publish')
  console.log(`  包名             : ${manifest.name}`)
  console.log(`  版本             : ${manifest.version}`)
  console.log(`  发布可见性       : ${manifest.publishConfig?.access ?? '(未声明)'}`)
  console.log(`  dsh.bundle.patch : ${(manifest.dsh?.bundle?.patch ?? []).length} 个文件`)
  console.log(`  失败             : ${result.failures.length}`)
  console.log(`  警告             : ${result.warnings.length}`)
  if (result.warnings.length > 0) {
    console.log('\n警告明细：')
    for (const w of result.warnings) console.log(`  - ${w}`)
  }
  if (result.failures.length > 0) {
    console.log('\n失败明细：')
    for (const f of result.failures) console.log(`  - ${f}`)
    console.error('\nFAIL')
    process.exit(1)
  }
  console.log('\nPASS')
}
