/**
 * npm pack dry-run verifier: runs `npm pack --dry-run --json` and checks
 * the resulting file list against the manifest's `exports`, `main`,
 * `types`, and `bin` entries.
 *
 * Reads stdin (npm pack's JSON output) so the caller can pipe it.
 *
 * Run via:
 *   npm pack --dry-run --json --ignore-scripts | node scripts/verify-package.mjs
 */
import { readFile } from 'node:fs/promises'

import { configShipViolations, describeConfigViolation } from './_config-ship-policy.mjs'

const input = await new Promise((resolve, reject) => {
  let value = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => { value += chunk })
  process.stdin.on('end', () => resolve(value))
  process.stdin.on('error', reject)
})

const reports = JSON.parse(input)
const report = Array.isArray(reports) ? reports[0] : Object.values(reports)[0]
if (report === undefined || !Array.isArray(report.files)) {
  throw new Error('npm pack did not return a package file list')
}

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const packed = new Set(report.files.map((file) => file.path.replaceAll('\\', '/')))
const targets = new Set()

const addTarget = (value) => {
  if (typeof value === 'string') targets.add(value.replace(/^\.\//u, ''))
}

addTarget(manifest.main)
addTarget(manifest.types)
for (const target of Object.values(manifest.bin ?? {})) addTarget(target)

const collectExports = (value) => {
  if (typeof value === 'string') {
    addTarget(value)
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const nested of Object.values(value)) collectExports(nested)
}
collectExports(manifest.exports)

const missing = [...targets].filter((target) => !packed.has(target))
if (missing.length > 0) {
  throw new Error(`package exports missing from tarball: ${missing.join(', ')}`)
}

if ([...packed].some((path) => path.startsWith('src/'))) {
  throw new Error('npm package unexpectedly contains TypeScript sources')
}
if (packed.has('lib/invariant.js')) {
  throw new Error('npm package contains the obsolete hand-built invariant entry')
}

// §7.102 security: the runtime config holds the plaintext provider keys
// (deepseek / dashscope / tavily / bocha / edge). It must never reach a
// distributable tarball.
//
// The subtlety this guard exists for: npm pack honours .npmignore INSTEAD
// of .gitignore whenever .npmignore exists — so the `config/edge.json`
// rule in .gitignore does NOT keep the file out of the package. The
// .npmignore rule does; this gate proves it still holds.
//
// config/edge.example.json (the template) and config/privacy-policy.json
// are expected to ship.
const FORBIDDEN_IN_PACKAGE = [
  'config/edge.json',
  '.env',
  '.env.sh',
  '.env.example',
]
const leaked = FORBIDDEN_IN_PACKAGE.filter((path) => packed.has(path))
if (leaked.length > 0) {
  throw new Error(
    `package would ship plaintext credentials: ${leaked.join(', ')}. `
    + 'Add them to .npmignore (npm pack ignores .gitignore when .npmignore exists).',
  )
}

// §7.189: the exact-name list above cannot see the live config's BACKUP —
// `config/edge.json.bak-<timestamp>` carries the same plaintext keys (measured
// 2026-11-11: 5 real API keys) and slips past any `config/edge.json` rule —
// nor editor junk like `config/.DS_Store`. Check the whole config/ subtree
// against the shipping allowlist instead.
const configViolations = configShipViolations([...packed])
if (configViolations.length > 0) {
  throw new Error(
    `package would ship ${configViolations.map((v) => describeConfigViolation(v)).join('；')}. `
    + 'Add them to .npmignore (npm pack ignores .gitignore when .npmignore exists).',
  )
}

await import(new URL(`../${manifest.main}`, import.meta.url))
const invariant = await import(new URL('../lib/dsh-adapter/invariant.js', import.meta.url))
if (invariant.name !== 'dsh-edge-agent-invariant' || typeof invariant.apply !== 'function') {
  throw new Error('compiled invariant entry does not expose the expected contract')
}

console.log(`package surface OK (${packed.size} files, ${targets.size} entry targets)`)