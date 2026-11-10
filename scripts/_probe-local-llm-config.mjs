// scripts/_probe-local-llm-config.mjs
// Which file does the DEPLOYED bundle actually read its local-LLM config
// from? Imports the loader out of the nested desktop install and prints
// the candidate list, the file that won, and the resolved local pool.
//
// Usage: node scripts/_probe-local-llm-config.mjs [<bundle-root>]

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const bundleRoot = resolve(process.argv[2] ?? join(
  process.env.USERPROFILE ?? process.env.HOME ?? '',
  '.dsh', 'profiles', 'desktop', 'node_modules',
  '@dsh-edge', 'dsh-edge-agent',
))

const loaderUrl = pathToFileURL(join(bundleRoot, 'lib', 'dsh-adapter', 'edge-config.js')).href
console.log(`bundle root : ${bundleRoot}`)
console.log(`cwd         : ${process.cwd()}`)
console.log(`loader      : ${loaderUrl}\n`)

const mod = await import(loaderUrl)

console.log('--- candidates (priority order) ---')
for (const c of mod.edgeConfigCandidates()) {
  console.log(`  [${existsSync(c) ? 'HIT ' : 'miss'}] ${c}`)
}

console.log('\n--- load ---')
let cfg
try {
  cfg = mod.loadEdgeConfig(true)
  console.log('  loadEdgeConfig(true) OK')
} catch (err) {
  console.log(`  loadEdgeConfig threw: ${err?.message ?? err}`)
  console.log(String(err?.stack ?? '').split('\n').slice(0, 8).join('\n'))
  cfg = mod.loadEdgeConfig()
  console.log('  fallback loadEdgeConfig() OK')
}

console.log('\n--- winner ---')
console.log(`  ${mod.edgeConfigPath() ?? '(none — built-in defaults)'}`)

console.log('\n--- resolved llm.local ---')
const local = cfg.llm?.local ?? {}
const secret = local.keyRef ? cfg.secrets?.[local.keyRef] : undefined
console.log(`  baseUrl   : ${local.baseUrl ?? '(unset)'}`)
console.log(`  model     : ${local.model ?? '(unset)'}`)
console.log(`  keyRef    : ${local.keyRef ?? '(unset)'}`)
console.log(`  apiKey    : ${secret ? `${secret.slice(0, 4)}…(${secret.length} chars)` : '(unset)'}`)

console.log('\n--- localPool() (what the adapter actually uses) ---')
const pool = mod.localPool(cfg)
console.log(`  baseUrl : ${pool.baseUrl ?? '(unset) → route NOT registered'}`)
console.log(`  model   : ${pool.model ?? '(unset)'}`)
console.log(`  apiKey  : ${pool.apiKey ? `${pool.apiKey.slice(0, 4)}…(${pool.apiKey.length} chars)` : '(unset)'}`)
