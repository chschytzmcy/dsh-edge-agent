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
 * §7.136 (2026-10-28): rule 2 got an exception, and the reason is the host
 * mechanism — three rows MUST stay on the host tree:
 *
 *  - `dsh-edge-agent`（裸包名行）: the host's client-modules scans
 *    `ctx.loader.entries()` — the HOST Loader's entries. A preset's plugin
 *    list lives in its own EntryTree, outside that enumeration, so the
 *    browser half (the Edge tab's webview) is only discoverable from a bare
 *    row on the host tree.
 *  - `audit-log` / `file-logger`: the bare row injects `auditLog`, and its
 *    apply() installs the file logger (which claims the `fileLogger`
 *    service name). Both must therefore live in the root realm.
 *
 * The preset's own rows now sit inside a `cordis:group` with an `isolate`
 * map — the host refuses to mount a preset whose rows publish services into
 * the root realm (that is what made 设置页 show 「加载失败」). The isolate
 * contract itself is gated by scripts/verify-preset-isolate.ts.
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
        plugins: flattenPluginRows(pluginRows),
      })
    }
  }
  return out
}

/**
 * Flatten a preset's plugin list: a `group: true` row contributes itself AND
 * the rows nested in its `config` list (§7.136 puts this bundle's rows inside
 * a `cordis:group` so their services live in an isolated realm).
 */
function flattenPluginRows(
  pluginRows: unknown[],
): Array<{ id: string; name: string }> {
  const out: Array<{ id: string; name: string }> = []
  for (const p of pluginRows) {
    if (p === null || typeof p !== 'object') continue
    const row = p as Record<string, unknown>
    out.push({
      id: typeof row.id === 'string' ? row.id : '?',
      name: typeof row.name === 'string' ? row.name : '?',
    })
    if (row.group === true && Array.isArray(row.config)) {
      for (const child of row.config) {
        if (child === null || typeof child !== 'object') continue
        const c = child as Record<string, unknown>
        out.push({
          id: typeof c.id === 'string' ? c.id : '?',
          name: typeof c.name === 'string' ? c.name : '?',
        })
      }
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

// ── §7.135/§7.136 semantic rule: the bundle's rows live INSIDE a preset ─
//
// §7.136 修正：有三行**必须**留在宿主树（顶层 insert 段）—— 宿主机制的限制，
// 不是偏好：
//
//   dsh-edge-agent（裸包名行）—— 宿主的 client-modules 只扫宿主 Loader 的
//     entries（`ctx.loader.entries()`），preset 的插件树不在其中 ⇒ Edge tab
//     的浏览器半边只有从宿主树里的裸包名行才能被发现。
//   audit-log / file-logger —— 裸包名行 inject ['auditLog']，且它 apply() 里的
//     installFileLogger 会先占住 `fileLogger` 服务名 ⇒ 两者必须在 root realm。
//
// 其余本 bundle 的行必须住在 preset 里：留在顶层 insert 段的行对**所有**工作
// 方式生效 —— 那样切回标准模式时 Edge 的行为依然在跑，「标准模式 + 本项目功能」
// 就是空话。
const isBundleRow = (name: string): boolean =>
  name === BUNDLE_PKG || name.startsWith(`${BUNDLE_PKG}/`)

/** Rows the host mechanism forces onto the host tree (§7.136). */
const HOST_FORCED_ROWS = new Set(['dsh-edge-agent', 'file-logger', 'audit-log'])

const bundleRowsInPreset = new Set<string>()
for (const p of presets) {
  for (const row of p.plugins) {
    if (isBundleRow(row.name)) bundleRowsInPreset.add(row.name)
  }
}
const topLevelIds = [
  ...patch.inserts.map((r) => r.id),
  // The desktop-safe variant ships its own top-level patch; the semantic rule
  // must hold for BOTH (the desktop is the variant that ships).
  ...parsePatch(readFileSync(join(root, 'cordis.desktop-safe.patch.yml'), 'utf8')).inserts.map((r) => r.id),
]
const bundleRowsAtTopLevel = topLevelIds.filter((id) => {
  // A row that is ALSO declared inside a preset is fine; the violation is
  // a row that lives ONLY at the top level (mounted for every mode).
  for (const preset of presets) {
    if (preset.plugins.some((x) => x.id === id)) return false
  }
  return true
})

const violations: string[] = []
for (const id of bundleRowsAtTopLevel) {
  if (!HOST_FORCED_ROWS.has(id)) {
    violations.push(
      `bundle plugin row left in the top-level insert section: ${id}`
      + ' — a top-level row is mounted for EVERY work mode; the 边缘模式 would'
      + ' not be a separate mode at all. Move it into presets/edge*.patch.yml.',
    )
  }
}
for (const id of HOST_FORCED_ROWS) {
  if (!topLevelIds.includes(id)) {
    violations.push(
      `host-forced row "${id}" is missing from the top-level insert section`
      + ' — the host mechanism needs it on the host tree (see §7.136 in'
      + ' scripts/_isolate-edge-group.mjs).',
    )
  }
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