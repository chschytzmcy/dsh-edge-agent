# dsh-edge-agent 架构设计（合并文档）

> 版本：v0.1.0 · 最后更新：2026-08-31
>
> **本文档由 10 份原文档合并**：`02-architecture/` 6 篇（总览 + 插件 + 双入口 + 适配契约 + 工具复用 + 变更）+ `03-privacy-and-security/#第7章--stride-威胁模型与缓解措施` + `04-plugin-development/#第8章--插件开发指南规范--示例` + `07-design-baseline/` 2 篇（设计基线）。
>
> **文档结构**：第 1 章为架构总览，后续章节为各专题深入，最后两章为设计基线完整保留。

## 目录

- [第1章 · 总览：四层模型 + Realm + Cordis 插件机制](#第1章--总览：四层模型--Realm--Cordis-插件机制)
- [第2章 · 22+1 插件职责、依赖关系、启动顺序](#第2章--191-插件职责、依赖关系、启动顺序)
- [第3章 · CLI vs HTTP 双入口设计](#第3章--CLI-vs-HTTP-双入口设计)
- [第4章 · DSH 上游适配契约（升级时阅读）](#第4章--DSH-上游适配契约升级时阅读)
- [第5章 · DSH 原生工具复用决策（为何不自己实现）](#第5章--DSH-原生工具复用决策为何不自己实现)
- [第6章 · 工具复用变更记录](#第6章--工具复用变更记录)
- [第7章 · STRIDE 威胁模型与缓解措施](#第7章--STRIDE-威胁模型与缓解措施)
- [第8章 · 插件开发指南（规范 + 示例）](#第8章--插件开发指南规范--示例)
- [第9章 · 设计基线：完整设计方案（235 KB 主基线）](#第9章--设计基线：完整设计方案235-KB-主基线)
- [第10章 · 设计基线：Realm × Skill × Tool 模型](#第10章--设计基线：Realm-×-Skill-×-Tool-模型)

---



# 第1章 总览：四层模型 + Realm + Cordis 插件机制

> 来源：`02-architecture/architecture.md`

# dsh-edge-agent 架构设计

> 版本：v0.1.0 · 最后更新：2026-08-18

## 🎯 设计目标

`dsh-edge-agent` 的核心目标是在**用户设备**上运行一个**隐私优先**的 AI 智能体，同时保持与云端 LLM 的协作能力。具体目标包括：

1. **数据最小化**：敏感数据不离开设备
2. **零信任通信**：云端无法将请求与用户关联
3. **可验证安全**：通过 TEE 提供远程证明
4. **可扩展架构**：通过 Cordis 插件机制支持自定义能力

## 🏛️ 总体架构

dsh-edge-agent 的架构分为**四层**：

```
┌─────────────────────────────────────────────────────────┐
│ Layer 4: 用户交互层                                      │
│   - CLI / HTTP API / Voice                              │
├─────────────────────────────────────────────────────────┤
│ Layer 3: 智能体层（DSH Agent Loop）                       │
│   - agents, llm, tools, sessions                        │
├─────────────────────────────────────────────────────────┤
│ Layer 2: 隐私控制层（dsh-edge-agent 核心）                │
│   - intent-router, prompt-guard, sanitizer-pipeline     │
│   - privacy-policy, audit-log, td-bus                  │
├─────────────────────────────────────────────────────────┤
│ Layer 1: 安全基座层                                       │
│   - tcm, local-storage, attestation                     │
│   - ohttp-gateway, secure-bridge                        │
└─────────────────────────────────────────────────────────┘
```

每一层都向下调用，不允许反向依赖。

## 🔌 插件树

dsh-edge-agent 由 **22 个核心插件 + 1 个可选 http-api** 组成（原 §头部曾称"19+1"已过时）。所有插件都遵循 Cordis 的 `name` + `inject` + `Config` + `apply` 模式。具体 `inject` 依赖见 [第 2 章 §0](#0-插件分类dsh-原生-vs-dsh-edge-agent) 表（基于 `grep "export const inject" src/dsh-adapter/*.ts` 实测）。

### 依赖关系图

```
                  tcm (可信计算)
                    │
        ┌───────────┼───────────┐
        │           │           │
   local-storage  attestation  audit-log
        │           │           │
        └─────┬─────┘           │
              │                 │
         sessions          privacy-policy
              │                 │
              └────────┬────────┘
                       │
                  tools (Realm-aware)
                       │
        ┌──────────────┼──────────────┐
        │              │              │
  DSH tools       voice-input    plugin-host
  (bash/fs/web)        │              │
        │              │              │
        └──────────────┘              │
                                      │
   prompt-guard ◄─── intent-router ◄─┘
        │              │
        │              ├──── model-router
        │              │
        │       sanitizer-pipeline
        │
   td-bus ◄─── secure-bridge ◄── ohttp-gateway
                                     │
                              cloud-llm-adapter

   plugin-host (interop anchor, 第三方插件挂载点)

   http-api (可选，外部消费者接口)
```

> **工具复用**: dsh-edge-agent 使用 DSH 原生工具（`@deepseek-ai/dsh-tool-bash`、`dsh-tool-fs`、`dsh-tool-web`），而非自行实现。详见 [#第5章--dsh-原生工具复用决策为何不自己实现](#第5章--dsh-原生工具复用决策为何不自己实现)。

### 插件清单

dsh-edge-agent 由 **22 个核心插件 + 1 个可选 http-api** 组成（原 §"19+1"已过时）。所有插件都遵循 Cordis 的 `name` + `inject` + `Config` + `apply` 模式。具体 `inject` 依赖见 [第 2 章 §0](#0-插件分类dsh-原生-vs-dsh-edge-agent) 表（基于 `grep "export const inject" src/dsh-adapter/*.ts` 实测）。

| 插件 | 职责 | Realm |
|---|---|---|
| `tcm` | 可信计算模块（**当前 stub**，A3 后实装真实 TEE 后端） | — |
| `local-storage` | 会话 / 审计 JSONL 持久化（deployed 为 plain，PII 脱敏未加密） | LOCAL |
| `sessions` | 加密会话管理 | LOCAL |
| `audit-log` | 防篡改审计日志 | LOCAL |
| `privacy-policy` | 隐私策略引擎（v1.5.0，可热更新） | — |
| `tools` | Realm-aware 工具注册中心（复用 DSH 原生工具） | — |
| `prompt-guard` | 输入安全扫描（16 注入规则 + Qwen3-4B 模型辅助） | — |
| `intent-router` | 意图分类与路由（v2：被 input-guard 编排） | — |
| `input-guard` | **v2 编排器**（2026-08-29 引入）：3 个全局 hook 统一三入口隐私管线 | — |
| `realm-skill-bridge` | Realm-aware skill catalog filter（2026-08-27 引入） | — |
| `model-router` | LLM 路由（local / cloud） | — |
| `local-llm-adapter` | 本地 LLM 适配器（Qwen3-4B） | LOCAL |
| `cloud-llm-adapter` | 云端 LLM 适配器（DeepSeek） | CLOUD |
| `sanitizer-pipeline` | PII 脱敏管线（9 条规则） | SANITIZED |
| `web-search-guard` | web_search / web_fetch 结果 PII 反脱敏 + realm 校验 | — |
| `ohttp-gateway` | OHTTP（RFC 9458）网关（**A3 后实装**） | — |
| `secure-bridge` | 端云安全桥 | — |
| `attestation` | TEE 远程证明 | — |
| `td-bus` | 威胁检测总线 | — |
| `voice-input` | 语音输入（v0.5.0+） | LOCAL |
| `plugin-host` | 第三方插件互操作锚点 | — |
| `http-api` | HTTP API（可选，:21017） | — |

> **工具复用**: dsh-edge-agent 不再自行实现工具插件，而是复用 DSH 原生工具（仅 `@deepseek-ai/dsh-tool-web` 在 `package.json` `peerDependencies` 中声明；`dsh-tool-bash` / `dsh-tool-fs` 经 `@deepseek-ai/dsh-tools` peer 链 transitive 引入），通过 `tools` 插件配置 Realm 标记。详见 [#第5章--dsh-原生工具复用决策为何不自己实现](#第5章--dsh-原生工具复用决策为何不自己实现)。

## 🌍 Realm 模型

dsh-edge-agent 引入了 **Realm（域）模型**，将所有数据处理划分为三个域：

| Realm | 数据流向 | 典型用例 | 安全等级 |
|---|---|---|---|
| **LOCAL** | 完全在本地处理 | 文件读取、数学计算、本地 LLM 推理 | 最高 |
| **SANITIZED** | 脱敏后发送至云端 | 一般性问答（自动替换 PII） | 中 |
| **CLOUD** | 原始数据发送至云端 | 用户明确授权的云端任务 | 最低（需用户授权） |

每个工具在注册时必须声明所属 realm，意图路由器根据用户输入和数据敏感度自动选择 realm。

## 🔐 安全控制流

一次典型的用户请求经历以下安全控制流：

```
用户输入
  ↓
[1] prompt-guard.checkInput()    # 检测 prompt injection
  ↓
[2] intent-router.classify()     # 分类意图 + realm
  ↓
[3] privacy-policy.check()       # 验证是否符合策略
  ↓
[4] sanitizer-pipeline.sanitize() # 脱敏（如需）
  ↓
[5] tools.invoke() OR llm.invoke() # 执行
  ↓
[6] audit-log.log()              # 记录审计
  ↓
[7] td-bus.analyze()             # 威胁检测
  ↓
返回结果
```

每一步都可能**拒绝请求**或**升级到更高的安全等级**。

## 📦 Adapter 边界

dsh-edge-agent 严格隔离上游 DSH API：

```
src/
  dsh-adapter/    ← 唯一允许 import @deepseek-ai/* 的目录
  *.ts            ← 仅通过 dsh-adapter/types.ts 拿到类型
```

通过 `verify-adapter-boundary.ts` 脚本在 CI 中强制检查。

## 📦 最小部署清单：bundle 在任意 profile 跑起来需要什么

> 依据：§7.55/§7.56/§7.59 部署验证（清单各项均实机核过）；同步语义 = nested 包每次 install 与 repo diff-then-copy（§7.57）。逐轮验证记录与 boot 签名存档 `docs/PROGRESS.md` §7.55-§7.59，本文不携过程。

dsh-edge-agent 是 profile-agnostic 的 Cordis bundle：它"能不能装上"与目标 profile 无关（web / dsh-tui / 自定义同构），最小集只由以下 **4 项**决定。

### 最小必需集（挂载 + 全部插件生效）

| # | 文件 | 位置 | 作用 |
|---|---|---|---|
| 1 | `package.json` | `~/.dsh/profiles/<p>/node_modules/@deepseek-harness-edge-agent/dsh-edge-agent/` | bundle 身份卡：`name`/`version`；**`exports` 29 个 subpath 映射**（patch 里每个插件 `name: '…/file-logger'` 靠它解析到实现文件）；**`dsh.bundle.patch` 指针**（告诉 DSH 去哪读装配清单） |
| 2 | `cordis.patch.yml` | 同上 | 装配说明书：10 个 config 覆盖 + 30 个 disable + 17 个插件 insert。⚠️ §7.59 实测修正：指针在而文件缺是 **boot 硬失败**（`failed to read overlay …ENOENT`），不是"静默一个都不 mount"；"死 JS 躺 node_modules"只有 ④ 未注册时成立 |
| 3 | `lib/**/*.js` | 同上 | 插件实现本体（tsc 产物）。⚠️ 目录名误导：tsconfig `outDir: "lib/types"`，运行时 `.js` 实际就在 `lib/types/dsh-adapter/*.js`；每模块三份产物，Node 只读 `.js`（`.d.ts` 服务 `types` 条件、`.map` 仅调试定位） |
| 4 | profile 注册 | `~/.dsh/profiles/<p>/package.json` → `dsh.profile.bundles` 数组追加包名 | 唯一入口开关：不列入 bundles，DSH 启动时不加载本包 |

### 功能完整（web 场景近似必需）

| 5 | agent preset | `~/.dsh/.agent-presets/dsh-edge-agent/{preset.yml, agent.cordis.yml}` | web 宿主的默认 preset 指向 `dsh-edge-agent`（见第 2 节 preset 说明）。缺失后果：隐私插件照常运行，但会话的 agent 组装（工具/prompt 段）不是 edge 版，preset 选择器失效 |

### 明确不需要（都是开发/安装/文档便利）

`src/`、`tests/`、`scripts/`、`presets/`（legacy）、`Makefile`、`install.sh`、`README/LICENSE`、`pnpm-lock.yaml`、`.env`/`.env.sh`（运维项：缺 key 触发 §7.35 LOCAL 降级，属设计内行为）、bundle 自带 `node_modules`（**全部依赖是 peerDependencies，由 `~/.dsh/profiles/node_modules/` hoist 提供**——这是最小集只有 ~1MB 的原因）、legacy `cordis.yml` 与 `profiles/*.cordis.yml`（§7.31 起无人读）。

### 手工最小部署（等价 install.sh 核心路径）

```bash
N=~/.dsh/profiles/<p>/node_modules/@deepseek-harness-edge-agent/dsh-edge-agent
mkdir -p "$N"
cp package.json cordis.patch.yml "$N/"     # ① ②
rsync -a --delete lib/ "$N/lib/"           # ③
# ④ 把包名追加进 ~/.dsh/profiles/<p>/package.json 的 dsh.profile.bundles
# ⑤ (§7.59.3) realm 数据面:往 realm-skill-bridge.configPath 的路径落一张
#    skill-realms.json(实验根可用 bundle-minimal/skill-realms.seed.json)。
#    派工单只挂闸门,策略在表里:缺表 → tools 全部 fail-open(§7.47.1 设计)+ 技能全隐。
```

### 前提与注意

- **前提**：目标机已装 dsh CLI 全局包（`@deepseek-ai/dsh`，自带 dsh-base / dsh-web-app / `@deepseek-ai/*` 上游插件，经 `~/.dsh/profiles/node_modules/` hoist 可解析）。bundle 零自购依赖。
- `install.sh` §2.7 额外写入 profile `dependencies` 的 `file:` 链接是给 `pnpm install` 用的；手工物理放置时可省略。
- **改了嵌套包必须重启 dsh 进程才生效**（运行时唯一真相源是嵌套包那份，不是 repo；§7.54.8 lesson 3）。
- **§7.59 实证结论（极简线）**：上方手工步骤 ①-⑤ 在 TUI 形状（dsh-tui 克隆）与 headless（dsh-base + dsh-headless，零安装）两形状逐字成立，闸门行为一致（差异仅在 TUI 必须 TTY、非交互驱动要用 headless 单发）。**验证面 = TUI 形状（user 拍板 2026-09-16）：dsh-tui 生产实例测完即完成；headless 仅是自动化臂；web 不列入**（`~/.dsh/profiles/web/` 属全量线资产，原样保留、与极简线零联动）。三层语义 mount ≠ active ≠ enforced、最小执法集 = 7 闭包推导与缺件行为，均已并入 `docs/deploy-minimal-files.md` ② 节（铁律 3 + 部署验收推论）及 ①② 表格；载体 = `bundle-minimal/` 三文件（唯一派工单 `cordis.patch.yml`，§7.59.5 单源收敛）+ `scripts/minimal-bundle-rig.sh`；历轮 boot 签名与结果计数存档 `docs/PROGRESS.md` §7.59 系列。⚠️ 复跑 rig 仍建议 `MIN_ROOT=<scratch>` 覆写——默认 `~/.dsh-edge-agent-minimal/` 已无生产实例使用（dsh-tui 已于 2026-09-16 换回全量 bundle，§7.59.7），但里面是 §7.59 历轮实证证据，rig assert 开头会 `rm -rf` 清空它。
- **极简/定制部署的存储隔离坑（§7.59 R7）**：`audit-log.root`、`privacy-policy.policyPath` 是 Schema 必填（缺了 schemastery **静默丢插件**，连 boot 报错都没有），而 `realm-skill-bridge.configPath` **有代码默认值且硬编码 `~/.dsh-edge-agent/skill-realms.json`、不读 `DSH_EDGE_STORAGE_ROOT`**——实验/多实例部署想隔离数据根，这三处都必须显式指走，否则会写进生产共享 root。
- **§7.61 项目自有 headless profile `dsh-edge`（零 UI 宿主）**：仓库带骨架 `profiles/dsh-edge/package.json`（bundles = `[dsh-base, 本包]`）。可行为前提：dsh-base@0.1.2-rc.1 的自带 patch 挂 `- id: web`，故 file-logger 的 `inject: ['web']` 在无 dsh-web-app / 无 dsh-tui 时照样闭合（实机 ops log `web-diag ctx.web registered=true` 钉死）；常驻由 http-api 自己的 `node:http` listen handle 撑（上游 `@deepseek-ai/dsh-headless` 是 one-shot，勿入 bundles）。皮肤 `profiles/dsh-edge/cordis.patch.yml` 把 audit root 分流到 `~/.dsh-edge-agent/audit-dsh-edge/`（flush 是整文件读→tmp→rename，`src/dsh-adapter/audit-log.ts:263-269`，与 dsh-tui 共享审计文件存在互相覆盖新行的竞争窗），其余数据面仍共享生产 root。部署：`./install.sh --profiles=dsh-edge --with=dsh-edge` → 唯一入口 HTTP `http://127.0.0.1:21019/v1/chat`（GET `/v1/health`；鉴权同 bearer）。E2E 复用：`AUTH=on PORT=21019 AUDIT=~/.dsh-edge-agent/audit-dsh-edge/audit.plain.jsonl scripts/e2e-tui-live.sh h1 h2 h5 h4 h3`（§7.60 H 臂平移，实测 13 PASS/0 FAIL/1 合法 sk）。

## 🚀 启动流程

1. **CLI 启动器**（`bin/dsh-edge-agent.js`）（legacy——launcher 已随 §7.33 删除；profile 名 `dsh-edge-agent` 亦被 §7.61 的 `dsh-edge` 取代。现役入口 = `install.sh` / `dsh --profile <name>`）：
   - 检测 `dsh` CLI
   - 引导 `$DSH_HOME/profiles/dsh-edge-agent/` profile
   - 拦截 `--resume` 参数
   - 透传其他参数给 `dsh --profile dsh-edge-agent`

2. **DSH profile boot**：
   - 加载 `cordis.yml` + `cordis.patch.yml`
   - 按依赖顺序实例化所有插件
   - 启动 agent loop

3. **dsh-edge-agent 主插件**（`src/dsh-adapter/index.ts`）：
   - 检查 TEE 可用性
   - 加载隐私策略
   - 注册 LLM 适配器
   - 启动审计日志

## 📐 版本路线图

| 版本 | 状态 | 范围 |
|---|---|---|
| **v0.1.0** | ✅ 当前 | 脚手架：所有插件结构 + stub 实现 |
| v0.2.0 | 计划中 | S1-S5：完整实现 LOCAL 域 + 本地 LLM |
| v0.3.0 | 计划中 | S6-S9：完整实现 SANITIZED 域 + 脱敏管线 |
| v0.4.0 | 计划中 | S10-S11：TEE 集成 + 远程证明 |
| v0.5.0 | 计划中 | S12：E2E 测试 + 性能基准 |
| v0.6.0 | 计划中 | S13：http-api + 第三方插件市场 |
| v1.0.0 | 计划中 | 生产就绪 + 真实 TEE 部署 |

## 🔗 相关文档

- [安装与部署](../README.md#-安装)（项目根 README）
- [配置参考](../README.md#-配置参考)（项目根 README）
- [上游适配契约](#第4章--dsh-上游适配契约升级时阅读)
- [威胁模型](#第7章--stride-威胁模型与缓解措施)
- [插件开发](#第8章--插件开发指南规范--示例)

---


# 第2章 22+1 插件职责、依赖关系、启动顺序

> 来源：`02-architecture/#第2章--221-插件职责依赖关系启动顺序`

# 插件架构与 DSH 调用关系

> 生成时间: 2026-08-21  
> 基于代码 `src/dsh-adapter/` 与 `cordis.yml` 的实际依赖分析

---

## 0. 插件分类:DSH 原生 vs dsh-edge-agent

### DSH 原生插件 (Core DSH Services)

来自 `@deepseek-ai/*` 包,是 DSH 框架的核心服务,由 Cordis 容器直接提供:

| 服务 | 包名 | 作用 | 提供者 |
|------|------|------|--------|
| `agents` | `@deepseek-ai/dsh-agent` | Agent 生命周期管理,创建 AgentHandle | DSH 核心 |
| `llm` | `@deepseek-ai/dsh-llm` | 统一 LLM 接口,adapter 注册,流式生成 | DSH 核心 |
| `tools` | `@deepseek-ai/dsh-tools` | 工具注册表,dispatchToolBody 派发 | DSH 核心 |
| `sessions` | `@deepseek-ai/dsh-session` | 会话管理,事件总线 | DSH 核心 |
| `web` | `@deepseek-ai/dsh-web` | 出站 HTTP 客户端,搜索工具接口 | DSH 核心 |
| `invariants` | `@deepseek-ai/dsh-invariants` | 契约校验,类型安全 | DSH 核心 |
| `cordis` | `@deepseek-ai/cordis` | 插件容器,Service 基类,依赖注入 | DSH 核心 |
| `schemastery` | `@deepseek-ai/schemastery` | Config schema DSL | DSH 核心 |

**DSH 原生工具插件** (直接使用,无需重新实现):

| 工具 | 包名 | 作用 |
|------|------|------|
| `bash` | `@deepseek-ai/dsh-tool-bash` | Bash 命令执行,沙箱,后台 jobs |
| `read/write/edit` | `@deepseek-ai/dsh-tool-fs` | 文件系统工具(读取/写入/编辑/图像) |
| `web_search/web_fetch` | `@deepseek-ai/dsh-tool-web` | Web 搜索和 URL 抓取 |
| 搜索提供者 | `@deepseek-ai/dsh-web-search-deepseek` | DeepSeek 原生搜索 API |

**关键特性**:
- 由 DSH 团队维护,版本跟随 DSH 发布周期
- 提供基础抽象接口(如 `LlmAdapter`, `StreamChunk`, `BlockAssembler`)
- 通过 `ctx.get('serviceName')` 访问
- **工具插件已经过生产验证,功能完整,直接复用**

---

### dsh-edge-agent 插件 (Edge Plugins)

位于 `src/dsh-adapter/`,是 dsh-edge-agent 仓库的自研插件,扩展 DSH 以支持边缘侧私有 AI 代理:

#### 安全/隐私层 (11 个)

| 插件 | 文件 | `inject` 数组 | 作用 |
|------|------|--------------|------|
| **tcm** | `tcm.ts` | *(none)* | TEE 密钥管理（**当前为 stub**：所有 crypto 方法返回零字节，A3 之后实装真实 TEE 后端） |
| **local-storage** | `local-storage.ts` | *(none)* | 会话 / 审计 JSONL 持久化（deployed patch 使用 `storage.plain.jsonl`，PII 脱敏但未加密） |
| **audit-log** | `audit-log.ts` | *(none)* | HMAC 链接的防篡改审计日志 |
| **sessions** | `sessions.ts` | `['localStorage']` | 加密会话生命周期管理（扩展 DSH `sessions`） |
| **privacy-policy** | `privacy-policy.ts` | `['auditLog']` | 热加载的隐私策略引擎（v1.5.0） |
| **prompt-guard** | `prompt-guard.ts` | `['privacyPolicy', 'auditLog', 'llm']` | 输入安全扫描（16 注入规则 + Qwen3-4B 模型辅助） |
| **sanitizer-pipeline** | `sanitizer-pipeline.ts` | `['privacyPolicy', 'auditLog']` | PII 正向 / 反向脱敏（9 条规则 + session 映射） |
| **ohttp-gateway** | `ohttp-gateway.ts` | `['tcm', 'auditLog']` | RFC 9458 OHTTP 匿名网关（A3 后实装） |
| **secure-bridge** | `secure-bridge.ts` | `['tcm', 'ohttp', 'privacyPolicy', 'auditLog']` | 出站安全桥（OHTTP / TLS 模式） |
| **attestation** | `attestation.ts` | `['tcm', 'auditLog']` | TEE 证明 token 生成 / 验证 |
| **td-bus** | `td-bus.ts` | `['auditLog', 'privacyPolicy']` | 威胁检测总线（速率 / 模式异常；deployed 默认 `cloudRequestsPerMinute: 8`） |

#### LLM 适配层 (3 个)

| 插件 | 文件 | `inject` 数组 | 作用 |
|------|------|--------------|------|
| **local-llm-adapter** | `local-llm-adapter.ts` | `['llm', 'auditLog']` | 本地 Qwen3-4B 推理，继承 `LlmAdapter` |
| **cloud-llm-adapter** | `cloud-llm-adapter.ts` | `['llm', 'auditLog']` | DeepSeek Chat Completions（SSE），继承 `LlmAdapter` |
| **model-router** | `model-router.ts` | `['llm']` | 模型路由，统一 `ctx.llm` 表面 |

#### 工具层 (2 个，含 DSH 原生复用)

| 插件 | 文件 | `inject` 数组 | 作用 |
|------|------|--------------|------|
| **tools** | `tools.ts` | `['auditLog', 'tools']` | Realm 工具注册表配置，为 DSH 原生工具添加 Realm 标记 |
| **web-search-guard** | `web-search-guard.ts` | `['tools', 'sanitizer', 'auditLog']` | web_search / web_fetch 结果 PII 反脱敏 + realm 校验（v0.5.0+ 新增） |

> **工具复用**: dsh-edge-agent 不再自行实现工具插件，而是直接复用 DSH 原生工具：
> - `@deepseek-ai/dsh-tool-web` — Web 搜索和抓取（**仅此一项在 `package.json` `peerDependencies` 中声明**）
> - `@deepseek-ai/dsh-web-search-deepseek` — DeepSeek 搜索提供者
> - `@deepseek-ai/dsh-tool-bash` / `dsh-tool-fs` — 通过 `@deepseek-ai/dsh-tools` peer 链 transitive 引入，**未直接列入本仓 peer deps**

#### 编排层 (4 个)

| 插件 | 文件 | `inject` 数组 | 作用 |
|------|------|--------------|------|
| **intent-router** | `intent-router.ts` | `['llm', 'auditLog']` | 意图分类 → LOCAL / CLOUD 路由（v2：被 input-guard 编排） |
| **input-guard** | `input-guard.ts` | `['promptGuard', 'privacyPolicy', 'intentRouter', 'sanitizer', 'auditLog']` | **v2 编排器**（2026-08-29 引入）：注册 3 个全局 hook（`agent/pre-step` + `agent/request` + `llm/stream`），统一 http-api / Web UI / dsh-im 三入口的隐私管线 |
| **plugin-host** | `plugin-host.ts` | `['agents', 'sessions']` | 第三方插件宿主（Community Consensus grant） |
| **http-api** | `http-api.ts` | `['agents', 'intentRouter', 'auditLog', 'tdBus', 'realmSkillBridge', 'edgeTools']` | HTTP 接入（POST /v1/chat, SSE 流，:21017） |

#### 辅助插件 (2 个)

| 插件 | 文件 | `inject` 数组 | 作用 |
|------|------|--------------|------|
| **voice-input** | `voice-input.ts` | `['sessions', 'auditLog']` | Whisper-tiny 语音输入（v0.5.0+） |
| **realm-skill-bridge** | `realm-skill-bridge.ts` | `['auditLog']` | Realm-aware skill catalog filter（`ctx.skills.list/snapshot` 扩展；2026-08-27 引入） |

> **插件总数**：22 个（11 + 3 + 2 + 4 + 2），原 §插件清单 头部称"19+1"已过时。
> **本表所有 `inject` 列均为 `grep "export const inject" src/dsh-adapter/*.ts` 实测结果（2026-08-31）**。

---

### 关键区别

| 维度 | DSH 原生插件 | dsh-edge-agent 插件 |
|------|-------------|---------------------|
| **来源** | `@deepseek-ai/*` npm 包 | `src/dsh-adapter/*.ts` 本地代码 |
| **维护方** | DSH 团队 | dsh-edge-agent 团队 |
| **版本管理** | 跟随 DSH 发布 | 跟随本项目发布 |
| **职责** | 提供核心抽象(agent/llm/tools/sessions) | 实现边缘侧私有 AI 代理的具体功能 |
| **注册方式** | Cordis 容器自动加载 | 通过 `apply()` 手动调用子插件 |
| **扩展方式** | 继承基类(如 `LlmAdapter`) | 实现接口(如 `IntentRouter`, `AuditLogService`) |
| **数据存储** | 内存(由 DSH 管理) | 本地加密存储(local-storage) |
| **网络请求** | 无(或抽象接口) | OHTTP 匿名/secure-bridge 加密 |
| **隐私策略** | 无 | privacy-policy 引擎,Realm 隔离 |

---

### 插件加载流程

```mermaid
sequenceDiagram
    autonumber
    participant User as dsh CLI
    participant Cordis as Cordis 容器
    participant DSH as DSH 原生插件<br/>(agents/llm/tools/sessions)
    participant Edge as dsh-edge-agent<br/>(主插件)
    participant Sub as dsh-edge-agent 子插件<br/>(21 个)

    User->>Cordis: dsh --profile dsh-edge-agent
    Cordis->>DSH: 加载 @deepseek-ai/* 包
    Note over DSH: agents, llm, tools, sessions,<br/>invariants, web 等核心服务就绪
    Cordis->>Edge: 加载 dsh-edge-agent 主插件
    Edge->>Edge: import('./plugin.js')
    Edge->>Sub: 按拓扑排序激活 19 个子插件
    Note over Sub: 1. tcm<br/>2. local-storage<br/>3. audit-log<br/>...<br/>21. http-api

    Sub->>DSH: 注入依赖(ctx.get('llm'), ctx.get('agents'))
    DSH-->>Sub: 返回服务实例

    Note over Sub: local-llm-adapter 继承 LlmAdapter<br/>cloud-llm-adapter 继承 LlmAdapter<br/>两者通过 ctx.llm.registerAdapter() 注册

    Sub->>DSH: local-tools 通过 defineTool() 注册工具
    Sub->>DSH: web-search 通过 registerSearchProvider() 注册搜索

    Note over Edge: 所有插件就绪<br/>edge-agent/boot 事件触发
    Edge-->>Cordis: 启动完成
    Cordis-->>User: DSH 进程运行中
```

---

## 1. 整体架构

dsh-edge-agent 是一个基于 DSH Cordis 插件机制的边缘侧私有 AI 代理。整体架构分为四层:

```
┌─────────────────────────────────────────────────────────────────────┐
│                        外部接入层 (Entry)                            │
│  HTTP API  ·  CLI (dsh --profile)  ·  WebSocket (未来)              │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────────┐
│                       编排层 (Orchestration)                         │
│  intent-router  ·  model-router  ·  plugin-host                     │
│  ↓ 决定走 LOCAL(本地) 还是 CLOUD(云端),以及工具注册                    │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────────┐
│                       安全/隐私层 (Privacy)                          │
│  tcm  ·  local-storage  ·  privacy-policy  ·  prompt-guard          │
│  sanitizer-pipeline  ·  ohttp-gateway  ·  secure-bridge              │
│  attestation  ·  td-bus                                             │
│  ↓ TEE 密钥管理、AES-256-GCM 加密存储、OHTTP 匿名请求               │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────────┐
│                       执行层 (Execution)                             │
│  local-llm-adapter   →  本地 Qwen3-4B (llama.cpp)                  │
│  cloud-llm-adapter   →  DeepSeek Chat Completions (SSE)             │
│  local-tools         →  LOCAL realm 工具 (文件/计算)                 │
│  web-search          →  CLOUD realm 工具 (Anthropic Messages API)   │
│  sessions / audit-log / voice-input                                 │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
              ┌───────────────────────────────────┐
              │  DSH 核心服务 (上游 Cordis 生态)    │
              │  @deepseek-ai/cordis              │
              │  @deepseek-ai/dsh-agent           │
              │  @deepseek-ai/dsh-llm             │
              │  @deepseek-ai/dsh-session         │
              │  @deepseek-ai/dsh-tools           │
              │  @deepseek-ai/dsh-web-search-deepseek │
              │  ...                              │
              └───────────────────────────────────┘
```

---

## 2. 插件依赖关系图 (Plugin Dependency Graph)

箭头表示 "depends-on" 方向(被依赖方在右):

```mermaid
flowchart LR
    %% 基础层(无依赖)
    tcm[tcm<br/>TEE 密钥管理]
    localStorage[local-storage<br/>加密 KV]
    auditLog[audit-log<br/>HMAC 审计]

    %% 核心安全/隐私
    sessions[sessions<br/>加密会话]
    privacy[privacy-policy<br/>隐私策略引擎]
    promptGuard[prompt-guard<br/>输入/输出扫描]

    %% 网关/桥接
    ohttp[ohttp-gateway<br/>OHTTP 匿名网关]
    secureBridge[secure-bridge<br/>出站安全桥]

    %% 工具/搜索
    tools[tools<br/>Realm 工具注册表]
    localTools[local-tools<br/>LOCAL 工具]
    webSearch[web-search<br/>CLOUD 搜索]

    %% LLM 适配器
    localLlm[local-llm-adapter<br/>Qwen3-4B]
    cloudLlm[cloud-llm-adapter<br/>DeepSeek]
    modelRouter[model-router<br/>模型路由]

    %% 编排层
    intentRouter[intent-router<br/>意图分类]
    sanitizer[sanitizer-pipeline<br/>PII 脱敏]
    attestation[attestation<br/>TEE 证明]
    tdBus[td-bus<br/>威胁检测]
    voiceInput[voice-input<br/>语音输入]
    pluginHost[plugin-host<br/>第三方插件宿主]
    httpApi[http-api<br/>HTTP 接入]
    invariant[invariant<br/>契约校验]

    %% 基础层关系
    localStorage --> tcm
    auditLog --> tcm
    auditLog --> localStorage

    %% 会话/隐私
    sessions --> localStorage
    privacy --> tcm
    privacy --> localStorage
    privacy --> auditLog
    promptGuard --> tcm
    promptGuard --> privacy
    promptGuard --> auditLog

    %% 网关/桥接
    ohttp --> tcm
    ohttp --> auditLog
    secureBridge --> tcm
    secureBridge --> ohttp
    secureBridge --> privacy
    secureBridge --> auditLog

    %% 工具层
    tools --> auditLog
    localTools --> tools
    localTools --> localStorage
    webSearch --> tools
    webSearch --> secureBridge
    webSearch --> auditLog

    %% LLM 层
    localLlm --> llm((llm<br/>DSH 服务))
    localLlm --> auditLog
    cloudLlm --> llm
    cloudLlm --> secureBridge
    cloudLlm --> auditLog
    modelRouter --> llm

    %% 编排层
    intentRouter --> llm
    intentRouter --> promptGuard
    intentRouter --> privacy
    intentRouter --> auditLog
    intentRouter --> sessions
    intentRouter --> localStorage
    sanitizer --> localStorage
    sanitizer --> privacy
    attestation --> tcm
    attestation --> auditLog
    tdBus --> auditLog
    tdBus --> privacy
    voiceInput --> sessions
    voiceInput --> auditLog
    pluginHost --> agents((agents<br/>DSH 服务))
    pluginHost --> sessions
    httpApi --> agents
    httpApi --> intentRouter
    httpApi --> auditLog

    classDef base fill:#e1f5fe,stroke:#0277bd,stroke-width:2px;
    classDef privacy fill:#fff3e0,stroke:#e65100,stroke-width:2px;
    classDef orchestration fill:#f3e5f5,stroke:#6a1b9a,stroke-width:2px;
    classDef execution fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px;
    classDef dsh fill:#fce4ec,stroke:#c2185b,stroke-width:2px,stroke-dasharray: 5 5;

    class tcm,localStorage,auditLog base;
    class sessions,privacy,promptGuard,ohttp,secureBridge,attestation,tdBus,sanitizer privacy;
    class intentRouter,modelRouter,pluginHost orchestration;
    class localLlm,cloudLlm,localTools,webSearch,voiceInput,tools execution;
    class llm,agents dsh;
```

---

## 3. 启动顺序 (Boot Order)

Cordis Loader 按拓扑排序激活插件。实际启动顺序如下(从 `plugin.ts` 注释提取):

```mermaid
flowchart TD
    A[1. tcm] --> B[2. local-storage]
    A --> C[3. audit-log]
    B --> C
    B --> D[4. sessions]
    A --> D
    C --> E[5. privacy-policy]
    B --> E
    C --> F[6. tools]
    E --> G[7. prompt-guard]
    A --> G
    A --> H[8. ohttp-gateway]
    C --> H
    H --> I[9. secure-bridge]
    E --> I
    A --> J[10. attestation]
    K[11. local-llm-adapter] -.注册到.-> LLM((ctx.llm))
    I --> M[12. cloud-llm-adapter]
    M -.注册到.-> LLM
    LLM --> N[13. model-router]
    C --> O[14. td-bus]
    E --> O
    N --> P[15. intent-router]
    G --> P
    E --> P
    B --> Q[16. sanitizer-pipeline]
    E --> Q
    F --> R[17. local-tools]
    B --> R
    F --> S[18. web-search]
    I --> S
    D --> T[19. voice-input]
    D --> U[20. plugin-host]
    D --> V[21. http-api]
    P --> V

    classDef foundation fill:#e1f5fe,stroke:#0277bd;
    classDef privacy fill:#fff3e0,stroke:#e65100;
    classDef execution fill:#e8f5e9,stroke:#2e7d32;

    class A,B,C,D foundation;
    class E,F,G,H,I,J,O,Q privacy;
    class K,L,M,N,P,R,S,T,U,V execution;
```

---

## 4. 请求处理流程 (Request Flow)

### 4.1 HTTP Chat 请求整体流程

```mermaid
flowchart TD
    Start([客户端 POST /v1/chat]) --> Auth{Bearer Token<br/>认证}
    Auth -->|失败| Reject[401 Unauthorized]
    Auth -->|成功| Classify[intent-router.classify]

    Classify --> RouteDecision{Intent?}
    RouteDecision -->|LOCAL| LocalLLM[local-llm-adapter<br/>Qwen3-4B 本地推理]
    RouteDecision -->|CLOUD| Sanitize[sanitizer-pipeline<br/>PII 脱敏]

    Sanitize --> PromptGuard[prompt-guard<br/>输入扫描]
    PromptGuard --> Bridge[secure-bridge<br/>OHTTP 加密]
    Bridge --> OHTTP[ohttp-gateway<br/>匿名中继]
    OHTTP --> CloudLLM[cloud-llm-adapter<br/>DeepSeek SSE]

    LocalLLM --> AgentLoop
    CloudLLM --> AgentLoop

    AgentLoop[agent-loop<br/>DSH 核心] --> ToolCheck{有 tool-call?}
    ToolCheck -->|无| FinalText[生成最终文本]
    ToolCheck -->|有| ToolDispatch[tools.dispatchToolBody]

    ToolDispatch --> RealmCheck{工具 Realm?}
    RealmCheck -->|LOCAL| LocalToolExec[local-tools<br/>本地执行]
    RealmCheck -->|CLOUD| WebSearchExec[web-search<br/>DeepSeek Anthropic API]

    LocalToolExec --> LoopBack[结果回传 agent-loop]
    WebSearchExec --> LoopBack
    LoopBack --> AgentLoop

    FinalText --> ReverseSan[反向 PII 还原]
    ReverseSan --> Audit[audit-log 记录]
    Audit --> Response([200 JSON 响应])

    classDef input fill:#bbdefb,stroke:#1565c0;
    classDef decision fill:#fff9c4,stroke:#f57f17;
    classDef local fill:#c8e6c9,stroke:#2e7d32;
    classDef cloud fill:#ffccbc,stroke:#d84315;
    classDef output fill:#e1bee7,stroke:#6a1b9a;

    class Start,Auth,Reject input;
    class Classify,RouteDecision,ToolCheck,RealmCheck decision;
    class LocalLLM,LocalToolExec local;
    class Sanitize,PromptGuard,Bridge,OHTTP,CloudLLM,WebSearchExec cloud;
    class FinalText,ReverseSan,Audit,Response output;
```

### 4.2 模型路由细节

```mermaid
flowchart LR
    Msg[用户消息] --> IR[intent-router]
    IR -->|category=LOCAL<br/>confidence≥0.6| MR[model-router]
    IR -->|category=CLOUD| MR

    MR -->|resolveRoute| Provider{provider 前缀}
    Provider -->|local-*| LA[local-llm-adapter]
    Provider -->|cloud-*| CA[cloud-llm-adapter]

    LA --> LLM((ctx.llm<br/>统一接口))
    CA --> LLM

    LLM --> AG[agent-loop]
```

---

## 5. 核心序列图 (Sequence Diagrams)

### 5.1 完整 Chat 请求序列(含工具调用)

```mermaid
sequenceDiagram
    autonumber
    participant Client as 客户端
    participant HTTP as http-api
    participant IR as intent-router
    participant MR as model-router
    participant AL as agent-loop (DSH)
    participant LLM as ctx.llm (统一)
    participant LA as local-llm-adapter
    participant CA as cloud-llm-adapter
    participant SB as secure-bridge
    participant OH as ohttp-gateway
    participant Tools as ctx.tools
    participant LT as local-tools
    participant WS as web-search
    participant Audit as audit-log
    participant DS as DeepSeek API

    Client->>HTTP: POST /v1/chat {message, sessionId}
    HTTP->>Audit: info http.chat.start
    HTTP->>IR: classify(message)
    IR-->>HTTP: {category: CLOUD, confidence: 0.85}
    HTTP->>MR: resolveRoute(cloud-llm)
    MR-->>HTTP: provider+model
    HTTP->>AL: followup(userMessage)

    Note over AL,Audit: 第一轮 LLM 调用 (带工具声明)

    AL->>LLM: generate(messages, tools)
    LLM->>CA: stream(options)
    CA->>SB: request(https://api.deepseek.com/...)
    SB->>OH: ohttpEncrypt(payload)
    OH->>DS: POST /chat/completions (SSE)
    DS-->>OH: text-delta 流
    OH-->>SB: 解密
    SB-->>CA: SSE frames
    Note over CA: sseEventToChunk()<br/>tool-call-delta 累积<br/>terminalChunks() 收尾
    CA-->>LLM: StreamChunk 流
    LLM-->>AL: assembled message (text + tool-call blocks)

    AL->>Audit: assistant/message
    AL->>Tools: dispatchToolBody(tool-call block)
    Tools->>Audit: tool/call
    Tools->>WS: execute({query})
    WS->>DS: POST /anthropic/v1/messages (web_search_20250305)
    DS-->>WS: web_search_tool_result blocks
    Note over WS: mapAnthropicResponse()<br/>提取 citations + URLs
    WS-->>Tools: {content, sources}
    Tools-->>AL: tool-result message
    AL->>Audit: tool/result

    Note over AL,Audit: 第二轮 LLM 调用 (带工具结果)

    AL->>LLM: generate(messages + tool-result)
    LLM->>CA: stream(...)
    CA->>DS: POST /chat/completions
    DS-->>CA: 最终文本
    CA-->>LLM: StreamChunk 流
    LLM-->>AL: final assistant message
    AL->>Audit: assistant/message (text only)

    AL-->>HTTP: turn complete
    HTTP->>Audit: info http.chat.end
    HTTP-->>Client: 200 {sessionId, result, intent}
```

### 5.2 意图分类序列

```mermaid
sequenceDiagram
    autonumber
    participant HTTP as http-api
    participant IR as intent-router
    participant LLM as ctx.llm (本地)
    participant LA as local-llm-adapter
    participant Qwen as Qwen3-4B
    participant Audit as audit-log

    HTTP->>IR: classify("帮我计算 123*456")
    IR->>Audit: debug intent.classify.start

    Note over IR: 1. 规则匹配 (快速路径)
    IR->>IR: ruleBasedClassify(text)
    Note over IR: 关键词命中: "计算" → LOCAL<br/>confidence=0.7

    alt 规则置信度 ≥ 阈值 (0.6)
        IR-->>HTTP: {category: LOCAL, confidence: 0.7}
    else 规则不确定
        Note over IR: 2. LLM 兜底分类
        IR->>LLM: generate(classification prompt)
        LLM->>LA: stream(qwen3-4b)
        LA->>Qwen: llama.cpp 本地推理
        Qwen-->>LA: "LOCAL"
        LA-->>LLM: StreamChunk
        LLM-->>IR: 解析响应
        IR-->>HTTP: {category: LOCAL, confidence: 0.85}
    end

    HTTP->>Audit: info http.chat.route {intent: LOCAL}
```

### 5.3 工具调用生命周期 (BlockAssembler 视角)

这是近期修复的核心流程 —— tool-call block 索引冲突问题:

```mermaid
sequenceDiagram
    autonumber
    participant DS as DeepSeek SSE
    participant CA as cloud-llm-adapter
    participant SSE as openai-sse helpers
    participant BA as BlockAssembler (DSH)
    participant AL as agent-loop

    Note over CA: stream() 开始<br/>yield block-start(index=0, text)

    loop 文本 delta 流
        DS->>CA: {choices: [{delta: {content: "..."}}]}
        CA->>SSE: parseSseEvent → text-delta(index=0)
        SSE-->>CA: StreamChunk
        CA->>BA: push(text-delta, index=0)
        Note over BA: partial[0].text += delta
        CA-->>AL: yield text-delta
    end

    loop 工具调用 delta 流
        DS->>CA: {choices: [{delta: {tool_calls: [{index: 0, function: {name, arguments}}]}}]}
        CA->>SSE: parseSseEvent → tool-call-delta(index=0)
        Note over SSE: toolCalls Map 累积<br/>{id, name, arguments}
        SSE-->>CA: StreamChunk(index=0)
        CA->>BA: push(tool-call-delta, index=0)
        Note over BA: partial[0] 已有!<br/>累积 toolCallId/Name/Args<br/>⚠️ 与 text 共享 partial
        CA-->>AL: yield tool-call-delta
    end

    DS->>CA: {choices: [{finish_reason: "tool_calls"}]}
    CA->>SSE: parseSseEvent → finish

    Note over CA: SSE 流结束<br/>进入 terminalChunks()

    CA->>SSE: terminalChunks(...)
    Note over SSE: 旧实现 (BUG):<br/>yield block-end(index=0, text)<br/>yield block-end(index=0, tool-call) ← 冲突!<br/>→ text 块先设置 partial.block<br/>→ tool-call 块被丢弃

    Note over SSE: 新实现 (FIXED):<br/>yield block-end(index=0, text)<br/>yield block-end(index=1, tool-call) ✓<br/>(toolCallIndex 从 1 开始递增)

    SSE-->>CA: block-end(0, text), block-end(1, tool-call), finish
    CA->>BA: push(block-end, index=0)
    Note over BA: partial[0].block = text block
    CA->>BA: push(block-end, index=1)
    Note over BA: 新 partial[1].block = tool-call block ✓
    CA->>BA: push(finish, reason=tool-calls)
    Note over BA: _finish = {kind: tool-calls}

    CA-->>AL: 流结束

    AL->>BA: assembler.blocks()
    BA-->>AL: [text block, tool-call block]
    Note over AL: message.content 包含两者 ✓<br/>检测到 tool-call → 进入工具派发
```

---

## 6. 插件与 DSH 上游服务的交互接口

| 插件 | 使用的 DSH 服务 | 接口方式 |
|------|----------------|----------|
| `local-llm-adapter` | `ctx.llm` | 继承 `LlmAdapter`，注册 `stream()` |
| `cloud-llm-adapter` | `ctx.llm` | 继承 `LlmAdapter`，注册 `stream()` |
| `model-router` | `ctx.llm` | 调用 `resolveRoute()`，选择 adapter |
| `intent-router` | `ctx.llm`, `ctx.auditLog` | 调用 `generate()` 做意图分类 |
| `input-guard` | `ctx.promptGuard`, `ctx.privacyPolicy`, `ctx.intentRouter`, `ctx.sanitizer`, `ctx.auditLog` | v2 编排器：3 个全局 waterfall hook（`agent/pre-step` + `agent/request` + `llm/stream`），调用各服务做正向 + 反向 + 路由改写 |
| `sanitizer-pipeline` | `ctx.privacyPolicy`, `ctx.auditLog` | 调用 `sanitize()` / `desanitize()` |
| `prompt-guard` | `ctx.privacyPolicy`, `ctx.auditLog`, `ctx.llm` | 调用 `checkInput()`；模型辅助检测走 `ctx.llm.stream()` |
| `http-api` | `ctx.agents`, `ctx.intentRouter`, `ctx.auditLog`, `ctx.tdBus`, `ctx.realmSkillBridge`, `ctx.edgeTools` | 调用 `agents.create()` / `agent.followup()`；订阅 `session/event`；读 `_edgeRejection` 翻译 HTTP 状态 |
| `tools` | `ctx.tools`, `ctx.auditLog` | `defineTool()` 注册 Realm-aware 工具；`filterTools()` / `isToolAllowed()` 做 realm 过滤 |
| `web-search-guard` | `ctx.tools`, `ctx.sanitizer`, `ctx.auditLog` | 监听 `tools/result`，对 web_search / web_fetch 结果做 PII 反脱敏 + realm 校验 |
| `plugin-host` | `ctx.agents`, `ctx.sessions` | 管理第三方插件 grant |
| `sessions` (edge) | `ctx.localStorage` | 加密会话元数据 |
| `audit-log` | `*(none — 无 DSH 服务依赖)*` | HMAC 链接；`audit()` / `log()` / `getStats()` |
| `privacy-policy` | `ctx.auditLog` | 持久化策略缓存；`matchRouting()` / `classify()` / `sanitize()` |
| `secure-bridge` | `ctx.tcm`, `ctx.ohttp`, `ctx.privacyPolicy`, `ctx.auditLog` | 出站请求加密 + 域名过滤 |
| `realm-skill-bridge` | `ctx.auditLog` | 扩展 `ctx.skills.list()` / `ctx.skills.snapshot()`，按 realm 过滤 skill catalog |
| `td-bus` | `ctx.auditLog`, `ctx.privacyPolicy` | 速率 / 模式异常检测；`recordCloudRequest()` / `recordSanitizeFailure()` |
| `attestation` | `ctx.tcm`, `ctx.auditLog` | TEE 证明 token 生成 / 验证 |
| `ohttp-gateway` | `ctx.tcm`, `ctx.auditLog` | RFC 9458 OHTTP 匿名网关 |

**关键抽象边界**:
- `LlmAdapter` (来自 `@deepseek-ai/dsh-llm`) — 本地/云端适配器都继承此类,`stream()` 返回 `AsyncIterable<StreamChunk>`
- `StreamChunk` — 统一的流式数据单元 (`text-delta`, `tool-call-delta`, `block-end`, `finish` 等)
- `BlockAssembler` — DSH 内部把 chunk 流组装成完整 message block
- `ctx.tools` — Realm-aware 工具注册表,`local-tools` 和 `web-search` 都通过它暴露工具给 agent-loop

---

## 7. 数据流向总览

```mermaid
flowchart TB
    subgraph External["外部世界"]
        User([用户])
        DS[(DeepSeek Cloud)]
        ThirdParty[第三方插件]
    end

    subgraph Edge["dsh-edge-agent"]
        subgraph Entry["接入层"]
            HTTP[http-api]
            CLI[dsh CLI]
        end

        subgraph Orch["编排层"]
            IR[intent-router]
            MR[model-router]
            PH[plugin-host]
        end

        subgraph Security["安全/隐私层"]
            TCM[tcm]
            LS[local-storage]
            PP[privacy-policy]
            PG[prompt-guard]
            SP[sanitizer-pipeline]
            OH[ohttp-gateway]
            SB[secure-bridge]
            AT[attestation]
            TD[td-bus]
            AL[audit-log]
        end

        subgraph Exec["执行层"]
            LLA[local-llm-adapter]
            CLA[cloud-llm-adapter]
            LT[local-tools]
            WS[web-search]
            VI[voice-input]
            Tools[tools registry]
        end
    end

    subgraph DSHCore["DSH 核心 (@deepseek-ai/*)"]
        Cordis[cordis 容器]
        Agents[agents 服务]
        LLM[llm 服务]
        Session[session 服务]
        AgentLoop[agent-loop]
        ToolsSvc[tools 服务]
        WebSvc[web 服务]
    end

    User -->|HTTP/JSON| HTTP
    User -->|CLI| CLI
    ThirdParty --> PH

    HTTP --> IR
    HTTP --> Agents
    CLI --> Agents

    IR --> LLM
    MR --> LLM

    Agents --> AgentLoop
    AgentLoop --> LLM
    AgentLoop --> ToolsSvc

    LLM --> LLA
    LLM --> CLA
    LLA -->|llama.cpp 本地| LLA
    CLA --> SB
    SB --> OH
    OH --> DS

    ToolsSvc --> Tools
    Tools --> LT
    Tools --> WS
    WS --> SB
    WS -->|Anthropic Messages API| DS

    TCM --> LS
    TCM --> OH
    TCM --> AT
    LS --> Session
    LS --> SP
    PP --> PG
    PP --> SB
    PP --> SP
    PG --> IR
    SP --> CLA
    AL --> TD

    classDef external fill:#ffcdd2,stroke:#c62828;
    classDef edge fill:#e8eaf6,stroke:#283593;
    classDef dsh fill:#fff3e0,stroke:#ef6c00;

    class User,DS,ThirdParty external;
    class HTTP,CLI,IR,MR,PH,TCM,LS,PP,PG,SP,OH,SB,AT,TD,AL,LLA,CLA,LT,WS,VI,Tools edge;
    class Cordis,Agents,LLM,Session,AgentLoop,ToolsSvc,WebSvc dsh;
```

---

## 8. 关键 Realm 模型

dsh-edge-agent 通过 **Realm** 概念隔离工具和数据:

| Realm | 含义 | 典型工具 | 数据路径 |
|-------|------|---------|---------|
| **LOCAL** | 本地私有数据/计算 | `local-tools` (文件读写, 数学计算) | 不出设备, AES-256-GCM 加密存储 |
| **CLOUD** | 公网知识/服务 | `web-search`, `cloud-llm-adapter` | OHTTP 匿名中继, PII 脱敏 |
| **SANITIZED** | 经脱敏可上云的数据 | `sanitizer-pipeline` 处理后的内容 | 正向脱敏 → 云 → 反向还原 |

`intent-router` 的意图分类决定请求走 LOCAL 还是 CLOUD;`tools` 插件的 Realm 注册表决定工具调用路由。

---

## 9. 与 DSH 上游包的依赖关系

```mermaid
flowchart LR
    Edge[dsh-edge-agent<br/>本仓库]

    Edge --> Cordis[@deepseek-ai/cordis<br/>插件容器 + Service 基类]
    Edge --> Schema[@deepseek-ai/schemastery<br/>Config schema DSL]
    Edge --> Agent[@deepseek-ai/dsh-agent<br/>Agent / AgentHandle]
    Edge --> LLM[@deepseek-ai/dsh-llm<br/>LlmAdapter / StreamChunk / BlockAssembler]
    Edge --> Session[@deepseek-ai/dsh-session<br/>Session / SessionId / SessionEvent]
    Edge --> Tools[@deepseek-ai/dsh-tools<br/>defineTool / createSuccessResult]
    Edge --> Web[@deepseek-ai/dsh-web-search-deepseek<br/>DeepSeekSearchProvider]
    Edge --> WebCore[@deepseek-ai/dsh-web<br/>WebError / ctx.web]

    classDef edge fill:#e3f2fd,stroke:#1565c0;
    classDef dsh fill:#fff8e1,stroke:#f57f17;
    class Edge edge;
    class Cordis,Schema,Agent,LLM,Session,Tools,Web,WebCore dsh;
```

**关键交互点**:
- **`LlmAdapter` 继承**: `local-llm-adapter` 和 `cloud-llm-adapter` 都继承自 `LlmAdapter`,通过 `ctx.llm.registerAdapter()` 注册,由 `model-router` 选择
- **`StreamChunk` 契约**: 适配器返回的 chunk 流必须遵循 DSH 定义的类型(`text-delta`, `tool-call-delta`, `block-end`, `finish` 等),由 `BlockAssembler` 组装
- **`defineTool` 注册**: 本地工具和搜索工具通过 `defineTool()` 暴露给 `ctx.tools`,agent-loop 在生成 tool-call 时自动派发
- **`SessionEvent` 订阅**: `http-api` 通过 `ctx.on('session/event', ...)` 监听所有 session 事件,实现响应流式返回

---

## 10. 附录:插件速查表

| 插件 | 来源 | 作用 | 依赖 | 注册的服务/接口 |
|------|------|------|------|----------------|
| **tcm** | 🟦 Edge | TEE 密钥管理、AES-256-GCM 加解密、密封、远程证明 | 无 | `ctx.tcm` |
| **local-storage** | 🟦 Edge | AES-256-GCM 加密的 SQLite KV | tcm | `ctx.localStorage` |
| **audit-log** | 🟦 Edge | HMAC 链接的防篡改审计日志,JSONL 持久化 | tcm, localStorage | `ctx.auditLog` |
| **sessions** | 🟦 Edge | 加密会话生命周期管理 | localStorage | 扩展 `ctx.sessions` |
| **privacy-policy** | 🟦 Edge | 热加载的隐私策略引擎 | tcm, localStorage, auditLog | `ctx.privacyPolicy` |
| **tools** | 🟦 Edge | Realm-aware 工具注册表(LOCAL/CLOUD/SANITIZED) | auditLog | `ctx.tools` / `ctx.edgeTools` |
| **prompt-guard** | 🟦 Edge | 输入/输出安全扫描(MVP:4 条规则) | tcm, privacyPolicy, auditLog | `ctx.promptGuard` |
| **intent-router** | 🟦 Edge | 意图分类 → LOCAL/CLOUD 路由 | llm, promptGuard, privacyPolicy, auditLog, sessions, localStorage | `ctx.intentRouter` |
| **model-router** | 🟦 Edge | 模型路由,统一 `ctx.llm` 表面 | llm | 扩展 `ctx.llm.resolveRoute()` |
| **local-llm-adapter** | 🟦 Edge | 本地 Qwen3-4B 推理(llama.cpp) | llm, auditLog | 注册到 `ctx.llm` |
| **cloud-llm-adapter** | 🟦 Edge | DeepSeek Chat Completions(SSE) | llm, secureBridge, auditLog | 注册到 `ctx.llm` |
| **sanitizer-pipeline** | 🟦 Edge | PII 正向/反向脱敏 | localStorage, privacyPolicy | `ctx.sanitizer` |
| **ohttp-gateway** | 🟦 Edge | RFC 9458 OHTTP 匿名网关 | tcm, auditLog | `ctx.ohttp` |
| **secure-bridge** | 🟦 Edge | 出站安全桥(OHTTP/TLS 模式) | tcm, ohttp, privacyPolicy, auditLog | `ctx.secureBridge` |
| **attestation** | 🟦 Edge | TEE 证明 token 生成/验证 | tcm, auditLog | `ctx.attestation` |
| **td-bus** | 🟦 Edge | 威胁检测总线(速率/模式异常) | auditLog, privacyPolicy | `ctx.tdBus` |
| **local-tools** | 🟦 Edge | LOCAL realm 工具(文件/计算) | tools, localStorage | 注册到 `ctx.tools` |
| **web-search** | 🟦 Edge | CLOUD 搜索(DeepSeek Anthropic API) | tools, secureBridge, auditLog | 注册到 `ctx.web` |
| **voice-input** | 🟦 Edge | Whisper-tiny 语音输入 | sessions, auditLog | `ctx.voiceInput` |
| **plugin-host** | 🟦 Edge | 第三方插件宿主(Community Consensus grant) | agents, sessions | `ctx.pluginHost` |
| **http-api** | 🟦 Edge | HTTP 接入(POST /v1/chat, SSE 流) | agents, intentRouter, auditLog | HTTP 服务器 |
| **invariant** | 🟦 Edge | 上游 DSH 契约校验 | invariants | 启动时 drift check |

**图例**: 🟦 Edge = dsh-edge-agent 自研插件 (src/dsh-adapter/)  
所有 19 个子插件都是 dsh-edge-agent 的自研插件,它们依赖 DSH 原生服务(如 `agents`, `llm`, `tools`, `sessions`)。

---

## 11. 关键事件流 (Session Events)

agent-loop 和 session 服务发出的事件,`http-api` 订阅:

```mermaid
sequenceDiagram
    participant AL as agent-loop
    participant SE as Session
    participant HTTP as http-api
    participant Audit as audit-log

    AL->>SE: turn/start
    SE->>HTTP: session/event
    AL->>SE: step/start
    SE->>HTTP: session/event
    AL->>SE: user/message
    SE->>HTTP: session/event
    AL->>SE: assistant/chunk (多次)
    SE->>HTTP: session/event
    Note over HTTP: 流式推送到客户端(SSE)
    AL->>SE: assistant/message
    SE->>HTTP: session/event
    alt 有工具调用
        AL->>SE: tool/call
        SE->>HTTP: session/event
        Note over AL: 执行工具
        AL->>SE: tool/result
        SE->>HTTP: session/event
        Note over AL: 回到 LLM
    end
    AL->>SE: step/end
    SE->>HTTP: session/event
    AL->>SE: turn/end
    SE->>HTTP: session/event
    Note over HTTP: 提取最后 assistant/message 的文本
    HTTP->>Audit: info http.chat.end
```

---

**文档维护**: 此文档应随插件增删同步更新。修改 `cordis.yml` 或新增 `src/dsh-adapter/*.ts` 后,请重新生成依赖图。


---


# 第3章 CLI vs HTTP 双入口设计

> 来源：`02-architecture/#第3章--cli-vs-http-双入口设计`

# dsh-edge-agent 多入口架构设计

**版本**：v1.1 (2026-08-29)
**适用范围**：dsh-edge-agent v0.1.0+
**关联文档**：[`input-guard-design.md`](./intent-and-sanitization.md)、[`architecture.md`](architecture.md)、[`#第2章--221-插件职责依赖关系启动顺序`](#第2章--221-插件职责依赖关系启动顺序)、[`#第9章--设计基线完整设计方案235-kb-主基线`](#第9章--设计基线完整设计方案235-kb-主基线)

---

## 1. TL;DR

dsh-edge-agent 同时对外暴露**三个用户入口**，明确分工：

| 入口 | 端口 | 协议 | 鉴权 | 目标用户 |
|---|---|---|---|---|
| **dsh-webui**（DSH 官方 Web UI） | `:21018` | SPA + apiproxy RPC + SSE | loopback trust + pairing | **人类 / 浏览器** |
| **dsh-im**（IM 聊天软件通道网关） | (无新端口) | webserver 内部 apiProxy + IM 平台 SDK | QR / bot credentials | **人类 / 移动端聊天** |
| **http-api**（自研 REST） | `:21017` | REST + SSE + Bearer | Bearer token + body cap | **CLI / SDK / cURL / 外部 agent** |

三条入口**共享同一套 agent-loop 管线**（input-guard / prompt-guard / sanitizer / privacy-policy / audit-log / sessions / model-router / LLM adapters）。`input-guard` 挂在全局 hook 上，所以**所有入口自动获得隐私保护**。

```
                     ┌─────────────────────────────────┐
                     │   shared agent-loop + input-guard│
                     │   (privacy pipeline invariant)   │
                     └────────────────▲────────────────┘
                                      │
       ┌──────────────────────────────┼──────────────────────────────┐
       │                              │                              │
 ┌─────┴──────┐               ┌───────┴───────┐              ┌───────┴───────┐
 │dsh-webui   │               │ dsh-im         │              │ http-api      │
 │(:21018)    │               │ (no new port)  │              │ (:21017)      │
 │browser     │               │IM clients      │              │CLI/SDK/cURL   │
 │SPA+apiproxy│               │feishu/weixin/  │              │REST+SSE+bearer│
 │            │               │dingtalk/wecom/ │              │               │
 │            │               │qq/slack/tg/    │              │               │
 │            │               │dc/whatsapp     │              │               │
 └────────────┘               └───────────────┘              └───────────────┘
       │                              │                              │
       └──── all reach agent-loop ────┴──── all reach agent-loop ────┘
                  via dsh-host-webserver apiProxy            via agent.followup
```

---

## 2. 背景：input-guard 决定三条入口是平行的

2026-08-29 合并的 `input-guard`（commit `eaec70b`）把 http-api 内的脱敏/防护逻辑**上移到 agent-loop 的全局 hook**：

- `agent/pre-step` — pre-flight prompt-guard + privacy-policy + intent-route + sanitize
- `agent/request` — sanitize failure → downgrade to LOCAL
- `llm/stream` — desanitize 占位符回 PII

这条 hook 链对所有走 agent-loop 的入口一视同仁：

| 入口 | 路径 | input-guard 覆盖 |
|---|---|---|
| dsh-webui | `dsh-host-apiproxy → agent-loop` | ✅ 自动 |
| dsh-im | `IM SDK → dsh-host-webserver.connection → apiProxy → agent-loop` | ✅ 自动 |
| http-api | `agent.followup → agent-loop` | ✅ 自动 |

这意味着多入口不是"三条不同的实现路径"，而是"三条不同的 transport + 一条共享的 agent 管线"。input-guard 的存在让多入口**安全对齐**成为自然结果。

**关键洞察**：dsh-im 之所以能"零成本"获得 input-guard 覆盖，是因为它**复用**了 webserver 的 `apiProxy` 服务，而不是另起炉灶自己调 agent-loop。这意味着 dsh-im 是 webui 的 transport 变体，而不是平行的新入口——它的鉴权面（QR / bot credentials）和 webui 的 loopback trust 是同一个 webserver 实例提供的。

---

## 3. 设计决策

### 3.1 主决策：明确分工（CONFIRM）

**采纳用户提出的分工**：

- 浏览器 / 真人用户 → dsh-webui（`@deepseek-ai/dsh-host-webserver` + `dsh-web-app` + `dsh-web-frontend` + `@linxin666/dsh-web-ui-all`）
- 移动端 / IM 聊天用户 → dsh-im（`@xmanrui/dsh-im`，基于 webserver 的 connection/apiProxy）
- CLI / SDK / 外部 agent / cURL → http-api

### 3.2 鉴权模型不同

| 模型 | 适用 | 设计依据 |
|---|---|---|
| dsh-webui：loopback trust + pairing token | 浏览器用户，DSH 上游默认 | SPA 的 token 流转复杂；loopback 已提供边界；上游合约 |
| http-api：Bearer token + body cap（1 MiB） | 程序客户端，机器友好 | bearer 是机器调用的事实标准；body cap 防 OOM |

强行复用任一模型都会让另一端的体验崩坏。两套鉴权**互不交叉**。

### 3.3 接口风格不同

- **dsh-webui**：SPA + apiproxy RPC（SPA 通过 `dsh-host-apiproxy` 调 `sessions.list / prompt / cancel / fork / rename` 等 DSH 合约方法）。
- **dsh-im**：IM 平台 SDK 长连接 / 长轮询（飞书 WebSocket、钉钉 Stream、Slack Socket Mode、Telegram Bot API、Discord Gateway v10、WhatsApp Web 等），消息经 webserver 内部 `apiProxy` 入 agent-loop。
- **http-api**：RESTful + SSE（人类熟悉 + 程序易测；SSE 15s keepalive 防代理切断）。

### 3.4 拒绝的替代方案

- **「合并到 dsh-webui」**：webui 是浏览器表面，bearer + cookie 模型不兼容机器调用。
- **「合并到 http-api」**：失去 DSH 原生 SPA（task-board / git-graph / pet / skin-center），违反 DSH 架构。
- **「webui 调 http-api 反向调用」**：绕过 DSH 原生 apiproxy，破坏 input-guard 的统一 hook 设计（input-guard-design.md §4.3 已否）。
- **「三入口共用同一端口」**：协议、鉴权、客户端形态完全不同，强行绑定会引入隐藏耦合。
- **「http-api 加 CORS 让 webui SDK 也走它」**：CORS 是 webui 的补救路径，不是主路径；先坚持 `dsh-host-apiproxy`。
- **「dsh-im 独立监听新端口」**：dsh-im 复用 webserver 的 connection/apiProxy，不开新端口——它的鉴权面（QR / bot credentials）由 webui「设置 → IM机器人」页面统一管理。这避免了 IM 凭据与 webui 凭据两套存储的不一致。

---

## 4. 端口与协议

### 4.1 dsh-webui（`:21018`）

- **宿主**：`@deepseek-ai/dsh-host-webserver`
- **前端**：`dsh-web-app` + `dsh-web-frontend`（SPA）+ 可选 `@linxin666/dsh-web-ui-all`（task-board / git-graph / pet / skin-center 全家桶；**v1 默认 disable**）
- **后端桥**：`dsh-host-apiproxy`（DSH 上游，不在 dsh-edge-agent 仓库控制范围）
- **协议**：HTTP/1.1 + WebSocket（apiproxy）+ SSE（chat 流）
- **鉴权**：loopback trust；远端访问走 DSH 上游的配对 token 流程
- **附加角色**：同时为 dsh-im 提供 `connection` + `apiProxy` 服务（详见 §4.3）

### 4.2 http-api（`:21017`）

- **宿主**：`@deepseek-harness-edge-agent/dsh-edge-agent/http-api`（自研插件）
- **协议**：REST + SSE（chat 流）
- **鉴权**：Bearer token（`Authorization: Bearer <EDGE_API_KEY>`，环境变量注入）+ body cap（默认 1 MiB）
- **CORS**：**v1 不暴露**——`enableCors` 字段在 schema 中完全不出现（即便 `DSH_EDGE_HTTP_CORS=true` 也不生效）。理由：CORS 是 webui 补救路径，会引入 preflight 攻击面；程序客户端同主机调用不需要 CORS。**v2 再启用**（必须配 origin allowlist + `Vary: Origin`）。

### 4.3 dsh-im（无新端口 — 复用 webserver）

- **宿主**：`@xmanrui/dsh-im`（IM 通道网关插件）
- **依赖服务**（来自 dsh-base + 本 patch 已挂载）：
  - `connection`     ← `@deepseek-ai/dsh-host-webserver`（本 patch 顶层 configOverride）
  - `apiProxy`       ← `@deepseek-ai/dsh-host-webserver` 内部
  - `typertGateway`  ← `@deepseek-ai/dsh-api-gateway`（dsh-base 顶层 id `typert-gateway`）
  - `credentials`    ← `@deepseek-ai/dsh-credentials-local`（dsh-base 顶层 id `credentials`）
- **协议**：IM 平台原生 SDK
  | 渠道 | 协议 |
  |---|---|
  | 飞书 | WebSocket 长连接 + 流式卡片 |
  | 微信 | iLink 长轮询 + 1,800 字符分段发送 |
  | 钉钉 | Stream 长连接 + AI Card |
  | 企业微信 | WebSocket 长连接 + 「思考中」原生展示 |
  | QQ | WebSocket 长连接（私聊 Markdown，群聊仅 @） |
  | Slack | Socket Mode 长连接 |
  | Telegram | Bot API 长轮询 + Rich Message Draft 流式预览 |
  | Discord | Gateway v10 长连接 + 原生 Thread |
  | WhatsApp | WhatsApp Web 长连接 |
  | AI Office | HTTPS 心跳 + SSE 下行（90 秒任务租约） |
- **鉴权**：
  - **IM 渠道凭据**（飞书 App Secret / 微信 iLink 凭据 / 钉钉 Client Secret / 企业微信 Bot Secret / QQ AppSecret / Slack Bot+App Token / Telegram Bot Token / Discord Bot Token / WhatsApp 扫码）：用户从 webui 「设置 → IM机器人」页面扫码或粘贴，**只写入 `dsh-credentials-local` 受保护凭据存储**，配置文件不落盘。
  - **AI Office Device Token**：同上，只入凭据存储。
  - **rpcAuthority**：`'loopback'`（默认，IM 管理 RPC 仅 loopback）或 `'trusted-host'`（远端访问 webui 场景）。
- **CORS**：N/A — IM 客户端是 SDK 长连接，不走浏览器预检。

### 4.4 端口冲突矩阵

| 端口 | 服务 | 冲突？ |
|---|---|---|
| `:21017` | http-api | — |
| `:21018` | dsh-host-webserver | — |
| `:21019+` | webui SPA 内部端口（dsh-web-app 内嵌静态资源） | — |

监听时使用 `127.0.0.1` 默认绑定（可通过 `DSH_EDGE_HTTP_HOST` / `DSH_EDGE_WEB_HOST` 改）。两端口**可同时监听**，互不阻塞。dsh-im 不开端口，IM 平台长连接由各渠道 SDK 自行维护；webserver 在 loopback 上为 dsh-im 提供 apiProxy。

### 4.5 服务依赖矩阵（dsh-im 视角）

| 依赖服务 | 提供者 | 是否在本 patch 显式挂载 |
|---|---|---|
| `connection` | `@deepseek-ai/dsh-host-webserver` | ✅ 顶层 configOverride（`dsh-host-webserver`） |
| `apiProxy` | `@deepseek-ai/dsh-host-webserver` 内部 | ✅ 同上 |
| `typertGateway` | `@deepseek-ai/dsh-api-gateway` | ❌ 由 dsh-base 顶层 id `typert-gateway` 提供 |
| `credentials` | `@deepseek-ai/dsh-credentials-local` | ❌ 由 dsh-base 顶层 id `credentials` 提供 |
| `tools`, `systemPrompt` | dsh-base | ❌ |

dsh-im 的 plugin-level `inject` 列出 `connection / credentials / apiProxy / typertGateway`——本 patch 已**通过 `dsh-host-webserver` 顶层 configOverride 间接提供前两个**；后两个由 dsh-base 在加载时已挂。

---

## 5. http-api v1 接口规范

### 5.1 公开端点（无 Bearer 鉴权）

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/v1/health` | 存活探针；返回 `{ "status": "ok" }` |
| `GET` | `/v1/openapi.json` | OpenAPI 3.0 spec（由路由表自动生成） |
| `OPTIONS` | `/v1/health`、`/v1/openapi.json` | 预检 204（无 CORS 头） |

### 5.2 Chat 端点（Bearer 鉴权）

| 方法 | 路径 | Body | Response |
|---|---|---|---|
| `POST` | `/v1/chat` | `{ message, sessionId? }` | 同步：返回最终文本 + intent 元数据 |
| `POST` | `/v1/chat/stream` | `{ message, sessionId? }` | SSE：`intent` → `text` chunks → `done`，**15s `: keepalive <ts>` 心跳** |

### 5.3 Session 端点（Bearer 鉴权）

| 方法 | 路径 | Body | Response |
|---|---|---|---|
| `GET` | `/v1/sessions` | — | `{ sessions: [...] }` |
| `GET` | `/v1/sessions/{id}` | — | `{ sessionId, createdAt, lastAccessedAt }` |
| `POST` | `/v1/sessions/{id}/cancel` | — | `202 { sessionId, canceled, status }` |
| `POST` | `/v1/sessions/{id}/rename` | `{ title }` | `200 { sessionId, title }` |
| `POST` | `/v1/sessions/{id}/fork` | `{ atMessageIndex?, newSessionId? }` | `201 { sessionId, sourceSessionId }` |
| `DELETE` | `/v1/sessions/{id}` | — | `204` |

### 5.4 元数据端点（Bearer 鉴权）

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/v1/models` | 返回 `{ models: [{ provider, realm, available }] }` |
| `GET` | `/v1/audit` | 查询审计日志，支持 `since` / `until` / `kind` / `level` / `sessionId` / `limit`（默认 50，硬上限 500） |

### 5.5 OpenAPI spec

`GET /v1/openapi.json` 返回由路由表自动派生的 OpenAPI 3.0 spec。每个路由的 `summary` 字段来自 `RouteDef.summary`，请求体和详细响应描述由 `http-api.ts` 内的 `pathExtras` 表附加。

**单一来源原则**：spec 由 `routes` 字段生成；新增端点只需在 `buildRoutes()` 中加一行。

---

## 6. 错误模型

| 状态码 | 触发条件 |
|---|---|
| `400` | message 缺失 / body 不是合法 JSON / rename title 缺失或 > 200 字符 / audit filter 参数非法 |
| `401` | Bearer token 缺失或不匹配 |
| `403` | intent-router REJECT（privacy-policy 规则命中） |
| `404` | 会话 / 资源不存在 |
| `413` | 请求体超过 `maxRequestBodyBytes`（默认 1 MiB；socket 被销毁阻止后续流） |
| `500` | 内部异常 |
| `503` | td-bus 威胁等级 elevated |

SSE 流的错误：流开始前同 REST；流开始后**写入失败**会触发 `req.on('close')` 清理并安全终止流（无法改 header，只能 `res.end()`）。

---

## 7. 安全约束

### 7.1 不开 CORS（v1）

- **v1 schema 不暴露** `enableCors` 字段。即便 operator 设 `DSH_EDGE_HTTP_CORS=true`，config 解析也会忽略。
- **v2 启用条件**（必须全部满足）：(a) origin allowlist 环境变量；(b) preflight OPTIONS handler；(c) `Vary: Origin` 响应头。

### 7.2 SSE keepalive

- 每 15s 写入 `: keepalive <unix-ms>\n\n` 注释帧（SSE 注释，客户端不解析）
- 客户端断开 → `req.on('close')` → 清理 `session/event` 订阅 + clearInterval

### 7.3 Body cap

- 默认 1 MiB；`maxRequestBodyBytes = 0` 关闭（**不推荐生产**）
- 超限时 `req.destroy(err)` 关闭 socket（防止攻击者继续流式发送）
- 错误带 `statusCode = 413`，由 dispatcher 转 413

### 7.4 Bearer token 必须从环境变量注入

- 配置文件**不硬编码** Bearer token
- 推荐：使用 secret manager 注入 `EDGE_API_KEY`
- v1 不支持 token rotation / multiple tokens（v2 引入时另起 RFC）

---

## 8. 配置项

http-api 的 Config 字段（`src/dsh-adapter/http-api.ts`）：

| 字段 | 默认 | 用途 |
|---|---|---|
| `host` | `127.0.0.1` | 监听地址 |
| `port` | `21017` | 监听端口 |
| `bearerToken` | undefined（`EDGE_API_KEY` 环境变量） | 鉴权 token；空则不鉴权 |
| `sessionIdleTimeoutMs` | `1800000` (30 min) | 空闲会话回收；0 禁用 |
| `maxActiveSessions` | `100` | LRU 上限；0 无限 |
| `maxRequestBodyBytes` | `1048576` (1 MiB) | Body cap；0 禁用 |

**`requireAttestation` 字段已删除**（2026-08-29）— 它曾被声明但从未读取，对 operator 是安全谎言。attestation 是 A5 阶段工作，届时再重新引入字段 + 接入真实检查。

---

## 9. 与 dsh-web-ui 全家桶的关系

### 9.1 默认 disable

`cordis.patch.yml` 中以下 id 默认 `disabled: true`：

- `dsh-web-app`
- `dsh-web-frontend`
- `@linxin666/dsh-web-ui-all`（task-board / git-graph / pet / skin-center）
- `web-search` / `voice-input` / `dsh-edge-agent`（aggregator）

**仅启用**：`dsh-host-webserver`（DSH 上游 webui 最小集；并同时为 dsh-im 提供 connection/apiProxy）+ dsh-im（plugin 声明在 `insert:` 段）。

### 9.2 SPA / IM 通过 apiproxy 调 agent-loop，**不调 http-api**

DSH 上游 SPA 的 chat RPC（`sessions.prompt` / `sessions.list` / `sessions.cancel` / `sessions.fork` / `sessions.rename`）走 `dsh-host-apiproxy`，**绝不**绕道 http-api。dsh-im 也走相同的 apiproxy——这是它能"零成本"获得 input-guard 覆盖的关键。这样：

- DSH 上游合约保持原样
- input-guard 的全局 hook 自动覆盖 SPA + IM 路径（apiproxy → agent-loop）
- http-api 不需要承担 webui 兼容层

### 9.3 启用 webui 全家桶的代价

若未来启用 `@linxin666/dsh-web-ui-all`，需检查其 cordis patch 内部是否挂载 `sessions` 插件（已知风险 §10.1）。启用前**必须**：

1. grep bundle 内 `sessions` 配置
2. 确认 root 不覆盖我们的 `~/.dsh-edge-agent/sessions/`
3. 必要时调整 `cordis.patch.yml` 顺序

---

## 10. 已知冲突与未解决问题

### 10.1 sessions 插件被 webui bundle 覆盖的风险

**风险**：`@linxin666/dsh-web-ui-all/cordis.patch.yml:58-66` 会再 mount `session-persistence-jsonl` 指向 `dshHomePath('sessions')`，可能覆盖我们的 root（Cordis "最后 mount 胜出" 语义）。

**缓解**：
- v1 保持 `@linxin666/dsh-web-ui-all` 默认 disabled
- 启用 webui 全家桶前先 grep bundle 内 `sessions` 配置
- 长期：把 `sessions` 挂载从 `insert:` 段提到顶层 `configOverrides` 段（合并为一行），降低被覆盖概率。**不在 v1 范围**（会触发 patch-surface 重生成）。

### 10.2 apiproxy 不在控制范围

**风险**：`dsh-host-apiproxy` 是 DSH 上游，apiproxy 的 RPC 接口（`sessions.list / prompt / cancel / fork / rename` 等）是 DSH 合约。上游变更字段命名 webui 立刻断裂。

**缓解**：
- 不修改 apiproxy 行为
- input-guard 是我们与上游之间的**安全合约层**——即便 apiproxy 改变，输入/输出 hook 仍然保护隐私管线
- 升级 DSH 时验证 apiproxy 行为

### 10.3 requireAttestation 字段已删除

**状态**：v1 schema 中已删除该字段。`cordis.patch.yml` 中 `requireAttestation: false` 已替换为注释。

**未来**：attestation 是 A5 阶段工作；届时重新引入字段并接入真实检查，**单独 RFC**。

### 10.4 dsh-im 凭据存储与公网回流风险

**风险**：
- dsh-im 把 9 大 IM 平台 + AI Office 的 bot credentials / Device Token **只写入 `dsh-credentials-local` 受保护本地凭据存储**，配置文件不落盘——这是 dsh-im 自身的契约（[README §安装](https://github.com/xmanrui/dsh-im)）。
- AI Office Connector 让本机 Harness **主动**连接公网 Office（`POST /api/harness/connector/heartbeat` + `GET /api/harness/connector/stream` SSE 下行）。**不需要**本机公网 IP / 端口转发 / 反向代理；它通过 90 秒租约 + 30 秒续租保持长连。
- SSE 下行的 `text-delta` / 状态更新 / 工具执行结果会回到公网 Office——**但只回 desensitize 后的内容**（脱敏在 input-guard `llm/stream` hook 之后）。

**缓解**：
- v1.1 起要求**默认关闭** dsh-im 的 `office` 通道（用户在 webui 开关），默认只启用用户主动配置的 IM 通道。
- AI Office Connector 启用前需明确告知用户「状态 + 工具名 + 增量文本会到公网 Office」，UI 弹出 opt-in 对话框（v1.1 UI 工作）。
- 如果未来需要把 IM 渠道结果**禁止**回某 IM 平台（例如：飞书群聊里讨论隐私问题，希望群消息不回 IM），需要 input-guard 加一个 per-channel allowlist——v1 不实现。

### 10.5 dsh-im 的 apiProxy 依赖耦合

**风险**：dsh-im `inject` 列出 `connection / apiProxy / typertGateway`，这些服务由 `dsh-host-webserver` 和 dsh-base 提供。**如果未来禁用 webserver，dsh-im 自动失效**——这是预期的（dsh-im 本身就是 webui 的 transport 变体），但需要在 profile 文档明示。

**缓解**：
- `cordis.patch.yml` 中 `dsh-host-webserver` 不在 disables 列表（这是 M4 已确定的选择）
- dsh-im 不在 `disabled: true` 之列；它随 webserver 启用 / 禁用而隐式联动
- 用户禁用 dsh-im 时只需在 webui 「设置 → IM机器人」关闭各 channel；插件本身不卸载（保持 QR / bot 配置持久）

---

## 11. 路线图

### v1.1（本文档 — 已实施 2026-08-29）

- 双入口：dsh-webui (:21018) / http-api (:21017)，13 个 must-have 项（见 plan §3.1）
- 三入口扩展：dsh-im 挂入 `insert:` 段，复用 webserver 的 apiProxy
- 无 CORS、无 UI、无工具/技能/文件端点
- `input-guard` 是多入口统一防护的基石
- `patch-surface` snapshot 不变（`inserts=0, 6 configOverrides, 7 disables`）

### v1.2

- CORS（必须配 origin allowlist）
- `/v1/tools/{list,invoke}` 端点
- `/v1/skills/{list,load}` 端点
- `/v1/files/{read,write}`（受限）
- dsh-im AI Office opt-in UI 对话框
- IM channel 关闭时 per-channel allowlist（§10.4 缓解 3）

### v2

- WebSocket 升级 SSE
- 请求签名（HMAC over body）
- token rotation / multiple tokens
- 可选 GraphQL 适配层

---

## 12. 引用

- [input-guard-design.md](./intent-and-sanitization.md) — input-guard 编排器设计（多入口统一防护的依赖）
- [architecture.md](architecture.md) — 整体架构
- [#第2章--221-插件职责依赖关系启动顺序](#第2章--221-插件职责依赖关系启动顺序) — Cordis 插件机制
- [#第9章--设计基线完整设计方案235-kb-主基线](#第9章--设计基线完整设计方案235-kb-主基线) — v6 设计文档
- `src/dsh-adapter/http-api.ts` — http-api 主插件
- `src/dsh-adapter/http-api-routes.ts` — 路由表
- `src/dsh-adapter/http-api-sessions.ts` — sessions 软依赖包装
- `src/dsh-adapter/input-guard.ts` — 双入口统一防护编排器
- `src/dsh-adapter/model-router.ts` — `listDetailed()` 实现
- `src/dsh-adapter/audit-log.ts` — `query()` 实现
- `profiles/dsh-edge-agent/cordis.patch.yml` — DSH 配置 patch


---


# 第4章 DSH 上游适配契约（升级时阅读）

> 来源：`02-architecture/#第4章--dsh-上游适配契约升级时阅读`

# 上游适配契约（ADAPTER）

> 本文档描述 dsh-edge-agent 与上游 DSH (DeepSeek Harness) 的版本与边界合约。

## 🎯 目的

`dsh-edge-agent` 严格隔离上游 DSH API，确保：

1. **升级可控**：DSH rc 版本升级时只影响一处（`src/dsh-adapter/`）
2. **边界可验证**：通过 `verify-adapter-boundary.ts` 在 CI 中强制检查
3. **类型可追溯**：所有上游类型从 `src/dsh-adapter/types.ts` 单一来源导出
4. **版本可锁定**：通过 `UPSTREAM_VALIDATED_VERSION` 锁定已验证的 DSH 版本线

## 📐 边界规则

### 1. 唯一允许 `@deepseek-ai/*` 的目录

```sh
src/dsh-adapter/    ✅ 允许
src/dsh-adapter/*    ✅ 允许（所有子文件）
src/<其他>.ts        ❌ 禁止
src/<子目录>/        ❌ 禁止
```

**违反后果**：CI 中 `pnpm run verify:boundary` 失败。

### 2. 类型导入必须经过 types.ts

```typescript
// ✅ 正确
import type { Context, Service } from './dsh-adapter/types.js'

// ❌ 错误
import { Context } from '@deepseek-ai/cordis'
```

**理由**：
- 集中上游类型 re-export，便于升级
- 减少 `@deepseek-ai/*` 直接依赖数量
- 加快 TypeScript 编译速度

### 3. 运行时导入必须经过 services

```typescript
// ✅ 正确（在 dsh-adapter 内）
const tcm = ctx.tcm
const llm = ctx.llm
const sessions = ctx.sessions

// ❌ 错误（直接调用上游 SDK）
import { Context } from '@deepseek-ai/cordis'
const ctx = new Context()
```

**理由**：
- 上游 SDK 可能在版本升级时改变 API
- dsh-edge-agent 通过 `interface Context` 增强类型提供稳定门面

### 4. Service 通过 `declare module` 扩展

```typescript
// src/dsh-adapter/tcm.ts
import { Service } from '@deepseek-ai/cordis'

export class TcmService extends Service {
  // ...
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tcm: TcmService
  }
}
```

**理由**：
- 类型合并让 `ctx.tcm` 在所有文件中可用
- 不需要 `as any` 强制转换

## 📦 已验证的版本线

```typescript
// src/dsh-adapter/contract.ts
export const UPSTREAM_VALIDATED_VERSION = '0.1.2-rc.1'

export const UPSTREAM_FRAMEWORK_MAJORS = {
  '@deepseek-ai/cordis': '^4.0.1',
  '@deepseek-ai/schemastery': '^3.18.1',
} as const

export const UPSTREAM_BLESSED_PACKAGES = [
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-events',
  '@deepseek-ai/dsh-scope',
  '@deepseek-ai/dsh-scope-disk',
] as const
```

**为什么是 `0.1.2-rc.1`？**

1. **DSH 团队已发布**：经过 DeepSeek Harness 团队验证的稳定预发布版本
2. **与 dsh-TUI 对齐**：确保生态兼容性
3. **schema 稳定**：所有必需的服务接口已稳定

## 🔍 验证脚本

### `verify:boundary`

```sh
node --import tsx/esm scripts/verify-adapter-boundary.ts
```

扫描所有 `src/**/*.ts`，确保 `@deepseek-ai/*` 只在 `src/dsh-adapter/` 内出现。

### `verify:contract`

```sh
node --import tsx/esm scripts/verify-upstream-contract.ts
```

读取 `package.json` 中的 `@deepseek-ai/*` 版本，与 `UPSTREAM_FRAMEWORK_MAJORS` 比对。不匹配时失败。

### `verify:build`

```sh
pnpm run verify:build
# = verify:boundary
# + verify:contract
# + verify:patch-surface
# + verify:plugin-spec
# + verify:package
```

串联所有验证脚本，CI 必须全部通过。

## 📈 升级流程

当 DSH 发布新版本（如 `0.1.0`）时：

### Step 1: 更新 `UPSTREAM_VALIDATED_VERSION`

```typescript
// src/dsh-adapter/contract.ts
-export const UPSTREAM_VALIDATED_VERSION = '0.1.2-rc.1'
+export const UPSTREAM_VALIDATED_VERSION = '0.1.0'
```

### Step 2: 更新 `package.json`

```json
{
  "devDependencies": {
    "@deepseek-ai/dsh-agent": "^0.1.0",
    "@deepseek-ai/dsh-llm": "^0.1.0",
    ...
  }
}
```

### Step 3: 运行 `pnpm install`

### Step 4: 修复破坏性变更

```sh
pnpm run compile
```

根据 TypeScript 错误逐个修复（应该都在 `src/dsh-adapter/` 内）。

### Step 5: 运行所有验证

```sh
pnpm run verify:build
pnpm test
```

### Step 6: 升级 patch-surface.snapshot

```sh
node --import tsx/esm scripts/verify-patch-surface.ts --snapshot
```

### Step 7: 更新测试和文档

确保所有测试通过，文档反映新版本。

### Step 8: 提交

```sh
git commit -m "chore: upgrade DSH to 0.1.0"
git tag v0.X.0
```

## 🛡️ Invariant Companion

dsh-edge-agent 提供一个 invariant companion 插件：

```typescript
// src/dsh-adapter/invariant.ts
export const name = 'dsh-edge-agent-invariant'

export const inject = ['invariants'] as const

export interface Config {
  // no config
}

export const Config: Schema<Config> = Schema.object({})

export async function apply(ctx: Context, config: Config): Promise<void> {
  // 检查关键不变量：
  // 1. ctx.tcm 已注册
  // 2. ctx.localStorage 已注册
  // 3. ctx.privacyPolicy 已加载
  // 4. ctx.auditLog 已启用

  ctx.effect(() => {
    if (!ctx.tcm) throw new Error('invariant: tcm must be mounted')
    if (!ctx.localStorage) throw new Error('invariant: local-storage must be mounted')
    if (!ctx.privacyPolicy) throw new Error('invariant: privacy-policy must be mounted')
    if (!ctx.auditLog) throw new Error('invariant: audit-log must be mounted')
  })

  return async () => {}
}
```

**作用**：
- 在所有关键插件挂载完成后运行
- 断言核心不变量已建立
- 失败时阻止 agent loop 启动

## 📚 相关文件

- `src/dsh-adapter/contract.ts` — 上游版本合约
- `src/dsh-adapter/types.ts` — 上游类型 re-export
- `src/dsh-adapter/invariant.ts` — 不变量 companion
- `src/dsh-adapter/index.ts` — 主插件
- `src/dsh-adapter/plugin.ts` — 主插件运行时
- `scripts/verify-adapter-boundary.ts` — 边界检查
- `scripts/verify-upstream-contract.ts` — 版本线校验

---


# 第5章 DSH 原生工具复用决策（为何不自己实现）

> 来源：`02-architecture/#第5章--dsh-原生工具复用决策为何不自己实现`

# DSH 原生工具复用分析

> 生成时间: 2026-08-21  
> 分析 DSH 已提供的工具与 dsh-edge-agent 当前实现的重叠

---

## 0. 结论摘要

**DSH 已经提供了完整的工具集,dsh-edge-agent 应该直接复用,而不是重新实现。**

| 功能 | DSH 原生包 | dsh-edge-agent 当前实现 | 建议 |
|------|-----------|------------------------|------|
| **Bash 执行** | `@deepseek-ai/dsh-tool-bash` ✅ | 无(通过 local-tools 间接实现) | ✅ **直接用 DSH** |
| **文件读写** | `@deepseek-ai/dsh-tool-fs` ✅ | `local-tools.ts` 的 local_file_read/write | ✅ **直接用 DSH** |
| **数学计算** | DSH bash 工具可执行 | `local-tools.ts` 的 local_calculate | ⚠️ **可保留或移除**(DSH bash 更强) |
| **Web 搜索** | `@deepseek-ai/dsh-tool-web` + `dsh-web-search-deepseek` ✅ | `web-search.ts`(stub,返回空) | ✅ **直接用 DSH** |
| **Web 抓取** | `@deepseek-ai/dsh-tool-web` ✅ | 无 | ✅ **直接用 DSH** |

---

## 1. DSH 原生工具详解

### 1.1 Bash 工具 (`@deepseek-ai/dsh-tool-bash`)

**已提供的功能**:
- ✅ 完整的 bash 命令执行(`bash -c`)
- ✅ 工作目录管理(`workdir`,基于会话 cwd)
- ✅ 超时控制(`timeoutMs`)
- ✅ 后台执行(`run_in_background`,通过 `ctx.jobs`)
- ✅ 沙箱模式(`workspace-write` / `danger-full-access`)
- ✅ 权限升权(`ctx.approval`)
- ✅ 输出截断和 spill 文件
- ✅ 退出码、信号、超时标记
- ✅ 环境变量管理(`DSH_*` 托管变量)
- ✅ Job 管理(`job_output`, `job_list`, `job_kill`)

**安全特性**:
- 沙箱限制(Landlock/Windows ACL)
- 逐会话 cwd 隔离
- 环境变量清理(移除凭据和陈旧 `DSH_*`)
- 权限升权需要用户批准

**与 dsh-edge-agent 的关系**:
- ❌ **dsh-edge-agent 没有自己的 bash 实现**
- ✅ 当前测试中使用的 `bash` 工具就是 DSH 原生的
- ✅ 可以直接使用,无需任何修改

---

### 1.2 文件系统工具 (`@deepseek-ai/dsh-tool-fs`)

**已提供的功能**:
- ✅ `read` — 带行号的文件读取,分页支持
- ✅ `write` — 创建/覆盖文件
- ✅ `edit` — 字面量替换编辑
- ✅ `read_image` — 图像文件读取(PNG/JPEG/WebP/GIF)
- ✅ 流式读取(大文件)
- ✅ 读取窗口逻辑(`offset`, `limit`)
- ✅ 观察策略插件(`dsh-fs-observation-policy`)
- ✅ 沙箱限制和权限升权

**安全特性**:
- 路径解析基于会话 cwd
- 写入前需要观察(`fs/observed` 事件)
- 版本控制(防止并发冲突)
- 沙箱模式支持
- 文件大小限制(`readMaxBytes`, `readStreamMinSize`)

**与 dsh-edge-agent 的关系**:
- ⚠️ **dsh-edge-agent 的 `local_file_read`/`local_file_write` 是重复实现**
- ❌ 缺少 DSH 的编辑、图像读取、流式读取等功能
- ❌ 缺少观察策略和版本控制
- ✅ 应该用 DSH 的 `read`/`write`/`edit` 替代

---

### 1.3 Web 工具 (`@deepseek-ai/dsh-tool-web`)

**已提供的功能**:
- ✅ `web_search` — Web 搜索,返回答案和来源 URL
- ✅ `web_fetch` — 获取特定 URL,HTML→Markdown 渲染
- ✅ 结果数量上限(`searchMaxResults`,默认 8)
- ✅ 超时控制(`fetchTimeoutMs`, `searchTimeoutMs`)
- ✅ 输出大小限制(`fetchMaxOutputChars`,默认 200,000)
- ✅ UI 呈现卡片(`presentCall`, `presentResult`)
- ✅ 结构化错误处理(`WebError`)

**搜索提供者**:
- `@deepseek-ai/dsh-web-search-deepseek` — DeepSeek 的 Anthropic 兼容 API
- 调用 `POST {baseURL}/messages` 启用 `web_search_20250305` 服务器工具
- 解析 `web_search_tool_result` 块
- 去重、截断、来源关联

**与 dsh-edge-agent 的关系**:
- ⚠️ **dsh-edge-agent 的 `web-search.ts` 是 stub,返回空数组**
- ❌ 缺少实际的搜索实现
- ✅ 应该直接用 DSH 的 `web_search` 和 `web_fetch`

---

## 2. dsh-edge-agent 当前实现的问题

### 2.1 local-tools.ts — 重复造轮子

**当前实现**:
```typescript
// 3 个工具
local_file_read  → 读取文件
local_file_write → 写入文件
local_calculate  → 纯数学计算
```

**问题**:
1. **与 DSH 工具重叠** — DSH 已经有 `read`/`write`/`edit` 工具,功能更完整
2. **缺少高级功能**:
   - ❌ 没有编辑工具(`edit`)
   - ❌ 没有图像读取(`read_image`)
   - ❌ 没有流式读取
   - ❌ 没有观察策略(版本控制)
   - ❌ 没有沙箱限制
3. **Realm 标记是唯一的额外价值** — 但这可以通过配置 DSH 工具实现

**allowList 控制**:
- 当前实现有 `allowList` 白名单
- DSH 工具通过 `ctx.fs.resolve()` 和沙箱模式实现类似功能
- 可以通过配置 DSH 的沙箱策略达到相同效果

---

### 2.2 web-search.ts — Stub 实现

**当前实现**:
```typescript
async search(query: string, options?: { maxResults?: number }): Promise<WebSearchResult[]> {
  void query
  void options
  return []  // ← stub,没有实际搜索
}
```

**问题**:
1. **完全不可用** — 返回空数组,无法执行搜索
2. **DSH 已有完整实现** — `dsh-tool-web` + `dsh-web-search-deepseek` 提供了生产级搜索
3. **重复配置** — 当前配置 `backend: 'duckduckgo' | 'brave' | 'custom'` 都没有实现

**正确的做法**:
- 直接使用 DSH 的 `web_search` 和 `web_fetch` 工具
- 通过 `ctx.web` seam 自动选择提供者
- 配置 `dsh-web-search-deepseek` 的 API key 和端点

---

## 3. 推荐的改进方案

### 3.1 短期(立即可做)

#### ✅ 删除 local-tools.ts,使用 DSH 原生工具

**修改 cordis.yml**:
```yaml
# 移除 local-tools 插件
# - id: local-tools
#   name: '@deepseek-harness-edge-agent/dsh-edge-agent/local-tools'

# 确保 DSH 工具已加载
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
  config:
    readLimit: 2000
    readMaxBytes: 51200
- id: fs-local
  name: '@deepseek-ai/dsh-fs-local'
  config:
    cwd: /home/etsme/cy/agent/dsh-edge-agent
```

**好处**:
- ✅ 立即获得完整的文件系统工具(read/write/edit/read_image)
- ✅ 获得 bash 工具和 job 管理
- ✅ 减少维护成本
- ✅ 与 DSH 生态保持一致

#### ✅ 删除 web-search.ts,使用 DSH 原生工具

**修改 cordis.yml**:
```yaml
# 移除 web-search 插件
# - id: web-search
#   name: '@deepseek-harness-edge-agent/dsh-edge-agent/web-search'

# 加载 DSH web 工具
- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
  config:
    search: true
    fetch: true
    searchMaxResults: 8
    fetchTimeoutMs: 30000

- id: web-search-deepseek
  name: '@deepseek-ai/dsh-web-search-deepseek'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
    baseURL: https://api.deepseek.com/anthropic/v1
```

**好处**:
- ✅ 立即获得可用的 web 搜索
- ✅ 获得 web_fetch(URL 抓取)
- ✅ 使用 DeepSeek 的原生搜索能力
- ✅ 结构化搜索结果(URL、标题、snippet、引用)

---

### 3.2 中期(需要少量开发)

#### 🔧 为 DSH 工具添加 Realm 标记

**问题**: DSH 工具没有 LOCAL/CLOUD realm 概念

**解决方案**: 通过 Cordis 的 waterfall/middleware 机制注入

```typescript
// 创建新插件: realm-marker
export const name = 'realm-marker'
export const inject = ['tools', 'edgeTools'] as const

export async function apply(ctx: Context, config: Config) {
  // 监听工具注册,标记 realm
  ctx.on('tool/registered', (tool) => {
    if (['read', 'write', 'edit', 'bash'].includes(tool.name)) {
      ctx.edgeTools.setRealm(tool.name, 'LOCAL')
    }
    if (['web_search', 'web_fetch'].includes(tool.name)) {
      ctx.edgeTools.setRealm(tool.name, 'CLOUD')
    }
  })
}
```

**或者更简单**: 在 intent-router 中根据工具名称推断 realm

```typescript
// intent-router.ts 中
function getToolRealm(toolName: string): Realm {
  const localTools = ['read', 'write', 'edit', 'bash', 'local_calculate']
  const cloudTools = ['web_search', 'web_fetch']
  
  if (localTools.includes(toolName)) return 'LOCAL'
  if (cloudTools.includes(toolName)) return 'CLOUD'
  return 'SANITIZED'
}
```

---

#### 🔧 为 DSH 工具添加 allowList 控制

**问题**: DSH 工具使用沙箱模式,但没有 allowList 概念

**解决方案 1**: 使用 DSH 的沙箱配置

```yaml
- id: fs-local
  name: '@deepseek-ai/dsh-fs-local'
  config:
    cwd: /home/etsme/cy/agent/dsh-edge-agent
    # 通过沙箱策略限制访问范围
    sandboxMode: workspace-write
```

**解决方案 2**: 创建中间件拦截工具调用

```typescript
// allowlist-guard.ts
export const name = 'allowlist-guard'
export const inject = ['tools', 'edgeTools'] as const

export async function apply(ctx: Context, config: Config) {
  ctx.before('tool/execute', async (toolName, args) => {
    if (['read', 'write', 'edit'].includes(toolName)) {
      const path = args.file_path
      if (!isUnderAllowList(path, config.allowList)) {
        throw new Error(`Path ${path} not in allowList`)
      }
    }
  })
}
```

---

#### 🔧 集成 privacy-policy 和 audit-log

**问题**: DSH 工具没有隐私策略和审计集成

**解决方案**: 通过事件监听

```typescript
// privacy-audit-bridge.ts
export const name = 'privacy-audit-bridge'
export const inject = ['tools', 'privacyPolicy', 'auditLog'] as const

export async function apply(ctx: Context) {
  // 监听工具调用
  ctx.on('tool/executed', async (toolName, args, result) => {
    // 审计日志
    await ctx.auditLog.log({
      level: 'info',
      kind: 'tool.executed',
      source: toolName,
      payload: { args, resultLen: JSON.stringify(result).length }
    })
    
    // 隐私策略检查(异步,不阻塞)
    if (['web_search', 'web_fetch'].includes(toolName)) {
      await ctx.privacyPolicy.checkOutbound(args)
    }
  })
}
```

---

### 3.3 长期(架构优化)

#### 🎯 统一工具注册机制

**当前问题**: `ctx.tools` 和 `ctx.edgeTools` 两套注册机制

**建议**: 全部使用 `ctx.tools`,删除 `ctx.edgeTools`

```typescript
// 删除 tools.ts 中的 edgeTools 扩展
// 只在 DSH 的 ctx.tools 上添加 realm 元数据

ctx.tools.register({
  name: 'web_search',
  metadata: { realm: 'CLOUD' }  // ← 通过 metadata 传递 realm
}, handler)
```

---

#### 🎯 创建 Edge 工具配置层

**目标**: 让 DSH 工具感知 Edge 的安全需求

```typescript
// edge-tool-config.ts
export const name = 'edge-tool-config'
export const inject = ['tools', 'localStorage', 'privacyPolicy', 'secureBridge'] as const

export async function apply(ctx: Context) {
  // 配置 DSH 工具使用 Edge 的安全服务
  
  // 1. 文件系统工具使用加密存储
  ctx.configure('tool-fs', {
    storageBackend: ctx.localStorage  // ← 替换默认存储
  })
  
  // 2. Web 工具使用 secure-bridge
  ctx.configure('tool-web', {
    httpClient: ctx.secureBridge  // ← 替换默认 HTTP 客户端
  })
  
  // 3. Bash 工具使用 TEE 密钥
  ctx.configure('tool-bash', {
    envProvider: () => ({
      TEE_KEY: ctx.tcm.getKey('bash-env')
    })
  })
}
```

---

## 4. 迁移路线图

### Phase 1: 立即复用 DSH 工具 (1-2 天)

- [ ] 删除 `local-tools.ts` 插件
- [ ] 删除 `web-search.ts` 插件
- [ ] 更新 `cordis.yml` 加载 DSH 原生工具
- [ ] 配置 `dsh-web-search-deepseek` 的 API key
- [ ] 测试验证:
  - [ ] `read`/`write`/`edit` 工具正常工作
  - [ ] `bash` 工具正常工作
  - [ ] `web_search` 返回真实搜索结果
  - [ ] `web_fetch` 抓取 URL 成功

### Phase 2: 添加 Edge 安全层 (3-5 天)

- [ ] 创建 `realm-marker` 插件,标记工具 realm
- [ ] 创建 `allowlist-guard` 插件,拦截工具调用
- [ ] 创建 `privacy-audit-bridge` 插件,集成隐私策略和审计
- [ ] 更新 `intent-router` 根据 realm 路由请求

### Phase 3: 深度集成 (1-2 周)

- [ ] 配置 DSH 工具使用 `localStorage`(加密存储)
- [ ] 配置 DSH 工具使用 `secureBridge`(OHTTP)
- [ ] 创建 Edge 专属的工具配置层
- [ ] 完善隐私策略引擎与工具执行的集成

---

## 5. 成本收益分析

### 当前方案(重复实现)

**成本**:
- 🔴 维护 2 个插件(local-tools, web-search)
- 🔴 功能不完整(缺少 edit、image、stream、search)
- 🔴 与 DSH 生态脱节
- 🔴 需要自己处理沙箱、超时、错误

**收益**:
- 🟢 完全控制(但实际上 DSH 工具已经可配置)
- 🟢 Realm 标记(但可以通过配置实现)

### 推荐方案(复用 DSH)

**成本**:
- 🟡 需要添加少量 Edge 专属逻辑(realm、allowlist)
- 🟡 需要理解 DSH 工具的配置机制

**收益**:
- 🟢 立即获得完整功能(bash、fs、web_search、web_fetch)
- 🟢 减少维护成本(删除 2 个插件)
- 🟢 与 DSH 生态保持一致
- 🟢 自动获得 DSH 的更新和改进
- 🟢 更好的安全性(DSH 工具经过更严格的测试)

---

## 6. 总结

**你的质疑完全正确** — dsh-edge-agent 不应该重新实现 DSH 已经提供的工具。

### 核心观点

1. **DSH 工具已经非常完整** — bash、fs、web 工具都经过生产验证
2. **重复实现是浪费** — local-tools 和 web-search 的功能 DSH 都有
3. **Edge 的额外需求可以通过配置/中间件实现** — realm、allowlist、privacy、audit
4. **应该站在巨人的肩膀上** — 复用 DSH 工具,专注于 Edge 的独特价值(TEE、OHTTP、隐私策略)

### 立即行动

1. ✅ 删除 `local-tools.ts` 和 `web-search.ts`
2. ✅ 更新 `cordis.yml` 加载 DSH 原生工具
3. ✅ 配置 `dsh-web-search-deepseek` 使用 DEEPSEEK_API_KEY
4. ✅ 测试验证所有工具正常工作

### 后续优化

1. 🔧 创建 `realm-marker` 插件标记工具 realm
2. 🔧 创建 `allowlist-guard` 插件控制访问范围
3. 🔧 创建 `privacy-audit-bridge` 插件集成安全和审计
4. 🔧 深度集成 Edge 安全服务(localStorage、secureBridge、tcm)

---

**最终目标**: dsh-edge-agent 应该是一个**配置层**和**安全层**,而不是工具实现层。让 DSH 负责工具,Edge 负责安全。


---


# 第6章 工具复用变更记录

> 来源：`02-architecture/tool-reuse-changes.md`

# 工具复用变更总结

> 时间: 2026-08-21  
> 变更: 删除重复工具实现,切换到 DSH 原生工具

---

## 变更概览

### 删除的文件

1. **`src/dsh-adapter/local-tools.ts`** — 本地工具实现(local_file_read/write/calculate)
2. **`src/dsh-adapter/web-search.ts`** — Web 搜索 stub(返回空数组)
3. **`src/local-tools.ts`** — 顶层 re-export
4. **`src/web-search.ts`** — 顶层 re-export

### 修改的文件

1. **`cordis.yml`** — 添加 DSH 原生工具配置
2. **`src/dsh-adapter/index.ts`** — 移除 local-tools 和 web-search 的导出
3. **`src/dsh-adapter/plugin.ts`** — 更新启动顺序注释(21→19 个插件)
4. **`src/dsh-adapter/tools.ts`** — 更新注释,移除对 local-tools 的引用
5. **`package.json`** — 移除 local-tools 和 web-search 的导出路径

---

## 新增的 DSH 原生工具配置

### cordis.yml 新增条目

```yaml
# 文件系统工具
- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
  config:
    readLimit: 2000
    readMaxBytes: 51200

# Bash 工具
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  config:
    enableRunInBackground: false

# Web 工具
- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
  config:
    search: true
    fetch: true
    searchMaxResults: 8
    fetchTimeoutMs: 30000
    searchTimeoutMs: 30000

# DeepSeek 搜索提供者
- id: web-search-deepseek
  name: '@deepseek-ai/dsh-web-search-deepseek'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
    baseURL: https://api.deepseek.com/anthropic/v1
    model: deepseek-v4-flash
```

---

## 获得的功能

### ✅ 立即获得的完整工具集

| 工具 | 来源 | 功能 |
|------|------|------|
| **bash** | `dsh-tool-bash` | Bash 执行、沙箱、后台 jobs、工作目录隔离 |
| **read** | `dsh-tool-fs` | 文件读取、行号、分页、流式读取 |
| **write** | `dsh-tool-fs` | 文件创建/覆盖、观察策略、版本控制 |
| **edit** | `dsh-tool-fs` | 字面量替换编辑、唯一匹配检查 |
| **read_image** | `dsh-tool-fs` | 图像文件读取(PNG/JPEG/WebP/GIF) |
| **web_search** | `dsh-tool-web` + `dsh-web-search-deepseek` | DeepSeek 原生搜索、结构化结果 |
| **web_fetch** | `dsh-tool-web` | URL 抓取、HTML→Markdown 渲染 |

### 🎯 相比之前实现的优势

#### Bash 工具
- ✅ 沙箱模式(workspace-write/full-access)
- ✅ 权限升权(ctx.approval)
- ✅ 后台 jobs(job_output/list/kill)
- ✅ 工作目录隔离(逐会话 cwd)
- ✅ 环境变量管理(DSH_* 托管)
- ✅ 输出截断 + spill 文件

#### 文件系统工具
- ✅ 编辑工具(edit) — 之前没有
- ✅ 图像读取(read_image) — 之前没有
- ✅ 流式读取 — 之前没有
- ✅ 观察策略(版本控制) — 之前没有
- ✅ 沙箱限制 — 之前没有

#### Web 工具
- ✅ **可用的搜索** — 之前 web-search.ts 是 stub,返回空数组
- ✅ Web 抓取(web_fetch) — 之前没有
- ✅ DeepSeek 原生搜索 — 结构化结果(URL、标题、snippet、引用)
- ✅ 去重、截断、错误处理

---

## 下一步工作

### 可选:添加 Edge 安全层

如果需要保持原有的安全特性,可以创建以下插件:

#### 1. Realm 标记插件

```typescript
// realm-marker.ts
export const name = 'realm-marker'
export const inject = ['tools', 'edgeTools'] as const

export async function apply(ctx: Context) {
  ctx.on('tool/registered', (tool) => {
    const localTools = ['read', 'write', 'edit', 'bash']
    const cloudTools = ['web_search', 'web_fetch']
    
    if (localTools.includes(tool.name)) {
      ctx.edgeTools.setRealm(tool.name, 'LOCAL')
    }
    if (cloudTools.includes(tool.name)) {
      ctx.edgeTools.setRealm(tool.name, 'CLOUD')
    }
  })
}
```

#### 2. 隐私审计桥接插件

```typescript
// privacy-audit-bridge.ts
export const name = 'privacy-audit-bridge'
export const inject = ['tools', 'privacyPolicy', 'auditLog'] as const

export async function apply(ctx: Context) {
  ctx.on('tool/executed', async (toolName, args, result) => {
    await ctx.auditLog.log({
      level: 'info',
      kind: 'tool.executed',
      source: toolName,
      payload: { args, resultLen: JSON.stringify(result).length }
    })
  })
}
```

---

## 验证测试

重新编译后,需要测试:

```bash
# 1. 测试文件工具
curl -X POST http://127.0.0.1:21017/v1/chat \
  -d '{"message":"读取 package.json 的前 10 行"}'

# 2. 测试 bash 工具
curl -X POST http://127.0.0.1:21017/v1/chat \
  -d '{"message":"执行命令: ls -la"}'

# 3. 测试 web 搜索(需要 DEEPSEEK_API_KEY)
curl -X POST http://127.0.0.1:21017/v1/chat \
  -d '{"message":"搜索最新的 AI 新闻"}'

# 4. 测试 web 抓取
curl -X POST http://127.0.0.1:21017/v1/chat \
  -d '{"message":"抓取 https://example.com 的内容"}'
```

---

## 总结

### 核心观点

✅ **DSH 原生工具已经非常完整**,dsh-edge-agent 不需要重新实现  
✅ **删除了重复代码**,减少维护成本  
✅ **立即获得完整功能**,包括之前缺失的 edit、read_image、web_fetch  
✅ **Web 搜索从 stub 变为可用** — 使用 DeepSeek 原生搜索 API  

### 架构原则

**dsh-edge-agent 应该是一个配置层和安全层,而不是工具实现层。**

- ✅ DSH 负责工具(bash、fs、web)
- ✅ Edge 负责安全(TEE、OHTTP、privacy-policy、audit-log)
- ✅ 站在巨人的肩膀上,专注于 Edge 的独特价值

---

## 相关文档

- [#第5章--dsh-原生工具复用决策为何不自己实现](#第5章--dsh-原生工具复用决策为何不自己实现) — DSH 原生工具详细分析
- [#第2章--221-插件职责依赖关系启动顺序](#第2章--221-插件职责依赖关系启动顺序) — 插件架构和 DSH 调用关系


---


# 第7章 STRIDE 威胁模型与缓解措施

> 来源：`03-privacy-and-security/#第7章--stride-威胁模型与缓解措施`

# 威胁模型

> 本文档使用 [STRIDE](https://learn.microsoft.com/en-us/azure/security/develop/threat-modeling-tool-threats) 方法论描述 dsh-edge-agent 的威胁模型。

## 🎯 信任边界

dsh-edge-agent 的信任边界如下：

```
┌─────────────────────────────────────────┐
│           信任边界（用户设备）             │
│                                         │
│   ┌──────────────────────────────┐     │
│   │  dsh-edge-agent 进程          │     │
│   │   - LOCAL 域                  │     │
│   │   - SANITIZED 域              │     │
│   └──────────────────────────────┘     │
│                                         │
│   ┌──────────────────────────────┐     │
│   │  TEE（可信执行环境）           │     │
│   │   - 密钥                      │     │
│   │   - 加密原语                  │     │
│   └──────────────────────────────┘     │
│                                         │
└─────────────────┬───────────────────────┘
                  │
                  │  OHTTTP（加密 + 匿名化）
                  │
┌─────────────────┴───────────────────────┐
│        不信任（云端）                     │
│   ┌──────────────────────────────┐     │
│   │  云端 LLM                    │     │
│   │   - 看到脱敏数据              │     │
│   │   - 不知道用户身份            │     │
│   └──────────────────────────────┘     │
└─────────────────────────────────────────┘
```

**核心假设**：
- 用户设备**受信任**（前提：用户自己控制设备）
- 云端**不受信任**（可能记录一切）
- 网络路径**不受信任**（中间人可见）

## 🚨 威胁类别

### 1. Spoofing（身份伪造）

| 威胁 | 影响 | 缓解措施 |
|---|---|---|
| 攻击者伪造用户请求 | 越权访问用户数据 | TEE 远程证明 + OHTTP（云端无法关联） |
| 攻击者伪造云端响应 | 数据投毒 | TLS 证书验证 + 响应签名（待 S12 实现） |
| 攻击者伪造策略文件 | 绕过隐私控制 | 策略文件 HMAC 签名（待 S6 实现） |

### 2. Tampering（数据篡改）

| 威胁 | 影响 | 缓解措施 |
|---|---|---|
| 篡改本地存储 | 数据泄露 | AES-256-GCM 加密 + 完整性校验 |
| 篡改会话历史 | 注入恶意上下文 | 链式 HMAC 防篡改审计日志 |
| 篡改插件代码 | 任意代码执行 | dsh-adapter 边界 + 签名验证（待 S10） |
| 篡改网络流量 | 中间人攻击 | TLS + OHTTP（双层加密） |

### 3. Repudiation（否认）

| 威胁 | 影响 | 缓解措施 |
|---|---|---|
| 用户否认某次操作 | 责任归属问题 | 审计日志签名 + 不可篡改时间戳 |
| 云端否认某次响应 | 投毒溯源 | 响应签名 + 关联审计（待 S12） |

### 4. Information Disclosure（信息泄露）

| 威胁 | 影响 | 缓解措施 |
|---|---|---|
| LLM 输出泄露训练数据 | 隐私泄露 | 输出过滤 + redaction（待 S6） |
| 会话内容泄露至云端 | 上下文泄露 | Realm 路由 + 脱敏管线 |
| OHTTP 关联攻击 | 用户画像 | 双层 OHTTP + 时间扰动（待 S11） |
| 日志泄露敏感信息 | 侧信道 | 敏感字段脱敏（`DSH_EDGE_AUDIT_SENSITIVE_FIELDS`） |

### 5. Denial of Service（拒绝服务）

| 威胁 | 影响 | 缓解措施 |
|---|---|---|
| 恶意输入撑爆本地存储 | 服务不可用 | 配额管理 + 自动清理 |
| 高频云端请求 | 配额耗尽 | 速率限制 + 威胁检测 |
| 插件死循环 | 资源耗尽 | 工具超时 + loop-hygiene |
| OHTTP relay 不可用 | 云端功能失效 | TLS 回退（需显式启用） |

### 6. Elevation of Privilege（权限提升）

| 威胁 | 影响 | 缓解措施 |
|---|---|---|
| 第三方插件越权访问 | 数据泄露 | 显式 grant 机制 + 插件沙箱 |
| Realm 边界被绕过 | 数据泄漏 | intent-router 强制 + 工具隔离 |
| 配置文件被篡改 | 权限提升 | 配置文件签名（待 S10） |

## 🛡️ 缓解措施详解

### 1. TEE（可信执行环境）

**目标**：保护密钥不被提取

**实现**：
- 所有密钥（`tcm` 持有）保存在 TEE 内部
- 加密/解密操作在 TEE 内执行
- 远程证明让云端验证设备可信

**支持的 TEE**：
- ARM TrustZone（推荐用于移动设备）
- RISC-V Keystone（推荐用于 IoT）
- Intel SGX（推荐用于服务器）
- `simulated` 后端（仅用于开发）

### 2. Realm 路由

**目标**：自动选择合适的数据流向

**实现**：
- `intent-router` 根据用户输入和数据敏感度分类
- 三个 realm：LOCAL / SANITIZED / CLOUD
- 工具在注册时必须声明 realm
- Realm 不匹配的工具不可调用

### 3. PII 脱敏

**目标**：在发送至云端前替换敏感信息

**实现**：
- `sanitizer-pipeline` 检测人名、邮箱、电话、地址等
- 替换为占位符（`<NAME_1>`, `<EMAIL_1>` 等）
- 映射表加密存储在本地
- 返回结果时自动反脱敏

### 4. OHTTP（Oblivious HTTP）

**目标**：云端无法将请求与用户关联

**原理**：
- 请求在客户端用 HPKE 公钥加密
- Relay 只能看到加密的密文，无法解密
- Target 看到明文但不知道用户身份（被 relay 隔离）
- 双重加密：OHTTP + TLS

**依赖**：
- 一个 OHTTP relay（中继）
- 一个 OHTTP target（真正的服务端）

### 5. 威胁检测

**目标**：自动识别异常行为

**检测规则**：
- 短时间高频云端请求（默认 20/min）
- 连续脱敏失败（默认 3 次）
- 连续权限拒绝（默认 5 次）
- 异常时间模式（如深夜高频请求）

**响应**：
- `block-cloud`：阻断所有云端请求
- `kill-session`：终止当前会话
- `notify-user`：通知用户确认
- `lockdown`：进入锁定模式（需手动解锁）

### 6. 审计日志

**目标**：所有操作可追溯、不可篡改

**实现**：
- HMAC 链：每条记录包含前一条的 HMAC
- 任何篡改会导致链断裂
- 自动定期 flush 到加密存储
- 告警机制：当达到阈值时通知用户

## 🎯 安全等级

dsh-edge-agent 提供**三个安全等级**：

### Level 1: 基础（默认）

- 本地加密存储
- TEE 密钥保护（simulated 后端）
- 基础威胁检测
- Realm 路由

### Level 2: 增强（推荐生产）

启用：
- 真实 TEE（`DSH_EDGE_TEE_TYPE=trustzone`）
- OHTTP relay（`DSH_EDGE_BRIDGE_MODE=ohttp`）
- 远程证明（`DSH_EDGE_ATTEST_VERIFIER`）
- 完整威胁检测（`DSH_EDGE_TD_*`）

### Level 3: 最高安全（敏感场景）

在 Level 2 基础上：
- 禁用所有云端调用（`DSH_EDGE_BRIDGE_MODE=tls` + 域拒绝列表）
- 启用 TEE 推理（`DSH_EDGE_TEE_INFERENCE=true`）
- 锁定 Realm（强制 LOCAL only）
- 手动审核所有第三方插件

## 📊 残余风险

即使采取所有缓解措施，仍存在以下残余风险：

| 风险 | 描述 | 用户责任 |
|---|---|---|
| 设备物理被盗 | TEE 密钥可能被盗 | 启用设备密码 + 远程擦除 |
| 用户被钓鱼 | 用户主动泄露数据 | 教育用户 + UI 提示 |
| 云端 LLM 投毒 | 模型本身被污染 | 选择可信模型 |
| 侧信道 | 计时、功耗等 | 不在本项目范围内 |
| 社会工程学 | 操纵用户授权 | 强化 UI 警告 |

## 🔗 相关文档

- [架构设计](architecture.md#安全控制流)
- [配置参考](../README.md#-配置参考)（项目根 README）
- [插件开发](#第8章--插件开发指南规范--示例#安全最佳实践)
- [上游适配契约](#第4章--dsh-上游适配契约升级时阅读)

---


# 第8章 插件开发指南（规范 + 示例）

> 来源：`04-plugin-development/#第8章--插件开发指南规范--示例`

# 插件开发指南

dsh-edge-agent 通过 Cordis 插件机制实现可扩展性。本指南介绍如何编写新的插件。

## 📋 插件规范

每个 dsh-edge-agent 插件必须遵循以下规范：

```typescript
// src/dsh-adapter/my-plugin.ts

export const name = 'my-plugin'  // kebab-case，必须与文件名一致

export const inject = ['tcm', 'sessions'] as const  // 软依赖列表

export interface Config {
  // 配置字段
  myOption: string
}

export const Config: Schema<Config> = Schema.object({
  myOption: Schema.string().required(),
})

export async function apply(ctx: Context, config: Config): Promise<void> {
  // 1. 注册服务
  ctx.plugin(MyService)

  // 2. 订阅事件（可选）
  ctx.event.on('agent/pre-step', async (payload) => { ... })

  // 3. 注册工具（可选）
  ctx.edgeTools.register({ ... }, async (args) => { ... })

  // 4. 返回 disposer
  return async () => {
    // 清理逻辑
  }
}
```

## 🔧 创建插件的步骤

### Step 1: 在 `src/dsh-adapter/` 创建文件

```sh
touch src/dsh-adapter/my-plugin.ts
```

文件名必须与 `name` 字段一致（kebab-case）。

### Step 2: 实现插件

```typescript
// src/dsh-adapter/my-plugin.ts
import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'my-plugin'

export const inject = ['tcm'] as const

export interface Config {
  enabled: boolean
  rateLimit: number
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true),
  rateLimit: Schema.natural().default(100),
})

export interface MyService {
  doSomething(input: string): Promise<string>
}

export class MyServiceImpl extends Service {
  constructor(ctx: any) {
    super(ctx, 'myService')
  }

  async doSomething(input: string): Promise<string> {
    // 实现你的逻辑
    return `processed: ${input}`
  }
}

// 声明 ctx 扩展（可选）
declare module '@deepseek-ai/cordis' {
  interface Context {
    myService: MyServiceImpl
  }
}

export async function apply(ctx: any, config: Config): Promise<void> {
  ctx.plugin(MyServiceImpl)
  void config
  return async () => {
    // 清理逻辑
  }
}
```

### Step 3: 在 `src/` 添加 shim

```typescript
// src/my-plugin.ts
export * from './dsh-adapter/my-plugin.js'
export { default } from './dsh-adapter/my-plugin.js'
```

### Step 4: 在 `cordis.yml` 注册

```yaml
- id: my-plugin
  name: '@deepseek-harness-edge-agent/dsh-edge-agent/my-plugin'
  inject: [tcm]
  config:
    enabled: true
    rateLimit: 100
```

### Step 5: 在 `package.json` 添加 subpath export

```json
{
  "exports": {
    "./my-plugin": {
      "types": "./lib/types/my-plugin.d.ts",
      "import": "./lib/types/my-plugin.js"
    }
  }
}
```

### Step 6: 在 `patch-surface.snapshot.json` 记录

```json
{
  "inserts": ["my-plugin", ...]
}
```

## 🔐 Realm 感知

如果你的插件涉及数据处理，建议声明 realm：

```typescript
export const name = 'my-plugin'

export const inject = ['tools'] as const

export interface Config {
  realm: 'LOCAL' | 'CLOUD' | 'SANITIZED'
}

export async function apply(ctx: any, config: Config): Promise<void> {
  const tools = ctx.edgeTools
  tools.register(
    {
      name: 'my_tool',
      realm: config.realm,  // 重要：声明 realm
      description: '...',
      inputSchema: { ... },
    },
    async (args) => {
      // 工具实现
    },
  )
}
```

## 📡 事件订阅

插件可以订阅 DSH agent loop 的事件：

```typescript
export async function apply(ctx: any, config: Config): Promise<void> {
  ctx.event.on('agent/pre-step', async (payload) => {
    // 在每一步前执行
    console.log('pre-step', payload)
  })

  ctx.event.on('agent/request', async (payload) => {
    // LLM 调用前
  })

  ctx.event.on('agent/response', async (payload) => {
    // LLM 响应后
  })

  ctx.event.on('agent/post-step', async (payload) => {
    // 每一步后
  })

  return async () => {
    // 清理事件订阅
  }
}
```

## 🔌 服务注册

插件可以注册 Cordis service：

```typescript
import { Service } from '@deepseek-ai/cordis'

export class MyService extends Service {
  constructor(ctx: any) {
    super(ctx, 'myService')
  }

  // 服务方法
  async myMethod(): Promise<void> {
    // ...
  }
}

// 在 apply 中注册
export async function apply(ctx: any, config: Config): Promise<void> {
  ctx.plugin(MyService)
}
```

其他插件可以通过 `ctx.myService` 访问。

## 🧪 测试插件

```ts
// tests/unit/my-plugin.test.ts
import assert from 'node:assert/strict'
import { default as myPlugin } from '../../src/dsh-adapter/my-plugin.ts'

describe('my-plugin', () => {
  it('exports the canonical plugin shape', () => {
    assert.equal(myPlugin.name, 'my-plugin')
    assert.deepEqual([...myPlugin.inject], ['tcm'])
    assert.equal(typeof myPlugin.apply, 'function')
  })

  it('default apply returns a disposer', async () => {
    const fakeCtx = { plugin: () => undefined } as never
    const dispose = await myPlugin.apply(fakeCtx, {
      enabled: true,
      rateLimit: 100,
    })
    assert.equal(typeof dispose, 'function')
    await dispose()
  })
})
```

## 🔒 安全最佳实践

1. **最小权限**：只在 `inject` 中声明真正需要的依赖
2. **输入验证**：对所有用户输入进行验证
3. **输出过滤**：在返回前过滤敏感信息
4. **审计日志**：使用 `ctx.auditLog.log()` 记录重要操作
5. **错误处理**：不要吞掉错误，至少要记录
6. **资源清理**：在 disposer 中释放所有资源

## 📦 第三方插件

如果你的插件需要被其他项目使用，可以发布为独立包：

```json
// third-party-plugin/package.json
{
  "name": "@my-org/dsh-edge-foo",
  "version": "0.1.0",
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-harness-edge-agent/dsh-edge-agent": "^0.1.0"
  }
}
```

在用户的 `cordis.yml` 中挂载：

```yaml
- id: my-foo-plugin
  name: '@my-org/dsh-edge-foo'
  inject: [tcm, sessions]
  config: { ... }
```

启用第三方插件：
```sh
export DSH_EDGE_PLUGINS_THIRD_PARTY=true
```

## 🔗 相关文档

- [架构设计](architecture.md#插件树)
- [配置参考](../README.md#-配置参考)（项目根 README）
- [威胁模型](#第7章--stride-威胁模型与缓解措施)

---


# 第9章 设计基线：完整设计方案（235 KB 主基线）

> 来源：`07-design-baseline/#第9章--设计基线完整设计方案235-kb-主基线`

# 基于 DSH 插件机制的端侧私密智能体设计

> **合规性声明（v6.0 修订版）**：本设计**完全基于 DSH Cordis 插件机制**实现端侧智能体的所有能力，**不需要修改 DSH 核心代码**。所有 22 个核心专用插件 + 1 个可选 `http-api` 插件（§ 8.19；原文档 v6 起草时为 19 个，2026-08-27 起新增 `input-guard` / `realm-skill-bridge` / `web-search-guard`）均遵循标准的 `name` + `inject` + `Config` + `apply` 命名导出模式（参考 `packages/llm/llm-deepseek/src/index.ts:41-200`），通过 `ctx.effect` / `ctx.provide` / `ctx.llm.registerAdapter` / `ctx.tools.register` / `ctx.event.on` 等 Cordis 与 DSH 原生 API 协作；多 LLM provider 通过**在同一 `ctx.llm` 上注册多条适配器路由**（`ctx.llm.registerAdapter(['local-llm'], adapter)`）实现，**不再依赖** `cordis:group` + `isolate: { llm: true }`（`isolate` 是 per-agent 隔离机制，宿主面 `inject` 拿不到子 realm service —— 见 `packages/preset/agent-presets/src/mount.ts:178-265`）；所有事件拦截点均为 DSH Cordis 已有标准事件（`agent/pre-step` 返回 `PreStepDecision`、`agent/request` 返回 `LlmCallConfig`、`llm/stream` 输出过滤、`tools/post-execute` 工具结果检查），未引入任何 DSH 不存在的事件。
>
> 本次（v6.0）修订基于对 DSH 真实源码的逐项复核（详见 § 十一 可行性复核），修正 v5 的以下不合规点：
> 1. **LLM provider 注册**：v5 自定义 `LlmProvider { chat, chatStream }` 接口不符合 DSH `LlmAdapter { stream }` 抽象；v6.0 改为 `LlmAdapter` 子类 + `ctx.llm.registerAdapter`。
> 2. **同名 service 冲突**：v5 用 `isolate: { llm: true }` 隐藏同名 service；v6.0 在同一 `llm` service 上注册多条 provider 路由（适配器模式）。
> 3. **事件监听器契约**：v5 在 waterfall 中 `throw SecurityError`；v6.0 改为返回 `PreStepDecision` / `LlmCallConfig` 等决策对象。
> 4. **输出过滤事件点**：v5 把 LLM 输出检查挂在 `tools/post-execute`；v6.0 改为 `llm/stream` waterfall（LLM 不是 tool）。
> 5. **plugin 命名导出**：v5 仅 export `inject` + `apply`；v6.0 补齐 `name` + `Config: z<Config>`。
> 6. **service 访问约定**：v5 用 `ctx['xxx']` 字符串下标访问 service；v6.0 未在 `inject` 声明的可选 service 改为 `ctx.get('name')`。
> 7. **cordis.yml 禁用字段**：v5 用 `disable: true` / `disable: [dsh-*]`；v6.0 改为 Loader 真实字段 `disabled: true`（行级）。
> 8. **`inject: ['config']`**：DSH 无 `config` service，plugin 配置走 `apply(ctx, config)` 第二参数；v6.0 删除全部 `config` 注入项。
> 9. **Agent Loop 入口**：v5 自定义 `runAgentLoop(ctx, ...)`；v6.0 改为 `ctx.agents.create(...)` + `agent.followup(userMsg)`。
>
> **关于 DSH 对外服务能力**：DSH 内置 Runtime Profile 只有 `web`（浏览器 UI，3080 端口）和 `headless`（一次性 runner），**没有内置"对外 HTTP API 服务"形态**。如需对外提供结构化 API（如手机 APP、第三方服务调用），通过可选的 `http-api` 插件实现（§ 8.19）。
>
> **实施策略**：本设计采用**渐进式实施**（从轻到重），分 8 个阶段逐步落地。当前已完成 Phase 1（基础功能）+ Phase 2（基础安全加固）+ Phase 3（关键信息脱敏），代码与设计匹配度约 50%。详见 [§ 1.6 渐进式实施路线图](#16-渐进式实施路线图)。

## 一、设计概述

### 1.1 目标

在 DeepSeek Agent Harness (DSH) 的插件架构上，构建一个**端侧私密智能体**，实现：

- **隐私优先**：所有个人数据在端侧处理，不离开设备
- **最小暴露**：必须使用云端能力时，仅暴露脱敏后的最小必要信息
- **可验证安全**：通过 TEE + 远程证明，让用户可以验证隐私承诺 *(⏸ 后续增强,见决策 #7)*
- **零信任通信**：端云之间通过 Oblivious HTTP 通信，网关无法关联用户身份与请求内容 *(⏸ 后续增强,见决策 #7)*
- **主动防御**：威胁检测总线持续监控异常行为，自动降级或阻断

### 1.2 核心原则

1. **数据不出端**：个人数据（通讯录、日历、文件等）永远不离开设备
2. **最小权限**：每个插件只拥有完成其功能所需的最小权限
3. **纵深防御**：多层安全机制（Realm 隔离 → 脱敏 → 审计 → 威胁检测;TEE 维度后续增强）
4. **可验证**：通过远程证明，用户可以验证运行环境的安全性 *(⏸ 后续增强 — 当前依靠工程测试背书,见决策 #7)*
5. **零信任网络**：端云通信不信任任何中间节点，通过 OHTTP 实现身份-内容分离 *(⏸ 后续增强 — 当前依靠 HTTPS 传输安全,见决策 #7)*
6. **隐私策略驱动**：所有安全行为由可配置、可热更新的隐私策略引擎统一驱动

### 1.3 与通用 Agent 框架的解耦

本设计**不依赖任何内置服务**。所有存储、会话、配置、事件、工具注册等能力均由专用插件提供，可独立运行在任意 DSH 兼容环境中。

| 能力 | 提供方式 | 说明 |
|------|----------|------|
| 存储 | `local-storage` 插件 | 加密 SQLite，密钥存于 TEE |
| 会话 | `sessions` 插件 | 加密会话管理，支持过期和审计 |
| 配置 | `privacy-policy` 插件 | 可热更新的隐私策略引擎 |
| 事件 | DSH 内置事件系统 | Cordis 事件机制，支持 emit/parallel/serial/bail/waterfall 5种分发模式 |
| 工具 | `tools` 插件 | Realm 感知的工具注册中心 |
| 日志 | `audit-log` 插件 | 防篡改审计日志 |
| 认证 | `attestation` 插件 | TEE 远程证明 |
| 通信 | `secure-bridge` 插件 | OHTTP 零信任端云通道 |
| 防护 | `prompt-guard` 插件 | 输入/输出安全防护 |
| 模型 | `model-router` 插件 | 多模型智能路由 |
| 监控 | `td-bus` 插件 | 威胁检测总线 |

### 1.4 DSH 内置插件映射表

本设计与 DSH 内置插件的对应关系如下：

| 设计插件 | DSH 内置插件 | 关系 | 说明 |
|----------|--------------|------|------|
| `tcm` | - | **新增** | 可信计算模块，提供 TEE 管理和密钥服务 |
| `local-storage` | `database` | **替换** | 替换内置数据库插件，增加 AES-256-GCM 加密 |
| `sessions` | `sessions` | **替换** | 替换内置会话插件，增加加密和 Realm 隔离 |
| `audit-log` | `logger` | **替换** | 替换内置日志插件，增加防篡改和敏感字段脱敏 |
| `privacy-policy` | `config` | **替换** | 替换内置配置插件，增加策略引擎能力 |
| `tools` | `tools` | **替换** | 替换内置工具插件，增加 Realm 感知和权限检查 |
| `prompt-guard` | - | **新增** | 输入/输出安全防护，Prompt 注入检测 |
| `model-router` | - | **新增** | 多模型智能路由，健康检查 |
| `local-llm-provider` | - | **新增** | 本地 LLM 推理（llama.cpp） |
| `cloud-llm-provider` | - | **新增** | 云端 LLM 推理（DeepSeek API） |
| `intent-router` | - | **新增** | 意图分类和路由决策 |
| `sanitizer-pipeline` | - | **新增** | 数据脱敏管线 |
| `ohttp-gateway` | - | **新增** | OHTTP 网关（RFC 9458） |
| `secure-bridge` | - | **新增** | 端云安全通信桥接 |
| `attestation` | - | **新增** | TEE 远程证明 |
| `td-bus` | - | **新增** | 威胁检测总线 |
| `local-tools` | - | **新增** | 本地工具实现 |
| `web-search` | - | **新增** | 公网搜索工具 |
| `voice-input` | - | **新增** | 语音输入处理 |

**说明**：
- **新增**：DSH 没有内置对应插件，完全由本设计提供
- **替换**：DSH 有内置插件，但本设计提供增强版本（加密、审计、Realm 隔离等）
- 所有事件通过 Cordis 内置 `ctx.event` 系统分发（emit / parallel / serial / bail / waterfall 五种传播模式），不依赖任何外部 event-bus 插件

### 1.5 技术栈

- **插件框架**：DSH（DeepSeek Agent Harness）
- **本地 LLM**：Qwen3-4B（Q4_K_M 量化）via llama.cpp
- **云端 LLM**：DeepSeek-V4 API
- **语音识别**：Whisper-tiny（本地）
- **加密**：AES-256-GCM（存储加密）+ X25519（密钥交换）
- **TEE**：ARM TrustZone / RISC-V Keystone（可选）
- **安全通信**：OHTTP（Oblivious HTTP, RFC 9458）
- **远程证明**：TEE Attestation Token
- **目标平台**：瑞芯微 RK3588 / 飞腾 D3000M（纯 CPU 推理）

### 1.6 渐进式实施路线图

> **实施原则**：从轻到重，先实现基本功能，再持续添加安全加固。每个阶段都可独立交付、独立验证，前一阶段是后一阶段的基础。

本设计的所有能力**不是一次性实现**的，而是按照"**先跑起来 → 再加防护 → 最后上硬件**"的策略，分阶段渐进式落地。

#### 1.6.1 当前状态（2026-08-24）

**已完成**：

| 阶段 | 功能 | 插件 | 状态 |
|---|---|---|---|
| M1 | 基础对话 + HTTP API | `http-api` | ✅ 完整（含 REJECT 403、threat-block 503、`/v1/chat` + `/v1/chat/stream`） |
| M2 | 本地 LLM 接入 | `local-llm-adapter` | ✅ 完整 |
| M3 | 云端 LLM 接入 | `cloud-llm-adapter` | ✅ 完整 |
| M4 | 意图路由 | `intent-router`, `model-router` | ✅ 完整（含三层防御 prompt-guard 正则→400 + prompt-guard 本地 LLM 模型检测→400 + privacy-policy REJECT→403、confidence histogram、LLM-first 顺序、`parseFailure` 计数、`softService()` 软依赖）；**真实环境 e2e 验证 17/17 通过** |
| A1-simplified | 端侧隐私安全（简化版） | `prompt-guard` | ✅ PII 脱敏 + 注入检测 + 频率限制；已并入 Phase 4 |
| A1-audit | 审计日志增强 | `audit-log` | ✅ PII 脱敏 + 日志轮转 |
| A1-session | 会话安全增强 | `http-api` | ✅ 过期清理 + 访问审计 + LRU 淘汰 |
| A1-storage | 存储脱敏 | `local-storage` | ✅ 敏感字段自动脱敏 |
| G8 | 工具 Realm 隔离 | `tools` | ✅ `enableToolIsolation` 接入 `filterTools(intent)` / `isToolAllowed(name, intent)` |
| G9 | 意图分类可观测性 | `intent-router` | ✅ `getStats().confidenceHistogram`（10-bucket × {accepted, rejected}） |

**部署验证**：
- ✅ RK3588 设备部署成功
- ✅ 单元测试套件全通过
- ✅ 本地/云端 LLM 切换正常
- ✅ SSE 流式响应正常（每 chunk `desanitizeSync`）
- ✅ 注入检测拦截（≥3 种模式，规则可配置 `action: block | warn | sanitize`）
- ✅ PII 脱敏（手机号、邮箱、身份证、银行卡、API Key）
- ✅ `intent-router` REJECT 命中 → http-api 403 短路（`intent.rules.rejected` 安全级审计）
- ✅ **隐私预检三层防御 e2e 验证**（2026-08-24）：12 个恶意请求全拦截（3 个 prompt-guard 正则 HTTP 400 + 9 个 privacy-policy HTTP 403），5 个正常请求不误拦（HTTP 200，正确分类 LOCAL/CLOUD）。prompt-guard 模型辅助检测默认开启（local-llm，fail-open）。详见 [intent-recognition-routing.md](./intent-and-sanitization.md) "真实环境 e2e 验证" 章节
- ✅ `td-bus.shouldBlock()` 命中 → http-api 503 短路（`http.chat.threat-blocked` 审计）
- ✅ CLOUD 路径 sanitize → LLM → desanitize（或流式 `desanitizeSync`）端到端
- ✅ Privacy-policy `matchRouting` 命中走规则，未命中走 LLM，再 fallback 关键词 → `defaultCategory`
- ✅ Confidence histogram (`getStats().confidenceHistogram`) 用于调优 `confidenceThreshold`
- ✅ `parseFailure` 与 `sanitizeError`（安全级）独立可观测
- ✅ `enableToolIsolation` 真正进入 service（pre-G8 是死代码）
- ✅ 审计日志自动脱敏敏感字段
- ✅ 审计日志自动轮转（>10MB 或 >7 天）
- ✅ 会话 30 分钟未访问自动清理
- ✅ 最大活跃会话数 100，LRU 淘汰
- ✅ 存储时敏感字段自动脱敏（local-storage、sessions）
- ✅ Privacy-policy JSON 文件 mtime 轮询热重载（`setInterval(checkForUpdates, 5000)`）

**当前匹配度（按维度）**：
- 已完成功能维度：~ 95%（Phase 1-4 全 ✅ + G8 + G9；缺 Phase 5-8 范围）
- 端到端通路维度：~ 85%（路由 / 脱敏 / 审计 / 限流 / REJECT 全打通；td-bus 与 sanitize-error 闭环有但弱）
- 设计意图贴合维度：~ 50%（v6 合规形式已对齐；event-bus 协议、`modelRouter.resolve()` 在 http-api 内未启用、agent-loop 自监听未启用）

#### 1.6.2 实施阶段

##### Phase 1: 基础功能（✅ 已完成）

**目标**：让智能体跑起来，能对话

**交付物**：
- [x] HTTP API 服务（`http-api`）
- [x] 本地 LLM 适配器（`local-llm-adapter`）
- [x] 云端 LLM 适配器（`cloud-llm-adapter`）
- [x] 意图路由（`intent-router`）
- [x] 模型路由（`model-router`）
- [x] 工具注册（`tools`）
- [x] 本地存储（`local-storage` — 明文 JSONL）
- [x] 会话管理（`sessions` — 基础功能）
- [x] 审计日志（`audit-log` — 明文 JSONL）
- [x] RK3588 部署验证

**安全能力**：无

##### Phase 2: 基础安全加固（✅ 已完成）

**目标**：在不依赖 TEE/策略引擎的前提下，提供基础安全防护

**交付物**：
- [x] **A1-simplified**: `prompt-guard` 简化版
  - [x] PII 脱敏（5 种：手机号、身份证、银行卡、邮箱、API Key）
  - [x] 注入检测（3 种：直接注入、提示词泄露、角色覆盖）
  - [x] 频率限制（20 req/min/session）
  - [x] 输入长度限制（10000 字符）
- [x] **审计日志增强**
  - [x] 敏感字段自动脱敏（手机号、邮箱、API Key）— `pii-utils` 共享模块
  - [x] 安全事件分级（debug/info/warn/error/security）
  - [x] 日志轮转（>10MB 或 >7 天，最多 5 个历史文件）
- [x] **会话安全增强**
  - [x] 会话过期自动清理（30 分钟未访问）
  - [x] 会话访问审计（创建/删除/过期/淘汰均有审计）
  - [x] 最大活跃会话数限制（100，LRU 淘汰）

**安全能力**：应用层防护（无加密、无 TEE）

**工作量**：已完成 | **测试**：162 个单元测试全通过

##### Phase 3: 关键信息脱敏（✅ 已完成）

**目标**：保护静态数据中的敏感信息，防止设备丢失导致的数据泄露

**交付物**：
- [x] **pii-utils 共享模块**
  - [x] 5 种 PII 规则（手机号、身份证、银行卡、邮箱、API Key）
  - [x] redactString() 单字符串脱敏
  - [x] redactObject() 深度遍历对象脱敏
- [x] **audit-log PII 脱敏** ✅（Phase 2 已完成）
  - [x] payload 中敏感字段自动脱敏
  - [x] enablePIIRedaction 开关
- [x] **local-storage PII 脱敏** ✅
  - [x] put() 写入前对 value 应用 PII 脱敏
  - [x] enablePIIRedaction 开关
  - [x] 磁盘文件中敏感字段为掩码
- [x] **sessions PII 脱敏** ✅
  - [x] 复用 local-storage 的脱敏能力
  - [x] 会话消息自动脱敏

**简化方案**：只做关键信息脱敏，不做完整加密（无 AES、无 tcm、无 SQLite）

**安全能力**：静态数据脱敏（无加密、无 TEE）

**工作量**：已完成 | **测试**：203 个单元测试全通过

##### Phase 4: 隐私策略引擎（✅ 已完成）

**目标**：统一驱动所有隐私相关行为，支持热更新

**交付物**：
- [x] **privacy-policy 完整实现**
  - [x] 策略文件加载（JSON）
  - [x] 路由规则（`RoutingRule { pattern, realm: 'LOCAL'|'CLOUD'|'SANITIZED'|'REJECT', confidence, rationale }`）
  - [x] 脱敏规则（PII 类型、策略、模板）
  - [x] 数据分类（public/internal/confidential/secret）
  - [ ] 工具访问策略（后续迭代）
  - [x] 全局约束（云端请求限制等）
  - [x] 热更新（基于 `setInterval(checkForUpdates, watchIntervalMs)` 轮询文件 mtime，默认 5 秒；不是 `fs.watch`）
  - [ ] 策略签名验证（后续迭代）
- [x] **intent-router 联动**
  - [x] intent-router 主体能力已独立实现
  - [x] 从 privacy-policy `matchRouting()` 拉取规则（hybrid：`pre-check` 命中 REJECT 短路 + fallback 路径命中返回 verdict）
  - [x] REJECT 意图拦截（intent-router `matchRouting` pre-check + http-api 403 short-circuit）
  - [x] shipped `privacy-policy.json` 含 2 条 REJECT 规则（危险操作、破坏性命令）+ `DEFAULT_POLICY` 含 2 条基础 REJECT 回退（**2026-08-24 优化**：移除重复攻击模式规则，由 prompt-guard 统一处理）
  - [x] **真实环境 e2e 验证通过**（2026-08-24）：12 个恶意请求全拦截 + 5 个正常请求不误拦，三层防御（prompt-guard 正则 HTTP 400 拦截攻击模式 + prompt-guard 模型 HTTP 400 拦截复杂攻击 + privacy-policy HTTP 403 拦截业务危险操作）
- [x] **prompt-guard 联动**
  - [x] prompt-guard 已独立实现 PII 检测与注入防护
  - [x] 从 privacy-policy `classifyData()` 拉脱敏 / 分类规则（`secret` 级一票否决）
  - [x] **三层防御第一层**：http-api 调用 intent-router 之前先经 prompt-guard 正则模式库（命中 → HTTP 400），再经本地 qwen3-4b 模型辅助检测（fail-open，捕捉正则漏报的复杂攻击）
- [x] **sanitizer-pipeline 完整实现**
  - [x] 正向脱敏（PII → 占位符，格式 `[<PII_TYPE>_<counter>]`，如 `[PHONE_1]`、`[EMAIL_2]`）
  - [x] 反向还原（占位符 → PII），含异步 `desanitize` 与同步 `desanitizeSync`
  - [x] 会话级映射表（per-session mapping）
  - [x] 与 privacy-policy 联动（获取脱敏规则）
  - [x] 会话映射上限（`maxReplacementsPerSession` 默认 1024，超限 audit `sanitizer.limit-reached`）
  - [x] `desanitizeSync(text, sessionId)` 同步入口（流式响应逐 chunk 还原）
  - [x] `purge(sessionId)`（http-api DELETE session 时清理映射）
- [x] **http-api 集成 sanitizer-pipeline**
  - [x] CLOUD 请求输入脱敏（`handleChat` + `handleChatStream`）
  - [x] CLOUD 响应反向还原（`handleChat` 整块 `desanitize` + `handleChatStream` 逐 chunk `desanitizeSync`）
  - [x] `sanitizer.purge(sessionId)` 在 DELETE session 时调用
  - [x] REJECT 意图 → 403 short-circuit（不再进入 agent loop 与脱敏）
  - [x] threat-block（td-bus） → 503 short-circuit
  - [x] `promptGuard.checkOutput(result, { sanitized: wasSanitized })` 防止 desanitize 后被二次 mask
- [x] **intent-router 分类 LLM 自身的脱敏前置**（`classifyWithLlm` 在 `modelRouter.resolve(...).realm === 'CLOUD'` 时先 `sanitizer.sanitize` 再喂 LLM——防分类请求本身带 PII 出端）

**安全能力**：策略驱动的隐私控制 + CLOUD 请求端到端脱敏 + 分类请求也不带 PII 上云

**工作量**：7-10 天 | **依赖**：Phase 3

##### Phase 5: 工具与多模态（📋 计划中）

**目标**：扩展智能体能力，支持更多工具和输入方式

**交付物**：
- [ ] **tools 增强**
  - [ ] Realm 权限检查
  - [ ] 工具调用审计
  - [ ] 速率限制（每工具独立配置）
  - [ ] 工具沙箱（文件系统限制）
- [ ] **web-search 完整实现**
  - [ ] DuckDuckGo/Brave Search 集成
  - [ ] 域名黑白名单
  - [ ] 安全搜索（SafeSearch）
  - [ ] 搜索结果脱敏
- [ ] **voice-input 完整实现**
  - [ ] Whisper-tiny 本地推理
  - [ ] VAD（语音活动检测）
  - [ ] 流式转写
  - [ ] 语音数据不出端
- [ ] **local-tools 增强**
  - [ ] 通讯录查询、日历查询
  - [ ] 文件读写（白名单路径）
  - [ ] 数学计算

**安全能力**：工具级权限控制

**工作量**：10-15 天 | **依赖**：Phase 4

##### Phase 6: 威胁检测与自动响应（📋 计划中）

**目标**：持续监控异常行为，自动降级或阻断

**交付物**：
- [ ] **td-bus 完整实现**
  - [ ] 事件订阅（tools/call, session/create, policy/tamper 等）
  - [ ] 检测规则引擎（count_gt, equals, contains）
  - [ ] 威胁等级计算（normal/elevated/high/critical）
  - [ ] 自动响应动作（block-cloud, kill-session, lockdown, notify-user）
  - [ ] 检测窗口（滑动时间窗）
- [ ] **与 prompt-guard 联动**：输入攻击频率检测、自动提升检测级别
- [ ] **与 secure-bridge 联动**：云端请求频率检测、自动阻断异常请求
- [ ] **用户通知机制**：安全事件推送、威胁等级显示

**安全能力**：主动防御

**工作量**：5-7 天 | **依赖**：Phase 4, Phase 5

##### Phase 7: TEE 可信计算（⏸ 后续增强,2026-08-26 决策暂不实施）

**目标**：硬件级信任根，密钥不离开 TEE

**交付物**：
- [ ] **tcm TEE 后端**
  - [ ] ARM TrustZone 集成（RK3588）
  - [ ] RISC-V Keystone 集成（飞腾 D3000M）
  - [ ] 安全内存管理、密钥永不离开 TEE
- [ ] **attestation 完整实现**
  - [ ] TEE 证明令牌生成
  - [ ] 远程验证服务对接
  - [ ] 证明缓存与续签
- [ ] **加密存储 TEE 集成**
  - [ ] 主密钥存于 TEE
  - [ ] 密封存储（数据绑定到设备）
  - [ ] TEE 内安全计算（embedding 推理）

**安全能力**：硬件级信任根

**工作量**：15-20 天 | **依赖**：Phase 3, Phase 6 | **硬件要求**：RK3588 TrustZone / 飞腾 D3000M

**状态（2026-08-26 决策）**：⏸ **后续增强功能**。当前 v0.1.0 信任模型为"开发者承诺 + 单元/e2e 测试背书";TEE 远程证明待 DSH Edge 部署规模化时再启动。`tcm.ts` / `attestation.ts` 文件保留为接口骨架,供未来扩展。

##### Phase 8: 零信任通信（⏸ 后续增强,2026-08-26 决策暂不实施）

**目标**：端云通信零信任，网关无法关联用户与内容

**交付物**：
- [ ] **ohttp-gateway 完整实现**
  - [ ] HPKE 加密（Hybrid Public Key Encryption）
  - [ ] 内层请求构造（Target 可见）、外层请求构造（Relay 不可见）
  - [ ] 密钥配置获取与缓存、响应解密
- [ ] **secure-bridge 完整实现**
  - [ ] OHTTP 模式（零信任）、Direct-TLS 模式（直连，证书固定）
  - [ ] 自动降级（OHTTP → TLS）、请求重试与退避
  - [ ] 与 td-bus 联动（限流、隔离）
- [ ] **cloud-llm-adapter 集成**
  - [ ] 通过 secure-bridge 发送请求
  - [ ] 数据分类检查（非 public 必须脱敏）

**安全能力**：零信任网络

**工作量**：10-15 天 | **依赖**：Phase 7 | **状态**：⏸ **后续增强功能**

**状态（2026-08-26 决策）**：⏸ **后续增强功能**。当前 v0.1.0 `cloud-llm-adapter` 直连 DeepSeek API(依赖 HTTPS 传输安全);OHTTP 网关+身份-内容分离待隐私合规需求出现时再启动。`ohttp-gateway.ts` / `secure-bridge.ts` 文件保留为接口骨架,供未来扩展。

#### 1.6.3 实施进度可视化

```
Phase 1: 基础功能          ████████████████████ 100% ✅
Phase 2: 基础安全加固      ████████████████████ 100% ✅
Phase 3: 关键信息脱敏      ████████████████████ 100% ✅
Phase 4: 隐私策略引擎      ████████████████████ 100% ✅
Phase 5: 工具与多模态      ██░░░░░░░░░░░░░░░░░░  10% 📋 (仅 G8 enableToolIsolation 完成，web-search / voice-input 未动)
Phase 6: 威胁检测          ██░░░░░░░░░░░░░░░░░░  10% 📋 (td-bus 单机计数器 + http-api 503 短路；规则引擎、自动响应未做)
Phase 7: TEE 可信计算      ░░░░░░░░░░░░░░░░░░░░   0% ⏸ (后续增强,2026-08-26 决策暂不实施)
Phase 8: 零信任通信        ░░░░░░░░░░░░░░░░░░░░   0% ⏸ (后续增强,2026-08-26 决策暂不实施)
```

**总体进度**（三档加权，2026-08-23）：
- 已完成功能维度（按 4 个主阶段计数）：~ 80%
- 端到端通路维度（路由 + 脱敏 + 审计 + 限流 + REJECT 全打通）：~ 85%
- 设计意图贴合维度（v6 合规修订 + event-bus 协议 + http-api 走 modelRouter）：~ 55%

注：之前笼统的"约 60%"未区分维度；当下一份渐进式报告以"已完成维度 / 端到端维度 / 设计意图维度"三档同时呈现。

#### 1.6.4 阶段依赖关系

```
Phase 1 (基础功能)
    ↓
Phase 2 (基础安全)
    ↓
Phase 3 (存储加密)
    ↓
Phase 4 (隐私策略)
    ↓
Phase 5 (工具多模态) ──┐
    ↓                  ↓
Phase 6 (威胁检测) ←───┘
    ↓
Phase 7 (TEE) ─────→ Phase 8 (零信任通信，可选)
```

#### 1.6.5 决策记录

**已做出的决策**：

1. **A2 传输层安全暂不实施**（2026-08-22）
   - 原因：当前直接调用 DeepSeek API，无中间中继，OHTTP 价值有限
   - HTTPS 已足够保护传输安全
   - 保留 Phase 8 作为远期规划

2. **RK3588 NPU 优化不在本项目范围**（2026-08-22）
   - 原因：NPU 优化属于硬件驱动层，不在应用层项目范围
   - 使用 rkllm3-server 提供的 OpenAI 兼容 API 即可

3. **A1 采用简化版实现 → 已升级至隐私策略驱动**（2026-08-22 → 2026-08-23）
   - 原因：Phase 4 完成后 privacy-policy 引擎已就绪
   - 现状：prompt-guard 在 `checkInput` / `checkOutput` 阶段独立运行规则；脱敏规则仍由 prompt-guard 内置 PII 字典与 sanitizer-pipeline 自身规则驱动，**policy.json 中的 `sanitizationRules` 仅供 sanitizer-pipeline 加载**——secret 级阻断在 `checkInput` 内由 `privacyPolicy.classifyData()` 完成
   - A1-simplified 行已从 § 1.6.1 当前状态表移除

4. **intent-router 当前为 fail-open，不走 fail-closed**（2026-08-23）
   - 原 Phase B 计划：低置信度 (< `confidenceThreshold`) → REJECT（fail-closed）
   - 现状：低置信度 → fallback 到 `classifyWithRules` / `defaultCategory`（fail-open）
   - 原因：qwen3-4b 在多轮上下文下置信度分布抖动较大，fail-closed 误拒率不可接受
   - 安全级别相当：privacy-policy `matchRouting` 已提供 pre-check 的 REJECT 真短路（http-api 403）；LLM 路径的 REJECT 只作为规则覆盖不到的边角保护

5. **intent-router LLM 分类请求本身不携带 PII 上云**（2026-08-23）
   - 决定：分类 LLM 解析到 `realm === 'CLOUD'` 时，分类前先 `sanitizer.sanitize()`
   - 权衡：换来「分类请求也脱敏」的零信任；代价是分类延迟增加（取决于 sanitize 成本）

6. **http-api 选择 provider/model 仍在两条 handler 内硬编码**（2026-08-23）
   - 设计意图（§ 4.2）：由 `modelRouter.resolve()` 决定
   - 现状：`isLocal ? 'local-llm' / 'qwen3-4b-instruct-2507' : 'cloud-llm' / 'deepseek-chat'`
   - 影响：意图路由 verdict 决定了 realm，但 provider id 走硬编码
   - 待 Phase 5 后期合并时把两条 handler 内的硬编码换成 `modelRouter.resolve(intent)` 形式调用

7. **Phase 7 (TEE 可信计算) + Phase 8 (零信任通信 OHTTP) 暂不实施，作为后续增强功能**（2026-08-26）
   - 决策：当前 v0.1.0 信任模型接受"开发者承诺 + 单元/e2e 测试背书",不强求密码学证明
   - 原因：
     - **Phase 7 (TEE)**:Dsh-edge-agent 主要部署在 RK3588 / 飞腾 D3000M 设备,**当前硬件 TEE 接口尚未在项目优先级中**;且 TEE 集成需要硬件驱动层工作(与"应用层"项目定位不符)。RK3588 NPU 优化已说明这点(决策 #2)
     - **Phase 8 (OHTTP)**:当前 `cloud-llm-adapter` 直连 DeepSeek API(走 HTTPS);OHTTP 网关需独立中继服务,**与 DSH 部署模式耦合**,且 PII 已通过 sanitize 脱敏,OHTTP 主要解决"行为模式关联",在 v0.1.0 阶段用户隐私期望的边际收益不显著
   - **后续触发条件**:
     - Phase 7:DSH Edge 进入规模化部署(> 1000 台),且出现合规要求(如等保/SOC2)需要硬件级信任根时启动
     - Phase 8:出现云端服务商要求/隐私监管要求身份-内容分离时启动(如 GDPR 解释、欧盟数据保护合规)
   - **保留**: `tcm.ts` / `attestation.ts` / `ohttp-gateway.ts` / `secure-bridge.ts` 4 个文件保留为**接口骨架**(避免后续从零设计);其 plugin shape 仍注册到 cordis 但实装是 TODO stub
   - **影响范围**:
     - § 1.1 "可验证安全"(TEE 远程证明)与"零信任通信"(OHTTP)两项目标**不达成**,v0.1.0 是"承诺型"而非"可证明型"边缘私密智能体
     - § 1.2 核心原则中"可验证"与"零信任网络"两项**不达成**,依靠工程测试背书
     - 不影响 M 段 / A 段 / G 段交付;Phase 5/6 仍是近期推进重点
   - 与历史决策 #1 (A2 传输层安全暂不实施) 的关系:本次为**扩展性确认**,覆盖了 Phase 7 TEE 维度(此前决策仅覆盖 Phase 8)

**待决策**：

1. **Phase 5 web-search / voice-input 实现优先级**(2026-08-26):Phase 5 当前仅 G8 enableToolIsolation 完成,剩余工具是否在 v0.2 启动前补齐,需要确认业务需求先后

#### 1.6.6 下一步行动

| 时间 | 行动 |
|---|---|
| 2026-08-23 | Phase 1-4 全部 ✅；G8 (enableToolIsolation) + G9 (confidenceHistogram) 已合入 |
| 2 周内 | Phase 5 收尾（tools.ts 用 DSH native `ctx.tools` 全面替换 register；web-search / voice-input 启动） |
| 1 个月 | Phase 5 完整实现 + Phase 6 威胁检测规则引擎、自动响应、用户通知 |
| 2-3 个月 | Phase 5-6 完整收尾 + Phase 7 评估（TEE 优先级决策）|

#### 1.6.7 验证标准

**Phase 1 验证（基础功能）**：
- [x] HTTP API 服务启动：`http-api` listen `:21017` by default ✅
- [x] 本地 LLM 适配器：`local-llm` 路由注册 ✅
- [x] 云端 LLM 适配器：`cloud-llm` 路由注册 ✅
- [x] 意图路由基础分类（keyword fallback） ✅
- [x] 工具注册表（Realm-aware view） ✅

**Phase 2 验证**：
- [x] 审计日志中手机号显示为 `138****5678` ✅
- [x] 审计日志自动轮转（>10MB 或 >7 天） ✅
- [x] 会话 30 分钟未访问自动清理 ✅
- [x] 活跃会话数超过上限时淘汰最久未访问 ✅

**Phase 3 验证**：
- [x] local-storage 存储文件中敏感字段为掩码 ✅
- [x] sessions 消息内容自动脱敏 ✅
- [x] audit-log payload 自动脱敏 ✅（Phase 2 已完成）
- [x] enablePIIRedaction 开关正常工作 ✅

**Phase 4 验证**：
- [x] privacy-policy 策略文件加载（JSON 格式） ✅
- [x] 路由规则匹配（LOCAL/CLOUD/SANITIZED/REJECT 四类 category） ✅
- [x] 数据分类（public/confidential/secret） ✅
- [x] 热更新（基于 `setInterval(checkForUpdates, 5000)` 轮询文件 mtime，非 `fs.watch`） ✅
- [x] sanitizer-pipeline 正向脱敏（PII → `[PHONE_1]` / `[EMAIL_2]` / `[ID_CARD_3]`） ✅
- [x] sanitizer-pipeline 异步反脱敏（`desanitize(text, sessionId)`） ✅
- [x] sanitizer-pipeline 同步反脱敏（`desanitizeSync(text, sessionId)`，用于 `handleChatStream` 逐 chunk） ✅
- [x] 会话级映射表隔离（不同会话独立占位符） ✅
- [x] http-api `handleChat` CLOUD 请求脱敏 + 响应还原 ✅
- [x] http-api `handleChatStream` 流式 CLOUD 请求脱敏 + 逐 chunk 还原 ✅
- [x] `sanitizer.purge(sessionId)` 在 DELETE session 时调用 ✅
- [x] `intent-router.matchRouting` pre-check REJECT → http-api 403 short-circuit ✅
- [x] `intent-router.classifyWithLlm` 中：分类 LLM 在 `realm === 'CLOUD'` 时先 `sanitizer.sanitize()` 再喂 LLM（PII 不出端） ✅
- [x] `td-bus.shouldBlock()` 命中 → http-api 503 short-circuit（`http.chat.threat-blocked` 安全级审计） ✅
- [x] `promptGuard.checkOutput(result, { sanitized: wasSanitized })` 防止 desanitize 后被二次 mask ✅
- [x] `tools.enableToolIsolation` 接入 `filterTools(intent)` / `isToolAllowed(name, intent)` (G8) ✅
- [x] `intent-router.getStats().confidenceHistogram` 10-bucket × {accepted, rejected} (G9) ✅
- [x] `intent-router` `confidenceThreshold` 是 `0..1` 浮点（`Schema.number().min(0).max(1)`，非 `Schema.natural()` —— 18d247d 修复） ✅
- [x] `intent-router` `parseFailure` / `sanitizeError` (安全级) 独立可观测 ✅
- [x] 单元测试套件全通过 ✅
- [ ] 策略文件篡改检测（后续迭代）

#### 1.6.8 小结

本项目采用**渐进式实施**策略：

1. **先跑起来**（Phase 1）— 基础对话功能
2. **再加防护**（Phase 2-6）— 逐步增强安全能力
3. **最后上硬件**（Phase 7-8）— TEE + 零信任

每个阶段都可独立交付，前一阶段是后一阶段的基础。当前处于 **Phase 4（隐私策略引擎）已完成**，Phase 1-4 均已完成。下一步启动 Phase 5（工具增强 + 多模态）。

**核心理念**：安全不是一蹴而就的，而是持续演进的过程。

---

## 二、插件架构

### 2.0 整体分层

```
┌─────────────────────────────────────────────────────────────────────┐
│                        用户输入层                                    │
│  voice-input（语音）/ 文本输入                                        │
├─────────────────────────────────────────────────────────────────────┤
│                        安全防护层                                    │
│  prompt-guard（输入/输出防护）/ privacy-policy（策略引擎）             │
├─────────────────────────────────────────────────────────────────────┤
│                        路由决策层                                    │
│  intent-router（意图分类）/ model-router（模型选择）                   │
├─────────────────────────────────────────────────────────────────────┤
│                        Realm 隔离层                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐                      │
│  │  LOCAL   │  │  CLOUD   │  │  SANITIZED   │                      │
│  │          │  │          │  │              │                      │
│  │local-llm │  │cloud-llm │  │sanitizer-pipe│                      │
│  │local-tool│  │web-search│  │              │                      │
│  └──────────┘  └──────────┘  └──────────────┘                      │
├─────────────────────────────────────────────────────────────────────┤
│                        基础设施层                                    │
│  local-storage / sessions / tools                    │
│  audit-log / td-bus / secure-bridge / attestation / tcm             │
│  ohttp-gateway / privacy-policy                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

### 2.1 tcm 插件（可信计算模块）

TEE 环境管理，为整个系统提供硬件级信任根。

#### 插件元信息
```yaml
name: tcm
type: security-core
inject:
  - config
```

#### 接口定义
```typescript
interface TcmConfig {
  // TEE 类型
  teeType: 'trustzone' | 'keystone' | 'sgx' | 'simulated'
  // 密钥存储路径（TEE 内部）
  keyStorePath: string
  // 是否启用 TEE 内模型推理
  teeInference: boolean
  // 安全内存大小限制（字节）
  secureMemoryLimit: number
}

interface TcmService {
  // 密钥管理
  generateKey(tag: string): Promise<CryptoKey>
  getKey(tag: string): Promise<CryptoKey>
  deleteKey(tag: string): Promise<void>

  // 加密/解密（密钥不离开 TEE）
  encrypt(data: Uint8Array, tag: string): Promise<Uint8Array>
  decrypt(data: Uint8Array, tag: string): Promise<Uint8Array>

  // 安全哈希
  hash(data: Uint8Array, algorithm: 'sha-256' | 'sha-3'): Promise<Uint8Array>

  // TEE 内安全计算（如 embedding 推理）
  secureCompute(input: Uint8Array, modelTag: string): Promise<Uint8Array>

  // 远程证明
  generateAttestation(nonce: string): Promise<AttestationToken>

  // 密封存储（数据绑定到当前设备+TEE）
  seal(data: Uint8Array): Promise<Uint8Array>
  unseal(data: Uint8Array): Promise<Uint8Array>

  // 健康状态
  getStatus(): TcmStatus
}

interface TcmStatus {
  teeAvailable: boolean
  teeType: string
  secureMemoryUsed: number
  secureMemoryTotal: number
  keyCount: number
  lastAttestation: number | null
}
```

#### 核心实现
```typescript
export const inject = ['config']

export function apply(ctx: Context, config: TcmConfig) {
  ctx.effect(() => {
    let teeBackend: TeeBackend

    // 根据配置初始化 TEE 后端
    switch (config.teeType) {
      case 'trustzone':
        teeBackend = new TrustZoneBackend()
        break
      case 'keystone':
        teeBackend = new KeystoneBackend()
        break
      case 'simulated':
        teeBackend = new SimulatedTeeBackend()  // 开发/测试用
        break
    }

    const service: TcmService = {
      async generateKey(tag) {
        const key = await teeBackend.generateKey(tag)
        ctx.event.emit('tcm/key-generated', { tag })
        return key
      },

      async getKey(tag) {
        return await teeBackend.getKey(tag)
      },

      async encrypt(data, tag) {
        const key = await this.getKey(tag)
        return await teeBackend.encrypt(data, key)
      },

      async decrypt(data, tag) {
        const key = await teeBackend.getKey(tag)
        return await teeBackend.decrypt(data, key)
      },

      async hash(data, algorithm) {
        return await teeBackend.hash(data, algorithm)
      },

      async secureCompute(input, modelTag) {
        // 在 TEE 内部执行推理（如 embedding）
        // 输入和输出都在安全内存中，REE 侧无法窥探
        if (!config.teeInference) {
          throw new Error('TEE 内推理未启用')
        }
        return await teeBackend.runInference(input, modelTag)
      },

      async generateAttestation(nonce) {
        const token = await teeBackend.generateAttestation(nonce)
        ctx.event.emit('tcm/attestation-generated', {
          nonce,
          timestamp: Date.now(),
        })
        return token
      },

      async seal(data) {
        // 使用设备绑定的密钥加密，数据只能在同一设备+TEE上解密
        const deviceKey = await this.getKey('_device_seal_key')
        const iv = crypto.getRandomValues(new Uint8Array(12))
        const encrypted = await aesGcmEncrypt(data, deviceKey, iv)
        return concat(iv, encrypted)
      },

      async unseal(data) {
        const deviceKey = await this.getKey('_device_seal_key')
        const iv = data.slice(0, 12)
        const ciphertext = data.slice(12)
        return await aesGcmDecrypt(ciphertext, deviceKey, iv)
      },

      getStatus() {
        return teeBackend.getStatus()
      },
    }

    const dispose = ctx.provide('tcm', service)
    return async () => { dispose() }
  })
}
```

#### 配置 schema
```yaml
tcm:
  teeType: trustzone        # RK3588 使用 TrustZone
  keyStorePath: /secure/keys
  teeInference: true        # 启用 TEE 内 embedding 推理
  secureMemoryLimit: 67108864  # 64MB 安全内存
```

#### 错误处理
- TEE 不可用 → 降级到 simulated 模式，发出安全告警
- 安全内存不足 → 驱逐最久未使用的密钥
- 密封数据损坏 → 拒绝解密，要求重新初始化

---

### 2.2 local-storage 插件（加密存储）

替代任何内置 storage 服务。提供加密的本地持久化存储，密钥由 `tcm` 管理。

#### 插件元信息
```yaml
name: local-storage
type: service
inject:
  - tcm
  - config
```

#### 接口定义
```typescript
interface LocalStorageConfig {
  // 数据库路径
  dbPath: string
  // 加密密钥标签（在 tcm 中引用）
  encryptionKeyTag: string
  // 是否启用 WAL 模式
  walMode: boolean
  // 自动备份间隔（毫秒）
  backupInterval: number
  // 最大数据库大小（字节）
  maxSize: number
}

interface LocalStorageService {
  // 基础 CRUD
  get<T>(collection: string, key: string): Promise<T | null>
  set<T>(collection: string, key: string, value: T): Promise<void>
  delete(collection: string, key: string): Promise<boolean>
  list(collection: string, filter?: QueryFilter): Promise<StorageEntry[]>

  // 批量操作
  batch(ops: StorageOperation[]): Promise<void>

  // 全文搜索（加密索引）
  search(collection: string, query: string): Promise<StorageEntry[]>

  // 数据源接入（通讯录、日历等系统数据）
  queryDataSource(source: string, query: object): Promise<any[]>

  // 存储统计
  getStats(): StorageStats
}
```

#### 核心实现
```typescript
export const inject = ['tcm', 'config']

export function apply(ctx: Context, config: LocalStorageConfig) {
  ctx.effect(() => {
    let db: EncryptedSQLite
    let encryptionKey: CryptoKey

    async function init() {
      // 从 TCM 获取或生成加密密钥
      try {
        encryptionKey = await ctx.tcm.getKey(config.encryptionKeyTag)
      } catch {
        encryptionKey = await ctx.tcm.generateKey(config.encryptionKeyTag)
      }

      // 打开加密数据库
      db = await EncryptedSQLite.open(config.dbPath, {
        encryptionKey,
        walMode: config.walMode,
      })

      // 初始化系统数据源连接
      await initDataSources(config.dataSources)
    }

    init()

    const service: LocalStorageService = {
      async get(collection, key) {
        const row = await db.query(
          `SELECT value FROM ${collection} WHERE key = ?`,
          [key]
        )
        if (!row) return null

        // 值在 SQLite 层面已加密，取出后由 EncryptedSQLite 自动解密
        return JSON.parse(row.value)
      },

      async set(collection, key, value) {
        const serialized = JSON.stringify(value)
        await db.execute(
          `INSERT OR REPLACE INTO ${collection} (key, value, updated_at)
           VALUES (?, ?, ?)`,
          [key, serialized, Date.now()]
        )
        ctx.event.emit('storage/set', { collection, key })
      },

      async delete(collection, key) {
        const result = await db.execute(
          `DELETE FROM ${collection} WHERE key = ?`,
          [key]
        )
        ctx.event.emit('storage/delete', { collection, key })
        return result.changes > 0
      },

      async list(collection, filter) {
        return await db.queryAll(
          `SELECT key, value, updated_at FROM ${collection}
           ${buildWhereClause(filter)}
           ORDER BY updated_at DESC`,
          filter?.params ?? []
        )
      },

      async search(collection, query) {
        // 使用加密感知的全文搜索（FTS5 + 加密索引）
        return await db.ftsSearch(collection, query)
      },

      async queryDataSource(source, query) {
        // 查询系统数据源（通讯录、日历等）
        const ds = dataSources.get(source)
        if (!ds) throw new Error(`数据源 ${source} 不存在`)
        return await ds.query(query)
      },

      getStats() {
        return {
          collections: db.getCollections(),
          totalSize: db.getFileSize(),
          encrypted: true,
        }
      },
    }

    const dispose = ctx.provide('local-storage', service)
    return async () => {
      await db.close()
      dispose()
    }
  })
}
```

#### 配置 schema
```yaml
local-storage:
  dbPath: /data/agent/storage.enc.db
  encryptionKeyTag: storage-master-key
  walMode: true
  backupInterval: 3600000
  maxSize: 536870912       # 512MB
  dataSources:
    - type: contacts
      dbPath: /data/user/contacts.db
    - type: calendar
      dbPath: /data/user/calendar.db
```

#### 错误处理
- 数据库损坏 → 从最近备份恢复
- 加密密钥丢失 → 数据不可恢复，要求重新初始化
- 磁盘空间不足 → 清理过期数据，发出告警

---

### 2.3 sessions 插件（加密会话管理）

替代任何内置 session 服务。提供加密的对话会话管理，支持过期、审计和 Realm 隔离。

#### 插件元信息
```yaml
name: sessions
type: service
inject:
  - tcm
  - local-storage
  - config
```

#### 接口定义
```typescript
interface SecureSessionConfig {
  // 会话过期时间（毫秒）
  sessionTimeout: number
  // 加密密钥标签
  encryptionKeyTag: string
  // 最大活跃会话数
  maxActiveSessions: number
  // 是否持久化会话到磁盘
  persistSessions: boolean
  // 会话历史保留天数
  historyRetentionDays: number
}

interface Session {
  id: string
  realm: 'local' | 'cloud' | 'sanitized'
  messages: ChatMessage[]
  metadata: Record<string, unknown>
  createdAt: number
  lastAccessedAt: number
  expiresAt: number
}

interface SecureSessionService {
  // 创建新会话
  create(realm: string, metadata?: object): Promise<Session>

  // 获取会话（自动解密）
  get(sessionId: string): Promise<Session | null>

  // 追加消息（自动加密）
  appendMessage(sessionId: string, message: ChatMessage): Promise<void>

  // 获取最近消息（用于上下文构建）
  getRecentMessages(sessionId: string, count: number): Promise<ChatMessage[]>

  // 销毁会话
  destroy(sessionId: string): Promise<void>

  // 清理过期会话
  cleanup(): Promise<number>

  // 列出活跃会话
  listActive(): Promise<SessionSummary[]>
}
```

#### 核心实现
```typescript
export const inject = ['tcm', 'local-storage', 'config']

export function apply(ctx: Context, config: SecureSessionConfig) {
  ctx.effect(() => {
    // 内存中的活跃会话缓存（已解密）
    const activeSessions = new Map<string, Session>()
    let encryptionKey: CryptoKey

    async function init() {
      encryptionKey = await ctx.tcm.getKey(config.encryptionKeyTag)

      // 定时清理过期会话
      setInterval(async () => {
        const cleaned = await service.cleanup()
        if (cleaned > 0) {
          ctx.event.emit('session/cleanup', { count: cleaned })
        }
      }, 60000)  // 每分钟检查
    }

    init()

    const service: SecureSessionService = {
      async create(realm, metadata) {
        if (activeSessions.size >= config.maxActiveSessions) {
          // 淘汰最久未访问的会话
          const oldest = [...activeSessions.values()]
            .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt)[0]
          await this.destroy(oldest.id)
        }

        const session: Session = {
          id: generateSessionId(),
          realm: realm as Session['realm'],
          messages: [],
          metadata: metadata ?? {},
          createdAt: Date.now(),
          lastAccessedAt: Date.now(),
          expiresAt: Date.now() + config.sessionTimeout,
        }

        activeSessions.set(session.id, session)

        if (config.persistSessions) {
          await persistSession(session, encryptionKey)
        }

        ctx.event.emit('session/created', { id: session.id, realm })
        return session
      },

      async get(sessionId) {
        // 先查内存缓存
        let session = activeSessions.get(sessionId)
        if (session) {
          // 检查过期
          if (Date.now() > session.expiresAt) {
            await this.destroy(sessionId)
            return null
          }
          session.lastAccessedAt = Date.now()
          return session
        }

        // 从磁盘加载（解密）
        if (config.persistSessions) {
          session = await loadSession(sessionId, encryptionKey)
          if (session) {
            activeSessions.set(sessionId, session)
            return session
          }
        }

        return null
      },

      async appendMessage(sessionId, message) {
        const session = await this.get(sessionId)
        if (!session) throw new Error(`会话 ${sessionId} 不存在或已过期`)

        session.messages.push(message)
        session.lastAccessedAt = Date.now()

        if (config.persistSessions) {
          await persistSession(session, encryptionKey)
        }

        ctx.event.emit('session/message-appended', {
          sessionId,
          role: message.role,
          realm: session.realm,
        })
      },

      async getRecentMessages(sessionId, count) {
        const session = await this.get(sessionId)
        if (!session) return []
        return session.messages.slice(-count)
      },

      async destroy(sessionId) {
        activeSessions.delete(sessionId)
        if (config.persistSessions) {
          await ctx['local-storage'].delete('sessions', sessionId)
        }
        ctx.event.emit('session/destroyed', { id: sessionId })
      },

      async cleanup() {
        const now = Date.now()
        let cleaned = 0

        for (const [id, session] of activeSessions) {
          if (now > session.expiresAt) {
            await this.destroy(id)
            cleaned++
          }
        }

        return cleaned
      },

      async listActive() {
        return [...activeSessions.values()].map(s => ({
          id: s.id,
          realm: s.realm,
          messageCount: s.messages.length,
          createdAt: s.createdAt,
          lastAccessedAt: s.lastAccessedAt,
        }))
      },
    }

    const dispose = ctx.provide('sessions', service)
    return async () => {
      activeSessions.clear()
      dispose()
    }
  })
}
```

#### 配置 schema
```yaml
sessions:
  sessionTimeout: 1800000       # 30 分钟
  encryptionKeyTag: session-key
  maxActiveSessions: 10
  persistSessions: true
  historyRetentionDays: 7
```

---

### 2.4 tools 插件（Realm-aware 视图）

DSH 已经内置 `ctx.tools`（上游 `@deepseek-ai/dsh-tools`），本插件**不维护平行注册表**，只是在上游注册表之上提供 Realm-aware 视图：根据 intent-router 的 verdict 过滤可见工具，并在 `enableToolIsolation: true`（默认）时强制按 `intent.category` 匹配。G8（2026-08-23 commit `b39d21f`）合入后，`enableToolIsolation` 真正进入 service，之前该 flag 是死配置。

#### 插件元信息
```yaml
name: tools
type: service
inject:
  - audit-log
```

#### 接口定义
```typescript
type ToolRealm = 'LOCAL' | 'CLOUD' | 'SANITIZED'

interface ToolSummary {
  name: string
  description: string
  realm: ToolRealm
}

/** 仅取 intent-router verdict 中的 category 字段。声明在 tools.ts
 *  内部以避免对 intent-router.ts 的循环依赖；intent-router 的
 *  `Intent` 类型本身满足该结构。 */
type IntentLike = { readonly category: 'LOCAL' | 'CLOUD' | 'SANITIZED' | 'REJECT' }

interface ToolsService {
  /** 列出全局工具（按 `realm` 过滤时严格要求 `setRealm` 显式标记）。 */
  list(realm?: ToolRealm): ToolSummary[]
  /** 名称已注册（上游 `ctx.tools.view()` 含该名）。 */
  has(name: string): boolean
  /** 工具的显式 realm 标记；未标记返回 undefined。 */
  realmOf(name: string): ToolRealm | undefined
  /** 用 `local_` / `cloud_` / `sanitized_` 前缀推断；其它默认 CLOUD。 */
  classify(name: string): ToolRealm
  /** G8: 给定 intent-router verdict，返回可见工具集。
   *  - REJECT → []
   *  - enableToolIsolation: false → 全集（opt-out）
   *  - enableToolIsolation: true  → 仅 `realmOf(name) ?? classifyByPrefix(name) === intent.category` 的工具 */
  filterTools(intent: IntentLike): ToolSummary[]
  /** G8: 单工具判断（比 `filterTools(intent).some(...)` 便宜）。 */
  isToolAllowed(toolName: string, intent: IntentLike): boolean
}
```

#### 核心实现（基于 `src/dsh-adapter/tools.ts`）
```typescript
export const inject = ['auditLog'] as const

export class ToolsServiceImpl extends Service {
  private readonly realm = new Map<string, ToolRealm>()
  private readonly enableToolIsolation: boolean

  constructor(ctx: Context, config: Partial<Config>) {
    super(ctx, 'edgeTools')
    this.enableToolIsolation = config.enableToolIsolation ?? false
  }

  /** 显式覆盖工具的 realm 标记。Tool 注册本身仍走
   *  `ctx.tools.register(...)` 上游。 */
  setRealm(toolName: string, realm: ToolRealm): void { ... }

  /** G8: 可见性过滤。 */
  filterTools(intent: IntentLike): ToolSummary[] {
    if (intent.category === 'REJECT') return []
    if (!this.enableToolIsolation) return this.list()
    const upstream = upstreamTools(this.ctx)
    return upstream
      .filter((t) => (this.realm.get(t.name) ?? classifyByPrefix(t.name)) === intent.category)
      .map((t) => ({ name: t.name, description: t.description, realm: this.realm.get(t.name) ?? classifyByPrefix(t.name) }))
  }

  isToolAllowed(toolName: string, intent: IntentLike): boolean {
    if (intent.category === 'REJECT') return false
    if (!this.enableToolIsolation) return this.has(toolName)
    if (!this.has(toolName)) return false
    return (this.realm.get(toolName) ?? classifyByPrefix(toolName)) === (intent.category as ToolRealm)
  }
}

/** 纯函数：按工具名推断 realm。`local_*` → LOCAL，`cloud_*` → CLOUD，
 *  `sanitized_*` → SANITIZED，其它 → CLOUD（故意默认到 CLOUD，让
 *  cloud 路径可以显式拒绝，避免默默落到 LOCAL）。 */
export function classifyByPrefix(toolName: string): ToolRealm { ... }
```

#### 配置 schema
```yaml
tools:
  # 默认 per-tool 速率（信息项，M3 持久化时启用）
  defaultRateLimitPerMinute: 60
  # G8: 启用 realm 隔离（与 intent-router verdict 联动过滤）
  enableToolIsolation: true
  # 展示模式（信息项，本服务暂不消费）
  presentationMode: native     # native | code-mode
```

#### `apply()` 实装
```typescript
export async function apply(ctx: Context, config: Config): Promise<() => Promise<void>> {
  // ToolsServiceImpl extends Service，构造时已通过 ctx.reflect.provide('edgeTools', this) 注册；
  // 此处不再 ctx.provide，避免 "service already registered"。
  void new ToolsServiceImpl(ctx, config)
  return async () => {}
}
```

#### 调用方
- `intent-router` 不调用 `filterTools`（intent 不直接限工具可见性）
- `http-api` / 自定义 agent loop 消费 `filterTools(intent)` / `isToolAllowed(name, intent)`

#### 已知降级
- 旧 unit tests / 上游 dsh-tools 切换时 `enableToolIsolation` 仍可设为 `false`，返回全集
- `setRealm` 必须在工具注册**之后**调用，否则分类只能走前缀推断

---

### 2.5 privacy-policy 插件（隐私策略引擎）

统一驱动所有隐私相关行为的可配置策略引擎。**替代原来硬编码在 intent-router 中的规则**。v0.1.0 实装（Phase 4 已完成）已落地 `RoutingRule` / `SanitizationRule` / `DataClassification` / `GlobalConstraints` 四个对象 + 文件加载 + mtime 轮询热重载；策略签名验证、远程策略拉取、`toolAccessPolicy` 尚未实装，留作后续迭代。

#### 插件元信息
```yaml
name: privacy-policy
type: service
inject:
  - audit-log          # 实际 inject（其它依赖通过 ctx.get 懒查）
```

#### 配置（cordis.yml 实际形态）
```yaml
privacy-policy:
  policyPath: /etc/dsh-edge-agent/policy.json
  hotReload: true
  watchIntervalMs: 5000   # mtime 轮询间隔
```

#### 接口定义（实装的 surface）
```typescript
export interface Config {
  policyPath: string
  hotReload: boolean
  watchIntervalMs: number
}

/** Routing rule — 实装字段。不带 priority/id/description 等。 */
export interface RoutingRule {
  /** RegExp pattern (case-insensitive applied)。 */
  pattern: string
  /** 目标 realm，REJECT 是第一类 category。 */
  realm: 'LOCAL' | 'CLOUD' | 'SANITIZED' | 'REJECT'
  /** 0..1 confidence；规则命中直接采用，不进 LLM。 */
  confidence: number
  /** 人类可读理由，写入审计。 */
  rationale: string
}

/** Sanitization rule — 驱动 sanitizer-pipeline 的 placeholder 生成。 */
export interface SanitizationRule {
  pattern: string
  replacement: string         // 形如 '[PHONE_$&]'，$& / $1 等 regex backref
  dataClass: string           // 关联 DataClassification.class
  piiType: string             // 'phone' | 'email' | 'id-card' | ...
}

/** Data classification — public/internal/confidential/secret 四档。 */
export interface DataClassification {
  class: 'public' | 'internal' | 'confidential' | 'secret'
  defaultRealm: 'LOCAL' | 'CLOUD' | 'SANITIZED'
  ttlSeconds: number
}

/** Globals — 限流 / 强制证明 / TCB 失陷降级。 */
export interface GlobalConstraints {
  maxCloudRequestsPerMinute: number
  requireAttestation: boolean
  blockIfTcbCompromised: boolean
}

export interface PrivacyPolicyService {
  reload(): Promise<void>
  get(): PrivacyPolicy
  getRoutingRules(): RoutingRule[]
  getSanitizationRules(): SanitizationRule[]
  getClassifications(): DataClassification[]
  getConstraints(): GlobalConstraints
  /** 按序遍历 routingRules，第一条 `RegExp(pattern, 'i').test(text)` 命中返回；
   *  REJECT 命中后 intent-router pre-check 短路 → http-api 403。 */
  matchRouting(text: string): RoutingRule | null
  /** 命中脱敏规则时返回最高的 dataClass；未命中返回 'public'。 */
  classifyData(text: string): string
  on(event: 'policy/loaded', listener: (policy: PrivacyPolicy) => void): void
}
```

#### 核心实现（基于 `src/dsh-adapter/privacy-policy.ts`）
```typescript
export const inject = ['auditLog'] as const

const DEFAULT_POLICY: PrivacyPolicy = {
  version: '1.0.0',
  routingRules: [
    { pattern: '(本地|local|文件|file|计算|calculate)', realm: 'LOCAL', confidence: 0.8, rationale: 'Local operations stay on device' },
  ],
  sanitizationRules: [
    { pattern: '1[3-9]\\d{9}', replacement: '[PHONE_$&]', dataClass: 'confidential', piiType: 'phone' },
    { pattern: '([\\w.-]+)@([\\w.-]+\\.\\w+)', replacement: '[EMAIL_$&]', dataClass: 'confidential', piiType: 'email' },
  ],
  dataClassifications: [
    { class: 'public',        defaultRealm: 'CLOUD',     ttlSeconds: 3600 },
    { class: 'internal',      defaultRealm: 'SANITIZED', ttlSeconds: 1800 },
    { class: 'confidential',  defaultRealm: 'LOCAL',     ttlSeconds:  900 },
    { class: 'secret',        defaultRealm: 'LOCAL',     ttlSeconds:  300 },
  ],
  globalConstraints: {
    maxCloudRequestsPerMinute: 20,
    requireAttestation: false,
    blockIfTcbCompromised: true,
  },
}

export class PrivacyPolicyServiceImpl extends Service implements PrivacyPolicyService {
  private policy: PrivacyPolicy = DEFAULT_POLICY
  private lastMtime = 0
  private watchTimer: ReturnType<typeof setInterval> | undefined

  /** 第一遍：磁盘加载；hotReload=true 时启动轮询 timer。 */
  async start(): Promise<void> { ... reload() + setInterval(checkForUpdates, watchIntervalMs) }
  /** 单次轮询：stat file → 比较 mtimeMs → 大于 lastMtime 触发 reload。 */
  private async checkForUpdates(): Promise<void> { ... }

  matchRouting(text: string): RoutingRule | null {
    for (const rule of this.policy.routingRules) {
      try {
        if (new RegExp(rule.pattern, 'i').test(text)) return rule
      } catch { /* skip bad regex */ }
    }
    return null
  }

  classifyData(text: string): string {
    const order = ['public', 'internal', 'confidential', 'secret']
    let highest = 'public'
    for (const rule of this.policy.sanitizationRules) {
      if (new RegExp(rule.pattern, 'i').test(text)) {
        const idx = order.indexOf(rule.dataClass)
        if (idx > order.indexOf(highest)) highest = rule.dataClass
      }
    }
    return highest
  }
}
```

#### `apply()` 实装
```typescript
export async function apply(ctx: any, config: Config): Promise<() => Promise<void>> {
  const auditLog = ctx.get('auditLog')
  const service = new PrivacyPolicyServiceImpl(ctx, config, auditLog)
  await service.start()
  return async () => { service.stop() }   // clearInterval
}
```

#### 与 intent-router 的实际接缝
```typescript
// 在 intent-router.ts:classify() 与 classifyWithRules() 中：
const pre = policy?.matchRouting?.(effectiveText)
if (pre && pre.realm === 'REJECT') {
  this.stats.rejected++
  this.audit('security', 'intent.rules.rejected', { source: 'privacy-policy-precheck', ... })
  return { category: 'REJECT', confidence: pre.confidence, targetRealm: 'rejected',
           rationale: pre.rationale || 'policy-rule:reject', dataLevel: 'internal',
           requiresSanitization: false }
}
```
- **两条路径使用 matchRouting**：① `classify()` 早期 pre-check；② `classifyWithRules()` fallback 路径（命中任意 realm 都直接采用，不再调 LLM）。
- REJECT 在任一路径命中，http-api 都会发出 403 与 `intent.rules.rejected` 安全级审计。

#### 已知未实装项
- 策略文件**签名验证**：当前 `reload()` 不校验哈希。如果要防止磁盘被改文件后被静默采纳，需要先求 sha256 并和 lastMtime 一起记录——属于「策略文件篡改检测」条目。
- **工具访问策略** `toolAccessPolicy`：policy.json 暂不消费；`tools.ts` 的 Realm 隔离由 `enableToolIsolation` 与 `setRealm` 驱动，未走 policy 引擎。
- **远程策略拉取**：当前实装仅本地 JSON；`allowRemotePolicyUpdate` / `policyUpdateUrl` 仍为 schema 占位，未实现拉取与签名校验。
- **政策审计 / 变更广播**：仅 `policy/loaded` 事件 emit；policy diff 与签名升级通知未实现。

### 2.6 prompt-guard 插件（输入/输出安全防护）

防止 prompt 注入、越狱攻击，以及输出中的敏感信息泄露。v0.1.0 实装对**输入规则**与**输出 PII redact**双通道；规则 action 三档（`block / warn / sanitize`），当前 `sanitize` action 在 cordis.yml schema 已声明但运行时未实装（选 `sanitize` 即抛 `sanitize-action-not-implemented`）。

`promptGuard.checkOutput` 在 http-api 内的正确接入点是 `promptGuard.checkOutput(result, { sanitized: wasSanitized })`——`wasSanitized=true` 时 prompt-guard 跳过自身的输出 mask，避免对 `sanitizer.desanitize()` 还原后的明文做二次脱敏。

#### 插件元信息
```yaml
name: prompt-guard
type: middleware
inject:
  - tcm
  - privacy-policy
  - audit-log
  - llm          # 启用模型辅助检测时需要
```

#### 接口定义（实装 surface）
```typescript
export interface InjectionRuleConfig {
  name: string
  pattern: string
  /** action 三档：当前 `sanitize` 是占位符（运行时会抛错） */
  action?: 'block' | 'warn' | 'sanitize'
}

export interface Config {
  // 入口限制
  maxInputLength: number            // 默认 10000
  maxRequestsPerMinute: number      // 默认 20

  // 功能开关
  enablePIIRedaction: boolean       // 默认 true
  enableInjectionDetection: boolean // 默认 true
  enableRateLimit: boolean          // 默认 true

  // 可配置注入规则
  rules: InjectionRuleConfig[]

  // 模型辅助检测
  enableModelDetection: boolean
  modelDetectionProvider: string    // 默认 'local-llm'
  modelDetectionModel: string       // 默认 'qwen3-4b'
  modelDetectionTimeoutMs: number   // 默认 4000
  modelDetectionMaxInputLength: number  // 默认 2000
}

/** Real 入口表面（schema 行为可见处）。 */
interface PromptGuardService {
  checkInput(text: string, sessionId?: string): Promise<{ safe: boolean; reason: string; riskLevel: RiskLevel }>
  /** G6: wasSanitized 标志 — true 时跳过输出的 PII 二次 mask，避免与 sanitizer-pipeline 输出脱敏冲突 */
  checkOutput(text: string, opts?: { sanitized?: boolean }): Promise<{ filtered: string; redacted: Array<{ type: string; masked: string }> }>
}
```

#### 核心实现（基于 `src/dsh-adapter/prompt-guard.ts`）
```typescript
export const inject = ['tcm', 'privacyPolicy', 'auditLog', 'llm'] as const

export async function apply(ctx: Context, config: Config): Promise<() => Promise<void>> {
  // PromptGuardServiceImpl extends Service，构造时已 ctx.reflect.provide('promptGuard', this)。
  void new PromptGuardServiceImpl(ctx, config, /* privacyPolicy */ ctx.get('privacyPolicy'),
                                     /* auditLog      */ ctx.get('auditLog'),
                                     /* llm           */ ctx.get('llm'))
  return async () => {}
}
```

#### checkInput 实际流水线
```
1. 长度检查（> maxInputLength → block）
2. 速率限制（per-session + 全局；超限返回 safe=false, riskLevel=high）
3. 注入正则（遍历 rules[]，命中按 action 分级：block/warn/sanitize）
4. privacy-policy.classifyData()；最高级 ≥ secret → 输入 block（secret 一票否决）
5. 模型辅助检测（默认开启）→ 调 ctx.llm.stream() 走 local-llm 语义安全分类
   - fail-open：超时/报错/解析失败 → 不阻断，依赖前序正则+PII 判定
   - 仅 explicit safe:false → block（riskLevel=high）
最终：任一阶段 safe:false → HTTP 400 + 输入拦截
```

#### checkOutput 实际流水线
```
1. 遍历内置 PII 字典（pii-utils）做 regex scan
2. if (sanitized) skipPIIRedaction = true   ← G6
   这是 G6 关键：当 sanitizer-pipeline 已经做过正向脱敏 + 反向还原，
   还原后的文本可能再次含 PII；prompt-guard 在 wasSanitized=true 时不
   再对这部分做 mask（避免「明文还原后又被二次 mask」造成体验偏差）
3. 输出 filtered = 替换后文本 + redacted[] 列表（供 http-api 上报）
```

#### 配置 schema（cordis.yml 当前可声明）
```yaml
prompt-guard:
  maxInputLength: 10000
  maxRequestsPerMinute: 20
  enablePIIRedaction: true
  enableInjectionDetection: true
  enableRateLimit: true
  rules:
    - name: "ignore-previous"      # 注意：实装字段名是 name，不是 id
      pattern: "(忽略|无视|忘记).*(之前|上面).*(指令|规则|提示)"
      action: "block"
    - name: "role-override"
      pattern: "你现在(是|扮演|假装是)"
      action: "warn"
    # …可继续追加任意条；每个 action 独立审计
  enableModelDetection: true        # 默认 true，使用 local-llm 做语义安全分类（fail-open）
  modelDetectionProvider: "local-llm"
  modelDetectionModel: "qwen3-4b"
  modelDetectionTimeoutMs: 4000
```

#### 实装未覆盖项 / 与原设计的差异
- `sanitize` action：schema 已声明，运行时会抛 `not-implemented`。重写路径后续在 Phase 5/6 计划中处理。
- `addInputRule` / `addOutputRule`：实装走 cordis.yml 静态加载 + `start()` 时初始化，无运行时热添加 API。
- `redact` / `block` action 仅在输出侧使用（输入侧只有 `block / warn`）；当前实装忽略 outputRules 静态集，输出 PII 走 `pii-utils` 内置 + `redactString()`。

---

### 2.7 model-router 插件（多模型路由）

替代原来 intent-router 中硬编码的模型选择逻辑。根据意图分类结果、负载情况和策略约束，智能选择最优模型。

> **重要变更**：本插件是 `llm` service 在**主 Context** 中的唯一 Provider。两个底层 provider（`local-llm-provider`、`cloud-llm-provider`）位于各自的 isolated realm 中，本插件持有两个子 ctx 引用并对外提供统一的 `chat` / `chatStream` 接口，DSH Agent Loop 与其他插件**仅需依赖 `ctx.llm` 即可**。这样既避免同名 `llm` 冲突，又保持对调用方的透明。

#### 插件元信息
```yaml
name: model-router
type: middleware
inject:
  - local-llm-realm    # 注入 isolated 子 ctx（含 llm provider，仅供本地使用）
  - cloud-llm-realm    # 注入 isolated 子 ctx（含 llm provider，仅供云端使用）
  - privacy-policy
  - audit-log
  - config
```

#### 接口定义
```typescript
interface ModelRouterConfig {
  // 可用模型列表
  models: ModelEntry[]
  // 默认模型
  defaultModel: string
  // 是否启用负载均衡
  enableLoadBalancing: boolean
  // 模型健康检查间隔（毫秒）
  healthCheckInterval: number
}

interface ModelEntry {
  name: string
  provider: 'local' | 'cloud'
  capabilities: string[]    // 如 ['chat', 'embedding', 'routing']
  maxContextSize: number
  // 策略约束
  allowedDataLevels: string[]  // 如 ['public', 'internal']
  // 优先级（数值越小优先级越高）
  priority: number
}

interface ModelRouterService {
  // 根据意图和数据分类选择模型
  selectModel(intent: IntentResult, dataLevel?: string): Promise<string>

  // 获取模型信息
  getModelInfo(name: string): ModelEntry | undefined

  // 获取所有可用模型
  listModels(): ModelEntry[]

  // 报告模型健康状态
  reportHealth(name: string, healthy: boolean): void
}
```

#### 核心实现
```typescript
export const inject = ['local-llm-realm', 'cloud-llm-realm', 'privacy-policy', 'audit-log', 'config']

export function apply(ctx: Context, config: ModelRouterConfig) {
  ctx.effect(() => {
    const healthStatus = new Map<string, { healthy: boolean; lastCheck: number }>()

    // 初始化健康状态
    for (const model of config.models) {
      healthStatus.set(model.name, { healthy: true, lastCheck: Date.now() })
    }

    /**
     * 内部：根据选中的模型名解析到底层 provider
     * - qwen3-4b / 本地模型  → ctx['local-llm-realm'].llm
     * - deepseek-chat / 云端模型 → ctx['cloud-llm-realm'].llm
     */
    function resolveProvider(modelName: string): LlmProvider {
      const meta = config.models.find(m => m.name === modelName)
      if (!meta) throw new Error(`未知模型: ${modelName}`)
      if (meta.provider === 'local') return ctx['local-llm-realm'].llm
      if (meta.provider === 'cloud') return ctx['cloud-llm-realm'].llm
      throw new Error(`不支持的 provider 类型: ${meta.provider}`)
    }

    /**
     * 统一对外的 llm service 接口（DSH Agent Loop 调用 ctx.llm 时命中此实现）
     * - 根据 options.realm 或 dataLevel 自动路由到对应 isolated realm 中的底层 provider
     */
    const unifiedLlm: LlmProvider = {
      name: 'model-router',
      realm: 'any',

      async chat(messages, options) {
        // 1. 根据 intent 选出模型名（由调用方通过 options.intent 传入）
        const modelName = options?.modelName
          ?? (await service.selectModel(
            options?.intent ?? { category: 'LOCAL', confidence: 1, reasoning: 'default', targetRealm: 'local' },
            options?.dataLevel,
          ))
        const provider = resolveProvider(modelName)
        return await provider.chat(messages, options)
      },

      async *chatStream(messages, options) {
        const modelName = options?.modelName
          ?? (await service.selectModel(
            options?.intent ?? { category: 'LOCAL', confidence: 1, reasoning: 'default', targetRealm: 'local' },
            options?.dataLevel,
          ))
        const provider = resolveProvider(modelName)
        yield* provider.chatStream(messages, options)
      },
    }

    const service: ModelRouterService = {
      async selectModel(intent, dataLevel) {
        const constraints = ctx['privacy-policy'].getConstraints()

        // 候选模型过滤
        let candidates = config.models.filter(m => {
          // 健康检查
          const health = healthStatus.get(m.name)
          if (!health?.healthy) return false

          // 数据级别约束
          if (dataLevel && !m.allowedDataLevels.includes(dataLevel)) {
            return false
          }

          // REJECT 意图不需要模型
          if (intent.category === 'REJECT') return false

          // LOCAL 意图只能用本地模型
          if (intent.category === 'LOCAL' && m.provider !== 'local') {
            return false
          }

          // CLOUD/SANITIZED 意图优先云端模型
          // 但如果云端请求已达上限，降级到本地
          if (intent.category === 'CLOUD' || intent.category === 'SANITIZED') {
            // 允许本地和云端
          }

          return true
        })

        if (candidates.length === 0) {
          // 降级：使用默认模型（如果存在）
          const defaultModel = config.models.find(m => m.name === config.defaultModel)
          if (defaultModel) {
            ctx['audit-log'].log({
              level: 'warning',
              type: 'model-router-fallback',
              action: 'using-default-model',
              plugin: 'model-router',
              metadata: { intent: intent.category, defaultModel: config.defaultModel },
              dataExfiltrated: false,
              sanitized: false,
              success: true,
            })
            return config.defaultModel
          }
          throw new Error('没有可用的模型')
        }

        // 按优先级排序
        candidates.sort((a, b) => a.priority - b.priority)

        // 如果启用负载均衡，在同优先级中选择负载最低的
        if (config.enableLoadBalancing && candidates.length > 1) {
          // 简单策略：优先选择本地模型（减少云端依赖）
          const localCandidates = candidates.filter(m => m.provider === 'local')
          if (localCandidates.length > 0) {
            return localCandidates[0].name
          }
        }

        return candidates[0].name
      },

      getModelInfo(name) {
        return config.models.find(m => m.name === name)
      },

      listModels() {
        return [...config.models]
      },

      reportHealth(name, healthy) {
        healthStatus.set(name, { healthy, lastCheck: Date.now() })
        ctx.event.emit('model-router/health-changed', { name, healthy })
      },
    }

    // 同时提供 model-router（给其他插件用）和 llm（给 DSH Agent Loop 用）
    const disposeRouter = ctx.provide('model-router', service)
    const disposeLlm = ctx.provide('llm', unifiedLlm)
    return async () => {
      disposeLlm()
      disposeRouter()
    }
  })
}
```

#### 配置 schema
```yaml
model-router:
  defaultModel: qwen3-4b
  enableLoadBalancing: true
  healthCheckInterval: 30000
  models:
    - name: qwen3-4b
      provider: local
      capabilities: [chat, routing, embedding]
      maxContextSize: 4096
      allowedDataLevels: [public, internal, confidential, secret]
      priority: 1
    - name: deepseek-chat
      provider: cloud
      capabilities: [chat]
      maxContextSize: 65536
      allowedDataLevels: [public]
      priority: 10
    - name: qwen3-1.5b
      provider: local
      capabilities: [routing]
      maxContextSize: 2048
      allowedDataLevels: [public, internal, confidential, secret]
      priority: 5
```

---

### 2.8 attestation 插件（远程证明）

基于 TEE 的远程证明，让用户可以验证智能体运行环境的安全性。

#### 插件元信息
```yaml
name: attestation
type: service
inject:
  - tcm
  - config
  - audit-log
```

#### 接口定义
```typescript
interface AttestationConfig {
  // 证明服务 URL
  verificationServiceUrl: string
  // 证明缓存时间（毫秒）
  attestationCacheTTL: number
  // 是否启动时自动证明
  attestOnStartup: boolean
}

interface AttestationService {
  // 生成证明令牌
  generateToken(nonce: string): Promise<AttestationToken>

  // 验证当前环境
  verify(): Promise<VerificationResult>

  // 获取证明状态
  getStatus(): AttestationStatus
}

interface AttestationToken {
  nonce: string
  teeType: string
  measurements: Record<string, string>  // PCR 值 / 度量值
  signature: Uint8Array
  timestamp: number
}

interface VerificationResult {
  verified: boolean
  teeValid: boolean
  measurementsMatch: boolean
  details: string
}
```

#### 核心实现
```typescript
export const inject = ['tcm', 'config', 'audit-log']

export function apply(ctx: Context, config: AttestationConfig) {
  ctx.effect(() => {
    let cachedToken: AttestationToken | null = null
    let lastVerification: VerificationResult | null = null

    const service: AttestationService = {
      async generateToken(nonce) {
        // 通过 TCM 生成证明令牌
        const token = await ctx.tcm.generateAttestation(nonce)

        cachedToken = token
        ctx.event.emit('attestation/token-generated', { nonce })
        return token
      },

      async verify() {
        // 生成新的证明令牌
        const nonce = crypto.randomUUID()
        const token = await this.generateToken(nonce)

        // 发送到验证服务
        try {
          const response = await fetch(config.verificationServiceUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              nonce,
              token: encodeBase64(token),
            }),
          })

          const result: VerificationResult = await response.json()
          lastVerification = result

          ctx['audit-log'].log({
            level: result.verified ? 'info' : 'security',
            type: 'attestation-verification',
            action: result.verified ? 'verified' : 'verification-failed',
            plugin: 'attestation',
            metadata: {
              teeValid: result.teeValid,
              measurementsMatch: result.measurementsMatch,
            },
            dataExfiltrated: false,
            sanitized: false,
            success: result.verified,
          })

          return result
        } catch (error) {
          return {
            verified: false,
            teeValid: false,
            measurementsMatch: false,
            details: `验证服务不可达: ${error.message}`,
          }
        }
      },

      getStatus() {
        return {
          lastVerified: lastVerification?.verified ?? false,
          lastVerificationTime: lastVerification ? Date.now() : null,
          cachedTokenExists: cachedToken !== null,
        }
      },
    }

    // 启动时自动证明
    if (config.attestOnStartup) {
      service.verify().then(result => {
        if (!result.verified) {
          console.warn('远程证明失败:', result.details)
        }
      })
    }

    const dispose = ctx.provide('attestation', service)
    return async () => { dispose() }
  })
}
```

#### 配置 schema
```yaml
attestation:
  verificationServiceUrl: https://attest.example.com/verify
  attestationCacheTTL: 3600000
  attestOnStartup: true
```

---

### 2.9 ohttp-gateway 插件（Oblivious HTTP 网关）

实现 RFC 9458 Oblivious HTTP，确保端云通信中网关无法关联用户身份与请求内容。

#### 插件元信息
```yaml
name: ohttp-gateway
type: service
inject:
  - tcm
  - config
  - audit-log
```

#### 接口定义
```typescript
interface OhttpGatewayConfig {
  // Relay 服务器地址
  relayUrl: string
  // Target 服务器地址（DeepSeek API）
  targetUrl: string
  // OHTTP 密钥配置 URL
  keyConfigUrl: string
  // 请求超时（毫秒）
  timeout: number
}

interface OhttpGatewayService {
  // 通过 OHTTP 发送请求
  sendRequest(request: OhttpRequest): Promise<OhttpResponse>

  // 获取 OHTTP 密钥配置
  getKeyConfig(): Promise<OhttpKeyConfig>
}

interface OhttpRequest {
  method: string
  url: string
  headers: Record<string, string>
  body: string
}

interface OhttpResponse {
  status: number
  headers: Record<string, string>
  body: string
}
```

#### 核心实现
```typescript
export const inject = ['tcm', 'config', 'audit-log']

export function apply(ctx: Context, config: OhttpGatewayConfig) {
  ctx.effect(() => {
    let keyConfig: OhttpKeyConfig | null = null

    const service: OhttpGatewayService = {
      async getKeyConfig() {
        if (keyConfig && Date.now() - keyConfig.fetchedAt < 3600000) {
          return keyConfig
        }

        const response = await fetch(config.keyConfigUrl)
        keyConfig = {
          ...await response.json(),
          fetchedAt: Date.now(),
        }
        return keyConfig
      },

      async sendRequest(request) {
        const kc = await this.getKeyConfig()

        // 1. 构造内层请求（Target 看到的）
        const innerRequest = {
          method: request.method,
          url: request.url,
          headers: {
            ...request.headers,
            // 内层不携带任何身份标识
            'Authorization': request.headers['Authorization'],
          },
          body: request.body,
        }

        // 2. 使用 OHTTP 密钥加密内层请求
        const encryptedInner = await ohttpEncrypt(innerRequest, kc)

        // 3. 构造外层请求（Relay 看到的）
        // Relay 只能看到外层请求，无法解密内层内容
        const outerRequest = {
          method: 'POST',
          url: config.relayUrl,
          headers: {
            'Content-Type': 'message/ohttp-req',
            // 外层不携带任何与用户身份相关的信息
            // 使用随机化的标识，防止 Relay 关联请求
          },
          body: encryptedInner,
        }

        ctx.event.emit('ohttp/request-sent', {
          relayUrl: config.relayUrl,
          timestamp: Date.now(),
        })

        // 4. 发送外层请求到 Relay
        const relayResponse = await fetch(outerRequest.url, {
          method: outerRequest.method,
          headers: outerRequest.headers,
          body: outerRequest.body,
          signal: AbortSignal.timeout(config.timeout),
        })

        // 5. 解密响应
        const encryptedResponse = await relayResponse.arrayBuffer()
        const decryptedResponse = await ohttpDecrypt(
          new Uint8Array(encryptedResponse),
          kc
        )

        ctx['audit-log'].log({
          level: 'info',
          type: 'ohttp-request',
          action: 'request-complete',
          plugin: 'ohttp-gateway',
          metadata: {
            relayUrl: config.relayUrl,
            status: decryptedResponse.status,
          },
          dataExfiltrated: true,  // 数据确实出端了
          sanitized: true,        // 但应该已经过脱敏
          success: true,
        })

        return decryptedResponse
      },
    }

    const dispose = ctx.provide('ohttp-gateway', service)
    return async () => { dispose() }
  })
}
```

#### OHTTP 通信流程
```
┌──────────┐         ┌──────────┐         ┌──────────┐
│  端侧    │         │  Relay   │         │  Target  │
│  Agent   │         │  网关    │         │ (DeepSeek)│
└────┬─────┘         └────┬─────┘         └────┬─────┘
     │                    │                    │
     │ 1. 获取 OHTTP 公钥  │                    │
     │───────────────────>│───────────────────>│
     │<───────────────────│<───────────────────│
     │                    │                    │
     │ 2. 加密内层请求      │                    │
     │    (含 API Key)     │                    │
     │                    │                    │
     │ 3. 外层请求         │                    │
     │    (无身份信息)      │                    │
     │───────────────────>│                    │
     │                    │ 4. 解密内层请求      │
     │                    │───────────────────>│
     │                    │                    │
     │                    │ 5. 内层响应          │
     │                    │<───────────────────│
     │ 6. 外层响应         │                    │
     │<───────────────────│                    │
     │                    │                    │
     │ 7. 解密响应         │                    │
     │                    │                    │

Relay 视角：看到加密的外层请求，不知道内容，不知道目标
Target 视角：看到内层请求，知道 API Key，但不知道请求来自哪个用户设备
```

#### 配置 schema
```yaml
ohttp-gateway:
  relayUrl: https://relay.example.com/ohttp
  targetUrl: https://api.deepseek.com/v1
  keyConfigUrl: https://api.deepseek.com/.well-known/ohttp-keys
  timeout: 30000
```

---

### 2.10 secure-bridge 插件（端云安全通信桥）

整合 OHTTP、TLS、请求审计，提供统一的端云安全通信接口。

#### 插件元信息
```yaml
name: secure-bridge
type: service
inject:
  - tcm
  - ohttp-gateway
  - privacy-policy
  - audit-log
  - config
```

#### 接口定义
```typescript
interface SecureBridgeConfig {
  // 通信模式：ohttp（零信任）或 direct-tls（直连）
  mode: 'ohttp' | 'direct-tls'
  // 直连模式下的 TLS 配置
  directTls?: {
    verifyCertificate: boolean
    pinCertificates: string[]   // 证书固定
  }
  // 请求重试配置
  retry: {
    maxRetries: number
    backoffMs: number
  }
}

interface SecureBridgeService {
  // 发送云端请求（自动选择 OHTTP 或直连 TLS）
  sendCloudRequest(request: CloudRequest): Promise<CloudResponse>

  // 获取通信状态
  getStatus(): BridgeStatus
}

interface CloudRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: string
  // 数据分类级别（决定是否允许发送）
  dataLevel: string
  // 是否已经过脱敏
  sanitized: boolean
}
```

#### 核心实现
```typescript
export const inject = ['tcm', 'ohttp-gateway', 'privacy-policy', 'audit-log', 'config']

export function apply(ctx: Context, config: SecureBridgeConfig) {
  ctx.effect(() => {
    const service: SecureBridgeService = {
      async sendCloudRequest(request) {
        // 1. 策略检查：是否允许发送
        const constraints = ctx['privacy-policy'].getConstraints()
        if (request.dataLevel !== 'public' && !request.sanitized) {
          throw new SecurityError('非公开数据必须经过脱敏后才能发送到云端')
        }

        // 2. 根据模式选择通信通道
        let response: CloudResponse

        if (config.mode === 'ohttp') {
          // 通过 OHTTP 发送（零信任）
          response = await ctx['ohttp-gateway'].sendRequest({
            method: request.method,
            url: request.url,
            headers: request.headers,
            body: request.body,
          })
        } else {
          // 直连 TLS（证书固定）
          response = await sendDirectTls(request, config.directTls!)
        }

        // 3. 审计
        ctx['audit-log'].log({
          level: 'info',
          type: 'cloud-request',
          action: 'request-complete',
          plugin: 'secure-bridge',
          realm: request.sanitized ? 'sanitized' : 'cloud',
          metadata: {
            url: request.url,
            dataLevel: request.dataLevel,
            sanitized: request.sanitized,
            mode: config.mode,
          },
          dataExfiltrated: true,
          sanitized: request.sanitized,
          success: true,
        })

        return response
      },

      getStatus() {
        return {
          mode: config.mode,
          ohttpAvailable: config.mode === 'ohttp',
          lastRequestTime: null,
        }
      },
    }

    const dispose = ctx.provide('secure-bridge', service)
    return async () => { dispose() }
  })
}
```

#### 配置 schema
```yaml
secure-bridge:
  mode: ohttp
  directTls:
    verifyCertificate: true
    pinCertificates:
      - "sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
  retry:
    maxRetries: 2
    backoffMs: 1000
```

---

### 2.11 td-bus 插件（威胁检测总线）

持续监控所有插件的行为，检测异常模式并自动响应。

#### 插件元信息
```yaml
name: td-bus
type: middleware
inject:
  - audit-log
  - privacy-policy
  - config
```

#### 接口定义
```typescript
interface TdBusConfig {
  // 检测规则
  detectionRules: DetectionRule[]
  // 响应动作
  responseActions: ResponseAction[]
  // 检测窗口（毫秒）
  detectionWindow: number
  // 是否启用自动响应
  enableAutoResponse: boolean
}

interface DetectionRule {
  id: string
  description: string
  // 检测条件
  condition: {
    eventType: string
    field?: string
    operator: 'equals' | 'gt' | 'lt' | 'contains' | 'count_gt'
    value: any
    windowMs?: number
  }
  severity: 'low' | 'medium' | 'high' | 'critical'
  // 触发的响应动作 ID
  responseActionIds: string[]
}

interface ThreatDetectionService {
  // 获取当前威胁状态
  getThreatLevel(): ThreatLevel
  // 获取最近的威胁事件
  getRecentThreats(): ThreatEvent[]
  // 手动触发响应
  triggerResponse(actionId: string): Promise<void>
}
```

#### 核心实现
```typescript
export const inject = ['audit-log', 'privacy-policy', 'config']

export function apply(ctx: Context, config: TdBusConfig) {
  ctx.effect(() => {
    const recentThreats: ThreatEvent[] = []
    const eventCounts = new Map<string, { count: number; resetAt: number }>()
    let currentThreatLevel: ThreatLevel = 'normal'

    // 订阅所有事件进行检测
    const eventTypes = [
      'tools/call-started',
      'tools/realm-violation',
      'session/created',
      'policy/tamper-detected',
      'input-threat-detected',
      'ohttp/request-sent',
    ]

    const unsubscribers = eventTypes.map(eventType =>
      ctx.event.on(eventType, (payload) => {
        detect(eventType, payload)
      })
    )

    function detect(eventType: string, payload: any) {
      for (const rule of config.detectionRules) {
        if (rule.condition.eventType !== eventType) continue

        let triggered = false

        switch (rule.condition.operator) {
          case 'count_gt':
            const key = `${rule.id}:${eventType}`
            const counter = eventCounts.get(key) ?? {
              count: 0,
              resetAt: Date.now() + (rule.condition.windowMs ?? config.detectionWindow),
            }
            if (Date.now() > counter.resetAt) {
              counter.count = 0
              counter.resetAt = Date.now() + (rule.condition.windowMs ?? config.detectionWindow)
            }
            counter.count++
            eventCounts.set(key, counter)
            triggered = counter.count > rule.condition.value
            break

          case 'equals':
            triggered = payload[rule.condition.field!] === rule.condition.value
            break

          case 'contains':
            triggered = String(payload[rule.condition.field!]).includes(rule.condition.value)
            break
        }

        if (triggered) {
          const threat: ThreatEvent = {
            id: generateId(),
            ruleId: rule.id,
            description: rule.description,
            severity: rule.severity,
            timestamp: Date.now(),
            payload,
          }

          recentThreats.push(threat)
          updateThreatLevel()

          ctx['audit-log'].log({
            level: rule.severity === 'critical' ? 'security' : 'warning',
            type: 'threat-detected',
            action: rule.id,
            plugin: 'td-bus',
            metadata: {
              ruleId: rule.id,
              severity: rule.severity,
              eventType,
            },
            dataExfiltrated: false,
            sanitized: false,
            success: false,
          })

          // 自动响应
          if (config.enableAutoResponse) {
            for (const actionId of rule.responseActionIds) {
              executeResponseAction(actionId)
            }
          }
        }
      }
    }

    function updateThreatLevel() {
      const recent = recentThreats.filter(
        t => Date.now() - t.timestamp < config.detectionWindow
      )
      const criticalCount = recent.filter(t => t.severity === 'critical').length
      const highCount = recent.filter(t => t.severity === 'high').length

      if (criticalCount > 0) {
        currentThreatLevel = 'critical'
      } else if (highCount >= 3) {
        currentThreatLevel = 'high'
      } else if (highCount > 0) {
        currentThreatLevel = 'elevated'
      } else {
        currentThreatLevel = 'normal'
      }

      ctx.event.emit('td-bus/threat-level-changed', { level: currentThreatLevel })
    }

    function executeResponseAction(actionId: string) {
      const action = config.responseActions.find(a => a.id === actionId)
      if (!action) return

      switch (action.type) {
        case 'block-cloud':
          // 阻断所有云端请求
          ctx.event.emit('td-bus/block-cloud-requests', { reason: actionId })
          break
        case 'kill-session':
          // 终止当前会话
          ctx.event.emit('td-bus/kill-session', { reason: actionId })
          break
        case 'notify-user':
          // 通知用户
          ctx.event.emit('td-bus/user-notification', {
            message: action.message,
            severity: action.severity,
          })
          break
        case 'lockdown':
          // 全面锁定：停止所有云端通信，仅保留本地功能
          ctx.event.emit('td-bus/lockdown', { reason: actionId })
          break
      }
    }

    const service: ThreatDetectionService = {
      getThreatLevel() {
        return currentThreatLevel
      },

      getRecentThreats() {
        return [...recentThreats]
      },

      async triggerResponse(actionId) {
        executeResponseAction(actionId)
      },
    }

    const dispose = ctx.provide('td-bus', service)
    return async () => {
      unsubscribers.forEach(u => u())
      dispose()
    }
  })
}
```

#### 配置 schema
```yaml
td-bus:
  detectionWindow: 300000        # 5 分钟检测窗口
  enableAutoResponse: true
  detectionRules:
    - id: "frequent-cloud-requests"
      description: "短时间内大量云端请求"
      condition:
        eventType: "ohttp/request-sent"
        operator: "count_gt"
        value: 20
        windowMs: 60000
      severity: "high"
      responseActionIds: ["block-cloud", "notify-user"]

    - id: "realm-violation-spike"
      description: "频繁的 Realm 越权访问"
      condition:
        eventType: "tools/realm-violation"
        operator: "count_gt"
        value: 5
        windowMs: 60000
      severity: "critical"
      responseActionIds: ["lockdown", "notify-user"]

    - id: "policy-tamper"
      description: "策略文件被篡改"
      condition:
        eventType: "policy/tamper-detected"
        operator: "equals"
        field: "detected"
        value: true
      severity: "critical"
      responseActionIds: ["lockdown", "notify-user"]

    - id: "input-attack-spike"
      description: "频繁的输入攻击"
      condition:
        eventType: "input-threat-detected"
        operator: "count_gt"
        value: 10
        windowMs: 300000
      severity: "high"
      responseActionIds: ["notify-user"]

  responseActions:
    - id: "block-cloud"
      type: "block-cloud"
      message: "检测到异常云端请求，已临时阻断云端通信"

    - id: "kill-session"
      type: "kill-session"
      message: "检测到安全威胁，当前会话已终止"

    - id: "notify-user"
      type: "notify-user"
      message: "检测到潜在安全威胁，请注意"

    - id: "lockdown"
      type: "lockdown"
      message: "检测到严重安全威胁，系统已进入安全锁定模式"
```

---

### 2.12 voice-input 插件（语音输入）

#### 插件元信息
```yaml
name: voice-input
type: tool
inject:
  - config
```

#### 接口定义
```typescript
interface VoiceInputConfig {
  engine: string
  modelPath: string
  sampleRate: number
  language: string
  vadEnabled: boolean
}

interface VoiceInputService {
  transcribeFile(audioBuffer: ArrayBuffer): Promise<string>
  transcribeStream(stream: ReadableStream): AsyncIterable<string>
}
```

#### 核心实现
```typescript
export const inject = ['config']

export function apply(ctx: Context, config: VoiceInputConfig) {
  ctx.effect(() => {
    const service: VoiceInputService = {
      async transcribeFile(audioBuffer) {
        ctx.event.emit('voice/transcription-started', {
          bufferSize: audioBuffer.byteLength,
        })

        const result = await transcribeWithWhisper(audioBuffer, {
          modelPath: config.modelPath,
          sampleRate: config.sampleRate,
          language: config.language,
        })

        ctx.event.emit('voice/transcription-complete', {
          text: result.text,
          confidence: result.confidence,
          duration: result.duration,
        })

        return result.text
      },

      async *transcribeStream(stream) {
        // VAD + 流式转写
        const chunks = splitByVad(stream)
        for await (const chunk of chunks) {
          const text = await this.transcribeFile(chunk)
          if (text.trim()) yield text
        }
      },
    }

    const dispose = ctx.provide('voice-input', service)
    return async () => { dispose() }
  })
}
```

#### 配置 schema
```yaml
voice-input:
  engine: whisper-local
  modelPath: /models/whisper-tiny-q8.bin
  sampleRate: 16000
  language: zh
  vadEnabled: true
```

---

### 2.13 local-llm-provider 插件（本地 LLM）

> **关键说明**：本插件在 `local-llm-realm`（通过 `cordis:group` + `isolate: { llm: true }` 建立的独立 realm）中提供 `llm` 服务，避免与 `cloud-llm-provider` 的同名 `llm` 服务冲突（DSH Cordis 规范：每个 registry 内同 key 只允许一个 Provider；通过 `isolate` 可在子 Context 中为同名 service 建立独立 realm）。

#### 插件元信息
```yaml
name: local-llm-provider
type: llm-provider
inject:
  - config
```

#### 接口定义
```typescript
interface LocalLlmConfig {
  backend: string
  modelPath: string
  modelName: string
  contextSize: number
  gpuLayers: number
  threads: number
  temperature: number
}
```

#### 核心实现
```typescript
export const inject = ['config']

export function apply(ctx: Context, config: LocalLlmConfig) {
  ctx.effect(() => {
    const provider: LlmProvider = {
      name: config.modelName,
      realm: 'local',

      async chat(messages, options) {
        ctx.event.emit('llm/local-inference-started', {
          model: config.modelName,
          messageCount: messages.length,
        })

        const result = await llamaCpp.chat(messages, {
          model: config.modelPath,
          contextSize: config.contextSize,
          gpuLayers: config.gpuLayers,
          threads: config.threads,
          temperature: options?.temperature ?? config.temperature,
          tools: options?.tools,
        })

        ctx.event.emit('llm/local-inference-complete', {
          model: config.modelName,
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
        })

        return result
      },

      async *chatStream(messages, options) {
        yield* llamaCpp.chatStream(messages, {
          model: config.modelPath,
          contextSize: config.contextSize,
          threads: config.threads,
          temperature: options?.temperature ?? config.temperature,
        })
      },
    }

    // 在 local-llm-realm（isolated ctx）中 provide 'llm' 服务
    const dispose = ctx.provide('llm', provider)
    return async () => { dispose() }
  })
}
```

#### 挂载位置（cordis.yml）

> 本插件**必须**挂在 `local-llm-realm` 组的 isolated 子 ctx 下，使其 `llm` 服务仅在该 realm 内可见：

```yaml
plugins:
  - id: local-llm-realm
    name: cordis:group
    group: true
    isolate:
      llm: true    # 为本子树建立独立的 llm realm
    config:
      - name: local-llm-provider
        inject: [config]
        # 在该 isolated 子 ctx 中 provide 'llm'
```

#### 配置 schema
```yaml
local-llm-provider:
  backend: llama-cpp
  modelPath: /models/qwen3-4b-q4_k_m.gguf
  modelName: qwen3-4b
  contextSize: 4096
  gpuLayers: 0
  threads: 4
  temperature: 0.7
```

---

### 2.14 cloud-llm-provider 插件（云端 LLM）

> **关键说明**：本插件在 `cloud-llm-realm`（通过 `cordis:group` + `isolate: { llm: true }` 建立的独立 realm）中提供 `llm` 服务，与 `local-llm-provider` 同名但完全隔离。DSH Cordis 规范允许通过 `isolate` 在不同子 Context 中为同名 service 建立独立 realm，按需激活。

#### 插件元信息
```yaml
name: cloud-llm-provider
type: llm-provider
inject:
  - secure-bridge
  - config
  - audit-log
```

#### 核心实现
```typescript
export const inject = ['secure-bridge', 'config', 'audit-log']

export function apply(ctx: Context, config: CloudLlmConfig) {
  ctx.effect(() => {
    const rateLimiter = new RateLimiter(config.rateLimitRPM)

    const provider: LlmProvider = {
      name: config.model,
      realm: 'cloud',

      async chat(messages, options) {
        if (!rateLimiter.tryAcquire()) {
          throw new RateLimitError('云端 LLM 请求频率超限')
        }

        ctx.event.emit('llm/cloud-inference-started', {
          model: config.model,
          messageCount: messages.length,
        })

        // 通过 secure-bridge 发送请求
        const response = await ctx['secure-bridge'].sendCloudRequest({
          url: `${config.baseUrl}/chat/completions`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            model: config.model,
            messages,
            max_tokens: options?.maxTokens ?? config.maxTokens,
            temperature: options?.temperature ?? config.temperature,
            tools: options?.tools?.map(formatToolForApi),
          }),
          dataLevel: options?.dataLevel ?? 'public',
          sanitized: options?.sanitized ?? false,
        })

        const result = parseApiResponse(response)

        ctx.event.emit('llm/cloud-inference-complete', {
          model: config.model,
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
        })

        return result
      },

      async *chatStream(messages, options) {
        yield* cloudChatStream(messages, config, ctx['secure-bridge'], options)
      },
    }

    // 在 cloud-llm-realm（isolated ctx）中 provide 'llm' 服务
    const dispose = ctx.provide('llm', provider)
    return async () => { dispose() }
  })
}
```

#### 挂载位置（cordis.yml）

> 本插件**必须**挂在 `cloud-llm-realm` 组的 isolated 子 ctx 下，使其 `llm` 服务仅在该 realm 内可见，与 `local-llm-realm` 中的 `llm` 互不冲突：

```yaml
plugins:
  - id: cloud-llm-realm
    name: cordis:group
    group: true
    isolate:
      llm: true    # 为本子树建立独立的 llm realm
    config:
      - name: cloud-llm-provider
        inject: [secure-bridge, config, audit-log]
        # 在该 isolated 子 ctx 中 provide 'llm'
```

> **注意**：DSH Loader 会把每个 `group: true` 的子树创建为一个 isolated Fiber，并把 Fiber 对应的子 ctx 作为 service 暴露给父 Fiber 的 ctx（即 `ctx['local-llm-realm']` 和 `ctx['cloud-llm-realm']` 在 model-router 中可直接通过 `inject` 拿到，访问其内部的 `llm` service）。

#### 配置 schema
```yaml
cloud-llm-provider:
  provider: deepseek
  apiKey: ${DEEPSEEK_API_KEY}
  baseUrl: https://api.deepseek.com/v1
  model: deepseek-chat
  maxTokens: 4096
  temperature: 0.7
  timeout: 30000
  retryCount: 2
  rateLimitRPM: 30
```

---

### 2.15 intent-router 插件（意图路由）

按 `ctx.llm` 输出与 policy 双源 `matchRouting` 把用户请求路由到 **LOCAL / CLOUD / SANITIZED / REJECT** 四类 realm，并把意图作为后续 agent loop 的入口参数。

**v0.1.0 关键 trade-off**(架构级决策):

- **LLM-first → rules fallback**(不是「rules → LLM」瀑布)。低置信度时 fallback 到 keyword rules(**fail-open**,不是 fail-closed)。
- **三层防御纵深**(职责分离):http-api 调用 intent-router 之前先经 prompt-guard 正则模式库(攻击模式 → HTTP 400)+ 本地 qwen3-4b 模型辅助检测(复杂攻击,fail-open);intent-router 自身的 privacy-policy REJECT 规则(业务危险操作 → HTTP 403)。三层各司其职:prompt-guard 专注攻击模式(注入/提词/越狱/角色覆盖/数据外传),privacy-policy REJECT 专注业务危险操作(破坏性命令/数据库删除)。
- **`softService()` 软依赖**:对 privacyPolicy / modelRouter / sanitizer / piiUtils 采用 dual-mode 查找——Cordis 运行时用 `ctx.get()`(不在 inject 中时返回 undefined 而非 throw),单元测试裸 mock 用直接属性访问。保证在缺失或 mock 场景下均不崩溃。
- **配置 schema 浮点化**:`confidenceThreshold` 是 0..1 浮点(`Schema.number().min(0).max(1)`),由 commit `18d247d` 修复 `Schema.natural()` 拒绝 `0.6` 的 bug。
- **隐私侧额外防线**:分类 LLM 解析到 realm=CLOUD 时,先 `sanitizer.sanitize()` 再喂 LLM——**分类请求也带 PII 不出端**。

#### 插件元信息
```yaml
name: intent-router
type: middleware
inject:
  - llm
  - audit-log          # privacy-policy / model-router / sanitizer / piiUtils 走 softService() 懒查(不在 inject)
```

#### 与相邻插件的关系(架构级)

| 上游 | 协同 |
|------|------|
| `http-api` | 调用 `classify(text)`;REJECT → HTTP 403 short-circuit;Intent 作为 SSE 首帧 (`type: "intent"`) 返回 |
| `prompt-guard` | 调用前先经 prompt-guard 正则模式库(攻击 → HTTP 400)+ 本地 LLM 模型检测(复杂攻击,fail-open) |
| `privacy-policy` | `matchRouting()` pre-check 命中 REJECT 短路;fallback 路径命中返回 verdict(REALM_LOCAL/CLOUD/SANITIZED) |
| `sanitizer` | CLOUD 分类前 `sanitize()`,分类请求自身也带 PII 不出端 |

| 下游 | 用法 |
|------|------|
| `tools` | `filterTools(intent)` / `isToolAllowed(name, intent)` 实现 realm 级别工具隔离(REJECT → 空工具列表) |
| `td-bus` | 威胁检测总线消费 Intent 进行异常行为分析(规划中,尚未接入主链路) |
| `audit-log` | 每次分类触发 `intent.classify.start` / `intent.classify.end` / `intent.rules.rejected`(security 级) / `intent.classify.truncated`(warn 级) |

#### 设计意图 vs 实现的差异
| 维度 | 原 v6 设计 | 当前实现 | 原因 |
|---|---|---|---|
| 顺序 | rules → LLM → confidence | **LLM-first → rules fallback** | qwen3-4b 在规则路径下经常被强力 regex 反向劫持;先让 LLM 拿 verdict,规则只做兜底更稳 |
| 低置信度 | fail-closed → REJECT | **fail-open → rules/defaultCategory** | qwen3-4b 置信度抖动较大;REJECT 误拒率不可接受 |
| 输入防护 | 单层 | **三层防御**:prompt-guard 正则(零 token)+ prompt-guard 本地 LLM(fail-open)+ privacy-policy REJECT(零 token) | 纵深防御,即使一层漏过另一层仍可阻断 |
| `inject` | `['llm','privacy-policy','model-router','prompt-guard','audit-log','config']` | **`['llm','auditLog']`**(其它走 `softService()` 懒查) | v6 §7 明确规定 inject 不列 `config`;privacy-policy/model-router/sanitizer 在 intent-router 之后 boot,必须懒查 |
| 软依赖访问 | `ctx.xxx` 直接访问 | **`softService(name)`** dual-mode:Cordis `ctx.get()` / mock 直接属性 | Cordis `ctx.xxx` 对非 inject 服务会 throw;`softService()` 兼容运行时和单元测试 |
| `ctx.llm.chat()` | 直接调用 | **`ctx.llm.stream({ signal })`** | v6 §11.2 row 4;DSH `LlmAdapter { stream }` |
| REJECT 来源 | 仅 prompt-guard | **policy pre-check + fallback rule 两条路径** | LLM 分类只产出 LOCAL/CLOUD;REJECT 必经 policy 规则 |
| SANITIZED | LLM verdict | **仅 policy 规则命中** | LLM prompt 模版里不写 SANITIZED 选项 |

#### 配置 schema(cordis.yml 当前形态)
```yaml
intent-router:
  defaultCategory: 'CLOUD'                  # 兜底 category
  classificationProvider: 'local-llm'  # 必须是带前缀的路由 id(modelRouter 解析)
  classificationModel: 'qwen3-4b'
  confidenceThreshold: 0.6                  # 0..1 浮点(18d247d 修复)
  llmTimeoutMs: 4000
  recentMessagesLimit: 3
  maxInputLength: 2000
  fallbackKeywords: []                      # 空时用 EN+CN 内置;非空时整体替换
```

环境覆写:
- `DSH_EDGE_INTENT_LLM_TIMEOUT_MS`
- `DSH_EDGE_INTENT_MAX_INPUT`
- `DSH_EDGE_INTENT_FALLBACK_KEYWORDS` (comma-separated)
- `DSH_EDGE_INTENT_CONFIDENCE_THRESHOLD`

#### 详细信息参考

> **本节仅为架构级概要**(`intent-router` 在插件拓扑中的位置、关键 trade-off、与相邻插件的关系、设计决策表、配置 schema)。完整实装解析 ——
>
> - **核心实现** `classify()` 流水线(195 行 ASCII 树状图,含 `policy pre-check` → `classifyWithLlm` → `classifyWithRules` fallback → 7 种 `_intentRouterReason` 异常分支)
> - **接口定义** `Config` / `Intent` / `IntentRouterService` 完整 TypeScript 定义
> - **关键加固点** `parseClassificationVerdict` 三档解析(Tier 1/2/3 + Tier 3 双命中原因)
> - **Defense-in-depth** `redactPreview()` 审计级文本预览(80 字符上限 + null 降级)
> - **可观测性** `getStats()` 15 个独立计数字段 + G9 10-bucket confidenceHistogram
> - **下游集成** + **软依赖架构**(`softService()` dual-mode 详细说明)
> - **真实环境 e2e 验证**(2026-08-26 实跑 31 个用例,LOCAL/CLOUD/REJECT 完整覆盖)
> - **shipped privacy-policy.json v1.x 修复历史**(v1.0.0 → v1.4.0,含 P0 api-key + P1 phone 截断 id-card 修复)
> - **部署注意事项** + **后续优化项**
>
> —— 详见 **[intent-recognition-routing.md](./intent-and-sanitization.md)**。

---

### 2.16 sanitizer-pipeline 插件（数据脱敏管线）

正向脱敏（PII → 占位符）+ 反向还原（占位符 → PII）+ 会话级映射表。规则由 privacy-policy 动态加载（polled mtime），占位符生成走 session 内 counter。同 session 内同一原始值复用同一占位符（避免描述翻车）。

**关键三入口**：
- `sanitize(text, { sessionId })` —— 入口（http-api `handleChat` / `handleChatStream` 在 `!isLocal` 时调用）
- `desanitize(text, sessionId)` —— 异步反向还原（http-api `handleChat` 整块响应）
- `desanitizeSync(text, sessionId)` —— 同步反向还原（http-api `handleChatStream` 逐 chunk 还原流的必要条件）
- `purge(sessionId)` —— http-api `handleDeleteSession` 时清映射（不删除会泄露到下一会话）

#### 插件元信息
```yaml
name: sanitizer-pipeline
type: middleware
inject:
  - privacy-policy    # 必需
  - audit-log         # audit
```

#### 接口定义
```typescript
export interface Config {
  enableAutoDetection: boolean          // 默认 true（自动用 privacy-policy 规则）
  maxReplacementsPerSession: number    // 默认 1024（防 DoS）
}

export interface Replacement {
  original: string
  placeholder: string
  piiType: string
  dataClass: string
}

export interface SanitizationResult {
  sanitizedText: string
  sessionId: string
  replacements: Replacement[]
}

export interface SanitizerService {
  sanitize(text: string, context?: { sessionId?: string }): Promise<SanitizationResult>
  desanitize(text: string, sessionId: string): Promise<string>
  /** 流式同步反向还原；无 audit log，stream 回调内不能 await */
  desanitizeSync(text: string, sessionId: string): string
  purge(sessionId: string): Promise<void>
  getMappingSize(sessionId: string): number
}
```

#### 核心实现（基于 `src/dsh-adapter/sanitizer-pipeline.ts`）
```typescript
export const inject = ['privacyPolicy', 'auditLog'] as const

interface SessionMapping { counter: number; placeholders: Map<string /* placeholder */, string /* original */> }

export class SanitizerServiceImpl extends Service implements SanitizerService {
  private sessionMappings = new Map<string /* sessionId */, SessionMapping>()

  async sanitize(text, context) {
    const sessionId = context?.sessionId ?? 'default'
    let mapping = this.sessionMappings.get(sessionId) ??
                 (this.sessionMappings.set(sessionId, { counter: 0, placeholders: new Map() }).get(sessionId)!)

    const rules = this.privacyPolicy.getSanitizationRules()   // 每次重取；policy 热重载后下一次生效
    const replacements: Replacement[] = []
    let sanitizedText = text

    for (const rule of rules) {
      try {
        const regex = new RegExp(rule.pattern, 'gi')
        const matches = sanitizedText.match(regex) || []
        for (const match of matches) {
          let placeholder = this.findExistingPlaceholder(mapping, match)   // 同值复用占位符
          if (!placeholder) {
            mapping.counter++
            placeholder = `[${(rule.piiType || 'PII').toUpperCase()}_${mapping.counter}]`
            mapping.placeholders.set(placeholder, match)
          }
          sanitizedText = sanitizedText.replace(match, placeholder)
          replacements.push({ original: match, placeholder, piiType: rule.piiType, dataClass: rule.dataClass })
          if (mapping.placeholders.size >= this.maxReplacementsPerSession) {
            await this.audit('warn', 'sanitizer.limit-reached', { sessionId, limit: this.maxReplacementsPerSession })
            break
          }
        }
      } catch { /* bad regex: skip */ }
    }
    if (replacements.length) {
      await this.audit('info', 'sanitizer.sanitized', { sessionId, replacementCount: replacements.length })
    }
    return { sanitizedText, sessionId, replacements }
  }

  async desanitize(text, sessionId) {
    const mapping = this.sessionMappings.get(sessionId)
    if (!mapping) return text
    let restored = text
    for (const [ph, orig] of mapping.placeholders.entries()) {
      restored = restored.split(ph).join(orig)
    }
    if (restored !== text) await this.audit('debug', 'sanitizer.desanitized', { sessionId })
    return restored
  }

  /** 流式响应专用；无 audit log，handler 同步调用。 */
  desanitizeSync(text, sessionId) {
    const mapping = this.sessionMappings.get(sessionId)
    if (!mapping) return text
    let restored = text
    for (const [ph, orig] of mapping.placeholders.entries()) {
      restored = restored.split(ph).join(orig)
    }
    return restored
  }

  async purge(sessionId) {
    const m = this.sessionMappings.get(sessionId)
    if (m) { this.sessionMappings.delete(sessionId); await this.audit('info', 'sanitizer.purged', { sessionId, purgedMappings: m.placeholders.size }) }
  }
}
```

#### `apply()` 实装
```typescript
export async function apply(ctx: any, config: Config): Promise<() => Promise<void>> {
  const privacyPolicy = ctx.get('privacyPolicy')
  const auditLog      = ctx.get('auditLog')
  const service = new SanitizerServiceImpl(ctx, config, privacyPolicy, auditLog)
  return async () => {
    // 关停时清空所有 session 映射（避免测试 / dev 残留）
    for (const sessionId of service['sessionMappings'].keys()) {
      await service.purge(sessionId)
    }
  }
}
```

#### 与 http-api 的接缝
- `handleChat`（http-api.ts:305-320）：`if (!isLocal && this.sanitizer) { const r = await sanitizer.sanitize(message, { sessionId }); messageToSend = r.sanitizedText; }`；响应时用 `await sanitizer.desanitize(result, sessionId)`
- `handleChatStream`（http-api.ts:470-487）：同上 sanitize；**逐 chunk 还原**：`textToSend = this.sanitizer.desanitizeSync(chunk.text, sessionId)`
- `handleDeleteSession`（http-api.ts:562-566）：`await this.sanitizer.purge(id)`

#### 失败模式（fail-open 关键）
- `sanitize()` 抛错 → http-api **不会阻断**，仅 `audit('error', 'http.chat.sanitize.error', { reqId, sessionId, error })` 然后原文本继续往后端 LLM 送——这是 fail-open 的核心设计点（参 § 1.6.5 决策 5）
- `getMappingSize > maxReplacementsPerSession` → 强制终止本轮 sanitize + audit warn
- 单条 `new RegExp(rule.pattern, 'gi')` 抛错 → catch 跳过该规则（不中断整批）

#### 与原设计的差异
- 占位符模板从 `{index}` 改成 `[<PII_TYPE>_<counter>]`，类型可读、与 piiType 联动；计数从 1 起，同 session 单调递增
- 新增 `maxReplacementsPerSession` 默认 1024（原设计没有）
- 删除 `sessionTimeout`：原设计假设 5 分钟过期，实装仅在 `purge()` 调用时清理（由 http-api session 删除驱动）
- 删除 `position` 字段：实装用 `String.split(ph).join(orig)` 全替换（不依赖位置，不需排序）

#### 配置 schema（cordis.yml 当前形态）
```yaml
sanitizer-pipeline:
  enableAutoDetection: true
  maxReplacementsPerSession: 1024
```

---

### 2.17 local-tools 插件（本地私密工具集）

#### 插件元信息
```yaml
name: local-tools
type: tool
inject:
  - tools
  - config
  - local-storage
```

#### 核心实现
```typescript
export const inject = ['tools', 'config', 'local-storage']

export function apply(ctx: Context, config: LocalToolsConfig) {
  ctx.effect(() => {
    const isPathAllowed = (path: string) => {
      return config.allowedPaths.some(allowed => path.startsWith(allowed))
    }

    const toolDefinitions = [
      {
        name: 'local_file_read',
        description: '读取本地文件（仅限白名单路径）',
        realm: 'local' as ToolRealm,
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '文件路径' },
          },
          required: ['path'],
        },
        async execute({ path }) {
          if (!isPathAllowed(path)) {
            throw new PermissionDeniedError(`路径不在白名单内: ${path}`)
          }
          ctx.event.emit('tools/local-file-read', { path })
          return await readFile(path, 'utf-8')
        },
      },
      {
        name: 'local_file_write',
        description: '写入本地文件（仅限白名单路径）',
        realm: 'local' as ToolRealm,
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['path', 'content'],
        },
        async execute({ path, content }) {
          if (!config.allowWrite) throw new PermissionDeniedError('写操作已禁用')
          if (!isPathAllowed(path)) throw new PermissionDeniedError(`路径不在白名单内: ${path}`)
          ctx.event.emit('tools/local-file-write', { path, size: content.length })
          await writeFile(path, content, 'utf-8')
          return { success: true, path }
        },
      },
      {
        name: 'local_query_contacts',
        description: '查询本地通讯录',
        realm: 'local' as ToolRealm,
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '联系人姓名（模糊匹配）' },
          },
        },
        async execute({ name }) {
          ctx.event.emit('tools/local-contacts-query', { name })
          return await ctx['local-storage'].queryDataSource('contacts', { name })
        },
      },
      {
        name: 'local_query_calendar',
        description: '查询本地日历',
        realm: 'local' as ToolRealm,
        parameters: {
          type: 'object',
          properties: {
            startDate: { type: 'string' },
            endDate: { type: 'string' },
          },
          required: ['startDate', 'endDate'],
        },
        async execute({ startDate, endDate }) {
          ctx.event.emit('tools/local-calendar-query', { startDate, endDate })
          return await ctx['local-storage'].queryDataSource('calendar', { startDate, endDate })
        },
      },
      {
        name: 'local_calculate',
        description: '数学计算',
        realm: 'any' as ToolRealm,  // 计算工具可在任何 Realm 使用
        parameters: {
          type: 'object',
          properties: {
            expression: { type: 'string' },
          },
          required: ['expression'],
        },
        async execute({ expression }) {
          return safeEvaluate(expression)
        },
      },
    ]

    const disposers = toolDefinitions
      .filter(t => config.enabledTools.includes(t.name))
      .map(tool => ctx.tools.register(tool))

    return async () => {
      disposers.forEach(d => d())
    }
  })
}
```

#### 配置 schema
```yaml
local-tools:
  enabledTools:
    - local_file_read
    - local_file_write
    - local_query_contacts
    - local_query_calendar
    - local_calculate
  allowedPaths:
    - /data/user/documents
    - /data/user/notes
    - /tmp/agent-workspace
  allowWrite: true
```

---

### 2.18 web-search 插件（公网搜索工具）

#### 插件元信息
```yaml
name: web-search
type: tool
inject:
  - tools
  - secure-bridge
  - config
  - audit-log
```

#### 核心实现
```typescript
export const inject = ['tools', 'secure-bridge', 'config', 'audit-log']

export function apply(ctx: Context, config: WebSearchConfig) {
  ctx.effect(() => {
    const rateLimiter = new RateLimiter(config.requestsPerMinute)

    const toolDef: ToolDefinition = {
      name: 'web_search',
      description: '搜索公网信息（查询内容已经过脱敏处理）',
      realm: 'cloud',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          maxResults: { type: 'number' },
          timeRange: { type: 'string', enum: ['day', 'week', 'month', 'year'] },
        },
        required: ['query'],
      },
      rateLimit: { maxCalls: config.requestsPerMinute, windowMs: 60000 },

      async execute(params) {
        if (!rateLimiter.tryAcquire()) {
          throw new RateLimitError('搜索请求频率超限')
        }

        ctx['audit-log'].log({
          level: 'info',
          type: 'web-search',
          action: 'search-request',
          plugin: 'web-search',
          realm: 'cloud',
          metadata: { queryLength: params.query.length, engine: config.engine },
          dataExfiltrated: true,
          sanitized: true,
          success: true,
        })

        // 通过 secure-bridge 发送搜索请求
        const results = await executeWebSearch(params, config, ctx['secure-bridge'])

        // 域名过滤
        const blockedDomains = new Set(config.blockedDomains ?? [])
        return results.filter(r => {
          const domain = new URL(r.url).hostname
          return !blockedDomains.has(domain)
        }).slice(0, params.maxResults ?? config.maxResults)
      },
    }

    const dispose = ctx.tools.register(toolDef)
    return async () => { dispose() }
  })
}
```

#### 配置 schema
```yaml
web-search:
  engine: duckduckgo
  maxResults: 5
  safeSearch: true
  blockedDomains:
    - malicious-site.com
  requestsPerMinute: 10
  allowPageFetch: true
```

---

### 2.19 audit-log 插件（审计日志）

#### 插件元信息
```yaml
name: audit-log
type: service
inject:
  - tcm
  - local-storage
  - config
```

#### 核心实现
```typescript
export const inject = ['tcm', 'local-storage', 'config']

export function apply(ctx: Context, config: AuditLogConfig) {
  ctx.effect(() => {
    const buffer: AuditEntry[] = []
    const FLUSH_INTERVAL = 5000
    const MAX_BUFFER_SIZE = 100

    const flushTimer = setInterval(() => flush(), FLUSH_INTERVAL)

    async function flush() {
      if (buffer.length === 0) return
      const entries = buffer.splice(0, buffer.length)

      // 写入加密存储
      for (const entry of entries) {
        await ctx['local-storage'].set('audit-log', entry.id, sanitizeEntry(entry))
      }
    }

    function sanitizeEntry(entry: AuditEntry): AuditEntry {
      const sanitized = { ...entry, metadata: { ...entry.metadata } }
      for (const field of config.sensitiveFields) {
        if (sanitized.metadata[field]) {
          sanitized.metadata[field] = '[REDACTED]'
        }
      }
      return sanitized
    }

    const service: AuditLogService = {
      log(entry) {
        const fullEntry: AuditEntry = {
          ...entry,
          id: generateId(),
          timestamp: Date.now(),
        }
        buffer.push(fullEntry)
        ctx.event.emit('audit/log-entry', fullEntry)

        if (buffer.length >= MAX_BUFFER_SIZE) flush()
      },

      query(filter) {
        return ctx['local-storage'].list('audit-log', buildAuditFilter(filter))
      },

      getSecurityReport() {
        const last24h = buffer.filter(e => Date.now() - e.timestamp < 86400000)
        return {
          totalEvents: last24h.length,
          cloudRequests: last24h.filter(e => e.realm === 'cloud').length,
          sanitizationOps: last24h.filter(e => e.sanitized).length,
          securityEvents: last24h.filter(e => e.level === 'security').length,
          permissionDenied: last24h.filter(e => e.action === 'permission-denied').length,
          dataExfiltrated: last24h.filter(e => e.dataExfiltrated).length,
        }
      },
    }

    const dispose = ctx.provide('audit-log', service)
    return async () => {
      clearInterval(flushTimer)
      await flush()
      dispose()
    }
  })
}
```

#### 配置 schema
```yaml
audit-log:
  minLevel: info
  sensitiveFields: [query, input, response, phone, email]
  enableAlerts: true
  alertThresholds:
    cloudRequestsPerMinute: 20
    sanitizationFailures: 3
    permissionDenied: 5
```

---

## 三、插件依赖关系图

```
tcm（可信计算模块）
    └── inject: [config]
    └── 无外部依赖，最先启动

local-storage（加密存储）
    └── inject: [tcm, config]
    └── 依赖: tcm（加密密钥）

audit-log（审计日志）
    └── inject: [tcm, local-storage, config]
    └── 依赖: tcm, local-storage

sessions（加密会话）
    └── inject: [tcm, local-storage, config]
    └── 依赖: tcm, local-storage

privacy-policy（隐私策略引擎）
    └── inject: [tcm, local-storage, audit-log]
    └── 依赖: tcm, local-storage, audit-log

tools（工具注册中心）
    └── inject: [config, audit-log]
    └── 依赖: audit-log

prompt-guard（输入/输出防护）
    └── inject: [tcm, privacy-policy, audit-log]
    └── 依赖: tcm, privacy-policy, audit-log

model-router（多模型路由 —— **主 ctx 中 `llm` 的唯一 Provider**）
    └── inject: [local-llm-realm, cloud-llm-realm, privacy-policy, audit-log]
    └── p�

ohttp-gateway（OHTTP 网关）
    └── inject: [tcm, config, audit-log]
    └── 依赖: tcm, audit-log

secure-bridge（端云安全通信）
    └── inject: [tcm, ohttp-gateway, privacy-policy, audit-log, config]
    └── 依赖: tcm, ohttp-gateway, privacy-policy, audit-log

attestation（远程证明）
    └── inject: [tcm, config, audit-log]
    └── 依赖: tcm, audit-log

td-bus（威胁检测总线）
    └── inject: [audit-log, privacy-policy, config]
    └── 依赖: audit-log, privacy-policy

local-llm-realm（**isolated realm 子树**）
    └── group: true + isolate: { llm: true }
    └── 内含 local-llm-provider，在该子 ctx 中 provide 'llm'
    └── 自身子 Fiber 被 Loader 暴露为父 ctx 的 service，供 model-router 注入

local-llm-provider（本地 LLM）
    └── inject: [config]
    └── provide: llm（**仅在 local-llm-realm 子 ctx 中**）
    └── 无插件依赖（在该 isolated 子树内）

cloud-llm-realm（**isolated realm 子树**）
    └── group: true + isolate: { llm: true }
    └── 内含 cloud-llm-provider，在该子 ctx 中 provide 'llm'
    └── 自身子 Fiber 被 Loader 暴露为父 ctx 的 service，供 model-router 注入

cloud-llm-provider（云端 LLM）
    └── inject: [secure-bridge, config, audit-log]
    └── provide: llm（**仅在 cloud-llm-realm 子 ctx 中**）
    └── 依赖: secure-bridge, audit-log（在该 isolated 子树内）

intent-router（意图路由）
    └── inject: [model-router, prompt-guard, privacy-policy, audit-log, sessions, local-storage]
    └── 依赖: model-router, prompt-guard, privacy-policy, audit-log
    └── 注：不再直接依赖 llm，由 model-router 在主 ctx 提供统一的 llm service

sanitizer-pipeline（脱敏管线）
    └── inject: [config, local-storage, privacy-policy]
    └── 依赖: local-storage, privacy-policy

local-tools（本地工具）
    └── inject: [tools, config, local-storage]
    └── 依赖: tools, local-storage

web-search（公网搜索）
    └── inject: [tools, secure-bridge, config, audit-log]
    └── 依赖: tools, secure-bridge, audit-log

voice-input（语音输入）
    └── inject: [config]
    └── 无插件依赖
```

### 启动顺序（拓扑排序）

> **说明**：DSH Loader 按 `inject` 依赖自动激活 Fiber，不保证 YAML 行顺序；以下是基于 `inject` 的依赖关系得到的拓扑排序参考。

1. `tcm`（基础，无依赖）
2. `local-storage`（依赖 tcm）
3. `audit-log`（依赖 tcm, local-storage）
4. `sessions`（依赖 tcm, local-storage）
5. `privacy-policy`（依赖 tcm, local-storage, audit-log）
6. `tools`（依赖 audit-log）
7. `prompt-guard`（依赖 tcm, privacy-policy, audit-log）
8. `ohttp-gateway`（依赖 tcm, audit-log）
9. `secure-bridge`（依赖 tcm, ohttp-gateway, privacy-policy, audit-log）
10. `attestation`（依赖 tcm, audit-log）
11. `local-llm-realm`（group 子树；其内 `local-llm-provider` 依赖 config）
12. `cloud-llm-realm`（group 子树；其内 `cloud-llm-provider` 依赖 secure-bridge, audit-log）
13. `model-router`（依赖 local-llm-realm, cloud-llm-realm, privacy-policy, audit-log）
14. `td-bus`（依赖 audit-log, privacy-policy）
15. `intent-router`（依赖 model-router, prompt-guard, privacy-policy, audit-log, sessions, local-storage）
16. `sanitizer-pipeline`（依赖 local-storage, privacy-policy）
17. `local-tools`（依赖 tools, local-storage）
18. `web-search`（依赖 tools, secure-bridge, audit-log）
19. `voice-input`（无依赖）

> **isolated realm 子树的激活顺序**：Loader 在激活 `model-router`（依赖 `local-llm-realm` 与 `cloud-llm-realm`）之前，会先激活这两个 group 子树。group 子树内部的拓扑排序由 Loader 在子 Fiber 内独立完成。

---

## 四、Agent Loop 集成

### 4.1 安全管线的实际接入点（http-api 进程内流水线）

> **v6 修订**：原 §4.1 假设通过 Cordis 事件（`agent/pre-step` / `agent/request` / `tools/post-execute`）拦截 Agent Loop 注入安全逻辑。**当前实装并未使用 Cordis 事件**——`src/dsh-adapter/intent-router.ts` / `prompt-guard.ts` / `sanitizer-pipeline.ts` 都不订阅上述事件，安全管线完全由 `http-api.handleChat` / `handleChatStream` 在自己进程内按顺序串起来。这意味着：
>
> 1. 直接调用 `ctx.agents.followup()` / `ctx.llm.stream()` 绕过 http-api 的代码路径**不享受任何安全防护**——所有 PII/REJECT/threat-block 拦截都依赖 http-api 作为唯一入口
> 2. 之所以能这么设计：当前 dsh-edge-agent 的唯一对外入口就是 http-api；DSH Agent Loop 内嵌的 tools（bash/read/write/edit/web_search）尚未通过 http-api 暴露给终端用户
> 3. 若以后启用 web UI / CLI 直接调 Agent Loop，必须把整条管线复制一份到工具调用入口（或者改回事件拦截）

#### 真实管道（基于 `src/dsh-adapter/http-api.ts`）

```
bearer-auth
  ↓
td-bus.recordCloudRequest() / shouldBlock()        → 503 if blocked
  ↓
prompt-guard.checkInput(message)                    → 400 if unsafe
  ↓
intent-router.classify(message, { sessionId })
  ├─ category === 'REJECT'                          → 403 short-circuit
  └─ else
  ↓
isLocal = category === 'LOCAL'
  ↓
provider/model = isLocal ? local-llm : cloud-llm
(硬编码，**未**走 modelRouter.resolve()——见"实现侧限制")
  ↓
if (!isLocal && sanitizer):
  msgToSend = await sanitizer.sanitize(message, { sessionId })
  wasSanitized = true
  ↓
result = await ctx.agents.followup(userMessage)
  ↓
if (!isLocal && sanitizer):
  resultText = await sanitizer.desanitize(result, sessionId)
  ↓
outputCheck = prompt-guard.checkOutput(resultText, { sanitized: wasSanitized })
  → 若 outputCheck.redactedText 存在 → 替换 resultText（防止 desanitize 重新引入 PII 之后被误 mask）
  ↓
200 JSON { kind:'chat', message, intent }
```

#### 决策对象 vs 异常抛出（v6 合规修正）

原 §4.1 大量使用 `throw new SecurityError(...)`。v6 §11.2 row 5 修正：

- **CLOUD/REJECT 路径**：使用决策对象（`{ kind: 'reject', reason, status: 403 }` / `{ kind: 'block', reason, status: 503 }`），由 http-api 转换为 HTTP 状态码。异常**仅**用于真正的不可恢复错误（DB 损坏、鉴权失败）。
- **SANITIZED 路径**：使用决策对象 `{ kind: 'sanitized', sanitizedText, sessionId }`，由 http-api 决定走 sanitize → LLM → desanitize。
- **input/output 安全检查**：仍走异常（`UnsafeInputError` / `UnsafeOutputError`），由 http-api try/catch 转换为 400。

#### 不再使用的概念（已从实装移除）

- ~~`ctx['local-llm-realm'].llm.chat()`~~ → 实装统一走 `ctx.llm.stream({ provider, model, ... })`，多 provider 通过 dsh-adapters 注册
- ~~`ctx.event.on('tools/post-execute', ...)`~~ → 实装不订阅此事件
- ~~`toolName === 'llm' || 'model-router'` 分支判断~~ → 实装用 realm 决定 provider，无 LLM 工具概念
- ~~`SecurityError` 抛错阻断 CLOUD~~ → 改为决策对象，由 http-api 映射 403

#### 事件流程图（实际顺序，与 http-api.ts 对应）

```mermaid
sequenceDiagram
    actor User as 用户
    participant API as http-api<br/>(handleChat)
    participant TDB as td-bus
    participant PG as prompt-guard
    participant IR as intent-router
    participant SP as sanitizer-pipeline
    participant LLM as llm service<br/>(ctx.llm.stream)
    participant AL as audit-log

    User->>API: POST /v1/chat { message, sessionId }
    API->>TDB: shouldBlock()
    alt blocked
        TDB-->>API: { block:true, reason }
        API-->>User: 503 threat-block
    else allow
        TDB-->>API: ok
        API->>PG: checkInput(message)
        alt unsafe
            PG-->>API: { safe:false, reason }
            API-->>User: 400 unsafe-input
        else safe
            PG-->>API: { safe:true }
            API->>IR: classify(message, { sessionId })
            alt REJECT
                IR-->>API: { category:'REJECT', ... }
                API-->>User: 403 reject
            else LOCAL/CLOUD/SANITIZED
                IR-->>API: { category, targetRealm, requiresSanitization }
                Note over API: isLocal = category === 'LOCAL'<br/>provider/model 硬编码
                alt !isLocal && sanitizer
                    API->>SP: sanitize(message, { sessionId })
                    SP-->>API: { sanitizedText, wasSanitized:true }
                end
                API->>LLM: stream({ provider, model, messages })
                LLM-->>API: result text
                alt !isLocal && sanitizer
                    API->>SP: desanitize(result, sessionId)
                    SP-->>API: 还原 PII
                end
                API->>PG: checkOutput(result, { sanitized: wasSanitized })
                PG-->>API: { safe:true, redactedText? }
                API-->>User: 200 JSON { message, intent }
            end
        end
    end
```

### 4.2 主循环流程（http-api 真实形态）

> 以下是 `http-api.handleChat` 的简化版骨架，对应 `src/dsh-adapter/http-api.ts:406-627`。`handleChatStream`（`http-api.ts:629-836`）是同样的同步版本 + SSE 推送 + `desanitizeSync`（不能 await）。

```typescript
// http-api.ts 真实结构（简化）
class HttpApiService {
  async handleChat(req: ChatRequest): Promise<ChatResponse> {
    const reqId = uuid()
    const sessionId = req.sessionId ?? (await this.sessions.create()).id

    // 1. bearer-auth 已在 router 层（401 短路），此处不重复

    // 2. td-bus: 威胁等级 / 阻断检查
    if (this.tdBus) {
      await this.tdBus.recordCloudRequest({ reqId, sessionId, kind: 'chat' })
      const block = await this.tdBus.shouldBlock()
      if (block?.block) {
        return { status: 503, body: { kind:'threat-block', reason: block.reason } }
      }
    }

    // 3. prompt-guard: 输入安全
    const inputCheck = await this.promptGuard.checkInput(req.message)
    if (!inputCheck.safe) {
      return { status: 400, body: { kind:'unsafe-input', reason: inputCheck.reason } }
    }

    // 4. intent-router: 意图分类（带 sessionId 让 sanitizer 复用同一映射）
    const intent = await this.intentRouter.classify(req.message, { sessionId })
    if (intent.category === 'REJECT') {
      return { status: 403, body: { kind:'reject', reason: intent.rationale } }
    }

    // 5. 决定 provider/model（**硬编码**，不走 modelRouter.resolve）
    const isLocal = intent.category === 'LOCAL'
    const provider = isLocal ? 'local-llm' : 'cloud-llm'
    const model    = isLocal ? 'qwen3-4b'        : 'deepseek-chat'

    // 6. 脱敏（仅 CLOUD/SANITIZED，且 sanitizer 挂载时）
    let wasSanitized = false
    let messageToSend = req.message
    if (!isLocal && this.sanitizer) {
      try {
        const r = await this.sanitizer.sanitize(req.message, { sessionId })
        messageToSend = r.sanitizedText
        wasSanitized = r.replacements.length > 0
      } catch (err) {
        // fail-open: 原文本继续走；audit error 即可，不阻断
        await this.auditLog.log({ level:'error', kind:'http.chat.sanitize.error', source:'http-api', payload:{ reqId, sessionId, error:String(err) } })
      }
    }

    // 7. 调 LLM
    const userMessage = createUserMessage({ content:[{ type:'text', text: messageToSend }], source:{ kind:'user' } })
    let result = await this.agents.followup(userMessage)   // 经 dsh-llm 内部走 ctx.llm.stream

    // 8. 反向还原（仅 CLOUD/SANITIZED）
    if (!isLocal && this.sanitizer) {
      result = await this.sanitizer.desanitize(result, sessionId)
    }

    // 9. 输出安全检查（传 wasSanitized 防止 desanitize 后 PII 被误 mask）
    const outputCheck = await this.promptGuard.checkOutput(result, { sanitized: wasSanitized })
    if (outputCheck.redactedText) result = outputCheck.redactedText

    return { status:200, body:{ kind:'chat', message: result, intent } }
  }
}
```

#### 与原 §4.2 概念性伪代码的差异

| 概念伪代码 | 实装形态 |
|---|---|
| `throw new SecurityError` | 决策对象 `{ status:403, body:{kind:'reject', reason} }` |
| `ctx.event.on('agent/pre-step')` | `await this.intentRouter.classify(...)` 在 http-api 内同步调用 |
| `ctx.event.on('tools/post-execute')` | 实装无此事件订阅；输出检查直接调 `promptGuard.checkOutput()` |
| `modelRouter.selectModel(intent, dataLevel)` | 实装**硬编码** `isLocal ? local-llm : cloud-llm`（已知偏离 v6 §4.2 设计的硬编码点） |
| `ctx['local-llm-realm'].llm.chat()` | 统一 `ctx.llm.stream({ provider, model, ... })`，多 provider 通过 dsh-adapters 注册 |
| `sanitizer-pipeline` 全局依赖 | `if (!isLocal && this.sanitizer)` 软依赖（fail-open） |
| 单一 SANITIZED 路径特殊处理 | SANITIZED 与 CLOUD 在管线里走同一路径（`isLocal` 都为 false），区别仅在 `intent.category` 不同 |


### 4.3 cordis.yml 完整配置

> **关键变更说明**：为支持 `local-llm-provider` 与 `cloud-llm-provider` 在同一 bundle 中以同名 `llm` 服务共存，本配置使用 `cordis:group` + `isolate: { llm: true }` 建立两个 isolated 子 ctx（`local-llm-realm` 与 `cloud-llm-realm`），各自的 `llm` provider 仅在对应 realm 内可见。`model-router` 同时注入两个子 ctx 句柄作为普通 service（Loader 自动把 group 的子 Fiber 暴露为父 ctx 的 service 引用），对外提供统一的 `llm` service 给 DSH Agent Loop 使用，**完整保留 Cordis "一切皆插件" 模型**，不修改 DSH 核心。

```yaml
# cordis.yml - 端侧私密智能体完整配置
meta:
  name: edge-private-agent
  version: 6.0.0
  description: 基于 DSH 的端侧私密智能体（v6.0：LLM adapter 化、event 契约修正、cordis.yml 字段修正）

plugins:
  # ═══ 安全核心层 ═══
  tcm:
    teeType: trustzone
    keyStorePath: /secure/keys
    teeInference: true
    secureMemoryLimit: 67108864

  # ═══ 基础设施层 ═══
  local-storage:
    dbPath: /data/agent/storage.enc.db
    encryptionKeyTag: storage-master-key
    walMode: true
    maxSize: 536870912
    dataSources:
      - type: contacts
        dbPath: /data/user/contacts.db
      - type: calendar
        dbPath: /data/user/calendar.db

  sessions:
    sessionTimeout: 1800000
    encryptionKeyTag: session-key
    maxActiveSessions: 10
    persistSessions: true
    historyRetentionDays: 7

  audit-log:
    minLevel: info
    sensitiveFields: [query, input, response, phone, email]
    enableAlerts: true

  privacy-policy:
    policyPath: /data/agent/policy.json
    allowRemotePolicyUpdate: false
    policyUpdateInterval: 86400000

  tools: {}

  # ═══ 安全防护层 ═══
  prompt-guard:
    enableModelDetection: true
    modelDetectionName: qwen3-4b

  attestation:
    verificationServiceUrl: https://attest.example.com/verify
    attestationCacheTTL: 3600000
    attestOnStartup: true

  td-bus:
    detectionWindow: 300000
    enableAutoResponse: true

  # ═══ 通信层 ═══
  ohttp-gateway:
    relayUrl: https://relay.example.com/ohttp
    targetUrl: https://api.deepseek.com/v1
    keyConfigUrl: https://api.deepseek.com/.well-known/ohttp-keys
    timeout: 30000

  secure-bridge:
    mode: ohttp
    retry:
      maxRetries: 2
      backoffMs: 1000

  # ═══ 模型层（isolated realm + 统一 router）═══
  # 本地 LLM realm —— 建立独立的 llm 命名空间
  - id: local-llm-realm
    name: cordis:group
    group: true
    isolate:
      llm: true               # 本子树中的 llm service 隔离到独立 realm
    config:
      - name: local-llm-provider
        inject: [config]       # 在该 isolated 子 ctx 中 provide 'llm'
        config:
          backend: llama-cpp
          modelPath: /models/qwen3-4b-q4_k_m.gguf
          modelName: qwen3-4b
          contextSize: 4096
          gpuLayers: 0
          threads: 4
          temperature: 0.7

  # 云端 LLM realm —— 建立另一个独立的 llm 命名空间
  - id: cloud-llm-realm
    name: cordis:group
    group: true
    isolate:
      llm: true               # 与 local-llm-realm 的 llm 完全隔离
    config:
      - name: cloud-llm-provider
        inject: [secure-bridge, config, audit-log]
        config:
          provider: deepseek
          apiKey: ${DEEPSEEK_API_KEY}
          baseUrl: https://api.deepseek.com/v1
          model: deepseek-chat
          maxTokens: 4096
          temperature: 0.7
          timeout: 30000
          retryCount: 2
          rateLimitRPM: 30

  # 模型路由层 —— 注入两个 isolated 子 ctx 作为 service，对外统一提供 llm
  # 注意：DSH Loader 自动将每个 group 子树创建为子 Fiber，
  # 并把对应的子 ctx 作为 service 暴露给父 ctx（即 inject 时按 group id 引用）。
  model-router:
    inject: [local-llm-realm, cloud-llm-realm, privacy-policy, audit-log]
    config:
      defaultModel: qwen3-4b
      enableLoadBalancing: true
      healthCheckInterval: 30000
      models:
        - name: qwen3-4b
          provider: local
          capabilities: [chat, routing, embedding]
          maxContextSize: 4096
          allowedDataLevels: [public, internal, confidential, secret]
          priority: 1
        - name: deepseek-chat
          provider: cloud
          capabilities: [chat]
          maxContextSize: 65536
          allowedDataLevels: [public]
          priority: 10

  # ═══ 路由层 ═══
  intent-router:
    inject: [model-router, prompt-guard, privacy-policy, audit-log, sessions, local-storage]
    config:
      confidenceThreshold: 0.6
      maxRoutingTokens: 128

  # ═══ 脱敏层 ═══
  sanitizer-pipeline:
    inject: [config, local-storage, privacy-policy]
    config:
      logSanitization: true
      sessionTimeout: 300000

  # ═══ 工具层 ═══
  local-tools:
    inject: [tools, config, local-storage]
    config:
      enabledTools:
        - local_file_read
        - local_file_write
        - local_query_contacts
        - local_query_calendar
        - local_calculate
      allowedPaths:
        - /data/user/documents
        - /data/user/notes
        - /tmp/agent-workspace
      allowWrite: true

  web-search:
    inject: [tools, secure-bridge, config, audit-log]
    config:
      engine: duckduckgo
      maxResults: 5
      safeSearch: true
      requestsPerMinute: 10
      allowPageFetch: true

  # ═══ 输入层 ═══
  voice-input:
    inject: [config]
    config:
      engine: whisper-local
      modelPath: /models/whisper-tiny-q8.bin
      sampleRate: 16000
      language: zh
      vadEnabled: true
```

---

## 五、平台适配说明

### 5.1 瑞芯微 RK3588
- 纯 CPU 推理，`gpuLayers: 0`
- 4 大核 + 4 小核，`threads: 4`（仅用大核）
- 模型量化：Q4_K_M（平衡质量与速度）
- 推荐模型：Qwen3-4B-Q4_K_M（约 2.5GB）
- Whisper 使用 tiny 量化版（约 40MB）
- TEE：ARM TrustZone
- 安全内存：64MB

### 5.2 飞腾 D3000M
- 支持 AVX-512 指令集
- 8 核心，`threads: 8`
- 可使用稍大模型：Qwen3-4B-Q5_K_M（约 3GB）
- llama.cpp 后端需开启 AVX-512 编译
- TEE：RISC-V Keystone（如可用）

---

## 六、架构图与序列图

### 6.1 整体架构框图

```mermaid
graph TB
    subgraph 用户输入层
        MIC["🎤 麦克风<br/>语音采集"]
        TXT["⌨️ 文本输入<br/>键盘/IME"]
    end

    subgraph 安全防护层
        PG["prompt-guard 插件<br/>────────────<br/>输入攻击检测(→HTTP 400)<br/>输出泄露过滤<br/>模型辅助判断"]
        PP["privacy-policy 插件<br/>────────────<br/>策略引擎(热更新, REJECT→HTTP 403)<br/>数据分类<br/>全局约束"]
    end

    subgraph 输入处理层
        VI["voice-input 插件<br/>────────────<br/>Whisper-tiny 本地ASR<br/>VAD 静音检测<br/>16kHz 采样"]
    end

    subgraph 路由决策层
        IR["intent-router 插件<br/>────────────────<br/>① 策略REJECT预检<br/>② 模型意图分类<br/>③ 置信度校验<br/>④ softService()软依赖"]
        MR["model-router 插件<br/>────────────────<br/>多模型智能选择<br/>健康检查<br/>数据级别约束"]
    end

    subgraph Realm 隔离域
        direction LR
        subgraph LOCAL Realm ["🔒 LOCAL Realm（数据不出端）"]
            LLP["local-llm-provider<br/>────────────<br/>Qwen3-4B-Q4_K_M<br/>llama.cpp 后端<br/>纯CPU推理"]
            LT["local-tools<br/>────────────<br/>文件读写(白名单)<br/>通讯录/日历查询<br/>数学计算"]
        end

        subgraph CLOUD Realm ["☁️ CLOUD Realm（公开信息查询）"]
            CLP["cloud-llm-provider<br/>────────────<br/>DeepSeek-V4 API<br/>速率限制 30RPM"]
            WS["web-search<br/>────────────<br/>DuckDuckGo 搜索<br/>域名黑白名单"]
        end

        subgraph SANITIZED Realm ["🛡️ SANITIZED Realm（脱敏后查询）"]
            SP["sanitizer-pipeline<br/>────────────<br/>策略驱动脱敏规则<br/>语义保持替换<br/>会话映射管理"]
        end
    end

    subgraph 端云安全通信
        SB["secure-bridge<br/>────────────<br/>OHTTP / TLS 选择<br/>证书固定<br/>请求审计"]
        OH["ohttp-gateway<br/>────────────<br/>RFC 9458<br/>身份-内容分离<br/>Relay 不可见"]
    end

    subgraph 安全核心层
        TCM["tcm 插件<br/>────────────<br/>TEE 管理<br/>密钥不离开安全区<br/>密封存储/远程证明"]
        ATT["attestation<br/>────────────<br/>TEE 远程证明<br/>环境验证"]
        TDB["td-bus<br/>────────────<br/>威胁检测总线<br/>异常行为监控<br/>自动降级/锁定"]
    end

    subgraph 基础设施层
        LS["local-storage<br/>────────────<br/>AES-256-GCM 加密<br/>密钥存于 TEE<br/>SQLite"]
        SS["sessions<br/>────────────<br/>加密会话管理<br/>过期/审计<br/>Realm 隔离"]
        TR["tools<br/>────────────<br/>Realm 感知注册<br/>权限/速率检查"]
        AL["audit-log<br/>────────────<br/>防篡改审计<br/>敏感字段脱敏<br/>日志轮转"]
    end

    subgraph 输出层
        TTS["🔊 语音合成输出"]
        SCR["📱 屏幕文本输出"]
    end

    %% 数据流
    MIC --> VI
    TXT --> PG
    VI -->|"ASR 文本"| PG
    PG -->|"安全输入"| IR

    IR -->|"路由结果"| MR
    MR -->|"选择模型"| IR

    IR -->|"LOCAL"| LLP
    IR -->|"LOCAL"| LT
    IR -->|"CLOUD"| CLP
    IR -->|"CLOUD"| WS
    IR -->|"SANITIZED"| SP
    SP -->|"脱敏后文本"| CLP
    SP -->|"脱敏后查询"| WS

    CLP --> SB
    WS --> SB
    SB --> OH
    OH -->|"OHTTP"| INTERNET["🌐 互联网"]

    %% 安全核心连接
    TCM -.->|"密钥服务"| LS
    TCM -.->|"密钥服务"| SS
    TCM -.->|"密钥服务"| OH
    TCM -.->|"证明令牌"| ATT
    PP -.->|"策略规则"| IR
    PP -.->|"脱敏规则"| SP
    PP -.->|"数据分类"| PG

    LLP -->|"本地响应"| OUT["结果聚合"]
    LT -->|"工具结果"| LLP
    CLP -->|"云端结果"| OUT
    SP -->|"还原结果"| OUT
    OUT --> PG
    PG -->|"安全输出"| TTS
    PG -->|"安全输出"| SCR

    %% 审计连接
    CLP -.->|"审计"| AL
    WS -.->|"审计"| AL
    IR -.->|"审计"| AL
    SP -.->|"审计"| AL
    SB -.->|"审计"| AL

    %% 样式
    style LOCAL fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px
    style CLOUD fill:#e3f2fd,stroke:#1565c0,stroke-width:2px
    style SANITIZED fill:#fff3e0,stroke:#e65100,stroke-width:2px
    style IR fill:#f3e5f5,stroke:#6a1b9a,stroke-width:2px
    style MR fill:#f3e5f5,stroke:#6a1b9a,stroke-width:2px
    style AL fill:#fce4ec,stroke:#c62828,stroke-width:2px
    style TCM fill:#fff9c4,stroke:#f57f17,stroke-width:2px
    style PG fill:#fce4ec,stroke:#c62828,stroke-width:2px
    style PP fill:#fce4ec,stroke:#c62828,stroke-width:2px
    style TDB fill:#fce4ec,stroke:#c62828,stroke-width:2px
    style SB fill:#e0f7fa,stroke:#00695c,stroke-width:2px
    style OH fill:#e0f7fa,stroke:#00695c,stroke-width:2px
```

---

### 6.2 场景1：LOCAL — 本地私密操作序列图

> 示例：「帮我整理一下本地的会议纪要」（基于 `http-api.handleChat` 真实管道）
>
> **v6 修订**：移除 v6 初稿中的 `ctx['local-llm-realm'].llm.chat()` 概念；实装统一通过 `ctx.llm.stream({ provider: 'local-llm', ... })` 调用本地 provider adapter。provider/model 当前在 http-api 内**硬编码**（不走 `modelRouter.resolve()`）——见 § 4.2 的"实现侧限制"。

```mermaid
sequenceDiagram
    autonumber
    actor User as 👤 用户
    participant API as http-api<br/>(handleChat)
    participant TDB as td-bus
    participant PG as prompt-guard
    participant IR as intent-router
    participant PP as privacy-policy
    participant LLM as ctx.llm<br/>(local-llm adapter)
    participant LT as local-tools
    participant LS as local-storage<br/>(AES-256-GCM)
    participant TCM as tcm
    participant AL as audit-log

    User->>API: POST /v1/chat { message:"帮我整理一下本地的会议纪要", sessionId }

    API->>TDB: shouldBlock()
    TDB-->>API: ok
    API->>PG: checkInput(message)
    PG->>PP: 数据分类查询
    PP-->>PG: classification: internal
    PG-->>API: { safe:true }

    API->>IR: classify(message, { sessionId })
    IR->>PP: matchRouting(text)
    PP-->>IR: routingRules
    IR->>IR: 命中 "本地" → LOCAL<br/>rule=local-device-ops
    IR->>AL: 审计: intent-rules-hit<br/>{category:LOCAL, source:'privacy-policy'}
    IR-->>API: { category:'LOCAL', targetRealm:'local', requiresSanitization:false }

    Note over API: isLocal=true<br/>provider='local-llm'<br/>model='qwen3-4b'<br/>**硬编码**，不走 modelRouter

    API->>LLM: stream({ provider:'local-llm', model:'qwen3-4b', messages:[...history, userMsg] })

    LLM->>LT: tool_call: local_file_read<br/>{path:"/data/user/notes/*"}
    LT->>LS: 列出 workspace 文件
    LS->>TCM: 获取存储密钥
    TCM-->>LS: AES-256 密钥
    LS-->>LT: [会议纪要-0815.md, 会议纪要-0816.md]
    LT-->>LLM: tool_result: 文件列表

    LLM->>LT: tool_call: local_file_read<br/>{path:"会议纪要-0816.md"}
    LT->>LS: 读取文件内容（自动解密）
    LS-->>LT: 文件文本
    LT-->>LLM: tool_result: 文件内容

    LLM->>LLM: 生成整理后的纪要<br/>(纯本地推理，数据不出端)
    LLM-->>API: result text

    Note over API: isLocal=true → 不调 sanitizer
    API->>PG: checkOutput(result, { sanitized:false })
    PG-->>API: { safe:true }

    API-->>User: 200 JSON { message: "整理后的纪要...", intent:{ category:'LOCAL', ... } }

    Note over User,TCM: 🔒 全程数据未出端；存储 AES-256-GCM 加密
```

---

### 6.3 场景2：CLOUD — 查询公网信息序列图

> 示例：「最近有什么 AI 领域的重要新闻」

```mermaid
sequenceDiagram
    autonumber
    actor User as 👤 用户
    participant API as http-api
    participant TDB as td-bus
    participant PG as prompt-guard
    participant IR as intent-router
    participant PP as privacy-policy
    participant LLM as ctx.llm<br/>(cloud-llm adapter)
    participant WS as web-search
    participant SB as secure-bridge<br/>(mode: ohttp)
    participant OH as ohttp-gateway
    participant AL as audit-log

    User->>API: POST /v1/chat { message:"最近有什么 AI 领域的重要新闻", sessionId }

    API->>TDB: shouldBlock()
    TDB-->>API: ok
    API->>PG: checkInput(message)
    PG-->>API: { safe:true, dataClass:'public' }
    API->>IR: classify(message, { sessionId })
    IR->>PP: matchRouting
    PP-->>IR: "新闻" → CLOUD
    IR-->>API: { category:'CLOUD', targetRealm:'cloud', requiresSanitization:false }

    Note over API: isLocal=false<br/>provider='cloud-llm'<br/>model='deepseek-chat'<br/>**硬编码**

    Note over API: 无 sanitize（message 无 PII）
    API->>LLM: stream({ provider:'cloud-llm', model:'deepseek-chat', messages })
    LLM->>WS: tool_call: web_search<br/>{query:"AI 领域 重要新闻 2026年8月"}
    WS->>SB: sendCloudRequest(search)
    SB->>OH: OHTTP 封装

    OH->>RELAY: 外层加密请求
    RELAY->>TARGET: 转发内层请求
    TARGET-->>RELAY: 内层响应
    RELAY-->>OH: 外层加密响应
    OH->>OH: 解密响应
    OH-->>SB: 明文响应
    SB-->>WS: 搜索结果
    WS->>WS: 域名过滤
    WS-->>LLM: tool_result: 5 条结果

    LLM->>LLM: 基于搜索结果生成回答
    LLM-->>API: result text

    API->>PG: checkOutput(result, { sanitized:false })
    PG-->>API: { safe:true }
    API-->>User: 200 JSON { message, intent:{ category:'CLOUD', ... } }

    Note over User,OH: ☁️ 通过 OHTTP 通信<br/>Relay 不知道用户身份<br/>Target 不知道请求来源设备
```

---

### 6.4 场景3：SANITIZED — 脱敏后公网查询序列图

> 示例：「帮我查一下张三的公司最近有什么动态」

```mermaid
sequenceDiagram
    autonumber
    actor User as 👤 用户
    participant API as http-api
    participant PG as prompt-guard
    participant IR as intent-router
    participant PP as privacy-policy
    participant SP as sanitizer-pipeline
    participant LLM as ctx.llm<br/>(cloud-llm adapter)
    participant WS as web-search
    participant AL as audit-log

    User->>API: POST /v1/chat { message:"帮我查一下张三的公司最近有什么动态", sessionId }

    API->>PG: checkInput(message)
    PG-->>API: { safe:true }
    API->>IR: classify(message, { sessionId })
    IR->>PP: matchRouting
    PP-->>IR: 命中"姓名/公司" → SANITIZED
    IR-->>API: { category:'SANITIZED', targetRealm:'sanitized', requiresSanitization:true }

    Note over API: isLocal=false → 进入 sanitize

    API->>SP: sanitize(message, { sessionId })
    SP->>PP: getSanitizationRules()
    PP-->>SP: sanitizationRules (6 条)
    SP->>SP: 执行脱敏管线:<br/>① "张三" → "[NAME_1]"<br/>② 保留公司名为占位符 (规则未匹配时不脱敏)
    SP->>AL: 审计: sanitizer.sanitized<br/>{replacements:1, sessionId}
    SP-->>API: { sanitizedText:"帮我查一下[NAME_1]的公司...", wasSanitized:true }

    API->>LLM: stream({ provider:'cloud-llm', messages:[sanitizedText] })
    LLM->>WS: tool_call: web_search<br/>{query:"[NAME_1]的公司 最新动态"}
    WS-->>LLM: 搜索结果
    LLM->>LLM: 生成回答<br/>"XX 科技最近..."
    LLM-->>API: sanitized-result text

    API->>SP: desanitize(sanitized-result, sessionId)
    SP->>SP: 还原 "[NAME_1]" → "张三"
    SP-->>API: restored text

    API->>PG: checkOutput(restored, { sanitized:wasSanitized })
    Note over PG: wasSanitized=true<br/>防止 desanitize 后的 PII 被误 mask
    PG-->>API: { safe:true }

    API-->>User: 200 JSON { message:"XX 科技最近发布了...", intent:{ category:'SANITIZED', ... } }

    Note over User,AL: 🛡️ 云端仅看到 "[NAME_1]"<br/>OHTTP 进一步隔离身份与内容
```

---

### 6.5 场景4：威胁检测与自动响应序列图

> 示例：短时间内大量云端请求触发威胁检测（http-api 入口被 td-bus 阻断）

```mermaid
sequenceDiagram
    autonumber
    actor User as 👤 用户
    participant API as http-api<br/>(handleChat)
    participant TDB as td-bus
    participant IR as intent-router
    participant LLM as ctx.llm
    participant AL as audit-log

    Note over User,TDB: ═══ 正常请求阶段 ═══
    User->>API: POST /v1/chat { message:"查询1", sessionId }
    API->>TDB: shouldBlock()
    TDB-->>API: ok
    API->>IR: classify
    IR-->>API: CLOUD
    API->>LLM: stream
    LLM-->>API: result
    API-->>User: 200
    Note over TDB: 检测: count=1/20 ✅

    Note over User,TDB: ═══ 异常请求阶段 ═══
    loop 连续 20+ 次云端请求
        User->>API: POST /v1/chat { message:"查询N" }
        API->>TDB: shouldBlock()
        TDB-->>API: ok
        API->>IR: classify
        API->>LLM: stream
        LLM-->>API: result
        API-->>User: 200
        Note over TDB: 检测: count 递增...
    end

    Note over TDB: ═══ 威胁触发 ═══
    TDB->>TDB: count > 20 in 60s<br/>rule: frequent-cloud-requests<br/>severity: HIGH
    TDB->>AL: ⚠️ 审计: td-bus.threat-detected<br/>{severity:high}
    TDB->>TDB: 状态: block-cloud=true

    Note over User,TDB: ═══ 阻断阶段 ═══
    User->>API: POST /v1/chat { message:"新查询", sessionId }
    API->>TDB: shouldBlock()
    TDB-->>API: { block:true, reason:"frequent-cloud-requests" }
    API-->>User: 503 threat-block<br/>{ kind:"threat-block", reason:"..." }

    Note over User,TDB: 🛡️ td-bus 在 http-api 入口处 503 短路<br/>无需穿透到 LLM 调用
```

---

### 6.6 安全防线全景图

```mermaid
graph LR
    subgraph 纵深防御体系
        direction TB
        L1["第1层: TEE 硬件隔离<br/>tcm 插件<br/>────────────<br/>密钥不离开安全区<br/>密封存储绑定设备<br/>ARM TrustZone"]
        L2["第2层: 远程证明<br/>attestation 插件<br/>────────────<br/>验证运行环境完整性<br/>用户可验证安全承诺"]
        L3["第3层: 策略驱动路由<br/>privacy-policy + intent-router<br/>────────────<br/>可热更新隐私策略<br/>数据分类分级<br/>规则+模型双重路由"]
        L4["第4层: Realm 隔离<br/>tools<br/>────────────<br/>工具 Realm 权限<br/>跨 Realm 访问拒绝<br/>审计记录"]
        L5["第5层: 数据脱敏<br/>sanitizer-pipeline<br/>────────────<br/>策略驱动脱敏规则<br/>语义保持替换<br/>会话映射还原"]
        L6["第6层: 零信任通信<br/>secure-bridge + ohttp-gateway<br/>────────────<br/>OHTTP 身份-内容分离<br/>证书固定<br/>Relay 不可见"]
        L7["第7层: 输入/输出防护<br/>prompt-guard<br/>────────────<br/>Prompt 注入检测<br/>输出泄露过滤<br/>模型辅助判断"]
        L8["第8层: 全链路审计<br/>audit-log<br/>────────────<br/>所有操作可追溯<br/>敏感字段自动脱敏<br/>防篡改存储"]
        L9["第9层: 主动防御<br/>td-bus<br/>────────────<br/>异常行为检测<br/>自动降级/锁定<br/>实时告警"]
    end

    subgraph 加密存储
        S1["local-storage<br/>AES-256-GCM"]
        S2["sessions<br/>加密会话"]
    end

    L1 --> L2
    L2 --> L3
    L3 --> L4
    L4 --> L5
    L5 --> L6
    L6 --> L7
    L7 --> L8
    L8 --> L9

    style L1 fill:#fff9c4,stroke:#f57f17,stroke-width:2px
    style L2 fill:#fff9c4,stroke:#f57f17,stroke-width:2px
    style L3 fill:#f3e5f5,stroke:#6a1b9a,stroke-width:2px
    style L4 fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px
    style L5 fill:#fff3e0,stroke:#e65100,stroke-width:2px
    style L6 fill:#e0f7fa,stroke:#00695c,stroke-width:2px
    style L7 fill:#fce4ec,stroke:#c62828,stroke-width:2px
    style L8 fill:#fce4ec,stroke:#c62828,stroke-width:2px
    style L9 fill:#fce4ec,stroke:#c62828,stroke-width:2px
```

---

*设计时间：2026-08-16（v1.0） → 2026-08-17（v6.0 可行性复核）*
*版本：6.0.0*
*基于 DeepSeek Harness (DSH) 插件架构*
*零内置服务依赖，所有能力由专用插件提供*

---

## 七、附录：DSH Cordis 插件机制合规性说明

### 7.1 合规性结论（v6.0 修订）

| 项 | 状态 | 说明 |
|---|---|---|
| 插件命名导出（`name` + `inject` + `Config` + `apply`） | ✅ 合规（v6.0 补齐） | 19 个插件必须 named-export 这四项；参考 `packages/llm/llm-deepseek/src/index.ts:41-200` 与 `packages/subagent/subagent-acp/src/index.ts:23-24` |
| Service 提供（`ctx.provide`） | ✅ 合规 | 使用 `ctx.effect` 包装，Fiber 卸载自动撤下 |
| 服务消费（`ctx.foo` 经 Proxy） | ⚠️ 限定范围 | 仅在 `inject` 声明的依赖上使用 `ctx.foo`；未声明的可选 service 必须 `ctx.get(name)`（包 AGENTS.md 强制） |
| 事件机制（`ctx.event.on` / `emit`） | ✅ 合规 | 仅使用 DSH Cordis 已有的标准事件点 |
| 同名 service 冲突处理 | ✅ v6.0 重写 | **删除** `isolate: { llm: true }` 设计；改为在同一 `ctx.llm` 上注册多条 provider 路由（`ctx.llm.registerAdapter(['local-llm'], adapter)`） |
| 事件拦截点选择 | ⚠️ v6.0 重写 | 输入拦截：`agent/pre-step`（返回 `PreStepDecision`）+ `agent/request`（返回 `LlmCallConfig`）；输出过滤：`llm/stream` waterfall（不是 `tools/post-execute`，LLM 不是 tool） |
| 工具注册（`ctx.tools.register`） | ✅ 合规 | 加入 `ctx.tools` 目录（DSH 标准工具注册机制） |
| 配置层（cordis.yml） | ⚠️ v6.0 修字段名 | 禁用条目用行级 `disabled: true`（Loader 真实字段），不是数组 `disable:`；其余字段（`name: cordis:group` + `group: true` + `isolate: { <key>: true }`）保持 |
| Realm 隔离（`isolate`） | ✅ 合规（语义重定义） | v6.0 移除 `llm` realm；保留 `cordis:group` 的 per-agent 用法（如 prompt-guard、td-bus 等可选 realm） |
| Fiber 生命周期 | ✅ 合规 | 资源获取与释放在同一 effect 内登记；Provider 替换由 Loader 自动触发 dependent-drain |

**v6.0 结论**：本设计**通过 DSH 插件机制**实现端侧智能体的所有功能，**不需要修改 DSH 核心代码**。所有 v5 中的"妥协机制"（如同名 `llm` 服务、waterfall 抛错、`ctx['xxx']` 字符串访问）均在 v6.0 中替换为 DSH 原生 API 的正确用法（`LlmAdapter` 注册、返回决策对象、`ctx.get`）。

### 7.2 初稿不合规点与修正对照

| # | 初稿不合规点 | 不合规原因 | v6.0 修正方案 |
|---|---|---|---|
| 1 | 4.1 节使用 `llm/before-call` 事件 | DSH Cordis 不存在该事件点 | 替换为 `agent/request`（waterfall，可在请求组装阶段拦截或改写） |
| 2 | 4.1 节使用 `llm/after-call` 事件 | 同上 | 输出侧改挂到 `llm/stream` waterfall（**不是** `tools/post-execute`，因为 LLM 不是 tool）；本地工具结果拦截仍在 `tools/post-execute`，但签名是 `(exec, result, next)` 不是 `(payload, payload, next)` |
| 3 | 4.1 节 `payload.toolName === 'llm' \|\| 'model-router'` 判断 | LLM 不在 `tools/post-execute` 事件族；该事件参数是 `(exec, result, next)`，没有 `toolName` 字段（应使用 `exec.name`） | 输出过滤改为在 `llm/stream` waterfall 中通过 `BlockAssembler` 拦截 `StreamChunk`；`tools/post-execute` 只用于本地工具结果检查 |
| 4 | 2.13 / 2.14 / 2.7 自定义 `LlmProvider` 接口 + `model-router` provide `llm` | DSH 真实 LLM 形态是 `LlmAdapter` 抽象类（仅 `stream(options)` 方法），并通过 `ctx.llm.registerAdapter([provider], adapter)` 注册；`LlmRuntime` 是单例全局服务，不允许被覆盖 | 改为两个 adapter plugin：`local-llm-adapter` 与 `cloud-llm-adapter`，各自 `ctx.llm.registerAdapter(['local-llm'], new LocalAdapter())`；选择路由由 agent 选项（`options.provider` / `options.model`）+ adapter 注册表完成，不需要 `model-router` 提供新的 `llm` service |
| 5 | 2.7 用 `cordis:group` + `isolate: { llm: true }` 解决同名 `llm` | `isolate` realm 的设计语义是**按会话/按 agent 隔离**（per-session scoping），不是用来"隐藏"主机面上的单例 service；agent-presets 文档明确说 `inject` 解析在会话存在之前完成，无法 `inject` 出一个 `isolate` realm 内的 service | 删除 isolated realm 设计；改用 § 4 的"adapter 注册"机制在同一 `llm` service 上注册多条路由 |
| 6 | 2.15 `intent-router` 中 `ctx.llm.chat(messages, options)` 与 `collectStream(...)` | DSH `LlmRuntime` 没有 `chat()` 方法，只有 `stream(options: GenerateOptions): AsyncIterable<StreamChunk>`；`GenerateOptions` 不是 `messages[]` 而是包含 `messages / provider / model / signal` 的完整请求 | 改用 `ctx.llm.stream({ messages, provider: 'local-llm', ... })`，通过 `BlockAssembler` 收集 chunk；本小节其余片段仅作语义说明保留 |
| 7 | 多处 `inject: ['config']` | Cordis 没有 `config` 服务；plugin 配置直接通过 `apply(ctx, config)` 第二参数传入（Loader 把 `entry.config` 解析后传给 apply） | 删除所有 `config` 注入项；plugin 的配置 schema 由 `export const Config: z<Config> = z.object(...)` 声明 |
| 8 | 多处 `ctx['xxx']` 字符串下标访问 service | 包 AGENTS.md 明确规定：可选 service 必须用 `ctx.get('name')`（直读全局 store），`ctx.xxx` 保留给 `inject` 声明的依赖 | 在 4.1 / 8 节事件拦截中，把"非 inject 声明的 service"读取改为 `ctx.get('xxx')` 形式 |
| 9 | `cordis.yml` 中 `disable: [dsh-*]` / `disable: true` 行字段 | Loader 真实字段是行级 `disabled: true`（单值布尔），不是数组形式；该字段支持 `!!js` 插值（例：`disabled: !!js process.platform === 'win32'`） | 全文 `disable: true` → `disabled: true`；禁用列表通过 patch 的"覆盖该行"实现，不是数组 disable |
| 10 | 4.1 节 `throw new SecurityError('输入未通过安全检查')` 在 waterfall 中 | `agent/pre-step` 与 `agent/request` 的 waterfall 监听器应通过**返回决策**（`{ kind: 'reject' }` / `{ kind: 'enter', messages }`）来拒绝/改写，抛错会绕过 agent loop 的决策分支，行为不可预期 | 改用 `return { kind: 'reject' }`（pre-step）或返回替换后的 `LlmCallConfig`（agent/request）；仅在真正不可恢复的错误才抛 |
| 11 | 8.19.4 `runAgentLoop(ctx, {...})` 自定义入口函数 | DSH 没有该函数；启动对话的正确路径是 `ctx.agents.create(...)` 拿到 `agent`，再 `agent.followup(userMsg)` 触发主循环，或 `agent.inject(...)` 排队上下文 | http-api 应通过 `ctx.agents` 注册的某个 agent（或创建一个 `headless`-mode agent）来跑对话；通过订阅 `agent/status` / `session/event` / `assistant/chunk` 拿结果 |
| 12 | 4.1 节 `tools/post-execute` 监听 `toolName === 'llm'` | LLM 不是 tool，注册表里没有名为 `llm` 的工具 | 删除该分支；输出过滤全部走 `llm/stream` waterfall（通过 `BlockAssembler` 处理 `StreamChunk`） |

### 7.3 关键 Cordis API 用法复核

| API | 本设计使用 | 是否合规 | 备注 |
|---|---|---|---|
| `export const name = '...'` | — | ⚠️ 缺失 | 真实 plugin 必须 named-export `name`（参考 `packages/llm/llm-deepseek/src/index.ts`）；只 export `inject` + `apply` 的 plugin Loader 仍能识别，但 `verify-cordis-config` 等 gate 会按缺失字段报错 |
| `export const inject = [...]` | 19 处 | ✅ | 标准 coeffect 声明；解析后由 Cordis 在 Fiber 激活前保证服务可用 |
| `export const Config: z<Config> = z.object(...)` | — | ⚠️ 缺失 | 真实 plugin 同时 named-export `Config` 作为 zod schema（Loader 用它解析并把结果作为第二参数传给 `apply`） |
| `export function apply(ctx, config)` | 19 处 | ✅ | 标准 Fiber 激活入口 |
| `ctx.effect(setup)` | 多处 | ✅ | 资源获取与释放成对登记 |
| `ctx.provide(key, value)` | 多处 | ✅ | Fiber 卸载自动撤下（前提是同 key 在该 fiber 域内无冲突 Provider） |
| `ctx.on(event, listener)` | intent-router 等 | ✅ | listener 必须 `await next()` 才能继续传递；返回不调 `next()` 等同于短路 |
| `ctx.event.emit(name, payload)` | 多处 | ✅ | 业务通知事件不属于 Agent/LLM/Capability 三大事件族，name 字段可自由命名 |
| `ctx.foo` 经 Proxy 读取 | 多处 | ⚠️ 仅在 `inject` 声明的依赖上使用 | 包 AGENTS.md 明确：可选 service 必须用 `ctx.get('name')`；本设计把非 `inject` 声明的读取改成 `ctx.get` |
| `ctx['xxx']` 字符串下标访问 | 多处 | ⚠️ | 等价但绕过 Proxy 校验；保留仅在运行时规避类型递归时使用，业务路径统一改为 `ctx.get` |
| `ctx.isolate({ <key>: true })` | 通过 YAML `isolate` 字段 | ⚠️ 用法合规但语义错配 | `isolate` 是 per-agent 隔离机制（参考 `apps/cli/config/agent-presets/code/agent.cordis.yml` 的 `planMode` / `compaction`），不是用来"隐藏主机面 service"；本设计在 v6.0 删除 `isolate: { llm: true }` 设计 |
| `ctx.llm.stream(options)` | — | ⚠️ 缺失 | DSH 唯一 LLM 调用入口；本设计自定义的 `chat/chatStream` 接口需改为 `stream(options: GenerateOptions): AsyncIterable<StreamChunk>` |
| `ctx.llm.registerAdapter(providers, adapter)` | — | ⚠️ 缺失 | LLM provider 的正确注册方式；本设计两个 provider plugin 应改写为 adapter 注册模式 |
| `ctx.agents.create(...)` | http-api | ⚠️ 缺失 | 启动一次对话的入口；`runAgentLoop` 函数不存在 |
| `ctx.event.on('agent/pre-step', listener)` | intent-router | ✅ 但返回值契约错 | waterfall listener 应返回 `PreStepDecision`（`{ kind: 'reject' }` 或 `{ kind: 'enter', messages }`），不是 `throw` |
| `ctx.event.on('agent/request', listener)` | intent-router | ✅ | 返回 `LlmCallConfig`；注意 `payload` 不含 `intent` / `dataLevel` 字段（监听器需自行维护这些旁路信息） |
| `ctx.event.on('tools/post-execute', listener)` | intent-router | ⚠️ 误用 | 监听器签名为 `(exec: ToolExecution, result: Readonly<ToolExecutionResult>, next)`，不是 `(payload, payload, next)`；且 LLM 不在该事件族 |
| `ctx.event.on('llm/stream', listener)` | — | ⚠️ 缺失 | 输出过滤、chunk 级 redact/限速的正确事件；监听器签名为 `(this: LlmRuntime, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>` |

### 7.4 不在 Cordis 范围内的依赖

| 能力 | 来源 | 说明 |
|---|---|---|
| TEE 硬件调用（TrustZone / Keystone） | 平台特定 SDK | 通过 `tcm` 插件封装，Cordis 不感知 |
| llama.cpp 本地推理 | native binding | 通过 `local-llm-provider` 封装 |
| OHTTP 协议（RFC 9458） | 网络库 | 通过 `ohttp-gateway` 封装 |
| Whisper ASR | native binding | 通过 `voice-input` 封装 |
| AES-256-GCM、X25519 | Web Crypto / Node crypto | 通过 `tcm` 封装 |

这些能力均通过插件封装，对 Cordis 完全透明，不需要修改 DSH 核心。

### 7.5 已知边界

DSH 当前实现相比论文理想保证有以下差距，本设计通过插件代码做了规避：

1. **顶层 effect 并发清理**：本设计将所有资源获取与释放收进同一外层 effect 中，利用内部逆序清理让 service 先退出。
2. **依赖约束 ≠ 权限控制**：Cordis 的 `inject` 校验是依赖约束而非权限边界；本设计通过 `tcm` 把密钥隔离到 TEE 安全区，通过 `privacy-policy` 把策略约束做成全局可热更新的拦截层，实现真正的"纵深防御"。
3. **Realm 边界由 Loader 提供**：本设计完全依赖 `cordis:group` + `isolate` 配置，运行时由 DSH Loader 创建 isolated Fiber 并暴露子 ctx 句柄。
4. **模块级 HMR 当前关闭**：本设计为端侧长期运行场景，未依赖 HMR。

---

## 八、实施计划（M 段先跑通端到端，A 段按需加固）

> 本章在 v6 的基础上重排实施节奏。v6 的 13 阶段按"基础设施分层"递进——先 S0-S1 跑通骨架、S2 才上 TCM、S5 才把"双 LLM realm"接好。这意味着 S4 的最小验证必须用 mock LLM 模拟真后端，端到端验收不可靠。本版本改用"先端到端跑通，再逐层加固"的两段式：
>
> - **M 段（必选）**：M0-M5。M5 完成时，端侧智能体**作为普通的本地 LLM 客户端已可用**——能对话、能调本地工具、能记会话、能切模型、能被 HTTP 形态调用。所有 M 段的代码**裸奔**：明文 HTTPS、明文 SQLite、API Key 仅环境变量、无审计告警、无输入检查、无加密。
> - **A 段（增强，可选）**：A1-A8。在 M 段基础上叠加纵深防御：输入/输出防护（A1）、意图路由 + 脱敏管线（A2）、TCM + 加密层（A3）、OHTTP 通信（A4）、远程证明（A5）、主动防御（A6）、公网搜索（A7）、语音输入（A8）。A 段任意阶段独立选做，没有 A-A 强依赖链。A 段本地 LLM 真后端（原 v7.0 A7）已在 M4 实现，故此处不再列。
>
> 选这条路线的理由：
> 1. M 段每一步都能用真 API 验收，调试循环短。
> 2. 安全层推迟后，开发期不用每次都跑 TEE / OHTTP / 脱敏，CI 速度也快。
> 3. 端侧智能体的核心价值是"完成任务 + 保护隐私"——但前提是任务能完成。先有"裸奔可用"的 E2E，再穿"铠甲"，每一层都能独立验收。
> 4. A 段独立可拆，可按需求优先级取用。
>
> v6 的合规修正（§ 十一）仍然成立：M 段的代码同样遵守 LLM adapter 注册、命名导出、waterfall 决策对象、`disabled` 字段、事件拦截点等规则。

### 8.1 阶段总览

| 阶段 | 主题 | 新增/升级 | 依赖 | 验证形态 |
|---|---|---|---|---|
| **M0** | 工程脚手架 | 19 插件 stub + `verify:build` 全绿 | — | `pnpm run verify:build` ✅（已完成，见 commit `17330da`） |
| **M1** | Cloud LLM 直连 | `cloud-llm-adapter` 真 API；`model-router` / `intent-router` 最小版 | M0 | "输入文本 → DeepSeek → 返回文本" demo |
| **M2** | 工具调用 | `local-tools` 子集（file_read / file_write / calculate）；`tools` 注册表最小版 | M1 | "读 /tmp/test.txt" 端到端 |
| **M3** | 会话与持久化（明文） | `sessions` + `local-storage`（明文 SQLite）+ `audit-log`（明文 ring buffer） | M2 | 多轮对话上下文保留 + 重启后查历史 |
| **M4** | 多模型 + 路由 | `local-llm-adapter`（mock）+ `cloud-llm-adapter`（真）+ `model-router` 按 `options.providers` 分发 | M3 | 同会话内切换 qwen3-4b-mock / deepseek-v4 |
| **M5** | HTTP API 服务 | `http-api`：`/v1/chat` + `/v1/chat/stream`（SSE）+ `/v1/sessions/*` | M4 | curl 调用 + 流式响应 |
| **A1** | 输入/输出防护 | `prompt-guard`（5 类攻击拦截 + PII redact） | M5 | 注入恶意 prompt 全部拦截 |
| **A2** | 意图路由 + 脱敏 | `intent-router`（规则 + 模型 fallback）+ `sanitizer-pipeline` | M5 | "查张三" → SANITIZED → 自动脱敏 + 反向还原 |
| **A3** | TCM + 加密层 | `tcm`（simulated）+ `local-storage` / `sessions` / `audit-log` 升级加密 | A1+A2 | SQLite dump 为密文 |
| **A4** | 零信任通信（OHTTP） | `ohttp-gateway`（RFC 9458 HPKE）+ `secure-bridge`（mode=ohttp） | M5 | tcpdump 验证外层仅密文 |
| **A5** | 远程证明 | `attestation`（simulated，JWT 签发） | A3 | 生成 token + mock verify 服务 |
| **A6** | 主动防御 | `td-bus`（规则 + 响应动作） | A3+A4 | 高频请求自动 block-cloud |
| **A7** | 公网搜索 | `web-search`（duckduckgo / brave） | M5 | "今天 AI 新闻" 返回真实结果 |
| **A8** | 语音输入 | `voice-input`（Whisper-tiny） | M4 | 麦克风 → 文本 → Agent Loop |

### 8.2 M0：脚手架（已完成）

**目标**：跑通 DSH 插件骨架 + 19 个插件 stub + `verify:build` 全绿。

**已完成**（见 commit `17330da`，56 files changed）：

- [x] 单包多 subpath：`@deepseek-harness-edge-agent/dsh-edge-agent` + 21 个 subpath（19 插件 + index + http-api + invariant）
- [x] 19 个插件全部 stub：`name` + `inject` + `Config` + `apply` 四项 named-export 完整
- [x] 三个 profile：`edge-minimal` / `edge-standard` / `edge-full`
- [x] 验证门禁：`verify:boundary` / `verify:contract` / `verify:patch-surface` / `verify:plugin-spec` 全部通过
- [x] 编译产物：`pnpm run compile` 产出 `lib/types/index.js` 与 `lib/types/dsh-adapter/*.js`

**未做**：所有插件的 `apply` 函数体都是占位 stub，只 verify shape 不做实际工作。

### 8.3 M1：Cloud LLM 直连

**目标**：跑通 DSH Agent Loop + 真 DeepSeek API，能对话。

**任务**：

- [ ] 填实 `cloud-llm-adapter`：
  - `LlmAdapter` 子类，实现 `async *stream(options: GenerateOptions): AsyncIterable<StreamChunk>`
  - 调用 DeepSeek Chat Completions API（OpenAI 兼容）
  - 配置从 env 读 `DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`
- [ ] 填实 `model-router`（最小版）：不创建 isolated realm，按 `options.providers` 数组选已注册的 adapter
  - **修正 v6 S5**：v6 用 `cordis:group` + `isolate: { llm: true }` 隔离同名 llm，但 § 11.2 (3) 明确 `isolate` 是 per-agent scoping，宿主 `inject` 拿不到子 realm service。改用 DSH 原生 `LlmRuntime.registerAdapter(['cloud-llm'], new CloudAdapter())`——所有 adapter 共享同一个 `ctx.llm` 单例，**根本不需要 isolate**
- [ ] 填实 `intent-router`（最小版）：默认 `CLOUD`（不分类）
- [ ] 在 `edge-minimal` profile 中只挂 `cloud-llm-adapter` / `model-router` / `intent-router`，跑通 `dsh run "你好"`

**验证**：

```bash
$ export DEEPSEEK_API_KEY=...
$ pnpm dsh --profile edge-minimal "你好"
✅ DeepSeek 响应：你好！我是 DeepSeek。
```

**产出物**：`tests/integration/cloud-llm.test.ts`、`scripts/smoke-cloud.ts`

### 8.4 M2：工具调用

**目标**：Agent Loop 能调本地工具。

**任务**：

- [ ] 填实 `local-tools` 子集：
  - `local_file_read`：读取 `~/.dsh-edge-agent/workspace/` 下文件
  - `local_file_write`：同上，写入
  - `local_calculate`：纯 JS 数学表达式求值
- [ ] 填实 `tools` 插件（最小版）：注册表 + Realm 校验（先 hardcode 接受所有 realm）+ 速率限制（先关闭）
- [ ] DSH Agent Loop tool-call E2E：用户输入"读 /tmp/test.txt" → Agent Loop 调 `local_file_read` → 返回内容

**验证**：

```bash
$ echo "hello edge" > /tmp/test.txt
$ pnpm dsh --profile edge-minimal "请帮我读 /tmp/test.txt"
🔧 tool_call: local_file_read({path: "/tmp/test.txt"})
📄 文件内容是 "hello edge"
```

**产出物**：`tests/integration/tool-call.test.ts`

### 8.5 M3：会话与持久化（明文）

**目标**：会话能跨重启保留；审计日志能查询。**明文 SQLite，无加密**。

**任务**：

- [ ] 填实 `sessions`（**明文版**）：in-memory cache + persist 到 SQLite（plain）；支持 create / appendMessage / getRecentMessages / listActive / cleanup
- [ ] 填实 `local-storage`（**明文版**）：better-sqlite3，每行 value 原文存储；提供 get / set / delete / list
- [ ] 填实 `audit-log`（**明文版**）：内存 ring buffer + 定期 flush 到 SQLite（plain）；支持 log / query / getSecurityReport
- [ ] 单元测试：多轮对话上下文保留；重启后能查到旧会话

**验证**：

```bash
$ pnpm dsh --profile edge-minimal run "我叫张三"
$ pnpm dsh --profile edge-minimal run "我叫什么名字？"
✅ Agent Loop 拉历史会话，知道你叫张三

$ pnpm dsh --profile edge-minimal sessions list
✅ sess_abc123 (2 messages, last seen 2026-08-18)
```

**注意**：此阶段**无任何加密**——SQLite 文件可被任意工具读懂。A3 阶段再升级加密。

**产出物**：`tests/integration/sessions.test.ts`、`tests/integration/audit-log.test.ts`

### 8.6 M4：多模型 + 路由（合并 v7.0 原 M4 + A7）

**目标**：同一会话内能切换不同 LLM 后端——本地 mock + 本地真机（llama.cpp OpenAI-compatible endpoint）+ 云端 DeepSeek，三者共存并由同一个 `ctx.llm` runtime 调度。

**v7.1 合并说明**：v7.0 把 M4（mock）与 A7（真 llama.cpp）拆成两段。本仓库有一台可达的本地 LLM（`http://192.168.66.195:8701/v1`，OpenAI 兼容 chat-completions 流式），没有必要先 mock 再替；本阶段直接把两条路径都实现在 `local-llm-adapter` 里，靠 `Config.mode` 在 `mock` 与 `real` 之间切换。`A7` 原条目（v7.0 § 8.13）整体删去。

**任务**：

- [ ] 填实 `local-llm-adapter` 双模式：
  - `mode: 'mock'` —— 同步按用户最后一条 user 文本返回 `"[LOCAL-MOCK] {trim(prompt)}"`，无网络
  - `mode: 'real'` —— POST 到 `{baseUrl}/chat/completions`，复用 `cloud-llm-adapter` 的 SSE 解析逻辑（包含 tool-calls delta 透传）
  - 两条路径都注册到同一个 `ctx.llm.registerAdapter(['local-llm-mock', 'local-llm'], adapter)`，route 名是 dispatch key
- [ ] `model-router` 升级：`options.provider` 命中 LOCAL 时返回 `realm='LOCAL'`；命不中返回错误；`options.model` 透传
- [ ] 通过 `provider`/`model` 显式路由（system prompt 提示 + agent 配置两种暴露路径）
- [ ] 单元测试：
  - mock：route `local-llm-mock` 命中 mock adapter，stream 出来 `[LOCAL-MOCK] 你好`
  - real：route `local-llm` 命中真后端，stub `fetch` 验证 wire body
  - cloud：route `cloud-llm` 命中 cloud-llm-adapter（回归 M1）
  - model-router：`resolveRoute('local-llm-mock')` → LOCAL；`'cloud-llm'` → CLOUD

**验证**（⚠️ §7.61 注：本节及其后 M 段验证块里的 `--config profiles/edge-*.cordis.yml` 命令为 v7.x 里程碑原文——该旗标已不在现装 dsh CLI，四个 yml 已 git rm；现役手工/自动验证走 `scripts/e2e-tui-live.sh`（§7.60）与 `profiles/dsh-edge`（§7.61））：

```bash
$ pnpm dsh --config profiles/edge-m1.cordis.yml --provider local-llm-mock "今天天气"
✅ [LOCAL-MOCK] 今天天气...

$ pnpm dsh --config profiles/edge-m1.cordis.yml --provider cloud-llm "今天天气"
✅ DeepSeek 真实响应

$ DSH_EDGE_LOCAL_LLM_MODE=real \
  DSH_EDGE_LOCAL_LLM_BASEURL=http://192.168.66.195:8701/v1 \
  pnpm dsh --config profiles/edge-m1.cordis.yml --provider local-llm "今天天气"
✅ 真 llama.cpp 响应
```

**注意**：本阶段**不**实现 realm 隔离（§ 11.2 (3) 确认 isolate 不可行）。多 provider 全部注册到同一个 `ctx.llm` 单例 service。`mode: 'real'` 走 `127.0.0.1` / 内网 LAN；A4 OHTTP 阶段不动这条路径，只接管 cloud-llm-adapter 的出口。

**产出物**：`tests/unit/local-llm-adapter.test.ts`、`tests/unit/model-router.test.ts`（扩展）

### 8.7 M5：HTTP API 服务（M 段终点，端侧智能体已可用）

**目标**：把 DSH Agent Loop 包成 REST + SSE，外部程序能调用。

**任务**：

- [ ] 填实 `http-api`：
  - `POST /v1/chat` 同步：返回 `{ sessionId, result, intent, duration }`
  - `POST /v1/chat/stream` SSE：转发 `assistant/chunk` waterfall chunk
  - `GET /v1/sessions`、`GET /v1/sessions/:id`、`DELETE /v1/sessions/:id`
  - `GET /v1/health`（公开）、`GET /v1/openapi.json`（公开）
  - API Key 鉴权（从 env 读 `EDGE_API_KEY`）
  - **Agent Loop 入口**：通过 `ctx.agents.create()` + `agent.followup(userMsg)` 触发（修正 v6 § 8.19.4 中的 `runAgentLoop`——DSH 无此函数）
  - **流式**：订阅 `session/event` / `assistant/chunk` 转发 SSE
- [ ] 单元测试：未鉴权 401；chat E2E；SSE 流式
- [ ] `edge-full.cordis.yml` 默认 `disabled: dsh-web-app`，避免与 3080 冲突

**验证**：

```bash
$ pnpm dsh --profile edge-full serve &
[INFO] http-api listening on 127.0.0.1:8080

$ curl -X POST http://127.0.0.1:8080/v1/chat \
    -H "Authorization: Bearer $EDGE_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"message":"hi"}'
{"sessionId":"sess_abc","result":"...","intent":{"category":"CLOUD"},"duration":1832}
```

**M5 完成里程碑**：

| 能力 | 状态 |
|---|---|
| 文本对话（云端 LLM） | ✅ |
| 工具调用（本地） | ✅ |
| 多轮会话持久化 | ✅ |
| 多 provider 切换 | ✅ |
| HTTP API 形态供外部集成 | ✅ |
| **安全状态** | ❌ **完全裸奔**——明文 HTTPS、明文 SQLite、API Key 仅环境变量、无审计告警、无输入检查、无加密 |

**产出物**：`tests/integration/http-api.test.ts`

---

### A 段：增强加固（可选，按需取用）

> M5 完成后系统已可用。下面 8 个 A 段**互相独立**，可按优先级挑着做。每个 A 段都依赖 M5（包含所有 M 段插件）。A-A 弱依赖：A3 解锁 A5；A1+A2+A4 → A6；M4（含本地真 LLM）解锁 A8。

### 8.8 A1：输入/输出防护

**目标**：`prompt-guard` 真实实现：拒绝恶意 prompt，过滤输出 PII。

**任务**（v6 修订：状态标注对齐当前代码实装）：

- [x] 填实 `prompt-guard`：
  - [x] `checkInput`：正则匹配 5 类攻击模式（忽略指令、系统提示提取、角色覆盖、数据外传、批量导出）
  - [x] `checkOutput(text, { sanitized })`：基于 `privacy-policy.getSanitizationRules()` 匹配 PII 模式（手机、邮箱、身份证、银行卡）自动 redact；`sanitized` 参数传 `wasSanitized` 防止 desanitize 后被二次 mask
  - [x] ~~注册 `agent/pre-step` waterfall listener 返回 `PreStepDecision`~~ → **实装未订阅 Cordis 事件**；安全拦截改由 `http-api.handleChat` 在调用 prompt-guard 时同步触发（见 § 4.1 真实管道）
  - [x] ~~注册 `llm/stream` waterfall listener 过滤 chunk 中的 PII~~ → 同上，实装在 http-api 输出检查点 `checkOutput()` 调用
- [x] 单元测试：5 类恶意 prompt 全部拒绝；输出含手机号自动 redact

**注意**：waterfall listener 应返回决策对象，不 throw（v6 § 11.2 (6)）。但当前实装走 http-api 直调路径（决策对象 `{ status:400, kind:'unsafe-input', reason }`），不在事件层。

**依赖**：`privacy-policy`（仅 `getSanitizationRules()` 方法）。

### 8.9 A2：意图路由 + 脱敏管线

**目标**：实现 LOCAL / CLOUD / SANITIZED 三类 realm 路由 + SANITIZED 脱敏 + 反向还原。

**任务**（v6 修订：状态标注对齐当前代码实装）：

- [x] 填实 `intent-router`（完整版，基于 `src/dsh-adapter/intent-router.ts`）：
  - [x] 隐私策略 pre-check：`policy.matchRouting(text)` → REJECT 短路（不调 LLM）
  - [x] LLM-first 路径：`classifyWithLlm()` → `ctx.llm.stream({ provider, model, signal })`，**分类前 sanitize**（当 `modelRouter.resolve(...).realm === 'CLOUD'`）
  - [x] `modelRouter.resolve()` 懒查（intent-router 在 model-router 之前 boot）
  - [x] 三档解析：JSON.parse / fence extract / regex 双命中（必须 category+confidence 都拿到）
  - [x] 置信度门槛（`Schema.number().min(0).max(1)`，`18d247d` 修复）；低于门槛 → `classifyWithRules` fallback
  - [x] AbortController 限时（默认 4000ms）
  - [x] `parseFailure` 计数器（与 `llmError` 分离，`c7b5daa`）
  - [x] `sanitizeError` 审计 level=`security`（P1 hardening）
  - [x] `getStats()` 含 13 计数 + `confidenceHistogram` 10-bucket × `{accepted, rejected}`（G9）
  - [x] `redactPreview()` 经 `ctx.piiUtils.redactString` 防御纵深
  - [x] `fallbackKeywords` 可由 `DSH_EDGE_INTENT_FALLBACK_KEYWORDS` env 覆写
  - [x] 返回 `{ category, confidence, targetRealm, rationale, dataLevel, requiresSanitization }`
- [x] 填实 `sanitizer-pipeline`：
  - [x] `sanitize(text, { sessionId })`：按 `privacy-policy.getSanitizationRules()` 替换为 `[<PII_TYPE>_<counter>]` 占位符，返回 `{ sanitizedText, replacements, sessionId }`
  - [x] `desanitize(text, sessionId)`：异步反向还原（整块响应）
  - [x] `desanitizeSync(text, sessionId)`：**同步**反向还原（流式响应 `handleChatStream` 逐 chunk 还原用）
  - [x] `purge(sessionId)`：由 `http-api.handleDeleteSession` 调用，删除会话映射
  - `desanitize(text, sessionId)`：从会话映射还原
- [ ] `model-router` 升级：根据 `targetRealm` 选 provider（LOCAL→本地 mock/CLOUD→云端/SANITIZED→云端+脱敏）
- [ ] 单元测试 + E2E：「查张三的公司」→ SANITIZED → 云端看到 `[用户A]` → 还原

### 8.10 A3：TCM + 加密层

**目标**：所有数据落地加密；密钥由 TCM 管理。

**任务**：

- [ ] 填实 `tcm`（simulated 后端）：
  - `generateKey / getKey / deleteKey`
  - `encrypt / decrypt`（AES-256-GCM via `crypto.subtle` / `node:crypto`）
  - `seal / unseal`（设备绑定密钥）
  - `getStatus`
- [ ] `local-storage` 升级：每行 value 写入前 `tcm.encrypt`，读出后 `tcm.decrypt`
- [ ] `sessions` 升级：会话 JSON 整体加密存储
- [ ] `audit-log` 升级：审计条目加密落盘
- [ ] 验证：SQLite dump 为密文

**注意**：替换 M3 的明文版存储。`local-storage` / `sessions` / `audit-log` 都需要 inject 加 `tcm`，cordis.yml 依赖图相应调整。

### 8.11 A4：零信任通信（OHTTP）

**目标**：`secure-bridge` 通过 OHTTP 走，Relay 看不到内容。

**任务**：

- [ ] 填实 `ohttp-gateway`：
  - `getKeyConfig`：从配置的 URL 拉 OHTTP 公钥配置
  - `sendRequest`：HPKE 加密内层请求 → 外层 POST 到 Relay → 解密响应
- [ ] 填实 `secure-bridge`：根据 `config.mode` 选 OHTTP / 直连 TLS
- [ ] docker-compose 起测试 OHTTP Relay + Target
- [ ] tcpdump 验证外层仅密文

### 8.12 A5：远程证明

**目标**：`attestation` 签发 token，云端能验证端侧环境完整性。

**任务**：

- [ ] 填实 `attestation`：
  - `generateToken(nonce)`：通过 `tcm.sign()` 签 JWT
  - `verify()`：发到 mock verification 服务
- [ ] http-api 集成 `POST /v1/attest`（M5 已留接口）

**依赖**：A3（需要 `tcm.sign`）。

### 8.13 A6：主动防御

**目标**：检测异常行为模式，自动响应。

**任务**（v6 修订：状态标注对齐当前代码实装）：

- [x] 填实 `td-bus`（基于 `src/dsh-adapter/td-bus.ts`）：
  - [x] 检测规则：`count_gt` / `equals` / `contains` / `time-window`
  - [x] 响应动作：`block-cloud` / `kill-session` / `notify-user` / `lockdown`
  - [x] `recordCloudRequest()` 记录每次云端请求
  - [x] `shouldBlock()` 检查当前是否处于阻断状态
- [x] 关键事件接入点（http-api 入口，非订阅模式）：
  - [x] http-api `handleChat` 入口调 `tdBus.shouldBlock()` → **503 threat-block** 短路（这是当前实现；不是订阅 `ohttp/request-sent`）
  - [x] ~~`tools/realm-violation`、`policy/tamper-detected` 订阅~~ → **实装未订阅**；策略篡改检测为后续迭代（见 § 1.6.7 `[ ]`）
- [x] http-api 在 td-bus 返回 `{ block:true }` 时直接返回 503（无需穿透到 secure-bridge）

### 8.14 A7：公网搜索

**目标**：`web-search` 真实接入（duckduckgo HTML / brave API）。

**任务**：

- [ ] `web-search` 真实实现，调用 `secure-bridge.sendCloudRequest`
- [ ] 域名黑名单过滤
- [ ] 速率限制

### 8.15 A8：语音输入

**目标**：`voice-input` 接 Whisper-tiny。

**任务**：

- [ ] 集成 Whisper native binding（Q8 量化）
- [ ] VAD 静音检测
- [ ] 流式转写 API
- [ ] 转写结果接 `prompt-guard`（依赖 A1）

### 8.17 阶段间依赖图

```
                  ┌── A1 prompt-guard
                  ├── A2 intent-router + sanitizer
                  ├── A3 tcm + encryption
M0 ─→ M1 ─→ M2 ─→ M3 ─→ M4 ─→ M5 ─┤── A4 ohttp
                  │                ├── A5 attestation（需 A3）
                  │                ├── A6 td-bus（需 A1+A2+A4）
                  │                ├── A7 web-search（原 § 8.14）
                  │                └── A8 voice-input（原 § 8.15，需 M4 真实本地 LLM）

A 段互相独立，按需取用
```

### 8.18 累计代码量与周期估算

| 阶段 | 累计插件 | 代码量 | 周期 |
|---|---|---|---|
| M0 | 21 (stub) | ~1500 | ✅ 已完成 |
| M1 | +1 真实现 | +300 | 1 人天 |
| M2 | +3 真实现 | +600 | 2 人天 |
| M3 | +6 真实现 | +1200 | 3 人天 |
| M4 | +8 真实现 | +1500 | 2 人天 |
| M5 | +9 真实现 | +2000 | 3 人天 |
| **M 段合计** | **9** | **~5000** | **~11 人天** |
| A1 | +1 | +400 | 1 人天 |
| A2 | +2 | +700 | 2 人天 |
| A3 | +1 (+3 升级) | +800 | 2 人天 |
| A4 | +2 | +800 | 3 人天（OHTTP 复杂） |
| A5 | +1 | +300 | 1 人天 |
| A6 | +1 | +500 | 1 人天 |
| A7 | +1 | +400 | 1 人天 |
| A8 | +1 | +600 | 3 人天（whisper native） |
| **A 段合计** | **~8** | **~5000** | **~15 人天** |

### 8.19 每阶段通用验证清单

无论哪个阶段，完成时都需确认：

- [ ] **单元测试通过**：新增/修改的函数有测试覆盖，行覆盖 ≥ 80%
- [ ] **集成验证通过**：`dsh --dump-config` 输出符合预期
- [ ] **Cordis 合规检查**：所有插件符合 `name` / `inject` / `Config` / `apply` 模式；事件拦截点仅使用 DSH 标准事件
- [ ] **文档同步**：本文件中相应章节的"实现要点"与代码一致
- [ ] **可演示**：有一个手动 run 脚本或测试用例能完整复现
- [ ] **未引入核心修改**：`git diff dsh/` 应为空

### 8.20 风险与回退

| 风险 | 阶段 | 回退方案 |
|---|---|---|
| `cordis:group` + `isolate` 在当前 DSH 版本未按预期暴露子 ctx 句柄 | （不再用，v6 已修正） | 模型路由改用 `ctx.llm.registerAdapter(providers, adapter)` 共享单例 service |
| DSH 内置 `llm` service 存在并冲突 | M1 | 在 cordis.yml 中行级 `disabled: true` |
| OHTTP 部署复杂 | A4 | A4 拆为 A4a（直连 TLS）+ A4b（OHTTP），先打通 TLS 再升级 |
| Whisper native 编译失败 | A8 | 退回方案：用纯 JS 实现的 Web Speech API（浏览器侧）替代 |
| RK3588 上 llama.cpp Q4 推理延迟过高 | M4 | 退化到 `mode: 'mock'`，先打通链路；性能优化放 M4 之后 |

### 8.21 阶段准入/准出标准

**准入（Start）**：上一阶段"每阶段通用验证清单"全部勾选，且 cordis.yml 能稳定启动。

**准出（Done）**：本阶段：

1. 单元 + 集成测试 `pnpm test` 全绿
2. 至少一个端到端演示脚本可手动跑通
3. 文档已同步
4. 下游阶段的"依赖项"已可用（在该阶段的 cordis.yml 中能 `--dump-config` 看到）

### 8.22 逐阶段合规复核矩阵

> 本节是本版本的**最终合规声明**：逐阶段、逐任务地标注每个动作发生在哪一层（插件代码 / DSH 配置层 / 测试基础设施），并明确"任何阶段都不得修改 DSH 核心源码（`/dsh/`、`node_modules/@deepseek-ai/dsh*`、DSH Loader、Cordis 运行时）"。

#### 8.22.1 分层约定

| 层级 | 含义 | 是否修改 |
|---|---|---|
| **L1 插件代码** | `src/dsh-adapter/<plugin>.ts`，实现 `name` + `inject` + `Config` + `apply` | ✅ 自由修改 |
| **L2 DSH 配置层** | `cordis.yml`、profile、patch | ✅ 自由修改（DSH Loader 解析） |
| **L3 测试基础设施** | docker-compose、mock verify 服务、test fixture | ✅ 自由修改（与 DSH 无关） |
| **L4 DSH 核心代码** | DSH Loader、Cordis 运行时、Agent Loop 内核、Session 投影、`agent/*` / `llm/*` / `tools/*` 内置事件分发 | ❌ **禁止修改** |

**铁律**：所有阶段结束时 `git diff dsh/ node_modules/@deepseek-ai/` 必须为空。

#### 8.22.2 逐阶段合规矩阵

| 阶段 | 任务 | 层级 | 是否涉及 DSH 核心 | 备注 |
|---|---|---|---|---|
| **M0** | 工程脚手架 | L1/L2 | ❌ | 已完成 |
| **M1** | 填实 `cloud-llm-adapter` 真 API | L1 | ❌ | `LlmAdapter.stream()` 子类 |
| M1 | `model-router` 最小版 | L1 | ❌ | 不创建 isolated realm |
| M1 | `intent-router` 默认 CLOUD | L1 | ❌ | 不分类 |
| **M2** | 填实 `local-tools` 子集 | L1 | ❌ | `ctx.tools.register()` |
| M2 | `tools` 注册表最小版 | L1 | ❌ | Realm 校验先 hardcode |
| **M3** | `sessions` / `local-storage` / `audit-log` 明文版 | L1 | ❌ | SQLite 原文 |
| **M4** | `local-llm-adapter` mock + 真后端（`mode` 切换） | L1 | ❌ | `ctx.llm.registerAdapter(['local-llm-mock', 'local-llm'], ...)` |
| M4 | `local-llm-adapter` 真模式 POST `{baseUrl}/chat/completions` | L1 | ❌ | OpenAI 兼容 SSE，HTTP 出端不加密（LAN only） |
| M4 | `model-router` 按 `options.providers` 分发 | L1 | ❌ | 不替换 `ctx.llm` |
| M4 | LAN 性能 bench（可选） | L3 | ❌ | 与 DSH 无关 |
| **M5** | `http-api` 实现 REST + SSE | L1 | ❌ | 通过 `ctx.agents.create()` 触发 |
| M5 | `cordis.yml` 中 `disabled: dsh-web-app` | L2 | ❌ | 行级 `disabled: true`（Loader 真实字段） |
| **A1** ✅ | `prompt-guard` 5 类攻击拦截 + PII redact | L1 | ❌ | checkInput/checkOutput 通过 http-api 直调（不订阅 Cordis 事件） |
| A1 ✅ | ~~注册 `agent/pre-step` waterfall~~ | — | — | **实装未订阅**；改为 http-api `handleChat` 同步调用 `promptGuard.checkInput()` |
| A1 ✅ | ~~注册 `llm/stream` waterfall~~ | — | — | **实装未订阅**；输出过滤在 http-api 输出检查点调用 `checkOutput()` |
| **A2** ✅ | `intent-router` 完整版（privacy-policy pre-check + LLM-first + rules fallback） | L1 | ❌ | REJECT 短路 / confidenceThreshold=0.6 / modelRouter 懒查 / 三档解析 |
| A2 ✅ | `sanitizer-pipeline` 前向脱敏 + 反向还原 | L1 | ❌ | 含 `desanitizeSync`（流式）+ `purge(sessionId)` |
| **A3** | `tcm` simulated 后端 | L1 | ❌ | `crypto.subtle` / `node:crypto` 封装在插件内 |
| A3 | `local-storage` / `sessions` / `audit-log` 升级加密 | L1 | ❌ | 通过 `ctx.tcm.encrypt/decrypt` |
| A3 | SQLite dump 验证 | L3 | ❌ | 与 DSH 无关 |
| **A4** | `ohttp-gateway` 封装 HPKE + RFC 9458 | L1 | ❌ | OHTTP 库通过插件封装 |
| A4 | `secure-bridge` mode=ohttp | L1 | ❌ | |
| A4 | 部署 OHTTP Relay + Target（docker-compose） | L3 | ❌ | 测试基础设施 |
| A4 | tcpdump 抓包 | L3 | ❌ | |
| **A5** | `attestation` token 签发 | L1 | ❌ | 通过 `ctx.tcm.sign()` |
| A5 | 部署 mock verify 服务 | L3 | ❌ | |
| **A6** ✅ | `td-bus` 检测 + 响应 | L1 | ❌ | recordCloudRequest / shouldBlock 由 http-api 入口同步调用 |
| A6 ✅ | 503 threat-block 短路 | L1 | ❌ | http-api `handleChat` 在 tdBus.shouldBlock=true 时直接返回 503 |
| **A7** | `web-search` 真接入 | L1 | ❌ | `ctx.secure-bridge.sendCloudRequest` |
| **A8** | `voice-input` 接 Whisper-tiny | L1 | ❌ | Whisper binding 在插件内 import |
| A8 | 转写结果接 `prompt-guard` 入口 | L1 | ❌ | 在应用层组装 |

#### 8.22.3 关键边界确认

| 风险点 | 阶段 | 合规处理 |
|---|---|---|
| Whisper native binding 直接 import | A8 | ✅ 在 `voice-input` 插件 `apply()` 内 import；❌ 不得在 DSH 启动器、Loader、Agent Loop 中 import |
| llama.cpp / OpenAI-compatible endpoint 调用 | M4 | ✅ 在 `local-llm-adapter` 插件 `apply()` 内 import / HTTP；❌ 不得绕过插件 |
| OHTTP 库直接 import | A4 | ✅ 在 `ohttp-gateway` 插件内 import；其他插件仅通过 `ctx['ohttp-gateway']` 访问 |
| TEE SDK 直接调用（TrustZone/Keystone） | A3/A5 | ✅ 在 `tcm` 插件内 import native SDK；其他插件仅通过 `ctx.tcm.xxx()` 访问 |
| AES-256-GCM / X25519 直接调用 | A3/A5 | ✅ 在 `tcm` 插件内通过 `crypto.subtle` / `node:crypto` 实现 |
| DSH 内置 Agent Loop 直接替换 | M2/M5 | ✅ 仅作为 consumer 使用，**不替换**；通过 `ctx.event.on('agent/pre-step')` 事件拦截注入 |
| DSH 内置 `tools` service 直接扩展 | M2/A7 | ✅ 通过 `ctx.tools.register()` 注入；❌ 不得修改 DSH 内置 tools 实现 |
| `cordis.yml` 中新增 `disabled: true` 行级字段 | M5 | ✅ 合法（DSH Loader 配置层）；真实字段名是 `disabled` |
| docker-compose / mock service / test fixture | A4/A5 | ✅ 合法测试基础设施，**不在 DSH 仓库内** |

#### 8.22.4 阶段准入合规检查

在原 8.21 准入基础上，每个阶段开始前还需确认：

- [ ] **L1 检查**：本阶段要新增的插件/命令，是否全部在 `src/dsh-adapter/<plugin>.ts` 下？是否仅依赖其他已存在的插件 service？
- [ ] **L2 检查**：本阶段要新增的 `cordis.yml` 配置行，是否仅使用 DSH Loader 已支持的字段（Entry、`disabled: true`、`config`）？
- [ ] **L3 检查**：本阶段要新增的测试基础设施（docker-compose、mock 服务），是否与 DSH 进程隔离？
- [ ] **L4 拦截检查**：执行 `git diff dsh/ node_modules/@deepseek-ai/ --stat`，确认本阶段无 DSH 核心改动。

#### 8.22.5 最终合规结论

**本版本第八章所列 M0-M5（必选）+ A1-A8（可选）的每一步骤都仅涉及以下三类操作：**

1. **L1 插件代码**（`src/dsh-adapter/<plugin>.ts`）—— 自由
2. **L2 DSH 配置层**（`cordis.yml`）—— 自由
3. **L3 测试基础设施**（docker-compose、mock service、test fixture）—— 自由

**完全不需要修改 DSH 核心代码（L4）。** 任何看似涉及 native 库的步骤（Whisper、llama.cpp、OHTTP、TEE SDK）都通过对应插件封装调用，插件是封装边界，不是 DSH 核心。

#### 8.22.6 实施期复核脚本（建议）

```bash
#!/bin/bash
# scripts/check-plugin-only.sh
# 在每个阶段结束时执行，确保仅修改插件

set -e
echo "🔍 Checking DSH core untouched..."

# 1. 检查 DSH 核心目录无修改
if git diff --quiet dsh/ 2>/dev/null; then
  echo "✅ dsh/ unmodified"
else
  echo "❌ dsh/ has changes — STOP and revert!"
  git diff dsh/
  exit 1
fi

# 2. 检查 node_modules 无修改
if git diff --quiet node_modules/@deepseek-ai/ 2>/dev/null; then
  echo "✅ node_modules/@deepseek-ai/ unmodified"
else
  echo "❌ DSH npm packages modified — STOP and reinstall!"
  exit 1
fi

# 3. 列出本阶段所有改动文件
echo ""
echo "📁 Files modified in this phase:"
git diff --name-only HEAD~1 HEAD | grep -E "^(src/|cordis\.yml|tests/|docker/|scripts/)" || echo "  (none)"

# 4. 统计改动分布
echo ""
echo "📊 Change distribution:"
git diff --shortstat HEAD~1 HEAD
```

### 8.23 HTTP API 服务插件（v6 § 8.19 合并至此）

> 本节保留 v6 § 8.19 关于 `http-api` 的设计细节，作为 M5 阶段的实现参考。**M5 即 http-api 阶段**，对应 DSH 不内置对外 HTTP API service 的现实。
>
> **v6 修订**：本节按当前 `src/dsh-adapter/http-api.ts` 实装重写——鉴权模型（单一 bearerToken）、路由表（实际只有 7 条）、端到端管道（决策对象而非 throw）、provider/model 硬编码点（实现侧限制）。

#### 8.23.1 插件定位

| 维度 | http-api 插件 |
|---|---|
| **位置** | L1 插件代码（`src/dsh-adapter/http-api.ts`） |
| **职责** | 把 DSH Agent Loop 包装成结构化 HTTP API，让外部程序可调用；**唯一对外入口**，所有安全拦截（prompt-guard / intent-router / sanitizer / td-bus）都在此入口串联 |
| **与 DSH Web Profile 关系** | 不冲突。Web Profile 监听 3080 端口（浏览器 UI），http-api 监听独立端口（默认 `21017`）；通过 cordis.yml 中行级 `disabled: dsh-web-app` 即可只启用 API |
| **与 Agent Loop 关系** | 通过 `ctx.agents.create({ ... })` 拿到 `Agent` + `AgentHandle` 后 `handle.followup(userMsg)` 触发 DSH 内置 Agent Loop；**不替换** |
| **鉴权** | 单一 `bearerToken`（config 必填，env 注入）；`requireAttestation` 开关（默认 true，attestation 阶段接入） |
| **审计** | 每个请求都写 `audit-log`（kind: `http.chat.*` / `http.session.*` / `http.attest.*`），可追溯 |
| **Session 管理** | 进程内 `Map<sessionId, { agent, handle, lastAccessedAt }>`，LRU 上限 `maxActiveSessions`（默认 100），`sessionIdleTimeoutMs`（默认 30 min）后清理 |

#### 8.23.2 接口定义

```typescript
export const name = 'http-api'

export const inject = ['agents', 'intentRouter', 'promptGuard', 'auditLog', 'sanitizer', 'tdBus'] as const

export interface Config {
  host: string                          // 默认 '127.0.0.1'
  port: number                          // 默认 21017（与 Web Profile 3080 区分）
  bearerToken?: string                  // 必填（仅 env 注入）
  requireAttestation: boolean           // 默认 true
  sessionIdleTimeoutMs: number          // 默认 30 * 60 * 1000（30 min）；0 禁用
  maxActiveSessions: number             // 默认 100；0 不限
}

export const Config: Schema<Config> = Schema.object({
  host: Schema.string().default('127.0.0.1'),
  port: Schema.natural().default(21017),
  bearerToken: Schema.string(),
  requireAttestation: Schema.boolean().default(true),
  sessionIdleTimeoutMs: Schema.natural().default(30 * 60 * 1000),
  maxActiveSessions: Schema.natural().default(100),
})

export interface HttpApiService {
  start(): Promise<void>
  stop(): Promise<void>
  isRunning(): boolean
  endpoint(): string
}
```

#### 8.23.3 REST API 设计（实装 7 条）

| Method | Path | 用途 | 鉴权 |
|---|---|---|---|
| GET | `/v1/health` | 健康检查 | 无（公开） |
| GET | `/v1/openapi.json` | OpenAPI 规范（auto-generated） | 无（公开） |
| POST | `/v1/chat` | 主聊天入口（同步） | Bearer Token |
| POST | `/v1/chat/stream` | 流式聊天（SSE） | Bearer Token |
| GET | `/v1/sessions` | 列出当前进程内 active 会话 | Bearer Token |
| GET | `/v1/sessions/:id` | 获取会话详情（messages + intent history） | Bearer Token |
| DELETE | `/v1/sessions/:id` | 删除会话 + `sanitizer.purge(id)` | Bearer Token |

**未实装的接口**（v6 初稿列了但代码无对应 handler）：
- ~~`POST /v1/attest`~~ → attestation 阶段接入；当前路由 404
- ~~`GET /v1/policy`~~ → 策略查询接口（policy-admin 阶段）
- ~~`POST /v1/policy/reload`~~ → 触发热更新（当前是 mtime 轮询自动触发，无手动 reload 接口）
- ~~`GET /v1/stats`~~ → 统计信息（已通过 `intentRouter.getStats()` 等局部接口暴露）

#### 8.23.4 核心实现（基于 `src/dsh-adapter/http-api.ts`）

```typescript
// apply() — http-api.ts:734-746
export async function apply(ctx: any, config: Config): Promise<() => Promise<void>> {
  // 软依赖：tdBus 可缺失（td-bus 未挂载时不阻断）
  const agents      = ctx.get('agents')
  const promptGuard = ctx.get('promptGuard')
  const auditLog    = ctx.get('auditLog')
  const sanitizer   = ctx.get('sanitizer')
  const tdBus       = ctx.get?.('tdBus') ?? ctx.tdBus

  const service = new HttpApiServiceImpl(ctx, config, agents, promptGuard, auditLog, sanitizer, tdBus)
  await service.start()
  return async () => { await service.stop() }
}
```

**端到端 `handleChat` 管道**（http-api.ts:218-402）：

```typescript
private async handleChat(req, res, reqId, start) {
  // 1. bearer-auth（在 handleRequest 顶层，401 短路）

  // 2. td-bus 阻断检查
  if (this.tdBus) {
    await this.tdBus.recordCloudRequest({ reqId, sessionId, kind:'chat' })
    const block = await this.tdBus.shouldBlock()
    if (block?.block) return json(res, 503, { kind:'threat-block', reason: block.reason })
  }

  // 3. prompt-guard 输入检查
  const inputCheck = await this.promptGuard.checkInput(message)
  if (!inputCheck.safe) return json(res, 400, { kind:'unsafe-input', reason: inputCheck.reason })

  // 4. intent-router 分类
  const intent = await this.intentRouter.classify(message, { sessionId })
  if (intent.category === 'REJECT') return json(res, 403, { kind:'reject', reason: intent.rationale })

  // 5. provider/model 硬编码（**未**走 modelRouter.resolve()——实现侧限制）
  const isLocal = intent.category === 'LOCAL'
  const provider = isLocal ? 'local-llm' : 'cloud-llm'
  const model    = isLocal ? 'qwen3-4b'        : 'deepseek-chat'

  // 6. CLOUD/SANITIZED → sanitize（fail-open）
  let wasSanitized = false, messageToSend = message
  if (!isLocal && this.sanitizer) {
    try {
      const r = await this.sanitizer.sanitize(message, { sessionId })
      messageToSend = r.sanitizedText
      wasSanitized = r.replacements.length > 0
    } catch (err) {
      this.audit('error', 'http.chat.sanitize.error', { reqId, sessionId, error: String(err) })
      // 失败仍继续（fail-open）
    }
  }

  // 7. Agent Loop
  const userMessage = createUserMessage({ content:[{ type:'text', text: messageToSend }], source:{ kind:'user' } })
  let result = await handle.followup(userMessage)

  // 8. CLOUD/SANITIZED → desanitize
  if (!isLocal && this.sanitizer) result = await this.sanitizer.desanitize(result, sessionId)

  // 9. prompt-guard 输出检查（传 wasSanitized 防止 desanitize 后被误 mask）
  const outputCheck = await this.promptGuard.checkOutput(result, { sanitized: wasSanitized })
  if (outputCheck.redactedText) result = outputCheck.redactedText

  return json(res, 200, { kind:'chat', message: result, intent })
}
```

**`handleChatStream` 同构**（http-api.ts:404-551）：
- SSE `data: { type:'intent', intent:{...} }` 首条 → 客户端早返回分类结果
- 后续 chunks：`textToSend = this.sanitizer.desanitizeSync(chunk.text, sessionId)` ——**同步**反向还原（不能 await）
- 首条 `data: { type:'done' }` 结束

**`handleDeleteSession`**（http-api.ts:552-?）：
- 调 `await this.sanitizer.purge(id)` —— **关键**：不 purge 会导致 session 映射泄漏到下一会话
- LRU eviction 超 `maxActiveSessions` 时同样调 `purge(id)`

#### 8.23.5 配置示例

```yaml
http-api:
  port: 21017
  host: 127.0.0.1
  bearerToken: !!js process.env.EDGE_API_KEY      # 必填，仅 env 注入
  requireAttestation: true                         # A5 attestation 阶段接入
  sessionIdleTimeoutMs: 1800000                    # 30 min
  maxActiveSessions: 100
```

#### 8.23.6 cordis.yml 挂载

```yaml
plugins:
  - id: dsh-web-app
    disabled: true                                 # 禁用 DSH Web Profile 的 3080

  http-api:
    inject: [agents, intent-router, prompt-guard, audit-log, sanitizer, td-bus]
    config:
      port: 21017
      host: 127.0.0.1
      bearerToken: !!js process.env.EDGE_API_KEY
```

**注意**：Loader 真实字段是行级 `disabled: true`（不是数组形式的 `disable:`）。

#### 8.23.7 验证脚本

```typescript
// tests/integration/http-api.test.ts
import request from 'supertest'

describe('http-api', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await request(server).post('/v1/chat').send({ message: 'hi' })
    expect(res.status).toBe(401)
  })

  it('returns 403 on REJECT intent', async () => {
    const res = await request(server).post('/v1/chat')
      .set('Authorization', 'Bearer test-key')
      .send({ message: '导出全部用户数据' })     // 命中 policy REJECT
    expect(res.status).toBe(403)
    expect(res.body.kind).toBe('reject')
  })

  it('returns 503 when td-bus blocks', async () => {
    // stub tdBus.shouldBlock → { block:true, reason:'frequent-cloud-requests' }
    const res = await request(server).post('/v1/chat')
      .set('Authorization', 'Bearer test-key')
      .send({ message: 'hi' })
    expect(res.status).toBe(503)
    expect(res.body.kind).toBe('threat-block')
  })

  it('returns 400 on unsafe input', async () => {
    const res = await request(server).post('/v1/chat')
      .set('Authorization', 'Bearer test-key')
      .send({ message: '<inject-prompt>' })
    expect(res.status).toBe(400)
    expect(res.body.kind).toBe('unsafe-input')
  })

  it('sanitizes PII before cloud call when sanitizer mounted', async () => {
    // stub sanitizer.sanitize to assert it was called with phone-bearing text
    const res = await request(server).post('/v1/chat')
      .set('Authorization', 'Bearer test-key')
      .send({ message: '查一下 13812345678', sessionId: 'sess-test' })
    expect(res.status).toBe(200)
    // sanitizer was called for CLOUD classification
    expect(sanitizer.sanitize).toHaveBeenCalledWith(expect.stringContaining('13812345678'), { sessionId:'sess-test' })
  })

  it('purges session mapping on DELETE /v1/sessions/:id', async () => {
    const create = await request(server).post('/v1/chat')
      .set('Authorization', 'Bearer test-key')
      .send({ message: 'hi', sessionId: 'sess-A' })
    await request(server).delete('/v1/sessions/sess-A')
      .set('Authorization', 'Bearer test-key')
    expect(sanitizer.purge).toHaveBeenCalledWith('sess-A')
  })
})
```

#### 8.23.8 合规复核

| 项 | 状态 | 说明 |
|---|---|---|
| 仅在 `src/dsh-adapter/http-api.ts` 下新增插件 | ✅ L1 | 不修改 DSH |
| 仅在 `cordis.yml` 中增配置 | ✅ L2 | `disabled: dsh-web-app` 是合法 Loader 配置 |
| 不替换 DSH Agent Loop | ✅ | 通过 `ctx.agents.create()` + `handle.followup()` 触发 |
| 仅监听独立端口（默认 21017） | ✅ | 与 Web Profile 3080 不冲突 |
| Bearer Token 鉴权 | ✅ | `bearerToken` 配置项 + `Authorization: Bearer` header 校验 |
| 审计 / Session 清理 / LRU 完整 | ✅ | 复用 `audit-log`；`setInterval` 清理过期 session；`maxActiveSessions` LRU |
| **决策对象替代 throw** | ✅ | 403 reject / 503 threat-block / 400 unsafe-input 均返回 JSON decision |
| **sanitize / desanitize 接缝** | ✅ | CLOUD/SANITIZED 才走；fail-open；`wasSanitized` flag 传 `checkOutput` |
| **provider/model 硬编码** | ⚠️ 实现侧限制 | 当前未走 `modelRouter.resolve()`；记录在 `src/dsh-adapter/http-api.ts:handleChat`；后续阶段替换 |
| `git diff dsh/` 应为空 | ✅ | 完全合规 |


## 九、合规性最终声明（v7.0）

本设计（v7.1）包含：
- **22 个核心插件**（§ 二，全部按 v6.0/v7.0/v8 修订：named-export 四项 + `Config` zod schema；v8 起新增 `input-guard` / `realm-skill-bridge` / `web-search-guard` 三个）
- **1 个可选对外服务插件**（§ 8.23，`http-api`，已修正 `disabled:` 字段与 `runAgentLoop` 入口；并入 M5 阶段必做）
- **M 段 6 阶段必选实施计划**（§ 8.2 - § 8.7：M0 脚手架 → M1 Cloud 直连 → M2 工具调用 → M3 明文会话 → M4 多模型路由【含本地 mock + 真 llama.cpp】 → M5 HTTP API）+ **A 段 8 阶段增强加固**（§ 8.8 - § 8.15：A1 输入/输出防护 → A2 意图路由 + 脱敏 → A3 TCM + 加密 → A4 OHTTP → A5 远程证明 → A6 主动防御 → A7 公网搜索 → A8 语音输入）。v7.1 把 v7.0 的 A7（本地 LLM 真后端）合并进了 M4，因此 A 段降为 8 阶段。
- **逐阶段合规复核矩阵**（§ 8.22）：覆盖 M0-M5 与 A1-A8 每阶段
- **可行性复核（§ 十一）**：基于 DSH 真实源码（`packages/core/agent/src/runtime-types.ts`、`packages/core/tools/src/index.ts`、`packages/llm/llm/src/index.ts`、`packages/preset/agent-presets/src/mount.ts` 等）的逐项实证；v7.0 新增了 M 段"裸奔 E2E"合规复核

**全部内容仅涉及 DSH 插件代码（§ 二）+ DSH 配置层（cordis.yml）+ 测试基础设施**，**完全不修改 DSH 核心代码**。

任何阶段结束时：
- `git diff dsh/` 应为空
- `git diff node_modules/@deepseek-ai/` 应为空
- 所有 native 库（Whisper、llama.cpp、OHTTP、TEE SDK）都通过对应插件封装
- 所有定制逻辑通过 `ctx.event.on(...)` 事件拦截注入，不替换 DSH Agent Loop；waterfall listener 返回决策对象而非 `throw`
- LLM provider 通过 `LlmAdapter` 子类 + `ctx.llm.registerAdapter(...)` 注册，不替换 `ctx.llm` 单例 service
- 输出过滤挂在 `llm/stream` waterfall，本地工具结果检查挂在 `tools/post-execute`（区分清楚）
- M5 阶段启用 `http-api` 时通过行级 `disabled: true`（Loader 真实字段）与 DSH 内置 Web Profile 解耦，不互相干扰
- 未在 `inject` 中声明的可选 service 一律用 `ctx.get('name')` 访问（不绕过 Proxy）
- M 段（必选）与 A 段（可选）共用同一套合规规则；A 段的代码不需要"先做 A3 才能做 A1"，按需取用

---

## 十、版本演进记录

| 版本 | 主要变更 |
|---|---|
| **v1.0** | 初稿设计（`基于 DSH 插件机制的端侧私密智能体设计（修正版）.md`） |
| **v2.0** | 合规修正：替换 `llm/before-call` / `llm/after-call` 为 DSH 标准事件；通过 `cordis:group` + `isolate` 解决同名 `llm` 冲突 |
| **v3.0** | 新增 13 阶段实施计划（§ 八） |
| **v4.0** | 新增逐阶段合规复核矩阵（§ 8.18）与最终声明（§ 九） |
| **v5.0** | 新增可选的 `http-api` 插件设计（§ 8.19），澄清 DSH 不内置对外 API 服务形态 |
| **v6.0** | 基于真实 DSH 源码复核后的可行性修订：1) 改写 LLM provider 注册机制为 `LlmAdapter` + `ctx.llm.registerAdapter`；2) 删除 `isolate: { llm: true }` 设计；3) waterfall 监听器改用返回决策而非 `throw`；4) 输出过滤改挂 `llm/stream`；5) `cordis.yml` 禁用字段由 `disable:` 改为 `disabled:`；6) `inject: ['config']` 全部删除（配置走 `apply` 第二参数）；7) 新增 § 十一 可行性复核，汇总 § 七、§ 八 各阶段的真实 DSH 对照 |
| **v7.0**（本次） | 重排实施计划为"M 段先跑通端到端，A 段按需加固"两段式：1) § 八从 13 阶段（S0-S13）重排为 M0-M5（必选 6 阶段）+ A1-A9（可选 9 阶段）；2) M5 即 http-api 阶段（原 v6 S13 合并至此），删去独立 S13；3) M 段每一步都能用真 API 验收，调试循环短；4) A 段独立可选，无 A-A 强依赖链，可按需求优先级取用；5) § 8.22 合规矩阵扩展覆盖 A 段所有阶段；6) § 九、§ 十一 同步更新 |

---

## 十一、可行性复核（基于 DSH 源码实证）

> 本节汇总 v6.0 修订中的关键证据。所有结论对照 DSH 真实代码位置（行号锚点），便于复核。

### 11.1 项目结构与可挂载点

| DSH 模块 | 真实位置 | 关键事实 |
|---|---|---|
| 核心 agent 事件 | `packages/core/agent/src/runtime-types.ts:147-291` | `Events` declare-module 块定义全部 agent 事件及 payload 形状 |
| 工具事件 | `packages/core/tools/src/index.ts:142-208` | `tools/pre-execute` / `tools/execute` / `tools/post-execute` / `tools/result` / `tools/change`；签名 `(exec, result, next)` |
| LLM 服务 | `packages/llm/llm/src/index.ts:180-348` | `LlmAdapter` 抽象类仅暴露 `stream()`；`LlmRuntime.registerAdapter(providers, adapter)` 注册 |
| `llm/stream` 事件 | `packages/llm/llm/src/index.ts:64` | `'(this: LlmRuntime, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>'` |
| LLM 真实调用路径 | `packages/llm/llm/src/index.ts:913` | `stream(options): AsyncIterable<StreamChunk>` 是唯一入口 |
| 插件命名导出 | `packages/llm/llm-deepseek/src/index.ts:41-200`、`packages/subagent/subagent-acp/src/index.ts:23-24` | 必须 named-export `name` / `inject` / `Config` / `apply`，**无 default export** |
| `cordis:group` + `isolate` 用法 | `apps/cli/config/agent-presets/code/agent.cordis.yml:111-148` | `planMode: true` / `compaction: true` / `workflowEngine: true` 等 per-agent 隔离 |
| `disabled` 字段 | `packages/bundle/base/cordis.patch.yml:180-245`、`examples/headless-agent/e2b.cordis.yml:17-20` | 行级 `disabled: true`；支持 `!!js` 插值；不存在 `disable:` 数组形式 |
| Web Profile 默认端口 | `packages/bundle/web-app/cordis.patch.yml:120` | `port: !!js ctx.webStartup.port ?? 3080` |
| Headless Profile | `packages/bundle/headless/cordis.patch.yml` | `dsh --profile headless "<task>"` 一次性 runner，不开 HTTP |
| preset mount 与 isolate | `packages/preset/agent-presets/src/mount.ts:178-265` | `isolate` realm 内 service **不可被宿主面 `inject`**（依赖解析早于会话存在），明确说明该机制用于 per-session scoping |

### 11.2 不合规点逐项摘要

| 序号 | v5 设计 | v5 错误类型 | v6.0 修正 | 涉及文件/章节 |
|---|---|---|---|---|
| 1 | 自定义 `LlmProvider { name, realm, chat, chatStream }` | 接口完全错误 | `LlmAdapter { stream(options) }` + `registerAdapter(['local-llm'], new LocalAdapter())` | § 2.7 / § 2.13 / § 2.14 |
| 2 | `model-router` 同时 provide `llm` | `LlmRuntime` 是单例全局 service，禁止被替换 | 删除 `model-router` 的 `llm` provide；adapters 通过 `ctx.llm.registerAdapter` 接入统一 service | § 2.7 |
| 3 | `isolate: { llm: true }` 解决同名 llm 冲突 | `isolate` 是 per-agent 隔离，宿主面 `inject` 拿不到子 realm service | 删除 isolate 设计；用 adapter 注册路由代替 | § 2.7 / § 4.3 / § 七 |
| 4 | `intent-router` 中 `ctx.llm.chat(messages, options)` + `collectStream(...)` | DSH `LlmRuntime` 无 `chat()` 方法，只有 `stream()` | 改用 `ctx.llm.stream({ messages, provider: 'local-llm', signal })` | § 2.15 |
| 5 | `tools/post-execute` 监听 `toolName === 'llm' \|\| 'model-router'` 并改写 LLM 输出 | LLM 不是 tool；该事件族不覆盖 LLM | 输出过滤改挂 `llm/stream` waterfall（通过 `BlockAssembler` 处理 chunk）；`tools/post-execute` 只用于本地工具结果 | § 4.1 / § 6.2-6.4 |
| 6 | `throw new SecurityError(...)` 在 `agent/pre-step` / `agent/request` waterfall 中 | waterfall listener 应返回决策对象，抛错会绕过 agent loop 决策分支 | 返回 `{ kind: 'reject' }`（pre-step）或返回替换的 `LlmCallConfig`（request） | § 4.1 / § 4.2 |
| 7 | 多处 `inject: ['config']` | DSH 无 `config` 服务；plugin 配置直接通过 `apply(ctx, config)` 第二参数传入 | 删除 `config` 注入项；plugin 必须 named-export `Config: z<Config>` zod schema | § 二 所有 § |
| 8 | 多处 `ctx['xxx']` 字符串下标访问 service | 包 AGENTS.md：可选 service 必须 `ctx.get('name')` | `ctx.get('xxx')` 取代 `ctx['xxx']`；`ctx.xxx` 仅在 `inject` 声明的依赖上保留 | § 二 / § 四 |
| 9 | `cordis.yml` 中 `disable: [dsh-*]` / `disable: true` | Loader 字段是行级 `disabled: true`，无数组形式 | 全部 `disable:` → `disabled:` | § 8.19.6 / § 七 |
| 10 | `agent/request` payload 含 `intent` / `dataLevel` 字段 | 该事件 payload 只有 `{ agent, turn, step, signal }` | 监听器自行把 `intent` / `dataLevel` 作为旁路维护（payload 可变），或注册到 `agent.ctx` 状态对象上 | § 4.1 |
| 11 | `tools/post-execute` 监听器签名 `(payload, payload, next)` | 真实签名是 `(exec, result, next)`，`result` 是 `Readonly` | 改写监听器形参；`toolName` 改为 `exec.name` | § 4.1 / § 4.2 |
| 12 | `runAgentLoop(ctx, ...)` 自定义入口 | DSH 无该函数；启动对话需 `ctx.agents.create(...)` → `agent.followup(userMsg)` | http-api 通过 `ctx.agents` 拿 agent；订阅 `session/event` / `assistant/chunk` 拿流 | § 8.19.4 |
| 13 | 所有 plugin named-export 仅 `inject` + `apply` | 包 AGENTS.md 强制四项 named-export；`name` 与 `Config` 缺失 | 补齐 `export const name = '...'` 与 `export const Config: z<Config> = z.object(...)` | § 二 所有 § |

### 11.3 实施期额外的源码核查清单

每阶段开工前，对照 DSH 源码再核一遍：

- [ ] 当前阶段新引入的 plugin 是否 named-export `name` / `inject` / `Config` / `apply` 全部四项？
- [ ] 当前阶段若新增 `cordis.yml` 行，禁用字段是否用了 `disabled:`（不是 `disable:`）？
- [ ] 当前阶段是否用到 `ctx.llm.chat(...)` 之类的方法？（应替换为 `ctx.llm.stream(options)`）
- [ ] 当前阶段是否在 waterfall listener 里 `throw`？（应改返回决策）
- [ ] 当前阶段是否在监听 LLM 输出？（应挂 `llm/stream`，不是 `tools/post-execute`）
- [ ] 当前阶段是否 `inject: ['config']`？（应删除，配置走 `apply` 第二参数）
- [ ] 当前阶段是否在 `cordis.yml` 中通过 `inject: [local-llm-realm]` 引用一个 `cordis:group` 子树？（该用法不可行——子 realm service 不可被宿主 `inject`）

### 11.4 仍然成立的设计前提

以下 v5 假设在 v6.0 中**经源码复核确认仍然有效**，无需修改：

- 所有安全/隐私能力通过纯插件代码 + cordis.yml 配置层 + 测试基础设施实现，不修改 DSH 核心源码。
- DSH 内置 Runtime Profile 仅有 `web`（3080 端口浏览器 UI）与 `headless`（一次性 runner），无内置 HTTP API service。`http-api` 插件设计成立。
- Agent Loop 不替换；定制逻辑通过 `agent/pre-step` / `agent/request` / `agent/turn-stopping` 等事件注入。
- 工具通过 `ctx.tools.register(definition)` 注册到标准注册表。
- 事件基于 Cordis `emit / parallel / serial / bail / waterfall` 五种模式分发。
- `cordis:group` + `isolate` 机制真实存在，可用于 per-agent scoping（v6.0 中用于 prompt-guard、td-bus 等独立 realm）。
- Whisper / llama.cpp / OHTTP / TEE SDK 通过对应插件封装调用，DSH 进程不直接依赖 native 模块。
- native addon（如 `dsh-tool-call-timeout-policy`）的封装约定沿用 `packages/core/tools/src/index.ts:235-247` 的 `ToolDefinition.execute(args, exec)` + `signal` 模式。

### 11.5 已识别的开放问题（v6.0 → 2026-08-24 状态）

> v6 初稿（2026-08-16）列出的开放问题在 2026-08-24 代码实装下分两类：**已关闭**（实装完成）和**仍开放**（后续阶段处理）。

#### 已关闭（2026-08-24）

| 问题 | 关闭时间 / 提交 / 文件 |
|---|---|
| REJECT 意图拦截未实现 | **closed** — `intent-router.classify()` 引入隐私策略 pre-check + fallback rules 双 REJECT 路径（http-api.ts:218-402 → 403 short-circuit）；shipped `privacy-policy.json` 含 2 条 REJECT 规则（业务危险操作）；**真实环境 e2e 验证 17/17 通过**（2026-08-24，三层防御：prompt-guard 正则 HTTP 400 拦截攻击模式 + prompt-guard 模型 HTTP 400 拦截复杂攻击 + privacy-policy HTTP 403 拦截业务危险操作） |
| `sanitizer-pipeline` 缺同步反脱敏入口 | **closed** — 新增 `desanitizeSync(text, sessionId)`（sanitizer-pipeline.ts:??），供 `handleChatStream` 逐 chunk 还原 |
| `sanitizer-pipeline` 缺 `purge()` | **closed** — 新增 `purge(sessionId)`（sanitizer-pipeline.ts:??），由 http-api `handleDeleteSession` 调用 |
| `tools.enableToolIsolation` 配置未生效 | **closed** — G8（commit `b39d21f`）把 `enableToolIsolation` 真接入 `filterTools(intent)` / `isToolAllowed(name, intent)` |
| `intent-router.confidenceThreshold` Schemastery 拒绝 0.6 | **closed** — commit `18d247d` 把 schema 从 `Schema.natural()` 改为 `Schema.number().min(0).max(1)` |
| `intent-router` 解析失败与 LLM 错误混计数 | **closed** — P1 hardening（commit `c7b5daa`）拆分 `parseFailure` 与 `llmError` |
| `intent-router` `sanitizeError` 审计级别不够 | **closed** — 同上 commit 改 `level='security'`（SIEM 可见） |
| intent-router 缺置信度分布可观测性 | **closed** — G9（commit `b4e5810`）在 `getStats()` 加入 `confidenceHistogram` 10-bucket × `{accepted, rejected}` |
| `http-api` 缺 threat-block 阻断 | **closed** — `td-bus.shouldBlock()` 在 `handleChat` 入口 503 短路 |
| `http-api` 缺会话映射清理 | **closed** — `handleDeleteSession` 调 `sanitizer.purge(id)`；LRU eviction 同步清理 |
| 隐私策略文件**篡改检测**（签名验证） | **closed** — `privacy-policy` 新增 HMAC-SHA256 sidecar 校验：env `DSH_EDGE_POLICY_HMAC_KEY` 启用，启动 + mtime 轮询双路径校验；fail-closed `audit('security', 'policy.tamper-detected', { reason })`；env 未设走 dev/CI 默认并发出一次性 `policy.signing.disabled` 通知 |
| `http-api` 的 `provider/model` 硬编码点 | **closed** — 提取 `resolveRoute(ctx, isLocal)`（http-api.ts）：优先 `modelRouter.resolve(preferred)`，失败/缺失时回退硬编码对；soft-dep 模式（不 `inject`）避免 boot order 变更 |
| `prompt-guard` `action: sanitize` 行为未实装 | **closed** — sanitize 档位改为改写命中为 `[REDACTED:<ruleName>]`，audit `info` `guard.rule.sanitized`；block/warn 语义不变；改写后文本通过 `InputCheckResult.sanitizedText` 暴露给调用方 |

#### 仍开放（后续阶段）

| 问题 | 影响 | 建议下一步 |
|---|---|---|
| TEE 后端在裸机 RK3588 上的 TrustZone 接入 | `tcm` 当前 simulated 后端（`crypto.subtle` / `node:crypto`） | A3 阶段：real-mode 接口预留，simulated 完整覆盖 dev/CI |
| Whisper / llama.cpp native binding 在 arm64 RK3588 上的打包 | 体积、依赖链、冷启动延迟 | A8 阶段做 bench；必要时 WASM 替代或预编译 `.node` artifact |
| OHTTP Relay 部署：DSH 内置示例无 OHTTP 拓扑，需自建 | A4 阶段受外部依赖阻塞 | 提供 docker-compose 模板（含 relay + target mock）放在 `examples/ohttp-topology/` |
| `prompt-guard` 缺输出端覆盖（双 gap：流式无 checkOutput + 输出端无 `sanitize` 档位） | (a) `checkOutput` 仅 `/v1/chat` 调用（`http-api.ts:394`），`/v1/chat/stream` 路径**完全无 checkOutput 兜底**——流式 chunk 端 PII 可能漏出；(b) 策略为 `block/warn/sanitize` 三档，输入端 `sanitize` 已实装（commit `53dde0b`），输出端仍是 redact-or-not 二档 | A1.5 阶段：`handleChatStream` 接入 `checkOutput`（沿用 `sanitized: wasSanitized` 上下文避免与 desanitize 矛盾），并补全输出端 `sanitize` 路径（独立脱敏 vs 走 sanitizer-pipeline 复用） |
| 安全管线仅在 http-api 进程内生效 | 绕过 http-api 直调 `ctx.agents.followup()` 不享受任何拦截 | 若启用 web UI / CLI 直调 Agent Loop，需把整条管线复制一份到工具调用入口（v6.0 §4.1 修订已注明） |
| `tools.filterTools(intent)` 已实装但未在 routing pipeline 中调用 | G8（commit `b39d21f`）接通 `enableToolIsolation` 开关 + `filterTools`/`isToolAllowed` 服务接口 + `tools.test.ts` 14 用例，但 `grep -r filterTools src/` 在定义点之外**零调用方**——`http-api.handleChat`/`handleChatStream` 也未消费；意味着即使在 http-api 进程内 realm 隔离也未生效 | A0.5 阶段：http-api `handleChat` 在 `record.agent.followup(userMessage)` 之前调 `edgeTools.filterTools(intent)`，agent-loop 直调入口做同样过滤 |
| `policy.tamper-detected` 事件 emit 方已就绪、订阅侧未接线 | `privacy-policy.ts:209-225` 在 HMAC 校验失败时 emit `policy.tamper-detected`（security 级，commit `53dde0b`），但 §1.6.7 checkbox 仍标"实装未订阅"；audit-log 是 fire-and-forget 写入 JSONL，SIEM / OHTTP 联动 / secure-bridge 均未订阅该事件 → 篡改检测目前只是写入日志、不触发任何外部响应 | A2.5 阶段：在 audit-log 上挂 `policy/tamper-detected` 订阅，转发到 SIEM forwarder；OHTTP relay topology（A4）接通后联动降级云端路由 |
| `policy/loaded` 事件零订阅方 | `privacy-policy.ts:357-374` 在热重载时 emit `policy/loaded`，但 `grep "on('policy/loaded')" src/` 在 `privacy-policy.ts` 之外**零命中**——intent-router / prompt-guard 不订阅 → 热重载后两者仍持旧快照，路由与脱敏规则不刷新 | A2.5 阶段：intent-router / prompt-guard 在 `apply()` 里挂 `privacyPolicy.on('policy/loaded', () => { /* 刷新内部快照 */ })`，避免 mtime 改动后业务侧延迟一周期 |
| `handleChatStream` 入口未调 `tdBus.shouldBlock()` | `handleChat` 入口已调 `tdBus.shouldBlock()` 503 短路（`http-api.ts:251-262`）；`handleChatStream` 入口**未调** `shouldBlock`/`recordCloudRequest`——流式入口可绕过进程级威胁阻断 | A0.5 阶段：`handleChatStream` 复制 `handleChat` 的 td-bus 前置检查（503 短路 + `recordCloudRequest()`） |
| `intentRouter.classify()` 多轮上下文 dead code | `intent-router.classify(text, context)` 支持 `{ recentMessages, sessionId }`，53 个单测覆盖；但 `http-api.ts:291`、`:461` 调用 `intentRouter.classify(message)` **不传任何 context 字段** → recent-messages 嵌入、多 turn 协同分类在生产路径上是死代码 | A0.5 阶段：`handleChat` 从 `record.agent.session.events` 拉最近 N 条（`recentMessagesLimit`），转成 `recentMessages` 传给 `intentRouter.classify` |
| 流式分类（每 token 增量判定） | 当前每 turn 一次完整 LLM call；无 token 级增量分类 | v6 §5.5 未来工作 |


---


# 第10章 设计基线：Realm × Skill × Tool 模型

> 来源：`07-design-baseline/#第10章--设计基线realm--skill--tool-模型`

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
  ├─ model-router.resolve('CLOUD') → cloud-llm
  ├─ sanitizer.sanitize(text) → 脱敏（如有 PII）
  │
  ├─ ctx.agents.create({ model: 'cloud-llm', realm: 'CLOUD' })
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
  ├─ model-router.resolve('LOCAL') → local-llm
  │
  ├─ ctx.agents.create({ model: 'local-llm', realm: 'LOCAL' })
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


---
