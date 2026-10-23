/**
 * Pipeline flow view (§7.106): the current turn condensed into a five-node
 * vertical flow — attack detection → intent classification → PII sanitize →
 * routing verdict → answer egress — each node carrying a headline verdict
 * plus evidence lines built from the very audit rows below it (the override
 * pair, the from→to route rewrite, step latencies, the egress declaration).
 *
 * Pure function of the already turn-filtered rows: every word derives from a
 * recorded kind; a stage with no rows says "等待", never a fabricated green.
 */
import { createElement as h } from 'react'
import type { ReactElement } from 'react'
import type { EdgeRow, EdgeSummary } from './types'
import { tr } from './i18n'

type Tone = 'wait' | 'run' | 'ok' | 'warn' | 'stop' | 'info'

interface FlowNode {
  label: string
  tone: Tone
  detail: string
  /** Evidence lines rendered small under the headline. */
  sub: string[]
}

/** rowsFor output is oldest-first; "latest row of a kind" is therefore the tail. */
const latest = (rows: EdgeRow[], match: (r: EdgeRow) => boolean): EdgeRow | undefined =>
  [...rows].reverse().find(match)

const field = (r: EdgeRow | undefined, key: string): unknown => r?.payload[key]
const ms = (v: unknown): string => typeof v === 'number' ? `${(v / 1000).toFixed(1)}s` : '?'
/** Present any scalar for the evidence line; numbers included (textLen
   landed as '?' when this only accepted strings — 2026-10-23 flow shot). */
const str = (v: unknown): string => typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '?'

function guardNode(rows: EdgeRow[]): FlowNode {
  const end = latest(rows, r => r.kind === 'guard.model-detect.end')
  const err = latest(rows, r => /^guard\.model-detect\.(error|timeout|provider_error)$/.test(r.kind))
  const skipped = latest(rows, r => /^guard\.model-detect\.skip/.test(r.kind))
  const started = latest(rows, r => r.kind === 'guard.model-detect.start')
  const injection = latest(rows, r => r.kind === 'input.injection.warned' || r.kind === 'input.injection')
  if (injection !== undefined && end === undefined) {
    return {
      label: tr('flow.guard'), tone: 'warn',
      detail: tr('flow.guard.injection'),
      sub: [str(field(injection, 'patterns')) === '?' ? tr('flow.g.guardrule') : `patterns=${str(field(injection, 'patterns'))}`],
    }
  }
  if (err !== undefined && (end === undefined || err.ts > end.ts)) {
    return {
      label: tr('flow.guard'), tone: 'warn',
      detail: tr('flow.guard.failopen'),
      sub: [
        `${tr('flow.lbl.cause')} ${str(field(err, 'reason'))} · ${ms(field(err, 'durationMs'))}`,
        tr('flow.g.regexOn'),
      ],
    }
  }
  if (end !== undefined) {
    const cls = typeof end.payload.dataClass === 'string' ? end.payload.dataClass : '?'
    return {
      label: tr('flow.guard'), tone: 'ok',
      detail: cls === 'public' ? tr('flow.guard.public') : `dataClass=${cls}`,
      sub: [
        `${tr('flow.lbl.judge')} dataClass=${cls} · ${ms(field(end, 'durationMs'))}`,
        `${tr('flow.lbl.model')} ${str(field(end, 'provider'))}/${str(field(end, 'model'))} · ${tr('flow.lbl.input')} ${str(field(end, 'textLen'))}`,
      ],
    }
  }
  if (skipped !== undefined) return { label: tr('flow.guard'), tone: 'ok', detail: tr('flow.guard.skipped'), sub: [] }
  if (started !== undefined) return { label: tr('flow.guard'), tone: 'run', detail: tr('flow.guard.running'), sub: [] }
  return { label: tr('flow.guard'), tone: 'wait', detail: tr('flow.wait'), sub: [] }
}

function intentNode(rows: EdgeRow[]): FlowNode {
  const end = latest(rows, r => r.kind === 'intent.classify.end')
  const override = latest(rows, r => r.kind === 'intent.classify.entity_override')
  const rejected = latest(rows, r => r.kind === 'intent.rules.rejected')
  const started = latest(rows, r => r.kind === 'intent.classify.start')
  if (rejected !== undefined && (end === undefined || rejected.ts > end.ts)) {
    return { label: tr('flow.intent'), tone: 'stop', detail: tr('flow.intent.rejected'), sub: [] }
  }
  if (end !== undefined) {
    const cat = str(field(end, 'category'))
    const conf = typeof end.payload.confidence === 'number' ? `${(end.payload.confidence * 100).toFixed(0)}%` : '?'
    const sub: string[] = [`${tr('flow.lbl.verdict')} ${cat} · ${conf} · ${str(field(end, 'rationale'))}`]
    if (override !== undefined && override.ts <= end.ts) {
      sub.push(`${tr('flow.lbl.override')} ${str(field(override, 'from'))} → ${str(field(override, 'to'))} · ${tr('flow.lbl.entity')} ${str(field(override, 'entity'))}`)
      const lc = typeof override.payload.llmConfidence === 'number' ? `${(override.payload.llmConfidence * 100).toFixed(0)}%` : '?'
      sub.push(`${tr('flow.lbl.llmSay')} ${str(field(override, 'llmRationale'))} · ${lc} ${tr('flow.lbl.overridden')}`)
    }
    // classifier/textLen live on the classify.start row; duration/category on end.
    const startRow = latest(rows, r => r.kind === 'intent.classify.start')
    const textLen = field(end, 'textLen') ?? field(startRow, 'textLen')
    sub.push(`${tr('flow.lbl.classifier')} ${str(field(startRow, 'classifier'))} · ${ms(field(end, 'durationMs'))} · ${tr('flow.lbl.input')} ${str(textLen)}`)
    return {
      label: tr('flow.intent'), tone: 'ok',
      detail: `${cat} ${conf} · ${override !== undefined && override.ts <= end.ts ? tr('flow.intent.viaEntity') : tr('flow.intent.viaLlm')}`,
      sub,
    }
  }
  if (started !== undefined) return { label: tr('flow.intent'), tone: 'run', detail: tr('flow.running'), sub: [] }
  return { label: tr('flow.intent'), tone: 'wait', detail: tr('flow.wait'), sub: [] }
}

function sanitizeNode(rows: EdgeRow[], category: string | undefined): FlowNode {
  const done = latest(rows, r => r.kind === 'sanitizer.sanitized' || r.kind === 'input-guard.sanitized' || r.kind === 'guard.rule.sanitized')
  const failed = latest(rows, r => /^input-guard\.sanitize\.(downgraded|failed)$/.test(r.kind))
  const back = latest(rows, r => r.kind === 'sanitizer.desanitized')
  if (failed !== undefined) {
    return { label: tr('flow.sanitize'), tone: 'warn', detail: tr('flow.sanitize.failed'), sub: [`${tr('flow.lbl.cause')} ${str(field(failed, 'reason')) ?? '-'}`] }
  }
  if (done !== undefined) {
    const n = typeof done.payload.count === 'number' ? done.payload.count : done.payload.replacements
    const sub = [typeof n === 'number' ? `${tr('flow.sanitize.hits')} ${n} ${tr('flow.sanitize.unit')}` : tr('flow.sanitize.done')]
    if (back !== undefined) sub.push(tr('flow.s.desanitized'))
    return { label: tr('flow.sanitize'), tone: 'ok', detail: tr('flow.s.done'), sub }
  }
  if (category === 'LOCAL') {
    return { label: tr('flow.sanitize'), tone: 'ok', detail: tr('flow.sanitize.localSkip'), sub: [tr('flow.s.localWhy')] }
  }
  if (category !== undefined) {
    return { label: tr('flow.sanitize'), tone: 'ok', detail: tr('flow.sanitize.clean'), sub: [tr('flow.s.cleanWhy')] }
  }
  return { label: tr('flow.sanitize'), tone: 'wait', detail: tr('flow.wait'), sub: [] }
}

function routeNode(rows: EdgeRow[]): FlowNode {
  const routed = latest(rows, r => r.kind === 'input-guard.routed')
  const overridden = latest(rows, r => r.kind === 'input-guard.route.overridden')
  const blocked = latest(rows, r => /^input-guard\.blocked\./.test(r.kind))
  const missing = latest(rows, r => /route-missing|cloud-key\.missing|cloud\.unavailable/.test(r.kind))
  if (blocked !== undefined) {
    // Evidence = classification metadata ONLY (reason/riskLevel/rationale).
    // The payload's `preview` can carry raw user text (audit stays local);
    // the panel's hard rule is no original content — never surface it here.
    const what = blocked.kind.replace('input-guard.blocked.', '')
    const reason = str(field(blocked, 'reason'))
    const rationale = str(field(blocked, 'rationale'))
    const risk = str(field(blocked, 'riskLevel'))
    const cause = reason !== '?' ? reason : rationale !== '?' ? rationale : '?'
    const sub = [`${tr('flow.lbl.cause')} ${cause}`]
    const extras = [
      risk !== '?' ? `${tr('flow.lbl.risk')} ${risk}` : null,
      typeof blocked.payload.confidence === 'number' ? `confidence ${(blocked.payload.confidence * 100).toFixed(0)}%` : null,
    ].filter((v): v is string => v !== null)
    if (extras.length > 0) sub.push(extras.join(' · '))
    return { label: tr('flow.route'), tone: 'stop', detail: `${tr('flow.route.blocked')} · ${what}`, sub }
  }
  if (missing !== undefined) return { label: tr('flow.route'), tone: 'warn', detail: tr('flow.route.fallback'), sub: [`${tr('flow.lbl.cause')} ${str(field(missing, 'reason'))}`] }
  if (routed !== undefined) {
    const cat = str(field(routed, 'category'))
    const forced = overridden !== undefined && overridden.ts >= routed.ts - 2000
    const sub: string[] = []
    if (forced && overridden !== undefined) {
      sub.push(`${tr('flow.lbl.rewrite')} ${str(field(overridden, 'from.provider'))}/${str(field(overridden, 'from.model'))} → ${str(field(overridden, 'to.provider'))}/${str(field(overridden, 'to.model'))}`)
      sub.push(`${tr('flow.lbl.reason')} ${str(field(overridden, 'reason'))}`)
    }
    sub.push(`${tr('flow.lbl.entry')} ${str(field(routed, 'routeSource'))} · ${tr('flow.lbl.edgePool')} ${routed.payload.edgeRouteUsed === true ? tr('flow.lbl.used') : tr('flow.lbl.hostOwn')}`)
    return {
      label: tr('flow.route'), tone: 'ok',
      detail: forced ? `${cat} · ${tr('flow.route.forced')}` : `${cat} · ${tr('flow.route.kept')}`,
      sub,
    }
  }
  if (intentStarted(rows)) return { label: tr('flow.route'), tone: 'run', detail: tr('flow.running'), sub: [] }
  return { label: tr('flow.route'), tone: 'wait', detail: tr('flow.wait'), sub: [] }
}

const intentStarted = (rows: EdgeRow[]): boolean => rows.some(r => r.kind.startsWith('intent.classify.'))

function threatNode(rows: EdgeRow[]): FlowNode {
  const escalated = latest(rows, r => r.kind === 'td-bus.escalated')
  const rate = latest(rows, r => r.kind === 'input.rate-limit' || r.kind === 'input.global-rate-limit')
  const blocked = latest(rows, r => r.kind === 'http.chat.threat-blocked')
  if (blocked !== undefined) {
    return { label: tr('flow.threat'), tone: 'stop', detail: tr('flow.threat.blocked'), sub: [`${tr('flow.lbl.cause')} ${str(field(blocked, 'reason')) ?? '-'}`] }
  }
  if (escalated !== undefined) {
    return {
      label: tr('flow.threat'), tone: 'warn', detail: tr('flow.threat.escalated'),
      sub: [`${str(field(escalated, 'from'))} → ${str(field(escalated, 'to'))} · ${str(field(escalated, 'count'))}/${str(field(escalated, 'threshold'))}`],
    }
  }
  if (rate !== undefined) return { label: tr('flow.threat'), tone: 'warn', detail: tr('flow.threat.rate'), sub: [] }
  return { label: tr('flow.threat'), tone: 'ok', detail: tr('flow.threat.calm'), sub: [] }
}

function answerNode(rows: EdgeRow[], summary: EdgeSummary): FlowNode {
  const host = latest(rows, r => r.kind === 'llm.host.route')
  if (host === undefined) {
    return { label: tr('flow.answer'), tone: 'wait', detail: tr('flow.answer.pending'), sub: [] }
  }
  const provider = str(field(host, 'provider'))
  const model = str(field(host, 'model'))
  const local = provider.startsWith('local-llm')
  const answerSteps = rows.filter(r => r.kind === 'llm.local.end' && typeof r.payload.promptLen === 'number' && (r.payload.promptLen as number) > 1000)
  const sub: string[] = [
    `${tr('flow.lbl.route')} ${provider}/${model}`,
    local ? tr('flow.a.localKeep') : tr('flow.a.cloudSend'),
  ]
  if (local && answerSteps.length > 0) {
    const total = answerSteps.reduce((n, r) => n + (typeof r.payload.durationMs === 'number' ? r.payload.durationMs : 0), 0)
    sub.push(`${tr('flow.lbl.steps')} ×${answerSteps.length} · ${tr('flow.lbl.total')} ${ms(total)} · ${tr('flow.lbl.context')} ${str(answerSteps.at(-1)?.payload.promptLen)}`)
  }
  const tok = summary.tokens
  if (tok !== undefined && (tok.input !== undefined || tok.output !== undefined)) {
    sub.push(`token ${tok.input ?? 0} ${tr('flow.lbl.in')} / ${tok.output ?? 0} ${tr('flow.lbl.out')}`)
  }
  return {
    label: tr('flow.answer'),
    tone: local ? 'ok' : 'info',
    detail: local ? `${tr('flow.answer.local')} · ${model}` : `${tr('flow.answer.cloud')} ${provider}/${model}`,
    sub,
  }
}

const ARROW = '│'

export function FlowPanel(props: { rows: EdgeRow[]; summary: EdgeSummary }): ReactElement {
  const { rows, summary } = props
  const classifyEnd = latest(rows, r => r.kind === 'intent.classify.end')
  const category = classifyEnd !== undefined ? String(classifyEnd.payload.category ?? '') : undefined
  const nodes: FlowNode[] = [
    guardNode(rows),
    intentNode(rows),
    sanitizeNode(rows, category),
    routeNode(rows),
    answerNode(rows, summary),
    threatNode(rows),
  ]
  const children = nodes.flatMap((n, i) => [
    h('div', { key: `n${i}`, class: `dsh-edge-flow-node dsh-edge-flow-node--${n.tone}` },
      h('span', { class: 'dsh-edge-flow-dot' }),
      h('span', { class: 'dsh-edge-flow-label' }, n.label),
      h('span', { class: 'dsh-edge-flow-detail' }, n.detail),
      n.sub.length > 0
        ? h('div', { class: 'dsh-edge-flow-sub' }, ...n.sub.map((s, j) => h('div', { key: j }, s)))
        : null,
    ),
    ...(i < nodes.length - 1 ? [h('div', { key: `a${i}`, class: 'dsh-edge-flow-arrow' }, ARROW)] : []),
  ])
  return h('div', { class: 'dsh-edge-flow' }, ...children)
}
