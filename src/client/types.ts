/**
 * Client-side mirror of the edge-context-view wire types. Re-declared here
 * because the client bundle inlines every import and must never reach a host
 * module (same discipline as dsh-context's apiRoutes.ts).
 */

export type EdgePanel = 'intent' | 'route' | 'interception' | 'threat'

export interface EdgeRow {
  ts: number
  kind: string
  panel: EdgePanel
  level: string
  seq: number
  payload: Record<string, unknown>
  /** §7.106: committed-turn count at host record time; -1 = global-bucket
   *  row (always rendered). Rows of older turns are dropped from the panel
   *  by the store — each new turn wipes back to fresh records. */
  turn?: number
}

export interface EdgeSummary {
  sessionId: string
  startedAt?: number
  lastSeenAt?: number
  turns: number
  /** §7.106: wall clock of the newest turn/start — window for global-bucket rows. */
  turnStartTs?: number
  tokens?: { input?: number; output?: number; cacheRead?: number }
  /** §7.106: last observed answer route (survives the turn window; the host
   *  only re-announces `request/context` when the route changes). */
  lastRoute?: { provider: string; model: string; ts: number }
}

export interface EdgeSnapshot {
  cursor: number
  rows: EdgeRow[]
  summary: EdgeSummary
}

/** Browser-relative spelling — root-absolute would drop a reverse proxy's
 *  path prefix at the gateway (dsh-context apiRoutes note). */
export const CONTEXT_ROUTE = 'api/dsh-edge/context'

/** §7.133: 取 LLM trace 正文的路由（点开一次调用时才拉）。 */
export const TRACE_ROUTE = 'api/dsh-edge/trace'
