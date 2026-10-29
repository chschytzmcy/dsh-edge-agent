/**
 * §7.151 —— 宿主原生 provider 路径的出网裁剪守卫
 *
 * 主人现场（2026-10-29）：桌面部署的 CLOUD 轮次直接派发给**宿主原生 provider**
 * （桌面 GUI 选的 `qwen-token-plan-cn`），压根不进 `cloud-llm-adapter` ⇒
 * adapter 里的 §7.131 裁剪一次都没跑过，本地历史整段上云。
 *
 * 守卫补在 `llm/stream` waterfall（真正的出网那一跳）上：
 * - 判定「这通调用是不是出网的」；
 * - 用与 adapter 同源的 `planCloudEgress` 算「只带云段历史」的请求体；
 * - 裁掉本地段后**换掉请求体重新派发**（宿主把 LOOP 请求 deep-frozen 送来，
 *   监听器不能就地改写）。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

import {
  HostEgressGuard,
  isCloudBoundProvider,
  planHostEgress,
} from '../../src/dsh-adapter/host-egress-guard'
import type { EgressMessage } from '../../src/dsh-adapter/cloud-egress'

function userMsg(text: string): EgressMessage {
  return { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

function assistantMsg(provider: string | undefined, text = 'ok'): EgressMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    source: { kind: 'model', provider, model: 'm1' },
  }
}

function texts(messages: readonly EgressMessage[]): string[] {
  return messages.map(m => {
    const c = m.content as Array<{ type: string; text?: string }>
    return c.map(b => b.text ?? '').join('')
  })
}

/** 一段「本地轮 + 当前云轮」的会话。 */
function mixedHistory(): EgressMessage[] {
  return [
    userMsg('本地轮的用户输入'),
    assistantMsg('local-llm', '本地模型的回答'),
    userMsg('当前轮的用户输入'),
  ]
}

describe('§7.151 — 哪些 provider 算「出网」', () => {
  it('宿主自选 provider（桌面 GUI 选的模型）→ 出网，要裁', () => {
    assert.equal(isCloudBoundProvider('qwen-token-plan-cn', ['local-llm']), true)
    assert.equal(isCloudBoundProvider('minimax-cn', ['local-llm']), true)
    assert.equal(isCloudBoundProvider('deepseek-official', ['local-llm']), true)
  })

  it('自有池（local-llm / cloud-llm）→ 不归守卫管', () => {
    // local-llm 按裁决带全部历史；cloud-llm 由 cloud-llm-adapter 自己裁
    // （直连 + delegate 两条路径都接了 §7.131）—— 守卫再裁一遍会把 adapter
    // 的 historyDropped 洗成 0，把证据抹掉。
    assert.equal(isCloudBoundProvider('local-llm', ['local-llm']), false)
    assert.equal(isCloudBoundProvider('cloud-llm', ['local-llm']), false)
  })

  it('本地池名单内 / local- 前缀 → 不是出网', () => {
    assert.equal(isCloudBoundProvider('qwen-local', ['local-llm', 'qwen-local']), false)
    assert.equal(isCloudBoundProvider('local-qwen', ['local-llm']), false)
  })

  it('空 provider → 不是出网（防御：不是模型调用）', () => {
    assert.equal(isCloudBoundProvider('', ['local-llm']), false)
  })
})

describe('§7.151 — 纯裁剪', () => {
  it('本地段被裁掉，当前轮保留', () => {
    const plan = planHostEgress(mixedHistory(), ['local-llm'])
    assert.ok(plan, '有本地段 ⇒ 必须给出裁剪结果')
    assert.equal(plan!.droppedCount, 2)
    assert.deepEqual(texts(plan!.messages), ['当前轮的用户输入'])
  })

  it('没有本地段 ⇒ 不裁（undefined），不做无谓的重新派发', () => {
    const plan = planHostEgress([
      userMsg('云轮输入'),
      assistantMsg('qwen-token-plan-cn', '云轮回答'),
      userMsg('当前轮输入'),
    ], ['local-llm'])
    assert.equal(plan, undefined)
  })

  it('provider 分布直方图如实反映历史是谁产的', () => {
    const plan = planHostEgress(mixedHistory(), ['local-llm'])
    assert.deepEqual(plan!.histogram, { 'local-llm': 1 })
  })
})

describe('§7.151 — 守卫的判定', () => {
  const ctx = { reflect: { provide() { return () => {} } }, provide() { return () => {} } } as any

  it('宿主 provider + 本地历史 → 给出裁剪结果', () => {
    const guard = new HostEgressGuard(ctx)
    const plan = guard.plan({
      provider: 'qwen-token-plan-cn',
      model: 'deepseek-v4.1-flash',
      messages: mixedHistory(),
    })
    assert.ok(plan)
    assert.equal(plan!.droppedCount, 2)
  })

  it('purpose 非空（宿主内部用途：compaction / session-title）→ 不裁', () => {
    const guard = new HostEgressGuard(ctx)
    assert.equal(guard.plan({
      provider: 'qwen-token-plan-cn',
      purpose: 'compaction',
      messages: mixedHistory(),
    }), undefined)
  })

  it('自有池 provider → 不裁', () => {
    const guard = new HostEgressGuard(ctx)
    assert.equal(guard.plan({ provider: 'local-llm', messages: mixedHistory() }), undefined)
    assert.equal(guard.plan({ provider: 'cloud-llm', messages: mixedHistory() }), undefined)
  })

  it('已裁过的请求（重新派发进来的那一趟）→ 放行，不递归', () => {
    const guard = new HostEgressGuard(ctx)
    const request = { provider: 'qwen-token-plan-cn', messages: mixedHistory() }
    assert.ok(guard.plan(request), '第一趟要裁')
    guard.markTrimmed(request)
    assert.equal(guard.plan(request), undefined, '第二趟必须放行，否则无限递归')
  })

  it('没有 messages / provider → 不裁', () => {
    const guard = new HostEgressGuard(ctx)
    assert.equal(guard.plan({ provider: 'qwen-token-plan-cn' }), undefined)
    assert.equal(guard.plan({ messages: mixedHistory() }), undefined)
  })

  it('本地池名单来自 model-router（与 adapter / 路由同一份事实源）', () => {
    // cordis 里「可选服务」只能走 ctx.get() 读 —— 直取 ctx.modelRouter 在真
    // 运行时是**抛错**的（未 provide 且未在 inject 声明里）。这里用同样的
    // 取法造假 ctx。
    const guard = new HostEgressGuard({
      reflect: { provide() { return () => {} } },
      provide() { return () => {} },
      get: (name: string) => (name === 'modelRouter' ? {
        listDetailed: () => [
          { provider: 'local-llm', realm: 'LOCAL' },
          { provider: 'qwen-local', realm: 'LOCAL' },
          { provider: 'qwen-token-plan-cn', realm: 'CLOUD' },
        ],
      } : undefined),
    } as any)
    assert.deepEqual(guard.localProviders(), ['local-llm', 'qwen-local'])
    // 名单内的 provider 不算出网
    assert.equal(guard.plan({ provider: 'qwen-local', messages: mixedHistory() }), undefined)
  })

  it('model-router 不可用 → 退回默认名单 local-llm（不放大裁剪范围）', () => {
    const guard = new HostEgressGuard(ctx)
    assert.deepEqual(guard.localProviders(), ['local-llm'])
  })

  it('ctx.get 抛错 → 退回默认名单，绝不把异常带进出网链路', () => {
    const guard = new HostEgressGuard({
      reflect: { provide() { return () => {} } },
      provide() { return () => {} },
      get() { throw new Error('cannot get property "modelRouter" without inject') },
    } as any)
    assert.deepEqual(guard.localProviders(), ['local-llm'])
  })
})
