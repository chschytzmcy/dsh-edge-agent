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
 *
 * §7.197 (2026-11-12): Tier-3 的凭据解析改成**与上游同款**（主机凭据服务 +
 * DeepSeek 账号登录），不再只认我们自己的 edge.json。
 *
 * 症状（桌面版实测 2026-11-12 12:46）：`web_search` 报
 *   `Error: configured web provider "tavily-bocha-fallback" is registered but unavailable`
 * 那是宿主 seam 的 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`（dsh-web
 * `resolveProvider()`：配置了 provider id、注册了，但 `available()` 为 false）。
 *
 * 根因两层：
 *   1. `available()` 只认「我们自己的」三样东西：edge.json 的
 *      `secrets.tavilyApiKey` / `bochaApiKey` / `deepseekApiKey`（或同名 env）。
 *      而这台机器上**根本没有 edge.json**（仓库、已装包、`~/.dsh-edge-agent/`
 *      都没有）⇒ 三样全空 ⇒ `available()` false ⇒ seam 直接拒绝，搜索根本没发生。
 *   2. 更深一层：就算有 edge.json，我们的 Tier-3 也**只认我们自己的 key** ——
 *      上游 `web-search-deepseek` 是「账号令牌（仅 `deepseek-account` 路由）
 *      → 主机凭据服务 `ctx.credentials.resolve('DEEPSEEK_API_KEY')`
 *      → 启动环境」三条路，我们一条都没接。
 *      ⇒ 主人「我在 DSH 里配的就是 DeepSeek 模型，应该直接能用 deepseek search」
 *      这个预期，被我们的实现挡在了门外：**模型是 DeepSeek 的，搜索却用不上
 *      DeepSeek 的凭据**。
 *
 * 修法：Tier-3 的凭据解析按上游的顺序来 ——
 *   ① DeepSeek 账号令牌（仅当当前会话的 provider 路由是 `deepseek-account`）
 *   ② 我们自己的 edge.json `secrets.deepseekApiKey`（操作者显式配置优先）
 *   ③ 主机凭据服务 `ctx.credentials.resolve('DEEPSEEK_API_KEY')`
 *   ④ 启动环境 `launchEnvironmentOf(ctx).get('DEEPSEEK_API_KEY')`
 *   ⑤ 进程环境 `DEEPSEEK_API_KEY`
 * 并且 `available()` 不再拿「此刻有没有 key」当硬门槛（凭据解析是**异步且按路由**
 * 的，同步判据做不到）—— 改成判「有没有凭据通道」。
 */

import { WebError, type WebSearchProvider, type WebSearchRequest, type WebSearchResult } from '@deepseek-ai/dsh-web'
import { DeepSeekSearchProvider } from '@deepseek-ai/dsh-web-search-deepseek'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
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

/**
 * 宿主把「DeepSeek 账号」当作 provider 路由注册时的 id（上游
 * `web-search-deepseek` 的 `ACCOUNT_PROVIDER`）。只有当前会话走这条路由，
 * 搜索才用账号登录（`x-dsh-auth-token`）而不是 API key。
 */
export const DEEPSEEK_ACCOUNT_PROVIDER = 'deepseek-account'

/** 凭据引用的名字（上游 `web-search-deepseek` 的 `apiKeyEnv` 默认值）。 */
const DEEPSEEK_API_KEY_REF = 'DEEPSEEK_API_KEY'

/**
 * 主机侧的**凭据通道**（§7.197）。
 *
 * 这三个通道都不是我们能自己造出来的，只能从宿主服务里拿：
 *   - `credentials`：宿主凭据服务（`ctx.credentials`）—— 桌面端「Web search」
 *     设置页写进去的 key 就在这里；
 *   - `launchEnv`：启动环境快照（`launchEnvironmentOf(ctx)`）—— 启动器导出的 env；
 *   - `account`：DeepSeek 账号服务（`ctx.deepseekAccount`）—— 账号登录令牌。
 *
 * 全部可选：宿主没提供就退回到我们自己的 edge.json / 进程环境。
 *
 * ⚠️ 三个通道都是**惰性取值**（返回函数的引用，而不是服务本身）：
 * 宿主的插件装载顺序不保证「credentials / deepseekAccount 在我们 apply() 之前
 * 就已就位」⇒ 在 apply() 时把服务抓死，迟注册的那条路就永远丢了。
 * 上游 `web-search-deepseek` 也是**每次搜索**才 `ctx.get(...)` 的。
 */
export interface DeepSeekCredentialPlane {
  /** 宿主凭据服务：`resolve(ref)` → `{ value }`。 */
  credentials?: () => { resolve(ref: ReturnType<typeof credentialRef>): Promise<{ value: string } | undefined> } | undefined
  /** 启动环境快照：`get(name)` → `{ value }`。 */
  launchEnv?: () => { get(name: string): { value: string } | undefined } | undefined
  /** DeepSeek 账号服务：`resolveToken(endpoint)` → 令牌字符串。 */
  account?: () => { resolveToken(endpoint: string): Promise<string | undefined> } | undefined
  /** 当前会话的 provider 路由（判断是不是 `deepseek-account`）。 */
  routeProvider?: () => string | undefined
}

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
    /**
     * §7.197: 主机侧凭据通道。用来做两件事 ——
     *   1. `available()`：判断「有没有凭据通道」（而不是「此刻有没有 key」）；
     *   2. Tier-3 的凭据解析（见 `apply()` 里造的 upstream provider thunk）。
     */
    private readonly credentialPlane: DeepSeekCredentialPlane = {},
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
   * Cheap local availability check; no network calls.
   *
   * §7.197: 判据从「此刻有没有 key」改成「**有没有凭据通道**」。
   *
   * 为什么不能继续用「此刻有没有 key」：Tier-3 的凭据解析是**异步且按路由**
   * 的 —— 账号令牌只有当当前会话走 `deepseek-account` 路由时才存在，而
   * `available()` 是同步方法、拿不到路由。拿「此刻没 key」当硬门槛的后果是
   * 宿主 seam 在**搜索还没发生**时就拒绝（`WEB_PROVIDER_CONFIGURED_UNAVAILABLE`），
   * 主人看到的只是一句「registered but unavailable」，既不知道该配什么，
   * 也不知道「用 DeepSeek 账号模型就能搜」。
   *
   * 真正的凭据判定发生在搜索时（上游同款）：解析不到就抛
   * `WEB_PROVIDER_CREDENTIAL_MISSING`（我们翻译成自己的可执行提示）。
   */
  available(): boolean {
    if ((this.tavilyEnabled && this.tavilyKey) || (this.bochaEnabled && this.bochaKey)) return true
    if (this.dsKey) return true
    const plane = this.credentialPlane
    // 主机凭据服务 / DeepSeek 账号服务：解析是**异步**的 ⇒ 只能判「有没有这个通道」。
    // 少了它们，账号模型与主机凭据里的 key 就永远轮不到（§7.197 的主因）。
    if (plane.credentials?.() || plane.account?.()) return true
    // 启动环境是**同步**的 ⇒ 直接判那把 key 在不在。
    // 注意 `launchEnvironmentOf(ctx)` 永远返回一个快照（process.env 兜底），
    // 所以不能拿「快照存在」当判据 —— 那样 available() 恒为 true。
    const fromLaunchEnv = plane.launchEnv?.()?.get(DEEPSEEK_API_KEY_REF)?.value?.trim()
    return Boolean(fromLaunchEnv)
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
    //
    // §7.197: 凭据解析交给 upstream provider 自己做（账号令牌 → API key，
    // 顺序与上游 `web-search-deepseek` 一致，见 `apply()` 里的 thunk）。
    // 我们只在**一个凭据都没有**时把它翻译成自己的提示 —— 上游抛的是
    // `WEB_PROVIDER_CREDENTIAL_MISSING`，那句话里的修复路径是上游插件的
    // 配置项，对本仓的操作者不适用。
    try {
      return await this.deepseek.search(request, signal)
    } catch (err) {
      if (err instanceof WebError && err.code === 'WEB_PROVIDER_CREDENTIAL_MISSING') {
        throw new WebError(
          'no web search credential is available: DeepSeek tier needs a credential, and none of the '
          + 'four sources has one (config/edge.json secrets.deepseekApiKey / the host credentials '
          + 'service (DEEPSEEK_API_KEY) / the launch environment / the DeepSeek account sign-in)',
          'WEB_PROVIDER_UNAVAILABLE',
          { cause: err },
        )
      }
      throw err
    }
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
/**
 * 当前会话的 provider 路由（上游 `web-search-deepseek` 同款：
 * `ctx.agents.currentInitiator()?.session.requestContext()?.provider`）。
 *
 * 只有它是 `deepseek-account` 时，搜索才用账号登录令牌。拿不到就返回
 * undefined（⇒ 不走账号令牌）—— 拿不到不是错误，只是「这条路没有凭据」。
 */
function currentRouteProvider(ctx: Context): string | undefined {
  try {
    const agents = ctx.get('agents') as
      | { currentInitiator?: () => { session?: { requestContext?: () => { provider?: string } } } | undefined }
      | undefined
    const route = agents?.currentInitiator?.()?.session?.requestContext?.()?.provider
    return typeof route === 'string' ? route : undefined
  } catch {
    return undefined
  }
}

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

  // ── §7.197: 主机侧凭据通道 ────────────────────────────────────────────
  //
  // 上游 `web-search-deepseek` 是这样解析凭据的（已从 app.asar 里核对源码）：
  //   ① 账号令牌 —— 仅当当前会话的 provider 路由是 `deepseek-account`，
  //      令牌由 `ctx.deepseekAccount.resolveToken(endpoint)` 给；
  //   ② API key —— `ctx.credentials.resolve('DEEPSEEK_API_KEY')`，
  //      拿不到再退到启动环境 `launchEnvironmentOf(ctx)`。
  //
  // 我们原来一条都没接（只读自己的 edge.json），所以「DSH 里配的就是 DeepSeek
  // 模型」这件事，对搜索没有任何影响 —— 模型是 DeepSeek 的，搜索却用不上
  // DeepSeek 的凭据。现在按上游同款接上。
  const plane: DeepSeekCredentialPlane = {
    credentials: () => ctx.get('credentials') as
      | { resolve(ref: ReturnType<typeof credentialRef>): Promise<{ value: string } | undefined> }
      | undefined,
    launchEnv: () => launchEnvironmentOf(ctx),
    account: () => ctx.get('deepseekAccount') as
      | { resolveToken(endpoint: string): Promise<string | undefined> }
      | undefined,
    routeProvider: () => currentRouteProvider(ctx),
  }

  // Construct upstream DeepSeek provider for Tier-3 fallback. The provider
  // class is stateless across calls — credentials are resolved per search.
  //
  // §7.197: `resolveAccountToken` / `resolveApiKey` 现在是**主机同款**的两条路：
  // 账号令牌优先（且只在账号路由上），API key 依次是
  // 我们自己的 edge.json → 主机凭据服务 → 启动环境 → 进程环境。
  const dsProvider = new DeepSeekSearchProvider(() => ({
    resolveAccountToken: async (endpoint: string) => {
      if (plane.routeProvider?.() !== DEEPSEEK_ACCOUNT_PROVIDER) return undefined
      const token = await plane.account?.()?.resolveToken(endpoint)
      return token && token.length > 0 ? token : undefined
    },
    resolveApiKey: async () => {
      if (dsKey) return dsKey
      const fromCredentials = await plane.credentials?.()?.resolve(credentialRef(DEEPSEEK_API_KEY_REF))
      const credentialValue = fromCredentials?.value?.trim()
      if (credentialValue) return credentialValue
      const fromLaunchEnv = plane.launchEnv?.()?.get(DEEPSEEK_API_KEY_REF)?.value?.trim()
      if (fromLaunchEnv) return fromLaunchEnv
      return process.env.DEEPSEEK_API_KEY
    },
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
  }, plane)
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
