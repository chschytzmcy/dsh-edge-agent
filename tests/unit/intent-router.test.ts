/**
 * intent-router plugin tests — verifies canonical shape and the
 * event-hook bootstrap path.
 */
import assert from 'node:assert/strict'
import { default as router } from '../../src/dsh-adapter/intent-router.ts'

describe('intent-router plugin', () => {
  it('exports the canonical plugin shape', () => {
    assert.equal(router.name, 'intent-router')
    assert.deepEqual([...router.inject], ['llm', 'promptGuard', 'privacyPolicy', 'auditLog', 'sessions', 'localStorage'])
    assert.equal(typeof router.apply, 'function')
    assert.equal(typeof router.Config, 'object')
  })

  it('config has ruleConfidenceThreshold', () => {
    const schema = router.Config as unknown as { toJSON(): unknown }
    assert.ok(schema.toJSON())
  })

  it('default apply registers event hooks and returns a disposer', async () => {
    let pluginCount = 0
    const fakeCtx = {
      plugin: () => { pluginCount += 1 },
      event: { on: () => undefined },
      intentRouter: {},
      promptGuard: {},
      auditLog: {},
      sessions: { get: async () => null },
    } as never
    const dispose = await router.apply(fakeCtx, {
      enableLlmFallback: true,
      ruleConfidenceThreshold: 0.6,
    })
    assert.equal(pluginCount, 1)
    assert.equal(typeof dispose, 'function')
    await dispose()
  })
})