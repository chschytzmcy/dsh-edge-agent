/**
 * cloud-llm-adapter — registers a remote LLM provider (DeepSeek, etc).
 * Each request must traverse the secure-bridge, so the adapter never
 * holds direct API credentials.
 *
 * @module dsh-edge-agent/cloud-llm-adapter
 */

import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'cloud-llm-adapter'

export const inject = ['secureBridge', 'auditLog'] as const

export interface Config {
  providers: string[]
  baseUrl: string
  apiKeyEnv: string
}

export const Config: Schema<Config> = Schema.object({
  providers: Schema.array(Schema.string()).default(['cloud-deepseek-v4']),
  baseUrl: Schema.string().default('https://api.deepseek.com'),
  apiKeyEnv: Schema.string().default('DEEPSEEK_API_KEY'),
})

export interface CloudLlmAdapter {
  readonly providers: string[]
  stream(options: any): AsyncIterable<any>
}

export class CloudLlmAdapterImpl extends Service implements CloudLlmAdapter {
  readonly providers: string[]
  constructor(ctx: any, config: Config) {
    super(ctx, 'cloudLlmAdapter')
    this.providers = config.providers
  }
  async *stream(options: any): AsyncIterable<any> {
    void options
    yield { type: 'done' }
  }
}

export async function apply(ctx: any, config: Config): Promise<() => Promise<void>> {
  const adapter = new CloudLlmAdapterImpl(ctx, config)
  ctx.plugin(CloudLlmAdapterImpl, config)
  const llm = (ctx as any).llm
  if (llm?.registerAdapter) {
    llm.registerAdapter(config.providers, adapter)
  }
  return async () => {}
}
