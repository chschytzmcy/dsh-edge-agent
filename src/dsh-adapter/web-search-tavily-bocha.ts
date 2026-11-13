/**
 * web-search-tavily-bocha — Phase 5 (§7.82) 2-tier fallback search provider.
 *
 * ## §7.221 (2026-11-13, owner ruling) —— 去掉 DeepSeek 档，跟随所配置的云端模型
 *
 * 原来这里是**三级链**：Tavily → 博查 AI → **DeepSeek**。第三档是 edge **自己**
 * 造的一个 `DeepSeekSearchProvider` 实例，凭据自己解析（edge.json → 主机凭据
 * 服务 → 启动环境 → 进程环境），于是 edge 侧需要一把 `DEEPSEEK_API_KEY`。
 *
 * 主人的裁决：**去掉 deepseek search**。理由与 `cloud-llm` 那条一致 ——
 * `cloud-llm` 默认是 DELEGATE（转发给**宿主 profile 已配置的模型**），搜索
 * 也该跟着**所配置的云端模型**走，而不是 edge 自己拿一把 key 去调 DeepSeek。
 *
 * ⇒ 本文件现在只有**两档**（Tavily / 博查），两档都**默认关闭**（§7.182）。
 *
 * ⇒ 「两档都没有」时的行为：**工具层 `web_search` 整个不提供** ⇒ 模型只能用
 * 它**自己 provider 的原生搜索**。
 *
 * ## 「不提供」怎么实现（关键机制，踩过的坑都记在这）
 *
 * 宿主 `@deepseek-ai/dsh-tool-web` 注册 `web_search` 时带了一个**按模型步
 * 生效**的条件谓词（宿主 `dsh-tool-web/src/search.ts`）：
 *
 * ```ts
 * ctx.tools.register(defineTool({ name: 'web_search', ... }),
 *   { when: ({ modelSelection }) => ctx.web.searchReady(modelSelection.provider) })
 * ```
 *
 * `when` 的契约（宿主 `dsh-tools/src/contracts.ts`）：
 * `readonly when?: (context) => boolean | Promise<boolean>`，且
 * 「False excludes it from both declarations and dispatch」—— 答 false ⇒ 工具
 * **既不声明给模型、也不可被派发**；宿主给 `web_search` 的那段 system-prompt
 * 指引也一并消失（它读的是 `ctx.tools.get('web_search', scope, toolSet)`）。
 *
 * 而 `ctx.web.searchReady()` 的语义（宿主 `dsh-web/src/index.ts`）是：
 *
 * ```ts
 * async function selectedProviderReady(select, llmProvider) {
 *   let provider
 *   try { provider = select() } catch (_selectionFailure) { return true }
 *   return await provider.ready?.(llmProvider) ?? true
 * }
 * ```
 *
 * ⚠️ **选中失败反而答 true**（宿主注释原话：selection failure answers true,
 * because `search()` reports that failure as a structured `WebError`）。
 *
 * ⇒ 所以「两档都关」**不能**表达成「provider 没注册」或「provider
 * `available()` 为 false」—— 那两种情况宿主 seam 都会**选中失败** ⇒
 * `searchReady()` 答 true ⇒ 工具**照旧可见**，模型一调就撞结构化错误。
 *
 * ⇒ 唯一能让宿主把工具藏起来的形状是：**provider 被正常选中 + `ready()` 答
 * false**。所以本文件：
 *
 *   - **恒注册**（不因两档都关而跳过注册）—— 否则 `web.searchProvider` 这个
 *     钉死的 id 会悬空（`WEB_PROVIDER_CONFIGURED_MISSING`），同样是选中失败。
 *   - `available()` **恒 true** —— 让**选中成功**，宿主才会去问 `ready()`。
 *   - `ready()` 按两档的可用性作答 —— 两档都关 ⇒ false ⇒ 宿主藏起工具。
 *
 * `available()` 恒 true 看起来像谎报，但它的语义只被 `resolveProvider` 消费
 * （"这个 provider 可不可被选中"），而宿主 `listProviders()` 明说
 * 「Availability does not filter the lists」—— 设置页的 provider 列表不受影响。
 *
 * ## 现在的链
 *
 * Provider chain (resolved per call, on `ctx.web`):
 *   1. Tavily  — primary (English/global, AI-tuned results, `tavilyApiKey`)
 *   2. 博查 AI — secondary (Chinese search optimization, `bochaApiKey`)
 *
 * 任一 tier 抛错（HTTP 非 2xx / 网络 / JSON 解析 / AbortError）⇒ 记日志，
 * 下一 tier 接续；两档都失败 ⇒ `WEB_PROVIDER_UNAVAILABLE`。
 *
 * ## 凭据来源（§7.102, 2026-10-21）
 *
 * `config/edge.json` 的 `secrets.tavilyApiKey` / `secrets.bochaApiKey`
 * 优先，`process.env` 的 `TAVILY_API_KEY` / `BOCHA_API_KEY` 兜底。
 * 旧的 flow（repo .env → install.sh `source .env.sh` → process.env）已经没了
 * —— 桌面 GUI 从不 source 它，所以桌面版本来就没有搜索 key。
 *
 * 这条口径由 `edge-config.ts` 的 `resolveWebSearchTiers()` **统一**实现，闸门
 * 侧（`realm-skill-bridge.ts`）走同一个函数 ⇒ 两边不会对「空串 / env 兜底」
 * 出现分叉。
 *
 * ## 为什么用裸名（NOT `DSH_EDGE_*` 前缀）
 *
 * DSH dsh-app-boot 0.1.2-rc.1 的 BOOTSTRAP_PREFIXES =
 * ["DSH_", "XDG_", "DYLD_", "BASH_FUNC_"] 会在 dsh 自己解析 .env 时拒收任何
 * 带这些前缀的 KEY。裸名与那个启动器行为兼容。
 *
 * ## Cordis 集成
 *
 * 注册为**一个** search provider，id = `tavily-bocha-fallback`。
 *
 * @module dsh-edge/dsh-edge-agent/web-search-tavily-bocha
 */

import { WebError, type WebSearchProvider, type WebSearchRequest, type WebSearchResult } from '@deepseek-ai/dsh-web'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { loadEdgeConfig, resolveWebSearchTiers, type EdgeWebSearchTiers } from './edge-config.js'

// ── Endpoints (fixed; these are the only authoritative hosts for each provider) ─────
const TAVILY_ENDPOINT = 'https://api.tavily.com/search'
// 博查 AI web-search endpoint (§7.82.2 修正域名 —— 旧 `api.bocha.cn` 是误传,
// 官方开放平台 docs https://open.bochaai.com 明确指向 `api.bochaai.com`;
// 旧域名持任何 key 都会 403 quota 错误,实际是路由不可达伪装成 quota)。
const BOCHA_ENDPOINT = 'https://api.bochaai.com/v1/web-search'

/** Stable id for `ctx.web.searchProviderId` selection and audit messages. */
export const TAVILY_BOCHA_PROVIDER_ID = 'tavily-bocha-fallback'

/**
 * Cordis plugin name — must match the `id:` row in `cordis.patch.yml`.
 */
export const name = 'web-search-tavily-bocha'

/** Inject `web` (seam) so `ctx.web.registerSearchProvider` is available. */
export const inject = ['web']

/**
 * Config schema. The aggregator is fully config-driven (§7.82), so the schema
 * is intentionally minimal — provided only to satisfy the `verify:plugin-spec`
 * battery. Future work (per-provider rate-limit split, domain whitelist,
 * SafeSearch) can add fields here without touching `apply()`.
 */
export interface Config {
  /** Reserved for future tuning knobs. No-op in v0.1.x. */
  reserved: Record<string, unknown>
}

export const Config: Schema<Config> = Schema.object({
  reserved: Schema.dict(Schema.any()).default({} as Record<string, unknown>),
})

/**
 * Aggregator provider: Tier-1 Tavily → Tier-2 博查.
 * Implements the `WebSearchProvider` interface from `@deepseek-ai/dsh-web`.
 *
 * §7.221: 档位状态**不缓存** —— 每次 `available()` / `ready()` / `search()` 都
 * 现读配置（`loadEdgeConfig(true)` 走 mtime+size 指纹快速路径，没变就只
 * 一次 `statSync`）。这样 provider 的真实状态与闸门侧
 * （`realm-skill-bridge`）读到的永远是同一份快照 ⇒ 不会出现「工具可见但调不
 * 通」或「工具藏了但其实能搜」的裂缝。
 */
export class TavilyBochaFallbackProvider implements WebSearchProvider {
  readonly id = TAVILY_BOCHA_PROVIDER_ID

  /**
   * @param loadTiers - 解析两档（开关 + key）的取数口。默认从 edge 配置读；
   *   测试可注入固定值。
   */
  constructor(
    private readonly loadTiers: () => EdgeWebSearchTiers = () => resolveWebSearchTiers(loadEdgeConfig(true)),
  ) {}

  /** 当前两档的状态（现读，见类注释）。 */
  private get tiers(): EdgeWebSearchTiers {
    return this.loadTiers()
  }

  /** Tavily 档是否真的能打（开关开 **且** 配到了 key）。 */
  private get tavilyReady(): boolean {
    const t = this.tiers
    return t.tavilyEnabled && Boolean(t.tavilyKey)
  }

  /** 博查档是否真的能打（开关开 **且** 配到了 key）。 */
  private get bochaReady(): boolean {
    const t = this.tiers
    return t.bochaEnabled && Boolean(t.bochaKey)
  }

  /**
   * Cheap local availability check; no network calls.
   *
   * §7.221: **恒 true**。
   *
   * ⚠️ 别改成「两档都没关就 false」—— 宿主 seam 的 `resolveProvider` 在
   * `available()` 为 false 时会**选中失败**（`WEB_PROVIDER_CONFIGURED_UNAVAILABLE`），
   * 而 `selectedProviderReady` 对选中失败**答 true** ⇒ 宿主会把 `web_search`
   * **照旧声明给模型**（`when` 谓词答 true）⇒ 模型一调就撞结构化错误，
   * 正是本轮要消除的状态。
   *
   * 真正的「不可用」信号走 `ready()`（见下）。
   */
  available(): boolean {
    return true
  }

  /**
   * §7.221: **宿主闸门（主）** —— 宿主 `dsh-tool-web` 用
   * `when: ({ modelSelection }) => ctx.web.searchReady(modelSelection.provider)`
   * 注册 `web_search`；`searchReady()` 选中成功后才问 provider 的 `ready?.()`。
   *
   * 两档都拿不出 ⇒ 答 **false** ⇒ 宿主把 `web_search` 从**声明**与**派发**
   * 里一并摘掉（连带那段 system-prompt 指引）⇒ 模型看不见工具、也调不到 ⇒
   * 走它**自己 provider 的原生搜索**。
   *
   * @param _llmProvider - 本次模型请求的 provider 路由 id。本聚合器与路由无关
   *   （Tavily / 博查 都是独立凭据），故不参与判定。
   */
  async ready(_llmProvider?: string): Promise<boolean> {
    return this.tavilyReady || this.bochaReady
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const tiers = this.tiers

    // Tier 1 — Tavily
    if (tiers.tavilyEnabled && tiers.tavilyKey) {
      try {
        return await this.searchTavily(request, signal, tiers.tavilyKey)
      } catch (err) {
        // Tier 1 failed; fall through to Tier 2. We log but do not throw —
        // this is the explicit lingguard-style "fail-down" contract.
        console.warn(
          `[web-search-tavily-bocha] Tavily failed, falling through to 博查: ` +
            (err instanceof Error ? err.message : String(err)),
        )
      }
    }

    // Tier 2 — 博查 AI
    if (tiers.bochaEnabled && tiers.bochaKey) {
      try {
        return await this.searchBocha(request, signal, tiers.bochaKey)
      } catch (err) {
        console.warn(
          `[web-search-tavily-bocha] 博查 failed: ` +
            (err instanceof Error ? err.message : String(err)),
        )
      }
    }

    // §7.221: 没有 DeepSeek 兜底了 —— 两档都没成 ⇒ 明确报「不可用」。
    //
    // 走到这里只有两种可能：
    //   (a) 两档都**没配置**（开关开但没 key，或两档都关）—— 正常情况下
    //       宿主不会把工具声明给模型（`ready()` 答 false），但直接调
    //       `ctx.web.search()` 仍可能走到这里；
    //   (b) 两档都配了但**都失败**。
    if (!this.tavilyReady && !this.bochaReady) {
      throw new WebError(
        'web search is unavailable: no Tavily or 博查 AI tier is enabled with a key. '
        + 'Enable one of them in config/edge.json (webSearch.tavilyEnabled / webSearch.bochaEnabled) '
        + 'with its key, or let the model use its own provider\'s native search.',
        'WEB_PROVIDER_UNAVAILABLE',
      )
    }
    throw new WebError(
      'web search is unavailable: neither the Tavily nor the 博查 AI tier succeeded. '
      + 'Enable one of them in config/edge.json (webSearch.tavilyEnabled / webSearch.bochaEnabled) '
      + 'with its key, or let the model use its own provider\'s native search.',
      'WEB_PROVIDER_UNAVAILABLE',
    )
  }

  // ── Tier 1: Tavily ───────────────────────────────────────────────────────
  // API: https://docs.tavily.com/docs/rest-api/api-reference#endpoint-search
  // Body: { api_key, query, max_results, search_depth, include_answer }
  // 200 OK response: { answer?: string, results: [{ title, url, content, score }] }
  private async searchTavily(req: WebSearchRequest, signal: AbortSignal | undefined, apiKey: string): Promise<WebSearchResult> {
    const r = await fetch(TAVILY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query: req.query,
        max_results: req.maxResults ?? 5,
        search_depth: 'basic',
        include_answer: true,
      }),
      signal,
    })
    if (!r.ok) {
      const body = await r.text().catch(() => '')
      throw new Error(`Tavily HTTP ${r.status}: ${body.slice(0, 200)}`)
    }
    const json = (await r.json()) as {
      answer?: string
      results?: Array<{ title?: string; url: string; content?: string }>
    }
    const sources = (json.results ?? [])
      .filter((it) => it.url)
      .map((it) => ({
        url: it.url,
        ...(it.title ? { title: it.title } : {}),
        ...(it.content ? { snippet: it.content } : {}),
      }))
    return {
      ...(json.answer ? { content: json.answer } : {}),
      sources,
      truncated: false,
    }
  }

  // ── Tier 2: 博查 AI ────────────────────────────────────────────────────────
  // API: https://open.bochaai.com(§7.82.2 修正:旧 feishu docx 链接已迁移,权威 spec 在开放平台)
  // Body: { query, count, summary, freshness } —— 4 个字段,无额外必填
  // 200 OK response: { code: 200, msg: null, log_id, data: { _type, queryContext, webPages: { webSearchUrl, totalEstimatedMatches, value: [...] }, images?, videos? } }
  // 错误 response: { code: 4xx, msg: '...', log_id } —— 无 data 字段
  private async searchBocha(req: WebSearchRequest, signal: AbortSignal | undefined, apiKey: string): Promise<WebSearchResult> {
    const r = await fetch(BOCHA_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query: req.query,
        count: req.maxResults ?? 5,
        summary: true,
        freshness: 'noLimit',
      }),
      signal,
    })
    if (!r.ok) {
      const body = await r.text().catch(() => '')
      throw new Error(`博查 HTTP ${r.status}: ${body.slice(0, 200)}`)
    }
    const json = (await r.json()) as {
      code: number
      msg?: string | null
      log_id?: string
      data?: {
        _type?: string
        queryContext?: { originalQuery?: string }
        webPages?: {
          webSearchUrl?: string
          totalEstimatedMatches?: number
          value?: Array<{
            id?: string
            name?: string
            url: string
            displayUrl?: string
            snippet?: string
            summary?: string
            siteName?: string
            datePublished?: string
            dateLastCrawled?: string
          }>
        }
        summary?: string
      }
    }
    if (json.code !== 200) {
      throw new Error(`博查 API code ${json.code}: ${json.msg ?? 'unknown error'} (log_id=${json.log_id ?? 'n/a'})`)
    }
    const pages = json.data?.webPages?.value ?? []
    const sources = pages
      .filter((it) => it.url)
      .map((it) => ({
        url: it.url,
        ...(it.name ? { title: it.name } : {}),
        ...(it.summary ? { snippet: it.summary } : it.snippet ? { snippet: it.snippet } : {}),
        // §7.221: 字段名是 `publishedAt` —— 早先这里写的是 `datePublished`，
        // 而 `WebSearchSource` 没有这个字段 ⇒ 发布日期一直被**静默丢弃**
        // （宿主 `formatSearchOutput` 读的是 `source.publishedAt`）。
        ...(it.datePublished ? { publishedAt: it.datePublished } : {}),
      }))
    return {
      ...(json.data?.summary ? { content: json.data.summary } : {}),
      sources,
      truncated: false,
    }
  }
}

// ── Cordis plugin entry point ───────────────────────────────────────────
/**
 * The dsh loader passes the parent Cordis `ctx` here; `inject: ['web']`
 * guarantees `ctx.web` is non-null. We register one aggregator provider
 * whose id is `tavily-bocha-fallback`.
 *
 * §7.221: **恒注册**。两档都关时不是「不注册」，而是「注册了但 `ready()`
 * 答 false」—— 原因见文件头：宿主 seam 对「选中失败」答 true，那样工具反而
 * 会**照旧可见**给模型。
 *
 * @param ctx - Cordis context with `ctx.web` available per `inject`.
 */
export async function apply(ctx: Context, _config: Config): Promise<void> {
  // §7.102 (2026-10-21): the search keys come from config/edge.json
  // (secrets.tavilyApiKey / secrets.bochaApiKey).
  // The old flow was: repo .env → install.sh `source .env.sh` → process.env
  // → this read. That chain is gone — the desktop GUI never sourced it.
  // Env names stay honoured as a per-process override.
  const provider = new TavilyBochaFallbackProvider()

  // §7.221: 两档都没启用时打一行 info —— 说明「工具层 web_search 会由宿主
  // 按模型步藏起来，搜索跟随所配置的云端模型」。
  void provider.ready().then((usable) => {
    if (usable) return
    ctx.logger?.info?.(
      '[web-search-tavily-bocha] 两档都没启用（Tavily / 博查）⇒ 宿主会在模型步里'
      + '把 web_search 藏起来（provider.ready() = false）；搜索跟随所配置的云端模型'
      + '自带的原生搜索（§7.221）。',
    )
  })

  // The `web` seam is registered by `@deepseek-ai/dsh-tool-web` upstream;
  // it's not part of the stock `Context` interface, so cast narrowly.
  const webCtx = ctx as Context & {
    web: { registerSearchProvider(p: WebSearchProvider): void }
  }
  try {
    webCtx.web.registerSearchProvider(provider)
  } catch (err: any) {
    // §7.189 (2026-11-11): 同一个 id 被占用，**不该**拖垮整条 preset。
    //
    // 实测（桌面 App 日志 2026-11-11 21:52:38.886）：
    //   ERROR [web-search-tavily-bocha] WebError: a web provider with id
    //     "tavily-bocha-fallback" is already registered
    //   作用域链：#web-search-tavily-bocha → #edge-stack →
    //             #agent-preset-registry → #include
    //
    // 这一行失败 ⇒ 宿主 dsh-agent-preset-registry 的 mountPreset() 直接
    // throw（audit.failed 非空 ⇒ 整条 preset 挂载失败）⇒「边缘模式」这个
    // 工作方式从设置页消失 ⇒ 主人看到的症状是「部署了 npm 包，模式里却
    // 没有边缘模式」（2026-11-11 实测）。
    //
    // 触发场景是**热装切换**：桌面端插件管理器把旧副本换成本 npm 包时，
    // 旧实例还没卸载，新实例已经挂上 ⇒ 同一个 id 注册两次。
    //
    // 对策：与 local-llm-adapter / cloud-llm-adapter 同一范式 ——
    // 重复注册时**让位**（不抛），因为 id 是本插件的常量，注册表里已有的那
    // 一个与我们等价（同样的 provider 类、同样的 key 来源）。
    //
    // 判定走 `err.code`：宿主 HarnessError 自带 code 字段，且宿主源码明确
    // 写着「route on this, never by parsing message」（dsh-llm HarnessError）。
    if (err?.code !== 'WEB_DUPLICATE_PROVIDER') throw err
    ctx.logger?.error?.(
      `[web-search-tavily-bocha] provider id "${TAVILY_BOCHA_PROVIDER_ID}" 已被注册 `
      + '（本插件的另一个实例 —— 多半是桌面端热装切换时旧副本尚未卸载）；'
      + '本实例让位，不重复注册。',
    )
    // 让位是「发生了一件事」⇒ 必须留痕，不能静悄悄。
    // auditLog 走**延迟注入**（ctx.get），不写进 inject 数组：inject 是
    // cordis 的硬依赖，声明它等于要求 cordis 等到 auditLog 就绪才起我们
    // 这一行（§7.175/§7.176 的教训：闸门不该因服务次序而缺席）。
    try {
      const auditLog = ctx.get?.('auditLog') as
        | { log?: (entry: unknown) => Promise<unknown> }
        | undefined
      void auditLog?.log?.({
        level: 'warn',
        kind: 'web.search.registration.duplicate',
        source: 'web-search-tavily-bocha',
        payload: {
          providerId: TAVILY_BOCHA_PROVIDER_ID,
          error: String(err?.message ?? err),
        },
      })?.catch?.(() => {})
    } catch {
      // 审计不可用也不影响让位 —— 但日志那一行已经记过，不算静悄悄。
    }
  }
}

export default { name, inject, apply }
