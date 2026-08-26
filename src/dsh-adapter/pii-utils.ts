/**
 * pii-utils — 共享的 PII 检测与脱敏工具
 *
 * 供 prompt-guard 和 audit-log 复用，避免重复定义正则规则。
 *
 * @module dsh-edge-agent/pii-utils
 */

export interface PIIRule {
  name: 'phone' | 'id-card' | 'bank-card' | 'email' | 'api-key'
    | 'ip-address' | 'mac-address' | 'passport' | 'license-plate'
  pattern: RegExp
  mask: (match: string) => string
}

/**
 * 9 种 PII 规则：手机号、身份证、银行卡、邮箱、API Key、IP 地址、
 * MAC 地址、护照号、车牌号。
 *
 * 与 `privacy-policy.json` shipped 9 条 sanitizationRules + DEFAULT_POLICY
 * 完全对齐（2026-08-26 多次修复）：
 * - 5→9 条扩展（ip/mac/passport/license-plate）
 * - P0 修复 api-key 正则（允许 sk-proj-XXX 等真实前缀）
 * - P1 修复规则顺序 + phone 加 \b 边界（防止 phone 误截断 id-card）
 */
export const PII_RULES: PIIRule[] = [
  // 规则顺序：长规则优先(id-card → bank-card → phone),
  // 防止 phone 正则在 18 位身份证号 / 16-19 位银行卡号内部子串误命中
  // (P1 修复 2026-08-26)。
  {
    name: 'id-card',
    pattern: /\d{17}[\dXx]/g,
    mask: (m) => `${m.slice(0, 3)}***********${m.slice(14)}`,
  },
  {
    name: 'bank-card',
    pattern: /\b\d{16,19}\b/g,
    mask: (m) => `${m.slice(0, 4)}**********${m.slice(-4)}`,
  },
  {
    name: 'phone',
    // \b 边界防御：即使 id-card/bank-card 漏过,11 位 phone 子串也不会
    // 在更长数字串内部误命中(如身份证号 `110101199003078811` 内部
    // 子串 `19900307881`)
    pattern: /\b1[3-9]\d{9}\b/g,
    mask: (m) => `${m.slice(0, 3)}****${m.slice(7)}`,
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
    // P0 修复 (2026-08-26): 允许 sk- 后跟 OpenAI/Anthropic 风格的可选项目名前缀
    // (proj-/ant-/live-/test-/org-), 否则真实 sk-proj-XXX / sk-ant-XXX 全部漏过
    pattern: /sk-(?:proj-|ant-|live-|test-|org-)?[a-zA-Z0-9]{20,}/g,
    mask: () => 'sk-***',
  },
  // P1 (2026-08-26): 4 类扩展 PII,与 shipped privacy-policy.json 对齐
  {
    name: 'ip-address',
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    mask: (m) => {
      // 保留前两段 + 后两段掩码
      const parts = m.split('.')
      return `${parts[0]}.${parts[1]}.***.***`
    },
  },
  {
    name: 'mac-address',
    pattern: /([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}/g,
    mask: (m) => {
      // MAC: 00:1A:2B:3C:4D:5E → 00:1A:**:**:**:**
      const parts = m.split(/[:-]/)
      return `${parts[0]}:${parts[1]}:**:**:**:**`
    },
  },
  {
    name: 'passport',
    pattern: /\b(?:E[0-9A-Z]\d{7}|G\d{8})\b/g,
    mask: (m) => `${m[0]}****${m.slice(-2)}`,
  },
  {
    name: 'license-plate',
    // 京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤川青藏琼 + 字母 + 5 位
    pattern: /[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤川青藏琼][A-Z][A-HJ-NP-Z0-9]{5}/g,
    mask: (m) => `${m[0]}*·*****`,
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
