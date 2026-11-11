# 加载到本地 DSH（macOS / Windows / 当前桌面版 runtime）

> 2026-10-18 实测通过：DSH `0.2.1-rc.2` + 本仓 `lib/` + 隔离 profile `edge`，
> `GET /v1/health` → `{"status":"ok"}`。
> 2026-10-24 Windows 实测补充：§8.2.1（EPERM 坑 + link: 免重装更新）。

## 0. 先说结论

| 方式 | 可行性 | 说明 |
|---|---|---|
| CLI 管理当前 Electron 桌面会话的 `desktop` profile | ❌ | `dsh --profile desktop` 直接报 `managed exclusively by the Electron application`；不要手改 |
| **桌面 App 的 Plugins 页安装第三方 bundle** | ✅（装 desktop-safe 产物）/ ⚠️（直接装全量 patch） | Desktop 插件管理器支持 npm / Git / 本地目录三个通道；推荐用 §8 的 `--emit-dir` 可安装目录（desktop-safe）。全量 `cordis.patch.yml` 会改写全局模型、persona、approval、sandbox、session root，不适合直接装进日常桌面 |
| 用同一个 DSH runtime 起一个独立 profile（headless HTTP） | ✅ | 本文推荐；不碰 desktop，不影响当前 GUI |

## 0.1 桌面 App 其实能装插件，但本仓不是“桌面友好插件”

DSH Desktop 的侧边栏 **Plugins → Add plugin** 支持安装第三方 bundle，来源可以是：

- npm 包名；
- GitHub/GitLab/Bitbucket 仓库；
- **本机目录路径**。

所以“桌面不能加载插件”这个说法不准确。准确说法是：**CLI 不能管理
Electron 独占的 `desktop` profile，但 App UI 可以。**

不建议直接把本仓装进 `desktop`，因为 `cordis.patch.yml` 不只是挂载自己的
插件，还会改写宿主全局配置：

- 覆盖 `system-prompt/persona`；
- 禁用部分工具/子代理相关 row；
- 改 `approval` / `sandbox-policy` / `session-persistence-jsonl` root；
- 启动 http-api（默认 :21017）。

> **§7.100 变更**：全量 patch 现在**不再**覆盖 `agent-default-model`、也不再
> 禁用上游 `llm-deepseek`。云池改为 delegate 模式——`cloud-llm` 路由转发到宿主
> profile 已配置的模型提供商（正是桌面 GUI 选的那个）。因此"云路径用宿主模型"
> 这件事全量/desktop-safe 两条路径现在一致；差异只剩"是否改写 persona/审批/
> 沙箱/session root、是否起 http-api、是否禁用上游工具 row"这些全局项。

如果只想在桌面 GUI 里用它的隐私管线，应做一个“desktop-safe patch/profile
skin”：只 insert 需要的 edge 插件，不改这些全局项。本仓已提供该模式：
`cordis.desktop-safe.patch.yml`（打包与安装见 §8）。

## 1. 找到当前 DSH CLI

macOS 桌面版没有把 `dsh` 放进 PATH，CLI 在 app 内：

```bash
export DSH_BIN="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$DSH_BIN" --version
# 0.2.1-rc.2
```

## 2. 编译本仓

```bash
cd /Users/<user>/cy/code/dsh-edge-agent
pnpm install
pnpm run compile
```

> 本机若 `pnpm` 不在 PATH，可用 DSH 自带 pnpm：
> `/Users/<user>/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs`

## 3. 建一个隔离 profile（不碰 ~/.dsh/profiles/desktop）

下面用 `/tmp/dsh-edge-probe` 做演示；想持久化可换成
`$HOME/.dsh-edge-profile`。

```bash
export DSH_HOME=/tmp/dsh-edge-probe
PROFILE=edge
REPO=/Users/<user>/cy/code/dsh-edge-agent
PKG="$DSH_HOME/profiles/$PROFILE/node_modules/@dsh-edge/dsh-edge-agent"

rm -rf "$DSH_HOME/profiles/$PROFILE"
mkdir -p "$PKG"

# 3.1 profile 骨架：dsh-base + 本 bundle
cat > "$DSH_HOME/profiles/$PROFILE/package.json" <<'EOF'
{
  "name": "dsh-profile-edge",
  "private": true,
  "dependencies": {
    "@dsh-edge/dsh-edge-agent": "file:./node_modules/@dsh-edge/dsh-edge-agent"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@dsh-edge/dsh-edge-agent"
      ]
    }
  }
}
EOF
printf '[]\n' > "$DSH_HOME/profiles/$PROFILE/cordis.yml"
printf '[]\n' > "$DSH_HOME/profiles/$PROFILE/cordis.patch.yml"

# 3.2 嵌套 bundle：package.json + lib + bundle patch
cp "$REPO/package.json" "$PKG/package.json"
cp "$REPO/cordis.patch.yml" "$PKG/cordis.patch.yml"
cp -R "$REPO/lib" "$PKG/lib"

# 3.3 让 bundle 的 @deepseek-ai/* import 能解析
#     开发态快捷方式：复用本仓已安装的 0.2.1-rc.2 依赖。
ln -s "$REPO/node_modules/@deepseek-ai" \
      "$DSH_HOME/profiles/$PROFILE/node_modules/@deepseek-ai"
```

> `@deepseek-ai/dsh-base` 由 DSH app 自带（app.asar）解析；本仓不复制它。
> 生产部署应走 `install.sh` 的 pnpm 链，而不是 symlink。

## 4. 启动

```bash
export DSH_HOME=/tmp/dsh-edge-probe
export DSH_EDGE_HTTP_PORT=21099
export DSH_EDGE_HTTP_HOST=127.0.0.1
export DSH_EDGE_STORAGE_ROOT="$DSH_HOME/data"
export DSH_EDGE_AUDIT_ROOT="$DSH_HOME/audit"
export DSH_EDGE_LOG_ROOT="$DSH_HOME/log"

"$DSH_BIN" --profile edge >"$DSH_HOME/boot.log" 2>&1 &
```

启动成功时 audit 里会有：

```text
input-guard.hook.registered      (agent/pre-step, llm/stream, agent/request)
external.hook.registered
http.started                      { host, port }
```

## 5. 验证

```bash
curl -s http://127.0.0.1:21099/v1/health
# {"status":"ok"}

curl -s http://127.0.0.1:21099/v1/models
```

> `/v1/health` 只证明插件图完整、HTTP 起来了。要真正聊天，还需要在
> `.env` / 环境变量里配置本地或云端 LLM（默认本地端点是
> `http://192.0.2.102:11017/v1`，本机不一定可达）。

## 6. 已知警告（不影响启动）

`cordis.patch.yml` 里有 8 个 0.2.1 已不存在的上游 row：

```text
web-search / tool-str-replace-editor / tool-subagent-report / tool-ralph /
skill-badge / workflow-worker-thread / tool-call-timeout-policy /
dsh-tui-agent-presets
```

DSH loader 打印 `entry not found` 后继续；这些 disable 变成 no-op。后续应加
`verify:surface`，把上游 row 改名/删除变成可见报告。

## 7. 停止 / 清理

```bash
# 找到本 profile 的进程并停止
pkill -f 'dsh --profile edge' || true
rm -rf /tmp/dsh-edge-probe
```

不要对 `~/.dsh/profiles/desktop` 做任何手改；桌面 App 重启时可能覆盖，
且 CLI 明确拒绝管理该 profile。

## 8. 加载到当前桌面版（Plugins 页）

如果目标就是“像 dsh-cli / web profile 一样，把 bundle 装进当前 Desktop”。
桌面插件管理器支持 **npm / Git / 本地目录 / tarball** 四个通道，本仓现状：

| 通道 | 现状 |
|---|---|
| npm 包名 | **2026-11-11 起可用**：包名 `@dsh-edge/dsh-edge-agent`，**已发布**（首个版本 0.1.1、0.1.2 均于 2026-11-11 上线；`npm view @dsh-edge/dsh-edge-agent version` 查线上版本）。作者侧的 npm 账号（`chschytzmcy`）+ 组织（`dsh-edge`）+ scope 所有权 + 发布凭据**都已就位**。`npm run publish:npm -- --yes` 一条命令走完构建 + 28 道门禁 + 发布（默认 dry-run）。此前（§7.156）发现发布链有个洞：build 步只跑 `compile` ⇒ `verify:build` 必红 ⇒ 从来没走到过 `pnpm publish`，已修。**装完必须点「立即启用」**，且设备上没有 `~/.dsh-edge-agent/edge.json` 的话两个池会退化成 DELEGATE（见 [`deploy-npm.md`](deploy-npm.md) §9.2）。完整指南见 [`deploy-npm.md`](deploy-npm.md) |
| Git 仓库 | **2026-10-30（§7.155）起可用**：见 [`deploy-github.md`](deploy-github.md)。此前不成立的根因是 `prepare` 只跑 `compile`、产不出浏览器半侧 `lib/client.js`（Edge tab 会静默消失），且桌面环境无 npm；现在 `prepare` 走 `run.mjs compile build:client`（不依赖 npm），并有 `verify:git-install` 门禁守着。代价：pnpm ≥10 要求用户点一次「允许这些脚本并重试」 |
| tarball 路径 | **2026-10-30（§7.157）起有门禁守着**：见 [`deploy-tarball.md`](deploy-tarball.md)。此前 `dist/*.tar.gz` **从来没被任何门禁检查过**，且实测发现它是 §7.153 修复**之前**的陈旧产物（`dsh.bundle.patch` 写成字符串 ⇒ preset 层缺席 ⇒ 「边缘模式」工作方式不会注册）⇒ 新增 `verify:tarball` 并接进 `verify:build` |
| **本地目录（推荐）** | 指 `--emit-dir` 产出的可安装目录：预置 `lib/`、已删 `scripts`/`devDependencies`，安装即用。宿主侧的完整契约见 **§8.8**（2026-10-30 读透） |

不要用**源码目录**直接安装：源码 package.json 的 `prepare` 脚本会触发构建，
而桌面 App 环境不一定有 npm（用 `run.mjs` 就没有这个依赖）——要走源码通道请用
上面的 Git 仓库通道，它有专门的准备与门禁。

### 8.1 生成可安装产物

```bash
cd /Users/<user>/cy/code/dsh-edge-agent
bash scripts/build-desktop-bundle.sh --emit-dir   # 需要 lib/ 时自动编译
```

产物（均在 `dist/`，已被 .gitignore 忽略）：

```text
dist/installable/dsh-edge-agent-desktop-safe/   # 桌面「本地目录」通道用（推荐）
dist/installable/dsh-edge-agent-full/
dist/dsh-edge-agent-desktop-safe.tar.gz         # CLI `dsh plugin add` / 分发用
dist/dsh-edge-agent-full.tar.gz
```

### 8.2 在桌面 App 里安装

侧边栏：

```text
Plugins → Add plugin → Install a third-party plugin
```

选「本地目录」，输入绝对路径：

```text
/Users/<user>/cy/code/dsh-edge-agent/dist/installable/dsh-edge-agent-desktop-safe
```

安装后启用该 bundle。若提示需要重启，就重启 DSH Desktop。
（tarball 仍可用于 CLI：`dsh plugin --profile <name> add <tarball>`。）

#### 8.2.1 Windows 实测（2026-10-24，Git Bash + 桌面 App）

流程与上面一致，填入的绝对路径形如：

```text
C:\Users\<你>\GolandProjects\gitlab\dsh-edge-agent\dist\installable\dsh-edge-agent-desktop-safe
```

Windows 专属的三件事：

**① `--emit-dir` 不需要退桌面 App（2026-10-24 修复后）。**
App 一旦以 `link:` 装过这个目录，`rebuild-installable.mjs` 的 retire-rename
就会被活句柄锁死——EPERM 且重试救不了（一天撞了 3 次后修的）。现在脚本
的行为：rename 带 3 次短退避（救 Defender/indexer 瞬时扫描）；仍锁则
**自动降级为就地同步**——staging 逐条覆盖进 target、目录不挪窝，`link:`
目标持续有效（§7.103 的本意），输出带 `in-place` 提示，App 重启即拿新
代码。想要干净的原子换目录（POSIX 语义），退出 App 再跑。

**② 已装过（`link:` 模式）的更新不需要重新安装。**
§7.103 的设计就是让 `link:` 目标持续有效——改文件不需要 rename：

```bash
npm run compile
cp -r lib/. "dist/installable/dsh-edge-agent-desktop-safe/lib/"
# 重启桌面 App 生效；config/ 同理（installable 目录带 config/，直接覆盖）
```

**③ 构建工具链用 Git Bash 即可，但注意缺件。**
Git Bash 自带 GNU tar 1.35（`--no-xattrs` 能跑）+ `shasum` ✓；
但 **make / rsync / setsid / ss 都没有** → `make package`、`install.sh`
不可用。Windows 的实际构建打包对是：

```bash
npm run build:tarball                            # 编译 + 打包 + 门禁（Windows/PowerShell 也能跑）
npm run compile                                  # pnpm 不在 PATH 时用 npm run
bash scripts/build-desktop-bundle.sh --no-build  # 复用现有 lib/，只重打包
bash scripts/build-desktop-bundle.sh --emit-dir  # 出 installable 目录（App 开着也行，锁住自动 in-place）
bash scripts/build-desktop-bundle.sh --install-desktop=link   # 构建 + 把桌面 profile 切 link（开发）模式
bash scripts/build-desktop-bundle.sh --install-desktop=tar    # 构建 + 切 tar（分发）模式
```

> 补充：Windows 上 headless CLI profile 的等价部署（不碰桌面 profile）用
> App 内嵌 CLI：
> `"%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"`
> —— `dsh.cmd plugin --profile dsh-edge-agent add file:<tarball>` 后
> `DSH_EDGE_LOG_FILE=force dsh.cmd --profile dsh-edge-agent` 起服务
> （force 是 CLI 宿主 exporter 冲突下让文本 ops log 落盘的开关，
> 2026-10-24 实测）。`build-desktop-bundle.sh --install-desktop` 会自动探测
> 这个 dsh.cmd（顺序：`DSH_BIN` → PATH → macOS App 内嵌 → 此 Windows 路径
> → `~/.npm-global/bin`）。

### 8.3 两个包的区别

| 变体 | patch | 作用 |
|---|---|---|
| `desktop-safe` | [cordis.desktop-safe.patch.yml](../cordis.desktop-safe.patch.yml) | 插入隐私/Realm/审计插件 + §7.100 LLM 路由：`cloud-llm` 为**委托模式**（云回答转发到桌面 GUI 所选的宿主提供商，脱敏后出网，凭据归宿主）；`local-llm` 只有配了 `DSH_EDGE_LOCAL_LLM_*` 才可用，意图分类/guard 检测没本地端点就走规则档。不改默认模型、persona、approval、sandbox、session root；不启动 http-api |
| `full` | [cordis.patch.yml](../cordis.patch.yml) | 和独立 edge profile 一致；会改写宿主全局配置（persona、工具禁用、session root 等），适合专用 profile，不适合直接放进日常桌面。云池同样可选：不配 CLOUD_LLM_* 即 delegate |

### 8.4 desktop-safe 自带 §7.101 Edge tab（桌面右栏 4 panel）

desktop-safe 产物多挂一个 host 插件 `edge-context-view`（仅 auditLog 硬依赖 + `connection` 软延迟）+ 客户端 `lib/client.js` bundle；启用后桌面右栏出现 **Edge** tab，呈现：

| Panel | 数据源 |
|---|---|
| Intent | 意图分类（`intent.classify.start/.end` 等） |
| Route | 路由决策（`http.chat.route`、`llm.cloud.*`、`llm.local.*`） |
| Interception | 拦截/脱敏（`input-guard.*`、`guard.*`、`sanitizer.*`、`input.*`） |
| Threat | 威胁总线（`td-bus.escalated`、`http.chat.threat-blocked`） |
| Session summary 条 | turn 数 + token 用量（adapter 报账才显示） |

传输是 dsh-context 的 POST route pull：client 轮询 `api/dsh-edge/context`（host `/api/dsh-edge/context`），**不**自建 AsyncIterable seam；payload 字段经 pii-utils 5 类 tokenize + 嵌套对象扁平化，**不**展示原始 PII。

装配后建议开机看一眼：

1. 右栏出现 **Edge** tab（位置与 dsh-context 的 Context tab 同高度）
2. 切到 Edge tab，控制台 0 报错
3. 发一条本地 query → Intent panel 出现一行
4. 切桌面主题深/浅 → 配色跟随（`currentColor` + `color-mix` 实现）
5. 切桌面语言 zh/en → 文案跟随（`locale.register/bind` 实现）

详细规则、配置旋钮、PII 纪律见 [docs/edge-context-tab-plan.md](edge-context-tab-plan.md) 与 [docs/PROGRESS.md §7.101](PROGRESS.md)；客户端数据通路分析见 [docs/notes/dsh-context-walkthrough.md](notes/dsh-context-walkthrough.md)。

建议顺序：先用 `desktop-safe` 验证插件能挂载；确认后再决定是否需要 full 或自定义 patch。

### 8.5 §7.107：输入框收「目录」还是「压缩包」——都行

桌面插件管理器的 spec 解析器在 app.asar 里
（`@deepseek-ai/dsh-plugin-manager/lib/types/install-spec.js`）：

```js
const TARBALL_SPEC = /\.(?:tgz|tar\.gz)(?:#.*)?$/i;
const path = spec.replace(/^(?:file|link):/, '');
if (path !== spec || isAbsolute(path)) {
    if (!isAbsolute(path)) throw invalid(spec, 'a local path must be absolute');
    return TARBALL_SPEC.test(path) ? { kind: 'tarball', spec, path } : { kind: 'path', spec, path };
}
```

| 填入 | 桌面认成 | profile 里记成 | 备注 |
|---|---|---|---|
| 绝对路径 `…/xxx.tar.gz` / `.tgz` | `tarball` | `file:<path>` | 分发模式：解包成冻结副本，更新走 §8.6 坑 1 流程 |
| 绝对路径 `…/dsh-edge-agent-desktop-safe/` | `path` | `link:<绝对路径>` | **开发模式**：符号引用目录，改文件重启即生效（实测形态见 §8.8.2） |
| 相对路径 `./x` | 拒绝 | — | "a local path must be absolute" |
| `link:` + 目录 | `path` | `link:<绝对路径>` | ✅ 与裸路径等价（实测），开发模式 |
| `file:` + **目录** | `path` | `file:<绝对路径>` | ⚠️ **静默陷阱**：见 §8.8.4 —— 冻结 **且丢活配置** |
| `file:` + **tarball** | `tarball` | `file:<绝对路径>` | ✅ 正确用法：tarball 是文件，`file:` 才对 |

### 8.6 §7.107：迭代一次桌面 bundle 的完整步骤（两个坑）

> **两种模式（2026-10-24 起桌面 profile 为 link）**：`link:`（本地目录通道）=
> **开发模式**——node_modules 里是指向 `dist/installable/<variant>/` 的符号链接，
> 改目录里的文件 + 重启 App 即生效，**坑 1 不存在**；`file:`（tarball 通道）=
> 分发模式——安装时解包成冻结副本，更新走下面的坑 1 流程。
> 构建并切换一条命令（脚本每次全量重建两种产物 + verify-installable 门禁）：
>
> ```bash
> bash scripts/build-desktop-bundle.sh --install-desktop=link   # 构建 + 切开发模式
> bash scripts/build-desktop-bundle.sh --install-desktop=tar    # 构建 + 切分发模式
> ```
>
> 切换建议退 App 后跑（脚本检测到 App 运行会提示）。三平台通用
> （macOS / Windows Git Bash / Linux）：脚本自动处理 tar 口味（bsdtar 去掉
> `--no-xattrs`）、sha256（`shasum`/`sha256sum`）与 dsh CLI 探测。

**坑 1 —— pnpm 不会因为 tarball 内容变了就重新解包。**
`file:` tarball 依赖的 integrity 变了，lockfile 会更新，但 `pnpm install`
仍然报 "Already up to date"，`node_modules/` 里躺的还是旧代码。必须先把
已装目录挪走再装：

```bash
export DSH_BIN="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
PKG=~/.dsh/profiles/desktop/node_modules/@dsh-edge/dsh-edge-agent
osascript -e 'tell application "DeepSeek Harness" to quit'      # 先退干净
mv "$PKG" "$PKG.old"
"$DSH_BIN" plugin --profile desktop install                    # 装新的
rm -rf ~/.dsh/profiles/desktop/node_modules/.ignored           # pnpm 会把旧目录挪进 .ignored
```

装完核对哈希，确认装的是新产物：

```bash
shasum -a 256 "$PKG/lib/client.js" dist/installable/dsh-edge-agent-desktop-safe/lib/client.js
```

**坑 2 —— 配置不在 tarball 里，要单独同步。**
tarball 故意不带 `config/edge.json`（明文密钥）。桌面版真正在用的配置按
`edge-config.ts` 的 `edgeConfigCandidates()` 顺序找（§7.182 后**只有两档**）：

1. `<bundle>/config/edge.json` —— **顺位 1** —— 即
   `~/.dsh/profiles/desktop/node_modules/@dsh-edge/dsh-edge-agent/config/edge.json`
   （插件装在哪，配置就在哪；打开插件目录就能找到）
2. `~/.dsh-edge-agent/edge.json` —— **顺位 2** —— 重装 / 删 profile 都活着

放一份进去（顺位 2 推荐 —— 顺位 1 会被「重装 tarball」抹掉）：

```bash
mkdir -p ~/.dsh-edge-agent
cp config/edge.example.json ~/.dsh-edge-agent/edge.json   # 模板 → 顺位 2
# 或者就地写插件目录那份（顺位 1）：
cp ~/.dsh-edge-agent/edge.json "<bundle>/config/edge.json"
```

> §7.182：**仓库的 `config/` 目录不再放活配置**（明文 key 不该待在 git checkout
> 里），模板 `config/edge.example.json` 只是给你抄的那份 —— 运行时不再读它
> （模板里的部署值已并入代码默认值）。
>
> §7.182 补：模板里原先的 `jev.apiKeyRef: "bailianApiKey"` 也一并摘掉了
> —— `danglingSecretRefs()` 把「槽位为空」也算悬空引用 ⇒ 照模板抄的人
> 每次启动都会看到一条「密钥引用指向不存在的槽位」ERROR。要用百炼决策模型
> 才把这一行加回来（并在 `secrets` 里填上那个槽位的真实 key）。

**验证哪一份生效**（§7.107 新增的启动审计行）：

```bash
grep -o '"kind":"config.loaded".\{0,240\}' ~/.dsh-edge-agent/audit/audit.plain.jsonl | tail -1
```

### 8.7 §7.107：桌面版真正在用的目录一览

```
~/.dsh/profiles/desktop/                                  ← 桌面 profile 根
├── package.json                    依赖 + dsh.profile.bundles
├── cordis.yml / cordis.patch.yml   profile 自己的 patch 层（桌面侧手改的 model/persona/providers）
└── node_modules/
    ├── @dsh-edge/dsh-edge-agent/     ← 【插件代码真正所在】
    │   ├── lib/                    编译产物（host 半 + client.js）
    │   ├── cordis.desktop-safe.patch.yml
    │   └── config/                 edge.json / edge.example.json / privacy-policy.json
    └── dsh-context/
```

数据根：`~/.dsh-edge-agent/{audit,log,storage}`；隐私策略：
`~/.dsh-edge-agent/privacy-policy.json`（缺省回落到 bundle 自带的
`config/privacy-policy.json`，§7.107 修的）。

**发布时用哪个目录**：三份产物，各有各的落点 ——

| 产物 | 由谁产出 | 内容 | 落到哪 |
|---|---|---|---|
| npm 包 | `publish.yml`（推 `v*` tag）→ `pnpm publish` | `package.json#files` = `lib/` + `config/`（去 edge.json）+ 3 个 yml + `presets/` | 用户 profile 的 `node_modules/` |
| release tarball | `make package` → `dist/dsh-edge-agent-v<ver>.tar.gz` | 上面这些 + `scripts/` + `profiles/dsh-edge/` + `install.sh`/`uninstall.sh`/`README`/`LICENSE` | 外部用户解压后跑 `install.sh` |
| 桌面 bundle | `scripts/build-desktop-bundle.sh --emit-dir` | `dist/dsh-edge-agent-{desktop-safe,full}.tar.gz` + `dist/installable/<variant>/` | `~/.dsh/profiles/desktop/node_modules/@dsh-edge/dsh-edge-agent/` |

npm 包与桌面 bundle 都带 `config/`（去掉 `config/edge.json`），所以装完
就能找到 shipped 模板；`config/edge.json` 只留在 operator 自己的机器上。

### 8.8 §7.156：本地目录通道的宿主契约（2026-10-30 读透 + 实测）

> 前面 §8.5–§8.7 记的是**怎么用**。这一节记的是**宿主到底怎么对待这个目录**
> —— 几条结论会直接影响「这个目录该放什么」和「出问题该查哪」。

宿主侧出处：`deepseek-harness`（只读参考仓）
`packages/boot/plugin-manager/src/install-spec.ts`、`operations.ts`、
`index.ts`、`packages/boot/app-boot/src/{profile,index,plugin-compatibility}.ts`。

#### 8.8.1 输入怎么被分类

```
spec.replace(/^(?:file:|link:)/, '')   ← 只剥一个前缀
若剥掉了前缀 或 isAbsolute(path)  ⇒ 进 path/tarball 分支
  · 不是绝对路径 ⇒ 拒绝「a local path must be absolute」
  · 以 .tgz / .tar.gz 结尾 ⇒ kind = tarball
  · 其余 ⇒ kind = path
```

- **必须是绝对路径**。Windows 上 `C:\x`、`C:/x`、`\x`、`/x` 都算；
  `C:x`（驱动器相对）**不算** ⇒ 落到 registry 分支 ⇒ 被拒成「不是合法包名」。
- `file:` / `link:` 前缀可选，**剥掉后分类，原样带前缀交给 pnpm**。
- 客户端**几乎不做校验**（只 `trim()`），所有判定都在宿主侧。

#### 8.8.2 pnpm 实际记录成什么样（2026-10-30 实测）

在隔离临时 profile 里真装一次 `dist/installable/dsh-edge-agent-desktop-safe`：

```json
"dependencies": {
  "@dsh-edge/dsh-edge-agent":
    "link:C:/Users/<user>/GolandProjects/gitlab/dsh-edge-agent/dist/installable/dsh-edge-agent-desktop-safe"
}
```

`node_modules/@dsh-edge/dsh-edge-agent` 是个**符号链接**
（`lstat` → `isSymbolicLink() === true`），指向那个目录。

⇒ **裸绝对路径 ⇒ 记成 `link:<绝对路径>`、装出来是符号链接**（不是 `file:`）。
源码推演说「记成 `file:`」——**以实测为准**。

⇒ 好处：改目录里的文件 + 重启桌面 App 即生效，不用重装（这正是 §8.6
`link:` 模式「坑 1 不存在」的原因）。

#### 8.8.2.1 ⚠️ 前缀决定一切：`file:` + **目录**是静默陷阱（2026-10-30 实测）

§8.8.2 测的是**裸路径**。同一目录换三种写法真装三次（隔离临时 profile）：

| 写法 | profile 里记成 | `node_modules` 里是 | 实时？ | 带活配置？ |
|---|---|---|---|---|
| 裸绝对路径 | `link:<绝对路径>` | 符号链接 | ✅ | ✅ |
| `link:` + 绝对路径 | `link:<绝对路径>` | 符号链接 | ✅ | ✅ |
| **`file:` + 绝对路径** | `file:<绝对路径>` | **真实副本（冻结）** | ❌ | ❌ **丢** |

⇒ **`file:` 指向目录，同时坏掉两件事**：

1. **不实时** —— pnpm 把目录 **pack** 进 store（不是链接）⇒ 改文件不再生效；
2. **丢活配置** —— pack 尊重 manifest 的 `files` 白名单，而白名单写着
   `"!config/edge.json"` ⇒ 装出来那份**没有** `config/edge.json`
   ⇒ 宿主的配置**顺位 1**（`<bundle>/config/edge.json`）落空
   ⇒ 悄悄退到 `~/.dsh-edge-agent/edge.json`（顺位 2）或内置默认值
   ⇒ 本地路由可能不注册 ⇒ 每轮 LOCAL 被隐私裁决拦下。
   （§7.182：顺位 2 的 home 那份不受 pack 影响 ⇒ 写在 home 就不受这条影响。）

**宿主不会提醒你**：`install-spec.ts:69-92` 只剥**一个** `file:`/`link:` 前缀，
**按扩展名**分类（目录一律 `kind: 'path'`，与前缀无关），然后把 spec **原样**交给
pnpm（`index.ts:930` `pnpm add <spec>`）。⇒ `file:<目录>` 被无声接受。

⇒ **目录就填裸路径**（或 `link:`），**`file:` 只留给 tarball**。
门禁：`scripts/verify-local-channel.mjs`（已接进 `verify:build`）。

#### 8.8.3 宿主**不会**构建这个目录

- 宿主的「有没有构建过」检查**只对官方目录（Official）生效**
  （`official-install-target.ts:48-51`）；用户手输的路径**没有这一步**；
- 入口（`exports` / `main`）**只在加载时**由 Node 解析器解析
  （`app-boot/src/package-meta.ts:73-80`）；
- ⇒ **目录里必须已经带着可用的 `lib/`**。`--emit-dir` 产物满足这一点；
  **源码目录不满足** ⇒ 所以 §8 开头才说「不要用源码目录直接安装」。

#### 8.8.4 但目录里的构建脚本仍会被 pnpm 拦

pnpm 11 对**任何**来源的依赖脚本都要求放行（`allowBuilds`）。`--emit-dir`
产物里没有构建脚本 ⇒ 不会触发；但**源码目录**有 `prepare` ⇒ 会撞上
`build-blocked`（宿主给「允许这些脚本并重试」，`manager.spec.ts:786-808`）。

放行键里嵌的是 `file:` spec 原文（路径带空格也照抄）。

#### 8.8.5 兼容性在装**之前**就查了

path spec 的 manifest **直接从目录里的 `package.json` 读**
（`operations.ts:180-184`），不查 registry。`engines.dsh` 不满足 ⇒
**在 pnpm 跑之前就拒绝**，一个字节都不下载。

#### 8.8.6 没有 in-place 升级

`updateRefusal` 只认 registry spec ⇒ 本地目录装的包**永远不会被标成可更新**
⇒ 升级的唯一途径是**卸载 + 重装**。客户端会明说
（`installProblemInstalled`：「要升级请卸载后重装」）。

而且**重装到同一个目录也会被拒**（`already-installed`，按包名判定）。

#### 8.8.7 装完仍要点「立即启用」

与 git / npm 通道一样：客户端对用户手输的 spec 传 `enabled: false`
⇒ 宿主不自动 `selectBundle` ⇒ 必须点「立即启用」。

#### 8.8.8 卸载不会删你的源目录

宿主只把**包名**交给 `pnpm remove`（`index.ts:1060`）⇒ 只动 profile 里的
`package.json` 与 `node_modules`。**你填的那个目录宿主一行代码都不会删**
（宿主唯一会删的是 profile 内的文件：`restoreFiles` / 运行记录）。

#### 8.8.9 ⚠️ 目录里的一切都会进包（含真密钥）

本地目录是**符号链接** ⇒ `node_modules` 里那个包**就是那个目录本身**
⇒ 目录里有什么就有什么。本仓 `dist/installable/dsh-edge-agent-desktop-safe/`
里**含 `config/edge.json`（明文 API key）**。

⇒ **这个目录不能外发、不能打包分享**。要分发请走 npm 通道（`files` 白名单
排除了 `config/edge.json`）或 git 通道（`config/edge.json` 不入库）。

#### 8.8.10 一句话对照表

| 问题 | 本地目录 | GitHub 地址 | npm 包名 |
|---|---|---|---|
| 要构建授权 | 否（产物无脚本）/ 是（源码目录有 `prepare`） | **是** | 否 |
| PATH 要有 pnpm | 否 | **是** | 否 |
| 装出来是 | 符号链接 | clone 后现场编译 | 冻结的 tarball |
| 能钉版本吗 | 不能（跟着目录变） | `#<sha>` | `pkg@0.1.1` |
| 能原地升级吗 | 不能（卸了重装） | 不能（卸了重装） | 能（`updateBundle`） |
| 目录/包里有真密钥吗 | **有**（符号链接） | 无（不入库） | 无（`files` 排除） |
| 安装耗时（实测） | **447 ms** | ~41 s | 取决于 registry |

### 8.9 §7.157：tarball 通道（离线分发给别人）

宿主把**绝对路径**且以 `.tgz` / `.tar.gz` 结尾的输入认成 `kind: 'tarball'`
（`install-spec.ts:30` 的 `TARBALL_SPEC`），随后原样交给 `pnpm add`。
**`.zip` 不支持。**

```bash
npm run build:tarball                   # 编译 + 打包 + 门禁 → dist/dsh-edge-agent-desktop-safe.tar.gz
```

在桌面 App 里填 tarball 的绝对路径（客户端是**纯文本框**，没有目录选择器，
所以 `.tar.gz` 路径可以手打）。

**与「本地目录」通道的本质差别**：

| | 本地目录 | tarball |
|---|---|---|
| node_modules 里 | 符号链接 → **源目录** | 符号链接 → **pnpm store 的解包副本** |
| 改了会生效吗 | **会**（同步文件 + 重启） | **不会** ⇒ 卸载重装（§8.6 坑 1） |
| 含真密钥吗 | **有**（`config/edge.json`） | **没有** ⇒ 目标机器自己写 `~/.dsh-edge-agent/edge.json` |
| 要构建授权吗 | 否 | 否（包里没有 `scripts`） |

**装完仍要点「立即启用」**；tarball 装的包**永远不会被标成可更新**
（`updateRefusal` 只认 registry spec）⇒ 升级只能卸载重装。

完整指南（含宿主链路、产物字段、门禁与排障）见
[`deploy-tarball.md`](deploy-tarball.md)。

### 8.10 §7.175：包名（scope）改名后，已部署 profile 必须同步的 4 处

> 2026-11-11 实测：本仓的包名从 `@deepseek-harness-edge-agent/dsh-edge-agent`
> 改成 **`@dsh-edge/dsh-edge-agent`**（scope 迁到 npm 组织 `@dsh-edge`）。
>
> **代码改完 ≠ 装好了。** 已部署的 profile 里有 **4 处**写着包名，
> 漏改任何一处，宿主都不会挂载这个 bundle —— 而且四种症状各不相同，
> 没有一种会直说「包名变了」。

| # | 文件 | 字段 | 漏改的症状 |
|---|---|---|---|
| 1 | `<profile>/package.json` | `dependencies["@dsh-edge/dsh-edge-agent"]` | 宿主解析不到这个依赖 → 插件整体不加载，profile 起来了但没这个插件 |
| 2 | `<profile>/package.json` | `dsh.profile.bundles[]` | 依赖在、bundle 不在 bundles 列表 → 隐私栈**一行都不挂**（最容易误判成「插件装了但没生效」） |
| 3 | `<profile>/pnpm-lock.yaml` | `importers['.'].dependencies['@dsh-edge/dsh-edge-agent']` | lockfile 与 package.json 打架 → `pnpm install` 报 "Already up to date"，但装的是旧代码 |
| 4 | `<profile>/pnpm-workspace.yaml` | `allowBuilds` 白名单 | 将来走 git 源安装时 pnpm 拒跑构建脚本 → 装上了但半残 |

**第 4 处的键不是单纯包名** —— 是 `<包名>@<source>` 的全量形式，git 源要写两条（http + ssh）：

```yaml
nodeLinker: hoisted
autoInstallPeers: false
allowBuilds:
  "@dsh-edge/dsh-edge-agent@git+https://github.com/chschytzmcy/dsh-edge-agent.git": true
  "@dsh-edge/dsh-edge-agent@git+ssh://git@github.com/chschytzmcy/dsh-edge-agent.git": true
```

#### 改名时的完整动作（按这个顺序）

1. **先把旧 scope 的目录挪走** —— pnpm 不会自己清理同位置的旧包，
   留着会和新包同时出现在 `node_modules/` 里：

   ```bash
   mv ~/.dsh/profiles/<profile>/node_modules/@deepseek-harness-edge-agent \
      ~/.dsh/profiles/<profile>/node_modules/@deepseek-harness-edge-agent.old-<ts>
   ```

2. 改第 1、2 处（同一个 `package.json` 里的两个字段）。
3. **重建 lockfile** —— pnpm 会自己改写第 3 处，离线即可，不需要联网：

   ```bash
   cd ~/.dsh/profiles/<profile> && pnpm install --offline
   ```

4. 改第 4 处（`pnpm-workspace.yaml`）。
5. **核对装的是新产物**（sha256 与仓库产物逐字一致）：

   ```bash
   shasum -a 256 ~/.dsh/profiles/<profile>/node_modules/@dsh-edge/dsh-edge-agent/lib/client.js \
     <repo>/dist/installable/dsh-edge-agent-desktop-safe/lib/client.js
   ```

6. **扫旧 scope 残留**（期望 0 命中）：

   ```bash
   grep -rn "deepseek-harness-edge-agent" ~/.dsh/profiles \
     --include=*.json --include=*.yaml --include=*.yml
   ```

#### 两个 profile 的差异

| | 桌面 profile | headless profile |
|---|---|---|
| 路径 | `~/.dsh/profiles/desktop` | `~/.dsh/profiles/dsh-edge-agent` |
| node_modules 布局 | `nodeLinker: hoisted` | pnpm isolated（`node_modules/.pnpm/`） |
| bundles 列表 | base / web-app / dsh-context / 本包 | base / 本包 |
| 额外要同步 | —— | profile 自己的 `cordis.patch.yml` overlay 也要同步包名 |

> **回滚点**：改名动过的每个 profile 都留一份
> `package.json.bak-<ts>` / `pnpm-lock.yaml.bak-<ts>`，
> 以及第 1 步移开的旧目录本身 —— 它就是旧版的完整副本。

## 9. 验证安装

```bash
# 1. bundle 已注册到 target profile？
grep '@dsh-edge/dsh-edge-agent' ~/.dsh/profiles/<profile>/package.json

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

> **判一个会话有没有真的走本项目链路，唯一判据是审计链**（§7.140）：
> ```bash
> node scripts/probe-session-audit.mjs --session <id>
> ```
> 会话头 / projcache 里的 preset 标签都不可作判据。详见
> [`desktop-troubleshooting.md` §5](desktop-troubleshooting.md)。

## 10. 卸载

```bash
# 1. 停所有 dsh profile
pkill -f 'node.*dsh --profile dsh-tui' || true
pkill -f 'node.*dsh --profile web' || true

# 2. 从 profile bundles 列表移除 bundle
# （CLI：dsh plugin --profile dsh-tui remove <bundle> — 如 dsh CLI 提供）
# 或手动编辑 ~/.dsh/profiles/dsh-tui/package.json 删除 bundles + dependencies 中的 dsh-edge-agent
# §7.43: dsh-tui + web 都要处理（如果都装过）

# 3. 移除嵌套包
rm -rf ~/.dsh/profiles/dsh-tui/node_modules/@dsh-edge/
rm -rf ~/.dsh/profiles/web/node_modules/@dsh-edge/   # 若 web 装过

# 4. 移除 bundle 数据（注意：会删除所有会话和加密数据！）
rm -rf ~/.dsh-edge-agent-web/

# 5. 移除全局包（如适用）
npm uninstall -g @dsh-edge/dsh-edge-agent
```

> **桌面版走宿主 GUI 的卸载**（Plugins → 已安装 → 移除）：宿主会做
> `pnpm remove` + 撤掉 `dsh.profile.bundles` 里的条目。**你填的那个源目录
> 宿主一行代码都不会删**（§8.8.8）。

