# dsh-edge-agent

> 边缘侧私密智能体 · 基于 DSH (DeepSeek Harness) Cordis 插件机制

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-blue)](package.json)

`dsh-edge-agent` 是一个面向用户的端侧私密智能体，基于 [DeepSeek Harness](https://github.com/deepseek-harness) 的 Cordis 插件机制构建。敏感数据默认留在设备端，仅在用户授权时通过零信任通道与云端通信。

## ✨ 核心特性

- **🔒 端侧优先**：默认本地 LLM 处理，云端仅在明确需要时调用
- **🛡️ 隐私保护**：PII 自动脱敏 + 隐私策略热重载（[AES-256-GCM 加密存储](./docs/PROGRESS.md#planned)）
- **🌐 零信任通信**：RFC 9458 OHTTP 协议，云端无法关联用户身份与请求
- **🚨 威胁检测**：实时监控异常行为，自动隔离可疑流量
- **🔌 插件化**：19 个 plugin（含 1 桌面 webview bundle），全部 subpath 导出

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

### 方式一：从源码构建（推荐开发者）

```bash
git clone https://github.com/chschytzmcy/dsh-edge-agent.git
cd dsh-edge-agent

pnpm install
pnpm run compile

# §7.69 (2026-09-17): 单 profile 架构 —— 默认 dsh-edge,杀其他+启指定,端口统一 :21017
./install.sh                            # 默认：杀 dsh-tui + web,同步 + 启 dsh-edge(:21017)
./install.sh --profile=web              # 切 web:杀 dsh-tui + dsh-edge,同步 + 启 web(:21017 + webui :3080)
./install.sh --profile=tui              # 切 dsh-tui:杀 web + dsh-edge,同步 + 启 dsh-tui(:21017)
./install.sh --profile=dsh-edge         # 显式(与默认等价)
./install.sh --no-restart               # 只同步不杀不启(开发改代码反复迭代时)

# 手动启动某个 profile（开发循环）
cd ~/.dsh/profiles/dsh-tui
setsid nohup dsh --profile dsh-tui > run.log 2>&1 < /dev/null &
disown
```

### 方式二：把 bundle 装到现有 dsh-tui / web profile（profile-agnostic）

§7.69 单 profile 架构 —— install.sh 一次只部署一个 profile(target),先杀掉其他 profile 进程,再 restart target 拿新代码:

```bash
# 默认：部署 dsh-edge(项目自有 headless,无 UI)
./install.sh

# 切到浏览器宿主
./install.sh --profile=web

# 切到终端宿主
./install.sh --profile=tui   # 或 --profile=dsh-tui
```

> bundle 是 profile-agnostic 的——`--profile=` 接受任何 DSH profile 名(dsh-tui / web / dsh-edge / 自定义)。HTTP 端口统一 :21017(http-api schema 默认,`http-api.ts:63`);切 profile 前 install.sh 必杀其他进程(避免 EADDRINUSE + audit TOCTOU race)。加新 profile 只在 install.sh `OTHER_PROFILES` 列表里添一行即可。

> **当前桌面版（DeepSeek Harness App）**：CLI 不能管理 Electron 独占的 `desktop` profile，但桌面侧边栏 **Plugins → Add plugin** 支持 npm / Git / 本地目录三个通道，见下方方式四。

### 方式三：Windows

```cmd
:: PowerShell 或 cmd
:: （Windows 上 dsh CLI 行为一致；具体启动命令参考 DSH 官方 Windows 文档）
dsh plugin --profile dsh-tui add @deepseek-harness-edge-agent/dsh-edge-agent
:: 或装到任意 profile：dsh plugin --profile <name> add @deepseek-harness-edge-agent/dsh-edge-agent
:: §7.43: 想并存启动 dsh-tui + web 用 ./install.sh
```

> Windows 上的本机构建/打包：`install.sh` 与 `make` 不可用（Git Bash 缺
> rsync/setsid/ss/make）；实际命令链是 `npm run compile` +
> `bash scripts/build-desktop-bundle.sh --no-build`（Git Bash 自带 GNU tar
> 1.35 + shasum，脚本直接能跑；`pnpm` 不在 PATH 时统一用 `npm run`）。
> `--emit-dir` 在桌面 App 运行时目录被 `link:` 锁住会自动降级为就地同步
> （2026-10-24 起，详见方式四），无需退 App。模式切换（`--install-desktop=link|tar`）
> 在 Git Bash 同样可用：脚本自动探测 App 内嵌 `dsh.cmd`
> （`%LOCALAPPDATA%\Programs\DeepSeek Harness\...`），也可 `DSH_BIN` 显式指定。

### 方式四：部署到 DSH 桌面版插件（Windows / macOS）

桌面 App（DeepSeek Harness）的 `desktop` profile 由 Electron 独占管理，
CLI 碰不了——但 App 侧边栏 **Plugins → Add plugin → Install a
third-party plugin** 支持 npm / Git / **本地目录** 三个通道。本仓标准走法
是「本地目录」装 desktop-safe 产物（只 insert 隐私栈、不改宿主全局配置；
全量 `cordis.patch.yml` 会改写 persona/approval/sandbox/session root，不要
装进日常桌面）。

**共同步骤（两平台一致）**：

```bash
# 1. 生成可安装目录
npm run compile                                    # pnpm 不在 PATH 时用 npm run
bash scripts/build-desktop-bundle.sh --no-build --emit-dir
# → dist/installable/dsh-edge-agent-desktop-safe/   ← 本地目录通道用这个
# → dist/dsh-edge-agent-desktop-safe.tar.gz         ← CLI/分发用（不带 config/）
# 桌面 App 开着也能跑：目录被 link: 锁住时自动降级为就地同步（输出带 in-place 提示）

# 2. App 里安装：Plugins → Add plugin → 本地目录 → 填【绝对路径】→ 安装 → 启用
#    （相对路径会被拒："a local path must be absolute"）

# 3. 配置（产物故意不带真实密钥）：把 config/edge.json 放到 ~/.dsh-edge-agent/edge.json

# 4. 验证：右栏出现 Edge tab；审计里确认配置来源
grep -o '"kind":"config.loaded".\{0,240\}' ~/.dsh-edge-agent/audit/audit.plain.jsonl | tail -1
```

> **两种模式（2026-10-24 起）**：本地目录通道 = `link:` **开发模式**（profile 只做
> 符号引用，改 `dist/installable/<variant>/` 里的文件 + 重启 App 即生效，无需重装）；
> tarball 通道 = `file:` 分发模式（解包成冻结副本，更新需重装）。构建并切换一条命令：
> `bash scripts/build-desktop-bundle.sh --install-desktop=link`（或 `=tar`；
> macOS / Windows Git Bash / Linux 三平台通用）。
> 脚本每次全量重建两种产物并跑 verify-installable 门禁（含 `lib/client.js` Edge tab
> bundle——它不在 `pnpm run compile` 的产物里，缺了它 Edge tab 静默不出现）。

**Windows 特有（2026-10-24 实测）**：

- `--emit-dir` **不需要退桌面 App**（2026-10-24 起）：App 以 `link:` 挂着
  installable 目录时 rename 会被活句柄锁住（EPERM，重试救不了），脚本自动
  降级为**就地同步**——staging 逐条覆盖、目录不挪窝，`link:` 目标持续
  有效。想要干净的一次性原子换目录（POSIX 语义），退出 App 再跑即可。
- 填入的路径示例：
  `C:\Users\<你>\GolandProjects\gitlab\dsh-edge-agent\dist\installable\dsh-edge-agent-desktop-safe`
- **已经装过（link: 模式）的更新不需要重新安装**——直接改文件即可：
  ```bash
  npm run compile
  cp -r lib/. "dist/installable/dsh-edge-agent-desktop-safe/lib/"
  # 重启桌面 App 生效（§7.103：link: 目标持续有效，改文件无需 rename）
  ```

**macOS 特有**：

- tar 实现自动识别（2026-10-24 起）：系统自带 bsdtar 自动去掉 `--no-xattrs`
  （bsdtar 默认不写 xattr，`COPYFILE_DISABLE=1` 防 AppleDouble），**无需再装 gnu-tar**
- 退 App：`osascript -e 'tell application "DeepSeek Harness" to quit'`
- 填入的路径示例：
  `/Users/<你>/code/dsh-edge-agent/dist/installable/dsh-edge-agent-desktop-safe`
- 用 **tarball 更新**时注意 pnpm 不重解包的坑（内容变了仍报 "Already up to
  date"，须 mv 走旧目录再 `dsh plugin --profile desktop install`），完整
  步骤见 [docs/load-into-local-dsh.md §8.6](docs/load-into-local-dsh.md)。

> 完整细节（npm/Git/本地目录/tarball 四种 spec 的判定规则、§7.101 Edge
> tab 验收清单、桌面目录结构一览、Windows 实测 §8.2.1）见
> [docs/load-into-local-dsh.md](docs/load-into-local-dsh.md)。

### 首次启动流程

首次运行 `install.sh`（默认 `--profile=dsh-edge`，§7.69 单 profile 架构）会执行：

1. 检测 dsh CLI / pnpm 是否已安装
2. `dsh plugin add @deepseek-harness-edge-agent/dsh-edge-agent` 注册本 bundle 到 target profile 的 `dsh.profile.bundles` 列表
3. pnpm 装 7 个上游包（dsh-agent-loop / dsh-tool-web / dsh-web / dsh-web-search-deepseek / dsh-skill / dsh-tool-skill / dsh-skill-filesystem）
4. rsync `lib/` → profile 嵌套包
5. 同步 `cordis.patch.yml` 到嵌套包（**bundle-level patch**，§7.31 fix）
6. 数据面单 root `~/.dsh-edge-agent/`（§7.36 起各 profile 共享，§7.68 撤回 §7.61 audit 分流，所有 profile 共写 `audit/audit.plain.jsonl`）
7. 加载默认策略 `config/privacy-policy.json`（§7.87.13.3 起从仓库根 `config/` 复制到 `~/.dsh-edge-agent/privacy-policy.json`；也可由 `DSH_EDGE_PRIVACY_POLICY_PATH` 覆盖）
8. **杀掉其他 profile 进程**(dsh-tui + web,§7.69)+ 杀掉 target profile 旧进程 + restart target 拿新代码,HTTP 端口统一 :21017

完成后 HTTP API 监听 `:21017`(`/v1/chat`, GET `/v1/health`)。切 UI 用 `./install.sh --profile=web`(webui `:3080`)或 `--profile=tui`(终端)。

### 验证安装

```bash
# 1. bundle 已注册到 target profile？
grep '@deepseek-harness-edge-agent/dsh-edge-agent' ~/.dsh/profiles/dsh-edge/package.json

# 2. 19 个 plugin 全部挂载？
dsh --profile dsh-edge --dump-config | grep -E 'input-guard|file-logger|intent-router|sanitizer' | wc -l
# 期望：≥4

# 3. 单 profile 运行(§7.69)?只一个 dsh 进程 + :21017 在听
pgrep -af 'dsh --profile' | grep -v pgrep
ss -tlnp | grep -E '21017'

# 4. http-api 健康检查
curl -s --max-time 3 http://127.0.0.1:21017/v1/health
```

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
./install.sh --skip-pnpm

# 4. 启动（§7.43 默认 = dsh-tui）
cd ~/.dsh/profiles/dsh-tui
setsid nohup dsh --profile dsh-tui > run.log 2>&1 < /dev/null &
disown

# 或前台（debug 用）
dsh --profile dsh-tui
```

> **桌面 GUI 用户**：`config/edge.json` 随 bundle 一起装进
> `~/.dsh/profiles/<profile>/node_modules/@deepseek-harness-edge-agent/dsh-edge-agent/config/`，
> GUI Add Plugin 后立即生效 —— **不需要 source 任何 env**。

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
| `llm.local.baseUrl` | （空 = 不注册） | OpenAI 兼容端点 URL |
| `llm.local.model` | `qwen3-4b` | 端点 model id |
| `llm.local.keyRef` | （空 = 不发 auth 头） | 指向 `secrets` 段里的键名 |
| `llm.local.stripTools` | `false` | 省略 `body.tools`（minicpm Jinja2 bug 规避） |
| `llm.local.enableThinking` | `false` | 关掉 thinking-model 的 chain-of-thought |

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

| profile | 进程 | 入口 | 状态 |
|---|---|---|---|
| `desktop` | DSH 桌面 App（Electron 管理） | GUI + 右栏 **Edge** tab | desktop-safe bundle；App 的 plugin manager 管，CLI 不要碰 |
| `dsh-edge-agent` | `dsh --profile dsh-edge-agent`（后台） | HTTP API `:21017` | 同一 desktop-safe bundle + profile overlay 挂 http-api |
| `web`（切换时） | dsh-web | 官方 Web UI `:3080` + IM 机器人 | 浏览器 / IM 用户入口 |

两边共用 `~/.dsh-edge-agent/edge.json`（唯一配置源）与 `~/.dsh-edge-agent/audit/`（审计落盘）。

### 部署 dsh-edge-agent HTTP profile（§7.107 一次命令）

```bash
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
pnpm test                 # 单元测试（2026-10-24：52 文件 1042 passed / 0 failed）
pnpm run verify:build     # 11 项构建门禁
pnpm run lint             # eslint（0 error 基线）
bash scripts/e2e-ops-log-coverage.sh   # E2E ops log 4 用例（2026-10-24：4/4 全绿）
```

完整测试报告（手动 smoke / http-api 示例 / intent 规则表 / 自动化 / §7.107
E2E 实测记录）见 **[docs/TEST-REPORT.md](docs/TEST-REPORT.md)**。

---

更多文档见 [docs/architecture.md](docs/architecture.md)：[架构](docs/architecture.md) · [上游适配契约](docs/architecture.md) · [威胁模型](docs/architecture.md) · [插件开发](docs/architecture.md) · [实施进度](docs/PROGRESS.md) · [意图与脱敏详细设计](docs/intent-and-sanitization.md) · [测试报告](docs/TEST-REPORT.md)

MIT License. 详见 [LICENSE](LICENSE)。
