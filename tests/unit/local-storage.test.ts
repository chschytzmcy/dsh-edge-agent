/**
 * local-storage (M3) tests — exercises the JSONL-backed KV store against
 * a temp directory. Round-trips put/get/delete/list across a simulated
 * process restart by constructing two service instances pointing at the
 * same file.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'vitest'

import * as storage from '../../src/dsh-adapter/local-storage.ts'
import { LocalStorageServiceImpl } from '../../src/dsh-adapter/local-storage.ts'

function fakeCtx() {
  return {
    reflect: { provide(_n: string, _v: unknown) { return () => {} } },
    provide(_n: string, _v: unknown) { return () => {} },
  }
}

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'edge-m3-storage-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('local-storage (M3)', () => {
  it('exports the canonical plugin shape', () => {
    assert.equal(storage.name, 'local-storage')
    assert.deepEqual([...storage.inject], [])
    assert.equal(typeof storage.apply, 'function')
    assert.ok(storage.Config)
  })

  it('put/get round-trip a value within one process', async () => {
    const svc = new LocalStorageServiceImpl(fakeCtx() as never, { root, filename: 's.jsonl' })
    await svc.load()
    await svc.put('users', 'alice', { name: 'Alice', age: 30 })
    const got = await svc.get<{ name: string; age: number }>('users', 'alice')
    assert.equal(got?.name, 'Alice')
    assert.equal(got?.age, 30)
  })

  it('returns null for unknown keys', async () => {
    const svc = new LocalStorageServiceImpl(fakeCtx() as never, { root, filename: 's.jsonl' })
    await svc.load()
    assert.equal(await svc.get('users', 'missing'), null)
  })

  it('persists across simulated restart by re-reading the JSONL', async () => {
    const first = new LocalStorageServiceImpl(fakeCtx() as never, { root, filename: 's.jsonl' })
    await first.load()
    await first.put('users', 'alice', { name: 'Alice' })
    await first.put('users', 'bob', { name: 'Bob' })
    // New process: construct a fresh service that re-scans the same file.
    const second = new LocalStorageServiceImpl(fakeCtx() as never, { root, filename: 's.jsonl' })
    await second.load()
    assert.deepEqual(await second.get('users', 'alice'), { name: 'Alice' })
    assert.deepEqual(await second.get('users', 'bob'), { name: 'Bob' })
  })

  it('delete removes the key and is observable after restart', async () => {
    const first = new LocalStorageServiceImpl(fakeCtx() as never, { root, filename: 's.jsonl' })
    await first.load()
    await first.put('k', 'x', 'value')
    await first.delete('k', 'x')
    const second = new LocalStorageServiceImpl(fakeCtx() as never, { root, filename: 's.jsonl' })
    await second.load()
    assert.equal(await second.get('k', 'x'), null)
  })

  it('list returns every entry in a collection', async () => {
    const svc = new LocalStorageServiceImpl(fakeCtx() as never, { root, filename: 's.jsonl' })
    await svc.load()
    await svc.put('colors', 'r', '#f00')
    await svc.put('colors', 'g', '#0f0')
    await svc.put('colors', 'b', '#00f')
    const list = await svc.list('colors')
    const map = new Map(list.map((e) => [e.key, e.value]))
    assert.equal(map.get('r'), '#f00')
    assert.equal(map.get('g'), '#0f0')
    assert.equal(map.get('b'), '#00f')
  })

  it('clear empties a collection', async () => {
    const svc = new LocalStorageServiceImpl(fakeCtx() as never, { root, filename: 's.jsonl' })
    await svc.load()
    await svc.put('c', 'k1', 1)
    await svc.put('c', 'k2', 2)
    await svc.clear('c')
    const list = await svc.list('c')
    assert.equal(list.length, 0)
  })

  it('isolates collections', async () => {
    const svc = new LocalStorageServiceImpl(fakeCtx() as never, { root, filename: 's.jsonl' })
    await svc.load()
    await svc.put('a', 'k', 'A')
    await svc.put('b', 'k', 'B')
    assert.equal(await svc.get('a', 'k'), 'A')
    assert.equal(await svc.get('b', 'k'), 'B')
    await svc.delete('a', 'k')
    assert.equal(await svc.get('b', 'k'), 'B')
  })
})