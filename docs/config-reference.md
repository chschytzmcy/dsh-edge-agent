# 配置参考

> 本文件是 `dsh-edge-agent` 的**完整配置清单**（2026-10-30 从根 README 迁出，
> README 只留最基本的介绍与部署信息）。
>
> 配置读取的唯一入口是 `src/dsh-adapter/edge-config.ts`。

## 0. 配置归一（§7.102，2026-10-21）

`dsh-edge-agent` 现在只通过**一个文件**配置 —— `config/edge.json`。旧的 `.env` /
`.env.sh` 两条链（裸名 env → `.env.sh` 派生 `DSH_EDGE_*` → cordis patch 读
`process.env`）已删除。

**查找顺序**（与 profile 无关，desktop / tui / web / edge 一致）：

```
1. <bundle>/config/edge.json     ← 仓库 checkout 或 bundle 自带副本
2. ~/.dsh-edge-agent/edge.json   ← install.sh 部署的用户副本（可改）
3. <bundle>/config/edge.example.json  ← shipped 模板（空 secret + 默认值）
```

模板见 [config/edge.example.json](../config/edge.example.json)（tracked）。
**切勿提交 `config/edge.json`** —— 它含明文 API key，已在 `.gitignore` 里。

> ⚠️ **桌面版的实际落位**：git / npm 装法都**不会**把 `config/edge.json` 带进包里
> ⇒ 装完要写 `~/.dsh-edge-agent/edge.json`（第 2 顺位）。只有「本地目录」装法
> （符号链接整个目录）才落在第 1 顺位。详见
> [`deploy-github.md` §4](deploy-github.md) 与
> [`deploy-npm.md` §9.1](deploy-npm.md)。

## 1. Secret

`secrets` 段存明文 key，池通过 `keyRef` 指向它：

```jsonc
{
  "secrets": { "dashscopeApiKey": "sk-..." },
  "llm": { "local": { "baseUrl": "https://...", "model": "qwen3.6-flash", "keyRef": "dashscopeApiKey" } }
}
```

> **Secret 警告**：`config/edge.json` 含明文 API key，**绝不能提交到 git**。

## 2. 通用配置

| 变量 | 默认值 | 取值范围 | 说明 |
|---|---|---|---|
| `DSH_EDGE_LANG` | `zh` | `zh` / `en` | 启动器消息语言（不影响 agent 内容语言） |
| `DSH_EDGE_WORKSPACE` | 当前目录 | 任意路径 | 工作目录 |
| `DSH_EDGE_RESUME_SESSION` | — | session id | 通过 `--resume` 设置 |
| `DSH_EDGE_PERMISSION_MODE` | `workspace-write`（部署默认）/ `ask`（Schema 默认） | `ask` / `workspace-write` / `danger-full-access` | 权限模式 |

## 3. TEE 配置

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

> ⚠️ TEE 相关能力目前是**桩实现**（crypto 返回零字节、网关恒返回 200），
> 尚未接入真实 TEE 与 RFC 9458 中继。**当前真正生效的隐私保证来自 Layer 2**
> （脱敏管线 + 策略引擎 + 审计链 + Realm 闸门）。分层状态表见
> [`architecture.md`](architecture.md)。

## 4. 存储配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_STORAGE_ROOT` | `~/.dsh-edge-agent/storage` | 存储根目录 |
| `DSH_EDGE_STORAGE_FILE` | `storage.plain.jsonl` | JSONL 存储文件名（未加密；AES-256-GCM 加密见 [Planned](PROGRESS.md#planned)） |

## 5. 策略配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_PRIVACY_POLICY_PATH` | `${DSH_EDGE_STORAGE_ROOT}/privacy-policy.json`（默认 `~/.dsh-edge-agent-web/storage/privacy-policy.json`）| 隐私策略文件路径 |
| `DSH_EDGE_REALM_HOT_RELOAD` | `true` | realm 配置热重载开关（不重载策略文件本身） |

## 6. 路由配置

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

## 7. 模型配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_DEFAULT_MODEL` | `local-llm` | 默认模型 |
| `DSH_EDGE_LOCAL_MODELS` | `local-llm,local-llm-llama3` | 本地模型列表（逗号分隔） |
| `DSH_EDGE_CLOUD_MODELS` | `cloud-llm,cloud-llm-v3` | 云端模型列表（逗号分隔） |

### 7.1 本地 LLM（`config/edge.json` → `llm.local`）

| 字段 | 默认值 | 说明 |
|---|---|---|
| `llm.local.baseUrl` | （空 = 不注册） | OpenAI 兼容端点 URL，**必须含 `/v1`**（adapter 只追加 `/chat/completions`） |
| `llm.local.model` | `qwen3-4b` | 端点 model id |
| `llm.local.keyRef` | （空 = 不发 auth 头） | 指向 `secrets` 段里的键名 |
| `llm.local.stripTools` | `false` | 省略 `body.tools`（minicpm Jinja2 bug 规避） |
| `llm.local.enableThinking` | `false` | 关掉 thinking-model 的 chain-of-thought |
| `llm.local.reasoningEffortNone` | `false` | **ollama 池必开** —— 见下 |

`local-llm-adapter` 始终走真实 OpenAI 兼容端点。端点指向任一 llama.cpp /
vLLM / Ollama / DashScope 实例：

```jsonc
{
  "llm": {
    "local": {
      "baseUrl": "http://192.168.66.195:8701/v1",
      "model": "qwen3-4b-instruct-2507",
      "keyRef": "dashscopeApiKey"   // 指向 secrets 段里的键名；无鉴权则留空
    }
  }
}
```

> `llm.local.baseUrl` **留空 = 不注册本地 LLM 路由**（模型列表里不出现
> `local-llm`，意图分类 / prompt-guard 自动降级到关键词 / 正则规则档）。
> 早期版本用 `http://127.0.0.1:8080/v1` 作默认值，撞上无关守护进程导致
> 每次请求 401 —— 现在没有硬编码默认端点。

> **ollama 用户注意**：ollama 的 `/v1` 兼容层**静默丢弃** `chat_template_kwargs`
> 和顶层 `think:false`，只有 `reasoning_effort:"none"` 生效。不开这个开关，
> thinking 会吃满 `max_tokens` → `content` 为空 → 攻击检测 json-parse-failed
> **静默落回正则档**（实测 24.6s → 6.5s）。
>
> ```json
> "local": {
>   "baseUrl": "http://<host>:11434/v1",
>   "model": "<ollama 里实际的 tag>",
>   "keyRef": "",
>   "reasoningEffortNone": true
> }
> ```
>
> 严格网关（OpenAI 官方风格）不认这个参数会返 400，保持 `false`。

> **改完要重启**：`baseUrl` / `model` / `reasoningEffortNone` 都在 adapter
> 构造时冻结（`local-llm-adapter.ts:243-256`），改配置文件不触发重新注册。
> 桌面版需**完全退出 DSH App 进程**再打开。

### 7.2 云端 LLM（§7.100 起整体可选 —— 不配即 DELEGATE 到宿主 profile 提供商）

| 字段 | 默认值 | 说明 |
|---|---|---|
| `llm.cloud.baseUrl` | （空 = DELEGATE） | 自研直连的 OpenAI 兼容端点 |
| `llm.cloud.model` | （空） | 直连模式 model id |
| `llm.cloud.keyRef` | （空） | 指向 `secrets` 段里的键名 |
| `llm.cloud.delegate` | `true` | `false` 禁用委托：云不可用 → input-guard 降级 LOCAL（LOCAL-only 部署用） |
| `llm.cloud.delegateProvider` | （自动） | 显式锁定委托目标路由 id（如 `qwen-token-plan-cn`） |
| `llm.cloud.delegateModel` | （跟随宿主选择） | 委托 wire model override |

配置 `llm.cloud.baseUrl` 即切回自研直连；解析链详见 PROGRESS §7.100。

## 8. 出站配置

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

## 9. 审计与威胁检测

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

### 9.1 详细 LLM 追踪（§7.118，写进 ops log）

ops log 默认只记 LLM 调用的**长度**（`promptLen=… resultLen=…`）。要看
"到底发了什么、回了什么"，用这组配置把**脱敏 + 截断后的**完整 request /
response 写进 ops log（`info` 级别，默认可见）：

```jsonc
// config/edge.json
{
  "audit": {
    "llmTrace": {
      "enabled": true,          // 总开关
      "includeRequest": true,   // 逐条 message 的角色 / 正文 / 工具回显
      "includeResponse": true,  // 正文 + tool calls + finish reason
      "maxChars": 2000,         // 单字段字符上限（溢出显式标注 …[+N chars]）
      "maxMessages": 12,        // 只保留最近 N 条 message
      "redactPii": true,        // 走 pii-utils 的 10 类 PII 规则
      "redactSecrets": true     // 盖住厂商前缀密钥（sk-cp- / sk-ws- / tvly- …）
    }
  }
}
```

> `redactSecrets` 不是多余的：pii-utils 的 api-key 规则
> （`sk-(?:proj-|ant-|live-|test-|org-)?[a-zA-Z0-9]{20,}`）**匹配不到**
> `sk-cp-…` / `sk-ws-…` / `tvly-…` 这类带厂商前缀的密钥。
>
> 改完 `config/edge.json` 即时生效（`loadEdgeConfig()` 带 mtime+size 指纹
> 缓存），不需要重启进程。

### 9.2 Edge 面板的原始判断数据（§7.121）

桌面版 Edge 标签把一轮判定拆成六个节点（攻击检测 → 意图判定 → PII 脱敏
→ 路由决策 → 答案出口 → 威胁监控）。每个节点除结论外都给出**原始依据**，
便于对账：

| 节点 | 原始依据 |
|---|---|
| 攻击检测 | 命中的注入规则名 + 该规则的**正则原文**；模型判「安全」的**理由原文**；不安全轮的**威胁类型** |
| 意图判定 | **本轮实际裁决者**（决策模型 / LLM 分类器 / 缓存 / 关键词规则）、命中**关键字**、语义说明、决策路径机器码、决策模型的原始 `intent` / `confidence` / `riskScore`、分类器的**真实落点**（含「本机 / 不在本机」标注） |
| PII 脱敏 | 命中的 **PII 规则类型**（phone / id-card / email …）+ 替换成的**占位符** |
| 路由决策 | 改写的**机器原因码**（译文与原码并列）、改写前的原路由来源 |
| 答案出口 | 真实出口的原始字段（route / durationMs / promptLen / resultLen）；**作答中**（请求已发出、答案未回）与**作答失败**（http / network error）是两个独立状态，不笼统写成「路由未定」 |
| 威胁监控 | 本轮检了多少条信号；限流时区分全局档 / 会话档 |

> 命中明细（规则名 / PII 类型 / 占位符）都是**规则标识符**，不含用户原文。
> PII 的原文永不进 audit —— 占位符是明文 PII 的映射键，值不落盘。
>
> 意图判定节点的「裁决者」显示的是**本轮实际是谁判的**，不是配置里的备用
> 分类器；旁边的「真实落点」是该 provider 的实际 baseUrl，并标注是否在
> 本机 —— provider 名里的 `local` **不代表**落点在本机
> （`config/edge.json` 的 `llm.local.baseUrl` 可以指向公网）。

## 10. 工具配置

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

## 11. 语音输入

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_VOICE_MODEL` | `~/.dsh-edge-agent/models/whisper-tiny.bin` | Whisper 模型路径 |
| `DSH_EDGE_VOICE_VAD` | `0.6` | VAD 静音阈值（秒） |
| `DSH_EDGE_VOICE_SR` | `16000` | 采样率 |

## 12. 插件配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_PLUGINS_THIRD_PARTY` | `false` | 是否允许第三方插件 |

## 13. HTTP API（可选）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_HTTP_HOST` | `0.0.0.0`（部署默认）/ `127.0.0.1`（Schema 默认） | HTTP 服务器绑定地址 |
| `DSH_EDGE_HTTP_PORT` | `21017` | HTTP 服务器端口 |
| `DSH_EDGE_HTTP_BEARER` | — | Bearer token（如不设则禁用） |
| `EDGE_API_KEY` | — | API 鉴权密钥（注入到 `DSH_EDGE_HTTP_BEARER`） |

## 14. 遥测

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_TELEMETRY` | `false` | 是否启用 DSH 遥测 |

## 15. 会话

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_SESSION_ROOT` | `~/.dsh-edge-agent/sessions` | 会话 JSONL 根目录 |
| `DSH_EDGE_SESSION_TTL` | `3600` | 默认 TTL（秒） |
| `DSH_EDGE_MAX_SESSIONS` | `8` | 最大并发会话数 |
| `DSH_EDGE_SESSION_WINDOW_SIZE` | `32` | 意图路由的会话窗口大小 |

## 16. Bash

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_BASH_TIMEOUT_MS` | `60000` | Bash 命令超时（毫秒） |

## 17. 通过 cordis.yml 覆盖

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

## 18. 路由行为约定（不是配置项，是裁决）

以下几条是**行为契约**，配置改不了它们；出处见
[`PROGRESS.md`](PROGRESS.md)。

- **REJECT 永不出网**（§7.128）：策略规则或分类器判下的 REJECT 绝不会被改写成
  CLOUD —— fail-closed（默认）直接拦下，fail-open 也只降级到 LOCAL 留在设备上
  继续，且仍会注册 session realm（Layer 3 的 tool-realm gating 不许 fail-open）。
- **面板不得断言与数据相矛盾的事**（§7.129 / §7.130）：Tier-0 设备指令正则裁决的
  一轮显示「设备指令正则裁决」，不会谎称「LLM 裁决」（分类器压根没被调用）。
- **「是否出网」的判据是 category（哪个池），不是端点落在哪台机**：
  `category=LOCAL` 即**不算出公网** —— `llm.local` 池是 operator 自有设施，
  端点不在本机也照样不出网。
- **出网只带云段历史**（§7.131）：发往 `cloud-llm` 的请求**只携带之前所有上过
  cloud-llm 的历史**；任何 local-llm 段的历史会话信息一律不带 —— 默认路由是
  本地池，本地轮次积累的历史属于**本地资产**，路由被改写/恢复切回云端时不能跟
  着上云。`local-llm` 反过来携带**全部**历史（本地池带什么都不算出网）。
  保留块出网前还会再脱敏一次（可逆占位符），脱敏失败则 fail-closed 不出网。
  分段依据是宿主给每条 assistant 消息打的 `source.provider`（路由 id）。
- **答案出口只认本对话的出网**（§7.132）：插件自己也调 LLM —— 入口安检
  （`prompt-guard`）、意图分类器（`intent-router`）、宿主的会话标题生成 ——
  它们与主对话走**同一个** adapter，落**同样**的 `llm.local.start` 审计行。
  出口审计行带两个判别字段：`internal`（我们自己的内部调用标记）与 `tools`
  （这次请求带了几件工具 —— 主对话恒带 30+ 件，一切内部调用一件都不带）。
  面板据此把内部调用排除在「答案出口」之外。
- **LLM 调用记录按类别分组、请求响应成对**（§7.134）：Edge 标签页底部的
  「LLM 调用」板块按**攻击检测 / 意图判定 / 路由决策 / 宿主内部调用**分组，
  每次往返的**请求在上、响应在下**成对显示。配对靠 `callId` —— 一次 `stream()`
  一个 call，REQ 与 RESP 共用；重试时可能出现多条 RESP，取最后一条。

> **路由机制本身**（三层兜底 / 实体护栏 / DELEGATE 链 / 三档搜索 fail-down）
> 见 [`architecture.md` §7.107 章](architecture.md) 与
> [`intent-and-sanitization.md`](intent-and-sanitization.md)。

## 19. 五种部署形态 × 配置存在性 × 实时性（2026-10-30 裁决）

**主人裁决**：

- **npm 与 git 仓库部署 ⇒ 不得带 `config/edge.json`**（明文凭据绝不出网）；
- **目录通道 ⇒ 走 link 方式、实时更新**；
- **tar 包方式 ⇒ 可以带真实 `config/edge.json`**（演示用，不外传）。

| 形态 | 产物 | `config/edge.json` | 生效顺位 | 实时性 | 门禁 |
|---|---|---|---|---|---|
| **npm 包** | `npm pack` 的 tarball | ❌ 不含 | 2 | 冻结 | `verify-package`（`FORBIDDEN_IN_PACKAGE`） |
| **GitHub 仓库** | `pnpm add git+…` 现场编译 | ❌ 不含 | 2 | 冻结（装的是 HEAD） | `verify-git-install`：静态断言 + `--real` **真装一遍**后检查包里没有它 |
| **本地目录（link）** | `dist/installable/<变体>/` 的**符号链接** | ✅ **含（活配置）** | **1** | **实时**（见下） | `verify-installable` §1c（本轮新增） |
| **tarball（可分发）** | `dist/<变体>.tar.gz` | ❌ 不含 | 2 | 冻结（pnpm store 的副本） | `verify-tarball` 第 5 条 |
| **tarball（DEMO 演示）** | `dist/<变体>-DEMO.tar.gz` | ✅ **含真实凭据** | **1** | 冻结 | `verify-tarball` **反向规则**（必须含）+ 文件名带 `-DEMO` |

⇒ **只有「本地目录（link）」与「DEMO tarball」带活配置**；其余三种形态一律不含
⇒ 目标机器自己写 `~/.dsh-edge-agent/edge.json`（顺位 2）。

### link 通道的「实时更新」到底实时到什么程度

| 改什么 | 生效方式 |
|---|---|
| `dist/installable/<变体>/config/edge.json` | **不用重启** —— 配置读取带文件指纹（mtime+size），变了就重读 |
| 同一文件里**从「无端点」改成「有端点」** | **要重启** —— `local-llm` 路由的注册发生在启动时的插件 `apply()` 里 |
| `dist/installable/<变体>/lib/*.js`（代码） | **重启 App** —— bundle 是符号链接，文件直接变，重启即生效 |
| 装出来的 tarball 内容 | **不生效** —— 冻结副本 ⇒ 卸载重装 |

### ⚠️ 目录通道**必须**写成 `link:` 或裸路径 —— `file:<目录>` 是静默陷阱（2026-10-30 实测）

三种写法装同一个目录，**结果完全不同**（隔离临时 profile 里真装三次）：

| 写法 | profile 里记成 | `node_modules` 里是 | 实时？ | 带活配置？ |
|---|---|---|---|---|
| **裸绝对路径** | `link:<绝对路径>` | 符号链接 | ✅ | ✅ |
| **`link:<绝对路径>`** | `link:<绝对路径>` | 符号链接 | ✅ | ✅ |
| **`file:<绝对路径>`** | `file:<绝对路径>` | **真实副本（冻结）** | ❌ | ❌ **丢** |

⇒ **`file:` 指向目录会同时坏掉裁决的两半**：① pnpm 把目录 **pack** 进 store 而不是链接 ⇒
「改文件重启即生效」不成立；② pack 会尊重 manifest 的 `files` 白名单，而白名单里写着
`"!config/edge.json"` ⇒ **装出来那份没有活配置** ⇒ 宿主的配置**顺位 1**
（`<bundle>/config/edge.json`）落空 ⇒ 悄悄退到 `~/.dsh-edge-agent/edge.json` 或空模板
⇒ 本地路由可能压根不注册 ⇒ 每一轮 LOCAL 都被隐私裁决拦下。

**宿主不会拦你**：`install-spec.ts:69-92` 只剥**一个** `file:`/`link:` 前缀，
**按扩展名**分类（目录一律 `kind: 'path'`，跟前缀无关），然后把 spec **原样**交给 pnpm
（`index.ts:930` 的 `pnpm add <spec>`）。⇒ `file:<目录>` 被无声接受，问题要到
「配置不见了 / 不实时了」才显形。

⇒ **目录通道照着这两条写**：桌面 GUI 的「添加插件」输入框填
`C:\…\dist\installable\dsh-edge-agent-desktop-safe`（**裸路径**即可），
或显式 `link:C:\…\dist\installable\dsh-edge-agent-desktop-safe`。
**不要填 `file:` + 目录**（`file:` 只对 **tarball** 是对的）。

门禁：`scripts/verify-local-channel.mjs`（`verify:local-channel`，已接进 `verify:build`）

### 为什么要给 link 通道加硬断言（§7.161）

`verify-installable.mjs` 原来只要求「`config/` 里有 `edge.json` **或**
`edge.example.json`」⇒ **installable 目录若丢了活配置，它照样绿** ⇒ link
模式的 profile 会悄悄退到空模板（顺位 1 落空），运维的真端点不再是生效的那份
—— 正是 §7.102 记过的那个坑。

⇒ 现在：**本仓有 `config/edge.json` 时，installable 目录里必须有它**
（条件断言 —— 干净 checkout / CI 没有活配置可带，空模板仍是正确的兜底）。

反向证伪（对真实产物做的）：把两个变体的 `config/edge.json` 移开 ⇒ 门禁红；
放回 ⇒ 绿。

## 20. 相关文档

- [`deploy-github.md`](deploy-github.md) — 从 GitHub 仓库地址安装（配置落位见 §4）
- [`deploy-npm.md`](deploy-npm.md) — 从 npm 包名安装（配置落位见 §9.1）
- [`load-into-local-dsh.md`](load-into-local-dsh.md) — 装进本地 DSH
- [`architecture.md`](architecture.md) — 架构、Realm 模型、威胁模型、插件开发
- [`intent-and-sanitization.md`](intent-and-sanitization.md) — 意图判定 + PII 脱敏详细设计
- [`intent-decision-reference.md`](intent-decision-reference.md) — 三层决策参考手册
- [`version-policy.md`](version-policy.md) — 上游版本策略
- [`PROGRESS.md`](PROGRESS.md) — 实施进度档案（§7.x 全量历史）
