#!/usr/bin/env node
/**
 * probe-desktop-preset-roster.mjs — 读**活着的**宿主 preset roster。
 *
 * 为什么需要它（§7.138）：
 *
 *   「边缘模式有没有挂上」「它是不是当前默认」这两个问题，
 *   从磁盘上的任何文件都答不出来 ——
 *   - preset 的**挂载结果**（broken / 正常）是运行时状态；
 *   - `isDefault` = `selectedDefault ?? default`，`selectedDefault` 是
 *     **live setting**（设置页「设为默认」写的），不是 profile 里的静态行。
 *
 *   所以只能问宿主本身。这个探针复用桌面外壳同款的两步握手：
 *
 *   1. `GET http://127.0.0.1:<port>/?token=<launch token>` → 303 + `Set-Cookie`
 *      （宿主用一次性 launch token 换浏览器会话 cookie）；
 *   2. `POST /api/<namespace>/<method>` + `client-request` 信封 → RPC。
 *
 *   认证 cookie 按 audience 绑 host:port，端口随每次启动变 ⇒ 每次都要重新换。
 *
 * 用法：
 *   node scripts/probe-desktop-preset-roster.mjs <dsh web 启动日志里的完整 URL>
 *   node scripts/probe-desktop-preset-roster.mjs <URL> --set-default <presetId>
 *
 * 例：
 *   node scripts/probe-desktop-preset-roster.mjs \
 *     "http://127.0.0.1:63976/?token=xxxx" --set-default edge
 *
 * 退出码：0 = 成功；1 = 宿主不可达 / 鉴权失败 / RPC 报错。
 */

import { randomUUID } from 'node:crypto'

/** 换一枚浏览器会话 cookie（外壳 `authenticateWebHost` 同款）。 */
async function browserCookie(url) {
  const response = await fetch(url, { redirect: 'manual' })
  const setCookie = response.headers.get('set-cookie')
  await response.body?.cancel()
  if (setCookie === null) {
    throw new Error(`host refused the launch token (status ${response.status}) — is this the current boot URL?`)
  }
  return setCookie.split(';')[0]
}

/** 一次 RPC（宿主 client-connection 的 client-request 信封）。 */
async function rpc(origin, cookie, namespace, method, args = {}) {
  const rpcId = randomUUID()
  const fullMethod = `${namespace}/${method}`
  const response = await fetch(`${origin}/api/${fullMethod}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId, method: fullMethod, payload: { args } }),
  })
  const text = await response.text()
  if (response.status !== 200) throw new Error(`${fullMethod} -> HTTP ${response.status}: ${text.slice(0, 200)}`)
  const envelope = JSON.parse(text)
  const result = envelope?.result
  if (result?.ok !== true) {
    throw new Error(`${fullMethod} -> ${result?.error?.message ?? 'RPC failed'}`)
  }
  return result.value
}

/** 把 roster 渲染成人能读的表格。 */
function formatRoster(roster) {
  const rows = roster?.presets ?? []
  const lines = ['preset                 default  name']
  for (const row of rows) {
    lines.push(
      `${String(row.id).padEnd(22)} ${(row.isDefault === true ? 'YES' : '-').padEnd(8)} ${row.name ?? ''}${
        row.broken === undefined ? '' : `   [broken: ${row.broken}]`
      }`
    )
  }
  return lines.join('\n')
}

async function main() {
  const argv = process.argv.slice(2)
  const url = argv.find((a) => a.startsWith('http'))
  const setIndex = argv.indexOf('--set-default')
  const setDefault = setIndex >= 0 ? argv[setIndex + 1] : undefined
  if (url === undefined) {
    console.error('usage: node scripts/probe-desktop-preset-roster.mjs <dsh web URL> [--set-default <presetId>]')
    process.exit(2)
  }

  const origin = new URL(url).origin
  let cookie
  try {
    cookie = await browserCookie(url)
  } catch (error) {
    console.error(`cannot authenticate against ${origin}: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }

  if (setDefault !== undefined) {
    await rpc(origin, cookie, 'settings', 'update', {
      ns: 'agent-preset-registry',
      patch: { selectedDefault: setDefault },
    })
    console.log(`selectedDefault := ${setDefault}`)
  }

  const roster = await rpc(origin, cookie, 'agentPresets', 'list')
  console.log(formatRoster(roster))
  const edge = (roster?.presets ?? []).find((row) => row.id === 'edge')
  if (edge === undefined) {
    console.log('\nedge preset: ABSENT (the bundle is not mounted)')
    process.exit(1)
  }
  console.log(`\nedge preset: ${edge.broken === undefined ? 'healthy' : `BROKEN (${edge.broken})`}, isDefault=${edge.isDefault === true}`)
  // §7.142: the tab type is registered in EVERY work mode; what the default
  // preset decides is whether a NEW session starts under 边缘模式 (and hence
  // opens itself into the Edge panel).
  console.log(
    edge.isDefault === true
      ? 'Edge tab: registered in every work mode (§7.142); new sessions start under 边缘模式 ⇒ they open the panel themselves.'
      : 'Edge tab: registered in every work mode (§7.142). The default is 标准模式 ⇒ new sessions stay standard; pick 边缘模式 in a session to make it open the panel.',
  )
}

await main()
