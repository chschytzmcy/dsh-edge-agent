/**
 * §7.131 —— 出网那一刻真的裁了：cloud-llm-adapter 的 wire body 断言
 *
 * 纯函数层（`cloud-egress.test.ts`）钉死了分段判据；本文件钉死**接线**：
 * 消息进 adapter → 出网裁剪 + 脱敏 → 真正发出去的 wire body 里只剩云段历史。
 *
 * 主人裁决（2026-10-27）：
 * > 发给 cloudllm 的请求，只能携带之前所有的上 cloudllm 的历史；
 * > 而 localllm 需要携带所有的历史会话信息。
 */

import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'vitest'

import {
  CloudEgressGuard,
  CloudLlmAdapterImpl,
  CloudLlmDelegateAdapterImpl,
} from '../../src/dsh-adapter/cloud-llm-adapter.ts'

const originalFetch = globalThis.fetch
let captured: { url: string; bodyJson: Record<string, unknown> } | undefined

function installFetchMock(): void {
  captured = undefined
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url
    const bodyText = typeof init.body === 'string' ? init.body : ''
    captured = { url, bodyJson: bodyText.length > 0 ? JSON.parse(bodyText) : {} }
    const events = [
      { choices: [{ delta: { content: 'ok' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        for (const e of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    })
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch
}

/** 极简 sanitizer 桩：手机号 → 占位符。 */
function stubCtx(options: { withSanitizer?: boolean } = {}) {
  // §7.151: 可选服务只能走 ctx.get() 读 —— cordis 4.x 的 ctx 是 Proxy，直取
  // 一个没 provide、也没在 inject 声明里的属性会**抛错**。adapter 的 inject
  // 是 ['llm','auditLog','inputGuard']，没有 modelRouter ⇒ 只能这样拿。
  const modelRouter = {
    listDetailed: () => [
      { provider: 'local-llm', realm: 'LOCAL' },
      { provider: 'cloud-llm', realm: 'CLOUD' },
    ],
  }
  const ctx: Record<string, unknown> = {
    modelRouter,
    get: (name: string) => (name === 'modelRouter' ? modelRouter : undefined),
  }
  if (options.withSanitizer !== false) {
    ctx.sanitizer = {
      sanitize: async (text: string) => {
        const replacements: Array<Record<string, string>> = []
        const sanitizedText = text.replace(/\b1[3-9]\d{9}\b/g, (m) => {
          replacements.push({ original: m, placeholder: '[PHONE_1]', piiType: 'phone', dataClass: 'confidential' })
          return '[PHONE_1]'
        })
        return { sanitizedText, sessionId: 's1', replacements }
      },
      desanitize: async (text: string) => text,
    }
  }
  return ctx
}

function userMsg(text: string): Record<string, unknown> {
  return { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

function assistantMsg(provider: string, text: string): Record<string, unknown> {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    source: { kind: 'model', provider, model: 'm1' },
  }
}

/** wire body 里的 messages（OpenAI 形态）。 */
function wireTexts(body: Record<string, unknown>): string[] {
  const msgs = body.messages as Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>
  return msgs.map(m =>
    typeof m.content === 'string'
      ? m.content
      : (m.content ?? []).map(b => b.text ?? '').join(''),
  )
}

function makeAdapter(ctx: Record<string, unknown>, auditLog?: { log: (e: unknown) => Promise<unknown> }) {
  const guard = new CloudEgressGuard(ctx as never)
  return new CloudLlmAdapterImpl(
    {
      providers: ['cloud-llm'],
      baseUrl: 'https://api.example.test',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      defaultModel: 'deepseek-chat',
    },
    auditLog as never,
    undefined,
    undefined,
    guard,
  )
}

async function drain(adapter: CloudLlmAdapterImpl, messages: unknown[]): Promise<void> {
  for await (const _ of adapter.stream({
    provider: 'cloud-llm',
    model: 'deepseek-chat',
    sessionId: 's1',
    messages: messages as never,
  } as never)) { /* drain */ }
}

describe('§7.131 — cloud-llm-adapter 出网裁剪', () => {
  afterEach(() => {
    delete process.env.DEEPSEEK_API_KEY
    captured = undefined
    restoreFetch()
  })

  it('本地段历史不出现在 wire body 里', async () => {
    process.env.DEEPSEEK_API_KEY = 'sk-test'
    installFetchMock()
    const adapter = makeAdapter(stubCtx())
    await drain(adapter, [
      userMsg('本地轮的用户输入'),
      assistantMsg('local-llm', '本地模型的回答'),
      userMsg('本轮用户输入'),
    ])
    assert.ok(captured, '必须有出网请求')
    const texts = wireTexts(captured!.bodyJson)
    assert.ok(!texts.some(t => t.includes('本地轮')), `本地历史泄漏: ${JSON.stringify(texts)}`)
    assert.ok(!texts.some(t => t.includes('本地模型')), `本地历史泄漏: ${JSON.stringify(texts)}`)
    assert.ok(texts.some(t => t.includes('本轮用户输入')), `本轮内容必须带上: ${JSON.stringify(texts)}`)
  })

  it('之前上过云的历史保留在 wire body 里', async () => {
    process.env.DEEPSEEK_API_KEY = 'sk-test'
    installFetchMock()
    const adapter = makeAdapter(stubCtx())
    await drain(adapter, [
      userMsg('云轮输入'),
      assistantMsg('cloud-llm', '云轮回答'),
      userMsg('本轮用户输入'),
    ])
    const texts = wireTexts(captured!.bodyJson)
    assert.ok(texts.some(t => t.includes('云轮输入')), `云段历史必须保留: ${JSON.stringify(texts)}`)
    assert.ok(texts.some(t => t.includes('云轮回答')), `云段历史必须保留: ${JSON.stringify(texts)}`)
  })

  it('本轮内容里的 PII 被脱敏后才出网', async () => {
    process.env.DEEPSEEK_API_KEY = 'sk-test'
    installFetchMock()
    const adapter = makeAdapter(stubCtx())
    await drain(adapter, [
      userMsg('本地轮输入'),
      assistantMsg('local-llm', '本地回答'),
      userMsg('我的手机号是 13800138000'),
    ])
    const texts = wireTexts(captured!.bodyJson)
    assert.ok(!texts.some(t => t.includes('13800138000')), `明文 PII 出网: ${JSON.stringify(texts)}`)
    assert.ok(texts.some(t => t.includes('[PHONE_1]')), `应当脱敏: ${JSON.stringify(texts)}`)
  })

  it('裁剪与脱敏都记进审计（operator 能 grep 到）', async () => {
    process.env.DEEPSEEK_API_KEY = 'sk-test'
    installFetchMock()
    const entries: Array<{ kind: string; payload: Record<string, unknown> }> = []
    const auditLog = { log: async (e: unknown) => { entries.push(e as never) } }
    const adapter = makeAdapter(stubCtx(), auditLog)
    await drain(adapter, [
      userMsg('本地轮输入'),
      assistantMsg('local-llm', '本地回答'),
      userMsg('本轮输入 手机号 13800138000'),
    ])
    const egress = entries.find(e => e.kind === 'llm.cloud.egress')
    assert.ok(egress, `必须有 llm.cloud.egress 审计行: ${entries.map(e => e.kind).join(',')}`)
    assert.equal(egress!.payload.droppedLocalHistory, 2)
    assert.equal(egress!.payload.sanitized, true)
    assert.ok((egress!.payload.replacements as number) > 0, '应记录脱敏替换次数')
  })

  it('没有 sanitizer 时：仍然裁剪本地段，但如实记录未脱敏', async () => {
    process.env.DEEPSEEK_API_KEY = 'sk-test'
    installFetchMock()
    const entries: Array<{ kind: string; payload: Record<string, unknown> }> = []
    const auditLog = { log: async (e: unknown) => { entries.push(e as never) } }
    const adapter = makeAdapter(stubCtx({ withSanitizer: false }), auditLog)
    await drain(adapter, [
      userMsg('本地轮输入'),
      assistantMsg('local-llm', '本地回答'),
      userMsg('本轮输入'),
    ])
    const texts = wireTexts(captured!.bodyJson)
    assert.ok(!texts.some(t => t.includes('本地轮')), `本地历史泄漏: ${JSON.stringify(texts)}`)
    const egress = entries.find(e => e.kind === 'llm.cloud.egress')
    assert.ok(egress, '必须有 llm.cloud.egress 审计行')
    assert.equal(egress!.payload.sanitized, false)
    assert.equal(egress!.payload.droppedLocalHistory, 2)
  })
})

describe('§7.131 — DELEGATE 路径同样裁剪（当前部署走的就是这条）', () => {
  afterEach(() => {
    delete process.env.DEEPSEEK_API_KEY
    captured = undefined
    restoreFetch()
  })

  function mkDelegateCtx(): { ctx: Record<string, unknown>; forwarded: Array<{ messages: unknown[] }> } {
    const forwarded: Array<{ messages: unknown[] }> = []
    const llm = {
      listProviders: () => [{ id: 'qwen-token-plan-cn', name: 'qwen-token-plan-cn' }],
      listModels: async () => [{ provider: 'qwen-token-plan-cn', id: 'deepseek-v4-flash-0731', name: 'x' }],
      resolveModelInfo: async () => ({ provider: 'x', id: 'x', name: 'x', context: { contextWindow: 32768 } }),
      stream(options: { messages: unknown[] }) {
        forwarded.push({ messages: options.messages })
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: 'ok' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    }
    const ctx = stubCtx()
    ctx.llm = llm
    return { ctx, forwarded }
  }

  function makeDelegate(ctx: Record<string, unknown>, auditLog?: { log: (e: unknown) => Promise<unknown> }) {
    const guard = new CloudEgressGuard(ctx as never)
    const accessors = {
      llm: (ctx as { llm: unknown }).llm as never,
      getAgentDefaultModel: () => undefined,
    }
    return new CloudLlmDelegateAdapterImpl(
      {
        providers: ['cloud-llm'],
        baseUrl: '',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        defaultModel: 'deepseek-chat',
        delegateProvider: 'qwen-token-plan-cn',
        delegateEnabled: true,
      } as never,
      accessors,
      auditLog as never,
      undefined,
      undefined,
      guard,
    )
  }

  it('转发给宿主的云模型时，本地段历史已被裁掉', async () => {
    process.env.DEEPSEEK_API_KEY = 'sk-test'
    const { ctx, forwarded } = mkDelegateCtx()
    const adapter = makeDelegate(ctx)
    for await (const _ of adapter.stream({
      provider: 'cloud-llm',
      model: 'deepseek-chat',
      sessionId: 's1',
      messages: [
        userMsg('本地轮输入'),
        assistantMsg('local-llm', '本地回答'),
        userMsg('本轮输入'),
      ] as never,
    } as never)) { /* drain */ }

    assert.equal(forwarded.length, 1, '应当转发一次')
    const texts = forwarded[0]!.messages.map((m: { content: Array<{ text?: string }> }) =>
      (m.content ?? []).map(b => b.text ?? '').join(''),
    )
    assert.ok(!texts.some(t => t.includes('本地轮')), `本地历史泄漏: ${JSON.stringify(texts)}`)
    assert.ok(!texts.some(t => t.includes('本地回答')), `本地历史泄漏: ${JSON.stringify(texts)}`)
    assert.ok(texts.some(t => t.includes('本轮输入')), `本轮内容必须带上: ${JSON.stringify(texts)}`)
  })

  it('delegate 路径也脱敏本轮内容', async () => {
    process.env.DEEPSEEK_API_KEY = 'sk-test'
    const { ctx, forwarded } = mkDelegateCtx()
    const adapter = makeDelegate(ctx)
    for await (const _ of adapter.stream({
      provider: 'cloud-llm',
      model: 'deepseek-chat',
      sessionId: 's1',
      messages: [userMsg('我的手机号是 13800138000')] as never,
    } as never)) { /* drain */ }

    const texts = forwarded[0]!.messages.map((m: { content: Array<{ text?: string }> }) =>
      (m.content ?? []).map(b => b.text ?? '').join(''),
    )
    assert.ok(!texts.some(t => t.includes('13800138000')), `明文 PII 出网: ${JSON.stringify(texts)}`)
    assert.ok(texts.some(t => t.includes('[PHONE_1]')), `应当脱敏: ${JSON.stringify(texts)}`)
  })
})
