// scripts/verify-env-bridge.mjs
// Gate: the two halves of the §7.102 env contract must name the same
// variables.
//
//   scripts/edge-config-env.mjs   emits  `export K=V` lines for the shell
//                                side (e2e / bench scripts call curl,
//                                python and the dsh CLI directly).
//   src/dsh-adapter/edge-config.ts ENV_OVERRIDES
//                                consumes the same names on the plugin
//                                side (each entry maps one env var onto a
//                                config field).
//
// Why this needs a gate:
//
//   The commit that introduced the bridge described the two lists as
//   "bidirectionally aligned". They were not: 18 names had drifted apart.
//   The damaging direction is "emitted but never consumed" — an operator
//   exports DSH_EDGE_GUARD_MODEL_TIMEOUT_MS, the shell happily exports
//   it, and the plugin ignores it completely. A silent no-op is worse
//   than a missing knob, because the operator believes they configured
//   something.
//
//   The opposite direction ("consumed but never emitted") is less harmful
//   — the file is the source of truth and the plugin reads it directly —
//   but it still means the shell side cannot reach that knob.
//
// Run: node scripts/verify-env-bridge.mjs

import { readFileSync } from 'node:fs'

const bridge = readFileSync('scripts/edge-config-env.mjs', 'utf8')
const config = readFileSync('src/dsh-adapter/edge-config.ts', 'utf8')

// Names the shell side may emit for its own consumers only. A bare
// provider key (e.g. DEEPSEEK_API_KEY) is handed to curl / python by the
// e2e scripts, not to a plugin field.
const SHELL_ONLY = new Set([
  'DEEPSEEK_API_KEY',
  'DASHSCOPE_API_KEY',
  'TAVILY_API_KEY',
  'BOCHA_API_KEY',
])

const emitted = new Set()
for (const m of bridge.matchAll(/push(?:Csv)?\('([A-Z0-9_]+)'/g)) emitted.add(m[1])

const consumed = new Set()
const block = config.slice(
  config.indexOf('const ENV_OVERRIDES'),
  config.indexOf('/** A fresh deep copy'),
)
for (const m of block.matchAll(/env:\s*'([A-Z0-9_]+)'/g)) consumed.add(m[1])

const emittedOnly = [...emitted].filter((n) => !consumed.has(n) && !SHELL_ONLY.has(n)).sort()
const consumedOnly = [...consumed].filter((n) => !emitted.has(n)).sort()

console.log(`env-bridge: ${emitted.size} emitted, ${consumed.size} consumed, `
  + `${SHELL_ONLY.size} shell-only`)

if (emittedOnly.length === 0 && consumedOnly.length === 0) {
  console.log('env-bridge OK (both halves name the same variables)')
  process.exit(0)
}

if (emittedOnly.length > 0) {
  console.log(`\n✗ exported by the bridge but consumed by no plugin (silent no-ops):`)
  for (const n of emittedOnly) console.log(`    ${n}`)
}
if (consumedOnly.length > 0) {
  console.log(`\n✗ consumed by a plugin but never exported (unreachable from the shell):`)
  for (const n of consumedOnly) console.log(`    ${n}`)
}
console.log('')
console.log('Fix: add the missing name to both halves —')
console.log('  scripts/edge-config-env.mjs  → push(\'NAME\', <config path>)')
console.log('  src/dsh-adapter/edge-config.ts → { env: \'NAME\', apply: (cfg, v) => … }')
process.exit(1)
