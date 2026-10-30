# 从 npm 包名安装（桌面版 Plugins → Add plugin）

> 状态：**2026-10-30 完成通道调研 + 发布链修复**（§7.156）。宿主侧的 npm 通道
> 早就做完了；这一轮把它读透，并修好了**发布链上那个从来没被走通过的洞**。
>
> ⚠️ **但这个通道今天还用不了** —— 包尚未发布到 registry（404）。
> 「填包名」这条路要等第一次发布之后才成立。
>
> 宿主契约出处：`deepseek-harness`（只读参考仓）
> `packages/boot/plugin-manager/src/*`、`packages/client/ui-plugin-manager/src/client/*`、
> `docs/user/develop/basic/publish.md`。

## 0. 一句话

在桌面 App 的 **Plugins → Add plugin** 里填

```
@deepseek-harness-edge-agent/dsh-edge-agent
```

宿主负责查 registry、装、校验、启用；**本仓负责让 registry 上那个 tarball
包含宿主要的全部东西**（Node 半侧 + 浏览器半侧 + bundle patch 层）。

与 git 通道最大的差别：**npm 通道不需要构建授权，也不需要 PATH 上有 pnpm**
（§2.6 解释为什么）⇒ 用户点一下就装完。

## 1. 三条通道怎么选

| 通道 | 输入 | 要构建授权吗 | PATH 要有 pnpm 吗 | 产物形态 | 适合谁 |
|---|---|---|---|---|---|
| **npm 包名** | `@作者/插件名` | **否** | **否**（用 App 自带的） | 预构建 | **发布给公众** |
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

本仓的 `@deepseek-harness-edge-agent/dsh-edge-agent` ✅ 合规。

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

## 7. 作者侧义务 —— 本仓逐条对照

宿主自己的说明在 `publish.md`（**是教程不是清单**）。按它 + 宿主源码的要求
逐条对本仓：

| 要求 | 出处 | 本仓 | 状态 |
|---|---|---|---|
| 包名合规（小写、≤214） | `install-spec.ts:32-33` | `@deepseek-harness-edge-agent/dsh-edge-agent` | ✅ |
| `name` / `version` | `publish.md:36-44` | `0.1.1` | ✅ |
| `dsh.bundle.patch`（字符串或列表） | `publish.md:13,64` | `["./cordis.desktop-safe.patch.yml", "./presets/edge.desktop-safe.patch.yml"]` | ✅ |
| patch 文件**必须在包里** | `app-boot/src/index.ts:538-546` | 两个都在 `files` 白名单里 | ✅ |
| `engines.dsh` 声明 | `publish.md:66` | `">=0.2.1-rc.2"` | ✅ |
| 共享的 dsh 包同时进 peer + dev | `publish.md:105` | 8 个 `@deepseek-ai/*` 两边都有 | ✅ |
| **npm 发布时必须预构建 `lib/`** | `publish.md:169,185` | `prepare` = `compile` + `build:client` | ✅ |
| `files` 白名单 | `publish.md:41` | `lib` `config` `presets` 3 个 yml，且 `!config/edge.json` | ✅ |
| 包名可发（registry 上没被占） | npm | registry 404 ⇒ **还没发** | ❌ |

**`prepare` 只对 git 安装有意义**（`publish.md:171`）—— npm 装的时候 tarball 里
已经是构建好的 `lib/`，pnpm 不会跑 `prepare`。

### 7.1 包里有什么（`verify:package` 实测：231 文件 / 67 个入口目标）

```
lib/            ← Node 半侧（.js + .d.ts）+ 浏览器半侧 lib/client.js
config/         ← edge.example.json + privacy-policy.json（**没有 edge.json**）
presets/
cordis.yml / cordis.patch.yml / cordis.desktop-safe.patch.yml
package.json / README.md / LICENSE
```

`files` 白名单在 npm 通道同样生效：`src/`、`scripts/`、`tests/`、`.git/` 都不进包。

## 8. 发布链（CI）

### 8.1 触发

| 文件 | 触发 | 作用 |
|---|---|---|
| `ci.yml` | push main / PR | 只检查，不发布 |
| `publish.yml` | **推 `v*` tag** | 检查 + `pnpm publish --provenance --access public` + GitHub Release |
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
| `pnpm publish`（无 token） | `You must be logged in to publish packages.` | `NPM_TOKEN` secret 没配/失效 |
| `pnpm publish`（无权限） | `403 Forbidden - PUT https://registry.npmjs.org/... - You do not have permission to publish` | scope 没建好 / 名字被占 |
| `pnpm publish`（版本已存在） | `409 Conflict - PUT ... - Cannot publish over the previously published versions: 0.1.1` | 改版本号再发 |

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

### 8.5 真正发布成功需要哪些条件（逐条核对，2026-10-30 核实）

| # | 条件 | 状态 | 备注 |
|---|---|---|---|
| 1 | npmjs.com 账号 | ❓ | 需要主人在 registry 上有账号 |
| 2 | scope `@deepseek-harness-edge-agent` 可用 | ✅ | 查得 404 ⇒ 该 scope 未被占用；首次发布会创建它 |
| 3 | 认证：`NPM_TOKEN`（**granular access token**，publish 权限、Bypass 2FA、≤90 天） | ❓ | **classic token 已于 2025-12 被 npm 撤销**，只能用 granular |
| 3′ | 或 OIDC **Trusted Publishing**（不要 token） | ⚠️ | 需 **npm CLI ≥ 11.5.1**（⇒ Node 24）；CI 现在 Node 22.20 ⇒ npm 10.x ⇒ **用不了** |
| 4 | `publishConfig.access: "public"` | ✅ | scoped 包默认 restricted，必须显式 public |
| 5 | `repository.url` 与发布位置**精确匹配**（大小写敏感） | ✅ | **§7.156 已从 SSH 形式改成 `https://github.com/chschytzmcy/dsh-edge-agent.git`** |
| 6 | `permissions: id-token: write` | ✅ | workflow 里已有 |
| 7 | 云托管 runner | ✅ | `ubuntu-latest`（自托管 runner 不满足 provenance 要求） |
| 8 | **仓库公开**（provenance 的前提） | ❌ **当前是私有** | GitHub API 匿名查本仓返回 **404** ⇒ 私有。⇒ §8.5.1 |
| 9 | 包本身 public | ✅ | `--access public` |
| 10 | `lib/` 预构建 | ✅ | §8.3 修的就是这个 |
| 11 | `files` 白名单 | ✅ | 231 文件 / 67 入口 |
| 12 | `dsh.bundle.patch` 列出的文件在包里 | ✅ | 两个 patch 都在白名单里 |
| 13 | `engines.dsh` 声明 | ✅ | `>=0.2.1-rc.2` |
| 14 | 版本未被占用 | ✅ | `0.1.1` 未发过（registry 404） |
| 15 | tag ↔ `package.json#version` 一致 | ✅ | §7.156 加了断言 |
| 16 | 真密钥不在包里 | ✅ | `.npmignore` + `files` **双重**排除 `config/edge.json` |

⇒ **剩下的只有两件是主人手上的**：① npm 账号 + token（③）；② 要不要转公开（⑧）。

#### 8.5.1 provenance 的那条硬约束（最容易踩的一脚）

npm 的溯源徽章（`Built and signed on GitHub Actions`）**只接受公共来源仓库**。
pnpm 自己的判定（`releasing/commands/lib/publish/oidc/provenance.js`）：

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

**§7.156 的处理**：不写死 `--provenance`，而是**按仓库可见性自动决定**：

```yaml
- name: Publish
  env:
    NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
  run: |
    VISIBILITY="${{ github.event.repository.visibility }}"
    if [ "$VISIBILITY" = "public" ]; then
      pnpm publish --provenance --access public
    else
      echo "::warning::仓库是 private ⇒ npm 不接受私有来源仓库的 provenance。本次不带 --provenance 发布。"
      pnpm publish --access public
    fi
```

- **现在是私有** ⇒ 走「不带」那支 ⇒ **发得出去**（只是没有溯源徽章）；
- **将来转公开** ⇒ 同一份 workflow 自动升级成带徽章的，**不用再改**；
- 取不到可见性时默认走「不带」那支 ⇒ 宁可少一个徽章，也不要让整个发布因 provenance 失败。

> ⚠️ **首次发布的额外不确定点**：pnpm 第②步要问 registry「这个包是不是 public」，
> 而首次发布时包**还不存在**。若那个端点在包不存在时返回 404，会变成
> `ProvenanceFailedToFetchVisibilityError`。这只会影响**公开仓库**的首次发布；
> 私有仓库走的是「不带 `--provenance`」那支，不经过这一步。

#### 8.5.2 认证方式怎么选

| 方式 | 需要什么 | 代价 |
|---|---|---|
| **granular access token** | npmjs.com → Settings → Access Tokens → 新建，勾 publish、勾 Bypass 2FA、有效期 ≤90 天、scope 限定到本包 ⇒ 存成 GitHub secret `NPM_TOKEN` | 要定期轮换（90 天） |
| **OIDC Trusted Publishing** | npmjs.com 上给本包登记 trusted publisher（Owner / Repository / Workflow 文件名 `publish.yml`，**大小写敏感**）⇒ **完全不需要 token** | 需 **npm CLI ≥ 11.5.1** ⇒ Node 24。本仓 CI 用 Node 22.20 ⇒ **现在用不了**，要升 Node |

⇒ **当前建议走 granular token**：CI 已是 Node 22.20，升 Node 属于额外改动。

> npm 2025-12 起撤销了全部 classic token。旧的 `NPM_TOKEN`（classic）现在一律无效。

## 9. 排障

| 症状 | 看哪里 | 常见原因 |
|---|---|---|
| 预检就说「没有这个包」 | `pnpm view <spec> name version description dsh --json` 手跑一遍 | 包没发布 / registry 不对 / 网络到不了 registry |
| 预检说「这个包没有声明组合包」 | `pnpm view <spec> dsh --json` | `dsh.bundle` 缺失，或**没有 `patch`** |
| 装完说「failed to read overlay」 | tarball 里有没有那两个 patch 文件 | `files` 白名单漏了 |
| 装完说「版本不兼容」 | `engines.dsh` vs 宿主版本 | 范围太窄 |
| 装完桌面右栏没有 Edge tab | `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` | **没点「立即启用」**（§6.3） |
| 配置读不到 / 云端 401 | `~/.dsh-edge-agent/audit/audit.plain.jsonl` 的 `config.loaded` | npm 装法同样**没有** `config/edge.json` ⇒ 要写 `~/.dsh-edge-agent/edge.json`（§4） |

### 9.1 配置落位（与 git 通道一致）

`config/edge.json` 含明文 API key，**不入库、不进包** ⇒ npm 装出来的包里也没有它。

运行时查找顺序（`src/dsh-adapter/edge-config.ts:391-408`）：

1. `<bundle root>/config/edge.json` — npm 装法**没有**；
2. `~/.dsh-edge-agent/edge.json` — **npm 装法用这个**；
3. `<bundle root>/config/edge.example.json` — 空密钥兜底。

⇒ 把真实端点与密钥写进 `~/.dsh-edge-agent/edge.json`。

## 10. 版本语义：npm 通道和 git 通道**不一样**

| | npm 通道 | GitHub 地址通道 |
|---|---|---|
| 装到的是哪个版本 | 你发的那个版本 | **默认分支的 HEAD**（`resolveGitCommit` 在 `gitCommittish` 为空时取 `"HEAD"`） |
| 要钉版本怎么办 | 填 `pkg@0.1.1` | 填 `https://github.com/owner/repo#<sha>` |
| 能用 tag 钉吗 | —— | 填 `#v1.2.3` 可以 |

⇒ **npm 通道发出来的版本号，git 地址通道那边默认认不出来**（那边跟着 main 跑）。

## 11. 相关文档

- [`deploy-github.md`](deploy-github.md) — 从 GitHub 仓库地址安装
- [`load-into-local-dsh.md`](load-into-local-dsh.md) — 本地目录通道（§8）
- [`desktop-troubleshooting.md`](desktop-troubleshooting.md) — 装完起不来 / Edge tab 不见了
- [`deploy-minimal-files.md`](deploy-minimal-files.md) — 最小部署清单
- 宿主自己的发布说明：`deepseek-harness/docs/user/develop/basic/publish.md`
