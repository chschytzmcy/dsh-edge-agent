/**
 * pii-utils — 共享的 PII 检测与脱敏工具
 *
 * 供 prompt-guard 和 audit-log 复用，避免重复定义正则规则。
 *
 * @module dsh-edge-agent/pii-utils
 */

export interface PIIRule {
  name: 'phone' | 'id-card' | 'bank-card' | 'email' | 'api-key'
  pattern: RegExp
  mask: (match: string) => string
}

/**
 * 5 种 PII 规则：手机号、身份证、银行卡、邮箱、API Key
 * 与 prompt-guard 保持一致。
 */
export const PII_RULES: PIIRule[] = [
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

/**
 * 对单个字符串应用所有 PII 规则，返回脱敏后的字符串和脱敏明细。
 */
export function redactString(
  text: string,
  rules: PIIRule[] = PII_RULES,
): { redacted: string; matches: Array<{ type: string; masked: string }> } {
  let result = text
  const matches: Array<{ type: string; masked: string }> = []

  for (const rule of rules) {
    const found = text.match(rule.pattern) || []
    for (const match of found) {
      const masked = rule.mask(match)
      result = result.replace(match, masked)
      matches.push({ type: rule.name, masked })
    }
  }

  return { redacted: result, matches }
}

/**
 * 深度遍历对象，对所有字符串值应用 PII 脱敏。
 * 返回新对象（不修改原对象）。
 */
export function redactObject<T>(
  obj: T,
  rules: PIIRule[] = PII_RULES,
): { redacted: T; count: number } {
  let count = 0

  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const { redacted, matches } = redactString(value, rules)
      count += matches.length
      return redacted
    }
    if (Array.isArray(value)) {
      return value.map((item) => walk(item))
    }
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = walk(v)
      }
      return out
    }
    return value
  }

  return { redacted: walk(obj) as T, count }
}
