/**
 * §7.129 —— 面板不得断言与审计数据相矛盾的事
 *
 * 真实桌面截图（发「开灯」）暴露了两处不诚实：
 *
 *  1. **意图判定标题写「LLM 裁决」，但分类器一次都没被调用。**
 *     §7.124 的 Tier-0 设备指令正则层直接定案（intent.classify.end 的
 *     durationMs=1，path=device-command，LLM 分类器压根没跑），但标题
 *     掉进了 `viaLlm` 兜底分支 —— 与同屏的「裁决者 device-command」
 *     自相矛盾。分类器没跑却宣称它裁决了。
 *
 *  2. **顶部结论写「数据未离开设备」，但原文确实出了设备。**
 *     那一轮的答案发去了 `http://67.0.***.***:11434/v1`（公网，31587
 *     字符）—— 与同一屏「真实落点 · 不在本机」自相矛盾。provider 名叫
 *     `local-llm` 不代表落点在本机（§7.118 的 P0，用户裁决维持现状）。
 *
 * 修法：判定落点的**事实**由服务端算成布尔值 `baseUrlIsLocal` 随出口行
 * 下发（审计里的 baseUrl 是脱敏的 `67.0.***.***`，客户端算不出来），
 * 面板只在**能证实**的时候才下断言。
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

/** 实测那一轮「开灯」的行（脱敏后的 baseUrl，§7.129 之前的样子）。*/
const REAL_TURN_ROWS = (baseUrlIsLocal?: boolean): EdgeRow[] => [
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
    ...(baseUrlIsLocal === undefined ? {} : { baseUrlIsLocal }),
  }, 'route'),
]

describe('§7.129 — 意图判定节点：device-command 不得宣称 LLM 裁决', () => {
  it('标题显示「设备指令正则裁决」而不是「LLM 裁决」', () => {
    const out = render(REAL_TURN_ROWS(false))
    assert.ok(out.includes('设备指令正则裁决'), `headline missing: ${out}`)
    assert.ok(!out.includes('LLM 裁决'), `must not claim the LLM classifier decided: ${out}`)
  })

  it('裁决者行显示「设备指令正则（分类器未调用）」', () => {
    const out = render(REAL_TURN_ROWS(false))
    assert.ok(out.includes('设备指令正则（分类器未调用）'), `decider missing: ${out}`)
    assert.ok(!out.includes('LLM 分类器'), `must not name the LLM classifier: ${out}`)
  })

  it('机器码路径仍然透出（路径 device-command）', () => {
    const out = render(REAL_TURN_ROWS(false))
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

describe('§7.129 — 顶部结论：「数据未离开设备」必须能被出口端点证实', () => {
  it('出口行证实落在本机 → 保留隐私承诺', () => {
    const v = verdictLine([
      row('intent.classify.end', { path: 'llm', category: 'LOCAL', confidence: 0.9 }, 'intent'),
      row('llm.local.start', { provider: 'local-llm', baseUrl: 'http://127.0.0.1:8080/v1', baseUrlIsLocal: true }, 'route'),
    ])
    assert.ok(v.text.includes('数据未离开设备'), `expected the privacy promise: ${v.text}`)
    assert.equal(v.tone, 'local')
  })

  it('出口行证实不在本机 → 不得再说「数据未离开设备」', () => {
    const v = verdictLine(REAL_TURN_ROWS(false))
    assert.ok(v.text.includes('落点不在本机'), `expected the off-device disclosure: ${v.text}`)
    assert.ok(!v.text.includes('数据未离开设备'), `must not claim the data stayed: ${v.text}`)
    assert.equal(v.tone, 'warn')
  })

  it('出口行还没落 → 不下断言，说「落点待确认」', () => {
    const v = verdictLine([
      row('intent.classify.end', { path: 'llm', category: 'LOCAL', confidence: 0.9 }, 'intent'),
    ])
    assert.ok(v.text.includes('落点待确认'), `expected the pending state: ${v.text}`)
    assert.ok(!v.text.includes('数据未离开设备'), `must not make an unproven promise: ${v.text}`)
  })

  it('出口行带了 baseUrlIsLocal=false 时，即使 provider 叫 local-llm 也不许说「未离开设备」', () => {
    // provider 名字骗人，落点不骗人 —— 这正是 §7.118 的 P0。
    const v = verdictLine([
      row('input-guard.routed', { category: 'LOCAL', edgeRouteUsed: false, routeSource: 'webui' }, 'intent'),
      row('llm.local.start', { provider: 'local-llm', baseUrlIsLocal: false }, 'route'),
    ])
    assert.ok(!v.text.includes('数据未离开设备'), `must not claim the data stayed: ${v.text}`)
    assert.equal(v.tone, 'warn')
  })

  it('CLOUD 轮次仍然是云端结论', () => {
    const v = verdictLine([
      row('intent.classify.end', { path: 'llm', category: 'CLOUD', confidence: 0.9 }, 'intent'),
      row('llm.cloud.start', { provider: 'cloud-llm', baseUrlIsLocal: false }, 'route'),
    ])
    assert.ok(v.text.includes('云端作答'), `expected the cloud verdict: ${v.text}`)
    assert.equal(v.tone, 'cloud')
  })

  it('什么都没发生时仍然是「等待意图判定」', () => {
    const v = verdictLine([row('intent.classify.start', { classifier: 'local-llm' })])
    assert.ok(v.text.includes('等待意图判定'), `expected waiting: ${v.text}`)
    assert.equal(v.tone, 'wait')
  })
})

describe('§7.129 — PII 节点：落点不在本机时不得说「答案不出设备」', () => {
  // 「无需脱敏」的理由是「答案不出设备」—— 而这句话只有在本地池**真的**落在
  // 本机时才成立。实测：83 个 LOCAL 轮次，脱敏事件 0 次（19 次脱敏全部是
  // CLOUD / SANITIZED 轮次），而 LOCAL 的落点是公网 67.0.0.5 —— 也就是说
  // LOCAL 轮次里的 PII 是**未脱敏**发出去的。
  it('落点不在本机 → 「未脱敏（落点不在本机）」并明确告警', () => {
    const rows = [
      row('intent.classify.end', { path: 'device-command', category: 'LOCAL', confidence: 0.95 }, 'intent'),
      row('llm.local.start', { provider: 'local-llm', baseUrlIsLocal: false }, 'route'),
    ]
    const out = render(rows)
    assert.ok(out.includes('未脱敏（落点不在本机）'), `expected the warning: ${out}`)
    assert.ok(out.includes('本轮原文未脱敏发出'), `expected the disclosure: ${out}`)
    assert.ok(!out.includes('答案不出设备'), `must not claim the answer stayed on-device: ${out}`)
  })

  it('落点在本机 → 保留「答案不出设备，无需脱敏」', () => {
    const rows = [
      row('intent.classify.end', { path: 'llm', category: 'LOCAL', confidence: 0.9 }, 'intent'),
      row('llm.local.start', { provider: 'local-llm', baseUrlIsLocal: true }, 'route'),
    ]
    const out = render(rows)
    assert.ok(out.includes('答案不出设备'), `expected the original wording: ${out}`)
  })

  it('落点未知 → 「落点待确认 —— 未做脱敏」，不得断言「答案不出设备」', () => {
    const rows = [
      row('intent.classify.end', { path: 'llm', category: 'LOCAL', confidence: 0.9 }, 'intent'),
    ]
    const out = render(rows)
    assert.ok(out.includes('落点待确认'), `expected the pending state: ${out}`)
    assert.ok(!out.includes('答案不出设备'), `must not make an unproven claim: ${out}`)
  })
})

describe('§7.129 — 答案出口：落点不在本机时不得说「全部留在本机」', () => {
  it('落点不在本机 → 「全部离开了本机」', () => {
    const rows = [
      row('llm.local.start', { provider: 'local-llm', model: 'qwen3.8:27b', baseUrlIsLocal: false }, 'route'),
      row('llm.local.end', {
        provider: 'local-llm', model: 'qwen3.8:27b', route: 'qwen3.8:27b',
        durationMs: 96384, promptLen: 31587, resultLen: 118,
      }, 'route'),
    ]
    const out = render(rows)
    assert.ok(out.includes('全部离开了本机'), `expected the disclosure: ${out}`)
    assert.ok(!out.includes('全部留在本机'), `must not claim it stayed: ${out}`)
  })

  it('落点在本机 → 保留「全部留在本机」', () => {
    const rows = [
      row('llm.local.start', { provider: 'local-llm', model: 'qwen3-4b', baseUrlIsLocal: true }, 'route'),
      row('llm.local.end', {
        provider: 'local-llm', model: 'qwen3-4b', route: 'qwen3-4b',
        durationMs: 2063, promptLen: 101298, resultLen: 412,
      }, 'route'),
    ]
    const out = render(rows)
    assert.ok(out.includes('全部留在本机'), `expected the original wording: ${out}`)
  })
})
