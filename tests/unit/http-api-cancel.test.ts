/**
 * http-api cancel route tests — verify POST /v1/sessions/{id}/cancel
 * disposes the live AgentHandle and persists the cancel intent.
 */
import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'

import { HttpApiServiceImpl } from '../../src/dsh-adapter/http-api.ts'

function mockReq(urlPath: string, method = 'POST', headers: Record<string, string> = {}): any {
  const ee = new EventEmitter()
  ;(ee as any).method = method
  ;(ee as any).url = urlPath
  ;(ee as any).headers = { host: 'localhost', ...headers }
  return ee
}

function mockRes() {
  const cap: any = { status: 0, body: undefined, headers: {} }
  const res: any = {
    writeHead(status: number, headers?: any) { cap.status = status; if (headers) cap.headers = headers; return res },
    setHeader(k: string, v: string) { cap.headers[k] = v; return res },
    end(payload?: any) { cap.body = payload; return res },
    write(_chunk: any) { return true },
    on(_event: string, _fn: any) { return res },
  }
  return { res, cap }
}

describe('http-api /v1/sessions/{id}/cancel', () => {
  let audit: { entries: any[]; log: (e: any) => Promise<void> }
  let disposeCount: number

  beforeEach(() => {
    audit = { entries: [], log: async (e: any) => { audit.entries.push(e) } }
    disposeCount = 0
  })

  function buildService() {
    const svc = new HttpApiServiceImpl(
      { reflect: { provide: () => {} }, on: () => () => {} } as any,
      {
        host: '127.0.0.1',
        port: 0,
        bearerToken: 'test-token',
        sessionIdleTimeoutMs: 0,
        maxActiveSessions: 100,
        maxRequestBodyBytes: 1024 * 1024,
      } as any,
      { create: async () => ({ agent: {}, handle: { dispose: async () => {} } }) } as any,
      audit,
      undefined,
    ) as any
    return svc
  }

  /** Seed an in-memory session record directly so tests don't need to
   *  drive the full /v1/chat flow (which requires async agent event
   *  emission and brittle timing). */
  function seedSession(svc: any, id: string) {
    let disposed = false
    svc.sessions.set(id, {
      agent: { id, session: { id, events: [] }, followup: () => {} },
      handle: { dispose: async () => { if (!disposed) { disposed = true; disposeCount++ } } },
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    })
  }

  it('cancels an active session — returns 202 and disposes the handle', async () => {
    const svc = buildService()
    seedSession(svc, 'sess-1')

    const req = mockReq('/v1/sessions/sess-1/cancel', 'POST', { authorization: 'Bearer test-token' })
    const { res, cap } = mockRes()
    await (svc as any).handleRequest(req, res)

    assert.equal(cap.status, 202)
    const body = JSON.parse(cap.body)
    assert.equal(body.sessionId, 'sess-1')
    assert.equal(body.canceled, true)
    assert.equal(disposeCount, 1, 'handle.dispose() must be called exactly once')
    const cancelAudit = audit.entries.find((e: any) => e.kind === 'session.canceled')
    assert.ok(cancelAudit, 'session.canceled audit entry must exist')
    assert.equal(cancelAudit.payload.sessionId, 'sess-1')
  })

  it('cancel on unknown session is idempotent — 202 with status=no-active-handle', async () => {
    const svc = buildService()
    const req = mockReq('/v1/sessions/ghost/cancel', 'POST', { authorization: 'Bearer test-token' })
    const { res, cap } = mockRes()
    await (svc as any).handleRequest(req, res)
    assert.equal(cap.status, 202)
    const body = JSON.parse(cap.body)
    assert.equal(body.canceled, true)
    assert.equal(body.status, 'no-active-handle')
    assert.equal(disposeCount, 0, 'no dispose when session was never active')
  })

  it('cancel requires bearer auth — 401 without token', async () => {
    const svc = buildService()
    seedSession(svc, 'sess-2')
    const req = mockReq('/v1/sessions/sess-2/cancel', 'POST')
    const { res, cap } = mockRes()
    await (svc as any).handleRequest(req, res)
    assert.equal(cap.status, 401)
  })
})
