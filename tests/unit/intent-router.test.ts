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
})
