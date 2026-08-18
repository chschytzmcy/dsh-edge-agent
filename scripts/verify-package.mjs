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

await import(new URL(`../${manifest.main}`, import.meta.url))
const invariant = await import(new URL('../lib/types/dsh-adapter/invariant.js', import.meta.url))
if (invariant.name !== 'dsh-edge-agent-invariant' || typeof invariant.apply !== 'function') {
  throw new Error('compiled invariant entry does not expose the expected contract')
}

console.log(`package surface OK (${packed.size} files, ${targets.size} entry targets)`)