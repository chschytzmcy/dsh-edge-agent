/**
 * sessions — M3 PLAINTEXT session store. One session = one KV entry in the
 * `local-storage` collection `sessions`, keyed by `sessionId`. Each value
 * carries the full message list, a creation time, and a lastSeenAt stamp.
 *
 * M3 NOTE — A3 replaces this with an encrypted + indexed store; the
 * service contract (create / appendMessage / getRecentMessages /
 * listActive / cleanup) is the durable shape.
 *
 * @module dsh-edge-agent/sessions
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

import type { LocalStorageServiceImpl } from './local-storage.ts'

export const name = 'sessions'

export const inject = ['localStorage'] as const

export interface Config {
  /** Default TTL in seconds; sessions idle longer than this are eligible for cleanup. */
  defaultTtlSeconds: number
  /** Hard cap on cached sessions; cleanup prunes LRU first. */
  maxConcurrentSessions: number
  /** Filename inside the local-storage root for the sessions collection. */
  collection: string
}

export const Config: Schema<Config> = Schema.object({
  defaultTtlSeconds: Schema.natural().default(3600),
  maxConcurrentSessions: Schema.natural().default(64),
  collection: Schema.string().default('sessions'),
})

export interface SessionMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: unknown
  ts: number
}

export interface SessionRecord {
  id: string
  createdAt: number
  lastSeenAt: number
  ttlSeconds: number
  messages: SessionMessage[]
  /** Optional realm tag (LOCAL / CLOUD / SANITIZED) the session started under. */
  realm?: 'LOCAL' | 'CLOUD' | 'SANITIZED'
}

export interface SessionsService {
  create(input: { id?: string; realm?: SessionRecord['realm']; ttlSeconds?: number }): Promise<SessionRecord>
  appendMessage(id: string, message: SessionMessage): Promise<SessionRecord>
  getRecentMessages(id: string, limit?: number): Promise<SessionMessage[]>
  get(id: string): Promise<SessionRecord | null>
  listActive(): Promise<SessionRecord[]>
  /** Drop sessions idle longer than their TTL; returns the count removed. */
  cleanup(): Promise<number>
  /** Touch lastSeenAt without appending; preserves the TTL window. */
  touch(id: string): Promise<void>
}

// NOTE: declaration merging disabled to avoid conflict with upstream dsh-session's SessionStore.
// The edge-agent's session service is accessed via ctx.get('sessions') instead of ctx.sessions.
// declare module '@deepseek-ai/cordis' {
//   interface Context {
//     sessions: SessionsServiceImpl
//   }
// }

export class SessionsServiceImpl extends Service {
  private readonly collection: string
  private readonly defaultTtlSeconds: number
  private readonly maxConcurrentSessions: number

  constructor(ctx: Context, config: Config) {
    super(ctx, 'sessions')
    this.collection = config.collection
    this.defaultTtlSeconds = config.defaultTtlSeconds
    this.maxConcurrentSessions = config.maxConcurrentSessions
  }

  async create(input: { id?: string; realm?: SessionRecord['realm']; ttlSeconds?: number }): Promise<SessionRecord> {
    const storage = this.storage()
    const now = Date.now()
    const id = input.id ?? `sess_${now}_${Math.random().toString(36).slice(2, 10)}`
    const session: SessionRecord = {
      id,
      createdAt: now,
      lastSeenAt: now,
      ttlSeconds: input.ttlSeconds ?? this.defaultTtlSeconds,
      messages: [],
      realm: input.realm,
    }
    await storage.put(this.collection, id, session)
    return session
  }

  async appendMessage(id: string, message: SessionMessage): Promise<SessionRecord> {
    const storage = this.storage()
    const session = await this.get(id)
    if (!session) {
      throw new Error(`sessions: session "${id}" not found`)
    }
    session.messages.push(message)
    session.lastSeenAt = Date.now()
    await storage.put(this.collection, id, session)
    return session
  }

  async getRecentMessages(id: string, limit?: number): Promise<SessionMessage[]> {
    const session = await this.get(id)
    if (!session) return []
    const slice = limit === undefined ? session.messages : session.messages.slice(-limit)
    return [...slice]
  }

  async get(id: string): Promise<SessionRecord | null> {
    const storage = this.storage()
    const session = await storage.get<SessionRecord>(this.collection, id)
    return session
  }

  async listActive(): Promise<SessionRecord[]> {
    const storage = this.storage()
    const entries = await storage.list(this.collection)
    const now = Date.now()
    const out: SessionRecord[] = []
    for (const { value } of entries) {
      const session = value as SessionRecord
      const ttlMs = session.ttlSeconds * 1000
      if (now - session.lastSeenAt <= ttlMs) out.push(session)
    }
    out.sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    return out
  }

  async touch(id: string): Promise<void> {
    const storage = this.storage()
    const session = await storage.get<SessionRecord>(this.collection, id)
    if (!session) return
    session.lastSeenAt = Date.now()
    await storage.put(this.collection, id, session)
  }

  async cleanup(): Promise<number> {
    const storage = this.storage()
    const entries = await storage.list(this.collection)
    const now = Date.now()
    let removed = 0
    for (const { key, value } of entries) {
      const session = value as SessionRecord
      const ttlMs = session.ttlSeconds * 1000
      if (now - session.lastSeenAt > ttlMs) {
        await storage.delete(this.collection, key)
        removed++
      }
    }
    // Enforce the cap by evicting oldest-by-lastSeenAt.
    const active = await storage.list(this.collection)
    if (active.length > this.maxConcurrentSessions) {
      const sorted = (active
        .map((e) => e.value as SessionRecord)
        .sort((a, b) => a.lastSeenAt - b.lastSeenAt))
      const overflow = sorted.length - this.maxConcurrentSessions
      for (let i = 0; i < overflow; i++) {
        const victim = sorted[i]
        if (victim) {
          await storage.delete(this.collection, victim.id)
          removed++
        }
      }
    }
    return removed
  }

  private storage(): LocalStorageServiceImpl {
    return (this as unknown as { ctx: { localStorage: LocalStorageServiceImpl } }).ctx.localStorage
  }
}

export async function apply(ctx: Context, config: Config): Promise<() => Promise<void>> {
  // SessionsServiceImpl extends `Service`, so its constructor calls
  // `ctx.reflect.provide('sessions', this)` for us. Do not call
  // `ctx.provide` again — that would throw "service already registered".
  void new SessionsServiceImpl(ctx, config)
  return async () => {}
}