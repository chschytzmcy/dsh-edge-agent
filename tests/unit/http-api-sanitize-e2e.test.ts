/**
 * End-to-end sanitization flow tests — verifies that PII replacement,
 * session mapping, desanitization, and cross-turn persistence all work
 * together correctly through the full http-api → sanitizer → agent →
 * desanitize pipeline.
 *
 * These complement `http-api-sanitize-downgrade.test.ts` (which tests the
 * fail-closed downgrade path) by exercising the HAPPY PATH with real PII
 * patterns and verifying the full round-trip.
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

/**
 * Fake sanitizer with realistic PII patterns and per-session mapping.
 * Mirrors the shape of sanitizer-pipeline's real output.
 */
function makeFakeSanitizer() {
  // session -> Map<original, placeholder>
  const mappings = new Map<string, Map<string, string>>()
  const counters = { sanitize: 0, desanitize: 0 }
  const calls: { method: 'sanitize' | 'desanitize'; text: string; sessionId?: string }[] = []

  function ensureSession(sessionId: string): Map<string, string> {
    let m = mappings.get(sessionId)
    if (!m) {
      m = new Map()
      mappings.set(sessionId, m)
    }
    return m
  }

  function placeholderFor(sessionId: string, original: string, piiType: string): string {
    const m = ensureSession(sessionId)
    const existing = m.get(original)
    if (existing) return existing
    // Count how many of this type already exist in this session
    const count = Array.from(m.values()).filter((v) => v.startsWith(`[${piiType.toUpperCase()}_`)).length + 1
    const ph = `[${piiType.toUpperCase()}_${count}]`
    m.set(original, ph)
    return ph
  }

  const sanitizer = {
    calls,
    mappings,
    counters,
    async sanitize(text: string, ctx?: { sessionId?: string }) {
      counters.sanitize++
      const sid = ctx?.sessionId ?? 'default'
      calls.push({ method: 'sanitize', text, sessionId: sid })
      let out = text
      const replacements: { original: string; placeholder: string; piiType: string }[] = []
      // Phone pattern
      const phoneRe = /(1[3-9]\d{9})/gu
      for (const m of text.matchAll(phoneRe)) {
        const ph = placeholderFor(sid, m[1], 'phone')
        out = out.replace(m[1], ph)
        replacements.push({ original: m[1], placeholder: ph, piiType: 'phone' })
      }
      // Email pattern
      const emailRe = /([\w.-]+@[\w.-]+\.\w+)/gu
      for (const m of text.matchAll(emailRe)) {
        const ph = placeholderFor(sid, m[1], 'email')
        out = out.replace(m[1], ph)
        replacements.push({ original: m[1], placeholder: ph, piiType: 'email' })
      }
      return { sanitizedText: out, replacements }
    },
    async desanitize(text: string, sessionId?: string) {
      counters.desanitize++
      const sid = sessionId ?? 'default'
      calls.push({ method: 'desanitize', text, sessionId: sid })
      const m = mappings.get(sid)
      if (!m) return text
      let out = text
      for (const [original, placeholder] of m) {
        out = out.split(placeholder).join(original)
      }
      return out
    },
    desanitizeSync(text: string, sessionId?: string) {
      const sid = sessionId ?? 'default'
      const m = mappings.get(sid)
      if (!m) return text
      let out = text
      for (const [original, placeholder] of m) {
        out = out.split(placeholder).join(original)
      }
      return out
    },
    purge(sessionId: string) {
      mappings.delete(sessionId)
    },
  }
  return sanitizer
}

describe('http-api E2E sanitization flow', () => {
  let audit: { entries: any[]; log: (e: any) => Promise<void> }
  let ctx: ReturnType<typeof makeCordisCtx>

  beforeEach(() => {
    audit = { entries: [], log: async (e: any) => { audit.entries.push(e) } }
    ctx = makeCordisCtx()
  })

  /**
   * Build the service with a fake agents.create that echoes back a response
   * containing (or not containing) sanitizer placeholders. The `agentReply`
   * is what the cloud LLM would send back — typically with [PHONE_1] etc.
   */
  function buildService(opts: {
    intentCategory?: string
    sanitizer?: any
    agentReply?: string
  }) {
    const { intentCategory = 'CLOUD', sanitizer, agentReply = 'ok' } = opts
    const createCalls: { provider?: string; model?: string; messages: any[] }[] = []
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
          createCalls.push({
            provider: agentOptions?.provider,
            model: agentOptions?.model,
            messages: [],
          })
          const events: any[] = []
          const session = { id: sessionId, events }
          return {
            agent: {
              id: sessionId,
              session,
              followup: (msg: any) => {
                createCalls[createCalls.length - 1].messages.push(msg)
                const assistant = {
                  type: 'assistant/message',
                  data: { message: { content: [{ type: 'text', text: agentReply }] } },
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
        dataLevel: 'public',
        requiresSanitization: intentCategory === 'SANITIZED',
      }),
    }
    return { svc, createCalls }
  }

  // ── E2E PII round-trip ────────────────────────────────────────────────────

  it('replaces phone PII before agent and restores in response', async () => {
    const sanitizer = makeFakeSanitizer()
    const { svc, createCalls } = buildService({
      intentCategory: 'CLOUD',
      sanitizer,
      agentReply: '您的手机号是[PHONE_1]',
    })
    const req = mockReq({ message: '我的手机号是13812345678' })
    const { res, cap } = mockRes()

    await (svc as any).handleRequest(req, res)

    assert.equal(cap.status, 200)
    // Agent received SANITIZED text (phone replaced with placeholder)
    assert.equal(createCalls.length, 1)
    const sentText = createCalls[0].messages[0].content[0].text
    assert.equal(sentText, '我的手机号是[PHONE_1]')
    assert.ok(!sentText.includes('13812345678'), 'raw phone must not reach agent')
    // Response was desanitized — user sees original phone back
    const parsed = JSON.parse(cap.body)
    assert.equal(parsed.result, '您的手机号是13812345678')
    // Sanitizer was called for both directions
    assert.equal(sanitizer.counters.sanitize, 1)
    assert.equal(sanitizer.counters.desanitize, 1)
  })

  it('handles multiple PII types in one message (phone + email)', async () => {
    const sanitizer = makeFakeSanitizer()
    const { svc, createCalls } = buildService({
      intentCategory: 'CLOUD',
      sanitizer,
      agentReply: '手机号[PHONE_1]，邮箱[EMAIL_1]',
    })
    const req = mockReq({ message: '手机13812345678邮箱test@example.com' })
    const { res, cap } = mockRes()

    await (svc as any).handleRequest(req, res)

    const sentText = createCalls[0].messages[0].content[0].text
    assert.equal(sentText, '手机[PHONE_1]邮箱[EMAIL_1]')
    const parsed = JSON.parse(cap.body)
    assert.equal(parsed.result, '手机号13812345678，邮箱test@example.com')
    // Both replacements tracked
    assert.equal(sanitizer.calls[0].method, 'sanitize')
    // (replacements count is 2, but we don't expose it here — just verify
    // the round-trip is correct)
  })

  it('deduplicates same PII value within a session', async () => {
    const sanitizer = makeFakeSanitizer()
    const { svc, createCalls } = buildService({
      intentCategory: 'CLOUD',
      sanitizer,
      agentReply: '[PHONE_1]和[PHONE_1]相同',
    })
    const req = mockReq({ message: '13812345678和13812345678' })
    const { res, cap } = mockRes()

    await (svc as any).handleRequest(req, res)

    const sentText = createCalls[0].messages[0].content[0].text
    assert.equal(sentText, '[PHONE_1]和[PHONE_1]')
    const parsed = JSON.parse(cap.body)
    assert.equal(parsed.result, '13812345678和13812345678相同')
  })

  // ── No-PII case ───────────────────────────────────────────────────────────

  it('no PII → sanitizer called but desanitize skipped (no-op)', async () => {
    const sanitizer = makeFakeSanitizer()
    const { svc, createCalls } = buildService({
      intentCategory: 'CLOUD',
      sanitizer,
      agentReply: 'Hello world',
    })
    const req = mockReq({ message: '今天天气怎么样' })
    const { res, cap } = mockRes()

    await (svc as any).handleRequest(req, res)

    const sentText = createCalls[0].messages[0].content[0].text
    assert.equal(sentText, '今天天气怎么样')
    // Sanitizer called but no replacements
    assert.equal(sanitizer.counters.sanitize, 1)
    // Desanitize SKIPPED because sanitizationInfo is undefined (0 replacements)
    assert.equal(sanitizer.counters.desanitize, 0)
    const parsed = JSON.parse(cap.body)
    assert.equal(parsed.result, 'Hello world')
    // http.chat.sanitized audit should NOT fire (0 replacements)
    const sanitizedEntry = audit.entries.find((e: any) => e.kind === 'http.chat.sanitized')
    assert.equal(sanitizedEntry, undefined)
  })

  // ── LOCAL bypass ──────────────────────────────────────────────────────────

  it('LOCAL intent: sanitizer NOT called, PII passes through raw', async () => {
    const sanitizer = makeFakeSanitizer()
    const { svc, createCalls } = buildService({
      intentCategory: 'LOCAL',
      sanitizer,
      agentReply: '好的，本地文件已读取',
    })
    const req = mockReq({ message: '读取本地文件，里面写着13812345678' })
    const { res, cap } = mockRes()

    await (svc as any).handleRequest(req, res)

    // Agent received RAW text (no sanitization)
    const sentText = createCalls[0].messages[0].content[0].text
    assert.equal(sentText, '读取本地文件，里面写着13812345678')
    assert.equal(sanitizer.counters.sanitize, 0, 'sanitizer must NOT be called for LOCAL')
    assert.equal(sanitizer.counters.desanitize, 0)
  })

  // ── SANITIZED intent ──────────────────────────────────────────────────────

  it('SANITIZED intent: still triggers sanitization (same as CLOUD)', async () => {
    const sanitizer = makeFakeSanitizer()
    const { svc, createCalls } = buildService({
      intentCategory: 'SANITIZED',
      sanitizer,
      agentReply: '您的号码是[PHONE_1]',
    })
    const req = mockReq({ message: '手机号13812345678' })
    const { res, cap } = mockRes()

    await (svc as any).handleRequest(req, res)

    // SANITIZED intent triggers sanitization (isLocal = false)
    const sentText = createCalls[0].messages[0].content[0].text
    assert.equal(sentText, '手机号[PHONE_1]')
    assert.equal(sanitizer.counters.sanitize, 1)
    assert.equal(sanitizer.counters.desanitize, 1)
    const parsed = JSON.parse(cap.body)
    assert.equal(parsed.result, '您的号码是13812345678')
  })

  // ── Desanitize error handling ─────────────────────────────────────────────

  it('desanitize throws → error audited, response kept as-is (no crash)', async () => {
    const sanitizer = makeFakeSanitizer()
    // Override desanitize to throw
    sanitizer.desanitize = async () => { throw new Error('desanitize-boom') }
    const { svc } = buildService({
      intentCategory: 'CLOUD',
      sanitizer,
      agentReply: '您的手机号是[PHONE_1]',
    })
    const req = mockReq({ message: '手机号13812345678' })
    const { res, cap } = mockRes()

    await (svc as any).handleRequest(req, res)

    assert.equal(cap.status, 200)
    const parsed = JSON.parse(cap.body)
    // Response kept as-is (placeholder not restored)
    assert.equal(parsed.result, '您的手机号是[PHONE_1]')
    // Error audited
    const errEntry = audit.entries.find((e: any) => e.kind === 'http.chat.desanitize.error')
    assert.ok(errEntry, 'http.chat.desanitize.error audit should be present')
    assert.match(errEntry.payload.error, /desanitize-boom/u)
  })

  // ── Stream endpoint symmetry ──────────────────────────────────────────────

  it('POST /v1/chat/stream: PII round-trip matches /v1/chat', async () => {
    const sanitizer = makeFakeSanitizer()
    const createCalls2: any[] = []
    const svc2 = new HttpApiServiceImpl(
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
          createCalls2.push({ provider: agentOptions?.provider, model: agentOptions?.model, messages: [] })
          const events: any[] = []
          const session = { id: sessionId, events }
          return {
            agent: {
              id: sessionId,
              session,
              followup: (msg: any) => {
                createCalls2[createCalls2.length - 1].messages.push(msg)
                // Emit chunk events (stream endpoint listens for these)
                const chunk1 = { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: '号码[PHONE_1]' } } }
                const chunk2 = { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: '已记录' } } }
                // Also emit assistant/message so session.events has it (for multi-turn buffer)
                const assistant = { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '号码[PHONE_1]已记录' }] } } }
                const turnEnd = { type: 'turn/end', data: { reason: { kind: 'completed' } } }
                process.nextTick(() => {
                  events.push(chunk1, chunk2, assistant, turnEnd)
                  ctx.emit('session/event', session, chunk1)
                  ctx.emit('session/event', session, chunk2)
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
    ;(svc2 as any).intentRouter = {
      classify: async () => ({
        category: 'CLOUD',
        confidence: 0.9,
        targetRealm: 'cloud',
        rationale: 'llm-classified:cloud',
        dataLevel: 'public',
        requiresSanitization: false,
      }),
    }

    const req = mockReq({ message: '手机号13812345678' }, '/v1/chat/stream')
    const { res, cap } = mockRes()

    await (svc2 as any).handleRequest(req, res)
    // handleChatStream is fire-and-forget — wait for async chunk events
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    // Agent received sanitized text
    assert.equal(createCalls2.length, 1)
    const sentText = createCalls2[0].messages[0].content[0].text
    assert.equal(sentText, '手机号[PHONE_1]')
    // SSE text events contain desanitized chunks
    const textWrites = cap.writes.filter((w: string) => w.includes('"type":"text"'))
    assert.ok(textWrites.length >= 2, `expected >=2 text events, got ${textWrites.length}`)
    // First chunk: '号码[PHONE_1]' → desanitized to '号码13812345678'
    const chunk1 = JSON.parse(textWrites[0].replace(/^data: /, '').trim())
    assert.equal(chunk1.text, '号码13812345678')
    // Second chunk: '已记录' → unchanged
    const chunk2 = JSON.parse(textWrites[1].replace(/^data: /, '').trim())
    assert.equal(chunk2.text, '已记录')
    // Done event should also be present
    const doneWrite = cap.writes.find((w: string) => w.includes('"type":"done"'))
    assert.ok(doneWrite, 'SSE done event should be present')
  })

  // ── Audit events ──────────────────────────────────────────────────────────

  it('audit: http.chat.sanitized fires only when replacements > 0', async () => {
    const sanitizer = makeFakeSanitizer()
    // Case 1: with PII → audit fires
    const { svc: svc1 } = buildService({
      intentCategory: 'CLOUD',
      sanitizer,
      agentReply: '[PHONE_1]',
    })
    const req1 = mockReq({ message: '手机号13812345678' })
    const { res: res1 } = mockRes()
    await (svc1 as any).handleRequest(req1, res1)
    const sEntry1 = audit.entries.find((e: any) => e.kind === 'http.chat.sanitized')
    assert.ok(sEntry1, 'http.chat.sanitized should fire when replacements > 0')
    assert.equal(sEntry1.payload.replacementCount, 1)

    // Case 2: no PII → audit does NOT fire
    audit.entries.length = 0
    const sanitizer2 = makeFakeSanitizer()
    const { svc: svc2 } = buildService({
      intentCategory: 'CLOUD',
      sanitizer: sanitizer2,
      agentReply: 'hello',
    })
    const req2 = mockReq({ message: 'hi' })
    const { res: res2 } = mockRes()
    await (svc2 as any).handleRequest(req2, res2)
    const sEntry2 = audit.entries.find((e: any) => e.kind === 'http.chat.sanitized')
    assert.equal(sEntry2, undefined, 'http.chat.sanitized should NOT fire when no replacements')
  })

  // ── Audit preview redaction (defense-in-depth 2026-08-24) ─────────────────
  // http.chat.start used to log the first 80 chars of raw user input.
  // Now messagePreview goes through redactString from pii-utils.

  it('audit: http.chat.start preview is redacted (no raw PII in audit)', async () => {
    const sanitizer = makeFakeSanitizer()
    const { svc } = buildService({
      intentCategory: 'CLOUD',
      sanitizer,
      agentReply: 'ok',
    })
    const req = mockReq({ message: '手机号13812345678请帮我查' })
    const { res } = mockRes()

    await (svc as any).handleRequest(req, res)

    const startEntry = audit.entries.find((e: any) => e.kind === 'http.chat.start')
    assert.ok(startEntry, 'http.chat.start audit should fire')
    // Preview must NOT contain the raw phone number
    assert.doesNotMatch(startEntry.payload.messagePreview, /13812345678/u,
      'messagePreview must not contain raw PII')
    // Preview should contain the redacted form
    assert.match(startEntry.payload.messagePreview, /\*{4,}/u,
      'pii-utils masks PII with asterisks (e.g. 138****5678)')
  })
})
