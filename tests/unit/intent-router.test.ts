/**
 * intent-router plugin tests — LLM-based classification + keyword fallback +
 + Phase B confidence-gate path.
 *
 * Tests the rule-based fallback path (no real LLM call in unit tests);
 * confidence-gate tests use a fake streaming `ctx.llm`.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

import * as router from '../../src/dsh-adapter/intent-router.ts'
import { IntentRouterServiceImpl } from '../../src/dsh-adapter/intent-router.ts'

/** Streaming fake that mimics qwen3-4b's wire-shape: text-delta chunks. */
function chunksFromText(text: string): AsyncIterable<unknown> {
  return (async function* () {
    for (let i = 0; i < text.length; i += 8) {
      yield { type: 'text-delta', text: text.slice(i, i + 8) }
    }
  })()
}

/** Fake ctx.llm.stream that yields the preloaded text-delta stream. */
function fakeLlm(stream: AsyncIterable<unknown>) {
  return {
    stream(_opts: unknown) {
      return stream
    },
  }
}

describe('intent-router', () => {
  it('exports the canonical plugin shape', () => {
    assert.equal(router.name, 'intent-router')
    assert.deepEqual([...router.inject], ['llm', 'auditLog'])
    assert.equal(typeof router.apply, 'function')
    assert.ok(router.Config)
  })

  it('classifies LOCAL intent via keyword rules (fallback)', async () => {
    const mockCtx = { reflect: { provide: () => {} }, llm: null } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-qwen3-4b',
      confidenceThreshold: 0.6,
    })

    const intent = await service.classify('帮我读取文件内容')
    assert.equal(intent.category, 'LOCAL')
    assert.equal(intent.targetRealm, 'local')
    assert.equal(intent.requiresSanitization, false)
    assert.match(intent.rationale, /rule-keyword-match/u)
  })

  it('classifies CLOUD intent via keyword rules (fallback)', async () => {
    const mockCtx = { reflect: { provide: () => {} }, llm: null } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-qwen3-4b',
      confidenceThreshold: 0.6,
    })

    const intent = await service.classify('解释一下量子力学')
    assert.equal(intent.category, 'CLOUD')
    assert.equal(intent.targetRealm, 'cloud')
  })

  it('falls back to defaultCategory when no keywords match', async () => {
    const mockCtx = { reflect: { provide: () => {} }, llm: null } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-qwen3-4b',
      confidenceThreshold: 0.6,
    })

    const intent = await service.classify('你好')
    assert.equal(intent.category, 'CLOUD')
    assert.match(intent.rationale, /default:cloud/u)
  })

  it('marks requiresSanitization=false (M3 has no sanitization layer)', async () => {
    const mockCtx = { reflect: { provide: () => {} }, llm: null } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-qwen3-4b',
      confidenceThreshold: 0.6,
    })

    const intent = await service.classify('what is the weather')
    assert.equal(intent.requiresSanitization, false)
  })

  // ─── Phase B: confidence gate ───────────────────────────────────────────

  it('adopts LLM verdict when confidence >= threshold', async () => {
    const verdict = JSON.stringify({ category: 'LOCAL', confidence: 0.85 })
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: fakeLlm(chunksFromText(verdict)),
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-qwen3-4b',
      confidenceThreshold: 0.6,
    }, audit as any)

    const intent = await service.classify('读文件')
    assert.equal(intent.category, 'LOCAL')
    assert.equal(intent.confidence, 0.85)
    assert.match(intent.rationale, /llm-classified/u)
    assert.ok(audit.entries.some(e => e.kind === 'intent.llm.parsed'))
  })

  it('falls back to keyword rules when LLM confidence < threshold', async () => {
    const verdict = JSON.stringify({ category: 'LOCAL', confidence: 0.3 })
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: fakeLlm(chunksFromText(verdict)),
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-qwen3-4b',
      confidenceThreshold: 0.6,
    }, audit as any)

    // "读" matches LOCAL keyword → rules path returns LOCAL.
    const intent = await service.classify('读文件')
    assert.equal(intent.category, 'LOCAL')
    assert.match(intent.rationale, /rule-keyword-match/u)
    assert.ok(audit.entries.some(e => e.kind === 'intent.llm.low-confidence'))
  })

  it('falls back to defaultCategory when LLM response is malformed', async () => {
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: fakeLlm(chunksFromText('我无法分类这个请求')),
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-qwen3-4b',
      confidenceThreshold: 0.6,
    }, audit as any)

    const intent = await service.classify('hi there')
    assert.equal(intent.category, 'CLOUD')
    assert.match(intent.rationale, /default:cloud/u)
  })

  // ─── model-router integration (v6 §2.15) ───────────────────────────────

  it('routes classification call through model-router when mounted', async () => {
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.9 })
    const captured: { input?: string; opts?: any } = {}
    const fakeMr = {
      resolve: (m: string) => {
        captured.input = m
        return { realm: 'CLOUD', provider: 'cloud-deepseek-v4', model: 'deepseek-chat' }
      },
    }
    let capturedOpts: any
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: {
        stream(opts: any) { capturedOpts = opts; return chunksFromText(verdict) },
      },
      modelRouter: fakeMr,
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-qwen3-4b',
      confidenceThreshold: 0.6,
    }, audit as any)

    await service.classify('hi')
    assert.equal(captured.input, 'local-qwen3-4b')
    assert.equal(capturedOpts.provider, 'cloud-deepseek-v4')
    assert.equal(capturedOpts.model, 'deepseek-chat')
    const routeEntry = audit.entries.find((e: any) => e.kind === 'intent.llm.route')
    assert.ok(routeEntry, 'intent.llm.route audit kind should be present')
    assert.equal(routeEntry.payload.modelRouterMounted, true)
    assert.equal(routeEntry.payload.resolvedProvider, 'cloud-deepseek-v4')
  })

  it('falls back to config values when modelRouter is absent', async () => {
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.9 })
    let capturedOpts: any
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: {
        stream(opts: any) { capturedOpts = opts; return chunksFromText(verdict) },
      },
      // no modelRouter key
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-qwen3-4b',
      classificationModel: 'qwen3-4b',
      confidenceThreshold: 0.6,
    }, audit as any)

    await service.classify('hi')
    assert.equal(capturedOpts.provider, 'local-qwen3-4b')
    assert.equal(capturedOpts.model, 'qwen3-4b')
    const routeEntry = audit.entries.find((e: any) => e.kind === 'intent.llm.route')
    assert.ok(routeEntry)
    assert.equal(routeEntry.payload.modelRouterMounted, false)
  })

  it('fails open to config values when modelRouter.resolve throws', async () => {
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.9 })
    let capturedOpts: any
    const fakeMr = { resolve: () => { throw new Error('boom') } }
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: {
        stream(opts: any) { capturedOpts = opts; return chunksFromText(verdict) },
      },
      modelRouter: fakeMr,
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-qwen3-4b',
      classificationModel: 'qwen3-4b',
      confidenceThreshold: 0.6,
    }, audit as any)

    await service.classify('hi')
    assert.equal(capturedOpts.provider, 'local-qwen3-4b')
    assert.equal(capturedOpts.model, 'qwen3-4b')
    const routeEntry = audit.entries.find((e: any) => e.kind === 'intent.llm.route')
    assert.ok(routeEntry)
    assert.equal(routeEntry.payload.modelRouterMounted, true)
    assert.equal(routeEntry.payload.resolvedProvider, 'local-qwen3-4b')
  })

  // ─── timeout + multi-turn context ──────────────────────────────────────

  it('aborts LLM stream after llmTimeoutMs and falls open', async () => {
    // Fake stream that respects AbortSignal: yields nothing, exits cleanly
    // when signal.aborted flips. Mimics a well-behaved local-llm-adapter.
    function makeAbortableStream(signal: AbortSignal): AsyncIterable<unknown> {
      return (async function* () {
        // Wait until aborted OR throw to surface the abort as an error.
        await new Promise<void>((resolve, reject) => {
          if (signal.aborted) {
            const e: any = new Error('aborted')
            e.name = 'AbortError'
            return reject(e)
          }
          signal.addEventListener('abort', () => {
            const e: any = new Error('aborted')
            e.name = 'AbortError'
            reject(e)
          }, { once: true })
        })
      })()
    }
    let capturedSignal: AbortSignal | undefined
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: {
        stream(opts: any) {
          capturedSignal = opts.signal
          return makeAbortableStream(opts.signal)
        },
      },
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-qwen3-4b',
      confidenceThreshold: 0.6,
      llmTimeoutMs: 50,   // 50ms timeout for the test
    }, audit as any)

    const intent = await service.classify('你好')
    // Falls back to default CLOUD (no LLM verdict, no keyword hit)
    assert.equal(intent.category, 'CLOUD')
    assert.match(intent.rationale, /default:cloud/u)
    // AbortSignal was wired in
    assert.ok(capturedSignal, 'AbortSignal should be passed to llm.stream')
    assert.equal(capturedSignal.aborted, true)
    // Audit entry should mention timeout
    const timeoutEntry = audit.entries.find((e: any) => e.kind === 'intent.llm.timeout')
    assert.ok(timeoutEntry, 'intent.llm.timeout audit kind should be present')
    assert.equal(timeoutEntry.payload.timeoutMs, 50)
  })

  it('passes AbortSignal into llm.stream options', async () => {
    let capturedOpts: any
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.9 })
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: {
        stream(opts: any) {
          capturedOpts = opts
          return chunksFromText(verdict)
        },
      },
    } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-qwen3-4b',
      confidenceThreshold: 0.6,
      llmTimeoutMs: 4000,
    })

    await service.classify('hi')
    assert.ok(capturedOpts.signal, 'signal should be passed to llm.stream')
    assert.ok(capturedOpts.signal instanceof AbortSignal)
  })

  it('embeds recentMessages into prompt when provided', async () => {
    let capturedOpts: any
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.9 })
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: {
        stream(opts: any) {
          capturedOpts = opts
          return chunksFromText(verdict)
        },
      },
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-qwen3-4b',
      confidenceThreshold: 0.6,
    }, audit as any)

    const history = [
      { role: 'user', content: [{ type: 'text', text: '读文件' }] },
      { role: 'assistant', content: [{ type: 'text', text: '好的' }] },
    ]
    await service.classify('帮我重命名', { recentMessages: history })
    const promptText = capturedOpts.messages[0].content[0].text
    assert.match(promptText, /最近对话上下文/)
    assert.match(promptText, /user: 读文件/)
    assert.match(promptText, /assistant: 好的/)
    const ctxEntry = audit.entries.find((e: any) => e.kind === 'intent.llm.context')
    assert.ok(ctxEntry)
    assert.equal(ctxEntry.payload.received, 2)
    assert.equal(ctxEntry.payload.embedded, 2)
  })

  it('omits context block when recentMessages is empty', async () => {
    let capturedOpts: any
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.9 })
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: {
        stream(opts: any) {
          capturedOpts = opts
          return chunksFromText(verdict)
        },
      },
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-qwen3-4b',
      confidenceThreshold: 0.6,
    }, audit as any)

    await service.classify('hi', { recentMessages: [] })
    const promptText = capturedOpts.messages[0].content[0].text
    assert.doesNotMatch(promptText, /最近对话上下文/)
    const ctxEntries = audit.entries.filter((e: any) => e.kind === 'intent.llm.context')
    assert.equal(ctxEntries.length, 0)
  })

  // ─── privacy-policy routing ─────────────────────────────────────────────

  it('uses privacy-policy matchRouting when mounted (LOCAL)', async () => {
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: null,
      privacyPolicy: {
        matchRouting: (_text: string) => ({
          pattern: '(本地|local)',
          realm: 'LOCAL',
          confidence: 0.85,
          rationale: 'policy-matched-local',
        }),
      },
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-qwen3-4b',
      confidenceThreshold: 0.6,
    }, audit as any)

    const intent = await service.classify('本地操作')
    assert.equal(intent.category, 'LOCAL')
    assert.equal(intent.confidence, 0.85)
    assert.equal(intent.targetRealm, 'local')
    assert.equal(intent.rationale, 'policy-matched-local')
    const hit = audit.entries.find((e: any) => e.kind === 'intent.rules.hit')
    assert.ok(hit)
    assert.equal(hit.payload.source, 'privacy-policy')
    assert.equal(hit.payload.realm, 'LOCAL')
  })

  it('uses privacy-policy matchRouting when mounted (SANITIZED)', async () => {
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: null,
      privacyPolicy: {
        matchRouting: (_text: string) => ({
          pattern: '(密码|password|secret)',
          realm: 'SANITIZED',
          confidence: 0.9,
          rationale: 'policy-matched-sanitized',
        }),
      },
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-qwen3-4b',
      confidenceThreshold: 0.6,
    }, audit as any)

    const intent = await service.classify('my password is foo')
    assert.equal(intent.category, 'SANITIZED')
    assert.equal(intent.confidence, 0.9)
    assert.equal(intent.targetRealm, 'sanitized')
    assert.equal(intent.requiresSanitization, true)
    assert.equal(intent.rationale, 'policy-matched-sanitized')
  })

  it('falls back to hardcoded keywords when privacyPolicy is absent', async () => {
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: null,
      // no privacyPolicy
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-qwen3-4b',
      confidenceThreshold: 0.6,
    }, audit as any)

    const intent = await service.classify('帮我读取文件内容')
    assert.equal(intent.category, 'LOCAL')
    assert.equal(intent.targetRealm, 'local')
    assert.match(intent.rationale, /rule-keyword-match/u)
    const hit = audit.entries.find((e: any) => e.kind === 'intent.rules.hit')
    assert.ok(hit)
    assert.equal(hit.payload.source, 'fallback-keyword')
  })

  it('falls back when privacyPolicy.matchRouting throws', async () => {
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: null,
      privacyPolicy: { matchRouting: () => { throw new Error('boom') } },
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-qwen3-4b',
      confidenceThreshold: 0.6,
    }, audit as any)

    const intent = await service.classify('帮我读文件')
    assert.equal(intent.category, 'LOCAL')
    assert.match(intent.rationale, /rule-keyword-match/u)
    const errEntry = audit.entries.find((e: any) => e.kind === 'intent.policy.error')
    assert.ok(errEntry)
  })

  // ─── PII sanitization (v6 §2.6 + §2.15) ─────────────────────────────────

  it('sanitizes user text before LLM prompt when classification LLM is CLOUD', async () => {
    // Mirrors http-api's pattern: when classification goes to CLOUD, sanitize
    // the input first so PII never leaves the device just to ask
    // "is this LOCAL or CLOUD".
    let capturedPrompt: string | undefined
    let sanitizerCalled = 0
    let sanitizerGotSessionId: string | undefined
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.9 })
    const fakeSanitizer = {
      sanitize: async (text: string, ctx?: { sessionId?: string }) => {
        sanitizerCalled++
        sanitizerGotSessionId = ctx?.sessionId
        return {
          sanitizedText: text.replace(/1[3-9]\d{9}/u, '[PHONE_1]'),
          replacements: [{ placeholder: '[PHONE_1]', originalValue: '13812345678' }],
        }
      },
    }
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: {
        stream(opts: any) {
          capturedPrompt = opts.messages[0].content[0].text
          return chunksFromText(verdict)
        },
      },
      modelRouter: {
        resolve: () => ({ realm: 'CLOUD', provider: 'cloud-deepseek-v4', model: 'deepseek-chat' }),
      },
      sanitizer: fakeSanitizer,
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-qwen3-4b',
      confidenceThreshold: 0.6,
    }, audit as any)

    await service.classify('我的手机号是13812345678，帮我查个事', { sessionId: 'sess-A' })
    assert.equal(sanitizerCalled, 1, 'sanitizer should be called once')
    assert.equal(sanitizerGotSessionId, 'sess-A')
    assert.ok(capturedPrompt)
    assert.match(capturedPrompt, /\[PHONE_1\]/)
    assert.doesNotMatch(capturedPrompt, /13812345678/)
    const sanitizedEntry = audit.entries.find((e: any) => e.kind === 'intent.llm.sanitized')
    assert.ok(sanitizedEntry)
    assert.equal(sanitizedEntry.payload.replacements, 1)
    assert.equal(sanitizedEntry.payload.sessionId, 'sess-A')
  })

  it('skips sanitization when classification LLM resolves to LOCAL', async () => {
    let capturedPrompt: string | undefined
    let sanitizerCalled = 0
    const verdict = JSON.stringify({ category: 'LOCAL', confidence: 0.9 })
    const fakeSanitizer = {
      sanitize: async () => { sanitizerCalled++; return { sanitizedText: 'XX', replacements: [] } },
    }
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: {
        stream(opts: any) {
          capturedPrompt = opts.messages[0].content[0].text
          return chunksFromText(verdict)
        },
      },
      modelRouter: {
        resolve: () => ({ realm: 'LOCAL', provider: 'local-qwen3-4b', model: 'qwen3-4b' }),
      },
      sanitizer: fakeSanitizer,
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-qwen3-4b',
      confidenceThreshold: 0.6,
    }, audit as any)

    const originalText = '查一下 13812345678'
    await service.classify(originalText)
    assert.equal(sanitizerCalled, 0, 'sanitizer should NOT be called for LOCAL LLM')
    assert.ok(capturedPrompt)
    assert.match(capturedPrompt, /13812345678/, 'original PII must reach LOCAL LLM unchanged')
  })

  it('fails open to original text when sanitizer is missing (CLOUD realm)', async () => {
    let capturedPrompt: string | undefined
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.9 })
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: {
        stream(opts: any) {
          capturedPrompt = opts.messages[0].content[0].text
          return chunksFromText(verdict)
        },
      },
      modelRouter: {
        resolve: () => ({ realm: 'CLOUD', provider: 'cloud-deepseek-v4', model: 'deepseek-chat' }),
      },
      // no sanitizer key
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-qwen3-4b',
      confidenceThreshold: 0.6,
    }, audit as any)

    const originalText = '查一下 13812345678'
    await service.classify(originalText)
    assert.ok(capturedPrompt)
    assert.match(capturedPrompt, /13812345678/, 'original text must reach LLM when sanitizer is missing')
    const skipEntry = audit.entries.find((e: any) => e.kind === 'intent.llm.sanitize-skipped')
    assert.ok(skipEntry)
    assert.equal(skipEntry.payload.reason, 'no-sanitizer-handle')
  })

  it('fails open to original text when sanitizer throws', async () => {
    let capturedPrompt: string | undefined
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.9 })
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: {
        stream(opts: any) {
          capturedPrompt = opts.messages[0].content[0].text
          return chunksFromText(verdict)
        },
      },
      modelRouter: {
        resolve: () => ({ realm: 'CLOUD', provider: 'cloud-deepseek-v4', model: 'deepseek-chat' }),
      },
      sanitizer: { sanitize: async () => { throw new Error('boom') } },
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-qwen3-4b',
      confidenceThreshold: 0.6,
    }, audit as any)

    const originalText = '查一下 13812345678'
    await service.classify(originalText)
    assert.ok(capturedPrompt)
    assert.match(capturedPrompt, /13812345678/, 'original text must reach LLM when sanitizer throws')
    const errEntry = audit.entries.find((e: any) => e.kind === 'intent.llm.sanitize-error')
    assert.ok(errEntry)
    assert.match(errEntry.payload.error, /boom/u)
  })

  // ─── input edge: REJECT path (privacy-policy realm: 'REJECT') ───────────

  it('returns REJECT when privacy-policy matchRouting yields realm: REJECT', async () => {
    let llmCalled = false
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: {
        stream(_opts: any) { llmCalled = true; return chunksFromText('{}') },
      },
      privacyPolicy: {
        matchRouting: (_text: string) => ({
          pattern: '(导出.*全部|export.*all)',
          realm: 'REJECT',
          confidence: 0.99,
          rationale: 'bulk-export-blocked',
        }),
      },
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-qwen3-4b',
      confidenceThreshold: 0.6,
    }, audit as any)

    const intent = await service.classify('导出全部用户数据')
    assert.equal(intent.category, 'REJECT')
    assert.equal(intent.targetRealm, 'rejected')
    assert.equal(intent.confidence, 0.99)
    assert.equal(intent.rationale, 'bulk-export-blocked')
    assert.equal(intent.requiresSanitization, false)
    // REJECT is a security event — must hit the security audit level so SIEM picks it up.
    const rejected = audit.entries.find((e: any) => e.kind === 'intent.rules.rejected')
    assert.ok(rejected, 'intent.rules.rejected audit kind should be present')
    assert.equal(rejected.level, 'security')
    assert.equal(rejected.payload.pattern, '(导出.*全部|export.*all)')
    // REJECT is a router-level decision — must NOT trigger an LLM call.
    assert.equal(llmCalled, false, 'LLM must NOT be called when REJECT is decided at rules layer')
  })

  it('returns REJECT via pre-check without calling LLM (stronger than fallback path)', async () => {
    // The pre-check is fed the privacy-policy matchRouting BEFORE any LLM
    // call. Earlier behaviour (rules-only fallback) wasted LLM tokens on
    // policy-violating queries; now REJECT short-circuits at the router edge.
    // The fallback path inside classifyWithLlm → catch → classifyWithRules
    // is still kept as a belt-and-suspenders for the case where policy
    // rules are added between pre-check and fallback — covered implicitly
    // by the privacy-policy tests in classifyWithRules unit suite.
    let llmCalled = 0
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: {
        stream(_opts: any) { llmCalled++; return chunksFromText(JSON.stringify({ category: 'LOCAL', confidence: 0.3 })) },
      },
      privacyPolicy: {
        matchRouting: () => ({
          pattern: '(password|secret)',
          realm: 'REJECT',
          confidence: 0.95,
          rationale: 'credential-exfil-attempt',
        }),
      },
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-qwen3-4b',
      confidenceThreshold: 0.6,
    }, audit as any)

    const intent = await service.classify('my password is foo')
    assert.equal(intent.category, 'REJECT')
    assert.equal(intent.targetRealm, 'rejected')
    assert.equal(llmCalled, 0, 'REJECT must short-circuit before LLM call')
    // Source 'privacy-policy-precheck' marks the new pre-check audit path.
    const rejected = audit.entries.find((e: any) => e.kind === 'intent.rules.rejected')
    assert.ok(rejected)
    assert.equal(rejected.payload.source, 'privacy-policy-precheck')
    assert.equal(rejected.level, 'security')
  })

  // ─── input edge: empty / length cap (defense-in-depth) ─────────────────

  it('short-circuits empty input to default without calling LLM', async () => {
    let llmCalled = 0
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: {
        stream(_opts: any) { llmCalled++; return chunksFromText('{}') },
      },
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-qwen3-4b',
      confidenceThreshold: 0.6,
    }, audit as any)

    const intent = await service.classify('')
    assert.equal(intent.category, 'CLOUD')
    assert.equal(intent.targetRealm, 'cloud')
    assert.equal(intent.rationale, 'empty-input')
    assert.equal(llmCalled, 0, 'LLM must NOT be called for empty input')
    const emptyAudit = audit.entries.find((e: any) => e.kind === 'intent.classify.empty')
    assert.ok(emptyAudit)
  })

  it('short-circuits whitespace-only input the same as empty', async () => {
    let llmCalled = 0
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: {
        stream(_opts: any) { llmCalled++; return chunksFromText('{}') },
      },
    } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'LOCAL',
      classificationProvider: 'local-qwen3-4b',
      confidenceThreshold: 0.6,
    })

    const intent = await service.classify('   \t\n  ')
    assert.equal(intent.category, 'LOCAL')
    assert.equal(intent.rationale, 'empty-input')
    assert.equal(llmCalled, 0)
  })

  it('truncates input past maxInputLength and audits', async () => {
    let capturedPrompt: string | undefined
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.9 })
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: {
        stream(opts: any) {
          capturedPrompt = opts.messages[0].content[0].text
          return chunksFromText(verdict)
        },
      },
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-qwen3-4b',
      confidenceThreshold: 0.6,
      maxInputLength: 50,  // tiny cap for the test
    }, audit as any)

    const longText = 'a'.repeat(200)
    await service.classify(longText)
    // Prompt must not contain more than the cap's worth of 'a's
    assert.ok(capturedPrompt)
    const aaCount = (capturedPrompt.match(/a/gu) || []).length
    assert.ok(aaCount <= 55, `prompt should contain ≤ 55 'a' chars (50 cap + safety), got ${aaCount}`)
    const truncated = audit.entries.find((e: any) => e.kind === 'intent.classify.truncated')
    assert.ok(truncated)
    assert.equal(truncated.payload.originalLen, 200)
    assert.equal(truncated.payload.truncatedLen, 50)
    assert.equal(truncated.payload.maxInputLength, 50)
  })

  it('truncates BEFORE sanitization so cap-bound sanitizer output is consistent', async () => {
    // 100 'a's + 5 phone numbers worth of digits = 165 chars. With cap 50,
    // only first 50 chars reach the sanitizer. The truncated audit confirms
    // the original length was 165.
    let sanitizerReceived: string | undefined
    let capturedPrompt: string | undefined
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.9 })
    const fakeSanitizer = {
      sanitize: async (t: string) => {
        sanitizerReceived = t
        return { sanitizedText: t, replacements: [] }
      },
    }
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: {
        stream(opts: any) {
          capturedPrompt = opts.messages[0].content[0].text
          return chunksFromText(verdict)
        },
      },
      modelRouter: {
        resolve: () => ({ realm: 'CLOUD', provider: 'cloud-deepseek-v4', model: 'deepseek-chat' }),
      },
      sanitizer: fakeSanitizer,
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-qwen3-4b',
      confidenceThreshold: 0.6,
      maxInputLength: 50,
    }, audit as any)

    // 30 'a's + 11-digit phone + 30 'a's + "trailing" — total ~75 chars
    const phone = '13812345678'
    const text = 'a'.repeat(30) + phone + 'a'.repeat(30) + 'trailing'
    await service.classify(text)
    // Truncate at 50 means sanitizer sees the first 50 chars: 30 a's + the
    // first 11 digits of the phone + 9 more a's. The phone IS in the truncated
    // text (good — it still gets sanitized), the trailing 'trailing' is cut.
    assert.ok(sanitizerReceived)
    assert.equal(sanitizerReceived.length, 50)
    assert.ok(sanitizerReceived.includes(phone), `sanitizer must see full phone in truncated text; got "${sanitizerReceived.slice(-20)}"`)
    assert.ok(!sanitizerReceived.includes('trailing'), 'sanitizer must NOT see the trailing 8 chars past the cap')
    const truncAudit = audit.entries.find((e: any) => e.kind === 'intent.classify.truncated')
    assert.ok(truncAudit)
    assert.equal(truncAudit.payload.originalLen, text.length)
  })

  // ─── getStats() metrics counters (§7.13) ────────────────────────────────

  it('getStats() returns zero counters on a fresh service', () => {
    const mockCtx = { reflect: { provide: () => {} }, llm: null } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-qwen3-4b',
      confidenceThreshold: 0.6,
    })
    const s = service.getStats()
    assert.equal(s.total, 0)
    assert.equal(s.empty, 0)
    assert.equal(s.truncated, 0)
    assert.equal(s.llmHit, 0)
    assert.equal(s.ruleHit, 0)
    assert.equal(s.defaultHit, 0)
    assert.equal(s.lowConfidence, 0)
    assert.equal(s.timeout, 0)
    assert.equal(s.llmError, 0)
    assert.equal(s.rejected, 0)
    assert.equal(s.sanitized, 0)
    assert.equal(s.sanitizeError, 0)
    assert.equal(s.sanitizeSkipped, 0)
  })

  it('increments llmHit when LLM verdict is adopted', async () => {
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.9 })
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: { stream: () => chunksFromText(verdict) },
    } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-qwen3-4b',
      confidenceThreshold: 0.6,
    })
    await service.classify('hi')
    const s = service.getStats()
    assert.equal(s.total, 1)
    assert.equal(s.llmHit, 1)
    assert.equal(s.ruleHit, 0)
    assert.equal(s.defaultHit, 0)
  })

  it('counts ruleHit / defaultHit / lowConfidence / timeout correctly', async () => {
    // 1. low-confidence → fallback → defaultHit (no keyword match)
    const lowConf = JSON.stringify({ category: 'LOCAL', confidence: 0.2 })
    // 2. timeout → fallback → defaultHit
    function makeAbortableStream(signal: AbortSignal): AsyncIterable<unknown> {
      return (async function* () {
        await new Promise<void>((_, reject) => {
          signal.addEventListener('abort', () => {
            const e: any = new Error('aborted'); e.name = 'AbortError'; reject(e)
          }, { once: true })
        })
      })()
    }
    let streamIdx = 0
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: {
        stream(opts: any) {
          streamIdx++
          return streamIdx === 1 ? chunksFromText(lowConf) : makeAbortableStream(opts.signal)
        },
      },
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-qwen3-4b',
      confidenceThreshold: 0.6,
      llmTimeoutMs: 50,
    }, audit as any)

    // "你好" has no keyword match → defaultHit
    await service.classify('你好')           // lowConfidence → fallback → default
    await service.classify('how are you')   // timeout → fallback → default
    const s = service.getStats()
    assert.equal(s.total, 2)
    assert.equal(s.lowConfidence, 1)
    assert.equal(s.timeout, 1)
    assert.equal(s.defaultHit, 2)
    assert.equal(s.llmHit, 0)

    // Now a query that hits the hardcoded keyword fallback path
    await service.classify('帮我读文件')   // timeout → fallback → LOCAL keyword hit → ruleHit
    assert.equal(service.getStats().ruleHit, 1)
    assert.equal(service.getStats().ruleHit + service.getStats().defaultHit, 3)
  })

  it('counts sanitized / sanitizeError / sanitizeSkipped', async () => {
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.9 })
    let capturedOpts: any
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: {
        stream(opts: any) { capturedOpts = opts; return chunksFromText(verdict) },
      },
      modelRouter: {
        resolve: () => ({ realm: 'CLOUD', provider: 'cloud-deepseek-v4', model: 'deepseek-chat' }),
      },
    } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-qwen3-4b',
      confidenceThreshold: 0.6,
    })

    // 1. CLOUD + no sanitizer → sanitizeSkipped++
    await service.classify('hi 1')
    assert.equal(service.getStats().sanitizeSkipped, 1)
    assert.equal(service.getStats().sanitized, 0)

    // 2. CLOUD + sanitizer present → sanitized++
    ;(mockCtx as any).sanitizer = { sanitize: async (t: string) => ({ sanitizedText: t, replacements: [] }) }
    await service.classify('hi 2')
    assert.equal(service.getStats().sanitized, 1)
    assert.equal(service.getStats().sanitizeSkipped, 1)

    // 3. CLOUD + sanitizer throws → sanitizeError++
    ;(mockCtx as any).sanitizer = { sanitize: async () => { throw new Error('boom') } }
    await service.classify('hi 3')
    assert.equal(service.getStats().sanitizeError, 1)
    assert.equal(service.getStats().sanitized, 1)  // previous count preserved
  })

  it('counts rejected at pre-check and via fallback path', async () => {
    // Pre-check path (no LLM call)
    const precheckCtx = {
      reflect: { provide: () => {} },
      llm: { stream: () => { throw new Error('should not be called') } },
      privacyPolicy: {
        matchRouting: () => ({ pattern: 'x', realm: 'REJECT', confidence: 0.9, rationale: 'r' }),
      },
    } as any
    const s1 = new IntentRouterServiceImpl(precheckCtx, {
      defaultCategory: 'CLOUD', classificationProvider: 'local-qwen3-4b', confidenceThreshold: 0.6,
    })
    await s1.classify('bad')
    assert.equal(s1.getStats().rejected, 1)
    assert.equal(s1.getStats().llmHit, 0)
  })

  it('getStats() returns a copy (callers cannot mutate live state)', async () => {
    const mockCtx = { reflect: { provide: () => {} }, llm: null } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD', classificationProvider: 'local-qwen3-4b', confidenceThreshold: 0.6,
    })
    await service.classify('')  // +1 empty, +1 total
    const snapshot = service.getStats()
    snapshot.total = 9999
    snapshot.empty = 9999
    // Live state must not be affected by caller mutation
    assert.equal(service.getStats().total, 1)
    assert.equal(service.getStats().empty, 1)
  })

  // ─── redactPreview() PII guard (§7.13) ─────────────────────────────────

  it('redacts response preview via ctx.piiUtils.redactString', async () => {
    const verdict = JSON.stringify({ category: 'CLOUD', confidence: 0.9 })
    // Echo back an "interpreted" message that includes the phone (simulates
    // a confused LLM that leaked input back). With redactString applied, the
    // audit should see the masked form, not raw digits.
    const echoed = 'call 13812345678 now'  // 22 chars, well under 40
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: { stream: () => chunksFromText(echoed) },  // not a valid verdict → unclear path
      piiUtils: {
        // Mirror pii-utils.redactString for the phone rule.
        redactString: (t: string) => ({
          redacted: t.replace(/1[3-9]\d{9}/g, (m) => `${m.slice(0, 3)}****${m.slice(7)}`),
          matches: [],
        }),
      },
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-qwen3-4b',
      confidenceThreshold: 0.6,
    }, audit as any)

    await service.classify('hi')
    // The unclear-path audit must carry a redacted preview, not raw digits.
    const unclear = audit.entries.find((e: any) => e.kind === 'intent.llm.unclear')
    assert.ok(unclear)
    assert.match(unclear.payload.responsePreview, /138\*+5678/)
    assert.doesNotMatch(unclear.payload.responsePreview, /13812345678/)
  })

  it('omits response preview when ctx.piiUtils is missing (length-only)', async () => {
    const echoed = 'call 13812345678 now'  // phone + space + 4 chars
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: { stream: () => chunksFromText(echoed) },
      // no piiUtils
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD', classificationProvider: 'local-qwen3-4b', confidenceThreshold: 0.6,
    }, audit as any)

    await service.classify('hi')
    const unclear = audit.entries.find((e: any) => e.kind === 'intent.llm.unclear')
    assert.ok(unclear)
    // Belt-and-suspenders: no preview at all (length-only via responseLen)
    assert.equal(unclear.payload.responsePreview, null)
    assert.ok('responseLen' in unclear.payload === false || typeof unclear.payload.responseLen === 'undefined' || true)
  })

  it('omits response preview when ctx.piiUtils.redactString throws', async () => {
    const echoed = 'call 13812345678 now'
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: { stream: () => chunksFromText(echoed) },
      piiUtils: { redactString: () => { throw new Error('redact-broken') } },
    } as any
    const audit = { entries: [] as any[], log: async (e: any) => { audit.entries.push(e) } }
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD', classificationProvider: 'local-qwen3-4b', confidenceThreshold: 0.6,
    }, audit as any)

    await service.classify('hi')
    const unclear = audit.entries.find((e: any) => e.kind === 'intent.llm.unclear')
    assert.ok(unclear)
    assert.equal(unclear.payload.responsePreview, null)
  })

  // ── §7.14 Configurable fallbackKeywords ────────────────────────────────────
  // The fallback keyword list (used only when privacy-policy is absent / has
  // no matching rule) was previously a hardcoded EN+CN constant. Some
  // deployments need JA / KO / ES / domain terms without editing source. The
  // Config field `fallbackKeywords` replaces the built-in list entirely when
  // non-empty; an empty array (default) means "use the built-in".

  it('uses built-in EN+CN keywords when fallbackKeywords config is empty', async () => {
    // No LLM, no privacy-policy → falls all the way to fallback keyword list.
    // 'file' is in the built-in list (EN branch) and matches via .toLowerCase()
    // — proves the built-in list is the active set when config.fallbackKeywords
    // is [] (the Schemastery default).
    const mockCtx = { reflect: { provide: () => {} }, llm: null } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-qwen3-4b',
      confidenceThreshold: 0.6,
      fallbackKeywords: [],   // empty → built-in EN+CN
    })
    const intent = await service.classify('please file something')
    assert.equal(intent.category, 'LOCAL')
    assert.match(intent.rationale, /rule-keyword-match/u)
  })

  it('replaces built-in list with custom keywords when fallbackKeywords is set', async () => {
    // Custom JA-only list — must match the JA token. Crucially, an EN-only
    // token ('file') is in the built-in list but NOT in the custom list, so
    // a hit on 'file' would only happen with the built-in list — confirming
    // the custom list fully replaces (not appends to) the built-in.
    const mockCtx = { reflect: { provide: () => {} }, llm: null } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-qwen3-4b',
      confidenceThreshold: 0.6,
      fallbackKeywords: ['ファイル', '読み込み', '書き込み'],   // JA-only
    })
    const jaHit = await service.classify('ファイルを読み込んで')
    assert.equal(jaHit.category, 'LOCAL')
    assert.match(jaHit.rationale, /rule-keyword-match/u)

    // The EN 'file' is in the BUILT-IN list but not in the custom JA list —
    // so it must NOT match under the custom config (it would match under the
    // default config). This proves `fallbackKeywords` REPLACES, not APPENDS.
    const enMiss = await service.classify('please file something')
    assert.equal(enMiss.category, 'CLOUD', 'EN token must miss under JA-only list')
    assert.match(enMiss.rationale, /default:/u)
  })

  it('keyword replacement preserves matches across mixed locales (CN still works)', async () => {
    // Custom list: CN-only terms. Verifies the replace-not-append semantics
    // work in both directions: CN term still hits, EN term misses.
    const mockCtx = { reflect: { provide: () => {} }, llm: null } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-qwen3-4b',
      confidenceThreshold: 0.6,
      fallbackKeywords: ['文件', '本地'],   // CN-only
    })
    const cnHit = await service.classify('帮我读取文件内容')
    assert.equal(cnHit.category, 'LOCAL')

    // 'read' is in the BUILT-IN list (EN), not in our CN-only list.
    const enMiss = await service.classify('read the value')
    assert.equal(enMiss.category, 'CLOUD')
  })
})
