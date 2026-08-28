/**
 * openai-sse — shared helpers for talking to OpenAI-compatible
 * `/chat/completions` endpoints. Both `cloud-llm-adapter` (DeepSeek)
 * and `local-llm-adapter` (`mode: 'real'`) drive their wire envelope
 * and SSE parse through this module so a wire-protocol change lands
 * in one place.
 *
 * Wire shape:
 *   POST {baseUrl}/chat/completions
 *     { model, messages, stream: true, tools?, temperature?, max_tokens? }
 *   response: `text/event-stream` of `data: {...}` frames ending in
 *     `data: [DONE]`. The adapter translates frames into the DSH
 *     `StreamChunk` union (block-start, text-delta, reasoning-delta,
 *     tool-call-delta, block-end, usage, finish).
 *
 * @module dsh-edge-agent/openai-sse
 */

import type {
  CallId,
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  Message as DshMessage,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { attributionHeaders, CallId as brandCallId, LlmError } from '@deepseek-ai/dsh-llm'

/** Adapter contract surface shared by every OpenAI-compatible endpoint. */
export interface OpenAiCompatibleAdapter {
  readonly providers: readonly string[]
  readonly baseUrl: string
  readonly defaultModel: string
  readonly temperature: number | undefined
  providerInfo(provider: string): LlmProviderInfo
  listModels(provider: string): Promise<readonly LlmModelInfo[]>
  resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo>
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/** Build the wire body for `POST /chat/completions`. */
export function buildChatCompletionsBody(
  options: GenerateOptions,
  defaultModel: string,
  temperature: number | undefined,
): Record<string, unknown> {
  const wireMessages: Array<Record<string, unknown>> = []
  if (options.system !== undefined && options.system.length > 0) {
    wireMessages.push({ role: 'system', content: options.system })
  }
  for (const message of options.messages) {
    // Cordis messages use content-block arrays. We need to translate:
    //   - text blocks → concatenated text content
    //   - tool-call blocks → OpenAI `tool_calls` field (assistant messages)
    //   - tool-result blocks → separate `role: 'tool'` messages with `tool_call_id`
    const blocks = (Array.isArray(message.content) ? message.content : []) as unknown as Array<Record<string, unknown>>
    const textParts: string[] = []
    const toolCalls: Array<Record<string, unknown>> = []
    const toolResults: Array<{ id: string; content: string }> = []
    for (const block of blocks) {
      if (block.type === 'text' && typeof block.text === 'string') {
        textParts.push(block.text)
      } else if (block.type === 'tool-call') {
        toolCalls.push({
          id: String(block.toolCallId ?? block.callId ?? block.id ?? `call_${Math.random().toString(36).slice(2)}`),
          type: 'function',
          function: {
            name: String(block.name ?? ''),
            arguments: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {}),
          },
        })
      } else if (block.type === 'tool-result') {
        toolResults.push({
          id: String(block.toolCallId ?? block.callId ?? block.id ?? ''),
          content: typeof block.content === 'string' ? block.content : extractText(block.content as Array<{ type: string; text?: string }>),
        })
      }
      // reasoning blocks are intentionally skipped for the wire format
    }

    // Tool results become separate `role: 'tool'` messages
    if (toolResults.length > 0) {
      for (const tr of toolResults) {
        wireMessages.push({ role: 'tool', tool_call_id: tr.id, content: tr.content })
      }
      continue
    }

    // Build the wire message with appropriate fields
    const wireMsg: Record<string, unknown> = { role: message.role }
    wireMsg.content = textParts.length > 0 ? textParts.join('') : (toolCalls.length > 0 ? null : '')
    if (toolCalls.length > 0) {
      wireMsg.tool_calls = toolCalls
    }
    wireMessages.push(wireMsg)
  }
  const body: Record<string, unknown> = {
    // CRITICAL: use the adapter's configured `defaultModel` (the real upstream
    // model name, e.g. "deepseek-chat"), NOT `options.model` which is the Cordis
    // provider route ID (e.g. "cloud-deepseek-v4"). The route ID is meaningless
    // to the upstream API — only the adapter knows its own model name.
    model: defaultModel,
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

/** Pull the text out of a content-block array into one concatenated string. */
export function extractText(blocks: readonly { type: string; text?: string }[]): string {
  return blocks
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('')
}

/** Read a `Response` body as an SSE stream and yield finished frames. */
export async function* iterateSseFrames(
  response: Response,
  onError: (message: string) => never,
): AsyncIterable<ParsedEvent> {
  if (!response.ok || response.body === null) {
    const text = await response.text().catch(() => '')
    throw new LlmError(
      `OpenAI-compatible SSE: HTTP ${response.status} from ${response.url}: ${text.slice(0, 512)}`,
      'PROVIDER_ERROR',
    )
  }
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
        if (chunk !== undefined) yield chunk
      }
    }
  } catch (error) {
    onError((error as Error).message ?? String(error))
  } finally {
    reader.releaseLock()
  }
}

/**
 * Translate a `text-delta` or `tool-call-delta` SSE event into a DSH
 * `StreamChunk`. Returns `null` for `finish` events — the caller
 * tracks the finish reason separately and emits the terminal `finish`
 * through `terminalChunks` once the SSE stream closes.
 */
export function sseEventToChunk(
  event: ParsedEvent,
  toolCalls: Map<number, { id: string; name: string; arguments: string }>,
): {
  chunk: StreamChunk
  sawText: boolean
  sawToolCall: boolean
} | null {
  if (event.kind === 'text-delta') {
    return { chunk: { type: 'text-delta', index: 0, text: event.text }, sawText: true, sawToolCall: false }
  }
  if (event.kind === 'tool-call-delta') {
    const current = toolCalls.get(event.index) ?? { id: '', name: '', arguments: '' }
    if (event.id !== undefined) current.id = event.id
    if (event.name !== undefined) current.name = event.name
    current.arguments += event.argumentsDelta
    toolCalls.set(event.index, current)
    const idForChunk = event.id ?? current.id
    // CRITICAL: dsh-session's `snapshotJsonValue` rejects chunks with `undefined`
    // fields (throws "carries non-JSON-serializable data"). When DeepSeek splits
    // a tool call across multiple deltas, intermediate chunks omit `name` (and
    // on the very first chunk the local accumulator's `name` is still `''`).
    // Strip `undefined` so the chunk survives lossless JSON validation.
    const chunk: StreamChunk = {
      type: 'tool-call-delta',
      index: event.index,
      id: brandCallId(idForChunk as CallId | string) as CallId,
      argumentsDelta: event.argumentsDelta,
    }
    if (event.name !== undefined) chunk.name = event.name
    return {
      chunk,
      sawText: false,
      sawToolCall: true,
    }
  }
  return null
}

/** Extract the finish reason out of a `finish` event. */
export function sseFinishReason(event: ParsedEvent): 'stop' | 'length' | 'tool-calls' | undefined {
  return event.kind === 'finish' ? event.finishReason : undefined
}

/** Emit the terminal chunks: text `block-end`, sorted tool-call `block-end`s, then `finish`. */
export function* terminalChunks(
  sawText: boolean,
  assembledText: string,
  toolCalls: Map<number, { id: string; name: string; arguments: string }>,
  finishKind: 'stop' | 'length' | 'tool-calls' | undefined,
  sawToolCall: boolean,
): Iterable<StreamChunk> {
  if (sawText) {
    yield { type: 'block-end', index: 0, block: { type: 'text', text: assembledText } }
  }
  // CRITICAL: Tool-call block-ends must use indices that don't collide with text (index 0).
  // The BlockAssembler uses chunk.index to track blocks, so text and tool-calls must have
  // distinct indices. Use 1, 2, 3... for tool-calls.
  let toolCallIndex = 1
  for (const [, call] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
    yield {
      type: 'block-end',
      index: toolCallIndex++,
      block: {
        type: 'tool-call',
        id: brandCallId(call.id as CallId | string) as CallId,
        name: call.name,
        arguments: call.arguments,
      },
    }
  }
  yield {
    type: 'finish',
    reason:
      finishKind === 'length'
        ? { kind: 'max-tokens' }
        : finishKind === 'tool-calls' || sawToolCall
          ? { kind: 'tool-calls' }
          : { kind: 'stop' },
  }
}

/** SSE parser primitives. Kept package-private so other modules can't lean on the shape. */
export type ParsedEvent =
  | { kind: 'text-delta'; text: string }
  | { kind: 'tool-call-delta'; index: number; id?: string; name?: string; argumentsDelta: string }
  | { kind: 'finish'; finishReason: 'stop' | 'length' | 'tool-calls' }

export function splitSseEvents(buffer: string): { events: string[]; remainder: string } {
  const events: string[] = []
  let idx = buffer.indexOf('\n\n')
  let cursor = 0
  while (idx !== -1) {
    events.push(buffer.slice(cursor, idx))
    cursor = idx + 2
    idx = buffer.indexOf('\n\n', cursor)
  }
  return { events, remainder: buffer.slice(cursor) }
}

export function parseSseEvent(raw: string): ParsedEvent | undefined {
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

/** Default attribution headers every request should carry. */
export function defaultAttributionHeaders(): Record<string, string> {
  return attributionHeaders()
}

/** Type re-exports for downstream consumers. */
export type { DshMessage, GenerateOptions, StreamChunk }
