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
| `intent-router` | LLM 意图分类 → LOCAL/CLOUD 路由 | ✅ 可用 |
| `local-tools` | 本地工具（file_read/write/calculate） | ✅ 可用 |
| `http-api` | REST + SSE HTTP 服务器 | ✅ 可用 |
| `tcm` | 可信计算模块 | 🔲 桩 |
| `prompt-guard` | 输入/输出安全防护 | 🔲 桩 |
| `sanitizer-pipeline` | PII 脱敏/还原 | 🔲 桩 |
| `ohttp-gateway` | OHTTP 网关 | 🔲 桩 |
| `secure-bridge` | 端云安全通信桥 | 🔲 桩 |
| `attestation` | TEE 远程证明 | 🔲 桩 |
| `td-bus` | 威胁检测总线 | 🔲 桩 |
| `web-search` | 公网搜索 | 🔲 桩 |
| `voice-input` | 语音输入 | 🔲 桩 |
| `plugin-host` | 第三方插件宿主 | 🔲 桩 |

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

```bash
# 1. 把 dsh CLI 加入 PATH（如果用 npm-global 安装）
export PATH="$HOME/.npm-global/bin:$PATH"

# 2. 设置环境变量
export EDGE_API_KEY=test-secret-key                  # HTTP API 鉴权密钥
export DSH_EDGE_HTTP_PORT=21017                      # HTTP API 端口

# 3.（可选）CLOUD 路由需要 DeepSeek API Key
export DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx

# 4. 同步配置到 home profile（关键步骤！）
cp profiles/dsh-edge-agent/cordis.patch.yml ~/.dsh/profiles/dsh-edge-agent/

# 5. 启动
dsh --profile dsh-edge-agent

# 后台运行
setsid dsh --profile dsh-edge-agent > /tmp/dsh.log 2>&1 < /dev/null &
```

### LLM 路由机制

dsh-edge-agent 通过 **意图路由**自动选择 LLM，无需手动指定 provider：

| 用户消息类型 | 触发关键词 | 路由到 | 示例 |
|---|---|---|---|
| **LOCAL** | 文件、读取、写入、计算、设备、本地 | `local-qwen3-4b-mock` | `"帮我读取文件"` → `[LOCAL-MOCK] ...` |
| **CLOUD** | 解释、什么是、知识问答 | `cloud-deepseek-v4` | `"量子力学是什么"` → DeepSeek 真实回答 |

> ⚠️ `DSH_EDGE_PROVIDER` 环境变量**仅**影响 system prompt 文本，不会改变实际路由。
> 实际路由由 `http-api.handleChat()` 根据意图分类结果硬编码选择。

### 真实本地 LLM（可选 — 替换 mock）

如需使用真实的 llama.cpp 服务替代 mock：

```bash
# 启动 llama.cpp 服务（如 http://192.168.66.195:8701/v1）
export DSH_EDGE_LOCAL_LLM_MODE=real
export DSH_EDGE_LOCAL_LLM_BASEURL=http://192.168.66.195:8701/v1
export DSH_EDGE_LOCAL_LLM_MODEL=qwen3-4b
```

> 注意：需修改 `http-api.ts` 中的 `provider` 硬编码才能切换到真实本地 LLM。

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_HTTP_PORT` | `21017` | HTTP API 端口 |
| `EDGE_API_KEY` | — | API 鉴权密钥（无值则跳过认证） |
| `DSH_EDGE_PROVIDER` | `local-qwen3-4b-mock` | 仅用于 system prompt，不影响实际路由 |
| `DEEPSEEK_API_KEY` | — | DeepSeek API Key（CLOUD 路由必需） |
| `DSH_EDGE_LOCAL_LLM_MODE` | `mock` | local LLM 模式：`mock` 或 `real` |
| `DSH_EDGE_LOCAL_LLM_BASEURL` | `http://127.0.0.1:8080/v1` | 本地 LLM 端点（real 模式） |
| `DSH_EDGE_LOCAL_LLM_MODEL` | `qwen3-4b` | 本地 LLM 模型名 |
| `DSH_EDGE_STORAGE_ROOT` | `~/.dsh-edge-agent-m1` | 数据存储根目录 |

## 🧪 Curl 功能测试

> 假设服务器运行在 `http://127.0.0.1:21017`，API Key 为 `test-secret-key`。

### Health Check

```bash
curl http://127.0.0.1:21017/v1/health
```

```json
{"status":"ok","version":"0.1.0","provider":"local-qwen3-4b-mock"}
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
  "result": "[LOCAL-MOCK] Current runtime context...",
  "intent": {
    "category": "LOCAL",
    "targetRealm": "local",
    "confidence": 0.7,
    "rationale": "rule-keyword-match"
  },
  "duration": 25
}
```

> LOCAL intent 路由到本地 LLM（`local-qwen3-4b-mock`），不消耗云端 API 配额。

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
data: {"type":"chunk","content":"[LOCAL-"}

data: {"type":"chunk","content":"MOCK] "}

data: {"type":"chunk","content":"1+1等于几"}

data: {"type":"done"}
```

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

---

更多文档见 `docs/` 目录：[架构](docs/architecture.md) · [配置](docs/configuration.md) · [威胁模型](docs/threat-model.md) · [插件开发](docs/plugin-development.md) · [实施进度](docs/PROGRESS.md)

MIT License. 详见 [LICENSE](LICENSE)。
