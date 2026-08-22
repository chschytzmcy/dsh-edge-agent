/**
 * prompt-guard plugin tests — verifies canonical shape and stub verdict.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import * as guard from '../../src/dsh-adapter/prompt-guard.ts'

describe('prompt-guard plugin', () => {
  it('exports the canonical plugin shape', () => {
    assert.equal(guard.name, 'prompt-guard')
    assert.deepEqual([...guard.inject], ['tcm', 'privacyPolicy', 'auditLog'])
    assert.equal(typeof guard.apply, 'function')
    assert.ok(guard.Config)
  })

  it('default apply returns a disposer', async () => {
    const fakeCtx = { plugin: () => undefined } as never
    const dispose = await guard.apply(fakeCtx, {
      rules: [],
      enableModelDetection: false,
    })
    assert.equal(typeof dispose, 'function')
    await dispose()
  })
})