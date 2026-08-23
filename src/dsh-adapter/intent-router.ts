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
}

export const Config: Schema<Config> = Schema.object({
  defaultCategory: Schema.union(['LOCAL', 'CLOUD', 'SANITIZED'] as const)
    .default('CLOUD'),
  classificationProvider: Schema.string().default('local-qwen3-4b'),
  classificationModel: Schema.string().default('qwen3-4b'),
  confidenceThreshold: Schema.natural().default(0.6),
  llmTimeoutMs: Schema.natural().default(4000),
  recentMessagesLimit: Schema.natural().default(3),
  maxInputLength: Schema.natural().default(2000),
  fallbackKeywords: Schema.array(Schema.string()).default([] as string[]),
})

export interface Intent {
  category: 'LOCAL' | 'CLOUD' | 'SANITIZED' | 'REJECT'
  confidence: number
  targetRealm: string
  rationale: string
  dataLevel: 'public' | 'sanitized' | 'internal'
  requiresSanitization: boolean
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

export class IntentRouterServiceImpl extends Service {
  private readonly defaultCategory: Intent['category']
  private readonly classificationProvider: string
  private readonly classificationModel: string
  private readonly confidenceThreshold: number
  private readonly llmTimeoutMs: number
  private readonly recentMessagesLimit: number
  private readonly maxInputLength: number
  private readonly fallbackKeywords: readonly string[]
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
    rejected: 0,
    sanitized: 0,
    sanitizeError: 0,
    sanitizeSkipped: 0,
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
    this.llm = (ctx as any).llm
    this.auditLog = auditLog
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
    const piiUtils = (this.ctx as any).piiUtils
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
        dataLevel: 'public',
        requiresSanitization: this.defaultCategory === 'SANITIZED',
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
    const policy = (this.ctx as any).privacyPolicy
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
            dataLevel: 'internal',
            requiresSanitization: false,
          }
        }
      } catch (err: any) {
        this.audit('warn', 'intent.policy.precheck-error', { error: err?.message ?? String(err) })
        // Pre-check failure is non-fatal; fall through to LLM+rules path.
      }
    }

    const textPreview = effectiveText.slice(0, 80)
    this.audit('info', 'intent.classify.start', { textLen: effectiveText.length, textPreview, classifier: this.classificationProvider, model: this.classificationModel })

    // Try LLM classification first
    try {
      const intent = await this.classifyWithLlm(effectiveText, context?.recentMessages, context?.sessionId)
      this.stats.llmHit++
      this.audit('info', 'intent.classify.end', {
        textLen: effectiveText.length,
        path: 'llm',
        category: intent.category,
        confidence: intent.confidence,
        rationale: intent.rationale,
        durationMs: Date.now() - start,
      })
      return intent
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
    // model-router.ts:103). Current default 'local-qwen3-4b' is fine.
    const modelRouter = (this.ctx as any).modelRouter
    const resolved = (() => {
      try { return modelRouter?.resolve?.(this.classificationProvider) }
      catch { return undefined }
    })()
    const provider = resolved?.provider ?? this.classificationProvider
    const model = resolved?.model ?? this.classificationModel
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
    // Mirrors http-api's pattern: `if (!isLocal && this.sanitizer) ...`.
    // Soft dep: missing or throwing sanitizer → use original text (fail-open,
    // accept PII risk on the classification call; the *real* cloud call
    // through http-api is still sanitized downstream).
    let promptText = text
    const resolvedRealm = resolved?.realm
    if (resolvedRealm === 'CLOUD') {
      const sanitizer = (this.ctx as any).sanitizer
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
          this.audit('warn', 'intent.llm.sanitize-error', {
            error: err?.message ?? String(err),
            originalLen: text.length,
          })
          // fail-open: keep original text
        }
      } else {
        this.stats.sanitizeSkipped++
        this.audit('debug', 'intent.llm.sanitize-skipped', { reason: 'no-sanitizer-handle' })
      }
    }

    // Multi-turn context: best-effort extract text from each message and
    // append a "history" block before the current query. Caps at
    // recentMessagesLimit (default 3) and per-message length to bound prompt size.
    const historyBlock = (() => {
      if (!this.recentMessagesLimit || !recentMessages?.length) return ''
      const tail = recentMessages.slice(-this.recentMessagesLimit)
      const lines: string[] = []
      for (const m of tail) {
        const text = extractMessageText(m).slice(0, 200)
        const role = (m as any)?.role ?? (m as any)?.source?.kind ?? '?'
        if (text) lines.push(`${role}: ${text}`)
      }
      if (!lines.length) return ''
      return `\n最近对话上下文（仅参考，不要分类历史消息本身）：\n${lines.join('\n')}\n`
    })()
    if (recentMessages?.length) {
      this.audit('debug', 'intent.llm.context', {
        received: recentMessages.length,
        embedded: Math.min(recentMessages.length, this.recentMessagesLimit),
      })
    }

    // Phase B: ask for structured JSON output with explicit confidence.
    // Below the configured threshold we fall back to keyword rules
    // (fail-open; we do NOT reject — see plan Phase B).
    const prompt = `判断以下用户请求属于哪类：
- LOCAL：本地文件操作、设备控制、数学计算、系统管理
- CLOUD：知识问答、聊天、创意写作、需要联网的任务
${historyBlock}
Respond ONLY with a single JSON object — no prose, no Markdown:
{ "category": "LOCAL"|"CLOUD", "confidence": <0.0-1.0> }

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
      const stream = this.llm.stream({
        provider,
        model,
        messages: [userMessage],
        signal: controller.signal,
      })

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
      dataLevel: 'public',
      requiresSanitization: false,
    }
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
    const policy = (this.ctx as any).privacyPolicy
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
          dataLevel: 'internal',
          requiresSanitization: false,
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
        // SANITIZED verdict carries a 'sanitized' data level so downstream
        // consumers (sanitizer-pipeline, audit-log) know the payload was
        // re-classified by policy, not the default public assumption.
        dataLevel: realm === 'SANITIZED' ? 'sanitized' : 'public',
        requiresSanitization: realm === 'SANITIZED',
      }
    }

    // Fallback: configurable keyword list (defaults to built-in EN + CN).
    // Used only when privacy-policy is absent / has no matching rule.
    const lower = text.toLowerCase()
    const matched = this.fallbackKeywords.find((kw) => lower.includes(kw.toLowerCase()))

    if (matched !== undefined) {
      this.audit('debug', 'intent.rules.hit', { source: 'fallback-keyword', matchedKeyword: matched })
      return {
        category: 'LOCAL',
        confidence: 0.7,
        targetRealm: 'local',
        rationale: 'rule-keyword-match',
        dataLevel: 'public',
        requiresSanitization: false,
      }
    }

    this.audit('debug', 'intent.rules.miss', { defaultCategory: this.defaultCategory })
    return {
      category: this.defaultCategory,
      confidence: 0.5,
      targetRealm: this.defaultCategory === 'CLOUD' ? 'cloud' : 'local',
      rationale: `default:${this.defaultCategory.toLowerCase()}`,
      dataLevel: 'public',
      requiresSanitization: false,
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
  /** REJECT verdict returned (pre-check or fallback). */
  rejected: number
  /** Sanitizer applied to CLOUD-classification prompt. */
  sanitized: number
  /** Sanitizer threw (fail-open → original text reached LLM). */
  sanitizeError: number
  /** CLOUD realm but no sanitizer handle mounted (fail-open). */
  sanitizeSkipped: number
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
function parseClassificationVerdict(raw: string): ClassificationVerdict | null {
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
  // Tier 3: regex token fallback (category-only, confidence default 0.5)
  const categoryMatch = /["']?category["']?\s*[:=]\s*["']?(LOCAL|CLOUD)["']?/iu.exec(cleaned)
  if (categoryMatch) {
    const confidenceMatch = /["']?confidence["']?\s*[:=]\s*([0-9.]+)/iu.exec(cleaned)
    const conf = confidenceMatch ? Number(confidenceMatch[1]) : 0.5
    return {
      category: categoryMatch[1].toUpperCase() as 'LOCAL' | 'CLOUD',
      confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.5,
    }
  }
  return null
}

function coerceClassification(obj: unknown): ClassificationVerdict | null {
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
function extractMessageText(m: unknown): string {
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