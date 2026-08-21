/**
 * model-router — M1 + M4 router. Each user request picks a model by
 * name; the router classifies the name into a realm and forwards to
 * `ctx.llm.stream` so the registered adapter for that provider route
 * actually runs. The router never creates an isolated realm and never
 * replaces `ctx.llm` — adapters registered via
 * `ctx.llm.registerAdapter(providers, adapter)` are the only LLM
 * surface, as documented in § 11.2 (3) of dsh-edge-agent-design-v6.md.
 *
 * M4 adds:
 *   - `listAvailable()` returns the union of `Config.localModels` and
 *     `Config.cloudModels` so callers can enumerate dispatch keys.
 *   - `resolve()` accepts either a provider route id (e.g. `local-qwen3-4b`)
 *     or a free-form model id (e.g. `deepseek-chat`) and maps it to the
 *     correct route. The prefix rule still decides realm; a free-form
 *     model id without a prefix falls back to CLOUD.
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
  /** Default route id used when a request omits one. */
  defaultModel: string
  /** Catalog of local provider routes the router can surface. */
  localModels: string[]
  /** Catalog of cloud provider routes the router can surface. */
  cloudModels: string[]
}

export const Config: Schema<Config> = Schema.object({
  defaultModel: Schema.string().default('cloud-deepseek-v4'),
  localModels: Schema.array(Schema.string()).default([
    'local-qwen3-4b',
  ]),
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
  isAvailable(provider: string): boolean
}

export class ModelRouterServiceImpl extends Service {
  private readonly localModels: readonly string[]
  private readonly cloudModels: readonly string[]

  constructor(ctx: Context, localModels: readonly string[], cloudModels: readonly string[]) {
    super(ctx, 'modelRouter')
    this.localModels = localModels
    this.cloudModels = cloudModels
  }

  resolve(model: string): ResolvedRoute {
    return resolveRoute(model, this.localModels, this.cloudModels)
  }

  listAvailable(): string[] {
    return [...this.localModels, ...this.cloudModels]
  }

  isAvailable(provider: string): boolean {
    return this.localModels.includes(provider) || this.cloudModels.includes(provider)
  }
}

/** Pure route classifier. Exported so unit tests can pin it without a Cordis ctx. */
export function resolveRoute(
  model: string,
  localModels: readonly string[] = ['local-qwen3-4b'],
  cloudModels: readonly string[] = ['cloud-deepseek-v4'],
): ResolvedRoute {
  const normalized = model.length > 0 ? model : 'cloud-deepseek-v4'
  if (localModels.includes(normalized)) {
    return { realm: 'LOCAL', provider: normalized, model: normalized }
  }
  if (cloudModels.includes(normalized)) {
    return { realm: 'CLOUD', provider: normalized, model: normalized }
  }
  if (normalized.startsWith('local-')) {
    return { realm: 'LOCAL', provider: normalized, model: normalized }
  }
  if (normalized.startsWith('cloud-')) {
    return { realm: 'CLOUD', provider: normalized, model: normalized }
  }
  // Unknown prefix: treat as CLOUD (provider/model a la DeepSeek chat-completions).
  return { realm: 'CLOUD', provider: normalized, model: normalized }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    modelRouter: ModelRouterServiceImpl
  }
}

export async function apply(ctx: Context, config: Config): Promise<() => Promise<void>> {
  // ModelRouterServiceImpl extends `Service`, so its constructor calls
  // `ctx.reflect.provide('modelRouter', this)` for us. Do not call
  // `ctx.provide` again — that would throw "service already registered".
  void new ModelRouterServiceImpl(ctx, config.localModels, config.cloudModels)
  return async () => {}
}
