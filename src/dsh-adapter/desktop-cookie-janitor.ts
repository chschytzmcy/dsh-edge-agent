/**
 * desktop-cookie-janitor — §7.145 桌面版「起不来」的根因修复。
 *
 * ## 现象（主人现场，2026-10-28）
 *
 * 桌面版反复起不来，报 "DeepSeek Harness is unavailable"。审计链里能看到
 * **18 次「插件加载完 0.1 秒就死」的启动**（每次只有 8 条事件：
 * config.loaded → policy.loaded → boot.probe → 4 条 hook 注册，然后戛然而止）。
 *
 * ## 根因
 *
 * 桌面版每次启动都用**随机端口**起 web 服务
 * （apps/desktop-host/src/index.ts: `args: ['--no-open','--host','127.0.0.1','--port','0']`），
 * 宿主据此签发浏览器会话 cookie：
 *
 *   cookie 名 = "dsh-auth-" + base64url(sha256(authority))   // authority = "127.0.0.1:<port>"
 *
 * **端口进了 cookie 名** ⇒ 每次启动都是一条**新名字**的 cookie ⇒ 上一轮的 cookie
 * 既不会被命中、也不会因为端口复用而覆盖 ⇒ Chromium 的 cookie jar 无限增长。
 *
 * Chromium 把**同一 host 的全部 cookie** 塞进 Cookie 头（cookie 不按端口隔离，
 * 只有名字里带了端口）⇒ Electron 外壳的 welcome 握手
 * （app.asar/lib/main.js:8885 `net.fetch(url, {credentials:'include'})`）带着
 * 一大堆 cookie 出发 ⇒ 宿主 web 服务是裸 `createServer(listener)`
 * （@deepseek-ai/dsh-host-webserver/lib/index.js:566，未设 maxHeaderSize）
 * ⇒ Node 默认 16384 B 头上限 ⇒ **431 Request Header Fields Too Large**
 * ⇒ 外壳判定 `!authenticated.ok` ⇒ 拆掉宿主 ⇒ 「unavailable」。
 *
 * 实测：71 条 cookie = 16.2 KB（每条 227 B）⇒ 约 69 次启动就撞线。
 *
 * ## 为什么是本插件来修
 *
 * 实测时间线（2026-10-29 01:08:23 一次真实启动）：
 *
 *   01:08:23.030  我们的插件加载（config.loaded）
 *   01:08:25.979  Electron 锁住 cookie 库（welcome 握手触发网络服务）
 *
 * ⇒ 插件加载后有**约 3 秒的窗口**，cookie 库还没被锁 ⇒ 这时候可以把历次启动
 * 留下的死端口 cookie 删掉。Electron 之后才打开这个库，读到的就是清理过的。
 *
 * 同时把宿主 web 服务的 `maxHeaderSize` 抬上去：即使清理没赶上（库已被锁），
 * 一个已经攒胖的 jar 也不会再把启动打死 —— 两道防线，互不依赖。
 *
 * ## 只在桌面版生效
 *
 * 431 只发生在 Electron 外壳（只有它带 Chromium cookie jar）。headless profile
 * （web / tui / dsh-edge-agent）由普通 Node 拉起，自己起 web 服务、客户端不带
 * cookie jar ⇒ 同样场景不会发生。所以本插件用 `process.versions.electron`
 * 判别运行环境，非桌面版一律跳过 —— 不去动无关 profile 里的宿主 web 服务。
 *
 * ## 不做什么
 *
 * - **不碰**非 `dsh-auth-*` 的 cookie（别的站点的）。
 * - **不碰**当前活着端口的那条（= 本次会话的 cookie）。
 * - **不删**认不出 audience 的行以外的东西；认不出的 auth cookie 视为残骸
 *   （它多半来自旧版本/旧端口），但只在 `source_port` 也拿不到时才动它。
 * - 任何一步失败都**静默降级**（返回一份报告，绝不抛）—— 观测/家���不能拖垮启动。
 *
 * @module dsh-edge-agent/desktop-cookie-janitor
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { createConnection } from 'node:net'

export const name = 'desktop-cookie-janitor'

/** 无硬依赖：web 服务用 `ctx.inject(['webServer'])` 延迟取（headless profile
 *  未必有它），cookie 库也不依赖任何服务。 */
export const inject = [] as const

/** 宿主签发的浏览器会话 cookie 前缀（别的 cookie 一律不碰）。 */
export const AUTH_COOKIE_PREFIX = 'dsh-auth-'

/** Node http.Server 的默认请求头上限（bytes）。宿主 web 服务没设 maxHeaderSize，
 *  所以这就是宿主实际生效的门槛。 */
export const NODE_MAX_HEADER_SIZE = 16_384

/** 我们把上限抬到的值（bytes）。64 KB ≈ 280 条 cookie —— 远超 Chromium 的
 *  每域 cookie 上限（180），所以清理一旦失效也不会顶到 Chromium 的淘汰线。 */
export const DEFAULT_MAX_HEADER_BYTES = 65_536

/** Chromium 会话 cookie 之外的请求头估值（Host / UA / sec-ch-* / Accept-* …）。 */
export const OTHER_HEADER_BYTES = 600

/** 单条 cookie 的实测字节：name 52 + value 173 + 2 个分隔符 ≈ 227。 */
export const PER_COOKIE_BYTES = 227

/** cookie 库中的一行（只取我们用得到的列）。 */
export interface CookieRow {
  host_key: string
  name: string
  value: string
  source_port: number | null
}

/* ── 纯逻辑（可单测） ─────────────────────────────────────────────────────── */

/**
 * 从 cookie 里取出 audience（`host:port`）。
 *
 * 宿主签发的是 `v1.<base64url(json)>.<hmac>`，json 里带 authority；但 Chromium
 * 在 Windows 上会用 DPAPI 加密 `value` 列 ⇒ 解析多半失败 ⇒ 退回
 * `host_key` + `source_port`（Chromium 自己记的源端口，一直是对的）。
 */
export function authorityOf(cookie: CookieRow): string | undefined {
  const value = typeof cookie.value === 'string' ? cookie.value : ''
  const parts = value.split('.')
  if (parts.length >= 2 && /^v\d+$/.test(parts[0])) {
    try {
      const json = Buffer.from(parts[1], 'base64url').toString('utf8')
      const payload = JSON.parse(json) as { authority?: unknown }
      if (typeof payload.authority === 'string' && payload.authority.length > 0) {
        return payload.authority
      }
    } catch {
      /* 值被加密了 —— 落到下面的 source_port 兜底 */
    }
  }
  if (cookie.source_port !== undefined && cookie.source_port !== null) {
    return `${String(cookie.host_key)}:${String(cookie.source_port)}`
  }
  return undefined
}

/** 从 audience 里取端口。 */
export function portOf(authority: string | undefined): number | undefined {
  if (typeof authority !== 'string') return undefined
  const at = authority.lastIndexOf(':')
  if (at < 0) return undefined
  const port = Number(authority.slice(at + 1))
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined
}

/**
 * 请求头投影：Chromium 会把同一 host 的全部 cookie 塞进 Cookie 头。
 *
 * @param cookies - 参与发送的 cookie 行
 */
export function projectHeaderBytes(cookies: CookieRow[]): number {
  let bytes = OTHER_HEADER_BYTES
  for (const cookie of cookies) {
    const name = String(cookie.name ?? '')
    const value = String(cookie.value ?? '')
    bytes += name.length + 1 + value.length + 1
  }
  return bytes
}

/** 还能撑几次启动（每次新增一条 cookie）。 */
export function remainingLaunches(cookies: CookieRow[]): number {
  const used = projectHeaderBytes(cookies)
  if (used >= NODE_MAX_HEADER_SIZE) return 0
  return Math.floor((NODE_MAX_HEADER_SIZE - 1 - used) / PER_COOKIE_BYTES)
}

/** 一条 cookie 的判定结果。 */
export interface CookieVerdict {
  cookie: CookieRow
  authority: string | undefined
  port: number | undefined
  /** 端口已死 = 历次启动的残骸，可以删。 */
  stale: boolean
  reason: string
}

/**
 * 把 auth cookie 分成「活的」与「死的」。
 *
 * @param cookies - 库里的全部行（函数自己只挑 `dsh-auth-*`）
 * @param isAlive - (port) => Promise<boolean>，端口存活探针（可注入以便自证）
 */
export async function classifyCookies(
  cookies: CookieRow[],
  isAlive: (port: number) => Promise<boolean>,
): Promise<{ auth: CookieRow[]; foreign: CookieRow[]; stale: CookieVerdict[]; live: CookieVerdict[] }> {
  const auth: CookieRow[] = []
  const foreign: CookieRow[] = []
  for (const cookie of cookies) {
    if (typeof cookie.name === 'string' && cookie.name.startsWith(AUTH_COOKIE_PREFIX)) auth.push(cookie)
    else foreign.push(cookie)
  }
  const stale: CookieVerdict[] = []
  const live: CookieVerdict[] = []
  for (const cookie of auth) {
    const authority = authorityOf(cookie)
    const port = portOf(authority)
    if (port === undefined) {
      // 认不出 audience：算残骸（多半来自旧版本/旧端口），宁可清掉。
      stale.push({ cookie, authority, port, stale: true, reason: 'unparsable-audience' })
      continue
    }
    if (await isAlive(port)) live.push({ cookie, authority, port, stale: false, reason: 'live-port' })
    else stale.push({ cookie, authority, port, stale: true, reason: 'dead-port' })
  }
  return { auth, foreign, stale, live }
}

/**
 * 抬高 web 服务的请求头上限。
 *
 * Node 在**每条连接**建立时把 `server.maxHeaderSize` 读进 parser ⇒ 在握手
 * 之前改好即可生效。
 *
 * ⚠️ 实测坑：`http.createServer()` 建出来的 server 上，`maxHeaderSize` 是
 * **undefined**（不是 16384！）—— Node 把默认值放在 parser 里。所以
 * 「读到的不是数字 ⇒ 不是 http server」这个判据是错的，会让这道防线永远
 * 抬不上。真正的判据是「它像不像一个 http server」（有 listen/close）。
 *
 * @returns 是否真的改了（false = 没接口 / 已经够大 / 被禁用 / 不是 server）
 */
export function applyHeaderBudget(server: unknown, bytes: number): boolean {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return false
  if (server === null || typeof server !== 'object') return false
  const target = server as { maxHeaderSize?: unknown; listen?: unknown; close?: unknown }
  // 只动 http server —— 别的对象不该被塞一个 maxHeaderSize。
  if (typeof target.listen !== 'function' || typeof target.close !== 'function') return false
  const current = target.maxHeaderSize
  if (typeof current === 'number' && current >= bytes) return false
  try {
    target.maxHeaderSize = bytes
    return true
  } catch {
    return false
  }
}

/* ── 环境探测 ───────────────────────────────────────────────────────────── */

/** 桌面版 cookie 库的默认位置（各平台 Electron userData 目录）。 */
export function defaultJarPath(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === 'win32') {
    const base = env.APPDATA ?? join(env.HOME ?? '', 'AppData', 'Roaming')
    return join(base, '@deepseek-ai', 'dsh-desktop', 'Network', 'Cookies')
  }
  if (process.platform === 'darwin') {
    return join(env.HOME ?? '', 'Library', 'Application Support', '@deepseek-ai', 'dsh-desktop', 'Network', 'Cookies')
  }
  return join(env.XDG_CONFIG_HOME ?? join(env.HOME ?? '', '.config'), '@deepseek-ai', 'dsh-desktop', 'Network', 'Cookies')
}

/** 端口上是否还有进程在监听（= 该 cookie 的宿主还活着）。 */
export function probePort(port: number, host = '127.0.0.1', timeoutMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port })
    const done = (alive: boolean) => {
      socket.destroy()
      resolve(alive)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/* ── 实操（打开/删除） ───────────────────────────────────────────────────── */

interface SqliteLike {
  prepare(sql: string): { all(): unknown[]; run(...args: unknown[]): { changes?: number | bigint } }
  exec(sql: string): void
  close(): void
}

/**
 * 载入 `node:sqlite`。
 *
 * 用 `createRequire` 而不是 `await import('node:sqlite')`：vite/vitest 的模块
 * 解析器不认识 `node:sqlite`（会当成普通包去解析 ⇒ "Failed to load url
 * sqlite"），`createRequire` 直接走 Node 的原生解析 ⇒ 单测跑的是**同一条**
 * 真实路径，不是替身。
 */
function loadSqlite(): { DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteLike } {
  const require = createRequire(import.meta.url)
  return require('node:sqlite') as { DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteLike }
}

const READ_ROWS = `SELECT host_key, name, value, path,
                          source_port,
                          CAST(expires_utc AS TEXT) AS expires_utc
                     FROM cookies`

function readRows(db: SqliteLike): CookieRow[] {
  return db.prepare(READ_ROWS).all() as unknown as CookieRow[]
}

function deleteRows(db: SqliteLike, victims: CookieRow[]): number {
  const stmt = db.prepare('DELETE FROM cookies WHERE host_key = ? AND name = ?')
  let removed = 0
  for (const cookie of victims) {
    removed += Number(stmt.run(cookie.host_key, cookie.name).changes ?? 0)
  }
  return removed
}

/** 清理结果（给日志看的客观事实，不含任何 cookie 明文）。 */
export interface JanitorReport {
  /** cookie 库路径（不存在 ⇒ 根本没有桌面版环境）。 */
  jar: string
  /** 库可读吗？不可读 = 打不开（被 Electron 锁着 / 文件损坏）。 */
  opened: boolean
  /** 库里的 auth cookie 总数。 */
  authCount: number
  /** 删掉的条数。 */
  removed: number
  /** 清理后的请求头投影字节数。 */
  projectedBytes: number
  /** 清理后还能撑几次启动。 */
  launchesLeft: number
  /** 出错时的说明（可空）。 */
  error?: string
}

/**
 * 清一次 cookie 库。
 *
 * 全程不抛：库不存在 / 被 Electron 锁着 / 没有 node:sqlite —— 都只写进报告。
 */
export async function cleanCookieJar(jarPath: string, isAlive?: (port: number) => Promise<boolean>): Promise<JanitorReport> {
  const report: JanitorReport = {
    jar: jarPath,
    opened: false,
    authCount: 0,
    removed: 0,
    projectedBytes: 0,
    launchesLeft: 0,
  }
  try {
    if (!existsSync(jarPath)) {
      report.error = 'jar-missing'
      return report
    }
    const { DatabaseSync } = loadSqlite()
    const db = new DatabaseSync(jarPath) as unknown as SqliteLike
    try {
      const rows = readRows(db)
      // 「库可用」= 真读到了 cookie 表（SQLite 构造是惰性的：文件损坏时构造
      // 成功、第一次读表头才炸）。所以 opened 在读完行之后才置位。
      report.opened = true
      const alive = isAlive ?? ((port: number) => probePort(port))
      const groups = await classifyCookies(rows, alive)
      report.authCount = groups.auth.length
      if (groups.stale.length > 0) {
        report.removed = deleteRows(db, groups.stale.map((g) => g.cookie))
      }
      const after = readRows(db)
      const survivors = after.filter((c) => typeof c.name === 'string' && c.name.startsWith(AUTH_COOKIE_PREFIX))
      report.projectedBytes = projectHeaderBytes(survivors)
      report.launchesLeft = remainingLaunches(survivors)
    } finally {
      db.close()
    }
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error)
  }
  return report
}

/* ── 插件 ─────────────────────────────────────────────────────────────────── */

export interface Config {
  /** 关掉整个插件（默认开）。 */
  enabled: boolean
  /** 请求头上限（bytes）；0 = 不动宿主。 */
  maxHeaderBytes: number
  /** cookie 库路径；空 = 按平台默认猜。 */
  jarPath: string
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true),
  maxHeaderBytes: Schema.natural().default(DEFAULT_MAX_HEADER_BYTES),
  jarPath: Schema.string().default(''),
})

interface WebServerFace {
  server?: { maxHeaderSize?: number }
}

/** 宿主 web 服务（@deepseek-ai/dsh-host-webserver）注入的服务名。 */
export const WEB_SERVER_SERVICE = 'webServer'

/**
 * 是不是跑在 Electron 里（= 桌面版）。
 *
 * 桌面版的宿主进程是 Electron 以 `ELECTRON_RUN_AS_NODE=1` 拉起来的
 * （apps/desktop-host/src/index.ts 的 packageManager），所以宿主进程里
 * `process.versions.electron` 有值（实测 44.7.0）。headless profile
 * （web / tui / dsh-edge-agent）由普通 Node 拉起 ⇒ 没有这个字段。
 */
export function isDesktopRuntime(versions: Record<string, string | undefined> = process.versions): boolean {
  return typeof versions.electron === 'string' && versions.electron.length > 0
}

/**
 * 从 inject 回调拿到的 ctx 代理里取出宿主 web 服务。
 *
 * cordis 的 `ctx.inject(deps, cb)` 把 **ctx 代理**交给回调（不是服务本身），
 * 注入的服务要从代理上按**服务名**取（`raw.webServer`）；直接读别的属性
 * 会被代理拒绝（"cannot get property X without inject"）。
 */
export function webServerOf(raw: unknown): WebServerFace | undefined {
  return (raw as Record<string, unknown> | null | undefined)?.[WEB_SERVER_SERVICE] as WebServerFace | undefined
}

/** 立刻抬高上限（web 服务的 http server 已经存在时）。 */
export function raiseHeaderBudget(raw: unknown, bytes: number): boolean {
  return applyHeaderBudget(webServerOf(raw)?.server, bytes)
}

/**
 * 等 web 服务把 http server 建出来，再抬上限。
 *
 * 宿主 web 服务的 `server` 字段是在 `listen` 的 effect 里创建的
 * （`this.server = createServer(listener)`），而 inject 回调在**服务构造**时
 * 就触发了 ⇒ 那一刻 `server` 还是 undefined。所以这里短轮询一下：等它出现
 * 立刻抬（赶在 Electron 的 welcome 握手之前），最多等 ~2 秒。
 *
 * @returns 是否抬成功
 */
export function raiseHeaderBudgetWhenReady(
  raw: unknown,
  bytes: number,
  attempts = 40,
  intervalMs = 50,
  schedule: (fn: () => void, ms: number) => void = setTimeout,
): Promise<boolean> {
  return new Promise((resolve) => {
    const web = webServerOf(raw)
    let attempt = 0
    const tick = (): void => {
      attempt += 1
      const changed = applyHeaderBudget(web?.server, bytes)
      if (changed) { resolve(true); return }
      if (web?.server !== undefined) { resolve(false); return } // 有 server 但抬不动
      if (attempt >= attempts) { resolve(false); return }
      schedule(tick, intervalMs)
    }
    tick()
  })
}

type Injector = { inject(deps: readonly string[], cb: (raw: unknown) => void): void }

export async function apply(ctx: Context, config: Config): Promise<() => void> {
  const cfg: Config = { ...Config, ...(config ?? {}) } as Config
  if (cfg.enabled === false) return () => {}

  if (!isDesktopRuntime()) {
    // headless profile：无 Electron cookie jar ⇒ 没有 431 可修 ⇒ 不碰宿主。
    ctx.logger?.info?.('[desktop-cookie-janitor] not an Electron runtime — skipped')
    return () => {}
  }

  // ── 防线 1：抬高请求头上限 ────────────────────────────────────────────
  //
  // 我们的插件在宿主树里加载，早于 Electron 的 welcome 握手 ⇒ 来得及。
  //
  // cordis 的 `ctx.inject(deps, cb)` 把 **ctx 代理**交给回调（不是服务本身），
  // 注入的服务要从代理上按**服务名**取（`raw.webServer`）；直接读别的属性
  // 会被代理拒绝（"cannot get property X without inject"）。
  const injector = ctx as unknown as Injector
  injector.inject([WEB_SERVER_SERVICE], (raw) => {
    try {
      void raiseHeaderBudgetWhenReady(raw, cfg.maxHeaderBytes).then((raised) => {
        ctx.logger?.info?.(
          `[desktop-cookie-janitor] maxHeaderSize ${raised ? 'raised' : 'unchanged'} → ${cfg.maxHeaderBytes}`,
        )
      })
    } catch (error) {
      // 拿不到 web 服务就只是没有这道防线 —— 不能拖垮启动，更不能刷错误。
      ctx.logger?.warn?.(
        `[desktop-cookie-janitor] header budget skipped: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  })

  // ── 防线 2：开机清掉历次启动的残骸 ────────────────────────────────────
  //
  // 实测这个时刻 cookie 库还没被 Electron 锁住（约 3 秒窗口）：
  //   01:08:23.030 插件加载 → 01:08:25.979 Electron 锁库。
  const jarPath = cfg.jarPath.length > 0 ? cfg.jarPath : defaultJarPath()
  const report = await cleanCookieJar(jarPath)
  ctx.logger?.info?.(
    `[desktop-cookie-janitor] jar=${report.jar} opened=${report.opened} auth=${report.authCount}`
    + ` removed=${report.removed} projected=${report.projectedBytes}B launchesLeft=${report.launchesLeft}`
    + (report.error ? ` error=${report.error}` : ''),
  )

  return () => {}
}
