/**
 * §7.214 (2026-11-13): DELEGATE 严格档的判据升级为 **realm 判定**。
 *
 * ## 背景：§7.210 的粗粒度版本比主人给的口径粗一档
 *
 * §7.190 记下的既有事实：「DELEGATE 委托到云端时，闸门不拦」。主人当时给的
 * 选项是：「**DELEGATE 的委托目标按 model-router 的 realm 判定，非 LOCAL 就
 * fail-closed 拒收**」。
 *
 * §7.210 先做了「可见化 + 默认关闭的粗粒度严格档」：只要是 DELEGATE 就拒收。
 * 但 DELEGATE 的落点**可能本身就是本地的**（`llm.local.delegateProvider`
 * 指向一条 model-router 标注为 LOCAL 的路由）⇒ 那种情况**并不出网** ⇒
 * 按 §7.190 不该拒收。
 *
 * 本文件锁住 §7.214 的判据：
 *
 *   1. 严格档 + 落点 realm = **LOCAL** ⇒ **放行**（没出网，不该拒）；
 *   2. 严格档 + 落点 realm ≠ LOCAL ⇒ fail-closed 拒收（带 realm 证据）；
 *   3. 严格档 + realm **证不出来** ⇒ 仍拒收（fail-closed：证不出来 ≠ 本地）；
 *   4. 默认档（开关未开）⇒ 语义不变：照常改道、照常留审计事件；
 *   5. 默认档 + 落点 realm = LOCAL ⇒ **不留** `delegate-egress`
 *      （它没出网 ⇒ 写「出网」就是与实际行为相反的陈述），
 *      落点事实改记在 `reroute.local` 行上；
 *   6. 直连池 ⇒ **完全不查** realm（§7.211 裁决：本地池直连什么端点都不做
 *      特殊处理）。
 *
 * 覆盖之外还有一条**接线**断言：realm 的判定必须走 model-router 的
 * `listDetailed()`（与 cloud-llm-adapter / host-egress-guard 同源），
 * 不能靠 `local-` 前缀猜。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

import { InputGuardServiceImpl } from '../../src/dsh-adapter/input-guard.ts'
import type { Config } from '../../src/dsh-adapter/input-guard.ts'
import { providerRealm } from '../../src/dsh-adapter/provider-realm.ts'

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

const HOST_PROVIDER = 'qwen-token-plan-cn'

function fakeLlmRuntime(calls: Array<{ provider?: string; model?: string; messages?: unknown }>) {
  return {
    listProviders: () => [{ id: HOST_PROVIDER, name: HOST_PROVIDER }],
    listModels: async (provider: string) => (
      provider === HOST_PROVIDER ? [{ provider, id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }] : []
    ),
    stream(options: any) {
      calls.push({ provider: options?.provider, model: options?.model, messages: options?.messages })
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: 'ok' }
      })()
    },
  }
}

/**
 * 假宿主 ctx。
 *
 * `realms` = model-router 的 `listDetailed()` 该返回的清单；
 * `routerReachable` = false 时**没有** model-router（老宿主）⇒ realm 证不出来。
 */
function fakeCtx(opts: {
  llm?: { stream: (o: unknown) => AsyncIterable<unknown> }
  hostModel?: string
  realms?: Array<{ provider: string; realm: string }>
  routerReachable?: boolean
} = {}) {
  const listDetailedCalls: number[] = []
  const router = opts.routerReachable === false
    ? undefined
    : {
        isAvailable: () => true,
        listDetailed: () => {
          listDetailedCalls.push(1)
          return opts.realms ?? [{ provider: HOST_PROVIDER, realm: 'CLOUD' }]
        },
      }
  return {
    listDetailedCalls,
    reflect: { provide(_n: string, _v: unknown) { return () => {} } },
    provide(_n: string, _v: unknown) { return () => {} },
    get(name: string) {
      if (name === 'modelRouter') {
        if (!router) throw new Error('no service modelRouter')
        return router
      }
      if (name === 'llm') {
        return opts.llm ?? { stream: async function* () { /* no calls expected */ } }
      }
      if (name === 'agentDefaultModel') {
        return {
          currentSelection: () => (
            opts.hostModel ? { provider: HOST_PROVIDER, model: opts.hostModel } : undefined
          ),
        }
      }
      throw new Error(`no service ${name}`)
    },
  }
}

/** 可覆写本地池形态的测试子类（不依赖机器上那份 edge.json）。 */
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

function armEdgeSession(svc: InputGuardServiceImpl, sessionId: string, category: 'LOCAL' | 'CLOUD'): void {
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
  provider: HOST_PROVIDER,
  model: 'deepseek-v4.1-flash',
  messages: [] as unknown[],
}

// ── 严格档：realm 判定 ──────────────────────────────────────────────────────

describe('§7.214 严格档按 realm 判定（不是「有没有 baseUrl」）', () => {
  it('落点 realm = LOCAL ⇒ 放行（改道过去并不出网 ⇒ 不该拒）', async () => {
    const audit = fakeAuditLog()
    const calls: Array<{ provider?: string; model?: string; messages?: unknown }> = []
    const ctx = fakeCtx({
      llm: fakeLlmRuntime(calls),
      hostModel: 'deepseek-v4.1-flash',
      realms: [{ provider: HOST_PROVIDER, realm: 'LOCAL' }],
    })
    const svc = new TestGuard(ctx as any, defaultConfig(), DELEGATE_STRICT_SHAPE, audit.api)
    armEdgeSession(svc, 's1', 'LOCAL')

    await drain(svc.handleLlmStream(
      { ...LOCAL_TURN } as any,
      async function* () { throw new Error('不该走到默认处理') },
    ))

    assert.equal(calls.length, 1, '落点是 LOCAL ⇒ 这一轮没出网 ⇒ 严格档不该拒收')
    assert.equal(calls[0]!.provider, 'local-llm')
    assert.ok(
      !audit.entries.some(e => e.kind === 'input-guard.reroute.blocked'),
      '没被拦就不该写 blocked 事件',
    )
  })

  it('落点 realm ≠ LOCAL ⇒ fail-closed 拒收（带 realm 证据）', async () => {
    const audit = fakeAuditLog()
    const calls: Array<{ provider?: string; model?: string; messages?: unknown }> = []
    const ctx = fakeCtx({
      llm: fakeLlmRuntime(calls),
      hostModel: 'deepseek-v4.1-flash',
      realms: [{ provider: HOST_PROVIDER, realm: 'CLOUD' }],
    })
    const svc = new TestGuard(ctx as any, defaultConfig(), DELEGATE_STRICT_SHAPE, audit.api)
    armEdgeSession(svc, 's1', 'LOCAL')

    await assert.rejects(
      () => drain(svc.handleLlmStream(
        { ...LOCAL_TURN } as any,
        async function* () { throw new Error('不该走到默认处理') },
      )),
      /realm|LOCAL|requireLocalEndpoint/,
    )

    assert.equal(calls.length, 0, '被拒收的这一轮绝不能派发出去 —— 那才是出网')
    const blocked = audit.entries.find(e => e.kind === 'input-guard.reroute.blocked')
    assert.ok(blocked, '必须留 blocked 审计')
    assert.equal(blocked.level, 'security')
    assert.equal((blocked.payload as any).reason, 'local-endpoint-required')
    assert.equal((blocked.payload as any).delegateProvider, HOST_PROVIDER, '必须写下「转给谁」')
    assert.equal((blocked.payload as any).delegateRealm, 'CLOUD', '必须写下它的 realm')
  })

  it('realm 证不出来 ⇒ 仍然拒收（fail-closed：证不出来 ≠ 本地）', async () => {
    const audit = fakeAuditLog()
    const calls: Array<{ provider?: string; model?: string; messages?: unknown }> = []
    const ctx = fakeCtx({
      llm: fakeLlmRuntime(calls),
      hostModel: 'deepseek-v4.1-flash',
      routerReachable: false,
    })
    const svc = new TestGuard(ctx as any, defaultConfig(), DELEGATE_STRICT_SHAPE, audit.api)
    armEdgeSession(svc, 's1', 'LOCAL')

    await assert.rejects(() => drain(svc.handleLlmStream(
      { ...LOCAL_TURN } as any,
      async function* () { throw new Error('不该走到默认处理') },
    )))

    assert.equal(calls.length, 0, '证不出落点是不是本地 ⇒ 不能放行')
    const blocked = audit.entries.find(e => e.kind === 'input-guard.reroute.blocked')
    assert.ok(blocked)
    assert.equal((blocked.payload as any).delegateRealm, 'UNKNOWN')
    assert.equal((blocked.payload as any).realmSource, 'router-unavailable')
  })

  it('清单里有这个 provider 但 realm 字段缺失 ⇒ 同样按「证不出来」处理', async () => {
    const audit = fakeAuditLog()
    const calls: Array<{ provider?: string; model?: string; messages?: unknown }> = []
    const ctx = fakeCtx({
      llm: fakeLlmRuntime(calls),
      hostModel: 'deepseek-v4.1-flash',
      realms: [{ provider: HOST_PROVIDER, realm: '' }],
    })
    const svc = new TestGuard(ctx as any, defaultConfig(), DELEGATE_STRICT_SHAPE, audit.api)
    armEdgeSession(svc, 's1', 'LOCAL')

    await assert.rejects(() => drain(svc.handleLlmStream(
      { ...LOCAL_TURN } as any,
      async function* () { throw new Error('不该走到默认处理') },
    )))

    assert.equal(calls.length, 0)
    const blocked = audit.entries.find(e => e.kind === 'input-guard.reroute.blocked')
    assert.equal((blocked!.payload as any).delegateRealm, 'UNKNOWN')
  })
})

// ── 默认档：语义不变 ────────────────────────────────────────────────────────

describe('§7.214 默认档（开关未开）语义不变', () => {
  it('落点 realm = CLOUD ⇒ 照常改道 + 留 delegate-egress 事件（带落点事实）', async () => {
    const audit = fakeAuditLog()
    const calls: Array<{ provider?: string; model?: string; messages?: unknown }> = []
    const ctx = fakeCtx({
      llm: fakeLlmRuntime(calls),
      hostModel: 'deepseek-v4.1-flash',
      realms: [{ provider: HOST_PROVIDER, realm: 'CLOUD' }],
    })
    const svc = new TestGuard(ctx as any, defaultConfig(), DELEGATE_SHAPE, audit.api)
    armEdgeSession(svc, 's1', 'LOCAL')

    await drain(svc.handleLlmStream(
      { ...LOCAL_TURN } as any,
      async function* () { throw new Error('不该走到默认处理') },
    ))

    assert.equal(calls.length, 1, '默认档必须照常派发（上游有意放行这个语义）')
    const egress = audit.entries.find(e => e.kind === 'input-guard.reroute.delegate-egress')
    assert.ok(egress, 'DELEGATE 出网仍要留 security 事件')
    assert.equal(egress.level, 'security')
    assert.equal((egress.payload as any).blocked, false)
    assert.equal((egress.payload as any).delegateProvider, HOST_PROVIDER)
    assert.equal((egress.payload as any).delegateRealm, 'CLOUD')
    assert.ok(
      !audit.entries.some(e => e.kind === 'input-guard.reroute.blocked'),
      '默认档没被拦 ⇒ 不该写 blocked 事件',
    )
  })

  it('落点 realm = LOCAL ⇒ 不留 delegate-egress（它没出网）但落点事实记在 reroute.local 上', async () => {
    const audit = fakeAuditLog()
    const calls: Array<{ provider?: string; model?: string; messages?: unknown }> = []
    const ctx = fakeCtx({
      llm: fakeLlmRuntime(calls),
      hostModel: 'deepseek-v4.1-flash',
      realms: [{ provider: HOST_PROVIDER, realm: 'LOCAL' }],
    })
    const svc = new TestGuard(ctx as any, defaultConfig(), DELEGATE_SHAPE, audit.api)
    armEdgeSession(svc, 's1', 'LOCAL')

    await drain(svc.handleLlmStream(
      { ...LOCAL_TURN } as any,
      async function* () { throw new Error('不该走到默认处理') },
    ))

    assert.equal(calls.length, 1)
    assert.ok(
      !audit.entries.some(e => e.kind === 'input-guard.reroute.delegate-egress'),
      '落点是 LOCAL ⇒ 这一轮没出网 ⇒ 写「出网」就是与实际行为相反的陈述',
    )
    const reroute = audit.entries.find(e => e.kind === 'input-guard.reroute.local')
    assert.ok(reroute, '改道事实仍要留痕')
    assert.equal((reroute.payload as any).mode, 'delegate')
    assert.equal((reroute.payload as any).delegateProvider, HOST_PROVIDER)
    assert.equal((reroute.payload as any).delegateRealm, 'LOCAL')
  })

  it('直连池 ⇒ 完全不查 realm（§7.211：本地池直连什么端点都不做特殊处理）', async () => {
    const audit = fakeAuditLog()
    const calls: Array<{ provider?: string; model?: string; messages?: unknown }> = []
    const ctx = fakeCtx({
      llm: fakeLlmRuntime(calls),
      realms: [{ provider: HOST_PROVIDER, realm: 'CLOUD' }],
    })
    const svc = new TestGuard(ctx as any, defaultConfig(), { ...DIRECT_SHAPE, requireLocalEndpoint: true }, audit.api)
    armEdgeSession(svc, 's1', 'LOCAL')

    await drain(svc.handleLlmStream(
      { ...LOCAL_TURN } as any,
      async function* () { throw new Error('不该走到默认处理') },
    ))

    assert.equal(calls.length, 1, '直连池有真端点 ⇒ 严格档不该拦它')
    assert.equal(ctx.listDetailedCalls.length, 0, '直连池不该去问 model-router 的 realm')
    assert.ok(!audit.entries.some(e => e.kind === 'input-guard.reroute.blocked'))
    assert.ok(!audit.entries.some(e => e.kind === 'input-guard.reroute.delegate-egress'))
  })
})

// ── 判定本身：provider-realm ────────────────────────────────────────────────

describe('§7.214 providerRealm —— 判定只认 model-router 的 realm', () => {
  it('realm === LOCAL ⇒ isLocal', () => {
    const ctx = fakeCtx({ realms: [{ provider: 'x', realm: 'LOCAL' }] })
    const v = providerRealm(ctx, 'x')
    assert.equal(v.isLocal, true)
    assert.equal(v.realm, 'LOCAL')
    assert.equal(v.source, 'model-router')
  })

  it('realm 是别的值 ⇒ 不是本地', () => {
    const ctx = fakeCtx({ realms: [{ provider: 'x', realm: 'CLOUD' }] })
    const v = providerRealm(ctx, 'x')
    assert.equal(v.isLocal, false)
    assert.equal(v.realm, 'CLOUD')
  })

  it('provider 不在清单里 ⇒ 证不出来（不是本地）', () => {
    const ctx = fakeCtx({ realms: [{ provider: 'other', realm: 'LOCAL' }] })
    const v = providerRealm(ctx, 'x')
    assert.equal(v.isLocal, false)
    assert.equal(v.realm, 'UNKNOWN')
    assert.equal(v.source, 'model-router-missing')
  })

  it('没有 model-router ⇒ 证不出来', () => {
    const ctx = fakeCtx({ routerReachable: false })
    const v = providerRealm(ctx, 'x')
    assert.equal(v.isLocal, false)
    assert.equal(v.realm, 'UNKNOWN')
    assert.equal(v.source, 'router-unavailable')
  })

  it('没有落点（provider 空）⇒ 证不出来', () => {
    const ctx = fakeCtx()
    const v = providerRealm(ctx, '')
    assert.equal(v.isLocal, false)
    assert.equal(v.source, 'no-target')
  })

  it('刻意不靠 `local-` 前缀猜（那会 fail-open）', () => {
    const ctx = fakeCtx({ realms: [{ provider: 'local-ollama', realm: 'CLOUD' }] })
    const v = providerRealm(ctx, 'local-ollama')
    assert.equal(v.isLocal, false, '前缀不构成证据 —— model-router 说 CLOUD 就是 CLOUD')
    assert.equal(v.realm, 'CLOUD')
  })
})
