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
 * for `content` deltas and a terminal `finish({ kind: 'stop' })`.
 *
 * @module dsh-edge-agent/cloud-llm-adapter
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import {
  attributionHeaders,
  CallId as brandCallId,
  LlmAdapter,
  LlmError,
} from '@deepseek-ai/dsh-llm'
import type {
  CallId,
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  Message,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'

export const name = 'cloud-llm-adapter'

export const inject = ['llm'] as const

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
  providers: Schema.array(Schema.string()).default(['cloud-deepseek-v4']),
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

  constructor(config: Config) {
    super()
    this.providersList = [...config.providers]
    this.baseUrl = config.baseUrl.replace(/\/+$/u, '')
    this.apiKeyEnv = config.apiKeyEnv
    this.defaultModel = config.defaultModel
    this.temperature = config.temperature
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
        inputModalities: ['text'],
      },
    ])
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const apiKey = readApiKey(this.apiKeyEnv)
    if (!apiKey) {
      throw new LlmError(
        `cloud-llm-adapter: missing API key in env slot "${this.apiKeyEnv}"`,
        'MISSING_CREDENTIAL',
      )
    }
    const url = `${this.baseUrl}/chat/completions`
    const body = buildRequestBody(options, this.defaultModel, this.temperature)
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'authorization': `Bearer ${apiKey}`,
      'accept': 'text/event-stream',
      ...attributionHeaders(),
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: options.signal,
    })
    if (!response.ok || response.body === null) {
      const text = await response.text().catch(() => '')
      throw new LlmError(
        `cloud-llm-adapter: HTTP ${response.status} from ${url}: ${text.slice(0, 512)}`,
        'PROVIDER_ERROR',
      )
    }

    yield { type: 'block-start', index: 0, blockType: 'text' }
    let assembledText = ''
    let finishKind: 'stop' | 'length' | 'tool-calls' = 'stop'
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>()
    let sawToolCall = false
    let sawText = false

    const stream = response.body as unknown as ReadableStream<Uint8Array>
    const reader = stream.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const events = splitSseEvents(buffer)
        buffer = events.remainder
        for (const event of events.events) {
          const chunk = parseSseEvent(event)
          if (chunk === undefined) continue
          if (chunk.kind === 'text-delta') {
            assembledText += chunk.text
            sawText = true
            yield { type: 'text-delta', index: 0, text: chunk.text }
          } else if (chunk.kind === 'tool-call-delta') {
            sawToolCall = true
            const current = toolCalls.get(chunk.index) ?? { id: '', name: '', arguments: '' }
            if (chunk.id !== undefined) current.id = chunk.id
            if (chunk.name !== undefined) current.name = chunk.name
            current.arguments += chunk.argumentsDelta
            toolCalls.set(chunk.index, current)
            const idForChunk = chunk.id ?? current.id
            yield {
              type: 'tool-call-delta',
              index: chunk.index,
              id: brandCallId(idForChunk),
              name: chunk.name,
              argumentsDelta: chunk.argumentsDelta,
            }
          } else if (chunk.kind === 'finish') {
            finishKind = chunk.finishReason
          }
        }
      }
    } catch (error) {
      throw new LlmError(
        `cloud-llm-adapter: SSE stream interrupted: ${(error as Error).message ?? String(error)}`,
        'PROVIDER_ERROR',
      )
    } finally {
      reader.releaseLock()
    }

    if (sawText) {
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'text', text: assembledText },
      }
    }
    for (const [index, call] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
      yield {
        type: 'block-end',
        index,
        block: { type: 'tool-call', id: brandCallId(call.id), name: call.name, arguments: call.arguments },
      }
    }
    yield {
      type: 'finish',
      reason: finishKind === 'length'
        ? { kind: 'max-tokens' }
        : finishKind === 'tool-calls' || sawToolCall
          ? { kind: 'tool-calls' }
          : { kind: 'stop' },
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

function buildRequestBody(
  options: GenerateOptions,
  defaultModel: string,
  temperature: number | undefined,
): Record<string, unknown> {
  const wireMessages: Array<{ role: string; content: unknown }> = []
  if (options.system !== undefined && options.system.length > 0) {
    // DeepSeek expects the system slot as the first message.
    wireMessages.push({ role: 'system', content: options.system })
  }
  for (const message of options.messages) {
    wireMessages.push({ role: message.role, content: extractText(message.content) })
  }
  const body: Record<string, unknown> = {
    model: options.model || defaultModel,
    messages: wireMessages,
    stream: true,
  }
  if (options.tools !== undefined && options.tools.length > 0) {
    body.tools = options.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }))
  }
  if (temperature !== undefined) body.temperature = temperature
  if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens
  return body
}

function extractText(blocks: readonly { type: string; text?: string }[]): string {
  return blocks
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('')
}

type ParsedEvent =
  | { kind: 'text-delta'; text: string }
  | { kind: 'tool-call-delta'; index: number; id?: string; name?: string; argumentsDelta: string }
  | { kind: 'finish'; finishReason: 'stop' | 'length' | 'tool-calls' }

function splitSseEvents(buffer: string): { events: string[]; remainder: string } {
  // SSE frames end with `\n\n`; tolerate `\r\n\r\n` and lone newlines.
  const events: string[] = []
  let idx = buffer.indexOf('\n\n')
  let cursor = 0
  while (idx !== -1) {
    events.push(buffer.slice(cursor, idx))
    cursor = idx + 2
    idx = buffer.indexOf('\n\n', cursor)
  }
  return { events: events, remainder: buffer.slice(cursor) }
}

function parseSseEvent(raw: string): ParsedEvent | undefined {
  const lines = raw.split('\n')
  for (const line of lines) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload.length === 0 || payload === '[DONE]') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch {
      continue
    }
    const record = parsed as Record<string, unknown>
    const choices = record.choices
    if (!Array.isArray(choices) || choices.length === 0) continue
    const choice = choices[0] as Record<string, unknown>
    const delta = choice.delta as Record<string, unknown> | undefined
    const content = delta?.content
    if (typeof content === 'string' && content.length > 0) {
      return { kind: 'text-delta', text: content }
    }
    const toolCalls = delta?.tool_calls
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      const first = toolCalls[0] as Record<string, unknown>
      const fn = first.function as Record<string, unknown> | undefined
      const index = typeof first.index === 'number' ? first.index : 0
      return {
        kind: 'tool-call-delta',
        index,
        id: typeof first.id === 'string' ? first.id : undefined,
        name: typeof fn?.name === 'string' ? fn.name : undefined,
        argumentsDelta: typeof fn?.arguments === 'string' ? fn.arguments : '',
      }
    }
    const finishReason = choice.finish_reason
    if (typeof finishReason === 'string') {
      if (finishReason === 'tool_calls') {
        return { kind: 'finish', finishReason: 'tool-calls' }
      }
      return {
        kind: 'finish',
        finishReason: finishReason === 'length' ? 'length' : 'stop',
      }
    }
  }
  return undefined
}

export async function apply(ctx: Context, config: Config): Promise<() => Promise<void>> {
  const adapter = new CloudLlmAdapterImpl(config)
  const llm = (ctx as unknown as {
    llm: { registerAdapter(providers: string[], adapter: LlmAdapter): { (): void } }
  }).llm
  const registration = llm.registerAdapter(config.providers, adapter)
  return async () => {
    registration()
  }
}