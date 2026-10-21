/**
 * pii-utils tests — PII detection and redaction utility
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, it } from 'vitest'
import {
  redactString,
  redactObject,
  normalizeForPII,
  sliceOriginal,
  PII_RULES,
  PII_PATTERNS,
} from '../../src/dsh-adapter/pii-utils.js'

describe('pii-utils', () => {
  describe('PII_RULES', () => {
    it('defines 9 rules (5 core + 4 extended, aligned with privacy-policy.json)', () => {
      assert.equal(PII_RULES.length, 9)
      const names = PII_RULES.map((r) => r.name).sort()
      assert.deepEqual(names, [
        'api-key', 'bank-card', 'email', 'id-card',
        'ip-address', 'license-plate', 'mac-address', 'passport', 'phone',
      ])
    })
  })

  describe('redactString', () => {
    it('redacts phone number', () => {
      const { redacted, matches } = redactString('我的手机号13812345678请查收')
      assert.ok(redacted.includes('138****5678'))
      assert.ok(!redacted.includes('13812345678'))
      assert.equal(matches.length, 1)
      assert.equal(matches[0].type, 'phone')
    })

    it('redacts email', () => {
      const { redacted, matches } = redactString('邮箱test@gmail.com')
      assert.ok(redacted.includes('t***@gmail.com'))
      assert.ok(!redacted.includes('test@gmail.com'))
      assert.equal(matches[0].type, 'email')
    })

    it('redacts api key', () => {
      const { redacted, matches } = redactString('key=sk-abcdefghijklmnopqrstuvwxyz')
      assert.ok(redacted.includes('sk-***'))
      assert.equal(matches[0].type, 'api-key')
    })

    // Extended rules (2026-08-26): synced with privacy-policy.json 9 sanitizationRules
    it('redacts ip-address', () => {
      const { redacted, matches } = redactString('服务器 192.168.1.100 怎么访问')
      assert.ok(!redacted.includes('192.168.1.100'), `redacted=${redacted}`)
      assert.ok(/\d+\.\d+\.\*\*\*\.\*\*\*/.test(redacted), `expected masked form, got: ${redacted}`)
      assert.equal(matches[0].type, 'ip-address')
    })

    it('redacts mac-address', () => {
      const { redacted, matches } = redactString('设备 00:1A:2B:3C:4D:5E 配置网络')
      assert.ok(!redacted.includes('00:1A:2B:3C:4D:5E'), `redacted=${redacted}`)
      assert.equal(matches[0].type, 'mac-address')
    })

    it('redacts passport', () => {
      const { redacted, matches } = redactString('护照 E12345678 办理签证')
      assert.ok(!redacted.includes('E12345678'), `redacted=${redacted}`)
      assert.equal(matches[0].type, 'passport')
    })

    it('redacts license-plate', () => {
      const { redacted, matches } = redactString('车牌 京A12345 违章查询')
      assert.ok(!redacted.includes('京A12345'), `redacted=${redacted}`)
      assert.equal(matches[0].type, 'license-plate')
    })

    it('redacts multiple PII types', () => {
      const { redacted, matches } = redactString('手机13812345678邮箱a@b.com')
      assert.ok(redacted.includes('138****5678'))
      assert.ok(redacted.includes('a***@b.com'))
      assert.equal(matches.length, 2)
    })

    it('returns original string if no PII', () => {
      const input = '普通文本没有敏感信息'
      const { redacted, matches } = redactString(input)
      assert.equal(redacted, input)
      assert.equal(matches.length, 0)
    })

    it('handles empty string', () => {
      const { redacted, matches } = redactString('')
      assert.equal(redacted, '')
      assert.equal(matches.length, 0)
    })

    it('accepts custom rules', () => {
      const customRules = [
        { name: 'phone' as const, pattern: /\d{11}/g, mask: (m: string) => m.slice(0, 3) + '***' },
      ]
      const { redacted, matches } = redactString('号码13812345678', customRules)
      assert.ok(redacted.includes('138***'))
      assert.equal(matches.length, 1)
    })
  })

  describe('redactObject', () => {
    it('redacts string values in an object', () => {
      const input = { phone: '13812345678', name: '张三' }
      const { redacted, count } = redactObject(input)
      assert.ok((redacted as any).phone.includes('138****5678'))
      assert.equal((redacted as any).name, '张三')
      assert.equal(count, 1)
    })

    it('redacts deeply nested strings', () => {
      const input = { user: { contact: { email: 'test@example.com' } } }
      const { redacted, count } = redactObject(input)
      assert.ok((redacted as any).user.contact.email.includes('t***@example.com'))
      assert.equal(count, 1)
    })

    it('redacts strings in arrays', () => {
      const input = { phones: ['13812345678', '13900001111'] }
      const { redacted, count } = redactObject(input)
      assert.ok((redacted as any).phones[0].includes('138****5678'))
      assert.ok((redacted as any).phones[1].includes('139****1111'))
      assert.equal(count, 2)
    })

    it('preserves non-string values', () => {
      const input = { count: 42, active: true, data: null }
      const { redacted, count } = redactObject(input)
      assert.deepEqual(redacted, input)
      assert.equal(count, 0)
    })

    it('does not mutate original object', () => {
      const input = { phone: '13812345678' }
      const original = JSON.stringify(input)
      redactObject(input)
      assert.equal(JSON.stringify(input), original)
    })

    it('handles empty object', () => {
      const { redacted, count } = redactObject({})
      assert.deepEqual(redacted, {})
      assert.equal(count, 0)
    })

    it('handles audit entry shape', () => {
      const entry = {
        ts: 1234567890,
        level: 'info',
        kind: 'http.chat.start',
        source: 'http-api',
        payload: {
          sessionId: 'sess-1',
          messagePreview: '手机号13812345678',
        },
      }
      const { redacted, count } = redactObject(entry)
      const redactedPayload = (redacted as any).payload
      assert.ok(redactedPayload.messagePreview.includes('138****5678'))
      assert.equal(count, 1)
    })
  })
})

/**
 * 2026-08-30 修复回归。
 */
describe('pii-utils 单一事实源', () => {
  it('每条 PII_RULES 的 pattern 都来自 PII_PATTERNS', () => {
    for (const rule of PII_RULES) {
      assert.equal(
        rule.pattern.source,
        new RegExp(PII_PATTERNS[rule.name]).source,
        `${rule.name} 的正则必须复用 PII_PATTERNS，禁止另写字面量`,
      )
    }
  })

  it('shipped privacy-policy.json 的 pattern 与 PII_PATTERNS 完全一致', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const { dirname, join, resolve } = await import('node:path')
    // 2026-09-21 (§7.87.13.3): config/privacy-policy.json is the shipped
    // prod config (was tests/fixtures/privacy-policy.json before the
    // rename; even earlier was profiles/dsh-edge-agent/ overlay before
    // the §7.31 bundle-refactor).
    const fixturePath = resolve(dirname(fileURLToPath(import.meta.url)), '../../config/privacy-policy.json')
    // pathToFileURL: on Windows an absolute path is `C:\...`, which is not a
    // valid URL — `new URL(path, base)` throws "The URL must be of scheme
    // file". This test only ever ran on POSIX; §7.102 surfaced it on
    // Windows.
    const url = pathToFileURL(fixturePath)
    const policy = JSON.parse(readFileSync(url, 'utf-8'))
    for (const rule of policy.sanitizationRules) {
      assert.equal(
        rule.pattern,
        PII_PATTERNS[rule.piiType as keyof typeof PII_PATTERNS],
        `privacy-policy.json 的 ${rule.piiType} 与 pii-utils 脱钩了`,
      )
    }
    assert.equal(policy.sanitizationRules.length, PII_RULES.length)
  })

  it('DEFAULT_POLICY 的 pattern 与 PII_PATTERNS 完全一致', async () => {
    const { PrivacyPolicyServiceImpl } = await import(
      '../../src/dsh-adapter/privacy-policy.js'
    )
    const svc = new PrivacyPolicyServiceImpl(
      { reflect: { provide: () => () => {} }, provide: () => () => {} } as never,
      { policyPath: '/nonexistent/policy.json', hotReload: false, watchIntervalMs: 5000 },
      { log: async () => {} },
    )
    await svc.reload() // 文件不存在 → 回落 DEFAULT_POLICY
    for (const rule of svc.getSanitizationRules()) {
      assert.equal(
        rule.pattern,
        PII_PATTERNS[rule.piiType as keyof typeof PII_PATTERNS],
      )
    }
  })
})

describe('redactString 累进匹配', () => {
  it('身份证被掩码后不会被 bank-card 规则重复计一笔', () => {
    // 旧实现始终在原文上匹配、在结果上替换：bank-card 在原文里命中这串
    // 18 位身份证 → result.replace 找不到 → 静默 no-op，但 matches 里
    // 却记了一笔根本没发生的 bank-card 脱敏。
    const { redacted, matches } = redactString('身份证 110101199003078815')
    assert.ok(!redacted.includes('110101199003078815'))
    assert.deepEqual(matches.map((m) => m.type), ['id-card'])
  })

  it('同一取值出现多次时全部替换且只计一笔', () => {
    const { redacted, matches } = redactString('13812345678 和 13812345678')
    assert.ok(!redacted.includes('13812345678'))
    assert.equal(matches.length, 1)
    assert.equal(redacted, '138****5678 和 138****5678')
  })

  it('多种 PII 混排时各自只计一笔', () => {
    const { matches } = redactString('13812345678 / a@b.com / 13812345678')
    assert.deepEqual(matches.map((m) => m.type).sort(), ['email', 'phone'])
  })
})

describe('ip-address 误伤收敛', () => {
  it('不把带 v 前缀的四段版本号当成 IP', () => {
    const { redacted, matches } = redactString('升级到 v1.0.0.1 版本')
    assert.equal(redacted, '升级到 v1.0.0.1 版本')
    assert.equal(matches.length, 0)
  })

  it('不匹配五段以上的点分数字', () => {
    const { matches } = redactString('序号 1.2.3.4.5')
    assert.equal(matches.filter((m) => m.type === 'ip-address').length, 0)
  })

  it('不匹配非法八位组', () => {
    const { matches } = redactString('值域 999.999.999.999')
    assert.equal(matches.filter((m) => m.type === 'ip-address').length, 0)
  })

  it('仍然识别真实内网 / 公网 IP', () => {
    for (const ip of ['192.168.1.100', '10.0.0.254', '8.8.8.8', '172.16.31.7']) {
      const { redacted, matches } = redactString(`访问 ${ip}`)
      assert.ok(
        matches.some((m) => m.type === 'ip-address'),
        `${ip} 应被识别为 IP`,
      )
      assert.ok(!redacted.includes(ip))
    }
  })
})

// ─── §7.87.13 (2026-09-20) PII 预检测前的文本规范化 ──────────────────────
//
// 背景:production 风险观测(§7.87.12 4 模型 trace)
//   - 空格分隔 phone "1 3 8 0 0 1 3 8 0 0 0" → phone regex `\b1[3-9]\d{9}\b` 漏
//   - 中文数字 id_card "一一零一零一一九九零零三零七八八一一" → id_card regex
//     `\d{17}[\dXx]` 完全漏
//   - 4 个本地 LLM 在这两个 case 上 100% 失败 → 唯一防线 = sanitizer 预处理
//
// 本组测试覆盖 normalizeForPII / sliceOriginal 的核心行为契约,
// 不重在 PII regex 命中(那是 sanitizer-pipeline.test.ts 的事)。
describe('normalizeForPII (§7.87.13)', () => {
  it('drops whitespace and tracks charMap monotonically', () => {
    const text = '1 3 8 0 0 1 3 8 0 0 0'
    const { normalized, charMap, changed } = normalizeForPII(text)
    assert.equal(normalized, '13800138000')
    // 11 digits → 11 charMap entries(每 2 步 1 个 digit,因为 digit 之间 1 个空格)
    assert.deepEqual(charMap, [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20])
    assert.equal(charMap.length, normalized.length)
    assert.equal(changed, true)
    // charMap 严格单调递增
    for (let i = 1; i < charMap.length; i++) {
      assert.ok(charMap[i] > charMap[i - 1], `charMap[${i}]=${charMap[i]} not > ${charMap[i - 1]}`)
    }
  })

  it('converts Chinese digits to Arabic (1-to-1 char mapping)', () => {
    const text = '一一零一零一一九九零零三零七八八一一'
    const { normalized, charMap, changed } = normalizeForPII(text)
    assert.equal(normalized, '110101199003078811')
    assert.equal(charMap.length, 18)
    assert.equal(changed, true)
    // charMap 严格单调递增,且每字符宽度 1
    for (let i = 1; i < charMap.length; i++) {
      assert.equal(charMap[i] - charMap[i - 1], 1)
    }
  })

  it('handles 大写财务数字 + 〇 + 两', () => {
    const text = '壹贰叁肆伍陆柒捌玖〇两'
    const { normalized } = normalizeForPII(text)
    assert.equal(normalized, '12345678902')
  })

  it('returns text unchanged when no whitespace / Chinese digits', () => {
    const text = 'hello world 12345'
    // 注意:world 跟 12345 之间有空格,会触发 changed=true。
    // 这里测的是"无空格也无中文数字"的纯情形。
    const text2 = 'hello12345'
    const { normalized, charMap, changed } = normalizeForPII(text2)
    assert.equal(normalized, text2)
    assert.equal(charMap.length, text2.length)
    assert.equal(changed, false)
  })

  it('keeps ASCII digits untouched', () => {
    const text = 'phone 13800138000'
    const { normalized } = normalizeForPII(text)
    assert.equal(normalized, 'phone 13800138000')
  })

  it('mixed: prefix + spaced phone', () => {
    const text = '我的手机号 1 3 8 0 0 1 3 8 0 0 0'
    const { normalized, charMap } = normalizeForPII(text)
    // "我的手机号" 跟 "1" 之间的 space 不是 digit 两侧,保留(保护 word boundary)
    assert.equal(normalized, '我的手机号 13800138000')
    assert.equal(charMap.length, normalized.length)
    // phone 在 normalized 中是 [6, 17)(跳过 normalized[5] 的 space)
    const phoneOriginal = sliceOriginal(text, charMap, 6, 17)
    assert.equal(phoneOriginal, '1 3 8 0 0 1 3 8 0 0 0')
  })

  it('mixed: prefix + Chinese-digit id_card', () => {
    const text = '身份证号 一一零一零一一九九零零三零七八八一一'
    const { normalized, charMap } = normalizeForPII(text)
    // "身份证号" 跟 "一" 之间的 space 不是 digit 两侧,保留
    assert.equal(normalized, '身份证号 110101199003078811')
    // id_card 在 normalized 中是 [5, 23)(跳过 normalized[4] 的 space)
    const idOriginal = sliceOriginal(text, charMap, 5, 23)
    assert.equal(idOriginal, '一一零一零一一九九零零三零七八八一一')
  })
})

describe('sliceOriginal (§7.87.13)', () => {
  it('throws on out-of-range indices', () => {
    const text = 'abc def'
    const { charMap } = normalizeForPII(text)
    assert.throws(() => sliceOriginal(text, charMap, -1, 2))
    assert.throws(() => sliceOriginal(text, charMap, 0, charMap.length + 1))
    assert.throws(() => sliceOriginal(text, charMap, 5, 5))
    assert.throws(() => sliceOriginal(text, charMap, 6, 5))
  })

  it('round-trips: normalizeForPII + sliceOriginal recovers original substring', () => {
    const cases = [
      'phone 1 3 8 0 0 1 3 8 0 0 0',
      'id 一一零一零一一九九零零三零七八八一一',
      'mixed 1 3 8 0 0 1 3 8 0 0 0 + 一一零一一',
    ]
    for (const text of cases) {
      const { normalized, charMap } = normalizeForPII(text)
      // 整段反查必须等于原文
      const recovered = sliceOriginal(text, charMap, 0, charMap.length)
      assert.equal(recovered, text, `round-trip failed for: ${text}`)
      // normalized 长度 = charMap 长度
      assert.equal(normalized.length, charMap.length)
    }
  })
})
