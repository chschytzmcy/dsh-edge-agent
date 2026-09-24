/**
 * §7.93 Phase 3 — tool-runner:needle function_calls 的 TS 执行边界。
 *
 * 执法链断言(与 LLM-produced tool_calls 同等待遇):
 *   - schema 面校验:幻觉工具名拒(不 POST 给 needle 的名字不执行)
 *   - ungrounded:required 捏造 → skip(不执行,留给 synthesis);
 *     非 required → drop 后照常执行;别的工具的条目不误伤
 *   - realm 预检:deny → needle.realm_rejected(security 级),宿主不进
 *   - 宿主执行:ctx.tools.execute 收 {callId,name,arguments,agent(同一性
 *     透传 — Layer 3 靠 agent.session.id 解析 realm),signal}
 *   - 失败契约:host throw / isError 都归一成 outcome,永不 throw
 *   - 审计纪律:payload 只有 metadata,绝不落 arguments/result 内容
 *   - executeAll 顺序执行,单个失败不断链
 */
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import {
  ToolRunner,
  extractResultText,
  partitionUngrounded,
  requiredArgsOf,
  type NeedleFunctionCall,
  type NeedleToolSchemaLike,
  type ToolExecutionResultLike,
} from '../../src/dsh-adapter/tool-runner.js'

// ── fixtures ────────────────────────────────────────────────────────────────
// PII 纪律(test-fixture-no-real-pii):全部占位号。

const PII_MARKER_ARGS = '13800000000'   // 出现在 arguments 里
const PII_MARKER_RESULT = '110101199001011234' // 出现在 result content 里

function makeSchemas(): NeedleToolSchemaLike[] {
  return [
    {
      name: 'get_weather',
      description: 'Get weather',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' }, date: { type: 'string' } },
        required: ['city'],
      },
    },
    {
      name: 'send_message',
      description: 'Send a message',
      parameters: {
        type: 'object',
        properties: { contact: { type: 'string' }, text: { type: 'string' } },
        required: ['contact', 'text'],
      },
    },
    {
      name: 'bash',
      description: 'Run a command',
      parameters: { type: 'object', properties: { command: { type: 'string' } } },
    },
  ]
}

interface HostCall {
  callId: string
  name: string
  arguments: unknown
  agent: unknown
  signal: AbortSignal
}

function makeHost(impl?: (input: HostCall) => Promise<ToolExecutionResultLike> | ToolExecutionResultLike) {
  const calls: HostCall[] = []
  const host = {
    execute: async (input: HostCall) => {
      calls.push(input)
      if (impl) return impl(input)
      return {
        isError: false,
        content: [{ type: 'text', text: `result-of-${input.name}` }],
      } satisfies ToolExecutionResultLike
    },
  }
  return { host, calls }
}

function makeBridge(opts?: { realm?: string; denyReason?: string }) {
  const seen: Array<{ name: string; realm: string | undefined }> = []
  return {
    bridge: {
      getAgentRealm: (_agent: unknown) => opts?.realm ?? 'LOCAL',
      checkToolRealm: (name: string, realm: string | undefined) => {
        seen.push({ name, realm })
        return opts?.denyReason
      },
    },
    seen,
  }
}

function makeAudit() {
  const entries: Array<{ level: string; kind: string; source: string; payload?: Record<string, unknown> }> = []
  return {
    entries,
    auditLog: { log: (e: any) => { entries.push(e) } },
    kinds: () => entries.map(e => e.kind),
    find: (kind: string) => entries.find(e => e.kind === kind),
  }
}

function makeLogs() {
  const lines: string[] = []
  return { lines, logger: { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m) } }
}

/** payload.agent 同一性透传的假 agent(带 session.id,Layer 3 的 realm 键)。 */
const AGENT = { session: { id: 'sess-abc-0001' } }

function makeRunner(opts?: {
  host?: ReturnType<typeof makeHost>['host']
  bridge?: ReturnType<typeof makeBridge>['bridge']
  auditLog?: ReturnType<typeof makeAudit>['auditLog']
  logger?: ReturnType<typeof makeLogs>['logger']
}) {
  const runner = new ToolRunner({
    tools: opts?.host ?? makeHost().host,
    realmSkillBridge: opts?.bridge ?? makeBridge().bridge,
    auditLog: opts?.auditLog,
    logger: opts?.logger,
  })
  return { runner }
}

function baseReq(overrides?: Partial<Parameters<ToolRunner['execute']>[0]>): Parameters<ToolRunner['execute']>[0] {
  return {
    call: { name: 'get_weather', arguments: { city: 'Lagos' } },
    agent: AGENT,
    sessionId: 'sess-abc-0001',
    schemas: makeSchemas(),
    ...overrides,
  }
}

// ── pure helpers ────────────────────────────────────────────────────────────

describe('tool-runner: pure helpers', () => {
  it('extractResultText 拼 text 块,跳过非 text 块,非数组 → ""', () => {
    assert.equal(extractResultText([{ type: 'text', text: 'a' }, { type: 'image' } as any, { type: 'text', text: 'b' }]), 'ab')
    assert.equal(extractResultText(undefined), '')
    assert.equal(extractResultText([] as any), '')
  })

  it('requiredArgsOf:防御性抽取(required 非数组/含非 string → 过滤)', () => {
    assert.deepEqual(requiredArgsOf(makeSchemas()[0]), ['city'])
    assert.deepEqual(requiredArgsOf(makeSchemas()[2]), []) // 无 required
    assert.deepEqual(requiredArgsOf(undefined), [])
    assert.deepEqual(
      requiredArgsOf({ name: 'x', description: '', parameters: { required: ['a', 42, null] as any } }),
      ['a'],
    )
  })

  it('partitionUngrounded:required → skip,非 required → drop,别家条目不误伤', () => {
    const schemas = makeSchemas()
    // send_message: contact+text 都 required;bash: command 非 required
    assert.deepEqual(
      partitionUngrounded('send_message', ['send_message.text', 'send_message.contact'], schemas[1]),
      { skip: ['text', 'contact'], drop: [] },
    )
    assert.deepEqual(
      partitionUngrounded('bash', ['bash.command'], schemas[2]),
      { skip: [], drop: ['command'] },
    )
    // 别的工具的前缀 + 垃圾条目全部忽略
    assert.deepEqual(
      partitionUngrounded('bash', ['send_message.text', 'bash.', 42 as any, 'bashX.command'], schemas[2]),
      { skip: [], drop: [] },
    )
    assert.deepEqual(partitionUngrounded('bash', undefined, schemas[2]), { skip: [], drop: [] })
  })
})

// ── happy path ──────────────────────────────────────────────────────────────

describe('tool-runner: executed', () => {
  it('高置信 call → 宿主 execute 收 {callId,name,arguments,agent 同一性,signal},outcome.executed + 文本投影', async () => {
    const h = makeHost()
    const a = makeAudit()
    const { runner } = makeRunner({ host: h.host, auditLog: a.auditLog })

    const outcome = await runner.execute(baseReq())

    assert.equal(outcome.status, 'executed')
    assert.equal(outcome.name, 'get_weather')
    assert.equal(outcome.text, 'result-of-get_weather')
    assert.deepEqual(outcome.executedArguments, { city: 'Lagos' })
    assert.equal(outcome.reason, undefined)
    assert.ok(outcome.durationMs >= 0)

    // 宿主收到的输入
    assert.equal(h.calls.length, 1)
    const input = h.calls[0]!
    assert.equal(input.name, 'get_weather')
    assert.deepEqual(input.arguments, { city: 'Lagos' })
    assert.equal(input.agent, AGENT, 'agent 必须同一性透传 —— Layer 3 靠 agent.session.id 解析 realm,假 agent = fail-open')
    assert.equal(input.callId, outcome.callId)
    assert.ok(input.callId.startsWith('needle-sess-abc-00'), `callId 带 session 前缀: ${input.callId}`)
    assert.ok(input.signal instanceof AbortSignal, '缺省 signal 时 runner 自建超时信号')

    // audit:needle.executed(info 级,metadata only)
    const executed = a.find('needle.executed')
    assert.ok(executed, `audit kinds: ${a.kinds()}`)
    assert.equal(executed!.level, 'info')
    assert.equal(executed!.payload?.name, 'get_weather')
    assert.equal(executed!.payload?.resultLen, 'result-of-get_weather'.length)
  })

  it('arguments 缺失/非对象 → 默认 {} 照常执行', async () => {
    const h = makeHost()
    const { runner } = makeRunner({ host: h.host })
    const o1 = await runner.execute(baseReq({ call: { name: 'bash' } }))
    assert.equal(o1.status, 'executed')
    assert.deepEqual(h.calls[0]!.arguments, {})
    const o2 = await runner.execute(baseReq({ call: { name: 'bash', arguments: 'rm -rf' as any } }))
    assert.equal(o2.status, 'executed')
    assert.deepEqual(h.calls[1]!.arguments, {})
  })

  it('caller signal 透传(不自建)', async () => {
    const h = makeHost()
    const { runner } = makeRunner({ host: h.host })
    const ac = new AbortController()
    await runner.execute(baseReq({ signal: ac.signal }))
    assert.equal(h.calls[0]!.signal, ac.signal)
  })

  it('callId 单调唯一(同 ms 两 call 不撞号)', async () => {
    const h = makeHost()
    const { runner } = makeRunner({ host: h.host })
    const a = await runner.execute(baseReq())
    const b = await runner.execute(baseReq())
    assert.notEqual(a.callId, b.callId)
  })
})

// ── realm / schema enforcement ──────────────────────────────────────────────

describe('tool-runner: 执法链', () => {
  it('realm 预检 deny → denied + needle.realm_rejected(security 级),宿主不进', async () => {
    const h = makeHost()
    const a = makeAudit()
    const { bridge } = makeBridge({ realm: 'LOCAL', denyReason: 'Tool "web_search" (CLOUD) not allowed in LOCAL realm' })
    const runner = new ToolRunner({ tools: h.host, realmSkillBridge: bridge, auditLog: a.auditLog })

    const outcome = await runner.execute(baseReq({
      call: { name: 'get_weather', arguments: { city: 'Lagos' } },
    }))

    assert.equal(outcome.status, 'denied')
    assert.match(outcome.reason!, /not allowed in LOCAL realm/)
    assert.equal(h.calls.length, 0, 'deny 后宿主管线不进')
    const rej = a.find('needle.realm_rejected')
    assert.ok(rej)
    assert.equal(rej!.level, 'security')
    assert.equal(rej!.payload?.agentRealm, 'LOCAL')
  })

  it('幻觉工具名(∉ POST 给 needle 的 schemas)→ denied + needle.unknown_tool,宿主不进', async () => {
    const h = makeHost()
    const a = makeAudit()
    const { runner } = makeRunner({ host: h.host, auditLog: a.auditLog })

    const outcome = await runner.execute(baseReq({
      call: { name: 'launch_missiles', arguments: { target: 'moon' } },
    }))

    assert.equal(outcome.status, 'denied')
    assert.match(outcome.reason!, /unknown_tool/)
    assert.equal(h.calls.length, 0)
    assert.equal(a.find('needle.unknown_tool')?.level, 'warn')
  })

  it('name 缺失/非 string → denied invalid_call', async () => {
    const h = makeHost()
    const { runner } = makeRunner({ host: h.host })
    const outcome = await runner.execute(baseReq({ call: { name: '' } }))
    assert.equal(outcome.status, 'denied')
    assert.match(outcome.reason!, /invalid_call/)
    assert.equal(h.calls.length, 0)
  })

  it('ungrounded required → skipped + needle.fabricated_arg(action=skip),宿主不进', async () => {
    // 实测场景(memory v2):"Send a message to 张三" → text 被捏造成 "👍",
    // validation.ungrounded=["send_message.text"] → 不执行,留给 synthesis。
    const h = makeHost()
    const a = makeAudit()
    const { runner } = makeRunner({ host: h.host, auditLog: a.auditLog })

    const outcome = await runner.execute(baseReq({
      call: { name: 'send_message', arguments: { contact: '张三', text: '👍' } },
      ungrounded: ['send_message.text'],
    }))

    assert.equal(outcome.status, 'skipped')
    assert.deepEqual(outcome.fabricatedArgs, ['text'])
    assert.match(outcome.reason!, /fabricated required argument/)
    assert.equal(h.calls.length, 0, 'required 捏造的 call 绝不执行')
    const fab = a.find('needle.fabricated_arg')
    assert.ok(fab)
    assert.equal(fab!.payload?.action, 'skip')
    assert.deepEqual(fab!.payload?.fabricatedArgs, ['text'])
  })

  it('ungrounded 非 required → 剥除后照常执行(action=drop),幻觉值不进工具', async () => {
    const h = makeHost()
    const a = makeAudit()
    const { runner } = makeRunner({ host: h.host, auditLog: a.auditLog })

    const outcome = await runner.execute(baseReq({
      call: { name: 'get_weather', arguments: { city: 'Lagos', date: '幻觉日期' } },
      ungrounded: ['get_weather.date'],
    }))

    assert.equal(outcome.status, 'executed')
    assert.deepEqual(outcome.executedArguments, { city: 'Lagos' }, '捏造的 date 已剥除')
    assert.deepEqual(outcome.fabricatedArgs, ['date'])
    assert.deepEqual(h.calls[0]!.arguments, { city: 'Lagos' })
    assert.equal(a.find('needle.fabricated_arg')?.payload?.action, 'drop')
  })

  it('别家工具的 ungrounded 条目不误伤本 call', async () => {
    const h = makeHost()
    const { runner } = makeRunner({ host: h.host })
    const outcome = await runner.execute(baseReq({
      call: { name: 'get_weather', arguments: { city: 'Lagos' } },
      ungrounded: ['send_message.text', 'bash.command'],
    }))
    assert.equal(outcome.status, 'executed')
    assert.deepEqual(outcome.executedArguments, { city: 'Lagos' })
  })
})

// ── failure paths ───────────────────────────────────────────────────────────

describe('tool-runner: 失败契约(永不 throw)', () => {
  it('宿主 execute throw → error + needle.execution_failed(thrown=true)', async () => {
    const h = makeHost(async () => { throw new Error('cannot get property tools without inject') })
    const a = makeAudit()
    const { runner } = makeRunner({ host: h.host, auditLog: a.auditLog })

    const outcome = await runner.execute(baseReq())

    assert.equal(outcome.status, 'error')
    assert.match(outcome.reason!, /without inject/)
    const failed = a.find('needle.execution_failed')
    assert.ok(failed)
    assert.equal(failed!.level, 'warn')
    assert.equal(failed!.payload?.thrown, true)
  })

  it('宿主返回 isError → error + needle.execution_failed(带 errorCode)', async () => {
    const h = makeHost(async () => ({
      isError: true,
      error: { message: 'network unreachable', info: { name: 'WebFetchError', code: 'NETWORK' } },
      content: [{ type: 'text', text: 'error text' }],
    }))
    const a = makeAudit()
    const { runner } = makeRunner({ host: h.host, auditLog: a.auditLog })

    const outcome = await runner.execute(baseReq())

    assert.equal(outcome.status, 'error')
    assert.equal(outcome.reason, 'network unreachable')
    assert.equal(a.find('needle.execution_failed')?.payload?.errorCode, 'NETWORK')
  })

  it('auditLog.log 自身 throw → 执行链不断(audit 失败不阻断)', async () => {
    const h = makeHost()
    const boom = { log: () => { throw new Error('audit disk full') } }
    const runner = new ToolRunner({ tools: h.host, realmSkillBridge: makeBridge().bridge, auditLog: boom })
    const outcome = await runner.execute(baseReq())
    assert.equal(outcome.status, 'executed')
  })
})

// ── executeAll ──────────────────────────────────────────────────────────────

describe('tool-runner: executeAll', () => {
  it('顺序执行、顺序保真,单个失败不断链', async () => {
    const order: string[] = []
    const h = makeHost(async (input) => {
      order.push(input.name)
      if (input.name === 'bash') return { isError: true, error: { message: 'boom' }, content: [] }
      return { isError: false, content: [{ type: 'text', text: `ok-${input.name}` }] }
    })
    const a = makeAudit()
    const { runner } = makeRunner({ host: h.host, auditLog: a.auditLog })

    const calls: NeedleFunctionCall[] = [
      { name: 'get_weather', arguments: { city: 'Lagos' } },
      { name: 'bash', arguments: { command: 'echo 192.0.2.1' } },
      { name: 'send_message', arguments: { contact: '张三', text: 'hi' } },
    ]
    const outcomes = await runner.executeAll(calls, {
      agent: AGENT,
      sessionId: 'sess-abc-0001',
      schemas: makeSchemas(),
    })

    assert.deepEqual(order, ['get_weather', 'bash', 'send_message'], '顺序执行(并发是宿主 scheduler 的领地)')
    assert.deepEqual(outcomes.map(o => o.status), ['executed', 'error', 'executed'])
    assert.equal(outcomes[0]!.text, 'ok-get_weather')
    assert.equal(outcomes[1]!.reason, 'boom')
    assert.equal(outcomes[2]!.text, 'ok-send_message')
    // 每个 executed/error 都有对应 audit
    assert.equal(a.entries.filter(e => e.kind === 'needle.executed').length, 2)
    assert.equal(a.entries.filter(e => e.kind === 'needle.execution_failed').length, 1)
  })

  it('空 calls / undefined → [](绝不 POST 空集给 needle 的对偶:空集不执行)', async () => {
    const h = makeHost()
    const { runner } = makeRunner({ host: h.host })
    assert.deepEqual(await runner.executeAll([], { agent: AGENT, schemas: makeSchemas() }), [])
    assert.deepEqual(await runner.executeAll(undefined as any, { agent: AGENT, schemas: makeSchemas() }), [])
    assert.equal(h.calls.length, 0)
  })
})

// ── audit hygiene (PII 纪律) ────────────────────────────────────────────────

describe('tool-runner: audit 只落 metadata', () => {
  it('arguments 内容与 result 内容绝不出现在任何 audit payload / ops log', async () => {
    const h = makeHost(async () => ({
      isError: false,
      content: [{ type: 'text', text: `身份证 ${PII_MARKER_RESULT} 已处理` }],
    }))
    const a = makeAudit()
    const logs = makeLogs()
    const runner = new ToolRunner({
      tools: h.host,
      realmSkillBridge: makeBridge().bridge,
      auditLog: a.auditLog,
      logger: logs.logger,
    })

    await runner.execute(baseReq({
      call: { name: 'get_weather', arguments: { city: `手机号 ${PII_MARKER_ARGS}` } },
    }))

    const auditDump = JSON.stringify(a.entries)
    assert.ok(!auditDump.includes(PII_MARKER_ARGS), 'audit 落了 arguments 内容')
    assert.ok(!auditDump.includes(PII_MARKER_RESULT), 'audit 落了 result 内容')
    const logDump = logs.lines.join('\n')
    assert.ok(!logDump.includes(PII_MARKER_ARGS), 'ops log 落了 arguments 内容')
    assert.ok(!logDump.includes(PII_MARKER_RESULT), 'ops log 落了 result 内容')
    // metadata 该有的都有
    const executed = a.find('needle.executed')!
    assert.equal(typeof executed.payload?.durationMs, 'number')
    assert.equal(typeof executed.payload?.resultLen, 'number')
  })

  it('ops log 每个 outcome 一行(status/tool/callId/sessionId/durationMs)', async () => {
    const h = makeHost()
    const logs = makeLogs()
    const runner = new ToolRunner({
      tools: h.host,
      realmSkillBridge: makeBridge().bridge,
      auditLog: makeAudit().auditLog,
      logger: logs.logger,
    })
    await runner.execute(baseReq())
    assert.equal(logs.lines.length, 1)
    assert.match(logs.lines[0]!, /\[tool-runner\] executed tool=get_weather callId=needle-\S+ sessionId=sess-abc-0001 durationMs=\d+/)
  })
})
