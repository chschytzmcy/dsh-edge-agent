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
import { createHmac, timingSafeEqual } from 'node:crypto'

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
  version: '1.2.0',
  routingRules: [
    // REJECT rules — must come first (first-match-wins)
    // Only business-dangerous operations; attack patterns handled by prompt-guard
    {
      pattern: '(导出|删除|清空|格式化).*(数据库|系统|磁盘|全部数据)',
      realm: 'REJECT',
      confidence: 0.9,
      rationale: 'Dangerous system operation',
    },
    {
      pattern: '(drop\\s+table|rm\\s+-rf|format\\s+[a-z]:|del\\s+/[fs])',
      realm: 'REJECT',
      confidence: 0.95,
      rationale: 'Destructive command pattern',
    },
    // LOCAL rules
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
    // P1 (2026-08-24): IP / MAC / passport / license plate — low FP, high-value
    {
      pattern: '\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b',
      replacement: '[IP_$&]',
      dataClass: 'confidential',
      piiType: 'ip-address',
    },
    {
      pattern: '([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}',
      replacement: '[MAC_$&]',
      dataClass: 'confidential',
      piiType: 'mac-address',
    },
    {
      pattern: '(E[0-9A-Z]\\d{7}|G\\d{8})',
      replacement: '[PASSPORT_$&]',
      dataClass: 'secret',
      piiType: 'passport',
    },
    {
      pattern: '[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤川青藏琼][A-Z][A-HJ-NP-Z0-9]{5}',
      replacement: '[PLATE_$&]',
      dataClass: 'confidential',
      piiType: 'license-plate',
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
  /**
   * HMAC-SHA256 key for policy file signature verification. Read once at
   * construction from `DSH_EDGE_POLICY_HMAC_KEY`. When set, every reload
   * (initial + hot-reload) verifies `<policyPath>.sig` contains
   * `hex(hmac_sha256(policyBody, key))`. Empty/undefined disables the
   * check (dev/CI default) and emits `policy.signing.disabled` audit.
   */
  private readonly hmacKey: string | undefined

  constructor(
    ctx: any,
    private config: Config,
    private auditLog: any,
  ) {
    super(ctx, 'privacyPolicy')
    this.hmacKey = process.env.DSH_EDGE_POLICY_HMAC_KEY?.trim() || undefined
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

      // Signature verification (fail-closed on tamper). Only runs when
      // DSH_EDGE_POLICY_HMAC_KEY is set. On mismatch: keep the in-memory
      // policy, audit 'security', do NOT update lastMtime so the same
      // tampered mtime does not re-trigger every poll.
      if (this.hmacKey) {
        const sigPath = `${path}.sig`
        if (!existsSync(sigPath)) {
          await this.audit('security', 'policy.tamper-detected', {
            path, reason: 'signature-file-missing', sigPath,
          })
          return
        }
        let sigOk = false
        try {
          const sigRaw = await readFile(sigPath, 'utf-8')
          sigOk = this.verifySignature(raw, sigRaw)
        } catch (err: any) {
          await this.audit('security', 'policy.tamper-detected', {
            path, reason: 'signature-read-failed', error: err?.message ?? String(err),
          })
          return
        }
        if (!sigOk) {
          await this.audit('security', 'policy.tamper-detected', {
            path, reason: 'hmac-mismatch',
          })
          return
        }
      } else {
        // First time we observe the "signing disabled" state — emit once
        // so operators know the dev/CI default is in effect.
        if (!this.signingDisabledEmitted) {
          this.signingDisabledEmitted = true
          await this.audit('info', 'policy.signing.disabled', {
            hint: 'set DSH_EDGE_POLICY_HMAC_KEY to enable tamper detection',
          })
        }
      }

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

  /**
   * HMAC-SHA256 verification using `node:crypto.timingSafeEqual`.
   * Returns true iff `sigRaw` (hex) equals HMAC-SHA256(raw, hmacKey).
   * Lenient on whitespace / case in `sigRaw` to keep operator workflow
   * (`sha256sum policy.json | openssl dgst -hmac KEY -hex`) forgiving.
   */
  private verifySignature(raw: string, sigRaw: string): boolean {
    if (!this.hmacKey) return true
    const expected = createHmac('sha256', this.hmacKey).update(raw, 'utf-8').digest()
    const cleaned = sigRaw.trim().replace(/^0x/u, '').replace(/\s+/gu, '').toLowerCase()
    if (!/^[0-9a-f]+$/u.test(cleaned)) return false
    if (cleaned.length !== expected.length * 2) return false
    let actual: Buffer
    try {
      actual = Buffer.from(cleaned, 'hex')
    } catch {
      return false
    }
    try {
      return timingSafeEqual(expected, actual)
    } catch {
      return false
    }
  }

  /** Latch so the dev/CI "signing disabled" audit fires at most once. */
  private signingDisabledEmitted = false

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
