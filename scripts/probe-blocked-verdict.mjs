#!/usr/bin/env node
/**
 * probe-blocked-verdict.mjs — §7.219 的**取证脚本**（手动跑，不是门禁）
 *
 * ## 它回答什么问题
 *
 * 「那一轮被 fail-closed 拒收时，Edge 面板**到底显示什么**？」
 *
 * ## 为什么需要它（取证边界）
 *
 * 实机（web UI）里，**Edge 面板拿不到会话行** —— 它显示「尚未绑定会话」+ 全局信号
 * （§7.145 记过这条）⇒ 面板的**会话级显示**在那个环境里截不到。
 *
 * ⇒ 换个更硬的验法：把审计链里**那一轮的真实行**原样喂给本仓库的
 * `verdictLine()` 与 `FlowPanel()`，看它们**真的渲染成什么**。
 * 数据是实机产生的，渲染是本仓库的代码 ⇒ 缺的那一环（宿主怎么把行交给面板）
 * 不影响「面板会显示什么」这个结论。
 *
 * ## 它**不是**门禁
 *
 * 它读的是本机的 `~/.dsh-edge-agent/audit/audit.plain.jsonl`（CI 上没有那个文件）
 * ⇒ **不进** `verify:build` 链。想复现的人自己在本机跑：
 *
 * ```
 * node --import tsx/esm scripts/probe-blocked-verdict.mjs
 * node --import tsx/esm scripts/probe-blocked-verdict.mjs --selftest   # 不需要审计链
 * ```
 *
 * 只读：不写仓库内任何文件，不回显凭据。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { verdictLine } from '../src/client/verdict'
import { FlowPanel } from '../src/client/flowPanel'

/** 审计行 → 客户端 EdgeRow。`panel` 只有客户端才有，这里按 kind 前缀粗映射。 */
function toEdgeRow(line, idx) {
  let parsed
  try { parsed = JSON.parse(line) } catch { return null }
  const kind = String(parsed.kind ?? '')
  const panel = /^intent\./.test(kind) ? 'intent'
    : /^(llm|input-guard\.reroute|input-guard\.routed)/.test(kind) ? 'route'
    : /^input-guard\.blocked/.test(kind) ? 'interception'
    : /^(guard|intent-router|sanitizer|prompt-guard)/.test(kind) ? 'threat'
    : 'intent'
  return {
    ts: Number(parsed.ts ?? idx),
    kind,
    panel,
    level: String(parsed.level ?? 'info'),
    seq: idx,
    payload: parsed.payload ?? {},
  }
}

/**
 * 跑一遍关键断言 —— **selftest 与实跑共用**同一份判定逻辑。
 *
 * @param {object[]} window 这一轮的行
 * @param {string} sessionId
 */
function assess(window, sessionId) {
  const v = verdictLine(window)
  const html = String(renderToStaticMarkup(FlowPanel({ rows: window, summary: { sessionId, turns: 2 } })))
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  const checks = [
    ['结论含「已拦截」', v.text.includes('已拦截')],
    ['结论含「未作答」', v.text.includes('未作答')],
    ['结论不含「本地模型作答」', !v.text.includes('本地模型作答')],
    ['路由含「已拦截 · local-endpoint-required」', text.includes('已拦截 · local-endpoint-required')],
    ['路由不含「按原选择」', !text.includes('按原选择')],
    ['落点证据透出（真实落点 / realm / 判定依据）',
      text.includes('真实落点') && text.includes('realm') && text.includes('判定依据')],
  ]
  return { v, text, checks }
}

/** §7.216 实机那一轮的关键行（审计链第 486 / 487 行）。 */
const SELFTEST_FIXTURE = [
  {
    ts: 1794541825221, kind: 'intent.classify.end', panel: 'intent', level: 'info', seq: 1,
    payload: { path: 'llm', category: 'LOCAL', confidence: 0.9 },
  },
  {
    ts: 1794541825222, kind: 'input-guard.reroute.blocked', panel: 'route', level: 'security', seq: 2,
    payload: {
      sessionId: 'session-8393eb16-9b90-49ed-a0b0-6b9d4fc9c7c0',
      provider: 'qwen-token-plan-cn',
      model: 'deepseek-v4.1-flash',
      reason: 'local-endpoint-required',
      delegateProvider: 'qwen-token-plan-cn',
      delegateRealm: 'UNKNOWN',
      realmSource: 'model-router-missing',
    },
  },
]

function selftest() {
  let bad = 0
  const report = (label, ok) => {
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}`)
    if (!ok) bad++
  }

  const { v, checks } = assess(SELFTEST_FIXTURE, 'session-selftest')
  report('结论行显示「已拦截 —— 未作答」', v.text.includes('已拦截') && v.text.includes('未作答'))
  report('tone = blocked', v.tone === 'blocked')
  for (const [name, ok] of checks) report(name, ok)

  // 负向：没有被拒收的轮次 ⇒ 结论行仍然是「本地模型作答」
  const clean = assess([
    {
      ts: 1, kind: 'intent.classify.end', panel: 'intent', level: 'info', seq: 1,
      payload: { path: 'llm', category: 'LOCAL', confidence: 0.9 },
    },
  ], 'session-selftest')
  report('不误伤：没有被拒收 ⇒ 仍然是「本地模型作答」', clean.v.text.includes('本地模型作答'))
  report('不误伤：tone 仍然是 local', clean.v.tone === 'local')

  if (bad > 0) {
    console.error(`\nselftest FAILED: ${bad} assertion(s)`)
    process.exit(2)
  }
  console.log('\nselftest OK')
}

function runReal() {
  const auditPath = process.argv[2] ?? join(homedir(), '.dsh-edge-agent', 'audit', 'audit.plain.jsonl')
  const sessionId = process.argv[3] ?? 'session-8393eb16-9b90-49ed-a0b0-6b9d4fc9c7c0'

  const raw = readFileSync(auditPath, 'utf8').split('\n').filter(Boolean)
  const rows = raw.map(toEdgeRow).filter(Boolean)
  const mine = rows.filter(r => r.payload.sessionId === sessionId)
  if (mine.length === 0) {
    console.error(`no rows for session ${sessionId} in ${auditPath}`)
    process.exit(1)
  }

  // 只看**最后一次**拒收之后的那一批行（= 面板 store 的做法：旧轮次的行被丢弃）。
  const blockedIdx = mine.map((r, i) => (r.kind === 'input-guard.reroute.blocked' ? i : -1)).filter(i => i >= 0)
  const last = blockedIdx.at(-1)
  if (last === undefined) {
    console.error(`session ${sessionId} has no input-guard.reroute.blocked row`)
    process.exit(1)
  }
  const window = mine.slice(last)
  console.log(`session ${sessionId}: ${mine.length} rows; last blocked at #${last + 1}; showing ${window.length} row(s) from there`)
  console.log('kinds:', [...new Set(window.map(r => r.kind))].join(', '))

  const { v, text, checks } = assess(window, sessionId)

  console.log('\n=== 顶部结论 ===')
  console.log(`text : ${v.text}`)
  console.log(`tone : ${v.tone}`)

  const idx = text.indexOf('路由决策')
  console.log('\n=== 路由决策节点附近 ===')
  console.log(idx >= 0 ? text.slice(idx, idx + 260) : '(路由决策 not found)')

  console.log('\n=== 关键断言 ===')
  let bad = 0
  for (const [name, ok] of checks) {
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}`)
    if (!ok) bad++
  }
  process.exit(bad === 0 ? 0 : 1)
}

if (process.argv.includes('--selftest')) selftest()
else runReal()
