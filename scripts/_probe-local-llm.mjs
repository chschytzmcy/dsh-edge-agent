// scripts/_probe-local-llm.mjs
// Scan the loopback ports for an OpenAI-compatible endpoint (llama.cpp /
// Ollama / vLLM), so the operator can be told which DSH_EDGE_LOCAL_LLM_BASEURL
// to point at instead of guessing.

import { createConnection } from 'node:net'

const ports = process.argv.slice(2).map(Number)

const probe = (port) => new Promise((resolve) => {
  const socket = createConnection({ host: '127.0.0.1', port })
  const done = (result) => { socket.destroy(); resolve(result) }
  socket.setTimeout(1200)
  socket.on('connect', () => done({ port, open: true }))
  socket.on('timeout', () => done({ port, open: false }))
  socket.on('error', () => done({ port, open: false }))
})

for (const port of ports) {
  const { open } = await probe(port)
  if (!open) continue
  for (const path of ['/v1/models', '/models', '/api/tags']) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(1500) })
      const text = await res.text()
      const interesting = res.ok && (/"(model|id|name)"\s*:/.test(text) || /model/i.test(text))
      if (interesting) {
        console.log(`port ${port} ${path} -> ${res.status}`)
        console.log(`  ${text.slice(0, 400).replace(/\n/g, ' ')}`)
      }
    } catch { /* not this one */ }
  }
}
console.log('scan done')
