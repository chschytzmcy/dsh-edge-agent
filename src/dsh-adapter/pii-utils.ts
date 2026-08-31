/**
 * pii-utils — 共享的 PII 检测与脱敏工具
 *
 * 本模块是**全项目 PII 正则的唯一事实源**（`PII_PATTERNS`）。
 * 消费方：
 *   - `privacy-policy.ts` 的 `DEFAULT_POLICY.sanitizationRules`（直接复用
 *     `PII_PATTERNS`，不再各写一份字面量）
 *   - `sanitizer-pipeline.ts` 经由 `privacyPolicy.getSanitizationRules()`
 *     消费 pattern 字符串做**可逆**脱敏
 *   - `prompt-guard` / `audit-log` / `local-storage` 经由本模块的
 *     `redactString` / `redactObject` 做**不可逆**掩码
 *
 * 两条链路共用同一批 pattern，只有替换语义不同（占位符 vs 掩码），
 * 因此 pattern 必须集中定义，禁止在别处重复书写。
 *
 * @module dsh-edge-agent/pii-utils
 */

export type PIIName =
  | 'id-card' | 'bank-card' | 'phone' | 'email' | 'api-key'
  | 'ip-address' | 'mac-address' | 'passport' | 'license-plate'

/**
 * PII 正则字面量（唯一事实源）。
 *
 * 以 `RegExp` source 语法书写（不含分隔符与 flags），便于同时用于
 * `new RegExp(pattern, 'gi')`（脱敏管线）与本模块的 `RegExp` 实例。
 *
 * 规则顺序见 `PII_ORDER` —— 顺序是语义的一部分，长规则必须先跑。
 */
export const PII_PATTERNS: Record<PIIName, string> = {
  // 严格身份证：省份码 + 19xx/20xx + 合法月日 + 顺序码 + 校验位。
  // `\b` 边界防止在 16-19 位银行卡号内部命中 18 位子串。
  'id-card':
    '\\b[1-9]\\d{5}(?:19|20)\\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\\d|3[01])\\d{3}[\\dXx]\\b',
  'bank-card': '\\b\\d{16,19}\\b',
  // `\b` 边界防止在更长数字串内部误命中 11 位子串
  phone: '\\b1[3-9]\\d{9}\\b',
  email: '[\\w.-]+@[\\w.-]+\\.\\w+',
  'api-key':
    '(?:sk-(?:proj-|ant-|live-|test-|org-)?[a-zA-Z0-9]{20,}|key-[a-zA-Z0-9]{16,}|api[_-]?key[_-]?[a-zA-Z0-9]{16,})',
  // 合法八位组（0-255）+ 上下文排除：
  //   `(?<![vV\d.])` 前面不是 v/V 或数字/点 → 排除 `v1.2.3.4` 版本号，
  //                  以及 `1.2.3.4.5` 这类更长点分串的中段
  //   `(?!\.\d)`     后面不再接 `.数字` → 排除五段以上的版本号
  // 注意：裸写的四段版本号（如 `1.0.0.1`）仍会被当作 IP——它本身就是
  // 合法且在用的公网地址，宁可误伤也不漏报。
  'ip-address':
    '(?<![vV\\d.])(?:(?:25[0-5]|2[0-4]\\d|1\\d{2}|[1-9]?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|1\\d{2}|[1-9]?\\d)(?!\\.?\\d)',
  'mac-address': '(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}',
  passport: '\\b(?:E[0-9A-Z]\\d{7}|G\\d{8})\\b',
  'license-plate':
    '[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤川青藏琼][A-Z][A-HJ-NP-Z0-9]{5}',
}

/**
 * 规则求值顺序。长规则优先（id-card → bank-card → phone），防止短规则
 * 在更长的数字串内部误命中。
 *
 * 注意：顺序生效的前提是 `redactString` / `sanitize` 采用**累进匹配**
 * （每条规则在上一条的产出上继续匹配），否则顺序没有意义。
 */
export const PII_ORDER: PIIName[] = [
  'id-card',
  'bank-card',
  'phone',
  'email',
  'api-key',
  'ip-address',
  'mac-address',
  'passport',
  'license-plate',
]

/** 各 PII 类型的数据分级，与 privacy-policy 的 dataClassifications 对应。 */
export const PII_DATA_CLASS: Record<PIIName, 'confidential' | 'secret'> = {
  'id-card': 'secret',
  'bank-card': 'secret',
  'api-key': 'secret',
  passport: 'secret',
  phone: 'confidential',
  email: 'confidential',
  'ip-address': 'confidential',
  'mac-address': 'confidential',
  'license-plate': 'confidential',
}

/** 不可逆掩码函数（仅用于日志/存储，不参与上云脱敏）。 */
export const PII_MASKS: Record<PIIName, (match: string) => string> = {
  'id-card': (m) => `${m.slice(0, 3)}***********${m.slice(14)}`,
  'bank-card': (m) => `${m.slice(0, 4)}**********${m.slice(-4)}`,
  phone: (m) => `${m.slice(0, 3)}****${m.slice(7)}`,
  email: (m) => {
    const [local, domain] = m.split('@')
    return `${local[0]}***@${domain}`
  },
  'api-key': () => 'sk-***',
  'ip-address': (m) => {
    const parts = m.split('.')
    return `${parts[0]}.${parts[1]}.***.***`
  },
  'mac-address': (m) => {
    const parts = m.split(/[:-]/)
    return `${parts[0]}:${parts[1]}:**:**:**:**`
  },
  passport: (m) => `${m[0]}****${m.slice(-2)}`,
  'license-plate': (m) => `${m[0]}*·*****`,
}

export interface PIIRule {
  name: PIIName
  pattern: RegExp
  mask: (match: string) => string
}

/**
 * 9 种 PII 规则，由 `PII_PATTERNS` + `PII_MASKS` 按 `PII_ORDER` 组装。
 * 与 privacy-policy 的 sanitizationRules 共用同一批 pattern 字面量。
 */
export const PII_RULES: PIIRule[] = PII_ORDER.map((name) => ({
  name,
  pattern: new RegExp(PII_PATTERNS[name], 'g'),
  mask: PII_MASKS[name],
}))

/**
 * 对单个字符串应用所有 PII 规则，返回脱敏后的字符串和脱敏明细。
 *
 * 累进匹配：每条规则在**上一条规则的产出**（`result`）上继续匹配，而不是
 * 回到原始 `text`。否则后序规则会命中前序规则已经掩码掉的区间，导致
 * `result.replace` 静默 no-op、而 `matches` 里却记了一笔不存在的脱敏
 * （2026-08-30 修复）。
 *
 * 同一取值在文本中出现多次时一次性全部替换，且只计一笔，避免计数虚高。
 */
export function redactString(
  text: string,
  rules: PIIRule[] = PII_RULES,
): { redacted: string; matches: Array<{ type: string; masked: string }> } {
  let result = text
  const matches: Array<{ type: string; masked: string }> = []

  for (const rule of rules) {
    // 克隆正则，避免共享实例的 lastIndex 状态在并发调用间串扰
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags)
    const hits = result.match(pattern)
    if (!hits) continue
    // 去重：同一取值只处理一次（split/join 已经全量替换）
    for (const hit of new Set(hits)) {
      let masked: string
      try {
        masked = rule.mask(hit)
      } catch {
        continue // 掩码函数对畸形输入抛错时跳过，绝不让原文漏出
      }
      if (masked === hit) continue
      result = result.split(hit).join(masked)
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
