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
import { join } from 'node:path'
import { edgeHome, loadEdgeConfig } from './edge-config.js'

export const name = 'tcm'

export const inject = [] as const

export interface Config {
  teeType: 'simulated' | 'trustzone' | 'keystone' | 'sgx'
  keyStorePath: string
  teeInference: boolean
  secureMemoryLimit: number
}

export const Config: Schema<Config> = Schema.object({
  // §7.102 "one config file": no required/default — apply() fills teeType /
  // keyStorePath from config/edge.json (tee.*), deriving the keystore path
  // from the storage root when not given.
  teeType: Schema.union(['simulated', 'trustzone', 'keystone', 'sgx'] as const),
  keyStorePath: Schema.string(),
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
  // §7.102: fill unset fields from config/edge.json (tee.*) so the stub
  // service and A3 future work read the same single source.
  const tee = loadEdgeConfig().tee
  const c = config as Partial<Config>
  if (c.teeType === undefined) {
    c.teeType = (tee?.type && tee.type.length > 0 ? tee.type : 'simulated') as Config['teeType']
  }
  if (c.keyStorePath === undefined) {
    const storageRoot = tee?.storageRoot && tee.storageRoot.length > 0 ? tee.storageRoot : edgeHome()
    c.keyStorePath = tee?.keyStorePath && tee.keyStorePath.length > 0
      ? tee.keyStorePath
      : join(storageRoot, 'tcm-keys.json')
  }
  ctx.plugin(TcmService)
  // MVP: real TEE wiring (KeyStore, secure-memory limiter) lives in plugin.ts
  return async () => {
    // dispose hook
  }
}
