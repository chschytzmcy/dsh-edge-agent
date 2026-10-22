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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist', 'installable')

const VARIANTS = [
  {
    dir: 'dsh-edge-agent-desktop-safe',
    patch: 'cordis.desktop-safe.patch.yml',
    // The desktop-safe bundle must point its cordis patch at the safe
    // variant — the full patch ships host rewrites the desktop profile
    // must not apply.
    patchField: 'cordis.desktop-safe.patch.yml',
    version: '0.1.1',
  },
  {
    dir: 'dsh-edge-agent-full',
    patch: 'cordis.patch.yml',
    patchField: 'cordis.patch.yml',
    version: '0.1.1-full',
  },
]

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
  variantPkg.version = variant.version
  if (!variantPkg.dsh) variantPkg.dsh = {}
  if (!variantPkg.dsh.bundle) variantPkg.dsh.bundle = {}
  variantPkg.dsh.bundle.patch = `./${variant.patchField}`
  writeFileSync(
    join(staging, 'package.json'),
    JSON.stringify(variantPkg, null, 2) + '\n',
    'utf-8',
  )

  // 4. Swap: the old directory moves aside, the new one takes its place.
  //    rename() over an existing directory is atomic on both POSIX and
  //    Windows (the target is briefly absent, but it was never a link
  //    target being watched at that instant).
  const retired = join(DIST, `.${variant.dir}.retired`)
  rmSync(retired, { recursive: true, force: true })
  if (existsSync(target)) renameSync(target, retired)
  renameSync(staging, target)
  rmSync(retired, { recursive: true, force: true })

  console.log(`  built ${variant.dir} (patch=${variant.patchField}, version=${variant.version})`)
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
