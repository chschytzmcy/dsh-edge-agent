// scripts/_probe-auth.mjs — show the auth handshake of a DSH web server.
const base = process.argv[2]
const token = process.argv[3]

const attempts = [
  [`?token=`, `${base}/?token=${encodeURIComponent(token)}`],
  [`bearer`, `${base}/`],
  [`x-dsh-token`, `${base}/`],
]

for (const [label, url] of attempts) {
  const headers = label === 'bearer' ? { authorization: `Bearer ${token}` }
    : label === 'x-dsh-token' ? { 'x-dsh-token': token }
    : {}
  const res = await fetch(url, { headers, redirect: 'manual' })
  const body = await res.text()
  console.log(`\n=== ${label} -> ${res.status} ${res.statusText}`)
  for (const [k, v] of res.headers) console.log(`   ${k}: ${v}`)
  console.log('   body:', body.slice(0, 300))
}
