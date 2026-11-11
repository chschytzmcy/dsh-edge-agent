/**
 * §7.184 (2026-11-11) —— 面板必须写明「你选的是 A、实际跑的是 B」。
 *
 * 主人裁决：「选择器完全不动，实际请求改道到本地池」。
 *
 * ⇒ 宿主模型选择器里仍然显示主人选的那个（比如云端模型），但这一轮真正跑的
 *   是本地池。面板是本项目对「实际发生了什么」的唯一权威展示口 ⇒ 它必须把
 *   两边都写出来，否则界面上写的名字跟实际跑的不是一回事（§7.176 的纪律）。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { FlowPanel } from '../../src/client/flowPanel'
import type { EdgeRow, EdgeSummary } from '../../src/client/types'

let seq = 0
let ts = 1_700_000_000_000

function row(kind: string, payload: Record<string, unknown>, panel: EdgeRow['panel'] = 'route'): EdgeRow {
  seq += 1
  ts += 1000
  return { ts, kind, panel, level: 'info', seq, payload }
}

const SUMMARY: EdgeSummary = { sessionId: 's1', turns: 1 }

function render(rows: EdgeRow[]): string {
  return renderToStaticMarkup(FlowPanel({ rows, summary: SUMMARY })) as unknown as string
}

/** §7.184: 改道审计行（input-guard.reroute.local）。 */
function rerouteRow(): EdgeRow {
  return row('input-guard.reroute.local', {
    sessionId: 's1',
    from: { provider: 'qwen-token-plan-cn', model: 'deepseek-v4.1-flash' },
    to: { provider: 'local-llm', model: 'qwen3.8-max' },
    source: 'local-pool',
    mode: 'direct',
  })
}

/** 本地池的出口行（直连）。 */
function localEnd(): EdgeRow {
  return row('llm.local.end', {
    provider: 'local-llm', model: 'qwen3.8-max', route: 'local-llm',
    durationMs: 1200, resultLen: 88, tools: 30,
  })
}

describe('§7.184 — 答案出口必须写明「会话选型 → 实际落点」', () => {
  it('有改道行时：面板同时写出会话选型与实际落点', () => {
    const out = render([rerouteRow(), localEnd()])
    assert.ok(
      out.includes('会话选型 → 实际落点 qwen-token-plan-cn/deepseek-v4.1-flash → local-llm/qwen3.8-max'),
      `面板必须写明「你选的是 A、实际跑的是 B」: ${out}`,
    )
    assert.ok(out.includes('路由 local-llm/qwen3.8-max'), `路由行应显示真实落点: ${out}`)
  })

  it('没有改道行时：不多写那一行（不能显示一件没发生过的事）', () => {
    const out = render([localEnd()])
    assert.ok(
      !out.includes('会话选型 → 实际落点'),
      `没有改道就不该写改道行: ${out}`,
    )
  })

  it('改道行单独出现（出口行还没到）也不报错', () => {
    const out = render([rerouteRow()])
    assert.ok(out.includes('会话选型 → 实际落点'), `改道行必须可见: ${out}`)
  })
})
