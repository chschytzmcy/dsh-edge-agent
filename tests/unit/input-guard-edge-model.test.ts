/**
 * §7.176 (2026-11-11): 边缘模式的**会话默认模型** —— input-guard 的
 * `agent/created` 监听器把会话级 modelSelection 钉到本地池。
 *
 * 覆盖：
 *   1. 纯函数 resolveEdgeDefaultSelection —— 直连 / 委托两种模式下的 provider+model；
 *   2. 纯函数 shouldProvisionEdgeModel —— 显式选择优先于 preset 默认；
 *   3. handleAgentCreated —— 钉 / 不钉的各条分支，以及「绝不让 agent 创建失败」。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

import {
  InputGuardServiceImpl,
  apply,
  resolveEdgeDefaultSelection,
  shouldProvisionEdgeModel,
} from '../../src/dsh-adapter/input-guard.ts'
import type { Config } from '../../src/dsh-adapter/input-guard.ts'

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
 * 假 ctx：
 *   - `get('modelRouter')` → isAvailable（本地路由在不在）；
 *   - `get('agentDefaultModel')` → currentSelection（宿主当前选的模型）。
 */
function fakeCtx(opts: {
  localRouteAvailable?: boolean
  hostModel?: string
} = {}) {
  return {
    reflect: { provide(_n: string, _v: unknown) { return () => {} } },
    provide(_n: string, _v: unknown) { return () => {} },
    get(name: string) {
      if (name === 'modelRouter') {
        return { isAvailable: () => opts.localRouteAvailable ?? true }
      }
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => (opts.hostModel ? { provider: 'deepseek-official', model: opts.hostModel } : undefined) }
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

  protected override localPoolMode(): 'direct' | 'delegate' {
    return this.mode
  }
}

/** 造一个「宿主 AgentModel」形状的对象（dsh-agent 的 AgentModel）。*/
function fakeAgentModel(opts: {
  recorded?: { provider?: string; model?: string } | null
  options?: { provider?: string; model?: string }
  throwOnSelect?: boolean
} = {}) {
  const selections: Array<{ provider: string; model: string }> = []
  return {
    selections,
    model: {
      select(selection: { provider: string; model: string }) {
        if (opts.throwOnSelect) throw new Error('select failed')
        selections.push(selection)
      },
      recordedSelection: () => opts.recorded ?? null,
      options: opts.options,
    },
  }
}

// ── 纯函数 ──────────────────────────────────────────────────────────────────

describe('resolveEdgeDefaultSelection — §7.176', () => {
  it('直连池：用本地池自己的 model id', () => {
    const r = resolveEdgeDefaultSelection('local-llm', 'qwen3.8-flash', 'deepseek-v4.1-flash', false)
    assert.equal(r.provider, 'local-llm')
    assert.equal(r.model, 'qwen3.8-flash')
    assert.equal(r.source, 'local-pool')
  })

  it('DELEGATE：wire 上跑的是宿主当前模型 ⇒ 用宿主那个 id（不写不符实际的名字）', () => {
    const r = resolveEdgeDefaultSelection('local-llm', 'qwen3.8-flash', 'deepseek-v4.1-flash', true)
    assert.equal(r.provider, 'local-llm')
    assert.equal(r.model, 'deepseek-v4.1-flash')
    assert.equal(r.source, 'host-delegate')
  })

  it('DELEGATE 且宿主没有可用模型：退回本地池 model id', () => {
    const r = resolveEdgeDefaultSelection('local-llm', 'qwen3.8-flash', undefined, true)
    assert.equal(r.model, 'qwen3.8-flash')
    assert.equal(r.source, 'local-pool')
  })

  it('DELEGATE 且宿主模型是空白串：同样退回本地池 model id', () => {
    const r = resolveEdgeDefaultSelection('local-llm', 'qwen3.8-flash', '   ', true)
    assert.equal(r.model, 'qwen3.8-flash')
    assert.equal(r.source, 'local-pool')
  })
})

describe('shouldProvisionEdgeModel — §7.176', () => {
  it('会话里还没有记录过选择 ⇒ 钉', () => {
    assert.equal(shouldProvisionEdgeModel(null, { provider: 'deepseek-official', model: 'deepseek-flash' }), true)
    assert.equal(shouldProvisionEdgeModel(undefined, undefined), true)
  })

  it('记录的选择 == agentOptions（宿主把默认值回显成 model/selection）⇒ 钉', () => {
    assert.equal(
      shouldProvisionEdgeModel({ provider: 'deepseek-official', model: 'deepseek-flash' }, { provider: 'deepseek-official', model: 'deepseek-flash' }),
      true,
    )
  })

  it('记录的选择 != agentOptions（用户显式选过）⇒ 不钉', () => {
    assert.equal(
      shouldProvisionEdgeModel({ provider: 'qwen-token-plan-cn', model: 'deepseek-v4.1-flash' }, { provider: 'deepseek-official', model: 'deepseek-flash' }),
      false,
    )
  })

  it('有记录但拿不到 agentOptions ⇒ 不钉（分不清是不是显式选择，宁可不改）', () => {
    assert.equal(shouldProvisionEdgeModel({ provider: 'x', model: 'y' }, undefined), false)
  })
})

// ── handleAgentCreated ──────────────────────────────────────────────────────

describe('handleAgentCreated — §7.176 边缘模式默认模型', () => {
  it('没有记录过选择 ⇒ 把会话选择钉到本地池（直连）', () => {
    const audit = fakeAuditLog()
    const svc = new TestGuard(fakeCtx({ hostModel: 'deepseek-v4.1-flash' }) as any, defaultConfig(), 'direct', audit.api)
    const am = fakeAgentModel({ options: { provider: 'deepseek-official', model: 'deepseek-flash' } })
    svc.handleAgentCreated({ agent: { id: 'a1', session: { id: 's1' }, model: am.model } })
    assert.deepEqual(am.selections, [{ provider: 'local-llm', model: 'qwen3.8-flash' }])
    const line = audit.entries.find(e => e.kind === 'input-guard.model.defaulted')
    assert.ok(line, '必须留审计行')
    assert.equal(line.payload.provider, 'local-llm')
    assert.equal(line.payload.source, 'local-pool')
  })

  it('DELEGATE 模式 ⇒ 钉的 model 是宿主当前那个', () => {
    const audit = fakeAuditLog()
    const svc = new TestGuard(fakeCtx({ hostModel: 'deepseek-v4.1-flash' }) as any, defaultConfig(), 'delegate', audit.api)
    const am = fakeAgentModel({ options: { provider: 'deepseek-official', model: 'deepseek-flash' } })
    svc.handleAgentCreated({ agent: { id: 'a1', session: { id: 's1' }, model: am.model } })
    assert.deepEqual(am.selections, [{ provider: 'local-llm', model: 'deepseek-v4.1-flash' }])
    const line = audit.entries.find(e => e.kind === 'input-guard.model.defaulted')
    assert.equal(line.payload.source, 'host-delegate')
  })

  it('用户显式选过模型 ⇒ 不动（显式选择优先）', () => {
    const audit = fakeAuditLog()
    const svc = new TestGuard(fakeCtx() as any, defaultConfig(), 'direct', audit.api)
    const am = fakeAgentModel({
      recorded: { provider: 'qwen-token-plan-cn', model: 'deepseek-v4.1-flash' },
      options: { provider: 'deepseek-official', model: 'deepseek-flash' },
    })
    svc.handleAgentCreated({ agent: { id: 'a1', session: { id: 's1' }, model: am.model } })
    assert.equal(am.selections.length, 0)
    const line = audit.entries.find(e => e.kind === 'input-guard.model.default-skipped')
    assert.equal(line.payload.reason, 'explicit-selection')
  })

  it('本地路由不存在（delegate=false 的 kill switch）⇒ 不钉，交给 §7.175 闸门报错', () => {
    const audit = fakeAuditLog()
    const svc = new TestGuard(fakeCtx({ localRouteAvailable: false }) as any, defaultConfig(), 'delegate', audit.api)
    const am = fakeAgentModel({ options: { provider: 'deepseek-official', model: 'deepseek-flash' } })
    svc.handleAgentCreated({ agent: { id: 'a1', session: { id: 's1' }, model: am.model } })
    assert.equal(am.selections.length, 0)
    const line = audit.entries.find(e => e.kind === 'input-guard.model.default-skipped')
    assert.match(String(line.payload.reason), /local-route-missing/)
  })

  it('select() 抛错 ⇒ 吞掉并审计，绝不让 agent 创建失败', () => {
    const audit = fakeAuditLog()
    const svc = new TestGuard(fakeCtx() as any, defaultConfig(), 'direct', audit.api)
    const am = fakeAgentModel({ throwOnSelect: true, options: { provider: 'deepseek-official', model: 'deepseek-flash' } })
    assert.doesNotThrow(() => {
      svc.handleAgentCreated({ agent: { id: 'a1', session: { id: 's1' }, model: am.model } })
    })
    const line = audit.entries.find(e => e.kind === 'input-guard.model.default-failed')
    assert.ok(line, '失败必须留审计行')
  })

  it('载荷里没有 agent.model ⇒ 什么都不做', () => {
    const audit = fakeAuditLog()
    const svc = new TestGuard(fakeCtx() as any, defaultConfig(), 'direct', audit.api)
    assert.doesNotThrow(() => {
      svc.handleAgentCreated({ agent: { id: 'a1', session: { id: 's1' } } })
      svc.handleAgentCreated(undefined)
      svc.handleAgentCreated({})
    })
    assert.equal(audit.entries.length, 0)
  })
})

// ── apply() 的接线 ──────────────────────────────────────────────────────────

describe('apply() — §7.176 监听器接线', () => {
  function makeApplyCtx() {
    const handlers: Record<string, (payload: any) => unknown> = {}
    const audits: any[] = []
    const ctx = {
      reflect: { provide(_n: string, _v: unknown) { return () => {} } },
      provide(_n: string, _v: unknown) { return () => {} },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      on(event: string, handler: any) {
        handlers[event] = handler
        return () => { delete handlers[event] }
      },
      promptGuard: { checkInput: async () => ({ safe: true }) },
      privacyPolicy: { matchRouting: () => null },
      intentRouter: { classify: async () => ({ category: 'LOCAL', confidence: 1 }) },
      sanitizer: { sanitize: async () => ({ sanitizedText: '', replacements: [] }) },
      auditLog: { log: async (e: any) => { audits.push(e) } },
      get(name: string) {
        if (name === 'modelRouter') return { isAvailable: () => true }
        if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) }
        throw new Error(`no service ${name}`)
      },
    }
    return { ctx, handlers, audits }
  }

  it('注册 agent/created 监听器，且是 scope 绑定（不带 global）', async () => {
    const { ctx, handlers, audits } = makeApplyCtx()
    const dispose = await apply(ctx as any, defaultConfig())
    assert.equal(typeof handlers['agent/created'], 'function')
    const reg = audits.find(e => e.kind === 'input-guard.hook.registered' && e.payload?.event === 'agent/created')
    assert.ok(reg, '必须留 hook.registered 审计行')
    assert.equal(reg.payload.global, undefined, '监听器必须 scope 绑定 —— global 会让标准模式也触发')
    assert.equal(reg.payload.scopedTo, 'agent-preset')
    await dispose()
  })

  it('监听器真的被接到服务上（派发 agent/created ⇒ 会话被钉到本地池）', async () => {
    const { ctx, handlers } = makeApplyCtx()
    const dispose = await apply(ctx as any, defaultConfig())
    const am = fakeAgentModel({ options: { provider: 'deepseek-official', model: 'deepseek-flash' } })
    await handlers['agent/created']!({ agent: { id: 'a1', session: { id: 's1' }, model: am.model } })
    assert.equal(am.selections.length, 1)
    assert.equal(am.selections[0]!.provider, 'local-llm')
    await dispose()
  })

  it('dispose() 之后监听器被摘掉', async () => {
    const { ctx, handlers } = makeApplyCtx()
    const dispose = await apply(ctx as any, defaultConfig())
    await dispose()
    assert.equal(handlers['agent/created'], undefined)
  })
})
