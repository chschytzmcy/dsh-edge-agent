/**
 * M1 + M4 unit tests: model-router route classification.
 *
 * The route classifier is a pure function so the realm logic does not
 * need a real Cordis context. M4 adds explicit catalog lookup (so the
 * router can distinguish `local-qwen3-4b` from arbitrary `local-*`
 * strings) and a service-level `listAvailable` / `isAvailable` surface.
 *
 * Run via `pnpm test -t model-router`.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

import * as modelRouter from '../../src/dsh-adapter/model-router.ts'
import { resolveRoute, ModelRouterServiceImpl } from '../../src/dsh-adapter/model-router.ts'

function fakeCtx() {
  return {
    reflect: { provide(_n: string, _v: unknown) { return () => {} } },
    provide(_n: string, _v: unknown) { return () => {} },
  } as never
}

describe('model-router (M1 + M4)', () => {
  it('exports the canonical plugin shape', () => {
    assert.equal(modelRouter.name, 'model-router')
    assert.deepEqual([...modelRouter.inject], ['llm'])
    assert.equal(typeof modelRouter.apply, 'function')
    assert.ok(modelRouter.Config)
  })

  it('routes local-* catalog routes to the LOCAL realm', () => {
    const r = resolveRoute('local-qwen3-4b-mock')
    assert.equal(r.realm, 'LOCAL')
    assert.equal(r.provider, 'local-qwen3-4b-mock')

    const r2 = resolveRoute('local-qwen3-4b')
    assert.equal(r2.realm, 'LOCAL')
    assert.equal(r2.provider, 'local-qwen3-4b')
  })

  it('routes cloud-* catalog routes to the CLOUD realm', () => {
    const r = resolveRoute('cloud-deepseek-v4')
    assert.equal(r.realm, 'CLOUD')
    assert.equal(r.provider, 'cloud-deepseek-v4')
  })

  it('falls back to CLOUD for unknown prefixes', () => {
    const r = resolveRoute('gpt-4')
    assert.equal(r.realm, 'CLOUD')
    assert.equal(r.provider, 'gpt-4')
  })

  it('falls back to CLOUD when model is an empty string', () => {
    const r = resolveRoute('')
    assert.equal(r.realm, 'CLOUD')
    assert.equal(r.provider, 'cloud-deepseek-v4')
  })

  it('M4: catalog membership decides realm before prefix matching', () => {
    // A provider named "cloud-x" placed in the LOCAL catalog must be
    // routed to LOCAL even though the prefix suggests CLOUD.
    const r = resolveRoute('cloud-x', ['cloud-x'], [])
    assert.equal(r.realm, 'LOCAL')
    assert.equal(r.provider, 'cloud-x')

    // Likewise for a "local-x" placed in the cloud catalog.
    const r2 = resolveRoute('local-x', [], ['local-x'])
    assert.equal(r2.realm, 'CLOUD')
    assert.equal(r2.provider, 'local-x')
  })

  it('M4: ModelRouterServiceImpl exposes listAvailable + isAvailable', () => {
    const svc = new ModelRouterServiceImpl(
      fakeCtx(),
      ['local-qwen3-4b-mock', 'local-qwen3-4b'],
      ['cloud-deepseek-v4'],
    )
    const all = svc.listAvailable()
    assert.ok(all.includes('local-qwen3-4b-mock'))
    assert.ok(all.includes('local-qwen3-4b'))
    assert.ok(all.includes('cloud-deepseek-v4'))

    assert.equal(svc.isAvailable('local-qwen3-4b'), true)
    assert.equal(svc.isAvailable('local-qwen3-4b-mock'), true)
    assert.equal(svc.isAvailable('cloud-deepseek-v4'), true)
    assert.equal(svc.isAvailable('gpt-4'), false)
    assert.equal(svc.isAvailable(''), false)
  })

  it('M4: ModelRouterServiceImpl.resolve delegates to resolveRoute with its catalogs', () => {
    const svc = new ModelRouterServiceImpl(fakeCtx(), ['only-local'], ['only-cloud'])
    assert.equal(svc.resolve('only-local').realm, 'LOCAL')
    assert.equal(svc.resolve('only-cloud').realm, 'CLOUD')
    assert.equal(svc.resolve('something-else').realm, 'CLOUD')
  })
})
