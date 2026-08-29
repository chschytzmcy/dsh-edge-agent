/**
 * http-api fork route tests — verify POST /v1/sessions/{id}/fork
 * creates a new session record and copies recent messages.
 */
import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'

import { HttpApiServiceImpl } from '../../src/dsh-adapter/http-api.ts'

function mockReq(urlPath: string, method = 'POST', headers: Record<string, string> = {}, body?: any): any {
  const ee = new EventEmitter()
  ;(ee as any).method = method
  ;(ee as any).url = urlPath
  ;(ee as any).headers = { host: 'localhost', ...headers }
  if (body !== undefined) {
    process.nextTick(() => { ee.emit('data', JSON.stringify(body)); ee.emit('end') })
  } else {
    process.nextTick(() => ee.emit('end'))
  }
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

describe('http-api /v1/sessions/{id}/fork', () => {
  let audit: { entries: any[]; log: (e: any) => Promise<void> }

  beforeEach(() => {
    audit = { entries: [], log: async (e: any) => { audit.entries.push(e) } }
  })

  function buildService() {
    return new HttpApiServiceImpl(
      { reflect: { provide: () => {} }, on: () => () => {} } as any,
      {
        host: '127.0.0.1', port: 0, bearerToken: 'test-token',
        sessionIdleTimeoutMs: 0, maxActiveSessions: 100, maxRequestBodyBytes: 1024 * 1024,
      } as any,
      { create: async () => ({ agent: {}, handle: { dispose: async () => {} } }) } as any,
      audit,
      undefined,
    ) as any
  }

  function seedSession(svc: any, id: string) {
    svc.sessions.set(id, {
      agent: { id, session: { id, events: [] }, followup: () => {} },
      handle: { dispose: async () => {} },
      createdAt: Date.now(), lastAccessedAt: Date.now(),
    })
  }

  it('forks an active session — returns 201 with new sessionId', async () => {
    const svc = buildService()
    seedSession(svc, 'source-1')
    const req = mockReq('/v1/sessions/source-1/fork', 'POST', { authorization: 'Bearer test-token' }, {})
    const { res, cap } = mockRes()
    await (svc as any).handleRequest(req, res)
    assert.equal(cap.status, 201)
    const body = JSON.parse(cap.body)
    assert.equal(body.sourceSessionId, 'source-1')
    assert.notEqual(body.sessionId, 'source-1', 'fork must produce a fresh sessionId')
    const forkAudit = audit.entries.find((e: any) => e.kind === 'session.forked')
    assert.ok(forkAudit)
    assert.equal(forkAudit.payload.sourceSessionId, 'source-1')
    assert.equal(forkAudit.payload.newSessionId, body.sessionId)
  })

  it('returns 404 for unknown source session', async () => {
    const svc = buildService()
    const req = mockReq('/v1/sessions/ghost/fork', 'POST', { authorization: 'Bearer test-token' }, {})
    const { res, cap } = mockRes()
    await (svc as any).handleRequest(req, res)
    assert.equal(cap.status, 404)
  })

  it('fork requires bearer auth — 401 without token', async () => {
    const svc = buildService()
    const req = mockReq('/v1/sessions/x/fork', 'POST', {}, {})
    const { res, cap } = mockRes()
    await (svc as any).handleRequest(req, res)
    assert.equal(cap.status, 401)
  })

  it('fork copies recent messages to the new session ring buffer', async () => {
    const svc = buildService()
    seedSession(svc, 'src-2')
    // Pre-populate the source ring buffer (mimics multi-turn history).
    svc.sessionBuffers.set('src-2', [
      { role: 'user', text: 'turn-1', ts: Date.now() },
      { role: 'assistant', text: 'reply-1', ts: Date.now() },
    ])
    const req = mockReq('/v1/sessions/src-2/fork', 'POST', { authorization: 'Bearer test-token' }, {})
    const { res, cap } = mockRes()
    await (svc as any).handleRequest(req, res)
    assert.equal(cap.status, 201)
    const newId = JSON.parse(cap.body).sessionId
    const buf = svc.sessionBuffers.get(newId) ?? []
    assert.ok(buf.length > 0, 'forked session should have copied recent messages')
    assert.ok(buf.some((m: any) => m.text === 'turn-1'))
  })
})
