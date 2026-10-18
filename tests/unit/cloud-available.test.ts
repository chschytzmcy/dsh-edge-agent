/**
 * §7.100 availability truth for the cloud pool, at the two decision sites:
 *  - input-guard cloudAvailable() — decides whether CLOUD/SANITIZED turns
 *    downgrade to LOCAL (must mirror the adapter's mode resolution).
 *  - model-router isAvailable()/listDetailed() — registry truth replaces
 *    the old hardcoded `available: true`.
 */
import assert from 'node:assert/strict'
import { describe, it, afterEach } from 'vitest'

import { InputGuardServiceImpl } from '../../src/dsh-adapter/input-guard.ts'
import { ModelRouterServiceImpl } from '../../src/dsh-adapter/model-router.ts'

const ENV_KEYS = [
  'DSH_EDGE_CLOUD_LLM_BASEURL',
  'DEEPSEEK_BASE_URL',
  'DSH_EDGE_CLOUD_DELEGATE',
  'DSH_EDGE_CLOUD_DELEGATE_PROVIDER',
  'DSH_EDGE_CLOUD_DELEGATE_MODEL',
  'TEST_CLOUD_KEY_SLOT',
] as const

const saved: Record<string, string | undefined> = {}
function clearEnv() {
  for (const k of ENV_KEYS) {
    if (!(k in saved)) saved[k] = process.env[k]
    delete process.env[k]
  }
}
function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]!
  }
}

function baseConfig(): any {
  return {
    enableInputGuard: true,
    sanitizeLocalTraffic: false,
    rejectOnPolicyViolation: true,
    downgradeOnSanitizeFailure: true,
    localProvider: 'local-llm',
    localModel: 'qwen3-4b-instruct-2507',
    cloudApiKeyEnv: 'TEST_CLOUD_KEY_SLOT',
    defaultCloudProvider: 'cloud-llm',
    defaultCloudModel: 'deepseek-chat',
  }
}

function mkService(env: Record<string, string>, llmRoutes?: string[] | null) {
  const llm = llmRoutes === null
    ? undefined
    : { listProviders: () => llmRoutes!.map((id) => ({ id, name: id })) }
  const ctx: any = {
    reflect: { provide: () => {} },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    get(name: string) {
      if (name === 'llm') { if (!llm) throw new Error('no llm'); return llm }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }) }
      if (name === 'credentials') throw new Error('no credentials')
      throw new Error(`no service ${name}`)
    },
  }
  return new InputGuardServiceImpl(ctx, { ...baseConfig(), ...{} } as any)
}

describe('§7.100 input-guard cloudAvailable()', () => {
  afterEach(restoreEnv)

  it('DIRECT mode (baseurl configured): key present → ok; key missing → §7.35 reason', () => {
    clearEnv()
    process.env.DSH_EDGE_CLOUD_LLM_BASEURL = 'https://api.deepseek.com'
    let svc = mkService({}, ['cloud-llm', 'local-llm'])
    let r = (svc as any).cloudAvailable()
    assert.equal(r.mode, 'direct')
    assert.equal(r.ok, false)
    assert.match(r.reason, /^cloud-key-missing:TEST_CLOUD_KEY_SLOT/)
    process.env.TEST_CLOUD_KEY_SLOT = 'sk-test'
    svc = mkService({}, ['cloud-llm'])
    r = (svc as any).cloudAvailable()
    assert.equal(r.ok, true)
    delete process.env.TEST_CLOUD_KEY_SLOT
  })

  it('DELEGATE mode: live host route (selection) → ok with provenance', () => {
    clearEnv()
    const svc = mkService({}, ['deepseek-official'])
    const r = (svc as any).cloudAvailable()
    assert.equal(r.mode, 'delegate')
    assert.equal(r.ok, true)
    assert.match(r.reason, /delegate-target:deepseek-official/)
  })

  it('DELEGATE mode: only own routes registered → not available (downgrade path)', () => {
    clearEnv()
    const svc = mkService({}, ['cloud-llm', 'local-llm'])
    const r = (svc as any).cloudAvailable()
    assert.equal(r.ok, false)
    assert.match(r.reason, /cloud-unavailable/)
  })

  it('DELEGATE mode: DSH_EDGE_CLOUD_DELEGATE=false → not available (§7.35 semantics restored)', () => {
    clearEnv()
    process.env.DSH_EDGE_CLOUD_DELEGATE = 'false'
    const svc = mkService({}, ['deepseek-official'])
    const r = (svc as any).cloudAvailable()
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'cloud-delegate-disabled')
  })

  it('legacy upstream (no listProviders) → falls back to key check, no crash', () => {
    clearEnv()
    const svc = mkService({}, null) // ctx.get('llm') throws
    const r = (svc as any).cloudAvailable()
    assert.equal(r.ok, false) // no key in slot → same verdict §7.35 would give
    assert.match(r.reason, /legacy/)
  })
})

describe('§7.100 model-router registry truth', () => {
  function mkRouter(live: string[] | null) {
    const ctx: any = {
      reflect: { provide: () => {} },
      llm: live === null ? undefined : { listProviders: () => live.map((id) => ({ id, name: id })) },
    }
    return new ModelRouterServiceImpl(ctx, ['local-llm'], ['cloud-llm'])
  }

  it('configured-but-unregistered route reports available:false', () => {
    const mr = mkRouter(['local-llm'])
    assert.equal(mr.isAvailable('local-llm'), true)
    assert.equal(mr.isAvailable('cloud-llm'), false)
    const detailed = mr.listDetailed()
    assert.deepEqual(detailed.find((m) => m.provider === 'cloud-llm')!.available, false)
  })

  it('delegate route counts as available once registered', () => {
    const mr = mkRouter(['local-llm', 'cloud-llm'])
    assert.equal(mr.isAvailable('cloud-llm'), true)
  })

  it('no registry (old upstream / partial fakes) → §7.4 config-membership fallback', () => {
    const mr = mkRouter(null)
    assert.equal(mr.isAvailable('cloud-llm'), true)
    assert.equal(mr.listDetailed().every((m) => m.available), true)
  })
})
