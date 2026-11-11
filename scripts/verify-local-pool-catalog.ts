/**
 * §7.180 (2026-11-11): 本地池的**模型目录**门禁。
 *
 * 主人实测（2026-11-11 13:52，桌面 App）：边缘模式会话在输入框下方的宿主
 * 模型选择器里显示「请选择模型」。
 *
 * 根因（宿主源码查实）：
 *   - `dsh-api-session-controller` 的 `buildModelCatalog` 对每个 provider 调
 *     `ctx.llm.listModels(provider.id)`，再 `groups.filter(g => g.models.length > 0)`
 *     —— **空目录的 provider 整组从目录里消失**；
 *   - 宿主 picker 用「provider + model」在目录里找 `currentChoice`，找不到就
 *     显示 `trigger.fallback`（"请选择模型"）。
 *
 * 所以「本地池在目录里声明它真正会跑的那个模型」是一条**不变量**：
 *   1. 直连池：声明它唯一会跑的 model（wire body 的 model 就是它）；
 *   2. DELEGATE 本地池：声明委托目标的 model id（与 wire 同源）；
 *   3. 云池：**仍然隐身**（§7.106 Option A —— 避免用户误选 cloud-llm/
 *      deepseek-chat，也避免 INVALID_CATALOG）；
 *   4. wire / 目录 / 会话补钉说**同一个** model id（共享委托目标缓存）。
 *
 * 门禁是行为级的（真的调一次 `listModels()` / `stream()`），纯只读、不联网、
 * 不读凭据。
 *
 * Run via `node --import tsx/esm scripts/verify-local-pool-catalog.ts`.
 */
import {
  CloudLlmDelegateAdapterImpl,
  DelegateTargetCache,
  localPoolTargetCache,
  type DelegateAccessors,
} from '../src/dsh-adapter/cloud-llm-adapter.ts'
import { LocalLlmAdapterImpl } from '../src/dsh-adapter/local-llm-adapter.ts'
import { resolveEffectiveLocalModelSync } from '../src/dsh-adapter/effective-model.ts'

const violations: string[] = []

function fail(message: string): void {
  violations.push(message)
}

/** 假宿主 llm：活拓扑 + 模型目录 + 转发记录（离线）。 */
function fakeLlm(routes: string[], models: Record<string, Array<{ provider: string; id: string; name: string }>> = {}) {
  const calls: Array<{ provider: string; model: string }> = []
  return {
    calls,
    listProviders: () => routes.map((id) => ({ id, name: id })),
    listModels: async (provider: string) => models[provider] ?? [],
    stream(options: { provider: string; model: string }) {
      calls.push({ provider: options.provider, model: options.model })
      return (async function* () { yield { type: 'text-delta', index: 0, text: 'ok' } })()
    },
    resolveModelInfo: async (provider: string, model: string) => ({ provider, id: model, name: model, context: { contextWindow: 32768 } }),
  }
}

function accessors(llm: unknown, selection?: { provider?: string; model?: string }): DelegateAccessors {
  return {
    llm: llm as never,
    getAgentDefaultModel: () => (selection ? { currentSelection: () => selection } : undefined),
  }
}

const LOCAL_DELEGATE_CFG = {
  providers: ['local-llm'],
  delegateProvider: undefined,
  delegateModel: undefined,
  delegateEnabled: true,
} as never

// ── 1. 直连池：声明它唯一会跑的那个模型 ─────────────────────────────────────

{
  const adapter = new LocalLlmAdapterImpl({
    providers: ['local-llm'],
    baseUrl: 'http://127.0.0.1:8080/v1',
    defaultModel: 'qwen3.8-flash',
    apiKeyEnv: 'DSH_EDGE_LOCAL_LLM_KEY_ENV',
  } as never)
  const models = await adapter.listModels('local-llm')
  if (models.length === 0) {
    fail('直连池的 listModels() 返回空 —— 宿主 buildModelCatalog 会把 local-llm 整组剔出目录 ⇒ 宿主模型选择器显示「请选择模型」')
  } else {
    for (const model of models) {
      if (model.provider !== 'local-llm') fail(`直连池声明的 model.provider='${model.provider}' ≠ 'local-llm'（宿主会判 INVALID_CATALOG）`)
      if (model.id !== 'qwen3.8-flash') fail(`直连池声明的 model.id='${model.id}' ≠ 池自己的 defaultModel='qwen3.8-flash'（写了跟实际不符的名字）`)
      if (typeof model.name !== 'string' || model.name.length === 0) fail('直连池声明的 model.name 为空（宿主会判 INVALID_CATALOG）')
    }
  }
}

// ── 2. DELEGATE 本地池：声明委托目标的 model id ─────────────────────────────

{
  const llm = fakeLlm(['qwen-token-plan-cn'])
  const delegate = new CloudLlmDelegateAdapterImpl(
    LOCAL_DELEGATE_CFG,
    accessors(llm, { provider: 'qwen-token-plan-cn', model: 'deepseek-v4.1-flash' }),
    undefined, undefined, undefined, undefined, 'local', new DelegateTargetCache(),
  )
  const models = await delegate.listModels('local-llm')
  if (models.length === 0) {
    fail('DELEGATE 本地池的 listModels() 返回空 —— 宿主模型选择器显示「请选择模型」')
  } else if (models.length > 1) {
    fail(`DELEGATE 本地池声明了 ${models.length} 个模型 —— wire 上只会跑一个（委托目标），多出来的是骗人的`)
  } else {
    const model = models[0]!
    if (model.id !== 'deepseek-v4.1-flash') fail(`DELEGATE 本地池声明的 model.id='${model.id}' ≠ 委托目标的 model id='deepseek-v4.1-flash'`)
    if (model.provider !== 'local-llm') fail(`DELEGATE 本地池声明的 model.provider='${model.provider}' ≠ 'local-llm'（宿主会判 INVALID_CATALOG）`)
  }
}

// ── 3. 云池：仍然隐身（§7.106 Option A） ────────────────────────────────────

{
  const llm = fakeLlm(['qwen-token-plan-cn'])
  const delegate = new CloudLlmDelegateAdapterImpl(
    { providers: ['cloud-llm'], delegateEnabled: true } as never,
    accessors(llm, { provider: 'qwen-token-plan-cn', model: 'deepseek-v4.1-flash' }),
    undefined, undefined, undefined, undefined, 'cloud', new DelegateTargetCache(),
  )
  const models = await delegate.listModels('cloud-llm')
  if (models.length !== 0) {
    fail(`云池的 listModels() 返回了 ${models.length} 项 —— §7.106 Option A 要求 cloud-llm 在目录里隐身（避免误选 cloud-llm/deepseek-chat）`)
  }
}

// ── 4. wire / 目录 / 会话补钉说同一个 model id ──────────────────────────────

{
  localPoolTargetCache.clear()
  const llm = fakeLlm(['qwen-token-plan-cn'])
  const selection = { provider: 'qwen-token-plan-cn', model: 'deepseek-v4.1-flash' }
  const delegate = new CloudLlmDelegateAdapterImpl(
    LOCAL_DELEGATE_CFG,
    accessors(llm, selection),
    undefined, undefined, undefined, undefined, 'local', localPoolTargetCache,
  )

  // wire
  for await (const _ of delegate.stream({ provider: 'local-llm', model: 'route-key', messages: [] } as never)) { /* drain */ }
  const wireModel = llm.calls[0]?.model

  // 目录
  const catalog = await delegate.listModels('local-llm')
  const catalogModel = catalog[0]?.id

  // 会话补钉（input-guard 读同一份共享缓存）
  const ctx = {
    get(name: string) {
      if (name === 'llm') return llm
      if (name === 'agentDefaultModel') return { currentSelection: () => selection }
      throw new Error(`no service ${name}`)
    },
  }
  const pinned = resolveEffectiveLocalModelSync(ctx, { delegate: true }, 'qwen3-4b', 'local-llm')

  if (wireModel !== catalogModel) {
    fail(`wire 跑的 model='${wireModel}' 与模型目录声明的 model='${catalogModel}' 不一致 ⇒ 界面上写的名字跟实际跑的不是一回事`)
  }
  if (pinned?.model !== catalogModel) {
    fail(`会话补钉的 model='${pinned?.model}' 与模型目录声明的 model='${catalogModel}' 不一致 ⇒ 宿主选择器找不到匹配项，显示「请选择模型」`)
  }
  if (pinned?.provider !== 'qwen-token-plan-cn') {
    fail(`会话补钉的落点 provider='${pinned?.provider}' ≠ 委托落点='qwen-token-plan-cn'`)
  }
}

if (violations.length > 0) {
  console.error('Local-pool catalog gate FAILED:')
  for (const v of violations) console.error(`  - ${v}`)
  process.exit(1)
}

console.log('local-pool catalog OK (direct + delegate + cloud + wire/catalog/pin 一致性)')
