/**
 * §7.123 (2026-10-27) — edge hardening regressions.
 *
 * This file pins the five behaviour changes made after the code audit:
 *
 *   1. input-guard sanitizes EVERY user message, not only the last one
 *      (the agent loop ships the whole conversation to the model, so PII
 *      from an earlier turn used to ride along unredacted).
 *   2. The §7.109 semantic unlock cannot be satisfied by a SYNTHETIC
 *      confidence (the bailian decision-model's "decisive-by-construction"
 *      0.9 placeholder).
 *   3. The LLM verdict regex fallback accepts the full 4-category union —
 *      a malformed-JSON REJECT must not silently fall through to the
 *      keyword-rules tier (a dropped REJECT is a dropped BLOCK).
 *   4. http-api authentication fails CLOSED when no bearer token is
 *      configured, and compares tokens in constant time.
 *   5. http-api-routes survives a malformed percent-escape in a path
 *      parameter (a remote crash otherwise).
 *
 * Every test here asserts on the REAL production module — not on a
 * re-implementation. (Audit note: three older test files asserted against
 * copies of the code and could not fail on a production regression.)
 */

import assert from 'node:assert/strict'
import { describe, it, beforeEach, afterEach } from 'vitest'

import { InputGuardServiceImpl } from '../../src/dsh-adapter/input-guard.ts'
import type { Config } from '../../src/dsh-adapter/input-guard.ts'
import {
  IntentRouterServiceImpl,
  parseClassificationVerdict,
  coerceClassification,
} from '../../src/dsh-adapter/intent-router.ts'
import { findRoute, type RouteDef } from '../../src/dsh-adapter/http-api-routes.ts'
import { HttpApiServiceImpl } from '../../src/dsh-adapter/http-api.ts'

/* ────────────────────────────────────────────────────────────────────────────
 * 1. input-guard — every user message is sanitized
 * ──────────────────────────────────────────────────────────────────────────── */

function igConfig(overrides: Partial<Config> = {}): Config {
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
  } as Config
}

function igCtx() {
  return {
    reflect: { provide(_n: string, _v: unknown) { return () => {} } },
    provide(_n: string, _v: unknown) { return () => {} },
  }
}

/** Sanitizer fake that replaces every email it sees with a placeholder. */
function piiSanitizer() {
  const calls: string[] = []
  return {
    calls,
    api: {
      async sanitize(text: string, ctx?: { sessionId?: string }) {
        calls.push(text)
        const replacements = [...text.matchAll(/[\w.-]+@[\w.-]+\.\w+/gu)].map((m, i) => ({
          original: m[0],
          placeholder: `[EMAIL_${i + 1}]`,
          piiType: 'email',
          dataClass: 'confidential',
        }))
        let out = text
        for (const r of replacements) out = out.split(r.original).join(r.placeholder)
        return { sanitizedText: out, sessionId: ctx?.sessionId ?? 's', replacements }
      },
      async desanitize(text: string) { return text },
    },
  }
}

function multiTurnPayload() {
  return {
    agent: { id: 'a1', session: { id: 'sess-1' } as any },
    messages: [
      { role: 'system', content: 'You are edge-agent' },
      { role: 'user', content: '我的邮箱是 alice@example.com' },
      { role: 'assistant', content: '好的，我记下了。' },
      { role: 'user', content: '再确认一下 bob@example.com 能不能收到' },
    ],
    step: 2,
    // §7.175: 宿主给本轮选的模型（payload 顶层）。缺它 ⇒ fail-closed 拒收。
    modelSelection: { provider: 'local-llm', model: 'qwen3-4b-instruct-2507' },
  }
}

describe('§7.123 — input-guard sanitizes EVERY user message', () => {
  // §7.175: 「云端不可用 → 降级 LOCAL」这条路径退役了（input-guard 不再改写
  // 路由，也不再探云池），脱敏步骤按意图分类照常跑。这里保留 key 的设置
  // 只是为了让 fixture 与环境无关，不影响行为。
  const KEY = 'DEEPSEEK_API_KEY'
  let saved: string | undefined

  beforeEach(() => {
    saved = process.env[KEY]
    process.env[KEY] = 'sk-test-present-for-7123'
  })

  afterEach(() => {
    if (saved === undefined) delete process.env[KEY]
    else process.env[KEY] = saved
  })

  it('rewrites PII in an earlier turn, not just the last one', async () => {
    const san = piiSanitizer()
    const svc = new InputGuardServiceImpl(
      igCtx() as any,
      igConfig(),
      undefined,
      undefined,
      { classify: async () => ({ category: 'CLOUD', confidence: 0.9 }) } as any,
      san.api as any,
    )

    const payload = multiTurnPayload()
    const decision = await svc.handlePreStep(payload as any, async () => ({
      kind: 'enter',
      messages: [...payload.messages],
    }))

    const messages = (decision as any).messages as Array<Record<string, unknown>>
    // Both user turns were sanitized — the first one used to leak.
    assert.ok(
      !String(messages[1].content).includes('alice@example.com'),
      '第 1 轮 user 消息里的 PII 未脱敏',
    )
    assert.ok(
      !String(messages[3].content).includes('bob@example.com'),
      '最后一条 user 消息里的 PII 未脱敏',
    )
    assert.ok(String(messages[1].content).includes('[EMAIL_'), '第 1 轮应被占位符替换')
    assert.ok(String(messages[3].content).includes('[EMAIL_'), '最后一条应被占位符替换')
    // The assistant turn and the system turn are untouched.
    assert.equal(messages[2].content, '好的，我记下了。')
    assert.equal(messages[0].content, 'You are edge-agent')
  })

  it('sanitizes every user turn (one sanitize call per user message)', async () => {
    const san = piiSanitizer()
    const svc = new InputGuardServiceImpl(
      igCtx() as any,
      igConfig(),
      undefined,
      undefined,
      { classify: async () => ({ category: 'CLOUD', confidence: 0.9 }) } as any,
      san.api as any,
    )

    const payload = multiTurnPayload()
    await svc.handlePreStep(payload as any, async () => ({
      kind: 'enter',
      messages: [...payload.messages],
    }))

    assert.equal(san.calls.length, 2, '两条 user 消息应各脱敏一次')
    assert.ok(san.calls.some((t) => t.includes('alice@example.com')))
    assert.ok(san.calls.some((t) => t.includes('bob@example.com')))
  })

  it('records the hit PII types + how many turns were rewritten in the audit row', async () => {
    const san = piiSanitizer()
    const entries: any[] = []
    const svc = new InputGuardServiceImpl(
      igCtx() as any,
      igConfig(),
      undefined,
      undefined,
      { classify: async () => ({ category: 'CLOUD', confidence: 0.9 }) } as any,
      san.api as any,
      { log: async (e: any) => { entries.push(e) } } as any,
    )

    const payload = multiTurnPayload()
    await svc.handlePreStep(payload as any, async () => ({
      kind: 'enter',
      messages: [...payload.messages],
    }))

    const row = entries.find((e) => e.kind === 'input-guard.sanitized')
    assert.ok(row, '应落一条 input-guard.sanitized 审计')
    assert.equal(row.payload.sanitizedMessages, 2)
    assert.equal(row.payload.userMessages, 2)
    assert.deepEqual(row.payload.piiTypes, ['email'])
    // The audit payload must not carry the plaintext PII.
    assert.equal(JSON.stringify(row.payload).includes('alice@example.com'), false)
  })

  it('does not rewrite the synthetic user-role runtime context appended by dsh-agent-instructions', async () => {
    const san = piiSanitizer()
    const svc = new InputGuardServiceImpl(
      igCtx() as any,
      igConfig(),
      undefined,
      undefined,
      { classify: async () => ({ category: 'CLOUD', confidence: 0.9 }) } as any,
      san.api as any,
    )

    const payload = multiTurnPayload()
    const decision = await svc.handlePreStep(payload as any, async () => ({
      kind: 'enter',
      messages: [
        ...payload.messages,
        // dsh-agent-instructions appends a synthetic user-role run context.
        { role: 'user', content: '<runtime_context>system injected alice@example.com</runtime_context>' },
      ],
    }))

    const messages = (decision as any).messages as Array<Record<string, unknown>>
    // The injected context is NOT user content — it must stay verbatim.
    assert.ok(
      String(messages[4].content).includes('alice@example.com'),
      '注入的运行上下文不应被改写',
    )
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * 2 + 3. intent-router — semantic unlock + verdict parsing
 * ──────────────────────────────────────────────────────────────────────────── */

describe('§7.123 — intent-router verdict parsing accepts the full category union', () => {
  it('parses a REJECT category out of malformed JSON (Tier 3 fallback)', () => {
    const verdict = parseClassificationVerdict('garbage { category: "REJECT", confidence: 0.9 } tail')
    assert.ok(verdict, 'REJECT 应能被 Tier 3 正则解析出来')
    assert.equal(verdict!.category, 'REJECT')
    assert.equal(verdict!.confidence, 0.9)
  })

  it('parses a SANITIZED category out of malformed JSON', () => {
    const verdict = parseClassificationVerdict('{category=SANITIZED, confidence=0.7}')
    assert.ok(verdict)
    assert.equal(verdict!.category, 'SANITIZED')
  })

  it('still rejects an unknown category (falls through to the rules tier)', () => {
    const verdict = parseClassificationVerdict('{ category: "WEIRD", confidence: 0.9 }')
    assert.equal(verdict, null)
  })

  it('Tier 1 direct JSON parse still wins and handles REJECT', () => {
    const verdict = coerceClassification({ category: 'reject', confidence: 0.95 })
    assert.ok(verdict)
    assert.equal(verdict!.category, 'REJECT')
  })
})

function chunksFromText(text: string): AsyncIterable<unknown> {
  return (async function* () {
    for (let i = 0; i < text.length; i += 8) {
      yield { type: 'text-delta', text: text.slice(i, i + 8) }
    }
  })()
}

function fakePolicy(stages?: { semanticCloudMinConfidence?: number }) {
  return {
    getIntentStages: () => stages,
    getCategories: () => [],
    matchRouting: () => null,
    on: () => {},
  }
}

/** intent-router fixture: fake policy + fake LLM + audit spy. */
function routerWith(opts: {
  policyStages?: { semanticCloudMinConfidence?: number }
  verdict: string
}) {
  const entries: any[] = []
  const ctx = {
    reflect: { provide: () => {} },
    llm: { stream: (_opts: unknown) => chunksFromText(opts.verdict) },
    privacyPolicy: fakePolicy(opts.policyStages),
  } as any
  const service = new IntentRouterServiceImpl(ctx, {
    defaultCategory: 'LOCAL',
    classificationProvider: 'local-llm',
    confidenceThreshold: 0.6,
  }, { entries, log: async (e: any) => { entries.push(e) } } as any)
  return { service, entries }
}

describe('§7.123 — semantic unlock requires a REPORTED confidence', () => {
  it('a synthetic confidence (confidenceReported === false) never unlocks the cloud', async () => {
    const { service, entries } = routerWith({
      policyStages: { semanticCloudMinConfidence: 0.5 },
      verdict: JSON.stringify({ category: 'CLOUD', confidence: 0.9 }),
    })
    // Force the "synthetic" provenance onto the verdict the way the bailian
    // decision-model path does.
    const original = (service as any).classifyWithLlm
    ;(service as any).classifyWithLlm = async (...args: any[]) => {
      const v = await original.apply(service, args)
      return { ...v, confidenceReported: false }
    }

    const intent = await service.classify('规划黄山两日游怎么安排')
    assert.equal(intent.category, 'LOCAL', '合成置信度不得解锁 CLOUD')
    assert.equal(intent.rationale, 'no-web-need')
    assert.ok(
      entries.some((e) => e.kind === 'intent.cloud.semantic-unlock-skipped'),
      '应留一条 semantic-unlock-skipped 审计',
    )
  })

  it('a reported confidence above the threshold DOES unlock the cloud', async () => {
    const { service } = routerWith({
      policyStages: { semanticCloudMinConfidence: 0.5 },
      verdict: JSON.stringify({ category: 'CLOUD', confidence: 0.9 }),
    })

    const intent = await service.classify('规划黄山两日游怎么安排')
    assert.equal(intent.category, 'CLOUD', '已上报的高置信度应放行')
  })

  it('without the semantic threshold configured the gate stays keyword-only', async () => {
    const { service } = routerWith({
      policyStages: {},
      verdict: JSON.stringify({ category: 'CLOUD', confidence: 0.99 }),
    })

    const intent = await service.classify('规划黄山两日游怎么安排')
    assert.equal(intent.category, 'LOCAL', '未配置阈值时 = 纯关键词闸门')
    assert.equal(intent.rationale, 'no-web-need')
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * 4 + 5. http-api — auth fail-closed + route param decoding
 * ──────────────────────────────────────────────────────────────────────────── */

describe('§7.123 — http-api-routes survives malformed percent-escapes', () => {
  const routes: RouteDef[] = [
    {
      method: 'GET',
      pattern: '/v1/sessions/{id}',
      auth: 'bearer',
      summary: 'get one session',
      handler: () => {},
    },
  ]

  it('a malformed escape does not throw (no URIError → no process crash)', () => {
    let matched: any
    assert.doesNotThrow(() => {
      matched = findRoute(routes, 'GET', '/v1/sessions/%zz')
    })
    assert.ok(matched, '路由仍应匹配')
  })

  it('a well-formed escape is still decoded', () => {
    const matched = findRoute(routes, 'GET', '/v1/sessions/abc%20def')
    assert.ok(matched)
    assert.equal(matched!.params.id, 'abc def')
  })
})

describe('§7.123 — http-api authentication fails closed', () => {
  /** Instantiate the service without booting a server. */
  function makeService(bearerToken?: string) {
    return new HttpApiServiceImpl(
      { reflect: { provide: () => {} }, on: () => () => {} } as any,
      { host: '127.0.0.1', port: 0, bearerToken } as any,
      undefined,
      undefined,
      undefined,
    )
  }

  it('denies every request when no bearer token is configured', () => {
    const svc = makeService(undefined)
    const req = { headers: { authorization: 'Bearer anything' } } as any
    assert.equal((svc as any).checkAuth(req), false, '未配置 token 时必须拒绝（fail-closed）')
  })

  it('denies an empty-string token as well', () => {
    const svc = makeService('')
    const req = { headers: { authorization: 'Bearer anything' } } as any
    assert.equal((svc as any).checkAuth(req), false)
  })

  it('accepts the exact bearer token', () => {
    const svc = makeService('s3cret')
    const ok = { headers: { authorization: 'Bearer s3cret' } } as any
    assert.equal((svc as any).checkAuth(ok), true)
  })

  it('rejects a wrong token, a wrong scheme, and a missing header', () => {
    const svc = makeService('s3cret')
    assert.equal((svc as any).checkAuth({ headers: { authorization: 'Bearer wrong' } } as any), false)
    assert.equal((svc as any).checkAuth({ headers: { authorization: 'Basic s3cret' } } as any), false)
    assert.equal((svc as any).checkAuth({ headers: {} } as any), false)
  })
})
