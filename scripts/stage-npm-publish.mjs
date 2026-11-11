#!/usr/bin/env node
/**
 * stage-npm-publish.mjs — §7.188：把「要发给 registry 的那个包」摆到 `dist/.npm-stage/`。
 *
 * ## 为什么要有这一步（2026-11-11 实测）
 *
 * 0.1.1 发布出去的 `package.json` 带着**仓库根清单**的 `scripts.*`（50 余条）和一整套
 * `devDependencies` —— 而它们指向的 `scripts/`、`src/`、`tests/` **不在 tarball 里**
 * （`files` 白名单只放 `lib` / `config` / `presets` / 几个 yml / `CHANGELOG.md`）。
 *
 * ⇒ 清单声称了并不存在的东西。对消费者**无害**（registry 安装不触发 `prepare`，
 * 包里也没有 `postinstall`），但它是**清单与内容不一致**。
 *
 * ## 为什么不改仓库根的 package.json
 *
 * 仓库根的 `scripts` / `devDependencies` 是**仓库自己**要用的（构建链、门禁、单测）
 * ⇒ 不能删。⇒ 只能**另摆一份**「发布用清单」，从那里发。
 *
 * 顺带：`desktop-safe` 变体的清单**本来就**没有 `scripts` / `devDependencies`
 * （`scripts/_pack-core.mjs` 的 `stageVariant()` 删的）⇒ 本脚本基本是「把变体清单
 * 的版本号换回纯 semver」。
 *
 * ## 与 CI 的关系（不能分叉）
 *
 * CI 的 publish job 以前在仓库根跑 `pnpm publish`。现在**两边都从 `dist/.npm-stage`
 * 跑同一条 `pnpm publish`** ⇒ 「本地 dry-run 与 CI 真发是同一条命令」这条纪律
 * 仍然成立，只是 cwd 换了个目录。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/stage-npm-publish.mjs            # 摆好暂存目录
 * node scripts/stage-npm-publish.mjs --selftest  # 自证（纯函数，不碰 dist/）
 * ```
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 已构建好的 safe 变体目录（`build:installable` 的产物）。 */
export const VARIANT_DIR = join(ROOT, 'dist', 'installable', 'dsh-edge-agent-desktop-safe')

/** 暂存目录 —— `pnpm publish` 的 cwd。 */
export const STAGE_DIR = join(ROOT, 'dist', '.npm-stage')

/** 仓库根清单的版本号 —— 发布出去的版本必须是它。 */
export function repoVersion(root = ROOT) {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
}

/**
 * 从变体清单合成**发布用清单**。
 *
 * - 版本：仓库根的版本（**不带** `-desktop-safe` 后缀 —— npm 上的版本必须是纯 semver）；
 * - 删掉 `scripts` / `devDependencies`（它们指向不在包里的文件）；
 * - 删掉 `packageManager`（pnpm 发布时会剥掉它；显式删掉更确定，产物不依赖 pnpm 的版本声明）。
 *
 * 其余字段（`name` / `exports` / `files` / `engines` / `dsh` / `peerDependencies` /
 * `publishConfig` / `repository` …）**原样保留** —— 装后校验（`dsh.bundle.patch`
 * 存在、`engines.dsh` 兼容）全靠它们。
 */
export function buildPublishManifest(variantManifest, version) {
  const pkg = { ...variantManifest }
  pkg.version = version
  delete pkg.scripts
  delete pkg.devDependencies
  delete pkg.packageManager
  return pkg
}

/**
 * 把变体目录 + README + LICENSE 摆进暂存目录，写好发布用清单。
 *
 * 内容与 0.1.1 发布的 tarball **逐文件相同**（README / LICENSE 由 npm 自动带，
 * 前提是目录里有 —— 变体目录里没有，所以这里补上）。
 */
export function stageNpmPackage({ root = ROOT, variantDir = VARIANT_DIR, stageDir = STAGE_DIR } = {}) {
  if (!existsSync(variantDir)) {
    throw new Error(`变体目录不存在：${variantDir} —— 先跑 build:installable`)
  }
  rmSync(stageDir, { recursive: true, force: true })
  mkdirSync(stageDir, { recursive: true })
  for (const entry of readdirSync(variantDir)) {
    cpSync(join(variantDir, entry), join(stageDir, entry), { recursive: true })
  }
  // README / LICENSE —— npm 永远自动带，但前提是**目录里真的有**。
  for (const f of ['README.md', 'LICENSE']) {
    const src = join(root, f)
    if (existsSync(src)) cpSync(src, join(stageDir, f))
  }
  const variantManifest = JSON.parse(readFileSync(join(variantDir, 'package.json'), 'utf8'))
  const manifest = buildPublishManifest(variantManifest, repoVersion(root))
  writeFileSync(join(stageDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return manifest
}

/* ── 自证（纯函数 + 临时目录，不碰 dist/）────────────────────────────────── */

function selftest() {
  const failures = []
  const check = (name, ok, detail) => {
    if (ok) console.log(`  ok   ${name}`)
    else {
      console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`)
      failures.push(name)
    }
  }

  // 1. 清单合成：版本换掉、三处删掉、其余保留
  {
    const variant = {
      name: '@dsh-edge/dsh-edge-agent',
      version: '9.9.9-desktop-safe',
      scripts: { build: 'x' },
      devDependencies: { a: '1' },
      packageManager: 'pnpm@11.7.0',
      exports: { '.': './lib/index.js' },
      files: ['lib'],
      peerDependencies: { '@deepseek-ai/cordis': '>=4.0.5' },
      dsh: { bundle: { patch: ['./cordis.desktop-safe.patch.yml'] } },
    }
    const m = buildPublishManifest(variant, '0.1.2')
    check('版本换成仓库版本', m.version === '0.1.2', m.version)
    check('scripts 被删', m.scripts === undefined)
    check('devDependencies 被删', m.devDependencies === undefined)
    check('packageManager 被删', m.packageManager === undefined)
    check('exports 原样保留', m.exports['.'] === './lib/index.js')
    check('files 原样保留', Array.isArray(m.files) && m.files[0] === 'lib')
    check('peerDependencies 原样保留', m.peerDependencies['@deepseek-ai/cordis'] === '>=4.0.5')
    check('dsh.bundle.patch 原样保留', m.dsh.bundle.patch[0] === './cordis.desktop-safe.patch.yml')
    check('不改原对象', variant.version === '9.9.9-desktop-safe' && variant.scripts !== undefined)
  }

  // 2. 暂存：目录内容 = 变体内容 + README + LICENSE，清单已换
  {
    const dir = join(ROOT, 'dist', '.npm-stage-selftest')
    const root = join(ROOT, 'dist', '.npm-stage-selftest-root')
    try {
      rmSync(dir, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
      mkdirSync(join(root, 'lib'), { recursive: true })
      mkdirSync(join(root, 'config'), { recursive: true })
      writeFileSync(join(root, 'lib', 'index.js'), 'export const x = 1\n', 'utf8')
      writeFileSync(join(root, 'config', 'edge.example.json'), '{}\n', 'utf8')
      writeFileSync(join(root, 'README.md'), '# r\n', 'utf8')
      writeFileSync(join(root, 'LICENSE'), 'MIT\n', 'utf8')
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', version: '0.1.2' }), 'utf8')

      const m = stageNpmPackage({ root, variantDir: root, stageDir: dir })
      check('清单版本正确', m.version === '0.1.2', m.version)
      check('lib 被搬过来', existsSync(join(dir, 'lib', 'index.js')))
      check('config 被搬过来', existsSync(join(dir, 'config', 'edge.example.json')))
      check('README 被搬过来', existsSync(join(dir, 'README.md')))
      check('LICENSE 被搬过来', existsSync(join(dir, 'LICENSE')))
      const written = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      check('暂存目录里的清单已换', written.version === '0.1.2')
      check('暂存目录里没有 scripts', !existsSync(join(dir, 'scripts')))
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    }
  }

  if (failures.length > 0) {
    console.error(`selftest: ${failures.length} check(s) failed`)
    process.exit(1)
  }
  console.log('selftest: all checks passed')
}

const isEntryPoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isEntryPoint) {
  if (process.argv.includes('--selftest')) {
    selftest()
  } else {
    const manifest = stageNpmPackage()
    console.log('stage:npm')
    console.log(`  暂存目录   : ${STAGE_DIR}`)
    console.log(`  清单版本   : ${manifest.version}`)
    console.log(`  scripts    : ${manifest.scripts ? '有（不该有！）' : '无 ✓'}`)
    console.log(`  devDeps    : ${manifest.devDependencies ? '有（不该有！）' : '无 ✓'}`)
    console.log(`  bundle.patch: ${(manifest.dsh?.bundle?.patch ?? []).length} 个文件`)
  }
}
