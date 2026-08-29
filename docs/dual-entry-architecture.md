# dsh-edge-agent 双入口架构设计

**版本**：v1 (2026-08-29)
**适用范围**：dsh-edge-agent v0.1.0+
**关联文档**：[`input-guard-design.md`](./input-guard-design.md)、[`architecture.md`](./architecture.md)、[`plugin-architecture.md`](./plugin-architecture.md)、[`dsh-edge-agent-design.md`](./dsh-edge-agent-design.md)

---

## 1. TL;DR

dsh-edge-agent 同时对外暴露**两个 HTTP 入口**，明确分工：

| 入口 | 端口 | 协议 | 鉴权 | 目标用户 |
|---|---|---|---|---|
| **dsh-webui**（DSH 官方 Web UI） | `:21018` | SPA + apiproxy RPC + SSE | loopback trust + pairing | **人类 / 浏览器** |
| **http-api**（自研 REST） | `:21017` | REST + SSE + Bearer | Bearer token + body cap | **CLI / SDK / cURL / 外部 agent** |

两条入口**共享同一套 agent-loop 管线**（input-guard / prompt-guard / sanitizer / privacy-policy / audit-log / sessions / model-router / LLM adapters）。`input-guard` 挂在全局 hook 上，所以**所有入口自动获得隐私保护**。

```
                     ┌─────────────────────────────────┐
                     │   shared agent-loop + input-guard│
                     │   (privacy pipeline invariant)   │
                     └────────────────▲────────────────┘
                                      │
                  ┌───────────────────┴───────────────────┐
                  │                                       │
        ┌─────────┴─────────┐                 ┌───────────┴─────────┐
        │  dsh-webui(:21018)│                 │  http-api (:21017)  │
        │  browser / human  │                 │  CLI / SDK / cURL   │
        │  SPA + apiproxy   │                 │  REST + SSE + bearer│
        └───────────────────┘                 └─────────────────────┘
```

---

## 2. 背景：input-guard 决定两条入口是平行的

2026-08-29 合并的 `input-guard`（commit `eaec70b`）把 http-api 内的脱敏/防护逻辑**上移到 agent-loop 的全局 hook**：

- `agent/pre-step` — pre-flight prompt-guard + privacy-policy + intent-route + sanitize
- `agent/request` — sanitize failure → downgrade to LOCAL
- `llm/stream` — desanitize 占位符回 PII

这条 hook 链对所有走 agent-loop 的入口一视同仁：

| 入口 | 路径 | input-guard 覆盖 |
|---|---|---|
| dsh-webui | `dsh-host-apiproxy → agent-loop` | ✅ 自动 |
| http-api | `agent.followup → agent-loop` | ✅ 自动 |

这意味着双入口不是"两条不同的实现路径"，而是"两条不同的 transport + 一条共享的 agent 管线"。input-guard 的存在让双入口**安全对齐**成为自然结果。

---

## 3. 设计决策

### 3.1 主决策：明确分工（CONFIRM）

**采纳用户提出的分工**：

- 浏览器 / 真人用户 → dsh-webui（`@deepseek-ai/dsh-host-webserver` + `dsh-web-app` + `dsh-web-frontend` + `@linxin666/dsh-web-ui-all`）
- CLI / SDK / 外部 agent / cURL → http-api

### 3.2 鉴权模型不同

| 模型 | 适用 | 设计依据 |
|---|---|---|
| dsh-webui：loopback trust + pairing token | 浏览器用户，DSH 上游默认 | SPA 的 token 流转复杂；loopback 已提供边界；上游合约 |
| http-api：Bearer token + body cap（1 MiB） | 程序客户端，机器友好 | bearer 是机器调用的事实标准；body cap 防 OOM |

强行复用任一模型都会让另一端的体验崩坏。两套鉴权**互不交叉**。

### 3.3 接口风格不同

- **dsh-webui**：SPA + apiproxy RPC（SPA 通过 `dsh-host-apiproxy` 调 `sessions.list / prompt / cancel / fork / rename` 等 DSH 合约方法）。
- **http-api**：RESTful + SSE（人类熟悉 + 程序易测；SSE 15s keepalive 防代理切断）。

### 3.4 拒绝的替代方案

- **「合并到 dsh-webui」**：webui 是浏览器表面，bearer + cookie 模型不兼容机器调用。
- **「合并到 http-api」**：失去 DSH 原生 SPA（task-board / git-graph / pet / skin-center），违反 DSH 架构。
- **「webui 调 http-api 反向调用」**：绕过 DSH 原生 apiproxy，破坏 input-guard 的统一 hook 设计（input-guard-design.md §4.3 已否）。
- **「双入口共用同一端口」**：协议、鉴权、客户端形态完全不同，强行绑定会引入隐藏耦合。
- **「http-api 加 CORS 让 webui SDK 也走它」**：CORS 是 webui 的补救路径，不是主路径；先坚持 `dsh-host-apiproxy`。

---

## 4. 端口与协议

### 4.1 dsh-webui（`:21018`）

- **宿主**：`@deepseek-ai/dsh-host-webserver`
- **前端**：`dsh-web-app` + `dsh-web-frontend`（SPA）+ 可选 `@linxin666/dsh-web-ui-all`（task-board / git-graph / pet / skin-center 全家桶；**v1 默认 disable**）
- **后端桥**：`dsh-host-apiproxy`（DSH 上游，不在 dsh-edge-agent 仓库控制范围）
- **协议**：HTTP/1.1 + WebSocket（apiproxy）+ SSE（chat 流）
- **鉴权**：loopback trust；远端访问走 DSH 上游的配对 token 流程

### 4.2 http-api（`:21017`）

- **宿主**：`@deepseek-harness-edge-agent/dsh-edge-agent/http-api`（自研插件）
- **协议**：REST + SSE（chat 流）
- **鉴权**：Bearer token（`Authorization: Bearer <EDGE_API_KEY>`，环境变量注入）+ body cap（默认 1 MiB）
- **CORS**：**v1 不暴露**——`enableCors` 字段在 schema 中完全不出现（即便 `DSH_EDGE_HTTP_CORS=true` 也不生效）。理由：CORS 是 webui 补救路径，会引入 preflight 攻击面；程序客户端同主机调用不需要 CORS。**v2 再启用**（必须配 origin allowlist + `Vary: Origin`）。

### 4.3 端口冲突矩阵

| 端口 | 服务 | 冲突？ |
|---|---|---|
| `:21017` | http-api | — |
| `:21018` | dsh-host-webserver | — |
| `:21019+` | webui SPA 内部端口（dsh-web-app 内嵌静态资源） | — |

监听时使用 `127.0.0.1` 默认绑定（可通过 `DSH_EDGE_HTTP_HOST` / `DSH_EDGE_WEB_HOST` 改）。两端口**可同时监听**，互不阻塞。

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

**仅启用**：`dsh-host-webserver` + `dsh-host-apiproxy`（DSH 上游的 webui 最小集）。

### 9.2 SPA 通过 apiproxy 调 agent-loop，**不调 http-api**

DSH 上游 SPA 的 chat RPC（`sessions.prompt` / `sessions.list` / `sessions.cancel` / `sessions.fork` / `sessions.rename`）走 `dsh-host-apiproxy`，**绝不**绕道 http-api。这样：

- DSH 上游合约保持原样
- input-guard 的全局 hook 自动覆盖 SPA 路径（apiproxy → agent-loop）
- http-api 不需要承担 webui 兼容层

### 9.3 启用 webui 全家桶的代价

若未来启用 `@linxin666/dsh-web-ui-all`，需检查其 cordis patch 内部是否挂载 `sessions` 插件（已知风险 §10.1）。启用前**必须**：

1. grep bundle 内 `sessions` 配置
2. 确认 root 不覆盖我们的 `~/.dsh-edge-agent-m1/sessions/`
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

---

## 11. 路线图

### v1（本文档 — 已实施 2026-08-29）

- 13 个 must-have 项（见 plan §3.1）
- 无 CORS、无 UI、无工具/技能/文件端点
- `input-guard` 是双入口统一防护的基石
- `patch-surface` snapshot 不变（`inserts=0, 6 configOverrides, 7 disables`）

### v1.1

- CORS（必须配 origin allowlist）
- `/v1/tools/{list,invoke}` 端点
- `/v1/skills/{list,load}` 端点
- `/v1/files/{read,write}`（受限）

### v2

- WebSocket 升级 SSE
- 请求签名（HMAC over body）
- token rotation / multiple tokens
- 可选 GraphQL 适配层

---

## 12. 引用

- `docs/input-guard-design.md` — input-guard 编排器设计（双入口统一防护的依赖）
- `docs/architecture.md` — 整体架构
- `docs/plugin-architecture.md` — Cordis 插件机制
- `docs/dsh-edge-agent-design.md` — v6 设计文档
- `src/dsh-adapter/http-api.ts` — http-api 主插件
- `src/dsh-adapter/http-api-routes.ts` — 路由表
- `src/dsh-adapter/http-api-sessions.ts` — sessions 软依赖包装
- `src/dsh-adapter/input-guard.ts` — 双入口统一防护编排器
- `src/dsh-adapter/model-router.ts` — `listDetailed()` 实现
- `src/dsh-adapter/audit-log.ts` — `query()` 实现
- `profiles/dsh-edge-agent/cordis.patch.yml` — DSH 配置 patch
