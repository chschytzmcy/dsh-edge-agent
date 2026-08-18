#!/usr/bin/env node --import tsx/esm
/**
 * M4 manual smoke — verify the local-llm-adapter (mock + real) and
 * cloud-llm-adapter dispatch through the same `ctx.llm` runtime.
 *
 * Three runs share the `dsh-edge-agent` profile and only differ in env:
 *
 *   1. `mock`   — `DSH_EDGE_PROVIDER=local-qwen3-4b-mock` (no network).
 *                 Asserts the assistant prints `[LOCAL-MOCK]` at least
 *                 once (the mock echoes its entire input back, so the
 *                 exact prompt text may be preceded by the headless
 *                 runner's system-preamble).
 *   2. `cloud`  — `DSH_EDGE_PROVIDER=cloud-deepseek-v4` (DeepSeek API).
 *                 Requires `DEEPSEEK_API_KEY` to be in the launching
 *                 environment. Asserts the response is NOT the mock
 *                 echo, so the cloud path actually ran.
 *   3. `real`   — `DSH_EDGE_PROVIDER=local-qwen3-4b`,
 *                 `DSH_EDGE_LOCAL_LLM_MODE=real`, and
 *                 `DSH_EDGE_MODEL=qwen3-4b-instruct-2507` (the wire-model
 *                 id reported by `GET /v1/models`) so the LAN endpoint
 *                 `http://192.168.66.195:8701/v1` can resolve it. Skipped
 *                 unless `DSH_EDGE_REAL_LLM_REQUIRED=1`.
 *
 * The smoke uses the `dsh-edge-agent` profile whose `cordis.patch.yml`
 * sits in `$DSH_HOME/profiles/dsh-edge-agent/`. That patch disables
 * upstream tool/web/subagent/workflow rows so the qwen3-4b context
 * window (13 000 tokens) is not exceeded by the bundled system prompt.
 * Re-enable those rows when targeting a larger-context backend.
 *
 * Run: `pnpm exec tsx scripts/m4-smoke.ts`. Exit code 0 when every
 * requested run completes successfully.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const prompt = '今天天气怎么样？只用一句话回答。'
const realModel = process.env.DSH_EDGE_LOCAL_LLM_MODEL ?? 'qwen3-4b-instruct-2507'
const baseUrl = process.env.DSH_EDGE_LOCAL_LLM_BASEURL ?? 'http://192.168.66.195:8701/v1'
const requireReal = process.env.DSH_EDGE_REAL_LLM_REQUIRED === '1'

interface RunSpec {
  label: string
  provider: string
  model: string
  extraEnv: Record<string, string>
  /** Substring that MUST appear in stdout. */
  mustContain?: string
  /** Substring that MUST NOT appear in stdout. */
  mustNotContain?: string
  skipReason?: string
}

const runs: RunSpec[] = [
  {
    label: 'mock',
    provider: 'local-qwen3-4b-mock',
    model: 'local-qwen3-4b-mock',
    extraEnv: {},
    mustContain: '[LOCAL-MOCK]',
  },
  {
    label: 'cloud',
    provider: 'cloud-deepseek-v4',
    model: 'deepseek-chat',
    extraEnv: {},
    mustNotContain: '[LOCAL-MOCK]',
    skipReason: process.env.DEEPSEEK_API_KEY ? undefined : 'DEEPSEEK_API_KEY is not set',
  },
  {
    label: 'real',
    provider: 'local-qwen3-4b',
    model: realModel,
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

// Surface any obvious environment gaps before launching dsh.
const profilePath = `${homedir()}/.dsh-home/profiles/dsh-edge-agent/cordis.yml`
if (!existsSync(profilePath)) {
  // Just a hint — dsh will fail loud if the profile is missing.
}

async function runOnce(spec: RunSpec): Promise<{ exitCode: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'dsh',
      ['--profile', 'dsh-edge-agent', prompt],
      {
        stdio: ['ignore', 'pipe', 'inherit'],
        env: {
          ...process.env,
          ...spec.extraEnv,
          DSH_EDGE_PROVIDER: spec.provider,
          DSH_EDGE_MODEL: spec.model,
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
  console.log(`[m4-smoke] run ${spec.label} (provider=${spec.provider}, model=${spec.model})`)
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