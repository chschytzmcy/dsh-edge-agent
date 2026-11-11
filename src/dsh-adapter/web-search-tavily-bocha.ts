/**
 * web-search-tavily-bocha — Phase 5 (§7.82) 3-tier fallback search provider.
 *
 * Provider chain (resolved per call, on `ctx.web.search`):
 *   1. Tavily        — primary (English/global, AI-tuned results, `tavilyApiKey`)
 *   2. 博查 AI        — secondary (Chinese search optimization, `bochaApiKey`)
 *   3. DeepSeek      — tertiary (re-imports `@deepseek-ai/dsh-web-search-deepseek`,
 *                       uses native `web_search_20250305` server tool on Anthropic
 *                       Messages; final backstop when both Tavily and Bocha fail
 *                       or when neither key is set and only DEEPSEEK_API_KEY is present)
 *
 * Configuration (.env-managed via §7.75 .env.sh source chain — bare names,
 * no DSH_/XDG_/DYLD_/BASH_FUNC_ prefix to bypass dsh-app-boot blacklist):
 *   - TAVILY_API_KEY    (Tier 1) — bare name, lives in repo .env
 *   - BOCHA_API_KEY     (Tier 2) — bare name, lives in repo .env
 *   - DEEPSEEK_API_KEY  (Tier 3 fallback, already required for cloud-llm)
 *   - DEEPSEEK_BASE_URL (optional, default https://api.deepseek.com/anthropic/v1)
 *
 * Where the keys come from (§7.102, 2026-10-21): config/edge.json
 * `secrets.tavilyApiKey` / `secrets.bochaApiKey` / `secrets.deepseekApiKey`.
 * The old flow was: repo .env → install.sh `source .env.sh` → process.env
 * → this read. That chain is gone — the desktop GUI never sourced it, so
 * the desktop build had no search keys at all. The env names below stay
 * honoured as a per-process override.
 *
 * Why bare names (NOT DSH_EDGE_* prefix)?  DSH dsh-app-boot 0.1.2-rc.1's
 * BOOTSTRAP_PREFIXES = ["DSH_", "XDG_", "DYLD_", "BASH_FUNC_"] rejects any
 * DSH_-prefixed KEY in .env files when dsh itself parses them
 * (dsh-app-boot/lib/index.js:933-1015). Bare names stay compatible with
 * that launcher behaviour for the env override path.
 *
 * Cordis integration: registers as a single search provider with id
 * `tavily-bocha-fallback` in `ctx.web`. `available()` returns true iff at
 * least one tier has its key configured — when both Tavily and Bocha keys
 * are missing but DEEPSEEK_API_KEY is set, the aggregator still registers
 * (Tier-3 DeepSeek only), avoiding the seam's `WEB_PROVIDER_UNAVAILABLE`.
 *
 * Fallback semantics mirror lingguard's `internal/tools/web.go` (Tavily →
 * 博查) but extend to a 3rd tier for resilience: any exception from a tier
 * (HTTP non-2xx, malformed JSON, AbortError) is logged and the next tier
 * takes over. Final WebError `WEB_PROVIDER_UNAVAILABLE` only fires when ALL
 * three tiers fail or are unavailable.
 */

import { WebError, type WebSearchProvider, type WebSearchRequest, type WebSearchResult } from '@deepseek-ai/dsh-web'
import { DeepSeekSearchProvider } from '@deepseek-ai/dsh-web-search-deepseek'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { loadEdgeConfig } from './edge-config.js'

// ── Endpoints (fixed; these are the only authoritative hosts for each provider) ─────
const TAVILY_ENDPOINT = 'https://api.tavily.com/search'
// 博查 AI web-search endpoint (§7.82.2 修正域名 —— 旧 `api.bocha.cn` 是误传,
// 官方开放平台 docs https://open.bochaai.com 明确指向 `api.bochaai.com`;
// 旧域名持任何 key 都会 403 quota 错误,实际是路由不可达伪装成 quota)。
const BOCHA_ENDPOINT = 'https://api.bochaai.com/v1/web-search'
const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic/v1'

/** Stable id for `ctx.web.searchProviderId` selection and audit messages. */
export const TAVILY_BOCHA_PROVIDER_ID = 'tavily-bocha-fallback'

/**
 * Cordis plugin name — must match the `id:` row in `cordis.patch.yml`.
 */
export const name = 'web-search-tavily-bocha'

/** Inject `web` (seam) so `ctx.web.registerSearchProvider` is available. */
export const inject = ['web']

/**
 * Config schema. The aggregator is fully env-driven (§7.82: TAVILY_API_KEY
 * / BOCHA_API_KEY / DEEPSEEK_API_KEY — bare names per §7.75), so the schema is
 * intentionally minimal — provided only to satisfy the `verify:plugin-spec`
 * battery. Future Phase 5 work (per-provider rate-limit split, domain
 * whitelist, SafeSearch) can add fields here without touching `apply()`.
 */
export interface Config {
  /** Reserved for future tuning knobs. No-op in v0.1.x. */
  reserved: Record<string, unknown>
}

export const Config: Schema<Config> = Schema.object({
  reserved: Schema.dict(Schema.any()).default({} as Record<string, unknown>),
})

/**
 * Aggregator provider: Tier-1 Tavily → Tier-2 Bocha → Tier-3 DeepSeek.
 * Implements the `WebSearchProvider` interface from `@deepseek-ai/dsh-web`.
 */
export class TavilyBochaFallbackProvider implements WebSearchProvider {
  readonly id = TAVILY_BOCHA_PROVIDER_ID

  constructor(
    private readonly tavilyKey: string | undefined,
    private readonly bochaKey: string | undefined,
    private readonly dsKey: string | undefined,
    private readonly deepseek: DeepSeekSearchProvider,
    /**
     * §7.107 (2026-10-24): per-tier switches. `config/edge.json` has always
     * declared `webSearch.tavilyEnabled` / `bochaEnabled` — and NOTHING read
     * them: the tiers were gated purely on "is the key present". An operator
     * who wanted DeepSeek Search as the backend had no way to say so; every
     * search burned two 401 round-trips on the way down the chain to it.
     * §7.182 (2026-11-11, owner ruling): the shipped default is **OFF** for
     * both tiers ⇒ out of the box only the DeepSeek tier is on the chain.
     * An unset switch therefore means DISABLED (opt-in, not opt-out).
     */
    private readonly tiers: { tavilyEnabled?: boolean; bochaEnabled?: boolean } = {},
  ) {}

  private get tavilyEnabled(): boolean {
    // §7.182: unset = disabled (the shipped default is off).
    return this.tiers.tavilyEnabled === true
  }

  private get bochaEnabled(): boolean {
    // §7.182: unset = disabled (the shipped default is off).
    return this.tiers.bochaEnabled === true
  }

  /**
   * Cheap local availability check; no network calls. Returns true iff any
   * tier can serve — at least one of Tavily/Bocha/DeepSeek key set.
   *
   * We deliberately do NOT delegate to `this.deepseek.available()` because
   * upstream's check returns true whenever a `resolveApiKey` thunk is
   * defined, regardless of whether the resolved key string is empty.
   * Our caller may legitimately invoke us with `dsKey=undefined` (Tiers 1/2
   * only config), so we must check the key string ourselves.
   *
   * When ALL three are unavailable, `ctx.web` will filter us out and the
   * seam will throw `WEB_PROVIDER_UNAVAILABLE` only if no other provider
   * is registered as a fallback. (We always register this row, so an
   * absent-key env is a no-op rather than an error.)
   */
  available(): boolean {
    return Boolean((this.tavilyEnabled && this.tavilyKey) || (this.bochaEnabled && this.bochaKey) || this.dsKey)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    // Tier 1 — Tavily
    if (this.tavilyEnabled && this.tavilyKey) {
      try {
        return await this.searchTavily(request, signal)
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
    if (this.bochaEnabled && this.bochaKey) {
      try {
        return await this.searchBocha(request, signal)
      } catch (err) {
        console.warn(
          `[web-search-tavily-bocha] 博查 failed, falling through to DeepSeek: ` +
            (err instanceof Error ? err.message : String(err)),
        )
      }
    }

    // Tier 3 — DeepSeek (imported provider; uses native server-tool search).
    // We gate on `this.dsKey` directly rather than `this.deepseek.available()`
    // because upstream's available() returns true whenever a `resolveApiKey`
    // thunk is defined, even when it resolves to an empty string.
    if (this.dsKey) {
      return await this.deepseek.search(request, signal)
    }

    // All tiers failed or unavailable.
    throw new WebError(
      'all web search providers failed or none configured ' +
        '(set TAVILY_API_KEY / BOCHA_API_KEY / DEEPSEEK_API_KEY in .env)',
      'WEB_PROVIDER_UNAVAILABLE',
    )
  }

  // ── Tier 1: Tavily ───────────────────────────────────────────────────────
  // API: https://docs.tavily.com/docs/rest-api/api-reference#endpoint-search
  // Body: { api_key, query, max_results, search_depth, include_answer }
  // 200 OK response: { answer?: string, results: [{ title, url, content, score }] }
  private async searchTavily(req: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const r = await fetch(TAVILY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: this.tavilyKey,
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
  private async searchBocha(req: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const r = await fetch(BOCHA_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.bochaKey}`,
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
        ...(it.datePublished ? { datePublished: it.datePublished } : {}),
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
 * The Tier-3 DeepSeek provider is constructed (not registered) so we can
 * invoke its `search()` directly inside our Tier-3 fallback path. The
 * upstream `web-search-deepseek` plugin row is kept enabled in
 * `cordis.patch.yml` so its `registerSearchProvider('deepseek-official')`
 * also fires — but DSH's seam then sees TWO registered search providers
 * (ours + deepseek-official) and would throw `WEB_PROVIDER_AMBIGUOUS`.
 *
 * To avoid that, the cordis.patch.yml disables `web-search-deepseek` when
 * `web-search-tavily-bocha` is enabled; the Tier-3 fallback inside the
 * aggregator reaches the same DeepSeek HTTP endpoint by holding a private
 * `DeepSeekSearchProvider` instance, so we never lose the backstop.
 *
 * @param ctx - Cordis context with `ctx.web` available per `inject`.
 */
export async function apply(ctx: Context, _config: Config): Promise<void> {
  // §7.102 (2026-10-21): the search keys come from config/edge.json
  // (secrets.tavilyApiKey / secrets.bochaApiKey / secrets.deepseekApiKey).
  // The old flow was: repo .env → install.sh `source .env.sh` → process.env
  // → this read. That chain is gone — the desktop GUI never sourced it.
  // Env names stay honoured as a per-process override.
  const cfg = loadEdgeConfig(true)
  const secrets = cfg.secrets ?? {}
  const tavilyKey = (secrets.tavilyApiKey ?? process.env.TAVILY_API_KEY)?.trim() || undefined
  const bochaKey = (secrets.bochaApiKey ?? process.env.BOCHA_API_KEY)?.trim() || undefined
  const dsKey = (secrets.deepseekApiKey ?? process.env.DEEPSEEK_API_KEY)?.trim() || undefined
  const dsBaseURL = process.env.DEEPSEEK_BASE_URL?.trim() || DEEPSEEK_DEFAULT_BASE_URL

  // Construct upstream DeepSeek provider for Tier-3 fallback. We bypass its
  // settings-section / credential-ref machinery because we read env vars
  // ourselves (consistent with `local-llm-adapter` pattern). The provider
  // class is stateless across calls — re-reading env on each `search()`.
  const dsProvider = new DeepSeekSearchProvider(() => ({
    resolveApiKey: async () => dsKey,
    baseURL: dsBaseURL,
    model: 'deepseek-v4-flash',
    apiVersion: '2023-06-01',
    maxTokens: 4096,
    maxUses: 5,
  }))

  const provider = new TavilyBochaFallbackProvider(tavilyKey, bochaKey, dsKey, dsProvider, {
    // §7.107: the per-tier switches, finally read. §7.182: default =
    // disabled ⇒ an unset config keeps only the DeepSeek tier on the chain.
    tavilyEnabled: cfg.webSearch?.tavilyEnabled,
    bochaEnabled: cfg.webSearch?.bochaEnabled,
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
