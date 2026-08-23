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
}

export const Config: Schema<Config> = Schema.object({
  defaultCategory: Schema.union(['LOCAL', 'CLOUD', 'SANITIZED'] as const)
    .default('CLOUD'),
  classificationProvider: Schema.string().default('local-qwen3-4b'),
  classificationModel: Schema.string().default('qwen3-4b'),
  confidenceThreshold: Schema.natural().default(0.6),
  llmTimeoutMs: Schema.natural().default(4000),
  recentMessagesLimit: Schema.natural().default(3),
})

export interface Intent {
  category: 'LOCAL' | 'CLOUD' | 'SANITIZED'
  confidence: number
  targetRealm: string
  rationale: string
  dataLevel: 'public' | 'sanitized' | 'internal'
  requiresSanitization: boolean
}

export interface IntentRouterService {
  classify(text: string, context?: { recentMessages?: unknown[]; sessionId?: string }): Promise<Intent>
  resolve(intent: Intent): { realm: string; config: Record<string, unknown> }
}

/** Keywords that strongly suggest LOCAL realm. */
const LOCAL_KEYWORDS = [
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
  private readonly llm: any
  private readonly auditLog: AuditLike | undefined

  constructor(ctx: Context, config: Config, auditLog?: AuditLike) {
    super(ctx, 'intentRouter')
    this.defaultCategory = config.defaultCategory
    this.classificationProvider = config.classificationProvider
    this.classificationModel = config.classificationModel
    this.confidenceThreshold = config.confidenceThreshold
    this.llmTimeoutMs = config.llmTimeoutMs ?? 4000
    this.recentMessagesLimit = config.recentMessagesLimit ?? 3
    this.llm = (ctx as any).llm
    this.auditLog = auditLog
  }

  private audit(level: 'debug' | 'info' | 'warn' | 'error' | 'security', kind: string, payload: Record<string, unknown>): void {
    if (!this.auditLog) return
    void this.auditLog.log({ level, kind, source: 'intent-router', payload }).catch(() => {})
  }

  async classify(text: string, context?: { recentMessages?: unknown[]; sessionId?: string }): Promise<Intent> {
    const start = Date.now()
    const textPreview = text.slice(0, 80)
    this.audit('info', 'intent.classify.start', { textLen: text.length, textPreview, classifier: this.classificationProvider, model: this.classificationModel })

    // Try LLM classification first
    try {
      const intent = await this.classifyWithLlm(text, context?.recentMessages, context?.sessionId)
      this.audit('info', 'intent.classify.end', {
        textLen: text.length,
        path: 'llm',
        category: intent.category,
        confidence: intent.confidence,
        rationale: intent.rationale,
        durationMs: Date.now() - start,
      })
      return intent
    } catch (err: any) {
      this.audit('warn', 'intent.classify.llm_error', { textLen: text.length, error: err?.message ?? String(err) })
      // Fall back to keyword rules
      const intent = this.classifyWithRules(text)
      this.audit('info', 'intent.classify.end', {
        textLen: text.length,
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
          this.audit('info', 'intent.llm.sanitized', {
            sessionId: sessionId ?? 'default',
            originalLen: text.length,
            sanitizedLen: promptText.length,
            replacements: replacementCount,
          })
        } catch (err: any) {
          this.audit('warn', 'intent.llm.sanitize-error', {
            error: err?.message ?? String(err),
            originalLen: text.length,
          })
          // fail-open: keep original text
        }
      } else {
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
      this.audit('warn', isAbort ? 'intent.llm.timeout' : 'intent.llm.error', {
        durationMs,
        timeoutMs: this.llmTimeoutMs,
        chunks,
        responseLen: responseText.length,
        error: err?.message ?? String(err),
      })
      throw err
    } finally {
      clearTimeout(timer)
    }
    this.audit('debug', 'intent.llm.response', { durationMs: Date.now() - llmStart, chunks, responseLen: responseText.length, responsePreview: responseText.trim().slice(0, 40) })

    const verdict = parseClassificationVerdict(responseText)
    if (!verdict) {
      this.audit('debug', 'intent.llm.unclear', { responsePreview: responseText.trim().slice(0, 40) })
      throw new Error('intent-router: llm response unclear')
    }
    this.audit('debug', 'intent.llm.parsed', { category: verdict.category, confidence: verdict.confidence })

    // Confidence gate: if below threshold, fall back to keyword rules.
    if (verdict.confidence < this.confidenceThreshold) {
      this.audit('info', 'intent.llm.low-confidence', {
        confidence: verdict.confidence,
        threshold: this.confidenceThreshold,
        category: verdict.category,
      })
      throw new Error(`intent-router: low confidence ${verdict.confidence} < ${this.confidenceThreshold}`)
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
    const policy = (this.ctx as any).privacyPolicy
    let matchedRule: { pattern: string; realm: string; confidence: number; rationale: string } | null = null
    try {
      const r = policy?.matchRouting?.(text)
      if (r && (r.realm === 'LOCAL' || r.realm === 'CLOUD' || r.realm === 'SANITIZED')) {
        matchedRule = r
      }
    } catch (err: any) {
      this.audit('warn', 'intent.policy.error', { error: err?.message ?? String(err) })
    }

    if (matchedRule) {
      const realm = matchedRule.realm
      const targetRealm = realm === 'LOCAL' ? 'local' : realm === 'SANITIZED' ? 'sanitized' : 'cloud'
      this.audit('debug', 'intent.rules.hit', {
        source: 'privacy-policy',
        pattern: matchedRule.pattern,
        realm,
        confidence: matchedRule.confidence,
      })
      return {
        category: realm as Intent['category'],
        confidence: matchedRule.confidence,
        targetRealm,
        rationale: matchedRule.rationale || `policy-rule:${realm.toLowerCase()}`,
        dataLevel: 'public',
        requiresSanitization: realm === 'SANITIZED',
      }
    }

    // Fallback: hardcoded LOCAL_KEYWORDS (kept for deployments without
    // privacy-policy, or with empty routingRules).
    const lower = text.toLowerCase()
    const matched = LOCAL_KEYWORDS.find((kw) => lower.includes(kw.toLowerCase()))

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