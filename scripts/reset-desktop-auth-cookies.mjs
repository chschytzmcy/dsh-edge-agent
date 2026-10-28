#!/usr/bin/env node
/**
 * reset-desktop-auth-cookies.mjs — §7.137 桌面版启动失败修复工具。
 *
 * 背景（2026-10-28 实测，见 docs/desktop-troubleshooting.md）：
 *
 *   宿主桌面版每次启动都用随机端口起 web 服务
 *   （apps/desktop-host/src/index.ts: `args: ['--no-open','--host','127.0.0.1','--port','0']`），
 *   宿主据此签发浏览器会话 cookie：
 *
 *     cookie 名 = "dsh-auth-" + base64url(sha256(authority))     // authority = "127.0.0.1:<port>"
 *     有效期   = cookieMaxAgeDays（默认 30 天）
 *
 *   端口进了 cookie 名 ⇒ 每次启动都是一条**新名字**的 cookie ⇒ 上一轮的 cookie
 *   既不会被命中也永远不会过期 ⇒ Chromium 的 cookie jar 无限增长（实测 71 条 /
 *   16.2 KB，每条 226 B）。
 *
 *   Electron 外壳的 welcome 握手用 `net.fetch(url, {credentials:'include'})`
 *   （app.asar/lib/main.js:8885），它**带 cookie jar** ⇒ 请求头里塞进全部 71 条
 *   cookie；而宿主 web 服务是裸 `createServer(listener)`
 *   （@deepseek-ai/dsh-host-webserver/lib/index.js:412，未设 maxHeaderSize）
 *   ⇒ Node 默认 16384 B 头上限 ⇒ **431 Request Header Fields Too Large**
 *   ⇒ 外壳判定 `!authenticated.ok` ⇒ 抛 "desktop welcome: Web authentication failed"
 *   ⇒ 拆掉宿主 ⇒ 「DeepSeek Harness is unavailable」。
 *
 *   外壳第一步 `authenticateWebHost`（main.js:8230）用的是 Node 的 `fetch`，
 *   它没有 cookie jar ⇒ 头很小 ⇒ 303 正常。这就是「Node 通、Electron 不通」的
 *   割裂原因，也是为什么直连 web 服务看起来一切正常。
 *
 * 本工具做什么：
 *   1. 读桌面版的 Chromium cookie 库（Electron 必须已退出，否则库被锁）；
 *   2. 把 `dsh-auth-*` cookie 按 audience 端口分类：
 *        live  = 该端口当前还有进程监听（= 本次运行中的宿主）
 *        stale = 端口已死（= 历次启动留下的垃圾）
 *   3. 报告 **请求头投影大小**（cookie 合计 + 其余请求头估值）与 Node 的 16384
 *      上限的关系 —— 这就是「还能撑几次启动」的判据；
 *   4. `--apply` 时删除 stale cookie（默认不动 live 的那条会话 cookie）。
 *
 * 用法：
 *   node scripts/reset-desktop-auth-cookies.mjs                  # 只报告，不改
 *   node scripts/reset-desktop-auth-cookies.mjs --apply          # 清掉死端口 cookie
 *   node scripts/reset-desktop-auth-cookies.mjs --apply --all    # 连 live 的会话 cookie 一起清
 *   node scripts/reset-desktop-auth-cookies.mjs --jar <path>     # 指定 cookie 库
 *   node scripts/reset-desktop-auth-cookies.mjs --selftest       # 自证（门禁用）
 *
 * 注意：Electron 运行时 cookie 库被独占锁，工具会拒绝在此时改动 —— 先退出桌面版。
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection } from 'node:net'
import { pathToFileURL } from 'node:url'

/** Node http.Server 的默认请求头上限（bytes）。宿主 web 服务没设 maxHeaderSize，
 *  所以这就是宿主实际生效的门槛。 */
export const NODE_MAX_HEADER_SIZE = 16384
/** Chromium 会话 cookie 之外的请求头估值（Host / UA / sec-ch-* / Accept-* …）。
 *  实测约 500–600 B，用 600 保守估计。 */
export const OTHER_HEADER_BYTES = 600
/** 宿主签发的浏览器会话 cookie 前缀。 */
export const AUTH_COOKIE_PREFIX = 'dsh-auth-'

/** 桌面版 cookie 库的默认位置（各平台 Electron userData 目录）。 */
export function defaultJarPath() {
  if (process.platform === 'win32') {
    const base = process.env.APPDATA ?? join(process.env.HOME ?? '', 'AppData', 'Roaming')
    return join(base, '@deepseek-ai', 'dsh-desktop', 'Network', 'Cookies')
  }
  if (process.platform === 'darwin') {
    return join(
      process.env.HOME ?? '',
      'Library',
      'Application Support',
      '@deepseek-ai',
      'dsh-desktop',
      'Network',
      'Cookies'
    )
  }
  return join(
    process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? '', '.config'),
    '@deepseek-ai',
    'dsh-desktop',
    'Network',
    'Cookies'
  )
}

/**
 * 从 cookie 值里取出 audience（host:port）。
 *
 * 宿主签发的是 `v1.<base64url(json)>.<hmac>`，json 里带 authority 与有效期；
 * 值被 Chromium 加密时退回到库里的 source_port + host_key 两列。
 */
export function authorityOf(cookie) {
  const value = typeof cookie.value === 'string' ? cookie.value : ''
  const parts = value.split('.')
  if (parts.length >= 2 && /^v\d+$/.test(parts[0])) {
    try {
      const json = Buffer.from(parts[1], 'base64url').toString('utf8')
      const payload = JSON.parse(json)
      if (typeof payload.authority === 'string') return payload.authority
    } catch {
      /* 落到下面的 source_port 兜底 */
    }
  }
  if (cookie.source_port !== undefined && cookie.source_port !== null) {
    return `${String(cookie.host_key)}:${String(cookie.source_port)}`
  }
  return undefined
}

/** 从 audience 里取端口。 */
export function portOf(authority) {
  if (typeof authority !== 'string') return undefined
  const at = authority.lastIndexOf(':')
  if (at < 0) return undefined
  const port = Number(authority.slice(at + 1))
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined
}

/** 端口上是否还有进程在监听（= 该 cookie 的宿主还活着）。 */
export function probePort(port, host = '127.0.0.1', timeoutMs = 250) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port })
    const done = (alive) => {
      socket.destroy()
      resolve(alive)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/**
 * 把 cookie 分成三类。
 *
 * @param cookies - 库里读到的全部 cookie 行
 * @param isAlive - (port) => Promise<boolean>，端口存活探针（可注入以便自证）
 */
export async function classify(cookies, isAlive) {
  const auth = []
  const foreign = []
  for (const cookie of cookies) {
    if (typeof cookie.name === 'string' && cookie.name.startsWith(AUTH_COOKIE_PREFIX)) auth.push(cookie)
    else foreign.push(cookie)
  }
  const stale = []
  const live = []
  for (const cookie of auth) {
    const authority = authorityOf(cookie)
    const port = portOf(authority)
    if (port === undefined) {
      // 认不出 audience：算 stale（它多半来自旧版本/旧端口），宁可清掉。
      stale.push({ cookie, authority, reason: 'unparsable-audience' })
      continue
    }
    if (await isAlive(port)) live.push({ cookie, authority, port })
    else stale.push({ cookie, authority, port, reason: 'dead-port' })
  }
  return { auth, foreign, stale, live }
}

/**
 * 请求头投影：Chromium 会把同一 host 的全部 cookie 塞进 Cookie 头。
 *
 * @param cookies - 参与发送的 cookie 行
 */
export function projectHeaderBytes(cookies) {
  let bytes = OTHER_HEADER_BYTES
  for (const cookie of cookies) {
    const name = String(cookie.name ?? '')
    const value = String(cookie.value ?? '')
    bytes += name.length + 1 + value.length + 1
  }
  return bytes
}

/** 还能撑几次启动（每次新增一条 cookie）。 */
export function remainingLaunches(cookies) {
  const perLaunch = 226
  const used = projectHeaderBytes(cookies)
  if (used >= NODE_MAX_HEADER_SIZE) return 0
  return Math.floor((NODE_MAX_HEADER_SIZE - 1 - used) / perLaunch)
}

/** 从库里删掉给定 cookie 行。 */
export function deleteCookies(db, cookies) {
  const stmt = db.prepare('DELETE FROM cookies WHERE host_key = ? AND name = ?')
  let removed = 0
  for (const cookie of cookies) {
    removed += Number(stmt.run(cookie.host_key, cookie.name).changes ?? 0)
  }
  return removed
}

/** 打开 cookie 库（可写）。Electron 运行时会被独占锁拒绝 —— 这正是我们要的门。 */
export async function openJar(path, writable) {
  const { DatabaseSync } = await import('node:sqlite')
  return new DatabaseSync(path, { readOnly: !writable })
}

function readAll(db) {
  // expires_utc 是 Chromium 的 int64（1601 纪元微秒），超出 JS 安全整数 ⇒ 取文本。
  return db
    .prepare(
      `SELECT host_key, name, value, path, source_port,
              CAST(expires_utc AS TEXT) AS expires_utc
         FROM cookies`
    )
    .all()
}

function formatReport(jarPath, cookies, groups, limit) {
  const projected = projectHeaderBytes(cookies)
  const lines = []
  lines.push(`jar            : ${jarPath}`)
  lines.push(`cookies total  : ${cookies.length}`)
  lines.push(`  dsh-auth-*   : ${groups.auth.length}`)
  lines.push(`  other        : ${groups.foreign.length}`)
  lines.push(`  live port    : ${groups.live.length}`)
  lines.push(`  stale (dead) : ${groups.stale.length}`)
  lines.push(`projected req  : ${projected} B / limit ${limit} B`)
  lines.push(`headroom       : ${limit - projected} B`)
  lines.push(`launches left  : ~${remainingLaunches(cookies)}`)
  if (projected >= limit) {
    lines.push('VERDICT        : OVER LIMIT — 桌面版 welcome 握手会拿到 431，删掉 stale cookie')
  } else {
    lines.push('VERDICT        : within limit')
  }
  return lines.join('\n')
}

/** 自证：不依赖宿主、不依赖桌面版，用构造出来的 cookie 库验证分类与删除逻辑。 */
async function selftest() {
  const failures = []
  const check = (name, ok, detail) => {
    if (ok) console.log(`  ok   ${name}`)
    else {
      console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
      failures.push(name)
    }
  }

  const dir = mkdtempSync(join(tmpdir(), 'dsh-auth-cookie-selftest-'))
  const jar = join(dir, 'Cookies')
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(jar)
    db.exec(
      `CREATE TABLE cookies (
         host_key TEXT, name TEXT, value TEXT, path TEXT,
         source_port INTEGER, expires_utc INTEGER
       )`
    )
    const insert = db.prepare(
      'INSERT INTO cookies (host_key, name, value, path, source_port, expires_utc) VALUES (?,?,?,?,?,?)'
    )
    // 造一条形态与宿主一致的 cookie：v1.<base64url(json)>.<sig>
    const mint = (authority, issuedAt = Date.now()) => {
      const payload = { version: 1, authority, issuedAt, expiresAt: issuedAt + 30 * 86400000 }
      const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
      return `v1.${body}.${'A'.repeat(43)}`
    }
    const deadPort = 1 // 不会有人监听 1 端口
    insert.run('127.0.0.1', `${AUTH_COOKIE_PREFIX}dead`, mint(`127.0.0.1:${deadPort}`), '/', deadPort, 0)
    insert.run('127.0.0.1', `${AUTH_COOKIE_PREFIX}live`, mint('127.0.0.1:65000'), '/', 65000, 0)
    insert.run('example.com', 'foreign_cookie', 'v', '/', 443, 0)

    const rows = readAll(db)
    check('fixture has 3 rows', rows.length === 3, `got ${rows.length}`)

    const groups = await classify(rows, async (port) => port === 65000)
    check('one foreign cookie kept out of the auth set', groups.foreign.length === 1)
    check('dead-port auth cookie classified stale', groups.stale.length === 1 && groups.stale[0].port === deadPort)
    check('live-port auth cookie classified live', groups.live.length === 1 && groups.live[0].port === 65000)

    const removed = deleteCookies(db, groups.stale.map((g) => g.cookie))
    check('one stale row deleted', removed === 1, `removed ${removed}`)
    const after = readAll(db)
    check('stale row gone', !after.some((c) => c.name === `${AUTH_COOKIE_PREFIX}dead`))
    check('live row kept', after.some((c) => c.name === `${AUTH_COOKIE_PREFIX}live`))
    check('foreign row kept', after.some((c) => c.name === 'foreign_cookie'))

    // authority 解析
    const parsed = authorityOf({ host_key: '127.0.0.1', name: 'x', value: mint('127.0.0.1:61254') })
    check('authority parsed from cookie value', parsed === '127.0.0.1:61254', parsed)
    const parsedFallback = authorityOf({ host_key: '127.0.0.1', name: 'x', value: '', source_port: 5555 })
    check('authority falls back to source_port', parsedFallback === '127.0.0.1:5555', parsedFallback)

    // 请求头投影：71 条真实形态的 cookie 必须越过 Node 上限，10 条不能。
    // 真实 cookie 的实测尺寸：name = 9 + 43 = 52 字符，value = "v1." + base64url(json)
    // + "." + 43 = 173 字符 ⇒ 每条 227 B（71 条合计 16,117 B，与现场测量一致）。
    const realCookie = () => ({ name: `${AUTH_COOKIE_PREFIX}${'A'.repeat(43)}`, value: 'B'.repeat(173) })
    const many = Array.from({ length: 71 }, realCookie)
    const few = Array.from({ length: 10 }, realCookie)
    check('71 cookies project over the Node limit', projectHeaderBytes(many) > NODE_MAX_HEADER_SIZE)
    check('10 cookies stay under the Node limit', projectHeaderBytes(few) < NODE_MAX_HEADER_SIZE)
    check('remaining launches is finite', remainingLaunches(few) > 0 && remainingLaunches(many) === 0)
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  if (failures.length > 0) {
    console.error(`selftest: ${failures.length} check(s) failed`)
    process.exit(1)
  }
  console.log('selftest: all checks passed')
}

async function main() {
  const argv = process.argv.slice(2)
  const options = { apply: false, all: false, dryRun: false, selftest: false, jar: undefined, limit: NODE_MAX_HEADER_SIZE }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--apply') options.apply = true
    else if (arg === '--all') options.all = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--selftest') options.selftest = true
    else if (arg === '--jar') options.jar = argv[++i]
    else if (arg === '--limit') options.limit = Number(argv[++i])
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: node scripts/reset-desktop-auth-cookies.mjs [--apply] [--all] [--jar <path>] [--limit <bytes>] [--selftest]')
      return
    } else {
      console.error(`unknown option: ${arg}`)
      process.exit(2)
    }
  }

  if (options.selftest) {
    await selftest()
    return
  }

  const jarPath = options.jar ?? defaultJarPath()
  if (!existsSync(jarPath)) {
    console.log(`no cookie jar at ${jarPath} — nothing to do`)
    return
  }

  let db
  try {
    db = await openJar(jarPath, options.apply)
  } catch (error) {
    console.error(`cannot open cookie jar: ${jarPath}`)
    console.error(`  ${error instanceof Error ? error.message : String(error)}`)
    console.error('  桌面版还在运行时会锁住这个库 —— 先退出桌面版再试。')
    process.exit(1)
  }

  try {
    const cookies = readAll(db)
    const groups = await classify(cookies, (port) => probePort(port))
    console.log(formatReport(jarPath, cookies, groups, options.limit))

    const victims = options.all ? groups.auth : groups.stale.map((g) => g.cookie)
    if (!options.apply || options.dryRun) {
      console.log(`\n(dry run) ${victims.length} cookie(s) would be removed`)
      return
    }
    if (victims.length === 0) {
      console.log('\nnothing to remove')
      return
    }
    const removed = deleteCookies(db, victims)
    console.log(`\nremoved ${removed} cookie(s)`)
    const after = readAll(db)
    const groupsAfter = await classify(after, (port) => probePort(port))
    console.log(formatReport(jarPath, after, groupsAfter, options.limit))
    if (projectHeaderBytes(after) >= options.limit) {
      console.log('still over the limit: run with --all to drop every dsh-auth cookie')
    }
  } finally {
    db.close()
  }
}

// 只在被直接执行时跑；被 import 时只导出纯函数（门禁与单测用）。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}

export { main, selftest }
