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
      providers: ['cloud-deepseek-v4'],
      baseUrl: 'https://api.example.test',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      defaultModel: 'deepseek-chat',
    })

    const chunks: unknown[] = []
    for await (const chunk of adapter.stream({
      provider: 'cloud-deepseek-v4',
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
      providers: ['cloud-deepseek-v4'],
      baseUrl: 'https://api.example.test',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      defaultModel: 'deepseek-chat',
    })

    for await (const _ of adapter.stream({
      provider: 'cloud-deepseek-v4',
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
      providers: ['cloud-deepseek-v4'],
      baseUrl: 'https://api.example.test',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      defaultModel: 'deepseek-chat',
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
      providers: ['cloud-deepseek-v4'],
      baseUrl: 'https://api.example.test',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      defaultModel: 'deepseek-v4-flash',
    })

    for await (const _ of adapter.stream({
      provider: 'cloud-deepseek-v4',
      model: '',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) {
      // drain
    }

    assert.ok(captured)
    assert.equal(captured!.bodyJson.model, 'deepseek-v4-flash')
  })
})