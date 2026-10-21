/**
 * file-logger — M6 durable file exporter for Cordis `ctx.logger`.
 *
 * DSH host does not ship a service logger (`dsh --help` has no `--log-file`),
 * and Cordis's LoggerService only installs an in-memory ring buffer (1000
 * entries). Without an external exporter every `ctx.logger.info(...)` call
 * lands in that buffer and is lost on exit. We register a file exporter so
 * every dsh-edge-agent plugin's log output is durably persisted to disk,
 * rotated on size, and tail-able for offline troubleshooting.
 *
 * Cordis `export()` contract is **strictly synchronous** (see
 * `@deepseek-ai/cordis@4.0.1/src/logger.ts:46`; the loop at `:154-159`
 * does not await) — the only safe pattern is to synchronously push the
 * formatted line into an in-memory queue, then let a background
 * `setInterval().unref()` flush the queue to disk. The audit-log plugin
 * uses the same pattern (`audit-log.ts:147-152`).
 *
 * Loop avoidance: `export()` must NEVER call `ctx.logger.error(...)` —
 * audit-log's own diagnostics already do (`audit-log.ts:266/309`), and a
 * failure here would re-enter our own `export()` and spin. Failures are
 * swallowed silently and counted; a stderr notice is emitted on the first
 * drop and every 1000th drop after that.
 *
 * Append-mode (`fs.open(path, 'a')`) means each process boot appends to
 * the existing file instead of truncating it, so install.sh's truncate-on-
 * restart semantics are no longer in play — dsh-edge-agent's own writer
 * owns the file lifecycle.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * OPERATIONS / AUDIT CHANNEL DISCIPLINE  (2026-09-01)
 * ═══════════════════════════════════════════════════════════════════════
 * Two log channels. They serve different consumers. Do not blur them.
 *
 *  ┌─ OPERATIONS LOG ──────────────────────────────────────────────────┐
 *  │ Path:   ~/.dsh-edge-agent/log/dsh-edge-agent.log (this file)      │
 *  │ Source: every `ctx.logger.{info,warn,error,debug}` call           │
 *  │ Rule:   **info / warn / error entries MUST NOT contain request    │
 *  │         bodies, response bodies, tool arguments, prompt text,    │
 *  │         or any user PII.** Only metadata (provider, model,        │
 *  │         reqId, durationMs, counts) and error diagnostics.         │
 *  │                                                                   │
 *  │         **debug entries MAY carry LLM call bodies** (request     │
 *  │         messages + response text) for offline triage — opt-in    │
 *  │         via `DSH_EDGE_LOG_LEVEL=debug`. 2026-09-11 default       │
 *  │         flipped from `debug` to `info` (users said log was too   │
 *  │         noisy — every LLM call landed 4 body lines). Re-enable   │
 *  │         with `DSH_EDGE_LOG_LEVEL=debug`. CLOUD prompts are       │
 *  │         pre-sanitized by input-guard before egress, so the       │
 *  │         captured prompt is already placeholder-text for         │
 *  │         sensitive spans. CLOUD response text is NOT redacted.   │
 *  │         Call sites: cloud-llm-adapter.ts, local-llm-adapter.ts.  │
 *  │         Used by operators to triage service flow, failures, and  │
 *  │         LLM call replay.                                         │
 *  └───────────────────────────────────────────────────────────────────┘
 *
 *  ┌─ AUDIT LOG ───────────────────────────────────────────────────────┐
 *  │ Path:   ~/.dsh-edge-agent/audit/audit.plain.jsonl                 │
 *  │ Source: every `auditLog.log({...})` call — explicit, opt-in       │
 *  │ Rule:   **Records the actual call content** (provider, model,     │
 *  │         promptLen, messageCount, toolName, redacted args,         │
 *  │         durationMs). Fields are PII-redacted via                  │
 *  │         `pii-utils.redactObject()` before write. Used by          │
 *  │         compliance / legal / security review.                     │
 *  └───────────────────────────────────────────────────────────────────┘
 *
 * Concretely: every existing `ctx.logger.info(...)` call in dsh-edge-agent
 * carries only metadata. **Before adding a new ctx.logger call**, confirm
 * it does not embed any of: `messages`, `args` (tool args), `promptText`,
 * response bodies, session content, or user-supplied strings. If you need
 * to log that data, route it through `auditLog.log(...)` so it lands in
 * the audit JSONL with field-level redaction, NOT here.
 *
 * Wiring (2026-09-01): file-logger is registered as a standalone Cordis
 * plugin id (`profiles/dsh-edge-agent/cordis.patch.yml`) so its apply()
 * runs at boot — before audit-log / http-api / etc. The disabled
 * aggregator `dsh-edge-agent` (see cordis.patch.yml:26-29) means the
 * internal `src/dsh-adapter/index.ts:apply()` is never invoked, so we
 * can't rely on it to install the exporter. Each plugin id in the patch
 * is loaded independently via its `name:` field.
 *
 * @module dsh-edge-agent/file-logger
 */

import type { Context, Message } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { mkdir, open, stat } from 'node:fs/promises'
import { renameWithRetry } from './local-storage.js'
import { loadEdgeConfig } from './edge-config.js'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'

export const name = 'file-logger'

// 2026-09-02: inject `web` so the boot diagnostic at installFileLogger()
// can read `ctx.web.searchProviders.size` without Cordis throwing
// `cannot get property "web" without inject`. file-logger itself does
// not use the service; only the diagnostic does.
export const inject = ['web'] as const

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** Numeric Cordis logger level (mirrors @deepseek-ai/cordis/src/logger.ts:22-27). */
const LEVEL_NUMERIC: Record<LogLevel, number> = {
  error: 0,
  info: 1,
  warn: 2,
  debug: 3,
}

/** Reverse lookup for `resolveLoggerConfig` env validation. */
function parseLogLevel(value: string | undefined, fallback: LogLevel = 'info'): LogLevel {
  if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') return value
  return fallback
}

export interface Config {
  /** Directory holding the log file. Created if missing. */
  root: string
  /** Filename inside `root` for the persistent log. */
  filename: string
  /** Background flush cadence in ms. */
  flushIntervalMs: number
  /** In-memory queue cap; oldest entry is dropped on overflow. */
  queueCapacity: number
  /** Rotate log when file exceeds this size (bytes). 0 = disabled. */
  maxFileSizeBytes: number
  /**
   * Calendar-day rotation: rotate when the file's last-write day is at
   * least this many local calendar days before today. `1` = daily
   * rotation (first flush after midnight moves the old file to `.1`).
   * `0` = disabled.
   *
   * §7.56 (2026-09-15): previously this compared elapsed `now - mtime`,
   * which NEVER fires for an active append-mode log — continuous writes
   * keep mtime at "moments ago", so `ageDays ≈ 0` forever (the shipped
   * `maxFileAgeDays: 0` masked the dead branch). Calendar-day diff works
   * for continuously-written files: at the first flush of a new day the
   * mtime's date is yesterday, so dayDiff ≥ 1 triggers the rotation.
   */
  maxFileAgeDays: number
  /** Maximum number of rotated files to keep. */
  maxRotatedFiles: number
  /**
   * Minimum logger level emitted to disk. 2026-09-11: default flipped
   * from `debug` back to `info` (per user feedback "log 太冗余") so the
   * LLM body debug calls in `cloud-llm-adapter.ts` /
   * `local-llm-adapter.ts` (LLM_REQUEST / LLM_MESSAGES / LLM_RESPONSE
   * / LLM_RESPONSE_TEXT) are filtered by Cordis and don't reach the
   * ops log. Set `DSH_EDGE_LOG_LEVEL=debug` to re-enable body capture
   * for offline triage. Previously flipped 2026-09-02 info→debug; see
   * PROGRESS §7.23 for the original flip.
   */
  level: LogLevel
}

// §7.102 "one config file": root/level/maxFileAgeDays/maxRotatedFiles carry
// NO Schema default — resolveLoggerConfig()/apply() fill them from
// config/edge.json (audit.*) with the env params as per-process overrides.
// (The old Schema default maxRotatedFiles=5 also silently disagreed with
// the shipped value 7 — defaults living in two places always drift.)
export const Config: Schema<Config> = Schema.object({
  root: Schema.string(),
  filename: Schema.string().default('dsh-edge-agent.log'),
  flushIntervalMs: Schema.natural().default(1000),
  queueCapacity: Schema.natural().default(10_000),
  maxFileSizeBytes: Schema.natural().default(50 * 1024 * 1024), // 50MB
  maxFileAgeDays: Schema.number(), // §7.56: daily rotation by default
  maxRotatedFiles: Schema.natural(),
  level: Schema.union(['debug', 'info', 'warn', 'error'] as const),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    fileLogger: FileLoggerServiceImpl
  }
}

/**
 * Singleton service exposed on `ctx.fileLogger`. Owns the in-memory queue
 * and the background flush loop. The Cordis exporter callback installed
 * by `installFileLogger` simply forwards to `export()` on this service.
 */
export class FileLoggerServiceImpl extends Service {
  private readonly filePath: string
  private readonly flushIntervalMs: number
  private readonly queueCapacity: number
  private readonly maxFileSizeBytes: number
  private readonly maxFileAgeDays: number
  private readonly maxRotatedFiles: number

  /** Formatted lines waiting to be flushed to disk. */
  private queue: string[] = []
  /** Number of entries dropped because `queue` was full. */
  private droppedCount = 0
  /** Monotonically increasing serial so we can debug dropped-entry runs. */
  private flushSerial = 0
  private flushTimer: ReturnType<typeof setInterval> | undefined
  private flushPromise: Promise<void> = Promise.resolve()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'fileLogger')
    this.filePath = join(config.root, config.filename)
    this.flushIntervalMs = config.flushIntervalMs
    this.queueCapacity = config.queueCapacity
    this.maxFileSizeBytes = config.maxFileSizeBytes
    this.maxFileAgeDays = config.maxFileAgeDays
    this.maxRotatedFiles = config.maxRotatedFiles
  }

  /** Test helper returning the resolved log file path. */
  filePathForTests(): string {
    return this.filePath
  }

  /** Test helper: how many entries have been dropped because the queue was full. */
  droppedCountForTests(): number {
    return this.droppedCount
  }

  /** Start the periodic flush; idempotent. Call once from `installFileLogger`. */
  start(): void {
    if (this.flushTimer !== undefined) return
    this.flushTimer = setInterval(() => {
      void this.flush().catch(() => { /* swallow — never call ctx.logger here */ })
    }, this.flushIntervalMs)
    // unref so the timer never holds the process open by itself.
    if (typeof this.flushTimer.unref === 'function') this.flushTimer.unref()
  }

  /** Stop the periodic flush; for tests and the dispose hook. */
  stop(): void {
    if (this.flushTimer !== undefined) {
      clearInterval(this.flushTimer)
      this.flushTimer = undefined
    }
  }

  /**
   * Cordis exporter callback. **Synchronous, no await**. Push the
   * formatted line onto the queue; the background timer drains it.
   *
   * NEVER call `this.ctx.logger.*` from here — audit-log does that on
   * its own errors (`audit-log.ts:266/309`), which would re-enter this
   * method and spin the loop. We swallow everything silently and count
   * drops; a one-shot stderr notice flags the first drop and every
   * 1000th drop after.
   */
  export(message: Message): void {
    try {
      const line = formatLine(message)
      if (this.queue.length >= this.queueCapacity) {
        this.queue.shift() // drop oldest
        this.droppedCount++
        if (this.droppedCount === 1 || this.droppedCount % 1000 === 0) {
          // Direct stderr write — bypasses ctx.logger to avoid re-entry.
          process.stderr.write(
            `[file-logger] dropped ${this.droppedCount} entries (queue full, capacity=${this.queueCapacity})\n`,
          )
        }
      }
      this.queue.push(line)
    } catch {
      // Intentionally empty — see method-level comment about loop avoidance.
    }
  }

  /**
   * Drain the queue to disk. Serialised through `flushPromise` so
   * overlapping calls (timer + dispose) don't interleave writes.
   *
   * Uses `fs.open(path, 'a')` rather than audit-log's read-merge-write
   * pattern — there is no upstream reader modifying the file, so
   * append-at-the-tail is sufficient.
   */
  async flush(): Promise<void> {
    if (this.queue.length === 0) return
    this.flushPromise = this.flushPromise.then(async () => {
      // Snapshot the queue once; subsequent `export()` calls accumulate
      // into the next batch. splice() returns the drained lines in order.
      const drained = this.queue.splice(0, this.queue.length)
      if (drained.length === 0) return
      const serial = ++this.flushSerial
      try {
        await mkdir(dirname(this.filePath), { recursive: true })
        await this.checkAndRotate()
        const payload = drained.join('')
        const fd = await open(this.filePath, 'a')
        try {
          await fd.write(payload)
        } finally {
          await fd.close()
        }
      } catch {
        // Swallow — never call ctx.logger. Best-effort persistence.
        process.stderr.write(`[file-logger] flush #${serial} failed for ${drained.length} lines\n`)
      }
    })
    return this.flushPromise
  }

  /**
   * Size + age based rotation. Copied from audit-log's
   * `checkAndRotate` (`audit-log.ts:278-311`) — the algorithm is the same
   * but this exporter has no read-merge-write coupling, so we only rotate
   * here (audit-log couples rotation with its write path).
   */
  private async checkAndRotate(): Promise<void> {
    if (!existsSync(this.filePath)) return
    try {
      const stats = await stat(this.filePath)
      // §7.56: calendar-day diff in LOCAL time (matches formatLocalIso's
      // timestamp policy — "one day" is the operator's wall clock day, not
      // a UTC day). The previous elapsed-time form (`now - mtime`) never
      // fired for an active append-mode log because every write refreshes
      // mtime to "moments ago".
      const dayDiff = localDayIndex(new Date()) - localDayIndex(new Date(stats.mtimeMs))
      const needsRotation =
        (this.maxFileSizeBytes > 0 && stats.size >= this.maxFileSizeBytes) ||
        (this.maxFileAgeDays > 0 && dayDiff >= this.maxFileAgeDays)
      if (!needsRotation) return

      // Shift .N → .N+1, then current → .1. Highest index first so we
      // never overwrite a file we still need to move.
      for (let i = this.maxRotatedFiles; i >= 1; i--) {
        const from = i === 1 ? this.filePath : `${this.filePath}.${i - 1}`
        const to = `${this.filePath}.${i}`
        if (existsSync(from)) {
          await renameWithRetry(from, to)
        }
      }
      // Delete files beyond the keep window.
      const oldest = `${this.filePath}.${this.maxRotatedFiles + 1}`
      if (existsSync(oldest)) {
        const { rm } = await import('node:fs/promises')
        await rm(oldest, { force: true })
      }
    } catch {
      // Rotation failure must not block the flush path — swallow.
    }
  }
}

/**
 * Format a Cordis Message as one physical line:
 *   `<iso-ts> <LEVEL> [<plugin-name>] <message>\n`
 *
 * Mirrors the format the previous stdout exporter used
 * (`src/dsh-adapter/index.ts:80-88` before Step 1.5), so operator grep
 * habits (`grep '\[http-api\]' ~/.dsh-edge-agent/log/...`) carry over.
 *
 * Timestamp policy (§7.30): local-time ISO 8601 with numeric offset
 * (e.g. `2026-09-03T09:41:30.824+08:00`), NOT `toISOString()` UTC `Z`.
 * Operators in Asia/Shanghai tailing the ops log need wall-clock matches
 * with their chat logs and `date` output. Epoch value is unchanged —
 * any reader (jq, awk, datalog) can still parse the absolute moment.
 * The audit log keeps epoch ms (machine-only schema; no human readers).
 *
 * Newlines inside an Error's `stack` are escaped to `⏎` so each log
 * entry stays a single physical line; without this, a thrown Error
 * spreads across 5-10 stack frames and `split('\n').filter(Boolean)`
 * downstream counts them as separate entries, breaking rotation
 * arithmetic and grep counts.
 */
/**
 * Calendar-day index in the system's LOCAL timezone: whole days since the
 * epoch as seen from local wall-clock time. Only differences between two
 * indexes are meaningful (`dayDiff >= maxFileAgeDays`). Using local
 * components keeps day boundaries aligned with the log's own local ISO
 * timestamps (§7.30 policy), so rotation happens at the operator's
 * midnight, not UTC midnight.
 */
function localDayIndex(d: Date): number {
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000)
}

function formatLocalIso(d: Date): string {
  // Manual ISO 8601 in system TZ with offset, since `toISOString()` is
  // hardcoded UTC and `Intl.DateTimeFormat` is locale-aware (varies by
  // runtime). getXxx() methods on Date already use system local time.
  // getTimezoneOffset returns minutes WEST of UTC; flip sign so positive
  // offsets are east of UTC (ISO convention).
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0')
  const padMs = (n: number): string => String(n).padStart(3, '0')
  const offsetMin = -d.getTimezoneOffset()
  const sign = offsetMin >= 0 ? '+' : '-'
  const absMin = Math.abs(offsetMin)
  const offH = pad(Math.floor(absMin / 60))
  const offM = pad(absMin % 60)
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `.${padMs(d.getMilliseconds())}${sign}${offH}:${offM}`
  )
}

function formatLine(message: Message): string {
  const ts = formatLocalIso(new Date(message.ts))
  const type = message.type.toUpperCase().padEnd(5)
  const args = message.args ?? []
  const head = args[0] instanceof Error
    ? (args[0].stack || args[0].message)
    : String(args[0] ?? '')
  const tail = args.slice(1)
    .map((a) => (a instanceof Error ? a.message : String(a)))
    .join(' ')
  const line = tail.length > 0 ? `${head} ${tail}` : head
  // Collapse internal newlines (mainly from Error.stack frames) so each
  // entry is exactly one physical line. `⏎` is a visible marker that
  // round-trips cleanly through `tail -F` and grep.
  return `${ts} ${type} [${message.name}] ${line.replace(/\r?\n/g, ' ⏎ ')}\n`
}

/** Resolved config used by `installFileLogger`. Pure data, easy to mock. */
export interface ResolvedLoggerConfig {
  root: string
  filename: string
  flushIntervalMs: number
  queueCapacity: number
  maxFileSizeBytes: number
  maxFileAgeDays: number
  maxRotatedFiles: number
  level: LogLevel
}

/**
 * Resolve the file-logger config from env vars with sensible defaults.
 * Centralised here so tests can call it directly and `installFileLogger`
 * stays a one-liner.
 *
 * Path resolution: `DSH_EDGE_LOG_ROOT` wins, then `USERPROFILE` (Windows),
 * then `HOME` (POSIX). File name is fixed (`dsh-edge-agent.log`) so
 * operators always know what file to tail.
 *
 * Level resolution: `DSH_EDGE_LOG_LEVEL` wins, otherwise `info`. The
 * `info` default (2026-09-11, flipped from `debug` per user feedback
 * "log 太冗余") suppresses LLM body debug calls in
 * `cloud-llm-adapter.ts` / `local-llm-adapter.ts` — set
 * `DSH_EDGE_LOG_LEVEL=debug` to re-enable.
 */
export function resolveLoggerConfig(env: NodeJS.ProcessEnv = process.env): ResolvedLoggerConfig {
  // §7.102 layering (per field): explicit env param entry > config/edge.json
  // `audit.*` (loadEdgeConfig also folds live DSH_EDGE_* env into the file
  // view) > the literal below. The env-param layer keeps the unit tests'
  // fake-env surface working; the file layer is what the desktop GUI finally
  // gets when no env is exported.
  const a = loadEdgeConfig(true).audit ?? {}
  const homeBase = (env.USERPROFILE ?? env.HOME ?? '').toString()
  const root = firstNonEmpty(env.DSH_EDGE_LOG_ROOT, a.logRoot)
    ?? join(homeBase, '.dsh-edge-agent', 'log')
  // §7.56: daily rotation is the default (maxFileAgeDays=1). Override with
  // DSH_EDGE_LOG_MAX_AGE_DAYS (0 disables age rotation, keeping size-only).
  const ageDaysEnv = parseInt(env.DSH_EDGE_LOG_MAX_AGE_DAYS ?? '', 10)
  const rotatedEnv = parseInt(env.DSH_EDGE_LOG_MAX_ROTATED ?? '', 10)
  return {
    root,
    filename: 'dsh-edge-agent.log',
    flushIntervalMs: 1000,
    queueCapacity: 10_000,
    maxFileSizeBytes: 50 * 1024 * 1024,
    maxFileAgeDays: Number.isFinite(ageDaysEnv) && ageDaysEnv >= 0
      ? ageDaysEnv
      : a.logMaxAgeDays ?? 1,
    maxRotatedFiles: Number.isFinite(rotatedEnv) && rotatedEnv > 0
      ? rotatedEnv
      : a.logMaxRotated ?? 7,
    level: parseLogLevel(env.DSH_EDGE_LOG_LEVEL ?? a.logLevel, 'info'),
  }
}

/** First non-empty string among the candidates, else undefined. */
function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.length > 0) return v
  }
  return undefined
}

/**
 * Install the file exporter on a fresh Cordis context. Called once at
 * the very top of `apply()` (`src/dsh-adapter/index.ts`) before any
 * other plugin can call `ctx.logger.*`.
 *
 * Gating:
 *   - `DSH_EDGE_LOG_FILE=false` disables (tests opt out).
 *   - First-wins: if the host already registered an exporter, skip —
 *     prevents double-writing when DSH eventually ships its own file
 *     logger. Detected via `ctx.logger.exporters.size > 1` (Cordis's
 *     default ring-buffer exporter occupies slot 1).
 *
 * Returns the service for tests; returns `undefined` when skipped so
 * callers know not to register dispose hooks.
 */
export function installFileLogger(
  ctx: Context,
  resolved?: ResolvedLoggerConfig,
): FileLoggerServiceImpl | undefined {
  if (process.env.DSH_EDGE_LOG_FILE === 'false') return undefined
  if (ctx.logger.exporters.size > 1) return undefined

  const config = resolved ?? resolveLoggerConfig()
  const service = new FileLoggerServiceImpl(ctx, config)
  service.start()
  // 2026-09-02 diagnostic: dump the web seam provider registry once boot
  // settles. The "configured web provider deepseek-official is not
  // registered" error we hit on `web_search` tool calls means
  // web-search-deepseek's `apply()` never ran its
  // `ctx.web.registerSearchProvider(...)` line — either because its
  // `inject: ['web']` dep wasn't satisfied, or because
  // `installSettingsSection` threw first. Knowing which one at boot saves
  // a 90s chat round-trip. Deferred via setImmediate so every plugin's
  // `apply()` has run before we read the registry; `ctx.inject` callbacks
  // only fire when their deps are live, so the loader must settle first.
  setImmediate(() => {
    try {
      const web = (ctx as unknown as { web?: { searchProviders?: Map<string, unknown> } }).web
      const map = web?.searchProviders
      const size = map instanceof Map ? map.size : -1
      const ids = map instanceof Map ? [...map.keys()].join(',') : 'n/a'
      ctx.logger?.info?.(`[web-diag] ctx.web registered=${web !== undefined} searchProviders.size=${size} ids=[${ids}]`)
    } catch (err: any) {
      ctx.logger?.warn?.(`[web-diag] failed: ${err?.message ?? String(err)}`)
    }
  })
  // Bind the export callback to the service instance. Cordis calls this
  // synchronously from inside its logger loop — never invoke ctx.logger
  // from inside (would re-enter and loop).
  //
  // 2026-09-02: pass `levels: { default: <numeric> }` so the file-logger
  // receives all messages at-or-above the configured threshold. Without
  // this, Cordis's per-exporter level defaults to INFO and silently
  // suppresses every `ctx.logger.debug(...)` call — including the LLM
  // body debug calls in cloud-llm-adapter.ts / local-llm-adapter.ts.
  // Cordis's own ring-buffer exporter keeps its hard-coded INFO level so
  // the in-memory buffer stays tight while disk captures everything.
  ctx.logger.exporter({
    export: (msg: Message): void => service.export(msg),
    levels: { default: LEVEL_NUMERIC[config.level] },
  })
  return service
}

/**
 * Stop the flush timer and drain the queue. Wired into the apply()
 * dispose hook in `index.ts` so a clean shutdown loses at most one
 * interval's worth of logs.
 */
export async function shutdownFileLogger(service: FileLoggerServiceImpl | undefined): Promise<void> {
  if (!service) return
  service.stop()
  await service.flush()
}

/**
 * Standard Cordis plugin apply — installs the file exporter on first
 * load and returns a disposer that drains the queue on shutdown.
 *
 * Wired into repo-root `cordis.patch.yml` (per §7.25 + §7.31 — bundle is
 * self-contained) as a standalone plugin id `file-logger` so this runs
 * at boot, before any other dsh-edge-agent plugin (audit-log / http-api /
 * etc.) emits log lines.
 *
 * Idempotency: `installFileLogger` already has a first-wins guard via
 * `ctx.logger.exporters.size > 1`. Calling it twice is a no-op.
 */
export async function apply(ctx: Context, config: Config): Promise<() => Promise<void>> {
  // §7.102: the cordis row may omit root/level/rotation fields (the patches
  // no longer pass env expressions). Layer: explicit row value >
  // resolveLoggerConfig() (= config/edge.json audit.* > env > literal).
  const base = resolveLoggerConfig() as unknown as Config
  const row = config as Partial<Config>
  const pick = <K extends keyof Config>(k: K): Config[K] => (row[k] === undefined ? base[k] : row[k] as Config[K])
  const effective: Config = {
    root: pick('root'),
    filename: pick('filename'),
    flushIntervalMs: pick('flushIntervalMs'),
    queueCapacity: pick('queueCapacity'),
    maxFileSizeBytes: pick('maxFileSizeBytes'),
    maxFileAgeDays: pick('maxFileAgeDays'),
    maxRotatedFiles: pick('maxRotatedFiles'),
    level: pick('level'),
  }
  const service = installFileLogger(ctx, effective)
  return async () => {
    await shutdownFileLogger(service)
  }
}