/**
 * §7.181 —— DELEGATE 池的出口行必须被「答案出口」认出来
 *
 * ## 现场（主人 14:2x 的面板截图）
 *
 * ```
 * 答案出口   路由未定
 * ```
 *
 * 明明作答了（审计链里 `llm.local.delegate.resolved` ×3 → `llm.local.delegate.end`
 * ×3 一条不缺），面板却写「路由未定」。
 *
 * ## 根因
 *
 * §7.171 之后桌面走的是 **DELEGATE 路径**：池 `local-llm` 不自己出网，而是把请求
 * 转给宿主当前模型（`qwen-token-plan-cn/deepseek-v4.1-flash`）。这条路径的审计
 * 行是 `llm.{local,cloud}.delegate.resolved` / `.delegate.end`，字段形状也与直连行
 * 不同：
 *
 * - 直连行：`provider` / `model` / `route` / `promptLen`（池自己的路由）
 * - 委托行：`from`（池）/ `toProvider` / `toModel`（真实落点）/ `messageCount`
 *
 * 面板的 `answerNode` 此前**只认直连行**（`llm.local.end` / `llm.cloud.end` /
 * `.start`）+ 宿主 `llm.host.route`（宿主只在路由**变化**时宣告，稳态会话没有）
 * + `summary.lastRoute`（只随 host.route 写）⇒ 三条路全空 ⇒「路由未定」。
 *
 * ## 口径（§7.130 保留）
 *
 * LOCAL / CLOUD 的判据是**哪个池**（category），不是出口端点落在哪台机。
 * DELEGATE 下池仍是 `local-llm` ⇒ 面板仍按 LOCAL 口径显示，但**额外补一行
 * 「真实落点」**，把实际转发到哪儿讲清楚 —— 不藏，也不篡改 §7.130 的结论。
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

/** DELEGATE 出口行：池 = local-llm，落点 = 宿主当前模型。 */
function delegateResolved(extra: Record<string, unknown> = {}): EdgeRow {
  return row('llm.local.delegate.resolved', {
    from: 'local-llm', toProvider: 'qwen-token-plan-cn', toModel: 'deepseek-v4.1-flash',
    source: 'selection', messageCount: 6, tools: 32, ...extra,
  })
}

function delegateEnd(extra: Record<string, unknown> = {}): EdgeRow {
  return row('llm.local.delegate.end', {
    from: 'local-llm', toProvider: 'qwen-token-plan-cn', toModel: 'deepseek-v4.1-flash',
    durationMs: 4200, resultLen: 512, tools: 32, ...extra,
  })
}

describe('§7.181 — DELEGATE 出口行必须被答案出口认出来', () => {
  it('只有委托出口行时：不得显示「路由未定」', () => {
    const out = render([delegateResolved(), delegateEnd()])
    assert.ok(!out.includes('路由未定'), `DELEGATE 下不得写路由未定: ${out}`)
  })

  it('路由行显示池 + 落点模型，并补一行「真实落点」', () => {
    const out = render([delegateResolved(), delegateEnd()])
    assert.ok(out.includes('路由 local-llm/deepseek-v4.1-flash'), `路由行应带池与模型: ${out}`)
    assert.ok(out.includes('真实落点 qwen-token-plan-cn/deepseek-v4.1-flash'), `应补真实落点行: ${out}`)
  })

  it('§7.130 口径保留：判据是**池**，DELEGATE 走本地池 ⇒ 仍按 LOCAL 显示', () => {
    const out = render([delegateResolved(), delegateEnd()])
    assert.ok(out.includes('问题、上下文、答案全部留在本机'), `池=local-llm ⇒ LOCAL 口径: ${out}`)
    assert.ok(!out.includes('出网文本已先行检查/脱敏'), `不得改判成 CLOUD: ${out}`)
  })

  it('云池委托 ⇒ 按 CLOUD 口径显示', () => {
    const out = render([
      row('llm.cloud.delegate.resolved', {
        from: 'cloud-llm', toProvider: 'deepseek-official', toModel: 'deepseek-chat',
        source: 'selection', messageCount: 6, tools: 32,
      }),
      row('llm.cloud.delegate.end', {
        from: 'cloud-llm', toProvider: 'deepseek-official', toModel: 'deepseek-chat',
        durationMs: 4200, resultLen: 512, tools: 32,
      }),
    ])
    assert.ok(out.includes('出网文本已先行检查/脱敏'), `池=cloud-llm ⇒ CLOUD 口径: ${out}`)
    assert.ok(out.includes('真实落点 deepseek-official/deepseek-chat'), `应补真实落点行: ${out}`)
  })

  it('委托行在飞（只有 resolved）：显示作答中，而不是路由未定', () => {
    const out = render([delegateResolved()])
    assert.ok(out.includes('作答中'), `在飞应显示作答中: ${out}`)
    assert.ok(!out.includes('路由未定'), `在飞不得写路由未定: ${out}`)
    assert.ok(out.includes('路由 qwen-token-plan-cn/deepseek-v4.1-flash'), `在飞也应报出落点: ${out}`)
  })

  it('内部调用（tools=0）的委托行不得冒充本对话的出网', () => {
    // 安检 / 分类器同样走委托路径，靠 adapter 侧补的 tools=0 判别字段排除。
    const out = render([
      delegateResolved({ tools: 0, internal: 'prompt-guard' }),
      delegateEnd({ tools: 0, internal: 'prompt-guard' }),
    ])
    assert.ok(out.includes('路由未定'), `只有内部调用时应当仍是路由未定: ${out}`)
    assert.ok(!out.includes('作答中'), `内部调用不得显示作答中: ${out}`)
  })

  it('内部调用 + 主对话并存时：答案出口显示的是主对话那条', () => {
    const out = render([
      delegateResolved({ tools: 0, internal: 'intent-classifier' }),
      delegateEnd({ tools: 0, internal: 'intent-classifier' }),
      delegateResolved(),
      delegateEnd(),
    ])
    assert.ok(!out.includes('路由未定'), `主对话存在不得写路由未定: ${out}`)
    assert.ok(out.includes('真实落点 qwen-token-plan-cn/deepseek-v4.1-flash'), `应显示主对话落点: ${out}`)
  })

  it('出口步数统计委托行；上下文规模用「条消息」而不是「字」', () => {
    const out = render([delegateResolved(), delegateEnd(), delegateEnd({ durationMs: 800 })])
    assert.ok(out.includes('步数 ×2'), `应统计两条委托出口: ${out}`)
    assert.ok(out.includes('末轮上下文 6 条消息'), `委托行用 messageCount + 条消息: ${out}`)
    assert.ok(!out.includes('字'), `委托行不该出现「字」单位: ${out}`)
  })

  it('直连行仍然照旧工作（不因委托行支持而退化）', () => {
    const out = render([
      row('llm.local.start', {
        provider: 'local-llm', model: 'qwen3.8:27b', route: 'qwen3.8:27b',
        messageCount: 5, promptLen: 10171, tools: 32,
      }),
      row('llm.local.end', {
        provider: 'local-llm', model: 'qwen3.8:27b', route: 'qwen3.8:27b',
        durationMs: 2063, promptLen: 101298, resultLen: 412, tools: 32,
      }),
    ])
    assert.ok(!out.includes('路由未定'), `直连行不得退化: ${out}`)
    assert.ok(out.includes('路由 local-llm/qwen3.8:27b'), `直连路由行应照旧: ${out}`)
    assert.ok(out.includes('末轮上下文 101298 字'), `直连行用 promptLen + 字: ${out}`)
    assert.ok(!out.includes('真实落点'), `直连池落点=池，不必补真实落点: ${out}`)
  })
})
