/**
 * §7.131 —— 出网请求的「只带云段历史」不变量
 *
 * 主人裁决（2026-10-27）：
 *
 * > 发给 cloudllm 的请求，只能携带**之前所有的上 cloudllm 的历史**；
 * > 而 localllm 需要携带**所有的**历史会话信息。
 *
 * 两条规则不对称，因为两条出口的风险不同：
 *
 * - `local-llm` = operator 自有设施，带全部历史不算出网 → **不裁**
 * - `cloud-llm` = 公网。本地轮次积累的历史属于**本地资产**，路由被改写/恢复
 *   切回云端时不能跟着上云 → **裁掉本地段**
 *
 * 判据落在宿主 dsh-llm 给每条 assistant 消息打的 `source.provider`
 * （`ModelMessageSource extends AssistantProviderMetadata`）—— 逐条可判，
 * 不靠推断。
 *
 * 裁决补充：「不用兼容历史会话，新会话支撑即可」→ 产不出 provider 的那一段
 * 按 `unknown` **保守丢弃**，不为旧会话写兼容分支。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import {
  assistantProviderHistogram,
  isUserInputMessage,
  planCloudEgress,
  providerSegment,
  type EgressMessage,
} from '../../src/dsh-adapter/cloud-egress'

function userMsg(text: string, kind = 'user'): EgressMessage {
  return { role: 'user', content: [{ type: 'text', text }], source: { kind } }
}

function assistantMsg(provider: string | undefined, text = 'ok'): EgressMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    source: { kind: 'model', provider, model: 'm1' },
  }
}

function toolMsg(text = 'tool output'): EgressMessage {
  return { role: 'tool', content: [{ type: 'text', text }], source: { kind: 'tool', callId: 'c1' } }
}

function texts(messages: readonly EgressMessage[]): string[] {
  return messages.map(m => {
    const c = m.content as Array<{ type: string; text?: string }>
    return c.map(b => b.text ?? '').join('')
  })
}

describe('§7.131 — provider → 段归属', () => {
  it('本地名单内的 provider → local', () => {
    assert.equal(providerSegment('local-llm'), 'local')
    assert.equal(providerSegment('local-llm', ['local-llm', 'qwen-local']), 'local')
  })

  it('以 local- 开头的 provider → local（与 model-router.resolveRoute 同口径）', () => {
    assert.equal(providerSegment('local-qwen'), 'local')
  })

  it('其余 provider → cloud（含宿主自选模型名）', () => {
    assert.equal(providerSegment('cloud-llm'), 'cloud')
    assert.equal(providerSegment('qwen-token-plan-cn'), 'cloud')
    assert.equal(providerSegment('deepseek-chat'), 'cloud')
  })

  it('provider 缺失 → unknown（无法证明上过云）', () => {
    assert.equal(providerSegment(undefined), 'unknown')
    assert.equal(providerSegment(''), 'unknown')
  })
})

describe('§7.131 — 轮次起点识别', () => {
  it('真实用户输入（source.kind=user）是轮次起点', () => {
    assert.equal(isUserInputMessage(userMsg('hi')), true)
  })

  it('宿主 model-switch 通知（source.kind=model-selection）不是轮次起点', () => {
    assert.equal(isUserInputMessage(userMsg('[model changed: ...]', 'model-selection')), false)
  })

  it('工具结果不是轮次起点', () => {
    assert.equal(isUserInputMessage(toolMsg()), false)
  })
})

describe('§7.131 — 云端出网：本地段一律不带', () => {
  it('本地段（含其 user 输入与 assistant 回复）整段丢弃', () => {
    const messages = [
      userMsg('本地轮的用户输入'),
      assistantMsg('local-llm', '本地模型的回答'),
      userMsg('本轮用户输入'),
    ]
    const plan = planCloudEgress(messages, { currentSegment: 'cloud' })
    assert.deepEqual(texts(plan.kept), ['本轮用户输入'])
    assert.equal(plan.droppedCount, 2)
  })

  it('之前上过云的历史保留（主人规则：只能携带之前所有上 cloudllm 的历史）', () => {
    const messages = [
      userMsg('云轮 1 输入'),
      assistantMsg('cloud-llm', '云轮 1 回答'),
      userMsg('云轮 2 输入'),
      assistantMsg('cloud-llm', '云轮 2 回答'),
      userMsg('本轮输入'),
    ]
    const plan = planCloudEgress(messages, { currentSegment: 'cloud' })
    assert.deepEqual(texts(plan.kept), [
      '云轮 1 输入', '云轮 1 回答', '云轮 2 输入', '云轮 2 回答', '本轮输入',
    ])
    assert.equal(plan.droppedCount, 0)
  })

  it('本地段与云段交替时，逐段判定：本地段丢、云段留', () => {
    const messages = [
      userMsg('L1'),
      assistantMsg('local-llm', 'L1a'),
      userMsg('C1'),
      assistantMsg('cloud-llm', 'C1a'),
      userMsg('L2'),
      assistantMsg('local-llm', 'L2a'),
      userMsg('C2'),
      assistantMsg('cloud-llm', 'C2a'),
      userMsg('NOW'),
    ]
    const plan = planCloudEgress(messages, { currentSegment: 'cloud' })
    assert.deepEqual(texts(plan.kept), ['C1', 'C1a', 'C2', 'C2a', 'NOW'])
    assert.equal(plan.droppedCount, 4)
  })

  it('宿主自选模型名（qwen-token-plan-cn）算云段', () => {
    const messages = [
      userMsg('C1'),
      assistantMsg('qwen-token-plan-cn', 'C1a'),
      userMsg('NOW'),
    ]
    const plan = planCloudEgress(messages, { currentSegment: 'cloud' })
    assert.deepEqual(texts(plan.kept), ['C1', 'C1a', 'NOW'])
  })
})

describe('§7.131 — 未知来源段：保守丢弃（不兼容历史会话）', () => {
  it('没有 provider 的 assistant 段整段丢弃', () => {
    const messages = [
      userMsg('旧会话输入'),
      assistantMsg(undefined, '旧会话回答'),
      userMsg('本轮输入'),
    ]
    const plan = planCloudEgress(messages, { currentSegment: 'cloud' })
    assert.deepEqual(texts(plan.kept), ['本轮输入'])
    assert.equal(plan.droppedCount, 2)
  })

  it('provider 为空串同样算未知', () => {
    const messages = [userMsg('x'), assistantMsg('', 'y'), userMsg('NOW')]
    const plan = planCloudEgress(messages, { currentSegment: 'cloud' })
    assert.deepEqual(texts(plan.kept), ['NOW'])
  })
})

describe('§7.131 — 本轮内容完整保留（含工具交互）', () => {
  it('本轮的 user + assistant(tool_call) + tool(result) 一起保留', () => {
    const messages = [
      userMsg('本地轮输入'),
      assistantMsg('local-llm', '本地回答'),
      userMsg('本轮输入'),
      // 本轮切到云 → 本轮的 tool_call 由**云端模型**产生（provider=cloud-llm）。
      // 这正是 tool 续步的第 2 跳出网时的真实形状。
      assistantMsg('cloud-llm', '本轮 tool_call'),
      toolMsg('本轮 tool 结果'),
    ]
    const plan = planCloudEgress(messages, { currentSegment: 'cloud' })
    assert.deepEqual(texts(plan.kept), ['本轮输入', '本轮 tool_call', '本轮 tool 结果'])
    assert.equal(plan.droppedCount, 2)
  })

  it('model-switch 通知属于它**前面**那一段 —— 切云时随本地段一起丢掉', () => {
    // 通知的文案是「上面的 assistant 回合由 X 生成，之后由 Y 继续」。它描述的
    // 正是它前面那一段，所以归属那一段。本地段被丢弃时，通知也一起丢 ——
    // 否则云端会收到一句「上面的回合由 local-llm 生成」，而那些回合根本不在
    // 请求里，语义反而错乱。
    const messages = [
      userMsg('L1'),
      assistantMsg('local-llm', 'L1a'),
      userMsg('切换通知', 'model-selection'),
      userMsg('NOW'),
    ]
    const plan = planCloudEgress(messages, { currentSegment: 'cloud' })
    assert.deepEqual(texts(plan.kept), ['NOW'])
    assert.equal(plan.droppedCount, 3)
  })
})

describe('§7.131 — 退化路径', () => {
  it('整段消息里没有用户输入 → 全部保留（宁可少裁也不静默清空）', () => {
    const messages = [assistantMsg('local-llm', 'x'), toolMsg('y')]
    const plan = planCloudEgress(messages, { currentSegment: 'cloud' })
    assert.equal(plan.kept.length, 2)
    assert.equal(plan.droppedCount, 0)
  })

  it('空消息数组 → 空结果，不抛', () => {
    const plan = planCloudEgress([], { currentSegment: 'cloud' })
    assert.deepEqual(plan.kept, [])
    assert.equal(plan.droppedCount, 0)
  })

  it('轮次起点之前的消息（无归属）保留 —— 那是运行时上下文不是会话历史', () => {
    const messages = [
      { role: 'system', content: [{ type: 'text', text: 'system prompt' }], source: { kind: 'system-prompt' } } as EgressMessage,
      userMsg('NOW'),
    ]
    const plan = planCloudEgress(messages, { currentSegment: 'cloud' })
    assert.deepEqual(texts(plan.kept), ['system prompt', 'NOW'])
  })
})

describe('§7.131 — 本地 provider 名单可配', () => {
  it('名单里的 provider 按 local 段丢', () => {
    const messages = [
      userMsg('x'),
      assistantMsg('qwen-local', 'a'),
      userMsg('NOW'),
    ]
    const plan = planCloudEgress(messages, { currentSegment: 'cloud', localProviders: ['local-llm', 'qwen-local'] })
    assert.deepEqual(texts(plan.kept), ['NOW'])
  })
})

describe('§7.151 — 当前轮里混进了本地产出的消息', () => {
  // 场景：同一轮内路由从 LOCAL 翻到 CLOUD（pre-step 每个 step 都重新分类）。
  // 那一轮里已经有本地池产出的 assistant 消息 —— 它是本地资产，不该上云；
  // 但**当前用户输入**是「当前内容」，本来就该出网（裁决：当前内容出网前脱敏）。
  it('本地产出的内容拦下，当前用户输入保留', () => {
    const messages = [
      userMsg('当前轮的用户输入'),
      assistantMsg('local-llm', '本地模型在这一步的回答'),
      toolMsg('本地工具的结果'),
    ]
    const plan = planCloudEgress(messages, { currentSegment: 'cloud' })
    assert.deepEqual(texts(plan.kept), ['当前轮的用户输入'])
    assert.equal(plan.droppedCount, 2)
  })

  it('反向证伪：不能整轮丢 —— 整轮丢会把当前用户输入一起丢掉', () => {
    const messages = [
      userMsg('当前轮的用户输入'),
      assistantMsg('local-llm', '本地回答'),
    ]
    const plan = planCloudEgress(messages, { currentSegment: 'cloud' })
    assert.ok(
      texts(plan.kept).includes('当前轮的用户输入'),
      '云端模型必须收到当前这一轮的问题，否则整轮答非所问',
    )
  })

  it('当前轮全是云段产出 → 全部保留（不误伤）', () => {
    const messages = [
      userMsg('当前轮的用户输入'),
      assistantMsg('qwen-token-plan-cn', '云端回答'),
      toolMsg('云端工具的结果'),
    ]
    const plan = planCloudEgress(messages, { currentSegment: 'cloud' })
    assert.deepEqual(texts(plan.kept), ['当前轮的用户输入', '云端回答', '云端工具的结果'])
    assert.equal(plan.droppedCount, 0)
  })

  it('当前轮没有 assistant 消息 → 全部保留', () => {
    const messages = [userMsg('当前轮的用户输入')]
    const plan = planCloudEgress(messages, { currentSegment: 'cloud' })
    assert.deepEqual(texts(plan.kept), ['当前轮的用户输入'])
    assert.equal(plan.droppedCount, 0)
  })

  it('历史轮的本地段照丢，当前轮的本地产出照拦（两件事互不干扰）', () => {
    const messages = [
      userMsg('本地轮输入'),
      assistantMsg('local-llm', '本地轮回答'),
      userMsg('当前轮输入'),
      assistantMsg('local-llm', '当前轮里的本地回答'),
    ]
    const plan = planCloudEgress(messages, { currentSegment: 'cloud' })
    assert.deepEqual(texts(plan.kept), ['当前轮输入'])
    assert.equal(plan.droppedCount, 3)
  })
})

describe('§7.131 — provider 分布观测（审计用）', () => {
  it('统计 assistant 消息的 provider 分布', () => {
    const messages = [
      assistantMsg('local-llm'),
      assistantMsg('local-llm'),
      assistantMsg('cloud-llm'),
      assistantMsg(undefined),
      userMsg('x'),
      toolMsg('y'),
    ]
    assert.deepEqual(assistantProviderHistogram(messages), {
      'local-llm': 2,
      'cloud-llm': 1,
      '<none>': 1,
    })
  })

  it('空输入 → 空分布', () => {
    assert.deepEqual(assistantProviderHistogram([]), {})
  })
})

/**
 * §7.164 —— 历史轮里「云在前、本地在后」的混合形状
 *
 * ## 这条为什么存在
 *
 * 旧口径：非当前轮的归属 = 该轮**第一条** assistant 的 provider。一轮里只要第一
 * 条是云，**整轮**都算云段 ⇒ 同一轮里本地模型产出的回答、以及它之后的本地工具
 * 输出，会被后续出网请求原样带走。
 *
 * 实测（用编译产物跑 `planCloudEgress`）：
 *
 * ```
 * 输入：user(第一轮) → assistant(qwen-token-plan-cn) → assistant(local-llm)
 *       → tool(本地工具输出) → user(当前轮)
 * 结果：kept 5 条、dropped 0 条 ⇒ 整段保留，连裁剪都没触发
 * ```
 *
 * 真实会话数据也证实过这个形状可达（provider 顺序
 * `qwen-token-plan-cn → qwen-token-plan-cn → local-llm → …`）。
 *
 * ## 修好之后的口径
 *
 * 历史轮里出现本地产出 ⇒ 从它起（含其后的工具结果）全部拦下；云段前缀留下
 * （那一部分真的上过云）。
 */
describe('§7.164 — 历史轮里的云→本地混合形状', () => {
  it('非当前轮的本地产出（及其后的工具结果）被拦下', () => {
    const messages = [
      userMsg('第一轮用户输入'),
      assistantMsg('qwen-token-plan-cn', '云回答 1'),
      assistantMsg('local-llm', '本地模型的回答'),
      toolMsg('本地工具的输出'),
      userMsg('当前轮用户输入'),
    ]
    const plan = planCloudEgress(messages, { currentSegment: 'cloud' })
    assert.deepEqual(texts(plan.kept), [
      '第一轮用户输入', '云回答 1', '当前轮用户输入',
    ])
    assert.equal(plan.droppedCount, 2)
  })

  it('反向证伪：云段前缀必须留下（那部分真的上过云，丢了就是误伤）', () => {
    const messages = [
      userMsg('第一轮用户输入'),
      assistantMsg('qwen-token-plan-cn', '云回答 1'),
      assistantMsg('local-llm', '本地模型的回答'),
      userMsg('当前轮用户输入'),
    ]
    const plan = planCloudEgress(messages, { currentSegment: 'cloud' })
    const kept = texts(plan.kept)
    assert.ok(kept.includes('云回答 1'), '云段前缀不能被误伤')
    assert.ok(kept.includes('第一轮用户输入'), '该轮用户输入随云段请求上过云')
    assert.ok(!kept.includes('本地模型的回答'), '本地产出绝不能上云')
  })

  it('混合轮里的纯云段轮次不受影响（前后夹着的云轮照常保留）', () => {
    const messages = [
      userMsg('纯云轮输入'),
      assistantMsg('qwen-token-plan-cn', '纯云轮回答'),
      userMsg('混合轮输入'),
      assistantMsg('qwen-token-plan-cn', '混合轮的云回答'),
      assistantMsg('local-llm', '混合轮的本地回答'),
      toolMsg('混合轮的本地工具输出'),
      userMsg('当前轮用户输入'),
    ]
    const plan = planCloudEgress(messages, { currentSegment: 'cloud' })
    assert.deepEqual(texts(plan.kept), [
      '纯云轮输入', '纯云轮回答',
      '混合轮输入', '混合轮的云回答',
      '当前轮用户输入',
    ])
    assert.equal(plan.droppedCount, 2)
  })

  it('本地产出排在云段之前 ⇒ 整轮拦下（那一轮只到过本地池）', () => {
    const messages = [
      userMsg('本地轮输入'),
      assistantMsg('local-llm', '本地回答'),
      assistantMsg('qwen-token-plan-cn', '后到的云回答'),
      userMsg('当前轮用户输入'),
    ]
    const plan = planCloudEgress(messages, { currentSegment: 'cloud' })
    assert.deepEqual(texts(plan.kept), ['当前轮用户输入'])
    assert.equal(plan.droppedCount, 3)
  })

  it('当前轮的混合形状口径不变（§7.151）：本地起全丢、当前用户输入保留', () => {
    const messages = [
      userMsg('当前轮用户输入'),
      assistantMsg('qwen-token-plan-cn', '本轮的云回答'),
      assistantMsg('local-llm', '本轮后来切到本地的回答'),
      toolMsg('本地工具输出'),
    ]
    const plan = planCloudEgress(messages, { currentSegment: 'cloud' })
    assert.deepEqual(texts(plan.kept), ['当前轮用户输入', '本轮的云回答'])
    assert.equal(plan.droppedCount, 2)
  })
})
