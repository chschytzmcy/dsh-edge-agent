// scripts/verify-local-channel.mjs — §7.162: the gate on the LOCAL-DIRECTORY
// channel (the `link:` form) and on how a directory may be handed to pnpm.
//
// ## The failure it exists to prevent
//
// The operator's ruling (2026-10-30):
//
//   > 主要保证 npm 和 git 仓库部署的时候没有 edge.json 即可，目录采用 link
//   > 方式、实时更新，tar 包方式包括真实 edge.json，可以用于演示
//
// "目录采用 link 方式、实时更新" is a CONTRACT, and until now nothing checked
// it. Measured on 2026-10-30 (three real installs into throwaway profiles,
// `node scripts/_pack-core.mjs` installable dir as the source):
//
//   spec                        profile 里记成        node_modules      实时?  带活配置?
//   <裸绝对路径>                 link:<绝对路径>        符号链接          是      是
//   link:<绝对路径>             link:<绝对路径>        符号链接          是      是
//   file:<绝对路径>             file:<绝对路径>        真实副本(冻结)     否      **否**
//
// ⇒ `file:` on a DIRECTORY is a silent trap, and it breaks the ruling in BOTH
//   ways at once:
//
//   1. FROZEN. pnpm packs the directory into the store instead of linking it,
//      so "改文件重启即生效" stops being true.
//   2. THE LIVE CONFIG IS DROPPED. The pack honours the manifest's `files`
//      whitelist, and that whitelist excludes `config/edge.json`
//      ("!config/edge.json"). So the installed copy has NO live config ⇒ the
//      host's config candidate #1 (`<bundle>/config/edge.json`) misses ⇒ the
//      plugin falls back to `~/.dsh-edge-agent/edge.json` or the blank
//      template ⇒ the local-LLM route may never register ⇒ every LOCAL turn
//      is blocked by the privacy ruling.
//
// The host makes this worse, not better: `install-spec.ts:69-92` strips ONE
// `file:` / `link:` prefix and classifies by EXTENSION only — a directory is
// `kind: 'path'` no matter which prefix it carries — and then hands the spec
// to pnpm VERBATIM (`index.ts:930` `pnpm add <spec>`). So the host accepts
// `file:<dir>` without a word and the operator finds out only when the code
// stops updating.
//
// ## What this gate checks
//
//   1. The installable manifest's `files` whitelist carries the
//      "!config/edge.json" negation ⇒ a pack of the directory can never carry
//      the operator's plaintext API key into node_modules.
//   2. The installable manifest's `files` whitelist EQUALS the repo root's
//      ⇒ the two producers of that directory cannot drift apart.
//   3. The documentation tells the operator to use `link:` (or a bare
//      absolute path) for a directory, and says what `file:` on a directory
//      costs.
//   4. The build scripts install the local directory with `link:`, never with
//      `file:`.
//   5. §7.182: the same doc must name the operator's config location —
//      `~/.dsh-edge-agent/edge.json` (顺位 2).
//
// Run via:
//   node scripts/verify-local-channel.mjs             # audit the real tree
//   node scripts/verify-local-channel.mjs --selftest  # self-proof + refutation
//
// Exit codes: 0 = pass; 1 = the contract is broken; 2 = selftest failed.
//
// Read-only: writes nothing inside the repository.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { variantByDir, variantFiles } from './_bundle-variants.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The negation that keeps the plaintext key out of every pack of the dir. */
const SECRET_NEGATION = '!config/edge.json'

/**
 * The docs that tell an operator how to install the local directory.
 *
 * Each entry is [file, required fragments]. A fragment is a plain substring;
 * the Chinese text carries the meaning, the ASCII fragments keep the check
 * stable across wording changes.
 *
 * §7.163: the second entry (docs/config-reference.md) was removed when the
 * three strategy/config documents were merged into docs/privacy-policy.md.
 * Its required fragments were a duplicate of load-into-local-dsh.md's — that
 * document is where the local-channel install rules actually live, so the
 * assertion stays pointed there instead of at a file that no longer exists.
 */
const DOC_REQUIREMENTS = [
  {
    file: 'docs/load-into-local-dsh.md',
    required: ['link:', 'file:', '~/.dsh-edge-agent/edge.json'],
  },
]

/**
 * The shell wrappers that switch the desktop profile between the two modes.
 *
 * `--install-desktop=link` must install the local DIRECTORY through a link
 * (either an explicit `link:` spec or a bare absolute path — pnpm records
 * BOTH as `link:`, measured); `--install-desktop=tar` must use `file:` on the
 * TARBALL, where `file:` is correct (a tarball is a file, not a directory).
 */
const BUILD_SCRIPTS = [
  'scripts/build-desktop-bundle.sh',
  'scripts/build-windows.sh',
  'scripts/build-linux.sh',
  'scripts/build-macos.sh',
]

/** Collected failures; the script reports them all at once. */
const failures = []
const check = (ok, message) => { if (!ok) failures.push(message) }

/**
 * Read a repo-relative file as UTF-8, or undefined when it does not exist.
 *
 * @param {string} rel
 * @returns {string | undefined}
 */
function readRepoFile(rel) {
  const path = join(ROOT, rel)
  if (!existsSync(path)) return undefined
  return readFileSync(path, 'utf8')
}

/* ── 1 + 2. the installable manifests' `files` whitelist ─────────────────── */

function verifyInstallableWhitelists() {
  const rootManifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const expected = rootManifest.files
  check(
    Array.isArray(expected) && expected.includes(SECRET_NEGATION),
    `仓库根 package.json#files 缺少 "${SECRET_NEGATION}" ⇒ npm 包会把明文 API key 发出去`,
  )

  const installableRoot = join(ROOT, 'dist', 'installable')
  if (!existsSync(installableRoot)) {
    // Nothing built yet — the other gate (verify-installable) reports that.
    return 0
  }
  const dirs = readdirSync(installableRoot)
    .map((name) => join(installableRoot, name))
    .filter((p) => existsSync(join(p, 'package.json')))

  for (const dir of dirs) {
    const rel = dir.slice(ROOT.length + 1).replaceAll('\\', '/')
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const files = pkg.files

    check(
      Array.isArray(files) && files.includes(SECRET_NEGATION),
      `${rel}: package.json#files 缺少 "${SECRET_NEGATION}" `
      + `（当前 ${JSON.stringify(files)}）⇒ \`pnpm add file:<目录>\` 走 pack 路径时`
      + '会把本机 config/edge.json 里的明文 API key 拷进 node_modules。',
    )
    // §7.209: 基准是**本变体**的派生清单，不是仓库根清单 ——
    // 变体必须**不带**别的变体的补丁（safe 不带 full 的两个 yml）。
    // 基准仍由同一份派生给出（scripts/_bundle-variants.mjs#variantFiles）。
    const variant = variantByDir(basename(dir))
    const expectedForVariant = variant
      ? variantFiles(rootManifest, variant)
      : rootManifest.files
    check(
      JSON.stringify(files) === JSON.stringify(expectedForVariant),
      `${rel}: package.json#files 是 ${JSON.stringify(files)}，`
      + `但${variant ? ` ${variant.dir} 变体的派生清单` : '仓库根'}是 ${JSON.stringify(expectedForVariant)} `
      + '⇒ 两条产出路径（rebuild-installable.mjs / _pack-core.mjs）的白名单漂移了。',
    )
  }
  return dirs.length
}

/* ── 3. the documentation ────────────────────────────────────────────────── */

function verifyDocs() {
  for (const { file, required } of DOC_REQUIREMENTS) {
    const text = readRepoFile(file)
    if (text === undefined) {
      check(false, `${file} 不存在 —— 目录通道的写法说明没了`)
      continue
    }
    for (const fragment of required) {
      check(
        text.includes(fragment),
        `${file} 里没有 "${fragment}" ⇒ 没告诉主人目录通道该怎么写、file: 会付出什么代价`,
      )
    }
    // The trap itself must be named, not implied.
    check(
      /file:[^\n]*目录|目录[^\n]*file:/u.test(text),
      `${file} 没有把「file: 指向目录」这件事与「目录」放在同一段说明里 `
      + '⇒ 主人看不出 file:<目录> 与 link:<目录> 的差别',
    )
  }
}

/* ── 4. the build scripts ────────────────────────────────────────────────── */

/**
 * The spec a script hands to `dsh plugin … add` in each mode.
 *
 * Two shapes are accepted for the link mode, and both are correct (measured):
 *   · an explicit `link:<dir>` spec;
 *   · a BARE absolute path to the directory — pnpm records it as `link:`
 *     anyway, so it produces the same symlinked, live install.
 *
 * What must never appear is a `file:` prefix on a DIRECTORY: that packs the
 * directory into a frozen copy AND drops the live config.
 *
 * The extraction keys on the SHAPE of the spec (prefix + whether the path
 * names a tarball), not on the shell variable it comes from — the four
 * wrappers spell it differently (`SPEC="link:$INSTALLABLE_DIR"` vs
 * `spec="$DIST/installable/…"`, `file:$TARBALL` vs
 * `file:$DIST/…tar.gz`), and a gate that only recognises one spelling is a
 * gate that silently stops guarding the others.
 *
 * @param {string} text the script source
 * @returns {{ link?: string, file?: string }}
 */
export function extractSpecs(text) {
  // Every `spec=` / `SPEC=` assignment to a quoted literal.
  const specs = [...text.matchAll(/(?:^|\s)(?:spec|SPEC)="([^"]+)"/gu)].map((m) => m[1])
  const link = specs.find((s) => s.startsWith('link:'))
    ?? specs.find((s) => !s.startsWith('file:') && /installable/iu.test(s))
  const file = specs.find((s) => s.startsWith('file:'))
  return { link, file }
}

/** Does this spec text point at the installable DIRECTORY (not a tarball)? */
function pointsAtInstallableDir(spec) {
  return /installable/iu.test(spec) && !/\.tar\.gz|\.tgz/iu.test(spec)
}

/** Does this spec text point at a TARBALL? */
function pointsAtTarball(spec) {
  return /\.tar\.gz|\.tgz/iu.test(spec) || /TARBALL/u.test(spec)
}

function verifyBuildScripts() {
  for (const file of BUILD_SCRIPTS) {
    const text = readRepoFile(file)
    if (text === undefined) {
      check(false, `${file} 不存在 —— 桌面 profile 的切换脚本没了`)
      continue
    }
    const { link, file: fileSpec } = extractSpecs(text)

    check(
      link !== undefined,
      `${file} 里找不到 link 模式的 spec ⇒ --install-desktop=link 不知道用什么写法`,
    )
    if (link !== undefined) {
      check(
        pointsAtInstallableDir(link),
        `${file} 的 link 模式 spec 指向 "${link}"，不是 installable 目录 `
        + '⇒ link 通道会挂到错的东西上',
      )
      check(
        !/^file:/u.test(link),
        `${file} 的 link 模式用了 file: 前缀 ⇒ 目录会被 pack 成冻结副本并丢掉活配置`,
      )
    }

    check(
      fileSpec !== undefined,
      `${file} 里找不到 tar 模式的 spec ⇒ --install-desktop=tar 不知道用什么写法`,
    )
    if (fileSpec !== undefined) {
      check(
        pointsAtTarball(fileSpec),
        `${file} 的 tar 模式 spec 指向 "${fileSpec}"，不是 tarball `
        + '⇒ --install-desktop=tar 会把一个目录当 tarball 装（冻结 + 丢活配置）',
      )
    }
  }
}

/* ── selftest: the gate must bite, and must not bite on the sound shape ─── */

function selftest() {
  let bad = 0
  const expect = (label, actual, wanted) => {
    const ok = actual === wanted
    if (!ok) bad++
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label} — expected ${wanted}, got ${actual}`)
  }

  console.log('verify-local-channel --selftest')

  // 1. The whitelist checks are pure functions of a manifest — exercise them
  //    through the same predicates the audit uses.
  const hasNegation = (files) => Array.isArray(files) && files.includes(SECRET_NEGATION)
  expect('含排除项 ⇒ 通过', hasNegation(['lib', 'config', SECRET_NEGATION]), true)
  expect('缺排除项 ⇒ 报失败', hasNegation(['lib', 'config']), false)

  // 2. A whitelist that drifted from the root's is caught.
  const sameAsRoot = (files, root) => JSON.stringify(files) === JSON.stringify(root)
  const ROOT_FILES = ['lib', 'config', 'cordis.patch.yml', SECRET_NEGATION]
  expect('与根一致 ⇒ 通过', sameAsRoot(ROOT_FILES, ROOT_FILES), true)
  expect('与根漂移 ⇒ 报失败', sameAsRoot(['lib', 'config'], ROOT_FILES), false)

  // 3. The doc fragments: the sound shape passes, the trap without any
  //    mention of `file:` next to a directory fails.
  const mentionsTrap = (text) => /file:[^\n]*目录|目录[^\n]*file:/u.test(text)
  expect('提到 file: 目录陷阱 ⇒ 通过', mentionsTrap('用 link: 装目录；file: 指向目录会丢活配置'), true)
  expect('完全没提 file: ⇒ 报失败', mentionsTrap('用 link: 装目录即可'), false)

  // 4. The build-script specs: link mode ⇒ directory, tar mode ⇒ tarball.
  //    Both correct shapes for the link mode are accepted (explicit `link:`
  //    prefix, or a bare absolute path — pnpm records the latter as `link:`
  //    too), and `file:` on a directory is rejected.
  {
    const EXPLICIT = 'SPEC="link:$INSTALLABLE_DIR"\nSPEC="file:$TARBALL"\n'
    const BARE = 'spec="$DIST/installable/dsh-edge-agent-desktop-safe"\nspec="file:$DIST/dsh-edge-agent-desktop-safe.tar.gz"\n'

    const explicit = extractSpecs(EXPLICIT)
    expect('显式 link: 被认出（保留前缀）', explicit.link, 'link:$INSTALLABLE_DIR')
    expect('显式 link: 指向 installable ⇒ 通过', pointsAtInstallableDir(explicit.link ?? ''), true)
    expect('显式 file: 指向 tarball ⇒ 通过', pointsAtTarball(explicit.file ?? ''), true)

    const bare = extractSpecs(BARE)
    expect('裸路径形态被认出', bare.link, '$DIST/installable/dsh-edge-agent-desktop-safe')
    expect('裸路径指向 installable ⇒ 通过', pointsAtInstallableDir(bare.link ?? ''), true)
    expect('file: 指向 .tar.gz 被认出', bare.file, 'file:$DIST/dsh-edge-agent-desktop-safe.tar.gz')
    expect('file: 指向 .tar.gz ⇒ 通过', pointsAtTarball(bare.file ?? ''), true)

    // The trap: `file:` on a DIRECTORY.
    //
    // `pointsAtInstallableDir` answers "does this spec name the installable
    // directory" — and `file:$INSTALLABLE_DIR` DOES name it, so that
    // predicate is true and must stay true. What makes it a trap is the
    // PREFIX, and that is what the spec check rejects: a `file:` prefix on
    // anything that is not a tarball.
    const TRAP = 'SPEC="file:$INSTALLABLE_DIR"\n'
    const trap = extractSpecs(TRAP)
    expect('file: 指向目录被认出是 file spec（保留前缀）', trap.file, 'file:$INSTALLABLE_DIR')
    expect('file: 指向目录 ⇒ 不算 tarball', pointsAtTarball(trap.file ?? ''), false)
    expect('file: 前缀 ⇒ 该 spec 不该被当 link 模式用', /^file:/u.test(trap.file ?? ''), true)
  }

  if (bad > 0) {
    console.error(`verify-local-channel --selftest: FAILED (${bad} 项)`)
    process.exit(2)
  }
  console.log('verify-local-channel --selftest: all checks passed')
}

if (process.argv.includes('--selftest')) {
  selftest()
} else {
  const count = verifyInstallableWhitelists()
  verifyDocs()
  verifyBuildScripts()

  if (failures.length > 0) {
    console.error('verify-local-channel: FAILED')
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exit(1)
  }
  console.log(`verify-local-channel OK (${count} installable manifests, ${DOC_REQUIREMENTS.length} docs, ${BUILD_SCRIPTS.length} build scripts)`)
}
