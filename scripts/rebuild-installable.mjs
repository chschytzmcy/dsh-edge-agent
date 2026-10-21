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

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
function shippedEntries(pkg) {
  return Array.isArray(pkg.files) && pkg.files.length > 0 ? pkg.files : ['lib']
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
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })

  // 1. Ship the `files` list (lib, config, presets, ...).
  for (const entry of shippedEntries(pkg)) {
    const src = join(ROOT, entry)
    if (!existsSync(src)) {
      console.error(`  warning: ${entry} not found in repo — skipped`)
      continue
    }
    cpSync(src, join(target, entry), { recursive: true })
  }

  // 2. The cordis patch variant this bundle ships.
  const patchSrc = join(ROOT, variant.patch)
  if (!existsSync(patchSrc)) {
    console.error(`  error: ${variant.patch} not found`)
    process.exit(1)
  }
  cpSync(patchSrc, join(target, variant.patch))

  // 3. package.json — variant-specific name/version + patch field rewrite.
  const variantPkg = readJson(join(ROOT, 'package.json'))
  variantPkg.version = variant.version
  if (!variantPkg.dsh) variantPkg.dsh = {}
  if (!variantPkg.dsh.bundle) variantPkg.dsh.bundle = {}
  variantPkg.dsh.bundle.patch = `./${variant.patchField}`
  writeFileSync(
    join(target, 'package.json'),
    JSON.stringify(variantPkg, null, 2) + '\n',
    'utf-8',
  )

  console.log(`  built ${variant.dir} (patch=${variant.patchField}, version=${variant.version})`)
}

console.log('rebuild-installable: done')
