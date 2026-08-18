/**
 * TCM (Trusted Computing Module) — provides TEE-aware key management,
 * encryption, sealing, and remote-attestation primitives.
 *
 * Backends:
 *   - simulated: pure-JS, suitable for dev/CI
 *   - trustzone: ARM TrustZone (production target)
 *   - keystone: RISC-V Keystone (production target)
 *   - sgx: Intel SGX (server-side test)
 *
 * @module dsh-edge-agent/tcm
 */

import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'tcm'

export const inject = [] as const

export interface Config {
  teeType: 'simulated' | 'trustzone' | 'keystone' | 'sgx'
  keyStorePath: string
  teeInference: boolean
  secureMemoryLimit: number
}

export const Config: Schema<Config> = Schema.object({
  teeType: Schema.union(['simulated', 'trustzone', 'keystone', 'sgx'] as const).required(),
  keyStorePath: Schema.string().required(),
  teeInference: Schema.boolean().default(false),
  secureMemoryLimit: Schema.natural().default(64 * 1024 * 1024),
})

export interface AttestationToken {
  payload: string
  signature: string
  teeType: string
  nonce: string
}

export interface TcmStatus {
  teeAvailable: boolean
  teeType: string
  keyCount: number
  secureMemoryUsed: number
}

export class TcmService extends Service {
  constructor(ctx: any) {
    super(ctx, 'tcm')
  }

  async generateKey(tag: string): Promise<Uint8Array> {
    // MVP: stub. real implementation would call TEE SDK
    return new Uint8Array(32)
  }

  async getKey(tag: string): Promise<Uint8Array> {
    return new Uint8Array(32)
  }

  async deleteKey(tag: string): Promise<void> {
    // MVP: stub
  }

  async encrypt(data: Uint8Array, tag: string): Promise<Uint8Array> {
    // MVP: stub. real implementation uses AES-256-GCM via TEE
    return data
  }

  async decrypt(data: Uint8Array, tag: string): Promise<Uint8Array> {
    return data
  }

  async hash(data: Uint8Array, algorithm: 'sha-256' | 'sha-3'): Promise<Uint8Array> {
    return new Uint8Array(32)
  }

  async seal(data: Uint8Array): Promise<Uint8Array> {
    return data
  }

  async unseal(data: Uint8Array): Promise<Uint8Array> {
    return data
  }

  async generateAttestation(nonce: string): Promise<AttestationToken> {
    return {
      payload: '',
      signature: '',
      teeType: 'simulated',
      nonce,
    }
  }

  getStatus(): TcmStatus {
    return {
      teeAvailable: true,
      teeType: 'simulated',
      keyCount: 0,
      secureMemoryUsed: 0,
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tcm: TcmService
  }
}

export async function apply(ctx: any, config: Config): Promise<() => Promise<void>> {
  ctx.plugin(TcmService)
  // MVP: real TEE wiring (KeyStore, secure-memory limiter) lives in plugin.ts
  return async () => {
    // dispose hook
  }
}
