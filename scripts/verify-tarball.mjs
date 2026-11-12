// scripts/verify-tarball.mjs — §7.157: the tarball channel's gate.
//
// ## The failure it exists to prevent
//
// `dist/<variant>.tar.gz` is a DISTRIBUTABLE artifact: the top-level directory is
// named `package` (npm/pnpm's expectation) and it is what a user hands to the
// desktop's "Add plugin → local directory" box, pointing at the .tar.gz.
//
// §7.153 fixed the variant table so `dsh.bundle.patch` is the LIST form
// (host rows + the Agent Preset layer). The tarball was NOT rebuilt afterwards
// ⇒ the shipped tarball still declared the STRING form ⇒ the preset layer was
// silently dropped ⇒ 「边缘模式」 work mode never registered on the desktop.
//
// Nothing noticed, because `verify-installable.mjs` walks `dist/installable/`
// only — **the tarball was never checked at all**. It could go stale (or lose a
// file, or gain config/edge.json) with the whole gate chain green.
//
// ## What this script checks
//
// For each variant's tarball:
//   1. the file exists and the single top-level entry is `package`;
//   2. `dsh.bundle.patch` is a LIST and every file it names is inside the
//      tarball (§7.153 — the string form silently drops the preset layer);
//   3. `engines.dsh` is declared (the host's compatibility gate needs it);
//   4. `lib/index.js` AND `lib/client.js` are inside (§7.145 — the browser half
//      is an esbuild artifact; missing it makes the Edge tab vanish silently);
//   5. `config/edge.json` is NOT inside (plaintext operator credentials);
//   6. `scripts` / `devDependencies` were dropped (a directory dependency's
//      `prepare` would run at install time and demand build approval);
//   7. the manifest agrees with `dist/installable/<variant>/package.json` on the
//      fields that matter — this is the anti-staleness check: a tarball built
//      before a manifest change fails here;
//   8. §7.207: the tarball carries a README.md, and it is byte-identical to the
//      repository's — "the shipped README is the current README" must not be a
//      coincidence that can silently rot.
//
// Run via:
//   node scripts/verify-tarball.mjs             # audit the real artifacts
//   node scripts/verify-tarball.mjs --selftest  # self-proof + refutation
//
// Exit codes: 0 = pass; 1 = an artifact is not sound; 2 = selftest failed.
//
// Read-only: writes nothing inside the repository.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { configShipViolations, describeConfigViolation } from './_config-ship-policy.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')

/** The two bundle variants this repo ships. */
const VARIANTS = [
  { dir: 'dsh-edge-agent-desktop-safe', tarball: 'dsh-edge-agent-desktop-safe.tar.gz' },
  { dir: 'dsh-edge-agent-full', tarball: 'dsh-edge-agent-full.tar.gz' },
]

/** The Agent Preset layer must be part of the patch list, not the whole story. */
const PRESET_LAYER = /presets\/.*\.patch\.yml$/

/* ── tar reading ─────────────────────────────────────────────────────────── */

/**
 * List a tarball's entries and read one file out of it.
 *
 * Uses the system `tar` (GNU tar / bsdtar / Git Bash tar all support these
 * flags). `tar -tzf` lists; `tar -xzOf <archive> <member>` streams one member
 * to stdout.
 */
function readTarball(path) {
  const list = execFileSync('tar', ['-tzf', path], {
    encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
  })
  const entries = list.split('\n').map((line) => line.trim().replace(/\\/g, '/')).filter(Boolean)
  const files = entries.filter((e) => !e.endsWith('/')).map((e) => e.replace(/^package\//, ''))
  const tops = new Set(entries.map((e) => e.split('/')[0]))
  const read = (member) => execFileSync('tar', ['-xzOf', path, `package/${member}`], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
  })
  return { entries, files, tops, read }
}

/* ── the audit ───────────────────────────────────────────────────────────── */

/**
 * Audit one tarball against the contract.
 *
 * @param {string} tarballPath
 * @param {string} installableDir the sibling installable directory
 * @param {{ expectSecretConfig?: boolean }} [opts]
 *   `expectSecretConfig: true` audits a DEMO artifact (§7.160) — one that is
 *   SUPPOSED to carry config/edge.json, because the operator decided the
 *   artifact is for demo on their own machine and carries the live
 *   configuration. The distributable artifact must never carry it.
 *   §7.182: the DEMO build sources that file from 顺位 2
 *   (~/.dsh-edge-agent/edge.json), not from the repository.
 * @returns {{ failures: string[], notes: string[] }}
 */
export function auditTarball(tarballPath, installableDir, { expectSecretConfig = false } = {}) {
  const failures = []
  const notes = []

  if (!existsSync(tarballPath)) {
    return { failures: [`tarball 不存在：${relative(ROOT, tarballPath)}（先跑 \`node scripts/_pack-core.mjs tarball\`）`], notes }
  }

  let tarball
  try {
    tarball = readTarball(tarballPath)
  } catch (err) {
    return { failures: [`tarball 读不出来：${relative(ROOT, tarballPath)} — ${String(err.message).slice(0, 120)}`], notes }
  }

  // ── 1. npm/pnpm expect exactly one top-level entry named `package` ────────
  if (tarball.tops.size !== 1 || !tarball.tops.has('package')) {
    failures.push(
      `顶层目录必须是且只能是 \`package\`（npm/pnpm 的期望），实际是：${[...tarball.tops].join(', ')}`,
    )
  }

  // ── the manifest ─────────────────────────────────────────────────────────
  let manifest
  try {
    manifest = JSON.parse(tarball.read('package.json'))
  } catch (err) {
    failures.push(`tarball 里读不出 package.json：${String(err.message).slice(0, 120)}`)
    return { failures, notes }
  }

  // ── 2. dsh.bundle.patch must be the LIST form (§7.153) ───────────────────
  const patch = manifest?.dsh?.bundle?.patch
  if (patch === undefined) {
    failures.push('tarball 的 package.json 没有声明 dsh.bundle.patch ⇒ 宿主不会把它当 bundle（not-bundle）')
  } else if (typeof patch === 'string') {
    failures.push(
      'dsh.bundle.patch 写成了字符串形式 —— 这会静默丢掉 Agent Preset 层：'
      + '「边缘模式」这个工作方式永远不会注册（§7.153）。必须写成列表。',
    )
  } else if (!Array.isArray(patch) || patch.length === 0) {
    failures.push('dsh.bundle.patch 既不是非空数组也不是字符串')
  } else {
    // every declared patch file must be inside the tarball
    for (const p of patch) {
      const rel = String(p).replace(/^\.\//, '')
      if (!tarball.files.includes(rel)) {
        failures.push(`dsh.bundle.patch 声明了 ${rel}，但它不在 tarball 里 ⇒ 宿主装完会报 "failed to read overlay"`)
      }
    }
    // the preset layer must be there — this is the §7.153 regression guard
    if (!patch.some((p) => PRESET_LAYER.test(String(p).replace(/^\.\//, '')))) {
      failures.push(
        'dsh.bundle.patch 没有包含 presets/*.patch.yml ⇒ Agent Preset 层缺席 ⇒ '
        + '「边缘模式」工作方式不会出现在设置页（§7.153）',
      )
    }
    notes.push(`patch 层 ${patch.length} 个：${patch.join(', ')}`)
  }

  // ── 3. engines.dsh must be declared ─────────────────────────────────────
  if (!manifest?.engines?.dsh) {
    failures.push('tarball 的 package.json 没有声明 engines.dsh ⇒ 宿主会回退到查 peer 范围（不保证与本仓一致）')
  }

  // ── 4. the two entry points must be inside ───────────────────────────────
  for (const entry of ['lib/index.js', 'lib/client.js']) {
    if (!tarball.files.includes(entry)) {
      failures.push(
        `tarball 里没有 ${entry} —— `
        + (entry === 'lib/client.js'
          ? '浏览器半侧是 esbuild 产物，compile 产不出来；缺了它 Edge tab 会静默不出现（§7.145）'
          : '宿主入口缺失，装完加载不了'),
      )
    }
  }

  // ── 5. the plaintext credential file: EXCLUDED from the DISTRIBUTABLE
  //      artifact, REQUIRED in the DEMO one (§7.160) ────────────────────────
  //      §7.182 (2026-11-11): the DEMO build sources the live config from
  //      顺位 2 (~/.dsh-edge-agent/edge.json) — the repository's config/
  //      directory is no longer a supported drop point. The rule itself is
  //      unchanged: distributable artifacts never carry the plaintext file.
  if (expectSecretConfig) {
    if (!tarball.files.includes('config/edge.json')) {
      failures.push(
        'DEMO 包里没有 config/edge.json —— 它存在的意义就是带上活配置，'
        + '好让没配置过的机器装上就能用（否则顺位 1 落空 → 本地路由不注册 → '
        + '边缘模式被隐私裁决拦下）',
      )
    } else {
      notes.push('DEMO：含 config/edge.json（明文凭据，勿分发）')
    }
  } else if (tarball.files.includes('config/edge.json')) {
    failures.push('tarball 里含 config/edge.json —— 那是运维的明文 API key，绝不能进可分发产物')
  }
  if (!tarball.files.includes('config/edge.example.json')) {
    notes.push('tarball 里没有 config/edge.example.json（空密钥模板）—— 装完用户拿不到模板')
  }

  // ── 5b. §7.189: config/ 里只允许出货**白名单**上的文件 ──────────────────
  //      光看 `config/edge.json` 在不在是不够的：它的**兄弟** `edge.json.bak-<时间戳>`
  //      装的是同一份明文密钥（实测 2026-11-11，那份备份带着 5 个真 API key
  //      进了 tarball / installable / npm-stage 三个发布面）。同理 `.DS_Store`
  //      这类编辑器垃圾也不该出货。
  for (const v of configShipViolations(tarball.files, { allowSecretConfig: expectSecretConfig })) {
    failures.push(`tarball 里含 ${describeConfigViolation(v)} —— 产物不得夹带它`)
  }

  // ── 6. scripts / devDependencies must be gone ────────────────────────────
  if (manifest.scripts !== undefined) {
    failures.push('tarball 的 package.json 还带 scripts —— 目录/tarball 依赖的 prepare 会在安装时触发并要求构建授权')
  }
  if (manifest.devDependencies !== undefined) {
    failures.push('tarball 的 package.json 还带 devDependencies —— 装到用户机器上会拖一堆开发依赖')
  }

  // ── 7. anti-staleness: agree with the installable directory ─────────────
  const installablePkg = join(installableDir, 'package.json')
  if (!existsSync(installablePkg)) {
    notes.push(`没有 ${relative(ROOT, installablePkg)} ⇒ 跳过与 installable 目录的一致性比对`)
  } else {
    const other = JSON.parse(readFileSync(installablePkg, 'utf8'))
    const norm = (v) => JSON.stringify(v)
    for (const field of ['version', 'main', 'engines']) {
      if (norm(manifest[field]) !== norm(other[field])) {
        failures.push(
          `tarball 的 package.json#${field} 与 ${relative(ROOT, installablePkg)} 不一致 `
          + `(${norm(manifest[field])} vs ${norm(other[field])}) ⇒ tarball 是陈旧产物，重新构建`
        )
      }
    }
    if (norm(manifest?.dsh?.bundle?.patch) !== norm(other?.dsh?.bundle?.patch)) {
      failures.push(
        `tarball 的 dsh.bundle.patch 与 ${relative(ROOT, installablePkg)} 不一致 `
        + `(${norm(manifest?.dsh?.bundle?.patch)} vs ${norm(other?.dsh?.bundle?.patch)}) ⇒ tarball 是陈旧产物，重新构建`
      )
    }
  }

  // ── 8. §7.207: the tarball must carry the CURRENT README ────────────────
  //    The git release channel (§7.201) hands these tarballs to users directly
  //    — if the README is missing or stale, the package page and the release
  //    asset tell two different stories.
  const repoReadme = join(ROOT, 'README.md')
  if (!tarball.files.includes('README.md')) {
    failures.push(
      'tarball 里没有 README.md —— §7.207: tar 包是直接发给用户的产物（GitHub Release 资产），'
      + '它必须带着**当前**的 README（README.md 已在 package.json#files 白名单里）',
    )
  } else if (!existsSync(repoReadme)) {
    notes.push('仓库根没有 README.md ⇒ 跳过 README 内容比对')
  } else {
    const shipped = tarball.read('README.md')
    const current = readFileSync(repoReadme, 'utf8')
    if (shipped !== current) {
      failures.push(
        'tarball 里的 README.md 与仓库根的不一致 ⇒ 出货的是**陈旧** README'
        + `（包内 ${shipped.length} 字节 vs 仓库 ${current.length} 字节）—— 重新构建`,
      )
    } else {
      notes.push(`README.md 与仓库一致（${current.length} 字节）`)
    }
  }

  notes.push(`条目 ${tarball.files.length} 个`)
  return { failures, notes }
}

/* ── self-proof + refutation ────────────────────────────────────────────── */

/**
 * Build tarball fixtures in a temp dir and assert the auditor turns red for
 * each defect and green for the sound shape.
 */
function selftest() {
  let failures = 0
  const expect = (label, actual, wanted) => {
    const ok = actual === wanted
    if (!ok) failures++
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label} — expected ${wanted}, got ${actual}`)
  }

  const ROOT_TMP = mkdtempSync(join(tmpdir(), 'dsh-tarball-selftest-'))
  const mk = (name, files, manifest) => {
    const dir = join(ROOT_TMP, name)
    mkdirSync(join(dir, 'package'), { recursive: true })
    for (const [rel, content] of Object.entries(files)) {
      const p = join(dir, 'package', rel)
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, content)
    }
    writeFileSync(join(dir, 'package', 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    execFileSync('tar', ['-czf', join(dir, 'x.tar.gz'), '-C', dir, 'package'], { stdio: 'ignore' })
    return join(dir, 'x.tar.gz')
  }

  const GOOD_FILES = {
    'lib/index.js': 'export {}\n',
    'lib/client.js': 'export {}\n',
    'cordis.desktop-safe.patch.yml': '[]\n',
    'presets/edge.desktop-safe.patch.yml': '[]\n',
    'config/edge.example.json': '{}\n',
    // §7.207: the shipped README must be the repository's, byte for byte.
    'README.md': readFileSync(join(ROOT, 'README.md'), 'utf8'),
  }
  const GOOD_MANIFEST = {
    name: '@dsh-edge/dsh-edge-agent',
    version: '0.1.1-desktop-safe',
    main: 'lib/index.js',
    engines: { node: '^22.19 || >=24', dsh: '>=0.2.1-rc.2' },
    dsh: { bundle: { patch: ['./cordis.desktop-safe.patch.yml', './presets/edge.desktop-safe.patch.yml'] } },
  }

  console.log('verify-tarball --selftest')

  // 1. the sound shape passes.
  {
    const t = mk('good', GOOD_FILES, GOOD_MANIFEST)
    const r = auditTarball(t, join(ROOT_TMP, 'nonexistent'))
    expect('正确形状 ⇒ 无失败', r.failures.length, 0)
  }

  // 2. §7.153 regression: the STRING form of dsh.bundle.patch is caught.
  {
    const t = mk('stringform', GOOD_FILES, { ...GOOD_MANIFEST, dsh: { bundle: { patch: './cordis.desktop-safe.patch.yml' } } })
    const r = auditTarball(t, join(ROOT_TMP, 'nonexistent'))
    expect('patch 写成字符串 ⇒ 报失败', r.failures.length > 0, true)
    expect('失败信息点名字符串形式', r.failures.some((f) => f.includes('字符串形式')), true)
  }

  // 3. the preset layer missing is caught even in list form.
  {
    const t = mk('nopreset', GOOD_FILES, { ...GOOD_MANIFEST, dsh: { bundle: { patch: ['./cordis.desktop-safe.patch.yml'] } } })
    const r = auditTarball(t, join(ROOT_TMP, 'nonexistent'))
    expect('列表里没有 presets 层 ⇒ 报失败', r.failures.some((f) => f.includes('presets/')), true)
  }

  // 4. a declared patch file that is not inside is caught.
  {
    const t = mk('missingpatch', GOOD_FILES, {
      ...GOOD_MANIFEST,
      dsh: { bundle: { patch: ['./cordis.desktop-safe.patch.yml', './presets/edge.desktop-safe.patch.yml', './nope.yml'] } },
    })
    const r = auditTarball(t, join(ROOT_TMP, 'nonexistent'))
    expect('声明了不在包里的 patch ⇒ 报失败', r.failures.some((f) => f.includes('nope.yml')), true)
  }

  // 5. missing lib/client.js is caught (§7.145).
  {
    const { 'lib/client.js': _omit, ...files } = GOOD_FILES
    const t = mk('noclient', files, GOOD_MANIFEST)
    const r = auditTarball(t, join(ROOT_TMP, 'nonexistent'))
    expect('缺 lib/client.js ⇒ 报失败', r.failures.some((f) => f.includes('lib/client.js')), true)
  }

  // 6. config/edge.json inside is caught.
  {
    const t = mk('withsecret', { ...GOOD_FILES, 'config/edge.json': '{"secrets":{}}' }, GOOD_MANIFEST)
    const r = auditTarball(t, join(ROOT_TMP, 'nonexistent'))
    expect('含 config/edge.json ⇒ 报失败', r.failures.some((f) => f.includes('config/edge.json')), true)
  }

  // 6b. §7.160: the DEMO artifact inverts that rule — it MUST carry the
  //     live configuration, otherwise it is just a copy of the distributable
  //     one and buys the operator nothing.
  {
    const t = mk('demo', { ...GOOD_FILES, 'config/edge.json': '{"secrets":{}}' }, GOOD_MANIFEST)
    const r = auditTarball(t, join(ROOT_TMP, 'nonexistent'), { expectSecretConfig: true })
    expect('DEMO 包含 config/edge.json ⇒ 无失败', r.failures.length, 0)
    expect('DEMO 包被标注含明文凭据', r.notes.some((n) => n.includes('DEMO')), true)
  }

  // 6c. a DEMO artifact WITHOUT the config is caught.
  {
    const t = mk('demo-missing', GOOD_FILES, GOOD_MANIFEST)
    const r = auditTarball(t, join(ROOT_TMP, 'nonexistent'), { expectSecretConfig: true })
    expect('DEMO 包缺 config/edge.json ⇒ 报失败', r.failures.some((f) => f.includes('DEMO')), true)
  }

  // 6d. §7.189: the live config's BACKUP is caught too — an exact-name check
  //     (`config/edge.json`) misses it, and that is how 5 real API keys
  //     reached the tarball on 2026-11-11.
  {
    const t = mk('withbak', { ...GOOD_FILES, 'config/edge.json.bak-20261029-220133': '{}' }, GOOD_MANIFEST)
    const r = auditTarball(t, join(ROOT_TMP, 'nonexistent'))
    expect('含 config/edge.json.bak-* ⇒ 报失败', r.failures.some((f) => f.includes('edge.json.bak-20261029-220133')), true)
  }

  // 6e. §7.189: editor junk is caught too.
  {
    const t = mk('withdsstore', { ...GOOD_FILES, 'config/.DS_Store': 'x' }, GOOD_MANIFEST)
    const r = auditTarball(t, join(ROOT_TMP, 'nonexistent'))
    expect('含 config/.DS_Store ⇒ 报失败', r.failures.some((f) => f.includes('.DS_Store')), true)
  }

  // 7. missing engines.dsh is caught.
  {
    const t = mk('noengines', GOOD_FILES, { ...GOOD_MANIFEST, engines: { node: '^22.19' } })
    const r = auditTarball(t, join(ROOT_TMP, 'nonexistent'))
    expect('缺 engines.dsh ⇒ 报失败', r.failures.some((f) => f.includes('engines.dsh')), true)
  }

  // 8. leftover scripts is caught.
  {
    const t = mk('withscripts', GOOD_FILES, { ...GOOD_MANIFEST, scripts: { prepare: 'node x.mjs' } })
    const r = auditTarball(t, join(ROOT_TMP, 'nonexistent'))
    expect('还带 scripts ⇒ 报失败', r.failures.some((f) => f.includes('scripts')), true)
  }

  // 9. a wrong top-level directory name is caught.
  {
    const dir = join(ROOT_TMP, 'wrongtop')
    mkdirSync(join(dir, 'notpackage'), { recursive: true })
    writeFileSync(join(dir, 'notpackage', 'package.json'), JSON.stringify(GOOD_MANIFEST))
    execFileSync('tar', ['-czf', join(dir, 'x.tar.gz'), '-C', dir, 'notpackage'], { stdio: 'ignore' })
    const r = auditTarball(join(dir, 'x.tar.gz'), join(ROOT_TMP, 'nonexistent'))
    expect('顶层目录不叫 package ⇒ 报失败', r.failures.some((f) => f.includes('package')), true)
  }

  // 10. a stale tarball (manifest disagrees with the installable dir) is caught.
  {
    const t = mk('stale', GOOD_FILES, { ...GOOD_MANIFEST, version: '0.1.0-desktop-safe' })
    const installable = join(ROOT_TMP, 'stale-installable')
    mkdirSync(installable, { recursive: true })
    writeFileSync(join(installable, 'package.json'), JSON.stringify({ ...GOOD_MANIFEST, version: '0.1.1-desktop-safe' }))
    const r = auditTarball(t, installable)
    expect('版本与 installable 目录不一致 ⇒ 报失败', r.failures.some((f) => f.includes('陈旧产物')), true)
  }

  // 11. §7.207: a tarball WITHOUT the README is caught, and one with a STALE
  //     README is caught too — "the shipped README is the current README"
  //     must be enforced, not assumed.
  {
    const { 'README.md': _omit, ...files } = GOOD_FILES
    const t = mk('noreadme', files, GOOD_MANIFEST)
    const r = auditTarball(t, join(ROOT_TMP, 'nonexistent'))
    expect('缺 README.md ⇒ 报失败', r.failures.some((f) => f.includes('README.md')), true)
  }
  {
    const t = mk('stalereadme', { ...GOOD_FILES, 'README.md': '# 旧 README\n' }, GOOD_MANIFEST)
    const r = auditTarball(t, join(ROOT_TMP, 'nonexistent'))
    expect('README 与仓库不一致 ⇒ 报失败', r.failures.some((f) => f.includes('陈旧')), true)
  }

  rmSync(ROOT_TMP, { recursive: true, force: true })

  if (failures > 0) {
    console.error(`\nselftest FAILED: ${failures} assertion(s)`)
    process.exit(2)
  }
  console.log('\nselftest OK — 门禁能抓住缺 preset 层 / 缺 client.js / 含密钥 / 陈旧产物，也能放过正确的形状')
}

/* ── entry ───────────────────────────────────────────────────────────────── */

const args = process.argv.slice(2)
if (args.includes('--selftest')) {
  selftest()
} else if (args.length > 0) {
  console.error('usage: node scripts/verify-tarball.mjs [--selftest]')
  process.exit(2)
} else {
  const failures = []
  let audited = 0
  for (const variant of VARIANTS) {
    const tarballPath = join(DIST, variant.tarball)
    const installableDir = join(DIST, 'installable', variant.dir)
    const result = auditTarball(tarballPath, installableDir)
    audited++
    const rel = relative(ROOT, tarballPath)
    if (result.failures.length === 0) {
      console.log(`verify-tarball: ${rel} OK（${result.notes.join('；')}）`)
    } else {
      console.error(`verify-tarball: ${rel} 不合格：`)
      for (const f of result.failures) console.error(`  - ${f}`)
      failures.push(...result.failures)
    }
  }
  // §7.160: the DEMO artifact, when it exists, is audited with the INVERTED
  // credential rule (it MUST carry config/edge.json). It is optional — the
  // distributable build never produces it — but if it is there, it has to be
  // the thing it claims to be. §7.182: its config comes from 顺位 2
  // (~/.dsh-edge-agent/edge.json), not from the repository.
  for (const variant of VARIANTS) {
    const demoPath = join(DIST, variant.tarball.replace(/\.tar\.gz$/u, '-DEMO.tar.gz'))
    if (existsSync(demoPath)) {
      const installableDir = join(DIST, 'installable', variant.dir)
      const demo = auditTarball(demoPath, installableDir, { expectSecretConfig: true })
      audited++
      const demoRel = relative(ROOT, demoPath)
      if (demo.failures.length === 0) {
        console.log(`verify-tarball: ${demoRel} OK（DEMO；${demo.notes.join('；')}）`)
      } else {
        console.error(`verify-tarball: ${demoRel} 不合格：`)
        for (const f of demo.failures) console.error(`  - ${f}`)
        failures.push(...demo.failures)
      }
    }
  }
  if (failures.length > 0) {
    console.error(`\nverify-tarball FAILED: ${failures.length} 项`)
    process.exit(1)
  }
  console.log(`verify-tarball OK (audited: ${audited} 个 tarball)`)
}
