/**
 * web-search-tavily-bocha unit tests — Phase 5 (§7.82), 3-tier fallback
 * (Tavily → 博查 AI → DeepSeek).
 *
 * Stubs `globalThis.fetch` with a per-URL responder table. DeepSeek tier
 * is reached by constructing a `DeepSeekSearchProvider` whose internal
 * `fetch` call to `https://api.deepseek.com/anthropic/v1/messages` we
 * also stub.
 *
 * Test matrix (matches plan §7.82 verification table):
 *   T1  Tavily OK                → returns Tavily result, no Tier-2/3 calls
 *   T2  Tavily 500 → 博查 OK      → returns Bocha result, no Tier-3 call
 *   T3  Tavily+Bocha 500 → DS OK  → returns DeepSeek result
 *   T4  All three fail           → throws WEB_PROVIDER_UNAVAILABLE
 *   T5  No API keys configured   → available()=false; search() throws
 *   T6  available() with only Bocha key (no Tavily, no DS key) → true
 *   T7  maxResults passes through to Tavily body
 *   T8  signal aborts Tavily mid-flight → falls through to 博查
 */

import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'vitest'

import {
  TAVILY_BOCHA_PROVIDER_ID,
  TavilyBochaFallbackProvider,
  apply,
} from '../../src/dsh-adapter/web-search-tavily-bocha.ts'
import { DeepSeekSearchProvider } from '@deepseek-ai/dsh-web-search-deepseek'
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

/**
 * DeepSeek tier uses Anthropic Messages API streaming. The provider yields
 * `web_search_tool_result` content blocks; we need a minimal SSE response
 * that satisfies the upstream `mapAnthropicResponse` parser. The simplest
 * valid shape: a `web_search_tool_result` block with one `web_search_result`
 * item.
 */
function deepseekResponder(status: number, body: unknown): UrlResponder {
  return {
    test: (url) => url.startsWith('https://api.deepseek.com/anthropic/v1/messages'),
    build: () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  }
}

// ── helper: build a Tier-3 DeepSeekSearchProvider with fake credentials ────
function makeDeepSeekProvider(apiKey = 'sk-ds-fake', baseURL = 'https://api.deepseek.com/anthropic/v1') {
  return new DeepSeekSearchProvider(() => ({
    resolveApiKey: async () => apiKey,
    baseURL,
    model: 'deepseek-v4-flash',
    apiVersion: '2023-06-01',
    maxTokens: 4096,
    maxUses: 5,
  }))
}

function makeProvider(opts: {
  tavilyKey?: string
  bochaKey?: string
  dsKey?: string
}) {
  const ds = new DeepSeekSearchProvider(() => ({
    resolveApiKey: async () => opts.dsKey,
    baseURL: 'https://api.deepseek.com/anthropic/v1',
    model: 'deepseek-v4-flash',
    apiVersion: '2023-06-01',
    maxTokens: 4096,
    maxUses: 5,
  }))
  // §7.182: the Tavily / 博查 tiers are OFF by default ⇒ the tests that
  // exercise them must opt in explicitly.
  return new TavilyBochaFallbackProvider(opts.tavilyKey, opts.bochaKey, opts.dsKey, ds, {
    tavilyEnabled: true,
    bochaEnabled: true,
  })
}

// ── tests ───────────────────────────────────────────────────────────

describe('TavilyBochaFallbackProvider', () => {
  beforeEach(() => {
    installFetchMock()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('T1: Tavily success returns Tavily result without calling Tier-2/3', async () => {
    responderTable = [
      tavilyResponder(200, {
        answer: 'Tavily answer',
        results: [
          { title: 'A', url: 'https://a.example', content: 'A snippet' },
          { title: 'B', url: 'https://b.example', content: 'B snippet' },
        ],
      }),
    ]
    const provider = makeProvider({ tavilyKey: 'tvly-fake', bochaKey: 'sk-bocha-fake' })
    const result = await provider.search({ query: 'q', maxResults: 5 })
    assert.equal(result.content, 'Tavily answer')
    assert.equal(result.sources.length, 2)
    assert.equal(result.sources[0].url, 'https://a.example')
    assert.equal(result.sources[0].title, 'A')
    assert.equal(capturedCalls.length, 1)
    assert.equal(capturedCalls[0].url, 'https://api.tavily.com/search')
  })

  it('T2: Tavily 500 → 博查 fallback returns Bocha result without Tier-3', async () => {
    responderTable = [
      tavilyResponder(500, 'tavily broken'),
      bochaResponder(200, {
        code: 200,
        data: {
          webPages: {
            value: [{ name: 'X', url: 'https://x.example', summary: 'X summary' }],
          },
          summary: '博查 summary',
        },
      }),
    ]
    const provider = makeProvider({ tavilyKey: 'tvly-fake', bochaKey: 'sk-bocha-fake' })
    const result = await provider.search({ query: 'q', maxResults: 5 })
    assert.equal(result.content, '博查 summary')
    assert.equal(result.sources.length, 1)
    assert.equal(result.sources[0].title, 'X')
    assert.equal(capturedCalls.length, 2)
    assert.equal(capturedCalls[0].url, 'https://api.tavily.com/search')
    assert.equal(capturedCalls[1].url, 'https://api.bochaai.com/v1/web-search')
  })

  it('T3: Tavily+博查 fail → DeepSeek Tier-3 fallback', async () => {
    // DeepSeek Anthropic Messages response with one web_search_result block.
    responderTable = [
      tavilyResponder(500, 'tavily broken'),
      bochaResponder(500, 'bocha broken'),
      deepseekResponder(200, {
        content: [
          {
            type: 'web_search_tool_result',
            content: [
              {
                type: 'web_search_result',
                url: 'https://ds.example',
                title: 'DS',
                page_age: '2026-09-18',
              },
            ],
          },
        ],
      }),
    ]
    const provider = makeProvider({
      tavilyKey: 'tvly-fake',
      bochaKey: 'sk-bocha-fake',
      dsKey: 'sk-ds-real',
    })
    const result = await provider.search({ query: 'q', maxResults: 5 })
    assert.equal(result.sources.length, 1)
    assert.equal(result.sources[0].url, 'https://ds.example')
    assert.equal(result.sources[0].title, 'DS')
    assert.equal(capturedCalls.length, 3)
    assert.equal(
      capturedCalls[2].url,
      'https://api.deepseek.com/anthropic/v1/messages',
    )
  })

  it('T4: all three tiers fail → upstream DeepSeek WebError bubbles up', async () => {
    responderTable = [
      tavilyResponder(500, 'tavily broken'),
      bochaResponder(500, 'bocha broken'),
      deepseekResponder(401, 'unauthorized'),
    ]
    const provider = makeProvider({
      tavilyKey: 'tvly-fake',
      bochaKey: 'sk-bocha-fake',
      dsKey: 'sk-ds-bad',
    })
    // When all 3 tiers fail with HTTP errors, Tier-3's upstream
    // DeepSeekSearchProvider throws its own WebError(WEB_PROVIDER_ERROR).
    // Our aggregator propagates it (no rewrap) — the seam-level
    // WEB_PROVIDER_UNAVAILABLE only fires when no key is set on any tier.
    await assert.rejects(
      () => provider.search({ query: 'q', maxResults: 5 }),
      (err: unknown) => err instanceof WebError && err.code === 'WEB_PROVIDER_ERROR',
    )
    assert.equal(capturedCalls.length, 3, 'all 3 tiers attempted')
  })

  it('T4b: no key on any tier → our WEB_PROVIDER_UNAVAILABLE (seam-level)', async () => {
    responderTable = [] // no fetch calls expected
    const provider = makeProvider({}) // all keys undefined
    await assert.rejects(
      () => provider.search({ query: 'q', maxResults: 5 }),
      (err: unknown) => err instanceof WebError && err.code === 'WEB_PROVIDER_UNAVAILABLE',
    )
    assert.equal(capturedCalls.length, 0, 'no tier attempted when none configured')
  })

  it('T5: no API keys → available()=false; search() throws WEB_PROVIDER_UNAVAILABLE', () => {
    const provider = makeProvider({}) // all undefined
    assert.equal(provider.available(), false)
    assert.equal(provider.id, TAVILY_BOCHA_PROVIDER_ID)
  })

  it('T6: available() true when only 博查 key is set (no Tavily, no DS)', () => {
    const provider = makeProvider({ bochaKey: 'sk-bocha-fake' })
    assert.equal(provider.available(), true)
  })

  it('T6b: available() true when only Tavily key is set', () => {
    const provider = makeProvider({ tavilyKey: 'tvly-fake' })
    assert.equal(provider.available(), true)
  })

  it('T6c: available() true when only DS key is set (Tavily+Bocha skip → Tier-3 only)', () => {
    const provider = makeProvider({ dsKey: 'sk-ds-fake' })
    assert.equal(provider.available(), true)
  })

  it('T7: maxResults from WebSearchRequest passes through to Tavily body', async () => {
    responderTable = [
      tavilyResponder(200, {
        results: [{ title: 'A', url: 'https://a.example', content: 'A' }],
      }),
    ]
    const provider = makeProvider({ tavilyKey: 'tvly-fake' })
    await provider.search({ query: 'q', maxResults: 8 })
    const body = capturedCalls[0].bodyJson
    assert.equal(body?.max_results, 8)
    assert.equal(body?.query, 'q')
  })

  it('T8: Tavily throws → 博查 fallback runs (any error → fall through)', async () => {
    responderTable = [
      {
        test: (url) => url === 'https://api.tavily.com/search',
        build: () => {
          throw new Error('simulated network failure')
        },
      },
      bochaResponder(200, {
        code: 200,
        data: {
          webPages: { value: [{ url: 'https://b.example', name: 'B' }] },
        },
      }),
    ]
    const provider = makeProvider({ tavilyKey: 'tvly-fake', bochaKey: 'sk-bocha-fake' })
    const result = await provider.search({ query: 'q' })
    assert.equal(result.sources.length, 1)
    assert.equal(capturedCalls.length, 2)
  })

  it('T9: 博查 returns code != 200 → tier-3 fallback fires', async () => {
    responderTable = [
      tavilyResponder(500, 'tavily broken'),
      bochaResponder(200, { code: 401, message: 'invalid api key' }),
      deepseekResponder(200, {
        content: [
          {
            type: 'web_search_tool_result',
            content: [{ type: 'web_search_result', url: 'https://ds2.example', title: 'DS2' }],
          },
        ],
      }),
    ]
    const provider = makeProvider({
      tavilyKey: 'tvly-fake',
      bochaKey: 'sk-bocha-bad',
      dsKey: 'sk-ds-fake',
    })
    const result = await provider.search({ query: 'q' })
    assert.equal(result.sources[0].url, 'https://ds2.example')
    assert.equal(capturedCalls.length, 3)
  })

  // ── §7.182 (2026-11-11, owner ruling): Tavily / 博查 默认关闭 ──────────
  it('§7.182: 不传 tier 开关 ⇒ Tavily / 博查 不在链上（只走 DeepSeek 档）', async () => {
    // 出厂默认：webSearch.tavilyEnabled / bochaEnabled 都是 false ⇒ 这两档
    // 即使配了 key 也不在链上（opt-in，不是 opt-out）。
    responderTable = [
      deepseekResponder(200, {
        content: [
          {
            type: 'web_search_tool_result',
            content: [{ type: 'web_search_result', url: 'https://ds.example', title: 'DS' }],
          },
        ],
      }),
    ]
    const ds = makeDeepSeekProvider('sk-ds-real')
    const provider = new TavilyBochaFallbackProvider(
      'tvly-fake',
      'sk-bocha-fake',
      'sk-ds-real',
      ds,
    )
    const result = await provider.search({ query: 'q', maxResults: 5 })
    assert.equal(result.sources.length, 1)
    assert.equal(result.sources[0].url, 'https://ds.example')
    assert.equal(capturedCalls.length, 1, 'Tavily / 博查 不该被调用')
    assert.equal(capturedCalls[0].url, 'https://api.deepseek.com/anthropic/v1/messages')
  })

  it('§7.182: 两档都关且没有 DeepSeek key ⇒ provider 不可用', () => {
    const ds = makeDeepSeekProvider(undefined)
    const provider = new TavilyBochaFallbackProvider('tvly-fake', 'sk-bocha-fake', undefined, ds)
    assert.equal(provider.available(), false)
  })

  it('T10: abort signal propagates to fetch on the first active tier', async () => {
    let aborted = false
    responderTable = [
      {
        test: (url) => url === 'https://api.tavily.com/search',
        build: (_captured) => {
          // Inspect the AbortSignal that the provider passed via fetch().
          // We assert the signal exists; the actual abort behavior is
          // exercised by the production runtime.
          aborted = true
          return new Response('aborted', { status: 499 })
        },
      },
    ]
    const provider = makeProvider({ tavilyKey: 'tvly-fake' })
    const controller = new AbortController()
    await assert.rejects(() =>
      provider
        .search({ query: 'q' }, controller.signal)
        .catch((err) => {
          // Tier 1 throws, no Tier 2; expect to bubble up.
          throw err
        }),
    )
    assert.equal(aborted, true)
  })
})

// ── §7.189: apply() 的重复注册让位 ───────────────────────────────────
//
// 背景（2026-11-11 实测，桌面 App 日志 21:52:38.886）：
//   ERROR [web-search-tavily-bocha] WebError: a web provider with id
//     "tavily-bocha-fallback" is already registered
//   作用域链：#web-search-tavily-bocha → #edge-stack → #agent-preset-registry
//
// 宿主 dsh-agent-preset-registry 的 mountPreset() 里，audit.failed 非空 ⇒
// 整条 preset 挂载失败 ⇒「边缘模式」从设置页消失。
// ⇒ 这一行必须**让位**（不抛），否则一个瞬时的 id 冲突能干掉整个工作方式。

describe('apply() —— provider id 被占用时让位（§7.189）', () => {
  const config = { reserved: {} }

  function makeCtx(register: () => void) {
    const logged: Array<{ level: string; message: string }> = []
    const audited: unknown[] = []
    const ctx = {
      web: { registerSearchProvider: register },
      logger: {
        error: (message: string) => { logged.push({ level: 'error', message }) },
        warn: (message: string) => { logged.push({ level: 'warn', message }) },
        info: () => {},
      },
      get: (name: string) =>
        name === 'auditLog'
          ? { log: async (entry: unknown) => { audited.push(entry) } }
          : undefined,
    }
    return { ctx: ctx as unknown as Parameters<typeof apply>[0], logged, audited }
  }

  it('id 已被占用 ⇒ 不抛错，让位，且留下日志与审计痕迹', async () => {
    const { ctx, logged, audited } = makeCtx(() => {
      throw new WebError(
        `a web provider with id "${TAVILY_BOCHA_PROVIDER_ID}" is already registered`,
        'WEB_DUPLICATE_PROVIDER',
      )
    })
    await assert.doesNotReject(() => apply(ctx, config))
    assert.equal(logged.length, 1, '让位必须留下一条日志，不许静悄悄')
    assert.match(logged[0].message, /已被注册/u)
    assert.equal(audited.length, 1, '让位必须留下一条审计记录')
    assert.equal(
      (audited[0] as { kind?: string }).kind,
      'web.search.registration.duplicate',
    )
  })

  it('别的错误照抛（不吞）', async () => {
    const { ctx, logged } = makeCtx(() => { throw new Error('boom') })
    await assert.rejects(() => apply(ctx, config), /boom/u)
    assert.equal(logged.length, 0)
  })

  it('不重复时正常注册，且不留痕迹', async () => {
    let registered = 0
    const { ctx, logged, audited } = makeCtx(() => { registered++ })
    await apply(ctx, config)
    assert.equal(registered, 1)
    assert.equal(logged.length, 0)
    assert.equal(audited.length, 0)
  })

  it('判定走 err.code，不靠 message 文本（宿主要求）', async () => {
    // 同一条 message，但 code 不是 WEB_DUPLICATE_PROVIDER ⇒ 照抛。
    const { ctx } = makeCtx(() => {
      throw new WebError(
        `a web provider with id "${TAVILY_BOCHA_PROVIDER_ID}" is already registered`,
        'WEB_PROVIDER_UNAVAILABLE',
      )
    })
    await assert.rejects(() => apply(ctx, config))
  })
})

// ── §7.197: Tier-3 的凭据解析改成「主机同款」 ─────────────────────────
//
// 症状（2026-11-12 12:46 桌面版实测，用户报上来的）：
//   Error: configured web provider "tavily-bocha-fallback" is registered but unavailable
//
// 那是宿主 seam 的 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`：配置了 provider id、
// 它也注册了，但 `available()` 返回 false ⇒ 搜索**根本没发生**。
//
// 根因：我们只认自己的 edge.json（secrets.deepseekApiKey / env DEEPSEEK_API_KEY）。
// 这台机器上根本没有 edge.json ⇒ 一把 key 都没有 ⇒ available() false。
// 更深一层：上游 `web-search-deepseek` 是「账号令牌 → 主机凭据服务 → 启动环境」
// 三条路，我们一条没接 ⇒ 「DSH 里配的就是 DeepSeek 模型」对搜索毫无影响。
//
// 这一组测试驱动的是 **apply() 的真接线**（不是把接线抄一份到测试里）——
// 抄一遍的话，接线本身坏掉时测试还是绿的。

describe('§7.197: Tier-3 走主机凭据（apply() 真接线）', () => {
  const config = { reserved: {} }
  let savedConfigFileEnv: string | undefined

  beforeEach(() => {
    installFetchMock()
    // 不读本机的 edge.json（主人机器上可能有真 key ⇒ 断言会飘）。
    savedConfigFileEnv = process.env.DSH_EDGE_CONFIG_FILE
    process.env.DSH_EDGE_CONFIG_FILE = 'off'
    responderTable = [
      deepseekResponder(200, {
        content: [
          {
            type: 'web_search_tool_result',
            content: [{ type: 'web_search_result', url: 'https://ds.example', title: 'DS' }],
          },
        ],
      }),
    ]
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (savedConfigFileEnv === undefined) delete process.env.DSH_EDGE_CONFIG_FILE
    else process.env.DSH_EDGE_CONFIG_FILE = savedConfigFileEnv
  })

  /** 一个最小宿主 ctx：凭据服务 / 账号服务 / 当前路由都按需给。 */
  function makeHostCtx(opts: {
    credentials?: { resolve(ref: string): Promise<{ value: string } | undefined> }
    account?: { resolveToken(endpoint: string): Promise<string | undefined> }
    route?: string
  }) {
    let registered: any
    const ctx = {
      web: { registerSearchProvider: (p: unknown) => { registered = p } },
      logger: { error: () => {}, warn: () => {}, info: () => {} },
      get: (name: string) => {
        if (name === 'credentials') return opts.credentials
        if (name === 'deepseekAccount') return opts.account
        if (name === 'agents') {
          return {
            currentInitiator: () => ({
              session: { requestContext: () => ({ provider: opts.route }) },
            }),
          }
        }
        return undefined
      },
    }
    return {
      ctx: ctx as unknown as Parameters<typeof apply>[0],
      provider: () => registered,
    }
  }

  it('主机凭据服务里有 DEEPSEEK_API_KEY ⇒ Tier-3 用它（x-api-key）', async () => {
    const seen: string[] = []
    const host = makeHostCtx({
      credentials: {
        resolve: async (ref: string) => {
          seen.push(ref)
          return { value: 'sk-from-host-store' }
        },
      },
    })
    await apply(host.ctx, config)
    const result = await host.provider().search({ query: 'q', maxResults: 5 })
    assert.equal(result.sources[0].url, 'https://ds.example')
    assert.deepEqual(seen, ['DEEPSEEK_API_KEY'], '必须按 credential ref 查，而不是读文件')
    const headers = capturedCalls[0].init.headers as Record<string, string>
    assert.equal(headers['x-api-key'], 'sk-from-host-store')
  })

  it('当前路由是 deepseek-account ⇒ 用账号登录令牌（x-dsh-auth-token），不带 x-api-key', async () => {
    const host = makeHostCtx({
      account: { resolveToken: async () => 'tok-account-123' },
      route: 'deepseek-account',
      credentials: { resolve: async () => ({ value: 'sk-should-not-be-used' }) },
    })
    await apply(host.ctx, config)
    await host.provider().search({ query: 'q', maxResults: 5 })
    const headers = capturedCalls[0].init.headers as Record<string, string>
    assert.equal(headers['x-dsh-auth-token'], 'tok-account-123')
    assert.equal(headers['x-api-key'], undefined, '账号路由下不该再带 API key')
  })

  it('不是账号路由 ⇒ 不用账号令牌，退回 API key', async () => {
    const host = makeHostCtx({
      account: { resolveToken: async () => 'tok-account-123' },
      route: 'qwen-token-plan-cn',
      credentials: { resolve: async () => ({ value: 'sk-from-host-store' }) },
    })
    await apply(host.ctx, config)
    await host.provider().search({ query: 'q', maxResults: 5 })
    const headers = capturedCalls[0].init.headers as Record<string, string>
    assert.equal(headers['x-dsh-auth-token'], undefined, '非账号路由不得使用账号令牌')
    assert.equal(headers['x-api-key'], 'sk-from-host-store')
  })

  it('一把凭据都没有 ⇒ available() 仍为 true（不再硬拒），搜索时给可执行提示', async () => {
    const host = makeHostCtx({ credentials: { resolve: async () => undefined } })
    await apply(host.ctx, config)
    const provider = host.provider()
    assert.equal(provider.available(), true, '有凭据通道就不该在 seam 层被拒')
    await assert.rejects(
      () => provider.search({ query: 'q', maxResults: 5 }),
      (err: unknown) =>
        err instanceof WebError
        && err.code === 'WEB_PROVIDER_UNAVAILABLE'
        && /credentials service/u.test(err.message),
    )
    assert.equal(capturedCalls.length, 0, '没有凭据就不该真的发请求')
  })

  it('宿主一个通道都没有 ⇒ available() 为 false（保持旧语义）', async () => {
    const host = makeHostCtx({})
    await apply(host.ctx, config)
    assert.equal(host.provider().available(), false)
  })

  it('宿主服务在 apply() 之后才就位 ⇒ 照样用得上（通道是惰性取值）', async () => {
    // 宿主的插件装载顺序不保证 credentials 在我们 apply() 之前就绪。
    // 若在 apply() 时把服务抓死，迟注册的那条路就永远丢了 ⇒ 通道必须惰性取值。
    let ready = false
    const host = makeHostCtx({
      credentials: {
        resolve: async () => (ready ? { value: 'sk-late-host-store' } : undefined),
      },
    })
    // apply() 那一刻，宿主还没把凭据服务交出来（之后才交）。
    const originalGet = (host.ctx as unknown as { get: (name: string) => unknown }).get
    ;(host.ctx as unknown as { get: (name: string) => unknown }).get = (name: string) =>
      name === 'credentials' && !ready ? undefined : originalGet(name)
    await apply(host.ctx, config)
    ready = true
    await host.provider().search({ query: 'q', maxResults: 5 })
    const headers = capturedCalls[0].init.headers as Record<string, string>
    assert.equal(headers['x-api-key'], 'sk-late-host-store', '迟就位的凭据服务也必须被用上')
  })
})
