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
  isLocalPoolForward,
  planHostEgress,
} from '../../src/dsh-adapter/host-egress-guard'
import { LOCAL_POOL_FORWARD_MARKER } from '../../src/dsh-adapter/host-llm-trace'
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

/**
 * §7.171 —— 本地池 delegate 转发时，守卫必须放行（不裁）
 *
 * 背景：本地池没配端点时转发给宿主提供商（§7.171 新增）。转发后 `provider`
 * 是宿主的目标路由（如 `deepseek-official`）—— 与「用户直接选了那个模型」在
 * provider 维度上**无法区分**，光看 provider 会把本地池的转发误判成出网并裁掉
 * 本地段历史（与 §7.131 的不对称规则冲突：本地池带**全部**历史）。
 *
 * 唯一的区分依据是转发方打上的标记 —— 守卫读到就放行。
 */
describe('§7.171 — 本地池转发 ⇒ 守卫放行（不裁）', () => {
  const ctx = { reflect: { provide() { return () => {} } }, provide() { return () => {} } } as any

  it('标记存在 ⇒ 不裁（哪怕 provider 是宿主自选路由）', () => {
    const guard = new HostEgressGuard(ctx)
    const plan = guard.plan({
      provider: 'deepseek-official',
      model: 'deepseek-v4.1-flash',
      messages: mixedHistory(),
      [LOCAL_POOL_FORWARD_MARKER]: true,
    })
    assert.equal(plan, undefined, '本地池转发必须原样放行 —— 本地池的口径是带全部历史')
  })

  it('同一个请求去掉标记 ⇒ 照旧裁（标记是唯一的区分依据，不能放宽别的路径）', () => {
    const guard = new HostEgressGuard(ctx)
    const plan = guard.plan({
      provider: 'deepseek-official',
      model: 'deepseek-v4.1-flash',
      messages: mixedHistory(),
    })
    assert.ok(plan, '没有标记的宿主路由调用仍要裁')
    assert.equal(plan!.droppedCount, 2)
  })

  it('isLocalPoolForward：认标记、不认别的键', () => {
    assert.equal(isLocalPoolForward({ [LOCAL_POOL_FORWARD_MARKER]: true }), true)
    assert.equal(isLocalPoolForward({ [LOCAL_POOL_FORWARD_MARKER]: 1 }), true)
    assert.equal(isLocalPoolForward({ [LOCAL_POOL_FORWARD_MARKER]: false }), false)
    assert.equal(isLocalPoolForward({ [LOCAL_POOL_FORWARD_MARKER]: undefined }), false)
    assert.equal(isLocalPoolForward({}), false)
    assert.equal(isLocalPoolForward(undefined), false)
  })

  it('标记透传宿主 spread 后仍能被识别（未知字段不被拒）', () => {
    // 宿主 adapterStream 用 `{...options, ...resolvedConfig}` spread ——
    // 未知字段原样透传。守卫读到的是 spread 之后的对象。
    const options = { provider: 'deepseek-official', messages: mixedHistory() }
    const forwarded = { ...options, [LOCAL_POOL_FORWARD_MARKER]: true }
    const guard = new HostEgressGuard(ctx)
    assert.equal(guard.plan(forwarded as any), undefined)
  })
})

/**
 * §7.151 —— 实机形状回归（主人 2026-10-29 16:04 那一轮真实会话）
 *
 * ## 为什么要有这条
 *
 * 规则层的用例（`cloud-egress.test.ts`）证明的是「**某一条规则**成立」。但主人
 * 真正要问的是「**整段真实会话**裁完之后，发出去的那份到底是不是只有云段历史」。
 *
 * 这一条把实机那一轮的**消息构成**原样搬进来，钉死三个数字：
 *
 * - `kept = 43` / `dropped = 7` —— 与审计链 `llm.cloud.egress` 行的
 *   `keptMessages=43 droppedLocalHistory=7` **逐位一致**；
 * - `providerHistogram = { local-llm: 2, qwen-token-plan-cn: 12 }` —— 与审计行
 *   的 `providerHistogram` 一致（直方图统计的是**裁剪前**的整份请求）；
 * - model-selection 通知落在第 **32** 位 —— 与主人在 Edge 面板截图里看到的
 *   `index 32` 一致（**独立第三方证据**：不是我们自证，是主人眼里的那条）。
 *
 * 任何一次对 `planCloudEgress` / `planHostEgress` 的改动，只要动了口径，这三个
 * 数字就会对不上 ⇒ 立刻红。
 *
 * ## 这条会话的形状（取自 `~/.dsh/sessions/.../session.v4.jsonl.zstd`）
 *
 * | 轮次 | 意图 | provider | 消息数 |
 * |---|---|---|---|
 * | 1「你好」 | LOCAL | local-llm | 5（用户输入 + runtime-context + skill-catalog + time-context + 本地回答）|
 * | 2「查询最新的英国新闻」 | CLOUD（首次尝试失败）| qwen-token-plan-cn | 3 |
 * | 3「查询最新的英国新闻」重试 | CLOUD | qwen-token-plan-cn | 26（9 条云回答 + 13 条工具结果 + 3 条上下文）|
 * | 4「你可以做什么」 | LOCAL | local-llm | 2（用户输入 + 本地回答）|
 * | 5「查询下AI新闻」（当前轮）| CLOUD | qwen-token-plan-cn | 13 |
 *
 * 另有 1 条 system 提示（轮次起点之前 ⇒ 不属于任何轮次 ⇒ 保留）。
 * 合计 50 = 43（出网）+ 7（本地段，被拦下）。
 */
describe('§7.151 — 实机形状回归（2026-10-29 16:04 那一轮）', () => {
  const CLOUD = 'qwen-token-plan-cn'
  const LOCAL = 'local-llm'

  function sys(text: string): EgressMessage {
    return { role: 'system', content: [{ type: 'text', text }], source: { kind: 'system-prompt' } }
  }
  function user(text: string, kind = 'user'): EgressMessage {
    return { role: 'user', content: [{ type: 'text', text }], source: { kind } }
  }
  function dev(text: string): EgressMessage {
    return { role: 'developer', content: [{ type: 'text', text }], source: { kind: 'developer' } }
  }
  function asst(provider: string, text: string): EgressMessage {
    return { role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider, model: 'm' } }
  }
  function tool(text: string): EgressMessage {
    return { role: 'tool', content: [{ type: 'text', text }], source: { kind: 'tool-result' } }
  }

  /** 真实会话的 50 条消息（顺序与宿主会话日志一致）。 */
  function realSession(): EgressMessage[] {
    const m: EgressMessage[] = []
    // 轮次起点之前的运行时上下文 —— 不属于任何轮次 ⇒ 保留
    m.push(sys('system prompt'))

    // ── 第 1 轮（本地）：你好 ───────────────────────────────
    m.push(user('你好'))
    m.push(user('Current runtime context.', 'runtime-context'))
    m.push(user('<system-reminder> skills', 'skill-catalog'))
    m.push(user('Time sampled while preparing turn 1', 'time-context'))
    m.push(asst(LOCAL, '本地模型的回答（轮 1）'))

    // ── 第 2 轮（云）：首次尝试，失败 ────────────────────────
    m.push(user('查询最新的英国新闻'))
    m.push(user('[model changed: 轮 2]', 'model-selection'))
    m.push(dev('developer context'))

    // ── 第 3 轮（云）：同一问题重试 + 工具链 ─────────────────
    m.push(user('查询最新的英国新闻'))
    m.push(user('Current runtime context.', 'runtime-context'))
    m.push(dev('developer context'))
    m.push(asst(CLOUD, '云回答 1'))
    m.push(tool('工具结果 1'))
    m.push(dev('developer context'))
    m.push(asst(CLOUD, '云回答 2'))
    m.push(tool('工具结果 2'))
    m.push(tool('工具结果 3'))
    m.push(asst(CLOUD, '云回答 3'))
    m.push(tool('工具结果 4'))
    m.push(asst(CLOUD, '云回答 4'))
    m.push(tool('工具结果 5'))
    m.push(tool('工具结果 6'))
    m.push(asst(CLOUD, '云回答 5'))
    m.push(tool('工具结果 7'))
    m.push(asst(CLOUD, '云回答 6'))
    m.push(tool('工具结果 8'))
    m.push(tool('工具结果 9'))
    m.push(asst(CLOUD, '云回答 7'))
    m.push(tool('工具结果 10'))
    m.push(tool('工具结果 11'))
    m.push(asst(CLOUD, '云回答 8'))
    m.push(tool('工具结果 12'))
    m.push(tool('工具结果 13'))
    m.push(asst(CLOUD, '云回答 9'))

    // ── 第 4 轮（本地）：你可以做什么 ───────────────────────
    m.push(user('你可以做什么'))
    m.push(asst(LOCAL, '本地模型的回答（轮 4）'))

    // ── 第 5 轮（云，当前轮）：查询下AI新闻 ─────────────────
    m.push(user('查询下AI新闻'))
    m.push(user('Time sampled while preparing turn 5', 'time-context'))
    m.push(user('[model changed: 轮 5]', 'model-selection'))
    m.push(dev('developer context'))
    m.push(asst(CLOUD, '云回答 10'))
    m.push(tool('工具结果 14'))
    m.push(dev('developer context'))
    m.push(asst(CLOUD, '云回答 11'))
    m.push(tool('工具结果 15'))
    m.push(tool('工具结果 16'))
    m.push(asst(CLOUD, '云回答 12'))
    m.push(tool('工具结果 17'))
    m.push(tool('工具结果 18'))
    return m
  }

  it('出网的条数 = 43，被拦下的本地段 = 7（与审计链逐位一致）', () => {
    const plan = planHostEgress(realSession(), [LOCAL])
    assert.ok(plan, '有本地段 ⇒ 必须给出裁剪结果')
    assert.equal(plan!.messages.length, 43)
    assert.equal(plan!.droppedCount, 7)
    assert.equal(realSession().length, 50, '原始请求应是 50 条（43 + 7）')
  })

  it('provider 直方图：local-llm 2 条、云端 12 条（与审计行一致；统计的是裁剪前）', () => {
    const plan = planHostEgress(realSession(), [LOCAL])
    assert.deepEqual(plan!.histogram, { [LOCAL]: 2, [CLOUD]: 12 })
  })

  it('出网的那 43 条里，一条本地池的回答都没有', () => {
    const plan = planHostEgress(realSession(), [LOCAL])
    const kept = texts(plan!.messages)
    // 两个本地轮次的 assistant 回答 + 它们各自的用户输入，全部被拦下
    assert.equal(kept.filter(t => t.startsWith('本地模型的回答')).length, 0)
    assert.equal(kept.includes('你好'), false)
    assert.equal(kept.includes('你可以做什么'), false)
    // 直方图里的 2 条 local-llm 就是那两条本地回答 ⇒ 它们必须都不在 kept 里
    const localAssistants = plan!.messages.filter(m => m.role === 'assistant' && m.source?.provider === LOCAL)
    assert.equal(localAssistants.length, 0)
    // 云段历史一条不少
    assert.equal(kept.filter(t => t.startsWith('云回答')).length, 12)
    assert.equal(kept.filter(t => t.startsWith('工具结果')).length, 18)
  })

  it('model-selection 通知落在第 32 位（与主人在 Edge 面板看到的 index 32 一致）', () => {
    const plan = planHostEgress(realSession(), [LOCAL])
    const idx = plan!.messages.findIndex(m => texts([m]).join('').includes('[model changed: 轮 5]'))
    assert.equal(idx, 32)
  })

  it('当前轮的用户输入必须保留 —— 它是「当前内容」，本来就该出网', () => {
    const plan = planHostEgress(realSession(), [LOCAL])
    assert.ok(texts(plan!.messages).includes('查询下AI新闻'))
  })
})

/**
 * §7.164 —— 守卫层：历史轮里「云在前、本地在后」的真实形状
 *
 * ## 这条为什么存在
 *
 * §7.151 的实机回归（上一节）那条会话里，每一轮都是**纯**云段或**纯**本地段，
 * 所以「一轮内翻路由」的形状没被覆盖到。
 *
 * 真实会话数据里**确实有**这种轮次（provider 顺序
 * `qwen-token-plan-cn → qwen-token-plan-cn → local-llm → …`）：旧口径按「第一
 * 条 assistant 的 provider」整轮归云 ⇒ 整轮保留 ⇒ 本地模型的回答 + 本地工具
 * 输出跟着上云，且因为 `droppedCount === 0`，**守卫连裁剪都不触发**
 * （`planHostEgress` 返回 undefined，请求原样出网）。
 *
 * 这一条钉住守卫层的结果：守卫必须给出裁剪结果，且本地内容必须不在出网的那份里。
 */
describe('§7.164 — 守卫层：历史轮的云→本地混合形状', () => {
  const CLOUD = 'qwen-token-plan-cn'
  const LOCAL = 'local-llm'

  function user(text: string, kind = 'user'): EgressMessage {
    return { role: 'user', content: [{ type: 'text', text }], source: { kind } }
  }
  function asst(provider: string, text: string): EgressMessage {
    return { role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider, model: 'm' } }
  }
  function tool(text: string): EgressMessage {
    return { role: 'tool', content: [{ type: 'text', text }], source: { kind: 'tool', callId: 'c1' } }
  }

  /** 真实形状：同一轮里先云后本地。 */
  function mixedTurnHistory(): EgressMessage[] {
    return [
      user('第一轮用户输入'),
      asst(CLOUD, '云回答 1'),
      asst(CLOUD, '云回答 2'),
      asst(LOCAL, '本地模型的回答'),
      tool('本地工具的输出'),
      user('当前轮用户输入'),
    ]
  }

  it('守卫必须给出裁剪结果（旧口径下这里会返回 undefined —— 压根不裁）', () => {
    const plan = planHostEgress(mixedTurnHistory(), [LOCAL])
    assert.ok(plan, '历史轮里有本地产出 ⇒ 必须触发裁剪')
    assert.equal(plan!.droppedCount, 2)
  })

  it('本地模型的回答与本地工具输出都不在出网的那份里', () => {
    const plan = planHostEgress(mixedTurnHistory(), [LOCAL])
    const kept = texts(plan!.messages)
    assert.ok(!kept.includes('本地模型的回答'), '本地模型输出绝不能上云')
    assert.ok(!kept.includes('本地工具的输出'), '本地工具输出绝不能上云')
    // 云段前缀与当前轮输入照常保留
    assert.ok(kept.includes('云回答 1'))
    assert.ok(kept.includes('云回答 2'))
    assert.ok(kept.includes('当前轮用户输入'))
  })

  it('守卫走真实入口（provider=宿主自选模型）时同样拦得住', () => {
    const guard = new HostEgressGuard({
      reflect: { provide() { return () => {} } },
      provide() { return () => {} },
    } as any)
    const plan = guard.plan({
      provider: CLOUD,
      model: 'deepseek-v4.1-flash',
      messages: mixedTurnHistory(),
    })
    assert.ok(plan, '宿主原生 provider 的出网必须被裁')
    assert.equal(plan!.droppedCount, 2)
    const kept = texts(plan!.messages)
    assert.ok(!kept.includes('本地模型的回答'))
    assert.ok(!kept.includes('本地工具的输出'))
  })
})
