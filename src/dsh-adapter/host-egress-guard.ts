/**
 * host-egress-guard — §7.151 出网那一跳的「只带云段历史」守卫
 *
 * ## 为什么需要这个模块（主人现场，2026-10-29）
 *
 * 主人在 Edge 面板看到：发往云端模型（`qwen-token-plan-cn/deepseek-v4.1-flash`）
 * 的请求里带着**全部**本地历史 —— 三条 `provider: local-llm` 的 assistant
 * 回复原样上云。那违反 §7.131 的裁决（2026-10-27）：
 *
 * > 发往 cloud-llm 的请求只能携带**之前上过 cloud-llm 的历史**；本地池带全部历史。
 *
 * ## 根因：这条出网**根本没经过**本项目的 cloud adapter
 *
 * §7.131 的裁剪一直住在 `cloud-llm-adapter` 里（直连路径 + delegate 路径各一份）。
 * 但桌面部署的 CLOUD 轮次**压根不进那个 adapter**：
 *
 * ```
 * intent.classify.end  category=CLOUD confidence=0.95 path=jev-adopt
 * input-guard.routed   category=CLOUD edgeRouteUsed=False routeSource=webui
 * llm.trace.index REQ  provider=qwen-token-plan-cn model=deepseek-v4.1-flash messageCount=31
 * ```
 *
 * - `edgeRouteUsed=False` ⇒ webui 入口没有 `_edgeRoute`，edge 不改写路由；
 * - 意图判成 CLOUD ⇒ `handleAgentRequest` **不**降级 ⇒ seed 的 provider 原样保留；
 * - seed 的 provider 是宿主自己的 `qwen-token-plan-cn`（桌面 GUI 选的模型）⇒
 *   agent-loop 直接派发给**宿主原生 provider**，不经过 `cloud-llm`。
 *
 * 于是 `cloud-llm-adapter` 里的 §7.131 裁剪**一次都没跑过**（审计链里
 * `llm.cloud.delegate.resolved` / `llm.cloud.egress` 全是 0 条可证）。
 *
 * ## 修法：守卫落在**真正的出网那一跳**
 *
 * 宿主原生 provider 的那一跳只有一个必经之地：`llm/stream` waterfall
 * （`ctx.llm.stream()` 的实现就是 `ctx.waterfall(this, 'llm/stream', options, …)`）。
 * 守卫在那儿：
 *
 * 1. 判定这通调用是不是**出网**的（provider 不在本地池 / 自有池里）；
 * 2. 用 `planCloudEgress`（与 adapter 同一份口径）算出「只带云段历史」的请求体；
 * 3. 命中本地段 ⇒ **换掉请求体重新派发**（`ctx.llm.stream({...options, messages})`）。
 *
 * ### 为什么必须「重新派发」而不是就地改写
 *
 * 宿主契约（`@deepseek-ai/dsh-llm` 的 api-catalog 明写）：
 *
 * > A LOOP-built request carries the process-local `markAgentLoopRequest` identity
 * > and arrives **deep-frozen (mutation throws)**: its content is a pure function
 * > of the session log … so listeners **read it, never rewrite it**.
 *
 * 请求体是冻结的 ⇒ 只能换一个请求对象重新派发。这与 `cloud-llm-adapter` 的
 * delegate 路径是同一个姿势（它也用 `{...options, messages: forwardMessages}`
 * 重新派发），宿主侧已验证可行。
 *
 * 重新派发会**再进一次 waterfall**：本模块用 `markTrimmed` 打标记，
 * 裁过的请求体进来直接放行 ⇒ 不会递归、不会二次裁剪。
 *
 * ## 裁剪口径与 adapter 完全同源
 *
 * 判据、段划分、丢弃规则全部复用 `cloud-egress.ts` 的 `planCloudEgress` ——
 * 同一份事实源，杜绝「adapter 认为该带、守卫认为该丢」这种口径漂移。
 *
 * @module dsh-edge-agent/host-egress-guard
 */

import type { Context } from '@deepseek-ai/cordis'

import {
  assistantProviderHistogram,
  planCloudEgress,
  type EgressMessage,
} from './cloud-egress.js'
import { LOCAL_POOL_FORWARD_MARKER, OWN_POOL_PROVIDERS } from './host-llm-trace.js'

/** 一通 `llm/stream` 调用里守卫用得到的字段（结构化描述，不依赖宿主类型）。 */
export interface HostEgressRequest {
  provider?: unknown
  model?: unknown
  sessionId?: unknown
  purpose?: unknown
  messages?: unknown
  /** §7.171: 「本地池 delegate 转发」标记（见 `LOCAL_POOL_FORWARD_MARKER`）。 */
  [LOCAL_POOL_FORWARD_MARKER]?: unknown
}

/** 裁剪结果。 */
export interface HostEgressPlan {
  /** 允许出网的消息（按原顺序）。 */
  messages: EgressMessage[]
  /** 被拦下的消息条数（本地段 / 无法证明上过云的段）。 */
  droppedCount: number
  /** assistant 消息的 provider 分布（观测用：让人一眼看出这段历史是谁产的）。 */
  histogram: Record<string, number>
}

/**
 * 这通调用是不是**出网**的？
 *
 * - 自有池（`local-llm` / `cloud-llm`）⇒ **不归本守卫管**：
 *   `local-llm` 按裁决带全部历史；`cloud-llm` 由 `cloud-llm-adapter` 自己裁
 *   （直连与 delegate 两条路径都接了 §7.131，审计行也由它出）。
 *   守卫再裁一遍会让 adapter 的 `historyDropped` 变成 0，**把证据洗掉**。
 * - 本地池名单（model-router 的 LOCAL 名单）⇒ 本地池，带全部历史。
 * - `local-` 前缀 ⇒ 同上（与 `providerSegment` 同源）。
 * - 其余（宿主自选 provider，如 `qwen-token-plan-cn`）⇒ 出网，要裁。
 */
export function isCloudBoundProvider(
  provider: string,
  localProviders: readonly string[],
  own: readonly string[] = OWN_POOL_PROVIDERS,
): boolean {
  if (provider.length === 0) return false
  if (own.includes(provider)) return false
  if (localProviders.includes(provider)) return false
  if (provider.startsWith('local-')) return false
  return true
}

/**
 * 纯裁剪：只带云段历史。返回 `undefined` 表示**无需裁剪**（没有本地段）。
 *
 * `currentSegment: 'cloud'` —— 本轮正在出网，所以本轮归属云段。
 */
export function planHostEgress(
  messages: readonly EgressMessage[],
  localProviders: readonly string[],
): HostEgressPlan | undefined {
  const plan = planCloudEgress(messages, {
    currentSegment: 'cloud',
    localProviders,
  })
  if (plan.droppedCount === 0) return undefined
  return {
    messages: plan.kept,
    droppedCount: plan.droppedCount,
    histogram: assistantProviderHistogram(messages),
  }
}

/**
 * §7.171: 这通调用是不是「本地池 delegate 转发」？
 *
 * 本地池转发给宿主提供商时，`provider` 已经是宿主的目标路由（如
 * `deepseek-official`）—— 与「用户直接选了那个模型」在 provider 维度上
 * **无法区分**。唯一的区别在发起方：本地池的口径是「带全部历史」，宿主原生
 * 路由的口径是「只带云段历史」。所以转发方必须在请求上打标记。
 *
 * 标记值刻意做成 truthy 判据（而不是 `=== true`）：宿主 spread options 时
 * 原样透传，值是什么不重要，**有没有**才重要。
 */
export function isLocalPoolForward(request: HostEgressRequest | undefined): boolean {
  if (request == null || typeof request !== 'object') return false
  const flag = (request as Record<string, unknown>)[LOCAL_POOL_FORWARD_MARKER]
  return flag !== undefined && flag !== null && flag !== false
}

/**
 * 出网守卫。
 *
 * 持有 ctx 只为两件事：取本地 provider 名单（与 adapter 同源）、给裁过的请求
 * 打标记（防重新派发时递归）。
 */
export class HostEgressGuard {
  /** 已裁过的请求对象 —— 重新派发会再进一次 waterfall，靠它放行。 */
  private readonly trimmed = new WeakSet<object>()

  constructor(private readonly ctx: Context) {}

  /**
   * 运行时取本地 provider 名单。
   *
   * 用 model-router 的 `listDetailed()`（带 realm 标注）—— 与路由判定、adapter
   * 的 §7.131 裁剪同一份事实源。model-router 在 patch 里排在 input-guard 之后，
   * 所以运行时取（与 `CloudEgressGuard.localProviders()` 同款做法）。
   *
   * **必须走 `ctx.get()` 而不是 `ctx.modelRouter` 直取**：cordis 4.x 的 ctx 是
   * Proxy —— 读一个既没 provide、也不在 `inject` 声明里的属性会**直接抛**
   * `cannot get property "modelRouter" without inject`（input-guard 刻意不把
   * model-router 放进 `inject`，见那处的注释）。`ctx.get()` 才是「可选服务」的
   * 安全读法（input-guard 的 `localAvailable()` 用的就是它）。
   */
  localProviders(): string[] {
    let router: { listDetailed?: () => Array<{ provider?: string; realm?: string }> } | undefined
    try {
      router = (this.ctx as unknown as {
        get?: (name: string) => unknown
      }).get?.('modelRouter') as typeof router
    } catch {
      router = undefined
    }
    try {
      const detailed = router?.listDetailed?.() ?? []
      const locals = detailed
        .filter(d => d.realm === 'LOCAL' && typeof d.provider === 'string')
        .map(d => d.provider as string)
      if (locals.length > 0) return locals
    } catch { /* fall through to the default */ }
    return ['local-llm']
  }

  /** 给裁过的请求对象打标记。 */
  markTrimmed(options: object): void {
    this.trimmed.add(options)
  }

  /** 这个请求对象是不是已经裁过了？（重新派发时进来 ⇒ 直接放行） */
  isTrimmed(options: object): boolean {
    return this.trimmed.has(options)
  }

  /**
   * 这通调用要不要裁？裁的话给出裁剪结果。
   *
   * 不裁的情形（逐条都要有理由，缺一条就是一条漏）：
   * - 已经裁过的请求（重新派发进来的那一趟）⇒ 直接放行。
   * - 没有 provider ⇒ 不是模型调用（防御）。
   * - 自有池 / 本地池 ⇒ 按裁决不带云段 / 带全部历史。
   * - **本地池 delegate 转发**（§7.171）⇒ 这通调用由本地池发起，口径是
   *   「带全部历史」⇒ 不裁。转发后 `provider` 是宿主的目标 provider，光看
   *   provider 判不出来（那是宿主原生路由），只能靠转发标记区分。
   * - `purpose` 非空 ⇒ 宿主的内部用途（compaction / session-title），
   *   不是主人关心的「这一轮对话」，裁它会破坏子系统的语义。
   * - 没有可识别的用户输入 ⇒ `planCloudEgress` 走退化路径（全部保留）。
   * - 裁完一条不丢 ⇒ 没有本地段，不需要裁。
   */
  plan(request: HostEgressRequest): HostEgressPlan | undefined {
    // 已经裁过的请求（重新派发进来的那一趟）⇒ 直接放行：再裁一次是幂等的，
    // 但**再派发一次就是递归**。
    if (request != null && typeof request === 'object' && this.isTrimmed(request)) return undefined
    // §7.171: 本地池 delegate 转发 ⇒ 不裁（LOCAL 口径：带全部历史）。
    // 标记由 `CloudLlmDelegateAdapterImpl` 在 poolKind='local' 时打上。
    if (isLocalPoolForward(request)) return undefined
    const provider = typeof request?.provider === 'string' ? request.provider : ''
    if (provider.length === 0) return undefined
    const purpose = typeof request?.purpose === 'string' ? request.purpose : ''
    if (purpose.length > 0) return undefined
    const locals = this.localProviders()
    if (!isCloudBoundProvider(provider, locals)) return undefined
    if (!Array.isArray(request?.messages)) return undefined
    const messages = request.messages as EgressMessage[]
    return planHostEgress(messages, locals)
  }
}
