#!/usr/bin/env node --import tsx/esm
/**
 * DEAD (§7.61, 2026-09-17): 依赖的 `dsh --config` 旗标已从现装 CLI 移除,
 * profiles/edge-m1.cordis.yml 已 git rm;工具链 E2E 面由
 * scripts/e2e-tui-live.sh(§7.60)取代。保留供叙事连贯,不可运行。
 *
 * M2 manual smoke — drive the edge-m1 profile through a tool-calling
 * conversation: the assistant must call `local_file_read` to surface
 * the contents of `/tmp/m2-smoke-test.txt`.
 *
 * Pre-reqs:
 *   DEEP SEEK_API_KEY=<your-key> (cloud LLM)
 *   Run:  bash -c 'echo "hello edge" > /tmp/m2-smoke-test.txt'
 *   Then: pnpm exec tsx scripts/m2-smoke.ts
 *
 * The unit tests stub `fetch` and never spin the real DSH loop. This
 * script is the only manual check that the dsh-agent loop actually
 * dispatches a registered local tool through `ctx.tools` and reads back
 * the file content through the cloud model.
 *
 * Exit code 0 when the file content ("hello edge") appears in the
 * stream stdout; non-zero otherwise.
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const profile = join(here, '..', 'profiles', 'edge-m1.cordis.yml')

if (!process.env.DEEPSEEK_API_KEY) {
  console.error('[m2-smoke] DEEPSEEK_API_KEY is not set; aborting.')
  console.error('  export DEEPSEEK_API_KEY=sk-... and re-run.')
  process.exit(2)
}

// Pin a tempdir under the platform tmp so the allowlist prefix matches.
const staging = mkdtempSync(join(tmpdir(), 'm2-smoke-'))
const probe = join(staging, 'probe.txt')
writeFileSync(probe, 'hello edge', 'utf-8')

const prompt = `请用 local_file_read 工具读取 ${probe} 的内容，并原样告诉我文件内容。`

console.log(`[m2-smoke] profile=${profile}`)
console.log(`[m2-smoke] probe=${probe}`)
console.log(`[m2-smoke] prompt=${prompt}`)

const child = spawn(
  'npx',
  ['-y', '--package=@deepseek-ai/dsh', 'dsh', '--config', profile, prompt],
  {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: {
      ...process.env,
      DSH_EDGE_LOCAL_TOOLS_ALLOWLIST: staging,
      DSH_EDGE_LOCAL_TOOLS_WRITABLE: 'false',
    },
  },
)

let stdout = ''
child.stdout.on('data', (chunk) => {
  stdout += chunk.toString('utf-8')
  process.stdout.write(chunk)
})

child.on('error', (err) => {
  console.error(`[m2-smoke] launch failed: ${err.message}`)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`[m2-smoke] dsh exited via signal ${signal}`)
    process.exit(1)
  }
  if (code !== 0) {
    console.error(`[m2-smoke] dsh exited with code ${code}`)
    process.exit(code ?? 1)
  }
  // Sanity: the smoke only asserts that the file contents made it back
  // through the cloud model; the file itself is the ground truth.
  const ground = readFileSync(probe, 'utf-8').trim()
  if (!stdout.includes(ground)) {
    console.error(`[m2-smoke] FAILED: stdout did not contain "${ground}"`)
    console.error('--- captured stdout ---')
    console.error(stdout)
    process.exit(1)
  }
  console.log(`[m2-smoke] ✅ file content "${ground}" reached the assistant transcript`)
  process.exit(0)
})