/**
 * sanitizer-pipeline — forward sanitization (PII → placeholders) and
 * reverse desanitization (placeholders → PII) for SANITIZED-realm
 * sessions. The mapping table is per-session and stored in memory.
 *
 * Phase 4 完整实现：
 * - 正向脱敏（PII → 占位符）
 * - 反向还原（占位符 → PII）
 * - 会话级映射表
 * - 与 privacy-policy 联动（获取脱敏规则）
 *
 * @module dsh-edge-agent/sanitizer-pipeline
 */

import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { PrivacyPolicyServiceImpl, SanitizationRule } from './privacy-policy.js'

export const name = 'sanitizer-pipeline'

export const inject = ['privacyPolicy', 'auditLog'] as const

export interface Config {
  enableAutoDetection: boolean
  maxReplacementsPerSession: number
}

export const Config: Schema<Config> = Schema.object({
  enableAutoDetection: Schema.boolean().default(true),
  maxReplacementsPerSession: Schema.natural().default(1024),
})

export interface Replacement {
  original: string
  placeholder: string
  piiType: string
  dataClass: string
}

export interface SanitizationResult {
  sanitizedText: string
  sessionId: string
  replacements: Replacement[]
}

export interface SanitizerService {
  sanitize(text: string, context?: { sessionId?: string }): Promise<SanitizationResult>
  desanitize(text: string, sessionId: string): Promise<string>
  desanitizeSync(text: string, sessionId: string): string
  purge(sessionId: string): Promise<void>
  getMappingSize(sessionId: string): number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sanitizer: SanitizerServiceImpl
  }
}

/**
 * Per-session mapping table: placeholder → original value.
 */
interface SessionMapping {
  counter: number
  placeholders: Map<string, string> // placeholder → original
}

export class SanitizerServiceImpl extends Service implements SanitizerService {
  private sessionMappings = new Map<string, SessionMapping>()
  private readonly maxReplacementsPerSession: number
  private readonly enableAutoDetection: boolean

  constructor(
    ctx: any,
    config: Config,
    private privacyPolicy: PrivacyPolicyServiceImpl,
    private auditLog: any,
  ) {
    super(ctx, 'sanitizer')
    this.maxReplacementsPerSession = config.maxReplacementsPerSession
    this.enableAutoDetection = config.enableAutoDetection
  }

  /**
   * Forward sanitization: replace PII with placeholders.
   * Returns the sanitized text and the list of replacements made.
   */
  async sanitize(
    text: string,
    context?: { sessionId?: string },
  ): Promise<SanitizationResult> {
    const sessionId = context?.sessionId ?? 'default'
    let mapping = this.sessionMappings.get(sessionId)
    if (!mapping) {
      mapping = { counter: 0, placeholders: new Map() }
      this.sessionMappings.set(sessionId, mapping)
    }

    const rules = this.privacyPolicy.getSanitizationRules()
    let sanitizedText = text
    const replacements: Replacement[] = []

    for (const rule of rules) {
      try {
        const regex = new RegExp(rule.pattern, 'gi')
        const matches = sanitizedText.match(regex) || []
        for (const match of matches) {
          // Check if we've already replaced this exact value in this session
          let placeholder = this.findExistingPlaceholder(mapping, match)
          if (!placeholder) {
            // Create new placeholder
            mapping.counter++
            const piiType = rule.piiType || 'PII'
            placeholder = `[${piiType.toUpperCase()}_${mapping.counter}]`
            mapping.placeholders.set(placeholder, match)
          }
          sanitizedText = sanitizedText.replace(match, placeholder)
          replacements.push({
            original: match,
            placeholder,
            piiType: rule.piiType,
            dataClass: rule.dataClass,
          })
          // Check limit
          if (mapping.placeholders.size >= this.maxReplacementsPerSession) {
            await this.audit('warn', 'sanitizer.limit-reached', {
              sessionId,
              limit: this.maxReplacementsPerSession,
            })
            break
          }
        }
      } catch {
        // Invalid regex, skip
      }
    }

    if (replacements.length > 0) {
      await this.audit('info', 'sanitizer.sanitized', {
        sessionId,
        replacementCount: replacements.length,
        totalMappings: mapping.placeholders.size,
      })
    }

    return { sanitizedText, sessionId, replacements }
  }

  /**
   * Reverse restoration: replace placeholders back to original PII.
   */
  async desanitize(text: string, sessionId: string): Promise<string> {
    const mapping = this.sessionMappings.get(sessionId)
    if (!mapping) return text

    let restoredText = text
    for (const [placeholder, original] of mapping.placeholders.entries()) {
      // Replace all occurrences of the placeholder
      restoredText = restoredText.split(placeholder).join(original)
    }

    if (restoredText !== text) {
      await this.audit('debug', 'sanitizer.desanitized', {
        sessionId,
        restored: restoredText !== text,
      })
    }

    return restoredText
  }

  /**
   * Synchronous variant of desanitize — no audit log, for use in streaming
   * event callbacks where async is not available.
   */
  desanitizeSync(text: string, sessionId: string): string {
    const mapping = this.sessionMappings.get(sessionId)
    if (!mapping) return text

    let restoredText = text
    for (const [placeholder, original] of mapping.placeholders.entries()) {
      restoredText = restoredText.split(placeholder).join(original)
    }
    return restoredText
  }

  /**
   * Purge all mappings for a session (e.g., when session is deleted).
   */
  async purge(sessionId: string): Promise<void> {
    const mapping = this.sessionMappings.get(sessionId)
    if (mapping) {
      const size = mapping.placeholders.size
      this.sessionMappings.delete(sessionId)
      await this.audit('info', 'sanitizer.purged', { sessionId, purgedMappings: size })
    }
  }

  /**
   * Get the number of mappings for a session (for debugging/testing).
   */
  getMappingSize(sessionId: string): number {
    return this.sessionMappings.get(sessionId)?.placeholders.size ?? 0
  }

  /**
   * Find if a value has already been assigned a placeholder in this session.
   */
  private findExistingPlaceholder(mapping: SessionMapping, value: string): string | null {
    for (const [placeholder, original] of mapping.placeholders.entries()) {
      if (original === value) return placeholder
    }
    return null
  }

  private async audit(level: string, kind: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.auditLog?.log) return
    try {
      await this.auditLog.log({ level, kind, source: 'sanitizer-pipeline', payload })
    } catch {
      // Ignore audit errors
    }
  }
}

export async function apply(ctx: any, config: Config): Promise<() => Promise<void>> {
  const privacyPolicy = ctx.get('privacyPolicy')
  const auditLog = ctx.get('auditLog')
  const service = new SanitizerServiceImpl(ctx, config, privacyPolicy, auditLog)
  return async () => {
    // Cleanup all session mappings on shutdown
    for (const sessionId of service['sessionMappings'].keys()) {
      await service.purge(sessionId)
    }
  }
}
