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

export const inject = ['agents', 'intentRouter', 'promptGuard', 'auditLog'] as const

export interface Config {
  host: string
  port: number
  /** Bearer token required for all requests. */
  bearerToken?: string
  /** Whether to require attestation on first request. */
  requireAttestation: boolean
  /** Session idle timeout in ms. Sessions not accessed within this are cleaned up. 0 = disabled. */
  sessionIdleTimeoutMs: number
  /** Maximum active sessions. LRU eviction when exceeded. 0 = unlimited. */
  maxActiveSessions: number
}

export const Config: Schema<Config> = Schema.object({
  host: Schema.string().default('127.0.0.1'),
  port: Schema.natural().default(21017),
  bearerToken: Schema.string(),
  requireAttestation: Schema.boolean().default(true),
  sessionIdleTimeoutMs: Schema.natural().default(30 * 60 * 1000), // 30 min
  maxActiveSessions: Schema.natural().default(100),
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
  lastAccessedAt: number
}

export class HttpApiServiceImpl extends Service {
  private server: Server | undefined
  private readonly sessions = new Map<string, SessionRecord>()
  private running = false
  private intentRouter: any
  private cleanupTimer: ReturnType<typeof setInterval> | undefined

  constructor(
    private cordisCtx: any,
    private config: Config,
    private agents: any,
    private promptGuard: any,
    private auditLog: any,
  ) {
    super(cordisCtx, 'httpApi')
  }

  /** Emit an audit-log entry (silent no-op if missing or wrong API). */
  private audit(level: 'debug' | 'info' | 'warn' | 'error' | 'security', kind: string, payload: Record<string, unknown>): void {
    if (!this.auditLog || typeof this.auditLog.log !== 'function') {
      return
    }
    void this.auditLog.log({ level, kind, source: 'http-api', payload }).catch(() => {})
  }

  /** One-line access log to stdout (visible in /tmp/dsh.log). */
  private accessLog(reqId: string, method: string, path: string, status: number, durationMs: number, extra?: string): void {
    console.log(`[http-api][${reqId}] ${method} ${path} ${status} ${durationMs}ms${extra ? ' ' + extra : ''}`)
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
    // Start periodic session cleanup
    if (this.config.sessionIdleTimeoutMs > 0) {
      this.cleanupTimer = setInterval(() => {
        this.cleanupExpiredSessions()
      }, Math.min(this.config.sessionIdleTimeoutMs / 2, 60000)) // Check every min(timeout/2, 60s)
      if (typeof this.cleanupTimer.unref === 'function') this.cleanupTimer.unref()
    }
    this.audit('info', 'http.started', { host: this.config.host, port: this.config.port })
  }

  async stop(): Promise<void> {
    if (!this.running || !this.server) return
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = undefined
    }
    await new Promise<void>((resolve) => {
      this.server!.close(() => resolve())
      for (const record of this.sessions.values()) {
        record.handle.dispose().catch(() => {})
      }
      this.sessions.clear()
    })
    this.running = false
    this.audit('info', 'http.stopped', {})
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
    const reqId = randomUUID().slice(0, 8)
    const start = Date.now()

    // Public routes (no auth)
    if (req.method === 'GET' && path === '/v1/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok' }))
      this.accessLog(reqId, 'GET', path, 200, Date.now() - start)
      return
    }
    if (req.method === 'GET' && path === '/v1/openapi.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(this.getOpenApiSpec()))
      this.accessLog(reqId, 'GET', path, 200, Date.now() - start)
      return
    }

    // Auth check
    if (!this.checkAuth(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      this.accessLog(reqId, req.method ?? '?', path, 401, Date.now() - start, 'auth-fail')
      this.audit('warn', 'http.auth.fail', { reqId, method: req.method, path })
      return
    }

    try {
      if (req.method === 'POST' && path === '/v1/chat') {
        await this.handleChat(req, res, reqId, start)
      } else if (req.method === 'POST' && path === '/v1/chat/stream') {
        await this.handleChatStream(req, res, reqId, start)
      } else if (req.method === 'GET' && path === '/v1/sessions') {
        this.handleListSessions(res)
        this.accessLog(reqId, 'GET', path, 200, Date.now() - start)
      } else if (req.method === 'GET' && path.startsWith('/v1/sessions/')) {
        const id = path.slice('/v1/sessions/'.length)
        this.handleGetSession(id, res)
        this.accessLog(reqId, 'GET', path, 200, Date.now() - start)
      } else if (req.method === 'DELETE' && path.startsWith('/v1/sessions/')) {
        const id = path.slice('/v1/sessions/'.length)
        await this.handleDeleteSession(id, res)
        this.accessLog(reqId, 'DELETE', path, 204, Date.now() - start)
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Not found' }))
        this.accessLog(reqId, req.method ?? '?', path, 404, Date.now() - start)
      }
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message ?? 'Internal error' }))
      this.accessLog(reqId, req.method ?? '?', path, 500, Date.now() - start, `err="${err.message ?? 'unknown'}"`)
      this.audit('error', 'http.error', { reqId, method: req.method, path, error: err.message })
    }
  }

  private checkAuth(req: IncomingMessage): boolean {
    if (!this.config.bearerToken) return true
    const auth = req.headers.authorization
    if (!auth) return false
    const [scheme, token] = auth.split(' ')
    return scheme === 'Bearer' && token === this.config.bearerToken
  }

  private async handleChat(req: IncomingMessage, res: ServerResponse, reqId: string, start: number): Promise<void> {
    const body = await this.readJsonBody(req)
    const { message, sessionId: requestedSessionId } = body
    if (!message || typeof message !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'message is required' }))
      this.accessLog(reqId, 'POST', '/v1/chat', 400, Date.now() - start, 'no-message')
      return
    }

    const sessionId = requestedSessionId ?? randomUUID()
    this.audit('info', 'http.chat.start', { reqId, sessionId, messageLen: message.length, messagePreview: message.slice(0, 80) })

    // Input security check
    if (this.promptGuard) {
      try {
        const inputCheck = await this.promptGuard.checkInput(message, sessionId)
        if (!inputCheck.safe) {
          this.accessLog(reqId, 'POST', '/v1/chat', 400, Date.now() - start, 'input-blocked')
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            error: 'Input blocked by security policy',
            reason: inputCheck.reason,
            riskLevel: inputCheck.riskLevel,
          }))
          return
        }
      } catch (err: any) {
        this.audit('error', 'http.chat.input-check.error', { reqId, sessionId, error: err.message })
      }
    }

    // Classify intent using intent-router
    let intent = { category: 'CLOUD' as const, confidence: 0, targetRealm: 'cloud', rationale: 'no-classifier' }
    if (this.intentRouter) {
      try {
        intent = await this.intentRouter.classify(message)
      } catch (err: any) {
        // Intent classification failed, use default
      }
    }

    // Select provider/model based on intent
    const isLocal = (intent.category as string) === 'LOCAL'
    const provider = isLocal ? 'local-qwen3-4b' : 'cloud-deepseek-v4'
    const model = isLocal ? (process.env.DSH_EDGE_LOCAL_LLM_MODEL ?? 'qwen3-4b-instruct-2507') : 'deepseek-chat'
    this.audit('info', 'http.chat.route', { reqId, sessionId, intent: intent.category, provider, model, confidence: intent.confidence, rationale: intent.rationale })
    const record = await this.ensureSession(sessionId, provider, model)

    // Wait for turn completion by subscribing to session/event
    const turnEnd = new Promise<string>((resolve) => {
      const dispose = this.cordisCtx.on('session/event', (session: any, event: SessionEvent) => {
        if (event.type === 'turn/end') {
          const events = record.agent.session.events
          const lastAssistant = events
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

    // Call followup - it's fire-and-forget, agent loop runs async
    record.agent.followup(userMessage)

    let result = await turnEnd

    // Output security check (PII redaction)
    let redactedInfo: Array<{ type: string; masked: string }> | undefined
    if (this.promptGuard && result) {
      try {
        const outputCheck = await this.promptGuard.checkOutput(result)
        result = outputCheck.filtered
        if (outputCheck.redacted.length > 0) {
          redactedInfo = outputCheck.redacted
        }
      } catch (err: any) {
        this.audit('error', 'http.chat.output-check.error', { reqId, sessionId, error: err.message })
      }
    }

    const duration = Date.now() - start
    this.audit('info', 'http.chat.end', { reqId, sessionId, provider, model, durationMs: duration, resultLen: result.length })
    this.accessLog(reqId, 'POST', '/v1/chat', 200, duration, `${provider}/${model} intent=${intent.category}`)

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
        ...(redactedInfo && { redacted: redactedInfo }),
      }),
    )
  }

  private async handleChatStream(req: IncomingMessage, res: ServerResponse, reqId: string, start: number): Promise<void> {
    const body = await this.readJsonBody(req)
    const { message, sessionId: requestedSessionId } = body
    if (!message || typeof message !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'message is required' }))
      this.accessLog(reqId, 'POST', '/v1/chat/stream', 400, Date.now() - start, 'no-message')
      return
    }

    const sessionId = requestedSessionId ?? randomUUID()
    this.audit('info', 'http.chat.stream.start', { reqId, sessionId, messageLen: message.length })

    // Input security check
    if (this.promptGuard) {
      try {
        const inputCheck = await this.promptGuard.checkInput(message, sessionId)
        if (!inputCheck.safe) {
          this.accessLog(reqId, 'POST', '/v1/chat/stream', 400, Date.now() - start, 'input-blocked')
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            error: 'Input blocked by security policy',
            reason: inputCheck.reason,
            riskLevel: inputCheck.riskLevel,
          }))
          return
        }
      } catch (err: any) {
        this.audit('error', 'http.chat.stream.input-check.error', { reqId, sessionId, error: err.message })
      }
    }

    // Classify intent (same as handleChat) so SSE routes to the correct LLM
    let intent = { category: 'CLOUD' as const, confidence: 0, targetRealm: 'cloud', rationale: 'no-classifier' }
    if (this.intentRouter) {
      try {
        intent = await this.intentRouter.classify(message)
      } catch (err: any) {
        // Intent classification failed, use default
      }
    }

    const isLocal = (intent.category as string) === 'LOCAL'
    const provider = isLocal ? 'local-qwen3-4b' : 'cloud-deepseek-v4'
    const model = isLocal ? (process.env.DSH_EDGE_LOCAL_LLM_MODEL ?? 'qwen3-4b-instruct-2507') : 'deepseek-chat'
    this.audit('info', 'http.chat.stream.route', { reqId, sessionId, intent: intent.category, provider, model })
    const record = await this.ensureSession(sessionId, provider, model)

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    this.accessLog(reqId, 'POST', '/v1/chat/stream', 200, Date.now() - start, `${provider}/${model} intent=${intent.category}`)

    // Emit intent first so client knows the routing decision
    res.write(`data: ${JSON.stringify({ type: 'intent', intent: { category: intent.category, targetRealm: intent.targetRealm, confidence: intent.confidence, rationale: intent.rationale } })}\n\n`)

    const dispose = this.cordisCtx.on('session/event', (_session: any, event: SessionEvent) => {
      if (event.type === 'assistant/chunk') {
        const chunk = (event as any).data.chunk
        if (chunk.type === 'text-delta') {
          res.write(`data: ${JSON.stringify({ type: 'text', text: chunk.text })}\n\n`)
        }
      } else if (event.type === 'turn/end') {
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`)
        const duration = Date.now() - start
        this.audit('info', 'http.chat.stream.end', { reqId, sessionId, provider, model, durationMs: duration })
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
      lastAccessedAt: record.lastAccessedAt,
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
    this.audit('debug', 'session.accessed', { sessionId: id })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ sessionId: id, createdAt: record.createdAt, lastAccessedAt: record.lastAccessedAt }))
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
    this.audit('info', 'session.deleted', { sessionId: id })
    res.writeHead(204)
    res.end()
  }

  private async ensureSession(sessionId: string, provider?: string, model?: string): Promise<SessionRecord> {
    let record = this.sessions.get(sessionId)
    if (!record) {
      // Check max active sessions and evict LRU if needed
      if (this.config.maxActiveSessions > 0 && this.sessions.size >= this.config.maxActiveSessions) {
        await this.evictLeastRecentSession()
      }
      console.log(`[http-api] Creating agent with provider=${provider}, model=${model}`)
      const handle = await this.agents.create({
        sessionId: SessionId(sessionId),
        agentOptions: {
          provider: provider ?? 'local-qwen3-4b',
          model: model ?? 'qwen3-4b',
        },
        meta: { cwd: process.cwd() },
      })
      console.log(`[http-api] Agent created successfully`)
      const now = Date.now()
      record = { agent: handle.agent, handle, createdAt: now, lastAccessedAt: now }
      this.sessions.set(sessionId, record)
      this.audit('info', 'session.created', { sessionId, provider, model, totalSessions: this.sessions.size })
    } else {
      // Update last accessed time
      record.lastAccessedAt = Date.now()
    }
    return record
  }

  /**
   * Clean up sessions that have been idle longer than sessionIdleTimeoutMs.
   * Called periodically by the cleanup timer.
   */
  private cleanupExpiredSessions(): void {
    if (this.config.sessionIdleTimeoutMs <= 0) return
    const now = Date.now()
    const timeout = this.config.sessionIdleTimeoutMs
    const expired: string[] = []

    for (const [id, record] of this.sessions.entries()) {
      if (now - record.lastAccessedAt > timeout) {
        expired.push(id)
      }
    }

    for (const id of expired) {
      const record = this.sessions.get(id)
      if (record) {
        record.handle.dispose().catch(() => {})
        this.sessions.delete(id)
        this.audit('info', 'session.expired', { sessionId: id, idleMs: now - record.lastAccessedAt })
      }
    }

    if (expired.length > 0) {
      this.audit('debug', 'session.cleanup', { expiredCount: expired.length, remainingCount: this.sessions.size })
    }
  }

  /**
   * Evict the least-recently-used session to make room for a new one.
   * Called when maxActiveSessions is reached.
   */
  private async evictLeastRecentSession(): Promise<void> {
    let oldest: { id: string; lastAccessedAt: number } | null = null

    for (const [id, record] of this.sessions.entries()) {
      if (!oldest || record.lastAccessedAt < oldest.lastAccessedAt) {
        oldest = { id, lastAccessedAt: record.lastAccessedAt }
      }
    }

    if (oldest) {
      const record = this.sessions.get(oldest.id)
      if (record) {
        await record.handle.dispose()
        this.sessions.delete(oldest.id)
        this.audit('info', 'session.evicted', {
          sessionId: oldest.id,
          reason: 'max-active-sessions-reached',
          idleMs: Date.now() - oldest.lastAccessedAt,
        })
      }
    }
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
  const promptGuard = ctx.get('promptGuard')
  const auditLog = ctx.get('auditLog')
  console.log(`[http-api] apply() - promptGuard: ${!!promptGuard}, auditLog: ${!!auditLog}`)
  const service = new HttpApiServiceImpl(ctx, config, agents, promptGuard, auditLog)
  await service.start()
  return async () => {
    await service.stop()
  }
}
