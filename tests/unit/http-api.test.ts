/**
 * http-api plugin tests — end-to-end against the REAL `HttpApiServiceImpl`.
 *
 * §7.123 (2026-10-27): this file used to stand up its OWN
 * `createServer(...)` that "mimics http-api behavior" and assert against
 * that mock — 12 cases that could not fail when the production dispatcher
 * regressed. The suite now boots the production service on an ephemeral
 * port and drives it over real HTTP, so a broken route table / auth gate /
 * status code fails here.
 *
 * The ops-log assertions were source-text greps ("the file contains the
 * string `[http-api] chat received`"). They are now behavioural: the
 * logger output is captured and the emitted line is asserted — including
 * the PII-safety property that the raw message body never reaches the log.
 */
import { describe, it, expect, afterEach } from 'vitest'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { HttpApiServiceImpl, resolveRoute } from '../../src/dsh-adapter/http-api.ts'

/* ────────────────────────────────────────────────────────────────────────────
 * Fixtures
 * ──────────────────────────────────────────────────────────────────────────── */

interface Harness {
  svc: any
  base: string
  auditEntries: any[]
  logLines: string[]
  dispose: () => Promise<void>
}

/** Cordis-ish ctx: `on('session/event')` fan-out + logger capture. */
function makeCordisCtx(logLines: string[]) {
  const ee = new EventEmitter()
  return {
    on: (event: string, listener: any) => {
      ee.on(event, listener)
      return () => ee.off(event, listener)
    },
    emit: (event: string, ...args: any[]) => ee.emit(event, ...args),
    reflect: { provide: () => () => {} },
    provide: () => () => {},
    logger: {
      info: (line: string) => { logLines.push(line) },
      warn: (line: string) => { logLines.push(line) },
      error: (line: string) => { logLines.push(line) },
      debug: (line: string) => { logLines.push(line) },
    },
  }
}

/**
 * Boot the real service on an ephemeral port.
 *
 * `agents.create()` returns the AgentHandle itself (the production code
 * reads `handle.agent` and calls `handle.dispose()`), and `followup()`
 * schedules the assistant/message + turn/end session events that
 * handleChat awaits.
 */
async function boot(overrides: {
  intentCategory?: string
  bearerToken?: string
} = {}): Promise<Harness> {
  const logLines: string[] = []
  const auditEntries: any[] = []
  const ctx = makeCordisCtx(logLines)

  const agents = {
    create: async ({ sessionId }: any) => {
      const events: any[] = []
      const session = { id: sessionId, events }
      const agent = {
        session,
        followup: (_msg: any) => {
          const assistant = {
            type: 'assistant/message',
            data: { message: { content: [{ type: 'text', text: `reply-${sessionId}` }] } },
          }
          const turnEnd = { type: 'turn/end', data: { reason: { kind: 'completed' } } }
          process.nextTick(() => {
            events.push(assistant)
            events.push(turnEnd)
            ctx.emit('session/event', session, assistant)
            ctx.emit('session/event', session, turnEnd)
          })
        },
        whenIdle: () => new Promise<void>(resolve => setImmediate(resolve)),
      }
      return {
        agent,
        async dispose() {},
        async whenIdle() {},
      }
    },
  }

  const svc = new HttpApiServiceImpl(
    ctx as any,
    {
      host: '127.0.0.1',
      port: 0,
      bearerToken: overrides.bearerToken ?? 'test-token',
      sessionIdleTimeoutMs: 0,
      maxActiveSessions: 100,
      maxRequestBodyBytes: 1024 * 1024,
    } as any,
    agents as any,
    { entries: auditEntries, log: async (e: any) => { auditEntries.push(e) } } as any,
    undefined,
  )
  ;(svc as any).intentRouter = {
    classify: async () => ({
      category: overrides.intentCategory ?? 'CLOUD',
      confidence: 0.95,
      targetRealm: (overrides.intentCategory ?? 'CLOUD').toLowerCase(),
      rationale: 'test-classifier',
    }),
  }

  await svc.start()
  const address = (svc as any).server.address()
  const port = typeof address === 'object' && address ? address.port : 0

  return {
    svc,
    base: `http://127.0.0.1:${port}`,
    auditEntries,
    logLines,
    dispose: async () => { await svc.stop() },
  }
}

/** A harness that is torn down after each test. */
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!
    await fn()
  }
})

async function harness(overrides?: Parameters<typeof boot>[0]): Promise<Harness> {
  const h = await boot(overrides)
  cleanups.push(h.dispose)
  return h
}

function authHeader(token = 'test-token'): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

/* ────────────────────────────────────────────────────────────────────────────
 * 1. Route surface — driven over real HTTP against the production server
 * ──────────────────────────────────────────────────────────────────────────── */

describe('http-api plugin (real service, real HTTP)', () => {
  it('health endpoint is public (no auth required)', async () => {
    const h = await harness()
    const res = await fetch(`${h.base}/v1/health`)
    assert_status(res.status, 200)
    assert_body(res, { status: 'ok' })
  })

  it('HEAD /v1/health is also public (RFC 7231 §4.3.2: HEAD = GET, no body)', async () => {
    const h = await harness()
    const res = await fetch(`${h.base}/v1/health`, { method: 'HEAD' })
    assert_status(res.status, 200)
    assert.equal((await res.text()).length, 0, 'HEAD 不应返回 body')
  })

  it('openapi.json endpoint is public', async () => {
    const h = await harness()
    const res = await fetch(`${h.base}/v1/openapi.json`)
    assert_status(res.status, 200)
    const spec = await res.json() as any
    assert.equal(spec.openapi, '3.0.0')
  })

  it('rejects requests without auth token', async () => {
    const h = await harness()
    const res = await fetch(`${h.base}/v1/sessions`)
    assert_status(res.status, 401)
  })

  it('rejects requests with wrong auth token', async () => {
    const h = await harness()
    const res = await fetch(`${h.base}/v1/sessions`, { headers: authHeader('wrong') })
    assert_status(res.status, 401)
  })

  it('accepts requests with correct auth token', async () => {
    const h = await harness()
    const res = await fetch(`${h.base}/v1/sessions`, { headers: authHeader() })
    assert_status(res.status, 200)
  })

  it('lists sessions (empty initially)', async () => {
    const h = await harness()
    const res = await fetch(`${h.base}/v1/sessions`, { headers: authHeader() })
    const body = await res.json() as any
    assert.deepEqual(body.sessions, [])
  })

  it('POST /v1/chat creates a session and returns result', async () => {
    const h = await harness()
    const res = await fetch(`${h.base}/v1/chat`, {
      method: 'POST',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    })
    assert_status(res.status, 200)
    const body = await res.json() as any
    assert.ok(body.sessionId, '应返回 sessionId')
    assert.ok(body.result !== undefined, '应返回 result')
    assert.ok(body.intent, '应返回 intent 裁决')
  })

  it('POST /v1/chat reuses existing session when sessionId provided', async () => {
    const h = await harness()
    const post = (message: string, sessionId?: string) => fetch(`${h.base}/v1/chat`, {
      method: 'POST',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({ message, sessionId }),
    })
    const first = await (await post('one')).json() as any
    const second = await (await post('two', first.sessionId)).json() as any
    assert.equal(second.sessionId, first.sessionId)
  })

  it('POST /v1/chat rejects missing message', async () => {
    const h = await harness()
    const res = await fetch(`${h.base}/v1/chat`, {
      method: 'POST',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert_status(res.status, 400)
  })

  it('GET /v1/sessions/:id returns session details', async () => {
    const h = await harness()
    const created = await (await fetch(`${h.base}/v1/chat`, {
      method: 'POST',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    })).json() as any

    const res = await fetch(`${h.base}/v1/sessions/${created.sessionId}`, { headers: authHeader() })
    assert_status(res.status, 200)
    const body = await res.json() as any
    assert.equal(body.sessionId, created.sessionId)
    assert.ok(body.createdAt > 0)
  })

  it('GET /v1/sessions/:id returns 404 for unknown session', async () => {
    const h = await harness()
    const res = await fetch(`${h.base}/v1/sessions/does-not-exist`, { headers: authHeader() })
    assert_status(res.status, 404)
  })

  it('DELETE /v1/sessions/:id removes session', async () => {
    const h = await harness()
    const created = await (await fetch(`${h.base}/v1/chat`, {
      method: 'POST',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    })).json() as any

    const res = await fetch(`${h.base}/v1/sessions/${created.sessionId}`, {
      method: 'DELETE',
      headers: authHeader(),
    })
    assert_status(res.status, 204)

    const after = await fetch(`${h.base}/v1/sessions/${created.sessionId}`, { headers: authHeader() })
    assert_status(after.status, 404)
  })

  it('returns 404 for unknown routes', async () => {
    const h = await harness()
    const res = await fetch(`${h.base}/v1/nope`, { headers: authHeader() })
    assert_status(res.status, 404)
  })

  it('a malformed percent-escape in a path param does not take the process down (§7.123)', async () => {
    const h = await harness()
    // `%zz` is not a valid escape — decodeURIComponent would throw URIError.
    const res = await fetch(`${h.base}/v1/sessions/%zz`, { headers: authHeader() })
    // The request is answered (404 for the unknown id) instead of crashing.
    assert_status(res.status, 404)
    // The service is still alive afterwards.
    const health = await fetch(`${h.base}/v1/health`)
    assert_status(health.status, 200)
  })
})

function assert_status(actual: number, expected: number): void {
  expect(actual).toBe(expected)
}

function assert_body(res: Response, expected: Record<string, unknown>): void {
  return res.json().then((body: any) => {
    expect(body).toMatchObject(expected)
  }) as unknown as void
}

/* ────────────────────────────────────────────────────────────────────────────
 * 2. resolveRoute — the modelRouter wiring (unchanged; already real)
 * ──────────────────────────────────────────────────────────────────────────── */

describe('http-api resolveRoute (modelRouter wiring)', () => {
  const prevLocal = process.env.DSH_EDGE_LOCAL_LLM_MODEL
  const prevCloud = process.env.DSH_EDGE_MODEL

  afterEach(() => {
    if (prevLocal === undefined) delete process.env.DSH_EDGE_LOCAL_LLM_MODEL
    else process.env.DSH_EDGE_LOCAL_LLM_MODEL = prevLocal
    if (prevCloud === undefined) delete process.env.DSH_EDGE_MODEL
    else process.env.DSH_EDGE_MODEL = prevCloud
  })

  it('falls back to hardcoded local provider+model when modelRouter is absent', () => {
    delete process.env.DSH_EDGE_LOCAL_LLM_MODEL
    const r = resolveRoute({}, true)
    expect(r.resolved).toBe(false)
    expect(r.provider).toBe('local-llm')
    expect(r.model).toBe('qwen3-4b-instruct-2507')
  })

  it('falls back to hardcoded cloud provider+model when modelRouter is absent', () => {
    const r = resolveRoute({}, false)
    expect(r.resolved).toBe(false)
    expect(r.provider).toBe('cloud-llm')
    expect(r.model).toBe('deepseek-chat')
  })

  it('honors DSH_EDGE_LOCAL_LLM_MODEL env override on the local fallback path', () => {
    process.env.DSH_EDGE_LOCAL_LLM_MODEL = 'qwen3-4b-fine-tuned'
    const r = resolveRoute({}, true)
    expect(r.resolved).toBe(false)
    expect(r.model).toBe('qwen3-4b-fine-tuned')
  })

  it('§7.75: honors DSH_EDGE_MODEL env override on the cloud fallback path', () => {
    // §7.75 (2026-09-17): cloud fallback 链从硬编码 'deepseek-chat'
    // 改成读 DSH_EDGE_MODEL（.env CLOUD_LLM_MODEL 注入值）—— 改 .env
    // CLOUD_LLM_MODEL=deepseek-flash 后 model-router 走 fallback 时上行
    // model 也跟 flash 对齐，不再悄悄变 deepseek-chat
    process.env.DSH_EDGE_MODEL = 'deepseek-flash'
    const r = resolveRoute({}, false)
    expect(r.resolved).toBe(false)
    expect(r.provider).toBe('cloud-llm')
    expect(r.model).toBe('deepseek-flash')
  })

  it('uses modelRouter.resolve when present and returns the resolved route', () => {
    let calledWith: string | undefined
    const ctx = {
      modelRouter: {
        resolve: (preferred: string) => {
          calledWith = preferred
          return { realm: 'LOCAL', provider: 'local-llm-tuned', model: 'qwen3-4b-ft-2026-08' }
        },
      },
    }
    const r = resolveRoute(ctx, true)
    expect(calledWith).toBe('local-llm')
    expect(r.resolved).toBe(true)
    expect(r.provider).toBe('local-llm-tuned')
    expect(r.model).toBe('qwen3-4b-ft-2026-08')
  })

  it('falls back when modelRouter.resolve throws (defensive: never break the chat round-trip)', () => {
    const ctx = {
      modelRouter: {
        resolve: () => { throw new Error('router offline') },
      },
    }
    const r = resolveRoute(ctx, false)
    expect(r.resolved).toBe(false)
    expect(r.provider).toBe('cloud-llm')
    expect(r.model).toBe('deepseek-chat')
  })

  // ─── §7.192: 池没配 model ⇒ 取 DSH 配置的模型 ─────────────────────────────
  //
  // 没配置文件 ⇒ 池走 DELEGATE（§7.171）⇒ wire 上真正跑的是**宿主当前那个
  // 模型**（桌面 GUI 的模型选择器）。这时写死一个别的名字（老代码写的是
  // `qwen3-4b-instruct-2507`）= **面板显示一件没发生过的事**。
  const dshSelectionCtx = () => ({
    get(name: string) {
      if (name === 'llm') {
        return {
          listProviders: () => [{ id: 'qwen-token-plan-cn', name: 'qwen-token-plan-cn' }],
          listModels: async () => [],
        }
      }
      if (name === 'agentDefaultModel') {
        return {
          currentSelection: () => ({ provider: 'qwen-token-plan-cn', model: 'deepseek-v4.1-flash' }),
        }
      }
      return undefined
    },
  })

  it('§7.192: 本地池没配 model ⇒ 取 DSH 配置的模型（宿主当前选择），不是写死的名字', () => {
    delete process.env.DSH_EDGE_LOCAL_LLM_MODEL
    const r = resolveRoute(dshSelectionCtx(), true)
    expect(r.provider).toBe('local-llm')
    expect(r.model).toBe('deepseek-v4.1-flash')
  })

  it('§7.192: 本地池没配 model + modelRouter 回 provider id ⇒ 也用 DSH 配置的模型', () => {
    delete process.env.DSH_EDGE_LOCAL_LLM_MODEL
    const ctx = {
      ...dshSelectionCtx(),
      get(name: string) {
        if (name === 'modelRouter') {
          return { resolve: () => ({ realm: 'LOCAL', provider: 'local-llm', model: 'local-llm' }) }
        }
        return dshSelectionCtx().get(name)
      },
    }
    const r = resolveRoute(ctx, true)
    expect(r.resolved).toBe(true)
    expect(r.provider).toBe('local-llm')
    expect(r.model).toBe('deepseek-v4.1-flash')
  })

  it('§7.192: 云池没配 model ⇒ 同样取 DSH 配置的模型', () => {
    delete process.env.DSH_EDGE_MODEL
    const r = resolveRoute(dshSelectionCtx(), false)
    expect(r.provider).toBe('cloud-llm')
    expect(r.model).toBe('deepseek-v4.1-flash')
  })

  it('§7.192: 宿主解析不到任何落点 ⇒ 退回原硬编码兜底（不因此让请求失败）', () => {
    delete process.env.DSH_EDGE_LOCAL_LLM_MODEL
    const r = resolveRoute({}, true)
    expect(r.resolved).toBe(false)
    expect(r.provider).toBe('local-llm')
    expect(r.model).toBe('qwen3-4b-instruct-2507')
  })

  it('falls back when modelRouter.resolve returns a malformed shape', () => {
    const ctx = {
      modelRouter: {
        resolve: () => ({ provider: 123, model: null }), // wrong types
      },
    }
    const r = resolveRoute(ctx, true)
    expect(r.resolved).toBe(false)
    expect(r.provider).toBe('local-llm')
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * 3. §7.46.5 ops log — behavioural, not source-text greps
 * ──────────────────────────────────────────────────────────────────────────── */

describe('http-api §7.46.5 — chat received/reply ops log (captured logger output)', () => {
  const SECRET = 'my-phone-is-13800138000'

  async function chatAndCapture(message: string): Promise<string[]> {
    const h = await harness()
    await fetch(`${h.base}/v1/chat`, {
      method: 'POST',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
    })
    return h.logLines
  }

  it('emits a "chat received" line carrying messageLen (not the body)', async () => {
    const lines = await chatAndCapture(SECRET)
    const received = lines.find((l) => l.includes('[http-api] chat received'))
    expect(received, '应落一行 chat received').toBeTruthy()
    expect(received).toContain('messageLen=')
    expect(received).toContain('sessionId=')
  })

  it('emits a "chat reply" line with provider/model/durationMs/resultLen/status', async () => {
    const lines = await chatAndCapture(SECRET)
    const reply = lines.find((l) => l.includes('[http-api] chat reply'))
    expect(reply, '应落一行 chat reply').toBeTruthy()
    expect(reply).toContain('provider=')
    expect(reply).toContain('model=')
    expect(reply).toContain('durationMs=')
    expect(reply).toContain('resultLen=')
    expect(reply).toContain('status=200')
  })

  it('never echoes the raw message body into the ops log (PII safety)', async () => {
    const lines = await chatAndCapture(SECRET)
    const chatLines = lines.filter((l) => l.includes('[http-api] chat'))
    expect(chatLines.length).toBeGreaterThan(0)
    for (const line of chatLines) {
      expect(line, `ops log 泄露了消息原文: ${line}`).not.toContain(SECRET)
    }
  })

  it('a logger that throws does not break the chat round-trip', async () => {
    const h = await harness()
    // Replace the ctx logger with one that always throws — the production
    // code wraps every logger call in try/catch for exactly this reason.
    ;(h.svc as any).ctx.logger = {
      info: () => { throw new Error('logger exploded') },
      warn: () => { throw new Error('logger exploded') },
      error: () => { throw new Error('logger exploded') },
      debug: () => { throw new Error('logger exploded') },
    }
    const res = await fetch(`${h.base}/v1/chat`, {
      method: 'POST',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    })
    expect(res.status).toBe(200)
  })
})
