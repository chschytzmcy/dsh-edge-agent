/**
 * local-llm-adapter — registers a local LLM (e.g. llama.cpp running on
 * device) on the shared `ctx.llm` runtime. Bound to the LOCAL realm:
 * no outbound network, no remote attestation needed.
 *
 * @module dsh-edge-agent/local-llm-adapter
 */

import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'local-llm-adapter'

export const inject = [] as const

export interface Config {
  providers: string[]
  modelPath: string
  contextSize: number
  threads: number
}

export const Config: Schema<Config> = Schema.object({
  providers: Schema.array(Schema.string()).default(['local-qwen3-4b']),
  modelPath: Schema.string().required(),
  contextSize: Schema.natural().default(8192),
  threads: Schema.natural().default(4),
})

export interface LocalLlmAdapter {
  readonly providers: string[]
  stream(options: any): AsyncIterable<any>
}

export class LocalLlmAdapterImpl extends Service implements LocalLlmAdapter {
  readonly providers: string[]
  constructor(ctx: any, config: Config) {
    super(ctx, 'localLlmAdapter')
    this.providers = config.providers
  }
  async *stream(options: any): AsyncIterable<any> {
    void options
    yield { type: 'done' }
  }
}

export async function apply(ctx: any, config: Config): Promise<() => Promise<void>> {
  const adapter = new LocalLlmAdapterImpl(ctx, config)
  ctx.plugin(LocalLlmAdapterImpl, config)
  // Register on the LLM runtime.
  const llm = (ctx as any).llm
  if (llm?.registerAdapter) {
    llm.registerAdapter(config.providers, adapter)
  }
  return async () => {}
}
