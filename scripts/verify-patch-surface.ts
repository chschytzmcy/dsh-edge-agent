/**
 * Patch-surface contract: the dsh-edge-agent profile patch may only touch
 * official rows that are justified. The baseline is a SNAPSHOT
 * (patch-surface.snapshot.json) derived from the local cordis.patch.yml.
 *
 * When the patch drifts (new inserts, new disables, changed config
 * overrides), the diff fails HERE (CI) instead of silently drifting on
 * user machines; reviewing the diff and regenerating the snapshot is the
 * documented upgrade step.
 *
 * Run via `node --import tsx/esm scripts/verify-patch-surface.ts`.
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'

const root = resolve(import.meta.dirname, '..')
const patchPath = join(root, 'cordis.patch.yml')
const snapshotPath = join(root, 'patch-surface.snapshot.json')

interface ParsedPatch {
  overrides: Array<{ id: string; disabled: boolean; hasConfig: boolean }>
  inserts: Array<{ id: string }>
}

function parsePatch(text: string): ParsedPatch {
  const doc = parseYaml(text) as unknown
  const overrides: ParsedPatch['overrides'] = []
  const inserts: ParsedPatch['inserts'] = []
  if (!Array.isArray(doc)) throw new Error('patch root is not a list')
  for (const item of doc) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (Array.isArray(record.insert)) {
      for (const row of record.insert) {
        if (row !== null && typeof row === 'object' && typeof (row as Record<string, unknown>).id === 'string') {
          inserts.push({ id: (row as Record<string, unknown>).id as string })
        }
      }
      continue
    }
    if (typeof record.id === 'string') {
      overrides.push({
        id: record.id,
        disabled: record.disabled === true,
        hasConfig: 'config' in record,
      })
    }
  }
  return { overrides, inserts }
}

if (!existsSync(patchPath)) {
  console.error('cordis.patch.yml missing')
  process.exit(1)
}
const patch = parsePatch(readFileSync(patchPath, 'utf8'))

interface Snapshot {
  inserts: string[]
  configOverrides: string[]
  disablesBeyondWebApp: string[]
  webAppDisablesBeyondTui: string[]
  insertsSharedWithWebApp: string[]
}

const computed: Snapshot = {
  inserts: patch.inserts.map(r => r.id),
  configOverrides: patch.overrides.filter(r => !r.disabled && r.hasConfig).map(r => r.id),
  disablesBeyondWebApp: patch.overrides.filter(r => r.disabled).map(r => r.id),
  webAppDisablesBeyondTui: [],
  insertsSharedWithWebApp: [],
}

const mode = process.argv[2]
if (mode === '--snapshot') {
  writeFileSync(snapshotPath, `${JSON.stringify(computed, null, 2)}\n`)
  console.log(`patch-surface snapshot written: ${snapshotPath}`)
  process.exit(0)
}

if (!existsSync(snapshotPath)) {
  console.error('patch-surface.snapshot.json missing — run: node --import tsx/esm scripts/verify-patch-surface.ts --snapshot')
  process.exit(1)
}
const recorded = JSON.parse(readFileSync(snapshotPath, 'utf8')) as Snapshot

const same =
  JSON.stringify(recorded.inserts) === JSON.stringify(computed.inserts) &&
  JSON.stringify(recorded.configOverrides) === JSON.stringify(computed.configOverrides) &&
  JSON.stringify(recorded.disablesBeyondWebApp) === JSON.stringify(computed.disablesBeyondWebApp)

if (same) {
  console.log(
    `patch-surface OK (${computed.inserts.length} inserts, ` +
      `${computed.configOverrides.length} config overrides, ` +
      `${computed.disablesBeyondWebApp.length} disables)`,
  )
  process.exit(0)
}
console.error('patch-surface drifted from snapshot:')
console.error('  recorded:', JSON.stringify(recorded))
console.error('  current :', JSON.stringify(computed))
console.error('Review the diff, then regenerate: node --import tsx/esm scripts/verify-patch-surface.ts --snapshot')
process.exit(1)