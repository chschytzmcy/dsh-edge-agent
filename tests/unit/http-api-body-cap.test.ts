/**
 * http-api body cap tests — verifies the readJsonBody defenses added 2026-08-26:
 *   - body > maxRequestBodyBytes → HTTP 413 (Payload Too Large), socket destroyed
 *   - malformed JSON              → HTTP 400 (Bad Request)
 *   - normal body                  → still succeeds (regression)
 *   - cap = 0 disables the cap     → very large body succeeds (back-compat knob)
 */
import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'

import { HttpApiServiceImpl } from '../../src/dsh-adapter/http-api.ts'

/** Build a mock IncomingMessage that emits a single data+end (or N data
 *  chunks + end). Listener registration inside readJsonBody's Promise
 *  constructor runs synchronously, so emitting via process.nextTick after
 *  the await hits the listener first. */
function mockReqWithChunks(
  chunks: string[],
  urlPath = '/v1/chat',
  headers: Record<string, string> = {},
): any {
  const ee = new EventEmitter()
  ;(ee as any).method = 'POST'
  ;(ee as any).url = urlPath
  ;(ee as any).headers = {
    host: 'localhost',
    authorization: 'Bearer test-token',
    'content-type': 'application/json',
    ...headers,
  }
  // Track destroy() calls to verify the socket-tear-down defense.
  let destroyCalls = 0
  let lastDestroyErr: any = null
  ;(ee as any).destroy = (err?: any) => {
    destroyCalls++
    lastDestroyErr = err
    return ee
  }
  ;(ee as any)._destroyCalls = () => destroyCalls
  ;(ee as any)._lastDestroyErr = () => lastDestroyErr

  process.nextTick(() => {
    for (const c of chunks) ee.emit('data', c)
    ee.emit('end')
  })
  return ee
}

/** Build a mock ServerResponse that captures writeHead / end. */
function mockRes() {
  const cap: any = { status: 0, body: undefined, headers: {} }
  const res: any = {
    writeHead(status: number, headers?: any) {
      cap.status = status
      if (headers) cap.headers = headers
      return res
    },
    setHeader(k: string, v: string) { cap.headers[k] = v; return res },
    end(payload?: any) { cap.body = payload; return res },
    write(_chunk: any) { return true },
    on(_event: string, _fn: any) { return res },
  }
  return { res, cap }
}

describe('http-api body cap (maxRequestBodyBytes)', () => {
  let audit: { entries: any[]; log: (e: any) => Promise<void> }
  let intentRouter: any
  let llmCallCount: number

  beforeEach(() => {
    audit = { entries: [], log: async (e: any) => { audit.entries.push(e) } }
    llmCallCount = 0
    intentRouter = {
      classify: async () => ({
        category: 'CLOUD',
        confidence: 0.9,
        targetRealm: 'cloud',
        rationale: 'llm-classified:cloud',
      }),
    }
  })

  /** Build a service with a custom body cap. Pass 0 to disable the cap. */
  function buildService(maxRequestBodyBytes: number) {
    const svc = new HttpApiServiceImpl(
      { reflect: { provide: () => {} }, on: () => () => {} } as any,
      {
        host: '127.0.0.1',
        port: 0,
        bearerToken: 'test-token',
        sessionIdleTimeoutMs: 0,
        maxActiveSessions: 100,
        requireAttestation: false,
        maxRequestBodyBytes,
      } as any,
      {
        create: async ({ sessionId }: any) => {
          llmCallCount++
          return {
            agent: {
              id: sessionId,
              session: { id: sessionId, events: [] },
              followup: (_msg: any) => {
                setTimeout(() => {
                  ;(svc as any).cordisCtx?.emit?.('session/event', { id: sessionId }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'hi' }] } } })
                  ;(svc as any).cordisCtx?.emit?.('session/event', { id: sessionId }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
                }, 5)
              },
            },
            handle: { dispose: async () => {} },
          }
        },
      } as any,
      audit,
      undefined,
    )
    ;(svc as any).intentRouter = intentRouter
    return svc
  }

  // ----- 413 path -----

  it('returns 413 when a single chunk exceeds maxRequestBodyBytes', async () => {
    const svc = buildService(64) // 64-byte cap
    const oversized = 'x'.repeat(200) // one 200-byte chunk
    const req = mockReqWithChunks([oversized])
    const { res, cap } = mockRes()

    await (svc as any).handleRequest(req, res)

    assert.equal(cap.status, 413, `expected 413, got ${cap.status}`)
    const parsed = JSON.parse(cap.body)
    assert.match(parsed.error, /maxRequestBodyBytes=64/u)
    // LLM must NEVER be called when the body is rejected up-front.
    assert.equal(llmCallCount, 0)
    // Socket must be torn down to prevent the attacker from streaming more.
    assert.equal(req._destroyCalls(), 1, 'req.destroy() must be called once')
    assert.ok(req._lastDestroyErr() instanceof Error)
    assert.match(req._lastDestroyErr().message, /maxRequestBodyBytes/u)
    // Audit logs at warn (not error) since 413 is a client error.
    const errEntry = audit.entries.find((e: any) => e.kind === 'http.error')
    assert.ok(errEntry, 'http.error audit must be present')
    assert.equal(errEntry.level, 'warn')
    assert.equal(errEntry.payload.status, 413)
  })

  it('returns 413 when accumulated multi-chunk body exceeds cap', async () => {
    const svc = buildService(100) // 100-byte cap
    // 5 × 40-byte chunks = 200 bytes; cap is breached after chunk 3 (120 > 100).
    const chunks = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40), 'd'.repeat(40), 'e'.repeat(40)]
    const req = mockReqWithChunks(chunks)
    const { res, cap } = mockRes()

    await (svc as any).handleRequest(req, res)

    assert.equal(cap.status, 413, `expected 413, got ${cap.status}`)
    assert.equal(llmCallCount, 0)
    // Once aborted, subsequent chunks must be ignored — only one destroy call.
    assert.equal(req._destroyCalls(), 1)
  })

  it('accepts a body whose total bytes are exactly at the cap', async () => {
    const svc = buildService(100)
    // Construct a JSON body that is exactly 100 bytes when serialized.
    // {"message":"<padding>"} → 14 + len(padding) = 100 → padding = 86
    const padding = 'p'.repeat(86)
    const body = { message: padding }
    const payload = JSON.stringify(body)
    assert.equal(Buffer.byteLength(payload, 'utf-8'), 100, 'fixture: must be exactly 100 bytes')

    // Test readJsonBody directly — we only care about the cap boundary, not
    // the full handleRequest → handleChat pipeline.
    const req = mockReqWithChunks([payload])

    const parsed = await (svc as any).readJsonBody(req)
    assert.equal(parsed.message, padding)
    assert.equal(req._destroyCalls(), 0, 'socket must NOT be destroyed for valid bodies')
  })

  it('caps the stream endpoint as well', async () => {
    const svc = buildService(64)
    const req = mockReqWithChunks(['x'.repeat(200)], '/v1/chat/stream')
    const { res, cap } = mockRes()

    await (svc as any).handleRequest(req, res)

    assert.equal(cap.status, 413, `expected 413 on stream, got ${cap.status}`)
    assert.equal(llmCallCount, 0)
    assert.equal(req._destroyCalls(), 1)
  })

  it('cap = 0 disables the byte limit (back-compat knob)', async () => {
    const svc = buildService(0) // cap disabled
    const huge = JSON.stringify({ message: 'x'.repeat(5000) })

    // Test readJsonBody directly to avoid the full chat pipeline.
    const req = mockReqWithChunks([huge])

    const parsed = await (svc as any).readJsonBody(req)
    assert.equal(parsed.message.length, 5000)
    assert.equal(req._destroyCalls(), 0, 'cap=0 must not destroy the socket for any size')
  })

  // ----- 400 path -----

  it('returns 400 when the body is malformed JSON', async () => {
    const svc = buildService(1024)
    // Missing closing brace → JSON.parse throws.
    const req = mockReqWithChunks(['{"message":"oops"'])
    const { res, cap } = mockRes()

    await (svc as any).handleRequest(req, res)

    assert.equal(cap.status, 400, `expected 400, got ${cap.status}`)
    const parsed = JSON.parse(cap.body)
    assert.match(parsed.error, /malformed JSON body/u)
    // LLM must NOT be called for malformed bodies.
    assert.equal(llmCallCount, 0)
    // Socket NOT destroyed (client didn't stream excessively — just sent bad JSON).
    assert.equal(req._destroyCalls(), 0, 'malformed JSON must NOT destroy the socket')
    // Audit logs at warn (4xx), not error.
    const errEntry = audit.entries.find((e: any) => e.kind === 'http.error')
    assert.ok(errEntry, 'http.error audit must be present')
    assert.equal(errEntry.level, 'warn')
    assert.equal(errEntry.payload.status, 400)
  })

  it('returns 400 on completely empty body content', async () => {
    // Empty payload currently resolves to {} — that returns 400 only because
    // `message` is missing. Here we test the empty-input branch explicitly:
    // the implementation resolves {} on empty data, then message-check fires 400.
    const svc = buildService(1024)
    const req = mockReqWithChunks([''])   // zero-byte body
    const { res, cap } = mockRes()

    await (svc as any).handleRequest(req, res)

    assert.equal(cap.status, 400, `expected 400 on empty body, got ${cap.status}`)
    assert.match(JSON.parse(cap.body).error, /message is required/u)
  })

  it('returns 400 on garbage that is not JSON at all', async () => {
    const svc = buildService(1024)
    const req = mockReqWithChunks(['this is plain text, not json'])
    const { res, cap } = mockRes()

    await (svc as any).handleRequest(req, res)

    assert.equal(cap.status, 400)
    assert.match(JSON.parse(cap.body).error, /malformed JSON body/u)
    assert.equal(llmCallCount, 0)
  })

  // ----- Regression: normal body still works -----

  it('normal body parses successfully via readJsonBody (regression)', async () => {
    const svc = buildService(1024 * 1024) // 1 MiB cap, way above test body
    const req = mockReqWithChunks([JSON.stringify({ message: 'hello world' })])

    // Test readJsonBody directly — boundary we care about is the byte cap,
    // not the downstream chat pipeline (covered by http-api-e2e.test.ts).
    const parsed = await (svc as any).readJsonBody(req)

    assert.deepEqual(parsed, { message: 'hello world' })
    assert.equal(req._destroyCalls(), 0)
  })
})
