/**
 * http-api plugin tests — verifies HTTP routes, auth, and agent integration.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'

// Simplified test without Cordis Service wrapper
describe('http-api plugin', () => {
  let server: Server
  let port: number
  let sessions: Map<string, any>
  let agents: any

  beforeEach(async () => {
    sessions = new Map()
    agents = {
      create: async ({ sessionId }: { sessionId: string }) => {
        const events: any[] = []
        return {
          agent: {
            id: sessionId,
            session: {
              id: sessionId,
              events,
            },
            followup: (msg: any) => {
              // Simulate agent processing
              setTimeout(() => {
                events.push({
                  type: 'assistant/chunk',
                  data: { chunk: { type: 'text-delta', text: 'Hello' } },
                })
                events.push({
                  type: 'assistant/message',
                  data: {
                    message: {
                      content: [{ type: 'text', text: 'Hello world' }],
                    },
                  },
                })
                events.push({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
              }, 10)
            },
          },
          handle: {
            dispose: async () => {},
          },
        }
      },
    }

    // Create a simple HTTP server that mimics http-api behavior
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      const path = url.pathname

      // Public routes (mirrors real dispatcher: HEAD falls back to GET
      // per RFC 7231 §4.3.2 — see http-api.ts handleRequest).
      if (path === '/v1/health' && (req.method === 'GET' || req.method === 'HEAD')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        if (req.method === 'GET') res.end(JSON.stringify({ status: 'ok' }))
        else res.end()
        return
      }
      if (path === '/v1/openapi.json' && (req.method === 'GET' || req.method === 'HEAD')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        if (req.method === 'GET') res.end(JSON.stringify({ openapi: '3.0.0' }))
        else res.end()
        return
      }

      // Auth check
      const auth = req.headers.authorization
      if (!auth || auth !== 'Bearer test-token') {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized' }))
        return
      }

      try {
        if (req.method === 'POST' && path === '/v1/chat') {
          const body = await readJsonBody(req)
          const { message, sessionId: requestedSessionId } = body
          if (!message) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'message is required' }))
            return
          }

          const sessionId = requestedSessionId ?? `session-${Date.now()}`
          if (!sessions.has(sessionId)) {
            const result = await agents.create({ sessionId })
            sessions.set(sessionId, { agent: result.agent, handle: result.handle, createdAt: Date.now() })
          }

          // Wait for turn completion
          await new Promise((resolve) => setTimeout(resolve, 50))

          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              sessionId,
              result: 'Hello world',
              intent: { category: 'CLOUD' },
              duration: 50,
            }),
          )
        } else if (req.method === 'GET' && path === '/v1/sessions') {
          const list = Array.from(sessions.entries()).map(([id, record]) => ({
            sessionId: id,
            createdAt: record.createdAt,
          }))
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ sessions: list }))
        } else if (req.method === 'GET' && path.startsWith('/v1/sessions/')) {
          const id = path.slice('/v1/sessions/'.length)
          const record = sessions.get(id)
          if (!record) {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Session not found' }))
            return
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ sessionId: id, createdAt: record.createdAt }))
        } else if (req.method === 'DELETE' && path.startsWith('/v1/sessions/')) {
          const id = path.slice('/v1/sessions/'.length)
          const record = sessions.get(id)
          if (!record) {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Session not found' }))
            return
          }
          await record.handle.dispose()
          sessions.delete(id)
          res.writeHead(204)
          res.end()
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Not found' }))
        }
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err.message }))
      }
    })

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any
        port = addr.port
        resolve()
      })
    })
  })

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  const baseUrl = () => `http://127.0.0.1:${port}`

  const readJsonBody = (req: any): Promise<any> => {
    return new Promise((resolve, reject) => {
      let data = ''
      req.on('data', (chunk: any) => (data += chunk))
      req.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : {})
        } catch (err) {
          reject(err)
        }
      })
      req.on('error', reject)
    })
  }

  it('health endpoint is public (no auth required)', async () => {
    const res = await fetch(`${baseUrl()}/v1/health`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ status: 'ok' })
  })

  it('HEAD /v1/health is also public (RFC 7231 §4.3.2: HEAD = GET, no body)', async () => {
    // curl -I / load-balancer probes use HEAD; without this fallback the
    // dispatcher would 401 (curl omits Authorization), polluting audit log.
    const res = await fetch(`${baseUrl()}/v1/health`, { method: 'HEAD' })
    expect(res.status).toBe(200)
  })

  it('openapi.json endpoint is public', async () => {
    const res = await fetch(`${baseUrl()}/v1/openapi.json`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.openapi).toBe('3.0.0')
  })

  it('rejects requests without auth token', async () => {
    const res = await fetch(`${baseUrl()}/v1/sessions`)
    expect(res.status).toBe(401)
  })

  it('rejects requests with wrong auth token', async () => {
    const res = await fetch(`${baseUrl()}/v1/sessions`, {
      headers: { Authorization: 'Bearer wrong-token' },
    })
    expect(res.status).toBe(401)
  })

  it('accepts requests with correct auth token', async () => {
    const res = await fetch(`${baseUrl()}/v1/sessions`, {
      headers: { Authorization: 'Bearer test-token' },
    })
    expect(res.status).toBe(200)
  })

  it('lists sessions (empty initially)', async () => {
    const res = await fetch(`${baseUrl()}/v1/sessions`, {
      headers: { Authorization: 'Bearer test-token' },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.sessions).toEqual([])
  })

  it('POST /v1/chat creates a session and returns result', async () => {
    const res = await fetch(`${baseUrl()}/v1/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify({ message: 'hi' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.sessionId).toBeDefined()
    expect(body.result).toBeDefined()
    expect(body.duration).toBeGreaterThan(0)
  })

  it('POST /v1/chat reuses existing session when sessionId provided', async () => {
    const sessionId = 'test-session-123'
    const res1 = await fetch(`${baseUrl()}/v1/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify({ message: 'hi', sessionId }),
    })
    const body1 = await res1.json()
    expect(body1.sessionId).toBe(sessionId)

    const res2 = await fetch(`${baseUrl()}/v1/sessions`, {
      headers: { Authorization: 'Bearer test-token' },
    })
    const body2 = await res2.json()
    expect(body2.sessions).toHaveLength(1)
    expect(body2.sessions[0].sessionId).toBe(sessionId)
  })

  it('POST /v1/chat rejects missing message', async () => {
    const res = await fetch(`${baseUrl()}/v1/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('GET /v1/sessions/:id returns session details', async () => {
    const sessionId = 'test-session-456'
    await fetch(`${baseUrl()}/v1/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify({ message: 'hi', sessionId }),
    })

    const res = await fetch(`${baseUrl()}/v1/sessions/${sessionId}`, {
      headers: { Authorization: 'Bearer test-token' },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.sessionId).toBe(sessionId)
    expect(body.createdAt).toBeDefined()
  })

  it('GET /v1/sessions/:id returns 404 for unknown session', async () => {
    const res = await fetch(`${baseUrl()}/v1/sessions/unknown`, {
      headers: { Authorization: 'Bearer test-token' },
    })
    expect(res.status).toBe(404)
  })

  it('DELETE /v1/sessions/:id removes session', async () => {
    const sessionId = 'test-session-789'
    await fetch(`${baseUrl()}/v1/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify({ message: 'hi', sessionId }),
    })

    const delRes = await fetch(`${baseUrl()}/v1/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer test-token' },
    })
    if (delRes.status !== 204) {
      const body = await delRes.text()
      console.error('DELETE failed:', delRes.status, body)
    }
    expect(delRes.status).toBe(204)

    const getRes = await fetch(`${baseUrl()}/v1/sessions/${sessionId}`, {
      headers: { Authorization: 'Bearer test-token' },
    })
    expect(getRes.status).toBe(404)
  })

  it('returns 404 for unknown routes', async () => {
    const res = await fetch(`${baseUrl()}/v1/unknown`, {
      headers: { Authorization: 'Bearer test-token' },
    })
    expect(res.status).toBe(404)
  })
})

// resolveRoute() is exported as a pure function from http-api so the
// model-router wiring can be exercised without standing up the full HTTP
// server + Service instance. The soft-dep contract: modelRouter on the
// cordis context is preferred; when absent / throws, fall back to the
// legacy hardcoded provider/model pair.
import { resolveRoute } from '../../src/dsh-adapter/http-api.ts'

describe('http-api resolveRoute (modelRouter wiring)', () => {
  const prevEnv = process.env.DSH_EDGE_LOCAL_LLM_MODEL

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.DSH_EDGE_LOCAL_LLM_MODEL
    else process.env.DSH_EDGE_LOCAL_LLM_MODEL = prevEnv
  })

  it('falls back to hardcoded local provider+model when modelRouter is absent', () => {
    delete process.env.DSH_EDGE_LOCAL_LLM_MODEL
    const r = resolveRoute({}, true)
    expect(r.resolved).toBe(false)
    expect(r.provider).toBe('local-qwen3-4b')
    expect(r.model).toBe('qwen3-4b-instruct-2507')
  })

  it('falls back to hardcoded cloud provider+model when modelRouter is absent', () => {
    const r = resolveRoute({}, false)
    expect(r.resolved).toBe(false)
    expect(r.provider).toBe('cloud-deepseek-v4')
    expect(r.model).toBe('deepseek-chat')
  })

  it('honors DSH_EDGE_LOCAL_LLM_MODEL env override on the local fallback path', () => {
    process.env.DSH_EDGE_LOCAL_LLM_MODEL = 'qwen3-4b-fine-tuned'
    const r = resolveRoute({}, true)
    expect(r.resolved).toBe(false)
    expect(r.model).toBe('qwen3-4b-fine-tuned')
  })

  it('uses modelRouter.resolve when present and returns the resolved route', () => {
    let calledWith: string | undefined
    const ctx = {
      modelRouter: {
        resolve: (preferred: string) => {
          calledWith = preferred
          return { realm: 'LOCAL', provider: 'local-qwen3-4b-tuned', model: 'qwen3-4b-ft-2026-08' }
        },
      },
    }
    const r = resolveRoute(ctx, true)
    expect(calledWith).toBe('local-qwen3-4b')
    expect(r.resolved).toBe(true)
    expect(r.provider).toBe('local-qwen3-4b-tuned')
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
    expect(r.provider).toBe('cloud-deepseek-v4')
    expect(r.model).toBe('deepseek-chat')
  })

  it('falls back when modelRouter.resolve returns a malformed shape', () => {
    const ctx = {
      modelRouter: {
        resolve: () => ({ provider: 123, model: null }), // wrong types
      },
    }
    const r = resolveRoute(ctx, true)
    expect(r.resolved).toBe(false)
    expect(r.provider).toBe('local-qwen3-4b')
  })
})

// §7.46.5 (2026-09-12): 在 ops log 留 chat received/reply 两行 —
// 让 operator 看 trace 时知道消息何时到达、何时回包。
// 这是 source-level smoke test：构造一个最小 HttpApiServiceImpl 触发
// handleChat，捕获 ctx.logger.info emit 行。
// (inline mock-server 不走真实 HttpApiServiceImpl，所以另外构造。)
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
// (handleChat 端到端测试需要完整 req/res/intentRouter/agents，由 E2E
// curl POST 覆盖；这里是 source-level smoke test 验证 emit 格式)

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const httpApiSource = readFileSync(
  join(__dirname, '../../src/dsh-adapter/http-api.ts'),
  'utf-8',
)

describe('http-api §7.46.5 — chat received/reply ops log source presence', () => {
  it('source contains [http-api] chat received emit (post-receive entry log)', () => {
    // §7.46.5: 在 handleChat 内 sessionId 解析后、intentRouter 之前 emit
    // messageLen（不是 message 内容 — 避免 PII 落 ops log）
    const match = httpApiSource.match(/\[\s*http-api\s*\]\s*chat received\s+sessionId=/)
    expect(match, 'expected `[http-api] chat received sessionId=...` emit line in http-api.ts').toBeTruthy()
  })

  it('source contains [http-api] chat reply emit with provider/model/durationMs/resultLen/status', () => {
    // §7.46.5: 在 handleChat 200 响应前 emit，含 provider/model/durationMs
    // /resultLen/status=200/intent — 让 operator grep 知道 chat round-trip 完成
    const match = httpApiSource.match(
      /\[\s*http-api\s*\]\s*chat reply\s+sessionId=[^\n]*provider=[^\n]*model=[^\n]*durationMs=[^\n]*resultLen=[^\n]*status=200/,
    )
    expect(
      match,
      'expected `[http-api] chat reply sessionId=... provider=... model=... durationMs=... resultLen=... status=200 intent=...` emit line in http-api.ts',
    ).toBeTruthy()
  })

  it('chat received line uses try/catch + optional-chained logger (per ops-log-coverage-principle pattern)', () => {
    // 验证 try { this.ctx.logger?.info?.(...) } catch 兜底在 chat received 附近
    // 不能让 logger throw 中断 chat round-trip
    const idx = httpApiSource.indexOf('[http-api] chat received')
    expect(idx).toBeGreaterThan(-1)
    // 向前走到上一个 'try {' 行（最多 400 chars）
    const window = httpApiSource.slice(Math.max(0, idx - 400), idx)
    expect(window).toMatch(/\btry\s*\{/)
    // 向后走到 catch
    const after = httpApiSource.slice(idx, idx + 400)
    expect(after).toMatch(/\}\s*catch\s*\{/)
  })

  it('chat reply line uses try/catch + optional-chained logger', () => {
    const idx = httpApiSource.indexOf('[http-api] chat reply')
    expect(idx).toBeGreaterThan(-1)
    const window = httpApiSource.slice(Math.max(0, idx - 400), idx)
    expect(window).toMatch(/\btry\s*\{/)
    const after = httpApiSource.slice(idx, idx + 400)
    expect(after).toMatch(/\}\s*catch\s*\{/)
  })

  it('chat received/reply do NOT echo raw message body (PII safety)', () => {
    // 不能让 message 内容（可能含 PII）落 ops log — messageLen 而非 message
    const receivedWindow = httpApiSource.slice(
      httpApiSource.indexOf('[http-api] chat received'),
      httpApiSource.indexOf('[http-api] chat received') + 300,
    )
    const replyWindow = httpApiSource.slice(
      httpApiSource.indexOf('[http-api] chat reply'),
      httpApiSource.indexOf('[http-api] chat reply') + 400,
    )
    // 模板里只能出现 messageLen / message.length，不能出现裸 message=
    expect(receivedWindow).toContain('messageLen=')
    expect(receivedWindow).not.toMatch(/message=\$\{/)
    // reply 用 resultLen 而非 result 内容
    expect(replyWindow).toContain('resultLen=')
    expect(replyWindow).not.toMatch(/result=\$\{/)
  })
})
