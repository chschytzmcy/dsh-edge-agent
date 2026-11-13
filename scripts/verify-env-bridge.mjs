#!/usr/bin/env node
// scripts/verify-env-bridge.mjs
// Gate: the two halves of the §7.102 env contract must name the same
// variables — AND each name must mean exactly ONE config field.
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
// §7.223 (2026-11-14) — the second family of defects this gate now covers:
//
//   The original gate compared the two name lists as **sets**. A set cannot
//   see multiplicity, so it was blind to the defect it should have caught:
//   `DSH_EDGE_STORAGE_ROOT` was pushed TWICE by the bridge — once from
//   `tee.storageRoot` and once from `storage.root` — and the second push
//   silently overwrote the first. `tee.storageRoot` could therefore never
//   reach the shell side, and the same name additionally meant "the storage
//   base directory" in `cordis.yml`. One name, four meanings, zero warnings.
//
//   ⇒ New invariants (checks 2-4 below):
//     2. the bridge must not emit one name from two different config paths;
//     3. ENV_OVERRIDES must not map one name onto two different config paths;
//     4. where a name exists in BOTH halves, both must point at the SAME
//        field — compared by the field's leaf name (`storage.root` and
//        `cfg.storage!.root` are the same field; `tee.storageRoot` is not).
//
// Run: node scripts/verify-env-bridge.mjs
//      node scripts/verify-env-bridge.mjs --selftest

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BRIDGE_REL = 'scripts/edge-config-env.mjs'
const CONFIG_REL = 'src/dsh-adapter/edge-config.ts'

// Names the shell side may emit for its own consumers only. A bare
// provider key (e.g. DEEPSEEK_API_KEY) is handed to curl / python by the
// e2e scripts, not to a plugin field.
const SHELL_ONLY = new Set([
  'DEEPSEEK_API_KEY',
  'DASHSCOPE_API_KEY',
  'TAVILY_API_KEY',
  'BOCHA_API_KEY',
])

/**
 * Parse the bridge: every `push('NAME', <expr>)` / `pushCsv('NAME', <expr>)`.
 *
 * @param {string} text
 * @returns {Map<string, Array<{ expr: string, line: number }>>}
 */
export function parseBridge(text) {
  const out = new Map()
  text.split(/\r?\n/u).forEach((line, i) => {
    const re = /push(?:Csv)?\('([A-Z0-9_]+)',\s*([A-Za-z0-9_.\[\]]+)\)/gu
    let m
    while ((m = re.exec(line)) !== null) {
      if (!out.has(m[1])) out.set(m[1], [])
      out.get(m[1]).push({ expr: m[2], line: i + 1 })
    }
  })
  return out
}

/**
 * Parse the plugin half: every `env: 'NAME'` → the config path its
 * `apply` writes to (`cfg.storage!.root` ⇒ `storage.root`).
 *
 * @param {string} text
 * @returns {Map<string, Array<{ path: string, line: number }>>}
 */
export function parseOverrides(text) {
  const out = new Map()
  const start = text.indexOf('const ENV_OVERRIDES')
  const end = text.indexOf('/** A fresh deep copy')
  if (start < 0 || end < 0) return out
  const block = text.slice(start, end)
  const re = /env:\s*'([A-Z0-9_]+)'[\s\S]{0,120}?apply:\s*\(cfg,\s*v\)\s*=>\s*\{\s*cfg\.([A-Za-z0-9_.\[\]!]+)\s*=/gu
  let m
  while ((m = re.exec(block)) !== null) {
    const path = m[2].replace(/!/gu, '').replace(/\[[^\]]*\]/gu, '')
    const line = block.slice(0, m.index).split(/\r?\n/u).length
    if (!out.has(m[1])) out.set(m[1], [])
    out.get(m[1]).push({ path, line })
  }
  return out
}

/** The leaf (last dotted segment) of a config path. */
export function leafOf(path) {
  const parts = path.split('.').filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/**
 * Run every invariant. Pure — takes both texts, returns a list of failures.
 *
 * @param {string} bridgeText
 * @param {string} configText
 * @returns {string[]}
 */
export function audit(bridgeText, configText) {
  const failures = []
  const emitted = parseBridge(bridgeText)
  const consumed = parseOverrides(configText)

  const emittedOnly = [...emitted.keys()].filter((n) => !consumed.has(n) && !SHELL_ONLY.has(n)).sort()
  const consumedOnly = [...consumed.keys()].filter((n) => !emitted.has(n)).sort()

  for (const n of emittedOnly) failures.push(`emitted by the bridge but consumed by no plugin (silent no-op): ${n}`)
  for (const n of consumedOnly) failures.push(`consumed by a plugin but never emitted (unreachable from the shell): ${n}`)

  // §7.223 check 2 — one name must not be emitted from two config paths.
  for (const [name, entries] of emitted) {
    const exprs = [...new Set(entries.map((e) => e.expr))]
    if (exprs.length > 1) {
      failures.push(
        `one env name emitted from ${exprs.length} different config paths: ${name}`
        + ` ← ${exprs.join(' / ')} (the later push silently overwrites the earlier one)`
        + ` [${BRIDGE_REL}:${entries.map((e) => e.line).join(',')}]`,
      )
    }
  }

  // §7.223 check 3 — one name must not be mapped onto two config paths.
  for (const [name, entries] of consumed) {
    const paths = [...new Set(entries.map((e) => e.path))]
    if (paths.length > 1) {
      failures.push(
        `one env name mapped onto ${paths.length} different config paths: ${name}`
        + ` ← ${paths.join(' / ')} [${CONFIG_REL}]`,
      )
    }
  }

  // §7.223 check 4 — the two halves must agree on WHICH field they mean.
  for (const [name, eEntries] of emitted) {
    const cEntries = consumed.get(name)
    if (!cEntries) continue
    for (const e of eEntries) {
      for (const c of cEntries) {
        if (leafOf(e.expr) !== leafOf(c.path)) {
          failures.push(
            `the two halves disagree on what ${name} means:`
            + ` bridge pushes ${e.expr} [${BRIDGE_REL}:${e.line}]`
            + ` but the plugin maps it to ${c.path} [${CONFIG_REL}:${c.line}]`,
          )
        }
      }
    }
  }

  return failures
}

/* ── self-proof + refutation ───────────────────────────────────────────── */

function selftest() {
  let failures = 0
  const check = (name, cond, detail) => {
    if (!cond) failures++
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ` — ${detail}`}`)
  }

  const GOOD_BRIDGE = [
    "push('DSH_EDGE_STORAGE_ROOT', storage.root)",
    "push('DSH_EDGE_TEE_STORAGE_ROOT', tee.storageRoot)",
    "push('DSH_EDGE_LOCAL_LLM_BASEURL', local.baseUrl)",
    "push('DEEPSEEK_API_KEY', s.deepseekApiKey)",
  ].join('\n')
  const GOOD_CONFIG = [
    "const ENV_OVERRIDES = [",
    "  { env: 'DSH_EDGE_STORAGE_ROOT', apply: (cfg, v) => { cfg.storage!.root = v } },",
    "  { env: 'DSH_EDGE_TEE_STORAGE_ROOT', apply: (cfg, v) => { cfg.tee!.storageRoot = v } },",
    "  {",
    "    env: 'DSH_EDGE_LOCAL_LLM_BASEURL',",
    "    apply: (cfg, v) => { cfg.llm!.local!.baseUrl = v },",
    "  },",
    "]",
    "/** A fresh deep copy */",
  ].join('\n')

  console.log('verify-env-bridge --selftest')

  // 1. the current shape passes.
  check('clean tree ⇒ no failures', audit(GOOD_BRIDGE, GOOD_CONFIG).length === 0,
    JSON.stringify(audit(GOOD_BRIDGE, GOOD_CONFIG)))

  // 2. the §7.223 defect itself: one name emitted from two paths.
  {
    const f = audit(GOOD_BRIDGE + "\npush('DSH_EDGE_STORAGE_ROOT', tee.storageRoot)", GOOD_CONFIG)
    check('one name emitted from two paths is caught',
      f.some((x) => x.includes('emitted from 2 different config paths')), JSON.stringify(f))
  }

  // 3. one name mapped onto two paths on the plugin side.
  {
    const f = audit(GOOD_BRIDGE, GOOD_CONFIG.replace(
      "  { env: 'DSH_EDGE_STORAGE_ROOT', apply: (cfg, v) => { cfg.storage!.root = v } },",
      "  { env: 'DSH_EDGE_STORAGE_ROOT', apply: (cfg, v) => { cfg.storage!.root = v } },\n"
      + "  { env: 'DSH_EDGE_STORAGE_ROOT', apply: (cfg, v) => { cfg.tee!.storageRoot = v } },"))
    check('one name mapped onto two paths is caught',
      f.some((x) => x.includes('mapped onto 2 different config paths')), JSON.stringify(f))
  }

  // 4. the two halves pointing at different fields.
  {
    const f = audit(
      GOOD_BRIDGE.replace("push('DSH_EDGE_STORAGE_ROOT', storage.root)", "push('DSH_EDGE_STORAGE_ROOT', tee.storageRoot)"),
      GOOD_CONFIG)
    check('halves disagreeing on the field is caught',
      f.some((x) => x.includes('disagree on what')), JSON.stringify(f))
  }

  // 5. the original two invariants still hold.
  {
    const f = audit(GOOD_BRIDGE + "\npush('DSH_EDGE_GUARD_MODEL_TIMEOUT_MS', guard.timeoutMs)", GOOD_CONFIG)
    check('emitted-but-not-consumed is caught',
      f.some((x) => x.includes('consumed by no plugin')), JSON.stringify(f))
  }
  {
    const f = audit(
      GOOD_BRIDGE.replace("push('DSH_EDGE_STORAGE_ROOT', storage.root)\n", ''),
      GOOD_CONFIG)
    check('consumed-but-not-emitted is caught',
      f.some((x) => x.includes('never emitted')), JSON.stringify(f))
  }

  // 6. a shell-only name (bare provider key) is NOT a violation.
  {
    const f = audit(GOOD_BRIDGE, GOOD_CONFIG)
    check('shell-only provider key is not flagged',
      !f.some((x) => x.includes('DEEPSEEK_API_KEY')), JSON.stringify(f))
  }

  if (failures > 0) {
    console.error(`\nselftest FAILED: ${failures} assertion(s)`)
    process.exit(2)
  }
  console.log('\nselftest OK — 门禁能抓住「一个 env 名字对应两个配置字段」'
    + '（桥侧同名两次推、插件侧同名映射两次、两半指向不同字段），'
    + '也能守住原来的「两半名字对齐」两条')
}

/* ── entry ─────────────────────────────────────────────────────────────── */

// Only run the gate when this file IS the entry point. Importing it (e.g. from
// a probe that re-runs `audit()` against an older tree) must define the
// functions without executing the gate.
const isEntry = Boolean(process.argv[1])
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (!isEntry) {
  // imported — nothing to do
} else if (process.argv.includes('--selftest')) {
  selftest()
} else {
  const bridgeText = readFileSync(join(ROOT, BRIDGE_REL), 'utf8')
  const configText = readFileSync(join(ROOT, CONFIG_REL), 'utf8')
  const failures = audit(bridgeText, configText)
  const emitted = parseBridge(bridgeText)
  const consumed = parseOverrides(configText)
  console.log(`env-bridge: ${emitted.size} emitted, ${consumed.size} consumed, `
    + `${SHELL_ONLY.size} shell-only`)
  if (failures.length === 0) {
    console.log('env-bridge OK (both halves name the same variables; '
      + 'each name maps to exactly one config field)')
    process.exit(0)
  }
  console.error(`\n✗ env-bridge contract violated (${failures.length}):`)
  for (const f of failures) console.error(`    ${f}`)
  console.error('')
  console.error('Fix: one env name must mean exactly ONE config field —')
  console.error("  scripts/edge-config-env.mjs  → push('NAME', <one config path>)")
  console.error("  src/dsh-adapter/edge-config.ts → { env: 'NAME', apply: (cfg, v) => { cfg.<same field> = v } }")
  process.exit(1)
}
