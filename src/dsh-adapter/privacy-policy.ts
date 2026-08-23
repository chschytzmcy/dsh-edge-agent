/**
 * privacy-policy — engine that loads, validates, and hot-reloads the
 * privacy policy file. The policy controls routing rules, sanitization
 * rules, data classifications, and global constraints.
 *
 * Phase 4 完整实现：
 * - 策略文件加载（JSON）
 * - 路由规则（LOCAL/CLOUD/SANITIZED/REJECT）
 * - 脱敏规则（PII 类型、策略、模板）
 * - 数据分类（public/internal/confidential/secret）
 * - 热更新（文件监控）
 * - 全局约束（云端请求限制等）
 *
 * @module dsh-edge-agent/privacy-policy
 */

import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'

export const name = 'privacy-policy'

export const inject = ['auditLog'] as const

export interface Config {
  policyPath: string
  hotReload: boolean
  watchIntervalMs: number
}

export const Config: Schema<Config> = Schema.object({
  policyPath: Schema.string().required(),
  hotReload: Schema.boolean().default(true),
  watchIntervalMs: Schema.natural().default(5000),
})

export interface RoutingRule {
  /** Regex pattern to match against user input. */
  pattern: string
  /** Target realm for matching requests. */
  realm: 'LOCAL' | 'CLOUD' | 'SANITIZED' | 'REJECT'
  /** Confidence threshold (0-1). */
  confidence: number
  /** Human-readable rationale. */
  rationale: string
}

export interface SanitizationRule {
  /** Regex pattern to match PII. */
  pattern: string
  /** Replacement template (e.g., "[PHONE_$1]"). */
  replacement: string
  /** Data classification class. */
  dataClass: string
  /** PII type name (phone, email, etc.). */
  piiType: string
}

export interface DataClassification {
  /** Classification class name. */
  class: 'public' | 'internal' | 'confidential' | 'secret'
  /** Default realm for this classification. */
  defaultRealm: 'LOCAL' | 'CLOUD' | 'SANITIZED'
  /** TTL in seconds for cached classifications. */
  ttlSeconds: number
}

export interface GlobalConstraints {
  /** Max cloud requests per minute. */
  maxCloudRequestsPerMinute: number
  /** Whether to require attestation for cloud requests. */
  requireAttestation: boolean
  /** Block all requests if TCB is compromised. */
  blockIfTcbCompromised: boolean
}

export interface PrivacyPolicy {
  version: string
  routingRules: RoutingRule[]
  sanitizationRules: SanitizationRule[]
  dataClassifications: DataClassification[]
  globalConstraints: GlobalConstraints
}

export interface PrivacyPolicyService {
  reload(): Promise<void>
  get(): PrivacyPolicy
  getRoutingRules(): RoutingRule[]
  getSanitizationRules(): SanitizationRule[]
  getClassifications(): DataClassification[]
  getConstraints(): GlobalConstraints
  /** Match input against routing rules; returns first match or null. */
  matchRouting(text: string): RoutingRule | null
  /** Classify data based on patterns; returns classification class. */
  classifyData(text: string): string
  on(event: 'policy/loaded', listener: (policy: PrivacyPolicy) => void): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    privacyPolicy: PrivacyPolicyServiceImpl
  }
}

/**
 * Default policy used when no policy file exists or loading fails.
 */
const DEFAULT_POLICY: PrivacyPolicy = {
  version: '1.0.0',
  routingRules: [
    {
      pattern: '(本地|local|文件|file|计算|calculate)',
      realm: 'LOCAL',
      confidence: 0.8,
      rationale: 'Local operations stay on device',
    },
  ],
  sanitizationRules: [
    {
      pattern: '1[3-9]\\d{9}',
      replacement: '[PHONE_$&]',
      dataClass: 'confidential',
      piiType: 'phone',
    },
    {
      pattern: '([\\w.-]+)@([\\w.-]+\\.\\w+)',
      replacement: '[EMAIL_$&]',
      dataClass: 'confidential',
      piiType: 'email',
    },
  ],
  dataClassifications: [
    { class: 'public', defaultRealm: 'CLOUD', ttlSeconds: 3600 },
    { class: 'internal', defaultRealm: 'SANITIZED', ttlSeconds: 1800 },
    { class: 'confidential', defaultRealm: 'LOCAL', ttlSeconds: 900 },
    { class: 'secret', defaultRealm: 'LOCAL', ttlSeconds: 300 },
  ],
  globalConstraints: {
    maxCloudRequestsPerMinute: 20,
    requireAttestation: false,
    blockIfTcbCompromised: true,
  },
}

export class PrivacyPolicyServiceImpl extends Service implements PrivacyPolicyService {
  private policy: PrivacyPolicy = DEFAULT_POLICY
  private lastMtime: number = 0
  private watchTimer: ReturnType<typeof setInterval> | undefined
  private listeners = new Map<string, Set<Function>>()

  constructor(
    ctx: any,
    private config: Config,
    private auditLog: any,
  ) {
    super(ctx, 'privacyPolicy')
  }

  /** Start the policy loader and optional hot-reload watcher. */
  async start(): Promise<void> {
    await this.reload()
    if (this.config.hotReload) {
      this.watchTimer = setInterval(() => {
        void this.checkForUpdates()
      }, this.config.watchIntervalMs)
      if (typeof this.watchTimer.unref === 'function') this.watchTimer.unref()
    }
  }

  /** Stop the hot-reload watcher. */
  stop(): void {
    if (this.watchTimer) {
      clearInterval(this.watchTimer)
      this.watchTimer = undefined
    }
  }

  /** Reload the policy from disk. */
  async reload(): Promise<void> {
    const path = this.config.policyPath
    if (!existsSync(path)) {
      await this.audit('warn', 'policy.missing', { path })
      this.policy = DEFAULT_POLICY
      this.emit('policy/loaded', this.policy)
      return
    }
    try {
      const raw = await readFile(path, 'utf-8')
      const parsed = JSON.parse(raw) as PrivacyPolicy
      // Basic validation
      if (!parsed.version || !Array.isArray(parsed.routingRules)) {
        throw new Error('Invalid policy structure')
      }
      this.policy = parsed
      const stats = await stat(path)
      this.lastMtime = stats.mtimeMs
      await this.audit('info', 'policy.loaded', { path, version: parsed.version })
      this.emit('policy/loaded', this.policy)
    } catch (err: any) {
      await this.audit('error', 'policy.load-failed', { path, error: err.message })
      this.policy = DEFAULT_POLICY
      this.emit('policy/loaded', this.policy)
    }
  }

  /** Check if the policy file has been modified and reload if needed. */
  private async checkForUpdates(): Promise<void> {
    const path = this.config.policyPath
    if (!existsSync(path)) return
    try {
      const stats = await stat(path)
      if (stats.mtimeMs > this.lastMtime) {
        await this.reload()
      }
    } catch {
      // Ignore stat errors
    }
  }

  get(): PrivacyPolicy {
    return this.policy
  }

  getRoutingRules(): RoutingRule[] {
    return this.policy.routingRules
  }

  getSanitizationRules(): SanitizationRule[] {
    return this.policy.sanitizationRules
  }

  getClassifications(): DataClassification[] {
    return this.policy.dataClassifications
  }

  getConstraints(): GlobalConstraints {
    return this.policy.globalConstraints
  }

  /** Match input against routing rules; returns first match or null. */
  matchRouting(text: string): RoutingRule | null {
    for (const rule of this.policy.routingRules) {
      try {
        const regex = new RegExp(rule.pattern, 'i')
        if (regex.test(text)) {
          return rule
        }
      } catch {
        // Invalid regex, skip
      }
    }
    return null
  }

  /** Classify data based on sanitization rules; returns the highest classification. */
  classifyData(text: string): string {
    const classOrder = ['public', 'internal', 'confidential', 'secret']
    let highest = 'public'
    for (const rule of this.policy.sanitizationRules) {
      try {
        const regex = new RegExp(rule.pattern, 'i')
        if (regex.test(text)) {
          const idx = classOrder.indexOf(rule.dataClass)
          const highestIdx = classOrder.indexOf(highest)
          if (idx > highestIdx) {
            highest = rule.dataClass
          }
        }
      } catch {
        // Invalid regex, skip
      }
    }
    return highest
  }

  on(event: string, listener: Function): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set())
    }
    this.listeners.get(event)!.add(listener)
  }

  private emit(event: string, ...args: any[]): void {
    const listeners = this.listeners.get(event)
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(...args)
        } catch {
          // Ignore listener errors
        }
      }
    }
  }

  private async audit(level: string, kind: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.auditLog?.log) return
    try {
      await this.auditLog.log({ level, kind, source: 'privacy-policy', payload })
    } catch {
      // Ignore audit errors
    }
  }
}

export async function apply(ctx: any, config: Config): Promise<() => Promise<void>> {
  const auditLog = ctx.get('auditLog')
  const service = new PrivacyPolicyServiceImpl(ctx, config, auditLog)
  await service.start()
  return async () => {
    service.stop()
  }
}
