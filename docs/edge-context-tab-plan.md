# dsh-edge-agent 桌面右栏 "Edge" tab —— 实施计划

> **范围声明（v4，已落档 + 实现完成，2026-10-20）**：本计划**仿造 dsh-context v0.73.3 host+client 双半体结构**，在 DSH 桌面右栏增加一个 Edge tab，呈现本仓 **4 个核心隐私 flow + 1 个 session summary 条** 的实时状态：
>
> | Panel | 字段源 plugin | 数据 |
> |---|---|---|
> | **Intent** | `intent-router` | classify.start/.end、intent 类别、置信度、是否 fallback |
> | **Route** | `model-router` + `cloud-llm-adapter` + `local-llm-adapter` | provider / model / baseUrl / delegate / 状态 |
> | **Interception** | `input-guard` + `prompt-guard` + `sanitizer-pipeline` | guard.input/.output、sanitize.replace、preflight、downgraded |
> | **Threat** | `td-bus` | `td-bus.escalated` severity / rule（计划 §3 原写"td.alert"为命名误，最终 kind 是 `td-bus.escalated`）|
> | Session summary 条 | 进程内 `session/event` listener + audit | sessionId / 轮次 / token 累计（adapter 报账才显示）|
>
> **架构沿用 dsh-context**：host+client 半体、Preact+esbuild、`tsc` 排除 `src/client`（emit）、独立 `tsconfig.client.json` 做类型门、`sidebarRightTabs.register` 注册 tab 类型、`slots.register('sidebar.right.pane.tab', ...)` 挂载主体。
> **传输是 dsh-context 的标准件 `connection.fetch.register` POST route pull**（非自研 AsyncIterable seam —— 见裁决 B）。
> **数据源是 `audit-log.ts` 增的 `onEntry` 活体监听**（非可订阅的 plugin 事件流 —— 见裁决 A）。
> **内容是本仓特有**：4 个独立 stream + session summary seam；严格**不展示原始 PII**。

> **状态（v5，2026-10-29 §7.146 刷新）**：本文是**已落地计划书**，不是待办。
> 实现完成 2026-10-20；桌面装机闭环 2026-10-22（§7.106）；§7.142 改口径为
> 「Edge tab 常驻注册，只有边缘模式才真正生效」；§7.145-B 加了「尚未绑定会话」
> 面板口径；§7.145-C 加了构建链门禁（漏跑 `build:client` ⇒ 直接失败而非静默
> 消失 Edge tab）。**11 项验收现为 9 ✅ / 2 ⏳**（见 §5，余 2 项是无实机取证，
> 不拿设计满足冒充实测）。下方 v4 段落保持原样，作为当时的决策留档。

## 0. 与 §7.x 主线的关系

- 本计划从属于"为 dsh-edge-agent 在桌面内提供原位可视化"。
- §7.98.1（30% 复测）后续修复由独立 §7.99 计划推进，**不**在本计划观察范围。
- 本计划引入 1 个 host 端新 plugin（`edge-context-view`）、1 个 audit-log 服务接口增量（`onEntry`）、1 段 esbuild 出 bundle 的步骤、5 个 client panel 文件 + 4 个 client 支撑文件。

## 1. 现状（实现完成 2026-10-20；桌面装机闭环 2026-10-22 §7.106；本表刷新于 2026-10-29 §7.146）

| # | 项 | 状态 | 备注 |
|---|---|---|---|
| 1 | `package.json#dsh.client.{inject,platform,entry}` 已加 | ✅ | entry 现为 `./lib/client.js` |
| 2 | `package.json#exports["./client"]` 指向 `lib/client.js`（esbuild bundle） | ✅ | 同步增 `./edge-context-view` 子路径 |
| 3 | `src/client/index.ts` —— mount 4 panel + summary，4 道 deferred inject | ✅ | 71 行 skeleton → 168 行实装 |
| 4 | esbuild bundle `lib/client.js` 落位 + `lib/types/dsh-adapter/edge-context-view.{js,d.ts}` | ✅ | 20 KB（远低于原 50 KB 风险项） |
| 5 | 桌面右栏看到 "Edge" tab | ✅ | **已装机实测**（§7.106，2026-10-22 桌面截图为证；§7.142 起 tab **常驻注册**，不再跟默认 preset 走） |
| 6 | dsh-context v0.73.3 源码 walkthrough | ✅ | `docs/notes/dsh-context-walkthrough.md` |
| 7 | host 端新 plugin `edge-context-view`（4 panel + session summary，inject `['auditLog']` 硬 + 软延迟） | ✅ | 原计划 8 inject，v4 缩为 1 |
| 8 | client 组件（Intent / Route / Interception / Threat + Session summary）| ✅ | 5 个 .tsx + 5 个支撑 .ts |
| 9 | esbuild 出 `lib/client.js` bundle（tsc 排除 `src/client`，独立 `tsconfig.client.json` 类型门）| ✅ | styles 内联，无 `lib/client.css` |
| 10 | 桌面装机实测 —— 11 项验收 | **9 ✅ / 2 ⏳** | 见 §5（#9 已由 §7.106 桌面截图闭环；#10、#11 的深浅主题 / en 切换部分仍无实机取证） |
| 11 | **构建链门禁**：漏跑 `build:client` ⇒ Edge tab 静默消失 | ✅ | §7.145-C：`rebuild-installable.mjs` 自检缺浏览器半边 ⇒ **exit 1**（不再是静默） |

## 2. 不做的（明确剔除）

- 自研技术栈（不用 tsdown / tailwindcss / lightningcss）
- ~~自建 seam 通道（沿用 dsh-context 的 AsyncIterable 模式）~~ —— **v4 修订**：dsh-context v0.73.3 实际无 AsyncIterable seam（已 walkthrough 核实），传输走 dsh-context 的 `connection.fetch.register` POST route pull 框架标准件
- detail channel 语义（按需重型数据拉取）—— 与上对齐，POST route 是"沿用 dsh-context 标准件"，不是新加重型数据 channel
- 跨 session 聚合
- §7.x 调试可视化（`prompt-guard fallback-token-only` 等 400 路径的专门字段）
- 独立隐私审查章节（沿用 dsh-context 的威胁模型）
- **PII 摘要展示** —— 4 个 panel **不**展示原始 PII；只展示计数 + 类别 + 时间戳 + 级别
- 回滚策略（tab 加载失败回退到当前 skeleton）
- 新 cordis 事件类型 / 新 audit kind —— v4 新增 `auditLog.onEntry(listener)` 是 service 接口增量（非新事件类型）
- 新 SessionEvent kind —— SessionEventMap 词表封闭（见裁决 E）

## 3. 实施阶段（3 阶段）—— 已完成

### 阶段 1：dsh-context v0.73.3 walkthrough（3-4h）✅

读 5 个文件并 dump 形状到 `docs/notes/dsh-context-walkthrough.md`：

| 源 | 取什么 |
|---|---|
| `src/host/timeline.ts` | Projection unit 形状：`{key, stateSchema(zod), init(), apply(state,SessionEvent)→state, wire:{viewSchema,view}, stateVersion}` |
| `src/host/connection.ts` | `connection.fetch.register({path, methods:['POST'], requestBody:'buffered', fetch})` —— POST route 标准件 |
| `src/host/index.ts` | inject=`['sessionProjections']` 硬依赖；deferred `ctx.inject(['connection','sessions'], ...)` 装载 route |
| `src/client/services.ts` | face 类型本地声明；`SessionStandardProps { sessionId?, useProjection?(key), useChat? }` |
| `src/client/timelineSource.ts` + `src/client/sidebar.ts` | client `fetch('api/<plugin>/<route>', {method:'POST', body})` 模式；`slots.inject('sidebar.right.pane.tab', ...)` 挂载主体 |
| `package.json#dsh.client` | `{inject:[6 上游包], platform:'web'}` —— **无 `entry` 字段**（双保险：本仓设 `entry` 字段不冲突） |

### 阶段 2：本仓实现（8-12h）✅

**裁决（见 §10 v4）核心结论**：v0.73.3 用**两条框架标准通道**——`sessionProjections` push（仅 SessionEvent 可折）+ `connection.fetch.register` POST route pull（on-demand）。本仓边缘隐私事件不进入 SessionEvent（封闭词表）→ 走 POST route pull。

**host** —— 新增 `src/dsh-adapter/edge-context-view.ts`：

- inject **`['auditLog']` 硬 + `['connection','slots','locale']` 软延迟**（v3 计划的 8 inject 已废，见裁决 D）
- 暴露 **`snapshot(sessionId, cursor)`** 纯数据接口（**不是** AsyncIterable，见裁决 B）
- 折叠数据源：
  - **`auditLog.onEntry(listener)`** 活体监听（**裁决 A**：audit-log 新增的 seam，ring push 后 fire、逐 listener try/catch fail-open、含未 flush 条目）
  - **`ctx.on('session/event', ...)`** 进程内监听（同 http-api.ts:567 习语），折 `turn/start` 计数 + `assistant/message.usage` token（**裁决 C**）
- 5 类 kind → panel 映射表（walkthrough §6）—— `internal_kinds` 黑名单（`input-guard.hook.registered` 等启动期噪音不进 panel）
- payload 严格走 `src/dsh-adapter/pii-utils.ts` 的 5 类 PII 检测（phone / id-card / bank-card / email / api-key）；命中即 tokenize；安全兜底 `piiRedact: false` 时仍允许原值（运维 opt-out）
- 路由：`/api/dsh-edge/context`（**裁决 B**），host 端 `connection.fetch.register`，client 端 `api/dsh-edge/context` 浏览器相对路径（反向代理前缀纪律）

**client** —— 复制 dsh-context panel 组件结构，按 panel 映射字段：

- 4 个 `.tsx`：`intentPanel.tsx` / `routePanel.tsx` / `interceptionPanel.tsx` / `threatPanel.tsx`
- 1 个 session summary：`sessionSummary.tsx`
- 支撑文件：`types.ts`（wire 镜像）、`store.ts`（模块级单例 + 2s 轮询）、`rows.tsx`（共享 RowList + level tint）、`theme.ts`（`currentColor` + `color-mix` 主题跟随）、`i18n.ts`（zh/en 字典 + `setTranslator()` 兜底）
- **Preact + esbuild**（与 dsh-context 同栈；**不**引入 tsdown / tailwindcss）
- 4 道 deferred `ctx.inject`（`locale` / `sidebarRightTabs` / `slots` / `slot-body`）—— `CordisCtx` 局最小面声明绕开 `verify:boundary`

**patch** —— `cordis.desktop-safe.patch.yml` 加 1 行：

```yaml
- id: edge-context-view
  name: '@deepseek-harness-edge-agent/dsh-edge-agent/edge-context-view'
  inject: [auditLog]   # 仅 1 硬依赖；connection 软延迟
  config:
    bufferSize: !!js parseInt(process.env.DSH_EDGE_VIEW_BUFFER_SIZE ?? '64', 10)
    sessionTtlMs: !!js parseInt(process.env.DSH_EDGE_VIEW_SESSION_TTL_MS ?? '1800000', 10)
    piiRedact: !!js process.env.DSH_EDGE_VIEW_PII_REDACT !== 'false'
```

### 阶段 3：build 管线 + 装机验证（2-4h）✅（除装机目视 3 项）

- `tsconfig.json`：`exclude: ["src/client"]`（**v4 修订**：jsx 不再放主 tsconfig）
- `tsconfig.client.json`（**新**）：`noEmit` + `jsx:"react-jsx"` + `jsxImportSource:"preact"` + DOM lib + `exclude: []`（清掉继承的 src/client exclude，否则类型门失效）
- `scripts/build-client.mjs`（**新**，~30 行）：
  - 入口 `src/client/index.ts`（含 4 panel + summary 组件）
  - `bundle: true`、`format: 'esm'`、`platform: 'browser'`、`jsx: 'automatic'` + `jsxImportSource: 'preact'`、`minify: true`、`target: 'es2020'`
  - 输出 `lib/client.js`（**无 `lib/client.css`** —— 样式 `theme.ts` 运行时注入）
  - **build 之前** `rm -rf lib/types/client`（防 tsc 旧产物残留）
- `package.json#dsh.client.entry` 改 `./lib/client.js`
- `scripts/verify-plugin-spec.ts`：exports 校验跳过 `./client`（bundle 走 `dsh.client.entry`，无对应 src/dsh-adapter/*.ts；同款纪律见 dsh-context）
- `pnpm-workspace.yaml`：补 `allowBuilds.esbuild: true`（解 pnpm 11 的 IGNORED_BUILDS 阻塞 deps-status）
- devDeps：`preact ^10`、`esbuild ^0.28`
- npm scripts：`build:client` + `typecheck:client` 接进 `build`（compile → typecheck:client → build:client → verify:build）

## 4. 风险（4 条 + 1 条 v4 增量）

| 风险 | 严重度 | 缓解 / 实测 |
|---|---|---|
| `sidebarRightTabs.register` 签名在 0.2.1-rc.2 / 0.2.1 stable 不同 | 高 | walkthrough 已 dump 真实签名；**本机桌面 0.2.1-rc.2 已装机验证**（§7.106，桌面截图为证） |
| tsc 与 esbuild 双产物共存（`lib/types/client` vs `lib/client.js`）| 中 | tsconfig exclude `src/client/`；build-client 前 `rm -rf lib/types/client`；本机实测：lib/client.js 单产物存在 |
| inject 拓扑影响 seam 事件时序（PROGRESS §7.94 多次踩坑）| **v4 修订**——`['auditLog']` 硬单依赖 + connection 软延迟，时序风险降至低 | inject 拓扑 audit 已做（裁决 D）：auditLog 必须先组成（cordis inject 纪律保证），connection 在 slack 延迟 |
| bundle 超 50KB | 低 | **实测 20 KB**（远低于阈值）|
| **v4 增量**：新增 `auditLog.onEntry` 服务接口，担心影响隐私管线 | 中 | listener 故障 try/catch fail-open（与 td-bus 同款纪律）；新增 1 个 audit-log 单测覆盖 fire/unsubscribe/throw 路径；无既有路径变更 |

## 5. 接受标准（11 项 = 9 ✅ + 2 ⏳，2026-10-29 §7.146 刷新）

阶段 3 出口，**11 项**全部满足才算 done。装机目视 3 项原为 ⏳，其中 **#9 已于
2026-10-22（§7.106，桌面截图为证）闭环**；余 2 项仍无实机取证，如实标 ⏳。

### 本环境能验（8 ✅）

| # | 项 | 验证 |
|---|---|---|
| 1 | tsc compile（`-p tsconfig.json`）0 错误 | ✅ |
| 2 | tsc client typecheck（`-p tsconfig.client.json`）0 错误 | ✅ |
| 3 | esbuild 出 `lib/client.js` | ✅ 20 KB |
| 4 | `npm run verify:build` 5 道门（boundary / contract / patch-surface / plugin-spec / bundle-mount）全绿 | ✅ |
| 5 | vitest 新增 18 个 + audit-log 13 个 = 31 全过 | ✅ |
| 6 | **4 个 panel 都不展示原始 PII**（host safePayload 5 类 tokenize + 嵌套对象扁平化；unit test 已覆盖）| ✅ |
| 7 | 桌面 installable bundle smoke（`bash scripts/build-desktop-bundle.sh --emit-dir --no-build`）| ✅ `lib/client.js` 落入 + 新 patch row 进入 `cordis.desktop-safe.patch.yml` |
| 8 | tab 类型在 deferred 注入下 mount 失败也保持插件健康（client 4 道 deferred ctudei + host softInject） | ✅ |

### 装机目视（3 项 → 现 1 ✅ / 2 ⏳）

| # | 项 | 状态 | 依据 |
|---|---|---|---|
| 9 | 装机后桌面右栏出现 "Edge" tab（位置与 dsh-context 的 "Context" tab 同高度）+ 切到 Edge tab bundle 加载 0 报错 | ✅ | **§7.106（2026-10-22）桌面截图为证**：右栏 Edge tab 打开、四面板渲染、意图面板收到活体行 `jev.boot_probe`（全链路：audit-log onEntry → edge-context-view fold → `/api/dsh-edge/context` pull → client 轮询 → 渲染）。§7.142 起 tab **常驻注册**，任何工作模式都有这个页签 |
| 10 | 切到后台再切回 → 数据保留（不重 mount 清空）| ⏳ | 设计满足（client `store.ts` 模块级单例；attach/detach 配对），**未实机取证**——如实标 ⏳，不拿设计满足冒充实测 |
| 11 | 桌面主题深/浅 + 语言 zh/en 跟随（无白底穿帮 + 文案跟随） | 部分 ✅ / ⏳ | **zh 通道已实机通**：§7.145-B 桌面 r16（`127.0.0.1:62248`）面板显示「尚未绑定会话 / 暂无全局信号」中文文案。**深/浅主题切换与 en 切换仍未实机取证**（设计满足：theme `currentColor` + `color-mix`；i18n `locale.register/bind` + zh/en 字典） |

## 6. 文件清单

**新增（15 个）：**

- `src/dsh-adapter/edge-context-view.ts` —— host 端 plugin（4 panel + session summary，inject `['auditLog']` 硬 + connection 软延迟）
- `src/client/types.ts` —— wire 类型镜像 + `CONTEXT_ROUTE = 'api/dsh-edge/context'`
- `src/client/store.ts` —— 模块级单例（attach/detach + 2s 轮询 + cursor 增量 + 失败软提示）
- `src/client/rows.tsx` —— 共享 RowList（time / shortKind / field 白名单 / level tint）
- `src/client/intentPanel.tsx` / `routePanel.tsx` / `interceptionPanel.tsx` / `threatPanel.tsx` —— 4 个 panel 组件
- `src/client/sessionSummary.tsx` —— session 摘要条（turns / tokens 输入输出 / lifetime）
- `src/client/theme.ts` —— `currentColor` + `color-mix` 主题跟随样式注入
- `src/client/i18n.ts` —— zh/en 字典 + `setTranslator()`
- `scripts/build-client.mjs` —— esbuild 出 `lib/client.js`
- `tsconfig.client.json` —— noEmit + jsx preact + DOM lib，client 类型门
- `tests/unit/edge-context-view.test.ts` —— 18 个 seam fold 单测
- `docs/notes/dsh-context-walkthrough.md` —— 阶段 1 walkthrough 落档

**修改（13 个）：**

- `src/client/index.ts` —— 71 行 skeleton → 168 行 mount 4 panel + summary（4 道 deferred inject：locale / sidebarRightTabs / slots / 主体；CordisCtx 局最小面声明绕开 verify:boundary）
- `src/dsh-adapter/audit-log.ts` —— 追加-only `onEntry(listener): () => void` seam + listener 故障 try/catch fail-open
- `cordis.desktop-safe.patch.yml` —— 增 `edge-context-view` insert row（**实际 inject 是 `['auditLog']`，不是 v3 计划的 8 个**）
- `package.json` —— exports `./edge-context-view` 新增 + `./client` 改 `./lib/client.js` + `dsh.client.entry` 改 `./lib/client.js` + scripts `build:client` / `typecheck:client` 接进 `build` + devDeps `preact ^10` / `esbuild ^0.28`
- `pnpm-lock.yaml` —— preact + esbuild 解锁
- `pnpm-workspace.yaml` —— `allowBuilds.esbuild: true`（解 pnpm 11 IGNORED_BUILDS 阻塞）
- `tsconfig.json` —— `exclude: ["src/client"]`（jsx 配置移到 tsconfig.client.json）
- `scripts/verify-plugin-spec.ts` —— exports 校验跳过 `./client`（bundle 走 `dsh.client.entry`，无对应 src/dsh-adapter/*.ts）
- `README.md` —— 插件计数 + 新行 + §7.101 交叉引用
- `docs/PROGRESS.md` —— 新增 §7.101 条目
- `docs/load-into-local-dsh.md` —— §8.4 desktop-safe Edge tab 装配说明
- `docs/plugin-mount-points.md` —— §7 audit-log / edge-context-view 子条目
- `docs/edge-context-tab-plan.md` —— 本文件（v3 → v4 修正 + 计数修正）
- （隐式）`src/client/`：之前只 71 行 skeleton index.ts，现扩到 11 个文件

**不引入：**

- tsdown / tailwindcss / lightningcss
- 新 cordis 事件类型 / 新 SessionEvent kind（`auditLog.onEntry` 是 service 接口增量，**不是**新事件类型）
- 自研 AsyncIterable seam
- detail channel 语义
- WebSocket / SSE
- 新 schema

## 7. 时间预估（实际）

| 阶段 | 估时 | 实际（参考） |
|---|---|---|
| 1 walkthrough | 3-4h | ~3h（v0.73.3 源码浅 clone + 5 个文件精读 + 裁决 5 条）|
| 2 实现（host 1 plugin + audit seam + 4 panel + 1 summary + 4 支撑 + patch）| 8-12h | ~9h（含 audit seam 修 + boundary / plugin-spec 门微调）|
| 3 build + 装机验证 | 2-4h | ~2h（除装机目视 3 项）|
| **合计** | **13-20h** | **~14h**（与下限一致） |

## 8. 不承诺的口径

本计划**不**承诺以下用户视角能力：

- "Edge tab 可被用户用来调 §7.x 的可观测性 bug"
- "L2 云池切换前后的对比可视化"
- "PII 摘要展示给用户" —— **强制规则**：4 个 panel **不**展示原始 PII（即使已脱敏过的占位符 `<<PII_PHONE_1>>` 也不直接展示）
- "session summary 一定有 token 数字" —— **v4 修订**：adapter 不报账时显示"—"，不假造 0

## 9. 后续可考虑（不在本计划）

- dsh-context 工具链全套对齐（tsdown + tailwindcss）—— 如果阶段 2 后组件复杂度上升
- main panel `Watch Insight` 页（仿 dsh-context）—— 与本 plan 平行启动
- §7.x 调试可视化（prompt-guard `fallback-token-only` 等 400 路径）—— 由 §7.99 计划承接
- 把现有 `dsh-edge-flow.html`（82KB 静态）deprecate —— 在 Edge tab 装机稳定后单独处理
- panel 内增加"详情 modal"（点击 row 弹窗显示与该事件相关的更多上下文，仍走 PII 过滤）—— 现版本不做
- **v4 增量**：把 session/event 监听也升到 host 端 `connection.fetch` 之外的二级 channel（如 `useProjection('edgeSummary')`），把 session summary 改 push 模式 —— 需 dsh 框架侧确认 `sessionProjections` 是否支持自定义非-session 源，**未做**
- **v4 增量**：panel 数据按 `panel` 切分单独 endpoint（4 个 route 替代 1 个），client 按需订阅 —— 当前 1 个 endpoint 已经够用（polling + cursor 增量）

## 10. 修订历史

- **v1**（未提交），~345 行：自研方案，4 panel + 8 inject + schema reconcile + 自研 seam 折叠
- **v2**（commit `ba689d1`，2026-10-19），~162 行：仿 dsh-context、仅 3 panel、最窄范围
- **v3**（2026-10-19），~210 行：仿 dsh-context 架构 + 本仓 4 panel + session summary，inject 8 服务；硬规则：**不展示原始 PII**
- **v4**（2026-10-20，已落档 + 实现完成 + 本次文档修正）：
  - **裁决 A**：seam 数据源是 audit-log 记录（非可订阅事件流）——`audit-log.ts` 新增 `onEntry(listener)` 活体监听 seam（追加-only、逐 listener try/catch fail-open、ring push 后触发、含未 flush 条目；unit test 已加）。
  - **裁决 B**：传输改为 dsh-context 的 **POST route pull**（框架 `connection.fetch.register`，path `/api/dsh-edge/context`，client `api/dsh-edge/context` 轮询 + cursor）。`snapshot()` 返回纯数据，**不是** AsyncIterable（浏览器订不到 cordis）。
  - **裁决 C**：session summary token 源 = `assistant/message.usage`（adapter 报账才显示，未报则"—"）。
  - **裁决 D**：原 8 inject 缩为 `['auditLog']` 硬 + `['connection']`/`['slots','locale']` 软延迟；其余 6 个服务无可读 API。
  - **裁决 E**：`sessionProjections` 物理上装不下边缘隐私事件（SessionEvent 词表封闭，无自定义 kind），故不强求用纯 switch。
  - **build**：tsc 排除 `src/client`（emit），独立 `tsconfig.client.json`（noEmit + jsx preact + DOM lib + `exclude: []`）做类型门；`scripts/build-client.mjs` esbuild 出 `lib/client.js`（20 KB，远低于 50 KB 风险项）。
  - **新增文件（13）**：`src/dsh-adapter/edge-context-view.ts`、`src/client/{index,types,store,rows,i18n,theme,intentPanel,routePanel,interceptionPanel,threatPanel,sessionSummary}`（11 个）、`scripts/build-client.mjs`、`tsconfig.client.json`、`tests/unit/edge-context-view.test.ts`、`docs/notes/dsh-context-walkthrough.md`。
  - **修改文件（9）**：`audit-log.ts`、`cordis.desktop-safe.patch.yml`（`edge-context-view` insert row，`inject: [auditLog]`）、`package.json`（exports `./edge-context-view` 新增、`./client` → `./lib/client.js`、`dsh.client.entry` 改 `./lib/client.js`、devDeps preact + esbuild、`build:client`/`typecheck:client` 接进 `build`）、`pnpm-lock.yaml`、`pnpm-workspace.yaml`（`allowBuilds.esbuild: true`）、`tsconfig.json`（exclude）、`scripts/verify-plugin-spec.ts`（`./client` 跳过源文件存在性检查——bundle 走 `dsh.client.entry`）、`docs/edge-context-tab-plan.md`（本文件 v3→v4 修正）。
  - **11 项验收**（计划 §5）：本环境能验的 8 项全部通过（tsc compile、tsc-client typecheck、esbuild bundle 20 KB、verify:build 5 道门、31 个新单测全过、桌面 installable bundle smoke 含 `lib/client.js` 与新 patch row、PII 5 类在 host 折叠时已 tokenize + 嵌套对象扁平化、tab 类型在 deferred 注入下 mount 失败也保持插件健康）。装机目视验证（11 项中剩 3 组：①右栏 Edge tab 出现 + bundle 加载 0 报错；②切后台再切回数据保留；③主题深/浅跟随 + 语言 zh/en 文案跟随）需在桌面 0.2.1-rc.2 实跑。
  - **本次文档修正**：v3 原始 §3 阶段 2/3 与实现差异较大（inject 表从 8 缩到 1、传输从 AsyncIterable 改 POST route、build 从"jsx 放主 tsconfig"改为"独立 tsconfig.client.json"、文件清单从 5 新增 4 修改改为 15 新增 13 修改——feat commit 11 新增 / 9 修改 + 文档同步 commit 4 修改），原 §1 状态表/§4 风险/§5 验收/§6 文件清单同步按 v4 实际对齐。
- **v5**（2026-10-29，§7.146 文档审计刷新，**只改状态不改方案**）：
  - **§1 状态表**：第 5 行「桌面右栏看到 Edge tab」由 ⏳ → ✅（§7.106 桌面截图为证）；第 10 行由「8/11 ✅，3/11 ⏳」→ **9 ✅ / 2 ⏳**；新增第 11 行记 §7.145-C 构建链门禁。
  - **§4 风险表**：`sidebarRightTabs.register` 签名行由「装机待验」→ 已装机验证。
  - **§5 验收表**：#9 补实机取证依据；#10 如实标 ⏳（无实机取证，不拿设计满足冒充）；#11 标「zh 通道已实机通 / 深浅主题与 en 切换未验」——**不把 3 项 ⏳ 一次性抹平成全绿**。
  - **头部**：加 v5 状态段，声明本文是**已落地计划书**而非待办，并串起 §7.106 / §7.142 / §7.145-B / §7.145-C 四条后续主线。