# dsh-edge-agent

> 边缘侧私密智能体 · 基于 DSH (DeepSeek Harness) Cordis 插件机制

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-blue)](package.json)

`dsh-edge-agent` 是面向用户的端侧私密智能体，以 **bundle 补丁**的形式注册在宿主的
DSH 桌面版 / CLI 上，新增一个 **Agent Preset —— 边缘模式**：宿主自带的标准 / 创造 /
PTC / 极简四种工作方式之外，边缘模式 = 标准模式 + 本项目的全部功能（隐私护栏、意图
判定、路由决策、PII 脱敏、Realm 闸门、审计链、Edge 面板）。默认仍是标准模式；在设置页
选中「边缘模式」即启用。

> 这是**一种工作方式**，不是替代品。护栏 hook 由宿主的 scope 链判定 —— **标准模式下
> 本项目的插件完全不生效**；Edge tab 常驻可见，但只有边缘模式才真正生效。判一个会话
> 有没有走本项目链路，**唯一判据是审计链**。

---

## 📥 在 DSH 上加载本插件

### 一、它是怎么被宿主认出来的（速览）

宿主只认**包名**：profile 的 `package.json` → `dsh.profile.bundles[]` 里追加包名 ⇒
宿主的 bundle 加载器读这个包自己的 `package.json#dsh.bundle.patch` ⇒ 按插件行的
`inject` 依赖图实例化 ⇒ 插件通过**事件钩子 / Service / Provider** 三种挂法接进 DSH 流程。

**两个变体**：`desktop-safe`（只 insert、不改写宿主默认；**本文所有通道都装它**）与
`full`（顶层 patch 改写 persona / approval / sandbox 等宿主全局，给「独立部署自有
profile」的场景用）。

> 机制细节（三棵 patch 树各装什么、顶层为什么只有 4 行 insert、scope 隔离规则、
> 插件行的完整挂点）见 [`docs/architecture.md`](docs/architecture.md)、
> [`docs/plugin-mount-points.md`](docs/plugin-mount-points.md) 与
> [`docs/load-into-local-dsh.md`](docs/load-into-local-dsh.md)。

### 二、桌面版（主路径）：Plugins → Add plugin

DSH 桌面 App 侧边栏的 **Plugins → Add plugin** 支持四个通道。**装完必须点「立即启用」**
（GUI 不会自动启用），否则启动时不加载。

| 通道 | 输入 | 要构建授权 | PATH 要有 pnpm | 产物形态 | 含真密钥 | 改了会生效吗 |
|---|---|---|---|---|---|---|
| **A 本地目录** | 绝对路径 | 否 | 否 | 符号链接 | ⚠️ **有** | ✅ 改文件重启即生效 |
| **B GitHub 地址** | `git+ssh://git@github.com/<owner>/<repo>` | **是** | **是** | 现场编译 | 否 | ❌ 须重装 |
| **C npm 包名** | `@dsh-edge/dsh-edge-agent` | 否 | 否 | 预构建 | 否 | 走 `updateBundle` |
| **D tarball 路径** | `…/x.tar.gz` 绝对路径 | 否 | 否 | pnpm store 冻结副本 | 否 | ❌ 须卸载重装 |

四条通道在宿主里是**同一段代码**（一律 `pnpm add <spec>`），差别全在本仓的作者侧义务：

- **A 本地目录**（本机开发调试）
  ```bash
  pnpm install && npm run build:windows   # 或 build:macos / build:linux
  ```
  在 App 里选「本地目录」，填**绝对路径**指向产物目录：
  ```
  Windows  C:\Users\<你>\…\dsh-edge-agent\dist\installable\dsh-edge-agent-desktop-safe
  macOS    /Users/<你>/…/dsh-edge-agent/dist/installable/dsh-edge-agent-desktop-safe
  Linux    /home/<你>/…/dsh-edge-agent/dist/installable/dsh-edge-agent-desktop-safe
  ```
  > ⚠️ **相对路径会被拒**（`a local path must be absolute`）；Git Bash 的 `/c/Users/…` 是
  > MSYS2 虚拟路径，桌面 App 不认，必须用 `C:\…`。
  > ⚠️ 这个目录**含明文 API key**（`config/edge.json`）⇒ **别把 `dist/` 发给别人**。

- **B GitHub 地址**（小范围分发 / 持续迭代）—— 填
  `git+ssh://git@github.com/chschytzmcy/dsh-edge-agent.git`。宿主克隆源码、在本地跑
  `prepare` 编译出 `lib/`、再装成 bundle。首次会失败并提示「允许这些脚本并重试」——
  点它放行；装完点「立即启用」；重启桌面 App。两个前置条件：仓库要能读（私有库建议
  SSH 形式）、**PATH 上要有 `pnpm`**（只有这条通道要，因为 pnpm 给 git 依赖注入的
  `pnpm install` 是用 shell 跑的；宿主自己调 pnpm 用的是 App 自带那支）。

- **C npm 包名**（发布给公众）—— 装的是**预构建**包，不需要构建授权、不需要 PATH 上有
  pnpm。**包已发布**：`@dsh-edge/dsh-edge-agent@0.1.1`（2026-11-11 上线）⇒ 这条通道
  现在直接可用。详见 [`docs/deploy-npm.md`](docs/deploy-npm.md)。

- **D tarball 路径**（离线分发）——
  ```bash
  npm run build:tarball    # 编译 + 打包 + 门禁 → dist/dsh-edge-agent-desktop-safe.tar.gz
  ```
  在 App 里填 tarball 的**绝对路径**。不需要构建授权、不需要 PATH 上有 pnpm；tarball
  **不含 `config/edge.json`**（目标机器要自己写 `~/.dsh-edge-agent/edge.json`）。
  > ⚠️ **改了 tarball 不会自动生效** —— 装出来是 pnpm store 里的冻结副本，要卸载重装。

### 三、独立 HTTP profile（headless CLI）

```bash
npm run build:macos -- --deploy-profile=dsh-edge-agent   # 或 build:linux
```

一条命令做完整件事：build + 装 bundle + 同步配置 + 重启 + 验活。HTTP API 监听 `:21017`
→（`/v1/chat`，GET `/v1/health`）。

> ⚠️ **Windows 只有桌面版**：桌面 App 独占 `desktop` profile（`managed exclusively by the
> Electron application`），CLI 碰不了 ⇒ Windows 上没有独立 headless profile 这条路。

### 四、装完自检：**mount ≠ active ≠ enforced**

「装上了」分三层，**boot 不报错只证明前两层**：

| 层 | 含义 | 怎么验 |
|---|---|---|
| **mount** | 插件被挂上 | boot 不报错 |
| **active** | cordis 把插件置为 ACTIVE | `--dump-config` 里能看到插件行 |
| **enforced** | 真拦得住 | **审计链里出现执法行**（`blocked.attack` / `blocked.policy` / `etscli.shell.denied` …） |

```bash
# 1. bundle 已注册到 profile？
grep '@dsh-edge/dsh-edge-agent' ~/.dsh/profiles/<profile>/package.json

# 2. 隐私栈挂上了？（期望 ≥4）
dsh --profile <profile> --dump-config \
  | grep -E 'input-guard|file-logger|intent-router|sanitizer' | wc -l

# 3. 桌面版：右栏出现 Edge tab → 发一条本地 query → Intent panel 出现一行
```

**排障对照**：

| 现象 | 多半是 |
|---|---|
| `profile is not mounted` / 插件行根本不在 `--dump-config` | ① 没进 `dsh.profile.bundles` |
| `1 entry did not activate` + `pending (waiting for services: …)` | ④ inject 闭包不齐 —— 补齐被点名插件的传递依赖 |
| 插件行在、但会话里什么也不拦 | ③ scope 隔离（**宿主树行不能反向依赖 preset 子树的 service**，§7.152）/ 当前会话是**标准模式**（不是边缘模式） |
| 桌面版没有 Edge tab | `lib/client.js` 没构建 —— `prepare` 链里漏了 `build:client`（**静默失败，无报错**） |

---

## ✨ 核心特性

| 能力 | 状态 | 说明 |
|---|---|---|
| **🔒 端侧优先** | ✅ | 默认本地 LLM 处理；未决轮次一律留在设备上 |
| **🛡️ 隐私保护** | ✅ | PII 可逆脱敏 + 不可逆日志掩码 + 隐私策略热重载 + HMAC 校验 |
| **🚦 Realm 三级闸门** | ✅ | LOCAL → SANITIZED → CLOUD；分类→脱敏→路由→执行的完整拦截链，缺件即降级本地 |
| **🚨 威胁检测** | ✅ | `td-bus` 滑动窗口计数 + 分级 + 隔离；超阈值返回 503 |
| **📜 审计与可追溯** | ✅ | 追加式 JSONL 审计链 + ops log 详细 LLM request/response 追踪（PII + 密钥双重脱敏） |
| **🔌 插件化** | ✅ | 插件全部按 subpath 导出（**37 条**），`verify:*` 门禁锁死装配面 |
| **🌐 零信任通信** | 🚧 | RFC 9458 OHTTP 网关为**桩实现**；当前云端通道走标准 TLS |
| **🔑 TEE / 远程证明** | 🚧 | `tcm` / `attestation` 为**桩实现**；真实 TEE 后端待接入 |

> 当前真正生效的隐私保证来自 **Layer 2**（脱敏管线 + 策略引擎 + 审计链 + Realm 闸门）。
> 分层状态表见 [`docs/architecture.md`](docs/architecture.md)。

---

## ⚙️ 配置

配置只有**一个文件**：`edge.json`。所有 profile 读同一份，不依赖环境变量。

### 配置落点（两个，没有第三个）

| 顺位 | 路径 | 说明 |
|---|---|---|
| 1 | `<插件目录>/config/edge.json` | 装好后在 App 里就能找到的那份 |
| 2 | `~/.dsh-edge-agent/edge.json` | 跨通道、跨重装、删 profile 都活着 ★ **推荐** |

要改配置就抄模板过去填：

```bash
mkdir -p ~/.dsh-edge-agent
cp config/edge.example.json ~/.dsh-edge-agent/edge.json
```

> **仓库的 `config/` 目录不放活配置**（§7.182）—— npm / git / tarball 三条通道的产物里
> **本来就没有** `config/edge.json`（打包时按设计排除）。仓库那份
> `config/edge.example.json` 只是**给你抄的模板**，模板里的部署值已并入代码默认值
> ⇒「没配置文件」与「照模板抄」行为一致。

**先说结论：`secrets` 和 `llm` 都不是必填。** 桌面版装法下，`edge.json` 写成 `{}`
也能正常跑 —— 两个池都会**转发宿主 GUI 里选中的模型**，凭据全归宿主，edge 侧一个
secret 都不碰。

### 两个池怎么配

`llm.local` 与 `llm.cloud` **完全对称**：

| `llm.<池>.baseUrl` | `llm.<池>.delegate` | 行为 |
|---|---|---|
| 填了 | 任意 | **直连** —— edge 自有池，密钥走 `keyRef`（端点不鉴权时 `keyRef` 也可以不填）|
| 留空 | `true`（默认）| **DELEGATE** —— 转发宿主选中的提供商（凭据归宿主，edge 侧不碰 secret）|
| 留空 | `false` | **不注册路由** —— LOCAL 意图 fail-closed 报错 |

⇒ 也就是说：**不填 `baseUrl` 不等于「没模型」**，而是「用宿主 GUI 里选的那个模型」。

```jsonc
{
  "llm": {
    "local": { "baseUrl": "", "delegate": true },   // → 转发宿主选中的模型
    "cloud": { "baseUrl": "", "delegate": true }    // → 同上
  }
}
```

要 edge 自有直连池时填 `baseUrl + model + keyRef`（`baseUrl` 必须含 `/v1`）：

```jsonc
{
  "secrets": { "dashscopeApiKey": "sk-..." },
  "llm": {
    "local": {
      "baseUrl": "https://your-endpoint/v1",
      "model": "your-model",
      "keyRef": "dashscopeApiKey"     // 端点不鉴权（本地 llama.cpp / vLLM）时整行可省
    }
  }
}
```

`delegate: false` 是 kill switch —— 回到「没端点就不注册路由」的旧语义。

### 不配会怎样

| 你没配的东西 | 结果 |
|---|---|
| `llm` 整段 | 两池都 DELEGATE ⇒ **实际是同一个模型**（宿主选的那个）。⚠️ 意图分类与 guard 检测这两个**内部阶段**钉在 `local-llm` 上，端点留空时它们会跑在宿主模型上 ⇒「待检测的用户原文」也会上行（§7.171 的已知边界）|
| `llm.local.baseUrl` | `local-llm` 路由**照样注册**（转发宿主模型），不是「没模型」|
| `llm.local.keyRef` | 端点不鉴权 ⇒ 完全正常（不发 Authorization 头）；端点要鉴权 ⇒ 401，报错会指名让你配 `keyRef` |
| `secrets` 整段（**桌面版**）| **完全正常** —— 桌面版不挂 http-api，一个 secret 都不需要 |
| `secrets.edgeApiKey`（**独立 HTTP profile**）| **必填**：http-api 暴露 `/v1/audit` 与 session delete/fork，没凭据就**拒绝启动**（fail-closed），而不是开一个无鉴权的 API |
| `secrets.tavilyApiKey` / `bochaApiKey` | 搜索 provider 的 `available()` 变 false ⇒ 被宿主从可用清单里过滤掉（搜索不可用），其余功能照常 |

> ⚠️ 两池的**出网口径不同**：云池只带「之前上过云的历史」；本地池带**全部**历史
> （§7.131 的不对称规则）。本地池走 delegate 时同样按这个口径 —— 已知边界见
> [`docs/privacy-policy.md`](docs/privacy-policy.md#已知边界)。
>
> ⚠️ `config/edge.json` 含**明文 API key**，绝不能提交到 git（已在 `.gitignore` 里，
> `.npmignore` 也排除了它 ⇒ 不会进 npm 包）。完整配置清单见
> [`docs/privacy-policy.md`](docs/privacy-policy.md#配置清单)。

### 边缘模式的模型从哪来（选型不动 + 出网那一跳改道）

宿主 0.2.2-rc.1 起，**路由只由会话级 `modelSelection` 决定** —— 在 `agent/request` 里
改写 provider/model 会被宿主的 `prepareRequest()` 判非法并抛错。§7.184 起，本包
**不再改写会话选型**：宿主模型选择器里显示什么，就一直是什么。

| 情况 | 结果 |
|---|---|
| 进入边缘模式 | **选型一个字都不改** —— 选择器保持你选的那个，不跳 |
| 本轮判定为 LOCAL、但会话选的 provider 不是本地 provider | 这一轮在**出网那一跳**被**改道**到本地池（provider 与 model 都换）⇒ 这一轮仍然留在设备上，**不再被拒收** |
| 本轮判定为 CLOUD | 不改道 —— 本轮就是要出网的（脱敏 + 只带云段历史） |
| 改道改不动（本地路由不存在 / 解析不到本地模型 / 宿主 LLM runtime 不可用） | **fail-closed 抛错**，绝不放行到可能上云的 provider |
| 宿主模型选择器里看到什么 | 本地池**如实声明**它真正会跑的那**一个**模型 —— 直连池 = 池自己的 model id；DELEGATE = 委托目标的 model id（§7.180）|

判一次会话到底用了哪个 provider，**唯一权威是审计链**：`input-guard.reroute.local`
（改道发生，带 `from` = 被改掉的原选型、`to` = 实际落点）/ `input-guard.reroute.blocked`
（改不动，fail-closed）。面板的「答案出口」一栏会把两边都摆出来 ——
**「会话选型 → 实际落点」**；LOCAL / CLOUD 的判据是**哪个池**（§7.130），DELEGATE 下
额外多一行「真实落点」。详见 [`docs/privacy-policy.md`](docs/privacy-policy.md)。

---

## 📚 文档

| 文档 | 内容 |
|---|---|
| [`docs/README.md`](docs/README.md) | **文档总索引**（每份一句说明 + 状态） |
| [`docs/architecture.md`](docs/architecture.md) | 架构主文档：四层模型 / Realm / 插件开发 / 威胁模型 / 三棵 patch 树 |
| [`docs/plugin-mount-points.md`](docs/plugin-mount-points.md) | 插件挂点表：每个插件的真实挂点 + 三种挂法 |
| [`docs/deploy-minimal-files.md`](docs/deploy-minimal-files.md) | 每个文件装了什么 / 最小部署清单 |
| [`docs/privacy-policy.md`](docs/privacy-policy.md) | 隐私链路单一权威文档：策略 + 判定表 + 配置清单 + 审计 + 行为契约 |
| [`docs/deploy-github.md`](docs/deploy-github.md) | 从 GitHub 仓库地址安装 |
| [`docs/deploy-npm.md`](docs/deploy-npm.md) | 从 npm 包名安装 + 发布链排障 |
| [`docs/npm-account-setup.md`](docs/npm-account-setup.md) | 注册 npm 账号/组织（scope `@dsh-edge`）+ 办发布凭据 |
| [`docs/deploy-tarball.md`](docs/deploy-tarball.md) | 从 tarball 路径安装（离线分发） |
| [`docs/load-into-local-dsh.md`](docs/load-into-local-dsh.md) | 装进本地 DSH（三条路 + 宿主契约） |
| [`docs/desktop-troubleshooting.md`](docs/desktop-troubleshooting.md) | 桌面版排障手册 |
| [`docs/version-policy.md`](docs/version-policy.md) | 上游版本策略 |
| [`docs/PROGRESS.md`](docs/PROGRESS.md) | 实施进度档案（§7.x 全量历史） |

### 开发

```bash
pnpm install
pnpm run build      # compile → typecheck:client → build:client → build:installable → pack:tarball → verify:build
pnpm test           # 单元测试
pnpm run lint       # eslint
```

### 发布到 npm

```bash
npm run publish:npm                    # 构建 + 27 道门禁 + dry-run（**默认不发**）
npm run publish:npm -- --yes           # 真发
npm run publish:npm -- --yes --tag     # 发完打 v<version> tag（再 git push origin v<version> 触发 CI）
```

前置：`npm login` 一次（凭据写在 `~/.npmrc`；PATH 上要有 `pnpm`）。
不带 `--yes` **永远不会碰 registry**。

> ⚠️ **「publish 报成功」≠「包已经能装」**：npm 现在把 bypass-2FA token 的直发也收进了
> 分级发布（staged publishing）—— 包名先被占位版 `0.0.0-stage` 占住，真实版本要等放行。
> **判据**：`npm view <pkg> version` 返回 `0.0.0-stage` = 还卡着，返回真实版本号 = 已上线。
> 详见 [`docs/deploy-npm.md`](docs/deploy-npm.md) §8.1.2。

> ⚠️ **`build` 的步骤顺序不能省**：门禁验的是**产物**不是源码 —— `compile` 只重建 Node
> 半侧，`lib/client.js` 来自 `build:client`（esbuild），`dist/installable/` 来自
> `build:installable`。缺 `build:client` 的包是**静默**坏法：Edge tab 根本不出现，
> 没有任何报错。

MIT License. 详见 [LICENSE](LICENSE)。
