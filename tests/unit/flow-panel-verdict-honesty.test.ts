/**
 * §7.129 / §7.130 —— 面板不得断言与审计数据相矛盾的事
 *
 * 真实桌面截图（发「开灯」）暴露了**一处**不诚实：
 *
 *  1. **意图判定标题写「LLM 裁决」，但分类器一次都没被调用。**
 *     §7.124 的 Tier-0 设备指令正则层直接定案（intent.classify.end 的
 *     durationMs=1，path=device-command，LLM 分类器压根没跑），但标题
 *     掉进了 `viaLlm` 兜底分支 —— 与同屏的「裁决者 device-command」
 *     自相矛盾。分类器没跑却宣称它裁决了。**这一条 §7.130 保留。**
 *
 * §7.129 曾把同一轮的端点位置（`http://67.0.***.***:11434/v1`，不在本机）
 * 推导成「出网」，并据此改写了顶部结论 / PII 节点 / 答案出口三处文案。
 *
 * **§7.130 撤回那部分**（主人裁决，2026-10-27）：
 *
 * > 「只要定位到 category=LOCAL，就不算到公网，不用关心具体的模型来源。」
 *
 * 判定「是否出网」的依据是 **category（哪个池）**，**不是**端点落在哪台机。
 * `llm.local` 池是 operator 自有设施（当前部署指向 67.0.0.5 —— 那是
 * operator 自己的机器/内网），所以 provider 名叫 `local-llm`、端点不在
 * 本机，**都不构成出网**。
 *
 * 因此本文件钉死的是：**端点位置不参与出网判断**。凡是端点推导出来的
 * 文案（「落点不在本机」「未脱敏（落点不在本机）」「全部离开了本机」）
 * 都不许再出现；出网结论只看 category。
 *
 * 同时钉死：**§7.122 的分类器落点披露仍然保留**（那是备查信息，不是出网
 * 判断）—— 「真实落点 http://… · 不在本机」这一行继续透出。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { FlowPanel } from '../../src/client/flowPanel'
import { verdictLine } from '../../src/client/verdict'
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
 * 实测那一轮「开灯」的行 —— 出口端点确实**不在本机**（67.0.***.*** 是
 * operator 自己的机器/内网，不是公网）。
 *
 * §7.130 起，这一行**不再**影响任何出网结论：category=LOCAL 即不出网。
 */
const REAL_TURN_ROWS: EdgeRow[] = [
  row('intent.classify.start', {
    classifier: 'local-llm',
    model: 'qwen3.8:27b',
    textLen: 2,
    classifierEndpoint: 'http://67.0.***.***:11434/v1',
    classifierIsLocal: false,
  }, 'intent'),
  row('intent.classify.end', {
    path: 'device-command',
    category: 'LOCAL',
    confidence: 0.95,
    rationale: 'device-command:开:灯',
    durationMs: 1,
    textLen: 2,
  }, 'intent'),
  row('llm.local.start', {
    provider: 'local-llm',
    model: 'qwen3.8:27b',
    route: 'qwen3.8:27b',
    messageCount: 69,
    promptLen: 31587,
    baseUrl: 'http://67.0.***.***:11434/v1',
  }, 'route'),
]

describe('§7.129 — 意图判定节点：device-command 不得宣称 LLM 裁决（§7.130 保留）', () => {
  it('标题显示「设备指令正则裁决」而不是「LLM 裁决」', () => {
    const out = render(REAL_TURN_ROWS)
    assert.ok(out.includes('设备指令正则裁决'), `headline missing: ${out}`)
    assert.ok(!out.includes('LLM 裁决'), `must not claim the LLM classifier decided: ${out}`)
  })

  it('裁决者行显示「设备指令正则（分类器未调用）」', () => {
    const out = render(REAL_TURN_ROWS)
    assert.ok(out.includes('设备指令正则（分类器未调用）'), `decider missing: ${out}`)
    assert.ok(!out.includes('LLM 分类器'), `must not name the LLM classifier: ${out}`)
  })

  it('机器码路径仍然透出（路径 device-command）', () => {
    const out = render(REAL_TURN_ROWS)
    assert.ok(out.includes('device-command'), `machine path missing: ${out}`)
  })

  it('LLM 真的裁决时不受影响（不误伤）', () => {
    const rows = [
      row('intent.classify.start', { classifier: 'local-llm', model: 'qwen3-4b', textLen: 6 }, 'intent'),
      row('intent.classify.end', {
        path: 'llm',
        category: 'LOCAL',
        confidence: 0.98,
        rationale: 'llm-classified:local',
        durationMs: 300,
        textLen: 6,
      }, 'intent'),
    ]
    const out = render(rows)
    assert.ok(out.includes('LLM 裁决'), `llm headline missing: ${out}`)
    assert.ok(out.includes('LLM 分类器'), `llm decider missing: ${out}`)
  })
})

describe('§7.130 — 顶部结论：出网判据是 category，不是端点', () => {
  it('category=LOCAL 且端点不在本机 → 仍然是「数据未离开设备」（端点位置不是判据）', () => {
    // 实测那一轮：出口落点是 http://67.0.***.***:11434/v1，不在本机。
    // 但 category=LOCAL = 走 operator 自有的 llm.local 池 ⇒ 不算出网。
    const v = verdictLine(REAL_TURN_ROWS)
    assert.ok(v.text.includes('数据未离开设备'), `expected the LOCAL verdict: ${v.text}`)
    assert.equal(v.tone, 'local')
  })

  it('结论文案里不得再出现端点推导的字样（落点不在本机 / 待确认）', () => {
    const v = verdictLine(REAL_TURN_ROWS)
    assert.ok(!v.text.includes('落点不在本机'), `endpoint-derived wording must be gone: ${v.text}`)
    assert.ok(!v.text.includes('待确认'), `endpoint-derived wording must be gone: ${v.text}`)
  })

  it('出口行即使残留 baseUrlIsLocal=false（旧字段/旧产物）也不得改变结论', () => {
    // 服务端已不再下发该字段；即便历史行里还带着它，也不再被读取。
    const v = verdictLine([
      row('intent.classify.end', { path: 'llm', category: 'LOCAL', confidence: 0.9 }, 'intent'),
      row('llm.local.start', { provider: 'local-llm', baseUrl: 'http://67.0.***.***:11434/v1', baseUrlIsLocal: false }, 'route'),
    ])
    assert.ok(v.text.includes('数据未离开设备'), `expected the LOCAL verdict: ${v.text}`)
    assert.equal(v.tone, 'local')
  })

  it('policy 层定的 LOCAL（分类器没跑）也算不出网', () => {
    const v = verdictLine([
      row('input-guard.policy.route-applied', { policyRealm: 'LOCAL', ruleId: 'device-command' }, 'intent'),
      row('llm.local.start', { provider: 'local-llm', baseUrl: 'http://67.0.***.***:11434/v1' }, 'route'),
    ])
    assert.ok(v.text.includes('数据未离开设备'), `expected the LOCAL verdict: ${v.text}`)
    assert.equal(v.tone, 'local')
  })

  it('category=CLOUD → 仍然是云端结论', () => {
    const v = verdictLine([
      row('intent.classify.end', { path: 'llm', category: 'CLOUD', confidence: 0.9 }, 'intent'),
      row('llm.cloud.start', { provider: 'cloud-llm', baseUrl: 'https://api.example.com/v1' }, 'route'),
    ])
    assert.ok(v.text.includes('云端作答'), `expected the cloud verdict: ${v.text}`)
    assert.equal(v.tone, 'cloud')
  })

  it('什么都还没发生时仍然是「等待意图判定」', () => {
    const v = verdictLine([row('intent.classify.start', { classifier: 'local-llm' })])
    assert.ok(v.text.includes('等待意图判定'), `expected waiting: ${v.text}`)
    assert.equal(v.tone, 'wait')
  })
})

describe('§7.130 — PII 节点：LOCAL 一律「无需脱敏」，不看端点', () => {
  it('category=LOCAL 且端点不在本机 → 「无需（本地作答）」/「答案不出设备，无需脱敏」', () => {
    const rows = [
      row('intent.classify.end', { path: 'device-command', category: 'LOCAL', confidence: 0.95 }, 'intent'),
      row('llm.local.start', { provider: 'local-llm', baseUrl: 'http://67.0.***.***:11434/v1' }, 'route'),
    ]
    const out = render(rows)
    assert.ok(out.includes('无需（本地作答）'), `expected the local skip: ${out}`)
    assert.ok(out.includes('答案不出设备，无需脱敏'), `expected the local reason: ${out}`)
  })

  it('端点推导出来的告警文案不得再出现', () => {
    const rows = [
      row('intent.classify.end', { path: 'device-command', category: 'LOCAL', confidence: 0.95 }, 'intent'),
      row('llm.local.start', { provider: 'local-llm', baseUrl: 'http://67.0.***.***:11434/v1' }, 'route'),
    ]
    const out = render(rows)
    assert.ok(!out.includes('未脱敏（落点不在本机）'), `endpoint-derived warning must be gone: ${out}`)
    assert.ok(!out.includes('本轮原文未脱敏发出'), `endpoint-derived warning must be gone: ${out}`)
  })

  it('category=CLOUD → 走已检查/无 PII 那一支（不误伤）', () => {
    const rows = [
      row('intent.classify.end', { path: 'llm', category: 'CLOUD', confidence: 0.9 }, 'intent'),
      row('llm.cloud.start', { provider: 'cloud-llm', baseUrl: 'https://api.example.com/v1' }, 'route'),
    ]
    const out = render(rows)
    assert.ok(out.includes('未发现 PII'), `expected the checked wording: ${out}`)
    assert.ok(out.includes('已检查，出向文本无 PII'), `expected the checked reason: ${out}`)
  })
})

describe('§7.130 — 答案出口：LOCAL 一律「全部留在本机」，不看端点', () => {
  it('本地池且端点不在本机 → 「问题、上下文、答案全部留在本机」', () => {
    const rows = [
      row('llm.local.start', { provider: 'local-llm', model: 'qwen3.8:27b', baseUrl: 'http://67.0.***.***:11434/v1' }, 'route'),
      row('llm.local.end', {
        provider: 'local-llm', model: 'qwen3.8:27b', route: 'qwen3.8:27b',
        durationMs: 96384, promptLen: 31587, resultLen: 118,
      }, 'route'),
    ]
    const out = render(rows)
    assert.ok(out.includes('问题、上下文、答案全部留在本机'), `expected the local wording: ${out}`)
  })

  it('端点推导出来的「全部离开了本机」不得再出现', () => {
    const rows = [
      row('llm.local.start', { provider: 'local-llm', model: 'qwen3.8:27b', baseUrl: 'http://67.0.***.***:11434/v1' }, 'route'),
      row('llm.local.end', {
        provider: 'local-llm', model: 'qwen3.8:27b', route: 'qwen3.8:27b',
        durationMs: 96384, promptLen: 31587, resultLen: 118,
      }, 'route'),
    ]
    const out = render(rows)
    assert.ok(!out.includes('全部离开了本机'), `endpoint-derived wording must be gone: ${out}`)
  })

  it('云池 → 「出网文本已先行检查/脱敏」（不误伤）', () => {
    const rows = [
      row('llm.cloud.start', { provider: 'cloud-llm', model: 'gpt-x' }, 'route'),
      row('llm.cloud.end', { provider: 'cloud-llm', model: 'gpt-x', durationMs: 1200 }, 'route'),
    ]
    const out = render(rows)
    assert.ok(out.includes('出网文本已先行检查/脱敏'), `expected the cloud wording: ${out}`)
  })
})

describe('§7.130 — §7.122 的分类器落点披露仍然保留（备查信息，不是出网判断）', () => {
  it('意图判定节点继续透出「真实落点 … · 不在本机」', () => {
    const out = render(REAL_TURN_ROWS)
    assert.ok(out.includes('真实落点'), `the endpoint disclosure must stay: ${out}`)
    assert.ok(out.includes('不在本机'), `the endpoint disclosure must stay: ${out}`)
  })
})
