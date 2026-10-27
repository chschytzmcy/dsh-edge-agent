/**
 * http-api session management tests — against the REAL `HttpApiServiceImpl`.
 *
 * §7.123 (2026-10-27): this file used to define its own `TestSessionManager`
 * class ("Test harness that mimics the session management logic in
 * HttpApiServiceImpl") and assert against THAT copy. A copy cannot fail when
 * the production code regresses — it only proves the test author's
 * re-implementation was self-consistent. Every assertion below now drives
 * the production service (`ensureSession`, `cleanupExpiredSessions`,
 * `evictLeastRecentSession`, `handleDeleteSession`, `handleListSessions`).
 */
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

import { HttpApiServiceImpl } from '../../src/dsh-adapter/http-api.ts'

/** Minimal ServerResponse double capturing status + body. */
function mockRes() {
  const cap: any = { status: 0, body: undefined }
  const res: any = {
    writeHead(status: number) { cap.status = status; return res },
    setHeader() { return res },
    end(payload?: any) { cap.body = payload; return res },
    write(_chunk: any) { return true },
    on(_event: string, _fn: any) { return res },
  }
  return { res, cap }
}

/** Fake `agents` service: `create()` returns the AgentHandle itself
 *  (the production code reads `handle.agent` and calls `handle.dispose()`). */
function fakeAgents() {
  const created: string[] = []
  const disposed: string[] = []
  return {
    created,
    disposed,
    api: {
      async create(opts: any) {
        const id = String(opts?.sessionId ?? 'unknown')
        created.push(id)
        return {
          agent: { id, session: { id } },
          async dispose() { disposed.push(id) },
          async whenIdle() {},
        }
      },
    },
  }
}

function fakeAuditLog() {
  const entries: any[] = []
  return { entries, api: { log: async (e: any) => { entries.push(e) } } }
}

function fakeCtx() {
  return {
    reflect: { provide(_n: string, _v: unknown) { return () => {} } },
    provide(_n: string, _v: unknown) { return () => {} },
    on: () => () => {},
  }
}

function buildService(opts: {
  sessionIdleTimeoutMs?: number
  maxActiveSessions?: number
} = {}) {
  const audit = fakeAuditLog()
  const agents = fakeAgents()
  const svc = new HttpApiServiceImpl(
    fakeCtx() as any,
    {
      host: '127.0.0.1',
      port: 0,
      bearerToken: 'test-token',
      sessionIdleTimeoutMs: opts.sessionIdleTimeoutMs ?? 30_000,
      maxActiveSessions: opts.maxActiveSessions ?? 10,
      maxRequestBodyBytes: 1024 * 1024,
    } as any,
    agents.api as any,
    audit.api as any,
  )
  return { svc, audit, agents }
}

/** The production session map (private field — accessed for assertions). */
function sessionsOf(svc: any): Map<string, any> {
  return svc.sessions
}

describe('http-api session management (production service)', () => {
  describe('session creation', () => {
    it('creates a session and records createdAt / lastAccessedAt', async () => {
      const { svc } = buildService()
      const record = await (svc as any).ensureSession('s1')
      assert.ok(record.createdAt > 0)
      assert.ok(record.lastAccessedAt >= record.createdAt)
      assert.equal(sessionsOf(svc).size, 1)
      assert.equal(sessionsOf(svc).has('s1'), true)
    })

    it('audits session creation', async () => {
      const { svc, audit } = buildService()
      await (svc as any).ensureSession('s1')
      const created = audit.entries.filter((e) => e.kind === 'session.created')
      assert.equal(created.length, 1)
      assert.equal(created[0].payload.sessionId, 's1')
    })

    it('updates lastAccessedAt on subsequent access and does NOT re-create the agent', async () => {
      const { svc, agents } = buildService()
      const first = await (svc as any).ensureSession('s1')
      const firstAccess = first.lastAccessedAt
      await new Promise((r) => setTimeout(r, 5))
      const second = await (svc as any).ensureSession('s1')
      assert.ok(second.lastAccessedAt >= firstAccess)
      assert.equal(sessionsOf(svc).size, 1)
      // A second ensureSession on an existing id must NOT spawn a second agent.
      assert.equal(agents.created.length, 1)
    })
  })

  describe('session expiration', () => {
    it('expires sessions idle longer than the timeout and disposes the agent', async () => {
      const { svc, agents } = buildService({ sessionIdleTimeoutMs: 100 })
      await (svc as any).ensureSession('s1')
      await (svc as any).ensureSession('s2')
      // Backdate s1 so it looks idle.
      sessionsOf(svc).get('s1').lastAccessedAt = Date.now() - 200

      ;(svc as any).cleanupExpiredSessions()

      assert.equal(sessionsOf(svc).has('s1'), false, 's1 应被过期清理')
      assert.equal(sessionsOf(svc).has('s2'), true, 's2 仍在活动期')
      assert.ok(agents.disposed.includes('s1'), '过期会话的 agent handle 应被 dispose')
    })

    it('audits session expiration', async () => {
      const { svc, audit } = buildService({ sessionIdleTimeoutMs: 100 })
      await (svc as any).ensureSession('s1')
      sessionsOf(svc).get('s1').lastAccessedAt = Date.now() - 200

      ;(svc as any).cleanupExpiredSessions()

      const expired = audit.entries.filter((e) => e.kind === 'session.expired')
      assert.equal(expired.length, 1)
      assert.equal(expired[0].payload.sessionId, 's1')
    })

    it('does not expire sessions when the timeout is 0', async () => {
      const { svc } = buildService({ sessionIdleTimeoutMs: 0 })
      await (svc as any).ensureSession('s1')
      sessionsOf(svc).get('s1').lastAccessedAt = Date.now() - 999_999

      ;(svc as any).cleanupExpiredSessions()

      assert.equal(sessionsOf(svc).size, 1, 'timeout=0 表示永不过期')
    })

    it('does not expire recently accessed sessions', async () => {
      const { svc } = buildService({ sessionIdleTimeoutMs: 30_000 })
      await (svc as any).ensureSession('s1')
      await (svc as any).ensureSession('s2')

      ;(svc as any).cleanupExpiredSessions()

      assert.equal(sessionsOf(svc).size, 2)
    })
  })

  describe('LRU eviction at maxActiveSessions', () => {
    it('evicts the least-recently-used session and audits it', async () => {
      const { svc, audit, agents } = buildService({ maxActiveSessions: 2 })
      await (svc as any).ensureSession('s1')
      await new Promise((r) => setTimeout(r, 5))
      await (svc as any).ensureSession('s2')
      // Touch s2 so s1 becomes the least-recently-used.
      await new Promise((r) => setTimeout(r, 5))
      await (svc as any).ensureSession('s2')
      await new Promise((r) => setTimeout(r, 5))

      await (svc as any).ensureSession('s3') // over the cap → evict LRU

      assert.equal(sessionsOf(svc).has('s1'), false, 's1（最久未访问）应被淘汰')
      assert.equal(sessionsOf(svc).has('s2'), true)
      assert.equal(sessionsOf(svc).has('s3'), true)
      assert.equal(sessionsOf(svc).size, 2)

      const evicted = audit.entries.filter((e) => e.kind === 'session.evicted')
      assert.equal(evicted.length, 1)
      assert.equal(evicted[0].payload.sessionId, 's1')
      assert.equal(evicted[0].payload.reason, 'max-active-sessions-reached')
      assert.ok(agents.disposed.includes('s1'), '被淘汰会话的 agent handle 应被 dispose')
    })
  })

  describe('session deletion (DELETE /v1/sessions/{id})', () => {
    it('404s for an unknown session', async () => {
      const { svc } = buildService()
      const { res, cap } = mockRes()
      await (svc as any).handleDeleteSession('nope', res)
      assert.equal(cap.status, 404)
    })

    it('204s for a known session, disposes the agent and audits the delete', async () => {
      const { svc, audit, agents } = buildService()
      await (svc as any).ensureSession('s1')
      const { res, cap } = mockRes()

      await (svc as any).handleDeleteSession('s1', res)

      assert.equal(cap.status, 204)
      assert.equal(sessionsOf(svc).has('s1'), false)
      assert.ok(agents.disposed.includes('s1'))
      const deleted = audit.entries.filter((e) => e.kind === 'session.deleted')
      assert.equal(deleted.length, 1)
      assert.equal(deleted[0].payload.sessionId, 's1')
    })
  })

  describe('session listing (GET /v1/sessions)', () => {
    it('lists the live sessions with their timestamps', async () => {
      const { svc } = buildService()
      await (svc as any).ensureSession('s1')
      await (svc as any).ensureSession('s2')
      const { res, cap } = mockRes()

      ;(svc as any).handleListSessions(res)

      assert.equal(cap.status, 200)
      const body = JSON.parse(cap.body)
      assert.equal(body.sessions.length, 2)
      const ids = body.sessions.map((s: any) => s.sessionId).sort()
      assert.deepEqual(ids, ['s1', 's2'])
      assert.ok(body.sessions[0].createdAt > 0)
      assert.ok(body.sessions[0].lastAccessedAt > 0)
    })
  })
})
