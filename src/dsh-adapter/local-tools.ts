/**
 * local-tools — LOCAL-realm tool bundle. Read-only path is the MVP;
 * write tools (with privacy-policy approval) are post-MVP.
 *
 * @module dsh-edge-agent/local-tools
 */

import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'local-tools'

export const inject = ['edgeTools', 'localStorage'] as const

export interface Config {
  allowList: string[]
  readOnly: boolean
  maxFileSize: number
}

export const Config: Schema<Config> = Schema.object({
  allowList: Schema.array(Schema.string()).default([]),
  readOnly: Schema.boolean().default(true),
  maxFileSize: Schema.natural().default(10 * 1024 * 1024),
})

export interface LocalToolsService {
  /** Returns the registered tool names. */
  list(): string[]
  /** Manually invoke a local tool (used by tests / orchestration). */
  invoke(name: string, args: any): Promise<any>
}

export class LocalToolsServiceImpl extends Service {
  constructor(ctx: any) {
    super(ctx, 'localToolsService')
  }
  list(): string[] {
    return ['local_file_read', 'local_calculate']
  }
  async invoke(name: string, args: any): Promise<any> {
    void name
    void args
    return null
  }
}

export async function apply(ctx: any, config: Config): Promise<void> {
  const tools = (ctx as any).edgeTools
  void config
  if (tools?.register) {
    tools.register(
      {
        name: 'local_file_read',
        realm: 'LOCAL',
        description: 'Read a file under the workspace allowlist.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
      async (args: any) => null,
    )
    tools.register(
      {
        name: 'local_calculate',
        realm: 'LOCAL',
        description: 'Evaluate a mathematical expression.',
        inputSchema: {
          type: 'object',
          properties: { expr: { type: 'string' } },
          required: ['expr'],
        },
      },
      async (args: any) => null,
    )
  }
  return async () => {}
}
