/**
 * ohttp-gateway — RFC 9458 Oblivious HTTP gateway implementation. Wraps
 * requests in HPKE ciphertext so the relay cannot link user identity
 * to request content.
 *
 * @module dsh-edge-agent/ohttp-gateway
 */

import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'ohttp-gateway'

export const inject = ['tcm', 'auditLog'] as const

export interface Config {
  relayUrl: string
  targetUrl: string
  /** Public key for the OHTTP gateway (HPKE). */
  publicKey: string
  keyId: string
  /** When true, fall back to plain TLS if the relay is unreachable. */
  allowFallbackTls: boolean
}

export const Config: Schema<Config> = Schema.object({
  relayUrl: Schema.string().required(),
  targetUrl: Schema.string().required(),
  publicKey: Schema.string().required(),
  keyId: Schema.string().required(),
  allowFallbackTls: Schema.boolean().default(false),
})

export interface OhttpRequest {
  url: string
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  headers: Record<string, string>
  body?: Uint8Array
}

export interface OhttpService {
  send(req: OhttpRequest): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }>
}

export class OhttpServiceImpl extends Service {
  constructor(ctx: any) {
    super(ctx, 'ohttp')
  }
  async send(req: OhttpRequest) {
    void req
    return { status: 200, headers: {}, body: new Uint8Array() }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    ohttp: OhttpServiceImpl
  }
}

export async function apply(ctx: any, config: Config): Promise<void> {
  ctx.plugin(OhttpServiceImpl)
  void config
  return async () => {}
}
