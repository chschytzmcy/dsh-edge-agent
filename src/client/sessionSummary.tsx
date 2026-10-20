import { createElement as h } from 'react'
import type { EdgeSummary } from './types'
import { tr } from './i18n'

function fmtAge(startedAt?: number, lastSeenAt?: number): string {
  if (startedAt === undefined || lastSeenAt === undefined) return '—'
  const sec = Math.max(0, Math.round((lastSeenAt - startedAt) / 1000))
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m${sec % 60}s`
  return `${Math.floor(min / 60)}h${min % 60}m`
}

function fmtTokens(tokens: EdgeSummary['tokens']): string {
  if (tokens === undefined) return tr('summary.noTokens')
  const i = tokens.input ?? 0
  const o = tokens.output ?? 0
  return `${i} in / ${o} out`
}

/** Session summary bar: turns + token accounting (only when the adapter
 *  reported usage — never a faked 0) + lifetime. */
export function SessionSummaryBar(props: { summary: EdgeSummary }) {
  const { summary } = props
  return h('div', { class: 'dsh-edge-summary' },
    h('span', null, tr('summary.turns'), ' ', h('b', null, String(summary.turns))),
    h('span', null, tr('summary.tokens'), ' ', h('b', null, fmtTokens(summary.tokens))),
    h('span', null, tr('summary.age'), ' ', h('b', null, fmtAge(summary.startedAt, summary.lastSeenAt))),
  )
}
