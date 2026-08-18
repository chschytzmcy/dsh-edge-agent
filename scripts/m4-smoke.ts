#!/usr/bin/env node --import tsx/esm
/**
 * M4 manual smoke — verify the local-llm-adapter (mock + real) and
 * cloud-llm-adapter dispatch through the same `ctx.llm` runtime.
 *
 * Three runs share the `edge-m1` profile and only differ in env:
 *
 *   1. `mock`   — `DSH_EDGE_PROVIDER=local-qwen3-4b-mock` (no network).
 *                 Asserts the assistant prints `[LOCAL-MOCK] {prompt}`.
 *   2. `cloud`  — `DSH_EDGE_PROVIDER=cloud-deepseek-v4` (DeepSeek API).
 *                 Requires `DEEPSEEK_API_KEY`. Asserts the response is
 *                 NOT the mock echo, so the cloud path actually ran.
 *   3. `real`   — `DSH_EDGE_PROVIDER=local-qwen3-4b` and
 *                 `DSH_EDGE_LOCAL_LLM_MODE=real` with `DSH_EDGE_LOCAL_LLM_BASEURL`
 *                 pointing at the LAN endpoint. Skipped when the env
 *                 point is unreachable (no `DSH_EDGE_REAL_LLM_REQUIRED=1`).
 *
 * Run: `pnpm exec tsx scripts/m4-smoke.ts`. Exit code 0 when every
 * requested run completes successfully.
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const profile = join(here, '..', 'profiles', 'edge-m1.cordis.yml')

interface RunSpec {
  label: string
  provider: string
  extraEnv: Record<string, string>
  /**
   * Substring that MUST appear in stdout. Pass `null` to assert the
   * absence of a substring instead.
   */
  mustContain?: string
  mustNotContain?: string
  skipReason?: string
}

const prompt = '今天天气怎么样？只用一句话回答。'
const baseUrl = process.env.DSH_EDGE_LOCAL_LLM_BASEURL ?? 'http://192.168.66.195:8701/v1'
const requireReal = process.env.DSH_EDGE_REAL_LLM_REQUIRED === '1'

const runs: RunSpec[] = [
  {
    label: 'mock',
    provider: 'local-qwen3-4b-mock',
    extraEnv: {},
    mustContain: `[LOCAL-MOCK] ${prompt}`,
  },
  {
    label: 'cloud',
    provider: 'cloud-deepseek-v4',
    extraEnv: {},
    mustNotContain: '[LOCAL-MOCK]',
    skipReason: process.env.DEEPSEEK_API_KEY ? undefined : 'DEEPSEEK_API_KEY is not set',
  },
  {
    label: 'real',
    provider: 'local-qwen3-4b',
    extraEnv: {
      DSH_EDGE_LOCAL_LLM_MODE: 'real',
      DSH_EDGE_LOCAL_LLM_BASEURL: baseUrl,
    },
    mustNotContain: '[LOCAL-MOCK]',
    skipReason: requireReal
      ? undefined
      : 'set DSH_EDGE_REAL_LLM_REQUIRED=1 to enable the LAN llama.cpp run',
  },
]

async function runOnce(spec: RunSpec): Promise<{ exitCode: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'npx',
      ['-y', '--package=@deepseek-ai/dsh', 'dsh', '--config', profile, prompt],
      {
        stdio: ['ignore', 'pipe', 'inherit'],
        env: {
          ...process.env,
          ...spec.extraEnv,
          DSH_EDGE_PROVIDER: spec.provider,
          DSH_EDGE_MODEL: spec.provider,
        },
      },
    )
    let stdout = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf-8')
    })
    child.on('error', reject)
    child.on('exit', (code) => resolve({ exitCode: code ?? 1, stdout }))
  })
}

let failures = 0

for (const spec of runs) {
  if (spec.skipReason !== undefined) {
    console.log(`[m4-smoke] skip ${spec.label}: ${spec.skipReason}`)
    continue
  }
  console.log(`[m4-smoke] run ${spec.label} (provider=${spec.provider})`)
  const { exitCode, stdout } = await runOnce(spec)
  if (exitCode !== 0) {
    console.error(`[m4-smoke] FAILED: ${spec.label} dsh exit ${exitCode}`)
    failures += 1
    continue
  }
  if (spec.mustContain !== undefined && !stdout.includes(spec.mustContain)) {
    console.error(`[m4-smoke] FAILED: ${spec.label} stdout missing "${spec.mustContain}"`)
    console.error('--- captured stdout ---')
    console.error(stdout)
    failures += 1
    continue
  }
  if (spec.mustNotContain !== undefined && stdout.includes(spec.mustNotContain)) {
    console.error(`[m4-smoke] FAILED: ${spec.label} stdout contained forbidden "${spec.mustNotContain}"`)
    console.error('--- captured stdout ---')
    console.error(stdout)
    failures += 1
    continue
  }
  console.log(`[m4-smoke] ✅ ${spec.label} OK`)
}

if (failures > 0) {
  console.error(`[m4-smoke] ${failures} run(s) failed`)
  process.exit(1)
}
console.log('[m4-smoke] ✅ all requested routes passed')
process.exit(0)
