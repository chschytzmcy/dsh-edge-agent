// scripts/_probe-install-chain.mjs
// §7.103 (2026-10-22): one-shot diagnosis of the desktop install chain.
//
// Answers, in order:
//   1. Is the link target (dist/installable/<variant>) present and complete?
//   2. Is the package actually installed in the profile's node_modules
//      (and not parked under .ignored/ because pnpm saw the link break)?
//   3. What does the profile's package.json declare (link + bundles)?
//   4. If a web server URL is given, is our entry in window.__DSH_BOOT__?
//
// Usage:
//   node scripts/_probe-install-chain.mjs [webBaseUrl] [token]
//
// Exit code 0 = the chain looks intact; 1 = something is broken (printed).

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const PKG_NAME = '@deepseek-harness-edge-agent/dsh-edge-agent'
const REPO = resolve(import.meta.dirname, '..')
let problems = 0

const say = (ok, msg) => {
  if (!ok) problems++
  console.log(`${ok ? '  OK  ' : ' FAIL '} ${msg}`)
}

// ── 1. the installable bundle the profile links to ────────────────────────
console.log('=== 1. installable bundle (link target) ===')
for (const variant of ['dsh-edge-agent-desktop-safe', 'dsh-edge-agent-full']) {
  const dir = join(REPO, 'dist', 'installable', variant)
  if (!existsSync(dir)) {
    say(false, `${variant}: directory missing — run: npm run build:installable`)
    continue
  }
  const has = (f) => existsSync(join(dir, f))
  const pkg = has('package.json') ? JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) : {}
  const patchField = pkg?.dsh?.bundle?.patch
  say(has('package.json'), `${variant}: package.json ${has('package.json') ? 'present' : 'MISSING'}`)
  say(has('cordis.desktop-safe.patch.yml') || has('cordis.patch.yml'),
    `${variant}: cordis patch file present`)
  say(has('lib/client.js'), `${variant}: lib/client.js ${has('lib/client.js') ? 'present' : 'MISSING'}`)
  say(has('lib/index.js'), `${variant}: lib/index.js ${has('lib/index.js') ? 'present' : 'MISSING'}`)
  say(has('config/edge.json') || has('config/edge.example.json'),
    `${variant}: config/ present`)
  if (patchField) {
    say(existsSync(join(dir, patchField.replace(/^\.\//, ''))),
      `${variant}: dsh.bundle.patch → ${patchField} resolves`)
  } else {
    say(false, `${variant}: package.json#dsh.bundle.patch missing`)
  }
  const exportsClient = pkg?.exports?.['./client']
  say(typeof exportsClient === 'string' || exportsClient?.default !== undefined,
    `${variant}: exports["./client"] = ${JSON.stringify(exportsClient)}`)
  say(pkg?.dsh?.client?.platform === 'web',
    `${variant}: dsh.client.platform = ${JSON.stringify(pkg?.dsh?.client?.platform)}`)
  say(Array.isArray(pkg?.dsh?.client?.inject) && pkg.dsh.client.inject.length > 0,
    `${variant}: dsh.client.inject = ${JSON.stringify(pkg?.dsh?.client?.inject)}`)
}

// ── 2/3. the desktop profile ────────────────────────────────────────────
console.log('\n=== 2. desktop profile install state ===')
const profileDir = join(homedir(), '.dsh', 'profiles', 'desktop')
if (!existsSync(profileDir)) {
  say(false, 'profile ~/.dsh/profiles/desktop missing')
} else {
  const pkgPath = join(profileDir, 'package.json')
  const profilePkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf8')) : {}
  const specifier = profilePkg?.dependencies?.[PKG_NAME]
  say(typeof specifier === 'string', `profile declares ${PKG_NAME} = ${JSON.stringify(specifier)}`)
  if (typeof specifier === 'string' && specifier.startsWith('link:')) {
    const target = resolve(profileDir, specifier.slice('link:'.length))
    say(existsSync(target), `link target exists: ${target}`)
  }
  const bundles = profilePkg?.dsh?.profile?.bundles ?? []
  say(bundles.includes(PKG_NAME), `bundles[] includes our package`)
  console.log(`         bundles: ${JSON.stringify(bundles)}`)

  // installed?
  const installed = join(profileDir, 'node_modules', ...PKG_NAME.split('/'))
  const ignored = join(profileDir, 'node_modules', '.ignored', ...PKG_NAME.split('/'))
  const installedOk = existsSync(join(installed, 'package.json'))
  const ignoredOk = existsSync(join(ignored, 'package.json'))
  say(installedOk, `installed at node_modules/${PKG_NAME}${installedOk ? '' : ' — MISSING'}`)
  if (ignoredOk) {
    say(false, `parked under node_modules/.ignored/ — pnpm saw the link break;`
      + ` re-add the plugin in the desktop UI`)
  }
  // dsh-context for comparison
  const ctxInstalled = existsSync(join(profileDir, 'node_modules', 'dsh-context', 'package.json'))
  say(ctxInstalled, `dsh-context installed (reference plugin) — ${ctxInstalled ? 'present' : 'MISSING'}`)
}

// ── 4. the live boot graph (optional) ───────────────────────────────────
const base = process.argv[2]
const token = process.argv[3]
if (base) {
  console.log('\n=== 3. live boot graph ===')
  try {
    const jar = new Map()
    const first = await fetch(`${base}/?token=${encodeURIComponent(token ?? '')}`, { redirect: 'manual' })
    for (const raw of first.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';')
      const i = pair.indexOf('=')
      jar.set(pair.slice(0, i), pair.slice(i + 1))
    }
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
    const res = await fetch(`${base}/`, { headers: { cookie } })
    const html = await res.text()
    const m = /globalThis\["__DSH_BOOT__"\]\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/u.exec(html)
    if (!m) {
      say(false, 'boot graph not found in index html')
    } else {
      const graph = JSON.parse(m[1])
      const ids = (graph.entries ?? []).map((e) => e.id)
      console.log(`         graph entries: ${JSON.stringify(ids)}`)
      say(ids.includes(PKG_NAME), `boot graph contains ${PKG_NAME}`)
      const ours = (graph.entries ?? []).find((e) => e.id === PKG_NAME)
      if (ours) console.log(`         ours: ${JSON.stringify(ours, null, 2).replace(/\n/g, '\n         ')}`)
    }
  } catch (e) {
    say(false, `cannot reach ${base}: ${e.message}`)
  }
}

console.log(problems === 0 ? '\nRESULT: chain looks intact' : `\nRESULT: ${problems} problem(s) found`)
process.exit(problems === 0 ? 0 : 1)
