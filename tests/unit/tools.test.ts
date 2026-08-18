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
})