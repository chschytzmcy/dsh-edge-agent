// scripts/_probe-models.mjs — list the model routes a running DSH server
// exposes. Used to confirm that an adapter which registers no route (the
// local-LLM adapter without an endpoint) disappears from the catalog
// instead of offering a route that always fails.
const base = process.argv[2]
const token = process.argv[3]

const jar = new Map()
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
const first = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
for (const raw of first.headers.getSetCookie?.() ?? []) {
  const [pair] = raw.split(';')
  const idx = pair.indexOf('=')
  jar.set(pair.slice(0, idx), pair.slice(idx + 1))
}

for (const path of ['/v1/models', '/api/v1/models']) {
  const res = await fetch(`${base}${path}`, { headers: { cookie: cookieHeader() } })
  const text = await res.text()
  console.log(`\n=== ${path} -> ${res.status} ===`)
  if (res.status !== 200) {
    console.log(text.slice(0, 200))
    continue
  }
  let parsed
  try { parsed = JSON.parse(text) } catch { console.log(text.slice(0, 400)); continue }
  const rows = parsed?.data ?? parsed?.models ?? parsed
  if (Array.isArray(rows)) {
    for (const r of rows) {
      const id = r?.id ?? r?.name ?? r?.model ?? JSON.stringify(r)
      const provider = r?.provider ?? r?.realm ?? ''
      console.log(`  ${id}${provider ? `  (${provider})` : ''}`)
    }
  } else {
    console.log(text.slice(0, 600))
  }
}
