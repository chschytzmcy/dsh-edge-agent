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
}

export const Config: Schema<Config> = Schema.object({
  defaultCategory: Schema.union(['LOCAL', 'CLOUD', 'SANITIZED'] as const)
    .default('CLOUD'),
  classificationProvider: Schema.string().default('local-qwen3-4b'),
  classificationModel: Schema.string().default('qwen3-4b'),
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
  private readonly llm: any
  private readonly auditLog: AuditLike | undefined

  constructor(ctx: Context, config: Config, auditLog?: AuditLike) {
    super(ctx, 'intentRouter')
    this.defaultCategory = config.defaultCategory
    this.classificationProvider = config.classificationProvider
    this.classificationModel = config.classificationModel
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

    const prompt = `判断以下用户请求属于哪类：
- LOCAL：本地文件操作、设备控制、数学计算、系统管理
- CLOUD：知识问答、聊天、创意写作、需要联网的任务

只回答 LOCAL 或 CLOUD，不要其他内容。

用户请求：${text}

类别：`

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

    const normalized = responseText.trim().toUpperCase()
    if (normalized.includes('LOCAL')) {
      return {
        category: 'LOCAL',
        confidence: 0.85,
        targetRealm: 'local',
        rationale: 'llm-classified:local',
        dataLevel: 'public',
        requiresSanitization: false,
      }
    } else if (normalized.includes('CLOUD')) {
      return {
        category: 'CLOUD',
        confidence: 0.85,
        targetRealm: 'cloud',
        rationale: 'llm-classified:cloud',
        dataLevel: 'public',
        requiresSanitization: false,
      }
    }

    // LLM responded but unclear, fall back to rules
    this.audit('debug', 'intent.llm.unclear', { responsePreview: normalized.slice(0, 40) })
    throw new Error('intent-router: llm response unclear')
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