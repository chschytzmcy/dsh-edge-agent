/**
 * §7.179 (2026-11-11): 内部阶段（guard 检测 / 意图分类）**真正会跑**的模型。
 *
 * 背景（主人实测 2026-11-11 12:56，桌面 App）：
 *
 *   guard / intent 两个阶段的 provider 钉在 `local-llm` 上，但模型名此前只跟
 *   `llm.local.model` 走（prompt-guard / intent-router 各自在 apply() 里算一次）。
 *   **DELEGATE 模式下 `llm.local.baseUrl` 与 `llm.local.model` 都是空的**
 *   （shipped 模板如此，§7.171）⇒ 模型名停在 Schema 默认 `qwen3-4b`，而 wire
 *   上真正跑的是委托解析出来的**宿主当前模型**（实测
 *   `qwen-token-plan-cn/deepseek-v4.1-flash`）。
 *
 *   ⇒ 面板写「模型 local-llm/qwen3-4b」而实际跑的是另一个模型 = **与实际行为
 *   相反的陈述**（主人的规矩）。§7.176 已经定过同一口径（「DELEGATE 模式下写
 *   宿主当前模型 id —— wire 上真正跑的就是它，不写一个跟实际不符的名字」），
 *   这里把它落到 guard / intent 两个阶段上。
 *
 * 口径（与 local-llm-adapter 的 wire 行为逐条对齐，不是另写一套）：
 *
 *   - 直连池（`llm.local.baseUrl` 非空）：wire body 的 model = `llm.local.model`
 *     （adapter 的 `defaultModel`，`options.model` 只是路由键 `route=`）⇒ 取它；
 *   - DELEGATE 池（baseUrl 空）：wire body 的 model = 委托目标的解析结果
 *     （`env` 显式 → `selection` 宿主当前选择 → `probe` 活拓扑探针；探针步
 *     没定 model 时 adapter 在 stream 时取该 provider 的第一个 model id）
 *     ⇒ **复用 adapter 的同一份解析链**（`probeCloudTarget`）；
 *   - 都拿不到 ⇒ 退回调用方给的请求值，并如实标注来处（`requested`）。
 *
 * 单一事实源：`probeCloudTarget`（cloud-llm-adapter 导出）—— local-llm-adapter
 * 的 DELEGATE 分支用的就是它，本模块只复用、不复制解析逻辑。
 */

import {
  probeCloudTarget,
  localPoolTargetCache,
  type AgentDefaultModelLike,
  type CloudDelegateTarget,
  type DelegateAccessors,
  type DelegateConfigLike,
  type DelegateLlmLike,
} from './cloud-llm-adapter.js'
import { localPool } from './edge-config.js'

/** 内部阶段真正会跑的模型。 */
export interface EffectiveLocalModel {
  /** 实际会跑（wire body）的模型 id。 */
  model: string
  /**
   * 实际落点的 provider。
   *
   * 直连池 = 本地路由自己（`local-llm`）；DELEGATE = **宿主 provider**
   * （`qwen-token-plan-cn` 之类）—— 这一项才是「数据往哪儿去」的事实。
   */
  provider?: string
  /** 这个 id 的来处（审计与面板的事实标注）。 */
  source: 'local-pool' | 'host-delegate' | 'requested'
  /** 委托解析链的哪一步（与 delegate 审计的 `source` 同名，便于对账）。 */
  via?: 'env' | 'selection' | 'probe'
}

/** 本地池里本模块用到的几个字段（测试可直接构造）。 */
export interface LocalPoolShape {
  baseUrl?: string
  model?: string
  /** `llm.local.delegate=false` = kill switch（路由不注册）。 */
  delegate?: boolean
  delegateProvider?: string
  delegateModel?: string
  /**
   * §7.210 (2026-11-12) / §7.214 (2026-11-13): true = 本地池的委托落点
   * **不是本地**时 fail-closed 拒收。默认 false（零行为变化）；input-guard
   * 用它决定「DELEGATE 出网」是只记审计还是直接拒收。
   *
   * §7.214 起判据是落点的 realm（model-router 说了算），不是「有没有 baseUrl」。
   */
  requireLocalEndpoint?: boolean
}

/** ctx 上取宿主服务的软读法（读不到就是 undefined，不抛）。 */
function softService<T>(ctx: unknown, name: string): T | undefined {
  try {
    return (ctx as { get?: (n: string) => unknown } | undefined)?.get?.(name) as T | undefined
  } catch {
    return undefined
  }
}

/**
 * 用 adapter 的同一份解析链探一次委托目标。
 *
 * `ownProvider` = 调用方自己那条路由（`local-llm`）—— 递归护栏要排除它自己。
 *
 * §7.180: 结果进**共享**缓存（`localPoolTargetCache`）—— 与 wire
 * （local-llm-adapter 的 DELEGATE 分支）、模型目录（`listModels()`）读的是
 * 同一个目标对象 ⇒ 三处说的必然是同一个模型。
 */
function probeTarget(
  ctx: unknown,
  ownProvider: string,
  pool: LocalPoolShape,
): CloudDelegateTarget | null {
  const llm = softService<DelegateLlmLike>(ctx, 'llm')
  if (!llm || typeof llm.listProviders !== 'function') return null
  const accessors: DelegateAccessors = {
    llm,
    getAgentDefaultModel: () => softService<AgentDefaultModelLike>(ctx, 'agentDefaultModel'),
  }
  const cfg: DelegateConfigLike = {
    providers: [ownProvider],
    delegateProvider: pool.delegateProvider,
    delegateModel: pool.delegateModel,
    // `llm.local.delegate=false` = kill switch ⇒ 路由根本没注册 ⇒ 没有委托目标。
    delegateEnabled: pool.delegate,
  }
  try {
    const cached = localPoolTargetCache.get(llm, cfg)
    if (cached !== undefined) return cached
    const target = probeCloudTarget(accessors, cfg)
    localPoolTargetCache.set(llm, cfg, target)
    return target
  } catch {
    return null
  }
}

/** 探针步没定 model 时，adapter 取该 provider 的第一个 model id（同一口径）。 */
async function firstModelId(ctx: unknown, provider: string): Promise<string> {
  const llm = softService<DelegateLlmLike>(ctx, 'llm')
  if (!llm || typeof llm.listModels !== 'function') return ''
  try {
    const models = await llm.listModels(provider)
    const id = models?.[0]?.id
    return typeof id === 'string' ? id.trim() : ''
  } catch {
    return ''
  }
}

/**
 * §7.180: **同步**解析（不触网）。
 *
 * 供 input-guard 在 `agent/created` 里**同步**补钉会话选择：宿主的第一轮
 * pre-step 紧跟 agent 创建之后，异步补钉会来不及（§7.179 的 fail-closed
 * 闸门会把第一轮直接拒掉）。
 *
 * 返回 `undefined` = 这一轮解析还需要一次异步的 `firstModelId` 查询（委托
 * 解析链的**探针步**没定 model）⇒ 调用方要么异步补钉，要么明确跳过 ——
 * **不许**拿一个「看起来对」的 id 糊弄过去（§7.176）。
 */
export function resolveEffectiveLocalModelSync(
  ctx: unknown,
  pool: LocalPoolShape,
  requested: string,
  ownProvider = 'local-llm',
): EffectiveLocalModel | undefined {
  // 直连池：wire body 的 model 就是池自己的 model（同步可知）。
  if (pool.baseUrl) {
    const model = (pool.model ?? '').trim()
    return {
      model: model.length > 0 ? model : requested,
      provider: ownProvider,
      source: 'local-pool',
    }
  }

  // DELEGATE：与 adapter 同一条解析链（同步部分）。
  const target = probeTarget(ctx, ownProvider, pool)
  if (!target) {
    // 解析不到任何落点 ⇒ 池跑不起来；退回请求值并如实标注来处。
    return { model: requested, source: 'requested' }
  }
  const model = (target.model ?? '').trim()
  if (model.length === 0) return undefined
  return { model, provider: target.provider, source: 'host-delegate', via: target.source }
}

/**
 * 解析「这个内部阶段这一轮真正会跑哪个模型」（池形态由调用方给 ⇒ 可测）。
 *
 * @param ctx        宿主 ctx（读 `llm` / `agentDefaultModel` 两个软依赖）
 * @param pool       本地池现状（直连 / DELEGATE）
 * @param requested  调用方请求的模型 id（拿不到真相时的退路）
 * @param ownProvider 调用方自己那条路由（`local-llm`），用于递归护栏
 */
export async function resolveEffectiveLocalModelWith(
  ctx: unknown,
  pool: LocalPoolShape,
  requested: string,
  ownProvider = 'local-llm',
): Promise<EffectiveLocalModel> {
  // 直连池 / 解析不到落点：同步就能定。
  const sync = resolveEffectiveLocalModelSync(ctx, pool, requested, ownProvider)
  if (sync !== undefined && sync.source !== 'host-delegate') return sync

  // DELEGATE 且探针步没定 model：需要一次 firstModelId 查询（异步）。
  const target = probeTarget(ctx, ownProvider, pool)
  if (!target) return { model: requested, source: 'requested' }
  let model = (target.model ?? '').trim()
  if (model.length === 0) {
    model = await firstModelId(ctx, target.provider)
    // §7.180: 回填进缓存的目标对象 ⇒ 目录（listModels）、会话补钉与 wire
    // 三处共享同一个 id（缓存里放的就是这个对象本身）。
    if (model.length > 0) target.model = model
  }
  if (model.length === 0) {
    // 落点解析到了、model id 拿不到 ⇒ 如实记下落点，模型名退回请求值。
    return { model: requested, provider: target.provider, source: 'host-delegate', via: target.source }
  }
  return { model, provider: target.provider, source: 'host-delegate', via: target.source }
}

/**
 * 解析「这个内部阶段这一轮真正会跑哪个模型」（池形态取自 config/edge.json）。
 *
 * @param ctx        宿主 ctx（读 `llm` / `agentDefaultModel` 两个软依赖）
 * @param requested  调用方请求的模型 id（拿不到真相时的退路）
 * @param ownProvider 调用方自己那条路由（`local-llm`），用于递归护栏
 */
export async function resolveEffectiveLocalModel(
  ctx: unknown,
  requested: string,
  ownProvider = 'local-llm',
): Promise<EffectiveLocalModel> {
  let pool: LocalPoolShape
  try {
    pool = localPool()
  } catch {
    pool = {}
  }
  return resolveEffectiveLocalModelWith(ctx, pool, requested, ownProvider)
}
