/**
 * cloud-egress — 出网请求的「只带云段历史」不变量。
 *
 * ## 主人裁决（2026-10-27）
 *
 * > 发给 cloudllm 的请求，只能携带**之前所有的上 cloudllm 的历史**；
 * > 而 locallm 需要携带**所有的**历史会话信息。
 *
 * 拆开就是两条不对称的规则：
 *
 * | 出口 | 允许携带的历史 |
 * |---|---|
 * | `local-llm` | **全部**历史会话信息（含云段）—— 本地池是 operator 自有设施，带什么都不算出网 |
 * | `cloud-llm` | **只有之前上过 cloud-llm 的历史**；任何 local-llm 段的历史一律不带 |
 *
 * 为什么要不对称：默认路由是本地池，本地轮次积累的会话历史属于**本地资产**。
 * 一旦路由被改写 / 恢复切回云端（`input-guard.route.restored`，实测在 10-24 真实
 * 发生过），整段本地历史会跟着上云 —— 那是**新增**泄露。本地池自己带全部历史
 * 不构成泄露，所以不裁。
 *
 * ## 分段依据：宿主给每条 assistant 消息打了 provider 标记
 *
 * `@deepseek-ai/dsh-llm` 的 `ModelMessageSource` 是 `AssistantProviderMetadata`：
 *
 * ```ts
 * interface AssistantProviderMetadata {
 *   provider: string   // Provider route that produced the message.
 *   model: string
 * }
 * interface ModelMessageSource extends AssistantProviderMetadata { kind: 'model' }
 * ```
 *
 * 所以「这条 assistant 消息是在哪台池上生成的」是**逐条可判**的事实，不需要
 * 靠推断或靠会话边界记账。
 *
 * 用户消息 / 工具结果没有 provider 标记 —— 它们归属于**所在的那一轮**。轮次
 * 起点 = 一条**真实用户输入**消息（`role === 'user' && source.kind === 'user'`）：
 *
 * - 宿主的 model-switch 通知也是 user-role，但 `source.kind === 'model-selection'`
 * - dsh-agent-instructions 注入的运行上下文也是 user-role，但 `source.kind` 是
 *   别的 producer kind
 *
 * 两者都**不是**用户输入，所以按 `source.kind === 'user'` 过滤能精确切出轮次。
 *
 * ## 纯函数
 *
 * 本模块不碰 React、不碰 Cordis、不发请求 —— 只做切分与标注，单测直接断言。
 * 真正的出网调用在 `cloud-llm-adapter`（直连与 delegate 两条路径都接）。
 */

/** 一条出网候选消息的最小形状（dsh 的 Message 是它的超集）。 */
export interface EgressMessage {
  role: string
  content: unknown
  source?: { kind?: string; provider?: string; model?: string } & Record<string, unknown>
  [k: string]: unknown
}

/** 一条消息归属的段。`unknown` = 产不出它的 provider（无法证明它上过云）。 */
export type EgressSegment = 'cloud' | 'local' | 'unknown'

/** 一段历史的归属判定结果。 */
export interface EgressPlanOptions {
  /**
   * 本轮（正在出网的这一轮）的归属。本轮还没有 assistant 消息 —— 它正是这次
   * 请求要生成的，所以段的归属由**出网目标**决定，而不是由消息内容决定。
   */
  currentSegment: EgressSegment
  /**
   * 本地 provider 名单（含 'local-llm'）。判定规则与 `model-router.resolveRoute`
   * 同源：名单内或以 `local-` 开头 → local 段；其余 → cloud 段。
   */
  localProviders?: readonly string[]
}

/** 切分结果。 */
export interface EgressPlan {
  /** 允许出网的消息（按原顺序）。 */
  kept: EgressMessage[]
  /** 被拦下的消息条数（本地段）。 */
  droppedCount: number
  /** 逐条标注（与传入数组等长）。`null` = 该消息不属于任何轮次（轮次起点之前）。 */
  segments: Array<EgressSegment | null>
  /** 轮次边界下标（每一轮的起始消息下标）。 */
  turnStarts: number[]
}

const DEFAULT_LOCAL_PROVIDERS = ['local-llm'] as const

/**
 * provider → 段归属。规则与 `model-router.resolveRoute` 同源，避免两处口径漂移：
 * 本地名单内、或以 `local-` 开头 → local；其余（`cloud-llm` / 宿主自选模型名
 * 如 `qwen-token-plan-cn`）→ cloud。
 *
 * **provider 缺失 → `unknown`**：产不出它的 provider，就**无法证明**它上过云。
 * 主人裁决（2026-10-27）「不用兼容历史会话」—— 旧会话里没有 provider 标记的
 * 那一段直接按 unknown 丢弃，不为它写兼容分支。保守方向：宁可少带，不可多带。
 */
export function providerSegment(
  provider: string | undefined,
  localProviders: readonly string[] = DEFAULT_LOCAL_PROVIDERS,
): EgressSegment {
  if (typeof provider !== 'string' || provider.length === 0) return 'unknown'
  if (localProviders.includes(provider)) return 'local'
  if (provider.startsWith('local-')) return 'local'
  return 'cloud'
}

/** 是不是一条**真实用户输入**消息（轮次起点）。 */
export function isUserInputMessage(message: EgressMessage): boolean {
  return message.role === 'user' && message.source?.kind === 'user'
}

/**
 * 切分消息流，标出每一段（轮次）的归属。
 *
 * 轮次起点 = 真实用户输入消息。段起点之前的消息（理论上只有 system / 早期注入）
 * 不属于任何轮次 → `null`，保留（它们不是会话历史，是运行时上下文）。
 *
 * ## 每一轮怎么判归属（§7.164 修订）
 *
 * 判据只有一条：**这条内容真的上过云吗？** 上过才带。
 *
 * | 轮次形状 | 归属 |
 * |---|---|
 * | 整轮都是云端产出 | 云段 —— 全带 |
 * | 整轮都是本地/未知池产出 | 本地段 —— 整轮丢（含该轮用户输入） |
 * | **云在前、本地在后**（同一轮内路由翻转）| 云前缀带、从本地产出起全丢 |
 * | 本轮（正在出网的这一轮）| 按出网目标归属；出现本地产出则从它起全丢 |
 *
 * ### 为什么「云在前、本地在后」必须切（§7.164 实测发现的泄漏）
 *
 * 旧口径：非当前轮的归属 = 该轮**第一条** assistant 的 provider ⇒ 一轮里只要
 * 第一条是云，**整轮**都算云段 —— 于是同一轮里本地模型产出的回答、以及它之后
 * 的本地工具输出，会被后续出网请求原样带走。
 *
 * 实测形状（真实会话 `session-bd598cb9-…`，provider 顺序
 * `qwen-token-plan-cn → qwen-token-plan-cn → local-llm → …`）⇒ 旧口径下
 * `kept 5 / dropped 0`，裁剪**根本没触发**（`planHostEgress` 见
 * `droppedCount === 0` 就返回 undefined）。本地模型的回答 + 本地工具输出跟着
 * 上云。
 *
 * 修法：非当前轮也按「出现本地产出即从它起切开」处理 —— 云段前缀（真的上过云的
 * 那部分）留下，本地产出起（含其后的工具结果）全部拦下。
 *
 * 纯本地轮（本地产出在前）仍整轮丢：那一轮的用户输入只到过本地池，没上过云。
 */
export function planCloudEgress(
  messages: readonly EgressMessage[],
  options: EgressPlanOptions,
): EgressPlan {
  const localProviders = options.localProviders ?? DEFAULT_LOCAL_PROVIDERS
  const list = messages ?? []

  // 轮次起点
  const turnStarts: number[] = []
  for (let i = 0; i < list.length; i++) {
    if (isUserInputMessage(list[i]!)) turnStarts.push(i)
  }

  const segments: Array<EgressSegment | null> = new Array(list.length).fill(null)

  if (turnStarts.length === 0) {
    // 没有可识别的用户输入 —— 整段当作「轮次起点之前」的上下文，全部保留。
    // 这种情况很罕见（宿主每轮至少一条用户输入），保留比静默清空安全。
    return { kept: [...list], droppedCount: 0, segments, turnStarts }
  }

  for (let t = 0; t < turnStarts.length; t++) {
    const start = turnStarts[t]!
    const end = t + 1 < turnStarts.length ? turnStarts[t + 1]! : list.length
    const isCurrent = t === turnStarts.length - 1

    // 本轮内的三条事实（一次扫描得出）：
    // - firstLocal：本轮**第一条**本地/未知池产出的 assistant 下标（-1 = 没有）
    // - cloudBeforeLocal：firstLocal 之前是否出现过云端产出
    //   （= 这一轮的用户输入真的被送到云端过）
    // - hasAssistant：本轮有没有任何 assistant 产出
    let firstLocal = -1
    let cloudBeforeLocal = false
    let hasAssistant = false
    for (let i = start; i < end; i++) {
      const m = list[i]!
      if (m.role !== 'assistant' || m.source?.kind !== 'model') continue
      hasAssistant = true
      const seg = providerSegment(m.source.provider, localProviders)
      if (seg === 'cloud') {
        if (firstLocal < 0) cloudBeforeLocal = true
        continue
      }
      if (firstLocal < 0) firstLocal = i
    }

    if (firstLocal < 0) {
      // 本轮没有任何本地产出 ⇒ 整轮是云段。
      // 本轮（正在出网的这一轮）还没有 assistant 消息时，归属由出网目标决定。
      const segment = hasAssistant ? 'cloud' : options.currentSegment
      for (let i = start; i < end; i++) segments[i] = segment
      continue
    }

    if (isCurrent) {
      // §7.151：当前轮里出现本地产出 ⇒ 从它起（含其后的工具结果）全部拦下。
      //
      // 为什么不能整轮丢：整轮丢会把本轮的**当前用户输入**一起丢掉 —— 那是
      // 「当前内容」，本来就该出网（裁决：当前内容出网前脱敏）。丢了它，云端
      // 模型收到的是一个没有问题的请求。
      for (let i = start; i < firstLocal; i++) segments[i] = options.currentSegment
      for (let i = firstLocal; i < end; i++) segments[i] = 'local'
      continue
    }

    if (cloudBeforeLocal) {
      // §7.164：历史轮里的「云在前、本地在后」形状 —— 云前缀（真上过云）留下，
      // 从本地产出起（含其后的工具结果）全部拦下。
      //
      // 旧口径按「第一条 assistant 的 provider」整轮归云 ⇒ 本地模型的回答和本地
      // 工具输出会跟着下一次出网请求上云（实测 + 真实会话数据都证实过）。
      for (let i = start; i < firstLocal; i++) segments[i] = 'cloud'
      for (let i = firstLocal; i < end; i++) segments[i] = 'local'
      continue
    }

    // 纯本地轮（本地产出在前，没有云段前缀）⇒ 整轮拦下，含该轮的用户输入：
    // 那一轮的内容只到过本地池，没上过云。
    for (let i = start; i < end; i++) segments[i] = 'local'
  }

  const kept: EgressMessage[] = []
  let droppedCount = 0
  for (let i = 0; i < list.length; i++) {
    const seg = segments[i]
    // local / unknown 都拦下：前者是本地资产，后者无法证明上过云。
    if (seg === 'local' || seg === 'unknown') {
      droppedCount++
      continue
    }
    kept.push(list[i]!)
  }

  return { kept, droppedCount, segments, turnStarts }
}

/**
 * 统计消息流里 assistant 消息的 provider 分布。
 *
 * 纯观测（审计用）—— 让人能直接确认「这段历史是本地池产生的还是云端产生的」，
 * 也就是裁剪判据到底成不成立。不读正文，只读 `source.provider`。
 */
export function assistantProviderHistogram(
  messages: ReadonlyArray<{ role?: string; source?: { kind?: string; provider?: string } }>,
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const m of messages ?? []) {
    if (m?.role !== 'assistant') continue
    const kind = m.source?.kind
    if (kind !== undefined && kind !== 'model') continue
    const provider = typeof m.source?.provider === 'string' && m.source.provider.length > 0
      ? m.source.provider
      : '<none>'
    out[provider] = (out[provider] ?? 0) + 1
  }
  return out
}
