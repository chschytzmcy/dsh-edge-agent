/**
 * §7.119 回归测试 —— DSH 规范 tool-result 形状（「消息级」）的识别。
 *
 * ## 背景
 *
 * DSH 上游 `createToolResultMessage()` 造出的工具结果消息是**消息级**的：
 *
 * ```json
 * { "role": "tool",
 *   "toolCallId": "call_x",
 *   "source": { "kind": "tool", "callId": "call_x" },
 *   "content": [ { "type": "text", "text": "…" } ] }
 * ```
 *
 * call id 在**消息顶层**，content 里是结果文本块、**没有** `tool-result` 块。
 *
 * 旧实现只认 content 块，两处都栽了：
 *
 * 1. `openai-sse.ts` 的 `buildChatCompletionsBody` → tool_call_id 丢失 →
 *    §7.106 的配对守卫把它降级成
 *    `"[tool-result (unreferenced) lost its matching call; output:]"` 的
 *    user 消息。**模型的每一个工具结果都是这样进去的**（实测真实会话
 *    77/77 全是这个形状）。
 * 2. `input-guard.ts` 的 `collectResultIds` → 每个 tool_call 都被误判成
 *    orphan → 每轮注入合成的 "aborted" tool-result → 会话历史无限增长
 *    （实测 24 轮后 42 个假 orphan、111 条消息）。
 *
 * 本文件钉住修复后的行为。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { buildChatCompletionsBody } from '../../src/dsh-adapter/openai-sse.js'
import { InputGuardServiceImpl } from '../../src/dsh-adapter/input-guard.js'
import type { Config } from '../../src/dsh-adapter/input-guard.js'

/** DSH 规范的 tool-result 消息（消息级 call id + 文本 content）。 */
function toolResultMessage(callId: string, text: string): Record<string, unknown> {
  return {
    role: 'tool',
    toolCallId: callId,
    source: { kind: 'tool', callId },
    content: [{ type: 'text', text }],
  }
}

/** 旧式的块级 tool-result（content 里带 tool-result 块）。 */
function blockToolResultMessage(callId: string, text: string): Record<string, unknown> {
  return {
    role: 'user',
    content: [{ type: 'tool-result', toolCallId: callId, content: text }],
  }
}

function assistantToolCallMessage(callId: string): Record<string, unknown> {
  return {
    role: 'assistant',
    content: [{ type: 'tool-call', id: callId, name: 'web_search', arguments: '{"q":"x"}' }],
  }
}

describe('§7.119 DSH 规范 tool-result 形状（消息级 call id）', () => {
  describe('buildChatCompletionsBody', () => {
    it('emits a real role:tool message with tool_call_id (message-level id)', () => {
      const body = buildChatCompletionsBody({
        messages: [
          assistantToolCallMessage('call_a'),
          toolResultMessage('call_a', 'search output'),
        ] as never,
        system: 'sys',
      }, 'model')

      const toolMsg = body.messages.find((m) => m.role === 'tool') as Record<string, unknown> | undefined
      assert.ok(toolMsg, '应产生一条 role:tool 消息')
      assert.equal(toolMsg!.tool_call_id, 'call_a')
      assert.equal(toolMsg!.content, 'search output')
    })

    it('does NOT demote the result to "lost its matching call" user text', () => {
      const body = buildChatCompletionsBody({
        messages: [
          assistantToolCallMessage('call_a'),
          toolResultMessage('call_a', 'search output'),
        ] as never,
        system: 'sys',
      }, 'model')

      const demoted = body.messages.filter(
        (m) => typeof m.content === 'string' && m.content.includes('lost its matching call'),
      )
      assert.equal(demoted.length, 0, '工具结果不得被降级成 user 文本')
    })

    it('every role:tool message carries a non-empty tool_call_id', () => {
      const body = buildChatCompletionsBody({
        messages: [
          assistantToolCallMessage('call_a'),
          toolResultMessage('call_a', 'out-a'),
          assistantToolCallMessage('call_b'),
          toolResultMessage('call_b', 'out-b'),
        ] as never,
        system: 'sys',
      }, 'model')

      const toolMsgs = body.messages.filter((m) => m.role === 'tool')
      assert.equal(toolMsgs.length, 2)
      for (const m of toolMsgs) {
        assert.equal(typeof m.tool_call_id, 'string')
        assert.ok((m.tool_call_id as string).length > 0)
      }
    })

    it('still handles the legacy block-level tool-result shape', () => {
      const body = buildChatCompletionsBody({
        messages: [
          assistantToolCallMessage('call_a'),
          blockToolResultMessage('call_a', 'legacy output'),
        ] as never,
        system: 'sys',
      }, 'model')

      const toolMsg = body.messages.find((m) => m.role === 'tool') as Record<string, unknown> | undefined
      assert.ok(toolMsg)
      assert.equal(toolMsg!.tool_call_id, 'call_a')
    })

    it('falls back to the block path when a role:tool message has no id at all', () => {
      const body = buildChatCompletionsBody({
        messages: [
          assistantToolCallMessage('call_a'),
          { role: 'tool', content: [{ type: 'text', text: 'id-less output' }] },
        ] as never,
        system: 'sys',
      }, 'model')

      // 取不到 id → 不走消息级分支 → 该消息按普通消息处理（content 变文本）
      const toolMsg = body.messages.find((m) => m.role === 'tool') as Record<string, unknown> | undefined
      assert.equal(toolMsg, undefined, '无 id 的 role:tool 不得伪造 tool_call_id')
    })
  })

  describe('input-guard sanitizeOrphanToolCalls', () => {
    function makeGuard() {
      return new InputGuardServiceImpl(
        { reflect: { provide(_n: string, _v: unknown) { return () => {} } }, provide(_n: string, _v: unknown) { return () => {} } } as never,
        {
          enableInputGuard: true,
          sanitizeLocalTraffic: false,
          rejectOnPolicyViolation: true,
          downgradeOnSanitizeFailure: true,
          localProvider: 'local-llm',
          localModel: 'qwen3-4b-instruct-2507',
          cloudApiKeyEnv: 'DEEPSEEK_API_KEY',
          defaultCloudProvider: 'cloud-llm',
          defaultCloudModel: 'deepseek-chat',
        } as Config,
        undefined, undefined, undefined, undefined, undefined,
      )
    }

    it('does NOT report the message-level tool-result as an orphan', () => {
      const svc = makeGuard()
      const result = svc.sanitizeOrphanToolCalls([
        assistantToolCallMessage('call_a'),
        toolResultMessage('call_a', 'search output'),
      ] as never, 'sess-shape')

      assert.equal(result.orphanCount, 0, '消息级 tool-result 不该被误判成 orphan')
      assert.equal(result.syntheticInjected, 0)
      assert.equal(result.messages.length, 2, '不该注入任何合成消息')
    })

    it('does not grow the history across repeated turns (the accumulation bug)', () => {
      const svc = makeGuard()
      // 模拟 10 轮：每轮 assistant(tool-call) + tool-result
      let messages: Array<Record<string, unknown>> = []
      for (let turn = 0; turn < 10; turn++) {
        const callId = `call_${turn}`
        messages = [...messages, assistantToolCallMessage(callId), toolResultMessage(callId, `out-${turn}`)]
        const result = svc.sanitizeOrphanToolCalls(messages as never, 'sess-accum')
        assert.equal(result.orphanCount, 0, `第 ${turn + 1} 轮出现假 orphan`)
        assert.equal(result.messages.length, messages.length, `第 ${turn + 1} 轮历史被撑大了`)
      }
    })

    it('still detects a genuinely orphaned tool-call', () => {
      const svc = makeGuard()
      const result = svc.sanitizeOrphanToolCalls([
        assistantToolCallMessage('call_orphan'),
        { role: 'user', content: 'next question' },
      ] as never, 'sess-real-orphan')

      assert.equal(result.orphanCount, 1, '真 orphan 仍要被抓到')
      assert.equal(result.syntheticInjected, 1)
    })

    it('still handles the legacy block-level shape without false positives', () => {
      const svc = makeGuard()
      const result = svc.sanitizeOrphanToolCalls([
        assistantToolCallMessage('call_a'),
        blockToolResultMessage('call_a', 'legacy output'),
      ] as never, 'sess-legacy')

      assert.equal(result.orphanCount, 0)
    })
  })
})
