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
cd /Users/a18104385217/cy/code/dsh-edge-agent
pnpm install
pnpm run compile
```

> 本机若 `pnpm` 不在 PATH，可用 DSH 自带 pnpm：
> `/Users/a18104385217/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs`

## 3. 建一个隔离 profile（不碰 ~/.dsh/profiles/desktop）

下面用 `/tmp/dsh-edge-probe` 做演示；想持久化可换成
`$HOME/.dsh-edge-profile`。

```bash
export DSH_HOME=/tmp/dsh-edge-probe
PROFILE=edge
REPO=/Users/a18104385217/cy/code/dsh-edge-agent
PKG="$DSH_HOME/profiles/$PROFILE/node_modules/@deepseek-harness-edge-agent/dsh-edge-agent"

rm -rf "$DSH_HOME/profiles/$PROFILE"
mkdir -p "$PKG"

# 3.1 profile 骨架：dsh-base + 本 bundle
cat > "$DSH_HOME/profiles/$PROFILE/package.json" <<'EOF'
{
  "name": "dsh-profile-edge",
  "private": true,
  "dependencies": {
    "@deepseek-harness-edge-agent/dsh-edge-agent": "file:./node_modules/@deepseek-harness-edge-agent/dsh-edge-agent"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-harness-edge-agent/dsh-edge-agent"
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
> `http://192.168.1.121:11017/v1`，本机不一定可达）。

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
桌面插件管理器支持 **npm / Git / 本地目录** 三个通道，本仓现状：

| 通道 | 现状 |
|---|---|
| npm 包名 | 发布流水线就绪（`publish.yml`），但包尚未发布（registry 404）；推 `v*` tag 后可用 |
| Git 仓库 | **2026-10-30（§7.155）起可用**：见 [`deploy-github.md`](deploy-github.md)。此前不成立的根因是 `prepare` 只跑 `compile`、产不出浏览器半侧 `lib/client.js`（Edge tab 会静默消失），且桌面环境无 npm；现在 `prepare` 走 `run.mjs compile build:client`（不依赖 npm），并有 `verify:git-install` 门禁守着。代价：pnpm ≥10 要求用户点一次「允许这些脚本并重试」 |
| **本地目录（推荐）** | 指 `--emit-dir` 产出的可安装目录：预置 `lib/`、已删 `scripts`/`devDependencies`，安装即用 |

不要用**源码目录**直接安装：源码 package.json 的 `prepare` 脚本会触发构建，
而桌面 App 环境不一定有 npm（用 `run.mjs` 就没有这个依赖）——要走源码通道请用
上面的 Git 仓库通道，它有专门的准备与门禁。

### 8.1 生成可安装产物

```bash
cd /Users/a18104385217/cy/code/dsh-edge-agent
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
/Users/a18104385217/cy/code/dsh-edge-agent/dist/installable/dsh-edge-agent-desktop-safe
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
npm run compile                                  # pnpm 不在 PATH 时用 npm run
bash scripts/build-desktop-bundle.sh --no-build  # 只出 tarball
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
| 绝对路径 `…/dsh-edge-agent-desktop-safe/` | `path` | `link:<path>` | **开发模式**（桌面 profile 当前用的就是这条）：符号引用目录，改文件重启即生效 |
| 相对路径 `./x` | 拒绝 | — | "a local path must be absolute" |
| `file:` / `link:` 前缀 | 剥掉前缀再判 | — | |

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
PKG=~/.dsh/profiles/desktop/node_modules/@deepseek-harness-edge-agent/dsh-edge-agent
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
`edge-config.ts` 的 `edgeConfigCandidates()` 顺序找：

1. `<bundle>/config/edge.json` —— 即
   `~/.dsh/profiles/desktop/node_modules/@deepseek-harness-edge-agent/dsh-edge-agent/config/edge.json`
2. `~/.dsh-edge-agent/edge.json`
3. `<bundle>/config/edge.example.json`（模板兜底）

所以放一份进去：

```bash
cp config/edge.json ~/.dsh-edge-agent/edge.json
cp config/edge.json "<bundle>/config/edge.json"
```

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
    ├── @deepseek-harness-edge-agent/dsh-edge-agent/     ← 【插件代码真正所在】
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
| 桌面 bundle | `scripts/build-desktop-bundle.sh --emit-dir` | `dist/dsh-edge-agent-{desktop-safe,full}.tar.gz` + `dist/installable/<variant>/` | `~/.dsh/profiles/desktop/node_modules/@deepseek-harness-edge-agent/dsh-edge-agent/` |

npm 包与桌面 bundle 都带 `config/`（去掉 `config/edge.json`），所以装完
就能找到 shipped 模板；`config/edge.json` 只留在 operator 自己的机器上。

