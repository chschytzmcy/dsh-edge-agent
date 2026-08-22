/**
 * prompt-guard — 端侧隐私安全防护
 *
 * 核心功能：
 * 1. PII 脱敏（手机号、身份证、银行卡、邮箱、API Key）
 * 2. 基础输入限制（长度、频率）
 * 3. 基本注入检测（3 种危险模式）
 *
 * @module dsh-edge-agent/prompt-guard
 */

import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'prompt-guard'

export const inject = ['auditLog'] as const

export interface Config {
  // 输入限制
  maxInputLength: number
  maxRequestsPerMinute: number

  // 功能开关
  enablePIIRedaction: boolean
  enableInjectionDetection: boolean
  enableRateLimit: boolean
}

export const Config: Schema<Config> = Schema.object({
  maxInputLength: Schema.number().default(10000),
  maxRequestsPerMinute: Schema.number().default(20),
  enablePIIRedaction: Schema.boolean().default(true),
  enableInjectionDetection: Schema.boolean().default(true),
  enableRateLimit: Schema.boolean().default(true),
})

// PII 规则
interface PIIRule {
  name: string
  pattern: RegExp
  mask: (match: string) => string
}

const PII_RULES: PIIRule[] = [
  {
    name: 'phone',
    pattern: /1[3-9]\d{9}/g,
    mask: (m) => `${m.slice(0, 3)}****${m.slice(7)}`,
  },
  {
    name: 'id-card',
    pattern: /\d{17}[\dXx]/g,
    mask: (m) => `${m.slice(0, 3)}***********${m.slice(14)}`,
  },
  {
    name: 'bank-card',
    pattern: /\d{16,19}/g,
    mask: (m) => `${m.slice(0, 4)}**********${m.slice(-4)}`,
  },
  {
    name: 'email',
    pattern: /([\w.-]+)@([\w.-]+\.\w+)/g,
    mask: (m) => {
      const [local, domain] = m.split('@')
      return `${local[0]}***@${domain}`
    },
  },
  {
    name: 'api-key',
    pattern: /sk-[a-zA-Z0-9]{20,}/g,
    mask: () => 'sk-***',
  },
]

// 注入检测模式
const INJECTION_PATTERNS = [
  {
    name: 'direct-injection',
    pattern: /ignore\s+(all\s+)?previous\s+instructions/i,
  },
  {
    name: 'prompt-leak',
    pattern: /show\s+me\s+(your\s+)?system\s+prompt/i,
  },
  {
    name: 'role-override',
    pattern: /you\s+are\s+now\s+(a|an)\s+/i,
  },
]

export interface InputCheckResult {
  safe: boolean
  reason?: string
  riskLevel?: 'low' | 'medium' | 'high'
}

export interface OutputCheckResult {
  filtered: string
  redacted: Array<{ type: string; masked: string }>
}

export interface PromptGuardService {
  checkInput(text: string, sessionId: string): Promise<InputCheckResult>
  checkOutput(text: string): Promise<OutputCheckResult>
}

// 频率限制存储
const requestCounts = new Map<string, { count: number; resetTime: number }>()

export class PromptGuardServiceImpl extends Service implements PromptGuardService {
  private config: Config

  constructor(ctx: any, config: Config) {
    super(ctx, 'promptGuard')
    this.config = config
  }

  async checkInput(text: string, sessionId: string): Promise<InputCheckResult> {
    // 1. 长度检查
    if (text.length > this.config.maxInputLength) {
      await this.audit('warn', 'input.too-long', { sessionId, length: text.length })
      return {
        safe: false,
        reason: `Input exceeds max length (${this.config.maxInputLength})`,
        riskLevel: 'medium',
      }
    }

    // 2. 频率限制
    if (this.config.enableRateLimit) {
      const rateLimitResult = this.checkRateLimit(sessionId)
      if (!rateLimitResult.allowed) {
        await this.audit('warn', 'input.rate-limit', { sessionId })
        return {
          safe: false,
          reason: 'Rate limit exceeded',
          riskLevel: 'medium',
        }
      }
    }

    // 3. 注入检测
    if (this.config.enableInjectionDetection) {
      for (const { name, pattern } of INJECTION_PATTERNS) {
        if (pattern.test(text)) {
          await this.audit('security', 'input.injection', {
            sessionId,
            pattern: name,
            preview: text.slice(0, 100),
          })
          return {
            safe: false,
            reason: `Injection pattern detected: ${name}`,
            riskLevel: 'high',
          }
        }
      }
    }

    return { safe: true, riskLevel: 'low' }
  }

  async checkOutput(text: string): Promise<OutputCheckResult> {
    if (!this.config.enablePIIRedaction) {
      return { filtered: text, redacted: [] }
    }

    let filtered = text
    const redacted: Array<{ type: string; masked: string }> = []

    for (const rule of PII_RULES) {
      const matches = text.match(rule.pattern) || []
      for (const match of matches) {
        const masked = rule.mask(match)
        filtered = filtered.replace(match, masked)
        redacted.push({ type: rule.name, masked })
      }
    }

    if (redacted.length > 0) {
      await this.audit('info', 'output.pii-redacted', {
        count: redacted.length,
        types: [...new Set(redacted.map((r) => r.type))],
      })
    }

    return { filtered, redacted }
  }

  private checkRateLimit(sessionId: string): { allowed: boolean } {
    const now = Date.now()
    const record = requestCounts.get(sessionId)

    if (!record || now > record.resetTime) {
      requestCounts.set(sessionId, { count: 1, resetTime: now + 60000 })
      return { allowed: true }
    }

    if (record.count >= this.config.maxRequestsPerMinute) {
      return { allowed: false }
    }

    record.count++
    return { allowed: true }
  }

  private async audit(
    level: 'debug' | 'info' | 'warn' | 'error' | 'security',
    kind: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const auditLog = (this.ctx as any).auditLog
    if (!auditLog?.log) return
    void auditLog.log({ level, kind, source: 'prompt-guard', payload })
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    promptGuard: PromptGuardServiceImpl
  }
}

export async function apply(ctx: any, config: Config): Promise<() => Promise<void>> {
  ctx.plugin(PromptGuardServiceImpl, config)
  return async () => {}
}
