/**
 * local-llm-adapter — M4 multi-model + routing.
 *
 * Registers one or more provider routes on the shared `ctx.llm`
 * runtime, all backed by a real OpenAI-compatible `/chat/completions`
 * endpoint. Defaults to `http://127.0.0.1:8080/v1` (llama.cpp's
 * `server` binary); the reachable endpoint in this repo is
 * `http://192.168.66.195:8701/v1`. No in-process mock — every call
 * leaves the process.
 *
 * The wire-protocol parser lives in `./openai-sse.js` so changes to
 * the SSE framing land in one place and are shared by the cloud
 * adapter. The body builder flips `stream: true` and merges adapter
 * defaults (model, temperature) so the upstream server sees the same
 * shape the dsh agent loop emits.
 *
 * @module dsh-edge-agent/local-llm-adapter
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
import { localPool } from './edge-config.js'
import {
  bumpSessionToolCallCount,
  MAX_CONSECUTIVE_TOOL_CALLS,
  resetSessionToolCallCount,
} from './llm-max-turns.js'

export const name = 'local-llm-adapter'

export const inject = ['llm', 'auditLog', 'inputGuard'] as const

/**
 * §7.42 (2026-09-05) P0-2: per-session runaway guard. If the local LLM emits
 * more than this many consecutive REAL tool-call responses (finishKind=
 * 'tool-calls' with toolCalls.size > 0 — malformed cases are handled by P0-1
 * above and rewritten to finishKind='stop' before reaching the counter), the
 * adapter throws `LlmError('MAX_TURNS_EXCEEDED')` to terminate the agent loop.
 * 20 is conservative: a healthy tool-use turn rarely exceeds 3-5 iterations;
 * 20 catches runaways without tripping on legitimate long chains.
 *
 * §7.47.5 (2026-09-13): shared with cloud-llm-adapter via ./llm-max-turns.ts
 * so cross-adapter sessions (e.g. classifier fallback LOCAL → CLOUD) keep
 * a single counter. See llm-max-turns.ts for the rationale.
 */

/** Minimal interface our adapter needs from the audit-log service. */
interface AuditLike {
  log(entry: { level: 'debug' | 'info' | 'warn' | 'error' | 'security'; kind: string; source: string; payload: Record<string, unknown> }): Promise<unknown>
}

/**
 * 2026-08-31: input-guard 注入用于清洗孤儿 tool_call。
 * qwen3 对 orphan tool_call 不像 DeepSeek 那么严格（不会 400），
 * 但统一清洗可避免 LLM 上下文里出现悬空调用、提升模型行为稳定性。
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

function audit(log: AuditLike | undefined, level: 'debug' | 'info' | 'warn' | 'error' | 'security', kind: string, payload: Record<string, unknown>): void {
  if (!log) return
  void log.log({ level, kind, source: 'local-llm-adapter', payload }).catch(() => {})
}

/** Minimal duck-typed handle for Cordis `LoggerService`. Used by tests to stub
 *  logger behavior; `apply()` injects the live `ctx.logger` from Cordis. */
type LoggerLike = Pick<LoggerService, 'info' | 'warn' | 'error' | 'debug'>

export interface Config {
  /** Provider route ids this adapter owns. */
  providers: string[]
  /** OpenAI-compatible endpoint. `/chat/completions` is appended.
   *
   *  Undefined means "no local-LLM endpoint configured": the adapter then
   *  registers NO provider route at all (see `apply`). It must not fall back
   *  to a hard-coded port — a default like `127.0.0.1:8080` collides with
   *  unrelated daemons that listen there (observed 2026-10-21: TeleAgent's
   *  scheduler daemon owns 8080 and answers 401 "Missing bearer token"),
   *  which turned every turn into a failed local-LLM call even though the
   *  operator never asked for a local model. */
  baseUrl?: string
  /** Default model id when the request omits one. */
  defaultModel: string
  /** Optional bearer header for an authenticated endpoint.
   *
   *  §7.102: the value is now the literal key, not an env-slot name. The
   *  key lives in config/edge.json (gitignored) and reaches the adapter
   *  through this field. `apiKeyEnv` is kept as a deprecated alias for
   *  callers that still pass an env-slot name — it is read from
   *  process.env when present, but new deployments should use `apiKey`. */
  apiKey?: string
  /** @deprecated Use `apiKey` (literal). Kept so an env-slot name still
   *  works for a transition period. */
  apiKeyEnv?: string
  /** §7.4? (2026-09-17) LAN minicpm5-2b Jinja2 tojson(ensure_ascii) bug
   *  workaround: when true, omit `body.tools` from wire request so the
   *  server template `{% if tools %}` block is never evaluated. Model
   *  falls back to plain-text tool defs in system prompt's
   *  <available_tools>. Defaults to false. */
  stripTools?: boolean
  /** §7.87.5 (2026-09-19): disable chain-of-thought for thinking-capable
   *  models (qwen3.5 / QwQ / DeepSeek-R1). When false (default), the wire
   *  body gets `chat_template_kwargs={enable_thinking: false}` so the model
   *  returns final answer directly instead of burning max_tokens on reasoning.
   *  Pass-through no-op for non-thinking servers. */
  enableThinking?: boolean
}

export const Config: Schema<Config> = Schema.object({
  providers: Schema.array(Schema.string()).default(['local-llm']),
  // No default on purpose: an unset endpoint means the local-LLM route stays
  // off (see `Config.baseUrl` and `apply`). The operator opts in with
  // llm.local.baseUrl in config/edge.json (§7.102).
  baseUrl: Schema.string().description('OpenAI-compatible endpoint base; unset = the local-LLM route is not registered.'),
  defaultModel: Schema.string().default('qwen3-4b'),
  apiKey: Schema.string().description('Optional bearer token for an authenticated endpoint (literal value from config/edge.json).'),
  apiKeyEnv: Schema.string().description('Deprecated: env-slot name carrying an auth bearer. Prefer apiKey.'),
  stripTools: Schema.boolean().default(false),
  // §7.87.5 (2026-09-19): default false — production wants fast answers.
  // qwen3.5 / QwQ / DeepSeek-R1 will burn max_tokens on reasoning by default.
  enableThinking: Schema.boolean().default(false),
})

export interface LocalLlmAdapter {
  readonly providers: string[]
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/**
 * Adapter facade. Owns one real-HTTP inner adapter per configured
 * provider route so `ctx.llm.registerAdapter([...], this)` can route
 * any of them through the same instance — keeping the `dispose`
 * set in lockstep with the registration.
 */
export class LocalLlmAdapterImpl extends LlmAdapter {
  private readonly providersList: string[]
  private readonly innerByProvider: Map<string, LlmAdapter>

  constructor(config: Config, auditLog?: AuditLike, inputGuard?: InputGuardLike, logger?: LoggerLike) {
    super()
    this.providersList = [...config.providers]
    this.innerByProvider = new Map()
    // An unset endpoint leaves every route without a backend. `apply` keeps
    // the adapter unregistered in that case; the guard here keeps the
    // facade honest for direct construction (tests, embedding).
    const baseUrl = (config.baseUrl ?? '').trim()
    if (baseUrl.length === 0) return
    for (const provider of this.providersList) {
      this.innerByProvider.set(provider, new RealLocalAdapter(provider, config, baseUrl, auditLog, inputGuard, logger))
    }
  }

  get providers(): string[] {
    return [...this.providersList]
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: provider }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const inner = this.innerByProvider.get(provider)
    return inner
      ? inner.listModels(provider)
      : Promise.resolve([])
  }

  override resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const inner = this.innerByProvider.get(provider)
    return inner
      ? inner.resolveModel(provider, model, signal)
      : Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const inner = this.innerByProvider.get(options.provider)
    if (inner === undefined) {
      throw new LlmError(
        `local-llm-adapter: unknown provider route "${options.provider}" (registered: ${this.providersList.join(', ')})`,
        'UNKNOWN_PROVIDER',
      )
    }
    yield* inner.stream(options)
  }
}

/**
 * Real backend. Mirrors `CloudLlmAdapterImpl` but skips the bearer
 * header unless `Config.apiKeyEnv` is set (llama.cpp `server` does
 * not require auth by default). Bound to LAN/loopback endpoints only.
 */
class RealLocalAdapter extends LlmAdapter {
  private readonly providerName: string
  private readonly baseUrl: string
  private readonly defaultModel: string
  private readonly apiKey: string | undefined
  private readonly apiKeyEnv: string | undefined
  private readonly auditLog: AuditLike | undefined
  private readonly inputGuard: InputGuardLike | undefined
  private readonly logger: LoggerLike | undefined
  private readonly stripTools: boolean
  private readonly enableThinking: boolean

  constructor(provider: string, config: Config, baseUrl: string, auditLog?: AuditLike, inputGuard?: InputGuardLike, logger?: LoggerLike) {
    super()
    this.providerName = provider
    this.baseUrl = baseUrl.replace(/\/+$/u, '')
    this.defaultModel = config.defaultModel
    // §7.102: prefer the literal key from config/edge.json; fall back to the
    // deprecated env-slot lookup so an in-flight migration still authenticates.
    this.apiKey = config.apiKey
    this.apiKeyEnv = config.apiKeyEnv
    this.auditLog = auditLog
    this.inputGuard = inputGuard
    this.logger = logger
    this.stripTools = config.stripTools ?? false
    // §7.87.5 (2026-09-19): opt-in flag for thinking-capable models.
    this.enableThinking = config.enableThinking ?? false
  }

  /** Resolve the bearer token: literal key first, env slot second. */
  private resolveApiKey(): string | undefined {
    if (this.apiKey !== undefined && this.apiKey.length > 0) return this.apiKey
    return this.apiKeyEnv !== undefined ? readApiKey(this.apiKeyEnv) : undefined
  }

  get providers(): string[] {
    return [this.providerName]
  }

  override providerInfo(_provider: string): LlmProviderInfo {
    return { id: this.providerName, name: this.providerName }
  }

  /**
   * §7.106 Option A: the catalog (the desktop's model picker) is deliberately
   * EMPTY — local-llm is privacy-pipeline plumbing (guard/intent internal
   * stages + input-guard's per-turn downgrade route), not a user choice.
   * dsh-llm documents the decoupling ("catalog membership does not constrain
   * core routing", lib/index.js:2080): stream/resolve keep serving the route,
   * and compaction reads its 16384 window off resolveModel's context (the
   * §7.40 capacity lives there now — a hidden catalog can no longer carry it).
   */
  override listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([])
  }

  override resolveModel(
    _provider: string,
    model: string,
  ): Promise<LlmResolvedModelInfo> {
    // §7.40 (2026-09-04): see listModels comment — contextWindow must also
    // surface through resolveModel so the runtime normalises it onto the
    // active session's `info.context.contextWindow`. Without this the
    // adapter's advertised contextWindow is ignored.
    return Promise.resolve({
      provider: this.providerName,
      id: model,
      name: model,
      context: { contextWindow: 16384 },
    })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const url = `${this.baseUrl}/chat/completions`

    // 2026-08-31：input-guard 清洗孤儿 tool_call。
    let sanitizedMessages: typeof options.messages = options.messages
    if (this.inputGuard) {
      const result = this.inputGuard.sanitizeOrphanToolCalls(
        options.messages as unknown as ReadonlyArray<Record<string, unknown>>,
        (options as { sessionId?: string }).sessionId,
      )
      sanitizedMessages = result.messages as unknown as typeof options.messages
    }

    // §7.4? (2026-09-17) LAN minicpm5-2b Jinja2 `tojson(ensure_ascii)` bug:
    // when stripTools is on, set `tools: undefined` in the spread so the
    // openai-sse.ts guard skips `body.tools` assignment and the server
    // template's `{% if tools %}` block is skipped. Default false → wire
    // body unchanged for unaffected servers/models.
    const wireOptions = this.stripTools
      ? { ...options, tools: undefined, messages: sanitizedMessages }
      : { ...options, messages: sanitizedMessages }
    const body = buildChatCompletionsBody(wireOptions, this.defaultModel, undefined, this.enableThinking)
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      ...attributionHeaders(),
    }
    const apiKey = this.resolveApiKey()
    if (apiKey !== undefined) headers.authorization = `Bearer ${apiKey}`

    const promptText = sanitizedMessages.map((m) => `${m.role}:${extractText(m.content)}`).join('\n')
    const promptLen = promptText.length
    // §7.54.7 (2026-09-14): capture wire-system (passed to
    // buildChatCompletionsBody) for ops log so operator can see what system
    // prompt actually went out to local LLM. Truncate to first 200 chars to
    // keep log lines readable; full text is in the request body which
    // DSH_EDGE_LOG_LEVEL=debug exposes via LLM_MESSAGES.
    const wireSystem = typeof options.system === 'string' ? options.system : ''
    const systemLen = wireSystem.length
    const systemPreview = systemLen > 0 ? wireSystem.slice(0, 200).replace(/\s+/g, ' ') : ''
    const start = Date.now()
    // §7.46.1 (2026-09-11): ops log 让 TUI 路径调哪个 local LLM / 多久 / 多少
    // token 在 ops log 里可见。配合 realm-skill-bridge pre-step + tool allow
    // 形成完整 trace。
    const sessionId = (options as { sessionId?: string }).sessionId ?? '<pre-session>'
    try {
      // §7.54 (2026-09-14): show the wire body model (`this.defaultModel`,
      // which buildChatCompletionsBody uses) instead of `options.model` (which
      // model-router may overwrite to the provider route id, e.g.
      // 'local-llm'). Operators reading the ops log expect to see the actual
      // model name qwen3.7-plus, not the routing key. `route=${options.model}`
      // preserves the upstream-visible routing key for diagnosis.
      this.logger?.info?.(
        `[local-llm-adapter] LLM call start sessionId=${sessionId} provider=${options.provider} model=${this.defaultModel} route=${options.model} messageCount=${sanitizedMessages.length} promptLen=${promptLen} systemLen=${systemLen}${systemPreview ? ` systemPreview="${systemPreview}${systemLen > 200 ? '...' : ''}"` : ''} baseUrl=${this.baseUrl}`,
      )
    } catch { /* debug only */ }
    // 2026-09-02: per-call request/response body logging to ops log at
    // debug level (mirrors cloud-llm-adapter). LOCAL content never
    // leaves the device, so this is purely a local-debug aid; CLOUD
    // prompts are pre-sanitized by input-guard before egress. Set
    // `DSH_EDGE_LOG_LEVEL=info` to suppress bodies entirely.
    this.logger?.debug?.(`[local-llm-adapter] LLM_REQUEST provider=${options.provider} model=${options.model} messageCount=${sanitizedMessages.length} promptLen=${promptLen}`)
    this.logger?.debug?.(`[local-llm-adapter] LLM_MESSAGES ${JSON.stringify({ messages: sanitizedMessages })}`)
    audit(this.auditLog, 'info', 'llm.local.start', { provider: options.provider, model: this.defaultModel, route: options.model, messageCount: sanitizedMessages.length, promptLen, baseUrl: this.baseUrl })

    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: options.signal,
      })
    } catch (err: any) {
      const durationMs = Date.now() - start
      audit(this.auditLog, 'error', 'llm.local.network_error', { provider: options.provider, model: this.defaultModel, route: options.model, durationMs, error: err?.message ?? String(err) })
      throw err
    }

    if (!response.ok) {
      const durationMs = Date.now() - start
      let respBody = ''
      try { respBody = await response.text() } catch { /* ignore */ }
      audit(this.auditLog, 'error', 'llm.local.http_error', { provider: options.provider, model: this.defaultModel, route: options.model, status: response.status, durationMs, respBody: respBody.slice(0, 500) })
      // 2026-10-21: 401/403 almost always means "this endpoint wants a
      // bearer" (or "the port belongs to something else entirely"). Name the
      // knob so the operator does not have to reverse-engineer the envelope.
      const authHint = response.status === 401 || response.status === 403
        ? ` — the endpoint requires an Authorization: Bearer token; set llm.local.keyRef`
          + ` in config/edge.json to the name of a key under "secrets"`
          + `${this.apiKeyEnv === undefined ? '' : `, or point apiKeyEnv at the env slot <${this.apiKeyEnv}>`}`
          + `, and confirm ${this.baseUrl} is really your local LLM server.`
        : ''
      throw new LlmError(`local-llm-adapter (${this.providerName}): HTTP ${response.status}: ${respBody.slice(0, 200)}${authHint}`, 'PROVIDER_ERROR')
    }

    // 2026-09-03 §7.34.2 fix: defer `block-start` until the first text-delta.
    // 之前无条件 yield block-start → 如果 LLM 返回 0 token（completion_tokens=0
    // 但 finish_reason='stop'，llama.cpp 在 24 条 message / 2535 tokens prompt
    // 下实测会发生），BlockAssembler 拿到一个未关闭的 text block + finish，
    // 状态机卡住、agent-loop 永远等不到 block-end。
    //
    // 实测数据：webui chat "查询下密盒有哪些图片文件"（17:20:40 +08:00），
    // 远端 llama.cpp 192.168.1.121:11017 返回 completion_tokens=0 finish=stop
    // （254ms），dsh 进入 idle 4+ 分钟无响应。
    //
    // 修复：block-start 改为 lazy（首次 text-delta 前 yield 一次），empty stream
    // 不再 yield block-start → BlockAssembler 不创建 orphan block → finish
    // 正常传递 → agent-loop 状态机清零。
    let blockStartYielded = false
    const yieldBlockStartOnce = (): boolean => {
      if (blockStartYielded) return false
      blockStartYielded = true
      return true
    }
    let assembledText = ''
    let finishKind: 'stop' | 'length' | 'tool-calls' | undefined
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>()
    let sawText = false
    let sawToolCall = false

    const throwOnWire = (message: string): never => {
      throw new LlmError(`local-llm-adapter (${this.providerName}): SSE stream interrupted: ${message}`, 'PROVIDER_ERROR')
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
        yield result.chunk
      }
    } catch (err: any) {
      wireError = err?.message ?? String(err)
      throw err
    } finally {
      const durationMs = Date.now() - start
      // §7.46.1: ops log done 行
      // §7.54 (2026-09-14): show defaultModel (= wire body) for consistency
      // with start line; options.model may be the routing key 'local-llm'.
      try {
        this.logger?.info?.(
          `[local-llm-adapter] LLM call done sessionId=${sessionId} provider=${options.provider} model=${this.defaultModel} route=${options.model} durationMs=${durationMs} resultLen=${assembledText.length} toolCallCount=${toolCalls.size} finishKind=${finishKind ?? 'unknown'}${wireError !== undefined ? ` wireError=${wireError}` : ''}`,
        )
      } catch { /* debug only */ }
      audit(this.auditLog, 'info', 'llm.local.end', { sessionId: options.sessionId,
        provider: options.provider,
        model: this.defaultModel,
        route: options.model,
        durationMs,
        promptLen,
        resultLen: assembledText.length,
        toolCallCount: toolCalls.size,
        finishKind,
        sawText,
        sawToolCall,
        ...(wireError !== undefined ? { wireError } : {}),
      })
      // 2026-09-02: dump response summary + full text to the ops log at
      // debug level (mirrors cloud-llm-adapter).
      this.logger?.debug?.(`[local-llm-adapter] LLM_RESPONSE provider=${options.provider} durationMs=${durationMs} resultLen=${assembledText.length} finishKind=${finishKind ?? 'unknown'}`)
      this.logger?.debug?.(`[local-llm-adapter] LLM_RESPONSE_TEXT ${JSON.stringify({ text: assembledText })}`)
    }

    // §7.42 (2026-09-05) P0-1: malformed-tool-call detection.
    // qwen3-4b-instruct-2507 @ OpenAI-compatible endpoints sometimes emit
    // ~12 bytes of XML tag fragments (e.g. `\n<think>\n`) as plain-text
    // content while setting finish_reason=tool_calls. Two patterns observed:
    //
    // Pattern A (rare, ~1%): toolCalls.size === 0, no real tool call accumulated.
    //   Agent loop sees "tool-calls" but nothing to dispatch -> runaway (152
    //   iterations observed in tui-probe-1). Fix: rewrite finishKind='stop'.
    //
    // Pattern B (dominant, ~99%): toolCalls.size >= 1, real tool call also emitted.
    //   Agent loop dispatches the tool call, but the XML fragment text confuses
    //   the model -> loop retries a few times then terminates (5 iterations, 70s
    //   observed in p0-local test). Fix: strip the XML fragment from assembledText
    //   so it doesn't pollute the session context, but let the tool call proceed.
    //
    // Both patterns logged at WARN + audit for ops visibility.
    const MALFORMED_TOOL_CALL_TEXT_RE = /^[\s<>\/a-z_]{0,30}$/u
    if (
      finishKind === 'tool-calls' &&
      assembledText.length > 0 &&
      assembledText.length <= 30 &&
      MALFORMED_TOOL_CALL_TEXT_RE.test(assembledText)
    ) {
      const hasRealToolCalls = toolCalls.size > 0
      audit(this.auditLog, 'warn', 'llm.local.malformed_tool_call', { sessionId: options.sessionId,
        provider: options.provider,
        model: options.model,
        resultLen: assembledText.length,
        assembledTextPreview: assembledText.slice(0, 100),
        messageCount: sanitizedMessages.length,
        toolCallCount: toolCalls.size,
        pattern: hasRealToolCalls ? 'B' : 'A',
      })
      this.logger?.warn?.(
        `[local-llm-adapter] malformed tool-call response detected (pattern=${hasRealToolCalls ? 'B' : 'A'}, toolCallCount=${toolCalls.size}, text=${JSON.stringify(assembledText.slice(0, 40))})`,
      )
      if (!hasRealToolCalls) {
        // Pattern A: no real tool call -> rewrite to stop, loop terminates
        finishKind = 'stop'
        sawToolCall = false
      } else {
        // Pattern B: real tool call present -> strip XML fragment text, let tool proceed
        // Note: text-delta chunks already yielded, can't un-yield. But we clear
        // assembledText so subsequent context doesn't include the fragment.
        assembledText = ''
        sawText = false
      }
    }

    // §7.42 (2026-09-05) P0-2: per-session max-turns guard.
    // If the local LLM keeps returning tool-calls without making progress
    // (no text content, no stop/length finish), bound the resource usage
    // by throwing after MAX_CONSECUTIVE_TOOL_CALLS consecutive tool-call
    // responses. The counter resets on stop/length (agent loop terminates
    // naturally) or on text-bearing tool-call responses (progress signal).
    //
    // Trigger: finishKind === 'tool-calls' && !sawText (no text content).
    //   - Pattern B malformed (P0-1 above) sets assembledText='' and sawText=false,
    //     so it also increments this counter — correct, since it's not making progress.
    //   - Real tool-call with text (e.g. model explains what it's doing) does NOT
    //     increment — that's a progress signal.
    //
    // Session tracking via shared module (./llm-max-turns.ts). Cross-adapter
    // sessions keep a single counter so e.g. classifier fallback LOCAL → CLOUD
    // doesn't reset the runaway count.
    if (finishKind === 'tool-calls') {
      if (!sawText) {
        const consecutiveCount = bumpSessionToolCallCount(options.sessionId)
        const sessionKeyForLog = typeof options.sessionId === 'string' && options.sessionId.length > 0
          ? options.sessionId
          : 'default'
        if (consecutiveCount > MAX_CONSECUTIVE_TOOL_CALLS) {
          audit(this.auditLog, 'warn', 'llm.local.max_turns_exceeded', {
            provider: options.provider,
            model: options.model,
            sessionId: sessionKeyForLog,
            consecutiveCount,
          })
          this.logger?.error?.(
            `[local-llm-adapter] per-session max-turns exceeded (session=${sessionKeyForLog}, count=${consecutiveCount}/${MAX_CONSECUTIVE_TOOL_CALLS})`,
          )
          // Reset counter so next call starts fresh (agent loop may retry).
          resetSessionToolCallCount(options.sessionId)
          throw new LlmError(
            `local-llm-adapter (${this.providerName}): per-session max-turns exceeded (count=${consecutiveCount})`,
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

function readApiKey(slot: string): string | undefined {
  if (typeof process === 'undefined' || !process.env) return undefined
  const value = process.env[slot]
  if (typeof value !== 'string' || value.length === 0) return undefined
  return value
}

export async function apply(ctx: Context, config: Config): Promise<() => Promise<void>> {
  ctx.logger?.info?.(`[local-llm-adapter] apply() called with providers: ${config.providers?.join(', ')}`)
  // §7.102: the effective pool comes from config/edge.json. The cordis
  // patch row no longer carries any local-LLM config (it used to read
  // process.env.DSH_EDGE_LOCAL_LLM_*, which the desktop GUI never had).
  const pool = localPool()
  // The cordis config, when present, wins over the file (a profile that
  // still passes an explicit baseUrl keeps working).
  const baseUrl = (
    typeof config.baseUrl === 'string' && config.baseUrl.trim().length > 0
      ? config.baseUrl
      : pool.baseUrl ?? ''
  ).trim()
  // 2026-10-21: the local-LLM route is opt-in. Without an endpoint the
  // adapter registers NOTHING, so the model registry never offers
  // `local-llm`, the model router cannot select it, and the internal
  // intent/guard stages stay on their keyword/regex tier instead of
  // burning a request against whatever happens to own the default port.
  // Previously the Schema default (`127.0.0.1:8080`) made the route live
  // unconditionally: on a machine where 8080 is an unrelated authenticated
  // daemon, every turn failed with HTTP 401 "Missing bearer token".
  if (baseUrl.length === 0) {
    ctx.logger?.info?.(
      '[local-llm-adapter] no endpoint configured — the local-LLM route stays off. '
      + 'Set llm.local.baseUrl in config/edge.json to enable it.',
    )
    return async () => {}
  }
  // Fold the file-derived pool into the config the adapter actually uses.
  //
  // Precedence: an explicit cordis config value wins, then the file, then the
  // Schema default. The Schema default is already applied to `config` by the
  // loader, so we cannot use it to detect "the operator did not configure a
  // model" — that is why the file is consulted before falling back to the
  // plugin's own default string.
  const effective: Config = {
    ...config,
    baseUrl,
    defaultModel: pool.model ?? config.defaultModel,
    apiKey: config.apiKey ?? pool.apiKey,
    stripTools: config.stripTools ?? pool.stripTools,
    enableThinking: config.enableThinking ?? pool.enableThinking,
  }
  const auditLog = (ctx as unknown as { auditLog?: AuditLike }).auditLog
  // 2026-08-31: input-guard 可选注入；DSH_EDGE_INPUT_GUARD=false 或 plugin
  // 启动顺序导致 inputGuard 未就绪时降级为不洗（保持旧行为）。
  const inputGuard = (ctx as unknown as { inputGuard?: InputGuardLike }).inputGuard
  const logger = ctx.logger as LoggerLike | undefined
  const adapter = new LocalLlmAdapterImpl(effective, auditLog, inputGuard, logger)
  const llm = (ctx as unknown as {
    llm: { registerAdapter(providers: string[], adapter: LlmAdapter): { (): void } }
  }).llm
  ctx.logger?.info?.(`[local-llm-adapter] Registering adapter for providers: ${config.providers?.join(', ')}`)
  const registration = llm.registerAdapter(config.providers, adapter)
  ctx.logger?.info?.(`[local-llm-adapter] Adapter registered successfully`)
  return async () => {
    registration()
  }
}
