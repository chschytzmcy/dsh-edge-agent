/**
 * audit-log — M3 PLAINTEXT append-only log with an in-memory ring buffer.
 * Each entry is one JSON line:
 *   { ts, level, kind, source, payload }
 *
 * Phase 2 增强：
 * - 敏感字段自动脱敏（手机号、身份证、银行卡、邮箱、API Key）
 * - 日志轮转（按大小/时间）
 *
 * M3 NOTE — A3 swaps the on-disk format for HMAC-chained tamper-evident
 * entries; the public surface (log / query / getSecurityReport) is the
 * durable contract.
 *
 * @module dsh-edge-agent/audit-log
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { redactObject } from './pii-utils.js'
import { renameWithRetry } from './local-storage.js'

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

/**
 * Calendar-day index in the system's LOCAL timezone (§7.56). Only diffs
 * between two indexes are meaningful. Mirrors file-logger.ts's helper —
 * kept local to this module so audit-log has no import dependency on the
 * logger plugin (both already duplicate the rotation algorithm by design).
 */
function localDayIndex(d: Date): number {
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000)
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
  /** Enable PII redaction in payload fields. */
  enablePIIRedaction: boolean
  /** Rotate log when file exceeds this size (bytes). 0 = disabled. */
  maxFileSizeBytes: number
  /** Rotate log when file age exceeds this (days). 0 = disabled. */
  maxFileAgeDays: number
  /** Maximum number of rotated files to keep. */
  maxRotatedFiles: number
}

export const Config: Schema<Config> = Schema.object({
  minLevel: Schema.union(['debug', 'info', 'warn', 'error', 'security'] as const).default('info'),
  ringBufferSize: Schema.natural().default(512),
  flushIntervalMs: Schema.natural().default(1000),
  filename: Schema.string().default('audit.plain.jsonl'),
  root: Schema.string().required(),
  enablePIIRedaction: Schema.boolean().default(true),
  maxFileSizeBytes: Schema.natural().default(10 * 1024 * 1024), // 10MB
  maxFileAgeDays: Schema.number().default(7),
  maxRotatedFiles: Schema.natural().default(5),
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

/** Live listener over freshly recorded entries. Fired synchronously after
 *  the ring-buffer push (so unflushed entries are visible), before the
 *  disk write — the §7.101 seam that lets `edge-context-view` fold panel
 *  state without polling `query()` (which re-reads the whole file). */
export type AuditEntryListener = (entry: AuditEntry) => void

export interface AuditLogService {
  log(entry: Omit<AuditEntry, 'ts'> & { ts?: number }): Promise<void>
  query(filter: AuditQuery): Promise<AuditEntry[]>
  getSecurityReport(): Promise<SecurityReport>
  /** Manually trigger a disk flush; mostly for tests. */
  flush(): Promise<void>
  /** Subscribe to live entries; returns an unsubscribe function.
   *  Listener faults are caught — they can never break the audit path. */
  onEntry(listener: AuditEntryListener): () => void
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
  private readonly enablePIIRedaction: boolean
  private readonly maxFileSizeBytes: number
  private readonly maxFileAgeDays: number
  private readonly maxRotatedFiles: number
  private ringBuffer: AuditEntry[] = []
  /** Index of the first entry in ringBuffer that has NOT yet been flushed. */
  private flushIndex = 0
  private flushTimer: ReturnType<typeof setInterval> | undefined
  private dirty = false
  private flushPromise: Promise<void> = Promise.resolve()
  private readonly entryListeners = new Set<AuditEntryListener>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'auditLog')
    this.filePath = join(config.root, config.filename)
    this.minLevel = config.minLevel
    this.ringBufferSize = config.ringBufferSize
    this.flushIntervalMs = config.flushIntervalMs
    this.enablePIIRedaction = config.enablePIIRedaction
    this.maxFileSizeBytes = config.maxFileSizeBytes
    this.maxFileAgeDays = config.maxFileAgeDays
    this.maxRotatedFiles = config.maxRotatedFiles
  }

  /** Test/apply helper that returns the audit log's current file path. */
  filePathForTests(): string {
    return this.filePath
  }

  /** §7.101 live seam: subscribe to freshly recorded entries. The returned
   *  function unsubscribes. Delivery is synchronous after the ring push;
   *  a throwing listener is isolated (the audit path is privacy-critical,
   *  a viewer fault must never affect it — same fail-open discipline as
   *  TdBusServiceImpl.on). */
  onEntry(listener: AuditEntryListener): () => void {
    this.entryListeners.add(listener)
    return () => { this.entryListeners.delete(listener) }
  }

  private notifyEntryListeners(record: AuditEntry): void {
    if (this.entryListeners.size === 0) return
    for (const listener of [...this.entryListeners]) {
      try { listener(record) } catch { /* viewer faults never break the audit path */ }
    }
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
    // Apply PII redaction to payload if enabled
    let payload = entry.payload
    if (this.enablePIIRedaction) {
      payload = redactObject(entry.payload).redacted as Record<string, unknown>
    }
    const record: AuditEntry = {
      ts: entry.ts ?? Date.now(),
      level: entry.level,
      kind: entry.kind,
      source: entry.source,
      payload,
    }
    // Verify lossless JSON up front so a non-serializable payload never
    // wedges the flush path. `session.event` payloads are derived from the
    // session log (already JSON-validated by dsh-session), but defensively
    // double-check; one bad entry would otherwise break the whole flush.
    try {
      JSON.stringify(record)
    } catch (err) {
      this.ctx.logger?.error?.(`[audit-log] dropping non-JSON entry kind=${entry.kind} source=${entry.source} err=${(err as Error).message}`)
      return
    }
    this.ringBuffer.push(record)
    if (this.ringBuffer.length > this.ringBufferSize) {
      this.ringBuffer.shift()
      // Keep flushIndex aligned with the buffer: an entry was dropped from
      // the front, so the "first unflushed" boundary shifts back by one.
      this.flushIndex = Math.max(0, this.flushIndex - 1)
    }
    this.dirty = true
    this.notifyEntryListeners(record)
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
      // Only flush the [flushIndex..length) slice — never re-write entries
      // already on disk.
      const start = this.flushIndex
      const end = this.ringBuffer.length
      if (start >= end) {
        this.dirty = false
        return
      }
      const toWrite = this.ringBuffer.slice(start, end)
      if (toWrite.length === 0) {
        this.dirty = false
        return
      }
      await mkdir(dirname(this.filePath), { recursive: true })
      // Check if rotation is needed before writing
      await this.checkAndRotate()
      const prev = existsSync(this.filePath) ? await readFile(this.filePath, 'utf-8') : ''
      try {
        const lines = toWrite.map((e) => JSON.stringify(e)).join('\n') + '\n'
        const next = prev + lines
        const tmp = `${this.filePath}.tmp-${process.pid}`
        await writeFile(tmp, next, 'utf-8')
        await renameWithRetry(tmp, this.filePath)
        this.flushIndex = end
        this.dirty = false
      } catch (err) {
        // A single non-serializable entry would otherwise pin the buffer
        // forever and stop every subsequent flush. Drop the batch and report;
        // log() already pre-validates JSON so this is a belt-and-braces guard.
        this.ctx.logger?.error?.(`[audit-log] flush failed, dropping ${toWrite.length} entries: ${(err as Error).message}`)
        this.flushIndex = end
        this.dirty = false
      }
    })
    return this.flushPromise
  }

  /**
   * Check if the current log file needs rotation (by size or age).
   * If yes, rotate: current → .1, .1 → .2, ..., delete oldest beyond maxRotatedFiles.
   */
  private async checkAndRotate(): Promise<void> {
    if (!existsSync(this.filePath)) return

    try {
      const stats = await stat(this.filePath)
      // §7.56 (2026-09-15): calendar-day diff (local time), replacing the
      // elapsed-time form `now - mtime`. Same bug as file-logger: an active
      // append-mode log refreshes mtime on every flush, so elapsed age was
      // always ≈ 0 and the configured `maxFileAgeDays: 7` never fired.
      // Day-index diff rotates on the first flush of a new calendar day
      // once the file is ≥ maxFileAgeDays days old by wall clock.
      const dayDiff = localDayIndex(new Date()) - localDayIndex(new Date(stats.mtimeMs))

      const needsRotation =
        (this.maxFileSizeBytes > 0 && stats.size >= this.maxFileSizeBytes) ||
        (this.maxFileAgeDays > 0 && dayDiff >= this.maxFileAgeDays)

      if (!needsRotation) return

      // Rotate: shift .N → .N+1, then current → .1
      for (let i = this.maxRotatedFiles; i >= 1; i--) {
        const from = i === 1 ? this.filePath : `${this.filePath}.${i - 1}`
        const to = `${this.filePath}.${i}`
        if (existsSync(from)) {
          await renameWithRetry(from, to)
        }
      }

      // Delete files beyond maxRotatedFiles
      const oldest = `${this.filePath}.${this.maxRotatedFiles + 1}`
      if (existsSync(oldest)) {
        await import('node:fs/promises').then((fs) => fs.rm(oldest, { force: true }))
      }
    } catch (err) {
      // Rotation failure should not block flushing
      this.ctx.logger?.error?.(`[audit-log] rotation failed: ${(err as Error).message}`)
    }
  }

  /** Read every entry from disk; used by query() to span past the ring buffer. */
  private async readAllFromDisk(): Promise<AuditEntry[]> {
    const disk = await this.readDiskEntries()
    // Disk already holds entries [0..flushIndex); only merge the unflushed
    // tail [flushIndex..length) of the ring buffer to avoid duplicates.
    const unflushed = this.ringBuffer.slice(this.flushIndex)
    const seen = new Set<number>()
    const merged: AuditEntry[] = []
    for (const e of disk) {
      if (!seen.has(e.ts)) {
        seen.add(e.ts)
        merged.push(e)
      }
    }
    for (const e of unflushed) {
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