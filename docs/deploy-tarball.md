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
| GitHub 地址 | `https://github.com/o/r` | **是** | **是** | 现场编译 | 否 | 重装 |
| 本地目录 | `C:\path\to\dir` | 否 | 否 | **符号链接** | **有** ⚠️ | **会** |

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
node_modules/.pnpm/@deepseek-harness-edge-agen_<hash>/node_modules/@deepseek-harness-edge-agent/dsh-edge-agent
```

⇒ **冻结副本**。改了 tarball 内容再 `pnpm install`，pnpm **不会重新解包**
（报 "Already up to date"，`node_modules/` 里还是旧代码）—— 这与
[`load-into-local-dsh.md` §8.6 坑 1](load-into-local-dsh.md) 是同一件事。

### 2.4 profile 里记成什么

```
"dependencies": {
  "@deepseek-harness-edge-agent/dsh-edge-agent":
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
4. 配置写 `~/.dsh-edge-agent/edge.json`（tarball 里没有 `config/edge.json`，§3.3）

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

`_pack-core.mjs` 的 `stageVariant()` 对两类产物**区别对待**（这是 load-bearing）：

| 产物 | `config/edge.json` |
|---|---|
| **tarball / npm pack**（可分发） | **排除** —— 那是运维的明文端点与 API key |
| **installable 目录**（link 模式，本机用） | **保留** —— 桌面 profile 靠它找到活配置 |

⇒ **tarball 里没有 `config/edge.json`**（实测确认）⇒ 装完配置要写
`~/.dsh-edge-agent/edge.json`（第 2 顺位）。

## 4. 实测（2026-10-30，隔离临时 profile）

```
pnpm add C:\…\dist\dsh-edge-agent-desktop-safe.tar.gz
  → dependencies = { "@deepseek-harness-edge-agent/dsh-edge-agent":
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
| 想在别的机器上装 | tarball **不含** `config/edge.json` ⇒ 目标机器要自己写 `~/.dsh-edge-agent/edge.json` |

## 7. 相关文档

- [`deploy-github.md`](deploy-github.md) — 从 GitHub 仓库地址安装
- [`deploy-npm.md`](deploy-npm.md) — 从 npm 包名安装
- [`load-into-local-dsh.md`](load-into-local-dsh.md) — 本地目录通道（§8）+ 迭代循环与卸载
- [`config-reference.md`](config-reference.md) — 完整配置清单
- [`desktop-troubleshooting.md`](desktop-troubleshooting.md) — 桌面版排障手册
- [`architecture.md`](architecture.md) — 架构、Realm 模型、插件开发
