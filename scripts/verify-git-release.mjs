// scripts/verify-git-release.mjs — §7.201: the gate on the GIT publication
// (the GitHub Release the `v*` tag publishes, with the prebuilt tarballs as
// assets).
//
// ## What it exists to prevent
//
// The npm channel and the git channel are two DIFFERENT sinks for the same
// build, and they fail for different reasons:
//
//   - npm fails when the registry or the token fails (the first-publish token
//     expires 2026-11-18; direct publishing is removed in 2027-01);
//   - git fails when the tag or the GitHub side fails.
//
// Measured 2026-11-12: `publish.yml`'s release job created the GitHub Release
// with `generate_release_notes: true` and `fail_on_unmatched_files: true` —
// and **no `files:` at all** ⇒ the release carried ZERO assets. (The
// `fail_on_unmatched_files` flag is only meaningful when `files:` is set, so
// attaching files was clearly the original intent and the line was simply
// never written.)
//
// ⇒ **Neither variant was distributable**: npm ships only the safe variant
// (§7.188 — `stage:npm` stages the safe variant), and the two tarballs existed
// only as local build output under `dist/` (gitignored).
//
// ## What this script checks
//
//   1. a job creates a GitHub Release (the action that does it);
//   2. its `files:` names **every** variant's tarball **explicitly** — the
//      variant table (`scripts/_bundle-variants.mjs`) is the single source of
//      truth, so a new variant cannot be added without being published;
//   3. the `files:` list carries NO wildcard: `dist/*.tar.gz` would also match
//      the `-DEMO` tarballs, and those carry the operator's **plaintext API
//      keys** (§7.182 — `config/edge.json` is staged into them). A release is
//      public ⇒ a wildcard there is a credential leak waiting for a rebuild
//      that happens to produce the DEMO artefacts;
//   4. the list carries nothing else — an entry that matches no variant is an
//      artifact nobody can account for;
//   5. `fail_on_unmatched_files` is on (fail-closed: a missing tarball must
//      fail the release, not produce an empty release);
//   6. the release job **builds** the tarballs it attaches (`pack:tarball`)
//      and **gates** them (`verify:tarball`) — otherwise the release would
//      fail at run time with "no files matched", long after the tag was pushed;
//   7. the release job does **not** depend on the npm job — the git channel
//      must survive an npm failure, or it is not a channel, it is a mirror.
//
// Run via:
//   node scripts/verify-git-release.mjs             # audit the real workflow
//   node scripts/verify-git-release.mjs --selftest  # self-proof + refutation
//
// Exit codes: 0 = pass; 1 = the git publication is not sound; 2 = selftest failed.
//
// Read-only: writes nothing inside the repository.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse as parseYaml } from 'yaml'

import { BUNDLE_VARIANTS } from './_bundle-variants.mjs'
import { REQUIRED_BUILD_STEPS } from './verify-ci-build-chain.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORKFLOW_REL = '.github/workflows/publish.yml'

/** The action that creates a GitHub Release. */
const RELEASE_ACTION = 'softprops/action-gh-release'

/**
 * The chain the release job must run — the canonical one (§7.154/§7.156/§7.158),
 * minus `stage:npm`: the npm staging is the npm channel's business, the git
 * channel ships tarballs.
 *
 * The list is imported, not copied — `scripts/verify-ci-build-chain.mjs` is the
 * single source of truth for "which steps produce the artifacts the gates read".
 */
const RELEASE_CHAIN = REQUIRED_BUILD_STEPS.filter((s) => s !== 'stage:npm')

/**
 * The script that gates the tarballs.
 *
 * Two spellings, because a workflow step may call it either way:
 *   - `node scripts/verify-tarball.mjs`  (the FILE — a dash)
 *   - `pnpm run verify:tarball`          (the npm SCRIPT — a colon)
 */
const TARBALL_GATE_SPELLINGS = ['verify:tarball', 'verify-tarball']

/**
 * The tarball file name of a variant — the name the release must attach.
 *
 * @param {{ dir: string }} variant
 * @returns {string}
 */
export function tarballNameOf(variant) {
  return `${variant.dir}.tar.gz`
}

/**
 * Find the job that creates the GitHub Release.
 *
 * @param {any} workflow parsed publish.yml
 * @returns {{ name: string, job: any } | null}
 */
export function findReleaseJob(workflow) {
  const jobs = workflow?.jobs ?? {}
  for (const [name, job] of Object.entries(jobs)) {
    const steps = job?.steps ?? []
    if (steps.some((s) => String(s?.uses ?? '').includes(RELEASE_ACTION))) {
      return { name, job }
    }
  }
  return null
}

/**
 * The `files:` list of the release step, split into entries.
 *
 * The action accepts a multi-line string or a list; both are read here, and
 * the string form is split on newlines (which is how the action itself reads
 * a multi-line `files:`).
 *
 * @param {any} step the release step
 * @returns {string[]}
 */
export function releaseFileEntries(step) {
  const files = step?.with?.files
  if (files === undefined || files === null) return []
  if (Array.isArray(files)) return files.map((f) => String(f).trim()).filter(Boolean)
  return String(files)
    .split(/\r?\n/u)
    .map((f) => f.trim())
    .filter(Boolean)
}

/**
 * Audit the git publication.
 *
 * @param {any} workflow parsed publish.yml
 * @param {{ dir: string }[]} variants the variant table
 * @returns {{ failures: string[], attached: string[], jobName: string | null }}
 */
export function auditGitRelease(workflow, variants) {
  const failures = []
  const found = findReleaseJob(workflow)
  if (found === null) {
    failures.push(
      `no job in the workflow creates a GitHub Release (no step uses ${RELEASE_ACTION}) —`
      + ' the git publication does not exist.',
    )
    return { failures, attached: [], jobName: null }
  }
  const { name, job } = found
  const step = (job.steps ?? []).find((s) => String(s?.uses ?? '').includes(RELEASE_ACTION))
  const attached = releaseFileEntries(step)

  // 2. every variant's tarball, named explicitly.
  for (const variant of variants) {
    const expected = `dist/${tarballNameOf(variant)}`
    if (!attached.includes(expected)) {
      failures.push(
        `the release does not attach ${expected} — the git publication must ship EVERY`
        + ' variant (the variant table in scripts/_bundle-variants.mjs is the single source'
        + ' of truth; npm ships only the safe variant, so the release is the only place'
        + ' the other variants reach a user).',
      )
    }
  }

  // 3. no wildcard: `dist/*.tar.gz` would sweep in the `-DEMO` tarballs, and
  //    those carry the operator's plaintext API keys.
  for (const entry of attached) {
    if (entry.includes('*')) {
      failures.push(
        `the release attaches \`${entry}\` — a wildcard there would also match the`
        + ' `-DEMO` tarballs, which carry the operator\'s PLAINTEXT API KEYS (§7.182).'
        + ' Name every tarball explicitly.',
      )
    }
  }

  // 4. nothing that matches no variant.
  const expectedNames = new Set(variants.map((v) => `dist/${tarballNameOf(v)}`))
  for (const entry of attached) {
    if (!expectedNames.has(entry)) {
      failures.push(
        `the release attaches \`${entry}\`, which is not a variant tarball — an artifact`
        + ' nobody can account for must not reach a public release.',
      )
    }
  }

  // 5. fail-closed on a missing file.
  if (step?.with?.['fail_on_unmatched_files'] !== true) {
    failures.push(
      'the release step does not set `fail_on_unmatched_files: true` — a missing tarball'
      + ' must fail the release instead of producing an empty one.',
    )
  }

  // 6. the job builds and gates what it attaches.
  const runText = (job.steps ?? [])
    .map((s) => String(s?.run ?? ''))
    .join('\n')
  for (const step of RELEASE_CHAIN) {
    if (!runText.includes(step)) {
      failures.push(
        `the release job does not run \`${step}\` — it attaches tarballs it never built`
        + ' (a fresh checkout has no dist/ and no lib/ at all ⇒ the release would fail at'
        + ' run time, long after the tag was pushed). The release job must run the canonical'
        + ` chain (${RELEASE_CHAIN.join(' → ')}).`,
      )
    }
  }
  if (!TARBALL_GATE_SPELLINGS.some((s) => runText.includes(s))) {
    failures.push(
      `the release job does not run the tarball gate (\`${TARBALL_GATE_SPELLINGS.join('` / `')}\`)`
      + ' — tarballs must be gated in the job that ships them (the same rule the npm job follows).',
    )
  }

  // 7. independence from npm.
  const needs = job?.needs
  const needed = needs === undefined ? [] : Array.isArray(needs) ? needs : [needs]
  if (needed.includes('npm')) {
    failures.push(
      'the release job `needs: npm` — the git publication would then be hostage to the'
      + ' registry (the first-publish token expires 2026-11-18, and direct publishing is'
      + ' removed in 2027-01). The two channels are separate sinks; neither may block the other.',
    )
  }

  return { failures, attached, jobName: name }
}

/* ── self-proof + refutation ───────────────────────────────────────────── */

function selftest() {
  let failures = 0
  const expect = (label, actual, wanted) => {
    const ok = actual === wanted
    if (!ok) failures++
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label} — expected ${wanted}, got ${actual}`)
  }

  const variants = BUNDLE_VARIANTS
  const bothFiles = variants
    .map((v) => `            dist/${tarballNameOf(v)}`)
    .join('\n')

  /** A workflow fixture with one release job. */
  const fixture = (releaseWith, extra = {}) => {
    const yamlText = `name: publish
on:
  push:
    tags: ['v*']
jobs:
  npm:
    name: publish to npm
    runs-on: ubuntu-latest
    steps:
      - name: Build
        run: node scripts/run.mjs compile build:installable pack:tarball stage:npm
  release:
    name: git release
    runs-on: ubuntu-latest
${extra.needs !== undefined ? `    needs: ${extra.needs}\n` : ''}    steps:
      - name: Build
        run: node scripts/run.mjs compile typecheck:client build:client build:installable pack:tarball
      - name: Verify
        run: node scripts/verify-tarball.mjs
      - name: Create GitHub release
        uses: softprops/action-gh-release@v2
        with:
          generate_release_notes: true
          fail_on_unmatched_files: true
          files: |
${releaseWith}
`
    return parseYaml(yamlText)
  }

  const sound = fixture(bothFiles)

  console.log('verify-git-release --selftest')

  // 1. the sound shape passes.
  {
    const r = auditGitRelease(sound, variants)
    expect('两个变体都点名 ⇒ 无失败', r.failures.length, 0)
    expect('附件清单读出两条', r.attached.length, 2)
    expect('附件清单含 safe 变体', r.attached.some((f) => f.includes('desktop-safe')), true)
    expect('附件清单含 full 变体', r.attached.some((f) => f.endsWith('full.tar.gz')), true)
  }

  // 2. no release step at all.
  {
    const none = parseYaml(`name: publish\non:\n  push:\n    tags: ['v*']\njobs:\n  npm:\n    steps:\n      - run: echo hi\n`)
    const r = auditGitRelease(none, variants)
    expect('没有 release job ⇒ 报 1 项', r.failures.length, 1)
    expect('失败信息点名 action', r.failures[0].includes(RELEASE_ACTION), true)
  }

  // 3. a missing variant is caught (the full variant is the one npm does not ship).
  {
    const onlySafe = fixture(`            dist/${tarballNameOf(variants[0])}`)
    const r = auditGitRelease(onlySafe, variants)
    expect('漏掉一个变体 ⇒ 报 1 项', r.failures.length, 1)
    expect('失败信息点名 full 变体', r.failures[0].includes(tarballNameOf(variants[1])), true)
  }

  // 4. a wildcard is caught — that is the DEMO credential leak.
  {
    const wild = fixture('            dist/*.tar.gz')
    const r = auditGitRelease(wild, variants)
    // 4 failures: neither variant is named (2) + the wildcard itself (1) +
    // the wildcard is also not a known artifact (1).
    expect('通配符 ⇒ 报 4 项（两个变体没点名 + 通配符 + 不认识的附件）', r.failures.length, 4)
    expect('失败信息点名 DEMO', r.failures.some((f) => f.includes('DEMO')), true)
  }

  // 5. an unknown artifact is caught.
  {
    const extra = fixture(`${bothFiles}\n            dist/whatever.tar.gz`)
    const r = auditGitRelease(extra, variants)
    expect('多一个不认识的附件 ⇒ 报 1 项', r.failures.length, 1)
    expect('失败信息点名 whatever', r.failures[0].includes('whatever'), true)
  }

  // 6. fail_on_unmatched_files off is caught.
  {
    const noFail = parseYaml(`name: publish\non:\n  push:\n    tags: ['v*']\njobs:\n  release:\n    steps:\n      - run: node scripts/run.mjs compile typecheck:client build:client build:installable pack:tarball\n      - run: node scripts/verify-tarball.mjs\n      - uses: softprops/action-gh-release@v2\n        with:\n          files: |\n${bothFiles}\n`)
    const r = auditGitRelease(noFail, variants)
    expect('没开 fail_on_unmatched_files ⇒ 报 1 项', r.failures.length, 1)
    expect('失败信息点名 fail_on_unmatched_files', r.failures[0].includes('fail_on_unmatched_files'), true)
  }

  // 7. the job that attaches tarballs it never built is caught.
  {
    const noBuild = parseYaml(`name: publish\non:\n  push:\n    tags: ['v*']\njobs:\n  release:\n    steps:\n      - run: node scripts/run.mjs compile typecheck:client build:client build:installable\n      - run: node scripts/verify-tarball.mjs\n      - uses: softprops/action-gh-release@v2\n        with:\n          fail_on_unmatched_files: true\n          files: |\n${bothFiles}\n`)
    const r = auditGitRelease(noBuild, variants)
    expect('没跑 pack:tarball ⇒ 报 1 项', r.failures.length, 1)
    expect('失败信息点名 pack:tarball', r.failures[0].includes('pack:tarball'), true)
  }

  // 8. the job that attaches ungated tarballs is caught.
  {
    const noGate = parseYaml(`name: publish\non:\n  push:\n    tags: ['v*']\njobs:\n  release:\n    steps:\n      - run: node scripts/run.mjs compile typecheck:client build:client build:installable pack:tarball\n      - uses: softprops/action-gh-release@v2\n        with:\n          fail_on_unmatched_files: true\n          files: |\n${bothFiles}\n`)
    const r = auditGitRelease(noGate, variants)
    expect('没跑 verify:tarball ⇒ 报 1 项', r.failures.length, 1)
    expect('失败信息点名 verify:tarball', r.failures[0].includes('verify:tarball'), true)
  }

  // 9. `needs: npm` is caught — the git channel must not be hostage to the registry.
  {
    const coupled = fixture(bothFiles, { needs: 'npm' })
    const r = auditGitRelease(coupled, variants)
    expect('needs: npm ⇒ 报 1 项', r.failures.length, 1)
    expect('失败信息点名 npm', r.failures[0].includes('npm'), true)
  }

  if (failures > 0) {
    console.error(`\nselftest FAILED: ${failures} assertion(s)`)
    process.exit(2)
  }
  console.log('\nselftest OK —— 门禁能抓住「只挂一个变体 / 用通配符 / 不建不验 / 依赖 npm」这四类退化')
}

/* ── entry ──────────────────────────────────────────────────────────────── */

const args = process.argv.slice(2)

/**
 * Run the audit against the real workflow.
 */
function main() {
  const path = join(ROOT, WORKFLOW_REL)
  if (!existsSync(path)) {
    console.error(`verify-git-release: missing ${WORKFLOW_REL}`)
    process.exit(1)
  }
  const workflow = parseYaml(readFileSync(path, 'utf8'))
  const result = auditGitRelease(workflow, BUNDLE_VARIANTS)

  console.log('verify-git-release')
  console.log(`  变体表（单一事实源）: ${BUNDLE_VARIANTS.map((v) => v.dir).join(', ')}`)
  console.log(`  发布 job          : ${result.jobName ?? '(没有)'}`)
  console.log(`  附件清单          : ${result.attached.length ? result.attached.join(' , ') : '(空)'}`)
  console.log(`  失败              : ${result.failures.length}`)

  if (result.failures.length > 0) {
    console.log('\n失败明细：')
    for (const f of result.failures) console.log(`  - ${f}`)
    console.error('\nFAIL')
    process.exit(1)
  }
  console.log('\nPASS')
}

// 只在**直接执行**本文件时跑入口 —— 否则 import 本模块（调试、别的门禁复用
// 它的函数）会连带执行审计并 process.exit，把调用方的进程直接带走。
const isEntry = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isEntry) {
  if (args.includes('--selftest')) {
    selftest()
  } else if (args.length > 0) {
    console.error('usage: node scripts/verify-git-release.mjs [--selftest]')
    process.exit(2)
  } else {
    main()
  }
}
