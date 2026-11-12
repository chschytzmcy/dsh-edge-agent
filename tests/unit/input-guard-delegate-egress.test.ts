/**
 * §7.210 (2026-11-12): 「DELEGATE 出网」从审计行里的一个 `mode` 字段，
 * 升级成**独立的一等 security 级审计事件**；并加一个**默认关闭**的 opt-in
 * 闸门 `llm.local.requireLocalEndpoint`。
 *
 * ## 背景：这不是「云端不可用」，是「DELEGATE 委托到云端时闸门不拦」
 *
 * intent=LOCAL 的轮次会被**改道**到本地池（§7.184）。但本地池**默认**是
 * DELEGATE（没配 `llm.local.baseUrl` ⇒ 转发宿主 provider，§7.171）
 * ⇒ 改道过去其实**出网**了 —— 而 intent=LOCAL 的承诺是「这一轮留在设备上」。
 *
 * 这个放行是**上游有意**的（`input-guard-local-reroute.test.ts` 有单测断言
 * DELEGATE 池照常改道）⇒ 改它 = 改产品语义 ⇒ 主人未拍板前**不改语义**。
 * 本文件锁住的是「**可见化 + 可选严格档**」：
 *
 *   1. 无论开关如何，DELEGATE 出网都留下一条 **security 级**审计事件
 *      `input-guard.reroute.delegate-egress`（以前只是 info 级
 *      `reroute.local` 行里的 `mode: 'delegate'` 字段 —— grep 'security'
 *      找不到、grep 'egress' 也找不到）。
 *   2. `llm.local.requireLocalEndpoint=true` ⇒ DELEGATE 时 **fail-closed 拒收**
 *      （这一轮绝不出网）。默认 **false** ⇒ **零行为变化**。
 *
 * 覆盖：
 *   1. 默认（开关未开）⇒ DELEGATE 照常改道（零行为变化）+ 留 security 事件；
 *   2. 开关未开 ⇒ **不**留 `reroute.blocked`（没被拦就别写「被拦了」）；
 *   3. 开关打开 + DELEGATE ⇒ fail-closed 抛错、**不派发**、留 blocked 事件；
 *   4. 开关打开 + DELEGATE ⇒ **不留** `reroute.local`（被拦下却写「改道了」= 假记录）；
 *   5. 开关打开 + **直连池** ⇒ 完全不受影响（照常改道、无 delegate-egress 事件）；
 *   6. 直连池 + 默认 ⇒ 无 delegate-egress 事件（零噪声）；
 *   7. 配置接线：`llm.local.requireLocalEndpoint` 从 edge.json 到达运行时，
 *      未配置时是 false（零行为变化的证据）。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

import { InputGuardServiceImpl } from '../../src/dsh-adapter/input-guard.ts'
import type { Config } from '../../src/dsh-adapter/input-guard.ts'
import { localPool } from '../../src/dsh-adapter/edge-config.ts'
import type { EdgeConfig } from '../../src/dsh-adapter/edge-config.ts'

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

function fakeLlmRuntime(calls: Array<{ provider?: string; model?: string; messages?: unknown }>) {
  return {
    listProviders: () => [{ id: 'qwen-token-plan-cn', name: 'qwen-token-plan-cn' }],
    listModels: async (provider: string) => (
      provider === 'qwen-token-plan-cn' ? [{ provider, id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }] : []
    ),
    stream(options: any) {
      calls.push({ provider: options?.provider, model: options?.model, messages: options?.messages })
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: 'ok' }
      })()
    },
  }
}

function fakeCtx(opts: {
  llm?: { stream: (o: unknown) => AsyncIterable<unknown> }
  hostModel?: string
} = {}) {
  return {
    reflect: { provide(_n: string, _v: unknown) { return () => {} } },
    provide(_n: string, _v: unknown) { return () => {} },
    get(name: string) {
      if (name === 'modelRouter') return { isAvailable: () => true }
      if (name === 'llm') {
        return opts.llm ?? { stream: async function* () { /* no calls expected */ } }
      }
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => (opts.hostModel ? { provider: 'qwen-token-plan-cn', model: opts.hostModel } : undefined) }
      }
      throw new Error(`no service ${name}`)
    },
  }
}

/**
 * 可覆写本地池形态的测试子类。
 *
 * `shape` 直接给 ⇒ 三个维度（直连/委托 × 严格档开关）都能构造，
 * 不依赖机器上那份 `~/.dsh-edge-agent/edge.json` 的真实内容。
 */
class TestGuard extends InputGuardServiceImpl {
  constructor(
    ctx: any,
    config: Config,
    private readonly shape: Record<string, unknown>,
    auditLog?: any,
  ) {
    super(ctx, config, undefined, undefined, undefined, undefined, auditLog)
  }

  protected override localPoolShape(): any {
    return this.shape
  }
}

const DIRECT_SHAPE = { baseUrl: 'http://127.0.0.1:8080/v1', model: 'qwen3.8-max' }
const DELEGATE_SHAPE = { delegate: true }
const DELEGATE_STRICT_SHAPE = { delegate: true, requireLocalEndpoint: true }

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

const LOCAL_TURN = {
  sessionId: 's1',
  provider: 'qwen-token-plan-cn',
  model: 'deepseek-v4.1-flash',
  messages: [] as unknown[],
}

// ── 一等审计事件 ────────────────────────────────────────────────────────────

describe('§7.210 DELEGATE 出网 —— 一等 security 审计事件', () => {
  it('DELEGATE 池 ⇒ 留一条 security 级 input-guard.reroute.delegate-egress', async () => {
    const audit = fakeAuditLog()
    const calls: Array<{ provider?: string; model?: string; messages?: unknown }> = []
    const ctx = fakeCtx({ llm: fakeLlmRuntime(calls), hostModel: 'deepseek-v4.1-flash' })
    const svc = new TestGuard(ctx as any, defaultConfig(), DELEGATE_SHAPE, audit.api)
    armEdgeSession(svc, 's1', 'LOCAL')

    await drain(svc.handleLlmStream(
      { ...LOCAL_TURN } as any,
      async function* () { throw new Error('不该走到默认处理') },
    ))

    const line = audit.entries.find(e => e.kind === 'input-guard.reroute.delegate-egress')
    assert.ok(line, '必须留 DELEGATE 出网事件 —— 以前它只是 reroute.local 行里的一个 mode 字段')
    assert.equal(line.level, 'security', '必须是 security 级 —— info 级在审计链里跟普通流水事件没区别')
    assert.equal((line.payload as any).reason, 'local-pool-delegate')
    assert.equal((line.payload as any).blocked, false, '默认档没被拦')
    assert.equal((line.payload as any).from.provider, 'qwen-token-plan-cn')
    assert.equal((line.payload as any).to.provider, 'local-llm')
  })

  it('直连池 ⇒ 没有 delegate-egress 事件（零噪声）', async () => {
    const audit = fakeAuditLog()
    const calls: Array<{ provider?: string; model?: string; messages?: unknown }> = []
    const ctx = fakeCtx({ llm: fakeLlmRuntime(calls) })
    const svc = new TestGuard(ctx as any, defaultConfig(), DIRECT_SHAPE, audit.api)
    armEdgeSession(svc, 's1', 'LOCAL')

    await drain(svc.handleLlmStream(
      { ...LOCAL_TURN } as any,
      async function* () { throw new Error('不该走到默认处理') },
    ))

    assert.ok(
      !audit.entries.some(e => e.kind === 'input-guard.reroute.delegate-egress'),
      '直连池根本没委托 ⇒ 不该有出网事件',
    )
  })
})

// ── opt-in 严格档 ───────────────────────────────────────────────────────────

describe('§7.210 requireLocalEndpoint —— opt-in 严格档（默认关闭 ⇒ 零行为变化）', () => {
  it('默认（开关未开）⇒ DELEGATE 照常改道 —— 既有语义一个字没改', async () => {
    const audit = fakeAuditLog()
    const calls: Array<{ provider?: string; model?: string; messages?: unknown }> = []
    const ctx = fakeCtx({ llm: fakeLlmRuntime(calls), hostModel: 'deepseek-v4.1-flash' })
    const svc = new TestGuard(ctx as any, defaultConfig(), DELEGATE_SHAPE, audit.api)
    armEdgeSession(svc, 's1', 'LOCAL')

    await drain(svc.handleLlmStream(
      { ...LOCAL_TURN } as any,
      async function* () { throw new Error('不该走到默认处理') },
    ))

    assert.equal(calls.length, 1, '默认档必须照常派发（上游有意放行这个语义）')
    assert.equal(calls[0]!.provider, 'local-llm')
    assert.ok(
      !audit.entries.some(e => e.kind === 'input-guard.reroute.blocked'),
      '没被拦就不该写 blocked 事件',
    )
  })

  it('开关打开 + DELEGATE ⇒ fail-closed 拒收（绝不出网）', async () => {
    const audit = fakeAuditLog()
    const calls: Array<{ provider?: string; model?: string; messages?: unknown }> = []
    const ctx = fakeCtx({ llm: fakeLlmRuntime(calls), hostModel: 'deepseek-v4.1-flash' })
    const svc = new TestGuard(ctx as any, defaultConfig(), DELEGATE_STRICT_SHAPE, audit.api)
    armEdgeSession(svc, 's1', 'LOCAL')

    await assert.rejects(
      () => drain(svc.handleLlmStream(
        { ...LOCAL_TURN } as any,
        async function* () { throw new Error('不该走到默认处理') },
      )),
      /DELEGATE|requireLocalEndpoint/,
    )

    assert.equal(calls.length, 0, '被拒收的这一轮绝不能派发出去 —— 那才是出网')
    const blocked = audit.entries.find(e => e.kind === 'input-guard.reroute.blocked')
    assert.ok(blocked, '必须留 blocked 审计')
    assert.equal(blocked.level, 'security')
    assert.equal((blocked.payload as any).reason, 'local-endpoint-required')
  })

  it('开关打开 + DELEGATE ⇒ 不留「改道了」的记录（假记录 = 面板上说谎）', async () => {
    const audit = fakeAuditLog()
    const calls: Array<{ provider?: string; model?: string; messages?: unknown }> = []
    const ctx = fakeCtx({ llm: fakeLlmRuntime(calls), hostModel: 'deepseek-v4.1-flash' })
    const svc = new TestGuard(ctx as any, defaultConfig(), DELEGATE_STRICT_SHAPE, audit.api)
    armEdgeSession(svc, 's1', 'LOCAL')

    await assert.rejects(() => drain(svc.handleLlmStream(
      { ...LOCAL_TURN } as any,
      async function* () { throw new Error('不该走到默认处理') },
    )))

    assert.ok(
      !audit.entries.some(e => e.kind === 'input-guard.reroute.local'),
      '被拦下的这一轮没改道 ⇒ 不能留 reroute.local 行',
    )
    const egress = audit.entries.find(e => e.kind === 'input-guard.reroute.delegate-egress')
    assert.ok(egress, '仍要留出网事件（blocked=true）—— 让人看得见「为什么被拦」')
    assert.equal((egress.payload as any).blocked, true)
  })

  it('开关打开 + 直连池 ⇒ 完全不受影响（照常改道）', async () => {
    const audit = fakeAuditLog()
    const calls: Array<{ provider?: string; model?: string; messages?: unknown }> = []
    const ctx = fakeCtx({ llm: fakeLlmRuntime(calls) })
    const svc = new TestGuard(ctx as any, defaultConfig(), { ...DIRECT_SHAPE, requireLocalEndpoint: true }, audit.api)
    armEdgeSession(svc, 's1', 'LOCAL')

    await drain(svc.handleLlmStream(
      { ...LOCAL_TURN } as any,
      async function* () { throw new Error('不该走到默认处理') },
    ))

    assert.equal(calls.length, 1, '直连池有真端点 ⇒ 严格档不该拦它')
    assert.equal(calls[0]!.provider, 'local-llm')
    assert.ok(!audit.entries.some(e => e.kind === 'input-guard.reroute.blocked'))
  })
})

// ── 配置接线 ────────────────────────────────────────────────────────────────

describe('§7.210 requireLocalEndpoint 配置接线', () => {
  it('edge.json 的 llm.local.requireLocalEndpoint 到达运行时', () => {
    const cfg = { llm: { local: { requireLocalEndpoint: true } } } as unknown as EdgeConfig
    assert.equal(localPool(cfg).requireLocalEndpoint, true)
  })

  it('没配 ⇒ false（零行为变化的证据）', () => {
    const cfg = { llm: { local: { baseUrl: 'http://127.0.0.1:8080/v1' } } } as unknown as EdgeConfig
    assert.equal(localPool(cfg).requireLocalEndpoint, false)
  })

  it('空配置 ⇒ false', () => {
    assert.equal(localPool({} as EdgeConfig).requireLocalEndpoint, false)
  })
})
