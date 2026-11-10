// scripts/_isolate-edge-group.mjs — 把 preset 里的本项目插件行关进
// `cordis:group` + `isolate` 隔离 realm，并把宿主机制要求留在宿主树的行搬回
// 顶层 insert 段（§7.136）。
//
// ## 为什么必须这么改
//
// 宿主 DSH 的 Agent Preset 挂载审计
// （@deepseek-ai/dsh-agent-preset-registry/lib/types/mount.js）：
//
//   const leaked = leakedServices(ctx, ctx.fiber)
//   if (audit.failed.length > 0) throw new Error(audit.failed.join("\n"))
//   if (leaked.length > 0) throw new Error(`Preset services require isolate realms: ${leaked.join(", ")}`)
//
// leakedServices 的判据（lib/types/mount.js:109-123）：挂在 preset 子树里的服务，
// 如果存进的是 **root realm** 的 symbol ⇒ 泄漏 ⇒ 整个 preset 挂载失败 ⇒
// 设置页那张卡显示「加载失败」。
//
// 宿主给的解法（README 原文）：
//   「preset 的服务提供方及其消费方必须共享同一个 cordis:group 隔离 realm。」
//   「A preset plugin that supplies a service must isolate the provider and all
//     its consumers in the same realm.」
//
// 于是本脚本：
//   1. 把 preset 里本项目的插件行整体塞进一个 `cordis:group`（`isolate` 列出组内
//      每一行提供的服务名）—— 组内互相可见，组外（宿主）看不见，不泄漏。
//   2. 把 3 行**必须留在宿主树**的行搬回顶层 insert 段（理由见下）。
//
// ## 那 3 行为什么必须留在宿主树
//
//   dsh-edge-agent（裸包名行）
//     宿主的 client-modules 只扫**宿主 Loader 的 entries**
//     （dsh-client-modules/lib/index.js 文档注释：「scans the host Loader's
//     entries for packages declaring `dsh.client`」；processOne() 遍历
//     `this.ctx.loader.entries()`）。preset 的插件树是独立的 EntryTree，不在
//     loader 的 entry 表里 ⇒ 浏览器半边（Edge tab 的 webview）只有从**宿主树**
//     里的裸包名行才能被发现。行留在宿主树 = 客户端半边始终可被发现。
//
//   audit-log
//     裸包名行 inject ['auditLog']；它必须能在宿主树里解析到 ⇒ auditLog 得在
//     root realm ⇒ 它不能被关进 preset 的隔离 realm（隔离后 preset 的行与宿主
//     树看到的是两个不同实例）。
//
//   file-logger
//     裸包名行 apply() 里第一件事就是 installFileLogger(ctx)，会先占住
//     `fileLogger` 这个服务名。file-logger 行必须和它同在宿主树、并且比它早
//     装载 —— 否则桌面版的 ops log 文件名会从 `dsh-edge-agent-desktop.log`
//     退回 `dsh-edge-agent.log`（resolveLoggerConfig() 的字面量）。
//
// ## 服务名从源码推导，不写死
//
// 行 id ≠ 插件导出的 name（例：行 id `edge-tools-registry` → 插件 name `tools`
// → 服务 `edgeTools`）。所以本脚本按行的 `name:` 字段取子路径，回到
// src/dsh-adapter/<sub>.ts 里读 `super(<ctx>, '<service>')` —— 改源码不会让
// 这张表漂移。门禁 scripts/verify-preset-isolate.ts 用同一套推导复核。
//
// Usage: node scripts/_isolate-edge-group.mjs [--write]

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WRITE = process.argv.includes('--write')
const PKG = '@dsh-edge/dsh-edge-agent'

/** 必须留在宿主树（顶层 insert 段）的行。 */
const HOST_ROWS = new Set(['dsh-edge-agent', 'file-logger', 'audit-log'])

/** 每个变体：顶层 patch 文件 + preset 文件。 */
const VARIANTS = [
  { patch: 'cordis.desktop-safe.patch.yml', preset: 'presets/edge.desktop-safe.patch.yml' },
  { patch: 'cordis.patch.yml', preset: 'presets/edge.patch.yml' },
]

/* ── 服务名推导 ─────────────────────────────────────────────────────────── */

/**
 * 一行插件提供的服务名；不提供服务则返回 undefined。
 *
 * @param {string} rowName - 行的 `name:` 字段（插件 specifier）
 * @returns {string | undefined}
 */
function serviceOfRow(rowName) {
  if (!rowName.startsWith(`${PKG}/`)) return undefined
  const sub = rowName.slice(PKG.length + 1)
  let src
  try {
    src = readFileSync(join(ROOT, 'src', 'dsh-adapter', `${sub}.ts`), 'utf8')
  } catch {
    return undefined
  }
  const m = src.match(/super\(\s*\w+\s*,\s*'([^']+)'\s*\)/)
  return m ? m[1] : undefined
}

/* ── YAML 行块切分 ─────────────────────────────────────────────────────── */

/**
 * 把一段行列表切成「块」：块 = 行头上方的注释 + 该行的全部行。
 *
 * 注释归属规则：**注释属于它下面那一行**（与本仓 patch 文件的写法一致）。
 *
 * @param {string[]} lines
 * @param {number} start - 第一行的下标
 * @param {number} end - 列表结束的行号（不含）
 * @param {number} indent - 行头缩进
 */
function splitBlocks(lines, start, end, indent) {
  const head = new RegExp(`^ {${indent}}- id: `)
  const blocks = []
  let current = null
  let pending = []
  for (let i = start; i < end; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (trimmed === '') {
      if (current) current.lines.push(line)
      continue
    }
    const ind = line.length - line.trimStart().length
    if (head.test(line)) {
      current = { id: line.replace(head, '').trim(), lines: [...pending, line] }
      blocks.push(current)
      pending = []
      continue
    }
    if (trimmed.startsWith('#') && ind <= indent) {
      pending.push(line)
      continue
    }
    if (current) current.lines.push(line)
  }
  return { blocks, pending }
}

/** 取块里 `name:` 字段的值。 */
function nameOf(block) {
  for (const line of block.lines) {
    const m = line.match(/^\s+name:\s*'([^']+)'/)
    if (m) return m[1]
  }
  return undefined
}

/* ── 主流程 ─────────────────────────────────────────────────────────────── */

for (const variant of VARIANTS) {
  const patchPath = join(ROOT, variant.patch)
  const presetPath = join(ROOT, variant.preset)
  const presetLines = readFileSync(presetPath, 'utf8').split('\n')

  // preset 的 `plugins:` 列表区域：[pluginsIdx+1, listEnd)
  const pluginsIdx = presetLines.findIndex((l) => /^ {8}plugins:\s*$/.test(l))
  if (pluginsIdx < 0) {
    console.error(`${variant.preset}: no "plugins:" list found`)
    process.exit(1)
  }
  let listEnd = presetLines.length
  for (let i = pluginsIdx + 1; i < presetLines.length; i++) {
    const line = presetLines[i]
    if (line.trim() === '') continue
    const ind = line.length - line.trimStart().length
    if (ind <= 8) { listEnd = i; break }
  }

  const { blocks, pending } = splitBlocks(presetLines, pluginsIdx + 1, listEnd, 10)
  const ours = blocks.filter((b) => (nameOf(b) ?? '').startsWith(PKG))
  const hostBlocks = blocks.filter((b) => !ours.includes(b))
  const moved = ours.filter((b) => HOST_ROWS.has(b.id))
  const grouped = ours.filter((b) => !HOST_ROWS.has(b.id))

  if (moved.length !== HOST_ROWS.size) {
    console.error(`${variant.preset}: expected ${HOST_ROWS.size} host rows, found ${moved.map((b) => b.id).join(', ')}`)
    process.exit(1)
  }

  // isolate 名单 = 组内每一行提供的服务名。
  const services = []
  for (const block of grouped) {
    const svc = serviceOfRow(nameOf(block) ?? '')
    if (svc && !services.includes(svc)) services.push(svc)
  }
  services.sort()

  const groupLines = [
    '          # ── 边缘模式：本项目的功能（§7.135 + §7.136）──────────────────────',
    '          #',
    '          # 宿主规则（dsh-agent-preset-registry README）：',
    '          #   「preset 的服务提供方及其消费方必须共享同一个 cordis:group 隔离 realm」',
    '          # 挂载审计（lib/types/mount.js）：preset 子树里的服务如果存进 root realm',
    '          # ⇒ 泄漏 ⇒ 整个 preset 挂载失败（设置页那张卡显示「加载失败」）。',
    '          # 所以本组用 cordis:group + isolate 把组内每一行提供的服务关进组内 realm：',
    '          # 组内互相可见，组外（宿主）看不见 ⇒ 不泄漏。',
    '          #',
    '          # isolate 名单由 scripts/_isolate-edge-group.mjs 从源码推导',
    '          # （super(ctx,\'<svc>\')），门禁 scripts/verify-preset-isolate.ts 复核 ——',
    '          # 改源码后必须重跑本脚本。',
    '          - id: edge-stack',
    '            name: cordis:group',
    '            group: true',
    '            isolate:',
    ...services.map((svc) => `              ${svc}: true`),
    '            config:',
  ]
  const groupedText = grouped
    .map((b) => b.lines.map((l) => (l === '' ? '' : `    ${l}`)).join('\n'))
    .join('\n')

  // 拼回 preset：列表前的部分原样 + 宿主行 + 组 + 列表后的部分原样。
  const rebuilt = [
    ...presetLines.slice(0, pluginsIdx + 1),
    ...hostBlocks.flatMap((b) => b.lines),
    ...groupLines,
    ...groupedText.split('\n'),
    ...pending,
    ...presetLines.slice(listEnd),
  ]

  // 顶层 patch：把搬回来的行写成 insert 段（缩进 4 = preset 里的 10 - 6）。
  // 搬回来的块里那条「边缘模式：本项目的功能」旧横幅是 preset 专属的，丢掉 ——
  // 顶层这三行的理由由下面新写的横幅说明。
  const movedText = moved
    .map((b) => {
      const first = b.lines.findIndex((l) => /^ {10}- id: /.test(l))
      const lead = b.lines.slice(0, first)
      // 整段前导注释里只要有一行提到「边缘模式：本项目的功能」，整段丢掉 ——
      // 那条横幅说的是 preset 内部的事，跟留在宿主树的三行无关。
      const drop = lead.some((l) => l.includes('边缘模式：本项目的功能'))
      const lines = drop ? b.lines.slice(first) : b.lines
      return lines.map((l) => (l === '' ? '' : l.replace(/^ {6}/, ''))).join('\n')
    })
    .join('\n')
  const insertSection = [
    '',
    '# ── 本 bundle 留在宿主树的三行（§7.136）──────────────────────────────────',
    '# 理由见 scripts/_isolate-edge-group.mjs 的文件头：',
    '#   dsh-edge-agent（裸包名）—— 宿主 client-modules 只扫宿主 Loader 的 entries，',
    '#     preset 树不在其中 ⇒ Edge tab 的浏览器半边只能从这里被发现；',
    '#   audit-log / file-logger —— 裸包名行 inject auditLog，且它的 installFileLogger',
    '#     会先占住 fileLogger 服务名 ⇒ 两者必须在 root realm，且 file-logger 行要更早装载。',
    '- insert:',
    ...movedText.split('\n'),
  ]

  let patchLines = readFileSync(patchPath, 'utf8').split('\n')
  // 去掉上一次运行留下的同名 insert 段（幂等）。
  const insertIdx = patchLines.findIndex((l) => l === '- insert:')
  if (insertIdx >= 0) {
    let end = insertIdx + 1
    while (end < patchLines.length) {
      const line = patchLines[end]
      const t = line.trim()
      if (t === '' || t.startsWith('#')) { end++; continue }
      if (line.length - line.trimStart().length <= 4) break
      end++
    }
    patchLines.splice(insertIdx, end - insertIdx)
  }
  while (patchLines.length > 0 && patchLines[patchLines.length - 1] === '') patchLines.pop()
  patchLines.push(...insertSection, '')

  if (!WRITE) {
    console.log(`dry run — ${variant.preset}`)
    console.log(`  host rows  : ${hostBlocks.map((b) => b.id).join(', ')}`)
    console.log(`  group rows : ${grouped.map((b) => b.id).join(', ')}`)
    console.log(`  isolate    : ${services.join(', ')}`)
    console.log(`  moved out  : ${moved.map((b) => b.id).join(', ')}`)
    continue
  }

  writeFileSync(presetPath, rebuilt.join('\n'), 'utf8')
  writeFileSync(patchPath, patchLines.join('\n'), 'utf8')
  console.log(`${variant.preset}: ${grouped.length} rows grouped, ${moved.length} rows moved to ${variant.patch}`)
  console.log(`  isolate: ${services.join(', ')}`)
}
