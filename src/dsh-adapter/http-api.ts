/**
 * http-api — exposes an HTTP server from the parent DSH process so that
 * external consumers (mobile apps, third-party services) can talk to a
 * running agent. Optional S13 plugin.
 *
 * @module dsh-edge-agent/http-api
 */

import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'http-api'

export const inject = ['agents', 'sessions', 'auditLog'] as const

export interface Config {
  host: string
  port: number
  /** Bearer token required for all requests. */
  bearerToken?: string
  /** Whether to require attestation on first request. */
  requireAttestation: boolean
}

export const Config: Schema<Config> = Schema.object({
  host: Schema.string().default('127.0.0.1'),
  port: Schema.natural().default(3080),
  bearerToken: Schema.string(),
  requireAttestation: Schema.boolean().default(true),
})

export interface HttpApiService {
  start(): Promise<void>
  stop(): Promise<void>
  isRunning(): boolean
  endpoint(): string
}

export class HttpApiServiceImpl extends Service {
  constructor(ctx: any) {
    super(ctx, 'httpApi')
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  isRunning(): boolean {
    return false
  }
  endpoint(): string {
    return ''
  }
}

export async function apply(ctx: any, config: Config): Promise<() => Promise<void>> {
  ctx.plugin(HttpApiServiceImpl)
  const svc: HttpApiServiceImpl = (ctx as any).httpApi
  await svc.start()
  void config
  return async () => {
    await svc.stop()
  }
}
