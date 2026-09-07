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
 */
const MAX_CONSECUTIVE_TOOL_CALLS = 20
const _sessionToolCallRuns = new Map<string, { count: number; lastSeen: number }>()
let _toolCallRunPruneCounter = 0

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
  /** OpenAI-compatible endpoint. `/chat/completions` is appended. */
  baseUrl: string
  /** Default model id when the request omits one. */
  defaultModel: string
  /** Optional bearer header for an authenticated llama.cpp server. */
  apiKeyEnv?: string
}

export const Config: Schema<Config> = Schema.object({
  providers: Schema.array(Schema.string()).default(['local-qwen3-4b']),
  baseUrl: Schema.string().default('http://127.0.0.1:8080/v1'),
  defaultModel: Schema.string().default('qwen3-4b'),
  apiKeyEnv: Schema.string().description('Optional env-slot name carrying an auth bearer.'),
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
    for (const provider of this.providersList) {
      this.innerByProvider.set(provider, new RealLocalAdapter(provider, config, auditLog, inputGuard, logger))
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
  private readonly apiKeyEnv: string | undefined
  private readonly auditLog: AuditLike | undefined
  private readonly inputGuard: InputGuardLike | undefined
  private readonly logger: LoggerLike | undefined

  constructor(provider: string, config: Config, auditLog?: AuditLike, inputGuard?: InputGuardLike, logger?: LoggerLike) {
    super()
    this.providerName = provider
    this.baseUrl = config.baseUrl.replace(/\/+$/u, '')
    this.defaultModel = config.defaultModel
    this.apiKeyEnv = config.apiKeyEnv
    this.auditLog = auditLog
    this.inputGuard = inputGuard
    this.logger = logger
  }

  get providers(): string[] {
    return [this.providerName]
  }

  override providerInfo(_provider: string): LlmProviderInfo {
    return { id: this.providerName, name: this.providerName }
  }

  override listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([
      {
        provider: this.providerName,
        id: this.defaultModel,
        name: this.defaultModel,
        // §7.40 (2026-09-04): advertise contextWindow so basic-compaction-engine
        // can compact long conversations. Without this, compaction logs
        //   "compaction-basic: no context capacity for local-qwen3-4b/qwen3-4b-instruct-2507"
        // and refuses to compact, leaving messageCount/promptLen to grow
        // across turns. The local model then degrades to empty/garbled
        // completions after the second or third call (observed in session
        // 7eb91d59-...: call 1=19s/61 chars/tool-calls, call 2=1s/12 chars/
        // malformed `</tool_call>`, call 3=218ms/0 chars/finishKind=unknown).
        // 16384 is the user-reported hard cap for this local qwen3-4b
        // server (16K OOMs observed at higher settings; this machine is
        // shared with other workloads, so a conservative ceiling is the
        // only safe choice). Can be lifted once we measure the local
        // server's actual capacity. §7.40.1 (2026-09-07): lowered from
        // 32768 → 16384 after operator confirmed the local server's
        // effective context window is 16K, not 32K.
        contextWindow: 16384,
        inputModalities: ['text'],
      },
    ])
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

    const body = buildChatCompletionsBody({ ...options, messages: sanitizedMessages }, this.defaultModel, undefined)
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      ...attributionHeaders(),
    }
    const apiKey = this.apiKeyEnv !== undefined ? readApiKey(this.apiKeyEnv) : undefined
    if (apiKey !== undefined) headers.authorization = `Bearer ${apiKey}`

    const promptText = sanitizedMessages.map((m) => `${m.role}:${extractText(m.content)}`).join('\n')
    const promptLen = promptText.length
    const start = Date.now()
    // 2026-09-02: per-call request/response body logging to ops log at
    // debug level (mirrors cloud-llm-adapter). LOCAL content never
    // leaves the device, so this is purely a local-debug aid; CLOUD
    // prompts are pre-sanitized by input-guard before egress. Set
    // `DSH_EDGE_LOG_LEVEL=info` to suppress bodies entirely.
    this.logger?.debug?.(`[local-llm-adapter] LLM_REQUEST provider=${options.provider} model=${options.model} messageCount=${sanitizedMessages.length} promptLen=${promptLen}`)
    this.logger?.debug?.(`[local-llm-adapter] LLM_MESSAGES ${JSON.stringify({ messages: sanitizedMessages })}`)
    audit(this.auditLog, 'info', 'llm.local.start', { provider: options.provider, model: options.model, messageCount: sanitizedMessages.length, promptLen, baseUrl: this.baseUrl })

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
      audit(this.auditLog, 'error', 'llm.local.network_error', { provider: options.provider, model: options.model, durationMs, error: err?.message ?? String(err) })
      throw err
    }

    if (!response.ok) {
      const durationMs = Date.now() - start
      let respBody = ''
      try { respBody = await response.text() } catch { /* ignore */ }
      audit(this.auditLog, 'error', 'llm.local.http_error', { provider: options.provider, model: options.model, status: response.status, durationMs, respBody: respBody.slice(0, 500) })
      throw new LlmError(`local-llm-adapter (${this.providerName}): HTTP ${response.status}: ${respBody.slice(0, 200)}`, 'PROVIDER_ERROR')
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
      audit(this.auditLog, 'info', 'llm.local.end', {
        provider: options.provider,
        model: options.model,
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
      audit(this.auditLog, 'warn', 'llm.local.malformed_tool_call', {
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
    // Session tracking via module-level Map, keyed by sessionId (falls back to
    // 'default' if absent — single shared counter for non-session callers).
    // Stale entries pruned every 100 calls (keep those seen in last 5 minutes).
    const sessionKey = typeof options.sessionId === 'string' && options.sessionId.length > 0
      ? options.sessionId
      : 'default'
    if (finishKind === 'tool-calls') {
      if (!sawText) {
        const now = Date.now()
        const entry = _sessionToolCallRuns.get(sessionKey) ?? { count: 0, lastSeen: now }
        entry.count += 1
        entry.lastSeen = now
        _sessionToolCallRuns.set(sessionKey, entry)
        // Periodic prune: every 100 calls, drop entries older than 5 minutes.
        if (++_toolCallRunPruneCounter % 100 === 0) {
          const cutoff = now - 5 * 60 * 1000
          for (const [k, v] of _sessionToolCallRuns) {
            if (v.lastSeen < cutoff) _sessionToolCallRuns.delete(k)
          }
        }
        if (entry.count > MAX_CONSECUTIVE_TOOL_CALLS) {
          audit(this.auditLog, 'warn', 'llm.local.max_turns_exceeded', {
            provider: options.provider,
            model: options.model,
            sessionId: sessionKey,
            consecutiveCount: entry.count,
          })
          this.logger?.error?.(
            `[local-llm-adapter] per-session max-turns exceeded (session=${sessionKey}, count=${entry.count}/${MAX_CONSECUTIVE_TOOL_CALLS})`,
          )
          // Reset counter so next call starts fresh (agent loop may retry).
          _sessionToolCallRuns.delete(sessionKey)
          throw new LlmError(
            `local-llm-adapter (${this.providerName}): per-session max-turns exceeded (count=${entry.count})`,
            'MAX_TURNS_EXCEEDED',
          )
        }
      } else {
        // Tool-call response with text content -> progress, reset counter.
        _sessionToolCallRuns.delete(sessionKey)
      }
    } else if (finishKind === 'stop' || finishKind === 'length') {
      // Natural termination -> reset counter.
      _sessionToolCallRuns.delete(sessionKey)
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
  const auditLog = (ctx as unknown as { auditLog?: AuditLike }).auditLog
  // 2026-08-31: input-guard 可选注入；DSH_EDGE_INPUT_GUARD=false 或 plugin
  // 启动顺序导致 inputGuard 未就绪时降级为不洗（保持旧行为）。
  const inputGuard = (ctx as unknown as { inputGuard?: InputGuardLike }).inputGuard
  const logger = ctx.logger as LoggerLike | undefined
  const adapter = new LocalLlmAdapterImpl(config, auditLog, inputGuard, logger)
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
