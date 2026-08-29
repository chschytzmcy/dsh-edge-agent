/**
 * http-api rename route tests — verify POST /v1/sessions/{id}/rename
 * updates the title via the soft-dep sessions helper.
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
    process.nextTick(() => {
      ee.emit('data', JSON.stringify(body))
      ee.emit('end')
    })
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

describe('http-api /v1/sessions/{id}/rename', () => {
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

  it('renames an active session — returns 200 with new title', async () => {
    const svc = buildService()
    seedSession(svc, 'sess-rename')
    const req = mockReq('/v1/sessions/sess-rename/rename', 'POST', { authorization: 'Bearer test-token' }, { title: '我的会话' })
    const { res, cap } = mockRes()
    await (svc as any).handleRequest(req, res)
    assert.equal(cap.status, 200)
    const body = JSON.parse(cap.body)
    assert.equal(body.sessionId, 'sess-rename')
    assert.equal(body.title, '我的会话')
    const renameAudit = audit.entries.find((e: any) => e.kind === 'session.renamed')
    assert.ok(renameAudit)
    assert.equal(renameAudit.payload.title, '我的会话')
  })

  it('returns 400 when title is missing', async () => {
    const svc = buildService()
    seedSession(svc, 'sess-x')
    const req = mockReq('/v1/sessions/sess-x/rename', 'POST', { authorization: 'Bearer test-token' }, {})
    const { res, cap } = mockRes()
    await (svc as any).handleRequest(req, res)
    assert.equal(cap.status, 400)
    assert.match(JSON.parse(cap.body).error, /title is required/u)
  })

  it('returns 400 when title exceeds 200 chars', async () => {
    const svc = buildService()
    seedSession(svc, 'sess-y')
    const longTitle = 'x'.repeat(201)
    const req = mockReq('/v1/sessions/sess-y/rename', 'POST', { authorization: 'Bearer test-token' }, { title: longTitle })
    const { res, cap } = mockRes()
    await (svc as any).handleRequest(req, res)
    assert.equal(cap.status, 400)
    assert.match(JSON.parse(cap.body).error, /200 chars/u)
  })
})
