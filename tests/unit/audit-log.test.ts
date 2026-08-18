/**
 * audit-log (M3) tests — in-memory ring buffer + periodic plaintext JSONL
 * flush, query + getSecurityReport surfaces, level filtering.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'vitest'

import * as audit from '../../src/dsh-adapter/audit-log.ts'
import { AuditLogServiceImpl } from '../../src/dsh-adapter/audit-log.ts'

function fakeCtx() {
  return {
    reflect: { provide(_n: string, _v: unknown) { return () => {} } },
    provide(_n: string, _v: unknown) { return () => {} },
  }
}

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'edge-m3-audit-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('audit-log (M3)', () => {
  it('exports the canonical plugin shape', () => {
    assert.equal(audit.name, 'audit-log')
    assert.deepEqual([...audit.inject], [])
    assert.equal(typeof audit.apply, 'function')
    assert.ok(audit.Config)
  })

  it('log() pushes entries into the ring buffer', async () => {
    const svc = new AuditLogServiceImpl(fakeCtx() as never, {
      minLevel: 'debug',
      ringBufferSize: 8,
      flushIntervalMs: 60_000,
      filename: 'a.jsonl',
      root,
    })
    await svc.log({ level: 'info', kind: 'session.create', source: 'sessions', payload: { id: 'a' } })
    await svc.log({ level: 'info', kind: 'session.create', source: 'sessions', payload: { id: 'b' } })
    const all = await svc.query({})
    assert.equal(all.length, 2)
    assert.equal(all[0]!.kind, 'session.create')
  })

  it('drops entries below minLevel', async () => {
    const svc = new AuditLogServiceImpl(fakeCtx() as never, {
      minLevel: 'warn',
      ringBufferSize: 8,
      flushIntervalMs: 60_000,
      filename: 'a.jsonl',
      root,
    })
    await svc.log({ level: 'debug', kind: 'x', source: 'y', payload: {} })
    await svc.log({ level: 'info', kind: 'x', source: 'y', payload: {} })
    await svc.log({ level: 'warn', kind: 'x', source: 'y', payload: {} })
    const all = await svc.query({})
    assert.equal(all.length, 1)
    assert.equal(all[0]!.level, 'warn')
  })

  it('flush() persists pending entries to disk', async () => {
    const svc = new AuditLogServiceImpl(fakeCtx() as never, {
      minLevel: 'debug',
      ringBufferSize: 8,
      flushIntervalMs: 60_000,
      filename: 'a.jsonl',
      root,
    })
    await svc.log({ level: 'info', kind: 'k1', source: 's', payload: { v: 1 } })
    await svc.log({ level: 'info', kind: 'k2', source: 's', payload: { v: 2 } })
    await svc.flush()
    const file = join(root, 'a.jsonl')
    const lines = readFileSync(file, 'utf-8').trim().split('\n')
    assert.equal(lines.length, 2)
    const first = JSON.parse(lines[0]!)
    assert.equal(first.kind, 'k1')
    assert.equal(first.payload.v, 1)
  })

  it('query() filters by level/kind/source/since/limit', async () => {
    const svc = new AuditLogServiceImpl(fakeCtx() as never, {
      minLevel: 'debug',
      ringBufferSize: 16,
      flushIntervalMs: 60_000,
      filename: 'a.jsonl',
      root,
    })
    const t0 = Date.now()
    await svc.log({ level: 'info', kind: 'tool.call', source: 'tools', payload: {} })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await svc.log({ level: 'warn', kind: 'tool.deny', source: 'tools', payload: {} })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await svc.log({ level: 'error', kind: 'llm.fail', source: 'cloud-llm-adapter', payload: {} })

    const onlyWarn = await svc.query({ level: 'warn' })
    assert.equal(onlyWarn.length, 1)
    assert.equal(onlyWarn[0]!.kind, 'tool.deny')

    const onlyTools = await svc.query({ source: 'tools' })
    assert.equal(onlyTools.length, 2)

    const onlyFail = await svc.query({ kind: 'llm.fail' })
    assert.equal(onlyFail.length, 1)

    const sinceT0 = await svc.query({ sinceMs: t0 })
    assert.equal(sinceT0.length, 3)

    const last1 = await svc.query({ limit: 1 })
    assert.equal(last1.length, 1)
    assert.equal(last1[0]!.kind, 'llm.fail')
  })

  it('getSecurityReport summarises level counts and rate', async () => {
    const svc = new AuditLogServiceImpl(fakeCtx() as never, {
      minLevel: 'debug',
      ringBufferSize: 16,
      flushIntervalMs: 60_000,
      filename: 'a.jsonl',
      root,
    })
    await svc.log({ level: 'info', kind: 'a', source: 'x', payload: {} })
    await svc.log({ level: 'warn', kind: 'b', source: 'x', payload: {} })
    await svc.log({ level: 'error', kind: 'c', source: 'x', payload: {} })
    await svc.log({ level: 'security', kind: 'd', source: 'x', payload: {} })
    const report = await svc.getSecurityReport()
    assert.equal(report.totalEntries, 4)
    assert.equal(report.levelCounts.info, 1)
    assert.equal(report.levelCounts.warn, 1)
    assert.equal(report.levelCounts.error, 1)
    assert.equal(report.levelCounts.security, 1)
    assert.ok(report.ratePerMinute.a === 1)
    assert.ok(report.ratePerMinute.d === 1)
    assert.ok(report.recent.length >= 1)
  })

  it('ring buffer drops oldest entries past ringBufferSize', async () => {
    const svc = new AuditLogServiceImpl(fakeCtx() as never, {
      minLevel: 'debug',
      ringBufferSize: 3,
      flushIntervalMs: 60_000,
      filename: 'a.jsonl',
      root,
    })
    for (let i = 0; i < 5; i++) {
      await svc.log({ level: 'info', kind: `k${i}`, source: 's', payload: { i } })
    }
    const all = await svc.query({})
    // query() spans past the ring via disk (which is empty until flush),
    // so the result reflects ONLY the ring buffer here.
    assert.ok(all.length <= 3)
    assert.equal(all[all.length - 1]!.kind, 'k4')
  })
})