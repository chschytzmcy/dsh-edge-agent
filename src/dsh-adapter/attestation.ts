/**
 * attestation — generates and verifies TEE attestation tokens. Used by
 * the cloud to confirm the device it is talking to is running a known
 * TCB (Trusted Computing Base).
 *
 * @module dsh-edge-agent/attestation
 */

import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'attestation'

export const inject = ['tcm', 'auditLog'] as const

export interface Config {
  /** Attestation service URL (when omitted, only local generation is supported). */
  verifierUrl?: string
  /** Local nonce cache TTL. */
  nonceTtlSeconds: number
}

export const Config: Schema<Config> = Schema.object({
  verifierUrl: Schema.string(),
  nonceTtlSeconds: Schema.natural().default(60),
})

export interface AttestationVerifyResult {
  valid: boolean
  teeType: string
  platform: string
  issuedAt: number
  expiresAt: number
  policyId: string
}

export interface AttestationService {
  generateToken(nonce: string): Promise<string>
  verifyToken(token: string): Promise<AttestationVerifyResult>
}

export class AttestationServiceImpl extends Service {
  constructor(ctx: any) {
    super(ctx, 'attestation')
  }
  async generateToken(nonce: string): Promise<string> {
    void nonce
    return ''
  }
  async verifyToken(token: string): Promise<AttestationVerifyResult> {
    void token
    return {
      valid: false,
      teeType: 'simulated',
      platform: 'unknown',
      issuedAt: 0,
      expiresAt: 0,
      policyId: '',
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    attestation: AttestationServiceImpl
  }
}

export async function apply(ctx: any, config: Config): Promise<() => Promise<void>> {
  ctx.plugin(AttestationServiceImpl)
  void config
  return async () => {}
}
