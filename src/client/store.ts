/**
 * Client data store for the Edge tab. Module-level singletons survive tab
 * unmount/remount — "switch to background and back keeps the data" is a
 * store guarantee, not a component one.
 *
 * Pull transport: POST `api/dsh-edge/context` with { sessionId, cursor };
 * the host returns rows strictly newer than the cursor plus the session
 * summary (docs/notes/dsh-context-walkthrough.md ruling B). Polling is
 * armed only while a component is attached; fetch faults are silent
 * (retry on the next tick) because a transient proxy blip must never
 * blank the panel.
 */

import type { EdgePanel, EdgeRow, EdgeSnapshot, EdgeSummary } from './types'
import { CONTEXT_ROUTE, TRACE_ROUTE } from './types'

const POLL_MS = 2_000
/** Per-panel row cap on the client (the host caps at its bufferSize; the
 *  client keeps a little more history locally so scrolling survives a
 *  host-side ring rotation). */
const CLIENT_CAP = 200

interface SessionState {
  cursor: number
  rows: EdgeRow[]
  summary: EdgeSummary
  /** Consecutive poll faults — only surfaces a soft hint in the UI. */
  failures: number
}

type Listener = () => void

const sessions = new Map<string, SessionState>()
const listeners = new Set<Listener>()
let pollTimer: ReturnType<typeof setInterval> | undefined
let attached = 0

function notify(): void {
  for (const fn of [...listeners]) {
    try { fn() } catch { /* a paint fault must not kill the store */ }
  }
}

function stateFor(sessionId: string): SessionState {
  let s = sessions.get(sessionId)
  if (!s) {
    s = { cursor: 0, rows: [], summary: { sessionId, turns: 0 }, failures: 0 }
    sessions.set(sessionId, s)
  }
  return s
}

async function pollOnce(sessionIds: string[]): Promise<void> {
  for (const sessionId of sessionIds) {
    const s = stateFor(sessionId)
    try {
      const response = await fetch(CONTEXT_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, cursor: s.cursor }),
      })
      if (!response.ok) { s.failures += 1; continue }
      const snap = await response.json() as EdgeSnapshot
      s.failures = 0
      // Re-prove the wire defensively — never trust the payload shape.
      if (typeof snap.cursor === 'number' && snap.cursor > s.cursor) s.cursor = snap.cursor
      if (Array.isArray(snap.rows)) {
        s.rows = [...s.rows, ...snap.rows.filter(r => r && typeof r.kind === 'string' && typeof r.panel === 'string')]
        if (s.rows.length > CLIENT_CAP * 4) s.rows = s.rows.slice(-CLIENT_CAP * 4)
      }
      if (snap.summary && typeof snap.summary === 'object') s.summary = snap.summary
    } catch {
      s.failures += 1
    }
  }
  notify()
}

function ensurePolling(): void {
  if (pollTimer !== undefined) return
  void pollOnce([...sessions.keys()])
  pollTimer = setInterval(() => {
    if (attached === 0) return
    void pollOnce([...sessions.keys()])
  }, POLL_MS)
}

function stopPollingIfIdle(): void {
  if (attached > 0 || pollTimer === undefined) return
  clearInterval(pollTimer)
  pollTimer = undefined
}

/**
 * §7.133: 拉一条 LLM trace 的**正文**。
 *
 * 索引行（每次调用一行摘要）随 audit 行一起进面板；正文（完整 request /
 * response）留在宿主的内存 ring 里，点开才取 —— 单轮主对话的 request 正文
 * 实测 22.5 万字符，进面板常驻内存会随轮次线性膨胀。
 *
 * 取不到就说取不到（404 = 已被 ring 淘汰），绝不返回空对象冒充「正文是空的」。
 */
export interface TraceFetchResult {
  ok: boolean
  /** 格式化后的正文（JSON）。 */
  text?: string
  /** 失败原因（机器码，如 `trace-not-found`）。 */
  error?: string
}

export async function fetchTraceBody(traceId: string): Promise<TraceFetchResult> {
  try {
    const response = await fetch(TRACE_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ traceId }),
    })
    if (!response.ok) {
      let error = `HTTP ${response.status}`
      try {
        const parsed = await response.json() as { error?: unknown }
        if (typeof parsed?.error === 'string' && parsed.error.length > 0) error = parsed.error
      } catch { /* keep the status form */ }
      return { ok: false, error }
    }
    const payload = await response.json() as unknown
    let text: string
    try {
      text = JSON.stringify(payload, null, 2) ?? String(payload)
    } catch {
      text = String(payload)
    }
    return { ok: true, text }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export const edgeStore = {
  /** Attach a mounted view to a session; returns a detach. Data for the
   *  session persists in the module store across attach/detach cycles. */
  attach(sessionId: string, listener: Listener): () => void {
    attached += 1
    stateFor(sessionId)
    listeners.add(listener)
    ensurePolling()
    listener()
    return () => {
      attached -= 1
      listeners.delete(listener)
      stopPollingIfIdle()
    }
  },
  /** Rows of the CURRENT turn only (§7.106; user ruling 2026-10-22 新一轮
   *  清旧行, extended 2026-10-23): session-tagged rows must carry the live
   *  turn number; global-bucket rows (turn -1 — host answer steps never get
   *  a sessionId into adapter audits, so attribution cannot be threaded at
   *  the source) fall back to the turn time window: only rows at or after
   *  `turnStartTs` render. Without a window yet (first turn not started)
   *  globals pass, matching the pre-wipe behavior. */
  rowsFor(sessionId: string, panel: EdgePanel, currentTurn: number, turnStartTs?: number): EdgeRow[] {
    return this.currentRows(sessionId, currentTurn, turnStartTs).filter(r => r.panel === panel)
  },


  /** Every current-turn row across panels (flow view input).
   *
   *  Window-first semantics (§7.106, 2026-10-23 race fix): the authoritative
   *  discriminator is row time vs `turnStartTs`. The row's `turn` number
   *  cannot be trusted for early-turn rows — `turn/start` session events
   *  reach the fold AFTER the pre-step audit rows land (host log commits
   *  asynchronously), so the first rows of a turn were tagged with the
   *  previous count and got wrongly wiped (observed: intent/sanitize nodes
   *  stuck on 等待 while guard/route/answer showed data). Audit `ts` is
   *  production-time and race-free; the turn tag stays informational only.
   *  Before the first turn there is no window, so everything renders
   *  (boot probes included). */
  currentRows(sessionId: string, _currentTurn: number, turnStartTs?: number): EdgeRow[] {
    const s = sessions.get(sessionId)
    if (!s) return []
    const out: EdgeRow[] = []
    for (const row of s.rows) {
      if (turnStartTs !== undefined && row.ts < turnStartTs) continue
      out.push(row)
    }
    return out.slice(-CLIENT_CAP)
  },
  summaryFor(sessionId: string): EdgeSummary {
    return sessions.get(sessionId)?.summary ?? { sessionId, turns: 0 }
  },
  failing(sessionId: string): boolean {
    return (sessions.get(sessionId)?.failures ?? 0) >= 3
  },
}
