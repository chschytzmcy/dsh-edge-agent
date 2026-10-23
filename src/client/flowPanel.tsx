/**
 * Pipeline flow view (§7.106): the current turn condensed into a five-node
 * vertical flow — attack detection → intent classification → PII sanitize →
 * routing verdict → answer egress — each node carrying a headline verdict
 * plus evidence lines built from the very audit rows below it (the override
 * pair, the from→to route rewrite, step latencies, the egress declaration).
 *
 * Pure function of the already turn-filtered rows: every word derives from a
 * recorded kind; a stage with no rows says "等待", never a fabricated green.
 *
 * §7.107 (2026-10-23, desktop deployment round) — the panel was honest but
 * not tidy. Three defects the desktop shot exposed, all fixed here:
 *
 *  1. The intent node only read the LLM classifier (`intent.classify.*`), so
 *     a turn the **privacy-policy tier** decided (`input-guard.policy
 *     .route-applied`) — the classifier never ran, the policy short-circuits
 *     it — sat on "等待" while the routing node below announced the verdict.
 *     The policy tier IS an intent verdict and is now read as one.
 *  2. The routing node took the LAST `input-guard.route.overridden` row.
 *     The guard re-announces the rewrite on every answer step, and those
 *     later rows are local→local no-ops — the panel showed
 *     "改写 local-llm/X → local-llm/X" instead of the one line that actually
 *     matters (host model → local model). Only a real change counts now.
 *  3. Evidence lines mixed raw identifiers into the Chinese prose
 *     ("判定 dataClass=public", "理由 intent-local") and repeated the
 *     headline ("干净（公开级）" + "判定 dataClass=public" side by side).
 *     Identifiers are now translated, the duplicate verdict is gone, and
 *     every node renders with the same three-level rhythm.
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
const rationaleStr = (r: EdgeRow): string => typeof r.payload.rationale === 'string' ? r.payload.rationale : ''
const ms = (v: unknown): string => typeof v === 'number' ? `${(v / 1000).toFixed(1)}s` : '?'
/** Present any scalar for the evidence line; numbers included (textLen
   landed as '?' when this only accepted strings — 2026-10-23 flow shot). */
const str = (v: unknown): string => typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '?'
const num = (v: unknown): number | undefined => typeof v === 'number' ? v : undefined
const pct = (v: unknown): string => typeof v === 'number' ? `${(v * 100).toFixed(0)}%` : '?'

/** Data-class names reach the panel as raw enum values; the panel speaks the
 *  operator's language, so the enum is translated and the raw spelling kept
 *  only in parentheses for forensics. */
function classLabel(cls: string): string {
  const key = `flow.class.${cls}`
  const label = tr(key)
  return label === key ? cls : `${label}（${cls}）`
}

/** A long regex (the policy pattern) must not blow up the narrow sidebar. */
function clip(v: string, max = 44): string {
  return v.length <= max ? v : `${v.slice(0, max - 1)}…`
}

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
    // The headline already says the verdict ("干净（公开级）"); repeating it
    // as "判定 dataClass=public" underneath was noise in a narrow column.
    // The evidence line now carries what the headline cannot: who judged,
    // how long it took, how much text was scanned.
    return {
      label: tr('flow.guard'), tone: 'ok',
      detail: cls === 'public' ? tr('flow.guard.public') : classLabel(cls),
      sub: [
        `${tr('flow.lbl.model')} ${str(field(end, 'provider'))}/${str(field(end, 'model'))}`,
        `${tr('flow.lbl.elapsed')} ${ms(field(end, 'durationMs'))} · ${tr('flow.lbl.scanned')} ${str(field(end, 'textLen'))} ${tr('flow.lbl.chars')}`,
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
  // §7.107: the privacy-policy tier decides BEFORE the classifier runs
  // (input-guard.ts §7.87.13.2 short-circuits the LLM call). A turn decided
  // by the policy therefore has NO intent.classify.* row at all — reading
  // only the classifier left the node on "等待" while the routing node
  // below announced the verdict. The policy tier is an intent verdict.
  const policy = latest(rows, r => r.kind === 'input-guard.policy.route-applied')
  if (rejected !== undefined && (end === undefined || rejected.ts > end.ts)) {
    return { label: tr('flow.intent'), tone: 'stop', detail: tr('flow.intent.rejected'), sub: [] }
  }
  if (end !== undefined) {
    const cat = str(field(end, 'category'))
    const conf = pct(field(end, 'confidence'))
    const sub: string[] = [`${tr('flow.lbl.verdict')} ${cat} · ${conf} · ${str(field(end, 'rationale'))}`]
    if (override !== undefined && override.ts <= end.ts) {
      sub.push(`${tr('flow.lbl.override')} ${str(field(override, 'from'))} → ${str(field(override, 'to'))} · ${tr('flow.lbl.entity')} ${str(field(override, 'entity'))}`)
      sub.push(`${tr('flow.lbl.llmSay')} ${str(field(override, 'llmRationale'))} · ${pct(field(override, 'llmConfidence'))} ${tr('flow.lbl.overridden')}`)
    }
    // classifier/textLen live on the classify.start row; duration/category on end.
    const startRow = latest(rows, r => r.kind === 'intent.classify.start')
    const textLen = field(end, 'textLen') ?? field(startRow, 'textLen')
    sub.push(`${tr('flow.lbl.classifier')} ${str(field(startRow, 'classifier'))} · ${tr('flow.lbl.elapsed')} ${ms(field(end, 'durationMs'))} · ${tr('flow.lbl.scanned')} ${str(textLen)} ${tr('flow.lbl.chars')}`)
    // `default:sanitized` rationale = the classifier never returned a verdict
    // (error/timeout upstream — e.g. the model answered non-JSON). Surface
    // WHY from the error rows instead of pretending an LLM decided.
    const isDefault = rationaleStr(end).startsWith('default:')
    if (isDefault) {
      const causeRow = latest(rows, r => /^intent\.(classify\.llm_error|llm\.(timeout|error|provider_error))$/u.test(r.kind))
      if (causeRow !== undefined) sub.push(`${tr('flow.lbl.cause')} ${str(field(causeRow, 'error') ?? field(causeRow, 'reason'))} → ${str(causeRow.kind)}`)
      else sub.push(tr('flow.intent.defaultNoCause'))
    }
    return {
      label: tr('flow.intent'), tone: isDefault ? 'warn' : 'ok',
      detail: `${cat} ${conf} · ${isDefault ? tr('flow.intent.viaDefault') : override !== undefined && override.ts <= end.ts ? tr('flow.intent.viaEntity') : tr('flow.intent.viaLlm')}`,
      sub,
    }
  }
  if (policy !== undefined) {
    // Policy tier verdict — no classifier ran, and none was needed.
    const realm = str(field(policy, 'policyRealm'))
    const confidence = pct(field(policy, 'policyConfidence'))
    const pattern = str(field(policy, 'policyPattern'))
    const rationale = str(field(policy, 'policyRationale'))
    const sub: string[] = []
    if (pattern !== '?') sub.push(`${tr('flow.lbl.rule')} ${clip(pattern)}`)
    if (rationale !== '?') sub.push(`${tr('flow.lbl.reason')} ${rationale}`)
    sub.push(`${tr('flow.lbl.confidence')} ${confidence}`)
    return {
      label: tr('flow.intent'), tone: 'ok',
      detail: `${realm} · ${tr('flow.intent.viaPolicy')}`,
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
  // §7.107: the guard re-announces the rewrite on every answer step, and
  // those later rows are local→local no-ops. Only a row that actually
  // CHANGES the model counts — otherwise the panel showed the no-op and
  // hid the one rewrite that mattered (host model → local model).
  // The newest CHANGING row wins; a turn with only no-ops has no rewrite.
  const realOverride = latest(rows, r => r.kind === 'input-guard.route.overridden' && !sameModel(r, 'from', 'to'))
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
      num(field(blocked, 'confidence')) !== undefined ? `${tr('flow.lbl.confidence')} ${pct(field(blocked, 'confidence'))}` : null,
    ].filter((v): v is string => v !== null)
    if (extras.length > 0) sub.push(extras.join(' · '))
    return { label: tr('flow.route'), tone: 'stop', detail: `${tr('flow.route.blocked')} · ${what}`, sub }
  }
  if (missing !== undefined) return { label: tr('flow.route'), tone: 'warn', detail: tr('flow.route.fallback'), sub: [`${tr('flow.lbl.cause')} ${str(field(missing, 'reason'))}`] }
  if (routed !== undefined) {
    const cat = str(field(routed, 'category'))
    const forced = realOverride !== undefined && realOverride.ts >= routed.ts - 2000
    const sub: string[] = []
    if (realOverride !== undefined) {
      sub.push(`${tr('flow.lbl.rewrite')} ${str(field(realOverride, 'from.provider'))}/${str(field(realOverride, 'from.model'))} → ${str(field(realOverride, 'to.provider'))}/${str(field(realOverride, 'to.model'))}`)
      sub.push(`${tr('flow.lbl.reason')} ${reasonLabel(str(field(realOverride, 'reason')))}`)
    }
    sub.push(`${tr('flow.lbl.entry')} ${str(field(routed, 'routeSource'))} · ${tr('flow.lbl.pool')} ${routed.payload.edgeRouteUsed === true ? tr('flow.lbl.used') : tr('flow.lbl.hostOwn')}`)
    return {
      label: tr('flow.route'), tone: 'ok',
      detail: forced ? `${cat} · ${tr('flow.route.forced')}` : `${cat} · ${tr('flow.route.kept')}`,
      sub,
    }
  }
  if (intentStarted(rows)) return { label: tr('flow.route'), tone: 'run', detail: tr('flow.running'), sub: [] }
  return { label: tr('flow.route'), tone: 'wait', detail: tr('flow.wait'), sub: [] }
}

/** True when a route-override row does not actually change the model.
 *
 *  The host flattens the row's nested `from`/`to` objects one level deep
 *  (`from.provider`, `from.model`, … — edge-context-view.ts safePayload),
 *  so the comparison reads those dotted keys, not the parent objects. */
function sameModel(r: EdgeRow, fromKey: string, toKey: string): boolean {
  const fp = field(r, `${fromKey}.provider`)
  const fm = field(r, `${fromKey}.model`)
  const tp = field(r, `${toKey}.provider`)
  const tm = field(r, `${toKey}.model`)
  if (fp === undefined && fm === undefined && tp === undefined && tm === undefined) return false
  return str(fp) === str(tp) && str(fm) === str(tm)
}

/** Machine reason codes → operator language. */
function reasonLabel(reason: string): string {
  switch (reason) {
    case 'intent-local': return tr('flow.reason.intentLocal')
    case 'intent-sanitized': return tr('flow.reason.intentSanitized')
    case 'policy-rule': return tr('flow.reason.policyRule')
    default: return reason
  }
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
  // No in-window host.route ≠ no route: `request/context` fires only on
  // CHANGES, so a same-model turn carries the session's last observed route
  // forward (flagged with a 沿用 note — the distinction from a fresh
  // announcement stays honest). Nothing ever seen → honest pending.
  const host = latest(rows, r => r.kind === 'llm.host.route')
  const effective = host !== undefined
    ? { provider: str(field(host, 'provider')), model: str(field(host, 'model')), carried: false }
    : summary.lastRoute !== undefined
      ? { provider: summary.lastRoute.provider, model: summary.lastRoute.model, carried: true }
      : undefined
  if (effective === undefined) {
    return { label: tr('flow.answer'), tone: 'wait', detail: tr('flow.answer.pending'), sub: [] }
  }
  const { provider, model, carried } = effective
  const local = provider.startsWith('local-llm')
  const answerSteps = rows.filter(r => r.kind === 'llm.local.end' && typeof r.payload.promptLen === 'number' && (r.payload.promptLen as number) > 1000)
  const sub: string[] = [
    `${tr('flow.lbl.route')} ${provider}/${model}${carried ? ` · ${tr('flow.answer.carried')}` : ''}`,
    local ? tr('flow.a.localKeep') : tr('flow.a.cloudSend'),
  ]
  if (local && answerSteps.length > 0) {
    const total = answerSteps.reduce((n, r) => n + (typeof r.payload.durationMs === 'number' ? r.payload.durationMs : 0), 0)
    sub.push(`${tr('flow.lbl.steps')} ×${answerSteps.length} · ${tr('flow.lbl.total')} ${ms(total)} · ${tr('flow.lbl.context')} ${str(answerSteps.at(-1)?.payload.promptLen)} ${tr('flow.lbl.chars')}`)
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
  const policy = latest(rows, r => r.kind === 'input-guard.policy.route-applied')
  // §7.107: the category the turn actually ran under — the classifier's
  // verdict when it spoke, the policy tier's realm when the policy decided
  // first (the classifier is then skipped entirely).
  const category = classifyEnd !== undefined
    ? String(classifyEnd.payload.category ?? '')
    : policy !== undefined
      ? String(policy.payload.policyRealm ?? '')
      : undefined
  const nodes: FlowNode[] = [
    guardNode(rows),
    intentNode(rows),
    sanitizeNode(rows, category),
    routeNode(rows),
    answerNode(rows, summary),
    threatNode(rows),
  ]
  // §7.107: three-level rhythm for every node — label line, verdict line,
  // evidence lines. The label used to share a baseline with the verdict,
  // so a long verdict wrapped under the label and the column lost its
  // grid. The verdict now always starts on its own line.
  const children = nodes.flatMap((n, i) => [
    h('div', { key: `n${i}`, class: `dsh-edge-flow-node dsh-edge-flow-node--${n.tone}` },
      h('div', { class: 'dsh-edge-flow-head' },
        h('span', { class: 'dsh-edge-flow-dot' }),
        h('span', { class: 'dsh-edge-flow-label' }, n.label),
      ),
      h('div', { class: 'dsh-edge-flow-detail' }, n.detail),
      n.sub.length > 0
        ? h('div', { class: 'dsh-edge-flow-sub' }, ...n.sub.map((s, j) => h('div', { key: j }, s)))
        : null,
    ),
    ...(i < nodes.length - 1 ? [h('div', { key: `a${i}`, class: 'dsh-edge-flow-arrow' }, ARROW)] : []),
  ])
  return h('div', { class: 'dsh-edge-flow' }, ...children)
}
