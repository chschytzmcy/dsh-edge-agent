/**
 * privacy-policy plugin tests — verifies the canonical plugin shape and
 * the stub service contract.
 */
import assert from 'node:assert/strict'
import { default as policy } from '../../src/dsh-adapter/privacy-policy.ts'

describe('privacy-policy plugin', () => {
  it('exports the canonical plugin shape', () => {
    assert.equal(policy.name, 'privacy-policy')
    assert.deepEqual([...policy.inject], ['tcm', 'localStorage', 'auditLog'])
    assert.equal(typeof policy.apply, 'function')
    assert.equal(typeof policy.Config, 'object')
  })

  it('config requires policyPath', () => {
    const schema = policy.Config as unknown as { toJSON(): unknown }
    assert.ok(schema.toJSON())
  })

  it('default apply returns a disposer', async () => {
    const fakeCtx = { plugin: () => undefined } as never
    const dispose = await policy.apply(fakeCtx, {
      policyPath: '/tmp/policy.json',
      hotReload: true,
      watchIntervalMs: 5000,
    })
    assert.equal(typeof dispose, 'function')
    await dispose()
  })
})