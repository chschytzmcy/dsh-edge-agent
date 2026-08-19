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
| `local-llm-adapter` | 本地 LLM（mock + 真 llama.cpp） | ✅ 可用 |
| `model-router` | 多模型路由分发 | ✅ 可用 |
| `local-tools` | 本地工具（file_read/write/calculate） | ✅ 可用 |
| `http-api` | REST + SSE HTTP 服务器 | ✅ 可用 |
| `tcm` | 可信计算模块 | 🔲 桩 |
| `prompt-guard` | 输入/输出安全防护 | 🔲 桩 |
| `intent-router` | 意图分类 → Realm 路由 | 🔲 桩 |
| `sanitizer-pipeline` | PII 脱敏/还原 | 🔲 桩 |
| `ohttp-gateway` | OHTTP 网关 | 🔲 桩 |
| `secure-bridge` | 端云安全通信桥 | 🔲 桩 |
| `attestation` | TEE 远程证明 | 🔲 桩 |
| `td-bus` | 威胁检测总线 | 🔲 桩 |
| `web-search` | 公网搜索 | 🔲 桩 |
| `voice-input` | 语音输入 | 🔲 桩 |
| `plugin-host` | 第三方插件宿主 | 🔲 桩 |

> M 段（M0–M5）已全部完成，A 段安全加固均未开始。详见 [docs/PROGRESS.md](docs/PROGRESS.md)。

## 📦 安装

```bash
# 前置
npm install -g @deepseek-ai/dsh pnpm

# 克隆并安装
git clone https://github.com/chschytzmcy/dsh-edge-agent.git
cd dsh-edge-agent
pnpm install
./install.sh
```

## 🚀 部署

```bash
# 设置环境变量
export EDGE_API_KEY=test-secret-key
export DSH_EDGE_HTTP_PORT=3080
export DSH_EDGE_PROVIDER=local-qwen3-4b-mock   # mock 模式，无需 API Key

# 启动
dsh --profile dsh-edge-agent

# 后台运行
dsh --profile dsh-edge-agent > /tmp/dsh-edge-agent.log 2>&1 &
```

### LLM Provider 选择

```bash
# Mock 模式（测试用，无需 API Key）
export DSH_EDGE_PROVIDER=local-qwen3-4b-mock

# Cloud 模式（需 DeepSeek API Key）
export DEEPSEEK_API_KEY=sk-...
export DSH_EDGE_PROVIDER=cloud-deepseek-v4

# 本地真实 LLM（需 llama.cpp 服务）
export DSH_EDGE_PROVIDER=local-qwen3-4b
export DSH_EDGE_LOCAL_LLM_MODE=real
export DSH_EDGE_LOCAL_LLM_BASEURL=http://192.168.66.195:8701/v1
```

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_HTTP_PORT` | `3080` | HTTP API 端口 |
| `EDGE_API_KEY` | — | API 鉴权密钥 |
| `DSH_EDGE_PROVIDER` | `local-qwen3-4b-mock` | LLM 提供者 |
| `DEEPSEEK_API_KEY` | — | DeepSeek API Key（cloud 模式必需） |
| `DSH_EDGE_LOCAL_LLM_BASEURL` | `http://127.0.0.1:8080/v1` | 本地 LLM 端点 |
| `DSH_EDGE_STORAGE_ROOT` | `~/.dsh-edge-agent` | 数据存储根目录 |

## 🧪 Curl 功能测试

> 假设服务器运行在 `http://127.0.0.1:3080`，API Key 为 `test-secret-key`。

### Health Check

```bash
curl http://127.0.0.1:3080/v1/health
```

```json
{"status":"ok","version":"0.1.0","provider":"local-qwen3-4b-mock"}
```

### 认证测试

```bash
# 无 Token → 401
curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:3080/v1/chat \
  -H "Content-Type: application/json" -d '{"message":"hi"}'

# 错误 Token → 401
curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:3080/v1/chat \
  -H "Authorization: Bearer wrong-key" \
  -H "Content-Type: application/json" -d '{"message":"hi"}'

# 正确 Token → 200
curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:3080/v1/chat \
  -H "Authorization: Bearer test-secret-key" \
  -H "Content-Type: application/json" -d '{"message":"hi"}'
```

### Chat 同步

```bash
curl -X POST http://127.0.0.1:3080/v1/chat \
  -H "Authorization: Bearer test-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"message":"你好，请介绍一下自己","sessionId":"test-001"}'
```

```json
{
  "sessionId": "test-001",
  "result": "[LOCAL-MOCK] 你好，请介绍一下自己",
  "intent": {"category": "CLOUD"},
  "duration": 123
}
```

### Chat 流式（SSE）

```bash
curl -N -X POST http://127.0.0.1:3080/v1/chat/stream \
  -H "Authorization: Bearer test-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"message":"1+1等于几","sessionId":"test-002"}'
```

```
data: {"type":"chunk","content":"[LOCAL-"}

data: {"type":"chunk","content":"MOCK] "}

data: {"type":"chunk","content":"1+1等于几"}

data: {"type":"done"}
```

### 会话管理

```bash
# 列出所有会话
curl http://127.0.0.1:3080/v1/sessions \
  -H "Authorization: Bearer test-secret-key"

# 获取特定会话
curl http://127.0.0.1:3080/v1/sessions/test-001 \
  -H "Authorization: Bearer test-secret-key"

# 删除会话
curl -X DELETE http://127.0.0.1:3080/v1/sessions/test-001 \
  -H "Authorization: Bearer test-secret-key"
```

### OpenAPI Spec

```bash
curl http://127.0.0.1:3080/v1/openapi.json | jq .
```

---

更多文档见 `docs/` 目录：[架构](docs/architecture.md) · [配置](docs/configuration.md) · [威胁模型](docs/threat-model.md) · [插件开发](docs/plugin-development.md) · [实施进度](docs/PROGRESS.md)

MIT License. 详见 [LICENSE](LICENSE)。
