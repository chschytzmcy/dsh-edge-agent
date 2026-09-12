/**
 * M1 unit test: cloud-llm-adapter against a stubbed `fetch`.
 *
 * Stubs the global `fetch` with a hand-written OpenAI-compatible SSE
 * responder. Asserts the wire envelope sent upstream (URL, headers,
 * JSON body) and the StreamChunks the adapter yields downstream.
 *
 * Run via `pnpm test -t cloud-llm-adapter`.
 */

import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'vitest'

import { CloudLlmAdapterImpl } from '../../src/dsh-adapter/cloud-llm-adapter.ts'

type FetchInit = {
  url: string
  init: RequestInit
}

interface CapturedRequest extends FetchInit {
  bodyJson: Record<string, unknown>
}

const originalFetch = globalThis.fetch

let captured: CapturedRequest | undefined

function installFetchMock(responder: (init: FetchInit) => Response): void {
  captured = undefined
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : (input as Request).url
    const bodyText = typeof init.body === 'string' ? init.body : ''
    const req: FetchInit = { url, init }
    captured = { ...req, bodyJson: bodyText.length > 0 ? JSON.parse(bodyText) : {} }
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

describe('cloud-llm-adapter (M1)', () => {
  beforeEach(() => {
    process.env.DEEPSEEK_API_KEY = 'sk-m1-test'
  })

  afterEach(() => {
    delete process.env.DEEPSEEK_API_KEY
    captured = undefined
    restoreFetch()
  })

  it('reads DEEPSEEK_API_KEY and posts to the configured endpoint', async () => {
    installFetchMock(() => sseResponse([
      { choices: [{ delta: { content: 'hi' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]))

    const adapter = new CloudLlmAdapterImpl({
      providers: ['cloud-llm'],
      baseUrl: 'https://api.example.test',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      defaultModel: 'deepseek-chat',
    })

    const chunks: unknown[] = []
    for await (const chunk of adapter.stream({
      provider: 'cloud-llm',
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
    })) {
      chunks.push(chunk)
    }

    assert.ok(captured, 'fetch was called')
    assert.equal(captured!.url, 'https://api.example.test/chat/completions')
    assert.equal(captured!.init.method, 'POST')
    assert.match(
      (captured!.init.headers as Record<string, string>).authorization,
      /^Bearer sk-m1-test$/u,
    )
    assert.equal(captured!.bodyJson.model, 'deepseek-chat')
    assert.equal(captured!.bodyJson.stream, true)
    const wireMessages = captured!.bodyJson.messages as Array<Record<string, unknown>>
    assert.equal(wireMessages.length, 1)
    assert.equal(wireMessages[0]!.role, 'user')
    assert.equal(wireMessages[0]!.content, '你好')

    // block-start(text), text-delta, block-end(text), finish(stop)
    assert.equal(chunks.length, 4)
    const types = chunks.map((c) => (c as { type: string }).type)
    assert.deepEqual(types, ['block-start', 'text-delta', 'block-end', 'finish'])
  })

  it('threads the system slot as the first wire message', async () => {
    installFetchMock(() => sseResponse([
      { choices: [{ delta: { content: 'pong' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]))

    const adapter = new CloudLlmAdapterImpl({
      providers: ['cloud-llm'],
      baseUrl: 'https://api.example.test',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      defaultModel: 'deepseek-chat',
    })

    for await (const _ of adapter.stream({
      provider: 'cloud-llm',
      model: 'deepseek-chat',
      system: 'be terse',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    })) {
      // drain
    }

    assert.ok(captured)
    const wireMessages = captured!.bodyJson.messages as Array<Record<string, unknown>>
    assert.equal(wireMessages[0]!.role, 'system')
    assert.equal(wireMessages[0]!.content, 'be terse')
    assert.equal(wireMessages[1]!.role, 'user')
    assert.equal(wireMessages[1]!.content, 'ping')
  })

  it('throws MISSING_CREDENTIAL when the env slot is empty', async () => {
    delete process.env.DEEPSEEK_API_KEY
    installFetchMock(() => sseResponse([]))

    const adapter = new CloudLlmAdapterImpl({
      providers: ['cloud-llm'],
      baseUrl: 'https://api.example.test',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      defaultModel: 'deepseek-chat',
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
        assert.equal((error as { code?: string }).code, 'MISSING_CREDENTIAL')
        return true
      },
    )
  })

  it('falls back to the configured defaultModel when request omits one', async () => {
    installFetchMock(() => sseResponse([
      { choices: [{ delta: { content: 'ok' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]))

    const adapter = new CloudLlmAdapterImpl({
      providers: ['cloud-llm'],
      baseUrl: 'https://api.example.test',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      defaultModel: 'deepseek-v4-flash',
    })

    for await (const _ of adapter.stream({
      provider: 'cloud-llm',
      model: '',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) {
      // drain
    }

    assert.ok(captured)
    assert.equal(captured!.bodyJson.model, 'deepseek-v4-flash')
  })
})

describe('cloud-llm-adapter (M2 tool-calls)', () => {
  beforeEach(() => {
    process.env.DEEPSEEK_API_KEY = 'sk-m2-test'
  })

  afterEach(() => {
    delete process.env.DEEPSEEK_API_KEY
    captured = undefined
    restoreFetch()
  })

  it('forwards tools in the request body as function tools', async () => {
    installFetchMock(() => sseResponse([
      { choices: [{ delta: { content: 'no tool needed' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]))

    const adapter = new CloudLlmAdapterImpl({
      providers: ['cloud-llm'],
      baseUrl: 'https://api.example.test',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      defaultModel: 'deepseek-chat',
    })

    for await (const _ of adapter.stream({
      provider: 'cloud-llm',
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
      tools: [
        {
          name: 'local_file_read',
          description: 'read',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      ],
    })) {
      // drain
    }

    assert.ok(captured)
    const wireTools = captured!.bodyJson.tools as Array<Record<string, unknown>>
    assert.equal(wireTools.length, 1)
    assert.equal(wireTools[0]!.type, 'function')
    const fn = wireTools[0]!.function as Record<string, unknown>
    assert.equal(fn.name, 'local_file_read')
    assert.equal(fn.description, 'read')
  })

  it('emits tool-call-delta chunks and finish({kind: tool-calls})', async () => {
    installFetchMock(() => sseResponse([
      // First delta: opens the tool call with id + name.
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_abc', function: { name: 'local_file_read', arguments: '' } }] }, finish_reason: null }] },
      // Second delta: streams the arguments JSON.
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"/tmp/test.txt"}' } }] }, finish_reason: null }] },
      // Third frame: finish reason = tool_calls.
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]))

    const adapter = new CloudLlmAdapterImpl({
      providers: ['cloud-llm'],
      baseUrl: 'https://api.example.test',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      defaultModel: 'deepseek-chat',
    })

    const chunks: unknown[] = []
    for await (const chunk of adapter.stream({
      provider: 'cloud-llm',
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'read /tmp/test.txt' }] }],
      tools: [
        { name: 'local_file_read', description: 'r', parameters: {} },
      ],
    })) {
      chunks.push(chunk)
    }

    // Expected sequence (§7.34.2): 2× tool-call-delta → block-end(tool-call) → finish(tool-calls).
    // No block-start(text) — there's no text in this stream (lazy block-start, only emitted
    // before the first text-delta). Old behavior was ['block-start', 'tool-call-delta', ...]
    // which left an orphan text block in BlockAssembler when no text was ever streamed.
    const types = chunks.map((c) => (c as { type: string }).type)
    assert.deepEqual(types, ['tool-call-delta', 'tool-call-delta', 'block-end', 'finish'])

    const firstDelta = chunks[0] as { id: string; name?: string; argumentsDelta: string }
    assert.equal(firstDelta.id, 'call_abc')
    assert.equal(firstDelta.name, 'local_file_read')
    assert.equal(firstDelta.argumentsDelta, '')

    const secondDelta = chunks[1] as { argumentsDelta: string }
    assert.equal(secondDelta.argumentsDelta, '{"path":"/tmp/test.txt"}')

    const blockEnd = chunks[2] as { block: { type: string; id: string; name: string; arguments: string } }
    assert.equal(blockEnd.block.type, 'tool-call')
    assert.equal(blockEnd.block.id, 'call_abc')
    assert.equal(blockEnd.block.name, 'local_file_read')
    assert.equal(blockEnd.block.arguments, '{"path":"/tmp/test.txt"}')

    const finish = chunks[3] as { reason: { kind: string } }
    assert.equal(finish.reason.kind, 'tool-calls')
  })

  it('still emits a text block-end when the assistant mixed text and tool calls', async () => {
    installFetchMock(() => sseResponse([
      { choices: [{ delta: { content: 'let me check' }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_xyz', function: { name: 'local_calculate', arguments: '{"expr":"2+2"}' } }] }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]))

    const adapter = new CloudLlmAdapterImpl({
      providers: ['cloud-llm'],
      baseUrl: 'https://api.example.test',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      defaultModel: 'deepseek-chat',
    })

    const chunks: unknown[] = []
    for await (const chunk of adapter.stream({
      provider: 'cloud-llm',
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'compute 2+2' }] }],
      tools: [{ name: 'local_calculate', description: 'c', parameters: {} }],
    })) {
      chunks.push(chunk)
    }

    const blockEnds = chunks.filter((c) => (c as { type: string }).type === 'block-end') as Array<{ block: { type: string } }>
    assert.equal(blockEnds.length, 2)
    const kinds = blockEnds.map((b) => b.block.type).sort()
    assert.deepEqual(kinds, ['text', 'tool-call'])
  })

  // 2026-09-03 §7.34.2 regression: empty cloud stream must not orphan block-start.
  // Same root cause as local-llm-adapter. Even if DeepSeek returns finish=stop
  // with 0 content (e.g. upstream moderation / server filter), BlockAssembler
  // must not be left waiting for block-end.
  it('empty stream (finish=stop with no content) → no block-start, only finish (§7.34.2)', async () => {
    process.env.DEEPSEEK_API_KEY = 'sk-test-empty'
    installFetchMock(() => sseResponse([
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]))
    const adapter = new CloudLlmAdapterImpl({
      providers: ['cloud-llm'],
      baseUrl: 'https://api.deepseek.com',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      defaultModel: 'deepseek-chat',
    })

    const chunks: Array<{ type: string; [k: string]: unknown }> = []
    for await (const chunk of adapter.stream({
      provider: 'cloud-llm',
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) {
      chunks.push(chunk as { type: string })
    }
    delete process.env.DEEPSEEK_API_KEY

    const types = chunks.map((c) => c.type)
    assert.deepEqual(types, ['finish'])
    assert.equal((chunks[0] as { reason?: { kind: string } }).reason?.kind, 'stop')
    restoreFetch()
  })

  // §7.46.1 (2026-09-11): cloud-llm-adapter per-call info log
  // 让"TUI 路径调了哪个 cloud LLM / 多久 / 多少 token"在 ops log 里可见。
  // start 行 + done 行成对，配合 realm-skill-bridge pre-step / tool allow
  // 形成完整 trace。
  describe('per-call ops log (§7.46.1)', () => {
    it('emits LLM call start + done with sessionId, provider, model, duration', async () => {
      installFetchMock(() => sseResponse([
        { choices: [{ delta: { content: 'hi' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]))
      process.env.DEEPSEEK_API_KEY = 'sk-sec7461-test'
      const infoLines: string[] = []
      const fakeLogger = {
        info: (line: string) => infoLines.push(line),
        warn: () => {},
        error: () => {},
        debug: () => {},
      }
      const adapter = new CloudLlmAdapterImpl(
        {
          providers: ['cloud-llm'],
          baseUrl: 'https://api.example.test',
          apiKeyEnv: 'DEEPSEEK_API_KEY',
          defaultModel: 'deepseek-chat',
        },
        undefined,
        undefined,
        fakeLogger,
      )
      for await (const _ of adapter.stream({
        provider: 'cloud-llm',
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
        sessionId: 'sec7461-cloud',
      } as any)) {
        // drain
      }
      const start = infoLines.find((l) => l.includes('LLM call start'))
      const done = infoLines.find((l) => l.includes('LLM call done'))
      assert.ok(start, `expected LLM call start line, got: ${JSON.stringify(infoLines)}`)
      assert.ok(done, `expected LLM call done line, got: ${JSON.stringify(infoLines)}`)
      assert.ok(start!.includes('sessionId=sec7461-cloud'), 'start should include sessionId')
      assert.ok(start!.includes('provider=cloud-llm'), 'start should include provider')
      assert.ok(start!.includes('model=deepseek-chat'), 'start should include model')
      assert.ok(start!.includes('messageCount=1'), 'start should include messageCount')
      assert.ok(done!.includes('sessionId=sec7461-cloud'), 'done should include sessionId')
      assert.ok(done!.includes('provider=cloud-llm'), 'done should include provider')
      assert.ok(done!.includes('model=deepseek-chat'), 'done should include model')
      assert.match(done!, /durationMs=\d+/, 'done should include durationMs=N')
      assert.match(done!, /resultLen=\d+/, 'done should include resultLen=N')
      assert.ok(done!.includes('finishKind=stop'), 'done should include finishKind=stop')
      delete process.env.DEEPSEEK_API_KEY
      restoreFetch()
    })
  })
})