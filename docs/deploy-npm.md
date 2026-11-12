# 从 npm 包名安装（桌面版 Plugins → Add plugin）

> 状态：**2026-11-10 发布链就绪**（§7.172）。宿主侧的 npm 通道 2026-10-30 就
> 调研完了（§7.156），这一轮把**发布这条路本身**修成了可用状态：本地一键发布
> 脚本 + 发布就绪门禁 + CI 决策（已发版本跳过 / 首次发布不带 provenance）。
>
> ⚠️ **但这个通道今天还用不了** —— 包**仍未**发布到 registry（registry 上查无
> 此包）。「填包名」这条路要等第一次发布之后才成立。
>
> ⇒ 缺的**不是代码**，是**作者侧的三件东西**：① npmjs.com 上拥有
> `@dsh-edge` scope 的账号/组织；② 发布凭据（granular
> access token，或登记 trusted publisher 改走 OIDC）；③ 执行
> `npm run publish:npm -- --yes --tag`。逐条清单见 §8.5，
> **注册与办凭据的逐步操作见 [`npm-account-setup.md`](npm-account-setup.md)**。
>
> 宿主契约出处：`deepseek-harness`（只读参考仓）
> `packages/boot/plugin-manager/src/*`、`packages/client/ui-plugin-manager/src/client/*`、
> `docs/user/develop/basic/publish.md`。

## 0. 一句话

在桌面 App 的 **Plugins → Add plugin** 里填

```
@dsh-edge/dsh-edge-agent
```

宿主负责查 registry、装、校验、启用；**本仓负责让 registry 上那个 tarball
包含宿主要的全部东西**（Node 半侧 + 浏览器半侧 + bundle patch 层）。

与 git 通道最大的差别：**npm 通道不需要构建授权，也不需要 PATH 上有 pnpm**
（§2.6 解释为什么）⇒ 用户点一下就装完。

## 1. 三条通道怎么选

| 通道 | 输入 | 要构建授权吗 | PATH 要有 pnpm 吗 | 产物形态 | 适合谁 |
|---|---|---|---|---|---|
| **npm 包名** | `@作者/插件名` | **否** | **否**（用 App 自带的） | 预构建 | **发布给公众** |
| **tarball URL** | `https://…/x.tar.gz` | **否** | **否** | 预构建（冻结副本） | 不经 registry 的分发（§7.201；见 [`deploy-tarball.md` §8](deploy-tarball.md)） |
| GitHub 地址 | `https://github.com/<owner>/<repo>` | **是**（点一次放行） | **是** | 现场编译 | 自己/小范围分发、持续迭代 |
| 本地目录 | `C:\path\to\dir` | 否（但目录里若有构建脚本则要） | 否 | 预构建（符号链接） | 本机开发调试 |

三条通道在宿主里是**同一段代码**（`install-spec.ts:69-92` 解析出四种形态，
`index.ts:930` 一律 `pnpm add <spec>`，cwd = profile 目录）。

各自的完整指南：[`deploy-github.md`](deploy-github.md)（GitHub 通道）、
[`load-into-local-dsh.md` §8](load-into-local-dsh.md)（本地目录通道）。

## 2. 宿主怎么认「这是一个 npm 包名」

### 2.1 分类顺序

`parseInstallSpec(raw)`（`install-spec.ts:69-92`）按顺序判定：

| # | 规则 | 命中则 |
|---|---|---|
| 1 | `file:` / `link:` 前缀，或绝对路径 | → `path`（或 `.tgz`/`.tar.gz` → `tarball`） |
| 2 | 相对路径（`./x`、`../x`） | ❌ 拒绝：`a local path must be absolute` |
| 3 | git shorthand / git URL / 托管仓库 URL | → `git` |
| 4 | 其它 `http(s)://` | → `tarball`（否则拒绝：`a URL must point at a git repository or a tarball`） |
| 5 | **其余一切** | → **`registry`** |

⇒ 宿主对「像不像包名」的判断就是**第 5 条的兜底**：不是前四种，就当包名试。

### 2.2 包名规则（比 npm 自己还严）

宿主用自己的正则校验（`install-spec.ts:32-33, 87-89`）：

```
/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/
```

- **只允许小写**（`Dsh-Upper` 被拒）；
- 长度 ≤ 214；
- scope 是包名的一部分，一路带到依赖键、bundle 名、列表行。

本仓的 `@dsh-edge/dsh-edge-agent` ✅ 合规。

### 2.3 版本后缀怎么切

`spec.indexOf('@', 1)` —— **从第 1 个字符后找第一个 `@`**：

| 输入 | name | range |
|---|---|---|
| `pkg` | `pkg` | 无（pnpm 取 `latest`） |
| `pkg@^1.2` | `pkg` | `^1.2` |
| `@scope/name` | `@scope/name` | 无 |
| `@scope/name@^1.2` | `@scope/name` | `^1.2` |
| `@scope/name@` | — | ❌ 拒绝：`a version after @ must not be empty` |

## 3. 装之前：宿主要问 registry 两次

### 3.1 第一次 —— 用户可见的预检（`inspect`）

```
pnpm view <spec> name version description dsh --json
```

- 跑在 **profile 目录**里（代理/认证设置在那儿生效，`operations.ts:651`）；
- 超时 `inspectTimeoutMs`（默认 **20000ms**，`index.ts:799`）；
- **禁用 pnpm 重试**（`--config.fetch-retries=0`，`operations.ts:649`）——
  理由是「不响的 registry 要在超时内报出来，后面的 registry 就是重试」。

读到的字段里 `dsh` 最要紧：它带 `dsh.bundle`，而 **`dsh.bundle` 必须带 `patch`
才算 bundle**（`operations.ts:75-79`）—— 只声明 `dsh.bundle` 而没有 `patch`
⇒ 宿主判它 `not-bundle` ⇒ 拒绝安装。

预检的几种结论（`index.ts:807`）：

| 结论 | 触发 |
|---|---|
| `already-installed` | profile 里已经有这个包了 |
| `not-found` | registry 说没有，**或**没有匹配的版本 |
| `network` | 网络/超时 |
| `unknown` | 其它；也包括「pnpm view 答了但没这个包」 |
| `not-a-bundle` | 包没声明 `dsh.bundle` |

### 3.2 第二次 —— 装前的兼容性预检（`operations.ts:186-193`）

```
pnpm view <spec> name version engines peerDependencies --json
```

- `engines` 和 `peerDependencies` 在**这里**读（不在 `inspect()` 里）；
- 超时同样是 20000ms（`LOOKUP_TIMEOUT_MS`）；
- 带与正式安装**同一个** `--registry=` 标志 ⇒ 查的就是要装的那个源；
- 不满足 ⇒ **在 pnpm 跑之前就拒绝**，一个字节都不下载。

⇒ **版本不兼容的用户会看到「装不了」，而不是「装完起不来」**。

## 4. registry 选择与回退

### 4.1 计划怎么排（`registry.ts:54-76`）

- `own` = pnpm 自己配置里写的 registry（每次现读）；
- `fallbacks` = 配置里的备用源，**默认带 `https://registry.npmmirror.com/`**；
- **私有或未知的 registry 单独问，不回退**（`registry.ts:73-74`）——
  私有源失败不会掉到公网去；
- 否则：请求的源排第一，其余按配置顺序。

默认（用户的 pnpm 指向 npm 官方）：`[pnpm 自己的, npmmirror]` —— **两个源**。

### 4.2 什么时候换下一个源

只有这四种信号算「是 registry 的问题」（`registry.ts:79`）：

```
network · timeout · not-found · no-matching-version
```

其它失败（兼容性拒绝、被用户中止）**不换源**。

### 4.3 客户端能做什么

- 安装对话框里有 **registry 选择器**（宿主的第一个源 + 备用源 + pnpm 自己 + 手填 URL）；
- 宿主会**竞速** `registry.npmjs.org/-/ping` 和 `registry.npmmirror.com/-/ping`
  （1.5s 上限、5 分钟缓存），npmmirror 先答应就预选它；
- ⚠️ **「改用国内镜像」那个按钮是 GitHub 失败路径专有的**——
  它只在 spec 确认是 GitHub 宿主、失败是 network/timeout、且宿主归因到
  `spec-host` 时才出现（`manager-store.ts:304-312`）。
  **填 npm 包名时没有这个按钮**，registry 路径的补救是 registry 选择器 + 逐源重试。

## 5. 版本解析：宿主根本不做

**宿主不选版本，全交给 pnpm。**

- `pkg` → `pnpm add pkg` → pnpm 取 `latest`；
- `pkg@^1.2` / `pkg@next` / `pkg@1.2.3` → 原样传给 `pnpm add`。

宿主只在**读**版本：`inspect()` 读到的 `pnpm view` 结果对 range 来说
**只是最高的一个匹配**（pnpm 对 range 只打印最高匹配，这是它要逐版本查的原因）。

⇒ 想要可复现，就在 spec 里写死版本：`pkg@0.1.1`。

## 6. 真正的安装

### 6.1 命令（`index.ts:930`）

```ts
runPnpm(['add', installSpec, ...saveExact ? ['--save-exact'] : [], ...registryArguments(registry)])
```

- cwd = **profile 目录**（不是插件目录，不是用户当前目录）；
- 产物形态 = registry 上的 tarball（预构建）。

### 6.2 装后校验（`index.ts:960-977`）

1. 找出这次被加进去的依赖，必须**恰好一个**，否则 `ambiguous-install`；
2. `dsh.bundle` 必须存在，且**必须带 `patch`** ⇒ 否则 `not-bundle`；
3. `dsh.bundle.patch` 列出的每个文件**必须在包里存在**，否则
   `failed to read overlay <file>` ⇒ **整个安装回滚**（`package.json` + 锁文件都还原）；
4. `engines.dsh` 独断兼容（没有它才逐个查 peer 范围）⇒ 不满足则
   `incompatible-version`；
5. 记录 `manifest.version` ⇒ 列表里显示的版本；
6. 写 `dsh.profile.bundles` ⇒ **启用**。

### 6.3 ⚠️ 装完不会自动启用

客户端对**用户手输的 spec** 传 `enabled: false`（`manager-store.ts:1250`）
⇒ 宿主只在 `enabled !== false` 时才 `selectBundle`（`index.ts:990`）。

⇒ **必须点「立即启用」**（`PluginManagerPage.tsx:1488-1489`），
否则包在 `dependencies` 里却不在 `dsh.profile.bundles` 里 ⇒ 启动不加载 ⇒
桌面右栏不出现 Edge tab。

（只有「官方目录（catalog）」安装才带 `selection` ⇒ 自动启用。）

### 6.4 为什么 npm 通道不需要构建授权、也不需要 PATH 上有 pnpm

| | git 通道 | npm 通道 |
|---|---|---|
| 包里有构建脚本吗 | 有（`prepare`） | 无（tarball 里是构建好的 `lib/`） |
| pnpm 会不会注入 `<pm>-install` | **会**（`prepare` 非空 ⇒ 必走构建路径） | **不会** |
| 注入的脚本谁跑 | **shell** ⇒ 要在 PATH 上找到 `pnpm` | — |
| 宿主自己调 pnpm 用哪支 | 宿主自带的那支（`profile.packageManager`，见 `app-boot/src/profile-context.ts:17`「Packaged applications supply their bundled runtime instead of a PATH executable」） | 同一支 |

⇒ git 通道额外要求「PATH 上有 pnpm」，是因为 **pnpm 注入的 `pnpm install`
是用 shell 跑的**，而 App 自带的是 `pnpm.mjs`（不是 PATH 上的可执行命令）。
npm 通道根本不触发这次注入 ⇒ **用户机器上没装 pnpm 也能装**。

### 6.5 实装实测：npm 通道装到桌面 profile（2026-11-11 真跑，不是 dry-run）

在本机 desktop profile 上完整走了一遍 npm 通道：

```powershell
# 装前：按 PID 停 App（GUI + 宿主），避免 Windows 文件锁住要替换的插件目录
pnpm --dir "$env:USERPROFILE\.dsh\profiles\desktop" add "@dsh-edge/dsh-edge-agent@0.1.1"
# 装后：重启 App
```

`package.json` 的 `dependencies` 从 `file:...tar.gz` 变成 `"0.1.1"`；
`dsh.profile.bundles` 本来就含本包 ⇒ 不用动（不在列表里的话，启动不会加载它）。

**三个坑 —— 都是实测撞出来的，不是推测**

| # | 坑 | 实测现象 | 正确做法 |
|---|---|---|---|
| 1 | **`pnpm add <pkg>` 不带版本号，不会把已有的 `file:` / `git:` spec 换成 registry spec** | 连跑两遍（pnpm 12.16.1 与 11.28.5），`package.json` **原样不动**（连 mtime 都没变），只有锁文件重算了一遍 tarball 的 integrity | 必须写全版本：`pnpm add <pkg>@0.1.1`（pnpm 会打出 `dependencies: - … 0.1.1-desktop-safe / + … 0.1.1`）。GUI 自己装时是直接改清单的，不受这条影响 |
| 2 | **pnpm 的供应链策略（`minimumReleaseAge`）会给刚发布的版本自动加排除项** | pnpm 打印 `Added 1 entry to minimumReleaseAgeExclude in pnpm-workspace.yaml`，profile 的 `pnpm-workspace.yaml` 被写入 `minimumReleaseAgeExclude: ['@dsh-edge/dsh-edge-agent@0.1.1']` | 正常现象，不用管。若 profile 设了 `minimumReleaseAgeStrict: true`，这一步会变成提示 / 失败 |
| 3 | **GUI 装包一律先落 `enabled:false`** | `plugin-operations/operations.jsonl` 里是固定三段：`install`（`enabled:false`）→ `bundle/enable`（`enabled:true`）→ `restart-required` | 必须点「立即启用」（§6.3）。绕过 GUI 直接跑 pnpm 就不产生这段记录 —— 但包仍要出现在 `dsh.profile.bundles` 里才会被加载 |

**装后核验清单（每一条都机器可查）**

| 查什么 | 怎么看 | 2026-11-11 实测值 |
|---|---|---|
| 装的是 registry 版还是 tarball 版 | 插件目录 `package.json` 的 `version` | `0.1.1`（tarball 通道是 `0.1.1-desktop-safe`） |
| 文件全不全 | 数插件目录的文件数 | **238**（= registry `dist.fileCount`） |
| 内容对不对 | 与 `dist/installable/dsh-edge-agent-desktop-safe/` 逐文件 SHA256 | 236 个共有文件**全部一致**；只多 `README.md`/`LICENSE`；唯一差异是 `package.json#version` |
| 包里有没有活配置 | 插件目录 `config/` | 只有 `edge.example.json` + `privacy-policy.json`，**没有 `edge.json`** |
| 配置命中哪一档 | 审计链 `config.loaded` | `path=C:\Users\<你>\.dsh-edge-agent\edge.json`（顺位 1 不存在 ⇒ 命中顺位 2） |
| 本地池是不是直连 | 审计链 `llm.local.catalog` | `{"provider":"local-llm","model":"qwen3.8-flash","mode":"direct"}` |
| hook 数对不对 | 审计链 `input-guard.hook.registered` | 只有 3 个：`agent/pre-step` / `llm/stream` / `agent/request` |

## 7. 作者侧义务 —— 本仓逐条对照

宿主自己的说明在 `publish.md`（**是教程不是清单**）。按它 + 宿主源码的要求
逐条对本仓：

| 要求 | 出处 | 本仓 | 状态 |
|---|---|---|---|
| 包名合规（小写、≤214） | `install-spec.ts:32-33` | `@dsh-edge/dsh-edge-agent` | ✅ |
| `name` / `version` | `publish.md:36-44` | `0.1.2` | ✅ |
| `dsh.bundle.patch`（字符串或列表） | `publish.md:13,64` | `["./cordis.desktop-safe.patch.yml", "./presets/edge.desktop-safe.patch.yml"]` | ✅ |
| patch 文件**必须在包里** | `app-boot/src/index.ts:538-546` | 两个都在 `files` 白名单里 | ✅ |
| `engines.dsh` 声明 | `publish.md:66` | `">=0.2.1-rc.2"` | ✅ |
| 共享的 dsh 包同时进 peer + dev | `publish.md:105` | 8 个 `@deepseek-ai/*` 两边都有 | ✅ |
| **npm 发布时必须预构建 `lib/`** | `publish.md:169,185` | `prepare` = `compile` + `build:client` | ✅ |
| `files` 白名单 | `publish.md:41` | `lib` `config` `presets` 3 个 yml，且 `!config/edge.json` | ✅ |
| 包名可发（registry 上没被占） | npm | **已发布** —— 2026-11-11 上线 0.1.1，scope `@dsh-edge` 已归本仓账号 | ✅ |
| `CHANGELOG.md` 存在且**含当前版本** | `publish.yml` 前置清单第 3 条 | 已在 `files` 白名单里 | ✅ |

**这张表现在是机器检查的** —— §7.172 加了 `scripts/verify-npm-publish.mjs`，
把上表里**能离线机器判定**的那 11 条逐条变成断言，已接进 `verify:build` 链
（`verify:npm-publish`，链内第 25 位）：

> 「包名可发」那一行查的是 **registry 的实时状态**，离线判不了（脚本全程不联网），
> 所以它不在断言里 —— 但它**不是可选项**：第一次发布之前它就是 ❌。

```bash
node scripts/verify-npm-publish.mjs             # 查当前树
node scripts/verify-npm-publish.mjs --selftest  # 自证 + 反向证伪（27 条断言）
```

⇒ **发布前不必再靠人肉对表**；漏了哪条，门禁会指名道姓地报出来。

**`prepare` 只对 git 安装有意义**（`publish.md:171`）—— npm 装的时候 tarball 里
已经是构建好的 `lib/`，pnpm 不会跑 `prepare`。

### 7.1 包里有什么（`npm pack --dry-run` 实测：238 文件 / 37 个 `exports` 入口，2026-11-11）

```
lib/            ← Node 半侧（.js + .d.ts）+ 浏览器半侧 lib/client.js
config/         ← edge.example.json + privacy-policy.json（**没有 edge.json**）
presets/
cordis.yml / cordis.patch.yml / cordis.desktop-safe.patch.yml
package.json / README.md / LICENSE / CHANGELOG.md
```

> **238 = registry 上 0.1.1 的 `dist.fileCount`** —— 逐条对得上。
> 比 `dist/installable/` 多的两个文件是 `README.md` 与 `LICENSE`：**npm 自动带，
> 不靠 `files` 白名单**（`verify-npm-publish.mjs` 的 `isCoveredByFiles()` 把
> `readme*` / `license*` 列为「永远进包」）。

> `CHANGELOG.md` 是 §7.172 补进 `files` 的 —— npm **不会**自动带它（npm 只自动带
> package.json / README / LICENSE），而 `publish.yml` 的前置清单明写「CHANGELOG.md is
> updated」，且 npm 页面会渲染它。不显式加进 `files` ⇒ 门禁 `verify:npm-publish` 报
> 「CHANGELOG 不在包里」。

`files` 白名单在 npm 通道同样生效：`src/`、`scripts/`、`tests/`、`.git/` 都不进包。

> **✅ 0.1.2 起已修：清单不再声明不在包里的东西。**
> 0.1.1 发布出去的 `package.json` 带着仓库根清单的 `scripts.*`（50 余条）和一整套
> `devDependencies`，而它们指向的 `scripts/`、`src/`、`tests/` **不在 tarball 里**
> ⇒ 清单声称了并不存在的东西（对消费者无害：registry 安装**不会**触发 `prepare`，
> 包里也没有 `postinstall`）。
> 现在发布走一个**消毒过的暂存目录** `dist/.npm-stage/`：内容 = safe 变体 +
> README + LICENSE，清单 = 去掉 `scripts` / `devDependencies` / `packageManager` 的那份。
> **出货文件逐个不变**（仍是 238 个），只有清单瘦了 —— 由 `verify:npm-stage` 门禁守着。

## 8. 发布链（CI）

### 8.1 触发

| 文件 | 触发 | 作用 |
|---|---|---|
| `ci.yml` | push main / PR | 只检查，不发布 |
| `publish.yml` | **推 `v*` tag** | 检查 + `pnpm publish`（**按决策**带/不带 provenance；该版本已发则跳过 publish）+ GitHub Release |
| `upstream-latest.yml` | 每周一 03:17 UTC + 手动 | 探测上游 `@latest` 会不会打破兼容（**有意的，不是发布闸**） |

**推 tag 就是全部动作**：

```bash
git push origin main
git tag v0.1.1
git push origin v0.1.1     # ← 这一步才触发 publish.yml
```

顺序不能反 —— `publish.yml` 检出的是**那个 tag 指向的 commit**。

> ⚠️ **CI 红不拦 push**。CI 是 push **之后**才跑的，代码已经上去了
> （§7.154 记过：2026-09-20 起每次 push 到 main 都红，连续 9 天没人被拦）。
> ⇒ **push 前在本地跑 `npm run build`**（它含门禁），这是唯一的「事前」窗口。

### 8.1.1 本地发布路径（§7.172 新增，第一次发布走这条）

CI 那条链是「代码上去了之后才跑」的 —— 而 npm 这条链**在 2026-11-11 才第一次被走通**
（此前本仓 0 个 tag、registry 上查无此包）。第一次发布不该拿 CI 当试验品，所以给了一条
**发布前**的本地路径（**这条路径已经真跑通过一次**，见 §8.1.2）：

```bash
npm run publish:npm                    # 构建 + 全部门禁 + dry-run（安全默认，不发）
npm run publish:npm -- --yes           # 真发
npm run publish:npm -- --yes --tag     # 发完打 v<version> tag（再 git push origin v<version>）
```

它按顺序做 5 件事：

1. **工作树必须干净**（`--allow-dirty` 可强行越过）—— 发出去的必须是 git 里有的东西；
2. **registry 预检**：这个版本发过没有？发过 ⇒ 立刻停（不浪费一次构建 + 门禁）；
3. **认证预检**（仅真发时）：`NPM_TOKEN` / `NODE_AUTH_TOKEN` / `~/.npmrc` / 仓库
   `.npmrc` 里有没有 token？**没有就立刻停**（实测 3 秒）—— 不能等构建链 + 31 道
   门禁跑完才在 `pnpm publish` 那一步才发现没登录。
   ⚠️ **两种 token 行都要认**（§7.185 实测踩过）：`npm login --auth-type=web` 写进
   `~/.npmrc` 的是**带 registry 前缀**的 `//registry.npmjs.org/:_authToken=…`；只认
   不带前缀的 `_authToken=` 会给出**假阴性**（明明 `npm whoami` 有身份、token 也在，
   预检却报「没找到凭据」）。自证：`npm run publish:npm -- --selftest`；
4. **canonical 构建链**（`compile → typecheck:client → build:client → build:installable
   → pack:tarball → stage:npm`）—— 与 CI **一字不差**；
5. **全部门禁**（`verify:build`，**31 项**，验的是**产物**）；
6. **`pnpm publish --dry-run`** —— **默认不发**，只把「将要发出去的东西」摊开给你看。

⇒ **不带 `--yes` 永远不会碰 registry。** 这是这个脚本的默认值，也是它能被信任的原因。

**两条路径可以共存且幂等**：本地 `--yes --tag` 发完再推 tag ⇒ CI 的 publish job 看到
「该版本已在 registry 上」⇒ **跳过 publish**（不撞 409），但 release job 仍会建
GitHub Release。这正是 `publish-decision.mjs` 的 `skip` 决策存在的原因。

本地与 CI 跑的是**同一条命令**：

```
pnpm publish --access public --ignore-scripts --no-git-checks [--provenance|--no-provenance]
```

**⚠️ 0.1.2 起，这一条命令在 `dist/.npm-stage/` 里跑**（本地与 CI 同一目录）：
那个目录里摆的是「真正要发给 registry 的那个包」—— 内容 = safe 变体 + README +
LICENSE，清单 = **去掉 `scripts` / `devDependencies` / `packageManager`** 的那份
（0.1.1 的毛病：清单声明了 50 余条脚本和一整套 devDeps，而它们指向的文件根本不在
tarball 里）。暂存目录由构建链里的 `stage:npm` 产出，由 `verify:npm-stage` 门禁守着
（出货文件必须**逐个等于**「变体目录 + README + LICENSE」）。

- `--no-git-checks`：CI 在 tag push 时**必然**是 detached HEAD（`actions/checkout`
  检出的是 tag）⇒ pnpm 的 git 检查会直接报 `ERR_PNPM_GIT_UNKNOWN_BRANCH`
  （**实测**，见 §8.2）。绕开之后，这道检查由本地脚本自己接住（0.1 工作树干净 /
  0.2 HEAD 必须 attached）。
- `--ignore-scripts`：让 `prepare` 不要在发布步里**重跑一遍** compile+build:client ——
  Build 步产出的 `lib/` 已经过了 `verify:build`，发出去的应该是**门禁验过的那个**。

### 8.1.2 「publish 报成功」≠「包已经能装」（staged publishing，2026-11-11 实测）

第一次真发布（0.1.1）实测：`pnpm publish` 打印
`✅ Published package @dsh-edge/dsh-edge-agent@0.1.1`、退出码 0 —— 但**那一刻
registry 上还装不了这个包**：

| 探针 | 刚发完 | 约 6 分钟后 |
|---|---|---|
| `npm view <pkg> version` | **404** | `0.1.1` |
| packument `GET /@dsh-edge%2fdsh-edge-agent` | **404** | **200**，`versions = 0.0.0-stage, 0.1.1` |
| `GET /-/package/<pkg>/dist-tags` | `{"latest":"0.1.1"}` | 同左 |
| `GET /<pkg>/0.1.1`（版本文档） | **200**（fileCount 238） | 同左 |
| `npm access list packages dsh-edge` | `@dsh-edge/dsh-edge-agent: read-write` | 同左 |

⇒ npm 现在把**「用 bypass-2FA token 直接发布」也收进了分级发布（staged publishing）**：
包名先被占位版 `0.0.0-stage` 占住（占位 tarball 的 package.json 直说
`"stub": true, "description": "Temporary package placeholder for staged publishing"`），
真实版本进待批队列。**这次是自动放行**（约 6 分钟）；也可能需要人在 npmjs.com 的
**Staged Packages** 页点 Approve，或 `npm stage approve <stage-id>`（要求 npm ≥ 11.15，
且仍需一次 2FA 挑战 —— TOTP 已被 npm 移除 ⇒ 本机 CLI 这条路走不通，浏览器才可行）。

**判据**（§7.193 实测更正，**唯一正确的一条**）：**看 `versions` 里有没有出现新版本**
—— `npm view <pkg> version` 与 `dist-tags.latest` 在放行前返回的都是**上一个真实版本**
（发 0.1.2 时是 `0.1.1`），拿它们当判据会**误判成「已上线」**。`versions` 里留着
`0.0.0-stage` 是**正常的占位残留**，不用管它。

```bash
npm view @dsh-edge/dsh-edge-agent versions --json
# ⇒ 数组里出现新版本号 ⇒ 已上线
```

> **⚠️ 第二次发布同样会被 staged（0.1.2 实测）**：发 0.1.2 时 `pnpm publish` 同样打印
> `✅ Published`、退出码 0，而那一刻 `npm view` 仍返回 **`0.1.1`**（上一个真实版本），
> `versions` 里**还没有** `0.1.2`；约 5 分钟后才变成
> `versions = 0.0.0-stage, 0.1.1, 0.1.2` / `latest = 0.1.2`。
> ⇒ **推 tag 之前先确认新版本已经在 `versions` 里** —— 否则 CI 的 publish job 会以为
> 「该版本还没发过」而真去发一遍，撞 409。
>
> 这条判据已经**写进门禁**：`npm run verify:npm-readiness -- --online` 会把
> `versions` / `latest` /「当前版本是否已在 versions 里」一起打出来，并在未上线时
> 显式提醒别推 tag（§8.5 第 25 行）。

### 8.1.3 「已经发过了」在 CI 侧怎么算成功（§7.202，2026-11-12）

上面那条「推 tag 前先确认 `versions` 里看得见」在**本机发布路径**里其实很难做到：
`npm run publish:npm -- --yes --tag` 是**发完立刻推 tag** 的，而 registry 的读路径
要过 **~91 秒**才追上（实测：15:26:35 发布成功 → 15:28:06 `versions` 里才出现
0.1.4）⇒ 等也是等，等完还是**赛跑**。

⇒ 修在 CI 侧（两道防线，都在 `publish.yml`）：

| 防线 | 做什么 | 为什么 |
|---|---|---|
| ① 判定步等窗口 | `scripts/publish-decision.mjs --wait-seconds 180`：「包存在、但这一版还不在 `versions` 里」时最多等 3 分钟（每 15 秒重查） | 「包存在但这一版不在」正是传播延迟的 signature；**首次发布**（包压根不存在）不等 |
| ② 409 当成功 | publish 步捕获 `EPUBLISHCONFLICT` / `cannot publish over the previously published versions` ⇒ 视为成功（`::notice::`） | 「这一版已经在 registry 上」就是**这一版的目标状态** —— 撞它不该把一次成功的发版涂红 |

**别的错误仍然让 job 红**（401/403 = CI 没有 npm 凭据，等等），并发 `::error::`
注解说明是什么问题 —— 注解**公开可读**（匿名 `GET /repos/{owner}/{repo}/check-runs/{id}/annotations`
就能取），不必登录也能定位失败。

这两条都有门禁盯着（`scripts/verify-ci-build-chain.mjs` 的两项检查 + 9 条自证断言）。

> ⚠️ **CI 的 npm 面仍然需要凭据**：在主人挂上 trusted publisher（或给仓库加
> `NPM_TOKEN` secret）之前，**npm 面只能靠本机路径**；`release`（git）面不依赖它。

官方文档：[Staged publishing for npm packages](https://docs.npmjs.com/staged-publishing)。

### 8.2 环节与报错对照

| 环节 | 报错首行 | 含义 / 怎么办 |
|---|---|---|
| `pnpm install --frozen-lockfile` | `ERR_PNPM_OUTDATED_LOCKFILE` — `Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date with <ROOT>/package.json` | 改了 `package.json` 没更新锁文件 |
| 同上 | `ERR_PNPM_FROZEN_LOCKFILE_WITH_OUTDATED_LOCKFILE` | 锁文件格式跨了 pnpm 大版本 |
| Build 步（tsc） | `error TSxxxx: ...` | TypeScript 编译错误 |
| Build 步（esbuild） | esbuild 报错 | 浏览器半侧打不出来 |
| `verify:build` → `verify:package` | `Error: package exports missing from tarball: lib/client.js` | **实测复现**（§7.156 修的就是这个） |
| `verify:build` → `verify:installable` | `installable dir not found: dist/installable` + `(run \`make installable\` or \`npm run build\` first)` | **实测复现** |
| `verify:build` → `verify:ci-build-chain` | `verify-ci-build-chain: CI build chain is not sound:` + 逐条 `- ...` | CI 少跑了构建步骤 |
| `pnpm test -- --run` | vitest 失败摘要 | 单测红 |
| tag 版本一致性 | `::error::tag v0.1.2 does not match package.json#version 0.1.1` | tag 与 manifest 版本不一致 |
| CHANGELOG 缺版本（§7.172） | `::error::CHANGELOG.md has no entry for version 0.1.1` | `publish.yml` 的前置清单第 3 条 |
| `pnpm publish`（无 token） | `You must be logged in to publish packages.` | `NPM_TOKEN` secret 没配/失效 |
| `pnpm publish`（无权限） | `403 Forbidden - PUT https://registry.npmjs.org/... - You do not have permission to publish` | scope 没建好 / 名字被占 |
| `pnpm publish`（版本已存在） | `409 Conflict - PUT ... - Cannot publish over the previously published versions: 0.1.1` | 改版本号再发 |
| `pnpm publish`（**CI，detached HEAD**） | `Error: ERR_PNPM_GIT_UNKNOWN_BRANCH` + `× The Git HEAD may not attached to any branch, but your "publish-branch" is set to "master|main"` | **实测（2026-11-10）**：CI 在 tag push 时必然 detached HEAD ⇒ 必须加 `--no-git-checks`（§7.172） |
| `pnpm publish`（**首次发布带 provenance**） | pnpm 的 provenance 生成器抛错（registry 答 `{"public":false}`） | 首次发布**不能**带 `--provenance` ⇒ 由 `publish-decision.mjs` 判定（§8.5.1） |
| `pnpm publish`（**报成功但装不了**） | **无报错**（退出码 0）⇒ 但 `versions` 里还没有新版本（`npm view <pkg> version` 仍返回**上一个真实版本**，不是占位版） | npm 的 **staged publishing**：真实版本在待批队列，要等放行（或在 npmjs.com 的 Staged Packages 页点 Approve）—— 判据见 §8.1.2 |
| `pnpm publish`（Windows 上跑不起来） | `退出码 null（进程没起来）` | `pnpm`/`npm` 在 Windows 上是 `.cmd` shim，Node 20.12+ 拒绝 spawn ⇒ 要按裸名走 shell（§8.1.1） |

> §7.172 起，**「版本已存在」在 CI 上不再是一个错误**：publish job 会先看 registry，
> 发现该版本已发 ⇒ **跳过 publish**（不撞 409），release job 照常建 GitHub Release。
> 本地脚本则在**预检阶段**就停下来（不浪费一次构建 + 门禁）。

### 8.3 §7.156 修的那个洞（发布链从来没走通过）

`publish.yml` 的 build 步原来写的是 `pnpm run compile`。而：

- `compile` = `clean-lib` + `tsc`，`clean-lib` 把**整个 `lib/` 删掉**重建服务端那一半
  ⇒ 浏览器半侧 `lib/client.js`（esbuild 产物）没了；
- 全新 checkout 里**没有 `dist/`** ⇒ `dist/installable/` 也没了。

而 `verify:build` 里的 `verify:package` 硬读 `lib/client.js`、
`verify:installable` 硬读 `dist/installable/` ⇒ **必红**：

```
Error: package exports missing from tarball: lib/client.js
installable dir not found: dist/installable
```

⇒ **发布 job 死在 Verify 步，从来没走到过 `pnpm publish`**。没人发现，
因为这个仓库**从来没有推过 `v*` tag**（本仓至今 0 个 tag）。

修法：build 步改成与 `ci.yml`、与 `package.json#scripts.build` **一字不差**的链：

```yaml
- name: Build (compile → browser half → installable bundle)
  run: node scripts/run.mjs compile typecheck:client build:client build:installable
```

### 8.4 门禁：谁在守这条链

`scripts/verify-ci-build-chain.mjs`（§7.154 建、§7.156 扩）：

- 检查 **`ci.yml` 的 `build` job 和 `publish.yml` 的 `npm` job** 都跑全了
  `compile` / `build:client` / `build:installable`；
- 检查这两条链与 `package.json#scripts.build` **不漂移**；
- 检查链里引用的脚本在 `package.json#scripts` 里都存在。

```bash
node scripts/verify-ci-build-chain.mjs             # 查当前树
node scripts/verify-ci-build-chain.mjs --selftest  # 自证 + 反向证伪（11 项断言）
```

自证里包含**反向证伪**：把「只跑 `compile`」这个 §7.104 的缺陷造出来，
门禁必须报出 `build:client` 与 `build:installable` 两项；造回完整链，门禁必须放过。

**§7.172 加了两道门禁** —— `verify:npm-publish` 守的不是「构建链」，而是
**发布前的作者义务**（§7 那张表）：包名合规、semver、`publishConfig.access=public`、
`dsh.bundle.patch` 列出的文件既存在又在 `files` 里、`engines.dsh`、peer ⊆ dev、
`repository.url` 与 git remote 对得上、`CHANGELOG.md` 存在且含当前版本且在 `files` 里、
`config/edge.json` 确实被排除、`prepare` 跑的是 compile+build:client、`main`+`types`
确实在包里。

它已接进 `package.json#scripts.verify:build`（`verify:npm-publish`，链内第 25 位）
⇒ **CI 每次 push 都会跑它** ⇒
「漏了哪条发布义务」在合并前就被拦下，而不是等到推了 tag 才炸。

**§7.172 还加了第二道门禁** `verify:npm-decision`（链内第 26 位）—— 它守的是
**发布决策本身**。理由很硬：`registry-version.mjs` 与 `publish-decision.mjs`
**只在 CI 的 publish job 里跑**（`publish.yml` 的 Decide 步）⇒ build job 里的任何
门禁都够不着它们 ⇒ 一旦判错方向：

- 该带不带 `--provenance` 判错 ⇒ pnpm 的 provenance 生成器抛错 ⇒ **整个发布失败**；
- stdout 的 `key=value` 契约破了 ⇒ `$GITHUB_OUTPUT` 解析失败 ⇒ job 在一个跟发布
  毫无关系的地方红掉。

⇒ 两段代码各自带 `--selftest`（判定表 10 条断言 / stdout 契约 14 条断言），
`verify:npm-decision` 把它们**都跑一遍**（不联网：判定表用注入的假探针，stdout
契约用连不上的端口）⇒ 在**每一次 push** 上就能发现它们坏了，而不是等到推 tag。

### 8.5 真正发布成功需要哪些条件（逐条核对，2026-11-10 核实；2026-11-11 发布实况回填）

| # | 条件 | 状态 | 备注 |
|---|---|---|---|
| 1 | npmjs.com 账号 + 组织 `dsh-edge` | ✅ **已建**（2026-11-11 实测 `/-/org/dsh-edge/package` → HTTP 200） | 账号 `chschytzmcy`，是该组织成员（角色含 publish）；逐步操作见 [`npm-account-setup.md`](npm-account-setup.md) |
| 2 | scope `@dsh-edge` 可用 | ✅ **已由我们自己占用** | 2026-11-11 首次发布时创建（`npm access list packages dsh-edge` → `@dsh-edge/dsh-edge-agent: read-write`） |
| 3 | 认证：`NPM_TOKEN`（**granular access token**，publish 权限、Bypass 2FA、≤90 天） | ✅ **已在用** | `~/.npmrc` 里是 granular token（`//registry.npmjs.org/:_authToken=…`）；`npm profile get` 返 **403**（token 只授权了这个 scope，符合预期）。**classic token 已于 2025-12 被 npm 撤销**，只能用 granular |
| 3′ | 或 OIDC **Trusted Publishing**（不要 token） | ✅ **可用** | **pnpm 11.7.0 自己实现了 OIDC 交换**（`crates/publish/src/oidc/*`）⇒ **不需要 npm CLI ≥ 11.5.1**，也**不需要升 Node**（CI 是 Node 22.20 + pnpm 11.7.0）。**§7.172 修正了旧结论** |
| 4 | `publishConfig.access: "public"` | ✅ | scoped 包默认 restricted，必须显式 public |
| 5 | `repository.url` 与发布位置**精确匹配**（大小写敏感） | ✅ | **§7.156 已从 SSH 形式改成 `https://github.com/chschytzmcy/dsh-edge-agent.git`** |
| 6 | `permissions: id-token: write` | ✅ | workflow 里已有 |
| 7 | 云托管 runner | ✅ | `ubuntu-latest`（自托管 runner 不满足 provenance 要求） |
| 8 | **仓库公开**（provenance 的前提） | ✅ **已转公开**（2026-11-10） | 主人把仓库改成了 public；匿名 GitHub API 核实 `visibility = public` |
| 9 | 包本身 public | ✅ | `--access public` |
| 10 | `lib/` 预构建 | ✅ | §8.3 修的就是这个 |
| 11 | `files` 白名单 | ✅ | 238 文件 / 37 个 `exports` 入口（2026-11-11 实测） |
| 12 | `dsh.bundle.patch` 列出的文件在包里 | ✅ | 两个 patch 都在白名单里 |
| 13 | `engines.dsh` 声明 | ✅ | `>=0.2.1-rc.2` |
| 14 | 版本未被占用 | ✅ **0.1.2 已发布**（2026-11-11） | 下一版必须改 `package.json#version`（同一版本不能重发）；tag `v0.1.2` 已推 origin |
| 15 | tag ↔ `package.json#version` 一致 | ✅ | §7.156 加了断言 |
| 16 | 真密钥不在包里 | ✅ | `.npmignore` + `files` **双重**排除 `config/edge.json` |
| 17 | `CHANGELOG.md` 存在 + 含当前版本 + 在 `files` 里 | ✅ | §7.172 补的（npm **不会**自动带它） |
| 18 | pnpm 的 git 检查不挡路 | ✅ | §7.172：CI 在 tag push 时是 detached HEAD ⇒ 必须 `--no-git-checks`（**实测**） |
| 19 | 首次发布**不带** `--provenance` | ✅ | §7.172：`decideProvenance` 判定（实测 visibility 端点答 200 `{"public":false}`） |
| 20 | 发布就绪门禁 | ✅ | §7.172：`verify:npm-publish`（链内第 25 位） |
| 21 | 发布决策门禁 | ✅ | §7.172：`verify:npm-decision`（链内第 26 位）—— 判定表 + stdout 契约的自证 |
| 22 | 包名一致性门禁 | ✅ | §7.173：`verify:package-name`（链内第 24 位）—— 包名副本与 `package.json#name` 交叉比对 |
| 23 | **发布清单不含不在包里的东西** | ✅ | §7.188：`stage:npm` 暂存目录 + `verify:npm-stage`（链内第 27 位）—— 清单里不得有 `scripts` / `devDependencies` / `packageManager` |
| 24 | **`--provenance` 只在受支持的 CI 里带** | ✅ | §7.188：pnpm 的 provenance 生成器**只在 CI 里**能工作 ⇒ 本机一律 `--no-provenance`（实测 `ERR_PNPM_PROVENANCE_UNSUPPORTED_PROVIDER`） |
| 25 | **发布前置条件有门禁守着** | ✅ | §7.193：`verify:npm-readiness`（链内第 28 位）—— 9 项静态断言（OIDC 前提 / 发布路径形状 / tag↔version）+ token 字面量扫描 + **人工核对清单**（2FA 与 trusted publisher 机器查不了，如实报「查不了」而非假装查过） |

⇒ **原来的两件（2026-11-10 的待办）在 2026-11-11 都已落地**（组织建好、token 在位、
`0.1.1` / `0.1.2` 已发布，见 §8.1.2）。**现在剩下的是这两件新的主人手上的事
（顺序不能反）**：

1. **先开账号 2FA**（浏览器：npmjs.com/settings/two-factor-auth）——
   npm 已移除 TOTP 注册通道 ⇒ 只能挂 WebAuthn 安全密钥（Windows Hello 的 PIN /
   指纹 / 人脸即可）。**这一步是第 2 步的前置**：npm 官方 `npm trust` 文档写明 trusted
   publisher 要求账号级 2FA，且不接受勾了 bypass 的 granular token。
2. **再登记 trusted publisher**（浏览器：包页面 → Settings → Trusted Publisher）——
   `dsh-edge` / `chschytzmcy/dsh-edge-agent` / `publish.yml`，**并勾上「npm publish」**
   （2026-09-03 后新建的连接默认只允许 staged publish）。**不做 ⇒ 2027-01 起 CI 发不了**
   （token 直发被移除）；**配完 48 小时内要推一次 tag**，否则配置作废。

详见 [`npm-account-setup.md`](npm-account-setup.md) §5（2FA）、§8（trusted publisher）、
§12（这两件为什么机器查不了、门禁怎么提醒）。

下面是 2026-11-10 的裁决与当时的待办（**均已完成**，留档）：

1. ✅ **在 npmjs.com 建一个叫 `dsh-edge` 的组织**，并把主人自己的
   npm 账号加为**成员**（角色需含 publish）。
   ⇒ **口径（2026-11-10 裁决）**：走**组织**，不走同名的「机器人式」用户账号 ——
   对外的 scope 名不变、凭据是主人本人的、还能邀请别人一起发。
   npm 的规则是「scope 由同名用户**或**同名组织拥有」，而**发包的人不必是那个
   名字**（官方原文）：

   > If publishing a public module to an organization scope, you must first either
   > create an organization with the name of the scope that you'd like to publish to
   > **or be added to an existing organization** with the appropriate permissions.

   （名字可用性当时已查实：registry 上**无同名组织**、该 scope 下**无任何包**。）
2. ✅ **发布凭据** —— 首次发布用 granular access token（见 §8.5.2），发完之后登记
   trusted publisher（Owner 填这个组织）改走 OIDC。**trusted publisher 还没登记**（见本节开头）。

拿到之后，本地发一次就够（**不用改任何代码** —— 包名/对外标识一个字都不动）：

```bash
npm login --scope=@dsh-edge   # 用主人自己的账号；scope 钉到组织
npm run publish:npm -- --yes --tag
git push origin v0.1.1         # 触发 CI；它会看到版本已发 ⇒ 跳过 publish，只建 Release
```

> **2026-11-11 就是这三条走通的**（`0.1.1` 已上线，tag `v0.1.1` 已推）。

> **为什么组织方案不需要改任何代码**：scope 仍是 `@dsh-edge`
> ⇒ `package.json#name`、patch 行、preset、文档、门禁里那 **181 处 / 45 个文件**
> 的字符串**全部不动**（§7.172 实测的分布）。**换 scope** 才会牵动那 45 个文件，
> 其中 84 处是宿主在运行时解析的 patch 行（漏改 ⇒ 插件挂不上 ⇒ Edge tab 静默消失），
> 外加两个门禁各自硬编码了一份包名。⇒ 走组织 = **零改动**。

#### 8.5.1 provenance 的那条硬约束（最容易踩的一脚）

npm 的溯源徽章（`Built and signed on GitHub Actions`）**只接受公共来源仓库**。
pnpm 自己的判定分**两步**（pnpm 11 的实现是 Rust：`crates/publish/src/oidc/provenance.rs`）：

```js
// ① 先解 OIDC token 的 payload
if ((!GITHUB_ACTIONS || payload.repository_visibility !== "public") && ...)
  throw new ProvenanceInsufficientInformationError()
//    "The environment does not provide enough information to determine visibility"

// ② 再问 registry：这个包本身是不是 public
GET /-/package/<name>/visibility   →  必须是 { public: true }
```

⇒ **仓库是私有的 ⇒ 第①步就抛错 ⇒ 整个发布失败**，报的是
`ProvenanceInsufficientInformationError`；npm 侧的对应错误是
`npm error 422 Unprocessable Entity / Error verifying sigstore provenance bundle:
Unsupported GitHub Actions source repository visibility: "private"`。

**§7.156 的处理**：不写死 `--provenance`，而是**按仓库可见性自动决定**。但它只
处理了第①步 —— 第②步当时只能靠猜，于是 §7.172 把它补上了。

#### 8.5.1.1 第②步的真实形态：**不是 404，是 200 + `{"public":false}`**

**实测（2026-11-10，匿名请求 `registry.npmjs.org`）**：

| 目标 | HTTP | body |
|---|---|---|
| `@dsh-edge/dsh-edge-agent`（**尚不存在**）| **200** | `{"public":false}` |
| `@deepseek-ai/cordis`（已存在的公开包）| 200 | `{"public":true}` |

> ⚠️ **本节此前写的是「包不存在时端点返回 404」—— 猜错了形态**。真实形态是
> **HTTP 200 + `{"public":false}`**（包还不存在，自然不是 public）。**结论一样**
> （首次发布带 `--provenance` 必失败），但错误类型不同：不是
> `ProvenanceFailedToFetchVisibilityError`，而是 pnpm 认为「这包不是 public，
> 不给它做 provenance」而抛错。

⇒ **首次发布不能带 `--provenance`**（哪怕仓库已经是 public）。发完之后
（必要时 `pnpm access set status=public @scope/pkg`），registry 才会答
`{"public":true}`，之后的版本才带得上徽章。

**§7.172 的处理**：把两个决策都从 workflow 的 YAML 里挪进一个**可测的脚本**
（`scripts/publish-decision.mjs`）—— stdout 只有 `key=value`（给 `$GITHUB_OUTPUT`），
人类可读的判断走 stderr（留在 CI 日志里）：

```yaml
- name: Decide (skip if published / provenance)
  id: decide
  env:
    REPOSITORY_VISIBILITY: ${{ github.event.repository.visibility }}
  run: node scripts/publish-decision.mjs >> "$GITHUB_OUTPUT"

- name: Publish
  if: steps.decide.outputs.skip != 'true'
  env:
    NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
  run: |
    if [ "${{ steps.decide.outputs.provenance }}" = "true" ]; then
      pnpm publish --provenance --access public --ignore-scripts --no-git-checks
    else
      pnpm publish --no-provenance --access public --ignore-scripts --no-git-checks
    fi
```

判定表（`decideProvenance` 的实现，`scripts/registry-version.mjs`）：

| 仓库可见性 | 包在 registry 上 | 结论 |
|---|---|---|
| 私有 | 任意 | ❌ 不带（① 就抛错）|
| 公开 | **还不存在** | ❌ 不带（② 答 `{"public":false}`）—— **首次发布** |
| 公开 | 存在且 public | ✅ 带 |
| 公开 | 存在但不是 public | ❌ 不带 |
| 任意 | 查不到（网络失败）| ❌ 不带（宁可少一个徽章，也不让整个发布失败）|

⇒ **仓库从私有转公开之后，同一份 workflow 自动升级成带徽章的，不用再改**；
取不到可见性 / registry 时默认走「不带」那支 ⇒ 少一个徽章好过整个发布挂掉。

#### 8.5.2 认证方式怎么选

| 方式 | 需要什么 | 代价 |
|---|---|---|
| **granular access token** | npmjs.com → Settings → Access Tokens → 新建，勾 publish、勾 Bypass 2FA、有效期 ≤90 天、scope 限定到本包 ⇒ 存成 GitHub secret `NPM_TOKEN`（或本地 `npm login`） | 要定期轮换（90 天） |
| **OIDC Trusted Publishing** | npmjs.com 上给本包登记 trusted publisher（Owner / Repository / Workflow 文件名 `publish.yml`，**大小写敏感**）⇒ **完全不需要 token** | **pnpm 11.7.0 自己就能做**（`crates/publish/src/oidc/*`）⇒ **不需要 npm CLI ≥ 11.5.1，也不需要升 Node**。**§7.172 修正了旧结论** |

⇒ **建议先走 granular token**（一次发布就能验证整条链）；**之后**再登记 trusted
publisher 换成 OIDC，把 token 从仓库里彻底拿掉。

> **§7.172 修正的旧结论**：本节此前写的是「OIDC 需 npm CLI ≥ 11.5.1 ⇒ Node 24 ⇒
> 本仓 CI 用 Node 22.20 ⇒ 用不了」。这条对 **`npm publish`** 成立，但**对 pnpm 不成立**
> —— workflow 里跑的是 `pnpm publish`，而 pnpm 11.7.0 的二进制里内建了 OIDC 交换
> （`ACTIONS_ID_TOKEN_REQUEST_URL` / `ACTIONS_ID_TOKEN_REQUEST_TOKEN` /
> `npm.pkg.github.com` / `trusted publish`）。⇒ 「要升 Node」这条额外改动**不需要做**。

> npm 2025-12 起撤销了全部 classic token。旧的 `NPM_TOKEN`（classic）现在一律无效。

#### 8.5.3 组织 scope 下的 token 怎么签（2026-11-10 查实，方案 B 专用）

npm 的 token 表单有**两处容易选错**：

| 表单栏目 | 管什么 | 能不能用来发本包的版 |
|---|---|---|
| **「Select packages and scopes」** | 包/作用域的读读写权限 | ✅ **走这里** —— 选中本组织下的 `@dsh-edge` |
| **「Organizations」** | **组织成员/团队**的增删改 | ❌ **不能用它发包**（那是治理权限，不是发布权限）|

- token 的权限**不能超过签发者本人的权限** ⇒ 主人不在组织里、或组织角色不含
  publish ⇒ token 一样发不了。⇒ **先把主人自己的账号加进组织、给 publish 角色**。
- 首次发布需要 **Read and write** + **Bypass 2FA**（CI 发布要跳过交互式 2FA），
  有效期 **≤90 天**（read-write token 的上限）。
- 每个账号最多 1000 个 granular token；每个 token 最多覆盖 50 个包 / 50 个 scope。

> ⚠️ **npm 正在退场「用 token 直接发版」这条**（2026-11-10 查实，官方文档原文）：
> 「Bypass-2FA tokens with direct-publish access are being deprecated. The ability to
> publish new package versions directly with a granular access token **will be
> removed in January 2027**」，替代路径是 **Read and write (stage only)** +
> `npm stage publish` / `npm stage approve` 的**人工审批流**。
>
> ⇒ **所以 token 只是「第一次发布」的过桥**：发完立刻登记 trusted publisher 走 OIDC
> —— 之后既没有凭据要轮换，也不受这条退场影响。本仓 CI 已经支持 OIDC
> （pnpm 11.7.0 内建交换，§8.5.2），**不需要为 2027 改任何代码**。

## 9. 排障

| 症状 | 看哪里 | 常见原因 |
|---|---|---|
| 预检就说「没有这个包」 | `pnpm view <spec> name version description dsh --json` 手跑一遍 | 包没发布 / registry 不对 / 网络到不了 registry |
| 预检说「这个包没有声明组合包」 | `pnpm view <spec> dsh --json` | `dsh.bundle` 缺失，或**没有 `patch`** |
| 装完说「failed to read overlay」 | tarball 里有没有那两个 patch 文件 | `files` 白名单漏了 |
| 装完说「版本不兼容」 | `engines.dsh` vs 宿主版本 | 范围太窄 |
| 装完桌面右栏没有 Edge tab | `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` | **没点「立即启用」**（§6.3） |
| 配置读不到 / 云端 401 | `~/.dsh-edge-agent/audit/audit.plain.jsonl` 的 `config.loaded` | npm 装法同样**没有** `config/edge.json` ⇒ 要写 `~/.dsh-edge-agent/edge.json`（顺位 2）或插件目录里那份（顺位 1）（§4） |
| `pnpm add` 之后依赖 spec 还是 `file:` / `git:` | `~/.dsh/profiles/<prof>/package.json` 的 `dependencies` | **不带版本号不会换 source**（§6.5 坑 1）⇒ 写 `pnpm add <pkg>@<version>` |
| Edge tab 出来了，但「意图判定」长时间「进行中…」 | 审计链 `config.loaded` 的 `path` | **没配置文件** ⇒ 两池都 DELEGATE ⇒ 内部阶段打宿主模型（§9.2） |

### 9.1 配置落位（与 git 通道一致）

`config/edge.json` 含明文 API key，**不入库、不进包** ⇒ npm 装出来的包里也没有它。

运行时查找顺序（`src/dsh-adapter/edge-config.ts`，§7.182 后**只有两档**）：

1. `<bundle root>/config/edge.json` — **顺位 1**：装好后的插件目录里那份
   （npm 装法包里没有它，但你可以自己写进去；打开插件目录就能找到）；
2. `~/.dsh-edge-agent/edge.json` — **顺位 2**：跨通道、跨重装都活着，推荐。

⇒ 把真实端点与密钥写进这两个位置之一。

### 9.2 「意图判定」卡住 = 那个设备上没有配置文件（2026-11-11 定位）

**症状**：Edge tab 正常出现，但「意图判定」一直「进行中…」，下游「PII 脱敏」「路由决策」
跟着一起等；面板上的模型是**宿主选的那个模型**（如 `deepseek-account/deepseek-flash`），
不是 edge 自有的 `local-llm`。

**因果链 —— 每一环都在代码里，不是推测**

| 环 | 事实 | 出处 |
|---|---|---|
| 1 | npm 装出来的包里**没有** `config/edge.json`（只有模板 `edge.example.json`） | §7.1；发布物实测 |
| 2 | 配置候选**只有两档**：插件目录 `config/edge.json` → `~/.dsh-edge-agent/edge.json`；**模板永远不是候选** | `src/dsh-adapter/edge-config.ts:508-532` |
| 3 | 两档都没命中 ⇒ 走 `DEFAULT_EDGE_CONFIG`，其中 `llm.local.delegate = true`、`llm.cloud.delegate = true` | `edge-config.ts:335-336` |
| 4 | DELEGATE = **转发宿主 profile 已配置的模型提供商**（edge 一个 secret 都不碰） | `local-llm-adapter.ts:819-836`；`edge-config.ts:104-110` |
| 5 | 意图阶段默认 `provider=local-llm`、`timeoutMs=60000`，且 `stages.intent.timeoutMs` 会接进 `llmTimeoutMs` | `edge-config.ts:345-347`；`intent-router.ts:3113-3115` |

⇒ 那次意图判定的调用打在**宿主模型**上，超时窗口是 **60 秒**（不是 4 秒）⇒ 面板长时间挂着。
（DELEGATE 只换「谁提供模型」，不换这一域的隐私口径 —— local 池仍带全部历史。）

**先确认（一条命令，不改任何东西）**

```powershell
node -e "const fs=require('fs');const p=process.env.USERPROFILE+'/.dsh-edge-agent/audit/audit.plain.jsonl';if(!fs.existsSync(p)){console.log('NO AUDIT FILE');process.exit(0)}const l=fs.readFileSync(p,'utf8').split('\n').filter(Boolean);for(const x of l){try{const o=JSON.parse(x);if(o.kind==='config.loaded')console.log(new Date(o.ts).toISOString(),JSON.stringify(o.payload))}catch{}}"
```

- `path` = `(defaults — no config file found)` ⇒ **就是这条链**，去写配置；
- `path` = `…\config\edge.json` ⇒ 顺位 1 命中（插件目录里有活配置）；
- `path` = `C:\Users\<你>\.dsh-edge-agent\edge.json` ⇒ 顺位 2 命中（配置在 home，跨重装都活着）。

**解封**：写 `~/.dsh-edge-agent/edge.json`（推荐 —— 重装、删 profile 都活着）：

```json
{
  "llm": { "local": { "baseUrl": "https://<你的端点>/v1", "model": "<模型 id>", "keyRef": "myEdgeKey" } },
  "secrets": { "myEdgeKey": "<你的 key>" },
  "stages": {
    "intent": { "provider": "local-llm", "timeoutMs": 60000 },
    "guard":  { "provider": "local-llm", "timeoutMs": 60000 }
  }
}
```

⇒ `baseUrl` 一填，本地池从 DELEGATE 变成 **direct**（`edge-config.ts:1143-1157`），
内部阶段直接打本地端点，不再借道宿主模型。
（`keyRef` 指向 `secrets` 里的槽位；明文 key 只落在文件里，不进包、不进仓库。）

**改完必须重启 App** —— `llm` / `stages` / `jev` 这些段是在插件 `apply()` 里定死的。
重启后审计链应出现
`llm.local.catalog {"provider":"local-llm","model":"<你的模型>","mode":"direct"}`。

## 10. 版本语义：npm 通道和 git 通道**不一样**

| | npm 通道 | GitHub 地址通道 |
|---|---|---|
| 装到的是哪个版本 | 你发的那个版本 | **默认分支的 HEAD**（`resolveGitCommit` 在 `gitCommittish` 为空时取 `"HEAD"`） |
| 要钉版本怎么办 | 填 `pkg@0.1.1` | 填 `https://github.com/owner/repo#<sha>` |
| 能用 tag 钉吗 | —— | 填 `#v1.2.3` 可以 |

⇒ **npm 通道发出来的版本号，git 地址通道那边默认认不出来**（那边跟着 main 跑）。

## 11. 相关文档

- [`npm-account-setup.md`](npm-account-setup.md) — **注册 npm 账号/组织 + 办发布凭据**（§8.5 的第 1、3 条展开）
- [`deploy-github.md`](deploy-github.md) — 从 GitHub 仓库地址安装
- [`load-into-local-dsh.md`](load-into-local-dsh.md) — 本地目录通道（§8）
- [`desktop-troubleshooting.md`](desktop-troubleshooting.md) — 装完起不来 / Edge tab 不见了
- [`deploy-minimal-files.md`](deploy-minimal-files.md) — 最小部署清单
- 宿主自己的发布说明：`deepseek-harness/docs/user/develop/basic/publish.md`
