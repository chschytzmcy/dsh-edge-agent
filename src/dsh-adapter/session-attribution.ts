/**
 * §7.147 会话归属：审计行「属于哪个会话」的唯一口径。
 *
 * ## 为什么要有这个模块
 *
 * Edge 面板按**行**判断「这一轮」（§7.145-B）：会话自己的行 `turn >= 0`，
 * 全局行 `turn === -1`（哨兵）。归属在宿主侧由 `edge-context-view.ts` 的
 * `extractSessionId()` 决定 —— 载荷里**有** sessionId 就是会话行，没有就是
 * 全局行；全局桶会被合并进**任何一个**会话的快照。
 *
 * 实测（§7.147，2026-10-29，本机审计链 4962 行逐 kind 统计）：
 *
 * | kind | 条数 | 带 sessionId |
 * |---|---|---|
 * | `llm.local.start` | 640 | **0** |
 * | `llm.trace.index` | 195 | **0** |
 * | `intent.jev.adopt` / `intent.jev.response` | 62 | **0** |
 *
 * 于是这些行**永远**落全局桶 ⇒ 路由 / 意图两个面板**结构上**不可能说
 * 「这一轮」⇒ 面板只能显示「尚未绑定会话 + 全局信号」。
 *
 * ## 哨兵不是会话 id
 *
 * ops log 用 `'<pre-session>'` 表示「这次调用发生在会话建立之前」（§7.52：
 * `<none>` / `unknown` 让人以为是数据丢失，`<pre-session>` 说明是预期）。
 * 那是个**日志显示用**的哨兵，**不是**一个真实的会话 id。
 *
 * 把它当 sessionId 写进审计载荷会造出一个不存在的桶 —— 那些行从此只在
 * 「有人请求 sessionId = `<pre-session>`」时才可见，等于**从所有真实会话
 * 的视图里消失**。那比不写更糟：**宁可全局可见，不要无处可见**。
 *
 * 所以本模块给出唯一口径：
 *
 *   - **生产侧**：`realSessionId()` / `sessionIdField()` —— 哨兵与空串一律
 *     判成「没有会话」，载荷里干脆不写这个键。
 *   - **消费侧**：`edge-context-view.ts` 的 `extractSessionId()` 同样把哨兵
 *     判成全局 —— 防御旧行与其它可能漏进来的路径。
 *
 * @module dsh-edge-agent/session-attribution
 */

/**
 * ops log 用的「无会话」哨兵（§7.52）。
 *
 * 它是**日志显示**用的，不是会话标识。任何把它当作 id 使用的地方都是 bug。
 */
export const PRE_SESSION_SENTINEL = '<pre-session>'

/**
 * 取「真实会话 id」——没有就是 `undefined`（= 归属全局桶）。
 *
 * 判为「没有会话」的输入：非字符串 / 空串 / `'<pre-session>'` 哨兵。
 *
 * @param value - 任意来源的候选 id（options.sessionId / trace.sessionId / …）
 * @returns 真实会话 id，或 `undefined`
 */
export function realSessionId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  if (value.length === 0 || value === PRE_SESSION_SENTINEL) return undefined
  return value
}

/**
 * 审计载荷上的 `sessionId` 字段 —— 有真会话才带这个键。
 *
 * 用 `...(id ? { sessionId: id } : {})`（本仓既有写法，见 `intent-router.ts`
 * 的 `...(sessionId ? { sessionId } : {})`）而不是 `sessionId: id`：后者在
 * 无会话时会写一个 `undefined` 字段。JSON.stringify 会把它丢掉，结果一样，
 * 但显式 spread 更清楚「**没有**这个键」而不是「有个空值」。
 *
 * @param value - 任意来源的候选 id
 * @returns 可直接展开进审计载荷的对象
 */
export function sessionIdField(value: unknown): { sessionId?: string } {
  const id = realSessionId(value)
  return id === undefined ? {} : { sessionId: id }
}
