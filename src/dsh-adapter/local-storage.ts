/**
 * local-storage — M3 PLAINTEXT key/value store. Each "collection" is an
 * ordered append-only log of `{op, key, value}` JSON lines. Reads project
 * the latest write per key (a compacted view), and writes append a single
 * line. No encryption, no compression, no TCM dependency.
 *
 * Phase 3 增强：存储时对敏感字段自动脱敏（PII redaction），复用 pii-utils。
 *
 * M3 NOTE — A3 replaces this entire file with an encrypted SQLite-backed
 * store. The plugin shape (Service + put/get/delete/list) is the durable
 * contract; the on-disk format is an implementation detail.
 *
 * @module dsh-edge-agent/local-storage
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { mkdir, readFile, appendFile, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { redactObject } from './pii-utils.js'
import { edgeHome, loadEdgeConfig } from './edge-config.js'

export const name = 'local-storage'

export const inject = [] as const

export interface Config {
  /** Directory holding the storage files. Created if missing. */
  root: string
  /** Filename inside `root`. Each line is one log entry. */
  filename: string
  /** Enable PII redaction before writing to disk. */
  enablePIIRedaction: boolean
}

export const Config: Schema<Config> = Schema.object({
  // §7.102 "one config file": root has no required/default — apply() fills
  // it from config/edge.json (storage.root) or ~/.dsh-edge-agent/storage.
  root: Schema.string(),
  filename: Schema.string().default('storage.plain.jsonl'),
  enablePIIRedaction: Schema.boolean().default(true),
})

export interface KVEntry {
  key: string
  value: unknown
}

export interface StorageService {
  get<T = unknown>(collection: string, key: string): Promise<T | null>
  put<T = unknown>(collection: string, key: string, value: T): Promise<void>
  delete(collection: string, key: string): Promise<void>
  list(collection: string): Promise<KVEntry[]>
  /** Drop every entry in one collection; M3-only test/teardown hook. */
  clear(collection: string): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    localStorage: LocalStorageServiceImpl
  }
}

/**
 * JSONL-backed KV store. One file per `Config.filename`; lines are
 * `{op: 'put'|'delete', collection, key, value, ts}` records.
 */
export class LocalStorageServiceImpl extends Service {
  private readonly filePath: string
  private readonly enablePIIRedaction: boolean
  private cache = new Map<string, Map<string, unknown>>()
  private writeQueue: Promise<void> = Promise.resolve()
  private loaded = false

  constructor(ctx: Context, config: Config) {
    super(ctx, 'localStorage')
    this.filePath = join(config.root, config.filename)
    this.enablePIIRedaction = config.enablePIIRedaction
  }

  /** Initial scan; idempotent. M3 calls this once per process. */
  async load(): Promise<void> {
    if (this.loaded) return
    if (!existsSync(this.filePath)) {
      await mkdir(dirname(this.filePath), { recursive: true })
      this.loaded = true
      return
    }
    const raw = await readFile(this.filePath, 'utf-8')
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(trimmed) as Record<string, unknown>
      } catch {
        continue
      }
      const op = parsed.op as string | undefined
      const collection = parsed.collection as string | undefined
      const key = parsed.key as string | undefined
      // clear 记录没有 key — 跳过它会让重启后被 clear 的 collection 复活。
      if (!collection || (!key && op !== 'clear')) continue
      if (op === 'clear') {
        this.cache.set(collection, new Map())
        continue
      }
      const bucket = this.collection(collection)
      if (op === 'delete') bucket.delete(key!)
      else if (op === 'put') bucket.set(key!, parsed.value)
    }
    this.loaded = true
  }

  async get<T = unknown>(collection: string, key: string): Promise<T | null> {
    await this.load()
    const bucket = this.collection(collection)
    const value = bucket.get(key)
    if (value === undefined) return null
    return value as T
  }

  async put<T = unknown>(collection: string, key: string, value: T): Promise<void> {
    await this.load()
    // Apply PII redaction to value before storing
    const storedValue = this.enablePIIRedaction
      ? redactObject(value).redacted
      : value
    this.collection(collection).set(key, storedValue)
    await this.append({ op: 'put', collection, key, value: storedValue, ts: Date.now() })
  }

  async delete(collection: string, key: string): Promise<void> {
    await this.load()
    const bucket = this.collection(collection)
    if (!bucket.delete(key)) return
    await this.append({ op: 'delete', collection, key, ts: Date.now() })
  }

  async list(collection: string): Promise<KVEntry[]> {
    await this.load()
    const bucket = this.collection(collection)
    return [...bucket.entries()].map(([key, value]) => ({ key, value }))
  }

  async clear(collection: string): Promise<void> {
    await this.load()
    this.cache.set(collection, new Map())
    await this.append({ op: 'clear', collection, ts: Date.now() })
  }

  private collection(name: string): Map<string, unknown> {
    let bucket = this.cache.get(name)
    if (!bucket) {
      bucket = new Map()
      this.cache.set(name, bucket)
    }
    return bucket
  }

  /** Append one record; serialized through a tail-of-promise chain.
   *
   * 单行 append（O(1)），不再整读整写（旧的 read-merge-write 让每次
   * put/delete 的成本随历史线性增长）。崩溃一致性：append 中途 crash
   * 最多留半行，load() 的逐行 JSON.parse 会跳过它。
   *
   * 队列防中毒：链内吞掉本次失败并让链继续走 —— 一次磁盘错误（满盘、
   * 权限）曾把 writeQueue 变成永久 rejected，之后所有 put/delete 静默
   * 失效直到重启。失败仍如实抛给当次调用方。 */
  private append(record: Record<string, unknown>): Promise<void> {
    const line = `${JSON.stringify(record)}\n`
    const run = async (): Promise<void> => {
      await mkdir(dirname(this.filePath), { recursive: true })
      await appendFile(this.filePath, line, 'utf-8')
    }
    const result = this.writeQueue.then(run, run)
    this.writeQueue = result.catch(() => {})
    return result
  }
}

/**
 * rename() with a short backoff for EPERM.
 *
 * Windows quirk (observed 2026-10-21 running the suite on the desktop host):
 * right after writeFile closes the handle, the Defender/indexer scan can
 * hold the file open for a few milliseconds — rename() then fails with
 * EPERM even though nothing is logically wrong. The lock clears on its own;
 * POSIX platforms never hit this path (rename is atomic and unblocked).
 * Shared with audit-log / file-logger, whose atomic writes have the same
 * exposure on the Windows desktop deployment.
 */
export async function renameWithRetry(
  from: string,
  to: string,
  attempts = 5,
  baseDelayMs = 20,
): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await rename(from, to)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code
      if (i >= attempts - 1 || code !== 'EPERM' && code !== 'EBUSY' && code !== 'ENOTEMPTY') throw e
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * (i + 1)))
    }
  }
}

export async function apply(ctx: Context, config: Config): Promise<() => Promise<void>> {
  // §7.102: root comes from config/edge.json (storage.root) when the row
  // omits it — the patch no longer carries `!!js HOME` path expressions.
  const c = config as Partial<Config>
  if (c.root === undefined) {
    const fileRoot = loadEdgeConfig().storage?.root
    c.root = fileRoot && fileRoot.length > 0 ? fileRoot : edgeHome('storage')
  }
  // LocalStorageServiceImpl extends `Service`, so its constructor calls
  // `ctx.reflect.provide('localStorage', this)` for us. Do not call
  // `ctx.provide` again — that would throw "service already registered".
  const service = new LocalStorageServiceImpl(ctx, config)
  await service.load()
  return async () => {}
}

/**
 * Main-aggregator shutdown hook. Flushes any pending in-memory state
 * (none today; the JSONL layer writes on every put/delete) and disposes
 * the local-storage service. A3 will replace this body with an
 * encryption-key zeroization step.
 */
export async function storageShutdown(ctx: Context): Promise<() => Promise<void>> {
  const svc = (ctx as unknown as { localStorage?: { dispose?: () => void } }).localStorage
  return async () => {
    svc?.dispose?.()
  }
}