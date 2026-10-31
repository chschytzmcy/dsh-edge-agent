/**
 * §7.151 —— **真运行时**集成验证：宿主 provider 的出网请求只带云段历史
 *
 * 这一组是本节最强的证据，也是**唯一能抓到 cordis Proxy 陷阱**的地方：
 *
 * - 单位测试用的 fake ctx 读一个不存在的属性只会返回 undefined；**真 cordis
 *   的 ctx 是 Proxy**，读一个既没 provide、也不在 `inject` 声明里的属性会
 *   **直接抛** `cannot get property "modelRouter" without inject`
 *   （cordis 4.x `ReflectService.handler.get`）。
 *   §7.151 的守卫与 §7.131 的 adapter 侧裁剪都取 model-router 的本地名单 ——
 *   直取 `ctx.modelRouter` 就会在真机上抛错，裁剪**从来就没跑起来过**。
 *   本组用真 cordis Context + 真 LlmRuntime 把这条钉死。
 *
 * 走的链路是真的：`ctx.llm.stream()` → `ctx.waterfall('llm/stream', …)` →
 * 监听器 → adapter dispatch（`packages/llm/llm/src/index.ts:1174`）。
 * 请求体按宿主契约 **deep-frozen + markAgentLoopRequest**（监听器只读不改）。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'

import { InputGuardServiceImpl } from '../../src/dsh-adapter/input-guard.ts'
import { HostEgressGuard } from '../../src/dsh-adapter/host-egress-guard.ts'

/** 记录 adapter 真正收到的那一份请求体。 */
class RecordingAdapter extends LlmAdapter {
  readonly calls: any[] = []

  override async *stream(options: any): AsyncIterable<any> {
    this.calls.push(options)
    yield { type: 'text-delta', text: 'cloud answer' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function config(overrides: Record<string, unknown> = {}): any {
  return {
    enableInputGuard: true,
    sanitizeLocalTraffic: false,
    rejectOnPolicyViolation: true,
    downgradeOnSanitizeFailure: true,
    localProvider: 'local-llm',
    localModel: 'qwen3.8-flash',
    cloudApiKeyEnv: 'DEEPSEEK_API_KEY',
    defaultCloudProvider: 'cloud-llm',
    defaultCloudModel: 'deepseek-chat',
    ...overrides,
  }
}

/** 宿主契约：LOOP 构建的请求 deep-frozen + 带 markAgentLoopRequest 标记。 */
function frozenLoopRequest(sessionId = 's1', provider = 'qwen-token-plan-cn') {
  const messages = Object.freeze([
    Object.freeze({
      role: 'user',
      content: Object.freeze([{ type: 'text', text: '本地轮输入' }]),
      source: Object.freeze({ kind: 'user' }),
    }),
    Object.freeze({
      role: 'assistant',
      content: Object.freeze([{ type: 'text', text: '本地轮回答' }]),
      source: Object.freeze({ kind: 'model', provider: 'local-llm', model: 'qwen3.8-flash' }),
    }),
    Object.freeze({
      role: 'user',
      content: Object.freeze([{ type: 'text', text: '当前轮输入' }]),
      source: Object.freeze({ kind: 'user' }),
    }),
  ])
  return markAgentLoopRequest(Object.freeze({
    provider,
    model: 'deepseek-v4.1-flash',
    messages,
    sessionId,
  })) as any
}

function textsOf(options: any): string[] {
  return (options.messages ?? []).map((m: any) => m.content?.[0]?.text ?? '')
}

/**
 * 模拟「插件跑在边缘模式 preset 的 scope 里」的 cordis ctx。
 *
 * cordis 4.x 的 ctx 是 Proxy：读一个**既没 provide、也没在 `inject` 声明里**的
 * 属性会**直接抛** `cannot get property "x" without inject`。input-guard 的
 * inject 里**没有 'llm'**，而它跑在 preset scope 里 ⇒ `ctx.llm` 直取必炸
 * （15:54 实机：整轮处理失败，报的就是这句）。
 *
 * 而 `ctx.get('x')` 是安全读法（cordis 把 `get` mixin 到 ctx 上；读不到返回
 * undefined，不抛）—— 同文件的 `cloudAvailable()` 早就在用它。
 *
 * 这个代理把「直取未声明服务」复现成抛错，让回归测试能钉死这条。
 */
function scopedCtxLike(root: Context): Context {
  const UNDECLARED = new Set(['llm', 'modelRouter', 'auditLog', 'sanitizer', 'agentDefaultModel'])
  return new Proxy(root as any, {
    get(target, prop, recv) {
      if (typeof prop === 'symbol') return Reflect.get(target, prop, recv)
      if (UNDECLARED.has(prop)) {
        throw new Error(`cannot get property "${String(prop)}" without inject`)
      }
      return Reflect.get(target, prop, recv)
    },
  })
}

/** 真 cordis Context + 真 LlmRuntime（服务跑在 scope 型 ctx 上）。 */
function harness(provider = 'qwen-token-plan-cn') {
  const ctx = new Context()
  void new LlmRuntime(ctx)
  const adapter = new RecordingAdapter()
  ctx.llm.registerAdapter([provider], adapter)
  const svc = new InputGuardServiceImpl(scopedCtxLike(ctx) as any, config())
  // 边缘会话的 pre-step 状态（真实链路里由 handlePreStep 写入）。
  ;(svc as any).stepState.set('s1', {
    sanitized: false, replacements: 0, sessionId: 's1', timestamp: Date.now(),
  })
  return { ctx, svc, adapter }
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of stream) { void _ }
}

describe('§7.151 — 真运行时：出网请求只带云段历史', () => {
  it('scope 型 ctx：直取 ctx.llm 会抛，安全读法 ctx.get("llm") 正常', () => {
    // 这就是 15:54 实机失败的形态：插件跑在 preset scope 里，inject 里没有
    // 'llm' ⇒ 直取抛错。守卫必须走 ctx.get()。
    const ctx = new Context()
    void new LlmRuntime(ctx)
    const scoped = scopedCtxLike(ctx)
    assert.throws(() => (scoped as any).llm, /cannot get property "llm" without inject/)
    assert.equal(typeof (scoped as any).get('llm').stream, 'function')
  })

  it('宿主 provider 的出网请求里，本地历史被裁掉，当前轮留下', async () => {
    const { ctx, svc, adapter } = harness()
    ctx.on('llm/stream', (options: any, next: any) => svc.handleLlmStream(options, next), { global: true } as any)

    await drain(ctx.llm.stream(frozenLoopRequest()))

    assert.equal(adapter.calls.length, 1, '只应派发一次（重新派发不是无限递归）')
    assert.deepEqual(textsOf(adapter.calls[0]!), ['当前轮输入'], '出网请求里只剩当前轮')
  })

  it('反向证伪：没有守卫时，宿主 provider 收到的是**全部**历史', async () => {
    // 同样的真运行时，只是**不注册**守卫 —— 证明裁剪确实是守卫做的，
    // 而不是宿主自己裁的（宿主契约：请求体是纯函数，监听器只读不改）。
    const { ctx, adapter } = harness()
    await drain(ctx.llm.stream(frozenLoopRequest()))

    assert.equal(adapter.calls.length, 1)
    assert.deepEqual(textsOf(adapter.calls[0]!), ['本地轮输入', '本地轮回答', '当前轮输入'])
  })

  it('本地池的请求带全部历史（裁决：本地池不出网，不裁）', async () => {
    const { ctx, svc, adapter } = harness('local-llm')
    ctx.on('llm/stream', (options: any, next: any) => svc.handleLlmStream(options, next), { global: true } as any)

    await drain(ctx.llm.stream(frozenLoopRequest('s1', 'local-llm')))

    assert.equal(adapter.calls.length, 1)
    assert.deepEqual(textsOf(adapter.calls[0]!), ['本地轮输入', '本地轮回答', '当前轮输入'])
  })

  it('守卫取本地名单时**不能**因 cordis Proxy 抛错（model-router 未 provide）', () => {
    // cordis 4.x：读未 provide 且未在 inject 声明里的属性 → 直接抛
    // `cannot get property "modelRouter" without inject`。
    // 直取 ctx.modelRouter 会让裁剪在真机上抛错 ⇒ 裁剪从来没跑起来过。
    const ctx = new Context()
    void new LlmRuntime(ctx)
    const guard = new HostEgressGuard(ctx as any)
    assert.deepEqual(guard.localProviders(), ['local-llm'])

    // 模型 router 存在时，用它的 LOCAL 名单（与路由判定同一份事实源）。
    const ctx2 = new Context()
    void new LlmRuntime(ctx2)
    ;(ctx2 as any).provide('modelRouter', {
      listDetailed: () => [
        { provider: 'local-llm', realm: 'LOCAL' },
        { provider: 'qwen-local', realm: 'LOCAL' },
        { provider: 'qwen-token-plan-cn', realm: 'CLOUD' },
      ],
    })
    const guard2 = new HostEgressGuard(ctx2 as any)
    assert.deepEqual(guard2.localProviders(), ['local-llm', 'qwen-local'])
  })
})

/**
 * §7.165 —— 裁剪判断**自己抛错**时的语义
 *
 * ## 为什么要有这一组
 *
 * 裁剪判断（`planCloudEgress`）会遍历消息并读 `message.role`。请求体里混进
 * null / undefined 元素就会抛 TypeError。宿主契约下消息都是规范对象，但守卫
 * 不能被人为构造的载荷打穿。
 *
 * 抛错路径的关键事实（实测确认）：`plan()` 在 waterfall 监听器里**同步**执行，
 * 抛错发生在派发**之前** ⇒ 请求**根本没到 provider**（fail-closed，不会泄露）。
 *
 * 原来缺的是**证据**：这一路上没有任何审计行，面板上看起来像「什么都没发生」。
 * 本项目对面板的纪律是「宁可漏显示，也不能显示一件没发生过的事」；这里恰恰
 * 相反 —— **发生了拦截却什么都不显示**。§7.165 补上一条审计行，fail-closed
 * 语义一个字不改。
 */
describe('§7.165 — 裁剪判断抛错：fail-closed + 必须留证据', () => {
  it('消息数组里混进 null ⇒ 请求没到 provider，且审计行落盘', async () => {
    const rows: any[] = []
    const auditLog = { log: async (row: any) => { rows.push(row); return row } }

    const ctx = new Context()
    void new LlmRuntime(ctx)
    const adapter = new RecordingAdapter()
    ctx.llm.registerAdapter(['qwen-token-plan-cn'], adapter)
    const svc = new InputGuardServiceImpl(
      scopedCtxLike(ctx) as any, config(),
      undefined, undefined, undefined, undefined, auditLog as any,
    )
    ;(svc as any).stepState.set('s1', {
      sanitized: false, replacements: 0, sessionId: 's1', timestamp: Date.now(),
    })
    ctx.on('llm/stream', (options: any, next: any) => svc.handleLlmStream(options, next), { global: true } as any)

    const bad = markAgentLoopRequest(Object.freeze({
      provider: 'qwen-token-plan-cn',
      model: 'deepseek-v4.1-flash',
      messages: Object.freeze([null as any]),
      sessionId: 's1',
    })) as any

    let thrown: unknown
    try {
      await drain(ctx.llm.stream(bad))
    } catch (err) {
      thrown = err
    }

    assert.ok(thrown, '异常必须继续往上抛（fail-closed 语义不变）')
    assert.equal(adapter.calls.length, 0, 'fail-closed：请求根本没到 provider')

    const blocked = rows.find(r => r.kind === 'llm.cloud.egress.blocked')
    assert.ok(blocked, '发生了拦截就必须有审计行 —— 面板不能“什么都没发生”')
    assert.equal(blocked!.level, 'security')
    assert.equal(blocked!.payload.reason, 'plan-error')
    assert.equal(blocked!.payload.provider, 'qwen-token-plan-cn')
    assert.equal(typeof blocked!.payload.error, 'string')
  })

  it('没有审计通道时也不改变 fail-closed 语义（异常照抛、请求照不到 provider）', async () => {
    const ctx = new Context()
    void new LlmRuntime(ctx)
    const adapter = new RecordingAdapter()
    ctx.llm.registerAdapter(['qwen-token-plan-cn'], adapter)
    const svc = new InputGuardServiceImpl(scopedCtxLike(ctx) as any, config())
    ;(svc as any).stepState.set('s1', {
      sanitized: false, replacements: 0, sessionId: 's1', timestamp: Date.now(),
    })
    ctx.on('llm/stream', (options: any, next: any) => svc.handleLlmStream(options, next), { global: true } as any)

    const bad = markAgentLoopRequest(Object.freeze({
      provider: 'qwen-token-plan-cn',
      model: 'deepseek-v4.1-flash',
      messages: Object.freeze([undefined as any]),
      sessionId: 's1',
    })) as any

    let thrown: unknown
    try {
      await drain(ctx.llm.stream(bad))
    } catch (err) {
      thrown = err
    }
    assert.ok(thrown)
    assert.equal(adapter.calls.length, 0)
  })
})
