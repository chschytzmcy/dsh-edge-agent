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
// §7.175 起它还回答第二个问题：**这个 preset 有没有 broken**。宿主给每个
// preset 一个 `broken` 字段（字符串 = 失败原因）。我们的 preset 层里新增了
// `@deepseek-ai/dsh-agent-default-model` 行，而该插件会 `ctx.inject(['settings'])`
// —— 若 preset scope 链上看不到 settings service，apply 就会失败、preset 变 broken。
//
// ## 怎么问
//
// 1. 宿主进程在 127.0.0.1:<随机端口> 上开 HTTP；
// 2. 鉴权走 Cookie `dsh-auth-*`，其值是 `v1.<base64url(JSON)>`，JSON 里带
//    `authority: "127.0.0.1:<端口>"` —— **必须匹配当前宿主端口**；
// 3. RPC 走 `POST /api/<namespace>/<method>`，信封是
//    `{ type: "client-request", rpcId, method, payload: { args } }`。
//
// cookie 的签名部分不需要解 —— 整个 cookie 值原样带上即可；
// 本脚本**从不打印** cookie 值。
//
// ## 平台差异（§7.175 实测补齐）
//
// | 环节 | macOS | Windows |
// |---|---|---|
// | 找宿主进程 | `pgrep -f dsh-desktop-host` | `Get-CimInstance Win32_Process` |
// | 找监听端口 | `lsof -nP -a -p <pid> -iTCP -sTCP:LISTEN` | `netstat -ano` |
// | cookie 库 | `~/Library/Application Support/@deepseek-ai/dsh-desktop/Cookies` | `%APPDATA%\@deepseek-ai\dsh-desktop\Network\Cookies` |
// | 读 cookie | `sqlite3` CLI | `node:sqlite`（Node ≥ 22.5 内置） |
//
// **Windows 上 cookie 库会被运行中的桌面 App 独占锁住**（`EBUSY`，连
// `FileShare.ReadWrite` 都打不开）⇒ 读不到。两个出口：
//
//   - `--export-cookies <file>`：**桌面 App 退出后**跑一次，把 cookie 落盘；
//   - `--cookie-file <file>`：桌面 App **启动后**用这个文件里的 cookie 去问。
//
// （App 重启时若宿主端口不变，两步之间 cookie 依然有效；即使端口变了，本脚本
// 会把候选 cookie 逐个试，由宿主自己判定哪个有效 —— 401 还是 200 是权威答案。）
//
// ## 用法
//
//   node scripts/_probe-host-presets.mjs            # 自动发现端口与 cookie
//   node scripts/_probe-host-presets.mjs --expect edge   # 断言 edge 在册且不 broken
//   node scripts/_probe-host-presets.mjs --export-cookies cookie.json  # App 退出后跑
//   node scripts/_probe-host-presets.mjs --cookie-file cookie.json      # App 启动后跑
//
// 退出码：0 = 名册已取到（且 --expect 的断言成立）；1 = 断言不成立；
// 2 = 宿主没跑起来 / 拿不到 cookie。

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

// ESM 里没有 require —— node:sqlite 是内置模块，用 createRequire 同步拿。
const requireBuiltin = createRequire(import.meta.url)

const EXPECT = process.argv.includes('--expect')
  ? process.argv[process.argv.indexOf('--expect') + 1]
  : null

const EXPORT = process.argv.includes('--export-cookies')
  ? process.argv[process.argv.indexOf('--export-cookies') + 1]
  : null

const COOKIE_FILE = process.argv.includes('--cookie-file')
  ? process.argv[process.argv.indexOf('--cookie-file') + 1]
  : null

const IS_WINDOWS = process.platform === 'win32'

/** 桌面宿主当前监听的 HTTP 端口。宿主每次重启端口都会变，必须重新发现。 */
function hostPort() {
  if (IS_WINDOWS) return hostPortWindows()
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

/**
 * Windows 版的端口发现。
 *
 * 坑（实测 2026-11-11）：本机**桌面 App 和 headless profile 的可执行文件同名**
 * —— `dsh.cmd` 启动的 CLI 也是 `DeepSeek Harness.exe`。光按进程名筛会把
 * headless profile 的 http-api（21017）也捞进来，问错宿主。
 *
 * 区分依据是**命令行**：
 *   - headless profile：`...\resources\runtime\cli\bin\..\..\..\..\DeepSeek Harness.exe`
 *     ⇒ 含 `runtime\cli`；
 *   - Electron 子进程（gpu / renderer / utility）：含 `--type=`；
 *   - 桌面宿主本体：装在 `...\Programs\DeepSeek Harness\` 下，不带上面两者。
 */
function hostPortWindows() {
  const ps = `$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" `
    + `| Where-Object { $_.CommandLine -and $_.CommandLine -notmatch 'runtime\\\\cli' -and $_.CommandLine -notmatch '--type=' } `
    + `| ForEach-Object { $_.ProcessId }`
  let pids = []
  try {
    pids = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter(Boolean)
  } catch {
    return null
  }
  if (pids.length === 0) return null

  let netstat = ''
  try {
    netstat = execFileSync('netstat', ['-ano'], { encoding: 'utf8' })
  } catch {
    return null
  }
  const want = new Set(pids)
  for (const line of netstat.split('\n')) {
    if (!/LISTENING/i.test(line)) continue
    const parts = line.trim().split(/\s+/)
    if (parts.length < 5) continue
    const m = parts[1].match(/^127\.0\.0\.1:(\d+)$/)
    if (!m) continue
    if (!want.has(parts[parts.length - 1])) continue
    return Number(m[1])
  }
  return null
}

/**
 * 读桌面 App 的 cookie 库（Chromium 的 Cookies 文件），返回
 * `[{ name, value, authority }]`。
 *
 * macOS 走 `sqlite3` CLI；Windows 走 `node:sqlite`（Node ≥ 22.5 内置，
 * 无需外部依赖）。**cookie 值永远不打印。**
 */
function readAuthCookies() {
  if (IS_WINDOWS) return readAuthCookiesWindows()
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

/** Windows 版的 cookie 读取。库被桌面 App 独占锁住 ⇒ 抛给上层报可执行的错。 */
function readAuthCookiesWindows() {
  const db = join(process.env.APPDATA ?? '', '@deepseek-ai', 'dsh-desktop', 'Network', 'Cookies')
  if (!existsSync(db)) return []
  let DatabaseSync
  try {
    ;({ DatabaseSync } = requireBuiltin('node:sqlite'))
  } catch {
    throw new Error('node:sqlite 不可用（需要 Node ≥ 22.5）—— 无法读 Chromium 的 cookie 库')
  }
  const conn = new DatabaseSync(db, { readOnly: true })
  try {
    const rows = conn
      .prepare("SELECT name, value FROM cookies WHERE name LIKE 'dsh-auth-%'")
      .all()
    const out = []
    for (const r of rows) {
      const value = String(r.value ?? '')
      let authority = null
      try {
        const json = Buffer.from(value.slice(3), 'base64url').toString('utf8')
        authority = JSON.parse(json.slice(0, json.indexOf('}') + 1)).authority ?? null
      } catch { /* 解析不了就靠端口匹配兜底 */ }
      out.push({ name: String(r.name), value, authority })
    }
    return out
  } finally {
    conn.close()
  }
}

/* ── 导出模式：桌面 App **退出**后跑，把 cookie 落盘给下一步用 ───────────── */

if (EXPORT) {
  let cookies = []
  try {
    cookies = readAuthCookies()
  } catch (err) {
    console.error(`✗ 读 cookie 库失败：${err?.message ?? err}`)
    console.error('  Windows 上桌面 App 会独占锁住 cookie 库 ⇒ 先把桌面 App 完全退出再跑这一步。')
    process.exit(2)
  }
  if (cookies.length === 0) {
    console.error('✗ cookie 库里没有 dsh-auth-* —— 桌面 App 还没连过宿主，或路径不对。')
    process.exit(2)
  }
  writeFileSync(EXPORT, JSON.stringify(cookies, null, 2), 'utf8')
  console.log(`已导出 ${cookies.length} 个 dsh-auth-* cookie → ${EXPORT}`)
  console.log('  （该文件含凭据，用完请删除；脚本从不打印 cookie 值）')
  process.exit(0)
}

/* ── 正常探测 ─────────────────────────────────────────────────────────────── */

// 端口发现先做：它不依赖 cookie，而且失败时的报错更有指导性
// （「宿主没跑」和「拿不到 cookie」是两回事）。
const port = hostPort()
if (!port) {
  console.error('桌面宿主没在运行（找不到它的监听端口）')
  process.exit(2)
}

let cookies = []
if (COOKIE_FILE) {
  if (!existsSync(COOKIE_FILE)) {
    console.error(`✗ cookie 文件不存在：${COOKIE_FILE}`)
    process.exit(2)
  }
  cookies = JSON.parse(readFileSync(COOKIE_FILE, 'utf8'))
} else {
  try {
    cookies = readAuthCookies()
  } catch (err) {
    console.error(`✗ 读 cookie 库失败：${err?.message ?? err}（宿主端口 ${port}）`)
    if (IS_WINDOWS) {
      console.error('  桌面 App 运行时独占锁住 cookie 库。两条路：')
      console.error('    1) 退出桌面 App 后跑 `--export-cookies <file>`，再启动 App 后跑 `--cookie-file <file>`')
      console.error('    2) 或者直接用桌面 App 的 UI 看 preset 卡片是否 broken')
    }
    process.exit(2)
  }
}

if (cookies.length === 0) {
  console.error(`拿不到 dsh-auth-* cookie（宿主端口 ${port}）`)
  process.exit(2)
}

// 优先用 authority 匹配当前端口的那个；匹配不上就把候选逐个试 ——
// 宿主自己说了算（200 = 有效，401 = 无效）。
const ordered = [
  ...cookies.filter((c) => c.authority?.endsWith(`:${port}`)),
  ...cookies.filter((c) => !c.authority?.endsWith(`:${port}`)),
]

async function callList(cookie) {
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
  return { status: res.status, body: await res.json().catch(() => null) }
}

let body = null
for (const cookie of ordered) {
  let r
  try {
    r = await callList(cookie)
  } catch (err) {
    console.error(`✗ 请求宿主失败：${err?.message ?? err}`)
    process.exit(2)
  }
  if (r.status === 200) {
    body = r.body
    break
  }
}
if (!body) {
  console.error(`✗ ${ordered.length} 个候选 cookie 全部被宿主拒绝（401）—— 宿主端口 ${port}`)
  console.error('  cookie 可能已过期：退出桌面 App → --export-cookies 重导一次 → 再启动 App。')
  process.exit(2)
}

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
