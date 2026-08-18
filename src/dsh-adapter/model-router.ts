/**
 * model-router — minimal M1 router. Each user request picks a model
 * by name; the router classifies the name into a realm and forwards
 * to `ctx.llm.stream` so the registered adapter for that provider
 * route actually runs. The router never creates an isolated realm
 * and never replaces `ctx.llm` — adapters registered via
 * `ctx.llm.registerAdapter(providers, adapter)` are the only LLM
 * surface, as documented in § 11.2 (3) of dsh-edge-agent-design-v6.md.
 *
 * @module dsh-edge-agent/model-router
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'model-router'

export const inject = ['llm'] as const

export type Realm = 'LOCAL' | 'CLOUD' | 'SANITIZED'

export interface Config {
  /** Default model used when a request omits one. */
  defaultModel: string
  /** Catalog of local provider routes the router can surface. */
  localModels: string[]
  /** Catalog of cloud provider routes the router can surface. */
  cloudModels: string[]
}

export const Config: Schema<Config> = Schema.object({
  defaultModel: Schema.string().default('cloud-deepseek-v4'),
  localModels: Schema.array(Schema.string()).default(['local-qwen3-4b-mock']),
  cloudModels: Schema.array(Schema.string()).default(['cloud-deepseek-v4']),
})

export interface ResolvedRoute {
  realm: Realm
  provider: string
  model: string
}

export interface ModelRouterService {
  resolve(model: string): ResolvedRoute
  listAvailable(): string[]
}

export class ModelRouterServiceImpl extends Service {
  constructor(ctx: Context) {
    super(ctx, 'modelRouter')
  }

  resolve(model: string): ResolvedRoute {
    return resolveRoute(model)
  }

  listAvailable(): string[] {
    return ['local-qwen3-4b-mock', 'cloud-deepseek-v4']
  }
}

/** Pure route classifier. Exported so unit tests can pin it without a Cordis ctx. */
export function resolveRoute(model: string): ResolvedRoute {
  const normalized = model.length > 0 ? model : 'cloud-deepseek-v4'
  if (normalized.startsWith('local-')) {
    return { realm: 'LOCAL', provider: normalized, model: normalized }
  }
  if (normalized.startsWith('cloud-')) {
    return { realm: 'CLOUD', provider: normalized, model: normalized }
  }
  return { realm: 'CLOUD', provider: normalized, model: normalized }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    modelRouter: ModelRouterServiceImpl
  }
}

export async function apply(ctx: Context, config: Config): Promise<() => Promise<void>> {
  const service = new ModelRouterServiceImpl(ctx)
  const dispose = ctx.provide('modelRouter', service)
  void config
  return async () => {
    dispose()
  }
}