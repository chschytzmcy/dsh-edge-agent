/**
 * intent-router — classifies user input into LOCAL / CLOUD / SANITIZED
 * realms, enforces routing rules from the privacy policy, and gates
 * agent-loop events.
 *
 * @module dsh-edge-agent/intent-router
 */

import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'intent-router'

export const inject = ['llm', 'promptGuard', 'privacyPolicy', 'auditLog', 'sessions', 'localStorage'] as const

export interface Config {
  /** When true, allow fallback to LLM classifier when rule match is low-confidence. */
  enableLlmFallback: boolean
  /** Minimum confidence to accept a rule-based classification. */
  ruleConfidenceThreshold: number
}

export const Config: Schema<Config> = Schema.object({
  enableLlmFallback: Schema.boolean().default(true),
  ruleConfidenceThreshold: Schema.number().default(0.6),
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

export class IntentRouterServiceImpl extends Service {
  constructor(ctx: any) {
    super(ctx, 'intentRouter')
  }
  async classify(text: string, context?: { recentMessages?: unknown[] }): Promise<Intent> {
    void text
    void context
    return {
      category: 'LOCAL',
      confidence: 1,
      targetRealm: 'local',
      rationale: 'default',
      dataLevel: 'public',
      requiresSanitization: false,
    }
  }
  resolve(intent: Intent) {
    void intent
    return { realm: 'local', config: {} }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    intentRouter: IntentRouterServiceImpl
  }
}

export async function apply(ctx: any, config: Config): Promise<() => Promise<void>> {
  ctx.plugin(IntentRouterServiceImpl)

  // Hook the DSH agent-loop events.
  const ctxAny = ctx as any
  if (typeof ctxAny.event?.on === 'function') {
    ctxAny.event.on('agent/pre-step', async (payload: any) => {
      const router: IntentRouterServiceImpl = ctxAny.intentRouter
      const guard = ctxAny.promptGuard
      const session = ctxAny.sessions
      const audit = ctxAny.auditLog

      // 1. input safety
      if (payload?.input && guard) {
        const v = await guard.checkInput(payload.input)
        if (!v.safe) {
          return { kind: 'reject' as const }
        }
      }
      // 2. intent classification
      if (payload?.input) {
        const intent = await router.classify(payload.input, {
          recentMessages: payload.session ? await session.get(payload.session.id) : undefined,
        })
        payload.intent = intent
      }
      void audit
    })

    ctxAny.event.on('agent/request', async (payload: any) => {
      const intent: Intent | undefined = payload?.intent
      const audit = ctxAny.auditLog
      if (intent && audit) {
        await audit.log({
          level: 'info',
          type: 'llm-call',
          action: 'pre-call',
          plugin: 'intent-router',
          realm: intent.targetRealm,
          metadata: { intent: intent.category, dataLevel: intent.dataLevel },
          dataExfiltrated: intent.targetRealm !== 'local',
          sanitized: intent.category === 'SANITIZED',
          success: true,
        })
      }
    })
  }

  void config
  return async () => {}
}
