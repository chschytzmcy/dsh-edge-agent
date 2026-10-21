/**
 * §7.105 (2026-10-21) openai-sse 空 tool-call id 测试 —— 上游省略 id 时
 * 绝不能让空串逃逸出适配器。
 *
 * 事故回放：session-f1b44612（local-llm/qwen3.8-flash）的日志尾部，
 * `assistant/message` 的 tool-call 块 id 为 ""，`tool/call` 的 callId 也为 ""。
 * 宿主把空 id 原样写进 v4 会话日志，重新加载时校验器
 * `assertReleasedV4Relationships` 抛
 * `SessionFormatError: tool call id requires a nonempty string`——
 * 一个工具调用让**整个会话**的历史都加载不了（不只是最后一轮）。
 *
 * 根因在 openai-sse.ts 的 inbound 路径：`current.id` 初值为 ''，上游不带 id
 * 时它一直是 ''，`brandCallId('')` 又是恒等转换（无运行时校验），空串一路
 * 写进日志。outbound 路径的 `??` 同样放行空串（'' 非 nullish）。
 *
 * 断言：
 *   1. 上游省略 id / 发 id:"" → 块的 id 必须非空，且唯一
 *   2. 上游给了真 id → 原样保留
 *   3. id 在后续 delta 才到 → 真 id 覆盖合成 id
 *   4. 同一调用的所有 delta 与 block-end 必须用同一个 id
 *   5. outbound wire body 不得出现空 tool_call_id
 */

import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import {
  buildChatCompletionsBody,
  parseSseEvent,
  sseEventToChunk,
  terminalChunks,
  type ParsedEvent,
} from '../../src/dsh-adapter/openai-sse.ts'

/** 模拟适配器的流式循环：feed 每个 wire 事件 → 收集 chunk → 喂给宿主
 * BlockAssembler → 收尾 terminalChunks → 返回组装出的 content 块数组。 */
function assembleLikeAdapter(events: ParsedEvent[]): Array<Record<string, unknown>> {
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>()
  const assembler = new BlockAssembler()
  let sawText = false
  let sawToolCall = false
  let assembledText = ''

  for (const event of events) {
    const result = sseEventToChunk(event, toolCalls)
    if (result === null) continue
    if (result.chunk.type === 'text-delta') {
      sawText = true
      assembledText += (result.chunk as { text: string }).text
    } else if (result.chunk.type === 'tool-call-delta') {
      sawToolCall = true
    }
    assembler.push(result.chunk)
  }
  for (const chunk of terminalChunks(sawText, assembledText, toolCalls, 'tool-calls', sawToolCall)) {
    assembler.push(chunk)
  }
  return assembler.blocks() as unknown as Array<Record<string, unknown>>
}

/** 从 SSE 原始帧解析出事件序列（跳过 [DONE] 与无法解析的帧）。 */
function parseFrames(frames: string[]): ParsedEvent[] {
  const events: ParsedEvent[] = []
  for (const frame of frames) {
    const event = parseSseEvent(frame)
    if (event !== undefined) events.push(event)
  }
  return events
}

const OMIT_ID = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"pwsh","arguments":"{}"}}]}}]}'
const EMPTY_ID = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"","function":{"name":"pwsh","arguments":"{}"}}]}}]}'
const REAL_ID = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_real_123","function":{"name":"pwsh","arguments":"{}"}}]}}]}'

describe('openai-sse empty tool-call id (§7.105)', () => {
  it('upstream omits the id → the assembled block still has a nonempty id', () => {
    const blocks = assembleLikeAdapter(parseFrames([OMIT_ID]))
    const toolBlocks = blocks.filter((b) => b.type === 'tool-call')
    assert.equal(toolBlocks.length, 1)
    assert.equal(typeof toolBlocks[0].id, 'string')
    assert.notEqual(toolBlocks[0].id, '', '空 id 会让整份会话日志加载失败')
  })

  it('upstream sends id:"" → the assembled block still has a nonempty id', () => {
    const blocks = assembleLikeAdapter(parseFrames([EMPTY_ID]))
    const toolBlocks = blocks.filter((b) => b.type === 'tool-call')
    assert.equal(toolBlocks.length, 1)
    assert.notEqual(toolBlocks[0].id, '', '空串 id 必须被替换')
  })

  it('a real upstream id is preserved verbatim', () => {
    const blocks = assembleLikeAdapter(parseFrames([REAL_ID]))
    const toolBlocks = blocks.filter((b) => b.type === 'tool-call')
    assert.equal(String(toolBlocks[0].id), 'call_real_123')
  })

  it('an id arriving on a later delta wins over the synthesized one', () => {
    const events = parseFrames([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"pwsh","arguments":"{\\"a\\":"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_late_9","function":{"arguments":"1}"}}]}}]}',
    ])
    const blocks = assembleLikeAdapter(events)
    const toolBlocks = blocks.filter((b) => b.type === 'tool-call')
    assert.equal(String(toolBlocks[0].id), 'call_late_9')
  })

  it('every delta of one call and the block-end share the same id', () => {
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>()
    const events = parseFrames([
      OMIT_ID,
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"b\\":2}"}}]}}]}',
    ])
    const deltaIds: string[] = []
    for (const event of events) {
      const result = sseEventToChunk(event, toolCalls)
      if (result !== null && result.chunk.type === 'tool-call-delta') {
        deltaIds.push(String(result.chunk.id))
      }
    }
    const end = [...terminalChunks(false, '', toolCalls, 'tool-calls', true)]
      .find((c) => c.type === 'block-end' && (c as any).block?.type === 'tool-call') as
      | { block: { id: string } }
      | undefined
    assert.ok(end, '存在 tool-call block-end')
    assert.equal(new Set(deltaIds).size, 1, '同一次调用的所有 delta 必须共用一个 id')
    assert.equal(deltaIds[0], end.block.id, 'delta 与 block-end 的 id 必须一致')
    assert.notEqual(end.block.id, '')
  })

  it('parallel calls without ids get distinct ids (the validator forbids repeats)', () => {
    const events = parseFrames([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"a","arguments":"{}"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"name":"b","arguments":"{}"}}]}}]}',
    ])
    const blocks = assembleLikeAdapter(events)
    const ids = blocks.filter((b) => b.type === 'tool-call').map((b) => String(b.id))
    assert.equal(ids.length, 2)
    assert.equal(new Set(ids).size, 2, '合成的 id 必须互不相同')
  })

  it('the outbound wire body never carries an empty tool_call_id', () => {
    const body = buildChatCompletionsBody(
      {
        model: 'local-llm',
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'tool-call', id: '', name: 'pwsh', arguments: '{}' },
            ],
          } as any,
          {
            role: 'user',
            content: [
              { type: 'tool-result', toolCallId: '', content: 'ok' },
            ],
          } as any,
        ],
      } as any,
      'local-model',
      undefined,
    )
    const wire = body as { messages: Array<Record<string, any>> }
    for (const message of wire.messages) {
      for (const call of message.tool_calls ?? []) {
        assert.notEqual(call.id, '', '空 tool_call id 会被上游拒绝')
      }
      if (message.role === 'tool') {
        assert.notEqual(message.tool_call_id, '')
      }
    }
  })
})
