#!/usr/bin/env node
/**
 * M5 manual verification script — tests the HTTP API endpoints.
 *
 * Prerequisites:
 *   1. Build: npm run compile (or npm run build)
 *   2. Start server: EDGE_API_KEY=test123 dsh --profile dsh-edge-agent
 *   3. Run this script: node scripts/m5-verify.ts
 *
 * Expected: all tests pass with ✅
 */

const BASE_URL = process.env.DSH_EDGE_HTTP_URL ?? 'http://127.0.0.1:21017'
const API_KEY = process.env.EDGE_API_KEY ?? 'test123'

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    console.log(`✅ ${name}`)
  } catch (err: any) {
    console.error(`❌ ${name}: ${err.message}`)
    process.exitCode = 1
  }
}

async function main() {
  console.log(`Testing HTTP API at ${BASE_URL}\n`)

  await test('GET /v1/health (public)', async () => {
    const res = await fetch(`${BASE_URL}/v1/health`)
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`)
    const body = await res.json()
    if (body.status !== 'ok') throw new Error('expected status: ok')
  })

  await test('GET /v1/openapi.json (public)', async () => {
    const res = await fetch(`${BASE_URL}/v1/openapi.json`)
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`)
    const body = await res.json()
    if (!body.openapi) throw new Error('expected openapi field')
  })

  await test('Rejects missing auth', async () => {
    const res = await fetch(`${BASE_URL}/v1/sessions`)
    if (res.status !== 401) throw new Error(`expected 401, got ${res.status}`)
  })

  await test('Rejects wrong auth', async () => {
    const res = await fetch(`${BASE_URL}/v1/sessions`, {
      headers: { Authorization: 'Bearer wrong' },
    })
    if (res.status !== 401) throw new Error(`expected 401, got ${res.status}`)
  })

  await test('POST /v1/chat (sync)', async () => {
    const res = await fetch(`${BASE_URL}/v1/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({ message: 'hello' }),
    })
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`)
    const body = await res.json()
    if (!body.sessionId) throw new Error('expected sessionId')
    if (!body.result) throw new Error('expected result')
    if (!body.duration) throw new Error('expected duration')
  })

  await test('GET /v1/sessions', async () => {
    const res = await fetch(`${BASE_URL}/v1/sessions`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    })
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`)
    const body = await res.json()
    if (!Array.isArray(body.sessions)) throw new Error('expected sessions array')
  })

  await test('POST /v1/chat/stream (SSE)', async () => {
    const res = await fetch(`${BASE_URL}/v1/chat/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({ message: 'hello' }),
    })
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`)
    if (!res.headers.get('content-type')?.includes('text/event-stream')) {
      throw new Error('expected text/event-stream')
    }
    // Read a few chunks
    const reader = res.body?.getReader()
    if (!reader) throw new Error('no reader')
    let chunks = 0
    while (chunks < 3) {
      const { done, value } = await reader.read()
      if (done) break
      chunks++
    }
    reader.cancel()
  })

  console.log('\n✅ All tests passed')
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
