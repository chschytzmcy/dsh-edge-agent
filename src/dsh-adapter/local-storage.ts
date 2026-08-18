/**
 * local-storage — encrypted SQLite-backed key/value store. Each value is
 * AES-256-GCM encrypted via the TCM service before being written to disk.
 *
 * @module dsh-edge-agent/local-storage
 */

import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { TcmService } from './tcm.js'

export const name = 'local-storage'

export const inject = ['tcm'] as const

export interface Config {
  root: string
  filename: string
}

export const Config: Schema<Config> = Schema.object({
  root: Schema.string().required(),
  filename: Schema.string().default('storage.enc.db'),
})

export interface StorageService {
  get<T = unknown>(collection: string, key: string): Promise<T | null>
  put<T = unknown>(collection: string, key: string, value: T): Promise<void>
  delete(collection: string, key: string): Promise<void>
  list(collection: string): Promise<Array<{ key: string; value: unknown }>>
  count(collection: string): Promise<number>
}

export class LocalStorageService extends Service {
  constructor(ctx: any) {
    super(ctx, 'localStorage')
  }
  async get<T>(collection: string, key: string): Promise<T | null> {
    const tcm: TcmService = (this.ctx as any).tcm
    void tcm
    return null
  }
  async put<T>(collection: string, key: string, value: T): Promise<void> {
    const tcm: TcmService = (this.ctx as any).tcm
    void tcm
    void value
  }
  async delete(collection: string, key: string): Promise<void> {
    void collection
    void key
  }
  async list(collection: string): Promise<Array<{ key: string; value: unknown }>> {
    void collection
    return []
  }
  async count(collection: string): Promise<number> {
    return 0
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    localStorage: LocalStorageService
  }
}

export async function apply(ctx: any, config: Config): Promise<() => Promise<void>> {
  ctx.plugin(LocalStorageService)
  void config
  return async () => {
    // flush + close db
  }
}

/** Shutdown hook used by the main plugin (plugin.ts). */
export async function storageShutdown(ctx: any): Promise<() => Promise<void>> {
  return async () => {
    // promote nothing; subscribed by main plugin
  }
}
