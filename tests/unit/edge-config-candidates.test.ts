/**
 * §7.182 (2026-11-11) —— 配置落点：**只有两档**
 *
 * ## 主人裁决（三句话，原文）
 *
 * > 「仓库的配置目录后续不再支持」
 * > 「按正常逻辑 `<插件目录>/config/edge.json` 就应该是第一顺位，是有用的，
 * >   这样用户才可以理解」
 * > 「`~/.dsh-edge-agent/edge.json` 是第二顺位，没有第3顺位了，就这两个」
 *
 * ⇒ 候选表（**没有第三档**：shipped 模板不再被读取，它的值折进了代码默认值）：
 *
 * | 顺位 | 路径 | 谁写它 |
 * |---|---|---|
 * | 1 | `<安装目录>/config/edge.json` | 运维（插件装在哪，配置就在哪 —— 用户找得到） |
 * | 2 | `~/.dsh-edge-agent/edge.json` | 运维（跨通道 / 跨重装 / 删 profile 都活着） |
 *
 * ## 关键：顺位 1 在**源码 checkout** 里要跳过
 *
 * `edgeBundleRoot()` 从本模块位置往上两级 ⇒ **仓库 checkout 与安装目录解析到
 * 同一条路径**。而仓库的 `config/` 目录按裁决不再作为活配置的落点（明文
 * API key 不该待在 git checkout 里）。
 *
 * ⇒ `isSourceCheckout()`：`<root>/src/dsh-adapter` 存在 ⇒ 是 checkout ⇒
 * **跳过顺位 1** ⇒ checkout 与安装态读的是**同一份** home 配置，dev 与生产
 * 不会分叉。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'

import {
  edgeConfigCandidates,
  edgeBundleRoot,
  edgeHome,
  isSourceCheckout,
  resetEdgeConfigCache,
  DEFAULT_EDGE_CONFIG,
} from '../../src/dsh-adapter/edge-config.ts'
import { resolveLlmTraceConfig } from '../../src/dsh-adapter/llm-trace.ts'

/**
 * vitest.config.ts 设了 DSH_EDGE_CONFIG_FILE=off（让开发机的活配置不泄漏进
 * 断言）。本文件要断言**候选顺序**，必须临时把这个开关摘掉。
 */
function withFileLayer<T>(fn: () => T): T {
  const prev = process.env.DSH_EDGE_CONFIG_FILE
  delete process.env.DSH_EDGE_CONFIG_FILE
  try {
    resetEdgeConfigCache()
    return fn()
  } finally {
    if (prev === undefined) delete process.env.DSH_EDGE_CONFIG_FILE
    else process.env.DSH_EDGE_CONFIG_FILE = prev
    resetEdgeConfigCache()
  }
}

describe('§7.182 — 配置落点：顺位 1 插件目录 / 顺位 2 home，就这两档', () => {
  it('单测跑在源码 checkout 里 ⇒ 顺位 1 被跳过，只剩 home 一档', () => {
    // 本文件 import 的是 src/ ⇒ edgeBundleRoot() = 仓库根 ⇒ 是 checkout。
    assert.equal(isSourceCheckout(), true, '单测环境应当是源码 checkout')
    const candidates = withFileLayer(() => edgeConfigCandidates())
    assert.equal(candidates.length, 1, `checkout 里应当只有 home 一档: ${candidates.join(' | ')}`)
    assert.equal(candidates[0], join(homedir(), '.dsh-edge-agent', 'edge.json'))
  })

  it('checkout 里不得把仓库的 config/edge.json 当候选', () => {
    const candidates = withFileLayer(() => edgeConfigCandidates())
    assert.ok(
      !candidates.some(c => c.endsWith(join('config', 'edge.json'))),
      `仓库那份不得再是候选: ${candidates.join(' | ')}`,
    )
  })

  it('安装态（无 src/ 树）⇒ 顺位 1 生效：插件目录的 config/edge.json 在最前', () => {
    // 造一个「像安装目录」的根：只有 config/，没有 src/。
    const fakeRoot = mkdtempSync(join(tmpdir(), 'dsh-edge-bundle-'))
    mkdirSync(join(fakeRoot, 'config'), { recursive: true })
    assert.equal(isSourceCheckout(fakeRoot), false, '没有 src/ 的目录应当被当成安装态')
    // 有 src/ 树 ⇒ 是 checkout ⇒ 顺位 1 被跳过。
    mkdirSync(join(fakeRoot, 'src', 'dsh-adapter'), { recursive: true })
    assert.equal(isSourceCheckout(fakeRoot), true, '有 src/ 树的目录应当被当成 checkout')
  })

  it('顺位 2 就是 edgeHome("edge.json") —— 运维的持久落点', () => {
    const candidates = withFileLayer(() => edgeConfigCandidates())
    assert.ok(candidates.includes(edgeHome('edge.json')), 'home 那份必须在候选里')
    assert.equal(edgeHome('edge.json'), join(homedir(), '.dsh-edge-agent', 'edge.json'))
  })

  it('模板不再被读取（没有第三档）', () => {
    const candidates = withFileLayer(() => edgeConfigCandidates())
    assert.ok(
      !candidates.some(c => c.endsWith('edge.example.json')),
      `shipped 模板不再是运行时候选: ${candidates.join(' | ')}`,
    )
  })

  it('DSH_EDGE_CONFIG_FILE=off 仍然关掉整个文件层（测试隔离不变）', () => {
    const prev = process.env.DSH_EDGE_CONFIG_FILE
    process.env.DSH_EDGE_CONFIG_FILE = 'off'
    try {
      resetEdgeConfigCache()
      assert.deepEqual(edgeConfigCandidates(), [])
    } finally {
      if (prev === undefined) delete process.env.DSH_EDGE_CONFIG_FILE
      else process.env.DSH_EDGE_CONFIG_FILE = prev
      resetEdgeConfigCache()
    }
  })

  it('edgeBundleRoot() 仍然是「仓库根 / 安装目录」的那个根（顺位 1 的定位依据）', () => {
    assert.equal(edgeBundleRoot(), join(edgeBundleRoot()))
    assert.ok(edgeBundleRoot().length > 0)
  })
})

/**
 * 模板 ↔ 代码默认值 的漂移锁。
 *
 * §7.182 之后，`config/edge.example.json` **不再是运行时候选** —— 但它仍然是
 * 运维**抄来改**的那份模板。所以两边必须同值：抄出来的配置与「没配置文件」的
 * 行为必须一样，否则「照模板抄」就成了另一套配置。
 */
describe('§7.182 — 模板与代码默认值不得漂移', () => {
  const tpl = JSON.parse(
    readFileSync(join(edgeBundleRoot(), 'config', 'edge.example.json'), 'utf8'),
  ) as Record<string, any>

  const PAIRS: Array<[string, unknown, unknown]> = [
    ['stages.guard.timeoutMs', DEFAULT_EDGE_CONFIG.stages?.guard?.timeoutMs, tpl.stages.guard.timeoutMs],
    ['stages.intent.timeoutMs', DEFAULT_EDGE_CONFIG.stages?.intent?.timeoutMs, tpl.stages.intent.timeoutMs],
    ['stages.intent.llmFallback', DEFAULT_EDGE_CONFIG.stages?.intent?.llmFallback, tpl.stages.intent.llmFallback],
    ['jev.enabled', DEFAULT_EDGE_CONFIG.jev?.enabled, tpl.jev.enabled],
    ['jev.provider', DEFAULT_EDGE_CONFIG.jev?.provider, tpl.jev.provider],
    ['jev.model', DEFAULT_EDGE_CONFIG.jev?.model, tpl.jev.model],
    ['jev.authScheme', DEFAULT_EDGE_CONFIG.jev?.authScheme, tpl.jev.authScheme],
    ['jev.path', DEFAULT_EDGE_CONFIG.jev?.path, tpl.jev.path],
    ['jev.localAdoptFloor', DEFAULT_EDGE_CONFIG.jev?.localAdoptFloor, tpl.jev.localAdoptFloor],
    ['webSearch.tavilyEnabled', DEFAULT_EDGE_CONFIG.webSearch?.tavilyEnabled, tpl.webSearch.tavilyEnabled],
    ['webSearch.bochaEnabled', DEFAULT_EDGE_CONFIG.webSearch?.bochaEnabled, tpl.webSearch.bochaEnabled],
    ['functionCallExternal.timeoutMs', DEFAULT_EDGE_CONFIG.functionCallExternal?.timeoutMs, tpl.functionCallExternal.timeoutMs],
    ['functionCallExternal.probeTimeoutMs', DEFAULT_EDGE_CONFIG.functionCallExternal?.probeTimeoutMs, tpl.functionCallExternal.probeTimeoutMs],
  ]

  for (const [field, code, template] of PAIRS) {
    it(`${field}：代码默认值 === 模板值`, () => {
      assert.deepEqual(code, template, `${field} 在代码默认值与模板之间漂移了`)
    })
  }

  it('llmTrace：生效值与模板一致（DEFAULT_LLM_TRACE_CONFIG 就是兜底）', () => {
    const eff = resolveLlmTraceConfig(DEFAULT_EDGE_CONFIG)
    const t = tpl.audit.llmTrace
    for (const k of ['enabled', 'includeRequest', 'includeResponse', 'maxChars', 'maxMessages', 'redactPii', 'redactSecrets']) {
      assert.deepEqual(eff[k as keyof typeof eff], t[k], `audit.llmTrace.${k} 漂移`)
    }
  })

  it('模板同样不带 jev.apiKeyRef（照模板抄不会触发「密钥引用指向不存在的槽位」）', () => {
    // danglingSecretRefs() 把「槽位为空」也算悬空引用（edge-config.ts:1079）⇒
    // 模板里写 apiKeyRef + secrets 里留空 = 每个抄模板的人启动都报一条 ERROR。
    assert.equal(tpl.jev?.apiKeyRef, undefined, '模板里不得预置 jev.apiKeyRef')
  })

  it('jev.apiKeyRef 刻意不并入代码默认值（默认档位没有这个槽位可指）', () => {
    // 模板里写着 apiKeyRef → secrets.bailianApiKey；槽位不在 ⇒ 每次启动都会报
    // 「密钥引用指向不存在的槽位」（§7.171 的已知噪声）。代码默认值不得带上这个
    // 引用 —— jev 的默认 provider 是本地 ONNX，本来就不需要 key。
    assert.equal(DEFAULT_EDGE_CONFIG.jev?.apiKeyRef, undefined)
  })
})
