// Verify installable bundle directories under dist/installable.
//
// §7.101.x (2026-10-20): added after a real incident where the desktop GUI
// validator rejected an installable dir with ENOENT because the package.json
// bundle.patch field pointed at a file (cordis.patch.yml) that wasn't in the
// dir (we shipped only cordis.desktop-safe.patch.yml). npm pack treats the
// files field as the source of truth; the desktop GUI independently validates
// every file the manifest references. This script closes that gap pre-make.
//
// For each directory under dist/installable, every file path that the bundle
// package.json claims must exist on disk; the host entry point (lib/types/
// index.js), the presets directory, and the cordis patch must all exist
// independently of the manifest.
//
// Note: keep backticks out of comments. Node 24 ESM lexer walks block-comment
// regions for template-string opening backticks; a stray backtick inside an
// open-close comment pair silently re-enters string-literal scanning and
// corrupts the parser.
//
// Run via: node scripts/verify-installable.mjs

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const INSTALLABLE = process.env.INSTALLABLE_DIR
  ? resolve(process.env.INSTALLABLE_DIR)
  : join(ROOT, 'dist', 'installable')

const REQUIRED_HOST_ENTRY = 'lib/types/index.js'

/** Recursive directory walker. */
function walk(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

// Strip surrounding double quotes from a JSON-derived yaml path.
function unquote(value) {
  if (typeof value !== 'string') return value
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1)
  }
  return value
}

/** Single-bundle verification. Throws on first violation. */
function verifyBundle(dir) {
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) {
    throw new Error(`${relative(ROOT, dir)}: missing package.json`)
  }
  let pkg
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  } catch (e) {
    throw new Error(`${relative(ROOT, dir)}: package.json is not valid JSON (${e.message})`)
  }

  // 1. host half entry must exist (lib/types/index.js).
  const hostEntry = join(dir, REQUIRED_HOST_ENTRY)
  if (!existsSync(hostEntry)) {
    throw new Error(`${relative(ROOT, dir)}: missing host entry ${REQUIRED_HOST_ENTRY}`)
  }

  // 2. bundle.patch path must exist on disk.
  //    This is the failure mode that triggered §7.101.x.
  const dshBundlePatch = unquote(pkg?.dsh?.bundle?.patch)
  if (!dshBundlePatch) {
    throw new Error(`${relative(ROOT, dir)}: package.json#dsh.bundle.patch missing`)
  }
  if (typeof dshBundlePatch !== 'string') {
    throw new Error(
      `${relative(ROOT, dir)}: package.json#dsh.bundle.patch is not a string: ${typeof dshBundlePatch}`,
    )
  }
  // Desktop forbids non-yaml patches: must end in .yml/.yaml.
  if (!/\.(ya?ml)$/i.test(dshBundlePatch)) {
    throw new Error(
      `${relative(ROOT, dir)}: dsh.bundle.patch must be a yaml file, got: ${dshBundlePatch}`,
    )
  }
  const patchAbs = join(dir, dshBundlePatch)
  if (!existsSync(patchAbs)) {
    throw new Error(
      `${relative(ROOT, dir)}: dsh.bundle.patch points at ` +
        `${dshBundlePatch} but the file is missing on disk`,
    )
  }

  // 3. dsh.client (optional). When entry is present, entry file must exist.
  //    dsh-context ships with just an `entry` field (no inject/platform);
  //    we mirror that minimal shape, so inject/platform are optional.
  const dshClientEntry = unquote(pkg?.dsh?.client?.entry)
  if (dshClientEntry) {
    const clientAbs = join(dir, dshClientEntry)
    if (!existsSync(clientAbs)) {
      throw new Error(
        `${relative(ROOT, dir)}: dsh.client.entry points at ` +
          `${dshClientEntry} but the file is missing on disk`,
      )
    }
  }

  // 4. presets/ must exist with at least one .json.
  const presetsDir = join(dir, 'presets')
  if (!existsSync(presetsDir)) {
    throw new Error(`${relative(ROOT, dir)}: missing presets/ directory`)
  }
  const presetFiles = readdirSync(presetsDir).filter((n) => n.endsWith('.json'))
  if (presetFiles.length === 0) {
    throw new Error(`${relative(ROOT, dir)}: presets/ contains no .json files`)
  }

  return {
    bundle: pkg.name,
    version: pkg.version,
    variant: dshBundlePatch,
    client: dshClientEntry ?? null,
    presets: presetFiles.length,
  }
}

let dirs
try {
  dirs = readdirSync(INSTALLABLE)
    .map((name) => join(INSTALLABLE, name))
    .filter((p) => statSync(p).isDirectory())
} catch {
  console.error(`installable dir not found: ${relative(ROOT, INSTALLABLE)}`)
  console.error('(run `make installable` or `npm run build` first)')
  process.exit(1)
}

if (dirs.length === 0) {
  console.error('no bundles under dist/installable/')
  process.exit(1)
}

const reports = []
for (const dir of dirs) {
  try {
    reports.push(verifyBundle(dir))
  } catch (e) {
    console.error(`verify-installable: ${e.message}`)
    process.exit(1)
  }
}

console.log(`verify-installable OK (${reports.length} bundles)`)
for (const r of reports) {
  const clientNote = r.client ? `client=${r.client}` : 'client=(none)'
  console.log(
    `  - ${r.bundle}@${r.version}: patch=${r.variant}, ${clientNote}, presets=${r.presets}`,
  )
}
