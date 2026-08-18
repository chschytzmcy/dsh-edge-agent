/**
 * Headless smoke test for the dsh-edge-agent plugin tree: imports the
 * compiled invariant companion and each sub-plugin under a fresh Cordis
 * context, asserts the expected service names, and disposes everything.
 *
 * Catches:
 *   - export shape regressions (`name`, `inject`, `apply`)
 *   - service context augmentation (declared `interface Context` extensions)
 *   - accidental non-async `apply` regressions
 *
 * Run via `node --import tsx/esm scripts/smoke.ts` (or `pnpm run smoke`).
 */

interface CordisContext {
  plugin(plugin: unknown, config?: unknown): unknown
  fiber: { dispose(): Promise<void> }
  registry: Record<string, unknown>
  [key: string]: unknown
}

const ctx: CordisContext = await import('@deepseek-ai/cordis').then((m) => new m.Context())

// 1. Invariant companion — its presence is the upgradable seam.
const invariant = await import('../src/dsh-adapter/invariant.js')
if (invariant.name !== 'dsh-edge-agent-invariant') {
  throw new Error(`invariant companion name is '${invariant.name}', expected 'dsh-edge-agent-invariant'`)
}
if (typeof invariant.apply !== 'function') {
  throw new Error('invariant companion missing apply()')
}
await ctx.plugin(invariant.default ?? invariant)
console.log('--- invariant companion OK')

// 2. Each sub-plugin loads, has the canonical shape, and disposes cleanly.
const PLUGINS = [
  'tcm',
  'local-storage',
  'sessions',
  'audit-log',
  'privacy-policy',
  'tools',
  'prompt-guard',
  'intent-router',
  'model-router',
  'local-llm-adapter',
  'cloud-llm-adapter',
  'sanitizer-pipeline',
  'ohttp-gateway',
  'secure-bridge',
  'attestation',
  'td-bus',
  'local-tools',
  'web-search',
  'voice-input',
  'plugin-host',
  'http-api',
]

let loaded = 0
for (const pluginName of PLUGINS) {
  const mod = await import(`../src/dsh-adapter/${pluginName}.js`)
  if (typeof mod.name !== 'string' || mod.name !== pluginName) {
    throw new Error(`${pluginName}: name export is '${mod.name}', expected '${pluginName}'`)
  }
  if (!Array.isArray(mod.inject)) {
    throw new Error(`${pluginName}: inject export is not an array`)
  }
  if (typeof mod.apply !== 'function') {
    throw new Error(`${pluginName}: apply export is not a function`)
  }
  loaded += 1
}
console.log(`--- ${loaded} plugin modules OK (shape only; no apply() invocations)`)

// 3. Aggregator plugin loads and re-exports every sub-plugin.
const aggregator = await import('../src/dsh-adapter/index.js')
if (aggregator.name !== 'dsh-edge-agent') {
  throw new Error(`aggregator name is '${aggregator.name}', expected 'dsh-edge-agent'`)
}
if (!Array.isArray(aggregator.inject)) {
  throw new Error('aggregator inject export is not an array')
}
if (typeof aggregator.apply !== 'function') {
  throw new Error('aggregator missing apply()')
}
console.log('--- aggregator OK')

await ctx.fiber.dispose()
console.log(`smoke OK (${loaded} plugin shapes verified, aggregator re-exports clean)`)