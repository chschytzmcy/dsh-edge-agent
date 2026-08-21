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

import type { Context } from '@deepseek-ai/cordis'
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

export const inject = ['llm', 'auditLog'] as const

/** Minimal interface our adapter needs from the audit-log service. */
interface AuditLike {
  log(entry: { level: 'debug' | 'info' | 'warn' | 'error' | 'security'; kind: string; source: string; payload: Record<string, unknown> }): Promise<unknown>
}

function audit(log: AuditLike | undefined, level: 'debug' | 'info' | 'warn' | 'error' | 'security', kind: string, payload: Record<string, unknown>): void {
  if (!log) return
  void log.log({ level, kind, source: 'local-llm-adapter', payload }).catch(() => {})
}

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

  constructor(config: Config, auditLog?: AuditLike) {
    super()
    this.providersList = [...config.providers]
    this.innerByProvider = new Map()
    for (const provider of this.providersList) {
      this.innerByProvider.set(provider, new RealLocalAdapter(provider, config, auditLog))
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

  constructor(provider: string, config: Config, auditLog?: AuditLike) {
    super()
    this.providerName = provider
    this.baseUrl = config.baseUrl.replace(/\/+$/u, '')
    this.defaultModel = config.defaultModel
    this.apiKeyEnv = config.apiKeyEnv
    this.auditLog = auditLog
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
    const body = buildChatCompletionsBody(options, this.defaultModel, undefined)
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      ...attributionHeaders(),
    }
    const apiKey = this.apiKeyEnv !== undefined ? readApiKey(this.apiKeyEnv) : undefined
    if (apiKey !== undefined) headers.authorization = `Bearer ${apiKey}`

    const promptText = options.messages.map((m) => `${m.role}:${extractText(m.content)}`).join('\n')
    const promptLen = promptText.length
    const start = Date.now()
    audit(this.auditLog, 'info', 'llm.local.start', { provider: options.provider, model: options.model, messageCount: options.messages.length, promptLen, baseUrl: this.baseUrl })

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
  const auditLog = (ctx as unknown as { auditLog?: AuditLike }).auditLog
  const adapter = new LocalLlmAdapterImpl(config, auditLog)
  const llm = (ctx as unknown as {
    llm: { registerAdapter(providers: string[], adapter: LlmAdapter): { (): void } }
  }).llm
  const registration = llm.registerAdapter(config.providers, adapter)
  return async () => {
    registration()
  }
}
