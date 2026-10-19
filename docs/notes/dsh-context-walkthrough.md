# dsh-context v0.73.3 walkthrough —— Edge tab 阶段 1 落档

> 来源:GitHub tag `v0.73.3`(bowenliang123/dsh-context,浅 clone 只读;本机桌面装的 0.73.0 仅有编译产物 `lib/`,无 `src/`,故取源码 tag——计划里"v0.73.3"的版本目标以此满足)。
> 计划文档 `docs/edge-context-tab-plan.md` §3 阶段 1 的四项读取目标全部覆盖;计划引用的 `src/client/connection.ts` 不存在,实际对应文件为 `src/host/connection.ts` + `src/client/services.ts` + `src/client/timelineSource.ts`,已按真实路径读。

## 1. 核心裁决:host→client 数据通路**不是** AsyncIterable 订阅

v0.73.3 的 dsh-context **没有任何自研 AsyncIterable seam**。它用两条**框架标准**通道:

| 通道 | 方向 | 机制 | 载体 |
|---|---|---|---|
| **sessionProjections** | push | host `ctx.sessionProjections.register(unit)`;框架按已提交 `session/event` 驱动折叠,经 `sessionProjectionCache` 持久化,以 `session/projection` 帧推给浏览器 | client `props.useProjection(key)`(slot 组件 props 自带) |
| **connection.fetch route** | pull | host `ctx.inject(['connection','sessions'], …)` 后 `connection.fetch.register({path:'/api/dsh-context/detail', methods:['POST'], requestBody:'buffered', fetch})`(`src/host/connection.ts:33`) | client 相对路径 `fetch('api/dsh-context/detail', {method:'POST', body})`(`src/client/timelineSource.ts:45`;相对拼写是反向代理前缀纪律,`apiRoutes.ts` 头注) |

**关键约束**:`sessionProjections` 的 `apply(state, event: SessionEvent)` 必须是纯函数,且 event 只能是框架 event log 里的 SessionEvent。

## 2. SessionEvent 词表是**封闭**的(代码核验 `@deepseek-ai/dsh-session/lib/types/types.d.ts:256-436`)

`turn/start|end`、`step/start|end`、`user/message`、`developer/message`、`system/message`、`assistant/message`(**携带 `usage`**——adapter 报账时 token 数在这)、`assistant/attempt`、`tool/call`、`tool/result`、`request/header`、`request/context`、`session/end-seed`。

→ **没有自定义/插件 event kind**。本仓的 intent/guard/sanitize/td 事件不进入 durable log,**projection 通道物理上装不下它们**。

## 3. Projection unit 形状(`src/host/timeline.ts:298-315` + `compat.ts`)

```ts
{ key, stateSchema(zod), init(), apply(state, SessionEvent)→state,  // 被忽略的事件必须返回同一引用
  wire: { viewSchema(zod), view(state) }, stateVersion }             // bump 即缓存行失效重折
```

wire 值全部 `z.strictObject` 出 host 前校验;`slim` 按 detail 通道活性逐 serve 选代际(有通道发轻 head,重集合按 POST 拉取)。

## 4. client 挂载形态(`src/client/sidebar.ts` + `src/client/index.ts`)

- tab 类型注册:`ctx.inject(['sidebarRightTabs'], cb)` → `tabs.register({id, kind, title:()=>t(…), guide:[…]})` ——**与本仓 skeleton 一致**,face 类型本地声明(上游包在 app.asar,不在 npm)。
- tab 本体是第二个 slot:`ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({name:'sidebar.right.pane.tab', key:<tab kind>}, (props) => view({...props, host:'sidebar'})))`。
- 组件 props = `SessionStandardProps { sessionId?, useProjection?(key), useChat? }`(`services.ts:177-186`);每个 face 调用点 re-prove,fail-open。
- i18n:`ctx.locale.register(ns, {zh, en})` + `bind(ns)` → `t()`;文案随宿主语言。
- dsh-context 的 `package.json#dsh.client` 只有 `{inject:[6 个上游包], platform:'web'}`——**没有 entry 字段**;client 入口走 `exports['./client'] → './lib/client.js'` 约定。本仓 skeleton 的 `dsh.client.entry` 字段是否被消费未证实,装机时观察(保留字段、同时把 `./client` 导出指向 bundle,两种解析方式都吃到)。

## 5. inject 拓扑审计(计划风险 3 的缓解项)

- host plugin 顶层硬依赖只写了**一个**:`inject = ['sessionProjections']`(Cordis 未组成前保持 PENDING)。
- 其余(face 可能缺失的)全部走**嵌套 deferred `ctx.inject`**,arms 时机不假设加载顺序。
- 版本低于 baseline 时注册 fallback unit(零数据 + 门禁记录),不崩。

## 6. 对本仓 Edge tab 的设计裁决(与 v3 计划的偏离及理由)

v3 计划的"5 个 AsyncIterable seam + 订阅各 plugin 事件"建立在错误前提上(计划把"审计 kind"当成了"可订阅事件流")。代码事实:

1. **本仓事件源是 audit-log 记录,不是事件流**:`intent.classify.start/.end` 等 60+ kind 全部经 `auditLog.log({level, kind, source, payload})` 落 ring buffer + JSONL;`intentRouter`/`tdBus` 等服务**不暴露任何 listener API**(本仓逐一核验)。`auditLog.query()` 只读磁盘(全量 `readAllFromDisk`),轮询代价不可接受。
2. **裁决 A——fold 数据源**:给 `audit-log` 增加 `onEntry(listener)` 活体监听(append-only、逐 listener try/catch fail-open、ring push 后触发、含未 flush 条目)。不新增事件 kind、不改管线语义;这是 seam 能成立的唯一低摩擦前提。
3. **裁决 B——传输**:采用 dsh-context 的 **POST route pull** 通道(框架 `connection.fetch.register`,path `/api/dsh-edge/context`,client `api/dsh-edge/context` 轮询 + cursor 增量)。v3 计划"不建 detail channel"条目**修订**:detail channel 模式(dsh-context 的标准件)是浏览器可达的唯一现实通路;不做的只是"按需重型数据拉取"的语义,传输层复用。headless profile 无 `connection` face → deferred inject,插件照常挂载、无 route(= tab 在 CLI/TUI 不显示,计划原意保持)。
4. **裁决 C——session summary 的 token 源**:`turn/start` 计数轮次 + `assistant/message.usage`(存在才显示,缺则"—"),经进程内 `ctx.on('session/event', …)`(本仓既有 idiom,`http-api.ts:567`)折叠;edge 独立路径叠加 `sessions` 服务的 createdAt/lastSeenAt。不承诺 token 数字(adapter 不报账时如实缺省)。
5. **裁决 D——host seam 形态**:`ctx.edgeContextView.snapshot(sessionId, cursor)` 返回纯数据(4 panel rows + summary),**不是** AsyncIterable(浏览器订不到 cordis,自研流没有消费者)。单测直接打 fold 纯函数,比打流更强。
6. **裁决 E——inject 表**:v3 计划的 8 个 inject 缩减为 `['auditLog']` 硬 + `['connection','sessions']` 软。其余 6 个服务对象无数据可读(核验),注入它们只增加加载顺序耦合(计划风险 3 自己指出的坑)。面板归属按 source 字段过滤,不靠注入。

### 面板 ← 真实 audit kind 映射(全部代码核验)

| Panel | kinds(payload 关键字段) |
|---|---|
| Intent | `intent.classify.start`(textLen/classifier/model)、`intent.classify.end`(category/confidence/rationale)、`intent.llm.low-confidence`、`intent.classify.llm_error/provider_error`、`input-guard.intent.downgraded` |
| Route | `http.chat.route`(intent/provider/model/resolved)、`llm.cloud.start`(provider/model/baseUrl/promptLen)、`llm.local.start`、`llm.cloud.delegate.resolved`(from/toProvider/toModel)、`llm.cloud.delegate.unavailable`、`llm.cloud.end/http_error/network_error`、`llm.local.end/http_error/network_error` |
| Interception | `input-guard.sanitized`、`input-guard.sanitize.downgraded/.failed`、`input-guard.blocked.attack/intent/policy`、`guard.model-detect.unsafe/skip/error/provider_error`、`guard.rule.sanitized`、`sanitizer.sanitized`(计数)、`sanitizer.desanitized/purged`、`input.injection`、`input.secret-data` |
| Threat | `td-bus.escalated`(from/to/count/threshold)、`input.global-rate-limit`、`input.rate-limit`、`http.chat.threat-blocked` |
| Session summary | `session/event` `turn/start`(轮次)、`assistant/message.usage`(token,可缺)、sessions 记录起止 |

计划里 "td.alert" 不存在,实为 `td-bus.escalated`(severity≈to 档位)。PII 防线维持:`pii-utils` 5 类在出 host 前对 payload 字符串值再扫一遍(tokenize),面板只见计数/类别/时间戳。

## 7. 遗留不确定(阶段 3 装机裁决)

- `dsh.client.entry` 与 `exports['./client']` 谁被桌面消费(双保险已设)。
- 桌面 webview 对 `api/dsh-edge/context` 相对 fetch 的同源/鉴权行为(dsh-context 同款写法,理论同源)。
- `slots`/`locale` 服务在 3 包 inject 下是否可用(dsh-context 用了 6 包;缺则 deferred 分支静默,tab 类型注册仍成立)。
