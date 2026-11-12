# dsh-edge-agent

> 边缘侧私密智能体 · 基于 DSH (DeepSeek Harness) Cordis 插件机制

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-blue)](package.json)

给 DSH 桌面版 / CLI 装上一个新的 **Agent Preset —— 边缘模式**：宿主自带的
标准 / 创造 / PTC / 极简之外，**边缘模式 = 标准模式 + 本项目的全部能力**
（隐私护栏 · 意图判定 · 路由决策 · PII 脱敏 · Realm 闸门 · 审计链 · Edge 面板）。
默认仍是标准模式，在设置页选中「边缘模式」才生效。

> 这是**一种工作方式**，不是替代品：标准模式下本插件**完全不生效**（Edge tab 常驻可见）。
> 判一个会话有没有走本链路，**唯一判据是审计链**。

本包启用的是 `desktop-safe` 变体 —— 只 insert 插件行，不改写宿主的 persona /
approval / sandbox 等全局设置。

---

## 📥 装

### ① npm 包名（推荐：装预构建包）

桌面版 DSH App：**Plugins → Add plugin** → 填包名 `@dsh-edge/dsh-edge-agent`
—— **不需要构建授权、不需要 PATH 上有 pnpm**。

> ⚠️ **装完必做两步**：① 点「**立即启用**」（GUI 不会自动启用）② **重启桌面 App**。
> 否则包在 `dependencies` 里却不在 `dsh.profile.bundles` 里 ⇒ 启动不加载 ⇒ 右栏没有 Edge tab。

### ② GitHub Release 上的预构建 tar 包（免 registry）

在 [Releases 页](https://github.com/chschytzmcy/dsh-edge-agent/releases) 取最新版本的
`dsh-edge-agent-desktop-safe.tar.gz`（或 `dsh-edge-agent-full.tar.gz`），
在 **Plugins → Add plugin** 里粘它的 URL：

```
https://github.com/chschytzmcy/dsh-edge-agent/releases/download/<tag>/dsh-edge-agent-desktop-safe.tar.gz
```

宿主把这种 URL 判成 **tarball**（不是 git 仓库）⇒ 走 tarball 通道，
**免构建授权、免 PATH 上的 pnpm、不需要 registry**。

### ③ GitHub 地址 / 本地目录（要自己编译）

这两条通道需要 PATH 上有 pnpm，宿主会在插件目录里跑构建。编译与完整步骤见
[`docs/load-into-local-dsh.md`](docs/load-into-local-dsh.md) 与
[`docs/deploy-github.md`](docs/deploy-github.md)：

```bash
pnpm install
pnpm run build      # compile → typecheck:client → build:client → build:installable → pack:tarball → verify:build
```

产物：`dist/installable/<变体>/`（桌面 App 装的那份目录）与
`dist/dsh-edge-agent-<变体>.tar.gz`（通道②能粘的那个 tar 包）。

---

## ⚙️ 配置：`edge.json`

**只有一个文件**：`edge.json`，所有 profile 读同一份，不依赖环境变量。

### 缺省是什么样（不写配置文件会怎样）

**一句话**：缺省下两个池都**转发宿主 GUI 里选中的模型**（DELEGATE）——
所以「本地」这一栏**默认并不在本地**。

| 缺省项 | 缺省值 | 后果 |
|---|---|---|
| `llm.local.baseUrl` | 空 ⇒ **DELEGATE** | `local-llm` 路由**照样注册**，但它转发宿主模型 —— 不是「没模型」|
| `llm.cloud.baseUrl` | 空 ⇒ **DELEGATE** | 云池同样转发宿主模型 |
| `stages.intent.provider` | `local-llm` | 意图判定钉在本地池上 ⇒ 端点留空时它**跑宿主模型** ⇒ **待检测的用户原文也会上行**（已知边界）|
| `stages.intent.timeoutMs` / `stages.guard.timeoutMs` | `60000` | 意图判定与护栏那两次调用的超时窗口是 **60 秒** |
| `llm.local.delegate` | `true` | 要「不注册本地路由」必须显式写 `false`（kill switch）|

⇒ **想让「本地」真的是本地，必须填 `llm.local.baseUrl`**。

### 落点（两个，没有第三个）

| 顺位 | 路径 | 说明 |
|---|---|---|
| 1 | `<插件目录>/config/edge.json` | 装好后在 App 里就能找到的那份 |
| 2 | `~/.dsh-edge-agent/edge.json` | 跨通道、跨重装、删 profile 都活着 ★ **推荐** |

> 各发布通道的产物里**本来就没有** `config/edge.json`（打包时按设计排除）；
> 插件目录那份 `config/edge.example.json` 只是**给你抄的模板**。

### 怎么配（三步）

1. 把插件目录里的模板抄到 home：
   ```bash
   mkdir -p ~/.dsh-edge-agent
   cp <插件目录>/config/edge.example.json ~/.dsh-edge-agent/edge.json
   ```
2. 填三样东西：
   ```jsonc
   {
     "secrets": { "myEdgeKey": "<你的 key>" },
     "llm": {
       "local": {
         "baseUrl": "https://your-endpoint/v1",   // 必须含 /v1
         "model": "your-model",
         "keyRef": "myEdgeKey"                     // 端点不鉴权（本地 llama.cpp / vLLM）时整行可省
       }
     }
   }
   ```
   - `baseUrl` 留空 = DELEGATE（转发宿主模型）；填了 = **直连自有池**，凭据只认 `keyRef` 指向的槽位；
   - `llm.cloud` 与 `llm.local` **完全对称**，配法一模一样；
   - `delegate: false` = kill switch（不注册路由 ⇒ LOCAL 轮次 fail-closed，不放行到可能上云的 provider）。
3. **重启桌面 App** —— `llm` / `stages` / `jev` 在插件启动时定死，不重启不生效。

### 不配会怎样

| 你没配的东西 | 结果 |
|---|---|
| `llm.local.keyRef` | 端点不鉴权 ⇒ 完全正常；端点要鉴权 ⇒ 401，报错会指名让你配 `keyRef` |
| `secrets` 整段（**桌面版**）| **完全正常** —— 桌面版不挂 http-api，一个 secret 都不需要 |
| `secrets.edgeApiKey`（**独立 HTTP profile**）| **必填** —— 没凭据**拒绝启动**（fail-closed）|

> ⚠️ 两池的**出网口径不同**：云池只带「之前上过云的历史」；本地池带**全部**历史。
> ⚠️ `edge.json` 含**明文 API key**，绝不能提交到 git。
> 完整配置清单见 [`docs/privacy-policy.md`](docs/privacy-policy.md#配置清单)。

---

## ✅ 装完自检

「装上了」分三层，**boot 不报错只证明前两层**：

| 层 | 含义 | 怎么验 |
|---|---|---|
| **mount** | 插件被挂上 | boot 不报错 |
| **active** | cordis 把插件置为 ACTIVE | `--dump-config` 里能看到插件行 |
| **enforced** | 真拦得住 | **审计链里出现执法行**（`blocked.attack` / `blocked.policy` …）|

```bash
grep '@dsh-edge/dsh-edge-agent' ~/.dsh/profiles/<profile>/package.json
dsh --profile <profile> --dump-config | grep -cE 'input-guard|file-logger|intent-router|sanitizer'
```

---

## 🔀 边缘模式的模型从哪来

宿主 0.2.2-rc.1 起**路由只由会话级 `modelSelection` 决定**，本包**不改写会话选型**：

- 进入边缘模式 ⇒ **选型一个字都不改**；
- 本轮判定为 LOCAL、但会话选的 provider 不是本地 provider ⇒ 这一轮在**出网那一跳**
  被**改道**到本地池（provider 与 model 都换）⇒ 这一轮仍然留在设备上，**不再被拒收**；
- 改道改不动（本地路由不存在 / 解析不到本地模型 / 宿主 LLM runtime 不可用）⇒
  **fail-closed 抛错**，绝不放行到可能上云的 provider。

判一次会话到底用了哪个 provider，**唯一权威是审计链**：`input-guard.reroute.local`
（改道发生，带 `from` / `to`）/ `input-guard.reroute.blocked`（改不动）。
详见 [`docs/privacy-policy.md`](docs/privacy-policy.md)。

---

## ✨ 能力

| 能力 | 状态 | 说明 |
|---|---|---|
| **🔒 端侧优先** | ✅ | 默认本地 LLM 处理；未决轮次一律留在设备上 |
| **🛡️ 隐私保护** | ✅ | PII 可逆脱敏 + 日志掩码 + 隐私策略热重载 |
| **🚦 Realm 三级闸门** | ✅ | LOCAL → SANITIZED → CLOUD；缺件即降级本地 |
| **🚨 威胁检测** | ✅ | `td-bus` 滑动窗口 + 分级 + 隔离；超阈值返回 503 |
| **📜 审计与可追溯** | ✅ | 追加式 JSONL 审计链 + ops log（PII + 密钥双重脱敏）|
| **🔌 插件化** | ✅ | 按 subpath 导出（**37 条**入口）|
| **🌐 零信任通信** | 🚧 | OHTTP 网关为**桩实现**；当前云端通道走标准 TLS |
| **🔑 TEE / 远程证明** | 🚧 | `tcm` / `attestation` 为**桩实现** |

---

## 📚 文档

| 文档 | 内容 |
|---|---|
| [`docs/README.md`](docs/README.md) | **文档总索引**（每份一句说明 + 状态）|
| [`docs/architecture.md`](docs/architecture.md) | 架构主文档：四层模型 / Realm / 插件开发 / 威胁模型 / patch 树 |
| [`docs/privacy-policy.md`](docs/privacy-policy.md) | 隐私链路单一权威：策略 + 判定表 + 配置清单 + 审计 + 行为契约 |
| [`docs/deploy-npm.md`](docs/deploy-npm.md) | npm 通道：安装与排障 |
| [`docs/deploy-tarball.md`](docs/deploy-tarball.md) | tar 包通道：安装与排障 |
| [`docs/desktop-troubleshooting.md`](docs/desktop-troubleshooting.md) | 桌面版排障手册 |

MIT License. 详见 [LICENSE](LICENSE)。
