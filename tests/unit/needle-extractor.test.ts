/**
 * §7.93 Phase 4 — needle-extractor 骨架单测。
 *
 * 骨架期契约(全部在此锁死):
 *  1. inject 列表 = §7.92.2 proxy trap 防线:读 ctx.X 前必先列 inject;
 *     privacyPolicy 刻意不在列表(插件不读 categories,intent 判定归 intent-router)。
 *  2. Config schema 默认值 = .env / memory 契约逐字段一致(needleEnabled=false、
 *     url=:8081、timeout=1500、threshold=0.7、translate=on/local-llm、
 *     breaker/probe 四件套 = §7.92.6/§7.92.7 jev 同款默认)。
 *  3. service 构造期 `??` 回退与 schema 默认镜像一致(cordis 走 schema,
 *     测试/手工构造走 ??,两条路必须给同一个值)。
 *  4. isAvailable() = 总开关(Phase 6 才叠加 breaker;Phase 5 listener 的第一道 gate)。
 *  5. getStats() 返回副本 —— 调用方改不坏内部计数。
 *  6. apply() 零 waterfall 副作用:llm/tools/realmSkillBridge 全缺席也能
 *     boot/dispose(骨架期一次 HTTP 都不发,listener 一个都不挂)。
 *  7. boot ops-log 一行(§7.46 纪律):enabled/url/translate/timeout/threshold
 *     全在行内,运维排查"needle 为什么没生效"第一眼。
 *  8. createToolRunner() 惰性 loose-read:依赖齐 → ToolRunner;缺任一 /
 *     cordis proxy throw(§7.92.2)→ undefined(调用方 fall through)。
 *  9. audit():source='needle-extractor';log reject / auditLog 缺席都不炸。
 *
 * PII 纪律:本文件 fixture 一律占位(无真号真证)。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import {
  Config as ConfigSchema,
  NeedleExtractorServiceImpl,
  apply,
  inject,
  name as pluginName,
} from '../../src/dsh-adapter/needle-extractor.js'
import { ToolRunner } from '../../src/dsh-adapter/tool-runner.js'

// ── fixtures ────────────────────────────────────────────────────────────────

interface AuditEntry { level: string; kind: string; source: string; payload: Record<string, unknown> }

function makeCtx(extra: Record<string, unknown> = {}) {
  const logs: string[] = []
  const ctx = {
    reflect: { provide: () => {} },
    logger: {
      info: (m: string) => logs.push(m),
      warn: (m: string) => logs.push(m),
    },
    llm: null,
    ...extra,
  } as any
  return { ctx, logs }
}

function makeAuditLog(entries?: AuditEntry[], mode: 'resolve' | 'reject' = 'resolve') {
  const sink: AuditEntry[] = entries ?? []
  return {
    sink,
    log: (e: AuditEntry) => {
      sink.push(e)
      return mode === 'reject' ? Promise.reject(new Error('audit down')) : Promise.resolve()
    },
  }
}

function makeService(config: Record<string, unknown> = {}, ctxExtra: Record<string, unknown> = {}, auditMode?: 'resolve' | 'reject') {
  const entries: AuditEntry[] = []
  const { ctx, logs } = makeCtx(ctxExtra)
  const svc = new NeedleExtractorServiceImpl(ctx, config as never, makeAuditLog(entries, auditMode))
  return { svc, ctx, logs, entries }
}

/** §7.93 memory 契约:12 个字段的权威默认值(.env 翻译层未生效时的兜底)。 */
const EXPECTED_DEFAULTS = {
  needleEnabled: false,
  needleUrl: 'http://127.0.0.1:8081',
  needleTimeoutMs: 1500,
  needleTranslateTimeoutMs: 3000,
  needleConfidenceThreshold: 0.7,
  needleTranslateEnabled: true,
  needleTranslateProvider: 'local-llm',
  needleBreakerTtlMs: 30000,
  needleBootProbeEnabled: true,
  needleBootProbeTimeoutMs: 2000,
  needleBreakerProbeMs: 5000,
  needleProbeTimeoutMs: 1000,
} as const

// ── 1. plugin 面 ────────────────────────────────────────────────────────────

describe('needle-extractor:plugin 面', () => {
  it('name = needle-extractor(派工单 id 契约)', () => {
    assert.equal(pluginName, 'needle-extractor')
  })

  it('§7.92.2 inject 锁:llm/auditLog/realmSkillBridge/tools 四项,privacyPolicy 刻意缺席', () => {
    // 读 ctx.X 前必须先列 inject(cordis proxy 静默 throw "cannot get
    // property X without inject")。少列 = Phase 5/6 接线时静默失败;
    // 多列 privacyPolicy = 声明了不消费的依赖(计划草稿已裁掉:本插件
    // 不读 categories,intent 判定归 intent-router)。
    assert.deepEqual([...inject], ['llm', 'auditLog', 'realmSkillBridge', 'tools'])
    assert.ok(!(inject as readonly string[]).includes('privacyPolicy'))
  })
})

// ── 2. config schema 默认值 ─────────────────────────────────────────────────

describe('needle-extractor:config 默认值', () => {
  it('schema resolve 空 config → 12 字段与 .env/memory 契约逐字一致', () => {
    // schemastery schema 可调用:ConfigSchema({}) 即 cordis 挂载时的 resolve 路径。
    const resolved = ConfigSchema({} as never) as Record<string, unknown>
    for (const [k, v] of Object.entries(EXPECTED_DEFAULTS)) {
      assert.equal(resolved[k], v, `schema 默认漂移: ${k}`)
    }
  })

  it('schema 无多余字段(新增 config 必须同步 .env 翻译层 + 本测试)', () => {
    const resolved = ConfigSchema({} as never) as Record<string, unknown>
    assert.deepEqual(Object.keys(resolved).sort(), Object.keys(EXPECTED_DEFAULTS).sort())
  })

  it('service 构造期 ?? 回退与 schema 默认镜像一致(手工构造路径)', () => {
    const { svc } = makeService({})
    assert.deepEqual(svc.getConfigView(), { ...EXPECTED_DEFAULTS })
  })

  it('显式 config 覆盖默认(Phase 9 cordis.patch.yml env 翻译层的消费面)', () => {
    const { svc } = makeService({ needleEnabled: true, needleUrl: 'http://127.0.0.1:9999', needleTimeoutMs: 42 })
    const view = svc.getConfigView()
    assert.equal(view.needleEnabled, true)
    assert.equal(view.needleUrl, 'http://127.0.0.1:9999')
    assert.equal(view.needleTimeoutMs, 42)
    // 未覆盖字段仍吃默认
    assert.equal(view.needleConfidenceThreshold, 0.7)
  })
})

// ── 3. availability + stats ─────────────────────────────────────────────────

describe('needle-extractor:availability 与 stats', () => {
  it('isAvailable():默认 false(NEEDLE_ENABLED 默认关,user 终裁);显式 true 才可用', () => {
    assert.equal(makeService({}).svc.isAvailable(), false)
    assert.equal(makeService({ needleEnabled: true }).svc.isAvailable(), true)
    assert.equal(makeService({ needleEnabled: false }).svc.isAvailable(), false)
  })

  it('getStats() 返回副本:调用方改计数不污染内部', () => {
    const { svc } = makeService({})
    const s1 = svc.getStats()
    s1.needleExtractCalls = 999
    s1.needleEnabled = !s1.needleEnabled
    const s2 = svc.getStats()
    assert.equal(s2.needleExtractCalls, 0)
    assert.equal(s2.needleEnabled, false)
  })

  it('getStats() 初始形状:全计数 0、breaker 关、needleEnabled 反映配置', () => {
    const { svc } = makeService({ needleEnabled: true })
    const s = svc.getStats()
    assert.equal(s.needleEnabled, true)
    assert.equal(s.needleCircuitOpen, false)
    for (const k of Object.keys(s)) {
      if (typeof s[k as keyof typeof s] === 'number' && k !== 'needleEnabled') {
        assert.equal(s[k as keyof typeof s], 0, `计数 ${k} 初始非 0`)
      }
    }
  })
})

// ── 4. apply 生命周期(零副作用)─────────────────────────────────────────────

describe('needle-extractor:apply 生命周期', () => {
  it('llm/tools/realmSkillBridge 全缺席也能 boot + dispose(骨架期零 HTTP 零 listener)', () => {
    // ctx 上没有 on/registry/waterfall 任何东西:apply 若偷偷挂 listener
    // 或发 probe,这里会直接 TypeError —— "零副作用"由 fake ctx 的贫瘠证明。
    const { ctx, logs } = makeCtx()
    return apply(ctx, {}).then(async dispose => {
      assert.equal(typeof dispose, 'function')
      await dispose()
      assert.equal(logs.filter(l => l.includes('[needle-extractor] boot')).length, 1)
    })
  })

  it('boot ops-log 一行含 enabled/url/translate/timeout/threshold(§7.46 纪律,metadata only)', async () => {
    const { ctx, logs } = makeCtx()
    const dispose = await apply(ctx, {
      needleEnabled: true,
      needleUrl: 'http://127.0.0.1:8081',
      needleTranslateEnabled: false,
      needleTranslateProvider: 'local-llm',
      needleTimeoutMs: 1500,
      needleConfidenceThreshold: 0.7,
    } as never)
    await dispose()
    const boot = logs.find(l => l.includes('[needle-extractor] boot'))!
    assert.match(boot, /enabled=true/)
    assert.match(boot, /url=http:\/\/127\.0\.0\.1:8081/)
    assert.match(boot, /translate=false\/local-llm/)
    assert.match(boot, /timeoutMs=1500/)
    assert.match(boot, /threshold=0\.7/)
  })

  it('apply 默认 config:boot 行 enabled=false(默认关,运维第一眼可见)', async () => {
    const { ctx, logs } = makeCtx()
    const dispose = await apply(ctx, {} as never)
    await dispose()
    assert.match(logs.find(l => l.includes('[needle-extractor] boot'))!, /enabled=false/)
  })

  it('ctx.logger 缺席时 apply 不炸(boot log 是尽力而为)', async () => {
    const ctx = { reflect: { provide: () => {} } } as any
    const dispose = await apply(ctx, {} as never)
    await dispose()
  })
})

// ── 5. createToolRunner(Phase 3 边界装配)───────────────────────────────────

describe('needle-extractor:createToolRunner', () => {
  const makeTools = () => ({ execute: async () => ({ isError: false, content: [] }) })
  const makeBridge = () => ({ getAgentRealm: () => 'LOCAL', checkToolRealm: () => undefined })

  it('tools + realmSkillBridge 齐备 → ToolRunner 实例', () => {
    const { svc } = makeService({}, { tools: makeTools(), realmSkillBridge: makeBridge() })
    const runner = svc.createToolRunner()
    assert.ok(runner instanceof ToolRunner)
  })

  it('缺 tools / 缺 bridge / 二者全缺 → undefined(调用方 fall through 到 LLM 自提取)', () => {
    assert.equal(makeService({}, { realmSkillBridge: makeBridge() }).svc.createToolRunner(), undefined)
    assert.equal(makeService({}, { tools: makeTools() }).svc.createToolRunner(), undefined)
    assert.equal(makeService({}).svc.createToolRunner(), undefined)
  })

  it('tools.execute 非函数(形状不对)→ undefined', () => {
    const { svc } = makeService({}, { tools: {}, realmSkillBridge: makeBridge() })
    assert.equal(svc.createToolRunner(), undefined)
  })

  it('§7.92.2 proxy trap:ctx.tools getter throw → undefined 而非炸穿(惰性 loose-read 的意义)', () => {
    // getter 必须定义在构造好的 ctx 上(makeCtx 的 spread 会提前触发 getter)。
    const { ctx } = makeCtx()
    const svc = new NeedleExtractorServiceImpl(ctx, {} as never)
    Object.defineProperty(ctx, 'tools', {
      configurable: true,
      get() { throw new Error('cannot get property tools without inject') },
    })
    assert.equal(svc.createToolRunner(), undefined)
  })
})

// ── 6. audit helper ─────────────────────────────────────────────────────────

describe('needle-extractor:audit', () => {
  it('audit 条目 source=needle-extractor,level/kind/payload 原样透传', () => {
    const { svc, entries } = makeService()
    svc.audit('info', 'needle.extract', { durationMs: 412, functionCallCount: 1 })
    assert.equal(entries.length, 1)
    assert.deepEqual(entries[0], {
      level: 'info',
      kind: 'needle.extract',
      source: 'needle-extractor',
      payload: { durationMs: 412, functionCallCount: 1 },
    })
  })

  it('auditLog.log reject → audit 不炸不阻断(void + catch(() => {}) 契约)', () => {
    const { svc } = makeService({}, {}, 'reject')
    assert.doesNotThrow(() => svc.audit('warn', 'needle.timeout_skip', {}))
  })

  it('auditLog 缺席 → audit 静默 no-op', () => {
    const { ctx } = makeCtx()
    const svc = new NeedleExtractorServiceImpl(ctx, {} as never)
    assert.doesNotThrow(() => svc.audit('security', 'needle.realm_rejected', {}))
  })
})

// ── 7. Phase 5:agent/pre-step waterfall listener ─────────────────────────────

import { ToolRunner as ToolRunnerClass } from '../../src/dsh-adapter/tool-runner.js'

/**
 * 完整 bridge mock:同时满足 needle-extractor(handlePreStep 读
 * getSessionRealm + getToolSchemasForNeedle)+ ToolRunner(读
 * getAgentRealm + checkToolRealm)两套。
 */
function makeBridge(realm: 'LOCAL' | 'CLOUD' | 'SANITIZED' | undefined, schemas: ReadonlyArray<{ name: string; description: string; parameters: Record<string, unknown> }> = []) {
  return {
    getSessionRealm: () => realm,
    getToolSchemasForNeedle: () => schemas,
    getAgentRealm: () => realm,
    checkToolRealm: () => undefined, // fail-open allow
  }
}

/**
 * Phase 5 契约总览(每条对应下述测试):
 *  1. next() 永远先 await(链式包裹语义,无 next() = veto)
 *  2. decision.kind === 'reject' → 透传(上游已拒)
 *  3. !isAvailable() → 透传(总开关关)
 *  4. sessionId 缺失 → 透传
 *  5. realm 未注册 / 非 LOCAL|SANITIZED → needleRealmUnsetSkip++ / 透传
 *  6. 真用户最后一条文本为空 → 透传
 *  7. translate 失败(无 llm / disabled / timeout / error / empty) → 透传
 *  8. getToolSchemasForNeedle 空 → 透传
 *  9. extract HTTP 非 2xx / JSON 烂 / 超时 → 透传
 * 10. adopt gate 未过 → needleLowConfSkip++ / 透传
 * 11. createToolRunner undefined → 透传(无法执行)
 * 12. outcomes 全 denied/skipped/error → 透传(0 executed 不注入)
 * 13. outcomes ≥1 executed → 注入 user-role synthesis message
 * 14. await next() 抛 → 重抛(基础设施错误不静默吞)
 * 15. 处理阶段抛 → 透传原 decision(不污染 dispatch)
 */

function makeListenerCtx(
  cfg: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
  auditMode?: 'resolve' | 'reject',
) {
  const entries: AuditEntry[] = []
  const logs: string[] = []
  const onHandlers: Array<{ event: string; handler: any; opts: any }> = []
  const onCalls: Array<{ name: string; args: any[] }> = []
  const fetchCalls: Array<{ url: string; body: any }> = []
  // configurable fetch (tests inject via extra.fetch)
  let fetchImpl: ((url: string, init: any) => Promise<Response>) | undefined
  const baseCtx = {
    reflect: {
      provide: () => {},
      bind: (fn: any) => fn,
    },
    logger: {
      info: (m: string) => logs.push(m),
      warn: (m: string) => logs.push(m),
    },
    on: (event: string, handler: any, opts: any) => {
      onHandlers.push({ event, handler, opts })
      onCalls.push({ name: event, args: [handler, opts] })
      return () => { /* disposer */ }
    },
    ...extra,
  } as any
  // wire fetch through if provided
  fetchImpl = (baseCtx as any).fetch
  void fetchImpl // referenced
  void fetchCalls // referenced
  const svc = new NeedleExtractorServiceImpl(baseCtx, cfg as never, makeAuditLog(entries, auditMode))
  // 把 auditLog 也挂到 ctx 上:apply() 单独读 ctx.auditLog(不经 service)。
  baseCtx.auditLog = makeAuditLog(entries, auditMode)
  return { ctx: baseCtx, svc, entries, logs, onHandlers, fetchImpl }
}

function okJsonResponse(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Realistic needle /extract OK response for happy-path tests. */
const NEEDLE_OK_CALL = {
  type: 'call',
  function_calls: [{ name: 'bash', arguments: { command: 'ls /home/etsme/work' } }],
  confidence: 0.92,
  validation: { ungrounded: [] },
  reasoning: 'list markdown files in work dir',
  latency_ms: 412,
}

describe('needle-extractor:Phase 5 listener 透传语义', () => {
  it('总开关关 → listener 永不挂(apply 阶段 ctx.on 可选 + handlePreStep 第一道 gate)', async () => {
    // 默认 needleEnabled=false,apply 不挂 listener(显式策略:false 时不
    // 浪费一个全局 hook 槽)。测试 handlePreStep 第一道 gate:即便被调,
    // 也立刻 next() 透传。
    const { svc } = makeListenerCtx({})
    const payload = {
      agent: { session: { id: 'sess-001' } },
      messages: [{ role: 'user', content: '查一下文档' }],
      step: 1,
    }
    const next = async () => ({ kind: 'enter', messages: [{ role: 'user', content: '查一下文档' }] as any }) as any
    const out = await svc.handlePreStep(payload, next)
    assert.equal(out.kind, 'enter')
    assert.equal(out.messages?.length, 1)
    assert.equal(out.messages?.[0]?.content, '查一下文档')
  })

  it('await next() 永远先执行(链式语义;决策透传 = 原始决策不被改写)', async () => {
    // 配齐 enabled + bridge + tools + llm,但 make next 返回一个**标记
    // 对象**,断言 listener 拿到的是同一对象(= 没改写)。
    const { svc } = makeListenerCtx({ needleEnabled: true })
    const seed = { kind: 'enter' as const, messages: [{ role: 'user', content: 'A' }] as any }
    const next = async () => seed as any
    const out = await svc.handlePreStep({
      agent: { session: { id: 'sess-x' } },
      messages: [{ role: 'user', content: 'A' }],
      step: 1,
    }, next)
    // 因 realm 没注册(undefined)、bridge 无 getToolSchemasForNeedle → 透传
    assert.deepEqual(out, seed)
  })

  it('next() 返回 reject → listener 透传(不重写 `reject` 决策)', async () => {
    const { svc } = makeListenerCtx({ needleEnabled: true })
    const seed = { kind: 'reject' as const, reason: 'upstream-policy' }
    const next = async () => seed as any
    const out = await svc.handlePreStep({
      agent: { session: { id: 'sess-x' } },
      messages: [{ role: 'user', content: 'A' }],
      step: 1,
    }, next)
    assert.deepEqual(out, seed)
  })

  it('sessionId 缺失 → 透传(框架未就绪)', async () => {
    const { svc } = makeListenerCtx({ needleEnabled: true })
    const seed = { kind: 'enter' as const, messages: [{ role: 'user', content: 'A' }] as any }
    const out = await svc.handlePreStep({
      agent: { session: {} },
      messages: [{ role: 'user', content: 'A' }],
      step: 1,
    }, async () => seed as any)
    assert.deepEqual(out, seed)
  })

  it('realm = CLOUD → 透传 + needleRealmUnsetSkip++', async () => {
    const bridge = makeBridge('CLOUD')
    const { svc } = makeListenerCtx({ needleEnabled: true }, { realmSkillBridge: bridge })
    const seed = { kind: 'enter' as const, messages: [{ role: 'user', content: 'A' }] as any }
    const out = await svc.handlePreStep({
      agent: { session: { id: 'sess-x' } },
      messages: [{ role: 'user', content: 'A' }],
      step: 1,
    }, async () => seed as any)
    assert.deepEqual(out, seed)
    assert.equal(svc.getStats().needleRealmUnsetSkip, 1)
  })

  it('realm undefined → 透传 + needleRealmUnsetSkip++(稳健于 input-guard apply 顺序)', async () => {
    const bridge = makeBridge(undefined)
    const { svc } = makeListenerCtx({ needleEnabled: true }, { realmSkillBridge: bridge })
    const seed = { kind: 'enter' as const, messages: [{ role: 'user', content: 'A' }] as any }
    const out = await svc.handlePreStep({
      agent: { session: { id: 'sess-x' } },
      messages: [{ role: 'user', content: 'A' }],
      step: 1,
    }, async () => seed as any)
    assert.deepEqual(out, seed)
    assert.equal(svc.getStats().needleRealmUnsetSkip, 1)
  })

  it('最后一条用户文本为空 → 透传(无 query 不进 needle)', async () => {
    const bridge = makeBridge('LOCAL', [{ name: 'bash', description: '', parameters: {} }])
    const { svc } = makeListenerCtx({ needleEnabled: true }, { realmSkillBridge: bridge })
    const seed = { kind: 'enter' as const, messages: [{ role: 'assistant', content: 'hi' }] as any }
    const out = await svc.handlePreStep({
      agent: { session: { id: 'sess-x' } },
      messages: [{ role: 'assistant', content: 'hi' }],
      step: 1,
    }, async () => seed as any)
    assert.deepEqual(out, seed)
  })

  it('translate 关闭 + query 英文 → 直通 extract,无 llm 调用', async () => {
    // 验证 needleTranslateEnabled=false 时 query 不被翻译,直接进 extract
    const bridge = makeBridge('LOCAL')
    let llmStreamCalls = 0
    const llm = { stream: () => { llmStreamCalls++; throw new Error('llm should not be called when translate disabled') } }
    const fetchMock = (() => Promise.reject(new Error('extract should not be called when schemas empty'))) as any
    const { svc } = makeListenerCtx(
      { needleEnabled: true, needleTranslateEnabled: false },
      { realmSkillBridge: bridge, llm, fetch: fetchMock },
    )
    const seed = { kind: 'enter' as const, messages: [{ role: 'user', content: 'list files' }] as any }
    const out = await svc.handlePreStep({
      agent: { session: { id: 'sess-x' } },
      messages: [{ role: 'user', content: 'list files' }],
      step: 1,
    }, async () => seed as any)
    assert.deepEqual(out, seed)
    assert.equal(llmStreamCalls, 0) // translate 关,llm 不被调
  })

  it('translate 启用但 llm 缺席 → 透传(不炸穿 turn)', async () => {
    const bridge = makeBridge('LOCAL', [{ name: 'bash', description: '', parameters: {} }])
    const { svc } = makeListenerCtx(
      { needleEnabled: true, needleTranslateEnabled: true },
      { realmSkillBridge: bridge, llm: null }, // 故意无 llm
    )
    const seed = { kind: 'enter' as const, messages: [{ role: 'user', content: '查文档' }] as any }
    const out = await svc.handlePreStep({
      agent: { session: { id: 'sess-x' } },
      messages: [{ role: 'user', content: '查文档' }],
      step: 1,
    }, async () => seed as any)
    assert.deepEqual(out, seed)
  })

  it('extract HTTP 非 2xx → 透传(不注入)', async () => {
    const bridge = makeBridge('LOCAL', [{ name: 'bash', description: '', parameters: {} }])
    // 构造 minimal llm.stream 返回的 async iterable(英文直通,绕开 translate)
    async function* llmStream() { yield { type: 'text-delta', text: 'list files' } }
    const llm = { stream: () => llmStream() }
    const fetchMock = (() => Promise.resolve(new Response('upstream busy', { status: 503 }))) as any
    const { svc } = makeListenerCtx(
      { needleEnabled: true, needleTranslateEnabled: false }, // 关掉 translate 走最简路径
      { realmSkillBridge: bridge, llm, fetch: fetchMock },
    )
    const seed = { kind: 'enter' as const, messages: [{ role: 'user', content: 'list files' }] as any }
    const out = await svc.handlePreStep({
      agent: { session: { id: 'sess-x' } },
      messages: [{ role: 'user', content: 'list files' }],
      step: 1,
    }, async () => seed as any)
    assert.deepEqual(out, seed)
    assert.equal(svc.getStats().needleExtractCalls, 1)
    // 503 非 timeout → needleExtractFailed audit(不是 timeout_skip)
    assert.equal(svc.getStats().needleTimeoutSkip, 0)
  })

  it('extract 低置信 → needleLowConfSkip++ / 透传', async () => {
    const bridge = makeBridge('LOCAL', [{ name: 'bash', description: '', parameters: {} }])
    async function* llmStream() { yield { type: 'text-delta', text: 'list files' } }
    const llm = { stream: () => llmStream() }
    const fetchMock = (() => Promise.resolve(okJsonResponse({ ...NEEDLE_OK_CALL, confidence: 0.3 }))) as any
    const { svc } = makeListenerCtx(
      { needleEnabled: true, needleTranslateEnabled: false, needleConfidenceThreshold: 0.7 },
      { realmSkillBridge: bridge, llm, fetch: fetchMock },
    )
    const seed = { kind: 'enter' as const, messages: [{ role: 'user', content: 'list files' }] as any }
    const out = await svc.handlePreStep({
      agent: { session: { id: 'sess-x' } },
      messages: [{ role: 'user', content: 'list files' }],
      step: 1,
    }, async () => seed as any)
    assert.deepEqual(out, seed)
    assert.equal(svc.getStats().needleLowConfSkip, 1)
    assert.equal(svc.getStats().needleExtractOk, 0)
  })

  it('extract type=respond(needle 自答) → 透传(无 call 要执行)', async () => {
    const bridge = makeBridge('LOCAL', [{ name: 'bash', description: '', parameters: {} }])
    async function* llmStream() { yield { type: 'text-delta', text: 'list files' } }
    const llm = { stream: () => llmStream() }
    const fetchMock = (() => Promise.resolve(okJsonResponse({
      type: 'respond',
      function_calls: [],
      confidence: 0.95,
      validation: { ungrounded: [] },
      text: 'no tools needed',
    }))) as any
    const { svc } = makeListenerCtx(
      { needleEnabled: true, needleTranslateEnabled: false },
      { realmSkillBridge: bridge, llm, fetch: fetchMock },
    )
    const seed = { kind: 'enter' as const, messages: [{ role: 'user', content: 'list files' }] as any }
    const out = await svc.handlePreStep({
      agent: { session: { id: 'sess-x' } },
      messages: [{ role: 'user', content: 'list files' }],
      step: 1,
    }, async () => seed as any)
    assert.deepEqual(out, seed)
    assert.equal(svc.getStats().needleLowConfSkip, 1)
  })
})

describe('needle-extractor:Phase 5 happy path 注入', () => {
  it('≥1 executed → decision.messages 末尾追加 user-role 合成 message + 计数自增', async () => {
    const bridge = makeBridge('LOCAL', [{ name: 'bash', description: '', parameters: {} }])
    async function* llmStream() { yield { type: 'text-delta', text: 'list files' } }
    const llm = { stream: () => llmStream() }
    const fetchMock = (() => Promise.resolve(okJsonResponse(NEEDLE_OK_CALL))) as any
    const tools = {
      execute: async () => ({ isError: false, content: [{ type: 'text', text: 'file1.md\nfile2.md' }] }),
    }
    const { svc, entries } = makeListenerCtx(
      { needleEnabled: true, needleTranslateEnabled: false },
      { realmSkillBridge: bridge, llm, fetch: fetchMock, tools },
    )
    const seed = { kind: 'enter' as const, messages: [{ role: 'user', content: 'list files' }] as any }
    const out = await svc.handlePreStep({
      agent: { session: { id: 'sess-x' } },
      messages: [{ role: 'user', content: 'list files' }],
      step: 1,
    }, async () => seed as any)
    // 注入:原 1 条 + 合成 1 条 = 2 条
    assert.equal(out.kind, 'enter')
    assert.equal(out.messages?.length, 2)
    // 合成 message:role=user,content=[{type:text,text:'[System — needle pre-execution summary]...'}]
    const injected = out.messages![1] as any
    assert.equal(injected.role, 'user')
    assert.match(String(injected.content?.[0]?.text ?? ''), /needle pre-execution summary/)
    assert.match(String(injected.content?.[0]?.text ?? ''), /bash/)
    assert.match(String(injected.content?.[0]?.text ?? ''), /file1\.md/)
    // stats:计数对账
    const s = svc.getStats()
    assert.equal(s.needleExtractCalls, 1)
    assert.equal(s.needleExtractOk, 1)
    assert.equal(s.needleExecuted, 1)
    assert.equal(s.needleSynthesisInjected, 1)
    // audit:needle.synthesis_injected + needle.executed(tool-runner)
    assert.ok(entries.some(e => e.kind === 'needle.synthesis_injected'))
    assert.ok(entries.some(e => e.kind === 'needle.executed'))
    assert.ok(entries.some(e => e.kind === 'needle.extract'))
  })

  it('全 denied/skipped/error → 不注入(0 executed 即 fall through)', async () => {
    const bridge = makeBridge('LOCAL', [{ name: 'bash', description: '', parameters: {} }])
    async function* llmStream() { yield { type: 'text-delta', text: 'list files' } }
    const llm = { stream: () => llmStream() }
    const fetchMock = (() => Promise.resolve(okJsonResponse(NEEDLE_OK_CALL))) as any
    // tools.execute 抛错 → 全部 outcome=error(0 executed)
    const tools = { execute: async () => { throw new Error('tool down') } }
    const { svc } = makeListenerCtx(
      { needleEnabled: true, needleTranslateEnabled: false },
      { realmSkillBridge: bridge, llm, fetch: fetchMock, tools },
    )
    const seed = { kind: 'enter' as const, messages: [{ role: 'user', content: 'list files' }] as any }
    const out = await svc.handlePreStep({
      agent: { session: { id: 'sess-x' } },
      messages: [{ role: 'user', content: 'list files' }],
      step: 1,
    }, async () => seed as any)
    // 0 executed → 不注入,透传
    assert.deepEqual(out, seed)
    const s = svc.getStats()
    assert.equal(s.needleExecuted, 0)
    assert.equal(s.needleErrors, 1)
    assert.equal(s.needleSynthesisInjected, 0)
  })
})

describe('needle-extractor:Phase 5 异常/异常路径', () => {
  it('await next() 自身抛 → 重抛(基础设施错误不静默吞;audit needle.listener.error)', async () => {
    const { svc, entries } = makeListenerCtx({ needleEnabled: true })
    const next = async () => { throw new Error('upstream blew up') }
    let threw = false
    try {
      await svc.handlePreStep({
        agent: { session: { id: 'sess-x' } },
        messages: [{ role: 'user', content: 'A' }],
        step: 1,
      }, next)
    } catch (err) {
      threw = true
      assert.match((err as Error).message, /upstream blew up/)
    }
    assert.ok(threw, 'must re-throw when next() itself throws')
    // audit 落 needle.listener.error(hadDecision=false)
    assert.ok(entries.some(e => e.kind === 'needle.listener.error'))
    const errAudit = entries.find(e => e.kind === 'needle.listener.error')!
    assert.equal((errAudit.payload as any).hadDecision, false)
  })

  it('处理阶段抛(extract 抛同步) → 走 extract 内部 catch,不冒到 listener 级 catch(干净失败)', async () => {
    // 复现路径:translate 抛非 abort → translate 内部 catch 收 → tr.ok=false
    // → handlePreStep 透传(干净,不冒到 listener 级 catch,无 needle.listener.error)。
    // 这是 §7.93 设计的契约:translate/extract 自己错 → 自己的 audit kind;
    // listener-level 错 → needle.listener.error。两者清晰分层。
    const bridge = makeBridge('LOCAL', [{ name: 'bash', description: '', parameters: {} }])
    async function* llmStream() { yield { type: 'text-delta', text: 'list files' } }
    const llm = { stream: () => llmStream() }
    // fetch 抛非 AbortError → extract 内部 try/catch 收 → needle.extract_failed
    const fetchMock = (() => { throw new Error('fetch kaboom sync') }) as any
    const { svc, entries } = makeListenerCtx(
      { needleEnabled: true, needleTranslateEnabled: false },
      { realmSkillBridge: bridge, llm, fetch: fetchMock },
    )
    const seed = { kind: 'enter' as const, messages: [{ role: 'user', content: 'list files' }] as any }
    const out = await svc.handlePreStep({
      agent: { session: { id: 'sess-x' } },
      messages: [{ role: 'user', content: 'list files' }],
      step: 1,
    }, async () => seed as any)
    // 透传
    assert.deepEqual(out, seed)
    // 走 extract_failed audit(非 listener 级 error)
    assert.ok(entries.some(e => e.kind === 'needle.extract_failed'))
    assert.ok(!entries.some(e => e.kind === 'needle.listener.error'))
  })

  it('apply() 默认注册 listener(disposerReturned=true → audit needle.hook.registered)', async () => {
    // 测试 apply() 注册了 hook:ctx.on 收到 'agent/pre-step' + global:true
    const { ctx, entries } = makeListenerCtx({})
    const dispose = await (await import('../../src/dsh-adapter/needle-extractor.js')).apply(ctx, {} as never)
    assert.equal(typeof dispose, 'function')
    // audit needle.hook.registered
    assert.ok(entries.some(e => e.kind === 'needle.hook.registered'), 'needle.hook.registered audit must fire on apply()')
    const reg = entries.find(e => e.kind === 'needle.hook.registered')!
    assert.equal((reg.payload as any).event, 'agent/pre-step')
    assert.equal((reg.payload as any).global, true)
    await dispose()
  })
})

describe('needle-extractor:Phase 5 ToolRunner 装配/执行边界', () => {
  it('getToolSchemasForNeedle 返回 [] → 透传(无 tool 给 needle = 0 调用风险)', async () => {
    const bridge = makeBridge('LOCAL')
    async function* llmStream() { yield { type: 'text-delta', text: 'list files' } }
    const llm = { stream: () => llmStream() }
    let fetchCalled = false
    const fetchMock = (() => { fetchCalled = true; return Promise.resolve(okJsonResponse(NEEDLE_OK_CALL)) }) as any
    const { svc } = makeListenerCtx(
      { needleEnabled: true, needleTranslateEnabled: false },
      { realmSkillBridge: bridge, llm, fetch: fetchMock },
    )
    const seed = { kind: 'enter' as const, messages: [{ role: 'user', content: 'list files' }] as any }
    const out = await svc.handlePreStep({
      agent: { session: { id: 'sess-x' } },
      messages: [{ role: 'user', content: 'list files' }],
      step: 1,
    }, async () => seed as any)
    assert.deepEqual(out, seed)
    assert.equal(fetchCalled, false, 'no /extract POST when schemas empty')
  })

  it('createToolRunner 返回 undefined(tools.execute 非函数)→ 透传', async () => {
    const bridge = makeBridge('LOCAL', [{ name: 'bash', description: '', parameters: {} }])
    async function* llmStream() { yield { type: 'text-delta', text: 'list files' } }
    const llm = { stream: () => llmStream() }
    const fetchMock = (() => Promise.resolve(okJsonResponse(NEEDLE_OK_CALL))) as any
    // 故意 tools 形状不对(无 execute)
    const { svc } = makeListenerCtx(
      { needleEnabled: true, needleTranslateEnabled: false },
      { realmSkillBridge: bridge, llm, fetch: fetchMock, tools: { schemas: () => [] } },
    )
    const seed = { kind: 'enter' as const, messages: [{ role: 'user', content: 'list files' }] as any }
    const out = await svc.handlePreStep({
      agent: { session: { id: 'sess-x' } },
      messages: [{ role: 'user', content: 'list files' }],
      step: 1,
    }, async () => seed as any)
    assert.deepEqual(out, seed)
    assert.equal(svc.getStats().needleExecuted, 0)
    assert.equal(svc.getStats().needleSynthesisInjected, 0)
  })
})

describe('needle-extractor:Phase 5 repairEntities 兜底(dry-run 经验)', () => {
  // 通过 translate 走真路径难以在单测里观察 repairEntities(私有),
  // 这里走 sibling 间接路径:让 translate OK 但 extract 5xx → 走
  // audit 链,验证 translate.ok(query) 的 query 已 repair。
  // 因为 repairEntities 是文件内私有函数且未导出,本组测试聚焦
  // translate 的端到端可观测性:audit needle.translate 的
  // repaired=true / outputLen 等 metadata 字段。
  it('translate 输出含原文路径 → audit needle.translate.repaired=false', async () => {
    const bridge = makeBridge('LOCAL') // 让 extract 不进,审计更容易抓
    async function* llmStream() {
      yield { type: 'text-delta', text: 'List files in 【/home/etsme/work】' }
    }
    const llm = { stream: () => llmStream() }
    const { svc, entries } = makeListenerCtx(
      { needleEnabled: true, needleTranslateEnabled: true },
      { realmSkillBridge: bridge, llm },
    )
    const seed = { kind: 'enter' as const, messages: [{ role: 'user', content: '查 /home/etsme/work 下的文件' }] as any }
    await svc.handlePreStep({
      agent: { session: { id: 'sess-x' } },
      messages: [{ role: 'user', content: '查 /home/etsme/work 下的文件' }],
      step: 1,
    }, async () => seed as any)
    const tr = entries.find(e => e.kind === 'needle.translate')!
    assert.equal((tr.payload as any).repaired, false) // 【/home/etsme/work】 已含原文
    assert.ok((tr.payload as any).outputLen > 0)
  })

  it('translate 丢路径(写出 /home/etsween) → repairEntities 替换 【..】 段 → audit repaired=true', async () => {
    const bridge = makeBridge('LOCAL')
    async function* llmStream() {
      // 模拟 dry-run 复现的 entity corruption
      yield { type: 'text-delta', text: 'List files in 【/home/etsween/work】' }
    }
    const llm = { stream: () => llmStream() }
    const { svc, entries } = makeListenerCtx(
      { needleEnabled: true, needleTranslateEnabled: true },
      { realmSkillBridge: bridge, llm },
    )
    const seed = { kind: 'enter' as const, messages: [{ role: 'user', content: '查 /home/etsme/work 下的文件' }] as any }
    await svc.handlePreStep({
      agent: { session: { id: 'sess-x' } },
      messages: [{ role: 'user', content: '查 /home/etsme/work 下的文件' }],
      step: 1,
    }, async () => seed as any)
    const tr = entries.find(e => e.kind === 'needle.translate')!
    assert.equal((tr.payload as any).repaired, true)
  })
})
