/**
 * web-search-guard — Phase 5 monitoring guard for `@deepseek-ai/dsh-tool-web`.
 *
 * DSH ships a native `web_search` / `web_fetch` tool pair (registered by
 * `@deepseek-ai/dsh-tool-web`). The actual search runs server-side via
 * `@deepseek-ai/dsh-web-search-deepseek`, which hits DeepSeek's
 * Anthropic-compatible `/messages` endpoint with the `web_search_20250305`
 * server tool. dsh-edge-agent owns the *security* layer, not the tool
 * implementation (see `docs/dsh-native-tools-analysis.md` §6).
 *
 * This guard sits on the `tools/result` observer hook (registered upstream by
 * `@deepseek-ai/dsh-tools` — `notifyResult` at `dsh-tools/lib/index.js:3272`).
 * It does NOT block execution — `tools/result` is intentionally observe-only
 * per the DSH pipeline contract — and serves three purposes:
 *
 *   1. **PII-leak monitor (task #38).** When the LLM emits a `web_search`
 *      tool_call, we re-sanitize the `query` string through
 *      `ctx.sanitizer.sanitize(query)` and compare. If the result differs from
 *      the input, the LLM bypassed the upstream sanitizer and shipped raw PII
 *      (a phone, an id-card, an email) to DeepSeek's search endpoint — we
 *      emit a `security` audit event so the operator can investigate. We do
 *      NOT block the call: blocking would force the model into a
 *      nondeterministic retry loop, and the audit trail already captures the
 *      leak for offline review.
 *
 *   2. **Tool audit event (task #39).** Every successful `web_search` /
 *      `web_fetch` invocation logs an `info`-level audit entry with the
 *      sanitized query, result count, and duration. The argument payload
 *      goes through `redactObject` (from `pii-utils.ts`) as belt-and-braces
 *      redaction in case step 1 missed something.
 *
 *   3. **Rate-limit (task #40).** In-memory sliding-window counters cap
 *      `web_search` to 10 calls/min and `web_fetch` to 5 calls/min. Phase 5
 *      deliberately keeps this in-process (no persistence); the persistent
 *      token-meter already shipped by DSH (`@deepseek-ai/dsh-tools` upstream)
 *      is the long-term home — wiring it in is M5+ work. The guard is a
 *      safety net, not the policy of record.
 *
 * Why a separate plugin rather than a guard inside `tools.ts`?
 *   `tools.ts` is the realm registry (`setRealm` / `filterTools`). The
 *   security monitoring here is orthogonal: realm decides *whether* the
 *   tool runs, this guard decides *what to log* when it runs. Splitting
 *   them keeps each plugin's contract crisp and lets us disable monitoring
 *   independently of realm isolation in tests.
 *
 * @module dsh-edge-agent/web-search-guard
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { redactObject as redactObjectImpl } from './pii-utils.js'

/**
 * Strip PII patterns from arbitrary object payloads and return just the
 * redacted structure. `pii-utils.redactObject` returns `{redacted, count}`;
 * we want the redacted value here so audit payloads carry clean data.
 */
function redactPayload<T>(obj: T): T {
  return redactObjectImpl(obj).redacted
}

export const name = 'web-search-guard'

export const inject = ['tools', 'sanitizer', 'auditLog'] as const

/**
 * Tool names this guard monitors. Aligned with the realm tags wired in
 * `tools.ts` (`DSH_NATIVE_REALM_MAP`). Adding a new tool here without a
 * matching entry in that map is a configuration error — the realm gate
 * would let the tool through under any verdict.
 */
const MONITORED_TOOLS = new Set(['web_search', 'web_fetch'])

/**
 * Per-tool call budgets inside a 60-second sliding window. Phase 5
 * chooses conservative defaults to keep model-driven runaway search
 * loops from amplifying cost / latency.
 */
const RATE_LIMITS: Readonly<Record<string, number>> = {
  web_search: 10,
  web_fetch: 5,
}

const WINDOW_MS = 60_000

export interface Config {
  /** Enable PII-leak detection. Disable only for tests / benchmarks. */
  enablePIIMonitor: boolean
  /** Enable tool-call audit logging. */
  enableAudit: boolean
  /** Enable in-process rate-limit. */
  enableRateLimit: boolean
  /** Override per-tool rate limits. */
  rateLimits: Record<string, number>
}

export const Config: Schema<Config> = Schema.object({
  enablePIIMonitor: Schema.boolean().default(true),
  enableAudit: Schema.boolean().default(true),
  enableRateLimit: Schema.boolean().default(true),
  rateLimits: Schema.dict(Schema.number()).default({}),
})

/** Tool execution view (from `tools/result` event). Kept structural so
 *  we don't depend on a `@deepseek-ai/dsh-tools` type that may shift
 *  across rc versions. */
interface ToolExecView {
  readonly name: string
  readonly callId?: string
  readonly arguments?: unknown
  readonly agent?: unknown
}

interface ToolResultView {
  readonly isError?: boolean
  readonly value?: unknown
}

interface AuditLike {
  log(entry: {
    level: 'debug' | 'info' | 'warn' | 'error' | 'security'
    kind: string
    source: string
    payload: Record<string, unknown>
  }): Promise<unknown>
}

interface SanitizerLike {
  sanitize(
    text: string,
    context?: { sessionId?: string },
  ): Promise<{ sanitizedText: string; replacements: Array<{ original: string; placeholder: string; piiType: string }> }>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    webSearchGuard: WebSearchGuardService
  }
}

/**
 * Sliding-window counter for a single tool name. Stores per-call
 * timestamps so we can evict entries older than `WINDOW_MS`.
 */
class WindowCounter {
  private timestamps: number[] = []
  constructor(private readonly limit: number) {}
  /** Record a hit. Returns true when within budget, false when over. */
  hit(now: number): boolean {
    const cutoff = now - WINDOW_MS
    while (this.timestamps.length > 0 && this.timestamps[0] < cutoff) {
      this.timestamps.shift()
    }
    if (this.timestamps.length >= this.limit) return false
    this.timestamps.push(now)
    return true
  }
  /** Reset the window. Useful when an external quota system takes over. */
  reset(): void {
    this.timestamps = []
  }
}

/**
 * Live service exposed on `ctx.webSearchGuard`. Allows runtime inspection
 * of the rate-limit state and lets tests reset counters between cases.
 */
export class WebSearchGuardService extends Service {
  private readonly counters = new Map<string, WindowCounter>()
  private readonly enablePIIMonitor: boolean
  private readonly enableAudit: boolean
  private readonly enableRateLimit: boolean
  private readonly rateLimitOverrides: Record<string, number>
  private audit: AuditLike | undefined
  private sanitizer: SanitizerLike | undefined

  constructor(ctx: Context, config?: Partial<Config>) {
    super(ctx, 'webSearchGuard')
    this.enablePIIMonitor = config?.enablePIIMonitor ?? true
    this.enableAudit = config?.enableAudit ?? true
    this.enableRateLimit = config?.enableRateLimit ?? true
    this.rateLimitOverrides = config?.rateLimits ?? {}
  }

  /** Wire to ctx services after construction. Split from the constructor so
   *  the Service base class doesn't have to thread the deps. */
  attach(audit: AuditLike | undefined, sanitizer: SanitizerLike | undefined): void {
    this.audit = audit
    this.sanitizer = sanitizer
  }

  /** Effective rate limit for a tool, applying overrides on top of defaults. */
  limitFor(toolName: string): number {
    return this.rateLimitOverrides[toolName] ?? RATE_LIMITS[toolName] ?? Number.POSITIVE_INFINITY
  }

  /** Currently used count for `toolName` inside the sliding window. */
  used(toolName: string): number {
    return this.counters.get(toolName)?.['timestamps'].length ?? 0
  }

  /** Reset every counter. Test-only API; not exposed to production callers. */
  resetCounters(): void {
    for (const counter of this.counters.values()) counter.reset()
  }

  /**
   * Rate-limit gate. Returns true when the call is within budget; the caller
   * should consult this BEFORE dispatching the tool, not after — `tools/result`
   * fires post-dispatch, so it is too late for the gate there. This method
   * exists so a future caller (e.g. `tools/pre-execute` waterfall listener)
   * can integrate the budget; today it is a passive recorder.
   */
  recordHit(toolName: string, now = Date.now()): boolean {
    if (!this.enableRateLimit) return true
    const limit = this.limitFor(toolName)
    let counter = this.counters.get(toolName)
    if (counter === undefined) {
      counter = new WindowCounter(limit)
      this.counters.set(toolName, counter)
    }
    return counter.hit(now)
  }
}

export async function apply(ctx: Context, config: Config): Promise<() => Promise<void>> {
  const service = new WebSearchGuardService(ctx, config)
  // Resolve injected services. Cordis's Service base provides `get` only
  // after the loader has wired dependents, so we walk the ctx explicitly.
  const audit = (ctx as unknown as { auditLog?: AuditLike }).auditLog
  const sanitizer = (ctx as unknown as { sanitizer?: SanitizerLike }).sanitizer
  service.attach(audit, sanitizer)

  // ── tools/pre-execute waterfall gate (§7.37 defense-in-depth) ──────────
  // Hard invariant: web_search / web_fetch (cloud-only tools, hit DeepSeek
  // Anthropic-compatible endpoint) MUST NOT run under a local-* provider.
  // input-guard's §7.35 may downgrade CLOUD → LOCAL on a key miss; if that
  // downgrade is wrong (false positive) we still refuse here so the LLM
  // never actually fires a request. Without this hook, a misclassified
  // CLOUD intent lands on local-llm, which still has web_search in
  // its tool list (tools are global), and qwen wastes DeepSeek API quota
  // on a task the local model can't usefully answer.
  //
  // Mechanism: dsh-tools runs `ctx.waterfall("tools/pre-execute", exec,
  // () => allow)` before each tool dispatch — see
  // @deepseek-ai/dsh-tools/lib/index.js:3098. A listener returning
  // `{kind: 'deny', reason}` short-circuits the dispatch.
  type GateDecision = { kind: 'allow' } | { kind: 'deny'; reason: string }
  type PreExecuteListener = (
    exec: ToolExecView & { agent?: { config?: { provider?: string }; session?: { config?: { provider?: string } } } },
    next: () => Promise<GateDecision>,
  ) => Promise<GateDecision>
  const onToolsPreExecute = (async (exec, next) => {
    if (!MONITORED_TOOLS.has(exec.name)) return next()
    const provider =
      (exec as { agent?: { session?: { config?: { provider?: string } } } }).agent?.session?.config?.provider ??
      (exec as { agent?: { config?: { provider?: string } } }).agent?.config?.provider
    if (typeof provider === 'string' && provider.startsWith('local-')) {
      await audit?.log({
        level: 'security',
        kind: 'web-search-guard.blocked-local-provider',
        source: 'web-search-guard',
        payload: {
          toolName: exec.name,
          callId: exec.callId,
          provider,
          args: redactPayload((exec.arguments ?? {}) as Record<string, unknown>),
        },
      })
      return { kind: 'deny', reason: `web-search blocked: provider=${provider} (cloud-only tool, must run on cloud-* provider)` }
    }
    return next()
  }) as PreExecuteListener

  // ── tools/result observer ────────────────────────────────────────────────
  // DSH dsh-tools emits this AFTER the canonical outcome is materialized
  // (see `notifyResult` in dsh-tools/lib/index.js:3272). The event is
  // observe-only — we cannot block or replace the outcome from here. We
  // log; downstream policy decides what to do.
  type ResultListener = (exec: ToolExecView, result: ToolResultView) => unknown
  const onToolsResult = ((exec: ToolExecView, result: ToolResultView) => {
    if (!MONITORED_TOOLS.has(exec.name)) return
    void handleToolsResult(service, exec, result).catch((err) => {
      // Observer errors must never break the tool pipeline — DSH swallows
      // them after logging. Match that contract.
      audit?.log({
        level: 'error',
        kind: 'web-search-guard.observer-error',
        source: 'web-search-guard',
        payload: {
          toolName: exec.name,
          callId: exec.callId,
          error: err instanceof Error ? err.message : String(err),
        },
      }).catch(() => {})
    })
  }) as ResultListener

  const ctxWithOn = ctx as unknown as {
    on?: (event: string, fn: (...args: any[]) => any, opts?: Record<string, unknown>) => () => void | Promise<void>
  }
  // tools/pre-execute is a *waterfall* (see dsh-tools/lib/index.js:3098), so
  // the listener must be registered with `{ global: true }` to survive
  // per-session scope bindings. Without `global`, the gate is invisible to
  // tools dispatched under agent session scopes and §7.37 never fires.
  const disposePre = ctxWithOn.on?.('tools/pre-execute', onToolsPreExecute, { global: true })
  const disposeOn = ctxWithOn.on?.('tools/result', onToolsResult)

  // ── tools/change: refresh rate-limit counters when tools come and go ──
  // We do not create counters lazily — `recordHit` does — so this is a
  // no-op today. Kept as a hook point for future per-agent overrides.
  // DIAGNOSTIC (Phase 5 v2): log every tool registration so E2E boot scan
  // can see whether web_search / web_fetch actually register at all.
  let seenNames = new Set<string>()
  const onToolsChange = (): void => {
    try {
      const t = (ctx as unknown as { tools?: { view?: () => { entries?: () => Iterable<[string, unknown]> } } }).tools
      const view = t?.view?.()
      const entries = view?.entries ? Array.from(view.entries()) : []
      const fresh = entries.filter(([n]) => !seenNames.has(n))
      if (fresh.length > 0) {
        const names = fresh.map(([n]) => n).join(', ')
        ctx.logger?.info?.(`[web-search-guard] tools/change +${fresh.length}: ${names}`)
        fresh.forEach(([n]) => seenNames.add(n))
        ctx.logger?.info?.(`[web-search-guard] total registered: ${seenNames.size} (${Array.from(seenNames).join(', ')})`)
      }
    } catch (err) {
      ctx.logger?.warn?.(`[web-search-guard] tools/change read error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  // Fire once on apply to catch tools already registered.
  ctx.logger?.info?.('[web-search-guard] apply() called, registering tools/pre-execute + tools/change + tools/result listeners')
  setImmediate(onToolsChange)
  const disposeChange = ctxWithOn.on?.('tools/change', onToolsChange)

  return async () => {
    await disposePre?.()
    await disposeOn?.()
    await disposeChange?.()
  }
}

/**
 * Handle one `tools/result` event for a monitored tool. Split into its own
 * function so tests can call it directly with a fabricated exec/result pair.
 *
 * Exported so the test suite (and any future tooling that wants to replay
 * a captured `tools/result` event) can drive the pipeline without spinning
 * up a full Cordis context.
 */
export async function handleToolsResult(
  service: WebSearchGuardService,
  exec: ToolExecView,
  result: ToolResultView,
): Promise<void> {
  // Self-contained tool filter — the observer wrapper in `apply()` already
  // gates on `MONITORED_TOOLS`, but exported callers (tests, future replay
  // tooling) bypass that wrapper. Re-check here so the function is safe
  // to call directly.
  if (!MONITORED_TOOLS.has(exec.name)) return

  const start = Date.now()
  const args = (exec.arguments ?? {}) as Record<string, unknown>
  const query = typeof args.query === 'string' ? args.query : ''

  // Record the hit (for future budget enforcement). Today's pipeline cannot
  // gate on this; the post-execute observer fires too late. We still record
  // so external dashboards can see the live rate.
  const withinBudget = service.recordHit(exec.name, start)

  // ── PII-leak monitor ─────────────────────────────────────────────────────
  if (service['enablePIIMonitor'] && service['sanitizer'] && query.length > 0) {
    const { sanitizedText, replacements } = await service['sanitizer'].sanitize(query, {
      sessionId: 'web-search-guard',
    })
    if (sanitizedText !== query || replacements.length > 0) {
      await service['audit']?.log({
        level: 'security',
        kind: 'web-search-guard.pii-leak',
        source: 'web-search-guard',
        payload: {
          toolName: exec.name,
          callId: exec.callId,
          queryLength: query.length,
          replacements: replacements.map((r) => ({ piiType: r.piiType, placeholder: r.placeholder })),
          // The full sanitized query is intentionally NOT included — the
          // point is to alert on the leak, not to log raw PII. Operators
          // see the placeholder mapping and replay from session logs.
        },
      })
    }
  }

  // ── Tool audit event ─────────────────────────────────────────────────────
  if (service['enableAudit']) {
    // redactPayload strips known PII from arbitrary object payloads as a
    // belt-and-braces redaction in case `args.query` slipped past the
    // monitor above (e.g. a brand-new PII type not in the policy yet).
    const redactedArgs = redactPayload(args)
    const resultCount = Array.isArray(result.value)
      ? result.value.length
      : typeof result.value === 'object' && result.value !== null && 'results' in result.value
        ? Array.isArray((result.value as { results?: unknown }).results)
          ? (result.value as { results: unknown[] }).results.length
          : undefined
        : undefined
    await service['audit']?.log({
      level: 'info',
      kind: 'tool.web-search.executed',
      source: 'web-search-guard',
      payload: {
        toolName: exec.name,
        callId: exec.callId,
        isError: result.isError === true,
        withinBudget,
        used: service.used(exec.name),
        limit: service.limitFor(exec.name),
        resultCount,
        args: redactedArgs,
        durationMs: Date.now() - start,
      },
    })
  }

  // ── Rate-limit alarm ─────────────────────────────────────────────────────
  // The hit was already recorded; if we are AT or OVER the budget, log a
  // warning. Future work (M5+) wires this to `ctx.tools.guard()` to deny
  // pre-execute when over budget. For Phase 5 it is a soft alarm.
  if (service['enableRateLimit'] && !withinBudget) {
    await service['audit']?.log({
      level: 'warn',
      kind: 'web-search-guard.rate-limit-exceeded',
      source: 'web-search-guard',
      payload: {
        toolName: exec.name,
        used: service.used(exec.name),
        limit: service.limitFor(exec.name),
      },
    })
  }
}
