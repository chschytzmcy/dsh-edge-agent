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
  | 'ip-address' | 'mac-address' | 'passport' | 'license-plate' | 'credential'

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
  // §7.106 (2026-10-23) credential：标签式凭据（密码/口令/password/token/secret
  // + 分隔符 + 值）。LOCAL 轮放行明文口令操作（设备登录，操作者裁决）后，这些
  // 值会沉淀进会话历史——后续 CLOUD 轮整段历史回显出网，必须由可逆脱敏兜住。
  // 值段排除空白与常见收尾符，长度 3-64；宁可多掩不可漏放。
  'credential':
    '(?:密码|口令|passwd|password|pwd|secret|access[ _-]?token|token|api[ _-]?key)["\' 　]{0,2}(?:[:：=]|是|为|\\s+is\\s+)["\' 　]?[^\\s"\'，,;；<>（）()]{3,64}',
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
  'credential',
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
  'credential': 'secret',
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
  // 掩码保留标签只糊值段：日志能看出"这里有个凭据"，看不出凭据本身。
  'credential': (m) => {
    const i = m.search(/[:：=是为]/u)
    return i > 0 ? `${m.slice(0, i)}***` : '***'
  },
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
 * 10 种 PII 规则，由 `PII_PATTERNS` + `PII_MASKS` 按 `PII_ORDER` 组装。
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

/**
 * §7.87.13 (2026-09-20) PII 预检测前的文本规范化。
 *
 * PII 正则（`\b1[3-9]\d{9}\b` / `\d{17}[\dXx]` 等）都是**字面量字符匹配**，
 * 对以下两种用户写法直接漏抓：
 *
 *   - **空格分隔**: `我的手机号是 1 3 8 0 0 1 3 8 0 0 0`
 *     → phone regex 11 位数字必须连续,空格断开会漏。
 *   - **中文数字编码**: `身份证号 一一零一零一一九九零零三零七八八一一`
 *     → id-card regex 匹配 `\d{17}` 不抓 `一`,完全漏。
 *
 * 实测（§7.87.12 4 模型 trace）:4 个本地 LLM 在这两个 case 上的失败率
 * 100%(27B / 4B / 9B 都漏),**唯一防线**是 sanitizer 预处理。本函数
 * 是这条防线的核心。
 *
 * ## 字符级 1:1 映射
 *
 * 返回 `charMap[i] = text 中第 i 个规范化字符对应的源位置`,配合 sanitizer
 * 把 regex 在 normalized 上的命中区间 `[start, end)` 反查到原始文本上:
 *
 *   ```
 *   text     = "手机号 1 3 8 0 0 1 3 8 0 0 0"
 *   normalized = "手机号13800138000"   ← 仅 drop digit 之间的 10 个空格
 *   charMap  = [0,1,2, 3, 6,8,10,12,14,16,18,20,22,24]
 *
 *   regex 在 normalized 上命中 "13800138000" → [4, 15)
 *   charMap[4]=6, charMap[14]=24 → text.slice(6, 25) = "1 3 8 0 0 1 3 8 0 0 0"
 *   ```
 *
 * `byOriginal` 用"用户原始字符串"做 key,desanitize 后能精确还原用户
 * 输入的字面形式(带空格 / 中文数字),而不是规范化后的形式。
 *
 * ## 字符级规范化规则
 *
 *   - **空白字符**(`,` `\s`):**仅当两侧相邻字符都是 ASCII digit 时丢弃** —
 *     不能简单全 drop:否则 `IP 10.0.0.1` → `IP10.0.0.1`,IP regex 的 `\b`
 *     在 'P' 与 '1' 之间无 word boundary,漏检。同理 email regex 在
 *     `a @ b . com` 间没有 space 时也能匹配,但保留 space 不破坏既有
 *     检测。**安全**:即使过度保留 space,正则仍按设计工作,最多漏掉
 *     "digit 间空格"的规范化收益。
 *   - **中文数字 → 阿拉伯数字**:1:1 映射,包括:
 *     - 大写(财务/合同):壹贰叁肆伍陆柒捌玖
 *     - 〇 (圆圈 0):见 ○ 形式零
 *     - 两 (口语化 2):常见于电话/身份证
 *   - **其他字符**:原样保留
 *
 * ## 已知限制(可接受)
 *
 *   - **位值中文数字**(`百`/`千`/`万`/`亿`)不被处理 — 需要完整数字
 *     parsing,而我们的 fixture 都是单字数字("一一零...")。如果未来
 *     fixture 出现"一百三十八",需要扩展 parseIntChinese 之类。
 *   - **规范化是纯字符串变换**,不引入语义理解。"我买了一个东西"
 *     不会因"一"被改而漏报 — 因为规范化后"我买了1个东西"仍不含
 *     11/17-18 位连续数字,regex 不会误报。保守 over-mask 是安全的。
 */
const CN_DIGIT_MAP: Record<string, string> = {
  零: '0', 〇: '0',
  一: '1', 壹: '1',
  二: '2', 贰: '2', 两: '2',
  三: '3', 叁: '3',
  四: '4', 肆: '4',
  五: '5', 伍: '5',
  六: '6', 陆: '6',
  七: '7', 柒: '7',
  八: '8', 捌: '8',
  九: '9', 玖: '9',
}

export function normalizeForPII(text: string): {
  normalized: string
  /** `charMap[i]` = 规范化后第 i 个字符在原文本 `text` 中的源位置。
   *  严格单调递增(规范化要么 1:0 删,要么 1:1 改,从不插入字符)。
   *  长度 = normalized.length。 */
  charMap: number[]
  /** 规范化是否实际改变了文本(便于审计/forensics)。 */
  changed: boolean
} {
  // 第一遍:把 CN 数字转成 ASCII 数字(`converted` 数组存"该位置的字符
  // 转换后形态"),后续的空格判断用 `converted` 而不是原始 `text` —
  // 否则空格两侧是"非 ASCII digit 但 CN digit"的话判断会错。
  const converted: string[] = new Array(text.length)
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const mapped = CN_DIGIT_MAP[ch]
    converted[i] = mapped !== undefined ? mapped : ch
  }

  // 第二遍:遍历 converted,对空白决定是丢弃还是保留
  let normalized = ''
  const charMap: number[] = []
  let changed = false

  for (let i = 0; i < converted.length; i++) {
    const ch = converted[i]

    if (/\s/u.test(ch)) {
      // 仅当两侧相邻(在 converted 数组里)非空白字符都是 ASCII digit 时丢弃
      let prevIsDigit = false
      for (let j = i - 1; j >= 0; j--) {
        if (!/\s/u.test(converted[j])) {
          prevIsDigit = /\d/u.test(converted[j])
          break
        }
      }
      let nextIsDigit = false
      for (let j = i + 1; j < converted.length; j++) {
        if (!/\s/u.test(converted[j])) {
          nextIsDigit = /\d/u.test(converted[j])
          break
        }
      }
      if (prevIsDigit && nextIsDigit) {
        // digit 之间的空白,丢掉以让 PII 正则能连续匹配
        changed = true
        continue
      }
      // 非 digit 之间的空白 → 保留(保护 IP/email 的 word boundary)
    } else if (CN_DIGIT_MAP[text[i]] !== undefined) {
      // CN → ASCII 转换
      changed = true
    }

    normalized += ch
    charMap.push(i)
  }

  return { normalized, charMap, changed }
}

/**
 * 把 `normalizeForPII()` 返回的 charMap + normalized 上的命中区间
 * `[start, end)` 翻回 `text` 上的对应区间。
 *
 * 用法:`sliceOriginal(text, charMap, start, end)` → 用户原始子串
 * (含被丢弃的空白、被转换的中文数字)。
 *
 * 注意:返回字符串的字符数可能 > (end - start),因为 whitespace
 * 不在 charMap 里但仍在原文本里。
 */
export function sliceOriginal(
  text: string,
  charMap: number[],
  start: number,
  end: number,
): string {
  if (start < 0 || end > charMap.length || start >= end) {
    throw new Error(
      `sliceOriginal: invalid range [${start}, ${end}) for charMap.length=${charMap.length}`,
    )
  }
  const fromIdx = charMap[start]
  const toIdx = charMap[end - 1] + 1
  return text.slice(fromIdx, toIdx)
}

/**
 * §7.106 (2026-10-23): does the text carry a labeled credential
 * (`密码：X`, `token = X`, …)? input-guard's sticky-LOCAL rule uses it: a
 * credential handoff continues a device-operation context locally — the
 * cloud route is a functional dead end there (the model could only ever
 * echo the placeholder back). Non-global RegExp ⇒ stateless `.test`.
 */
const CREDENTIAL_PROBE = new RegExp(PII_PATTERNS.credential, 'iu')
export function containsCredential(text: string): boolean {
  return CREDENTIAL_PROBE.test(text)
}
