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
import {
  danglingSecretRefs,
  formatDanglingSecretRefs,
  jevPool,
  loadEdgeConfig,
  localPool,
} from './edge-config.js'
import { resolveEffectiveLocalModel } from './effective-model.js'
import { withInternalCaller } from './llm-internal-caller.js'
import {
  buildRequestTrace,
  buildResponseTrace,
  emitTrace,
  resolveLlmTraceConfig,
  type TraceSink,
} from './llm-trace.js'
import { getTraceStore, nextCallId } from './llm-trace-store.js'
import { sessionIdField } from './session-attribution.js'

export const name = 'intent-router'

export const inject = ['llm', 'auditLog', 'privacyPolicy'] as const

/** Minimal interface our router needs from the audit-log service. */
interface AuditLike {
  log(entry: { level: 'debug' | 'info' | 'warn' | 'error' | 'security'; kind: string; source: string; payload: Record<string, unknown> }): Promise<unknown>
}

/**
 * §7.122: 端点是否落在本机。
 *
 * provider 名（`local-llm`）**不代表**落点 —— config/edge.json 的
 * `llm.local.baseUrl` 可以是任何地址，包括公网。operator 要判断
 * 「这轮原文有没有出网」，看的是落点，不是名字。
 *
 * §7.130: 主人裁决——「是否出网」的判据是 **category（哪个池）**，不是端点
 * 落在哪台机。本函数仍然有用（§7.122 的分类器落点披露是备查信息），但它
 * **不参与出网判断**：local 池是 operator 自有设施，端点不在本机也不算出网。
 */
export function isLoopbackEndpoint(endpoint: string | undefined): boolean {
  if (endpoint === undefined || endpoint.trim().length === 0) return false
  let host: string
  try {
    host = new URL(endpoint).hostname
  } catch {
    return false
  }
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
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
  /** §7.115 (2026-10-25): decision-model-only mode — false = the LLM
   *  classifier never runs; a jev skip goes straight to the rules tier +
   *  default LOCAL (fail-closed). Default true. */
  llmFallback?: boolean
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
   *  DSH_EDGE_INTENT_CLOUD_KEYWORDS (comma-sep) — appended to built-in.
   *  §7.108: the policy file's stages.intent.cloudKeywords ALSO appends
   *  (hot-reloadable) — preferred operator surface. */
  cloudKeywords?: string[]
  /** §7.58 (2026-09-16): LOCAL-entity list (密盒/ets/etscli built-in)
   *  matched before every keyword layer and used to override a non-LOCAL
   *  LLM verdict. Env DSH_EDGE_INTENT_LOCAL_ENTITIES (comma-sep) appends to
   *  built-in (NOT replaces), same semantics as cloudKeywords. §7.108:
   *  policy-file stages.intent.localEntities also appends (hot-reloadable). */
  localEntities?: string[]
  /** §7.124 (2026-10-27): 家庭设备操作正则层的扩展词表（追加到内置词表）。 */
  deviceCommands?: { devices?: string[]; actions?: string[] }
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
  /** §7.112 (2026-10-25): jev backend kind. 'local' = the ONNX /predict
   *  contract (default); 'bailian-decision' = Alibaba's decision-model
   *  /systemone structured-decision interface — one call carries the whole
   *  taxonomy as choice/score questions (no 16-intent cap, no chitchat
   *  markers). Env DSH_EDGE_INTENT_JEV_PROVIDER. */
  jevProvider?: 'local' | 'bailian-decision'
  /** §7.112: decision-model id (bailian-decision only, e.g.
   *  'decision-model-preview'). Env DSH_EDGE_INTENT_JEV_MODEL. */
  jevModel?: string
  /** §7.112: literal Authorization key (edge.json jev.apiKeyRef →
   *  secrets.*). Bailian MaaS requires it; local ONNX never did. */
  jevApiKey?: string
  /** §7.112: 'raw' = `Authorization: <key>` (org systemone examples);
   *  'bearer' = `Authorization: Bearer <key>` (compatible-mode
   *  convention). Default 'raw'. */
  jevAuthScheme?: 'raw' | 'bearer'
  /** §7.114 (2026-10-25): classify path appended to jevUrl. '/systemone'
   *  (default) = the MaaS deployments; a local MLX serve of the same
   *  contract exposes '/v1/classify' — point jevUrl at its /v1 root and
   *  set '/classify'. The decision model is a config-file-bound EXTERNAL
   *  service: url/path/model/key all live in edge.json, zero hardcoding. */
  jevPath?: string
  /** §7.115: directional confidence gate — a LOCAL-leaning decision-model
   *  verdict adopts at this floor (default 0.5) instead of paying the LLM
   *  round-trip for a second opinion; non-LOCAL (data may leave the device)
   *  keeps the strict jevConfidenceThreshold. */
  jevLocalAdoptFloor?: number
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
    // §7.107 (2026-10-23, operator ruling「默认应该是本地，而不是云端」):
    // the ladder so far was 'CLOUD' (2026-08) → 'SANITIZED' (2026-09-02 —
    // the classifier was silent, so scrub the text and egress anyway).
    // Neither rung is "local": both eventually leave the device. The ruling
    // is one step further — an UNDECIDED turn stays on the device.
    //
    // The cloud is now reached only through an explicit signal: the
    // privacy-policy's public-web rule, a CLOUD keyword, a confident
    // classifier verdict that names a web need, or a caller-supplied route.
    // Consequence: an install with no local endpoint can no longer answer
    // at all — fail-closed with an actionable error (input-guard's
    // `local.route-missing`), by design.
    .default('LOCAL'),
  classificationProvider: Schema.string().default('local-llm'),
  // §7.115: decision-model-only mode switch (see Config docs).
  llmFallback: Schema.boolean(),
  // §7.102: the classification model follows the LOCAL pool in
  // config/edge.json (llm.local.model). The Schema default is only a
  // last-resort fallback when no config file is present at all.
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
  // §7.124 (2026-10-27): 家庭设备操作正则层的 operator 扩展点。追加到内置
  // 词表（不替换）——运维加一个新电器名只改 config/edge.json 一行。
  deviceCommands: Schema.object({
    devices: Schema.array(Schema.string()).default([] as string[]),
    actions: Schema.array(Schema.string()).default([] as string[]),
  }).default({ devices: [], actions: [] } as any),
  // §7.92.3 (2026-09-23): jev HTTP intent recognizer. Schema default
  // is `false` so a bare unit-test construction (no env) skips jev
  // entirely. §7.102: the toggle's value now comes from config/edge.json
  // (jev.enabled, production default false — §7.182 owner ruling) via
  // apply()'s file-fill; the
  // Schema carries no default so "patch row did not configure it" stays
  // distinguishable from an explicit value. The literal fallbacks live in
  // the constructor (this.jevXxx = config.jevXxx ?? …) and match the old
  // schema defaults verbatim. §7.92.7 boot probe + breaker keep the
  // no-jev-running path fast-fail.
  jevEnabled: Schema.boolean(),
  jevUrl: Schema.string(),
  // §7.112: Bailian decision-model backend surface.
  jevProvider: Schema.union(['local', 'bailian-decision'] as const),
  jevModel: Schema.string(),
  jevApiKey: Schema.string(),
  jevAuthScheme: Schema.union(['raw', 'bearer'] as const),
  jevPath: Schema.string(),
  jevLocalAdoptFloor: Schema.number(),
  // 2.5s = comfortably above jev's documented P95 (< 300ms) with headroom
  // for cold-start model load + inter-container network jitter. Smaller
  // than `llmTimeoutMs` (default 4-30s) so jev-as-prefilter still saves
  // the operator's overall chat budget on jev-failure paths.
  jevTimeoutMs: Schema.natural(),
  // Mirrors jev's built-in `execute` gate (>= 0.85). Operators tune lower
  // (e.g. 0.70) to trade more jev-adopts for higher mis-route risk.
  jevConfidenceThreshold: Schema.number().min(0).max(1),
  // Mirrors jev's built-in risk-score gate (>= 0.7 → clarify → REJECT).
  jevRiskThreshold: Schema.number().min(0).max(1),
  // §7.92.6 (2026-09-24): circuit-breaker TTL. 30s gives jev a chance to
  // recover (e.g. operator restarts the container) without hammering it.
  // Operators tune down (e.g. 5s) for fast-fail rigs, or up (e.g. 5min) for
  // known-flaky services where jev outage is expected to last longer.
  jevBreakerTtlMs: Schema.natural(),
  // §7.92.7 (2026-09-24): boot probe + periodic recovery probe.
  jevBootProbeEnabled: Schema.boolean(),
  jevBootProbeTimeoutMs: Schema.natural(),
  jevBreakerProbeMs: Schema.natural(),
  jevProbeTimeoutMs: Schema.natural(),
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
  /**
   * §7.123 (2026-10-27): provenance of `confidence`.
   *
   * `false` means "this number is a PLACEHOLDER, not a reported confidence"
   * — today only the bailian decision-model path produces it: the backend
   * returns a `choice` without a numeric confidence, so the decoder
   * substitutes a synthetic 0.9 ("decisive-by-construction"). A synthetic
   * value must not be able to satisfy an operator's *semantic trust*
   * threshold (stages.intent.semanticCloudMinConfidence), because the
   * operator is trusting a measurement that does not exist.
   *
   * `undefined` = reported (the normal case: LLM classifier, local ONNX
   * jev, rules tier). Only `false` disables the semantic unlock.
   */
  confidenceReported?: boolean
}

export interface IntentRouterService {
  classify(text: string, context?: { recentMessages?: unknown[]; sessionId?: string }): Promise<Intent>
  /**
   * §7.107: does this text ask for PUBLIC-WEB information?
   *
   * The operator's ruling: the cloud LLM is only for "需要搜索公网上的信息".
   * This is the signal that unlocks the cloud — a CLOUD verdict from any
   * other tier (a confident local classifier, a caller route) is honoured
   * only when this returns a keyword.
   *
   * The keyword list is the same one the rules tier uses (built-in
   * information-acquisition words + `stages.intent.cloudKeywords`), so the
   * gate and the rules tier can never disagree about what counts as a
   * web need.
   */
  cloudSignal(text: string): string | undefined
  resolve(intent: Intent): { realm: string; config: Record<string, unknown> }
  /** Snapshot of in-memory counters. O(1) read for ops dashboards. */
  getStats(): IntentRouterStats
}

/** Built-in last-resort LOCAL keyword list (EN + CN). Used only when
 *  privacy-policy is absent / empty AND `config.fallbackKeywords` is unset.
 *  Users override via env `DSH_EDGE_INTENT_FALLBACK_KEYWORDS` (comma-sep).
 *
 *  §7.123 (2026-10-27): moved to `./intent-signals.ts` — the strategy DATA
 *  (keyword tables, entity tables, the fallback taxonomy) now lives apart
 *  from the decision LOGIC in this file. */
import {
  LOCAL_KEYWORDS_DEFAULT,
  CLOUD_KEYWORDS_DEFAULT,
  LOCAL_ENTITY_KEYWORDS_DEFAULT,
  JEV_MAX_INTENTS,
  CATEGORIES_FALLBACK,
  RULE_CATEGORIES,
  matchDeviceCommand,
} from './intent-signals.js'
import {
  buildClassificationPrompt,
  buildJevIntentCriteria,
  JEV_INTENT_INSTRUCTIONS,
  JEV_RISK_INSTRUCTIONS,
  JEV_RISK_CRITERIA,
} from './intent-prompts.js'

export {
  LOCAL_KEYWORDS_DEFAULT,
  CLOUD_KEYWORDS_DEFAULT,
  LOCAL_ENTITY_KEYWORDS_DEFAULT,
  JEV_MAX_INTENTS,
  CATEGORIES_FALLBACK,
  RULE_CATEGORIES,
}

/** §7.92.5: pure helper that splits an array into ≤ `size`-sized
 *  chunks. Used by `classifyWithJev()` to break the full
 *  `categories[].jevIntents[]` payload into batches that respect the
 *  jev v0.3.0 hard cap. Module-scope so it can be unit-tested in
 *  isolation if needed. */
/** §7.112 (2026-10-25): best-effort extraction of the decision-model's
 *  answers map from a not-yet-frozen response envelope. The systemone
 *  contract is new — tolerate the shapes plausible in compatible-mode
 *  deployments:
 *    { answers: { intent: ..., risk: ... } }            — canonical
 *    { output: { answers: ... } }                        — DashScope native
 *    { choices: [{ message: { content: '<json>' } }] }   — chat-completions wrap
 *    { intent: ..., risk: ... }                          — flat
 *  Returns the first object (depth-first, ≤6 levels) carrying ≥1 question
 *  key; null when none does. */
function extractDecisionAnswers(parsed: any, keys: string[]): Record<string, unknown> | null {
  if (!parsed || typeof parsed !== 'object') return null
  const content = parsed?.choices?.[0]?.message?.content
  if (typeof content === 'string') {
    try {
      const fromInner = extractDecisionAnswers(JSON.parse(content), keys)
      if (fromInner) return fromInner
    } catch { /* content was prose — keep walking the outer envelope */ }
  }
  const visit = (node: any, depth: number): Record<string, unknown> | null => {
    if (!node || typeof node !== 'object' || depth > 6) return null
    if (Array.isArray(node)) {
      for (const item of node) {
        const hit = visit(item, depth + 1)
        if (hit) return hit
      }
      return null
    }
    if (keys.some((k) => k in node)) return node as Record<string, unknown>
    for (const value of Object.values(node)) {
      const hit = visit(value, depth + 1)
      if (hit) return hit
    }
    return null
  }
  return visit(parsed, 0)
}

function chunkIntents<T>(intents: T[], size: number = JEV_MAX_INTENTS): T[][] {
  const out: T[][] = []
  for (let i = 0; i < intents.length; i += size) {
    out.push(intents.slice(i, i + size))
  }
  return out
}

export class IntentRouterServiceImpl extends Service {
  private readonly defaultCategory: Intent['category']
  private readonly classificationProvider: string
  private readonly classificationModel: string
  private readonly confidenceThreshold: number
  private readonly llmFallback: boolean
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
  /** §7.124: operator-extended device-command terms (ADDITIVE on top of the
   * built-in vocabulary in ./intent-signals.ts). */
  private readonly deviceCommandOverrides: { devices: readonly string[]; actions: readonly string[] }
  /** §7.92.3 (2026-09-23): jev HTTP intent recognizer (toggle). When
   *  true, classify() invokes classifyWithJev() BEFORE classifyWithLlm(). */
  private readonly jevEnabled: boolean
  /** §7.92.3: jev base URL, e.g. `http://127.0.0.1:8001`. */
  private readonly jevUrl: string
  /** §7.112: Bailian decision-model backend surface (see Config docs). */
  private readonly jevProvider: 'local' | 'bailian-decision'
  private readonly jevModel: string
  private readonly jevApiKey: string | undefined
  private readonly jevAuthScheme: 'raw' | 'bearer'
  private readonly jevPath: string
  private readonly jevLocalAdoptFloor: number
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
  /** §7.92.3 (2026-09-23) + §7.108 (2026-10-24): categories spec — loaded
   *  from privacyPolicy.getCategories() at construction AND refreshed on
   *  every `policy/loaded` event when the spec came from the policy
   *  service (config.categories keeps its explicit-override semantics and
   *  is never refreshed). Drives both the LLM prompt (description field
   *  per category) AND the jev-intent → category lookup (jevIntents[] per
   *  category, flattened into jevIntentMap). Tests inject via
   *  `config.categories` to bypass privacy-policy. */
  private categories: readonly import('./privacy-policy.js').IntentCategory[]
  /** §7.92.3: flat jev-intent-string → category lookup, derived from
   *  `this.categories[].jevIntents`. Rebuilt together with categories on
   *  policy hot-reload (§7.108). */
  private jevIntentMap: Record<string, 'LOCAL' | 'CLOUD' | 'SANITIZED' | 'REJECT'>
  private readonly llm: any
  private readonly auditLog: AuditLike | undefined

  /** ── classify() 结果缓存（LRU + TTL）───────────────────────────────
   *  只缓存"贵的"路径的最终 verdict（LLM 采纳 / jev 采纳，均过
   *  gateCloudVerdict）；规则兜底、policy REJECT、jev-reject 都很便宜
   *  且依赖可热重载的状态，不缓存。没有 in-flight 合并 —— 并发同文本
   *  各自走 LLM（保持并发计数语义），只有"完成后"的重复才命中。
   *  verdict 对同一文本是确定性的（gate 也是纯文本判定），TTL 只为
   *  让关键词表/策略热重载后的新判定尽快生效。 */
  private static readonly CLASSIFY_CACHE_TTL_MS = 60_000
  private static readonly CLASSIFY_CACHE_MAX = 128
  private readonly classifyCache = new Map<string, { intent: Intent; exp: number }>()

  private classifyCacheKey(text: string, recent: unknown[] | undefined): string {
    let ctx = ''
    if (recent && recent.length > 0) {
      try { ctx = JSON.stringify(recent) } catch { ctx = `unserializable:${recent.length}` }
    }
    return `${text}\u0000${ctx}`
  }

  private classifyCacheGet(key: string): Intent | undefined {
    const hit = this.classifyCache.get(key)
    if (!hit) return undefined
    if (Date.now() > hit.exp) {
      this.classifyCache.delete(key)
      return undefined
    }
    // LRU refresh：命中搬到队尾。
    this.classifyCache.delete(key)
    this.classifyCache.set(key, hit)
    return { ...hit.intent }
  }

  private classifyCacheSet(key: string, intent: Intent): void {
    this.classifyCache.delete(key)
    this.classifyCache.set(key, { intent, exp: Date.now() + IntentRouterServiceImpl.CLASSIFY_CACHE_TTL_MS })
    while (this.classifyCache.size > IntentRouterServiceImpl.CLASSIFY_CACHE_MAX) {
      const oldest = this.classifyCache.keys().next().value
      if (oldest === undefined) break
      this.classifyCache.delete(oldest)
    }
  }

  private readonly stats: IntentRouterStats = {
    total: 0,
    empty: 0,
    truncated: 0,
    llmHit: 0,
    /** 同文本+同上下文的重复 classify() 命中缓存（不付 LLM/jev 往返）。 */
    cacheHit: 0,
    ruleHit: 0,
    /** §7.124: Tier-0 家庭设备操作正则命中数。 */
    deviceCommandHit: 0,
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
    this.llmFallback = config.llmFallback ?? true
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
    // §7.124 (2026-10-27): operator-extended device-command terms, ADDITIVE
    // on top of the built-in vocabulary (same semantics as cloudKeywords).
    this.deviceCommandOverrides = {
      devices: config.deviceCommands?.devices ?? [],
      actions: config.deviceCommands?.actions ?? [],
    }
    // §7.92.3 + §7.92.7: jev config. Schema default is `false` so unit
    // tests that construct the service with minimal config don't make
    // real fetches. PRODUCTION default is ALSO `false` since §7.182
    // (2026-11-11, owner ruling): jev is an optional accelerator that needs
    // a local decision-model service, so it stays off until an operator
    // writes `jev.enabled: true` (or sets DSH_EDGE_INTENT_JEV_ENABLED=true).
    this.jevEnabled = config.jevEnabled ?? false
    this.jevUrl = config.jevUrl ?? 'http://127.0.0.1:8001'
    // §7.112: Bailian decision-model backend (defaults keep the local
    // ONNX contract byte-identical when unset).
    this.jevProvider = config.jevProvider ?? 'local'
    this.jevModel = config.jevModel ?? 'decision-model-preview'
    this.jevApiKey = config.jevApiKey || undefined
    this.jevAuthScheme = config.jevAuthScheme ?? 'raw'
    this.jevPath = config.jevPath ?? '/systemone'
    this.jevLocalAdoptFloor = config.jevLocalAdoptFloor ?? 0.5
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
    // §7.108 (2026-10-24): when the categories spec came from the policy
    // service (config.categories not set), follow policy hot-reloads so the
    // LLM prompt and the jev intent map pick up new categories (e.g. a
    // travel domain added to CLOUD) without a restart. A reload that drops
    // categories entirely keeps the last-known spec (defensive).
    if (!(config.categories && config.categories.length > 0)) {
      const policySvc = this.softService('privacyPolicy') as {
        on?: (event: string, listener: (p: import('./privacy-policy.js').PrivacyPolicy) => void) => void
      } | undefined
      if (policySvc && typeof policySvc.on === 'function') {
        policySvc.on('policy/loaded', (p) => {
          const next = p?.categories ?? []
          if (next.length === 0) return
          this.categories = next
          const m: Record<string, 'LOCAL' | 'CLOUD' | 'SANITIZED' | 'REJECT'> = {}
          for (const cat of next) {
            for (const intent of cat.jevIntents) m[intent] = cat.id
          }
          this.jevIntentMap = m
        })
      }
    }
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

  /* ── §7.133: jev 决策模型调用的 trace ────────────────────────────────── */

  /**
   * §7.133: jev 决策模型调用的 trace。
   *
   * jev 走的是**裸 fetch**，不经过 `ctx.llm` —— 所以 adapter 那条路看不到
   * 它。而它恰恰是把用户原文送出设备的那一call（当前配置指向百炼云端
   * decision-model，§7.112/§7.114）。面板若只显示 local-llm 的分类器调用，
   * 就是在显示一件没发生过的事（§7.107 的诚实性纪律）。
   *
   * 所以这里补一路 trace：caller 仍是 `intent-classifier`（它就是意图
   * 分类器），provider 用 `bailian-decision` / `jev` 区分是哪条后端。
   */
  private traceJevRequest(
    provider: string,
    model: string,
    url: string,
    sessionId: string | undefined,
    text: string,
    system: string,
    callId: string,
    rawBody?: unknown,
  ): void {
    try {
      const cfg = resolveLlmTraceConfig(loadEdgeConfig())
      if (!cfg.enabled || !cfg.includeRequest) return
      const trace = buildRequestTrace({
        sessionId: sessionId ?? 'default',
        provider,
        model,
        baseUrl: url,
        system,
        messages: [{ role: 'user', content: text }],
        // §7.144: 完整请求体 —— jev 的 body 里最关键的是 `questions`
        // （分类体系 + 风险标准），那是**投影装不下**的部分：主人的原话
        // 「request 里只发了那段 system 吗？」—— 不是，但面板当时只记了两段。
        rawBody,
        config: cfg,
      })
      this.emitJevTrace('REQ', 'intent-router jev LLM_REQUEST', trace, callId)
    } catch { /* 观测失败不拖垮主链路 */ }
  }

  private traceJevResponse(
    provider: string,
    model: string,
    sessionId: string | undefined,
    content: string,
    durationMs: number,
    error: string | undefined,
    callId: string,
    rawBody?: unknown,
  ): void {
    try {
      const cfg = resolveLlmTraceConfig(loadEdgeConfig())
      if (!cfg.enabled || !cfg.includeResponse) return
      const trace = buildResponseTrace({
        sessionId: sessionId ?? 'default',
        provider,
        model,
        durationMs,
        finishReason: error === undefined ? 'stop' : 'error',
        content,
        toolCalls: [],
        // §7.144: 完整响应体（jev 回的是一整段 JSON：answers + usage + request_id）。
        rawBody,
        error,
        config: cfg,
      })
      this.emitJevTrace('RESP', 'intent-router jev LLM_RESPONSE', trace, callId)
    } catch { /* 观测失败不拖垮主链路 */ }
  }

  private emitJevTrace(kind: 'REQ' | 'RESP', tag: string, trace: unknown, callId: string): void {
    try {
      // ctx.logger 在某些宿主形态下取不到（未 inject 的 plugin proxy 会抛）
      // —— 那是**老通路**（ops log）的事，不能连累索引行与正文 store。
      let logger: { info?: (m: string) => void } | undefined
      try {
        logger = (this.ctx as unknown as { logger?: { info?: (m: string) => void } }).logger
      } catch { logger = undefined }
      const sink: TraceSink = {
        log: (entry) => this.auditLog?.log(entry) ?? Promise.resolve(),
        logger,
        store: getTraceStore(),
      }
      emitTrace(sink, kind, tag, trace, 'intent-classifier', { toolCount: 0, callId })
    } catch { /* 观测失败不拖垮主链路 */ }
  }

  /**
   * §7.122: 分类器 provider 的**真实落点**。
   *
   * provider 名（`local-llm`）不等于落点 —— config/edge.json 的
   * `llm.local.baseUrl` 可以指向公网。审计要能回答「这轮原文发到哪去了」，
   * 光有 provider 名不够。
   *
   * 解析规则：provider 以 `cloud-` 开头 → cloud 池；否则 local 池。
   * （与 model-router 的 realm 判定同一口径：`local-*` 前缀 = LOCAL 域，
   * 其余按 CLOUD 处理。）
   */
  private classifierEndpoint(): string | undefined {
    try {
      const provider = this.classificationProvider ?? ''
      const pool = provider.startsWith('cloud-') ? undefined : localPool()
      return pool?.baseUrl
    } catch {
      return undefined
    }
  }

  /** §7.113 (2026-10-25): the two evidence scalars the Edge tab renders
   *  beside the verdict — `keyword` = the regex keyword/entity the rules
   *  layer matched (derived from the rationale; empty for semantic
   *  verdicts), `semantic` = the chosen category's description sentence,
   *  i.e. the "why" the LLM/jev classifier answered with. Both are plain
   *  scalars so safePayload passes them (PII-scanned) to the intent panel. */
  private classifyEvidence(intent: Intent): { keyword?: string; semantic?: string } {
    const out: { keyword?: string; semantic?: string } = {}
    const kw = /^(?:rule-cloud-keyword|rule-local-entity|override-local-entity|rule-keyword-match):(.+)$/u.exec(intent.rationale)
    if (kw) out.keyword = kw[1]
    const desc = this.categories.find((c) => c.id === intent.category)?.description
    if (desc) out.semantic = desc
    return out
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

  /**
   * §7.107 (2026-10-23, operator ruling「只有需要搜索公网上的信息才需要用到
   * cloudllm」): a CLOUD verdict needs a public-web need.
   *
 * The signal is this router's own cloud keyword list (built-in
 * information-acquisition words + `stages.intent.cloudKeywords` + the
 * policy file's `stages.intent.cloudKeywords`, §7.108) — the same list the
 * rules tier matches, so the gate and the rules tier can never disagree
 * about what counts as a web need.
   *
   * The gate is applied to the LLM / jev verdicts ONLY:
   *   - the rules tier reaches CLOUD either through a privacy-policy rule
   *     (the operator's own statement — honoured as-is) or through a cloud
   *     keyword (which IS the signal);
   *   - the LLM/jev verdicts are a MODEL's opinion, and a model's opinion
   *     is not what decides whether text may leave the device.
   *
   * It lives HERE — at the source of the verdict — and not in the
   * consumer: the verdict is read by two consumers, input-guard
   * (agent/pre-step) and http-api (which writes `agent._edgeRoute` from it
   * and hands that over as an EXPLICIT route that input-guard honours
   * as-is). A gate in the consumer closed only the input-guard path.
   */
  private gateCloudVerdict(intent: Intent, text: string, sid: string): Intent {
    if (intent.category !== 'CLOUD') return intent
    const signal = this.cloudSignal(text)
    if (signal !== undefined) return intent
    // §7.109 (2026-10-24): semantic unlock — the policy file may declare
    // operator trust in the classifier's SEMANTIC verdict: an LLM/jev CLOUD
    // at confidence >= stages.intent.semanticCloudMinConfidence passes
    // without a keyword signal (e.g. "规划黄山两日游怎么安排" needs public
    // info but carries no keyword). Undefined (default) keeps §7.107
    // keyword-only. The entity guardrail already ran before this gate and
    // still wins; downstream sanitizer (fail-closed) / prompt-guard PII
    // veto / td-bus are untouched — the unlock relaxes only the KEYWORD
    // requirement, not any data-protection layer.
    //
    // §7.123 (2026-10-27): a SYNTHETIC confidence cannot unlock the gate.
    // The bailian decision-model answers a `choice` question; when it does
    // not report a numeric confidence the decoder substitutes 0.9
    // ("decisive-by-construction"). With the shipped policy threshold of
    // 0.75 that placeholder was ALWAYS >= threshold, so every CLOUD verdict
    // from that provider left the device with no public-web signal — the
    // §7.107 gate was inert on exactly the path that talks to a cloud
    // service. Requiring a *reported* confidence restores the gate's
    // meaning: the operator's trust threshold is a threshold on a
    // measurement, not on a placeholder.
    const semanticMin = this.policyIntentStages()?.semanticCloudMinConfidence
    const syntheticConfidence = intent.confidenceReported === false
    if (syntheticConfidence) {
      this.audit('warn', 'intent.cloud.semantic-unlock-skipped', {
        sessionId: sid,
        confidence: intent.confidence,
        minConfidence: semanticMin,
        rationale: intent.rationale,
        note: 'classifier confidence is synthetic (not reported) — semantic unlock does not apply; a public-web signal is required',
      })
    } else if (typeof semanticMin === 'number' && intent.confidence >= semanticMin) {
      this.audit('info', 'intent.cloud.semantic-unlock', {
        sessionId: sid,
        confidence: intent.confidence,
        minConfidence: semanticMin,
        rationale: intent.rationale,
        note: 'policy semantic trust: classifier CLOUD verdict passed without a keyword signal',
      })
      return intent
    }
    this.audit('warn', 'intent.cloud.blocked-no-web-need', {
      sessionId: sid,
      category: intent.category,
      confidence: intent.confidence,
      rationale: intent.rationale,
      note: 'cloud verdict without a public-web signal — kept on device',
    })
    // The final verdict gets its own classify.end row: the panel reads the
    // LATEST one, and the pre-gate row still says CLOUD — the panel would
    // announce a cloud verdict that never happened.
    this.audit('info', 'intent.classify.end', {
      sessionId: sid,
      textLen: text.length,
      path: 'gate-no-web-need',
      category: 'LOCAL',
      confidence: intent.confidence,
      rationale: 'no-web-need',
      ...(this.classifyEvidence({ ...intent, category: 'LOCAL', rationale: 'no-web-need' })),
    })
    return { category: 'LOCAL', confidence: intent.confidence, targetRealm: 'local', rationale: 'no-web-need' }
  }

  async classify(text: string, context?: { recentMessages?: unknown[]; sessionId?: string }): Promise<Intent> {
    const start = Date.now()
    this.stats.total++
    // §7.106 (2026-10-22): thread the session id into every panel-visible classify
    // audit. Without it the fold drops these rows into the _global bucket
    // (turn sentinel -1) and per-turn wiping never hides them — observed:
    // turn-1 classify rows still on screen during turn 2 (17:47 desktop).
    const sid = typeof context?.sessionId === 'string' ? context.sessionId : ''

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
      this.audit('warn', 'intent.classify.truncated', { sessionId: sid,
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
          this.audit('security', 'intent.rules.rejected', { sessionId: sid,
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
        this.audit('warn', 'intent.policy.precheck-error', { sessionId: sid, error: err?.message ?? String(err) })
        // Pre-check failure is non-fatal; fall through to LLM+rules path.
      }
    }

    const textPreview = this.redactPreview(effectiveText) ?? `[len=${effectiveText.length}]`
    // §7.122: `classifier` 是**配置里的备用分类器**，不是本轮的实际裁决者
    // —— jev 预筛命中时（path=jev-adopt）LLM 分类器根本没被调用，而面板把
    // 这个配置值渲染成「分类器 local-llm」，operator 会以为本轮是它判的。
    //
    // 落两样东西：
    //   - `classifierEndpoint`：这个 provider 的**真实落点**。provider 名叫
    //     `local-llm` 但 baseUrl 可能是公网（config/edge.json 的
    //     llm.local.baseUrl），名字骗人，落点不骗人。
    //   - `classifierIsLocal`：落点是否真的在本机（127.0.0.1 / localhost）。
    const classifierEndpoint = this.classifierEndpoint()
    // §7.179（2026-11-11）：**本轮真正会跑的**分类模型。
    //
    // 之前分类模型名只在 apply() 里跟 `llm.local.model` 走一次（§7.102）。DELEGATE
    // 模式（llm.local.baseUrl 留空）下那个值是空的 ⇒ 模型名停在 Schema 默认
    // `qwen3-4b`，而 wire 上真正跑的是委托解析出来的宿主当前模型 ⇒ 面板写着
    // 「裁决者 LLM 分类器 local-llm/qwen3-4b」而实际跑的是另一个模型（与实际
    // 行为相反）。§7.176 的同一口径：写 wire 上真正跑的那个。
    const effective = await resolveEffectiveLocalModel(
      this.ctx,
      this.classificationModel,
      this.classificationProvider,
    )
    this.audit('info', 'intent.classify.start', {
      sessionId: sid,
      textLen: effectiveText.length,
      textPreview,
      classifier: this.classificationProvider,
      model: effective.model,
      // 真实落点（DELEGATE 时是宿主 provider，不是 local-llm）。
      modelProvider: effective.provider ?? this.classificationProvider,
      modelSource: effective.source,
      classifierEndpoint,
      classifierIsLocal: isLoopbackEndpoint(classifierEndpoint),
    })

    // 缓存命中：同文本+同上下文的已完成 verdict 直接复用，跳过 jev/LLM。
    const cacheKey = this.classifyCacheKey(effectiveText, context?.recentMessages)
    const cachedVerdict = this.classifyCacheGet(cacheKey)
    if (cachedVerdict) {
      this.stats.cacheHit++
      this.audit('info', 'intent.classify.end', { sessionId: sid,
        textLen: effectiveText.length,
        path: 'cache',
        category: cachedVerdict.category,
        confidence: cachedVerdict.confidence,
        rationale: cachedVerdict.rationale,
        ...this.classifyEvidence(cachedVerdict),
        durationMs: Date.now() - start,
      })
      return cachedVerdict
    }

    // §7.124 (2026-10-27): Tier-0 — 家庭设备操作正则快速层。
    //
    // 用户裁决：「意图识别需要先走正则，快速决策，比如开灯、关门、开空调
    // 这些家庭里家电操作，然后才是决策模型分类，最后才是 llm 分类」。
    //
    // 三级阶梯现在是：
    //   Tier-0  正则（本层）      ~0ms        命中即定案，绝不外呼
    //   Tier-1  jev 决策模型      ~150ms-6s   语义分类
    //   Tier-2  LLM 分类器        4s-30s      最后兜底
    //
    // 位置说明：放在缓存之后、jev 之前。缓存命中本来就是 ~0ms 且语义等价，
    // 没有理由绕过它；而放在 jev 之前才能兑现「正则优先」——命中即定案，
    // 原始指令不出设备、不进 jev 的上行请求体（jev 指向云端时这一点尤其
    // 重要）。
    //
    // 判定一律 LOCAL：家电操作由 LOCAL realm 的设备技能执行，不该上云
    // （与 §7.107「默认本地」一致）。
    //
    // 未命中不惩罚 —— 直接落到 jev / LLM，行为与本层存在时完全一致。
    const deviceMatch = matchDeviceCommand(effectiveText, this.deviceCommandTerms())
    if (deviceMatch) {
      this.stats.deviceCommandHit++
      this.audit('info', 'intent.device-command.hit', {
        sessionId: sid,
        device: deviceMatch.device,
        action: deviceMatch.action,
        matched: deviceMatch.matched,
        textLen: effectiveText.length,
      })
      const deviceIntent: Intent = {
        category: 'LOCAL',
        confidence: 0.95,
        targetRealm: 'local',
        rationale: `device-command:${deviceMatch.action}:${deviceMatch.device}`,
        // §7.123: a regex verdict is a MEASURED decision, not a model-reported
        // confidence — mark it as such so the semantic-unlock provenance guard
        // can tell it apart from a synthetic placeholder.
        confidenceReported: true,
      }
      this.audit('info', 'intent.classify.end', { sessionId: sid,
        textLen: effectiveText.length,
        path: 'device-command',
        category: deviceIntent.category,
        confidence: deviceIntent.confidence,
        rationale: deviceIntent.rationale,
        ...this.classifyEvidence(deviceIntent),
        durationMs: Date.now() - start,
        device: deviceMatch.device,
        action: deviceMatch.action,
      })
      this.classifyCacheSet(cacheKey, deviceIntent)
      return deviceIntent
    }

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
        this.audit('info', 'intent.classify.end', { sessionId: sid,
          textLen: effectiveText.length,
          path: 'jev-reject',
          category: 'REJECT',
          confidence: jevResult.confidence,
          rationale: `jev-risk:${jevResult.riskScore.toFixed(2)}`,
          ...this.classifyEvidence({ category: 'REJECT', confidence: jevResult.confidence, targetRealm: 'rejected', rationale: 'jev-risk' }),
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
            this.audit('warn', 'intent.classify.entity_override', { sessionId: sid,
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
        this.audit('info', 'intent.classify.end', { sessionId: sid,
          textLen: effectiveText.length,
          path: finalIntent === adopted ? 'jev-adopt' : 'jev-adopt-entity-override',
          category: finalIntent.category,
          confidence: finalIntent.confidence,
          rationale: finalIntent.rationale,
          ...this.classifyEvidence(finalIntent),
          durationMs: Date.now() - start,
          jevLatencyMs: jevResult.latencyMs,
          jevIntent: jevResult.jevIntentString,
          jevConfidence: jevResult.confidence,
          // §7.121: 决策模型的**原始风险分**。此前只落了 intent/confidence，
          // 「模型到底有多确信这条请求有风险」这个问题没有答案 —— 而它正是
          // §7.107 公网检索闸门和 REJECT 闸门的输入。
          jevRiskScore: jevResult.riskScore,
        })
        // §7.107: a model's CLOUD opinion is not what decides whether text
        // may leave the device — a public-web need is.
        const gatedJev = this.gateCloudVerdict(finalIntent, effectiveText, sid)
        this.classifyCacheSet(cacheKey, gatedJev)
        return gatedJev
      }
      // action === 'skip' (low-conf / fallback_llm / unrecognized intent /
      // transport error / timeout). All already audited inside
      // classifyWithJev with a specific kind. Count under jevSkip (or
      // jevError/jevTimeout already incremented inside the helper).
      if (jevResult.action === 'skip' && jevResult.skipReason !== 'jev-error' && jevResult.skipReason !== 'jev-timeout') {
        this.stats.jevSkip++
      }
    }

    // §7.115: decision-model-only mode (stages.intent.llmFallback=false) —
    // the LLM classifier is a fallback operators can switch off entirely.
    // When off, a jev skip goes straight to the rules tier + default LOCAL
    // (fail-closed); no LLM round-trip ever happens.
    if (!this.llmFallback) {
      const intent = this.classifyWithRules(effectiveText)
      if (intent.category === 'REJECT') this.stats.rejected++
      else if (intent.rationale.startsWith('default:')) this.stats.defaultHit++
      else this.stats.ruleHit++
      this.audit('info', 'intent.classify.end', { sessionId: sid,
        textLen: effectiveText.length,
        path: 'rules-llm-fallback-off',
        category: intent.category,
        confidence: intent.confidence,
        rationale: intent.rationale,
        ...this.classifyEvidence(intent),
        durationMs: Date.now() - start,
      })
      return intent
    }

    // Try LLM classification first
    try {
      const intent = await this.classifyWithLlm(effectiveText, context?.recentMessages, context?.sessionId, effective)
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
          this.audit('warn', 'intent.classify.entity_override', { sessionId: sid,
            from: intent.category,
            to: 'LOCAL',
            entity: entityHit,
            llmConfidence: intent.confidence,
            llmRationale: intent.rationale,
            textLen: effectiveText.length,
          })
        }
      }
      this.audit('info', 'intent.classify.end', { sessionId: sid,
        textLen: effectiveText.length,
        path: finalIntent === intent ? 'llm' : 'llm-entity-override',
        category: finalIntent.category,
        confidence: finalIntent.confidence,
        rationale: finalIntent.rationale,
        ...this.classifyEvidence(finalIntent),
        durationMs: Date.now() - start,
      })
      // §7.107: the public-web gate. Without a public-web signal the turn
      // stays on the device, whatever the classifier said.
      const gatedLlm = this.gateCloudVerdict(finalIntent, effectiveText, sid)
      this.classifyCacheSet(cacheKey, gatedLlm)
      return gatedLlm
    } catch (err: any) {
      // classifyWithLlm already audited the specific kind (timeout vs error
      // vs low-confidence vs unclear). Here we just attribute the fallback.
      this.audit('warn', 'intent.classify.llm_error', { sessionId: sid, textLen: effectiveText.length, error: err?.message ?? String(err) })
      // Fall back to keyword rules
      const intent = this.classifyWithRules(effectiveText)
      if (intent.category === 'REJECT') this.stats.rejected++
      else if (intent.rationale.startsWith('default:')) this.stats.defaultHit++
      else this.stats.ruleHit++
      this.audit('info', 'intent.classify.end', { sessionId: sid,
        textLen: effectiveText.length,
        path: 'rules-after-llm-error',
        category: intent.category,
        confidence: intent.confidence,
        rationale: intent.rationale,
        ...this.classifyEvidence(intent),
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
    // §7.147：这一路的审计行必须带 sessionId —— 否则行归不了属，Edge 面板
    // 的意图面板永远说不清「这一轮」（实测：jev 的 62 条 adopt/response 无一带
    // sessionId，全部落全局桶）。闭包一次带上，本函数内的 audit 都走它。
    //
    // sessionId 为空时**不写**这个键 ⇒ 归全局桶（而不是造一个假会话桶）。
    const audit = (level: 'debug' | 'info' | 'warn' | 'error' | 'security', kind: string, payload: Record<string, unknown>): void =>
      this.audit(level, kind, { ...sessionIdField(sessionId), ...payload })
    const batchStart = Date.now()
    audit('debug', 'intent.jev.batch.start', {
      textLen: text.length,
      batchSize: intents.length,
      batchLatencyBudgetMs: this.jevTimeoutMs,
    })
    // §7.133: 本机 jev 后端同样是「把原文发出去的模型调用」—— 留痕。
    // §7.134: REQ/RESP 共用一个 callId（面板据此配成一对）。
    const jevCallId = nextCallId()
    // §7.144: 请求体先提成变量 —— trace 要记**完整**的那一份（query + 整份
    // intents 分类表 + chitchat 标记），fetch 与 trace 用同一个对象，
    // 杜绝「记的和发的不是同一份」。
    const jevRequestBody = {
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
    }
    this.traceJevRequest('jev', 'jev-local', `${this.jevUrl}/predict`, sessionId, text, '', jevCallId, jevRequestBody)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.jevTimeoutMs)

    let responseText = ''
    let parsed: any = null
    let jevError: string | undefined
    try {
      const r = await fetch(`${this.jevUrl}/predict`, {
        method: 'POST',
        headers: this.jevHeaders(),
        body: JSON.stringify(jevRequestBody),
        signal: controller.signal,
      })
      if (!r.ok) {
        this.stats.jevError++
        audit('warn', 'intent.jev.error', {
          httpStatus: r.status,
          batchLatencyMs: Date.now() - batchStart,
        })
        jevError = `HTTP ${r.status}`
        return { action: 'skip', confidence: 0, riskScore: 0, latencyMs: Date.now() - jevStart, skipReason: 'jev-error' }
      }
      responseText = await r.text()
      try {
        parsed = JSON.parse(responseText)
      } catch (parseErr: any) {
        this.stats.jevError++
        audit('warn', 'intent.jev.error', {
          reason: 'parse-failure',
          error: parseErr?.message ?? String(parseErr),
          batchLatencyMs: Date.now() - batchStart,
        })
        jevError = `parse-failure: ${parseErr?.message ?? String(parseErr)}`.slice(0, 200)
        return { action: 'skip', confidence: 0, riskScore: 0, latencyMs: Date.now() - jevStart, skipReason: 'jev-error' }
      }
    } catch (err: any) {
      const isAbort = err?.name === 'AbortError' || controller.signal.aborted
      const latencyMs = Date.now() - jevStart
      if (isAbort) this.stats.jevTimeout++
      else this.stats.jevError++
      audit('warn', isAbort ? 'intent.jev.timeout' : 'intent.jev.error', {
        latencyMs,
        timeoutMs: this.jevTimeoutMs,
        batchLatencyMs: Date.now() - batchStart,
        error: err?.message ?? String(err),
      })
      jevError = isAbort ? 'timeout' : (err?.message ?? String(err)).slice(0, 200)
      return {
        action: 'skip',
        confidence: 0,
        riskScore: 0,
        latencyMs,
        skipReason: isAbort ? 'jev-timeout' : 'jev-error',
      }
    } finally {
      clearTimeout(timer)
      // §7.133: jev 本机后端的 response trace（失败也有）。
      this.traceJevResponse('jev', 'jev-local', sessionId, responseText, Date.now() - batchStart, jevError, jevCallId,
        // §7.144: 完整响应体。
        responseText)
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
    audit('debug', 'intent.jev.response', {
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
      audit('security', 'intent.rules.rejected', {
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
      audit('info', 'intent.jev.fallback_intent', {
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
      audit('info', 'intent.jev.low_confidence', {
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
      audit('info', 'intent.jev.fallback_intent', {
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
      audit('info', 'intent.jev.unmapped_intent', {
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
      audit('security', 'intent.rules.rejected', {
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
    audit('info', 'intent.jev.adopt', {
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
  /** §7.112: headers for every jev HTTP surface (predict / health /
   *  systemone). Content-Type always; Authorization only when a key is
   *  configured — Bailian MaaS requires it, the local ONNX service never
   *  did. */
  private jevHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.jevApiKey) {
      headers.Authorization = this.jevAuthScheme === 'bearer' ? `Bearer ${this.jevApiKey}` : this.jevApiKey
    }
    return headers
  }

  /** §7.112 (2026-10-25): Bailian decision-model backend for the jev stage.
   *
   *  One POST `${jevUrl}/systemone` replaces the batched /predict flow:
   *  the structured-decision interface carries the whole taxonomy at once —
   *    questions.intent = choice over categories (criteria = id → description)
   *    questions.risk    = score over 4 danger levels (→ risk_score 0..1)
   *  so there is no 16-intent cap and no chitchat markers. Confidence/risk
   *  gates, breaker semantics and audit rows mirror the local flow so
   *  classify() cannot tell the backends apart. */
  private async classifyWithBailianDecision(
    text: string,
    sessionId: string | undefined,
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
    // §7.147：这一路的审计行必须带 sessionId —— 否则行归不了属，Edge 面板
    // 的意图面板永远说不清「这一轮」（实测：jev 的 62 条 adopt/response 无一带
    // sessionId，全部落全局桶）。闭包一次带上，本函数内的 audit 都走它。
    //
    // sessionId 为空时**不写**这个键 ⇒ 归全局桶（而不是造一个假会话桶）。
    const audit = (level: 'debug' | 'info' | 'warn' | 'error' | 'security', kind: string, payload: Record<string, unknown>): void =>
      this.audit(level, kind, { ...sessionIdField(sessionId), ...payload })
    const criteria = buildJevIntentCriteria(this.categories)
    const body = {
      model: this.jevModel,
      state: {
        session_id: sessionId ?? 'default',
        content: text,
      },
      questions: {
        intent: {
          type: 'choice',
          instructions: JEV_INTENT_INSTRUCTIONS,
          criteria,
        },
        risk: {
          type: 'score',
          instructions: JEV_RISK_INSTRUCTIONS,
          criteria: [...JEV_RISK_CRITERIA],
        },
      },
    }
    const batchStart = Date.now()
    audit('debug', 'intent.jev.batch.start', {
      textLen: text.length,
      provider: 'bailian-decision',
      model: this.jevModel,
      batchLatencyBudgetMs: this.jevTimeoutMs,
    })
    // §7.133: jev 是裸 fetch，不走 ctx.llm —— 这里补一路 trace，
    // 否则面板看不到「用户原文被送去了百炼」这一事实。
    // §7.134: REQ/RESP 共用一个 callId（面板据此配成一对）。
    const jevCallId = nextCallId()
    this.traceJevRequest(
      'bailian-decision',
      this.jevModel,
      `${this.jevUrl}${this.jevPath}`,
      sessionId,
      text,
      JEV_INTENT_INSTRUCTIONS,
      jevCallId,
      // §7.144: 完整请求体（含 questions 的分类体系与风险标准）。
      body,
    )

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.jevTimeoutMs)
    let parsed: any = null
    let jevBody = ''
    let jevError: string | undefined
    try {
      const r = await fetch(`${this.jevUrl}${this.jevPath}`, {
        method: 'POST',
        headers: this.jevHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!r.ok) {
        this.stats.jevError++
        audit('warn', 'intent.jev.error', {
          provider: 'bailian-decision',
          httpStatus: r.status,
          batchLatencyMs: Date.now() - batchStart,
        })
        this.jevBreakerOpenUntil = Date.now() + this.jevBreakerTtlMs
        jevError = `HTTP ${r.status}`
        return { action: 'skip', confidence: 0, riskScore: 0, latencyMs: Date.now() - jevStart, skipReason: 'jev-error' }
      }
      jevBody = await r.text()
      parsed = JSON.parse(jevBody)
    } catch (err: any) {
      const isAbort = err?.name === 'AbortError' || controller.signal.aborted
      const latencyMs = Date.now() - jevStart
      if (isAbort) this.stats.jevTimeout++
      else this.stats.jevError++
      audit('warn', isAbort ? 'intent.jev.timeout' : 'intent.jev.error', {
        provider: 'bailian-decision',
        latencyMs,
        timeoutMs: this.jevTimeoutMs,
        error: err?.message ?? String(err),
      })
      this.jevBreakerOpenUntil = Date.now() + this.jevBreakerTtlMs
      jevError = isAbort ? 'timeout' : (err?.message ?? String(err)).slice(0, 200)
      return {
        action: 'skip',
        confidence: 0,
        riskScore: 0,
        latencyMs,
        skipReason: isAbort ? 'jev-timeout' : 'jev-error',
      }
    } finally {
      clearTimeout(timer)
      // §7.133: 失败也要有 response trace —— 否则面板只剩「发出去了」而
      // 没有「回来没有 / 为什么没回来」。
      this.traceJevResponse(
        'bailian-decision',
        this.jevModel,
        sessionId,
        jevBody,
        Date.now() - batchStart,
        jevError,
        jevCallId,
        // §7.144: 完整响应体（jev 回的整段 JSON：answers / usage / request_id）。
        jevBody,
      )
    }

    // Success → the backend answered; close the breaker (mirrors the
    // batched flow's "any successful batch closes it").
    this.jevBreakerOpenUntil = 0

    // §7.112.1 (2026-10-25 实测 shape): answers.intent = {type:'choice',
    // choice:'<criteria key>', confidence, probabilities}; answers.risk =
    // {type:'score', score:<0..3 连续>, legend, confidence}. score/3 →
    // 0..1 接回 jevRiskThreshold（0.7 ≈ score 2.1 起 REJECT）。
    const answers = extractDecisionAnswers(parsed, ['intent', 'risk'])
    const intentAns = answers?.intent as Record<string, unknown> | string | undefined
    const riskAns = answers?.risk as Record<string, unknown> | number | undefined
    let intentStr: string | null = null
    // §7.123 (2026-10-27): `confidenceReported` tracks whether the backend
    // actually sent a numeric confidence. The 0.9 fallback below is a
    // PLACEHOLDER ("the model had to pick exactly one criterion"), not a
    // measurement — it must not be able to unlock the semantic-trust gate.
    let confidenceReported = false
    let confidence = 0.9 // decisive-by-construction: the model must pick exactly one criterion
    if (typeof intentAns === 'string') {
      intentStr = intentAns.toUpperCase()
    } else if (intentAns && typeof intentAns === 'object') {
      intentStr = typeof intentAns.choice === 'string' ? intentAns.choice.toUpperCase() : null
      if (typeof intentAns.confidence === 'number') {
        confidence = Math.max(0, Math.min(1, intentAns.confidence))
        confidenceReported = true
      }
    }
    let rawRisk = 0
    if (typeof riskAns === 'number') rawRisk = riskAns
    else if (riskAns && typeof riskAns === 'object' && typeof (riskAns as any).score === 'number') {
      rawRisk = (riskAns as any).score
    }
    const riskScore = Math.max(0, Math.min(1, rawRisk / 3))
    const latencyMs = typeof parsed?.latency_ms === 'number' ? parsed.latency_ms : Date.now() - jevStart
    this.stats.jevLatencyMsTotal += latencyMs
    audit('info', 'intent.jev.response', {
      provider: 'bailian-decision',
      model: this.jevModel,
      intent: intentStr,
      confidence,
      riskScore,
      latencyMs,
    })

    // Risk gate — same semantics as the local flow's risk_score gate.
    if (riskScore >= this.jevRiskThreshold) {
      audit('security', 'intent.rules.rejected', {
        source: 'jev-bailian-decision',
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

    // §7.115 directional confidence gate: resolve the mapped category FIRST,
    // then split the floor by direction — LOCAL is the fail-safe default
    // (§7.107), so a LOCAL-leaning verdict adopts at jev.localAdoptFloor
    // (default 0.5) instead of paying the LLM round-trip for a second
    // opinion; non-LOCAL (data may leave the device) keeps the strict
    // jevConfidenceThreshold.
    // §7.115.1: LOCAL is the default category — it is adoptable even when
    // the §7.110-simplified taxonomy ships no LOCAL row (the criteria
    // catch-all above offered it as a choice; the verdict must be adoptable).
    const mapped = intentStr === 'LOCAL'
      ? 'LOCAL'
      : this.categories.find((c) => c.id === intentStr)?.id
    if (!intentStr || !mapped) {
      audit('info', 'intent.jev.unmapped_intent', {
        provider: 'bailian-decision',
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
        skipReason: 'unmapped-intent',
      }
    }
    const adoptFloor = mapped === 'LOCAL' ? this.jevLocalAdoptFloor : this.jevConfidenceThreshold
    if (confidence < adoptFloor) {
      audit('info', 'intent.jev.low_confidence', {
        provider: 'bailian-decision',
        intent: intentStr,
        confidence,
        threshold: adoptFloor,
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

    const targetRealm = mapped === 'LOCAL' ? 'local'
      : mapped === 'CLOUD' ? 'cloud'
      : mapped === 'REJECT' ? 'rejected'
      : 'sanitized'
    if (mapped === 'REJECT') {
      audit('security', 'intent.rules.rejected', {
        source: 'jev-bailian-decision',
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
    audit('info', 'intent.jev.adopt', {
      provider: 'bailian-decision',
      intent: intentStr,
      realm: mapped,
      confidence,
      riskScore,
      latencyMs,
    })
    return {
      action: 'adopt',
      intent: {
        category: mapped,
        confidence,
        targetRealm,
        rationale: `jev-intent:${intentStr}`,
        // §7.123: carry the confidence provenance so the §7.109 semantic
        // gate can tell a measured confidence from the synthetic 0.9.
        confidenceReported,
      },
      jevIntentString: intentStr,
      confidence,
      riskScore,
      latencyMs,
    }
  }

  private async classifyWithJev(text: string, sessionId?: string): Promise<{
    action: 'reject' | 'adopt' | 'skip'
    intent?: Intent
    jevIntentString?: string
    confidence: number
    riskScore: number
    latencyMs: number
    skipReason?: string
  }> {
    // §7.147：这一路的审计行必须带 sessionId —— 否则行归不了属，Edge 面板
    // 的意图面板永远说不清「这一轮」（实测：jev 的 62 条 adopt/response 无一带
    // sessionId，全部落全局桶）。闭包一次带上，本函数内的 audit 都走它。
    //
    // sessionId 为空时**不写**这个键 ⇒ 归全局桶（而不是造一个假会话桶）。
    const audit = (level: 'debug' | 'info' | 'warn' | 'error' | 'security', kind: string, payload: Record<string, unknown>): void =>
      this.audit(level, kind, { ...sessionIdField(sessionId), ...payload })
    // §7.92.6 (2026-09-24): circuit breaker — short-circuit if a
    // previous classify() within the TTL window saw all 3 batches
    // fail. Saves up to ~3 × jevTimeoutMs = 7500ms wall-clock on every
    // chat when jev is dead. Operators see "circuit open" once in
    // audit, then this debug-level skip per call until recovery.
    if (Date.now() < this.jevBreakerOpenUntil) {
      this.stats.jevCircuitSkip++
      audit('debug', 'intent.jev.circuit_open_skip', {
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
    // §7.112: Bailian decision-model backend — one /systemone call replaces
    // the batched /predict flow (no 16-intent cap, no chitchat markers).
    // Verdict / gates / breaker semantics are mirrored so classify() cannot
    // tell the backends apart.
    if (this.jevProvider === 'bailian-decision') {
      return this.classifyWithBailianDecision(text, sessionId, jevStart)
    }
    const allIntents = this.buildJevIntentsPayload()
    const chitchatIntents = ['闲聊', '其他'] // §7.92.5: defensive marker for jev v0.3.0+
    const batches = chunkIntents(allIntents, JEV_MAX_INTENTS)
    audit('debug', 'intent.jev.start', {
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
      audit('warn', 'intent.jev.circuit_open', {
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

  private async classifyWithLlm(
    text: string,
    recentMessages?: unknown[],
    sessionId?: string,
    // §7.179：调用方（classify）已经解析过「这一轮真正会跑的模型」⇒ 直接
    // 传下来，避免同一次分类里重复解析（探针步会触发一次 listModels）。
    effective?: { model: string; provider?: string; source: string },
  ): Promise<Intent> {
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
    // §7.179：请求里的 model 必须是**真正会跑**的那个（DELEGATE 下 = 委托
    // 解析出来的宿主模型），不是停在 Schema 默认的 `qwen3-4b`。口径与
    // effective-model.ts 一致，与 local-llm-adapter 共用同一条解析链。
    const eff = effective ?? await resolveEffectiveLocalModel(
      this.ctx,
      this.classificationModel,
      this.classificationProvider,
    )
    const requestedModel = eff.model
    const resolvedModel = (resolved && resolved.model === resolved.provider) ? requestedModel : resolved?.model
    const model = resolvedModel ?? requestedModel
    this.audit('debug', 'intent.llm.route', {
      configured: this.classificationProvider,
      resolvedRealm: resolved?.realm,
      resolvedProvider: provider,
      resolvedModel: model,
      modelProvider: eff.provider ?? this.classificationProvider,
      modelSource: eff.source,
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
          this.audit('security', 'intent.llm.sanitize-error', { sessionId: sessionId ?? '',
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
        this.audit('security', 'intent.llm.sanitize-unavailable', { sessionId: sessionId ?? '', reason: 'no-sanitizer-handle' })
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
            this.audit('warn', 'intent.llm.history-sanitize-error', { sessionId: sessionId ?? '',
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
    // §7.110 (2026-10-24): 默认本地 —— the operator's taxonomy only needs to
    // POSITIVELY define the exceptions (CLOUD / REJECT); LOCAL is the
    // catch-all default and may ship no row at all. When the policy has no
    // LOCAL row, append a fixed catch-all line and include LOCAL in the
    // output union so the model can express "neither of the above"
    // (coerceClassification accepts LOCAL regardless of the taxonomy).
    // §7.123 (2026-10-27): the prompt template moved to
    // `./intent-prompts.ts` — the two prompt surfaces (local LLM classifier
    // + Bailian decision-model) now live side by side and cannot drift on
    // the LOCAL catch-all wording.
    const { prompt } = buildClassificationPrompt({
      categories: this.categories,
      historyBlock,
      promptText,
    })

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
        // §7.132: 标记这是**意图分类器内部调用**，不是主对话出网。
        ...withInternalCaller({}, 'intent-classifier'),
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
      this.audit('warn', 'intent.llm.provider_error', { sessionId: sessionId ?? '',
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
    for (const kw of this.localEntitiesAll()) {
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

  /** §7.108 (2026-10-24): the policy file's stages.intent signal tables,
   *  read LIVE on every classify so a policy hot-reload takes effect on
   *  the next turn. Missing service / old policy → undefined (callers
   *  fall back to the constructor-built lists). */
  private policyIntentStages(): import('./privacy-policy.js').PolicyIntentStages | undefined {
    const policy = this.softService('privacyPolicy')
    try { return policy?.getIntentStages?.() ?? undefined }
    catch { return undefined }
  }

  /** §7.108: the FULL cloud signal list = built-in + patch config +
   *  policy stages.intent.cloudKeywords. ONE definition shared by the
   *  rules tier and the §7.107 gate — they can never disagree about what
   *  counts as a public-web need. */
  private cloudKeywordsAll(): readonly string[] {
    const fromPolicy = this.policyIntentStages()?.cloudKeywords
    return (fromPolicy && fromPolicy.length > 0)
      ? this.cloudKeywords.concat(fromPolicy)
      : this.cloudKeywords
  }

  /** §7.108: the FULL LOCAL entity list = built-in + patch config + policy. */
  private localEntitiesAll(): readonly string[] {
    const fromPolicy = this.policyIntentStages()?.localEntities
    return (fromPolicy && fromPolicy.length > 0)
      ? this.localEntities.concat(fromPolicy)
      : this.localEntities
  }

  /** §7.108: LOCAL last-resort list — policy stages.intent.fallbackKeywords
   *  (non-empty) REPLACES, mirroring the env var's replace semantics. */
  /** §7.124 (2026-10-27): the device-command extension terms = patch config
   *  (config/edge.json stages.intent.deviceCommands) + the policy file's
   *  stages.intent.deviceCommands (hot-reloadable, read LIVE per classify).
   *  Both are ADDITIVE on top of the built-in vocabulary. */
  private deviceCommandTerms(): { devices: readonly string[]; actions: readonly string[] } {
    const fromPolicy = this.policyIntentStages()?.deviceCommands
    return {
      devices: this.deviceCommandOverrides.devices.concat(fromPolicy?.devices ?? []),
      actions: this.deviceCommandOverrides.actions.concat(fromPolicy?.actions ?? []),
    }
  }

  private fallbackKeywordsAll(): readonly string[] {
    const fromPolicy = this.policyIntentStages()?.fallbackKeywords
    return (fromPolicy && fromPolicy.length > 0) ? fromPolicy : this.fallbackKeywords
  }

  /**
   * §7.107: the public-web signal — the keyword that unlocks the cloud.
   *
   * Same list the rules tier matches (built-in information-acquisition words
   * + patch `stages.intent.cloudKeywords` + policy-file
   * `stages.intent.cloudKeywords` (§7.108)); `classifyWithRules` calls this
   * so the gate and the rules tier cannot drift apart.
   */
  cloudSignal(text: string): string | undefined {
    const lower = text.toLowerCase()
    return this.cloudKeywordsAll().find((kw) => lower.includes(kw.toLowerCase()))
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
    // would otherwise hit defaultCategory (LOCAL, fail-closed) without
    // any LLM call. Inspection order is ENTITY → CLOUD → LOCAL → default —
    // if a query contains both CLOUD and LOCAL signals (e.g. "把本地文件整理
    // 成新闻稿发到网上"), the CLOUD path wins because user explicitly asked
    // for online content; a LOCAL *entity* name still beats both (above).
    // Privacy-policy rules (before all of this) can still REJECT.
    const cloudMatched = this.cloudSignal(text)
    if (cloudMatched !== undefined) {
      this.audit('debug', 'intent.rules.hit', { source: 'cloud-keyword', matchedKeyword: cloudMatched })
      return {
        category: 'CLOUD',
        confidence: 0.8,
        targetRealm: 'cloud',
        rationale: `rule-cloud-keyword:${cloudMatched}`,
      }
    }
    const matched = this.fallbackKeywordsAll().find((kw) => lower.includes(kw.toLowerCase()))

    if (matched !== undefined) {
      this.audit('debug', 'intent.rules.hit', { source: 'fallback-keyword', matchedKeyword: matched })
      return {
        category: 'LOCAL',
        confidence: 0.7,
        targetRealm: 'local',
        // §7.113: carry the keyword in the rationale — the Edge tab's
        // keyword evidence scalar derives from it.
        rationale: `rule-keyword-match:${matched}`,
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
    // §7.112: the systemone contract has no /health surface — GET /health
    // answers 400 even with a valid key (observed on token-plan), which
    // pre-opened the breaker at boot and silently skipped every classify.
    // The backend is billed per call: skip probing entirely and let the
    // breaker open only on real classify failures (TTL gives recovery).
    // §7.114: the skip is path-scoped — the MaaS deployments have no
    // /health surface, but a local MLX serve DOES (GET {url}/health →
    // 200), and for that deployment probing is free and desirable.
    if (this.jevProvider === 'bailian-decision' && this.jevPath === '/systemone') {
      if (phase === 'boot') {
        this.audit('debug', 'intent.jev.boot_probe', { provider: 'bailian-decision', skipped: true, note: 'no /health surface — probe skipped' })
      }
      return true
    }
    const probeStart = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let ok = false
    let httpStatus = 0
    let errorMsg = ''
    try {
      const r = await fetch(`${this.jevUrl}/health`, {
        method: 'GET',
        headers: this.jevHeaders(),
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
  /** TTL/LRU 缓存命中 —— 同文本+同上下文的重复 classify() 不再付
   *  LLM/jev 往返（"你好" 类闲聊在 §7.107 gate 下尤其常见）。 */
  cacheHit: number
  /** classifyWithRules adopted — privacy-policy match OR hardcoded keyword. */
  ruleHit: number
  /** §7.124 (2026-10-27): Tier-0 device-command regex hit — the turn was
   * decided locally by regex, without calling jev or the LLM classifier.
   * Every hit saved one decision-model round-trip (~150ms-6s). */
  deviceCommandHit: number
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
  //
  // §7.123 (2026-10-27): the category alternation MUST cover the full
  // 4-category union. It used to accept only `LOCAL|CLOUD`, while
  // `coerceClassification` accepts LOCAL|CLOUD|SANITIZED|REJECT — so a
  // malformed-JSON verdict whose category was SANITIZED or REJECT fell
  // through Tier 3 and landed on the keyword-rules tier. A dropped REJECT
  // is a dropped BLOCK: the request was classified as dangerous and then
  // silently re-routed. The alternation now mirrors coerceClassification
  // exactly; unknown categories still return null → rules tier.
  const categoryMatch = /["']?category["']?\s*[:=]\s*["']?(LOCAL|CLOUD|SANITIZED|REJECT)["']?/iu.exec(cleaned)
  // `[:=]?` — separator is optional: qwen3-4b sometimes emits
  // `confidence 0.8` (whitespace only), sometimes `confidence: 0.8`,
  // sometimes `confidence=0.8`. All three should be recovered.
  const confidenceMatch = /["']?confidence["']?\s*[:=]?\s*([0-9.]+)/iu.exec(cleaned)
  if (categoryMatch && confidenceMatch) {
    const conf = Number(confidenceMatch[1])
    return {
      category: categoryMatch[1].toUpperCase() as 'LOCAL' | 'CLOUD' | 'SANITIZED' | 'REJECT',
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
  // §7.102: the intent stage config comes from config/edge.json
  // (stages.intent.*). The cordis patch row no longer reads process.env —
  // the desktop GUI never had those variables.
  const intentStage = loadEdgeConfig().stages?.intent
  if (intentStage) {
    if (intentStage.provider !== undefined) {
      ;(config as { classificationProvider: string }).classificationProvider = intentStage.provider
    }
    if (intentStage.defaultCategory !== undefined) {
      ;(config as { defaultCategory: 'LOCAL' | 'CLOUD' | 'SANITIZED' }).defaultCategory =
        intentStage.defaultCategory as 'LOCAL' | 'CLOUD' | 'SANITIZED'
    }
    if (intentStage.timeoutMs !== undefined) {
      ;(config as { llmTimeoutMs: number }).llmTimeoutMs = intentStage.timeoutMs
    }
    if (intentStage.confidenceThreshold !== undefined) {
      ;(config as { confidenceThreshold: number }).confidenceThreshold = intentStage.confidenceThreshold
    }
    if (intentStage.recentLimit !== undefined) {
      ;(config as { recentMessagesLimit: number }).recentMessagesLimit = intentStage.recentLimit
    }
    if (intentStage.maxInput !== undefined) {
      ;(config as { maxInputLength: number }).maxInputLength = intentStage.maxInput
    }
    if (intentStage.cloudKeywords !== undefined) {
      ;(config as { cloudKeywords: string[] }).cloudKeywords = intentStage.cloudKeywords
    }
    if (intentStage.localEntities !== undefined) {
      ;(config as { localEntities: string[] }).localEntities = intentStage.localEntities
    }
    if (intentStage.fallbackKeywords !== undefined) {
      ;(config as { fallbackKeywords: string[] }).fallbackKeywords = intentStage.fallbackKeywords
    }
    // §7.124 (2026-10-27): 家庭设备操作正则层的 operator 扩展词表。
    if (intentStage.deviceCommands !== undefined) {
      ;(config as { deviceCommands: { devices: string[]; actions: string[] } }).deviceCommands = {
        devices: intentStage.deviceCommands.devices ?? [],
        actions: intentStage.deviceCommands.actions ?? [],
      }
    }
    // §7.115: decision-model-only mode switch (stages.intent.llmFallback).
    if (intentStage.llmFallback !== undefined) {
      ;(config as { llmFallback: boolean }).llmFallback = intentStage.llmFallback
    }
  }
  // §7.102: the jev pre-filter knobs come from config/edge.json (jev.*).
  // The Schema carries no defaults for them (constructor `??` literals are
  // the last resort), so an unset patch row leaves the field undefined
  // here and the file can fill it.
  const jev = loadEdgeConfig().jev
  if (jev) {
    const c = config as unknown as Record<string, unknown>
    const fill = (key: string, value: unknown): void => {
      if (value !== undefined && c[key] === undefined) c[key] = value
    }
    fill('jevEnabled', jev.enabled)
    fill('jevUrl', jev.url)
    // §7.112: Bailian decision-model backend (provider / model / auth).
    fill('jevProvider', jev.provider)
    fill('jevModel', jev.model)
    fill('jevAuthScheme', jev.authScheme)
    fill('jevPath', jev.path)
    const jpoolApiKey = jevPool().apiKey
    if (jpoolApiKey !== undefined) fill('jevApiKey', jpoolApiKey)
    // §7.154: a jev.apiKeyRef naming a slot that is not there leaves the
    // decision model without a credential — the stage then silently falls
    // back to the rule tier. Say it at boot, not at the first fallback.
    {
      const dangling = danglingSecretRefs().filter((r) => r.field.startsWith('jev.'))
      if (dangling.length > 0) {
        ctx.logger?.error?.(
          `[intent-router] 配置里的密钥引用指向不存在的槽位：${formatDanglingSecretRefs(dangling)}`
          + ' —— 判定模型没有凭据，jev 路径会静默退回规则档',
        )
      }
    }
    fill('jevTimeoutMs', jev.timeoutMs)
    fill('jevConfidenceThreshold', jev.confidenceThreshold)
    fill('jevRiskThreshold', jev.riskThreshold)
    // 方向分闸：LOCAL 倾向的判决用低门（默认本地，不落 LLM），
    // 非 LOCAL 仍走 jevConfidenceThreshold（出网要严门）。
    // 这一项在配置面（edge-config.ts / edge.example.json）早已声明，
    // 但此前漏接线 ⇒ 写了不生效，静默走构造默认值。
    fill('jevLocalAdoptFloor', jev.localAdoptFloor)
    fill('jevBreakerTtlMs', jev.breakerTtlMs)
    fill('jevBootProbeEnabled', jev.bootProbeEnabled)
    fill('jevBootProbeTimeoutMs', jev.bootProbeTimeoutMs)
    fill('jevBreakerProbeMs', jev.breakerProbeMs)
    fill('jevProbeTimeoutMs', jev.probeTimeoutMs)
  }
  // §7.102: the classification model follows stages.intent.model when set,
  // else the LOCAL pool (llm.local.model) — the file is the single source
  // of truth. §7.100 privacy invariant: the classifier may only target the
  // local pool; a cloud provider here would ship the raw user text out.
  const stageModel = intentStage?.model?.trim()
  const poolModel = stageModel && stageModel.length > 0 ? stageModel : localPool().model
  if (poolModel && config.classificationModel !== poolModel) {
    ctx.logger?.info?.(`[intent-router] classificationModel from config/edge.json: ${config.classificationModel} → ${poolModel}`)
    ;(config as { classificationModel: string }).classificationModel = poolModel
  }
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