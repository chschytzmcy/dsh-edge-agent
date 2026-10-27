/**
 * llm-trace — 详细的 LLM request / response 追踪，写进 ops log。
 *
 * ## 为什么需要这个模块
 *
 * 现状（§7.118, 2026-10-26）：adapters 只在 ops log 里记**长度**——
 * `promptLen=121853 systemLen=225 resultLen=5006`。真正想看"到底发了什么、
 * 回了什么"的时候，唯一去处是把 `DSH_EDGE_LOG_LEVEL` 降到 `debug`，而
 * `LLM_MESSAGES` / `LLM_RESPONSE_TEXT` 那两条全量 dump 才会出现：
 *
 *   - 全量 dump 没有脱敏 → 用户原文、工具回显、可能夹带的凭据直接落盘；
 *   - 全量 dump 没有截断 → 一条 120KB 的 prompt 能撑爆一行日志；
 *   - `debug` 级别默认被压制 → 运维默认看不到，而需要看的人往往是在出事之后。
 *
 * 这个模块把"详细"拆成三个**可独立关闭**的维度，并给每一维加上硬边界：
 *
 *   1. **脱敏**（`redactPii` / `redactSecrets`）——PII 走 `pii-utils` 的
 *      10 类规则，凭据走本模块自己的密钥掩码（`pii-utils` 的 api-key 规则
 *      匹配不到 `sk-cp-` / `tvly-` 这类带前缀的厂商密钥，见
 *      `SECRET_PATTERNS`）。
 *   2. **截断**（`maxChars` / `maxMessages`）——每个字段独立上限，且**截断
 *      必须显式可见**（`truncated: true` + `…[+N chars]`），绝不让"日志里
 *      看起来是完整的"成为可能。
 *   3. **分级**（`includeRequest` / `includeResponse`）——只要 request 或
 *      只要 response，各自可关。
 *
 * ## 落盘位置
 *
 * 走 `ctx.logger.info` —— 即 ops log 的默认级别。**不是** debug：运维在
 * 出事后 tail 的是 ops log，不是 debug 日志。
 *
 * ## 安全边界
 *
 * - 本模块**不**写明文密钥：`authorization` 头、`apiKey` 参数一律不进 trace。
 * - 本模块**不**改变任何出网行为：它只在本地组装一个日志对象。
 * - 本模块对畸形输入**永不抛错**：trace 是观测手段，不能把主链路带崩。
 *
 * @module dsh-edge-agent/llm-trace
 */

import { redactString } from './pii-utils.js'
import type { EdgeConfig } from './edge-config.js'

/* ── 配置 ───────────────────────────────────────────────────────────────── */

/**
 * LLM trace 的行为开关。落在 `config/edge.json` 的 `audit.llmTrace` 段
 * （§7.102「只有一个配置文件」——bundle patch 不再读 process.env）。
 */
export interface LlmTraceConfig {
  /** 总开关。false 时 adapters 完全不构造 trace。 */
  enabled: boolean
  /** 是否记录 request（messages + system + 参数）。 */
  includeRequest: boolean
  /** 是否记录 response（content + tool calls + finish reason）。 */
  includeResponse: boolean
  /** 单个文本字段的最大保留字符数。0 = 不截断（不推荐）。 */
  maxChars: number
  /** request 里最多保留多少条 message。 */
  maxMessages: number
  /** 是否做 PII 脱敏（pii-utils 的 10 类规则）。 */
  redactPii: boolean
  /** 是否做凭据掩码（本模块的 SECRET_PATTERNS）。 */
  redactSecrets: boolean
}

/**
 * 出厂默认。
 *
 * `maxChars=2000` 的取舍：一条 message 的正文通常在几百字，2000 足够看清
 * 上下文；整轮 12 条 message × 2000 字 ≈ 24KB 一行，日志文件按 50MB 轮转，
 * 完全可控。想看全量请走 `DSH_EDGE_LOG_LEVEL=debug` 的旧通道，不要把这个值
 * 调到很大 —— 那是拿磁盘换眼睛。
 */
export const DEFAULT_LLM_TRACE_CONFIG: LlmTraceConfig = {
  enabled: true,
  includeRequest: true,
  includeResponse: true,
  maxChars: 2000,
  maxMessages: 12,
  redactPii: true,
  redactSecrets: true,
}

/**
 * 从 `config/edge.json` 解析 trace 配置。
 *
 * 缺省逐字段回落到 `DEFAULT_LLM_TRACE_CONFIG`；`maxChars<=0` 视为"不截断"
 * 但会在 trace 里标注 `truncated:false`，让读日志的人知道这是显式选择。
 */
export function resolveLlmTraceConfig(cfg?: EdgeConfig): LlmTraceConfig {
  const raw = (cfg?.audit as { llmTrace?: Partial<LlmTraceConfig> } | undefined)?.llmTrace
  if (!raw) return { ...DEFAULT_LLM_TRACE_CONFIG }
  const pick = <K extends keyof LlmTraceConfig>(k: K): LlmTraceConfig[K] =>
    raw[k] === undefined ? DEFAULT_LLM_TRACE_CONFIG[k] : (raw[k] as LlmTraceConfig[K])
  return {
    enabled: pick('enabled'),
    includeRequest: pick('includeRequest'),
    includeResponse: pick('includeResponse'),
    maxChars: pick('maxChars'),
    maxMessages: pick('maxMessages'),
    redactPii: pick('redactPii'),
    redactSecrets: pick('redactSecrets'),
  }
}

/* ── 凭据掩码 ───────────────────────────────────────────────────────────── */

/**
 * 凭据字面量掩码（不依赖 pii-utils）。
 *
 * `pii-utils` 的 `api-key` 规则是
 * `sk-(?:proj-|ant-|live-|test-|org-)?[a-zA-Z0-9]{20,}`，它**匹配不到**
 * 厂商自定义前缀的密钥：`sk-cp-…`（MiniMax）在 `cp-` 处断了，且下一段含
 * `_` 也不在字符类里；`tvly-…`（Tavily）、`sk-ws-…`（DashScope）同理。
 * 实测 `config/edge.json` 里的三把真 key 全部逃逸。
 *
 * 所以这里独立覆盖"厂商前缀 + 通用形态"两类，并加两条**收敛条件**避免误伤
 * 普通英文词：
 *
 *   - 厂商前缀密钥要求"长度 ≥16 **且** 至少含一个数字"。真密钥几乎必然带
 *     数字；而 `key-representation`、`api-key-description` 这类正常词不含
 *     数字，不会被误掩。字符类放宽到 `[A-Za-z0-9._-]`（含 `.`），否则
 *     DashScope 的 `sk-ws-EXAMPLE0.dot0.…`（JWS 风格带点）会在第一个
 *     点处断掉而逃逸。
 *   - 另加一条全大写形态（`tvly-PLACEHOLDER_REPLACE_ME`），这类占位符不含
 *     数字但仍是凭据位。
 */
export const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  // Authorization / Bearer 头：整个 token 换成固定掩码。
  { name: 'bearer', pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi },
  // 厂商前缀密钥（含数字）：sk-cp-… / sk-ws-… / xai-… / pk-…
  {
    name: 'vendor-key',
    pattern: /\b(?:sk|key|pk|tvly|xai|rk|ak)[-_](?=[A-Za-z0-9._-]*\d)[A-Za-z0-9._-]{16,}/gi,
  },
  // 厂商前缀密钥（全大写占位形态）：tvly-PLACEHOLDER_REPLACE_ME
  { name: 'vendor-key-caps', pattern: /\b(?:sk|key|pk|tvly|xai|rk|ak)[-_][A-Z0-9_]{12,}\b/g },
  // 标签式：apiKey=xxx / "api_key": "xxx" / secret: xxx / token=xxx
  {
    name: 'labeled-secret',
    pattern: /\b(api[_-]?key|apikey|secret|access[_-]?token|refresh[_-]?token|authorization|password|passwd|pwd|token)\b\s*["']?\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/gi,
  },
]

/** 掩码后的固定占位符。 */
export const SECRET_MASK = '[REDACTED]'

export interface SecretMaskResult {
  text: string
  /** 命中的规则名（去重）。 */
  hits: string[]
}

/**
 * 把文本里的凭据字面量替换成 `SECRET_MASK`。
 *
 * 顺序有意义：先打标签式（`apiKey=…`），再打 `Bearer`，最后打裸厂商前缀 ——
 * 否则 `Bearer sk-cp-xxx` 会被前两条先吃掉，留下一截尾巴。
 */
export function maskSecrets(text: string): SecretMaskResult {
  let out = text
  const hits = new Set<string>()
  for (const { name, pattern } of SECRET_PATTERNS) {
    // 克隆正则，避免共享实例的 lastIndex 在并发调用间串扰（同 pii-utils 的做法）
    const re = new RegExp(pattern.source, pattern.flags)
    if (!re.test(out)) continue
    hits.add(name)
    out = out.replace(new RegExp(pattern.source, pattern.flags), (m) => {
      // 标签式：保留标签名，只换值，保留可读性。
      const idx = m.search(/[:=]/)
      if (idx >= 0) return `${m.slice(0, idx + 1)}${SECRET_MASK}`
      // Bearer：保留前缀（`Bearer `），换掉 token。
      const sp = m.search(/\s/)
      if (sp > 0 && /^(Bearer|Basic)$/i.test(m.slice(0, sp))) {
        return `${m.slice(0, sp + 1)}${SECRET_MASK}`
      }
      return SECRET_MASK
    })
  }
  return { text: out, hits: [...hits] }
}

/* ── 截断 ───────────────────────────────────────────────────────────────── */

export interface TraceText {
  /** 实际写入日志的文本。 */
  text: string
  /** 截断前的原始长度。 */
  length: number
  /** 是否发生了截断。 */
  truncated: boolean
}

/**
 * 按字符数截断，**显式标注**溢出了多少。
 *
 * 不用 `…` 单字符收尾 —— 它和原文里的省略号没法区分。统一用
 * `…[+N chars]`，`grep` 得到的就是真的。
 */
export function truncateForLog(text: string, maxChars: number): TraceText {
  if (typeof text !== 'string') return { text: '', length: 0, truncated: false }
  const length = text.length
  if (maxChars <= 0 || length <= maxChars) return { text, length, truncated: false }
  const dropped = length - maxChars
  return { text: `${text.slice(0, maxChars)}…[+${dropped} chars]`, length, truncated: true }
}

/**
 * 对一段要进日志的文本走完整条链：凭据掩码 → PII 脱敏 → 截断。
 *
 * 顺序同样有讲究：先掩码再脱敏，避免 PII 规则把密钥的一部分改写成别的形态
 * 而逃过掩码；截断放最后，保证掩码与脱敏作用在**完整**文本上（否则密钥可能
 * 恰好落在被切掉的那一段里……不对，那样反而安全了，但 PII 的部分掩码会因
 * 截断而失配。结论：先处理完再截，语义最直观）。
 */
export function sanitizeTraceText(text: string, cfg: LlmTraceConfig): TraceText {
  if (typeof text !== 'string' || text.length === 0) {
    return { text: '', length: 0, truncated: false }
  }
  let out = text
  if (cfg.redactSecrets) out = maskSecrets(out).text
  if (cfg.redactPii) out = redactString(out).redacted
  return truncateForLog(out, cfg.maxChars)
}

/* ── request trace ──────────────────────────────────────────────────────── */

/** 一条 message 的 trace 视图。 */
export interface LlmMessageTrace {
  index: number
  role: string
  /** `source.kind`（`tool` / `user` / …），能区分"工具回显"和"用户输入"。 */
  kind?: string
  /**
   * §7.131: `source.provider` —— 产出这条 assistant 消息的 provider 路由。
   * 出网裁剪（cloud-egress）按它把会话历史切成「云段 / 本地段」，所以把它
   * 也透出到 trace 里：operator 一眼能看出「这段历史是本地池的还是云端的」。
   */
  provider?: string
  /** 正文原始长度。 */
  length: number
  /** 正文（已脱敏 + 截断）。 */
  text?: TraceText
}

export interface LlmRequestTrace {
  sessionId: string
  provider: string
  model: string
  baseUrl?: string
  /** 实际发出的 message 条数（不是 trace 里保留的条数）。 */
  messageCount: number
  /** trace 里因 maxMessages 截掉了几条。 */
  droppedMessages: number
  /** 全部 message 正文的总长度（未截断前）。 */
  promptLength: number
  system?: TraceText
  messages: LlmMessageTrace[]
  /** 本次请求带的工具名（不含 schema）。 */
  tools?: string[]
  params?: {
    temperature?: number
    maxTokens?: number
    stream?: boolean
  }
}

/** 构造 request trace 时的输入。 */
export interface LlmRequestTraceInput {
  sessionId: string
  provider: string
  model: string
  baseUrl?: string
  system?: string
  messages: Array<{ role: string; content: unknown; source?: { kind?: string; provider?: string } }>
  tools?: Array<{ name?: string; function?: { name?: string } }>
  params?: LlmRequestTrace['params']
  config: LlmTraceConfig
}

/**
 * 把 `options.messages` 的 content 摊平成纯文本。
 *
 * dsh-llm 的 `Message.content` 有两种形态：content-block 数组（`{type:'text',
 * text}`）和裸字符串。两种都要认，否则一半消息在 trace 里是空的。
 */
export function messageContentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: string; text?: string } =>
      typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text')
    .map((b) => (typeof b.text === 'string' ? b.text : ''))
    .join('')
}

/**
 * 构造 request trace。
 *
 * 保留**最后** `maxMessages` 条 message（而不是前 `maxMessages` 条）：多轮
 * 对话里真正决定这次请求的是最近几轮，开头的 system 指令已经被压进
 * `system` 字段了。
 */
export function buildRequestTrace(input: LlmRequestTraceInput): LlmRequestTrace {
  const { config } = input
  const all = input.messages ?? []
  const keepFrom = Math.max(0, all.length - Math.max(0, config.maxMessages))
  const kept = all.slice(keepFrom)

  const promptLength = all.reduce((n, m) => n + messageContentToText(m.content).length, 0)

  const messages: LlmMessageTrace[] = kept.map((m, i) => {
    const raw = messageContentToText(m.content)
    const trace: LlmMessageTrace = {
      index: keepFrom + i,
      role: m.role,
      length: raw.length,
    }
    if (m.source?.kind) trace.kind = m.source.kind
    if (m.source?.provider) trace.provider = m.source.provider
    // 空正文的消息（比如只有 tool_calls 的 assistant 回合）留空，不写 `text`
    // 字段 —— 让读日志的人分得清"没有正文"和"正文被截断成空"。
    if (raw.length > 0) trace.text = sanitizeTraceText(raw, config)
    return trace
  })

  const trace: LlmRequestTrace = {
    sessionId: input.sessionId,
    provider: input.provider,
    model: input.model,
    messageCount: all.length,
    droppedMessages: all.length - kept.length,
    promptLength,
    messages,
  }
  if (input.baseUrl) trace.baseUrl = input.baseUrl
  if (input.system && input.system.length > 0) {
    trace.system = sanitizeTraceText(input.system, config)
  }
  const toolNames = (input.tools ?? [])
    .map((t) => t.name ?? t.function?.name)
    .filter((n): n is string => typeof n === 'string' && n.length > 0)
  if (toolNames.length > 0) trace.tools = toolNames
  if (input.params) trace.params = input.params
  return trace
}

/* ── response trace ─────────────────────────────────────────────────────── */

export interface LlmToolCallTrace {
  id?: string
  name: string
  arguments?: TraceText
}

export interface LlmResponseTrace {
  sessionId: string
  provider: string
  model: string
  /** 第几次尝试（重试计数从 1 开始）。 */
  attempt?: number
  durationMs?: number
  finishReason?: string
  /** 助手正文（已脱敏 + 截断）。 */
  content?: TraceText
  toolCalls: LlmToolCallTrace[]
  usage?: {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
  }
  /** 上游错误信息（已截断）。 */
  error?: string
}

export interface LlmResponseTraceInput {
  sessionId: string
  provider: string
  model: string
  attempt?: number
  durationMs?: number
  finishReason?: string
  content?: string
  toolCalls?: Array<{ id?: string; name: string; arguments?: string }>
  usage?: LlmResponseTrace['usage']
  error?: string
  config: LlmTraceConfig
}

/** 构造 response trace。 */
export function buildResponseTrace(input: LlmResponseTraceInput): LlmResponseTrace {
  const { config } = input
  const trace: LlmResponseTrace = {
    sessionId: input.sessionId,
    provider: input.provider,
    model: input.model,
    toolCalls: [],
  }
  if (input.attempt !== undefined) trace.attempt = input.attempt
  if (input.durationMs !== undefined) trace.durationMs = input.durationMs
  if (input.finishReason) trace.finishReason = input.finishReason
  if (input.content && input.content.length > 0) {
    trace.content = sanitizeTraceText(input.content, config)
  }
  for (const call of input.toolCalls ?? []) {
    const t: LlmToolCallTrace = { name: call.name }
    if (call.id) t.id = call.id
    if (call.arguments && call.arguments.length > 0) {
      t.arguments = sanitizeTraceText(call.arguments, config)
    }
    trace.toolCalls.push(t)
  }
  if (input.usage) trace.usage = input.usage
  if (input.error) {
    trace.error = truncateForLog(input.error, Math.max(200, config.maxChars)).text
  }
  return trace
}

/* ── 输出格式化 ─────────────────────────────────────────────────────────── */

/**
 * 把 trace 压成**单行**字符串。
 *
 * ops log 的 `formatLine` 会把换行折成 `⏎`，所以这里自己保证单行：
 * `JSON.stringify` 已经把字符串内的换行转义成 `\n`，但仍可能出现裸的
 * 控制字符（U+2028/2029 等），统一替换掉，避免日志文件出现"一行日志占了
 * 三行物理行"的破事。
 */
export function formatTraceLine(tag: string, trace: unknown): string {
  let json: string
  try {
    json = JSON.stringify(trace)
  } catch {
    // 循环引用 / BigInt 之类的破值：退回一个可读的占位，绝不让日志路径抛错。
    json = JSON.stringify({ error: 'trace-not-serializable' })
  }
  const singleLine = json.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ')
  return `[${tag}] ${singleLine}`
}
