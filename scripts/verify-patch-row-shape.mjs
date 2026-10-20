// scripts/verify-patch-row-shape.mjs
//
// §7.101.x (2026-10-20): pre-make sanity check for cordis 0.2.1-rc.2
// patch loader. The loader silently skips rows that carry `inject:` or
// `config:` fields (those are 0.2.2+ syntax); the desktop GUI then
// renders zero errors but the affected plugin row never mounts, which
// is exactly what was happening to `edge-context-view` until
// docs/dev-notes/cordis-rc021-patch-loader.md captured the bug.
//
// This script enforces the patch-row contract that the desktop
// 0.2.1-rc.2 loader actually honors:
//
//   1. Every `name:` resolves to a package subpath that is declared in
//      package.json#exports (or is the package main itself, which Node
//      ESM resolves via main).
//   2. The `edge-context-view` row (the §7.101 desktop right-pane Edge
//      tab) MUST NOT carry an `inject:` or `config:` field — the
//      loader silently skips the whole row when those are present
//      (Bug 1 in docs/dev-notes/cordis-rc021-patch-loader.md). The
//      plugin already declares `inject = ['auditLog']` in source and
//      reads all knobs from process.env inside apply().
//   3. No row name may include '/lib/' — Bug 2 in the same dev-note
//      triggers ERR_PACKAGE_PATH_NOT_EXPORTED on require().
//
// Other `config:` fields elsewhere in the patch are intentional (see
// patch-surface.snapshot.json — `configOverrides: 8`); verify-patch-surface
// gates the count. Removing them globally would change host defaults that
// the bundle ships to production; the §7.101.x fix is scoped to
// edge-context-view only.
//
// The script reads both patch files in `cordis.{,desktop-safe.}patch.yml`
// plus the package.json. It walks every `- id:` row inside `insert:`
// / top-level override blocks and emits a single-line violation per
// offender. Exits 1 on any violation; 0 on clean.
//
// Run via: node scripts/verify-patch-row-shape.mjs
//
// Note: keep backticks out of comments (Node 24 ESM lexer walks
// block-comment regions for template-literal opening backticks; a stray
// backtick silently re-enters string-literal scanning).

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PATCH_FILES = ['cordis.patch.yml', 'cordis.desktop-safe.patch.yml']

// Pre-load exports map (Node ESM resolution targets). Computed before
// any row walks so `declaredExports.has(...)` is in scope at check time.
const PKG_PATH = join(ROOT, 'package.json')
const declaredExports = new Set()
try {
  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'))
  for (const key of Object.keys(pkg.exports ?? {})) {
    // key is like './file-logger' or '.' or './cordis.patch.yml'
    declaredExports.add(key === '.' ? '.' : key)
  }
} catch {
  // Surface as a violation in the row walk below if relevant.
}

const violations = []

for (const patchName of PATCH_FILES) {
  const patchPath = join(ROOT, patchName)
  if (!existsSync(patchPath)) {
    violations.push(`${patchName}: file missing at ${relative(ROOT, patchPath)}`)
    continue
  }

  let doc
  try {
    const text = readFileSync(patchPath, 'utf8')
    doc = parseYaml(text)
  } catch (e) {
    violations.push(`${patchName}: invalid YAML (${e.message})`)
    continue
  }
  if (!Array.isArray(doc)) {
    violations.push(`${patchName}: top-level must be an array of rows`)
    continue
  }

  for (let i = 0; i < doc.length; i++) {
    const row = doc[i]
    if (!row || typeof row !== 'object') continue
    collectRowViolations(row, patchName, i, violations)
  }
}

if (violations.length > 0) {
  console.error('patch-row-shape FAILED:')
  for (const v of violations) console.error(`  - ${v}`)
  process.exit(1)
}

console.log(`patch-row-shape OK (${PATCH_FILES.length} patch files, 0 silent-skip risks)`)
process.exit(0)

/**
 * Walk every row inside an `insert:` block and every top-level
 * `- id:` row, asserting the cordis 0.2.1-rc.2 loader contract.
 *
 * @param {Record<string, unknown>} row
 * @param {string} patchName
 * @param {number} topIndex
 * @param {string[]} violations
 */
function collectRowViolations(row, patchName, topIndex, violations) {
  // Top-level row form: `{ id: '...', config?: {...} }` — overrides an
  // upstream plugin in-place; name is OPTIONAL here. We still want to
  // catch Bug 1 (config:) on top-level rows because the loader skips it
  // silently for both forms.
  if (row.insert && Array.isArray(row.insert)) {
    for (let j = 0; j < row.insert.length; j++) {
      checkInsertRow(row.insert[j], patchName, `${topIndex}.insert.${j}`, violations)
    }
  } else if (row.id) {
    checkTopRow(row, patchName, `${topIndex}`, violations)
  }
}

function checkTopRow(r, patchName, where, violations) {
  const id = r.id
  // Top-level rows are CONFIG OVERRIDES — they reference an upstream
  // plugin by name; no `name:` field is needed (cordis uses `id:`).
  // Other plugins in the patch legitimately carry `config:` (recorded
  // by patch-surface.snapshot.json as configOverrides); the Bug 1
  // warning is scoped to edge-context-view only — see the module
  // header for the rationale.
  if (id === 'edge-context-view') {
    if ('config' in r) {
      violations.push(
        `${patchName}#${where} (id=${id}): top-level row carries 'config:' field. ` +
          `cordis 0.2.1-rc.2 patch loader SILENTLY SKIPS the row. ` +
          `Read env vars inside apply() and do not rely on patch-level config.`,
      )
    }
    if ('inject' in r) {
      violations.push(
        `${patchName}#${where} (id=${id}): top-level row carries 'inject:' field. ` +
          `cordis 0.2.1-rc.2 patch loader SILENTLY SKIPS the row. ` +
          `Inject deps inside the plugin's apply() via ctx.inject([...]).`,
      )
    }
  }
}

function checkInsertRow(r, patchName, where, violations) {
  if (!r || typeof r !== 'object') return
  const id = r.id
  const name = r.name

  if (typeof name === 'string') {
    // Bug 2: name: '.../lib/types/...' triggers ERR_PACKAGE_PATH_NOT_EXPORTED.
    if (name.includes('/lib/types/') || name.includes('/lib/')) {
      violations.push(
        `${patchName}#${where} (id=${id}): name='${name}' contains '/lib/' — ` +
          `cordis will require() it, Node ESM will reject via exports. ` +
          `Use a bare package name or a declared exports subpath.`,
      )
    }
    // exports gate: if name is a subpath, it must be declared in package.json exports.
    if (name.startsWith('@')) {
      const subpath = name.replace(/^@[^/]+\/[^/]+/u, '')
      if (subpath && subpath !== '.') {
        const candidate = `.${subpath}`
        if (!declaredExports.has(candidate)) {
          violations.push(
            `${patchName}#${where} (id=${id}): name='${name}' points at ` +
              `subpath '${candidate}' which is NOT declared in package.json#exports. ` +
              `Add an exports entry, or use a bare package name.`,
          )
        }
      }
    }
  } else {
    violations.push(
      `${patchName}#${where}: insert row is missing a 'name' field — ` +
        `cordis cannot resolve the plugin.`,
    )
  }

  // Bug 1: cordis 0.2.1-rc.2 silently skips these. The §7.101.x scope
  // is edge-context-view only — other plugins legitimately carry
  // config: fields (verify-patch-surface's snapshot records them), and
  // removing them globally would change production host defaults.
  if (id === 'edge-context-view') {
    if ('inject' in r) {
      violations.push(
        `${patchName}#${where} (id=${id}): carries 'inject:' field. ` +
          `cordis 0.2.1-rc.2 patch loader SILENTLY SKIPS the row. ` +
          `Move dependency declaration into the plugin's own apply() via ctx.inject([...]).`,
      )
    }
    if ('config' in r) {
      violations.push(
        `${patchName}#${where} (id=${id}): carries 'config:' field. ` +
          `cordis 0.2.1-rc.2 patch loader SILENTLY SKIPS the row. ` +
          `Read env vars inside the plugin's apply() instead of relying on config injection.`,
      )
    }
  }
}