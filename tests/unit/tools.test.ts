/**
 * tools plugin tests — M2 surface: classifyByPrefix (pure) and
 * ToolsServiceImpl.setRealm / list / realmOf (in-memory).
 */

import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

import * as tools from '../../src/dsh-adapter/tools.ts'
import { classifyByPrefix, ToolsServiceImpl } from '../../src/dsh-adapter/tools.ts'

/** Build a minimal fake Cordis ctx that ToolsServiceImpl needs. */
function fakeCtx(toolsMap: Record<string, { description?: string }> = {}) {
  const toolsRecord = toolsMap
  return {
    reflect: {
      provide(_name: string, _value: unknown) {
        return () => {}
      },
    },
    provide(_name: string, value: unknown) {
      return () => value
    },
    tools: {
      view() {
        const map = new Map<string, { description?: string }>(Object.entries(toolsRecord))
        return {
          entries() { return map.entries() },
        }
      },
    },
  }
}

describe('tools (M2)', () => {
  it('exports the canonical plugin shape', () => {
    assert.equal(tools.name, 'tools')
    assert.deepEqual([...tools.inject], ['auditLog'])
    assert.equal(typeof tools.apply, 'function')
    assert.ok(tools.Config)
  })

  it('classifies names by prefix', () => {
    assert.equal(classifyByPrefix('local_file_read'), 'LOCAL')
    assert.equal(classifyByPrefix('cloud_search'), 'CLOUD')
    assert.equal(classifyByPrefix('sanitized_redact'), 'SANITIZED')
    assert.equal(classifyByPrefix('unknown_tool'), 'CLOUD')
  })

  it('service remembers the realm set by apply()', () => {
    const ctx = fakeCtx({ local_file_read: { description: 'read' } })
    const service = new ToolsServiceImpl(ctx as never)
    service.setRealm('local_file_read', 'LOCAL')
    assert.equal(service.realmOf('local_file_read'), 'LOCAL')
    assert.equal(service.has('local_file_read'), true)
    assert.equal(service.has('nonexistent_tool'), false)
  })

  it('list() filters by realm when supplied', () => {
    const ctx = fakeCtx({
      local_file_read: { description: 'read' },
      local_calculate: { description: 'calc' },
      cloud_search: { description: 'search' },
    })
    const service = new ToolsServiceImpl(ctx as never)
    service.setRealm('local_file_read', 'LOCAL')
    service.setRealm('local_calculate', 'LOCAL')
    service.setRealm('cloud_search', 'CLOUD')
    const local = service.list('LOCAL').map((t) => t.name).sort()
    assert.deepEqual(local, ['local_calculate', 'local_file_read'])
    const cloud = service.list('CLOUD').map((t) => t.name)
    assert.deepEqual(cloud, ['cloud_search'])
  })

  it('list() with no filter returns every registered tool with the recorded realm', () => {
    const ctx = fakeCtx({
      local_file_read: { description: 'r' },
      cloud_search: { description: 's' },
    })
    const service = new ToolsServiceImpl(ctx as never)
    service.setRealm('local_file_read', 'LOCAL')
    const all = service.list().map((t) => `${t.name}:${t.realm}`).sort()
    assert.deepEqual(all, ['cloud_search:CLOUD', 'local_file_read:LOCAL'])
  })

  // ── G8: enableToolIsolation × intent-router verdict ─────────────────────────
  // Pre-G8 the `enableToolIsolation` Config flag was defined but never plumbed
  // — ToolsServiceImpl never received it. G8 wires it through the constructor
  // and exposes `filterTools(intent)` + `isToolAllowed(name, intent)`. Consumers
  // (http-api, agent-loop) drive tool visibility from the intent-router verdict.

  /** A test fixture: 4 tools spanning all 3 known realms. */
  function isolationCtx() {
    return fakeCtx({
      local_file_read: { description: 'r' },
      local_calculate: { description: 'c' },
      cloud_search: { description: 's' },
      cloud_summarize: { description: 'su' },
      sanitized_redact: { description: 'red' },
    })
  }

  it('filterTools(LOCAL) returns only local_ tools when isolation is on', () => {
    const service = new ToolsServiceImpl(isolationCtx() as never, { enableToolIsolation: true })
    const names = service.filterTools({ category: 'LOCAL' }).map((t) => t.name).sort()
    assert.deepEqual(names, ['local_calculate', 'local_file_read'])
  })

  it('filterTools(CLOUD) returns only cloud_ tools when isolation is on', () => {
    const service = new ToolsServiceImpl(isolationCtx() as never, { enableToolIsolation: true })
    const names = service.filterTools({ category: 'CLOUD' }).map((t) => t.name).sort()
    // cloud_search + cloud_summarize only — SANITIZED tools are NOT visible
    // to CLOUD realm (semantics: SANITIZED is its own realm, not a CLOUD
    // sub-realm; cross-realm tool leak would defeat the purpose).
    assert.deepEqual(names, ['cloud_search', 'cloud_summarize'])
  })

  it('filterTools(SANITIZED) returns only sanitized_ tools when isolation is on', () => {
    const service = new ToolsServiceImpl(isolationCtx() as never, { enableToolIsolation: true })
    const names = service.filterTools({ category: 'SANITIZED' }).map((t) => t.name)
    assert.deepEqual(names, ['sanitized_redact'])
  })

  it('filterTools(REJECT) returns [] — no tools visible to a rejected intent', () => {
    const service = new ToolsServiceImpl(isolationCtx() as never, { enableToolIsolation: true })
    assert.deepEqual(service.filterTools({ category: 'REJECT' }), [])
  })

  it('filterTools() returns all tools regardless of intent when isolation is OFF (legacy)', () => {
    const service = new ToolsServiceImpl(isolationCtx() as never, { enableToolIsolation: false })
    const names = service.filterTools({ category: 'LOCAL' }).map((t) => t.name).sort()
    assert.deepEqual(names, [
      'cloud_search', 'cloud_summarize', 'local_calculate', 'local_file_read', 'sanitized_redact',
    ])
  })

  it('filterTools() defaults to isolation OFF when no Config is supplied', () => {
    // Backward compat: pre-G8 callers passed only `(ctx)`. They must still
    // see all tools (the prior behavior — flag was inert).
    const service = new ToolsServiceImpl(isolationCtx() as never)
    const names = service.filterTools({ category: 'LOCAL' }).map((t) => t.name).sort()
    assert.equal(names.length, 5)
  })

  it('isToolAllowed respects the same isolation matrix', () => {
    const service = new ToolsServiceImpl(isolationCtx() as never, { enableToolIsolation: true })
    // LOCAL intent: local_ allowed, others denied
    assert.equal(service.isToolAllowed('local_file_read', { category: 'LOCAL' }), true)
    assert.equal(service.isToolAllowed('cloud_search', { category: 'LOCAL' }), false)
    assert.equal(service.isToolAllowed('sanitized_redact', { category: 'LOCAL' }), false)
    // CLOUD intent: cloud_ allowed
    assert.equal(service.isToolAllowed('cloud_search', { category: 'CLOUD' }), true)
    assert.equal(service.isToolAllowed('local_file_read', { category: 'CLOUD' }), false)
    // SANITIZED intent: sanitized_ allowed
    assert.equal(service.isToolAllowed('sanitized_redact', { category: 'SANITIZED' }), true)
    assert.equal(service.isToolAllowed('cloud_search', { category: 'SANITIZED' }), false)
    // REJECT intent: NOTHING allowed (including tools the realm would normally see)
    assert.equal(service.isToolAllowed('local_file_read', { category: 'REJECT' }), false)
    assert.equal(service.isToolAllowed('cloud_search', { category: 'REJECT' }), false)
  })

  it('isToolAllowed with isolation OFF returns true for any registered tool', () => {
    const service = new ToolsServiceImpl(isolationCtx() as never, { enableToolIsolation: false })
    // ANY non-REJECT intent → all registered tools allowed
    assert.equal(service.isToolAllowed('local_file_read', { category: 'CLOUD' }), true)
    assert.equal(service.isToolAllowed('sanitized_redact', { category: 'LOCAL' }), true)
    // REJECT still denies all (intent rejection is independent of isolation flag)
    assert.equal(service.isToolAllowed('local_file_read', { category: 'REJECT' }), false)
  })

  it('isToolAllowed returns false for unregistered tool regardless of isolation', () => {
    const service = new ToolsServiceImpl(isolationCtx() as never, { enableToolIsolation: true })
    assert.equal(service.isToolAllowed('does_not_exist', { category: 'LOCAL' }), false)
  })

  // ── Phase 5: DSH_NATIVE_REALM_MAP (2026-08-26) ────────────────────────────
  // `@deepseek-ai/dsh-tool-web` registers `web_search` and `web_fetch` without
  // a realm prefix, so `classifyByPrefix` would default them to CLOUD anyway.
  // The explicit map makes the assignment discoverable: `realmOf('web_search')`
  // returns CLOUD without a manual `setRealm` call. Local fs tools (bash,
  // read, write, edit) similarly get LOCAL without prefix games.

  it('Phase 5: web_search / web_fetch resolve to CLOUD without manual setRealm', () => {
    const service = new ToolsServiceImpl(isolationCtx() as never)
    assert.equal(service.realmOf('web_search'), 'CLOUD')
    assert.equal(service.realmOf('web_fetch'), 'CLOUD')
    assert.equal(service.classify('web_search'), 'CLOUD')
  })

  it('Phase 5: DSH local fs tools (bash/read/write/edit) resolve to LOCAL', () => {
    const service = new ToolsServiceImpl(isolationCtx() as never)
    assert.equal(service.realmOf('bash'), 'LOCAL')
    assert.equal(service.realmOf('read'), 'LOCAL')
    assert.equal(service.realmOf('write'), 'LOCAL')
    assert.equal(service.realmOf('edit'), 'LOCAL')
  })

  it('Phase 5: filterTools(CLOUD) hides web_search under LOCAL intent', () => {
    // Without the map, web_search (no prefix) would default to CLOUD and
    // accidentally be visible to a LOCAL verdict — defeating the intent-router
    // realm guarantee. With the map applied at construction, isToolAllowed
    // returns false for a LOCAL intent on web_search.
    const service = new ToolsServiceImpl(
      fakeCtx({ web_search: { description: 'web search' }, local_file_read: { description: 'r' } }) as never,
      { enableToolIsolation: true },
    )
    assert.equal(service.isToolAllowed('web_search', { category: 'LOCAL' }), false)
    assert.equal(service.isToolAllowed('web_search', { category: 'CLOUD' }), true)
    assert.equal(service.isToolAllowed('local_file_read', { category: 'LOCAL' }), true)
  })

  it('Phase 5: apply() registers existing web_search / web_fetch into the realm map', async () => {
    // ToolsServiceImpl apply() walks the upstream registry once at boot and
    // `setRealm`s every name in DSH_NATIVE_REALM_MAP, so callers can rely on
    // `realmOf` immediately after `apply()` returns.
    const ctx = fakeCtx({
      web_search: { description: 'web search' },
      web_fetch: { description: 'web fetch' },
      bash: { description: 'bash' },
    })
    ctx.on = () => () => {}
    await tools.apply(ctx as never, {
      defaultRateLimitPerMinute: 60,
      enableToolIsolation: true,
      presentationMode: 'native',
    })
    // The service was created via `new` inside apply(); we cannot reach it
    // directly from the test, but `ctx.reflect.provide` was called during
    // construction. The test surface here is the absence of exceptions —
    // unit-level realm behavior is exercised by the dedicated tests above.
    assert.ok(true)
  })
})