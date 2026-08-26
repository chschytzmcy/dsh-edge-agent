/**
 * http-api sanitize-downgrade tests — verifies that when the sanitizer is
 * unavailable or throws for a CLOUD-bound request, the http-api downgrades
 * to LOCAL instead of sending raw (potentially PII-containing) text to the
 * cloud. Policy: "脱不了敏就不上云".
 *
 * Covers both /v1/chat and /v1/chat/stream endpoints.
 */
import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'

import { HttpApiServiceImpl } from '../../src/dsh-adapter/http-api.ts'

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
  process.nextTick(() => {
    ee.emit('data', payload)
    ee.emit('end')
  })
  return ee
}

function mockRes() {
  const cap: any = { status: 0, body: undefined, headers: {}, writes: [] as any[] }
  const res: any = {
    writeHead(status: number, headers?: any) {
      cap.status = status
      if (headers) cap.headers = headers
      return res
    },
    setHeader(k: string, v: string) { cap.headers[k] = v; return res },
    end(payload?: any) { cap.body = payload; return res },
    write(chunk: any) { cap.writes.push(chunk); return true },
    on(_event: string, _fn: any) { return res },
  }
  return { res, cap }
}

/** Build a cordisCtx shim with a real EventEmitter so session/event
 *  subscriptions work (handleChat awaits a turn/end event). */
function makeCordisCtx() {
  const ee = new EventEmitter()
  return {
    on: (event: string, listener: any) => {
      ee.on(event, listener)
      return () => ee.off(event, listener)
    },
    emit: (event: string, ...args: any[]) => ee.emit(event, ...args),
    reflect: { provide: () => () => {} },
    provide: () => () => {},
  }
}

describe('http-api sanitize-downgrade to LOCAL', () => {
  let audit: { entries: any[]; log: (e: any) => Promise<void> }
  let agentsCreateCalls: { provider?: string; model?: string }[]
  let ctx: ReturnType<typeof makeCordisCtx>

  beforeEach(() => {
    audit = { entries: [], log: async (e: any) => { audit.entries.push(e) } }
    agentsCreateCalls = []
    ctx = makeCordisCtx()
  })

  function buildService(opts: {
    intentCategory?: string
    sanitizer?: any
  }) {
    const { intentCategory = 'CLOUD', sanitizer } = opts
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
      {
        create: async ({ sessionId, agentOptions }: any) => {
          agentsCreateCalls.push({
            provider: agentOptions?.provider,
            model: agentOptions?.model,
          })
          const events: any[] = []
          const session = { id: sessionId, events }
          return {
            agent: {
              id: sessionId,
              session,
              followup: (_msg: any) => {
                const assistant = {
                  type: 'assistant/message',
                  data: { message: { content: [{ type: 'text', text: 'ok' }] } },
                }
                const turnEnd = { type: 'turn/end', data: { reason: { kind: 'completed' } } }
                process.nextTick(() => {
                  events.push(assistant)
                  events.push(turnEnd)
                  ctx.emit('session/event', session, assistant)
                  ctx.emit('session/event', session, turnEnd)
                })
              },
            },
            handle: { dispose: async () => {} },
          }
        },
      } as any,
      null,   // promptGuard
      audit,
      sanitizer,
      undefined,  // tdBus
    )
    ;(svc as any).intentRouter = {
      classify: async () => ({
        category: intentCategory,
        confidence: 0.9,
        targetRealm: intentCategory === 'LOCAL' ? 'local' : 'cloud',
        rationale: `llm-classified:${intentCategory.toLowerCase()}`,
      }),
    }
    return svc
  }

  // ── /v1/chat ────────────────────────────────────────────────────────────

  it('POST /v1/chat: downgrades to LOCAL when sanitizer is unavailable', async () => {
    const svc = buildService({ intentCategory: 'CLOUD', sanitizer: undefined })
    const req = mockReq({ message: 'hello' })
    const { res, cap } = mockRes()

    await (svc as any).handleRequest(req, res)

    assert.equal(cap.status, 200)
    const parsed = JSON.parse(cap.body)
    // Intent must be downgraded to LOCAL in the response
    assert.equal(parsed.intent.category, 'LOCAL')
    assert.equal(parsed.intent.targetRealm, 'local')
    assert.match(parsed.intent.rationale, /sanitized-fallback/u)
    // agents.create must be called with LOCAL provider
    assert.equal(agentsCreateCalls.length, 1)
    assert.equal(agentsCreateCalls[0].provider, 'local-qwen3-4b')
    // Audit: security-level sanitize-unavailable
    const unavail = audit.entries.find((e: any) => e.kind === 'http.chat.sanitize.unavailable')
    assert.ok(unavail, 'http.chat.sanitize.unavailable audit kind should be present')
    assert.equal(unavail.level, 'security')
    assert.equal(unavail.payload.originalIntent, 'CLOUD')
  })

  it('POST /v1/chat: downgrades to LOCAL when sanitizer throws', async () => {
    const svc = buildService({
      intentCategory: 'CLOUD',
      sanitizer: { sanitize: async () => { throw new Error('sanitize-boom') } },
    })
    const req = mockReq({ message: 'hello' })
    const { res, cap } = mockRes()

    await (svc as any).handleRequest(req, res)

    assert.equal(cap.status, 200)
    const parsed = JSON.parse(cap.body)
    assert.equal(parsed.intent.category, 'LOCAL')
    assert.equal(parsed.intent.targetRealm, 'local')
    assert.match(parsed.intent.rationale, /sanitized-fallback/u)
    assert.equal(agentsCreateCalls[0].provider, 'local-qwen3-4b')
    // Audit: security-level sanitize.failed
    const failed = audit.entries.find((e: any) => e.kind === 'http.chat.sanitize.failed')
    assert.ok(failed, 'http.chat.sanitize.failed audit kind should be present')
    assert.equal(failed.level, 'security')
    assert.match(failed.payload.error, /sanitize-boom/u)
  })

  it('POST /v1/chat: does NOT downgrade when sanitizer works', async () => {
    const svc = buildService({
      intentCategory: 'CLOUD',
      sanitizer: {
        sanitize: async (t: string) => ({ sanitizedText: t, replacements: [] }),
        desanitize: async (t: string) => t,
      },
    })
    const req = mockReq({ message: 'hello' })
    const { res, cap } = mockRes()

    await (svc as any).handleRequest(req, res)

    assert.equal(cap.status, 200)
    const parsed = JSON.parse(cap.body)
    // Intent must remain CLOUD
    assert.equal(parsed.intent.category, 'CLOUD')
    assert.equal(parsed.intent.targetRealm, 'cloud')
    // agents.create must use cloud provider
    assert.equal(agentsCreateCalls[0].provider, 'cloud-deepseek-v4')
    // No downgrade audit
    const unavail = audit.entries.find((e: any) => e.kind === 'http.chat.sanitize.unavailable')
    assert.equal(unavail, undefined)
  })

  it('POST /v1/chat: LOCAL intent bypasses sanitization entirely', async () => {
    let sanitizeCalled = false
    const svc = buildService({
      intentCategory: 'LOCAL',
      sanitizer: {
        sanitize: async () => { sanitizeCalled = true; return { sanitizedText: '', replacements: [] } },
      },
    })
    const req = mockReq({ message: 'read file' })
    const { res, cap } = mockRes()

    await (svc as any).handleRequest(req, res)

    assert.equal(cap.status, 200)
    assert.equal(sanitizeCalled, false, 'sanitizer must NOT be called for LOCAL intent')
    const parsed = JSON.parse(cap.body)
    assert.equal(parsed.intent.category, 'LOCAL')
    assert.equal(agentsCreateCalls[0].provider, 'local-qwen3-4b')
  })

  // ── /v1/chat/stream ─────────────────────────────────────────────────────

  it('POST /v1/chat/stream: downgrades to LOCAL when sanitizer is unavailable', async () => {
    const svc = buildService({ intentCategory: 'CLOUD', sanitizer: undefined })
    const req = mockReq({ message: 'hello' }, '/v1/chat/stream')
    const { res, cap } = mockRes()

    await (svc as any).handleRequest(req, res)

    // The SSE response writes intent + done events via res.write
    const intentWrite = cap.writes.find((w: string) => w.includes('"type":"intent"'))
    assert.ok(intentWrite, 'SSE intent event should be present')
    const intentPayload = JSON.parse(intentWrite.replace(/^data: /, '').trim())
    assert.equal(intentPayload.intent.category, 'LOCAL')
    assert.equal(intentPayload.intent.targetRealm, 'local')
    assert.match(intentPayload.intent.rationale, /sanitized-fallback/u)
    // agents.create must use LOCAL provider
    assert.equal(agentsCreateCalls[0].provider, 'local-qwen3-4b')
    // Audit: security-level
    const unavail = audit.entries.find((e: any) => e.kind === 'http.chat.stream.sanitize.unavailable')
    assert.ok(unavail, 'http.chat.stream.sanitize.unavailable audit kind should be present')
    assert.equal(unavail.level, 'security')
  })

  it('POST /v1/chat/stream: downgrades to LOCAL when sanitizer throws', async () => {
    const svc = buildService({
      intentCategory: 'CLOUD',
      sanitizer: { sanitize: async () => { throw new Error('stream-boom') } },
    })
    const req = mockReq({ message: 'hello' }, '/v1/chat/stream')
    const { res, cap } = mockRes()

    await (svc as any).handleRequest(req, res)

    const intentWrite = cap.writes.find((w: string) => w.includes('"type":"intent"'))
    assert.ok(intentWrite)
    const intentPayload = JSON.parse(intentWrite.replace(/^data: /, '').trim())
    assert.equal(intentPayload.intent.category, 'LOCAL')
    assert.match(intentPayload.intent.rationale, /sanitized-fallback/u)
    assert.equal(agentsCreateCalls[0].provider, 'local-qwen3-4b')
    const failed = audit.entries.find((e: any) => e.kind === 'http.chat.stream.sanitize.failed')
    assert.ok(failed)
    assert.equal(failed.level, 'security')
    assert.match(failed.payload.error, /stream-boom/u)
  })
})
