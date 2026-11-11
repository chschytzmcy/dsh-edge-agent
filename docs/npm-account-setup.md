# npm 账号/组织注册与发布凭据办理（scope `@dsh-edge`）

> 状态：**✅ 已发布 `0.1.1`**（2026-11-11，§7.185）。三件作者侧的事都做完了：
> 组织 `dsh-edge` 已建、凭据已用、第一次发布已上线（registry 侧实测：`versions =
> 0.0.0-stage, 0.1.1`，`dist-tags.latest = 0.1.1`，npm 通道实装通过）。
>
> | # | 原来缺什么 | 谁做 | 状态 |
> |---|---|---|---|
> | 1 | npmjs.com 上拥有 `@dsh-edge` scope 的**账号或组织** | **主人**（本文件 §2–§4） | ✅ 已建（实测 `/-/org/dsh-edge/package` → HTTP 200） |
> | 2 | 发布凭据：granular token，**或**登记 trusted publisher 改走 OIDC | **主人**（本文件 §5–§6） | ✅ token 已在 `~/.npmrc`；**trusted publisher 还没登记** |
> | 3 | 执行第一次发布 | **我**（`npm run publish:npm -- --yes`） | ✅ 已上线 0.1.1（tag `v0.1.1`） |
>
> **还剩两件事**（都要主人本人在浏览器里点）：
> ① 在包页面登记 **trusted publisher**（§8）—— 不做，2027-01 起 CI 发不了；
> ② 账号 2FA：**npm 已移除 TOTP 注册通道**，只剩 WebAuthn 安全密钥（§5）。
>
> 账号名 / 组织名**必须正好是 `dsh-edge`**——原因见 §1；npm 是**先到先得**，现在已真发一版
> （§10 的坑 1 不再适用）。

## 0. 一句话

注册一个叫 `dsh-edge` 的 npm **账号**（或同名**组织**）⇒ 拿到 `@dsh-edge` scope
⇒ 签一个 granular token ⇒ 发第一版 ⇒ 登记 trusted publisher ⇒ CI 以后走 OIDC、不要 token。

## 1. 为什么名字必须是 `dsh-edge`

### 1.1 npm 的规则

官方文档原话（[About scopes](https://docs.npmjs.com/about-scopes/)）：

> When you sign up for an npm user account or create an organization, you are
> granted a scope that matches your user or organization name.

建组织那页也是同一句逻辑（[Creating an organization](https://docs.npmjs.com/creating-an-organization)）：

> Your organization name will also be your organization scope.

⇒ **scope 名 = 账号名/组织名**，没有第二种来源。所以：

- 想拿 `@dsh-edge` ⇒ 必须存在一个叫 `dsh-edge` 的账号或组织；
- 改 scope 名**并不能**省掉注册，只是把「注册什么名字」从包上挪到账号/组织上；
- 账号名**不能带大写**（npm 用户名全小写），也不能用 npm 保留词。

### 1.2 scope 现在是空闲的（实测，带对照组）

| 探针 | 结果 | 结论 |
|---|---|---|
| `https://www.npmjs.com/~dsh-edge` | h1 `not found` + `NotFoundError: Scope not found` | **未被占用** |
| `https://registry.npmjs.org/-/org/dsh-edge/package` | **404** | 无同名组织 |
| **对照组** `https://www.npmjs.com/~babel` | 跳 `/org/babel`，标题 `npm \| Profile`，列 `Packages 435` | **判别口径成立** |

> **判别口径**：`~<name>` 页面对**存在的** scope 会 302 到 `/org/<name>` 并渲染
> `npm | Profile` + `Packages N`；对**不存在的**留在原 URL，渲染 `not found` +
> `NotFoundError: Scope not found`。registry 端 `/-/org/<name>/package` 对不存在的
> 组织返 **404**（对照 `/-/org/types` 返 200）。
> **用户**账号端点 `/-/user/org.couchdb.user:<name>` 匿名访问恒 401 ⇒ 用户账号是否
> 存在**查不了**，只能靠 `~<name>` 页 + org 端点两条证据一起判。
> （直连抓 `www.npmjs.com` 会被 Cloudflare 挡，返回 challenge HTML ⇒ 要用浏览器。）

## 2. 两条路线（scope 都是 `@dsh-edge`）

| 路线 | 怎么做 | 取舍 |
|---|---|---|
| **A（推荐）** | 用**你自己的名字**注册个人账号（建议 `chschytzmcy`，与 GitHub 一致）→ 建**组织** `dsh-edge` → 把自己加为成员，角色给 **publish** | 语义清楚（账号＝人，组织＝项目），以后能加协作者；多 3 步 |
| **B（最省事）** | 直接注册**用户名 = `dsh-edge`** 的个人账号 | 一步到位；代价是这个名字成为你的公开身份，以后想加协作者得另建组织（同名不可能） |

**两条路对本仓完全等价**：包名都是 `@dsh-edge/dsh-edge-agent`，仓库侧一个字都不用改。
唯一差别在 §9 登记 trusted publisher 时，Owner 字段填账号名还是组织名。

> ⚠️ 路线 A 里，**个人账号名不能也叫 `dsh-edge`**——否则组织名就被占了。
> 路线 A 的个人账号随便叫什么（`chschytzmcy` 最合适），**组织**才叫 `dsh-edge`。

## 3. 注册账号

1. 打开 **https://www.npmjs.com/signup**
2. 填三样：
   - **Username**：路线 A 填 `chschytzmcy`；路线 B 填 `dsh-edge`（全小写、无空格）
   - **Email**：能收信的邮箱
   - **Password**：≥ 8 位，带大小写 + 数字
3. 点 **Create Account**
4. npm 发一封验证邮件 → **点邮件里的链接完成验证**（邮箱不验证不能发包）

> 站点可能先弹 Cloudflare 的 "Just a moment…" 验证页，等它自己过就行。

## 4. 建组织（只有路线 A 需要）

1. 登录后点右上角头像 → **Add an Organization**（或直接开
   **https://www.npmjs.com/org/create**）
2. **Name** 填 `dsh-edge` —— 下面会带出 scope `@dsh-edge`，确认一下
3. Plan 选 **"Unlimited public packages"** → **Create**
   （我们发公开包，免费那个就够；"Unlimited private packages" 是付费的）
4. 进组织 → 邀请自己（填你的 npm 用户名或邮箱）→ 团队选 **publish**
   - ⚠️ 表格里那个 "Organizations" 栏只管成员，**不能用来发包**；包的权限走包页面的
     Access 设置
   - ⚠️ npm 的 token 权限**不能超过签发者本人的权限** ⇒ 你的账号在组织里必须有
     publish 权限，才能用它的 token 发包

## 5. 开 2FA（发包硬要求）

路径 **https://www.npmjs.com/settings/two-factor-auth**：

> ⚠️ **2026-11-11 实测更正**：npm 已经**移除了 TOTP（Authenticator App）的注册通道** ——
> `npm profile enable-2fa auth-and-writes` 仍走 otpauth:// 生成路径，但 **registry 端点返
> 404**：`Adding a new TOTP 2FA is no longer supported`。⇒ **别再走「扫码装 TOTP」这条路**
> （本文件此前的版本写的就是它，那是已失效的旧口径）。
>
> 现在账号 2FA **只剩 WebAuthn 安全密钥**一种：Yubikey / Thetis / Feitian 等硬件钥匙，
> **以及 Windows Hello**（PIN / 指纹 / 人脸）—— Windows Hello 本身就是 WebAuthn 认证器，
> Windows 11 的「手机当安全钥匙」也算。
>
> 浏览器端的交互式 2FA 验证（挂 trusted publisher、改 2FA 配置）在 WebAuthn 下**完全可用**；
> 但 **CLI 的 `--otp` 只吃 TOTP 六位码** ⇒ 账号走 WebAuthn 后，经典 token 在 CLI 上发不了版。

没开 2FA 的话发布会被拒（npm 要求账号开着 2FA，或用勾了 Bypass 2FA 的 granular token）。

## 6. 签发发布凭据

路径 **https://www.npmjs.com/settings/access-tokens** → **Generate New Token**。

⚠️ **不要用 Classic token**。npm 站点现在挂着横幅：

> npm tokens that bypass 2FA are being restricted — account changes (Aug 2026)
> and direct publishing (Jan 27).

即 **2027-01 起「用 token 直接发版」这条路被移除**（改成 stage-only + `npm stage
approve`）。所以 token 只是**首次发布的过桥**，发完立刻切 trusted publishing（§9）。

配置：

| 项 | 值 | 为什么 |
|---|---|---|
| Packages | **Select packages and scopes** → 加上 `@dsh-edge` | 只授权这一个 scope |
| Permissions | **Read and write** | 发布需要写权限 |
| Expiration | 最长 **90 天** | npm 现在的上限 |
| Bypass 2FA | 勾上 | token 直发时要过 2FA 这一关 |

生成后**只显示一次**，立刻复制。名字建议 `dsh-edge-agent-publish`。

### 6.1 在本机放凭据（不要写进仓库）

```powershell
$env:NPM_TOKEN = 'npm_xxxxxxxx'
```

仓库里的 `scripts/publish-npm.mjs` 会离线读 `NPM_TOKEN` / `NODE_AUTH_TOKEN` /
`~/.npmrc` / 仓库 `.npmrc`；**找不到凭据会在 3 秒内拦停**，不会白跑一遍构建 + 28 道门禁。

## 7. 发第一版

注册 + 凭据都齐了之后：

```powershell
npm run publish:npm -- --yes --tag
```

这条命令会依次跑：canonical 构建链（compile → typecheck → build → pack → stage）→ **28 道门禁**
→ 认证预检 → `pnpm publish --access public --ignore-scripts --no-git-checks`。

- 首次发布**不带** `--provenance`（包还不存在时 visibility 端点答 200
  `{"public":false}`，provenance 生成器会失败）—— `publish-decision.mjs` 会自动判定。
- 本地发布要求 **attached HEAD**（CI 的 tag push 是 detached，所以 CI 侧走
  `--no-git-checks`）。

细节见 [`deploy-npm.md`](deploy-npm.md) §8.1.1 与 §8.2。

### 7.1 ⚠️ 实测：「发布报成功」≠「包已经能装」（staged publishing）

2026-11-11 实测：`pnpm publish` 打印
**`✅ Published package @dsh-edge/dsh-edge-agent@0.1.1`**、退出码 0 —— 但**那一刻
registry 上还装不了这个包**：

| 探针 | 刚发完 | 约 6 分钟后 |
|---|---|---|
| `npm view <pkg> version` | **404** | `0.1.1` |
| packument（`GET /@dsh-edge%2fdsh-edge-agent`） | **404** | **200**，versions = `0.0.0-stage, 0.1.1` |
| `GET /-/package/<pkg>/dist-tags` | `{"latest":"0.1.1"}` | 同左 |
| `GET /<pkg>/0.1.1`（版本文档） | 200（fileCount 238） | 同左 |

⇒ npm 现在把**「用 bypass-2FA token 直接发布」也收进了分级发布（staged publishing）**：
包名先被一个占位版 `0.0.0-stage` 占住，真实版本进待批队列。占位版是公开可装的，
真实版本要等放行 —— 这次实测是**自动放行**（等了约 6 分钟）；也可能需要人在 npmjs.com
的 **Staged Packages** 页点 Approve，或 `npm stage approve <stage-id>`（后者要求
npm ≥ 11.15，且仍需过一次 2FA 挑战）。

**判据**：`npm view <pkg> version` 返回 `0.0.0-stage` ⇒ 还卡着；返回真实版本号 ⇒ 已上线。

> 本机 npm 是 **11.6.2** ⇒ **没有** `npm stage` 子命令；要手动批准得用 `npx npm@12`，
> 而 npm 12 的 `stage approve` 仍要 2FA 挑战（TOTP 已被移除 ⇒ CLI 这条路对本机走不通，
> 浏览器点 Approve 才可行）。

官方文档：[Staged publishing for npm packages](https://docs.npmjs.com/staged-publishing)。

## 8. 首次发布之后：登记 trusted publisher

**这一步不做，CI 迟早发不了**（2027-01 起 token 直发被移除）。

包页面 **https://www.npmjs.com/package/@dsh-edge/dsh-edge-agent/settings/access**
登记 **Trusted Publisher**：

| 字段 | 填什么 |
|---|---|
| Organization or user | `dsh-edge`（路线 A 填**组织**，路线 B 填**账号**） |
| Repository | `chschytzmcy/dsh-edge-agent` |
| Workflow filename | `publish.yml` |

登记后 CI 用 **OIDC** 自动换短期凭据：**不需要任何 token**，也不受 2027 退场影响。
（pnpm 11.7.0 自己实现了 OIDC 交换 ⇒ 不需要 npm CLI ≥ 11.5.1，也不需要升 Node。）

## 9. 三个坑

1. **只注册不发包 = 抢注，违反 npm 使用条款。** npm 的争议政策原文：注册用户名/组织名
   「仅仅是为了将其保留以供将来使用」属于违规；组织长期不发包会被判抢注。
   ⇒ **注册完尽快真发一版**（本项目本来就要发，不冲突）。
2. **用户名/组织名不能含大写**，也不能带 npm 保留词；名字一旦占用基本要不回来
   （npm 政策：用户名的控制权**极不可能**转让）。
3. **首次发布不要带 `--provenance`**（见 §7）。另外 npm 对新账号有冷启动审核期
   （几小时到几天不等），那是正常流程，不是出错。
4. **「publish 报成功」不等于「包已经能装」** —— 见 §7.1：先 `npm view <pkg> version`
   确认返回值不是 `0.0.0-stage`，再去装。
5. **「占位版 0.0.0-stage 会一直留在 versions 里」** —— 它是注册时留下的占位残留
   （本次实测：`versions = 0.0.0-stage, 0.1.1`，`latest = 0.1.1`）⇒ 看到它别慌，
   **判据看 `dist-tags.latest` 指向谁**。

## 10. 仓库侧已经就绪的部分

| 部分 | 状态 | 出处 |
|---|---|---|
| 包名 `@dsh-edge/dsh-edge-agent` | ✅ 已定并全仓统一（47 文件 / 244 处） | `docs/PROGRESS.md` §7.173 |
| 包名一致性门禁（25 项链的第 21 位） | ✅ 16 条自证 + 反向证伪 | `scripts/verify-package-name.mjs` |
| 本地一键发布脚本 | ✅ 端到端跑通（dry-run） | `scripts/publish-npm.mjs` |
| CI 发布链 + 决策（跳过已发版 / 首次不带 provenance） | ✅ 门禁全绿 | `.github/workflows/publish.yml` |
| 首次发布的 provenance 判定 | ✅ 实测：visibility 端点答 200 `{"public":false}` | `scripts/registry-version.mjs` |

## 11. 相关文档

- [`deploy-npm.md`](deploy-npm.md) — npm 通道的完整说明：宿主怎么认包名、发布链环节与报错对照、作者侧义务逐条核对
- [`deploy-github.md`](deploy-github.md) — 从 GitHub 仓库地址安装（另一条通道）
- [`load-into-local-dsh.md`](load-into-local-dsh.md) — 本地目录通道
- 宿主自己的发布说明：`deepseek-harness/docs/user/develop/basic/publish.md`
- npm 官方：[About scopes](https://docs.npmjs.com/about-scopes/) /
  [Creating an organization](https://docs.npmjs.com/creating-an-organization) /
  [Disputes](https://docs.npmjs.com/policies/disputes)
