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
//   6. assert the §7.139 auto-open contract:
//
//        standard preset  → the Edge tab is NOT opened, even with a session
//                            on screen
//        edge preset      → the Edge tab IS opened for the session on screen
//        same session     → opened once only (a poll must not re-open it)
//        another session  → opened for that session too
//        back to standard → the Edge tab is CLOSED again (标准模式 = 纯宿主)
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

// §7.139: the auto-open ladder uses setTimeout (the session's store is
// minted in the render that follows the on-screen change). The fake timer
// keeps the ladder deterministic — it is fired by hand, in delay order.
const timeouts = new Map()
let nextTimeoutId = 1
const fakeSetTimeout = (cb, ms) => {
  const id = nextTimeoutId++
  timeouts.set(id, { cb, ms })
  return id
}
const fakeClearTimeout = (id) => {
  timeouts.delete(id)
}

console.log(`simulating webview load of: ${bundlePath}`)
const code = readFileSync(bundlePath, 'utf8')
vm.runInNewContext(code, {
  window: mockWindow,
  console,
  setInterval: fakeSetInterval,
  clearInterval: fakeClearInterval,
  setTimeout: fakeSetTimeout,
  clearTimeout: fakeClearTimeout,
})

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
  /** How often the roster was actually READ — §7.139: the watcher must reach
   *  the roster, not merely register a tab type it guessed about. */
  reads: 0,
  async list() {
    agentPresets.reads += 1
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

// §7.139: the host's right-sidebar controller, mocked to the contract the
// bundle uses (dsh-client-ui-sidebar-right/src/client/service.ts):
//   - `mounted` publishes the session on screen
//   - `openTab(kind)` acts on THAT session, and throws without one
//   - `tabsIn(sessionId)` lists one session's committed tabs
//   - `close(tabId)` / `closeIn(sessionId, tabId)` remove a tab
const sidebar = {
  onScreen: undefined,
  listeners: new Set(),
  tabs: new Map(),
  opened: [],
  closed: [],
  show(sessionId) {
    sidebar.onScreen = sessionId
    for (const listener of [...sidebar.listeners]) listener()
  },
}
const sidebarRight = {
  mounted: {
    getSnapshot: () => sidebar.onScreen,
    subscribe(listener) {
      sidebar.listeners.add(listener)
      return () => {
        sidebar.listeners.delete(listener)
      }
    },
  },
  openTab(kind) {
    sidebar.opened.push({ kind, sessionId: sidebar.onScreen })
    if (sidebar.onScreen === undefined) throw new Error('sidebarRight: no session surface is mounted')
    const tabs = sidebar.tabs.get(sidebar.onScreen) ?? []
    if (!tabs.some((t) => t.kind === kind)) tabs.push({ id: `tab-${kind}-${sidebar.onScreen}`, kind })
    sidebar.tabs.set(sidebar.onScreen, tabs)
  },
  tabsIn(sessionId) {
    return sidebar.tabs.get(sessionId) ?? []
  },
  close(tabId) {
    sidebar.closed.push(tabId)
    for (const tabs of sidebar.tabs.values()) {
      const index = tabs.findIndex((t) => t.id === tabId)
      if (index >= 0) {
        tabs.splice(index, 1)
        return
      }
    }
  },
  closeIn(sessionId, tabId) {
    sidebar.closed.push(tabId)
    const tabs = sidebar.tabs.get(sessionId) ?? []
    const index = tabs.findIndex((t) => t.id === tabId)
    if (index >= 0) tabs.splice(index, 1)
  },
}

const services = {
  locale,
  slots,
  sidebarRight,
  sidebarRightTabs: tabs,
  remote: { agentPresets },
  'remote.agentPresets': agentPresets,
}

// A session is on screen from the start: the auto-open must key off it.
sidebar.onScreen = 's1'

/**
 * Build the object an inject callback receives.
 *
 * The client framework hands the callback a CONTEXT-like object whose
 * properties are the injected services (`ctx.locale`, `ctx.slots`,
 * `ctx.remote.agentPresets`); a dotted dependency nests under its path.
 *
 * CORDIS SEMANTICS (§7.139): that object is a context PROXY — reading a name
 * the scope does not carry THROWS "cannot get property … without inject"
 * (@deepseek-ai/cordis lib/index.js:676). The mock reproduces the throw,
 * because a plain object let §7.136's scope-blind face probe
 * (`scope.list` / `scope.agentPresets`) slip through and kill the roster
 * watcher at runtime — the Edge tab then never registered, in any work mode.
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
  return new Proxy(ns, {
    get(target, prop) {
      if (typeof prop === 'symbol') return Reflect.get(target, prop)
      if (prop in target) return Reflect.get(target, prop)
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
  })
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
    // Cordis semantics: `ctx.get(name)` reads a service by name and answers
    // `undefined` when it is not registered (dsh-client-web's context proxy
    // — `ctx.get('sidebarRightTabs')?.get('browser')` in the host's own
    // chat plugin).
    get(name) {
      return services[name]
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

/** Fire the pending auto-open timers, in delay order, until none remain.
 *  The ladder re-arms itself after a failed attempt, so this loops. */
const flushTimers = async () => {
  for (let round = 0; round < 12; round++) {
    if (timeouts.size === 0) break
    const pending = [...timeouts.entries()].sort((a, b) => a[1].ms - b[1].ms)
    timeouts.clear()
    for (const [, timer] of pending) timer.cb()
    await settle()
  }
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
  console.log(`    auto-opens: ${sidebar.opened.length} (${sidebar.opened.map((o) => `${o.kind}@${o.sessionId}`).join(', ') || 'none'})  closed: ${sidebar.closed.length}`)
}

console.log(`  locale namespaces: ${locales.map((l) => l.ns).join(', ') || '(none)'}`)
console.log(`  slot entries:      ${slotEntries.length}`)

// Phase 1 — 标准模式: no Edge tab type may exist, and the tab must not open
// itself: 标准模式 is a pure host (主人裁决 2026-10-28).
await settle()
await flushTimers()
report('standard')
if (registeredTabs.length !== 0) {
  fail(`the Edge tab type is registered while the active preset is "standard" — the tab must exist only in 边缘模式`)
}
if (sidebar.opened.length !== 0) {
  fail(`the Edge tab opened itself while the active preset is "standard" (opened=${JSON.stringify(sidebar.opened)}) — 标准模式 must stay a pure host`)
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
await flushTimers()
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

// §7.139 — the auto-open contract, asserted in both directions.
//
// The Edge tab opens itself in 边缘模式 (the host never opens a tab on its
// own — the guide page is the default), once per session, and it is closed
// again when the master leaves 边缘模式 (标准模式 = 纯宿主, no dead chip).
const openedIn = (sessionId) => sidebar.opened.filter((o) => o.sessionId === sessionId && o.kind === 'dsh-edge-agent')

// Phase 3 — 边缘模式 opens the Edge tab in the session on screen.
if (agentPresets.reads < 1) {
  fail(`the roster was never read (reads=${agentPresets.reads}) — the roster watcher must reach \`agentPresets.list()\`, or the tab type is registered on a guess`)
}
if (openedIn('s1').length !== 1) {
  fail(`expected exactly ONE auto-open of the Edge tab in session s1, got ${openedIn('s1').length} (all opens: ${JSON.stringify(sidebar.opened)})`)
}
if (!sidebarRight.tabsIn('s1').some((t) => t.kind === 'dsh-edge-agent')) {
  fail('the Edge tab is not among the session tabs after the auto-open')
}

// A further poll must not open it again — one open per session.
await poll()
await flushTimers()
if (openedIn('s1').length !== 1) {
  fail(`the Edge tab was opened ${openedIn('s1').length} times in session s1 — one open per session, and never re-opened after the user closes it`)
}

// Another session on screen gets its own Edge tab.
sidebar.show('s2')
await flushTimers()
if (openedIn('s2').length !== 1) {
  fail(`expected exactly ONE auto-open of the Edge tab in session s2, got ${openedIn('s2').length}`)
}

// Phase 4 — back to 标准模式: the tab type must be dropped again, and the
// Edge tab we opened must be closed with it.
roster.presets[0].isDefault = true
roster.presets[1].isDefault = false
await poll()
await flushTimers()
report('standard again')
if (registeredTabs.length !== 0) {
  fail(`the Edge tab type survived the switch back to "standard" (registered=${registeredTabs.length})`)
}
if (sidebarRight.tabsIn('s2').some((t) => t.kind === 'dsh-edge-agent')) {
  fail('the Edge tab survived the switch back to "standard" — 标准模式 must not keep our tab')
}
if (sidebar.closed.length === 0) {
  fail('the Edge tab was not closed when the master left 边缘模式')
}

if (failed) process.exit(1)
console.log('client mount simulation PASSED')
