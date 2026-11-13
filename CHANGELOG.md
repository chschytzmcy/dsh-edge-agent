# Changelog

本文件的**唯一权威**是 [`docs/PROGRESS.md`](docs/PROGRESS.md) —— 那里逐条记着
每一次改动的根因、实证与裁决（§7.x 全量历史）。本文件是给**使用者**看的：装上之后
能得到什么、有什么边界、怎么排障。

格式：[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [Unreleased]

**「本地池其实是委托出去的」这件事，从审计行里的一个字段变成了一等 security 事件；
并多了一个默认关闭的开关，让它可以被彻底堵住。**
（2026-11-12，§7.210）

### 你会看到什么变化

- 判定为「本地」的轮次会被改道到本地池。**但本地池留空（默认）时是 DELEGATE**
  —— 转发宿主模型，也就是**这一轮其实出了设备**。
  以前这件事只表现为审计行里的一个 `mode: 'delegate'` 字段；现在审计链里会多一条
  **独立的一等 security 级事件**：`input-guard.reroute.delegate-egress`
  （带 `from` / `to` / `reason` / `blocked`）。grep `security` 或 `egress` 都能搜到。
- 想彻底杜绝这种出网，两条路：
  1. 在 `~/.dsh-edge-agent/edge.json` 的 `llm.local` 段填上 `baseUrl`（直连自有池）；
  2. 或把 `llm.local.requireLocalEndpoint` 设成 `true` —— DELEGATE 时该轮按
     fail-closed **拒收**（宁可不答，也不出网）。
- **默认 `false`** ⇒ 既有行为一个字没改（DELEGATE 照常放行，只是多了那条审计事件）。
- ⚠️ 别把 `requireLocalEndpoint` 一上来就开成 `true`：默认形态就是 DELEGATE，
  那样会让边缘模式全线不可用。
- ⚠️ 边界：以上说的 DELEGATE = **本地池没配端点**。若你把 `llm.local.baseUrl` 指向一个
  **云端**端点，边缘模式**不做任何特殊处理**（不改 provider 归属、不裁它的历史、
  不把它判成云池、不因此拦它）—— 那是你的行为，不是 bug。

### 测试与门禁

- 新增 `tests/unit/input-guard-delegate-egress.test.ts`（9 条）：默认档零行为变化 /
  security 事件 / 严格档拒收且不派发 / 被拒时不留「改道了」的假记录 / 直连池不受影响。
- `verify:config-hints` 扩了 3 组断言：新提示文案与旧文案受同一套纪律约束、
  必须点名 `requireLocalEndpoint`、模板里的默认值必须是 `false`（自证 14 → 17 条）。

### 上一轮（§7.209）

**safe 变体与 npm 包不再携带 full 变体的补丁；出货文件集改为按变体派生。**
（2026-11-12，§7.209）

#### 出货内容的变化（运行时行为一字未改）

- **npm 包与 safe 变体的 tar 包里不再有 full 变体的两个补丁**（`cordis.patch.yml`
  20,482 B + `presets/edge.patch.yml` 35,972 B，合计 **56,454 B**）：那两个文件与
  仓库根的 full 版**逐字节相同**，而 full 变体的语义是「**改写宿主默认值**」——
  与 safe 通道「不重写宿主默认值」的承诺互斥。
- 连带：`exports` 里指向这两个文件的公共子路径也一并去掉（仓库根清单 37 条 ⇒
  **safe 变体 35 条**、full 变体 36 条）。
- 两个 tar 包各 240 → **238** 个文件；npm 暂存目录 241 → **239** 个文件。
- **运行时行为与 0.1.5 完全相同** —— 本轮只动产物内容、门禁与文档。
- ⚠️ **已发布的 5 个 npm 版本（0.1.1 – 0.1.5）仍然带着 full 补丁** ——
  npm 版本不可覆盖，要等**下一个版本**发布才会消。

#### 排障指引改口（这行以前会把 safe 用户带进 full 行为）

- `docs/desktop-troubleshooting.md` §7 教的「手动 cp `cordis.patch.yml` 到嵌套包根」
  改成「cp **本变体自己的**补丁」（safe = `cordis.desktop-safe.patch.yml`，
  full = `cordis.patch.yml`）。以前照做 ⇒ safe 静默切成 full（改写模型/人设/审批/
  沙箱/会话根/http-api）；现在 safe 的包里**根本没有**那个文件可 cp。

#### 门禁：加了三项「变体纯净度」断言（门禁道数仍是 31）

- `verify:installable` 第 2d 项、`verify:npm-stage` 第 5d 项、`verify:tarball` 第 10 条
  （含 2 条反向自证）—— 本变体**不得**携带别的变体的补丁。
- 出货文件集改由 `scripts/_bundle-variants.mjs` **单一派生**（`variantFiles` /
  `variantExports`），四个出货写入点全部改走它，删掉了两处硬编码清单。

#### 文档：不再写会漂的出货数字

- `lib/` 下每个模块出 3 个产物 ⇒ 「包里几个文件」每改一次代码就变。原先写死的
  「238 文件 / 37 个 `exports` 入口」**早就在漂**（registry 上已是 241）。
  现在改成「规则 + 怎么问」（`npm view … dist.fileCount` / `npm pack --dry-run --json`），
  README 里的条数也去掉了。

### 上一轮（§7.208）

**产物一致性与文档口径各补一道机器看守；并把「CI 发不了 npm」查到日志级。**
（2026-11-12，§7.208）

#### 出货内容的变化（运行时行为一字未改）

- **tar 包（GitHub Release 资产）现在也带 `CHANGELOG.md`**（§7.208）：出货面有两个**各自
  独立**的生产者（npm 包走 `package.json#files`，tar 包走 `stageVariant` 的硬编码清单），
  `CHANGELOG.md` 之前只在 npm 包里 ⇒ **git release 通道的用户拿不到变更记录**。
  两个 tar 包各从 239 → **240** 个文件。
- 门禁 `verify:tarball` 新增**第 9 条断言**：出货的 `CHANGELOG.md` 必须与仓库根
  **逐字节一致**（与 README 同一条纪律）。
- **运行时行为与 0.1.5 完全相同** —— 本轮只动产物内容、门禁与文档。

#### 新门禁：文档里的门禁数必须等于链内实际道数（§7.208）

- 新增第 31 道门禁 `verify:doc-gate-count`：核对 `docs/`、README、`scripts/`、workflows
  里写的门禁**总数**与**位次**是否与 `verify:build` 链一致。
- 起因是实测发现：链里 30 道，而文档里有 **8 处**写着 29、发布脚本里还有 **4 处**
  （那是每次发版都会看到的终端输出），且**从来没有一份文档写对过这个数** ——
  现有门禁没有一道管「数字口径」。
- 门禁当场抓出 **12 处**真实漂移（含位次表里过期数字），已全部改正。

#### 补上一条留了三年的交叉校验（§7.208）

- `verify:installable` 新增第 5 项：`package.json#exports` 里指向**资源文件**的条目，
  目标必须真的在包里。补的是 `docs/dev-notes/cordis-rc021-patch-loader.md` §Bug3 记的
  那个真事故（指针在而文件缺 ⇒ 宿主启动时 `ENOENT` ⇒ **boot 硬失败**）。

---

## [0.1.5] — 2026-11-12

**发布链修掉一处竞态，并把 README 重排成正式文档的结构；两条发布面都带最新的 README。**
（2026-11-12，§7.202 / §7.203 / §7.204 / §7.205 / §7.206 / §7.207）

### 出货内容的变化（运行时行为一字未改）

- **本版进包的改动只有 `README.md` 的内容**（README 是出货文件之一）；
- **运行时行为与 0.1.4 完全相同** —— 本版只动文档与发布链，运行时代码一行未改；
- **tar 包（GitHub Release 资产）现在也带 README.md**（§7.207）：`README.md` 已进
  `package.json#files` 白名单 ⇒ 两个 tar 包各多一个文件。门禁 `verify:tarball` 新增
  一条断言：**出货的 README 必须与仓库根逐字节一致** ⇒ 「出货的 README = 最新的
  README」不会悄悄过期。

### 发布链：修掉「registry 的传播延迟」把 CI 的 npm job 拖红的竞态（§7.202）

- **症状**：发 0.1.4 时，CI 的 publish workflow 里 `publish to npm` 这个 job 红在
  `Publish` 步，而 `git release` 那个 job 全绿、Release 也照样建出来了 ——
  **包其实已经发出去了**（本机路径发的），CI 却说「发布失败」。
- **根因**：registry 的**写路径**与**读路径**不同步 —— 发布成功后约 **91 秒**，
  `versions` 数组才看得到新版本（实测：15:26:35 发布成功 → 15:28:06 才可见）。
  CI 的「要不要跳过发布」那一步正好落在这个窗口里 ⇒ 判「未发过」⇒ CI 真的去发 ⇒
  而 registry 早已拒收这一版。
- **修复**：① 判定步加等待窗口（`--wait-seconds`，包存在但这一版还看不见时最多等
  3 分钟）；② 发布步把「这一版已经在 registry 上」（409 / EPUBLISHCONFLICT）**当成功**
  —— 这正是「本机发 + CI 兜底」两条路径共存的语义，之前只写在注释里、没实现。
  其它错误仍然让 job 红，并发公开可读的 `::error::` 注解说明原因。
- **门禁**：`verify:ci-build-chain` 新增 2 项检查（自证断言 34 → 43）。

> 这一段**只改发布链**，不进 npm 包（`scripts/` 与 `docs/` 都不在 `files` 白名单里）。

### README 再收瘦（§7.203）

- 删掉「publish 报成功 ≠ 包已经能装」那段**对客户无用**的发布链说明
  （含分级发布的 `0.0.0-stage` 占位版）—— 它还**写错了**：staged publishing 期间
  `npm view <pkg> version` 返回的是**上一个真实版本**，正确判据是 `versions` 数组里
  有没有出现新版本；
- 删掉 `npm run publish:npm` 三条命令与 `npm login` 前置，收成一行指向
  [`docs/deploy-npm.md`](docs/deploy-npm.md) §8。

> 客户要的部分（怎么装、`edge.json` 怎么配、装完怎么自检、能力与隐私口径）一件没少。

### README 只留「用户怎么用」（§7.204）

- 装这一节扩成**三条通道**各一段：① npm 包名 ② GitHub Release 上的预构建 tar 包
  （粘 URL 即可，免构建授权 / 免 PATH 上的 pnpm / 免 registry）③ GitHub 地址或本地目录
  —— 并把**怎么编译**（`pnpm install` + `pnpm run build`，产物在哪）写进通道③；
- 移走维护者内容：`npm run publish:npm` 三条命令、`npm login` 前置、发布链指针、
  文档表里的实施档案行（发布链全套仍在 [`docs/deploy-npm.md`](docs/deploy-npm.md) §8）。

### README 开头重写（§7.205）

三段话压成**一段 + 三条要点**：**默认不生效** / **不接管宿主设置** / **判据只有一条**
（审计链）。事实一个没改，只是把「默认关闭」与「标准模式下不生效」合并成一条。

### README 通篇重排（§7.206）

骨架改成 **简介 → 功能特性 → 安装 → 配置 → 验证 → 隐私与安全 → 文档 → 许可**：

- 「功能特性」表**前移到安装之前**（先讲能干什么，再讲怎么装）；
- 安装节加一张**通道对照表**（需要 pnpm / 需要 registry / 适用场景）；
- 「缺省」与「不配会怎样」两张表**合并**（重复的两行删掉）；
- 出网口径 / fail-closed / 密钥警告**收进独立的「隐私与安全」节**；
- 去掉 emoji 标题与口语化小节名，改成文档腔。

---

## [0.1.4] — 2026-11-12

**让网页搜索接上 DSH 配的 DeepSeek 模型，并修掉 CI 里「单测假绿」的那道门禁。**
（2026-11-12，§7.196 / §7.197 / §7.198 / §7.199 / §7.200 / §7.201）

### 行为修复：网页搜索报「registered but unavailable」

**症状**：桌面版问「查询最新的美国新闻」⇒ 报
`Error: configured web provider "tavily-bocha-fallback" is registered but unavailable`
⇒ **搜索根本没发生**（不是搜不到，是没搜）。

**根因**：我们的 Tier-3 凭据解析只认 `edge.json` 里的 `secrets.deepseekApiKey`，
而主机凭据服务 / DSH 账号令牌 / 启动环境**一条都没接** ⇒ 三把 key 全空 ⇒
`available()` 恒为 false ⇒ 宿主直接判定「配了但不可用」。

**修复**（§7.198）：凭据解析按**上游同款**顺序接上主机 ——
①`deepseek-account` 路由的**账号令牌** → ②`edge.json` 的 `secrets.deepseekApiKey`
→ ③**主机凭据服务**（`ctx.credentials.resolve`）→ ④**启动环境**。
且凭据通道**惰性取值**（每次搜索才取），宿主服务晚注册也不丢路。

**修好之后怎么用**（两条都不用改代码）：

1. **切到 DSH 里配的 DeepSeek 模型**（账号登录已在库里）⇒ 走 `deepseek-account`
   路由的会话自动用账号令牌搜；
2. 或给主机存一把 `DEEPSEEK_API_KEY`：桌面端「Plugins > Built-in plugin settings >
   Web search」写入即可。

### 修掉 CI 里「单测假绿」的那道门禁

**症状**：CI 的 `unit tests` job 红了百余轮，注解是
`vitest 没有写出 /tmp/vitest.json —— 计数门禁无法判定`，而诊断里
**`vitest exit=0`**、stdout 是默认 reporter 的输出、82 个文件 1629 条测试**全过**。

**根因**（§7.199）：命令写成 `pnpm test -- --reporter=json --outputFile=…`，
而 pnpm 在 runner 上把**字面 `--`** 透传给了脚本 ⇒ vitest 的 CLI 解析器（cac）
把 `--` 之后的一切当成**位置过滤器** ⇒ `--reporter` / `--outputFile` 被静默丢弃
⇒ 报告文件不生成、**退出码仍是 0** ⇒ 计数门禁被静默绕过（假绿）。

**修复**：参数**烤进 package.json 的 `test:ci` 脚本**，workflow 只调脚本名
（全程不出现 `--`），报告路径改用仓库内相对路径；并给
`scripts/verify-ci-build-chain.mjs` 加 3 项检查（挡「用 `--` 转发 vitest 参数」
这种写法，自证从 9 组增到 12 组）。

### 新增发布面：GitHub Release 上直接可装的预构建包

`v*` tag 推上去以后，Release 上会挂着**两个预构建 tar 包**：

```
https://github.com/chschytzmcy/dsh-edge-agent/releases/download/v0.1.4/dsh-edge-agent-desktop-safe.tar.gz
https://github.com/chschytzmcy/dsh-edge-agent/releases/download/v0.1.4/dsh-edge-agent-full.tar.gz
```

在桌面 App 的 **Plugins → Add plugin** 里粘 URL 就能装：**免构建授权、免 PATH 上的
pnpm、不需要 registry**（宿主把这种 URL 判成 tarball，不是 git 仓库）。

- **safe** 变体不重写宿主默认值（模型/人设/审批/沙箱/会话根/http-api 都留着）；
- **full** 变体与独立的 `dsh-edge` profile 同款行为（改写宿主默认值）。
  ⇒ npm 通道只发 safe，**full 只有这一条分发路**。

详见 [`docs/deploy-tarball.md` §8](docs/deploy-tarball.md)。

### 对使用者的影响

**出货文件的**数量**不变**（仍 241 个）—— 上面第一条是**行为修复**
（`lib/dsh-adapter/web-search-tavily-bocha.js` 的内容变了），
第二条只改 CI 与门禁，**不进 npm 包**（`docs/` 与 `scripts/` 都不在 `files` 白名单里）。

> ⚠️ **0.1.3 不含网页搜索的修复** ⇒ 停在 0.1.3 的用户仍会看到那个报错。

---

## [0.1.3] — 2026-11-12

**修掉「边缘模式发请求卡住」，并把发版前置条件变成第 29 道门禁。** 2026-11-11 → 2026-11-12。

### 行为修复：边缘模式「发请求卡住」

> ⚠️ **0.1.2 不含这个修复**（实测拆包确认：0.1.2 的 `input-guard.js` 不含
> `isLocalPoolForward` 判据，也没有 `llm-drain-deadline`）⇒ 停在 0.1.2 的用户仍会遇到；
> **本版（0.1.3）包含**。

**症状**：桌面版加载插件 → 边缘模式发请求 → 一直「等待」，LLM 调用 0 次，**不报错**。
**触发条件**：没有 `edge.json`（两池都落到 DELEGATE 转发模式）+ 宿主有可选模型 +
边缘模式 + 同会话第二轮。

**根因**：本地池的 DELEGATE 转发回来那一趟，provider 变成了宿主的目标路由；
`input-guard` 的改道判据只认 provider 名、**不认「这是本地池自己发起的转发」**
⇒ 那趟又被改道 ⇒ 乒乓 ⇒ 递归吃内存 ⇒ **请求根本没走到网络层** ⇒ promise 永不 settle
⇒ 所以表现是「卡住」而不是「报错」。

**修复**（§7.190 / §7.191 / §7.192）：改道判据加**转发标记**
（`__edgeLocalPoolForward`）—— 本地池自己的转发不再被改道；另加时限收口
（`llm-drain-deadline`）与「本地没配模型就取 DSH 配置的模型」。

**验证（本机 Windows 实盘，四轮独立冷启动、可复现）**：

| | 改道跳数 | 审计 `reroute` 次数 | 真实网络请求 | 收口 |
|---|---|---|---|---|
| 修复前（npm 0.1.1） | **41**（打满探针上限） | **20** | **0**（没出网） | 探针中止（≈500ms） |
| 修复后（本版构建） | **3** | **1** | REQ + RESP | ✅ 27–55ms |

四轮的原始输出与复现步骤见 [`docs/PROGRESS.md`](docs/PROGRESS.md) §7.194。

### 把「发版前置条件」从口头记忆变成门禁

这一段**不改变运行时行为** —— 它改的是**发布链本身**与**文档口径**；
本版的**行为变化**在上面的「行为修复」一节。（§7.193，2026-11-11）

#### 修掉的两处「与实际行为相反」

- **staged publishing 的上线判据**：旧文档写「`npm view <pkg> version` 返回 `0.0.0-stage`
  ⇒ 还卡着」—— 实测**不是这样**：发 0.1.2 时它返回的是**上一个真实版本 `0.1.1`**。
  ⇒ 正确判据是**看 `versions` 数组里有没有出现新版本**（`npm view <pkg> versions --json`）。
  拿旧判据会**误判成「已上线」**，进而提前推 tag、让 CI 撞 409。
- **trusted publisher 的前置**：旧文档只说「去包页登记 trusted publisher」，
  没写**账号必须已经开着 2FA**。npm 官方 `npm trust` 文档写明 trusted publisher 要求
  **账号级 2FA**，且**不接受**勾了 bypass 的 granular token ⇒ **顺序是「先开 2FA →
  再挂 trusted publisher」**。

#### 新的第 29 道门禁：`verify:npm-readiness`

- **9 项静态断言**（全离线、只读）：`publish.yml` 有 `id-token: write`、被 `v*` tag 触发、
  publish 步骤 cwd 是 `dist/.npm-stage`、命令带 `--access public` / `--ignore-scripts` /
  `--no-git-checks`、`--provenance` 与 `--no-provenance` 两条分支都在、有 tag↔version 断言、
  真的有 `pnpm publish`；
- **token 字面量扫描**：git 追踪的文件里不得出现 npm token 的字面量；
- **`--online`** 才查 registry 实况（匿名只读），**网络失败不算失败**；
- **机器查不了的事，如实报「查不了」**：账号 2FA 状态（CLI 实测 403）与 trusted publisher
  是否已挂（registry 无可查端点）—— 每次 CI 都打印「去哪确认、为什么机器查不了」。

## [0.1.2] — 2026-11-11

**修三处「写的东西与实际行为不一致」，并把 README 收瘦。** 2026-08-18 → 2026-11-11。

- **包内版本头的日期与提交数**：0.1.1 那行写的是「2026-11-10 / 506 次提交」——
  两个都不是发布时的真实值（真实发布时刻是 2026-11-11 19:33）。现在只写日期区间，
  把「次提交」整个去掉：它是**移动靶**（写完没几轮就又不对了）。
- **发布出去的 `package.json` 不再声明不在包里的东西**：0.1.1 的清单带着 50 余条
  `scripts.*` 和一整套 `devDependencies`，而它们指向的 `scripts/`、`src/`、`tests/`
  根本不在 tarball 里。现在发布走一个**消毒过的暂存目录**（`dist/.npm-stage/`）：
  内容 = safe 变体 + README + LICENSE，清单 = 去掉 `scripts` / `devDependencies` /
  `packageManager` 的那份。**出货文件逐个不变**（仍是 238 个），只有清单瘦了。
- **README 重写**：只讲 `desktop-safe` 一种变体，重点放在**「不配 edge.json 时会怎样」**
  与**「edge.json 怎么配」**上 —— npm 包页就是这份 README，访客第一眼要看到的正是
  「缺省下『本地』并不在本地」这件事。

## [0.1.1] — 2026-11-11

**首次发布到 npm registry。** 2026-08-18 → 2026-11-11。

### 加载通道

桌面版 DSH App 的 **Plugins → Add plugin** 支持四种输入，本包四条都能装：

| 通道 | 输入 | 要构建授权 | PATH 要有 pnpm |
|---|---|---|---|
| A 本地目录 | 绝对路径 | 否 | 否 |
| B GitHub 地址 | `git+ssh://git@github.com/<owner>/<repo>` | 是 | 是 |
| C npm 包名 | `@dsh-edge/dsh-edge-agent` | 否 | 否 |
| D tarball 路径 | `…/x.tar.gz` 绝对路径 | 否 | 否 |

装完**必须点「立即启用」** —— GUI 不会自动启用，否则启动时不加载、右栏不出现
Edge tab。装法细节见 [`docs/deploy-github.md`](docs/deploy-github.md) /
[`docs/deploy-npm.md`](docs/deploy-npm.md) / [`docs/deploy-tarball.md`](docs/deploy-tarball.md)。

### 隐私管线（边缘模式）

宿主自带四种工作方式之外，本包注册了第五种 —— **「边缘模式」= 标准模式 + 本项目的
全部功能**。标准模式下本项目的插件**完全不生效**（护栏 hook 挂在宿主的 scope 链上）；
判一个会话有没有走本项目链路，**唯一判据是审计链**。

- **输入防御**（prompt-guard）—— 正则 + 频率 + PII 分级 + 可选模型辅助检测；
- **隐私策略**（privacy-policy）—— 业务危险操作与 PII 护栏，REJECT 永不出网；
- **意图识别**（intent-router）—— 设备正则 → 决策模型 → LLM 分类器 → 规则层
  四级阶梯（**决策模型那档出厂是关的**，§7.182），实体护栏与云闸两道后处理闸收口；
- **脱敏**（sanitizer + pii-utils）—— 10 类 PII，可逆占位符，出网前替换、回程还原；
- **编排层**（input-guard）—— 挂 `agent/pre-step` / `agent/request` / `llm/stream`
  三个 hook，谁都绕不过；
- **Realm 闸门**—— LOCAL/CLOUD realm 分离，skill 与工具按 realm 放行；
- **威胁总线**（td-bus）—— 云请求速率 / 连续脱敏失败 / 权限拒绝 / 端点失联
  四档阈值，逐级升到 block。

### LLM 路由

两个池（`llm.local` / `llm.cloud`）**完全对称**，各三种模式：

| `baseUrl` | `delegate` | 行为 |
|---|---|---|
| 填了 | 任意 | **直连** —— edge 自有池，密钥走 `keyRef` |
| 留空 | `true`（默认） | **DELEGATE** —— 转发宿主 GUI 里选中的模型，凭据归宿主 |
| 留空 | `false` | **不注册路由** —— LOCAL 意图 fail-closed |

出网口径**不对称**（这是裁决，不是 bug）：云池只带「之前上过云的历史」；本地池带
**全部**历史。出网那一跳由 `host-egress-guard` 兜底裁剪（挂在 `llm/stream`
waterfall 上）。

### 边缘模式的模型路由（fail-closed）

宿主 0.2.2-rc.1 起，**路由只由会话级 `modelSelection` 决定** —— 在
`agent/request` 里改写 provider/model 会被宿主的 `prepareRequest()` 判非法并
抛错。因此本包：

- **边缘模式不改写会话选型**（§7.184）：`agent/created` / `agent-preset/selected`
  的钉选与「客户端回写后回钉」全部退役 ⇒ 宿主模型选择器保持主人选的那个；
- **出网那一跳改道**：本轮判定为 LOCAL、而实际请求的 provider 不是本地 provider
  ⇒ 在 `llm/stream` 把它换成 provider = 本地池（**不再拒绝这一轮**）；判定为
  CLOUD ⇒ 不改道（用哪个模型是用户自己的行为）；改不动 ⇒ fail-closed 抛错；
- 面板上的「模型」一行显示的是**这一轮真正会跑**的模型与它的真实落点
  （DELEGATE 下 = 委托解析出来的宿主 provider/model），不是配置里的默认值；
- **宿主模型选择器（输入框下方）里能选到本地池**：本地池在宿主的模型目录里
  **如实声明**它真正会跑的那**一个**模型（直连池 = 池自己的 model id；
  DELEGATE = 委托目标的 model id）—— 宿主会把「空目录的 provider」整组剔出
  目录，不声明就只剩「请选择模型」（§7.180）。**wire 上跑的模型、目录里声明的
  那一项、会话被补钉的 model id 三者是同一个 id**；云池仍然在目录里隐身；
- **选型不动，实际请求改道**（§7.184）：进入边缘模式时插件**一个字都不改**你的
  模型选择（宿主选择器里显示什么就一直是什么）；但「本轮必须留在设备上」这条不变式
  由**出网那一跳**保证 —— 本轮判定为 LOCAL 时，请求在 `llm/stream` 被换成
  provider = 本地池（model id 与 wire 同源）。改道改不动（本地路由不存在等）就
  **fail-closed 抛错**，绝不放行到云端。面板的「答案出口」会写明
  **「会话选型 → 实际落点」**，两边都摆出来。

npm 包**不带** `config/edge.json` ⇒ 没配本地端点时 `local-llm` 走 DELEGATE
（转发宿主提供商），但 provider 身份仍是 `local-llm` ⇒ 闸门照常放行、装上即用。

### 配置

只有**一个文件**：`edge.json`，两个合法落点（§7.182）：

| 顺位 | 路径 | 适合 |
|---|---|---|
| 1 | `<插件目录>/config/edge.json` | 「插件装在哪，配置就在哪」—— 打开插件目录就能看到能改的那个 |
| 2 | `~/.dsh-edge-agent/edge.json` | **推荐** —— 重装 / 删 profile 都活着，npm / git / tarball 三条通道通用 |

仓库的 `config/` 目录**不再放活配置**（明文 API key 不该待在 git checkout 里），
三条通道的产物里也本来就没有这个文件。`config/edge.example.json` 仍随产物发布，
但它只是**给你抄的模板**（模板里的部署值已并入代码默认值 ⇒ 「没配置文件」与
「照模板抄」行为一致）。

**出厂默认（§7.182 主人裁决）**：三个可选开关默认**关闭** ——
`jev.enabled`（决策模型是需要本地 `:8001` 服务的可选加速器）、
`webSearch.tavilyEnabled` / `webSearch.bochaEnabled`
（⇒ 出厂 web-search 链上只有 DeepSeek 档）。要开就显式写 `true`。
这三个开关在插件 `apply()` 时读取 ⇒ **改完要重启 App**。

`secrets` 段存明文 key，其他段按 `keyRef` 引用它。**`secrets` 与 `llm` 都不是必填**
—— 桌面版装法下空对象也能跑。

### 观测

- **审计链** —— 决策级事件，JSONL 落盘，Edge 面板按「意图 / 判定 / 路由决策 /
  LLM 调用」分栏；
- **ops log** —— 启动与运行期诊断；
- **Edge 标签页** —— 桌面右栏 4 个面板 + 会话摘要实时可视化；
- 面板「答案出口」一栏**认得 DELEGATE 出口行**（`llm.*.delegate.*`）：直连池与
  DELEGATE 池都会显示「池 + 模型」，不会在明明作答时写「路由未定」（§7.181）。
  LOCAL / CLOUD 的判据仍是**哪个池**（§7.130），DELEGATE 下额外多一行「真实
  落点」，如实说明这一轮转发去了哪儿；
- **LLM trace** —— 每次往返的请求/响应成对可查（凭据与 PII 脱敏）。

### 工程门禁

28 道门禁，验的是**产物**不是源码（`npm run build` 一条链跑完）：
构建链完整性、adapter 边界、上游契约、patch 面、preset 隔离、发布面、文档可达性、
安装包内容、tarball、CI 链不漂移、边缘模式选型回钉（§7.183）……

### 已知边界

见 [`docs/privacy-policy.md`](docs/privacy-policy.md#已知边界) —— 那里逐条记着
「当前**未实现或未接线**」的部分（例如标准模式会话不做出网裁剪、本地池 delegate
模式下内部阶段会跑在宿主模型上）。

---

## 更早的版本

`0.1.0` 及更早只存在于 git 历史里，**从未发布到 registry**。
逐条实施记录见 [`docs/PROGRESS.md`](docs/PROGRESS.md)。
