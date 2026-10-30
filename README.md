# dsh-edge-agent

> 边缘侧私密智能体 · 基于 DSH (DeepSeek Harness) Cordis 插件机制

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-blue)](package.json)

`dsh-edge-agent` 是一个面向用户的端侧私密智能体，基于 [DeepSeek Harness](https://github.com/deepseek-harness) 的 Cordis 插件机制构建。敏感数据默认留在设备端，仅在用户授权时通过零信任通道与云端通信。

> **它是一种「工作方式」，不是替代品**（§7.135 / §7.136）：本 bundle 在宿主的 DSH 桌面版上
> 注册了一个新的 **Agent Preset** —— **边缘模式**。宿主自带的标准 / 创造 / PTC /
> 极简四种工作方式之外，边缘模式 = **标准模式 + 本项目的全部功能**（隐私护栏、
> 意图判定、路由决策、PII 脱敏、Realm 闸门、审计链、Edge 面板）。它以 bundle
> 补丁的形式声明（`presets/edge*.patch.yml`），与宿主内置 preset 同一套机制
> （`dsh.bundle.patch` → `insert` 一行 `@deepseek-ai/dsh-agent-preset`）。
> 默认仍是标准模式；在设置页选中「边缘模式」即启用。
>
> **「边缘模式」是默认，还是当前会话选的，决定了什么会出现**（§7.138 / §7.142，运行时实测）：
> - **服务端**：会话级选择就够 —— 护栏 hook 是 scope 化的，选了边缘模式的会话
>   立刻按端侧规则走。
> - **Edge tab**：**一直都在**（§7.142：主人裁决「edge tab 一直都在，只有边缘模式才
>   真正生效」）—— 任何工作方式的会话右栏都有这个页签，可随时点开；里面显示的是
>   **该会话自己**的边缘数据，没跑过边缘模式的会话面板是空的
>   （还没拿到 sessionId 的**空白草稿会话**会落到全局视图，显示全部边缘历史）。
>   **只有边缘模式的会话会自己打开面板**（§7.139：会话上台即自动打开 —— 宿主本身
>   从不自动打开任何 tab，默认页永远是 guide）；判据是**会话级**信号
>   （`session.projectionValues.agentPreset`，宿主自己就是这么读的），
>   **不再看名册默认项** ⇒ 主人把默认留在标准模式、临时在某个会话选边缘模式，
>   那个会话照样自动开面板。
>   活着的名册（挂载是否健康、谁在当默认）用
>   `node scripts/probe-desktop-preset-roster.mjs "<dsh web URL>"` 查。
>
> **现在是真正隔离的**（§7.136）：本项目的护栏 hook **不再带 `{ global: true }`**，
> 改由宿主的 scope 链判定 —— 监听器只在**自己的 preset scope 或其子 scope**
> 收到事件，而 Agent 绑到所选 preset 的代际 scope ⇒ **标准模式下本项目的插件
> 完全不生效**（路由改写 / PII 脱敏 / 护栏都停），边缘模式下才生效。
> Edge tab 常驻可见（§7.142），但**只有边缘模式才真正生效** —— 能力隔离在
> 服务端，客户端只负责把边缘模式的会话开进面板。
> 唯一保留全局的是 `llm/stream`：该事件不带 scope 载体，去掉也不生效。
>
> **判一个会话有没有走本项目链路，唯一判据是审计链**（§7.140）：
> `node scripts/probe-session-audit.mjs --session <id>`。会话头 / projcache 里的
> preset 标签都不可作判据 —— 一个是创建时快照、一个是客户端回写，可能与实际
> 绑定互相打架（2026-10-28 主人实机：标准模式会话「你可以做什么」审计链零事件）。
>
> **桌面版启动失败 / preset 状态异常 / Edge tab 不出现** ⇒ 看
> [docs/desktop-troubleshooting.md](./docs/desktop-troubleshooting.md)
> （桌面壳层故障手册：宿主认证 cookie 累积导致 431、活体名册探针、
> Edge tab 不出现的两类判据、通用排查动作表）。

## ✨ 核心特性

> **实现状态说明（2026-10-27）**：下表区分「已实装」与「路线图」。
> Layer 1 安全基座（`tcm` / `ohttp-gateway` / `secure-bridge` / `attestation`）
> 目前是**桩实现**（crypto 返回零字节、网关恒返回 200），尚未接入真实 TEE 与
> RFC 9458 中继。**当前真正生效的隐私保证来自 Layer 2**（脱敏管线 + 策略引擎
> + 审计链 + Realm 闸门）。详见
> [docs/architecture.md](./docs/architecture.md#第1章-总览四层模型--realm--cordis-插件机制)
> 的分层状态表与 `tests/unit/layer1-stubs-and-edge-config.test.ts`
> （桩契约测试：一旦有人实装真实后端，这些断言会失败，强制同步改文档）。

| 能力 | 状态 | 说明 |
|---|---|---|
| **🔒 端侧优先** | ✅ 已实装 | 默认本地 LLM 处理，云端仅在明确需要时调用；`stages.*.provider` 固定走本地模型 |
| **🛡️ 隐私保护** | ✅ 已实装 | PII 可逆脱敏（10 类规则，单一事实源）+ 不可逆日志掩码 + 隐私策略热重载 + 策略文件 HMAC 签名校验 |
| **🚦 Realm 三级闸门** | ✅ 已实装 | LOCAL → SANITIZED → CLOUD；分类→脱敏→路由→执行的完整拦截链，缺件即降级本地 |
| **🚨 威胁检测** | ✅ 已实装 | `td-bus` 滑动窗口计数 + 分级 + 隔离；超阈值返回 503 |
| **📜 审计与可追溯** | ✅ 已实装 | 追加式 JSONL 审计链 + ops log 详细 LLM request/response 追踪（PII + 厂商密钥双重脱敏） |
| **🔌 插件化** | ✅ 已实装 | 22+1 个 plugin（含 1 桌面 webview bundle），全部 subpath 导出，`verify:*` 门禁锁死装配面 |
| **🌐 零信任通信** | 🚧 路线图 | RFC 9458 OHTTP 网关为**桩实现**；当前云端通道走标准 TLS |
| **🔑 TEE / 远程证明** | 🚧 路线图 | `tcm` / `attestation` 为**桩实现**；真实 TEE 后端待接入 |
| **🖥️ 三平台** | ✅ 已实装 | Windows / macOS / Linux 各自一条构建命令（`npm run build:windows|macos|linux`）；桌面版三平台通吃，独立 HTTP profile 见支持矩阵 |

## 🏗️ 架构速览

四层架构（安全基础 → 隐私控制 → Agent → 用户交互），数据按 Realm 分级：
**LOCAL**（完全在设备端）→ **SANITIZED**（PII 替换后上云）→ **CLOUD**（用户授权后原始上云）。
路由默认本地：未决轮次留在设备上，只有带公网检索信号的请求才（脱敏后）出网。

> 完整设计（四层架构图 / Realm 模型 / 19 插件职责表 / LLM 路由与 §7.107
> 三档搜索链 / 入口架构）见
> [docs/architecture.md](docs/architecture.md)（§7.107 章为本仓最新设计增量）。

---

## 📦 安装

### 系统要求

| 组件 | 最低版本 | 推荐版本 |
|---|---|---|
| Node.js | `^22.19` 或 `>=24` | `>=22.20` |
| pnpm | `^10` 或 `^11` | `^11.7.0` |
| 操作系统 | Linux / macOS / Windows | Linux |
| 架构 | x64 / arm64 | arm64（for TEE） |

> **上游版本策略**：不锁定 `@deepseek-ai/dsh-*` 具体版本，跟随最新已发布 RC
> （当前最低兼容 `0.2.1-rc.2`，允许更新版本）。详见
> [docs/version-policy.md](docs/version-policy.md)。Node/pnpm 工具链仍保留约束。

### 前置依赖

```bash
# 1. DSH CLI（DeepSeek Harness 官方客户端）
npm install -g @deepseek-ai/dsh
dsh --version   # 验证

# 2. pnpm
npm install -g pnpm
# 或：corepack enable pnpm
pnpm --version   # 验证

# 3.（可选）TEE 开发环境
# 仅当需要在真实 TEE 上运行时需要：
#   ARM TrustZone  → 支持 TrustZone 的设备上编译 OP-TEE
#   RISC-V Keystone → RISC-V 工具链
#   Intel SGX       → Intel SGX SDK
# 脚手架阶段可用 simulated 后端，无需真实 TEE。
```

### 方式一：构建打包（三平台各自一条命令）

```bash
git clone https://github.com/chschytzmcy/dsh-edge-agent.git
cd dsh-edge-agent

pnpm install

npm run build:windows    # Windows（Git Bash）
npm run build:macos      # macOS
npm run build:linux      # Linux
```

**支持矩阵**：

| | 桌面版 | dsh-cli / dsh-web / dsh-edge-agent HTTP profile |
|---|---|---|
| **Windows** | ✅ | ❌ 桌面 App 独占 `desktop` profile，CLI 碰不了 |
| **macOS** | ✅ | ✅ |
| **Linux** | ✅ | ✅ |

> Windows 上 `make` / `rsync` 不可用（Git Bash 缺 rsync/setsid/ss/make），
> `make package` 与 `install.sh` 都用不了——`npm run build:windows` 是
> Windows 上唯一的构建路径。

三个脚本共用同一个 Node 核心（`scripts/_pack-core.mjs`），产物**字节一致**；
平台差异只在 runtime 探测与 tar 口味。

**产物**（两种模式同源，均过 verify-installable 门禁）：

```
dist/installable/dsh-edge-agent-desktop-safe/   ← link（开发）
dist/installable/dsh-edge-agent-full/
dist/dsh-edge-agent-desktop-safe.tar.gz         ← tar（分发）
dist/dsh-edge-agent-full.tar.gz
```

**两个变体**：用 `desktop-safe`（只 insert 隐私栈，不改宿主 persona /
approval / sandbox / session root，不起 http-api）；`full` 会改写宿主全局
配置，只适合专用 profile，不要装进日常桌面。

### 方式二：装进 DSH 桌面版（Windows / macOS / Linux）

桌面 App（DeepSeek Harness）的 `desktop` profile 由 Electron 独占管理，
CLI 碰不了——但 App 侧边栏 **Plugins → Add plugin → Install a
third-party plugin** 支持 npm / Git / **本地目录** 三个通道。本仓标准走法
是「本地目录」装 desktop-safe 产物。

**手动安装**：

```
1. 桌面 App 侧边栏 Plugins → Add plugin → 本地目录
2. 填【绝对路径】：
   Windows  C:\Users\<你>\GolandProjects\gitlab\dsh-edge-agent\dist\installable\dsh-edge-agent-desktop-safe
   macOS    /Users/<你>/code/dsh-edge-agent/dist/installable/dsh-edge-agent-desktop-safe
   Linux    /home/<你>/code/dsh-edge-agent/dist/installable/dsh-edge-agent-desktop-safe
   （相对路径会被拒："a local path must be absolute"；
     Git Bash 里的 /c/Users/… 是 MSYS2 虚拟路径，桌面 App 不认，必须用 C:\… ）
3. 安装 → 启用 → 重启 DSH
4. 验证：右栏出现 Edge tab；审计里确认配置来源
   grep -o '"kind":"config.loaded".\{0,240\}' ~/.dsh-edge-agent/audit/audit.plain.jsonl | tail -1
```

**一键安装**（构建 + 切模式）：

```bash
npm run build:windows -- --install-desktop=link   # 开发模式（link:）
npm run build:windows -- --install-desktop=tar    # 分发模式（file:）
npm run build:macos   -- --install-desktop=link
npm run build:linux   -- --install-desktop=link
```

**两种模式**：

| | link（开发） | tar（分发） |
|---|---|---|
| profile 里记成 | `link:<abs>` | `file:<abs>` |
| node_modules 里 | 符号链接指向 `dist/installable/` | 解包后的冻结副本 |
| 改代码后 | 同步文件 + 重启 App | 必须重装 |

**link 模式的迭代循环**（免重装）：

```bash
npm run compile
cp -r lib/. "dist/installable/dsh-edge-agent-desktop-safe/lib/"
# 重启桌面 App 生效
```

> ⚠️ **`dist/installable/*/config/edge.json` 含明文 API key**（桌面 link 模式
> 靠它找到活配置）。别把 `dist/` 整个目录发给别人——tarball 那份是干净的
> （已排除 `edge.json`）。

**方式二之二：填 GitHub 仓库地址（现场编译，适合分发给别人）**

桌面 App 的同一个对话框也接受仓库地址；宿主会克隆源码、在本地跑 `prepare`
编译出 `lib/`，再装成 bundle：

```
1. 桌面 App 侧边栏 Plugins → Add plugin → 填
   https://github.com/chschytzmcy/dsh-edge-agent
2. 首次会失败并提示「允许这些脚本并重试」——点它放行本仓的构建脚本
3. 装完点「立即启用」（GUI 不会自动启用）
4. 重启桌面 App
5. 配置写进 ~/.dsh-edge-agent/edge.json（git 装出来的包里不含明文密钥）
```

两个前置条件：**仓库要匿名可读**（私有库需要本机 git 有非交互凭据）、
**PATH 上要有 `pnpm`**（宿主 runtime 的 `bin/` 里只有 node；`npm i -g pnpm`
可解，装完要重启桌面 App）。细节见
[`docs/deploy-github.md`](docs/deploy-github.md)。

### 方式三：部署独立 HTTP profile（macOS / Linux）

`dsh-edge-agent` profile = **桌面那套 edge 逻辑 + 一层 HTTP overlay**
（`profiles/dsh-edge-agent/cordis.patch.yml` 只加一条 http-api row）。独立
进程 = 独立的内存 fold，所以 HTTP profile 的轮次不会污染桌面 Edge tab
面板（两者只共享 `~/.dsh-edge-agent/audit/` 磁盘审计轨）。

```bash
# 一条命令：build + 装 bundle + 同步配置 + 重启 + 验活
npm run build:macos -- --deploy-profile=dsh-edge-agent
npm run build:macos -- --deploy-profile=dsh-web
npm run build:macos -- --deploy-profile=dsh-tui

# 等价底层命令
bash scripts/deploy-profile.sh dsh-edge-agent [--no-build] [--no-restart]
```

| profile | 用途 | UI |
|---|---|---|
| `dsh-edge-agent` | 独立 HTTP profile（`:21017`） | 无（headless） |
| `dsh-web` | 官方 Web UI（`:3080`）+ IM 机器人 | 浏览器 |
| `dsh-tui` | 终端 | 终端 |

> 脚本要求 dsh CLI 可达（macOS 走 App 内嵌路径，Linux 走 PATH/npm-global，
> `DSH_EDGE_BIN` 可覆盖）。它会打包 desktop-safe bundle → 写 profile 骨架与
> overlay → 强制重新解包（pnpm 不重解包坑）→ 同步配置（**保留运维活密钥**）
> → 重启 → 验活。

### 方式四：从源码部署到现有 dsh-tui / web profile（macOS / Linux）

`install.sh` 一次只部署一个 profile(target)，先杀掉其他 profile 进程，
再 restart target 拿新代码：

```bash
./install.sh                            # 默认：dsh-edge(:21017)
./install.sh --profile=web              # 切 web(:21017 + webui :3080)
./install.sh --profile=tui              # 切 dsh-tui(:21017)
./install.sh --no-restart               # 只同步不杀不启(开发改代码反复迭代时)
```

> bundle 是 profile-agnostic 的——`--profile=` 接受任何 DSH profile 名。HTTP
> 端口统一 :21017；切 profile 前 install.sh 必杀其他进程（避免 EADDRINUSE +
> audit TOCTOU race）。加新 profile 只在 install.sh `OTHER_PROFILES` 列表里
> 添一行即可。

> 完整细节（npm/Git/本地目录/tarball 四种 spec 的判定规则、§7.101 Edge
> tab 验收清单、桌面目录结构一览、Windows 实测 §8.2.1）见
> [docs/load-into-local-dsh.md](docs/load-into-local-dsh.md)。

### 首次启动流程

**桌面版**：`npm run build:<platform>` → App 里按方式二装 → 重启 DSH。插件挂载后
右栏出现 Edge tab，审计里出现 `input-guard.hook.registered` / `http.started`。

**独立 HTTP profile**（`npm run build:macos -- --deploy-profile=dsh-edge-agent`
或 `bash scripts/deploy-profile.sh dsh-edge-agent`）会执行：


1. 检测 dsh CLI / node 是否已安装
2. 打包 desktop-safe bundle → `dist/*.tar.gz`
3. 写 profile 骨架 + overlay（`profiles/<name>/` → `~/.dsh/profiles/<name>/`）
4. `dsh plugin --profile <name> add file:<tarball>`；**先把旧目录挪走**——pnpm
   不会因为 tarball 内容变了就重新解包（会报 "Already up to date" 但
   `node_modules/` 里还是旧代码）
5. 同步 `config/privacy-policy.json` + `config/edge.json` → `~/.dsh-edge-agent/`
   （**运维的活密钥优先**，部署不会覆盖已轮换的 API key）
6. 重启 profile → 验活（`/v1/health` 带 bearer）

完成后 HTTP API 监听 `:21017`（`/v1/chat`，GET `/v1/health`）。

**从源码部署到现有 profile**（`install.sh`，§7.69 单 profile 架构）额外会：
装 7 个上游包（dsh-agent-loop / dsh-tool-web / dsh-web / dsh-web-search-deepseek
/ dsh-skill / dsh-tool-skill / dsh-skill-filesystem）、rsync `lib/` → 嵌套包、
同步 `cordis.patch.yml`（**bundle-level patch**，§7.31 fix）、杀掉其他 profile
进程（避免 EADDRINUSE + audit TOCTOU race）。

数据面单 root `~/.dsh-edge-agent/`（§7.36 起各 profile 共享，§7.68 撤回 §7.61
audit 分流，所有 profile 共写 `audit/audit.plain.jsonl`）。

### 验证安装

```bash
# 1. bundle 已注册到 target profile？
grep '@deepseek-harness-edge-agent/dsh-edge-agent' ~/.dsh/profiles/<profile>/package.json

# 2. 隐私栈全部挂载？（desktop-safe 是 18 个 row，full 19 个）
dsh --profile <profile> --dump-config | grep -E 'input-guard|file-logger|intent-router|sanitizer' | wc -l
# 期望：≥4

# 3. 单 profile 运行(§7.69)?只一个 dsh 进程 + :21017 在听
pgrep -af 'dsh --profile' | grep -v pgrep
ss -tlnp | grep -E '21017'

# 4. http-api 健康检查（带 bearer）
TOKEN=$(node -p "require('fs').readFileSync(process.env.HOME+'/.dsh-edge-agent/edge.json','utf8').secrets.edgeApiKey")
curl -s --max-time 3 -H "Authorization: Bearer $TOKEN" http://127.0.0.1:21017/v1/health
```

> **桌面版**的验证：右栏出现 **Edge** tab → 发一条本地 query → Intent panel
> 出现一行；审计里确认配置来源：
> ```bash
> grep -o '"kind":"config.loaded".\{0,240\}' ~/.dsh-edge-agent/audit/audit.plain.jsonl | tail -1
> ```

### 故障排查

| 现象 | 排查 |
|---|---|
| `未检测到 dsh CLI` | `npm install -g @deepseek-ai/dsh` 后 `hash -r` |
| `未检测到 pnpm` | `npm install -g pnpm` 或 `corepack enable pnpm` |
| dsh-tui 启动失败 | `tail -50 ~/.dsh/profiles/dsh-tui/run.log` 看 `intentRouter: found` 行 |
| web profile 启动后 `:3080` 不 listen | `tail -50 ~/.dsh/profiles/web/run.log` 看 `dsh web:` 行；可能是 webui 包未装，跑 `dsh plugin --profile web add @deepseek-ai/dsh-web @deepseek-ai/dsh-web-ui-all` |
| 19 个 plugin 只挂载 dsh-base 的 30 个（bundle 没生效） | `dsh plugin --profile dsh-tui add @deepseek-harness-edge-agent/dsh-edge-agent` 重装；或者 `install.sh §2.6 + §2.7` 没跑，手动 cp `cordis.patch.yml` 到嵌套包根 |
| `adapter boundary violated` | 把 `@deepseek-ai/*` 的 import 移到 `src/dsh-adapter/` 内（或经 `src/dsh-adapter/types.ts` 重新导出） |
| `upstream contract violated` | 上游 DSH 包低于最低兼容版本（当前 `0.2.1-rc.2`），或各 `@deepseek-ai/dsh-*` 包版本不一致；运行 `pnpm install` 或 `pnpm update @deepseek-ai/dsh-agent @deepseek-ai/dsh-llm ...` |
| Windows：`a local path must be absolute` | 填的是 Git Bash 的 `/c/Users/...`（MSYS2 虚拟路径），桌面 App 只认原生 `C:\Users\...`。用构建脚本输出的路径 |
| Windows：`Cannot connect to C: resolve failed` | tar 把 `C:` 当成远程主机名（GNU tar 的 `host:path` 语法）。当前脚本已规避（tar 只收相对路径）；若仍遇到，检查是否有旧版 `build-desktop-bundle.sh` |
| Windows：`/c/Program: No such file or directory` | 旧版 `build-desktop-bundle.sh` 把 node+pnpm 拼成字符串再未加引号展开，路径含空格被切开。用 `npm run build:windows` |
| Windows：`rename still locked (EPERM)` → `in-place` | **不是错误**——桌面 App 开着并持有 `dist/installable/` 句柄，脚本降级为逐条覆盖，`link:` 目标持续有效，重启 App 即生效。想要干净原子换目录就退出 App 再跑 |

### 卸载

```bash
# 1. 停所有 dsh profile
pkill -f 'node.*dsh --profile dsh-tui' || true
pkill -f 'node.*dsh --profile web' || true

# 2. 从 profile bundles 列表移除 bundle
# （CLI：dsh plugin --profile dsh-tui remove <bundle> — 如 dsh CLI 提供）
# 或手动编辑 ~/.dsh/profiles/dsh-tui/package.json 删除 bundles + dependencies 中的 dsh-edge-agent
# §7.43: dsh-tui + web 都要处理（如果都装过）

# 3. 移除嵌套包
rm -rf ~/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-edge-agent/
rm -rf ~/.dsh/profiles/web/node_modules/@deepseek-harness-edge-agent/   # 若 web 装过

# 4. 移除 bundle 数据（注意：会删除所有会话和加密数据！）
rm -rf ~/.dsh-edge-agent-web/

# 5. 移除全局包（如适用）
npm uninstall -g @deepseek-harness-edge-agent/dsh-edge-agent
```

---

## 🚀 部署

### 方式一：配置文件（推荐，§7.102）

配置只有**一个文件**：`config/edge.json`。所有 profile（desktop GUI / dsh-tui /
dsh-web / dsh-edge）读同一份，不依赖环境变量。

```bash
# 1. 把 dsh CLI 加入 PATH（如果用 npm-global 安装）
export PATH="$HOME/.npm-global/bin:$PATH"

# 2. 复制配置模板并填写
cp config/edge.example.json config/edge.json
$EDITOR config/edge.json   # 填入 secrets.* 的真实 key、llm.local.baseUrl 等

# 3. 部署（会把 config/edge.json 同步到 ~/.dsh-edge-agent/edge.json）
#    桌面版：npm run build:macos -- --install-desktop=link
#    CLI profile：npm run build:macos -- --deploy-profile=dsh-edge-agent
#    或从源码部署到既有 profile：./install.sh --skip-pnpm

# 4. 启动（桌面版由 App 管理；CLI profile 手动起）
cd ~/.dsh/profiles/dsh-edge-agent
setsid nohup dsh --profile dsh-edge-agent > run.log 2>&1 < /dev/null &
disown

# 或前台（debug 用）
dsh --profile dsh-edge-agent
```

> **桌面 GUI 用户**：`config/edge.json` 随 bundle 一起装进
> `~/.dsh/profiles/<profile>/node_modules/@deepseek-harness-edge-agent/dsh-edge-agent/config/`，
> GUI Add Plugin 后立即生效 —— **不需要 source 任何 env**。
>
> ⚠️ `dist/installable/*/config/edge.json`（桌面 link 模式用的那份）**含明文
> API key**——别把 `dist/` 整个目录发给别人。tarball 那份是干净的。

### 方式二：改用系统环境变量（CI / 临时调试）

CI 里没有文件时，可以只写 `~/.dsh-edge-agent/edge.json`（loader 的第 2 顺位）：

```bash
export PATH="$HOME/.npm-global/bin:$PATH"

# 最小可用配置
cat > ~/.dsh-edge-agent/edge.json <<'JSON'
{
  "secrets": { "dashscopeApiKey": "sk-..." },
  "llm": {
    "local": {
      "baseUrl": "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      "model": "qwen3.6-flash",
      "keyRef": "dashscopeApiKey"
    }
  }
}
JSON

dsh --profile dsh-tui
```

### LLM 路由（速览）

意图路由自动选 LLM，无需手动指定 provider：**未决轮次一律 LOCAL**
（本地 OpenAI 兼容端点）；**只有带公网检索信号的请求**（新闻/最新/天气/
web search…）才判 CLOUD 脱敏出网——分类器判了 CLOUD 但没公网信号同样
降级回本地（`no-web-need` gate）。云池不配即 DELEGATE 到宿主 profile
提供商，唯一必配的是 LOCAL 池。

> 路由细节（三层兜底 / 实体护栏 / §7.100 DELEGATE 链 / 三档搜索
> fail-down）见 [docs/architecture.md §7.107 章](docs/architecture.md) 与
> [docs/intent-and-sanitization.md](docs/intent-and-sanitization.md)。

> **REJECT 永不出网**（§7.128）：策略规则或分类器判下的 REJECT 绝不会被改写成
> CLOUD —— fail-closed（默认）直接拦下，fail-open 也只降级到 LOCAL 留在设备上
> 继续，且仍会注册 session realm（Layer 3 的 tool-realm gating 不许 fail-open）。
>
> **面板不得断言与数据相矛盾的事**（§7.129 / §7.130）：Tier-0 设备指令正则裁决的
> 一轮显示「设备指令正则裁决」，不会谎称「LLM 裁决」（分类器压根没被调用）。
>
> 「是否出网」的判据是 **category（哪个池）**，**不是**端点落在哪台机：
> `category=LOCAL` 即**不算出公网** —— `llm.local` 池是 operator 自有设施，
> 端点不在本机也照样不出网，不用关心具体的模型来源。顶部结论、PII 节点、
> 答案出口三处一律按 category 说话：LOCAL 说「数据未离开设备」/「无需脱敏」/
> 「全部留在本机」，CLOUD 说云端结论。意图判定节点仍透出「真实落点 …」（备查
> 信息，见 §7.122），那是**落点披露**，不是出网判断。
>
> **出网只带云段历史**（§7.131）：发往 `cloud-llm` 的请求**只携带之前所有上过
> cloud-llm 的历史**；任何 local-llm 段的历史会话信息一律不带 —— 默认路由是
> 本地池，本地轮次积累的历史属于**本地资产**，路由被改写/恢复切回云端时不能跟
> 着上云。`local-llm` 反过来携带**全部**历史（本地池带什么都不算出网）。
> 保留块出网前还会再脱敏一次（可逆占位符），脱敏失败则 fail-closed 不出网。
> 分段依据是宿主给每条 assistant 消息打的 `source.provider`（路由 id）；
> 审计里的 `input-guard.message-sources` 与 ops log 的 `LLM_REQUEST.provider`
> 能直接看到每个会话段的归属。
>
> **答案出口只认本对话的出网**（§7.132）：插件自己也调 LLM —— 入口安检
> （`prompt-guard`）、意图分类器（`intent-router`）、宿主的会话标题生成 ——
> 它们与主对话走**同一个** adapter，落**同样**的 `llm.local.start` 审计行。
> 面板的「答案出口」取「最后一条」，于是会抓到那条短的内部调用，把主对话的
> 真实出网状态盖掉（显示「作答中」，或者更糟 —— 显示一条**根本没发生过**的
> 失败）。现在出口审计行带两个判别字段：`internal`（我们自己的内部调用标记）
> 与 `tools`（这次请求带了几件工具 —— 主对话恒带 30+ 件，一切内部调用一件
> 都不带）。面板据此把内部调用排除在「答案出口」之外；`tools` 恒落（宿主没
> 传工具时落 `0`），所以宿主的标题插件也一并被排除，而 §7.132 之前的旧数据
> （没有这些字段）仍然照旧显示，不退化。
>
> **LLM 调用记录按类别分组、请求响应成对**（§7.134）：Edge 标签页底部的
> 「LLM 调用」板块按**攻击检测 / 意图判定 / 路由决策 / 宿主内部调用**分组
> （复用 §7.132 的 `caller` 标记与 Flow 面板的同一批文案），每次往返的
> **请求在上、响应在下**成对显示。配对靠 `callId` —— 一次 `stream()` 一个
> call，REQ 与 RESP 共用；重试时可能出现多条 RESP，取最后一条（最终结果）。
> 面板只列索引（provider / 归属 / 大小 / 用时），正文点开才按需拉取。

### 本地 LLM 端点

`local-llm-adapter` 始终走真实 OpenAI 兼容端点。端点指向任一 llama.cpp /
vLLM / Ollama / DashScope 实例 —— 在 `config/edge.json` 的 `llm.local` 段：

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

---

## ⚙️ 配置参考

> **§7.102（2026-10-21）配置归一**：dsh-edge-agent 现在只通过**一个文件**配置 ——
> `config/edge.json`。旧的 `.env` / `.env.sh` 两条链（裸名 env → `.env.sh` 派生
> `DSH_EDGE_*` → cordis patch 读 `process.env`）已删除。
>
> **新的查找顺序**（与 profile 无关，desktop / tui / web / edge 一致）：
>
> ```
> 1. <bundle>/config/edge.json     ← 仓库 checkout 或 bundle 自带副本
> 2. ~/.dsh-edge-agent/edge.json   ← install.sh 部署的用户副本（可改）
> 3. <bundle>/config/edge.example.json  ← shipped 模板（空 secret + 默认值）
> ```
>
> 模板见 [config/edge.example.json](config/edge.example.json)（tracked）。
> **切勿提交 `config/edge.json`** —— 它含明文 API key，已在 `.gitignore` 里。

配置读取的唯一入口是 `src/dsh-adapter/edge-config.ts`。

### 🔑 Secret

`secrets` 段存明文 key，池通过 `keyRef` 指向它：

```jsonc
{
  "secrets": { "dashscopeApiKey": "sk-..." },
  "llm": { "local": { "baseUrl": "https://...", "model": "qwen3.6-flash", "keyRef": "dashscopeApiKey" } }
}
```

> **Secret 警告**：`config/edge.json` 含明文 API key，**绝不能提交到 git**。

### 🌐 通用配置

| 变量 | 默认值 | 取值范围 | 说明 |
|---|---|---|---|
| `DSH_EDGE_LANG` | `zh` | `zh` / `en` | 启动器消息语言（不影响 agent 内容语言） |
| `DSH_EDGE_WORKSPACE` | 当前目录 | 任意路径 | 工作目录 |
| `DSH_EDGE_RESUME_SESSION` | — | session id | 通过 `--resume` 设置 |
| `DSH_EDGE_PERMISSION_MODE` | `workspace-write`（部署默认）/ `ask`（Schema 默认） | `ask` / `workspace-write` / `danger-full-access` | 权限模式 |

### 🔐 TEE 配置

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

### 💾 存储配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_STORAGE_ROOT` | `~/.dsh-edge-agent/storage` | 存储根目录 |
| `DSH_EDGE_STORAGE_FILE` | `storage.plain.jsonl` | JSONL 存储文件名（未加密；AES-256-GCM 加密见 [Planned](./docs/PROGRESS.md#planned)） |

### 📜 策略配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_PRIVACY_POLICY_PATH` | `${DSH_EDGE_STORAGE_ROOT}/privacy-policy.json`（默认 `~/.dsh-edge-agent-web/storage/privacy-policy.json`）| 隐私策略文件路径 |
| `DSH_EDGE_REALM_HOT_RELOAD` | `true` | realm 配置热重载开关（不重载策略文件本身） |

### 🚦 路由配置

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

### 🤖 模型配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_DEFAULT_MODEL` | `local-llm` | 默认模型 |
| `DSH_EDGE_LOCAL_MODELS` | `local-llm,local-llm-llama3` | 本地模型列表（逗号分隔） |
| `DSH_EDGE_CLOUD_MODELS` | `cloud-llm,cloud-llm-v3` | 云端模型列表（逗号分隔） |

**本地 LLM**（`config/edge.json` → `llm.local`）

| 字段 | 默认值 | 说明 |
|---|---|---|
| `llm.local.baseUrl` | （空 = 不注册） | OpenAI 兼容端点 URL，**必须含 `/v1`**（adapter 只追加 `/chat/completions`） |
| `llm.local.model` | `qwen3-4b` | 端点 model id |
| `llm.local.keyRef` | （空 = 不发 auth 头） | 指向 `secrets` 段里的键名 |
| `llm.local.stripTools` | `false` | 省略 `body.tools`（minicpm Jinja2 bug 规避） |
| `llm.local.enableThinking` | `false` | 关掉 thinking-model 的 chain-of-thought |
| `llm.local.reasoningEffortNone` | `false` | **ollama 池必开** —— 见下 |

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

**云端 LLM**（§7.100 起整体可选 —— 不配即 DELEGATE 到宿主 profile 提供商）

| 字段 | 默认值 | 说明 |
|---|---|---|
| `llm.cloud.baseUrl` | （空 = DELEGATE） | 自研直连的 OpenAI 兼容端点 |
| `llm.cloud.model` | （空） | 直连模式 model id |
| `llm.cloud.keyRef` | （空） | 指向 `secrets` 段里的键名 |
| `llm.cloud.delegate` | `true` | `false` 禁用委托：云不可用 → input-guard 降级 LOCAL（LOCAL-only 部署用） |
| `llm.cloud.delegateProvider` | （自动） | 显式锁定委托目标路由 id（如 `qwen-token-plan-cn`） |
| `llm.cloud.delegateModel` | （跟随宿主选择） | 委托 wire model override |

配置 `llm.cloud.baseUrl` 即切回自研直连；解析链详见 PROGRESS §7.100。

### 🌐 出站配置

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

### 🛡️ 审计与威胁检测

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

**详细 LLM 追踪**（§7.118，写进 ops log）

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

**Edge 面板的原始判断数据**（§7.121）

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

### 🛠️ 工具配置

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

### 🎤 语音输入

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_VOICE_MODEL` | `~/.dsh-edge-agent/models/whisper-tiny.bin` | Whisper 模型路径 |
| `DSH_EDGE_VOICE_VAD` | `0.6` | VAD 静音阈值（秒） |
| `DSH_EDGE_VOICE_SR` | `16000` | 采样率 |

### 🔌 插件配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_PLUGINS_THIRD_PARTY` | `false` | 是否允许第三方插件 |

### 🌐 HTTP API（可选）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_HTTP_HOST` | `0.0.0.0`（部署默认）/ `127.0.0.1`（Schema 默认） | HTTP 服务器绑定地址 |
| `DSH_EDGE_HTTP_PORT` | `21017` | HTTP 服务器端口 |
| `DSH_EDGE_HTTP_BEARER` | — | Bearer token（如不设则禁用） |
| `EDGE_API_KEY` | — | API 鉴权密钥（注入到 `DSH_EDGE_HTTP_BEARER`） |

### 📊 遥测

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_TELEMETRY` | `false` | 是否启用 DSH 遥测 |

### ⚙️ 会话

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_SESSION_ROOT` | `~/.dsh-edge-agent/sessions` | 会话 JSONL 根目录 |
| `DSH_EDGE_SESSION_TTL` | `3600` | 默认 TTL（秒） |
| `DSH_EDGE_MAX_SESSIONS` | `8` | 最大并发会话数 |
| `DSH_EDGE_SESSION_WINDOW_SIZE` | `32` | 意图路由的会话窗口大小 |

### ⚙️ Bash

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_BASH_TIMEOUT_MS` | `60000` | Bash 命令超时（毫秒） |

### 🛠️ 通过 cordis.yml 覆盖

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

---

## 🌐 入口架构

> §7.69 单 profile 架构，HTTP 端口统一 :21017；§7.107 起桌面版和 HTTP API
> 为**双 profile 双进程、同一套 edge 逻辑**（设计详见
> [docs/architecture.md §7.107 章](docs/architecture.md)）。

| profile | 进程 | 入口 | 状态 | 平台 |
|---|---|---|---|---|
| `desktop` | DSH 桌面 App（Electron 管理） | GUI + 右栏 **Edge** tab | desktop-safe bundle；App 的 plugin manager 管，CLI 不要碰 | Windows / macOS / Linux |
| `dsh-edge-agent` | `dsh --profile dsh-edge-agent`（后台） | HTTP API `:21017` | 同一 desktop-safe bundle + profile overlay 挂 http-api | macOS / Linux |
| `web`（切换时） | dsh-web | 官方 Web UI `:3080` + IM 机器人 | 浏览器 / IM 用户入口 | macOS / Linux |
| `dsh-tui`（切换时） | dsh-tui | 终端 | 终端用户入口 | macOS / Linux |

两边共用 `~/.dsh-edge-agent/edge.json`（唯一配置源）与 `~/.dsh-edge-agent/audit/`（审计落盘）。

> **Windows 只有桌面版**：桌面 App 独占 `desktop` profile，CLI 碰不了；所以
> Windows 上没有独立的 dsh-cli / dsh-web / dsh-edge-agent profile 部署路径。

### 部署 dsh-edge-agent HTTP profile（§7.107 一次命令）

```bash
# 顶层（推荐：构建 + 部署一步到位）
npm run build:macos -- --deploy-profile=dsh-edge-agent
npm run build:linux -- --deploy-profile=dsh-edge-agent

# 底层等价命令
bash scripts/deploy-profile.sh dsh-edge-agent          # build + 装 bundle + 同步配置 + 启动 + 验证
bash scripts/deploy-profile.sh dsh-edge-agent --no-build
bash scripts/deploy-profile.sh dsh-edge-agent --no-restart
```

> 脚本要求 dsh CLI 可达（macOS 走 App 内嵌路径，Linux 走 PATH/npm-global，
> `DSH_EDGE_BIN` 可覆盖；Windows 见
> [docs/load-into-local-dsh.md §8.2.1](docs/load-into-local-dsh.md) 的内嵌
> `dsh.cmd` 等价路径）。它会打包 desktop-safe bundle → 写 profile 骨架与
> overlay → 强制重新解包（pnpm 不重解包坑）→ 同步配置（**保留运维活密钥**）
> → 重启 → 验活。

### 浏览器 / IM 用户 → `:3080`

打开浏览器访问 `http://127.0.0.1:3080`，使用 DSH 官方 Web UI（chat / task-board / pet / IM机器人 等）。鉴权由 DSH 上游的配对 token 流程处理。

`@xmanrui/dsh-im` 插件通过 webserver 内部 `apiProxy` 把 IM 消息接入 agent-loop——**不监听新端口**，自动继承 input-guard 隐私管线。凭据在 Web UI「设置 → IM机器人」页面配置，只入 `dsh-credentials-local` 受保护本地存储，配置文件不落盘。支持飞书 / 微信 / 钉钉 / 企业微信 / QQ / Slack / Telegram / Discord / WhatsApp + AI Office Connector。

> **⚠️ AI Office 风险**：AI Office Connector 让本机 Harness **主动**连接公网 Office（不需公网 IP / 端口转发），但 SSE 下行的增量文本会回到公网 Office。**只在用户主动启用**后生效。

### 重新启用 http-api（可选，advanced）

如果你确实需要 CLI / SDK / cURL 调用（`curl :21017/v1/chat`），http-api 代码完整保留在 `src/dsh-adapter/http-api.ts`。启用步骤：

```bash
# 1. 编辑 cordis.patch.yml:313 把 disabled: true 删掉（或改成 false）
$EDITOR cordis.patch.yml

# 2. 同步到嵌套包 + 重启 web profile
./install.sh --skip-pnpm --profiles=web
```

启用后，http-api 会在 `:21017` 重新 listen（与 `:3080` webui 并存）。
REST 完整示例（chat / SSE / 会话管理 / OpenAPI）与鉴权/CORS 约定见
[docs/TEST-REPORT.md](docs/TEST-REPORT.md)；接口规范详见
[docs/architecture.md](docs/architecture.md)。

> **⚠️ 鉴权约定**：Bearer token 从环境变量 `EDGE_API_KEY` 注入；**不要硬编码**到配置文件。生产环境使用 secret manager。
> **⚠️ CORS**：v1 不启用 CORS。程序端请同主机调用；浏览器请走 `:3080` 官方 Web UI。

---

## 🔌 扩展

`function-call-external` 插件采用 **HTTP 契约边界**——任何实现该契约的 HTTP
服务（cactus-needle / 自训端侧模型 / 第三方 hosted API）都可通过
`FUNCTION_CALL_EXTERNAL_URL` 接入，plugin 主体零修改。契约与失败语义见
[docs/function-call-external-http-contract.md](docs/function-call-external-http-contract.md)。

---

## 🧪 测试

```bash
pnpm test                 # 单元测试（2026-10-26：52 文件 1067 passed / 2 skipped / 0 failed）
pnpm run verify:build     # 11 项构建门禁
pnpm run lint             # eslint（0 error 基线）
bash scripts/e2e-ops-log-coverage.sh   # E2E ops log 4 用例（2026-10-24：4/4 全绿）
```

## 📦 构建打包

```bash
npm run build:windows     # Windows（仅桌面版）
npm run build:macos       # macOS（桌面版 + CLI profile）
npm run build:linux       # Linux（桌面版 + CLI profile）
```

三个脚本共用 `scripts/_pack-core.mjs`（纯 Node），产物字节一致；平台差异
只在 runtime 探测与 tar 口味。详见上文「方式一 / 方式二 / 方式三」。

完整测试报告（手动 smoke / http-api 示例 / intent 规则表 / 自动化 / §7.107
E2E 实测记录）见 **[docs/TEST-REPORT.md](docs/TEST-REPORT.md)**。

---

更多文档见 [docs/architecture.md](docs/architecture.md)：[架构](docs/architecture.md) · [上游适配契约](docs/architecture.md) · [威胁模型](docs/architecture.md) · [插件开发](docs/architecture.md) · [实施进度](docs/PROGRESS.md) · [意图与脱敏详细设计](docs/intent-and-sanitization.md) · [三层决策参考手册（正则/决策模型/LLM 全清单）](docs/intent-decision-reference.md) · [测试报告](docs/TEST-REPORT.md)

`docs/` 目录的**总索引**（每份文档一句话说明 + 状态标记 + 处置判据）见 **[docs/README.md](docs/README.md)**。

MIT License. 详见 [LICENSE](LICENSE)。
