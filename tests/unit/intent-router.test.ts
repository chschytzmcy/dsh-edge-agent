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
})
