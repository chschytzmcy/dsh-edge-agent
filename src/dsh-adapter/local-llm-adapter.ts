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
        inputModalities: ['text'],
      },
    ])
  }

  override resolveModel(
    _provider: string,
    model: string,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider: this.providerName, id: model, name: model })
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

    yield { type: 'block-start', index: 0, blockType: 'text' }
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
