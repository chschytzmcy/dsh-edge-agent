# 桌面版排障手册（DeepSeek Harness 桌面壳）

本文件记录**桌面壳（Electron 外壳）层**的故障：它们不在本项目代码里，但会
让主人以为「我们的插件坏了」。每条都给出**判据**（怎么确认是这个原因）
和**动作**（怎么修）。

> 取证方式：宿主源码 `deepseek-harness`（本地 checkout）+ 安装目录里的
> `resources/app.asar`（宿主打包产物）。下面每条结论都能在这两处复核。

---

## 1. 启动失败：`DeepSeek Harness is unavailable — desktop welcome: Web authentication failed`

**现象**：双击桌面版 ⇒ 弹「DeepSeek Harness is unavailable」⇒ 宿主被外壳拆掉。
崩溃报告在
`%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-<ts>-host.log`：

```
phase: startup
--- error ---
Error: desktop welcome: Web authentication failed
    at connectDesktopWelcome (…/app.asar/lib/main.js:8886:31)
```

### 1.1 根因链（逐环实证）

| 环 | 事实 | 出处 |
|---|---|---|
| ① 桌面宿主用**随机端口**起 web 服务 | `args: ['--no-open','--host','127.0.0.1','--port','0']` | `apps/desktop-host/src/index.ts:36` |
| ② 宿主按 **audience = host:port** 签发浏览器会话 cookie | cookie 名 = `dsh-auth-` + base64url(sha256(authority))，有效期 `cookieMaxAgeDays`（默认 30 天） | `@deepseek-ai/dsh-client-connection/lib/index.js` `cookieName()` / `sessionCookie()` |
| ③ 端口进了 cookie **名** ⇒ 每次启动都是**新名字** ⇒ 旧 cookie 永不命中、永不过期 | Chromium cookie 不按端口匹配，同 host 下全部累积 | 同上 |
| ④ 外壳 welcome 握手用 Electron `net.fetch(url,{credentials:'include'})` —— **带 cookie jar** | `connectDesktopWelcome` | `app.asar/lib/main.js:8883-8887` |
| ⑤ 宿主 web 服务是裸 `createServer(listener)`，**没设 `maxHeaderSize`** ⇒ Node 默认 **16384 B** | — | `@deepseek-ai/dsh-host-webserver/lib/index.js:412` |
| ⑥ 请求头超限 ⇒ 宿主回 **431 Request Header Fields Too Large** ⇒ `!authenticated.ok` ⇒ 抛错 ⇒ 外壳拆宿主 | — | `main.js:8887` |

**关键的不对称**：外壳第一步 `authenticateWebHost`（`main.js:8230`）用的是
**Node 的 `fetch`** —— 它**没有 cookie jar**，请求头很小 ⇒ 303 正常。
所以「直连 web 服务一切正常，桌面版却起不来」是必然的，不是玄学。

### 1.2 实测（2026-10-28）

现场 cookie 库：**71 条** `dsh-auth-*`（全是 `127.0.0.1`，**没有别的 cookie**），
Cookie 头合计 **16,117 B**。

用真实 cookie 回放打宿主（裸 socket，手工组装 Chromium 头）：

```
A) token 请求 + 71 条陈旧 cookie (16,186 B) -> HTTP/1.1 431 Request Header Fields Too Large
B) 重定向 + 陈旧 + 新 cookie   (16,414 B) -> HTTP/1.1 431 Request Header Fields Too Large
C) 只有新 cookie                        -> HTTP/1.1 200 OK
```

**每条 cookie 227 B**（名 52 + 值 173 + 分隔符）⇒ **约 70 次启动后必然撞线**
（实测每天 ~7 次启动 ⇒ ~10 天复现一次）。

### 1.3 动作

> **§7.145-A 起（2026-10-29）不用手动跑了**：本仓的 `desktop-cookie-janitor` 插件
> 在**宿主启动的同一进程里**（握手之前）自动做两件事 ——
> ① 把宿主 web 服务的 `server.maxHeaderSize` 抬到 64 KB；
> ② 删掉**死端口**的 `dsh-auth-*` cookie（只留当前端口那一条）。
> **不改宿主、不改主人的 profile、不改启动习惯。**
> 现场日志（`~/.dsh-edge-agent/log/dsh-edge-agent-desktop.log`）：
>
> ```
> INFO [desktop-cookie-janitor] maxHeaderSize raised → 65536
> INFO [desktop-cookie-janitor] jar=…\dsh-desktop\Network\Cookies opened=true auth=1 removed=1 projected=600B launchesLeft=69
> ```
>
> 下面两条命令是**手工兜底 / 排障取证**（插件没挂上、或想先看现状时用）：

```bash
# 1) 先退出桌面版（cookie 库被 Electron 独占锁，运行时改不了）
# 2) 报告现状（不改任何东西）
node scripts/reset-desktop-auth-cookies.mjs
#    jar            : …\dsh-desktop\Network\Cookies
#    cookies total  : 71
#      dsh-auth-*   : 71
#      stale (dead) : 71
#    projected req  : 16717 B / limit 16384 B
#    launches left  : ~0
#    VERDICT        : OVER LIMIT — 桌面版 welcome 握手会拿到 431

# 3) 清掉「端口已死」的陈旧 cookie（保留当前会话那条）
node scripts/reset-desktop-auth-cookies.mjs --apply
```

删除整库（`Network\Cookies` + `Network\Cookies-journal`）也行 —— 现场证明
里面**只有** `dsh-auth-*`，零副作用；但会把应用内浏览器（侧边栏 browser）
登录过的站点一起登出，**优先用 `--apply` 精准删**。

### 1.4 复发与预防

| 方案 | 做法 | 代价 |
|---|---|---|
| **E（默认，§7.145-A）** | **本仓插件自动**：开机抬 `maxHeaderSize` 64 KB + 清死端口 cookie | 无（不改宿主 / profile / 启动习惯） |
| A | 定期跑 `--apply` | 约每 10 天一次（每次启动 +227 B） |
| B | profile patch 里把桌面 web 端口**钉死**（`webserver` 行 `port` 不再取 `ctx.webStartup.port`）⇒ cookie 名恒定 ⇒ 永远只有 1 条 | 端口占用时宿主起不来；两个桌面实例不能并存 |
| C | 把 `connection` 行的 `cookieMaxAgeDays` 调到 1 | 每天过期 ⇒ jar 只留当天的；但**开着超过 1 天的桌面会话会在中途失效** |
| D | 启动器脚本先清 cookie 再拉起桌面版 | 需要改主人的快捷方式 |

> B/C/D 都要改主人的 `~/.dsh/profiles/desktop/cordis.patch.yml`（改宿主配置），
> 属**破坏性操作**，动手前必须先问过主人。**E 不需要** —— 它在插件里，且自带
> `process.versions.electron` 判据，headless profile（web / tui）直接跳过。
>
> E 与 C 互斥：C 把 cookie 寿命压到 1 天 ⇒ **开着超过 1 天的桌面会话会中途 401**，
> 所以本仓**不动** `cookieMaxAgeDays`。

### 1.5 别浪费时间的方向（本轮已排除）

- **不是**本项目引起：A/B 回退到 `a0d9da3` 的产物重建部署 ⇒ 同样失败。
- **不是**系统代理：`--no-proxy-server` 启动仍失败；代理对 127.0.0.1 正确绕过。
- **不是**本项目插件重复挂载：`edge-context-view` 每轮只挂载 1 次。
- **不是** profile `package.json` / `cordis.patch.yml` 损坏：内容正常。

---

## 2. 活体状态：preset 有没有挂上、是不是默认

「边缘模式卡片还在吗」「它是不是当前默认」**从磁盘答不出来**：
挂载结果是运行时状态，`selectedDefault` 是 **live setting**（设置页
「设为默认」写的），不是 profile 里的静态行。

用探针问宿主本身（复用外壳同款的两步握手）：

```bash
node scripts/probe-desktop-preset-roster.mjs "http://127.0.0.1:63976/?token=…"
# preset                 default  name
# standard               -
# ptc                    -
# minimal                -
# cordis                 -
# edge                   YES      边缘模式
#
# edge preset: healthy, isDefault=true
```

URL 取桌面版启动日志里的 `dsh web: http://127.0.0.1:<port>/?token=…` 一行
（每次启动端口都变，token 一次性有效）。

把某个 preset 设为默认（等价于设置页的「设为默认」）：

```bash
node scripts/probe-desktop-preset-roster.mjs "<URL>" --set-default edge
```

---

## 3. Edge tab 不出现（**任何**工作模式都没有）

> **§7.142 起口径反转**：Edge tab 类型是**常驻注册**的 —— 任何工作方式的会话右栏
> 都应该有这个页签（只是**边缘模式会话会自己打开**，其它模式要手点）。所以
> **「看不到 Edge 页签」现在一律是故障**，不再是「默认 preset 不是边缘模式」的
> 正常表现。下面 3.1 的两分法只适用于 §7.139 之前的老版本。

**现象**：会话右侧没有 Edge 页签；guide 里也没有 Edge 入口（只有宿主自带的
工作区文件 / 上下文 / 新建终端 / 浏览器）。

### 3.1 先分清「门控为 false」与「门控从未运行」

> 仅适用于 §7.139 及更早（当时 tab 类型按默认 preset 注册 / 注销）。
> §7.142 之后 tab 常驻 ⇒ 无论名册默认是谁，页签都该在。

两者现象相同，判据不同：

| 判据 | 门控为 false（名册说不是边缘模式） | 门控从未运行（读名册就抛了） |
|---|---|---|
| 探针读活体 roster | `edge.isDefault=false` | `edge.isDefault=true`、healthy |
| web 端 network 里 `/api/agentPresets/list` | 有 5s 间隔的轮询 | **只有启动突发的几次，没有间隔** |
| 宿主 guide 里有没有 Edge 入口 | 没有 | 没有 |

**两栏都指向第二列 ⇒ 就是这一类。**

### 3.2 根因（2026-10-28 实锤，§7.139）

Cordis 的**注入作用域是 context PROXY**：读一个该作用域没有提供的服务名会
**抛错** —— `cannot get property "list" without inject`
（`@deepseek-ai/cordis` lib/index.js:676）。

我们 §7.136 的 `pickAgentPresets(raw)` 依次探测 `raw.list` / `raw.agentPresets`
/ `raw.remote.agentPresets` —— 前两个名字本作用域**没有提供** ⇒ 探测第一下就抛
⇒ 名册 watcher 当场死 ⇒ **Edge tab 类型从未注册** ⇒ 任何工作模式都不会出现。

修法：所有作用域属性读取都包一层 try/catch（`readProperty()`），只走已知安全的
路径（`raw.remote.agentPresets`）。

**门禁为什么当时没抓到**：`scripts/_simulate-client-mount.mjs` 的 mock 把注入作用域
做成了**普通对象**（读不到就是 `undefined`）⇒ 复刻不出 proxy 的抛错语义。
现已改成复刻 Cordis 语义（读未提供的名字就抛错）+ 断言「名册必须真的被读到」。

### 3.3 动作

```bash
# 1) 名册对不对（默认 preset 是谁、边缘模式挂上了没有）
node scripts/probe-desktop-preset-roster.mjs "http://127.0.0.1:<port>/?token=…"

# 2) 客户端 bundle 是不是新版（按 rev 取，看是否含 diag 标记/体积变化）
#    宿主启动清单：window.__DSH_BOOT__ 里的 entries[].url
# 3) 门禁自证（本地就能复现这类故障）
node scripts/_simulate-client-mount.mjs
```

### 3.4 附带结论：宿主**从不自动打开任何 tab**

默认页是 guide，tab 要从 guide 点开
（`dsh-client-ui-sidebar-right/src/client/contract/seed.ts:26` `defaultSeed`：
只有唯一 guide 条目才作默认页，否则默认页是 guide）。
所以「边缘模式自动打开 Edge tab」是我们自己做的（`ctx.get('sidebarRight').openTab`），
不是宿主行为 —— 升级宿主后这条要重新验证。

### 3.5 §7.142 新增的判据：页签在，但**不自动打开**

**现象**：Edge 页签在右栏（可点开），但边缘模式会话上台时它没有自动展开。

判据看**会话级**信号，不是名册默认项：

- 宿主自己的读法是 `session.projectionValues.agentPreset`
  （`ui-agent-preset/src/client/seat-store.ts:265` `presetOf`）—— 客户端用同一个来源。
- 该会话的 `agentPreset` 不是 `edge` ⇒ 不自动打开（**正常**：只有边缘模式会话
  才自己开面板；标准模式会话要手点，页签数据是空的）。
- 宿主读不到该会话的投影值（会话刚建、列表还没同步）⇒ **回落**到名册默认项；
  这时把默认设成边缘模式就能自动开（`--set-default edge`）。

**切回标准模式不会把已打开的面板关掉**（§7.142）—— 只有主人自己关。

### 3.6 §7.145-C 新增的判据：Edge tab **整个不见了**（连 guide 卡片都没有）

**现象**：guide 的卡片列表里**没有「Edge」**，右栏 tab strip 里也**没有 chip** ——
点开右栏只有宿主的「开始」页。而**宿主半边的日志完全正常**
（ops log 里 `[edge-context-view] apply() called — Edge tab host half mounting`）。

> **这不是 §7.139 那个门控问题**（那次的判据是「名册轮询没有 5s 间隔」），
> 也不是 §7.142 的「页签在但不自动打开」。这一条是**浏览器半边根本没装进 bundle**。

**根因**：`compile` = `clean-lib` + `tsc` ⇒ **清空整个 `lib/`**；浏览器半边
`lib/client.js` 由**另一步** `build:client`（esbuild）产出。重建时若只跑了
`compile` + `build:installable`（漏掉 `build:client`），installable 里就没有
`lib/client.js` ⇒ 宿主半边照常挂载、浏览器半边**从未注册** ⇒ **完全静默**。

**判据（一条就够）**：

```bash
# 桌面 profile 的 bundle 是 junction 指向 dist/installable/<variant>
ls -l "$HOME/.dsh/profiles/desktop/node_modules/@deepseek-harness-edge-agent/dsh-edge-agent/lib/client.js"
# 没有这个文件 ⇒ 就是这一类
```

**动作**：

```bash
npm run build:client        # 只补浏览器半边
npm run build:installable   # 重新发布（桌面 profile 是 junction ⇒ 重建即生效，不用重装插件）
```

> §7.145-C 起 `scripts/rebuild-installable.mjs` **自己会拦**：声明了 `dsh.client`
> 却找不到 `exports['./client']` ⇒ 直接 exit 1 并提示去跑 `build:client`。
> 所以「发布出去才发现缺半边」这条路已经封死；这一节留给**旧版本 installable** 的现场。

---

## 4. 通用排查动作

| 想知道的 | 去哪看 |
|---|---|
| 桌面壳崩了 | `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-<ts>-host.log` |
| 宿主自己的 stdout | 启动日志里的 `dsh web: …` 行所在的那个日志文件 |
| 我们的插件有没有挂上 | `~/.dsh-edge-agent/log/dsh-edge-agent-desktop.log`（ops log） |
| 我们的 hook 挂在哪个 scope | `~/.dsh-edge-agent/audit/audit.plain.jsonl`（`scopedTo` 字段） |
| 宿主 web 服务能不能直连 | 启动日志里的 `dsh web:` URL，浏览器打开即可（Node fetch 那条路是好的） |
| preset roster / live settings | `scripts/probe-desktop-preset-roster.mjs` |
| 某会话有没有走本项目链路 | `node scripts/probe-session-audit.mjs --session <id>`（判据 = **审计链有没有带这个 sessionId 的事件**；preset 标签不可作判据，§7.140） |

宿主侧源码位置（安装目录）：

```
app.asar/lib/main.js                                   外壳：authenticateWebHost:8230 / connectDesktopWelcome:8883
app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js
app.asar/dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js   BrowserAuth.authorizeIndex
app.asar/dsh/node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js       createServer:412
```

宿主源码 checkout（更易读）：`C:/Users/cheng/GolandProjects/gitlab/deepseek-harness`
（`apps/desktop-host/src/index.ts`、`packages/settings/settings/src/index.ts`、
`packages/preset/agent-preset-registry/src/index.ts`、
`packages/client/ui-sidebar-right/src/client/tab-registry.ts`）。

---

## 5. 判定一个会话有没有走本项目的链路（§7.140）

**别用 preset 标签判**。会话记录里有两个 `agentPreset`，都可能是过期的：

| 位置 | 语义 | 坑 |
|---|---|---|
| 会话头 `session.v4.jsonl.zstd` → `header.agentPreset` | **创建时**的快照 | 建会后再切工作方式，头上还是旧值（实测：头=edge、实际跑 standard） |
| projcache `session_projcache/sessions/*.json` → `rows.agentPreset.val` | 客户端回写的当前选择 | 历史上大量标 standard 的会话其实跑过本项目链路（§7.136 之前 hook 是 `{global:true}`） |

**唯一判据 = 审计链**：本项目的每个行为插件都往
`~/.dsh-edge-agent/audit/audit.plain.jsonl` 写带 `sessionId` 的事件；
没被碰过的会话连一条都没有。

```bash
# 单会话取证（结论 + 触发的能力清单 + 两处标签对照）
node scripts/probe-session-audit.mjs --session 8ff22795-c8e0-4777-9b52-cd74d8e816ba

# 全量对照表（TOUCHED / clean + 标签不一致标记）
node scripts/probe-session-audit.mjs

# 门禁自证（已在 verify:build 链里：verify:session-audit）
node scripts/probe-session-audit.mjs --selftest
```

参考实测（2026-10-28，隔离版部署后）：

- 标准模式会话「询问AI助手能力」⇒ `clean`（审计链 0 事件，全程宿主默认
  `qwen-token-plan-cn/qwen3.8-flash`）；
- 边缘模式会话「Greeting」⇒ `TOUCHED`（12 事件：守卫 → 意图 → 路由改写 →
  `local-llm` → 还原）。

另注意 ops log 里 `[edge-tools-registry] tools/change …` 在标准模式也会出现 ——
它只是**观测**宿主可见工具表（`src/dsh-adapter/tools.ts`，不拦截不删改）；
看到它 ≠ 插件在生效。

---

## 6. Edge 面板显示「尚未绑定会话」—— **不是故障**（§7.145-B）

**现象**：打开 Edge 面板，看到的是

```
尚未绑定会话
这一页还没有属于这个会话的一轮 —— 下面是全局信号，不是某一轮。开始一轮对话后，这里会变成该会话的记录。
暂无全局信号
```

**这是设计，不是坏了。** 判据是**行**不是 id：

- 宿主把「没有 sessionId 的审计行」放进兜底桶 `_global`，并且对**任何**会话的快照
  都把 `_global` **合并进来**；
- 行上带 `turn`：会话自己的行 `turn >= 0`，全局行 `turn === -1`；
- ⇒ **面板里没有一条属于本会话的行 ⇒ 面板没有「这一轮」可显示**。

桌面版开机就会建一个**草稿会话**（`POST /api/session/create`），所以 guide 页 /
新建会话页拿到的是**真实且非空**的 `sessionId` —— 光看 id 判断不出来，这也正是
修复前「轮次 0 / 本轮：等待意图判定 / 五节点流程 / LLM 调用 0」那套误导壳
还能出现的原因。

| 场景 | 面板显示 |
|---|---|
| 新建会话页 / guide 页 / 还没发第一条消息 | **尚未绑定会话** + 全局信号（一条不藏，只是标成全局） |
| 会话已经跑过一轮（或已有属于它的行） | 正常面板：轮次 / verdict / 五节点流程 / LLM 调用 |

**全局信号一条都不藏**（§7.129 的原则：不隐藏真发生的事，只是把它标对）。

> 若要确认「已绑定」那一支：发一条消息即可（`turn/start` 一落，轮次计数就起来了）。
> 注意宿主重启后轮次计数是**内存态**，老会话在宿主的 edge 面板里暂时没有数据 ——
> 这时面板会显示「尚未绑定会话」，发一条消息后就变成该会话的记录。

---

## 7. 安装期常见报错速查

> 2026-10-30 从根 README 迁入（README 只留最基本的介绍与部署信息）。
> 与 §1–§6 的区别：那一节排的是**运行期**故障，这一节排的是**装的时候**报错。

| 现象 | 排查 |
|---|---|
| `未检测到 dsh CLI` | `npm install -g @deepseek-ai/dsh` 后 `hash -r` |
| `未检测到 pnpm` | `npm install -g pnpm` 或 `corepack enable pnpm`（桌面版另见 [`deploy-github.md` §2.5](deploy-github.md)） |
| dsh-tui 启动失败 | `tail -50 ~/.dsh/profiles/dsh-tui/run.log` 看 `intentRouter: found` 行 |
| web profile 启动后 `:3080` 不 listen | `tail -50 ~/.dsh/profiles/web/run.log` 看 `dsh web:` 行；可能是 webui 包未装，跑 `dsh plugin --profile web add @deepseek-ai/dsh-web @deepseek-ai/dsh-web-ui-all` |
| 19 个 plugin 只挂载 dsh-base 的 30 个（bundle 没生效） | `dsh plugin --profile dsh-tui add @deepseek-harness-edge-agent/dsh-edge-agent` 重装；或者 `install.sh §2.6 + §2.7` 没跑，手动 cp `cordis.patch.yml` 到嵌套包根 |
| `adapter boundary violated` | 把 `@deepseek-ai/*` 的 import 移到 `src/dsh-adapter/` 内（或经 `src/dsh-adapter/types.ts` 重新导出） |
| `upstream contract violated` | 上游 DSH 包低于最低兼容版本（当前 `0.2.1-rc.2`），或各 `@deepseek-ai/dsh-*` 包版本不一致；运行 `pnpm install` 或 `pnpm update @deepseek-ai/dsh-agent @deepseek-ai/dsh-llm ...` |
| Windows：`a local path must be absolute` | 填的是 Git Bash 的 `/c/Users/...`（MSYS2 虚拟路径），桌面 App 只认原生 `C:\Users\...`。用构建脚本输出的路径 |
| Windows：`Cannot connect to C: resolve failed` | tar 把 `C:` 当成远程主机名（GNU tar 的 `host:path` 语法）。当前脚本已规避（tar 只收相对路径）；若仍遇到，检查是否有旧版 `build-desktop-bundle.sh` |
| Windows：`/c/Program: No such file or directory` | 旧版 `build-desktop-bundle.sh` 把 node+pnpm 拼成字符串再未加引号展开，路径含空格被切开。用 `npm run build:windows` |
| Windows：`rename still locked (EPERM)` → `in-place` | **不是错误**——桌面 App 开着并持有 `dist/installable/` 句柄，脚本降级为逐条覆盖，`link:` 目标持续有效，重启 App 即生效。想要干净原子换目录就退出 App 再跑 |
| `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` | git 通道要放行构建脚本；键要写**稳定键**（去掉 `#commit`），且 https / ssh **两种形态都要写**。见 [`deploy-github.md` §3.2](deploy-github.md) |
| `'pnpm' is not recognized` | git 通道：PATH 上要有 pnpm（`npm i -g pnpm`，装完**重启桌面 App**）。见 [`deploy-github.md` §2.5](deploy-github.md) |
| `package exports missing from tarball: lib/client.js` | `prepare` 缺 `build:client` ⇒ 浏览器半侧没产出。见 [`deploy-github.md` §2.2](deploy-github.md) |
| 装完右栏没有 Edge tab | ① 忘了点「立即启用」（GUI 不会自动启用）；② 目录里没有 `lib/client.js`（源码目录直接装的典型症状）；③ 见 §3 |

## 8. 相关文档

- [`load-into-local-dsh.md`](load-into-local-dsh.md) — 装进本地 DSH（三条路）
- [`deploy-github.md`](deploy-github.md) — 从 GitHub 仓库地址安装
- [`deploy-npm.md`](deploy-npm.md) — 从 npm 包名安装
- [`config-reference.md`](config-reference.md) — 完整配置清单
- [`architecture.md`](architecture.md) — 架构与插件开发

