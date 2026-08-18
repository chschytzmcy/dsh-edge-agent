/**
 * sessions (M3) tests — round-trips session create / appendMessage /
 * getRecentMessages / listActive / cleanup against a temp JSONL store.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'vitest'

import * as sessionsMod from '../../src/dsh-adapter/sessions.ts'
import { SessionsServiceImpl } from '../../src/dsh-adapter/sessions.ts'
import { LocalStorageServiceImpl } from '../../src/dsh-adapter/local-storage.ts'

function fakeCtx() {
  return {
    reflect: { provide(_n: string, _v: unknown) { return () => {} } },
    provide(_n: string, _v: unknown) { return () => {} },
  }
}

let root: string
let storage: LocalStorageServiceImpl
let sessions: SessionsServiceImpl

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'edge-m3-sessions-'))
  storage = new LocalStorageServiceImpl(fakeCtx() as never, { root, filename: 's.jsonl' })
  await storage.load()
  sessions = new SessionsServiceImpl(
    { ...fakeCtx(), localStorage: storage } as never,
    { defaultTtlSeconds: 3600, maxConcurrentSessions: 16, collection: 'sessions' },
  )
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('sessions (M3)', () => {
  it('exports the canonical plugin shape', () => {
    assert.equal(sessionsMod.name, 'sessions')
    assert.deepEqual([...sessionsMod.inject], ['localStorage'])
    assert.equal(typeof sessionsMod.apply, 'function')
    assert.ok(sessionsMod.Config)
  })

  it('create returns a fresh session with empty messages', async () => {
    const session = await sessions.create({})
    assert.match(session.id, /^sess_/u)
    assert.equal(session.messages.length, 0)
    assert.equal(session.lastSeenAt, session.createdAt)
  })

  it('appendMessage records a turn and updates lastSeenAt', async () => {
    const session = await sessions.create({})
    const before = session.createdAt
    await sessions.appendMessage(session.id, {
      role: 'user',
      content: 'hi',
      ts: before,
    })
    const got = await sessions.get(session.id)
    assert.ok(got)
    assert.equal(got!.messages.length, 1)
    assert.equal(got!.messages[0]!.role, 'user')
    assert.ok(got!.lastSeenAt >= before)
  })

  it('getRecentMessages returns the tail of the conversation', async () => {
    const session = await sessions.create({})
    for (const role of ['user', 'assistant', 'user', 'assistant', 'user'] as const) {
      await sessions.appendMessage(session.id, { role, content: role, ts: Date.now() })
    }
    const recent = await sessions.getRecentMessages(session.id, 3)
    assert.equal(recent.length, 3)
    assert.equal(recent[0]!.role, 'user')
    assert.equal(recent[2]!.role, 'user')
  })

  it('listActive returns sessions whose TTL has not elapsed', async () => {
    const a = await sessions.create({})
    const b = await sessions.create({})
    const list = await sessions.listActive()
    const ids = list.map((s) => s.id)
    assert.ok(ids.includes(a.id))
    assert.ok(ids.includes(b.id))
  })

  it('cleanup removes sessions idle past their TTL', async () => {
    const a = await sessions.create({ ttlSeconds: 0 })
    // Sleep briefly to ensure (now - lastSeenAt) > ttlMs for `a`.
    await new Promise((resolve) => setTimeout(resolve, 5))
    const removed = await sessions.cleanup()
    assert.ok(removed >= 1)
    assert.equal(await sessions.get(a.id), null)
  })

  it('appendMessage to an unknown id throws', async () => {
    await assert.rejects(
      () => sessions.appendMessage('sess_unknown', { role: 'user', content: 'hi', ts: 0 }),
      /session "sess_unknown" not found/u,
    )
  })

  it('survives a simulated restart by re-reading the store', async () => {
    const original = await sessions.create({})
    await sessions.appendMessage(original.id, { role: 'user', content: 'hi', ts: Date.now() })
    // Construct a fresh service tree pointing at the same JSONL.
    const storage2 = new LocalStorageServiceImpl(fakeCtx() as never, { root, filename: 's.jsonl' })
    await storage2.load()
    const sessions2 = new SessionsServiceImpl(
      { ...fakeCtx(), localStorage: storage2 } as never,
      { defaultTtlSeconds: 3600, maxConcurrentSessions: 16, collection: 'sessions' },
    )
    const restored = await sessions2.get(original.id)
    assert.ok(restored)
    assert.equal(restored!.messages.length, 1)
    assert.equal(restored!.messages[0]!.content, 'hi')
  })

  it('cleanup enforces maxConcurrentSessions by evicting the oldest', async () => {
    const tiny = new SessionsServiceImpl(
      { ...fakeCtx(), localStorage: storage } as never,
      { defaultTtlSeconds: 3600, maxConcurrentSessions: 2, collection: 'sessions' },
    )
    const a = await tiny.create({})
    await new Promise((resolve) => setTimeout(resolve, 5))
    const b = await tiny.create({})
    await new Promise((resolve) => setTimeout(resolve, 5))
    const c = await tiny.create({})
    void a; void b; void c
    const removed = await tiny.cleanup()
    assert.ok(removed >= 1)
    const survivors = await tiny.listActive()
    assert.ok(survivors.length <= 2)
  })
})