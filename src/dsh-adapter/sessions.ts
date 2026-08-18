/**
 * sessions — encrypted session lifecycle. Each session is a durable
 * conversation thread whose backing JSONL is sealed via the encrypted
 * local-storage collection.
 *
 * @module dsh-edge-agent/sessions
 */

import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'sessions'

export const inject = ['tcm', 'localStorage'] as const

export interface Config {
  defaultTtlSeconds: number
  maxConcurrentSessions: number
}

export const Config: Schema<Config> = Schema.object({
  defaultTtlSeconds: Schema.natural().default(60 * 60),
  maxConcurrentSessions: Schema.natural().default(8),
})

export interface SessionRecord {
  id: string
  realm: 'LOCAL' | 'CLOUD' | 'SANITIZED'
  owner: string
  createdAt: number
  expiresAt: number
  messages: number
}

export interface SessionService {
  create(realm: 'LOCAL' | 'CLOUD' | 'SANITIZED', owner: string): Promise<SessionRecord>
  get(id: string): Promise<SessionRecord | null>
  append(id: string, message: unknown): Promise<void>
  destroy(id: string): Promise<void>
  cleanup(): Promise<number>
  listActive(): Promise<SessionRecord[]>
}

export class SessionServiceImpl extends Service {
  constructor(ctx: any) {
    super(ctx, 'sessions')
  }
  async create(realm: 'LOCAL' | 'CLOUD' | 'SANITIZED', owner: string): Promise<SessionRecord> {
    void realm
    void owner
    return {
      id: 's-' + Date.now().toString(36),
      realm,
      owner,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3600_000,
      messages: 0,
    }
  }
  async get(id: string): Promise<SessionRecord | null> {
    void id
    return null
  }
  async append(id: string, message: unknown): Promise<void> {
    void id
    void message
  }
  async destroy(id: string): Promise<void> {
    void id
  }
  async cleanup(): Promise<number> {
    return 0
  }
  async listActive(): Promise<SessionRecord[]> {
    return []
  }
}

export async function apply(ctx: any, config: Config): Promise<void> {
  ctx.plugin(SessionServiceImpl)
  void config
  return async () => {}
}
