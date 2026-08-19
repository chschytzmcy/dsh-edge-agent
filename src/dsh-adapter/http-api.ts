/**
 * http-api — exposes an HTTP server from the parent DSH process so that
 * external consumers (mobile apps, third-party services) can talk to a
 * running agent. Optional S13 plugin.
 *
 * @module dsh-edge-agent/http-api
 */

import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

export const name = 'http-api'

export const inject = ['agents', 'intentRouter'] as const

export interface Config {
  host: string
  port: number
  /** Bearer token required for all requests. */
  bearerToken?: string
  /** Whether to require attestation on first request. */
  requireAttestation: boolean
}

export const Config: Schema<Config> = Schema.object({
  host: Schema.string().default('127.0.0.1'),
  port: Schema.natural().default(21017),
  bearerToken: Schema.string(),
  requireAttestation: Schema.boolean().default(true),
})

export interface HttpApiService {
  start(): Promise<void>
  stop(): Promise<void>
  isRunning(): boolean
  endpoint(): string
}

interface SessionRecord {
  agent: Agent
  handle: AgentHandle
  createdAt: number
}

export class HttpApiServiceImpl extends Service {
  private server: Server | undefined
  private readonly sessions = new Map<string, SessionRecord>()
  private running = false
  private intentRouter: any

  constructor(
    private cordisCtx: any,
    private config: Config,
    private agents: any,
    private auditLog: any,
  ) {
    super(cordisCtx, 'httpApi')
  }

  async start(): Promise<void> {
    if (this.running) return
    // Get intentRouter after all plugins are loaded
    try {
      const router = (this.cordisCtx as any).intentRouter
      if (router && typeof router.classify === 'function') {
        this.intentRouter = router
        console.log('[http-api] intentRouter: found and valid')
      } else {
        console.log('[http-api] intentRouter: exists but invalid', router)
      }
    } catch (err: any) {
      console.log('[http-api] Error getting intentRouter:', err?.message)
    }

    this.server = createServer((req, res) => this.handleRequest(req, res))
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(this.config.port, this.config.host, () => {
        this.server!.removeListener('error', reject)
        resolve()
      })
    })
    this.running = true
    this.auditLog?.info?.(`[http-api] listening on ${this.config.host}:${this.config.port}`)
  }

  async stop(): Promise<void> {
    if (!this.running || !this.server) return
    await new Promise<void>((resolve) => {
      this.server!.close(() => resolve())
      for (const record of this.sessions.values()) {
        record.handle.dispose().catch(() => {})
      }
      this.sessions.clear()
    })
    this.running = false
  }

  isRunning(): boolean {
    return this.running
  }

  endpoint(): string {
    return this.running ? `http://${this.config.host}:${this.config.port}` : ''
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const path = url.pathname

    // Public routes (no auth)
    if (req.method === 'GET' && path === '/v1/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok' }))
      return
    }
    if (req.method === 'GET' && path === '/v1/openapi.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(this.getOpenApiSpec()))
      return
    }

    // Auth check
    if (!this.checkAuth(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }

    try {
      if (req.method === 'POST' && path === '/v1/chat') {
        await this.handleChat(req, res)
      } else if (req.method === 'POST' && path === '/v1/chat/stream') {
        await this.handleChatStream(req, res)
      } else if (req.method === 'GET' && path === '/v1/sessions') {
        this.handleListSessions(res)
      } else if (req.method === 'GET' && path.startsWith('/v1/sessions/')) {
        const id = path.slice('/v1/sessions/'.length)
        this.handleGetSession(id, res)
      } else if (req.method === 'DELETE' && path.startsWith('/v1/sessions/')) {
        const id = path.slice('/v1/sessions/'.length)
        await this.handleDeleteSession(id, res)
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Not found' }))
      }
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message ?? 'Internal error' }))
    }
  }

  private checkAuth(req: IncomingMessage): boolean {
    if (!this.config.bearerToken) return true
    const auth = req.headers.authorization
    if (!auth) return false
    const [scheme, token] = auth.split(' ')
    return scheme === 'Bearer' && token === this.config.bearerToken
  }

  private async handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJsonBody(req)
    const { message, sessionId: requestedSessionId } = body
    if (!message || typeof message !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'message is required' }))
      return
    }

    const start = Date.now()
    const sessionId = requestedSessionId ?? randomUUID()
    const record = await this.ensureSession(sessionId)

    // Classify intent using intent-router
    let intent = { category: 'CLOUD' as const, confidence: 0, targetRealm: 'cloud', rationale: 'no-classifier' }
    if (this.intentRouter) {
      try {
        intent = await this.intentRouter.classify(message)
      } catch (err: any) {
        // Intent classification failed, use default
      }
    }

    // Wait for turn completion by subscribing to session/event
    const turnEnd = new Promise<string>((resolve) => {
      const dispose = this.cordisCtx.on('session/event', (session: any, event: SessionEvent) => {
        if (session.id !== sessionId) return
        if (event.type === 'turn/end') {
          const lastAssistant = record.agent.session.events
            .filter((e) => e.type === 'assistant/message')
            .pop()
          const text = lastAssistant
            ? (lastAssistant as any).data.message.content
                .filter((b: any) => b.type === 'text')
                .map((b: any) => b.text)
                .join('')
            : ''
          dispose()
          resolve(text)
        }
      })
    })

    const userMessage = createUserMessage({
      content: [{ type: 'text', text: message }],
      source: { kind: 'user' },
    })
    record.agent.followup(userMessage)

    const result = await turnEnd
    const duration = Date.now() - start

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        sessionId,
        result,
        intent: {
          category: intent.category,
          targetRealm: intent.targetRealm,
          confidence: intent.confidence,
          rationale: intent.rationale,
        },
        duration,
      }),
    )
  }

  private async handleChatStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJsonBody(req)
    const { message, sessionId: requestedSessionId } = body
    if (!message || typeof message !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'message is required' }))
      return
    }

    const sessionId = requestedSessionId ?? randomUUID()
    const record = await this.ensureSession(sessionId)

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })

    const dispose = this.cordisCtx.on('session/event', (_session: any, event: SessionEvent) => {
      if (event.type === 'assistant/chunk') {
        const chunk = (event as any).data.chunk
        if (chunk.type === 'text-delta') {
          res.write(`data: ${JSON.stringify({ type: 'text', text: chunk.text })}\n\n`)
        }
      } else if (event.type === 'turn/end') {
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`)
        dispose()
        res.end()
      }
    })

    const userMessage = createUserMessage({
      content: [{ type: 'text', text: message }],
      source: { kind: 'user' },
    })
    record.agent.followup(userMessage)
  }

  private handleListSessions(res: ServerResponse): void {
    const list = Array.from(this.sessions.entries()).map(([id, record]) => ({
      sessionId: id,
      createdAt: record.createdAt,
    }))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ sessions: list }))
  }

  private handleGetSession(id: string, res: ServerResponse): void {
    const record = this.sessions.get(id)
    if (!record) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Session not found' }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ sessionId: id, createdAt: record.createdAt }))
  }

  private async handleDeleteSession(id: string, res: ServerResponse): Promise<void> {
    const record = this.sessions.get(id)
    if (!record) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Session not found' }))
      return
    }
    await record.handle.dispose()
    this.sessions.delete(id)
    res.writeHead(204)
    res.end()
  }

  private async ensureSession(sessionId: string): Promise<SessionRecord> {
    let record = this.sessions.get(sessionId)
    if (!record) {
      const handle = await this.agents.create({
        sessionId: SessionId(sessionId),
        meta: { cwd: process.cwd() },
      })
      record = { agent: handle.agent, handle, createdAt: Date.now() }
      this.sessions.set(sessionId, record)
    }
    return record
  }

  private async readJsonBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let data = ''
      req.on('data', (chunk) => (data += chunk))
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

  private getOpenApiSpec(): object {
    return {
      openapi: '3.0.0',
      info: { title: 'dsh-edge-agent HTTP API', version: '1.0.0' },
      paths: {
        '/v1/health': {
          get: { summary: 'Health check', responses: { '200': { description: 'OK' } } },
        },
        '/v1/chat': {
          post: {
            summary: 'Synchronous chat',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      message: { type: 'string' },
                      sessionId: { type: 'string' },
                    },
                    required: ['message'],
                  },
                },
              },
            },
            responses: { '200': { description: 'Chat response' } },
          },
        },
        '/v1/chat/stream': {
          post: {
            summary: 'Streaming chat (SSE)',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      message: { type: 'string' },
                      sessionId: { type: 'string' },
                    },
                    required: ['message'],
                  },
                },
              },
            },
            responses: { '200': { description: 'SSE stream' } },
          },
        },
        '/v1/sessions': {
          get: { summary: 'List sessions', responses: { '200': { description: 'Session list' } } },
        },
        '/v1/sessions/{id}': {
          get: { summary: 'Get session', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Session details' } } },
          delete: { summary: 'Delete session', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '204': { description: 'Deleted' } } },
        },
      },
    }
  }
}

export async function apply(ctx: any, config: Config): Promise<() => Promise<void>> {
  const agents = ctx.get('agents')
  const auditLog = ctx.get('auditLog')
  const service = new HttpApiServiceImpl(ctx, config, agents, auditLog)
  await service.start()
  return async () => {
    await service.stop()
  }
}
