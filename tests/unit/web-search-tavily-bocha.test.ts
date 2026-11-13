/**
 * web-search-tavily-bocha unit tests —— §7.221（2026-11-13，主人裁决）。
 *
 * ## 这一轮改了什么
 *
 * 搜索链从**三级**（Tavily → 博查 AI → DeepSeek）变成**两档**（Tavily → 博查 AI）：
 * DeepSeek 那一档（edge 自建的 `DeepSeekSearchProvider`，用 `DEEPSEEK_API_KEY`
 * 打 `web_search_20250305`）整档删除。搜索改跟随**所配置的云端模型**。
 *
 * ## 「两档都没有 ⇒ 工具层 web_search 不提供」怎么落地
 *
 * 宿主 `@deepseek-ai/dsh-tool-web` 用
 * `when: ({ modelSelection }) => ctx.web.searchReady(modelSelection.provider)`
 * 注册 `web_search`；宿主 seam 的 `searchReady()` 只在**选中成功**时才去问
 * provider 的 `ready?.()`，**选中失败反而答 true**。
 *
 * ⇒ 所以「两档都关」必须表达成「provider 被选中 + `ready()` 答 false」。
 * 本文件里有两条**防回归**断言钉住这件事：
 *   - `available()` 恒 true（改成 false ⇒ 选中失败 ⇒ 工具反而可见）；
 *   - `ready()` 在两档都关时答 false。
 *
 * 测试矩阵：
 *   A 档位解析（edge-config）：开关 × key 的四种组合 + env 兜底 + 空串口径
 *   B provider：available / ready / search（成功、降级、失败、无配置）
 *   C 宿主规则复刻：searchReady 的结果决定工具可见性
 *   D apply()：恒注册、重复注册让位（§7.189）、错误照抛
 */

import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'vitest'

import {
  TAVILY_BOCHA_PROVIDER_ID,
  TavilyBochaFallbackProvider,
  apply,
} from '../../src/dsh-adapter/web-search-tavily-bocha.ts'
import {
  resolveWebSearchAvailability,
  resolveWebSearchTiers,
  type EdgeConfig,
  type EdgeWebSearchTiers,
} from '../../src/dsh-adapter/edge-config.ts'
import { WebError } from '@deepseek-ai/dsh-web'

// ── fetch mock infrastructure ────────────────────────────────────────

type FetchInit = { url: string; init: RequestInit }

interface CapturedRequest extends FetchInit {
  bodyJson: Record<string, unknown> | undefined
}

const originalFetch = globalThis.fetch

interface UrlResponder {
  test: (url: string) => boolean
  build: (captured: CapturedRequest) => Response
}

let responderTable: UrlResponder[] = []
let capturedCalls: CapturedRequest[] = []

function installFetchMock(): void {
  responderTable = []
  capturedCalls = []
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url
    const req: FetchInit = { url, init }
    let bodyJson: Record<string, unknown> | undefined
    if (typeof init.body === 'string') {
      try {
        bodyJson = JSON.parse(init.body)
      } catch {
        bodyJson = undefined
      }
    }
    const captured: CapturedRequest = { ...req, bodyJson }
    capturedCalls.push(captured)
    for (const r of responderTable) {
      if (r.test(url)) return r.build(captured)
    }
    throw new Error(`unmocked fetch: ${url}`)
  }) as typeof fetch
}

function tavilyResponder(status: number, body: unknown): UrlResponder {
  return {
    test: (url) => url === 'https://api.tavily.com/search',
    build: () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  }
}

function bochaResponder(status: number, body: unknown): UrlResponder {
  return {
    test: (url) => url === 'https://api.bochaai.com/v1/web-search',
    build: () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  }
}

/** 构造一个 provider，注入固定的两档状态（不读磁盘）。 */
function makeProvider(tiers: Partial<EdgeWebSearchTiers> = {}) {
  const full: EdgeWebSearchTiers = {
    tavilyEnabled: false,
    tavilyKey: undefined,
    bochaEnabled: false,
    bochaKey: undefined,
    ...tiers,
  }
  return new TavilyBochaFallbackProvider(() => full)
}

// ── A: 档位解析（edge-config 的单一事实源）────────────────────────────

describe('§7.221 — 档位解析（resolveWebSearchTiers / resolveWebSearchAvailability）', () => {
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    savedEnv.TAVILY_API_KEY = process.env.TAVILY_API_KEY
    savedEnv.BOCHA_API_KEY = process.env.BOCHA_API_KEY
    delete process.env.TAVILY_API_KEY
    delete process.env.BOCHA_API_KEY
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it('两档都关 ⇒ 工具不可用', () => {
    const cfg: EdgeConfig = { webSearch: { tavilyEnabled: false, bochaEnabled: false } }
    const av = resolveWebSearchAvailability(cfg)
    assert.equal(av.tavily, false)
    assert.equal(av.bocha, false)
    assert.equal(av.toolAvailable, false)
  })

  it('开关开但没有 key ⇒ 仍不可用（opt-in 的另一半）', () => {
    const cfg: EdgeConfig = { webSearch: { tavilyEnabled: true, bochaEnabled: true } }
    const av = resolveWebSearchAvailability(cfg)
    assert.equal(av.toolAvailable, false)
  })

  it('开关开且配到 key ⇒ 可用', () => {
    const cfg: EdgeConfig = {
      webSearch: { tavilyEnabled: true, bochaEnabled: false },
      secrets: { tavilyApiKey: 'tvly-real' },
    }
    const av = resolveWebSearchAvailability(cfg)
    assert.equal(av.tavily, true)
    assert.equal(av.bocha, false)
    assert.equal(av.toolAvailable, true)
  })

  it('env 兜底：配置里没有 key，但环境变量有 ⇒ 可用', () => {
    process.env.BOCHA_API_KEY = 'sk-bocha-env'
    const cfg: EdgeConfig = { webSearch: { tavilyEnabled: false, bochaEnabled: true } }
    const av = resolveWebSearchAvailability(cfg)
    assert.equal(av.bocha, true)
    assert.equal(av.toolAvailable, true)
  })

  it('配置里的空串**不算**配到 key，且**继续往 env 兜底**', () => {
    // §7.221 统一口径：空串 = 占位 = 未配置。早先聚合器里的
    // `secrets.x ?? env` 会让空串**挡住** env 兜底，与这里不一致。
    process.env.TAVILY_API_KEY = 'tvly-env'
    const cfg: EdgeConfig = {
      webSearch: { tavilyEnabled: true, bochaEnabled: false },
      secrets: { tavilyApiKey: '   ' },
    }
    const tiers = resolveWebSearchTiers(cfg)
    assert.equal(tiers.tavilyKey, 'tvly-env')
    assert.equal(resolveWebSearchAvailability(cfg).toolAvailable, true)
  })

  it('两档的 key 解析口径一致（trim 后非空才算）', () => {
    const cfg: EdgeConfig = {
      webSearch: { tavilyEnabled: true, bochaEnabled: true },
      secrets: { tavilyApiKey: ' tvly ', bochaApiKey: '' },
    }
    const tiers = resolveWebSearchTiers(cfg)
    assert.equal(tiers.tavilyKey, 'tvly')
    assert.equal(tiers.bochaKey, undefined)
  })
})

// ── B: provider 本体 ──────────────────────────────────────────────────

describe('TavilyBochaFallbackProvider（§7.221 两档）', () => {
  beforeEach(() => {
    installFetchMock()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('B1: id 恒为 tavily-bocha-fallback', () => {
    assert.equal(makeProvider().id, TAVILY_BOCHA_PROVIDER_ID)
  })

  it('B2: available() 恒 true —— 改成 false 会让宿主反而把工具露出来', () => {
    // 宿主 seam 的 resolveProvider：available() 为 false ⇒ 选中失败 ⇒
    // selectedProviderReady 对选中失败**答 true** ⇒ 宿主把 web_search 照旧
    // 声明给模型 ⇒ 模型一调就撞结构化错误。这正是本轮要消除的状态。
    assert.equal(makeProvider().available(), true, '两档都关时也必须恒 true')
  })

  it('B3: ready() —— 两档都关 ⇒ false（宿主据此把工具摘掉）', async () => {
    assert.equal(await makeProvider().ready(), false)
  })

  it('B4: ready() —— 任一档「enable 且有 key」⇒ true', async () => {
    assert.equal(await makeProvider({ tavilyEnabled: true, tavilyKey: 'tvly' }).ready(), true)
    assert.equal(await makeProvider({ bochaEnabled: true, bochaKey: 'sk-bocha' }).ready(), true)
  })

  it('B5: ready() —— 开关开但没 key ⇒ false', async () => {
    assert.equal(await makeProvider({ tavilyEnabled: true }).ready(), false)
    assert.equal(await makeProvider({ bochaEnabled: true }).ready(), false)
  })

  it('B6: Tavily 成功 ⇒ 返回 Tavily 结果，不打博查', async () => {
    responderTable = [
      tavilyResponder(200, {
        answer: 'Tavily answer',
        results: [
          { title: 'A', url: 'https://a.example', content: 'A snippet' },
          { title: 'B', url: 'https://b.example', content: 'B snippet' },
        ],
      }),
    ]
    const provider = makeProvider({ tavilyEnabled: true, tavilyKey: 'tvly-fake', bochaEnabled: true, bochaKey: 'sk-bocha-fake' })
    const result = await provider.search({ query: 'q', maxResults: 5 })
    assert.equal(result.content, 'Tavily answer')
    assert.equal(result.sources.length, 2)
    assert.equal(result.sources[0].url, 'https://a.example')
    assert.equal(result.sources[0].title, 'A')
    assert.equal(capturedCalls.length, 1)
    assert.equal(capturedCalls[0].url, 'https://api.tavily.com/search')
  })

  it('B7: Tavily 500 ⇒ 降级到博查（不再有第三档）', async () => {
    responderTable = [
      tavilyResponder(500, 'tavily broken'),
      bochaResponder(200, {
        code: 200,
        data: {
          webPages: { value: [{ name: 'X', url: 'https://x.example', summary: 'X summary' }] },
          summary: '博查 summary',
        },
      }),
    ]
    const provider = makeProvider({ tavilyEnabled: true, tavilyKey: 'tvly-fake', bochaEnabled: true, bochaKey: 'sk-bocha-fake' })
    const result = await provider.search({ query: 'q', maxResults: 5 })
    assert.equal(result.content, '博查 summary')
    assert.equal(result.sources[0].title, 'X')
    assert.equal(capturedCalls.length, 2)
    assert.equal(capturedCalls[0].url, 'https://api.tavily.com/search')
    assert.equal(capturedCalls[1].url, 'https://api.bochaai.com/v1/web-search')
  })

  it('B8: 两档都失败 ⇒ WEB_PROVIDER_UNAVAILABLE（只打两次请求，没有第三档）', async () => {
    responderTable = [
      tavilyResponder(500, 'tavily broken'),
      bochaResponder(500, 'bocha broken'),
    ]
    const provider = makeProvider({ tavilyEnabled: true, tavilyKey: 'tvly-fake', bochaEnabled: true, bochaKey: 'sk-bocha-bad' })
    await assert.rejects(
      () => provider.search({ query: 'q', maxResults: 5 }),
      (err: unknown) => err instanceof WebError && err.code === 'WEB_PROVIDER_UNAVAILABLE',
    )
    assert.equal(capturedCalls.length, 2, '只有两档，不该有第三次请求')
  })

  it('B9: 两档都没配置 ⇒ WEB_PROVIDER_UNAVAILABLE，且一个请求都不发', async () => {
    responderTable = []
    const provider = makeProvider()
    await assert.rejects(
      () => provider.search({ query: 'q', maxResults: 5 }),
      (err: unknown) =>
        err instanceof WebError
        && err.code === 'WEB_PROVIDER_UNAVAILABLE'
        && /own provider's native search/u.test(err.message),
    )
    assert.equal(capturedCalls.length, 0)
  })

  it('B10: 博查 code != 200 ⇒ 当作该档失败', async () => {
    responderTable = [
      bochaResponder(200, { code: 401, msg: 'invalid api key' }),
    ]
    const provider = makeProvider({ bochaEnabled: true, bochaKey: 'sk-bocha-bad' })
    await assert.rejects(
      () => provider.search({ query: 'q' }),
      (err: unknown) => err instanceof WebError && err.code === 'WEB_PROVIDER_UNAVAILABLE',
    )
    assert.equal(capturedCalls.length, 1)
  })

  it('B11: 开关关着的那档不会被调用', async () => {
    responderTable = [
      bochaResponder(200, { code: 200, data: { webPages: { value: [{ url: 'https://b.example' }] } } }),
    ]
    const provider = makeProvider({ bochaEnabled: true, bochaKey: 'sk-bocha-fake' })
    await provider.search({ query: 'q' })
    assert.equal(capturedCalls.length, 1)
    assert.equal(capturedCalls[0].url, 'https://api.bochaai.com/v1/web-search')
  })

  it('B12: maxResults 透传到 Tavily body', async () => {
    responderTable = [
      tavilyResponder(200, { results: [{ title: 'A', url: 'https://a.example', content: 'A' }] }),
    ]
    const provider = makeProvider({ tavilyEnabled: true, tavilyKey: 'tvly-fake' })
    await provider.search({ query: 'q', maxResults: 8 })
    assert.equal(capturedCalls[0].bodyJson?.max_results, 8)
    assert.equal(capturedCalls[0].bodyJson?.query, 'q')
  })

  it('B13: 博查的 datePublished ⇒ publishedAt（§7.221 修的静默丢字段）', async () => {
    responderTable = [
      bochaResponder(200, {
        code: 200,
        data: {
          webPages: {
            value: [{ name: 'N', url: 'https://n.example', datePublished: '2026-11-13' }],
          },
        },
      }),
    ]
    const provider = makeProvider({ bochaEnabled: true, bochaKey: 'sk-bocha-fake' })
    const result = await provider.search({ query: 'q' })
    // WebSearchSource 的字段名是 publishedAt —— 早先这里写的是 datePublished，
    // 而那个字段在类型上不存在 ⇒ 发布日期一直被静默丢弃。
    assert.equal((result.sources[0] as { publishedAt?: string }).publishedAt, '2026-11-13')
    assert.equal((result.sources[0] as { datePublished?: string }).datePublished, undefined)
  })

  it('B14: Tavily 抛异常 ⇒ 博查接续（任何错误都降级）', async () => {
    responderTable = [
      {
        test: (url) => url === 'https://api.tavily.com/search',
        build: () => {
          throw new Error('simulated network failure')
        },
      },
      bochaResponder(200, { code: 200, data: { webPages: { value: [{ url: 'https://b.example', name: 'B' }] } } }),
    ]
    const provider = makeProvider({ tavilyEnabled: true, tavilyKey: 'tvly-fake', bochaEnabled: true, bochaKey: 'sk-bocha-fake' })
    const result = await provider.search({ query: 'q' })
    assert.equal(result.sources.length, 1)
    assert.equal(capturedCalls.length, 2)
  })

  it('B15: 档位状态是**现读**的 —— 改配置后立刻生效', async () => {
    let tiers: EdgeWebSearchTiers = { tavilyEnabled: false, bochaEnabled: false }
    const provider = new TavilyBochaFallbackProvider(() => tiers)
    assert.equal(await provider.ready(), false)
    tiers = { tavilyEnabled: true, tavilyKey: 'tvly', bochaEnabled: false }
    assert.equal(await provider.ready(), true)
  })
})

// ── C: 宿主规则复刻（决定工具可见性的那一跳）──────────────────────────
//
// 下面两个函数是宿主 `@deepseek-ai/dsh-web` 的**最小复刻**（源码见
// `dsh-web/src/index.ts` 的 `resolveProvider` / `selectedProviderReady`），
// 用来证明「provider 的形状」在宿主规则下会得到什么结论。
//
// 宿主 `dsh-tool-web` 的注册条件：
//   `when: ({ modelSelection }) => ctx.web.searchReady(modelSelection.provider)`
// ⇒ searchReady() 为 true ⇒ 工具**声明给模型**；为 false ⇒ 工具被摘掉。

interface HostProvider {
  readonly id: string
  available(): boolean
  ready?(llmProvider: string | undefined): Promise<boolean>
  search(request: { query: string }, signal?: AbortSignal): Promise<unknown>
}

/** 宿主 `resolveProvider` 的复刻（configuredId 钉死的情形）。 */
function hostResolveProvider(configuredId: string, providers: Map<string, HostProvider>): HostProvider {
  const provider = providers.get(configuredId)
  if (!provider) {
    throw new WebError(`configured web provider "${configuredId}" is not registered`, 'WEB_PROVIDER_CONFIGURED_MISSING')
  }
  if (!provider.available()) {
    throw new WebError(`configured web provider "${configuredId}" is registered but unavailable`, 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE')
  }
  return provider
}

/** 宿主 `selectedProviderReady` 的复刻。 */
async function hostSearchReady(configuredId: string, providers: Map<string, HostProvider>): Promise<boolean> {
  let provider: HostProvider
  try {
    provider = hostResolveProvider(configuredId, providers)
  } catch {
    return true // 选中失败 ⇒ 答 true（宿主注释原文）
  }
  return (await provider.ready?.(undefined)) ?? true
}

describe('§7.221 — 宿主规则下的工具可见性', () => {
  it('C1: 两档都关 ⇒ provider 仍被选中、searchReady()=false ⇒ 工具被摘掉', async () => {
    const provider = makeProvider() // 两档都关
    const providers = new Map<string, HostProvider>([[TAVILY_BOCHA_PROVIDER_ID, provider]])
    assert.equal(await hostSearchReady(TAVILY_BOCHA_PROVIDER_ID, providers), false)
  })

  it('C2: 防回归 —— available() 为 false 会让 searchReady() 答 true（工具反而可见）', async () => {
    const broken: HostProvider = {
      id: TAVILY_BOCHA_PROVIDER_ID,
      available: () => false,
      ready: async () => false,
      search: async () => ({}),
    }
    const providers = new Map<string, HostProvider>([[TAVILY_BOCHA_PROVIDER_ID, broken]])
    // 选中失败 ⇒ 宿主答 true ⇒ web_search 照旧声明给模型 ⇒ 模型一调就撞错。
    assert.equal(await hostSearchReady(TAVILY_BOCHA_PROVIDER_ID, providers), true)
    // 这就是为什么本插件的 available() 必须恒 true。
    assert.equal(makeProvider().available(), true)
  })

  it('C3: 两档任一可用 ⇒ searchReady()=true ⇒ 工具照旧可见', async () => {
    const provider = makeProvider({ tavilyEnabled: true, tavilyKey: 'tvly' })
    const providers = new Map<string, HostProvider>([[TAVILY_BOCHA_PROVIDER_ID, provider]])
    assert.equal(await hostSearchReady(TAVILY_BOCHA_PROVIDER_ID, providers), true)
  })

  it('C4: 防回归 —— provider 没注册（id 悬空）也会让工具可见', async () => {
    const providers = new Map<string, HostProvider>()
    assert.equal(await hostSearchReady(TAVILY_BOCHA_PROVIDER_ID, providers), true)
  })
})

// ── D: apply() ────────────────────────────────────────────────────────

describe('apply() —— 恒注册 + 重复注册让位（§7.189）', () => {
  const config = { reserved: {} }

  function makeCtx(register: (p: unknown) => void) {
    const logged: Array<{ level: string; message: string }> = []
    const audited: unknown[] = []
    const ctx = {
      web: { registerSearchProvider: register },
      logger: {
        error: (message: string) => { logged.push({ level: 'error', message }) },
        warn: (message: string) => { logged.push({ level: 'warn', message }) },
        info: (message: string) => { logged.push({ level: 'info', message }) },
      },
      get: (name: string) =>
        name === 'auditLog'
          ? { log: async (entry: unknown) => { audited.push(entry) } }
          : undefined,
    }
    return { ctx: ctx as unknown as Parameters<typeof apply>[0], logged, audited }
  }

  it('D1: 两档都关时**照样注册**（不注册 ⇒ id 悬空 ⇒ 工具反而可见）', async () => {
    let registered = 0
    const { ctx } = makeCtx(() => { registered++ })
    await apply(ctx, config)
    assert.equal(registered, 1, '必须恒注册')
  })

  it('D2: id 已被占用 ⇒ 不抛错，让位，且留下日志与审计痕迹', async () => {
    // 背景（2026-11-11 实测，桌面 App 日志 21:52:38.886）：
    //   ERROR [web-search-tavily-bocha] WebError: a web provider with id
    //     "tavily-bocha-fallback" is already registered
    // 宿主 dsh-agent-preset-registry 的 mountPreset() 里 audit.failed 非空 ⇒
    // 整条 preset 挂载失败 ⇒「边缘模式」从设置页消失。
    const { ctx, logged, audited } = makeCtx(() => {
      throw new WebError(
        `a web provider with id "${TAVILY_BOCHA_PROVIDER_ID}" is already registered`,
        'WEB_DUPLICATE_PROVIDER',
      )
    })
    await assert.doesNotReject(() => apply(ctx, config))
    const errors = logged.filter((l) => l.level === 'error')
    assert.equal(errors.length, 1, '让位必须留下一条日志，不许静悄悄')
    assert.match(errors[0].message, /已被注册/u)
    assert.equal(audited.length, 1, '让位必须留下一条审计记录')
    assert.equal(
      (audited[0] as { kind?: string }).kind,
      'web.search.registration.duplicate',
    )
  })

  it('D3: 别的错误照抛（不吞）', async () => {
    const { ctx } = makeCtx(() => { throw new Error('boom') })
    await assert.rejects(() => apply(ctx, config), /boom/u)
  })

  it('D4: 判定走 err.code，不靠 message 文本（宿主要求）', async () => {
    const { ctx } = makeCtx(() => {
      throw new WebError(
        `a web provider with id "${TAVILY_BOCHA_PROVIDER_ID}" is already registered`,
        'WEB_PROVIDER_UNAVAILABLE',
      )
    })
    await assert.rejects(() => apply(ctx, config))
  })

  it('D5: 不重复时正常注册，且不留让位痕迹', async () => {
    let registered = 0
    const { ctx, logged, audited } = makeCtx(() => { registered++ })
    await apply(ctx, config)
    assert.equal(registered, 1)
    assert.equal(logged.filter((l) => l.level === 'error').length, 0)
    assert.equal(audited.length, 0)
  })
})
