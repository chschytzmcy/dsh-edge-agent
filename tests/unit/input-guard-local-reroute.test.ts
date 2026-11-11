/**
 * §7.184 (2026-11-11): 边缘模式的**出网那一跳改道**。
 *
 * 主人裁决（2026-11-11）：「选择器完全不动，实际请求改道到本地池」。
 *
 *   - 边缘模式**不再改写会话选型** ⇒ 宿主模型选择器保持主人选的那个，不跳
 *     （§7.176 的钉选 / §7.179 的补钉 / §7.183 的回钉全部退役）；
 *   - 「本轮必须留在设备上」这条不变式改由**出网那一跳**保证：LOCAL 轮次的
 *     请求在 `llm/stream` 被换成 provider = 本地池。
 *
 * 宿主契约（已查实，app.asar）：
 *   - `llm/stream` 的 waterfall **默认处理**才是解析适配器的地方
 *     （dsh-llm `adapterStream()`：`registration = this.registration(options.provider)`）
 *     ⇒ 换掉 `options.provider` 就换掉了真正发出去的适配器；
 *   - cordis 的 waterfall **不接受替换载荷**（`next()` 无参）⇒ 只能换一个请求
 *     对象**重新派发**（与 §7.151 的出网裁剪同一个姿势）。
 *
 * 覆盖：
 *   1. LOCAL 轮次 + 非本地 provider ⇒ 重新派发到本地池（provider + model 都换）；
 *   2. 本地池拿到的是**全部**历史（本地池不出网，不裁 —— §7.131）；
 *   3. CLOUD / SANITIZED 轮次 ⇒ **不改道**（本轮就是要出网的）；
 *   4. 已经是本地池 ⇒ 不改道（重新派发回来的那趟也走这一支 ⇒ 防自锁）；
 *   5. 标准模式（没有 step state）⇒ 直通、零记录（§7.140）；
 *   6. fail-closed：本地路由不存在 / 解析不到 model / LLM runtime 不可用 ⇒ 抛错，
 *      绝不放行到可能上云的 provider；
 *   7. 审计行：`input-guard.reroute.local`（成功）/ `input-guard.reroute.blocked`（失败）。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

import { InputGuardServiceImpl } from '../../src/dsh-adapter/input-guard.ts'
import type { Config } from '../../src/dsh-adapter/input-guard.ts'
import { LOCAL_POOL_FORWARD_MARKER } from '../../src/dsh-adapter/host-llm-trace.ts'

// ── helpers ─────────────────────────────────────────────────────────────────

function defaultConfig(overrides: Partial<Config> = {}): Config {
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
    presetId: 'edge',
    ...overrides,
  }
}

function fakeAuditLog() {
  const entries: any[] = []
  return {
    entries,
    api: { async log(entry: any) { entries.push(entry) } },
  }
}

/**
 * 记录每次 `llm.stream` 调用的假宿主 LLM runtime。
 *
 * 顺带提供 `listProviders` / `listModels` —— DELEGATE 池的落点解析
 * （§7.180 的委托解析链）要靠它们问出「宿主当前那个 provider/model」。
 */
function fakeLlmRuntime(calls: Array<{ provider?: string; model?: string; messages?: unknown }>) {
  return {
    listProviders: () => [{ id: 'qwen-token-plan-cn', name: 'qwen-token-plan-cn' }],
    listModels: async (provider: string) => (
      provider === 'qwen-token-plan-cn' ? [{ provider, id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }] : []
    ),
    stream(options: any) {
      calls.push({
        provider: options?.provider,
        model: options?.model,
        messages: options?.messages,
      })
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: 'ok' }
      })()
    },
  }
}

function fakeCtx(opts: {
  localRouteAvailable?: boolean
  llm?: { stream: (o: unknown) => AsyncIterable<unknown> }
  hostModel?: string
} = {}) {
  const live = ['qwen-token-plan-cn']
  return {
    reflect: { provide(_n: string, _v: unknown) { return () => {} } },
    provide(_n: string, _v: unknown) { return () => {} },
    get(name: string) {
      if (name === 'modelRouter') {
        return { isAvailable: () => opts.localRouteAvailable ?? true }
      }
      if (name === 'llm') {
        return opts.llm ?? { stream: async function* () { /* no calls expected */ } }
      }
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => (opts.hostModel ? { provider: live[0]!, model: opts.hostModel } : undefined) }
      }
      throw new Error(`no service ${name}`)
    },
  }
}

/** 可覆写本地池形态（直连 / 委托）的测试子类。*/
class TestGuard extends InputGuardServiceImpl {
  constructor(
    ctx: any,
    config: Config,
    private readonly mode: 'direct' | 'delegate',
    auditLog?: any,
  ) {
    super(ctx, config, undefined, undefined, undefined, undefined, auditLog)
  }

  protected override localPoolShape(): any {
    return this.mode === 'direct'
      ? { baseUrl: 'http://127.0.0.1:8080/v1', model: 'qwen3.8-max' }
      : { delegate: true }
  }
}

/** 造一个边缘模式会话的 step 状态（llm/stream 靠它认出「这是边缘会话」）。*/
function armEdgeSession(svc: InputGuardServiceImpl, sessionId: string, category: 'LOCAL' | 'CLOUD' | 'SANITIZED'): void {
  svc.setTurnCategory(sessionId, category)
  svc.setStepState(sessionId, {
    sanitized: false,
    replacements: 0,
    sessionId,
    timestamp: Date.now(),
    routeSource: 'webui',
  })
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of stream) { /* drain */ }
}

// ── 改道本体 ────────────────────────────────────────────────────────────────

describe('handleLlmStream — §7.184 出网那一跳改道到本地池', () => {
  it('LOCAL 轮次 + 非本地 provider ⇒ 重新派发到本地池（provider 与 model 都换）', async () => {
    const audit = fakeAuditLog()
    const calls: Array<{ provider?: string; model?: string; messages?: unknown }> = []
    const ctx = fakeCtx({ llm: fakeLlmRuntime(calls) })
    const svc = new TestGuard(ctx as any, defaultConfig(), 'direct', audit.api)
    armEdgeSession(svc, 's1', 'LOCAL')

    const messages = [
      { role: 'user', content: '你是谁' },
      { role: 'assistant', content: '上一轮本地回复' },
    ]
    await drain(svc.handleLlmStream(
      { sessionId: 's1', provider: 'qwen-token-plan-cn', model: 'deepseek-v4.1-flash', messages } as any,
      async function* () { throw new Error('不该走到默认处理（改道后不调 next()）') },
    ))

    assert.equal(calls.length, 1, '必须重新派发一次')
    assert.equal(calls[0]!.provider, 'local-llm', 'provider 必须换成本地池')
    assert.equal(calls[0]!.model, 'qwen3.8-max', 'model 必须是本地池真正会跑的那个（与 wire 同源）')
    const line = audit.entries.find(e => e.kind === 'input-guard.reroute.local')
    assert.ok(line, '必须留改道审计行')
    assert.equal((line.payload as any).from.provider, 'qwen-token-plan-cn')
    assert.equal((line.payload as any).from.model, 'deepseek-v4.1-flash')
    assert.equal((line.payload as any).to.provider, 'local-llm')
    assert.equal((line.payload as any).to.model, 'qwen3.8-max')
  })

  it('本地池拿到的是**全部**历史（本地池不出网，不裁 —— §7.131）', async () => {
    const audit = fakeAuditLog()
    const calls: Array<{ provider?: string; model?: string; messages?: unknown }> = []
    const ctx = fakeCtx({ llm: fakeLlmRuntime(calls) })
    const svc = new TestGuard(ctx as any, defaultConfig(), 'direct', audit.api)
    armEdgeSession(svc, 's1', 'LOCAL')

    const messages = [
      { role: 'user', content: '第一条' },
      { role: 'assistant', content: '本地回复', source: { kind: 'model', provider: 'local-llm', model: 'qwen3.8-max' } },
      { role: 'user', content: '第二条' },
    ]
    await drain(svc.handleLlmStream(
      { sessionId: 's1', provider: 'qwen-token-plan-cn', model: 'deepseek-v4.1-flash', messages } as any,
      async function* () { throw new Error('不该走到默认处理') },
    ))

    assert.equal(calls.length, 1)
    assert.equal((calls[0]!.messages as unknown[]).length, 3, '本地池必须拿到全部历史，一条都不能少')
  })

  it('CLOUD 轮次 ⇒ 不改道（本轮就是要出网的，脱敏 + 只带云段历史照旧）', async () => {
    const audit = fakeAuditLog()
    const calls: Array<{ provider?: string; model?: string; messages?: unknown }> = []
    const ctx = fakeCtx({ llm: fakeLlmRuntime(calls) })
    const svc = new TestGuard(ctx as any, defaultConfig(), 'direct', audit.api)
    armEdgeSession(svc, 's1', 'CLOUD')

    let defaultUsed = false
    await drain(svc.handleLlmStream(
      { sessionId: 's1', provider: 'qwen-token-plan-cn', model: 'deepseek-v4.1-flash', messages: [] } as any,
      async function* () { defaultUsed = true; yield { type: 'text-delta', index: 0, text: 'x' } },
    ))

    assert.equal(defaultUsed, true, 'CLOUD 轮次必须走默认处理（不改道）')
    assert.equal(calls.length, 0, 'CLOUD 轮次不得被改道')
    assert.ok(!audit.entries.some(e => e.kind === 'input-guard.reroute.local'))
  })

  it('已经是本地池 ⇒ 不改道（重新派发回来的那趟也走这一支 ⇒ 防自锁）', async () => {
    const audit = fakeAuditLog()
    const calls: Array<{ provider?: string; model?: string; messages?: unknown }> = []
    const ctx = fakeCtx({ llm: fakeLlmRuntime(calls) })
    const svc = new TestGuard(ctx as any, defaultConfig(), 'direct', audit.api)
    armEdgeSession(svc, 's1', 'LOCAL')

    let defaultUsed = false
    await drain(svc.handleLlmStream(
      { sessionId: 's1', provider: 'local-llm', model: 'qwen3.8-max', messages: [] } as any,
      async function* () { defaultUsed = true; yield { type: 'text-delta', index: 0, text: 'x' } },
    ))

    assert.equal(defaultUsed, true)
    assert.equal(calls.length, 0, '本地 provider 不该被重新派发')
    assert.ok(!audit.entries.some(e => e.kind === 'input-guard.reroute.local'))
  })

  it('标准模式会话（没有 step state）⇒ 直通、零记录（§7.140）', async () => {
    const audit = fakeAuditLog()
    const calls: Array<{ provider?: string; model?: string; messages?: unknown }> = []
    const ctx = fakeCtx({ llm: fakeLlmRuntime(calls) })
    const svc = new TestGuard(ctx as any, defaultConfig(), 'direct', audit.api)
    // 没有 armEdgeSession ⇒ 这个会话不是边缘会话。

    let defaultUsed = false
    await drain(svc.handleLlmStream(
      { sessionId: 's1', provider: 'qwen-token-plan-cn', model: 'deepseek-v4.1-flash', messages: [] } as any,
      async function* () { defaultUsed = true; yield { type: 'text-delta', index: 0, text: 'x' } },
    ))

    assert.equal(defaultUsed, true)
    assert.equal(calls.length, 0)
    assert.equal(audit.entries.length, 0, '标准模式不该留任何 edge 审计行')
  })

  it('DELEGATE 池 ⇒ 改道过去的 model 是委托落点那个（与 wire 同源）', async () => {
    const audit = fakeAuditLog()
    const calls: Array<{ provider?: string; model?: string; messages?: unknown }> = []
    const ctx = fakeCtx({ llm: fakeLlmRuntime(calls), hostModel: 'deepseek-v4.1-flash' })
    const svc = new TestGuard(ctx as any, defaultConfig(), 'delegate', audit.api)
    armEdgeSession(svc, 's1', 'LOCAL')

    await drain(svc.handleLlmStream(
      { sessionId: 's1', provider: 'qwen-token-plan-cn', model: 'deepseek-v4.1-flash', messages: [] } as any,
      async function* () { throw new Error('不该走到默认处理') },
    ))

    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.provider, 'local-llm')
    assert.equal(calls[0]!.model, 'deepseek-v4.1-flash', 'DELEGATE 池的落点是宿主当前那个')
  })
})

// ── fail-closed ─────────────────────────────────────────────────────────────

describe('handleLlmStream — §7.184 改道失败必须 fail-closed', () => {
  it('本地路由不存在 ⇒ 抛错（绝不放行到云端）+ 留 blocked 审计', async () => {
    const audit = fakeAuditLog()
    const calls: Array<{ provider?: string; model?: string; messages?: unknown }> = []
    const ctx = fakeCtx({ llm: fakeLlmRuntime(calls), localRouteAvailable: false })
    const svc = new TestGuard(ctx as any, defaultConfig(), 'direct', audit.api)
    armEdgeSession(svc, 's1', 'LOCAL')

    await assert.rejects(
      () => drain(svc.handleLlmStream(
        { sessionId: 's1', provider: 'qwen-token-plan-cn', model: 'deepseek-v4.1-flash', messages: [] } as any,
        async function* () { throw new Error('不该走到默认处理') },
      )),
      /本地路由/,
    )
    assert.equal(calls.length, 0, '改不动就不能发出任何请求')
    const blocked = audit.entries.find(e => e.kind === 'input-guard.reroute.blocked')
    assert.ok(blocked, '必须留 blocked 审计行')
    assert.match(String((blocked.payload as any).reason), /local-route-missing/)
  })

  it('宿主 LLM runtime 不可用 ⇒ 抛错（不是放行到云端）', async () => {
    const audit = fakeAuditLog()
    const ctx = fakeCtx({ llm: undefined })
    const svc = new TestGuard(ctx as any, defaultConfig(), 'direct', audit.api)
    armEdgeSession(svc, 's1', 'LOCAL')

    // ctx.get('llm') 返回一个没有 stream 的对象 ⇒ 重新派发不可用。
    ;(ctx as any).get = (name: string) => {
      if (name === 'modelRouter') return { isAvailable: () => true }
      if (name === 'llm') return {}
      throw new Error(`no service ${name}`)
    }

    await assert.rejects(
      () => drain(svc.handleLlmStream(
        { sessionId: 's1', provider: 'qwen-token-plan-cn', model: 'deepseek-v4.1-flash', messages: [] } as any,
        async function* () { throw new Error('不该走到默认处理') },
      )),
      /LLM runtime/,
    )
    const blocked = audit.entries.find(e => e.kind === 'input-guard.reroute.blocked')
    assert.ok(blocked)
    assert.equal((blocked.payload as any).reason, 'llm-runtime-unavailable')
  })
})

// ── §7.191 本地池 DELEGATE 转发的防自锁 ──────────────────────────────────────

/**
 * §7.191（2026-11-12）：本地池的 **DELEGATE 转发**不能被改道。
 *
 * §7.184 那句「重新派发回来的那趟 provider 已是本地池 ⇒ 天然不再改道
 * （防自锁）」**只在直连池下成立**。DELEGATE 池（§7.171）把请求转给**宿主的
 * 目标路由**（如 `qwen-token-plan-cn`）⇒ 回来那一趟的 provider 不是本地池 ⇒
 * 「provider !== localProvider」判据失效 ⇒
 *
 *   改道 → 本地池 → 委托（provider 换回宿主目标）→ 再进 waterfall → 再改道 → …
 *
 * ⇒ **无限乒乓**。实测（2026-11-12 桌面版）：递归 123 万次，JS 堆 4GB 爆掉，
 * 整机 OOM abort；意图分类器的 LLM 调用 5 次全挂（0/5），安检 5/6 挂。
 *
 * 判据必须是**转发标记**（`LOCAL_POOL_FORWARD_MARKER`）—— 转发后 provider 是
 * 宿主的目标路由，与「用户直接选了那个模型」在 provider 维度无法区分；裁剪
 * 路径（`hostEgressGuard.plan()`，§7.171）早就在用同一个标记。
 */
describe('handleLlmStream — §7.191 本地池的 DELEGATE 转发不会被无限改道', () => {
  it('本地池转发（带转发标记）⇒ 不改道，直接放行', async () => {
    const audit = fakeAuditLog()
    const calls: Array<{ provider?: string; model?: string }> = []
    const ctx = fakeCtx({ llm: fakeLlmRuntime(calls) })
    const svc = new TestGuard(ctx as any, defaultConfig(), 'delegate', audit.api)
    armEdgeSession(svc, 's1', 'LOCAL')

    // 这一趟就是本地池的 DELEGATE 转发：provider 已是宿主的目标路由，
    // 并带着 §7.171 的转发标记。
    await drain(svc.handleLlmStream(
      {
        sessionId: 's1',
        provider: 'qwen-token-plan-cn',
        model: 'deepseek-v4.1-flash',
        messages: [],
        [LOCAL_POOL_FORWARD_MARKER]: true,
      } as any,
      async function* () { yield { type: 'text-delta', index: 0, text: 'ok' } },
    ))

    assert.equal(calls.length, 0, '本地池自己的转发不能再被改道（否则就是无限乒乓）')
    const reroute = audit.entries.find(e => e.kind === 'input-guard.reroute.local')
    assert.equal(reroute, undefined, '本地池转发不该留下改道审计行')
  })

  it('本地池转发与改道不会形成无限乒乓（防自锁的第二判据）', async () => {
    const audit = fakeAuditLog()
    const calls: Array<{ provider?: string; model?: string }> = []
    let depth = 0
    // holder：假的宿主 runtime 要回调 svc.handleLlmStream（模拟委托转发），
    // 而 svc 又要用到这个 runtime ⇒ 循环依赖，用一个可变的 holder 串起来。
    const holder: { svc?: InputGuardServiceImpl } = {}
    // 假的宿主 LLM runtime：**模拟本地池的 DELEGATE 转发** ——
    // 回到宿主的 llm/stream，provider 换成宿主目标路由，并带转发标记。
    const ctx = fakeCtx({
      llm: {
        listProviders: () => [{ id: 'qwen-token-plan-cn', name: 'qwen-token-plan-cn' }],
        listModels: async (provider: string) => (
          provider === 'qwen-token-plan-cn'
            ? [{ provider, id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }]
            : []
        ),
        stream(options: any) {
          calls.push({ provider: options?.provider, model: options?.model })
          if (++depth > 5) {
            throw new Error('§7.191 防自锁失效：本地池转发被反复改道（无限乒乓）')
          }
          return holder.svc!.handleLlmStream(
            {
              ...options,
              provider: 'qwen-token-plan-cn',
              model: 'deepseek-v4.1-flash',
              [LOCAL_POOL_FORWARD_MARKER]: true,
            } as any,
            async function* () { yield { type: 'text-delta', index: 0, text: 'ok' } },
          )
        },
      },
    })
    holder.svc = new TestGuard(ctx as any, defaultConfig(), 'delegate', audit.api)
    const svc = holder.svc
    armEdgeSession(svc, 's1', 'LOCAL')

    // 主对话那一跳：provider 是宿主选的那个 ⇒ 该改道（LOCAL 轮次）。
    await drain(svc.handleLlmStream(
      { sessionId: 's1', provider: 'qwen-token-plan-cn', model: 'deepseek-v4.1-flash', messages: [] } as any,
      async function* () { yield { type: 'text-delta', index: 0, text: 'ok' } },
    ))

    assert.ok(calls.length <= 1, `改道只能发生一次（实际 ${calls.length} 次）—— 第二次就是乒乓`)
    assert.equal(calls[0]!.provider, 'local-llm', '第一次改道是换成本地池')
    const reroutes = audit.entries.filter(e => e.kind === 'input-guard.reroute.local')
    assert.equal(reroutes.length, 1, '改道审计行只能有一条')
  })
})
