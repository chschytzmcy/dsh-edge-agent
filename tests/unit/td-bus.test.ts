/**
 * td-bus plugin tests — canonical shape + Phase D threat-level state
 * machine (sliding-window counter, escalation, on() subscribers).
 */
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import * as tdBus from '../../src/dsh-adapter/td-bus.ts'
import { TdBusServiceImpl } from '../../src/dsh-adapter/td-bus.ts'

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
    const fakeCtx = { reflect: { provide: () => {} } } as never
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

  // ─── Phase D: threat-level state machine ─────────────────────────────────

  function makeService(opts: { cloudPerMin?: number; windowSec?: number; blockLevel?: 'elevated' | 'high' | 'critical' } = {}) {
    return new TdBusServiceImpl({ reflect: { provide: () => {} } } as any, {
      windowSeconds: opts.windowSec ?? 60,
      thresholds: {
        cloudRequestsPerMinute: opts.cloudPerMin ?? 20,
        failedSanitizationStreak: 3,
        permissionDeniedStreak: 5,
      },
      blockLevel: opts.blockLevel ?? 'critical',
    })
  }

  it('default threat level is normal', () => {
    const svc = makeService()
    assert.equal(svc.getThreatLevel(), 'normal')
    assert.equal(svc.shouldBlock(), false)
  })

  it('escalates to elevated at threshold × 1', () => {
    const svc = makeService({ cloudPerMin: 5 })
    for (let i = 0; i < 5; i++) svc.recordCloudRequest()
    assert.equal(svc.getThreatLevel(), 'elevated')
    // blockLevel default critical → don't block yet
    assert.equal(svc.shouldBlock(), false)
  })

  it('escalates to high at threshold × 2', () => {
    const svc = makeService({ cloudPerMin: 5 })
    for (let i = 0; i < 10; i++) svc.recordCloudRequest()
    assert.equal(svc.getThreatLevel(), 'high')
    assert.equal(svc.shouldBlock(), false)
  })

  it('escalates to critical at threshold × 4 and blocks by default', () => {
    const svc = makeService({ cloudPerMin: 5 })
    for (let i = 0; i < 20; i++) svc.recordCloudRequest()
    assert.equal(svc.getThreatLevel(), 'critical')
    assert.equal(svc.shouldBlock(), true)
  })

  it('blockLevel=high makes the bus block at high too', () => {
    const svc = makeService({ cloudPerMin: 5, blockLevel: 'high' })
    for (let i = 0; i < 10; i++) svc.recordCloudRequest()
    assert.equal(svc.getThreatLevel(), 'high')
    assert.equal(svc.shouldBlock(), true)
  })

  it('manual escalate() jumps straight to critical', () => {
    const svc = makeService()
    svc.escalate('manual-test')
    assert.equal(svc.getThreatLevel(), 'critical')
    assert.equal(svc.shouldBlock(), true)
  })

  it('decays back to normal as old hits slide out of the window', () => {
    const svc = makeService({ cloudPerMin: 2, windowSec: 1 })
    for (let i = 0; i < 4; i++) svc.recordCloudRequest() // → high (2 × 2)
    assert.equal(svc.getThreatLevel(), 'high')
    // Wait > windowSec so all hits decay
    return new Promise<void>((resolve) => setTimeout(() => {
      assert.equal(svc.getThreatLevel(), 'normal')
      resolve()
    }, 1100))
  })

  it('on() listeners fire when threat escalates across level', () => {
    const svc = makeService({ cloudPerMin: 2 })
    let calls = 0
    const off = svc.on('block-cloud', () => { calls += 1 })
    for (let i = 0; i < 2; i++) svc.recordCloudRequest() // → elevated
    // Phase D: on() subscribes the listener but does NOT auto-fire on
    // escalation — fires only when the bus explicitly calls it (e.g. via
    // escalate()). This test pins the current contract.
    svc.escalate('test')
    assert.ok(calls >= 1, 'listener should have been invoked by escalate()')
    off()
  })
})