#!/usr/bin/env node --import tsx/esm
/**
 * DEAD (§7.61, 2026-09-17): 依赖的 `dsh --config` 旗标已从现装 CLI 移除,
 * profiles/edge-m1.cordis.yml 已 git rm;会话/审计持久面由
 * scripts/e2e-tui-live.sh(§7.60)逐用例日志分析取代。不可运行。
 *
 * M3 manual smoke — drive the edge-m1 profile twice in a row, then inspect
 * the on-disk JSONL store: a session created in run 1 should be visible
 * in `sessions listActive` of run 2, and the audit log should contain
 * at least one `agent.run` entry.
 *
 * Pre-reqs:
 *   DEEPSEEK_API_KEY=<your-key>
 *
 * Run: pnpm exec tsx scripts/m3-smoke.ts
 *
 * Exit code 0 when:
 *   - Both dsh runs exit 0
 *   - storage.plain.jsonl exists and contains a `sessions` collection
 *     with at least one entry whose messages are non-empty
 *   - audit.plain.jsonl exists and has at least one entry
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const profile = join(here, '..', 'profiles', 'edge-m1.cordis.yml')

if (!process.env.DEEPSEEK_API_KEY) {
  console.error('[m3-smoke] DEEPSEEK_API_KEY is not set; aborting.')
  process.exit(2)
}

// Test sandbox root — separate from the production channel path
// `~/.dsh-edge-agent/` so a smoke run never touches user data. Per
// PROGRESS §7.25 + §7.25.x the production name is the bundle's channel
// root, not a profile name; this sandbox name keeps the `-m3-smoke`
// suffix for traceability.
const TEST_SANDBOX = '.dsh-edge-agent-m3-smoke'
const home = process.env.USERPROFILE ?? process.env.HOME ?? '/tmp'
const root = join(home, TEST_SANDBOX)
const storageFile = join(root, 'storage', 'storage.plain.jsonl')
const auditFile = join(root, 'audit', 'audit.plain.jsonl')

// Clean slate so each smoke run is deterministic.
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })

function runDsh(prompt: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'npx',
      ['-y', '--package=@deepseek-ai/dsh', 'dsh', '--config', profile, prompt],
      {
        stdio: ['ignore', 'pipe', 'inherit'],
        env: {
          ...process.env,
          DSH_EDGE_STORAGE_ROOT: join(root, 'storage'),
          DSH_EDGE_AUDIT_ROOT: join(root, 'audit'),
          DSH_EDGE_AUDIT_FLUSH_MS: '200',
        },
      },
    )
    child.stdout.on('data', () => {})
    child.on('error', reject)
    child.on('exit', (code) => resolve(code ?? 1))
  })
}

const turn1 = process.argv[2] ?? '我的名字是张三'
const turn2 = process.argv[3] ?? '我叫什么名字？请只回答我的名字。'

const code1 = await runDsh(turn1)
const code2 = await runDsh(turn2)
console.log(`[m3-smoke] dsh exit codes: run1=${code1} run2=${code2}`)

if (code1 !== 0 || code2 !== 0) {
  console.error('[m3-smoke] FAILED: one of the dsh runs did not exit cleanly.')
  process.exit(1)
}

if (!existsSync(storageFile)) {
  console.error(`[m3-smoke] FAILED: storage file ${storageFile} missing.`)
  process.exit(1)
}

const lines = readFileSync(storageFile, 'utf-8').split('\n').filter(Boolean)
const sessions = lines
  .map((line) => JSON.parse(line) as { collection?: string; key?: string; value?: unknown; op?: string })
  .filter((row) => row.collection === 'sessions' && row.op === 'put')
const withMessages = sessions.filter((row) => {
  const v = row.value as { messages?: unknown[] } | undefined
  return Array.isArray(v?.messages) && v.messages.length > 0
})
console.log(`[m3-smoke] sessions in store: ${sessions.length}; with messages: ${withMessages.length}`)

if (withMessages.length === 0) {
  console.error('[m3-smoke] FAILED: no session in storage carried any messages.')
  process.exit(1)
}

if (!existsSync(auditFile)) {
  console.error(`[m3-smoke] FAILED: audit file ${auditFile} missing.`)
  process.exit(1)
}

const auditLines = readFileSync(auditFile, 'utf-8').split('\n').filter(Boolean)
console.log(`[m3-smoke] audit entries on disk: ${auditLines.length}`)

if (auditLines.length === 0) {
  console.error('[m3-smoke] FAILED: audit log is empty.')
  process.exit(1)
}

console.log('[m3-smoke] ✅ M3 persistence + audit smoke OK')
process.exit(0)