// scripts/_probe-boot-graph.mjs
// Boot the auth handshake, parse the composed `window.__DSH_BOOT__` graph
// from the index page, and report our package's entry + fetch its bundle.

const base = process.argv[2]
const token = process.argv[3]
const ours = process.argv[4] ?? '@dsh-edge/dsh-edge-agent'

const jar = new Map()
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
const first = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
for (const raw of first.headers.getSetCookie?.() ?? []) {
  const [pair] = raw.split(';')
  const idx = pair.indexOf('=')
  jar.set(pair.slice(0, idx), pair.slice(idx + 1))
}
const get = async (path) => {
  const res = await fetch(`${base}${path}`, { headers: { cookie: cookieHeader() } })
  return { status: res.status, type: res.headers.get('content-type'), text: await res.text() }
}

const index = await get('/')
const m = /globalThis\["__DSH_BOOT__"\]\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/u.exec(index.text)
if (!m) {
  console.error('boot graph not found in index')
  process.exit(1)
}
const graph = JSON.parse(m[1])
console.log(`boot rev: ${graph.rev}  release: ${graph.release?.version} (${graph.release?.commit})`)

const entries = graph.entries ?? []
console.log(`\n=== ${entries.length} graph entries ===`)
for (const e of entries) {
  const mark = e.id === ours ? '  <<< OURS' : ''
  console.log(`  ${e.id}${mark}`)
  if (e.id === ours) console.log(`     ${JSON.stringify(e, null, 2).replace(/\n/g, '\n     ')}`)
}

console.log('\n=== batches ===')
for (const b of graph.batches ?? []) {
  console.log(`  kind=${b.kind} url=${b.url}`)
}

// Find the URL that serves our bundle and fetch it.
console.log('\n=== fetching our bundle ===')
const urls = new Set()
for (const b of graph.batches ?? []) {
  for (const r of b.records ?? []) {
    if (r.id === ours && r.url) urls.add(r.url)
  }
}
for (const e of entries) {
  if (e.id === ours && e.url) urls.add(e.url)
}
if (urls.size === 0) {
  // Fall back: the entry may carry a per-package path; derive it.
  urls.add(`plugins/??${ours}/client.js`)
}
for (const u of urls) {
  const path = u.startsWith('/') ? u : `/${u}`
  const r = await get(path)
  console.log(`  ${u}\n    -> ${r.status} ${r.type ?? ''} len=${r.text.length}`)
  if (r.status === 200) {
    console.log(`    head: ${r.text.slice(0, 200).replace(/\n/g, ' ')}`)
    console.log(`    has __ModuleLoader__: ${r.text.includes('__ModuleLoader__')}`)
  }
}
