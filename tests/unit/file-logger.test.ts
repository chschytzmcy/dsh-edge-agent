/**
 * file-logger (M6) tests — durable file exporter for `ctx.logger`.
 *
 * Coverage:
 *   1. Plugin shape (name/inject/Config/apply)
 *   2. Basic export/format: formatted line lands in file after flush
 *   3. Size-based rotation: file → .1 when maxFileSizeBytes exceeded
 *   3b. Calendar-day rotation (§7.56): file → .1 across a local day
 *       boundary when maxFileAgeDays ≥ 1; disabled at 0
 *   4. Queue overflow protection: drops oldest, increments droppedCount
 *   5. Concurrent flush serialisation: no duplicates, no losses
 *   6. installFileLogger env gate: DSH_EDGE_LOG_FILE=false skips
 *   7. installFileLogger first-wins: pre-populated exporters map skips
 *   8. resolveLoggerConfig: env overrides default HOME path
 *
 * Style mirrors tests/unit/audit-log.test.ts (vitest + node:assert/strict +
 * mkdtempSync-based scratch root).
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'vitest'

// Constants — mirror the bundle's channel-path defaults so a future rename
// (PROGRESS §7.25 / §7.25.x P3-P5) only touches these literals, not the
// assertions below. Per §7.25.x: the bundle name `dsh-edge-agent` MUST NOT
// be treated as a profile container name; `LOG_ROOT` is the bundle's
// channel-path default, independent of profile container name.
const LOG_FILENAME = 'dsh-edge-agent.log'
const LOG_ROOT_SEGMENT = '.dsh-edge-agent' // under $HOME, by default

import * as fileLogger from '../../src/dsh-adapter/file-logger.ts'
import {
  FileLoggerServiceImpl,
  installFileLogger,
  resolveLoggerConfig,
  shutdownFileLogger,
} from '../../src/dsh-adapter/file-logger.ts'

/**
 * Minimal context stub mirroring audit-log's fakeCtx. file-exporter reads
 * `ctx.logger.exporters.size` for the first-wins guard and calls
 * `ctx.logger.exporter(...)` to register itself; tests can inspect either.
 *
 * 2026-09-02: capture every registered exporter so tests can assert on
 * `exporter.levels` (the per-exporter level filter passed by
 * `installFileLogger` to enable debug-level body logging).
 */
function fakeCtx() {
  const exporters = new Map<object, true>()
  const registered: object[] = []
  return {
    registered,
    reflect: { provide(_n: string, _v: unknown) { return () => {} } },
    provide(_n: string, _v: unknown) { return () => {} },
    logger: {
      exporters,
      exporter(impl: object) {
        exporters.set(impl, true)
        registered.push(impl)
        return () => exporters.delete(impl)
      },
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
  }
}

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'edge-m6-filelog-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('file-logger plugin shape', () => {
  it('exports the canonical plugin shape', () => {
    assert.equal(fileLogger.name, 'file-logger')
    // 2026-09-02: inject=['web'] — see file-logger.ts for rationale
    // (boot diagnostic reads ctx.web.searchProviders.size).
    assert.deepEqual([...fileLogger.inject], ['web'])
    // Config is a Schemastery function (`Schema.object(...)`), not a plain
    // object — just assert it exists and is callable.
    assert.equal(typeof fileLogger.Config, 'function')
  })
})

describe('FileLoggerServiceImpl.export + flush', () => {
  it('formats a Cordis Message as `<iso-ts> <LEVEL> [<name>] <msg>`', () => {    // We don't call export() directly here — instead exercise the format
    // contract via a real Service so the queue/flush path is also covered.
    const svc = new FileLoggerServiceImpl(fakeCtx() as never, {
      root,
      filename: 'a.log',
      flushIntervalMs: 60_000,
      queueCapacity: 100,
      maxFileSizeBytes: 50 * 1024 * 1024,
      maxFileAgeDays: 0,
      maxRotatedFiles: 5,
    })
    // Construct a synthetic Message mirroring Cordis's `Message` shape
    // (`@deepseek-ai/cordis@4.0.1/src/logger.ts:30-38`).
    svc.export({
      sn: 1,
      ts: 1_700_000_000_000,
      name: 'test-plugin',
      type: 'info',
      level: 1,
      args: ['hello world'],
    } as never)
    svc.export({
      sn: 2,
      ts: 1_700_000_001_000,
      name: 'test-plugin',
      type: 'warn',
      level: 2,
      args: [new Error('boom')],
    } as never)
    return svc.flush().then(() => {
      assert.ok(existsSync(svc.filePathForTests()), 'log file should exist after flush')
      const content = readFileSync(svc.filePathForTests(), 'utf-8')
      const lines = content.split('\n').filter((l) => l.length > 0)
      assert.equal(lines.length, 2)
      // `type.padEnd(5)` produces `INFO ` (5-wide) so the rendered line has
      // two spaces between the level and the plugin name; allow either
      // single or double space to keep this assertion loose to format tweaks.
      // §7.30: timestamp is local ISO 8601 with offset (`+08:00` for
      // Asia/Shanghai), not UTC `Z`. Match a numeric offset (positive or
      // negative, 2-digit hour + 2-digit minute) so the assertion survives
      // any TZ the test machine happens to run in.
      assert.match(lines[0]!, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+\-]\d{2}:\d{2} INFO {1,2}\[test-plugin\] hello world$/)
      // Line 1 is an Error — `formatLine` collapses `stack` newlines to `⏎`
      // markers so the entry stays one physical line; assert the head is
      // present and stack frames are escaped rather than raw newlines.
      assert.match(lines[1]!, /WARN {1,2}\[test-plugin\] Error: boom/)
      assert.ok(!lines[1]!.includes('\n'), 'error stack must be collapsed to a single line')
    })
  })

  it('rotates the file when maxFileSizeBytes is exceeded', async () => {
    const svc = new FileLoggerServiceImpl(fakeCtx() as never, {
      root,
      filename: 'a.log',
      flushIntervalMs: 60_000,
      queueCapacity: 1000,
      // 100B forces rotation after ~1 entry.
      maxFileSizeBytes: 100,
      maxFileAgeDays: 0,
      maxRotatedFiles: 3,
    })
    // Push 5 entries; each formatted line is ~70-80 bytes; after the 2nd
    // the file should exceed 100B and rotate.
    for (let i = 0; i < 5; i++) {
      svc.export({
        sn: i,
        ts: 1_700_000_000_000 + i,
        name: 'rot',
        type: 'info',
        level: 1,
        args: [`entry-${i}`],
      } as never)
    }
    await svc.flush()
    // After the second flush batch the file should rotate. Run another
    // flush so checkAndRotate sees the now-oversized file.
    svc.export({
      sn: 99,
      ts: 1_700_000_000_999,
      name: 'rot',
      type: 'info',
      level: 1,
      args: ['trigger-rotation'],
    } as never)
    await svc.flush()
    // Either .1 or .2 should exist (depends on exact line lengths).
    const entries = readdirSync(root).filter((f) => f.startsWith('a.log'))
    assert.ok(entries.length >= 2, `expected rotation, got files: ${entries.join(', ')}`)
  })

  // §7.56 (2026-09-15): calendar-day rotation. The old elapsed-time check
  // (`now - mtime >= maxFileAgeDays`) never fired for an active append log
  // because every flush refreshes mtime. The new check compares LOCAL
  // calendar days, so a file whose mtime is "yesterday" rotates on the
  // first flush of today. Tests simulate the day boundary with utimesSync.
  it('rotates across a calendar-day boundary when maxFileAgeDays=1', async () => {
    const svc = new FileLoggerServiceImpl(fakeCtx() as never, {
      root,
      filename: 'a.log',
      flushIntervalMs: 60_000,
      queueCapacity: 100,
      maxFileSizeBytes: 50 * 1024 * 1024,
      maxFileAgeDays: 1,
      maxRotatedFiles: 7,
    })
    // Seed "yesterday's" file: write one line, then backdate mtime 36h
    // (36 > 24 guarantees a different local calendar day at any wall time).
    svc.export({ sn: 1, ts: Date.now(), name: 'rot', type: 'info', level: 1, args: ['yesterday-line'] } as never)
    await svc.flush()
    const yesterday = new Date(Date.now() - 36 * 60 * 60 * 1000)
    utimesSync(svc.filePathForTests(), yesterday, yesterday)

    // First flush of the "new day" must rotate the old file to .1.
    svc.export({ sn: 2, ts: Date.now(), name: 'rot', type: 'info', level: 1, args: ['today-line'] } as never)
    await svc.flush()

    const rotated = `${svc.filePathForTests()}.1`
    assert.ok(existsSync(rotated), 'expected .1 rotated file after day boundary')
    assert.match(readFileSync(rotated, 'utf-8'), /yesterday-line/)
    assert.match(readFileSync(svc.filePathForTests(), 'utf-8'), /today-line/)
    assert.ok(!readFileSync(svc.filePathForTests(), 'utf-8').includes('yesterday-line'),
      'new file must not contain pre-rotation content')
  })

  it('does NOT rotate within the same calendar day (maxFileAgeDays=1)', async () => {
    const svc = new FileLoggerServiceImpl(fakeCtx() as never, {
      root,
      filename: 'a.log',
      flushIntervalMs: 60_000,
      queueCapacity: 100,
      maxFileSizeBytes: 50 * 1024 * 1024,
      maxFileAgeDays: 1,
      maxRotatedFiles: 7,
    })
    svc.export({ sn: 1, ts: Date.now(), name: 'rot', type: 'info', level: 1, args: ['line-1'] } as never)
    await svc.flush()
    // Backdate 1h — still the same local calendar day in every realistic
    // run; even if the test executes within 1h of midnight the dayDiff is
    // at most 1 and only crosses when the hour actually spans midnight,
    // so assert on "no rotation OR rotation consistent with dayDiff".
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)
    utimesSync(svc.filePathForTests(), oneHourAgo, oneHourAgo)
    svc.export({ sn: 2, ts: Date.now(), name: 'rot', type: 'info', level: 1, args: ['line-2'] } as never)
    await svc.flush()

    const sameDay = oneHourAgo.getDate() === new Date().getDate()
    const rotated = existsSync(`${svc.filePathForTests()}.1`)
    if (sameDay) {
      assert.ok(!rotated, 'same calendar day must not rotate')
    } else {
      // Test ran across local midnight — rotation is the correct behavior.
      assert.ok(rotated, 'midnight crossed during test; rotation expected')
    }
  })

  it('maxFileAgeDays=0 disables day-boundary rotation', async () => {
    const svc = new FileLoggerServiceImpl(fakeCtx() as never, {
      root,
      filename: 'a.log',
      flushIntervalMs: 60_000,
      queueCapacity: 100,
      maxFileSizeBytes: 50 * 1024 * 1024,
      maxFileAgeDays: 0,
      maxRotatedFiles: 7,
    })
    svc.export({ sn: 1, ts: Date.now(), name: 'rot', type: 'info', level: 1, args: ['old-line'] } as never)
    await svc.flush()
    const threeDaysAgo = new Date(Date.now() - 72 * 60 * 60 * 1000)
    utimesSync(svc.filePathForTests(), threeDaysAgo, threeDaysAgo)
    svc.export({ sn: 2, ts: Date.now(), name: 'rot', type: 'info', level: 1, args: ['new-line'] } as never)
    await svc.flush()
    assert.ok(!existsSync(`${svc.filePathForTests()}.1`), 'age rotation disabled must not rotate')
  })

  it('drops oldest entries when queue is full and counts them', () => {
    const svc = new FileLoggerServiceImpl(fakeCtx() as never, {
      root,
      filename: 'a.log',
      flushIntervalMs: 60_000,
      queueCapacity: 3,
      maxFileSizeBytes: 50 * 1024 * 1024,
      maxFileAgeDays: 0,
      maxRotatedFiles: 5,
    })
    // Capacity 3, push 7 → expect 4 drops, queue length = 3 (capped).
    for (let i = 0; i < 7; i++) {
      svc.export({
        sn: i,
        ts: 1_700_000_000_000 + i,
        name: 'q',
        type: 'info',
        level: 1,
        args: [`e${i}`],
      } as never)
    }
    assert.equal(svc.droppedCountForTests(), 4)
  })
})

describe('installFileLogger', () => {
  it('returns undefined when DSH_EDGE_LOG_FILE=false', () => {
    const prev = process.env.DSH_EDGE_LOG_FILE
    try {
      process.env.DSH_EDGE_LOG_FILE = 'false'
      const result = installFileLogger(fakeCtx() as never, {
        root,
        filename: 'a.log',
        flushIntervalMs: 60_000,
        queueCapacity: 100,
        maxFileSizeBytes: 50 * 1024 * 1024,
        maxFileAgeDays: 0,
        maxRotatedFiles: 5,
      })
      assert.equal(result, undefined)
    } finally {
      if (prev === undefined) delete process.env.DSH_EDGE_LOG_FILE
      else process.env.DSH_EDGE_LOG_FILE = prev
    }
  })

  it('registers even when the host already has exporters (§7.118)', async () => {
    const ctx = fakeCtx()
    // The host (dsh-desktop-host / dsh --profile) registers its OWN exporter
    // at boot — a CONSOLE one, not a file one. The old guard
    // (`exporters.size > 1 → skip`) could not tell them apart, so the ops
    // log silently vanished on both hosts (desktop's last write was
    // 2026-10-25 19:47). Our output path is edge-owned
    // (~/.dsh-edge-agent/log/), so a collision with a host file exporter
    // cannot happen — the guard was protecting against a non-issue while
    // causing a real one.
    ctx.logger.exporter({ export() {} })
    ctx.logger.exporter({ export() {} })
    const sizeBefore = ctx.logger.exporters.size
    const svc = installFileLogger(ctx as never, {
      root,
      filename: 'a.log',
      flushIntervalMs: 60_000,
      queueCapacity: 100,
      maxFileSizeBytes: 50 * 1024 * 1024,
      maxFileAgeDays: 0,
      maxRotatedFiles: 5,
    })
    assert.ok(svc instanceof FileLoggerServiceImpl)
    assert.equal(ctx.logger.exporters.size, sizeBefore + 1)
    return shutdownFileLogger(svc)
  })

  it('DSH_EDGE_LOG_FILE=force is accepted as a no-op alias (§7.118)', async () => {
    const prev = process.env.DSH_EDGE_LOG_FILE
    try {
      process.env.DSH_EDGE_LOG_FILE = 'force'
      const svc = installFileLogger(fakeCtx() as never, {
        root,
        filename: 'a.log',
        flushIntervalMs: 60_000,
        queueCapacity: 100,
        maxFileSizeBytes: 50 * 1024 * 1024,
        maxFileAgeDays: 0,
        maxRotatedFiles: 5,
      })
      assert.ok(svc instanceof FileLoggerServiceImpl)
      return shutdownFileLogger(svc)
    } finally {
      if (prev === undefined) delete process.env.DSH_EDGE_LOG_FILE
      else process.env.DSH_EDGE_LOG_FILE = prev
    }
  })

  it('returns the service and registers exactly one exporter on a fresh ctx', () => {
    const ctx = fakeCtx()
    const sizeBefore = ctx.logger.exporters.size
    const svc = installFileLogger(ctx as never, {
      root,
      filename: 'a.log',
      flushIntervalMs: 60_000,
      queueCapacity: 100,
      maxFileSizeBytes: 50 * 1024 * 1024,
      maxFileAgeDays: 0,
      maxRotatedFiles: 5,
    })
    assert.ok(svc instanceof FileLoggerServiceImpl)
    assert.equal(ctx.logger.exporters.size, sizeBefore + 1)
    return shutdownFileLogger(svc)
  })
})

describe('resolveLoggerConfig', () => {
  it('uses DSH_EDGE_LOG_ROOT when set', () => {
    const cfg = resolveLoggerConfig({ DSH_EDGE_LOG_ROOT: '/var/log/custom' })
    assert.equal(cfg.root, '/var/log/custom')
    assert.equal(cfg.filename, LOG_FILENAME)
  })

  it('falls back to $HOME/.dsh-edge-agent/log when no env override', () => {
    const cfg = resolveLoggerConfig({ HOME: '/home/tester' })
    assert.equal(cfg.root, join('/home/tester', LOG_ROOT_SEGMENT, 'log'))
  })

  it('exposes the agreed defaults', () => {
    const cfg = resolveLoggerConfig({ HOME: '/tmp' })
    assert.equal(cfg.flushIntervalMs, 1000)
    assert.equal(cfg.queueCapacity, 10_000)
    assert.equal(cfg.maxFileSizeBytes, 50 * 1024 * 1024)
    // §7.56 (2026-09-15): daily rotation by default; keep-window widened
    // 5 → 7 so a week of day-rotated files survives.
    assert.equal(cfg.maxFileAgeDays, 1)
    assert.equal(cfg.maxRotatedFiles, 7)
    // 2026-09-11: default level flipped debug → info per user feedback
    // "log 太冗余" — ops log was drowning in 4 body lines per LLM call.
    // Previously 2026-09-02 info → debug (PROGRESS §7.23).
    assert.equal(cfg.level, 'info')
  })

  // §7.56 (2026-09-15): rotation env overrides. AGE_DAYS=0 restores the
  // old size-only behavior; invalid values fall back to the daily default.
  it('honours DSH_EDGE_LOG_MAX_AGE_DAYS / MAX_ROTATED env overrides', () => {
    assert.equal(resolveLoggerConfig({ HOME: '/tmp', DSH_EDGE_LOG_MAX_AGE_DAYS: '0' }).maxFileAgeDays, 0)
    assert.equal(resolveLoggerConfig({ HOME: '/tmp', DSH_EDGE_LOG_MAX_AGE_DAYS: '3' }).maxFileAgeDays, 3)
    assert.equal(resolveLoggerConfig({ HOME: '/tmp', DSH_EDGE_LOG_MAX_AGE_DAYS: 'bogus' }).maxFileAgeDays, 1)
    assert.equal(resolveLoggerConfig({ HOME: '/tmp', DSH_EDGE_LOG_MAX_ROTATED: '14' }).maxRotatedFiles, 14)
    assert.equal(resolveLoggerConfig({ HOME: '/tmp', DSH_EDGE_LOG_MAX_ROTATED: '-2' }).maxRotatedFiles, 7)
  })

  // 2026-09-02: DSH_EDGE_LOG_LEVEL env var overrides the default.
  it('honours DSH_EDGE_LOG_LEVEL env var override', () => {
    assert.equal(resolveLoggerConfig({ HOME: '/tmp', DSH_EDGE_LOG_LEVEL: 'info' }).level, 'info')
    assert.equal(resolveLoggerConfig({ HOME: '/tmp', DSH_EDGE_LOG_LEVEL: 'warn' }).level, 'warn')
    assert.equal(resolveLoggerConfig({ HOME: '/tmp', DSH_EDGE_LOG_LEVEL: 'error' }).level, 'error')
    assert.equal(resolveLoggerConfig({ HOME: '/tmp', DSH_EDGE_LOG_LEVEL: 'debug' }).level, 'debug')
  })

  // 2026-09-11: invalid env value falls back to 'info' (the new default,
  // flipped from 'debug' per user feedback "log 太冗余"). Operators
  // who set a bogus value get the same quiet ops log as before; set
  // DSH_EDGE_LOG_LEVEL=debug explicitly to re-enable body capture.
  it('falls back to info for invalid DSH_EDGE_LOG_LEVEL values', () => {
    assert.equal(resolveLoggerConfig({ HOME: '/tmp', DSH_EDGE_LOG_LEVEL: 'verbose' }).level, 'info')
    assert.equal(resolveLoggerConfig({ HOME: '/tmp', DSH_EDGE_LOG_LEVEL: '' }).level, 'info')
    assert.equal(resolveLoggerConfig({ HOME: '/tmp', DSH_EDGE_LOG_LEVEL: 'TRACE' }).level, 'info')
  })
})

// 2026-09-02: installFileLogger must register the exporter with a
// per-exporter `levels: { default: <numeric> }` so Cordis passes debug
// messages through. Without this, Cordis's default INFO filter silently
// drops every `ctx.logger.debug(...)` call (including the LLM body calls
// in cloud-llm-adapter.ts / local-llm-adapter.ts).
describe('installFileLogger level wiring', () => {
  it('registers an exporter with levels.default = 3 when level=debug', () => {
    const ctx = fakeCtx()
    installFileLogger(ctx as never, {
      root,
      filename: 'a.log',
      flushIntervalMs: 60_000,
      queueCapacity: 100,
      maxFileSizeBytes: 50 * 1024 * 1024,
      maxFileAgeDays: 0,
      maxRotatedFiles: 5,
      level: 'debug',
    })
    assert.equal(ctx.registered.length, 1)
    const exporter = ctx.registered[0] as { levels: Record<string, number> }
    assert.deepEqual(exporter.levels, { default: 3 })
  })

  it('registers an exporter with levels.default = 1 when level=info (suppresses debug)', () => {
    const ctx = fakeCtx()
    installFileLogger(ctx as never, {
      root,
      filename: 'a.log',
      flushIntervalMs: 60_000,
      queueCapacity: 100,
      maxFileSizeBytes: 50 * 1024 * 1024,
      maxFileAgeDays: 0,
      maxRotatedFiles: 5,
      level: 'info',
    })
    const exporter = ctx.registered[0] as { levels: Record<string, number> }
    assert.deepEqual(exporter.levels, { default: 1 })
  })

  it('maps warn/error to numeric 2/0', () => {
    const ctxWarn = fakeCtx()
    installFileLogger(ctxWarn as never, {
      root, filename: 'a.log', flushIntervalMs: 60_000, queueCapacity: 100,
      maxFileSizeBytes: 50 * 1024 * 1024, maxFileAgeDays: 0, maxRotatedFiles: 5,
      level: 'warn',
    })
    assert.deepEqual((ctxWarn.registered[0] as { levels: Record<string, number> }).levels, { default: 2 })

    const ctxError = fakeCtx()
    installFileLogger(ctxError as never, {
      root, filename: 'a.log', flushIntervalMs: 60_000, queueCapacity: 100,
      maxFileSizeBytes: 50 * 1024 * 1024, maxFileAgeDays: 0, maxRotatedFiles: 5,
      level: 'error',
    })
    assert.deepEqual((ctxError.registered[0] as { levels: Record<string, number> }).levels, { default: 0 })
  })
})

describe('shutdownFileLogger', () => {  it('stops the timer and drains the queue', async () => {
    const svc = new FileLoggerServiceImpl(fakeCtx() as never, {
      root,
      filename: 'a.log',
      flushIntervalMs: 60_000,
      queueCapacity: 100,
      maxFileSizeBytes: 50 * 1024 * 1024,
      maxFileAgeDays: 0,
      maxRotatedFiles: 5,
    })
    svc.export({
      sn: 1,
      ts: 1_700_000_000_000,
      name: 'shutdown',
      type: 'info',
      level: 1,
      args: ['final'],
    } as never)
    await shutdownFileLogger(svc)
    assert.ok(existsSync(svc.filePathForTests()))
    const content = readFileSync(svc.filePathForTests(), 'utf-8')
    assert.match(content, /\[shutdown\] final/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §7.30 regression suite: ops log timestamp is local ISO 8601 with numeric
// offset (e.g. "+08:00"), NOT UTC "Z". Without this, operators in
// Asia/Shanghai see "01:41:30" in the ops log when the actual moment is
// "09:41:30" local, which is unintuitive when tailing alongside `date`
// or other system logs.
// ─────────────────────────────────────────────────────────────────────────────

describe('§7.30 ops log timestamp — local ISO with numeric offset', () => {
  it('formatLine uses numeric offset (not Z) that matches system TZ', async () => {
    const svc = new FileLoggerServiceImpl(fakeCtx() as never, {
      root,
      filename: 'tz.log',
      flushIntervalMs: 60_000,
      queueCapacity: 100,
      maxFileSizeBytes: 50 * 1024 * 1024,
      maxFileAgeDays: 0,
      maxRotatedFiles: 5,
    })
    const probeTs = Date.now()
    svc.export({
      sn: 1, ts: probeTs, name: 'tz-test', type: 'info', level: 1, args: ['probe'],
    } as never)
    await svc.flush()
    const content = readFileSync(svc.filePathForTests(), 'utf-8')
    // Match: <year>-<mo>-<dd>T<h>:<m>:<s>.<ms>[+-]<HH>:<MM> INFO [tz-test] probe
    const m = content.match(/^(\S+) INFO {1,2}\[tz-test\] probe$/m)
    assert.ok(m, `expected line, got: ${content}`)
    const ts = m![1]!
    // Should NOT end with Z (UTC marker)
    assert.ok(!ts.endsWith('Z'), `must not end with Z (UTC), got: ${ts}`)
    // Should end with ±HH:MM (numeric offset)
    assert.match(ts, /[+-]\d{2}:\d{2}$/, `must end with ±HH:MM offset, got: ${ts}`)
    // The wall-clock components must match the local rendering of probeTs
    const d = new Date(probeTs)
    const expectedWall = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`
    assert.ok(ts.startsWith(expectedWall), `wall-clock mismatch: got=${ts} expected-start=${expectedWall}`)
    // Offset must equal system TZ (Date#getTimezoneOffset minutes west, flip sign)
    const offsetMin = -d.getTimezoneOffset()
    const sign = offsetMin >= 0 ? '+' : '-'
    const absMin = Math.abs(offsetMin)
    const expectedOffset = `${sign}${String(Math.floor(absMin / 60)).padStart(2, '0')}:${String(absMin % 60).padStart(2, '0')}`
    assert.ok(ts.endsWith(expectedOffset), `offset mismatch: got-offset=${ts.slice(-6)} expected=${expectedOffset}`)
  })

  it('output parses back to the same epoch ms (round-trip)', async () => {
    const svc = new FileLoggerServiceImpl(fakeCtx() as never, {
      root,
      filename: 'round.log',
      flushIntervalMs: 60_000,
      queueCapacity: 100,
      maxFileSizeBytes: 50 * 1024 * 1024,
      maxFileAgeDays: 0,
      maxRotatedFiles: 5,
    })
    const probeTs = 1_726_144_823_456  // fixed probe (2024-09-26 ish)
    svc.export({
      sn: 1, ts: probeTs, name: 'rt', type: 'info', level: 1, args: ['x'],
    } as never)
    await svc.flush()
    const content = readFileSync(svc.filePathForTests(), 'utf-8')
    const m = content.match(/^(\S+) INFO/m)
    assert.ok(m)
    const parsed = Date.parse(m![1]!)
    assert.equal(parsed, probeTs, 'parsed timestamp must equal original epoch ms (TZ-neutral ISO 8601)')
  })
})