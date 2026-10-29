/**
 * §7.145 契约测试 —— 桌面版 cookie 看门狗。
 *
 * 主人在 2026-10-28 撞了「桌面版起不来」：审计链里有 18 次「插件加载完
 * 0.1 秒就死」的启动。根因是 Electron 外壳的 welcome 握手带着 Chromium
 * cookie jar 出发 —— 端口每次随机 ⇒ cookie 名带端口 ⇒ 每次启动多一条永不
 * 回收的 `dsh-auth-*` ⇒ Chromium 把同一 host 的**所有** cookie 塞进 Cookie
 * 头 ⇒ 宿主 web 服务（裸 createServer，16 KB 头上限）⇒ **431** ⇒ 外壳拆宿主。
 *
 * 这里钉住四条契约：
 *
 *   1. **只清死端口的**：活端口（= 当前会话）的那条必须留着；非 `dsh-auth-*`
 *      的 cookie 一根手指都不碰。
 *   2. **抬头上限**：宿主的 `maxHeaderSize` 抬到 64 KB，且只往上抬。
 *   3. **只在桌面版生效**：非 Electron 运行时（web / tui / dsh-edge-agent）
 *      整个插件跳过 —— 不去动无关 profile 的宿主 web 服务。
 *   4. **永不拖垮启动**：库不存在 / 被锁 / 没有 node:sqlite ⇒ 只写报告，不抛。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'

// node:sqlite 走 createRequire —— vite 的解析器不认识它（当成普通包去解析）。
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => {
    exec(sql: string): void
    close(): void
    prepare(sql: string): {
      all(): unknown[]
      run(...args: unknown[]): { changes?: number | bigint }
    }
  }
}

import {
  AUTH_COOKIE_PREFIX,
  DEFAULT_MAX_HEADER_BYTES,
  NODE_MAX_HEADER_SIZE,
  applyHeaderBudget,
  authorityOf,
  classifyCookies,
  cleanCookieJar,
  defaultJarPath,
  isDesktopRuntime,
  portOf,
  projectHeaderBytes,
  raiseHeaderBudget,
  raiseHeaderBudgetWhenReady,
  remainingLaunches,
} from '../../src/dsh-adapter/desktop-cookie-janitor.ts'
import type { CookieRow } from '../../src/dsh-adapter/desktop-cookie-janitor.ts'

/** 造一条形态与宿主一致的 cookie：name = 前缀 + 43 字符，value = v1.<payload>.<sig>。 */
function mintCookie(authority: string, hostKey = '127.0.0.1'): CookieRow {
  const payload = { version: 1, authority, issuedAt: 1, expiresAt: 2 }
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const port = Number(authority.slice(authority.lastIndexOf(':') + 1))
  return { host_key: hostKey, name: `${AUTH_COOKIE_PREFIX}${'A'.repeat(43)}`, value: `v1.${body}.${'B'.repeat(43)}`, source_port: port }
}

describe('authorityOf / portOf', () => {
  it('从 cookie value 里解出 authority', () => {
    assert.equal(authorityOf(mintCookie('127.0.0.1:61254')), '127.0.0.1:61254')
  })

  it('value 被 Chromium 加密时退回 source_port + host_key', () => {
    const encrypted: CookieRow = { host_key: '127.0.0.1', name: 'dsh-auth-x', value: 'ENC(....)', source_port: 5555 }
    assert.equal(authorityOf(encrypted), '127.0.0.1:5555')
  })

  it('既没有 value 也没有 source_port ⇒ undefined', () => {
    assert.equal(authorityOf({ host_key: '127.0.0.1', name: 'x', value: '', source_port: null }), undefined)
  })

  it('portOf 只认真端口', () => {
    assert.equal(portOf('127.0.0.1:8080'), 8080)
    assert.equal(portOf('127.0.0.1'), undefined)
    assert.equal(portOf('127.0.0.1:0'), undefined)
    assert.equal(portOf('127.0.0.1:99999'), undefined)
    assert.equal(portOf(undefined), undefined)
  })
})

describe('请求头投影', () => {
  it('71 条真实形态的 cookie 越过 Node 上限，10 条不越', () => {
    const real = (): CookieRow => ({ host_key: '127.0.0.1', name: `${AUTH_COOKIE_PREFIX}${'A'.repeat(43)}`, value: 'B'.repeat(173), source_port: 1 })
    const many = Array.from({ length: 71 }, real)
    const few = Array.from({ length: 10 }, real)
    assert.ok(projectHeaderBytes(many) > NODE_MAX_HEADER_SIZE)
    assert.ok(projectHeaderBytes(few) < NODE_MAX_HEADER_SIZE)
    assert.equal(remainingLaunches(many), 0)
    assert.ok(remainingLaunches(few) > 0)
  })
})

describe('classifyCookies', () => {
  it('活端口留着，死端口判残骸，别的 cookie 不进 auth 集', async () => {
    const rows: CookieRow[] = [
      mintCookie('127.0.0.1:65000'),
      { host_key: '127.0.0.1', name: `${AUTH_COOKIE_PREFIX}dead`, value: '', source_port: 1 },
      { host_key: 'example.com', name: 'foreign_cookie', value: 'v', source_port: 443 },
    ]
    const groups = await classifyCookies(rows, async (port) => port === 65000)
    assert.equal(groups.foreign.length, 1)
    assert.equal(groups.live.length, 1)
    assert.equal(groups.live[0]?.port, 65000)
    assert.equal(groups.stale.length, 1)
    assert.equal(groups.stale[0]?.port, 1)
    assert.equal(groups.stale[0]?.reason, 'dead-port')
  })

  it('认不出 audience 的 auth cookie 算残骸（多半来自旧端口）', async () => {
    const rows: CookieRow[] = [{ host_key: '127.0.0.1', name: `${AUTH_COOKIE_PREFIX}junk`, value: '', source_port: null }]
    const groups = await classifyCookies(rows, async () => true)
    assert.equal(groups.stale.length, 1)
    assert.equal(groups.stale[0]?.reason, 'unparsable-audience')
    assert.equal(groups.live.length, 0)
  })
})

describe('applyHeaderBudget', () => {
  /** 一个像 http server 的对象（Node 的 Server 有 listen/close）。 */
  const fakeServer = (maxHeaderSize?: number): { maxHeaderSize?: number; listen(): void; close(): void } => ({
    ...(maxHeaderSize === undefined ? {} : { maxHeaderSize }),
    listen() {},
    close() {},
  })

  it('把默认抬到 64 KB', () => {
    const server = fakeServer(NODE_MAX_HEADER_SIZE)
    assert.equal(applyHeaderBudget(server, DEFAULT_MAX_HEADER_BYTES), true)
    assert.equal(server.maxHeaderSize, DEFAULT_MAX_HEADER_BYTES)
  })

  it('已经够大就不动', () => {
    const server = fakeServer(1_000_000)
    assert.equal(applyHeaderBudget(server, DEFAULT_MAX_HEADER_BYTES), false)
    assert.equal(server.maxHeaderSize, 1_000_000)
  })

  it('maxHeaderSize 是 undefined（Node 的真实初态！）⇒ 照样抬', () => {
    // 实测坑：`http.createServer()` 的 server.maxHeaderSize 是 undefined，
    // 不是 16384 —— Node 把默认值放在 parser 里。当年按「不是数字就不动」
    // 写，这道防线永远抬不上限（实机日志：maxHeaderSize unchanged）。
    const server = fakeServer()
    assert.equal(server.maxHeaderSize, undefined)
    assert.equal(applyHeaderBudget(server, DEFAULT_MAX_HEADER_BYTES), true)
    assert.equal(server.maxHeaderSize, DEFAULT_MAX_HEADER_BYTES)
  })

  it('不是 http server（没有 listen/close）⇒ 不动', () => {
    assert.equal(applyHeaderBudget({}, DEFAULT_MAX_HEADER_BYTES), false)
    assert.equal(applyHeaderBudget({ maxHeaderSize: 1 }, DEFAULT_MAX_HEADER_BYTES), false)
  })

  it('不是对象 / 0 或负数 ⇒ 什么都不做', () => {
    assert.equal(applyHeaderBudget(null, DEFAULT_MAX_HEADER_BYTES), false)
    assert.equal(applyHeaderBudget('nope', DEFAULT_MAX_HEADER_BYTES), false)
    const server = fakeServer(NODE_MAX_HEADER_SIZE)
    assert.equal(applyHeaderBudget(server, 0), false)
    assert.equal(applyHeaderBudget(server, -1), false)
    assert.equal(server.maxHeaderSize, NODE_MAX_HEADER_SIZE)
  })

  it('真机语义：抬高后，40 KB 的请求头不再 431', async () => {
    // 这是整条防线的**意义**所在：默认上限下 40 KB 头会被 Node 判 431
    // （桌面版「起不来」就是它）。抬到 64 KB 后同样的请求头通过。
    const { createServer, request } = await import('node:http')
    const big = 'x'.repeat(40 * 1024)
    const call = (server: { maxHeaderSize?: number }): Promise<number> => new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address() as { port: number }
        const req = request({ host: '127.0.0.1', port: address.port, path: '/', headers: { 'x-big': big } }, (res) => {
          res.resume()
          res.on('end', () => { server.close(); resolve(res.statusCode ?? 0) })
        })
        req.on('error', () => { server.close(); resolve(0) })
        req.end()
      })
    })
    const plain = createServer((_req, res) => { res.writeHead(200); res.end('ok') })
    assert.equal(await call(plain), 431, '默认上限下应当 431（这正是主人的故障）')
    const raised = createServer((_req, res) => { res.writeHead(200); res.end('ok') })
    assert.equal(applyHeaderBudget(raised, DEFAULT_MAX_HEADER_BYTES), true)
    assert.equal(await call(raised), 200, '抬高之后同样的请求头应当通过')
  })
})

describe('raiseHeaderBudget（inject 回调拿到的 ctx 代理）', () => {
  /** 一个像 http server 的对象。 */
  const fakeServer = (maxHeaderSize?: number): { maxHeaderSize?: number; listen(): void; close(): void } => ({
    ...(maxHeaderSize === undefined ? {} : { maxHeaderSize }),
    listen() {},
    close() {},
  })

  it('从代理上按服务名取出 web 服务并抬高上限', () => {
    // cordis 的 ctx.inject(deps, cb) 给的是 **ctx 代理**，服务要按名字取；
    // 直接读 `.server` 会被代理解掉（"cannot get property server without inject"）
    // —— 这是实机踩到的坑，必须钉住。
    const server = fakeServer(NODE_MAX_HEADER_SIZE)
    const raised = raiseHeaderBudget({ webServer: { server } }, DEFAULT_MAX_HEADER_BYTES)
    assert.equal(raised, true)
    assert.equal(server.maxHeaderSize, DEFAULT_MAX_HEADER_BYTES)
  })

  it('代理上没有 webServer ⇒ 不动、不抛', () => {
    assert.equal(raiseHeaderBudget({}, DEFAULT_MAX_HEADER_BYTES), false)
    assert.equal(raiseHeaderBudget({ webServer: {} }, DEFAULT_MAX_HEADER_BYTES), false)
    assert.equal(raiseHeaderBudget(null, DEFAULT_MAX_HEADER_BYTES), false)
  })

  it('server 还没建出来时等它 —— 宿主在 listen 的 effect 里才创建 server', async () => {
    // 实机踩到的：inject 回调在**服务构造**时触发，那时 `server` 还是
    // undefined（宿主是 `this.server = createServer(listener)`，在 listen
    // 的 effect 里）。不等着就永远抬不上限。
    const web: { server?: { maxHeaderSize?: number; listen(): void; close(): void } } = {}
    const pending: Array<() => void> = []
    const promise = raiseHeaderBudgetWhenReady(
      { webServer: web },
      DEFAULT_MAX_HEADER_BYTES,
      5,
      0,
      (fn) => { pending.push(fn) },
    )
    assert.equal(pending.length, 1, '还没有 server ⇒ 应当排一次重试')
    web.server = fakeServer(NODE_MAX_HEADER_SIZE)
    pending[0]?.()
    assert.equal(await promise, true)
    assert.equal(web.server.maxHeaderSize, DEFAULT_MAX_HEADER_BYTES, 'server 出现后应当被抬高')
  })
})

describe('isDesktopRuntime', () => {
  it('有 versions.electron ⇒ 桌面版', () => {
    assert.equal(isDesktopRuntime({ electron: '44.7.0' }), true)
  })

  it('没有 ⇒ headless profile（web / tui / dsh-edge-agent）', () => {
    assert.equal(isDesktopRuntime({}), false)
    assert.equal(isDesktopRuntime({ electron: '' }), false)
  })
})

describe('defaultJarPath', () => {
  it('落在 Electron userData 的 Network/Cookies 下', () => {
    const path = defaultJarPath({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming' } as NodeJS.ProcessEnv)
    assert.ok(path.endsWith(join('@deepseek-ai', 'dsh-desktop', 'Network', 'Cookies')), path)
  })
})

describe('cleanCookieJar', () => {
  it('删掉死端口的 auth cookie，活的那条和别的 cookie 都留着', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-janitor-test-'))
    const jar = join(dir, 'Cookies')
    try {
      const db = new DatabaseSync(jar)
      db.exec(`CREATE TABLE cookies (
        host_key TEXT, name TEXT, value TEXT, path TEXT,
        source_port INTEGER, expires_utc INTEGER
      )`)
      const insert = db.prepare('INSERT INTO cookies (host_key, name, value, path, source_port, expires_utc) VALUES (?,?,?,?,?,?)')
      insert.run('127.0.0.1', `${AUTH_COOKIE_PREFIX}live`, 'v1.payload.sig', '/', 65000, 0)
      insert.run('127.0.0.1', `${AUTH_COOKIE_PREFIX}dead`, 'v1.payload.sig', '/', 1, 0)
      insert.run('example.com', 'foreign_cookie', 'v', '/', 443, 0)
      db.close()

      const report = await cleanCookieJar(jar, async (port) => port === 65000)
      assert.equal(report.opened, true)
      assert.equal(report.authCount, 2)
      assert.equal(report.removed, 1)
      assert.equal(report.error, undefined)

      const check = new DatabaseSync(jar, { readOnly: true })
      const rows = check.prepare('SELECT name FROM cookies').all() as Array<{ name: string }>
      check.close()
      const names = rows.map((r) => r.name).sort()
      assert.deepEqual(names, [`${AUTH_COOKIE_PREFIX}live`, 'foreign_cookie'].sort())
      assert.ok(report.projectedBytes < NODE_MAX_HEADER_SIZE)
      assert.ok(report.launchesLeft > 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('库不存在 ⇒ 报告 jar-missing，不抛', async () => {
    const report = await cleanCookieJar(join(tmpdir(), 'dsh-janitor-absent-jar', 'Cookies'))
    assert.equal(report.opened, false)
    assert.equal(report.error, 'jar-missing')
    assert.equal(report.removed, 0)
  })

  it('库打不开（损坏 / 被占）⇒ 报告错误，不抛 —— 清理失败绝不能拖垮启动', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-janitor-broken-'))
    const jar = join(dir, 'Cookies')
    try {
      // 写一堆不是 SQLite 的字节 —— 打开时必然抛。
      writeFileSync(jar, 'this is not a sqlite database')
      const report = await cleanCookieJar(jar)
      assert.equal(report.opened, false)
      assert.ok(report.error !== undefined, '必须给出失败原因')
      assert.equal(report.removed, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('Electron 独占锁住库时同样不抛（锁是文件级的，SQLite 事务锁复现不了，\n' +
     '    但两者走的是同一条 catch 路径 —— 这里用损坏库覆盖它）', async () => {
    // 实测：Electron 开着这个库时，连 copyFileSync 都是 EBUSY（文件级独占），
    // SQLite 自己的事务锁拦不住「另一个连接打开」。所以「打不开」这一类失败
    // 用损坏库来覆盖 —— 断言的契约是同一个：报告错误、绝不抛。
    const dir = mkdtempSync(join(tmpdir(), 'dsh-janitor-garbage-'))
    const jar = join(dir, 'Cookies')
    try {
      writeFileSync(jar, Buffer.from([0x00, 0x01, 0x02, 0x03]))
      const report = await cleanCookieJar(jar, async () => true)
      assert.equal(report.opened, false)
      assert.ok(report.error !== undefined)
      assert.equal(report.authCount, 0)
      assert.equal(report.removed, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
