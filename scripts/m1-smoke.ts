#!/usr/bin/env node --import tsx/esm
/**
 * M1 manual smoke — drive the edge-m1 profile end-to-end against the
 * real DeepSeek API. The unit/integration tests under tests/unit/
 * stub `fetch`, but a real API call still has to be exercised by hand
 * before tagging the M1 milestone.
 *
 * Pre-reqs (env):
 *   DEEPSEEK_API_KEY=<your-key>
 *   DEEPSEEK_BASE_URL=<optional, defaults to https://api.deepseek.com>
 *
 * Run:
 *   pnpm exec tsx scripts/m1-smoke.ts "你好"
 *
 * Exit code 0 on a streamed `finish({ kind: 'stop' })`; non-zero on any
 * credential, network, or chunk-shape failure.
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const profile = join(here, '..', 'profiles', 'edge-m1.cordis.yml')

if (!process.env.DEEPSEEK_API_KEY) {
  console.error('[m1-smoke] DEEPSEEK_API_KEY is not set; aborting.')
  console.error('  export DEEPSEEK_API_KEY=sk-... and re-run.')
  process.exit(2)
}

const prompt = process.argv.slice(2).join(' ').trim() || '用一句话介绍你自己'
console.log(`[m1-smoke] profile=${profile}`)
console.log(`[m1-smoke] prompt=${prompt}`)

const child = spawn(
  'npx',
  ['-y', '--package=@deepseek-ai/dsh', 'dsh', '--config', profile, prompt],
  {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: process.env,
  },
)

child.on('error', (err) => {
  console.error(`[m1-smoke] launch failed: ${err.message}`)
  process.exit(1)
})
child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`[m1-smoke] dsh exited via signal ${signal}`)
    process.exit(1)
  }
  if (code !== 0) {
    console.error(`[m1-smoke] dsh exited with code ${code}`)
    process.exit(code ?? 1)
  }
  console.log('[m1-smoke] ✅ M1 end-to-end smoke OK')
  process.exit(0)
})