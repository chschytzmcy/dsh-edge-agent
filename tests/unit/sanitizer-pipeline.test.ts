/**
 * sanitizer-pipeline plugin tests — verifies canonical shape and stub
 * pass-through behavior.
 */
import assert from 'node:assert/strict'
import { default as sanitizer } from '../../src/dsh-adapter/sanitizer-pipeline.ts'

describe('sanitizer-pipeline plugin', () => {
  it('exports the canonical plugin shape', () => {
    assert.equal(sanitizer.name, 'sanitizer-pipeline')
    assert.deepEqual([...sanitizer.inject], ['localStorage', 'privacyPolicy'])
    assert.equal(typeof sanitizer.apply, 'function')
    assert.equal(typeof sanitizer.Config, 'object')
  })

  it('config has maxReplacementsPerSession', () => {
    const schema = sanitizer.Config as unknown as { toJSON(): unknown }
    assert.ok(schema.toJSON())
  })

  it('default apply returns a disposer', async () => {
    const fakeCtx = { plugin: () => undefined } as never
    const dispose = await sanitizer.apply(fakeCtx, {
      enableAutoDetection: true,
      maxReplacementsPerSession: 1024,
    })
    assert.equal(typeof dispose, 'function')
    await dispose()
  })
})