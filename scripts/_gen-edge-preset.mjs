// scripts/_gen-edge-preset.mjs — one-shot generator for presets/edge.patch.yml
//
// §7.135 (2026-10-28): the host's Agent Preset mechanism lets a bundle
// declare its own "work mode". The host ships four presets (standard /
// creator / ptc / minimal) as patch files under
// `@deepseek-ai/dsh-web-app/presets/*.patch.yml`, and the bundle manifest
// points at them:
//
//   "dsh": { "bundle": { "patch": [
//     "./cordis.patch.yml",
//     "./presets/standard.patch.yml",
//     "./presets/ptc.patch.yml",
//     "./presets/minimal.patch.yml",
//     "./presets/cordis.patch.yml" ] } }
//
// The Edge preset = the standard preset's plugin list + this bundle's
// behavioural rows. The standard rows are COPIED verbatim (the registry
// does not merge: "用户覆盖替换完整子插件列表，不自动合并内置列表的未来
// 更新"), so this generator extracts them from the host's own file rather
// than hand-copying 23 rows.
//
// Usage: node scripts/_gen-edge-preset.mjs <host-standard.patch.yml> [outPath]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const srcPath = process.argv[2]
if (!srcPath) {
  console.error('usage: node scripts/_gen-edge-preset.mjs <host-standard.patch.yml>')
  process.exit(1)
}

const src = readFileSync(srcPath, 'utf8')
const lines = src.split('\n')

// The host file's shape:
//   - insert:
//       - id: preset-standard
//         name: '@deepseek-ai/dsh-agent-preset'
//         config:
//           id: standard
//           order: 1
//           plugins:
//             - id: persona
//               ...
// Find the `plugins:` key, then take every deeper-indented row after it.
const pluginsIdx = lines.findIndex((l) => /^ {8}plugins:\s*$/.test(l))
if (pluginsIdx < 0) {
  console.error('could not find the `plugins:` key in the host standard patch')
  process.exit(1)
}
const pluginIndent = 10 // `          - id: ...`
const stdRows = []
for (let i = pluginsIdx + 1; i < lines.length; i++) {
  const l = lines[i]
  if (l.trim() === '') { stdRows.push(''); continue }
  const indent = l.length - l.trimStart().length
  if (indent < pluginIndent) break
  stdRows.push(l)
}
// Trailing blank lines are noise.
while (stdRows.length > 0 && stdRows[stdRows.length - 1] === '') stdRows.pop()

const countRows = stdRows.filter((l) => /^ {10}- id: /.test(l)).length
console.log(`extracted ${countRows} standard plugin rows`)

// ── §7.175（2026-11-11）：preset 里**没有** agent-default-model 行 ─────────
//
// 这一段曾经定义了一行 `agent-default-model`（provider=local-llm），本意是
// 「preset scope 自带一份，遮蔽 host scope 的全局默认（deepseek-official）」。
// **实测证伪**，那一行已被移除：
//
//   WARN [agent-preset-registry] agent preset edge:
//     agent-default-model (@deepseek-ai/dsh-agent-default-model):
//     service "agentDefaultModel" has been registered at <AgentDefaultModelConfig>
//
// 根因：宿主 dsh-base/cordis.patch.yml L90-94 已经在 **host scope** 声明了同一
// 个插件；该插件用 `super(ownerContext, "agentDefaultModel")` 注册 cordis service，
// 而 service 名**跨 scope 唯一** ⇒ preset scope 再声明一次 ⇒ 撞名 ⇒
// **整个 edge preset 挂载失败**。
//
// 真正的读取方在 host scope：`dsh-api-session-controller` 的 `agentOptions()` 读
// `this.ctx.agentDefaultModel` —— preset scope 里那份即使不撞名也**没有读者**。
//
// §7.176（2026-11-11）：本地模型默认值改由 **preset 内的 input-guard** 给出 ——
// 它监听 `agent/created`，用宿主的合规入口 `agent.model.select()` 把会话级
// modelSelection 钉成 local-llm。为什么不能靠这一行：
//   1. 宿主 0.2.2-rc.1 起路由只由**会话级** modelSelection 决定；
//   2. GUI 建的 agent 默认取 host scope 的 agentDefaultModel（宿主自带云端模型）；
//   3. local-llm 在模型目录里隐身（§7.106 Option A）⇒ GUI 里选不到，用户没法纠正。
//
// 主人裁决（2026-11-11）：**npm 包里不会带本地模型配置**（config/edge.json 被
// `files` 白名单排除）⇒ local-llm 在未配端点时走 DELEGATE（§7.171）转发宿主
// provider ⇒ 装上就能用（先用 dsh 自带的云端模型），provider 身份仍是 local-llm
// ⇒ §7.175 的 fail-closed 闸门照样放行。
//
// 实测记录见 docs/PROGRESS.md §7.175 / §7.176。
const EDGE_DEFAULT_MODEL_ROWS = '' // 保留名字：提醒后来者这里曾经放过一行、为什么不能放


const header = `# ── 边缘模式 preset（§7.135）──────────────────────────────────────────
#
# 宿主 DSH 的「Agent Preset」机制：preset 是一份 cordis insert patch，声明
# 一行 \`@deepseek-ai/dsh-agent-preset\`，其 \`config.plugins\` 是该工作方式
# 的**完整**插件行列表。宿主内置四种工作方式，都由 bundle 的 patch 文件
# 声明（@deepseek-ai/dsh-web-app/presets/*.patch.yml）：
#
#   standard —— 标准模式：persona / 工具 / plan-mode / compaction /
#               delegation / subagent …
#   ptc / minimal / cordis —— 另外三种
#
# 本文件声明**边缘模式**：标准模式的插件列表 **+ 本项目的全部功能**（隐私
# 护栏、意图判定、路由决策、PII 脱敏、两个 LLM adapter、Realm 闸门、威胁总线、
# 审计链、Edge 面板）。主人裁决（2026-10-28）：
#
#   「我需要在 dsh 桌面上出一新的 agent 工作时间，叫做边缘模式，功能是在
#     标准模式之上增加本项目的功能」
#   「只有选择 边缘模式 才会出现 edge tab」
#
# 所以本 bundle 的 **18 行插件全部在这里** —— 连 Edge 面板（edge-context-view）
# 与它的 webview client 注册（裸包名行）一起。切回标准模式 ⇒ 本 bundle 的
# 插件一行都不挂载 ⇒ 标准模式是**纯 DSH**，连 Edge tab 都没有。
#
# ## 为什么标准模式的行是抄来的
#
# 注册表**不合并**：preset 的 plugins 是完整列表，覆盖式（宿主原文：「用户覆盖
# 替换完整子插件列表，不自动合并内置列表的未来更新」）。所以边缘模式要
# 「在标准模式之上增加」，就必须把标准模式的行**整份抄进来**。
#
# 代价要说清楚：**宿主升级后标准模式的插件列表若变了，边缘模式不会自动跟随**
# —— 需要人把宿主的
#   @deepseek-ai/dsh-web-app/presets/standard.patch.yml
# 重新对齐到本文件。生成器 scripts/_gen-edge-preset.mjs 就是干这件事的。
#
# ## 主机 row 的覆盖留在顶层
#
# 本 bundle 顶层对宿主行的覆盖（tool-web / web / web-search-deepseek）是
# **patch 层**语义 —— preset 只能声明插件行，不能覆盖宿主行。所以这些覆盖
# 在任何工作方式下都生效。这是 preset 机制的边界，如实记录在此。
`

const out = `${header}
- insert:
    - id: preset-edge
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: edge
        name: 边缘模式
        description: 标准模式 + 本项目的端侧隐私能力（意图判定 / 路由决策 / PII 脱敏 / Realm 闸门）
        order: 2
        plugins:
${stdRows.join('\n')}
`

mkdirSync(join(ROOT, 'presets'), { recursive: true })
const outPath = process.argv[3]
  ? join(ROOT, process.argv[3])
  : join(ROOT, 'presets', 'edge.patch.yml')
writeFileSync(outPath, out, 'utf8')
console.log(`wrote ${outPath} (${out.length} bytes, ${stdRows.length} rows)`)
