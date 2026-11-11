/**
 * llm-drain-deadline —— §7.190（2026-11-11）：给「一次内部 LLM 调用」**自身**加时限。
 *
 * ## 为什么不能只靠 AbortController
 *
 * 现有的两处内部 LLM 调用（安检 `prompt-guard`、意图分类 `intent-router`）都是
 * 这个形状：
 *
 * ```ts
 * const controller = new AbortController()
 * const timer = setTimeout(() => controller.abort(), timeoutMs)
 * const streamRaw = this.llm.stream({ ...opts, signal: controller.signal })
 * const stream = await streamRaw                       // ← 阶段一：等 promise
 * for await (const chunk of stream) { ... }            // ← 阶段二：读流
 * ```
 *
 * `abort()` 只是**通知**下游取消。若下游那趟请求的 promise **永远不 settle**
 * （既不产出 chunk、也不结束、也不抛错），两个阶段都会**永远挂着** ——
 * abort 触发了也没用，因为没有任何东西被唤醒。
 *
 * **实测（2026-11-11 桌面版，22:31:58 / 22:37:45 / 22:39:45 三次全同）**：
 * 无活配置 ⇒ 本地池走 DELEGATE（转发宿主 provider）⇒ 意图分类那一跳挂在
 * provider 那一侧。证据链：
 *
 * - 60 秒时限到了：宿主的活动资源里 `Timeout` 计数归零（定时器已触发并消失）；
 * - 但审计链里**没有** `intent.llm.timeout`（说明 abort 没让循环退出，
 *   catch 分支根本没进）；
 * - 也没有 `intent.classify.end`；
 * - 宿主进程里**没有一条到 provider 的外连 socket**（只有 Electron 的回环 IPC）
 *   ⇒ 请求压根没走到网络层。
 *
 * ⇒ 整轮卡在「意图判定」，面板如实显示：攻击检测进行中 / 意图判定等待 /
 * 路由未定 / LLM 调用 0。
 *
 * ## 这里做什么
 *
 * 让「这次调用」和「时限」**赛跑**：时限先到 ⇒ 我们自己 abort 掉 controller 并抛
 * 一个 `name === 'AbortError'` 的错误。上层的超时分支照常记 `*.timeout` 并
 * fail-open（安检放行、意图分类退回规则层）⇒ **阶段不再能永久卡死整轮**。
 *
 * 这不替代 abort —— abort 仍然照常发给下游（下游守规矩时，它自己会更快地
 * 抛错/结束）。这里只是**兜底**：下游不守规矩时，由我们收口。
 */

/**
 * 在给定时限内跑完 `work`；时限到了就自己收口。
 *
 * 时限到了：先 `controller.abort()`（通知下游收尾），再抛一个 `AbortError`
 * —— 与下游自己因 abort 抛出的错误**同形**，上层的 `isAbort` 判定照常成立。
 *
 * @param work        这次调用要做的事（拿流 + 读完流）
 * @param timeoutMs   时限（毫秒）；<= 0 或非有限数表示不限时
 * @param controller  用来通知下游取消的 controller
 */
export async function raceWithDeadline<T>(
  work: () => Promise<T>,
  timeoutMs: number,
  controller: AbortController,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return await work()

  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // 先通知下游收尾（下游守规矩时它自己会结束；不守规矩时我们照样收口）。
      try {
        controller.abort()
      } catch { /* 通知失败不影响收口 */ }
      const err = new Error(`llm call did not settle within ${timeoutMs}ms`)
      err.name = 'AbortError'
      reject(err)
    }, timeoutMs)
  })

  try {
    return await Promise.race([work(), deadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
