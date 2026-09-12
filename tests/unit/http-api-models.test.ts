/**
 * http-api /v1/models route tests — verify the metadata endpoint
 * returns the dispatcher catalog (LOCAL + CLOUD providers).
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

describe('http-api /v1/models', () => {
  let audit: { entries: any[]; log: (e: any) => Promise<void> }

  beforeEach(() => {
    audit = { entries: [], log: async (e: any) => { audit.entries.push(e) } }
  })

  function buildService(modelRouter: any = null) {
    return new HttpApiServiceImpl(
      { reflect: { provide: () => {} }, on: () => () => {}, modelRouter } as any,
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

  it('returns the dispatcher catalog with realm metadata', async () => {
    const svc = buildService({
      listDetailed: () => [
        { provider: 'local-llm', realm: 'LOCAL', available: true },
        { provider: 'cloud-llm', realm: 'CLOUD', available: true },
      ],
    })
    const req = mockReq('/v1/models', { authorization: 'Bearer test-token' })
    const { res, cap } = mockRes()
    await (svc as any).handleRequest(req, res)

    assert.equal(cap.status, 200)
    const body = JSON.parse(cap.body)
    assert.ok(Array.isArray(body.models))
    assert.equal(body.models.length, 2)
    const local = body.models.find((m: any) => m.realm === 'LOCAL')
    const cloud = body.models.find((m: any) => m.realm === 'CLOUD')
    assert.equal(local.provider, 'local-llm')
    assert.equal(cloud.provider, 'cloud-llm')
    assert.equal(local.available, true)
  })

  it('falls back to hardcoded pair when model-router is missing', async () => {
    const svc = buildService(null)
    const req = mockReq('/v1/models', { authorization: 'Bearer test-token' })
    const { res, cap } = mockRes()
    await (svc as any).handleRequest(req, res)

    assert.equal(cap.status, 200)
    const body = JSON.parse(cap.body)
    assert.equal(body.models.length, 2)
    assert.ok(body.models.some((m: any) => m.realm === 'LOCAL'))
    assert.ok(body.models.some((m: any) => m.realm === 'CLOUD'))
  })

  it('requires bearer auth — 401 without token', async () => {
    const svc = buildService()
    const req = mockReq('/v1/models')
    const { res, cap } = mockRes()
    await (svc as any).handleRequest(req, res)
    assert.equal(cap.status, 401)
  })
})
