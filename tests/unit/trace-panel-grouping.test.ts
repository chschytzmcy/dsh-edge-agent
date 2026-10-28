/**
 * §7.134 —— LLM 调用面板：按类别分组 + 请求/响应成对
 *
 * 主人的原话：「edge tab 的 LLM 调用里没有按 攻击检测，意图判定，路由决策
 * 等类别来列出来，需要有请求和响应成对显示，上面是请求下面是响应」。
 *
 * ## 为什么要有 callId
 *
 * §7.133 的索引行里 REQ 与 RESP 各自有独立的 `traceId`（正文存储的键），
 * 于是面板上一次调用显示成两行不相干的条目 —— 主人在 §7.134 里要求成对。
 * 配对需要一个跨 REQ/RESP 的共同键 = **一次 LLM 往返**。
 *
 * ## 判据不另造一套
 *
 * 类别复用 §7.132 的 `caller` 标记，标题文案复用 Flow 面板的
 * `flow.guard` / `flow.intent` / `flow.route` —— 同一个概念两处文案
 * 必然漂移，所以只留一处。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  TracePanel,
  pairTraces,
  readTraceIndex,
  traceGroup,
  traceGroupLabel,
  callerLabel,
  type TraceIndex,
} from '../../src/client/tracePanel'
import type { EdgeRow } from '../../src/client/types'

let seq = 0
let ts = 1_700_000_000_000

function row(payload: Record<string, unknown>): EdgeRow {
  seq += 1
  ts += 1000
  return { ts, kind: 'llm.trace.index', panel: 'route', level: 'info', seq, payload }
}

/** 一条索引行（字段名与宿主 buildTraceIndex 一致）。 */
function idx(over: Partial<TraceIndex> & { traceId: string }): TraceIndex {
  return {
    kind: 'REQ',
    provider: 'local-llm',
    model: 'qwen3.8:27b',
    ...over,
  }
}

function render(rows: EdgeRow[]): string {
  // 必须走 createElement —— TracePanel 用了 useState，直接调用函数没有
  // React dispatcher（hooks 会炸）。server 渲染不执行 useEffect，正文不拉。
  return renderToStaticMarkup(createElement(TracePanel, { rows })) as unknown as string
}

/** 在渲染结果里找某个标签的位置（-1 = 没出现）。 */
function at(out: string, needle: string): number {
  return out.indexOf(needle)
}

describe('§7.134 — 类别归组', () => {
  it('prompt-guard → 攻击检测', () => {
    assert.equal(traceGroup(idx({ traceId: 't1', caller: 'prompt-guard' })), 'guard')
  })

  it('intent-classifier → 意图判定', () => {
    assert.equal(traceGroup(idx({ traceId: 't2', caller: 'intent-classifier' })), 'intent')
  })

  it('无 caller + 带工具 → 路由决策（主对话出网）', () => {
    assert.equal(traceGroup(idx({ traceId: 't3', toolCount: 32 })), 'route')
  })

  it('无 caller + 零工具 → 宿主内部调用', () => {
    assert.equal(traceGroup(idx({ traceId: 't4', toolCount: 0 })), 'host')
  })

  it('未知的 caller → 其他调用（不猜）', () => {
    // 一个我们认不出的调用方不该被塞进「攻击检测」或「路由决策」。
    assert.equal(traceGroup(idx({ traceId: 't5', caller: 'some-future-plugin', toolCount: 3 })), 'other')
  })

  it('类别标题复用 Flow 面板的同一批文案键', () => {
    assert.equal(traceGroupLabel('guard'), '攻击检测')
    assert.equal(traceGroupLabel('intent'), '意图判定')
    assert.equal(traceGroupLabel('route'), '路由决策')
  })

  it('归属标签仍按 §7.132 的判据', () => {
    assert.equal(callerLabel(idx({ traceId: 't6', caller: 'prompt-guard' })), '安检')
    assert.equal(callerLabel(idx({ traceId: 't7', toolCount: 0 })), '宿主内部调用')
    assert.equal(callerLabel(idx({ traceId: 't8', toolCount: 32 })), '主对话')
  })
})

describe('§7.134 — 请求/响应配对', () => {
  it('同 callId 的 REQ/RESP 配成一对', () => {
    const pairs = pairTraces([
      idx({ traceId: 'a', kind: 'REQ', callId: 'c1' }),
      idx({ traceId: 'b', kind: 'RESP', callId: 'c1' }),
    ])
    assert.equal(pairs.length, 1)
    assert.equal(pairs[0]!.req?.traceId, 'a')
    assert.equal(pairs[0]!.resp?.traceId, 'b')
  })

  it('重试时的多个 RESP → 取最后一个（最终结果）', () => {
    const pairs = pairTraces([
      idx({ traceId: 'a', kind: 'REQ', callId: 'c1' }),
      idx({ traceId: 'b', kind: 'RESP', callId: 'c1', error: 'timeout' }),
      idx({ traceId: 'c', kind: 'RESP', callId: 'c1' }),
    ])
    assert.equal(pairs.length, 1)
    assert.equal(pairs[0]!.resp?.traceId, 'c', '最后一个 RESP 才是这次调用的最终结果')
  })

  it('无 callId 的旧数据各自成对（不硬配）', () => {
    // 把两条不相干的调用凑成一对是面板在说假话。
    const pairs = pairTraces([
      idx({ traceId: 'a', kind: 'REQ' }),
      idx({ traceId: 'b', kind: 'RESP' }),
    ])
    assert.equal(pairs.length, 2)
    assert.equal(pairs[0]!.resp, undefined)
    assert.equal(pairs[1]!.req, undefined)
  })

  it('只有 REQ（响应还没来）也成一组', () => {
    const pairs = pairTraces([idx({ traceId: 'a', kind: 'REQ', callId: 'c1' })])
    assert.equal(pairs.length, 1)
    assert.equal(pairs[0]!.req?.traceId, 'a')
    assert.equal(pairs[0]!.resp, undefined)
  })

  it('读索引行时带上 callId', () => {
    const r = readTraceIndex(row({ traceId: 'x1', kind: 'REQ', callId: 'c9', provider: 'p', model: 'm' }))
    assert.equal(r?.callId, 'c9')
  })
})

describe('§7.134 — 面板渲染', () => {
  it('按类别分组显示，标题顺序与 Flow 面板一致', () => {
    const out = render([
      row({ traceId: 'r1', kind: 'REQ', callId: 'c1', caller: 'prompt-guard', toolCount: 0 }),
      row({ traceId: 'r2', kind: 'REQ', callId: 'c2', caller: 'intent-classifier', toolCount: 0 }),
      row({ traceId: 'r3', kind: 'REQ', callId: 'c3', toolCount: 32 }),
    ])
    const guard = at(out, '攻击检测')
    const intent = at(out, '意图判定')
    const route = at(out, '路由决策')
    assert.ok(guard >= 0 && intent >= 0 && route >= 0, `三组都要出现: ${out}`)
    assert.ok(guard < intent && intent < route, `分组顺序必须是 攻击检测 → 意图判定 → 路由决策: ${out}`)
  })

  it('请求在上、响应在下', () => {
    const out = render([
      row({ traceId: 'r1', kind: 'REQ', callId: 'c1', toolCount: 32, messageCount: 5, promptLength: 10171 }),
      row({ traceId: 'r2', kind: 'RESP', callId: 'c1', toolCount: 32, contentLength: 412, durationMs: 2063 }),
    ])
    const req = at(out, '请求')
    const resp = at(out, '响应')
    assert.ok(req >= 0 && resp >= 0, `请求/响应都要出现: ${out}`)
    assert.ok(req < resp, `请求必须在响应之上: ${out}`)
  })

  it('一次往返只出现一个「请求」和一个「响应」', () => {
    const out = render([
      row({ traceId: 'r1', kind: 'REQ', callId: 'c1', toolCount: 32 }),
      row({ traceId: 'r2', kind: 'RESP', callId: 'c1', toolCount: 32 }),
    ])
    const reqCount = out.split('请求').length - 1
    const respCount = out.split('响应').length - 1
    assert.equal(reqCount, 1, `请求应只出现一次: ${out}`)
    assert.equal(respCount, 1, `响应应只出现一次: ${out}`)
  })

  it('宿主内部调用单独成组，不混进路由决策', () => {
    const out = render([
      row({ traceId: 'r1', kind: 'REQ', callId: 'c1', toolCount: 0 }),
      row({ traceId: 'r2', kind: 'REQ', callId: 'c2', toolCount: 32 }),
    ])
    assert.ok(out.includes('宿主内部调用'), `宿主内部调用要有自己的组: ${out}`)
    const host = at(out, '宿主内部调用')
    const route = at(out, '路由决策')
    assert.ok(host >= 0 && route >= 0)
    assert.ok(route < host, `路由决策在宿主内部调用之前（Flow 面板顺序）: ${out}`)
  })

  it('没有 LLM 调用时给出空态', () => {
    const out = render([])
    assert.ok(out.includes('本轮没有记录到 LLM 调用'), out)
  })
})
