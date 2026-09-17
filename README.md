# dsh-edge-agent

> 边缘侧私密智能体 · 基于 DSH (DeepSeek Harness) Cordis 插件机制

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-blue)](package.json)

`dsh-edge-agent` 是一个面向用户的端侧私密智能体，基于 [DeepSeek Harness](https://github.com/deepseek-harness) 的 Cordis 插件机制构建。敏感数据默认留在设备端，仅在用户授权时通过零信任通道与云端通信。

## ✨ 核心特性

- **🔒 端侧优先**：默认本地 LLM 处理，云端仅在明确需要时调用
- **🛡️ 隐私保护**：PII 自动脱敏 + 隐私策略热重载（[AES-256-GCM 加密存储](./docs/PROGRESS.md#planned)）
- **🌐 零信任通信**：RFC 9458 OHTTP 协议，云端无法关联用户身份与请求
- **🚨 威胁检测**：实时监控异常行为，自动隔离可疑流量
- **🔌 插件化**：22 核心 + 1 可选 HTTP API，全部 subpath 导出

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
| `prompt-guard` | 输入/输出安全防护（正则 + LLM 兜底，rejection 翻译） | ✅ 可用 |
| `sanitizer-pipeline` | PII 脱敏/还原（9 规则，fail-open） | ✅ 可用 |
| `ohttp-gateway` | OHTTP 网关 | 🔲 桩 |
| `secure-bridge` | 端云安全通信桥 | 🔲 桩 |
| `attestation` | TEE 远程证明 | 🔲 桩 |
| `td-bus` | 威胁检测总线（速率/脱敏/权限阈值告警） | ✅ 可用 |
| `voice-input` | 语音输入 | 🔲 桩 |
| `plugin-host` | 第三方插件宿主 | 🔲 桩 |

> **工具复用**: dsh-edge-agent 使用 DSH 原生工具（bash、read/write/edit、web_search/web_fetch），而非自行实现。详见 [docs/architecture.md](docs/architecture.md)。
>
> M 段（M0–M5）已全部完成，意图识别（LOCAL/CLOUD）路由已端到端打通；A1（input-guard 编排器）与 A2（rejection → HTTP 400/403/503 翻译）已完成。A3+ 安全加固未开始。详见 [docs/PROGRESS.md](docs/PROGRESS.md)。

---

## 📦 安装

### 系统要求

| 组件 | 最低版本 | 推荐版本 |
|---|---|---|
| Node.js | `^22.19` 或 `>=24` | `>=22.20` |
| pnpm | `^10` 或 `^11` | `^11.7.0` |
| 操作系统 | Linux / macOS / Windows | Linux |
| 架构 | x64 / arm64 | arm64（for TEE） |

### 前置依赖

```bash
# 1. DSH CLI（DeepSeek Harness 官方客户端）
npm install -g @deepseek-ai/dsh
dsh --version   # 验证

# 2. pnpm
npm install -g pnpm
# 或：corepack enable pnpm
pnpm --version   # 验证

# 3.（可选）TEE 开发环境
# 仅当需要在真实 TEE 上运行时需要：
#   ARM TrustZone  → 支持 TrustZone 的设备上编译 OP-TEE
#   RISC-V Keystone → RISC-V 工具链
#   Intel SGX       → Intel SGX SDK
# 脚手架阶段可用 simulated 后端，无需真实 TEE。
```

### 方式一：从源码构建（推荐开发者）

```bash
git clone https://github.com/chschytzmcy/dsh-edge-agent.git
cd dsh-edge-agent

pnpm install
pnpm run compile

# §7.43 (2026-09-11): 默认只同步不启动；用 --with= 显式启。
./install.sh                            # 默认：只同步 dsh-tui + web，不启动（已运行的进程保持）
./install.sh --with                     # 同步 + 启动 dsh-tui + web（并存）
./install.sh --with=web                 # 同步两个 + 只启动 web
./install.sh --with=tui                 # 同步两个 + 只启动 dsh-tui
./install.sh --with=web,tui             # 同步两个 + 都启
./install.sh --profiles=dsh-tui         # 只同步 dsh-tui（不启）

# 手动启动某个 profile（开发循环）
cd ~/.dsh/profiles/dsh-tui
setsid nohup dsh --profile dsh-tui > run.log 2>&1 < /dev/null &
disown
```

### 方式二：把 bundle 装到现有 dsh-tui / web profile（profile-agnostic）

新 install.sh 把 bundle 同步到所有目标 profile 的嵌套包 + 重启对应 dsh：

```bash
# 默认：并存部署 dsh-tui + web
./install.sh

# 只装一个
./install.sh --profiles=web

# §7.61 项目自有 headless profile(无 UI,HTTP-only 入口 :21019)
./install.sh --profiles=dsh-edge --with=dsh-edge

# 装任意自定义 profile
./install.sh --profiles=my-edge
```

> bundle 是 profile-agnostic 的——`--profiles=` 接受任何 DSH profile 名（dsh-tui / web / dsh-edge / 自定义）。端口在 install.sh 里的 `port_for_profile()` 映射（现役登记：dsh-tui 21018 / web 21017 / dsh-edge 21019），未来加新 profile 必须在那里同步登记。

### 方式三：Windows

```cmd
:: PowerShell 或 cmd
:: （Windows 上 dsh CLI 行为一致；具体启动命令参考 DSH 官方 Windows 文档）
dsh plugin --profile dsh-tui add @deepseek-harness-edge-agent/dsh-edge-agent
:: 或装到任意 profile：dsh plugin --profile <name> add @deepseek-harness-edge-agent/dsh-edge-agent
:: §7.43: 想并存启动 dsh-tui + web 用 ./install.sh
```

### 首次启动流程

首次运行 `install.sh`（默认 `--profiles=dsh-tui,web`）会执行：

1. 检测 dsh CLI / pnpm 是否已安装
2. `dsh plugin add @deepseek-harness-edge-agent/dsh-edge-agent` 注册本 bundle 到每个目标 profile 的 `dsh.profile.bundles` 列表
3. pnpm 装 7 个上游包（dsh-agent-loop / dsh-tool-web / dsh-web / dsh-web-search-deepseek / dsh-skill / dsh-tool-skill / dsh-skill-filesystem）— 每个 profile 各装一次
4. rsync `lib/` → profile 嵌套包
5. 同步 `cordis.patch.yml` 到嵌套包（**bundle-level patch**，§7.31 fix）
6. 数据面单 root `~/.dsh-edge-agent/`（§7.36 起各 profile 共享，历史上"6 个 channel 目录按 profile 分根"的说法已废；§7.61 唯一例外：dsh-edge 的审计流经 profile skin 单独落 `~/.dsh-edge-agent/audit-dsh-edge/`，规避多进程并发 flush 的整文件读-改-写竞争）
7. 加载默认策略 `tests/fixtures/privacy-policy.json`（也可由 `DSH_EDGE_PRIVACY_POLICY_PATH` 覆盖）
8. 顺序启动 dsh-tui (port 21018) → web (port 21017)：每个 profile 独立 pkill → port-wait → nohup launch

完成后 TUI 进入终端交互；浏览器访问 `:3080` 即可使用 webui chat。

### 验证安装

```bash
# 1. bundle 已注册到 dsh-tui 和 web profile？
grep '@deepseek-harness-edge-agent/dsh-edge-agent' ~/.dsh/profiles/dsh-tui/package.json
grep '@deepseek-harness-edge-agent/dsh-edge-agent' ~/.dsh/profiles/web/package.json

# 2. 19 个 plugin 全部挂载？
dsh --profile dsh-tui --dump-config | grep -E 'input-guard|file-logger|intent-router|sanitizer' | wc -l
# 期望：≥4

# 3. 双 profile 并存运行？
pgrep -af 'dsh --profile (dsh-tui|web)' | grep -v pgrep
ss -tlnp | grep -E '21017|21018'   # 期望：两个端口都在听

# 4. http-api（tui 21018 / web 21017）
curl -s --max-time 3 http://127.0.0.1:21018/v1/health
curl -s --max-time 3 http://127.0.0.1:21017/v1/health
```

### 故障排查

| 现象 | 排查 |
|---|---|
| `未检测到 dsh CLI` | `npm install -g @deepseek-ai/dsh` 后 `hash -r` |
| `未检测到 pnpm` | `npm install -g pnpm` 或 `corepack enable pnpm` |
| dsh-tui 启动失败 | `tail -50 ~/.dsh/profiles/dsh-tui/run.log` 看 `intentRouter: found` 行 |
| web profile 启动后 `:3080` 不 listen | `tail -50 ~/.dsh/profiles/web/run.log` 看 `dsh web:` 行；可能是 webui 包未装，跑 `dsh plugin --profile web add @deepseek-ai/dsh-web @deepseek-ai/dsh-web-ui-all` |
| 19 个 plugin 只挂载 dsh-base 的 30 个（bundle 没生效） | `dsh plugin --profile dsh-tui add @deepseek-harness-edge-agent/dsh-edge-agent` 重装；或者 `install.sh §2.6 + §2.7` 没跑，手动 cp `cordis.patch.yml` 到嵌套包根 |
| `adapter boundary violated` | 把 `@deepseek-ai/*` 的 import 移到 `src/dsh-adapter/` 内（或经 `src/dsh-adapter/types.ts` 重新导出） |
| `upstream contract violated` | DSH 依赖版本与 `UPSTREAM_VALIDATED_VERSION`（`0.1.2-rc.1`）不匹配；运行 `pnpm install` 或 `pnpm update @deepseek-ai/dsh-agent @deepseek-ai/dsh-llm ...` |

### 卸载

```bash
# 1. 停所有 dsh profile
pkill -f 'node.*dsh --profile dsh-tui' || true
pkill -f 'node.*dsh --profile web' || true

# 2. 从 profile bundles 列表移除 bundle
# （CLI：dsh plugin --profile dsh-tui remove <bundle> — 如 dsh CLI 提供）
# 或手动编辑 ~/.dsh/profiles/dsh-tui/package.json 删除 bundles + dependencies 中的 dsh-edge-agent
# §7.43: dsh-tui + web 都要处理（如果都装过）

# 3. 移除嵌套包
rm -rf ~/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-edge-agent/
rm -rf ~/.dsh/profiles/web/node_modules/@deepseek-harness-edge-agent/   # 若 web 装过

# 4. 移除 bundle 数据（注意：会删除所有会话和加密数据！）
rm -rf ~/.dsh-edge-agent-web/

# 5. 移除全局包（如适用）
npm uninstall -g @deepseek-harness-edge-agent/dsh-edge-agent
```

---

## 🚀 部署

### 方式一：使用 `.env.sh` 加载器（推荐）

⚠️ **DSH 限制**：`.env` 不能直接放进 `node --env-file=.env`，DSH 会拒绝加载「进程启动敏感」变量（如 `DSH_EDGE_HTTP_PORT`、`DSH_EDGE_LOCAL_LLM_BASEURL`）。因此使用 `.env.sh` 加载器，它只把安全变量放入 `.env`，其他变量由加载器 export。

```bash
# 1. 把 dsh CLI 加入 PATH（如果用 npm-global 安装）
export PATH="$HOME/.npm-global/bin:$PATH"

# 2. 复制环境变量模板并填写
cp .env.example .env
$EDITOR .env   # 填入 DEEPSEEK_API_KEY、EDGE_API_KEY 等

# 3. cordis patch 已由 ./install.sh §3.5 自动同步到 dsh-tui profile 嵌套包；手动开发期改完 bundle 也可重跑：
./install.sh --skip-pnpm

# 4. 启动（§7.43 默认 = dsh-tui；dsh-tui profile 自己 source 自己的 .env.sh）
cd ~/.dsh/profiles/dsh-tui
setsid nohup dsh --profile dsh-tui > run.log 2>&1 < /dev/null &
disown

# 或前台（debug 用）
source .env.sh && dsh --profile dsh-tui
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
export DSH_EDGE_PROVIDER=cloud-llm
export DSH_EDGE_MODEL=deepseek-chat
export DSH_EDGE_LOCAL_LLM_MODE=real
export DSH_EDGE_LOCAL_LLM_BASEURL=http://192.168.66.195:8701/v1
export DSH_EDGE_LOCAL_LLM_MODEL=qwen3-4b-instruct-2507

# DSH_EDGE_HTTP_PORT 仅在重新启用 http-api（cordis.patch.yml:313 disabled: false）时有效
export DSH_EDGE_HTTP_PORT=21017  # §7.33 后默认 disabled，本变量无副作用
export DSH_EDGE_PROVIDER=cloud-llm
export DSH_EDGE_MODEL=deepseek-chat
export DSH_EDGE_LOCAL_LLM_MODE=real
export DSH_EDGE_LOCAL_LLM_BASEURL=http://192.168.66.195:8701/v1
export DSH_EDGE_LOCAL_LLM_MODEL=qwen3-4b-instruct-2507

# §7.43: bundle 自带完整 cordis.patch.yml，无需 cp profile overlay
cd ~/.dsh/profiles/dsh-tui
dsh --profile dsh-tui
```

### LLM 路由机制

dsh-edge-agent 通过**意图路由**自动选择 LLM，无需手动指定 provider：

| 用户消息类型 | 触发关键词 | 路由到 | 示例 |
|---|---|---|---|
| **LOCAL** | 文件、读取、写入、计算、设备、本地 | `local-llm`（真实 OpenAI 兼容端点） | `"帮我读取文件"` → 真实 qwen3-4b 回答 |
| **CLOUD** | 解释、什么是、知识问答 | `cloud-llm` | `"量子力学是什么"` → DeepSeek 真实回答 |

> ⚠️ `DSH_EDGE_PROVIDER` 环境变量**仅**影响 system prompt 文本，不会改变实际路由。
> 实际路由由 `http-api.handleChat()` 根据意图分类结果硬编码选择。

### 本地 LLM 端点

`local-llm-adapter` 始终走真实 OpenAI 兼容端点（Schema 默认 `http://127.0.0.1:8080/v1`；部署默认 `http://192.168.1.121:11017/v1`）。
通过环境变量指向任一 llama.cpp / vLLM / Ollama 实例：

```bash
# .env.sh 中：
export DSH_EDGE_LOCAL_LLM_BASEURL=http://192.168.66.195:8701/v1
export DSH_EDGE_LOCAL_LLM_MODEL=qwen3-4b-instruct-2507
```

---

## ⚙️ 配置参考

dsh-edge-agent 通过**环境变量**和 `cordis.yml` 进行配置。所有环境变量都以 `DSH_EDGE_` 前缀开头（除业务变量 `EDGE_API_KEY` 和 `DEEPSEEK_API_KEY`）。完整模板见 [.env.example](.env.example)，`.env` 文件已加入 `.gitignore`，**切勿提交含真实 Key 的 `.env`**。

> **Secret 警告**：`DEEPSEEK_API_KEY`、`EDGE_API_KEY` 是 secret，**绝不能提交到 git**。

### 🌐 通用配置

| 变量 | 默认值 | 取值范围 | 说明 |
|---|---|---|---|
| `DSH_EDGE_LANG` | `zh` | `zh` / `en` | 启动器消息语言（不影响 agent 内容语言） |
| `DSH_EDGE_WORKSPACE` | 当前目录 | 任意路径 | 工作目录 |
| `DSH_EDGE_RESUME_SESSION` | — | session id | 通过 `--resume` 设置 |
| `DSH_EDGE_PERMISSION_MODE` | `workspace-write`（部署默认）/ `ask`（Schema 默认） | `ask` / `workspace-write` / `danger-full-access` | 权限模式 |

### 🔐 TEE 配置

| 变量 | 默认值 | 取值范围 | 说明 |
|---|---|---|---|
| `DSH_EDGE_TEE_TYPE` | `simulated` | `simulated` / `trustzone` / `keystone` / `sgx` | TEE 后端类型 |
| `DSH_EDGE_TEE_INFERENCE` | `false` | `true` / `false` | 是否在 TEE 内执行 LLM 推理 |
| `DSH_EDGE_SECURE_MEM` | `67108864` | 字节数 | 安全内存上限 |

`DSH_EDGE_TEE_TYPE` 取值：

- **`simulated`**（默认）：纯 JS 实现，仅用于开发/CI
- **`trustzone`**：ARM TrustZone（生产环境推荐）
- **`keystone`**：RISC-V Keystone
- **`sgx`**：Intel SGX（服务器端测试）

### 💾 存储配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_STORAGE_ROOT` | `~/.dsh-edge-agent/storage` | 存储根目录 |
| `DSH_EDGE_STORAGE_FILE` | `storage.plain.jsonl` | JSONL 存储文件名（未加密；AES-256-GCM 加密见 [Planned](./docs/PROGRESS.md#planned)） |

### 📜 策略配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_PRIVACY_POLICY_PATH` | `${DSH_EDGE_STORAGE_ROOT}/privacy-policy.json`（默认 `~/.dsh-edge-agent-web/storage/privacy-policy.json`）| 隐私策略文件路径 |
| `DSH_EDGE_REALM_HOT_RELOAD` | `true` | realm 配置热重载开关（不重载策略文件本身） |

### 🚦 路由配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_DEFAULT_DATA_LEVEL` | `sanitized` | 默认数据级别（`public` / `sanitized` / `internal`） |
| `DSH_EDGE_ROUTER_LLM_FALLBACK` | `true` | 当规则匹配置信度低时是否使用 LLM 兜底 |
| `DSH_EDGE_ROUTER_THRESHOLD` | `0.6` | 规则匹配置信度阈值 |
| `DSH_EDGE_INTENT_CONFIDENCE_THRESHOLD` | `0.6` | LLM 分类置信度门槛；低于此值降级到 keyword 规则 |
| `DSH_EDGE_GUARD_MODEL` | `false` | 是否启用 prompt-guard 模型辅助检测 |
| `DSH_EDGE_GUARD_MODEL_PROVIDER` | `local-llm` | 模型辅助检测 provider route |
| `DSH_EDGE_GUARD_MODEL_MODEL` | `Qwen3-4B-Instruct-2507` | 模型辅助检测 model id（部署默认） |
| `DSH_EDGE_GUARD_MODEL_TIMEOUT_MS` | `4000` | 模型辅助检测单次超时（毫秒） |
| `DSH_EDGE_GUARD_MODEL_MAX_INPUT` | `2000` | 超过此字符数则跳过模型检测（fail-open） |
| `DSH_EDGE_INTENT_PROVIDER` | `local-llm` | 意图分类 provider |
| `DSH_EDGE_INTENT_MODEL` | `Qwen3-4B-Instruct-2507` | 意图分类 model id |
| `DSH_EDGE_INTENT_LLM_TIMEOUT_MS` | `4000` | 意图分类单次 LLM 超时（毫秒） |
| `DSH_EDGE_INTENT_RECENT_LIMIT` | `3` | 上下文 recent-messages 数量 |
| `DSH_EDGE_INTENT_MAX_INPUT` | `2000` | 超过此字符数则跳过 LLM 分类 |
| `DSH_EDGE_INTENT_FALLBACK_KEYWORDS` | （空） | 关键词兜底列表（逗号分隔） |

### 🤖 模型配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_DEFAULT_MODEL` | `local-llm` | 默认模型 |
| `DSH_EDGE_LOCAL_MODELS` | `local-llm,local-llm-llama3` | 本地模型列表（逗号分隔） |
| `DSH_EDGE_CLOUD_MODELS` | `cloud-llm,cloud-llm-v3` | 云端模型列表（逗号分隔） |

**本地 LLM**

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_LOCAL_MODEL_PATH` | `~/.dsh-edge-agent/models/qwen3-4b.gguf` | GGUF 模型文件路径 |
| `DSH_EDGE_LOCAL_CTX` | `8192` | 上下文窗口大小 |
| `DSH_EDGE_LOCAL_THREADS` | `4` | 推理线程数 |
| `DSH_EDGE_LOCAL_LLM_BASEURL` | `https://coding.dashscope.aliyuncs.com/v1`（2026-09-11 起） / `http://192.168.1.121:11017/v1`（旧部署） | OpenAI 兼容端点 URL（实际使用） |
| `DSH_EDGE_LOCAL_LLM_MODEL` | `qwen3.7-plus`（2026-09-11 起） / `qwen3-4b-instruct-2507`（旧部署） | 端点 model id |
| `DSH_EDGE_LOCAL_LLM_MODE` | `mock`（Schema）/`real`（部署） | `mock` / `real`（是否走真实端点） |
| `DSH_EDGE_LOCAL_LLM_APIKEY_ENV` | `DASHSCOPE_API_KEY`（DashScope 模式）/ 空（本地 llama.cpp） | env 变量名，指向存放 bearer 的槽位。设为 `DASHSCOPE_API_KEY` 让 adapter 读 `.env` 里的 DashScope key。留空表示不发 `Authorization` header |

**云端 LLM**

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_CLOUD_KEY_ENV` | `DEEPSEEK_API_KEY` | API key 环境变量 |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | API base URL |
| `DEEPSEEK_API_KEY` | — | DeepSeek API Key（CLOUD 路由必需） |

### 🌐 出站配置

| 变量 | 默认值 | 取值范围 | 说明 |
|---|---|---|---|
| `DSH_EDGE_BRIDGE_MODE` | `ohttp` | `ohttp` / `tls` / `auto` | 出站模式 |
| `DSH_EDGE_BRIDGE_ALLOW` | — | 域名列表 | 允许的域名（逗号分隔） |
| `DSH_EDGE_BRIDGE_DENY` | — | 域名列表 | 拒绝的域名（逗号分隔） |
| `DSH_EDGE_BRIDGE_TIMEOUT_MS` | `30000` | 毫秒数 | 请求超时 |

**OHTTP**

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_OHTTP_RELAY` | — | OHTTP relay URL |
| `DSH_EDGE_OHTTP_TARGET` | — | OHTTP target URL |
| `DSH_EDGE_OHTTP_PUBKEY` | — | HPKE 公钥 |
| `DSH_EDGE_OHTTP_KEY_ID` | — | OHTTP key id |
| `DSH_EDGE_ALLOW_FALLBACK_TLS` | `false` | OHTTP 不可用时是否允许回退到 TLS |

### 🛡️ 审计与威胁检测

**审计日志**

| 变量 | 默认值 | 取值范围 | 说明 |
|---|---|---|---|
| `DSH_EDGE_AUDIT_LEVEL` | `info` | `debug` / `info` / `warn` / `error` / `security` | 最小日志级别 |
| `DSH_EDGE_AUDIT_SENSITIVE_FIELDS` | — | 字段名列表 | 视为敏感的字段（逗号分隔） |
| `DSH_EDGE_AUDIT_ALERTS` | `true` | `true` / `false` | 是否启用告警 |
| `DSH_EDGE_AUDIT_CLOUD_RATE` | `20` | 数字 | 每分钟云端请求告警阈值 |
| `DSH_EDGE_AUDIT_SAN_FAIL` | `3` | 数字 | 脱敏失败告警阈值 |
| `DSH_EDGE_AUDIT_PERM_DENIED` | `5` | 数字 | 权限拒绝告警阈值 |
| `DSH_EDGE_AUDIT_FLUSH_MS` | `500` | 毫秒数 | 刷新间隔 |

**威胁检测**

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_TD_WINDOW` | `60` | 时间窗口（秒） |
| `DSH_EDGE_TD_CLOUD_RATE` | `20` | 时间窗口内最大云端请求数 |
| `DSH_EDGE_TD_SAN` | `3` | 连续脱敏失败阈值 |
| `DSH_EDGE_TD_PERM` | `5` | 连续权限拒绝阈值 |

### 🛠️ 工具配置

**本地工具**

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_LOCAL_TOOLS_ALLOW` | — | 允许的路径前缀（逗号分隔） |
| `DSH_EDGE_LOCAL_TOOLS_WRITE` | `false` | 是否允许写操作 |
| `DSH_EDGE_LOCAL_TOOLS_MAX` | `10485760` | 最大文件大小（字节） |

**Web 搜索**

| 变量 | 默认值 | 取值范围 | 说明 |
|---|---|---|---|
| `DSH_EDGE_WEB_BACKEND` | `duckduckgo` | `duckduckgo` / `brave` / `custom` | 后端 |
| `DSH_EDGE_WEB_MAX` | `8` | 数字 | 最大结果数 |

### 🎤 语音输入

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_VOICE_MODEL` | `~/.dsh-edge-agent/models/whisper-tiny.bin` | Whisper 模型路径 |
| `DSH_EDGE_VOICE_VAD` | `0.6` | VAD 静音阈值（秒） |
| `DSH_EDGE_VOICE_SR` | `16000` | 采样率 |

### 🔌 插件配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_PLUGINS_THIRD_PARTY` | `false` | 是否允许第三方插件 |

### 🌐 HTTP API（可选）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_HTTP_HOST` | `0.0.0.0`（部署默认）/ `127.0.0.1`（Schema 默认） | HTTP 服务器绑定地址 |
| `DSH_EDGE_HTTP_PORT` | `21017` | HTTP 服务器端口 |
| `DSH_EDGE_HTTP_BEARER` | — | Bearer token（如不设则禁用） |
| `EDGE_API_KEY` | — | API 鉴权密钥（注入到 `DSH_EDGE_HTTP_BEARER`） |

### 📊 遥测

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_TELEMETRY` | `false` | 是否启用 DSH 遥测 |

### ⚙️ 会话

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_SESSION_ROOT` | `~/.dsh-edge-agent/sessions` | 会话 JSONL 根目录 |
| `DSH_EDGE_SESSION_TTL` | `3600` | 默认 TTL（秒） |
| `DSH_EDGE_MAX_SESSIONS` | `8` | 最大并发会话数 |
| `DSH_EDGE_SESSION_WINDOW_SIZE` | `32` | 意图路由的会话窗口大小 |

### ⚙️ Bash

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_BASH_TIMEOUT_MS` | `60000` | Bash 命令超时（毫秒） |

### 🛠️ 通过 cordis.yml 覆盖

环境变量会设置默认值，但你可以通过 `cordis.patch.yml` 覆盖任何配置：

```yaml
- id: tcm
  config:
    teeType: trustzone
    keyStorePath: /opt/secure/keys
    teeInference: true
    secureMemoryLimit: 134217728  # 128 MiB
```

**优先级**：`cordis.yml` > 环境变量 > Schema 默认值

---

## 🌐 入口架构（§7.43 重构后：--profiles=dsh-tui,web 默认并存启动）

> **2026-09-11 §7.43 修订**：install.sh 重写后默认 `--profiles=dsh-tui,web` 并存启动。dsh-tui 用 :21018，web 用 :21017，两个 profile 同时在跑。`--all` / `--profiles=<csv>` / `--to-profile=<name>` (deprecated) 控制部署范围。
>
> §7.33 仍然有效：dsh-edge-agent 是"纯 plugins" bundle。http-api plugin 当前 **disabled**（代码保留，未来可手动启用）。

**默认入口（§7.43 dsh-tui profile 宿主）**：

| 入口 | 端口 | 鉴权 | 目标用户 | 状态 |
|---|---|---|---|---|
| **TUI**（dsh-tui bundle） | `:21018` | loopback trust | 终端用户 / 开发者 | ✅ enabled（§7.43 primary） |
| **DSH 官方 Web UI**（SPA + apiproxy） | `:3080` | loopback trust + pairing | 浏览器 / 真人用户 / IM 渠道 | ✅ 默认并存启动 |

**已 disabled 的可选入口**（代码保留，未来手动启用见下文 §"重新启用 http-api"）：

| 入口 | 端口 | 用途 | 状态 |
|---|---|---|---|
| **http-api**（自研 REST + SSE） | `:21017` | CLI / SDK / cURL / 外部 agent | ❌ disabled（`cordis.patch.yml:313 disabled: true`）|

### 浏览器 / IM 用户 → `:3080`

打开浏览器访问 `http://127.0.0.1:3080`，使用 DSH 官方 Web UI（chat / task-board / pet / IM机器人 等）。鉴权由 DSH 上游的配对 token 流程处理。

`@xmanrui/dsh-im` 插件通过 webserver 内部 `apiProxy` 把 IM 消息接入 agent-loop——**不监听新端口**，自动继承 input-guard 隐私管线。

启用步骤：

1. 在浏览器访问 `http://127.0.0.1:3080`，打开 **设置 → IM机器人** 页面
2. 选择渠道，按页面提示**扫码**或粘贴 App ID / Secret / Bot Token 等凭据
3. 凭据仅写入 `dsh-credentials-local` 受保护本地存储，配置文件不落盘
4. 启用后，IM 私聊 / 群消息会自动路由到 agent-loop（流式思考 / 工具执行进度 / 最终回答均原生渠道展示）

支持的 IM 渠道：飞书（WebSocket + 流式卡片）/ 微信（iLink 长轮询）/ 钉钉（Stream + AI Card）/ 企业微信（WebSocket + 「思考中」）/ QQ（WebSocket）/ Slack（Socket Mode）/ Telegram（Bot API + Rich Draft）/ Discord（Gateway v10 + 原生 Thread）/ WhatsApp（WhatsApp Web）+ **AI Office Connector**（公网 HTTPS 心跳 + SSE 下行）。

> **⚠️ AI Office 风险**：AI Office Connector 让本机 Harness **主动**连接公网 Office（不需公网 IP / 端口转发），但 SSE 下行的增量文本会回到公网 Office。**只在用户主动启用**后生效。

> **⚠️ 凭据安全**：所有 IM 平台 bot credentials 只入 `dsh-credentials-local`，RPC 响应不回传原始凭据。

### 重新启用 http-api（可选，advanced）

如果你确实需要 CLI / SDK / cURL 调用（`curl :21017/v1/chat`），http-api 代码完整保留在 `src/dsh-adapter/http-api.ts`。启用步骤：

```bash
# 1. 编辑 cordis.patch.yml:313 把 disabled: true 删掉（或改成 false）
$EDITOR cordis.patch.yml

# 2. 同步到嵌套包 + 重启 web profile
./install.sh --skip-pnpm --profiles=web
```

启用后，http-api 会在 `:21017` 重新 listen（与 `:3080` webui 并存）。代码路径完全保留，下面是 REST API 文档存档（§7.33 之前是主入口，现在为 advanced option）：

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

完整接口规范详见 [docs/architecture.md](docs/architecture.md)。

> **⚠️ 鉴权约定**：
> - **http-api**（如启用）：Bearer token 必须从环境变量 `EDGE_API_KEY` 注入；**不要硬编码**到配置文件。生产环境使用 secret manager。
> - **dsh-im**：IM 平台 bot credentials 走 webui「设置 → IM机器人」页面，凭据**只入 `dsh-credentials-local`**。
> - **dsh-webui**：loopback trust + DSH 上游配对 token 流程。
>
> **⚠️ CORS**：v1 不启用 CORS（`enableCors` 字段在 schema 中完全不暴露）。程序端请同主机调用；若需要从浏览器调用，请用 `:3080` 的官方 Web UI。

---

## 🧪 手动测试

### Webui smoke（推荐，web profile 默认已装并启动）

```bash
# 0. §7.43: 默认 --all 已装 web profile；如未装：
./install.sh --profiles=web

# 1. web 默认已在 :21017 listen；UI 在 :3080
# （如需手动启动：cd ~/.dsh/profiles/web && setsid nohup dsh --profile web > run.log 2>&1 < /dev/null & disown）

# 2. 等 5-10s（webui 首次加载慢）
sleep 10

# 3. 浏览器访问 http://127.0.0.1:3080/
#    应看到 DSH 官方 Web UI（chat / task-board / pet / IM机器人）

# 4. 验证 dsh-edge-agent bundle plugin 已挂载（input-guard / intent-router / sanitizer）
curl -s http://127.0.0.1:3080/ | head -3
# 期望：HTML 含 dsh / webui 字样

# 5. 跟 audit log 验证 input-guard hook 注册
tail -10 ~/.dsh-edge-agent-web/audit/audit.plain.jsonl \
  | jq -c 'select(.kind | test("registered|loaded"))' | head -5
# 期望：input-guard.hook.registered 等事件

# 6. http-api 应 disabled（§7.33）
curl -s --max-time 3 http://127.0.0.1:21017/v1/health
# 期望：连接拒绝
```

### Tui smoke（§7.43 primary；**默认就装**）

```bash
# 1. 启动 dsh-tui（install.sh 默认装；并存启动 dsh-tui + web）
cd ~/.dsh/profiles/dsh-tui
setsid nohup dsh --profile dsh-tui > run.log 2>&1 < /dev/null &
disown

# 2. 等 3-5s
sleep 5

# 3. 验证 dsh-tui 进程在跑
pgrep -f 'dsh --profile dsh-tui'   # 期望：返回 PID

# 4. 跟 audit log 验证 input-guard hook 注册
tail -10 ~/.dsh-edge-agent-dsh-tui/audit/audit.plain.jsonl \
  | jq -c 'select(.kind | test("registered|loaded"))' | head -5
# 期望：input-guard.hook.registered 等事件
```

### http-api 手动测试（advanced，**需先启用**）

> ⚠️ §7.33 后 http-api 默认 disabled。如要跑以下 curl 示例，先 `cordis.patch.yml:313` 删 `disabled: true` 并 `./install.sh --skip-pnpm --profiles=web` 重启 web profile。

假设服务器运行在 `http://127.0.0.1:21017`，API Key 为 `test-secret-key`。

### 启动服务

```bash
# 方式 1: 使用启动脚本（推荐；§7.43 默认 dsh-tui）
./scripts/launch-dev.sh

# 方式 2: 手动启动
source .env.sh
dsh --profile dsh-tui

# 方式 3: 后台运行
setsid bash -c 'source .env.sh && dsh --profile dsh-tui' > /tmp/dsh.log 2>&1 < /dev/null &
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

**LOCAL Intent**（本地处理 — 文件操作、计算）

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

> LOCAL intent 路由到本地 LLM（`local-llm`），直连真实 OpenAI 兼容端点（不消耗云端 API 配额）。

**CLOUD Intent**（云端处理 — 知识问答、创意）

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

> CLOUD intent 路由到 `cloud-llm`，需要 `DEEPSEEK_API_KEY` 环境变量。

### 工具调用测试

dsh-edge-agent 使用 DSH 原生工具，所有工具都通过模型自动调用。

**Bash 工具**（本地命令执行）

```bash
curl -X POST http://127.0.0.1:21017/v1/chat \
  -H "Authorization: Bearer test-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"message":"帮我计算 17*23","sessionId":"test-bash"}'
```

模型会调用 `bash` 工具执行 `echo $((17*23))`，返回计算结果。

**文件工具**（读/写/编辑）

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

**Web 搜索工具**（DeepSeek 搜索引擎）

```bash
curl -X POST http://127.0.0.1:21017/v1/chat \
  -H "Authorization: Bearer test-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"message":"搜索 DeepSeek V4 模型的最新消息","sessionId":"test-web-search"}'
```

模型会调用 `web_search` 工具，返回搜索结果摘要。

**Web 获取工具**（抓取网页内容）

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

---

## 🧪 自动化测试

### 单元测试（628 个测试用例 / 37 个测试文件）

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
- `verify:contract` — 上游版本契约（锁定 `0.1.2-rc.1`）
- `verify:patch-surface` — 补丁面一致性
- `verify:plugin-spec` — 插件规范（name+inject+Config+apply）

---

更多文档见 [docs/architecture.md](docs/architecture.md)：[架构](docs/architecture.md) · [上游适配契约](docs/architecture.md) · [威胁模型](docs/architecture.md) · [插件开发](docs/architecture.md) · [实施进度](docs/PROGRESS.md)

MIT License. 详见 [LICENSE](LICENSE)。
