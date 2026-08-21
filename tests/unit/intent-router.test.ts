/**
 * intent-router plugin tests — LLM-based classification + keyword fallback.
 *
 * Tests the rule-based fallback path (no real LLM call in unit tests).
 */

import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

import * as router from '../../src/dsh-adapter/intent-router.ts'
import { IntentRouterServiceImpl } from '../../src/dsh-adapter/intent-router.ts'

describe('intent-router', () => {
  it('exports the canonical plugin shape', () => {
    assert.equal(router.name, 'intent-router')
    assert.deepEqual([...router.inject], ['llm', 'auditLog'])
    assert.equal(typeof router.apply, 'function')
    assert.ok(router.Config)
  })

  it('classifies LOCAL intent via keyword rules (fallback)', async () => {
    // Create a context without real llm so the LLM path falls back to rules.
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: null,
    } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-qwen3-4b',
    })

    const intent = await service.classify('帮我读取文件内容')
    assert.equal(intent.category, 'LOCAL')
    assert.equal(intent.targetRealm, 'local')
    assert.equal(intent.requiresSanitization, false)
    assert.match(intent.rationale, /rule-keyword-match/u)
  })

  it('classifies CLOUD intent via keyword rules (fallback)', async () => {
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: null,
    } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-qwen3-4b',
    })

    const intent = await service.classify('解释一下量子力学')
    assert.equal(intent.category, 'CLOUD')
    assert.equal(intent.targetRealm, 'cloud')
  })

  it('falls back to defaultCategory when no keywords match', async () => {
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: null,
    } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-qwen3-4b',
    })

    const intent = await service.classify('你好')
    assert.equal(intent.category, 'CLOUD')
    assert.match(intent.rationale, /default:cloud/u)
  })

  it('marks requiresSanitization=false (M3 has no sanitization layer)', async () => {
    const mockCtx = {
      reflect: { provide: () => {} },
      llm: null,
    } as any
    const service = new IntentRouterServiceImpl(mockCtx, {
      defaultCategory: 'CLOUD',
      classificationProvider: 'local-qwen3-4b',
    })

    const intent = await service.classify('what is the weather')
    assert.equal(intent.requiresSanitization, false)
  })
})
