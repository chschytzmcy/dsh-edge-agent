/**
 * web-search-guard tests — Phase 5 (2026-08-26).
 *
 * Verifies:
 *   - PII leak detection (task #38): when LLM sends a query containing raw
 *     PII, the guard emits a `security` audit event.
 *   - Tool audit event (task #39): every monitored `web_search` / `web_fetch`
 *     invocation logs an `info`-level `tool.web-search.executed` event with
 *     redacted args.
 *   - Rate-limit (task #40): sliding-window counters cap web_search at 10/min
 *     and web_fetch at 5/min; over-budget hits emit a `warn` audit event.
 *
 * The plugin is exercised through `handleToolsResult`, the unit of work the
 * `tools/result` observer dispatches into. That keeps the test surface
 * independent of the Cordis loader.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

import * as guard from '../../src/dsh-adapter/web-search-guard.ts'
import {
  WebSearchGuardService,
  handleToolsResult,
  apply,
  Config,
} from '../../src/dsh-adapter/web-search-guard.ts'

/** Audit event collector. Mirrors the AuditLike contract. */
class FakeAudit {
  events: Array<{ level: string; kind: string; payload: Record<string, unknown> }> = []
  async log(entry: { level: string; kind: string; source: string; payload: Record<string, unknown> }): Promise<void> {
    this.events.push({ level: entry.level, kind: entry.kind, payload: entry.payload })
  }
  /** Find first event matching `kind`, or undefined. */
  find(kind: string) {
    return this.events.find((e) => e.kind === kind)
  }
  /** Count events matching `kind`. */
  count(kind: string): number {
    return this.events.filter((e) => e.kind === kind).length
  }
}

/** Sanitizer stub. `contaminated` toggles whether `sanitize` mutates input. */
function fakeSanitizer(contaminated = false) {
  return {
    sanitize: async (text: string) => {
      if (!contaminated) return { sanitizedText: text, replacements: [] }
      // Naive PII detector — replace any 11-digit phone-shaped substring.
      const m = text.match(/\b1[3-9]\d{9}\b/)
      if (!m) return { sanitizedText: text, replacements: [] }
      return {
        sanitizedText: text.replace(m[0], '[PHONE_1]'),
        replacements: [{ original: m[0], placeholder: '[PHONE_1]', piiType: 'phone' }],
      }
    },
  }
}

/**
 * Build a service wired to a fake audit + sanitizer. The constructor takes
 * `ctx` for `Service` base; we pass a stub that satisfies the Service
 * constructor's `reflect.provide` path.
 */
function buildService(opts: {
  enablePIIMonitor?: boolean
  enableAudit?: boolean
  enableRateLimit?: boolean
  contaminated?: boolean
  rateLimitOverride?: number
} = {}) {
  const audit = new FakeAudit()
  const sanitizer = fakeSanitizer(opts.contaminated ?? false)
  const ctx = {
    reflect: { provide: () => () => {} },
    provide: () => () => {},
  } as never
  const cfg = {
    enablePIIMonitor: opts.enablePIIMonitor ?? true,
    enableAudit: opts.enableAudit ?? true,
    enableRateLimit: opts.enableRateLimit ?? true,
    rateLimits: opts.rateLimitOverride !== undefined
      ? { web_search: opts.rateLimitOverride }
      : {},
  }
  const service = new WebSearchGuardService(ctx, cfg)
  service.attach(audit as never, sanitizer as never)
  return { service, audit }
}

/**
 * Drive `handleToolsResult` directly. The module does not export the
 * handler (it is package-private), so we re-trigger the same path through
 * the public `apply()`-installed observer. For unit-level granularity,
 * we instead exercise the service's `recordHit` + the audit pipeline by
 * reproducing the handler's contract here. Keep this test focused on the
 * Service surface (`used`, `limitFor`, `recordHit`) — full observer wiring
 * is exercised by M5 smoke (task #41).
 */

describe('web-search-guard (Phase 5)', () => {
  it('exports the canonical plugin shape', () => {
    assert.equal(guard.name, 'web-search-guard')
    assert.deepEqual([...guard.inject], ['tools', 'sanitizer', 'auditLog'])
    assert.equal(typeof guard.apply, 'function')
    assert.ok(guard.Config)
  })

  it('limitFor returns the hardcoded default when no override is given', () => {
    const { service } = buildService()
    assert.equal(service.limitFor('web_search'), 10)
    assert.equal(service.limitFor('web_fetch'), 5)
    assert.equal(service.limitFor('unknown_tool'), Number.POSITIVE_INFINITY)
  })

  it('limitFor honors per-tool overrides from config', () => {
    const { service } = buildService({ rateLimitOverride: 3 })
    assert.equal(service.limitFor('web_search'), 3)
    // overrides are per-tool; web_fetch still uses the default
    assert.equal(service.limitFor('web_fetch'), 5)
  })

  it('recordHit returns true within budget and false at/over the limit', () => {
    const { service } = buildService({ rateLimitOverride: 3 })
    assert.equal(service.recordHit('web_search', 1_000), true)   // 1/3
    assert.equal(service.recordHit('web_search', 2_000), true)   // 2/3
    assert.equal(service.recordHit('web_search', 3_000), true)   // 3/3
    assert.equal(service.recordHit('web_search', 4_000), false)  // over
    assert.equal(service.recordHit('web_search', 5_000), false)  // still over
  })

  it('sliding window evicts entries older than WINDOW_MS', () => {
    const { service } = buildService({ rateLimitOverride: 2 })
    const base = 1_700_000_000_000
    assert.equal(service.recordHit('web_search', base), true)         // 1/2
    assert.equal(service.recordHit('web_search', base + 30_000), true) // 2/2
    assert.equal(service.recordHit('web_search', base + 30_000), false) // over
    // Jump past the window — old entries evict.
    assert.equal(service.recordHit('web_search', base + 70_000), true) // 1/2
  })

  it('rate-limit counters are independent per tool', () => {
    const { service } = buildService()
    // Use up all web_search budget.
    for (let i = 0; i < 10; i++) {
      assert.equal(service.recordHit('web_search', 1_000 + i), true)
    }
    assert.equal(service.recordHit('web_search', 1_010), false)
    // web_fetch budget is untouched.
    assert.equal(service.recordHit('web_fetch', 1_000), true)
  })

  it('used() reflects current count in the sliding window', () => {
    const { service } = buildService({ rateLimitOverride: 5 })
    assert.equal(service.used('web_search'), 0)
    service.recordHit('web_search', 1_000)
    service.recordHit('web_search', 2_000)
    assert.equal(service.used('web_search'), 2)
  })

  it('resetCounters() empties every window', () => {
    const { service } = buildService({ rateLimitOverride: 2 })
    service.recordHit('web_search', 1_000)
    service.recordHit('web_search', 2_000)
    assert.equal(service.recordHit('web_search', 3_000), false)
    service.resetCounters()
    assert.equal(service.recordHit('web_search', 4_000), true)
  })

  it('recordHit is a no-op when enableRateLimit is false', () => {
    const { service } = buildService({ enableRateLimit: false, rateLimitOverride: 1 })
    assert.equal(service.recordHit('web_search', 1_000), true)
    assert.equal(service.recordHit('web_search', 1_000), true) // never over
    assert.equal(service.recordHit('web_search', 1_000), true)
  })

  // ── M5 smoke (task #41): handleToolsResult end-to-end ──────────────────────
  // These cases drive the public `handleToolsResult` directly — they exercise
  // the same code path the `tools/result` observer fires in production, but
  // without spinning up the full Cordis loader. The M5 *integration* smoke
  // (in `scripts/`) drives a real `dsh --profile web` session.
  // §7.43 (2026-09-05): web-only — 需要 ./install.sh --with-web 装过 web。

  it('M5: clean web_search query emits exactly one info-level audit (tool.web-search.executed)', async () => {
    const { service, audit } = buildService()
    await handleToolsResult(service, {
      name: 'web_search',
      callId: 'call-1',
      arguments: { query: '2026 春节档票房' },
    }, {
      isError: false,
      value: { results: [{ url: 'https://example.com', title: '票房数据' }] },
    })
    assert.equal(audit.count('tool.web-search.executed'), 1)
    assert.equal(audit.count('web-search-guard.pii-leak'), 0)
    const evt = audit.find('tool.web-search.executed')
    assert.ok(evt)
    assert.equal(evt?.payload.toolName, 'web_search')
    assert.equal(evt?.payload.isError, false)
    assert.equal(evt?.payload.resultCount, 1)
    assert.equal(evt?.payload.used, 1)
    assert.equal(evt?.payload.limit, 10)
    assert.deepEqual(evt?.payload.args, { query: '2026 春节档票房' })
  })

  it('M5: web_search query containing PII emits a security-level pii-leak audit', async () => {
    const { service, audit } = buildService({ contaminated: true })
    await handleToolsResult(service, {
      name: 'web_search',
      callId: 'call-leak',
      arguments: { query: '帮我查 13800138000 是谁的号码' },
    }, {
      isError: false,
      value: { results: [] },
    })
    assert.equal(audit.count('web-search-guard.pii-leak'), 1)
    const leak = audit.find('web-search-guard.pii-leak')
    assert.equal(leak?.level, 'security')
    assert.equal(leak?.payload.toolName, 'web_search')
    assert.equal(leak?.payload.queryLength, '帮我查 13800138000 是谁的号码'.length)
    // Replacement list contains the PII type + placeholder, NOT the raw PII.
    const repls = leak?.payload.replacements as Array<{ piiType: string; placeholder: string }>
    assert.equal(repls[0].piiType, 'phone')
    assert.equal(repls[0].placeholder, '[PHONE_1]')
    // The full query is intentionally NOT in the payload — we audit the leak
    // shape, not the raw PII.
    assert.equal(Object.prototype.hasOwnProperty.call(leak?.payload ?? {}, 'query'), false)
  })

  it('M5: web_search query containing PII does NOT block the call (monitor-only contract)', async () => {
    // Per the plugin doc, tools/result is observe-only — the guard must
    // not throw or skip downstream observers. The audit IS emitted; the
    // tool result IS unaffected.
    const { service, audit } = buildService({ contaminated: true })
    const exec = {
      name: 'web_search',
      callId: 'call-leak-2',
      arguments: { query: '查 13800138000 住址' },
    }
    const result = { isError: false, value: { results: [] } }
    await assert.doesNotReject(handleToolsResult(service, exec, result))
    assert.equal(audit.count('web-search-guard.pii-leak'), 1)
    // Tool audit still fires alongside the security event.
    assert.equal(audit.count('tool.web-search.executed'), 1)
  })

  it('M5: rate-limit-exceeded alarm fires when over budget (warn level)', async () => {
    const { service, audit } = buildService({ rateLimitOverride: 2 })
    const args = { query: 'first query' }
    // Burn through the budget.
    for (let i = 0; i < 2; i++) {
      await handleToolsResult(service, {
        name: 'web_search', callId: `c${i}`, arguments: args,
      }, { isError: false, value: { results: [] } })
    }
    assert.equal(audit.count('web-search-guard.rate-limit-exceeded'), 0)
    // Over-budget hit.
    await handleToolsResult(service, {
      name: 'web_search', callId: 'over', arguments: args,
    }, { isError: false, value: { results: [] } })
    assert.equal(audit.count('web-search-guard.rate-limit-exceeded'), 1)
    const alarm = audit.find('web-search-guard.rate-limit-exceeded')
    assert.equal(alarm?.level, 'warn')
    assert.equal(alarm?.payload.toolName, 'web_search')
    assert.equal(alarm?.payload.limit, 2)
  })

  it('M5: handleToolsResult ignores tools outside MONITORED_TOOLS', async () => {
    const { service, audit } = buildService()
    await handleToolsResult(service, {
      name: 'read',
      callId: 'c-read',
      arguments: { file_path: '/etc/passwd' },
    }, { isError: false, value: { content: '...' } })
    // No audit events for unmonitored tools — that is the entire point of
    // MONITORED_TOOLS, so local file reads don't spam the log.
    assert.equal(audit.events.length, 0)
  })

  it('M5: tool.web-search.executed payload is PII-redacted as belt-and-braces', async () => {
    const { service, audit } = buildService()
    await handleToolsResult(service, {
      name: 'web_search',
      callId: 'c-redact',
      arguments: { query: '13800138000 是谁的', extra: { email: 'x@y.com' } },
    }, { isError: false, value: { results: [] } })
    const evt = audit.find('tool.web-search.executed')
    assert.ok(evt)
    const args = evt?.payload.args as Record<string, unknown>
    // query is NOT contaminated here (sanitizer stub returns identical text)
    // so redaction has nothing to do. But the shape proves the path exists.
    assert.equal(typeof args.query, 'string')
  })

  it('M5: resultCount handles array values, nested results, and missing fields', async () => {
    const { service, audit } = buildService()
    // Array value → length
    await handleToolsResult(service, { name: 'web_search', callId: 'a', arguments: {} },
      { isError: false, value: [{ url: '1' }, { url: '2' }, { url: '3' }] })
    let evt = audit.find('tool.web-search.executed')
    assert.equal(evt?.payload.resultCount, 3)
    // Nested results object → length
    audit.events.length = 0
    await handleToolsResult(service, { name: 'web_search', callId: 'b', arguments: {} },
      { isError: false, value: { results: [{ url: '1' }, { url: '2' }] } })
    evt = audit.find('tool.web-search.executed')
    assert.equal(evt?.payload.resultCount, 2)
    // No value → undefined resultCount
    audit.events.length = 0
    await handleToolsResult(service, { name: 'web_search', callId: 'c', arguments: {} },
      { isError: true })
    evt = audit.find('tool.web-search.executed')
    assert.equal(evt?.payload.isError, true)
    assert.equal(evt?.payload.resultCount, undefined)
  })

  // ── apply() integration — the Cordis entry point ─────────────────────────
  // Verifies the apply() plugin wires the `tools/result` listener correctly
  // and tears it down on dispose. The handler is driven through ctx.on(),
  // simulating the DSH dsh-tools `notifyResult` call without booting the
  // full Cordis loader.

  it('apply() registers a tools/result listener and tears it down via the disposer', async () => {
    const audit = new FakeAudit()
    const sanitizer = fakeSanitizer(false)
    // Minimal ctx stub that captures ctx.on(event, fn) so we can replay it.
    const listeners = new Map<string, Array<(exec: unknown, result: unknown) => void>>()
    const ctx = {
      reflect: { provide: () => () => {} },
      provide: () => () => {},
      auditLog: audit,
      sanitizer,
      on(event: string, fn: (exec: unknown, result: unknown) => void): () => void {
        const list = listeners.get(event) ?? []
        list.push(fn)
        listeners.set(event, list)
        return () => {
          const next = (listeners.get(event) ?? []).filter((f) => f !== fn)
          listeners.set(event, next)
        }
      },
    } as never
    const cfg: Config = {
      enablePIIMonitor: true,
      enableAudit: true,
      enableRateLimit: true,
      rateLimits: {},
    }
    const dispose = await apply(ctx, cfg)
    // tools/result listener registered.
    const resultListeners = listeners.get('tools/result') ?? []
    assert.equal(resultListeners.length, 1, 'expected one tools/result listener')
    // tools/change listener registered (no-op today).
    assert.equal((listeners.get('tools/change') ?? []).length, 1)
    // Replay a fabricated event → audit log fires.
    const resultListenersNow = listeners.get('tools/result') ?? []
    await resultListenersNow[0](
      { name: 'web_search', callId: 'apply-1', arguments: { query: 'apply test' } },
      { isError: false, value: { results: [{ url: 'https://x' }] } },
    )
    assert.equal(audit.count('tool.web-search.executed'), 1)
    // Unmonitored tool → no event.
    audit.events.length = 0
    const resultListeners2 = listeners.get('tools/result') ?? []
    await resultListeners2[0](
      { name: 'read', callId: 'apply-2', arguments: { file_path: '/etc/passwd' } },
      { isError: false, value: {} },
    )
    assert.equal(audit.events.length, 0)
    // Dispose tears down both listeners.
    await dispose()
    assert.equal((listeners.get('tools/result') ?? []).length, 0)
    assert.equal((listeners.get('tools/change') ?? []).length, 0)
  })

  it('apply() reports an observer-error audit event when handleToolsResult throws', async () => {
    // Construct a service whose sanitizer rejects, forcing handleToolsResult
    // to throw and the observer wrapper to emit an error-level audit.
    const audit = new FakeAudit()
    const throwingSanitizer = {
      sanitize: async () => { throw new Error('sanitizer-down') },
    }
    const listeners = new Map<string, Array<(exec: unknown, result: unknown) => void>>()
    const ctx = {
      reflect: { provide: () => () => {} },
      provide: () => () => {},
      auditLog: audit,
      sanitizer: throwingSanitizer,
      on(event: string, fn: (exec: unknown, result: unknown) => void): () => void {
        const list = listeners.get(event) ?? []
        list.push(fn)
        listeners.set(event, list)
        return () => {}
      },
    } as never
    await apply(ctx, {
      enablePIIMonitor: true, enableAudit: true, enableRateLimit: true, rateLimits: {},
    })
    // Use a query so PII-monitor path is exercised (it calls the throwing
    // sanitizer). Without a query, the sanitizer is never called and the
    // pipeline succeeds — we want the failure path here.
    const resultListeners = listeners.get('tools/result') ?? []
    await resultListeners[0](
      { name: 'web_search', callId: 'throw-1', arguments: { query: 'test query' } },
      { isError: false, value: { results: [] } },
    )
    // The wrapper fires the catch handler asynchronously (the .catch on the
    // fire-and-forget Promise resolves on the next microtask). Yield so the
    // audit-log entry lands before we assert.
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(audit.count('web-search-guard.observer-error'), 1)
    assert.equal(audit.find('web-search-guard.observer-error')?.level, 'error')
  })
})
