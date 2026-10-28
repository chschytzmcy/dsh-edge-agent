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
// package.json claims must exist on disk; the host entry point (lib/index.js
// since the 2026-10-20 flat-layout move; it used to be lib/types/index.js),
// the presets directory, and the cordis patch must all exist independently
// of the manifest.
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

const REQUIRED_HOST_ENTRY = 'lib/index.js'

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

  // 1. host half entry must exist (lib/index.js).
  const hostEntry = join(dir, REQUIRED_HOST_ENTRY)
  if (!existsSync(hostEntry)) {
    throw new Error(`${relative(ROOT, dir)}: missing host entry ${REQUIRED_HOST_ENTRY}`)
  }

  // 1b. §7.102: the runtime config must ship with the bundle. The plugin
  //     reads <bundle>/config/edge.json first, then ~/.dsh-edge-agent/.
  //     Without a config/ dir the bundle falls back to the example
  //     template, which has blank secrets — the local-LLM route then never
  //     registers and every LOCAL turn 502s.
  const configDir = join(dir, 'config')
  if (!existsSync(configDir)) {
    throw new Error(`${relative(ROOT, dir)}: missing config/ directory (edge.json lives there)`)
  }
  const edgeConfig = join(configDir, 'edge.json')
  const edgeExample = join(configDir, 'edge.example.json')
  if (!existsSync(edgeConfig) && !existsSync(edgeExample)) {
    throw new Error(
      `${relative(ROOT, dir)}: config/ has neither edge.json nor edge.example.json`,
    )
  }
  // The template must always ship (it is the last-resort fallback).
  if (!existsSync(edgeExample)) {
    throw new Error(`${relative(ROOT, dir)}: missing config/edge.example.json (template)`)
  }
  // Whichever config is present must be valid JSON with the expected shape.
  for (const candidate of [edgeConfig, edgeExample]) {
    if (!existsSync(candidate)) continue
    let parsed
    try {
      parsed = JSON.parse(readFileSync(candidate, 'utf-8'))
    } catch (e) {
      throw new Error(`${relative(ROOT, candidate)}: invalid JSON (${e.message})`)
    }
    for (const section of ['llm', 'stages', 'privacy', 'resources']) {
      if (parsed[section] === undefined) {
        throw new Error(`${relative(ROOT, candidate)}: missing "${section}" section`)
      }
    }
  }

  // 2. bundle.patch path(s) must exist on disk.
  //    This is the failure mode that triggered §7.101.x.
  //
  //    §7.135: the field may be a STRING (one patch) or an ARRAY (several
  //    patch layers) — the host's own dsh-web-app bundle uses the array
  //    shape (`["./cordis.patch.yml", "./presets/standard.patch.yml", …]`).
  //    This bundle now ships two layers: the host-row overrides (cordis
  //    patch) and the **Agent Preset** declaration (the 边缘模式 work mode).
  const rawBundlePatch = pkg?.dsh?.bundle?.patch
  const bundlePatches = Array.isArray(rawBundlePatch)
    ? rawBundlePatch.map((p) => unquote(p))
    : [unquote(rawBundlePatch)]
  if (!rawBundlePatch || bundlePatches.length === 0 || bundlePatches.some((p) => !p)) {
    throw new Error(`${relative(ROOT, dir)}: package.json#dsh.bundle.patch missing`)
  }
  for (const dshBundlePatch of bundlePatches) {
    if (typeof dshBundlePatch !== 'string') {
      throw new Error(
        `${relative(ROOT, dir)}: package.json#dsh.bundle.patch entry is not a string: ${typeof dshBundlePatch}`,
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
  }

  // 3. dsh.client (optional). The webview module system requires the
  //    declaration shape { platform: 'web', inject?: [...], external?,
  //    immediately? } — `entry` is NOT a member and is ignored by the host
  //    (the bundle path comes from exports['./client']). A malformed or
  //    non-web declaration makes @deepseek-ai/dsh-client-modules skip the
  //    package entirely, so the client half never registers in the webview.
  const dshClient = pkg?.dsh?.client
  let clientNote = null
  if (dshClient !== void 0) {
    if (typeof dshClient !== 'object' || dshClient === null) {
      throw new Error(`${relative(ROOT, dir)}: dsh.client must be an object`)
    }
    if (dshClient.platform !== 'web') {
      throw new Error(
        `${relative(ROOT, dir)}: dsh.client.platform must be "web" (got ${JSON.stringify(dshClient.platform)})`,
      )
    }
    for (const key of ['inject', 'external']) {
      const value = dshClient[key]
      if (value !== void 0 && (!Array.isArray(value) || value.some((s) => typeof s !== 'string'))) {
        throw new Error(`${relative(ROOT, dir)}: dsh.client.${key} must be an array of strings`)
      }
    }
    if (dshClient.immediately !== void 0 && typeof dshClient.immediately !== 'boolean') {
      throw new Error(`${relative(ROOT, dir)}: dsh.client.immediately must be a boolean`)
    }
    const clientRel = typeof pkg.exports?.['./client'] === 'string' ? pkg.exports['./client'] : void 0
    if (clientRel === void 0) {
      throw new Error(`${relative(ROOT, dir)}: declares dsh.client but exports has no "./client" string entry`)
    }
    const clientAbs = join(dir, clientRel.replace(/^\.\//u, ''))
    if (!existsSync(clientAbs)) {
      throw new Error(
        `${relative(ROOT, dir)}: exports["./client"] points at ${clientRel} but the file is missing on disk`,
      )
    }
    clientNote = clientRel
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
    // §7.135: several patch layers (host-row overrides + the Agent Preset).
    variant: bundlePatches.join(' + '),
    client: clientNote,
    presets: presetFiles.length,
  }
}

// §7.101 v6.1: every conditional exports entry must list a 'require' or
// 'default' condition. Node's CJS resolver will skip an entry that only
// declares 'import', producing ERR_PACKAGE_PATH_NOT_EXPORTED on
// require('@scope/pkg'). The desktop GUI loader uses CJS for many host
// paths, so missing require/default silently breaks mount.
function verifyExportsConditions(pkg, dirRel) {
  if (!pkg.exports || typeof pkg.exports !== 'object') return
  const missing = []
  for (const [key, value] of Object.entries(pkg.exports)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      continue
    }
    const conds = Object.keys(value)
    if (conds.length === 0) continue
    const hasFallback = conds.includes('require') || conds.includes('default')
    const hasImportish = conds.includes('import') || conds.includes('types')
    if (hasImportish && !hasFallback) {
      missing.push(key)
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `${dirRel}: exports entries missing 'require'/'default' fallback: ` +
        missing.join(', ') +
        ' (will ERR_PACKAGE_PATH_NOT_EXPORTED on require())',
    )
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
    const r = verifyBundle(dir)
    // Cross-check exports condition keys against the package.json we just read.
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    verifyExportsConditions(pkg, relative(ROOT, dir))
    reports.push(r)
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
