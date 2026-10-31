# dsh-edge-agent

> 边缘侧私密智能体 · 基于 DSH (DeepSeek Harness) Cordis 插件机制

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-blue)](package.json)

`dsh-edge-agent` 是一个面向用户的端侧私密智能体，基于 [DeepSeek Harness](https://github.com/deepseek-harness)
的 Cordis 插件机制构建。敏感数据默认留在设备端，仅在用户授权时通过零信任通道与云端通信。

它以 **bundle 补丁**的形式在宿主的 DSH 桌面版上注册了一个新的 **Agent Preset ——
边缘模式**：宿主自带的标准 / 创造 / PTC / 极简四种工作方式之外，边缘模式 =
标准模式 + 本项目的全部功能（隐私护栏、意图判定、路由决策、PII 脱敏、Realm
闸门、审计链、Edge 面板）。默认仍是标准模式；在设置页选中「边缘模式」即启用。

> 这是**一种工作方式**，不是替代品。边缘模式的护栏 hook 由宿主的 scope 链判定
> ——**标准模式下本项目的插件完全不生效**；Edge tab 常驻可见，但只有边缘模式
> 才真正生效。判一个会话有没有走本项目链路，**唯一判据是审计链**。
> 运行时细节见 [`docs/architecture.md`](docs/architecture.md) 与
> [`docs/desktop-troubleshooting.md`](docs/desktop-troubleshooting.md)。

## ✨ 核心特性

| 能力 | 状态 | 说明 |
|---|---|---|
| **🔒 端侧优先** | ✅ | 默认本地 LLM 处理；未决轮次一律留在设备上 |
| **🛡️ 隐私保护** | ✅ | PII 可逆脱敏（10 类规则）+ 不可逆日志掩码 + 隐私策略热重载 + HMAC 校验 |
| **🚦 Realm 三级闸门** | ✅ | LOCAL → SANITIZED → CLOUD；分类→脱敏→路由→执行的完整拦截链，缺件即降级本地 |
| **🚨 威胁检测** | ✅ | `td-bus` 滑动窗口计数 + 分级 + 隔离；超阈值返回 503 |
| **📜 审计与可追溯** | ✅ | 追加式 JSONL 审计链 + ops log 详细 LLM request/response 追踪（PII + 密钥双重脱敏） |
| **🔌 插件化** | ✅ | 22+1 个 plugin（含 1 桌面 webview bundle），全部 subpath 导出，`verify:*` 门禁锁死装配面 |
| **🌐 零信任通信** | 🚧 | RFC 9458 OHTTP 网关为**桩实现**；当前云端通道走标准 TLS |
| **🔑 TEE / 远程证明** | 🚧 | `tcm` / `attestation` 为**桩实现**；真实 TEE 后端待接入 |

> 当前真正生效的隐私保证来自 **Layer 2**（脱敏管线 + 策略引擎 + 审计链 +
> Realm 闸门）。分层状态表见
> [`docs/architecture.md`](docs/architecture.md)。

---

## 📦 安装

### 系统要求

| 组件 | 最低版本 | 推荐版本 |
|---|---|---|
| Node.js | `^22.19` 或 `>=24` | `>=22.20` |
| pnpm | `^10` 或 `^11` | `^11.7.0` |
| 操作系统 | Linux / macOS / Windows | Linux |

### 前置依赖

```bash
npm install -g @deepseek-ai/dsh    # DSH CLI（DeepSeek Harness 官方客户端）
npm install -g pnpm                # 或：corepack enable pnpm
```

### 桌面版（主路径）

DSH 桌面 App（DeepSeek Harness）的侧边栏 **Plugins → Add plugin** 支持
**npm 包名 / tarball 路径 / GitHub 地址 / 本地目录** 四个通道。装完**必须点
「立即启用」**（GUI 不会自动启用），否则启动时不加载。

#### 通道 A：本地目录（本机开发调试用）

```bash
git clone https://github.com/chschytzmcy/dsh-edge-agent.git
cd dsh-edge-agent && pnpm install
npm run build:windows    # 或 build:macos / build:linux
```

然后在 App 里选「本地目录」，填**绝对路径**指向产物目录：

```
Windows  C:\Users\<你>\GolandProjects\gitlab\dsh-edge-agent\dist\installable\dsh-edge-agent-desktop-safe
macOS    /Users/<你>/code/dsh-edge-agent/dist/installable/dsh-edge-agent-desktop-safe
Linux    /home/<你>/code/dsh-edge-agent/dist/installable/dsh-edge-agent-desktop-safe
```

装出来是**符号链接** ⇒ 改文件 + 重启 App 即生效，不用重装。

> ⚠️ **相对路径会被拒**（`a local path must be absolute`）；Git Bash 里的
> `/c/Users/…` 是 MSYS2 虚拟路径，桌面 App 不认，必须用 `C:\…`。
> ⚠️ 这个目录**含明文 API key**（`config/edge.json`）⇒ **别把 `dist/` 发给别人**。

#### 通道 B：GitHub 仓库地址（现场编译，适合分发给别人）

在同一个对话框里填仓库地址：

```
git+ssh://git@github.com/chschytzmcy/dsh-edge-agent.git
```

宿主会克隆源码、在本地跑 `prepare` 编译出 `lib/`、再装成 bundle。

1. 首次会失败并提示「允许这些脚本并重试」——点它放行本仓的构建脚本；
2. 装完点「立即启用」；
3. 重启桌面 App；
4. 配置写进 `~/.dsh-edge-agent/edge.json`（git 装出来的包里**不含**明文密钥）。

两个前置条件：**仓库要能读**（私有库建议填 SSH 形式——只依赖 SSH key）、
**PATH 上要有 `pnpm`**（`npm i -g pnpm` 可解，装完要重启桌面 App）。

细节见 [`docs/deploy-github.md`](docs/deploy-github.md)。

#### 通道 C：npm 包名

```
@deepseek-harness-edge-agent/dsh-edge-agent
```

装的是**预构建**的包，不需要构建授权。包尚未发布到 registry；发布条件见
[`docs/deploy-npm.md`](docs/deploy-npm.md)。

#### 通道 D：tarball 路径（离线分发给别人）

```bash
npm run build:tarball                   # 编译 + 打包 + 门禁
                                       # → dist/dsh-edge-agent-desktop-safe.tar.gz
```

在同一个对话框里填 tarball 的**绝对路径**：

```
Windows  C:\Users\<你>\GolandProjects\gitlab\dsh-edge-agent\dist\dsh-edge-agent-desktop-safe.tar.gz
```

- **不需要构建授权、不需要 PATH 上有 pnpm**；
- tarball **不含 `config/edge.json`**（没有真密钥）⇒ 目标机器要自己写
  `~/.dsh-edge-agent/edge.json`；
- 装出来是 **pnpm store 里的冻结副本** ⇒ 改了 tarball **不会**自动生效，
  要卸载重装。

细节见 [`docs/deploy-tarball.md`](docs/deploy-tarball.md)。

### 独立 HTTP profile（macOS / Linux）

```bash
npm run build:macos -- --deploy-profile=dsh-edge-agent
npm run build:macos -- --deploy-profile=dsh-web      # 官方 Web UI (:3080) + IM 机器人
npm run build:macos -- --deploy-profile=dsh-tui      # 终端
```

一条命令做完整件事：build + 装 bundle + 同步配置 + 重启 + 验活。HTTP API 监听
`:21017`（`/v1/chat`，GET `/v1/health`）。

> **Windows 只有桌面版**：桌面 App 独占 `desktop` profile，CLI 碰不了。

---

## ⚙️ 配置

配置只有**一个文件**：`config/edge.json`。所有 profile 读同一份，不依赖环境变量。

```bash
cp config/edge.example.json config/edge.json
$EDITOR config/edge.json    # 填 secrets.* 的真实 key、llm.local.baseUrl 等
```

最小可用：

```jsonc
{
  "secrets": { "dashscopeApiKey": "sk-..." },
  "llm": {
    "local": {
      "baseUrl": "https://your-endpoint/v1",
      "model": "your-model",
      "keyRef": "dashscopeApiKey"
    }
  }
}
```

**查找顺序**（与 profile 无关）：

```
1. <bundle>/config/edge.json         ← 本地目录装法落这里
2. ~/.dsh-edge-agent/edge.json       ← git / npm 装法落这里
3. <bundle>/config/edge.example.json ← shipped 模板（空密钥兜底）
```

> ⚠️ `config/edge.json` 含**明文 API key**，绝不能提交到 git（已在
> `.gitignore` 里，`.npmignore` 也排除了它 ⇒ 不会进 npm 包）。
> 完整配置清单（16 类配置项 + 路由行为约定）见
> [`docs/privacy-policy.md`](docs/privacy-policy.md#配置清单)。

---

## ✅ 验证

```bash
# 1. bundle 已注册到 profile？
grep '@deepseek-harness-edge-agent/dsh-edge-agent' ~/.dsh/profiles/<profile>/package.json

# 2. 隐私栈挂上了？
dsh --profile <profile> --dump-config | grep -E 'input-guard|file-logger|intent-router|sanitizer' | wc -l   # 期望 ≥4

# 3. 桌面版：右栏出现 Edge tab → 发一条本地 query → Intent panel 出现一行
```

---

## 📚 文档

| 文档 | 内容 |
|---|---|
| [`docs/README.md`](docs/README.md) | **文档总索引**（每份一句说明 + 状态） |
| [`docs/deploy-github.md`](docs/deploy-github.md) | 从 GitHub 仓库地址安装 |
| [`docs/deploy-npm.md`](docs/deploy-npm.md) | 从 npm 包名安装 + 发布链排障 |
| [`docs/deploy-tarball.md`](docs/deploy-tarball.md) | 从 tarball 路径安装（离线分发） |
| [`docs/load-into-local-dsh.md`](docs/load-into-local-dsh.md) | 装进本地 DSH（三条路 + 宿主契约） |
| [`docs/privacy-policy.md`](docs/privacy-policy.md) | 隐私链路单一权威文档：策略 + 判定表 + 配置清单 + 审计 + 行为契约 |
| [`docs/architecture.md`](docs/architecture.md) | 架构主文档：四层模型 / Realm / 插件开发 / 威胁模型 |
| [`docs/desktop-troubleshooting.md`](docs/desktop-troubleshooting.md) | 桌面版排障手册 |
| [`docs/version-policy.md`](docs/version-policy.md) | 上游版本策略 |
| [`docs/TEST-REPORT.md`](docs/TEST-REPORT.md) | 测试报告与实测记录 |
| [`docs/PROGRESS.md`](docs/PROGRESS.md) | 实施进度档案（§7.x 全量历史） |

### 开发

```bash
pnpm test                # 单元测试
pnpm run verify:build    # 19 项构建门禁
pnpm run lint            # eslint
```

MIT License. 详见 [LICENSE](LICENSE)。
