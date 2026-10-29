/**
 * §7.147 会话归属：审计行「属于哪个会话」的口径。
 *
 * 背景（2026-10-29 实机取证）：Edge 面板按**行**判断「这一轮」（§7.145-B）
 * —— 会话自己的行 `turn >= 0`，全局行 `turn === -1`（哨兵）。归属由宿主
 * `edge-context-view.ts` 的 `extractSessionId()` 决定：载荷里**有** sessionId
 * 就是会话行，没有就是全局行；全局桶会被合并进**任何一个**会话的快照。
 *
 * 实测本机审计链（4962 行逐 kind 统计）：
 *
 * | kind | 条数 | 带 sessionId |
 * |---|---|---|
 * | `llm.local.start` | 640 | **0** |
 * | `llm.trace.index` | 195 | **0** |
 * | `intent.jev.adopt` / `intent.jev.response` | 62 | **0** |
 *
 * ⇒ 路由 / 意图两个面板**结构上**不可能归属任何一轮 ⇒ 面板只能显示
 * 「尚未绑定会话 + 全局信号」。
 *
 * 本文件钉死两件事：
 *
 *  1. **生产侧**：真会话 id 进载荷；哨兵 / 空串**不写**这个键（宁可归全局，
 *     也不要造一个不存在的桶把行藏掉）。
 *  2. **消费侧**：宿主 fold 遇到哨兵也判全局（防御旧行与旁路）。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import {
  PRE_SESSION_SENTINEL,
  realSessionId,
  sessionIdField,
} from '../../src/dsh-adapter/session-attribution.ts'
import {
  EdgeContextViewServiceImpl,
} from '../../src/dsh-adapter/edge-context-view.ts'
import type { AuditEntry } from '../../src/dsh-adapter/audit-log.ts'

function entry(kind: string, payload: Record<string, unknown>): AuditEntry {
  return { ts: Date.now(), level: 'info', kind, source: 'test', payload }
}

describe('§7.147 — realSessionId：哨兵不是会话 id', () => {
  it('真会话 id 原样返回', () => {
    assert.equal(realSessionId('session-8c67f7ca-1db4-4714-b89f-8f8ecb99d7c8'), 'session-8c67f7ca-1db4-4714-b89f-8f8ecb99d7c8')
  })

  it('空串 / 非字符串 ⇒ 没有会话', () => {
    assert.equal(realSessionId(''), undefined)
    assert.equal(realSessionId(undefined), undefined)
    assert.equal(realSessionId(null), undefined)
    assert.equal(realSessionId(42), undefined)
    assert.equal(realSessionId({}), undefined)
  })

  it('哨兵 ⇒ 没有会话（它只是 ops log 的显示约定）', () => {
    assert.equal(realSessionId(PRE_SESSION_SENTINEL), undefined)
    assert.equal(PRE_SESSION_SENTINEL, '<pre-session>')
  })
})

describe('§7.147 — sessionIdField：没有会话就不写这个键', () => {
  it('真会话 ⇒ 带 sessionId', () => {
    assert.deepEqual(sessionIdField('s-1'), { sessionId: 's-1' })
  })

  it('没有会话 ⇒ **不带** sessionId 键（反向证伪：不能造假桶）', () => {
    // 反向证伪点：这里若写成 `{ sessionId: undefined }`，JSON.stringify 会把
    // 键丢掉 —— 结果一样；但若写成 `{ sessionId: '<pre-session>' }`，面板会
    // 造出一个叫 <pre-session> 的桶，那几行从此在所有真实会话的视图里消失。
    const field = sessionIdField(undefined)
    assert.equal('sessionId' in field, false)
    assert.deepEqual(field, {})
  })

  it('哨兵 ⇒ 不带 sessionId 键', () => {
    const field = sessionIdField(PRE_SESSION_SENTINEL)
    assert.equal('sessionId' in field, false)
  })
})

describe('§7.147 — 消费侧：宿主 fold 把哨兵判全局', () => {
  const CONFIG = { bufferSize: 8, sessionTtlMs: 1_800_000, piiRedact: true }
  function makeService(): EdgeContextViewServiceImpl {
    const fakeCtx = { reflect: { provide: () => {} } } as never
    return new EdgeContextViewServiceImpl(fakeCtx, CONFIG)
  }

  it('带哨兵的行落全局桶，不造出假会话桶', () => {
    const svc = makeService()
    svc.record(entry('llm.local.start', { sessionId: PRE_SESSION_SENTINEL, provider: 'local-llm' }))
    // 假桶不能出现：否则那几行只在「有人请求这个假 id」时可见。
    assert.equal(svc.trackedSessionIds().includes(PRE_SESSION_SENTINEL), false)
    // 它是全局行 ⇒ 合并进任何会话的快照，且 turn = -1 哨兵。
    const snap = svc.snapshot('s-real')
    assert.equal(snap.rows.length, 1)
    assert.equal(snap.rows[0].turn, -1)
  })

  it('真会话 id 的行进会话桶，turn >= 0', () => {
    const svc = makeService()
    svc.record(entry('llm.local.start', { sessionId: 's-real', provider: 'local-llm' }))
    assert.ok(svc.trackedSessionIds().includes('s-real'))
    const snap = svc.snapshot('s-real')
    assert.equal(snap.rows.length, 1)
    assert.equal(snap.rows[0].turn, 0)
    // 别的会话看不到它（全局桶才会被合并进来）。
    assert.equal(svc.snapshot('s-other').rows.length, 0)
  })
})
