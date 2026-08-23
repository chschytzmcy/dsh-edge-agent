/**
 * privacy-policy plugin tests — exercises JSON policy loading, routing
 * rule matching, data classification, sanitization rule retrieval,
 * hot-reload detection, and default fallback behavior.
 *
 * Phase 4 完整测试。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'vitest'
import { createHmac } from 'node:crypto'

import * as policy from '../../src/dsh-adapter/privacy-policy.ts'
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

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'edge-p4-policy-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const TEST_POLICY: PrivacyPolicy = {
  version: '1.0.0',
  routingRules: [
    {
      pattern: '(本地|local|文件|file)',
      realm: 'LOCAL',
      confidence: 0.8,
      rationale: 'Local operations stay on device',
    },
    {
      pattern: '(密码|password|secret)',
      realm: 'LOCAL',
      confidence: 0.95,
      rationale: 'Sensitive credentials must not leave device',
    },
    {
      pattern: '(翻译|translate|summarize)',
      realm: 'CLOUD',
      confidence: 0.7,
      rationale: 'Knowledge tasks can use cloud',
    },
  ],
  sanitizationRules: [
    { pattern: '1[3-9]\\d{9}', replacement: '[PHONE]', dataClass: 'confidential', piiType: 'phone' },
    { pattern: '[\\w.-]+@[\\w.-]+\\.\\w+', replacement: '[EMAIL]', dataClass: 'confidential', piiType: 'email' },
    { pattern: '\\d{16,19}', replacement: '[BANK_CARD]', dataClass: 'secret', piiType: 'bank-card' },
  ],
  dataClassifications: [
    { class: 'public', defaultRealm: 'CLOUD', ttlSeconds: 3600 },
    { class: 'confidential', defaultRealm: 'LOCAL', ttlSeconds: 900 },
    { class: 'secret', defaultRealm: 'LOCAL', ttlSeconds: 300 },
  ],
  globalConstraints: {
    maxCloudRequestsPerMinute: 20,
    requireAttestation: false,
    blockIfTcbCompromised: true,
  },
}

function writePolicyFile(filename: string, data: unknown = TEST_POLICY): string {
  const path = join(root, filename)
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8')
  return path
}

describe('privacy-policy plugin', () => {
  it('exports the canonical plugin shape', () => {
    assert.equal(policy.name, 'privacy-policy')
    assert.deepEqual([...policy.inject], ['auditLog'])
    assert.equal(typeof policy.apply, 'function')
    assert.ok(policy.Config)
  })

  it('config schema includes policyPath, hotReload, watchIntervalMs', () => {
    const json = (policy.Config as unknown as { toJSON(): any }).toJSON()
    assert.ok(json)
  })
})

describe('privacy-policy loading', () => {
  it('loads a valid policy file from disk', async () => {
    const policyPath = writePolicyFile('policy.json')
    const audit = fakeAuditLog()
    const svc = new PrivacyPolicyServiceImpl(fakeCtx() as never, {
      policyPath,
      hotReload: false,
      watchIntervalMs: 5000,
    }, audit)
    await svc.reload()
    const p = svc.get()
    assert.equal(p.version, '1.0.0')
    assert.equal(p.routingRules.length, 3)
    assert.equal(p.sanitizationRules.length, 3)
  })

  it('falls back to default policy when file does not exist', async () => {
    const audit = fakeAuditLog()
    const svc = new PrivacyPolicyServiceImpl(fakeCtx() as never, {
      policyPath: join(root, 'nonexistent.json'),
      hotReload: false,
      watchIntervalMs: 5000,
    }, audit)
    await svc.reload()
    const p = svc.get()
    assert.equal(p.version, '1.0.0')
    assert.ok(p.routingRules.length > 0)
    // Should have logged a warning
    assert.ok(audit.entries.some(e => e.kind === 'policy.missing'))
  })

  it('falls back to default policy when file contains invalid JSON', async () => {
    const path = join(root, 'bad.json')
    writeFileSync(path, 'not json at all', 'utf-8')
    const audit = fakeAuditLog()
    const svc = new PrivacyPolicyServiceImpl(fakeCtx() as never, {
      policyPath: path,
      hotReload: false,
      watchIntervalMs: 5000,
    }, audit)
    await svc.reload()
    const p = svc.get()
    assert.ok(p.routingRules.length > 0)
    assert.ok(audit.entries.some(e => e.kind === 'policy.load-failed'))
  })

  it('falls back to default when policy structure is invalid', async () => {
    const path = writePolicyFile('invalid-structure.json', { version: '1.0' })
    const audit = fakeAuditLog()
    const svc = new PrivacyPolicyServiceImpl(fakeCtx() as never, {
      policyPath: path,
      hotReload: false,
      watchIntervalMs: 5000,
    }, audit)
    await svc.reload()
    assert.ok(audit.entries.some(e => e.kind === 'policy.load-failed'))
  })

  it('emits policy/loaded event on successful load', async () => {
    const policyPath = writePolicyFile('policy.json')
    const audit = fakeAuditLog()
    const svc = new PrivacyPolicyServiceImpl(fakeCtx() as never, {
      policyPath,
      hotReload: false,
      watchIntervalMs: 5000,
    }, audit)
    let loaded: PrivacyPolicy | null = null
    svc.on('policy/loaded', (p: PrivacyPolicy) => { loaded = p })
    await svc.reload()
    assert.ok(loaded)
    assert.equal(loaded!.version, '1.0.0')
  })
})

describe('privacy-policy routing', () => {
  it('matches LOCAL intent for local operations', async () => {
    const policyPath = writePolicyFile('policy.json')
    const svc = new PrivacyPolicyServiceImpl(fakeCtx() as never, {
      policyPath, hotReload: false, watchIntervalMs: 5000,
    }, fakeAuditLog())
    await svc.reload()
    const match = svc.matchRouting('帮我读取文件内容')
    assert.ok(match)
    assert.equal(match!.realm, 'LOCAL')
  })

  it('matches LOCAL intent for credential mentions', async () => {
    const policyPath = writePolicyFile('policy.json')
    const svc = new PrivacyPolicyServiceImpl(fakeCtx() as never, {
      policyPath, hotReload: false, watchIntervalMs: 5000,
    }, fakeAuditLog())
    await svc.reload()
    const match = svc.matchRouting('我的密码是什么')
    assert.ok(match)
    assert.equal(match!.realm, 'LOCAL')
    assert.equal(match!.confidence, 0.95)
  })

  it('matches CLOUD intent for translation requests', async () => {
    const policyPath = writePolicyFile('policy.json')
    const svc = new PrivacyPolicyServiceImpl(fakeCtx() as never, {
      policyPath, hotReload: false, watchIntervalMs: 5000,
    }, fakeAuditLog())
    await svc.reload()
    const match = svc.matchRouting('请翻译这段话')
    assert.ok(match)
    assert.equal(match!.realm, 'CLOUD')
  })

  it('returns null when no routing rule matches', async () => {
    const policyPath = writePolicyFile('policy.json')
    const svc = new PrivacyPolicyServiceImpl(fakeCtx() as never, {
      policyPath, hotReload: false, watchIntervalMs: 5000,
    }, fakeAuditLog())
    await svc.reload()
    const match = svc.matchRouting('xyzzy123 no match here')
    assert.equal(match, null)
  })
})

describe('privacy-policy classification', () => {
  it('classifies text with phone number as confidential', async () => {
    const policyPath = writePolicyFile('policy.json')
    const svc = new PrivacyPolicyServiceImpl(fakeCtx() as never, {
      policyPath, hotReload: false, watchIntervalMs: 5000,
    }, fakeAuditLog())
    await svc.reload()
    const cls = svc.classifyData('联系电话是 13812345678')
    assert.equal(cls, 'confidential')
  })

  it('classifies text with bank card as secret', async () => {
    const policyPath = writePolicyFile('policy.json')
    const svc = new PrivacyPolicyServiceImpl(fakeCtx() as never, {
      policyPath, hotReload: false, watchIntervalMs: 5000,
    }, fakeAuditLog())
    await svc.reload()
    const cls = svc.classifyData('卡号 6222021234567890123')
    assert.equal(cls, 'secret')
  })

  it('classifies plain text as public', async () => {
    const policyPath = writePolicyFile('policy.json')
    const svc = new PrivacyPolicyServiceImpl(fakeCtx() as never, {
      policyPath, hotReload: false, watchIntervalMs: 5000,
    }, fakeAuditLog())
    await svc.reload()
    const cls = svc.classifyData('hello world')
    assert.equal(cls, 'public')
  })
})

describe('privacy-policy accessors', () => {
  it('getRoutingRules returns all routing rules', async () => {
    const policyPath = writePolicyFile('policy.json')
    const svc = new PrivacyPolicyServiceImpl(fakeCtx() as never, {
      policyPath, hotReload: false, watchIntervalMs: 5000,
    }, fakeAuditLog())
    await svc.reload()
    assert.equal(svc.getRoutingRules().length, 3)
  })

  it('getSanitizationRules returns all sanitization rules', async () => {
    const policyPath = writePolicyFile('policy.json')
    const svc = new PrivacyPolicyServiceImpl(fakeCtx() as never, {
      policyPath, hotReload: false, watchIntervalMs: 5000,
    }, fakeAuditLog())
    await svc.reload()
    assert.equal(svc.getSanitizationRules().length, 3)
  })

  it('getClassifications returns data classifications', async () => {
    const policyPath = writePolicyFile('policy.json')
    const svc = new PrivacyPolicyServiceImpl(fakeCtx() as never, {
      policyPath, hotReload: false, watchIntervalMs: 5000,
    }, fakeAuditLog())
    await svc.reload()
    assert.equal(svc.getClassifications().length, 3)
  })

  it('getConstraints returns global constraints', async () => {
    const policyPath = writePolicyFile('policy.json')
    const svc = new PrivacyPolicyServiceImpl(fakeCtx() as never, {
      policyPath, hotReload: false, watchIntervalMs: 5000,
    }, fakeAuditLog())
    await svc.reload()
    const c = svc.getConstraints()
    assert.equal(c.maxCloudRequestsPerMinute, 20)
    assert.equal(c.blockIfTcbCompromised, true)
  })
})

describe('privacy-policy hot-reload', () => {
  it('reloads when file mtime changes', async () => {
    const policyPath = writePolicyFile('policy.json')
    const svc = new PrivacyPolicyServiceImpl(fakeCtx() as never, {
      policyPath, hotReload: false, watchIntervalMs: 5000,
    }, fakeAuditLog())
    await svc.reload()
    assert.equal(svc.get().routingRules.length, 3)

    // Write a new policy with different rules
    const updated: PrivacyPolicy = {
      ...TEST_POLICY,
      routingRules: [TEST_POLICY.routingRules[0]],
    }
    writeFileSync(policyPath, JSON.stringify(updated), 'utf-8')
    await svc.reload()
    assert.equal(svc.get().routingRules.length, 1)
  })
})

describe('privacy-policy apply', () => {
  it('returns a disposer function', async () => {
    const policyPath = writePolicyFile('policy.json')
    const audit = fakeAuditLog()
    const fakeC = {
      ...fakeCtx(),
      get(name: string) {
        if (name === 'auditLog') return audit
        return undefined
      },
    }
    const dispose = await policy.apply(fakeC, {
      policyPath,
      hotReload: false,
      watchIntervalMs: 5000,
    })
    assert.equal(typeof dispose, 'function')
    await dispose()
  })
})

describe('privacy-policy HMAC signing', () => {
  const TEST_KEY = 'unit-test-hmac-key-do-not-leak'

  function withHmacKey<T>(fn: () => Promise<T>): Promise<T> {
    const prev = process.env.DSH_EDGE_POLICY_HMAC_KEY
    process.env.DSH_EDGE_POLICY_HMAC_KEY = TEST_KEY
    return fn().finally(() => {
      if (prev === undefined) delete process.env.DSH_EDGE_POLICY_HMAC_KEY
      else process.env.DSH_EDGE_POLICY_HMAC_KEY = prev
    })
  }

  function withoutHmacKey<T>(fn: () => Promise<T>): Promise<T> {
    const prev = process.env.DSH_EDGE_POLICY_HMAC_KEY
    delete process.env.DSH_EDGE_POLICY_HMAC_KEY
    return fn().finally(() => {
      if (prev !== undefined) process.env.DSH_EDGE_POLICY_HMAC_KEY = prev
    })
  }

  function signBody(body: string, key: string = TEST_KEY): string {
    return createHmac('sha256', key).update(body, 'utf-8').digest('hex')
  }

  it('loads successfully when a valid sidecar signature is present', async () => {
    await withHmacKey(async () => {
      const policyPath = writePolicyFile('policy.json')
      const body = readFileSync(policyPath, 'utf-8')
      writeFileSync(`${policyPath}.sig`, signBody(body), 'utf-8')

      const audit = fakeAuditLog()
      const svc = new PrivacyPolicyServiceImpl(fakeCtx() as never, {
        policyPath, hotReload: false, watchIntervalMs: 5000,
      }, audit)
      await svc.reload()

      assert.equal(svc.get().version, '1.0.0')
      assert.ok(audit.entries.some((e) => e.kind === 'policy.loaded'))
      assert.ok(!audit.entries.some((e) => e.kind === 'policy.tamper-detected'))
    })
  })

  it('rejects a tampered body when the sidecar signature does not match', async () => {
    await withHmacKey(async () => {
      const policyPath = writePolicyFile('policy.json')
      const body = readFileSync(policyPath, 'utf-8')
      // Sign the unmodified body…
      writeFileSync(`${policyPath}.sig`, signBody(body), 'utf-8')
      // …then mutate the policy file behind the signature's back.
      writeFileSync(policyPath, JSON.stringify({ ...TEST_POLICY, version: '9.9.9' }), 'utf-8')

      const audit = fakeAuditLog()
      const svc = new PrivacyPolicyServiceImpl(fakeCtx() as never, {
        policyPath, hotReload: false, watchIntervalMs: 5000,
      }, audit)
      await svc.reload()

      // In-memory policy must be the default, NOT the tampered file.
      assert.equal(svc.get().version, '1.0.0')
      // Tamper event was raised at security level.
      const tamper = audit.entries.find((e) => e.kind === 'policy.tamper-detected')
      assert.ok(tamper, 'expected policy.tamper-detected audit entry')
      assert.equal(tamper!.level, 'security')
      assert.equal(tamper!.payload.reason, 'hmac-mismatch')
      // The tampered file's 'policy.loaded' must NOT have been emitted.
      assert.ok(!audit.entries.some((e) => e.kind === 'policy.loaded'))
    })
  })

  it('rejects when the sidecar signature file is missing and a key is configured', async () => {
    await withHmacKey(async () => {
      const policyPath = writePolicyFile('policy.json')
      // intentionally do NOT write `${policyPath}.sig`

      const audit = fakeAuditLog()
      const svc = new PrivacyPolicyServiceImpl(fakeCtx() as never, {
        policyPath, hotReload: false, watchIntervalMs: 5000,
      }, audit)
      await svc.reload()

      assert.equal(svc.get().version, '1.0.0')
      const tamper = audit.entries.find((e) => e.kind === 'policy.tamper-detected')
      assert.ok(tamper)
      assert.equal(tamper!.payload.reason, 'signature-file-missing')
    })
  })

  it('skips verification when DSH_EDGE_POLICY_HMAC_KEY is unset (dev/CI)', async () => {
    await withoutHmacKey(async () => {
      const policyPath = writePolicyFile('policy.json')
      // No sidecar file; no key — must still load.
      const audit = fakeAuditLog()
      const svc = new PrivacyPolicyServiceImpl(fakeCtx() as never, {
        policyPath, hotReload: false, watchIntervalMs: 5000,
      }, audit)
      await svc.reload()

      assert.equal(svc.get().version, '1.0.0')
      assert.ok(audit.entries.some((e) => e.kind === 'policy.loaded'))
      // Latched "signing disabled" notice fires once.
      const notices = audit.entries.filter((e) => e.kind === 'policy.signing.disabled')
      assert.equal(notices.length, 1)
    })
  })

  it('emits policy.signing.disabled at most once across multiple reloads', async () => {
    await withoutHmacKey(async () => {
      const policyPath = writePolicyFile('policy.json')
      const audit = fakeAuditLog()
      const svc = new PrivacyPolicyServiceImpl(fakeCtx() as never, {
        policyPath, hotReload: false, watchIntervalMs: 5000,
      }, audit)
      await svc.reload()
      await svc.reload()
      await svc.reload()

      const notices = audit.entries.filter((e) => e.kind === 'policy.signing.disabled')
      assert.equal(notices.length, 1)
    })
  })

  it('accepts hex signatures with leading whitespace or mixed case', async () => {
    await withHmacKey(async () => {
      const policyPath = writePolicyFile('policy.json')
      const body = readFileSync(policyPath, 'utf-8')
      const hex = signBody(body)
      const pretty = `\n  ${hex.slice(0, 16).toUpperCase()}${hex.slice(16).toLowerCase()}  \n`
      writeFileSync(`${policyPath}.sig`, pretty, 'utf-8')

      const audit = fakeAuditLog()
      const svc = new PrivacyPolicyServiceImpl(fakeCtx() as never, {
        policyPath, hotReload: false, watchIntervalMs: 5000,
      }, audit)
      await svc.reload()

      assert.equal(svc.get().version, '1.0.0')
      assert.ok(!audit.entries.some((e) => e.kind === 'policy.tamper-detected'))
    })
  })

  it('rejects a non-hex signature gracefully (no throw, fail-closed)', async () => {
    await withHmacKey(async () => {
      const policyPath = writePolicyFile('policy.json')
      writeFileSync(`${policyPath}.sig`, 'not-a-hex-string-at-all', 'utf-8')

      const audit = fakeAuditLog()
      const svc = new PrivacyPolicyServiceImpl(fakeCtx() as never, {
        policyPath, hotReload: false, watchIntervalMs: 5000,
      }, audit)
      await svc.reload()

      assert.equal(svc.get().version, '1.0.0')
      const tamper = audit.entries.find((e) => e.kind === 'policy.tamper-detected')
      assert.ok(tamper)
      assert.equal(tamper!.payload.reason, 'hmac-mismatch')
    })
  })
})
