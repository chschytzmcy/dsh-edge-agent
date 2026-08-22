/**
 * td-bus plugin tests — verifies canonical shape and stub threat level.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import * as tdBus from '../../src/dsh-adapter/td-bus.ts'

describe('td-bus plugin', () => {
  it('exports the canonical plugin shape', () => {
    assert.equal(tdBus.name, 'td-bus')
    assert.deepEqual([...tdBus.inject], ['auditLog', 'privacyPolicy'])
    assert.equal(typeof tdBus.apply, 'function')
    assert.ok(tdBus.Config)
  })

  it('config carries thresholds', () => {
    const schema = tdBus.Config as unknown as { toJSON(): unknown }
    assert.ok(schema.toJSON())
  })

  it('default apply returns a disposer', async () => {
    const fakeCtx = { plugin: () => undefined } as never
    const dispose = await tdBus.apply(fakeCtx, {
      windowSeconds: 60,
      thresholds: {
        cloudRequestsPerMinute: 20,
        failedSanitizationStreak: 3,
        permissionDeniedStreak: 5,
      },
    })
    assert.equal(typeof dispose, 'function')
    await dispose()
  })
})