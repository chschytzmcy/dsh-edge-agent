/**
 * §7.106 (2026-10-23) think-off wire shape. The ollama /v1 layer on the
 * operator's local server ignores `chat_template_kwargs` and top-level
 * `think` (probe-verified: message.reasoning survives both), so the local
 * pool must ALSO send `reasoning_effort:"none"` — otherwise the 256-token
 * model-detect budget is eaten by reasoning and content comes back empty
 * (finish=length → guard json-parse-failed fail-open every turn).
 */
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { buildChatCompletionsBody } from '../../src/dsh-adapter/openai-sse.ts'

const options = {
  provider: 'local-llm',
  model: 'qwen3.8:27b',
  messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
}

describe('§7.106 think-off dialects', () => {
  it('local pool (alsoReasoningEffort) sends BOTH chat_template_kwargs and reasoning_effort none', () => {
    const body = buildChatCompletionsBody(options as never, 'qwen3.8:27b', undefined, false, true)
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false })
    assert.equal(body.reasoning_effort, 'none')
  })

  it('default call (cloud direct / unknown-field-strict servers) keeps ONLY the old dialect', () => {
    const body = buildChatCompletionsBody(options as never, 'm', undefined, false)
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false })
    assert.equal('reasoning_effort' in body, false)
  })

  it('enableThinking=true sends NEITHER (thinking stays on, no overrides)', () => {
    const body = buildChatCompletionsBody(options as never, 'm', undefined, true, true)
    assert.equal('chat_template_kwargs' in body, false)
    assert.equal('reasoning_effort' in body, false)
  })
})
