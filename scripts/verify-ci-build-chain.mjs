// scripts/verify-ci-build-chain.mjs — §7.154: the gate that gates the gate.
//
// ## The failure it exists to prevent
//
// `verify:build` verifies ARTIFACTS, not sources:
//
//   scripts/_simulate-client-mount.mjs  hard-reads lib/client.js
//   scripts/verify-installable.mjs      reads dist/installable/<variant>/
//
// Those two artifacts come from steps that `pnpm run compile` does NOT
// perform: `compile` = clean-lib + tsc, and clean-lib wipes lib/ entirely,
// so tsc only rebuilds the server half. The browser half is a separate
// esbuild step (build:client) and the shipped bundle is another
// (build:installable).
//
// CI's build job ran `compile` and then `verify:build` ⇒ ENOENT ⇒ **every
// push to main has been red since §7.106 (2026-10-20)**. The failure was
// silent from the repo's side: nothing in the tree said which build steps
// the gates depend on, so nothing noticed the workflow was missing them.
//
// ## What this script checks
//
// 1. `.github/workflows/ci.yml` exists and parses as text we can inspect;
// 2. the `build` job runs the artifact-producing chain — every one of
//    compile / build:client / build:installable must appear in the job's
//    `run:` lines (either spelled out or reached through `npm run build` /
//    `node scripts/run.mjs <chain>`);
// 3. that chain matches package.json#scripts.build — the local build and
//    the CI build must not drift apart;
// 4. every script name the chain references actually exists in
//    package.json#scripts.
//
// A dropped step in ci.yml turns this script red BEFORE the push, instead
// of after.
//
// Run via: node scripts/verify-ci-build-chain.mjs

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORKFLOW = join(ROOT, '.github', 'workflows', 'ci.yml')

/** Steps whose products the gates read. Missing one ⇒ the gate reads ENOENT. */
const REQUIRED_BUILD_STEPS = ['compile', 'build:client', 'build:installable']

const failures = []

if (!existsSync(WORKFLOW)) {
  console.error(`verify-ci-build-chain: missing ${relative(ROOT, WORKFLOW)}`)
  process.exit(1)
}

const workflow = readFileSync(WORKFLOW, 'utf8')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const scripts = pkg.scripts ?? {}

// ── 1. isolate the `build` job ────────────────────────────────────────────
//
// The workflow has three jobs (build / test / e2e-opslog). Only the
// `build` job runs the gates, so only it has to produce the artifacts.
// Everything between the job header and the next top-level job header is
// that job's body.
const jobHeader = /^\s{2}build:\s*$/m.exec(workflow)
if (!jobHeader) {
  console.error('verify-ci-build-chain: no `build:` job found in ci.yml')
  process.exit(1)
}
const afterHeader = workflow.slice(jobHeader.index + jobHeader[0].length)
const nextJob = /^\s{2}[A-Za-z][\w-]*:\s*$/m.exec(afterHeader)
const buildJob = nextJob ? afterHeader.slice(0, nextJob.index) : afterHeader

// ── 2. the build job must produce every artifact the gates read ──────────
//
// Collect the shell text of every `run:` line in the job, then look for
// each required step name. `node scripts/run.mjs a b c` and
// `npm run build` are both accepted: the former names the steps directly,
// the latter reaches them through package.json#scripts.build.
const runLines = [...buildJob.matchAll(/^\s*run:\s*(.+)$/gm)].map((m) => m[1])
const runText = runLines.join('\n')

const mentionsBuildScript = /\bnpm run build\b/.test(runText)
  || /\bnode scripts\/run\.mjs\b[^\n]*\bbuild\b/.test(runText)

for (const step of REQUIRED_BUILD_STEPS) {
  const mentioned = runText.includes(step)
  if (!mentioned && !mentionsBuildScript) {
    failures.push(
      `ci.yml's build job does not run "${step}" — verify:build reads the artifact it`
      + ' produces (lib/client.js / dist/installable/), so the gate would fail with'
      + ' ENOENT instead of with a useful message.',
    )
  }
}

// ── 3. the CI chain must match package.json#scripts.build ────────────────
//
// The local build (npm run build) and the CI build must produce the same
// artifacts. If the local chain grows a step (or loses one) and ci.yml is
// not updated, the two drift — and the drift is invisible until a gate
// breaks somewhere else.
const localBuild = (scripts.build ?? '').trim()
if (!localBuild) {
  failures.push('package.json has no "build" script to compare ci.yml against.')
} else {
  const localSteps = localBuild
    .replace(/^node scripts\/run\.mjs\s+/u, '')
    .split(/\s+/u)
    .filter(Boolean)
  for (const step of REQUIRED_BUILD_STEPS) {
    if (!localSteps.includes(step)) {
      failures.push(
        `package.json#scripts.build does not include "${step}" — the gates need its`
        + ' artifact. Add the step to the build script (and to ci.yml).',
      )
    }
  }
}

// ── 4. every referenced script must exist ─────────────────────────────────
const referenced = new Set()
for (const line of runLines) {
  const m = /node scripts\/run\.mjs\s+(.+)$/u.exec(line.trim())
  if (!m) continue
  for (const name of m[1].split(/\s+/u)) referenced.add(name)
}
for (const name of referenced) {
  if (name === 'build' || name === 'verify:build') continue
  if (scripts[name] === undefined) {
    failures.push(`ci.yml runs "${name}" but package.json#scripts has no such script.`)
  }
}

if (failures.length > 0) {
  console.error('verify-ci-build-chain: CI build chain is not sound:')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}

console.log(
  'verify-ci-build-chain OK '
  + `(ci.yml build job produces: ${REQUIRED_BUILD_STEPS.join(', ')})`,
)
