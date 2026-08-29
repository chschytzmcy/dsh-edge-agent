# dsh-edge-agent

> 边缘侧私密智能体 · 基于 DSH (DeepSeek Harness) Cordis 插件机制

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-blue)](package.json)

`dsh-edge-agent` 是一个面向用户的端侧私密智能体，基于 [DeepSeek Harness](https://github.com/deepseek-harness) 的 Cordis 插件机制构建。敏感数据默认留在设备端，仅在用户授权时通过零信任通道与云端通信。

## ✨ 核心特性

- **🔒 端侧优先**：默认本地 LLM 处理，云端仅在明确需要时调用
- **🛡️ 隐私保护**：AES-256-GCM 加密存储、TEE 密钥管理、PII 自动脱敏
- **🌐 零信任通信**：RFC 9458 OHTTP 协议，云端无法关联用户身份与请求
- **🚨 威胁检测**：实时监控异常行为，自动隔离可疑流量
- **🔌 插件化**：19 核心 + 1 可选 HTTP API，全部 subpath 导出

## 🏗️ 架构

### 四层架构

```
┌───────────────────────────────────────────────┐
│ Layer 4: 用户交互（CLI / HTTP API / 语音）     │
├───────────────────────────────────────────────┤
│ Layer 3: Agent 层（DSH Agent Loop）            │
│   agents, llm, tools, sessions                │
├───────────────────────────────────────────────┤
│ Layer 2: 隐私控制                              │
│   intent-router, prompt-guard, sanitizer      │
│   privacy-policy, audit-log, td-bus           │
├───────────────────────────────────────────────┤
│ Layer 1: 安全基础                              │
│   tcm, local-storage, attestation             │
│   ohttp-gateway, secure-bridge                │
└───────────────────────────────────────────────┘
```

### Realm 数据模型

| Realm | 数据流向 | 安全等级 |
|---|---|---|
| **LOCAL** | 完全在设备端 | 最高 |
| **SANITIZED** | PII 替换后上云 | 中等 |
| **CLOUD** | 原始数据上云（用户授权） | 最低 |

### 插件体系

单包多 subpath 架构，所有插件从 `@deepseek-harness-edge-agent/dsh-edge-agent` 导出：

| 插件 | 职责 | 状态 |
|---|---|---|
| `local-storage` | JSONL 持久化 KV 存储 | ✅ 可用 |
| `sessions` | 会话管理（CRUD + TTL + LRU） | ✅ 可用 |
| `audit-log` | JSONL 审计日志 | ✅ 可用 |
| `cloud-llm-adapter` | DeepSeek API 流式客户端 | ✅ 可用 |
| `local-llm-adapter` | 本地 LLM（OpenAI 兼容端点直连） | ✅ 可用 |
| `model-router` | 多模型路由分发 | ✅ 可用 |
| `intent-router` | LLM 意图分类 → LOCAL/CLOUD 路由 | ✅ 可用 |
| `http-api` | REST + SSE HTTP 服务器 | ✅ 可用 |
| `tools` | Realm 工具注册表配置 | ✅ 可用 |
| `tcm` | 可信计算模块 | 🔲 桩 |
| `prompt-guard` | 输入/输出安全防护 | 🔲 桩 |
| `sanitizer-pipeline` | PII 脱敏/还原 | 🔲 桩 |
| `ohttp-gateway` | OHTTP 网关 | 🔲 桩 |
| `secure-bridge` | 端云安全通信桥 | 🔲 桩 |
| `attestation` | TEE 远程证明 | 🔲 桩 |
| `td-bus` | 威胁检测总线 | 🔲 桩 |
| `voice-input` | 语音输入 | 🔲 桩 |
| `plugin-host` | 第三方插件宿主 | 🔲 桩 |

> **工具复用**: dsh-edge-agent 使用 DSH 原生工具（bash、read/write/edit、web_search/web_fetch），而非自行实现。详见 [docs/dsh-native-tools-analysis.md](docs/dsh-native-tools-analysis.md)。
>
> M 段（M0–M5）已全部完成，意图识别（LOCAL/CLOUD）路由已端到端打通。A 段安全加固均未开始。详见 [docs/PROGRESS.md](docs/PROGRESS.md)。

## 📦 安装

### 快速安装（推荐）

```bash
# 前置：dsh CLI + pnpm
npm install -g @deepseek-ai/dsh pnpm

# 克隆并一键安装
git clone https://github.com/chschytzmcy/dsh-edge-agent.git
cd dsh-edge-agent
pnpm install
./install.sh
```

### 详细安装（单命令逐步执行）

```bash
# 1. 安装 dsh CLI（DeepSeek Harness 官方客户端）
npm install -g @deepseek-ai/dsh

# 2. 安装 pnpm 包管理器
npm install -g pnpm

# 3. 克隆仓库
git clone https://github.com/chschytzmcy/dsh-edge-agent.git
cd dsh-edge-agent

# 4. 安装项目依赖
pnpm install

# 5. 编译 TypeScript
pnpm run compile

# 6. 运行验证（确保所有插件形状正确）
pnpm run verify:build

# 7. 运行单元测试（16 个测试文件）
pnpm test

# 8. 将插件安装到 DSH profile
#    这会自动创建 ~/.dsh/profiles/dsh-edge-agent/ 并注入所有插件
dsh plugin --profile dsh-edge-agent add @deepseek-harness-edge-agent/dsh-edge-agent

# 9. 验证 profile 已创建
ls ~/.dsh/profiles/dsh-edge-agent/

# 10. 启动服务
dsh --profile dsh-edge-agent
```

## 🚀 部署

### 方式一：使用 `.env.sh` 加载器（推荐）

⚠️ **DSH 限制**：`.env` 不能直接放进 `node --env-file=.env`，DSH 会拒绝加载「进程启动敏感」变量（如 `DSH_EDGE_HTTP_PORT`、`DSH_EDGE_LOCAL_LLM_BASEURL`）。因此使用 `.env.sh` 加载器，它只把安全变量放入 `.env`，其他变量由加载器 export。

```bash
# 1. 把 dsh CLI 加入 PATH（如果用 npm-global 安装）
export PATH="$HOME/.npm-global/bin:$PATH"

# 2. 复制环境变量模板并填写
cp .env.example .env
$EDITOR .env   # 填入 DEEPSEEK_API_KEY、EDGE_API_KEY 等

# 3. 同步 cordis 配置（关键步骤！）
cp profiles/dsh-edge-agent/cordis.patch.yml ~/.dsh/profiles/dsh-edge-agent/

# 4. 启动（.env.sh 自动 export 所有 DSH_EDGE_* 变量）
source .env.sh && dsh --profile dsh-edge-agent

# 后台运行
setsid bash -c 'source .env.sh && dsh --profile dsh-edge-agent' > /tmp/dsh.log 2>&1 < /dev/null &
```

`.env.sh` 会打印加载的变量（脱敏）便于调试。

### 方式二：手动 export（CI / 临时调试）

```bash
export PATH="$HOME/.npm-global/bin:$PATH"

# 业务变量（可以放在 .env 里用 set -a 加载）
export EDGE_API_KEY=test-secret-key
export DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx

# DSH_EDGE_* 必须是 export（不能放进 .env）
export DSH_EDGE_HTTP_PORT=21017
export DSH_EDGE_PROVIDER=cloud-deepseek-v4
export DSH_EDGE_MODEL=deepseek-chat
export DSH_EDGE_LOCAL_LLM_MODE=real
export DSH_EDGE_LOCAL_LLM_BASEURL=http://192.168.66.195:8701/v1
export DSH_EDGE_LOCAL_LLM_MODEL=qwen3-4b-instruct-2507

cp profiles/dsh-edge-agent/cordis.patch.yml ~/.dsh/profiles/dsh-edge-agent/

dsh --profile dsh-edge-agent
```

### 完整环境变量

详见 [.env.example](.env.example)。`.env` 文件已加入 `.gitignore`，**切勿提交含真实 Key 的 `.env`**。

### LLM 路由机制

dsh-edge-agent 通过 **意图路由**自动选择 LLM，无需手动指定 provider：

| 用户消息类型 | 触发关键词 | 路由到 | 示例 |
|---|---|---|---|
| **LOCAL** | 文件、读取、写入、计算、设备、本地 | `local-qwen3-4b`（真实 OpenAI 兼容端点） | `"帮我读取文件"` → 真实 qwen3-4b 回答 |
| **CLOUD** | 解释、什么是、知识问答 | `cloud-deepseek-v4` | `"量子力学是什么"` → DeepSeek 真实回答 |

> ⚠️ `DSH_EDGE_PROVIDER` 环境变量**仅**影响 system prompt 文本，不会改变实际路由。
> 实际路由由 `http-api.handleChat()` 根据意图分类结果硬编码选择。

### 本地 LLM 端点

`local-llm-adapter` 始终走真实 OpenAI 兼容端点（默认 `http://127.0.0.1:8080/v1`）。
通过环境变量指向任一 llama.cpp / vLLM / Ollama 实例：

```bash
# .env.sh 中：
export DSH_EDGE_LOCAL_LLM_BASEURL=http://192.168.66.195:8701/v1
export DSH_EDGE_LOCAL_LLM_MODEL=qwen3-4b-instruct-2507
```

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `EDGE_API_KEY` | — | API 鉴权密钥（无值则跳过认证） |
| `DSH_EDGE_HTTP_PORT` | `21017` | HTTP API 端口 |
| `DSH_EDGE_PROVIDER` | `cloud-deepseek-v4` | 仅用于 system prompt，不影响实际路由 |
| `DSH_EDGE_MODEL` | `deepseek-chat` | 仅用于 system prompt |
| `DEEPSEEK_API_KEY` | — | DeepSeek API Key（CLOUD 路由必需） |
| `DSH_EDGE_LOCAL_LLM_BASEURL` | `http://127.0.0.1:8080/v1` | 本地 LLM 端点 |
| `DSH_EDGE_LOCAL_LLM_MODEL` | `qwen3-4b` | 本地 LLM 模型名 |
| `DSH_EDGE_INTENT_PROVIDER` | `local-qwen3-4b` | 意图分类所用 provider |
| `DSH_EDGE_INTENT_MODEL` | `qwen3-4b` | 意图分类所用模型 |
| `DSH_EDGE_STORAGE_ROOT` | `~/.dsh-edge-agent-m1` | 数据存储根目录 |

> **Secret 警告**：`DEEPSEEK_API_KEY`、`EDGE_API_KEY` 是 secret，**绝不能提交到 git**。
> 使用 `.env` 文件（已加入 `.gitignore`）+ `dsh --env-file=.env` 启动。

## 🌐 多入口架构

dsh-edge-agent 对外暴露**三个用户入口**，明确分工，互不替代：

| 入口 | 端口 | 鉴权 | 目标用户 |
|---|---|---|---|
| **DSH 官方 Web UI**（SPA + apiproxy） | `:21018` | loopback trust + pairing | 浏览器 / 真人用户 |
| **dsh-im**（IM 聊天软件通道网关） | (无新端口) | QR / bot credentials / AI Office Device Token | 移动端聊天软件用户 |
| **http-api**（自研 REST + SSE） | `:21017` | Bearer token + body cap | CLI / SDK / cURL / 外部 agent |

三条入口**共享同一套 agent-loop 管线**（含 input-guard / prompt-guard / sanitizer / privacy-policy / audit-log / sessions）。`input-guard` 挂在全局 hook 上，所以**所有入口自动获得隐私保护**——无论用户从 webui、IM 还是 cURL 进入，agent-loop 内的脱敏与降级行为完全一致。

### 浏览器用户 → `:21018`

打开浏览器访问 `http://127.0.0.1:21018`，使用 DSH 官方 Web UI（chat / task-board / pet 等）。鉴权由 DSH 上游的配对 token 流程处理。

### IM 聊天用户 → 飞书 / 微信 / 钉钉 / 企业微信 / QQ / Slack / Telegram / Discord / WhatsApp

dsh-im 插件（`@xmanrui/dsh-im`）通过 webserver 内部 `apiProxy` 把 IM 消息接入 agent-loop——**不监听新端口**，自动继承 input-guard 隐私管线。

启用步骤：

1. 在浏览器访问 `http://127.0.0.1:21018`，打开 **设置 → IM机器人** 页面
2. 选择渠道，按页面提示**扫码**或粘贴 App ID / Secret / Bot Token 等凭据
3. 凭据仅写入 `dsh-credentials-local` 受保护本地存储，配置文件不落盘
4. 启用后，IM 私聊 / 群消息会自动路由到 agent-loop（流式思考 / 工具执行进度 / 最终回答均原生渠道展示）

支持的 IM 渠道：飞书（WebSocket + 流式卡片）/ 微信（iLink 长轮询）/ 钉钉（Stream + AI Card）/ 企业微信（WebSocket + 「思考中」）/ QQ（WebSocket）/ Slack（Socket Mode）/ Telegram（Bot API + Rich Draft）/ Discord（Gateway v10 + 原生 Thread）/ WhatsApp（WhatsApp Web）+ **AI Office Connector**（公网 HTTPS 心跳 + SSE 下行）。

> **⚠️ AI Office 风险**：AI Office Connector 让本机 Harness **主动**连接公网 Office（不需公网 IP / 端口转发），但 SSE 下行的增量文本会回到公网 Office。**只在用户主动启用**后生效（v1.1 起 webui 提供 opt-in 对话框）。

> **⚠️ 凭据安全**：所有 IM 平台 bot credentials 只入 `dsh-credentials-local`，RPC 响应不回传原始凭据。详见 `docs/dual-entry-architecture.md` §10.4。

### 程序客户端 → `:21017`

### 程序客户端 → `:21017`

CLI / SDK / cURL 调用自研 REST API：

```bash
# 健康检查（无需鉴权）
curl http://127.0.0.1:21017/v1/health

# 鉴权 + 同步 chat
curl -X POST http://127.0.0.1:21017/v1/chat \
  -H "Authorization: Bearer $EDGE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"message": "你好"}'

# 流式 chat (SSE，15s keepalive 防代理切断)
curl -N -X POST http://127.0.0.1:21017/v1/chat/stream \
  -H "Authorization: Bearer $EDGE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"message": "你好"}'

# 列出 / 查询 / 取消 / 重命名 / fork / 删除 会话
curl -H "Authorization: Bearer $EDGE_API_KEY" \
  http://127.0.0.1:21017/v1/sessions
curl -H "Authorization: Bearer $EDGE_API_KEY" \
  http://127.0.0.1:21017/v1/sessions/{id}
curl -X POST -H "Authorization: Bearer $EDGE_API_KEY" \
  http://127.0.0.1:21017/v1/sessions/{id}/cancel
curl -X POST -H "Authorization: Bearer $EDGE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title": "新标题"}' \
  http://127.0.0.1:21017/v1/sessions/{id}/rename
curl -X POST -H "Authorization: Bearer $EDGE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}' \
  http://127.0.0.1:21017/v1/sessions/{id}/fork
curl -X DELETE -H "Authorization: Bearer $EDGE_API_KEY" \
  http://127.0.0.1:21017/v1/sessions/{id}

# 元数据：可用模型 + 审计日志
curl -H "Authorization: Bearer $EDGE_API_KEY" \
  http://127.0.0.1:21017/v1/models
curl -H "Authorization: Bearer $EDGE_API_KEY" \
  "http://127.0.0.1:21017/v1/audit?limit=20&kind=http.chat.start"

# OpenAPI 3.0 规范（无需鉴权）
curl http://127.0.0.1:21017/v1/openapi.json
```

完整接口规范详见 [`docs/dual-entry-architecture.md`](docs/dual-entry-architecture.md)（v1.1 起文档同时覆盖三入口，但文件名保留以保持 GitHub 链接稳定）。

> **⚠️ 鉴权约定**：
> - **http-api**：Bearer token 必须从环境变量 `EDGE_API_KEY` 注入；**不要硬编码**到配置文件。生产环境使用 secret manager。
> - **dsh-im**：IM 平台 bot credentials 走 webui「设置 → IM机器人」页面，凭据**只入 `dsh-credentials-local`**。配置文件不落盘。
> - **dsh-webui**：loopback trust + DSH 上游配对 token 流程。

> **⚠️ CORS**：v1 不启用 CORS（`enableCors` 字段在 schema 中完全不暴露）。程序端请同主机调用；若需要从浏览器直接调用 http-api，请改用 `:21018` 的官方 Web UI。

## 🧪 手动测试

> 假设服务器运行在 `http://127.0.0.1:21017`，API Key 为 `test-secret-key`。

### 启动服务

```bash
# 方式 1: 使用启动脚本（推荐）
./scripts/launch-dev.sh

# 方式 2: 手动启动
source .env.sh
dsh --profile dsh-edge-agent

# 方式 3: 后台运行
setsid bash -c 'source .env.sh && dsh --profile dsh-edge-agent' > /tmp/dsh.log 2>&1 < /dev/null &
```

### Health Check

```bash
curl http://127.0.0.1:21017/v1/health
```

```json
{"status":"ok"}
```

### 认证测试

```bash
# 无 Token → 401
curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:21017/v1/chat \
  -H "Content-Type: application/json" -d '{"message":"hi"}'

# 错误 Token → 401
curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:21017/v1/chat \
  -H "Authorization: Bearer wrong-key" \
  -H "Content-Type: application/json" -d '{"message":"hi"}'

# 正确 Token → 200
curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:21017/v1/chat \
  -H "Authorization: Bearer test-secret-key" \
  -H "Content-Type: application/json" -d '{"message":"hi"}'
```

### Chat 同步

#### LOCAL Intent（本地处理 — 文件操作、计算）

```bash
curl -X POST http://127.0.0.1:21017/v1/chat \
  -H "Authorization: Bearer test-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"message":"帮我读取文件","sessionId":"test-local"}'
```

```json
{
  "sessionId": "test-local",
  "result": "请提供您想要我读取的文件路径，以便我帮您获取其内容。",
  "intent": {
    "category": "LOCAL",
    "targetRealm": "local",
    "confidence": 0.7,
    "rationale": "rule-keyword-match"
  },
  "duration": 940
}
```

> LOCAL intent 路由到本地 LLM（`local-qwen3-4b`），直连真实 OpenAI 兼容端点（不消耗云端 API 配额）。

#### CLOUD Intent（云端处理 — 知识问答、创意）

```bash
curl -X POST http://127.0.0.1:21017/v1/chat \
  -H "Authorization: Bearer test-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"message":"用一句话介绍量子力学","sessionId":"test-cloud"}'
```

```json
{
  "sessionId": "test-cloud",
  "result": "量子力学是研究微观粒子（如原子、电子、光子）运动规律的理论，其核心在于粒子状态由波函数描述，观测结果具有概率性，且存在波粒二象性、叠加与纠缠等现象。",
  "intent": {
    "category": "CLOUD",
    "targetRealm": "cloud",
    "confidence": 0.5,
    "rationale": "default:cloud"
  },
  "duration": 1575
}
```

> CLOUD intent 路由到 `cloud-deepseek-v4`，需要 `DEEPSEEK_API_KEY` 环境变量。

### 工具调用测试

dsh-edge-agent 使用 DSH 原生工具，所有工具都通过模型自动调用。

#### Bash 工具（本地命令执行）

```bash
curl -X POST http://127.0.0.1:21017/v1/chat \
  -H "Authorization: Bearer test-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"message":"帮我计算 17*23","sessionId":"test-bash"}'
```

模型会调用 `bash` 工具执行 `echo $((17*23))`，返回计算结果。

#### 文件工具（读/写/编辑）

```bash
# 读取文件
curl -X POST http://127.0.0.1:21017/v1/chat \
  -H "Authorization: Bearer test-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"message":"读取 /tmp/test.txt 文件内容","sessionId":"test-file-read"}'

# 写入文件
curl -X POST http://127.0.0.1:21017/v1/chat \
  -H "Authorization: Bearer test-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"message":"在 /tmp 创建 hello.txt，内容是 Hello World","sessionId":"test-file-write"}'

# 编辑文件
curl -X POST http://127.0.0.1:21017/v1/chat \
  -H "Authorization: Bearer test-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"message":"将 /tmp/hello.txt 中的 Hello 改为 Hi","sessionId":"test-file-edit"}'
```

#### Web 搜索工具（DeepSeek 搜索引擎）

```bash
curl -X POST http://127.0.0.1:21017/v1/chat \
  -H "Authorization: Bearer test-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"message":"搜索 DeepSeek V4 模型的最新消息","sessionId":"test-web-search"}'
```

模型会调用 `web_search` 工具，返回搜索结果摘要。

#### Web 获取工具（抓取网页内容）

```bash
curl -X POST http://127.0.0.1:21017/v1/chat \
  -H "Authorization: Bearer test-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"message":"获取 https://example.com 的网页内容","sessionId":"test-web-fetch"}'
```

模型会调用 `web_fetch` 工具，返回网页内容摘要。

### Intent 分类规则

| 关键词触发 LOCAL | 默认 / 知识类 → CLOUD |
|---|---|
| 文件、读取、写入、删除、计算、加减乘除 | 解释、什么是、如何、为什么 |
| 本地、设备、系统、磁盘、目录、文件夹 | 你好、介绍、帮我写 |
| file, read, write, delete, calculate | 量子、相对论、Python |

分类流程：先用本地 Qwen3-4B 判断 → 失败时降级到关键词规则。

### Chat 流式（SSE）

```bash
curl -N -X POST http://127.0.0.1:21017/v1/chat/stream \
  -H "Authorization: Bearer test-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"message":"1+1等于几","sessionId":"test-002"}'
```

```
data: {"type":"intent","intent":{"category":"CLOUD","targetRealm":"cloud","confidence":0.85,"rationale":"llm-classified:cloud"}}

data: {"type":"text","text":"1"}

data: {"type":"text","text":"+1"}

data: {"type":"text","text":"=2"}

data: {"type":"done"}
```

> SSE 流式响应。帧类型：
> - `intent` — 首帧，携带意图分类结果
> - `text` — 文本增量片段
> - `done` — 结束帧

### 会话管理

```bash
# 列出所有会话
curl http://127.0.0.1:21017/v1/sessions \
  -H "Authorization: Bearer test-secret-key"

# 获取特定会话
curl http://127.0.0.1:21017/v1/sessions/test-001 \
  -H "Authorization: Bearer test-secret-key"

# 删除会话
curl -X DELETE http://127.0.0.1:21017/v1/sessions/test-001 \
  -H "Authorization: Bearer test-secret-key"
```

### OpenAPI Spec

```bash
curl http://127.0.0.1:21017/v1/openapi.json | jq .
```

## 🧪 自动化测试

### 单元测试（99 个测试用例）

```bash
pnpm test
```

覆盖 16 个测试文件，包括：
- 插件形状验证（name/inject/Config/apply）
- SSE 解析、JSONL 持久化、HTTP 路由
- 意图分类（LLM + 规则兜底）
- 会话管理、审计日志

### 构建验证

```bash
pnpm run verify:build
```

包含 4 个验证脚本：
- `verify:boundary` — 适配器边界检查（`@deepseek-ai/*` 仅存在于 `src/dsh-adapter/`）
- `verify:contract` — 上游版本契约（锁定 `0.1.0-rc.6`）
- `verify:patch-surface` — 补丁面一致性
- `verify:plugin-spec` — 插件规范（name+inject+Config+apply）

---

更多文档见 `docs/` 目录：[架构](docs/architecture.md) · [配置](docs/configuration.md) · [威胁模型](docs/threat-model.md) · [插件开发](docs/plugin-development.md) · [实施进度](docs/PROGRESS.md)

MIT License. 详见 [LICENSE](LICENSE)。
