/**
 * cloud-llm-adapter — registers a remote LLM provider (DeepSeek, etc).
 * M1 ships a minimal self-contained DeepSeek Chat-Completions client:
 * one HTTPS POST, one SSE parse, no retries, no idle watchdog, no
 * secure-bridge routing (the latter comes in A4). The credentials
 * are read from a process-env slot the operator names in
 * `Config.apiKeyEnv` (default `DEEPSEEK_API_KEY`); the adapter never
 * persists the key. Each request carries `attributionHeaders()` so
 * upstream can correlate the call to the harness.
 *
 * Wire protocol: OpenAI-compatible chat-completions streaming endpoint
 * (`{baseUrl}/chat/completions`). Adapter emits `text-delta` events
 * for `content` deltas, `tool-call-delta` for function-call deltas,
 * and a terminal `finish({kind})` derived from the stream's
 * `finish_reason`.
 *
 * The body builder + SSE parser live in `./openai-sse.js` so the
 * `local-llm-adapter` `mode: 'real'` path shares them.
 *
 * @module dsh-edge-agent/cloud-llm-adapter
 */

import type { Context, LoggerService } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { attributionHeaders, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'

import {
  buildChatCompletionsBody,
  extractText,
  iterateSseFrames,
  sseEventToChunk,
  sseFinishReason,
  terminalChunks,
} from './openai-sse.js'
import { cloudPool, loadEdgeConfig } from './edge-config.js'
import {
  buildRequestTrace,
  buildResponseTrace,
  emitTrace,
  type TraceSink,
  resolveLlmTraceConfig,
  type LlmTraceConfig,
} from './llm-trace.js'
import {
  bumpSessionToolCallCount,
  MAX_CONSECUTIVE_TOOL_CALLS,
  peekSessionSseRetryCount,
  resetSessionToolCallCount,
  resetSessionSseRetryCount,
  tryConsumeSseRetryBudget,
} from './llm-max-turns.js'
import {
  planCloudEgress,
  type EgressMessage,
} from './cloud-egress.js'
import { PII_ORDER, PII_PATTERNS } from './pii-utils.js'
import { egressAuditFields, internalCallerOf } from './llm-internal-caller.js'
import { sessionIdField } from './session-attribution.js'
import { getTraceStore, callIdFor } from './llm-trace-store.js'

export const name = 'cloud-llm-adapter'

export const inject = ['llm', 'auditLog', 'inputGuard'] as const

/** Minimal interface our adapter needs from the audit-log service. */
interface AuditLike {
  log(entry: { level: 'debug' | 'info' | 'warn' | 'error' | 'security'; kind: string; source: string; payload: Record<string, unknown> }): Promise<unknown>
}

/** Minimal duck-typed handle for Cordis `LoggerService`. Used by tests to stub
 *  logger behavior; `apply()` injects the live `ctx.logger` from Cordis. */
type LoggerLike = Pick<LoggerService, 'info' | 'warn' | 'error' | 'debug'>

/**
 * Minimal interface for input-guard's orphan-tool-call sanitizer
 * (added 2026-08-31). cloud-llm-adapter injects `'inputGuard'` and
 * calls this before buildChatCompletionsBody to avoid DeepSeek 400
 * errors when session history has orphaned tool_calls.
 */
interface InputGuardLike {
  sanitizeOrphanToolCalls(
    messages: ReadonlyArray<Record<string, unknown>>,
    sessionId?: string,
  ): {
    messages: Array<Record<string, unknown>>
    orphanCount: number
    syntheticInjected: number
  }
}

/**
 * Minimal sanitizer interface — mirrors input-guard's `SanitizerLike` so the
 * two consumers stay on the same real contract (`Replacement` is
 * `{ original, placeholder, piiType, dataClass, keptPrefix? }`, §7.123).
 */
interface SanitizerLike {
  sanitize(text: string, context?: { sessionId?: string }): Promise<{
    sanitizedText: string
    sessionId: string
    replacements: Array<{
      original: string
      placeholder: string
      piiType: string
      dataClass: string
      keptPrefix?: string
    }>
  }>
  desanitize(text: string, sessionId: string): Promise<string>
}

/**
 * 出网准备结果。 */
export interface CloudEgressResult {
  /** 真正发出去的消息（已裁剪 + 已脱敏）。 */
  messages: EgressMessage[]
  /** 被拦下的本地段消息条数。 */
  droppedCount: number
  /** 脱敏替换次数。 */
  replacements: number
  /** 是否真的做了脱敏（sanitizer 缺席 → false）。 */
  sanitized: boolean
}

/**
 * §7.131 (2026-10-27): 出网准备器 —— 裁剪 + 脱敏。
 *
 * **为什么 ctx 在这里而不是 apply() 时取**：`cordis.patch.yml` 里
 * cloud-llm-adapter(373) 排在 sanitizer-pipeline(506) **之前**，所以 apply()
 * 执行的那一刻 `ctx.sanitizer` 还是 undefined。但 stream() 是 boot 完成后的
 * 运行时调用 —— 那时所有插件都已 apply，ctx 完整。所以这里持有 ctx，在
 * **运行时**再取 sanitizer。
 *
 * 同理 `ctx.inputGuard` 也是运行时才拿得到 —— apply() 时取到的那个
 * `inputGuard` 一直是 undefined（§7.17 的孤儿 tool_call 清洗在当前部署下
 * 因此是**失效**的）。本轮不改那件事，只把脱敏需要的 sanitizer 运行时取到。
 */
export class CloudEgressGuard {
  constructor(private readonly ctx: Context) {}

  /** 运行时取 sanitizer（apply 时拿不到，见类注释）。 */
  private sanitizer(): SanitizerLike | undefined {
    return (this.ctx as unknown as { sanitizer?: SanitizerLike }).sanitizer
  }

  /**
   * 运行时取本地 provider 名单。
   *
   * 用 model-router 的 `listDetailed()`（带 realm 标注）—— 与路由判定同一份
   * 事实源，避免「出网裁剪认为它是本地、路由认为它是云」这种口径漂移。
   * model-router 在 patch 里排在 cloud-llm-adapter 之后，所以同样运行时取。
   */
  private localProviders(): string[] {
    const router = (this.ctx as unknown as {
      modelRouter?: { listDetailed?: () => Array<{ provider?: string; realm?: string }> }
    }).modelRouter
    try {
      const detailed = router?.listDetailed?.() ?? []
      const locals = detailed
        .filter(d => d.realm === 'LOCAL' && typeof d.provider === 'string')
        .map(d => d.provider as string)
      if (locals.length > 0) return locals
    } catch { /* fall through to the default */ }
    return ['local-llm']
  }

  /**
   * 裁剪到「只带云段历史 + 本轮」，并对保留块做可逆脱敏。
   *
   * 脱敏失败（占位符超限等）→ 抛错，**fail-closed**：宁可这一轮不出网，
   * 也不放行半脱敏文本（与 sanitizer-pipeline 的既有语义一致）。
   */
  async prepare(
    messages: readonly EgressMessage[],
    sessionId: string | undefined,
  ): Promise<CloudEgressResult> {
    const plan = planCloudEgress(messages, {
      currentSegment: 'cloud',
      localProviders: this.localProviders(),
    })
    const sanitizer = this.sanitizer()
    if (!sanitizer) {
      // 没有 sanitizer = 隐私栈没开（enableInputGuard=false 等）。裁剪仍然
      // 执行（主人要求无条件成立），脱敏记审计 —— 不能假装脱过了。
      return { messages: plan.kept, droppedCount: plan.droppedCount, replacements: 0, sanitized: false }
    }
    let replacements = 0
    const kept = await Promise.all(plan.kept.map(async (m) => {
      // 先用同一批 PII 正则做**廉价预检**，只有疑似才真的调 sanitizer ——
      // sanitizer.sanitize() 每次都要 sweepExpired（遍历全部 session mapping），
      // 一条会话动辄几十上百条消息，逐条调会明显拖慢出网。
      if (!mayContainPii(m.content)) return m
      const r = await this.sanitizeMessage(m, sanitizer, sessionId)
      replacements += r.replacements
      return r.message
    }))
    return { messages: kept, droppedCount: plan.droppedCount, replacements, sanitized: true }
  }

  private async sanitizeMessage(
    message: EgressMessage,
    sanitizer: SanitizerLike,
    sessionId: string | undefined,
  ): Promise<{ message: EgressMessage; replacements: number }> {
    let count = 0
    const next = await mapMessageStringsAsync(message, async (text) => {
      const result = await sanitizer.sanitize(text, sessionId ? { sessionId } : undefined)
      count += result.replacements.length
      return result.sanitizedText
    })
    return { message: next, replacements: count }
  }
}

/** 内容里是否**可能**含 PII —— 预检，避免对每条消息都调 sanitizer。 */
function mayContainPii(content: unknown): boolean {
  const texts: string[] = []
  collectStrings(content, texts)
  for (const t of texts) {
    for (const name of PII_ORDER) {
      // 正则带 g flag 时 lastIndex 有状态 —— 每次重建。
      if (new RegExp(PII_PATTERNS[name], 'i').test(t)) return true
    }
  }
  return false
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) collectStrings(v, out)
  }
}

/** mapMessageStrings 的 async 版本（脱敏是 async 的）。 */
async function mapMessageStringsAsync(
  message: EgressMessage,
  fn: (text: string) => Promise<string>,
): Promise<EgressMessage> {
  const next: EgressMessage = { ...message }
  next.content = await mapStringsAsync(message.content, fn)
  return next
}

async function mapStringsAsync(value: unknown, fn: (text: string) => Promise<string>): Promise<unknown> {
  if (typeof value === 'string') return await fn(value)
  if (Array.isArray(value)) {
    const out: unknown[] = []
    for (const v of value) out.push(await mapStringsAsync(v, fn))
    return out
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = await mapStringsAsync(v, fn)
    }
    return out
  }
  return value
}

export interface Config {
  /** Provider route ids this adapter owns; defaults match DeepSeek. */
  providers: string[]
  /**
   * Wire endpoint base; `/chat/completions` is appended.
   * §7.100: EMPTY (default) = DELEGATE mode — the `cloud-llm` route becomes a
   * pure forwarding shell onto the host profile's configured model provider.
   * Non-empty = the classic direct-connect client below, byte-for-byte unchanged.
   */
  baseUrl: string
  /** Process-env slot carrying the bearer key (never read at config time). Direct mode only. */
  apiKeyEnv: string
  /** §7.102: literal bearer key from config/edge.json (secrets.*).
   *  Preferred over apiKeyEnv when both are present. */
  apiKey?: string
  /** Default model id when the request omits one. Direct mode only (delegate carries it for forensics). */
  defaultModel: string
  /** Per-request temperature. Omit when the model is fixed. */
  temperature?: number
  /** Delegate step-1 explicit target route id (overrides selection/probe). */
  delegateProvider?: string
  /** Delegate wire model override; beats host selection / probe model. */
  delegateModel?: string
  /** Kill switch: false = never delegate. With an empty baseUrl, cloud turns
   *  then fail loudly (input-guard restores §7.35 downgrade-to-LOCAL). */
  delegateEnabled?: boolean
}

export const Config: Schema<Config> = Schema.object({
  providers: Schema.array(Schema.string()).default(['cloud-llm']),
  // §7.100: 默认空串 = delegate 模式哨兵。原默认 'https://api.deepseek.com'
  // 会让"未配置云池"静默直连 DeepSeek（拿不到 key 才报错）；现在未配置
  // 即继承宿主 profile 的提供商，显式配置 baseUrl 才走自研直连。
  baseUrl: Schema.string().default('').description('OpenAI-compatible endpoint base; empty = delegate to the host profile provider (§7.100).'),
  apiKeyEnv: Schema.string().default('DEEPSEEK_API_KEY'),
  defaultModel: Schema.string().default('deepseek-chat'),
  temperature: Schema.number().description('Optional override for sample temperature.'),
  delegateProvider: Schema.string().description('Delegate mode: explicit target provider route id.'),
  delegateModel: Schema.string().description('Delegate mode: wire model override (beats host selection).'),
  delegateEnabled: Schema.boolean().default(true).description('false = disable delegation; empty baseUrl then fails loudly.'),
})

export interface CloudLlmAdapter {
  readonly providers: string[]
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/**
 * Minimal DeepSeek-compatible adapter. Reads the bearer key lazily on
 * each stream call so a config update takes effect without a re-register.
 */
export class CloudLlmAdapterImpl extends LlmAdapter {
  private readonly providersList: string[]
  private readonly baseUrl: string
  private readonly apiKeyEnv: string
  private readonly apiKey: string | undefined
  private readonly defaultModel: string
  private readonly temperature: number | undefined
  private readonly auditLog: AuditLike | undefined
  private readonly inputGuard: InputGuardLike | undefined
  private readonly logger: LoggerLike | undefined
  /** §7.131: 出网准备器（裁剪云段 + 脱敏）。 */
  private readonly egress: CloudEgressGuard | undefined

  constructor(config: Config, auditLog?: AuditLike, inputGuard?: InputGuardLike, logger?: LoggerLike, egress?: CloudEgressGuard) {
    super()
    this.providersList = [...config.providers]
    this.baseUrl = config.baseUrl.replace(/\/+$/u, '')
    this.apiKeyEnv = config.apiKeyEnv
    this.apiKey = config.apiKey
    this.defaultModel = config.defaultModel
    this.temperature = config.temperature
    this.auditLog = auditLog
    this.inputGuard = inputGuard
    this.logger = logger
    this.egress = egress
  }

  private audit(level: 'debug' | 'info' | 'warn' | 'error' | 'security', kind: string, payload: Record<string, unknown>): void {
    if (!this.auditLog) return
    void this.auditLog.log({ level, kind, source: 'cloud-llm-adapter', payload }).catch(() => {})
  }

  /**
   * §7.118: 当前生效的 LLM trace 配置。
   *
   * 每次调用现取，而不是在 apply() 里存一份 —— `loadEdgeConfig()` 自带
   * mtime+size 指纹缓存，改了 config/edge.json 立刻生效，不用重启进程。
   * 指纹命中时只付一次 statSync，相对一次 LLM 往返可以忽略。
   */
  private traceConfig(): LlmTraceConfig {
    return resolveLlmTraceConfig(loadEdgeConfig())
  }

  /**
   * §7.118: 把详细的 request（messages + system + 参数）写进 ops log。
   *
   * 走 `info` 级别而不是 `debug` —— 运维出事之后 tail 的是 ops log，
   * 不是 debug 日志。完整内容经过脱敏（凭据 + PII）与按字段截断，
   * 详见 `./llm-trace.js`。
   *
   * 观测手段绝不能把主链路带崩：整段包在 try/catch 里。
   */
  private traceRequest(
    sessionId: string,
    options: GenerateOptions,
    system: string,
    messages: Array<{ role: string; content: unknown; source?: { kind?: string } }>,
    rawBody?: unknown,
  ): void {
    try {
      const cfg = this.traceConfig()
      if (!cfg.enabled || !cfg.includeRequest) return
      const trace = buildRequestTrace({
        sessionId,
        provider: options.provider,
        model: options.model ?? this.defaultModel,
        baseUrl: this.baseUrl,
        system,
        messages,
        tools: options.tools as Array<{ name?: string; function?: { name?: string } }> | undefined,
        // §7.144: 真正发出去的 wire body（面板上要能核对「发了什么」）。
        rawBody,
        params: {
          temperature: this.temperature,
          maxTokens: options.maxTokens,
          stream: true,
        },
        config: cfg,
      })
      this.emit('REQ', 'cloud-llm-adapter LLM_REQUEST', trace, options)
    } catch { /* 观测失败不拖垮主链路 */ }
  }

  /**
   * §7.118: 把详细的 response（正文 + tool calls + finish reason）写进 ops log。
   */
  private traceResponse(
    sessionId: string,
    provider: string,
    model: string,
    content: string,
    toolCalls: Array<{ id?: string; name: string; arguments?: string }>,
    finishKind: string | undefined,
    durationMs: number,
    attempt: number,
    error?: string,
    options?: GenerateOptions,
    rawBody?: unknown,
  ): void {
    try {
      const cfg = this.traceConfig()
      if (!cfg.enabled || !cfg.includeResponse) return
      const trace = buildResponseTrace({
        sessionId,
        provider,
        model,
        attempt,
        durationMs,
        finishReason: finishKind,
        content,
        toolCalls,
        // §7.144: 完整响应体快照。
        rawBody,
        error,
        config: cfg,
      })
      this.emit('RESP', 'cloud-llm-adapter LLM_RESPONSE', trace, options)
    } catch { /* 观测失败不拖垮主链路 */ }
  }

  /**
   * §7.133: trace 的统一出口 —— ops log + Edge 面板索引行 + 正文。
   *
   * 检测调用（安检 / 分类器）经 §7.132 的 `edgeInternalCaller` 标记带上
   * caller —— 与主对话走的是同一段代码。
   */
  private emit(
    kind: 'REQ' | 'RESP',
    tag: string,
    trace: unknown,
    options?: GenerateOptions,
  ): void {
    const sink: TraceSink = {
      log: (entry) => this.auditLog?.log(entry) ?? Promise.resolve(),
      logger: this.logger,
      store: getTraceStore(),
    }
    // §7.132 的判据落到索引行：带工具 = 主对话，一件不带 = 内部调用。
    const tools = options?.tools
    emitTrace(sink, kind, tag, trace, internalCallerOf(options), {
      toolCount: Array.isArray(tools) ? tools.length : 0,
      // §7.134: REQ 与 RESP 共用一个 callId —— 面板据此把两半配成一对。
      // 重试时可能出现「失败 RESP + 成功 RESP」，它们共用同一个 callId，
      // 面板取最后一个（那才是这次调用的最终结果）。
      callId: callIdFor(options),
    })
  }

  /** Mirror {@link CloudLlmAdapter.providers}; the upstream registry reads it. */
  get providers(): string[] {
    return [...this.providersList]
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: provider }
  }

  /**
   * §7.106 Option A: catalog deliberately empty — the cloud-llm route is
   * pipeline plumbing (http-api delegate egress, internal routing), not a
   * picker choice; advertising it let users accidentally select
   * `cloud-llm/deepseek-chat` and exposed INVALID_CATALOG failures.
   * Routing is unaffected ("catalog membership does not constrain core
   * routing", dsh-llm lib/index.js:2080) and compaction gets its 65536 from
   * resolveModel's context (§7.43), which stays.
   */
  override listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([])
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    // §7.43 (2026-09-07): see listModels comment — contextWindow must also
    // surface through resolveModel so the runtime normalises it onto the
    // active session's `info.context.contextWindow`. Without this the
    // adapter's advertised contextWindow is ignored.
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 65536 },
    })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // 2026-09-02: per-call request/response body logging to ops log at
    // debug level. CLOUD prompts are pre-sanitized by input-guard before
    // egress so the captured prompt is already placeholder-text for
    // sensitive spans; response text is NOT redacted. 2026-09-11 default
    // flipped to `info` — these 4 body lines are filtered by Cordis and
    // don't reach the ops log unless operator sets
    // `DSH_EDGE_LOG_LEVEL=debug`. The lines below still gate on
    // Cordis's per-exporter level filter — see file-logger.ts.
    this.logger?.debug?.(`[cloud-llm-adapter] LLM_REQUEST provider=${options.provider} model=${options.model} messageCount=${options.messages.length} promptLen=${options.messages.reduce((n, m) => n + extractText(m.content).length, 0)}`)
    // §7.102: prefer the literal key from config/edge.json; fall back to the
    // deprecated env-slot lookup so an in-flight migration still authenticates.
    const apiKey = this.apiKey ?? readApiKey(this.apiKeyEnv)
    if (!apiKey) {
      this.logger?.error?.(`[cloud-llm-adapter] missing API key (secrets.* / env slot ${this.apiKeyEnv})`)
      this.audit('error', 'llm.cloud.missing_key', { provider: options.provider, model: options.model, envSlot: this.apiKeyEnv })
      throw new LlmError(
        `cloud-llm-adapter: missing API key — set secrets.* in config/edge.json`
        + `${this.apiKeyEnv === '' ? '' : ` (or the env slot "${this.apiKeyEnv}")`}`,
        'MISSING_CREDENTIAL',
      )
    }
    const url = `${this.baseUrl}/chat/completions`

    // 2026-08-31：input-guard 清洗孤儿 tool_call（避免 DeepSeek 400）。
    // input-guard 未注入（plugin 顺序 / DSH_EDGE_INPUT_GUARD=false）则跳过。
    // 这里只覆盖 messages，其他 option 字段（tools / temperature 等）
    // 原样传给 buildChatCompletionsBody。
    let sanitizedMessages: typeof options.messages = options.messages
    if (this.inputGuard) {
      const result = this.inputGuard.sanitizeOrphanToolCalls(
        options.messages as unknown as ReadonlyArray<Record<string, unknown>>,
        (options as { sessionId?: string }).sessionId,
      )
      sanitizedMessages = result.messages as unknown as typeof options.messages
    }

    // §7.131 (2026-10-27): 出网准备 —— 裁掉本地段历史 + 对保留块脱敏。
    //
    // 主人裁决：「发给 cloudllm 的请求，只能携带之前所有的上 cloudllm 的历史」——
    // 默认路由是本地池，本地轮次积累的会话历史属于本地资产，路由被改写/恢复
    // 切回云端时不能跟着上云（实测 10-24 的 route.restored 就带着 28 条本地
    // 历史上过云）。
    //
    // 脱敏失败（占位符超限等）→ fail-closed：宁可这一轮不出网，也不放行半脱敏
    // 文本 —— 与 sanitizer-pipeline 的既有语义一致。
    const egressSessionId = (options as { sessionId?: string }).sessionId
    let egressDropped = 0
    let egressReplacements = 0
    let egressSanitized = false
    if (this.egress) {
      try {
        const prepared = await this.egress.prepare(
          sanitizedMessages as unknown as EgressMessage[],
          egressSessionId,
        )
        sanitizedMessages = prepared.messages as unknown as typeof options.messages
        egressDropped = prepared.droppedCount
        egressReplacements = prepared.replacements
        egressSanitized = prepared.sanitized
      } catch (err: any) {
        this.audit('security', 'llm.cloud.egress.blocked', {
          provider: options.provider,
          model: options.model,
          // §7.147: 原来写 `egressSessionId ?? 'unknown'` —— 那是**假会话 id**
          // （面板会造出一个叫 'unknown' 的桶，把这行从所有真实会话的视图里
          // 藏掉）。没有会话就不写这个键 ⇒ 归全局桶。
          ...sessionIdField(egressSessionId),
          reason: err?.message ?? String(err),
        })
        throw new LlmError(
          `cloud-llm-adapter: egress preparation failed (${err?.message ?? String(err)}) — refusing to send unscrubbed text`,
          'SANITIZE_FAILED',
        )
      }
    }

    // §7.48 (2026-09-13): system-prompt augmentation to nudge DeepSeek to
    // synthesize answer after receiving tool results, instead of looping
    // additional tool calls. 5x news verification (§7.47 followup):
    // 3/5 runs aborted with kind=error because DeepSeek chose tool-calls
    // over synthesis after gathering enough information. dsh-llm's
    // buildChatCompletionsBody (openai-sse.ts:53) prepends options.system
    // as a wire-level `{role:'system', content:string}` message — so we
    // append (not replace) the existing system prompt when this stream
    // is about to receive tool results.
    // Inject only when:
    //   1) messages already include a tool-result block — i.e. previous
    //      turn triggered a tool call. First-turn text-only chats don't
    //      need this guidance;
    //   2) we don't disturb an already-set system prompt — we APPEND to
    //      it so user/runtime-set instructions are preserved.
    // Scope: cloud-llm-adapter only. Local LLMs may have different
    // tool-call patterns; we don't want to disturb them.
    // Detection uses `source.kind === 'tool'` because dsh-llm's Message
    // type's `role` is `'system' | 'user' | 'assistant'` only — tool
    // results surface as user-role messages with source.kind='tool'.
    const hasToolResult = sanitizedMessages.some(
      (m) => (m as unknown as { source?: { kind?: string } }).source?.kind === 'tool',
    )
    let augmentedSystem = typeof options.system === 'string' ? options.system : ''
    let systemInjected = false
    if (hasToolResult) {
      const synthInstruction =
        'You have received tool results above. Based on those results, synthesize a comprehensive answer in the user\'s language. Do not call additional tools unless the existing results are clearly insufficient. Avoid empty responses.'
      augmentedSystem = augmentedSystem.length > 0
        ? `${augmentedSystem}\n\n${synthInstruction}`
        : synthInstruction
      systemInjected = true
    }

    const body = buildChatCompletionsBody(
      { ...options, messages: sanitizedMessages, system: augmentedSystem.length > 0 ? augmentedSystem : options.system },
      this.defaultModel,
      this.temperature,
    )
    const promptText = sanitizedMessages.map((m) => `${m.role}:${extractText(m.content)}`).join('\n')
    const promptLen = promptText.length
    const messageCount = sanitizedMessages.length
    // §7.54.7 (2026-09-14): capture wire-system (after tool-result augmentation)
    // for ops log so operator can see what system prompt actually went out.
    // Truncate to first 200 chars to keep log lines readable; full text is in
    // the request body which DSH_EDGE_LOG_LEVEL=debug exposes via LLM_MESSAGES.
    const wireSystem = augmentedSystem.length > 0 ? augmentedSystem : (typeof options.system === 'string' ? options.system : '')
    const systemLen = wireSystem.length
    const systemPreview = systemLen > 0 ? wireSystem.slice(0, 200).replace(/\s+/g, ' ') : ''
    const start = Date.now()
    // §7.46.1 (2026-09-11): ops log 让"TUI 路径调了哪个 LLM / 多少
    // token / 多久"在 ops log 里可见。http-api POST 200 行有 provider/model
    // + duration，但 TUI 路径之前只能靠 audit JSONL。start 行 + done
    // 行成对，配合 realm-skill-bridge 的 pre-step / tool-allow 形成
    // 完整 trace。
    const sessionId = (options as { sessionId?: string }).sessionId ?? 'unknown'
    try {
      this.logger?.info?.(
        `[cloud-llm-adapter] LLM call start sessionId=${sessionId} provider=${options.provider} model=${options.model} messageCount=${messageCount} promptLen=${promptLen} systemLen=${systemLen}${systemPreview ? ` systemPreview="${systemPreview}${systemLen > 200 ? '...' : ''}"` : ''} baseUrl=${this.baseUrl}`,
      )
    } catch { /* debug only */ }
    // 2026-09-02: dump the full sanitized messages array to the ops log
    // at debug level. JSON.stringify keeps the entry single-line so
    // file-logger's `formatLine` newline-collapse doesn't kick in.
    this.logger?.debug?.(`[cloud-llm-adapter] LLM_MESSAGES ${JSON.stringify({ messages: sanitizedMessages })}`)
    // §7.118: 详细 request trace —— 逐条 message 的角色 / 正文 / 工具回显，
    // 经凭据 + PII 脱敏、按字段截断后写进 ops log（info 级别，默认可见）。
    this.traceRequest(
      sessionId,
      options,
      wireSystem,
      sanitizedMessages as unknown as Array<{ role: string; content: unknown; source?: { kind?: string } }>,
      body,
    )
    // §7.147: 同 `llm.local.start` —— 这条**开始**行必须带 sessionId，
    // 否则它落全局桶，Edge 面板的路由面板永远说不清「这一轮」。
    this.audit('info', 'llm.cloud.start', { ...sessionIdField(options.sessionId), provider: options.provider, model: options.model, messageCount, promptLen, baseUrl: this.baseUrl, systemInjected, retryBudgetUsed: peekSessionSseRetryCount(options.sessionId), historyDropped: egressDropped, egressReplacements: egressReplacements, egressSanitized, ...egressAuditFields(options) })
    // §7.131: 出网裁剪单独留一行 —— operator grep `llm.cloud.egress` 就能看到
    // 「这一轮带了多少历史上去 / 丢了多少本地段 / 脱敏替换了几处」。
    if (egressDropped > 0 || egressReplacements > 0 || !egressSanitized) {
      this.audit('info', 'llm.cloud.egress', {
        provider: options.provider,
        model: options.model,
        // §7.147: 同上 —— `'unknown'` 是假会话 id，改成「没有就不写」。
        ...sessionIdField(egressSessionId),
        keptMessages: messageCount,
        droppedLocalHistory: egressDropped,
        replacements: egressReplacements,
        sanitized: egressSanitized,
      })
    }


    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'authorization': `Bearer ${apiKey}`,
      'accept': 'text/event-stream',
      ...attributionHeaders(),
    }

    // §7.50 (2026-09-13): wrap fetch + SSE parsing in a per-session retry
    // loop. Triggered when the upstream DeepSeek SSE stream disconnects
    // before yielding any chunk (observed 137-494ms drop in §7.48 news
    // verification, 2/5 runs aborted with kind=error after §7.48's
    // system-prompt augmentation already cleared the synthesis-side issue).
    //
    // §7.49 had explored retrying at the dsh-agent-loop layer; reverted
    // because (a) cordis ctx accessor requires extra inject, (b) Session.append
    // reentrancy guard throws from listeners, (c) dsh-agent-loop's turn model
    // doesn't rescue kind=error — new turns are fire-and-forget and don't
    // flow back to http-api response. So retry must live at the LLM-adapter
    // layer.
    //
    // Constraints:
    //   - retry only when no chunk has been yielded yet across the whole
    //     stream lifetime (avoids wasting tokens that upstream already
    //     produced; mid-stream drops in attempt N>1 → throw because the
    //     consumer has already consumed attempt 1's chunks)
    //   - per-session counter ≤ 1 (tryConsumeSseRetryBudget) so worst-case
    //     latency stays bounded and we don't amplify provider pressure
    //   - emit ops log + audit events for retry triggered / retry exhausted
    //     so the diagnostic matches the user principle "log should make
    //     the bug reproducible"
    //
    // yield semantics: we cannot `yield` from inside a retry helper
    // (generators can't yield across function boundaries). So we loop
    // inline and track `sawAnyChunkAcrossAttempts` — set true the first
    // time we yield a chunk; subsequent retry attempts bail on error.
    let sawAnyChunkAcrossAttempts = false
    let attemptIndex = 0
    let lastAttemptError: string | undefined
    // Hoisted so the post-loop runaway-tool-call guard + terminalChunks
    // yield can read the FINAL attempt's state after `break outer`.
    let assembledText = ''
    let finishKind: 'stop' | 'length' | 'tool-calls' | undefined
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>()
    let sawText = false
    let sawToolCall = false

    outer: while (true) {
      attemptIndex += 1
      // Reset per-attempt state (assembledText etc. are scoped INSIDE
      // the loop so they naturally discard on retry).
      let response: Response
      try {
        response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: options.signal,
        })
      } catch (err: any) {
        const errMsg = err?.message ?? String(err)
        lastAttemptError = `fetch: ${errMsg}`
        const durationMs = Date.now() - start
        this.audit('error', 'llm.cloud.network_error', { sessionId: options.sessionId,
          provider: options.provider,
          model: options.model,
          durationMs,
          attempt: attemptIndex,
          error: errMsg,
          ...egressAuditFields(options),
        })
        // §7.50 followup: emit bookkeeping on fetch throw too. AbortError
        // (signal aborted by dsh-agent-loop) is the common case — ops log
        // previously showed only LLM call start, hiding the abort source.
        try {
          this.logger?.info?.(
            `[cloud-llm-adapter] LLM call done sessionId=${sessionId} provider=${options.provider} model=${options.model} attempt=${attemptIndex} retried=false durationMs=${durationMs} resultLen=0 toolCallCount=0 finishKind=unknown fetchError=${errMsg}`,
          )
        } catch { /* debug only */ }
        // §7.118: 失败也要有 response trace —— 否则 ops log 里只剩一个
        // fetchError= 字样，看不出到底发了什么出去、为什么失败。
        this.traceResponse(sessionId, options.provider, options.model ?? this.defaultModel, '', [], undefined, durationMs, attemptIndex, errMsg, options,
          // §7.144: 传输层失败也要有完整响应体（错误原文）。
          { error: errMsg, attempt: attemptIndex })
        this.audit('info', 'llm.cloud.end', { sessionId: options.sessionId,
          provider: options.provider,
          model: options.model,
          durationMs,
          ...egressAuditFields(options),
          promptLen,
          resultLen: 0,
          toolCallCount: 0,
          finishKind: undefined,
          sawText: false,
          sawToolCall: false,
          attempt: attemptIndex,
          retried: attemptIndex > 1,
          fetchError: errMsg,
        })
        if (!tryConsumeSseRetryBudget(options.sessionId)) {
          this.logger?.error?.(
            `[cloud-llm-adapter] SSE retry exhausted sessionId=${sessionId} attempt=${attemptIndex} reason=fetch_throw error=${errMsg}`,
          )
          throw err
        }
        this.logger?.warn?.(
          `[cloud-llm-adapter] SSE retry triggered sessionId=${sessionId} attempt=${attemptIndex} reason=fetch_throw error=${errMsg}`,
        )
        this.audit('warn', 'llm.cloud.sse_retry_triggered', {
          provider: options.provider,
          model: options.model,
          sessionId,
          attempt: attemptIndex,
          reason: 'fetch_throw',
          error: errMsg,
        })
        continue
      }

      if (!response.ok) {
        const durationMs = Date.now() - start
        let respBody = ''
        try { respBody = await response.text() } catch { /* ignore */ }
        // HTTP 4xx/5xx — don't retry; the upstream rejected the request,
        // and retrying identical body won't help (would only amplify 429s).
        this.audit('error', 'llm.cloud.http_error', { sessionId: options.sessionId,
          provider: options.provider,
          model: options.model,
          status: response.status,
          durationMs,
          respBody: respBody.slice(0, 500),
          ...egressAuditFields(options),
        })
        // §7.50 followup (2026-09-13): also emit the LLM call done / end
        // bookkeeping on HTTP error so the ops log + audit pipeline
        // always has a matching end-pair for the start. Without this,
        // 4xx errors leave ops log showing only LLM call start (which
        // made the §7.50 verification look like a 0/5 regression — it
        // was actually a 402 Insufficient Balance).
        try {
          this.logger?.info?.(
            `[cloud-llm-adapter] LLM call done sessionId=${sessionId} provider=${options.provider} model=${options.model} attempt=${attemptIndex} retried=false durationMs=${durationMs} resultLen=0 toolCallCount=0 finishKind=unknown httpError=${response.status}`,
          )
        } catch { /* debug only */ }
        // §7.118: HTTP 失败同样留 response trace（含上游返回体摘要）。
        this.traceResponse(
          sessionId,
          options.provider,
          options.model ?? this.defaultModel,
          '',
          [],
          undefined,
          durationMs,
          attemptIndex,
          `HTTP ${response.status}: ${respBody.slice(0, 300)}`,
          options,
          // §7.144: HTTP 失败的上游返回体（主人排查 400 时要看的就是它）。
          { status: response.status, body: respBody, attempt: attemptIndex },
        )
        this.audit('info', 'llm.cloud.end', { sessionId: options.sessionId,
          provider: options.provider,
          model: options.model,
          durationMs,
          ...egressAuditFields(options),
          promptLen,
          resultLen: 0,
          toolCallCount: 0,
          finishKind: undefined,
          sawText: false,
          sawToolCall: false,
          attempt: attemptIndex,
          retried: attemptIndex > 1,
          httpError: response.status,
        })
        throw new LlmError(`cloud-llm-adapter: HTTP ${response.status}: ${respBody.slice(0, 200)}`, 'PROVIDER_ERROR')
      }

      // 2026-09-03 §7.34.2 fix: defer `block-start` until the first text-delta.
      // Same root cause as local-llm-adapter — empty stream (e.g. DeepSeek upstream
      // returns finish=stop with 0 content) would leave BlockAssembler with an
      // orphan text block + finish, agent-loop state machine hangs.
      let blockStartYielded = false
      const yieldBlockStartOnce = (): boolean => {
        if (blockStartYielded) return false
        blockStartYielded = true
        return true
      }
      // assembledText / finishKind / toolCalls / sawText / sawToolCall are
      // hoisted to outer scope so post-loop logic can read the FINAL
      // attempt's state. We reset them on each retry attempt so attempt 2
      // starts fresh (discarding attempt 1's partial progress).
      assembledText = ''
      finishKind = undefined
      toolCalls.clear()
      sawText = false
      sawToolCall = false

      const throwOnWire = (message: string): never => {
        throw new LlmError(`cloud-llm-adapter: SSE stream interrupted: ${message}`, 'PROVIDER_ERROR')
      }

      let wireError: string | undefined
      try {
        for await (const event of iterateSseFrames(response, throwOnWire)) {
          const reason = sseFinishReason(event)
          if (reason !== undefined) {
            finishKind = reason
            continue
          }
          const result = sseEventToChunk(event, toolCalls)
          if (result === null) continue
          if (result.chunk.type === 'text-delta') {
            // §7.34.2: yield block-start lazily before the first text-delta
            if (yieldBlockStartOnce()) {
              yield { type: 'block-start', index: 0, blockType: 'text' }
            }
            assembledText += (result.chunk as { text: string }).text
            sawText = result.sawText
          } else if (result.chunk.type === 'tool-call-delta') {
            sawToolCall = result.sawToolCall
          }
          if (!sawAnyChunkAcrossAttempts) sawAnyChunkAcrossAttempts = true
          yield result.chunk
        }
        // Stream completed normally — break the outer retry loop.
        // Reset the retry counter so future calls in this session start fresh.
        resetSessionSseRetryCount(options.sessionId)
        break outer
      } catch (err: any) {
        wireError = err?.message ?? String(err)
        lastAttemptError = `sse: ${wireError}`
        const durationMs = Date.now() - start
        this.audit('error', 'llm.cloud.sse_interrupted', { sessionId: options.sessionId,
          provider: options.provider,
          model: options.model,
          durationMs,
          attempt: attemptIndex,
          wireError,
        })
        if (sawAnyChunkAcrossAttempts) {
          // Mid-stream drop on a later try after attempt 1 yielded some
          // chunks — don't retry, the consumer has already consumed them.
          throw err
        }
        if (!tryConsumeSseRetryBudget(options.sessionId)) {
          this.logger?.error?.(
            `[cloud-llm-adapter] SSE retry exhausted sessionId=${sessionId} attempt=${attemptIndex} reason=sse_wire_error wireError=${wireError}`,
          )
          throw err
        }
        this.logger?.warn?.(
          `[cloud-llm-adapter] SSE retry triggered sessionId=${sessionId} attempt=${attemptIndex} reason=sse_wire_error wireError=${wireError}`,
        )
        this.audit('warn', 'llm.cloud.sse_retry_triggered', {
          provider: options.provider,
          model: options.model,
          sessionId,
          attempt: attemptIndex,
          reason: 'sse_wire_error',
          wireError,
        })
        // Note: assembledText is intentionally discarded on retry — we
        // are retrying from scratch because no chunk has been yielded yet.
        continue
      } finally {
        const durationMs = Date.now() - start
        const retried = attemptIndex > 1
        this.audit('info', 'llm.cloud.end', { sessionId: options.sessionId,
          provider: options.provider,
          model: options.model,
          durationMs,
          ...egressAuditFields(options),
          promptLen,
          resultLen: assembledText.length,
          toolCallCount: toolCalls.size,
          finishKind,
          sawText,
          sawToolCall,
          attempt: attemptIndex,
          retried,
          ...(wireError !== undefined ? { wireError } : {}),
          ...(lastAttemptError !== undefined && wireError === undefined ? { lastAttemptError } : {}),
        })
        // §7.46.1: ops log done 行,跟 start 行配对
        try {
          this.logger?.info?.(
            `[cloud-llm-adapter] LLM call done sessionId=${sessionId} provider=${options.provider} model=${options.model} attempt=${attemptIndex} retried=${retried} durationMs=${durationMs} resultLen=${assembledText.length} toolCallCount=${toolCalls.size} finishKind=${finishKind ?? 'unknown'}${wireError !== undefined ? ` wireError=${wireError}` : ''}`,
          )
        } catch { /* debug only */ }
        // 2026-09-02: dump response summary + full text to the ops log at
        // debug level. Splits into two entries (header + body) so grepping
        // for `LLM_RESPONSE_TEXT` can isolate the body without parsing JSON.
        this.logger?.debug?.(`[cloud-llm-adapter] LLM_RESPONSE provider=${options.provider} attempt=${attemptIndex} durationMs=${durationMs} resultLen=${assembledText.length} finishKind=${finishKind ?? 'unknown'}`)
        this.logger?.debug?.(`[cloud-llm-adapter] LLM_RESPONSE_TEXT ${JSON.stringify({ text: assembledText })}`)
        // §7.118: 详细 response trace（正文 + tool calls + finish reason）。
        this.traceResponse(
          sessionId,
          options.provider,
          options.model ?? this.defaultModel,
          assembledText,
          [...toolCalls.values()].map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })),
          finishKind,
          durationMs,
          attemptIndex,
          wireError,
          options,
          // §7.144: 完整响应体（正文 + 工具调用 + 结束原因）。
          {
            content: assembledText,
            tool_calls: [...toolCalls.values()].map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })),
            finish_reason: finishKind ?? 'unknown',
            ...(wireError !== undefined ? { wire_error: wireError } : {}),
          },
        )
      }
    }

    // §7.47.5 (2026-09-13): per-session runaway tool-call guard, mirrored
    // from local-llm-adapter (§7.42) which only protected local models.
    // cloud-llm-adapter previously had no guard, so DeepSeek looping
    // web_search/web_fetch indefinitely (e.g. "查询最新的AI新闻" hits it
    // deterministically — DeepSeek picks "call more tools" over
    // "synthesize answer" until dsh-agent-loop upper layer aborts with
    // reason=unknown → resultLen=0 → user sees empty reply). Now: emit
    // audit + logger.error + throw MAX_TURNS_EXCEEDED so ops log records
    // the runaway and agent loop terminates with a deterministic reason.
    if (finishKind === 'tool-calls') {
      if (!sawText) {
        const consecutiveCount = bumpSessionToolCallCount(options.sessionId)
        const sessionKeyForLog = typeof options.sessionId === 'string' && options.sessionId.length > 0
          ? options.sessionId
          : 'default'
        if (consecutiveCount > MAX_CONSECUTIVE_TOOL_CALLS) {
          this.audit('warn', 'llm.cloud.max_turns_exceeded', {
            provider: options.provider,
            model: options.model,
            sessionId: sessionKeyForLog,
            consecutiveCount,
          })
          this.logger?.error?.(
            `[cloud-llm-adapter] per-session max-turns exceeded (session=${sessionKeyForLog}, count=${consecutiveCount}/${MAX_CONSECUTIVE_TOOL_CALLS})`,
          )
          // Reset counter so next call starts fresh (agent loop may retry).
          resetSessionToolCallCount(options.sessionId)
          throw new LlmError(
            `cloud-llm-adapter: per-session max-turns exceeded (count=${consecutiveCount})`,
            'MAX_TURNS_EXCEEDED',
          )
        }
      } else {
        // Tool-call response with text content -> progress, reset counter.
        resetSessionToolCallCount(options.sessionId)
      }
    } else if (finishKind === 'stop' || finishKind === 'length') {
      // Natural termination -> reset counter.
      resetSessionToolCallCount(options.sessionId)
    }

    yield* terminalChunks(sawText, assembledText, toolCalls, finishKind, sawToolCall)
  }
}

/* ════════════════════════════════════════════════════════════════════
 * §7.100 DELEGATE MODE — "只需要配置 local-llm；宿主 profile 已配置的
 * 模型提供商即 cloud-llm"。
 *
 * baseUrl 为空（Schema 默认）时注册的是这个纯转发适配器：`cloud-llm` 路由
 * 保留（model-router / http-api / input-guard / patch 全按这个名字钉死，
 * 不用改任何消费方），但 stream 时把请求转发给宿主已注册的 provider route
 * —— key / OAuth / 凭据解析全归宿主 adapter（dsh-credentials 层），我们
 * 不再碰任何 secret。直连模式（baseUrl 显式配置）行为完全不变。
 *
 * 解析链（每次 stream 调用求值，`llm/adapters-updated` 事件清缓存）：
 *   1. delegateProvider（env 显式指定）→ 必须 live 且非自有路由，否则响亮失败
 *   2. agentDefaultModel.currentSelection()（桌面 GUI 选的模型，volatile 实时）
 *   3. live 拓扑探针：稳定云路由（deepseek-account / deepseek-official）优先，
 *      其余按注册顺序（llm-pi-ai 用户路由等）
 *   4. 都没有 → LlmError('NO_CLOUD_TARGET')。绝不返回零 chunk 的静默流
 *      —— 那正是 §7.98 L2 "200 + 空回复" 的成因家族。
 * 护栏：永不委托给 'cloud-llm'（自己，防递归）或 'local-llm'（LOCAL 池，
 * 防 realm 语义反转）。委托流量只服务 SANITIZED/CLOUD 回答；意图分类与
 * guard 检测按用户仲裁只吃本地模型，未配置即降级规则档。
 * ════════════════════════════════════════════════════════════════════ */

export interface CloudDelegateTarget {
  /** Live host route to forward to. */
  provider: string
  /** Wire model; undefined = resolve at stream time (host first model id). */
  model?: string
  /** Which resolution step produced this — forensic provenance in audit. */
  source: 'env' | 'selection' | 'probe'
}

/** Minimal live-topology surface the delegate needs from ctx.llm. */
interface DelegateLlmLike {
  listProviders(): Array<{ id: string; name: string }>
  stream(options: GenerateOptions): AsyncIterable<StreamChunk> | Promise<AsyncIterable<StreamChunk>>
  listModels(provider: string): Promise<readonly LlmModelInfo[]>
  resolveModelInfo?(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>
}

/** Structural view of `@deepseek-ai/dsh-agent-default-model`'s service. */
interface AgentDefaultModelLike {
  currentSelection(): { provider?: string; model?: string } | undefined
}

export interface DelegateAccessors {
  llm: DelegateLlmLike
  /** Soft dep: absent in minimal/headless graphs without dsh-base. */
  getAgentDefaultModel(): AgentDefaultModelLike | undefined
}

interface DelegateConfigLike {
  /** Own route ids (the cloud-llm set) — recursion guard. */
  providers: string[]
  delegateProvider?: string
  delegateModel?: string
  delegateEnabled?: boolean
}

/** Stable dsh-base cloud routes win over user-defined pi-ai keys (registry
 *  order alone would make the pick depend on mount timing). */
const DELEGATE_PRIORITY = ['deepseek-account', 'deepseek-official']

/**
 * Pure resolution probe — exported for input-guard's `cloudAvailable()`
 * (same chain, sync only: no async model fetch). Returns null when no
 * usable cloud target exists.
 */
export function probeCloudTarget(
  accessors: DelegateAccessors,
  cfg: DelegateConfigLike,
): CloudDelegateTarget | null {
  if (cfg.delegateEnabled === false) return null
  const own = new Set<string>([...cfg.providers, 'local-llm'])
  let live: string[]
  try {
    live = accessors.llm.listProviders().map((p) => p.id)
  } catch {
    return null
  }
  const usable = live.filter((id) => !own.has(id))
  const modelOverride = (cfg.delegateModel ?? '').trim()

  // Step 1: explicit operator intent — honored or loud failure, never silently skipped.
  const dp = (cfg.delegateProvider ?? '').trim()
  if (dp.length > 0) {
    if (own.has(dp) || !usable.includes(dp)) return null
    return { provider: dp, model: modelOverride.length > 0 ? modelOverride : undefined, source: 'env' }
  }

  // Step 2: the host profile's live selection (Desktop GUI model picker).
  let selection: { provider?: string; model?: string } | undefined
  try {
    selection = accessors.getAgentDefaultModel()?.currentSelection()
  } catch {
    selection = undefined
  }
  if (
    selection
    && typeof selection.provider === 'string'
    && selection.provider.length > 0
    && usable.includes(selection.provider)
  ) {
    const selModel = typeof selection.model === 'string' && selection.model.length > 0 ? selection.model : undefined
    return { provider: selection.provider, model: modelOverride.length > 0 ? modelOverride : selModel, source: 'selection' }
  }

  // Step 3: live-topology probe, stable ids first.
  const ordered = [
    ...DELEGATE_PRIORITY.filter((id) => usable.includes(id)),
    ...usable.filter((id) => !DELEGATE_PRIORITY.includes(id)),
  ]
  if (ordered.length > 0) {
    return { provider: ordered[0], model: modelOverride.length > 0 ? modelOverride : undefined, source: 'probe' }
  }
  return null
}

export class CloudLlmDelegateAdapterImpl extends LlmAdapter {
  private readonly providersList: string[]
  private readonly cfg: DelegateConfigLike
  private readonly accessors: DelegateAccessors
  private readonly auditLog: AuditLike | undefined
  private readonly inputGuard: InputGuardLike | undefined
  private readonly logger: LoggerLike | undefined
  /** §7.131: 出网准备器（裁剪云段 + 脱敏）。 */
  private readonly egress: CloudEgressGuard | undefined

  /** Cached probe result (undefined = not probed yet; null = probed, none). */
  private targetCache: CloudDelegateTarget | null | undefined
  /** provider → first advertised model id, so stream() never re-fetches lists. */
  private readonly modelIdCache = new Map<string, string>()

  constructor(
    config: DelegateConfigLike,
    accessors: DelegateAccessors,
    auditLog?: AuditLike,
    inputGuard?: InputGuardLike,
    logger?: LoggerLike,
    egress?: CloudEgressGuard,
  ) {
    super()
    this.providersList = [...config.providers]
    this.cfg = config
    this.accessors = accessors
    this.auditLog = auditLog
    this.inputGuard = inputGuard
    this.logger = logger
    this.egress = egress
  }

  private audit(level: 'debug' | 'info' | 'warn' | 'error' | 'security', kind: string, payload: Record<string, unknown>): void {
    if (!this.auditLog) return
    void this.auditLog.log({ level, kind, source: 'cloud-llm-adapter', payload }).catch(() => {})
  }

  /** `llm/adapters-updated` sink: drop cached target + model ids so the
   *  next call re-probes the new topology (host route churn is normal —
   *  llm-pi-ai itself re-registers via handle.replace on settings edits). */
  invalidateTopology(): void {
    this.targetCache = undefined
    this.modelIdCache.clear()
  }

  private resolveTarget(): CloudDelegateTarget | null {
    if (this.targetCache === undefined) {
      this.targetCache = probeCloudTarget(this.accessors, this.cfg)
    }
    return this.targetCache
  }

  get providers(): string[] {
    return [...this.providersList]
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: provider }
  }

  /** §7.106 Option A: see the base adapter's listModels — the delegate route
   *  is deliberately invisible in the catalog (a proxy of the host's own
   *  selection has nothing to advertise of its own). `stream()`/`resolveModel`
   *  keep working; `firstModelId` reads the TARGET provider's catalog via the
   *  registry, which is unaffected by what this route advertises. */
  override listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([])
  }

  override async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const target = this.resolveTarget()
    if (target && this.accessors.llm.resolveModelInfo) {
      try {
        const info = await this.accessors.llm.resolveModelInfo(target.provider, target.model ?? model, signal)
        // Borrow the delegate target's CAPABILITY (contextWindow, modalities,
        // cost — §7.43 compaction reads them) but never its IDENTITY: the
        // dsh-llm contract (INVALID_MODEL_INFO, dsh-llm lib/index.js:2121)
        // rejects a resolve whose provider/id do not equal the caller's
        // request — and a caller selecting 'cloud-llm/deepseek-chat' must get
        // exactly that back, not the host route's real model ('deepseek-v4-
        // flash-0731'). The earlier `{ ...info, provider }` kept the target's
        // id and failed validation, killing every turn on this route.
        const sameIdentity = info.id === model
        return {
          ...info,
          provider,
          id: model,
          name: sameIdentity ? info.name : model,
          ...(sameIdentity && typeof info.description === 'string' ? { description: info.description } : {}),
        }
      } catch {
        /* fall through to static shape */
      }
    }
    return { provider, id: model, name: model, context: { contextWindow: 65536 } }
  }

  private async firstModelId(target: CloudDelegateTarget): Promise<string | undefined> {
    const cached = this.modelIdCache.get(target.provider)
    if (cached) return cached
    try {
      const models = await this.accessors.llm.listModels(target.provider)
      const first = models[0]?.id
      if (first) this.modelIdCache.set(target.provider, first)
      return first
    } catch {
      return undefined
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const target = this.resolveTarget()
    if (!target) {
      this.logger?.error?.(
        `[cloud-llm-adapter] NO_CLOUD_TARGET sessionId=${(options as { sessionId?: string }).sessionId ?? 'unknown'} provider=${options.provider} delegateEnabled=${this.cfg.delegateEnabled !== false}`,
      )
      this.audit('error', 'llm.cloud.delegate.unavailable', { sessionId: options.sessionId,
        provider: options.provider,
        model: options.model,
        delegateProvider: this.cfg.delegateProvider ?? '',
        hint: 'configure CLOUD_LLM_BASEURL (direct pool), select a model in the host profile, or set DSH_EDGE_CLOUD_DELEGATE=false',
      })
      throw new LlmError(
        'cloud-llm-adapter: no cloud provider available (delegate mode). '
        + 'Configure CLOUD_LLM_BASEURL for a direct pool, select a model in the host profile, '
        + 'or set DSH_EDGE_CLOUD_DELEGATE=false to restore the §7.35 downgrade-to-LOCAL semantics.',
        'NO_CLOUD_TARGET',
      )
    }

    const wireModel = target.model ?? (await this.firstModelId(target)) ?? options.model
    const sessionId = (options as { sessionId?: string }).sessionId ?? 'unknown'

    // Orphan-tool-call wash (2026-08-31 fix, same rationale as direct mode):
    // run it before forwarding so the host adapter sees clean history too.
    let forwardMessages = options.messages
    if (this.inputGuard) {
      const result = this.inputGuard.sanitizeOrphanToolCalls(
        options.messages as unknown as ReadonlyArray<Record<string, unknown>>,
        (options as { sessionId?: string }).sessionId,
      )
      forwardMessages = result.messages as unknown as typeof options.messages
    }

    // §7.131 (2026-10-27): delegate 路径同样要裁剪 —— 它转发给宿主的云模型，
    // 那也是出网。当前部署走的就是这条（llm.cloud.baseUrl="" = DELEGATE），实测
    // 10-24 的 route.restored 就是带着 28 条本地历史走到这里的。
    let egressDropped = 0
    let egressReplacements = 0
    let egressSanitized = false
    if (this.egress) {
      try {
        const prepared = await this.egress.prepare(
          forwardMessages as unknown as EgressMessage[],
          sessionId,
        )
        forwardMessages = prepared.messages as unknown as typeof options.messages
        egressDropped = prepared.droppedCount
        egressReplacements = prepared.replacements
        egressSanitized = prepared.sanitized
      } catch (err: any) {
        this.audit('security', 'llm.cloud.egress.blocked', {
          provider: target.provider,
          model: wireModel,
          sessionId,
          reason: err?.message ?? String(err),
        })
        throw new LlmError(
          `cloud-llm-adapter: egress preparation failed (${err?.message ?? String(err)}) — refusing to send unscrubbed text`,
          'SANITIZE_FAILED',
        )
      }
    }

    this.audit('info', 'llm.cloud.delegate.resolved', {
      from: 'cloud-llm',
      toProvider: target.provider,
      toModel: wireModel,
      source: target.source,
      sessionId,
      messageCount: forwardMessages.length,
      historyDropped: egressDropped,
      egressReplacements,
      egressSanitized,
    })
    if (egressDropped > 0 || egressReplacements > 0 || !egressSanitized) {
      this.audit('info', 'llm.cloud.egress', {
        provider: target.provider,
        model: wireModel,
        sessionId,
        keptMessages: forwardMessages.length,
        droppedLocalHistory: egressDropped,
        replacements: egressReplacements,
        sanitized: egressSanitized,
      })
    }
    try {
      this.logger?.info?.(
        `[cloud-llm-adapter] DELEGATE start sessionId=${sessionId} from=cloud-llm to=${target.provider}/${wireModel} source=${target.source} messageCount=${forwardMessages.length} droppedLocalHistory=${egressDropped}`,
      )
    } catch { /* debug only */ }

    const start = Date.now()
    let assembledLen = 0
    let sawText = false
    let sawToolCall = false
    let finishKind: 'stop' | 'length' | 'tool-calls' | 'error' | 'aborted' | string | undefined

    try {
      const streamRaw = this.accessors.llm.stream({
        ...options,
        messages: forwardMessages,
        provider: target.provider,
        model: wireModel,
      })
      // §7.37 compat: llm.stream() may be a thenable returning the iterable.
      const stream = (streamRaw != null && typeof (streamRaw as { then?: unknown }).then === 'function')
        ? await (streamRaw as Promise<AsyncIterable<StreamChunk>>)
        : streamRaw as AsyncIterable<StreamChunk>

      // Forward verbatim — the host adapter synthesizes its own terminal
      // chunks; we must NOT append terminalChunks (would double the finish).
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') {
          sawText = true
          assembledLen += chunk.text.length
        } else if (chunk.type === 'tool-call-delta') {
          sawToolCall = true
        } else if (chunk.type === 'finish') {
          finishKind = (chunk.reason as { kind?: string } | undefined)?.kind
        }
        yield chunk
      }
    } finally {
      const durationMs = Date.now() - start
      this.audit('info', 'llm.cloud.delegate.end', {
        from: 'cloud-llm',
        toProvider: target.provider,
        toModel: wireModel,
        sessionId,
        durationMs,
        resultLen: assembledLen,
        sawText,
        sawToolCall,
        finishKind,
      })
      try {
        this.logger?.info?.(
          `[cloud-llm-adapter] DELEGATE done sessionId=${sessionId} from=cloud-llm to=${target.provider}/${wireModel} source=${target.source} durationMs=${durationMs} resultLen=${assembledLen} finishKind=${finishKind ?? 'unknown'}`,
        )
      } catch { /* debug only */ }
    }

    // §7.47.5 runaway parity: delegated cloud models loop tool-calls the same
    // way our direct client saw with DeepSeek — same per-session counter.
    if (finishKind === 'tool-calls') {
      if (!sawText) {
        const consecutiveCount = bumpSessionToolCallCount(options.sessionId)
        const sessionKeyForLog = typeof options.sessionId === 'string' && options.sessionId.length > 0
          ? options.sessionId
          : 'default'
        if (consecutiveCount > MAX_CONSECUTIVE_TOOL_CALLS) {
          this.audit('warn', 'llm.cloud.max_turns_exceeded', {
            provider: 'cloud-llm',
            toProvider: target.provider,
            model: wireModel,
            sessionId: sessionKeyForLog,
            consecutiveCount,
          })
          this.logger?.error?.(
            `[cloud-llm-adapter] per-session max-turns exceeded (session=${sessionKeyForLog}, count=${consecutiveCount}/${MAX_CONSECUTIVE_TOOL_CALLS})`,
          )
          resetSessionToolCallCount(options.sessionId)
          throw new LlmError(
            `cloud-llm-adapter: per-session max-turns exceeded (count=${consecutiveCount})`,
            'MAX_TURNS_EXCEEDED',
          )
        }
      } else {
        resetSessionToolCallCount(options.sessionId)
      }
    } else if (finishKind === 'stop' || finishKind === 'length') {
      resetSessionToolCallCount(options.sessionId)
    }
  }
}

/** Read an env-slot key, throwing on absence is left to the caller. */
function readApiKey(slot: string): string | undefined {
  if (typeof process === 'undefined' || !process.env) return undefined
  const value = process.env[slot]
  if (typeof value !== 'string' || value.length === 0) return undefined
  return value
}

export async function apply(ctx: Context, config: Config): Promise<() => Promise<void>> {
  ctx.logger?.info?.(`[cloud-llm-adapter] apply() called with providers: ${config.providers?.join(', ')}`)
  // §7.102: the cloud pool and the delegate knobs come from
  // config/edge.json (llm.cloud.*). The cordis patch row no longer reads
  // process.env — the desktop GUI never had those variables.
  const cloud = cloudPool()
  if (cloud.baseUrl !== undefined && cloud.baseUrl !== config.baseUrl) {
    ctx.logger?.info?.(`[cloud-llm-adapter] baseUrl from config/edge.json: ${config.baseUrl} → ${cloud.baseUrl}`)
    ;(config as { baseUrl: string }).baseUrl = cloud.baseUrl
  }
  // §7.111 (2026-10-24): llm.cloud.model was silently dropped here — the
  // direct mode then wired the Schema default 'deepseek-chat' to whatever
  // endpoint the operator configured (observed: MiniMax 400 "unknown model
  // 'deepseek-chat'"). Map it onto defaultModel like the other pool fields.
  if (cloud.model !== undefined && cloud.model !== '') {
    ;(config as { defaultModel?: string }).defaultModel = cloud.model
  }
  if (cloud.delegateProvider !== undefined) {
    ;(config as { delegateProvider?: string }).delegateProvider = cloud.delegateProvider
  }
  if (cloud.delegateModel !== undefined) {
    ;(config as { delegateModel?: string }).delegateModel = cloud.delegateModel
  }
  ;(config as { delegateEnabled?: boolean }).delegateEnabled = cloud.delegate
  if (cloud.apiKey !== undefined) {
    ;(config as { apiKey?: string }).apiKey = cloud.apiKey
  }
  const auditLog = (ctx as unknown as { auditLog?: AuditLike }).auditLog
  // input-guard 是可选注入 —— plugin 启动顺序里 cloud-llm-adapter 在
  // input-guard 之后才能拿到；否则降级为不洗（保持旧行为）。enableInputGuard=false
  // 时 inputGuard.sanitizeOrphanToolCalls 自身也 pass-through。
  const inputGuard = (ctx as unknown as { inputGuard?: InputGuardLike }).inputGuard
  const logger = ctx.logger as LoggerLike | undefined

  // §7.100: baseUrl 空（Schema 默认）= delegate 模式；显式配置 = 直连不变。
  const baseUrl = typeof config.baseUrl === 'string' ? config.baseUrl.trim() : ''
  const delegateMode = baseUrl.length === 0

  const llm = (ctx as unknown as {
    llm: {
      registerAdapter(providers: string[], adapter: LlmAdapter): { (): void }
      listProviders?(): Array<{ id: string; name: string }>
      stream?(options: GenerateOptions): AsyncIterable<StreamChunk> | Promise<AsyncIterable<StreamChunk>>
      listModels?(provider: string): Promise<readonly LlmModelInfo[]>
      resolveModelInfo?(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>
    }
  }).llm

  let delegate: CloudLlmDelegateAdapterImpl | undefined
  // §7.131: 出网准备器。ctx 在这里持有 —— sanitizer / modelRouter 都是运行时
  // 才拿得到（apply 时 cloud-llm-adapter 排在 sanitizer-pipeline 与
  // model-router 之前，ctx 里还没有它们）。
  const egress = new CloudEgressGuard(ctx)
  const adapter: CloudLlmAdapterImpl | CloudLlmDelegateAdapterImpl = delegateMode
    ? (() => {
        const accessors: DelegateAccessors = {
          llm: llm as unknown as DelegateLlmLike,
          // soft dep: dsh-base absent (minimal graphs) → undefined, probe skips to step 3.
          getAgentDefaultModel: () => {
            try {
              return (ctx as unknown as { get?: (n: string) => unknown }).get?.('agentDefaultModel') as
                AgentDefaultModelLike | undefined
            } catch {
              return undefined
            }
          },
        }
        delegate = new CloudLlmDelegateAdapterImpl(config, accessors, auditLog, inputGuard, logger, egress)
        return delegate
      })()
    : new CloudLlmAdapterImpl(config, auditLog, inputGuard, logger, egress)

  // §7.100 热更新：路由拓扑变更（宿主 pi-ai replace / adapter 装卸）→ 清缓存，
  // 下次 stream 重新探针。agentDefaultModel 是 volatile Config，GUI 换模型无需订阅。
  const offAdaptersUpdated = delegateMode && typeof ctx.on === 'function'
    ? ctx.on('llm/adapters-updated', () => { delegate?.invalidateTopology() })
    : undefined

  ctx.logger?.info?.(
    `[cloud-llm-adapter] Registering ${delegateMode ? 'DELEGATE' : 'DIRECT'} adapter for providers: ${config.providers?.join(', ')}`,
  )
  let registration: { (): void }
  try {
    registration = llm.registerAdapter(config.providers, adapter)
  } catch (err: any) {
    // A user-defined pi-ai route literally named 'cloud-llm' (or a stale
    // registration) wins the name; that live route legitimately IS the cloud
    // pool then. Degrade loudly instead of crashing the whole bundle.
    const isDuplicate = err?.code === 'DUPLICATE_ADAPTER'
      || String(err?.message ?? err).includes('DUPLICATE_ADAPTER')
      || String(err?.message ?? err).includes('already has an adapter')
    if (isDuplicate) {
      logger?.error?.(`[cloud-llm-adapter] DUPLICATE_ADAPTER on ${config.providers.join(',')}; host route owns it, edge adapter stands down`)
      auditLog?.log({
        level: 'security',
        kind: 'llm.cloud.registration.duplicate',
        source: 'cloud-llm-adapter',
        payload: { providers: config.providers, mode: delegateMode ? 'delegate' : 'direct', error: String(err?.message ?? err) },
      }).catch(() => {})
      offAdaptersUpdated?.()
      return async () => {}
    }
    throw err
  }
  ctx.logger?.info?.(`[cloud-llm-adapter] Adapter registered successfully`)
  return async () => {
    registration()
    offAdaptersUpdated?.()
  }
}
