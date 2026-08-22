/**
 * pii-utils tests — PII detection and redaction utility
 */
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { redactString, redactObject, PII_RULES } from '../../src/dsh-adapter/pii-utils.js'

describe('pii-utils', () => {
  describe('PII_RULES', () => {
    it('defines 5 rules', () => {
      assert.equal(PII_RULES.length, 5)
      const names = PII_RULES.map((r) => r.name).sort()
      assert.deepEqual(names, ['api-key', 'bank-card', 'email', 'id-card', 'phone'])
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
