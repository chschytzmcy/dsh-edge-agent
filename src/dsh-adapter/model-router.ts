/**
 * model-router — exposes a single `llm` surface to the rest of the agent
 * loop, but routes each request to the appropriate adapter (local or
 * cloud) based on the model name. Local adapters stay on-device; cloud
 * adapters go through secure-bridge.
 *
 * @module dsh-edge-agent/model-router
 */

import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'model-router'

export const inject = ['llm', 'privacyPolicy', 'auditLog'] as const

export interface Config {
  defaultModel: string
  localModels: string[]
  cloudModels: string[]
}

export const Config: Schema<Config> = Schema.object({
  defaultModel: Schema.string().default('local-qwen3-4b'),
  localModels: Schema.array(Schema.string()).default(['local-qwen3-4b', 'local-llama3-8b']),
  cloudModels: Schema.array(Schema.string()).default(['cloud-deepseek-v4', 'cloud-deepseek-v3']),
})

export interface ModelRouterService {
  resolve(model: string): { realm: 'LOCAL' | 'CLOUD' | 'SANITIZED'; provider: string }
  listAvailable(): string[]
}

export class ModelRouterServiceImpl extends Service {
  constructor(ctx: any) {
    super(ctx, 'modelRouter')
  }
  resolve(model: string): { realm: 'LOCAL' | 'CLOUD' | 'SANITIZED'; provider: string } {
    if (model.startsWith('local-')) return { realm: 'LOCAL', provider: model }
    if (model.startsWith('cloud-')) return { realm: 'CLOUD', provider: model }
    return { realm: 'CLOUD', provider: model }
  }
  listAvailable(): string[] {
    return ['local-qwen3-4b', 'cloud-deepseek-v4']
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    modelRouter: ModelRouterServiceImpl
  }
}

export async function apply(ctx: any, config: Config): Promise<void> {
  ctx.plugin(ModelRouterServiceImpl)
  void config
  return async () => {}
}
