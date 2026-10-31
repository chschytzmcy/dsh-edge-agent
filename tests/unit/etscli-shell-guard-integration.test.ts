/**
 * §7.120 —— **真运行时**验证：`tools/pre-execute` 的 deny 真的拦得住 bash
 *
 * ## 为什么要有这一组
 *
 * 单位测试用的是 fake ctx，只能证明「我们的判定函数对不对」。这一组用
 * **真 cordis Context + 真 ToolRuntime**（`@deepseek-ai/dsh-tools`）证明的是
 * 另外三件事：
 *
 * 1. **判定形状对**：`{kind:'deny', reason}` 这个返回形状，宿主真的认 ——
 *    `lib/index.js:3337-3353` 会把它物化成 `isError` 的最终结果，
 *    `error.message` 就是我们的拒绝理由；
 * 2. **工具确实没派发**：宿主在 deny 判定后直接返回，**不进入 execute** ——
 *    「拒绝了但命令还是跑了」是最坏的失败模式，必须钉死；
 * 3. **反向证伪**：不注册守卫时同一条命令**照常派发** —— 证明拦住它的确实是
 *    我们这道闸，而不是宿主自己拦的。
 *
 * ## 顺带钉住「放行时必须调用 next()」
 *
 * waterfall 里直接返回 `{kind:'allow'}` 会把宿主后面的链条（守卫、around
 * 派发）**整条截断** —— 那等于「一个只读子命令都不许跑」。所以放行路径必须
 * `return next()`。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'

import { registerEtscliShellGuard } from '../../src/dsh-adapter/etscli-shell-guard'

/**
 * 真 cordis + 真 ToolRuntime。
 *
 * `systemPrompt` 是 ToolRuntime 构造时就要用的服务（`lib/index.js:2802-2805`
 * 拿它挂工具 schema 与 section），这里给一个最小实现。
 */
function harness(): {
  ctx: Context
  tools: ToolRuntime
  dispatched: () => number
} {
  const ctx = new Context()
  ctx.provide('systemPrompt', {
    tools: () => {},
    section: () => {},
    getSectionOrder: () => 0,
  } as any)
  const tools = new ToolRuntime(ctx as any, 'tools')
  let dispatched = 0
  tools.register(defineTool({
    name: 'bash',
    description: 'Execute a bash command.',
    parameters: {
      command: { type: 'string', required: true, description: 'The bash command to execute.' },
    },
    output: {
      // 宿主的值 schema 编译器要求 `additionalProperties` **显式**写出
      // （`lib/index.js:552` 的 JsonSchemaError）。
      schema: { type: 'object', additionalProperties: true },
      render: () => [{ type: 'text', text: 'ran' }],
    },
    execute: async () => {
      dispatched += 1
      return { ran: true }
    },
  }))
  return { ctx, tools, dispatched: () => dispatched }
}

/** 跑一次 bash 工具调用。 */
async function runBash(tools: ToolRuntime, command: string): Promise<any> {
  return tools.execute({
    callId: `call-${command.length}`,
    name: 'bash',
    arguments: { command },
    signal: AbortSignal.timeout(5000),
  } as any)
}

describe('§7.120 — 真运行时：write 子命令被真 ToolRuntime 拦下', () => {
  it('写子命令 ⇒ isError + 拒绝理由进 error.message + 工具没派发', async () => {
    const { ctx, tools, dispatched } = harness()
    const denials: Array<{ tool: string; subcommand: string }> = []
    registerEtscliShellGuard(ctx as any, {
      onDeny: d => denials.push({ tool: d.tool, subcommand: d.subcommand }),
    })

    const result = await runBash(tools, 'etscli file upload /tmp/secret.txt')

    assert.equal(result.isError, true)
    assert.match(String(result.error?.message ?? ''), /etscli-shell-guard/)
    assert.match(String(result.error?.message ?? ''), /file upload/)
    assert.equal(dispatched(), 0, '命令绝不能真的跑起来')
    assert.equal(denials.length, 1)
    assert.equal(denials[0]!.tool, 'bash')
    assert.equal(denials[0]!.subcommand, 'file upload')
  })

  it('只读子命令 ⇒ 照常派发（不误伤）', async () => {
    const { ctx, tools, dispatched } = harness()
    registerEtscliShellGuard(ctx as any, {})

    const result = await runBash(tools, 'etscli fs ls --parent /tmp')

    assert.equal(result.isError, false)
    assert.equal(dispatched(), 1)
  })

  it('反向证伪：不注册守卫时写子命令**照常派发**（拦它的确实是我们这道闸）', async () => {
    const { tools, dispatched } = harness()

    const result = await runBash(tools, 'etscli file upload /tmp/secret.txt')

    assert.equal(result.isError, false)
    assert.equal(dispatched(), 1)
  })
})
