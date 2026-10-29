/**
 * §7.145 契约测试 —— 未绑定会话时的面板口径。
 *
 * Edge tab 常驻之后（§7.142），主人可以在**还没绑定会话**的时候打开面板。
 * 此前面板把**全局汇总**当成「这一轮」显示：轮次 0 / 「本轮：等待意图判定」/
 * 五节点流程 / 「LLM 调用 0」—— 看着像一个真的在跑的会话（§7.129 最怕的那种误导）。
 *
 * 这里钉住三条契约：
 *
 *   1. **绑定判据**：宿主没给会话（空 / `_global`）⇒ 未绑定；给了会话但面板里
 *      **没有一条属于它的行** ⇒ 同样未绑定（空白草稿会话的形态）；
 *   2. **不出现「本轮」**：未绑定时面板里一个「本轮」字样都不许有 ——
 *      没有会话就没有「这一轮」；
 *   3. **全局信号一条不藏**：全局桶里的行照常列出，只是分组标题写「全局信号」。
 *
 * 实机复验（2026-10-29）改了判据的落点：桌面版开机就建草稿会话，sessionId
 * 真实且非空 ⇒ 光看 id 判不出来 ⇒ 判据改成**行**（全局行带 turn = -1 哨兵）。
 */

import assert from 'node:assert/strict'
import { beforeEach, describe, it, vi } from 'vitest'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type { EdgeRow, EdgeSummary } from '../../src/client/types'

// ── store 的可控替身 ──────────────────────────────────────────────────────
// EdgeView 从 store 取「当前轮的行」和「会话摘要」。判据落在行上，所以测试
// 必须能摆出行；生产代码不为此开洞（store 是模块级单例，没有播种口）。
const { storeState } = vi.hoisted(() => ({ storeState: new Map<string, { rows: unknown[]; summary: unknown }>() }))

vi.mock('../../src/client/store', () => ({
  edgeStore: {
    attach: () => () => {},
    currentRows: (sessionId: string) => (storeState.get(sessionId)?.rows ?? []) as never,
    summaryFor: (sessionId: string) => (storeState.get(sessionId)?.summary ?? { sessionId, turns: 0 }) as never,
    rowsFor: () => [],
    failing: () => false,
  },
}))

const { GLOBAL_BUCKET, GLOBAL_ROW_TURN, UnboundView, globalSignalGroups, isBoundSession, isGlobalRow, isUnboundPanel } =
  await import('../../src/client/unbound')
const { EdgeView } = await import('../../src/client/index')

let seq = 0
let ts = 1_700_000_000_000

function row(kind: string, panel: EdgeRow['panel'], payload: Record<string, unknown> = {}, turn?: number): EdgeRow {
  seq += 1
  ts += 1000
  const r: EdgeRow = { ts, kind, panel, level: 'info', seq, payload }
  if (turn !== undefined) r.turn = turn
  return r
}

/** 一行全局桶的行（宿主给的 turn = -1 哨兵）。 */
function globalRow(kind: string, panel: EdgeRow['panel'], payload: Record<string, unknown> = {}): EdgeRow {
  return row(kind, panel, payload, GLOBAL_ROW_TURN)
}

/** 一行属于某个会话自己的行。 */
function sessionRow(kind: string, panel: EdgeRow['panel'], payload: Record<string, unknown> = {}, turn = 0): EdgeRow {
  return row(kind, panel, payload, turn)
}

/** 给某个会话摆好 store 状态。 */
function seed(sessionId: string, rows: EdgeRow[], summary?: Partial<EdgeSummary>): void {
  storeState.set(sessionId, {
    rows,
    summary: { sessionId, turns: 0, ...summary },
  })
}

beforeEach(() => {
  storeState.clear()
})

describe('isBoundSession', () => {
  it('没有 sessionId 或空串 ⇒ 未绑定', () => {
    assert.equal(isBoundSession(undefined), false)
    assert.equal(isBoundSession(''), false)
  })

  it('有 sessionId ⇒ 已绑定', () => {
    assert.equal(isBoundSession('session-abc'), true)
  })

  it('全局桶 id 不是「绑定」—— 它是没有会话时的兜底', () => {
    assert.equal(isBoundSession(GLOBAL_BUCKET), false)
  })
})

describe('isGlobalRow', () => {
  it('turn = -1 ⇒ 全局行', () => {
    assert.equal(isGlobalRow(globalRow('td-bus.threat', 'threat')), true)
  })

  it('turn >= 0 ⇒ 会话自己的行', () => {
    assert.equal(isGlobalRow(sessionRow('intent.classify.end', 'intent')), false)
  })

  it('turn 缺失 ⇒ 保守当成会话自己的行（不误判成全局）', () => {
    assert.equal(isGlobalRow(row('llm.trace.index', 'route')), false)
  })
})

describe('isUnboundPanel', () => {
  it('宿主没给会话 ⇒ 未绑定', () => {
    assert.equal(isUnboundPanel(undefined, [], 0), true)
    assert.equal(isUnboundPanel('', [], 0), true)
    assert.equal(isUnboundPanel(GLOBAL_BUCKET, [], 0), true)
  })

  it('空白草稿会话（零轮次 + 只有全局行）⇒ 未绑定 —— 实机复现的那个形态', () => {
    // 桌面版开机就建草稿会话：sessionId 真实且非空，但它自己一条行都没有，
    // 宿主把全局桶合并进来 ⇒ 旧壳会把全局汇总说成「本轮」。
    const rows = [globalRow('td-bus.threat', 'threat'), globalRow('llm.trace.index', 'route')]
    assert.equal(isUnboundPanel('draft-session', rows, 0), true)
  })

  it('会话跑过一轮 ⇒ 已绑定（哪怕此刻一条自己的行都还没落）', () => {
    assert.equal(isUnboundPanel('session-abc', [], 1), false)
  })

  it('会话已经有自己的行 ⇒ 已绑定', () => {
    const rows = [globalRow('td-bus.threat', 'threat'), sessionRow('intent.classify.end', 'intent')]
    assert.equal(isUnboundPanel('session-abc', rows, 0), false)
  })

  it('只有全局行但轮次 > 0 ⇒ 已绑定', () => {
    assert.equal(isUnboundPanel('session-abc', [globalRow('td-bus.threat', 'threat')], 1), false)
  })
})

describe('globalSignalGroups', () => {
  it('按面板分组，保持首次出现顺序', () => {
    const groups = globalSignalGroups([
      row('td-bus.threat', 'threat', { to: 'HIGH' }),
      row('intent.classify.end', 'intent', { category: 'LOCAL' }),
      row('input.rate-limit', 'threat', { count: 3 }),
      row('llm.trace.index', 'route', { provider: 'local-llm' }),
    ])
    assert.deepEqual(groups.map((g) => g.panel), ['threat', 'intent', 'route'])
    assert.equal(groups[0]?.rows.length, 2)
    assert.equal(groups[1]?.rows.length, 1)
    assert.equal(groups[2]?.rows.length, 1)
  })

  it('空输入 ⇒ 空分组', () => {
    assert.deepEqual(globalSignalGroups([]), [])
  })
})

describe('UnboundView', () => {
  it('明说「尚未绑定会话」', () => {
    const html = renderToStaticMarkup(UnboundView({ rows: [] }))
    assert.ok(html.includes('尚未绑定会话'), html)
  })

  it('不出现任何「本轮」字样 —— 没有会话就没有「这一轮」', () => {
    const html = renderToStaticMarkup(UnboundView({
      rows: [
        row('intent.classify.end', 'intent', { category: 'LOCAL' }),
        row('llm.trace.index', 'route', { provider: 'local-llm', model: 'MiniMax-M3.1-Flash' }),
      ],
    }))
    assert.ok(!html.includes('本轮'), `未绑定视图里出现了「本轮」：${html}`)
    assert.ok(!html.includes('轮次'), `未绑定视图里出现了「轮次」：${html}`)
    assert.ok(!html.includes('LLM 调用'), `未绑定视图里出现了「LLM 调用」：${html}`)
  })

  it('全局信号照常列出（一条不藏），归在「全局信号」标题下', () => {
    const html = renderToStaticMarkup(UnboundView({
      rows: [
        row('td-bus.threat', 'threat', { to: 'HIGH', reason: 'rate' }),
        row('llm.trace.index', 'route', { provider: 'qwen-token-plan-cn', model: 'deepseek-v4.1-flash' }),
      ],
    }))
    assert.ok(html.includes('threat'), '威胁信号行应当列出')
    assert.ok(html.includes('qwen-token-plan-cn'), '全局 LLM 调用行应当列出')
    assert.ok(html.includes('全局信号'), '全局信号分组标题应当出现')
  })

  it('一行全局信号都没有时，明说「暂无全局信号」', () => {
    const html = renderToStaticMarkup(UnboundView({ rows: [] }))
    assert.ok(html.includes('暂无全局信号'), html)
  })

  it('edge 服务不可达时仍然提示（可达性是与会话无关的事实）', () => {
    const html = renderToStaticMarkup(UnboundView({ rows: [], failing: true }))
    assert.ok(html.includes('edge 服务不可达'), html)
  })
})

describe('EdgeView 的接线（这才是真契约）', () => {
  it('没有 sessionId ⇒ 走未绑定分支：一个「本轮」都不许有', () => {
    const html = renderToStaticMarkup(h(EdgeView, {}))
    assert.ok(html.includes('尚未绑定会话'), html)
    assert.ok(!html.includes('本轮'), `未绑定视图里出现了「本轮」：${html}`)
    assert.ok(!html.includes('轮次'), `未绑定视图里出现了「轮次」：${html}`)
  })

  it('空白草稿会话（真实 sessionId + 零轮次 + 只有全局行）⇒ 走未绑定分支', () => {
    // §7.145 实机复现：桌面版 guide 页拿到的是真实草稿会话 id，光看 id 判不出来。
    seed('draft-session', [globalRow('td-bus.threat', 'threat', { to: 'HIGH' })], { turns: 0 })
    const html = renderToStaticMarkup(h(EdgeView, { sessionId: 'draft-session' }))
    assert.ok(html.includes('尚未绑定会话'), `草稿会话应当显示「尚未绑定会话」：${html}`)
    assert.ok(!html.includes('本轮'), `未绑定视图里出现了「本轮」：${html}`)
    assert.ok(!html.includes('轮次'), `未绑定视图里出现了「轮次」：${html}`)
    // 全局信号一条不藏（§7.129）：威胁行照样列出，只是标成全局信号。
    assert.ok(html.includes('全局信号'), `全局信号应当列出：${html}`)
  })

  it('会话跑过一轮 ⇒ 走正常分支：「本轮」语义照旧', () => {
    // 只有全局行 + 轮次 > 0：绑定证据是「跑过一轮」，不是「有会话的行」。
    seed('session-abc', [globalRow('td-bus.threat', 'threat', { to: 'HIGH' })], { turns: 1 })
    const html = renderToStaticMarkup(h(EdgeView, { sessionId: 'session-abc' }))
    assert.ok(!html.includes('尚未绑定会话'), `已绑定视图里不该出现「尚未绑定会话」：${html}`)
    assert.ok(html.includes('轮次'), html)
    assert.ok(html.includes('本轮'), html)
  })

  it('会话已经有自己的行（首轮竞态：行先于 turn/start 落库）⇒ 走正常分支', () => {
    seed('session-abc', [sessionRow('intent.classify.end', 'intent', { category: 'LOCAL' })], { turns: 0 })
    const html = renderToStaticMarkup(h(EdgeView, { sessionId: 'session-abc' }))
    assert.ok(!html.includes('尚未绑定会话'), `已绑定视图里不该出现「尚未绑定会话」：${html}`)
    assert.ok(html.includes('本轮'), html)
  })
})
