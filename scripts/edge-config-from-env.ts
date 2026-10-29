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
 * How the mapping is obtained (no second source of truth): the template is
 * written to the target path first, then loadEdgeConfig(true) merges it with
 * the built-in defaults and applies the SAME ENV_OVERRIDES layer the plugins
 * use — so "env → file" and "file → plugin" are the same mapping, by
 * construction.
 *
 * Secrets: the raw provider keys (DEEPSEEK_API_KEY / DASHSCOPE_API_KEY /
 * TAVILY_API_KEY / BOCHA_API_KEY / EDGE_API_KEY) are copied into
 * config/edge.json's secrets section, because in the FILE world a pool's
 * `keyRef` names a secrets.* FIELD (resolveSecret() looks the key up in
 * cfg.secrets), not an environment slot. The file is gitignored and written
 * 0600.
 *
 * Usage:
 *   node --import tsx/esm scripts/edge-config-from-env.ts [--out=<path>] [--port=<n>] [--dry-run]
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { loadEdgeConfig } from '../src/dsh-adapter/edge-config.js'

const ROOT = resolve(import.meta.dirname, '..')

/**
 * Raw env slot → secrets.* field. The env layer names a SLOT ("which env var
 * holds the key"); the file layer names a FIELD ("which key in secrets").
 * This table is the translation between the two worlds.
 */
const SECRET_SLOTS: Record<string, string> = {
  EDGE_API_KEY: 'edgeApiKey',
  DEEPSEEK_API_KEY: 'deepseekApiKey',
  DASHSCOPE_API_KEY: 'dashscopeApiKey',
  TAVILY_API_KEY: 'tavilyApiKey',
  BOCHA_API_KEY: 'bochaApiKey',
  BAILIAN_API_KEY: 'bailianApiKey',
}

function parseArgs(argv: string[]) {
  const opts = { out: join(ROOT, 'config', 'edge.json'), port: undefined as number | undefined, dryRun: false }
  for (const arg of argv) {
    if (arg.startsWith('--out=')) opts.out = resolve(arg.slice('--out='.length))
    else if (arg.startsWith('--port=')) opts.port = Number(arg.slice('--port='.length))
    else if (arg === '--dry-run') opts.dryRun = true
    else { console.error(`unknown option: ${arg}`); process.exit(2) }
  }
  return opts
}

const opts = parseArgs(process.argv.slice(2))
const template = join(ROOT, 'config', 'edge.example.json')
if (!existsSync(template)) {
  console.error(`[edge-config-from-env] template missing: ${template}`)
  process.exit(1)
}

// ── 1. seed the target with the template, then let edge-config.ts do the
//       env→config mapping (the authoritative one) ─────────────────────
mkdirSync(dirname(opts.out), { recursive: true })
copyFileSync(template, opts.out)
const cfg = loadEdgeConfig(true) as Record<string, any>

// ── 2. secrets: raw env slots → secrets.* fields ──────────────────────
const secrets = (cfg.secrets ??= {})
const secretReport: string[] = []
for (const [slot, field] of Object.entries(SECRET_SLOTS)) {
  const value = process.env[slot]
  if (value === undefined || value.length === 0) continue
  secrets[field] = value
  secretReport.push(`${field}✓`)
}

// ── 3. keyRef: env slot name → secrets field name ────────────────────
// "DASHSCOPE_API_KEY" (a slot) means "secrets.dashscopeApiKey" in the file
// world — resolveSecret() looks the key up in cfg.secrets.
const pools: Array<[string, any]> = [
  ['llm.local', cfg.llm?.local],
  ['llm.cloud', cfg.llm?.cloud],
]
for (const [name, pool] of pools) {
  if (!pool || typeof pool.keyRef !== 'string') continue
  const field = SECRET_SLOTS[pool.keyRef]
  if (!field) continue
  const slot = pool.keyRef
  if (typeof secrets[field] !== 'string' || secrets[field].length === 0) {
    // The slot is named but the value isn't in the environment — keep the
    // slot name (the adapter can still read it from process.env).
    console.log(`[edge-config-from-env] ${name}.keyRef=${slot}：环境里没有该 slot，保留 slot 名`)
    continue
  }
  pool.keyRef = field
  console.log(`[edge-config-from-env] ${name}.keyRef: ${slot} → ${field}（文件世界按 secrets 字段解析）`)
}

// ── 4. http.port override ─────────────────────────────────────────────
if (opts.port !== undefined) {
  if (!Number.isFinite(opts.port)) { console.error('--port 需要是数字'); process.exit(2) }
  cfg.http.port = opts.port
}

// ── 5. write ──────────────────────────────────────────────────────────
const json = JSON.stringify(cfg, null, 2) + '\n'
if (opts.dryRun) {
  console.log('[edge-config-from-env] --dry-run：未写入')
} else {
  writeFileSync(opts.out, json, { mode: 0o600 })
  chmodSync(opts.out, 0o600)
  console.log(`[edge-config-from-env] 已写入 ${opts.out} (0600)`)
}

// ── 6. report — never print a secret value ────────────────────────────
const http = cfg.http ?? {}
console.log(`  http          ${http.host}:${http.port}`)
console.log(`  llm.local     ${cfg.llm?.local?.baseUrl || '(unset)'} model=${cfg.llm?.local?.model || '(跟随池)'} keyRef=${cfg.llm?.local?.keyRef || '-'}`)
console.log(`  llm.cloud     ${cfg.llm?.cloud?.baseUrl || '(delegate)'} model=${cfg.llm?.cloud?.model || '-'} keyRef=${cfg.llm?.cloud?.keyRef || '-'} delegate=${cfg.llm?.cloud?.delegate}`)
console.log(`  secrets       ${secretReport.length ? secretReport.join(' ') : '(无 —— 环境里没有原始 key)'}`)
console.log(`  intent        provider=${cfg.stages?.intent?.provider} llmFallback=${cfg.stages?.intent?.llmFallback}`)
console.log(`  jev           enabled=${cfg.jev?.enabled} provider=${cfg.jev?.provider} url=${cfg.jev?.url ?? '-'}`)
console.log(`  fce           enabled=${cfg.functionCallExternal?.enabled} url=${cfg.functionCallExternal?.url ?? '-'}`)
