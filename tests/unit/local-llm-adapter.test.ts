/**
 * M4 unit tests — local-llm-adapter mock + real-mode dispatch.
 *
 * Mock-mode echo is fully exercised. Real-mode is exercised against a
 * stubbed `fetch` that returns the same SSE shape as the cloud tests;
 * the `local-qwen3-4b` route hits the real path, the `local-qwen3-4b-mock`
 * route never touches the network. Provider routing asserts the inner
 * adapter picked by route id.
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

describe('local-llm-adapter (M4)', () => {
  it('exports the canonical plugin shape', () => {
    assert.equal(localMod.name, 'local-llm-adapter')
    assert.deepEqual([...localMod.inject], ['llm'])
    assert.equal(typeof localMod.apply, 'function')
    assert.ok(localMod.Config)
  })

  it('mock mode echoes the last user message as [LOCAL-MOCK] {text}', async () => {
    const adapter = new LocalLlmAdapterImpl({
      providers: ['local-qwen3-4b-mock'],
      mode: 'mock',
      baseUrl: 'http://127.0.0.1:8080/v1',
      defaultModel: 'qwen3-4b',
    })

    const chunks: unknown[] = []
    for await (const chunk of adapter.stream({
      provider: 'local-qwen3-4b-mock',
      model: 'qwen3-4b',
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'be terse' }] },
        { role: 'user', content: [{ type: 'text', text: '你好' }] },
      ],
    })) {
      chunks.push(chunk)
    }

    const types = chunks.map((c) => (c as { type: string }).type)
    assert.deepEqual(types, ['block-start', 'text-delta', 'block-end', 'finish'])

    const text = (chunks[1] as { text: string }).text
    assert.equal(text, '[LOCAL-MOCK] 你好')

    const block = (chunks[2] as { block: { text: string } }).block
    assert.equal(block.text, '[LOCAL-MOCK] 你好')
  })

  it('mock mode falls back to "(no user text)" when the user slot is empty', async () => {
    const adapter = new LocalLlmAdapterImpl({
      providers: ['local-qwen3-4b-mock'],
      mode: 'mock',
      baseUrl: 'http://127.0.0.1:8080/v1',
      defaultModel: 'qwen3-4b',
    })

    const chunks: unknown[] = []
    for await (const chunk of adapter.stream({
      provider: 'local-qwen3-4b-mock',
      model: 'qwen3-4b',
      messages: [],
    })) {
      chunks.push(chunk)
    }
    const text = (chunks[1] as { text: string }).text
    assert.equal(text, '[LOCAL-MOCK] (no user text)')
  })

  it('mock mode never calls fetch', async () => {
    installFetchMock(() => sseResponse([]))
    const adapter = new LocalLlmAdapterImpl({
      providers: ['local-qwen3-4b-mock'],
      mode: 'mock',
      baseUrl: 'http://127.0.0.1:8080/v1',
      defaultModel: 'qwen3-4b',
    })
    for await (const _ of adapter.stream({
      provider: 'local-qwen3-4b-mock',
      model: 'qwen3-4b',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) {
      // drain
    }
    assert.equal(fetchCallCount, 0, 'mock path must not hit the network')
    restoreFetch()
  })

  it('real mode posts to {baseUrl}/chat/completions with the configured default model', async () => {
    installFetchMock(() => sseResponse([
      { choices: [{ delta: { content: 'pong' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]))

    const adapter = new LocalLlmAdapterImpl({
      providers: ['local-qwen3-4b'],
      mode: 'real',
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

  it('real mode omits the bearer header when no apiKeyEnv is configured', async () => {
    installFetchMock(() => sseResponse([
      { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
    ]))

    const adapter = new LocalLlmAdapterImpl({
      providers: ['local-qwen3-4b'],
      mode: 'real',
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

  it('real mode threads the apiKeyEnv bearer when configured', async () => {
    process.env.DSH_EDGE_LOCAL_LLM_KEY = 'sk-llm-test'
    installFetchMock(() => sseResponse([
      { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
    ]))

    const adapter = new LocalLlmAdapterImpl({
      providers: ['local-qwen3-4b'],
      mode: 'real',
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

  it('routes the right inner adapter by provider id when both are mounted', async () => {
    installFetchMock(() => sseResponse([
      { choices: [{ delta: { content: 'remote-reply' }, finish_reason: 'stop' }] },
    ]))

    const adapter = new LocalLlmAdapterImpl({
      providers: ['local-qwen3-4b-mock', 'local-qwen3-4b'],
      mode: 'real',
      baseUrl: 'http://192.168.66.195:8701/v1',
      defaultModel: 'qwen3-4b',
    })

    // Mock route must not hit the network.
    const mockChunks: unknown[] = []
    for await (const chunk of adapter.stream({
      provider: 'local-qwen3-4b-mock',
      model: 'qwen3-4b',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'echo' }] }],
    })) {
      mockChunks.push(chunk)
    }
    const mockText = (mockChunks[1] as { text: string }).text
    assert.equal(mockText, '[LOCAL-MOCK] echo')
    assert.equal(fetchCallCount, 0)

    // Real route must hit the network.
    const realChunks: unknown[] = []
    for await (const chunk of adapter.stream({
      provider: 'local-qwen3-4b',
      model: 'qwen3-4b',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'remote' }] }],
    })) {
      realChunks.push(chunk)
    }
    const realText = (realChunks[1] as { text: string }).text
    assert.equal(realText, 'remote-reply')
    assert.equal(fetchCallCount, 1)
    restoreFetch()
  })

  it('throws UNKNOWN_PROVIDER for routes the adapter does not own', async () => {
    installFetchMock(() => sseResponse([]))
    const adapter = new LocalLlmAdapterImpl({
      providers: ['local-qwen3-4b-mock'],
      mode: 'mock',
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
})
