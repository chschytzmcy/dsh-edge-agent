/**
 * §7.93 Phase 4 — needle-extractor 骨架单测。
 *
 * 骨架期契约(全部在此锁死):
 *  1. inject 列表 = §7.92.2 proxy trap 防线:读 ctx.X 前必先列 inject;
 *     privacyPolicy 刻意不在列表(插件不读 categories,intent 判定归 intent-router)。
 *     Phase 5 末 llm 也裁掉:不再 client 翻译,直接 needle(自带 cn_grounding)。
 *  2. Config schema 默认值 = .env / memory 契约逐字段一致(needleEnabled=false、
 *     url=:8081、timeout=1500、threshold=0.7、
 *     breaker/probe 四件套 = §7.92.6/§7.92.7 jev 同款默认)。
 *  3. service 构造期 `??` 回退与 schema 默认镜像一致(cordis 走 schema,
 *     测试/手工构造走 ??,两条路必须给同一个值)。
 *  4. isAvailable() = 总开关(Phase 6 才叠加 breaker;Phase 5 listener 的第一道 gate)。
 *  5. getStats() 返回副本 —— 调用方改不坏内部计数。
 *  6. apply() 零 waterfall 副作用:tools/realmSkillBridge 全缺席也能
 *     boot/dispose(骨架期一次 HTTP 都不发,listener 一个都不挂)。
 *  7. boot ops-log 一行(§7.46 纪律):enabled/url/timeout/threshold
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

/** §7.93 memory 契约:9 个字段的权威默认值(.env 翻译层未生效时的兜底)。
 *  (Phase 5 末 user 终裁:不管什么语种 needle 自带 cn_grounding,直接用,
 *  不再过 client 翻译;原 12 字段裁掉 needleTranslateTimeoutMs /
 *  needleTranslateEnabled / needleTranslateProvider。) */
const EXPECTED_DEFAULTS = {
  needleEnabled: false,
  needleUrl: 'http://127.0.0.1:8081',
  needleTimeoutMs: 1500,
  needleConfidenceThreshold: 0.7,
  needleBreakerTtlMs: 30000,
  needleBootProbeEnabled: true,
  needleBootProbeTimeoutMs: 2000,
  needleBreakerProbeMs: 5000,
  needleProbeTimeoutMs: 2000,
} as const

// ── 1. plugin 面 ────────────────────────────────────────────────────────────

describe('needle-extractor:plugin 面', () => {
  it('name = needle-extractor(派工单 id 契约)', () => {
    assert.equal(pluginName, 'needle-extractor')
  })

  it('§7.92.2 inject 锁:auditLog/realmSkillBridge/tools 三项,llm+privacyPolicy 刻意缺席', () => {
    // 读 ctx.X 前必须先列 inject(cordis proxy 静默 throw "cannot get
    // property X without inject")。少列 = Phase 5/6 接线时静默失败;
    // 多列 llm = 翻译已裁掉,本插件不调 LLM;多列 privacyPolicy =
    // 声明了不消费的依赖(intent 判定归 intent-router)。
    assert.deepEqual([...inject], ['auditLog', 'realmSkillBridge', 'tools'])
    assert.ok(!(inject as readonly string[]).includes('llm'))
    assert.ok(!(inject as readonly string[]).includes('privacyPolicy'))
  })
})

// ── 2. config schema 默认值 ─────────────────────────────────────────────────

describe('needle-extractor:config 默认值', () => {
  it('schema resolve 空 config → 9 字段与 .env/memory 契约逐字一致', () => {
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
  it('tools/realmSkillBridge 全缺席也能 boot + dispose(骨架期零 HTTP 零 listener)', () => {
    // ctx 上没有 on/registry/waterfall 任何东西:apply 若偷偷挂 listener
    // 或发 probe,这里会直接 TypeError —— "零副作用"由 fake ctx 的贫瘠证明。
    const { ctx, logs } = makeCtx()
    return apply(ctx, {}).then(async dispose => {
      assert.equal(typeof dispose, 'function')
      await dispose()
      assert.equal(logs.filter(l => l.includes('[needle-extractor] boot')).length, 1)
    })
  })

  it('boot ops-log 一行含 enabled/url/timeout/threshold(§7.46 纪律,metadata only)', async () => {
    const { ctx, logs } = makeCtx()
    const dispose = await apply(ctx, {
      needleEnabled: true,
      needleUrl: 'http://127.0.0.1:8081',
      needleTimeoutMs: 1500,
      needleConfidenceThreshold: 0.7,
    } as never)
    await dispose()
    const boot = logs.find(l => l.includes('[needle-extractor] boot'))!
    assert.match(boot, /enabled=true/)
    assert.match(boot, /url=http:\/\/127\.0\.0\.1:8081/)
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
 *  7. extract 失败(无 fetcher / HTTP 非 2xx / 超时 / JSON 烂) → 透传
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

  it('extract HTTP 非 2xx → 透传(不注入)', async () => {
    const bridge = makeBridge('LOCAL', [{ name: 'bash', description: '', parameters: {} }])
    const fetchMock = (() => Promise.resolve(new Response('upstream busy', { status: 503 }))) as any
    const { svc } = makeListenerCtx(
      { needleEnabled: true },
      { realmSkillBridge: bridge, fetch: fetchMock },
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
      { needleEnabled: true, needleConfidenceThreshold: 0.7 },
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
      { needleEnabled: true },
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
      { needleEnabled: true },
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
      { needleEnabled: true },
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
      { needleEnabled: true },
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
      { needleEnabled: true },
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
      { needleEnabled: true },
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

// ── 8. Phase 6:isAvailable breaker-aware ───────────────────────────────────

describe('needle-extractor:Phase 6 isAvailable 与 breaker', () => {
  it('isAvailable() 反映 needleEnabled + breaker 双重状态', () => {
    const off = makeService({ needleEnabled: false }).svc
    assert.equal(off.isAvailable(), false)
    const on = makeService({ needleEnabled: true }).svc
    assert.equal(on.isAvailable(), true)
  })

  it('getStats().needleCircuitOpen 初始 false(breaker 默认关闭)', () => {
    const { svc } = makeService({ needleEnabled: true })
    assert.equal(svc.getStats().needleCircuitOpen, false)
  })
})

// ── 9. Phase 6:boot probe + breaker 预开 ──────────────────────────────────

describe('needle-extractor:Phase 6 boot probe', () => {
  it('boot probe 200 → breaker 不预开,needleBootProbeOk++', async () => {
    const auditEntries: AuditEntry[] = []
    const { ctx, logs } = makeCtx()
    const baseCtx = ctx as any
    baseCtx.auditLog = makeAuditLog(auditEntries)
    baseCtx.fetch = (() => Promise.resolve(new Response('ok', { status: 200 }))) as any
    const svc = new NeedleExtractorServiceImpl(baseCtx, { needleEnabled: true }, makeAuditLog(auditEntries))
    svc.start()
    // boot probe 是 fire-and-forget;给 microtask 时间 settle
    await new Promise(r => setTimeout(r, 5))
    const s = svc.getStats()
    assert.equal(s.needleBootProbeOk, 1)
    assert.equal(s.needleBootProbeFail, 0)
    assert.equal(s.needleCircuitOpen, false, 'breaker 必须保持关闭')
    // audit:needle.boot_probe ok=true
    assert.ok(auditEntries.some(e => e.kind === 'needle.boot_probe'))
    await svc.stop()
  })

  it('boot probe 非 2xx → breaker 预开 + 周期 probe 启动,needleBootProbeFail++', async () => {
    const auditEntries: AuditEntry[] = []
    const { ctx } = makeCtx()
    const baseCtx = ctx as any
    baseCtx.auditLog = makeAuditLog(auditEntries)
    // 模拟 needle 还在暖机:503 + body
    baseCtx.fetch = (() => Promise.resolve(new Response('loading', { status: 503 }))) as any
    const svc = new NeedleExtractorServiceImpl(baseCtx, {
      needleEnabled: true,
      needleBootProbeTimeoutMs: 100,
      needleBreakerProbeMs: 60_000, // 周期 probe 设很大,避免测试退出前反复触发
      needleBreakerTtlMs: 5000,
    }, makeAuditLog(auditEntries))
    svc.start()
    await new Promise(r => setTimeout(r, 10))
    const s = svc.getStats()
    assert.equal(s.needleBootProbeOk, 0)
    assert.equal(s.needleBootProbeFail, 1)
    assert.equal(s.needleCircuitOpen, true, 'breaker 必须预开')
    // 周期 probe 已启动(timer 不为 null 通过 stats 间接验证 — 周期 probe
    // 间隔很大所以本测试不会触发;但 openBreaker 路径一定走了 startBreakerProbe)
    assert.ok(auditEntries.some(e => e.kind === 'needle.circuit_open'))
    await svc.stop()
    // stop() 必须清掉 timer(否则测试退出 hung)
  })

  it('boot probe network error → 同上:breaker 预开 + needleBootProbeFail++', async () => {
    const auditEntries: AuditEntry[] = []
    const { ctx } = makeCtx()
    const baseCtx = ctx as any
    baseCtx.auditLog = makeAuditLog(auditEntries)
    baseCtx.fetch = (() => Promise.reject(new Error('ECONNREFUSED'))) as any
    const svc = new NeedleExtractorServiceImpl(baseCtx, {
      needleEnabled: true,
      needleBootProbeTimeoutMs: 100,
      needleBreakerProbeMs: 60_000,
      needleBreakerTtlMs: 5000,
    }, makeAuditLog(auditEntries))
    svc.start()
    await new Promise(r => setTimeout(r, 10))
    const s = svc.getStats()
    assert.equal(s.needleBootProbeFail, 1)
    assert.equal(s.needleCircuitOpen, true)
    await svc.stop()
  })

  it('needleBootProbeEnabled=false → 不发 probe + audit skipped', async () => {
    const auditEntries: AuditEntry[] = []
    const { ctx } = makeCtx()
    const baseCtx = ctx as any
    baseCtx.auditLog = makeAuditLog(auditEntries)
    let fetchCalls = 0
    baseCtx.fetch = (() => { fetchCalls++; return Promise.resolve(new Response('ok', { status: 200 })) }) as any
    const svc = new NeedleExtractorServiceImpl(baseCtx, {
      needleEnabled: true,
      needleBootProbeEnabled: false,
    }, makeAuditLog(auditEntries))
    svc.start()
    await new Promise(r => setTimeout(r, 5))
    assert.equal(fetchCalls, 0, 'boot probe 关闭 → fetch 不被调用')
    assert.ok(auditEntries.some(e => e.kind === 'needle.boot_probe.skipped'))
    await svc.stop()
  })

  it('needleEnabled=false → start() no-op,不挂 probe 不挂 timer', async () => {
    const { svc, entries } = makeListenerCtx({}) // needleEnabled=false(默认)
    svc.start()
    await new Promise(r => setTimeout(r, 5))
    assert.equal(svc.getStats().needleBootProbeOk, 0)
    assert.equal(svc.getStats().needleBootProbeFail, 0)
    // 不应该有 needle.boot_probe.* audit(总开关没开)
    assert.ok(!entries.some(e => e.kind === 'needle.boot_probe'))
    await svc.stop()
  })
})

// ── 10. Phase 6:open-on-first-failure 行为 ─────────────────────────────────

describe('needle-extractor:Phase 6 extract 失败 → breaker 开', () => {
  it('extract 1.5s 超时(AbortError)→ openBreaker(timeout)+ needleCircuitOpen=true', async () => {
    const auditEntries: AuditEntry[] = []
    const { ctx } = makeCtx()
    const baseCtx = ctx as any
    baseCtx.auditLog = makeAuditLog(auditEntries)
    baseCtx.fetch = (() => new Promise((_resolve, reject) => {
      // 模拟 1.5s 超时但永远不 resolve → AbortSignal 触发
      setTimeout(() => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), 50)
    })) as any
    const svc = new NeedleExtractorServiceImpl(baseCtx, {
      needleEnabled: true,
      needleTimeoutMs: 20,
      needleBreakerProbeMs: 60_000,
      needleBreakerTtlMs: 5000,
    }, makeAuditLog(auditEntries))
    const bridge = makeBridge('LOCAL', [{ name: 'bash', description: '', parameters: {} }])
    ;(baseCtx as any).realmSkillBridge = bridge
    const out = await svc.handlePreStep({
      agent: { session: { id: 'sess-x' } },
      messages: [{ role: 'user', content: 'ls' }],
      step: 1,
    }, async () => ({ kind: 'enter' as const, messages: [] }))
    // 第一次请求 timeout → fall through + breaker 打开
    assert.equal(out.kind, 'enter')
    const s = svc.getStats()
    assert.equal(s.needleTimeoutSkip, 1)
    assert.equal(s.needleCircuitOpen, true, 'timeout 必须开 breaker(dry-run #1 强制要求)')
    assert.ok(auditEntries.some(e => e.kind === 'needle.circuit_open' && (e.payload as any).reason === 'timeout'))
    await svc.stop()
  })

  it('extract HTTP 503 → openBreaker(http_5xx)+ needleCircuitOpen=true', async () => {
    const auditEntries: AuditEntry[] = []
    const { ctx } = makeCtx()
    const baseCtx = ctx as any
    baseCtx.auditLog = makeAuditLog(auditEntries)
    baseCtx.fetch = (() => Promise.resolve(new Response('busy', { status: 503 }))) as any
    const svc = new NeedleExtractorServiceImpl(baseCtx, {
      needleEnabled: true,
      needleBreakerProbeMs: 60_000,
      needleBreakerTtlMs: 5000,
    }, makeAuditLog(auditEntries))
    const bridge = makeBridge('LOCAL', [{ name: 'bash', description: '', parameters: {} }])
    ;(baseCtx as any).realmSkillBridge = bridge
    await svc.handlePreStep({
      agent: { session: { id: 'sess-x' } },
      messages: [{ role: 'user', content: 'ls' }],
      step: 1,
    }, async () => ({ kind: 'enter' as const, messages: [] }))
    const s = svc.getStats()
    assert.equal(s.needleCircuitOpen, true, '5xx 必须开 breaker')
    assert.ok(auditEntries.some(e => e.kind === 'needle.circuit_open' && (e.payload as any).reason === 'http_5xx'))
    await svc.stop()
  })

  it('extract HTTP 422 → 不开 breaker(client error 不是 engine down)', async () => {
    const auditEntries: AuditEntry[] = []
    const { ctx } = makeCtx()
    const baseCtx = ctx as any
    baseCtx.auditLog = makeAuditLog(auditEntries)
    baseCtx.fetch = (() => Promise.resolve(new Response('bad request', { status: 422 }))) as any
    const svc = new NeedleExtractorServiceImpl(baseCtx, {
      needleEnabled: true,
      needleBreakerProbeMs: 60_000,
      needleBreakerTtlMs: 5000,
    }, makeAuditLog(auditEntries))
    const bridge = makeBridge('LOCAL', [{ name: 'bash', description: '', parameters: {} }])
    ;(baseCtx as any).realmSkillBridge = bridge
    await svc.handlePreStep({
      agent: { session: { id: 'sess-x' } },
      messages: [{ role: 'user', content: 'ls' }],
      step: 1,
    }, async () => ({ kind: 'enter' as const, messages: [] }))
    assert.equal(svc.getStats().needleCircuitOpen, false, '4xx ≠ engine down → 不开')
    // 无 needle.circuit_open audit
    assert.ok(!auditEntries.some(e => e.kind === 'needle.circuit_open'))
    await svc.stop()
  })

  it('extract 成功 → closeBreaker(若已开则关;未开则 no-op)', async () => {
    const auditEntries: AuditEntry[] = []
    const { ctx } = makeCtx()
    const baseCtx = ctx as any
    baseCtx.auditLog = makeAuditLog(auditEntries)
    baseCtx.fetch = (() => Promise.resolve(new Response(JSON.stringify(NEEDLE_OK_CALL), { status: 200 }))) as any
    const svc = new NeedleExtractorServiceImpl(baseCtx, {
      needleEnabled: true,
      needleBreakerProbeMs: 60_000,
      needleBreakerTtlMs: 5000,
    }, makeAuditLog(auditEntries))
    const bridge = makeBridge('LOCAL', [{ name: 'bash', description: '', parameters: {} }])
    ;(baseCtx as any).realmSkillBridge = bridge
    // 第一次成功 — breaker 本来就是关的,closeBreaker no-op
    await svc.handlePreStep({
      agent: { session: { id: 'sess-x' } },
      messages: [{ role: 'user', content: 'ls' }],
      step: 1,
    }, async () => ({ kind: 'enter' as const, messages: [] }))
    assert.equal(svc.getStats().needleCircuitOpen, false)
    await svc.stop()
  })
})

// ── 11. Phase 6:handlePreStep Gate 2 circuit_open_skip ────────────────────

describe('needle-extractor:Phase 6 Gate 2 短路', () => {
  it('breaker 开着 + needle 启用 → handlePreStep 透传 + audit needle.circuit_open_skip + needleCircuitSkip++', async () => {
    const auditEntries: AuditEntry[] = []
    const { ctx } = makeCtx()
    const baseCtx = ctx as any
    baseCtx.auditLog = makeAuditLog(auditEntries)
    // fetch 第一次 5xx,迫使 breaker 打开
    let fetchCalls = 0
    baseCtx.fetch = (() => {
      fetchCalls++
      return Promise.resolve(new Response('busy', { status: 503 }))
    }) as any
    const svc = new NeedleExtractorServiceImpl(baseCtx, {
      needleEnabled: true,
      needleBreakerProbeMs: 60_000,
      needleBreakerTtlMs: 5000,
    }, makeAuditLog(auditEntries))
    const bridge = makeBridge('LOCAL', [{ name: 'bash', description: '', parameters: {} }])
    ;(baseCtx as any).realmSkillBridge = bridge
    const seed = { kind: 'enter' as const, messages: [{ role: 'user', content: 'ls' }] as any }
    // 第一次请求:触发 5xx → breaker 打开
    await svc.handlePreStep({ agent: { session: { id: 'sess-x' } }, messages: [{ role: 'user', content: 'ls' }], step: 1 }, async () => seed)
    const fetchesAfterFirst = fetchCalls
    // 第二次请求:breaker 已开 → Gate 2 短路 → fetch 不会被调用
    const out = await svc.handlePreStep({ agent: { session: { id: 'sess-x' } }, messages: [{ role: 'user', content: 'ls' }], step: 1 }, async () => seed)
    assert.deepEqual(out, seed)
    assert.equal(fetchCalls, fetchesAfterFirst, 'breaker 开 → 不再发 fetch(节省 worst-case wall-clock)')
    // 第二次应落 needle.circuit_open_skip audit
    assert.ok(auditEntries.filter(e => e.kind === 'needle.circuit_open_skip').length >= 1)
    assert.equal(svc.getStats().needleCircuitSkip, 1)
    await svc.stop()
  })

  it('needleEnabled=false → handlePreStep Gate 2 透传 + 不 audit circuit_open_skip(总开关没开,不该有 audit 噪声)', async () => {
    const auditEntries: AuditEntry[] = []
    const { ctx } = makeCtx()
    const baseCtx = ctx as any
    baseCtx.auditLog = makeAuditLog(auditEntries)
    const svc = new NeedleExtractorServiceImpl(baseCtx, { needleEnabled: false }, makeAuditLog(auditEntries))
    const out = await svc.handlePreStep({
      agent: { session: { id: 'sess-x' } },
      messages: [{ role: 'user', content: 'ls' }],
      step: 1,
    }, async () => ({ kind: 'enter' as const, messages: [{ role: 'user', content: 'ls' }] as any }))
    assert.equal(out.kind, 'enter')
    assert.ok(!auditEntries.some(e => e.kind === 'needle.circuit_open_skip'))
    await svc.stop()
  })
})

// ── 12. Phase 6:周期 recovery probe ───────────────────────────────────────

describe('needle-extractor:Phase 6 周期 recovery probe', () => {
  it('周期 probe 命中 2xx → 关 breaker + 停 timer + needleRecoveredProbe++', async () => {
    const auditEntries: AuditEntry[] = []
    const { ctx } = makeCtx()
    const baseCtx = ctx as any
    baseCtx.auditLog = makeAuditLog(auditEntries)
    // 周期 probe 设 30ms(快速触发),boot probe timeout 50ms
    let probeCount = 0
    baseCtx.fetch = (url: string) => {
      probeCount++
      // /health 命中 200 → recovery
      if (url.endsWith('/health')) {
        return Promise.resolve(new Response('ok', { status: 200 }))
      }
      return Promise.resolve(new Response('busy', { status: 503 }))
    }
    const svc = new NeedleExtractorServiceImpl(baseCtx, {
      needleEnabled: true,
      needleBootProbeTimeoutMs: 50,
      needleBootProbeEnabled: true,
      needleBreakerProbeMs: 30,
      needleProbeTimeoutMs: 50,
      needleBreakerTtlMs: 5000,
    }, makeAuditLog(auditEntries))
    const bridge = makeBridge('LOCAL', [{ name: 'bash', description: '', parameters: {} }])
    ;(baseCtx as any).realmSkillBridge = bridge
    // boot probe 会失败(/extract 路由失败;但 boot probe 走 /health)
    // 等等:boot probe 也走 /health,而 fetch mock 给 /health → 200。
    // 那 boot probe 会成功,breaker 不开。
    // 改:让 boot probe 走 /health,但 seed breaker 打开通过先发一个 5xx
    // 然后 periodic probe 命中 /health 200 → 关。
    svc.start()
    await new Promise(r => setTimeout(r, 20))
    // boot probe 成功 → breaker 没开
    assert.equal(svc.getStats().needleBootProbeOk, 1)
    // 强制开 breaker:发一个 5xx extract
    await svc.handlePreStep({ agent: { session: { id: 'sess-x' } }, messages: [{ role: 'user', content: 'ls' }], step: 1 }, async () => ({ kind: 'enter' as const, messages: [] }))
    assert.equal(svc.getStats().needleCircuitOpen, true, '5xx → breaker 开')
    // 周期 probe 30ms 后命中 /health 200 → 关
    await new Promise(r => setTimeout(r, 100))
    assert.equal(svc.getStats().needleRecoveredProbe, 1, '周期 probe 命中 2xx → recovered')
    assert.equal(svc.getStats().needleCircuitOpen, false, 'breaker 已关')
    // audit:needle.recovered
    assert.ok(auditEntries.some(e => e.kind === 'needle.recovered'))
    await svc.stop()
  })

  it('周期 probe 仍 5xx → breaker 保持开 + needleProbeAttempts++(继续探)', async () => {
    const auditEntries: AuditEntry[] = []
    const { ctx } = makeCtx()
    const baseCtx = ctx as any
    baseCtx.auditLog = makeAuditLog(auditEntries)
    // 全 fail:boot probe /health 也 5xx
    baseCtx.fetch = (() => Promise.resolve(new Response('still down', { status: 503 }))) as any
    const svc = new NeedleExtractorServiceImpl(baseCtx, {
      needleEnabled: true,
      needleBootProbeTimeoutMs: 50,
      needleBreakerProbeMs: 30,
      needleProbeTimeoutMs: 50,
      needleBreakerTtlMs: 5000,
    }, makeAuditLog(auditEntries))
    svc.start()
    await new Promise(r => setTimeout(r, 20))
    assert.equal(svc.getStats().needleBootProbeFail, 1)
    assert.equal(svc.getStats().needleCircuitOpen, true)
    // 等 100ms,周期 probe 应该抢一次
    await new Promise(r => setTimeout(r, 80))
    assert.ok(svc.getStats().needleProbeAttempts >= 1, '周期 probe 持续尝试')
    assert.equal(svc.getStats().needleCircuitOpen, true, 'breaker 仍开')
    assert.equal(svc.getStats().needleRecoveredProbe, 0)
    await svc.stop()
  })
})

// ── 13. Phase 6:stop() lifecycle ───────────────────────────────────────────

describe('needle-extractor:Phase 6 stop()', () => {
  it('stop() 清 timer(不挂 setInterval 阻进程退出)', async () => {
    const { ctx } = makeCtx()
    const baseCtx = ctx as any
    baseCtx.fetch = (() => Promise.resolve(new Response('down', { status: 503 }))) as any
    const svc = new NeedleExtractorServiceImpl(baseCtx, {
      needleEnabled: true,
      needleBootProbeTimeoutMs: 30,
      needleBreakerProbeMs: 30,
      needleBreakerTtlMs: 5000,
    })
    svc.start()
    await new Promise(r => setTimeout(r, 50))
    // 此时周期 probe timer 应在跑
    await svc.stop()
    // stop 之后:再 sleep 100ms,不应再有新 probe 计数
    const attemptsBefore = svc.getStats().needleProbeAttempts
    await new Promise(r => setTimeout(r, 80))
    const attemptsAfter = svc.getStats().needleProbeAttempts
    // 允许 ≤1 误差(已经 schedule 的 timer 在 stop 之前抢了一次)
    assert.ok(attemptsAfter - attemptsBefore <= 1, 'stop 后 timer 必须清掉,probe 不再尝试')
  })

  it('stop() await in-flight boot probe(不让 dangling fetch 留下)', async () => {
    const { ctx } = makeCtx()
    const baseCtx = ctx as any
    let bootProbeResolved = false
    baseCtx.fetch = (() => new Promise<Response>(r => setTimeout(() => {
      bootProbeResolved = true
      r(new Response('ok', { status: 200 }))
    }, 30))) as any
    const svc = new NeedleExtractorServiceImpl(baseCtx, {
      needleEnabled: true,
      needleBootProbeTimeoutMs: 100,
      needleBootProbeEnabled: true,
      needleBreakerProbeMs: 60_000,
      needleBreakerTtlMs: 5000,
    })
    svc.start()
    // 立刻 stop,boot probe 还没 resolve
    await svc.stop()
    assert.ok(bootProbeResolved, 'stop() 必须 await boot probe settle')
    assert.equal(svc.getStats().needleBootProbeOk, 1, 'boot probe 完成后 needleBootProbeOk++')
  })
})

// ── 14. Phase 7:失败路径细分(422/503/502/timeout 区分)─────────────────

describe('needle-extractor:Phase 7 失败路径细分', () => {
  it('422 invalid body → 不重试 + 不开 breaker + audit reason=invalid_body_422', async () => {
    const auditEntries: AuditEntry[] = []
    const { ctx } = makeCtx()
    const baseCtx = ctx as any
    baseCtx.auditLog = makeAuditLog(auditEntries)
    let fetchCalls = 0
    baseCtx.fetch = (() => {
      fetchCalls++
      return Promise.resolve(new Response('{"detail":"invalid query"}', { status: 422 }))
    }) as any
    const svc = new NeedleExtractorServiceImpl(baseCtx, {
      needleEnabled: true,
      needleBreakerProbeMs: 60_000,
      needleBreakerTtlMs: 5000,
    }, makeAuditLog(auditEntries))
    const bridge = makeBridge('LOCAL', [{ name: 'bash', description: '', parameters: {} }])
    ;(baseCtx as any).realmSkillBridge = bridge
    const out = await svc.handlePreStep({
      agent: { session: { id: 'sess-x' } },
      messages: [{ role: 'user', content: 'ls' }],
      step: 1,
    }, async () => ({ kind: 'enter' as const, messages: [] }))
    assert.equal(out.kind, 'enter') // 透传
    assert.equal(fetchCalls, 1, '422 → 只发一次 fetch(不重试)')
    assert.equal(svc.getStats().needleCircuitOpen, false, '422 → 不开 breaker(client error)')
    assert.equal(svc.getStats().needleRetryAttempts, 0)
    const audit = auditEntries.find(e => e.kind === 'needle.extract_failed')!
    assert.equal((audit.payload as any).reason, 'invalid_body_422')
    await svc.stop()
  })

  it('503 with "loading" body → 不重试 + 开 breaker + audit reason=503_loading', async () => {
    const auditEntries: AuditEntry[] = []
    const { ctx } = makeCtx()
    const baseCtx = ctx as any
    baseCtx.auditLog = makeAuditLog(auditEntries)
    let fetchCalls = 0
    baseCtx.fetch = (() => {
      fetchCalls++
      // needle 服务端 503 loading 一般 JSON 响应 body 含 "loading"
      return Promise.resolve(new Response(JSON.stringify({ detail: 'engine loading, please retry later' }), { status: 503 }))
    }) as any
    const svc = new NeedleExtractorServiceImpl(baseCtx, {
      needleEnabled: true,
      needleBreakerProbeMs: 60_000,
      needleBreakerTtlMs: 5000,
    }, makeAuditLog(auditEntries))
    const bridge = makeBridge('LOCAL', [{ name: 'bash', description: '', parameters: {} }])
    ;(baseCtx as any).realmSkillBridge = bridge
    await svc.handlePreStep({
      agent: { session: { id: 'sess-x' } },
      messages: [{ role: 'user', content: 'ls' }],
      step: 1,
    }, async () => ({ kind: 'enter' as const, messages: [] }))
    assert.equal(fetchCalls, 1, '503 loading → 不重试')
    assert.equal(svc.getStats().needleCircuitOpen, true, '503 loading → breaker 开')
    assert.equal(svc.getStats().needleRetryAttempts, 0)
    const audit = auditEntries.find(e => e.kind === 'needle.extract_failed')!
    assert.equal((audit.payload as any).reason, '503_loading')
    await svc.stop()
  })

  it('503 with "busy" body → 重试 1 次 + 重试也 503 → 开 breaker', async () => {
    const auditEntries: AuditEntry[] = []
    const { ctx } = makeCtx()
    const baseCtx = ctx as any
    baseCtx.auditLog = makeAuditLog(auditEntries)
    let fetchCalls = 0
    baseCtx.fetch = (() => {
      fetchCalls++
      return Promise.resolve(new Response('engine busy', { status: 503, headers: { 'x-reason': 'busy' } }))
    }) as any
    const svc = new NeedleExtractorServiceImpl(baseCtx, {
      needleEnabled: true,
      needleBreakerProbeMs: 60_000,
      needleBreakerTtlMs: 5000,
    }, makeAuditLog(auditEntries))
    const bridge = makeBridge('LOCAL', [{ name: 'bash', description: '', parameters: {} }])
    ;(baseCtx as any).realmSkillBridge = bridge
    const start = Date.now()
    await svc.handlePreStep({
      agent: { session: { id: 'sess-x' } },
      messages: [{ role: 'user', content: 'ls' }],
      step: 1,
    }, async () => ({ kind: 'enter' as const, messages: [] }))
    const wall = Date.now() - start
    assert.equal(fetchCalls, 2, '503 busy → 重试一次 = 2 次 fetch')
    assert.ok(wall >= 180, `retry 应至少 200ms backoff(实测 ${wall}ms)`)
    assert.equal(svc.getStats().needleCircuitOpen, true, '重试仍 503 → breaker 开')
    assert.equal(svc.getStats().needleRetryAttempts, 1)
    // audit 链:1 个 needle.extract_retry + 1 个 needle.extract_failed
    const retryAudits = auditEntries.filter(e => e.kind === 'needle.extract_retry')
    assert.equal(retryAudits.length, 1)
    assert.equal((retryAudits[0].payload as any).status, 503)
    const failAudit = auditEntries.find(e => e.kind === 'needle.extract_failed')!
    assert.equal((failAudit.payload as any).reason, '503_busy')
    assert.equal((failAudit.payload as any).retried, true)
    await svc.stop()
  })

  it('503 busy → 首次 503,重试 200 → 合成 message 注入', async () => {
    const auditEntries: AuditEntry[] = []
    const { ctx } = makeCtx()
    const baseCtx = ctx as any
    baseCtx.auditLog = makeAuditLog(auditEntries)
    let calls = 0
    baseCtx.fetch = (() => {
      calls++
      if (calls === 1) {
        return Promise.resolve(new Response('engine busy', { status: 503, headers: { 'x-reason': 'busy' } }))
      }
      // 第二次重试成功
      return Promise.resolve(okJsonResponse(NEEDLE_OK_CALL))
    }) as any
    const tools = {
      execute: async () => ({ isError: false, content: [{ type: 'text', text: 'file1.md\nfile2.md' }] }),
    }
    const svc = new NeedleExtractorServiceImpl(baseCtx, {
      needleEnabled: true,
      needleBreakerProbeMs: 60_000,
      needleBreakerTtlMs: 5000,
    }, makeAuditLog(auditEntries))
    const bridge = makeBridge('LOCAL', [{ name: 'bash', description: '', parameters: {} }])
    ;(baseCtx as any).realmSkillBridge = bridge
    ;(baseCtx as any).tools = tools
    const seed = { kind: 'enter' as const, messages: [{ role: 'user', content: 'ls' }] as any }
    const out = await svc.handlePreStep({
      agent: { session: { id: 'sess-x' } },
      messages: [{ role: 'user', content: 'ls' }],
      step: 1,
    }, async () => seed)
    assert.equal(calls, 2, '503 重试 1 次 → 200 成功')
    assert.equal(out.kind, 'enter')
    assert.equal((out.messages ?? []).length, 2, '原 + 合成 message')
    assert.equal(svc.getStats().needleCircuitOpen, false, '成功 → 不开 breaker')
    assert.equal(svc.getStats().needleRetryAttempts, 1)
    assert.equal(svc.getStats().needleSynthesisInjected, 1)
    await svc.stop()
  })

  it('502 engine internal → 不重试 + 开 breaker + audit reason=http_502', async () => {
    const auditEntries: AuditEntry[] = []
    const { ctx } = makeCtx()
    const baseCtx = ctx as any
    baseCtx.auditLog = makeAuditLog(auditEntries)
    let fetchCalls = 0
    baseCtx.fetch = (() => {
      fetchCalls++
      return Promise.resolve(new Response('engine crash', { status: 502 }))
    }) as any
    const svc = new NeedleExtractorServiceImpl(baseCtx, {
      needleEnabled: true,
      needleBreakerProbeMs: 60_000,
      needleBreakerTtlMs: 5000,
    }, makeAuditLog(auditEntries))
    const bridge = makeBridge('LOCAL', [{ name: 'bash', description: '', parameters: {} }])
    ;(baseCtx as any).realmSkillBridge = bridge
    await svc.handlePreStep({
      agent: { session: { id: 'sess-x' } },
      messages: [{ role: 'user', content: 'ls' }],
      step: 1,
    }, async () => ({ kind: 'enter' as const, messages: [] }))
    // 502 在 retryPlan 第一次发 + 第二次也发(重试),还是 first only?
    // 期望:first attempt isRetryable(502 算),retryPlan[1] 也尝试一次(也是 502)
    // 所以 fetchCalls === 2(Phase 7 retry-once 包含 502)
    assert.equal(fetchCalls, 2, '502 → 重试一次 = 2 次 fetch')
    assert.equal(svc.getStats().needleCircuitOpen, true, '重试仍 502 → breaker 开')
    assert.equal(svc.getStats().needleRetryAttempts, 1)
    const failAudit = auditEntries.find(e => e.kind === 'needle.extract_failed')!
    assert.equal((failAudit.payload as any).reason, 'http_502')
    assert.equal((failAudit.payload as any).retried, true)
    await svc.stop()
  })

  it('408 timeout proxy → 不重试 + 开 breaker + audit needle.timeout_skip', async () => {
    const auditEntries: AuditEntry[] = []
    const { ctx } = makeCtx()
    const baseCtx = ctx as any
    baseCtx.auditLog = makeAuditLog(auditEntries)
    baseCtx.fetch = (() => Promise.resolve(new Response('gateway timeout', { status: 408 }))) as any
    const svc = new NeedleExtractorServiceImpl(baseCtx, {
      needleEnabled: true,
      needleBreakerProbeMs: 60_000,
      needleBreakerTtlMs: 5000,
    }, makeAuditLog(auditEntries))
    const bridge = makeBridge('LOCAL', [{ name: 'bash', description: '', parameters: {} }])
    ;(baseCtx as any).realmSkillBridge = bridge
    await svc.handlePreStep({
      agent: { session: { id: 'sess-x' } },
      messages: [{ role: 'user', content: 'ls' }],
      step: 1,
    }, async () => ({ kind: 'enter' as const, messages: [] }))
    assert.equal(svc.getStats().needleTimeoutSkip, 1)
    assert.equal(svc.getStats().needleCircuitOpen, true)
    assert.ok(auditEntries.some(e => e.kind === 'needle.timeout_skip'))
    const audit = auditEntries.find(e => e.kind === 'needle.timeout_skip')!
    assert.equal((audit.payload as any).reason, 'timeout_proxy')
    await svc.stop()
  })

  it('其它 5xx(如 500)→ 不重试 + 开 breaker + audit reason=http_500', async () => {
    const auditEntries: AuditEntry[] = []
    const { ctx } = makeCtx()
    const baseCtx = ctx as any
    baseCtx.auditLog = makeAuditLog(auditEntries)
    let fetchCalls = 0
    baseCtx.fetch = (() => {
      fetchCalls++
      return Promise.resolve(new Response('internal error', { status: 500 }))
    }) as any
    const svc = new NeedleExtractorServiceImpl(baseCtx, {
      needleEnabled: true,
      needleBreakerProbeMs: 60_000,
      needleBreakerTtlMs: 5000,
    }, makeAuditLog(auditEntries))
    const bridge = makeBridge('LOCAL', [{ name: 'bash', description: '', parameters: {} }])
    ;(baseCtx as any).realmSkillBridge = bridge
    await svc.handlePreStep({
      agent: { session: { id: 'sess-x' } },
      messages: [{ role: 'user', content: 'ls' }],
      step: 1,
    }, async () => ({ kind: 'enter' as const, messages: [] }))
    assert.equal(fetchCalls, 1, '500 → 不在 retry 列表 → 1 次 fetch')
    assert.equal(svc.getStats().needleCircuitOpen, true)
    assert.equal(svc.getStats().needleRetryAttempts, 0)
    const audit = auditEntries.find(e => e.kind === 'needle.extract_failed')!
    assert.equal((audit.payload as any).reason, 'http_500')
    await svc.stop()
  })

  it('retry 路径 wall-clock ≥ 200ms(退避预算的 ops 可观测性)', async () => {
    const auditEntries: AuditEntry[] = []
    const { ctx } = makeCtx()
    const baseCtx = ctx as any
    baseCtx.auditLog = makeAuditLog(auditEntries)
    baseCtx.fetch = (() => Promise.resolve(new Response('busy', { status: 503, headers: { 'x-reason': 'busy' } }))) as any
    const svc = new NeedleExtractorServiceImpl(baseCtx, {
      needleEnabled: true,
      needleBreakerProbeMs: 60_000,
      needleBreakerTtlMs: 5000,
    }, makeAuditLog(auditEntries))
    const bridge = makeBridge('LOCAL', [{ name: 'bash', description: '', parameters: {} }])
    ;(baseCtx as any).realmSkillBridge = bridge
    const start = Date.now()
    await svc.handlePreStep({
      agent: { session: { id: 'sess-x' } },
      messages: [{ role: 'user', content: 'ls' }],
      step: 1,
    }, async () => ({ kind: 'enter' as const, messages: [] }))
    const wall = Date.now() - start
    assert.ok(wall >= 180, `retry path 至少 200ms(实测 ${wall}ms)`)
    await svc.stop()
  })
})

// ── 15. Phase 7:parseExtractResponse 纯函数 ──────────────────────────────

describe('needle-extractor:Phase 7 parseExtractResponse', () => {
  // 通过 ctx.fetch mock 间接测(parseExtractResponse 是 private)
  it('response 缺 confidence → 默认 0', async () => {
    const auditEntries: AuditEntry[] = []
    const { ctx } = makeCtx()
    const baseCtx = ctx as any
    baseCtx.auditLog = makeAuditLog(auditEntries)
    baseCtx.fetch = (() => Promise.resolve(okJsonResponse({
      type: 'call',
      function_calls: [{ name: 'bash', arguments: { command: 'ls' } }],
      // no confidence
    }))) as any
    const svc = new NeedleExtractorServiceImpl(baseCtx, {
      needleEnabled: true,
      needleBreakerProbeMs: 60_000,
      needleBreakerTtlMs: 5000,
    }, makeAuditLog(auditEntries))
    const bridge = makeBridge('LOCAL', [{ name: 'bash', description: '', parameters: {} }])
    ;(baseCtx as any).realmSkillBridge = bridge
    const tools = {
      execute: async () => ({ isError: false, content: [{ type: 'text', text: 'file.md' }] }),
    }
    ;(baseCtx as any).tools = tools
    const seed = { kind: 'enter' as const, messages: [{ role: 'user', content: 'ls' }] as any }
    const out = await svc.handlePreStep({
      agent: { session: { id: 'sess-x' } },
      messages: [{ role: 'user', content: 'ls' }],
      step: 1,
    }, async () => seed)
    // confidence 缺 → 0 → < threshold 0.7 → adopt gate fails → 不注入
    assert.equal(out.kind, 'enter')
    assert.equal((out.messages ?? []).length, 1, 'seed + nothing → 只剩 seed')
    assert.equal(svc.getStats().needleSynthesisInjected, 0)
    assert.equal(svc.getStats().needleLowConfSkip, 1)
    await svc.stop()
  })

  it('response 缺 validation.ungrounded → 默认 []', async () => {
    const auditEntries: AuditEntry[] = []
    const { ctx } = makeCtx()
    const baseCtx = ctx as any
    baseCtx.auditLog = makeAuditLog(auditEntries)
    baseCtx.fetch = (() => Promise.resolve(okJsonResponse({
      type: 'call',
      function_calls: [{ name: 'bash', arguments: { command: 'ls' } }],
      confidence: 0.95,
      // no validation
    }))) as any
    const svc = new NeedleExtractorServiceImpl(baseCtx, {
      needleEnabled: true,
      needleBreakerProbeMs: 60_000,
      needleBreakerTtlMs: 5000,
    }, makeAuditLog(auditEntries))
    const bridge = makeBridge('LOCAL', [{ name: 'bash', description: '', parameters: {} }])
    ;(baseCtx as any).realmSkillBridge = bridge
    const tools = {
      execute: async () => ({ isError: false, content: [{ type: 'text', text: 'x' }] }),
    }
    ;(baseCtx as any).tools = tools
    const seed = { kind: 'enter' as const, messages: [{ role: 'user', content: 'ls' }] as any }
    const out = await svc.handlePreStep({
      agent: { session: { id: 'sess-x' } },
      messages: [{ role: 'user', content: 'ls' }],
      step: 1,
    }, async () => seed)
    // ungrounded=[] → 不跳 → 执行 → 注入
    assert.equal((out.messages ?? []).length, 2)
    assert.equal(svc.getStats().needleSynthesisInjected, 1)
    await svc.stop()
  })
})
