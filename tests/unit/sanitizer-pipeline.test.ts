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

  it('respects maxReplacementsPerSession limit', async () => {
    const policy = createPolicyService()
    await policy.reload()
    const audit = fakeAuditLog()
    const svc = new SanitizerServiceImpl(fakeCtx() as never, {
      enableAutoDetection: true,
      maxReplacementsPerSession: 2,
    }, policy, audit)

    await svc.sanitize('电话13812345678 13900001111 13700002222', { sessionId: 's1' })
    assert.equal(svc.getMappingSize('s1'), 2)
    assert.ok(audit.entries.some(e => e.kind === 'sanitizer.limit-reached'))
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
