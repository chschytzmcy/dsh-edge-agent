/** Shared row painting for the four Edge panels. */
import { createElement as h } from 'react'
import type { EdgeRow } from './types'

/** HH:MM:SS local time. */
export function fmtTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** `intent.classify.end` → `classify.end` — the source prefix is panel
 *  context the row already implies. */
export function shortKind(kind: string): string {
  const dot = kind.indexOf('.')
  return dot > 0 ? kind.slice(dot + 1) : kind
}

/** Field whitelist per panel, ordered for reading. Unknown kinds degrade to
 *  whatever safe scalars exist. */
const FIELD_ORDER: Record<string, string[]> = {
  intent: ['category', 'targetRealm', 'confidence', 'rationale', 'classifier', 'textLen'],
  // §7.106: llm.host.route rows carry provider+model from the session event
  // stream (the host's actual answer route — never visible via edge adapters).
  route: ['provider', 'model', 'toProvider', 'toModel', 'resolved', 'baseUrl', 'status', 'durationMs', 'promptLen'],
  // routed / model-detect rows: input-guard's decision fields and the guard
  // model's classification result. textPreview stays deliberately absent —
  // previews are payload, the panel shows scalars only.
  interception: ['reason', 'realm', 'targetRealm', 'rule', 'count', 'confidence', 'rationale', 'category', 'edgeRouteUsed', 'routeSource', 'dataClass', 'provider', 'model', 'textLen', 'durationMs'],
  threat: ['from', 'to', 'count', 'threshold', 'reason'],
}

/** Scalar cap: baseUrl/model/rationale strings otherwise push a row past any
 *  panel width — 24 chars keeps the field line to at most two wrapped rows. */
const VALUE_CAP = 24

export function rowFields(row: EdgeRow, panel: string): string {
  const keys = FIELD_ORDER[panel] ?? []
  const parts: string[] = []
  for (const key of keys) {
    const value = row.payload[key]
    if (typeof value === 'number') {
      parts.push(`${key}=${Math.round(value * 100) / 100}`)
    } else if (typeof value === 'boolean') {
      parts.push(`${key}=${value}`)
    } else if (typeof value === 'string' && value.length > 0) {
      parts.push(`${key}=${value.length > VALUE_CAP ? `${value.slice(0, VALUE_CAP - 1)}…` : value}`)
    }
  }
  return parts.join(' ')
}

function levelClass(level: string): string {
  if (level === 'warn') return 'warn'
  if (level === 'error' || level === 'security') return 'security'
  return ''
}

export function RowList(props: { rows: EdgeRow[]; panel: string; empty: string }) {
  const { rows, panel, empty } = props
  if (rows.length === 0) return h('div', { class: 'dsh-edge-empty' }, empty)
  // Newest first — the tab is a live monitor, not a replay.
  const ordered = [...rows].reverse()
  // Two-line rows: head (time + kind) and a wrapping field line. The earlier
  // single-line nowrap layout clipped every long field (baseUrl/model/…) past
  // the panel width — with a few turns of traffic the stream became unreadable.
  return h('div', { class: 'dsh-edge-rows' },
    ...ordered.map((row) => {
      const fields = rowFields(row, panel)
      return h('div', { class: `dsh-edge-row ${levelClass(row.level)}`, key: `${row.seq}` },
        h('div', { class: 'dsh-edge-row-head' },
          h('span', { class: 'ts' }, fmtTime(row.ts)),
          h('span', { class: 'k' }, shortKind(row.kind)),
        ),
        fields.length > 0 ? h('div', { class: 'f' }, fields) : null,
      )
    }),
  )
}
