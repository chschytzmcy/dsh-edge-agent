# dsh-edge-agent 桌面右栏 "Edge" tab —— 实施计划

> **范围声明（2026-10-19 校准）**：本计划**仅**做"仿造 dsh-context v0.73.3 的 host+client 双半体结构，在 DSH 桌面右栏增加一个 Edge tab"。
> **不**自研可视化技术栈、**不**重新设计隐私可观测面板的字段。
> host 端 seam 形状、client 组件结构、build 管线形态**均对齐 dsh-context 已有实现**；本计划只做"字段映射 + 装机验证"。

## 0. 与 §7.x 主线的关系

- 本计划从属于"为 dsh-edge-agent 在桌面内提供原位可视化"，**不**承担 §7.99 prompt-guard 修复的可观测性职责。
- §7.98.1（30% 复测）后续修复由独立 §7.99 计划推进。
- 本计划引入 1 个 host 端新 plugin（`edge-context-view`）、少量 client 端组件、1 段 esbuild 出 bundle 的步骤。

## 1. 现状（截至 2026-10-19）

| # | 项 | 状态 |
|---|---|---|
| 1 | `package.json#dsh.client.{inject,platform,entry}` 已加 | ✅ |
| 2 | `package.json#exports["./client"]` 指向 `lib/types/client/index.js` | ✅ |
| 3 | `src/client/index.ts` —— 注册占位 sidebar tab（71 行 skeleton）| ✅ |
| 4 | tsc 产物 `lib/types/client/{index.js,index.d.ts}` | ✅ |
| 5 | 桌面右栏看到 "Edge" tab | ⏳ 等装机 |
| 6 | dsh-context v0.73.3 源码 walkthrough（host seam + client 注册 + 面板结构）| ❌ |
| 7 | host 端新 plugin `edge-context-view`（窄版，仅 inject 3 服务）| ❌ |
| 8 | client 组件（3 panel：intent 摘要 / route 摘要 / 拦截计数）| ❌ |
| 9 | esbuild 出 `lib/client.js` bundle（tsc 排除 src/client）| ❌ |
| 10 | 桌面 0.2.1-rc.2 装机实测 —— 7 项验收均过 | ❌ |

## 2. 不做的（明确剔除）

避免前版 345 行方案里的"自研"陷阱，下列事项**一律不**进本计划：

- 自研 schema / 自研事件折叠工具 —— **直接抄 dsh-context timeline 实现**
- detail channel（按需重型数据拉取）
- 跨 session 聚合
- §7.x 调试可视化（如 prompt-guard `fallback-token-only` 400 路径的专门字段）
- 独立隐私审查章节（沿用 dsh-context 的威胁模型）
- 回滚策略（tab 加载失败时回退到当前 skeleton；install.sh 已有逻辑支持）

## 3. 实施阶段（3 阶段）

### 阶段 1：dsh-context v0.73.3 walkthrough（3-4h）

读 4 个文件并 dump 形状到 `docs/notes/dsh-context-walkthrough.md`：

| 源 | 取什么 |
|---|---|
| `src/host/timeline.ts` | seam 折叠形态、event shape、AsyncIterable 暴露方式 |
| `src/client/connection.ts` | client 订阅模式（event emitter / for-await / 这两种？）|
| `src/client/{tokens,timeline,...}.tsx`（3 个组件）| 面板结构 + slot API |
| `package.json#dsh.client.{inject,entry,platform}` | dsh-context 自己怎么配这几个字段 |

### 阶段 2：本仓实现（6-10h）

**host** —— 新增 `src/dsh-adapter/edge-context-view.ts`：

- inject **限到 3 个**：`[intentRouter, modelRouter, auditLog]`
- **不**订阅 `inputGuard / promptGuard / sanitizer / tdBus / cloudLlm / localLlm`
- 在 `auditLog` 上订阅所有 `dsh.edge.*` 事件，按 `sessionId` 折叠为**3 类计数 + 时间戳**（不暴露原始 payload / 不展示 PII）
- 暴露 `ctx.edgeContextView.summaryStream(sessionId?)` —— AsyncIterable
- schema **直接复用 dsh-context timeline 的字段** + 字段映射：
  - `contextLen` → `intentConfidence`
  - `tokenTotal` → 拦截事件计数
  - 其余字段按 walkthrough 决定

**client** —— 复制 dsh-context 3 个 `.tsx` 文件，改字段映射：

- **Preact + esbuild**（与 dsh-context 同栈；**不**引入 tsdown / tailwindcss）
- inject 的 3 个 service 名改为本仓的：`dsh-client-connection`, `dsh-client-locale`, `dsh-client-ui-sidebar-right`（已在 package.json 里）

**patch** —— `cordis.desktop-safe.patch.yml` 加 1 行 `insert: edge-context-view`：

```yaml
- insert:
    - id: edge-context-view
      name: '@deepseek-harness-edge-agent/dsh-edge-agent/edge-context-view'
      inject: [intentRouter, modelRouter, auditLog]
      config:
        bufferSize: 64
        sessionTtlMs: 1800000
```

### 阶段 3：build 管线 + 装机验证（2-4h）

- `tsconfig.json`：
  - 加 `"exclude": ["src/client"]` —— 避免 tsc 重出 `lib/types/client/`
  - 加 `"jsx": "react-jsx"`, `"jsxImportSource": "preact"`
- `scripts/build-client.mjs`（esbuild，~30 行）：
  - 入口 `src/client/index.ts`（含 `.tsx`）
  - bundleFormat: `'esm'`, platform: `'browser'`
  - 输出 `lib/client.js` + `lib/client.css`
  - **build 之前** `rm -rf lib/types/client`（清掉 tsc 旧产物）
- `package.json#dsh.client.entry` 改 `./lib/client.js`
- `npm run verify:build` 全绿 + 桌面装机 7 项验收

## 4. 风险（精简到 3 条）

| 风险 | 严重度 | 缓解 |
|---|---|---|
| `sidebarRightTabs.register` 签名在 0.2.1-rc.2 / 0.2.1 stable 不同 | 高 | 阶段 1 walkthrough 已 dump 真实签名；阶段 3 装机 smoke test 是最终检查 |
| tsc 与 esbuild 双产物共存（lib/types/client vs lib/client.js）| 中 | tsconfig exclude `src/client/`；build-client 前 `rm -rf lib/types/client`；加 verify 脚本巡检 |
| bundle 超 50KB（dsh-context 形态可能较大）| 低 | 单 build 监控；超则把 3 panel 中 1 panel 降级为 `(todo: ${count})` 占位 |

## 5. 接受标准（与 dsh-context 同款）

阶段 3 出口，**7 项**全部满足才算 done：

| □ | 项 |
|---|---|
| □ | 装机后桌面右栏出现 "Edge" tab，位置与 dsh-context 的 "Context" tab 同高度 |
| □ | 切到 Edge tab，bundle 加载控制台 0 报错（没有 unsupported face / undefined shape 告警）|
| □ | 发一条本地可处理的 query → intent panel 出现一行 + route panel 出现一行 |
| □ | 发一条触发 sanitizer 的 query → 拦截计数 panel 出现红点 + 计数 +1 |
| □ | 切到后台再切回 → 数据保留（不重 mount 清空）|
| □ | 切换桌面主题深/浅 → 配色跟随，无白底穿帮 |
| □ | 切换桌面语言 zh/en → 文案跟随 |

## 6. 文件清单

**新增：**

- `src/dsh-adapter/edge-context-view.ts` —— host 端 plugin（窄版，inject 3 服务）
- `scripts/build-client.mjs` —— esbuild 出 lib/client.js
- `docs/notes/dsh-context-walkthrough.md` —— 阶段 1 walkthrough 落档
- `tests/unit/edge-context-view.test.ts` —— 1 个 fold 单测

**修改：**

- `src/client/index.ts` —— 改为 mount 真实组件（替换当前 placeholder render）
- `cordis.desktop-safe.patch.yml` —— 加 `edge-context-view` insert row
- `tsconfig.json` —— exclude `src/client/`；加 jsx 配置
- `package.json` —— `dsh.client.entry` 改 `./lib/client.js`；加 preact devDep；加 `build:client` script

**不引入：**

- tsdown / tailwindcss / lightningcss（dsh-context 工具链全套不在本计划）
- 新 schema / 新事件类型
- detail channel
- WebSocket / SSE（沿用 dsh-context 已用的方式）

## 7. 时间预估（10-18h）

| 阶段 | 估时 |
|---|---|
| 1 walkthrough | 3-4h |
| 2 实现（host + client + patch）| 6-10h |
| 3 build + 装机验证 | 2-4h |
| **合计** | **10-18h** |

## 8. 不承诺的口径

本计划**不**承诺以下用户视角能力（这些由其他计划承担）：

- "Edge tab 可被用户用来调 §7.x 的可观测性 bug"
- "L2 云池切换前后的对比可视化"
- "PII 摘要展示给用户" —— 只展示计数 + 类别，**不**展示原始 payload

## 9. 后续可考虑（不在本计划）

- dsh-context 工具链全套对齐（tsdown + tailwindcss）—— 如果阶段 2 后组件复杂度上升
- main panel `Watch Insight` 页（仿 dsh-context）—— 与本 plan 平行启动
- §7.x 调试可视化（prompt-guard `fallback-token-only` 等 400 路径）—— 由 §7.99 计划承接
- 把现有 `dsh-edge-flow.html`（82KB 静态）deprecate —— 在 Edge tab 装机稳定后单独处理
