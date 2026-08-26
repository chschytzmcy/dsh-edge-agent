/**
 * http-api multi-turn context tests — verifies that the per-session
 * `recentMessages` ring buffer is fed to `intentRouter.classify()` so the
 * router can disambiguate follow-up queries. Closes P1-#7 from the
 * `意图识别路由` alignment report (2026-08-24):
 *   - First request: `recentMessages` passed to classify() must be []
 *   - Second request: prior user + assistant pair must be present
 *   - Beyond cap (6 entries / 3 pairs): FIFO eviction
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { beforeEach, describe, it } from 'vitest'

import { HttpApiServiceImpl } from '../../src/dsh-adapter/http-api.ts'

/** Build a mock IncomingMessage that emits the given body on next tick. */
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

/** Capture writeHead / end calls. */
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

/** Capture classify() arguments across calls so we can assert what the
 *  router saw. */
function makeSpyIntentRouter(verdictCategory: string = 'CLOUD') {
  const calls: Array<{ text: string; recentMessages: any[]; sessionId: string }> = []
  const spy = {
    classify: async (text: string, ctx?: any) => {
      calls.push({ text, recentMessages: ctx?.recentMessages ?? [], sessionId: ctx?.sessionId })
      return {
        category: verdictCategory,
        confidence: 0.95,
        targetRealm: verdictCategory.toLowerCase(),
        rationale: `llm-classified:${verdictCategory.toLowerCase()}`,
      }
    },
  }
  return { spy, calls }
}

/** Build a cordisCtx shim that emits `session/event` to all subscribers.
 *  Tests inject event payloads via `ctx.emit(...)` from `agents.create`
 *  closure to drive the http-api subscription in handleChat / handleChatStream. */
function makeCordisCtx() {
  const ee = new EventEmitter()
  // Mirror the shape http-api expects: ctx.on('session/event', listener)
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

interface SessionFixture { agent: any; handle: any }

function buildService(opts: { spy: any; fixtureMap: Map<string, SessionFixture>; ctx: any }) {
  const { spy, fixtureMap, ctx } = opts
  const audit = { entries: [], log: async (e: any) => { audit.entries.push(e) } }

  // agents.create: produces a session whose followup() synchronously
  // schedules assistant/message + turn/end events.
  const agents = {
    create: async ({ sessionId }: any) => {
      const events: any[] = []
      const session = { id: sessionId, events }
      // followup lives on the agent, not the session (mirrors dsh-agent).
      const agent = {
        session,
        followup: (_msg: any) => {
          // Mirrors dsh-session: append assistant/message + turn/end.
          // Use process.nextTick so the events land in the current
          // microtask drain — BEFORE await turnEnd suspends. We need
          // the assistant entry visible to the next snapshot.
          const assistant = {
            type: 'assistant/message',
            data: { message: { content: [{ type: 'text', text: `reply-${sessionId}-${events.length}` }] } },
          }
          const turnEnd = { type: 'turn/end', data: { reason: { kind: 'completed' } } }
          process.nextTick(() => {
            events.push(assistant)
            events.push(turnEnd)
            ctx.emit('session/event', session, assistant)
            ctx.emit('session/event', session, turnEnd)
          })
        },
      }
      const fixture: SessionFixture = {
        agent,
        handle: { dispose: async () => {} },
      }
      fixtureMap.set(sessionId, fixture)
      return fixture
    },
  }

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
    null,  // promptGuard
    audit,
    null,  // sanitizer
    undefined, // tdBus
  )
  ;(svc as any).intentRouter = spy
  return { svc, audit }
}

describe('http-api multi-turn context (recentMessages ring buffer)', () => {
  let fixtureMap: Map<string, SessionFixture>

  beforeEach(() => {
    fixtureMap = new Map()
  })

  it('first request passes empty recentMessages[] to classify()', async () => {
    const ctx = makeCordisCtx()
    const { spy, calls } = makeSpyIntentRouter()
    const { svc } = buildService({ spy, fixtureMap, ctx })

    const req = mockReq({ message: 'hi there', sessionId: 's1' })
    const { res, cap } = mockRes()
    await (svc as any).handleRequest(req, res)

    assert.equal(cap.status, 200)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].text, 'hi there')
    assert.deepEqual(calls[0].recentMessages, [], 'first turn should see no prior context')
    assert.equal(calls[0].sessionId, 's1')
  })

  it('second request in same session passes prior user+assistant pair', async () => {
    const ctx = makeCordisCtx()
    const { spy, calls } = makeSpyIntentRouter()
    const { svc } = buildService({ spy, fixtureMap, ctx })

    // ── Turn 1 ────────────────────────────────────────────────
    await (svc as any).handleRequest(
      mockReq({ message: 'tell me a joke', sessionId: 'sess-A' }),
      mockRes().res,
    )
    // ── Turn 2 (same session) ─────────────────────────────────
    await (svc as any).handleRequest(
      mockReq({ message: 'one more', sessionId: 'sess-A' }),
      mockRes().res,
    )

    assert.equal(calls.length, 2)
    assert.deepEqual(calls[0].recentMessages, [])
    assert.equal(calls[1].recentMessages.length, 2,
      'second classify() should see [user-turn1, assistant-turn1]')
    assert.equal(calls[1].recentMessages[0].role, 'user')
    assert.equal(calls[1].recentMessages[0].text, 'tell me a joke')
    assert.equal(calls[1].recentMessages[1].role, 'assistant')
    assert.match(calls[1].recentMessages[1].text, /^reply-/)
  })

  it('current query is NOT duplicated into recentMessages (snapshot before push)', async () => {
    // Regression guard: the buffer snapshot taken BEFORE pushing the
    // current user message must exclude that message. Otherwise the
    // router embeds the current query twice in the prompt.
    const ctx = makeCordisCtx()
    const { spy, calls } = makeSpyIntentRouter()
    const { svc } = buildService({ spy, fixtureMap, ctx })

    await (svc as any).handleRequest(
      mockReq({ message: 'turn-one', sessionId: 'sess-B' }),
      mockRes().res,
    )

    assert.equal(calls.length, 1)
    assert.equal(calls[0].text, 'turn-one')
    // The text of the CURRENT query must not appear in the history block.
    for (const m of calls[0].recentMessages) {
      assert.notEqual(m.text, 'turn-one', 'current query leaked into history block')
    }
  })

  it('ring buffer caps at 6 entries; older turns are evicted FIFO', async () => {
    const ctx = makeCordisCtx()
    const { spy, calls } = makeSpyIntentRouter()
    const { svc } = buildService({ spy, fixtureMap, ctx })

    // Issue 5 turns (10 entries before eviction: user+assistant ×5).
    // 6th turn's snapshot should only contain the LAST 6 (3 user+assistant pairs).
    for (let i = 1; i <= 5; i++) {
      await (svc as any).handleRequest(
        mockReq({ message: `turn-${i}`, sessionId: 'sess-C' }),
        mockRes().res,
      )
    }

    assert.equal(calls.length, 5)
    // Turn 5's history snapshot must contain at most 6 entries.
    const snapshot = calls[4].recentMessages
    assert.ok(snapshot.length <= 6, `snapshot length=${snapshot.length} exceeds cap`)
    // And the oldest entries (turn-1 user) must have been evicted.
    const snapshotTexts = snapshot.map((m: any) => m.text)
    assert.ok(!snapshotTexts.includes('turn-1'),
      'turn-1 must be evicted by FIFO; got: ' + JSON.stringify(snapshotTexts))
    // The most recent prior turn (turn-4 assistant) should still be there.
    assert.ok(snapshotTexts.some((t: string) => /reply-/.test(t)))
  })

  it('different sessions have independent ring buffers', async () => {
    const ctx = makeCordisCtx()
    const { spy, calls } = makeSpyIntentRouter()
    const { svc } = buildService({ spy, fixtureMap, ctx })

    await (svc as any).handleRequest(
      mockReq({ message: 'session-1-only', sessionId: 'sess-X' }),
      mockRes().res,
    )
    await (svc as any).handleRequest(
      mockReq({ message: 'session-2-only', sessionId: 'sess-Y' }),
      mockRes().res,
    )
    await (svc as any).handleRequest(
      mockReq({ message: 'session-1-followup', sessionId: 'sess-X' }),
      mockRes().res,
    )

    // Find calls by sessionId (spy preserves insertion order).
    const xCalls = calls.filter(c => c.sessionId === 'sess-X')
    const yCalls = calls.filter(c => c.sessionId === 'sess-Y')

    assert.equal(xCalls.length, 2)
    assert.equal(yCalls.length, 1)

    // sess-X follow-up should see sess-X history
    assert.equal(xCalls[1].recentMessages.length, 2)
    assert.equal(xCalls[1].recentMessages[0].text, 'session-1-only')

    // sess-Y first turn sees nothing
    assert.deepEqual(yCalls[0].recentMessages, [])
  })

  it('truncates long message text to 200 chars before storing', async () => {
    const ctx = makeCordisCtx()
    const { spy, calls } = makeSpyIntentRouter()
    const { svc } = buildService({ spy, fixtureMap, ctx })

    const longText = 'a'.repeat(500)
    await (svc as any).handleRequest(
      mockReq({ message: longText, sessionId: 'sess-long' }),
      mockRes().res,
    )
    await (svc as any).handleRequest(
      mockReq({ message: 'next', sessionId: 'sess-long' }),
      mockRes().res,
    )

    const snapshot = calls[1].recentMessages
    assert.ok(snapshot.length > 0)
    assert.ok(snapshot[0].text.length <= 200,
      `text should be capped at 200 chars, got ${snapshot[0].text.length}`)
  })
})