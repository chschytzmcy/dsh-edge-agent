/**
 * §7.221 — 工具层 `web_search` 的可用性闸门（edge 侧）。
 *
 * ## 这道闸门补的是哪一面
 *
 * 主闸门在**宿主**：`@deepseek-ai/dsh-tool-web` 用
 * `when: ({ modelSelection }) => ctx.web.searchReady(modelSelection.provider)`
 * 注册 `web_search`；聚合器 `ready()` 答 false 时，宿主把工具从**声明**与
 * **派发**里一并摘掉（连带那段 system-prompt 指引）。
 *
 * 但宿主那道闸门**管不到** external tool-schema face ——
 * `realm-skill-bridge.getToolSchemasForExternal()` 直接投影 registry schema，
 * **不经过**宿主的 `when` 谓词 ⇒ 外部调用方仍会看见 `web_search`。
 *
 * ⇒ edge 侧在 `filterToolsField`（模型可见性 + external face）与 Layer 3
 * （执行期）各补一道，两处共用 `resolveWebSearchAvailability()`。
 *
 * ## 判据
 *
 * Tavily / 博查 两档任一「enable 且配到了 key」⇒ 工具层 `web_search` 可用；
 * 两档都拿不出 ⇒ 不可用 ⇒ 模型走**所配置的云端模型**自带的原生搜索。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'vitest'

import {
  RealmSkillBridgeService,
  isWebSearchToolName,
} from '../../src/dsh-adapter/realm-skill-bridge.ts'
import { loadEdgeConfig, resetEdgeConfigCache } from '../../src/dsh-adapter/edge-config.ts'

function fakeCtx() {
  return {
    reflect: { provide(_n: string, _v: unknown) { return () => {} } },
    provide(_n: string, _v: unknown) { return () => {} },
    skills: {
      async list() { return [] },
      async snapshot() { return { skills: [], complete: true } },
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
}

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'edge-websearch-gate-'))
  resetEdgeConfigCache()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  resetEdgeConfigCache()
})

function makeService() {
  return new RealmSkillBridgeService(
    fakeCtx() as never,
    { configPath: join(root, 'skill-realms.json'), hotReload: false, watchIntervalMs: 5000 },
    undefined,
  )
}

/**
 * 把 edge 配置的模块级缓存**钉**成一份指定的配置。
 *
 * `loadEdgeConfig(force, candidates)` 允许显式给候选路径 ⇒ 可以在临时目录
 * 上放一份 edge.json 并让整个进程看到它；之后 `loadEdgeConfig()`（非强制）
 * 直接命中缓存 —— 这正是闸门侧读配置的方式。
 */
function primeEdgeConfig(body: unknown): void {
  const path = join(root, 'edge.json')
  writeFileSync(path, JSON.stringify(body), 'utf8')
  loadEdgeConfig(true, [path])
}

describe('§7.221 — isWebSearchToolName', () => {
  it('认 web_search 与带 provider 后缀的形状', () => {
    assert.equal(isWebSearchToolName('web_search'), true)
    assert.equal(isWebSearchToolName('web_search:deepseek-official'), true)
  })

  it('不认 web_fetch（抓网页与搜索档位无关）', () => {
    assert.equal(isWebSearchToolName('web_fetch'), false)
    assert.equal(isWebSearchToolName('web_fetch:http'), false)
    assert.equal(isWebSearchToolName('bash'), false)
    assert.equal(isWebSearchToolName('web_searcher'), false)
  })
})

describe('§7.221 — 闸门关闭（两档都没 enable）', () => {
  it('默认配置下工具层 web_search 不可用', () => {
    // vitest 全局设 DSH_EDGE_CONFIG_FILE=off ⇒ 读到的是内置默认值
    // （webSearch.tavilyEnabled / bochaEnabled 都是 false）。
    assert.equal(makeService().webSearchToolAvailable(), false)
  })

  it('filterToolsField 把 web_search 从模型可见工具里摘掉', () => {
    const service = makeService()
    const tools = [
      { name: 'web_search', description: 'search' },
      { name: 'web_fetch', description: 'fetch' },
      { name: 'bash', description: 'shell' },
    ]
    const filter = service.filterToolsField(tools, 'CLOUD', { audit: false })
    assert.deepEqual(filter.removed, ['web_search'])
    assert.equal(filter.changed, true)
    const kept = filter.tools.map((t) => (t as { name: string }).name)
    assert.deepEqual(kept, ['web_fetch', 'bash'], '只有 web_search 被摘掉')
  })

  it('带 provider 后缀的形状同样被摘掉', () => {
    const service = makeService()
    const filter = service.filterToolsField(
      [{ name: 'web_search:tavily-bocha-fallback' }],
      'CLOUD',
      { audit: false },
    )
    assert.deepEqual(filter.removed, ['web_search:tavily-bocha-fallback'])
    assert.equal(filter.tools.length, 0)
  })

  it('Layer 3 执行期直接拒（realm 已知）', () => {
    const reason = makeService().checkToolRealm('web_search', 'CLOUD')
    assert.ok(reason, '必须给出拒绝理由')
    assert.match(reason!, /unavailable/u)
    assert.match(reason!, /native search/u)
  })

  it('Layer 3 执行期直接拒（realm 未知也一样 —— 这是工具存不存在，不是 realm 问题）', () => {
    assert.ok(makeService().checkToolRealm('web_search', undefined))
  })

  it('web_fetch 不受影响', () => {
    assert.equal(makeService().checkToolRealm('web_fetch', 'CLOUD'), undefined)
  })
})

describe('§7.221 — 闸门打开（ Tavily 启用且配到 key）', () => {
  beforeEach(() => {
    primeEdgeConfig({
      webSearch: { tavilyEnabled: true, bochaEnabled: false },
      secrets: { tavilyApiKey: 'tvly-fake' },
    })
  })

  it('工具层 web_search 可用', () => {
    assert.equal(makeService().webSearchToolAvailable(), true)
  })

  it('filterToolsField 保留 web_search', () => {
    const filter = makeService().filterToolsField(
      [{ name: 'web_search' }, { name: 'web_fetch' }],
      'CLOUD',
      { audit: false },
    )
    assert.deepEqual(filter.removed, [])
    assert.equal(filter.changed, false)
    assert.equal(filter.tools.length, 2)
  })

  it('Layer 3 放行', () => {
    assert.equal(makeService().checkToolRealm('web_search', 'CLOUD'), undefined)
  })
})

describe('§7.221 — 开关开了但没 key ⇒ 闸门仍然关闭', () => {
  beforeEach(() => {
    primeEdgeConfig({
      webSearch: { tavilyEnabled: true, bochaEnabled: true },
      secrets: {},
    })
  })

  it('开关不等于可用 —— key 缺一不可', () => {
    assert.equal(makeService().webSearchToolAvailable(), false)
    assert.ok(makeService().checkToolRealm('web_search', 'CLOUD'))
  })
})
