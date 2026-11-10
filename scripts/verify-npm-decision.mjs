#!/usr/bin/env node
/**
 * verify-npm-decision.mjs —— 发布决策的门禁（§7.172）
 *
 * ## 为什么需要它
 *
 * 发布链上有两段**只在 CI 的 publish job 里跑**的代码，而 build job 的任何门禁
 * 都够不着它们：
 *
 *   | 脚本 | 在哪跑 | 决定什么 |
 *   |---|---|---|
 *   | `scripts/registry-version.mjs` | `publish.yml` 的 Decide 步 | 带**不带** `--provenance` |
 *   | `scripts/publish-decision.mjs` | `publish.yml` 的 Decide 步 | 跳**不跳过** publish + 上面那个 |
 *
 * 判错方向的后果都不是「少个功能」：
 *
 *   - 首次发布该带不带判错 ⇒ pnpm 的 provenance 生成器抛错 ⇒ **整个发布失败**；
 *   - stdout 的 `key=value` 契约破了 ⇒ `$GITHUB_OUTPUT` 解析失败 ⇒ job 在一个跟
 *     发布毫无关系的地方红掉。
 *
 * ⇒ 这两段各自带 `--selftest`，本门禁把它们**都跑一遍**，任一失败 ⇒ 门禁红。
 * 于是在**每一次 push** 上（而不只是推 tag 的那一刻）就能发现它们坏了。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/verify-npm-decision.mjs
 * ```
 *
 * 退出码：0 = 通过；1 = 有自证失败。
 *
 * 只读、不联网（两个被调用的自证都注入假探针 / 连不上的端口）。
 */

import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 被本门禁跑的两个自证。 */
const SELFTESTS = [
  {
    name: 'registry-version',
    why: 'provenance 判定表的五行（私有 / 首次发布 / 已存在 / 非 public / 查不到）',
    script: 'registry-version.mjs',
  },
  {
    name: 'publish-decision',
    why: 'stdout 契约（只输出 5 个 key=value，值都是单行，人类可读的部分走 stderr）',
    script: 'publish-decision.mjs',
  },
]

let failed = 0

console.log('verify-npm-decision')
for (const item of SELFTESTS) {
  console.log(`\n── ${item.name} --selftest ──`)
  console.log(`   （${item.why}）`)
  const res = spawnSync(process.execPath, [join(ROOT, 'scripts', item.script), '--selftest'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env },
  })
  if (res.status === 0) {
    console.log(`   ✓ ${item.name} 自证通过`)
  } else {
    failed++
    console.error(`   ✗ ${item.name} 自证失败（退出码 ${res.status}）`)
  }
}

console.log('\n────────────────────────────────────────')
if (failed > 0) {
  console.error(`  FAIL —— ${failed} 个自证失败`)
  process.exit(1)
}
console.log(`  PASS —— ${SELFTESTS.length} 个自证全绿`)
console.log('────────────────────────────────────────')
