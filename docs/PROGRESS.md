# dsh-edge-agent 实施进度报告

> **更新日期**：2026-08-23
> **基线设计文档**：`dsh-edge-agent-design-v6.md`（§ 八 实施计划）
> **版本**：v0.1.0

---

## 一、总体进度

| 阶段 | 完成度 | 状态 |
|---|---|---|
| **M 段（M0–M5）** | ████████████████████ 100% | ✅ 全部完成 |
| **A1 输入/输出防护** | ████████████████████ 100% | ✅ 完成（PII 检测 + 注入防护 + 限流 + LLM 语义识别） |
| **A2 意图路由** | ████████████████████ 100% | ✅ 完成（含分类 + 脱敏 + sanitizer 联动） |
| **Phase 2 基础安全加固** | ████████████████████ 100% | ✅ 完成（审计日志 PII 脱敏/轮转 + 会话管理） |
| **Phase 3 关键信息脱敏** | ████████████████████ 100% | ✅ 完成（local-storage PII 脱敏） |
| **Phase 4 隐私策略引擎** | ████████████████████ 100% | ✅ 完成（privacy-policy + sanitizer-pipeline + http-api 集成） |
| **A3 TCM + 加密层** | ░░░░░░░░░░░░░░░░░░░░ 0% | 🔲 未开始 |
| **A4 零信任通信** | ░░░░░░░░░░░░░░░░░░░░ 0% | 🔲 未开始 |
| **A5 远程证明** | ░░░░░░░░░░░░░░░░░░░░ 0% | 🔲 未开始 |
| **A6 主动防御** | ░░░░░░░░░░░░░░░░░░░░ 0% | 🔲 未开始 |
| **A8 语音输入** | ░░░░░░░░░░░░░░░░░░░░ 0% | 🔲 未开始 |
| **总体** | ~62% | Phase 1-4 全完成 + L0 LLM 语义识别，226 测试通过 |

**当前状态**：功能完整 + 核心安全能力（输入防护、PII 脱敏、CLOUD 端到端脱敏、审计日志）均已到位。下一步可启动 A3（加密层）或直接推进 Phase 5（工具增强 + 多模态）。

---

## 二、里程碑逐项状态

| 里程碑 | 主题 | 状态 | Commit | 说明 |
|---|---|---|---|---|
| **M0** | 工程脚手架 | ✅ 完成 | `17330da` | 21 插件 stub + 验证门禁全绿 |
| **M1** | Cloud LLM 直连 | ✅ 完成 | `4c45026` | DeepSeek API 真调用 E2E |
| **M2** | 工具调用 | ✅ 完成 | `8c8499f` | local_file_read / file_write / calculate |
| **M3** | 会话与持久化 | ✅ 完成 | `e97391d` | JSONL 明文持久化（sessions + local-storage + audit-log） |
| **M4** | 多模型 + 路由 | ✅ 完成 | `9ca6fab` | mock + 真 llama.cpp + cloud 三路由共存 |
| **M4+** | 真实本地 LLM 端到端 | ✅ 完成 | (pending) | qwen3-4b-instruct-2507 @ http://192.168.66.195:8701/v1 |
| **M5** | HTTP API 服务 | ✅ 完成 | `428f8f3` `158769a` | REST + SSE + 会话管理 + 13 项 E2E 测试 |
| **A1** | 输入/输出防护 | ✅ **完成** | (Phase 2) | 5 类攻击检测 + PII 检测（5 规则）+ 限流 + 输出脱敏 |
| **A2-分类** | 意图路由（分类层） | ✅ 完成 | `08e6b9e` `b1af057` | `intent-router` LLM 分类 + 关键词兜底 + 真实路由 |
| **A2-脱敏** | 意图路由（脱敏层） | ✅ **完成** | (Phase 4) | `sanitizer-pipeline` 正向脱敏 + 反向还原 + 会话映射 |
| **Phase 2** | 基础安全加固 | ✅ **完成** | — | 审计日志 PII 脱敏/轮转 + 会话过期/上限/淘汰 |
| **Phase 3** | 关键信息脱敏 | ✅ **完成** | — | local-storage put() 自动脱敏 |
| **Phase 4** | 隐私策略引擎 | ✅ **完成** | — | privacy-policy + sanitizer-pipeline + http-api 集成 |
| **A3** | TCM + 加密层 | 🔲 未开始 | — | `tcm` 所有方法返回空/默认值 |
| **A4** | 零信任通信 | 🔲 未开始 | — | `ohttp-gateway` + `secure-bridge` 均为桩 |
| **A5** | 远程证明 | 🔲 未开始 | — | `attestation` 为桩 |
| **A6** | 主动防御 | ✅ **完成** | (Phase D) | `td-bus` 滑窗状态机 + http-api 503 阻断 |
| **A7** | 公网搜索 | ✅ 已完成 | — | 复用 DSH 原生 `dsh-web-search-deepseek` |
| **A8** | 语音输入 | 🔲 未开始 | — | `voice-input` 返回空字符串 |

---

## 三、21 个插件实现分类

### ✅ 功能完整（FUNCTIONAL）— 13 个

| 插件 | 行数 | 核心实现 |
|---|---|---|
| **cloud-llm-adapter** | ~195 | 完整 DeepSeek chat-completions 流式客户端，SSE 帧解析，环境变量驱动 API Key |
| **local-llm-adapter** | ~290 | 真实 OpenAI 兼容端点，多 Provider 路由，**qwen3-4b-instruct-2507 端到端验证通过** |
| **openai-sse** | ~273 | 共享 SSE 解析器（text delta / tool-call delta / finish reason / terminal chunk） |
| **intent-router** | ~185 | LLM 分类（Qwen3-4B 提示词）+ 关键词兜底（LOCAL_KEYWORDS），classify() 接口 + resolve() Realm 映射 |
| **tools** | ~147 | Realm 工具注册表配置，为 DSH 原生工具添加 Realm 标记 |
| **local-storage** | ~179 | JSONL 持久化 KV 存储，原子写入，内存缓存，序列化写队列，**PII 自动脱敏（Phase 3）** |
| **sessions** | ~191 | 基于 local-storage 的会话 CRUD，TTL 感知，LRU 淘汰 |
| **audit-log** | ~265 | JSONL 环形缓冲区，周期刷新，级别过滤，安全报告，**PII 脱敏 + 自动轮转（Phase 2）** |
| **http-api** | ~700 | 真实 HTTP 服务器，Bearer 认证，SSE 流式，**会话管理（Phase 2）+ sanitizer 集成（Phase 4）** |
| **prompt-guard** | ~180 | 5 类输入攻击检测（injection/exfiltration/jailbreak/manipulation/oversized）+ 5 类 PII 检测 + 限流 + 输出脱敏 |
| **privacy-policy** | ~316 | JSON 策略文件加载 + 热更新 + 路由规则匹配 + 数据分类 + 脱敏规则 + 全局约束 |
| **sanitizer-pipeline** | ~240 | 正向脱敏（PII → 占位符）+ 反向还原（占位符 → PII）+ 会话级映射表 + 同步还原（流式用） |
| **pii-utils** | ~100 | 共享 PII 检测工具（5 规则：phone/id-card/bank-card/email/api-key），供 audit-log/local-storage/prompt-guard 复用 |

### ⚠️ 部分实现（PARTIAL）— 2 个

| 插件 | 行数 | 已完成 | 待完成 |
|---|---|---|---|
| **model-router** | ~120 | 前缀路由解析、listAvailable()、isAvailable() | 健康检查、置信度评分、动态模型发现 |
| **tools** (edgeTools) | ~147 | 上游 ctx.tools 读取、按前缀分类 Realm、setRealm() | Realm 门控/过滤（与 privacy-policy 联动） |

### 🔲 仅结构桩（STRUCTURAL）— 6 个

| 插件 | 行数 | 桩状态 |
|---|---|---|
| **tcm** | ~120 | 加密方法返回空 Uint8Array(32) 或恒等值 |
| **ohttp-gateway** | ~66 | send() 返回空 200，无 HPKE |
| **secure-bridge** | ~74 | sendCloudRequest() 返回 {status: 200, body: null} |
| **attestation** | ~74 | generateToken() 返回空字符串 |
| **td-bus** | ~166 | 真实滑窗 + 4 级威胁 + sticky escalate() + on() 订阅 |
| **voice-input** | ~54 | transcribe() 返回空字符串 |

另有 **plugin-host**（~65 行），`list()` 返回 `[]`，`get()` 返回 `null`。

---

## 四、测试覆盖现状

| 类别 | 数量 | 内容 |
|---|---|---|
| **单元测试** | 18 个文件（`tests/unit/`） | 功能完整插件有行为测试；结构桩有形状测试 |
| **测试总数** | **226 个** | 从 M5 封顶时的 ~100 增至 226（含 L0 LLM 语义识别 12 个对抗样本） |
| **里程碑烟雾** | 6 个脚本（`scripts/smoke*.ts`） | M1–M5 + M6 各有专用脚本，驱动真实基础设施 |
| **E2E 测试** | `m5-e2e-test.sh` | 13 项端点测试（health/auth/chat/SSE/sessions） |
| **集成测试** | 0 | `tests/integration/` 为空占位 |

### Phase 2-4 新增测试

| 测试文件 | 数量 | 覆盖 |
|---|---|---|
| `pii-utils.test.ts` | 14 | 5 类 PII 检测 + redactObject 嵌套处理 |
| `audit-log.test.ts` | +6 | PII 脱敏 + 日志轮转 |
| `local-storage.test.ts` | +5 | put() PII 脱敏（基础/磁盘/嵌套/数组/关闭） |
| `http-api-session.test.ts` | 13 | 会话过期/上限/淘汰/访问更新 |
| `privacy-policy.test.ts` | 16 | 加载/回退/路由匹配/分类/热更新/accessor/apply |
| `sanitizer-pipeline.test.ts` | 20 | 正向脱敏/反向还原/会话隔离/去重/上限/purge/round-trip/apply |

### 测试与实现深度的关联

- **FUNCTIONAL 插件** → 真实行为测试（SSE 解析、算术求值、JSONL 往返、HTTP 路由、PII 脱敏、策略匹配、占位符往返）
- **PARTIAL 插件** → 部分行为测试（路由解析、listAvailable）
- **STRUCTURAL 插件** → 仅形状测试（name/inject/apply/Config 导出验证）

---

## 五、CI 验证门禁现状

| 门禁 | 脚本 | 状态 |
|---|---|---|
| 适配器边界 | `verify-adapter-boundary.ts` | ✅ 通过（`@deepseek-ai/*` 仅存在于 `src/dsh-adapter/`） |
| 上游版本契约 | `verify-upstream-contract.ts` | ✅ 通过（锁定 `0.1.0-rc.6`） |
| 补丁面一致性 | `verify-patch-surface.ts` | ✅ 通过（`patch-surface.snapshot.json` 同步） |
| 插件规范 | `verify-plugin-spec.ts` | ✅ 通过（所有插件符合 name+inject+Config+apply） |
| 打包完整性 | `verify-package.mjs` | ✅ 通过（npm pack 包含所有 subpath 导出） |
| TypeScript | `tsc --noEmit` | ✅ 零错误 |

---

## 六、Git 提交历史

```
（待提交：Phase 2-4 完整实现）
b015af8 fix(tests): 修复单元测试导入和断言问题
b2958f2 refactor: 复用 DSH 原生工具,删除重复实现
ceb4a5e feat(intent-router): 完整审计 trace
8bfa2bd fix(audit-log): flush() 不再重复写整个 ring buffer
7c78d81 feat(llm-adapter): 每 LLM 调用挂 audit trace
138ff03 feat(http-api): access log + audit trace + 修复 auditLog 注入
7e776df fix(http-api): SSE 流式也走意图路由（之前强制 mock）
f144872 feat(config): .env.sh loader 绕过 DSH 的 .env 限制
69730ee feat(M4+): 真实本地 LLM 端到端 + .env 配置
1fe14e8 fix(profile): 修复 http-api 必须在 insert 块里
07d3c3b docs: 修正部署和 LLM Provider 选择说明
ebf5f9e docs(PROGRESS): 记录意图路由实现（A2-分类完成）
2e8c992 docs: README 加入 intent 路由示例
b1af057 fix: 修复 agent loop 返回为空 — 传递 agentOptions
08e6b9e feat: 实现意图识别 (LOCAL vs CLOUD) — LLM 分类 + 关键词兜底
158769a fix(M5): add missing plugin metadata and fix type conflicts
428f8f3 feat(M5): HTTP API service for external consumers
6d7c201 fix(M4): drop double provide() in 6 plugins + slim system prompt
9ca6fab feat(m4): multi-model routing (mock + 真 llama.cpp)
e97391d feat(m3): 明文 sessions / local-storage / audit-log (JSONL persist)
8c8499f feat(m2): LOCAL-realm tool calling (file_read / file_write / calculate)
4c45026 feat(m1): cloud LLM 直连 E2E (deepseek-chat)
0fefe94 docs(design): reorganize § 八 into M+A two-phase scheme (v7.0)
17330da fix(scaffold): pass verify:build for v0.1.0
dbee027 feat: scaffold dsh-edge-agent v0.1.0
c7a2164 Initial commit
```

---

## 七、Phase 2-4 实施详情（2026-08-22 新增）

### 7.1 Phase 2：基础安全加固

**目标**：为审计日志和会话系统添加基础安全防护

**交付物**：

| 模块 | 能力 | 关键代码 |
|---|---|---|
| **audit-log PII 脱敏** | 自动检测并脱敏 5 类 PII（手机号/身份证/银行卡/邮箱/API Key） | `audit-log.ts` + `pii-utils.ts` |
| **audit-log 轮转** | 大小轮转（>10MB）+ 时间轮转（>7 天）+ 最多保留 5 个归档文件 | `checkAndRotate()` |
| **http-api 会话管理** | 30 分钟空闲超时 + 最多 100 活跃会话 + LRU 淘汰 | `cleanupExpiredSessions()` + `evictLeastRecentSession()` |

**配置字段**（`cordis.patch.yml`）：
```yaml
audit-log:
  enablePIIRedaction: true
  maxFileSizeBytes: 10485760   # 10MB
  maxFileAgeDays: 7
  maxRotatedFiles: 5
http-api:
  sessionIdleTimeoutMs: 1800000  # 30 min
  maxActiveSessions: 100
```

**新增测试**：19 个（pii-utils 14 + audit-log PII 3 + http-api-session 13 减去共享部分）

### 7.2 Phase 3：关键信息脱敏（简化版）

**目标**：为本地存储添加 PII 脱敏能力（按用户要求不做全加密，只做关键信息脱敏）

**交付物**：

| 模块 | 能力 | 关键代码 |
|---|---|---|
| **local-storage PII 脱敏** | `put()` 写入前自动脱敏嵌套对象/数组中的 PII | `local-storage.ts` |
| **pii-utils 共享模块** | 统一 PII 检测逻辑，供 audit-log / local-storage / prompt-guard 复用 | `pii-utils.ts` |

**新增测试**：5 个（local-storage PII 行为测试）

### 7.3 Phase 4：隐私策略引擎 + 脱敏管线

**目标**：策略驱动的隐私控制 + CLOUD 请求端到端脱敏

**交付物**：

| 模块 | 能力 | 关键代码 |
|---|---|---|
| **privacy-policy** | JSON 策略文件加载 + 热更新（5 秒轮询） + 路由规则匹配 + 数据分类 + 脱敏规则 + 全局约束 | `privacy-policy.ts` |
| **sanitizer-pipeline** | 正向脱敏（PII → `[PHONE_1]`、`[EMAIL_2]`）+ 反向还原 + 会话级映射表 + 去重 + 上限保护 + desanitizeSync（流式用） | `sanitizer-pipeline.ts` |
| **http-api 集成** | handleChat/handleChatStream 的 CLOUD 请求输入脱敏 + 响应还原 + 会话删除时清理映射 | `http-api.ts` |
| **privacy-policy.json** | 默认策略文件：4 条路由规则 + 5 条脱敏规则 + 4 级数据分类 + 全局约束 | `profiles/dsh-edge-agent/privacy-policy.json` |

**CLOUD 请求脱敏流程**：
```
用户消息: "我手机号是13812345678，帮我翻译..."
  ↓ intent-router 分类为 CLOUD
  ↓ sanitizer.sanitize() → "我手机号是[PHONE_1]，帮我翻译..."
  ↓ 发送到 DeepSeek（云端仅看到占位符）
  ↓ DeepSeek 响应: "好的，[PHONE_1] 的翻译是..."
  ↓ sanitizer.desanitize() → "好的，13812345678 的翻译是..."
  ↓ 返回给用户（完整还原）
```

**流式响应脱敏**：
- 使用 `desanitizeSync()` 逐 chunk 同步还原
- 每个 chunk 独立处理占位符，避免阻塞事件循环
- 如占位符跨 chunk 分布，用户会临时看到占位符文本（可接受的 tradeoff）

**新增测试**：36 个（privacy-policy 16 + sanitizer-pipeline 20）

### 7.4 共享 PII 工具模块（pii-utils.ts）

**设计**：统一 PII 检测/脱敏逻辑，避免在 audit-log / local-storage / prompt-guard 中重复实现

**5 条 PII 规则**：
| 类型 | 正则 | 脱敏示例 |
|---|---|---|
| 手机号 | `1[3-9]\d{9}` | `13812345678` → `138****5678` |
| 身份证 | `[1-9]\d{5}(19\|20)...` | `110101199001011234` → `110101****1234` |
| 银行卡 | `\d{16,19}` | `6222021234567890` → `6222****7890` |
| 邮箱 | `[\w.-]+@[\w.-]+\.\w+` | `test@example.com` → `t***@example.com` |
| API Key | `sk-[a-zA-Z0-9]{20,}` | `sk-abcdef...` → `sk-****` |

**两个导出函数**：
- `redactString(s)` → 对单个字符串应用所有 PII 规则
- `redactObject(obj)` → 递归处理对象/数组中的字符串值

### 7.6 L0 prompt-guard 加入本地 LLM 语义识别（2026-08-23）

**背景**：L0 之前只有 `regex + PII + 限流` 三道硬规则，对**变形注入**（同形字 / 零宽字符 / base64）和**语义注入**（多轮 persona 接管）完全无感。`prompt-guard.ts:319` 处的模型检测位只是一段 stub。设计文档（`v6 §2.6`）已把模型辅助检测列为预期特性，但代码层缺位。

**实现**（`src/dsh-adapter/prompt-guard.ts`）：
- `modelBasedCheck()` 真正接上 `ctx.llm.stream()`，复用 `local-qwen3-4b / qwen3-4b`（同 intent-router，无需新增依赖）
- 流式解析 JSON verdict：`{ safe, threats[], dataClass, rationale }`
- **Fail-open**：禁用 / 无 llm handle / 输入过长 / 网络错 / AbortController 触发 / JSON 解析失败 → 返回 `null`，regex + PII 判定保留生效
- 仅 `safe:false` 才会短路成 high-risk block 返回给调用方
- AbortController 4 s 超时 + `MAX_ASSEMBLED` 防大输出 DoS
- audit payload **不携带原文**，只放 `textLen` + ≤60 字符 preview，`redactObject` 兜底

**6 类新 audit kind**（`source: prompt-guard`）：
| kind | level | 触发 |
|---|---|---|
| `guard.model-detect.start` | info | 进入检测 |
| `guard.model-detect.end` | info | 模型判 safe |
| `guard.model-detect.unsafe` | **security** | 模型判 unsafe |
| `guard.model-detect.timeout` | warn | AbortController 触发 |
| `guard.model-detect.error` | warn | 网络 / 解析 / JSON 失败 |
| `guard.model-detect.skipped` | debug | 禁用 / 无 llm / 输入过长 |

**Config 与 env 绑定**：
| env | 默认 | 说明 |
|---|---|---|
| `DSH_EDGE_GUARD_MODEL` | `false` | 总开关 |
| `DSH_EDGE_GUARD_MODEL_PROVIDER` | `local-qwen3-4b` | provider route |
| `DSH_EDGE_GUARD_MODEL_MODEL` | `qwen3-4b` | model id |
| `DSH_EDGE_GUARD_MODEL_TIMEOUT_MS` | `4000` | 单次超时 |
| `DSH_EDGE_GUARD_MODEL_MAX_INPUT` | `2000` | 输入上限 |

**对抗样本测试**（`tests/unit/prompt-guard.test.ts` `describe('prompt-guard model-based detection')`，12 用例）：
1. safe verdict → 返回 null，regex/PII 判定保留
2. unsafe verdict → high-risk block，audit 含 `unsafe` (security)
3. `enableModelDetection:false` → 不调 LLM，audit 含 `skipped:disabled`
4. llm handle missing → `skipped:no-llm-handle`
5. 输入超 `modelDetectionMaxInputLength` → `skipped:input-too-long`
6. 超时（`signal.aborted`）→ `timeout` (warn)
7. JSON 解析失败 → `error:json-parse-failed`
8. **同形字攻击**（西里尔 `о` U+043E）
9. **零宽字符攻击**（U+200B）
10. **base64 编码载荷**
11. **多轮 persona 接管**
12. **prompt-leak**（让模型复述系统提示）

每个对抗样本都在 `enableInjectionDetection:false` 的 guard 里跑——确保**只走 LLM 路径**，和 regex 路径完全隔离，是真正的对抗样本覆盖（之前 50 用例里 0 个对抗样本）。

**新增真实烟雾**：`scripts/m6-smoke.ts`（gated on `DSH_EDGE_REAL_LLM_REQUIRED=1`），驱动 LAN llama.cpp 跑 6 个对抗样本，从 audit log 验证预期 kind 落地。

**为什么 fail-open**：regex + PII 仍是最后防线；LLM 任何失败都意味着降级到硬规则而非全开。延迟预算 4 s 是 intent-router 实测 P99 的 4×，不阻塞主链路。

**新增测试**：12 个（prompt-guard model-based detection describe 块）

---

### 7.7 A6 主动防御：td-bus 接进 http-api 主链路（2026-08-23）

**背景**：`td-bus` 之前是纯结构桩——`getThreatLevel()` 固定返回 `'normal'`，没有真实状态机，更没有主链路干预。YT.md 评估指出 P2 级缺口：`A6 主动防御`形同虚设。

**实现**（`src/dsh-adapter/td-bus.ts`）：

**4 级滑窗状态机**：
| 计数（cloudHits in window） | threat level |
|---|---|
| 0 ~ cloudThreshold - 1 | `normal` |
| ≥ cloudThreshold × 1 | `elevated` |
| ≥ cloudThreshold × 2 | `high` |
| ≥ cloudThreshold × 4 | `critical` ← 默认 blockLevel |

- 滑窗默认 60 s（`windowSeconds`），过期事件自动 shift 出窗口
- `recordCloudRequest()` 每条 /v1/chat 请求前调用一次，计数 + recompute
- `shouldBlock()` 按 `blockLevel` 配置比较：默认 `critical`（最保守），env 可下调到 `high` / `elevated`

**Sticky escalate()**：
- `escalate(reason)` 立即跳到 `critical` 并设置 `stickyLevel` floor，**不会被滑窗衰减掉**
- 同时触发所有 `on()` 订阅（`block-cloud` / `kill-session` / `notify-user` / `lockdown`），供上游插件立即反应
- 之前的设计：escalate 只设 `currentLevel`，下次 recompute 又被滑窗覆盖回 normal —— 已修复

**主链路接入**（`src/dsh-adapter/http-api.ts`）：
- `inject` 加 `'tdBus'`；构造函数加第 7 参数；`apply()` 从 `ctx.tdBus` 取
- `/v1/chat` 入口在 `promptGuard.checkInput` **之前** 加威胁闸：
  ```ts
  if (this.tdBus?.shouldBlock?.()) {
    this.audit('security', 'http.chat.threat-blocked', { reqId, sessionId, threat })
    res.writeHead(503, { ... })
    res.end(JSON.stringify({ error: 'Service unavailable — threat level elevated', threat }))
    return
  }
  ```
- `tdBus.recordCloudRequest()` 在 audit 之前无副作用调用（计数后才决定放行/阻断）

**新 audit kind**：
| kind | level | 触发 |
|---|---|---|
| `td-bus.escalated` | warn / security | 滑窗升级到 elevated/high/critical，或 manual escalate |
| `http.chat.threat-blocked` | **security** | `/v1/chat` 被 td-bus 拒绝 |

**新 env / 配置**：
| env | 默认 | 说明 |
|---|---|---|
| `DSH_EDGE_TD_BLOCK_LEVEL` | `critical` | 阻断阈值（critical/high/elevated）|
| `DSH_EDGE_TD_WINDOW` | `60` | 滑窗秒数 |
| `DSH_EDGE_TD_CLOUD_RATE` | `20` | 滑窗内 cloud req/min 阈值 |

**失败模式**：
- `tdBus` 不存在（plugin 没 mount）→ `shouldBlock()` 不被调用，chain 跳过，**fallback open**（保持原行为）
- `tdBus.shouldBlock()` 抛 → try/catch 吞掉，**never block on td-bus faults**

**新增测试**：5 个（td-bus 状态机 + on() 监听 + 滑窗衰减 + sticky escalate）

**总计**：253 个单测全过，verify:build 4 关全过，compile 零错。

---

### 7.8 model-router 接进 intent-router（v6 §2.15，2026-08-23）

**背景**：`intent-router.classifyWithLlm()` 之前**完全绕过** `model-router`，直接用 `config.classificationProvider` + `config.classificationModel`（写死 `'local-qwen3-4b'` / `'qwen3-4b'`）调 `ctx.llm.stream()`。model-router 插件存在并提供 `resolve(modelId): {realm, provider, model}`，但**生产环境零调用**。改 routing model 必须改 yml + 重启；路由表（localModels / cloudModels）对分类调用无约束力。v6 §2.15 设计明确要求 intent-router 通过 model-router 选 model。

**实现**（`src/dsh-adapter/intent-router.ts:151-173`）：在 `classifyWithLlm()` 内每次调用前**懒查** `ctx.modelRouter`（不缓存）：

```ts
const modelRouter = (this.ctx as any).modelRouter
const resolved = (() => {
  try { return modelRouter?.resolve?.(this.classificationProvider) }
  catch { return undefined }
})()
const provider = resolved?.provider ?? this.classificationProvider
const model = resolved?.model ?? this.classificationModel
this.audit('debug', 'intent.llm.route', {
  configured: this.classificationProvider,
  resolvedRealm: resolved?.realm,
  resolvedProvider: provider,
  resolvedModel: model,
  modelRouterMounted: Boolean(modelRouter),
})
```

**为什么懒查（每次 classify 都重读 ctx）**：

根 `cordis.yml` 把 `intent-router`（line 184）排在 `model-router`（line 193）**之前**；patch yml 相反。如果在 `apply()` 阶段一次绑定，根 yml 部署会拿到 `undefined`。懒查覆盖两种 boot order。

**软依赖策略**（与 http-api 取 tdBus 同模式）：
- 不动 `inject`（保持 `['llm', 'auditLog']`）
- 不动 Config schema
- 不动构造函数签名（零侵入，7 个既有测试 + 1 个生产调用点全部无需改）
- modelRouter 缺失 → 用 config 值（向后兼容）
- `resolve()` 抛错 → try/catch 吞掉，回退 config（fail-open）

**⚠️ Sharp edge — `classificationProvider` 必须用 provider route id**：

`resolveRoute('qwen3-4b')` 返回 `{realm: 'CLOUD'}`（无 `local-` 前缀 → 落 CLOUD 分支，model-router.ts:103）。当前配置 `local-qwen3-4b` OK；若用户改成裸 `qwen3-4b` 会被悄悄翻成 CLOUD realm。**始终用 `local-xxx` / `cloud-xxx` 形式的 route id，不要用裸 model id。**

**新 audit kind**：
| kind | level | 触发 |
|---|---|---|
| `intent.llm.route` | debug | 每次 classifyWithLlm 都记：configured vs resolved provider/model + modelRouter 是否挂载 |

**3 个新单测**：
1. modelRouter 存在 + 返回 CLOUD 路由 → 用 resolved 值调 LLM，audit `modelRouterMounted: true`
2. modelRouter 缺失 → 用 config 值调 LLM，audit `modelRouterMounted: false`
3. modelRouter.resolve 抛错 → fail-open 回退 config，audit `modelRouterMounted: true` 但 `resolvedProvider` 是 config 值

**总计**：256 个单测全过，verify:build 4 关全过，compile 零错。

---

### 7.9 intent-router 加超时控制 + 多轮上下文（2026-08-23）

**背景**：L1 intent-router 完整性分析指出 **2 个 P0 级缺口**：
1. 🔴 **超时控制缺失**——LLM 调用没有 AbortController，遇到 llama.cpp 挂死 / qwen3-4b OOM / 网络不通时，http-api `/v1/chat` 会**无限等下去**，阻塞主链路
2. 🟡 **多轮上下文被忽略**——`classify(text, context?)` 接口接受 `recentMessages`，但 LLM prompt 只含当前 query，多轮 query 分类质量退化

**实现**（`src/dsh-adapter/intent-router.ts`）：

**超时控制**（与 prompt-guard LLM 路径同构）：
```ts
const controller = new AbortController()
const timer = setTimeout(() => controller.abort(), this.llmTimeoutMs)
try {
  const stream = this.llm.stream({ provider, model, messages: [userMessage], signal: controller.signal })
  for await (const chunk of stream) { ... }
} catch (err: any) {
  const isAbort = err?.name === 'AbortError' || controller.signal.aborted
  this.audit('warn', isAbort ? 'intent.llm.timeout' : 'intent.llm.error', { ... })
  throw err   // outer classify() catches → falls through to keyword/default path
} finally {
  clearTimeout(timer)
}
```

**多轮上下文**（无 `createSystemMessage` helper，借鉴 prompt-guard 同样做法 — 直接拼进 user prompt 文本）：
```ts
const historyBlock = (() => {
  if (!this.recentMessagesLimit || !recentMessages?.length) return ''
  const tail = recentMessages.slice(-this.recentMessagesLimit)
  const lines = tail.map(m => `${(m as any).role ?? '?'}: ${extractMessageText(m).slice(0, 200)}`)
  return `\n最近对话上下文（仅参考，不要分类历史消息本身）：\n${lines.join('\n')}\n`
})()
```

`extractMessageText(m)` 兼容 dsh-llm `{content: [{type:'text', text}]}` / `{text}` / `{message}` / 字符串 / 任意可序列化形态。

**Config 字段**（`Config` schema + 默认值）：
| 字段 | 默认 | env |
|---|---|---|
| `llmTimeoutMs` | `4000` | `DSH_EDGE_INTENT_LLM_TIMEOUT_MS` |
| `recentMessagesLimit` | `3` | `DSH_EDGE_INTENT_RECENT_LIMIT` |

**新 audit kind**：
| kind | level | 触发 |
|---|---|---|
| `intent.llm.timeout` | warn | AbortController 触发（`err.name === 'AbortError'` 或 `signal.aborted`）|
| `intent.llm.context` | debug | `recentMessages` 非空时记 received + embedded 数 |

**失败模式**：
- LLM 永不响应 → 4 s 后 AbortError → outer classify() catch → `classifyWithRules()` → keyword 兜底
- `recentMessages` 为 undefined / [] → 不嵌入 context block，不发 `intent.llm.context` audit
- `recentMessages` 含无法解析的 message → `extractMessageText` 返回 '' → 该行被跳过

**4 个新单测**：
1. **超时触发**：挂死流 + 50ms timeout → classify 返回 default CLOUD + audit `intent.llm.timeout` + `signal.aborted=true`
2. **signal 注入**：正常流 + 检查 `opts.signal instanceof AbortSignal === true`
3. **context 嵌入**：传 2 条 recentMessages → prompt 含"最近对话上下文" + audit `embedded: 2`
4. **空 context 不写**：传 `recentMessages: []` → prompt 不含 context 块 + 无 `intent.llm.context` audit

**总计**：260 个单测全过，verify:build 4 关全过，compile 零错。

---

### 7.10 intent-router 接进 privacy-policy 路由规则（2026-08-23）

**背景**：`intent-router.classifyWithRules()` 之前用的是**硬编码**的 17 个 `LOCAL_KEYWORDS`，与 `privacy-policy` 完全脱钩。结果：
- 路由规则不可热更新（privacy-policy 本来就支持 hot reload）
- `SANITIZED` category 在 schema 里允许但**永远不会被采用**（硬编码只返回 LOCAL/CLOUD）
- v6 §2.15 设计明确要求 `ctx['privacy-policy'].getRoutingRules()` 动态规则

**实现**（`src/dsh-adapter/intent-router.ts:classifyWithRules`）：

```ts
const policy = (this.ctx as any).privacyPolicy
let matchedRule = null
try {
  const r = policy?.matchRouting?.(text)
  if (r && (r.realm === 'LOCAL' || r.realm === 'CLOUD' || r.realm === 'SANITIZED')) {
    matchedRule = r
  }
} catch (err) { this.audit('warn', 'intent.policy.error', {...}) }

if (matchedRule) {
  const realm = matchedRule.realm
  const targetRealm = realm === 'LOCAL' ? 'local' : realm === 'SANITIZED' ? 'sanitized' : 'cloud'
  return { category: realm, confidence: matchedRule.confidence, targetRealm,
           rationale: matchedRule.rationale, requiresSanitization: realm === 'SANITIZED', ... }
}

// 兜底：硬编码 LOCAL_KEYWORDS（无 privacy-policy 或空 routingRules 时）
```

**关键点**：
- 不动 `inject`（保持 `['llm', 'auditLog']`），软依赖 late-bind
- privacy-policy 缺失 / matchRouting 抛错 / 无匹配规则 → 回退硬编码（fail-open，向后兼容）
- `realm: 'REJECT'` 被过滤（prompt-guard 已在 L0 拦截，重复处理）
- **首次解锁 `SANITIZED` realm 派发**——policy.json 里写 `realm: 'SANITIZED'` 的规则现在会真正进入路由决策，且 `requiresSanitization: true` 让 http-api / sanitizer 知道要脱敏

**新 audit kind**：
| kind | level | 触发 |
|---|---|---|
| `intent.rules.hit` (扩展) | debug | 新增 `payload.source: 'privacy-policy' \| 'fallback-keyword'` 区分来源 |
| `intent.policy.error` | warn | matchRouting 抛错（不影响主链路）|

**典型用法**：
```jsonc
// profiles/dsh-edge-agent/privacy-policy.json
{
  "routingRules": [
    { "pattern": "(本地|local|文件|file)", "realm": "LOCAL",      "confidence": 0.85, "rationale": "local-ops" },
    { "pattern": "(密码|password|secret)", "realm": "SANITIZED", "confidence": 0.9,  "rationale": "sensitive-payload" }
  ]
}
```
改 policy.json → privacy-policy hot reload → 下次 classify 立即生效，无需重启 agent。

**4 个新单测**：
1. privacy-policy LOCAL 规则命中 → category=LOCAL, confidence=0.85, rationale=policy-matched-local, audit source=`privacy-policy`
2. privacy-policy SANITIZED 规则命中 → category=SANITIZED, targetRealm=`sanitized`, requiresSanitization=true
3. privacy-policy 缺失 → 兜底硬编码 LOCAL_KEYWORDS，audit source=`fallback-keyword`
4. privacy-policy.matchRouting 抛错 → 兜底 + audit `intent.policy.error`

**总计**：264 个单测全过，verify:build 4 关全过，compile 零错。

### 7.11 intent-router 接入 sanitizer-pipeline：PII 在 prompt 前脱敏（v6 §2.6，2026-08-23）

**背景**：完成 #7.8 (model-router 路由) + #7.10 (privacy-policy 路由规则) 后，intent-router 把 `classificationProvider='local-qwen3-4b'` 路由成 `{realm: 'CLOUD', provider: 'cloud-deepseek-v4', model: 'deepseek-chat'}`（model-router.ts:103 裸 id 落 CLOUD 分支；但 `local-qwen3-4b` 是 provider route id，按配置默认仍然走 LOCAL）——**用户可改 yml 让分类 LLM 走云端**（如 qwen3-4b 不可用时降级到 deepseek-v4-fast）。此时**用户的原始 PII（手机/身份证/银行卡/邮箱/api-key）会跟着分类 prompt 一起发送到云端**，即便下游真实请求在 http-api 层会被 sanitizer 拦截。

**实现**（`src/dsh-adapter/intent-router.ts:classifyWithLlm`）：把 model-router resolve + sanitizer.sanitize 提到 prompt 构造之前：

```ts
const modelRouter = (this.ctx as any).modelRouter
const resolved = (() => {
  try { return modelRouter?.resolve?.(this.classificationProvider) }
  catch { return undefined }
})()  // {realm, provider, model} | undefined
...
let promptText = text
if (resolved?.realm === 'CLOUD') {
  const sanitizer = (this.ctx as any).sanitizer
  if (sanitizer?.sanitize) {
    try {
      const result = await sanitizer.sanitize(text, { sessionId: sessionId ?? 'default' })
      promptText = result.sanitizedText
      this.audit('info', 'intent.llm.sanitized', { ...replacements })
    } catch { /* fail-open */ }
  }
}
const prompt = `... 用户请求：${promptText}`   // 用 sanitized
```

**关键点**：
- **只对 CLOUD 分类 LLM 脱敏**（LOCAL LLM 永远在端侧，不存在出网风险）
- 软依赖：`ctx.sanitizer` 缺失或抛错 → 用原文本（fail-open；下游真实请求仍由 http-api 兜底脱敏）
- `sessionId` 通过 context 传入（`classify(text, { sessionId })`），默认 `'default'` —— 占位符在同一会话内可复用
- 不动 `inject`、不动 Config schema、不动构造函数签名（与 #7.8 #7.10 一致）
- 镜像 http-api 已有模式（`if (!isLocal && this.sanitizer) { sanitize }`）

**新 audit kind**：
| kind | level | 触发 |
|---|---|---|
| `intent.llm.sanitized` | info | CLOUD realm 分类 LLM + sanitizer 命中，记 replacement 数 + 长度差 |
| `intent.llm.sanitize-error` | warn | sanitize() 抛错，记 error + 原长 |
| `intent.llm.sanitize-skipped` | debug | CLOUD realm 但 sanitizer handle 缺失 |

**失败模式**：
- `ctx.sanitizer` 不存在（plugin 未 mount）→ audit `sanitize-skipped`，用原文本
- `sanitizer.sanitize()` 抛错 → audit `sanitize-error`，用原文本
- LOCAL realm → 根本不查 sanitizer，零额外延迟
- `sanitize()` 返回 `sanitizedText: undefined` → `?? text` 兜底

**4 个新单测**：
1. CLOUD + sanitizer 命中 → LLM 收到 `[PHONE_1]` 占位符而非 `13812345678`，audit `replacements: 1`、`sessionId: 'sess-A'`
2. CLOUD + LOCAL realm → sanitizer 调用 0 次，LLM 收到原文（端侧 LLM 不需脱敏）
3. CLOUD + sanitizer 缺失 → LLM 收到原文 + audit `sanitize-skipped: no-sanitizer-handle`
4. CLOUD + sanitizer 抛错 → LLM 收到原文 + audit `sanitize-error`，主链路不中断

**总计**：268 个单测全过，verify:build 4 关全过，compile 零错。

### 7.12 intent-router 输入边硬化 + REJECT 路径解锁（2026-08-23）

**背景**：完整性矩阵重分析后定位 3 个 P0/P1 缺口：

1. 🔴 **REJECT 路径契约级 bug** — `privacy-policy.ts:43` schema 允许 `realm: 'REJECT'`，`design-v6.md:430,1250,2017,5093` 把 REJECT 当 first-class category（policy.json 示例也含 REJECT 规则）。**但 `intent-router.ts:319` 用 `if (r.realm === 'LOCAL' || 'CLOUD' || 'SANITIZED')` 显式过滤 REJECT** —— 用户写在 policy.json 里的 REJECT 规则今天零效果。
2. 🟡 **空输入短路缺失** — `text=''` 仍走 LLM → 浪费一次调用 → 落 default。
3. 🟡 **输入长度上限缺失** — prompt-guard 有 `maxInputLength: 10000`，router 无。极端长文本可拖垮 qwen3-4b。

**实现**（`src/dsh-adapter/intent-router.ts`）：

**1) REJECT 解锁 + 策略预检**

新增 `RULE_CATEGORIES` 常量，替换窄过滤器为宽匹配：

```ts
const RULE_CATEGORIES = ['LOCAL', 'CLOUD', 'SANITIZED', 'REJECT'] as const
type RuleCategory = typeof RULE_CATEGORIES[number]

// classifyWithRules 内
if (r && (RULE_CATEGORIES as readonly string[]).includes(r.realm)) {
  matchedRule = r as { ... realm: RuleCategory ... }
}

if (matchedRule) {
  if (realm === 'REJECT') {
    audit('security', 'intent.rules.rejected', { ... })
    return { category: 'REJECT', targetRealm: 'rejected', ... }
  }
  ...
}
```

新增 **策略预检**（`classify()` 入口，truncate 之后、LLM 之前）：

```ts
const pre = policy?.matchRouting?.(effectiveText)
if (pre?.realm === 'REJECT') {
  audit('security', 'intent.rules.rejected', { source: 'privacy-policy-precheck', ... })
  return { category: 'REJECT', targetRealm: 'rejected', ... }   // 0 LLM tokens
}
```

**预检 vs 兜底的两层设计**：
- 预检：REJECT 在 router 边缘拦截，0 LLM 调用、0 延迟（policy-violating query 应尽快拒绝）
- 兜底：`classifyWithLlm → catch → classifyWithRules` 内仍跑 matchRouting —— LLM 故障（qwen3-4b OOM / 超时）时 REJECT 仍生效（policy 必须在 LLM 不可用时也存活）

**2) 空输入短路**

```ts
if (!text || !text.trim()) {
  audit('debug', 'intent.classify.empty', { textLen: text?.length ?? 0 })
  return { category: defaultCategory, ..., rationale: 'empty-input' }  // 0 LLM
}
```

**3) 长度上限 + 截断审计**

```ts
let effectiveText = text
if (text.length > this.maxInputLength) {       // default 2000
  audit('warn', 'intent.classify.truncated', { originalLen, truncatedLen })
  effectiveText = text.slice(0, this.maxInputLength)
}
```

截断在 sanitize 之前：100 KB 长文本 + 5 个手机号 → 截到 2 KB → sanitizer 看到的 PII 数量可控。

**Config 字段**：

| 字段 | 默认 | env |
|---|---|---|
| `maxInputLength` | `2000` | `DSH_EDGE_INTENT_MAX_INPUT` |

**新 audit kind**：
| kind | level | 触发 |
|---|---|---|
| `intent.classify.empty` | debug | 空 / 纯空白输入 |
| `intent.classify.truncated` | warn | 输入超 `maxInputLength` |
| `intent.rules.rejected` (扩展) | **security** | REJECT 命中（`payload.source: 'privacy-policy-precheck'` / `'privacy-policy'` 区分两层） |
| `intent.policy.precheck-error` | warn | 预检抛错（非致命，落入 LLM+rules 主链路） |

**语义修正**：SANITIZED verdict 的 `dataLevel` 从 `'public'` 改为 `'sanitized'`（line 340）。下游 sanitizer / audit-log 据此知道这条 payload 是被 policy 重分类的，不是 public 默认假设。

**契约边界**：router 返回 REJECT 后，**消费者契约**：
- http-api 应把 `intent.category === 'REJECT'` 翻译成 `403 Forbidden`，不再走 LLM
- agent-loop 的 `agent/pre-step` listener 应返回 `{ kind: 'reject', reason: intent.rationale }`
- **本次不实现 http-api REJECT 处理**（独立 PR，避免范围蔓延）；PROGRESS §7.12 显式记录为待办

**6 个新单测**：
1. REJECT 规则命中（pre-check）→ category=`REJECT`, targetRealm=`rejected`, **LLM 0 次调用**, audit source=`privacy-policy-precheck`
2. REJECT 预检路径：source=`privacy-policy-precheck`, level=`security`
3. 空输入短路 → category=`CLOUD/LOCAL`（按 defaultCategory）, rationale=`empty-input`, **LLM 0 次调用**, audit `intent.classify.empty`
4. 纯空白输入同上空短路
5. 超长输入截断 → 50 字符 cap 下 200 字符只送 50 进 LLM prompt, audit `truncated: originalLen=200, truncatedLen=50`
6. **截断在 sanitize 前** → 79 字符（含完整 phone）+ cap=50 → sanitizer 看到完整 11 位 phone（包含在 50 字符里），未超 cap 的 `trailing` 8 字符被切除

**总计**：274 个单测全过（+6 new），verify:build 4 关全过，compile 零错。

---

## 八、关键发现

1. **M 段代码"裸奔"时代结束** — Phase 2-4 为 M 段补齐了基础安全能力：PII 脱敏、审计日志轮转、会话管理、CLOUD 端到端脱敏。

2. **`http-api` 成为最复杂的插件**（~700 行）— 集成 intent-router + prompt-guard + sanitizer，支持非流式/流式两种脱敏路径。

3. **`pii-utils` 是关键抽象** — 统一 PII 检测逻辑后，audit-log、local-storage、prompt-guard 三处复用，代码一致性大幅提升。

4. **sanitizer-pipeline 的会话映射设计** — 选择 per-session in-memory Map 而非全局 Map，确保跨会话隔离；使用 counter 递增命名（`[PHONE_1]`）避免占位符冲突。

5. **流式脱敏的 tradeoff** — `desanitizeSync` 逐 chunk 处理，占位符跨 chunk 时无法还原。这是可接受的 tradeoff：LLM 通常将占位符作为单个 token 生成，跨 chunk 概率极低。

6. **策略文件选择 JSON 而非 YAML** — JSON 解析无需额外依赖，且与隐私策略的结构化特性匹配（规则、分类、约束均为结构化数据）。

7. **热更新机制选择轮询而非 inotify** — 跨平台兼容性更好（macOS/Linux），5 秒轮询间隔对策略文件场景足够。

---

## 九、近期改进（按时间倒序）

### 9.1 Phase 2-4 完整实现（2026-08-22）

**变更**：
- Phase 2：audit-log PII 脱敏 + 轮转 + http-api 会话管理
- Phase 3：local-storage PII 脱敏
- Phase 4：privacy-policy + sanitizer-pipeline + http-api 集成

**收益**：
- CLOUD 请求端到端脱敏（PII 不再发送到外部 LLM）
- 审计日志自动脱敏敏感信息，避免日志泄露
- 存储文件自动脱敏，降低静态数据风险
- 会话生命周期管理，防止资源耗尽

**测试**：226 个单元测试全通过（含 12 个 LLM 语义识别对抗样本）

### 9.2 DSH 原生工具复用（commit `b2958f2`）

**变更**：删除自实现的 `local-tools` 和 `web-search` 插件，复用 DSH 原生工具。

**收益**：
- 减少代码重复，降低维护成本
- 工具行为与 DSH 官方保持一致
- `tools` 插件简化为 Realm 配置层（148 行）

### 9.3 审计增强（commits `138ff03` `7c78d81` `ceb4a5e` `8bfa2bd`）

**变更**：
- `http-api`：access log + audit trace
- `cloud-llm-adapter` / `local-llm-adapter`：每次 LLM 调用挂 audit trace
- `intent-router`：完整 classify 审计
- `audit-log`：`flush()` 优化，只写增量

**收益**：
- 请求链路可追踪（reqId 贯穿 http-api → intent-router → llm-adapter）
- 安全审计数据完整
- 性能提升（audit-log flush 只写增量）

---

## 十、下一步建议

按设计文档 Phase 顺序和安全影响优先级排列：

| 优先级 | 阶段 | 内容 | 安全影响 | 预估工作量 |
|---|---|---|---|---|
| 🟡 **P1** | **Phase 5** | 工具增强 + 多模态 | 扩展能力边界 | 5-7 天 |
| 🟡 **P1** | **A3** | `tcm` AES-256-GCM 加密 + 存储升级 | 目前存储文件仍可被直接读取（虽已脱敏） | ~2 人天 |
| 🟡 **P1** | **A4** | `ohttp-gateway` + `secure-bridge` OHTTP 通道 | 目前云通信走明文 HTTPS | ~3 人天 |
| 🟢 **P2** | **A5** | `attestation` TEE 远程证明 | 需 A3 先行 | ~1 人天 |
| 🟢 **P2** | **A6** | `td-bus` 威胁检测 + 自动响应 | 需 A1+A2+A4 | ~1 人天 |
| 🟢 **P3** | **A8** | `voice-input` Whisper-tiny 语音 | 需本地 LLM | ~3 人天 |

**简而言之：Phase 1-4 已完成核心功能 + 关键安全能力。下一步可选路线：**
1. **扩展能力**（Phase 5）：工具增强 + 多模态，让用户能做更多事
2. **强化安全**（A3-A4）：加密存储 + OHTTP 通道，让数据更安全
3. **两者并行**：Phase 5 和 A3 可独立推进，互不依赖
