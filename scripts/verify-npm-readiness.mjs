#!/usr/bin/env node
/**
 * verify-npm-readiness.mjs — §7.193：把「发版前置条件」从口头记忆变成门禁。
 *
 * ## 为什么需要它
 *
 * §7.188 发完 0.1.2 之后查实了一件事：**发版这件事有三段前置条件，其中两段机器查不了**。
 *
 *   | 前置条件 | 机器能查吗 | 谁查 |
 *   |---|---|---|
 *   | 仓库侧是否为 OIDC 路径准备好了 | ✅ 能（`publish.yml` 的形状） | **本门禁** |
 *   | 账号是否开了 2FA | ❌ 不能（实测 `npm profile get` → 403） | 人，在 npmjs.com |
 *   | trusted publisher 是否已挂 | ❌ 不能（registry 上没有可查端点，实测 404） | 人，在包页 |
 *
 * 那两段查不了的，机器唯一能做的就是**每次 CI 都把「要人工确认什么、去哪确认」打印出来**，
 * 让它从「记忆」变成「日志」。而第一段——本来就在仓库里、随时可能被改坏——机器完全能查，
 * 却一直没有门禁管着。
 *
 * ## 它守的是什么（静态断言，全部离线、只读、不联网）
 *
 *   1. `publish.yml` 有 `id-token: write`
 *      —— 没有它，GitHub Actions 换不到 OIDC token ⇒ trusted publishing 永远用不了
 *      ⇒ 2027-01 token 直发被移除后，CI 再也发不了版。
 *   2. `publish.yml` 被 `v*` tag 触发
 *   3. publish 步骤的 cwd 是 `dist/.npm-stage`
 *      —— 本地 dry-run 与 CI 真发必须**同一个目录、同一���命令**。
 *   4. publish 命令带 `--access public` / `--ignore-scripts` / `--no-git-checks`
 *      —— `--no-git-checks` 尤其要命：tag push 是 detached HEAD，pnpm 的 git 检查
 *      会报 `ERR_PNPM_GIT_UNKNOWN_BRANCH`，每推一次 tag 就死一次。
 *   5. `--provenance` 与 `--no-provenance` **两条分支都在**
 *      —— 本机带不了溯源徽章（pnpm 的生成器只在受支持的 CI 里工作）、CI 要带。
 *      少一条 ⇒ 其中一边必炸。
 *   6. `publish.yml` 有 tag↔version 断言
 *      —— 否则推一个与清单版本不符的 tag，会发布一个仓库里没人认领的版本。
 *   7. 仓库里没有 npm token 的**字面量**
 *      —— 凭据进过一次聊天记录、一次 tool-outputs，就更不该进 git。
 *
 * ## 它查不了的（打印出来，让人去点）
 *
 *   - 账号 2FA：npm 官方 `npm trust` 文档写明「2FA enabled on account … must
 *     enable it to use trust commands」，且 **GAT with bypass 2FA 不被支持**
 *     ⇒ 挂 trusted publisher 之前必须先开 2FA。而 CLI 查不了自己的 2FA 状态
 *     （2026-11-11 实测：`npm profile get` → `403 Forbidden`）。
 *   - trusted publisher：registry 上没有可查的端点（2026-11-11 实测：匿名与
 *     带认证访问 `/-/npm/v1/trusted-publishers*` 都是 404）⇒ 只能人看包页。
 *
 * ## 在线部分（`--online`，匿名只读）
 *
 * 查 registry 上这个包的实况：是否存在、是否 public、versions、latest、
 * 当前版本是否已上线。
 *
 * **判据是 `versions` 里有没有新版本**，不是 `latest` 指向谁、也不是
 * `npm view <pkg> version` 返回什么 —— 实测 2026-11-11：staged publishing
 * 期间后两者返回的是**上一个真实版本**（0.1.1），不是占位版 `0.0.0-stage`。
 *
 * 网络失败**不算失败**（`state: "unknown"`，退出码仍为 0）—— 离线也要能跑。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/verify-npm-readiness.mjs              # 静态断言 + 人工核对清单（离线）
 * node scripts/verify-npm-readiness.mjs --online     # 再加 registry 实况（匿名只读）
 * node scripts/verify-npm-readiness.mjs --selftest   # 自证 + 反向证伪（不联网）
 * ```
 *
 * 退出码：0 = 通过；1 = 静态断言有失败；2 = 自证失败或参数错误。
 *
 * 只读：不写仓库内任何文件，不回显任何凭据。
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { probePackage, probeVisibility } from './registry-version.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORKFLOW_REL = '.github/workflows/publish.yml'

/**
 * npm token 的字面量形状。
 *
 * classic token 是 `npm_` + 36 个字符；granular token 更长（`npm_` + ~90）。
 * 所以下限取 30：既能盖住两种真 token，又不会把 `npm_fake` 这类占位符算进去
 * （`publish-npm.mjs` 的自证里就有 `npm_fake`，不能被误伤）。
 */
const TOKEN_LITERAL_RE = /npm_[A-Za-z0-9]{30,}/gu

/* ── 静态断言：publish.yml 的形状 ────────────────────────────────────────── */

/**
 * 审 `publish.yml` 是不是「OIDC 路径已就绪」的形状。
 *
 * 用**文本**判定，不用 YAML 解析：仓库里既有的 `verify-ci-build-chain.mjs`
 * 也是这么做的（它按 job 头切片），口径一致；而且这些断言要的就是
 * 「这些字串在不在」，不是「YAML 语义树长什么样」。
 *
 * @param {string} workflow publish.yml 全文
 * @returns {{failures: string[], passed: string[]}}
 */
export function auditPublishWorkflow(workflow) {
  const failures = []
  const passed = []
  const check = (ok, label, detail) => {
    if (ok) passed.push(label)
    else failures.push(`${label}${detail ? ' —— ' + detail : ''}`)
  }

  // 1. id-token: write（OIDC 的前提）
  check(
    /^[ \t]*id-token:[ \t]*write[ \t]*$/mu.test(workflow),
    'publish.yml 有 `id-token: write`',
    '没有它，GitHub Actions 换不到 OIDC token ⇒ trusted publishing 永远用不了 ⇒ 2027-01 后 CI 再也发不了版',
  )

  // 2. 被 v* tag 触发
  const tagTrigger = /tags:[ \t]*\n(?:[ \t]*-[ \t]*['"]?v\*['"]?)/mu.test(workflow)
  check(tagTrigger, 'publish.yml 被 `v*` tag 触发', '推 tag 不会触发发布 job')

  // 3. publish 步骤的 cwd
  check(
    /working-directory:[ \t]*dist\/\.npm-stage[ \t]*$/mu.test(workflow),
    'publish 步骤的 cwd 是 dist/.npm-stage',
    '本地 dry-run 验的就不是 CI 真发的那条命令了（同一个目录、同一条 pnpm publish 才是同一条路）',
  )

  // 4. publish 命令的三个必需 flag
  for (const [flag, why] of [
    ['--access public', 'scoped 包默认 restricted ⇒ 公众装不到'],
    ['--ignore-scripts', '产物已由 build 链产出并过门禁；再跑一次 prepare 等于发一个没被门禁看过的构建'],
    ['--no-git-checks', 'tag push 是 detached HEAD，pnpm 的 git 检查会报 ERR_PNPM_GIT_UNKNOWN_BRANCH ⇒ 每推一次 tag 死一次'],
  ]) {
    check(workflow.includes(flag), `publish 命令带 ${flag}`, why)
  }

  // 5. provenance 的两条分支
  check(
    workflow.includes('--provenance') && workflow.includes('--no-provenance'),
    'publish.yml 同时有 --provenance 与 --no-provenance 两条分支',
    '本机带不了溯源徽章（pnpm 的生成器只在受支持的 CI 里工作）、CI 要带 ⇒ 少一条则其中一边必炸',
  )

  // 6. tag↔version 断言
  check(
    /package\.json['"]?\)?\s*#?version|require\(['"][^'"]*package\.json['"]\)\.version/iu.test(workflow),
    'publish.yml 有 tag↔version 断言',
    '推一个与清单版本不符的 tag，会发布一个仓库里没人认领的版本',
  )

  // 7. publish 步骤本身在
  check(workflow.includes('pnpm publish'), 'publish.yml 里真的有 pnpm publish')

  return { failures, passed }
}

/* ── 静态断言：仓库里没有 token 字面量 ───────────────────────────────────── */

/**
 * 在给定文件内容里找 npm token 的字面量。
 *
 * @param {{path: string, text: string}[]} entries
 * @returns {{path: string, match: string}[]}
 */
export function findLiteralTokens(entries) {
  const hits = []
  for (const { path, text } of entries) {
    const re = new RegExp(TOKEN_LITERAL_RE.source, 'gu')
    for (const m of text.matchAll(re)) {
      hits.push({ path, match: m[0] })
    }
  }
  return hits
}

/**
 * 列出仓库里「可能藏着凭据」的文件（git 追踪的那些）。
 *
 * 用 `git ls-files` 而不是遍历目录：`node_modules` / `dist` 里有几十万文件，
 * 遍历一次要好几秒，而那里本来就不该有凭据（产物由 `verify:npm-stage` 管）。
 *
 * git 不可用（导出的 tarball、非 git 环境）⇒ 返回空数组并由调用方降级为
 * 「跳过这项检查」，不是失败。
 *
 * @returns {{path: string, text: string}[] | null} null = 拿不到文件列表
 */
export function collectTrackedFiles() {
  let out
  try {
    out = execFileSync('git', ['ls-files', '-z'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }
  const entries = []
  for (const rel of out.split('\0')) {
    if (!rel) continue
    // 只读文本文件：二进制读出来也没意义，还可能把大文件拖进内存。
    if (/\.(png|jpe?g|gif|webp|ico|zip|gz|tgz|woff2?|ttf|eot|pdf|mp4|wasm)$/iu.test(rel)) continue
    try {
      entries.push({ path: rel, text: readFileSync(join(ROOT, rel), 'utf8') })
    } catch {
      // 读不了（子模块、符号链接断了）⇒ 跳过，不算失败。
    }
  }
  return entries
}

/* ── 在线部分：registry 实况 ─────────────────────────────────────────────── */

/**
 * 把 registry 的实况描述成可读的几行，并给出**正确的上线判据**。
 *
 * 纯函数（探针可注入）⇒ 自证不联网。
 *
 * @param {{pkg: {state: string, versions?: string[], distTags?: Record<string,string>},
 *          vis: {public: boolean|null},
 *          currentVersion: string}} snapshot
 * @returns {{lines: string[], published: boolean|null, notes: string[]}}
 */
export function describeRegistryState({ pkg, vis, currentVersion }) {
  const lines = []
  const notes = []
  let published = null

  if (pkg.state === 'unknown') {
    lines.push('  registry 实况 : 不可达（网络失败）—— 不算失败，离线也要能跑')
    return { lines, published, notes }
  }
  if (pkg.state === 'absent') {
    lines.push('  registry 实况 : 包还不存在（首次发布）')
    notes.push('首次发布不能带 --provenance：registry 对不存在的包答 {"public":false} ⇒ pnpm 拒绝做徽章')
    return { lines, published, notes }
  }

  const versions = pkg.versions ?? []
  const latest = pkg.distTags?.latest
  lines.push(`  registry 实况 : 已发布 ${versions.length} 个版本`)
  lines.push(`  是否 public    : ${vis.public === true ? '是' : vis.public === false ? '否' : '未知'}`)
  lines.push(`  latest 指向    : ${latest ?? '(未知)'}`)
  lines.push(`  版本列表      : ${versions.length ? versions.join(', ') : '(空)'}`)

  published = versions.includes(currentVersion)
  lines.push(
    `  当前版本 ${currentVersion} : ${published ? '已在 versions 里（已上线）' : '尚未上线'}`,
  )
  notes.push(
    '上线判据 = versions 里有没有新版本。'
    + '实测（2026-11-11）：staged publishing 期间 `npm view <pkg> version` 返回的是'
    + '**上一个真实版本**（0.1.1），不是占位版 0.0.0-stage ⇒ 拿它当判据会误判。',
  )
  if (!published) {
    notes.push('尚未上线时不要推 tag：CI 的 publish job 会以为「还没发过」而真发一遍，撞 409。')
  }
  return { lines, published, notes }
}

/* ── 人工核对清单（机器查不了的那部分）───────────────────────────────────── */

/**
 * 机器查不了、必须人去点的两件事。
 *
 * **为什么机器查不了**（2026-11-11 实测，不是推测）：
 *   - 账号 2FA：`npm profile get` → `403 Forbidden - GET /-/npm/v1/user`，
 *     registry 同时挂着横幅「npm tokens that bypass 2FA are being restricted for
 *     account changes and direct publishing」⇒ bypass token 做不了账号治理动作，
 *     读不到自己的 2FA 状态。
 *   - trusted publisher：`/-/npm/v1/trusted-publishers` 与
 *     `/-/npm/v1/trusted-publishers/<pkg>` 匿名与带认证访问都是 404 ⇒ 没有可查端点。
 */
export const MANUAL_CHECKLIST = [
  {
    what: '账号 2FA（WebAuthn / Windows Hello）',
    why: 'npm 官方 npm trust 文档：「2FA enabled on account: Two-factor authentication must be enabled at the account level. Even if it\'s not currently enabled, you must enable it to use trust commands.」且「Granular Access Tokens (GAT) with the bypass 2FA option are not supported.」⇒ 挂 trusted publisher 之前必须先开 2FA。',
    where: 'https://www.npmjs.com/settings/two-factor-auth',
    cannot: 'CLI 查不到：npm profile get → 403 Forbidden（bypass token 不能做账号治理动作）',
  },
  {
    what: 'trusted publisher（OIDC 连接）',
    why: '2027-01 起 bypass-2FA token 失去直发权 ⇒ CI 必须走 OIDC。仓库侧已就位（id-token: write + pnpm 11.7.0 自己换 token），缺的是 npm 上那条连接。',
    where: 'https://www.npmjs.com/package/@dsh-edge/dsh-edge-agent/settings/access',
    cannot: 'registry 上没有可查端点：/-/npm/v1/trusted-publishers* 匿名与带认证都是 404',
    extra: '填 Organization or user=dsh-edge、Repository=chschytzmcy/dsh-edge-agent、Workflow filename=publish.yml；须勾上「npm publish」（2026-09-03 后新建的连接默认只允许 staged publish）；配完 48 小时内要推一次 tag，否则校验不过、配置作废。',
  },
]

/* ── 自证 + 反向证伪 ─────────────────────────────────────────────────────── */

/** 一份形状正确的 publish.yml（自证用，不联网）。 */
const GOOD_WORKFLOW = [
  'name: publish',
  'on:',
  '  push:',
  '    tags:',
  "      - 'v*'",
  'permissions:',
  '  contents: write',
  '  id-token: write',
  'jobs:',
  '  npm:',
  '    steps:',
  '      - name: Assert the tag matches package.json#version',
  '        run: |',
  '          VER="$(node -p "require(\'./package.json\').version")"',
  '      - name: Publish',
  '        working-directory: dist/.npm-stage',
  '        run: |',
  '          if [ "$PROV" = "true" ]; then',
  '            pnpm publish --provenance --access public --ignore-scripts --no-git-checks',
  '          else',
  '            pnpm publish --no-provenance --access public --ignore-scripts --no-git-checks',
  '          fi',
  '',
].join('\n')

function selftest() {
  let failures = 0
  const expect = (label, actual, wanted) => {
    const ok = actual === wanted
    if (!ok) failures++
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label} — expected ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`)
  }

  console.log('verify-npm-readiness --selftest')

  // 1. 形状正确 ⇒ 零失败，且**检查项集合**与预期一致
  //
  //    这里断言的是「集合」而不是「条数」：条数只是集合的大小，集合本身才是
  //    「这门禁到底守哪几条」。用集合断言 ⇒ 将来加一条检查时，必须同时把
  //    期望清单补上（否则这里红），而不是让条数悄悄变掉、没人发现。
  {
    const EXPECTED_CHECKS = [
      'publish.yml 有 `id-token: write`',
      'publish.yml 被 `v*` tag 触发',
      'publish 步骤的 cwd 是 dist/.npm-stage',
      'publish 命令带 --access public',
      'publish 命令带 --ignore-scripts',
      'publish 命令带 --no-git-checks',
      'publish.yml 同时有 --provenance 与 --no-provenance 两条分支',
      'publish.yml 有 tag↔version 断言',
      'publish.yml 里真的有 pnpm publish',
    ]
    const r = auditPublishWorkflow(GOOD_WORKFLOW)
    expect('形状正确 ⇒ 无失败', r.failures.length, 0)
    expect(
      '通过项集合与预期一致（不多不少）',
      [...r.passed].sort().join('|') === [...EXPECTED_CHECKS].sort().join('|'),
      true,
    )
    expect('通过项条数与预期一致', r.passed.length, EXPECTED_CHECKS.length)
  }

  // 2. 去掉 id-token: write ⇒ 报失败，且信息点名 OIDC
  {
    const r = auditPublishWorkflow(GOOD_WORKFLOW.replace('  id-token: write\n', ''))
    expect('去掉 id-token: write ⇒ 报失败', r.failures.length, 1)
    expect('失败信息点名 OIDC', r.failures[0].includes('OIDC'), true)
  }

  // 3. cwd 改了 ⇒ 报失败
  {
    const r = auditPublishWorkflow(GOOD_WORKFLOW.replace('working-directory: dist/.npm-stage', 'working-directory: .'))
    expect('cwd 不是暂存目录 ⇒ 报失败', r.failures.length, 1)
    expect('失败信息点名暂存目录', r.failures[0].includes('dist/.npm-stage'), true)
  }

  // 4. 去掉 --no-git-checks ⇒ 报失败（detached HEAD 那个坑）
  {
    const r = auditPublishWorkflow(GOOD_WORKFLOW.replaceAll(' --no-git-checks', ''))
    expect('去掉 --no-git-checks ⇒ 报失败', r.failures.length, 1)
    expect('失败信息点名 detached HEAD', r.failures[0].includes('detached HEAD'), true)
  }

  // 5. 只留 --provenance（少了 --no-provenance）⇒ 报失败
  {
    const r = auditPublishWorkflow(GOOD_WORKFLOW.replace('pnpm publish --no-provenance ', 'pnpm publish '))
    expect('少 --no-provenance ⇒ 报失败', r.failures.length, 1)
    expect('失败信息点名本机', r.failures[0].includes('本机'), true)
  }

  // 6. tag 触发写错 ⇒ 报失败
  {
    const r = auditPublishWorkflow(GOOD_WORKFLOW.replace("- 'v*'", '- "release-*"'))
    expect('tag 触发写错 ⇒ 报失败', r.failures.length, 1)
  }

  // 7. 去掉 tag↔version 断言 ⇒ 报失败
  {
    const r = auditPublishWorkflow(GOOD_WORKFLOW.replace(/      - name: Assert the tag matches package\.json#version\n(?:.*\n)*?          VER=.*\n/u, ''))
    expect('去掉 tag↔version 断言 ⇒ 报失败', r.failures.length, 1)
  }

  // 8. token 字面量：真 token 被抓、占位符不被误伤
  {
    const fake = `npm_${'a'.repeat(36)}`
    const hits = findLiteralTokens([
      { path: 'docs/x.md', text: `key=${fake}` },
      { path: 'scripts/publish-npm.mjs', text: "hasLiteralToken('_authToken=npm_fake\\n')" },
      { path: 'README.md', text: 'npm_ 是 npm token 的前缀' },
    ])
    expect('真 token 被抓到 1 处', hits.length, 1)
    expect('抓到的是那一处', hits[0].path, 'docs/x.md')
  }

  // 9. registry 实况：已发布 / 未上线 / 不可达
  {
    const s = describeRegistryState({
      pkg: { state: 'present', versions: ['0.0.0-stage', '0.1.1', '0.1.2'], distTags: { latest: '0.1.2' } },
      vis: { public: true },
      currentVersion: '0.1.2',
    })
    expect('已上线的版本 ⇒ published=true', s.published, true)
    expect('已上线的版本 ⇒ 报告里点名', s.lines.some((l) => l.includes('已在 versions 里')), true)
  }
  {
    const s = describeRegistryState({
      pkg: { state: 'present', versions: ['0.0.0-stage', '0.1.1'], distTags: { latest: '0.1.1' } },
      vis: { public: true },
      currentVersion: '0.1.2',
    })
    expect('未上线的版本 ⇒ published=false', s.published, false)
    expect('未上线 ⇒ 提醒别急着推 tag', s.notes.some((n) => n.includes('不要推 tag')), true)
    expect('未上线 ⇒ 报告里点名', s.lines.some((l) => l.includes('尚未上线')), true)
  }
  {
    const s = describeRegistryState({
      pkg: { state: 'unknown' },
      vis: { public: null },
      currentVersion: '0.1.3',
    })
    expect('不可达 ⇒ published=null（不是 false）', s.published, null)
    expect('不可达 ⇒ 报告说不可达', s.lines.some((l) => l.includes('不可达')), true)
  }

  // 10. 人工核对清单：两件都在，且每件都带「为什么机器查不了」
  {
    expect('人工核对清单有两项', MANUAL_CHECKLIST.length, 2)
    expect('每项都有核对地址', MANUAL_CHECKLIST.every((c) => c.where.startsWith('https://')), true)
    expect('每项都说明机器为何查不到', MANUAL_CHECKLIST.every((c) => typeof c.cannot === 'string' && c.cannot.length > 0), true)
    expect('2FA 那项引用了 npm trust 的原文', MANUAL_CHECKLIST[0].why.includes('must'), true)
  }

  if (failures > 0) {
    console.error(`\nselftest FAILED: ${failures} assertion(s)`)
    process.exit(2)
  }
  console.log('\nselftest OK —— 门禁能抓住被改坏的发布路径，也能放过完好的；查不了的部分如实报告为「查不了」')
}

/* ── 入口 ────────────────────────────────────────────────────────────────── */

const args = process.argv.slice(2)

if (args.includes('--selftest')) {
  selftest()
} else if (args.some((a) => a !== '--online')) {
  console.error('usage: node scripts/verify-npm-readiness.mjs [--online | --selftest]')
  process.exit(2)
} else {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const failures = []

  console.log('verify-npm-readiness')
  console.log(`  包名 : ${manifest.name}`)
  console.log(`  版本 : ${manifest.version}`)

  // ① publish.yml 的形状
  let workflow = ''
  try {
    workflow = readFileSync(join(ROOT, WORKFLOW_REL), 'utf8')
  } catch {
    failures.push(`缺 ${WORKFLOW_REL} —— 本仓要发 npm，发布 workflow 不能没有`)
  }
  if (workflow) {
    const r = auditPublishWorkflow(workflow)
    failures.push(...r.failures)
    console.log(`  OIDC 就绪 : ${r.passed.length} 项通过 / ${r.failures.length} 项失败`)
    for (const p of r.passed) console.log(`    ✓ ${p}`)
  }

  // ② token 字面量
  const tracked = collectTrackedFiles()
  if (tracked === null) {
    console.log('  token 字面量 : 跳过（拿不到 git 文件列表）')
  } else {
    const hits = findLiteralTokens(tracked)
    if (hits.length > 0) {
      for (const h of hits) failures.push(`${h.path} 里出现了 npm token 的字面量（${h.match.slice(0, 8)}…）—— 凭据不该进 git`)
      console.log(`  token 字面量 : ${hits.length} 处（不该有）`)
    } else {
      console.log(`  token 字面量 : 无 ✓（扫了 ${tracked.length} 个文件）`)
    }
  }

  // ③ registry 实况（只在 --online 时联网；匿名只读）
  if (args.includes('--online')) {
    const pkg = await probePackage(manifest.name)
    const vis = await probeVisibility(manifest.name)
    const snap = describeRegistryState({ pkg, vis, currentVersion: manifest.version })
    for (const l of snap.lines) console.log(l)
    for (const n of snap.notes) console.log(`    ℹ ${n}`)
  } else {
    console.log('  registry 实况 : 未查（加 --online 可查，匿名只读）')
  }

  // ④ 人工核对清单 —— 机器查不了的部分，如实说「查不了」而不是假装查过
  console.log('  人工核对（机器查不了，见 docs/npm-account-setup.md）：')
  for (const c of MANUAL_CHECKLIST) {
    console.log(`    · ${c.what}`)
    console.log(`        去哪 : ${c.where}`)
    console.log(`        为何查不了 : ${c.cannot}`)
    if (c.extra) console.log(`        注意 : ${c.extra}`)
  }

  console.log(`  失败 : ${failures.length}`)
  if (failures.length > 0) {
    console.log('\n失败明细：')
    for (const f of failures) console.log(`  - ${f}`)
    console.error('\nFAIL')
    process.exit(1)
  }
  console.log('\nPASS')
}
