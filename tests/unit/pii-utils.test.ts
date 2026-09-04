/**
 * pii-utils tests — PII detection and redaction utility
 */
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { redactString, redactObject, PII_RULES, PII_PATTERNS } from '../../src/dsh-adapter/pii-utils.js'

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
    // 2026-09-03 (§7.31): bundle is a pure plugin in web profile; tests
    // load privacy-policy.json from tests/fixtures/ (was profiles/dsh-edge-agent/
    // overlay before the refactor).
    const fixturePath = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/privacy-policy.json')
    const url = new URL(fixturePath, import.meta.url)
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
