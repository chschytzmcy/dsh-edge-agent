/**
 * llm-trace-store — §7.133 LLM request/response trace 的**正文存储**
 *
 * ## 为什么正文不进 audit 行
 *
 * §7.118 的 trace 走 `ctx.logger.info` → ops log 文件。而 Edge 面板的数据
 * 源是 **audit-log**（edge-context-view 的 fold）—— 两条通路不相通，所以
 * 面板看不到任何 request/response 正文。
 *
 * 修法有两条路：
 *
 *   A. 正文直接进 audit 行 —— 面板立刻能看到，但单轮主对话的 request
 *      正文实测 **22.5 万字符**（promptLength=225630）。几十轮之后，
 *      面板的常驻内存和渲染压力线性膨胀。
 *   B. 面板只放**索引**（每次调用一行摘要），正文按需拉取 —— 索引行是
 *      几十字节的标量，正文存在独立的 store 里，点开才取。
 *
 * 选 B。这与本仓一贯的纪律一致（§7.107「面板不得断言与审计数据相矛盾
 * 的事」、§7.129「宁可漏显示也不能显示一件没发生过的事」）：面板常驻
 * 的永远是**便宜的索引**，正文是**要才取**。
 *
 * ## store 的形状
 *
 * `traceId` → { kind: 'REQ' | 'RESP', caller?, trace }。ring buffer：
 * 条数与总字节双上限 —— 单条 trace 正文上限 2 万字符（trace 模块自己
 * 已按 maxChars 截断），所以 64 条 ≈ 1.3 MB 上界。
 *
 * ## 谁来写
 *
 * adapter（主对话出网）+ prompt-guard（安检）+ intent-router（分类器）。
 * 三处都经 `emitTrace()` —— 它同时落 **audit 索引行**（进面板）与
 * **正文**（进本 store）。
 *
 * 检测调用的标记沿用 §7.132 的 `edgeInternalCaller`：安检 = prompt-guard，
 * 分类器 = intent-classifier，主对话没有这个字段。面板据此把「检测调用」
 * 与「主对话出网」分开显示。
 *
 * @module dsh-edge-agent/llm-trace-store
 */

/** trace 的种类：请求 / 响应。 */
export type TraceKind = 'REQ' | 'RESP'

/**
 * 一次调用的归属。§7.132 的内部调用标记（安检 / 分类器）。
 *
 * 与 `llm-internal-caller.ts` 的 `InternalCaller` 是**同一个联合类型**
 * （两个字符串成员相同），TS 结构化类型允许互换 —— 这样 trace 模块不必
 * 依赖 adapter 模块，两边也不会各写一份而漂移。
 */
export type TraceCaller = 'prompt-guard' | 'intent-classifier'

export interface StoredTrace {
  kind: TraceKind
  /** §7.132：内部调用标记；undefined = 主对话出网。 */
  caller?: TraceCaller
  /** 完整 trace 对象（已脱敏 + 截断）。 */
  trace: unknown
}

export interface TraceStoreOptions {
  /** 最多保留多少条 trace（超出丢最旧的）。 */
  maxEntries: number
  /** 全部 trace 正文的总字节上限（超出丢最旧的）。 */
  maxBytes: number
}

/** 默认值：64 条 / 2 MB。 */
export const DEFAULT_TRACE_STORE_OPTIONS: TraceStoreOptions = {
  maxEntries: 64,
  maxBytes: 2 * 1024 * 1024,
}

/** 一条 trace 的粗略字节数（够用即可，不追求精确）。 */
function approxBytes(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return 0
  }
}

/**
 * trace 正文存储。
 *
 * 纯内存 —— 进程退出即消失，这是对的：正文是**当轮**的观测数据，不是
 * 审计记录（审计记录在 audit.plain.jsonl 里，且只存标量）。
 */
export class LlmTraceStore {
  private readonly entries = new Map<string, StoredTrace>()
  private readonly order: string[] = []
  private bytes = 0
  private readonly opts: TraceStoreOptions

  constructor(options: TraceStoreOptions = DEFAULT_TRACE_STORE_OPTIONS) {
    this.opts = options
  }

  /** 存一条 trace，返回它的 id（调用方拿去写索引行）。 */
  put(id: string, entry: StoredTrace): void {
    if (this.entries.has(id)) {
      // 同 id 重写（理论上不会）：先扣掉旧的字节数。
      this.bytes -= approxBytes(this.entries.get(id)?.trace)
      this.entries.set(id, entry)
      this.bytes += approxBytes(entry.trace)
      return
    }
    this.entries.set(id, entry)
    this.order.push(id)
    this.bytes += approxBytes(entry.trace)
    this.evict()
  }

  /** 取一条 trace；不存在返回 undefined。 */
  get(id: string): StoredTrace | undefined {
    return this.entries.get(id)
  }

  /** 当前条数（面板显示「已记录 N 次调用」用）。 */
  size(): number {
    return this.entries.size
  }

  /** 丢掉最旧的直到双双回到上限内。 */
  private evict(): void {
    while (
      this.order.length > 0
      && (this.entries.size > this.opts.maxEntries || this.bytes > this.opts.maxBytes)
    ) {
      const oldest = this.order.shift()
      if (oldest === undefined) break
      const removed = this.entries.get(oldest)
      this.entries.delete(oldest)
      this.bytes -= approxBytes(removed?.trace)
      if (this.bytes < 0) this.bytes = 0
    }
  }
}

/* ── trace id ───────────────────────────────────────────────────────────── */

/** trace id 的进程内计数器。 */
let traceSeq = 0

/**
 * §7.133: 生成 trace id。
 *
 * 单调计数 + 时间戳 —— 同一进程内唯一，且排序有意义（面板按时间排）。
 */
export function formatTraceId(seq: number, ts: number = Date.now()): string {
  return `t${ts.toString(36)}-${seq.toString(36)}`
}

/** §7.133: 取下一个 trace id（进程内单调）。 */
export function nextTraceId(): string {
  return formatTraceId(traceSeq++)
}

/* ── call id（REQ/RESP 配对键）────────────────────────────────────────────── */

/** call id 的进程内计数器。 */
let callSeq = 0

/**
 * §7.134: 生成 call id —— **一次 LLM 往返**的配对键。
 *
 * ## 为什么需要它
 *
 * §7.133 的索引行里，REQ 与 RESP 各自有独立的 `traceId`，于是面板上一次
 * 调用显示成**两行不相干的条目** —— 主人在 §7.134 里要求「请求和响应成对
 * 显示，上面是请求下面是响应」。配对需要一个跨 REQ/RESP 的共同键。
 *
 * ## 键的粒度：一次 `stream()` = 一个 call
 *
 * - local adapter：一次 `stream()` 一发一收，天然一对。
 * - cloud adapter（直连）：`traceRequest` 在**重试循环之前**只调一次，
 *   而 `traceResponse` 有三个出口（network error / HTTP error / 成功）。
 *   重试时可能出现「一次失败 RESP + 一次成功 RESP」—— 它们共用同一个
 *   callId，面板取**最后一个** RESP（那才是这次调用的最终结果）。
 * - jev（裸 fetch）：REQ/RESP 在同一个方法内。
 *
 * ## 用 `options` 对象身份当键
 *
 * 宿主每次 `stream()` 传一个新的 `options` 对象，而 REQ 与 RESP 拿到的是
 * **同一个**对象引用 —— 所以 `WeakMap<options, callId>` 就能把两半配上，
 * 且不需要改 `traceResponse` 的三个调用点的签名。
 *
 * `WeakMap` 不会泄漏：`options` 被回收，条目随之消失。
 */
const callIds = new WeakMap<object, string>()

/** §7.134: 取一个新的 call id（进程内单调）。 */
export function nextCallId(): string {
  return `c${callSeq++}`
}

/**
 * §7.134: 取这次调用的 call id（第一次调用时创建，之后复用）。
 *
 * 传入的不是对象时（理论上不会发生）退化成「每次一个新 call id」——
 * 宁可配不上，也不把两个不相干的调用错配成一对。
 */
export function callIdFor(options: unknown): string {
  if (options === null || typeof options !== 'object') {
    return nextCallId()
  }
  const existing = callIds.get(options)
  if (existing !== undefined) return existing
  const id = nextCallId()
  callIds.set(options, id)
  return id
}

/* ── service 形态 ───────────────────────────────────────────────────────── */

/**
 * trace store 的 service 形态。
 *
 * 为什么是**独立 service** 而不是 edge-context-view 的一个字段：
 * edge-context-view 是 GUI 宿主才有的延迟注入插件（`ctx.inject(['connection'])`），
 * 而写 trace 的是 adapter / prompt-guard / intent-router —— 它们在**任何**
 * profile 里都要能写（headless 的 CLI profile 也要留痕）。
 *
 * 进程内只有一个实例：adapter 与面板读写的必须是**同一个** store，否则
 * 面板点开索引行会永远 404。模块单例是这里最短也最可靠的路 —— ESM 的
 * 模块缓存保证同一个 bundle 里的所有引用指向同一个实例。
 */
export interface LlmTraceStoreService {
  put(id: string, entry: StoredTrace): void
  get(id: string): StoredTrace | undefined
  size(): number
}

/** 进程内唯一的 store 实例。 */
let singleton: LlmTraceStore | undefined

/** §7.133: 取进程内的 trace store（不存在则创建）。 */
export function getTraceStore(): LlmTraceStoreService {
  if (singleton === undefined) singleton = new LlmTraceStore()
  return singleton
}

/**
 * 把 store 注册成 cordis service（名字固定为 `llmTraceStore`）。
 *
 * 独立于 plugin 的 apply() —— 由**首个使用者**惰性创建并注册，这样
 * 不需要在 cordis.patch.yml 里加一行（那个 patch row 的形状门禁很严）。
 * 注册是 best-effort：ctx 不是 plugin-level proxy 时静默跳过，写入方照常
 * 用模块单例。
 */
export function provideTraceStore(ctx: unknown): LlmTraceStoreService {
  const store = getTraceStore()
  const c = ctx as {
    get?: (name: string) => unknown
    provide?: (name: string, value: unknown) => unknown
  }
  try {
    const existing = typeof c.get === 'function' ? c.get('llmTraceStore') : undefined
    if (existing !== undefined && existing !== null) return existing as LlmTraceStoreService
  } catch { /* not provided yet — fall through to register */ }

  try {
    if (typeof c.provide === 'function') c.provide('llmTraceStore', store)
  } catch {
    // 提供失败（ctx 不是 plugin-level proxy）→ 调用方降级，trace 正文不存，
    // 但索引行与 ops log 照旧（面板仍能看到「调了几次、多大、多久」）。
  }
  return store
}
