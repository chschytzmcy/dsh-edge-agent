/**
 * §7.219 —— 这一轮被 **fail-closed 拒收**时，面板必须说「没作答」
 *
 * ## 起因（实机复现，§7.216）
 *
 * §7.210 / §7.214 的严格档（`llm.local.requireLocalEndpoint=true`）在真机上
 * 拒收了一轮，审计链留下：
 *
 * ```json
 * {"level":"security","kind":"input-guard.reroute.blocked","payload":{
 *   "provider":"qwen-token-plan-cn","model":"deepseek-v4.1-flash",
 *   "reason":"local-endpoint-required","delegateProvider":"qwen-token-plan-cn",
 *   "delegateRealm":"UNKNOWN","realmSource":"model-router-missing"}}
 * ```
 *
 * 那一轮**没有发出任何 LLM 请求**（面板：LLM 调用 0、答案出口「路由未定」），
 * 可面板却写着：
 *
 *   · 顶部结论：「本轮：本地模型作答 —— 数据未离开设备」← **与实际行为相反**
 *   · 路由决策：「LOCAL · 按原选择」← **完全看不出这一轮被拒收了**
 *
 * ⇒ §7.129 的原则（「不写与实际行为相反的事」）在这里被顶破了：
 * 结论行判的是**意图分类**的 `category=LOCAL`，判的不是「这一轮真的作答了」。
 * §7.210 之前 DELEGATE 永远放行 ⇒ 那句话**总是**真的；**严格档第一次让
 * 「判定 LOCAL 但这一轮没作答」成为可能**。
 *
 * ## 这一节钉住的口径
 *
 * 1. 被拒收 ⇒ 顶部结论写「本轮：已拦截 —— 未作答」，tone = `blocked`；
 * 2. 路由决策写「已拦截 · local-endpoint-required」（**原因码**就是为什么被拒）；
 * 3. 落点证据透出：真实落点 / realm / 判定依据（§7.214 的三个字段）；
 * 4. **不误伤**：没有被拒收的轮次，结论行仍然是「本地模型作答」；
 * 5. **口径一致**：`input-guard.blocked.*`（攻击 / 策略 / 模型选择）也是
 *    「本轮没作答」⇒ 同样显示「已拦截 —— 未作答」——
 *    否则会出现「严格档拒收显示已拦截，攻击拦截却仍显示作答了」的自相矛盾；
 * 6. **不显示原文**：面板的硬规则是 no original content（审计留在本地）。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { FlowPanel } from '../../src/client/flowPanel'
import { verdictLine } from '../../src/client/verdict'
import { tr } from '../../src/client/i18n'
import type { EdgeRow, EdgeSummary } from '../../src/client/types'

let seq = 0
let ts = 1_700_000_000_000

function row(kind: string, payload: Record<string, unknown>, panel: EdgeRow['panel'] = 'intent'): EdgeRow {
  seq += 1
  ts += 1000
  return { ts, kind, panel, level: 'info', seq, payload }
}

const SUMMARY: EdgeSummary = { sessionId: 's1', turns: 1 }

function render(rows: EdgeRow[], summary: EdgeSummary = SUMMARY): string {
  return renderToStaticMarkup(FlowPanel({ rows, summary })) as unknown as string
}

/**
 * 严格档被拒收的那一轮（实机取证，§7.216 的审计链第 486 / 487 行）。
 *
 * 注意 `intent.classify.end` 的 `category=LOCAL` —— 它**照样**是 LOCAL：
 * 被拒收的原因不是「判定成 CLOUD」，而是「委托落点证不出来是本地」。
 */
const STRICT_TURN_ROWS: EdgeRow[] = [
  row('intent.classify.end', { path: 'llm', category: 'LOCAL', confidence: 0.9 }, 'intent'),
  row('input-guard.reroute.delegate-egress', {
    from: { provider: 'qwen-token-plan-cn', model: 'deepseek-v4.1-flash' },
    to: { provider: 'local-llm', model: 'deepseek-v4.1-flash' },
    delegateProvider: 'qwen-token-plan-cn',
    delegateRealm: 'UNKNOWN',
    realmSource: 'model-router-missing',
    reason: 'local-pool-delegate',
    blocked: true,
  }, 'route'),
  row('input-guard.reroute.blocked', {
    sessionId: 'session-8393eb16-9b90-49ed-a0b0-6b9d4fc9c7c0',
    provider: 'qwen-token-plan-cn',
    model: 'deepseek-v4.1-flash',
    reason: 'local-endpoint-required',
    delegateProvider: 'qwen-token-plan-cn',
    delegateRealm: 'UNKNOWN',
    realmSource: 'model-router-missing',
  }, 'route'),
]

describe('§7.219 — 顶部结论：被拒收的轮次不许说「本地模型作答」', () => {
  it('显示「已拦截 —— 未作答」，tone = blocked', () => {
    const v = verdictLine(STRICT_TURN_ROWS)
    assert.ok(v.text.includes('已拦截'), `expected the blocked verdict: ${v.text}`)
    assert.ok(v.text.includes('未作答'), `expected the blocked verdict: ${v.text}`)
    assert.equal(v.tone, 'blocked')
  })

  it('**不得**再出现「本地模型作答」（与实际行为相反的陈述）', () => {
    const v = verdictLine(STRICT_TURN_ROWS)
    assert.ok(!v.text.includes('本地模型作答'), `must not claim it was answered: ${v.text}`)
    assert.ok(!v.text.includes('数据未离开设备'), `must not claim an answer: ${v.text}`)
  })

  it('不误伤：没有被拒收的轮次，结论行仍然是「本地模型作答」', () => {
    const rows = [
      row('intent.classify.end', { path: 'llm', category: 'LOCAL', confidence: 0.9 }, 'intent'),
      row('llm.local.start', { provider: 'local-llm', model: 'qwen3.8:27b' }, 'route'),
    ]
    const v = verdictLine(rows)
    assert.ok(v.text.includes('本地模型作答'), `expected the LOCAL verdict: ${v.text}`)
    assert.equal(v.tone, 'local')
  })

  it('口径一致：`input-guard.blocked.*`（攻击 / 策略）同样是「没作答」', () => {
    const v = verdictLine([
      row('intent.classify.end', { path: 'llm', category: 'LOCAL', confidence: 0.9 }, 'intent'),
      row('input-guard.blocked.attack', { reason: 'injection', riskLevel: 'high' }, 'interception'),
    ])
    assert.ok(v.text.includes('已拦截'), `expected the blocked verdict: ${v.text}`)
    assert.equal(v.tone, 'blocked')
  })

  it('两种拒收都发生时，取「被拒收」而不是「等待意图判定」', () => {
    const v = verdictLine([
      row('input-guard.reroute.blocked', { reason: 'local-endpoint-required' }, 'route'),
    ])
    assert.equal(v.tone, 'blocked')
  })
})

describe('§7.219 — 路由决策：认 `input-guard.reroute.blocked`', () => {
  it('显示「已拦截 · local-endpoint-required」（原因码就是为什么被拒）', () => {
    const out = render(STRICT_TURN_ROWS)
    assert.ok(out.includes('已拦截 · local-endpoint-required'), `blocked detail missing: ${out}`)
  })

  it('**不得**再说「按原选择」（那一轮压根没走成）', () => {
    const out = render(STRICT_TURN_ROWS)
    assert.ok(!out.includes(tr('flow.route.kept')), `must not claim the route was kept: ${out}`)
  })

  it('落点证据透出：真实落点 / realm / 判定依据', () => {
    const out = render(STRICT_TURN_ROWS)
    assert.ok(out.includes('真实落点 qwen-token-plan-cn'), `landing missing: ${out}`)
    assert.ok(out.includes('realm UNKNOWN'), `realm missing: ${out}`)
    assert.ok(out.includes('判定依据 model-router-missing'), `realm source missing: ${out}`)
  })

  it('别的拒收原因码也照样显示「已拦截 · <原因码>」', () => {
    const out = render([
      row('intent.classify.end', { path: 'llm', category: 'LOCAL' }, 'intent'),
      row('input-guard.reroute.blocked', { reason: 'local-model-unresolved' }, 'route'),
    ])
    assert.ok(out.includes('已拦截 · local-model-unresolved'), `blocked detail missing: ${out}`)
  })

  it('不误伤：没有被拒收的轮次，路由决策仍是「按原选择」', () => {
    const out = render([
      row('intent.classify.end', { path: 'llm', category: 'LOCAL' }, 'intent'),
      row('input-guard.routed', { category: 'LOCAL', provider: 'qwen-token-plan-cn', model: 'm' }, 'route'),
    ])
    assert.ok(out.includes(tr('flow.route.kept')), `route must stay as-is: ${out}`)
    assert.ok(!out.includes('已拦截 ·'), `must not claim a block: ${out}`)
  })

  it('面板不显示原文（审计留在本地）', () => {
    const out = render([
      row('intent.classify.end', { path: 'llm', category: 'LOCAL' }, 'intent'),
      row('input-guard.reroute.blocked', {
        reason: 'local-endpoint-required',
        preview: '查本地IP',
        original: '查本地IP',
      }, 'route'),
    ])
    assert.ok(!out.includes('查本地IP'), `raw user text must never reach the panel: ${out}`)
  })
})
