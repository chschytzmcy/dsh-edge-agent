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

export const inject = ['agents', 'intentRouter', 'promptGuard', 'auditLog', 'sanitizer', 'tdBus'] as const

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
  private tdBus: any
  private cleanupTimer: ReturnType<typeof setInterval> | undefined

  constructor(
    private cordisCtx: any,
    private config: Config,
    private agents: any,
    private promptGuard: any,
    private auditLog: any,
    private sanitizer: any,
    tdBus?: any,
  ) {
    super(cordisCtx, 'httpApi')
    this.tdBus = tdBus
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

  /**
   * Resolve the actual provider + model to use for a given intent verdict.
   * Falls back to the legacy hardcoded pair (`local-qwen3-4b` /
   * `cloud-deepseek-v4` plus env-overridable model) when:
   *   - `modelRouter` is not registered on the cordis context (boot-order
   *     race: http-api boots before model-router in some configs)
   *   - `modelRouter.resolve` is unavailable
   *   - the lookup throws (defensive: never let router failure break a
   *     chat round-trip)
   *
   * Soft-dep pattern (no `inject`) — same as intent-router, because
   * http-api boots ahead of model-router in the canonical plugin order.
   * Extracted as a module-level pure function so unit tests can exercise
   * the resolution matrix without standing up a full HttpApiServiceImpl.
   */
  private resolveRoute(isLocal: boolean): { provider: string; model: string; resolved: boolean } {
    return resolveRoute(this.cordisCtx, isLocal)
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

    // Phase D: td-bus threat gate (blockLevel default: critical)
    if (this.tdBus) {
      // Feed each request into td-bus so it can recompute threat level.
      // CLOUD-bound requests count heavier; LOCAL ones count lightly.
      // For Phase D we feed all requests equally — refinement can come later.
      try { this.tdBus.recordCloudRequest() } catch { /* never block on td-bus faults */ }

      if (typeof this.tdBus.shouldBlock === 'function' && this.tdBus.shouldBlock()) {
        const threat = typeof this.tdBus.getThreatLevel === 'function'
          ? this.tdBus.getThreatLevel() : 'critical'
        this.audit('security', 'http.chat.threat-blocked', { reqId, sessionId, threat })
        this.accessLog(reqId, 'POST', '/v1/chat', 503, Date.now() - start, 'threat-blocked')
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Service unavailable — threat level elevated', threat }))
        return
      }
    }

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
    let intent: any = { category: 'CLOUD', confidence: 0, targetRealm: 'cloud', rationale: 'no-classifier' }
    if (this.intentRouter) {
      try {
        intent = await this.intentRouter.classify(message)
      } catch (err: any) {
        // Intent classification failed, use default
      }
    }

    // Contract: REJECT verdict from intent-router is a hard block. The router
    // already audited `intent.rules.rejected` at security level; here we
    // translate to a 403 response and short-circuit before any LLM call or
    // sanitization. Aligns with design-v6 §2.15 and §4.3 waterfall semantics
    // — REJECT bypasses the agent loop entirely.
    if (intent.category === 'REJECT') {
      const reason = (intent as any).rationale || 'policy-rule:reject'
      this.audit('warn', 'http.chat.rejected', { reqId, sessionId, reason, confidence: intent.confidence })
      this.accessLog(reqId, 'POST', '/v1/chat', 403, Date.now() - start, `reject:${reason}`)
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        error: 'Request rejected by policy',
        reason,
        confidence: intent.confidence,
      }))
      return
    }

    // Select provider/model based on intent. The hardcoded pair is the
    // fallback; modelRouter (registered later in boot order) takes
    // precedence via lazy lookup so http-api doesn't need an inject dep.
    const isLocal = intent.category === 'LOCAL'
    const route = this.resolveRoute(isLocal)
    const { provider, model } = route
    this.audit('info', 'http.chat.route', { reqId, sessionId, intent: intent.category, provider, model, resolved: route.resolved, confidence: intent.confidence, rationale: intent.rationale })

    // Phase 4: Sanitize input for CLOUD requests
    let messageToSend = message
    let sanitizationInfo: { replacements: number } | undefined
    if (!isLocal && this.sanitizer) {
      try {
        const sanitizationResult = await this.sanitizer.sanitize(message, { sessionId })
        messageToSend = sanitizationResult.sanitizedText
        if (sanitizationResult.replacements.length > 0) {
          sanitizationInfo = { replacements: sanitizationResult.replacements.length }
          this.audit('info', 'http.chat.sanitized', {
            reqId,
            sessionId,
            replacementCount: sanitizationResult.replacements.length,
          })
        }
      } catch (err: any) {
        this.audit('error', 'http.chat.sanitize.error', { reqId, sessionId, error: err.message })
      }
    }

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
      content: [{ type: 'text', text: messageToSend }],
      source: { kind: 'user' },
    })

    // Call followup - it's fire-and-forget, agent loop runs async
    record.agent.followup(userMessage)

    let result = await turnEnd

    // Phase 4: Desanitize output for CLOUD requests
    if (!isLocal && this.sanitizer && sanitizationInfo) {
      try {
        result = await this.sanitizer.desanitize(result, sessionId)
        this.audit('debug', 'http.chat.desanitized', { reqId, sessionId })
      } catch (err: any) {
        this.audit('error', 'http.chat.desanitize.error', { reqId, sessionId, error: err.message })
      }
    }

    // Output security check (PII redaction)
    // Pass sanitized=true when sanitizer-pipeline managed this session,
    // so prompt-guard skips its own masking and doesn't undo the desanitize above.
    let redactedInfo: Array<{ type: string; masked: string }> | undefined
    if (this.promptGuard && result) {
      try {
        const wasSanitized = !!sanitizationInfo
        const outputCheck = await this.promptGuard.checkOutput(result, { sanitized: wasSanitized })
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
    let intent: any = { category: 'CLOUD', confidence: 0, targetRealm: 'cloud', rationale: 'no-classifier' }
    if (this.intentRouter) {
      try {
        intent = await this.intentRouter.classify(message)
      } catch (err: any) {
        // Intent classification failed, use default
      }
    }

    // REJECT short-circuit (same contract as handleChat): write SSE-shaped
    // error event + 403, no LLM call, no sanitization. Client SSE parsers
    // expect an `error` event before the stream closes.
    if (intent.category === 'REJECT') {
      const reason = (intent as any).rationale || 'policy-rule:reject'
      this.audit('warn', 'http.chat.stream.rejected', { reqId, sessionId, reason, confidence: intent.confidence })
      this.accessLog(reqId, 'POST', '/v1/chat/stream', 403, Date.now() - start, `reject:${reason}`)
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        error: 'Request rejected by policy',
        reason,
        confidence: intent.confidence,
      }))
      return
    }

    const isLocal = intent.category === 'LOCAL'
    const route = this.resolveRoute(isLocal)
    const { provider, model } = route
    this.audit('info', 'http.chat.stream.route', { reqId, sessionId, intent: intent.category, provider, model, resolved: route.resolved })

    // Phase 4: Sanitize input for CLOUD requests
    let messageToSend = message
    let didSanitize = false
    if (!isLocal && this.sanitizer) {
      try {
        const sanitizationResult = await this.sanitizer.sanitize(message, { sessionId })
        messageToSend = sanitizationResult.sanitizedText
        if (sanitizationResult.replacements.length > 0) {
          didSanitize = true
          this.audit('info', 'http.chat.stream.sanitized', {
            reqId,
            sessionId,
            replacementCount: sanitizationResult.replacements.length,
          })
        }
      } catch (err: any) {
        this.audit('error', 'http.chat.stream.sanitize.error', { reqId, sessionId, error: err.message })
      }
    }

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
          // Phase 4: Desanitize streamed text for CLOUD requests
          let textToSend = chunk.text
          if (!isLocal && this.sanitizer && didSanitize) {
            try {
              textToSend = this.sanitizer.desanitizeSync(chunk.text, sessionId)
            } catch {
              // If desanitize fails, send original text
            }
          }
          res.write(`data: ${JSON.stringify({ type: 'text', text: textToSend })}\n\n`)
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
      content: [{ type: 'text', text: messageToSend }],
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
    // Phase 4: Purge sanitizer mappings for deleted session
    if (this.sanitizer) {
      try {
        await this.sanitizer.purge(id)
      } catch (err: any) {
        this.audit('error', 'session.delete.sanitizer-purge.error', { sessionId: id, error: err.message })
      }
    }
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

/**
 * Pure (exported for unit tests) route resolver. See the inline comment
 * in HttpApiServiceImpl#resolveRoute for the soft-dep / fail-open contract.
 */
export function resolveRoute(
  ctx: any,
  isLocal: boolean,
): { provider: string; model: string; resolved: boolean } {
  const preferred = isLocal ? 'local-qwen3-4b' : 'cloud-deepseek-v4'
  const fallbackModel = isLocal
    ? (process.env.DSH_EDGE_LOCAL_LLM_MODEL ?? 'qwen3-4b-instruct-2507')
    : 'deepseek-chat'
  const mr = ctx?.modelRouter
  if (mr && typeof mr.resolve === 'function') {
    try {
      const r = mr.resolve(preferred)
      if (r && typeof r.provider === 'string' && typeof r.model === 'string') {
        return { provider: r.provider, model: r.model, resolved: true }
      }
    } catch {
      // fall through to hardcoded pair
    }
  }
  return { provider: preferred, model: fallbackModel, resolved: false }
}

export async function apply(ctx: any, config: Config): Promise<() => Promise<void>> {
  const agents = ctx.get('agents')
  const promptGuard = ctx.get('promptGuard')
  const auditLog = ctx.get('auditLog')
  const sanitizer = ctx.get('sanitizer')
  const tdBus = ctx.get?.('tdBus') ?? (ctx as any).tdBus
  console.log(`[http-api] apply() - promptGuard: ${!!promptGuard}, auditLog: ${!!auditLog}, sanitizer: ${!!sanitizer}, tdBus: ${!!tdBus}`)
  const service = new HttpApiServiceImpl(ctx, config, agents, promptGuard, auditLog, sanitizer, tdBus)
  await service.start()
  return async () => {
    await service.stop()
  }
}
