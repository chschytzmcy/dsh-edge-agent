/**
 * edge-context-view — §7.101 host half of the desktop "Edge" tab.
 *
 * Folds the edge privacy audit stream into four panel row-lists (intent /
 * route / interception / threat) plus a per-session summary (turns + tokens
 * + lifetime), and serves them to the desktop client over a framework-
 * standard Connection POST route (`/api/dsh-edge/context`).
 *
 * Data-path decision (docs/notes/dsh-context-walkthrough.md, rulings A/B/D):
 *   - The panel sources are audit-log records — NOT subscribable plugin
 *     event streams. Live folding rides the new `auditLog.onEntry` seam;
 *     `query()` re-reads the whole file and is unusable as a poll source.
 *   - SessionEvent vocabulary is closed (no custom kinds), so
 *     `sessionProjections` cannot carry edge privacy events. The transport
 *     is the Connection fetch-route (dsh-context's detail-channel pattern);
 *     the client pulls with a cursor while the tab is mounted.
 *   - `ctx.edgeContextView.snapshot()` is a plain data fold, not an
 *     AsyncIterable: the browser cannot subscribe to cordis services, so a
 *     host-side stream would be an untestable dead API. Unit tests hit the
 *     fold directly.
 *   - Turns/tokens ride the in-process `session/event` listener (same
 *     idiom as http-api.ts:567): turn count from `turn/start`, tokens from
 *     `assistant/message` `usage` when the adapter reported accounting —
 *     absent usage, the summary says so instead of promising numbers.
 *
 * PII discipline: rows are counts/categories/timestamps/levels only at the
 * panel level; before a payload is stored, every string value passes the
 * `pii-utils` 5-class scanner a second time (audit-log already redacts on
 * write — this is belt-and-braces per the plan's hard rule, `piiRedact`).
 *
 * @module dsh-edge-agent/edge-context-view
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { redactObject } from './pii-utils.js'
import type { AuditEntry } from './audit-log.js'

export const name = 'edge-context-view'

/** Hard dep: the fold is fed exclusively through the audit stream.
 *  `connection` arms later via deferred ctx.inject (headless profiles
 *  never compose it and the plugin must still mount cleanly). */
export const inject = ['auditLog'] as const

export interface Config {
  /** Per-panel row cap (ring). Older rows are dropped from the front. */
  bufferSize: number
  /** Idle sessions are swept from the store after this long. */
  sessionTtlMs: number
  /** Re-scan every stored payload string against the 5 PII classes. */
  piiRedact: boolean
}

export const Config: Schema<Config> = Schema.object({
  bufferSize: Schema.natural().default(64),
  sessionTtlMs: Schema.natural().default(1_800_000),
  piiRedact: Schema.boolean().default(true),
})

/** Panel ids the client mounts. */
export type EdgePanel = 'intent' | 'route' | 'interception' | 'threat'

export interface EdgeRow {
  ts: number
  kind: string
  panel: EdgePanel
  /** Audit entry level, carried so the client can tint warn/error rows. */
  level: string
  payload: Record<string, unknown>
  /** Service-global monotonic sequence — the cursor is comparable across
   *  the session bucket and the global bucket, which is what a pull
   *  merges. (A per-bucket counter would let either side rewind it.) */
  seq: number
  /** §7.106: committed-turn count at record time; -1 = global-bucket row
   *  (session-independent: boot probes, rate-limit signals — always
   *  rendered). The client keeps session rows whose turn equals the
   *  session's current turn — each new turn wipes the panel back to fresh
   *  records (user ruling 2026-10-22: 新的对话旧记录删除). */
  turn: number
}

export interface EdgeSessionSummary {
  sessionId: string
  startedAt?: number
  lastSeenAt?: number
  /** Committed turn count (from `turn/start` session events). Doubles as the
   *  current-turn tag the client filters rows by (see {@link EdgeRow.turn}). */
  turns: number
  /** Token accounting from `assistant/message.usage`; undefined until an
   *  adapter reported usage (never faked as 0). */
  tokens?: { input?: number; output?: number; cacheRead?: number }
}

export interface EdgeContextSnapshot {
  /** Cursor to pass back on the next pull: rows strictly newer than this. */
  cursor: number
  rows: EdgeRow[]
  summary: EdgeSessionSummary
}

export interface EdgeContextViewService {
  snapshot(sessionId: string, cursor?: number): EdgeContextSnapshot
  /** Test/inspection helper. */
  trackedSessionIds(): string[]
}

/** Kinds that should never reach a panel — boot-time plumbing, hook
 *  registration, dependency probes. They are useful in audit but
 *  useless (and confusing) in a live monitor. */
const INTERNAL_KINDS: ReadonlySet<string> = new Set([
  'input-guard.hook.registered',
  'input-guard.dependency.missing',
  'input-guard.boot.probe',
  'input-guard.session-realm.registered',
])

/** Kind → panel routing table, dumped from the live audit call sites
 *  (see walkthrough §6). Unlisted kinds are ignored — the store only
 *  carries what the panels render. */
const PANEL_BY_KIND: Array<{ match: (kind: string) => boolean; panel: EdgePanel }> = [
  { match: k => k.startsWith('intent.') || k === 'input-guard.intent.downgraded', panel: 'intent' },
  {
    match: k =>
      k === 'http.chat.route'
      || k === 'http.chat.stream.route'
      || k.startsWith('llm.cloud.')
      || k.startsWith('llm.local.')
      // §7.106: host answer routes folded from the session event stream —
      // the desktop GUI answers through the host's own model (never an
      // edge adapter), so without these the Route panel cannot show where
      // the reply actually came from.
      || k.startsWith('llm.host.'),
    panel: 'route',
  },
  {
    // Interception = everything the guards/sanitizers decided or rewrote.
    // intent.*/http.chat.route already matched above, so order matters.
    match: k =>
      (!INTERNAL_KINDS.has(k) && k.startsWith('input-guard.'))
      || k.startsWith('guard.')
      || k.startsWith('sanitizer.')
      || k.startsWith('input.'),
    panel: 'interception',
  },
  {
    // Threat: escalations + rate-limit trips + explicit threat blocks.
    // (`input.rate-limit`/`input.global-rate-limit` hit the interception
    // rule first by prefix; re-route them here — they are td signals.)
    match: k =>
      k.startsWith('td-bus.')
      || k === 'http.chat.threat-blocked'
      || k === 'input.rate-limit'
      || k === 'input.global-rate-limit',
    panel: 'threat',
  },
]

/** Panel resolution with the threat re-route winning over the generic
 *  interception prefix. */
export function panelForKind(kind: string): EdgePanel | undefined {
  if (kind === 'input.rate-limit' || kind === 'input.global-rate-limit') return 'threat'
  for (const rule of PANEL_BY_KIND) {
    if (rule.match(kind)) return rule.panel
  }
  return undefined
}

/** Best-effort session attribution. Most guard/intent audit sites do not
 *  carry a sessionId (they run pre-turn); those rows land in `_global`
 *  and are merged into every snapshot — same fallback semantics as the
 *  §7.43 realm forensics. Rows with a real sessionId stay session-scoped. */
export const GLOBAL_BUCKET = '_global'

function extractSessionId(payload: Record<string, unknown>): string {
  const sid = payload.sessionId ?? payload.session
  return typeof sid === 'string' && sid.length > 0 ? sid : GLOBAL_BUCKET
}

/** Copy the payload with only scalar-safe fields, re-tokenized. Nested
 *  objects/arrays are flattened away EXCEPT small primitives we want
 *  (numbers/booleans kept; strings run through the PII scanner). */
export function safePayload(payload: Record<string, unknown>, piiRedact: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === 'string') {
      if (!piiRedact) { out[key] = value; continue }
      const { redacted } = redactObject({ [key]: value })
      const v = (redacted as Record<string, unknown>)[key]
      out[key] = typeof v === 'string' ? v : value
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value
    } else if (value === null) {
      out[key] = null
    }
    // objects/arrays (e.g. entity lists, edgeRejection) are dropped:
    // panels render rows of scalars; deep shapes are the detail channel
    // the plan explicitly cut.
  }
  return out
}

interface Bucket {
  rows: EdgeRow[]
  lastTouched: number
}

export class EdgeContextViewServiceImpl extends Service implements EdgeContextViewService {
  private readonly cfg: Config
  private readonly buckets = new Map<string, Bucket>()
  private readonly summaries = new Map<string, EdgeSessionSummary>()
  /** Service-global row sequence (the pull cursor). */
  private rowSeq = 0
  private sweepTimer: ReturnType<typeof setInterval> | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx, 'edgeContextView')
    this.cfg = config
  }

  /** Wire the live fold. Returns a disposer. */
  start(): () => void {
    const auditLog = (this.ctx as unknown as {
      auditLog?: { onEntry?(l: (e: AuditEntry) => void): () => void }
    }).auditLog
    const off = auditLog?.onEntry?.(entry => this.record(entry)) ?? (() => {})
    this.sweepTimer = setInterval(() => this.sweep(), Math.max(60_000, Math.floor(this.cfg.sessionTtlMs / 2)))
    if (typeof this.sweepTimer.unref === 'function') this.sweepTimer.unref()
    return () => {
      off()
      if (this.sweepTimer !== undefined) clearInterval(this.sweepTimer)
      this.sweepTimer = undefined
    }
  }

  /** Fold one audit record into the right panel bucket. Exported for tests
   *  through the service; kept public because the session-event listener
   *  also synthesizes rows through it. */
  record(entry: AuditEntry): void {
    const panel = panelForKind(entry.kind)
    if (panel === undefined) return
    const sessionId = extractSessionId(entry.payload)
    const bucket = this.bucketFor(sessionId)
    this.rowSeq += 1
    const row: EdgeRow = {
      ts: entry.ts,
      kind: entry.kind,
      panel,
      level: entry.level,
      seq: this.rowSeq,
      payload: safePayload(entry.payload, this.cfg.piiRedact),
      // Read-only turn tag: rows fold during a turn (pre-step runs after
      // turn/start commits), so the count already reflects this turn.
      // Global-bucket rows (no session — boot probes, rate-limit signals)
      // carry the -1 sentinel: they are session-independent and always
      // render (filtering them would silence the Threat panel forever).
      turn: sessionId === GLOBAL_BUCKET ? -1 : (this.summaries.get(sessionId)?.turns ?? 0),
    }
    bucket.rows.push(row)
    if (bucket.rows.length > this.cfg.bufferSize) bucket.rows.splice(0, bucket.rows.length - this.cfg.bufferSize)
    bucket.lastTouched = Date.now()
  }

  /** session/event fold (turn count + host answer rows + usage). `usage` is
   *  read defensively: adapters report it only when the upstream answered
   *  with accounting. §7.106: field names follow dsh-llm's `TokenUsage`
   *  (`inputTokens/outputTokens/cacheReadTokens`); the earlier code read
   *  `input/output`, which made every real host usage map to nothing while
   *  an empty `tokens` object still painted "0 in / 0 out" — tokens is now
   *  only created when at least one authoritative number arrived. */
  recordSessionEvent(sessionId: string, type: string, data: unknown): void {
    const summary = this.summaryFor(sessionId)
    const now = Date.now()
    summary.lastSeenAt = now
    if (summary.startedAt === undefined) summary.startedAt = now
    if (type === 'turn/start') {
      summary.turns += 1
    } else if (type === 'assistant/message') {
      const usage = (data as { usage?: Record<string, unknown> } | undefined)?.usage
      if (usage !== null && typeof usage === 'object') {
        const acc = (key: string, legacyKey: string): number | undefined => {
          const v = usage[key] ?? usage[legacyKey]
          return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined
        }
        const input = acc('inputTokens', 'input')
        const output = acc('outputTokens', 'output')
        const cacheRead = acc('cacheReadTokens', 'cacheRead')
        if (input !== undefined || output !== undefined || cacheRead !== undefined) {
          summary.tokens = summary.tokens ?? {}
          if (input !== undefined) summary.tokens.input = (summary.tokens.input ?? 0) + input
          if (output !== undefined) summary.tokens.output = (summary.tokens.output ?? 0) + output
          if (cacheRead !== undefined) summary.tokens.cacheRead = (summary.tokens.cacheRead ?? 0) + cacheRead
        }
      }
    } else if (type === 'request/context') {
      // The host resolved its answer route (dsh records this event when the
      // provider/model changes — one row per distinct route, not per turn).
      const ctxData = (data ?? {}) as { provider?: unknown; model?: unknown }
      if (typeof ctxData.provider === 'string' || typeof ctxData.model === 'string') {
        this.hostRow(sessionId, 'llm.host.route', {
          provider: typeof ctxData.provider === 'string' ? ctxData.provider : '',
          model: typeof ctxData.model === 'string' ? ctxData.model : '',
        })
      }
    }
  }

  /** Synthesize a Route-panel row from a session-event observation. Same ring
   *  and cursor as audit-fed rows; level `info`, PII-free scalars only. */
  private hostRow(sessionId: string, kind: string, fields: Record<string, unknown>): void {
    this.rowSeq += 1
    const bucket = this.bucketFor(sessionId)
    bucket.rows.push({
      ts: Date.now(),
      kind,
      panel: 'route',
      level: 'info',
      seq: this.rowSeq,
      payload: { ...fields },
      turn: this.summaries.get(sessionId)?.turns ?? 0,
    })
    if (bucket.rows.length > this.cfg.bufferSize) bucket.rows.splice(0, bucket.rows.length - this.cfg.bufferSize)
    bucket.lastTouched = Date.now()
  }

  snapshot(sessionId: string, cursor = 0): EdgeContextSnapshot {
    const rows: EdgeRow[] = []
    for (const bucket of [this.buckets.get(sessionId), this.buckets.get(GLOBAL_BUCKET)]) {
      if (!bucket) continue
      for (const row of bucket.rows) {
        if (row.seq > cursor) rows.push(row)
      }
    }
    rows.sort((a, b) => a.seq - b.seq)
    const nextCursor = rows.reduce((m, r) => Math.max(m, r.seq), cursor)
    const summary = this.summaryFor(sessionId)
    return { cursor: nextCursor, rows, summary: { ...summary } }
  }

  trackedSessionIds(): string[] {
    return [...this.buckets.keys()].filter(k => k !== GLOBAL_BUCKET)
  }

  private bucketFor(sessionId: string): Bucket {
    let bucket = this.buckets.get(sessionId)
    if (!bucket) {
      bucket = { rows: [], lastTouched: Date.now() }
      this.buckets.set(sessionId, bucket)
    }
    return bucket
  }

  private summaryFor(sessionId: string): EdgeSessionSummary {
    let summary = this.summaries.get(sessionId)
    if (!summary) {
      summary = { sessionId, turns: 0 }
      this.summaries.set(sessionId, summary)
    }
    return summary
  }

  private sweep(): void {
    const now = Date.now()
    for (const [id, bucket] of this.buckets) {
      if (id !== GLOBAL_BUCKET && now - bucket.lastTouched > this.cfg.sessionTtlMs) {
        this.buckets.delete(id)
        this.summaries.delete(id)
      }
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    edgeContextView: EdgeContextViewServiceImpl
  }
}

/** The client-side pull route (browser-relative spelling lives in the
 *  client bundle; the host registers the absolute path behind the
 *  harness `/api` fence — same discipline as dsh-context apiRoutes). */
export const EDGE_CONTEXT_ROUTE = '/api/dsh-edge/context'

interface ConnectionFetchRegister {
  register?(route: {
    path: string
    methods: readonly string[]
    requestBody: 'buffered'
    fetch: (request: Request) => Response | Promise<Response>
  }): () => void
}
interface ConnectionFace {
  fetch?: ConnectionFetchRegister
}

export async function apply(ctx: Context, config: Config): Promise<() => void> {
  // Boot evidence for the desktop ops log (file-logger picks this up via
  // the ctx.logger exporter chain). Proves the patch row activated.
  ctx.logger?.info?.('[edge-context-view] apply() called — Edge tab host half mounting')
  const service = new EdgeContextViewServiceImpl(ctx, config)
  // No `ctx.edgeContextView = ...` assignment: cordis 0.2.1-rc.2 plugin
  // proxy ctx can't accept arbitrary property writes (would throw
  // `cannot set property "x" without provide`). Service is captured by
  // closure in the route handler below.
  const disposeFold = service.start()

  // Deferred arms: `connection` only exists on GUI hosts. Headless profiles
  // (dsh-edge/dsh-tui) never compose it → no route, plugin stays clean.
  ctx.inject(['connection'], (raw) => {
    const c = raw as unknown as Context & { connection?: ConnectionFace }
    const register = c.connection?.fetch?.register
    if (typeof register !== 'function') return
    try {
      register.call(c.connection!.fetch!, {
        path: EDGE_CONTEXT_ROUTE,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request: Request) => {
          // Re-prove every input at the boundary — the wire is untrusted.
          let body: { sessionId?: unknown; cursor?: unknown }
          try {
            body = await request.json() as typeof body
          } catch {
            return new Response('{"error":"invalid-json"}', { status: 400, headers: { 'content-type': 'application/json' } })
          }
          const sessionId = typeof body.sessionId === 'string' && body.sessionId.length > 0 ? body.sessionId : GLOBAL_BUCKET
          const cursor = typeof body.cursor === 'number' && Number.isFinite(body.cursor) && body.cursor >= 0
            ? Math.floor(body.cursor) : 0
          const snapshot = service.snapshot(sessionId, cursor)
          // Host rows are already PII-scanned at store time; keep the audit
          // trail of who is pulling out of the payload (no new kinds).
          return new Response(JSON.stringify(snapshot), { status: 200, headers: { 'content-type': 'application/json' } })
        },
      })
    } catch { /* a rejecting registry only costs the route, not the plugin */ }
  })

  // In-process session/event fold (turns + tokens). Cordis 0.2.1-rc.2's
  // plugin-level proxy ctx does NOT expose `.on` directly (would throw
  // `cannot get property "on" without inject`); only Service-internal ctx
  // has it. Wrap in a try/catch so a missing fiber-root `.on` only costs
  // the session summary counter, not the whole plugin mount.
  let disposeSession: (() => void) | undefined
  try {
    const ctxOn = (ctx as unknown as {
      on?: (event: string, cb: (session: { id?: string }, event: { type: string; data?: unknown }) => void) => () => void
    }).on
    if (typeof ctxOn === 'function') {
      disposeSession = ctxOn.call(ctx, 'session/event', (session, event) => {
        const sid = typeof session?.id === 'string' && session.id.length > 0 ? session.id : undefined
        if (sid === undefined) return
        if (event?.type !== 'turn/start' && event?.type !== 'assistant/message' && event?.type !== 'request/context') return
        service.recordSessionEvent(sid, event.type, event.data)
      })
    }
  } catch {
    // Plugin-level proxy ctx can't subscribe events. Session summary
    // will fall back to audit-log derived data only.
  }

  return () => {
    disposeFold()
    disposeSession?.()
  }
}
