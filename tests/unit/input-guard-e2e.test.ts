/**
 * input-guard end-to-end integration tests — verifies that handlePreStep →
 * handleAgentRequest → handleLlmStream chain works correctly together.
 *
 * Tests the full per-turn pipeline (no real agent-loop), covering:
 *
 *   1. PII round-trip: text → sanitize (pre-step) → agent → desanitize (stream)
 *   2. Multiple PII types (phone + email) in one message
 *   3. Deduplication: same PII across turns maps to same placeholder
 *   4. Sanitize fails → downgrade state set → handleAgentRequest rewrites route
 *   5. Sanitize fails + downgradeOnSanitizeFailure=false → reject
 *   6. Stream chunks: placeholder split across chunks gets desanitized
 *   7. Stream chunks: no sanitization state → chunks pass through
 *   8. Multi-turn: each turn's sanitization is independent
 *   9. Audit trail: failures land at security level, success at info
 *
 * 设计原则：单插件集成测试，不引入真实 agent-loop。每个 handler 直接
 * 串联，模拟 sessionId 在 pre-step / agent/request / stream 之间的传递。
 *
 * @module tests/unit/input-guard-e2e
 */

import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

import { InputGuardServiceImpl } from '../../src/dsh-adapter/input-guard.ts'
import type { Config } from '../../src/dsh-adapter/input-guard.ts'

// ── helpers ─────────────────────────────────────────────────────────────────

function fakeCtx() {
  return {
    reflect: { provide(_n: string, _v: unknown) { return () => {} } },
    provide(_n: string, _v: unknown) { return () => {} },
  }
}

/** 真实感的 sanitizer：维护 sessionId → Map<original, placeholder> 映射。*/
function makeFakeSanitizer(opts: {
  throwOnSanitize?: boolean
  throwOnDesanitize?: boolean
} = {}) {
  const mappings = new Map<string, Map<string, string>>()
  const sanitizeCalls: Array<{ text: string; sessionId: string }> = []
  const desanitizeCalls: Array<{ text: string; sessionId: string }> = []

  function placeholderFor(sessionId: string, original: string, kind: string): string {
    let m = mappings.get(sessionId)
    if (!m) { m = new Map(); mappings.set(sessionId, m) }
    const existing = m.get(original)
    if (existing) return existing
    const count = Array.from(m.values()).filter(v => v.startsWith(`[${kind}_`)).length + 1
    const ph = `[${kind}_${count}]`
    m.set(original, ph)
    return ph
  }

  return {
    mappings,
    sanitizeCalls,
    desanitizeCalls,
    api: {
      async sanitize(text: string, ctx?: { sessionId?: string }) {
        const sid = ctx?.sessionId ?? 'default'
        sanitizeCalls.push({ text, sessionId: sid })
        if (opts.throwOnSanitize) throw new Error('sanitize-boom')
        let out = text
        const replacements: Array<{ type: string; original: string; token: string }> = []
        // Phone (CN): 1[3-9]\d{9}
        for (const m of text.matchAll(/(1[3-9]\d{9})/gu)) {
          const ph = placeholderFor(sid, m[1], 'PHONE')
          out = out.replace(m[1], ph)
          replacements.push({ type: 'phone', original: m[1], token: ph })
        }
        // Email
        for (const m of text.matchAll(/([\w.-]+@[\w.-]+\.\w+)/gu)) {
          const ph = placeholderFor(sid, m[1], 'EMAIL')
          out = out.replace(m[1], ph)
          replacements.push({ type: 'email', original: m[1], token: ph })
        }
        return { sanitizedText: out, sessionId: sid, replacements }
      },
      async desanitize(text: string, sessionId: string) {
        desanitizeCalls.push({ text, sessionId })
        if (opts.throwOnDesanitize) throw new Error('desanitize-boom')
        const m = mappings.get(sessionId)
        if (!m) return text
        let out = text
        for (const [original, placeholder] of m) {
          out = out.split(placeholder).join(original)
        }
        return out
      },
    },
  }
}

function fakeAuditLog() {
  const entries: Array<{ level: string; kind: string; payload: any }> = []
  return {
    entries,
    api: {
      async log(entry: { level: string; kind: string; payload: any }) {
        entries.push({ level: entry.level, kind: entry.kind, payload: entry.payload })
      },
    },
  }
}

function defaultConfig(overrides: Partial<Config> = {}): Config {
  return {
    enableInputGuard: true,
    sanitizeLocalTraffic: false,
    rejectOnPolicyViolation: true,
    downgradeOnSanitizeFailure: true,
    localProvider: 'local-qwen3-4b',
    localModel: 'qwen3-4b-instruct-2507',
    ...overrides,
  }
}

function makePayload(text: string, sessionId: string, edgeRoute?: { realm: string; category: string; provider: string; model: string }) {
  return {
    agent: {
      id: 'a1',
      session: { id: sessionId },
      ...(edgeRoute ? { _edgeRoute: edgeRoute } : {}),
    },
    messages: [
      { role: 'system', content: 'You are edge-agent' },
      { role: 'user', content: text },
    ],
    step: 1,
  }
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of stream) out.push(x)
  return out
}

function streamFrom<T>(items: T[]): AsyncIterable<T> {
  async function* gen() { for (const x of items) yield x }
  return gen()
}

// Note: do not make streamFrom async — the handler expects () => AsyncIterable<T>,
// not () => Promise<AsyncIterable<T>>. Calling an async function would yield a
// Promise and break `for await` iteration.

// ── tests ───────────────────────────────────────────────────────────────────

describe('input-guard E2E — PII round-trip', () => {
  it('sanitize → desanitize round-trip: phone PII', async () => {
    const san = makeFakeSanitizer()
    const audit = fakeAuditLog()
    const svc = new InputGuardServiceImpl(
      fakeCtx() as any, defaultConfig(),
      undefined, undefined, undefined, san.api as any, audit.api as any,
    )
    const sessionId = 'e2e-1'
    const payload = makePayload('我的手机号是13812345678', sessionId, {
      realm: 'CLOUD', category: 'CLOUD',
      provider: 'cloud-deepseek-v4', model: 'deepseek-chat',
    })

    // 1. pre-step: sanitize + record state
    const preStepDecision = await svc.handlePreStep(
      payload as any,
      async () => ({ kind: 'enter', messages: [...payload.messages] }),
    )
    assert.equal(preStepDecision.kind, 'enter')
    const sentMessages = preStepDecision.messages ?? payload.messages
    const sentText = (sentMessages[1] as any).content
    assert.equal(sentText, '我的手机号是[PHONE_1]', 'LLM 应看到占位符')
    assert.ok(!sentText.includes('13812345678'), '原文 PII 不可达 LLM')

    // 2. simulate agent: LLM 在响应里也用占位符
    const llmResponseText = '您的手机号是[PHONE_1]'

    // 3. llm/stream: desanitize chunks
    const chunks = [
      { type: 'text-delta', text: '您的手机号是[PHONE_1]' },
      { type: 'block-end', block: { type: 'text', text: llmResponseText } },
      { type: 'done', done: true },
    ]
    const desanitized = await collect(
      svc.handleLlmStream({ sessionId }, () => streamFrom(chunks)),
    )
    const textDelta = desanitized.find(c => c.type === 'text-delta') as any
    const blockEnd = desanitized.find(c => c.type === 'block-end') as any
    assert.equal(textDelta.text, '您的手机号是13812345678', 'user 应看到原文 PII')
    assert.equal(blockEnd.block.text, '您的手机号是13812345678', 'block-end 也应 desanitize')

    // 4. audit: input-guard.sanitized 触发
    const sanitizedAudit = audit.entries.find(e => e.kind === 'input-guard.sanitized')
    assert.ok(sanitizedAudit)
    assert.equal(sanitizedAudit?.level, 'info')
    assert.equal(sanitizedAudit?.payload?.replacementCount, 1)
  })

  it('multiple PII types in one message: phone + email', async () => {
    const san = makeFakeSanitizer()
    const svc = new InputGuardServiceImpl(
      fakeCtx() as any, defaultConfig(),
      undefined, undefined, undefined, san.api as any,
    )
    const payload = makePayload('手机 13812345678 邮箱 alice@example.com', 'e2e-2', {
      realm: 'CLOUD', category: 'CLOUD',
      provider: 'cloud-deepseek-v4', model: 'deepseek-chat',
    })
    const decision = await svc.handlePreStep(
      payload as any,
      async () => ({ kind: 'enter', messages: [...payload.messages] }),
    )
    const sentText = (decision.messages![1] as any).content
    assert.equal(sentText, '手机 [PHONE_1] 邮箱 [EMAIL_1]')
  })

  it('deduplicates same PII within session (同一值在不同 turn 映射到同占位符)', async () => {
    const san = makeFakeSanitizer()
    const svc = new InputGuardServiceImpl(
      fakeCtx() as any, defaultConfig(),
      undefined, undefined, undefined, san.api as any,
    )
    const sessionId = 'e2e-dedup'

    // 第一 turn：包含 13812345678
    const p1 = makePayload('我的手机号是 13812345678', sessionId, {
      realm: 'CLOUD', category: 'CLOUD',
      provider: 'cloud-deepseek-v4', model: 'deepseek-chat',
    })
    await svc.handlePreStep(p1 as any, async () => ({ kind: 'enter', messages: [...p1.messages] }))

    // 第二 turn：再次提到 13812345678 — 应映射到同一个 [PHONE_1]
    const p2 = makePayload('再确认一下手机 13812345678', sessionId, {
      realm: 'CLOUD', category: 'CLOUD',
      provider: 'cloud-deepseek-v4', model: 'deepseek-chat',
    })
    const d2 = await svc.handlePreStep(p2 as any, async () => ({ kind: 'enter', messages: [...p2.messages] }))
    const sentText2 = (d2.messages![1] as any).content
    assert.equal(sentText2, '再确认一下手机 [PHONE_1]')
  })

  it('no PII → sanitize runs but produces no replacements', async () => {
    const san = makeFakeSanitizer()
    const audit = fakeAuditLog()
    const svc = new InputGuardServiceImpl(
      fakeCtx() as any, defaultConfig(),
      undefined, undefined, undefined, san.api as any, audit.api as any,
    )
    const payload = makePayload('hello world', 'e2e-3', {
      realm: 'CLOUD', category: 'CLOUD',
      provider: 'cloud-deepseek-v4', model: 'deepseek-chat',
    })
    const decision = await svc.handlePreStep(
      payload as any,
      async () => ({ kind: 'enter', messages: [...payload.messages] }),
    )
    assert.equal((decision.messages![1] as any).content, 'hello world')
    // audit: input-guard.sanitized 应不触发（replacementCount=0）
    const sanitized = audit.entries.find(e => e.kind === 'input-guard.sanitized')
    assert.equal(sanitized, undefined, '无替换不应触发 sanitized 审计')
    // state.sanitized=false，所以 llm/stream 不应 desanitize
    const chunks = [{ type: 'text-delta', text: 'hi' }]
    const out = await collect(svc.handleLlmStream({ sessionId: 'e2e-3' }, () => streamFrom(chunks)))
    assert.equal((out[0] as any).text, 'hi', '无替换 → 不 desanitize')
  })
})

describe('input-guard E2E — downgrade semantics', () => {
  it('sanitize throws + downgradeOnSanitizeFailure=true → state.downgraded, route rewritten to LOCAL', async () => {
    const san = makeFakeSanitizer({ throwOnSanitize: true })
    const audit = fakeAuditLog()
    const svc = new InputGuardServiceImpl(
      fakeCtx() as any, defaultConfig({ downgradeOnSanitizeFailure: true }),
      undefined, undefined, undefined, san.api as any, audit.api as any,
    )
    const sessionId = 'down-1'
    const payload = makePayload('alice@example.com', sessionId, {
      realm: 'CLOUD', category: 'CLOUD',
      provider: 'cloud-deepseek-v4', model: 'deepseek-chat',
    })
    // pre-step：sanitize 抛错，但 downgrade=true → pass-through + 标记降级
    const decision = await svc.handlePreStep(
      payload as any,
      async () => ({ kind: 'enter', messages: [...payload.messages] }),
    )
    assert.equal(decision.kind, 'enter', '不 reject — 让 handleAgentRequest 改写路由')
    assert.equal((decision.messages![1] as any).content, 'alice@example.com', '原文保留 — LOCAL 无需脱敏')

    // state.downgraded=true
    const state = svc.getStepState(sessionId)
    assert.ok(state)
    assert.equal(state?.downgraded, true)
    assert.equal(state?.originalProvider, 'cloud-deepseek-v4')
    assert.equal(state?.originalModel, 'deepseek-chat')
    assert.equal(state?.originalRealm, 'CLOUD')

    // handleAgentRequest：改写 route 到 LOCAL
    const seed = { provider: 'cloud-deepseek-v4', model: 'deepseek-chat', maxTokens: 4096 }
    const result = await svc.handleAgentRequest(
      { agent: { session: { id: sessionId } } },
      seed,
      async () => seed,
    )
    assert.equal(result.provider, 'local-qwen3-4b')
    assert.equal(result.model, 'qwen3-4b-instruct-2507')
    assert.equal(result.maxTokens, 4096, '其他字段保留')

    // 审计：security 级别，包含 sanitize.failed + sanitize.downgraded + route.overridden
    assert.ok(audit.entries.some(e => e.kind === 'input-guard.sanitize.failed' && e.level === 'security'))
    assert.ok(audit.entries.some(e => e.kind === 'input-guard.sanitize.downgraded' && e.level === 'security'))
    const routeAudit = audit.entries.find(e => e.kind === 'input-guard.route.overridden')
    assert.ok(routeAudit)
    assert.equal(routeAudit?.payload?.from?.provider, 'cloud-deepseek-v4')
    assert.equal(routeAudit?.payload?.to?.provider, 'local-qwen3-4b')
  })

  it('sanitize throws + downgradeOnSanitizeFailure=false → reject', async () => {
    const san = makeFakeSanitizer({ throwOnSanitize: true })
    const audit = fakeAuditLog()
    const svc = new InputGuardServiceImpl(
      fakeCtx() as any, defaultConfig({ downgradeOnSanitizeFailure: false }),
      undefined, undefined, undefined, san.api as any, audit.api as any,
    )
    const payload = makePayload('alice@example.com', 'down-2', {
      realm: 'CLOUD', category: 'CLOUD',
      provider: 'cloud-deepseek-v4', model: 'deepseek-chat',
    })
    const decision = await svc.handlePreStep(
      payload as any,
      async () => ({ kind: 'enter', messages: [...payload.messages] }),
    )
    assert.equal(decision.kind, 'reject')
    assert.equal(decision.reason, 'sanitizer-failed')
    // state 不应被标为 downgraded（因为 REJECT 了）
    const state = svc.getStepState('down-2')
    assert.equal(state?.downgraded, undefined)
    // 路由不改写
    const seed = { provider: 'cloud-deepseek-v4', model: 'deepseek-chat' }
    const result = await svc.handleAgentRequest(
      { agent: { session: { id: 'down-2' } } },
      seed,
      async () => seed,
    )
    assert.deepEqual(result, seed)
  })

  it('sanitize unavailable (no sanitizer injected) → downgrade path 也工作', async () => {
    const audit = fakeAuditLog()
    const svc = new InputGuardServiceImpl(
      fakeCtx() as any, defaultConfig({ downgradeOnSanitizeFailure: true }),
      undefined, undefined, undefined, undefined, audit.api as any,
    )
    const payload = makePayload('hello', 'down-3', {
      realm: 'CLOUD', category: 'CLOUD',
      provider: 'cloud-deepseek-v4', model: 'deepseek-chat',
    })
    const result = await svc.handlePreStep(
      payload as any,
      async () => ({ kind: 'enter', messages: [...payload.messages] }),
    )
    // sanitizer 未注入：shouldSanitize=true 但 sanitizer 不可用 → 进 no-sanitize 分支
    // state.sanitized=false，但**没有** downgraded 标记（因为从未尝试 sanitize）
    assert.equal(result.kind, 'enter')
    const state = svc.getStepState('down-3')
    assert.equal(state?.downgraded, undefined)
  })
})

describe('input-guard E2E — stream chunks', () => {
  it('placeholder split across text-delta chunks gets desanitized', async () => {
    const san = makeFakeSanitizer()
    const svc = new InputGuardServiceImpl(
      fakeCtx() as any, defaultConfig(),
      undefined, undefined, undefined, san.api as any,
    )
    const sessionId = 'stream-1'
    // pre-step 先建立映射（这里手工设置模拟）
    san.mappings.set(sessionId, new Map([['13812345678', '[PHONE_1]']]))
    ;(svc as any).stepState.set(sessionId, {
      sanitized: true, replacements: 1, sessionId, timestamp: Date.now(),
    })

    // chunks 把 [PHONE_1] 切分：['您的手机是', '[PHONE', '_', '1]', '，谢谢']
    const chunks = [
      { type: 'text-delta', text: '您的手机是' },
      { type: 'text-delta', text: '[PHONE' },
      { type: 'text-delta', text: '_' },
      { type: 'text-delta', text: '1]' },
      { type: 'text-delta', text: '，谢谢' },
      { type: 'done', done: true },
    ]
    const out = await collect(svc.handleLlmStream({ sessionId }, () => streamFrom(chunks)))
    const texts = out.filter(c => c.type === 'text-delta').map(c => (c as any).text)
    const joined = texts.join('')
    assert.equal(joined, '您的手机是13812345678，谢谢', '跨 chunk 的占位符应被正确还原')
  })

  it('block-end text is also desanitized (防止累积器覆盖还原结果)', async () => {
    const san = makeFakeSanitizer()
    const svc = new InputGuardServiceImpl(
      fakeCtx() as any, defaultConfig(),
      undefined, undefined, undefined, san.api as any,
    )
    const sessionId = 'stream-2'
    san.mappings.set(sessionId, new Map([['alice@example.com', '[EMAIL_1]']]))
    ;(svc as any).stepState.set(sessionId, {
      sanitized: true, replacements: 1, sessionId, timestamp: Date.now(),
    })

    const chunks = [
      { type: 'text-delta', text: '邮箱是 [EMAIL_1]' },
      { type: 'block-end', block: { type: 'text', text: '邮箱是 [EMAIL_1]' } },
    ]
    const out = await collect(svc.handleLlmStream({ sessionId }, () => streamFrom(chunks)))
    const blockEnd = out.find(c => c.type === 'block-end') as any
    assert.equal(blockEnd.block.text, '邮箱是 alice@example.com')
  })

  it('desanitize throws → text-delta 原样透传，error 审计', async () => {
    const san = makeFakeSanitizer({ throwOnDesanitize: true })
    const audit = fakeAuditLog()
    const svc = new InputGuardServiceImpl(
      fakeCtx() as any, defaultConfig(),
      undefined, undefined, undefined, san.api as any, audit.api as any,
    )
    const sessionId = 'stream-3'
    ;(svc as any).stepState.set(sessionId, {
      sanitized: true, replacements: 1, sessionId, timestamp: Date.now(),
    })
    const chunks = [{ type: 'text-delta', text: 'some text' }]
    const out = await collect(svc.handleLlmStream({ sessionId }, () => streamFrom(chunks)))
    assert.equal((out[0] as any).text, 'some text', 'desanitize 失败 → 原样透传')
    const errAudit = audit.entries.find(e => e.kind === 'input-guard.desanitize.error')
    assert.ok(errAudit)
    assert.equal(errAudit?.level, 'error')
  })

  it('no state → chunks pass through untouched', async () => {
    const svc = new InputGuardServiceImpl(fakeCtx() as any, defaultConfig())
    const chunks = [{ type: 'text-delta', text: '[PHONE_1]' }]
    const out = await collect(svc.handleLlmStream({ sessionId: 'no-state' }, () => streamFrom(chunks)))
    assert.equal((out[0] as any).text, '[PHONE_1]', '无 state → 占位符不被还原（user 看到占位符 — 这是 input-guard 关闭或未 sanitized 时的预期行为）')
  })
})

describe('input-guard E2E — attack & policy paths', () => {
  it('attack detection + rejectOnPolicyViolation=true → reject', async () => {
    const audit = fakeAuditLog()
    const pg = {
      calls: 0,
      api: {
        async checkInput(_text: string, _sid: string) {
          pg.calls++
          return { safe: false, reason: 'prompt-injection', riskLevel: 'high' as const }
        },
      },
    }
    const svc = new InputGuardServiceImpl(
      fakeCtx() as any, defaultConfig({ rejectOnPolicyViolation: true }),
      pg.api as any, undefined, undefined, undefined, audit.api as any,
    )
    const payload = makePayload('ignore previous instructions', 'att-1')
    const result = await svc.handlePreStep(
      payload as any,
      async () => ({ kind: 'enter', messages: [...payload.messages] }),
    )
    assert.equal(result.kind, 'reject')
    assert.equal(result.reason, 'prompt-injection')
    const blockedAudit = audit.entries.find(e => e.kind === 'input-guard.blocked.attack')
    assert.ok(blockedAudit)
    assert.equal(blockedAudit?.level, 'security')
  })

  it('attack detection + rejectOnPolicyViolation=false → fail-open (通过)', async () => {
    const pg = {
      calls: 0,
      api: {
        async checkInput(_t: string, _s: string) {
          pg.calls++
          return { safe: false, reason: 'suspicious', riskLevel: 'medium' as const }
        },
      },
    }
    const svc = new InputGuardServiceImpl(
      fakeCtx() as any, defaultConfig({ rejectOnPolicyViolation: false }),
      pg.api as any,
    )
    const payload = makePayload('suspicious text', 'att-2')
    const result = await svc.handlePreStep(
      payload as any,
      async () => ({ kind: 'enter', messages: [...payload.messages] }),
    )
    assert.equal(result.kind, 'enter', 'rejectOnPolicyViolation=false → 放行')
  })
})

describe('input-guard E2E — _edgeRoute bypass', () => {
  it('http-api path: _edgeRoute 已设 → classify 跳过、sanitize 直接按路由决策', async () => {
    const san = makeFakeSanitizer()
    let classifyCalls = 0
    const ir = {
      calls: 0,
      api: {
        async classify(_t: string) {
          classifyCalls++
          return { category: 'CLOUD', confidence: 0.9 }
        },
      },
    }
    const svc = new InputGuardServiceImpl(
      fakeCtx() as any, defaultConfig(),
      undefined, undefined, ir.api as any, san.api as any,
    )
    const payload = makePayload('我的手机号是13812345678', 'edge-1', {
      realm: 'CLOUD', category: 'CLOUD',
      provider: 'cloud-deepseek-v4', model: 'deepseek-chat',
    })
    await svc.handlePreStep(
      payload as any,
      async () => ({ kind: 'enter', messages: [...payload.messages] }),
    )
    assert.equal(classifyCalls, 0, 'classify 不应被调用（已从 _edgeRoute 读取）')
    assert.equal(san.sanitizeCalls.length, 1, 'sanitize 仍按路由决策执行')
  })

  it('non-http-api 路径（无 _edgeRoute）→ 自行 classify', async () => {
    const ir = {
      calls: 0,
      api: {
        async classify(_t: string) {
          ir.calls++
          return { category: 'LOCAL', confidence: 0.85 }
        },
      },
    }
    const svc = new InputGuardServiceImpl(
      fakeCtx() as any, defaultConfig(),
      undefined, undefined, ir.api as any,
    )
    const payload = makePayload('读本地文件', 'edge-2')
    // 没有 _edgeRoute
    await svc.handlePreStep(
      payload as any,
      async () => ({ kind: 'enter', messages: [...payload.messages] }),
    )
    assert.equal(ir.calls, 1, '无 _edgeRoute → 自行 classify')
  })
})

describe('input-guard E2E — top-level bypass', () => {
  it('enableInputGuard=false: pre-step, agent/request, llm/stream all pass-through', async () => {
    const san = makeFakeSanitizer()
    const pg = {
      calls: 0,
      api: { async checkInput() { pg.calls++; return { safe: false, reason: 'should-not-trigger', riskLevel: 'high' as const } } },
    }
    const svc = new InputGuardServiceImpl(
      fakeCtx() as any, defaultConfig({ enableInputGuard: false }),
      pg.api as any, undefined, undefined, san.api as any,
    )

    // pre-step: 不调 prompt-guard、不调 sanitize，messages 不变
    const payload = makePayload('alice@example.com', 'bypass-1', {
      realm: 'CLOUD', category: 'CLOUD',
      provider: 'cloud-deepseek-v4', model: 'deepseek-chat',
    })
    const decision = await svc.handlePreStep(
      payload as any,
      async () => ({ kind: 'enter', messages: [...payload.messages] }),
    )
    assert.equal((decision.messages![1] as any).content, 'alice@example.com', '原文不动')
    assert.equal(pg.calls, 0, 'prompt-guard 未触发')
    assert.equal(san.sanitizeCalls.length, 0, 'sanitize 未触发')

    // agent/request: 即使手动设置 downgraded 状态也不改写
    ;(svc as any).stepState.set('bypass-1', {
      sanitized: false, replacements: 0, sessionId: 'bypass-1', timestamp: Date.now(),
      downgraded: true, originalProvider: 'cloud', originalModel: 'gpt',
    })
    const seed = { provider: 'cloud-deepseek-v4', model: 'deepseek-chat' }
    const reqResult = await svc.handleAgentRequest(
      { agent: { session: { id: 'bypass-1' } } },
      seed,
      async () => seed,
    )
    assert.deepEqual(reqResult, seed, 'enableInputGuard=false → 不改写')

    // llm/stream: 即使 sanitized=true 也不 desanitize（因为 enableInputGuard=false）
    ;(svc as any).stepState.set('bypass-1', {
      sanitized: true, replacements: 1, sessionId: 'bypass-1', timestamp: Date.now(),
    })
    const chunks = [{ type: 'text-delta', text: '[PHONE_1]' }]
    const out = await collect(svc.handleLlmStream({ sessionId: 'bypass-1' }, () => streamFrom(chunks)))
    assert.equal((out[0] as any).text, '[PHONE_1]', '占位符不被还原')
  })
})

describe('input-guard E2E — multi-turn state isolation', () => {
  it('each turn overwrites previous step state (no cross-turn contamination)', async () => {
    const san = makeFakeSanitizer()
    const svc = new InputGuardServiceImpl(
      fakeCtx() as any, defaultConfig(),
      undefined, undefined, undefined, san.api as any,
    )
    const sessionId = 'multi-1'

    // turn 1: sanitize, replacements > 0
    const p1 = makePayload('手机 13812345678', sessionId, {
      realm: 'CLOUD', category: 'CLOUD',
      provider: 'cloud-deepseek-v4', model: 'deepseek-chat',
    })
    await svc.handlePreStep(p1 as any, async () => ({ kind: 'enter', messages: [...p1.messages] }))
    let state = svc.getStepState(sessionId)
    assert.equal(state?.sanitized, true)
    assert.equal(state?.replacements, 1)

    // turn 2: no PII, replacements = 0
    const p2 = makePayload('读本地 README.md', sessionId, {
      realm: 'CLOUD', category: 'CLOUD',
      provider: 'cloud-deepseek-v4', model: 'deepseek-chat',
    })
    await svc.handlePreStep(p2 as any, async () => ({ kind: 'enter', messages: [...p2.messages] }))
    state = svc.getStepState(sessionId)
    assert.equal(state?.sanitized, false, 'turn 2 覆盖 turn 1 的 state')
    assert.equal(state?.replacements, 0)

    // llm/stream 在 turn 2: 因为 sanitized=false → 不 desanitize（即使 LLM 仍用了占位符）
    const chunks = [{ type: 'text-delta', text: '[PHONE_1] 是的' }]
    const out = await collect(svc.handleLlmStream({ sessionId }, () => streamFrom(chunks)))
    assert.equal((out[0] as any).text, '[PHONE_1] 是的', 'turn 2 state 为 sanitized=false → 不 desanitize')

    // turn 3: 又有 PII
    const p3 = makePayload('邮箱 alice@example.com', sessionId, {
      realm: 'CLOUD', category: 'CLOUD',
      provider: 'cloud-deepseek-v4', model: 'deepseek-chat',
    })
    await svc.handlePreStep(p3 as any, async () => ({ kind: 'enter', messages: [...p3.messages] }))
    state = svc.getStepState(sessionId)
    assert.equal(state?.sanitized, true)
    assert.equal(state?.replacements, 1)
  })

  it('different sessions have independent state', async () => {
    const san = makeFakeSanitizer()
    const svc = new InputGuardServiceImpl(
      fakeCtx() as any, defaultConfig(),
      undefined, undefined, undefined, san.api as any,
    )

    // session A: sanitize 成功
    const pA = makePayload('手机 13812345678', 'sess-A', {
      realm: 'CLOUD', category: 'CLOUD',
      provider: 'cloud-deepseek-v4', model: 'deepseek-chat',
    })
    await svc.handlePreStep(pA as any, async () => ({ kind: 'enter', messages: [...pA.messages] }))
    const stateA = svc.getStepState('sess-A')
    assert.equal(stateA?.sanitized, true)

    // session B: 没有任何 turn
    const stateB = svc.getStepState('sess-B')
    assert.equal(stateB, undefined, 'sess-B 独立 — 不受 sess-A 影响')
  })
})

describe('input-guard E2E — additional PII types', () => {
  // Extend the sanitizer to handle IP/MAC patterns (mirrors privacy-policy.json v1.4.0+).
  function makeRichSanitizer() {
    const mappings = new Map<string, Map<string, string>>()
    const calls: Array<{ text: string; sessionId: string }> = []
    function placeholderFor(sid: string, original: string, kind: string): string {
      let m = mappings.get(sid)
      if (!m) { m = new Map(); mappings.set(sid, m) }
      const ex = m.get(original)
      if (ex) return ex
      const n = Array.from(m.values()).filter(v => v.startsWith(`[${kind}_`)).length + 1
      const ph = `[${kind}_${n}]`
      m.set(original, ph)
      return ph
    }
    return {
      mappings,
      calls,
      api: {
        async sanitize(text: string, ctx?: { sessionId?: string }) {
          const sid = ctx?.sessionId ?? 'default'
          calls.push({ text, sessionId: sid })
          let out = text
          const replacements: Array<{ type: string; original: string; token: string }> = []
          // IPv4
          for (const m of text.matchAll(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/gu)) {
            const ph = placeholderFor(sid, m[0], 'IP')
            out = out.replace(m[0], ph)
            replacements.push({ type: 'ip', original: m[0], token: ph })
          }
          // MAC (xx:xx:xx:xx:xx:xx)
          for (const m of text.matchAll(/\b(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b/gu)) {
            const ph = placeholderFor(sid, m[0], 'MAC')
            out = out.replace(m[0], ph)
            replacements.push({ type: 'mac', original: m[0], token: ph })
          }
          return { sanitizedText: out, sessionId: sid, replacements }
        },
        async desanitize(text: string, sessionId: string) {
          const m = mappings.get(sessionId)
          if (!m) return text
          let out = text
          for (const [orig, ph] of m) out = out.split(ph).join(orig)
          return out
        },
      },
    }
  }

  it('IPv4 address sanitized end-to-end', async () => {
    const san = makeRichSanitizer()
    const svc = new InputGuardServiceImpl(
      fakeCtx() as any, defaultConfig(),
      undefined, undefined, undefined, san.api as any,
    )
    const sessionId = 'pII-ip'
    const payload = makePayload('服务器 IP 是 192.168.1.100', sessionId, {
      realm: 'CLOUD', category: 'CLOUD',
      provider: 'cloud-deepseek-v4', model: 'deepseek-chat',
    })
    const decision = await svc.handlePreStep(
      payload as any,
      async () => ({ kind: 'enter', messages: [...payload.messages] }),
    )
    const sentText = (decision.messages![1] as any).content
    assert.equal(sentText, '服务器 IP 是 [IP_1]')
    assert.ok(!sentText.includes('192.168'))

    // desanitize round-trip
    const chunks = [{ type: 'text-delta', text: '已连接 [IP_1]' }]
    const out = await collect(svc.handleLlmStream({ sessionId }, () => streamFrom(chunks)))
    assert.equal((out[0] as any).text, '已连接 192.168.1.100')
  })

  it('MAC address sanitized end-to-end', async () => {
    const san = makeRichSanitizer()
    const svc = new InputGuardServiceImpl(
      fakeCtx() as any, defaultConfig(),
      undefined, undefined, undefined, san.api as any,
    )
    const sessionId = 'pII-mac'
    const payload = makePayload('网卡 AA:BB:CC:DD:EE:FF', sessionId, {
      realm: 'CLOUD', category: 'CLOUD',
      provider: 'cloud-deepseek-v4', model: 'deepseek-chat',
    })
    const decision = await svc.handlePreStep(
      payload as any,
      async () => ({ kind: 'enter', messages: [...payload.messages] }),
    )
    const sentText = (decision.messages![1] as any).content
    assert.equal(sentText, '网卡 [MAC_1]')
  })

  it('multiple PII in one message: IPv4 + MAC', async () => {
    const san = makeRichSanitizer()
    const svc = new InputGuardServiceImpl(
      fakeCtx() as any, defaultConfig(),
      undefined, undefined, undefined, san.api as any,
    )
    const payload = makePayload('IP 10.0.0.1 网卡 AA:BB:CC:DD:EE:FF', 'multi', {
      realm: 'CLOUD', category: 'CLOUD',
      provider: 'cloud-deepseek-v4', model: 'deepseek-chat',
    })
    const decision = await svc.handlePreStep(
      payload as any,
      async () => ({ kind: 'enter', messages: [...payload.messages] }),
    )
    const sentText = (decision.messages![1] as any).content
    assert.equal(sentText, 'IP [IP_1] 网卡 [MAC_1]')
  })
})

describe('input-guard E2E — edge cases', () => {
  it('empty user text → no sanitize, pass through', async () => {
    const san = makeFakeSanitizer()
    const svc = new InputGuardServiceImpl(
      fakeCtx() as any, defaultConfig(),
      undefined, undefined, undefined, san.api as any,
    )
    const payload = {
      agent: { id: 'a1', session: { id: 'empty' }, _edgeRoute: { realm: 'CLOUD', category: 'CLOUD', provider: 'cloud-deepseek-v4', model: 'deepseek-chat' } },
      messages: [{ role: 'user', content: '' }],
      step: 1,
    }
    const decision = await svc.handlePreStep(
      payload as any,
      async () => ({ kind: 'enter', messages: [...payload.messages] }),
    )
    // 空文本：findLastUserText 找到 content='' 但 length>0 不成立，应返回 decision
    assert.equal(decision.kind, 'enter')
    assert.equal((decision.messages![0] as any).content, '')
    assert.equal(san.sanitizeCalls.length, 0)
  })

  it('very long text (>10KB) handles correctly', async () => {
    const san = makeFakeSanitizer()
    const svc = new InputGuardServiceImpl(
      fakeCtx() as any, defaultConfig(),
      undefined, undefined, undefined, san.api as any,
    )
    const longText = 'x'.repeat(15000) + ' 13812345678 ' + 'y'.repeat(15000)
    const payload = makePayload(longText, 'long-1', {
      realm: 'CLOUD', category: 'CLOUD',
      provider: 'cloud-deepseek-v4', model: 'deepseek-chat',
    })
    const decision = await svc.handlePreStep(
      payload as any,
      async () => ({ kind: 'enter', messages: [...payload.messages] }),
    )
    const sentText = (decision.messages![1] as any).content
    assert.ok(sentText.includes('[PHONE_1]'), '长文本中的 PII 仍被识别')
    assert.ok(!sentText.includes('13812345678'), '长文本中的 PII 原文被替换')
  })

  it('unicode CJK text passes through unmodified', async () => {
    const san = makeFakeSanitizer()
    const svc = new InputGuardServiceImpl(
      fakeCtx() as any, defaultConfig(),
      undefined, undefined, undefined, san.api as any,
    )
    const payload = makePayload('你好世界', 'unicode-1', {
      realm: 'CLOUD', category: 'CLOUD',
      provider: 'cloud-deepseek-v4', model: 'deepseek-chat',
    })
    const decision = await svc.handlePreStep(
      payload as any,
      async () => ({ kind: 'enter', messages: [...payload.messages] }),
    )
    assert.equal((decision.messages![1] as any).content, '你好世界')
  })

  it('PII mid-text with unicode surrounding is correctly replaced', async () => {
    const san = makeFakeSanitizer()
    const svc = new InputGuardServiceImpl(
      fakeCtx() as any, defaultConfig(),
      undefined, undefined, undefined, san.api as any,
    )
    const payload = makePayload('我的电话 13812345678 请回拨', 'mix-1', {
      realm: 'CLOUD', category: 'CLOUD',
      provider: 'cloud-deepseek-v4', model: 'deepseek-chat',
    })
    const decision = await svc.handlePreStep(
      payload as any,
      async () => ({ kind: 'enter', messages: [...payload.messages] }),
    )
    assert.equal((decision.messages![1] as any).content, '我的电话 [PHONE_1] 请回拨')
  })
})

describe('input-guard E2E — full downgrade round-trip', () => {
  it('sanitize throws → pre-step marks downgraded → agent/request rewrites → LOCAL route', async () => {
    // 验证完整的"故障 → 降级"语义链
    const san = makeFakeSanitizer({ throwOnSanitize: true })
    const audit = fakeAuditLog()
    const svc = new InputGuardServiceImpl(
      fakeCtx() as any, defaultConfig({ downgradeOnSanitizeFailure: true }),
      undefined, undefined, undefined, san.api as any, audit.api as any,
    )
    const sessionId = 'full-down-1'

    // ─ Phase 1: pre-step
    const payload = makePayload('alice@example.com', sessionId, {
      realm: 'CLOUD', category: 'CLOUD',
      provider: 'cloud-deepseek-v4', model: 'deepseek-chat',
      confidence: 0.92,
      rationale: 'cloud-classified',
    })
    const preStepDecision = await svc.handlePreStep(
      payload as any,
      async () => ({ kind: 'enter', messages: [...payload.messages] }),
    )
    assert.equal(preStepDecision.kind, 'enter')
    assert.equal((preStepDecision.messages![1] as any).content, 'alice@example.com',
      '原文保留 — LOCAL LLM 不需要脱敏')

    // ─ Phase 2: agent/request（模拟 agent-loop 的 buildRequest 阶段）
    const seed = { provider: 'cloud-deepseek-v4', model: 'deepseek-chat', maxTokens: 4096 }
    const reqResult = await svc.handleAgentRequest(
      { agent: { session: { id: sessionId } } },
      seed,
      async () => seed,
    )
    assert.equal(reqResult.provider, 'local-qwen3-4b', 'route 改写到 LOCAL')
    assert.equal(reqResult.model, 'qwen3-4b-instruct-2507')

    // ─ Phase 3: llm/stream — sanitized=false，所以不调 desanitize
    // 模拟 LOCAL LLM 的响应流（无占位符，因为没脱敏）
    const chunks = [
      { type: 'text-delta', text: '邮箱地址是 alice@example.com' },
      { type: 'done', done: true },
    ]
    const out = await collect(svc.handleLlmStream({ sessionId }, () => streamFrom(chunks)))
    const textDelta = out.find(c => c.type === 'text-delta') as any
    assert.equal(textDelta.text, '邮箱地址是 alice@example.com', 'LOCAL 路径 → 原文透传')

    // ─ 审计：完整链路都被记录
    const kinds = audit.entries.map(e => e.kind)
    assert.ok(kinds.includes('input-guard.sanitize.failed'))
    assert.ok(kinds.includes('input-guard.sanitize.downgraded'))
    assert.ok(kinds.includes('input-guard.route.overridden'))

    // ─ stepState 应仍保留原 route 信息，供响应体/上游观测
    const finalState = svc.getStepState(sessionId)
    assert.equal(finalState?.downgraded, true)
    assert.equal(finalState?.originalProvider, 'cloud-deepseek-v4')
    assert.equal(finalState?.originalRealm, 'CLOUD')
  })
})