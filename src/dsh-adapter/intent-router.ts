/**
 * intent-router — M1 minimal: every input defaults to CLOUD. The router
 * exists so downstream code can ask "where did this go?" without branching
 * on hard-coded strings. Real classification (rule + LLM fallback) lands
 * in A2; sanitization, prompt-guard, sessions, and audit-log listeners
 * also land there, not in M1.
 *
 * @module dsh-edge-agent/intent-router
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'intent-router'

export const inject = [] as const

export interface Config {
  /** Default realm when classification finds no rule. */
  defaultCategory: 'LOCAL' | 'CLOUD' | 'SANITIZED'
}

export const Config: Schema<Config> = Schema.object({
  defaultCategory: Schema.union(['LOCAL', 'CLOUD', 'SANITIZED'] as const)
    .default('CLOUD'),
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
  private readonly defaultCategory: Intent['category']

  constructor(ctx: Context, defaultCategory: Intent['category']) {
    super(ctx, 'intentRouter')
    this.defaultCategory = defaultCategory
  }

  async classify(text: string, context?: { recentMessages?: unknown[] }): Promise<Intent> {
    return classifyDefault(this.defaultCategory, text, context)
  }

  resolve(intent: Intent): { realm: string; config: Record<string, unknown> } {
    return resolveIntent(intent)
  }
}

/** Pure default classifier used by M1 (no rules, no LLM fallback). */
export function classifyDefault(
  defaultCategory: Intent['category'],
  _text: string,
  _context?: { recentMessages?: unknown[] },
): Intent {
  void _text
  void _context
  return {
    category: defaultCategory,
    confidence: 1,
    targetRealm: defaultCategory === 'CLOUD' ? 'cloud' : 'local',
    rationale: `m1-default:${defaultCategory.toLowerCase()}`,
    dataLevel: 'public',
    requiresSanitization: false,
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
  // IntentRouterServiceImpl extends `Service`, so its constructor calls
  // `ctx.reflect.provide('intentRouter', this)` for us. Do not call
  // `ctx.provide` again — that would throw "service already registered".
  void new IntentRouterServiceImpl(ctx, config.defaultCategory)
  return async () => {}
}