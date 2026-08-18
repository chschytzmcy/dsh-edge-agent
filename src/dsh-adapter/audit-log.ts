/**
 * audit-log — M3 PLAINTEXT append-only log with an in-memory ring buffer.
 * Each entry is one JSON line:
 *   { ts, level, kind, source, payload }
 * M3 NOTE — A3 swaps the on-disk format for HMAC-chained tamper-evident
 * entries; the public surface (log / query / getSecurityReport) is the
 * durable contract.
 *
 * @module dsh-edge-agent/audit-log
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const name = 'audit-log'

export const inject = [] as const

export type AuditLevel = 'debug' | 'info' | 'warn' | 'error' | 'security'

const LEVEL_ORDER: Record<AuditLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  security: 50,
}

export interface Config {
  /** Drop entries below this level. */
  minLevel: AuditLevel
  /** Maximum entries kept in memory; older entries still live on disk. */
  ringBufferSize: number
  /** Flush the ring buffer to disk every N ms. */
  flushIntervalMs: number
  /** Filename inside `root` for the persistent log. */
  filename: string
  /** Directory holding the audit log file. Created if missing. */
  root: string
}

export const Config: Schema<Config> = Schema.object({
  minLevel: Schema.union(['debug', 'info', 'warn', 'error', 'security'] as const).default('info'),
  ringBufferSize: Schema.natural().default(512),
  flushIntervalMs: Schema.natural().default(1000),
  filename: Schema.string().default('audit.plain.jsonl'),
  root: Schema.string().required(),
})

export interface AuditEntry {
  ts: number
  level: AuditLevel
  kind: string
  source: string
  payload: Record<string, unknown>
}

export interface AuditQuery {
  level?: AuditLevel
  kind?: string
  source?: string
  sinceMs?: number
  untilMs?: number
  limit?: number
}

export interface SecurityReport {
  totalEntries: number
  levelCounts: Record<AuditLevel, number>
  /** Rate observations: {kind: count-per-minute}. */
  ratePerMinute: Record<string, number>
  recent: AuditEntry[]
}

export interface AuditLogService {
  log(entry: Omit<AuditEntry, 'ts'> & { ts?: number }): Promise<void>
  query(filter: AuditQuery): Promise<AuditEntry[]>
  getSecurityReport(): Promise<SecurityReport>
  /** Manually trigger a disk flush; mostly for tests. */
  flush(): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    auditLog: AuditLogServiceImpl
  }
}

export class AuditLogServiceImpl extends Service {
  private readonly filePath: string
  private readonly minLevel: AuditLevel
  private readonly ringBufferSize: number
  private readonly flushIntervalMs: number
  private ringBuffer: AuditEntry[] = []
  private flushTimer: ReturnType<typeof setInterval> | undefined
  private dirty = false
  private flushPromise: Promise<void> = Promise.resolve()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'auditLog')
    this.filePath = join(config.root, config.filename)
    this.minLevel = config.minLevel
    this.ringBufferSize = config.ringBufferSize
    this.flushIntervalMs = config.flushIntervalMs
  }

  /** Test/apply helper that returns the audit log's current file path. */
  filePathForTests(): string {
    return this.filePath
  }

  /** Start the periodic flush; idempotent. Call once from `apply()`. */
  start(): void {
    if (this.flushTimer !== undefined) return
    this.flushTimer = setInterval(() => {
      void this.flush().catch(() => {})
    }, this.flushIntervalMs)
    // unref so the timer never holds the process open by itself.
    if (typeof this.flushTimer.unref === 'function') this.flushTimer.unref()
  }

  /** Stop the periodic flush; for tests and the main shutdown hook. */
  stopForTests(): void {
    if (this.flushTimer !== undefined) {
      clearInterval(this.flushTimer)
      this.flushTimer = undefined
    }
  }

  async log(entry: Omit<AuditEntry, 'ts'> & { ts?: number }): Promise<void> {
    if (LEVEL_ORDER[entry.level] < LEVEL_ORDER[this.minLevel]) return
    const record: AuditEntry = {
      ts: entry.ts ?? Date.now(),
      level: entry.level,
      kind: entry.kind,
      source: entry.source,
      payload: entry.payload,
    }
    this.ringBuffer.push(record)
    if (this.ringBuffer.length > this.ringBufferSize) {
      this.ringBuffer.shift()
    }
    this.dirty = true
  }

  async query(filter: AuditQuery): Promise<AuditEntry[]> {
    const all = await this.readAllFromDisk()
    let out = all
    if (filter.level) out = out.filter((e) => e.level === filter.level)
    if (filter.kind) out = out.filter((e) => e.kind === filter.kind)
    if (filter.source) out = out.filter((e) => e.source === filter.source)
    if (filter.sinceMs !== undefined) out = out.filter((e) => e.ts >= (filter.sinceMs as number))
    if (filter.untilMs !== undefined) out = out.filter((e) => e.ts <= (filter.untilMs as number))
    if (filter.limit !== undefined && out.length > filter.limit) {
      out = out.slice(out.length - filter.limit)
    }
    return out
  }

  async getSecurityReport(): Promise<SecurityReport> {
    const all = await this.readAllFromDisk()
    const levelCounts: Record<AuditLevel, number> = {
      debug: 0, info: 0, warn: 0, error: 0, security: 0,
    }
    const kindCounts = new Map<string, number>()
    for (const entry of all) {
      levelCounts[entry.level]++
      kindCounts.set(entry.kind, (kindCounts.get(entry.kind) ?? 0) + 1)
    }
    const ratePerMinute: Record<string, number> = {}
    for (const [kind, count] of kindCounts.entries()) {
      // crude approximation: per-minute = count / (window minutes)
      ratePerMinute[kind] = count
    }
    return {
      totalEntries: all.length,
      levelCounts,
      ratePerMinute,
      recent: all.slice(-20),
    }
  }

  async flush(): Promise<void> {
    if (!this.dirty) return
    // Serialise flushes.
    this.flushPromise = this.flushPromise.then(async () => {
      const snapshot = [...this.ringBuffer]
      if (snapshot.length === 0) return
      await mkdir(dirname(this.filePath), { recursive: true })
      const prev = existsSync(this.filePath) ? await readFile(this.filePath, 'utf-8') : ''
      const lines = snapshot.map((e) => JSON.stringify(e)).join('\n') + '\n'
      const next = prev + lines
      const tmp = `${this.filePath}.tmp-${process.pid}`
      await writeFile(tmp, next, 'utf-8')
      await rename(tmp, this.filePath)
      this.dirty = false
    })
    return this.flushPromise
  }

  /** Read every entry from disk; used by query() to span past the ring buffer. */
  private async readAllFromDisk(): Promise<AuditEntry[]> {
    const disk = await this.readDiskEntries()
    // Merge in-memory entries not yet flushed.
    const seen = new Set<number>()
    const merged: AuditEntry[] = []
    for (const e of disk) {
      if (!seen.has(e.ts)) {
        seen.add(e.ts)
        merged.push(e)
      }
    }
    for (const e of this.ringBuffer) {
      if (!seen.has(e.ts)) merged.push(e)
    }
    return merged
  }

  private async readDiskEntries(): Promise<AuditEntry[]> {
    if (!existsSync(this.filePath)) return []
    const raw = await readFile(this.filePath, 'utf-8')
    const out: AuditEntry[] = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      try {
        out.push(JSON.parse(trimmed) as AuditEntry)
      } catch {
        continue
      }
    }
    return out
  }
}

export async function apply(ctx: Context, config: Config): Promise<() => Promise<void>> {
  // AuditLogServiceImpl extends `Service`, so its constructor calls
  // `ctx.reflect.provide('auditLog', this)` for us. Do not call
  // `ctx.provide` again — that would throw "service already registered".
  const service = new AuditLogServiceImpl(ctx, config)
  await mkdir(dirname(service.filePathForTests()), { recursive: true }).catch(() => {})
  service.start()
  return async () => {
    service.stopForTests()
    await service.flush()
  }
}

/**
 * Main-aggregator shutdown hook. Stops the periodic flush and drains
 * any in-memory ring buffer to disk. A3 will replace this with a
 * tamper-evident HMAC finalisation.
 */
export async function auditLogShutdown(ctx: Context): Promise<() => Promise<void>> {
  const svc = (ctx as unknown as { auditLog?: AuditLogServiceImpl }).auditLog
  return async () => {
    if (!svc) return
    svc.stopForTests()
    await svc.flush()
  }
}