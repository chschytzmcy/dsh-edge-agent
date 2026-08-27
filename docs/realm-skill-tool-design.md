# Realm-Skill-Tool 隔离设计

> 飞书 Skill + CLI 作为 Cloud Skill，Local LLM 专属 Skill + Tool，双向互不可见

## 一、设计目标

```
┌─────────────────────────────────────────────────────────────────────┐
│                        dsh-edge-agent                               │
│                                                                     │
│  ┌──────────────────────┐          ┌──────────────────────────────┐ │
│  │   LOCAL Realm         │          │   CLOUD Realm                 │ │
│  │                       │          │                               │ │
│  │   Skills:             │          │   Skills:                     │ │
│  │   • sys-monitor       │   ╳╳╳   │   • lark-im                   │ │
│  │   • device-ctrl       │  隔离   │   • lark-calendar             │ │
│  │   • file-organizer    │         │   • lark-doc                  │ │
│  │                       │          │   • lark-sheets               │ │
│  │   Tools:              │          │   • lark-base                 │ │
│  │   • bash (已有)       │   ╳╳╳   │   • lark-drive                │ │
│  │   • read/write/edit   │  隔离   │   • lark-mail                 │ │
│  │   • glob/grep (已有)  │         │   • lark-task                 │ │
│  │   • local_cmd (新增)  │          │   • lark-wiki                 │ │
│  │   • sys_info (新增)   │          │   • lark-vc                   │ │
│  │                       │          │   • lark-contact              │ │
│  │   LLM: Qwen3-4B      │          │   • lark-minutes              │ │
│  │   (8K ctx, 精简)     │          │   • lark-whiteboard           │ │
│  │                       │          │   • lark-event                │ │
│  │                       │          │   • lark-workflow-*           │ │
│  │                       │          │                               │ │
│  │                       │          │   Tools:                      │ │
│  │                       │          │   • lark_api (新增, 封装CLI)  │ │
│  │                       │          │   • web_search (已有)         │ │
│  │                       │          │   • web_fetch (已有)          │ │
│  │                       │          │                               │ │
│  │                       │          │   LLM: DeepSeek-V4            │ │
│  │                       │          │   (128K ctx, 丰富)            │ │
│  └──────────────────────┘          └──────────────────────────────┘ │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │  SANITIZED Realm (中间地带)                                      │ │
│  │  Skills: data-analysis (使用 bash + read，数据脱敏后执行)        │ │
│  │  Tools: bash, read (已有) + sanitizer 前置                      │ │
│  └─────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

**核心约束**：
1. 飞书 Skill + `lark_api` Tool → **仅 CLOUD**，Local LLM 看不到、调不了
2. Local 专属 Skill + Tool → **仅 LOCAL**，Cloud LLM 看不到、调不了
3. 双向隔离通过 DSH 原生 `ctx.skills` scope 层 + `ctx.tools` scope 过滤实现

---

## 二、现有基础设施

### 2.1 DSH Skill 体系（直接复用）

| 组件 | 位置 | 能力 |
|------|------|------|
| `ctx.skills` | `@deepseek-ai/dsh-skill` | Skill 注册表，支持分层（global → scope）、provider 模式 |
| `ctx.skills.register(skill)` | 同上 | 运行时注册 skill（name, description, content, invocation, metadata） |
| `ctx.skills.registerProvider(create)` | 同上 | 注册 skill 提供者（list + get） |
| `dsh-tool-skill` | `@deepseek-ai/dsh-tool-skill` | Model-facing `skill` 工具 + `agent/pre-step` 自动注入 skill catalog |
| `dsh-skill-filesystem` | `@deepseek-ai/dsh-skill-filesystem` | 从 `~/.agents/skills/` 自动发现 SKILL.md，支持热重载 |

### 2.2 DSH Tool 体系（直接复用）

| 组件 | 能力 |
|------|------|
| `ctx.tools.register(tool)` | 注册工具，scope 感知 |
| `defineTool()` | 定义工具：name, description, parameters, execute, output.render |
| `tools/pre-execute` | Waterfall 门控：允许/拒绝/询问 |
| `tools/post-execute` | Waterfall 结果检查 |
| `tools/result` | Emit 观察：工具执行完成通知 |

### 2.3 dsh-edge-agent Realm 体系（已有）

| 组件 | 能力 |
|------|------|
| `edgeTools.filterTools(intent)` | 按 realm 过滤工具列表 |
| `edgeTools.isToolAllowed(name, intent)` | 单工具 realm 检查 |
| `DSH_NATIVE_REALM_MAP` | DSH 原生工具 realm 标记（bash→LOCAL, web_search→CLOUD 等） |
| `intent-router` | 分类 → LOCAL/CLOUD/SANITIZED/REJECT |

### 2.4 飞书 Skill + CLI（已有）

| 资源 | 路径 | 说明 |
|------|------|------|
| Lark CLI | `/home/etsme/.npm-global/bin/lark-cli` | Go 二进制，200+ 命令，11 业务域 |
| 已安装 Skill | `~/.agents/skills/lark-*/SKILL.md` | 19 个 skill，含 YAML frontmatter |
| 源 Skill | `~/cy/go/cli/skills/lark-*/SKILL.md` | 23 个 skill（多出 approval, attendance, okr, slides） |

**Skill 格式**（已有标准）：
```yaml
---
name: lark-im
version: 1.0.0
description: "飞书即时通讯：收发消息和管理群聊..."
metadata:
  requires:
    bins: ["lark-cli"]
  cliHelp: "lark-cli im --help"
---
# 指令内容...
```

---

## 三、整体架构

```
                    ┌─────────────────────────┐
                    │     intent-router        │
                    │  classify(user_input)     │
                    │  → Intent(LOCAL|CLOUD|    │
                    │         SANITIZED|REJECT) │
                    └────────────┬────────────┘
                                 │ intent.category
                                 ▼
┌────────────────────────────────────────────────────────────────────┐
│              realm-skill-bridge (新增核心插件)                       │
│                                                                    │
│  ┌────────────────────┐    ┌────────────────────────────────────┐  │
│  │  Lark Skill        │    │  Local Skill Provider              │  │
│  │  Provider           │    │                                    │  │
│  │                    │    │  从 ~/.agents/skills/sys-monitor/  │  │
│  │  从 ~/.agents/     │    │    device-ctrl/ 等目录读取         │  │
│  │  skills/lark-*/    │    │                                    │  │
│  │  读取 SKILL.md     │    │  或通过 ctx.skills.register()     │  │
│  │                    │    │  硬编码本地 skill                  │  │
│  │  metadata.realm =  │    │                                    │  │
│  │  'CLOUD'           │    │  metadata.realm = 'LOCAL'          │  │
│  └─────────┬──────────┘    └──────────────┬─────────────────────┘  │
│            │                               │                        │
│            ▼                               ▼                        │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  agent/pre-step waterfall: filter skill catalog by realm    │   │
│  │  → LOCAL agent 只看到 sys-monitor, device-ctrl...           │   │
│  │  → CLOUD agent 只看到 lark-im, lark-calendar...            │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                    │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  tools/pre-execute waterfall: realm gate on tool execution  │   │
│  │  → lark_api tool 只能在 CLOUD realm 执行                    │   │
│  │  → local_cmd tool 只能在 LOCAL realm 执行                   │   │
│  └─────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────┘
            │                               │
            ▼                               ▼
┌───────────────────────┐     ┌─────────────────────────────┐
│  LOCAL LLM (Qwen3-4B) │     │  CLOUD LLM (DeepSeek-V4)    │
│                        │     │                              │
│  看到的 skill catalog:  │     │  看到的 skill catalog:       │
│  • sys-monitor         │     │  • lark-im                   │
│  • device-ctrl         │     │  • lark-calendar             │
│  • file-organizer      │     │  • lark-doc                  │
│                        │     │  • lark-sheets               │
│  可用的 tools:          │     │  • ...                       │
│  • bash, read, write,  │     │                              │
│    edit, glob, grep    │     │  可用的 tools:               │
│  • local_cmd (新增)    │     │  • lark_api (新增)           │
│  • sys_info (新增)     │     │  • web_search, web_fetch     │
└───────────────────────┘     └─────────────────────────────┘
```

---

## 四、详细设计

### 4.1 新增插件：`realm-skill-bridge`

**职责**：在 DSH 已有的 skill/tool 体系之上叠加 realm 概念。**不负责发现和加载** — 那由 `dsh-skill-filesystem` 自动完成。只负责：
1. 从配置文件读取 skill/tool 的 realm 归属
2. 在 `agent/pre-step` 中按 realm 过滤 skill catalog
3. 在 `tools/pre-execute` 中拦截跨 realm 的 tool 执行

```typescript
// src/dsh-adapter/realm-skill-bridge.ts

export const name = 'realm-skill-bridge'
export const inject = ['skills', 'edgeTools', 'auditLog'] as const

export interface Config {
  /** Realm 配置文件路径（热重载） */
  realmConfigPath: string
  /** lark-cli 二进制路径 */
  larkCliPath: string
}

export const Config: Schema<Config> = Schema.object({
  realmConfigPath: Schema.string().default('~/.dsh-edge-agent/skill-realms.json'),
  larkCliPath: Schema.string().default('lark-cli'),
})
```

---

### 4.1.1 Realm 配置文件

**位置**：`~/.dsh-edge-agent/skill-realms.json`

**格式**：

```jsonc
{
  // ============================================================
  // Skill Realm 映射
  // key:   skill name 或 glob 模式（* 匹配任意字符）
  // value: "LOCAL" | "CLOUD"
  // 
  // 匹配优先级：精确名称 > glob 模式（按数组顺序）> defaultRealm
  // ============================================================
  "skills": {
    // ── 飞书全家桶 → CLOUD ──
    "lark-*":             "CLOUD",

    // ── 本地设备/系统 → LOCAL ──
    "sys-monitor":        "LOCAL",
    "device-ctrl":        "LOCAL",
    "file-organizer":     "LOCAL",
    "local-*":            "LOCAL",

    // ── 示例：某个 skill 虽然名字像 cloud 但你希望本地用 ──
    // "data-analysis":    "LOCAL",

    // ── 示例：某个第三方 skill 需要联网 ──
    // "web-research":     "CLOUD"
  },

  // ============================================================
  // Tool Realm 映射
  // 仅覆盖 DSH 原生工具的默认 realm。
  // dsh-edge-agent 自带的 LOCAL 工具（bash, read, write, edit, glob, grep）
  // 和 CLOUD 工具（web_search, web_fetch）已在代码中硬编码。
  //
  // 新增工具的 realm 在此声明。
  // ============================================================
  "tools": {
    // ── 新增工具 ──
    "lark_api":           "CLOUD",
    "skill_ref":          "CLOUD",
    "sys_info":           "LOCAL",
    "local_cmd":          "LOCAL"

    // ── 覆盖原生工具（通常不需要） ──
    // "bash":             "CLOUD",   // ⚠️ 危险：让云端执行 bash
  },

  // ============================================================
  // 默认 Realm（未在任何规则中匹配到的 skill/tool 的归属）
  //
  // "hidden" — 不加载给任何 agent（默认，fail-closed 安全策略）
  //            未在 skills 段声明的 skill 完全不可见
  // "LOCAL"  — 默认只给本地 agent 用，需显式声明才能上云
  // "CLOUD"  — 默认只给云端 agent 用，需显式声明才能本地用
  // "all"    — 不限制，所有 realm 的 agent 都能用（⚠️ 不安全）
  // ============================================================
  "defaultRealm": "hidden"
}
```

**匹配规则**：

| 优先级 | 匹配方式 | 示例 |
|--------|---------|------|
| 1 | SKILL.md frontmatter `metadata.realm` | `metadata: { realm: "CLOUD" }` |
| 2 | 配置文件精确名称匹配 | `"sys-monitor": "LOCAL"` |
| 3 | 配置文件 glob 模式（按 JSON 中声明顺序） | `"lark-*": "CLOUD"` |
| 4 | `defaultRealm` | `"hidden"` → 不加载给任何 agent |

**`defaultRealm` 语义**：

| 值 | 行为 | 适用场景 |
|----|------|---------|
| `"hidden"` | 未配置的 skill 对所有 agent **不可见** | **默认**。安全优先，只开放显式声明的 skill |
| `"LOCAL"` | 未配置的 skill 默认给 LOCAL agent | 信任本地，云端需要显式开放 |
| `"CLOUD"` | 未配置的 skill 默认给 CLOUD agent | 信任云端，本地需要显式开放 |
| `"all"` | 未配置的 skill 对所有 agent 可见 | ⚠️ 调试用，生产环境不安全 |

**为什么默认 `"hidden"`**：
- 用户可能安装了大量 skill（如 lark-openapi-explorer、第三方 skill），不希望全部暴露给 LLM
- fail-closed：只开放明确需要的 skill，减少攻击面
- 新增 skill 不会自动生效，必须用户在配置中显式声明

**为什么用 glob 而非前缀**：
- `lark-*` 比 `lark-` 前缀更明确（`*` 是通配符语义）
- 可以写 `*-workflow` 匹配所有工作流 skill
- 未来支持 `!lark-shared` 排除语法（TODO）

---

### 4.1.2 热重载机制

`realm-skill-bridge` 用 chokidar 监控 `skill-realms.json` 的变更，修改后自动生效，无需重启 dsh-edge-agent。

```typescript
// realm-skill-bridge.ts — apply() 中

import { watch } from 'chokidar'

// 加载 realm 配置
function loadRealmConfig(): RealmConfig {
  try {
    const raw = readFileSync(config.realmConfigPath, 'utf-8')
    return JSON.parse(raw)
  } catch (error) {
    ctx.logger.warn(`[realm-skill-bridge] failed to load ${config.realmConfigPath}: ${error}`)
    return { skills: {}, tools: {}, defaultRealm: 'hidden' }
  }
}

let realmConfig = loadRealmConfig()

// 热重载
const watcher = watch(config.realmConfigPath, { ignoreInitial: true })
watcher.on('change', () => {
  ctx.logger.info('[realm-skill-bridge] skill-realms.json changed, reloading...')
  realmConfig = loadRealmConfig()
  // 重新扫描所有 skill，应用新的 realm 映射
  tagSkills()
  // 重新标记 tool realm
  tagTools()
  // 通知下游
  ctx.emit('realm/change', { realmConfig })
})

// 对已发现的 skill 打 realm 标记
function tagSkills(): void {
  skillRealmMap.clear()
  const all = ctx.skills.list()
  let hiddenCount = 0
  for (const skill of all) {
    const realm = resolveSkillRealm(skill.name, skill.metadata, realmConfig)
    if (realm === 'hidden') {
      // 标记为 hidden → 不进入任何 agent 的 catalog
      skillRealmMap.set(skill.name, 'hidden')
      hiddenCount++
    } else if (realm === 'LOCAL' || realm === 'CLOUD' || realm === 'SANITIZED') {
      skillRealmMap.set(skill.name, realm)
    }
    // 如果 resolveSkillRealm 返回了具体 realm（非 hidden），记录
  }
  ctx.logger.info(`[realm-skill-bridge] ${all.length} skills discovered, ` +
    `${skillRealmMap.size - hiddenCount} tagged (${hiddenCount} hidden): ` +
    [...skillRealmMap.entries()]
      .filter(([, r]) => r !== 'hidden')
      .map(([n, r]) => `${n}=${r}`)
      .join(', '))
}

function tagTools(): void {
  for (const [toolName, realm] of Object.entries(realmConfig.tools)) {
    if (realm === 'LOCAL' || realm === 'CLOUD' || realm === 'SANITIZED') {
      ctx.edgeTools.setRealm(toolName, realm)
    }
  }
}

// Realm 解析（按优先级）
// 返回：
//   'LOCAL' | 'CLOUD' — 该 skill 归属该 realm
//   'hidden'          — 该 skill 不加载给任何 agent
function resolveSkillRealm(
  name: string,
  metadata: Record<string, unknown> | undefined,
  config: RealmConfig,
): 'LOCAL' | 'CLOUD' | 'SANITIZED' | 'hidden' {
  // 优先级 1：SKILL.md frontmatter 中显式声明 metadata.realm
  if (metadata?.realm === 'CLOUD' || metadata?.realm === 'LOCAL' || metadata?.realm === 'SANITIZED') {
    return metadata.realm
  }
  // 优先级 2：配置文件精确匹配
  if (config.skills[name]) return config.skills[name]
  // 优先级 3：配置文件 glob 匹配（按声明顺序）
  for (const [pattern, realm] of Object.entries(config.skills)) {
    if (pattern.includes('*') && minimatch(name, pattern)) {
      return realm
    }
  }
  // 优先级 4：defaultRealm
  return config.defaultRealm ?? 'hidden'
}
```

**日志输出**（启动时）：
```
[realm-skill-bridge] 22 skills tagged:
  lark-im=CLOUD, lark-calendar=CLOUD, lark-doc=CLOUD, lark-sheets=CLOUD,
  lark-base=CLOUD, lark-drive=CLOUD, lark-mail=CLOUD, lark-task=CLOUD,
  lark-wiki=CLOUD, lark-contact=CLOUD, lark-vc=CLOUD, lark-minutes=CLOUD,
  lark-whiteboard=CLOUD, lark-event=CLOUD, lark-openapi-explorer=CLOUD,
  lark-skill-maker=CLOUD, lark-workflow-meeting-summary=CLOUD,
  lark-workflow-standup-report=CLOUD, lark-shared=CLOUD,
  sys-monitor=LOCAL, device-ctrl=LOCAL, file-organizer=LOCAL
```

---

### 4.2 飞书 Skill → CLOUD Realm（简化设计）

**核心发现**：`dsh-skill-filesystem` 已经**自动发现** `~/.agents/skills/lark-*/SKILL.md`（rank 500, source: `user-agents`），包括：
- YAML frontmatter 解析（name, description, whenToUse, metadata）
- Markdown body 读取
- chokidar 热重载（文件增删改自动 invalidate）
- `resourceBase` 自动指向 skill 目录（references 子目录自动可用）

**我们不需要写 `LarkSkillProvider`** — 只需：
1. 在 `skill-realms.json` 中声明 `"lark-*": "CLOUD"`（见 §4.1.1）
2. `realm-skill-bridge` 自动读取配置并对已发现的 skill 打标记
3. `agent/pre-step` 中按 realm 过滤 catalog

**lark-shared 依赖处理**：

所有 lark skill 都依赖 `lark-shared/SKILL.md`（认证、身份、安全规则）。
有两种处理方式：

**方案 A：SKILL.md 层面（推荐）** — 在每个 lark skill 的 SKILL.md 开头加一行：
```markdown
> 使用前请先阅读 lark-shared skill 了解认证和安全规则。
```
LLM 看到后会自动先加载 `lark-shared`（因为它在 catalog 中可见）。

**方案 B：agent 层面** — 在 system prompt 中为 CLOUD agent 预置：
```
操作飞书前，请先调用 skill({name: "lark-shared"}) 了解认证和安全规则。
```

**resourceBase 处理**：

`dsh-skill-filesystem` 已自动将 `resourceBase` 指向 skill 目录（如 `~/.agents/skills/lark-base/`），所以 LLM 可以通过 `read` tool 读取 reference 文件。但 `read` 是 LOCAL tool，CLOUD realm 下不可用。

**解法**：给 CLOUD realm 新增一个轻量 `skill_ref` tool（在 `skill-realms.json` 的 tools 段声明 `skill_ref: "CLOUD"`）：

```typescript
const skillRefTool = defineTool({
  name: 'skill_ref',
  description: 'Read a reference file from a loaded skill. '
    + 'Use when a skill instruction says "see references/xxx.md".',
  parameters: {
    skill: { type: 'string', required: true, description: 'Skill name, e.g. "lark-base"' },
    file: { type: 'string', required: true, description: 'Relative path, e.g. "references/table-list.md"' },
  },
  async execute(args) {
    // 安全检查：file 不能包含 ../ 等路径穿越
    const skill = ctx.skills.get(args.skill)
    if (!skill?.resourceBase) return { error: `Skill "${args.skill}" not found or has no resources` }
    const fullPath = path.join(skill.resourceBase.path, args.file)
    if (!fullPath.startsWith(skill.resourceBase.path)) return { error: 'Invalid path' }
    return await readFile(fullPath, 'utf-8')
  },
})
ctx.tools.register(skillRefTool)
// realm 在 skill-realms.json 的 tools 段声明
```

### 4.2.1 DSH Skill 加载的两层分离机制

DSH 的 skill 体系是**目录索引 + 按需加载**：

| 阶段 | API | 返回 | 注入方式 | Token 开销 |
|------|-----|------|---------|-----------|
| **目录索引** | `ctx.skills.list()` | `SkillSummary[]` | `agent/pre-step` 自动注入为 `<available_skills>` | ~30-50 tokens/skill |
| **按需加载** | `ctx.skills.get(name)` | `SkillDefinition`（含完整 content） | LLM 主动调用 `skill({name})` tool | 完整 SKILL.md body（数百~数千 tokens） |

**Catalog 注入（轻量）** — `dsh-tool-skill` 在 `agent/pre-step` 中将所有 skill 的 summary 注入 system prompt：

```xml
<available_skills>
  <skill>
    <name>lark-calendar</name>
    <description>飞书日历：查看/创建/更新日程、管理参与者、忙闲查询、时间建议。</description>
    <whenToUse>当用户询问日程安排、需要创建会议、查看空闲时间时使用。</whenToUse>
    <invocation model="true" user="true" />
  </skill>
  <!-- ... 每个 skill 一个条目 ... -->
</available_skills>
```

**Content 加载（按需）** — LLM 看到 catalog 后，如果判断需要使用某个 skill，会调用 `skill` tool：

```
LLM → skill({name: "lark-calendar"})
     → ctx.skills.get("lark-calendar")
     → 返回完整 SkillDefinition（含 lark-shared 前置规则 + 日历指令）
     → 渲染为 <skill_content><skill_instructions>...</skill_instructions></skill_content>
     → 注入到下一轮 context
```

**Realm 过滤作用于两层**：
1. **Catalog 层**：`agent/pre-step` 注入 `<available_skills>` 时按 realm 过滤 → LOCAL agent 的 catalog 中看不到 `lark-*` skill 条目
2. **Content 层**：即使 LLM 幻觉调用了不存在的 skill name，`ctx.skills.get()` 也找不到 → 返回错误

这意味着 `LarkSkillProvider.list()` 返回的 summary 中 `description` 和 `whenToUse` 要精炼：
- `description`：一句话说明该 skill 能做什么
- `whenToUse`：触发条件，帮助 LLM 判断何时调用

而完整 SKILL.md 指令（含 lark-shared 前置规则 + references 引用）只在 LLM 主动调用 `skill({name})` 时才消耗 context。

### 4.3 lark-cli → CLOUD Tool (`lark_api`)

飞书 skill 的指令是让 LLM 调用 `lark-cli` 命令。但 dsh-edge-agent 的 LLM 不是直接执行 shell 命令的——它通过 **tool** 执行。所以需要把 `lark-cli` 封装为一个 CLOUD-realm 的 DSH tool。

```typescript
// 注册 lark_api tool — 仅 CLOUD realm 可见
const larkApiTool = defineTool({
  name: 'lark_api',
  description: 'Execute Lark/Feishu operations via lark-cli. '
    + 'Supports: im, calendar, docs, base, sheets, drive, mail, '
    + 'task, wiki, contact, vc, minutes, event, whiteboard. '
    + 'Pass the full lark-cli command as arguments.',
  parameters: {
    domain: {
      type: 'string',
      required: true,
      description: 'Business domain: im|calendar|docs|base|sheets|drive|mail|task|wiki|contact|vc|minutes|event|whiteboard',
    },
    command: {
      type: 'string',
      required: true,
      description: 'The lark-cli command to execute, e.g. "+agenda" or "events list --params \'...\'"',
    },
    as_identity: {
      type: 'string',
      required: false,
      description: 'Identity: "user" | "bot" | "auto" (default: auto)',
    },
  },
  async execute(args, exec) {
    const cliPath = config.larkCliPath
    const identityFlag = args.as_identity ? `--as ${args.as_identity}` : ''
    const fullCmd = `${cliPath} ${args.domain} ${args.command} ${identityFlag}`.trim()
    
    // 通过 subprocess 执行 lark-cli
    const result = await execSubprocess(fullCmd, {
      timeoutMs: 30000,
      cwd: exec.agent?.session.header.cwd,
      signal: exec.signal,
    })
    
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    }
  },
  presentCall(args) {
    return {
      card: 'generic',
      title: `Lark: ${args.domain} ${args.command.slice(0, 40)}`,
      kind: 'execute',
    }
  },
})

ctx.tools.register(larkApiTool)
// 标记为 CLOUD realm
ctx.edgeTools.setRealm('lark_api', 'CLOUD')
```

**安全约束**：
- `lark_api` tool 的 realm 为 CLOUD → `edgeTools.isToolAllowed('lark_api', {category:'LOCAL'})` 返回 `false`
- `tools/pre-execute` waterfall 中二次校验 realm（defense-in-depth）
- `lark-cli` 的 OAuth 凭证存储在 OS keychain 中（`lark-cli auth login` 已处理），不进入 dsh-edge-agent 的配置

### 4.4 Local 专属 Skill + Tool

**Local Skills**（仅 LOCAL realm）：

| Skill | 描述 | 依赖 Tool |
|-------|------|----------|
| `sys-monitor` | 系统监控：CPU/内存/磁盘/网络/进程 | `sys_info` (新增) |
| `device-ctrl` | 设备控制：GPIO、串口、LED、传感器 | `local_cmd` (新增) |
| `file-organizer` | 智能文件整理：分类、重命名、归档 | `bash`, `read`, `write`, `edit` (已有) |

**Local 专属 Tools**：

```typescript
// sys_info tool — 仅 LOCAL realm
const sysInfoTool = defineTool({
  name: 'sys_info',
  description: 'Get system information: CPU, memory, disk, network, processes, temperature.',
  parameters: {
    category: {
      type: 'string',
      required: false,
      description: 'cpu|memory|disk|network|process|temperature|all (default: all)',
    },
  },
  async execute(args) {
    // 调用系统命令获取信息（/proc, sysfs, etc.）
    // 不涉及任何网络请求，纯本地
    return collectSystemInfo(args.category ?? 'all')
  },
})
ctx.tools.register(sysInfoTool)
ctx.edgeTools.setRealm('sys_info', 'LOCAL')

// local_cmd tool — 仅 LOCAL realm，受限的命令执行
const localCmdTool = defineTool({
  name: 'local_cmd',
  description: 'Execute a curated set of local system commands for device control. '
    + 'Allowed: gpio, i2c, spi, led, sensor, systemctl (status only), etc.',
  parameters: {
    command: {
      type: 'string',
      required: true,
      description: 'The local command to execute',
    },
  },
  async execute(args, exec) {
    // 白名单检查
    if (!isAllowedLocalCommand(args.command)) {
      throw new Error(`Command not allowed in local_cmd: ${args.command}`)
    }
    return execSubprocess(args.command, { timeoutMs: 10000 })
  },
})
ctx.tools.register(localCmdTool)
ctx.edgeTools.setRealm('local_cmd', 'LOCAL')
```

### 4.5 Realm 隔离机制（三层防御）

```
                    请求到达
                       │
         ┌─────────────▼─────────────────┐
Layer 1    │  Skill Catalog 过滤            │
           │  (agent/pre-step)             │
           │                               │
           │  ctx.skills.list() 返回全部    │
           │  → 过滤 metadata.realm        │
           │  → LOCAL agent 只看 LOCAL skill│
           │  → CLOUD agent 只看 CLOUD skill│
           └─────────────┬─────────────────┘
                         │
         ┌───────────────▼───────────────┐
Layer 2    │  Tool Schema 过滤              │
           │  (edgeTools.filterTools)       │
           │                               │
           │  LLM 只看到该 realm 的        │
           │  tool schema                  │
           │  → LOCAL: bash, read, write,  │
           │    edit, glob, grep,          │
           │    sys_info, local_cmd        │
           │  → CLOUD: lark_api,           │
           │    web_search, web_fetch      │
           └───────────────┬───────────────┘
                           │
         ┌─────────────────▼─────────────┐
Layer 3    │  Tool Execute 门控             │
           │  (tools/pre-execute)          │
           │                               │
           │  即使 LLM 试图调用不属于      │
           │  该 realm 的 tool，在         │
           │  执行前被拦截                  │
           │  → edgeTools.isToolAllowed()  │
           │  → 拒绝 + audit security      │
           └───────────────────────────────┘
```

**Layer 1 实现** — Skill Catalog 过滤：

```typescript
// realm-skill-bridge.ts 中

ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
  const decision = await next()
  if (decision.kind === 'reject') return decision

  // 获取当前 agent 的 realm（从 session metadata 或 agent 配置读取）
  const currentRealm = getAgentRealm(agent)
  if (!currentRealm) return decision

  // 过滤 skill catalog message 中的 available_skills
  return filterSkillCatalogByRealm(decision, currentRealm)
})

function filterSkillCatalogByRealm(decision: AgentStepDecision, agentRealm: ToolRealm): AgentStepDecision {
  // 从 decision 的 system-reminder 中解析 <available_skills> 条目
  // 对每个 skill：
  //   1. 查找 skillRealmMap[skill.name]
  //   2. 如果是 'hidden' 或 undefined → 从 catalog 中移除
  //   3. 如果不等于 agentRealm → 从 catalog 中移除
  //   4. 如果等于 agentRealm → 保留
  
  // 效果：
  //   LOCAL agent 的 catalog 只含 LOCAL skill
  //   CLOUD agent 的 catalog 只含 CLOUD skill
  //   hidden skill 完全不出现在任何 catalog 中
  
  return decision  // (filtered)
}
```

**Layer 2 实现** — Tool Schema 过滤（已有基础设施）：

```typescript
// http-api.ts 中（现有 edgeTools.filterTools 接入）
const visibleTools = ctx.edgeTools.filterTools(intent)
// 传递给 agent 创建时限制 tool schema
```

**Layer 3 实现** — 执行门控：

```typescript
// realm-skill-bridge.ts 中

ctx.on('tools/pre-execute', async (exec, next) => {
  const toolRealm = ctx.edgeTools.realmOf(exec.name)
  const currentRealm = getAgentRealm(exec.agent)
  
  if (toolRealm && currentRealm && toolRealm !== currentRealm) {
    // 安全级审计：tool realm 不匹配
    ctx.auditLog?.log({
      level: 'security',
      kind: 'tool.realm.denied',
      source: 'realm-skill-bridge',
      payload: {
        tool: exec.name,
        toolRealm,
        agentRealm: currentRealm,
      },
    })
    return { kind: 'deny', reason: `Tool "${exec.name}" (${toolRealm}) not allowed in ${currentRealm} realm` }
  }
  
  return next()
})
```

---

## 五、数据流全景

### 5.1 CLOUD 路径（飞书操作）

```
用户: "帮我查看今天的日程"
  │
  ├─ prompt-guard.checkInput() → pass
  ├─ intent-router.classify() → CLOUD (知识/联网类任务)
  ├─ model-router.resolve('CLOUD') → cloud-deepseek-v4
  ├─ sanitizer.sanitize(text) → 脱敏（如有 PII）
  │
  ├─ ctx.agents.create({ model: 'cloud-deepseek-v4', realm: 'CLOUD' })
  │
  ├─ agent/pre-step:
  │   ├─ skill catalog 过滤 → 只展示 lark-* skills
  │   ├─ tool schema 过滤 → 只展示 lark_api, web_search, web_fetch
  │   └─ system prompt: "你是云端知识助手，可操作飞书..."
  │
  ├─ LLM (DeepSeek-V4) 推理:
  │   ├─ 看到 skill catalog 中有 lark-calendar
  │   ├─ 调用 skill({name: "lark-calendar"}) → 加载日历 skill 指令
  │   ├─ 按指令调用 lark_api({domain: "calendar", command: "+agenda"})
  │   └─ lark-cli calendar +agenda → 飞书 API → 日程数据
  │
  ├─ desanitizeSync(response) → 还原 PII
  └─ 返回用户: "你今天有3个日程：..."
```

### 5.2 LOCAL 路径（系统监控）

```
用户: "看看系统负载怎么样"
  │
  ├─ prompt-guard.checkInput() → pass
  ├─ intent-router.classify() → LOCAL (系统管理)
  ├─ model-router.resolve('LOCAL') → local-qwen3-4b
  │
  ├─ ctx.agents.create({ model: 'local-qwen3-4b', realm: 'LOCAL' })
  │
  ├─ agent/pre-step:
  │   ├─ skill catalog 过滤 → 只展示 sys-monitor, device-ctrl
  │   ├─ tool schema 过滤 → 只展示 bash, read, write, sys_info, local_cmd
  │   └─ system prompt: "你是本地设备助手，可监控系统..."
  │
  ├─ LLM (Qwen3-4B) 推理:
  │   ├─ 看到 skill catalog 中有 sys-monitor
  │   ├─ 调用 skill({name: "sys-monitor"}) → 加载监控 skill 指令
  │   ├─ 按指令调用 sys_info({category: "all"})
  │   └─ 返回系统信息
  │
  └─ 返回用户: "CPU 使用率 45%，内存 3.2G/8G..."
```

### 5.3 越权尝试（被拦截）

```
场景 1: 用户通过 LOCAL 路径尝试操作飞书
  用户: "帮我发个飞书消息"
  ├─ intent-router → LOCAL (不含联网关键词)
  ├─ agent 创建为 LOCAL realm
  ├─ LLM 看不到 lark_api tool，看不到 lark-* skill
  └─ 回复: "我是本地助手，无法操作飞书。联网操作请使用云端模式。"

场景 2: 用户通过 CLOUD 路径尝试设备控制
  用户: "帮我查看 CPU 温度"
  ├─ intent-router → CLOUD (知识类问题)
  ├─ agent 创建为 CLOUD realm
  ├─ LLM 看不到 sys_info / local_cmd tool
  └─ 回复: "我是云端助手，无法访问本地设备传感器。"
  
  (更好的情况：intent-router 正确识别为 LOCAL，直接走 LOCAL 路径)

场景 3: LLM 幻觉调用不属于该 realm 的 tool
  ├─ CLOUD agent 的 LLM 幻觉输出 "bash('rm -rf /')"
  ├─ tools/pre-execute: realm 检查 → bash 是 LOCAL，当前是 CLOUD
  ├─ 拒绝执行 + audit security 告警
  └─ 返回 tool 错误: "Tool 'bash' not allowed in CLOUD realm"

场景 4: 未配置的 skill 不可见（fail-closed）
  假设用户安装了第三方 skill ~/.agents/skills/some-random-tool/SKILL.md
  但 skill-realms.json 中没有声明
  ├─ dsh-skill-filesystem 自动发现 → ctx.skills.list() 包含该 skill
  ├─ realm-skill-bridge 扫描 → resolveSkillRealm() 返回 'hidden'（defaultRealm）
  ├─ skillRealmMap 标记 some-random-tool = 'hidden'
  ├─ LOCAL agent 的 <available_skills> → 不包含
  ├─ CLOUD agent 的 <available_skills> → 不包含
  └─ 两个 LLM 都不知道这个 skill 存在 → 不会调用
```

---

## 六、Cordis.yml 配置

```yaml
# ── 新增：Realm-Skill Bridge ──────────────────────────────────────
- id: realm-skill-bridge
  name: '@deepseek-harness-edge-agent/dsh-edge-agent/realm-skill-bridge'
  inject: [skills, edgeTools, auditLog]
  config:
    realmConfigPath: !!js process.env.DSH_EDGE_REALM_CONFIG ?? ((process.env.HOME ?? '') + '/.dsh-edge-agent/skill-realms.json')
    larkCliPath: !!js process.env.DSH_EDGE_LARK_CLI ?? 'lark-cli'

# ── 修改：dsh-skill-filesystem 增加 customSkillDirs 指向 local skill 目录 ──
- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    customSkillDirs:
      - !!js process.env.DSH_EDGE_LOCAL_SKILLS_DIR ?? ((process.env.HOME ?? '') + '/.dsh-edge-agent/skills')
    # ~/.agents/skills/ (含 lark-*) 已由 includeDefaultRoots 自动发现，无需配置
```

> **注意**：realm 归属**不在 cordis.yml 中配置**，而是在独立的 `skill-realms.json` 文件中（§4.1.1）。这样用户编辑 realm 映射不需要碰 cordis.yml，也支持热重载。

---

## 七、文件结构

```
~/.dsh-edge-agent/
├── skill-realms.json          ← 用户配置：skill/tool 的 realm 归属（热重载）
│                                  首次启动时从项目内置模板复制
├── skills/                     ← Local 专属 skill（被 dsh-skill-filesystem 通过 customSkillDirs 发现）
│   ├── sys-monitor/
│   │   └── SKILL.md
│   ├── device-ctrl/
│   │   └── SKILL.md
│   └── file-organizer/
│       └── SKILL.md
└── ...

dsh-edge-agent/
├── src/dsh-adapter/
│   ├── realm-skill-bridge.ts  ← 新增：读 skill-realms.json + catalog 过滤 + tool 门控
│   ├── lark-api-tool.ts       ← 新增：lark_api tool（封装 lark-cli）
│   ├── skill-ref-tool.ts      ← 新增：skill_ref tool（CLOUD realm 读 reference）
│   └── local-tools.ts         ← 新增：sys_info, local_cmd tool
│
├── templates/
│   └── skill-realms.default.json  ← 内置默认模板（首次启动复制到 ~/.dsh-edge-agent/）
│
└── cordis.yml                  ← 修改：新增 realm-skill-bridge 行
```

### 7.1 内置默认模板 `skill-realms.default.json`

项目自带一个开箱即用的模板，`realm-skill-bridge` 首次启动时复制到 `~/.dsh-edge-agent/skill-realms.json`（如果文件不存在）：

```jsonc
// templates/skill-realms.default.json
{
  "skills": {
    // 飞书全家桶 → 仅 CLOUD LLM 可用
    "lark-*": "CLOUD",

    // 本地系统/设备 → 仅 LOCAL LLM 可用
    "sys-monitor": "LOCAL",
    "device-ctrl": "LOCAL",
    "file-organizer": "LOCAL"
  },
  "tools": {
    // dsh-edge-agent 新增的工具
    "lark_api": "CLOUD",
    "skill_ref": "CLOUD",
    "sys_info": "LOCAL",
    "local_cmd": "LOCAL"
  },
  // 默认策略：未配置的 skill/tool 不加载给任何 agent（fail-closed）
  "defaultRealm": "hidden"
}
```

> 用户修改 `~/.dsh-edge-agent/skill-realms.json` 后立即生效，无需重启。
> 模板文件只用于首次引导，不覆盖用户已有配置。
> `defaultRealm: "hidden"` 意味着安装新 skill 后必须手动在配置中声明才会生效。

**不需要**：
- ~~`lark-skill-provider.ts`~~ — `dsh-skill-filesystem` 已自动发现 `~/.agents/skills/lark-*/SKILL.md`
- ~~`local-skill-provider.ts`~~ — `dsh-skill-filesystem` 通过 `customSkillDirs` 自动发现 local skills
- ~~飞书 skill 文件复制/移动~~ — 直接复用，热重载由 chokidar 处理

**Local Skill 示例**（`skills/sys-monitor/SKILL.md`）：

```markdown
---
name: sys-monitor
version: 1.0.0
description: "系统监控：查看 CPU、内存、磁盘、网络、温度等信息。当用户询问设备状态、系统负载、资源使用情况时使用。"
metadata:
  requires:
    bins: []
  realm: LOCAL
---

# sys-monitor

## 核心操作

### 查看系统概览
调用 `sys_info` 工具，category 设为 `all`。

### 查看特定指标
- CPU: `sys_info({category: "cpu"})`
- 内存: `sys_info({category: "memory"})`
- 磁盘: `sys_info({category: "disk"})`
- 温度: `sys_info({category: "temperature"})`

### 注意事项
- 所有数据来自本地 /proc 和 sysfs，不消耗网络
- 温度传感器需要硬件支持（RK3588 内置 thermal zone）
```

---

## 八、完整 Realm-Tool-Matrix

| Tool | Realm | 来源 | LOCAL 可见 | CLOUD 可见 | SANITIZED 可见 |
|------|-------|------|-----------|-----------|---------------|
| `bash` | LOCAL | DSH 原生 | ✅ | ❌ | ❌ |
| `read` | LOCAL | DSH 原生 | ✅ | ❌ | ❌ |
| `write` | LOCAL | DSH 原生 | ✅ | ❌ | ❌ |
| `edit` | LOCAL | DSH 原生 | ✅ | ❌ | ❌ |
| `glob` | LOCAL | DSH 原生 | ✅ | ❌ | ❌ |
| `grep` | LOCAL | DSH 原生 | ✅ | ❌ | ❌ |
| `sys_info` | LOCAL | **新增** | ✅ | ❌ | ❌ |
| `local_cmd` | LOCAL | **新增** | ✅ | ❌ | ❌ |
| `lark_api` | CLOUD | **新增** | ❌ | ✅ | ❌ |
| `web_search` | CLOUD | DSH 原生 | ❌ | ✅ | ❌ |
| `web_fetch` | CLOUD | DSH 原生 | ❌ | ✅ | ❌ |

| Skill | Realm | 来源 | Ref 文件 | 说明 |
|-------|-------|------|---------|------|
| **基础层** | | | | |
| `lark-shared` | CLOUD | 飞书 | 0 | 认证/身份/安全基础（所有 skill 依赖） |
| **即时通讯** | | | | |
| `lark-im` | CLOUD | 飞书 | 12 | 收发消息、群聊、搜索、reactions |
| **日历日程** | | | | |
| `lark-calendar` | CLOUD | 飞书 | 4 | 日程 CRUD、忙闲查询、时间建议 |
| **云文档** | | | | |
| `lark-doc` | CLOUD | 飞书 | 7 | 文档 CRUD、Markdown、媒体、搜索 |
| `lark-sheets` | CLOUD | 飞书 | 7 | 电子表格读写/追加/查找/导出 |
| `lark-base` | CLOUD | 飞书 | 87 | 多维表格（最大 skill）：表/字段/记录/视图/data-query |
| **云空间** | | | | |
| `lark-drive` | CLOUD | 飞书 | 3 | 文件管理、上传下载、评论、权限 |
| `lark-wiki` | CLOUD | 飞书 | 0 | 知识库空间/节点管理、token 解析 |
| **邮件** | | | | |
| `lark-mail` | CLOUD | 飞书 | 11 | 完整邮件生命周期（最安全敏感） |
| **任务** | | | | |
| `lark-task` | CLOUD | 飞书 | 12 | 任务/子任务/分配/提醒 |
| **通讯录** | | | | |
| `lark-contact` | CLOUD | 飞书 | 2 | 组织结构、员工搜索 |
| **视频会议** | | | | |
| `lark-vc` | CLOUD | 飞书 | 2 | 会议搜索、纪要/产出物获取 |
| `lark-minutes` | CLOUD | 飞书 | 0 | 闪记元数据（内容委托 vc +notes） |
| **白板画图** | | | | |
| `lark-whiteboard` | CLOUD | 飞书 | 6+12 | 架构图/流程图/思维导图，Mermaid + DSL JSON |
| **事件订阅** | | | | |
| `lark-event` | CLOUD | 飞书 | 1 | WebSocket 实时事件，NDJSON 输出 |
| **工具** | | | | |
| `lark-openapi-explorer` | CLOUD | 飞书 | 0 | 万能 API 发现后备 |
| `lark-skill-maker` | CLOUD | 飞书 | 0 | 元技能：创建新 skill |
| **工作流** | | | | |
| `lark-workflow-meeting-summary` | CLOUD | 飞书 | 0 | 会议纪要聚合 → 报告 → 文档 |
| `lark-workflow-standup-report` | CLOUD | 飞书 | 0 | 日程 + 任务 → 日报 |
| **Local 专属** | | | | |
| `sys-monitor` | LOCAL | **新增** | — | 系统监控：CPU/内存/磁盘/网络/温度 |
| `device-ctrl` | LOCAL | **新增** | — | 设备控制：GPIO/串口/LED/传感器 |
| `file-organizer` | LOCAL | **新增** | — | 智能文件整理：分类/重命名/归档 |

**飞书 skill 参考文件总计**：19 个 SKILL.md + 157 个 reference 文件 + 12 个 scene 文件 = **188 个文件**

---

## 九、实施路径

| 阶段 | 工作量 | 内容 |
|------|--------|------|
| **P1: lark_api Tool** | 2-3天 | 封装 `lark-cli` 为 DSH tool，标记 CLOUD realm，接入 `tools/pre-execute` 门控。先不做 skill 集成，直接让 CLOUD agent 能用 `lark_api` 工具。 |
| **P2: Lark Skill 注册** | 2-3天 | 实现 `LarkSkillProvider`，扫描 `~/.agents/skills/lark-*/SKILL.md` 注册到 `ctx.skills`，metadata 标记 `realm: 'CLOUD'`。实现 skill catalog 过滤。 |
| **P3: Local Skill + Tool** | 2天 | 创建 `skills/sys-monitor/` 等本地 skill，实现 `sys_info` / `local_cmd` tool，标记 LOCAL realm。 |
| **P4: 三层隔离完整接入** | 1-2天 | `agent/pre-step` catalog 过滤 + `edgeTools.filterTools(intent)` schema 过滤 + `tools/pre-execute` 执行门控。三层防御闭环。 |
| **P5: 用户可扩展** | 后续 | 支持用户通过 `~/.dsh-edge-agent/skills/` 添加自定义 skill（类似 privacy-policy 的 JSON 配置），热加载。 |

---

## 十、关键设计决策

### Q1: 为什么不自己写 `LarkSkillProvider`？

`dsh-skill-filesystem` 已经**完美支持** `~/.agents/skills/` 的自动发现（rank 500, source: `user-agents`），包括：
- YAML frontmatter 解析
- Markdown body 读取
- chokidar 热重载（文件增删改自动 invalidate `ctx.skills`）
- `resourceBase` 自动指向 skill 目录

**所以不需要自己写 provider**。只需在 `realm-skill-bridge` 中：
1. 监听 `skills/change` 事件
2. 对已发现的 `lark-*` skill 打 realm 标记
3. 在 `agent/pre-step` 中按 realm 过滤 catalog

这样 lark skill 的升级、新增、删除完全由 DSH 生态自动处理，我们零维护成本。

### Q2: 飞书 skill 的 `metadata.requires.bins: ["lark-cli"]` 怎么处理？

DSH 原生 skill 框架不检查 `requires.bins`。在我们的 `LarkSkillProvider` 中增加前置检查：
- `list()` 时检查 `lark-cli` 是否在 PATH 中可用
- 不可用时 log warning 并返回空列表（而非报错）
- 这样即使 lark-cli 未安装，也不影响其他 skill

### Q3: lark_api tool 的安全边界？

- **输入注入防护**：lark-cli 本身有输入注入保护（README 提到），我们在 `execute()` 中做额外检查（禁止 `;`、`|`、`$()` 等 shell 元字符）
- **凭证安全**：OAuth 凭证由 lark-cli 存储在 OS keychain 中，dsh-edge-agent 不接触凭证
- **审计**：每次 `lark_api` 调用都通过 `tools/result` 事件记录到 audit-log
- **速率限制**：通过 `td-bus` 的 `cloudRequestsPerMinute` 限制

### Q4: Local LLM 的上下文窗口够不够？

Qwen3-4B 有效上下文 ~8K tokens。需要精简：
- Skill catalog：3 个 local skill × ~30 tokens/描述 ≈ 90 tokens
- Tool schema：8 个 tool × ~50 tokens/schema ≈ 400 tokens
- System prompt：~200 tokens
- **总计约 ~700 tokens 的 overhead**，留 ~7300 tokens 给对话和推理，够用

Cloud LLM (DeepSeek-V4) 128K 上下文，即使加载所有 lark skill 的完整指令也绑绑有余。

---

## 附录 A：飞书 CLI 工具清单

**lark-cli** (`@larksuite/cli@1.0.0`)：Go 二进制，200+ 命令，16 个业务域

| 命令 | 业务域 | 主要能力 |
|------|--------|---------|
| `im` | 即时通讯 | 收发消息、管理群聊、搜索消息、下载资源、管理 reactions |
| `calendar` | 日历/日程 | 查看/创建/更新日程、管理参与者、忙闲查询、时间建议 |
| `docs` | 云文档 | 文档 CRUD、Markdown 互转、插入媒体、搜索云空间、白板更新 |
| `base` | 多维表格 | 表格/字段/记录/视图/表单/仪表盘/工作流/角色 CRUD、data-query DSL |
| `sheets` | 电子表格 | 创建/读写/追加/查找/导出，过滤器管理 |
| `drive` | 云空间 | 文件/文件夹管理、上传下载、文档评论、权限、订阅 |
| `mail` | 邮件 | 完整邮件生命周期：撰写、发送、回复、转发、阅读、搜索、草稿/文件夹/标签 |
| `task` | 任务 | 创建/管理任务和任务列表，子任务、分配、关注、提醒 |
| `wiki` | 知识库 | 管理 wiki 空间和节点，`spaces.get_node` 用于 token 解析 |
| `contact` | 通讯录 | 查询组织结构、搜索员工、获取用户详情 |
| `vc` | 视频会议 | 搜索已完成会议、获取会议纪要/产出物（摘要、待办、章节、转录） |
| `minutes` | 闪记 | 获取闪记基本信息（标题、封面、时长），实际内容委托 `vc +notes` |
| `event` | 事件订阅 | WebSocket 实时事件监听，NDJSON 输出到 stdout |
| `whiteboard` | 白板/画图 | 画架构图、流程图、思维导图等，双渲染路径（Mermaid + DSL JSON） |

**关键 flags**：
- `--as user|bot` — 身份切换（user_access_token vs tenant_access_token）
- `--format json|ndjson|table|csv|pretty` — 输出格式
- `--params` — URL/查询参数 JSON
- `--data` — 请求体 JSON
- `--page-all` — 自动翻页
- `--dry-run` — 预览不执行

**命令层级**：
```
lark-cli <service> +<shortcut>        ← 高级快捷命令（agent 友好）
lark-cli <service> <resource> <method> ← 注册 API 直接调用
lark-cli api <METHOD> <path>          ← 裸 API 调用（万能后备）
lark-cli schema <service.resource.method> ← 查看 API 参数定义
```

---

## 附录 B：19 个飞书 Skill 详细清单

所有 skill 位于 `~/.agents/skills/lark-*/SKILL.md`，每个包含 YAML frontmatter + Markdown 指令 + references 目录。

### 基础层

| Skill | 版本 | 描述 | Ref 文件 | 场景文件 |
|-------|------|------|---------|---------|
| **lark-shared** | 1.0.0 | 所有 lark skill 的共享基础规则：认证、身份类型、安全规则 | 0 | 0 |

> 所有其他 lark skill 都依赖 `lark-shared` 提供的 auth/identity 管理

### 业务层

| Skill | 版本 | 描述 | Ref 文件 | 场景文件 |
|-------|------|------|---------|---------|
| **lark-im** | 1.0.0 | IM：收发消息、管理群聊、搜索、下载资源、reactions | 12 | 0 |
| **lark-calendar** | 1.0.0 | 日历/日程：查看/创建/更新事件、管理参与者、忙闲查询、时间建议 | 4 | 0 |
| **lark-doc** | 1.0.0 | 云文档：CRUD、Markdown 互转、插入媒体、搜索、白板更新 | 7 | 0 |
| **lark-base** | 1.2.0 | 多维表格 ★最大：表格/字段/记录/视图/表单/仪表盘/工作流/角色/data-query | 87 | 0 |
| **lark-sheets** | 1.1.0 | 电子表格：创建/读写/追加/查找/导出，过滤器管理 | 7 | 0 |
| **lark-drive** | 1.0.0 | 云空间：文件管理、上传下载、文档评论、权限、订阅 | 3 | 0 |
| **lark-mail** | 1.0.0 | 邮件 ★最安全敏感：完整生命周期，邮件内容视为不可信输入 | 11 | 0 |
| **lark-task** | 1.0.0 | 任务管理：创建/管理任务和列表，子任务、分配、关注、提醒 | 12 | 0 |
| **lark-wiki** | 1.0.0 | 知识库：管理空间和节点，`spaces.get_node` 用于 token 解析 | 0 | 0 |
| **lark-contact** | 1.0.0 | 通讯录：查询组织结构、搜索员工、获取用户详情 | 2 | 0 |
| **lark-vc** | 1.0.0 | 视频会议：搜索已完成会议、获取会议纪要/产出物 | 2 | 0 |
| **lark-minutes** | 1.0.0 | 闪记元数据：基本信息，实际内容委托 `vc +notes` | 0 | 0 |
| **lark-event** | 1.0.0 | 事件订阅：WebSocket 实时监听，NDJSON 输出，正则路由 | 1 | 0 |
| **lark-whiteboard** | 1.0.0 | 白板画图 ★：架构图/流程图/思维导图等，Mermaid + DSL JSON 双路径 | 6 | **12** |

### 工具层

| Skill | 版本 | 描述 | Ref 文件 | 场景文件 |
|-------|------|------|---------|---------|
| **lark-openapi-explorer** | 1.0.0 | 当已有 skill 无法覆盖时，系统性发现并调用裸飞书 OpenAPI | 0 | 0 |
| **lark-skill-maker** | 1.0.0 | 元技能：创建新的 lark-cli skill 的模板和指导 | 0 | 0 |

### 工作流层（多步骤编排）

| Skill | 版本 | 描述 | 依赖 Skill |
|-------|------|------|-----------|
| **lark-workflow-meeting-summary** | 1.0.0 | 聚合会议纪要 → 生成结构化报告 → 可选创建飞书文档 | lark-vc, lark-doc |
| **lark-workflow-standup-report** | 1.0.0 | 日历日程 + 未完成任务 → AI 综合日报，冲突检测、空闲识别 | lark-calendar, lark-task |

### 参考文件汇总

| 类别 | 数量 |
|------|------|
| SKILL.md 主文件 | 19 |
| Reference 文档 | 157 |
| Scene 场景文件（白板） | 12 |
| **总计** | **188** |

---

## 附录 C：飞书 Skill 依赖关系

```
                    lark-shared (认证/身份/安全基础)
                         │
          ┌──────────────┼──────────────────────────┐
          │              │                          │
          ▼              ▼                          ▼
    ┌─────────┐    ┌──────────┐              ┌────────────┐
    │ 单域 skill │    │ 跨域 skill │              │ 工作流 skill │
    │         │    │          │              │            │
    │ lark-im │    │ lark-doc │              │ workflow-  │
    │ lark-cal│    │ lark-vc  │              │ meeting-   │
    │ lark-task│   │ lark-base│              │ summary    │
    │ lark-mail│   │ lark-sheets│            │            │
    │ lark-drive│  │ lark-wiki│              │ workflow-  │
    │ ...     │    │ ...      │              │ standup    │
    └─────────┘    └──────────┘              └────────────┘
```

**关键依赖**：
- 所有 skill → `lark-shared`（auth, identity, safety rules）
- `lark-wiki` 被其他 skill 引用（`spaces.get_node` 用于解析 wiki token）
- `lark-openapi-explorer` 作为万能后备，覆盖未注册 skill 的 API
- `lark-skill-maker` 作为元技能，指导创建新 skill

---

## 附录 D：Skill Catalog 注入策略与上下文预算

### D.1 两层分离：Catalog vs Content

DSH 的 skill 加载是**目录索引 + 按需加载**：

```
                    agent/pre-step 自动注入               LLM 主动调用 skill tool
                    ──────────────────────               ─────────────────────────
SkillSummary        SkillDefinition
(name + desc +      (含完整 markdown content +
 whenToUse)          lark-shared 前置规则)
~30-50 tokens/      数百~数千 tokens/
skill               skill (按需，非每轮)

[CATALOG — 每轮可见]                [CONTENT — 按需加载]
```

### D.2 Cloud LLM 上下文预算（DeepSeek-V4, 128K tokens）

**每轮固定开销**（system prompt + catalog + tool schemas）：

| 内容 | Token 估算 | 说明 |
|------|-----------|------|
| System prompt | ~500 | 角色 + 安全约束 + realm 信息 |
| Tool schemas (3 tools) | ~200 | lark_api + web_search + web_fetch |
| Skill catalog (19 skills) | ~950 | 每个 skill summary ~50 tokens（name + description + whenToUse） |
| **每轮固定合计** | **~1,650** | 占比 ~1.3% |

**按需加载**（LLM 调用 skill tool 时）：

| 内容 | Token 估算 |
|------|-----------|
| 单个 lark skill content | ~500-3000 tokens |
| lark-shared 前置注入 | ~300 tokens |
| lark-base（最大） | ~8000 tokens（含 87 个 reference 的索引） |

剩余 ~126,000 tokens 给对话历史 + 工具调用结果，绑绑有余。

### D.3 Local LLM 上下文预算（Qwen3-4B, 8K tokens）

**每轮固定开销**：

| 内容 | Token 估算 | 说明 |
|------|-----------|------|
| System prompt | ~200 | 角色 + 安全约束 |
| Tool schemas (8 tools) | ~400 | bash, read, write, edit, glob, grep, sys_info, local_cmd |
| Skill catalog (3 skills) | ~90 | 每个 ~30 tokens（精简 summary） |
| **每轮固定合计** | **~690** | 占比 ~8.5% |

**按需加载**（Local skill 内容通常很精简）：

| 内容 | Token 估算 |
|------|-----------|
| sys-monitor content | ~300 tokens |
| device-ctrl content | ~400 tokens |
| file-organizer content | ~500 tokens |

剩余 ~7,000 tokens 给对话 + 工具结果。用 compaction 压缩历史到最近 8-10 轮即可。

### D.4 关键结论

- **Catalog 层开销很小**：19 个飞书 skill 的 summary 总共才 ~950 tokens，远不到 128K 的 1%
- **Content 按需加载**：只在 LLM 判断需要时才加载完整指令，不会无谓消耗 context
- **Realm 过滤在 catalog 层**：LOCAL agent 的 `<available_skills>` 里完全没有 lark-* 条目 → LLM 根本不知道这些 skill 存在
- **双向隔离生效**：即使 CLOUD agent 幻觉尝试调用 `skill({name:"sys-monitor"})`，CLOUD skill provider 中没有这个 name → 返回 skill not found
