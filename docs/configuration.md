# 配置参考

dsh-edge-agent 通过**环境变量**和 `cordis.yml` 进行配置。所有环境变量都以 `DSH_EDGE_` 前缀开头。

## 🌐 通用配置

| 变量 | 默认值 | 取值范围 | 说明 |
|---|---|---|---|
| `DSH_EDGE_LANG` | `zh` | `zh` / `en` | 启动器消息语言（不影响 agent 内容语言） |
| `DSH_EDGE_WORKSPACE` | 当前目录 | 任意路径 | 工作目录 |
| `DSH_EDGE_RESUME_SESSION` | — | session id | 通过 `--resume` 设置 |
| `DSH_EDGE_PERMISSION_MODE` | `ask` | `ask` / `workspace-write` / `danger-full-access` | 权限模式 |

## 🔐 TEE 配置

| 变量 | 默认值 | 取值范围 | 说明 |
|---|---|---|---|
| `DSH_EDGE_TEE_TYPE` | `simulated` | `simulated` / `trustzone` / `keystone` / `sgx` | TEE 后端类型 |
| `DSH_EDGE_TEE_INFERENCE` | `false` | `true` / `false` | 是否在 TEE 内执行 LLM 推理 |
| `DSH_EDGE_SECURE_MEM` | `67108864` | 字节数 | 安全内存上限 |

### `DSH_EDGE_TEE_TYPE`

- **`simulated`**（默认）：纯 JS 实现，仅用于开发/CI
- **`trustzone`**：ARM TrustZone（生产环境推荐）
- **`keystone`**：RISC-V Keystone
- **`sgx`**：Intel SGX（服务器端测试）

## 💾 存储配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_STORAGE_ROOT` | `~/.dsh-edge-agent/` | 加密存储根目录 |
| `DSH_EDGE_STORAGE_FILE` | `storage.enc.db` | SQLite 文件名 |

## 📜 策略配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_POLICY_PATH` | `~/.dsh-edge-agent/policy.json` | 隐私策略文件路径 |
| `DSH_EDGE_POLICY_HOT_RELOAD` | `true` | 是否热重载策略文件 |
| `DSH_EDGE_POLICY_WATCH_MS` | `5000` | 策略文件轮询间隔 |

## 🚦 路由配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_DEFAULT_DATA_LEVEL` | `sanitized` | 默认数据级别（`public` / `sanitized` / `internal`） |
| `DSH_EDGE_ROUTER_LLM_FALLBACK` | `true` | 当规则匹配置信度低时是否使用 LLM 兜底 |
| `DSH_EDGE_ROUTER_THRESHOLD` | `0.6` | 规则匹配置信度阈值 |
| `DSH_EDGE_GUARD_MODEL` | `false` | 是否启用 prompt-guard 模型辅助检测 |
| `DSH_EDGE_GUARD_MODEL_PROVIDER` | `local-qwen3-4b` | 模型辅助检测 provider route |
| `DSH_EDGE_GUARD_MODEL_MODEL` | `qwen3-4b` | 模型辅助检测 model id |
| `DSH_EDGE_GUARD_MODEL_TIMEOUT_MS` | `4000` | 模型辅助检测单次超时（毫秒） |
| `DSH_EDGE_GUARD_MODEL_MAX_INPUT` | `2000` | 超过此字符数则跳过模型检测（fail-open） |

## 🤖 模型配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_DEFAULT_MODEL` | `local-qwen3-4b` | 默认模型 |
| `DSH_EDGE_LOCAL_MODELS` | `local-qwen3-4b,local-llama3-8b` | 本地模型列表（逗号分隔） |
| `DSH_EDGE_CLOUD_MODELS` | `cloud-deepseek-v4,cloud-deepseek-v3` | 云端模型列表（逗号分隔） |

### 本地 LLM

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_LOCAL_MODEL_PATH` | `~/.dsh-edge-agent/models/qwen3-4b.gguf` | GGUF 模型文件路径 |
| `DSH_EDGE_LOCAL_CTX` | `8192` | 上下文窗口大小 |
| `DSH_EDGE_LOCAL_THREADS` | `4` | 推理线程数 |

### 云端 LLM

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_CLOUD_KEY_ENV` | `DEEPSEEK_API_KEY` | API key 环境变量 |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | API base URL |

## 🌐 出站配置

| 变量 | 默认值 | 取值范围 | 说明 |
|---|---|---|---|
| `DSH_EDGE_BRIDGE_MODE` | `ohttp` | `ohttp` / `tls` / `auto` | 出站模式 |
| `DSH_EDGE_BRIDGE_ALLOW` | — | 域名列表 | 允许的域名（逗号分隔） |
| `DSH_EDGE_BRIDGE_DENY` | — | 域名列表 | 拒绝的域名（逗号分隔） |
| `DSH_EDGE_BRIDGE_TIMEOUT_MS` | `30000` | 毫秒数 | 请求超时 |

### OHTTP

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_OHTTP_RELAY` | — | OHTTP relay URL |
| `DSH_EDGE_OHTTP_TARGET` | — | OHTTP target URL |
| `DSH_EDGE_OHTTP_PUBKEY` | — | HPKE 公钥 |
| `DSH_EDGE_OHTTP_KEY_ID` | — | OHTTP key id |
| `DSH_EDGE_ALLOW_FALLBACK_TLS` | `false` | OHTTP 不可用时是否允许回退到 TLS |

## 🛡️ 审计与威胁检测

### 审计日志

| 变量 | 默认值 | 取值范围 | 说明 |
|---|---|---|---|
| `DSH_EDGE_AUDIT_LEVEL` | `info` | `debug` / `info` / `warn` / `error` / `security` | 最小日志级别 |
| `DSH_EDGE_AUDIT_SENSITIVE_FIELDS` | — | 字段名列表 | 视为敏感的字段（逗号分隔） |
| `DSH_EDGE_AUDIT_ALERTS` | `true` | `true` / `false` | 是否启用告警 |
| `DSH_EDGE_AUDIT_CLOUD_RATE` | `20` | 数字 | 每分钟云端请求告警阈值 |
| `DSH_EDGE_AUDIT_SAN_FAIL` | `3` | 数字 | 脱敏失败告警阈值 |
| `DSH_EDGE_AUDIT_PERM_DENIED` | `5` | 数字 | 权限拒绝告警阈值 |
| `DSH_EDGE_AUDIT_FLUSH_MS` | `500` | 毫秒数 | 刷新间隔 |

### 威胁检测

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_TD_WINDOW` | `60` | 时间窗口（秒） |
| `DSH_EDGE_TD_CLOUD_RATE` | `20` | 时间窗口内最大云端请求数 |
| `DSH_EDGE_TD_SAN` | `3` | 连续脱敏失败阈值 |
| `DSH_EDGE_TD_PERM` | `5` | 连续权限拒绝阈值 |

## 🛠️ 工具配置

### 本地工具

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_LOCAL_TOOLS_ALLOW` | — | 允许的路径前缀（逗号分隔） |
| `DSH_EDGE_LOCAL_TOOLS_WRITE` | `false` | 是否允许写操作 |
| `DSH_EDGE_LOCAL_TOOLS_MAX` | `10485760` | 最大文件大小 |

### Web 搜索

| 变量 | 默认值 | 取值范围 | 说明 |
|---|---|---|---|
| `DSH_EDGE_WEB_BACKEND` | `duckduckgo` | `duckduckgo` / `brave` / `custom` | 后端 |
| `DSH_EDGE_WEB_MAX` | `8` | 数字 | 最大结果数 |

## 🎤 语音输入

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_VOICE_MODEL` | `~/.dsh-edge-agent/models/whisper-tiny.bin` | Whisper 模型路径 |
| `DSH_EDGE_VOICE_VAD` | `0.6` | VAD 静音阈值（秒） |
| `DSH_EDGE_VOICE_SR` | `16000` | 采样率 |

## 🔌 插件配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_PLUGINS_THIRD_PARTY` | `false` | 是否允许第三方插件 |

## 🌐 HTTP API（可选）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_HTTP_HOST` | `127.0.0.1` | HTTP 服务器绑定地址 |
| `DSH_EDGE_HTTP_PORT` | `21017` | HTTP 服务器端口 |
| `DSH_EDGE_HTTP_BEARER` | — | Bearer token（如不设则禁用） |
| `DSH_EDGE_HTTP_REQUIRE_ATTEST` | `true` | 是否要求 attestation |

## 📊 遥测

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_TELEMETRY` | `false` | 是否启用 DSH 遥测 |

## ⚙️ 会话

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_SESSION_ROOT` | `~/.dsh-edge-agent/sessions` | 会话 JSONL 根目录 |
| `DSH_EDGE_SESSION_TTL` | `3600` | 默认 TTL（秒） |
| `DSH_EDGE_MAX_SESSIONS` | `8` | 最大并发会话数 |
| `DSH_EDGE_SESSION_WINDOW_SIZE` | `32` | 意图路由的会话窗口大小 |

## ⚙️ Bash

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_BASH_TIMEOUT_MS` | `60000` | Bash 命令超时（毫秒） |

## 🛠️ 通过 cordis.yml 覆盖

环境变量会设置默认值，但你可以通过 `cordis.patch.yml` 覆盖任何配置：

```yaml
- id: tcm
  config:
    teeType: trustzone
    keyStorePath: /opt/secure/keys
    teeInference: true
    secureMemoryLimit: 134217728  # 128 MiB
```

优先级：**cordis.yml > 环境变量 > Schema 默认值**

## 🔗 相关文档

- [架构设计](architecture.md)
- [威胁模型](threat-model.md)
- [插件开发](plugin-development.md)