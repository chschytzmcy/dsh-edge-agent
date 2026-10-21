// scripts/_simulate-host-mount.mjs
//
// Simulate the DSH host's mount of the edge-agent host half against a mock
// cordis 0.2.1-rc.2 context. The mock reproduces the Proxy semantics that
// caused the real failures:
//
//   * reading a property that is neither an own/prototype member nor a
//     DECLARED service throws
//     `cannot get property "<x>" without inject`
//   * writing an undeclared property throws
//     `cannot set property "<x>" without provide`
//   * `ctx.inject([...], cb)` is deferred and never throws
//
// A successful run proves the host half activates (a fiber exists), which is
// the precondition for @deepseek-ai/dsh-client-modules to discover the
// browser half at all (`entry.fiber === void 0 → continue`).

import { pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const entry = process.argv[2] ?? join(root, 'lib', 'index.js')

const declared = new Set() // services the plugin declared in `inject`
const services = new Map() // provided services

function makeCtx(pluginInject = []) {
  for (const s of pluginInject) declared.add(s)
  const logger = {
    info: (...a) => console.log('   [logger.info]', ...a),
    warn: (...a) => console.log('   [logger.warn]', ...a),
    error: (...a) => console.log('   [logger.error]', ...a),
    debug: () => {},
    exporters: new Set([1]),
    exporter(cfg) {
      // Cordis's external-exporter hook: the host appends this logger to
      // every subsequent log line. file-logger.ts installs exactly one.
      logger.exporters.add(cfg)
      return () => logger.exporters.delete(cfg)
    },
  }
  const base = {
    logger,
    inject(names, cb) {
      // Deferred inject: fires when every named service is available.
      const wanted = Array.isArray(names) ? names : [names]
      const fire = () => {
        try {
          cb(makeCtx(pluginInject))
        } catch (e) {
          console.error('   [deferred inject callback threw]', e?.message ?? e)
        }
      }
      if (wanted.every((w) => services.has(w))) fire()
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
    reflect: {
      provide(name, impl) {
        services.set(name, impl)
        for (const p of pending.splice(0)) {
          if (p.wanted.every((w) => services.has(w))) p.fire()
        }
        return () => services.delete(name)
      },
    },
  }
  return new Proxy(base, {
    get(target, prop) {
      if (typeof prop === 'symbol') return Reflect.get(target, prop)
      if (prop in target) return Reflect.get(target, prop)
      if (services.has(prop)) return services.get(prop)
      if (declared.has(prop)) return undefined
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
    set(target, prop, value) {
      if (prop in target || services.has(prop) || declared.has(prop)) {
        return Reflect.set(target, prop, value)
      }
      throw new Error(`cannot set property "${String(prop)}" without provide`)
    },
  })
}

const pending = []

console.log(`simulating host mount of: ${entry}`)
const mod = await import(pathToFileURL(entry).href)

for (const key of ['name', 'inject', 'apply', 'Config']) {
  console.log(`  ${key}: ${key in mod ? (typeof mod[key] === 'function' ? 'function' : JSON.stringify(mod[key])) : 'MISSING'}`)
}
if (typeof mod.apply !== 'function') {
  console.error('FAIL: no apply export — the host cannot mount this entry.')
  process.exit(1)
}

// The host mounts the bare-name row; its declared inject is what cordis
// waits for. Provide a stand-in auditLog service (the audit-log row does).
services.set('auditLog', { entries: [], onEntry: () => () => {} })

const ctx = makeCtx(mod.inject ?? [])
console.log(`  declared inject: ${JSON.stringify(mod.inject ?? [])}`)

try {
  const dispose = await mod.apply(ctx, {})
  console.log('  apply() OK — host half would activate (fiber exists)')
  if (typeof dispose === 'function') {
    await dispose()
    console.log('  dispose() OK')
  }
} catch (e) {
  console.error(`  apply() THREW: ${e?.message ?? e}`)
  process.exit(1)
}
console.log('host mount simulation PASSED')
