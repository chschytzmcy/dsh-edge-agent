/**
 * §7.58 (2026-09-16) input-guard Pass 0：重复 tool_call id 唯一化测试。
 *
 * 脏数据来源：旧版 openai-sse.ts 的 tool-call-delta / block-end 索引错位
 * （已源头修复），宿主 BlockAssembler 按 index 分块 → 一条 assistant 消息
 * 里出现两个 id/name/arguments 全同的 tool-call 块（session 24303d6a
 * turn 2 实测），两份 tool-result 共用同一 callId。该历史回放时 DeepSeek
 * 400 "Duplicate value for 'tool_call_id' … in message[N]"。
 *
 * 本文件测清洗层（sanitizeOrphanToolCalls 的 Pass 0）；源头修复的行为在
 * tests/unit/openai-sse-tool-call-index.test.ts 测。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

import { InputGuardServiceImpl } from '../../src/dsh-adapter/input-guard.ts'
import type { Config } from '../../src/dsh-adapter/input-guard.ts'

function fakeCtx() {
  return {
    reflect: { provide(_n: string, _v: unknown) { return () => {} } },
    provide(_n: string, _v: unknown) { return () => {} },
  }
}

function fakeAuditLog() {
  const entries: any[] = []
  return {
    entries,
    api: { async log(entry: any) { entries.push(entry) } },
  }
}

function defaultConfig(overrides: Partial<Config> = {}): Config {
  return {
    enableInputGuard: true,
    sanitizeLocalTraffic: false,
    rejectOnPolicyViolation: true,
    downgradeOnSanitizeFailure: true,
    localProvider: 'local-llm',
    localModel: 'qwen3-4b-instruct-2507',
    cloudApiKeyEnv: 'DEEPSEEK_API_KEY',
    defaultCloudProvider: 'cloud-llm',
    defaultCloudModel: 'deepseek-chat',
    ...overrides,
  }
}

const DUP_ID = 'call_00_QeghpJyr4wEMTBhWdTvJ9275'

function makeSvc(audit = fakeAuditLog()) {
  const svc = new InputGuardServiceImpl(
    fakeCtx() as any, defaultConfig(),
    undefined, undefined, undefined, undefined, audit.api as any,
  )
  return { svc, audit }
}

/** 事故历史的 dsh content-block 形状（assistant 双块 + 双 result 共用 id）。 */
function poisonedHistory(): Array<Record<string, unknown>> {
  return [
    { role: 'system', content: 'sys' },
    { role: 'user', content: [{ type: 'text', text: '查询共登陆了几个密盒' }] },
    { role: 'assistant', content: [
      { type: 'tool-call', id: DUP_ID, name: 'bash', arguments: '{"command":"etscli auth list"}' },
      { type: 'tool-call', id: DUP_ID, name: 'bash', arguments: '{"command":"etscli auth list"}' },
    ] },
    { role: 'user', source: { kind: 'tool', callId: DUP_ID }, content: [
      { type: 'tool-result', toolCallId: DUP_ID, content: [{ type: 'text', text: 'ACTIVE ...' }], isError: false },
    ] },
    { role: 'user', source: { kind: 'tool', callId: DUP_ID }, content: [
      { type: 'tool-result', toolCallId: DUP_ID, content: [{ type: 'text', text: 'ACTIVE ... (2)' }], isError: false },
    ] },
  ]
}

describe('sanitizeOrphanToolCalls §7.58 duplicate tool_call ids', () => {
  it('renames duplicate calls, re-pairs results, keeps orphanCount=0', () => {
    const { svc } = makeSvc()
    const result = svc.sanitizeOrphanToolCalls(poisonedHistory(), 'sess-dup')
    assert.equal(result.duplicateCount, 1)
    assert.equal(result.orphanCount, 0, '改名后 call↔result 配对仍完整')
    assert.equal(result.syntheticInjected, 0)
    const assistant = result.messages[2] as any
    assert.equal(assistant.content[0].id, DUP_ID, '第 1 次出现保留原 id')
    assert.equal(assistant.content[1].id, `${DUP_ID}-dup2`)
    // 块形状其余字段不动
    assert.equal(assistant.content[1].name, 'bash')
    assert.equal(assistant.content[1].arguments, '{"command":"etscli auth list"}')
    const r1 = result.messages[3] as any
    const r2 = result.messages[4] as any
    assert.equal(r1.content[0].toolCallId, DUP_ID)
    assert.equal(r1.source.callId, DUP_ID)
    assert.equal(r2.content[0].toolCallId, `${DUP_ID}-dup2`)
    assert.equal(r2.source.callId, `${DUP_ID}-dup2`, 'source.callId 同步改名')
    const ids = [
      assistant.content[0].id, assistant.content[1].id,
      r1.content[0].toolCallId, r2.content[0].toolCallId,
    ]
    assert.equal(new Set(ids).size, 2, '两个唯一 id，每个 call↔result 各配一对')
  })

  it('untouched messages keep object identity', () => {
    const { svc } = makeSvc()
    const history = poisonedHistory()
    const result = svc.sanitizeOrphanToolCalls(history, 'sess-dup-idem')
    assert.equal(result.messages[0], history[0])
    assert.equal(result.messages[1], history[1])
    assert.equal(result.messages[3], history[3], '第 1 个 result 未改名 → 原对象透传')
    assert.notEqual(result.messages[2], history[2])
    assert.notEqual(result.messages[4], history[4])
  })

  it('does not mutate the input messages (deepFreeze-safe)', () => {
    const { svc } = makeSvc()
    const history = poisonedHistory()
    const before = JSON.stringify(history)
    svc.sanitizeOrphanToolCalls(history)
    assert.equal(JSON.stringify(history), before, '不应修改入参')
  })

  it('three duplicates → -dup2/-dup3 with occurrence pairing', () => {
    const { svc } = makeSvc()
    const history: Array<Record<string, unknown>> = [
      { role: 'assistant', content: [
        { type: 'tool-call', id: DUP_ID, name: 'bash', arguments: '{}' },
        { type: 'tool-call', id: DUP_ID, name: 'bash', arguments: '{}' },
        { type: 'tool-call', id: DUP_ID, name: 'bash', arguments: '{}' },
      ] },
      { role: 'user', source: { kind: 'tool', callId: DUP_ID }, content: [{ type: 'tool-result', toolCallId: DUP_ID }] },
      { role: 'user', source: { kind: 'tool', callId: DUP_ID }, content: [{ type: 'tool-result', toolCallId: DUP_ID }] },
      { role: 'user', source: { kind: 'tool', callId: DUP_ID }, content: [{ type: 'tool-result', toolCallId: DUP_ID }] },
    ]
    const result = svc.sanitizeOrphanToolCalls(history, 'sess-tri')
    assert.equal(result.duplicateCount, 2)
    const assistant = result.messages[0] as any
    assert.deepEqual(
      assistant.content.map((b: any) => b.id),
      [DUP_ID, `${DUP_ID}-dup2`, `${DUP_ID}-dup3`],
    )
    assert.deepEqual(
      result.messages.slice(1).map((m: any) => m.content[0].toolCallId),
      [DUP_ID, `${DUP_ID}-dup2`, `${DUP_ID}-dup3`],
    )
    assert.equal(result.orphanCount, 0)
  })

  it('collision-safe: an existing "-dupN" id forces the x suffix', () => {
    const { svc } = makeSvc()
    const history: Array<Record<string, unknown>> = [
      { role: 'assistant', content: [
        { type: 'tool-call', id: DUP_ID, name: 'a', arguments: '{}' },
        { type: 'tool-call', id: DUP_ID, name: 'a', arguments: '{}' },
        { type: 'tool-call', id: `${DUP_ID}-dup2`, name: 'b', arguments: '{}' },
      ] },
      { role: 'user', source: { kind: 'tool', callId: DUP_ID }, content: [{ type: 'tool-result', toolCallId: DUP_ID }] },
      { role: 'user', source: { kind: 'tool', callId: DUP_ID }, content: [{ type: 'tool-result', toolCallId: DUP_ID }] },
      { role: 'user', source: { kind: 'tool', callId: `${DUP_ID}-dup2` }, content: [{ type: 'tool-result', toolCallId: `${DUP_ID}-dup2` }] },
    ]
    const result = svc.sanitizeOrphanToolCalls(history, 'sess-collide')
    assert.equal(result.orphanCount, 0)
    const assistant = result.messages[0] as any
    assert.equal(assistant.content[1].id, `${DUP_ID}-dup2x`, '撞名后追加 x')
    assert.equal(assistant.content[2].id, `${DUP_ID}-dup2`, '历史里本就存在的 id 不动')
    assert.deepEqual(
      result.messages.slice(1).map((m: any) => m.content[0].toolCallId),
      [DUP_ID, `${DUP_ID}-dup2x`, `${DUP_ID}-dup2`],
      'result 引用配对 call 的落定 id（撞名的让位只发生在 call 侧）',
    )
    assert.deepEqual(
      result.messages.slice(1).map((m: any) => m.source.callId),
      [DUP_ID, `${DUP_ID}-dup2x`, `${DUP_ID}-dup2`],
      'source.callId 同步',
    )
  })

  it('clean history → duplicateCount 0, full pass-through', () => {
    const { svc } = makeSvc()
    const history: Array<Record<string, unknown>> = [
      { role: 'assistant', content: [
        { type: 'tool-call', id: 'call_a', name: 'a', arguments: '{}' },
        { type: 'tool-call', id: 'call_b', name: 'b', arguments: '{}' },
      ] },
      { role: 'user', source: { kind: 'tool', callId: 'call_a' }, content: [{ type: 'tool-result', toolCallId: 'call_a' }] },
      { role: 'user', source: { kind: 'tool', callId: 'call_b' }, content: [{ type: 'tool-result', toolCallId: 'call_b' }] },
    ]
    const result = svc.sanitizeOrphanToolCalls(history, 'sess-clean')
    assert.equal(result.duplicateCount, 0)
    assert.equal(result.orphanCount, 0)
    result.messages.forEach((m, i) => assert.equal(m, history[i], `消息 ${i} 应原样透传`))
  })

  it('pass-through when enableInputGuard=false', () => {
    const svc = new InputGuardServiceImpl(
      fakeCtx() as any, defaultConfig({ enableInputGuard: false }),
      undefined, undefined, undefined, undefined, fakeAuditLog().api as any,
    )
    const history = poisonedHistory()
    const result = svc.sanitizeOrphanToolCalls(history, 'sess-off')
    assert.equal(result.duplicateCount, 0)
    assert.equal(result.messages[2], history[2])
    // 重复块原样保留（不洗）
    const assistant = result.messages[2] as any
    assert.equal(assistant.content[0].id, assistant.content[1].id)
  })

  it('audits + ops-log lines when repaired', async () => {
    const audit = fakeAuditLog()
    const warnLines: string[] = []
    const infoLines: string[] = []
    const ctx = {
      reflect: { provide(_n: string, _v: unknown) { return () => {} } },
      provide(_n: string, _v: unknown) { return () => {} },
      logger: {
        info: (l: string) => { infoLines.push(l) },
        warn: (l: string) => { warnLines.push(l) },
        error: (_l: string) => {},
        debug: (_l: string) => {},
      },
    }
    const svc = new InputGuardServiceImpl(
      ctx as any, defaultConfig(),
      undefined, undefined, undefined, undefined, audit.api as any,
    )
    svc.sanitizeOrphanToolCalls(poisonedHistory(), 'sess-audit')
    assert.ok(
      warnLines.some((l) => l.includes('duplicate-tool-call-id summary') && l.includes('renamedCalls=1')),
      `ops log 应有 duplicate summary 行，got: ${JSON.stringify(warnLines)}`,
    )
    assert.ok(
      infoLines.some((l) => l.includes('orphan-tool-call summary') && l.includes('duplicateRenamed=1')),
      `orphan summary 行（info）应带 duplicateRenamed 字段，got: ${JSON.stringify(infoLines)}`,
    )
    const entry = audit.entries.find((e: any) => e.kind === 'input-guard.duplicate-tool-call-id.recovered')
    assert.ok(entry, 'duplicate-tool-call-id audit 应发出')
    assert.equal(entry.level, 'warn')
    assert.equal(entry.payload.duplicateCount, 1)
    assert.equal(entry.payload.sessionId, 'sess-audit')
    await new Promise((r) => setImmediate(r))
  })
})
