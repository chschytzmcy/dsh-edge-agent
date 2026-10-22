/**
 * §7.106 selection-restore decision — the pure predicate behind the
 * turn/end listener that re-installs the user's model selection after an
 * input-guard downgrade rewrote the turn to local-llm (the host persists
 * the effective request header as "current model", leaving the picker
 * stale — displayed as `local-llm` before Option A hid the route, blank
 * after).
 */
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { selectionRestoreTarget } from '../../src/dsh-adapter/input-guard.ts'

type State = Parameters<typeof selectionRestoreTarget>[0]

function state(over: Partial<NonNullable<State>> = {}): NonNullable<State> {
  return {
    sanitized: false, replacements: 0, sessionId: 's', timestamp: 1,
    downgraded: true, downgradeReason: 'intent-local',
    originalProvider: 'qwen-token-plan-cn', originalModel: 'deepseek-v4-flash-0731',
    ...over,
  } as NonNullable<State>
}

describe('§7.106 selectionRestoreTarget', () => {
  const LOCAL = 'local-llm'
  it('downgraded turn with a foreign original route → restore target', () => {
    assert.deepEqual(selectionRestoreTarget(state(), LOCAL), {
      provider: 'qwen-token-plan-cn', model: 'deepseek-v4-flash-0731',
    })
  })
  it('no state / not downgraded → nothing to restore', () => {
    assert.equal(selectionRestoreTarget(undefined, LOCAL), undefined)
    assert.equal(selectionRestoreTarget(state({ downgraded: false }), LOCAL), undefined)
  })
  it('original already local → skip (never re-pollute the picker)', () => {
    assert.equal(selectionRestoreTarget(state({ originalProvider: LOCAL }), LOCAL), undefined)
  })
  it('missing/empty provider or model → skip', () => {
    assert.equal(selectionRestoreTarget(state({ originalProvider: '' }), LOCAL), undefined)
    assert.equal(selectionRestoreTarget(state({ originalModel: undefined }), LOCAL), undefined)
    assert.equal(selectionRestoreTarget(state({ originalModel: '' }), LOCAL), undefined)
  })
})
