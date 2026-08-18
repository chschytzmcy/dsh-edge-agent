/**
 * local-tools plugin tests — M2 pure helpers:
 *   - assertUnderAllowList (path gating)
 *   - evaluateExpression (pure-math evaluator)
 *
 * The actual upstream `ctx.tools.register()` flow is exercised in the
 * M2 manual smoke (scripts/m2-smoke.ts) because it requires a full Cordis
 * Loader boot — out of scope for the unit layer.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

import * as localTools from '../../src/dsh-adapter/local-tools.ts'
import {
  assertUnderAllowList,
  evaluateExpression,
} from '../../src/dsh-adapter/local-tools.ts'

describe('local-tools (M2)', () => {
  it('exports the canonical plugin shape', () => {
    assert.equal(localTools.name, 'local-tools')
    assert.deepEqual([...localTools.inject], ['edgeTools'])
    assert.equal(typeof localTools.apply, 'function')
    assert.ok(localTools.Config)
  })

  it('assertUnderAllowList accepts a path under any prefix', () => {
    assert.equal(
      assertUnderAllowList('/tmp/test.txt', ['/tmp']),
      '/tmp/test.txt',
    )
    assert.equal(
      assertUnderAllowList('/var/log/x.log', ['/tmp', '/var']),
      '/var/log/x.log',
    )
  })

  it('assertUnderAllowList rejects paths outside the allowlist', () => {
    assert.throws(
      () => assertUnderAllowList('/etc/passwd', ['/tmp']),
      /not under any allowList/u,
    )
  })

  it('assertUnderAllowList rejects an empty allowlist', () => {
    assert.throws(
      () => assertUnderAllowList('/tmp/test.txt', []),
      /allowList is empty/u,
    )
  })

  it('assertUnderAllowList treats exact-prefix matches as ok', () => {
    assert.equal(
      assertUnderAllowList('/tmp', ['/tmp']),
      '/tmp',
    )
  })

  it('evaluateExpression evaluates simple arithmetic', () => {
    assert.equal(evaluateExpression('1 + 2'), 3)
    assert.equal(evaluateExpression('10 - 4'), 6)
    assert.equal(evaluateExpression('6 * 7'), 42)
    assert.equal(evaluateExpression('8 / 2'), 4)
  })

  it('evaluateExpression respects precedence and parens', () => {
    assert.equal(evaluateExpression('2 + 3 * 4'), 14)
    assert.equal(evaluateExpression('(2 + 3) * 4'), 20)
    assert.equal(evaluateExpression('10 - 2 * 3'), 4)
  })

  it('evaluateExpression tolerates commas (returns last value)', () => {
    assert.equal(evaluateExpression('1 + 2, 3 * 4'), 12)
  })

  it('evaluateExpression rejects non-math input', () => {
    assert.throws(
      () => evaluateExpression('alert("x")'),
      /refused non-math/u,
    )
    assert.throws(
      () => evaluateExpression('1 + abc'),
      /refused non-math/u,
    )
  })

  it('evaluateExpression rejects division by zero', () => {
    assert.throws(
      () => evaluateExpression('1 / 0'),
      /division by zero/u,
    )
  })

  it('evaluateExpression handles nested parens and decimals', () => {
    assert.equal(evaluateExpression('(1.5 + 2.5) * 2'), 8)
    assert.equal(evaluateExpression('((1 + 2) * (3 + 4))'), 21)
  })
})