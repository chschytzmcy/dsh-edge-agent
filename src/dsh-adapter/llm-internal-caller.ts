/**
 * llm-internal-caller —— 区分「主对话出网」与「插件内部的 LLM 调用」。
 *
 * ## 为什么要这个
 *
 * 插件自己也会调 LLM：
 *
 * - `prompt-guard` —— 入口安检的**语义检测**（模型档）
 * - `intent-router` —— **意图分类器**（jev / LLM 分类）
 *
 * 它们都走同一个 `ctx.llm.stream(...)`，所以在 adapter 眼里与主对话**完全
 * 一致** —— 都落 `llm.local.start` / `llm.local.end` 审计行。
 *
 * §7.132 的现场：主人看到面板上「意图判定：等待 / 路由决策：等待」，
 * 下面却有「答案出口：作答中… · 路由 local-llm/qwen3.8:27b · messageCount=1 ·
 * promptLen=125」。查审计才发现 —— 那条 `llm.local.start` 是
 * **prompt-guard 的安检调用**（单条消息、125 字符），不是主对话的出网
 * （同一时刻还有一条 `messageCount=5 · promptLen=10171` 才是主对话）。
 *
 * 面板的答案出口节点取「最后一条 `llm.local.start`」，于是抓到了那条短的，
 * 把主对话的真实出网状态盖掉了 —— **面板在显示一件没发生过的事**。
 *
 * ## 做法
 *
 * 内部调用在 options 里带一个额外字段 `edgeInternalCaller`，adapter 把它
 * 落到出口审计行上（`internal` 字段），面板据此把内部调用排除在
 * 「答案出口」之外。
 *
 * 字段名带 `edge` 前缀是为了不与宿主 dsh-llm 的 `GenerateOptions` 撞名 ——
 * 宿主不认这个字段，会原样透传给 adapter。
 */

/** 内部调用方标识。 */
export type InternalCaller = 'prompt-guard' | 'intent-classifier'

/** 宿主 options 上的额外字段名。 */
export const EDGE_INTERNAL_CALLER_FIELD = 'edgeInternalCaller'

/** 带内部调用标记的 options。 */
export type WithInternalCaller<T> = T & { [EDGE_INTERNAL_CALLER_FIELD]: InternalCaller }

/**
 * 给 options 挂上内部调用标记。
 *
 * 返回的是**变量**而不是对象字面量 —— TS 的 excess property check 只对
 * 直接传参的字面量生效，所以 `llm.stream(withInternalCaller({...}, 'x'))`
 * 不会因为多了这个字段而报错。
 */
export function withInternalCaller<T extends object>(
  options: T,
  caller: InternalCaller,
): WithInternalCaller<T> {
  return { ...options, [EDGE_INTERNAL_CALLER_FIELD]: caller }
}

/** 从 options 里读出内部调用标记（没有就是 undefined = 主对话出网）。 */
export function internalCallerOf(options: unknown): InternalCaller | undefined {
  if (options === null || typeof options !== 'object') return undefined
  const raw = (options as Record<string, unknown>)[EDGE_INTERNAL_CALLER_FIELD]
  return typeof raw === 'string' && raw.length > 0 ? (raw as InternalCaller) : undefined
}

/**
 * 出网审计行要带的判别字段。
 *
 * - `internal` —— 内部调用标记（prompt-guard / intent-classifier）。没有这个
 *   字段的行**可能**是宿主的内部插件调用（比如会话标题生成），但我们控制
 *   不了它，只能靠下面的 `tools` 判别。
 * - `tools` —— 这次请求带了几件工具。**主对话恒带 30+ 件**（agent loop 一定
 *   带工具表），而一切内部调用（安检 / 分类器 / 标题生成）**一件都不带**。
 *   实测（18:24-18:25 那轮）主对话 `tools=32`，同一时刻的三条内部调用
 *   `tools=<none>` —— sessionId 全都相同，靠 sessionId 分不开，靠 tools 可以。
 *
 * ## 为什么 `tools` 恒落（哪怕宿主没传）
 *
 * 第一版是「宿主传了数组才落长度，否则**不落**该字段」—— 想保住旧数据。
 * 但那只保住了**旧数据**，没保住**宿主的内部调用**：宿主的会话标题生成走
 * 同一个 `ctx.llm.stream`，**不传 tools**，于是它落下来的行既没有 `internal`
 * 也没有 `tools` —— 面板按「两者皆无 → 保留」的旧数据兼容分支，会把它当成
 * 主对话的出网，**继续冒充答案出口**（18:34:59 那轮实测：
 * `messageCount=1 · promptLen=96`）。
 *
 * 所以改成**恒落**：宿主传了数组就落长度，没传就落 `0`。
 *
 * 这样「字段不存在」与「字段为 0」就被区分开了：
 *
 * | 行的来源 | `tools` 字段 | 面板判据 | 结果 |
 * |---|---|---|---|
 * | 主对话 | `32` | `> 0` | **保留** ✓ |
 * | 我们的内部调用 | `0` + `internal` | 有 `internal` | **排除** ✓ |
 * | 宿主内部调用（标题生成） | `0` | `=== 0` | **排除** ✓ |
 * | §7.132 之前的旧数据 | *字段不存在* | 既无 `internal` 也无 `tools` | **保留** ✓ |
 *
 * 旧数据不会被误判（字段缺失 ≠ 0），新数据里的内部调用一条不漏。
 *
 * 残留风险：若某个宿主版本**对主对话也不传 tools**，主对话会落 `tools=0`
 * 而被排除，答案出口会漏显示。那是「少显示」而不是「显示假信息」——
 * 按面板诚实性原则，宁可漏显示也不能让面板显示一件没发生过的事。
 * 实测（18:24、18:34 两轮）宿主对主对话恒传 32 件工具。
 */
export function egressAuditFields(options: unknown): { tools: number; internal?: string } {
  const out: { tools: number; internal?: string } = { tools: 0 }
  if (options !== null && typeof options === 'object') {
    const tools = (options as { tools?: unknown }).tools
    if (Array.isArray(tools)) out.tools = tools.length
  }
  const caller = internalCallerOf(options)
  if (caller !== undefined) out.internal = caller
  return out
}
