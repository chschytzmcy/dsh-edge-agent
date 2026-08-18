/**
 * tools — Realm-aware tool registry. Tools are tagged with the realm
 * they belong to (LOCAL / CLOUD / SANITIZED) so the intent-router can
 * filter the global tool set per session.
 *
 * @module dsh-edge-agent/tools
 */

import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'tools'

export const inject = ['auditLog'] as const

export interface Config {
  defaultRateLimitPerMinute: number
  enableToolIsolation: boolean
}

export const Config: Schema<Config> = Schema.object({
  defaultRateLimitPerMinute: Schema.natural().default(60),
  enableToolIsolation: Schema.boolean().default(true),
})

export interface ToolDefinition {
  name: string
  realm: 'LOCAL' | 'CLOUD' | 'SANITIZED'
  description: string
  inputSchema: Record<string, unknown>
  rateLimitPerMinute?: number
}

export interface ToolsService {
  register(tool: ToolDefinition, handler: (args: any) => Promise<any>): () => void
  list(realm?: 'LOCAL' | 'CLOUD' | 'SANITIZED'): ToolDefinition[]
  invoke(name: string, args: any, realm: string): Promise<any>
}

export class ToolsServiceImpl extends Service {
  constructor(ctx: any) {
    super(ctx, 'edgeTools')
  }
  register(tool: ToolDefinition, handler: (args: any) => Promise<any>): () => void {
    void tool
    void handler
    return () => {}
  }
  list(realm?: 'LOCAL' | 'CLOUD' | 'SANITIZED'): ToolDefinition[] {
    void realm
    return []
  }
  async invoke(name: string, args: any, realm: string): Promise<any> {
    void name
    void args
    void realm
    return null
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    edgeTools: ToolsServiceImpl
  }
}

export async function apply(ctx: any, config: Config): Promise<() => Promise<void>> {
  ctx.plugin(ToolsServiceImpl)
  void config
  return async () => {}
}
