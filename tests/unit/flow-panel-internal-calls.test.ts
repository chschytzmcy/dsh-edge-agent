/**
 * §7.132 —— 「答案出口」不得把插件的内部 LLM 调用当成本对话的出网
 *
 * ## 现场（主人 18:2x 的面板截图）
 *
 * ```
 * 意图判定   等待
 * 路由决策   等待
 * 答案出口   作答中…  路由 local-llm/qwen3.8:27b  原始 messageCount=1 · promptLen=125
 * ```
 *
 * 「意图判定 / 路由决策」都还没结束，下面却有「答案出口」在跑 —— 看着像自相
 * 矛盾。查审计才发现：那�� `llm.local.start`（messageCount=1 · promptLen=125）
 * 是 **prompt-guard 的安检调用**，不是主对话的出网。同一时刻还有一条
 * `messageCount=5 · promptLen=10171` 才是主对话 —— 面板取「最后一条
 * `llm.local.start`」，把主对话的真实状态盖掉了。
 *
 * 更严重的一面（同一 bug 的另一副面孔）：主人下一轮看到的是
 *
 * ```
 * 答案出口   作答失败  路由 local-llm/qwen3.8:27b
 *           原因 SESSION_TITLE_TIMEOUT after 60000ms · 用时 60.0s
 * ```
 *
 * `SESSION_TITLE_TIMEOUT` 是**宿主的会话标题生成插件**超时 —— 主对话根本没
 * 失败。面板在陈述一件没发生过的事（§7.129 原则的直接违反）。
 *
 * ## 判据
 *
 * 实测（ops log，18:24-18:25 那轮）：
 *
 * ```
 * mc=5  sessionId=session-cbd136f1  tools=32  kinds=system-prompt,user,...   ← 主对话
 * mc=1  sessionId=session-cbd136f1  tools=无   kinds=dsh-session-title-llm     ← 宿主标题插件
 * mc=1  sessionId=session-cbd136f1  tools=无   kinds=user                     ← 安检 / 分类器
 * ```
 *
 * **sessionId 全都相同**（同一个 session）→ 靠 sessionId 分不开。
 * **tools 数量能分**：主对话恒带 30+ 件工具，一切内部调用一件都不带。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { FlowPanel } from '../../src/client/flowPanel'
import type { EdgeRow, EdgeSummary } from '../../src/client/types'

let seq = 0
let ts = 1_700_000_000_000

function row(kind: string, payload: Record<string, unknown>, panel: EdgeRow['panel'] = 'intent'): EdgeRow {
  seq += 1
  ts += 1000
  return { ts, kind, panel, level: 'info', seq, payload }
}

const SUMMARY: EdgeSummary = { sessionId: 's1', turns: 1 }

function render(rows: EdgeRow[]): string {
  return renderToStaticMarkup(FlowPanel({ rows, summary: SUMMARY })) as unknown as string
}

/** 主对话的出网行：带 32 件工具。 */
function conversationStart(extra: Record<string, unknown> = {}): EdgeRow {
  return row('llm.local.start', {
    provider: 'local-llm', model: 'qwen3.8:27b', route: 'qwen3.8:27b',
    messageCount: 5, promptLen: 10171, baseUrl: 'http://67.0.***.***:11434/v1',
    tools: 32, ...extra,
  }, 'route')
}

/** 内部调用（安检 / 分类器）：我们打的标记 + 没有工具。 */
function internalStart(caller: string, extra: Record<string, unknown> = {}): EdgeRow {
  return row('llm.local.start', {
    provider: 'local-llm', model: 'qwen3.8:27b', route: 'qwen3.8:27b',
    messageCount: 1, promptLen: 125, baseUrl: 'http://67.0.***.***:11434/v1',
    tools: 0, internal: caller, ...extra,
  }, 'route')
}

describe('§7.132 — 答案出口不得把内部调用当成本对话的出网', () => {
  it('只有内部调用时：答案出口应当「等待」，而不是显示在作答', () => {
    const out = render([internalStart('prompt-guard')])
    assert.ok(!out.includes('作答中'), `内部调用不得显示作答中: ${out}`)
    assert.ok(!out.includes('作答失败'), `内部调用不得显示作答失败: ${out}`)
  })

  it('宿主的标题生成插件（无 tools、无 internal 标记）也不得冒充出网', () => {
    // session-title-llm 是**宿主**的插件 —— 我们控制不了它打标记，只能靠
    // 「不带工具」这个判别式（实测 tools=<none>）。
    const out = render([row('llm.local.start', {
      provider: 'local-llm', model: 'qwen3.8:27b', route: 'qwen3.8:27b',
      messageCount: 1, promptLen: 96, tools: 0,
    }, 'route')])
    assert.ok(!out.includes('作答中'), `标题插件不得显示作答中: ${out}`)
  })

  it('内部调用 + 主对话并存时：答案出口显示的是主对话那条', () => {
    const out = render([conversationStart(), internalStart('prompt-guard')])
    assert.ok(out.includes('作答中'), `主对话在飞应当显示作答中: ${out}`)
    assert.ok(out.includes('messageCount=5'), `必须是主对话的 messageCount: ${out}`)
    assert.ok(!out.includes('messageCount=1'), `内部调用的 messageCount 不得出现: ${out}`)
  })

  it('内部调用的失败不得冒充本对话的失败', () => {
    // 现场：面板显示「作答失败 · SESSION_TITLE_TIMEOUT」—— 那是标题插件超时，
    // 主对话压根没失败。
    const out = render([
      conversationStart(),
      row('llm.local.network_error', {
        provider: 'local-llm', model: 'qwen3.8:27b', route: 'qwen3.8:27b',
        durationMs: 59993, error: 'SESSION_TITLE_TIMEOUT after 60000ms', tools: 0,
      }, 'route'),
    ])
    assert.ok(!out.includes('作答失败'), `内部调用的失败不得冒充本对话: ${out}`)
    assert.ok(!out.includes('SESSION_TITLE_TIMEOUT'), `内部调用的错误不得出现: ${out}`)
    assert.ok(out.includes('作答中'), `主对话仍应在飞: ${out}`)
  })

  it('带 internal 标记的失败行同样被排除', () => {
    const out = render([
      conversationStart(),
      row('llm.local.network_error', {
        provider: 'local-llm', model: 'qwen3.8:27b', route: 'qwen3.8:27b',
        durationMs: 60014, error: 'This operation was aborted',
        tools: 0, internal: 'prompt-guard',
      }, 'route'),
    ])
    assert.ok(!out.includes('作答失败'), `internal 标记的失败不得冒充: ${out}`)
  })

  it('主对话自己的失败仍然照实显示', () => {
    const out = render([
      conversationStart(),
      row('llm.local.network_error', {
        provider: 'local-llm', model: 'qwen3.8:27b', route: 'qwen3.8:27b',
        durationMs: 96000, error: 'fetch failed', tools: 32,
      }, 'route'),
    ])
    assert.ok(out.includes('作答失败'), `主对话失败必须显示: ${out}`)
    assert.ok(out.includes('fetch failed'), `主对话失败原因必须显示: ${out}`)
  })

  it('旧数据（没有 tools 字段）不退化：仍然认作主对话出网', () => {
    // 老审计行没有 tools 字段 —— 保留它们，避免把旧的主对话出网误判成
    // 内部调用而让答案出口永远「等待」。
    const out = render([row('llm.local.start', {
      provider: 'local-llm', model: 'qwen3.8:27b', route: 'qwen3.8:27b',
      messageCount: 5, promptLen: 10171,
    }, 'route')])
    assert.ok(out.includes('作答中'), `旧数据应当仍然显示作答中: ${out}`)
  })

  it('主对话完成（llm.local.end）后显示正常出口，且不因内部调用而错位', () => {
    const out = render([
      row('llm.local.start', {
        provider: 'local-llm', model: 'qwen3.8:27b', route: 'qwen3.8:27b',
        messageCount: 5, promptLen: 10171, tools: 32,
      }, 'route'),
      row('llm.local.end', {
        provider: 'local-llm', model: 'qwen3.8:27b', route: 'qwen3.8:27b',
        durationMs: 2063, promptLen: 101298, resultLen: 412, tools: 32,
      }, 'route'),
      internalStart('intent-classifier'),
    ])
    assert.ok(!out.includes('作答中'), `已完成就不该还在作答中: ${out}`)
    assert.ok(out.includes('问题、上下文、答案全部留在本机'), `应显示本地出口文案: ${out}`)
  })
})
