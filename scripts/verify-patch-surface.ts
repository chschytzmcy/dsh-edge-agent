/**
 * Patch-surface contract: the dsh-edge-agent bundle patch may only touch
 * official rows that are justified. The bundle lives at the repo root
 * (`cordis.patch.yml`), NOT at a profile-level overlay. The baseline is
 * a SNAPSHOT
 * (patch-surface.snapshot.json) derived from the local cordis.patch.yml.
 *
 * When the patch drifts (new inserts, new disables, changed config
 * overrides), the diff fails HERE (CI) instead of silently drifting on
 * user machines; reviewing the diff and regenerating the snapshot is the
 * documented upgrade step.
 *
 * §7.135 (2026-10-28): the edge stack moved into an **Agent Preset** —
 * the host's "work mode" mechanism (`presets/edge*.patch.yml`). Two
 * consequences for this gate:
 *
 *  1. The preset files carry the bundle's plugin rows now, so the snapshot
 *     grew a `presets` section — the rows must stay under the gate's eye,
 *     not float free of it.
 *  2. A **semantic** rule (not a snapshot): every plugin row of this bundle
 *     must live inside a preset, and the bundle's top-level insert section
 *     must be EMPTY. A row left at the top level is mounted for EVERY work
 *     mode — the Edge behaviour would keep running while the host sits in
 *     标准模式, and 「边缘模式 = 标准模式 + 本项目功能」 would be a lie.
 *
 * Run via `node --import tsx/esm scripts/verify-patch-surface.ts`.
 */
import { readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'

const root = resolve(import.meta.dirname, '..')
const patchPath = join(root, 'cordis.patch.yml')
const presetDir = join(root, 'presets')
const snapshotPath = join(root, 'patch-surface.snapshot.json')
/** The bundle's own package name — a plugin row belongs to this bundle when
 *  its `name` is the bare package root or a subpath of it. */
const BUNDLE_PKG = '@deepseek-harness-edge-agent/dsh-edge-agent'

interface ParsedPatch {
  overrides: Array<{ id: string; disabled: boolean; hasConfig: boolean }>
  inserts: Array<{ id: string }>
}

/** One declared Agent Preset (§7.135). */
interface ParsedPreset {
  /** the preset FILE this was parsed from (variants share a config.id). */
  file?: string
  /** the preset's stable id (`config.id`) — what a session records. */
  presetId: string
  /** the declaration row id (`preset-edge`). */
  rowId: string
  /** display name / description / order. */
  name?: string
  description?: string
  order?: number
  /** the plugin rows, in declaration order. */
  plugins: Array<{ id: string; name: string }>
}

function parsePresets(text: string): ParsedPreset[] {
  const doc = parseYaml(text) as unknown
  const out: ParsedPreset[] = []
  if (!Array.isArray(doc)) return out
  for (const item of doc) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (!Array.isArray(record.insert)) continue
    for (const row of record.insert) {
      if (row === null || typeof row !== 'object') continue
      const r = row as Record<string, unknown>
      if (r.name !== '@deepseek-ai/dsh-agent-preset') continue
      const cfg = (r.config ?? {}) as Record<string, unknown>
      const pluginRows = Array.isArray(cfg.plugins) ? cfg.plugins : []
      out.push({
        presetId: typeof cfg.id === 'string' ? cfg.id : '?',
        rowId: typeof r.id === 'string' ? r.id : '?',
        name: typeof cfg.name === 'string' ? cfg.name : undefined,
        description: typeof cfg.description === 'string' ? cfg.description : undefined,
        order: typeof cfg.order === 'number' ? cfg.order : undefined,
        plugins: pluginRows
          .filter((p): p is Record<string, unknown> => p !== null && typeof p === 'object')
          .map((p) => ({
            id: typeof p.id === 'string' ? p.id : '?',
            name: typeof p.name === 'string' ? p.name : '?',
          })),
      })
    }
  }
  return out
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

interface Snapshot {
  inserts: string[]
  configOverrides: string[]
  disablesBeyondWebApp: string[]
  webAppDisablesBeyondTui: string[]
  insertsSharedWithWebApp: string[]
  /** §7.135: every declared Agent Preset and its plugin row ids. */
  presets: Record<string, string[]>
}

// ── parse the bundle patch + every preset patch ──────────────────────────
const patch = parsePatch(readFileSync(patchPath, 'utf8'))

const presetFiles = existsSync(presetDir)
  ? readdirSync(presetDir).filter((f) => f.endsWith('.patch.yml')).sort()
  : []
const presets: ParsedPreset[] = []
for (const file of presetFiles) {
  for (const p of parsePresets(readFileSync(join(presetDir, file), 'utf8'))) {
    // Two bundle variants (desktop-safe / full) each ship an edge preset and
    // both declare `config.id: edge` — they never live in the same profile,
    // so the id is not unique across FILES. Key the snapshot by file name.
    presets.push({ ...p, file })
  }
}

const computed: Snapshot = {
  inserts: patch.inserts.map(r => r.id),
  configOverrides: patch.overrides.filter(r => !r.disabled && r.hasConfig).map(r => r.id),
  disablesBeyondWebApp: patch.overrides.filter(r => r.disabled).map(r => r.id),
  webAppDisablesBeyondTui: [],
  insertsSharedWithWebApp: [],
  presets: Object.fromEntries(presets.map((p) => [p.file ?? p.presetId, p.plugins.map((x) => x.id)])),
}

// ── §7.135 semantic rule: the bundle's rows live INSIDE a preset ────────
const isBundleRow = (name: string): boolean =>
  name === BUNDLE_PKG || name.startsWith(`${BUNDLE_PKG}/`)

const bundleRowsInPreset = new Set<string>()
for (const p of presets) {
  for (const row of p.plugins) {
    if (isBundleRow(row.name)) bundleRowsInPreset.add(row.name)
  }
}
const bundleRowsAtTopLevel = patch.inserts
  .map((r) => r.id)
  .filter((id) => {
    // A row that is ALSO declared inside a preset is fine; the violation is
    // a row that lives ONLY at the top level (mounted for every mode).
    for (const preset of presets) {
      if (preset.plugins.some((x) => x.id === id)) return false
    }
    return true
  })

const violations: string[] = []
if (bundleRowsAtTopLevel.length > 0) {
  violations.push(
    `bundle plugin rows left in the top-level insert section: ${bundleRowsAtTopLevel.join(', ')}`
    + ' — a top-level row is mounted for EVERY work mode; the 边缘模式 would'
    + ' not be a separate mode at all.',
  )
}
if (presets.length === 0) {
  violations.push('no Agent Preset declared — the edge stack has no work mode to live in.')
}
for (const p of presets) {
  if (p.presetId === 'edge' || p.presetId === 'edge.desktop-safe') {
    const bundleRows = p.plugins.filter((x) => isBundleRow(x.name))
    if (bundleRows.length === 0) {
      violations.push(`preset "${p.presetId}" carries no bundle rows — it is just standard mode.`)
    }
  }
}

if (violations.length > 0) {
  console.error('patch-surface semantic violations:')
  for (const v of violations) console.error(`  - ${v}`)
  process.exit(1)
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
  JSON.stringify(recorded.disablesBeyondWebApp) === JSON.stringify(computed.disablesBeyondWebApp) &&
  JSON.stringify(recorded.presets ?? {}) === JSON.stringify(computed.presets)

if (same) {
  const presetRows = Object.values(computed.presets).reduce((n, ids) => n + ids.length, 0)
  console.log(
    `patch-surface OK (${computed.inserts.length} inserts, ` +
      `${computed.configOverrides.length} config overrides, ` +
      `${computed.disablesBeyondWebApp.length} disables, ` +
      `${Object.keys(computed.presets).length} presets / ${presetRows} plugin rows)`,
  )
  process.exit(0)
}
console.error('patch-surface drifted from snapshot:')
console.error('  recorded:', JSON.stringify(recorded))
console.error('  current :', JSON.stringify(computed))
console.error('Review the diff, then regenerate: node --import tsx/esm scripts/verify-patch-surface.ts --snapshot')
process.exit(1)