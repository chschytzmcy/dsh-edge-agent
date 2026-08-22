/**
 * TCM plugin tests — verifies the canonical plugin shape and that the
 * stub services are wired correctly. Real TEE backends (TrustZone /
 * Keystone) are out of scope for the v0.1.0 scaffold.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import * as tcm from '../../src/dsh-adapter/tcm.ts'

describe('tcm plugin', () => {
  it('exports the canonical plugin shape', () => {
    assert.equal(tcm.name, 'tcm')
    assert.deepEqual(tcm.inject, [])
    assert.equal(typeof tcm.apply, 'function')
    assert.ok(tcm.Config)
  })

  it('config requires teeType and keyStorePath', () => {
    const schema = tcm.Config as unknown as { toJSON(): unknown }
    assert.ok(schema.toJSON())
  })

  it('default apply returns a disposer', async () => {
    const fakeCtx = { plugin: () => undefined } as never
    const dispose = await tcm.apply(fakeCtx, {
      teeType: 'simulated',
      keyStorePath: '/tmp/keys',
      teeInference: false,
      secureMemoryLimit: 64 * 1024 * 1024,
    })
    assert.equal(typeof dispose, 'function')
    await dispose()
  })
})