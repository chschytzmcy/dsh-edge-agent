/**
 * flow-panel raw evidence tests — §7.121「每一次判断都要给出原始判断数据」
 *
 * 覆盖两件事：
 *
 *  1. **答案出口不再说「路由未定」**：桌面端答案走的是 edge adapter
 *     （`llm.local.end` / `llm.cloud.end`），不是宿主自己的
 *     `llm.host.route`。此前节点只认后者，于是一轮明明作答了的对话
 *     显示「路由未定」——真实会话里 90 条 llm.local.*、0 条 llm.host.route。
 *
 *  2. **每个判定节点露出原始依据**：正则命中了哪条规则（+ 正则原文）、
 *     意图判定命中了哪个关键字、jev 决策模型的原始 intent/confidence/
 *     riskScore、PII 命中了哪条规则并替成了什么占位符、路由改写的机器原因码。
 *
 * 渲染用 `react-dom/server` 静态渲染 —— 断言的是 operator 真正看到的
 *  文本，而不是内部数据结构。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { FlowPanel } from '../../src/client/flowPanel'
import type { EdgeRow, EdgeSummary } from '../../src/client/types'

let seq = 0
let ts = 1_700_000_000_000

/** Build one audit row as the host fold would hand it to the client. */
function row(kind: string, payload: Record<string, unknown>, panel: EdgeRow['panel'] = 'intent'): EdgeRow {
  seq += 1
  ts += 1000
  return { ts, kind, panel, level: 'info', seq, payload }
}

const SUMMARY: EdgeSummary = { sessionId: 's1', turns: 1 }

/** Render the flow panel and return its visible text. */
function render(rows: EdgeRow[], summary: EdgeSummary = SUMMARY): string {
  return renderToStaticMarkup(FlowPanel({ rows, summary })) as unknown as string
}

describe('flow panel — §7.121 answer egress', () => {
  it('reads the answer route from llm.local.end, not only llm.host.route', () => {
    // The real desktop shape: the edge adapter answered, the host never
    // announced a route of its own.
    const rows = [
      row('llm.local.end', {
        provider: 'local-llm',
        model: 'MiniMax-M3.1-Flash',
        route: 'MiniMax-M3.1-Flash',
        durationMs: 2063,
        promptLen: 101298,
        resultLen: 412,
      }, 'route'),
    ]
    const out = render(rows)
    assert.ok(!out.includes('路由未定'), `must not say 路由未定: ${out}`)
    assert.ok(out.includes('local-llm/MiniMax-M3.1-Flash'), `route missing: ${out}`)
    // 原始判断数据：这一轮实际出口的原始字段
    assert.ok(out.includes('durationMs=2063'), `raw duration missing: ${out}`)
    assert.ok(out.includes('promptLen=101298'), `raw promptLen missing: ${out}`)
    assert.ok(out.includes('resultLen=412'), `raw resultLen missing: ${out}`)
  })

  it('reads the cloud adapter row when the answer left the device', () => {
    const rows = [
      row('llm.cloud.end', {
        provider: 'cloud-llm',
        model: 'deepseek-chat',
        durationMs: 900,
        promptLen: 2048,
        resultLen: 128,
      }, 'route'),
    ]
    const out = render(rows)
    assert.ok(!out.includes('路由未定'), `must not say 路由未定: ${out}`)
    assert.ok(out.includes('cloud-llm/deepseek-chat'), `route missing: ${out}`)
  })

  it('still falls back to the host route when no adapter row exists', () => {
    const rows = [row('llm.host.route', { provider: 'local-llm', model: 'qwen3-4b' }, 'route')]
    const out = render(rows)
    assert.ok(out.includes('local-llm/qwen3-4b'), `host route missing: ${out}`)
    assert.ok(!out.includes('路由未定'), `must not say 路由未定: ${out}`)
  })

  it('honest pending when nothing ever announced a route', () => {
    const out = render([row('intent.classify.start', { classifier: 'local-llm' })])
    assert.ok(out.includes('路由未定'), `expected pending state: ${out}`)
  })
})

describe('flow panel — §7.121 raw judgment data', () => {
  it('attack check: names the injection rule AND its regex source', () => {
    const rows = [
      row('input.injection.warned', {
        patterns: ['role-override-zh'],
        patternSources: ['你(现在|立即)?\\s*(是|变成|扮演|充当)\\s*(一个|一名)?'],
        preview: '你是谁',
      }, 'interception'),
    ]
    const out = render(rows)
    assert.ok(out.includes('role-override-zh'), `hit rule missing: ${out}`)
    assert.ok(out.includes('正则'), `regex label missing: ${out}`)
    assert.ok(out.includes('扮演'), `regex source missing: ${out}`)
  })

  it('attack check: shows the model verdict rationale for a clean turn', () => {
    const rows = [
      row('guard.model-detect.end', {
        provider: 'local-llm',
        model: 'MiniMax-M3.1-Flash',
        dataClass: 'public',
        durationMs: 1819,
        textLen: 6,
        safe: true,
        rationale: '用户询问助手身份，属公开级信息',
      }, 'interception'),
    ]
    const out = render(rows)
    assert.ok(out.includes('干净（公开级）'), `verdict missing: ${out}`)
    assert.ok(out.includes('理由'), `why label missing: ${out}`)
    assert.ok(out.includes('公开级信息'), `rationale missing: ${out}`)
  })

  it('attack check: surfaces threats and rationale when the model says unsafe', () => {
    const rows = [
      row('guard.model-detect.unsafe', {
        provider: 'local-llm',
        model: 'MiniMax-M3.1-Flash',
        threats: ['prompt-leak'],
        dataClass: 'secret',
        rationale: '尝试索取系统提示词',
        durationMs: 900,
      }, 'interception'),
    ]
    const out = render(rows)
    assert.ok(out.includes('prompt-leak'), `threats missing: ${out}`)
    assert.ok(out.includes('尝试索取系统提示词'), `rationale missing: ${out}`)
  })

  it('intent: shows the matched keyword, the semantic meaning and the decider', () => {
    const rows = [
      row('intent.classify.start', { classifier: 'local-llm', model: 'qwen3-4b', textLen: 6 }, 'intent'),
      row('intent.classify.end', {
        category: 'LOCAL',
        confidence: 0.98,
        rationale: 'rule-local-entity:密盒',
        keyword: '密盒',
        semantic: '涉及本机设备上的应用与数据操作',
        path: 'llm',
        durationMs: 300,
        textLen: 6,
      }, 'intent'),
    ]
    const out = render(rows)
    assert.ok(out.includes('关键字'), `keyword label missing: ${out}`)
    assert.ok(out.includes('密盒'), `keyword missing: ${out}`)
    assert.ok(out.includes('语义'), `semantic label missing: ${out}`)
    assert.ok(out.includes('本机设备上的应用'), `semantic missing: ${out}`)
    // §7.122: 路径已并入「裁决者」行 —— LLM 路径要带上 provider/model 实体
    assert.ok(out.includes('裁决者'), `decided-by label missing: ${out}`)
    assert.ok(out.includes('LLM 分类器'), `decider missing: ${out}`)
    assert.ok(out.includes('local-llm/qwen3-4b'), `classifier identity missing: ${out}`)
  })

  it('intent: shows the decision model raw intent / confidence / riskScore', () => {
    const rows = [
      row('intent.classify.start', { classifier: 'local-llm', textLen: 6 }, 'intent'),
      row('intent.classify.end', {
        category: 'LOCAL',
        confidence: 0.94,
        rationale: 'jev-intent:本地操作',
        path: 'jev-adopt',
        durationMs: 2738,
        jevIntent: '本地操作',
        jevConfidence: 0.9409,
        jevRiskScore: 0.3679,
      }, 'intent'),
    ]
    const out = render(rows)
    assert.ok(out.includes('决策模型'), `jev label missing: ${out}`)
    assert.ok(out.includes('intent=本地操作'), `jev intent missing: ${out}`)
    assert.ok(out.includes('confidence=0.94'), `jev confidence missing: ${out}`)
    assert.ok(out.includes('riskScore=0.37'), `jev riskScore missing: ${out}`)
  })

  it('PII scrub: names the rules hit and the placeholders they became', () => {
    const rows = [
      row('sanitizer.sanitized', {
        replacementCount: 2,
        totalMappings: 2,
        piiTypes: ['phone', 'email'],
        placeholders: ['[PHONE_1]', '[EMAIL_2]'],
        dataClasses: ['confidential'],
      }, 'interception'),
    ]
    const out = render(rows)
    assert.ok(out.includes('已替换 2 处'), `count missing: ${out}`)
    assert.ok(out.includes('phone'), `pii type missing: ${out}`)
    assert.ok(out.includes('email'), `pii type missing: ${out}`)
    assert.ok(out.includes('[PHONE_1]'), `placeholder missing: ${out}`)
    assert.ok(out.includes('[EMAIL_2]'), `placeholder missing: ${out}`)
  })

  it('routing: shows the machine reason code next to the translated reason', () => {
    const rows = [
      row('input-guard.routed', { category: 'LOCAL', edgeRouteUsed: false, routeSource: 'webui' }, 'interception'),
      row('input-guard.route.overridden', {
        from: { provider: 'qwen-token-plan-cn', model: 'qwen3.8-flash' },
        to: { provider: 'local-llm', model: 'MiniMax-M3.1-Flash' },
        reason: 'intent-local',
      }, 'interception'),
    ]
    const out = render(rows)
    assert.ok(out.includes('意图判定为本地'), `translated reason missing: ${out}`)
    assert.ok(out.includes('机器码'), `code label missing: ${out}`)
    assert.ok(out.includes('intent-local'), `machine code missing: ${out}`)
  })

  it('threat watch: reports how many signals were inspected when calm', () => {
    const rows = [
      row('guard.model-detect.start', { textLen: 6 }, 'interception'),
      row('guard.model-detect.end', { dataClass: 'public', durationMs: 100, textLen: 6 }, 'interception'),
    ]
    const out = render(rows)
    assert.ok(out.includes('本轮窗口无异常'), `calm verdict missing: ${out}`)
    assert.ok(out.includes('已检信号'), `watched label missing: ${out}`)
    assert.ok(out.includes('2'), `watched count missing: ${out}`)
  })
})

describe('flow panel — §7.121 array payloads survive the fold', () => {
  it('renders array-valued hit details instead of a placeholder', () => {
    // The fold used to drop arrays wholesale, so `patterns` never reached
    // the panel — the operator saw 「命中告警级注入特征」 with no rule name.
    const rows = [
      row('input.injection.warned', { patterns: ['act-as', 'pretend'] }, 'interception'),
    ]
    const out = render(rows)
    assert.ok(out.includes('act-as'), `first rule missing: ${out}`)
    assert.ok(out.includes('pretend'), `second rule missing: ${out}`)
  })
})

describe('flow panel — §7.122 the classifier line must name the ACTUAL decider', () => {
  it('a jev verdict must NOT claim the LLM classifier decided it', () => {
    // The bug: `intent.classify.start` records the CONFIGURED fallback
    // classifier (local-llm) before any branch runs. When jev adjudicates
    // (path=jev-adopt) the LLM classifier is never called — yet the panel
    // rendered 「分类器 local-llm」, i.e. it named a decider that did not
    // run. Real session: path=jev-adopt with classifier=local-llm.
    const rows = [
      row('intent.classify.start', {
        classifier: 'local-llm',
        model: 'MiniMax-M3.1-Flash',
        textLen: 6,
      }, 'intent'),
      row('intent.classify.end', {
        category: 'LOCAL',
        confidence: 0.98,
        rationale: 'jev-intent:LOCAL',
        path: 'jev-adopt',
        durationMs: 308,
        jevIntent: 'LOCAL',
        jevConfidence: 0.98,
        jevRiskScore: 0.14,
      }, 'intent'),
    ]
    const out = render(rows)
    assert.ok(out.includes('裁决者'), `decided-by label missing: ${out}`)
    assert.ok(out.includes('决策模型'), `jev decider missing: ${out}`)
    assert.ok(out.includes('LLM 分类器未调用'), `must say the LLM classifier did NOT run: ${out}`)
    // 不得再出现「分类器 local-llm」这种把备用分类器说成裁决者的写法
    assert.ok(!out.includes('分类器 local-llm'), `must not name the unused classifier: ${out}`)
    assert.ok(out.includes('决策模型裁决'), `headline must not say LLM verdict: ${out}`)
  })

  it('an LLM verdict does name the LLM classifier', () => {
    const rows = [
      row('intent.classify.start', {
        classifier: 'local-llm',
        model: 'qwen3-4b',
        textLen: 6,
      }, 'intent'),
      row('intent.classify.end', {
        category: 'LOCAL',
        confidence: 0.9,
        rationale: 'llm-classified:local',
        path: 'llm',
        durationMs: 1098,
      }, 'intent'),
    ]
    const out = render(rows)
    assert.ok(out.includes('裁决者'), `decided-by label missing: ${out}`)
    assert.ok(out.includes('LLM 分类器'), `LLM decider missing: ${out}`)
    assert.ok(out.includes('local-llm/qwen3-4b'), `classifier identity missing: ${out}`)
  })

  it('shows the classifier endpoint and flags when it is NOT on this device', () => {
    // The provider name says "local" but config/edge.json may point it at a
    // public endpoint. The operator needs the real destination.
    const rows = [
      row('intent.classify.start', {
        classifier: 'local-llm',
        model: 'MiniMax-M3.1-Flash',
        textLen: 6,
        classifierEndpoint: 'https://api.minimaxi.com/v1',
        classifierIsLocal: false,
      }, 'intent'),
      row('intent.classify.end', {
        category: 'LOCAL',
        confidence: 0.98,
        rationale: 'jev-intent:LOCAL',
        path: 'jev-adopt',
        durationMs: 308,
      }, 'intent'),
    ]
    const out = render(rows)
    assert.ok(out.includes('真实落点'), `endpoint label missing: ${out}`)
    assert.ok(out.includes('api.minimaxi.com'), `endpoint missing: ${out}`)
    assert.ok(out.includes('不在本机'), `must flag the off-device endpoint: ${out}`)
  })

  it('marks a loopback endpoint as on-device', () => {
    const rows = [
      row('intent.classify.start', {
        classifier: 'local-llm',
        model: 'qwen3-4b',
        textLen: 6,
        classifierEndpoint: 'http://127.0.0.1:8080/v1',
        classifierIsLocal: true,
      }, 'intent'),
      row('intent.classify.end', {
        category: 'LOCAL',
        confidence: 0.9,
        rationale: 'llm-classified:local',
        path: 'llm',
        durationMs: 300,
      }, 'intent'),
    ]
    const out = render(rows)
    assert.ok(out.includes('127.0.0.1'), `endpoint missing: ${out}`)
    assert.ok(out.includes('本机'), `must mark the on-device endpoint: ${out}`)
  })

  it('a cache hit is named as such, not as a classifier verdict', () => {
    const rows = [
      row('intent.classify.start', { classifier: 'local-llm', model: 'x', textLen: 6 }, 'intent'),
      row('intent.classify.end', {
        category: 'LOCAL',
        confidence: 0.9,
        rationale: 'llm-classified:local',
        path: 'cache',
        durationMs: 5,
      }, 'intent'),
    ]
    const out = render(rows)
    assert.ok(out.includes('缓存命中'), `cache decider missing: ${out}`)
  })
})
