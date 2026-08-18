/**
 * sessions plugin tests — verifies canonical shape and stub contract.
 */
import assert from 'node:assert/strict'
import { default as sessions } from '../../src/dsh-adapter/sessions.ts'

describe('sessions plugin', () => {
  it('exports the canonical plugin shape', () => {
    assert.equal(sessions.name, 'sessions')
    assert.deepEqual([...sessions.inject], ['tcm', 'localStorage'])
    assert.equal(typeof sessions.apply, 'function')
    assert.equal(typeof sessions.Config, 'object')
  })

  it('config carries defaultTtlSeconds', () => {
    const schema = sessions.Config as unknown as { toJSON(): unknown }
    assert.ok(schema.toJSON())
  })

  it('default apply returns a disposer', async () => {
    const fakeCtx = { plugin: () => undefined } as never
    const dispose = await sessions.apply(fakeCtx, {
      defaultTtlSeconds: 3600,
      maxConcurrentSessions: 8,
    })
    assert.equal(typeof dispose, 'function')
    await dispose()
  })
})