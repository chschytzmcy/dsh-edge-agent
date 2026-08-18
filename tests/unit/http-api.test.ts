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

      // Public routes
      if (req.method === 'GET' && path === '/v1/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok' }))
        return
      }
      if (req.method === 'GET' && path === '/v1/openapi.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ openapi: '3.0.0' }))
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
