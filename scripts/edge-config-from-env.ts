/**
 * edge-config-from-env.ts — freeze the current environment into
 * config/edge.json (§7.102's single source of truth).
 *
 * The inverse of scripts/edge-config-env.mjs: that one reads the file and
 * exports shell variables, this one reads the shell's variables and writes
 * the file.
 *
 * Why it exists: the DSH_EDGE_* env layer is an OVERRIDE layer — edge-config.ts
 * applies it on top of the file, so a stale export in the operator's shell
 * silently wins over the file (observed 2026-10-26: a developer's shell carried
 * the retired .env.sh translation layer, which pinned the HTTP listener to
 * :21018 while config/edge.json said :21017). Freezing the environment into
 * the file and letting the file drive the runtime removes that class of drift.
 *
 * How the mapping is obtained (no second source of truth): the env layer is
 * edge-config.ts's own applyEnvOverrides() — the SAME function the runtime
 * uses, applied to the merged config. "env → file" and "file → plugin" are
 * the same mapping, by construction.
 *
 * Secrets: the raw provider keys (DEEPSEEK_API_KEY / DASHSCOPE_API_KEY /
 * TAVILY_API_KEY / BOCHA_API_KEY / EDGE_API_KEY / MINIMAX_API_KEY / …) are
 * copied into config/edge.json's secrets section, because in the FILE world a
 * pool's `keyRef` names a secrets.* FIELD (resolveSecret() looks the key up
 * in cfg.secrets), not an environment slot. The file is gitignored and
 * written 0600.
 *
 * ── §7.154 (2026-10-29): four defects this version fixes ──────────────────
 *
 * The previous version copied the TEMPLATE over the target file as its first
 * act (`copyFileSync(template, opts.out)`) and only then decided whether it
 * was allowed to write. That made three of its four documented behaviours
 * wrong:
 *
 *   ① --dry-run DESTROYED the target. The copy happened before the dry-run
 *      check, so the operator's live config/edge.json was replaced by the
 *      example template and the script then printed "未写入". Reproduced
 *      2026-10-29: the custom keys vanished and http.port was reset.
 *   ② Secrets that existed ONLY in the real file were wiped. The template is
 *      a blank skeleton; the operator's `secrets.*` are not in it, so the
 *      script rebuilt the secrets section from the environment alone. A key
 *      that is not in the environment (e.g. an operator-specific slot such
 *      as `aliyuntokenplanApiKey`) simply disappeared — and there was no
 *      backup.
 *   ③ The env-slot table was a SECOND source of truth and it had drifted:
 *      it listed `bailianApiKey` but not `minimaxApiKey`, so a MiniMax key
 *      lived in the environment but could never reach the file. The table is
 *      now DERIVED from the slot name (camelCase → SNAKE_CASE), which holds
 *      for every slot the project has ever used and covers slots the
 *      operator invents.
 *   ④ `--out=<path>` pointed somewhere else, but the env layer was still
 *      taken from the CANONICAL config/edge.json (the script relied on
 *      loadEdgeConfig(), which reads a fixed candidate list). The written
 *      file did not match the env that produced it.
 *
 * The shape now:
 *
 *   template  ┐
 *             ├─ deep merge (existing wins per leaf) ─→ apply env overrides ─┐
 *   existing  ┘                                                                ├─→ write (0600)
 *                                                                          backup first
 *
 * Nothing touches the filesystem until the final write — --dry-run is now
 * genuinely read-only.
 *
 * Usage:
 *   node --import tsx/esm scripts/edge-config-from-env.ts [--out=<path>] [--port=<n>] [--dry-run]
 *   node --import tsx/esm scripts/edge-config-from-env.ts --selftest
 */
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { applyEnvOverrides } from '../src/dsh-adapter/edge-config.js'

const ROOT = resolve(import.meta.dirname, '..')

/**
 * Env slot → secrets.* field, for slots whose env var name does NOT follow
 * the camelCase → SNAKE_CASE convention. Every slot the project ships
 * follows it (edgeApiKey → EDGE_API_KEY, dashscopeApiKey → DASHSCOPE_API_KEY,
 * minimaxApiKey → MINIMAX_API_KEY, …), so this table is normally EMPTY; it
 * exists only for the odd slot that needs a different env var name.
 */
const SECRET_SLOT_OVERRIDES: Record<string, string> = {
  EDGE_API_KEY: 'edgeApiKey',
}

/**
 * Derive the env var name for a secrets.* field.
 *
 * camelCase → SNAKE_CASE: `edgeApiKey` → `EDGE_API_KEY`. This is the
 * convention every shipped slot already follows, which is why deriving the
 * name beats hardcoding a table that silently drifts (§7.154 defect ③).
 */
export function fieldToEnvSlot(field: string): string {
  return field
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1_$2')
    .toUpperCase()
}

/**
 * Inverse of {@link fieldToEnvSlot}: an env slot name → the secrets.* field
 * it fills. `ALIASYUNTOKENPLAN_API_KEY` → `aliyuntokenplanApiKey`.
 */
export function envSlotToField(slot: string): string {
  const override = SECRET_SLOT_OVERRIDES[slot]
  if (override) return override
  return slot
    .toLowerCase()
    .replace(/_([a-z0-9])/gu, (_, c: string) => c.toUpperCase())
}

/** True for a plain JSON object (not null, not an array). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Deep-merge `overlay` onto `base`, with the overlay winning per leaf.
 * Secrets, pools and stages merge key-by-key, so a file that mentions one
 * key of a section still inherits the section's other keys.
 */
export function deepMerge<T extends Record<string, unknown>>(base: T, overlay: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(overlay)) {
    const current = out[key]
    out[key] = isPlainObject(current) && isPlainObject(value)
      ? deepMerge(current, value)
      : value
  }
  return out as T
}

interface Options {
  out: string
  port: number | undefined
  dryRun: boolean
  selftest: boolean
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    out: join(ROOT, 'config', 'edge.json'),
    port: undefined,
    dryRun: false,
    selftest: false,
  }
  for (const arg of argv) {
    if (arg.startsWith('--out=')) opts.out = resolve(arg.slice('--out='.length))
    else if (arg.startsWith('--port=')) {
      const n = Number(arg.slice('--port='.length))
      if (!Number.isFinite(n)) { console.error('--port 需要是数字'); process.exit(2) }
      opts.port = n
    } else if (arg === '--dry-run') opts.dryRun = true
    else if (arg === '--selftest') opts.selftest = true
    else { console.error(`unknown option: ${arg}`); process.exit(2) }
  }
  return opts
}

/** Read + parse a JSON file; undefined when absent or unparseable. */
function readJsonSafe(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    return isPlainObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Build the config that WOULD be written, without touching the filesystem.
 *
 * @param out        target path (read to preserve the operator's secrets)
 * @param template   the example template path
 * @param port       optional http.port override
 * @param env        process.env-like map (injectable for the selftest)
 */
export function buildConfig(
  out: string,
  template: string,
  port: number | undefined,
  env: Record<string, string | undefined>,
): Record<string, any> {
  const templateCfg = readJsonSafe(template) ?? {}

  // The operator's live config wins over the template, leaf by leaf. The
  // template only fills in what the real file does not mention — so a
  // secret that exists only in the real file SURVIVES (§7.154 defect ②).
  const existingCfg = readJsonSafe(out)
  const base = existingCfg ? deepMerge(templateCfg, existingCfg) : templateCfg

  // The env layer needs these sections to exist.
  base.llm = { ...(base.llm ?? {}) }
  base.llm.local = { ...(base.llm.local ?? {}) }
  base.llm.cloud = { ...(base.llm.cloud ?? {}) }
  base.secrets = { ...(base.secrets ?? {}) }

  // The authoritative env → config layer (the SAME one the runtime applies).
  const cfg = applyEnvOverrides(base as never) as Record<string, any>

  // Secrets: every slot the merged config knows about, filled from the
  // environment when the env var is present. The env var name is DERIVED
  // from the slot name (§7.154 defect ③) — a slot the operator invents
  // (aliyuntokenplanApiKey) works without touching this script.
  const secrets = (cfg.secrets ??= {})
  const secretReport: string[] = []
  for (const field of Object.keys(secrets)) {
    const slot = fieldToEnvSlot(field)
    const value = env[slot]
    if (value === undefined || value.length === 0) continue
    secrets[field] = value
    secretReport.push(`${field}✓`)
  }

  // keyRef: an env SLOT name means "secrets.<field>" in the file world —
  // resolveSecret() looks the key up in cfg.secrets. A keyRef that is
  // ALREADY a field name is left alone (it is valid as-is).
  const pools: Array<[string, any]> = [
    ['llm.local', cfg.llm?.local],
    ['llm.cloud', cfg.llm?.cloud],
  ]
  for (const [name, pool] of pools) {
    if (!pool || typeof pool.keyRef !== 'string' || pool.keyRef.length === 0) continue
    // Already a secrets field name with a value → nothing to translate.
    // (Without this check the log would claim "环境里没有该 slot" for a
    // perfectly valid operator-owned slot such as aliyuntokenplanApiKey.)
    const asField = secrets[pool.keyRef]
    if (typeof asField === 'string' && asField.length > 0) continue
    const field = envSlotToField(pool.keyRef)
    if (field === pool.keyRef) continue
    if (typeof secrets[field] !== 'string' || secrets[field].length === 0) {
      // The slot is named but the value isn't in the environment — keep the
      // slot name (the adapter can still read it from process.env).
      console.log(`[edge-config-from-env] ${name}.keyRef=${pool.keyRef}：环境里没有该 slot，保留 slot 名`)
      continue
    }
    pool.keyRef = field
    console.log(`[edge-config-from-env] ${name}.keyRef: ${pool.keyRef} → ${field}（文件世界按 secrets 字段解析）`)
  }

  if (port !== undefined) {
    cfg.http = { ...(cfg.http ?? {}) }
    cfg.http.port = port
  }

  return cfg
}

/* ── selftest ──────────────────────────────────────────────────────────── */

function selftest(): void {
  const tmp = join(ROOT, 'dist', '.edge-config-from-env.selftest')
  mkdirSync(tmp, { recursive: true })
  const template = join(tmp, 'template.json')
  const target = join(tmp, 'edge.json')

  const checks: Array<[string, boolean]> = []
  const check = (name: string, ok: boolean): void => { checks.push([name, ok]) }

  // Fixture: a template with one empty slot, and a live config carrying a
  // secret the template does NOT have (the operator's own slot).
  writeFileSync(template, JSON.stringify({
    secrets: { edgeApiKey: '', minimaxApiKey: '' },
    http: { host: '127.0.0.1', port: 21017 },
    llm: { local: { keyRef: 'edgeApiKey' }, cloud: {} },
  }, null, 2))
  writeFileSync(target, JSON.stringify({
    secrets: { aliyuntokenplanApiKey: 'operator-secret-value' },
    http: { host: '127.0.0.1', port: 21018 },
    llm: { local: { keyRef: 'aliyuntokenplanApiKey' }, cloud: {} },
  }, null, 2))

  const before = readFileSync(target, 'utf-8')

  // ① --dry-run must not touch the target at all.
  const dry = buildConfig(target, template, undefined, {})
  check('dry-run 产物里的 secrets 保留原文件独有的槽位', dry.secrets.aliyuntokenplanApiKey === 'operator-secret-value')
  check('dry-run 产物里的 http.port 保留原文件的值', dry.http.port === 21018)
  check('dry-run 之后目标文件逐字节未变', readFileSync(target, 'utf-8') === before)

  // ② env wins over the file, but only for the slots the env actually has.
  const withEnv = buildConfig(target, template, undefined, {
    EDGE_API_KEY: 'env-edge-key',
    ALIYUNTOKENPLAN_API_KEY: 'env-operator-key',
  })
  check('env 覆盖 secrets.edgeApiKey', withEnv.secrets.edgeApiKey === 'env-edge-key')
  check('env 覆盖 operator 槽位（派生出的 env 名）', withEnv.secrets.aliyuntokenplanApiKey === 'env-operator-key')
  check('模板里没有的槽位不会被凭空造出来', typeof withEnv.secrets.minimaxApiKey === 'string' || withEnv.secrets.minimaxApiKey === undefined)

  // ③ --port still works.
  const withPort = buildConfig(target, template, 21099, {})
  check('--port 覆盖 http.port', withPort.http.port === 21099)

  // ④ derived slot names.
  check('fieldToEnvSlot(edgeApiKey) = EDGE_API_KEY', fieldToEnvSlot('edgeApiKey') === 'EDGE_API_KEY')
  check('fieldToEnvSlot(minimaxApiKey) = MINIMAX_API_KEY', fieldToEnvSlot('minimaxApiKey') === 'MINIMAX_API_KEY')
  check('fieldToEnvSlot(aliyuntokenplanApiKey) = ALIYUNTOKENPLAN_API_KEY', fieldToEnvSlot('aliyuntokenplanApiKey') === 'ALIYUNTOKENPLAN_API_KEY')
  check('fieldToEnvSlot(dashscopeApiKey) = DASHSCOPE_API_KEY', fieldToEnvSlot('dashscopeApiKey') === 'DASHSCOPE_API_KEY')
  check('envSlotToField(MINIMAX_API_KEY) = minimaxApiKey', envSlotToField('MINIMAX_API_KEY') === 'minimaxApiKey')
  check('envSlotToField(ALIYUNTOKENPLAN_API_KEY) = aliyuntokenplanApiKey', envSlotToField('ALIYUNTOKENPLAN_API_KEY') === 'aliyuntokenplanApiKey')

  // ⑤ deep merge keeps the other keys of a merged section.
  const merged = deepMerge(
    { llm: { local: { model: 'a', keyRef: 'x' } } },
    { llm: { local: { keyRef: 'y' } } },
  ) as any
  check('deepMerge 逐叶合并（model 保留、keyRef 被覆盖）', merged.llm.local.model === 'a' && merged.llm.local.keyRef === 'y')

  const failed = checks.filter(([, ok]) => !ok)
  for (const [name, ok] of checks) console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`)
  if (failed.length > 0) {
    console.error(`selftest: ${failed.length} checks FAILED`)
    process.exit(1)
  }
  console.log(`selftest: all ${checks.length} checks passed`)
}

/* ── main ──────────────────────────────────────────────────────────────── */

const opts = parseArgs(process.argv.slice(2))

if (opts.selftest) {
  selftest()
  process.exit(0)
}

const template = join(ROOT, 'config', 'edge.example.json')
if (!existsSync(template)) {
  console.error(`[edge-config-from-env] template missing: ${template}`)
  process.exit(1)
}

// Build the config WITHOUT touching the filesystem. --dry-run stops here.
const cfg = buildConfig(opts.out, template, opts.port, process.env)
const json = JSON.stringify(cfg, null, 2) + '\n'

if (opts.dryRun) {
  console.log('[edge-config-from-env] --dry-run：未写入（目标文件未被触碰）')
} else {
  mkdirSync(dirname(opts.out), { recursive: true })
  // Back up the operator's current config before overwriting it. A frozen
  // environment must never be able to destroy the live one (§7.154 defect ②).
  if (existsSync(opts.out)) {
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
    const backup = `${opts.out}.bak-${stamp}`
    copyFileSync(opts.out, backup)
    chmodSync(backup, 0o600)
    console.log(`[edge-config-from-env] 已备份原文件 → ${backup}`)
  }
  writeFileSync(opts.out, json, { mode: 0o600 })
  chmodSync(opts.out, 0o600)
  console.log(`[edge-config-from-env] 已写入 ${opts.out} (0600)`)
}

// ── report — never print a secret value ────────────────────────────────
const http = cfg.http ?? {}
const secretSlots = Object.keys(cfg.secrets ?? {}).filter((k) => !k.startsWith('_'))
const filled = secretSlots.filter((k) => {
  const v = (cfg.secrets as Record<string, unknown>)[k]
  return typeof v === 'string' && v.length > 0
})
console.log(`  http          ${http.host}:${http.port}`)
console.log(`  llm.local     ${cfg.llm?.local?.baseUrl || '(unset)'} model=${cfg.llm?.local?.model || '(跟随池)'} keyRef=${cfg.llm?.local?.keyRef || '-'}`)
console.log(`  llm.cloud     ${cfg.llm?.cloud?.baseUrl || '(delegate)'} model=${cfg.llm?.cloud?.model || '-'} keyRef=${cfg.llm?.cloud?.keyRef || '-'} delegate=${cfg.llm?.cloud?.delegate}`)
console.log(`  secrets       已填 ${filled.length}/${secretSlots.length} 个槽位${filled.length ? `（${filled.join(' ')}）` : ''}`)
console.log(`  intent        provider=${cfg.stages?.intent?.provider} llmFallback=${cfg.stages?.intent?.llmFallback}`)
console.log(`  jev           enabled=${cfg.jev?.enabled} provider=${cfg.jev?.provider} url=${cfg.jev?.url ?? '-'}`)
console.log(`  fce           enabled=${cfg.functionCallExternal?.enabled} url=${cfg.functionCallExternal?.url ?? '-'}`)
