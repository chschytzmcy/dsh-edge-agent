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
//      package.json#scripts;
//   5. §7.198: no `if:` condition may reference `secrets.` — GitHub forbids
//      secrets directly in if conditions, and doing it invalidates the WHOLE
//      workflow file (the run shows the file path as its name and has no
//      jobs ⇒ the whole CI dies with no log and no annotation to read).
//   6. §7.199: vitest parameters must NOT be forwarded through `pnpm test -- …`.
//      pnpm versions differ on whether the literal `--` reaches the script,
//      and vitest's CLI parser (cac) treats everything after `--` as POSITIONAL
//      FILTERS ⇒ `--reporter=json` / `--outputFile=…` are silently dropped and
//      the run still exits 0. The parameters must live in package.json#scripts
//      ("test:ci") and the workflow must call that script by name.
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
 *
 * §7.201: exported so `verify-git-release.mjs` can require the SAME chain in
 * the job that ships the tarballs (minus `stage:npm`, which is the npm
 * staging) instead of keeping a second copy of the list.
 */
export const REQUIRED_BUILD_STEPS = ['compile', 'build:client', 'build:installable', 'pack:tarball', 'stage:npm']

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
  { file: 'publish.yml', job: 'npm', required: false, npmFace: true },
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
 * §7.198: GitHub **禁止在 `if:` 条件里直接引用 `secrets`** ——
 * 那样写会让**整个 workflow 文件被判无效**：
 *   - run 的名字变成文件路径（".github/workflows/ci.yml"），不是 workflow 的 `name:`；
 *   - jobs 列表为空（一个 job 都没起来）；
 *   - 整条 CI 直接挂，而且**看不出原因**（没有 log、没有注解 —— 实测 run #151）。
 *
 * 正确写法：secret 进 **job 级 env**，step 的 `if:` 用 `env.` 上下文引用
 * （`env` 上下文在 step 级 if 里是可用的，`secrets` 不是）。
 *
 * 这道检查放在这里，是因为本门禁本来就是「读两个 workflow 文件」的地方 ——
 * 同一个文件里的另一类「CI 挂了但看不出为什么」的坑，一并挡住。
 *
 * @param {string} workflowText
 * @returns {string[]} the offending `if:` expressions (empty when sound)
 */
export function findSecretInIf(workflowText) {
  const problems = []
  for (const m of workflowText.matchAll(/^[ \t]*(?:-[ \t]+)?if:[ \t]*(.+)$/gmu)) {
    if (/\bsecrets\./u.test(m[1])) problems.push(m[1].trim())
  }
  return problems
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

/**
 * §7.199: vitest 的参数**不能**靠 `pnpm test -- …` 转发。
 *
 * 实测（run #153）：runner 上 `pnpm test -- --run --reporter=json
 * --outputFile=/tmp/vitest.json` **没把参数交给 vitest** —— pnpm 把**字面 `--`**
 * 透传给了脚本，vitest 的 CLI 解析器（cac）把 `--` 之后的一切当成**位置过滤器**
 * ⇒ `--reporter=json` / `--outputFile=…` 被静默丢弃 ⇒ 跑的是默认 reporter、
 * 报告文件不生成、**退出码仍是 0**。本机可重复复现（逐条同症状）：
 *   node node_modules/vitest/vitest.mjs run tests/unit -- --reporter=json --outputFile=X
 *
 * 修法：参数烤进 package.json#scripts["test:ci"]，workflow 只调脚本名。
 *
 * 这里挡的是「写法回归」：有人图省事把命令改回 `pnpm test -- …`，症状是
 * **假绿**（测试照跑、退出码 0），比红更危险 —— 所以必须挡住。
 *
 * 注释行不算（文档里经常要写出这个坏例子）。
 *
 * @param {string} workflowText
 * @returns {string[]} the offending lines (empty when sound)
 */
export function findVitestArgForwarding(workflowText) {
  const problems = []
  for (const line of workflowText.split(/\r?\n/u)) {
    if (line.trim().startsWith('#')) continue
    const m = /\b(?:npm|pnpm)\s+(?:run\s+)?test\b/u.exec(line)
    if (!m) continue
    const after = line.slice(m.index + m[0].length)
    // 命中 `--`（后面还跟着东西）⇒ 参数转发写法。
    if (/(?:^|\s)--(?!\s*$)/u.test(after)) problems.push(line.trim())
  }
  return problems
}

/**
 * §7.199: package.json 里的 `test:ci` 脚本必须自带 reporter 与 outputFile。
 *
 * @param {Record<string, string>} scripts package.json#scripts
 * @returns {string[]} the problems (empty when sound)
 */
export function auditUnitTestScript(scripts) {
  const failures = []
  const ci = scripts['test:ci']
  if (typeof ci !== 'string' || !ci.trim()) {
    failures.push(
      'package.json has no "test:ci" script — §7.199: the CI unit step must call a script'
      + ' that bakes in --reporter=json/--outputFile, instead of forwarding them through'
      + ' `pnpm test -- …` (pnpm may pass the literal `--` through, and vitest then treats'
      + ' the flags as positional filters ⇒ no report file, exit code still 0).',
    )
    return failures
  }
  if (!/--reporter=json\b/u.test(ci)) {
    failures.push('package.json#scripts["test:ci"] does not pass --reporter=json — the count gate needs the JSON report.')
  }
  const out = /--outputFile=(\S+)/u.exec(ci)
  if (!out) {
    failures.push('package.json#scripts["test:ci"] does not pass --outputFile=<path> — the count gate needs the JSON report file.')
  } else if (out[1].startsWith('/') || /^[A-Za-z]:/u.test(out[1])) {
    failures.push(
      `package.json#scripts["test:ci"] writes the report to an absolute path (${out[1]}) — keep it`
      + ' inside the repository (dist/ is gitignored) so the path means the same thing on every'
      + ' runner and the report never lands outside the checkout.',
    )
  }
  return failures
}

/**
 * §7.199: 如果 workflow 有 `test:` job，它必须调 `pnpm run test:ci`。
 *
 * @param {string} workflowText
 * @returns {string[]} the problems (empty when sound)
 */
export function auditUnitTestJob(workflowText) {
  const failures = []
  const body = extractJob(workflowText, 'test')
  if (body === null) return failures // 没有单测 job 的 workflow 不强制
  if (!/(?:npm|pnpm)\s+run\s+test:ci\b/u.test(body)) {
    failures.push(
      'the `test:` job does not run `pnpm run test:ci` — §7.199: the JSON reporter flags'
      + ' must come from package.json#scripts["test:ci"], not from `pnpm test -- …`'
      + ' forwarding (a literal `--` makes vitest drop the flags and still exit 0).',
    )
  }
  return failures
}

/* ── §7.202：npm 发布面与「registry 传播延迟」的赛跑 ───────────────────── */

/**
 * 把 workflow 里所有 `run: |`（块状脚本）的正文抠出来。
 *
 * 为什么不能直接搜整个 job body：**注释里也会出现那些关键字**（比如「409 /
 * EPUBLISHCONFLICT 当成功」这句解释就在注释里）⇒ 门禁会拿注释当实现。
 * ⇒ 这里只取**真正的脚本正文**，并把 `#` 开头的行剔掉。
 *
 * @param {string} workflowText
 * @returns {string[]} the block bodies
 */
export function extractRunBlocks(workflowText) {
  const lines = workflowText.split(/\r?\n/u)
  const blocks = []
  for (let i = 0; i < lines.length; i++) {
    if (!/^[ \t]*(?:-[ \t]+)?run:[ \t]*\|[+-]?[ \t]*$/u.test(lines[i])) continue
    const indent = (lines[i].match(/^[ \t]*/u) ?? [''])[0].length
    const body = []
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]
      if (line.trim() === '') {
        body.push(line)
        continue
      }
      const lineIndent = (line.match(/^[ \t]*/u) ?? [''])[0].length
      if (lineIndent <= indent) break
      body.push(line)
    }
    blocks.push(body.join('\n'))
  }
  return blocks
}

/**
 * §7.202: decide 步必须给 registry 的传播延迟留一个**等待窗口**。
 *
 * 实测（发 0.1.4，run #4）：本机 `pnpm publish` 报成功 15:26:35，而 registry 的
 * `versions` 数组 **15:28:06** 才出现 0.1.4（≈91 秒）⇒ CI 的 decide 步正好
 * 落在这个窗口里时，会判「未发过」⇒ 真的去 publish ⇒ 撞 409 / 无凭据 ⇒ job 红。
 *
 * ⇒ decide 步必须带 `--wait-seconds <正整数>`。
 *
 * @param {string} workflowText
 * @returns {string[]} the problems (empty when sound)
 */
export function auditPublishDecideWait(workflowText) {
  const failures = []
  const body = extractJob(workflowText, 'npm')
  if (body === null) return failures
  const runLines = [...body.matchAll(/^[ \t]*(?:-[ \t]+)?run:[ \t]*(.+)$/gm)].map((m) => m[1])
  const decision = runLines.find((line) => line.includes('publish-decision.mjs'))
  if (!decision) {
    failures.push(
      'the `npm:` job does not run scripts/publish-decision.mjs — §7.202: the publish step'
      + ' needs the skip/provenance decision, and the decision needs the propagation wait.',
    )
    return failures
  }
  const wait = /--wait-seconds[ \t]+(\d+)/u.exec(decision)
  if (!wait) {
    failures.push(
      'scripts/publish-decision.mjs is called without `--wait-seconds` — §7.202: the'
      + " registry's read path lags its write path by ~1-2 minutes (measured: published"
      + ' 15:26:35 → visible in `versions` 15:28:06). Without a wait, the decide step'
      + ' races that delay, judges "not published", and the job publishes a version the'
      + ' registry already has.',
    )
  } else if (Number(wait[1]) <= 0) {
    failures.push(
      'scripts/publish-decision.mjs is called with `--wait-seconds 0` — §7.202: 0 means'
      + ' "do not wait", which is exactly the racy behaviour the wait exists to remove.',
    )
  }
  return failures
}

/**
 * §7.202: publish 步必须把「这一版已经在 registry 上」当**成功**。
 *
 * 这是 §7.172 注释里写的「两条路径共存」的语义 —— 之前**只写在注释里、没实现**：
 * 本机 `publish:npm --yes --tag` 发完再推 tag，CI 的 npm job 本该看到这一版已在
 * 于是跳过；而 decide 步输给了传播延迟时，真撞上 409 是**预期结果**，不是故障。
 *
 * 但**别的错误必须仍然让 job 红**（401/403 = CI 没凭据，等等）⇒ 门禁同时要求：
 *   - 认 409（EPUBLISHCONFLICT）⇒ 成功；
 *   - 其它失败 ⇒ 发 `::error::` 注解 **且** 把退出码传出去。
 *
 * @param {string} workflowText
 * @returns {string[]} the problems (empty when sound)
 */
export function auditPublishConflictHandling(workflowText) {
  const failures = []
  const blocks = extractRunBlocks(workflowText)
  const publishBlock = blocks.find((b) => b.includes('pnpm publish'))
  if (!publishBlock) {
    failures.push(
      'no `run:` block runs `pnpm publish` — §7.202: the publish step must handle'
      + ' "version already published" (409) as success and report other failures.',
    )
    return failures
  }
  // 注释行不算实现
  const code = publishBlock
    .split(/\r?\n/u)
    .filter((line) => !/^[ \t]*#/u.test(line))
    .join('\n')

  if (!/EPUBLISHCONFLICT|cannot publish over the previously published versions/u.test(code)) {
    failures.push(
      'the publish step does not treat "version already published" (409 / EPUBLISHCONFLICT)'
      + ' as success — §7.202: the local path publishes first and the CI path follows the'
      + ' tag, so a conflict there means the desired end state is already reached. Failing'
      + ' it paints a successful release red.',
    )
  }
  if (!/::error::/u.test(code)) {
    failures.push(
      'the publish step does not emit an `::error::` annotation when publishing fails —'
      + ' §7.202: failures must stay loud AND readable without opening the runner log'
      + ' (annotations are public).',
    )
  }
  if (!/exit[ \t]+\$\{?status/u.test(code)) {
    failures.push(
      'the publish step does not propagate the publish exit code (`exit $status`) —'
      + ' §7.202: a non-conflict failure must still turn the job red.',
    )
  }
  return failures
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

  // 9. §7.198: `if:` 里引用 secrets ⇒ 整个 workflow 文件无效（GitHub 限制）。
  {
    const bad = [
      'name: fixture',
      'on: push',
      'jobs:',
      '  build:',
      '    steps:',
      '      - name: a step',
      "        if: ${{ secrets.DEEPSEEK_API_KEY != '' }}",
      '        run: echo hi',
      '',
    ].join('\n')
    const problems = findSecretInIf(bad)
    expect('if: 里引用 secrets ⇒ 报 1 项', problems.length, 1)
    expect('问题里点名 secrets.', problems[0].includes('secrets.'), true)

    const good = bad.replace("secrets.DEEPSEEK_API_KEY", 'env.DEEPSEEK_API_KEY')
    expect('改成 env. 上下文 ⇒ 无问题', findSecretInIf(good).length, 0)
  }

  // 10. §7.199: vitest 参数**不能**靠 `pnpm test -- …` 转发。
  {
    const bad = [
      '      - name: Run unit tests',
      '        run: |',
      '          pnpm test -- --run --reporter=json --outputFile=/tmp/vitest.json',
      '',
    ].join('\n')
    const problems = findVitestArgForwarding(bad)
    expect('pnpm test -- 转发参数 ⇒ 报 1 项', problems.length, 1)
    expect('问题里点名 pnpm test', problems[0].includes('pnpm test'), true)

    expect('pnpm run test:ci ⇒ 无问题', findVitestArgForwarding('        run: pnpm run test:ci\n').length, 0)
    expect('pnpm install --frozen-lockfile ⇒ 无问题', findVitestArgForwarding('        run: pnpm install --frozen-lockfile\n').length, 0)
    expect('注释里的坏例子不算', findVitestArgForwarding('# pnpm test -- --reporter=json 是坏写法\n').length, 0)
  }

  // 11. §7.199: package.json 的 test:ci 脚本必须自带 reporter + outputFile，
  //     且报告写在仓库内（相对路径）。
  {
    expect('没有 test:ci 脚本 ⇒ 报 1 项', auditUnitTestScript({}).length, 1)
    expect(
      'test:ci 缺 --reporter=json ⇒ 报 1 项',
      auditUnitTestScript({ 'test:ci': 'vitest run tests/unit --outputFile=dist/probe/vitest-ci.json' }).length,
      1,
    )
    expect(
      'test:ci 的报告写在绝对路径 ⇒ 报 1 项',
      auditUnitTestScript({ 'test:ci': 'vitest run tests/unit --reporter=json --outputFile=/tmp/vitest.json' }).length,
      1,
    )
    expect(
      'test:ci 正确 ⇒ 无失败',
      auditUnitTestScript({ 'test:ci': 'vitest run tests/unit --reporter=json --outputFile=dist/probe/vitest-ci.json' }).length,
      0,
    )
  }

  // 12. §7.199: 有 `test:` job 的 workflow 必须调 `pnpm run test:ci`。
  {
    const withTestJob = (runBody) => [
      'name: fixture',
      'on: push',
      'jobs:',
      '  test:',
      '    steps:',
      '      - name: Run unit tests',
      `        run: ${runBody}`,
      '',
    ].join('\n')
    expect('调 pnpm run test:ci ⇒ 无失败', auditUnitTestJob(withTestJob('pnpm run test:ci')).length, 0)
    expect('调 pnpm test -- ⇒ 报 1 项', auditUnitTestJob(withTestJob('pnpm test -- --reporter=json')).length, 1)
    expect('没有 test job ⇒ 无失败', auditUnitTestJob('name: fixture\non: push\njobs:\n  build:\n    steps: []\n').length, 0)
  }

  // 13. §7.202: decide 步必须带 `--wait-seconds`（且 > 0）。
  {
    const decideFixture = (runBody) => [
      'name: fixture',
      'on: push',
      'jobs:',
      '  npm:',
      '    steps:',
      '      - name: Decide',
      '        id: decide',
      `        run: ${runBody}`,
      '',
    ].join('\n')
    expect(
      'decide 带 --wait-seconds 180 ⇒ 无失败',
      auditPublishDecideWait(decideFixture('node scripts/publish-decision.mjs --wait-seconds 180 >> "$GITHUB_OUTPUT"')).length,
      0,
    )
    expect(
      'decide 不带 --wait-seconds ⇒ 报 1 项',
      auditPublishDecideWait(decideFixture('node scripts/publish-decision.mjs >> "$GITHUB_OUTPUT"')).length,
      1,
    )
    expect(
      'decide 的 --wait-seconds 是 0 ⇒ 报 1 项',
      auditPublishDecideWait(decideFixture('node scripts/publish-decision.mjs --wait-seconds 0 >> "$GITHUB_OUTPUT"')).length,
      1,
    )
    expect(
      'decide 步整个不在 ⇒ 报 1 项',
      auditPublishDecideWait('name: fixture\non: push\njobs:\n  npm:\n    steps: []\n').length,
      1,
    )
  }

  // 14. §7.202: publish 步必须认 409、发 `::error::`、把退出码传出去。
  {
    const publishFixture = (body) => [
      'name: fixture',
      'on: push',
      'jobs:',
      '  npm:',
      '    steps:',
      '      - name: Publish',
      '        run: |',
      ...body.split('\n').map((l) => '          ' + l),
      '',
    ].join('\n')
    const GOOD = [
      'pnpm publish --no-provenance --access public 2>&1 | tee ../publish.log',
      'status=${PIPESTATUS[0]}',
      'if [ "$status" -eq 0 ]; then exit 0; fi',
      'if grep -qE "EPUBLISHCONFLICT|cannot publish over the previously published versions" ../publish.log; then',
      '  echo "::notice::这一版已经在 registry 上"',
      '  exit 0',
      'fi',
      'echo "::error::pnpm publish 失败 exit=$status"',
      'exit $status',
    ].join('\n')
    expect('publish 步认 409 + 发注解 + 传退出码 ⇒ 无失败', auditPublishConflictHandling(publishFixture(GOOD)).length, 0)

    // 反证 ①：没有 409 分支（注释里写了也不算）
    const noConflict = GOOD.split('\n').filter((l) => !l.includes('grep -qE') && !l.includes('::notice::')).join('\n')
    expect('publish 步不认 409 ⇒ 报 1 项', auditPublishConflictHandling(publishFixture(noConflict)).length, 1)

    // 反证 ②：409 只出现在注释里 ⇒ 仍要报（注释不是实现）
    const commented = GOOD.replace(
      'if grep -qE "EPUBLISHCONFLICT|cannot publish over the previously published versions" ../publish.log; then',
      '# 这里本来要认 EPUBLISHCONFLICT',
    ).split('\n').filter((l) => !l.includes('::notice::')).join('\n')
    expect('409 只写在注释里 ⇒ 仍报 1 项', auditPublishConflictHandling(publishFixture(commented)).length, 1)

    // 反证 ③：失败时不发注解 ⇒ 报 1 项
    const noAnnot = GOOD.replace('echo "::error::pnpm publish 失败 exit=$status"', 'echo "失败了"')
    expect('失败时不发 ::error:: ⇒ 报 1 项', auditPublishConflictHandling(publishFixture(noAnnot)).length, 1)

    // 反证 ④：不传退出码 ⇒ 报 1 项
    const noExit = GOOD.replace('exit $status', 'exit 0')
    expect('不传退出码 ⇒ 报 1 项', auditPublishConflictHandling(publishFixture(noExit)).length, 1)
  }

  if (failures > 0) {
    console.error(`\nselftest FAILED: ${failures} assertion(s)`)
    process.exit(2)
  }
  console.log('\nselftest OK — 门禁能抓住缺步骤的构建链，也能放过完整的链')
}

/* ── entry ──────────────────────────────────────────────────────────────── */

const args = process.argv.slice(2)

// 只在**直接执行**本文件时跑入口 —— 本文件导出函数给别的门禁用（§7.201：
// `verify-git-release.mjs` 复用 REQUIRED_BUILD_STEPS），而顶层就审计 + process.exit
// 会把 import 方的进程一起带走。
const isEntry = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isEntry) {
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
      // §7.198: `if:` 条件里引用 secrets ⇒ GitHub 判整个文件无效 ⇒ CI 全挂，
      // 而且**看不出原因**（run 名字变成文件路径、jobs 为空、没有 log）。
      for (const expr of findSecretInIf(workflow)) {
        failures.push(
          `${target.file}: an \`if:\` condition references \`secrets.\` (${expr}) — GitHub forbids`
          + ' secrets directly in if conditions, and it invalidates the WHOLE workflow file'
          + ' (the run shows the file path as its name and has no jobs). Put the secret in a'
          + ' job-level `env:` and reference it as `env.<NAME>` in the condition.',
        )
      }
      // §7.199: vitest 参数靠 `pnpm test -- …` 转发 ⇒ pnpm 把字面 `--` 透传给脚本
      // ⇒ vitest 把这些 flag 当位置过滤器丢弃 ⇒ **报告文件不生成、退出码仍是 0**
      // （假绿：测试照跑，但计数门禁根本没判）。参数必须烤进 package.json 的脚本。
      for (const line of findVitestArgForwarding(workflow)) {
        failures.push(
          `${target.file}: \`${line}\` forwards vitest flags through \`pnpm test -- …\` — §7.199:`
          + ' pnpm may pass the literal `--` through, and vitest (cac) then treats'
          + ' --reporter/--outputFile as POSITIONAL FILTERS ⇒ no JSON report, exit code still 0.'
          + ' Put the flags in package.json#scripts["test:ci"] and call that script by name.',
        )
      }
      for (const f of auditUnitTestJob(workflow)) {
        failures.push(`${target.file}: ${f}`)
      }
      // §7.202: npm 发布面与「registry 传播延迟」的赛跑 ——
      // decide 步必须等 registry 看得见这一版；publish 步必须把「已经发过了」
      // 当成功（这正是 §7.172 注释里写的两条路径共存语义，之前只写在注释里）。
      if (target.npmFace) {
        for (const f of auditPublishDecideWait(workflow)) {
          failures.push(`${target.file}: ${f}`)
        }
        for (const f of auditPublishConflictHandling(workflow)) {
          failures.push(`${target.file}: ${f}`)
        }
      }
      audited.push(`${target.file}(${target.job})`)
    }

    for (const f of auditUnitTestScript(scripts)) {
      failures.push(`package.json: ${f}`)
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
}
