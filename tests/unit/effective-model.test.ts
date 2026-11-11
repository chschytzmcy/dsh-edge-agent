/**
 * §7.179 (2026-11-11): 内部阶段（guard 检测 / 意图分类）**真正会跑**的模型。
 *
 * 主人实测（2026-11-11 12:56）：DELEGATE 模式下（`llm.local.baseUrl` 留空），
 * 面板写「模型 local-llm/qwen3-4b」，而 wire 上跑的是宿主当前模型
 * `qwen-token-plan-cn/deepseek-v4.1-flash` —— 与实际行为相反。
 *
 * 本文件锁住解析口径：
 *   1. 直连池 ⇒ 池自己的 model（wire body 的 model 就是它）；
 *   2. DELEGATE ⇒ 与 local-llm-adapter **同一条**解析链的结果
 *      （env 显式 → selection 宿主选择 → probe 活拓扑）；
 *   3. 解析不到 ⇒ 退回请求值，并如实标出来处。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

import {
  resolveEffectiveLocalModelWith,
  type LocalPoolShape,
} from '../../src/dsh-adapter/effective-model.ts'

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * 假宿主 ctx：给 `llm`（活拓扑 + 模型目录）与 `agentDefaultModel`（宿主选择）。
 */
function fakeCtx(opts: {
  providers?: string[]
  selection?: { provider?: string; model?: string }
  models?: Record<string, Array<{ id: string }>>
  noLlm?: boolean
} = {}) {
  return {
    get(name: string) {
      if (name === 'llm') {
        if (opts.noLlm) return undefined
        return {
          listProviders: () => (opts.providers ?? []).map((id) => ({ id, name: id })),
          listModels: async (provider: string) => opts.models?.[provider] ?? [],
        }
      }
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => opts.selection }
      }
      throw new Error(`no service ${name}`)
    },
  }
}

const DELEGATE: LocalPoolShape = { delegate: true }

// ── 直连池 ──────────────────────────────────────────────────────────────────

describe('resolveEffectiveLocalModelWith — 直连池', () => {
  it('wire body 的 model 就是池自己的 model', async () => {
    const r = await resolveEffectiveLocalModelWith(
      fakeCtx(),
      { baseUrl: 'http://127.0.0.1:8080/v1', model: 'qwen3.8-flash', delegate: true },
      'qwen3-4b',
    )
    assert.equal(r.model, 'qwen3.8-flash')
    assert.equal(r.provider, 'local-llm')
    assert.equal(r.source, 'local-pool')
  })

  it('池没配 model ⇒ 退回调用方请求的值，并标出来处', async () => {
    const r = await resolveEffectiveLocalModelWith(
      fakeCtx(),
      { baseUrl: 'http://127.0.0.1:8080/v1', delegate: true },
      'qwen3-4b',
    )
    assert.equal(r.model, 'qwen3-4b')
    assert.equal(r.source, 'local-pool')
  })
})

// ── DELEGATE ────────────────────────────────────────────────────────────────

describe('resolveEffectiveLocalModelWith — DELEGATE（与 adapter 同一条解析链）', () => {
  it('宿主当前选择 ⇒ 用它，并记下真实落点（不是 local-llm）', async () => {
    const r = await resolveEffectiveLocalModelWith(
      fakeCtx({
        providers: ['qwen-token-plan-cn', 'local-llm'],
        selection: { provider: 'qwen-token-plan-cn', model: 'deepseek-v4.1-flash' },
      }),
      DELEGATE,
      'qwen3-4b',
    )
    assert.equal(r.model, 'deepseek-v4.1-flash')
    assert.equal(r.provider, 'qwen-token-plan-cn')
    assert.equal(r.source, 'host-delegate')
    assert.equal(r.via, 'selection')
  })

  it('显式 delegateProvider/delegateModel ⇒ 走 env 那一步', async () => {
    const r = await resolveEffectiveLocalModelWith(
      fakeCtx({
        providers: ['deepseek-official', 'local-llm'],
        selection: { provider: 'deepseek-official', model: 'deepseek-flash' },
      }),
      { delegate: true, delegateProvider: 'deepseek-official', delegateModel: 'deepseek-v4.1-flash' },
      'qwen3-4b',
    )
    assert.equal(r.model, 'deepseek-v4.1-flash')
    assert.equal(r.provider, 'deepseek-official')
    assert.equal(r.via, 'env')
  })

  it('没有宿主选择 ⇒ 活拓扑探针；model 取该 provider 的第一个 model id', async () => {
    const r = await resolveEffectiveLocalModelWith(
      fakeCtx({
        providers: ['llm-pi-ai', 'local-llm'],
        models: { 'llm-pi-ai': [{ id: 'deepseek-v4.1-flash' }] },
      }),
      DELEGATE,
      'qwen3-4b',
    )
    assert.equal(r.model, 'deepseek-v4.1-flash')
    assert.equal(r.provider, 'llm-pi-ai')
    assert.equal(r.source, 'host-delegate')
    assert.equal(r.via, 'probe')
  })

  it('探针步也拿不到 model id ⇒ 退回请求值，但落点照实记', async () => {
    const r = await resolveEffectiveLocalModelWith(
      fakeCtx({ providers: ['llm-pi-ai', 'local-llm'] }),
      DELEGATE,
      'qwen3-4b',
    )
    assert.equal(r.model, 'qwen3-4b')
    assert.equal(r.provider, 'llm-pi-ai')
    assert.equal(r.source, 'host-delegate')
  })

  it('宿主一个可用路由都没有 ⇒ 退回请求值', async () => {
    const r = await resolveEffectiveLocalModelWith(fakeCtx({ providers: ['local-llm'] }), DELEGATE, 'qwen3-4b')
    assert.equal(r.model, 'qwen3-4b')
    assert.equal(r.source, 'requested')
    assert.equal(r.provider, undefined)
  })

  it('kill switch（llm.local.delegate=false）⇒ 路由没注册 ⇒ 退回请求值', async () => {
    const r = await resolveEffectiveLocalModelWith(
      fakeCtx({
        providers: ['qwen-token-plan-cn'],
        selection: { provider: 'qwen-token-plan-cn', model: 'deepseek-v4.1-flash' },
      }),
      { delegate: false },
      'qwen3-4b',
    )
    assert.equal(r.model, 'qwen3-4b')
    assert.equal(r.source, 'requested')
  })

  it('读不到 llm 服务（最小图）⇒ 退回请求值，不抛', async () => {
    const r = await resolveEffectiveLocalModelWith(fakeCtx({ noLlm: true }), DELEGATE, 'qwen3-4b')
    assert.equal(r.model, 'qwen3-4b')
    assert.equal(r.source, 'requested')
  })
})
