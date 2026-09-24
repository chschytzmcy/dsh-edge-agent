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

/** §7.93 memory 契约:11 个字段的权威默认值(.env 翻译层未生效时的兜底)。 */
const EXPECTED_DEFAULTS = {
  needleEnabled: false,
  needleUrl: 'http://127.0.0.1:8081',
  needleTimeoutMs: 1500,
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
  it('schema resolve 空 config → 11 字段与 .env/memory 契约逐字一致', () => {
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
