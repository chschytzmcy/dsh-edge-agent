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
 * Why bare names (NOT DSH_EDGE_* prefix)?  DSH dsh-app-boot 0.1.2-rc.1's
 * BOOTSTRAP_PREFIXES = ["DSH_", "XDG_", "DYLD_", "BASH_FUNC_"] rejects any
 * DSH_-prefixed KEY in .env files when dsh itself parses them
 * (dsh-app-boot/lib/index.js:933-1015). Our install.sh source chain
 * (`source .env.sh` → `set -a; . .env; set +a`) exports bare names BEFORE
 * dsh launches — they reach the plugin via process.env. Naming them with
 * the `DSH_EDGE_` prefix would either be silently ignored or rejected by
 * the launcher if anyone ever copied them into a dsh-loaded file. Bare
 * names align with §7.75 (`EDGE_API_KEY`, `DEEPSEEK_API_KEY`, etc.) so all
 * secrets sit in one .env.
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

// ── Endpoints (fixed; these are the only authoritative hosts for each provider) ─────
const TAVILY_ENDPOINT = 'https://api.tavily.com/search'
const BOCHA_ENDPOINT = 'https://api.bocha.cn/v1/web-search'
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
  ) {}

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
    return Boolean(this.tavilyKey || this.bochaKey || this.dsKey)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    // Tier 1 — Tavily
    if (this.tavilyKey) {
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
    if (this.bochaKey) {
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
  // API: https://bocha-ai.feishu.cn/docx/Uf4md5j4VoOùkxOkrlcZ03Wnse (web-search endpoint)
  // Body: { query, count, summary, freshness, searchMode }
  // 200 OK response: { code: 200, data: { webPages: { value: [...] }, summary? } }
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
      message?: string
      data?: {
        webPages?: { value?: Array<{ name?: string; url: string; snippet?: string; summary?: string }> }
        summary?: string
      }
    }
    if (json.code !== 200) {
      throw new Error(`博查 API code ${json.code}: ${json.message ?? 'unknown error'}`)
    }
    const sources = (json.data?.webPages?.value ?? [])
      .filter((it) => it.url)
      .map((it) => ({
        url: it.url,
        ...(it.name ? { title: it.name } : {}),
        ...(it.summary ? { snippet: it.summary } : it.snippet ? { snippet: it.snippet } : {}),
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
  // Read from bare env names — flow path:
  //   repo .env (TAVILY_API_KEY=...)  →  install.sh `source .env.sh`
  //                                    →  .env.sh `set -a; . .env; set +a`
  //                                    →  process.env.TAVILY_API_KEY
  //                                    →  this read in plugin.apply()
  // §7.75 design: all secrets sit in one .env, no DSH_/XDG_/DYLD_/BASH_FUNC_
  // prefix (would trip dsh-app-boot's bootstrap-only whitelist).
  const tavilyKey = process.env.TAVILY_API_KEY?.trim() || undefined
  const bochaKey = process.env.BOCHA_API_KEY?.trim() || undefined
  const dsKey = process.env.DEEPSEEK_API_KEY?.trim() || undefined
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

  const provider = new TavilyBochaFallbackProvider(tavilyKey, bochaKey, dsKey, dsProvider)
  // The `web` seam is registered by `@deepseek-ai/dsh-tool-web` upstream;
  // it's not part of the stock `Context` interface, so cast narrowly.
  const webCtx = ctx as Context & {
    web: { registerSearchProvider(p: WebSearchProvider): void }
  }
  webCtx.web.registerSearchProvider(provider)
}

export default { name, inject, apply }
