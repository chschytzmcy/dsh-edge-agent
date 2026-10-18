/**
 * §7.100 http-api upstream-error surfacing — adapter failures reach the
 * dsh-llm runtime as a terminal error FINISH chunk (never a throw), which
 * historically surfaced as HTTP 200 + empty result (the §7.98 L2 family).
 * Now: non-stream chat → 502 JSON with machine-readable code;
 * stream → SSE error frame.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { EventEmitter } from 'node:events'

import { HttpApiServiceImpl } from '../../src/dsh-adapter/http-api.ts'

const CONFIG = {
  host: '127.0.0.1',
  port: 0,
  bearerToken: 'test-token',
  sessionIdleTimeoutMs: 0,
  maxActiveSessions: 100,
  maxRequestBodyBytes: 1024 * 1024,
} as any

function mockRes() {
  const cap: any = { status: 0, body: undefined, chunks: '' as string, headers: {} }
  const res: any = {
    writeHead(status: number, headers?: any) { cap.status = status; if (headers) cap.headers = headers; return res },
    setHeader(k: string, v: string) { cap.headers[k] = v; return res },
    end(payload?: any) { if (typeof payload === 'string') cap.body = payload; return res },
    write(chunk: any) { cap.chunks += String(chunk); return true },
    on(_event: string, _fn: any) { return res },
  }
  return { res, cap }
}

function mockPostReq(urlPath: string, bodyObj: unknown, headers: Record<string, string> = {}): any {
  const ee: any = new EventEmitter()
  ee.method = 'POST'
  ee.url = urlPath
  ee.headers = { host: 'localhost', 'content-type': 'application/json', ...headers }
  setImmediate(() => {
    ee.emit('data', Buffer.from(JSON.stringify(bodyObj)))
    ee.emit('end')
  })
  return ee
}

/**
 * Fake cordis ctx + agents: followup() fires a turn/end session event with
 * the given reason, then resolves whenIdle. session.events stays empty so
 * assembled text is '' — the exact shape of the old silent-empty failure.
 */
function buildService(reason: any) {
  const listeners: Array<(session: any, event: any) => void> = []
  const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
  const ctx: any = {
    reflect: { provide: () => {} },
    on(ev: string, cb: any) {
      if (ev === 'session/event') {
        listeners.push(cb)
        return () => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1) }
      }
      return () => {}
    },
    get() { throw new Error('not injected') }, // no intentRouter/modelRouter → documented fallbacks
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  }
  const agents = {
    create: async ({ sessionId }: { sessionId: string }) => {
      let resolveIdle!: () => void
      const idle = new Promise<void>((r) => { resolveIdle = r })
      return {
        agent: {
          id: sessionId,
          session: { id: sessionId, events: [] },
          followup: () => {
            setTimeout(() => {
              for (const l of [...listeners]) l({ id: sessionId }, { type: 'turn/end', data: { reason } })
              resolveIdle()
            }, 5)
          },
          whenIdle: () => idle,
        },
        handle: { dispose: async () => {} },
      }
    },
  }
  const svc = new HttpApiServiceImpl(ctx, CONFIG, agents as any, audit as any, undefined)
  return { svc, audit }
}

const ERR_REASON = {
  kind: 'error',
  error: { code: 'NO_CLOUD_TARGET', message: 'cloud-llm-adapter: no cloud provider available (delegate mode)' },
}

describe('§7.100 http-api upstream error surfacing', () => {
  it('POST /v1/chat: empty result + error turn-end → 502 JSON with code', async () => {
    const { svc, audit } = buildService(ERR_REASON)
    const req = mockPostReq('/v1/chat', { message: 'hi', sessionId: 'err-1' }, { authorization: 'Bearer test-token' })
    const { res, cap } = mockRes()
    await (svc as any).handleRequest(req, res)

    assert.equal(cap.status, 502)
    const body = JSON.parse(cap.body)
    assert.equal(body.code, 'NO_CLOUD_TARGET')
    assert.equal(body.result, '')
    assert.equal(body.error, 'upstream model call failed')
    assert.ok(audit.entries.some((e) => e.kind === 'http.chat.upstream_error' && e.payload.code === 'NO_CLOUD_TARGET'))
  })

  it('POST /v1/chat: normal completed turn still 200 (regression fence)', async () => {
    const { svc } = buildService({ kind: 'completed' })
    const req = mockPostReq('/v1/chat', { message: 'hi', sessionId: 'ok-1' }, { authorization: 'Bearer test-token' })
    const { res, cap } = mockRes()
    await (svc as any).handleRequest(req, res)
    // 空文本 + completed（无 error reason）→ 维持既有 200 语义，不误伤
    assert.equal(cap.status, 200)
  })

  it('POST /v1/chat/stream: error turn-end → SSE error frame, not done', async () => {
    const { svc } = buildService(ERR_REASON)
    const req = mockPostReq('/v1/chat/stream', { message: 'hi', sessionId: 'err-2' }, { authorization: 'Bearer test-token' })
    const { res, cap } = mockRes()
    await (svc as any).handleRequest(req, res)
    // stream 帧在 turn/end 异步到达后才写出（handleRequest 不 await 整个流）
    await new Promise((r) => setTimeout(r, 60))
    assert.match(cap.chunks, /"type":"error"/)
    assert.match(cap.chunks, /"code":"NO_CLOUD_TARGET"/)
    assert.doesNotMatch(cap.chunks, /"type":"done"/)
  })

  it('POST /v1/chat/stream: blocked keeps priority over error branch (400/403/503 translation intact)', async () => {
    const { svc } = buildService({ kind: 'blocked' })
    const req = mockPostReq('/v1/chat/stream', { message: 'hi', sessionId: 'err-3' }, { authorization: 'Bearer test-token' })
    const { res, cap } = mockRes()
    await (svc as any).handleRequest(req, res)
    await new Promise((r) => setTimeout(r, 60))
    // blocked 分支自己写 error 帧带 rejection 字段；不应混入 §7.100 的 code 字段
    assert.match(cap.chunks, /"rejection"/)
    assert.doesNotMatch(cap.chunks, /"code":"NO_CLOUD_TARGET"/)
  })
})
