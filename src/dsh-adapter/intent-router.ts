/**
 * intent-router — LLM-based intent classification.
 *
 * Uses the local Qwen3-4B (via ctx.llm) to classify user messages as
 * LOCAL (file ops, device control, calculations) or CLOUD (knowledge,
 * chat, creative tasks). Falls back to keyword rules when the LLM
 * call fails (timeout, network error, unclear response).
 *
 * @module dsh-edge-agent/intent-router
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'intent-router'

export const inject = ['llm', 'auditLog'] as const

/** Minimal interface our router needs from the audit-log service. */
interface AuditLike {
  log(entry: { level: 'debug' | 'info' | 'warn' | 'error' | 'security'; kind: string; source: string; payload: Record<string, unknown> }): Promise<unknown>
}

export interface Config {
  /** Default realm when classification finds no rule. */
  defaultCategory: 'LOCAL' | 'CLOUD' | 'SANITIZED'
  /** Provider to use for intent classification. */
  classificationProvider: string
  /** Model id passed alongside `classificationProvider`. */
  classificationModel: string
  /** Minimum confidence the LLM must express to be trusted.
   *  Below this value, the router falls back to keyword rules
   *  (fail-open, not REJECT — see Phase B plan). */
  confidenceThreshold: number
  /** Hard cap on a single classify() LLM call. The AbortController fires
   *  this many ms after the stream starts; on timeout the call throws
   *  and the caller falls through to the keyword/default path (fail-open).
   *  Default 4000ms; env DSH_EDGE_INTENT_LLM_TIMEOUT_MS overrides. */
  llmTimeoutMs?: number
  /** Max number of recent messages to embed as multi-turn context.
   *  0 disables context. Default 3. */
  recentMessagesLimit?: number
  /** Hard cap on input text length. Past this, the router truncates the
   *  prompt input and audits `intent.classify.truncated`. Default 2000;
   *  env DSH_EDGE_INTENT_MAX_INPUT overrides. Defense-in-depth against
   *  pathologically long prompts overwhelming qwen3-4b. */
  maxInputLength?: number
  /** Last-resort LOCAL-keyword list used only when privacy-policy is absent
   *  or has no matching rule. Default ships EN + CN. Override via env
   *  DSH_EDGE_INTENT_FALLBACK_KEYWORDS (comma-separated) to add JA / KO /
   *  ES / domain-specific terms without editing source. Replaces the
   *  built-in list entirely when set. */
  fallbackKeywords?: string[]
  /** §7.47 (2026-09-12): CLOUD-keyword list matched BEFORE fallbackKeywords.
   *  Catches queries that obviously need web/search/online info (新闻/news/
   *  搜索/search/latest/最新/today/今天) and routes them to cloud LLM +
   *  web tools — without waiting for the LLM classifier (which can hang
   *  on Qwen3-4B). Default ships EN + CN built-in list. Override via env
   *  DSH_EDGE_INTENT_CLOUD_KEYWORDS (comma-sep) — appended to built-in. */
  cloudKeywords?: string[]
  /** §7.58 (2026-09-16): LOCAL-entity list (密盒/ets/etscli built-in)
   *  matched before every keyword layer and used to override a non-LOCAL
   *  LLM verdict. Env DSH_EDGE_INTENT_LOCAL_ENTITIES (comma-sep) appends to
   *  built-in (NOT replaces), same semantics as cloudKeywords. */
  localEntities?: string[]
  /** §7.92.3 (2026-09-23): jev HTTP intent recognizer (port 8001). Toggle
   *  — default OFF (opt-in). When ON, jev runs BEFORE the LLM classifier
   *  and short-circuits high-confidence / low-risk verdicts. See
   *  ~/work/jev-branch/docs/api_reference.md for the upstream contract.
   *  Env DSH_EDGE_INTENT_JEV_ENABLED (literal 'true' activates). */
  jevEnabled?: boolean
  /** §7.92.3: jev base URL. Env DSH_EDGE_INTENT_JEV_URL. */
  jevUrl?: string
  /** §7.92.3: jev HTTP timeout in ms. Env DSH_EDGE_INTENT_JEV_TIMEOUT_MS. */
  jevTimeoutMs?: number
  /** §7.92.3: minimum jev confidence to adopt. Below → fall through to
   *  LLM. Env DSH_EDGE_INTENT_JEV_CONFIDENCE_THRESHOLD. */
  jevConfidenceThreshold?: number
  /** §7.92.3: jev risk_score gate (≥ this value → REJECT). Env
   *  DSH_EDGE_INTENT_JEV_RISK_THRESHOLD. */
  jevRiskThreshold?: number
  /** §7.92.3: jev intent → realm mapping table. EXTENDS the built-in
   *  default (does not replace). Env DSH_EDGE_INTENT_JEV_INTENT_MAP as a
   *  JSON object string, e.g. `{"订单查询":"SANITIZED","refund":"CLOUD"}`. */
  jevIntentMap?: Record<string, 'LOCAL' | 'CLOUD' | 'SANITIZED'>
}

export const Config: Schema<Config> = Schema.object({
  defaultCategory: Schema.union(['LOCAL', 'CLOUD', 'SANITIZED'] as const)
    // 2026-09-02: changed from 'CLOUD' to 'SANITIZED'. Old default failed open
    // — ambiguous requests went straight to CLOUD LLM (raw data egress). With
    // SANITIZED, the input-guard sanitizer-pipeline runs first; sanitize
    // failure triggers input-guard.sanitize.downgraded → LOCAL (fail-closed).
    .default('SANITIZED'),
  classificationProvider: Schema.string().default('local-llm'),
  classificationModel: Schema.string().default('qwen3-4b'),
  // confidenceThreshold is a 0..1 probability, NOT an integer. Pre-fix used
  // Schema.natural() which validates as "integer multiple of 1" — runtime
  // values like 0.6 (the actual default and the DSH_EDGE_INTENT_CONFIDENCE_
  // THRESHOLD env value) were rejected at loader stage:
  //   $.confidenceThreshold expected number multiple of 1 but got 0.6
  confidenceThreshold: Schema.number().min(0).max(1).default(0.6),
  llmTimeoutMs: Schema.natural().default(4000),
  recentMessagesLimit: Schema.natural().default(3),
  maxInputLength: Schema.natural().default(2000),
  fallbackKeywords: Schema.array(Schema.string()).default([] as string[]),
  cloudKeywords: Schema.array(Schema.string()).default([] as string[]),
  localEntities: Schema.array(Schema.string()).default([] as string[]),
  // §7.92.3 (2026-09-23): jev HTTP intent recognizer. Toggle defaults
  // OFF — opt-in per §7.75 .env discipline ("不允许 ${VAR:-default}",
  // operators explicitly turn features on). When ON, jev runs BEFORE the
  // LLM classifier; failures fall through to LLM (no behavior change for
  // any path that doesn't go through jev).
  jevEnabled: Schema.boolean().default(false),
  jevUrl: Schema.string().default('http://127.0.0.1:8001'),
  // 2.5s = comfortably above jev's documented P95 (< 300ms) with headroom
  // for cold-start model load + inter-container network jitter. Smaller
  // than `llmTimeoutMs` (default 4-30s) so jev-as-prefilter still saves
  // the operator's overall chat budget on jev-failure paths.
  jevTimeoutMs: Schema.natural().default(2500),
  // Mirrors jev's built-in `execute` gate (>= 0.85). Operators tune lower
  // (e.g. 0.70) to trade more jev-adopts for higher mis-route risk.
  jevConfidenceThreshold: Schema.number().min(0).max(1).default(0.85),
  // Mirrors jev's built-in risk-score gate (>= 0.7 → clarify → REJECT).
  jevRiskThreshold: Schema.number().min(0).max(1).default(0.7),
  // Map of jev's intent strings (config/intents.yaml on the jev side) to
  // realm. EXTENDS built-in JEV_INTENT_MAP_DEFAULT — operators can
  // override built-in entries with their own.
  jevIntentMap: Schema.dict(Schema.union(['LOCAL', 'CLOUD', 'SANITIZED'] as const))
    .default({} as Record<string, 'LOCAL' | 'CLOUD' | 'SANITIZED'>),
})

export interface Intent {
  category: 'LOCAL' | 'CLOUD' | 'SANITIZED' | 'REJECT'
  confidence: number
  targetRealm: string
  rationale: string
}

export interface IntentRouterService {
  classify(text: string, context?: { recentMessages?: unknown[]; sessionId?: string }): Promise<Intent>
  resolve(intent: Intent): { realm: string; config: Record<string, unknown> }
  /** Snapshot of in-memory counters. O(1) read for ops dashboards. */
  getStats(): IntentRouterStats
}

/** Built-in last-resort LOCAL keyword list (EN + CN). Used only when
 *  privacy-policy is absent / empty AND `config.fallbackKeywords` is unset.
 *  Users override via env `DSH_EDGE_INTENT_FALLBACK_KEYWORDS` (comma-sep). */
const LOCAL_KEYWORDS_DEFAULT: readonly string[] = [
  '文件', '读', '写', '删除', '创建', '计算', '加减乘除',
  '本地', '设备', '系统', '磁盘', '目录', '文件夹',
  'file', 'read', 'write', 'delete', 'calculate', 'compute',
  'local', 'device', 'disk', 'directory', 'folder',
]

/** §7.47 (2026-09-12): Built-in CLOUD keyword list. Matched BEFORE
 *  fallbackKeywords in classifyWithRules so queries that obviously need
 *  web/search (新闻 / news / 最新 / latest / 今天 / today / 实时 / live /
 *  趋势 / trend / 排行榜 / ranking) go straight to CLOUD, without
 *  depending on the LLM classifier (which can hang on Qwen3-4B).
 *  Users extend via env `DSH_EDGE_INTENT_CLOUD_KEYWORDS` (comma-sep) —
 *  appended to built-in (NOT replaced). Lower priority than privacy-policy
 *  rules (which can REJECT) but higher than fallbackKeywords (which is
 *  LOCAL-only).
 *  §7.58 (2026-09-16): bare query VERBS (搜索/查询/查找/搜/查, search) were
 *  REMOVED from the built-in list. A verb is a query *action*, not an
 *  online-object signal — it fires on local questions too ("查询密盒登录状态"
 *  was mis-routed CLOUD by `rule-cloud-keyword:查询`, 2026-09-15 incident;
 *  any "检查一下设备" trips the single-char "查"). Verb-only queries now fall
 *  through to the LOCAL keyword list → defaultCategory (fail-closed,
 *  SANITIZED), with the LLM classifier (when alive) doing the nuanced
 *  work. Online OBJECT nouns (新闻/最新/热搜/news/latest/…) stay as-is. */
const CLOUD_KEYWORDS_DEFAULT: readonly string[] = [
  // 中文: 信息获取类信号词（§7.58: 只留对象/时间名词，不留裸动词）
  '新闻', '最新', '今天', '今日', '实时', '热搜', '趋势', '排行榜',
  '资讯', '动态', '进展', '消息',
  '网上', '互联网', '在线',
  // English: information-acquisition signals
  'news', 'latest', 'today', 'live', 'trending', 'ranking',
  'online', 'internet', 'web search', 'web',
]

/** §7.58 (2026-09-16): product/device entities that physically live behind
 *  LOCAL skills only (realm table: ets-* = LOCAL). Matched FIRST in
 *  classifyWithRules — above CLOUD strong keywords and the generic LOCAL
 *  fallback — and re-checked as a deterministic override after an
 *  LLM-classified non-LOCAL verdict (the qwen classifier answered CLOUD
 *  conf=1 for "查询共登陆了几个密盒": it cannot know which realms own
 *  which resources). CJK entries match as substrings; ASCII entries match
 *  with word boundaries so 'ets' cannot fire inside "assets". Extend via
 *  env `DSH_EDGE_INTENT_LOCAL_ENTITIES` (comma-sep) — appended to
 *  built-in, same semantics as cloudKeywords. */
const LOCAL_ENTITY_KEYWORDS_DEFAULT: readonly string[] = [
  '密盒', 'ets', 'etscli',
]

/** §7.92.3 (2026-09-23): built-in jev intent-string → realm mapping.
 *  Used by classifyWithJev() when `data.intent` is set + `data.action ===
 *  'execute'` + `confidence ≥ jevConfidenceThreshold`. Operators extend
 *  (and can override individual keys) via env `INTENT_JEV_INTENT_MAP` as
 *  JSON, e.g. `{"订单查询":"SANITIZED","refund":"CLOUD"}`. Lookup is
 *  exact-string match on the jev-side `intent` field.
 *
 *  Mapping rationale (per api_reference.md §3.3 + design-v6 §4.3):
 *  - 订单查询/物流跟踪/退款申请/账户管理/客服/订单状态/物流查询 → SANITIZED
 *    (these touch PII like order id, address, payment status — must run
 *    through input-guard sanitizer before any LLM sees them; the actual
 *    order data lives behind LOCAL skills though, so the post-sanitize
 *    path routes to the LOCAL realm if applicable — but the realm set
 *    here is the classifier verdict, not the post-sanitize routing).
 *    Operators who want direct LOCAL routing can override these to LOCAL.
 *  - 投诉/法务咨询/法律咨询 → REJECT (high-risk, audit security).
 *  - 闲聊/其他 → fallback_llm (handled in classifyWithJev, NOT here —
 *    these never reach this lookup).
 *  - 知识问答/通用咨询/天气/翻译/闲聊助手 → CLOUD (clear online tasks).
 *
 *  NOTE: 闲聊 / 其他 / null are EXCLUDED — classifyWithJev short-circuits
 *  these as `action: 'skip'` (fall through to LLM) BEFORE consulting this
 *  map. Other intents not listed here fall through too (defensive: if jev
 *  returns an intent string we don't recognize, LLM classifier handles it). */
const JEV_INTENT_MAP_DEFAULT: Readonly<Record<string, 'LOCAL' | 'CLOUD' | 'SANITIZED' | 'REJECT'>> = {
  // ── SANITIZED: PII-likely business intents (must sanitize before cloud) ──
  '订单查询': 'SANITIZED',
  '订单状态': 'SANITIZED',
  '物流跟踪': 'SANITIZED',
  '物流查询': 'SANITIZED',
  '快递查询': 'SANITIZED',
  '退款申请': 'SANITIZED',
  '退款查询': 'SANITIZED',
  '账户管理': 'SANITIZED',
  '账户余额': 'SANITIZED',
  '账户信息': 'SANITIZED',
  '客服': 'SANITIZED',
  '售后服务': 'SANITIZED',
  'order_inquiry': 'SANITIZED',
  'refund': 'SANITIZED',
  'refund_request': 'SANITIZED',
  'logistics': 'SANITIZED',
  'account': 'SANITIZED',
  'customer_service': 'SANITIZED',
  // ── REJECT: high-risk / sensitive intents (security-level audit) ──
  '投诉': 'REJECT',
  '法务咨询': 'REJECT',
  '法律咨询': 'REJECT',
  '举报': 'REJECT',
  'complaint': 'REJECT',
  'legal': 'REJECT',
  'legal_advice': 'REJECT',
  // ── CLOUD: clear online / knowledge tasks ──
  '知识问答': 'CLOUD',
  '通用咨询': 'CLOUD',
  '天气': 'CLOUD',
  '翻译': 'CLOUD',
  '新闻': 'CLOUD',
  '搜索': 'CLOUD',
  'knowledge': 'CLOUD',
  'weather': 'CLOUD',
  'translation': 'CLOUD',
  'news': 'CLOUD',
  'search': 'CLOUD',
  // ── LOCAL: clear device-bound tasks (rare from jev — usually an entity) ──
  '设备控制': 'LOCAL',
  '文件操作': 'LOCAL',
  'device_control': 'LOCAL',
  'file_ops': 'LOCAL',
}

export class IntentRouterServiceImpl extends Service {
  private readonly defaultCategory: Intent['category']
  private readonly classificationProvider: string
  private readonly classificationModel: string
  private readonly confidenceThreshold: number
  private readonly llmTimeoutMs: number
  private readonly recentMessagesLimit: number
  private readonly maxInputLength: number
  private readonly fallbackKeywords: readonly string[]
  /** §7.47 (2026-09-12): CLOUD keyword list, merged with built-in defaults.
   *  Matched in classifyWithRules BEFORE fallbackKeywords. */
  private readonly cloudKeywords: readonly string[]
  /** §7.58 (2026-09-16): LOCAL-entity list, merged with built-in defaults.
   *  Checked FIRST in classifyWithRules + as LLM-verdict override guardrail. */
  private readonly localEntities: readonly string[]
  /** §7.92.3 (2026-09-23): jev HTTP intent recognizer (toggle). When
   *  true, classify() invokes classifyWithJev() BEFORE classifyWithLlm(). */
  private readonly jevEnabled: boolean
  /** §7.92.3: jev base URL, e.g. `http://127.0.0.1:8001`. */
  private readonly jevUrl: string
  /** §7.92.3: jev fetch timeout (ms). */
  private readonly jevTimeoutMs: number
  /** §7.92.3: min jev confidence to adopt (else fall through to LLM). */
  private readonly jevConfidenceThreshold: number
  /** §7.92.3: jev risk_score gate (>= this → REJECT). */
  private readonly jevRiskThreshold: number
  /** §7.92.3: jev intent → realm map (merged with built-in defaults).
   *  User config OVERRIDES built-in entries with the same key. */
  private readonly jevIntentMap: Record<string, 'LOCAL' | 'CLOUD' | 'SANITIZED' | 'REJECT'>
  private readonly llm: any
  private readonly auditLog: AuditLike | undefined
  private readonly stats: IntentRouterStats = {
    total: 0,
    empty: 0,
    truncated: 0,
    llmHit: 0,
    ruleHit: 0,
    defaultHit: 0,
    lowConfidence: 0,
    timeout: 0,
    llmError: 0,
    /** P1: LLM stream returned text that parseClassificationVerdict could
     *  not turn into a verdict (all three tiers failed). Distinct from
     *  `llmError` (network / timeout) so operators can see the parse
     *  health of the LLM independently from the transport health. */
    parseFailure: 0,
    rejected: 0,
    sanitized: 0,
    sanitizeError: 0,
    sanitizeSkipped: 0,
    /** §7.92.3 (2026-09-23): jev prefilter counters. jevHit = adopted
     *  (path: jev-adopt), jevReject = risk-gated REJECT, jevSkip = fell
     *  through to LLM (low-conf / fallback_llm / unrecognized intent),
     *  jevError = transport / parse failure (also fell through), jevTimeout
     *  = subset of jevError where AbortSignal fired. Operators compare
     *  jevHit / total to gauge the latency savings of the toggle. */
    jevHit: 0,
    jevReject: 0,
    jevSkip: 0,
    jevError: 0,
    jevTimeout: 0,
    /** §7.92.3: cumulative jev fetch latency in ms (response.latency_ms).
     *  Used to compute average jev latency in ops dashboards without
     *  parsing JSONL. Reset on restart. */
    jevLatencyMsTotal: 0,
    /** G9: 10-bucket histogram of LLM confidence values × (accepted | rejected).
     *  Bucket key is `Math.floor(c * 10)` clamped to [0,9]; `conf=0.0` → '0',
     *  `conf=1.0` → '9' (last bucket inclusive). Empty until first
     *  `parseClassificationVerdict` succeeds. Timeouts / errors / unclear
     *  responses are NOT recorded (no confidence to bucket). */
    confidenceHistogram: {},
  }

  constructor(ctx: Context, config: Config, auditLog?: AuditLike) {
    super(ctx, 'intentRouter')
    this.defaultCategory = config.defaultCategory
    this.classificationProvider = config.classificationProvider
    this.classificationModel = config.classificationModel
    this.confidenceThreshold = config.confidenceThreshold
    this.llmTimeoutMs = config.llmTimeoutMs ?? 4000
    this.recentMessagesLimit = config.recentMessagesLimit ?? 3
    this.maxInputLength = config.maxInputLength ?? 2000
    // Empty array → use built-in EN+CN default. Non-empty → use as-is so
    // users can fully replace the list (e.g. JA-only deployment).
    this.fallbackKeywords = (config.fallbackKeywords && config.fallbackKeywords.length > 0)
      ? config.fallbackKeywords
      : LOCAL_KEYWORDS_DEFAULT
    // §7.47 (2026-09-12): cloudKeywords APPENDED to built-in (not replaced)
    // so the default safety net (新闻/news/search/...) always applies.
    // Empty config → use built-in only.
    this.cloudKeywords = CLOUD_KEYWORDS_DEFAULT.concat(config.cloudKeywords ?? [])
    // §7.58 (2026-09-16): localEntities APPENDED to built-in (not replaced),
    // same safety-net semantics as cloudKeywords.
    this.localEntities = LOCAL_ENTITY_KEYWORDS_DEFAULT.concat(config.localEntities ?? [])
    // §7.92.3 (2026-09-23): jev config. Toggle defaults false; URL keeps
    // localhost default for dev rigs. Intent map: user config keys OVERRIDE
    // built-in entries (Object.assign semantics, not concat) — operators
    // explicitly declaring `{"订单查询":"LOCAL"}` should win.
    this.jevEnabled = config.jevEnabled ?? false
    this.jevUrl = config.jevUrl ?? 'http://127.0.0.1:8001'
    this.jevTimeoutMs = config.jevTimeoutMs ?? 2500
    this.jevConfidenceThreshold = config.jevConfidenceThreshold ?? 0.85
    this.jevRiskThreshold = config.jevRiskThreshold ?? 0.7
    this.jevIntentMap = { ...JEV_INTENT_MAP_DEFAULT, ...(config.jevIntentMap ?? {}) }
    this.llm = (ctx as any).llm
    this.auditLog = auditLog
  }

  /**
   * Soft service lookup that works in both Cordis (runtime) and unit tests (bare mock).
   *
   * Cordis context: `ctx.get(name)` is available — use it. Throws when the
   * service is not in the `inject` list, so `get` acts as the gate.
   * Bare mock context (tests): `ctx.get` is undefined — fall back to direct
   * property access `ctx[name]`, which is how tests wire fake services.
   *
   * Either way, a missing service returns `undefined` rather than throwing.
   */
  private softService<T = any>(name: string): T | undefined {
    const c = this.ctx as any
    if (typeof c?.get === 'function') {
      try { return c.get(name) } catch { return undefined }
    }
    return c?.[name] ?? undefined
  }

  private audit(level: 'debug' | 'info' | 'warn' | 'error' | 'security', kind: string, payload: Record<string, unknown>): void {
    if (!this.auditLog) return
    void this.auditLog.log({ level, kind, source: 'intent-router', payload }).catch(() => {})
  }

  /** Redact PII from a short preview string before logging. Soft-dep on
   *  ctx.piiUtils.redactString. Returns `null` (rather than leaking) if
   *  redaction is unavailable — callers should log length-only in that case.
   *  Defense-in-depth: audit-log already runs redactObject on every payload,
   *  but router-level redaction survives audit-log misconfiguration. */
  private redactPreview(text: string): string | null {
    if (!text) return null
    const trimmed = text.trim().slice(0, 40)
    const piiUtils = this.softService('piiUtils')
    if (piiUtils && typeof piiUtils.redactString === 'function') {
      try {
        const result = piiUtils.redactString(trimmed)
        return typeof result?.redacted === 'string' ? result.redacted : null
      } catch {
        return null
      }
    }
    return null
  }

  async classify(text: string, context?: { recentMessages?: unknown[]; sessionId?: string }): Promise<Intent> {
    const start = Date.now()
    this.stats.total++

    // Input edge: empty / whitespace-only text → short-circuit to default.
    // Wasted LLM call is still bounded by llmTimeoutMs, but on the hot path
    // (e.g. UI cleared input) we want zero latency.
    if (!text || !text.trim()) {
      this.stats.empty++
      this.audit('debug', 'intent.classify.empty', { textLen: text?.length ?? 0 })
      return {
        category: this.defaultCategory,
        confidence: 0.5,
        targetRealm: this.defaultCategory === 'CLOUD' ? 'cloud' : this.defaultCategory === 'SANITIZED' ? 'sanitized' : 'local',
        rationale: 'empty-input',
      }
    }

    // Input edge: length cap. Past this, truncate and audit. Sanitization
    // (when classification LLM is CLOUD) happens on the truncated text, so
    // a 100kB paste with 5 phone numbers still only ships 5 placeholders.
    let effectiveText = text
    if (text.length > this.maxInputLength) {
      this.stats.truncated++
      this.audit('warn', 'intent.classify.truncated', {
        originalLen: text.length,
        truncatedLen: this.maxInputLength,
        maxInputLength: this.maxInputLength,
      })
      effectiveText = text.slice(0, this.maxInputLength)
    }

    // Policy pre-check: a privacy-policy REJECT rule short-circuits BEFORE
    // the LLM call. Reasons:
    //   1. REJECT is a strong policy signal — the user asked for something
    //      policy already forbids. Spending LLM tokens to confirm is wasteful.
    //   2. Latency on the rejection path matters: the policy-violating query
    //      should be denied at router-edge, not after a 4 s LLM timeout.
    //   3. The classification LLM may itself be unavailable (qwen3-4b OOM,
    //      llama.cpp hang) — REJECT must survive LLM outage. The fallback
    //      path inside classifyWithLlm → catch → classifyWithRules still
    //      re-runs matchRouting, so REJECT is also covered post-LLM-failure.
    const policy = this.softService('privacyPolicy')
    if (policy && typeof policy.matchRouting === 'function') {
      try {
        const pre = policy.matchRouting(effectiveText)
        if (pre && pre.realm === 'REJECT') {
          this.stats.rejected++
          this.audit('security', 'intent.rules.rejected', {
            source: 'privacy-policy-precheck',
            pattern: pre.pattern,
            confidence: pre.confidence,
            rationale: pre.rationale,
            textLen: effectiveText.length,
          })
          return {
            category: 'REJECT',
            confidence: pre.confidence,
            targetRealm: 'rejected',
            rationale: pre.rationale || 'policy-rule:reject',
          }
        }
      } catch (err: any) {
        this.audit('warn', 'intent.policy.precheck-error', { error: err?.message ?? String(err) })
        // Pre-check failure is non-fatal; fall through to LLM+rules path.
      }
    }

    const textPreview = this.redactPreview(effectiveText) ?? `[len=${effectiveText.length}]`
    this.audit('info', 'intent.classify.start', { textLen: effectiveText.length, textPreview, classifier: this.classificationProvider, model: this.classificationModel })

    // §7.92.3 (2026-09-23): jev prefilter. When enabled, runs BEFORE the
    // LLM classifier so confident jev verdicts (action=execute, conf >=
    // threshold, risk < threshold) save the 4-30s LLM round-trip. Failure
    // modes (network, timeout, parse error, low-confidence, unrecognized
    // intent, fallback_llm) all fall through to classifyWithLlm — jev is a
    // strictly-OPTIONAL accelerator, never a behavior regression.
    if (this.jevEnabled) {
      const jevResult = await this.classifyWithJev(effectiveText, context?.sessionId)
      if (jevResult.action === 'reject') {
        // Risk-score gate: security-level audit, count under `rejected`
        // (and `jevReject` for jev-specific observability).
        this.stats.rejected++
        this.stats.jevReject++
        this.audit('info', 'intent.classify.end', {
          textLen: effectiveText.length,
          path: 'jev-reject',
          category: 'REJECT',
          confidence: jevResult.confidence,
          rationale: `jev-risk:${jevResult.riskScore.toFixed(2)}`,
          durationMs: Date.now() - start,
          jevLatencyMs: jevResult.latencyMs,
          jevIntent: jevResult.intent,
        })
        return {
          category: 'REJECT',
          confidence: jevResult.confidence,
          targetRealm: 'rejected',
          rationale: `jev-risk:${jevResult.riskScore.toFixed(2)}`,
        }
      }
      if (jevResult.action === 'adopt' && jevResult.intent) {
        this.stats.jevHit++
        // §7.58 entity guardrail: same as LLM path — entities that
        // resolve only behind LOCAL skills force LOCAL, overriding a
        // jev-adopted non-LOCAL verdict (e.g. jev returns 'SANITIZED'
        // for "查我的密盒订单", entity wins → LOCAL). Mirrors the LLM
        // branch logic so behavior is symmetric across both paths.
        const adopted = jevResult.intent
        let finalIntent = adopted
        if (adopted.category !== 'LOCAL') {
          const entityHit = this.matchLocalEntity(effectiveText.toLowerCase())
          if (entityHit !== undefined) {
            finalIntent = {
              category: 'LOCAL',
              confidence: 0.9,
              targetRealm: 'local',
              rationale: `override-local-entity:${entityHit}`,
            }
            this.audit('warn', 'intent.classify.entity_override', {
              from: adopted.category,
              to: 'LOCAL',
              entity: entityHit,
              jevIntent: jevResult.jevIntentString,
              jevConfidence: jevResult.confidence,
              textLen: effectiveText.length,
              source: 'jev',
            })
          }
        }
        this.audit('info', 'intent.classify.end', {
          textLen: effectiveText.length,
          path: finalIntent === adopted ? 'jev-adopt' : 'jev-adopt-entity-override',
          category: finalIntent.category,
          confidence: finalIntent.confidence,
          rationale: finalIntent.rationale,
          durationMs: Date.now() - start,
          jevLatencyMs: jevResult.latencyMs,
          jevIntent: jevResult.jevIntentString,
          jevConfidence: jevResult.confidence,
        })
        return finalIntent
      }
      // action === 'skip' (low-conf / fallback_llm / unrecognized intent /
      // transport error / timeout). All already audited inside
      // classifyWithJev with a specific kind. Count under jevSkip (or
      // jevError/jevTimeout already incremented inside the helper).
      if (jevResult.action === 'skip' && jevResult.skipReason !== 'jev-error' && jevResult.skipReason !== 'jev-timeout') {
        this.stats.jevSkip++
      }
    }

    // Try LLM classification first
    try {
      const intent = await this.classifyWithLlm(effectiveText, context?.recentMessages, context?.sessionId)
      this.stats.llmHit++
      // §7.58 (2026-09-16) entity guardrail: the classification LLM has no
      // view of the skill-realm table — it answered CLOUD conf=1 for
      // "查询共登陆了几个密盒" (2026-09-15 turn 1), and the rules layer
      // never runs on this path. Entities that only resolve behind LOCAL
      // skills force LOCAL deterministically, overriding any non-LOCAL LLM
      // verdict. Fail-closed toward LOCAL; audited at warn so ops can grep
      // 'entity_override' for classifier quality regressions.
      let finalIntent = intent
      if (intent.category !== 'LOCAL') {
        const entityHit = this.matchLocalEntity(effectiveText.toLowerCase())
        if (entityHit !== undefined) {
          finalIntent = {
            category: 'LOCAL',
            confidence: 0.9,
            targetRealm: 'local',
            rationale: `override-local-entity:${entityHit}`,
          }
          this.audit('warn', 'intent.classify.entity_override', {
            from: intent.category,
            to: 'LOCAL',
            entity: entityHit,
            llmConfidence: intent.confidence,
            llmRationale: intent.rationale,
            textLen: effectiveText.length,
          })
        }
      }
      this.audit('info', 'intent.classify.end', {
        textLen: effectiveText.length,
        path: finalIntent === intent ? 'llm' : 'llm-entity-override',
        category: finalIntent.category,
        confidence: finalIntent.confidence,
        rationale: finalIntent.rationale,
        durationMs: Date.now() - start,
      })
      return finalIntent
    } catch (err: any) {
      // classifyWithLlm already audited the specific kind (timeout vs error
      // vs low-confidence vs unclear). Here we just attribute the fallback.
      this.audit('warn', 'intent.classify.llm_error', { textLen: effectiveText.length, error: err?.message ?? String(err) })
      // Fall back to keyword rules
      const intent = this.classifyWithRules(effectiveText)
      if (intent.category === 'REJECT') this.stats.rejected++
      else if (intent.rationale.startsWith('default:')) this.stats.defaultHit++
      else this.stats.ruleHit++
      this.audit('info', 'intent.classify.end', {
        textLen: effectiveText.length,
        path: 'rules-after-llm-error',
        category: intent.category,
        confidence: intent.confidence,
        rationale: intent.rationale,
        durationMs: Date.now() - start,
      })
      return intent
    }
  }

  /** §7.92.3 (2026-09-23): jev HTTP prefilter. Posts the user query to
   *  `${this.jevUrl}/predict` and returns one of:
   *  - `action: 'reject'`  → `risk_score >= jevRiskThreshold` (security-level)
   *  - `action: 'adopt'`   → `data.action === 'execute'`, confidence ≥
   *                           threshold, intent string found in jevIntentMap
   *                           (mapped to realm)
   *  - `action: 'skip'`    → any other condition (low-conf, fallback_llm,
   *                           unrecognized intent, transport / parse error).
   *                           Caller falls through to classifyWithLlm.
   *
   *  Failure handling: every error path (timeout, network, parse) is
   *  audited at warn level and produces `action: 'skip'` — jev being
   *  unavailable MUST NOT degrade the existing LLM classification path.
   *  This is the same fail-open contract used by classifyWithLlm's
   *  classifyWithRules fallback.
   *
   *  See ~/work/jev-branch/docs/api_reference.md for the wire spec.
   *  Implementation notes:
   *  - Uses global `fetch` (Node ≥18). AbortSignal for timeout.
   *  - No auth header — jev is local-network by design.
   *  - `metadata.session_id` for cross-service trace correlation.
   *  - `lang` hardcoded 'zh' (we don't auto-detect; the operator's UI
   *    can pass it later if multilingual queries become common). */
  private async classifyWithJev(text: string, sessionId?: string): Promise<{
    action: 'reject' | 'adopt' | 'skip'
    intent?: Intent
    jevIntentString?: string
    confidence: number
    riskScore: number
    latencyMs: number
    skipReason?: string
  }> {
    const jevStart = Date.now()
    this.audit('debug', 'intent.jev.start', {
      textLen: text.length,
      jevUrl: this.jevUrl,
      timeoutMs: this.jevTimeoutMs,
    })

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.jevTimeoutMs)

    let responseText = ''
    let parsed: any = null
    try {
      const r = await fetch(`${this.jevUrl}/predict`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: text,
          lang: 'zh',
          metadata: sessionId ? { session_id: sessionId } : {},
        }),
        signal: controller.signal,
      })
      if (!r.ok) {
        this.stats.jevError++
        this.audit('warn', 'intent.jev.error', {
          httpStatus: r.status,
          latencyMs: Date.now() - jevStart,
        })
        return { action: 'skip', confidence: 0, riskScore: 0, latencyMs: Date.now() - jevStart, skipReason: 'jev-error' }
      }
      responseText = await r.text()
      try {
        parsed = JSON.parse(responseText)
      } catch (parseErr: any) {
        this.stats.jevError++
        this.audit('warn', 'intent.jev.error', {
          reason: 'parse-failure',
          error: parseErr?.message ?? String(parseErr),
          latencyMs: Date.now() - jevStart,
        })
        return { action: 'skip', confidence: 0, riskScore: 0, latencyMs: Date.now() - jevStart, skipReason: 'jev-error' }
      }
    } catch (err: any) {
      const isAbort = err?.name === 'AbortError' || controller.signal.aborted
      const latencyMs = Date.now() - jevStart
      if (isAbort) this.stats.jevTimeout++
      else this.stats.jevError++
      this.audit('warn', isAbort ? 'intent.jev.timeout' : 'intent.jev.error', {
        latencyMs,
        timeoutMs: this.jevTimeoutMs,
        error: err?.message ?? String(err),
      })
      return {
        action: 'skip',
        confidence: 0,
        riskScore: 0,
        latencyMs,
        skipReason: isAbort ? 'jev-timeout' : 'jev-error',
      }
    } finally {
      clearTimeout(timer)
    }

    // Response envelope: {code, message, request_id, data: {...}}
    // See api_reference §2.1 + §3.2. `code === 0` is the success sentinel.
    const data = parsed?.data ?? {}
    const intentStr: string | null = typeof data.intent === 'string' ? data.intent : null
    const confidence = typeof data.confidence === 'number' ? Math.max(0, Math.min(1, data.confidence)) : 0
    const riskScore = typeof data.risk_score === 'number' ? Math.max(0, Math.min(1, data.risk_score)) : 0
    const dataAction: string = typeof data.action === 'string' ? data.action : ''
    const latencyMs = (typeof data.latency_ms === 'number' ? data.latency_ms : Date.now() - jevStart)

    this.stats.jevLatencyMsTotal += latencyMs
    this.audit('debug', 'intent.jev.response', {
      code: parsed?.code,
      intent: intentStr,
      confidence,
      riskScore,
      action: dataAction,
      latencyMs,
    })

    // Risk gate: high-risk queries short-circuit to REJECT before any
    // LLM call (security-first; user explicitly chose this in plan Q2).
    if (riskScore >= this.jevRiskThreshold) {
      this.audit('security', 'intent.rules.rejected', {
        source: 'jev',
        intent: intentStr,
        riskScore,
        confidence,
        textLen: text.length,
      })
      return {
        action: 'reject',
        confidence,
        riskScore,
        latencyMs,
        jevIntentString: intentStr ?? undefined,
      }
    }

    // Skip conditions: jev's own verdict says fall through, OR our
    // thresholds aren't met, OR the intent string isn't recognized.
    const FALLBACK_INTENTS = new Set(['闲聊', '其他', 'chat', 'other', 'fallback', 'null'])
    if (dataAction === 'fallback_llm') {
      this.audit('info', 'intent.jev.fallback_intent', {
        intent: intentStr,
        confidence,
        latencyMs,
      })
      return {
        action: 'skip',
        confidence,
        riskScore,
        latencyMs,
        jevIntentString: intentStr ?? undefined,
        skipReason: 'fallback-llm',
      }
    }
    if (confidence < this.jevConfidenceThreshold) {
      this.audit('info', 'intent.jev.low_confidence', {
        intent: intentStr,
        confidence,
        threshold: this.jevConfidenceThreshold,
        latencyMs,
      })
      return {
        action: 'skip',
        confidence,
        riskScore,
        latencyMs,
        jevIntentString: intentStr ?? undefined,
        skipReason: 'low-confidence',
      }
    }
    if (!intentStr || FALLBACK_INTENTS.has(intentStr)) {
      this.audit('info', 'intent.jev.fallback_intent', {
        intent: intentStr,
        confidence,
        latencyMs,
        reason: 'no-intent-or-fallback-intent',
      })
      return {
        action: 'skip',
        confidence,
        riskScore,
        latencyMs,
        jevIntentString: intentStr ?? undefined,
        skipReason: 'unrecognized-intent',
      }
    }

    // Map intent string → realm. Missing → skip (defensive).
    const mapped = this.jevIntentMap[intentStr]
    if (!mapped) {
      this.audit('info', 'intent.jev.unmapped_intent', {
        intent: intentStr,
        confidence,
        latencyMs,
      })
      return {
        action: 'skip',
        confidence,
        riskScore,
        latencyMs,
        jevIntentString: intentStr,
        skipReason: 'unmapped-intent',
      }
    }

    // Adopt the verdict. REJECT here is a policy-driven REJECT (not the
    // risk-score gate handled above) — for intents like '投诉' / 'legal'
    // mapped to REJECT in JEV_INTENT_MAP_DEFAULT. Security-level audit
    // mirrors the risk-gate path so SIEM picks both up uniformly.
    const targetRealm = mapped === 'LOCAL' ? 'local'
      : mapped === 'CLOUD' ? 'cloud'
      : mapped === 'REJECT' ? 'rejected'
      : 'sanitized'
    if (mapped === 'REJECT') {
      this.audit('security', 'intent.rules.rejected', {
        source: 'jev',
        intent: intentStr,
        confidence,
        riskScore,
        textLen: text.length,
      })
      return {
        action: 'reject',
        intent: {
          category: 'REJECT',
          confidence,
          targetRealm,
          rationale: `jev-intent:${intentStr}`,
        },
        jevIntentString: intentStr,
        confidence,
        riskScore,
        latencyMs,
      }
    }
    const adoptedIntent: Intent = {
      category: mapped,
      confidence,
      targetRealm,
      rationale: `jev-intent:${intentStr}`,
    }
    this.audit('info', 'intent.jev.adopt', {
      intent: intentStr,
      realm: mapped,
      confidence,
      riskScore,
      latencyMs,
    })
    return {
      action: 'adopt',
      intent: adoptedIntent,
      jevIntentString: intentStr,
      confidence,
      riskScore,
      latencyMs,
    }
  }

  private async classifyWithLlm(text: string, recentMessages?: unknown[], sessionId?: string): Promise<Intent> {
    if (!this.llm) {
      this.audit('debug', 'intent.llm.skipped', { reason: 'no-llm-handle' })
      throw new Error('intent-router: no llm handle')
    }

    // NEW: route the classification LLM call through model-router if mounted.
    // Lazy-lookup on every call (not cached) because root cordis.yml declares
    // intent-router BEFORE model-router — the service may not exist at the
    // first classify() but will by the next one. Soft dependency: missing or
    // throwing modelRouter falls back to config values (fail-open).
    // ⚠️ classificationProvider MUST be a provider route id (with 'local-' /
    // 'cloud-' prefix); bare model ids resolve to realm: 'CLOUD' (see
    // model-router.ts:103). Current default 'local-llm' is fine.
    //
    // §7.54 (2026-09-14): model-router maps provider ids to themselves
    // (e.g. 'local-llm' → {provider:'local-llm', model:'local-llm'}). The
    // wire body wants the actual upstream model name (classificationModel,
    // typically qwen3.7-plus). When router returns provider==model, fall
    // back to classificationModel so the adapter receives the right wire
    // model id (routing-key-only labels like 'local-llm' break upstream
    // model lookup and produce inconsistent ops log lines).
    const modelRouter = this.softService('modelRouter')
    const resolved = (() => {
      try { return modelRouter?.resolve?.(this.classificationProvider) }
      catch { return undefined }
    })()
    const provider = resolved?.provider ?? this.classificationProvider
    const resolvedModel = (resolved && resolved.model === resolved.provider) ? this.classificationModel : resolved?.model
    const model = resolvedModel ?? this.classificationModel
    this.audit('debug', 'intent.llm.route', {
      configured: this.classificationProvider,
      resolvedRealm: resolved?.realm,
      resolvedProvider: provider,
      resolvedModel: model,
      modelRouterMounted: Boolean(modelRouter),
    })

    // NEW: sanitize user text BEFORE the LLM prompt when the classification
    // LLM lives in the CLOUD realm. This prevents PII (phone/id/bank/email/
    // api-key) from leaving the device just to ask "is this LOCAL or CLOUD".
    // Policy: if sanitizer is unavailable or throws, do NOT send raw text to
    // the cloud LLM — throw so the outer classifyWithLlm catches and falls
    // through to classifyWithRules (which can produce LOCAL via policy rules
    // or keyword fallback). "脱不了敏就不上云".
    //
    // Sanitizer is lifted to this scope (not block-scoped inside the if)
    // so the multi-turn history builder below can reuse it — recentMessages
    // may contain PII from earlier turns that must also be sanitized before
    // reaching the cloud LLM. (2026-08-24 P0 fix)
    let promptText = text
    const resolvedRealm = resolved?.realm
    let sanitizer: any
    if (resolvedRealm === 'CLOUD') {
      sanitizer = this.softService('sanitizer')
      if (sanitizer && typeof sanitizer.sanitize === 'function') {
        try {
          const result = await sanitizer.sanitize(text, { sessionId: sessionId ?? 'default' })
          const replacementCount = Array.isArray(result?.replacements) ? result.replacements.length : 0
          promptText = result?.sanitizedText ?? text
          this.stats.sanitized++
          this.audit('info', 'intent.llm.sanitized', {
            sessionId: sessionId ?? 'default',
            originalLen: text.length,
            sanitizedLen: promptText.length,
            replacements: replacementCount,
          })
        } catch (err: any) {
          this.stats.sanitizeError++
          // SECURITY-level: PII failed to be stripped from text that the
          // router would have forwarded to a CLOUD LLM. SIEM must surface.
          this.audit('security', 'intent.llm.sanitize-error', {
            error: err?.message ?? String(err),
            originalLen: text.length,
          })
          // Fail-closed: throw so classifyWithLlm catches → classifyWithRules
          const e: any = new Error('intent-router: cloud sanitization failed')
          e._intentRouterReason = 'sanitize-failed'
          throw e
        }
      } else {
        this.stats.sanitizeSkipped++
        this.audit('security', 'intent.llm.sanitize-unavailable', { reason: 'no-sanitizer-handle' })
        // Fail-closed: throw so classifyWithLlm catches → classifyWithRules
        const e: any = new Error('intent-router: cloud sanitization unavailable')
        e._intentRouterReason = 'sanitize-unavailable'
        throw e
      }
    }

    // Multi-turn context: best-effort extract text from each message and
    // append a "history" block before the current query. Caps at
    // recentMessagesLimit (default 3) and per-message length to bound prompt size.
    //
    // P0 (2026-08-24): when the classification LLM is in CLOUD realm, each
    // history message must also be sanitized before inclusion. History may
    // contain PII from earlier turns (user shared a phone number in turn 1,
    // now asks a follow-up in turn 4) — sending raw history to the cloud
    // LLM would leak PII just as much as sending the current message raw.
    // Fail-closed per message: if sanitize throws for a history entry, that
    // entry is OMITTED rather than sent raw. The current message was already
    // fail-closed above if sanitizer is broken, so reaching here with
    // resolvedRealm === 'CLOUD' implies sanitizer is present.
    const historyLines: string[] = []
    if (this.recentMessagesLimit && recentMessages?.length) {
      const tail = recentMessages.slice(-this.recentMessagesLimit)
      let historySanitizedCount = 0
      for (const m of tail) {
        let msgText = extractMessageText(m).slice(0, 200)
        if (!msgText) continue
        const role = (m as any)?.role ?? (m as any)?.source?.kind ?? '?'
        if (resolvedRealm === 'CLOUD' && sanitizer && typeof sanitizer.sanitize === 'function') {
          try {
            const r = await sanitizer.sanitize(msgText, { sessionId: sessionId ?? 'default' })
            msgText = r?.sanitizedText ?? msgText
            if (Array.isArray(r?.replacements) && r.replacements.length > 0) historySanitizedCount++
          } catch (err: any) {
            // Fail-closed for this history entry: omit rather than leak raw PII.
            // The current message has already been sanitized (or we would have
            // thrown above), so only this particular history entry is skipped.
            this.audit('warn', 'intent.llm.history-sanitize-error', {
              error: err?.message ?? String(err),
              role,
            })
            continue
          }
        }
        historyLines.push(`${role}: ${msgText}`)
      }
      if (historySanitizedCount > 0) {
        this.audit('info', 'intent.llm.history-sanitized', {
          sessionId: sessionId ?? 'default',
          sanitizedMessageCount: historySanitizedCount,
          totalMessages: historyLines.length,
        })
      }
    }
    const historyBlock = historyLines.length > 0
      ? `\n最近对话上下文（仅参考，不要分类历史消息本身）：\n${historyLines.join('\n')}\n`
      : ''
    if (recentMessages?.length) {
      this.audit('debug', 'intent.llm.context', {
        received: recentMessages.length,
        embedded: Math.min(recentMessages.length, this.recentMessagesLimit),
      })
    }

    // Phase B: ask for structured JSON output with explicit confidence.
    // Below the configured threshold we fall back to keyword rules
    // (fail-open; we do NOT reject — see plan Phase B).
    //
    // Confidence calibration (2026-08-25): qwen3-4b tends to always output
    // 0.98-0.99 regardless of actual certainty, making the 0.6 gate
    // ineffective. Adding explicit confidence semantics to the prompt so
    // the model learns to differentiate clear vs ambiguous requests.
    const prompt = `判断以下用户请求属于哪类：
- LOCAL：本地文件操作、设备控制、数学计算、系统管理
- CLOUD：知识问答、聊天、创意写作、需要联网的任务
${historyBlock}
Respond ONLY with a single JSON object — no prose, no Markdown:
{ "category": "LOCAL"|"CLOUD", "confidence": <0.0-1.0> }

confidence 含义：
- 1.0 = 非常确定（请求明确属于该类别，无歧义）
- 0.7 = 较确定（请求大概率属于该类别，但有少许模糊）
- 0.5 = 不确定（请求模糊，可能是 LOCAL 也可能是 CLOUD）
- <0.5 = 完全不确定（无法判断类别）

用户请求：${promptText}`

    const userMessage = createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    })

    const llmStart = Date.now()
    let responseText = ''
    let chunks = 0

    // Hard timeout via signal — prevents llama.cpp / qwen3-4b hangs from
    // blocking the http-api main thread. On AbortError we throw and the
    // outer classify() falls through to the keyword/default path (fail-open).
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.llmTimeoutMs)

    try {
      const streamRaw = this.llm.stream({
        provider,
        model,
        messages: [userMessage],
        signal: controller.signal,
        // §7.53 (2026-09-13): propagate sessionId for ops log correlation.
        // local-llm-adapter reads options.sessionId for its 'LLM call start'
        // line; realm-skill-bridge probe reads p.sessionId from the
        // llm/stream waterfall payload. Both go from <pre-session> to the
        // real sessionId when this is set.
        ...(sessionId ? { sessionId } : {}),
      })
      // §7.37: this.llm.stream() returns Promise<AsyncIterable<StreamChunk>>
      // since dsh-llm 0.1.2-rc.1 — await if thenable, otherwise use directly.
      const stream = (streamRaw != null && typeof (streamRaw as { then?: unknown }).then === 'function')
        ? await (streamRaw as unknown as Promise<AsyncIterable<{ type: string; text?: string }>>)
        : streamRaw as AsyncIterable<{ type: string; text?: string }>

      for await (const chunk of stream) {
        chunks++
        if (chunk.type === 'text-delta') {
          responseText += (chunk as any).text
        }
      }
    } catch (err: any) {
      const isAbort = err?.name === 'AbortError' || controller.signal.aborted
      const durationMs = Date.now() - llmStart
      this.stats.timeout += isAbort ? 1 : 0
      this.stats.llmError += isAbort ? 0 : 1
      this.audit('warn', isAbort ? 'intent.llm.timeout' : 'intent.llm.error', {
        durationMs,
        timeoutMs: this.llmTimeoutMs,
        chunks,
        responseLen: responseText.length,
        error: err?.message ?? String(err),
      })
      const wrapped: any = new Error(err?.message ?? String(err))
      wrapped.name = err?.name ?? 'Error'
      wrapped._intentRouterReason = isAbort ? 'timeout' : 'llm-error'
      throw wrapped
    } finally {
      clearTimeout(timer)
    }
    this.audit('debug', 'intent.llm.response', { durationMs: Date.now() - llmStart, chunks, responseLen: responseText.length, responsePreview: this.redactPreview(responseText.trim().slice(0, 40)) })

    const verdict = parseClassificationVerdict(responseText)
    if (!verdict) {
      // P1: count parse failures separately from transport/timeout errors
      // so the dashboard's parse health can be read independently of
      // network health.
      this.stats.parseFailure++
      this.stats.llmError++
      this.audit('debug', 'intent.llm.unclear', { responsePreview: this.redactPreview(responseText.trim().slice(0, 40)) })
      const e: any = new Error('intent-router: llm response unclear')
      e._intentRouterReason = 'unclear'
      throw e
    }
    this.audit('debug', 'intent.llm.parsed', { category: verdict.category, confidence: verdict.confidence })

    // G9: confidence histogram — record every parsed verdict (whether it
    // crosses the threshold or not) so operators can see the LLM's
    // distribution and tune `confidenceThreshold` accordingly. Accepted vs
    // rejected split per bucket tells you exactly where the threshold cuts
    // the distribution. Confidences are pre-clamped to [0,1] by
    // coerceClassification, so Math.floor(c*10) yields 0..9 (1.0 clamped).
    {
      const bucket = Math.min(9, Math.max(0, Math.floor(verdict.confidence * 10)))
      const key = String(bucket)
      const cell = this.stats.confidenceHistogram[key]
        ?? (this.stats.confidenceHistogram[key] = { accepted: 0, rejected: 0 })
      if (verdict.confidence >= this.confidenceThreshold) cell.accepted++
      else cell.rejected++
    }

    // Confidence gate: if below threshold, fall back to keyword rules.
    if (verdict.confidence < this.confidenceThreshold) {
      this.stats.lowConfidence++
      this.audit('info', 'intent.llm.low-confidence', {
        confidence: verdict.confidence,
        threshold: this.confidenceThreshold,
        category: verdict.category,
      })
      const e: any = new Error(`intent-router: low confidence ${verdict.confidence} < ${this.confidenceThreshold}`)
      e._intentRouterReason = 'low-confidence'
      throw e
    }

    return {
      category: verdict.category,
      confidence: verdict.confidence,
      targetRealm: verdict.category === 'LOCAL' ? 'local' : 'cloud',
      rationale: `llm-classified:${verdict.category.toLowerCase()}`,
    }
  }

  /** §7.58 (2026-09-16): match a LOCAL-entity keyword. CJK entries are
   *  substring matches; ASCII entries require non-alphanumeric boundaries
   *  (so 'ets' never fires inside "assets"/"settings"). Returns the matched
   *  (lower-cased) keyword, or undefined. */
  private matchLocalEntity(lower: string): string | undefined {
    for (const kw of this.localEntities) {
      const k = kw.toLowerCase().trim()
      if (k.length === 0) continue
      if (/^[\x00-\x7f]+$/.test(k)) {
        const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        if (new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, 'u').test(lower)) return k
      } else if (lower.includes(k)) {
        return k
      }
    }
    return undefined
  }

  private classifyWithRules(text: string): Intent {
    // Phase: try privacy-policy routing rules first (hot-reloadable, richer
    // semantics: LOCAL/CLOUD/SANITIZED/REJECT with per-rule confidence +
    // rationale). Soft dep: missing or throwing matchRouting falls through
    // to the hardcoded keyword list (fail-open). The hardcoded list is the
    // last resort — even if privacy-policy is mounted but has zero rules,
    // we still try the local keyword fallback.
    //
    // REJECT is now a first-class category (previously silently filtered).
    // Privacy-policy allows `realm: 'REJECT'` and design-v6 §2.15 treats it as
    // "blocked at router, no model call, consumer should map to 403 /
    // { kind: 'reject' } decision". audit kind `intent.rules.rejected` is
    // security-level so SIEM picks it up.
    const policy = this.softService('privacyPolicy')
    let matchedRule: { pattern: string; realm: RuleCategory; confidence: number; rationale: string } | null = null
    try {
      const r = policy?.matchRouting?.(text)
      if (r && (RULE_CATEGORIES as readonly string[]).includes(r.realm)) {
        matchedRule = r as { pattern: string; realm: RuleCategory; confidence: number; rationale: string }
      }
    } catch (err: any) {
      this.audit('warn', 'intent.policy.error', { error: err?.message ?? String(err) })
    }

    if (matchedRule) {
      const realm = matchedRule.realm
      if (realm === 'REJECT') {
        this.audit('security', 'intent.rules.rejected', {
          source: 'privacy-policy',
          pattern: matchedRule.pattern,
          confidence: matchedRule.confidence,
          rationale: matchedRule.rationale,
          textLen: text.length,
        })
        return {
          category: 'REJECT',
          confidence: matchedRule.confidence,
          targetRealm: 'rejected',
          rationale: matchedRule.rationale || 'policy-rule:reject',
        }
      }
      const targetRealm = realm === 'LOCAL' ? 'local' : realm === 'SANITIZED' ? 'sanitized' : 'cloud'
      this.audit('debug', 'intent.rules.hit', {
        source: 'privacy-policy',
        pattern: matchedRule.pattern,
        realm,
        confidence: matchedRule.confidence,
      })
      return {
        category: realm,
        confidence: matchedRule.confidence,
        targetRealm,
        rationale: matchedRule.rationale || `policy-rule:${realm.toLowerCase()}`,
      }
    }

    // Fallback: configurable keyword list (defaults to built-in EN + CN).
    // Used only when privacy-policy is absent / has no matching rule.
    const lower = text.toLowerCase()
    // §7.58 (2026-09-16): LOCAL entities checked FIRST — before even CLOUD
    // strong keywords. "查询共登陆了几个密盒" (2026-09-15 incident) contains
    // both an entity (密盒) and a verb (查询): the entity names a resource
    // that only exists behind LOCAL skills, so it decides the realm no
    // matter what else the sentence contains. Fail-closed toward LOCAL.
    const entityHit = this.matchLocalEntity(lower)
    if (entityHit !== undefined) {
      this.audit('debug', 'intent.rules.hit', { source: 'local-entity', matchedEntity: entityHit })
      return {
        category: 'LOCAL',
        confidence: 0.9,
        targetRealm: 'local',
        rationale: `rule-local-entity:${entityHit}`,
      }
    }
    // §7.47 (2026-09-12): CLOUD keywords matched BEFORE LOCAL fallback.
    // This catches queries that obviously need web/search/latest-news and
    // would otherwise hit defaultCategory (SANITIZED, fail-closed) without
    // any LLM call. Inspection order is ENTITY → CLOUD → LOCAL → default —
    // if a query contains both CLOUD and LOCAL signals (e.g. "把本地文件整理
    // 成新闻稿发到网上"), the CLOUD path wins because user explicitly asked
    // for online content; a LOCAL *entity* name still beats both (above).
    // Privacy-policy rules (before all of this) can still REJECT.
    const cloudMatched = this.cloudKeywords.find((kw) => lower.includes(kw.toLowerCase()))
    if (cloudMatched !== undefined) {
      this.audit('debug', 'intent.rules.hit', { source: 'cloud-keyword', matchedKeyword: cloudMatched })
      return {
        category: 'CLOUD',
        confidence: 0.8,
        targetRealm: 'cloud',
        rationale: `rule-cloud-keyword:${cloudMatched}`,
      }
    }
    const matched = this.fallbackKeywords.find((kw) => lower.includes(kw.toLowerCase()))

    if (matched !== undefined) {
      this.audit('debug', 'intent.rules.hit', { source: 'fallback-keyword', matchedKeyword: matched })
      return {
        category: 'LOCAL',
        confidence: 0.7,
        targetRealm: 'local',
        rationale: 'rule-keyword-match',
      }
    }

    this.audit('debug', 'intent.rules.miss', { defaultCategory: this.defaultCategory })
    return {
      category: this.defaultCategory,
      confidence: 0.5,
      targetRealm: this.defaultCategory === 'CLOUD' ? 'cloud' : 'local',
      rationale: `default:${this.defaultCategory.toLowerCase()}`,
    }
  }

  resolve(intent: Intent): { realm: string; config: Record<string, unknown> } {
    return resolveIntent(intent)
  }

  /** Snapshot of in-memory counters. Returned object is a copy so callers
   *  can't mutate the live state. Counters are process-local — restart
   *  zeroes them. */
  getStats(): IntentRouterStats {
    // G9: deep-copy the histogram too — its nested {accepted, rejected}
    // cells would otherwise be live references into `this.stats`.
    const hist: IntentRouterStats['confidenceHistogram'] = {}
    for (const k of Object.keys(this.stats.confidenceHistogram)) {
      const cell = this.stats.confidenceHistogram[k]
      hist[k] = { accepted: cell.accepted, rejected: cell.rejected }
    }
    return { ...this.stats, confidenceHistogram: hist }
  }
}

/** Map an Intent to a realm/config tuple the rest of the agent loop can consume. */
export function resolveIntent(intent: Intent): { realm: string; config: Record<string, unknown> } {
  return {
    realm: intent.targetRealm,
    config: { intentCategory: intent.category },
  }
}

/** Parsed shape of the LLM's classification response. */
interface ClassificationVerdict {
  category: 'LOCAL' | 'CLOUD'
  confidence: number
}

/** Valid category values produced by classifyWithRules — wider than the LLM
 *  verdict set because privacy-policy rules can declare REJECT. */
const RULE_CATEGORIES = ['LOCAL', 'CLOUD', 'SANITIZED', 'REJECT'] as const
type RuleCategory = typeof RULE_CATEGORIES[number]

/** In-memory counters exposed via getStats(). Pure observability; the audit
 *  log already carries every per-call kind, but counters give operators an
 *  O(1) read for dashboards / alerts (rate of timeouts, % sanitized, etc.)
 *  without parsing JSONL. */
export interface IntentRouterStats {
  total: number
  empty: number
  truncated: number
  /** LLM verdict adopted as the final intent. */
  llmHit: number
  /** classifyWithRules adopted — privacy-policy match OR hardcoded keyword. */
  ruleHit: number
  /** No LLM verdict, no keyword → defaultCategory returned. */
  defaultHit: number
  /** LLM returned below confidence threshold (cause of fallback to rules). */
  lowConfidence: number
  /** AbortController fired during LLM stream. */
  timeout: number
  /** LLM threw a non-timeout error (network, parse, etc.). */
  llmError: number
  /** P1: LLM stream returned text that parseClassificationVerdict could
   *  not turn into a verdict (all three tiers failed). Distinct from
   *  `llmError` (network / timeout) — the LLM DID respond, the response
   *  just wasn't structured. Operators can compare
   *  `parseFailure / (llmHit + lowConfidence + parseFailure + llmError)`
   *  to gauge parse health. */
  parseFailure: number
  /** REJECT verdict returned (pre-check or fallback). */
  rejected: number
  /** Sanitizer applied to CLOUD-classification prompt. */
  sanitized: number
  /** Sanitizer threw (fail-closed → throws, falls back to classifyWithRules). */
  sanitizeError: number
  /** CLOUD realm but no sanitizer handle mounted (fail-closed → throws). */
  sanitizeSkipped: number
  /** §7.92.3 (2026-09-23): jev verdict ADOPTED (path: jev-adopt). Sum
   *  with `llmHit + ruleHit + defaultHit + jevHit` to verify all paths
   *  hit a final verdict. Compare `jevHit / total` to estimate latency
   *  savings from the toggle (every jevHit replaces a 4-30s LLM call
   *  with a ~150ms jev call). */
  jevHit: number
  /** §7.92.3: jev risk-gated REJECT (risk_score >= threshold). Subset
   *  of `rejected`. */
  jevReject: number
  /** §7.92.3: jev SKIPPED to LLM (low-conf / fallback_llm / unmapped).
   *  Distinct from jevError (transport failure) — skip means jev
   *  worked fine, just deferred to LLM for quality reasons. */
  jevSkip: number
  /** §7.92.3: jev transport / parse failure. Counts alongside jevSkip
   *  in classify()'s tally but operators triage them separately:
   *  jevError rate climbing → jev service health issue, jevSkip rate
   *  climbing → jev's intent set doesn't match our traffic. */
  jevError: number
  /** §7.92.3: subset of jevError where AbortSignal fired. */
  jevTimeout: number
  /** §7.92.3: cumulative jev `data.latency_ms` sum (ms). Use with
   *  `getStats()` calls to compute average jev latency without
   *  parsing JSONL. */
  jevLatencyMsTotal: number
  /** G9: 10-bucket histogram of LLM confidence values × (accepted | rejected).
   *  Bucket key is `String(Math.floor(c * 10))` clamped to [0,9]. Use
   *  `getStats()` to obtain a deep copy. Empty until the first parsed
   *  verdict — timeouts / errors / unclear responses are not recorded. */
  confidenceHistogram: { [bucket: string]: { accepted: number; rejected: number } }
}

/**
 * Fence-tolerant parser for `{ category, confidence }` JSON the LLM returns.
 * Falls back to: extract the first {...} block → regex token match for
 * `category` + a best-effort confidence float from the surrounding text.
 */
export function parseClassificationVerdict(raw: string): ClassificationVerdict | null {
  if (!raw.length) return null
  const cleaned = raw.replace(/^```(?:json)?/iu, '').replace(/```$/u, '').trim()

  // Tier 1: direct JSON parse
  try {
    return coerceClassification(JSON.parse(cleaned))
  } catch {
    /* fall through */
  }
  // Tier 2: extract first {...} block
  const fence = cleaned.match(/\{[\s\S]*\}/u)
  if (fence) {
    try {
      return coerceClassification(JSON.parse(fence[0]))
    } catch {
      /* fall through */
    }
  }
  // Tier 3: regex token fallback. Require BOTH category AND confidence
  // extracted from the LLM's own emission. If only one is recoverable
  // (e.g. the LLM wrote "category=LOCAL" with no confidence), return null
  // so the outer classifyWithLlm can attribute the failure to the
  // parseFailure counter and fall through to keyword rules — instead of
  // returning a 0.5-confidence verdict that ALWAYS fails the 0.6
  // confidence gate and wastes the LLM call.
  const categoryMatch = /["']?category["']?\s*[:=]\s*["']?(LOCAL|CLOUD)["']?/iu.exec(cleaned)
  // `[:=]?` — separator is optional: qwen3-4b sometimes emits
  // `confidence 0.8` (whitespace only), sometimes `confidence: 0.8`,
  // sometimes `confidence=0.8`. All three should be recovered.
  const confidenceMatch = /["']?confidence["']?\s*[:=]?\s*([0-9.]+)/iu.exec(cleaned)
  if (categoryMatch && confidenceMatch) {
    const conf = Number(confidenceMatch[1])
    return {
      category: categoryMatch[1].toUpperCase() as 'LOCAL' | 'CLOUD',
      confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.5,
    }
  }
  return null
}

export function coerceClassification(obj: unknown): ClassificationVerdict | null {
  if (!obj || typeof obj !== 'object') return null
  const o = obj as Record<string, unknown>
  const cat = typeof o.category === 'string' ? o.category.toUpperCase() : ''
  if (cat !== 'LOCAL' && cat !== 'CLOUD') return null
  const confRaw = typeof o.confidence === 'number'
    ? o.confidence
    : typeof o.confidence === 'string' ? Number(o.confidence) : NaN
  const conf = Number.isFinite(confRaw) ? Math.max(0, Math.min(1, confRaw)) : 0.5
  return { category: cat as 'LOCAL' | 'CLOUD', confidence: conf }
}

/** Best-effort extract a text payload from a recent-message object.
 *  Handles dsh-llm's `{content: [{type:'text', text}]}`, plain `{text}`,
 *  `{message: string}`, or anything stringifiable. Returns '' on failure. */
export function extractMessageText(m: unknown): string {
  if (typeof m === 'string') return m
  if (!m || typeof m !== 'object') return ''
  const o = m as Record<string, unknown>
  if (typeof o.text === 'string') return o.text
  if (typeof o.message === 'string') return o.message
  if (Array.isArray(o.content)) {
    const parts = o.content
      .map((p) => (p && typeof p === 'object' && typeof (p as any).text === 'string' ? (p as any).text : ''))
      .filter(Boolean)
    if (parts.length) return parts.join(' ')
  }
  return ''
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    intentRouter: IntentRouterServiceImpl
  }
}

export async function apply(ctx: Context, config: Config): Promise<() => Promise<void>> {
  const auditLog = (ctx as unknown as { auditLog?: AuditLike }).auditLog
  const service = new IntentRouterServiceImpl(ctx, config, auditLog)
  return async () => {}
}