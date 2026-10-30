# 从 GitHub 仓库地址安装（桌面版 Plugins → Add plugin）

> 状态：**2026-10-30 实现并实测**（§7.155）。通道本身宿主早就做完了；这一轮
> 补齐的是**作者侧**的义务，并加了一道门禁守着。
>
> 宿主契约出处：`deepseek-harness`（只读参考仓）
> `packages/boot/plugin-manager/src/*`、`packages/client/ui-plugin-manager/src/client/*`、
> `docs/user/develop/basic/publish.md`。

## 0. 一句话

在桌面 App 的 **Plugins → Add plugin** 里填

```
https://github.com/chschytzmcy/dsh-edge-agent
```

宿主负责预检、构建授权、装后校验、启用；**本仓负责让「克隆源码 → prepare → 打包」
产出宿主要的全部东西**（Node 半侧 + 浏览器半侧 + bundle patch 层）。

**两个前置条件**（详见 §2）：仓库要能被读（§2.1）、**PATH 上要有 `pnpm`**（§2.5）。

## 1. 三条通道怎么选

| 通道 | 输入 | 要构建授权吗 | 产物形态 | 适合谁 |
|---|---|---|---|---|
| npm 包名 | `@作者/插件名` | 否 | 预构建 | 要发布给公众 |
| **GitHub 地址** | `https://github.com/<owner>/<repo>` | **是**（一次点击放行） | 现场编译 | 自己/小范围分发、持续迭代 |
| 本地目录 | `C:\path\to\dir` | 否 | 预构建 | 本机开发调试 |

三条通道在宿主里是**同一段代码**（`install-spec.ts:69-92` 解析出四种形态，
`index.ts:930` 一律 `pnpm add <spec>`，cwd = profile 目录）。

## 2. 作者侧的前置条件（本仓已全部满足）

### 2.1 仓库要能被读

宿主的连通性预检跑的是（`github-connection.ts:44`）：

```
git -c credential.helper= ls-remote -- <repo> HEAD
```

**凭据助手被显式禁用、终端交互被禁用**。预检失败只有 `network` / `timeout` 会
阻断安装（`index.ts:908-912`），401/403 与认证失败一律**不阻断**，交给 pnpm 再试。

> 但**预检能过 ≠ 装得上** —— 预检走 git，pnpm 那一跳未必走 git。

#### ⚠️ 私有仓库：地址写法决定走 clone 还是走 tarball

pnpm 解析 git spec 后会决定「下载 tarball」还是「git clone」
（`dist/pnpm.mjs:139492` 的 `fromHostedGit` + `:139691` 的 `createResolutionObject`）：

```js
// :139547  先匿名探一次：https://github.com/<owner>/<repo> 发 HEAD
const repoIsPublic = httpsUrl != null && await isRepoPublic(httpsUrl, ...)
// :139504  私有库 ⇒ 先试 ls-remote（用本机 git 的凭据）
if (!fetchSpec && httpsUrl) {
  if ((hosted.auth || !repoIsPublic) && await accessRepository(httpsUrl)) {
    return { fetchSpec: httpsUrl, hosted: { ...hosted, tarball: void 0 }, ... }   // ★ tarball 置空 ⇒ 走 clone
  }
}
// :139537  兜底处的注释（pnpm 原话）：
//   without proof that the repo is public, the host's anonymous archive endpoint
//   cannot be assumed to work, so the resolution must stay `type: git`.
tarball: repoIsPublic ? hosted.tarball : void 0
```

⇒ **pnpm 自己有防护**：只有确认仓库公开才用 codeload tarball，否则强制 `type: git`
（走系统 git clone）。于是：

| 填的地址 | pnpm 怎么下 | 私有库能装吗 |
|---|---|---|
| `https://github.com/<owner>/<repo>` | 匿名 HEAD 探到是私有 ⇒ **走 git clone**（系统 git） | ✅ **但要求本机 git 有非交互可用凭据**（credential helper / GCM 里的 token）。换一台没配凭据的机器就装不上 |
| `git@github.com:<owner>/<repo>.git` | git clone（系统 git + SSH key） | ✅ **只依赖 SSH key，最稳** |
| `git+ssh://git@github.com/<owner>/<repo>.git` | git clone | ✅ |
| `ssh://git@github.com/...`（漏了 `git+`） | ⚠️ `isSsh`（`:139886`）不认这个开头 | 别这么写 |

clone 那条路 pnpm 会自己设 `GIT_TERMINAL_PROMPT=0` 与
`GIT_SSH_COMMAND=ssh -o BatchMode=yes`（`:138278-138281`）⇒ **非交互**；
pnpm 用的是**系统 git CLI**（自带 `@npmcli/git` 7.0.2，不是纯 JS 实现）。

⇒ **私有库填 SSH 形式**最稳（只依赖 SSH key）；**公开库填 https** 最省事
（别人不用配 key，且走 tarball 更快）。

> 宿主那一侧对 github.com **不会自动**从 HTTPS 回退到 SSH
> （`git-transport.ts:65-71`：`hosted-git-info` 认识 github.com ⇒ 不探测），
> 所以 SSH 形式必须**手填**。

**实测（2026-10-30，对本仓真实跑 `pnpm add`）**：

| 写法 | 结果 |
|---|---|
| `https://github.com/chschytzmcy/dsh-edge-agent` | ✅ 装成功（私有库 ⇒ 走 clone，用的是本机 GCM 里的 token） |
| `git+ssh://git@github.com/chschytzmcy/dsh-edge-agent.git` | ✅ 装成功（用本机 SSH key） |

两者解析出的 commit 都是 `552a6e7`（**默认分支的 HEAD**，不是 tag），
装出来的包内容完全一致。

> 构建授权那一步，pnpm 打印的键长这样（scoped 包名要加引号）：
> ```
> allowBuilds:
>   "@deepseek-harness-edge-agent/dsh-edge-agent@git+https://github.com/chschytzmcy/dsh-edge-agent.git#552a6e7f…": true
> ```
> 键 = `<包名>@<pkgResolutionId>`，而 `pkgResolutionId` = `git+<地址>#<commit>`。

#### 桌面版实机记录（2026-10-30）

主人实际在桌面 App 里点了一次，宿主写的日志把整条链路记下来了：

| 阶段 | 宿主日志 | 结论 |
|---|---|---|
| 连通性预检 | `fatal: could not read Username for 'https://github.com': terminal prompts disabled` | 预检用 `credential.helper=`（**显式禁用凭据助手**）+ `GIT_TERMINAL_PROMPT=0` ⇒ **本机 GCM 里的 token 在这一关用不上** ⇒ 私有库 + https ⇒ 预检必失败。**SSH 形式不受影响**（`credential.helper=` 对 SSH 无意义） |
| 真正安装 | `[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] ... fetched from "git@github.com:chschytzmcy/dsh-edge-agent.git"` | 注意 `fetched from` 是 **SSH** ⇒ **pnpm 自己从 https 回退到了 SSH**（`fromHostedGit` 的 `:139522`）⇒ 主机的 SSH key 生效、clone 成功。真正的阻断点是**构建授权** |

> ⚠️ **宿主有个文案误导**：客户端弹的是「无法访问 GitHub / 改用国内镜像」，
> 但**既不是网络不通，也不是 GitHub 不可达**。原因是失败分类
> （`install-failure.ts:21-30`）的 network 模式含 `\bETIMEDOUT\b`，而 pnpm 输出里
> 有一行**非致命**的 WARN：
> ```
> [WARN] HEAD https://github.com/chschytzmcy/dsh-edge-agent error (ETIMEDOUT). Will retry in 500 milliseconds.
> ```
> （那是 pnpm 匿名探测「仓库是否公开」那一步，超时了但被重试兜住）
> ⇒ 整段输出被判成 `network` ⇒ `failedAt='spec-host'` ⇒ 弹「无法访问 GitHub」。
> 宿主只看输出文本、不区分 WARN 与致命错误 ⇒ 分类被带偏。

⇒ 实操结论：**填 SSH 形式**（预检这关才能过）+ **提前把 allowBuilds 键写进
profile 的 `pnpm-workspace.yaml`**（等价于宿主 GUI 上那次「允许这些脚本并重试」），
就不必指望 GUI 把正确的按钮弹出来。

**⚠️ 但 SSH 形式也一样会做匿名 HEAD 探测**（实测：`hosted-git-info` 认得
`git+ssh://git@github.com/...` ⇒ 仍走 `fromHostedGit` ⇒ 仍做 `isRepoPublic`）：

```
[WARN] HEAD https://github.com/chschytzmcy/dsh-edge-agent error (ETIMEDOUT). Will retry in 500 milliseconds.
[WARN] HEAD https://github.com/chschytzmcy/dsh-edge-agent error (ECONNRESET). Will retry in 1 second.
```

⇒ **这台机器的匿名 HTTPS 到 github.com 是不通的**（SSH 通、匿名 HTTPS 不通）。
两个后果：

1. 安装会**多等两次超时**（看起来像卡住，其实是在重试）；
2. **https 形式彻底双输** —— 预检过不了（`credential.helper=` 禁掉了 GCM），
   clone 走的匿名 HTTPS 也不通 ⇒ **SSH 是唯一可行的写法**。

只要最终 pnpm 成功，那两行 WARN 不会触发失败分类 ⇒ GUI 不会弹「无法访问 GitHub」。

> 若要让别人无凭据装上，只能把仓库公开；发布前请先确认仓里没有密钥
> （`config/edge.json` 已被 `.gitignore` 排除，`config/edge.json.bak-*` 同样）。

### 2.2 `prepare` 必须自包含

宿主自己的说明（`publish.md:169-171`）：

> a git install fetches **sources, not built artifacts**: nothing runs your
> `build` script, so a TypeScript package arrives without its `lib/` output and
> fails to load.
>
> The **author** ships a `prepare` script — pnpm runs it after a git install —
> that builds the published entry points from source, **self-contained**.

⇒ git 安装**只跑 `prepare`，不跑 `build`**。本仓的 `prepare` 是：

```json
"prepare": "node scripts/run.mjs compile build:client"
```

- `compile` = `clean-lib` + `tsc -p tsconfig.json` ⇒ Node 半侧 `lib/**`
- `build:client` = esbuild ⇒ **浏览器半侧 `lib/client.js`**

> **`build:client` 不能漏**：`lib/client.js` 是 esbuild 产物，`tsc` 产不出来。
> 漏掉它的症状是「宿主半侧正常挂载、Edge tab 静默不出现」——日志里什么都不说
> （§7.145 记过这个坑）。本轮之前 `prepare` 只有 `compile`，正是这个状态。

### 2.3 `prepare` 自包含的边界

`tsconfig.json` 无 project references、`include` 只有 `src` ⇒ 编译不需要 monorepo
兄弟包。`run.mjs` 是包管理器无关的运行器（桌面 runtime 只有 node + pnpm，
**没有 npm**），所以 `prepare` 不依赖 npm。

### 2.4 pnpm 会先装 devDependencies

实测（pnpm 11.28.5，桌面 runtime 自带的那支）：git 依赖被准备时，pnpm 会先在
克隆目录里装好该包的 **devDependencies**，再跑 `prepare`：

```
node_modules listing = [".package-lock.json","left-pad"]     ← devDep 在
left-pad import = OK (function)
```

⇒ `tsc` / `esbuild` 在 git 安装时可用。本仓的 devDeps 在公网 npm 上都能按
`>=0.2.1-rc.2` 解析到 `0.2.1-rc.5`（已逐个核对）。

### 2.5 ⚠️ PATH 上必须有一个 `pnpm`（桌面版当前**不满足**）

这是**宿主侧**的条件，本仓无法绕过。链条是这样的（pnpm 自己的源码，
`dist/pnpm.mjs`）：

```js
// :130133  按 clone 根目录里的锁文件决定包管理器名
const pm = (await preferredPM(gitRootDir))?.name ?? "npm";
// :130157  往 clone 的 manifest 里注入一条脚本
manifest.scripts[`${pm}-install`] = `${pm} install`;
// :130158  用 shell 跑它
await runLifecycleHook(installScriptName, manifest, execOpts);
```

`prepare` 非空 ⇒ pnpm **一定**走构建路径（`:130185`）⇒ 一定注入 `pnpm install` ⇒
**shell 必须在 PATH 上找到 `pnpm`**。

**`<pm>` 为什么是 pnpm**（`preferredPM` 的判定顺序，`:130053`）：
`package-lock.json` → `yarn.lock` → `pnpm-lock.yaml` → `shrinkwrap.yaml` → `bun.lock*`
→ 向上找 `pnpm-lock.yaml` / `pnpm-workspace.yaml` → yarn workspace 根 → 最后按装机的
包管理器猜。本仓的 `package-lock.json` **在 `.gitignore` 里**（clone 里没有），
`pnpm-lock.yaml` 被跟踪 ⇒ 判定 **pnpm** ⇒ 注入的就是 `pnpm install`。

> 顺带说明为什么「改 `packageManager` 字段」不是出路：那只影响 `preferredPM`
> 的兜底分支，而本仓的 `pnpm-lock.yaml` 与 `pnpm-workspace.yaml` 都在跟踪列表里，
> 前两个判定分支已经把它钉死成 pnpm。

而桌面 runtime 的 `bin/` 里**只有 `node` / `node.cmd`，没有 pnpm**——宿主把
`runtime\bin` 前置到 PATH（`apps/desktop-host/src/index.ts:44`）后，用户 PATH 里
也得有 pnpm 才找得到。实测本机：**PATH 上没有 pnpm**（`C:\Program Files\nodejs`
与 `C:\Users\cheng\AppData\Roaming\npm` 里都没有 shim）。

⇒ 症状是 pnpm 抛这一句，卡住的人完全看不出该做什么：

```
pnpm-install$ pnpm install
'pnpm' is not recognized as an internal or external command
[ERR_PNPM_PREPARE_PACKAGE] Failed to prepare git-hosted package
```

**补救**（二选一）：

1. **装一个全局 pnpm**：`npm i -g pnpm` ⇒ 落到 `C:\Users\cheng\AppData\Roaming\npm`，
   该目录**本来就在用户 PATH 上** ⇒ 桌面 app 的 PATH 里就有了 pnpm ⇒ 通道通。
   （实测：用等价 shim 验证过整条链跑通。）**注意桌面 app 要重启**才拿到新 PATH。
   > **本机已于 2026-10-30 装好**：`C:\Users\cheng\AppData\Roaming\npm\pnpm.cmd`
   > （v11.7.0，与 `package.json#packageManager` 一致）。桌面 app 重启后生效。
2. **改走 npm / tarball 通道**（宿主 `publish.md:183-186` 的建议）：分发**预构建
   产物**，安装时不需要任何构建权限，也就不需要 PATH 上有 pnpm。

> 宿主自己那条 e2e 测试（`boot/plugin-manager/tests/manager.spec.ts:1460`，
> 「installs and removes with the bundled pnpm when PATH contains no pnpm」）
> 用的包**没有构建脚本** ⇒ 压根不触发这一步 ⇒ 这条缺口没被那条测试覆盖到。

## 3. 桌面上的操作步骤

### 3.1 输入

侧边栏 **Plugins → Add plugin**，输入框填仓库地址。

宿主对输入几乎不做处理（`manager-store.ts:764-770` 只 `trim()`，不补协议、
不补 `.git`）。可用的写法：

| 写法 | 结果 |
|---|---|
| `https://github.com/owner/repo` | ✅（**私有库会卡在预检**：宿主预检禁掉凭据助手 ⇒ 要用户名） |
| `https://github.com/owner/repo.git` | ✅ 同上 |
| `https://github.com/owner/repo#main` | ✅（钉分支） |
| `github:owner/repo` | ✅（shorthand） |
| `git+ssh://git@github.com/owner/repo.git` | ✅ **私有库用这个**（预检走 SSH，不吃凭据助手那一套） |
| `git@github.com:owner/repo.git` | ✅ 同上（scp 形式） |
| `https://github.com/owner/repo/subdir` | ❌ 被拒：`HOSTED_REPOSITORY_URL` 只接受**两段**路径（`install-spec.ts:24`）。要子目录必须写 `git+https://github.com/owner/repo#<sha>&path:/<dir>` |

### 3.2 构建授权（会弹一次）

第一次装一定失败，错误是：

```
[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] Failed to prepare git-hosted package ...
not in the "allowBuilds" allowlist
```

pnpm ≥10 拒绝为 git 依赖跑 `prepare`，除非**安装方**放行。宿主已经把这步
做进 UI：解析 pnpm 打印的键 → 写进 profile 的 `pnpm-workspace.yaml` →
给一个**「允许这些脚本并重试」**按钮（`build-approval.ts:15,63-96`）。

点一下即可。**安全含义**：这一步等于允许在本机执行该仓库的代码，宿主自己也
这么写（`publish.md:181`）。只放行你信得过的来源；要更稳就钉 commit：

```
https://github.com/chschytzmcy/dsh-edge-agent#<sha>
```

#### 手动放行：写**稳定键**，别写带 commit 的键

pnpm 打印的键长这样（键 = `<包名>@<pkgResolutionId>`，而 `pkgResolutionId` =
`git+<地址>#<commit>`）：

```yaml
allowBuilds:
  "@deepseek-harness-edge-agent/dsh-edge-agent@git+ssh://git@github.com/chschytzmcy/dsh-edge-agent.git#c2b01fc…": true
```

**带 `#<commit>` 的键只对那一个 commit 有效**——仓库一更新就失效。而 pnpm 的匹配
逻辑（`dist/pnpm.mjs:197370` 的 `getGitRepoAllowBuildKeyFromDepPath`）在比对时
**会把 `#` 之后截掉**，所以**去掉 `#<commit>` 的写法对仓库的任意 commit 都放行**：

```yaml
allowBuilds:
  "@deepseek-harness-edge-agent/dsh-edge-agent@git+ssh://git@github.com/chschytzmcy/dsh-edge-agent.git": true
```

> 键必须**不含 `#`**（`isGitRepoAllowBuildKey`：`:197367`），否则会被当成精确
> depPath 匹配。手动放行时写进 profile 的
> `~/.dsh/profiles/desktop/pnpm-workspace.yaml` 即可（宿主 GUI 点按钮写的也是
> 同一个文件，只是它写的是带 commit 的那一条）。

**实测（2026-10-30，桌面 runtime 那支 pnpm + 稳定键 + PATH 上有 pnpm）**：

```
exit = 0
  不再被构建授权拦下 : true
  prepare 真的跑了   : true
  lib/index.js       : true
  lib/client.js      : true
dependencies:
+ @deepseek-harness-edge-agent/dsh-edge-agent 0.1.1
Done in 50.3s using pnpm v11.28.5
```

⇒ **稳定键 + PATH 上有 pnpm ⇒ 整条链一次跑通**（50s 里有两次匿名 HEAD 探测的
超时在等）。

### 3.3 装完要点「立即启用」

**GUI 装完不会自动启用**（客户端传 `enabled: false`，`manager-store.ts:1250`；
宿主只在 `enabled !== false` 时才 `selectBundle`，`index.ts:990`）。

「启用」= 把包名写进 profile 的 `dsh.profile.bundles` + 挂载它的 bundle patch 层。
**不点就等于没装**：包在 `dependencies` 里，但不在 `dsh.profile.bundles` 里 ⇒
启动时不加载 ⇒ 桌面右栏不出现 Edge tab。

启用后若宿主提示「需重启」，重启桌面 App（无 HMR 时 bundle 层要重新加载）。

## 4. 装完之后配置在哪

`config/edge.json` **含明文 API key，不入库**（`.gitignore` 排除，且 `files`
白名单用 `!config/edge.json` 排除）⇒ **git 装出来的包里没有它**。

运行时查找顺序（`src/dsh-adapter/edge-config.ts:391-408`）：

1. `<bundle root>/config/edge.json` — 装在 `node_modules` 里时就是这里；
2. `~/.dsh-edge-agent/edge.json` — **git 装完用这个**（已安装覆盖位置）；
3. `<bundle root>/config/edge.example.json` — 空密钥的模板，最后兜底。

⇒ 把真实端点与密钥写进 `~/.dsh-edge-agent/edge.json`（该文件本身同样不入库）。

**装出来的包长什么样**（实测，2026-10-30）：

```
node_modules/@deepseek-harness-edge-agent/dsh-edge-agent/
├── lib/          ← prepare 现场编译出来的（Node 半侧 + 浏览器半侧 client.js）
├── config/       ← edge.example.json + privacy-policy.json（**没有 edge.json**）
├── presets/
├── cordis.desktop-safe.patch.yml
├── cordis.patch.yml
├── cordis.yml
├── package.json / README.md / LICENSE
└── （231 个文件 / 1.69 MB）
```

⇒ `files` 白名单在 git 通道**同样生效**：`src/`、`scripts/`、`tests/`、`.git/`
都没跟进来 ⇒ 装出来的东西与 `npm pack` 出来的**内容一致**
（`verify:package` 报的也是 231 files / 67 entry targets）。

## 5. 升级 / 回退

- 宿主对非官方插件只提供「卸载后重装」（`locales.ts:89`），没有 in-place 升级；
- 卸载走 `pnpm remove`，会一并撤掉 `dsh.profile.bundles` 里的条目；
- 想换版本就换 spec 里的 `#<sha>`，卸载重装。

## 6. 门禁：这条通道怎么保证不悄悄坏掉

```bash
npm run verify:git-install        # 静态契约（快，CI 跑）
npm run verify:git-install:real   # 端到端：克隆已提交状态 → 桌面 runtime 的 pnpm 装 → 核 payload
```

静态门禁把宿主那几条契约逐条变成断言（bundle 声明 / patch 文件存在且是 YAML
数组 / `prepare` 链覆盖 `compile` 与 `build:client` / `engines.dsh` 已声明 /
`files` 白名单覆盖且排除密钥 / `prepare` 不依赖 monorepo）。

`--real` 会**克隆本仓的已提交状态**（= GitHub 给用户的那份：只有 tracked 文件，
没有 `lib/`），在临时 profile 目录里用**桌面 runtime 自带的那支 pnpm** 装它，
然后检查装出来的包里真的有 `lib/index.js`、`lib/client.js` 与两个 bundle patch
文件，并确认 profile 的 `dependencies` 记下了它。pnpm 的构建授权那一步按宿主
`build-approval.ts` 的做法处理（解析 pnpm 打印的键 → 写 `allowBuilds` → 重试）。

> `--real` 要求工作区**已提交**——它克隆的是 HEAD，工作区脏着跑会测到旧代码、
> 给出假通过。脚本会自己检查并拒绝。

**实测结果（2026-10-30）**：

| 轮次 | PATH 上有没有 pnpm | 结果 |
|---|---|---|
| A | ❌ 没有 | 被前置条件拦下，报「PATH 上没有可用的 `pnpm`」并附补救；探测输出是 cmd.exe 的原话 `'pnpm' is not recognized as an internal or external command` |
| B | ✅ 有（等价 shim：`pnpm.cmd` → 桌面 runtime 那支 `pnpm.mjs`） | ✅ `端到端 OK（克隆 → pnpm add → payload 完整）` |

B 轮装出来的包里四样齐全：`lib/index.js`、`lib/client.js`、两个 bundle patch 文件、
profile `dependencies` 里的包名。

> 门禁自身也被证伪过一次（已修）：探测原本用 `execFileSync('pnpm', ...)`，而 Node
> 在 Windows 上**不给裸命令名补 `.cmd`/`.bat`**（Node 20.12+ 出于 CVE-2024-27980
> 拒绝 spawn .cmd/.bat），`npm i -g pnpm` 装出来的恰恰是 `pnpm.cmd` ⇒ **有 pnpm
> 被误判成没有**。现在按 Windows 的规矩解析（PATH 逐目录 × PATHEXT 逐扩展名，
> 与 cmd.exe / cross-spawn 一致）。

## 7. 相关文档

- [`load-into-local-dsh.md`](load-into-local-dsh.md) — 装进本地 DSH（三条路）
- [`desktop-troubleshooting.md`](desktop-troubleshooting.md) — 装完起不来 / Edge tab 不见了
- [`deploy-minimal-files.md`](deploy-minimal-files.md) — 最小部署清单
- 宿主自己的发布说明：`deepseek-harness/docs/user/develop/basic/publish.md`
