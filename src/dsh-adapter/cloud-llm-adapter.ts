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
import {
  bumpSessionToolCallCount,
  MAX_CONSECUTIVE_TOOL_CALLS,
  peekSessionSseRetryCount,
  resetSessionToolCallCount,
  resetSessionSseRetryCount,
  tryConsumeSseRetryBudget,
} from './llm-max-turns.js'

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

export interface Config {
  /** Provider route ids this adapter owns; defaults match DeepSeek. */
  providers: string[]
  /** Wire endpoint base; `/chat/completions` is appended. */
  baseUrl: string
  /** Process-env slot carrying the bearer key (never read at config time). */
  apiKeyEnv: string
  /** Default model id when the request omits one. */
  defaultModel: string
  /** Per-request temperature. Omit when the model is fixed. */
  temperature?: number
}

export const Config: Schema<Config> = Schema.object({
  providers: Schema.array(Schema.string()).default(['cloud-llm']),
  baseUrl: Schema.string().default('https://api.deepseek.com'),
  apiKeyEnv: Schema.string().default('DEEPSEEK_API_KEY'),
  defaultModel: Schema.string().default('deepseek-chat'),
  temperature: Schema.number().description('Optional override for sample temperature.'),
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
  private readonly defaultModel: string
  private readonly temperature: number | undefined
  private readonly auditLog: AuditLike | undefined
  private readonly inputGuard: InputGuardLike | undefined
  private readonly logger: LoggerLike | undefined

  constructor(config: Config, auditLog?: AuditLike, inputGuard?: InputGuardLike, logger?: LoggerLike) {
    super()
    this.providersList = [...config.providers]
    this.baseUrl = config.baseUrl.replace(/\/+$/u, '')
    this.apiKeyEnv = config.apiKeyEnv
    this.defaultModel = config.defaultModel
    this.temperature = config.temperature
    this.auditLog = auditLog
    this.inputGuard = inputGuard
    this.logger = logger
  }

  private audit(level: 'debug' | 'info' | 'warn' | 'error' | 'security', kind: string, payload: Record<string, unknown>): void {
    if (!this.auditLog) return
    void this.auditLog.log({ level, kind, source: 'cloud-llm-adapter', payload }).catch(() => {})
  }

  /** Mirror {@link CloudLlmAdapter.providers}; the upstream registry reads it. */
  get providers(): string[] {
    return [...this.providersList]
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: provider }
  }

  override listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    // M1 advertises a single default model per provider route.
    return Promise.resolve([
      {
        provider: this.providersList[0] ?? 'cloud',
        id: this.defaultModel,
        name: this.defaultModel,
        // §7.43 (2026-09-07): mirror the local-llm-adapter §7.40 fix — declare
        // contextWindow so basic-compaction-engine can compact long sessions.
        // Without it, compaction logs
        //   "compaction-basic: no context capacity for cloud-llm/deepseek-chat"
        // and refuses to compact, leaving promptLen to grow across turns
        // (observed: 4910 chars on the second cloud call in session
        // 5360189d-..., 5 tool-result blocks attached after web_search chain).
        // 65536 (64K) is the documented context window for deepseek-chat
        // (DeepSeek-V3/V4 variants); can be lifted if a future model ships
        // with a larger window. No OOM concern on cloud (unlike local-llm
        // §7.40 / §7.40.1 where we kept 16384 to avoid local inference OOM).
        contextWindow: 65536,
        inputModalities: ['text'],
      },
    ])
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
    const apiKey = readApiKey(this.apiKeyEnv)
    if (!apiKey) {
      this.logger?.error?.(`[cloud-llm-adapter] missing API key in env slot: ${this.apiKeyEnv}`)
      this.audit('error', 'llm.cloud.missing_key', { provider: options.provider, model: options.model, envSlot: this.apiKeyEnv })
      throw new LlmError(
        `cloud-llm-adapter: missing API key in env slot "${this.apiKeyEnv}"`,
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
    this.audit('info', 'llm.cloud.start', { provider: options.provider, model: options.model, messageCount, promptLen, baseUrl: this.baseUrl, systemInjected, retryBudgetUsed: peekSessionSseRetryCount(options.sessionId) })

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
        this.audit('error', 'llm.cloud.network_error', {
          provider: options.provider,
          model: options.model,
          durationMs,
          attempt: attemptIndex,
          error: errMsg,
        })
        // §7.50 followup: emit bookkeeping on fetch throw too. AbortError
        // (signal aborted by dsh-agent-loop) is the common case — ops log
        // previously showed only LLM call start, hiding the abort source.
        try {
          this.logger?.info?.(
            `[cloud-llm-adapter] LLM call done sessionId=${sessionId} provider=${options.provider} model=${options.model} attempt=${attemptIndex} retried=false durationMs=${durationMs} resultLen=0 toolCallCount=0 finishKind=unknown fetchError=${errMsg}`,
          )
        } catch { /* debug only */ }
        this.audit('info', 'llm.cloud.end', {
          provider: options.provider,
          model: options.model,
          durationMs,
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
        this.audit('error', 'llm.cloud.http_error', {
          provider: options.provider,
          model: options.model,
          status: response.status,
          durationMs,
          respBody: respBody.slice(0, 500),
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
        this.audit('info', 'llm.cloud.end', {
          provider: options.provider,
          model: options.model,
          durationMs,
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
        this.audit('error', 'llm.cloud.sse_interrupted', {
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
        this.audit('info', 'llm.cloud.end', {
          provider: options.provider,
          model: options.model,
          durationMs,
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

/** Read an env-slot key, throwing on absence is left to the caller. */
function readApiKey(slot: string): string | undefined {
  if (typeof process === 'undefined' || !process.env) return undefined
  const value = process.env[slot]
  if (typeof value !== 'string' || value.length === 0) return undefined
  return value
}

export async function apply(ctx: Context, config: Config): Promise<() => Promise<void>> {
  ctx.logger?.info?.(`[cloud-llm-adapter] apply() called with providers: ${config.providers?.join(', ')}`)
  const auditLog = (ctx as unknown as { auditLog?: AuditLike }).auditLog
  // input-guard 是可选注入 —— plugin 启动顺序里 cloud-llm-adapter 在
  // input-guard 之后才能拿到；否则降级为不洗（保持旧行为）。enableInputGuard=false
  // 时 inputGuard.sanitizeOrphanToolCalls 自身也 pass-through。
  const inputGuard = (ctx as unknown as { inputGuard?: InputGuardLike }).inputGuard
  const logger = ctx.logger as LoggerLike | undefined
  const adapter = new CloudLlmAdapterImpl(config, auditLog, inputGuard, logger)
  const llm = (ctx as unknown as {
    llm: { registerAdapter(providers: string[], adapter: LlmAdapter): { (): void } }
  }).llm
  ctx.logger?.info?.(`[cloud-llm-adapter] Registering adapter for providers: ${config.providers?.join(', ')}`)
  const registration = llm.registerAdapter(config.providers, adapter)
  ctx.logger?.info?.(`[cloud-llm-adapter] Adapter registered successfully`)
  return async () => {
    registration()
  }
}
