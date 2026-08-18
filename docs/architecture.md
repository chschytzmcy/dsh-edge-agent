# dsh-edge-agent 架构设计

> 版本：v0.1.0 · 最后更新：2026-08-18

## 🎯 设计目标

`dsh-edge-agent` 的核心目标是在**用户设备**上运行一个**隐私优先**的 AI 智能体，同时保持与云端 LLM 的协作能力。具体目标包括：

1. **数据最小化**：敏感数据不离开设备
2. **零信任通信**：云端无法将请求与用户关联
3. **可验证安全**：通过 TEE 提供远程证明
4. **可扩展架构**：通过 Cordis 插件机制支持自定义能力

## 🏛️ 总体架构

dsh-edge-agent 的架构分为**四层**：

```
┌─────────────────────────────────────────────────────────┐
│ Layer 4: 用户交互层                                      │
│   - CLI / HTTP API / Voice                              │
├─────────────────────────────────────────────────────────┤
│ Layer 3: 智能体层（DSH Agent Loop）                       │
│   - agents, llm, tools, sessions                        │
├─────────────────────────────────────────────────────────┤
│ Layer 2: 隐私控制层（dsh-edge-agent 核心）                │
│   - intent-router, prompt-guard, sanitizer-pipeline     │
│   - privacy-policy, audit-log, td-bus                  │
├─────────────────────────────────────────────────────────┤
│ Layer 1: 安全基座层                                       │
│   - tcm, local-storage, attestation                     │
│   - ohttp-gateway, secure-bridge                        │
└─────────────────────────────────────────────────────────┘
```

每一层都向下调用，不允许反向依赖。

## 🔌 插件树

dsh-edge-agent 由 **19 个核心插件 + 1 个可选 http-api** 组成。所有插件都遵循 Cordis 的 `name` + `inject` + `Config` + `apply` 模式。

### 依赖关系图

```
                  tcm (可信计算)
                    │
        ┌───────────┼───────────┐
        │           │           │
   local-storage  attestation  audit-log
        │           │           │
        └─────┬─────┘           │
              │                 │
         sessions          privacy-policy
              │                 │
              └────────┬────────┘
                       │
                  tools (Realm-aware)
                       │
        ┌──────────────┼──────────────┐
        │              │              │
  local-tools    web-search     voice-input
        │              │              │
        └──────────────┘              │
                                      │
   prompt-guard ◄─── intent-router ◄─┘
        │              │
        │              ├──── model-router
        │              │
        │       sanitizer-pipeline
        │
   td-bus ◄─── secure-bridge ◄── ohttp-gateway
                                     │
                              cloud-llm-adapter

   plugin-host (interop anchor, 第三方插件挂载点)

   http-api (可选, 外部消费者接口)
```

### 插件清单

| 插件 | 职责 | Realm |
|---|---|---|
| `tcm` | 可信计算模块（TEE 密钥管理） | — |
| `local-storage` | AES-256-GCM 加密 SQLite | LOCAL |
| `sessions` | 加密会话管理 | LOCAL |
| `audit-log` | 防篡改审计日志 | LOCAL |
| `privacy-policy` | 隐私策略引擎（可热更新） | — |
| `tools` | Realm-aware 工具注册中心 | — |
| `prompt-guard` | 输入/输出安全扫描 | — |
| `intent-router` | 意图分类与路由 | — |
| `model-router` | LLM 路由（local / cloud） | — |
| `local-llm-adapter` | 本地 LLM 适配器 | LOCAL |
| `cloud-llm-adapter` | 云端 LLM 适配器 | CLOUD |
| `sanitizer-pipeline` | PII 脱敏管线 | SANITIZED |
| `ohttp-gateway` | OHTTP（RFC 9458）网关 | — |
| `secure-bridge` | 端云安全桥 | — |
| `attestation` | TEE 远程证明 | — |
| `td-bus` | 威胁检测总线 | — |
| `local-tools` | 本地工具集 | LOCAL |
| `web-search` | 公网搜索 | CLOUD |
| `voice-input` | 语音输入 | LOCAL |
| `plugin-host` | 第三方插件互操作锚点 | — |
| `http-api` | HTTP API（可选） | — |

## 🌍 Realm 模型

dsh-edge-agent 引入了 **Realm（域）模型**，将所有数据处理划分为三个域：

| Realm | 数据流向 | 典型用例 | 安全等级 |
|---|---|---|---|
| **LOCAL** | 完全在本地处理 | 文件读取、数学计算、本地 LLM 推理 | 最高 |
| **SANITIZED** | 脱敏后发送至云端 | 一般性问答（自动替换 PII） | 中 |
| **CLOUD** | 原始数据发送至云端 | 用户明确授权的云端任务 | 最低（需用户授权） |

每个工具在注册时必须声明所属 realm，意图路由器根据用户输入和数据敏感度自动选择 realm。

## 🔐 安全控制流

一次典型的用户请求经历以下安全控制流：

```
用户输入
  ↓
[1] prompt-guard.checkInput()    # 检测 prompt injection
  ↓
[2] intent-router.classify()     # 分类意图 + realm
  ↓
[3] privacy-policy.check()       # 验证是否符合策略
  ↓
[4] sanitizer-pipeline.sanitize() # 脱敏（如需）
  ↓
[5] tools.invoke() OR llm.invoke() # 执行
  ↓
[6] audit-log.log()              # 记录审计
  ↓
[7] td-bus.analyze()             # 威胁检测
  ↓
返回结果
```

每一步都可能**拒绝请求**或**升级到更高的安全等级**。

## 📦 Adapter 边界

dsh-edge-agent 严格隔离上游 DSH API：

```
src/
  dsh-adapter/    ← 唯一允许 import @deepseek-ai/* 的目录
  *.ts            ← 仅通过 dsh-adapter/types.ts 拿到类型
```

通过 `verify-adapter-boundary.ts` 脚本在 CI 中强制检查。

## 🚀 启动流程

1. **CLI 启动器**（`bin/dsh-edge-agent.js`）：
   - 检测 `dsh` CLI
   - 引导 `$DSH_HOME/profiles/dsh-edge-agent/` profile
   - 拦截 `--resume` 参数
   - 透传其他参数给 `dsh --profile dsh-edge-agent`

2. **DSH profile boot**：
   - 加载 `cordis.yml` + `cordis.patch.yml`
   - 按依赖顺序实例化所有插件
   - 启动 agent loop

3. **dsh-edge-agent 主插件**（`src/dsh-adapter/index.ts`）：
   - 检查 TEE 可用性
   - 加载隐私策略
   - 注册 LLM 适配器
   - 启动审计日志

## 📐 版本路线图

| 版本 | 状态 | 范围 |
|---|---|---|
| **v0.1.0** | ✅ 当前 | 脚手架：所有插件结构 + stub 实现 |
| v0.2.0 | 计划中 | S1-S5：完整实现 LOCAL 域 + 本地 LLM |
| v0.3.0 | 计划中 | S6-S9：完整实现 SANITIZED 域 + 脱敏管线 |
| v0.4.0 | 计划中 | S10-S11：TEE 集成 + 远程证明 |
| v0.5.0 | 计划中 | S12：E2E 测试 + 性能基准 |
| v0.6.0 | 计划中 | S13：http-api + 第三方插件市场 |
| v1.0.0 | 计划中 | 生产就绪 + 真实 TEE 部署 |

## 🔗 相关文档

- [安装指南](installation.md)
- [配置参考](configuration.md)
- [威胁模型](threat-model.md)
- [插件开发](plugin-development.md)
- [上游适配契约](ADAPTER.md)