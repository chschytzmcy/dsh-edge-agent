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

/** 真 cordis Context + 真 LlmRuntime。 */
function harness(provider = 'qwen-token-plan-cn') {
  const ctx = new Context()
  void new LlmRuntime(ctx)
  const adapter = new RecordingAdapter()
  ctx.llm.registerAdapter([provider], adapter)
  const svc = new InputGuardServiceImpl(ctx as any, config())
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
