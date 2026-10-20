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
  route: ['provider', 'model', 'toProvider', 'toModel', 'resolved', 'baseUrl', 'status', 'durationMs', 'promptLen'],
  interception: ['reason', 'realm', 'targetRealm', 'rule', 'count', 'confidence', 'rationale'],
  threat: ['from', 'to', 'count', 'threshold', 'reason'],
}

export function rowFields(row: EdgeRow, panel: string): string {
  const keys = FIELD_ORDER[panel] ?? []
  const parts: string[] = []
  for (const key of keys) {
    const value = row.payload[key]
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      parts.push(`${key}=${typeof value === 'number' ? Math.round(value * 100) / 100 : value}`)
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
  return h('div', { class: 'dsh-edge-rows' },
    ...ordered.map((row) => h('div', { class: `dsh-edge-row ${levelClass(row.level)}`, key: `${row.seq}` },
      h('span', { class: 'ts' }, fmtTime(row.ts)),
      h('span', { class: 'k' }, shortKind(row.kind)),
      h('span', { class: 'f' }, rowFields(row, panel)),
    )),
  )
}
