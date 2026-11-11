# dsh-edge-agent 插件挂点表(代码版)

> 每个插件在 dsh 流程上的真实挂点 + 真实代理引用。
>
> **状态：2026-11-10 全量刷新（§7.173）**。上一版有三处口径已失效，本轮按
> **实测的四个 YAML** 重刷（行号与清单都从文件里读，不是从上一版抄）：
>
> | 上一版说的 | 实际 |
> |---|---|
> | 注入列表在 `cordis.patch.yml` 第 345–565 行 | 注入列表在 **`cordis.yml` 101–315**（bundle 清单）；`cordis.patch.yml` 里只有 **4 行 insert**（326/330/354/376） |
> | dormant 插件 5 个，`cordis.patch.yml:120-137` | `cordis.patch.yml` **100–135** 是 **7 行 upstream-disabled**，语义各不相同；其中 **5 个 M5+ stub** 才是 dormant |
> | 没写 preset 子树 | 补齐：**preset 子树 / 桌面安全版 preset / 独立 profile overlay** 三层 |
> | 没写 `etscli-shell-guard` | 补齐（它在三个 preset/overlay 层都有） |

## 一、三种挂法速查

```ts
// A. 事件钩子 ── 订阅 dsh 流程事件
// §7.136：agent/* 与 tools/* 的钩子**不再带 `{ global: true }`** —— 它们是
// scope 绑定的，只在**边缘模式 preset** 的 Agent 上生效（宿主按 scope 链
// 过滤：监听器自己的 scope 必须是派发 scope 或其祖先）。只有 llm/stream
// 仍是全局的（该事件不带 scope 载体）。
ctx.on('agent/pre-step', handler)          // scope 绑定
ctx.on('agent/request', handler)           // scope 绑定
ctx.on('llm/stream', handler, { global: true })
ctx.on('tools/pre-execute', handler)       // scope 绑定
ctx.on('tools/result', handler)            // scope 绑定
ctx.on('tools/change', handler)
ctx.on('skills/change', handler)
ctx.on('session/event', handler)

// B. Service 注册 ── 被别的 plugin softInject 取
ctx.reflect.provide('promptGuard', this)        // → ctx.promptGuard
ctx.reflect.provide('auditLog', this)           // → ctx.auditLog

// C. Provider 注册 ── 挂到 dsh-llm / dsh-web
ctx.llm.registerAdapter(['cloud-llm'], adapter)  // provider='cloud-llm' 的请求路由过来
ctx.web.registerSearchProvider('tavily-bocha-fallback', provider)
ctx.logger  // file-logger 重写整个 ctx.logger
```

---

## 二、入口 + 编排(input-guard + http-api)

### http-api — 外部 HTTP 入口

```ts
// src/dsh-adapter/http-api.ts:558
const dispose = this.cordisCtx.on('session/event', (session, event) => {
  // 把 dsh-agent 的流式 chunk 反向回 HTTP 客户端
  // 把 _edgeRejection 标签转 4xx (403 attack / 400 privacy-policy / 503 sanitize)
})
```
`inject: [agents, intentRouter, auditLog, tdBus, realmSkillBridge, edgeTools]`

### input-guard — 隐私编排中枢(挂 3 钩子)

```ts
// src/dsh-adapter/input-guard.ts（§7.136：前两个去掉 { global: true }）
const d1 = on('agent/pre-step', handler)                 // 正向: 攻击→策略→分类→脱敏（scope 绑定）
const d2 = on('llm/stream',    handler, { global: true }) // 反向: 反脱敏 text-delta（事件无 scope 载体）
const d3 = on('agent/request', handler)                  // §7.175 起只放行，不改路由（scope 绑定）
```

**softInject 5 个 service**(input-guard.ts:1544-1548):
```ts
const promptGuard   = (ctx as any).promptGuard     // input-guard.checkInput
const privacyPolicy = (ctx as any).privacyPolicy   // input-guard.matchRouting
const intentRouter  = (ctx as any).intentRouter    // input-guard.classify
const sanitizer     = (ctx as any).sanitizer       // input-guard.sanitize / desanitize
const auditLog      = (ctx as any).auditLog        // input-guard.audit()
```

**调用链**(input-guard.ts:739-1080):
```ts
await this.promptGuard.checkInput(text, sessionId)         // 攻击检测
const routing = this.privacyPolicy.matchRouting(text)     // 策略 REJECT
const intent  = await this.intentRouter.classify(text, …) // LOCAL/CLOUD 分类
const result  = await this.sanitizer.sanitize(text, …)    // CLOUD 才脱敏
```

---

## 三、3-tier realm gate(realm-skill-bridge)

### realm-skill-bridge — 数据安全分级权威 gate(挂 6 钩子)

```ts
// src/dsh-adapter/realm-skill-bridge.ts
}).on?.('skills/change',     () => { /* 重打 skill realm tag */ })
}).on?.('tools/change',      () => { /* 重打 tool realm tag */ })
}).on?.('agent/pre-step',    async (payload, next) => { /* Layer 1: 过滤 <available_skills> */ })
}).on?.('llm/stream',        (payload, next)     => { /* Layer 1.5: 探针 disabled (deepFreeze) */ })
}).on?.('tools/pre-execute', async (exec, next)   => { /* Layer 3: 权威 gate (拒绝 = reject) */ })
}).on?.('tools/result',      (exec, result)      => { /* status 落 ops log */ })
}).on?.('session/event',     (session, evt)      => { /* 补 TUI 路径 turn/start, turn/end 日志 */ })
```

**代理引用**:
```ts
// inject 硬依赖 (cordis.patch.yml:359)
inject: [auditLog, skills]

// softService (realm-skill-bridge.ts:418)
this.ctx.edgeTools.setRealm(toolName, tag)  // 给 dsh-tools 标的工具打 realm tag
this.ctx.skills.list()                     // 列 host 平面已注册的 skill
```

---

## 四、Privacy / Security 4 件套(Service 注册型)

### prompt-guard — 攻击检测

```ts
// 注册
ctx.reflect.provide('promptGuard', this)   // → ctx.promptGuard
// 提供的方法 (被 input-guard 调)
ctx.promptGuard.checkInput(text, sessionId): { allowed, reasons, severity }
// inject
inject: [auditLog, llm]                    // 可选 local-llm 模型辅助检测
```

### privacy-policy — 用户策略引擎

```ts
// 注册
ctx.reflect.provide('privacyPolicy', this) // → ctx.privacyPolicy
// 提供的方法
ctx.privacyPolicy.matchRouting(text): { action: 'allow'|'reject'|'sanitize', reasons }
// inject
inject: [auditLog]
```

### sanitizer-pipeline — PII 占位符引擎

```ts
// 注册
ctx.reflect.provide('sanitizer', this)     // → ctx.sanitizer
// 提供的方法
ctx.sanitizer.sanitize(text, { sessionId })        // 明文 → 占位符
ctx.sanitizer.desanitize(text, sessionId)          // 占位符 → 明文
// inject
inject: [privacyPolicy, auditLog]
```

### intent-router — LOCAL/CLOUD 分类

```ts
// 注册
ctx.reflect.provide('intentRouter', this)  // → ctx.intentRouter
// 提供的方法
ctx.intentRouter.classify(text, { sessionId }): { category: 'LOCAL'|'CLOUD'|'SANITIZED', confidence, reason }
// 内部 softService (intent-router.ts:258, 312, 424, 456)
this.softService('piiUtils')       // ctx.piiUtils.redactString
this.softService('privacyPolicy')  // precheck 策略
this.softService('modelRouter')    // 分类模型选择
this.softService('sanitizer')      // 历史消息 sanitize
// inject
inject: [llm, auditLog]            // 内部调 ctx.llm.stream 走 local-llm-adapter 分类
```

### model-router — 决策 provider/model

```ts
// 注册
ctx.reflect.provide('modelRouter', this)   // → ctx.modelRouter
// 提供的方法
ctx.modelRouter.resolve({ intent, route, fallback }): { provider, model }
// inject
inject: [llm]
```

---

## 五、LLM / Web Provider 注册

### cloud-llm-adapter — DeepSeek / 自配端点

```ts
// src/dsh-adapter/cloud-llm-adapter.ts:626
const registration = llm.registerAdapter(config.providers, adapter)
// config.providers = ['cloud-llm']
// 所有标 provider='cloud-llm' 的请求 → 自动转给本 adapter
// inject
inject: [llm, auditLog]
```

### local-llm-adapter — LAN Qwen3-4B / minicpm5-2b

```ts
// src/dsh-adapter/local-llm-adapter.ts:560
const registration = llm.registerAdapter(config.providers, adapter)
// config.providers = ['local-llm']
// 并发信号量 max=2, timeout 60s, 防止 Qwen3-4B 被打挂
// inject
inject: [llm, auditLog]
```

### web-search-tavily-bocha — 3-tier 兜底链

```ts
// src/dsh-adapter/web-search-tavily-bocha.ts:269
ctx.web.registerSearchProvider('tavily-bocha-fallback', provider)
// 三级链: Tavily → 博查 AI → DeepSeek
// 任一 tier 抛错 → 下一 tier
// inject
inject: [web]   // 硬依赖 dsh-web seam
```

### function-call-external — 外部 function call 通道

```ts
// src/dsh-adapter/function-call-external.ts
export const inject = ['auditLog', 'realmSkillBridge', 'tools'] as const
```

让**外部系统**（手机 app、第三方服务）经宿主调用本仓的 function call 通道。
它在 preset 里排在 `realm-skill-bridge` 之后 ⇒ 外部调用同样过 realm 闸门与工具打标。
（上一版漏了这个插件。）

---

## 六、Tool 层监控 + Logger

### tools (edge-tools-registry) — 注册工具 + realm 打标

```ts
// src/dsh-adapter/tools.ts:126
ctx.tools.register(tool)                    // 注册本地工具到 dsh-tools
// src/dsh-adapter/tools.ts:342
const disposeChange = ctx.on?.('tools/change', onToolsChange)
// 每次 dsh-tools 列表变化 → 按 DSH_NATIVE_REALM_MAP 重打 realm tag
// 注册
ctx.reflect.provide('edgeTools', this)       // → ctx.edgeTools (被 realm-skill-bridge 软调)
// inject
inject: [auditLog, tools]
```

### file-logger — 观测底盘(居首=排版约定;通道可用性靠延迟注入,§7.169)

```ts
// src/dsh-adapter/file-logger.ts(export const inject = [] as const)
// 重写 ctx.logger.*, 所有 plugin 的日志输出 → ~/.dsh-edge-agent/log/…log
// cordis.patch.yml §M6 注释(§7.169 已更正):旧的 "Must mount FIRST / 按依赖序
// 加载所以居首必最先 apply" 断言被实测推翻 —— 同层先后由模块解析速度决定。
// 需要「通道就位后才落」的启动凭据走 ctx.inject(['fileLogger'], …) 延迟注入。
```

### etscli-tools / etscli-shell-guard — 端侧直出工具 + shell 护栏

```ts
// src/dsh-adapter/etscli-tools.ts
export const inject = ['tools', 'shell'] as const
// src/dsh-adapter/etscli-shell-guard.ts
export const inject = [] as const
export function registerEtscliShellGuard(ctx, …)   // 单独注册函数
```

`etscli-tools` 把端侧直出工具挂进宿主的 `ctx.tools`；`etscli-shell-guard` 是它的
**shell 护栏**（单独注册，`inject` 为空 ⇒ 不依赖别的服务）。
两者在**三个 preset/overlay 层都有**（§8.4）—— 上一版整份清单里**漏了它们**，
其中 `etscli-shell-guard` 尤其关键：漏了它，端侧工具就能绕过 shell 护栏。

---

## 七、辅助 service(被个别 plugin 软调)

### audit-log — JSONL 审计(被几乎所有 plugin 反向观测)

```ts
// 注册
ctx.reflect.provide('auditLog', this)    // → ctx.auditLog
// 提供的方法
ctx.auditLog.log({ level, kind, source, payload })  // level=info/warn/error/security
// 注意 minLevel 默认 'info', debug 静默 drop (audit-log.ts:163)
// root: ~/.dsh-edge-agent/audit/audit.plain.jsonl
// §7.101: 新增 onEntry(listener) 活体 seam —— log() ring push 后 fire,
// listener 故障 try/catch fail-open,返回 unsubscribe
ctx.auditLog.onEntry((entry) => edgeContextView.record(entry))
```

### edge-context-view — §7.101 桌面右栏 Edge tab host 半体(只桌面)

```ts
// 注册(inject: [auditLog] 硬依赖,connection 软延迟)
ctx.reflect.provide('edgeContextView', this)    // → ctx.edgeContextView
// 提供的方法
ctx.edgeContextView.snapshot(sessionId, cursor)  // 纯数据 fold,非 AsyncIterable
ctx.edgeContextView.record(entry)                // 单条 audit 入 row ring
ctx.edgeContextView.recordSessionEvent(sid, type, data)  // session/event 折叠
// 提供给 client 的传输层: deferred inject(['connection'], ...) 后注册
// POST /api/dsh-edge/context route —— 框架 connection.fetch.register 标准件
// 客户端相对路径 'api/dsh-edge/context'(反向代理前缀纪律)
// session summary tokens = assistant/message.usage,adapter 不报账时 undefined
// payload 字段经 safePayload 过 pii-utils 5 类 tokenize + 嵌套对象扁平化
```

### tcm — TEE 密钥管理(被 prompt-guard 注入)

```ts
// 注册
ctx.plugin(TcmService)                  // → ctx.tcm
// 提供的方法
ctx.tcm.deriveKey / sealKey / unsealKey
// 用途: 加密 sanitizer 的明文 PII 映射表
// 配置: teeType=simulated (nitro 可选), keyStorePath=~/.dsh-edge-agent/tcm-keys.json
```

### local-storage — 加密 KV

```ts
// 注册
ctx.reflect.provide('localStorage', this)  // → ctx.localStorage
// 提供的方法
ctx.localStorage.get/set/del
// 用途: 存 sanitizer 暂存数据
// 路径: ~/.dsh-edge-agent/storage/storage.plain.jsonl
```

### sessions — JSONL 持久化（**bundle 清单挂、patch 层不挂**）

```ts
// cordis.yml:133  id=sessions-edge → '@dsh-edge/dsh-edge-agent/sessions'
//   inject: [tcm, localStorage]
// cordis.patch.yml:342-352 —— patch 层**故意不再 mount**：
//   dsh-base 已 mount 同一包 (session-persistence-jsonl)，再挂一次会 duplicate
//   provide() ⇒ 硬 boot 失败（§7.25 后修正）。root 由
//   DSH_EDGE_SESSION_ROOT env 改写（走 dshHomePath('sessions')）
// 提供的方法
ctx.sessions.create/resume/list/getEvents/snapshotEvents
```

> ⚠️ 上一版只写「继承 dsh-base，这里没 mount」，漏了 **bundle 清单（`cordis.yml`）
> 里其实有这一行**（id 是 `sessions-edge`）。两层不是一回事。

### td-bus — 威胁总线

```ts
// src/dsh-adapter/td-bus.ts
export const inject = ['auditLog', 'privacyPolicy'] as const
// 对外：getThreatLevel(): 'normal'|'elevated'|'high'|'critical'
//       recordCloudRequest() / isBlocked()
```

订阅高流量 audit 事件，按滑动窗口的云请求数抬高威胁等级（阈值来自
`config/edge.json` 的 `threat.*`）。**`http-api` 读 `getThreatLevel()`**：
达到 `threat.blockLevel` 就拒收外部请求。上游 `prompt-guard` 的攻击检测是
**单次请求**判定，td-bus 是**速率/累积**判定，两者互补。

---

## 八、四层挂载树 + 注入依赖完整列表

### 8.1 四层模型（先看这个，否则行号全对不上）

本仓的插件**挂在哪里**取决于哪份清单，共四层：

| 层 | 文件 | 作用 | 本仓行数 |
|---|---|---|---|
| **bundle 清单** | `cordis.yml` | `dsh --config cordis.yml` 的插件清单（**带 `inject`**）—— 注入依赖的事实源 | **21 行**（101–315） |
| **patch 层** | `cordis.patch.yml` | 覆盖上游 `dsh-base` 层 + **4 行 insert**（宿主树） | 383 行；insert 326/330/354/376 |
| **preset 子树** | `presets/edge.patch.yml` | 「边缘模式」工作方式的插件子树（§7.135） | **18 行**（250–484） |
| **preset 子树** | `presets/edge.desktop-safe.patch.yml` | 桌面安全版 preset 子树 | **16 行**（249–425） |
| **profile overlay** | `profiles/dsh-edge-agent/cordis.patch.yml` | 独立 profile 的 overlay（安装脚本落的那份） | **17 行**（70–154） |

> ⚠️ 上一版把 inject 列表说成「`cordis.patch.yml` 第 345–565 行」是**指错了文件**
> —— 那个区间属于 `cordis.yml`。`cordis.patch.yml` 里只有 4 行 insert。

### 8.2 bundle 清单（`cordis.yml` 101–315）—— 注入依赖的事实源

| 行 | id | 挂载点 | inject |
|---|---|---|---|
| 101 | `dsh-edge-agent` | 聚合器（挂所有子插件 + 注册 model-facing `services` 命名空间） | `agents, llm, sessions, invariants` |
| 115 | `tcm` | TEE 密钥管理（**必须最先挂**） | — |
| 125 | `local-storage` | 加密 KV | `tcm` |
| 133 | `sessions-edge` | sessions（patch 层不重复挂，见 §七） | `tcm, localStorage` |
| 141 | `audit-log` | JSONL 审计 | `tcm, localStorage` |
| 155 | `privacy-policy` | 策略引擎 | `tcm, localStorage, auditLog` |
| 164 | `tools` | 工具注册 + realm 打标 | `auditLog` |
| 175 | `realm-skill-bridge` | 3-tier realm gate | `auditLog` |
| 184 | `prompt-guard` | 攻击检测 | `tcm, privacyPolicy, auditLog, llm` |
| 196 | `intent-router` | LOCAL/CLOUD 分类 | `llm, promptGuard, privacyPolicy, auditLog, sessions, localStorage` |
| 208 | `model-router` | provider/model 决策 | `llm, privacyPolicy, auditLog` |
| 228 | `local-llm-adapter` | 本地池 adapter | — |
| 237 | `cloud-llm-adapter` | 云池 adapter | `secureBridge, auditLog` |
| 247 | `sanitizer-pipeline` | PII 占位符 | `localStorage, privacyPolicy` |
| 261 | `ohttp-gateway` | OHTTP 匿名传输（**dormant**，见 §十） | `tcm, auditLog` |
| 272 | `secure-bridge` | 加密桥（**dormant**） | `tcm, ohttp, privacyPolicy, auditLog` |
| 282 | `attestation` | TEE 远程证明（**dormant**） | `tcm, auditLog` |
| 292 | `td-bus` | 威胁总线 | `auditLog, privacyPolicy` |
| 304 | `voice-input` | 语音输入（**dormant**） | `sessions, auditLog` |
| 315 | `plugin-host` | 插件宿主（**dormant**） | `agents, sessions` |

### 8.3 patch 层（`cordis.patch.yml`）

- **upstream-disabled（100–135）**：7 行，覆盖上游 `dsh-base` 的同名 id。
  `dsh-edge-agent`(118) 是**防聚合器与 individual rows 双 apply**（不是 dormant）；
  `web-search`(132) 是**让位**给我们自己的 `web-search-tavily-bocha`；
  另 5 个是 M5+ stub（见 §十）。
- **insert 段（326–381）**：4 行，必须留在**宿主树**（不在 preset 里）——

  | 行 | id | 为什么必须留在宿主树 |
  |---|---|---|
  | 326 | `dsh-edge-agent`（裸包名） | client-modules 扫的是**宿主 Loader** 的 entries，preset 的 EntryTree 不在其中 ⇒ 裸名行放 preset 里永远扫不到浏览器半体，**Edge tab 会消失**（§7.136） |
  | 329 | `file-logger` | 重写 `ctx.logger.*`（通道就位由消费方延迟注入保证，§7.169） |
  | 353 | `audit-log` | 审计底座 |
  | 375 | `desktop-cookie-janitor` | 修**宿主自己的启动**（Electron 握手 cookie 堆到 16 KB ⇒ 431 ⇒ 外壳拆宿主）—— 发生在任何工作方式选定之前 ⇒ 必须在 preset 之外 |

### 8.4 preset 子树与 profile overlay

**`presets/edge.patch.yml`（边缘模式，250–484，18 行）**

| 行 | id | inject |
|---|---|---|
| 250 | `tcm` | — |
| 260 | `td-bus` | `auditLog, privacyPolicy` |
| 275 | `realm-skill-bridge` | `auditLog, skills, edgeTools, tools` |
| 284 | `http-api` | `agents, intentRouter, auditLog, tdBus, realmSkillBridge, edgeTools` |
| 288 | `cloud-llm-adapter` | `llm, auditLog` |
| 305 | `local-llm-adapter` | `llm, auditLog` |
| 317 | `model-router` | `llm` |
| 327 | `intent-router` | `llm, auditLog, privacyPolicy` |
| 340 | `edge-tools-registry` | `auditLog, tools` |
| 359 | `etscli-tools` | `tools, shell` |
| 373 | `etscli-shell-guard` | — |
| 376 | `local-storage` | — |
| 386 | `prompt-guard` | `auditLog, llm` |
| 399 | `privacy-policy` | `auditLog` |
| 413 | `sanitizer-pipeline` | `privacyPolicy, auditLog` |
| 430 | `web-search-tavily-bocha` | `web` |
| 459 | `function-call-external` | `auditLog, realmSkillBridge, tools` |
| 484 | `input-guard` | `promptGuard, privacyPolicy, intentRouter, sanitizer, auditLog, realmSkillBridge` |

**`presets/edge.desktop-safe.patch.yml`（桌面安全版，249–425，16 行）**

| 行 | id | inject |
|---|---|---|
| 249 | `tcm` | — |
| 255 | `privacy-policy` | `auditLog` |
| 263 | `td-bus` | `auditLog, privacyPolicy` |
| 273 | `edge-tools-registry` | `auditLog, tools` |
| 287 | `etscli-shell-guard` | — |
| 291 | `realm-skill-bridge` | `auditLog, skills, edgeTools, tools` |
| 299 | `prompt-guard` | `privacyPolicy, auditLog, llm` |
| 311 | `sanitizer-pipeline` | `privacyPolicy, auditLog` |
| 321 | `intent-router` | `llm, auditLog, privacyPolicy` |
| 332 | `cloud-llm-adapter` | `llm, auditLog` |
| 358 | `local-llm-adapter` | `llm, auditLog` |
| 366 | `model-router` | `llm` |
| 375 | `function-call-external` | `auditLog, realmSkillBridge, tools` |
| 380 | `input-guard` | `promptGuard, privacyPolicy, intentRouter, sanitizer, auditLog, realmSkillBridge` |
| 417 | `edge-context-view` | — |
| 425 | `web-search-tavily-bocha` | — |

**`profiles/dsh-edge-agent/cordis.patch.yml`（独立 profile overlay，70–154，17 行）**

tcm(70) / privacy-policy(75) / td-bus(79) / edge-tools-registry(83) /
etscli-shell-guard(97) / realm-skill-bridge(102) / prompt-guard(107) /
sanitizer-pipeline(112) / intent-router(118) / model-router(123) /
input-guard(127) / local-llm-adapter(132) / cloud-llm-adapter(135) /
function-call-external(140) / edge-context-view(145) /
web-search-tavily-bocha(149) / http-api(154)

> overlay 行的 `inject` 一律留空 —— 它们继承 preset 层已解析的依赖。

### 8.5 三层的 inject 差异（别拿某一层的值当全局真值）

同一个插件在三层的 `inject` **不一样**，因为层内可见的服务集合不同。例：

| 插件 | bundle 清单 | 边缘 preset | 桌面安全 preset |
|---|---|---|---|
| `prompt-guard` | `tcm, privacyPolicy, auditLog, llm` | `auditLog, llm` | `privacyPolicy, auditLog, llm` |
| `intent-router` | `llm, promptGuard, privacyPolicy, auditLog, sessions, localStorage` | `llm, auditLog, privacyPolicy` | `llm, auditLog, privacyPolicy` |
| `realm-skill-bridge` | `auditLog` | `auditLog, skills, edgeTools, tools` | `auditLog, skills, edgeTools, tools` |

⇒ 「某插件到底 inject 了谁」这个问题**没有单一答案**，必须指明在哪一层查。

---

## 九、一张图看完整链路

```
HTTP :21017
  ↓
http-api ──inject──► [agents, intentRouter, auditLog, tdBus, realmSkillBridge, edgeTools]
  └─session/event─► (chunk 回流, 4xx 拒收)
       │
       ▼
  dsh-agent-loop
       │
  agent/pre-step ──► input-guard (注入 promptGuard/privacyPolicy/intentRouter/sanitizer/auditLog)
       │              └─ promptGuard.checkInput  (ctx.promptGuard)
       │              └─ privacyPolicy.matchRouting  (ctx.privacyPolicy)
       │              └─ intentRouter.classify  (ctx.intentRouter → ctx.llm → local-llm-adapter)
       │              └─ sanitizer.sanitize  (ctx.sanitizer)
       │
  agent/pre-step ──► realm-skill-bridge (Layer 1: 过滤 <available_skills>)
       │              └─ inject: [auditLog, skills]
       │              └─ softService: ctx.edgeTools (打 realm tag)
       │
  agent/request ──► input-guard (§7.175 起只放行：不改 provider/model)
       │
  llm/stream ──► input-guard (反脱敏 text-delta, ctx.sanitizer.desanitize)
       │
  llm/stream ──► realm-skill-bridge (Layer 1.5 探针, disabled, deepFreeze)
       │
       ▼
  tools/pre-execute ──► realm-skill-bridge (Layer 3 权威 gate)
       │
       ▼
  tools/result ──► realm-skill-bridge (status 落 log)
  tools/change ──► realm-skill-bridge (重打 tag)
  tools/change ──► tools/edge-tools-registry (重打 tag)
  skills/change ──► realm-skill-bridge (重打 tag)
  session/event ──► realm-skill-bridge (补 TUI turn 日志)

观测底盘:
  audit-log ─► 所有 plugin ctx.auditLog.log(...)
  file-logger ─► 重写 ctx.logger.*, 落 ~/.dsh-edge-agent/log/(就位时机=延迟注入,§7.169)

Provider 注册 (并行):
  cloud-llm-adapter   ─► ctx.llm.registerAdapter(['cloud-llm'], adapter)
  local-llm-adapter   ─► ctx.llm.registerAdapter(['local-llm'], adapter)
  web-search-tavily-bocha ─► ctx.web.registerSearchProvider('tavily-bocha-fallback', p)
```

---

## 十、dormant 插件（5 个 M5+ stub，2026-11-10 实测）

在 `cordis.yml`（bundle 清单）里声明了、但**不在任何 preset 子树里** ⇒ 实际不挂载：

| bundle 清单行 | id | 用途 | inject |
|---|---|---|---|
| 261 | `ohttp-gateway` | OHTTP 匿名传输 | `tcm, auditLog` |
| 272 | `secure-bridge` | 加密桥 | `tcm, ohttp, privacyPolicy, auditLog` |
| 282 | `attestation` | TEE 远程证明 | `tcm, auditLog` |
| 304 | `voice-input` | 语音输入 | `sessions, auditLog` |
| 315 | `plugin-host` | 插件宿主 | `agents, sessions` |

> ⚠️ 上一版写的「`cordis.patch.yml:120-137`」不准。`cordis.patch.yml`
> **100–135** 是一整段 **upstream-disabled**，一共 **7 行**，语义各不相同，别混为一谈：
>
> | 行 | id | 这条 disable 的含义 |
> |---|---|---|
> | 118 | `dsh-edge-agent` | **防聚合器与 individual rows 双 apply**（不是 dormant） |
> | 124 | `plugin-host` | M5+ stub ⇒ dormant |
> | 126 | `ohttp-gateway` | M5+ stub ⇒ dormant |
> | 128 | `secure-bridge` | M5+ stub ⇒ dormant |
> | 130 | `attestation` | M5+ stub ⇒ dormant |
> | 132 | `web-search` | **让位**给我们自己的 `web-search-tavily-bocha`（上游那个不是 dormant） |
> | 134 | `voice-input` | M5+ stub ⇒ dormant |
>
> 也就是说：**dormant 的 5 个 = 上表 124 / 126 / 128 / 130 / 134 这 5 行**，
> 它们在 `cordis.yml` 里另有各自的声明行（见上表）。
> `web-search` 与 `dsh-edge-agent` 两条 disable 是**另外的语义**，别数进 dormant。

---

## 十一、速记三句话

1. **每个插件只有三种挂法**:挂 dsh 事件(`ctx.on`) / 注册 service(`ctx.reflect.provide`) / 注册 LLM/web provider(`ctx.llm.registerAdapter` / `ctx.web.registerSearchProvider`)。
2. **input-guard 是编排器**:挂 3 个 dsh 钩子,`softInject` 5 个 service,把 prompt-guard / privacy-policy / intent-router / sanitizer 串成一条管线。
3. **观测底盘 = audit-log + file-logger**:audit-log 是 service provider(几乎所有 plugin emit),file-logger 重写 ctx.logger(§7.169:同层 apply 先后靠不住,通道就位由消费方 `ctx.inject(['fileLogger'], …)` 延迟注入保证)。
