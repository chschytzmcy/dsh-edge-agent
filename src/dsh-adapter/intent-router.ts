/**
 * intent-router — LLM-based intent classification.
 *
 * Uses the local Qwen3-4B (via ctx.llm) to classify user messages as
 * LOCAL (file ops, device control, calculations) or CLOUD (knowledge,
 * chat, creative tasks). Falls back to keyword rules when LLM is
 * unavailable or in mock mode.
 *
 * @module dsh-edge-agent/intent-router
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'intent-router'

export const inject = ['llm'] as const

export interface Config {
  /** Default realm when classification finds no rule. */
  defaultCategory: 'LOCAL' | 'CLOUD' | 'SANITIZED'
  /** Provider to use for intent classification. */
  classificationProvider: string
}

export const Config: Schema<Config> = Schema.object({
  defaultCategory: Schema.union(['LOCAL', 'CLOUD', 'SANITIZED'] as const)
    .default('CLOUD'),
  classificationProvider: Schema.string().default('local-qwen3-4b-mock'),
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
  private readonly llm: any

  constructor(ctx: Context, config: Config) {
    super(ctx, 'intentRouter')
    this.defaultCategory = config.defaultCategory
    this.classificationProvider = config.classificationProvider
    this.llm = (ctx as any).llm
  }

  async classify(text: string, context?: { recentMessages?: unknown[] }): Promise<Intent> {
    // Try LLM classification first
    try {
      return await this.classifyWithLlm(text)
    } catch (err) {
      // Fall back to keyword rules
      return this.classifyWithRules(text)
    }
  }

  private async classifyWithLlm(text: string): Promise<Intent> {
    if (!this.llm) {
      return this.classifyWithRules(text)
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

    let responseText = ''
    try {
      const stream = this.llm.generate({
        provider: this.classificationProvider,
        messages: [userMessage],
      })

      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') {
          responseText += (chunk as any).text
        }
      }
    } catch (err) {
      // LLM call failed, fall back to rules
      return this.classifyWithRules(text)
    }

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
    return this.classifyWithRules(text)
  }

  private classifyWithRules(text: string): Intent {
    const lower = text.toLowerCase()
    const hasLocalKeyword = LOCAL_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()))

    if (hasLocalKeyword) {
      return {
        category: 'LOCAL',
        confidence: 0.7,
        targetRealm: 'local',
        rationale: 'rule-keyword-match',
        dataLevel: 'public',
        requiresSanitization: false,
      }
    }

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
  const service = new IntentRouterServiceImpl(ctx, config)
  return async () => {}
}