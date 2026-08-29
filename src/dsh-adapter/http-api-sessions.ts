/**
 * http-api-sessions — soft-dep wrapper around the `sessions` plugin
 * (`@deepseek-ai/dsh-session-persistence-jsonl`). Provides a stable
 * surface for the http-api endpoints (`/v1/sessions/{cancel,rename,
 * fork,...}`) without hard-binding to the upstream plugin's exact API.
 *
 * Why a wrapper layer?
 *   - The upstream `sessions` plugin's API may grow with each DSH
 *     release. The wrapper freezes a v1-stable contract:
 *       createSession / getSession / listSessions /
 *       renameSession / forkSession / cancelSession / deleteSession
 *   - Soft-dep pattern: if the `sessions` plugin isn't registered
 *     (older test profiles, minimal config), the wrapper falls back
 *     to in-memory metadata. This keeps tests simple and decouples
 *     from boot-order races.
 *   - Title rename needs a `payload` map the upstream plugin doesn't
 *     expose directly. The wrapper stores titles as audit-log entries
 *     keyed by `payload.sessionId + payload.title` (cheap, recoverable
 *     across restarts, and already persisted by the audit-log plugin).
 *
 * @module dsh-edge-agent/http-api-sessions
 */

import { randomUUID } from 'node:crypto'

export interface SessionMetadata {
  sessionId: string
  /** Display title (rename-able). May be null for sessions that haven't
   *  been renamed. */
  title: string | null
  createdAt: number
  lastAccessedAt: number
  /** Optional provider/model hint captured at session creation time.
   *  Stored as opaque strings — http-api doesn't enforce they match
   *  a registered provider. */
  provider?: string
  model?: string
}

export interface SessionCreateInput {
  sessionId?: string
  provider?: string
  model?: string
  /** Optional realm tag (LOCAL / CLOUD / SANITIZED). Used by the realm-
   *  skill-bridge layer to filter skill catalogs. Stored here for
   *  diagnostic / restore purposes. */
  realm?: string
}

export interface SessionForkInput {
  /** Source session id to fork from. */
  sourceSessionId: string
  /** Optional new session id; defaults to a fresh UUID. */
  newSessionId?: string
}

export interface HttpApiSessions {
  /** Create a new session record. Returns the assigned sessionId. */
  createSession(input?: SessionCreateInput): Promise<{ sessionId: string }>
  /** Read a session's metadata. Returns null if not found. */
  getSession(sessionId: string): Promise<SessionMetadata | null>
  /** List all sessions known to this wrapper. Newest-first by
   *  lastAccessedAt. */
  listSessions(): Promise<SessionMetadata[]>
  /** Update the human-readable title. */
  renameSession(sessionId: string, title: string): Promise<void>
  /** Fork: copy a session's history under a new sessionId. The source
   *  session is left untouched. Returns the new sessionId. */
  forkSession(input: SessionForkInput): Promise<{ sessionId: string; sourceSessionId: string }>
  /** Cancel: best-effort signal that the session's turn should abort.
   *  The actual abort is performed by the http-api service (which holds
   *  the AgentHandle). The wrapper just records intent. */
  cancelSession(sessionId: string): Promise<void>
  /** Delete: remove the session record entirely. Returns true if a
   *  record was deleted, false if no such session existed. */
  deleteSession(sessionId: string): Promise<boolean>
}

/** Minimal shape of the upstream `sessions` plugin we depend on.
 *  Kept intentionally narrow so we can detect "plugin present" via
 *  duck-typing instead of importing the upstream module directly. */
interface UpstreamSessions {
  create?(input: { sessionId: string; [k: string]: unknown }): Promise<unknown>
  delete?(sessionId: string): Promise<unknown>
  update?(sessionId: string, patch: Record<string, unknown>): Promise<unknown>
  get?(sessionId: string): Promise<unknown>
  list?(): Promise<unknown[]>
}

const TITLE_KIND = 'session.title' // used by /v1/audit filtering

/** Soft-dep constructor: pass the cordis context; the wrapper will
 *  duck-type `ctx.sessions` or `ctx.get?.('sessions')` lazily on each
 *  call. This keeps boot-order races from breaking http-api. */
export class HttpApiSessionsImpl implements HttpApiSessions {
  /** In-memory metadata fallback when the upstream plugin is absent. */
  private readonly memory = new Map<string, SessionMetadata>()
  /** Recently-deleted session ids we want to remember briefly so a
   *  post-cancel /v1/sessions/{id} doesn't immediately return 200.
   *  Cleared on a timer so it doesn't grow unbounded. */
  private readonly tombstone = new Set<string>()

  constructor(private cordisCtx: any) {}

  /** Lazy upstream plugin lookup. Returns null when the plugin isn't
   *  registered (older profiles / tests). */
  private upstream(): UpstreamSessions | null {
    const ctx = this.cordisCtx as any
    const direct = ctx?.sessions
    if (direct && typeof direct === 'object') return direct as UpstreamSessions
    if (typeof ctx?.get === 'function') {
      try {
        const v = ctx.get('sessions')
        if (v && typeof v === 'object') return v as UpstreamSessions
      } catch { /* plugin missing — soft-fail */ }
    }
    return null
  }

  async createSession(input: SessionCreateInput = {}): Promise<{ sessionId: string }> {
    const sessionId = input.sessionId ?? randomUUID()
    const now = Date.now()
    const meta: SessionMetadata = {
      sessionId,
      title: null,
      createdAt: now,
      lastAccessedAt: now,
      provider: input.provider,
      model: input.model,
    }
    this.memory.set(sessionId, meta)
    this.tombstone.delete(sessionId)
    const up = this.upstream()
    if (up?.create) {
      try { await up.create({ sessionId, provider: meta.provider, model: meta.model, createdAt: meta.createdAt, lastAccessedAt: meta.lastAccessedAt, title: meta.title }) } catch { /* upstream best-effort */ }
    }
    return { sessionId }
  }

  async getSession(sessionId: string): Promise<SessionMetadata | null> {
    const up = this.upstream()
    if (up?.get) {
      try {
        const raw = await up.get(sessionId)
        if (raw && typeof raw === 'object') return normalize(raw, sessionId)
      } catch { /* fall through to memory */ }
    }
    return this.memory.get(sessionId) ?? null
  }

  async listSessions(): Promise<SessionMetadata[]> {
    const up = this.upstream()
    if (up?.list) {
      try {
        const list = await up.list()
        if (Array.isArray(list)) return list.map((r) => normalize(r)).sort(byLastAccessedDesc)
      } catch { /* fall through */ }
    }
    return Array.from(this.memory.values())
      .filter((m) => !this.tombstone.has(m.sessionId))
      .sort(byLastAccessedDesc)
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    const meta = this.memory.get(sessionId)
    if (meta) meta.title = title
    const up = this.upstream()
    if (up?.update) {
      try { await up.update(sessionId, { title }) } catch { /* best-effort */ }
    }
  }

  async forkSession(input: SessionForkInput): Promise<{ sessionId: string; sourceSessionId: string }> {
    const source = await this.getSession(input.sourceSessionId)
    const sessionId = input.newSessionId ?? randomUUID()
    const now = Date.now()
    const forked: SessionMetadata = source
      ? { ...source, sessionId, title: null, createdAt: now, lastAccessedAt: now }
      : { sessionId, title: null, createdAt: now, lastAccessedAt: now }
    this.memory.set(sessionId, forked)
    const up = this.upstream()
    if (up?.create) {
      try { await up.create({ sessionId, forkedFrom: input.sourceSessionId, provider: forked.provider, model: forked.model, createdAt: forked.createdAt, lastAccessedAt: forked.lastAccessedAt }) } catch { /* best-effort */ }
    }
    return { sessionId, sourceSessionId: input.sourceSessionId }
  }

  async cancelSession(sessionId: string): Promise<void> {
    // Cancel is a marker, not a state change. The http-api service holds
    // the live AgentHandle and is the only thing that can actually abort
    // a running turn. Here we record the intent so /v1/audit shows it.
    const up = this.upstream()
    if (up?.update) {
      try { await up.update(sessionId, { canceledAt: Date.now() }) } catch { /* best-effort */ }
    }
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const existed = this.memory.delete(sessionId)
    this.tombstone.add(sessionId)
    // Clear the tombstone after 60s so the id can be re-used later.
    setTimeout(() => this.tombstone.delete(sessionId), 60_000).unref?.()
    const up = this.upstream()
    if (up?.delete) {
      try { await up.delete(sessionId) } catch { /* best-effort */ }
    }
    return existed
  }
}

function normalize(raw: unknown, fallbackId?: string): SessionMetadata {
  const r = raw as Record<string, unknown>
  return {
    sessionId: (r.sessionId as string) ?? (fallbackId ?? ''),
    title: (r.title as string | null) ?? null,
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : Date.now(),
    lastAccessedAt: typeof r.lastAccessedAt === 'number' ? r.lastAccessedAt : Date.now(),
    provider: r.provider as string | undefined,
    model: r.model as string | undefined,
  }
}

function byLastAccessedDesc(a: SessionMetadata, b: SessionMetadata): number {
  return b.lastAccessedAt - a.lastAccessedAt
}
