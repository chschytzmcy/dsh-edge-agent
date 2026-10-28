// scripts/_verify-installable-edge.mjs
//
// Local stand-in for vitest in sandboxed environments where vitest's
// worker fork is blocked. Loads the freshly-built installable bundle
// and exercises the surface that the desktop GUI would mount:

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = process.argv[2] ?? join(ROOT, 'dist', 'installable', 'dsh-edge-agent-desktop-safe')

if (!existsSync(join(TARGET, 'package.json'))) {
  console.error(`installable target missing: ${TARGET}`)
  console.error('run: node scripts/_rebuild-installable.mjs first')
  process.exit(2)
}

const pkg = JSON.parse(readFileSync(join(TARGET, 'package.json'), 'utf8'))
const lib = join(TARGET, 'lib')
console.log('=== installable bundle sanity ===')
console.log(`bundle:           ${pkg.name}@${pkg.version}`)
console.log(`target:           ${relative(ROOT, TARGET)}`)
console.log(`bundle.patch:     ${pkg.dsh?.bundle?.patch}`)
console.log(`client.entry:     ${pkg.dsh?.client?.entry}`)
console.log(`exports count:    ${Object.keys(pkg.exports ?? {}).length}`)

const requiredFiles = [
  'package.json',
  'cordis.desktop-safe.patch.yml',
  'cordis.patch.yml',
  'cordis.yml',
  'lib/index.js',
  'lib/client.js',
]
for (const f of requiredFiles) {
  const p = join(TARGET, f)
  if (!existsSync(p)) {
    console.error(`MISSING required file: ${f}`)
    process.exit(1)
  }
  console.log(`  ✓ ${f} (${statSync(p).size} bytes)`)
}

console.log()
console.log('=== edge-context-view patch row sanity ===')
// §7.135: the edge-context-view row moved into the **Agent Preset** patch
// (presets/edge.desktop-safe.patch.yml) — it is the Edge panel's host half
// and belongs to the 边缘模式 work mode, not to the global patch layer.
const patchCandidates = [
  join(TARGET, 'presets', 'edge.desktop-safe.patch.yml'),
  join(TARGET, 'cordis.desktop-safe.patch.yml'),
]
const patchPath = patchCandidates.find((p) => existsSync(p))
if (patchPath === undefined) {
  console.error('no patch file to inspect for the edge-context-view row')
  process.exit(1)
}
const patch = readFileSync(patchPath, 'utf8')
console.log(`  (inspected: ${patchPath.split(/[\\/]/).slice(-2).join('/')})`)
// Find the edge-context-view row block. §7.136 moved it one level deeper
// (inside the preset's `cordis:group`), so cut the slice at the NEXT row
// header instead of a fixed byte count — otherwise the following row's
// fields leak into this row's verdict.
const rowStart = patch.indexOf('- id: edge-context-view')
if (rowStart < 0) {
  console.error('edge-context-view row not found in patch')
  process.exit(1)
}
const rowSlice = patch.slice(rowStart, rowStart + 2000).split(/\n\s*- id: /)[0]
const hasInject = /^\s*inject:/m.test(rowSlice)
const hasConfig = /^\s*config:/m.test(rowSlice)
const hasName = /^\s*name:\s*['"]([^'"]+)['"]/m.exec(rowSlice)?.[1]

console.log(`row  id:           edge-context-view`)
console.log(`row  name:         ${hasName}`)
console.log(`row  has inject::  ${hasInject}   (must be false)`)
console.log(`row  has config::  ${hasConfig}  (must be false)`)

if (hasInject || hasConfig) {
  console.error('Bug 1 regression: inject: / config: is back in the edge-context-view patch row.')
  process.exit(1)
}
if (!hasName || !hasName.startsWith('@deepseek-harness-edge-agent/dsh-edge-agent')) {
  console.error(`Bug 2 regression: name='${hasName}' is not a valid bundle name.`)
  process.exit(1)
}

console.log()
console.log('=== client bundle content sanity ===')
const clientSrc = readFileSync(join(TARGET, 'lib/client.js'), 'utf8')
const clientBytes = Buffer.byteLength(clientSrc)
console.log(`lib/client.js:    ${clientBytes} bytes (expected ~9 KB module-loader format)`)
if (clientBytes < 3000 || clientBytes > 200000) {
  console.error(`client.js size out of range: ${clientBytes}`)
  process.exit(1)
}
// The webview loads the bundle as a CLASSIC script and requires it to
// self-register via window.__ModuleLoader__.load({id, factory}). A plain
// ESM file (top-level `export const name`) executes without registering
// and the tab silently never appears — reject that regression here.
if (!clientSrc.includes('window.__ModuleLoader__.load')) {
  console.error('client.js is NOT in __ModuleLoader__.load format (webview will never register it).')
  process.exit(1)
}
const idMatch = /__ModuleLoader__\.load\(\{\s*\n?\s*id:\s*"([^"]+)"/u.exec(clientSrc)
if (!idMatch || idMatch[1] !== pkg.name) {
  console.error(`client.js registration id mismatch: got ${idMatch?.[1]}, want ${pkg.name}`)
  process.exit(1)
}
console.log(`registration id:  ${idMatch[1]} ✓`)

console.log()
console.log('=== package.json#dsh.client declaration ===')
const dshClient = pkg.dsh?.client ?? {}
if (dshClient.platform !== 'web') {
  console.error(`dsh.client.platform must be "web" (got ${JSON.stringify(dshClient.platform)}) — client-modules skips non-web declarations.`)
  process.exit(1)
}
console.log(`platform:         ${dshClient.platform} ✓`)
console.log(`inject:           ${(dshClient.inject ?? []).join(', ') || '(none)'}`)

console.log()
console.log('=== main entry re-export bridge ===')
const mainEntry = readFileSync(join(TARGET, 'lib/index.js'), 'utf8')
const reExportsEdge = /export[^;]*from\s*['"][^'"]*edge-context-view\.js['"]/m.test(mainEntry)
console.log(`index re-exports edge-context-view: ${reExportsEdge}`)
if (!reExportsEdge) {
  console.error('Bug 2 regression: main entry does NOT re-export edge-context-view.')
  process.exit(1)
}

console.log()
console.log('=== package.json#exports entry ===')
const exports = pkg.exports ?? {}
const hasEdgeExports = './edge-context-view' in exports
console.log(`exports['./edge-context-view']: ${hasEdgeExports}`)
if (!hasEdgeExports) {
  console.error("exports['./edge-context-view'] is missing — subpath name resolution will fail.")
  process.exit(1)
}

console.log()
console.log('=== host plugin load (edge-context-view) ===')
// Edge tab host half is a Cordis plugin (not a dynamic runtime); its
// .js file is loadable directly via dynamic import. Cordis's loader
// uses the same path: `node -r path/to/edge-context-view.js`, which
// Node ESM resolves through the package.json#exports gate.
const installableRoot = TARGET
const pluginJs = join(installableRoot, 'lib', 'dsh-adapter', 'edge-context-view.js')
if (!existsSync(pluginJs)) {
  console.error(`plugin file missing: ${relative(ROOT, pluginJs)}`)
  process.exit(1)
}
const subpathModule = await import(pathToFileURL(pluginJs).href)
const expectedExports = ['name', 'inject', 'Config', 'apply']
for (const k of expectedExports) {
  if (!(k in subpathModule)) {
    console.error(`edge-context-view export missing: ${k}`)
    process.exit(1)
  }
}
console.log(`name:             '${subpathModule.name}'`)
console.log(`inject:           [${subpathModule.inject.join(', ')}]`)
console.log(`Config:           ${typeof subpathModule.Config === 'object' ? 'Schema<...>' : '???'}`)
console.log(`apply:            ${typeof subpathModule.apply === 'function' ? 'function' : '???'}`)

console.log()
console.log('all installable edge-context-view checks passed ✅')