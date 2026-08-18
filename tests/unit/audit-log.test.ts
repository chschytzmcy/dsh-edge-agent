/**
 * audit-log plugin tests — verifies canonical shape and stub contract.
 */
import assert from 'node:assert/strict'
import { default as auditLog } from '../../src/dsh-adapter/audit-log.ts'

describe('audit-log plugin', () => {
  it('exports the canonical plugin shape', () => {
    assert.equal(auditLog.name, 'audit-log')
    assert.deepEqual([...auditLog.inject], ['tcm', 'localStorage'])
    assert.equal(typeof auditLog.apply, 'function')
    assert.equal(typeof auditLog.Config, 'object')
  })

  it('config carries alert thresholds', () => {
    const schema = auditLog.Config as unknown as { toJSON(): unknown }
    assert.ok(schema.toJSON())
  })

  it('default apply returns a disposer', async () => {
    const fakeCtx = { plugin: () => undefined } as never
    const dispose = await auditLog.apply(fakeCtx, {
      minLevel: 'info',
      sensitiveFields: [],
      enableAlerts: true,
      alertThresholds: {
        cloudRequestsPerMinute: 20,
        sanitizationFailures: 3,
        permissionDenied: 5,
      },
      flushIntervalMs: 500,
    })
    assert.equal(typeof dispose, 'function')
    await dispose()
  })
})