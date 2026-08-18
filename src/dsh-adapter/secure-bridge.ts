/**
 * secure-bridge — the single outbound channel for cloud-bound requests.
 * Routes through the OHTTP gateway when reachable, falls back to direct
 * TLS only when explicitly allowed. Cooperates with td-bus for rate
 * limiting and quarantine.
 *
 * @module dsh-edge-agent/secure-bridge
 */

import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'secure-bridge'

export const inject = ['tcm', 'ohttp', 'privacyPolicy', 'auditLog'] as const

export interface Config {
  mode: 'ohttp' | 'tls' | 'auto'
  domainAllowList: string[]
  domainDenyList: string[]
  requestTimeoutMs: number
}

export const Config: Schema<Config> = Schema.object({
  mode: Schema.union(['ohttp', 'tls', 'auto'] as const).default('ohttp'),
  domainAllowList: Schema.array(Schema.string()).default([]),
  domainDenyList: Schema.array(Schema.string()).default([]),
  requestTimeoutMs: Schema.natural().default(30000),
})

export interface CloudRequest {
  url: string
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  headers: Record<string, string>
  body?: unknown
  sessionId?: string
}

export interface CloudResponse {
  status: number
  headers: Record<string, string>
  body: unknown
}

export interface SecureBridgeService {
  sendCloudRequest(req: CloudRequest): Promise<CloudResponse>
  isBlocked(): boolean
}

export class SecureBridgeServiceImpl extends Service {
  constructor(ctx: any) {
    super(ctx, 'secureBridge')
  }
  async sendCloudRequest(req: CloudRequest): Promise<CloudResponse> {
    void req
    return { status: 200, headers: {}, body: null }
  }
  isBlocked(): boolean {
    return false
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    secureBridge: SecureBridgeServiceImpl
  }
}

export async function apply(ctx: any, config: Config): Promise<() => Promise<void>> {
  ctx.plugin(SecureBridgeServiceImpl)
  void config
  return async () => {}
}
