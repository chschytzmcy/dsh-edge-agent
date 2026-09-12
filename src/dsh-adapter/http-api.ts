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
import { redactString } from './pii-utils.js'
import { findRoute, type RouteDef, type RouteContext } from './http-api-routes.js'
import { HttpApiSessionsImpl, type HttpApiSessions } from './http-api-sessions.js'

/**
 * Snapshot a live Session's event log, papering over the upstream API
 * change: 0.1.2-alpha.x exposed `.events` directly, 0.1.2-rc.1 removed it
 * in favour of `Session.snapshotEvents()`. Mirror of dsh-tui's
 * `compat/liveSession.snapshotLiveSessionEvents`.
 */
function snapshotSessionEvents(session: { snapshotEvents?: () => readonly SessionEvent[]; events?: readonly SessionEvent[] }): readonly SessionEvent[] {
  if (typeof session.snapshotEvents === 'function') {
    return session.snapshotEvents()
  }
  if (Array.isArray(session.events)) return session.events
  return []
}

export const name = 'http-api'

export const inject = ['agents', 'intentRouter', 'auditLog', 'tdBus', 'realmSkillBridge', 'edgeTools'] as const

export interface Config {
  host: string
  port: number
  /** Bearer token required for all requests. */
  bearerToken?: string
  // NOTE: `requireAttestation` removed 2026-08-29 (dual-entry plan §3.1.1).
  // It was declared but never read (grep 0 references in this repo) — a
  // silent lie to operators. Attestation is an A5 milestone; we'll re-add
  // the field together with the real check, not as a decorative default.
  /** Session idle timeout in ms. Sessions not accessed within this are cleaned up. 0 = disabled. */
  sessionIdleTimeoutMs: number
  /** Maximum active sessions. LRU eviction when exceeded. 0 = unlimited. */
  maxActiveSessions: number
  /** Max JSON body bytes accepted by POST endpoints. Defense-in-depth against
   *  malicious clients sending unbounded bodies (the old `readJsonBody`
   *  appended every chunk into a single string with no upper bound, letting
   *  a remote attacker OOM the edge agent). Default 1 MiB; set to 0 to
   *  disable the cap (NOT recommended in production). */
  maxRequestBodyBytes: number
}

export const Config: Schema<Config> = Schema.object({
  host: Schema.string().default('127.0.0.1'),
  port: Schema.natural().default(21017),
  bearerToken: Schema.string(),
  sessionIdleTimeoutMs: Schema.natural().default(30 * 60 * 1000), // 30 min
  maxActiveSessions: Schema.natural().default(100),
  maxRequestBodyBytes: Schema.natural().default(1024 * 1024), // 1 MiB
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

/** Multi-turn context ring buffer for a session. Kept in a separate Map
 *  (NOT on SessionRecord) because the buffer must accept pushes BEFORE
 *  `ensureSession()` has constructed the record — the very first turn
 *  pushes its user message before any agent exists, otherwise the first
 *  user entry would silently drop and follow-up turns would see only
 *  the prior assistant reply (no leading user) — breaking the user/
 *  assistant alternation the router relies on for disambiguation.
 *  Length cap = MAX_RECENT_MESSAGES_PER_SESSION (6 = 3 pairs by default);
 *  older entries are evicted FIFO. Best-effort: on agent-loop failure the
 *  assistant entry may be missing. */

interface RecentMessage {
  role: 'user' | 'assistant'
  text: string
  ts: number
}

/** Max entries retained in SessionRecord.recentMessages. Must stay in sync
 *  with `intent-router.recentMessagesLimit` × 2 (the router reads the last
 *  `recentMessagesLimit` entries, so 3 pairs = 6 entries covers 3 user
 *  turns with their assistant responses). */
const MAX_RECENT_MESSAGES_PER_SESSION = 6

export class HttpApiServiceImpl extends Service {
  private server: Server | undefined
  private readonly sessions = new Map<string, SessionRecord>()
  /** Per-session ring buffer for multi-turn context. See RecentMessage for
   *  schema. Lives outside `sessions` so pushRecentMessage can accept writes
   *  before ensureSession() finishes (first-turn user message). */
  private readonly sessionBuffers = new Map<string, RecentMessage[]>()
  private running = false
  private intentRouter: any
  private realmSkillBridge: any
  private tdBus: any
  private cleanupTimer: ReturnType<typeof setInterval> | undefined
  /** Soft-dep wrapper for the upstream `sessions` plugin. See
   *  `./http-api-sessions.ts`. Constructed lazily in `start()` so the
   *  upstream plugin has time to register (boot-order race). */
  private sessionsHelper: HttpApiSessions = new HttpApiSessionsImpl(null)

  constructor(
    private cordisCtx: any,
    private config: Config,
    private agents: any,
    private auditLog: any,
    tdBus?: any,
  ) {
    super(cordisCtx, 'httpApi')
    this.tdBus = tdBus
    this.routes = this.buildRoutes()
  }

  /** Route table — built once at construction so handlers can reference
   *  the service via `this`. See `./http-api-routes.ts` for the matcher. */
  private readonly routes: RouteDef[]

  /** Emit an audit-log entry (silent no-op if missing or wrong API). */
  private audit(level: 'debug' | 'info' | 'warn' | 'error' | 'security', kind: string, payload: Record<string, unknown>): void {
    if (!this.auditLog || typeof this.auditLog.log !== 'function') {
      return
    }
    void this.auditLog.log({ level, kind, source: 'http-api', payload }).catch(() => {})
  }

  /** One-line access log (visible in /tmp/dsh.log via stdout exporter). */
  private accessLog(reqId: string, method: string, path: string, status: number, durationMs: number, extra?: string): void {
    this.ctx.logger?.info?.(`[http-api][${reqId}] ${method} ${path} ${status} ${durationMs}ms${extra ? ' ' + extra : ''}`)
  }

  /** Append a recent-message entry to the session's ring buffer. Evicts
   *  oldest entries when the buffer exceeds MAX_RECENT_MESSAGES_PER_SESSION.
   *  Trims text to 200 chars to bound prompt size (intent-router further
   *  truncates per-message inside the historyBlock). Always accepts the
   *  push — the buffer map is independent of SessionRecord, so it can be
   *  written to before ensureSession() finishes (first-turn user message)
   *  or after handleDeleteSession() drops the session (orphan cleanup
   *  happens on the next sweep). */
  private pushRecentMessage(sessionId: string, role: 'user' | 'assistant', text: string): void {
    const trimmed = text.trim().slice(0, 200)
    if (!trimmed) return
    let buf = this.sessionBuffers.get(sessionId)
    if (!buf) {
      buf = []
      this.sessionBuffers.set(sessionId, buf)
    }
    buf.push({ role, text: trimmed, ts: Date.now() })
    while (buf.length > MAX_RECENT_MESSAGES_PER_SESSION) {
      buf.shift()
    }
  }

  /** Read a snapshot of the session's recent-message ring buffer.
   *  Returns [] if the session has no history yet. The caller MUST take
   *  this snapshot BEFORE pushing the current user message — the router
   *  embeds the snapshot as the "history" block and appends the current
   *  query itself. */
  private getPriorRecentMessages(sessionId: string): RecentMessage[] {
    const buf = this.sessionBuffers.get(sessionId)
    return buf ? buf.slice() : []
  }

  /** Drop the buffer for a session. Called from handleDeleteSession,
   *  cleanupExpiredSessions, evictLeastRecentSession, and stop().
   *
   *  也负责清除 sanitizer 的会话映射表——那张表里存的是**明文 PII**，
   *  若只删 buffer 不 purge，PII 会一直驻留在堆里直到进程退出
   *  （2026-08-30 修复）。软依赖 + best-effort：sanitizer 未注册或
   *  purge 失败都不能影响会话删除本身。 */
  private dropSessionBuffer(sessionId: string): void {
    this.sessionBuffers.delete(sessionId)
    const sanitizer = (this.cordisCtx as unknown as {
      sanitizer?: { purge?(id: string): Promise<void> }
    }).sanitizer
    if (typeof sanitizer?.purge === 'function') {
      void Promise.resolve(sanitizer.purge(sessionId)).catch(() => {
        // 忽略：sanitizer 自身还有 TTL 清扫兜底
      })
    }
  }

  /**
   * Resolve the actual provider + model to use for a given intent verdict.
   * Falls back to the legacy hardcoded pair (`local-llm` /
   * `cloud-llm` plus env-overridable model) when:
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
        this.ctx.logger?.info?.('[http-api] intentRouter: found and valid')
      } else {
        this.ctx.logger?.info?.('[http-api] intentRouter: exists but invalid', router)
      }
    } catch (err: any) {
      this.ctx.logger?.warn?.('[http-api] Error getting intentRouter:', err?.message)
    }

    // Get realmSkillBridge after all plugins are loaded. Optional — older
    // cordis.yml configs may not mount it. When absent, Layer 1 (catalog
    // filtering) and Layer 3 (tool realm gating) silently no-op.
    try {
      const bridge = (this.cordisCtx as any).realmSkillBridge
      if (bridge && typeof bridge.setSessionRealm === 'function') {
        this.realmSkillBridge = bridge
        this.ctx.logger?.info?.('[http-api] realmSkillBridge: found and valid')
      }
    } catch (err: any) {
      this.ctx.logger?.warn?.('[http-api] realmSkillBridge: not available:', err?.message)
    }

    // Phase 5 diagnostic: dump the upstream tool registry so E2E can see
    // whether web_search / web_fetch are actually mounted. The Cordis proxy
    // throws when `tools` hasn't injected, so wrap defensively.
    try {
      const edgeTools = (this.cordisCtx as any).edgeTools
      if (edgeTools && typeof edgeTools.list === 'function') {
        const allTools = edgeTools.list()
        const names = allTools.map((t: any) => `${t.name}:${t.realm}`)
        this.ctx.logger?.info?.(`[http-api] edgeTools.list() → ${names.length} tools: ${names.join(', ')}`)
        const hasWebSearch = names.some((n: string) => n.startsWith('web_search:'))
        const hasWebFetch = names.some((n: string) => n.startsWith('web_fetch:'))
        this.ctx.logger?.info?.(`[http-api] web_search registered: ${hasWebSearch}, web_fetch registered: ${hasWebFetch}`)
      } else {
        this.ctx.logger?.info?.('[http-api] edgeTools: missing or invalid')
      }
    } catch (err: any) {
      this.ctx.logger?.warn?.('[http-api] Error reading edgeTools:', err?.message)
    }

    // Initialize the soft-dep sessions helper. The wrapper ducks-types
    // `cordisCtx.sessions` lazily so a missing upstream plugin just falls
    // back to in-memory metadata (tests run that way).
    this.sessionsHelper = new HttpApiSessionsImpl(this.cordisCtx)

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
      this.sessionBuffers.clear()
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
    const method = req.method ?? 'GET'
    const reqId = randomUUID().slice(0, 8)
    const start = Date.now()

    // OPTIONS preflight for the public read-only endpoints — returns 204
    // without auth. CORS is NOT enabled (see docs/dual-entry-architecture.md
    // §7.1), but loopback probes shouldn't get a 405 from a method-aware
    // match table.
    if (method === 'OPTIONS' && (path === '/v1/health' || path === '/v1/openapi.json')) {
      res.writeHead(204)
      res.end()
      this.accessLog(reqId, 'OPTIONS', path, 204, Date.now() - start)
      return
    }

    // First pass: try to match a public route (no auth required).
    const publicRoutes = this.routes.filter((r) => r.auth === 'public')
    let publicMatch = findRoute(publicRoutes, method, path)
    if (!publicMatch && method === 'HEAD') {
      // RFC 7231 §4.3.2: HEAD is identical to GET except no body.
      // curl -I / load-balancer probes are HEAD — fall back to GET so
      // liveness probes don't trip auth and pollute audit log.
      publicMatch = findRoute(publicRoutes, 'GET', path)
    }
    if (publicMatch) {
      await this.invokeRoute(publicMatch.route, publicMatch.params, req, res, reqId, start, method)
      return
    }

    // Second pass: auth-required routes. Bearer check first.
    if (!this.checkAuth(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      this.accessLog(reqId, method, path, 401, Date.now() - start, 'auth-fail')
      this.audit('warn', 'http.auth.fail', { reqId, method, path })
      return
    }

    const authedMatch = findRoute(this.routes.filter((r) => r.auth === 'bearer'), method, path)
    if (!authedMatch) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Not found' }))
      this.accessLog(reqId, method, path, 404, Date.now() - start)
      return
    }

    await this.invokeRoute(authedMatch.route, authedMatch.params, req, res, reqId, start, method)
  }

  /** Dispatch helper — builds the RouteContext (parsing the body only
   *  when the route declares `body: 'json'`), invokes the handler, and
   *  maps thrown errors to the right HTTP status code (mirrors the
   *  original if/else chain's error semantics). */
  private async invokeRoute(
    route: RouteDef,
    params: Record<string, string>,
    req: IncomingMessage,
    res: ServerResponse,
    reqId: string,
    start: number,
    method: string,
  ): Promise<void> {
    const ctx: RouteContext = { req, res, reqId, start, body: undefined }
    try {
      // Parse the body INSIDE the try block — readJsonBody tags errors
      // with statusCode (413 / 400) that the error mapper below turns
      // into the right HTTP response. Parsing outside the try would let
      // those rejections bubble up as uncaught.
      if (route.body === 'json') {
        ctx.body = await this.readJsonBody(req)
      }
      await route.handler(ctx, params)
    } catch (err: any) {
      const status = typeof err?.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 600
        ? err.statusCode
        : 500
      if (!res.headersSent) {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err.message ?? 'Internal error' }))
      } else {
        // SSE stream is already open; can't rewrite headers. Best we can
        // do is terminate so the client sees the error.
        try { res.end() } catch { /* socket may be gone */ }
      }
      this.accessLog(reqId, method, new URL(req.url ?? '/', `http://${req.headers.host}`).pathname, status, Date.now() - start, `err="${err.message ?? 'unknown'}"`)
      this.audit(status >= 500 ? 'error' : 'warn', 'http.error', { reqId, method, path: req.url, status, error: err.message })
    }
  }

  private checkAuth(req: IncomingMessage): boolean {
    if (!this.config.bearerToken) return true
    const auth = req.headers.authorization
    if (!auth) return false
    const [scheme, token] = auth.split(' ')
    return scheme === 'Bearer' && token === this.config.bearerToken
  }

  private async handleChat(req: IncomingMessage, res: ServerResponse, reqId: string, start: number, body: any): Promise<void> {
    const { message, sessionId: requestedSessionId } = body ?? {}
    if (!message || typeof message !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'message is required' }))
      this.accessLog(reqId, 'POST', '/v1/chat', 400, Date.now() - start, 'no-message')
      return
    }

    const sessionId = requestedSessionId ?? randomUUID()
    // §7.46.5 (2026-09-12): ops log 入口端点 — 让 "user 几时发的消息"
    // 在 ops log 可见。配对 [input-guard] preflight intent + chat finished
    // 形成完整 trace：收到 → 路由 → 调 LLM → 回复。messageLen 而非
    // message 内容（避免 PII 落 ops log）。
    try {
      this.ctx.logger?.info?.(
        `[http-api] chat received sessionId=${sessionId} reqId=${reqId} messageLen=${message.length}`,
      )
    } catch { /* debug only */ }
    // Defense-in-depth: redact PII from the audit preview. audit-log's own
    // enablePIIRedaction also redacts, but this survives misconfiguration of
    // that setting. redactString is synchronous and cheap. (2026-08-24 fix)
    const messagePreview = redactString(message.slice(0, 80)).redacted
    this.audit('info', 'http.chat.start', { reqId, sessionId, messageLen: message.length, messagePreview })

    // Phase D: td-bus threat gate (blockLevel default: critical)
    if (this.tdBus) {
      // Feed each request into td-bus so it can recompute threat level.
      // CLOUD-bound requests count heavier; LOCAL ones count lightly.
      // For Phase D we feed all requests equally — refinement can come later.
      try { this.tdBus.recordCloudRequest() } catch { /* never block on td-bus faults */ }

      if (typeof this.tdBus.shouldBlock === 'function' && this.tdBus.shouldBlock()) {
        const threat = typeof this.tdBus.getThreatLevel === 'function'
          ? this.tdBus.getThreatLevel() : 'critical'
        this.audit('security', 'http.chat.threat-blocked', { reqId, sessionId, threat, endpoint: '/v1/chat' })
        this.accessLog(reqId, 'POST', '/v1/chat', 503, Date.now() - start, 'threat-blocked')
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Service unavailable — threat level elevated', threat }))
        return
      }
    }

    // Snapshot the per-session history BEFORE pushing the current user message,
    // then push. The router embeds the snapshot as the "history" block and
    // appends the current query itself — passing the buffer that already
    // contains the current turn would cause prompt duplication.
    const priorMessages = this.getPriorRecentMessages(sessionId)
    this.pushRecentMessage(sessionId, 'user', message)

    // Classify intent using intent-router
    let intent: any = { category: 'CLOUD', confidence: 0, targetRealm: 'cloud', rationale: 'no-classifier' }
    if (this.intentRouter) {
      try {
        intent = await this.intentRouter.classify(message, {
          recentMessages: priorMessages,
          sessionId,
        })
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
    this.audit('info', 'http.chat.route', { reqId, sessionId, intent: intent.category, provider: route.provider, model: route.model, resolved: route.resolved, confidence: intent.confidence, rationale: intent.rationale })

    // 脱敏逻辑已由 input-guard 插件在 agent/pre-step hook 中统一处理。
    // http-api 不再做 sanitizer.sanitize 或降级策略 — 所有入口（http-api /
    // Web UI / CLI）共享同一套管线。sanitizer 失败时 input-guard 会阻断
    // agent-loop（fail-closed），不会泄露原始 PII。
    const { provider, model } = route

    // Tag session realm for Layer 1 (catalog filtering) and Layer 3 (tool gating).
    // Realm is derived from intent-router's classification. input-guard may further
    // refine routing (REJECT / SANITIZED) within agent-loop, but http-api's realm
    // tag is the first-pass routing signal.
    if (this.realmSkillBridge) {
      const realm = isLocal ? 'LOCAL' : (intent.category === 'SANITIZED' ? 'SANITIZED' : 'CLOUD')
      this.realmSkillBridge.setSessionRealm(sessionId, realm)
    }

    const record = await this.ensureSession(sessionId, provider, model)

    // Wait for turn completion by subscribing to session/event
    const turnEnd = new Promise<{ result: string; rejection?: { status: number; kind: string; reason: string; riskLevel?: string } }>((resolve) => {
      const dispose = this.cordisCtx.on('session/event', (session: any, event: SessionEvent) => {
        if (event.type === 'turn/end') {
          // 2026-08-30 fix: agent-loop 把 input-guard 的 `{ kind: 'reject' }`
          // 翻译成 `turnEnds = { kind: 'blocked' }` 时会丢掉 reason 字符串。
          // input-guard 改在 reject 时把 reason 写到 `agent._edgeRejection`，
          // 这里读它并把 blocked turn 转成 HTTP 400 / 403。
          // event shape: { type, seq, time, data: { turn, reason } }
          const blockedReason = (event as any).data?.reason
          if (blockedReason?.kind === 'blocked') {
            const edgeRej = (record.agent as any)._edgeRejection as
              | { kind: 'attack' | 'policy' | 'intent' | 'sanitizer'; reason: string; riskLevel?: string }
              | undefined
            // attack → 400（请求内容不安全）
            // policy / intent → 403（policy-rule:reject 同语义，与 http-api:465 短路对齐）
            // sanitizer → 503（系统故障而非 user 错）
            const status = edgeRej?.kind === 'attack' ? 400
              : edgeRej?.kind === 'sanitizer' ? 503
              : 403
            const reason = edgeRej?.reason ?? 'request blocked'
            this.audit('warn', 'http.chat.blocked', {
              reqId, sessionId, edgeRejection: edgeRej,
            })
            dispose()
            resolve({ result: '', rejection: { status, kind: edgeRej?.kind ?? 'unknown', reason, riskLevel: edgeRej?.riskLevel } })
            return
          }
          const events = snapshotSessionEvents(record.agent.session as any)
          const lastAssistant = events
            .filter((e) => e.type === 'assistant/message')
            .pop()

          const text = lastAssistant
            ? (lastAssistant as any).data.message.content
                .filter((b: any) => b.type === 'text')
                .map((b: any) => b.text)
                .join('')
            : ''

          // Append assistant reply to the multi-turn ring buffer so the
          // NEXT classify() in this session can see it as prior context.
          // Best-effort: if the buffer is already evicted (session gone),
          // pushRecentMessage is a no-op.
          if (text) this.pushRecentMessage(sessionId, 'assistant', text)

          dispose()
          resolve({ result: text })
        }
      })
    })

    // input-guard 会在 agent/pre-step 中对消息做脱敏处理。http-api 把原文
    // 送给 agent-loop，由 input-guard 按 routing 决定是否脱敏（CLOUD 路径）
    // 或直接放行（LOCAL 路径）。
    const userMessage = createUserMessage({
      content: [{ type: 'text', text: message }],
      source: { kind: 'user' },
    })

    // 把路由决策挂到 agent 实例上，让 input-guard 在 agent/pre-step 里读到，
    // 避免重复跑 intentRouter.classify()（每次 ~0.5-1s 的 Qwen3-4B 推理）。
    // input-guard 也通过 agent/_edgeRoute 知道原始 realm；sanitize 失败降级
    // 到 LOCAL 后，audit / response 可以展示 "原始 CLOUD → 降级 LOCAL"。
    ;(record.agent as any)._edgeRoute = {
      realm: isLocal ? 'LOCAL' : (intent.category === 'SANITIZED' ? 'SANITIZED' : 'CLOUD'),
      category: intent.category,
      provider: route.provider,
      model: route.model,
      confidence: intent.confidence,
      rationale: intent.rationale,
    }

    // Call followup - it's fire-and-forget, agent loop runs async
    record.agent.followup(userMessage)

    let turnResult = await turnEnd

    // 2026-08-30 fix: turn-end 是 blocked 时翻译成对应的非 200 状态。
    // attack → 400；policy/intent → 403（与 line 465 对齐）；sanitizer → 503。
    if (turnResult.rejection) {
      const r = turnResult.rejection
      const duration = Date.now() - start
      this.accessLog(reqId, 'POST', '/v1/chat', r.status, duration, `reject:${r.kind}:${r.reason}`)
      res.writeHead(r.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        sessionId,
        result: '',
        error: 'Request rejected',
        rejection: r,
        intent: {
          category: intent.category,
          targetRealm: intent.targetRealm,
          confidence: intent.confidence,
          rationale: intent.rationale,
        },
        duration,
      }))
      return
    }

    const result = turnResult.result

    // 脱敏恢复（desanitize）已由 input-guard 插件在 llm/stream hook 中统一处理。
    // 输出安全过滤（prompt-guard.checkOutput）也迁移到 input-guard，
    // 以便 Web UI / CLI / SDK 所有入口统一受益。http-api 不再做安全过滤。

    const duration = Date.now() - start
    // §7.46.5 (2026-09-12): ops log 响应端点 — 让 "user 几时收到回复" 在
    // ops log 可见。resultLen 而非 result 内容；rejection 路径有
    // accessLog (line 482/599) 已覆盖 status code + reason。
    try {
      this.ctx.logger?.info?.(
        `[http-api] chat reply sessionId=${sessionId} reqId=${reqId} provider=${provider} model=${model} durationMs=${duration} resultLen=${result.length} status=200 intent=${intent.category}`,
      )
    } catch { /* debug only */ }
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
      }),
    )
  }

  private async handleChatStream(req: IncomingMessage, res: ServerResponse, reqId: string, start: number, body: any): Promise<void> {
    const { message, sessionId: requestedSessionId } = body ?? {}
    if (!message || typeof message !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'message is required' }))
      this.accessLog(reqId, 'POST', '/v1/chat/stream', 400, Date.now() - start, 'no-message')
      return
    }

    const sessionId = requestedSessionId ?? randomUUID()
    this.audit('info', 'http.chat.stream.start', { reqId, sessionId, messageLen: message.length })

    // Phase D: td-bus threat gate — mirrors handleChat() so the streaming
    // endpoint is also covered by the elevated-rate short-circuit. SSE clients
    // would otherwise sidestep the /v1/chat 503 path entirely.
    if (this.tdBus) {
      try { this.tdBus.recordCloudRequest() } catch { /* never block on td-bus faults */ }
      if (typeof this.tdBus.shouldBlock === 'function' && this.tdBus.shouldBlock()) {
        const threat = typeof this.tdBus.getThreatLevel === 'function'
          ? this.tdBus.getThreatLevel() : 'critical'
        this.audit('security', 'http.chat.threat-blocked', { reqId, sessionId, threat, endpoint: '/v1/chat/stream' })
        this.accessLog(reqId, 'POST', '/v1/chat/stream', 503, Date.now() - start, 'threat-blocked')
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Service unavailable — threat level elevated', threat }))
        return
      }
    }

    // Snapshot per-session history BEFORE pushing the current user message;
    // router embeds the snapshot as the "history" block and appends the
    // current query itself. (See handleChat for full rationale.)
    const streamPriorMessages = this.getPriorRecentMessages(sessionId)
    this.pushRecentMessage(sessionId, 'user', message)

    // Classify intent (same as handleChat) so SSE routes to the correct LLM
    let intent: any = { category: 'CLOUD', confidence: 0, targetRealm: 'cloud', rationale: 'no-classifier' }
    if (this.intentRouter) {
      try {
        intent = await this.intentRouter.classify(message, {
          recentMessages: streamPriorMessages,
          sessionId,
        })
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
    this.audit('info', 'http.chat.stream.route', { reqId, sessionId, intent: intent.category, provider: route.provider, model: route.model, resolved: route.resolved })

    // 脱敏逻辑已由 input-guard 插件在 agent/pre-step hook 中统一处理。
    // http-api 不再做 sanitizer.sanitize 或降级策略 — 所有入口共享同一套管线。
    const { provider, model } = route

    // Tag session realm for Layer 1 (catalog filtering) and Layer 3 (tool gating).
    if (this.realmSkillBridge) {
      const realm = isLocal ? 'LOCAL' : (intent.category === 'SANITIZED' ? 'SANITIZED' : 'CLOUD')
      this.realmSkillBridge.setSessionRealm(sessionId, realm)
    }

    const record = await this.ensureSession(sessionId, provider, model)

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      // Disable nginx response buffering so chunks reach the client in real
      // time. Without this, deepseek-chat (long CLOUD turns, 60-90s+) gets
      // batched by an upstream proxy and the SSE stream feels frozen.
      'X-Accel-Buffering': 'no',
    })
    this.accessLog(reqId, 'POST', '/v1/chat/stream', 200, Date.now() - start, `${provider}/${model} intent=${intent.category}`)

    // Emit intent first so client knows the routing decision
    res.write(`data: ${JSON.stringify({ type: 'intent', intent: { category: intent.category, targetRealm: intent.targetRealm, confidence: intent.confidence, rationale: intent.rationale } })}\n\n`)

    // SSE keepalive: 15s comment frames so intermediate proxies with an
    // idle-disconnect timeout (nginx default 60s, Cloudflare 100s) don't
    // kill the connection mid-turn. The frame starts with `:` which makes
    // it an SSE comment — clients ignore it. We write `: keepalive <ts>`
    // (operator-readable in raw stream captures) rather than just `:`
    // for diagnostics.
    const keepaliveMs = 15_000
    const keepaliveTimer = setInterval(() => {
      // Best-effort write; if the socket is gone, write returns false and
      // we clear the timer on the next 'close' handler.
      try {
        if (!res.write(`: keepalive ${Date.now()}\n\n`)) {
          // backpressure — not a failure, just a hint to stop; ignore
        }
      } catch {
        clearInterval(keepaliveTimer)
      }
    }, keepaliveMs)
    if (typeof keepaliveTimer.unref === 'function') keepaliveTimer.unref()

    const dispose = this.cordisCtx.on('session/event', (_session: any, event: SessionEvent) => {
      if (event.type === 'assistant/chunk') {
        const chunk = (event as any).data.chunk
        if (chunk.type === 'text-delta') {
          // 脱敏恢复已由 input-guard 在 llm/stream hook 中对 session 内 chunks 统一处理。
          // http-api 只负责把 chunk 透传给 SSE 客户端。
          res.write(`data: ${JSON.stringify({ type: 'text', text: chunk.text })}\n\n`)
        }
      } else if (event.type === 'turn/end') {
        // 2026-08-30 fix: blocked turn → SSE error 事件。headers 已经
        // 200/text-event-stream 写过了，不能再改 status code，但 SSE
        // 客户端能解析 error 事件 → client 收到 kind: 'attack' 自行报错。
        // event shape: { type, seq, time, data: { turn, reason } }
        const blockedReason = (event as any).data?.reason
        if (blockedReason?.kind === 'blocked') {
          const edgeRej = (record.agent as any)._edgeRejection as
            | { kind: 'attack' | 'policy' | 'intent' | 'sanitizer'; reason: string; riskLevel?: string }
            | undefined
          const status = edgeRej?.kind === 'attack' ? 400
            : edgeRej?.kind === 'sanitizer' ? 503
            : 403
          this.accessLog(reqId, 'POST', '/v1/chat/stream', status, Date.now() - start, `reject:${edgeRej?.kind ?? 'unknown'}:${edgeRej?.reason ?? 'blocked'}`)
          res.write(`data: ${JSON.stringify({
            type: 'error',
            status,
            error: 'Request rejected',
            rejection: edgeRej ?? { kind: 'unknown', reason: 'blocked' },
          })}\n\n`)
          dispose()
          clearInterval(keepaliveTimer)
          res.end()
          return
        }
        // Pull the assembled assistant text from session.events to feed
        // the multi-turn ring buffer (mirrors handleChat). Best-effort:
        // skip push if the agent never produced an assistant/message
        // (e.g. tool-only turn).
        const lastAssistant = snapshotSessionEvents(record.agent.session as any)
          .filter((e: any) => e.type === 'assistant/message')
          .pop()
        const assistantText = lastAssistant
          ? (lastAssistant as any).data.message.content
              .filter((b: any) => b.type === 'text')
              .map((b: any) => b.text)
              .join('')
          : ''
        if (assistantText) this.pushRecentMessage(sessionId, 'assistant', assistantText)

        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`)
        const duration = Date.now() - start
        this.audit('info', 'http.chat.stream.end', { reqId, sessionId, provider, model, durationMs: duration })
        dispose()
        clearInterval(keepaliveTimer)
        res.end()
      }
    })

    // Client-disconnect cleanup — when the browser/network drops, both
    // 'close' and 'aborted' fire (Node emits 'close' after the underlying
    // socket is destroyed). Without this unsubscribe, every reconnect
    // leaves a stale session/event listener that accumulates on the
    // cordis context — memory leak under flaky-network clients. We also
    // clear the keepalive timer here; if write() above threw because the
    // socket was already gone, the close handler is the safety net.
    let cleanedUp = false
    const onClose = () => {
      if (cleanedUp) return
      cleanedUp = true
      clearInterval(keepaliveTimer)
      try { dispose() } catch { /* listener already removed */ }
      this.audit('debug', 'http.chat.stream.client-closed', { reqId, sessionId })
    }
    req.on('close', onClose)
    req.on('aborted', onClose)
    // Also end the stream cleanly when the response side closes (write
    // fails on a torn-down socket). Belt-and-braces.
    res.on('close', onClose)

    // input-guard 会在 agent/pre-step 中对消息做脱敏处理。http-api 把原文
    // 送给 agent-loop，由 input-guard 按 routing 决定是否脱敏。
    // 同步挂路由决策到 agent，让 input-guard 避免重复 classify。
    ;(record.agent as any)._edgeRoute = {
      realm: isLocal ? 'LOCAL' : (intent.category === 'SANITIZED' ? 'SANITIZED' : 'CLOUD'),
      category: intent.category,
      provider: route.provider,
      model: route.model,
      confidence: intent.confidence,
      rationale: intent.rationale,
    }
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

  /** GET /v1/models — returns the dispatcher's provider catalog. Backed
   *  by `modelRouter.listDetailed()`; falls back to a hardcoded pair
   *  when the router isn't registered (boot-order race; mirrors
   *  `resolveRoute()`'s soft-dep pattern at line ~1440).
   *
   *  Soft-dep: cordis throws on `ctx.<name>` when the row isn't in
   *  `inject`, so wrap the lookup in try/catch and fall back. */
  private handleListModels(res: ServerResponse): void {
    const ctx = this.cordisCtx
    let mr: any
    try {
      mr = typeof ctx?.get === 'function' ? ctx.get('modelRouter') : ctx?.modelRouter
    } catch {
      // Cordis throws on "without inject" — treat as "not yet registered"
      // and let the fallback below produce a usable response.
      mr = undefined
    }
    let models: Array<{ provider: string; realm: string; available: boolean }>
    if (mr && typeof mr.listDetailed === 'function') {
      models = mr.listDetailed()
    } else {
      // Fallback: enumerate the legacy hardcoded pair so external clients
      // can still discover at least the default routes.
      models = [
        { provider: 'local-llm', realm: 'LOCAL', available: true },
        { provider: 'cloud-llm', realm: 'CLOUD', available: true },
      ]
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ models }))
  }

  /** GET /v1/audit?since=&until=&kind=&level=&sessionId=&limit= — query
   *  the audit-log. The audit-log API already supports level/kind/sinceMs/
   *  untilMs/limit; we additionally filter on `payload.sessionId` post-
   *  hoc because sessionId lives in payload (audit entries don't have a
   *  first-class sessionId field — they're `(level, kind, source, payload)`
   *  records). Limit defaults to 50, hard cap 500, to keep response size
   *  bounded — the audit-log JSONL can be very large for long-running
   *  deployments.
   *
   *  Path leakage: this endpoint NEVER returns the audit file path —
   *  only structured entries. Operators wanting to inspect the raw JSONL
   *  should use the existing file-system route (the audit-log's config
   *  already publishes its root). */
  private async handleListAudit(url: URL, res: ServerResponse): Promise<void> {
    if (!this.auditLog || typeof this.auditLog.query !== 'function') {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'audit-log not available' }))
      return
    }
    const sinceStr = url.searchParams.get('since')
    const untilStr = url.searchParams.get('until')
    const kind = url.searchParams.get('kind') ?? undefined
    const level = url.searchParams.get('level') ?? undefined
    const sessionId = url.searchParams.get('sessionId') ?? undefined
    const limitStr = url.searchParams.get('limit')

    let sinceMs: number | undefined
    let untilMs: number | undefined
    if (sinceStr) {
      const n = Number(sinceStr)
      if (!Number.isFinite(n)) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'since must be a number (ms epoch)' }))
        return
      }
      sinceMs = n
    }
    if (untilStr) {
      const n = Number(untilStr)
      if (!Number.isFinite(n)) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'until must be a number (ms epoch)' }))
        return
      }
      untilMs = n
    }
    let limit: number | undefined
    if (limitStr) {
      const n = Number(limitStr)
      if (!Number.isFinite(n) || n <= 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'limit must be a positive number' }))
        return
      }
      limit = Math.min(Math.floor(n), 500) // hard cap 500
    } else {
      limit = 50 // sensible default
    }

    let entries = await this.auditLog.query({
      level: level as any,
      kind,
      sinceMs,
      untilMs,
      limit,
    })
    if (sessionId) {
      entries = entries.filter((e: any) => e?.payload?.sessionId === sessionId)
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ entries, count: entries.length, limit }))
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
    this.dropSessionBuffer(id)
    // Best-effort persistence delete. Failures don't block the 204 — the
    // next process restart will see an orphan upstream record, which is
    // recoverable (it's metadata, not the live agent state).
    void this.sessionsHelper.deleteSession(id).catch(() => {})
    // input-guard 使用 WeakMap<Session, State> 维护脱敏状态，session dispose
    // 后自动回收，无需显式 purge。
    this.audit('info', 'session.deleted', { sessionId: id })
    res.writeHead(204)
    res.end()
  }

  /** POST /v1/sessions/{id}/cancel — best-effort cancel of any in-flight
   *  turn on this session. Currently implemented by disposing the live
   *  AgentHandle (same as DELETE); the session record is removed from
   *  the in-memory map but persisted metadata is retained so /v1/sessions
   *  still shows the historical record. Returns 202 Accepted to signal
   *  async semantics (the actual abort may race the next chunk). */
  private async handleCancelSession(id: string, res: ServerResponse): Promise<void> {
    const record = this.sessions.get(id)
    if (!record) {
      // Even when not in-memory, the persistence layer may know about it.
      // We treat that as "already canceled" — idempotent cancel is safer
      // than a 404 when the underlying agent has already exited.
      void this.sessionsHelper.cancelSession(id).catch(() => {})
      res.writeHead(202, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ sessionId: id, canceled: true, status: 'no-active-handle' }))
      return
    }
    await record.handle.dispose().catch(() => { /* best-effort */ })
    this.sessions.delete(id)
    this.dropSessionBuffer(id)
    void this.sessionsHelper.cancelSession(id).catch(() => {})
    this.audit('info', 'session.canceled', { sessionId: id })
    res.writeHead(202, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ sessionId: id, canceled: true, status: 'aborted' }))
  }

  /** POST /v1/sessions/{id}/rename — body `{ title }`. Updates the
   *  human-readable title in the persistence layer; the in-memory map
   *  is intentionally not the source of truth (titles survive restarts). */
  private async handleRenameSession(id: string, body: any, res: ServerResponse): Promise<void> {
    const title = body?.title
    if (typeof title !== 'string' || title.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'title is required (non-empty string)' }))
      return
    }
    if (title.length > 200) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'title must be ≤ 200 chars' }))
      return
    }
    // Verify the session is known to the in-memory map OR persistence layer.
    const inMemory = this.sessions.has(id)
    if (!inMemory) {
      const meta = await this.sessionsHelper.getSession(id).catch(() => null)
      if (!meta) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Session not found' }))
        return
      }
    }
    await this.sessionsHelper.renameSession(id, title)
    this.audit('info', 'session.renamed', { sessionId: id, title })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ sessionId: id, title }))
  }

  /** POST /v1/sessions/{id}/fork — body `{ atMessageIndex? }` (optional
   *  index into the recent-message ring buffer to fork from; defaults
   *  to "everything"). Creates a fresh session record and copies the
   *  source's recent messages (truncated at the requested index) into
   *  the new session's ring buffer. The live AgentHandle is NOT copied —
   *  the forked session starts fresh; the next followup() on it spins
   *  up a new agent. This is the same semantics as the DSH webui's
   *  `sessions.fork` RPC. Returns 201 Created with the new sessionId. */
  private async handleForkSession(id: string, body: any, res: ServerResponse): Promise<void> {
    const sourceRecord = this.sessions.get(id)
    const sourceMeta = await this.sessionsHelper.getSession(id).catch(() => null)
    if (!sourceRecord && !sourceMeta) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Session not found' }))
      return
    }
    const forkResult = await this.sessionsHelper.forkSession({
      sourceSessionId: id,
    })
    const newSessionId = forkResult.sessionId

    // Copy the recent-message ring buffer (truncated to atMessageIndex
    // when present). This gives the forked session the prior context so
    // the next classify() sees a coherent history.
    if (sourceRecord) {
      const sourceBuf = this.sessionBuffers.get(id) ?? []
      const idx = typeof body?.atMessageIndex === 'number'
        ? Math.max(0, Math.min(body.atMessageIndex, sourceBuf.length))
        : sourceBuf.length
      const copied = sourceBuf.slice(0, idx)
      this.sessionBuffers.set(newSessionId, copied)
    }

    this.audit('info', 'session.forked', {
      sourceSessionId: id,
      newSessionId,
      copiedMessages: this.sessionBuffers.get(newSessionId)?.length ?? 0,
    })
    res.writeHead(201, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      sessionId: newSessionId,
      sourceSessionId: id,
    }))
  }

  /**
   * Resolve the preset id one new session will run under and the `setup` hook
   * that mounts it. Returns `{}` when the deployment has no agent-presets
   * roster (bare dsh CLI without dsh-agent-presets installed) — agents then
   * run on the host composition, which is the pre-preset behaviour.
   *
   * Mirrors dsh-tui's `composePreset()` (lib/types/dsh-adapter/presets.js:35).
   * The original signature is in dsh-tui's private module surface, so we
   * inline a minimal version here: `resolve()` (exact roster match) +
   * `mount(agentCtx, id)` are the two public calls every implementation
   * exposes.
   */
  private async composeAgentPreset(): Promise<{ agentPreset?: string; setup?: (agentCtx: unknown) => Promise<void> }> {
    const presets = (this.ctx as unknown as { get?: (k: string) => unknown }).get?.('agentPresets') as
      | { resolve?: (id?: string) => Promise<{ id: string }>; mount?: (agentCtx: unknown, id: string) => Promise<unknown> }
      | undefined
    if (presets === undefined || typeof presets.resolve !== 'function' || typeof presets.mount !== 'function') {
      return {}
    }
    let resolvedId: string
    try {
      resolvedId = (await presets.resolve(undefined)).id
    }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.ctx.logger?.warn?.(`[http-api] agent preset (default) unavailable (${reason}) — composing session without a preset`)
      return {}
    }
    return {
      agentPreset: resolvedId,
      setup: async (agentCtx: unknown) => {
        await presets.mount!(agentCtx, resolvedId)
      },
    }
  }

  private async ensureSession(sessionId: string, provider?: string, model?: string): Promise<SessionRecord> {
    let record = this.sessions.get(sessionId)
    if (!record) {
      // Check max active sessions and evict LRU if needed
      if (this.config.maxActiveSessions > 0 && this.sessions.size >= this.config.maxActiveSessions) {
        await this.evictLeastRecentSession()
      }
      this.ctx.logger?.info?.(`[http-api] Creating agent with provider=${provider}, model=${model}`)
      // §7.38 (2026-09-04): compose preset before agents.create() so the agent
      // joins the standard preset (tools + skills + prompt sections).
      // Without this, dsh-agent-presets logs
      //   "agent <id> was published without joining an agent preset; its
      //    tools, prompt sections, and skill catalog resolve against the
      //    empty global layer"
      // and the resulting agent emits empty `result` (LLM has no tools/prompts).
      // Mirrors dsh-tui's composePreset() (lib/types/dsh-adapter/presets.js:35).
      // Roster absence (bare dsh CLI without dsh-agent-presets) is the
      // pre-preset fallback — agents get host composition instead, which is
      // what ran before §7.38 landed.
      const composed = await this.composeAgentPreset()
      const handle = await this.agents.create({
        sessionId: SessionId(sessionId),
        agentOptions: {
          provider: provider ?? 'local-llm',
          model: model ?? 'qwen3-4b',
        },
        meta: {
          cwd: process.cwd(),
          // Durable header — a later resume re-mounts exactly this preset.
          ...(composed.agentPreset === undefined ? {} : { agentPreset: composed.agentPreset }),
        },
        // Mounts the preset's tools/skills/sections onto the agent's scope.
        // Without setup, dsh-agent warns "agent … was published without
        // joining an agent preset" and the agent runs on empty global layer.
        ...(composed.setup === undefined ? {} : { setup: composed.setup }),
      })
      this.ctx.logger?.info?.(`[http-api] Agent created successfully`)
      const now = Date.now()
      record = {
        agent: handle.agent,
        handle,
        createdAt: now,
        lastAccessedAt: now,
      }
      this.sessions.set(sessionId, record)
      // Persist metadata via the soft-dep sessions helper. Fire-and-forget:
      // persistence failures must never block chat round-trip — the
      // in-memory map is the source of truth for the live process.
      void this.sessionsHelper.createSession({ sessionId, provider, model }).catch(() => {})
      this.audit('info', 'session.created', { sessionId, provider, model, totalSessions: this.sessions.size })
    } else {
      // Update last accessed time
      record.lastAccessedAt = Date.now()
    }
    return record!
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
        this.dropSessionBuffer(id)
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
        this.dropSessionBuffer(oldest.id)
        this.audit('info', 'session.evicted', {
          sessionId: oldest.id,
          reason: 'max-active-sessions-reached',
          idleMs: Date.now() - oldest.lastAccessedAt,
        })
      }
    }
  }

  private async readJsonBody(req: IncomingMessage): Promise<any> {
    // Defense-in-depth: cap the body size to avoid OOM from malicious clients
    // sending unbounded bodies. Per-chunk byte counting stops the connection
    // the moment the cap is breached, before `data` accumulates further.
    // Errors carry `statusCode` so the outer handler can return the right HTTP
    // code: 413 for body-too-large, 400 for malformed JSON.
    const cap = this.config.maxRequestBodyBytes
    return new Promise((resolve, reject) => {
      let data = ''
      let totalBytes = 0
      let aborted = false
      const abort = (err: Error & { statusCode?: number }): void => {
        if (aborted) return
        aborted = true
        // best-effort: tear down the socket so the attacker can't keep streaming
        try { req.destroy(err) } catch { /* ignore */ }
        reject(err)
      }
      req.on('data', (chunk: Buffer | string) => {
        if (aborted) return
        const buf = typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf-8') : chunk.length
        totalBytes += buf
        if (cap > 0 && totalBytes > cap) {
          const err: Error & { statusCode?: number } = new Error(`request body exceeds maxRequestBodyBytes=${cap}`)
          err.statusCode = 413
          abort(err)
          return
        }
        data += chunk
      })
      req.on('end', () => {
        if (aborted) return
        if (!data) { resolve({}); return }
        try {
          resolve(JSON.parse(data))
        } catch (err: any) {
          const wrapped: Error & { statusCode?: number; cause?: unknown } = new Error(`malformed JSON body: ${err?.message ?? 'parse failed'}`)
          wrapped.statusCode = 400
          wrapped.cause = err
          reject(wrapped)
        }
      })
      req.on('error', (err) => abort(err))
    })
  }

  private getOpenApiSpec(): object {
    // Derive the OpenAPI paths from the route table (single source of
    // truth). Per-route handler-specific bodies (chat message schema,
    // rename payload, fork body) are kept in a small lookup below so the
    // table stays focused on routing semantics.
    const chatRequestBody = {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              message: { type: 'string', description: 'User message text; subject to input-guard sanitize on CLOUD paths.' },
              sessionId: { type: 'string', description: 'Optional. Omit to start a fresh session; pass an existing id to continue a multi-turn conversation.' },
            },
            required: ['message'],
          },
        },
      },
    }
    const chatResponses = {
      '200': { description: 'Chat response with final assistant text and intent metadata.' },
      '400': { description: 'Bad request — message missing or malformed body.' },
      '401': { description: 'Unauthorized — missing or invalid bearer token.' },
      '403': { description: 'Forbidden — intent REJECT (privacy-policy rule).' },
      '413': { description: 'Payload Too Large — body exceeds maxRequestBodyBytes.' },
      '503': { description: 'Service Unavailable — td-bus threat gate active.' },
    }
    const streamResponses = {
      ...chatResponses,
      '200': { description: 'SSE stream: intent → text chunks → done. Includes 15s `: keepalive` comment frames.' },
    }
    const sessionPathParams = (idParam: string) => [{
      name: idParam,
      in: 'path',
      required: true,
      schema: { type: 'string' },
      description: 'Session id (UUID v4).',
    }]
    const renameBody = {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: { title: { type: 'string', maxLength: 200 } },
            required: ['title'],
          },
        },
      },
    }
    const forkBody = {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              atMessageIndex: { type: 'integer', minimum: 0, description: 'Truncate the copied recent-message ring buffer at this index. Omit to copy everything.' },
              newSessionId: { type: 'string', description: 'Optional override; defaults to a fresh UUID.' },
            },
          },
        },
      },
    }
    const auditQueryParams = [
      { name: 'since', in: 'query', schema: { type: 'integer' }, description: 'Filter: ts >= since (ms epoch).' },
      { name: 'until', in: 'query', schema: { type: 'integer' }, description: 'Filter: ts <= until (ms epoch).' },
      { name: 'kind', in: 'query', schema: { type: 'string' }, description: 'Filter by event kind (e.g. "http.chat.start").' },
      { name: 'level', in: 'query', schema: { type: 'string', enum: ['debug', 'info', 'warn', 'error', 'security'] } },
      { name: 'sessionId', in: 'query', schema: { type: 'string' }, description: 'Filter by payload.sessionId (post-hoc — payload-side filter).' },
      { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500 }, description: 'Default 50; hard cap 500.' },
    ]

    // Per-route summary overrides (the route table already carries a
    // short summary; this map adds request bodies and richer descriptions).
    const pathExtras: Record<string, Record<string, unknown>> = {
      '/v1/chat': {
        post: {
          requestBody: chatRequestBody,
          responses: chatResponses,
        },
      },
      '/v1/chat/stream': {
        post: {
          requestBody: chatRequestBody,
          responses: streamResponses,
        },
      },
      '/v1/sessions/{id}': {
        get: {
          parameters: sessionPathParams('id'),
          responses: { '200': { description: 'Session metadata' }, '404': { description: 'Session not found' } },
        },
        delete: {
          parameters: sessionPathParams('id'),
          responses: { '204': { description: 'Deleted' }, '404': { description: 'Session not found' } },
        },
      },
      '/v1/sessions/{id}/cancel': {
        post: {
          parameters: sessionPathParams('id'),
          responses: { '202': { description: 'Cancel accepted — best-effort abort.' } },
        },
      },
      '/v1/sessions/{id}/rename': {
        post: {
          parameters: sessionPathParams('id'),
          requestBody: renameBody,
          responses: { '200': { description: 'Renamed' }, '400': { description: 'title missing or too long' }, '404': { description: 'Session not found' } },
        },
      },
      '/v1/sessions/{id}/fork': {
        post: {
          parameters: sessionPathParams('id'),
          requestBody: forkBody,
          responses: { '201': { description: 'Forked — returns new sessionId' }, '404': { description: 'Session not found' } },
        },
      },
      '/v1/models': {
        get: {
          responses: { '200': { description: 'Provider catalog with realm metadata.' } },
        },
      },
      '/v1/audit': {
        get: {
          parameters: auditQueryParams,
          responses: { '200': { description: 'Audit entries (newest-first, capped at limit).' }, '400': { description: 'Invalid filter parameter' } },
        },
      },
    }

    const paths: Record<string, any> = {}
    for (const route of this.routes) {
      // OpenAPI placeholders don't accept `{id}`; map to `{id}` already
      // matches, but for the audit endpoint we need an empty method-key
      // bucket. Initialize on first encounter.
      if (!paths[route.pattern]) paths[route.pattern] = {}
      const op: Record<string, unknown> = { summary: route.summary }
      if (route.body === 'json') {
        op.requestBody = {
          content: { 'application/json': { schema: { type: 'object' } } },
        }
      }
      // Apply extras (which may add parameters, requestBody, richer responses).
      const extra = pathExtras[route.pattern]?.[route.method.toLowerCase()] as Record<string, unknown> | undefined
      const responses = extra?.responses ?? { '200': { description: 'OK' } }
      const merged: Record<string, unknown> = extra
        ? { ...op, ...extra, summary: op.summary, responses }
        : { ...op, responses }
      paths[route.pattern][route.method.toLowerCase()] = merged
    }

    return {
      openapi: '3.0.0',
      info: {
        title: 'dsh-edge-agent HTTP API',
        version: '1.1.0',
        description: 'Program-side entry point for the dsh-edge-agent. Browser users should use the DSH official Web UI at :21018 — see docs/dual-entry-architecture.md.',
      },
      paths,
    }
  }

  /** Build the route table — public + bearer-auth. Returns an array of
   *  RouteDef entries; the dispatcher (handleRequest) walks it to
   *  resolve method+path → handler. Built once at construction; the
   *  table is therefore stable across the service's lifetime, which
   *  lets future optimization (route hot-reload, per-route metrics) hook
   *  in at a single construction site. */
  private buildRoutes(): RouteDef[] {
    const svc = this
    return [
      // ── Public (no auth) ────────────────────────────────────────────
      {
        method: 'GET',
        pattern: '/v1/health',
        auth: 'public',
        summary: 'Liveness probe',
        handler: async (ctx) => {
          ctx.res.writeHead(200, { 'Content-Type': 'application/json' })
          ctx.res.end(JSON.stringify({ status: 'ok' }))
          svc.accessLog(ctx.reqId, 'GET', '/v1/health', 200, Date.now() - ctx.start)
        },
      },
      {
        method: 'GET',
        pattern: '/v1/openapi.json',
        auth: 'public',
        summary: 'OpenAPI 3.0 spec for this API',
        handler: async (ctx) => {
          ctx.res.writeHead(200, { 'Content-Type': 'application/json' })
          ctx.res.end(JSON.stringify(svc.getOpenApiSpec()))
          svc.accessLog(ctx.reqId, 'GET', '/v1/openapi.json', 200, Date.now() - ctx.start)
        },
      },

      // ── Bearer-auth chat ─────────────────────────────────────────────
      {
        method: 'POST',
        pattern: '/v1/chat',
        auth: 'bearer',
        body: 'json',
        summary: 'Synchronous chat — returns the final assistant text after the turn completes',
        handler: async (ctx) => svc.handleChat(ctx.req, ctx.res, ctx.reqId, ctx.start, ctx.body),
      },
      {
        method: 'POST',
        pattern: '/v1/chat/stream',
        auth: 'bearer',
        body: 'json',
        summary: 'Streaming chat — SSE response with intent/text/done events',
        handler: async (ctx) => svc.handleChatStream(ctx.req, ctx.res, ctx.reqId, ctx.start, ctx.body),
      },

      // ── Bearer-auth metadata ─────────────────────────────────────────
      {
        method: 'GET',
        pattern: '/v1/models',
        auth: 'bearer',
        summary: 'List available LLM providers (LOCAL + CLOUD) with realm metadata',
        handler: async (ctx) => {
          svc.handleListModels(ctx.res)
          svc.accessLog(ctx.reqId, 'GET', '/v1/models', 200, Date.now() - ctx.start)
        },
      },
      {
        method: 'GET',
        pattern: '/v1/audit',
        auth: 'bearer',
        summary: 'Query the audit log; supports since/until/kind/level/sessionId/limit',
        handler: async (ctx) => {
          const url = new URL(ctx.req.url ?? '/', `http://${ctx.req.headers.host ?? 'localhost'}`)
          await svc.handleListAudit(url, ctx.res)
          svc.accessLog(ctx.reqId, 'GET', '/v1/audit', 200, Date.now() - ctx.start)
        },
      },

      // ── Bearer-auth session management ───────────────────────────────
      {
        method: 'GET',
        pattern: '/v1/sessions',
        auth: 'bearer',
        summary: 'List active sessions (LRU order)',
        handler: async (ctx) => {
          svc.handleListSessions(ctx.res)
          svc.accessLog(ctx.reqId, 'GET', '/v1/sessions', 200, Date.now() - ctx.start)
        },
      },
      {
        method: 'GET',
        pattern: '/v1/sessions/{id}',
        auth: 'bearer',
        summary: 'Get session metadata by id',
        handler: async (ctx, params) => {
          svc.handleGetSession(params.id, ctx.res)
          svc.accessLog(ctx.reqId, 'GET', `/v1/sessions/${params.id}`, 200, Date.now() - ctx.start)
        },
      },
      {
        method: 'DELETE',
        pattern: '/v1/sessions/{id}',
        auth: 'bearer',
        summary: 'Delete session and release its AgentHandle',
        handler: async (ctx, params) => {
          await svc.handleDeleteSession(params.id, ctx.res)
          svc.accessLog(ctx.reqId, 'DELETE', `/v1/sessions/${params.id}`, 204, Date.now() - ctx.start)
        },
      },
      {
        method: 'POST',
        pattern: '/v1/sessions/{id}/cancel',
        auth: 'bearer',
        summary: 'Cancel an in-flight turn — best-effort abort of the live AgentHandle (202 Accepted)',
        handler: async (ctx, params) => {
          await svc.handleCancelSession(params.id, ctx.res)
          svc.accessLog(ctx.reqId, 'POST', `/v1/sessions/${params.id}/cancel`, 202, Date.now() - ctx.start)
        },
      },
      {
        method: 'POST',
        pattern: '/v1/sessions/{id}/rename',
        auth: 'bearer',
        body: 'json',
        summary: 'Rename a session — body `{ title }` (≤ 200 chars); persisted via the soft-dep sessions helper',
        handler: async (ctx, params) => {
          await svc.handleRenameSession(params.id, ctx.body, ctx.res)
          svc.accessLog(ctx.reqId, 'POST', `/v1/sessions/${params.id}/rename`, 200, Date.now() - ctx.start)
        },
      },
      {
        method: 'POST',
        pattern: '/v1/sessions/{id}/fork',
        auth: 'bearer',
        body: 'json',
        summary: 'Fork a session into a new sessionId; copies recent-message ring buffer (201 Created)',
        handler: async (ctx, params) => {
          await svc.handleForkSession(params.id, ctx.body, ctx.res)
          svc.accessLog(ctx.reqId, 'POST', `/v1/sessions/${params.id}/fork`, 201, Date.now() - ctx.start)
        },
      },
    ]
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
  const preferred = isLocal ? 'local-llm' : 'cloud-llm'
  const fallbackModel = isLocal
    ? (process.env.DSH_EDGE_LOCAL_LLM_MODEL ?? 'qwen3-4b-instruct-2507')
    : 'deepseek-chat'
  const mr = typeof ctx?.get === 'function' ? (() => { try { return ctx.get('modelRouter') } catch { return undefined } })() : ctx?.modelRouter
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
  const auditLog = ctx.get('auditLog')
  const tdBus = ctx.get?.('tdBus')
  ctx.logger?.info?.(`[http-api] apply() - auditLog: ${!!auditLog}, tdBus: ${!!tdBus}`)
  const service = new HttpApiServiceImpl(ctx, config, agents, auditLog, tdBus)
  await service.start()
  return async () => {
    await service.stop()
  }
}
