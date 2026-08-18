# dsh-edge-agent 文档目录

本文档目录包含 dsh-edge-agent 的完整技术文档（中英双语）。

## 📖 主文档

| 文档 | 中文 | 英文 |
|---|---|---|
| 架构设计 | [architecture.md](architecture.md) | [architecture.en.md](architecture.en.md) |
| 安装指南 | [installation.md](installation.md) | [installation.en.md](installation.en.md) |
| 配置参考 | [configuration.md](configuration.md) | [configuration.en.md](configuration.en.md) |
| 威胁模型 | [threat-model.md](threat-model.md) | [threat-model.en.md](threat-model.en.md) |
| 插件开发 | [plugin-development.md](plugin-development.md) | [plugin-development.en.md](plugin-development.en.md) |
| 上游适配契约 | [ADAPTER.md](ADAPTER.md) | — |

## 🎯 文档导航

- **新用户**：从 [installation.md](installation.md) 开始
- **架构师**：阅读 [architecture.md](architecture.md) 了解插件树和 realm 模型
- **安全审计员**：阅读 [threat-model.md](threat-model.md) 了解威胁模型和缓解措施
- **插件开发者**：阅读 [plugin-development.md](plugin-development.md) 了解如何新增插件
- **DSH 升级者**：阅读 [ADAPTER.md](ADAPTER.md) 了解上游版本合约

## 📝 文档约定

- 所有环境变量以 `DSH_EDGE_` 前缀开头
- 所有路径默认使用 `~/.dsh-edge-agent/` 作为根目录
- 所有配置可通过环境变量或 `cordis.yml` 覆盖
- 所有插件遵循 `name` + `inject` + `Config` + `apply` 模式

## 🔄 文档维护

文档随代码同步更新，遵循以下原则：
- **单一信息源**：每个事实只在一个地方描述
- **中英双语**：技术决策、API、配置文件双语化
- **示例优先**：尽量提供可运行的示例
- **链接完整**：所有内部链接必须指向真实存在的文件

## 📮 反馈

发现文档错误或有改进建议？请提交 [Issue](https://github.com/chschytzmcy/dsh-edge-agent/issues)。