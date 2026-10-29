// scripts/_probe-host-presets.mjs — §7.153 实机探针：桌面宿主的 Agent Preset 名册
//
// ## 它回答什么问题
//
// 「桌面版的工作方式列表里到底有没有『边缘模式』？」
//
// 这不是自证：名册由**宿主**（@deepseek-ai/dsh-agent-preset-registry）维护，
// 我们的 bundle 只是通过 package.json#dsh.bundle.patch 里的 preset 层把
// 一行 @deepseek-ai/dsh-agent-preset 交给它。名册里有 edge ⇒ 宿主收到了；
// 没有 ⇒ 那一层没被加载，而宿主**不会报错**（§7.153 的根因）。
//
// ## 怎么问
//
// 1. 宿主进程（dsh-desktop-host）在 127.0.0.1:<随机端口> 上开 HTTP；
// 2. 鉴权走 Cookie `dsh-auth-*`，其值是 `v1.<base64url(JSON)>`，JSON 里带
//    `authority: "127.0.0.1:<端口>"` —— **必须匹配当前宿主端口**；
// 3. RPC 走 `POST /api/<namespace>/<method>`，信封是
//    `{ type: "client-request", rpcId, method, payload: { args } }`。
//
// cookie 的签名部分不需要解 —— 整个 cookie 值原样带上即可；
// 本脚本**从不打印** cookie 值。
//
// ## 用法
//
//   node scripts/_probe-host-presets.mjs            # 自动发现端口与 cookie
//   node scripts/_probe-host-presets.mjs --expect edge   # 断言 edge 在册
//
// 退出码：0 = 名册已取到（且 --expect 的断言成立）；1 = 断言不成立；
// 2 = 宿主没跑起来 / 拿不到 cookie。

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const EXPECT = process.argv.includes('--expect')
  ? process.argv[process.argv.indexOf('--expect') + 1]
  : null

/** 桌面宿主当前监听的 HTTP 端口。宿主每次重启端口都会变，必须重新发现。 */
function hostPort() {
  const pids = execFileSync('pgrep', ['-f', 'dsh-desktop-host'], { encoding: 'utf8' })
    .split('\n').filter(Boolean)
  for (const pid of pids) {
    try {
      const out = execFileSync('lsof', ['-nP', '-a', '-p', pid, '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' })
      for (const line of out.split('\n')) {
        const m = line.match(/TCP 127\.0\.0\.1:(\d+) \(LISTEN\)/)
        if (m) return Number(m[1])
      }
    } catch { /* lsof 无输出：换下一个 pid */ }
  }
  return null
}

/** 读桌面 App 的 cookie 库（Chromium 的 Cookies 文件）。 */
function readAuthCookies() {
  const db = join(homedir(), 'Library/Application Support/@deepseek-ai/dsh-desktop/Cookies')
  if (!existsSync(db)) return []
  const out = execFileSync('sqlite3', [db, "SELECT name || '~' || value FROM cookies WHERE name LIKE 'dsh-auth-%';"], { encoding: 'utf8' })
  const rows = []
  for (const line of out.split('\n').filter(Boolean)) {
    const i = line.indexOf('~')
    if (i < 0) continue
    const name = line.slice(0, i)
    const value = line.slice(i + 1).trim()
    // cookie 值 = `v1.<base64url(JSON)>`，JSON 里带 authority（host:port）
    let authority = null
    try {
      const json = Buffer.from(value.slice(3), 'base64url').toString('utf8')
      authority = JSON.parse(json.slice(0, json.indexOf('}') + 1)).authority ?? null
    } catch { /* 解析不了就靠端口匹配兜底 */ }
    rows.push({ name, value, authority })
  }
  return rows
}

const port = hostPort()
if (!port) {
  console.error('桌面宿主没在运行（找不到 dsh-desktop-host 的监听端口）')
  process.exit(2)
}

const cookie = readAuthCookies().find((c) => c.authority?.endsWith(`:${port}`))
if (!cookie) {
  console.error(`拿不到 authority 匹配 127.0.0.1:${port} 的 auth cookie（webview 可能还没连上）`)
  process.exit(2)
}

const res = await fetch(`http://127.0.0.1:${port}/api/agentPresets/list`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Cookie: `${cookie.name}=${cookie.value}`,
  },
  body: JSON.stringify({
    type: 'client-request',
    rpcId: 'probe-agent-presets',
    method: 'agentPresets/list',
    payload: { args: {} },
  }),
})

const body = await res.json()
const presets = body?.result?.value?.presets ?? []
console.log(`宿主端口 ${port} ｜ 名册 ${presets.length} 项`)
for (const p of presets) {
  const flags = [
    p.isDefault ? '默认' : '',
    p.broken ? `broken=${p.broken}` : '可组合',
  ].filter(Boolean).join(' ｜ ')
  console.log(`  - ${p.id}${p.name ? `（${p.name}）` : ''} ｜ order ${p.order} ｜ ${flags}`)
}

if (EXPECT) {
  const hit = presets.find((p) => p.id === EXPECT)
  if (!hit) {
    console.error(`断言不成立：名册里没有 id=${EXPECT}`)
    process.exit(1)
  }
  if (hit.broken) {
    console.error(`断言不成立：${EXPECT} 在册但 broken=${hit.broken}`)
    process.exit(1)
  }
  console.log(`断言成立：${EXPECT} 在册且可组合会话`)
}
