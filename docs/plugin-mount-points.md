# dsh-edge-agent 插件挂点表(代码版)

> 每个插件在 dsh 流程上的真实挂点 + 真实代理引用。

## 一、三种挂法速查

```ts
// A. 事件钩子 ── 订阅 dsh 流程事件
ctx.on('agent/pre-step', handler, { global: true })
ctx.on('llm/stream', handler, { global: true })
ctx.on('agent/request', handler, { global: true })
ctx.on('tools/pre-execute', handler, { global: true })
ctx.on('tools/result', handler)
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
// src/dsh-adapter/input-guard.ts:1602,1618,1636
const d1 = on('agent/pre-step', handler, { global: true })  // 正向: 攻击→策略→分类→脱敏
const d2 = on('llm/stream',    handler, { global: true })  // 反向: 反脱敏 text-delta
const d3 = on('agent/request', handler, { global: true })  // 路由改写: sanitize失败 CLOUD→LOCAL
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

### file-logger — 观测底盘(必须第一个 apply)

```ts
// src/dsh-adapter/file-logger.ts:524
// 重写 ctx.logger.*, 所有 plugin 的日志输出 → ~/.dsh-edge-agent/log/dsh-edge-agent.log
// cordis.patch.yml:299-303 注释:
// "Must mount FIRST so every other plugin's ctx.logger.* call lands on disk"
```

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

### sessions — JSONL 持久化(继承 dsh-base,这里没 mount)

```ts
// cordis.patch.yml:454-464 没在 patch 里重新 mount
// dsh-base 已 mount 同一包 (session-persistence-jsonl)
// DSH_EDGE_SESSION_ROOT env 改写 root 到 ~/.dsh-edge-agent/sessions
// 提供的方法
ctx.sessions.create/resume/list/getEvents/snapshotEvents
```

---

## 八、注入依赖完整列表(cordis.patch.yml 第 345-565 行)

```yaml
# td-bus
inject: [auditLog, privacyPolicy]

# realm-skill-bridge
inject: [auditLog, skills]

# http-api
inject: [agents, intentRouter, auditLog, tdBus, realmSkillBridge, edgeTools]

# cloud-llm-adapter
inject: [llm, auditLog]

# local-llm-adapter
inject: [llm, auditLog]

# model-router
inject: [llm]

# intent-router
inject: [llm, auditLog]

# edge-tools-registry
inject: [auditLog, tools]

# prompt-guard
inject: [auditLog, llm]

# privacy-policy
inject: [auditLog]

# sanitizer-pipeline
inject: [privacyPolicy, auditLog]

# web-search-tavily-bocha
inject: [web]

# input-guard (5 个硬依赖 + softService)
inject: [promptGuard, privacyPolicy, intentRouter, sanitizer, auditLog]
```

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
  agent/request ──► input-guard (改写 provider/model: CLOUD → LOCAL)
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
  file-logger ─► 重写 ctx.logger.*, 第一个 apply, 落 ~/.dsh-edge-agent/log/

Provider 注册 (并行):
  cloud-llm-adapter   ─► ctx.llm.registerAdapter(['cloud-llm'], adapter)
  local-llm-adapter   ─► ctx.llm.registerAdapter(['local-llm'], adapter)
  web-search-tavily-bocha ─► ctx.web.registerSearchProvider('tavily-bocha-fallback', p)
```

---

## 十、dormant 插件(5 个,M5+ 待做)

```yaml
# cordis.patch.yml:120-137 — 全部 disabled: true
- id: plugin-host       # 53 行 stub
- id: ohttp-gateway     # OHTTP 匿名传输
- id: secure-bridge     # 加密桥
- id: attestation       # TEE 远程证明
- id: voice-input       # 53 行 skeleton
```

---

## 十一、速记三句话

1. **每个插件只有三种挂法**:挂 dsh 事件(`ctx.on`) / 注册 service(`ctx.reflect.provide`) / 注册 LLM/web provider(`ctx.llm.registerAdapter` / `ctx.web.registerSearchProvider`)。
2. **input-guard 是编排器**:挂 3 个 dsh 钩子,`softInject` 5 个 service,把 prompt-guard / privacy-policy / intent-router / sanitizer 串成一条管线。
3. **观测底盘 = audit-log + file-logger**:audit-log 是 service provider(几乎所有 plugin emit),file-logger 重写 ctx.logger(必须第一个 apply 才能捞住所有日志)。
