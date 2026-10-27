/**
 * §7.132 —— 内部调用标记与出网判别字段
 *
 * 见 `src/dsh-adapter/llm-internal-caller.ts` 的模块注释：插件自己也调 LLM
 * （prompt-guard 的安检、intent-router 的分类器、宿主的会话标题生成），
 * 它们与主对话走同一个 adapter，落同样的 `llm.local.start` 审计行 ——
 * 面板因此把内部调用当成了本对话的出网。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import {
  EDGE_INTERNAL_CALLER_FIELD,
  egressAuditFields,
  internalCallerOf,
  withInternalCaller,
} from '../../src/dsh-adapter/llm-internal-caller'

describe('§7.132 — 内部调用标记', () => {
  it('withInternalCaller 挂上标记，且不改动原对象', () => {
    const original = { provider: 'local-llm', model: 'm' }
    const tagged = withInternalCaller(original, 'prompt-guard')
    assert.equal(tagged[EDGE_INTERNAL_CALLER_FIELD], 'prompt-guard')
    assert.equal((original as Record<string, unknown>)[EDGE_INTERNAL_CALLER_FIELD], undefined)
  })

  it('internalCallerOf 读出标记', () => {
    assert.equal(internalCallerOf(withInternalCaller({}, 'intent-classifier')), 'intent-classifier')
  })

  it('没有标记 → undefined（主对话出网）', () => {
    assert.equal(internalCallerOf({ provider: 'local-llm' }), undefined)
    assert.equal(internalCallerOf(undefined), undefined)
    assert.equal(internalCallerOf(null), undefined)
  })
})

describe('§7.132 — 出网判别字段', () => {
  it('主对话：带 32 件工具、无 internal 标记', () => {
    const fields = egressAuditFields({ tools: Array.from({ length: 32 }, (_, i) => ({ name: `t${i}` })) })
    assert.equal(fields.tools, 32)
    assert.equal(fields.internal, undefined)
  })

  it('内部调用：tools 为 0 且带 internal 标记', () => {
    const fields = egressAuditFields(withInternalCaller({ tools: [] }, 'prompt-guard'))
    assert.equal(fields.tools, 0)
    assert.equal(fields.internal, 'prompt-guard')
  })

  it('宿主插件（无 tools 数组）→ 恒落 tools=0（这样它也能被排除）', () => {
    // §7.132 定稿：宿主没传 tools 时**恒落 0**，不是不落。
    // 「字段不存在」（§7.132 之前的旧数据）与「字段为 0」被区分开：
    // 旧行缺字段 → 面板保留（不退化）；新宿主的内部调用带 0 → 面板排除。
    const fields = egressAuditFields({ provider: 'local-llm' })
    assert.equal(fields.tools, 0)
    assert.equal(fields.internal, undefined)
  })

  it('tools 为空数组 → 落 0（确实是一次不带工具的调用）', () => {
    const fields = egressAuditFields({ tools: [] })
    assert.equal(fields.tools, 0)
  })

  it('宿主内部调用（无 tools、无 internal）→ 仍能被 tools=0 排除', () => {
    // 18:34:59 实测的宿主会话标题生成行就是这个形态：
    // 既没有 internal 标记，也没有 tools 字段 —— 第一版会漏掉它。
    const fields = egressAuditFields({ provider: 'local-llm', model: 'm' })
    assert.equal(fields.tools, 0)
    assert.equal(fields.internal, undefined)
  })
})
