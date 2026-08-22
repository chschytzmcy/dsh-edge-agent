/**
 * http-api session management tests — session expiration, audit, max sessions.
 *
 * Tests session management logic through a lightweight test harness
 * that simulates the key behaviors.
 */
import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'vitest'

interface SessionRecord {
  id: string
  createdAt: number
  lastAccessedAt: number
}

/**
 * Test harness that mimics the session management logic in HttpApiServiceImpl.
 */
class TestSessionManager {
  private sessions = new Map<string, SessionRecord>()
  private auditLog: Array<{ kind: string; payload: Record<string, unknown> }> = []

  constructor(
    private sessionIdleTimeoutMs: number,
    private maxActiveSessions: number,
  ) {}

  getAuditLog() {
    return this.auditLog
  }

  getSessionCount() {
    return this.sessions.size
  }

  hasSession(id: string) {
    return this.sessions.has(id)
  }

  getSession(id: string) {
    return this.sessions.get(id)
  }

  async ensureSession(id: string) {
    let record = this.sessions.get(id)
    if (!record) {
      // Check max and evict if needed
      if (this.maxActiveSessions > 0 && this.sessions.size >= this.maxActiveSessions) {
        this.evictLeastRecentSession()
      }
      const now = Date.now()
      record = { id, createdAt: now, lastAccessedAt: now }
      this.sessions.set(id, record)
      this.auditLog.push({ kind: 'session.created', payload: { sessionId: id, totalSessions: this.sessions.size } })
    } else {
      record.lastAccessedAt = Date.now()
    }
    return record
  }

  async deleteSession(id: string) {
    if (this.sessions.has(id)) {
      this.sessions.delete(id)
      this.auditLog.push({ kind: 'session.deleted', payload: { sessionId: id } })
    }
  }

  cleanupExpiredSessions() {
    if (this.sessionIdleTimeoutMs <= 0) return
    const now = Date.now()
    const expired: string[] = []
    for (const [id, record] of this.sessions.entries()) {
      if (now - record.lastAccessedAt > this.sessionIdleTimeoutMs) {
        expired.push(id)
      }
    }
    for (const id of expired) {
      const record = this.sessions.get(id)
      if (record) {
        this.sessions.delete(id)
        this.auditLog.push({
          kind: 'session.expired',
          payload: { sessionId: id, idleMs: now - record.lastAccessedAt },
        })
      }
    }
  }

  private evictLeastRecentSession() {
    let oldest: { id: string; lastAccessedAt: number } | null = null
    for (const [id, record] of this.sessions.entries()) {
      if (!oldest || record.lastAccessedAt < oldest.lastAccessedAt) {
        oldest = { id, lastAccessedAt: record.lastAccessedAt }
      }
    }
    if (oldest) {
      this.sessions.delete(oldest.id)
      this.auditLog.push({
        kind: 'session.evicted',
        payload: { sessionId: oldest.id, reason: 'max-active-sessions-reached' },
      })
    }
  }

  /** Manually set lastAccessedAt for testing expiration. */
  setLastAccessed(id: string, offsetMs: number) {
    const record = this.sessions.get(id)
    if (record) {
      record.lastAccessedAt = Date.now() - offsetMs
    }
  }
}

describe('http-api session management', () => {
  describe('session creation', () => {
    it('creates a new session with createdAt and lastAccessedAt', async () => {
      const mgr = new TestSessionManager(30000, 10)
      const record = await mgr.ensureSession('s1')
      assert.ok(record.createdAt > 0)
      assert.ok(record.lastAccessedAt >= record.createdAt)
      assert.equal(mgr.getSessionCount(), 1)
    })

    it('audits session creation', async () => {
      const mgr = new TestSessionManager(30000, 10)
      await mgr.ensureSession('s1')
      const log = mgr.getAuditLog()
      assert.equal(log.length, 1)
      assert.equal(log[0]!.kind, 'session.created')
      assert.equal(log[0]!.payload.sessionId, 's1')
    })

    it('updates lastAccessedAt on subsequent access', async () => {
      const mgr = new TestSessionManager(30000, 10)
      const r1 = await mgr.ensureSession('s1')
      const firstAccess = r1.lastAccessedAt
      // Small delay
      await new Promise((r) => setTimeout(r, 5))
      const r2 = await mgr.ensureSession('s1')
      assert.ok(r2.lastAccessedAt >= firstAccess)
      assert.equal(mgr.getSessionCount(), 1)
    })
  })

  describe('session expiration', () => {
    it('expires sessions idle longer than timeout', async () => {
      const mgr = new TestSessionManager(100, 10) // 100ms timeout
      await mgr.ensureSession('s1')
      await mgr.ensureSession('s2')
      // s1 is now idle
      mgr.setLastAccessed('s1', 200) // 200ms ago

      mgr.cleanupExpiredSessions()
      assert.equal(mgr.getSessionCount(), 1)
      assert.ok(!mgr.hasSession('s1'))
      assert.ok(mgr.hasSession('s2'))
    })

    it('audits session expiration', async () => {
      const mgr = new TestSessionManager(100, 10)
      await mgr.ensureSession('s1')
      mgr.setLastAccessed('s1', 200)

      mgr.cleanupExpiredSessions()
      const log = mgr.getAuditLog()
      const expired = log.filter((e) => e.kind === 'session.expired')
      assert.equal(expired.length, 1)
      assert.equal(expired[0]!.payload.sessionId, 's1')
    })

    it('does not expire sessions when timeout is 0', async () => {
      const mgr = new TestSessionManager(0, 10)
      await mgr.ensureSession('s1')
      mgr.setLastAccessed('s1', 999999)

      mgr.cleanupExpiredSessions()
      assert.equal(mgr.getSessionCount(), 1) // still alive
    })

    it('does not expire recently accessed sessions', async () => {
      const mgr = new TestSessionManager(30000, 10)
      await mgr.ensureSession('s1')
      await mgr.ensureSession('s2')
      // Both accessed recently
      mgr.cleanupExpiredSessions()
      assert.equal(mgr.getSessionCount(), 2)
    })
  })

  describe('session deletion', () => {
    it('removes session and audits deletion', async () => {
      const mgr = new TestSessionManager(30000, 10)
      await mgr.ensureSession('s1')
      await mgr.deleteSession('s1')
      assert.equal(mgr.getSessionCount(), 0)
      const log = mgr.getAuditLog()
      const deleted = log.filter((e) => e.kind === 'session.deleted')
      assert.equal(deleted.length, 1)
    })

    it('handles deleting non-existent session', async () => {
      const mgr = new TestSessionManager(30000, 10)
      await mgr.deleteSession('nonexistent')
      assert.equal(mgr.getSessionCount(), 0)
    })
  })

  describe('max active sessions (LRU eviction)', () => {
    it('evicts LRU session when max is reached', async () => {
      const mgr = new TestSessionManager(30000, 3)
      await mgr.ensureSession('s1')
      await new Promise((r) => setTimeout(r, 2))
      await mgr.ensureSession('s2')
      await new Promise((r) => setTimeout(r, 2))
      await mgr.ensureSession('s3')
      assert.equal(mgr.getSessionCount(), 3)

      // s4 triggers eviction of s1 (oldest lastAccessedAt)
      await mgr.ensureSession('s4')
      assert.equal(mgr.getSessionCount(), 3)
      assert.ok(!mgr.hasSession('s1'))
      assert.ok(mgr.hasSession('s2'))
      assert.ok(mgr.hasSession('s3'))
      assert.ok(mgr.hasSession('s4'))
    })

    it('audits eviction', async () => {
      const mgr = new TestSessionManager(30000, 2)
      await mgr.ensureSession('s1')
      await new Promise((r) => setTimeout(r, 2))
      await mgr.ensureSession('s2')

      await mgr.ensureSession('s3')
      const log = mgr.getAuditLog()
      const evicted = log.filter((e) => e.kind === 'session.evicted')
      assert.equal(evicted.length, 1)
      assert.equal(evicted[0]!.payload.sessionId, 's1')
      assert.equal(evicted[0]!.payload.reason, 'max-active-sessions-reached')
    })

    it('does not evict when maxActiveSessions is 0 (unlimited)', async () => {
      const mgr = new TestSessionManager(30000, 0)
      for (let i = 0; i < 20; i++) {
        await mgr.ensureSession(`s${i}`)
      }
      assert.equal(mgr.getSessionCount(), 20)
    })

    it('evicts LRU, not MRU, when idle times differ', async () => {
      const mgr = new TestSessionManager(30000, 3)
      await mgr.ensureSession('s1')
      await new Promise((r) => setTimeout(r, 2))
      await mgr.ensureSession('s2')
      await new Promise((r) => setTimeout(r, 2))
      await mgr.ensureSession('s3')

      // Access s1 to make it most-recent
      await mgr.ensureSession('s1')

      // s2 is now the LRU
      await mgr.ensureSession('s4')
      assert.ok(!mgr.hasSession('s2'), 's2 should be evicted as LRU')
      assert.ok(mgr.hasSession('s1'), 's1 should survive as recently accessed')
    })
  })
})
