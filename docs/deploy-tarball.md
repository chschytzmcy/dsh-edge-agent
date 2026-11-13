# 从 tarball 安装（桌面版 Plugins → Add plugin）

> 状态：**2026-10-30 打通 + 实测**（§7.157）。宿主侧的 tarball 通道早就做完了；
> 这一轮补的是**作者侧的门禁** —— 并且在补门禁的过程中发现：
> **`dist/*.tar.gz` 是 §7.153 修复之前的陈旧产物，从来没重打过**。
>
> 宿主契约出处：`deepseek-harness`（只读参考仓）
> `packages/boot/plugin-manager/src/install-spec.ts`、`index.ts`、`operations.ts`。

## 0. 一句话

在桌面 App 的 **Plugins → Add plugin** 里填 tarball 的**绝对路径**：

```
C:\Users\<你>\GolandProjects\gitlab\dsh-edge-agent\dist\dsh-edge-agent-desktop-safe.tar.gz
```

宿主把它当 npm 包 tarball 装进 profile ⇒ **不需要构建授权、不需要 PATH 上有
pnpm、不含任何密钥**（tarball 里没有 `config/edge.json`）。

> 与「本地目录」通道的关键差别：本地目录装出来是**指向源目录的符号链接**
> （改文件即生效，但**含真密钥**）；tarball 装出来是 **pnpm store 里的冻结副本**
> （不含密钥，但**改了 tarball 不会自动生效**，必须重装）。

## 1. 四条通道怎么选

| 通道 | 输入 | 要构建授权吗 | PATH 要有 pnpm 吗 | 产物形态 | 含真密钥 | 改了会生效吗 |
|---|---|---|---|---|---|---|
| **npm 包名** | `@作者/插件名` | 否 | 否 | 冻结的 tarball | 否 | 升级走 `updateBundle` |
| **tarball 路径** | `…/x.tar.gz` | 否 | 否 | **冻结副本** | **否** | **否**（要重装） |
| **tarball URL** | `https://…/x.tar.gz` | 否 | 否 | **冻结副本** | **否** | **否**（要重装） |
| GitHub 地址 | `https://github.com/o/r` | **是** | **是** | 现场编译 | 否 | 重装 |
| 本地目录 | `C:\path\to\dir` | 否 | 否 | **符号链接** | **有** ⚠️ | **会** |

> **tarball URL** 那一行是 §7.201 新增的发布面：`v*` tag 的 GitHub Release 上挂着
> **safe 与 full 两个预构建 tar 包** ⇒ 粘 URL 就能装（免构建授权、免 registry）。
> 详见 **§8**。

四条通道在宿主里是**同一段代码**（`install-spec.ts:69-92` 解析出四种形态，
`index.ts:930` 一律 `pnpm add <spec>`，cwd = profile 目录）。

各自的完整指南：[`deploy-github.md`](deploy-github.md)、
[`deploy-npm.md`](deploy-npm.md)、[`load-into-local-dsh.md` §8](load-into-local-dsh.md)。

## 2. 宿主怎么对待一个 tarball

### 2.1 输入怎么被认成 tarball

`parseInstallSpec`（`install-spec.ts:69-92`）：

```
TARBALL_SPEC = /\.(?:tgz|tar\.gz)(?:#.*)?$/i
```

- 剥掉**一个** `file:` / `link:` 前缀，或路径本身是绝对路径 ⇒ 进 path 分支；
- 剥完 / 判完是绝对路径后，**以 `.tgz` / `.tar.gz` 结尾 ⇒ `kind: 'tarball'`**；
- **相对路径一律被拒**：`a local path must be absolute`；
- ⚠️ **`.zip` 不支持** —— 整个 plugin-manager 里没有任何 zip 处理（只有
  `TARBALL_SPEC` 与 tarball 完整性分类）。

**两种写法等价**（实测）：

```
C:\path\to\x.tar.gz          ← 裸绝对路径
file:C:\path\to\x.tar.gz     ← 带 file: 前缀
```

两者装出来、profile 里记的 spec **完全一样**。

### 2.2 预检只查文件存在

`inspect()` 对 tarball spec **只做一件事**：文件在不在（`index.ts:620-622`），
不做 registry 查询、不做兼容性预检（那两步只对 registry spec 生效）。

⇒ tarball 通道的失败点全在**装完之后**：宿主会校验 `dsh.bundle` 声明、
patch 文件是否存在、`engines.dsh` 是否被当前 DSH 满足。

### 2.3 装出来是什么形态

pnpm 把 tarball 解包进 store，`node_modules/<包名>` 是 isolated 布局下的
符号链接，指向：

```
node_modules/.pnpm/@deepseek-harness-edge-agen_<hash>/node_modules/@dsh-edge/dsh-edge-agent
```

⇒ **冻结副本**。改了 tarball 内容再 `pnpm install`，pnpm **不会重新解包**
（报 "Already up to date"，`node_modules/` 里还是旧代码）—— 这与
[`load-into-local-dsh.md` §8.6 坑 1](load-into-local-dsh.md) 是同一件事。

### 2.4 profile 里记成什么

```
"dependencies": {
  "@dsh-edge/dsh-edge-agent":
    "file:C:/Users/…/dist/dsh-edge-agent-desktop-safe.tar.gz"
}
```

宿主显示这个依赖时用 `dependencySpec()`（`install-spec.ts:111-123`）把它还原成
可再次 `pnpm add` 的 spec。

### 2.5 更新只能卸载重装

`updateRefusal`（`index.ts:187-192`）只认 **registry** spec ⇒ tarball 装的包
**永远不会被标成可更新**。客户端会明说「要升级请卸载后重装」。

而且**重装到同一个 tarball 路径也会被拒**（按包名判 `already-installed`）
⇒ 得先卸载。

### 2.6 不需要构建授权

tarball 里没有 `install` / `postinstall` / `prepare` 脚本（`stageVariant()`
把 `scripts` 和 `devDependencies` 整个删掉）⇒ pnpm 没有任何东西要拦
⇒ **不用点「允许这些脚本并重试」**。

### 2.7 装完仍要点「立即启用」

客户端对**用户手输的 spec** 传 `enabled: false`（`manager-store.ts:1250`）
⇒ 宿主不自动 `selectBundle` ⇒ **必须点「立即启用」**，否则包在
`dependencies` 里却不在 `dsh.profile.bundles` 里 ⇒ 启动不加载 ⇒ Edge tab 不出现。

## 3. 作者侧义务：产出这个 tarball

### 3.1 本仓怎么产出

**一条命令（推荐）**：

```bash
npm run build:tarball
```

> 演示用、要「装到没配置过的机器上直接能跑」的包 ⇒ `npm run build:tarball:demo`
> （多打一个 `config/edge.json` 进去，**内含明文凭据，勿分发** —— 见 §3.5）。

它串三步，**一步都不能少**：

| 步 | 做什么 | 少了会怎样 |
|---|---|---|
| `compile:pack` | tsc → `lib/`（宿主半侧）+ esbuild → `lib/client.js`（浏览器半侧） | `lib/client.js` 缺失 ⇒ 装完 **Edge tab 静默不出现**（§7.145） |
| `pack:all` | `dist/installable/<变体>/` + `dist/*.tar.gz` + `.sha256` | 没有产物可装 |
| `verify:tarball` | 7 组门禁（见 §5） | 陈旧/漏文件/混密钥的包照发不误 |

产物：

```
dist/dsh-edge-agent-desktop-safe.tar.gz   ← 本通道的标的
dist/dsh-edge-agent-full.tar.gz
dist/<name>.tar.gz.sha256                  ← 校验和
```

tarball 的**顶层目录必须叫 `package`**（npm/pnpm 的期望，`_pack-core.mjs` §B）。

#### ⚠️ 底层命令**都不编译**

这是本节最容易踩的坑 —— 打包命令**只打包，不编译**：

| 命令 | 编译？ | 产物 |
|---|---|---|
| `node scripts/_pack-core.mjs compile` | ✅ 两半都编 | `lib/` |
| `node scripts/_pack-core.mjs tarball` | ❌ | 只出 tarball |
| `node scripts/_pack-core.mjs all` | ❌ | installable 目录 + tarball |

⇒ **「不编译就打包」= 打出陈旧产物**。§7.157 抓到的那对陈旧 tarball 就是这么
来的（`dsh.bundle.patch` 写成字符串、`engines` 里没有 `dsh` ⇒ 装出来**不注册
「边缘模式」**）。所以：**要么用 `npm run build:tarball`，要么自己按
`compile` → `all` 的顺序来**。

跨平台脚本（`build-windows.sh` / `build-macos.sh` / `build-linux.sh` /
`build-desktop-bundle.sh`）走的是 `compile` → 打包 → **两个门禁**
（`verify-installable` + `verify-tarball`），结果与上面一致。

#### 装进桌面版

1. 桌面 App → 侧边栏 **Plugins → Add plugin → Install a third-party plugin**
2. 填 tarball 的**绝对路径**（Windows 形式 `C:\…`，不是 MSYS2 的 `/c/…`）
3. 安装 → **点「立即启用」**（§2.7）→ 重启 App
4. 配置写**两个落点之一**（§7.182）：`~/.dsh-edge-agent/edge.json`（顺位 2，推荐）
   或装好后的插件目录里那份 `config/edge.json`（顺位 1）—— tarball 里两者都没有

CLI 装法（另建 profile，不碰 desktop）：

```bash
export DSH_BIN="$LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
export DSH_HOME=/tmp/dsh-edge-load
"$DSH_BIN" plugin --profile edge add "file:C:/…/dist/dsh-edge-agent-desktop-safe.tar.gz"
```

### 3.2 关键 manifest 字段

| 字段 | 值 | 为什么 |
|---|---|---|
| `dsh.bundle.patch` | **列表**：`["./cordis.desktop-safe.patch.yml", "./presets/edge.desktop-safe.patch.yml"]` | **字符串形式会静默丢掉 Agent Preset 层** ⇒「边缘模式」工作方式永远不注册（§7.153） |
| `engines.dsh` | `>=0.2.1-rc.2` | 宿主的兼容性闸门 |
| `main` | `lib/index.js` | 宿主入口 |
| `scripts` / `devDependencies` | **已删** | 目录/tarball 依赖的 `prepare` 会在安装时触发并要求构建授权 |

### 3.3 ⚠️ `config/edge.json` 被排除

`_pack-core.mjs` 的 `stageVariant()` **一律排除**活配置（§7.182）：

| 产物 | `config/edge.json` |
|---|---|
| **tarball / npm pack**（可分发） | **排除** —— 那是运维的明文端点与 API key |
| **installable 目录**（link 模式，本机用） | **也排除** —— 构建输出不该有第三份明文副本 |
| **DEMO tarball**（演示用，§3.5） | **例外** —— 唯一会带活配置的产物 |

⇒ **tarball 里没有 `config/edge.json`**（实测确认）⇒ 装完配置写两个落点之一：

1. **顺位 1** —— 装好后的插件目录里那份：
   `~/.dsh/profiles/desktop/node_modules/@dsh-edge/dsh-edge-agent/config/edge.json`
   （插件装在哪，配置就在哪，打开目录就能找到）；
2. **顺位 2** —— `~/.dsh-edge-agent/edge.json`（重装 / 删 profile 都活着，推荐）。

⇒ **没有第三顺位**：shipped 模板 `config/edge.example.json` **不再是运行时候选**，
它的部署值已折进代码默认值（`DEFAULT_EDGE_CONFIG`）⇒「没配置文件」≡「以前的模板」。

### 3.4 ⚠️ 拿到 tarball 的机器：没配过本地 LLM，边缘模式跑不起来

**这是 §7.159 在一台干净 Windows 设备上实测出来的硬门槛。**

tarball 不含 `config/edge.json`（§3.3）⇒ 一台**全新的机器**上没有配置文件，
生效的是**代码内置默认值**（§7.182 起 = 旧模板的部署值），而它的 `llm.local.baseUrl`
是**空**。

而 `local-llm` 路由**只有端点配了才注册**（`local-llm-adapter.ts:796-802`）：
baseUrl 为空 ⇒ adapter 不注册任何 provider ⇒ 模型注册表里**根本没有
`local-llm` 这条路** ⇒ 意图分类器（按 §7.100 裁决只准打 local-llm）报
`NO_ADAPTER` ⇒ 退化到正则档 ⇒ 判定 LOCAL ⇒ 隐私裁决要求必须走本地 ⇒
本地没有 ⇒ **fail-closed 拦下本轮**：

```
input-guard: 本轮 intent 判定为 LOCAL，按隐私裁决必须使用本地模型，
但本地路由 "local-llm" 不可用（local-route-missing:local-llm）。
为避免本地数据/PII 出境，已阻止本轮上云。
```

⇒ 这是**设计上的正确行为**（LOCAL 意图不许上云，而本地没有端点就只能停住），
**不是** tarball 通道的问题，也不是 bug。

#### 目标机器要自己写一份 `~/.dsh-edge-agent/edge.json`

```json
{
  "llm": {
    "local": {
      "baseUrl": "https://<你的 OpenAI 兼容端点>/v1",
      "model": "<模型名>",
      "keyRef": "myLocalKey"
    }
  },
  "secrets": {
    "myLocalKey": "<端点密钥>"
  }
}
```

三个要点：

1. `baseUrl` **必须含 `/v1`** —— adapter 只追加 `/chat/completions`；
2. `keyRef` 是**同一文件 `secrets` 段里的键名**（§7.102 起），**不是**环境变量名；
3. 端点不需要鉴权时，`keyRef` 可以留空、`secrets` 段也不必写。

写完**重启 App**。

> ⚠️ 为什么必须重启：配置**读取**本身是热生效的（`loadEdgeConfig()` 带文件
> 指纹缓存，mtime+size 变了就重读），但 **`local-llm` 路由的注册发生在插件
> `apply()` 时，也就是启动阶段** —— 端点从「无」变「有」必须重启才会注册。
> 反过来，端点一直配着的时候，改模型名这类是热生效的，不用重启。

> ⚠️ 报错文案曾经把用户指向 `DSH_EDGE_LOCAL_LLM_BASEURL` /
> `DSH_EDGE_LOCAL_LLM_KEY_ENV` 这两个**进程环境变量** —— 但桌面 GUI 启动宿主时
> 根本不读 .env，照着设了也没用（§7.159 实测）。§7.159 已把文案改成指向
> `edge.json`，并加门禁 [`verify-config-hints`](../scripts/verify-config-hints.mjs)
> 钉住「用户可见的配置提示必须指向真实配置入口」。

#### 想在这台机器上先看效果、不接本地模型

把 `llm.cloud` 配成**直连云池**（`baseUrl` + `model` + `keyRef`，不 delegate）
**并不能**绕开：隐私裁决是按 intent 走的，LOCAL 意图照样不许上云。
⇒ 想让边缘模式真正可用，**必须**配 `llm.local`。

### 3.5 DEMO 包（演示用：把活配置直接打进包里）

`npm run build:tarball:demo` 额外产出两个**演示用**的包：

```
dist/dsh-edge-agent-desktop-safe-DEMO.tar.gz
dist/dsh-edge-agent-full-DEMO.tar.gz
dist/README-DEMO.txt            ← 醒目警告，随包一起生成
```

它们与正规包**只差一个文件**：多了 `package/config/edge.json`（运维的明文
端点与 API key）。

> §7.182：**来源改了** —— DEMO 包的活配置从**顺位 2**（`~/.dsh-edge-agent/edge.json`）
> 读取，不再从仓库的 `config/edge.json` 取（仓库的 `config/` 目录已不再放活配置）。
> 该文件不存在 ⇒ `pack:demo` 直接报错退出，不会静默打一个空配置进去。

⇒ 好处：装到**任何一台没配置过的机器**上都能直接用 —— 配置候选**顺位 1**
（`<bundle>/config/edge.json`）命中 ⇒ `local-llm` 路由会注册 ⇒ 边缘模式
不会被隐私裁决 fail-closed 拦下（§3.4 那道门槛直接消失）。

⚠️ **主人裁决（2026-10-30）：演示用，不外传。** 因此这份产物有五道防线：

| 防线 | 机制 |
|---|---|
| 不进 git | `dist/` 已 gitignore |
| 不进 npm | `files` 白名单不含 `dist/`；`verify-package` 守 npm tarball |
| 不会被误当正规包 | 文件名带 `-DEMO`；`dist/README-DEMO.txt` 写明来龙去脉 |
| **改名也过不去** | `verify-tarball` 第 5 条对**正规包**判「含 `config/edge.json` ⇒ 红」（实测反向证伪：把 DEMO 包改名成正规包名字 ⇒ 门禁红） |
| DEMO 包自身也受检 | `verify-tarball` 对存在的 DEMO 包用**反向规则**审：必须**含** `config/edge.json`，否则红 |

⇒ 演示结束请删掉 `dist/*-DEMO.tar.gz`。

> ⚠️ 装 DEMO 包前注意：宿主按**包名**判重，同一个包名已经装过就装不上
> ⇒ **先卸载**再装。装完仍要点「立即启用」、重启 App。

## 4. 实测（2026-10-30，隔离临时 profile）

```
pnpm add C:\…\dist\dsh-edge-agent-desktop-safe.tar.gz
  → dependencies = { "@dsh-edge/dsh-edge-agent":
                      "file:C:/…/dist/dsh-edge-agent-desktop-safe.tar.gz" }
  → node_modules 条目是符号链接 → 指向 .pnpm/<hash>/… 的解包副本（冻结）
  → 包里：lib/index.js ✓  lib/client.js ✓
          cordis.desktop-safe.patch.yml ✓  presets/edge.desktop-safe.patch.yml ✓
          config/edge.example.json ✓
          config/edge.json ✗（不含真密钥）✓
```

`file:` 前缀写法结果完全相同。

## 5. 门禁：`verify:tarball`

**这条通道此前完全没有门禁。** `verify-installable.mjs` 只走
`dist/installable/`，**tarball 一次都没被检查过** ⇒ 它可以悄悄变旧、丢文件、
甚至混进密钥，而整条 `verify:build` 链依然全绿。

⇒ 新增 [`scripts/verify-tarball.mjs`](../scripts/verify-tarball.mjs)：

```bash
node scripts/verify-tarball.mjs             # 审真实产物
node scripts/verify-tarball.mjs --selftest  # 自证 + 反向证伪（11 项断言）
```

查 7 组：

1. tarball 存在，且**顶层目录是且只能是 `package`**；
2. `dsh.bundle.patch` 是**列表**，每个声明的文件都在包里，且**含 presets 层**；
3. `engines.dsh` 已声明；
4. `lib/index.js` **和 `lib/client.js`** 都在包里（§7.145：缺 client.js ⇒ Edge tab 静默消失）；
5. **不含 `config/edge.json`**；
6. `scripts` / `devDependencies` 已删；
7. **与 `dist/installable/<variant>/package.json` 的关键字段一致** ——
   这条就是**防陈旧**的：tarball 的 manifest 一旦比 installable 目录旧 ⇒ 门禁红。

已接进 `verify:build`（19 → **20 项**）。

### 5.1 反向证伪（对真实产物做的）

| 造出来的缺陷 | 门禁的反应 |
|---|---|
| 把 tarball 换成 §7.153 之前的旧形态（patch 写成字符串） | 🔴 2 项失败：字符串形式 + 「陈旧产物，重新构建」 |
| 往 tarball 里塞 `config/edge.json` | 🔴 1 项失败：含明文 API key |
| 恢复好产物 | 🟢 绿 |

### 5.2 那次被抓住的陈旧产物

**这是本轮的实际收获**：重建前的 `dist/*.tar.gz` 里
`dsh.bundle.patch` 是**字符串** `"./cordis.desktop-safe.patch.yml"`、
`engines` 里**没有 `dsh`** ⇒ 装出来的东西：

- **不会**注册「边缘模式」这个 Agent Preset（preset 层根本没被声明）⇒
  设置页的工作方式选择器里看不到它（§7.153 记过同一个坑）；
- 兼容性只能靠 peer 范围兜底。

⇒ 而 `dist/installable/` 目录（本地目录通道用）**一直是对的** ⇒
**同一台机器上两条通道装出来的东西不一样**，而且没人发现。

### 5.3 门禁接线：三条产线都要跑它（§7.158）

**门禁写出来不等于有人跑。** §7.157 把 `verify-tarball` 接进了 `verify:build`
（CI 用的那条链），但**本机的两条产线都没跑它**：

| 产线 | 产物 | §7.157 时跑的门禁 | 现在 |
|---|---|---|---|
| `build-windows/macos/linux.sh`（经 `_platform-common.sh`） | installable + tarball | 只有 `verify-installable` | **`verify-installable` + `verify-tarball`** |
| `build-desktop-bundle.sh`（老产线，自己实现打包） | installable + tarball | 只有 `verify-installable` | **同上** |
| `npm run build` / CI | installable + tarball | `verify:build`（含 `verify-tarball`） | 不变 |

⇒ 现在改的三处：`scripts/_platform-common.sh` 的 `dsh_package()`、
`scripts/build-desktop-bundle.sh` 的打包步之后。

### 5.4 §7.158：`verify:build` 含 `verify:tarball` ⇒ CI 必须产 tarball

§7.157 把 `verify:tarball` 接进 `verify:build` 时**漏了配套的构建步**：

```
CI/publish 的 build 链： compile → typecheck:client → build:client → build:installable
                                                                              ↑ 不产 tarball
verify:build 链：       … verify:installable → verify:tarball
                                           ↑ 读 dist/installable/  ✓
                                                        ↑ 读 dist/*.tar.gz  ✗ 不存在 ⇒ 判失败
```

⇒ **CI 必红**（`verify-tarball` 对缺失的产物判失败，不跳过）。
这与 §7.154（`lib/client.js`）、§7.156（`dist/installable/`）**是同一个形状**：
门禁读的是产物，产物得有人造。

修法：

1. `package.json#scripts.build` 与两个 workflow 的 build 链都加上 **`pack:tarball`**
   （= `node scripts/_pack-core.mjs tarball`，只出 tarball，不重复构建 installable）；
2. `verify-ci-build-chain.mjs` 的 `REQUIRED_BUILD_STEPS` 加上 `pack:tarball`
   ⇒ 以后再掉这一步，**提交前**就红，不用等 CI；
3. 顺带修掉那个门禁**自身的洞**（§7.158）：
   `mentionsBuildScript` 的旧正则是
   `/\bnode scripts\/run\.mjs\b[^\n]*\bbuild\b/`，而 `build:client` 里的
   `build` 满足 `\bbuild\b` ⇒ **任何提到 `build:client` 的链都豁免掉全部
   逐项检查**。也就是说 §7.154/§7.156 修对了 workflow，但**门禁从来没真正
   钉住它们**。现在豁免只认显式的 `npm run build` / `pnpm run build`
   （`(?![\w:-])` 保证 `npm run build:client` 不误匹配）。

反向证伪（对真实 workflow 做的）：

| 造出来的缺陷 | 门禁的反应 |
|---|---|
| `ci.yml` 的 build 链删掉 `pack:tarball` | 🔴 红：`the \`build\` job does not run "pack:tarball"` |
| `publish.yml` 的 build 链删掉 `pack:tarball` | 🔴 同上 |
| 把 `dist/*.tar.gz` 移走 | 🔴 `verify-tarball` 红：`tarball 不存在` |
| 全部还原 | 🟢 绿 |

## 6. 排障

| 现象 | 原因 |
|---|---|
| `the tarball does not exist` | 路径错 / 相对路径（必须绝对） |
| `a local path must be absolute` | 填了相对路径，或 Git Bash 的 `/c/Users/…`（桌面 App 只认 `C:\…`） |
| 装完提示 `failed to read overlay <file>` | tarball 里缺 `dsh.bundle.patch` 声明的文件 ⇒ 门禁 `verify:tarball` 能提前抓住 |
| 装完没有 Edge tab | ① 忘了点「立即启用」；② 缺 `lib/client.js`（`verify:tarball` 查得到）；③ preset 层缺席（工作方式选择器里没有「边缘模式」） |
| 改了 tarball 没变化 | **冻结副本** ⇒ 卸载重装（§2.5） |
| 装完一发言就报 `local-route-missing:local-llm` | 目标机器**没配本地 LLM** ⇒ 隐私裁决 fail-closed（**设计如此**）⇒ 按 **§3.4** 写 `~/.dsh-edge-agent/edge.json` 的 `llm.local` 后重启 |
| 照着报错设了 `DSH_EDGE_LOCAL_LLM_BASEURL` 还是不通 | 桌面 GUI 启动的宿主**读不到进程 env** ⇒ 必须写 `edge.json`（§3.4；§7.159 已改文案） |
| 想在别的机器上装 | tarball **不含** `config/edge.json` ⇒ 目标机器要自己写 `~/.dsh-edge-agent/edge.json`（顺位 2）或插件目录里那份（顺位 1）（§7.182） |

## 7. 相关文档

- [`deploy-github.md`](deploy-github.md) — 从 GitHub 仓库地址安装
- [`deploy-npm.md`](deploy-npm.md) — 从 npm 包名安装
- [`load-into-local-dsh.md`](load-into-local-dsh.md) — 本地目录通道（§8）+ 迭代循环与卸载
- [`privacy-policy.md`](privacy-policy.md) — 隐私策略 + 完整配置清单
- [`desktop-troubleshooting.md`](desktop-troubleshooting.md) — 桌面版排障手册
- [`architecture.md`](architecture.md) — 架构、Realm 模型、插件开发

---

## 8. 从 git 发布装（GitHub Release 资产 URL）—— §7.201

### 8.1 一句话

`v*` tag 推上去以后，GitHub Release 上会挂着**两个预构建 tar 包**；
在桌面 App 的 **Plugins → Add plugin** 里粘**那个 URL** 就能装：

```
https://github.com/chschytzmcy/dsh-edge-agent/releases/download/<tag>/dsh-edge-agent-desktop-safe.tar.gz
https://github.com/chschytzmcy/dsh-edge-agent/releases/download/<tag>/dsh-edge-agent-full.tar.gz
```

> `<tag>` = 当前发布版本（如 `v0.1.5`）—— 以 Releases 页上最新那个为准，不要写死。

⇒ **免构建授权、免 PATH 上的 pnpm**（与 npm 通道同一套好处，见
[`deploy-npm.md`](deploy-npm.md) §6.4），但**不需要 registry**。

### 8.2 为什么这条通道以前不存在

`publish.yml` 的 `release` job 建 GitHub Release 时**一个附件都没挂**：
有 `generate_release_notes` 与 `fail_on_unmatched_files`，却**没有 `files:`** ——
而 `fail_on_unmatched_files` 只有在挂了 `files:` 时才有意义 ⇒ 原意就是要挂，
只是那行从来没人写。

⇒ 后果：**两个变体的 tar 包都没有任何对外分发途径** ——
npm 只发 safe 变体（§7.188：`stage:npm` 暂存的是 safe 变体），
tar 包只存在于本地 `dist/`（已 gitignore）。
⇒ **full 变体（如 `0.1.3-full`）此前根本没有任何分发渠道。**

### 8.3 宿主把这种 URL 判成什么（实拉宿主源码，不是推测）

宿主 `@deepseek-ai/dsh-plugin-manager` 的 `lib/types/install-spec.js`：

```js
const HOSTED_REPOSITORY_URL = /^https?:\/\/[^/]+\/[^/]+\/[^/#]+(?:\.git)?(?:#.*)?$/i;
const TARBALL_SPEC = /\.(?:tgz|tar\.gz)(?:#.*)?$/i;

const git = GIT_SHORTHAND.test(spec) || GIT_URL.test(spec) || HOSTED_REPOSITORY_URL.test(spec);
if (git && !TARBALL_SPEC.test(spec)) return { kind: 'git', spec, host: gitHost(spec) };
if (/^https?:\/\//i.test(spec)) {
  if (TARBALL_SPEC.test(spec)) return { kind: 'tarball', spec, host: new URL(spec).host };
  throw invalid(spec, 'a URL must point at a git repository or a tarball');
}
```

- `HOSTED_REPOSITORY_URL` 只认 **host/段/段** 三段路径 ⇒ release 资产 URL
  （`/owner/repo/releases/download/<tag>/<file>`）**路径段更多，不匹配** ⇒
  不会被误判成 git 仓库；
- 而它以 `.tar.gz` 结尾 ⇒ `TARBALL_SPEC` 命中 ⇒ 判成 **`kind: 'tarball'`**。

⇒ **粘 URL 装预构建包，宿主走的是 tarball 通道**：装进 profile 的是 pnpm store
里的**冻结副本**（改了 tarball 不会自动生效，要重装 —— §2.5），
包里**不含** `config/edge.json`（§3.3）。

### 8.4 两个变体的区别

| 变体 | tar 包 | 清单版本 | `dsh.bundle.patch` | 用途 |
|---|---|---|---|---|
| safe | `dsh-edge-agent-desktop-safe.tar.gz` | `<version>-desktop-safe` | `cordis.desktop-safe.patch.yml` + `presets/edge.desktop-safe.patch.yml` | **不重写宿主默认值**（模型/人设/审批/沙箱/会话根/http-api 都留着）|
| full | `dsh-edge-agent-full.tar.gz` | `<version>-full` | `cordis.patch.yml` + `presets/edge.patch.yml` | 与独立的 `dsh-edge` profile 同款行为（**改写宿主默认值**）|

⇒ **npm 通道发的是 safe**；**full 只有 git 发布这一条路**（这是它第一次有对外分发渠道）。

> **§7.209（2026-11-12 起）：每个 tar 包只含自己变体的补丁。**
> 两个变体的补丁**互斥**（safe = 不改写宿主默认值 / full = 改写宿主默认值），
> 旧口径是「两个变体共用同一份 `files` 白名单」⇒ safe 的 tar 包里躺着 full 的
> 补丁（实测 56,454 B = `cordis.patch.yml` 20,482 + `presets/edge.patch.yml` 35,972）。
> 它不会被自动应用（宿主按 `package.json#dsh.bundle.patch` 取文件），但官方排障
> 文档教的「手动 cp `cordis.patch.yml` 到嵌套包根」会让 safe 用户**静默切到
> full 行为** ⇒ 该指引已改口（见 [`desktop-troubleshooting.md` §7](desktop-troubleshooting.md)）。
> ⇒ 由 `verify:tarball` 第 10 条（含 2 条反向自证）+ `verify:installable` 第 2d 项
> + `verify:npm-stage` 第 5d 项三道门禁钉死。

### 8.5 发布链（谁发的、谁验的）

```
git tag v<version>  →  publish.yml
                    ├─ job `npm`     → 构建 → verify:build（32 道门禁）→ pnpm publish
                    └─ job `release` → 构建 → verify:tarball → 建 Release，挂两个 tar 包
```

- 两个 job **互不依赖**（`release` 刻意**不**写 `needs: npm`）：
  npm 面会在 registry 或 token 出问题时挂（首发 token 2026-11-18 到期，
  2027-01 起 token 直发被移除），**git 面不能被它拖住**；
- **谁发谁验**：tar 包在发它的那个 job 里过 `verify:tarball`（§5），
  不是「别的 job 验过的产物」；
- **附件逐个点名**，不用 `dist/*.tar.gz` 通配符 —— `*-DEMO.tar.gz` 里带着
  运维的**明文 API key**（§3.5 / §7.182），而 release 是**公开**的
  ⇒ 通配符是一次待发的凭据泄漏。

门禁：`scripts/verify-git-release.mjs`（形状：变体齐 / 无通配符 / 自建自验 /
不依赖 npm）＋ `scripts/verify-tarball.mjs`（内容：§5）。

### 8.6 排障

| 现象 | 原因 |
|---|---|
| `a URL must point at a git repository or a tarball` | URL 没以 `.tgz` / `.tar.gz` 结尾（或拼错了）|
| `the tarball does not exist` | 版本 tag 不存在 ⇒ 先确认 Release 上确实有这一版 |
| 装完没有 Edge tab | 与 §6 同一张表（忘点「立即启用」/ 缺 `lib/client.js` / preset 层缺席）|
| 想要 full 的行为却装了 safe | 两个 URL 别搞混（§8.4）|

