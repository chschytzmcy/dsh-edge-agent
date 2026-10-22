// scripts/_probe-plugins-route.mjs
// Probe a running DSH web server for the client-module bundle route.
//
// The route is `/plugins/??<id>/client.js&rev=<12 hex>` (see
// @deepseek-ai/dsh-client-modules: PLUGIN_ROUTE + comboSearch). The token
// travels as a query parameter on the app URL, so it is appended here.

const base = process.argv[2]
const token = process.argv[3]
const ids = process.argv.slice(4)

if (!base || !token || ids.length === 0) {
  console.error('usage: node _probe-plugins-route.mjs <base> <token> <id...>')
  process.exit(1)
}

for (const id of ids) {
  const url = `${base}/plugins/??${id}/client.js&rev=000000000000&token=${encodeURIComponent(token)}`
  try {
    const res = await fetch(url)
    const text = await res.text()
    const first = text.slice(0, 90).replace(/\n/g, ' ')
    console.log(`${id}\n  -> ${res.status} ${res.headers.get('content-type') ?? ''} len=${text.length}\n  ${first}`)
  } catch (e) {
    console.log(`${id}\n  -> ERROR ${e?.message ?? e}`)
  }
}
