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
import { CONTEXT_ROUTE } from './types'

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
  /** Panel rows for the CURRENT turn only (§7.106, user ruling 2026-10-22:
   *  新的对话旧记录删除). Rows tagged with an older turn drop out of the
   *  view as soon as `turn/start` bumps the summary count — the panel
   *  wipes itself each turn. Global rows (turn -1) and rows from a host
   *  that predates the tag (turn undefined) always render. */
  rowsFor(sessionId: string, panel: EdgePanel, currentTurn: number): EdgeRow[] {
    const s = sessions.get(sessionId)
    if (!s) return []
    const out: EdgeRow[] = []
    for (const row of s.rows) {
      if (row.panel !== panel) continue
      if (row.turn !== undefined && row.turn >= 0 && row.turn !== currentTurn) continue
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
