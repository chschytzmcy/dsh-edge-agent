// Rebuild dist/installable/<variant>/ from the current build output.
//
// §7.102 (2026-10-21): the installable directories used to be maintained by
// hand (copy 6 things by hand, remember to fix the patch field, remember to
// copy config/). They drifted twice in one session: the desktop-safe variant
// shipped a `dsh.bundle.patch` pointing at a file that was not in the
// directory, and the config/ directory silently disappeared.
//
// This script makes the rebuild a single, idempotent, cross-platform command:
//
//   node scripts/rebuild-installable.mjs
//
// It reads package.json#files for the file list, so adding a shipped
// directory (e.g. "config") needs no change here.
//
// Variants:
//   dsh-edge-agent-desktop-safe — desktop profile; cordis patch is
//     cordis.desktop-safe.patch.yml and package.json#dsh.bundle.patch is
//     rewritten to point at it.
//   dsh-edge-agent-full         — full profile; cordis patch is
//     cordis.patch.yml (unchanged).
//
// Run via: node scripts/rebuild-installable.mjs

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BUNDLE_VARIANTS, bundlePatchDeclaration } from './_bundle-variants.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist', 'installable')

/** 同步睡眠（rename 重试的 backoff 用）。 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** rename 目录，带 EPERM/EBUSY/ENOTEMPTY 短退避（Windows 上 Defender/
 *  indexer 的瞬时扫描会短暂锁住刚写完的目录）。返回 false = 退避后仍
 *  锁着（活句柄，重试永远救不了——典型是运行中的桌面 App 以 `link:`
 *  挂着这个目录），由调用方决定降级路径；其他错误照抛。 */
function renameDirWithRetry(from, to, attempts = 3, delayMs = 300) {
  let lastCode
  for (let i = 0; i < attempts; i++) {
    if (i > 0) sleepSync(delayMs * i)
    try {
      renameSync(from, to)
      return true
    } catch (err) {
      lastCode = err?.code
      if (lastCode !== 'EPERM' && lastCode !== 'EBUSY' && lastCode !== 'ENOTEMPTY') throw err
    }
  }
  console.warn(`  warning: rename still locked after ${attempts} attempts (${lastCode})`)
  return false
}

/** 降级路径：把 staging 的内容逐条覆盖进 target（target 不挪窝）。
 *  §7.103 的目标本就是让 `link:` 目标路径持续有效——目录级 rename 只是
 *  手段之一；逐条替换同样达成（docs/load-into-local-dsh.md §8.2.1 的
 *  手动更新走的就是这条路）。staging 里没有、target 里残留的旧条目
 *  不主动删（无害：installable 集合由 files+patch+package.json 全量
 *  枚举）。个别条目仍被锁时告警跳过，不炸整轮。 */
function syncEntriesInPlace(staging, target) {
  const failed = []
  for (const entry of readdirSync(staging)) {
    const dst = join(target, entry)
    try {
      rmSync(dst, { recursive: true, force: true })
      cpSync(join(staging, entry), dst, { recursive: true })
    } catch (err) {
      failed.push(`${entry} (${err?.code ?? err?.message})`)
    }
  }
  if (failed.length > 0) {
    console.warn(`  warning: ${failed.length} entries could not be synced in-place: ${failed.join(', ')}`)
    console.warn(`           quit the app holding the directory and rerun for a clean atomic swap`)
  }
}

// §7.153: the variant table moved to _bundle-variants.mjs — the single source
// of truth. It used to be duplicated here and in two other scripts, and the
// copies drifted: the ones that wrote `dsh.bundle.patch` as a STRING dropped
// the Agent Preset layer, so the 边缘模式 work mode was never shipped.
const VARIANTS = BUNDLE_VARIANTS.map((v) => ({ ...v, patch: v.patchField }))

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

// The `files` array in package.json is the source of truth for what ships.
//
// Entries may carry a `!` prefix (npm's negation, e.g. "!config/edge.json"):
// those describe what must NOT reach the **npm tarball**. The installable
// bundle built here is a LOCAL artifact — the desktop profile mounts it
// through a junction and the runtime config (config/edge.json, with the
// operator's real endpoints) has to travel with it — so the whole config
// directory is copied and the negation is deliberately not applied here.
// The distributable tarballs (npm pack, `make package`) exclude it.
function shippedEntries(pkg) {
  const list = Array.isArray(pkg.files) && pkg.files.length > 0 ? pkg.files : ['lib']
  return list.filter((entry) => !entry.startsWith('!'))
}

let pkg
try {
  pkg = readJson(join(ROOT, 'package.json'))
} catch (e) {
  console.error(`rebuild-installable: cannot read package.json (${e.message})`)
  process.exit(1)
}

if (!existsSync(join(ROOT, 'lib'))) {
  console.error('rebuild-installable: lib/ not found — run `npm run build` first')
  process.exit(1)
}

mkdirSync(DIST, { recursive: true })

for (const variant of VARIANTS) {
  const target = join(DIST, variant.dir)
  // §7.103 (2026-10-22): build into a sibling temp dir and SWAP it in.
  //
  // The desktop profile installs this bundle as a pnpm `link:` pointing at
  // `dist/installable/<variant>`. Deleting that path (the old `rm -rf` here)
  // breaks the link for as long as the rebuild takes — and pnpm's watcher
  // reacts by moving the installed package into node_modules/.ignored/,
  // i.e. the plugin silently disappears from the profile and the Edge tab
  // never appears. Building beside the target and renaming keeps the link
  // path continuously valid.
  const staging = join(DIST, `.${variant.dir}.staging`)
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })

  // 1. Ship the `files` list (lib, config, presets, ...).
  for (const entry of shippedEntries(pkg)) {
    const src = join(ROOT, entry)
    if (!existsSync(src)) {
      console.error(`  warning: ${entry} not found in repo — skipped`)
      continue
    }
    cpSync(src, join(staging, entry), { recursive: true })
  }

  // 2. The cordis patch variant this bundle ships.
  const patchSrc = join(ROOT, variant.patch)
  if (!existsSync(patchSrc)) {
    console.error(`  error: ${variant.patch} not found`)
    process.exit(1)
  }
  cpSync(patchSrc, join(staging, variant.patch))

  // 3. package.json — variant-specific name/version + patch field rewrite.
  const variantPkg = readJson(join(ROOT, 'package.json'))
  variantPkg.version = `${pkg.version}${variant.versionSuffix}`
  if (!variantPkg.dsh) variantPkg.dsh = {}
  if (!variantPkg.dsh.bundle) variantPkg.dsh.bundle = {}
  // §7.135: the bundle carries TWO patch layers — the host-row overrides
  // (cordis patch) and the **Agent Preset** declaration (the 边缘模式 work
  // mode). The host's own dsh-web-app bundle uses the same array shape
  // (`"patch": ["./cordis.patch.yml", "./presets/standard.patch.yml", …]`).
  //
  // §7.153: the value now comes from the shared helper, so every writer
  // (this one, _pack-core.mjs, build-desktop-bundle.sh, _rebuild-installable.mjs)
  // produces the SAME declaration. The string form silently drops the preset
  // layer ⇒ the 边缘模式 work mode is never registered ⇒ the desktop shows no
  // such work mode, with no error anywhere.
  variantPkg.dsh.bundle.patch = bundlePatchDeclaration(variant)

  // §7.145: the browser half must exist BEFORE the bundle is published.
  //
  // `compile` (= clean-lib + tsc) wipes lib/ entirely, and the browser half
  // (`lib/client.js`) is produced by a SEPARATE step (`build:client`). A
  // build that runs `compile` without `build:client` therefore yields a
  // bundle with NO browser half — and the desktop's symptom is silent: the
  // host half mounts fine, the Edge tab simply never appears (not in the
  // guide, not in the tab strip), with nothing in the logs saying why.
  //
  // `verify:installable` already catches this, but only if it is run; this
  // check fails the BUILD, where the cause is still visible.
  const clientExport = variantPkg.exports?.['./client']
  if (variantPkg.dsh.client !== undefined && typeof clientExport === 'string') {
    const clientPath = join(ROOT, clientExport.replace(/^\.\//u, ''))
    if (!existsSync(clientPath)) {
      console.error(
        `rebuild-installable: ${variant.dir} declares dsh.client but ${clientExport} does not exist.`,
      )
      console.error('  The browser half is built by a separate step — run `npm run build:client`')
      console.error('  (or `npm run build`, which runs compile → build:client → build:installable).')
      console.error('  Shipping without it makes the Edge tab vanish silently in the desktop.')
      process.exit(1)
    }
  }

  // The installable directory is installed as a `file:` DIRECTORY dependency.
  // npm/pnpm run a directory dependency's `prepare` script after install —
  // and this repo's `prepare` compiles TypeScript, which needs the dev
  // dependencies and a package manager. The desktop runtime has neither, so
  // a `prepare` left in place stalls the install (or fails it outright).
  // The artifact already carries a compiled lib/; drop the build chain.
  delete variantPkg.scripts
  delete variantPkg.devDependencies
  writeFileSync(
    join(staging, 'package.json'),
    JSON.stringify(variantPkg, null, 2) + '\n',
    'utf-8',
  )

  // 4. Swap: the old directory moves aside, the new one takes its place.
  //    rename() over an existing directory is atomic on both POSIX and
  //    Windows (the target is briefly absent, but it was never a link
  //    target being watched at that instant).
  //    §Windows (2026-10-24): when the target is locked by a LIVE handle
  //    (the running desktop App holding the `link:` install open — retry
  //    never clears it, observed 3× in one day), degrade to an entry-wise
  //    in-place sync instead of dying: the link: target stays valid, the
  //    App picks the new code up on restart. A clean atomic swap still
  //    happens whenever the lock is absent (POSIX always; Windows with the
  //    app quit).
  //
  //    §7.175 (2026-11-11): 两步 swap 现在**各自**降级。
  //    此前只给「第一步（挪走旧目录）」配了降级，第二步（接上新目录）
  //    是一次裸 renameSync —— 它 EPERM 时（同一个活句柄！）整个脚本
  //    抛出，而**旧目录已经被挪走了** ⇒ `dist/installable/<variant>/`
  //    根本不存在 ⇒ 桌面 profile 的 `link:`/JUNCTION **悬空** ⇒
  //    Edge tab 静默消失（实测 2026-11-11 10:20）。
  //    现在两步都有降级路径，且**任何分支结束时 target 路径必然存在**
  //    （第二步失败 ⇒ 用旧目录恢复 + 就地同步，绝不留悬空 link）。
  const retired = join(DIST, `.${variant.dir}.retired`)
  rmSync(retired, { recursive: true, force: true })
  let inPlace = false
  let movedAside = false
  if (existsSync(target)) {
    if (renameDirWithRetry(target, retired)) {
      movedAside = true
    } else {
      console.warn(`  warning: ${variant.dir} is locked (running desktop App?) — in-place sync instead of atomic swap`)
    }
  }
  if (!movedAside) {
    // 旧目录挪不走（活句柄）⇒ 就地同步：target 路径不动，link 持续有效。
    syncEntriesInPlace(staging, target)
    rmSync(staging, { recursive: true, force: true })
    inPlace = true
  } else if (!renameDirWithRetry(staging, target)) {
    // 旧目录挪走了，但新的接不上（同一个活句柄卡在第二步）。
    // ⇒ 先把旧目录恢复回 target（link 立刻重新有效，绝不悬空），
    //    再就地同步新内容。
    console.warn(`  warning: ${variant.dir} staging rename failed — restoring the previous directory, then in-place sync`)
    if (renameDirWithRetry(retired, target)) {
      syncEntriesInPlace(staging, target)
      rmSync(staging, { recursive: true, force: true })
      inPlace = true
    } else {
      console.error(`  error: could not restore ${variant.dir} — the link: target is now dangling.`)
      console.error(`         手工恢复：把 ${retired} 改名为 ${target}`)
      process.exit(1)
    }
  }
  if (!inPlace) {
    rmSync(retired, { recursive: true, force: true })
  }
  // 不变式：target 路径必须存在（桌面 profile 的 link: 指向它）。
  if (!existsSync(target)) {
    console.error(`  error: ${variant.dir} is missing after the swap — the link: target would dangle.`)
    process.exit(1)
  }

  console.log(`  built ${variant.dir} (patch=${variant.patchField}, version=${variantPkg.version}${inPlace ? ', in-place' : ''})`)
}

console.log('rebuild-installable: done')

// §7.103 (2026-10-22): report a broken install link instead of leaving the
// operator with a silently plugin-less desktop profile.
//
// A DSH profile installs this bundle as `link:dist/installable/<variant>`.
// When that path is missing (or the profile's node_modules holds the package
// under .ignored/ because pnpm saw the link break), the profile still lists
// the bundle in dsh.profile.bundles, so the desktop starts happily and the
// Edge tab simply never appears. Both states are cheap to detect.
const profilesRoot = join(homedir(), '.dsh', 'profiles')
if (existsSync(profilesRoot)) {
  for (const profile of readdirSync(profilesRoot, { withFileTypes: true })) {
    if (!profile.isDirectory()) continue
    const profileDir = join(profilesRoot, profile.name)
    const pkgPath = join(profileDir, 'package.json')
    if (!existsSync(pkgPath)) continue
    let profilePkg
    try {
      profilePkg = readJson(pkgPath)
    } catch {
      continue
    }
    const deps = profilePkg?.dependencies ?? {}
    for (const [name, specifier] of Object.entries(deps)) {
      if (typeof specifier !== 'string' || !specifier.startsWith('link:')) continue
      const linkTarget = resolve(profileDir, specifier.slice('link:'.length))
      if (existsSync(linkTarget)) continue
      console.warn(
        `  WARNING: profile "${profile.name}" links ${name} → ${linkTarget} — the target does not exist.`
        + `\n           Re-add the plugin in the desktop UI (Plugins → Add Plugin →`
        + `\n           ${linkTarget}) or re-run the install so the link is restored.`,
      )
    }
    // A package the profile still lists but pnpm moved aside: the bundle is
    // declared yet not installed, which is the silent Edge-tab-less state.
    const ignored = join(profileDir, 'node_modules', '.ignored')
    if (existsSync(ignored)) {
      for (const entry of readdirSync(ignored, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const scope = join(ignored, entry.name)
        if (!existsSync(scope)) continue
        for (const pkg of readdirSync(scope, { withFileTypes: true })) {
          if (!pkg.isDirectory()) continue
          if (!existsSync(join(scope, pkg.name, 'package.json'))) continue
          console.warn(
            `  WARNING: profile "${profile.name}" holds ${entry.name}/${pkg.name} under`
            + ` node_modules/.ignored/ — pnpm saw the link break and set the package aside.`
            + `\n           Re-add the plugin in the desktop UI to restore it.`,
          )
        }
      }
    }
  }
}
