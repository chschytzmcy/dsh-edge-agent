/**
 * http-api persistence tests — verify that session creation/deletion
 * goes through the soft-dep sessions helper.
 */
import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'

import { HttpApiServiceImpl } from '../../src/dsh-adapter/http-api.ts'
import { HttpApiSessionsImpl } from '../../src/dsh-adapter/http-api-sessions.ts'

function mockReqWithChunks(chunks: string[], urlPath = '/v1/chat', headers: Record<string, string> = {}): any {
  const ee = new EventEmitter()
  ;(ee as any).method = 'POST'
  ;(ee as any).url = urlPath
  ;(ee as any).headers = { host: 'localhost', 'content-type': 'application/json', ...headers }
  process.nextTick(() => {
    for (const c of chunks) ee.emit('data', c)
    ee.emit('end')
  })
  return ee
}

function mockRes() {
  const cap: any = { status: 0, body: undefined, headers: {} }
  const res: any = {
    writeHead(status: number, headers?: any) { cap.status = status; if (headers) cap.headers = headers; return res },
    setHeader(k: string, v: string) { cap.headers[k] = v; return res },
    end(payload?: any) { cap.body = payload; return res },
    write(_chunk: any) { return true },
    on(_event: string, _fn: any) { return res },
  }
  return { res, cap }
}

describe('http-api session persistence via HttpApiSessionsImpl', () => {
  it('createSession persists in memory', async () => {
    const helper = new HttpApiSessionsImpl(null)
    const { sessionId } = await helper.createSession({ provider: 'local-qwen3-4b', model: 'qwen3-4b' })
    assert.ok(sessionId)
    const meta = await helper.getSession(sessionId)
    assert.ok(meta)
    assert.equal(meta?.provider, 'local-qwen3-4b')
    assert.equal(meta?.title, null)
  })

  it('renameSession updates the title', async () => {
    const helper = new HttpApiSessionsImpl(null)
    const { sessionId } = await helper.createSession()
    await helper.renameSession(sessionId, '我的会话')
    const meta = await helper.getSession(sessionId)
    assert.equal(meta?.title, '我的会话')
  })

  it('forkSession creates a new id with copied metadata', async () => {
    const helper = new HttpApiSessionsImpl(null)
    const { sessionId: srcId } = await helper.createSession({ provider: 'local', model: 'm' })
    await helper.renameSession(srcId, '原会话')
    const { sessionId: newId, sourceSessionId } = await helper.forkSession({ sourceSessionId: srcId })
    assert.notEqual(newId, srcId)
    assert.equal(sourceSessionId, srcId)
    const newMeta = await helper.getSession(newId)
    assert.ok(newMeta)
    assert.equal(newMeta?.provider, 'local')
    assert.equal(newMeta?.title, null, 'forked session starts with null title')
  })

  it('listSessions returns newest-first', async () => {
    const helper = new HttpApiSessionsImpl(null)
    const { sessionId: id1 } = await helper.createSession()
    // Wait so the timestamps differ deterministically.
    await new Promise((r) => setTimeout(r, 2))
    const { sessionId: id2 } = await helper.createSession()
    const list = await helper.listSessions()
    assert.equal(list.length, 2)
    assert.equal(list[0].sessionId, id2, 'newest first')
    assert.equal(list[1].sessionId, id1)
  })

  it('deleteSession removes the record and tombstones it', async () => {
    const helper = new HttpApiSessionsImpl(null)
    const { sessionId } = await helper.createSession()
    const deleted = await helper.deleteSession(sessionId)
    assert.equal(deleted, true)
    const meta = await helper.getSession(sessionId)
    // getSession reads the upstream first (not present), then memory
    // (also empty after delete), so it should return null.
    assert.equal(meta, null)
  })

  it('passes through to an upstream sessions plugin when present', async () => {
    const upstreamCreateCalls: any[] = []
    const upstream = {
      create: async (input: any) => { upstreamCreateCalls.push(input) },
      delete: async (id: string) => {},
      update: async (id: string, patch: any) => {},
      list: async () => [],
    }
    const helper = new HttpApiSessionsImpl({ sessions: upstream })
    const { sessionId } = await helper.createSession({ provider: 'p1', model: 'm1' })
    await new Promise((r) => setImmediate(r))
    assert.equal(upstreamCreateCalls.length, 1)
    assert.equal(upstreamCreateCalls[0].sessionId, sessionId)
    assert.equal(upstreamCreateCalls[0].provider, 'p1')
  })
})
