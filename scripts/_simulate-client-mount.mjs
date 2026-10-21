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
//      that provides the three services the plugin waits for
//      (locale / sidebarRightTabs / slots)
//   5. assert the tab registration and the keyed slot entry both landed
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

console.log(`simulating webview load of: ${bundlePath}`)
const code = readFileSync(bundlePath, 'utf8')
vm.runInNewContext(code, { window: mockWindow, console })

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

const tabs = {
  register(def) {
    registeredTabs.push(def)
    return () => {}
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

const pending = []
function makeCtx(declared) {
  const services = { locale, sidebarRightTabs: tabs, slots }
  const base = {
    inject(names, cb) {
      const wanted = Array.isArray(names) ? names : [names]
      const fire = () => cb(makeCtx(declared))
      if (wanted.every((w) => w in services)) fire()
      else pending.push({ wanted, fire })
      return () => {}
    },
    on() {
      return () => {}
    },
    effect(cb) {
      try {
        const r = cb()
        if (typeof r === 'function') r()
      } catch (e) {
        console.error('   [effect threw]', e?.message ?? e)
      }
      return () => {}
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
for (const p of pending.splice(0)) p.fire()

console.log(`  locale namespaces: ${locales.map((l) => l.ns).join(', ') || '(none)'}`)
console.log(`  registered tabs:   ${registeredTabs.length}`)
for (const t of registeredTabs) {
  console.log(`    id=${t.id} kind=${t.kind} title=${typeof t.title === 'function' ? 'fn' : JSON.stringify(t.title)} guide=${(t.guide ?? []).length}`)
}
console.log(`  slot entries:      ${slotEntries.length}`)
for (const s of slotEntries) {
  console.log(`    seat=${s.seat} key=${s.entry?.key ?? '(no key)'} name=${s.entry?.name ?? '?'}`)
}

// --- assertions ----------------------------------------------------------
let failed = false
if (registeredTabs.length === 0) {
  console.error('FAIL: no tab registered — the right rail has nothing to show')
  failed = true
}
const bodySeat = slotEntries.find((s) => s.seat === 'sidebar.right.pane.tab')
if (!bodySeat) {
  console.error('FAIL: no body seated at sidebar.right.pane.tab')
  failed = true
} else {
  const tab = registeredTabs[0]
  const expectedKey = tab?.id ?? tab?.kind
  if (bodySeat.entry?.key !== expectedKey) {
    console.error(`FAIL: slot key "${bodySeat.entry?.key}" !== registry id "${expectedKey}" — sidebar-right dispatches with entryKey = definition.id`)
    failed = true
  }
  // The body must render a React element (the host renderer is React).
  const el = bodySeat.entry?.render?.({ sessionId: 's1' })
  if (!el || typeof el !== 'object' || !('type' in el)) {
    console.error('FAIL: slot render did not return a React element')
    failed = true
  } else {
    console.log(`  body element type: ${typeof el.type === 'string' ? `<${el.type}>` : (el.type?.name ?? 'component')}`)
  }
}

if (failed) process.exit(1)
console.log('client mount simulation PASSED')
