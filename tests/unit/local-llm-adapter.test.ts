/**
 * M4 unit tests — local-llm-adapter real-mode dispatch.
 *
 * Every provider route the adapter owns hits the network. The
 * `local-qwen3-4b` route is exercised against a stubbed `fetch`
 * that returns the same SSE shape as the cloud tests. Provider
 * routing asserts the inner adapter picked by route id.
 *
 * Run via `pnpm test -t local-llm-adapter`.
 */

import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'vitest'

import * as localMod from '../../src/dsh-adapter/local-llm-adapter.ts'
import { LocalLlmAdapterImpl } from '../../src/dsh-adapter/local-llm-adapter.ts'

type FetchInit = { url: string; init: RequestInit }

interface CapturedRequest extends FetchInit {
  bodyJson: Record<string, unknown>
}

const originalFetch = globalThis.fetch

let captured: CapturedRequest | undefined
let fetchCallCount = 0

function installFetchMock(responder: (init: FetchInit) => Response): void {
  captured = undefined
  fetchCallCount = 0
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : (input as Request).url
    const bodyText = typeof init.body === 'string' ? init.body : ''
    const req: FetchInit = { url, init }
    captured = { ...req, bodyJson: bodyText.length > 0 ? JSON.parse(bodyText) : {} }
    fetchCallCount += 1
    return responder(req)
  }) as typeof fetch
}

function sseResponse(events: Array<Record<string, unknown>>, status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
  return new Response(stream, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch
}

describe('local-llm-adapter (M4, real-only)', () => {
  it('exports the canonical plugin shape', () => {
    assert.equal(localMod.name, 'local-llm-adapter')
    // 2026-08-31：注入 input-guard 用于清洗 orphan tool_call
    assert.deepEqual([...localMod.inject], ['llm', 'auditLog', 'inputGuard'])
    assert.equal(typeof localMod.apply, 'function')
    assert.ok(localMod.Config)
  })

  it('posts to {baseUrl}/chat/completions with the configured default model', async () => {
    installFetchMock(() => sseResponse([
      { choices: [{ delta: { content: 'pong' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]))

    const adapter = new LocalLlmAdapterImpl({
      providers: ['local-qwen3-4b'],
      baseUrl: 'http://127.0.0.1:8080/v1',
      defaultModel: 'qwen3-4b',
    })

    const chunks: unknown[] = []
    for await (const chunk of adapter.stream({
      provider: 'local-qwen3-4b',
      model: '',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    })) {
      chunks.push(chunk)
    }

    assert.ok(captured, 'real mode must hit fetch')
    assert.equal(captured!.url, 'http://127.0.0.1:8080/v1/chat/completions')
    assert.equal(captured!.init.method, 'POST')
    assert.equal(
      (captured!.init.headers as Record<string, string>)['content-type'],
      'application/json',
    )
    assert.equal(captured!.bodyJson.model, 'qwen3-4b')
    assert.equal(captured!.bodyJson.stream, true)
    const wireMessages = captured!.bodyJson.messages as Array<Record<string, unknown>>
    assert.equal(wireMessages.length, 1)
    assert.equal(wireMessages[0]!.role, 'user')

    const types = chunks.map((c) => (c as { type: string }).type)
    assert.deepEqual(types, ['block-start', 'text-delta', 'block-end', 'finish'])
    restoreFetch()
  })

  it('omits the bearer header when no apiKeyEnv is configured', async () => {
    installFetchMock(() => sseResponse([
      { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
    ]))

    const adapter = new LocalLlmAdapterImpl({
      providers: ['local-qwen3-4b'],
      baseUrl: 'http://192.168.66.195:8701/v1',
      defaultModel: 'qwen3-4b',
    })
    for await (const _ of adapter.stream({
      provider: 'local-qwen3-4b',
      model: 'qwen3-4b',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) {
      // drain
    }

    assert.ok(captured)
    const headers = captured!.init.headers as Record<string, string>
    assert.equal(headers.authorization, undefined)
    assert.equal(captured!.url, 'http://192.168.66.195:8701/v1/chat/completions')
    restoreFetch()
  })

  it('threads the apiKeyEnv bearer when configured', async () => {
    process.env.DSH_EDGE_LOCAL_LLM_KEY = 'sk-llm-test'
    installFetchMock(() => sseResponse([
      { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
    ]))

    const adapter = new LocalLlmAdapterImpl({
      providers: ['local-qwen3-4b'],
      baseUrl: 'http://192.168.66.195:8701/v1',
      defaultModel: 'qwen3-4b',
      apiKeyEnv: 'DSH_EDGE_LOCAL_LLM_KEY',
    })
    for await (const _ of adapter.stream({
      provider: 'local-qwen3-4b',
      model: 'qwen3-4b',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) {
      // drain
    }
    delete process.env.DSH_EDGE_LOCAL_LLM_KEY

    assert.ok(captured)
    assert.match(
      (captured!.init.headers as Record<string, string>).authorization,
      /^Bearer sk-llm-test$/u,
    )
    restoreFetch()
  })

  it('routes the right inner adapter by provider id when multiple routes are mounted', async () => {
    installFetchMock(() => sseResponse([
      { choices: [{ delta: { content: 'remote-reply' }, finish_reason: 'stop' }] },
    ]))

    const adapter = new LocalLlmAdapterImpl({
      providers: ['local-qwen3-4b', 'local-qwen3-4b-alt'],
      baseUrl: 'http://192.168.66.195:8701/v1',
      defaultModel: 'qwen3-4b',
    })

    // First route hits the network (signal-pulled landing).
    const firstChunks: unknown[] = []
    for await (const chunk of adapter.stream({
      provider: 'local-qwen3-4b',
      model: 'qwen3-4b',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'first' }] }],
    })) {
      firstChunks.push(chunk)
    }
    const firstText = (firstChunks[1] as { text: string }).text
    assert.equal(firstText, 'remote-reply')
    assert.equal(fetchCallCount, 1)

    // Second route hits the network too (no in-process mock).
    const secondChunks: unknown[] = []
    for await (const chunk of adapter.stream({
      provider: 'local-qwen3-4b-alt',
      model: 'qwen3-4b',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'second' }] }],
    })) {
      secondChunks.push(chunk)
    }
    const secondText = (secondChunks[1] as { text: string }).text
    assert.equal(secondText, 'remote-reply')
    assert.equal(fetchCallCount, 2)
    restoreFetch()
  })

  it('throws UNKNOWN_PROVIDER for routes the adapter does not own', async () => {
    installFetchMock(() => sseResponse([]))
    const adapter = new LocalLlmAdapterImpl({
      providers: ['local-qwen3-4b'],
      baseUrl: 'http://127.0.0.1:8080/v1',
      defaultModel: 'qwen3-4b',
    })

    await assert.rejects(
      (async () => {
        for await (const _ of adapter.stream({
          provider: 'cloud-deepseek-v4',
          model: 'deepseek-chat',
          messages: [],
        })) {
          // drain
        }
      })(),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal((error as { code?: string }).code, 'UNKNOWN_PROVIDER')
        return true
      },
    )
    restoreFetch()
  })

  // 2026-09-03 §7.34.2 regression suite: empty stream must NOT leave
  // BlockAssembler with an orphan text block. Real-world repro (webui
  // chat "查询下密盒有哪些图片文件" 17:20:40 +08:00): llama.cpp
  // 192.168.1.121:11017 returned completion_tokens=0 finish_reason=stop
  // for a 24-message / 2535-token prompt. dsh received block-start
  // then finish with no block-end — agent-loop state machine hung
  // waiting for the missing block-end.
  //
  // Fix: yield `block-start` lazily, only just before the first text-delta.
  // Empty streams now yield no block-start at all, so BlockAssembler stays
  // in clean state.
  it('empty stream (finish=stop with no content) → no block-start, only finish chunk (§7.34.2)', async () => {
    installFetchMock(() => sseResponse([
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]))
    const adapter = new LocalLlmAdapterImpl({
      providers: ['local-qwen3-4b'],
      baseUrl: 'http://127.0.0.1:8080/v1',
      defaultModel: 'qwen3-4b',
    })

    const chunks: Array<{ type: string; [k: string]: unknown }> = []
    for await (const chunk of adapter.stream({
      provider: 'local-qwen3-4b',
      model: 'qwen3-4b',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) {
      chunks.push(chunk as { type: string })
    }

    const types = chunks.map((c) => c.type)
    // §7.34.2: empty stream yields ONLY 'finish' — no orphan 'block-start'.
    // 之前会 yield ['block-start', 'finish'] → BlockAssembler 卡在等待 block-end。
    assert.deepEqual(types, ['finish'])
    const finishChunk = chunks[0] as { type: string; reason?: { kind: string } }
    assert.equal(finishChunk.reason?.kind, 'stop')
    restoreFetch()
  })

  it('text-delta stream → block-start emitted ONCE before first delta (§7.34.2)', async () => {
    installFetchMock(() => sseResponse([
      { choices: [{ delta: { content: 'hello' }, finish_reason: null }] },
      { choices: [{ delta: { content: ' world' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]))
    const adapter = new LocalLlmAdapterImpl({
      providers: ['local-qwen3-4b'],
      baseUrl: 'http://127.0.0.1:8080/v1',
      defaultModel: 'qwen3-4b',
    })

    const chunks: Array<{ type: string; [k: string]: unknown }> = []
    for await (const chunk of adapter.stream({
      provider: 'local-qwen3-4b',
      model: 'qwen3-4b',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) {
      chunks.push(chunk as { type: string })
    }

    const types = chunks.map((c) => c.type)
    assert.deepEqual(types, ['block-start', 'text-delta', 'text-delta', 'block-end', 'finish'])
    // 严格断言只有 1 个 block-start（防止回归到多次 yield）
    assert.equal(types.filter((t) => t === 'block-start').length, 1)
    restoreFetch()
  })

  // §7.42 (2026-09-05) P0-1: malformed-tool-call detection.
  // qwen3-4b sometimes emits ~12 bytes of pure XML tag fragments as
  // plain-text content while setting finish_reason='tool_calls'. Without
  // detection, dsh-agent-loop enters a runaway (152 iterations observed).
  // The adapter must detect this pattern and rewrite finishKind to 'stop'.
  it('malformed tool-call response (XML fragment + finish_reason=tool_calls) → rewrite to stop (§7.42 P0-1)', async () => {
    // Build the XML fragment at runtime to avoid embedding the literal in source.
    // Real-world value: 12 bytes = `\n</think>\n`.
    const xmlFragment = '\n' + String.fromCharCode(60) + '/think' + String.fromCharCode(62) + '\n'

    const auditEvents: Array<{ level: string; kind: string; payload: Record<string, unknown> }> = []
    const warnMessages: string[] = []
    const auditLog = {
      async log(entry: { level: string; kind: string; source: string; payload: Record<string, unknown> }): Promise<void> {
        auditEvents.push({ level: entry.level, kind: entry.kind, payload: entry.payload })
      },
    }
    const logger = {
      info: () => {},
      warn: (msg: string) => { warnMessages.push(msg) },
      error: () => {},
      debug: () => {},
    }

    installFetchMock(() => sseResponse([
      // Model emits the XML fragment as content (text-delta) ...
      { choices: [{ delta: { content: xmlFragment }, finish_reason: null }] },
      // ... but claims finish_reason=tool_calls (wire format uses underscore;
      // the parser normalizes it to the internal 'tool-calls' form).
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]))
    const adapter = new LocalLlmAdapterImpl(
      {
        providers: ['local-qwen3-4b'],
        baseUrl: 'http://127.0.0.1:8080/v1',
        defaultModel: 'qwen3-4b',
      },
      auditLog,
      undefined, // inputGuard
      logger,
    )

    const chunks: Array<{ type: string; [k: string]: unknown }> = []
    for await (const chunk of adapter.stream({
      provider: 'local-qwen3-4b',
      model: 'qwen3-4b',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) {
      chunks.push(chunk as { type: string })
    }

    const types = chunks.map((c) => c.type)
    // After P0-1 rewrite, the stream should look like a normal text response:
    // block-start (lazy) → text-delta (the fragment) → block-end → finish
    assert.deepEqual(types, ['block-start', 'text-delta', 'block-end', 'finish'])

    // Critical: finish reason must be 'stop', NOT 'tool-calls'.
    const finishChunk = chunks[chunks.length - 1] as { type: string; reason?: { kind: string } }
    assert.equal(finishChunk.reason?.kind, 'stop', 'malformed tool-call must be rewritten to stop')

    // The text-delta should carry the original fragment (so the user sees what the model emitted).
    const textChunk = chunks[1] as { type: string; text: string }
    assert.equal(textChunk.text, xmlFragment)

    // Verify the audit event was emitted with warn level.
    const malformedEvent = auditEvents.find((e) => e.kind === 'llm.local.malformed_tool_call')
    assert.ok(malformedEvent, 'must emit llm.local.malformed_tool_call audit event')
    assert.equal(malformedEvent.level, 'warn')

    // Verify the ops log got a warn message.
    assert.ok(warnMessages.some((m) => m.includes('malformed tool-call response')), 'must log warn about malformed tool-call')

    restoreFetch()
  })

  // §7.42 (2026-09-05) P0-2: per-session max-turns guard.
  // If the local LLM emits >20 REAL tool-call responses in a row, the
  // adapter must throw LlmError('MAX_TURNS_EXCEEDED') to bound the runaway.
  it('max-turns guard: >20 consecutive tool-call responses → throw MAX_TURNS_EXCEEDED (§7.42 P0-2)', async () => {
    // Real tool-call SSE stream (model emits proper tool-call JSON, not malformed).
    // The OpenAI SSE format for tool calls:
    //   delta.tool_calls[0] = { index: 0, id: 'call_1', function: { name: 'list_files', arguments: '' } }
    //   delta.tool_calls[0] = { index: 0, function: { arguments: '{"pa' } }
    //   ... then finish_reason='tool-calls'
    const realToolCallEvents = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'list_files', arguments: '' } }] }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"/tmp"}' } }] }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]

    const auditEvents: Array<{ level: string; kind: string }> = []
    const auditLog = {
      async log(entry: { level: string; kind: string; source: string; payload: Record<string, unknown> }): Promise<void> {
        auditEvents.push({ level: entry.level, kind: entry.kind })
      },
    }
    const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }

    const adapter = new LocalLlmAdapterImpl(
      { providers: ['local-qwen3-4b'], baseUrl: 'http://127.0.0.1:8080/v1', defaultModel: 'qwen3-4b' },
      auditLog,
      undefined,
      logger,
    )

    const sessionId = 'p0-maxturns-test-' + Date.now()

    // First 20 calls: succeed (tool-calls finish, counter increments).
    for (let i = 0; i < 20; i++) {
      installFetchMock(() => sseResponse(realToolCallEvents))
      const chunks: unknown[] = []
      for await (const chunk of adapter.stream({
        provider: 'local-qwen3-4b',
        model: 'qwen3-4b',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        sessionId,
      } as unknown as Parameters<typeof adapter.stream>[0])) {
        chunks.push(chunk)
      }
      // Each call should produce a tool-calls finish.
      const finish = chunks[chunks.length - 1] as { reason?: { kind: string } }
      assert.equal(finish.reason?.kind, 'tool-calls', `call ${i + 1} should finish with tool-calls`)
    }

    // 21st call: must throw MAX_TURNS_EXCEEDED.
    installFetchMock(() => sseResponse(realToolCallEvents))
    await assert.rejects(
      (async () => {
        for await (const _ of adapter.stream({
          provider: 'local-qwen3-4b',
          model: 'qwen3-4b',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
          sessionId,
        } as unknown as Parameters<typeof adapter.stream>[0])) {
          // drain
        }
      })(),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal((error as { code?: string }).code, 'MAX_TURNS_EXCEEDED')
        return true
      },
    )

    // Verify audit event was emitted.
    assert.ok(auditEvents.some((e) => e.kind === 'llm.local.max_turns_exceeded'), 'must emit max_turns_exceeded audit')

    // After the throw, counter is reset. Next call should succeed.
    installFetchMock(() => sseResponse([
      { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
    ]))
    const chunks: unknown[] = []
    for await (const chunk of adapter.stream({
      provider: 'local-qwen3-4b',
      model: 'qwen3-4b',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      sessionId,
    } as unknown as Parameters<typeof adapter.stream>[0])) {
      chunks.push(chunk)
    }
    const finish = chunks[chunks.length - 1] as { reason?: { kind: string } }
    assert.equal(finish.reason?.kind, 'stop', 'after throw + reset, next call should terminate cleanly')

    restoreFetch()
  })
})
