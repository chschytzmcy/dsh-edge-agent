/**
 * edge-context-view (§7.101) — seam fold unit tests. The store is hit
 * directly (no fake cordis loop): panel routing, cursor semantics across
 * session/global buckets, PII re-scan, ring caps, TTL sweep, summary fold.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import * as edgeView from '../../src/dsh-adapter/edge-context-view.ts'
import {
  EdgeContextViewServiceImpl,
  panelForKind,
  safePayload,
} from '../../src/dsh-adapter/edge-context-view.ts'
import type { AuditEntry } from '../../src/dsh-adapter/audit-log.ts'

const CONFIG = { bufferSize: 4, sessionTtlMs: 1_800_000, piiRedact: true }

function makeService(config = CONFIG): EdgeContextViewServiceImpl {
  const fakeCtx = { reflect: { provide: () => {} } } as never
  return new EdgeContextViewServiceImpl(fakeCtx, config)
}

function entry(kind: string, payload: Record<string, unknown>, ts = Date.now()): AuditEntry {
  return { ts, level: 'info', kind, source: 'test', payload }
}

describe('edge-context-view plugin shape', () => {
  it('exports the canonical plugin shape', () => {
    assert.equal(edgeView.name, 'edge-context-view')
    assert.deepEqual([...edgeView.inject], ['auditLog'])
    assert.equal(typeof edgeView.apply, 'function')
    assert.ok(edgeView.Config)
  })

  it('registers the /api/dsh-edge/context route path', () => {
    assert.equal(edgeView.EDGE_CONTEXT_ROUTE, '/api/dsh-edge/context')
  })
})

describe('panelForKind routing', () => {
  it('routes the four panels from real audit kinds', () => {
    assert.equal(panelForKind('intent.classify.start'), 'intent')
    assert.equal(panelForKind('intent.classify.end'), 'intent')
    assert.equal(panelForKind('http.chat.route'), 'route')
    assert.equal(panelForKind('llm.cloud.delegate.resolved'), 'route')
    assert.equal(panelForKind('llm.local.start'), 'route')
    assert.equal(panelForKind('input-guard.sanitized'), 'interception')
    assert.equal(panelForKind('guard.model-detect.unsafe'), 'interception')
    assert.equal(panelForKind('sanitizer.sanitized'), 'interception')
    assert.equal(panelForKind('td-bus.escalated'), 'threat')
    assert.equal(panelForKind('http.chat.threat-blocked'), 'threat')
  })

  it('rate-limit kinds are threat signals, not interception rows', () => {
    assert.equal(panelForKind('input.rate-limit'), 'threat')
    assert.equal(panelForKind('input.global-rate-limit'), 'threat')
  })

  it('ignores kinds no panel renders', () => {
    assert.equal(panelForKind('http.chat.start'), undefined)
    assert.equal(panelForKind('session.cleanup'), undefined)
    assert.equal(panelForKind('input-guard.hook.registered'), undefined)
  })
})

describe('fold + snapshot', () => {
  it('records session-scoped and global rows; a snapshot merges both in order', () => {
    const svc = makeService()
    svc.record(entry('intent.classify.end', { sessionId: 's1', category: 'LOCAL', confidence: 0.8 }))
    svc.record(entry('td-bus.escalated', { from: 'normal', to: 'elevated' }))
    const snap = svc.snapshot('s1')
    const kinds = snap.rows.map(r => r.kind)
    assert.deepEqual(kinds, ['intent.classify.end', 'td-bus.escalated'])
    assert.equal(snap.rows[0].panel, 'intent')
    assert.equal(snap.rows[1].panel, 'threat')
    // Another session sees ONLY the global row.
    const other = svc.snapshot('s2')
    assert.deepEqual(other.rows.map(r => r.kind), ['td-bus.escalated'])
  })

  it('cursor advances monotonically and re-pull is incremental', () => {
    const svc = makeService()
    svc.record(entry('intent.classify.start', { sessionId: 's1', textLen: 5 }))
    const first = svc.snapshot('s1', 0)
    assert.equal(first.rows.length, 1)
    svc.record(entry('intent.classify.end', { sessionId: 's1', category: 'CLOUD' }))
    const second = svc.snapshot('s1', first.cursor)
    assert.equal(second.rows.length, 1)
    assert.equal(second.rows[0].kind, 'intent.classify.end')
    assert.ok(second.cursor > first.cursor)
    // No-op pull returns nothing new.
    const third = svc.snapshot('s1', second.cursor)
    assert.equal(third.rows.length, 0)
    assert.equal(third.cursor, second.cursor)
  })

  it('cross-bucket cursor never rewinds', () => {
    const svc = makeService()
    svc.record(entry('td-bus.escalated', { from: 'normal', to: 'high' }))   // global seq=1
    svc.record(entry('guard.rule.sanitized', { sessionId: 's1' }))          // session seq=2
    const snap = svc.snapshot('s1')
    assert.equal(snap.rows.length, 2)
    // s2 only ever saw the global row; its cursor must stay behind seq 2
    // without re-serving it after the pull past it.
    const s2a = svc.snapshot('s2', 0)
    assert.equal(s2a.rows.length, 1)
    const s2b = svc.snapshot('s2', s2a.cursor)
    assert.equal(s2b.rows.length, 0)
  })

  it('bufferSize caps rows per bucket, dropping oldest first', () => {
    const svc = makeService({ ...CONFIG, bufferSize: 3 })
    for (let i = 0; i < 5; i++) {
      svc.record(entry('intent.classify.end', { sessionId: 's1', category: 'LOCAL', n: i }))
    }
    const snap = svc.snapshot('s1', 0)
    assert.equal(snap.rows.length, 3)
    const ns = snap.rows.map(r => r.payload.n)
    assert.deepEqual(ns, [2, 3, 4])
  })

  it('unlisted kinds never enter the store', () => {
    const svc = makeService()
    svc.record(entry('http.chat.start', { sessionId: 's1' }))
    assert.equal(svc.snapshot('s1').rows.length, 0)
  })
})

describe('PII defense', () => {
  it('tokenizes the 5 PII classes inside payload strings before storage', () => {
    const svc = makeService()
    svc.record(entry('input-guard.sanitized', {
      sessionId: 's1',
      sample: 'call 13812345678 or mail a@b.com',
      key: 'sk-abcdefghijklmnopqrstuvwxyz123456',
    }))
    const row = svc.snapshot('s1').rows.find(r => r.kind === 'input-guard.sanitized')!
    const json = JSON.stringify(row.payload)
    assert.ok(!json.includes('13812345678'), 'phone must not survive')
    assert.ok(!json.includes('a@b.com'), 'email must not survive')
    assert.ok(!json.includes('sk-abcdefghijklmnopqrstuvwxyz123456'), 'api-key must not survive')
  })

  it('piiRedact=false keeps raw strings (operator opt-out)', () => {
    const svc = makeService({ ...CONFIG, piiRedact: false })
    svc.record(entry('input-guard.sanitized', { sessionId: 's1', sample: '13812345678' }))
    const row = svc.snapshot('s1').rows[0]
    assert.equal(row.payload.sample, '13812345678')
  })

  it('safePayload flattens ONE level of scalar objects; deeper values and arrays drop', () => {
    const out = safePayload({ keep: 1, flag: true, one: { a: 'x', b: 2, deep: { c: 3 } }, list: ['a'], s: 'plain' }, true)
    assert.deepEqual(Object.keys(out).sort(), ['flag', 'keep', 'one.a', 'one.b', 's'])
  })
})

describe('session summary fold', () => {
  it('counts turns and accumulates usage only when reported', () => {
    const svc = makeService()
    svc.recordSessionEvent('s1', 'turn/start', {})
    svc.recordSessionEvent('s1', 'turn/start', {})
    svc.recordSessionEvent('s1', 'assistant/message', { usage: { input: 100, output: 20 } })
    svc.recordSessionEvent('s1', 'assistant/message', { usage: { input: 50, output: 10, cacheRead: 7 } })
    const { summary } = svc.snapshot('s1')
    assert.equal(summary.turns, 2)
    assert.equal(typeof summary.turnStartTs, 'number') // global-row time window (§7.106)
    assert.deepEqual(summary.tokens, { input: 150, output: 30, cacheRead: 7 })
  })

  it('no usage → tokens stay undefined (never faked as 0)', () => {
    const svc = makeService()
    svc.recordSessionEvent('s1', 'turn/start', {})
    svc.recordSessionEvent('s1', 'assistant/message', {})
    const { summary } = svc.snapshot('s1')
    assert.equal(summary.tokens, undefined)
    assert.equal(summary.startedAt !== undefined, true)
  })

  it('untracked session reads an empty summary without creating rows', () => {
    const svc = makeService()
    const snap = svc.snapshot('ghost')
    assert.equal(snap.rows.length, 0)
    assert.equal(snap.summary.turns, 0)
  })

  it('§7.106 host TokenUsage names (inputTokens/...) accumulate; empty usage never fakes 0', () => {
    const svc = makeService()
    svc.recordSessionEvent('s1', 'assistant/message', { usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 5 } })
    assert.deepEqual(svc.snapshot('s1').summary.tokens, { input: 120, output: 30, cacheRead: 5 })
    const svc2 = makeService()
    svc2.recordSessionEvent('s2', 'assistant/message', { usage: {} })
    assert.equal(svc2.snapshot('s2').summary.tokens, undefined)
  })

  it('§7.106 rows carry the turn tag current at fold time; globals get -1', () => {
    const svc = makeService()
    // pre-turn audit row → turn 0
    svc.record({ ts: Date.now(), level: 'info', kind: 'intent.classify.start', source: 'intent-router', payload: { sessionId: 's9', textLen: 2 } })
    assert.equal(svc.snapshot('s9').rows[0].turn, 0)
    svc.recordSessionEvent('s9', 'turn/start', {})
    svc.record({ ts: Date.now(), level: 'info', kind: 'intent.classify.end', source: 'intent-router', payload: { sessionId: 's9', category: 'LOCAL' } })
    assert.equal(svc.snapshot('s9').rows.at(-1)?.turn, 1)
    // no session → global bucket → sentinel -1 (client always renders it)
    svc.record({ ts: Date.now(), level: 'warn', kind: 'input.global-rate-limit', source: 'td-bus', payload: { count: 42 } })
    assert.equal(svc.snapshot('s9').rows.find(r => r.kind === 'input.global-rate-limit')?.turn, -1)
  })

  it('§7.106 request/context folds the host answer route into the Route panel', () => {
    const svc = makeService()
    svc.recordSessionEvent('s3', 'request/context', { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    const row = svc.snapshot('s3').rows.find(r => r.kind === 'llm.host.route')
    assert.ok(row, 'host route row folded')
    assert.equal(row.panel, 'route')
    assert.equal(row.payload.provider, 'deepseek-official')
    assert.equal(row.payload.model, 'deepseek-v4-flash')
  })
})

describe('auditLog.onEntry wiring', () => {
  it('apply() arms the fold through onEntry and disposes cleanly', async () => {
    const listeners: Array<(e: AuditEntry) => void> = []
    const fakeCtx = {
      reflect: { provide: () => {} },
      auditLog: { onEntry: (l: (e: AuditEntry) => void) => { listeners.push(l); return () => { listeners.length = 0 } } },
      inject: (_deps: readonly string[], _cb: (c: unknown) => void) => {},
      on: () => () => {},
    } as never
    const dispose = await edgeView.apply(fakeCtx, CONFIG)
    assert.equal(listeners.length, 1)
    // Feed through the live seam, then read through the store.
    listeners[0]({ ts: 1, level: 'info', kind: 'intent.classify.end', source: 'intent-router', payload: { sessionId: 's1', category: 'LOCAL' } })
    dispose()
    assert.equal(listeners.length, 0)
  })

  it('AuditLogServiceImpl.onEntry fires and unsubscribes (integration of the seam)', async () => {
    const { AuditLogServiceImpl, apply: auditApply, Config: AuditConfig } = await import('../../src/dsh-adapter/audit-log.ts')
    const root = `/tmp/dsh-edge-test-audit-${process.pid}-${Date.now()}`
    const ctx = { reflect: { provide: () => {} }, logger: { error: () => {} } } as never
    const svc = new AuditLogServiceImpl(ctx, {
      minLevel: 'info', ringBufferSize: 8, flushIntervalMs: 10_000,
      filename: 'a.jsonl', root, enablePIIRedaction: true,
      maxFileSizeBytes: 0, maxFileAgeDays: 0, maxRotatedFiles: 0,
    } as never)
    void auditApply
    void AuditConfig
    const seen: AuditEntry[] = []
    const off = svc.onEntry(e => seen.push(e))
    await svc.log({ level: 'info', kind: 'intent.classify.end', source: 'x', payload: { sessionId: 's1' } })
    assert.equal(seen.length, 1)
    off()
    await svc.log({ level: 'info', kind: 'intent.classify.end', source: 'x', payload: { sessionId: 's2' } })
    assert.equal(seen.length, 1, 'unsubscribed listener must not fire')
    // A throwing listener must not break the log path.
    const off2 = svc.onEntry(() => { throw new Error('boom') })
    await svc.log({ level: 'info', kind: 'k', source: 'x', payload: {} })
    off2()
    svc.stopForTests()
  })
})
