/**
 * §7.136 — Agent Preset isolate-realm contract.
 *
 * 宿主 DSH 的 Agent Preset 挂载审计
 * （@deepseek-ai/dsh-agent-preset-registry/lib/types/mount.js）：
 *
 *   const leaked = leakedServices(ctx, ctx.fiber)
 *   if (audit.failed.length > 0) throw new Error(audit.failed.join("\n"))
 *   if (leaked.length > 0) throw new Error(`Preset services require isolate realms: ${leaked.join(", ")}`)
 *
 * `leakedServices`（同文件 :109-123）判定：挂在 preset 子树里的服务，如果存进
 * 的是 **root realm** 的 symbol ⇒ 泄漏 ⇒ 整个 preset 挂载失败 ⇒ 设置页那张卡
 * 显示「加载失败」。§7.135 那版预设就是这么挂的。
 *
 * 宿主的解法（dsh-agent-preset-registry/README.zh.md 原文）：
 *   「preset 的服务提供方及其消费方必须共享同一个 `cordis:group` 隔离 realm。」
 *   「A preset plugin that supplies a service must isolate the provider and all
 *     its consumers in the same realm.」
 *
 * 本门禁把这条规则变成静态检查（不需要宿主进程）：
 *
 *   1. preset 里每一行**提供服务**的行，必须与它的消费方在同一个
 *      `cordis:group` 里，且该组的 `isolate` 名单包含这个服务名
 *      —— 否则它把服务存进 root realm ⇒ 泄漏 ⇒ 加载失败。
 *   2. 组内消费方 inject 的服务，如果**不由组内任何行提供**（宿主服务，或
 *      宿主树上的行），就**不能**出现在该组的 `isolate` 名单里
 *      —— 否则组内去找一个隔离 realm 里不存在的实例 ⇒ 该行永远 pending。
 *   3. 同一个服务不能既被 preset 内的行提供、又被宿主树上的行提供
 *      —— 第二次 provide 会抛 "service X has been registered at" ⇒ 挂载失败。
 *   4. `isolate` 名单里的每个服务名都必须真由组内某行提供（名单不许有幽灵项）。
 *
 * 「某行提供哪个服务」不是写死的：门禁按行的 `name:` 回到
 * src/dsh-adapter/<sub>.ts 读 `super(<ctx>, '<service>')`；「某行消费哪些服务」
 * 读同文件的 `export const inject = [...]`。改源码 ⇒ 门禁自动跟着变。
 *
 * Run via `node --import tsx/esm scripts/verify-preset-isolate.ts`.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'

const root = resolve(import.meta.dirname, '..')
const presetDir = join(root, 'presets')
const adapterDir = join(root, 'src', 'dsh-adapter')
/** The bundle's own package name — a plugin row belongs to this bundle when
 *  its `name` is the bare package root or a subpath of it. */
const BUNDLE_PKG = '@dsh-edge/dsh-edge-agent'

interface PluginFacts {
  /** The ctx service this plugin provides (`Service` subclass constructor). */
  service?: string
  /** The services this plugin injects. */
  inject: string[]
}

/**
 * Strip comments before scanning a plugin source for facts.
 *
 * A comment that quotes host code (`super(ctx, 'agents')`) used to be read as
 * a real service registration — the scan took the FIRST match, so a docstring
 * could shadow the actual `super(ctx, 'inputGuard')` and the gate then demanded
 * an isolate entry for a service the plugin never provides.
 *
 * Line comments are only stripped when `//` starts the line or follows
 * whitespace, so URLs (`http://…`) survive.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/gm, '$1')
}

/** Read a plugin's facts out of its adapter source. */
function factsOf(sub: string): PluginFacts | undefined {
  const file = join(adapterDir, `${sub}.ts`)
  if (!existsSync(file)) return undefined
  const src = stripComments(readFileSync(file, 'utf8'))
  const service = src.match(/super\(\s*\w+\s*,\s*'([^']+)'\s*\)/)?.[1]
  return { service, inject: parseInject(src) }
}

/** Parse `export const inject = [ ... ]` — comments stripped first, so a
 *  quoted service name inside a comment never counts as a dependency. */
function parseInject(src: string): string[] {
  const head = src.match(/export const inject\s*=\s*\[/)
  if (!head) return []
  const start = head.index! + head[0].length
  let depth = 1
  let i = start
  while (i < src.length && depth > 0) {
    if (src[i] === '[') depth++
    else if (src[i] === ']') depth--
    if (depth === 0) break
    i++
  }
  const body = src.slice(start, i).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1])
}
/** The subpath of a bundle plugin row, or undefined for a host row. */
function subOf(name: unknown): string | undefined {
  if (typeof name !== 'string') return undefined
  if (!name.startsWith(`${BUNDLE_PKG}/`)) return undefined
  return name.slice(BUNDLE_PKG.length + 1)
}

interface Row {
  id: string
  name?: string
  group?: boolean
  isolate?: Record<string, unknown>
  config?: Row[]
  /** §7.179: a leaf row's scalar config map (groups use `config` for children). */
  rowConfig?: Record<string, unknown>
}

/** One preset document: its own id plus its plugin rows (groups expanded). */
interface PresetDoc {
  presetId?: string
  rows: Row[]
}

/** One plugin row → Row (groups keep their children; leaves keep their config map). */
function toRow(raw: Record<string, unknown>): Row {
  const rowCfg = raw.config
  const scalarCfg = rowCfg !== null && typeof rowCfg === 'object' && !Array.isArray(rowCfg)
    ? (rowCfg as Record<string, unknown>)
    : undefined
  return {
    id: typeof raw.id === 'string' ? raw.id : '?',
    name: typeof raw.name === 'string' ? raw.name : undefined,
    group: raw.group === true,
    isolate: (raw.isolate ?? undefined) as Record<string, unknown> | undefined,
    config: Array.isArray(rowCfg)
      ? (rowCfg as unknown[]).map((c) => toRow((c ?? {}) as Record<string, unknown>))
      : undefined,
    rowConfig: scalarCfg,
  }
}

/** Parse one preset patch file into its plugin rows (groups expanded). */
function parsePresetDoc(text: string): PresetDoc {
  const doc = parseYaml(text) as unknown
  const out: Row[] = []
  let presetId: string | undefined
  if (!Array.isArray(doc)) return { presetId, rows: out }
  for (const item of doc) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (!Array.isArray(record.insert)) continue
    for (const raw of record.insert) {
      if (raw === null || typeof raw !== 'object') continue
      const r = raw as Record<string, unknown>
      if (r.name !== '@deepseek-ai/dsh-agent-preset') continue
      const cfg = (r.config ?? {}) as Record<string, unknown>
      if (typeof cfg.id === 'string') presetId = cfg.id
      const plugins = Array.isArray(cfg.plugins) ? cfg.plugins : []
      for (const p of plugins) {
        if (p === null || typeof p !== 'object') continue
        out.push(toRow(p as Record<string, unknown>))
      }
    }
  }
  return { presetId, rows: out }
}

/** Parse one preset patch file into its plugin rows (groups expanded). */
function parsePresetRows(text: string): Row[] {
  return parsePresetDoc(text).rows
}

/** Top-level insert rows of a bundle patch file. */
function parseTopLevelInserts(text: string): Row[] {
  const doc = parseYaml(text) as unknown
  const out: Row[] = []
  if (!Array.isArray(doc)) return out
  for (const item of doc) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (!Array.isArray(record.insert)) continue
    for (const raw of record.insert) {
      if (raw === null || typeof raw !== 'object') continue
      const r = raw as Record<string, unknown>
      out.push({
        id: typeof r.id === 'string' ? r.id : '?',
        name: typeof r.name === 'string' ? r.name : undefined,
      })
    }
  }
  return out
}

/* ── collect ─────────────────────────────────────────────────────────── */

const violations: string[] = []

const presetFiles = existsSync(presetDir)
  ? readdirSync(presetDir).filter((f) => f.endsWith('.patch.yml')).sort()
  : []
if (presetFiles.length === 0) {
  console.error('no preset patch files found under presets/')
  process.exit(1)
}

/** Services provided by the HOST tree (the bundle's top-level insert rows). */
const hostTreeServices = new Map<string, string>()
/** service → the plugin specifier that provides it (for diagnostics). */
const hostTreePlugins = new Map<string, string>()
for (const file of ['cordis.patch.yml', 'cordis.desktop-safe.patch.yml']) {
  const path = join(root, file)
  if (!existsSync(path)) continue
  for (const row of parseTopLevelInserts(readFileSync(path, 'utf8'))) {
    const sub = subOf(row.name)
    if (!sub) continue
    const facts = factsOf(sub)
    if (facts?.service) {
      hostTreeServices.set(facts.service, `${file}#${row.id}`)
      hostTreePlugins.set(facts.service, row.name!)
    }
  }
}

let checkedGroups = 0
let checkedRows = 0

/**
 * Apply the four rules to one preset's rows.
 *
 * @param file - the preset file name (for diagnostics)
 * @param rows - the preset's plugin rows (groups expanded)
 * @param hostTreeServices - service → host-tree row, for rule 3
 * @returns the violations found
 */
function collectViolations(
  file: string,
  rows: Row[],
  hostTreeServices: Map<string, string>,
  presetId?: string,
): string[] {
  const out: string[] = []
  const presetRows = rows.filter((r) => r.group === true)
  const leafRows = rows.filter((r) => r.group !== true)

  // Services provided by this preset's own rows — top-level leaves AND the
  // rows inside our groups (a group child is still a preset row).
  const presetServices = new Map<string, string>()
  const allPresetRows = [...leafRows, ...presetRows.flatMap((g) => g.config ?? [])]
  for (const row of allPresetRows) {
    const sub = subOf(row.name)
    if (!sub) continue
    const facts = factsOf(sub)
    if (facts?.service) presetServices.set(facts.service, row.id)
  }

  // Rule 3: a service provided on both sides ⇒ the second provide() throws.
  for (const [svc, where] of presetServices) {
    const host = hostTreeServices.get(svc)
    if (host) {
      out.push(
        `${file}: service "${svc}" is provided by preset row "${where}" AND by host-tree row "${host}"`
        + ' — the second provide() throws "service has been registered at" ⇒ the preset fails to mount.',
      )
    }
  }

  for (const group of presetRows) {
    const children = group.config ?? []
    // Only OUR groups are checked: a host group (planning / compaction /
    // delegation) isolates host services this gate cannot resolve.
    if (!children.some((c) => subOf(c.name))) continue
    checkedGroups++
    const isolated = new Set(Object.keys(group.isolate ?? {}))

    // Rule 1: a row that provides a service must have it isolated in this group.
    for (const child of children) {
      const sub = subOf(child.name)
      if (!sub) continue
      checkedRows++
      const facts = factsOf(sub)
      if (!facts) {
        out.push(`${file}: group "${group.id}" has a row "${child.id}" whose source (src/dsh-adapter/${sub}.ts) is missing.`)
        continue
      }
      if (facts.service && !isolated.has(facts.service)) {
        out.push(
          `${file}: group "${group.id}" row "${child.id}" provides service "${facts.service}"`
          + ' but that name is not in the group\'s isolate map ⇒ the service lands in the root realm'
          + ' ⇒ the preset mount audit reports a leak ⇒ 设置页显示「加载失败」.',
        )
      }
    }

    // Rule 2: an injected service that nobody in this group provides must not
    // be isolated here — the realm would hide the provider.
    for (const child of children) {
      const sub = subOf(child.name)
      if (!sub) continue
      const facts = factsOf(sub)
      if (!facts) continue
      for (const dep of facts.inject) {
        const providedHere = children.some((c) => {
          const csub = subOf(c.name)
          return csub ? factsOf(csub)?.service === dep : false
        })
        if (providedHere) continue
        if (isolated.has(dep)) {
          out.push(
            `${file}: group "${group.id}" isolates "${dep}", but no row in this group provides it`
            + ' (the provider is on the host tree or is a host service) ⇒ rows that inject it'
            + ' would wait forever inside the isolated realm.',
          )
        }
      }
    }

    // Rule 4: no ghost entries in the isolate map.
    for (const name of isolated) {
      const provided = children.some((c) => {
        const csub = subOf(c.name)
        return csub ? factsOf(csub)?.service === name : false
      })
      if (!provided) {
        out.push(
          `${file}: group "${group.id}" isolates "${name}" but no row in the group provides it`
          + ' — stale entry; run scripts/_isolate-edge-group.mjs to regenerate.',
        )
      }
    }
  }

  // Rule 5 (§7.179): the input-guard row must declare THIS preset's own id.
  //
  // `agent-preset/selected` is a GLOBAL host event (the registry emits it with
  // `ctx.emit(...)`, no scope carrier) ⇒ every work style's listeners see it
  // ⇒ input-guard has to filter by preset id. The id it filters on must be
  // this preset's id — a mismatch means the §7.179 re-pin never fires and the
  // first turn after switching work styles is blocked by the §7.175 gate.
  const guardRow = allPresetRows.find((r) => subOf(r.name) === 'input-guard')
  if (guardRow) {
    const declared = guardRow.rowConfig?.presetId
    if (typeof declared !== 'string' || declared.length === 0) {
      out.push(
        `${file}: the input-guard row does not declare config.presetId`
        + ' — it cannot filter the global "agent-preset/selected" event ⇒ the §7.179 re-pin never fires.',
      )
    } else if (declared !== presetId) {
      out.push(
        `${file}: the input-guard row declares config.presetId "${declared}" but the preset id is`
        + ` "${presetId ?? '?'}" ⇒ the §7.179 re-pin would never fire.`,
      )
    }
  }
  return out
}

const parsed = presetFiles.map((file) => {
  const doc = parsePresetDoc(readFileSync(join(presetDir, file), 'utf8'))
  return { file, presetId: doc.presetId, rows: doc.rows }
})

for (const { file, presetId, rows } of parsed) {
  violations.push(...collectViolations(file, rows, hostTreeServices, presetId))
}

// ── 自测：故意破坏一次，确认规则真的会响 ───────────────────────────────
if (process.argv.includes('--selftest')) {
  const selfViolations: string[] = []
  for (const { file, presetId, rows } of parsed) {
    const group = rows.find((r) => r.group === true && (r.config ?? []).some((c) => subOf(c.name)))
    if (!group) continue
    const provider = (group.config ?? []).find((c) => {
      const sub = subOf(c.name)
      return sub ? factsOf(sub)?.service !== undefined : false
    })
    if (!provider) continue
    const svc = factsOf(subOf(provider.name)!)!.service!

    // (a) 从 isolate 名单里删掉一个真实存在的服务 ⇒ 规则 1 必须响。
    const broken = JSON.parse(JSON.stringify(rows)) as Row[]
    const brokenGroup = broken.find((r) => r.id === group.id)!
    delete brokenGroup.isolate![svc]
    const a = collectViolations(file, broken, hostTreeServices, presetId)
    if (!a.some((v) => v.includes(`"${svc}"`))) {
      selfViolations.push(`selftest(a): removing "${svc}" from the isolate map produced no violation`)
    }

    // (b) 往 isolate 名单里塞一个没人提供的服务 ⇒ 规则 4 必须响。
    const ghost = JSON.parse(JSON.stringify(rows)) as Row[]
    const ghostGroup = ghost.find((r) => r.id === group.id)!
    ghostGroup.isolate = { ...(ghostGroup.isolate ?? {}), 'edgeGhostService': true }
    const b = collectViolations(file, ghost, hostTreeServices, presetId)
    if (!b.some((v) => v.includes('edgeGhostService'))) {
      selfViolations.push('selftest(b): a ghost isolate entry produced no violation')
    }

    // (c) 把宿主树上的行也塞进 preset ⇒ 规则 3 必须响。
    const hostService = [...hostTreeServices.keys()][0]
    const hostPlugin = hostService ? hostTreePlugins.get(hostService) : undefined
    if (hostService && hostPlugin) {
      const both = JSON.parse(JSON.stringify(rows)) as Row[]
      const bothGroup = both.find((r) => r.id === group.id)!
      bothGroup.config = [...(bothGroup.config ?? []), { id: 'selftest-duplicate', name: hostPlugin }]
      const c = collectViolations(file, both, hostTreeServices, presetId)
      if (!c.some((v) => v.includes(`"${hostService}"`) && v.includes('host-tree row'))) {
        selfViolations.push(`selftest(c): a service on both sides ("${hostService}") produced no violation`)
      }
    }

    // (d) §7.179 规则 5：把 input-guard 行的 presetId 改成别的 ⇒ 必须响。
    const wrongId = JSON.parse(JSON.stringify(rows)) as Row[]
    const wrongGroup = wrongId.find((r) => r.id === group.id)!
    const guardChild = (wrongGroup.config ?? []).find((c) => subOf(c.name) === 'input-guard')
    if (guardChild) {
      guardChild.rowConfig = { ...(guardChild.rowConfig ?? {}), presetId: 'not-the-preset' }
      const d = collectViolations(file, wrongId, hostTreeServices, presetId)
      if (!d.some((v) => v.includes('config.presetId'))) {
        selfViolations.push('selftest(d): a mismatched input-guard presetId produced no violation')
      }
    } else {
      selfViolations.push('selftest(d): no input-guard row found in the edge group')
    }
  }
  if (selfViolations.length > 0) {
    console.error('preset isolate selftest FAILED:')
    for (const v of selfViolations) console.error(`  - ${v}`)
    process.exit(1)
  }
  console.log('preset isolate selftest OK (rules 1/3/4/5 all fire on a broken preset)')
}

if (violations.length > 0) {
  console.error('preset isolate-realm violations:')
  for (const v of violations) console.error(`  - ${v}`)
  process.exit(1)
}

// The selftest above re-runs the checks on mutated copies; recount on the
// real presets so the summary reports the shipped state, not the mutations.
checkedGroups = 0
checkedRows = 0
for (const { file, rows } of parsed) collectViolations(file, rows, hostTreeServices)

console.log(
  `preset isolate OK (${presetFiles.length} preset files, ${checkedGroups} edge group(s),`
  + ` ${checkedRows} bundle rows, ${hostTreeServices.size} host-tree service(s))`,
)
