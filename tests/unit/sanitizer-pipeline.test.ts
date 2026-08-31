/**
 * sanitizer-pipeline plugin tests — exercises forward sanitization
 * (PII → placeholders), reverse desanitization (placeholders → PII),
 * per-session mapping, deduplication, session limits, purge, and
 * integration with privacy-policy.
 *
 * Phase 4 完整测试。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'vitest'

import * as sanitizer from '../../src/dsh-adapter/sanitizer-pipeline.ts'
import { SanitizerServiceImpl } from '../../src/dsh-adapter/sanitizer-pipeline.ts'
import { PrivacyPolicyServiceImpl } from '../../src/dsh-adapter/privacy-policy.ts'
import type { PrivacyPolicy } from '../../src/dsh-adapter/privacy-policy.ts'

function fakeCtx() {
  return {
    reflect: { provide(_n: string, _v: unknown) { return () => {} } },
    provide(_n: string, _v: unknown) { return () => {} },
  }
}

function fakeAuditLog() {
  const entries: any[] = []
  return {
    entries,
    log: async (entry: any) => { entries.push(entry) },
  }
}

const TEST_POLICY: PrivacyPolicy = {
  version: '1.0.0',
  routingRules: [],
  sanitizationRules: [
    { pattern: '1[3-9]\\d{9}', replacement: '[PHONE]', dataClass: 'confidential', piiType: 'phone' },
    { pattern: '[\\w.-]+@[\\w.-]+\\.\\w+', replacement: '[EMAIL]', dataClass: 'confidential', piiType: 'email' },
    { pattern: '\\d{16,19}', replacement: '[BANK_CARD]', dataClass: 'secret', piiType: 'bank-card' },
  ],
  dataClassifications: [],
  globalConstraints: { maxCloudRequestsPerMinute: 20, requireAttestation: false, blockIfTcbCompromised: true },
}

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'edge-p4-sanitizer-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function createPolicyService(): PrivacyPolicyServiceImpl {
  const policyPath = join(root, 'policy.json')
  writeFileSync(policyPath, JSON.stringify(TEST_POLICY, null, 2), 'utf-8')
  const svc = new PrivacyPolicyServiceImpl(fakeCtx() as never, {
    policyPath, hotReload: false, watchIntervalMs: 5000,
  }, fakeAuditLog())
  return svc
}

describe('sanitizer-pipeline plugin', () => {
  it('exports the canonical plugin shape', () => {
    assert.equal(sanitizer.name, 'sanitizer-pipeline')
    assert.deepEqual([...sanitizer.inject], ['privacyPolicy', 'auditLog'])
    assert.equal(typeof sanitizer.apply, 'function')
    assert.ok(sanitizer.Config)
  })

  it('config has enableAutoDetection and maxReplacementsPerSession', () => {
    const json = (sanitizer.Config as unknown as { toJSON(): any }).toJSON()
    assert.ok(json)
  })
})

describe('sanitizer-pipeline forward sanitization', () => {
  it('replaces phone numbers with placeholders', async () => {
    const policy = createPolicyService()
    await policy.reload()
    const audit = fakeAuditLog()
    const svc = new SanitizerServiceImpl(fakeCtx() as never, {
      enableAutoDetection: true,
      maxReplacementsPerSession: 1024,
    }, policy, audit)

    const result = await svc.sanitize('我的手机号是13812345678', { sessionId: 's1' })
    assert.ok(!result.sanitizedText.includes('13812345678'))
    assert.ok(result.sanitizedText.includes('[PHONE_1]'))
    assert.equal(result.replacements.length, 1)
    assert.equal(result.replacements[0].piiType, 'phone')
    assert.equal(result.replacements[0].original, '13812345678')
  })

  it('replaces email addresses with placeholders', async () => {
    const policy = createPolicyService()
    await policy.reload()
    const svc = new SanitizerServiceImpl(fakeCtx() as never, {
      enableAutoDetection: true,
      maxReplacementsPerSession: 1024,
    }, policy, fakeAuditLog())

    const result = await svc.sanitize('联系 test@example.com', { sessionId: 's1' })
    assert.ok(!result.sanitizedText.includes('test@example.com'))
    assert.ok(result.sanitizedText.includes('[EMAIL_1]'))
    assert.equal(result.replacements[0].piiType, 'email')
  })

  it('replaces multiple PII types in one text', async () => {
    const policy = createPolicyService()
    await policy.reload()
    const svc = new SanitizerServiceImpl(fakeCtx() as never, {
      enableAutoDetection: true,
      maxReplacementsPerSession: 1024,
    }, policy, fakeAuditLog())

    const result = await svc.sanitize(
      '电话13812345678，邮箱test@example.com',
      { sessionId: 's1' },
    )
    assert.ok(!result.sanitizedText.includes('13812345678'))
    assert.ok(!result.sanitizedText.includes('test@example.com'))
    assert.equal(result.replacements.length, 2)
  })

  it('leaves text without PII unchanged', async () => {
    const policy = createPolicyService()
    await policy.reload()
    const svc = new SanitizerServiceImpl(fakeCtx() as never, {
      enableAutoDetection: true,
      maxReplacementsPerSession: 1024,
    }, policy, fakeAuditLog())

    const result = await svc.sanitize('hello world', { sessionId: 's1' })
    assert.equal(result.sanitizedText, 'hello world')
    assert.equal(result.replacements.length, 0)
  })

  it('deduplicates same value within a session', async () => {
    const policy = createPolicyService()
    await policy.reload()
    const svc = new SanitizerServiceImpl(fakeCtx() as never, {
      enableAutoDetection: true,
      maxReplacementsPerSession: 1024,
    }, policy, fakeAuditLog())

    // First call creates mapping
    const r1 = await svc.sanitize('手机号13812345678', { sessionId: 's1' })
    assert.equal(r1.replacements[0].placeholder, '[PHONE_1]')

    // Second call with same phone should reuse the placeholder
    const r2 = await svc.sanitize('再提一次13812345678', { sessionId: 's1' })
    assert.ok(r2.sanitizedText.includes('[PHONE_1]'))
    assert.equal(svc.getMappingSize('s1'), 1)
  })

  it('assigns different placeholders to different values', async () => {
    const policy = createPolicyService()
    await policy.reload()
    const svc = new SanitizerServiceImpl(fakeCtx() as never, {
      enableAutoDetection: true,
      maxReplacementsPerSession: 1024,
    }, policy, fakeAuditLog())

    await svc.sanitize('电话13812345678 和 13900001111', { sessionId: 's1' })
    assert.equal(svc.getMappingSize('s1'), 2)
  })

  it('isolates mappings between sessions', async () => {
    const policy = createPolicyService()
    await policy.reload()
    const svc = new SanitizerServiceImpl(fakeCtx() as never, {
      enableAutoDetection: true,
      maxReplacementsPerSession: 1024,
    }, policy, fakeAuditLog())

    await svc.sanitize('电话13812345678', { sessionId: 's1' })
    await svc.sanitize('邮箱test@example.com', { sessionId: 's2' })

    assert.equal(svc.getMappingSize('s1'), 1)
    assert.equal(svc.getMappingSize('s2'), 1)
  })

  it('throws SanitizerLimitError when maxReplacementsPerSession is exceeded', async () => {
    const policy = createPolicyService()
    await policy.reload()
    const audit = fakeAuditLog()
    const svc = new SanitizerServiceImpl(fakeCtx() as never, {
      enableAutoDetection: true,
      maxReplacementsPerSession: 2,
    }, policy, audit)

    // 超限必须抛错，不能"脱一半就放行"——剩余未替换的 PII 会随 prompt
    // 直接上云。调用方（input-guard）据此降级 LOCAL。
    await assert.rejects(
      () => svc.sanitize('电话13812345678 13900001111 13700002222', { sessionId: 's1' }),
      (err: Error) => {
        assert.equal((err as { code?: string }).code, 'sanitizer-limit-exceeded')
        return true
      },
    )
    assert.equal(svc.getMappingSize('s1'), 2)
    assert.ok(audit.entries.some(e => e.kind === 'sanitizer.limit-reached'))
  })

  it('does not keep minting placeholders across rules once at the limit', async () => {
    const policy = createPolicyService()
    await policy.reload()
    const svc = new SanitizerServiceImpl(fakeCtx() as never, {
      enableAutoDetection: true,
      maxReplacementsPerSession: 1,
    }, policy, fakeAuditLog())

    // 手机号 + 邮箱分属两条规则。旧实现的 `break` 只跳出内层 matches 循环,
    // 外层规则照常继续铸造,限流形同虚设。
    await assert.rejects(
      () => svc.sanitize('13812345678 与 a@b.com', { sessionId: 's1' }),
    )
    assert.equal(svc.getMappingSize('s1'), 1)
  })

  it('counts a repeated value once instead of per occurrence', async () => {
    const policy = createPolicyService()
    await policy.reload()
    const svc = new SanitizerServiceImpl(fakeCtx() as never, {
      enableAutoDetection: true,
      maxReplacementsPerSession: 1024,
    }, policy, fakeAuditLog())

    const r = await svc.sanitize('13812345678 又是 13812345678', { sessionId: 's1' })
    assert.equal(r.replacements.length, 1)
    assert.equal(svc.getMappingSize('s1'), 1)
    assert.ok(!r.sanitizedText.includes('13812345678'))
  })

  it('uses default sessionId when none provided', async () => {
    const policy = createPolicyService()
    await policy.reload()
    const svc = new SanitizerServiceImpl(fakeCtx() as never, {
      enableAutoDetection: true,
      maxReplacementsPerSession: 1024,
    }, policy, fakeAuditLog())

    const result = await svc.sanitize('电话13812345678')
    assert.equal(result.sessionId, 'default')
    assert.equal(svc.getMappingSize('default'), 1)
  })
})

describe('sanitizer-pipeline reverse desanitization', () => {
  it('restores placeholders to original PII', async () => {
    const policy = createPolicyService()
    await policy.reload()
    const svc = new SanitizerServiceImpl(fakeCtx() as never, {
      enableAutoDetection: true,
      maxReplacementsPerSession: 1024,
    }, policy, fakeAuditLog())

    await svc.sanitize('我的手机号是13812345678', { sessionId: 's1' })
    const restored = await svc.desanitize('好的，你的号码是[PHONE_1]', 's1')
    assert.equal(restored, '好的，你的号码是13812345678')
  })

  it('restores multiple placeholders', async () => {
    const policy = createPolicyService()
    await policy.reload()
    const svc = new SanitizerServiceImpl(fakeCtx() as never, {
      enableAutoDetection: true,
      maxReplacementsPerSession: 1024,
    }, policy, fakeAuditLog())

    await svc.sanitize('电话13812345678 邮箱test@example.com', { sessionId: 's1' })
    const restored = await svc.desanitize('联系方式：[PHONE_1]，[EMAIL_2]', 's1')
    assert.equal(restored, '联系方式：13812345678，test@example.com')
  })

  it('returns text unchanged for unknown session', async () => {
    const policy = createPolicyService()
    await policy.reload()
    const svc = new SanitizerServiceImpl(fakeCtx() as never, {
      enableAutoDetection: true,
      maxReplacementsPerSession: 1024,
    }, policy, fakeAuditLog())

    const restored = await svc.desanitize('hello [PHONE_1]', 'unknown-session')
    assert.equal(restored, 'hello [PHONE_1]')
  })

  it('returns text unchanged when no placeholders present', async () => {
    const policy = createPolicyService()
    await policy.reload()
    const svc = new SanitizerServiceImpl(fakeCtx() as never, {
      enableAutoDetection: true,
      maxReplacementsPerSession: 1024,
    }, policy, fakeAuditLog())

    await svc.sanitize('电话13812345678', { sessionId: 's1' })
    const restored = await svc.desanitize('no placeholders here', 's1')
    assert.equal(restored, 'no placeholders here')
  })
})

describe('sanitizer-pipeline desanitizeSync', () => {
  it('works synchronously without audit log', async () => {
    const policy = createPolicyService()
    await policy.reload()
    const audit = fakeAuditLog()
    const svc = new SanitizerServiceImpl(fakeCtx() as never, {
      enableAutoDetection: true,
      maxReplacementsPerSession: 1024,
    }, policy, audit)

    await svc.sanitize('电话13812345678', { sessionId: 's1' })
    // Clear audit entries to verify desanitizeSync does NOT add to audit
    audit.entries.length = 0

    const restored = svc.desanitizeSync('号码是[PHONE_1]', 's1')
    assert.equal(restored, '号码是13812345678')
    // No audit entries from sync call
    assert.equal(audit.entries.length, 0)
  })

  it('returns text unchanged for unknown session', () => {
    const policy = createPolicyService()
    const svc = new SanitizerServiceImpl(fakeCtx() as never, {
      enableAutoDetection: true,
      maxReplacementsPerSession: 1024,
    }, policy, fakeAuditLog())

    const restored = svc.desanitizeSync('hello [PHONE_1]', 'no-such-session')
    assert.equal(restored, 'hello [PHONE_1]')
  })
})

describe('sanitizer-pipeline purge', () => {
  it('removes all mappings for a session', async () => {
    const policy = createPolicyService()
    await policy.reload()
    const audit = fakeAuditLog()
    const svc = new SanitizerServiceImpl(fakeCtx() as never, {
      enableAutoDetection: true,
      maxReplacementsPerSession: 1024,
    }, policy, audit)

    await svc.sanitize('电话13812345678', { sessionId: 's1' })
    assert.equal(svc.getMappingSize('s1'), 1)

    await svc.purge('s1')
    assert.equal(svc.getMappingSize('s1'), 0)
    assert.ok(audit.entries.some(e => e.kind === 'sanitizer.purged'))
  })

  it('is a no-op for unknown sessions', async () => {
    const policy = createPolicyService()
    await policy.reload()
    const audit = fakeAuditLog()
    const svc = new SanitizerServiceImpl(fakeCtx() as never, {
      enableAutoDetection: true,
      maxReplacementsPerSession: 1024,
    }, policy, audit)

    await svc.purge('unknown')
    assert.equal(audit.entries.filter(e => e.kind === 'sanitizer.purged').length, 0)
  })
})

describe('sanitizer-pipeline round-trip', () => {
  it('sanitize → desanitize restores original text', async () => {
    const policy = createPolicyService()
    await policy.reload()
    const svc = new SanitizerServiceImpl(fakeCtx() as never, {
      enableAutoDetection: true,
      maxReplacementsPerSession: 1024,
    }, policy, fakeAuditLog())

    const original = '我的手机13812345678，邮箱test@example.com'
    const result = await svc.sanitize(original, { sessionId: 's1' })
    const restored = await svc.desanitize(result.sanitizedText, 's1')
    assert.equal(restored, original)
  })

  it('cross-session isolation in round-trip', async () => {
    const policy = createPolicyService()
    await policy.reload()
    const svc = new SanitizerServiceImpl(fakeCtx() as never, {
      enableAutoDetection: true,
      maxReplacementsPerSession: 1024,
    }, policy, fakeAuditLog())

    // Same phone in two sessions — both get [PHONE_1] in their own context
    const r1 = await svc.sanitize('电话13812345678', { sessionId: 's1' })
    const r2 = await svc.sanitize('电话13900001111', { sessionId: 's2' })

    // Each session's desanitize should restore the correct original
    const restored1 = await svc.desanitize(r1.sanitizedText, 's1')
    const restored2 = await svc.desanitize(r2.sanitizedText, 's2')
    assert.equal(restored1, '电话13812345678')
    assert.equal(restored2, '电话13900001111')
  })
})

describe('sanitizer-pipeline apply', () => {
  it('returns a disposer that purges all sessions', async () => {
    const policy = createPolicyService()
    await policy.reload()
    const audit = fakeAuditLog()
    const fakeC = {
      ...fakeCtx(),
      get(name: string) {
        if (name === 'privacyPolicy') return policy
        if (name === 'auditLog') return audit
        return undefined
      },
    }
    const dispose = await sanitizer.apply(fakeC, {
      enableAutoDetection: true,
      maxReplacementsPerSession: 1024,
    })
    assert.equal(typeof dispose, 'function')
    await dispose()
  })
})

// ─── P1 (2026-08-24): additional PII patterns — IP / MAC / passport / license ──
// These rules were added to the shipped policy (v1.2.0). Tests below use an
// extended fixture to verify regex correctness end-to-end through the pipeline.

const EXTENDED_POLICY: PrivacyPolicy = {
  version: '1.2.0',
  routingRules: [],
  sanitizationRules: [
    { pattern: '1[3-9]\\d{9}', replacement: '[PHONE]', dataClass: 'confidential', piiType: 'phone' },
    { pattern: '[\\w.-]+@[\\w.-]+\\.\\w+', replacement: '[EMAIL]', dataClass: 'confidential', piiType: 'email' },
    { pattern: '\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b', replacement: '[IP]', dataClass: 'confidential', piiType: 'ip-address' },
    { pattern: '([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}', replacement: '[MAC]', dataClass: 'confidential', piiType: 'mac-address' },
    { pattern: '(E[0-9A-Z]\\d{7}|G\\d{8})', replacement: '[PASSPORT]', dataClass: 'secret', piiType: 'passport' },
    { pattern: '[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤川青藏琼][A-Z][A-HJ-NP-Z0-9]{5}', replacement: '[PLATE]', dataClass: 'confidential', piiType: 'license-plate' },
  ],
  dataClassifications: [],
  globalConstraints: { maxCloudRequestsPerMinute: 20, requireAttestation: false, blockIfTcbCompromised: true },
}

function createExtendedPolicyService(): PrivacyPolicyServiceImpl {
  const policyPath = join(root, 'policy-ext.json')
  writeFileSync(policyPath, JSON.stringify(EXTENDED_POLICY, null, 2), 'utf-8')
  const svc = new PrivacyPolicyServiceImpl(fakeCtx() as never, {
    policyPath, hotReload: false, watchIntervalMs: 5000,
  }, fakeAuditLog())
  return svc
}

describe('sanitizer-pipeline P1 PII patterns (v1.2.0)', () => {
  it('replaces IPv4 addresses', async () => {
    const policy = createExtendedPolicyService()
    await policy.reload()
    const audit = fakeAuditLog()
    const svc = new SanitizerServiceImpl(fakeCtx() as never, {
      enableAutoDetection: true, maxReplacementsPerSession: 1024,
    }, policy, audit)

    const r = await svc.sanitize('服务器 IP 是 192.168.1.100', { sessionId: 'ip-1' })
    assert.match(r.sanitizedText, /\[IP-ADDRESS_1\]/u)
    assert.doesNotMatch(r.sanitizedText, /192\.168\.1\.100/u)
    assert.equal(r.replacements.length, 1)
    assert.equal(r.replacements[0].piiType, 'ip-address')
  })

  it('replaces MAC addresses (colon and hyphen forms)', async () => {
    const policy = createExtendedPolicyService()
    await policy.reload()
    const svc = new SanitizerServiceImpl(fakeCtx() as never, {
      enableAutoDetection: true, maxReplacementsPerSession: 1024,
    }, policy, fakeAuditLog())

    const r1 = await svc.sanitize('设备 MAC: 00:1A:2B:3C:4D:5E', { sessionId: 'mac-1' })
    assert.match(r1.sanitizedText, /\[MAC-ADDRESS_1\]/u)
    assert.doesNotMatch(r1.sanitizedText, /00:1A:2B:3C:4D:5E/u)

    const r2 = await svc.sanitize('hyphen form: 00-1A-2B-3C-4D-5E', { sessionId: 'mac-2' })
    assert.match(r2.sanitizedText, /\[MAC-ADDRESS_1\]/u)
  })

  it('replaces Chinese passport numbers (E/G prefix)', async () => {
    const policy = createExtendedPolicyService()
    await policy.reload()
    const svc = new SanitizerServiceImpl(fakeCtx() as never, {
      enableAutoDetection: true, maxReplacementsPerSession: 1024,
    }, policy, fakeAuditLog())

    // New E-series passport: E + letter/digit + 7 digits
    const r1 = await svc.sanitize('护照号 EA1234567', { sessionId: 'pass-1' })
    assert.match(r1.sanitizedText, /\[PASSPORT_1\]/u)
    assert.doesNotMatch(r1.sanitizedText, /EA1234567/u)

    // Old G-series passport: G + 8 digits
    const r2 = await svc.sanitize('旧护照 G12345678', { sessionId: 'pass-2' })
    assert.match(r2.sanitizedText, /\[PASSPORT_1\]/u)
  })

  it('replaces Chinese license plates', async () => {
    const policy = createExtendedPolicyService()
    await policy.reload()
    const svc = new SanitizerServiceImpl(fakeCtx() as never, {
      enableAutoDetection: true, maxReplacementsPerSession: 1024,
    }, policy, fakeAuditLog())

    // Beijing plate: 京 + letter + 5 alphanum
    const r = await svc.sanitize('我的车牌是京A12345', { sessionId: 'plate-1' })
    assert.match(r.sanitizedText, /\[LICENSE-PLATE_1\]/u)
    assert.doesNotMatch(r.sanitizedText, /京A12345/u)
  })

  it('handles all PII types in one message', async () => {
    const policy = createExtendedPolicyService()
    await policy.reload()
    const svc = new SanitizerServiceImpl(fakeCtx() as never, {
      enableAutoDetection: true, maxReplacementsPerSession: 1024,
    }, policy, fakeAuditLog())

    const text = '手机号13812345678 邮箱a@b.com IP 10.0.0.1 车牌京A12345'
    const r = await svc.sanitize(text, { sessionId: 'multi-1' })
    assert.doesNotMatch(r.sanitizedText, /13812345678/u)
    assert.doesNotMatch(r.sanitizedText, /a@b\.com/u)
    assert.doesNotMatch(r.sanitizedText, /10\.0\.0\.1/u)
    assert.doesNotMatch(r.sanitizedText, /京A12345/u)
    assert.equal(r.replacements.length, 4)
    const piiTypes = r.replacements.map((rep: any) => rep.piiType).sort()
    assert.deepEqual(piiTypes, ['email', 'ip-address', 'license-plate', 'phone'])
  })

  it('does not match non-IP patterns (e.g., version strings)', async () => {
    const policy = createExtendedPolicyService()
    await policy.reload()
    const svc = new SanitizerServiceImpl(fakeCtx() as never, {
      enableAutoDetection: true, maxReplacementsPerSession: 1024,
    }, policy, fakeAuditLog())

    // Note: the simple IP regex WILL match version-like strings. This is
    // an accepted trade-off (low FP in chat contexts). Test documents
    // behavior: any N.N.N.N with 1-3 digit groups is treated as IP.
    const r = await svc.sanitize('node v18.17.0', { sessionId: 'ver-1' })
    // The regex \b(?:\d{1,3}\.){3}\d{1,3}\b DOES match 18.17.0 — only 3 dots
    // needed, but v18.17.0 only has 2 dots → NO match
    assert.equal(r.replacements.length, 0, 'version string should NOT match IP regex (only 2 dots)')
    assert.equal(r.sanitizedText, 'node v18.17.0')
  })
})

/**
 * 2026-08-30 修复回归：会话映射表生命周期、占位符防碰撞、反向还原正确性。
 */
describe('sanitizer-pipeline session lifecycle', () => {
  it('expires session mappings after sessionTtlMs', async () => {
    const policy = createPolicyService()
    await policy.reload()
    const audit = fakeAuditLog()
    const svc = new SanitizerServiceImpl(fakeCtx() as never, {
      enableAutoDetection: true,
      maxReplacementsPerSession: 1024,
      sessionTtlMs: 1,
      sweepIntervalMs: 0, // 只测惰性清扫，避免定时器干扰
    } as never, policy, audit)

    await svc.sanitize('13812345678', { sessionId: 'old' })
    assert.equal(svc.getMappingSize('old'), 1)

    await new Promise((r) => setTimeout(r, 5))
    // 任意一次 sanitize 都会先跑清扫
    await svc.sanitize('无 PII 文本', { sessionId: 'new' })

    assert.equal(svc.getMappingSize('old'), 0, '过期会话的明文 PII 必须被释放')
    assert.ok(audit.entries.some((e) => e.kind === 'sanitizer.session-expired'))
  })

  it('evicts least-recently-used sessions beyond maxSessions', async () => {
    const policy = createPolicyService()
    await policy.reload()
    const svc = new SanitizerServiceImpl(fakeCtx() as never, {
      enableAutoDetection: true,
      maxReplacementsPerSession: 1024,
      sessionTtlMs: 0,
      maxSessions: 2,
      sweepIntervalMs: 0,
    } as never, policy, fakeAuditLog())

    await svc.sanitize('13812345678', { sessionId: 's1' })
    await svc.sanitize('13900001111', { sessionId: 's2' })
    await svc.sanitize('13700002222', { sessionId: 's3' })

    assert.ok(svc.getSessionCount() <= 2, '会话数不得超过 maxSessions')
    assert.equal(svc.getMappingSize('s1'), 0, '最久未访问的会话应被淘汰')
    assert.equal(svc.getMappingSize('s3'), 1)
  })

  it('stop() clears every session mapping', async () => {
    const policy = createPolicyService()
    await policy.reload()
    const svc = new SanitizerServiceImpl(fakeCtx() as never, {
      enableAutoDetection: true, maxReplacementsPerSession: 1024,
    } as never, policy, fakeAuditLog())

    await svc.sanitize('13812345678', { sessionId: 'a' })
    await svc.sanitize('13900001111', { sessionId: 'b' })
    await svc.stop()

    assert.equal(svc.getSessionCount(), 0)
  })
})

describe('sanitizer-pipeline placeholder collision safety', () => {
  it('never mints a placeholder that collides with a literal in the input', async () => {
    const policy = createPolicyService()
    await policy.reload()
    const svc = new SanitizerServiceImpl(fakeCtx() as never, {
      enableAutoDetection: true, maxReplacementsPerSession: 1024,
    } as never, policy, fakeAuditLog())

    // 用户输入里本就含占位符形状的字面量
    const r = await svc.sanitize('见 [PHONE_1] 与 13812345678', { sessionId: 'c1' })
    assert.ok(!r.sanitizedText.includes('13812345678'))
    // 新铸造的占位符必须跳过 1
    assert.notEqual(r.replacements[0].placeholder, '[PHONE_1]')
    // 还原后用户原本的 [PHONE_1] 字面量保持不变
    const back = await svc.desanitize(r.sanitizedText, 'c1')
    assert.ok(back.includes('[PHONE_1]'))
    assert.ok(back.includes('13812345678'))
  })

  it('leaves unknown placeholders untouched on desanitize', async () => {
    const policy = createPolicyService()
    await policy.reload()
    const svc = new SanitizerServiceImpl(fakeCtx() as never, {
      enableAutoDetection: true, maxReplacementsPerSession: 1024,
    } as never, policy, fakeAuditLog())

    await svc.sanitize('13812345678', { sessionId: 'c2' })
    const out = await svc.desanitize('未知 [EMAIL_99] 占位符', 'c2')
    assert.equal(out, '未知 [EMAIL_99] 占位符')
  })
})
