/**
 * M1 unit test: model-router minimal version.
 *
 * Asserts realm classification by model-name prefix and the
 * canonical plugin shape (name/inject/Config/apply). The route
 * classifier is a pure function so the realm logic does not need
 * a real Cordis context.
 *
 * Run via `pnpm test -t model-router`.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

import * as modelRouter from '../../src/dsh-adapter/model-router.ts'
import { resolveRoute } from '../../src/dsh-adapter/model-router.ts'

describe('model-router (M1)', () => {
  it('exports the canonical plugin shape', () => {
    assert.equal(modelRouter.name, 'model-router')
    assert.deepEqual([...modelRouter.inject], ['llm'])
    assert.equal(typeof modelRouter.apply, 'function')
    assert.ok(modelRouter.Config)
  })

  it('routes local-* models to the LOCAL realm', () => {
    const r = resolveRoute('local-qwen3-4b-mock')
    assert.equal(r.realm, 'LOCAL')
    assert.equal(r.provider, 'local-qwen3-4b-mock')
  })

  it('routes cloud-* models to the CLOUD realm', () => {
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
})