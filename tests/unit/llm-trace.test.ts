/**
 * llm-trace tests — §7.118 详细 LLM request/response 追踪
 *
 * 覆盖三件事：
 *   1. 凭据掩码 —— 真实厂商密钥形态必须被盖住，且不误伤普通英文词；
 *   2. 截断 —— 溢出必须**显式可见**（truncated + 溢出字符数）；
 *   3. trace 组装 —— 保留最近 N 条 message、脱敏、按字段截断、序列化单行。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import {
  DEFAULT_LLM_TRACE_CONFIG,
  SECRET_MASK,
  buildRequestTrace,
  buildResponseTrace,
  formatTraceLine,
  maskSecrets,
  messageContentToText,
  resolveLlmTraceConfig,
  sanitizeTraceText,
  truncateForLog,
  type LlmTraceConfig,
} from '../../src/dsh-adapter/llm-trace.js'

const cfg = (over: Partial<LlmTraceConfig> = {}): LlmTraceConfig => ({
  ...DEFAULT_LLM_TRACE_CONFIG,
  ...over,
})

describe('llm-trace', () => {
  describe('maskSecrets', () => {
    it('masks the vendor key shapes pii-utils misses (§7.118)', () => {
      // pii-utils 的 api-key 规则是
      // `sk-(?:proj-|ant-|live-|test-|org-)?[a-zA-Z0-9]{20,}` —— 它匹配不到
      // `sk-cp-`（MiniMax，`cp-` 不在允许前缀里，且下一段含 `_`）、
      // `sk-ws-`（DashScope，JWS 风格带点）、`tvly-`（Tavily）。
      // ⚠️ 这里必须是**明显伪造**的值：仓库一旦落真 key 前缀，
      // 等于把生产凭据的一部分公开在 git 历史里。形态照抄厂商规则
      // （sk-cp- 含下划线 / sk-ws- JWS 带点 / sk- 纯 hex），内容全是占位。
      const cases = [
        'sk-cp-EXAMPLE0_notreal000key',
        'sk-ws-EXAMPLE0.dot0.segment0.fake0',
        'tvly-PLACEHOLDER_REPLACE_ME',
        'sk-EXAMPLE0123456789abcdef00',
      ]
      for (const key of cases) {
        const r = maskSecrets(key)
        assert.ok(!r.text.includes(key), `leaked: ${r.text}`)
        assert.ok(r.text.includes(SECRET_MASK), `not masked: ${r.text}`)
        assert.ok(r.hits.length > 0)
      }
    })

    it('masks Bearer headers but keeps the scheme', () => {
      const r = maskSecrets('Authorization: Bearer sk-cp-abcdefghijklmnop123456')
      assert.ok(!r.text.includes('sk-cp-abcdefghijklmnop123456'), `leaked: ${r.text}`)
      assert.ok(r.text.includes('Bearer'))
    })

    it('masks labeled secrets but keeps the label readable', () => {
      const r = maskSecrets('{"api_key":"abcd1234efgh5678","password":"hunter2xyz"}')
      assert.ok(!r.text.includes('abcd1234efgh5678'), `leaked: ${r.text}`)
      assert.ok(!r.text.includes('hunter2xyz'), `leaked: ${r.text}`)
      assert.ok(r.text.includes('api_key'))
    })

    it('does not false-positive on ordinary words', () => {
      const safe = [
        'the key-representation of api-key-description is fine',
        'release sk-1.2.3.45 build',
        'monkey-business and hotdog stand',
      ]
      for (const s of safe) {
        const r = maskSecrets(s)
        assert.equal(r.text, s, `false positive on: ${s}`)
        assert.equal(r.hits.length, 0)
      }
    })
  })

  describe('truncateForLog', () => {
    it('marks truncation explicitly with the dropped char count', () => {
      const t = truncateForLog('x'.repeat(3000), 100)
      assert.equal(t.truncated, true)
      assert.equal(t.length, 3000)
      assert.ok(t.text.includes('…[+2900 chars]'), t.text.slice(-40))
      assert.ok(t.text.length < 200)
    })

    it('leaves short text untouched', () => {
      const t = truncateForLog('hello', 100)
      assert.equal(t.truncated, false)
      assert.equal(t.text, 'hello')
      assert.equal(t.length, 5)
    })

    it('treats maxChars<=0 as "no truncation"', () => {
      const t = truncateForLog('hello', 0)
      assert.equal(t.truncated, false)
      assert.equal(t.text, 'hello')
    })
  })

  describe('sanitizeTraceText', () => {
    it('masks credentials AND PII in one pass', () => {
      const out = sanitizeTraceText(
        '手机 13800138000，key sk-cp-abcdefghijklmnop123456',
        cfg(),
      )
      assert.ok(!out.text.includes('13800138000'), `leaked: ${out.text}`)
      assert.ok(!out.text.includes('sk-cp-abcdefghijklmnop123456'), `leaked: ${out.text}`)
    })

    it('honours redactPii=false', () => {
      const out = sanitizeTraceText('手机 13800138000', cfg({ redactPii: false }))
      assert.ok(out.text.includes('13800138000'))
    })

    it('honours redactSecrets=false', () => {
      const out = sanitizeTraceText('key sk-cp-abcdefghijklmnop123456', cfg({ redactSecrets: false }))
      assert.ok(out.text.includes('sk-cp-abcdefghijklmnop123456'))
    })
  })

  describe('messageContentToText', () => {
    it('flattens a content-block array', () => {
      assert.equal(
        messageContentToText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }, { type: 'image' }]),
        'ab',
      )
    })

    it('passes a bare string through', () => {
      assert.equal(messageContentToText('plain'), 'plain')
    })

    it('returns empty for unknown shapes', () => {
      assert.equal(messageContentToText(undefined), '')
      assert.equal(messageContentToText(42), '')
    })
  })

  describe('buildRequestTrace', () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: [{ type: 'text', text: `msg-${i}` }],
      source: { kind: i === 3 ? 'tool' : undefined },
    }))

    it('keeps the LAST maxMessages messages, not the first', () => {
      const t = buildRequestTrace({
        sessionId: 's1',
        provider: 'cloud-llm',
        model: 'm',
        messages,
        config: cfg({ maxMessages: 5 }),
      })
      assert.equal(t.messageCount, 20)
      assert.equal(t.messages.length, 5)
      assert.equal(t.droppedMessages, 15)
      assert.equal(t.messages[0].index, 15)
      assert.ok(t.messages[0].text?.text.includes('msg-15'))
    })

    it('redacts and truncates every message body', () => {
      const t = buildRequestTrace({
        sessionId: 's1',
        provider: 'cloud-llm',
        model: 'm',
        messages: [{ role: 'user', content: [{ type: 'text', text: '手机 13800138000' }] }],
        config: cfg(),
      })
      assert.ok(!t.messages[0].text?.text.includes('13800138000'))
      assert.equal(t.messages[0].length, 14)
    })

    it('omits the text field for messages without a body', () => {
      const t = buildRequestTrace({
        sessionId: 's1',
        provider: 'cloud-llm',
        model: 'm',
        messages: [{ role: 'assistant', content: [] }],
        config: cfg(),
      })
      assert.equal(t.messages[0].text, undefined)
      assert.equal(t.messages[0].length, 0)
    })

    it('tags tool-result messages with their source kind', () => {
      const t = buildRequestTrace({
        sessionId: 's1',
        provider: 'cloud-llm',
        model: 'm',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'tool' } }],
        config: cfg(),
      })
      assert.equal(t.messages[0].kind, 'tool')
    })

    it('lists tool names but never their schemas', () => {
      const t = buildRequestTrace({
        sessionId: 's1',
        provider: 'cloud-llm',
        model: 'm',
        messages: [],
        tools: [{ name: 'web_search' }, { function: { name: 'bash' } }],
        config: cfg(),
      })
      assert.deepEqual(t.tools, ['web_search', 'bash'])
    })

    it('carries the system prompt through the same redaction path', () => {
      const t = buildRequestTrace({
        sessionId: 's1',
        provider: 'cloud-llm',
        model: 'm',
        system: 'user token: sk-cp-abcdefghijklmnop123456',
        messages: [],
        config: cfg(),
      })
      assert.ok(t.system)
      assert.ok(!t.system.text.includes('sk-cp-abcdefghijklmnop123456'))
    })
  })

  describe('buildResponseTrace', () => {
    it('records content, tool calls and finish reason', () => {
      const t = buildResponseTrace({
        sessionId: 's1',
        provider: 'cloud-llm',
        model: 'm',
        content: '答案正文',
        toolCalls: [{ id: 'call_1', name: 'web_search', arguments: '{"q":"天气"}' }],
        finishReason: 'tool-calls',
        durationMs: 1234,
        attempt: 1,
        config: cfg(),
      })
      assert.equal(t.finishReason, 'tool-calls')
      assert.equal(t.durationMs, 1234)
      assert.equal(t.content?.text, '答案正文')
      assert.equal(t.toolCalls.length, 1)
      assert.equal(t.toolCalls[0].name, 'web_search')
      assert.equal(t.toolCalls[0].id, 'call_1')
      assert.ok(t.toolCalls[0].arguments?.text.includes('天气'))
    })

    it('redacts credentials inside tool-call arguments', () => {
      const t = buildResponseTrace({
        sessionId: 's1',
        provider: 'cloud-llm',
        model: 'm',
        toolCalls: [{ name: 'x', arguments: '{"key":"sk-cp-abcdefghijklmnop123456"}' }],
        config: cfg(),
      })
      assert.ok(!t.toolCalls[0].arguments?.text.includes('sk-cp-abcdefghijklmnop123456'))
    })

    it('keeps the error message (truncated)', () => {
      const t = buildResponseTrace({
        sessionId: 's1',
        provider: 'cloud-llm',
        model: 'm',
        error: 'x'.repeat(5000),
        config: cfg({ maxChars: 200 }),
      })
      assert.ok(t.error)
      assert.ok(t.error.includes('…[+ chars]') || t.error.length < 400, `len=${t.error?.length}`)
    })
  })

  describe('resolveLlmTraceConfig', () => {
    it('returns defaults when the config has no llmTrace section', () => {
      assert.deepEqual(resolveLlmTraceConfig({}), DEFAULT_LLM_TRACE_CONFIG)
      assert.deepEqual(resolveLlmTraceConfig(undefined), DEFAULT_LLM_TRACE_CONFIG)
    })

    it('fills missing fields from the defaults (partial config is legal)', () => {
      const c = resolveLlmTraceConfig({ audit: { llmTrace: { maxChars: 99 } } })
      assert.equal(c.maxChars, 99)
      assert.equal(c.enabled, DEFAULT_LLM_TRACE_CONFIG.enabled)
      assert.equal(c.redactPii, DEFAULT_LLM_TRACE_CONFIG.redactPii)
    })
  })

  describe('formatTraceLine', () => {
    it('emits exactly one physical line', () => {
      const line = formatTraceLine('tag', { text: 'a\nb\r\nc d' })
      assert.ok(!line.includes('\n'), 'must not contain a raw newline')
      assert.ok(!line.includes('\r'))
      assert.ok(line.startsWith('[tag] '))
    })

    it('survives unserializable payloads', () => {
      const circular: Record<string, unknown> = {}
      circular.self = circular
      const line = formatTraceLine('tag', circular)
      assert.ok(line.includes('trace-not-serializable'))
    })
  })
})
