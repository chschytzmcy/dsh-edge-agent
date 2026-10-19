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
}

export interface EdgeSummary {
  sessionId: string
  startedAt?: number
  lastSeenAt?: number
  turns: number
  tokens?: { input?: number; output?: number; cacheRead?: number }
}

export interface EdgeSnapshot {
  cursor: number
  rows: EdgeRow[]
  summary: EdgeSummary
}

/** Browser-relative spelling — root-absolute would drop a reverse proxy's
 *  path prefix at the gateway (dsh-context apiRoutes note). */
export const CONTEXT_ROUTE = 'api/dsh-edge/context'
