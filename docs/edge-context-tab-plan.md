# dsh-edge-agent 桌面右栏 "Edge" tab —— 实施计划

> **范围声明（v3，2026-10-19）**：本计划**仿造 dsh-context v0.73.3 host+client 双半体结构**，
> 在 DSH 桌面右栏增加一个 Edge tab，呈现本仓 **4 个核心隐私 flow + 1 个 session summary 条** 的实时状态：
>
> | Panel | 字段源 plugin | 数据 |
> |---|---|---|
> | **Intent** | `intent-router` | classify.start/.end、intent 类别、置信度、是否 fallback |
> | **Route** | `model-router` + `cloud-llm-adapter` + `local-llm-adapter` | provider / model / baseUrl / delegate / 状态 |
> | **Interception** | `input-guard` + `prompt-guard` + `sanitizer-pipeline` | guard.input/.output、sanitize.replace、preflight、downgraded |
> | **Threat** | `td-bus` | td.alert severity / rule |
> | Session summary 条 | `sessions` | sessionId / 轮次 / token 累计 |
>
> **架构沿用 dsh-context**：host+client 半体、Preact+esbuild、tsc 排除 src/client、`sidebarRightTabs.register` 注册。
> **内容是本仓特有**：4 个独立 stream + session summary seam；严格**不展示原始 PII**。

## 0. 与 §7.x 主线的关系

- 本计划从属于"为 dsh-edge-agent 在桌面内提供原位可视化"。
- §7.98.1（30% 复测）后续修复由独立 §7.99 计划推进，**不**在本计划观察范围。
- 本计划引入 1 个 host 端新 plugin（`edge-context-view`）、4 个 client panel + 1 个 summary 条、1 段 esbuild 出 bundle 的步骤。

## 1. 现状（截至 2026-10-19）

| # | 项 | 状态 |
|---|---|---|
| 1 | `package.json#dsh.client.{inject,platform,entry}` 已加 | ✅ |
| 2 | `package.json#exports["./client"]` 指向 `lib/types/client/index.js` | ✅ |
| 3 | `src/client/index.ts` —— 注册占位 sidebar tab（71 行 skeleton）| ✅ |
| 4 | tsc 产物 `lib/types/client/{index.js,index.d.ts}` | ✅ |
| 5 | 桌面右栏看到 "Edge" tab | ⏳ 等装机 |
| 6 | dsh-context v0.73.3 源码 walkthrough（host seam + client 注册 + 4 panel slot API）| ❌ |
| 7 | host 端新 plugin `edge-context-view`（4 panel + session summary，inject 8 服务）| ❌ |
| 8 | client 组件（Intent / Route / Interception / Threat + Session summary）| ❌ |
| 9 | esbuild 出 `lib/client.js` bundle（tsc 排除 src/client）| ❌ |
| 10 | 桌面 0.2.1-rc.2 装机实测 —— 11 项验收均过 | ❌ |

## 2. 不做的（明确剔除）

- 自研技术栈（不用 tsdown / tailwindcss / lightningcss）
- 自建 seam 通道（沿用 dsh-context 的 AsyncIterable 模式）
- detail channel（按需重型数据拉取）
- 跨 session 聚合
- §7.x 调试可视化（`prompt-guard fallback-token-only` 等 400 路径的专门字段）
- 独立隐私审查章节（沿用 dsh-context 的威胁模型）
- **PII 摘要展示** —— 4 个 panel **不**展示原始 PII；只展示计数 + 类别 + 时间戳 + 级别
- 回滚策略（tab 加载失败回退到当前 skeleton）

## 3. 实施阶段（3 阶段）

### 阶段 1：dsh-context v0.73.3 walkthrough（3-4h）

读 4 个文件并 dump 形状到 `docs/notes/dsh-context-walkthrough.md`：

| 源 | 取什么 |
|---|---|
| `src/host/timeline.ts` | seam 折叠形态、event shape、AsyncIterable 暴露方式 |
| `src/client/connection.ts` | client 订阅模式（event emitter / for-await / 这两种？）|
| `src/client/{tokens,timeline,...}.tsx`（dsh-context 自己的 3 个组件）| panel 结构 + slot API（**特别关注 slot 是单一事件 / 列表 / 编辑器**）|
| `package.json#dsh.client.{inject,entry,platform}` | dsh-context 自己怎么配这几个字段 |

### 阶段 2：本仓实现（8-12h）

**host** —— 新增 `src/dsh-adapter/edge-context-view.ts`：

- inject **8 个**：`[intentRouter, modelRouter, inputGuard, promptGuard, sanitizer, tdBus, sessions, auditLog]`
- **不**注入 `cloudLlm / localLlm`（通过 model-router 派生即可；减少 inject 数量）
- 暴露 **5 个 seam**：

  | seam | 来源 event 订阅 |
  |---|---|
  | `ctx.edgeContextView.intentStream(sessionId?)` | `intentRouter` 转发 `intent.classify.start` / `.end` |
  | `ctx.edgeContextView.routeStream(sessionId?)` | `modelRouter` 状态变化 + `cloudLlm`/`localLlm` 选择（通过 modelRouter 派生）|
  | `ctx.edgeContextView.interceptionStream(sessionId?)` | `inputGuard.preflight` / `.sanitized` / `.downgraded` + `promptGuard.guard.input` / `.guard.output` + `sanitizer.replace` / `.desanitize` |
  | `ctx.edgeContextView.threatStream(sessionId?)` | `tdBus` 转发 `td.alert` |
  | `ctx.edgeContextView.sessionSummary(sessionId?)` | `sessions` 聚合：起止时间、轮次、token 累计 |

- 每个 stream = `AsyncIterable<{ ts: number; sessionId: string; panel: 'intent'|'route'|'interception'|'threat'|'sessionSummary'; payload: SafePayload }>`
- payload 严格走 `src/dsh-adapter/pii-utils.ts` 的 5 类 PII 检测（phone / id-card / bank-card / email / api-key）；命中即 tokenize

**client** —— 复制 dsh-context panel 组件结构，按 panel 映射字段：

- 4 个 `.tsx` 文件：`intentPanel.tsx` / `routePanel.tsx` / `interceptionPanel.tsx` / `threatPanel.tsx`
- 1 个 session summary 组件：`sessionSummary.tsx`
- **Preact + esbuild**（与 dsh-context 同栈；**不**引入 tsdown / tailwindcss）
- inject 服务名沿用本仓 `package.json#dsh.client.inject` 已配置的 3 个

**patch** —— `cordis.desktop-safe.patch.yml` 加 1 行：

```yaml
- insert:
    - id: edge-context-view
      name: '@deepseek-harness-edge-agent/dsh-edge-agent/edge-context-view'
      inject: [intentRouter, modelRouter, inputGuard, promptGuard, sanitizer, tdBus, sessions, auditLog]
      config:
        bufferSize: 64
        sessionTtlMs: 1800000
        piiRedact: true
```

### 阶段 3：build 管线 + 装机验证（2-4h）

- `tsconfig.json`：
  - 加 `"exclude": ["src/client"]` —— 避免 tsc 重出 `lib/types/client/`
  - 加 `"jsx": "react-jsx"`, `"jsxImportSource": "preact"`
- `scripts/build-client.mjs`（esbuild，~30 行）：
  - 入口 `src/client/index.ts`（含 4 panel + summary 组件）
  - bundleFormat: `'esm'`, platform: `'browser'`
  - 输出 `lib/client.js` + `lib/client.css`
  - **build 之前** `rm -rf lib/types/client`（清掉 tsc 旧产物）
- `package.json#dsh.client.entry` 改 `./lib/client.js`
- `npm run verify:build` 全绿 + 桌面装机 11 项验收

## 4. 风险（4 条）

| 风险 | 严重度 | 缓解 |
|---|---|---|
| `sidebarRightTabs.register` 签名在 0.2.1-rc.2 / 0.2.1 stable 不同 | 高 | 阶段 1 walkthrough 已 dump 真实签名；阶段 3 装机 smoke test 是最终检查 |
| tsc 与 esbuild 双产物共存（`lib/types/client` vs `lib/client.js`）| 中 | tsconfig exclude `src/client/`；build-client 前 `rm -rf lib/types/client`；加 verify 脚本巡检 |
| inject 8 服务，cordis 加载顺序影响 seam 事件时序（PROGRESS §7.94 多次踩坑）| 中 | 阶段 1 第一件事做 **inject 拓扑 audit**（哪些 plugin 先启、emit 时谁先谁后）；阶段 2 实施前用 mock 验证每个 stream 的 emit 时序 |
| bundle 超 50KB（4 panel + Preact 大约 80-100KB）| 低 | 单 build 监控；超则 Threat / Interception 共用 panel slot，或砍 session summary 为计数占位 |

## 5. 接受标准（11 项）

阶段 3 出口，**11 项**全部满足才算 done：

| □ | 项 |
|---|---|
| □ | 装机后桌面右栏出现 "Edge" tab，位置与 dsh-context 的 "Context" tab 同高度 |
| □ | 切到 Edge tab，bundle 加载控制台 0 报错 |
| □ | Intent panel —— 发本地 query → 出现一行：intent 类别 / 置信度 / 是否 fallback |
| □ | Route panel —— 发 query → 出现一行：provider / model / baseUrl / 状态 |
| □ | Interception panel —— 发含 PII 的 query → 出现 sanitize.replace 行 + guard.input 决策行 |
| □ | Threat panel —— 触发 td.alert（注入测试用例）→ 出现一条告警含 severity + rule |
| □ | Session summary 条 —— 跨多轮 query 后显示 turn 数 + token 累计 |
| □ | 切到后台再切回 → 数据保留（不重 mount 清空）|
| □ | 切换桌面主题深/浅 → 配色跟随，无白底穿帮 |
| □ | 切换桌面语言 zh/en → 文案跟随 |
| □ | **4 个 panel 都不展示原始 PII**（抽查面板 DOM，确认 phone / id-card / bank-card / email / api-key 5 类都不出现）|

## 6. 文件清单

**新增：**

- `src/dsh-adapter/edge-context-view.ts` —— host 端 plugin（4 panel + session summary seam，inject 8 服务）
- `src/client/{intentPanel,routePanel,interceptionPanel,threatPanel,sessionSummary}.{tsx,ts}`
- `scripts/build-client.mjs` —— esbuild 出 lib/client.js
- `docs/notes/dsh-context-walkthrough.md` —— 阶段 1 walkthrough 落档
- `tests/unit/edge-context-view.test.ts` —— seam fold 单测（4 类各 1-2 case）

**修改：**

- `src/client/index.ts` —— 改为 mount 4 panel + summary
- `cordis.desktop-safe.patch.yml` —— 加 `edge-context-view` insert row（8 inject + `piiRedact: true`）
- `tsconfig.json` —— exclude `src/client/`；加 jsx 配置
- `package.json` —— `dsh.client.entry` 改 `./lib/client.js`；加 preact devDep；加 `build:client` script

**不引入：**

- tsdown / tailwindcss / lightningcss
- 新 schema / 新事件类型
- detail channel
- WebSocket / SSE（沿用 dsh-context 已用的方式）

## 7. 时间预估（13-20h）

| 阶段 | 估时 |
|---|---|
| 1 walkthrough | 3-4h |
| 2 实现（host 8 inject + 4 panel + 1 summary + patch）| 8-12h |
| 3 build + 装机验证 | 2-4h |
| **合计** | **13-20h** |

## 8. 不承诺的口径

本计划**不**承诺以下用户视角能力：

- "Edge tab 可被用户用来调 §7.x 的可观测性 bug"
- "L2 云池切换前后的对比可视化"
- "PII 摘要展示给用户" —— **强制规则**：4 个 panel **不**展示原始 PII（即使已脱敏过的占位符 `<<PII_PHONE_1>>` 也不直接展示）

## 9. 后续可考虑（不在本计划）

- dsh-context 工具链全套对齐（tsdown + tailwindcss）—— 如果阶段 2 后组件复杂度上升
- main panel `Watch Insight` 页（仿 dsh-context）—— 与本 plan 平行启动
- §7.x 调试可视化（prompt-guard `fallback-token-only` 等 400 路径）—— 由 §7.99 计划承接
- 把现有 `dsh-edge-flow.html`（82KB 静态）deprecate —— 在 Edge tab 装机稳定后单独处理
- panel 内增加"详情 modal"（点击 row 弹窗显示与该事件相关的更多上下文，仍走 PII 过滤）—— 现版本不做

## 10. 修订历史

- **v1**（未提交），~345 行：自研方案，4 panel + 8 inject + schema reconcile + 自研 seam 折叠
- **v2**（commit `ba689d1`，2026-10-19），~162 行：仿 dsh-context、仅 3 panel、最窄范围
- **v3**（2026-10-19），~210 行：仿 dsh-context 架构 + 本仓 4 panel + session summary，inject 8 服务；硬规则：**不展示原始 PII**
- **v4**（本版已落档 + 实现完成，2026-10-20）：
  - **裁决 A**：seam 数据源是 audit-log 记录（非可订阅事件流）——`audit-log.ts` 新增 `onEntry(listener)` 活体监听 seam（追加-only、逐 listener try/catch fail-open、ring push 后触发、含未 flush 条目；unit test 已加）。
  - **裁决 B**：传输改为 dsh-context 的 **POST route pull**（框架 `connection.fetch.register`，path `/api/dsh-edge/context`，client `api/dsh-edge/context` 轮询 + cursor）。`snapshot()` 返回纯数据，**不是** AsyncIterable（浏览器订不到 cordis）。
  - **裁决 C**：session summary token 源 = `assistant/message.usage`（adapter 报账才显示，未报则"—"）。
  - **裁决 D**：原 8 inject 缩为 `['auditLog']` 硬 + `['connection']`/`['slots','locale']` 软延迟；其余 6 个服务无可读 API。
  - **裁决 E**：`sessionProjections` 物理上装不下边缘隐私事件（SessionEvent 词表封闭，无自定义 kind），故不强求用纯 switch。
  - **build**：tsc 排除 `src/client`（emit），独立 `tsconfig.client.json`（noEmit + jsx preact）做类型门；`scripts/build-client.mjs` esbuild 出 `lib/client.js`（20 KB，远低于 50 KB 风险项）。
  - **新增文件**：`src/dsh-adapter/edge-context-view.ts`（host）、`src/client/*`（11 个）、`scripts/build-client.mjs`、`tsconfig.client.json`、`tests/unit/edge-context-view.test.ts`、`docs/notes/dsh-context-walkthrough.md`。
  - **修改文件**：`audit-log.ts`、`cordis.desktop-safe.patch.yml`、`package.json`（exports/`./edge-context-view`、`./client` → `./lib/client.js`、`dsh.client.entry`、`build:client`/`typecheck:client`、devDeps preact + esbuild）、`tsconfig.json`（exclude）、`scripts/verify-plugin-spec.ts`（`./client` 跳过源文件存在性检查——bundle 走 dsh.client.entry）。
  - **11 项验收**（计划 §5）：本环境能验的 8 项全部通过（tsc compile、tsc-client typecheck、esbuild bundle、verify:build 5 道门、31 个新单测全过、桌面 installable bundle smoke 含 `lib/client.js` 与新 patch row、PII 5 类在 host 折叠时已 tokenize、tab 类型在 deferred 注入下 mount 失败也保持插件健康）。装机目视验证（11 项中剩 3 项：右栏 Edge tab 出现、深浅主题跟随、zh/en 文案跟随）需在桌面 0.2.1-rc.2 实跑。
