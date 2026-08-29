/**
 * http-api /v1/audit route tests — verify the audit query endpoint
 * passes filters to audit-log.query() and post-filters by sessionId.
 */
import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'

import { HttpApiServiceImpl } from '../../src/dsh-adapter/http-api.ts'

function mockReq(urlPath: string, headers: Record<string, string> = {}, method = 'GET'): any {
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

const SAMPLE = [
  { ts: 1, level: 'info', kind: 'http.chat.start', source: 'http-api', payload: { sessionId: 'a', messageLen: 10 } },
  { ts: 2, level: 'warn', kind: 'session.canceled', source: 'http-api', payload: { sessionId: 'a' } },
  { ts: 3, level: 'info', kind: 'http.chat.start', source: 'http-api', payload: { sessionId: 'b', messageLen: 20 } },
  { ts: 4, level: 'security', kind: 'intent.rejected', source: 'input-guard', payload: { sessionId: 'a' } },
]

describe('http-api /v1/audit', () => {
  let audit: any
  let queryCalls: any[]

  beforeEach(() => {
    queryCalls = []
    audit = {
      log: async () => {},
      query: async (filter: any) => {
        queryCalls.push(filter)
        return SAMPLE
      },
    }
  })

  function buildService() {
    return new HttpApiServiceImpl(
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
    )
  }

  it('returns all entries (default limit 50)', async () => {
    const svc = buildService()
    const req = mockReq('/v1/audit', { authorization: 'Bearer test-token' })
    const { res, cap } = mockRes()
    await (svc as any).handleRequest(req, res)

    assert.equal(cap.status, 200)
    const body = JSON.parse(cap.body)
    assert.equal(body.count, 4)
    assert.equal(body.limit, 50)
    assert.equal(queryCalls[0].limit, 50)
  })

  it('filters by sessionId via payload post-filter', async () => {
    const svc = buildService()
    const req = mockReq('/v1/audit?sessionId=a', { authorization: 'Bearer test-token' })
    const { res, cap } = mockRes()
    await (svc as any).handleRequest(req, res)

    assert.equal(cap.status, 200)
    const body = JSON.parse(cap.body)
    assert.equal(body.count, 3) // 3 entries with payload.sessionId === 'a'
    assert.ok(body.entries.every((e: any) => e.payload.sessionId === 'a'))
  })

  it('clamps limit to 500 max', async () => {
    const svc = buildService()
    const req = mockReq('/v1/audit?limit=9999', { authorization: 'Bearer test-token' })
    const { res, cap } = mockRes()
    await (svc as any).handleRequest(req, res)

    assert.equal(cap.status, 200)
    assert.equal(queryCalls[0].limit, 500, 'limit must be hard-capped at 500')
  })

  it('returns 400 on invalid since parameter', async () => {
    const svc = buildService()
    const req = mockReq('/v1/audit?since=not-a-number', { authorization: 'Bearer test-token' })
    const { res, cap } = mockRes()
    await (svc as any).handleRequest(req, res)

    assert.equal(cap.status, 400)
    assert.match(JSON.parse(cap.body).error, /since must be a number/u)
  })

  it('returns 503 when audit-log is missing', async () => {
    const svc = new HttpApiServiceImpl(
      { reflect: { provide: () => {} }, on: () => () => {} } as any,
      {
        host: '127.0.0.1', port: 0, bearerToken: 'test-token',
        sessionIdleTimeoutMs: 0, maxActiveSessions: 100, maxRequestBodyBytes: 1024 * 1024,
      } as any,
      { create: async () => ({ agent: {}, handle: { dispose: async () => {} } }) } as any,
      null, // no audit-log
      undefined,
    )
    const req = mockReq('/v1/audit', { authorization: 'Bearer test-token' })
    const { res, cap } = mockRes()
    await (svc as any).handleRequest(req, res)

    assert.equal(cap.status, 503)
    assert.match(JSON.parse(cap.body).error, /audit-log not available/u)
  })
})
