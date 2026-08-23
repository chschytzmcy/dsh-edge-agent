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
}

export const Config: Schema<Config> = Schema.object({
  defaultCategory: Schema.union(['LOCAL', 'CLOUD', 'SANITIZED'] as const)
    .default('CLOUD'),
  classificationProvider: Schema.string().default('local-qwen3-4b'),
  classificationModel: Schema.string().default('qwen3-4b'),
  confidenceThreshold: Schema.natural().default(0.6),
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
  classify(text: string, context?: { recentMessages?: unknown[] }): Promise<Intent>
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
  private readonly llm: any
  private readonly auditLog: AuditLike | undefined

  constructor(ctx: Context, config: Config, auditLog?: AuditLike) {
    super(ctx, 'intentRouter')
    this.defaultCategory = config.defaultCategory
    this.classificationProvider = config.classificationProvider
    this.classificationModel = config.classificationModel
    this.confidenceThreshold = config.confidenceThreshold
    this.llm = (ctx as any).llm
    this.auditLog = auditLog
  }

  private audit(level: 'debug' | 'info' | 'warn' | 'error' | 'security', kind: string, payload: Record<string, unknown>): void {
    if (!this.auditLog) return
    void this.auditLog.log({ level, kind, source: 'intent-router', payload }).catch(() => {})
  }

  async classify(text: string, context?: { recentMessages?: unknown[] }): Promise<Intent> {
    const start = Date.now()
    const textPreview = text.slice(0, 80)
    this.audit('info', 'intent.classify.start', { textLen: text.length, textPreview, classifier: this.classificationProvider, model: this.classificationModel })

    // Try LLM classification first
    try {
      const intent = await this.classifyWithLlm(text)
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

  private async classifyWithLlm(text: string): Promise<Intent> {
    if (!this.llm) {
      this.audit('debug', 'intent.llm.skipped', { reason: 'no-llm-handle' })
      throw new Error('intent-router: no llm handle')
    }

    // Phase B: ask for structured JSON output with explicit confidence.
    // Below the configured threshold we fall back to keyword rules
    // (fail-open; we do NOT reject — see plan Phase B).
    const prompt = `判断以下用户请求属于哪类：
- LOCAL：本地文件操作、设备控制、数学计算、系统管理
- CLOUD：知识问答、聊天、创意写作、需要联网的任务

Respond ONLY with a single JSON object — no prose, no Markdown:
{ "category": "LOCAL"|"CLOUD", "confidence": <0.0-1.0> }

用户请求：${text}`

    const userMessage = createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    })

    const llmStart = Date.now()
    let responseText = ''
    let chunks = 0
    try {
      const stream = this.llm.stream({
        provider: this.classificationProvider,
        model: this.classificationModel,
        messages: [userMessage],
      })

      for await (const chunk of stream) {
        chunks++
        if (chunk.type === 'text-delta') {
          responseText += (chunk as any).text
        }
      }
    } catch (err: any) {
      this.audit('warn', 'intent.llm.error', { durationMs: Date.now() - llmStart, error: err?.message ?? String(err) })
      throw err
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
    const lower = text.toLowerCase()
    const matched = LOCAL_KEYWORDS.find((kw) => lower.includes(kw.toLowerCase()))

    if (matched !== undefined) {
      this.audit('debug', 'intent.rules.hit', { matchedKeyword: matched })
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