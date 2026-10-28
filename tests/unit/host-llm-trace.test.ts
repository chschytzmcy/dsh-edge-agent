/**
 * §7.144 契约测试 —— 宿主 provider 那一跳的 trace。
 *
 * 主人在 Edge 面板发现「本轮走云端了，但 LLM 调用里没有云端模型」。根因是
 * `llm.cloud` 走 delegate 模式：请求由**宿主 provider** 发出，不经过本项目
 * 任何 adapter ⇒ adapter 记不到 ⇒ 面板里云端模型整条缺失。
 *
 * 这里钉住三条契约：
 *
 *   1. **记到**：边缘会话里宿主 provider 的调用，REQ / RESP 都进审计索引行，
 *      且共用一个 callId（面板上仍是「上请求、下响应」成对）。
 *   2. **不重记**：本项目自管池（local-llm / cloud-llm）的调用由 adapter 自己
 *      记，这里必须跳过 —— 否则同一通调用出现两条。
 *   3. **不越界**：标准模式会话（没有 pre-step 的 stepState）一条 edge 事件
 *      都不产生（§7.140 的不变式）。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

import {
  HostCallRecorder,
  HostResponseAccumulator,
  buildHostRequestTrace,
  buildHostResponseTrace,
  isOwnPoolProvider,
  OWN_POOL_PROVIDERS,
} from '../../src/dsh-adapter/host-llm-trace.ts'
import { DEFAULT_LLM_TRACE_CONFIG } from '../../src/dsh-adapter/llm-trace.ts'
import { InputGuardServiceImpl } from '../../src/dsh-adapter/input-guard.ts'
import type { Config } from '../../src/dsh-adapter/input-guard.ts'

// ── helpers ─────────────────────────────────────────────────────────────────

function fakeCtx() {
  return {
    reflect: { provide(_n: string, _v: unknown) { return () => {} } },
    provide(_n: string, _v: unknown) { return () => {} },
  }
}

function defaultConfig(overrides: Partial<Config> = {}): Config {
  return {
    enableInputGuard: true,
    sanitizeLocalTraffic: false,
    rejectOnPolicyViolation: true,
    downgradeOnSanitizeFailure: true,
    localProvider: 'local-llm',
    localModel: 'qwen3-4b-instruct-2507',
    cloudApiKeyEnv: 'DEEPSEEK_API_KEY',
    defaultCloudProvider: 'cloud-llm',
    defaultCloudModel: 'deepseek-chat',
    ...overrides,
  }
}

function fakeAuditLog() {
  const entries: any[] = []
  return {
    entries,
    api: { async log(entry: any) { entries.push(entry) } },
  }
}

function fakeIntentRouter(category = 'CLOUD') {
  return {
    api: {
      async classify(_text: string) {
        return { category, confidence: 0.9, rationale: 'test' }
      },
    },
  }
}

function fakeSanitizer(replacements = 0) {
  return {
    api: {
      async sanitize(text: string) {
        return {
          sanitized: text,
          replacements: Array.from({ length: replacements }, (_, i) => ({
            original: 'x', placeholder: `[PII_${i + 1}]`, piiType: 'email',
          })),
        }
      },
      async desanitize(text: string) { return text },
    },
  }
}

function makePreStepPayload(userText: string, sessionId = 'sess-1') {
  return {
    agent: { id: 'a1', session: { id: sessionId } as any },
    messages: [
      { role: 'system', content: 'You are edge-agent' },
      { role: 'user', content: userText },
    ],
    step: 1,
  }
}

function makeNext(messages: ReadonlyArray<Record<string, unknown>>) {
  return async () => ({ kind: 'enter', messages: [...messages] })
}

function streamFrom<T>(items: T[]): AsyncIterable<T> {
  return (async function* () { for (const x of items) yield x })()
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of stream) out.push(x)
  return out
}

/** 收集审计里的 llm.trace.index 行。 */
function traceIndexRows(entries: any[]): any[] {
  return entries.filter(e => e.kind === 'llm.trace.index')
}

// ── 纯函数 ─────────────────────────────────────────────────────────────────

describe('isOwnPoolProvider', () => {
  it('认得本项目自管的两个池', () => {
    assert.equal(isOwnPoolProvider('local-llm'), true)
    assert.equal(isOwnPoolProvider('cloud-llm'), true)
  })

  it('宿主 provider 不是自管池', () => {
    assert.equal(isOwnPoolProvider('qwen-token-plan-cn'), false)
    assert.equal(isOwnPoolProvider('deepseek-official'), false)
  })

  it('空 provider 不算自管池（宁可多记也不漏记）', () => {
    assert.equal(isOwnPoolProvider(''), false)
  })

  it('自管池名单是这两个', () => {
    assert.deepEqual([...OWN_POOL_PROVIDERS], ['local-llm', 'cloud-llm'])
  })
})

describe('buildHostRequestTrace', () => {
  it('body 快照带 provider/model/messages/tools', () => {
    const trace = buildHostRequestTrace({
      request: {
        provider: 'qwen-token-plan-cn',
        model: 'deepseek-v4.1-flash',
        sessionId: 'sess-1',
        messages: [{ role: 'user', content: '查一下今天的新闻' }],
        tools: [{ name: 'read' }, { name: 'grep' }],
      },
      config: DEFAULT_LLM_TRACE_CONFIG,
    })
    assert.equal(trace.provider, 'qwen-token-plan-cn')
    assert.equal(trace.model, 'deepseek-v4.1-flash')
    assert.equal(trace.messageCount, 1)
    assert.deepEqual(trace.tools, ['read', 'grep'])
    assert.ok(trace.body, 'body 快照必须存在')
    assert.equal(trace.body?.truncated, false)
    const body = trace.body?.text ?? ''
    assert.ok(body.includes('qwen-token-plan-cn'), 'body 里要有 provider')
    assert.ok(body.includes('查一下今天的新闻'), 'body 里要有消息正文')
    assert.ok(body.includes('"tools"'), 'body 里要有工具表')
  })

  it('body 走脱敏（凭据不出 trace）', () => {
    const trace = buildHostRequestTrace({
      request: {
        provider: 'qwen-token-plan-cn',
        model: 'deepseek-v4.1-flash',
        sessionId: 'sess-1',
        messages: [{ role: 'user', content: '用 apiKey=sk-cp-abcdef0123456789 调一下' }],
      },
      config: DEFAULT_LLM_TRACE_CONFIG,
    })
    const body = trace.body?.text ?? ''
    assert.ok(!body.includes('sk-cp-abcdef0123456789'), '明文密钥不得进 body')
    assert.ok(body.includes('[REDACTED]'), '密钥应被掩码')
  })
})

describe('HostResponseAccumulator', () => {
  it('text-delta 逐段累积', () => {
    const acc = new HostResponseAccumulator()
    acc.push({ type: 'text-delta', index: 0, text: '你好' })
    acc.push({ type: 'text-delta', index: 0, text: '世界' })
    assert.equal(acc.snapshot().content, '你好世界')
  })

  it('block-end 的整块正文覆盖 delta 累积值', () => {
    const acc = new HostResponseAccumulator()
    acc.push({ type: 'text-delta', index: 0, text: '你好' })
    acc.push({ type: 'block-end', index: 0, block: { type: 'text', text: '你好世界' } })
    assert.equal(acc.snapshot().content, '你好世界')
  })

  it('tool-call-delta 累积成工具调用', () => {
    const acc = new HostResponseAccumulator()
    acc.push({ type: 'tool-call-delta', index: 0, id: 'call-1', name: 'read', argumentsDelta: '{"path":' })
    acc.push({ type: 'tool-call-delta', index: 0, id: 'call-1', name: 'read', argumentsDelta: '"a.txt"}' })
    const calls = acc.snapshot().toolCalls
    assert.equal(calls.length, 1)
    assert.equal(calls[0].name, 'read')
    assert.equal(calls[0].id, 'call-1')
    assert.equal(calls[0].arguments, '{"path":"a.txt"}')
  })

  it('usage 与 finish reason 进快照', () => {
    const acc = new HostResponseAccumulator()
    acc.push({ type: 'usage', usage: { inputTokens: 195, outputTokens: 42 } })
    acc.push({ type: 'finish', reason: 'stop' })
    const snap = acc.snapshot()
    assert.equal(snap.usage?.promptTokens, 195)
    assert.equal(snap.usage?.completionTokens, 42)
    assert.equal(snap.usage?.totalTokens, 237)
    assert.equal(snap.finishReason, 'stop')
  })

  it('finish reason 是宿主对象时取 kind，不 stringify 成 {"kind":"stop"}', () => {
    // 宿主 FinishReason 是对象（FinishReasonMap: { kind: 'stop' } 等），
    // 直接 stringify 会在面板上显示成 {"kind":"stop"}。
    const acc = new HostResponseAccumulator()
    acc.push({ type: 'finish', reason: { kind: 'tool-calls' } })
    assert.equal(acc.snapshot().finishReason, 'tool-calls')

    const acc2 = new HostResponseAccumulator()
    acc2.push({ type: 'finish', reason: { kind: 'error', failure: { message: 'boom' } } })
    assert.equal(acc2.snapshot().finishReason, 'error')

    // 没有 kind 的对象 ⇒ 回落到 stringify（不能丢信息，也不能抛）
    const acc3 = new HostResponseAccumulator()
    acc3.push({ type: 'finish', reason: { weird: 1 } })
    assert.equal(acc3.snapshot().finishReason, '{"weird":1}')
  })

  it('畸形 chunk 不抛', () => {
    const acc = new HostResponseAccumulator()
    acc.push(null)
    acc.push(undefined)
    acc.push('nonsense')
    acc.push({ type: 'text-delta' })
    assert.equal(acc.snapshot().content, '')
  })
})

describe('buildHostResponseTrace', () => {
  it('正文 + 工具调用 + usage + finish 都进 trace', () => {
    const trace = buildHostResponseTrace({
      sessionId: 'sess-1',
      provider: 'qwen-token-plan-cn',
      model: 'deepseek-v4.1-flash',
      snapshot: {
        content: '今天有雨',
        toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }],
        finishReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
      durationMs: 1234,
      config: DEFAULT_LLM_TRACE_CONFIG,
    })
    assert.equal(trace.content?.text, '今天有雨')
    assert.equal(trace.toolCalls.length, 1)
    assert.equal(trace.finishReason, 'stop')
    assert.equal(trace.usage?.totalTokens, 15)
    assert.equal(trace.durationMs, 1234)
    assert.ok(trace.body, '响应也应有 body 快照')
    assert.ok((trace.body?.text ?? '').includes('今天有雨'))
  })
})

describe('HostCallRecorder', () => {
  it('构造即记 REQ，流结束记 RESP，两者共用一个 callId', async () => {
    const rows: any[] = []
    const sink = {
      log: async (entry: any) => { rows.push(entry) },
      store: { put: () => {} },
    }
    const request = {
      provider: 'qwen-token-plan-cn',
      model: 'deepseek-v4.1-flash',
      sessionId: 'sess-1',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'read' }],
    }
    const recorder = new HostCallRecorder({
      sink,
      config: DEFAULT_LLM_TRACE_CONFIG,
      request,
      callId: 'c42',
    })
    const out = await collect(recorder.wrap(streamFrom([
      { type: 'text-delta', index: 0, text: 'yo' },
      { type: 'finish', reason: 'stop' },
    ])))
    assert.deepEqual(out, [
      { type: 'text-delta', index: 0, text: 'yo' },
      { type: 'finish', reason: 'stop' },
    ])
    const idx = rows.filter(r => r.kind === 'llm.trace.index')
    assert.equal(idx.length, 2, 'REQ + RESP 各一条索引行')
    assert.equal(idx[0].payload.kind, 'REQ')
    assert.equal(idx[1].payload.kind, 'RESP')
    assert.equal(idx[0].payload.callId, 'c42')
    assert.equal(idx[1].payload.callId, 'c42')
    assert.equal(idx[0].payload.provider, 'qwen-token-plan-cn')
    assert.equal(idx[0].payload.toolCount, 1)
  })
})

// ── 接线（input-guard 的 llm/stream 钩子）──────────────────────────────────

describe('§7.144 接线：宿主 provider 的调用进面板', () => {
  it('边缘会话 + 宿主 provider ⇒ REQ/RESP 都记', async () => {
    const audit = fakeAuditLog()
    const svc = new InputGuardServiceImpl(
      fakeCtx() as any, defaultConfig(),
      undefined, undefined, fakeIntentRouter('CLOUD').api as any, fakeSanitizer(0).api as any, audit.api as any,
    )
    const payload = makePreStepPayload('查一下今天的新闻')
    await svc.handlePreStep(payload as any, makeNext(payload.messages))

    const chunks = [
      { type: 'text-delta', index: 0, text: '今天有雨' },
      { type: 'finish', reason: 'stop' },
    ]
    await collect(svc.handleLlmStream({
      sessionId: 'sess-1',
      provider: 'qwen-token-plan-cn',
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: '查一下今天的新闻' }],
      tools: [{ name: 'read' }],
    } as any, () => streamFrom(chunks)))

    const rows = traceIndexRows(audit.entries)
    assert.equal(rows.length, 2, 'REQ + RESP 各一条')
    assert.equal(rows[0].payload.provider, 'qwen-token-plan-cn')
    assert.equal(rows[0].payload.model, 'deepseek-v4.1-flash')
    assert.equal(rows[0].payload.kind, 'REQ')
    assert.equal(rows[1].payload.kind, 'RESP')
    // 面板配对：两半共用一个 callId
    assert.ok(rows[0].payload.callId, '索引行必须带 callId')
    assert.equal(rows[0].payload.callId, rows[1].payload.callId)
  })

  it('自管池（local-llm）不重复记 —— adapter 自己记过', async () => {
    const audit = fakeAuditLog()
    const svc = new InputGuardServiceImpl(
      fakeCtx() as any, defaultConfig(),
      undefined, undefined, fakeIntentRouter('LOCAL').api as any, fakeSanitizer(0).api as any, audit.api as any,
    )
    const payload = makePreStepPayload('本地操作')
    await svc.handlePreStep(payload as any, makeNext(payload.messages))

    await collect(svc.handleLlmStream({
      sessionId: 'sess-1',
      provider: 'local-llm',
      model: 'MiniMax-M3.1-Flash',
      messages: [{ role: 'user', content: '本地操作' }],
    } as any, () => streamFrom([{ type: 'text-delta', index: 0, text: 'ok' }])))

    assert.equal(traceIndexRows(audit.entries).length, 0, '自管池不得被重复记录')
  })

  it('标准模式会话（无 stepState）零 edge 事件', async () => {
    const audit = fakeAuditLog()
    const svc = new InputGuardServiceImpl(
      fakeCtx() as any, defaultConfig(),
      undefined, undefined, undefined, fakeSanitizer(0).api as any, audit.api as any,
    )
    // 刻意不跑 handlePreStep —— 标准模式会话就是这种状态
    await collect(svc.handleLlmStream({
      sessionId: 'std-session',
      provider: 'qwen-token-plan-cn',
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: 'hi' }],
    } as any, () => streamFrom([{ type: 'text-delta', index: 0, text: 'ok' }])))

    assert.equal(audit.entries.length, 0, '标准模式会话不得产生任何 edge 审计事件')
  })

  it('宿主内部用途（purpose 非空）不记 —— 面板不添噪音', async () => {
    const audit = fakeAuditLog()
    const svc = new InputGuardServiceImpl(
      fakeCtx() as any, defaultConfig(),
      undefined, undefined, fakeIntentRouter('CLOUD').api as any, fakeSanitizer(0).api as any, audit.api as any,
    )
    const payload = makePreStepPayload('压缩一下上下文')
    await svc.handlePreStep(payload as any, makeNext(payload.messages))

    await collect(svc.handleLlmStream({
      sessionId: 'sess-1',
      provider: 'qwen-token-plan-cn',
      model: 'deepseek-v4.1-flash',
      purpose: 'compaction',
      messages: [{ role: 'user', content: '...' }],
    } as any, () => streamFrom([{ type: 'text-delta', index: 0, text: 'ok' }])))

    assert.equal(traceIndexRows(audit.entries).length, 0, 'purpose 调用不得进面板')
  })
})
