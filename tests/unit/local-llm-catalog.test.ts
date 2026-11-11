/**
 * §7.180 (2026-11-11): 本地池在宿主**模型目录**里的声明。
 *
 * 主人实测（2026-11-11 13:52，桌面 App）：边缘模式会话在输入框下方的
 * 宿主模型选择器里显示「请选择模型」。
 *
 * 根因（宿主源码查实）：
 *   - `dsh-api-session-controller` 的 `buildModelCatalog` 对每个 provider 调
 *     `ctx.llm.listModels(provider.id)`，再 `groups.filter(g => g.models.length > 0)`
 *     —— **空目录的 provider 整组从目录里消失**；
 *   - 宿主的 picker（`dsh-client-ui-model-selection`）用「provider + model」
 *     在目录里找 `currentChoice`，找不到就显示 `trigger.fallback`（"请选择模型"）。
 *
 * 本地池此前**恒返回空目录**（§7.106 Option A）。那条理由对云池成立（避免
 * 用户误选 `cloud-llm/deepseek-chat`），对本地池不成立：边缘模式会话本来就
 * 该指向本地池，目录里没有它 ⇒ UI 与实际行为相反。
 *
 * 本文件锁住三件事：
 *   1. 直连池：目录里如实声明它**唯一**会跑的那个模型；
 *   2. DELEGATE 池：目录里声明委托目标的 model id（与 wire 同源）；
 *   3. 云池：仍然隐身（§7.106 Option A 不动）。
 *   4. wire（stream）、目录（listModels）、会话补钉（effective-model）说
 *      **同一个** model id。
 */

import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'vitest'

import {
  CloudLlmDelegateAdapterImpl,
  DelegateTargetCache,
  localPoolTargetCache,
  type DelegateAccessors,
} from '../../src/dsh-adapter/cloud-llm-adapter.ts'
import { LocalLlmAdapterImpl } from '../../src/dsh-adapter/local-llm-adapter.ts'
import { resolveEffectiveLocalModelSync } from '../../src/dsh-adapter/effective-model.ts'

// ── helpers ─────────────────────────────────────────────────────────────────

function mkLlm(routes: string[], opts: { modelsByProvider?: Record<string, any[]> } = {}) {
  const llm: any = {
    calls: [] as Array<{ provider: string; model: string }>,
    listProviders: () => routes.map((id) => ({ id, name: id })),
    listModels: async (p: string) => opts.modelsByProvider?.[p] ?? [],
    stream(options: any) {
      llm.calls.push({ provider: options.provider, model: options.model })
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: 'hi' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
    resolveModelInfo: async (p: string, m: string) => ({ provider: p, id: m, name: m, context: { contextWindow: 32768 } }),
  }
  return llm
}

function accessorsFor(llm: any, selection?: { provider?: string; model?: string }): DelegateAccessors {
  return {
    llm,
    getAgentDefaultModel: () => (selection ? { currentSelection: () => selection } : undefined),
  }
}

const LOCAL_CFG: any = {
  providers: ['local-llm'],
  delegateProvider: undefined,
  delegateModel: undefined,
  delegateEnabled: true,
}

async function drain(iterable: AsyncIterable<any>): Promise<void> {
  for await (const _ of iterable) { /* consume */ }
}

beforeEach(() => {
  // 共享缓存是模块级的 ⇒ 每个用例前清一次，避免用例之间串味。
  localPoolTargetCache.clear()
})

// ── 直连池 ──────────────────────────────────────────────────────────────────

describe('§7.180 直连池的模型目录', () => {
  it('如实声明池自己唯一会跑的那个模型', async () => {
    const adapter = new LocalLlmAdapterImpl({
      providers: ['local-llm'],
      baseUrl: 'http://127.0.0.1:8080/v1',
      defaultModel: 'qwen3.8-flash',
      apiKeyEnv: 'DSH_EDGE_LOCAL_LLM_KEY_ENV',
    } as any)
    const models = await adapter.listModels('local-llm')
    assert.deepEqual(models, [{ provider: 'local-llm', id: 'qwen3.8-flash', name: 'qwen3.8-flash' }])
  })

  it('宿主校验的那条不变量：model.provider 必须等于被问的 provider', async () => {
    const adapter = new LocalLlmAdapterImpl({
      providers: ['local-llm'],
      baseUrl: 'http://127.0.0.1:8080/v1',
      defaultModel: 'qwen3.8-flash',
      apiKeyEnv: 'DSH_EDGE_LOCAL_LLM_KEY_ENV',
    } as any)
    for (const model of await adapter.listModels('local-llm')) {
      assert.equal(model.provider, 'local-llm')
      assert.ok(model.id.length > 0)
      assert.ok(model.name.length > 0)
    }
  })
})

// ── DELEGATE 池 ─────────────────────────────────────────────────────────────

describe('§7.180 DELEGATE 本地池的模型目录', () => {
  it('声明委托目标的 model id（宿主当前选的那个）', async () => {
    const llm = mkLlm(['qwen-token-plan-cn'])
    const delegate = new CloudLlmDelegateAdapterImpl(
      LOCAL_CFG,
      accessorsFor(llm, { provider: 'qwen-token-plan-cn', model: 'deepseek-v4.1-flash' }),
      undefined, undefined, undefined, undefined, 'local', new DelegateTargetCache(),
    )
    const models = await delegate.listModels('local-llm')
    assert.deepEqual(models, [{ provider: 'local-llm', id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }])
  })

  it('探针步（宿主选择不可用）⇒ 声明该 provider 的第一个 model id', async () => {
    const llm = mkLlm(['deepseek-account'], {
      modelsByProvider: { 'deepseek-account': [{ provider: 'deepseek-account', id: 'deepseek-flash', name: 'deepseek-flash' }] },
    })
    const delegate = new CloudLlmDelegateAdapterImpl(
      LOCAL_CFG,
      accessorsFor(llm),
      undefined, undefined, undefined, undefined, 'local', new DelegateTargetCache(),
    )
    const models = await delegate.listModels('local-llm')
    assert.deepEqual(models, [{ provider: 'local-llm', id: 'deepseek-flash', name: 'deepseek-flash' }])
  })

  it('解析不到任何落点 ⇒ 目录为空（不编一个 id）', async () => {
    const llm = mkLlm([])
    const delegate = new CloudLlmDelegateAdapterImpl(
      LOCAL_CFG,
      accessorsFor(llm),
      undefined, undefined, undefined, undefined, 'local', new DelegateTargetCache(),
    )
    assert.deepEqual(await delegate.listModels('local-llm'), [])
  })
})

// ── 云池：仍然隐身 ──────────────────────────────────────────────────────────

describe('§7.180 云池仍然在目录里隐身', () => {
  it('§7.106 Option A 不动：cloud-llm 的目录恒空', async () => {
    const llm = mkLlm(['qwen-token-plan-cn'])
    const delegate = new CloudLlmDelegateAdapterImpl(
      { providers: ['cloud-llm'], delegateEnabled: true } as any,
      accessorsFor(llm, { provider: 'qwen-token-plan-cn', model: 'deepseek-v4.1-flash' }),
      undefined, undefined, undefined, undefined, 'cloud', new DelegateTargetCache(),
    )
    assert.deepEqual(await delegate.listModels('cloud-llm'), [])
  })
})

// ── wire / 目录 / 补钉：同一个 id ────────────────────────────────────────────

describe('§7.180 wire / 目录 / 会话补钉说同一个模型', () => {
  it('三处都从共享委托目标缓存取值 ⇒ 完全一致', async () => {
    const llm = mkLlm(['qwen-token-plan-cn'])
    const selection = { provider: 'qwen-token-plan-cn', model: 'deepseek-v4.1-flash' }
    const delegate = new CloudLlmDelegateAdapterImpl(
      LOCAL_CFG,
      accessorsFor(llm, selection),
      undefined, undefined, undefined, undefined, 'local', localPoolTargetCache,
    )

    // wire：转发给宿主时带的 model id。
    await drain(delegate.stream({ provider: 'local-llm', model: 'route-key', messages: [] } as any))
    assert.equal(llm.calls[0]!.model, 'deepseek-v4.1-flash')

    // 目录：给宿主选择器看的那一项。
    const models = await delegate.listModels('local-llm')
    assert.equal(models[0]!.id, 'deepseek-v4.1-flash')

    // 会话补钉：input-guard 读同一份缓存（同源）。
    const ctx = {
      get(name: string) {
        if (name === 'llm') return llm
        if (name === 'agentDefaultModel') return { currentSelection: () => selection }
        throw new Error(`no service ${name}`)
      },
    }
    const pinned = resolveEffectiveLocalModelSync(ctx, { delegate: true }, 'qwen3-4b', 'local-llm')
    assert.equal(pinned?.model, 'deepseek-v4.1-flash')
    assert.equal(pinned?.provider, 'qwen-token-plan-cn')
    assert.equal(pinned?.source, 'host-delegate')
  })

  it('拓扑变了（llm/adapters-updated）⇒ 缓存清空后重新解析', async () => {
    const llm = mkLlm(['qwen-token-plan-cn'])
    const delegate = new CloudLlmDelegateAdapterImpl(
      LOCAL_CFG,
      accessorsFor(llm, { provider: 'qwen-token-plan-cn', model: 'deepseek-v4.1-flash' }),
      undefined, undefined, undefined, undefined, 'local', localPoolTargetCache,
    )
    assert.equal((await delegate.listModels('local-llm'))[0]!.id, 'deepseek-v4.1-flash')

    // 宿主换了默认模型 + 路由拓扑变了 ⇒ 清缓存 ⇒ 重新解析出新 id。
    const llm2 = mkLlm(['qwen-token-plan-cn'])
    const delegate2 = new CloudLlmDelegateAdapterImpl(
      LOCAL_CFG,
      accessorsFor(llm2, { provider: 'qwen-token-plan-cn', model: 'deepseek-v4.1-pro' }),
      undefined, undefined, undefined, undefined, 'local', localPoolTargetCache,
    )
    delegate.invalidateTopology()
    assert.equal((await delegate2.listModels('local-llm'))[0]!.id, 'deepseek-v4.1-pro')
  })
})
