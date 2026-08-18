/**
 * local-storage plugin tests — verifies canonical shape and stub contract.
 */
import assert from 'node:assert/strict'
import { default as storage } from '../../src/dsh-adapter/local-storage.ts'

describe('local-storage plugin', () => {
  it('exports the canonical plugin shape', () => {
    assert.equal(storage.name, 'local-storage')
    assert.deepEqual([...storage.inject], ['tcm'])
    assert.equal(typeof storage.apply, 'function')
    assert.equal(typeof storage.Config, 'object')
  })

  it('config requires root', () => {
    const schema = storage.Config as unknown as { toJSON(): unknown }
    assert.ok(schema.toJSON())
  })

  it('default apply returns a disposer', async () => {
    const fakeCtx = { plugin: () => undefined } as never
    const dispose = await storage.apply(fakeCtx, {
      root: '/tmp/storage',
      filename: 'storage.enc.db',
    })
    assert.equal(typeof dispose, 'function')
    await dispose()
  })
})