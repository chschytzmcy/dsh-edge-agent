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

export const inject = ['llm', 'auditLog', 'privacyPolicy'] as const

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
  /** §7.92.3 (2026-09-23) + §7.92.5 (2026-09-23): jev HTTP intent
   *  recognizer (port 8001). Toggle — default OFF (opt-in). When ON,
   *  jev runs BEFORE the LLM classifier and short-circuits high-
   *  confidence / low-risk verdicts. See
   *  ~/work/jev-branch/docs/api_reference.md for the upstream contract.
   *  §7.92.5 splits the full categories[] taxonomy into ≤16-intent
   *  batches (jev v0.3.0 hard cap) and fires them concurrently via
   *  Promise.all. Env DSH_EDGE_INTENT_JEV_ENABLED (literal 'true' activates). */
  jevEnabled?: boolean
  /** §7.92.3: jev base URL. Env DSH_EDGE_INTENT_JEV_URL. */
  jevUrl?: string
  /** §7.92.3: per-batch jev HTTP timeout in ms (applies to EACH batch
   *  fired by the §7.92.5 orchestrator). Env DSH_EDGE_INTENT_JEV_TIMEOUT_MS. */
  jevTimeoutMs?: number
  /** §7.92.3: minimum jev confidence to adopt. Below → fall through to
   *  LLM. Env DSH_EDGE_INTENT_JEV_CONFIDENCE_THRESHOLD. */
  jevConfidenceThreshold?: number
  /** §7.92.3: jev risk_score gate (≥ this value → REJECT). Env
   *  DSH_EDGE_INTENT_JEV_RISK_THRESHOLD. */
  jevRiskThreshold?: number
  /** §7.92.6 (2026-09-24): circuit-breaker TTL (ms). When all 3
   *  jev batches fail (transport / parse / timeout) within one
   *  classify() call, the breaker opens and subsequent classify()
   *  calls skip jev entirely until TTL elapses. Any successful batch
   * (HTTP 2xx + parse OK, even if action='fallback_llm') closes the
   *  breaker immediately. Env DSH_EDGE_INTENT_JEV_BREAKER_TTL_MS. */
  jevBreakerTtlMs?: number
  /** §7.92.7 (2026-09-24): boot-time `/health` probe (toggle). When
   *  true, the service fires a single GET `${jevUrl}/health` (timeout
   *  = `jevBootProbeTimeoutMs`, default 2000ms) at `apply()` time. On
   *  non-2xx / network error / timeout the breaker is **pre-opened**
   *  with full TTL — first classify() short-circuits without paying
   *  the ~3 × jevTimeoutMs wall-clock. Default ON; operators set
   *  false to skip the probe (e.g. when jev boots lazily alongside
   *  dsh-edge and is reliably up by the time chat starts). Env
   *  DSH_EDGE_INTENT_JEV_BOOT_PROBE_ENABLED. */
  jevBootProbeEnabled?: boolean
  /** §7.92.7: boot probe timeout (ms). Smaller than `jevTimeoutMs`
   *  (which is per-batch for classify-time use). Env
   *  DSH_EDGE_INTENT_JEV_BOOT_PROBE_TIMEOUT_MS. */
  jevBootProbeTimeoutMs?: number
  /** §7.92.7: interval (ms) between breaker-open `/health` probes.
   *  While the breaker is open, a setInterval pings `/health` every
   *  N ms (timeout = `jevProbeTimeoutMs`). On 2xx the breaker closes
   *  immediately (recovery can be faster than waiting for full TTL).
   *  Default 5000ms — frequent enough that recovery feels snappy,
   *  infrequent enough to avoid hammering a sick jev. Env
   *  DSH_EDGE_INTENT_JEV_BREAKER_PROBE_MS. */
  jevBreakerProbeMs?: number
  /** §7.92.7: periodic probe timeout (ms). Smaller than `jevTimeoutMs`
   *  — we want fast fail on a sick jev rather than waiting the full
   *  classify-time budget. Env DSH_EDGE_INTENT_JEV_PROBE_TIMEOUT_MS. */
  jevProbeTimeoutMs?: number
  /** §7.92.3 (2026-09-23): intent category specs (LOCAL/CLOUD/SANITIZED/
   *  REJECT descriptions + jev intent lists). Loaded from
   *  `ctx.privacyPolicy.getCategories()` at construction. When set, used
   *  as-is (test override path); when absent AND privacyPolicy is missing,
   *  falls back to a hardcoded built-in. Same shape as
   *  privacy-policy.json#categories: array of {id, description,
   *  examples?, jevIntents[]}. Operators extend by editing
   *  config/privacy-policy.json (hot-reload picks it up via
   *  `policy/loaded` event); no env var override. */
  categories?: import('./privacy-policy.js').IntentCategory[]
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
  // §7.92.3 (2026-09-23): jev HTTP intent recognizer. Schema default
  // is `false` so a bare unit-test construction (no env) skips jev
  // entirely. The PRODUCTION default is `true` — `cordis.patch.yml`
  // reads `process.env.DSH_EDGE_INTENT_JEV_ENABLED !== 'false'`, so
  // when the env var is unset (operator's .env doesn't write it)
  // the toggle defaults to ON. §7.92.7 boot probe + breaker keep the
  // no-jev-running path fast-fail.
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
  // §7.92.6 (2026-09-24): circuit-breaker TTL. 30s gives jev a chance to
  // recover (e.g. operator restarts the container) without hammering it.
  // Operators tune down (e.g. 5s) for fast-fail rigs, or up (e.g. 5min) for
  // known-flaky services where jev outage is expected to last longer.
  jevBreakerTtlMs: Schema.natural().default(30000),
  // §7.92.7 (2026-09-24): boot probe + periodic recovery probe.
  jevBootProbeEnabled: Schema.boolean().default(true),
  jevBootProbeTimeoutMs: Schema.natural().default(2000),
  jevBreakerProbeMs: Schema.natural().default(5000),
  jevProbeTimeoutMs: Schema.natural().default(1000),
  // §7.92.3 (2026-09-23): intent category specs (descriptions + jev
  // intent lists). When privacy-policy is mounted, this is the runtime
  // override surface — tests pass categories directly. Default null:
  // constructor reads from ctx.privacyPolicy.getCategories() and only
  // falls back to a hardcoded built-in when neither is available.
  // Note: `examples` is optional in the privacy-policy.json schema (and
  // optional in IntentCategory); Schemastery's `Schema.array(...).default([])`
  // requires a non-optional inner schema so we coerce undefined → []
  // at the type level here.
  categories: Schema.array(Schema.object({
    id: Schema.union(['LOCAL', 'CLOUD', 'SANITIZED', 'REJECT'] as const).required(),
    description: Schema.string().required(),
    jevIntents: Schema.array(Schema.string()).required(),
  })).default([] as any[]),
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

/** §7.92.5 (2026-09-23): jev v0.3.0 hard cap on the `intents[]` payload
 *  field per `~/work/jev-branch/docs/api_reference.md §3.7`. ONNX model
 *  has `head_max_len=256`, which translates to ~16 intents × ~16
 *  description tokens. Source of truth is the upstream spec — bump this
 *  constant if jev ever relaxes the cap. */
const JEV_MAX_INTENTS = 16

/** §7.92.5: pure helper that splits an array into ≤ `size`-sized
 *  chunks. Used by `classifyWithJev()` to break the full
 *  `categories[].jevIntents[]` payload into batches that respect the
 *  jev v0.3.0 hard cap. Module-scope so it can be unit-tested in
 *  isolation if needed. */
function chunkIntents<T>(intents: T[], size: number = JEV_MAX_INTENTS): T[][] {
  const out: T[][] = []
  for (let i = 0; i < intents.length; i += size) {
    out.push(intents.slice(i, i + size))
  }
  return out
}

/** §7.92.3 (2026-09-23): hardcoded built-in fallback for the
 *  categories spec. Used ONLY when neither `config.categories` is set
 *  nor `ctx.privacyPolicy.getCategories()` returns a non-empty array.
 *  In normal operation the categories live in config/privacy-policy.json
 *  and are loaded by the privacy-policy service at boot — operators
 *  extend them there. The constant here keeps unit tests + early-boot
 *  paths working without requiring the privacy-policy service to be
 *  mounted. Mirrors `DEFAULT_POLICY.categories` in privacy-policy.ts:118. */
const CATEGORIES_FALLBACK: readonly import('./privacy-policy.js').IntentCategory[] = [
  {
    id: 'LOCAL',
    description: '本地文件操作、设备控制、数学计算、系统管理',
    jevIntents: ['设备控制', '文件操作', 'device_control', 'file_ops'],
  },
  {
    id: 'CLOUD',
    description: '知识问答、聊天、创意写作、需要联网的任务',
    jevIntents: ['知识问答', '通用咨询', '天气', '翻译', '新闻', '搜索', 'knowledge', 'weather', 'translation', 'news', 'search'],
  },
  {
    id: 'SANITIZED',
    description: '包含 PII 需先脱敏后路由（订单查询、账户管理、客服等含个人信息）',
    jevIntents: [
      '订单查询', '订单状态', '物流跟踪', '物流查询', '快递查询',
      '退款申请', '退款查询', '账户管理', '账户余额', '账户信息',
      '客服', '售后服务',
      'order_inquiry', 'refund', 'refund_request', 'logistics', 'account', 'customer_service',
    ],
  },
  {
    id: 'REJECT',
    description: '高危 / 违法 / 违规请求（危险系统操作、投诉、法务）',
    jevIntents: ['投诉', '法务咨询', '法律咨询', '举报', 'complaint', 'legal', 'legal_advice'],
  },
]

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
  /** §7.92.6 (2026-09-24): circuit-breaker TTL (ms). When all 3
   *  batches fail, set `jevBreakerOpenUntil = Date.now() + ttl` and
   *  classify() short-circuits jev (zero fetch) until that timestamp.
   *  Any successful batch closes the breaker (sets to 0). */
  private readonly jevBreakerTtlMs: number
  /** §7.92.6: ms-epoch timestamp until which the breaker is open.
   *  0 = closed. Mutable; reset on every Promise.all settle. */
  private jevBreakerOpenUntil = 0
  /** §7.92.7: boot probe toggle. When true, `start()` fires one
   *  `GET ${jevUrl}/health` and pre-opens the breaker on failure. */
  private readonly jevBootProbeEnabled: boolean
  /** §7.92.7: boot probe timeout (ms). */
  private readonly jevBootProbeTimeoutMs: number
  /** §7.92.7: interval between breaker-open `/health` probes (ms).
   *  Only active while the breaker is open. */
  private readonly jevBreakerProbeMs: number
  /** §7.92.7: periodic probe timeout (ms). */
  private readonly jevProbeTimeoutMs: number
  /** §7.92.7: setInterval handle for the periodic recovery probe.
   *  null = no timer running (breaker closed or probe disabled). */
  private jevBreakerProbeTimer: ReturnType<typeof setInterval> | null = null
  /** §7.92.7: in-flight boot probe promise. Tracked so a test or
   *  shutdown hook can `await stop()` without leaving a dangling
   *  fetch racing the constructor's first classify() call. */
  private jevBootProbePromise: Promise<void> | null = null
  /** §7.92.3 (2026-09-23): categories spec — loaded from
   *  privacyPolicy.getCategories() (hot-reload-aware via the policy/loaded
   *  event) and cached at construction. Drives both the LLM prompt
   *  (description field per category) AND the jev-intent → category
   *  lookup (jevIntents[] per category, flattened into jevIntentMap).
   *  Tests inject via `config.categories` to bypass privacy-policy. */
  private readonly categories: readonly import('./privacy-policy.js').IntentCategory[]
  /** §7.92.3: flat jev-intent-string → category lookup, derived from
   *  `this.categories[].jevIntents`. Built once at construction. */
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
    /** §7.92.6 (2026-09-24): circuit-breaker counters. jevCircuitOpen
     *  climbs once per "all 3 batches failed" event (suggests jev is
     *  flapping or down); jevCircuitSkip climbs per short-circuited
     *  classify() call (latency saved ≈ this × ~7500ms). */
    jevCircuitOpen: 0,
    jevCircuitSkip: 0,
    /** §7.92.7 (2026-09-24): boot probe counters. jevBootProbeOk fires
     *  when the startup `GET /health` returned 2xx (no breaker pre-open);
     *  jevBootProbeFail fires when it failed (breaker pre-opened, first
     *  classify() short-circuits). Useful for ops to know whether jev
     *  was healthy at boot. */
    jevBootProbeOk: 0,
    jevBootProbeFail: 0,
    /** §7.92.7: periodic probe counters. jevProbeAttempts = total
     *  `/health` pings while breaker open; jevRecoveredProbe = times
     *  a probe succeeded and closed the breaker (recovery was faster
     *  than waiting for full TTL). */
    jevProbeAttempts: 0,
    jevRecoveredProbe: 0,
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
    // §7.92.3 + §7.92.7: jev config. Schema default is `false` so unit
    // tests that construct the service with minimal config don't make
    // real fetches. PRODUCTION default (set by cordis.patch.yml) is
    // `true` — see schema docstring. Operators who DEFINITELY don't
    // want jev set DSH_EDGE_INTENT_JEV_ENABLED=false.
    this.jevEnabled = config.jevEnabled ?? false
    this.jevUrl = config.jevUrl ?? 'http://127.0.0.1:8001'
    this.jevTimeoutMs = config.jevTimeoutMs ?? 2500
    this.jevConfidenceThreshold = config.jevConfidenceThreshold ?? 0.85
    this.jevRiskThreshold = config.jevRiskThreshold ?? 0.7
    // §7.92.6: circuit breaker. TTL is configurable but the open flag
    // always starts closed — every fresh boot tries jev at least once
    // unless the boot probe (§7.92.7) pre-opens it (fire-and-forget).
    this.jevBreakerTtlMs = config.jevBreakerTtlMs ?? 30000
    this.jevBreakerOpenUntil = 0
    // §7.92.7: boot + recovery probe tunables.
    this.jevBootProbeEnabled = config.jevBootProbeEnabled ?? true
    this.jevBootProbeTimeoutMs = config.jevBootProbeTimeoutMs ?? 2000
    this.jevBreakerProbeMs = config.jevBreakerProbeMs ?? 5000
    this.jevProbeTimeoutMs = config.jevProbeTimeoutMs ?? 1000
    // §7.92.3: categories spec — resolution order:
    //  (1) config.categories (test override; explicit in code)
    //  (2) ctx.privacyPolicy.getCategories() (production path — loaded
    //      from config/privacy-policy.json at boot, hot-reloadable via
    //      the `policy/loaded` event)
    //  (3) CATEGORIES_FALLBACK (last-resort built-in, mirrored from
    //      DEFAULT_POLICY.categories in privacy-policy.ts; identical
    //      content so unit tests + early-boot paths stay sane when the
    //      privacy-policy service isn't wired)
    const policyCategories = (() => {
      const policy = this.softService('privacyPolicy')
      try { return policy?.getCategories?.() ?? [] }
      catch { return [] }
    })()
    const cats = (config.categories && config.categories.length > 0)
      ? config.categories
      : (policyCategories.length > 0 ? policyCategories : CATEGORIES_FALLBACK)
    this.categories = cats
    // Flatten categories[].jevIntents → single lookup map. Iterating once
    // at construction keeps classifyWithJev() at O(1) per call.
    const map: Record<string, 'LOCAL' | 'CLOUD' | 'SANITIZED' | 'REJECT'> = {}
    for (const cat of cats) {
      for (const intent of cat.jevIntents) {
        map[intent] = cat.id
      }
    }
    this.jevIntentMap = map
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

  /** §7.92.5 (2026-09-23): build the full jev `intents[]` payload from
   *  `this.categories[]`. Two-phase priority, NO 16-cap (the cap is
   *  enforced one level up by `chunkIntents()`):
   *
   *    Phase 1: emit every REJECT category's jevIntents first
   *             (security priority — must not be dropped)
   *    Phase 2: emit all other categories in `categories[]` config order
   *             (LOCAL → CLOUD → SANITIZED by default)
   *
   *  Dedup by name via a Set<string> so operators who accidentally list
   *  the same intent in two categories don't produce a duplicate name
   *  (which would confuse jev's own zero-shot classifier).
   *
   *  Returns the un-truncated array — the orchestrator batches it. */
  private buildJevIntentsPayload(): Array<{ name: string; description: string }> {
    const out: Array<{ name: string; description: string }> = []
    const seen = new Set<string>()
    const push = (cat: import('./privacy-policy.js').IntentCategory) => {
      for (const intent of cat.jevIntents) {
        if (seen.has(intent)) continue
        seen.add(intent)
        out.push({ name: intent, description: cat.description })
      }
    }
    for (const cat of this.categories) {
      if (cat.id === 'REJECT') push(cat)
    }
    for (const cat of this.categories) {
      if (cat.id !== 'REJECT') push(cat)
    }
    return out
  }

  /** §7.92.5 (2026-09-23): single-batch jev fetcher. Extracted from
   *  the old monolithic `classifyWithJev()` so the orchestrator can
   *  fire N concurrent calls via `Promise.all` and merge the results.
   *
   *  Takes the same `text` + `sessionId` as the old function, plus an
   *  already-≤16 `intents[]` slice and `chitchatIntents` (defensive
   *  marker for jev v0.3.0+). Returns the same shape:
   *  - `action: 'reject' | 'adopt' | 'skip'`
   *  - `confidence` / `riskScore` / `latencyMs` (always set)
   *  - `skipReason` when action='skip' — caller can tell whether to
   *    retry the verdict on the next batch (we don't — we just merge)
   *
   *  Every audit / counter side-effect for THIS batch fires here, not
   *  in the orchestrator, so partial failures are observable per-batch
   *  in the JSONL audit stream. */
  private async fetchJevBatch(
    text: string,
    sessionId: string | undefined,
    intents: Array<{ name: string; description: string }>,
    chitchatIntents: string[],
    jevStart: number,
  ): Promise<{
    action: 'reject' | 'adopt' | 'skip'
    intent?: Intent
    jevIntentString?: string
    confidence: number
    riskScore: number
    latencyMs: number
    skipReason?: string
  }> {
    const batchStart = Date.now()
    this.audit('debug', 'intent.jev.batch.start', {
      textLen: text.length,
      batchSize: intents.length,
      batchLatencyBudgetMs: this.jevTimeoutMs,
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
          // §7.92.5: jev v0.3.0+ zero-shot taxonomy. Without these
          // fields jev falls back to its built-in 8-intent default
          // schema and our `categories[].jevIntents[]` table never
          // gets used. Each batch carries ≤ 16 intents (chunked by
          // classifyWithJev).
          intents,
          chitchat_intents: chitchatIntents,
        }),
        signal: controller.signal,
      })
      if (!r.ok) {
        this.stats.jevError++
        this.audit('warn', 'intent.jev.error', {
          httpStatus: r.status,
          batchLatencyMs: Date.now() - batchStart,
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
          batchLatencyMs: Date.now() - batchStart,
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
        batchLatencyMs: Date.now() - batchStart,
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
      batchLatencyMs: Date.now() - batchStart,
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

  /** §7.92.5 (2026-09-23): jev HTTP prefilter — batched orchestrator.
   *  Splits the full `categories[].jevIntents[]` payload into ≤16-size
   *  batches (jev v0.3.0 hard cap from `head_max_len=256`), fires all
   *  batches concurrently via `Promise.all`, and merges the verdicts
   *  with a max-confidence pick:
   *
   *    1. Any `reject` action → pick highest `riskScore` (security signal)
   *    2. Else any `adopt` action → pick highest `confidence`; tie-break
   *       by earlier batch index (REJECT-priority intents live in
   *       batch 0, so the security-first ordering is preserved on ties)
   *    3. Else all skipped → return the first skip result
   *
   *  Returns one of:
   *  - `action: 'reject'`  → `risk_score >= jevRiskThreshold` (security-level)
   *  - `action: 'adopt'`   → `data.action === 'execute'`, confidence ≥
   *                           threshold, intent string found in jevIntentMap
   *                           (mapped to realm)
   *  - `action: 'skip'`    → any other condition (low-conf, fallback_llm,
   *                           unrecognized intent, transport / parse error).
   *                           Caller falls through to classifyWithLlm.
   *
   *  Failure handling: every per-batch error path (timeout, network,
   *  parse) is audited at warn level and produces `action: 'skip'` for
   *  THAT batch — jev being unavailable MUST NOT degrade the existing
   *  LLM classification path. This is the same fail-open contract used
   *  by classifyWithLlm's classifyWithRules fallback.
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
    // §7.92.6 (2026-09-24): circuit breaker — short-circuit if a
    // previous classify() within the TTL window saw all 3 batches
    // fail. Saves up to ~3 × jevTimeoutMs = 7500ms wall-clock on every
    // chat when jev is dead. Operators see "circuit open" once in
    // audit, then this debug-level skip per call until recovery.
    if (Date.now() < this.jevBreakerOpenUntil) {
      this.stats.jevCircuitSkip++
      this.audit('debug', 'intent.jev.circuit_open_skip', {
        textLen: text.length,
        jevUrl: this.jevUrl,
        openUntilMs: this.jevBreakerOpenUntil,
        remainingMs: this.jevBreakerOpenUntil - Date.now(),
      })
      return {
        action: 'skip',
        confidence: 0,
        riskScore: 0,
        latencyMs: 0,
        skipReason: 'jev-circuit-open',
      }
    }

    const jevStart = Date.now()
    const allIntents = this.buildJevIntentsPayload()
    const chitchatIntents = ['闲聊', '其他'] // §7.92.5: defensive marker for jev v0.3.0+
    const batches = chunkIntents(allIntents, JEV_MAX_INTENTS)
    this.audit('debug', 'intent.jev.start', {
      textLen: text.length,
      jevUrl: this.jevUrl,
      timeoutMs: this.jevTimeoutMs,
      batchCount: batches.length,
      totalIntents: allIntents.length,
    })

    // Fire all batches concurrently. Per-batch timeout is still
    // `this.jevTimeoutMs` — wall-clock is bounded by the slowest batch.
    const settled = await Promise.all(
      batches.map((intents) =>
        this.fetchJevBatch(text, sessionId, intents, chitchatIntents, jevStart),
      ),
    )

    // §7.92.6: breaker state machine. "All 3 batches failed" = every
    // settled result has skipReason ∈ {'jev-error', 'jev-timeout'}.
    // Any successful batch (HTTP 2xx + parse OK, even action=
    // 'fallback_llm') means jev is reachable and we close the breaker.
    const allBatchesFailed = settled.every(
      (r) => r.skipReason === 'jev-error' || r.skipReason === 'jev-timeout',
    )
    if (allBatchesFailed) {
      this.jevBreakerOpenUntil = Date.now() + this.jevBreakerTtlMs
      this.stats.jevCircuitOpen++
      this.audit('warn', 'intent.jev.circuit_open', {
        openUntilMs: this.jevBreakerOpenUntil,
        ttlMs: this.jevBreakerTtlMs,
        jevUrl: this.jevUrl,
        batchCount: settled.length,
      })
      // §7.92.7 (2026-09-24): start the recovery probe so we don't have
      // to wait for full TTL once jev comes back. No-op when a probe
      // timer is already running (e.g. breaker re-opened by classify()
      // racing the timer's own check).
      this.startBreakerProbe()
    } else {
      // Healthy response — clear the breaker. Any subsequent classify()
      // within the original TTL window that previously would have been
      // skipped will now hit jev normally. Also stop the recovery
      // probe timer — no longer needed.
      this.jevBreakerOpenUntil = 0
      this.stopBreakerProbe()
    }

    // Max-confidence merge. Priority order:
    //   1. Any reject → pick highest risk_score (security signal)
    //   2. Else any adopt → pick highest confidence; tie-break by batch
    //      index (earlier batches contain REJECT-priority intents, so
    //      they're preferred on ties — i.e. SECURITY-first tie-break)
    //   3. Else all skipped → return the first skip
    let best: Awaited<ReturnType<typeof this.fetchJevBatch>> | null = null
    for (let i = 0; i < settled.length; i++) {
      const r = settled[i]
      if (!best) { best = r; continue }
      if (r.action === 'reject' && (best.action !== 'reject' || r.riskScore > best.riskScore)) {
        best = r
      } else if (r.action === 'adopt' && best.action !== 'reject') {
        if (best.action !== 'adopt' || r.confidence > best.confidence) best = r
      } else if (r.action === 'skip' && best.action === 'skip' && !best.skipReason) {
        best = r
      }
    }

    return best ?? {
      action: 'skip',
      confidence: 0,
      riskScore: 0,
      latencyMs: Date.now() - jevStart,
      skipReason: 'all-batches-empty',
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
    //
    // §7.92.3 (2026-09-23): category list is built from
    // `this.categories` (loaded from config/privacy-policy.json via the
    // privacy-policy service, hot-reloadable). Replaces the previous
    // hardcoded 2-category block — now the LLM sees ALL of LOCAL/CLOUD/
    // SANITIZED/REJECT, matching jev's 4-category capability and giving
    // the LLM a path to surface SANITIZED/REJECT verdicts without a
    // separate rules pass. Order matches categories[] order in the
    // policy file so operators can control priority by reordering rows.
    const categoryLines = this.categories.map((c) => `- ${c.id}：${c.description}`).join('\n')
    const categoryUnion = this.categories.map((c) => c.id).join('|')
    const prompt = `判断以下用户请求属于哪类：
${categoryLines}
${historyBlock}
Respond ONLY with a single JSON object — no prose, no Markdown:
{ "category": ${categoryUnion}, "confidence": <0.0-1.0> }

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
    // §7.100: error-finish chunk capture (see loop below); declared outside
    // the try so the post-loop throw isn't swallowed by our own catch.
    let providerFailure: { code?: string; message?: string } | undefined

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
        } else if (chunk.type === 'finish') {
          // §7.100: adapter 侧错误（NO_ADAPTER / NO_CLOUD_TARGET / key 缺失…）
          // 被上游转成 terminal error finish chunk，不 throw。以前这里零
          // text-delta → 落到 'unclear' 分支，dashboard 把基础设施故障记成
          // "模型输出看不懂"。现在显式识别，归因 llm-error + provider_error。
          // （检测放 try 外抛出，避免本函数 catch 二次计数/重包裹。）
          const reason = (chunk as any).reason
          if (reason?.kind === 'error' || reason?.kind === 'aborted') {
            providerFailure = { code: reason.failure?.code, message: reason.failure?.message }
          }
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

    // §7.100: 基础设施故障（error/aborted finish chunk，非 throw）显式归因为
    // llm-error + provider_error 事件，让 dashboard 能把"provider 挂了"和
    // "模型话看不懂"分开；随后走既有 rules fallback（classify() 外层 catch）。
    if (providerFailure && responseText.trim().length === 0) {
      this.stats.llmError++
      this.audit('warn', 'intent.llm.provider_error', {
        provider,
        model,
        code: providerFailure.code ?? 'UNKNOWN',
        error: (providerFailure.message ?? '').slice(0, 200),
        chunks,
      })
      const e: any = new Error(`intent-router: provider error: ${providerFailure.code ?? 'UNKNOWN'}`)
      e._intentRouterReason = 'llm-error'
      throw e
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
      // §7.92.3 (2026-09-23): map all 4 verdict categories to targetRealm.
      // Previously was binary LOCAL/CLOUD; the LLM can now return
      // SANITIZED / REJECT directly so targetRealm must mirror them.
      targetRealm: verdict.category === 'LOCAL' ? 'local'
        : verdict.category === 'CLOUD' ? 'cloud'
        : verdict.category === 'SANITIZED' ? 'sanitized'
        : 'rejected',
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
  /** §7.92.7 (2026-09-24): boot-time health probe. Fires once at
   *  `start()` (called from `apply()`). Fire-and-forget — does NOT
   *  block plugin init. On 2xx → no-op (the breaker stays closed;
   *  classify() proceeds normally). On non-2xx / network error /
   *  timeout → pre-opens the breaker for `jevBreakerTtlMs` so the
   *  first classify() short-circuits instead of paying
   *  3 × `jevTimeoutMs` wall-clock.
   *
   *  Why fire-and-forget: blocking plugin init on a 2s jev probe
   *  adds 2s to cold boot, and a chat-less boot (e.g. CI smoke) has
   *  no classify() to gate. Race against first classify() is fine
   *  because: (1) plugin apply() runs before http-api opens its
   *  port, so the earliest chat is several hundred ms away, (2) if
   *  classify() runs first it just trips the breaker the normal
   *  way (3 batch fails) — same outcome as the probe. */
  start(): void {
    if (!this.jevEnabled) return
    if (!this.jevBootProbeEnabled) {
      this.audit('debug', 'intent.jev.boot_probe.skipped', {
        reason: 'disabled-by-config',
        jevUrl: this.jevUrl,
      })
      return
    }
    // Capture the promise so stop() can await it on shutdown.
    this.jevBootProbePromise = this.probeJevHealth('boot', this.jevBootProbeTimeoutMs, true)
      .then((ok) => {
        if (!ok) {
          // Pre-open breaker AND start the periodic recovery probe
          // — otherwise jev coming back online during the 30s TTL
          // would have to wait full TTL for the breaker to close.
          // The probe will close the breaker (and stop itself) the
          // moment /health returns 2xx.
          this.jevBreakerOpenUntil = Date.now() + this.jevBreakerTtlMs
          this.startBreakerProbe()
        }
      })
      .catch((err: any) => {
        // Defensive — `probeJevHealth` swallows transport errors and
        // resolves false; reaching this branch means a bug in the
        // probe itself. Log and keep the breaker closed (fail-open
        // for the probe path).
        this.audit('error', 'intent.jev.boot_probe.unexpected', {
          error: err?.message ?? String(err),
        })
      })
      .finally(() => {
        this.jevBootProbePromise = null
      })
  }

  /** §7.92.7: dispose hook. Awaits the in-flight boot probe (if
   *  any) and clears the recovery-probe timer. Tests call this to
   *  keep the event loop clean between cases; cordis calls this
   *  on plugin teardown. */
  async stop(): Promise<void> {
    this.stopBreakerProbe()
    if (this.jevBootProbePromise) {
      try { await this.jevBootProbePromise } catch { /* swallow */ }
    }
  }

  /** §7.92.7: probe jev `/health`. Returns true on HTTP 2xx, false
   *  on anything else (network error, timeout, non-2xx). Always
   *  resolves — never throws. The `phase` arg distinguishes boot-time
   *  vs periodic-recovery audit kinds so ops can tell them apart in
   *  the log. */
  private async probeJevHealth(
    phase: 'boot' | 'periodic',
    timeoutMs: number,
    preOpenBreaker: boolean,
  ): Promise<boolean> {
    if (phase === 'periodic') this.stats.jevProbeAttempts++
    const probeStart = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let ok = false
    let httpStatus = 0
    let errorMsg = ''
    try {
      const r = await fetch(`${this.jevUrl}/health`, {
        method: 'GET',
        signal: controller.signal,
      })
      httpStatus = r.status
      ok = r.ok
      if (!ok) {
        try { await r.text() } catch { /* ignore */ }
      }
    } catch (err: any) {
      errorMsg = err?.message ?? String(err)
    } finally {
      clearTimeout(timer)
    }
    const latencyMs = Date.now() - probeStart
    if (phase === 'boot') {
      if (ok) {
        this.stats.jevBootProbeOk++
        this.audit('info', 'intent.jev.boot_probe', {
          jevUrl: this.jevUrl,
          httpStatus,
          latencyMs,
          ok: true,
        })
      } else {
        this.stats.jevBootProbeFail++
        this.audit('warn', 'intent.jev.boot_probe', {
          jevUrl: this.jevUrl,
          httpStatus,
          latencyMs,
          ok: false,
          error: errorMsg,
          preOpenBreaker,
          // Useful for ops: how long classify() will short-circuit.
          openUntilMs: preOpenBreaker ? Date.now() + this.jevBreakerTtlMs : 0,
        })
      }
    } else {
      // periodic probe (always inside an open-breaker window)
      this.jevLastProbeLatencyMs = latencyMs
      this.audit(ok ? 'debug' : 'debug', 'intent.jev.probe', {
        jevUrl: this.jevUrl,
        httpStatus,
        latencyMs,
        ok,
        error: ok ? undefined : errorMsg,
      })
    }
    return ok
  }

  /** §7.92.7: start the recovery probe setInterval. Idempotent.
   *  Called from classifyWithJev() right after `jevBreakerOpenUntil`
   *  is set. When the periodic probe lands on 2xx it closes the
   *  breaker (and stops itself) — recovery is faster than waiting
   *  for full TTL. */
  private startBreakerProbe(): void {
    if (this.jevBreakerProbeTimer !== null) return // already running
    // unref so the timer never holds the process open by itself
    // (mirrors file-logger.ts:220 pattern).
    this.jevBreakerProbeTimer = setInterval(() => {
      void this.probeJevHealth('periodic', this.jevProbeTimeoutMs, false)
        .then((ok) => {
          if (!ok) return
          // 2xx from /health → jev is back. Close the breaker
          // and stop the timer. classify() calls now hit jev
          // normally; one of them may still trip the breaker
          // again if /predict is broken (different endpoint),
          // but the breaker restart path is already covered by
          // classifyWithJev()'s post-Promise.all branch.
          if (Date.now() < this.jevBreakerOpenUntil) {
            this.jevBreakerOpenUntil = 0
            this.stats.jevRecoveredProbe++
            this.audit('info', 'intent.jev.recovered', {
              jevUrl: this.jevUrl,
              probeLatencyMs: this.jevProbeTimerLatency(),
            })
          }
          this.stopBreakerProbe()
        })
        .catch(() => { /* probeJevHealth never throws; defensive */ })
    }, this.jevBreakerProbeMs)
    if (typeof this.jevBreakerProbeTimer.unref === 'function') {
      this.jevBreakerProbeTimer.unref()
    }
  }

  /** §7.92.7: clear the recovery probe setInterval. Idempotent. */
  private stopBreakerProbe(): void {
    if (this.jevBreakerProbeTimer === null) return
    clearInterval(this.jevBreakerProbeTimer)
    this.jevBreakerProbeTimer = null
  }

  /** §7.92.7 helper: wall-clock spent in the most recent successful
   *  probe (used in `intent.jev.recovered` audit payload). The
   *  setInterval callback captures `probeStart` in its closure but
   *  doesn't surface it cleanly — keep this lightweight by storing
   *  the latest observed latency in instance state. */
  private jevLastProbeLatencyMs = 0
  private jevProbeTimerLatency(): number { return this.jevLastProbeLatencyMs }

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
  /** §7.92.3 (2026-09-23): widened from the historical 2-category union
   *  (LOCAL | CLOUD) to match the categories spec in privacy-policy.json
   *  — the LLM prompt now lists all 4 (LOCAL/CLOUD/SANITIZED/REJECT),
   *  so the verdict parser must accept them too. The downstream code
   *  (entity guardrail, classifyWithRules fallback, etc.) was already
   *  4-category-aware via `RULE_CATEGORIES`. */
  category: 'LOCAL' | 'CLOUD' | 'SANITIZED' | 'REJECT'
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
  /** §7.92.6 (2026-09-24): circuit-breaker opened N times in this
   *  process lifetime. Climbs → jev service is flapping. Pair with
   *  jevCircuitSkip to estimate total bypassed latency: each skip
   *  avoided ~3 × jevTimeoutMs = 7500ms worst-case wall-clock. */
  jevCircuitOpen: number
  /** §7.92.6: classify() calls that returned early because breaker
   *  was open. Total latency saved ≈ jevCircuitSkip × 7500ms. */
  jevCircuitSkip: number
  /** §7.92.7 (2026-09-24): boot probe counters. jevBootProbeOk
   *  climbs when the startup `GET /health` returned 2xx; jevBootProbeFail
   *  climbs when it failed (breaker pre-opened, first classify()
   *  short-circuits). Operators compare these to gauge whether jev
   *  is consistently unhealthy at boot. */
  jevBootProbeOk: number
  jevBootProbeFail: number
  /** §7.92.7: periodic recovery probe counters. jevProbeAttempts =
   *  total `/health` pings fired while the breaker was open;
   *  jevRecoveredProbe = times a probe succeeded and closed the
   *  breaker (recovery was faster than waiting for full TTL).
   *  Healthy ratio ≈ jevRecoveredProbe / jevProbeAttempts. */
  jevProbeAttempts: number
  jevRecoveredProbe: number
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
  // §7.92.3 (2026-09-23): accept the full 4-category union so the LLM
  // can return SANITIZED / REJECT verdicts directly (previously dropped
  // → fallback path; now they reach the §7.58 entity guardrail + the
  // outer REJECT short-circuit unchanged). Categories outside the
  // union (typos, lowercase 'sanitized' before .toUpperCase, etc.) still
  // return null → outer classify() falls through to classifyWithRules.
  if (cat !== 'LOCAL' && cat !== 'CLOUD' && cat !== 'SANITIZED' && cat !== 'REJECT') return null
  const confRaw = typeof o.confidence === 'number'
    ? o.confidence
    : typeof o.confidence === 'string' ? Number(o.confidence) : NaN
  const conf = Number.isFinite(confRaw) ? Math.max(0, Math.min(1, confRaw)) : 0.5
  return { category: cat as 'LOCAL' | 'CLOUD' | 'SANITIZED' | 'REJECT', confidence: conf }
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
  // §7.92.7 (2026-09-24): fire boot probe (fire-and-forget). The
  // probe pre-opens the breaker if jev is down so first classify()
  // short-circuits instead of paying 3 × jevTimeoutMs wall-clock.
  service.start()
  return async () => {
    await service.stop()
  }
}