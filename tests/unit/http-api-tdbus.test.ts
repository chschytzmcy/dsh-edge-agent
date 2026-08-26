/**
 * http-api td-bus threat-gate tests — verifies that the Phase D
 * threat short-circuit covers BOTH the /v1/chat and /v1/chat/stream
 * endpoints. Previously only /v1/chat was wired (see docs §4 follow-up
 * #4: "/v1/chat/stream 入口尚未接入 td-bus 短路"), which let SSE
 * clients bypass the elevated-rate HTTP 503 entirely.
 */
import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'

import { HttpApiServiceImpl } from '../../src/dsh-adapter/http-api.ts'

/** Mock IncomingMessage that pre-emits body on nextTick. */
function mockReq(body: any, urlPath: string): any {
  const ee = new EventEmitter()
  ;(ee as any).method = 'POST'
  ;(ee as any).url = urlPath
  ;(ee as any).headers = {
    host: 'localhost',
    authorization: 'Bearer test-token',
    'content-type': 'application/json',
  }
  process.nextTick(() => {
    ee.emit('data', JSON.stringify(body))
    ee.emit('end')
  })
  return ee
}

/** Mock ServerResponse. */
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

/** Programmable tdBus mock. */
interface TdBusMock {
  block: boolean
  threat: 'normal' | 'elevated' | 'high' | 'critical'
  recordCalls: number
  /** If set, recordCloudRequest() throws to simulate fault-tolerance test. */
  recordThrows: boolean
  impl: {
    recordCloudRequest: () => void
    shouldBlock: () => boolean
    getThreatLevel: () => string
  }
}

function makeTdBus(initial: Partial<TdBusMock> = {}): TdBusMock {
  const mock: TdBusMock = {
    block: false,
    threat: 'critical',
    recordCalls: 0,
    recordThrows: false,
    ...initial,
    impl: undefined as any,
  }
  mock.impl = {
    recordCloudRequest: () => {
      mock.recordCalls++
      if (mock.recordThrows) throw new Error('td-bus fault')
    },
    shouldBlock: () => mock.block,
    getThreatLevel: () => mock.threat,
  }
  return mock
}

/** Stub agents.create — emits turn/end via ctx so http-api's session/event
 *  listener fires and the request resolves. */
function makeStubAgents(ctx: any) {
  const events: any[] = []
  return {
    agents: {
      create: async ({ sessionId }: any) => {
        const session = { id: sessionId, events }
        const agent = {
          session,
          followup: () => {
            setImmediate(() => {
              events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'x' }] } } })
              events.push({ type: 'turn/end', data: {} })
              ctx.emit('session/event', session, events[events.length - 2])
              ctx.emit('session/event', session, events[events.length - 1])
            })
          },
        }
        return { agent, handle: { dispose: async () => {} } }
      },
    },
  }
}

/** Build a Cordis-like context with on/emit/reflect/provide so Service
 *  base-class ctor succeeds. */
function makeCtx() {
  const ee = new EventEmitter()
  return {
    on: (e: string, fn: any) => { ee.on(e, fn); return () => ee.off(e, fn) },
    emit: (e: string, ...args: any[]) => ee.emit(e, ...args),
    reflect: { provide: () => () => {} },
    provide: () => () => {},
  }
}

describe('http-api td-bus threat gate', () => {
  let audit: { entries: any[]; log: (e: any) => Promise<void> }
  let tdBus: TdBusMock
  let agents: ReturnType<typeof makeStubAgents>['agents']
  let intentRouter: any
  let classifyCalls: number
  let ctx: any

  beforeEach(() => {
    audit = { entries: [], log: async (e: any) => { audit.entries.push(e) } }
    tdBus = makeTdBus()
    ctx = makeCtx()
    agents = makeStubAgents(ctx).agents
    classifyCalls = 0
    intentRouter = {
      classify: async () => {
        classifyCalls++
        return { category: 'CLOUD', confidence: 0.9, targetRealm: 'cloud', rationale: 'test' }
      },
    }
  })

  function buildService(): HttpApiServiceImpl {
    const svc = new HttpApiServiceImpl(
      ctx as any,
      {
        host: '127.0.0.1',
        port: 0,
        bearerToken: 'test-token',
        sessionIdleTimeoutMs: 0,
        maxActiveSessions: 100,
        requireAttestation: false,
      } as any,
      agents as any,
      null,         // promptGuard — disabled to isolate td-bus
      audit,
      null,         // sanitizer
      tdBus.impl,   // ← td-bus wired in
    )
    ;(svc as any).intentRouter = intentRouter
    return svc
  }

  it('/v1/chat returns 503 when td-bus.shouldBlock() === true', async () => {
    tdBus.block = true
    tdBus.threat = 'critical'
    const svc = buildService()
    const { res, cap } = mockRes()
    await (svc as any).handleRequest(mockReq({ message: 'hi' }, '/v1/chat'), res)

    assert.equal(cap.status, 503)
    assert.equal(tdBus.recordCalls, 1, 'recordCloudRequest must fire once')
    assert.equal(classifyCalls, 0, 'classify() must NOT run when blocked')
    // Audit kind: http.chat.threat-blocked at security level
    const blocked = audit.entries.find((e: any) => e.kind === 'http.chat.threat-blocked')
    assert.ok(blocked, 'expected http.chat.threat-blocked audit entry')
    assert.equal(blocked.level, 'security')
    assert.equal(blocked.payload.endpoint, '/v1/chat')
    assert.equal(blocked.payload.threat, 'critical')
  })

  it('/v1/chat/stream returns 503 when td-bus.shouldBlock() === true (Phase D completion)', async () => {
    tdBus.block = true
    tdBus.threat = 'high'
    const svc = buildService()
    const { res, cap } = mockRes()
    await (svc as any).handleRequest(mockReq({ message: 'hi' }, '/v1/chat/stream'), res)

    assert.equal(cap.status, 503, 'SSE endpoint must also short-circuit on threat')
    assert.equal(tdBus.recordCalls, 1, 'recordCloudRequest must fire once for stream too')
    assert.equal(classifyCalls, 0, 'classify() must NOT run when stream is blocked')
    const blocked = audit.entries.find((e: any) => e.kind === 'http.chat.threat-blocked')
    assert.ok(blocked, 'expected http.chat.threat-blocked audit entry')
    assert.equal(blocked.payload.endpoint, '/v1/chat/stream')
    assert.equal(blocked.payload.threat, 'high')
  })

  it('normal traffic flows through both endpoints when td-bus does not block', async () => {
    tdBus.block = false
    const svc = buildService()
    // /v1/chat
    await (svc as any).handleRequest(mockReq({ message: 'hi', sessionId: 'A' }, '/v1/chat'), mockRes().res)
    // /v1/chat/stream
    await (svc as any).handleRequest(mockReq({ message: 'hi', sessionId: 'B' }, '/v1/chat/stream'), mockRes().res)
    assert.equal(tdBus.recordCalls, 2, 'recordCloudRequest must fire once per request across both endpoints')
    assert.equal(classifyCalls, 2, 'classify() must run for both requests')
  })

  it('td-bus.recordCloudRequest() throwing does NOT block the request (fail-open)', async () => {
    tdBus.recordThrows = true
    tdBus.block = false
    const svc = buildService()
    const { res, cap } = mockRes()
    await (svc as any).handleRequest(mockReq({ message: 'hi' }, '/v1/chat/stream'), res)

    // Request still flows through (td-bus faults are swallowed silently)
    assert.notEqual(cap.status, 503, 'td-bus fault must not surface as 503')
    assert.equal(classifyCalls, 1, 'classify() should still run despite td-bus throwing')
  })

  it('td-bus missing entirely is also a no-op (soft dep)', async () => {
    // Build without tdBus
    const svc = new HttpApiServiceImpl(
      ctx as any,
      { bearerToken: 'test-token', sessionIdleTimeoutMs: 0, maxActiveSessions: 100, requireAttestation: false } as any,
      agents as any,
      null,
      audit,
      null,
      undefined,  // no tdBus
    )
    ;(svc as any).intentRouter = intentRouter
    const { res, cap } = mockRes()
    await (svc as any).handleRequest(mockReq({ message: 'hi' }, '/v1/chat/stream'), res)
    assert.equal(classifyCalls, 1, 'classify() must run when tdBus is absent')
    assert.notEqual(cap.status, 503)
  })
})