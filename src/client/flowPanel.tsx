/**
 * Pipeline flow view (§7.106): the current turn condensed into a five-node
 * vertical flow — attack detection → intent classification → PII sanitize →
 * routing verdict → answer egress. The event stream below stays the drill-down;
 * this answers "my message — where did it actually go" at a glance.
 *
 * Pure function of the already turn-filtered rows: every node state derives
 * from audit kinds, never invents a stage the host did not record. A missing
 * row is an honest "等待" / "跳过(本地)", never a fabricated green.
 */
import { createElement as h } from 'react'
import type { ReactElement } from 'react'
import type { EdgeRow } from './types'
import { tr } from './i18n'

type Tone = 'wait' | 'run' | 'ok' | 'warn' | 'stop' | 'info'

interface FlowNode {
  label: string
  tone: Tone
  detail: string
}

/** rowsFor output is oldest-first; "latest row of a kind" is therefore the tail. */
const latest = (rows: EdgeRow[], match: (r: EdgeRow) => boolean): EdgeRow | undefined =>
  [...rows].reverse().find(match)

const has = (rows: EdgeRow[], prefix: string): boolean => rows.some(r => r.kind.startsWith(prefix))

function guardNode(rows: EdgeRow[]): FlowNode {
  const end = latest(rows, r => r.kind === 'guard.model-detect.end')
  const err = latest(rows, r => /^guard\.model-detect\.(error|timeout|provider_error)$/.test(r.kind))
  const skipped = latest(rows, r => /^guard\.model-detect\.skip/.test(r.kind))
  const started = latest(rows, r => r.kind === 'guard.model-detect.start')
  const injection = latest(rows, r => r.kind === 'input.injection.warned' || r.kind === 'input.injection')
  if (injection !== undefined && end === undefined) {
    return { label: tr('flow.guard'), tone: 'warn', detail: tr('flow.guard.injection') }
  }
  if (err !== undefined && (end === undefined || err.ts > end.ts)) {
    return { label: tr('flow.guard'), tone: 'warn', detail: tr('flow.guard.failopen') }
  }
  if (end !== undefined) {
    const cls = typeof end.payload.dataClass === 'string' ? end.payload.dataClass : ''
    return { label: tr('flow.guard'), tone: 'ok', detail: cls === 'public' ? tr('flow.guard.public') : `dataClass=${cls}` }
  }
  if (skipped !== undefined) return { label: tr('flow.guard'), tone: 'ok', detail: tr('flow.guard.skipped') }
  if (started !== undefined) return { label: tr('flow.guard'), tone: 'run', detail: tr('flow.guard.running') }
  return { label: tr('flow.guard'), tone: 'wait', detail: tr('flow.wait') }
}

function intentNode(rows: EdgeRow[]): FlowNode {
  const end = latest(rows, r => r.kind === 'intent.classify.end')
  const override = latest(rows, r => r.kind === 'intent.classify.entity_override')
  const rejected = latest(rows, r => r.kind === 'intent.rules.rejected')
  const started = latest(rows, r => r.kind === 'intent.classify.start')
  if (rejected !== undefined && (end === undefined || rejected.ts > end.ts)) {
    return { label: tr('flow.intent'), tone: 'stop', detail: tr('flow.intent.rejected') }
  }
  if (end !== undefined) {
    const cat = String(end.payload.category ?? '?')
    const conf = typeof end.payload.confidence === 'number' ? ` ${(end.payload.confidence * 100).toFixed(0)}%` : ''
    const via = override !== undefined && override.ts <= end.ts ? tr('flow.intent.viaEntity') : tr('flow.intent.viaLlm')
    return { label: tr('flow.intent'), tone: 'ok', detail: `${cat}${conf} · ${via}` }
  }
  if (started !== undefined) return { label: tr('flow.intent'), tone: 'run', detail: tr('flow.running') }
  return { label: tr('flow.intent'), tone: 'wait', detail: tr('flow.wait') }
}

function sanitizeNode(rows: EdgeRow[], category: string | undefined): FlowNode {
  const done = latest(rows, r => r.kind === 'sanitizer.sanitized' || r.kind === 'input-guard.sanitized' || r.kind === 'guard.rule.sanitized')
  const failed = latest(rows, r => /^input-guard\.sanitize\.(downgraded|failed)$/.test(r.kind))
  if (failed !== undefined) return { label: tr('flow.sanitize'), tone: 'warn', detail: tr('flow.sanitize.failed') }
  if (done !== undefined) {
    const n = typeof done.payload.count === 'number' ? done.payload.count : done.payload.replacements
    return { label: tr('flow.sanitize'), tone: 'ok', detail: typeof n === 'number' ? `${tr('flow.sanitize.hits')} ×${n}` : tr('flow.sanitize.done') }
  }
  if (category === 'LOCAL') return { label: tr('flow.sanitize'), tone: 'ok', detail: tr('flow.sanitize.localSkip') }
  if (category !== undefined) return { label: tr('flow.sanitize'), tone: 'run', detail: tr('flow.sanitize.clean') }
  return { label: tr('flow.sanitize'), tone: 'wait', detail: tr('flow.wait') }
}

function routeNode(rows: EdgeRow[]): FlowNode {
  const routed = latest(rows, r => r.kind === 'input-guard.routed')
  const downgraded = latest(rows, r => r.kind === 'input-guard.route.overridden' || r.kind === 'input-guard.intent.downgraded')
  const blocked = latest(rows, r => /^input-guard\.blocked\./.test(r.kind))
  const missing = latest(rows, r => /route-missing|cloud-key\.missing|cloud\.unavailable/.test(r.kind))
  if (blocked !== undefined) return { label: tr('flow.route'), tone: 'stop', detail: tr('flow.route.blocked') }
  if (missing !== undefined) return { label: tr('flow.route'), tone: 'warn', detail: tr('flow.route.fallback') }
  if (routed !== undefined) {
    const cat = String(routed.payload.category ?? '?')
    const forced = downgraded !== undefined && downgraded.ts >= routed.ts - 2000
    // A forced-local downgrade is the guardrail SUCCEEDING (privacy kept) —
    // green with a note, not a warning.
    return {
      label: tr('flow.route'),
      tone: 'ok',
      detail: forced ? `${cat} · ${tr('flow.route.forced')}` : `${cat} · ${tr('flow.route.kept')}`,
    }
  }
  if (has(rows, 'intent.classify')) return { label: tr('flow.route'), tone: 'run', detail: tr('flow.running') }
  return { label: tr('flow.route'), tone: 'wait', detail: tr('flow.wait') }
}

function answerNode(rows: EdgeRow[]): FlowNode {
  const host = latest(rows, r => r.kind === 'llm.host.route')
  const local = host !== undefined && String(host.payload.provider ?? '').startsWith('local-llm')
  if (host === undefined) {
    return { label: tr('flow.answer'), tone: 'wait', detail: tr('flow.answer.pending') }
  }
  const provider = String(host.payload.provider ?? '?')
  const model = String(host.payload.model ?? '')
  if (local) {
    const steps = rows.filter(r => r.kind === 'llm.local.end' && typeof r.payload.promptLen === 'number' && (r.payload.promptLen as number) > 1000).length
    return {
      label: tr('flow.answer'),
      tone: 'ok',
      detail: `${tr('flow.answer.local')}${steps > 0 ? ` ×${steps}` : ''} · ${model}`,
    }
  }
  return { label: tr('flow.answer'), tone: 'info', detail: `${tr('flow.answer.cloud')} ${provider}/${model}` }
}

const ARROW = '│'

export function FlowPanel(props: { rows: EdgeRow[] }): ReactElement {
  const { rows } = props
  const classifyEnd = latest(rows, r => r.kind === 'intent.classify.end')
  const category = classifyEnd !== undefined ? String(classifyEnd.payload.category ?? '') : undefined
  const nodes: FlowNode[] = [guardNode(rows), intentNode(rows), sanitizeNode(rows, category), routeNode(rows), answerNode(rows)]
  const children = nodes.flatMap((n, i) => [
    h('div', { key: `n${i}`, class: `dsh-edge-flow-node dsh-edge-flow-node--${n.tone}` },
      h('span', { class: 'dsh-edge-flow-dot' }),
      h('span', { class: 'dsh-edge-flow-label' }, n.label),
      h('span', { class: 'dsh-edge-flow-detail' }, n.detail),
    ),
    ...(i < nodes.length - 1 ? [h('div', { key: `a${i}`, class: 'dsh-edge-flow-arrow' }, ARROW)] : []),
  ])
  return h('div', { class: 'dsh-edge-flow' }, ...children)
}
