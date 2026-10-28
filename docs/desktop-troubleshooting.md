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
| A（默认） | 定期跑 `--apply` | 约每 10 天一次（每次启动 +227 B） |
| B | profile patch 里把桌面 web 端口**钉死**（`webserver` 行 `port` 不再取 `ctx.webStartup.port`）⇒ cookie 名恒定 ⇒ 永远只有 1 条 | 端口占用时宿主起不来；两个桌面实例不能并存 |
| C | 把 `connection` 行的 `cookieMaxAgeDays` 调到 1 | 每天过期 ⇒ jar 只留当天的；但**开着超过 1 天的桌面会话会在中途失效** |
| D | 启动器脚本先清 cookie 再拉起桌面版 | 需要改主人的快捷方式 |

> B/C 都要改主人的 `~/.dsh/profiles/desktop/cordis.patch.yml`（改宿主配置），
> 属**破坏性操作**，动手前必须先问过主人。

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

**现象**：会话右侧没有 Edge 页签；guide 里也没有 Edge 入口（只有宿主自带的
工作区文件 / 上下文 / 新建终端 / 浏览器）。

### 3.1 先分清「门控为 false」与「门控从未运行」

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
# 1) 名册对不对（默认 preset 是谁）
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
