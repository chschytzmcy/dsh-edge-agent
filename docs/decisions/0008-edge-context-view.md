# ADR 0008 · Edge tab 桌面右栏可视化 —— 5 条核心架构裁决

> **状态**：✅ Accepted · **日期**：2026-10-20 · **后续影响**：§7.101 feat(`ab999ce`) + docs(`9622965`) · **回溯**：本 ADR 把 `docs/edge-context-tab-plan.md` v3→v4 中 §3 / §10 的 5 条裁决抽出独立落档，让计划文档回归"做什么"、本文档独立"为什么"。

---

## 上下文（Context）

DSH 桌面侧栏的 Edge tab 计划（`docs/edge-context-tab-plan.md`）最初按 **v3（2026-10-19）** 一版自研思路推：8 个 plugin 注入、用 `AsyncIterable<{...}>` 形态暴露 seam。落地前做了 dsh-context v0.73.3 源码 walkthrough（阶段 1），发现 v3 至少有 3 条关键假设**与 dsh-context 实际结构不符**：

1. dsh-context 不暴露任何 AsyncIterable seam——它有 `sessionProjections`（push，仅 SessionEvent 类型）和 `connection.fetch.register` POST route（pull，on-demand）两个标准件，Edge 隐私事件**不在 SessionEvent 词表内**。
2. `src/dsh-adapter/edge-context-view.ts` v3 想直接 `ctx.on('intent.classify.end', ...)` 等 8 个 service——这违反 §6 不做"新 cordis 事件类型"原则，也破坏 `verify:boundary` 静态门禁。
3. Session 摘要若想拿 token 字段并入，需要新 `SessionEvent` 类型，**会破 v0.73.3 的 SessionEventMap 词表封闭性**。

任何一条留在代码里都意味着：
- 重复造轮子（浪费后期 v5+ 维护者的认知）
- 不可升级（DSH 上游若后续改 AsyncIterable seam 或加 SessionEvent kind，平滑升级的路被堵）
- 边界层污染（违反 `verify:boundary` 静态规则）

故在阶段 2 实现开工前，先把这 5 条裁决落档 ADR。

---

## 裁决一览

| ID | 主题 | 决策 | 替代方案 | 拒绝理由 |
|---|---|---|---|---|
| **A** | 数据源 | 在 `audit-log.ts` 加 `onEntry(listener)`：ring buffer push 后 fire；listener try/catch fail-open；含未 flush 条目回放 | 发新 `cordis.event` 类型 / 发新 `audit.kind` | 已封闭的 audit 词表；在 §6 "新 audit kind 不做"已列；改造既有 service 接口是侵入性最小 |
| **B** | 传输通道 | `connection.fetch.register({path, method:'POST', body:'buffered'})` → 浏览器相对路径 `api/dsh-edge/context` 走反向代理前缀 | 自研 AsyncIterable seam 暴露给 webview | dsh-context v0.73.3 不存在 AsyncIterable seam；自研会破坏后续版本对接上游升级路径 |
| **C** | Session summary 数据源 | 进程内 `ctx.on('session/event')`（同 `http-api.ts:567` 习语） + token 累计走 audit 已落账的 `assistant/message.usage` | 新 SessionEvent kind（`edge-context.turn.start` 等） | SessionEventMap v0.73.3 是封闭词表；增 kind 会破坏 §6 "新 SessionEvent kind 不做" |
| **D** | host inject 清单 | `['auditLog']` 1 硬依赖 + `['connection','slots','locale']` 3 软延迟（`ctx.inject` deferred）| v3 计划的 8 inject | cordis 加载顺序曾踩坑（PROGRESS §7.94）；集中监听点越少，启动期 race 越小 |
| **E** | SessionEventMap 词表 | **封闭**，不在 plugin 内 emit 新 SessionEvent 类型 | 同 C（接受新 kind） | 词表封闭是 v0.73.3 的稳定契约；新 kind 一旦进 Map 上游升 RC 时会变 breakage |

---

## 详细论证

### A · 数据源 = `auditLog.onEntry(listener)`

**why**：本仓隐私 flow 的 4 个 panel 全部都能从 audit-log 现有事件折叠出来（`intent.*` / `route.*` / `guard.*` / `sanitize.*` / `td-bus.escalated` 等全部已在 audit 词表内）。audit-log 的 ring buffer 已经有 size + flash 规则，加一个 listener 钩子是单点增量。

**how**：
```ts
// audit-log.ts 增量接口
interface AuditLog {
  onEntry(listener: (entry: AuditEntry) => void): () => void  // unsubscribe
}
```

fire 时机：`push()` 入 ring buffer 后立即 fire；若注册时 buffer 已有未 flush 条目，按订阅顺序补发一份（**回放语义**）。每个 listener 独立 `try/catch` fail-open，单个 listener 抛错不影响其他也不影响 ring buffer 本身。

**拒绝替代（emit 新 cordis 事件 / 新 audit.kind）**：
- audit 词表已经过大；新 kind 会让 docs/PROGRESS §四 现状表继续膨胀、打破"封闭"约束
- 8 个 plugin 都各自发事件意味着 inject 链全展开（D 的麻烦），且 listener 各自实现重复（PII 过滤、聚合）

### B · 传输 = POST route pull（不是 AsyncIterable）

**why**：v3 walkthrough 验证阶段的关键发现是 **dsh-context v0.73.3 没有任何暴露给 webview client 的 AsyncIterable seam**。它的 `sessionProjections` 是 push 给 host 进程的、不是给 webview 的。给 webview 的统一形态是 `connection.fetch.register(... 'POST' ...)` POST route + 客户端 `api/<plugin>/<route>` 相对路径。

**how**：
```ts
// host
ctx.inject(['connection'], c =>
  c.connection.fetch.register({
    path: '/context',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async ({sessionId, cursor}) => { /* fold 从 auditLog */ },
  })
)
```

```ts
// client
const { rows } = await fetch('api/dsh-edge/context', {
  method: 'POST',
  body: JSON.stringify({ sessionId, cursor }),
}).then(r => r.json())
```

`sessionId` 缺省时回退当前 active session；`cursor` 是 host-side offset/seq，避免重复发。

**轮询策略**：client `store.ts` 2s 一次 POST（mk Polling），host 端用 cursor 比对实现差分。规模在小面板（每 panel 最多 ~64 rows / session）下带宽 < 1 KB/s。

**拒绝替代（自建 AsyncIterable seam）**：
- DSH 上游没暴露这个 face 给 webview；要自研需 hack `globalThis` 或 window.postMessage——破坏 v5 升级路径
- AsyncIterable 在 webview 跨 context 风险（geolocation / extension 比 workspace 更复杂）

### C · Session summary = `ctx.on('session/event')`（不增 SessionEvent kind）

**why**：DSH 主进程的 `http-api.ts:567` 已经用 `ctx.on('session/event', ...)` 做现有事件监听（turn count、token 累计）。Edge-context-view 的 session summary 直接**复用同一 listener 句型**，不再多开新通道。

**how**：
```ts
ctx.inject(['sessions'], c => {
  c.ctx.on('session/event', (e) => {
    if (e.type === 'turn.start') summary.turns++
    if (e.type === 'assistant/message.usage') summary.tokensIn += e.usage.tokens
  })
})
```

token 字段来自 `assistant/message.usage`——这是**已存在**的 event payload 字段，不是新增 kind；Host 折叠时**信任**上层 emit 完整性（路由层在 §6 "新 SessionEvent kind 不做" 里已声明）。

**拒绝替代（增 SessionEvent kind）**：
- SessionEventMap v0.73.3 是封闭词表（裁决 E）
- 新 kind 会在 `verify:plugin-spec` 里蹦出"未知事件类型"警告

### D · inject 清单 = `['auditLog']` 硬 + 软延迟

**why**：v3 计划的 8 inject 让 `edge-context-view` 同时是 intentRouter / modelRouter / inputGuard / promptGuard / sanitizer / tdBus / sessions / auditLog 的依赖者——cordis 加载顺序敏感（PROGRESS §7.94 多次踩坑）。把所有"折叠输入侧"压到一处（audit-log），其它（connection、slots、locale）作为软依赖延迟注入，唯一硬依赖点稳定为 1。

**how**：
```ts
export const inject = ['auditLog']  // 硬

export function apply(ctx) {
  ctx.inject(['connection', 'slots', 'locale'], (raw) => {
    // 上 injectable face 才装载；缺则 degrade
  })
}
```

**拒绝替代（8 inject 同级）**：
- 加载顺序：race 风险
- `verify:boundary` 静态门禁可能要重启
- 启动期噪音（多个 service 同时装载，连环阻塞）

### E · SessionEventMap 词表封闭

**why**：
1. v0.73.3 上游在该语义上稳定（"SessionEventMap 是 session 框架的核心契约，是扩展点"——已读过 `src/host/index.ts` 验证）。
2. Edge tab 若想加 `edge-context.turn.start` 之类的新型，**会破坏**：a) `plugin-spec` 静态扫描（未声明的 event type 会被警告）；b) 上游 DSH 升 0.3.x 时潜在断裂。
3. 本仓 §6 不做项已先说过"新 SessionEvent kind"——ADR 把这条做成 stable 约束。

**how**：所有需要 turn / token 累计的折叠一律走 C 的 `ctx.on('session/event')`；不在 client host 半中 emit 新 kind。

**拒绝替代**：
- 增 SessionEvent kind：会破词表封闭性 + 升 RC 时难维护。
- 在 Edge-tab 自己插件里维护一个独立 counter：可行但是重复造轮子——合并到 audit-log 持久化都没必要，summary 是 session-scoped 内存态。

---

## 后果（Consequences）

**正面**

- **上游升级路径平滑**：本 ADR 的 5 条都依赖 dsh-context 已稳定的 2 条标准件（POST route + session/event），DSH 升 0.3.x 时只有 audit-log 的 `onEntry` 是本仓契约点。
- **注入链稳定**：8 inject → 1 inject + 3 软大幅缩小 race 风险。
- **词表稳定**：SessionEventMap 与 DSH 上游保持封闭。
- **隐私严格**：`piiRedact: !!js env... !== 'false'` 同时落到 patch + doc——运维 opt-out 路径明确。

**负面 / 风险**

- **ABI surface 增量 1**：`AuditLog.onEntry(listener)` 是新增 service 接口（不是新事件）。如果上游未来不希望这个接口挂在 audit-log 上，要重构——但当前 `plugin-spec` 允许 schema 增量，不破。
- **轮询 2s 不是实时**：面板更新最多落后 2s；如果 §7 后续要在 Edge tab 上做"截图取证"，2s 延迟不够，会被推回去改 push 模型（届时再开 ADR 0009）。
- **`.css` 不落档**：样式走 `theme.ts` 运行时注入，未来想抽出独立样式得重新拆。

---

## 替代路径（如果 §7.101 上游不同步退化）

- 如果 DSH 0.3.x 把 `onEntry` 这类 API 收回归 *Persistence* 范畴，audit-log 不能再 inject，独立成 `audit-stream.ts` 独占 1 plugin，把本 ADR 边界外移——届时开 ADR 0009，关闭本页。
- 如果客户明确要求实时（< 100ms 刷新），需另起 ADR 评估 `connection.send.register`（服务端推）vs 现有 2s 轮询。

---

## 修订历史

| 版本 | 日期 | 改动 |
|---|---|---|
| 1.0 | 2026-10-20 | 初版落档 —— 抽自 `docs/edge-context-tab-plan.md` v3→v4 §3 / §10 |
