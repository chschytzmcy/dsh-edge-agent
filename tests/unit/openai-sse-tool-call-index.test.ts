/**
 * §7.58 (2026-09-16) openai-sse 索引对齐测试 —— 用宿主真实的 BlockAssembler
 * (@deepseek-ai/dsh-llm) 端到端组装，锁定 tool-call-delta 与 block-end 必须
 * 落在同一 index 空间（wire index + 1）。
 *
 * 事故回放：旧实现 delta 用 wire index（0 起）、block-end 用顺序号 1,2,3——
 * 纯 tool-call 轮次（无前置 text 占住 index 0）下，delta 累积出的 partial[0]
 * 和 block-end 的 partial[1] 各成一个块 → assistant 消息里同一次调用出现两遍
 * （同 id），回放被 DeepSeek 400 "Duplicate value for 'tool_call_id'"。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import {
  sseEventToChunk,
  terminalChunks,
  sseFinishReason,
  type ParsedEvent,
} from '../../src/dsh-adapter/openai-sse.ts'

/** 模拟 adapter 的流式循环：feed 每个 wire 事件 → 收集 chunk → 喂给宿主
 *  BlockAssembler → 收尾 terminalChunks → 返回组装出的 content 块数组。 */
function assembleLikeAdapter(events: ParsedEvent[]): Array<Record<string, unknown>> {
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>()
  const assembler = new BlockAssembler()
  let sawText = false
  let sawToolCall = false
  let assembledText = ''
  let finishKind: 'stop' | 'length' | 'tool-calls' | undefined

  for (const event of events) {
    const fr = sseFinishReason(event)
    if (fr !== undefined) {
      finishKind = fr
      continue
    }
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
  for (const chunk of terminalChunks(sawText, assembledText, toolCalls, finishKind, sawToolCall)) {
    assembler.push(chunk)
  }
  return assembler.blocks() as unknown as Array<Record<string, unknown>>
}

const CALL_ID = 'call_00_QeghpJyr4wEMTBhWdTvJ9275'
const ARGS_PARTS = ['{"command"', ': "etscli', ' auth list"}']

describe('openai-sse tool-call index alignment (BlockAssembler integration)', () => {
  it('text-less tool turn assembles exactly ONE block (duplicate regression)', () => {
    const events: ParsedEvent[] = [
      { kind: 'tool-call-delta', index: 0, id: CALL_ID, name: 'bash', argumentsDelta: '' },
      ...ARGS_PARTS.map((argumentsDelta) => ({ kind: 'tool-call-delta' as const, index: 0, argumentsDelta })),
      { kind: 'finish', finishReason: 'tool-calls' },
    ]
    const blocks = assembleLikeAdapter(events)
    assert.equal(blocks.length, 1, `期望 1 个块，实际 ${blocks.length}（修复前此处为 2：同 id 双块）`)
    const [block] = blocks
    assert.equal(block.type, 'tool-call')
    assert.equal(String(block.id), CALL_ID)
    assert.equal(block.name, 'bash')
    assert.equal(block.arguments, ARGS_PARTS.join(''))
  })

  it('text + single tool call → [text, tool] with one tool block', () => {
    const events: ParsedEvent[] = [
      { kind: 'text-delta', text: '我来查一下。' },
      { kind: 'tool-call-delta', index: 0, id: 'call_a', name: 'bash', argumentsDelta: '{"command":"ls"}' },
      { kind: 'finish', finishReason: 'tool-calls' },
    ]
    const blocks = assembleLikeAdapter(events)
    assert.equal(blocks.length, 2)
    assert.deepEqual(blocks.map((b) => b.type), ['text', 'tool-call'])
    assert.equal(String(blocks[1].id), 'call_a')
    assert.equal(blocks[0].text, '我来查一下。')
  })

  it('parallel calls (wire index 0,1) → 2 blocks, ids/order preserved, unique', () => {
    const events: ParsedEvent[] = [
      { kind: 'tool-call-delta', index: 0, id: 'call_0', name: 'read', argumentsDelta: '{"path":"a"}' },
      { kind: 'tool-call-delta', index: 1, id: 'call_1', name: 'read', argumentsDelta: '{"path":"b"}' },
      { kind: 'finish', finishReason: 'tool-calls' },
    ]
    const blocks = assembleLikeAdapter(events)
    assert.equal(blocks.length, 2)
    assert.deepEqual(blocks.map((b) => String(b.id)), ['call_0', 'call_1'])
    assert.equal(new Set(blocks.map((b) => String(b.id))).size, 2)
  })

  it('gapped wire indices (0,2) still land delta and block-end in the same slot', () => {
    const events: ParsedEvent[] = [
      { kind: 'tool-call-delta', index: 0, id: 'call_x', name: 'bash', argumentsDelta: '{}' },
      { kind: 'tool-call-delta', index: 2, id: 'call_y', name: 'bash', argumentsDelta: '{}' },
      { kind: 'finish', finishReason: 'tool-calls' },
    ]
    const blocks = assembleLikeAdapter(events)
    assert.equal(blocks.length, 2, '跳号 index 不得多开块（sequential 编号会错位）')
    assert.deepEqual(blocks.map((b) => String(b.id)), ['call_x', 'call_y'])
  })

  it('every tool-call delta chunk index equals its block-end index', () => {
    // 直接比对两阶段 yield 的 chunk.index —— 对齐关系的单元事实。
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>()
    const delta = sseEventToChunk(
      { kind: 'tool-call-delta', index: 1, id: 'call_z', name: 'bash', argumentsDelta: '{}' },
      toolCalls,
    )
    assert.ok(delta && delta.chunk.type === 'tool-call-delta')
    const ends = [...terminalChunks(false, '', toolCalls, 'tool-calls', true)]
    const end = ends.find((c) => c.type === 'block-end' && (c as any).block?.type === 'tool-call')
    assert.ok(end, '存在 tool-call block-end')
    assert.equal(delta.chunk.index, (end as { index: number }).index)
    assert.equal(delta.chunk.index, 2, 'wire index 1 → block index 2')
  })
})
