// scripts/_migrate-edge-rows.mjs — move this bundle's rows from the
// top-level insert section of a cordis patch into the `plugins:` list of an
// Agent Preset patch (§7.135).
//
// Why: a preset's `plugins` list is the COMPLETE plugin set of that work
// mode. Rows that stay in the bundle's top-level insert section are mounted
// for EVERY mode — so the Edge behaviour would still be active while the
// host sits in `standard`, and the "边缘模式 = 标准模式 + 本项目功能" promise
// would be a lie.
//
// 主人裁决（2026-10-28）：「只有选择 边缘模式 才会出现 edge tab」—— 所以
// **本 bundle 的全部插件行都进 preset**：连 Edge 面板（edge-context-view）与
// 它的 client 注册（裸包名行）一起。标准模式是**纯 DSH**，一个字节都不留。
//
// The top level keeps only the host-row OVERRIDES (tool-web / web / …) —
// those are patch-layer semantics; a preset can declare plugin rows but
// cannot override host rows.
//
// Usage: node scripts/_migrate-edge-rows.mjs --patch <patch.yml> \
//                                            --preset <preset.yml> [--write]

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WRITE = process.argv.includes('--write')

/**
 * Rows that stay in the top-level insert section instead of moving into the
 * preset. Empty by design (§7.135): every plugin row of this bundle belongs
 * to the 边缘模式. Kept as a hook for the (hypothetical) row that must be
 * global regardless of the work mode.
 */
const KEEP = new Set([])

function argOf(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined
}

const patchPath = join(ROOT, argOf('--patch') ?? 'cordis.desktop-safe.patch.yml')
const presetPath = join(ROOT, argOf('--preset') ?? 'presets/edge.patch.yml')
const patchLines = readFileSync(patchPath, 'utf8').split('\n')

// Locate the top-level `- insert:` section.
const insertIdx = patchLines.findIndex((l) => l === '- insert:')
if (insertIdx < 0) {
  console.error('no top-level `- insert:` section found')
  process.exit(1)
}

// Split the insert section into blocks: a block starts at `    - id: <id>`
// and runs until the next `    - id:` or a line whose indent drops to <= 4.
// Leading comment lines directly above a block belong to that block.
const blocks = []
let current = null
let pendingComments = []
for (let i = insertIdx + 1; i < patchLines.length; i++) {
  const l = patchLines[i]
  const trimmed = l.trim()
  if (trimmed === '') { if (current) current.lines.push(''); continue }
  const indent = l.length - l.trimStart().length
  // The row header itself sits at indent 4 — test it BEFORE the "section
  // ended" check, or every row header breaks the loop.
  if (/^ {4}- id: /.test(l)) {
    const id = l.replace(/^ {4}- id:\s*/, '').trim()
    current = { id, comments: pendingComments, lines: [l] }
    blocks.push(current)
    pendingComments = []
    continue
  }
  // A comment at indent 4 documents the NEXT row (it sits at the same level
  // as the row header) — it must not be mistaken for the end of the section.
  if (trimmed.startsWith('#')) {
    if (current) current.lines.push(l)
    else pendingComments.push(l)
    continue
  }
  if (indent <= 4) break // section ended (next top-level key)
  if (current) current.lines.push(l)
}
if (pendingComments.length > 0 && current) current.lines = [...pendingComments, ...current.lines]

// Every row in the insert section moves unless it is explicitly kept.
const MOVE = new Set(blocks.map((b) => b.id).filter((id) => !KEEP.has(id)))
const moved = blocks.filter((b) => MOVE.has(b.id))
const kept = blocks.filter((b) => KEEP.has(b.id))
if (moved.length === 0) {
  console.error('the insert section is empty — nothing to migrate')
  process.exit(1)
}

// ── 1. rewrite cordis.desktop-safe.patch.yml: keep only the observation rows
const keptIds = new Set(kept.map((b) => b.id))
const newPatch = []
let skipping = false
for (let i = 0; i < patchLines.length; i++) {
  const l = patchLines[i]
  const trimmed = l.trim()
  if (/^ {4}- id: /.test(l)) {
    const id = l.replace(/^ {4}- id:\s*/, '').trim()
    skipping = !keptIds.has(id)
    if (!skipping) newPatch.push(l)
    continue
  }
  if (skipping) {
    if (trimmed === '') continue
    const indent = l.length - l.trimStart().length
    // A comment at indent 4 documents the NEXT row — it belongs to the
    // skipped region too. Only a non-comment line at that depth ends the
    // skipped region (i.e. the next top-level key).
    if (indent <= 4 && !trimmed.startsWith('#')) {
      skipping = false
      newPatch.push(l)
    }
    continue
  }
  newPatch.push(l)
}

// The `- insert:` header itself: if every row moved into the preset, the
// section is empty and must go away — an empty list parses as null and the
// loader has nothing to insert.
const insertHeaderIdx = newPatch.findIndex((l) => l === '- insert:')
if (insertHeaderIdx >= 0) {
  let hasRow = false
  for (let i = insertHeaderIdx + 1; i < newPatch.length; i++) {
    const line = newPatch[i]
    const t = line.trim()
    if (t === '') continue
    if (line.length - line.trimStart().length <= 4) break
    hasRow = true
    break
  }
  if (!hasRow) {
    // Drop the header and any comment lines that belonged to it.
    let end = insertHeaderIdx + 1
    while (end < newPatch.length) {
      const line = newPatch[end]
      const t = line.trim()
      if (t === '' || t.startsWith('#')) { end++; continue }
      break
    }
    newPatch.splice(insertHeaderIdx, end - insertHeaderIdx)
  }
}

// ── 2. append the moved rows to the preset's plugins list (+6 spaces indent)
const INDENT = '      '
const movedText = moved
  .map((b) => b.lines.map((l) => (l === '' ? '' : INDENT + l)).join('\n'))
  .join('\n')

let preset = readFileSync(presetPath, 'utf8')
const presetLines = preset.split('\n')
// Drop trailing blank lines, append the moved rows, keep one trailing newline.
while (presetLines.length > 0 && presetLines[presetLines.length - 1] === '') presetLines.pop()
const banner = [
  '',
  '          # ── 边缘模式：本项目的功能（从 bundle 顶层 insert 段迁入，§7.135）─────',
  '          # 迁移的理由：preset 的 plugins 是该工作方式的**完整**列表；留在顶层',
  '          # insert 段的行对**所有**工作方式生效 —— 那样切回标准模式时 Edge 的',
  '          # 行为依然在跑，「标准模式 + 本项目功能」就成了空话。',
  '          # 观测面（dsh-edge-agent / file-logger / audit-log / edge-context-view）',
  '          # 刻意留在顶层：它们不改行为，主人任何时候都该看得见审计与面板。',
]
presetLines.push(...banner, ...movedText.split('\n'), '')
const newPreset = presetLines.join('\n')

if (!WRITE) {
  console.log('dry run — pass --write to apply')
  console.log(`  moved ${moved.length} rows: ${moved.map((b) => b.id).join(', ')}`)
  console.log(`  kept  ${kept.length} rows: ${kept.map((b) => b.id).join(', ')}`)
  process.exit(0)
}

writeFileSync(patchPath, newPatch.join('\n'), 'utf8')
writeFileSync(presetPath, newPreset, 'utf8')
console.log(`moved ${moved.length} rows into presets/edge.patch.yml`)
console.log(`  moved: ${moved.map((b) => b.id).join(', ')}`)
console.log(`  kept : ${kept.map((b) => b.id).join(', ')}`)
