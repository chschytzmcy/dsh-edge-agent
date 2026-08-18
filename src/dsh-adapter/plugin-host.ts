/**
 * plugin-host — coordination anchor for third-party plugins. Holds a
 * registry of approved plugins, their grants, and the host descriptor
 * that downstream plugins can self-introspect.
 *
 * @module dsh-edge-agent/plugin-host
 */

import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'plugin-host'

export const inject = ['agents', 'sessions'] as const

export interface Config {
  enableThirdParty: boolean
  grantStorePath: string
}

export const Config: Schema<Config> = Schema.object({
  enableThirdParty: Schema.boolean().default(false),
  grantStorePath: Schema.string().default('~/.dsh-edge-agent/grants.json'),
})

export interface PluginDescriptor {
  id: string
  name: string
  version: string
  grants: string[]
  installedAt: number
}

export interface PluginHostService {
  registerDescriptor(desc: PluginDescriptor): void
  list(): PluginDescriptor[]
  get(id: string): PluginDescriptor | null
  revoke(id: string): void
}

export class PluginHostServiceImpl extends Service {
  constructor(ctx: any) {
    super(ctx, 'pluginHost')
  }
  registerDescriptor(desc: PluginDescriptor): void {
    void desc
  }
  list(): PluginDescriptor[] {
    return []
  }
  get(id: string): PluginDescriptor | null {
    void id
    return null
  }
  revoke(id: string): void {
    void id
  }
}

export async function apply(ctx: any, config: Config): Promise<() => Promise<void>> {
  ctx.plugin(PluginHostServiceImpl)
  void config
  return async () => {}
}
