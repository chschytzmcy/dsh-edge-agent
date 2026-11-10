/**
 * host-llm-trace — §7.144 记录**宿主 provider** 发出的 LLM 调用
 *
 * ## 为什么需要这个模块（主人现场发现）
 *
 * 主人在 Edge 面板看到「本轮走云端了，但 LLM 调用里没有云端模型」。查审计链
 * 得到的硬事实是：那一轮**确实**判成了 CLOUD（jev 置信 0.83 < 门限 0.85 →
 * 落到本地 LLM 分类器 → `llm-classified:cloud`），但整轮**零条**
 * `llm.cloud.*` 事件 —— 只有 `llm.local.*`。
 *
 * 原因不是路由错了，是**观测漏了一跳**：
 *
 * - `config/edge.json` 的 `llm.cloud` 是 **delegate 模式**（`baseUrl` 空 +
 *   `delegate: true`，§7.100）：CLOUD 请求**转发给宿主 profile 已配置的模型
 *   提供商**（桌面 GUI 里选的那个，如 `qwen-token-plan-cn`），凭据全归宿主。
 * - 于是主对话的请求**不经过本项目的 cloud adapter** ⇒ 没有 `llm.cloud.*`
 *   审计事件，也没有 trace ⇒ 面板里云端模型整条缺席。
 * - 面板是诚实的（它没编造），但**不完整** —— 主人看到的是「没发生过」，
 *   实际是「没被记下来」。这正是 §7.129 最怕的那种误导：不是显示了一件
 *   没发生的事，而是**漏显示**了一件真发生的事。
 *
 * ## 补在哪一跳
 *
 * 宿主的 `llm/stream` 事件带**完整信封**（`GenerateOptions`：provider /
 * model / messages / system / tools / …），响应侧带**完整 chunk 流**
 * （text-delta / block-end / tool-call-delta / usage / finish）。所以宿主
 * provider 的这一跳**本来就完全可观测** —— 只是没人接。
 *
 * 本模块提供那一跳的记录能力；接线在 `input-guard` 的 `llm/stream` 钩子
 * （那里已经握有 sessionId → 会话状态的映射，能区分「边缘会话」与「标准
 * 模式会话」）。
 *
 * ## 与 adapter 记的那几条如何不重复
 *
 * 本项目自管两个池，provider 名固定：
 *
 * - `local-llm`（local adapter 注册名）
 * - `cloud-llm`（cloud adapter 注册名；delegate 模式下它把请求**再**转发给
 *   宿主 provider，那一跳的 provider 名是宿主自己的 ⇒ 正好被这里记到）
 *
 * 凡是 provider 属于自管池的调用，**adapter 自己已经记过**（REQ + RESP），
 * 这里跳过 —— 否则面板上会出现同一通调用记两遍。
 *
 * ## 记什么
 *
 * | 侧 | 内容 |
 * |---|---|
 * | REQ | 宿主看到的信封：provider / model / messages / system / tools / 参数 |
 * | RESP | 完整正文（block-end 优先）+ 工具调用 + finish reason + usage |
 *
 * `body` 快照是**宿主层信封**，不是 provider 的 wire body —— 后者在 adapter
 * 内部，宿主这一跳看不见。面板上 provider/model 字段会显示宿主 provider
 * 名（如 `qwen-token-plan-cn/deepseek-v4.1-flash`），一眼能认出「这是云端
 * 模型那一条」。
 *
 * @module dsh-edge-agent/host-llm-trace
 */

import {
  buildRequestTrace,
  buildResponseTrace,
  emitTrace,
} from './llm-trace.js'
import type {
  LlmRequestTrace,
  LlmResponseTrace,
  LlmTraceConfig,
  TraceSink,
} from './llm-trace.js'

/* ── provider 判据 ───────────────────────────────────────────────────────── */

/**
 * 本项目自管池的 provider 名（adapter 注册名）。
 *
 * 这两个名字来自 adapter 的注册表（cloud adapter 的 `providers` 默认
 * `['cloud-llm']`），不是配置项 —— 改成别的名字会破坏 §7.100 的 delegate
 * 语义，所以这里写死成常量。
 */
export const OWN_POOL_PROVIDERS: readonly string[] = ['local-llm', 'cloud-llm']

/**
 * §7.171 (2026-11-10): 「本地池 delegate 转发」标记。
 *
 * `local-llm` 走 delegate 时会把请求转发给宿主提供商（§7.171 新增），转发时
 * `provider` 变成了**目标** provider（不再是 `local-llm`）⇒ `host-egress-guard`
 * 会把它当成「宿主原生 provider 的出网那一跳」⇒ 按 §7.131 口径裁掉本地段历史。
 *
 * 但本地池的口径恰恰相反：**带全部历史**（§7.131 的不对称规则第一条）。
 * ⇒ 转发时打这个标记，出网守卫看到它就放行（不裁）。
 *
 * 打在 options 上是安全的：宿主 `LlmRuntime.stream` 走
 * `{...options, ...resolvedConfig}` 的 spread（`@deepseek-ai/dsh-llm`
 * `lib/index.js` 的 `adapterStream`），未知字段原样透传，不会被拒。
 *
 * 住在这里（而不是 adapter 里）是因为**打标的一方与读标的一方分属两个模块**：
 * `cloud-llm-adapter.ts`（打）↔ `host-egress-guard.ts`（读）。与
 * `OWN_POOL_PROVIDERS` 同处一地 —— 自有池相关的判据只有这一份事实源。
 */
export const LOCAL_POOL_FORWARD_MARKER = '__edgeLocalPoolForward'

/**
 * 这个 provider 是不是本项目自己管的池？
 *
 * 是 ⇒ adapter 已经记过这次调用，这里必须跳过（否则同一通调用记两遍）。
 * 否 ⇒ 宿主自己的 provider（delegate 出去的云池），**这里要补记**。
 */
export function isOwnPoolProvider(
  provider: string,
  own: readonly string[] = OWN_POOL_PROVIDERS,
): boolean {
  if (typeof provider !== 'string' || provider.length === 0) return false
  return own.includes(provider)
}

/* ── 请求侧 ───────────────────────────────────────────────────────────────── */

/** 宿主 `llm/stream` 的 options 里我们用得到的部分。 */
export interface HostCallRequest {
  provider: string
  model: string
  sessionId: string
  messages: Array<{
    role: string
    content: unknown
    source?: { kind?: string; provider?: string }
  }>
  system?: string
  tools?: Array<{ name?: string; function?: { name?: string } }>
  params?: {
    temperature?: number
    maxTokens?: number
    stream?: boolean
  }
}

/**
 * 构造宿主调用的 request trace。
 *
 * `rawBody` 记的是**宿主层信封**（provider / model / messages / system /
 * tools / 参数）—— 宿主这一跳能看到的全部。provider 的 wire body 在 adapter
 * 内部，从这里看不见（那一侧由 adapter 自己记）。
 */
export function buildHostRequestTrace(input: {
  request: HostCallRequest
  config: LlmTraceConfig
}): LlmRequestTrace {
  const r = input.request
  return buildRequestTrace({
    sessionId: r.sessionId,
    provider: r.provider,
    model: r.model,
    system: r.system,
    messages: r.messages,
    tools: r.tools,
    params: r.params,
    rawBody: {
      provider: r.provider,
      model: r.model,
      messages: r.messages,
      ...(r.system !== undefined ? { system: r.system } : {}),
      ...(r.tools !== undefined ? { tools: r.tools } : {}),
      ...(r.params !== undefined ? { params: r.params } : {}),
    },
    config: input.config,
  })
}

/* ── 响应侧累积 ───────────────────────────────────────────────────────────── */

/** 一次宿主调用的响应摘要。 */
export interface HostResponseSnapshot {
  content: string
  toolCalls: Array<{ id?: string; name: string; arguments?: string }>
  finishReason?: string
  usage?: {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
  }
}

/**
 * 单次响应累积的字符上限。
 *
 * 观测路径不能变成故障源：异常大的响应（长文档粘贴 + 长工具回显）不能把
 * 内存吃穿。超过上限后只保留前面这段，并在 trace 里如实标注（正文长度仍
 * 按**真实**长度报，不假装完整）。
 */
const MAX_ACCUM_CHARS = 200_000

/**
 * 从宿主的 chunk 流里累积一次响应。
 *
 * 正文优先取 `block-end` 的 `block.text`（宿主在 block 结束时给的是**全文**
 * 比逐个 text-delta 拼更准）；拿不到才回落累积 delta。
 */
export class HostResponseAccumulator {
  private text = ''
  private textTruncated = false
  private readonly calls = new Map<number, { id?: string; name: string; args: string }>()
  private finishReason: string | undefined
  private usage: HostResponseSnapshot['usage']

  /** 吃掉一个 chunk。永不抛 —— 畸形 chunk 直接忽略。 */
  push(chunk: unknown): void {
    if (chunk === null || typeof chunk !== 'object') return
    const c = chunk as Record<string, unknown>
    switch (c.type) {
      case 'text-delta': {
        if (typeof c.text === 'string') this.appendText(c.text)
        return
      }
      case 'block-end': {
        const block = c.block as { type?: unknown; text?: unknown } | undefined
        if (block && block.type === 'text' && typeof block.text === 'string') {
          // block-end 给的是**整块正文** —— 直接覆盖累积值（多 block 时以
          // 最后一个文本 block 为准；agent-loop 的回答基本是单块）。
          this.text = block.text.slice(0, MAX_ACCUM_CHARS)
          this.textTruncated = block.text.length > MAX_ACCUM_CHARS
        }
        return
      }
      case 'tool-call-delta': {
        const index = typeof c.index === 'number' ? c.index : this.calls.size
        const cur = this.calls.get(index) ?? { name: '', args: '' }
        if (typeof c.id === 'string' && c.id.length > 0) cur.id = c.id
        if (typeof c.name === 'string' && c.name.length > 0) cur.name = c.name
        if (typeof c.argumentsDelta === 'string') {
          cur.args = (cur.args + c.argumentsDelta).slice(0, MAX_ACCUM_CHARS)
        }
        this.calls.set(index, cur)
        return
      }
      case 'usage': {
        const u = c.usage as { inputTokens?: unknown; outputTokens?: unknown } | undefined
        if (u && typeof u === 'object') {
          const inputTokens = typeof u.inputTokens === 'number' ? u.inputTokens : undefined
          const outputTokens = typeof u.outputTokens === 'number' ? u.outputTokens : undefined
          this.usage = {
            promptTokens: inputTokens,
            completionTokens: outputTokens,
            totalTokens:
              inputTokens !== undefined && outputTokens !== undefined
                ? inputTokens + outputTokens
                : undefined,
          }
        }
        return
      }
      case 'finish': {
        // 宿主的 FinishReason 是**对象**（{ kind: 'stop' } / { kind: 'tool-calls' } …），
        // 直接 stringify 会变成 '{"kind":"stop"}' —— 面板上难看且不可比。优先取 kind。
        const reason = c.reason
        if (typeof reason === 'string') this.finishReason = reason
        else if (reason !== null && typeof reason === 'object') {
          const kind = (reason as Record<string, unknown>).kind
          this.finishReason = typeof kind === 'string' ? kind : safeStringify(reason)
        } else if (reason !== undefined) this.finishReason = safeStringify(reason)
        return
      }
      default:
        return
    }
  }

  private appendText(text: string): void {
    if (this.text.length >= MAX_ACCUM_CHARS) {
      this.textTruncated = true
      return
    }
    const room = MAX_ACCUM_CHARS - this.text.length
    if (text.length > room) {
      this.text += text.slice(0, room)
      this.textTruncated = true
      return
    }
    this.text += text
  }

  /** 当前累积结果。 */
  snapshot(): HostResponseSnapshot {
    const toolCalls = [...this.calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => {
        const call: { id?: string; name: string; arguments?: string } = { name: v.name }
        if (v.id !== undefined) call.id = v.id
        if (v.args.length > 0) call.arguments = v.args
        return call
      })
    const out: HostResponseSnapshot = { content: this.text, toolCalls }
    if (this.finishReason !== undefined) out.finishReason = this.finishReason
    if (this.usage !== undefined) out.usage = this.usage
    return out
  }

  /** 累积时是否撞到上限（面板据此说明正文不全）。 */
  get truncated(): boolean {
    return this.textTruncated
  }
}

/** 构造宿主调用的 response trace。 */
export function buildHostResponseTrace(input: {
  sessionId: string
  provider: string
  model: string
  snapshot: HostResponseSnapshot
  durationMs?: number
  config: LlmTraceConfig
}): LlmResponseTrace {
  const s = input.snapshot
  return buildResponseTrace({
    sessionId: input.sessionId,
    provider: input.provider,
    model: input.model,
    durationMs: input.durationMs,
    finishReason: s.finishReason,
    content: s.content,
    toolCalls: s.toolCalls,
    usage: s.usage,
    rawBody: {
      content: s.content,
      tool_calls: s.toolCalls,
      finish_reason: s.finishReason,
      usage: s.usage,
    },
    config: input.config,
  })
}

/* ── 记录器 ───────────────────────────────────────────────────────────────── */

/** 记录器的依赖面。 */
export interface HostCallRecorderOptions {
  sink: TraceSink
  config: LlmTraceConfig
  request: HostCallRequest
  /** §7.134：与面板配对用的 callId（REQ/RESP 共用）。 */
  callId: string
}

/**
 * 一次宿主 provider 调用的记录器。
 *
 * 构造即记 REQ；`wrap()` 包住 chunk 流，流结束时记 RESP。REQ/RESP 共用
 * 同一个 callId ⇒ 面板上仍然「上请求、下响应」成对显示。
 */
export class HostCallRecorder {
  private readonly accumulator = new HostResponseAccumulator()
  private readonly startedAt = Date.now()
  private responseEmitted = false

  constructor(private readonly options: HostCallRecorderOptions) {
    try {
      const { sink, config, request, callId } = options
      if (!config.enabled || !config.includeRequest) return
      const trace = buildHostRequestTrace({ request, config })
      emitTrace(sink, 'REQ', 'host-llm-trace LLM_REQUEST', trace, undefined, {
        toolCount: request.tools?.length ?? 0,
        callId,
      })
    } catch { /* 观测失败不拖垮主链路 */ }
  }

  /** 包住 chunk 流：边转发边累积，流结束记 RESP。 */
  async *wrap(stream: AsyncIterable<unknown>): AsyncIterable<unknown> {
    try {
      for await (const chunk of stream) {
        try { this.accumulator.push(chunk) } catch { /* 单个 chunk 畸形不影响主链路 */ }
        yield chunk
      }
    } finally {
      this.emitResponse()
    }
  }

  private emitResponse(): void {
    if (this.responseEmitted) return
    this.responseEmitted = true
    try {
      const { sink, config, request, callId } = this.options
      if (!config.enabled || !config.includeResponse) return
      const trace = buildHostResponseTrace({
        sessionId: request.sessionId,
        provider: request.provider,
        model: request.model,
        snapshot: this.accumulator.snapshot(),
        durationMs: Date.now() - this.startedAt,
        config,
      })
      emitTrace(sink, 'RESP', 'host-llm-trace LLM_RESPONSE', trace, undefined, {
        toolCount: request.tools?.length ?? 0,
        callId,
      })
    } catch { /* 观测失败不拖垮主链路 */ }
  }
}

/* ── 小工具 ───────────────────────────────────────────────────────────────── */

/** 永不抛的 stringify（finish reason 可能是对象）。 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return '[unserializable]'
  }
}
