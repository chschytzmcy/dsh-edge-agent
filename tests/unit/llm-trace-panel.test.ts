/**
 * §7.133 — Edge 标签下的 LLM 调用记录（索引 + 按需拉正文）
 *
 * 覆盖五件事：
 *
 *  1. **store 的 ring 淘汰**：条数上限与字节上限双生效，丢最旧的；
 *  2. **索引行只提取标量**：正文不进 audit 行（单轮主对话 request 实测
 *     22.5 万字符 —— 进 audit 行会让面板常驻内存随轮次线性膨胀）；
 *  3. **emitTrace 三通路**：ops log（§7.118 的老行为不变）+ audit 索引行
 *     （面板的数据源）+ 正文 store（点开才取）；
 *  4. **检测调用单独标记**：安检（prompt-guard）/ 分类器（intent-classifier）
 *     与主对话出网分开 —— 沿用 §7.132 的 `edgeInternalCaller` 体系；
 *  5. **取不到就说取不到**：HTTP 路由对「id 不存在」回 404 而不是回一个
 *     空对象冒充「正文是空的」。
 */
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'vitest'
import {
  DEFAULT_LLM_TRACE_CONFIG,
  buildRequestTrace,
  buildResponseTrace,
  buildTraceIndex,
  emitTrace,
  type TraceSink,
} from '../../src/dsh-adapter/llm-trace.js'
import {
  DEFAULT_TRACE_STORE_OPTIONS,
  LlmTraceStore,
  formatTraceId,
  getTraceStore,
  provideTraceStore,
} from '../../src/dsh-adapter/llm-trace-store.js'
import { internalCallerOf, withInternalCaller } from '../../src/dsh-adapter/llm-internal-caller.js'
import { panelForKind } from '../../src/dsh-adapter/edge-context-view.js'
import { readTraceIndex, callerLabel } from '../../src/client/tracePanel'
import type { EdgeRow } from '../../src/client/types'

/* ── 1. store 的 ring 淘汰 ─────────────────────────────────────────────── */

describe('§7.133 LlmTraceStore', () => {
  it('drops the oldest entry when the count cap is hit', () => {
    const store = new LlmTraceStore({ maxEntries: 3, maxBytes: 1_000_000 })
    for (let i = 0; i < 5; i++) store.put(`t${i}`, { kind: 'REQ', trace: { i } })
    assert.equal(store.size(), 3)
    assert.equal(store.get('t0'), undefined)
    assert.equal(store.get('t1'), undefined)
    assert.notEqual(store.get('t4'), undefined)
  })

  it('drops the oldest entry when the byte cap is hit', () => {
    // 每条约 1KB → 4 条就撑爆 3KB 的上限。
    const store = new LlmTraceStore({ maxEntries: 100, maxBytes: 3_000 })
    const blob = 'x'.repeat(1000)
    for (let i = 0; i < 5; i++) store.put(`t${i}`, { kind: 'REQ', trace: { blob } })
    assert.ok(store.size() < 5, `eviction did not run: ${store.size()}`)
    assert.equal(store.get('t0'), undefined)
    assert.notEqual(store.get('t4'), undefined)
  })

  it('keeps the caller tag on the stored entry', () => {
    const store = new LlmTraceStore()
    store.put('t1', { kind: 'REQ', caller: 'prompt-guard', trace: { a: 1 } })
    assert.equal(store.get('t1')?.caller, 'prompt-guard')
    assert.equal(store.get('t1')?.kind, 'REQ')
  })

  it('rewrites in place when the same id is stored twice', () => {
    const store = new LlmTraceStore()
    store.put('t1', { kind: 'REQ', trace: { a: 1 } })
    store.put('t1', { kind: 'RESP', trace: { a: 2 } })
    assert.equal(store.size(), 1)
    assert.equal(store.get('t1')?.kind, 'RESP')
  })

  it('has sane defaults (64 entries / 2 MB)', () => {
    assert.equal(DEFAULT_TRACE_STORE_OPTIONS.maxEntries, 64)
    assert.equal(DEFAULT_TRACE_STORE_OPTIONS.maxBytes, 2 * 1024 * 1024)
  })

  it('builds a sortable, unique-per-process trace id', () => {
    assert.equal(formatTraceId(0, 1000), formatTraceId(0, 1000))
    assert.notEqual(formatTraceId(0, 1000), formatTraceId(1, 1000))
  })

  it('hands the SAME instance to every caller (module singleton)', () => {
    // 写方（adapter / 安检 / 分类器）与读方（面板）必须落在同一个 store ——
    // 否则面板点开索引行会永远 404。
    const a = getTraceStore()
    const b = provideTraceStore({})
    assert.equal(a, b)
    assert.equal(getTraceStore(), a)
  })
})

/* ── 2. 索引行只提取标量 ───────────────────────────────────────────────── */

describe('§7.133 buildTraceIndex', () => {
  const requestTrace = buildRequestTrace({
    sessionId: 's1',
    provider: 'local-llm',
    model: 'MiniMax-M3.1-Flash',
    baseUrl: 'https://example.invalid/v1',
    system: 'you are a classifier',
    messages: [{ role: 'user', content: [{ type: 'text', text: '开灯' }] }],
    tools: [{ name: 'bash' }, { name: 'read' }],
    config: DEFAULT_LLM_TRACE_CONFIG,
  })

  it('extracts only scalars — the body never rides along', () => {
    const idx = buildTraceIndex('t1', 'REQ', requestTrace)
    assert.equal(idx.traceId, 't1')
    assert.equal(idx.kind, 'REQ')
    assert.equal(idx.provider, 'local-llm')
    assert.equal(idx.model, 'MiniMax-M3.1-Flash')
    assert.equal(idx.messageCount, 1)
    assert.equal(idx.promptLength, 2)
    assert.equal(idx.baseUrl, 'https://example.invalid/v1')
    // 正文不在索引行里 —— 一个字段都不该带。
    assert.equal((idx as Record<string, unknown>).messages, undefined)
    assert.equal((idx as Record<string, unknown>).system, undefined)
    assert.equal((idx as Record<string, unknown>).tools, undefined)
  })

  it('reports the body size so the panel can say "N KB"', () => {
    const idx = buildTraceIndex('t1', 'REQ', requestTrace)
    assert.ok((idx.bodyBytes ?? 0) > 0)
  })

  it('carries the caller tag for detection calls', () => {
    const idx = buildTraceIndex('t1', 'REQ', requestTrace, 'prompt-guard')
    assert.equal(idx.caller, 'prompt-guard')
  })

  it('omits the caller tag for the main conversation', () => {
    const idx = buildTraceIndex('t1', 'REQ', requestTrace)
    assert.equal(idx.caller, undefined)
  })

  it('counts the tools of a request (the §7.132 main-dialog discriminator)', () => {
    assert.equal(buildTraceIndex('t1', 'REQ', requestTrace).toolCount, 2)
    // response trace 里没有请求的工具表 —— 调用方用 extra 补。
    const responseTrace = buildResponseTrace({
      sessionId: 's1', provider: 'local-llm', model: 'm',
      content: 'ok', toolCalls: [], config: DEFAULT_LLM_TRACE_CONFIG,
    })
    assert.equal(buildTraceIndex('t2', 'RESP', responseTrace, undefined, { toolCount: 30 }).toolCount, 30)
  })

  it('counts the response tool calls', () => {
    const responseTrace = buildResponseTrace({
      sessionId: 's1', provider: 'local-llm', model: 'm',
      content: '', toolCalls: [{ name: 'bash', arguments: '{}' }], config: DEFAULT_LLM_TRACE_CONFIG,
    })
    assert.equal(buildTraceIndex('t2', 'RESP', responseTrace).toolCallCount, 1)
  })
})

/* ── 3. emitTrace 三通路 ───────────────────────────────────────────────── */

describe('§7.133 emitTrace', () => {
  function sink(over: Partial<TraceSink> = {}) {
    const logged: Array<{ kind: string; payload: Record<string, unknown> }> = []
    const ops: string[] = []
    const store = new LlmTraceStore()
    const s: TraceSink = {
      log: (entry) => { logged.push({ kind: entry.kind, payload: entry.payload }); return Promise.resolve() },
      logger: { info: (m) => { ops.push(m) } },
      store,
      nextTraceId: () => 't-fixed',
      ...over,
    }
    return { s, logged, ops, store }
  }

  it('writes all three channels', () => {
    const { s, logged, ops, store } = sink()
    const trace = { provider: 'local-llm', model: 'm', messageCount: 1 }
    const id = emitTrace(s, 'REQ', 'adapter LLM_REQUEST', trace)
    assert.equal(id, 't-fixed')
    // 1) ops log（§7.118 的老通路没坏）
    assert.equal(ops.length, 1)
    assert.ok(ops[0].includes('LLM_REQUEST'))
    // 2) audit 索引行（面板的数据源）
    assert.equal(logged.length, 1)
    assert.equal(logged[0].kind, 'llm.trace.index')
    assert.equal(logged[0].payload.traceId, 't-fixed')
    assert.equal(logged[0].payload.kind, 'REQ')
    // 3) 正文 store（点开才取）
    assert.notEqual(store.get('t-fixed'), undefined)
    assert.deepEqual(store.get('t-fixed')?.trace, trace)
  })

  it('tags detection calls with the internal caller', () => {
    const { s, logged, store } = sink()
    emitTrace(s, 'REQ', 'adapter LLM_REQUEST', { provider: 'local-llm' }, 'prompt-guard')
    assert.equal(logged[0].payload.caller, 'prompt-guard')
    assert.equal(store.get('t-fixed')?.caller, 'prompt-guard')
  })

  it('leaves the caller tag off the main conversation', () => {
    const { s, logged } = sink()
    emitTrace(s, 'REQ', 'adapter LLM_REQUEST', { provider: 'local-llm' })
    assert.equal(logged[0].payload.caller, undefined)
  })

  it('never lets a broken sink break the main chain', () => {
    const boom: TraceSink = {
      log: () => { throw new Error('audit down') },
      logger: { info: () => { throw new Error('logger down') } },
      store: { put: () => { throw new Error('store down') } },
    }
    assert.doesNotThrow(() => emitTrace(boom, 'REQ', 'x', {}))
  })

  it('survives a non-serializable trace (no crash, no row)', () => {
    const { s, logged } = sink()
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    assert.doesNotThrow(() => emitTrace(s, 'REQ', 'x', cyclic))
    // JSON.stringify 抛错 → buildTraceIndex 的 bodyBytes 兜底为 0，行照落。
    assert.equal(logged.length, 1)
    assert.equal(logged[0].payload.bodyBytes, 0)
  })
})

/* ── 4. 检测调用的标记体系（§7.132 复用） ─────────────────────────────── */

describe('§7.133 detection-call tagging', () => {
  it('reads the internal caller off the adapter options', () => {
    const opts = withInternalCaller({ provider: 'local-llm' }, 'prompt-guard')
    assert.equal(internalCallerOf(opts), 'prompt-guard')
    assert.equal(internalCallerOf(withInternalCaller({}, 'intent-classifier')), 'intent-classifier')
  })

  it('leaves the main conversation untagged', () => {
    assert.equal(internalCallerOf({ provider: 'local-llm' }), undefined)
    assert.equal(internalCallerOf(undefined), undefined)
  })
})

/* ── 5. 面板侧：路由 / 归属 / 取不到 ───────────────────────────────────── */

describe('§7.133 Edge panel wiring', () => {
  it('routes the index rows into the route panel', () => {
    assert.equal(panelForKind('llm.trace.index'), 'route')
  })

  it('reads an index row back into the panel shape', () => {
    const row: EdgeRow = {
      ts: 1, seq: 1, kind: 'llm.trace.index', panel: 'route', level: 'info',
      payload: {
        traceId: 't1', kind: 'RESP', provider: 'local-llm', model: 'MiniMax-M3.1-Flash',
        caller: 'prompt-guard', contentLength: 12, toolCallCount: 0, durationMs: 830,
        toolCount: 0, bodyBytes: 2048,
      },
    }
    const t = readTraceIndex(row)
    assert.ok(t)
    assert.equal(t?.traceId, 't1')
    assert.equal(t?.kind, 'RESP')
    assert.equal(t?.caller, 'prompt-guard')
    assert.equal(t?.durationMs, 830)
  })

  it('skips a row without a traceId (it could never be opened)', () => {
    const row: EdgeRow = {
      ts: 1, seq: 1, kind: 'llm.trace.index', panel: 'route', level: 'info',
      payload: { kind: 'REQ', provider: 'local-llm' },
    }
    assert.equal(readTraceIndex(row), undefined)
  })

  it('labels the three call kinds apart (§7.132 discriminator, verbatim)', () => {
    const base = { traceId: 't', kind: 'REQ' as const, provider: 'p', model: 'm' }
    assert.equal(callerLabel({ ...base, caller: 'prompt-guard' }), '安检')
    assert.equal(callerLabel({ ...base, caller: 'intent-classifier' }), '分类器')
    // 没有 caller 且一件工具没带 → 宿主的内部调用，不是主对话出网。
    assert.equal(callerLabel({ ...base, toolCount: 0 }), '宿主内部调用')
    // 没有 caller 但带工具 → 主对话出网。
    assert.equal(callerLabel({ ...base, toolCount: 30 }), '主对话')
  })
})

describe('§7.133 the adapter writes the panel rows', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function sseResponse(): Response {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    })
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }

  async function run(tools: unknown[] | undefined, caller: 'prompt-guard' | 'intent-classifier' | undefined) {
    globalThis.fetch = (async () => sseResponse()) as typeof fetch
    const rows: Array<{ kind: string; payload: Record<string, unknown> }> = []
    const auditLog = {
      log: (entry: { kind: string; payload: Record<string, unknown> }) => {
        rows.push({ kind: entry.kind, payload: entry.payload })
        return Promise.resolve()
      },
    }
    const { LocalLlmAdapterImpl } = await import('../../src/dsh-adapter/local-llm-adapter.js')
    const adapter = new LocalLlmAdapterImpl({
      providers: ['local-llm'],
      baseUrl: 'http://127.0.0.1:8080/v1',
      defaultModel: 'qwen3-4b',
    }, auditLog as never)
    const base = {
      provider: 'local-llm',
      model: '',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
      ...(tools ? { tools } : {}),
    }
    const options = caller === undefined ? base : withInternalCaller(base, caller)
    for await (const _chunk of adapter.stream(options as never)) { /* drain */ }
    return rows.filter(r => r.kind === 'llm.trace.index')
  }

  it('records a guard call with its internal caller', async () => {
    const rows = await run(undefined, 'prompt-guard')
    const req = rows.find(r => r.payload.kind === 'REQ')
    const resp = rows.find(r => r.payload.kind === 'RESP')
    assert.ok(req, 'no request index row')
    assert.ok(resp, 'no response index row')
    assert.equal(req!.payload.caller, 'prompt-guard')
    assert.equal(resp!.payload.caller, 'prompt-guard')
    // 检测调用一件工具都不带 —— §7.132 的判据。
    assert.equal(req!.payload.toolCount, 0)
    assert.equal(req!.payload.provider, 'local-llm')
    assert.equal(req!.payload.messageCount, 1)
    assert.ok(typeof req!.payload.bodyBytes === 'number')
  })

  it('records the main conversation WITHOUT a caller, and counts its tools', async () => {
    const tools = Array.from({ length: 32 }, (_, i) => ({ name: `tool${i}` }))
    const rows = await run(tools, undefined)
    const req = rows.find(r => r.payload.kind === 'REQ')
    assert.ok(req)
    assert.equal(req!.payload.caller, undefined)
    assert.equal(req!.payload.toolCount, 32)
  })

  it('records a classifier call with its internal caller', async () => {
    const rows = await run(undefined, 'intent-classifier')
    assert.equal(rows.find(r => r.payload.kind === 'REQ')?.payload.caller, 'intent-classifier')
  })
})

describe('§7.133 the panel must not render one call twice', () => {
  it('does not duplicate global-bucket rows in the _global snapshot', async () => {
    const mod = await import('../../src/dsh-adapter/edge-context-view.js')
    const svc = new mod.EdgeContextViewServiceImpl(
      { reflect: { provide: () => {} } } as never,
      { bufferSize: 8, sessionTtlMs: 60_000, piiRedact: true },
    )
    svc.record({
      ts: Date.now(), level: 'info', kind: 'llm.trace.index', source: 'llm-trace',
      payload: { traceId: 't1', kind: 'REQ', provider: 'local-llm', model: 'm' },
    })
    const global = svc.snapshot('_global', 0)
    assert.equal(global.rows.length, 1, 'the global row was rendered twice')
    // A real session snapshot still gets the global row exactly once.
    const scoped = svc.snapshot('s1', 0)
    assert.equal(scoped.rows.length, 1)
  })
})

describe('§7.133 trace body route', () => {
  interface FakeRoute {
    path: string
    methods: readonly string[]
    fetch(request: Request): Promise<Response>
  }

  function fakeCtx(routes: FakeRoute[]): unknown {
    return {
      reflect: { provide: () => {} },
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      inject: (_deps: readonly string[], cb: (raw: unknown) => void) => {
        cb({
          connection: {
            fetch: {
              register: (route: FakeRoute) => {
                routes.push(route)
                return () => {}
              },
            },
          },
        })
      },
    }
  }

  it('serves a stored body, and refuses to fake an empty one', async () => {
    const mod = await import('../../src/dsh-adapter/edge-context-view.js')
    const routes: FakeRoute[] = []
    const dispose = await mod.apply(fakeCtx(routes) as never, {
      bufferSize: 8, sessionTtlMs: 60_000, piiRedact: true,
    })
    assert.equal(mod.EDGE_TRACE_ROUTE, '/api/dsh-edge/trace')
    const route = routes.find(r => r.path === mod.EDGE_TRACE_ROUTE)
    assert.ok(route, 'trace route not registered')
    assert.deepEqual([...route.methods], ['POST'])

    // 正文在 store 里 → 200 + 正文。
    getTraceStore().put('t-hit', { kind: 'REQ', caller: 'prompt-guard', trace: { hello: 'world' } })
    const hit = await route.fetch(new Request('http://x/', {
      method: 'POST', body: JSON.stringify({ traceId: 't-hit' }),
    }))
    assert.equal(hit.status, 200)
    const body = JSON.parse(await hit.text()) as { kind: string; caller?: string; trace: { hello: string } }
    assert.equal(body.kind, 'REQ')
    assert.equal(body.caller, 'prompt-guard')
    assert.equal(body.trace.hello, 'world')

    // 正文不在 → 404（不是空对象）。
    const missing = await route.fetch(new Request('http://x/', {
      method: 'POST', body: JSON.stringify({ traceId: 'nope' }),
    }))
    assert.equal(missing.status, 404)
    assert.ok((await missing.text()).includes('trace-not-found'))

    // 没有 traceId → 400。
    const noId = await route.fetch(new Request('http://x/', {
      method: 'POST', body: JSON.stringify({}),
    }))
    assert.equal(noId.status, 400)
    assert.ok((await noId.text()).includes('missing-trace-id'))

    // 非法 JSON → 400。
    const badJson = await route.fetch(new Request('http://x/', {
      method: 'POST', body: 'not json',
    }))
    assert.equal(badJson.status, 400)

    await dispose?.()
  })
})
