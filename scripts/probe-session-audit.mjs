#!/usr/bin/env node
/**
 * probe-session-audit.mjs — 判定「某个会话有没有被本项目插件链路碰过」。
 *
 * 为什么需要它：
 *
 *   「标准模式 / 边缘模式会不会触发本项目能力」这个问题，问 UI 标签是**答错**的。
 *   会话记录里同时存在两处 preset 字段，而且都会与实际生效的绑定不一致：
 *
 *     - 会话头（session.v4.jsonl.zstd 的 header.agentPreset）= **创建时**的快照；
 *     - projcache（session_projcache/sessions/*.json 的 rows.agentPreset）= 客户端
 *       当前选择的回写值。
 *
 *   实测（2026-10-28）：主人 13:44 建的会话头写 `edge`，切到标准模式后发消息，
 *   projcache 写 `standard`；历史上还有一批会话头与 projcache 都写 `standard`
 *   却在审计链里跑过完整链路（意图判定 → 路由改写 → local-llm）。
 *
 *   唯一的判据是**审计链**（~/.dsh-edge-agent/audit/audit.plain.jsonl）：本项目的
 *   每个行为插件（input-guard / intent-router / prompt-guard / sanitizer /
 *   model-router / local+cloud llm adapter / function-call-external /
 *   realm-skill-bridge）都会往里写带 sessionId 的事件；没被碰过的会话，
 *   审计链里连一条记录都没有。
 *
 *   用法：
 *     node scripts/probe-session-audit.mjs                    # 全量对照表
 *     node scripts/probe-session-audit.mjs --session <id>     # 单会话取证
 *     node scripts/probe-session-audit.mjs --selftest         # 自证（纯内存）
 *
 *   退出码：0 = 正常；1 = 参数错误 / 路径不存在；2 = 自证失败。
 *
 *   只读：不写任何文件，不回显凭据。
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

/** 默认路径（Windows / POSIX 通用）。 */
export const DEFAULT_AUDIT = join(homedir(), '.dsh-edge-agent', 'audit', 'audit.plain.jsonl')
export const DEFAULT_PROJCACHE = join(homedir(), '.dsh', 'storages', 'session_projcache', 'sessions')
export const DEFAULT_SESSIONS = join(homedir(), '.dsh', 'sessions')

/**
 * 本项目的行为面在审计链里留下的事件种类。用于回答「碰到了哪些能力」。
 * `llm.trace.index` 来自 llm-trace；`realm-skill-bridge.*` 来自 realm 技能桥。
 */
const CAPABILITY_EVENTS = {
  'input-guard.routed': '意图落地 / Realm 登记',
  'input-guard.session-realm.registered': 'Realm 登记',
  // §7.175 (2026-11-11): 路由改写机制退役 —— `route.overridden` /
  // `intent.downgraded` / `selection.restored` 三者都不再产生。取代它们
  // 的是 `intent.local`（判定 LOCAL 时实际用的模型）与
  // `blocked.model-selection`（判定 LOCAL 却选了云端 ⇒ fail-closed 拒收）。
  'input-guard.intent.local': '意图判定为本地（实际用的模型）',
  'input-guard.blocked.model-selection': '本地闸门拒收（选了云端模型）',
  'input-guard.blocked.attack': '攻击拦截',
  'input-guard.blocked.policy': '策略拦截',
  'input-guard.sanitized': 'PII 脱敏生效',
  'input.injection.warned': '注入告警',
  'intent.classify.start': '意图判定（本地模型）',
  'intent.classify.end': '意图判定结论',
  'intent.jev.adopt': 'JEV 意图采纳',
  'guard.model-detect.start': '提示词守卫（本地模型）',
  'guard.model-detect.end': '提示词守卫结论',
  'guard.model-detect.unsafe': '守卫判定为不安全',
  'sanitizer.sanitized': '脱敏器改写',
  'llm.local.start': '本地模型调用',
  'llm.local.end': '本地模型应答',
  'llm.cloud.start': '云模型调用（委托宿主 provider）',
  'llm.cloud.end': '云模型应答',
  'llm.trace.index': 'LLM 出网 trace',
  'realm-skill-bridge.tools.filtered': 'Realm 技能/工具过滤',
  'tool.realm.denied': 'Realm 闸门拒绝',
}

/**
 * 归一化会话 id：宿主在不同地方写出的形式不一致 ——
 * 审计链的 `payload.sessionId` 是 `session-<uuid>`，projcache 的文件名是
 * `session-<uuid>.json`，会话目录是 `session-<uuid>/`。统一去掉前缀，
 * 以裸 uuid 作内部键，展示时再补回去。
 * @param {string} id
 */
export function normalizeId(id) {
  return id.startsWith('session-') ? id.slice('session-'.length) : id
}

/**
 * 解析审计链，按 sessionId 归并。
 * @param {string} text - audit.plain.jsonl 全文
 * @returns {Map<string, {n: number, first: number, last: number, kinds: Set<string>}>}
 */
export function parseAudit(text) {
  const bySession = new Map()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let event
    try { event = JSON.parse(trimmed) } catch { continue }
    const rawId = event?.payload?.sessionId
    if (typeof rawId !== 'string' || rawId.length === 0) continue
    const sessionId = normalizeId(rawId)
    let entry = bySession.get(sessionId)
    if (entry === undefined) {
      entry = { n: 0, first: event.ts ?? 0, last: event.ts ?? 0, kinds: new Set() }
      bySession.set(sessionId, entry)
    }
    entry.n += 1
    entry.last = event.ts ?? entry.last
    if (typeof event.kind === 'string') entry.kinds.add(event.kind)
  }
  return bySession
}

/**
 * 读会话头（.zstd 里的第一行 JSON）。
 * @param {string} file - session.v4.jsonl.zstd 路径
 * @returns {{agentPreset?: string, createdAt?: number}|null}
 */
export function readSessionHeader(file) {
  try {
    const text = zstdDecompressSync(readFileSync(file)).toString('utf8')
    const first = text.split('\n').find((line) => line.trim().length > 0)
    if (first === undefined) return null
    const header = JSON.parse(first)
    return { agentPreset: header.agentPreset, createdAt: header.createdAt }
  } catch {
    return null
  }
}

/**
 * 读 projcache 里与取证相关的字段。
 * @param {string} file - session_projcache/sessions/session-<id>.json 路径
 */
export function readProjcache(file) {
  let parsed
  try { parsed = JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
  const rows = parsed?.record?.rows ?? {}
  const timeline = rows.contextTimeline?.val
  return {
    agentPreset: rows.agentPreset?.val,
    title: rows.title?.val,
    model: timeline?.model,
    provider: timeline?.provider,
    lastPromptAt: timeline?.lastUser !== undefined ? rows.sessionListMetadata?.val?.lastPromptAt : undefined,
  }
}

/**
 * 判定：这次会话有没有被本项目插件链路碰过。
 * 判据只有一条 —— 审计链里有没有带这个 sessionId 的事件。
 * @param {string} sessionId
 * @param {Map<string, {n: number, kinds: Set<string>}>} auditIndex
 */
export function verdict(sessionId, auditIndex) {
  const entry = auditIndex.get(sessionId)
  if (entry === undefined) {
    return { touched: false, n: 0, capabilities: [], kinds: [] }
  }
  const capabilities = []
  for (const kind of entry.kinds) {
    const label = CAPABILITY_EVENTS[kind]
    if (label !== undefined && !capabilities.includes(label)) capabilities.push(label)
  }
  return { touched: true, n: entry.n, capabilities, kinds: [...entry.kinds].sort() }
}

/** 把一个会话的行渲染成人类可读的文本。 */
export function renderSession(row) {
  const lines = []
  lines.push(`sessionId   : session-${row.sessionId}`)
  lines.push(`结论        : ${row.touched ? `本项目插件链路已执行（${row.n} 条审计事件）` : '本项目插件链路未触发（审计链零事件）'}`)
  lines.push(`preset 标签 : 会话头=${row.headerPreset ?? '?'} | projcache=${row.projcachePreset ?? '?'}${row.labelMismatch ? '   ← 两者不一致，标签不可作判据' : ''}`)
  lines.push(`实际模型    : ${row.model ?? '?'} / ${row.provider ?? '?'}`)
  if (row.title !== undefined && row.title !== null) lines.push(`会话标题    : ${row.title}`)
  if (row.touched) {
    lines.push(`触发的能力  : ${row.capabilities.length > 0 ? row.capabilities.join('、') : '（仅日志类事件）'}`)
    lines.push(`事件种类    : ${row.kinds.join(', ')}`)
  }
  return lines.join('\n')
}

/** 收集所有会话的取证行。 */
export function collectSessions({ auditPath, projcacheDir, sessionsDir }) {
  const auditIndex = existsSync(auditPath)
    ? parseAudit(readFileSync(auditPath, 'utf8'))
    : new Map()
  const rows = []
  const ids = new Set(auditIndex.keys())
  if (existsSync(projcacheDir)) {
    for (const file of readdirSync(projcacheDir)) {
      if (!file.startsWith('session-') || !file.endsWith('.json')) continue
      ids.add(normalizeId(file.slice(0, -'.json'.length)))
    }
  }
  // 会话目录在 ~/.dsh/sessions/<workspace-slug>/session-<uuid>/ 下 —— 两层。
  const headerOf = new Map()
  if (existsSync(sessionsDir)) {
    for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const workspaceDir = join(sessionsDir, entry.name)
      let children
      try { children = readdirSync(workspaceDir, { withFileTypes: true }) } catch { continue }
      for (const child of children) {
        if (!child.isDirectory() || !child.name.startsWith('session-')) continue
        const id = normalizeId(child.name)
        ids.add(id)
        const header = readSessionHeader(join(workspaceDir, child.name, 'session.v4.jsonl.zstd'))
        if (header !== null) headerOf.set(id, header)
      }
    }
  }
  for (const sessionId of ids) {
    const header = headerOf.get(sessionId) ?? null
    const projcache = existsSync(projcacheDir)
      ? readProjcache(join(projcacheDir, `session-${sessionId}.json`))
      : null
    const result = verdict(sessionId, auditIndex)
    rows.push({
      sessionId,
      touched: result.touched,
      n: result.n,
      capabilities: result.capabilities,
      kinds: result.kinds,
      headerPreset: header?.agentPreset,
      projcachePreset: projcache?.agentPreset,
      labelMismatch: header?.agentPreset !== undefined && projcache?.agentPreset !== undefined
        && header.agentPreset !== projcache.agentPreset,
      model: projcache?.model,
      provider: projcache?.provider,
      title: projcache?.title,
    })
  }
  return rows
}

/** 自证：纯内存 fixture，不碰主人的文件系统。 */
function selftest() {
  const failures = []
  const check = (name, condition) => { if (!condition) failures.push(name) }

  const auditText = [
    JSON.stringify({ ts: 1000, kind: 'input-guard.routed', payload: { sessionId: 'session-a' } }),
    JSON.stringify({ ts: 1001, kind: 'intent.classify.end', payload: { sessionId: 'session-a' } }),
    JSON.stringify({ ts: 1002, kind: 'llm.local.start', payload: { sessionId: 'session-a' } }),
    JSON.stringify({ ts: 2000, kind: 'input-guard.hook.registered', payload: {} }),
    'not-json-line',
  ].join('\n')

  const index = parseAudit(auditText)
  check('审计 id 归一化去前缀', normalizeId('session-abc') === 'abc')
  check('审计 id 归一化保留裸 id', normalizeId('abc') === 'abc')
  check('audit 索引含被碰过的会话', index.has('a'))
  check('audit 索引不含未碰过的会话', !index.has('b'))
  check('事件计数正确', index.get('a').n === 3)
  check('全局事件不进会话索引', index.size === 1)

  const touched = verdict('a', index)
  check('判定为已触发', touched.touched === true)
  check('能力清单非空', touched.capabilities.length === 3)
  const untouched = verdict('b', index)
  check('判定为未触发', untouched.touched === false)
  check('未触发时能力清单为空', untouched.capabilities.length === 0)

  const rendered = renderSession({
    sessionId: 'session-b',
    touched: false,
    n: 0,
    capabilities: [],
    kinds: [],
    headerPreset: 'edge',
    projcachePreset: 'standard',
    labelMismatch: true,
    model: 'qwen3.8-flash',
    provider: 'qwen-token-plan-cn',
    title: '询问AI助手能力',
  })
  check('渲染含未触发结论', rendered.includes('未触发'))
  check('渲染标出标签不一致', rendered.includes('标签不可作判据'))

  if (failures.length > 0) {
    console.error('selftest FAILED:')
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(2)
  }
  console.log('selftest OK: 审计索引 / 判定 / 渲染 三段自证通过')
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--selftest')) {
    selftest()
    return
  }
  const option = (name, fallback) => {
    const index = argv.indexOf(name)
    return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
  }
  const auditPath = option('--audit', DEFAULT_AUDIT)
  const projcacheDir = option('--projcache', DEFAULT_PROJCACHE)
  const sessionsDir = option('--sessions', DEFAULT_SESSIONS)
  const focus = option('--session', undefined)

  if (!existsSync(auditPath)) {
    console.error(`audit chain not found: ${auditPath}`)
    process.exit(1)
  }

  const rows = collectSessions({ auditPath, projcacheDir, sessionsDir })
  if (focus !== undefined) {
    const row = rows.find((r) => r.sessionId === focus || r.sessionId === `session-${focus}`)
    if (row === undefined) {
      console.error(`session not found: ${focus}`)
      process.exit(1)
    }
    console.log(renderSession(row))
    return
  }

  rows.sort((a, b) => (b.touched ? 1 : 0) - (a.touched ? 1 : 0) || b.n - a.n)
  console.log(`审计链: ${auditPath}`)
  console.log(`会话总数: ${rows.length}   被本项目插件碰过: ${rows.filter((r) => r.touched).length}\n`)
  for (const row of rows) {
    console.log(`${row.touched ? 'TOUCHED' : '  clean'} session-${row.sessionId.padEnd(38)} ${row.touched ? String(row.n).padStart(4) + ' ev' : '   -'}  ${(row.model ?? '?').padEnd(22)} ${(row.provider ?? '?').padEnd(20)} preset[头=${row.headerPreset ?? '?'} 缓存=${row.projcachePreset ?? '?'}]${row.labelMismatch ? ' ⚠标签不一致' : ''}`)
  }
  console.log('\n判据：审计链里有没有带该 sessionId 的事件。preset 标签不可作判据。')
}

await main()
