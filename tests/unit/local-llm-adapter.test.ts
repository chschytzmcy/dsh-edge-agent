/**
 * M4 unit tests — local-llm-adapter real-mode dispatch.
 *
 * Every provider route the adapter owns hits the network. The
 * `local-llm` route is exercised against a stubbed `fetch`
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
      providers: ['local-llm'],
      baseUrl: 'http://127.0.0.1:8080/v1',
      defaultModel: 'qwen3-4b',
    })

    const chunks: unknown[] = []
    for await (const chunk of adapter.stream({
      provider: 'local-llm',
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

  // §7.106 (2026-10-23): a single LAN blip killed a whole agent turn at
  // 11:35:09 (`fetch failed` while the same server was healthy minutes
  // before/after) — transport errors now get ONE retry after a short
  // backoff. HTTP-error and abort paths deliberately do not retry.
  it('retries a transient network failure once and completes', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      if (calls === 1) throw new TypeError('fetch failed')
      return sseResponse([
        { choices: [{ delta: { content: 'pong' }, finish_reason: 'stop' }] },
      ])
    }) as typeof fetch
    const adapter = new LocalLlmAdapterImpl({
      providers: ['local-llm'],
      baseUrl: 'http://127.0.0.1:8080/v1',
      defaultModel: 'qwen3-4b',
    })
    const chunks: unknown[] = []
    for await (const chunk of adapter.stream({
      provider: 'local-llm',
      model: '',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    })) {
      chunks.push(chunk)
    }
    assert.equal(calls, 2, 'one retry after the transient failure')
    assert.ok(chunks.some(c => (c as { type: string }).type === 'text-delta'), 'stream completes')
    restoreFetch()
  })

  it('gives up after the single retry and rethrows', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      throw new TypeError('fetch failed')
    }) as typeof fetch
    const adapter = new LocalLlmAdapterImpl({
      providers: ['local-llm'],
      baseUrl: 'http://127.0.0.1:8080/v1',
      defaultModel: 'qwen3-4b',
    })
    await assert.rejects(async () => {
      for await (const _ of adapter.stream({
        provider: 'local-llm',
        model: '',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
      })) { /* drain */ }
    })
    assert.equal(calls, 2, 'exactly one retry, no more')
    restoreFetch()
  })

  it('omits the bearer header when no apiKeyEnv is configured', async () => {
    installFetchMock(() => sseResponse([
      { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
    ]))

    const adapter = new LocalLlmAdapterImpl({
      providers: ['local-llm'],
      baseUrl: 'http://192.168.66.195:8701/v1',
      defaultModel: 'qwen3-4b',
    })
    for await (const _ of adapter.stream({
      provider: 'local-llm',
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
      providers: ['local-llm'],
      baseUrl: 'http://192.168.66.195:8701/v1',
      defaultModel: 'qwen3-4b',
      apiKeyEnv: 'DSH_EDGE_LOCAL_LLM_KEY',
    })
    for await (const _ of adapter.stream({
      provider: 'local-llm',
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
      providers: ['local-llm', 'local-llm-alt'],
      baseUrl: 'http://192.168.66.195:8701/v1',
      defaultModel: 'qwen3-4b',
    })

    // First route hits the network (signal-pulled landing).
    const firstChunks: unknown[] = []
    for await (const chunk of adapter.stream({
      provider: 'local-llm',
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
      provider: 'local-llm-alt',
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
      providers: ['local-llm'],
      baseUrl: 'http://127.0.0.1:8080/v1',
      defaultModel: 'qwen3-4b',
    })

    await assert.rejects(
      (async () => {
        for await (const _ of adapter.stream({
          provider: 'cloud-llm',
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
      providers: ['local-llm'],
      baseUrl: 'http://127.0.0.1:8080/v1',
      defaultModel: 'qwen3-4b',
    })

    const chunks: Array<{ type: string; [k: string]: unknown }> = []
    for await (const chunk of adapter.stream({
      provider: 'local-llm',
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
      providers: ['local-llm'],
      baseUrl: 'http://127.0.0.1:8080/v1',
      defaultModel: 'qwen3-4b',
    })

    const chunks: Array<{ type: string; [k: string]: unknown }> = []
    for await (const chunk of adapter.stream({
      provider: 'local-llm',
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
        providers: ['local-llm'],
        baseUrl: 'http://127.0.0.1:8080/v1',
        defaultModel: 'qwen3-4b',
      },
      auditLog,
      undefined, // inputGuard
      logger,
    )

    const chunks: Array<{ type: string; [k: string]: unknown }> = []
    for await (const chunk of adapter.stream({
      provider: 'local-llm',
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
      { providers: ['local-llm'], baseUrl: 'http://127.0.0.1:8080/v1', defaultModel: 'qwen3-4b' },
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
        provider: 'local-llm',
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
          provider: 'local-llm',
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
      provider: 'local-llm',
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

  // §7.46.1 (2026-09-11): local-llm-adapter per-call info log 同 cloud。
  describe('per-call ops log (§7.46.1)', () => {
    it('emits LLM call start + done with sessionId, provider, model, duration', async () => {
      installFetchMock(() => sseResponse([
        { choices: [{ delta: { content: 'pong' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]))
      const infoLines: string[] = []
      const fakeLogger = {
        info: (line: string) => infoLines.push(line),
        warn: () => {},
        error: () => {},
        debug: () => {},
      }
      const adapter = new LocalLlmAdapterImpl(
        {
          providers: ['local-llm'],
          baseUrl: 'http://127.0.0.1:11017',
          apiKeyEnv: undefined,
          defaultModel: 'qwen3-4b-instruct-2507',
        },
        undefined,
        undefined,
        fakeLogger,
      )
      for await (const _ of adapter.stream({
        provider: 'local-llm',
        model: 'qwen3-4b-instruct-2507',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
        sessionId: 'sec7461-local',
      } as any)) {
        // drain
      }
      const start = infoLines.find((l) => l.includes('LLM call start'))
      const done = infoLines.find((l) => l.includes('LLM call done'))
      assert.ok(start, `expected LLM call start line, got: ${JSON.stringify(infoLines)}`)
      assert.ok(done, `expected LLM call done line, got: ${JSON.stringify(infoLines)}`)
      assert.ok(start!.includes('sessionId=sec7461-local'), 'start should include sessionId')
      assert.ok(start!.includes('provider=local-llm'), 'start should include provider')
      assert.ok(start!.includes('model=qwen3-4b-instruct-2507'), 'start should include model')
      assert.ok(done!.includes('sessionId=sec7461-local'), 'done should include sessionId')
      assert.match(done!, /durationMs=\d+/, 'done should include durationMs=N')
      assert.match(done!, /resultLen=\d+/, 'done should include resultLen=N')
      assert.ok(done!.includes('finishKind=stop'), 'done should include finishKind=stop')
      restoreFetch()
    })
  })

  // §7.4? (2026-09-17) stripTools client-side workaround.
  // LAN minicpm5-2b server Jinja2 `tojson(ensure_ascii)` crash when
  // body.tools is non-empty. The adapter must drop body.tools when
  // stripTools=true so the upstream `{% if tools %}` block is skipped.
  // Inverse template: cloud-llm-adapter.test.ts:214 (`forwards tools …`).
  describe('stripTools workaround (§7.4?)', () => {
    it('omits body.tools when stripTools=true', async () => {
      installFetchMock(() => sseResponse([
        { choices: [{ delta: { content: 'pong' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]))

      const adapter = new LocalLlmAdapterImpl({
        providers: ['local-llm'],
        baseUrl: 'http://127.0.0.1:8080/v1',
        defaultModel: 'qwen3-4b',
        stripTools: true,
      })

      for await (const _ of adapter.stream({
        provider: 'local-llm',
        model: 'qwen3-4b',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
        tools: [{
          name: 'local_file_read',
          description: 'read',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        }],
      })) {
        // drain
      }

      assert.ok(captured)
      assert.equal(captured!.bodyJson.tools, undefined,
        `expected no body.tools; got: ${JSON.stringify(captured!.bodyJson.tools)}`)
      assert.equal(captured!.bodyJson.model, 'qwen3-4b')
      assert.equal(captured!.bodyJson.stream, true)
      restoreFetch()
    })

    it('forwards body.tools when stripTools=false (default)', async () => {
      installFetchMock(() => sseResponse([
        { choices: [{ delta: { content: 'pong' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]))

      const adapter = new LocalLlmAdapterImpl({
        providers: ['local-llm'],
        baseUrl: 'http://127.0.0.1:8080/v1',
        defaultModel: 'qwen3-4b',
      })

      for await (const _ of adapter.stream({
        provider: 'local-llm',
        model: 'qwen3-4b',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
        tools: [{
          name: 'local_file_read',
          description: 'read',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        }],
      })) {
        // drain
      }

      assert.ok(captured)
      const wireTools = captured!.bodyJson.tools as Array<Record<string, unknown>>
      assert.ok(Array.isArray(wireTools), 'body.tools must be forwarded as array')
      assert.equal(wireTools.length, 1)
      assert.equal(wireTools[0]!.type, 'function')
      assert.equal((wireTools[0]!.function as Record<string, unknown>).name, 'local_file_read')
      restoreFetch()
    })
  })

  // 2026-10-21: the local-LLM route is opt-in. The Schema used to default
  // `baseUrl` to `http://127.0.0.1:8080/v1`, so the route was live even
  // when the operator never configured one — and on a machine where an
  // unrelated authenticated daemon owns 8080, every turn failed with
  // HTTP 401 "Missing bearer token".
  describe('opt-in endpoint (2026-10-21)', () => {
    it('registers no provider route when baseUrl is unset', async () => {
      const registered: string[][] = []
      const ctx = {
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
        llm: {
          registerAdapter(providers: string[], _adapter: unknown) {
            registered.push(providers)
            return () => {}
          },
        },
      }

      const dispose = await localMod.apply(ctx as never, {
        providers: ['local-llm'],
        defaultModel: 'qwen3-4b',
      } as never)

      assert.deepEqual(registered, [], 'no route may be registered without an endpoint')
      await dispose()
    })

    it('registers the provider route when baseUrl is set', async () => {
      const registered: string[][] = []
      const ctx = {
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
        llm: {
          registerAdapter(providers: string[], _adapter: unknown) {
            registered.push(providers)
            return () => {}
          },
        },
      }

      const dispose = await localMod.apply(ctx as never, {
        providers: ['local-llm'],
        baseUrl: 'http://127.0.0.1:11000/v1',
        defaultModel: 'qwen3-4b',
      } as never)

      assert.deepEqual(registered, [['local-llm']])
      await dispose()
    })

    it('names the apiKeyEnv knob in the 401 message', async () => {
      installFetchMock(() => new Response(
        '{"ok":false,"error":{"code":"UNAUTHORIZED","message":"Missing bearer token"}}',
        { status: 401, headers: { 'content-type': 'application/json' } },
      ))

      const adapter = new LocalLlmAdapterImpl({
        providers: ['local-llm'],
        baseUrl: 'http://127.0.0.1:8080/v1',
        defaultModel: 'qwen3-4b',
        apiKeyEnv: 'DSH_EDGE_LOCAL_LLM_KEY',
      })

      await assert.rejects(
        (async () => {
          for await (const _ of adapter.stream({
            provider: 'local-llm',
            model: 'qwen3-4b',
            messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
          })) {
            // drain
          }
        })(),
        /HTTP 401[\s\S]*apiKeyEnv[\s\S]*DSH_EDGE_LOCAL_LLM_KEY/,
      )
      restoreFetch()
    })
  })

  // §7.130: §7.129 曾让出口行带一个 `baseUrlIsLocal` 布尔值（服务端算好
  // 落点是否本机，随出口行下发）。该字段已撤回 —— 判定「是否出网」的依据
  // 是 category（哪个池），不是端点落在哪台机，端点位置不参与出网判断。
  // 这里钉死「该字段不再存在」，避免它被当成仍在生效的契约。
  describe('§7.130 — 出口行不再带 baseUrlIsLocal', () => {
    async function startRowFor(baseUrl: string): Promise<any> {
      installFetchMock(() => sseResponse([
        { choices: [{ delta: { content: 'pong' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]))
      const entries: any[] = []
      const auditLog = { log: async (e: any) => { entries.push(e) } }
      const adapter = new LocalLlmAdapterImpl(
        { providers: ['local-llm'], baseUrl, defaultModel: 'qwen3-4b' },
        auditLog as any,
      )
      for await (const _ of adapter.stream({
        provider: 'local-llm',
        model: 'qwen3-4b',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
      })) { /* drain */ }
      restoreFetch()
      return entries.find(e => e.kind === 'llm.local.start')
    }

    it('loopback 端点 → 出口行不带 baseUrlIsLocal', async () => {
      const row = await startRowFor('http://127.0.0.1:8080/v1')
      assert.ok(row, 'llm.local.start 必须落盘')
      assert.equal('baseUrlIsLocal' in row.payload, false)
    })

    it('非 loopback 端点 → 出口行同样不带 baseUrlIsLocal', async () => {
      const row = await startRowFor('http://67.0.1.1:11434/v1')
      assert.ok(row, 'llm.local.start 必须落盘')
      assert.equal('baseUrlIsLocal' in row.payload, false)
    })
  })

  // §7.131 (2026-10-27): 主人裁决的两条规则是**不对称**的 ——
  //   cloud-llm：只能携带之前所有上 cloudllm 的历史（本地段一律不带）
  //   local-llm：携带**所有**历史会话信息
  // 本地池是 operator 自有设施，带全部历史不算出网，所以**不裁**。
  // 这条用例钉死「本地路径没有被顺手裁掉」—— 它是云端那条规则的反面。
  describe('§7.131 — 本地池出网携带全部历史', () => {
    it('云段 + 本地段的历史一条都不少', async () => {
      installFetchMock(() => sseResponse([
        { choices: [{ delta: { content: 'pong' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]))
      const entries: any[] = []
      const auditLog = { log: async (e: any) => { entries.push(e) } }
      const adapter = new LocalLlmAdapterImpl(
        { providers: ['local-llm'], baseUrl: 'http://127.0.0.1:11434/v1', defaultModel: 'qwen3-4b' },
        auditLog as any,
      )
      const messages = [
        { role: 'user', content: [{ type: 'text', text: '云轮输入' }], source: { kind: 'user' } },
        { role: 'assistant', content: [{ type: 'text', text: '云轮回答' }], source: { kind: 'model', provider: 'cloud-llm', model: 'm' } },
        { role: 'user', content: [{ type: 'text', text: '本地轮输入' }], source: { kind: 'user' } },
        { role: 'assistant', content: [{ type: 'text', text: '本地轮回答' }], source: { kind: 'model', provider: 'local-llm', model: 'm' } },
        { role: 'user', content: [{ type: 'text', text: '本轮输入' }], source: { kind: 'user' } },
      ]
      for await (const _ of adapter.stream({
        provider: 'local-llm',
        model: 'qwen3-4b',
        messages: messages as any,
      })) { /* drain */ }
      restoreFetch()

      const row = entries.find(e => e.kind === 'llm.local.start')
      assert.ok(row, 'llm.local.start 必须落盘')
      assert.equal(row.payload.messageCount, 5, '本地池必须携带全部历史（云段 + 本地段）')

      const wire = (captured?.bodyJson?.messages ?? []) as Array<{ content: unknown }>
      const texts = wire.map(m => typeof m.content === 'string'
        ? m.content
        : (Array.isArray(m.content) ? m.content.map(b => (b as { text?: string }).text ?? '').join('') : ''))
      assert.ok(texts.some(t => t.includes('云轮输入')), `云段历史必须带上: ${JSON.stringify(texts)}`)
      assert.ok(texts.some(t => t.includes('本地轮输入')), `本地段历史必须带上: ${JSON.stringify(texts)}`)
      assert.ok(texts.some(t => t.includes('本轮输入')), `本轮必须带上: ${JSON.stringify(texts)}`)
    })
  })

  // §7.132: 出口审计行必须带出网判别字段 —— `tools`（这次请求带了几件工具）
  // 与 `internal`（内部调用标记）。面板靠它们把「主对话出网」与「插件的
  // 内部 LLM 调用」分开（prompt-guard 的安检、intent-router 的分类器、
  // 宿主的会话标题生成全都落同样的 llm.local.start 行）。
  describe('§7.132 — 出口行带出网判别字段', () => {
    async function startRowFor(options: Record<string, unknown>): Promise<any> {
      installFetchMock(() => sseResponse([
        { choices: [{ delta: { content: 'pong' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]))
      const entries: any[] = []
      const auditLog = { log: async (e: any) => { entries.push(e) } }
      const adapter = new LocalLlmAdapterImpl(
        { providers: ['local-llm'], baseUrl: 'http://127.0.0.1:11434/v1', defaultModel: 'qwen3-4b' },
        auditLog as any,
      )
      for await (const _ of adapter.stream({
        provider: 'local-llm',
        model: 'qwen3-4b',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
        ...options,
      } as any)) { /* drain */ }
      restoreFetch()
      return entries.find(e => e.kind === 'llm.local.start')
    }

    it('主对话（带工具）→ tools 落数量，无 internal 标记', async () => {
      const row = await startRowFor({ tools: [{ name: 'read' }, { name: 'grep' }] })
      assert.ok(row, 'llm.local.start 必须落盘')
      assert.equal(row.payload.tools, 2)
      assert.equal(row.payload.internal, undefined)
    })

    it('内部调用（无工具 + internal 标记）→ tools=0 + internal 落标记', async () => {
      const row = await startRowFor({ tools: [], edgeInternalCaller: 'prompt-guard' })
      assert.ok(row, 'llm.local.start 必须落盘')
      assert.equal(row.payload.tools, 0)
      assert.equal(row.payload.internal, 'prompt-guard')
    })

    it('宿主没传 tools → 恒落 tools=0（这样宿主的内部调用也能被排除）', async () => {
      const row = await startRowFor({})
      assert.ok(row, 'llm.local.start 必须落盘')
      assert.equal(row.payload.tools, 0)
      assert.equal(row.payload.internal, undefined)
    })
  })

  // §7.147 (2026-10-29): 这条**开始**行必须带 sessionId ——
  //
  // Edge 面板按**行**判断「这一轮」（§7.145-B）：会话自己的行 `turn >= 0`，
  // 全局行 `turn === -1`。归属由宿主 `edge-context-view.ts` 的
  // `extractSessionId()` 决定 —— 载荷里没有 sessionId 就是全局行，而全局桶
  // 会被合并进**任何一个**会话的快照。
  //
  // 实机取证（本机审计链 4962 行逐 kind 统计）：`llm.local.start` 640 条
  // **无一带** sessionId；而**同一次调用**的 `llm.local.end` 带了 483/569 ——
  // 同一个 LLM 往返，两半归属不一致。后果：路由面板结构上不可能归属任何一轮，
  // 面板只能显示「尚未绑定会话 + 全局信号」。
  describe('§7.147 — 开始行带会话归属', () => {
    async function startRowFor(options: Record<string, unknown>): Promise<any> {
      installFetchMock(() => sseResponse([
        { choices: [{ delta: { content: 'pong' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]))
      const entries: any[] = []
      const auditLog = { log: async (e: any) => { entries.push(e) } }
      const adapter = new LocalLlmAdapterImpl(
        { providers: ['local-llm'], baseUrl: 'http://127.0.0.1:11434/v1', defaultModel: 'qwen3-4b' },
        auditLog as any,
      )
      for await (const _ of adapter.stream({
        provider: 'local-llm',
        model: 'qwen3-4b',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
        ...options,
      } as any)) { /* drain */ }
      restoreFetch()
      return entries.find(e => e.kind === 'llm.local.start')
    }

    it('宿主给了 sessionId → 开始行带它（这行才是「这一轮」的证据）', async () => {
      const row = await startRowFor({ sessionId: 'session-8c67f7ca-1db4-4714-b89f-8f8ecb99d7c8' })
      assert.ok(row, 'llm.local.start 必须落盘')
      assert.equal(row.payload.sessionId, 'session-8c67f7ca-1db4-4714-b89f-8f8ecb99d7c8')
    })

    it('没有 sessionId → **不带** sessionId 键（反向证伪：不能造假桶）', async () => {
      // 反向证伪点：若无会话时写进一个假 id（例如 'unknown'），宿主会造出
      // 一个不存在的桶 —— 那几行从此只在「有人请求那个假 id」时可见，等于从
      // 所有真实会话的视图里消失。宁可归全局（全局桶合并进每个会话），
      // 不要无处可见。
      const row = await startRowFor({})
      assert.ok(row, 'llm.local.start 必须落盘')
      assert.equal('sessionId' in row.payload, false)
    })

    it('哨兵 sessionId → **不带** sessionId 键（哨兵不是会话 id）', async () => {
      const row = await startRowFor({ sessionId: '<pre-session>' })
      assert.ok(row, 'llm.local.start 必须落盘')
      assert.equal('sessionId' in row.payload, false)
    })

    it('开始行与结束行的归属一致（同一 id 两半都带）', async () => {
      installFetchMock(() => sseResponse([
        { choices: [{ delta: { content: 'pong' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]))
      const entries: any[] = []
      const auditLog = { log: async (e: any) => { entries.push(e) } }
      const adapter = new LocalLlmAdapterImpl(
        { providers: ['local-llm'], baseUrl: 'http://127.0.0.1:11434/v1', defaultModel: 'qwen3-4b' },
        auditLog as any,
      )
      for await (const _ of adapter.stream({
        provider: 'local-llm',
        model: 'qwen3-4b',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
        sessionId: 's-half',
      } as any)) { /* drain */ }
      restoreFetch()
      const start = entries.find(e => e.kind === 'llm.local.start')
      const end = entries.find(e => e.kind === 'llm.local.end')
      assert.ok(start, 'llm.local.start 必须落盘')
      assert.ok(end, 'llm.local.end 必须落盘')
      assert.equal(start.payload.sessionId, 's-half')
      assert.equal(end.payload.sessionId, 's-half')
    })
  })

  // §7.148 (2026-10-29): §7.147 只补了「开始行」；同一次调用的**失败行**
  // （http_error / network_error / network_retry）走的是模块级 `audit()`
  // 辅助函数，绕开了 `this.audit` 的改动 —— 实测本仓 43 条 `llm.local.http_error`
  // / 22 条 `llm.local.network_error` / 4 条 `llm.local.network_retry`
  // **无一带** sessionId。
  //
  // 后果与开始行相同：失败行落全局桶 ⇒ Edge 面板看不到「哪一轮失败了」。
  // 开始行带、失败行不带 ⇒ 同一个调用两半归属不一致。
  describe('§7.148 — 失败行也带会话归属', () => {
    async function rowsFor(options: Record<string, unknown>, responder: (init: FetchInit) => Response): Promise<any[]> {
      installFetchMock(responder)
      const entries: any[] = []
      const auditLog = { log: async (e: any) => { entries.push(e) } }
      const adapter = new LocalLlmAdapterImpl(
        { providers: ['local-llm'], baseUrl: 'http://127.0.0.1:11434/v1', defaultModel: 'qwen3-4b' },
        auditLog as any,
      )
      try {
        for await (const _ of adapter.stream({
          provider: 'local-llm',
          model: 'qwen3-4b',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
          ...options,
        } as any)) { /* drain */ }
      } catch { /* 失败路径是本组的被测对象 */ }
      restoreFetch()
      return entries
    }

    const http500 = () => new Response('boom', { status: 500 })
    const abortError = () => { const e: any = new Error('aborted'); e.name = 'AbortError'; throw e }
    const plainError = () => { throw new Error('socket hang up') }

    it('HTTP 失败行带 sessionId', async () => {
      const rows = await rowsFor({ sessionId: 's-http' }, http500)
      const row = rows.find(e => e.kind === 'llm.local.http_error')
      assert.ok(row, 'llm.local.http_error 必须落盘')
      assert.equal(row.payload.sessionId, 's-http')
    })

    it('中止型网络失败行带 sessionId', async () => {
      const rows = await rowsFor({ sessionId: 's-net' }, abortError)
      const row = rows.find(e => e.kind === 'llm.local.network_error')
      assert.ok(row, 'llm.local.network_error 必须落盘')
      assert.equal(row.payload.sessionId, 's-net')
    })

    it('重试行带 sessionId', async () => {
      let call = 0
      const rows = await rowsFor({ sessionId: 's-retry' }, (init) => {
        call += 1
        if (call === 1) plainError()
        return sseResponse([
          { choices: [{ delta: { content: 'pong' }, finish_reason: null }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ])
      })
      const row = rows.find(e => e.kind === 'llm.local.network_retry')
      assert.ok(row, 'llm.local.network_retry 必须落盘')
      assert.equal(row.payload.sessionId, 's-retry')
    })

    it('没有会话 → 失败行**不带** sessionId 键（反向证伪：不能造假桶）', async () => {
      const rows = await rowsFor({}, http500)
      const row = rows.find(e => e.kind === 'llm.local.http_error')
      assert.ok(row, 'llm.local.http_error 必须落盘')
      assert.equal('sessionId' in row.payload, false)
    })

    it('哨兵 sessionId → 失败行**不带** sessionId 键（哨兵不是会话 id）', async () => {
      const rows = await rowsFor({ sessionId: '<pre-session>' }, http500)
      const row = rows.find(e => e.kind === 'llm.local.http_error')
      assert.ok(row, 'llm.local.http_error 必须落盘')
      assert.equal('sessionId' in row.payload, false)
    })
  })
})
