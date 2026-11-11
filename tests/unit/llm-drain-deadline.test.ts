/**
 * llm-drain-deadline tests — §7.190（2026-11-11）。
 *
 * 这个模块存在的理由：一次内部 LLM 调用（安检 / 意图分类）**不能只靠
 * AbortController 兜底**。`abort()` 只是通知下游取消；若下游那趟请求的
 * promise **永远不 settle**（既不产出 chunk、也不结束、也不抛错），两个阶段
 * （等 promise / 读流）都会永远挂着 —— abort 触发了也没用，因为没有任何东西
 * 被唤醒。
 *
 * 实测（2026-11-11 桌面版，22:31:58 / 22:37:45 / 22:41:47 / 22:44:25 /
 * 22:46:29 五次全同）：意图分类器的委托调用挂在宿主流里，60 秒时限到了之后
 * 审计链里既没有 `intent.llm.timeout` 也没有 `intent.classify.end` ⇒
 * 整轮永久卡死。
 *
 * 这里测的是**收口契约**：
 * - 守规矩的活照常完成（不能因为加了时限就误伤正常路径）；
 * - 不守规矩的死，在时限内被我们自己收口，且抛的是 `AbortError`
 *   （与下游自己因 abort 抛出的错误同形 ⇒ 上层的 `isAbort` 判定照常成立）；
 * - 收口时**要 abort controller**（通知下游收尾）；
 * - 工作本身失败时，错误原样透出（不被时限吞掉）。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

import { raceWithDeadline } from '../../src/dsh-adapter/llm-drain-deadline.ts'

describe('raceWithDeadline (§7.190)', () => {
  it('returns the work result when it settles in time', async () => {
    const controller = new AbortController()
    const out = await raceWithDeadline(async () => 'done', 1000, controller)
    assert.equal(out, 'done')
    assert.equal(controller.signal.aborted, false, '正常完成不该 abort 下游')
  })

  it('rejects with AbortError and aborts the controller when the work never settles', async () => {
    const controller = new AbortController()
    // 宿主那趟请求**永不 settle**：既不 resolve 也不 reject。
    await assert.rejects(
      raceWithDeadline(() => new Promise<never>(() => {}), 30, controller),
      (err: any) => {
        assert.equal(err.name, 'AbortError')
        assert.match(err.message, /did not settle within 30ms/u)
        return true
      },
    )
    assert.equal(controller.signal.aborted, true, '收口时必须 abort 下游')
  })

  it('rejects with AbortError when the stream never yields (the for-await hang)', async () => {
    const controller = new AbortController()
    // 第二阶段挂死：迭代器永远不产出、也不结束。
    const neverEnding: AsyncIterable<unknown> = (async function* () {
      await new Promise<void>(() => {})
    })()
    await assert.rejects(
      raceWithDeadline(async () => {
        for await (const chunk of neverEnding) {
          void chunk
        }
      }, 30, controller),
      (err: any) => err.name === 'AbortError',
    )
    assert.equal(controller.signal.aborted, true)
  })

  it('propagates the work error unchanged when it settles before the deadline', async () => {
    const controller = new AbortController()
    await assert.rejects(
      raceWithDeadline(async () => { throw new Error('boom') }, 1000, controller),
      /boom/u,
    )
    assert.equal(controller.signal.aborted, false, '工作自己失败不该被当成超时')
  })

  it('propagates a non-AbortError rejection without rewrapping it', async () => {
    const controller = new AbortController()
    const boom = new Error('provider exploded')
    await assert.rejects(
      raceWithDeadline(async () => { throw boom }, 1000, controller),
      (err: any) => {
        assert.equal(err, boom, '错误对象要原样透出')
        assert.notEqual(err.name, 'AbortError')
        return true
      },
    )
  })

  it('does not arm a deadline when the timeout is not a positive finite number', async () => {
    const controller = new AbortController()
    assert.equal(await raceWithDeadline(async () => 'ok', 0, controller), 'ok')
    assert.equal(await raceWithDeadline(async () => 'ok', -1, controller), 'ok')
    assert.equal(await raceWithDeadline(async () => 'ok', Number.POSITIVE_INFINITY, controller), 'ok')
    assert.equal(await raceWithDeadline(async () => 'ok', Number.NaN, controller), 'ok')
    assert.equal(controller.signal.aborted, false)
  })

  it('does not abort the controller when the work finishes before the deadline', async () => {
    const controller = new AbortController()
    const out = await raceWithDeadline(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return 1
    }, 1000, controller)
    assert.equal(out, 1)
    assert.equal(controller.signal.aborted, false)
  })
})
