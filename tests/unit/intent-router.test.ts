/**
 * intent-router plugin tests — M1 minimal: default-category routing.
 *
 * A2 will expand this surface (rules + LLM fallback + prompt-guard
 * listener); M1 only checks the canonical shape and the
 * default-to-CLOUD behaviour.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

import * as router from '../../src/dsh-adapter/intent-router.ts'
import { classifyDefault } from '../../src/dsh-adapter/intent-router.ts'

describe('intent-router (M1)', () => {
  it('exports the canonical plugin shape', () => {
    assert.equal(router.name, 'intent-router')
    assert.deepEqual([...router.inject], [])
    assert.equal(typeof router.apply, 'function')
    assert.ok(router.Config)
  })

  it('defaults to the CLOUD realm in M1', async () => {
    const intent = await classifyDefault('CLOUD', '你好')
    assert.equal(intent.category, 'CLOUD')
    assert.equal(intent.confidence, 1)
    assert.equal(intent.targetRealm, 'cloud')
    assert.match(intent.rationale, /m1-default:cloud/u)
  })

  it('honors a configured default category of LOCAL', async () => {
    const intent = await classifyDefault('LOCAL', 'list files')
    assert.equal(intent.category, 'LOCAL')
    assert.equal(intent.targetRealm, 'local')
    assert.match(intent.rationale, /m1-default:local/u)
  })

  it('marks requiresSanitization=false (M1 has no sanitization layer)', async () => {
    const intent = await classifyDefault('CLOUD', 'what is the weather')
    assert.equal(intent.requiresSanitization, false)
  })
})