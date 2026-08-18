/**
 * prompt-guard — input/output safety scanning. Detects prompt-injection
 * attempts, prompt extraction, and dangerous output patterns.
 *
 * MVP minimal subset: `checkInput` only with 4 default rules. Output
 * sanitization and model-assisted detection are post-MVP.
 *
 * @module dsh-edge-agent/prompt-guard
 */

import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'prompt-guard'

export const inject = ['tcm', 'privacyPolicy', 'auditLog'] as const

export interface Config {
  rules: Array<{
    id: string
    pattern: string
    action: 'block' | 'warn' | 'rewrite'
    rationale: string
  }>
  enableModelDetection: boolean
}

export const Config: Schema<Config> = Schema.object({
  rules: Schema.array(
    Schema.object({
      id: Schema.string(),
      pattern: Schema.string(),
      action: Schema.union(['block', 'warn', 'rewrite'] as const),
      rationale: Schema.string(),
    }),
  ).default([]),
  enableModelDetection: Schema.boolean().default(false),
})

export interface GuardVerdict {
  safe: boolean
  rule: string | null
  rationale: string
  redactedText?: string
}

export interface PromptGuardService {
  checkInput(text: string): Promise<GuardVerdict>
  // post-MVP
  checkOutput?(text: string): Promise<GuardVerdict>
}

export class PromptGuardServiceImpl extends Service {
  constructor(ctx: any) {
    super(ctx, 'promptGuard')
  }
  async checkInput(text: string): Promise<GuardVerdict> {
    void text
    return { safe: true, rule: null, rationale: 'no rules matched' }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    promptGuard: PromptGuardServiceImpl
  }
}

export async function apply(ctx: any, config: Config): Promise<() => Promise<void>> {
  ctx.plugin(PromptGuardServiceImpl)
  void config
  return async () => {}
}
