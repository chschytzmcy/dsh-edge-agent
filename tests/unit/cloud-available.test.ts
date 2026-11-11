/**
 * §7.100 model-router registry truth — the registry replaces the old
 * hardcoded `available: true`.
 *
 * §7.175 (2026-11-11): the input-guard half of this file (the
 * `cloudAvailable()` probe) is gone — the probe existed only to trigger the
 * route rewrite (「云端不可用 → 降级 LOCAL」), and input-guard no longer
 * rewrites routes: the route is decided by the host's modelSelection and
 * the fail-closed gate in agent/pre-step.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

import { ModelRouterServiceImpl } from '../../src/dsh-adapter/model-router.ts'

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
    assert.equal(detailed.find((m) => m.provider === 'cloud-llm')!.available, false)
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
