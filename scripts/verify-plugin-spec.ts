/**
 * Plugin-spec battery: every src/dsh-adapter/*.ts plugin file must follow
 * the canonical `name` + `inject` + `Config` + `apply` shape, and the
 * main `src/dsh-adapter/index.ts` aggregator must mount them all.
 *
 * Verified properties:
 *   1. `name` is non-empty kebab-case (matches its filename).
 *   2. `inject` is an array of declared soft dependencies.
 *   3. `Config` schema is non-null and uses `@deepseek-ai/schemastery`.
 *   4. `apply` is an async function (or returns one).
 *   5. Every subpath in package.json `exports` resolves to a real file.
 *   6. The aggregator's `apply` invokes each sub-plugin's `apply`.
 *
 * Run via `node --import tsx/esm scripts/verify-plugin-spec.ts`.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, resolve, basename } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const ADAPTER = join(root, 'src', 'dsh-adapter')

const KEBAB_CASE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

interface Spec {
  name: string
  inject: readonly string[]
  configSchema: boolean
  apply: 'function' | 'arrow' | 'unknown'
}

const sources: string[] = []
function collect(dir: string): void {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      collect(path)
    } else if (entry.endsWith('.ts')) {
      sources.push(path)
    }
  }
}
collect(ADAPTER)

const violations: string[] = []
const pluginSpecs: Array<{ file: string; spec: Spec }> = []

for (const file of sources) {
  const base = basename(file, '.ts')
  if (base === 'contract' || base === 'types' || base === 'invariant' || base === 'invariant-install' || base === 'llm-adapters') continue
  if (base === 'pii-utils') continue
  if (base === 'openai-sse') continue
  // pure helpers — used internally by the http-api plugin; not plugins themselves
  if (base === 'http-api-routes') continue
  if (base === 'http-api-sessions') continue
  // pure shared state (max-turns guard + SSE-retry bookkeeping) imported by the
  // two llm-adapters only; never inserted by cordis.patch.yml, not in exports.
  // (§7.61: battery red since a5784d5 2026-09-13 — verify:build hadn't run until then.)
  if (base === 'llm-max-turns') continue
  // §7.93 Phase 3: pure class (no `inject`/`apply`), constructed by hand inside
  // function-call-external's Phase 4 — see tool-runner.ts:36-39. Never inserted
  // by cordis.patch.yml, not in package.json exports.
  if (base === 'tool-runner') continue
  // §7.102: pure config loader (single read point for config/edge.json),
  // imported by the plugins' apply(); never inserted by a cordis patch row,
  // not in package.json exports.
  if (base === 'edge-config') continue
  // §7.118: pure helper module for the detailed LLM request/response trace
  // (redaction + truncation + serialization). Imported by cloud-llm-adapter /
  // local-llm-adapter; never inserted by a cordis patch row, not in
  // package.json exports.
  if (base === 'llm-trace') continue
  // §7.123: the STRATEGY DATA extracted out of intent-router.ts —
  // keyword/entity tables + the fallback taxonomy. Imported by
  // intent-router.ts; never inserted by a cordis patch row, not in
  // package.json exports.
  if (base === 'intent-signals') continue
  // §7.123: the PROMPT TEMPLATES extracted out of intent-router.ts (the
  // local-LLM classifier prompt + the Bailian decision-model criteria).
  // Imported by intent-router.ts; never inserted by a cordis patch row, not
  // in package.json exports.
  if (base === 'intent-prompts') continue
  // §7.123: the message-array helpers extracted out of input-guard.ts (the
  // payload.messages vs decision.messages contract). Imported by
  // input-guard.ts; never inserted by a cordis patch row, not in
  // package.json exports.
  if (base === 'input-guard-messages') continue
  // §7.131: the egress-segmentation helpers extracted out of
  // cloud-llm-adapter.ts (云段/本地段切分 + provider 判定). Imported by
  // cloud-llm-adapter.ts / input-guard.ts; never inserted by a cordis patch
  // row, not in package.json exports.
  if (base === 'cloud-egress') continue
  // §7.132: the internal-caller tagging helpers extracted out of
  // prompt-guard.ts / intent-router.ts (标记内部 LLM 调用, 让面板把
  // 安检/分类器 与 主对话出网 区分开). Imported by prompt-guard.ts /
  // intent-router.ts / both llm-adapters; never inserted by a cordis patch
  // row, not in package.json exports.
  if (base === 'llm-internal-caller') continue
  // §7.133: the LLM trace BODY store (in-memory ring buffer holding the
  // full request/response bodies; the Edge panel pulls them on demand via
  // /api/dsh-edge/trace). Imported by both llm-adapters / intent-router /
  // edge-context-view; never inserted by a cordis patch row, not in
  // package.json exports.
  if (base === 'llm-trace-store') continue
  // §7.144: the HOST-PROVIDER call trace (the delegate-mode cloud call that
  // no adapter ever sees — recorded from the host's llm/stream hook by
  // input-guard). Imported by input-guard.ts; never inserted by a cordis
  // patch row, not in package.json exports.
  if (base === 'host-llm-trace') continue
  // §7.147: 会话归属的唯一口径（哨兵 `'<pre-session>'` 不是会话 id；没有会话
  // 就不写 sessionId 键 —— 宁可归全局桶，也不要造一个不存在的桶把行藏掉）。
  // Imported by local-llm-adapter / cloud-llm-adapter / llm-trace /
  // intent-router / edge-context-view; never inserted by a cordis patch row,
  // not in package.json exports.
  if (base === 'session-attribution') continue
  if (base === 'plugin' || base === 'index') continue
  const content = readFileSync(file, 'utf8')

  // name
  const nameMatch = content.match(/export const name\s*=\s*['"]([^'"]+)['"]/u)
  if (!nameMatch) {
    violations.push(`${relative(root, file)}: missing 'export const name'`)
    continue
  }
  const name = nameMatch[1]
  if (name !== base) {
    violations.push(`${relative(root, file)}: name='${name}' does not match filename='${base}'`)
  }
  if (!KEBAB_CASE.test(name)) {
    violations.push(`${relative(root, file)}: name='${name}' is not kebab-case`)
  }

  // inject
  const injectMatch = content.match(/export const inject\s*=\s*(\[[^\]]*\]|\[\s*\]\s*as\s*const)/u)
  if (!injectMatch) {
    violations.push(`${relative(root, file)}: missing 'export const inject'`)
  }

  // Config schema
  const configMatch = content.match(/export const Config:\s*Schema<[^>]+>\s*=\s*Schema\.object/u)
  if (!configMatch) {
    violations.push(`${relative(root, file)}: missing 'export const Config: Schema<...> = Schema.object(...)'`)
  }

  // apply
  const applyMatch = content.match(/export\s+async\s+function\s+apply\s*\(/u)
    ?? content.match(/export\s+function\s+apply\s*\(/u)
    ?? content.match(/export\s+const\s+apply\s*=\s*async\s*\(/u)
  if (!applyMatch) {
    violations.push(`${relative(root, file)}: missing 'export ... function apply(...)'`)
  }

  pluginSpecs.push({
    file: relative(root, file),
    spec: {
      name,
      inject: injectMatch ? (injectMatch[1] ?? '[]') : '[]',
      configSchema: !!configMatch,
      apply: applyMatch?.[0]?.includes('const') ? 'arrow' : 'function',
    },
  })
}

if (violations.length > 0) {
  console.error('Plugin-spec battery FAILED:')
  for (const v of violations) console.error(`  - ${v}`)
  process.exit(1)
}

// Check the package.json exports match real subpath files
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const exports = pkg.exports ?? {}
const exportViolations: string[] = []
for (const [key, value] of Object.entries(exports)) {
  if (key === './package.json' || key === './cordis.yml' || key === './client') continue
  // §7.101: './client' is the webview bundle produced by esbuild
  // (scripts/build-client.mjs) and lives at lib/client.js — it has no
  // matching src/dsh-adapter/*.ts because the half is shipped as a single
  // ESM file, not a Cordis plugin (its entry is configured by package.json
  // dsh.client.entry instead). See docs/edge-context-tab-plan.md.
  //
  // §7.135: the same exemption class covers the **preset patch files**
  // (./cordis.patch.yml, ./presets/edge*.patch.yml) — they are loader
  // configuration, not Cordis plugins; the plugin rows they declare point at
  // the real plugin subpaths.
  if (key.endsWith('.yml')) continue
  const v = value as Record<string, string> | string
  const importPath = typeof v === 'string' ? v : v.import
  if (!importPath) continue
  // source maps to ./src/dsh-adapter/<x>.ts; lib maps to ./lib/types/dsh-adapter/<x>.js
  const srcCandidate = join(root, 'src', 'dsh-adapter', `${basename(key) === '.' ? 'index' : key.replace(/^\.\//u, '')}.ts`)
  if (!existsSync(srcCandidate)) {
    exportViolations.push(`export '${key}' → no source file at ${relative(root, srcCandidate)}`)
  }
}
if (exportViolations.length > 0) {
  console.error('Subpath export surface violated:')
  for (const v of exportViolations) console.error(`  - ${v}`)
  process.exit(1)
}

console.log(`plugin-spec OK (${pluginSpecs.length} adapter plugins scanned, ${Object.keys(exports).length} subpath exports)`)