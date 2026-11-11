// scripts/verify-ci-build-chain.mjs — §7.154: the gate that gates the gate.
// §7.156: extended from ci.yml to ci.yml AND publish.yml.
//
// ## The failure it exists to prevent
//
// `verify:build` verifies ARTIFACTS, not sources:
//
//   scripts/_simulate-client-mount.mjs  hard-reads lib/client.js
//   scripts/verify-installable.mjs      reads dist/installable/<variant>/
//   scripts/verify-tarball.mjs           reads dist/<variant>.tar.gz
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
// §7.154 fixed ci.yml. §7.156 found the SAME shape still alive in
// publish.yml — the npm publishing job ran `pnpm run compile` and then
// `pnpm run verify:build`, so it died at the Verify step with
//   "package exports missing from tarball: lib/client.js"
// and never reached `pnpm publish` at all. Nobody noticed because the
// repository had never pushed a `v*` tag.
//
// The gate therefore covers BOTH workflows now. A workflow that builds
// artifacts for the gates must run the whole chain.
//
// §7.158: the same shape reappeared one step further along. §7.157 added
// verify-tarball to verify:build — the gate audits dist/<variant>.tar.gz —
// but neither workflow produced the tarballs, so the job would have died at
// the Verify step with "tarball 不存在". `pack:tarball` joined the chain and
// REQUIRED_BUILD_STEPS grew to match.
//
// ## What this script checks
//
// For each workflow below:
//   1. the file exists (required ones must);
//   2. the named job runs the artifact-producing chain — every one of
//      compile / build:client / build:installable must appear in the job's
//      `run:` lines (either spelled out or reached through `npm run build` /
//      `node scripts/run.mjs <chain>`);
//   3. that chain matches package.json#scripts.build — the local build and
//      the CI build must not drift apart;
//   4. every script name the chain references actually exists in
//      package.json#scripts.
//
// A dropped step in a workflow turns this script red BEFORE the push,
// instead of after.
//
// Run via:
//   node scripts/verify-ci-build-chain.mjs            # audit the real tree
//   node scripts/verify-ci-build-chain.mjs --selftest # self-proof + refutation
//
// Exit codes: 0 = pass; 1 = the chain is not sound; 2 = selftest failed.
//
// Read-only: writes nothing inside the repository.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Steps whose products the gates read. Missing one ⇒ the gate reads ENOENT.
 *
 * §7.188: `stage:npm` joined the list — `verify:npm-stage` reads
 * `dist/.npm-stage/`, and the publish job now runs `pnpm publish` **from that
 * directory** ⇒ a workflow that skipped the step would die at the Publish step
 * with "no such directory" instead of at the gate with a useful message.
 */
const REQUIRED_BUILD_STEPS = ['compile', 'build:client', 'build:installable', 'pack:tarball', 'stage:npm']

/**
 * The workflows that build artifacts for the gates, and the job in each that
 * does the building.
 *
 * `required: true` — the file must exist; a missing one is a failure.
 * `required: false` — the file may legitimately be absent (a repo that does
 * not publish to npm); but when it IS present its build job must satisfy the
 * chain.
 */
const WORKFLOWS = [
  { file: 'ci.yml', job: 'build', required: true },
  { file: 'publish.yml', job: 'npm', required: false },
]

/**
 * Isolate one job's body from a workflow's text.
 *
 * The job header is a two-space-indented `name:` line; the body runs until
 * the next job header at the same indent. `[ \t]` rather than `\s` on
 * purpose: `\s` matches a newline, so `^\s{2}` could straddle a line break
 * and match something that is not a job header at all.
 *
 * @param {string} workflow
 * @param {string} jobName
 * @returns {string | null} the job body, or null when the job is absent
 */
export function extractJob(workflow, jobName) {
  const header = new RegExp(`^[ \\t]{2}${jobName}:[ \\t]*$`, 'm')
  const match = header.exec(workflow)
  if (!match) return null
  const after = workflow.slice(match.index + match[0].length)
  const next = /^[ \t]{2}[A-Za-z][\w-]*:[ \t]*$/m.exec(after)
  return next ? after.slice(0, next.index) : after
}

/**
 * Audit one workflow's build job against the required chain.
 *
 * @param {string} workflowText
 * @param {string} jobName
 * @param {Record<string, string>} scripts package.json#scripts
 * @returns {{ failures: string[], runText: string, foundJob: boolean }}
 */
export function auditJob(workflowText, jobName, scripts) {
  const failures = []
  const body = extractJob(workflowText, jobName)
  if (body === null) {
    return { failures: [`no \`${jobName}:\` job found`], runText: '', foundJob: false }
  }

  // ── the job must produce every artifact the gates read ──────────────────
  //
  // Collect the shell text of every `run:` line in the job, then look for
  // each required step name. `node scripts/run.mjs a b c` names the steps
  // directly; `npm run build` reaches them through package.json#scripts.build
  // (which is audited separately below — it must contain every required step,
  // so reaching the chain that way is sound).
  const runLines = [...body.matchAll(/^[ \t]*(?:-[ \t]+)?run:[ \t]*(.+)$/gm)].map((m) => m[1])
  const runText = runLines.join('\n')

  // §7.158: the escape hatch used to be
  //   /\bnode scripts\/run\.mjs\b[^\n]*\bbuild\b/
  // and `build:client` satisfies `\bbuild\b` (`:` is a non-word character, so
  // the boundary holds). EVERY chain that mentioned build:client therefore
  // short-circuited the whole per-step check — the gate went green with
  // `build:installable` deleted from the workflow. In other words the
  // §7.154/§7.156 fixes were right about the WORKFLOWS but the gate never
  // actually pinned them; the regression they were supposed to prevent was
  // still open.
  //
  // The only sound exemption is an explicit `npm run build` / `pnpm run
  // build` — a script name, not a prefix. `(?![\w:-])` keeps `npm run
  // build:client` and `npm run build-installable` from matching.
  const mentionsBuildScript = /(?:^|[\s;&|(])(?:npm|pnpm) run build(?![\w:-])/mu.test(runText)

  for (const step of REQUIRED_BUILD_STEPS) {
    const mentioned = runText.includes(step)
    if (!mentioned && !mentionsBuildScript) {
      failures.push(
        `the \`${jobName}\` job does not run "${step}" — verify:build reads the artifact it`
        + ' produces (lib/client.js / dist/installable/ / dist/*.tar.gz), so the gate'
        + ' would fail with ENOENT instead of with a useful message.',
      )
    }
  }

  // ── the CI chain must match package.json#scripts.build ──────────────────
  //
  // The local build (npm run build) and the CI build must produce the same
  // artifacts. If the local chain grows a step (or loses one) and the
  // workflow is not updated, the two drift — and the drift is invisible
  // until a gate breaks somewhere else.
  const localBuild = (scripts.build ?? '').trim()
  if (!localBuild) {
    failures.push('package.json has no "build" script to compare the workflow against.')
  } else {
    const localSteps = localBuild
      .replace(/^node scripts\/run\.mjs\s+/u, '')
      .split(/\s+/u)
      .filter(Boolean)
    for (const step of REQUIRED_BUILD_STEPS) {
      if (!localSteps.includes(step)) {
        failures.push(
          `package.json#scripts.build does not include "${step}" — the gates need its`
          + ' artifact. Add the step to the build script (and to the workflow).',
        )
      }
    }
  }

  // ── every referenced script must exist ─────────────────────────────────
  const referenced = new Set()
  for (const line of runLines) {
    const m = /node scripts\/run\.mjs\s+(.+)$/u.exec(line.trim())
    if (!m) continue
    for (const name of m[1].split(/\s+/u)) referenced.add(name)
  }
  for (const name of referenced) {
    if (name === 'build' || name === 'verify:build') continue
    if (scripts[name] === undefined) {
      failures.push(`the workflow runs "${name}" but package.json#scripts has no such script.`)
    }
  }

  return { failures, runText, foundJob: true }
}

/* ── self-proof + refutation ───────────────────────────────────────────── */

/**
 * Build minimal workflow fixtures in memory and assert the auditor turns red
 * for a broken chain and green for a sound one.
 *
 * Refutation: manufacture the defect, the gate MUST report it; repair it,
 * the gate MUST let it through.
 */
function selftest() {
  let failures = 0
  const expect = (label, actual, wanted) => {
    const ok = actual === wanted
    if (!ok) failures++
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label} — expected ${wanted}, got ${actual}`)
  }

  // package.json#scripts as the real one has it: the full chain.
  const scripts = {
    build: 'node scripts/run.mjs compile typecheck:client build:client build:installable pack:tarball stage:npm verify:build',
    compile: 'node scripts/clean-lib.mjs && tsc -p tsconfig.json',
    'typecheck:client': 'tsc -p tsconfig.client.json',
    'build:client': 'node scripts/build-client.mjs',
    'build:installable': 'node scripts/rebuild-installable.mjs',
    'pack:tarball': 'node scripts/_pack-core.mjs tarball',
    'stage:npm': 'node scripts/stage-npm-publish.mjs',
    'verify:build': 'node scripts/run.mjs verify:boundary',
  }

  // A fixture in the shape a real workflow uses: block-style `run:` on its
  // own line under a step. (The auditor also accepts the flow-style
  // `- run: …` one-liner; the fixture uses the block form because that is
  // what actions/checkout-era workflows actually contain.)
  const wrap = (runBody) => `name: fixture\non: push\njobs:\n  build:\n    steps:\n      - name: a step\n        run: ${runBody}\n`

  console.log('verify-ci-build-chain --selftest')

  // 1. the sound chain passes.
  {
    const r = auditJob(wrap('      - run: node scripts/run.mjs compile typecheck:client build:client build:installable pack:tarball stage:npm'), 'build', scripts)
    expect('完整链 ⇒ 无失败', r.failures.length, 0)
  }

  // 2. the §7.104 defect — compile only — is caught, and the message names
  //    the missing step (this is the exact shape that reddened CI since
  //    §7.106 and that reddened publish.yml until §7.156).
  {
    const r = auditJob(wrap('      - run: pnpm run compile'), 'build', scripts)
    expect('只跑 compile ⇒ 报 4 项失败', r.failures.length, 4)
    expect('失败信息点名 build:client', r.failures.some((f) => f.includes('build:client')), true)
    expect('失败信息点名 build:installable', r.failures.some((f) => f.includes('build:installable')), true)
    expect('失败信息点名 pack:tarball', r.failures.some((f) => f.includes('pack:tarball')), true)
    expect('失败信息点名 stage:npm', r.failures.some((f) => f.includes('stage:npm')), true)
  }

  // 3. reaching the chain through `npm run build` is accepted.
  {
    const r = auditJob(wrap('      - run: npm run build'), 'build', scripts)
    expect('npm run build ⇒ 无失败', r.failures.length, 0)
  }

  // 4. a workflow naming a script that does not exist is caught.
  {
    const r = auditJob(wrap('      - run: node scripts/run.mjs compile build:client build:installable pack:tarball stage:npm build:nope'), 'build', scripts)
    expect('引用不存在的脚本 ⇒ 报 1 项失败', r.failures.length, 1)
    expect('失败信息点名 build:nope', r.failures.some((f) => f.includes('build:nope')), true)
  }

  // 5. package.json#scripts.build losing a step is caught.
  {
    const thin = { ...scripts, build: 'node scripts/run.mjs compile' }
    const r = auditJob(wrap('      - run: node scripts/run.mjs compile typecheck:client build:client build:installable pack:tarball stage:npm'), 'build', thin)
    expect('本地 build 少了步骤 ⇒ 报 4 项失败', r.failures.length, 4)
    expect('失败信息点名 build:client', r.failures.some((f) => f.includes('build:client')), true)
  }

  // 6. a missing job is caught.
  {
    const r = auditJob(wrap('      - run: pnpm run compile'), 'npm', scripts)
    expect('job 不存在 ⇒ 报 1 项失败', r.failures.length, 1)
    expect('失败信息点名 job 名', r.failures[0].includes('`npm:`'), true)
  }

  // 7. the job extractor must not be fooled by a same-named key nested deeper
  //    (a step's own `build:` key would otherwise truncate the body).
  {
    const nested = [
      'name: fixture',
      'on: push',
      'jobs:',
      '  build:',
      '    steps:',
      '      - name: a step',
      '        with:',
      '          build: something',
      '      - name: another step',
      '        run: pnpm run compile',
      '',
    ].join('\n')
    const body = extractJob(nested, 'build') ?? ''
    expect('嵌套的 build: 键不截断 job 体', body.includes('pnpm run compile'), true)
  }

  // 8. §7.158 regression: a chain that produces everything EXCEPT the
  //    tarballs. §7.157 put verify:tarball into verify:build, and both
  //    workflows ran the gates without producing dist/*.tar.gz ⇒ the job
  //    died at the Verify step. This assertion pins that shape.
  //
  //    §7.188: the fixture keeps `stage:npm` in the chain so this case stays
  //    exactly "missing pack:tarball" (one failure) — the missing-stage:npm
  //    case is case 2 above.
  {
    const r = auditJob(wrap('      - run: node scripts/run.mjs compile typecheck:client build:client build:installable stage:npm'), 'build', scripts)
    expect('少了 pack:tarball ⇒ 报 1 项失败', r.failures.length, 1)
    expect('失败信息点名 pack:tarball', r.failures.some((f) => f.includes('pack:tarball')), true)
  }

  if (failures > 0) {
    console.error(`\nselftest FAILED: ${failures} assertion(s)`)
    process.exit(2)
  }
  console.log('\nselftest OK — 门禁能抓住缺步骤的构建链，也能放过完整的链')
}

/* ── entry ──────────────────────────────────────────────────────────────── */

const args = process.argv.slice(2)
if (args.includes('--selftest')) {
  selftest()
} else if (args.length > 0) {
  console.error('usage: node scripts/verify-ci-build-chain.mjs [--selftest]')
  process.exit(2)
} else {
  const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts ?? {}
  const failures = []
  const audited = []

  for (const target of WORKFLOWS) {
    const path = join(ROOT, '.github', 'workflows', target.file)
    if (!existsSync(path)) {
      if (target.required) {
        failures.push(`missing .github/workflows/${target.file}`)
      } else {
        console.log(`verify-ci-build-chain: ${target.file} not present — skipped`)
        continue
      }
    }
    const workflow = readFileSync(path, 'utf8')
    const result = auditJob(workflow, target.job, scripts)
    for (const f of result.failures) {
      failures.push(`${target.file}: ${f}`)
    }
    audited.push(`${target.file}(${target.job})`)
  }

  if (failures.length > 0) {
    console.error('verify-ci-build-chain: CI build chain is not sound:')
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }

  console.log(
    'verify-ci-build-chain OK '
    + `(audited: ${audited.join(', ')}; required steps: ${REQUIRED_BUILD_STEPS.join(', ')})`,
  )
}
