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

#### 安全/隐私层 (8 个)

| 插件 | 文件 | 依赖的 DSH 服务 | 作用 |
|------|------|----------------|------|
| **tcm** | `tcm.ts` | 无 | TEE 密钥管理,AES-256-GCM 加解密,密封,远程证明 |
| **local-storage** | `local-storage.ts` | tcm | AES-256-GCM 加密的 SQLite KV 存储 |
| **audit-log** | `audit-log.ts` | tcm, localStorage | HMAC 链接的防篡改审计日志,JSONL 持久化 |
| **sessions** | `sessions.ts` | localStorage | 加密会话生命周期管理(扩展 DSH sessions) |
| **privacy-policy** | `privacy-policy.ts` | tcm, localStorage, auditLog | 热加载的隐私策略引擎 |
| **prompt-guard** | `prompt-guard.ts` | tcm, privacyPolicy, auditLog | 输入/输出安全扫描(MVP:4 条规则) |
| **ohttp-gateway** | `ohttp-gateway.ts` | tcm, auditLog | RFC 9458 OHTTP 匿名网关 |
| **secure-bridge** | `secure-bridge.ts` | tcm, ohttp, privacyPolicy, auditLog | 出站安全桥(OHTTP/TLS 模式) |
| **attestation** | `attestation.ts` | tcm, auditLog | TEE 证明 token 生成/验证 |
| **sanitizer-pipeline** | `sanitizer-pipeline.ts` | localStorage, privacyPolicy | PII 正向/反向脱敏 |
| **td-bus** | `td-bus.ts` | auditLog, privacyPolicy | 威胁检测总线(速率/模式异常) |

#### LLM 适配层 (3 个)

| 插件 | 文件 | 依赖的 DSH 服务 | 作用 |
|------|------|----------------|------|
| **local-llm-adapter** | `local-llm-adapter.ts` | llm, auditLog | 本地 Qwen3-4B 推理(llama.cpp),继承 `LlmAdapter` |
| **cloud-llm-adapter** | `cloud-llm-adapter.ts` | llm, secureBridge, auditLog | DeepSeek Chat Completions(SSE),继承 `LlmAdapter` |
| **model-router** | `model-router.ts` | llm | 模型路由,统一 `ctx.llm` 表面 |

#### 工具层 (已复用 DSH 原生工具)

| 插件 | 文件 | 依赖的 DSH 服务 | 作用 |
|------|------|----------------|------|
| **tools** | `tools.ts` | auditLog | Realm 工具注册表配置,为 DSH 原生工具添加 Realm 标记 |

> **工具复用**: dsh-edge-agent 不再自行实现工具插件,而是直接复用 DSH 原生工具:
> - `@deepseek-ai/dsh-tool-bash` — Bash 执行
> - `@deepseek-ai/dsh-tool-fs` — 文件系统(read/write/edit/read_image)
> - `@deepseek-ai/dsh-tool-web` — Web 搜索和抓取
> - `@deepseek-ai/dsh-web-search-deepseek` — DeepSeek 搜索提供者

#### 编排层 (3 个)

| 插件 | 文件 | 依赖的 DSH 服务 | 作用 |
|------|------|----------------|------|
| **intent-router** | `intent-router.ts` | llm, promptGuard, privacyPolicy, auditLog, sessions, localStorage | 意图分类 → LOCAL/CLOUD 路由 |
| **plugin-host** | `plugin-host.ts` | agents, sessions | 第三方插件宿主(Community Consensus grant) |
| **http-api** | `http-api.ts` | agents, intentRouter, auditLog | HTTP 接入(POST /v1/chat, SSE 流) |

#### 辅助插件 (2 个)

| 插件 | 文件 | 依赖的 DSH 服务 | 作用 |
|------|------|----------------|------|
| **voice-input** | `voice-input.ts` | sessions, auditLog | Whisper-tiny 语音输入 |
| **invariant** | `contract.ts` | invariants | 启动时上游 DSH 契约校验 |

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
    HTTP->>MR: resolveRoute(cloud-deepseek-v4)
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
| `local-llm-adapter` | `ctx.llm` | 继承 `LlmAdapter`,注册 `stream()` |
| `cloud-llm-adapter` | `ctx.llm` | 继承 `LlmAdapter`,注册 `stream()` |
| `model-router` | `ctx.llm` | 调用 `resolveRoute()`,选择 adapter |
| `intent-router` | `ctx.llm` | 调用 `generate()` 做意图分类 |
| `http-api` | `ctx.agents`, `ctx.sessions` | 调用 `agents.create()`, `agent.followup()` |
| `http-api` | `ctx.on('session/event')` | 订阅所有 session 事件 |
| `local-tools` | `ctx.tools` (edgeTools) | 调用 `defineTool()` 注册 LOCAL 工具 |
| `web-search` | `ctx.web` | 调用 `registerSearchProvider()` |
| `plugin-host` | `ctx.agents`, `ctx.sessions` | 管理第三方插件 grant |
| `sessions` (edge) | `ctx.localStorage` | 加密会话元数据 |
| `audit-log` | `ctx.tcm` | HMAC 链接 |
| `privacy-policy` | `ctx.localStorage` | 持久化策略缓存 |
| `secure-bridge` | `ctx.ohttp`, `ctx.privacyPolicy` | 出站请求加密 + 域名过滤 |

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
