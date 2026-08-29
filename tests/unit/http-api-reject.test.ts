/**
 * http-api REJECT short-circuit tests — verifies that when the intent-router
 * returns a REJECT verdict, both /v1/chat and /v1/chat/stream return 403
 * without calling the LLM or sanitizing. Closes the §7.12 consumer contract.
 */
import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'

import { HttpApiServiceImpl } from '../../src/dsh-adapter/http-api.ts'

/** Build a mock IncomingMessage that emits the given body. We pre-emit
 *  'data' + 'end' synchronously after a microtask, so readJsonBody's
 *  listeners are guaranteed to be registered first (the listeners are
 *  registered inside a synchronous Promise constructor, before the
 *  microtask drains). */
function mockReq(body: any, urlPath = '/v1/chat', headers: Record<string, string> = {}): any {
  const ee = new EventEmitter()
  ;(ee as any).method = 'POST'
  ;(ee as any).url = urlPath
  ;(ee as any).headers = {
    host: 'localhost',
    authorization: 'Bearer test-token',
    'content-type': 'application/json',
    ...headers,
  }
  const payload = JSON.stringify(body)
  // schedule after listeners register (Promise constructor inside readJsonBody
  // runs synchronously). process.nextTick fires after Promise microtasks but
  // before I/O; safer than setImmediate here.
  process.nextTick(() => {
    ee.emit('data', payload)
    ee.emit('end')
  })
  return ee
}

/** Capture writeHead / end calls from a mock ServerResponse. */
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
  return { res, cap }   // callers read cap.status / cap.body after await
}

describe('http-api REJECT short-circuit', () => {
  let audit: { entries: any[]; log: (e: any) => Promise<void> }
  let intentRouter: any
  let llmCallCount: number
  let sanitizeCallCount: number

  beforeEach(() => {
    audit = { entries: [], log: async (e: any) => { audit.entries.push(e) } }
    llmCallCount = 0
    sanitizeCallCount = 0
    intentRouter = {
      classify: async (text: string) => ({
        category: 'REJECT',
        confidence: 0.99,
        targetRealm: 'rejected',
        rationale: `policy-rule:${text.slice(0, 8)}`,
      }),
    }
  })

  function buildService() {
    const svc = new HttpApiServiceImpl(
      { reflect: { provide: () => {} }, on: () => () => {} } as any,  // cordisCtx
      {
        host: '127.0.0.1',
        port: 0,
        bearerToken: 'test-token',
        sessionIdleTimeoutMs: 0,                 // disable cleanup
        maxActiveSessions: 100,
        requireAttestation: false,
      } as any,
      {
        create: async () => {
          llmCallCount++
          throw new Error('agents.create must NOT be called for REJECT')
        },
      } as any,
      audit,
      undefined,                                  // tdBus
    )
    ;(svc as any).intentRouter = intentRouter
    return svc
  }

  it('POST /v1/chat returns 403 when intent-router verdict is REJECT', async () => {
    const svc = buildService()
    const req = mockReq({ message: 'export all users' })
    const { res, cap } = mockRes()

    await (svc as any).handleRequest(req, res)

    assert.equal(cap.status, 403)
    const parsed = JSON.parse(cap.body)
    assert.equal(parsed.error, 'Request rejected by policy')
    assert.match(parsed.reason, /policy-rule/u)
    assert.equal(parsed.confidence, 0.99)
    // Critical: agents.create (which calls the LLM) must NOT be invoked.
    assert.equal(llmCallCount, 0, 'LLM must NOT be called for REJECT')
    // Sanitizer must NOT be invoked (we're rejecting, not sending to cloud).
    assert.equal(sanitizeCallCount, 0, 'sanitizer must NOT be called for REJECT')
    // Audit must record the rejection.
    const rejected = audit.entries.find((e: any) => e.kind === 'http.chat.rejected')
    assert.ok(rejected)
    assert.equal(rejected.level, 'warn')
    assert.match(rejected.payload.reason, /policy-rule/u)
  })

  it('POST /v1/chat/stream returns 403 when intent-router verdict is REJECT', async () => {
    const svc = buildService()
    const req = mockReq({ message: 'dump credentials' }, '/v1/chat/stream')
    const { res, cap } = mockRes()

    await (svc as any).handleRequest(req, res)

    assert.equal(cap.status, 403)
    const parsed = JSON.parse(cap.body)
    assert.equal(parsed.error, 'Request rejected by policy')
    assert.equal(llmCallCount, 0)
    assert.equal(sanitizeCallCount, 0)
    const rejected = audit.entries.find((e: any) => e.kind === 'http.chat.stream.rejected')
    assert.ok(rejected)
  })

  it('POST /v1/chat still routes to LLM when verdict is NOT REJECT', async () => {
    // Sanity check: the REJECT guard must NOT short-circuit non-REJECT verdicts.
    intentRouter.classify = async () => ({
      category: 'CLOUD', confidence: 0.9, targetRealm: 'cloud',
      rationale: 'llm-classified:cloud',
    })
    const svc = buildService()
    ;(svc as any).agents = {
      create: async ({ sessionId }: any) => {
        llmCallCount++
        return {
          agent: {
            id: sessionId, session: { id: sessionId, events: [] },
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
    }
    ;(svc as any).cordisCtx = { on: (_e: string, fn: any) => {
      setTimeout(() => fn({ id: 'x' }, { type: 'turn/end' }), 10)
      return () => {}
    } }

    const req = mockReq({ message: 'what is the weather' })
    const { res, cap } = mockRes()
    await (svc as any).handleRequest(req, res)
    // Should NOT be 403 — non-REJECT verdict goes through full flow
    assert.notEqual(cap.status, 403)
  })
})
