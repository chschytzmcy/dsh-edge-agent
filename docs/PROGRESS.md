# dsh-edge-agent 实施进度报告

> **更新日期**：2026-08-19
> **基线设计文档**：`dsh-edge-agent-design-v6.md`（§ 八 实施计划）
> **版本**：v0.1.0

---

## 一、总体进度

| 阶段 | 完成度 | 状态 |
|---|---|---|
| **M 段（M0–M5）** | ████████████████████ 100% | ✅ 全部完成 |
| **A 段（A1–A8）** | ░░░░░░░░░░░░░░░░░░░░ 0% | 🔲 均未开始 |
| **总体** | ~50% | M 段功能可用，A 段安全为零 |

**M 段代码"裸奔"状态**（设计文档 § 八 明确说明）：
- 明文 HTTPS、明文 JSONL 存储
- API Key 仅环境变量
- 无审计告警、无输入检查、无加密
- 所有安全加固依赖 A 段实现

---

## 二、里程碑逐项状态

| 里程碑 | 主题 | 状态 | Commit | 说明 |
|---|---|---|---|---|
| **M0** | 工程脚手架 | ✅ 完成 | `17330da` | 21 插件 stub + 验证门禁全绿 |
| **M1** | Cloud LLM 直连 | ✅ 完成 | `4c45026` | DeepSeek API 真调用 E2E |
| **M2** | 工具调用 | ✅ 完成 | `8c8499f` | local_file_read / file_write / calculate |
| **M3** | 会话与持久化 | ✅ 完成 | `e97391d` | JSONL 明文持久化（sessions + local-storage + audit-log） |
| **M4** | 多模型 + 路由 | ✅ 完成 | `9ca6fab` | mock + 真 llama.cpp + cloud 三路由共存 |
| **M5** | HTTP API 服务 | ✅ 完成 | `428f8f3` `158769a` | REST + SSE + 会话管理 + 13 项 E2E 测试 |
| **A1** | 输入/输出防护 | 🔲 未开始 | — | `prompt-guard` 始终返回 `{safe: true}` |
| **A2** | 意图路由 + 脱敏 | 🔲 未开始 | — | `intent-router` 硬编码默认值，`sanitizer-pipeline` 透传 |
| **A3** | TCM + 加密层 | 🔲 未开始 | — | `tcm` 所有方法返回空/默认值 |
| **A4** | 零信任通信 | 🔲 未开始 | — | `ohttp-gateway` + `secure-bridge` 均为桩 |
| **A5** | 远程证明 | 🔲 未开始 | — | `attestation` 为桩 |
| **A6** | 主动防御 | 🔲 未开始 | — | `td-bus` 为桩 |
| **A7** | 公网搜索 | 🔲 未开始 | — | `web-search` 返回空数组 |
| **A8** | 语音输入 | 🔲 未开始 | — | `voice-input` 返回空字符串 |

---

## 三、21 个插件实现分类

### ✅ 功能完整（FUNCTIONAL）— 8 个

| 插件 | 行数 | 核心实现 |
|---|---|---|
| **cloud-llm-adapter** | ~195 | 完整 DeepSeek chat-completions 流式客户端，SSE 帧解析，环境变量驱动 API Key |
| **local-llm-adapter** | ~304 | 双模式：`mock`（进程内回显）+ `real`（POST 到 OpenAI 兼容端点），多 Provider 路由 |
| **openai-sse** | ~273 | 共享 SSE 解析器（text delta / tool-call delta / finish reason / terminal chunk） |
| **local-tools** | ~289 | 注册 3 个工具 + 递归下降算术求值器 + 路径白名单 |
| **local-storage** | ~179 | JSONL 持久化 KV 存储，原子写入，内存缓存，序列化写队列 |
| **sessions** | ~191 | 基于 local-storage 的会话 CRUD，TTL 感知，LRU 淘汰 |
| **audit-log** | ~265 | JSONL 环形缓冲区，周期刷新，级别过滤，安全报告生成 |
| **http-api** | ~375 | 真实 HTTP 服务器，5 路由（health/openapi/chat/chat-stream SSE/sessions CRUD），Bearer 认证 |

### ⚠️ 部分实现（PARTIAL）— 3 个

| 插件 | 行数 | 已完成 | 待完成 |
|---|---|---|---|
| **model-router** | ~120 | 前缀路由解析、listAvailable()、isAvailable() | 健康检查、置信度评分、动态模型发现 |
| **tools** (edgeTools) | ~147 | 上游 ctx.tools 读取、按前缀分类 Realm、setRealm() | A2 的 Realm 门控/过滤 |
| **intent-router** | ~98 | 规范服务形状、classifyDefault() 返回默认 Realm | 规则分类、LLM 回退、真正决策逻辑 |

### 🔲 仅结构桩（STRUCTURAL）— 10 个

| 插件 | 行数 | 桩状态 |
|---|---|---|
| **tcm** | ~120 | 加密方法返回空 Uint8Array(32) 或恒等值 |
| **privacy-policy** | ~132 | isAllowed() 永远 true，classifyData() 永远 'public' |
| **prompt-guard** | ~74 | checkInput() 永远 {safe: true} |
| **sanitizer-pipeline** | ~70 | sanitize()/desanitize() 原样返回 |
| **ohttp-gateway** | ~66 | send() 返回空 200，无 HPKE |
| **secure-bridge** | ~74 | sendCloudRequest() 返回 {status: 200, body: null} |
| **attestation** | ~74 | generateToken() 返回空字符串 |
| **td-bus** | ~72 | getThreatLevel() 返回 'normal' |
| **web-search** | ~70 | search() 返回空数组 |
| **voice-input** | ~54 | transcribe() 返回空字符串 |

另有 **plugin-host**（~65 行），`list()` 返回 `[]`，`get()` 返回 `null`。

---

## 四、测试覆盖现状

| 类别 | 数量 | 内容 |
|---|---|---|
| **单元测试** | 16 个文件（`tests/unit/`） | 功能完整插件有行为测试；结构桩仅有形状测试 |
| **里程碑烟雾** | 6 个脚本（`scripts/smoke*.ts`） | M1–M5 各有专用脚本，驱动真实基础设施 |
| **E2E 测试** | `m5-e2e-test.sh` | 13 项端点测试（health/auth/chat/SSE/sessions） |
| **集成测试** | 0 | `tests/integration/` 为空占位 |
| **E2E 框架** | 0 | `tests/e2e/` 为空占位 |

### 测试与实现深度的关联

- **FUNCTIONAL 插件** → 真实行为测试（SSE 解析、算术求值、JSONL 往返、HTTP 路由）
- **PARTIAL 插件** → 部分行为测试（路由解析、listAvailable）
- **STRUCTURAL 插件** → 仅形状测试（name/inject/apply/Config 导出验证）

### 缺失的测试层

- 无集成测试覆盖全量 Cordis 启动序列
- 无多插件协作的端到端测试（除 M5 HTTP API 通过 `ctx.agents.create()` 间接触发）
- 无安全相关测试（A 段开始前不适用）

---

## 五、CI 验证门禁现状

| 门禁 | 脚本 | 状态 |
|---|---|---|
| 适配器边界 | `verify-adapter-boundary.ts` | ✅ 通过（`@deepseek-ai/*` 仅存在于 `src/dsh-adapter/`） |
| 上游版本契约 | `verify-upstream-contract.ts` | ✅ 通过（锁定 `0.1.0-rc.6`） |
| 补丁面一致性 | `verify-patch-surface.ts` | ✅ 通过（`patch-surface.snapshot.json` 同步） |
| 插件规范 | `verify-plugin-spec.ts` | ✅ 通过（所有插件符合 name+inject+Config+apply） |
| 打包完整性 | `verify-package.mjs` | ✅ 通过（npm pack 包含所有 subpath 导出） |

---

## 六、Git 提交历史

```
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

共 11 次提交，M0→M1→M2→M3→M4→M5 里程碑链路清晰。

---

## 七、关键发现

1. **M 段代码"裸奔"**——设计文档明确指出：M 段完成时代码运行时**无加密、无输入检查、无审计告警**。所有安全功能依赖 A 段实现。

2. **`http-api` 是最先进的插件**（~375 行）——M5 封顶之作，完整实现 HTTP 服务器、SSE 流式、认证、会话管理。

3. **`openai-sse.ts` 是共享精品**（~273 行）——完整 SSE 解析器，云端和本地适配器共用，生产级线协议代码。

4. **`cordis.yml` 的 `inject` 声明是"期望性的"**——多个桩插件声明了 `inject: ['tcm', ...]` 但桩实现从未实际调用 TCM 方法。A 段实现时接线已就位。

5. **代码库干净**——仅 5 个 TODO/FIXME 标记，全在预期位置（`tcm.ts` 的 "MVP: stub"、`prompt-guard.ts` 的 "post-MVP"）。桩是有意为之的设计决策。

6. **存储实现为 JSONL 而非 SQLite**——设计文档原文写"明文 SQLite"，但 M3 实际实现使用了 JSONL 文件（`local-storage` 的原子写 + 内存缓存模式）。

---

## 八、下一步建议

按设计文档 A 段顺序和安全影响优先级排列：

| 优先级 | 里程碑 | 内容 | 安全影响 | 预估工作量 |
|---|---|---|---|---|
| 🔴 **P0** | **A1** | `prompt-guard` 实现 5 类攻击拦截 + 输出 PII redact | 目前所有输入直通，零防护 | ~1 人天 |
| 🔴 **P0** | **A2** | `intent-router` Realm 分类 + `sanitizer-pipeline` PII 脱敏 | 目前所有数据默认 CLOUD Realm，无脱敏 | ~2 人天 |
| 🟡 **P1** | **A3** | `tcm` AES-256-GCM 加密 + 存储升级 | 目前存储完全明文（JSONL） | ~2 人天 |
| 🟡 **P1** | **A4** | `ohttp-gateway` + `secure-bridge` OHTTP 通道 | 目前云通信无隐私保护 | ~3 人天 |
| 🟢 **P2** | **A5** | `attestation` TEE 远程证明 | 需 A3 先行 | ~1 人天 |
| 🟢 **P2** | **A6** | `td-bus` 威胁检测 + 自动响应 | 需 A1+A2+A4 | ~1 人天 |
| 🟢 **P2** | **A7** | `web-search` 真实搜索接入 | 功能增强，非安全关键 | ~1 人天 |
| 🟢 **P3** | **A8** | `voice-input` Whisper-tiny 语音 | 需 M4 真实本地 LLM | ~3 人天 |

**简而言之：功能骨架已立，安全灵魂待铸。** M 段证明了"能跑通"，A 段才能实现"能安全地跑"。
