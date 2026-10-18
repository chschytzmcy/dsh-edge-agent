# 加载到本地 DSH（macOS / 当前桌面版 runtime）

> 2026-10-18 实测通过：DSH `0.2.1-rc.2` + 本仓 `lib/` + 隔离 profile `edge`，
> `GET /v1/health` → `{"status":"ok"}`。

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
| Git 仓库 | 从 git 安装会触发源码 `prepare: npm run compile`（`lib/` 不入库），桌面环境不一定有构建链，不建议 |
| **本地目录（推荐）** | 指 `--emit-dir` 产出的可安装目录：预置 `lib/`、已删 `scripts`/`devDependencies`，安装即用 |

不要用源码目录直接安装：源码 package.json 的 `prepare` 脚本会触发
`npm run compile`，而桌面 App 环境不一定有 npm。

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

### 8.3 两个包的区别

| 变体 | patch | 作用 |
|---|---|---|
| `desktop-safe` | [cordis.desktop-safe.patch.yml](../cordis.desktop-safe.patch.yml) | 插入隐私/Realm/审计插件 + §7.100 LLM 路由：`cloud-llm` 为**委托模式**（云回答转发到桌面 GUI 所选的宿主提供商，脱敏后出网，凭据归宿主）；`local-llm` 只有配了 `DSH_EDGE_LOCAL_LLM_*` 才可用，意图分类/guard 检测没本地端点就走规则档。不改默认模型、persona、approval、sandbox、session root；不启动 http-api |
| `full` | [cordis.patch.yml](../cordis.patch.yml) | 和独立 edge profile 一致；会改写宿主全局配置（persona、工具禁用、session root 等），适合专用 profile，不适合直接放进日常桌面。云池同样可选：不配 CLOUD_LLM_* 即 delegate |

建议顺序：先用 `desktop-safe` 验证插件能挂载；确认后再决定是否需要 full 或自定义 patch。
