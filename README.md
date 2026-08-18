# dsh-edge-agent

> 边缘侧私密智能体 · 基于 DSH (DeepSeek Harness) Cordis 插件机制

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-blue)](package.json)

`dsh-edge-agent` 是一个面向用户的端侧私密智能体，专注于隐私保护和安全可控的 AI 交互。它基于 [DeepSeek Harness](https://github.com/deepseek-harness) 的 Cordis 插件机制构建，将敏感数据保留在本地，仅在必要时通过零信任通道与云端通信。

## ✨ 核心特性

- **🔒 端侧优先**：默认使用本地 LLM 处理所有数据，云端 LLM 仅在用户明确需要时调用
- **🛡️ 隐私保护**：AES-256-GCM 加密存储、TEE（可信执行环境）密钥管理、PII 自动脱敏
- **🌐 零信任通信**：基于 RFC 9458 OHTTP 协议，云端无法将请求与用户关联
- **🚨 威胁检测**：实时监控异常行为，自动隔离可疑流量
- **🔌 插件化**：19 个核心插件 + 1 个可选 http-api，全部以 subpath 形式导出

## 📦 安装

```sh
# 前置：安装官方 dsh CLI 和 pnpm
npm install -g @deepseek-ai/dsh pnpm

# 克隆并安装本仓库
git clone https://github.com/chschytzmcy/dsh-edge-agent.git
cd dsh-edge-agent
pnpm install
./install.sh

# 启动
dsh-edge-agent
```

详细安装说明见 [docs/installation.md](docs/installation.md)。

## 🏗️ 架构

dsh-edge-agent 采用**单包多 subpath**架构，所有插件都从 `@deepseek-harness-edge-agent/dsh-edge-agent` 导出：

```
@deepseek-harness-edge-agent/dsh-edge-agent          # 主插件（聚合器）
@deepseek-harness-edge-agent/dsh-edge-agent/tcm       # 可信计算模块
@deepseek-harness-edge-agent/dsh-edge-agent/privacy-policy  # 隐私策略
@deepseek-harness-edge-agent/dsh-edge-agent/ohttp-gateway   # OHTTP 网关
... 共 23 个 subpath
```

每个插件通过 Cordis 的 `name` + `inject` + `Config` + `apply` 模式声明，详见 [docs/architecture.md](docs/architecture.md)。

## ⚙️ 配置通过环境变量完成：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_TEE_TYPE` | `simulated` | TEE 后端：`simulated` / `trustzone` / `keystone` / `sgx` |
| `DSH_EDGE_STORAGE_ROOT` | `~/.dsh-edge-agent` | 加密存储根目录 |
| `DSH_EDGE_POLICY_PATH` | `~/.dsh-edge-agent/policy.json` | 隐私策略文件路径 |
| `DSH_EDGE_DEFAULT_DATA_LEVEL` | `sanitized` | 默认数据级别 |
| `DSH_EDGE_BRIDGE_MODE` | `ohttp` | 出站模式：`ohttp` / `tls` / `auto` |
| `DSH_EDGE_PERMISSION_MODE` | `ask` | 权限模式：`ask` / `workspace-write` / `danger-full-access` |

详细配置见 [docs/configuration.md](docs/configuration.md)。

## 🔐 安全模型

dsh-edge-agent 通过**纵深防御**保护用户隐私：

1. **本地加密**：所有数据使用 AES-256-GCM 加密，密钥由 TEE 保护
2. **意图路由**：自动识别数据敏感度，决定走 LOCAL / CLOUD / SANITIZED 三个 realm
3. **脱敏管线**：发送至云端前自动替换 PII（人名、邮箱、电话等）
4. **OHTTP 通道**：云端只能看到脱敏后的数据，且无法关联到用户身份
5. **威胁检测**：异常行为触发自动隔离（block-cloud / kill-session / lockdown）

完整威胁模型见 [docs/threat-model.md](docs/threat-model.md)。

## 🧪 开发

```sh
# 编译
pnpm run compile

# 验证（包含 boundary / contract / patch-surface / plugin-spec / package）
pnpm run verify:build

# 运行单元测试
pnpm test

# 冒烟测试
pnpm run smoke
```

插件开发指南见 [docs/plugin-development.md](docs/plugin-development.md)。

## 📜 许可证

MIT License. 详见 [LICENSE](LICENSE)。

## 🙏 致谢

本项目基于 [DeepSeek Harness](https://github.com/deepseek-harness) 和 [Cordis](https://github.com/deepseek-ai/cordis) 构建，感谢 DeepSeek 团队的开源贡献。

---

**⚠️ 当前状态**：这是 v0.1.0 脚手架版本。所有插件的 `apply` 方法均为占位实现，实际功能将在后续 S1-S13 阶段逐步填充。详见 [设计文档](docs/architecture.md#版本路线图)。