// scripts/_simulate-client-mount.mjs
//
// Simulate the DSH webview's handling of the client bundle:
//
//   1. execute lib/client.js as a CLASSIC script (the webview loads plugin
//      bundles as scripts, not ES modules)
//   2. capture the window.__ModuleLoader__.load({id, factory}) registration
//   3. materialize the factory with a `require` that resolves the platform
//      seed words (react / react/jsx-runtime / react-dom/client)
//   4. mount the materialized plugin against a mock cordis webview context
//      that provides the services the plugin waits for
//      (locale / sidebarRightTabs / slots / remote.agentPresets)
//   5. assert the preset gate in BOTH directions (§7.136):
//
//        standard preset  → NO Edge tab type registered
//        edge preset      → the tab type IS registered, body + title seated
//        back to standard → the tab type is unregistered again
//
// This reproduces the exact contract the host checks:
//   - registration id === package name (client-modules: `factories.has(id)`)
//   - factory returns { name, inject, apply }
//   - the tab body slot is keyed with the tab registry definition's id
//     (sidebar-right dispatches with `entryKey = definition?.id ?? tab.kind`)

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundlePath = process.argv[2] ?? join(root, 'lib', 'client.js')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

let registration = null
const mockWindow = {
  __ModuleLoader__: {
    load(reg) {
      registration = reg
    },
  },
}

// The bundle polls the preset roster, so the sandbox needs a timer. A fake
// one keeps the test deterministic: the poll callback is captured and fired
// by hand instead of waiting for wall-clock time.
const timers = new Map()
let nextTimerId = 1
const fakeSetInterval = (cb, ms) => {
  const id = nextTimerId++
  timers.set(id, { cb, ms })
  return id
}
const fakeClearInterval = (id) => {
  timers.delete(id)
}

console.log(`simulating webview load of: ${bundlePath}`)
const code = readFileSync(bundlePath, 'utf8')
vm.runInNewContext(code, { window: mockWindow, console, setInterval: fakeSetInterval, clearInterval: fakeClearInterval })

if (!registration) {
  console.error('FAIL: the bundle never called window.__ModuleLoader__.load — the webview would report "loaded without registering".')
  process.exit(1)
}
console.log(`  registered id: ${registration.id}`)
if (registration.id !== pkg.name) {
  console.error(`FAIL: registration id ${registration.id} !== package name ${pkg.name}`)
  process.exit(1)
}

// --- materialize ---------------------------------------------------------
const hostRequire = createRequire(join(root, 'package.json'))
const seedRequire = (spec) => {
  // The webview seed words: react / react/jsx-runtime / react-dom/client.
  if (spec === 'react' || spec === 'react/jsx-runtime' || spec === 'react-dom' || spec === 'react-dom/client') {
    return hostRequire(spec)
  }
  throw new Error(`client-modules: seed word "${spec}" is not available in the webview`)
}

const exportsObj = registration.factory(seedRequire)
const name = exportsObj?.name
const inject = exportsObj?.inject
const apply = exportsObj?.apply
console.log(`  name: ${name}`)
console.log(`  inject: ${JSON.stringify(inject ?? [])}`)
console.log(`  apply: ${typeof apply}`)
if (typeof apply !== 'function') {
  console.error('FAIL: factory did not return an apply function')
  process.exit(1)
}

// --- mock webview cordis ctx --------------------------------------------
const registeredTabs = []
const slotEntries = []
const locales = []

// §7.136: the Edge tab exists only while 边缘模式 is the ACTIVE preset.
// The mock lets the script flip the roster and re-read it, so the gate is
// exercised in both directions.
const roster = {
  presets: [
    { id: 'standard', name: '标准模式', isDefault: true },
    { id: 'edge', name: '边缘模式', isDefault: false },
  ],
}
const agentPresets = {
  async list() {
    return { ok: true, value: roster }
  },
}

const tabs = {
  register(def) {
    registeredTabs.push(def)
    return () => {
      const index = registeredTabs.indexOf(def)
      if (index >= 0) registeredTabs.splice(index, 1)
    }
  },
}
const slots = {
  inject(seat, factory) {
    const entry = factory()
    slotEntries.push({ seat, entry })
    return () => {}
  },
  register(descriptor, render) {
    return { ...descriptor, render }
  },
}
const locale = {
  register(ns, dict) {
    locales.push({ ns, dict })
  },
  bind(ns) {
    return (key) => locales.find((l) => l.ns === ns)?.dict?.[key] ?? key
  },
}

const services = {
  locale,
  slots,
  sidebarRightTabs: tabs,
  remote: { agentPresets },
  'remote.agentPresets': agentPresets,
}

/**
 * Build the object an inject callback receives.
 *
 * The client framework hands the callback a CONTEXT-like object whose
 * properties are the injected services (`ctx.locale`, `ctx.slots`,
 * `ctx.remote.agentPresets`); a dotted dependency nests under its path.
 */
const namespaceFor = (wanted) => {
  const ns = {}
  for (const name of wanted) {
    const parts = name.split('.')
    let cursor = ns
    for (let i = 0; i < parts.length - 1; i++) {
      cursor[parts[i]] ??= {}
      cursor = cursor[parts[i]]
    }
    cursor[parts[parts.length - 1]] = services[name]
  }
  return ns
}

const pending = []
function makeCtx(declared) {
  const base = {
    inject(names, cb) {
      const wanted = Array.isArray(names) ? names : [names]
      const missing = wanted.filter((w) => !(w in services))
      if (missing.length > 0) {
        pending.push({ wanted, missing })
        return () => {}
      }
      cb(namespaceFor(wanted))
      return () => {}
    },
    on() {
      return () => {}
    },
    // Cordis semantics: `effect(execute)` runs `execute` immediately and
    // collects the disposer it returns; the disposer runs when the fiber
    // unloads. Running it here would tear the roster watcher down at once.
    effect(cb) {
      const disposer = cb()
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
  }
  return new Proxy(base, {
    get(target, prop) {
      if (typeof prop === 'symbol') return Reflect.get(target, prop)
      if (prop in target) return Reflect.get(target, prop)
      if (prop in services) return services[prop]
      if (declared.includes(prop)) return services[prop]
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
  })
}

const ctx = makeCtx(inject ?? [])
try {
  apply(ctx)
} catch (e) {
  console.error(`FAIL: apply() threw: ${e?.message ?? e}`)
  process.exit(1)
}

// flush any deferred injects the mock queued
for (const p of pending.splice(0)) {
  console.error(`FAIL: the bundle pends on ${p.missing.join(', ')} — the web boot audit THROWS on a pending entry`)
  process.exit(1)
}

/** Let the roster read settle (the bundle awaits `agentPresets.list()`). */
const settle = async () => {
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
}

/** Fire the captured roster poll, exactly as the 5s timer would. */
const poll = async () => {
  for (const timer of [...timers.values()]) timer.cb()
  await settle()
}

// --- assertions ----------------------------------------------------------
let failed = false
const fail = (message) => {
  console.error(`FAIL: ${message}`)
  failed = true
}

const report = (phase) => {
  console.log(`  [${phase}] registered tabs: ${registeredTabs.length}`)
  for (const t of registeredTabs) {
    console.log(`    id=${t.id} kind=${t.kind} title=${typeof t.title === 'function' ? 'fn' : JSON.stringify(t.title)} guide=${(t.guide ?? []).length}`)
  }
}

console.log(`  locale namespaces: ${locales.map((l) => l.ns).join(', ') || '(none)'}`)
console.log(`  slot entries:      ${slotEntries.length}`)

// Phase 1 — 标准模式: no Edge tab type may exist.
await settle()
report('standard')
if (registeredTabs.length !== 0) {
  fail(`the Edge tab type is registered while the active preset is "standard" — the tab must exist only in 边缘模式`)
}

// The body/title seats are registered unconditionally (the sidebar dispatches
// them by key, so an unseated body would break the chip), but they must carry
// the registry id as their key.
const bodySeat = slotEntries.find((s) => s.seat === 'sidebar.right.pane.tab')
const titleSeat = slotEntries.find((s) => s.seat === 'sidebar.right.pane.tab.title')
if (!bodySeat) {
  fail('no body seated at sidebar.right.pane.tab')
} else if (bodySeat.entry?.key !== 'dsh-edge-agent') {
  fail(`slot key "${bodySeat.entry?.key}" !== registry id "dsh-edge-agent" — sidebar-right dispatches with entryKey = definition.id`)
}
if (!titleSeat) {
  fail('no title seated at sidebar.right.pane.tab.title')
} else if (titleSeat.entry?.key !== 'dsh-edge-agent') {
  fail(`title slot key "${titleSeat.entry?.key}" !== registry id "dsh-edge-agent"`)
}

// Phase 2 — 边缘模式: the tab type must appear.
roster.presets[0].isDefault = false
roster.presets[1].isDefault = true
await poll()
report('edge')
if (registeredTabs.length !== 1) {
  fail(`the Edge tab type is NOT registered while 边缘模式 is the active preset (registered=${registeredTabs.length})`)
} else {
  const tab = registeredTabs[0]
  if (tab.id !== 'dsh-edge-agent' || tab.kind !== 'dsh-edge-agent') {
    fail(`the registered tab type is id="${tab.id}" kind="${tab.kind}", expected "dsh-edge-agent"`)
  }
  if ((tab.guide ?? []).length !== 1) {
    fail(`the tab type carries ${(tab.guide ?? []).length} guide entries, expected 1`)
  }
  // The body must render a React element (the host renderer is React).
  const el = bodySeat?.entry?.render?.({ sessionId: 's1' })
  if (!el || typeof el !== 'object' || !('type' in el)) {
    fail('slot render did not return a React element')
  } else {
    console.log(`  body element type: ${typeof el.type === 'string' ? `<${el.type}>` : (el.type?.name ?? 'component')}`)
  }
}

// Phase 3 — back to 标准模式: the tab type must be dropped again.
roster.presets[0].isDefault = true
roster.presets[1].isDefault = false
await poll()
report('standard again')
if (registeredTabs.length !== 0) {
  fail(`the Edge tab type survived the switch back to "standard" (registered=${registeredTabs.length})`)
}

if (failed) process.exit(1)
console.log('client mount simulation PASSED')
