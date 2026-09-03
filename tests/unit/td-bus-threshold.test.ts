/**
 * td-bus threshold verification — pins the production-config escalation
 * matrix (cloudRequestsPerMinute=8, blockLevel='critical') and verifies
 * the `td-bus.escalated` audit-log payload contract.
 *
 * Why a separate file from td-bus.test.ts:
 *   The existing suite sweeps the state machine generically (threshold=5
 *   or 20). It does NOT pin the runtime config (8) nor verify the
 *   audit-event payload that operators actually see in /v1/audit. This
 *   file pins BOTH so future schema/config drift breaks loudly here
 *   rather than only at runtime.
 */
import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'vitest'
import { TdBusServiceImpl } from '../../src/dsh-adapter/td-bus.ts'

// Mirror the runtime config in repo-root cordis.patch.yml (td-bus block).
// Per §7.25 the bundle's manifest lives at the repo root, not in the
// profile overlay (`profiles/dsh-edge-agent/cordis.patch.yml` is now
// `[]`). If the patch changes, update the literal below AND
// patch-surface.snapshot.json — both must stay in sync.
const PROD_CONFIG = {
  windowSeconds: 60,
  thresholds: {
    cloudRequestsPerMinute: 8,
    failedSanitizationStreak: 3,
    permissionDeniedStreak: 5,
  },
  blockLevel: 'critical' as const,
}

interface AuditCall {
  level: string
  kind: string
  source: string
  payload: Record<string, unknown>
}

function makeHarness() {
  const calls: AuditCall[] = []
  const ctx = {
    reflect: { provide: () => {} },
    auditLog: {
      log: async (entry: AuditCall) => { calls.push(entry) },
    },
  }
  const svc = new TdBusServiceImpl(ctx as any, PROD_CONFIG)
  return { svc, calls }
}

describe('td-bus threshold (production config: cloudRequestsPerMinute=8, blockLevel=critical)', () => {
  let harness: ReturnType<typeof makeHarness>
  beforeEach(() => {
    harness = makeHarness()
  })

  // ─── Boundary matrix ──────────────────────────────────────────────────

  it('0 hits → normal, no block, no audit event', () => {
    const { svc, calls } = harness
    assert.equal(svc.getThreatLevel(), 'normal')
    assert.equal(svc.shouldBlock(), false)
    assert.equal(calls.length, 0, 'no escalation expected when below threshold')
  })

  it('7 hits (n-1) stays normal — no premature escalation', () => {
    const { svc, calls } = harness
    for (let i = 0; i < 7; i++) svc.recordCloudRequest()
    assert.equal(svc.getThreatLevel(), 'normal')
    assert.equal(svc.shouldBlock(), false)
    assert.equal(calls.length, 0)
  })

  it('8 hits hits the elevated threshold (× 1)', () => {
    const { svc, calls } = harness
    for (let i = 0; i < 8; i++) svc.recordCloudRequest()
    assert.equal(svc.getThreatLevel(), 'elevated')
    // blockLevel=critical → elevated does NOT block yet.
    assert.equal(svc.shouldBlock(), false)
  })

  it('15 hits (n-1 of high tier) stays elevated — no premature jump', () => {
    const { svc } = harness
    for (let i = 0; i < 15; i++) svc.recordCloudRequest()
    assert.equal(svc.getThreatLevel(), 'elevated')
    assert.equal(svc.shouldBlock(), false)
  })

  it('16 hits hits the high threshold (× 2)', () => {
    const { svc, calls } = harness
    for (let i = 0; i < 16; i++) svc.recordCloudRequest()
    assert.equal(svc.getThreatLevel(), 'high')
    assert.equal(svc.shouldBlock(), false)
  })

  it('31 hits (n-1 of critical tier) stays high — no premature jump', () => {
    const { svc } = harness
    for (let i = 0; i < 31; i++) svc.recordCloudRequest()
    assert.equal(svc.getThreatLevel(), 'high')
    assert.equal(svc.shouldBlock(), false)
  })

  it('32 hits hits the critical threshold (× 4) — and blocks', () => {
    const { svc, calls } = harness
    for (let i = 0; i < 32; i++) svc.recordCloudRequest()
    assert.equal(svc.getThreatLevel(), 'critical')
    assert.equal(svc.shouldBlock(), true, 'blockLevel=critical → shouldBlock() at critical')
    // 3 transitions observed: normal→elevated (at 8), elevated→high (at 16),
    // high→critical (at 32). All three emit one td-bus.escalated each.
    assert.equal(calls.length, 3)
  })

  // ─── Audit payload contract ────────────────────────────────────────────

  it('emits td-bus.escalated with correct from/to/count/threshold payload at each transition', () => {
    const { svc, calls } = harness
    for (let i = 0; i < 32; i++) svc.recordCloudRequest()

    // Exactly 3 escalation events.
    assert.equal(calls.length, 3)

    // Transition 1: normal → elevated at count=8.
    assert.equal(calls[0]!.kind, 'td-bus.escalated')
    assert.equal(calls[0]!.source, 'td-bus')
    assert.equal(calls[0]!.level, 'warn', 'non-critical escalations are warn level')
    assert.deepEqual(calls[0]!.payload, {
      from: 'normal',
      to: 'elevated',
      count: 8,
      threshold: 8,
    })

    // Transition 2: elevated → high at count=16.
    assert.deepEqual(calls[1]!.payload, {
      from: 'elevated',
      to: 'high',
      count: 16,
      threshold: 8,
    })

    // Transition 3: high → critical at count=32 — escalated to security.
    assert.equal(calls[2]!.level, 'security', 'critical escalation bumps level to security')
    assert.deepEqual(calls[2]!.payload, {
      from: 'high',
      to: 'critical',
      count: 32,
      threshold: 8,
    })
  })

  it('steady-state traffic at same level does NOT re-emit audit events', () => {
    const { svc, calls } = harness
    // Drive into elevated (8 hits = 1 escalation), then add 4 more —
    // level stays 'elevated', no new audit event should fire.
    for (let i = 0; i < 12; i++) svc.recordCloudRequest()
    assert.equal(svc.getThreatLevel(), 'elevated')
    assert.equal(calls.length, 1, 'only the one transition emitted an event')
  })

  it('manual escalate() emits a td-bus.escalated with reason payload (sticky to critical)', () => {
    const { svc, calls } = harness
    svc.escalate('manual-test: privacy policy tampered')
    assert.equal(svc.getThreatLevel(), 'critical')
    assert.equal(svc.shouldBlock(), true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.kind, 'td-bus.escalated')
    assert.equal(calls[0]!.level, 'security')
    assert.deepEqual(calls[0]!.payload, {
      from: 'normal',
      to: 'critical',
      reason: 'manual-test: privacy policy tampered',
    })
  })

  // ─── Sliding-window decay (pins that the runtime 60s window works) ─────

  it('sliding window decay drops level back when old hits expire', async () => {
    // Use a tiny window so we can observe decay in unit-test time.
    const ctx = {
      reflect: { provide: () => {} },
      auditLog: { log: async () => {} },
    }
    const svc = new TdBusServiceImpl(ctx as any, {
      windowSeconds: 1,
      thresholds: {
        cloudRequestsPerMinute: 4,
        failedSanitizationStreak: 3,
        permissionDeniedStreak: 5,
      },
      blockLevel: 'critical',
    })

    // 16 hits at threshold=4 → critical (× 4).
    for (let i = 0; i < 16; i++) svc.recordCloudRequest()
    assert.equal(svc.getThreatLevel(), 'critical')

    // Wait > windowMs so all hits decay.
    await new Promise<void>((resolve) => setTimeout(resolve, 1100))
    assert.equal(svc.getThreatLevel(), 'normal')
    assert.equal(svc.shouldBlock(), false)
  })

  it('handles burst-then-quiet pattern: spikes then decays', async () => {
    const ctx = {
      reflect: { provide: () => {} },
      auditLog: { log: async () => {} },
    }
    const svc = new TdBusServiceImpl(ctx as any, {
      windowSeconds: 1,
      thresholds: {
        cloudRequestsPerMinute: 4,
        failedSanitizationStreak: 3,
        permissionDeniedStreak: 5,
      },
      blockLevel: 'critical',
    })

    // Burst: 8 hits at threshold=4 → high.
    for (let i = 0; i < 8; i++) svc.recordCloudRequest()
    assert.equal(svc.getThreatLevel(), 'high')

    // Decay.
    await new Promise<void>((resolve) => setTimeout(resolve, 1100))
    assert.equal(svc.getThreatLevel(), 'normal')

    // Second burst → escalates again (proves decay really cleared state).
    for (let i = 0; i < 16; i++) svc.recordCloudRequest()
    assert.equal(svc.getThreatLevel(), 'critical')
  })
})
