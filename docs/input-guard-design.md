# input-guard 插件设计

> **状态**：Draft · 2026-08-28
> **作者**：edge-agent team
> **关联**：[architecture.md](./architecture.md) · [plugin-architecture.md](./plugin-architecture.md) · [test-report-sanitization-2026-08-25.md](./test-report-sanitization-2026-08-25.md)
> **关联决策讨论**：脱敏管线应挂在 Agent Loop 的事件链上，而不是某个入口（http-api / Web UI）内部。

## 1. TL;DR

`input-guard` 是一个**新**的 DSH 插件，作为端侧隐私安全管线的**编排器**，挂在 DSH 官方提供的 `agent/pre-step`（正向）和 `llm/stream`（反向）两个 hook 上，**统一覆盖所有入口**：http-api、Web UI、CLI、SDK，以及未来任何接入方式。

它不替代现有插件，而是**组合调用**它们：

```
input-guard (编排器)
  ├── promptGuard.checkInput     (regex + 模型攻击检测)
  ├── privacyPolicy.matchRouting (数据分类 / REJECT 策略)
  ├── intentRouter.classify      (LOCAL / CLOUD / REJECT 路由)
  ├── sanitizer.sanitize         (PII → 占位符，仅 CLOUD 路径)
  └── sanitizer.desanitize       (占位符 → PII，输出方向还原)
```

## 2. 背景：当前脱敏在哪里做

目前脱敏逻辑**硬编码在 `http-api` 插件内部**：

```
http-api.ts:
  L385: promptGuard.checkInput(message, sessionId)    // 攻击检测
  L458: sanitizer.sanitize(message, { sessionId })    // PII 脱敏
  L466: sanitizer.desanitize(result, sessionId)       // 输出还原
  + 隐式的 intentRouter.classify 调用（决定 LOCAL/CLOUD 分支）
```

**问题**：http-api 只是众多入口之一。当 Web UI（`dsh-web-ui-all` 全家桶）接入后，它的 chat 走 `dsh-host-apiproxy` → `agent-loop`，**完全绕过 http-api**，脱敏管线失效。

```
                  ┌──────────────────────────┐
                  │   dsh-edge-agent 进程      │
                  │                          │
http-api (21017) ─┤─ ✅ 有脱敏 ─┐            │
                  │              ▼            │
Web UI apiproxy ──┤─ ❌ 无脱敏 ─┼─→ agent-loop │
                  │              │            │
CLI / SDK ────────┤─ ❌ 无脱敏 ─┘            │
                  └──────────────────────────┘
```

**目标架构**：脱敏必须做在**所有入口的必经之路**上 — 也就是 Agent Loop 的事件链上。

```
http-api ──────┐
Web UI ────────┤
CLI / SDK ─────┼─→ agent-loop ──→ [agent/pre-step] ──→ LLM
               │                        │
               │                  input-guard 在这里
               │                  统一执行脱敏管线
               │                        │
               └─→ agent-loop ←── [llm/stream] ←── LLM
                                        │
                                  input-guard 在这里
                                  统一执行反脱敏
```

## 3. 为什么需要独立插件 — 不能合入已有插件吗？

这是最核心的问题。我们逐项分析过每种合并可能性，结论都是**不合**。

### 3.1 候选合并 A：并入 `prompt-guard`？

**表面看合理**：`prompt-guard` 已经在做 `checkInput`，让它再管脱敏 + 路由，"一个插件搞定输入安全"。

**为什么不行**：

| 维度 | prompt-guard（当前）| 合并后 |
|---|---|---|
| 职责 | 攻击检测（regex + 模型）| 攻击检测 + 策略 + 分类 + 脱敏 + 跨 hook 状态 |
| 测试面 | 单一：攻击模式识别 | 5 合 1，难以独立回归 |
| 单独开关 | ✅ 可以 `enableInjectionDetection=false` 关攻击检测 | ❌ 一关全关 |
| 失败模式 | 检测失败 fail-open，不影响后续 | 检测失败可能阻断脱敏 |

**根本原因**：`prompt-guard` 是一个**检测器（detector）** — 输入文本，输出 verdict（safe/unsafe）。`input-guard` 是一个**编排器（orchestrator）** — 按顺序调用多个服务、维护跨 hook 状态、决定降级策略。

把编排器塞进检测器，等于让"温度计"同时管"空调控制器"。温度检测和温控策略应该分开。

**类比**：
- `prompt-guard` ≈ 烟雾报警器（检测）
- `privacy-policy` ≈ 消防法规（策略）
- `sanitizer-pipeline` ≈ 防毒面具（处理）
- `input-guard` ≈ **消防指挥员**（编排：先报警、再查法规、再发面具）

让报警器同时指挥全场，会把它搞得很复杂，而且以后想换策略引擎时连报警器都要改。

### 3.2 候选合并 B：并入 `intent-router`？

**表面看合理**：intent-router 已经在做分类（LOCAL/CLOUD），分类结果正好决定要不要脱敏，"分类 + 脱敏一气呵成"。

**为什么不行**：

1. **破坏分类的纯粹性** — intent-router 当前是**纯函数式服务**：输入文本，输出 `{ category, confidence, rationale }`。它不修改消息、不注册全局 hook、不维护 session 状态。加上脱敏后，它要注册 `agent/pre-step` hook、调用 sanitizer、维护 mapping 表 — 变成一个重量级的状态ful 编排器。

2. **双重调用问题** — http-api 当前显式调用 `ctx.intentRouter.classify(text)` 做路由决策。如果 intent-router 自己在 `agent/pre-step` 又跑一遍，会**分类两次**（浪费 Qwen3-4B 一次推理）。要解决这个问题，得重新设计 http-api，让它不再主动调分类 — 改动面比新建插件还大。

3. **顺序错误** — intent-router 的分类应该发生在攻击检测**之后**（避免攻击消息消耗一次 Qwen3-4B 调用）。让 intent-router 编排意味着它要先调 prompt-guard，违反"分类器不做攻击检测"的职责划分。

4. **领域混淆** — intent-router 的输出领域是 `{ LOCAL, CLOUD, REJECT }`（路由领域）。`SANITIZED` 是**工具领域**（tool realm），不是意图。把 SANITIZED 加进意图分类输出会让领域模型混乱。

### 3.3 候选合并 C：并入 `sanitizer-pipeline`？

**表面看合理**：sanitizer 已经实现 `sanitize` 和 `desanitize` 算法，让它自己 hook 到 agent-loop 做端到端脱敏，"算法 + 调用点合一"。

**为什么不行**：

1. **sanitizer 没有安全上下文** — 它不知道"这条消息是不是攻击"、"这个 session 的数据分类是什么"、"这条路由是 LOCAL 还是 CLOUD"。这些判断需要 prompt-guard / privacy-policy / intent-router 的输出。让 sanitizer 反过来调用它们，职责倒置。

2. **算法 vs 决策分离** — sanitizer-pipeline 应该保持**纯粹的算法层**：给它文本 + session mapping，返回脱敏/还原结果。它不应该知道"什么时候该脱敏" — 那是策略层的事。

3. **可替换性** — 以后可能换脱敏算法（比如用 NER 模型代替正则）。如果 sanitizer 同时承担 hook 编排，换算法就要动 hook 逻辑。保持分离，算法可独立替换。

### 3.4 候选合并 D：并入 `privacy-policy`？

**表面看合理**：privacy-policy 已经在做数据分类（`public/internal/confidential/secret`）和路由 REJECT 规则，让它同时管脱敏编排，"策略 + 执行"一体。

**为什么不行**：

1. **privacy-policy 是声明式策略** — 它读 JSON 策略文件，匹配 routing 规则，输出 verdict。它不应该知道"脱敏算法怎么调"、"agent/pre-step hook 长什么样"。策略层和处理层分离是安全架构的基本原则（参考 Bell-LaPadula 模型）。

2. **策略可被多个消费者用** — 不只是 input-guard，未来 web-search-guard、审计模块都可能要查 privacy-policy。让它承担 input-guard 的编排职责会让它变成一个只服务于 input-guard 的插件，失去通用性。

### 3.5 候选合并 E：扩展 http-api 到全局？

**表面看合理**：http-api 里已经有完整的脱敏逻辑（L385-L541），把它抽成通用函数、让 web UI 也调，"代码复用"。

**为什么不行**：

1. **http-api 是 transport 层** — 它应该只懂 HTTP 协议（解析 request、拼 SSE response），不应该注册 DSH 全局 hook。让 http-api 注册 `agent/pre-step`，等于让 HTTP 插件变成安全管线插件，领域越界。

2. **Web UI 不经过 http-api** — Web UI 走 `dsh-host-apiproxy`，是 DSH 官方的 RPC 路由。让 Web UI "也调 http-api" 等于让 Web UI 绕开 DSH 原生路由，违反 DSH 架构。

3. **CLI / SDK 也绕不过** — 未来任何新入口（WebSocket、gRPC、MQTT）都要调 http-api？每加一个入口就要记得"哦还要调一遍安全管线" — 这是漏掉的根源。

## 4. input-guard 的独特价值：**编排器 + 跨 hook 状态**

排除所有合并可能后，input-guard 的独立价值浮出水面：

### 4.1 价值 1：编排器角色

input-guard 是唯一一个**按顺序组合调用**其他安全服务的插件：

```typescript
// input-guard 的 agent/pre-step handler（伪代码）
const verdict1 = await ctx.promptGuard.checkInput(text, sessionId)
if (!verdict1.safe) return reject(verdict1.reason)

const verdict2 = ctx.privacyPolicy.matchRouting(text)
if (verdict2?.realm === 'REJECT') return reject('policy-reject')

const intent = await ctx.intentRouter.classify(text)
if (intent.category === 'REJECT') return reject('intent-reject')

if (intent.category === 'CLOUD') {
  const sanitized = await ctx.sanitizer.sanitize(text, { sessionId })
  messages = replaceLastUserMessage(messages, sanitized.sanitizedText)
  // 记录 sanitizationInfo，给 llm/stream 反脱敏用
  remember(sessionId, sanitized.replacements)
}

return { kind: 'enter', messages }
```

这个**顺序**是关键：攻击检测（最便宜、最可能阻断）→ 策略判定（纯查表）→ 意图分类（LLM 调用）→ 脱敏（正则替换）。每一步的输出决定要不要跑下一步。

这种"决策链"逻辑不属于任何一个子服务，**必须有一个编排者**。

### 4.2 价值 2：跨 hook 状态

input-guard 同时注册 `agent/pre-step`（正向）和 `llm/stream`（反向）。它需要维护一个**跨 hook 的状态**：

```
agent/pre-step 记录：sessionId → { replacements: N, mapping: {...} }
llm/stream 读取：sessionId → 决定是否 desanitize、用哪个 mapping
```

这个状态**不属于任何一个子服务**：
- prompt-guard 不管反脱敏
- sanitizer 自己不知道当前 step 是不是需要 desanitize（它只是算法）
- intent-router 不管输出方向

input-guard 是唯一一个**既看到正向、又看到反向**的插件，由它维护这个跨 hook 的映射关系最自然。

### 4.3 价值 3：所有入口统一覆盖

一旦 input-guard 注册了 `agent/pre-step` + `llm/stream` 全局 hook，**任何入口都自动受益**：

| 入口 | 路径 | 是否经过 input-guard |
|---|---|---|
| http-api (21017) | HTTP → agent-loop → `agent/pre-step` | ✅ |
| Web UI chat | apiproxy → agent-loop → `agent/pre-step` | ✅ |
| CLI `dsh chat` | CLI → agent-loop → `agent/pre-step` | ✅ |
| SDK | SDK → agent-loop → `agent/pre-step` | ✅ |
| 未来的 WebSocket / gRPC | transport → agent-loop → `agent/pre-step` | ✅ |

http-api 不再需要包含脱敏逻辑 — 它变薄，只做协议适配。**新增入口不再需要"记得调一遍安全管线"** — 只要接入 agent-loop，管线自动生效。

### 4.4 价值 4：可独立开关 / 替换 / 测试

- **开关**：可以 `DSH_EDGE_INPUT_GUARD=false` 关掉整个管线（debug 模式）而不影响子服务
- **替换**：未来想要不同的编排顺序（比如先分类再攻击检测），只改 input-guard，不动子服务
- **测试**：input-guard 的测试专注**编排逻辑**（顺序、短路、状态传递），子服务的测试专注**各自的算法**。职责清晰，不会互相污染

## 5. 插件规格

### 5.1 元数据

```typescript
export const name = 'input-guard'
export const inject = [
  'promptGuard',      // 攻击检测
  'privacyPolicy',    // 数据分类 / REJECT 策略
  'intentRouter',     // LOCAL / CLOUD 路由
  'sanitizer',        // PII 脱敏 / 反脱敏
  'auditLog',         // 审计日志
] as const
```

### 5.2 Config

```yaml
- id: input-guard
  name: '@deepseek-harness-edge-agent/dsh-edge-agent/input-guard'
  inject: [promptGuard, privacyPolicy, intentRouter, sanitizer, auditLog]
  config:
    enableInputGuard: !!js process.env.DSH_EDGE_INPUT_GUARD !== 'false'
    sanitizeLocalTraffic: false   # LOCAL 路径是否仍走脱敏（默认 false，LOCAL LLM 看到原文）
    rejectOnSanitizeFailure: true # 脱敏失败时 fail-closed（降级 LOCAL 还是阻断）
```

### 5.3 Hook 注册

```typescript
// 正向：每次 LLM 调用前
ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next) => {
  const decision = await next()          // 让默认 handler 先跑（组装 systemPrompt）
  if (decision.kind === 'reject') return decision
  if (!config.enableInputGuard) return decision
  
  const sessionId = agent.session.id
  const lastUserText = findLastUserText(decision.messages)
  if (!lastUserText) return decision
  
  // 1. 攻击检测（cheap reject）
  const attackCheck = await ctx.promptGuard.checkInput(lastUserText, sessionId)
  if (!attackCheck.safe) {
    await ctx.auditLog.log({ level: 'security', kind: 'input-guard.blocked.attack', ... })
    return { kind: 'reject', reason: attackCheck.reason }
  }
  
  // 2. 策略判定
  const policyRouting = ctx.privacyPolicy.matchRouting(lastUserText)
  if (policyRouting?.realm === 'REJECT') {
    await ctx.auditLog.log({ level: 'security', kind: 'input-guard.blocked.policy', ... })
    return { kind: 'reject', reason: 'privacy-policy-reject' }
  }
  
  // 3. 意图分类（决定 LOCAL/CLOUD）
  const intent = await ctx.intentRouter.classify(lastUserText)
  if (intent.category === 'REJECT') {
    return { kind: 'reject', reason: 'intent-reject' }
  }
  
  // 4. 脱敏（仅 CLOUD 路径，或显式开启 LOCAL）
  const shouldSanitize = intent.category === 'CLOUD' || config.sanitizeLocalTraffic
  let sanitizationInfo
  if (shouldSanitize) {
    try {
      const result = await ctx.sanitizer.sanitize(lastUserText, { sessionId })
      sanitizationInfo = { sessionId, replacements: result.replacements.length }
      const newMessages = replaceLastUserText(decision.messages, result.sanitizedText)
      await ctx.auditLog.log({ level: 'info', kind: 'input-guard.sanitized', ... })
      return { ...decision, messages: newMessages }
    } catch (err) {
      if (config.rejectOnSanitizeFailure) {
        return { kind: 'reject', reason: 'sanitizer-failed' }
      }
      // fail-open: 降级 LOCAL（不脱敏就不上云）
      // 这一步需要重新路由 — 简化处理：直接阻断让用户重试
      return { kind: 'reject', reason: 'sanitizer-unavailable' }
    }
  }
  
  return decision
}, { global: true })

// 反向：每次 LLM 响应流
ctx.on('llm/stream', (options, next) => {
  const stream = next()
  const info = currentStepSanitizationInfo  // 从 agent/session 状态读
  if (!info || info.replacements === 0) return stream
  
  return (async function* () {
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta' && chunk.text) {
        const restored = await ctx.sanitizer.desanitize(chunk.text, info.sessionId)
        yield { ...chunk, text: restored.text }
      } else {
        yield chunk
      }
    }
  })()
}, { global: true })
```

### 5.4 跨 hook 状态

```typescript
// 在 agent/session 上挂一个 weakmap，存当前 step 的 sanitization 状态
const stepSanitizationState = new WeakMap<Session, {
  replacements: number
  lastSanitizedAt: number
}>()

// agent/pre-step 写入
stepSanitizationState.set(agent.session, { replacements: N, lastSanitizedAt: Date.now() })

// llm/stream 读取
const info = stepSanitizationState.get(currentSession)
```

## 6. http-api 的瘦身

input-guard 上线后，http-api.ts 应该：

- **删除** L385-L488 的 `promptGuard.checkInput` / `privacyPolicy.matchRouting` / `sanitizer.sanitize` 调用
- **删除** L535-L545 的 `sanitizer.desanitize` 调用
- **保留** request 解析、SSE 响应组装、rate-limit（HTTP 层）、bearer token 验证
- **保留** intent-router 的**调用结果读取**（用来决定 HTTP 响应里的 intent 字段，但不做拦截）

预期 http-api.ts 减少 ~100 行代码，职责回到纯粹的 transport 层。

## 7. 测试策略

| 测试场景 | 验证点 |
|---|---|
| http-api `/v1/chat` 含 PII | agent/pre-step 触发 sanitize，session 存 desanitize 版 |
| Web UI chat 含 PII | 同上（证明 Web UI 自动受益）|
| CLI 输入含 PII | 同上（证明 CLI 自动受益）|
| 攻击输入（"忽略之前的指令"）| agent/pre-step reject，不消耗分类/脱敏算力 |
| secret 级数据 | privacy-policy reject |
| LOCAL 路由 | 不 sanitize（除非 `sanitizeLocalTraffic: true`）|
| sanitizer 抛错 | fail-closed reject（或降级，按配置）|
| 输出流 desanitize | LLM 返回 token，用户看到真实 PII |
| 多 step 对话 | 第 2 步的 llm/stream 仍能 desanitize（状态正确传递）|
| `enableInputGuard: false` | 全部 bypass，回到 http-api 自带逻辑或完全无防护 |

## 8. 风险与缓解

### 8.1 `agent/pre-step` 修改 messages 是否真的生效？

**已验证**：`dsh-agent-instructions` 插件用同一机制追加 user-role 消息到 decision.messages，下游 LLM 调用看到了追加内容。我们的替换操作是同级别的，应该可行。

**缓解**：先写一个最小可运行验证（只替换文本，不做安全逻辑），确认 LLM 真的看到修改版，再叠加上层逻辑。

### 8.2 `llm/stream` wrap 后，session 累积器用的是 wrapper 的 chunks 吗？

**已验证**：`dsh-agent-loop/lib/index.js:617-630` 显示 `for await (const chunk of stream)` 迭代的是 `llm.stream()` 的返回值，而 `llm.stream()` 走 `waterfall("llm/stream", ...)`。wrapper 修改过的 chunks 会被 session 累积并持久化。

**缓解**：同上，先做最小验证。

### 8.3 性能影响

每次 LLM 调用新增：
- `promptGuard.checkInput`：regex 部分 ~0.1ms；model detection ~1-2s（已有）
- `privacyPolicy.matchRouting`：~0.1ms（纯 JSON 查表）
- `intentRouter.classify`：~0.5-1s（LLM 调用，**已有** — http-api 本来就调）
- `sanitizer.sanitize`：~0.5ms（纯正则）

**总增量**：~1ms（除了已经存在的 model detection + intent classification）。可忽略。

### 8.4 与现有 http-api 脱敏逻辑的共存

input-guard 上线前，http-api 仍然有脱敏逻辑。过渡期可以：
1. 先上线 input-guard，但 `enableInputGuard: false`（默认）
2. E2E 验证 input-guard 行为正确
3. 切到 `enableInputGuard: true`
4. 删 http-api 里的冗余代码

## 9. 总结

**input-guard 的存在价值**：

1. **编排器** — 按正确顺序组合调用 prompt-guard / privacy-policy / intent-router / sanitizer
2. **跨 hook 状态** — 唯一同时看到正向（agent/pre-step）和反向（llm/stream）的插件
3. **所有入口统一** — 注册全局 hook 后，http-api / Web UI / CLI / SDK 自动受益，新增入口零成本
4. **职责纯粹** — 子服务保持单一职责（检测 / 策略 / 分类 / 算法），input-guard 专注编排
5. **http-api 瘦身** — transport 层回到 transport，安全管线上移到专用插件

**不能合入已有插件的根本原因**：已有插件都是**服务层**（接受调用，返回结果），input-guard 是**编排层**（主动调用多个服务，维护跨调用状态）。这两层不能混 — 混了会破坏子服务的纯粹性、可测试性、可替换性。

这是经典的**分层架构**原则：
- 服务层（services）= 叶子节点，做一件事
- 编排层（orchestrators）= 内部节点，组合服务
- 传输层（transports）= 边界，做协议适配

input-guard 是编排层，http-api 是传输层，prompt-guard / privacy-policy / intent-router / sanitizer 是服务层。各归其位。
