# 最小部署清单:每个文件里装了什么、起什么作用

> 配套阅读:architecture.md「📦 最小部署清单」一节(5 项清单 + 手工部署步骤)。
> 本文只回答一个问题:**每个文件的内容物与具体职责**——只保留最终信息;测试过程与各轮 boot 签名逐字存档在 `docs/PROGRESS.md` §7.59 系列(user 拍板 2026-09-16)。
> 同步语义以 §7.57 修复后为准:nested `package.json`/`cordis.patch.yml`/`lib/` 每次 install 都与 repo diff-then-copy,profile 注册缺失即 fail-fast。⚠️ 极简线的**结论**仍在本文(② 节铁律 3 + 部署验收推论),但**可复现载体已退役**(§7.170:`bundle-minimal/` + rig 脚本 + CI 漂移锁测试成套删除)。

## 30 秒版:三件套的关系

```
package.json      = 花名册/电话本   "队里有什么人、去哪找"        —— Node 读
cordis.patch.yml  = 派工单/点菜单   "今天谁上岗、按什么参数、裁谁"  —— DSH 读
lib/**/*.js       = 工人本体        真实执行的代码
```

DSH 启动:按 package.json 里的指针读到派工单 → insert 点名 → 查花名册(exports)定位工位 → 到 lib 提货执行。**三者缺一,一个插件都装不上——且 2026-09-16 §7.59 实机探针证明:缺任何一环都是【当场响】(boot 报错退出),不是静默降级;"安静地一个都不装"只发生在 ④ bundles[] 未注册时(实机探针逐轮记录存 PROGRESS §7.59)。**

## ① `~/.dsh/profiles/<p>/node_modules/@dsh-edge/dsh-edge-agent/package.json`

repo 根 `package.json` 的**逐字节镜像**(install.sh §2.8 diff-then-copy;§7.57 起不再是"缺才拷")。内容物:

| 字段 | 内容 | 具体作用 |
|---|---|---|
| `name` / `version` | `@dsh-edge/dsh-edge-agent` / `0.1.0` | bundle 身份证;profile `bundles` 数组按 `name` 找到这个目录 |
| `exports` | **36 条子路径** → **路径指针**(每条就是 `{'types': '…d.ts', 'import': '…js'}` 两行,不含代码) | Node 标准的子路径路由表,决定 `import '包名/子路径'` 能否解析到文件。**不是插件列表**:36 条 = **31 条代码入口**(指向 `lib/**/*.js`)+ 3 条 `.yml` 配置资源(`./cordis.patch.yml` + 两个 `./presets/edge*.patch.yml`)+ 2 条特例(`./package.json`、`./invariant`)。lib 下共 **72 个 `.js`**,只有这 31 个入口对外可达,其余 41 个是包内私有。新增插件忘加 exports 条目 → Node 抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`(实机核过;整包缺失才是 `ERR_MODULE_NOT_FOUND`);这也是镜像必须跟 repo 同步的原因 |
| `dsh.bundle.patch` | **`["./cordis.desktop-safe.patch.yml", "./presets/edge.desktop-safe.patch.yml"]`**(数组) | 整张花名册与派工单的**唯一交点**:告诉 DSH loader 去哪读 ②。**数组**是 §7.135 起的形态——工作方式的插件列表住在 preset 里,顶层 patch 只留宿主行覆盖(见 ②)。实测:已注册 bundle 的 package.json 删掉 `dsh.bundle` 字段 → loadProfile 当场抛 `declares no dsh.bundle in its package.json`(硬失败,并非"②变死文件后照常 boot") |
| `peerDependencies` | `@deepseek-ai/* = 0.1.2-rc.1` 等 | **纯声明**:bundle 零自购依赖,运行时一律走 `~/.dsh/profiles/node_modules/` hoist 链解析(所以嵌套目录下没有自己的 node_modules)。peerDeps 漂移不影响运行,只有 `exports` 漂移会炸 |
| `files` | lib/ scripts/ presets/ + 若干根文件 | `make package` 白名单,决定 release tarball 内容;运行时不读 |

## ② 同目录 `cordis.patch.yml` — 派工单:整个 DSH 组装的差量指令

注意语义精度:它**不只说"本 bundle 要做什么"**,而是"装了本 bundle 之后,整个 DSH 的组装方案要做哪些改动"——三段里只有 insert 是自家事,config/disable 共 40 处动作的对象是**上游/宿主插件**。只写差量,DSH 启动时按层合并:`dsh-base → 宿主(dsh-web-app/dsh-tui) → 本 patch → ~/.dsh/profiles/<p>/cordis.patch.yml(用户皮肤,最后压顶)`。活例:§7.61 `profiles/dsh-edge/cordis.patch.yml`——无宿主 headless profile 用皮肤层把 audit-log root 分流,其 config 行是**整键替换**(必须全量重述 bundle 层该 id 的所有键,只写增量会丢键;头注释有此坑的完整说明)。

> **§7.135/§7.136 之后的结构(2026-10-29 §7.146 刷新)**:本项目的**行为插件行已全部迁进 preset**
> (`presets/edge*.patch.yml`),顶层 patch 只留**宿主行覆盖** + **必须留在宿主树的少数几行**。
> `dsh.bundle.patch` 因此是**数组**:顶层 patch + preset patch 两份一起加载。
> 下文三行按当前形态描述;§7.135 之前"顶层 insert 段装着自家全部插件"的形态已成历史。

- **顶层 insert 段:4 行(全是被逼留下的)** —— `dsh-edge-agent`(裸包名行)、`file-logger`、`audit-log`、`desktop-cookie-janitor`。这四行**没有一行是"方便"留下的**:`dsh-edge-agent` 裸包名行是**宿主机制逼的**(宿主的 client-modules 只扫宿主 Loader 的 entries,preset 子树不在其中 ⇒ Edge tab 的浏览器半边只能从这里被发现);`audit-log` / `file-logger` 是**宿主机制逼的**(裸包名行 inject `auditLog`,且 `installFileLogger` 会先占住 `fileLogger` 服务名 ⇒ 必须在 root realm 且 file-logger 更早装载);`desktop-cookie-janitor` 是**时序逼的**(宿主外壳的 welcome 握手发生在**任何工作方式选定之前** ⇒ 修 431 的插件必须在 preset 之外,§7.145-A)。理由类别已写进 `scripts/verify-patch-surface.ts` 的 `HOST_FORCED_ROWS`,防滥用先例。
- **本项目的插件行在 preset 里** —— `presets/edge.patch.yml`(full/CLI 变体)= **22 行宿主标准插件 + 17 行本项目插件**;`presets/edge.desktop-safe.patch.yml`(桌面变体)= **22 + 15**(桌面版多 `edge-context-view`,少 `http-api` / `etscli-tools` 等)。insert 的 `name` 就是子路径引用本身(如 `@dsh-edge/dsh-edge-agent/file-logger`)→ 经 ① 的 exports 解析到 lib。
- **config 覆盖(定参数)**:改**已存在插件**的参数——persona、agent 列表、approval 策略、session 存储根、sandbox 模式、`tool-web` 的 search/fetch provider、`web` 的 provider 链、`dsh-tui-agent-presets` 的默认 preset。值多为 `!!js` 表达式(如 `parseInt(process.env.DSH_EDGE_LOG_MAX_AGE_DAYS ?? '1', 10)`),所以 `.env.sh` 不改文件即可覆盖——这也是"改 env 必须重启进程"的机制根源。**当前数量**:full 变体顶层 **8 行** config 覆盖;desktop-safe 变体 **2 行**。
- **disable(撤编)**:剔除 edge 场景不用的上游/宿主插件(云直连、dsh 原生模块)。**当前数量**:full 变体顶层 **30 行**;desktop-safe 变体 **1 行**。另有 11 行「裸行」只声明 `- id:` 不带 config/disable —— 那是**重新启用/重新声明**宿主行(如 `tool-bash`、`goal`),不是覆盖。

三条铁律(实证):
1. **patch 说了算**:bundle 能力在 lib 里写了也不执行,上不上岗、按什么参数,全看这份派工单——聚合 id `dsh-edge-agent` 被 disable(`src/dsh-adapter/index.ts:apply()` 不执行),新增聚合级 wiring 必须另起独立插件 id。
2. **系统级、启动时**:一次组装管整个进程生命周期;与会话级的 ⑤ `agent.cordis.yml` 正交,别混。
3. **inject 只能加不能减**(§7.59 源码实证):代码里的 `export const inject` 会被 loader 追加合并进插件依赖,yml 无法撤销。所以"最小部署形态"绕不开包的硬依赖闭包(此结论由已退役的极简 rig 推导得出,§7.170 保留结论)——而且**被点名的两个能力插件还不是执法者**:prompt-guard / privacy-policy 是纯 service,自己不挂事件 hook;真正挂在 `agent/pre-step` / `llm/stream` / `agent/request` 上、聊天时挨个调用它们的唯一执法者是 **input-guard**。它的传递依赖闭包 = **最小执法集,共 7 插件**:

   ```
   宿主提供,无需点:llm▲(dsh-llm)、skills▲(宿主 bundle)

   input-guard(唯一执法者)
   ├─ prompt-guard        ── privacyPolicy, auditLog, llm▲
   ├─ privacy-policy      ── auditLog
   ├─ intent-router       ── llm▲, auditLog
   ├─ sanitizer-pipeline  ── privacyPolicy, auditLog
   ├─ realm-skill-bridge  ── auditLog, skills▲
   └─ audit-log           ── (无依赖)
   ```

   **哪怕派工单只写 input-guard 一个名字,闭包也会逼你点全 7 个**;只点两个能力插件的结果是 boot 硬失败(`2 entries did not activate` + 逐项 `pending (waiting for service…)`,静默 INACTIVE 是 cordis 核心行为,dsh 宿主的 `assertEntriesActivated` 明炸;逐字签名存 PROGRESS §7.59)。想装能力,必须连依赖一起点。

   **这 7 行现在分居两层**(§7.135/§7.136 之后):`input-guard` / `prompt-guard` / `privacy-policy` / `intent-router` / `sanitizer-pipeline` / `realm-skill-bridge` 六行在 **preset** 里(跟着「边缘模式」工作方式走);`audit-log` 一行在**宿主树**顶层 insert 段(它 inject `auditLog` 且要占住 `fileLogger` 服务名 ⇒ 必须 root realm)。**闭包跨层也要点全**——preset 里少一行,`input-guard` 照样 ACTIVE 却一条都不拦。

部署验收推论:"装上"分三层,**mount(挂上)≠ active(活了)≠ enforced(拦得住)**——boot 不报错只证明前两层,依赖闭包不齐时插件可能 ACTIVE 却一条都不拦;执法的真凭据是审计落盘出现 `blocked.attack` / `blocked.policy` 执法行(这也正是 §7.57 把 ④ 未注册改 fail-fast 的原因:缺件链路里唯一静默的就是它,其余缺口全部当场响,行为见 ①② 表格与文末差异速记)。

## ③ 同目录 `lib/**/*.js` — 插件实现本体(代码真正所在)

`tsc` 编译产物,①的 `exports.import` 指针全部指向这里(除 `./package.json` 与三条 `.yml` 资源指针——`./cordis.patch.yml` + 两个 `./presets/edge*.patch.yml`)。**注意目录名误导**:tsconfig 的 `outDir` 是 `"lib/types"`(历史命名),所以运行时 `.js` 实际位于 `lib/types/dsh-adapter/*.js`——`lib/types/` 不是"纯类型目录",每个模块三份产物(`.js` 实现 / `.d.ts` 类型 / `.map` 调试映射),Node 运行时只读 `.js`。另有 **41 个包内私有 `.js`**(src 根级兼容中转 + 内部工具;lib 下共 72 个 `.js`,只有 31 个对外可达),不在 exports 里、外部 import 不到,但被包内模块互 import——手工部署仍须 `rsync -a lib/` 整目录,不能挑文件。

双向关系别搞反:lib 是 **DSH 调它**(插件被 mount,调用面 = 每模块的 cordis 四件套 `name`/`inject`/`Config`/`apply`);它同时 **调 DSH**(①的 peerDependencies,经 hoist 解析)。

## ④ `~/.dsh/profiles/<p>/package.json` 的注册(文件本体是宿主清单,无 repo 源)

两个作用点:
- `dsh.profile.bundles` 数组含本包名 → **加载开关 + 合并顺序**(数组序即 merge 序,edge 排最后所以能覆盖宿主)。
- `dependencies` 的 `file:` 条目只是给 pnpm 链 node_modules 用的,物理手工放置(直接 cp 进嵌套目录)时可省。

骨架本体由 dsh CLI 首启自动生成(dsh-app-boot `initProfile`/`PROFILE_TEMPLATES`,非本 repo 文件);install.sh §2.7 只做"追加 edge-agent"的增量改写,§7.57 起骨架缺失即 fail-fast。

## 时序辨析:读 `dependencies` 的是 pnpm(部署时),读 `bundles` 的是 dsh(启动时)

`file:` 条目是**给 pnpm 的一次性输入**,不是 dsh 的寻路依据——两个时刻各读各的字段,互不越界:

```
── 部署时 ──  pnpm install
│   读 dependencies.file:  →  把"包在哪个路径"物化成 node_modules 里的目录/链接
│   (顺便给物理放置的 bundle"上户口":不登记的目录下次 install 会被当孤儿 prune)
│
── 启动时 ──  dsh --profile <p>
    读 dsh.profile.bundles  →  拿每个包名走 Node 模块解析,按 node_modules 物理布局找:
      profiles/<p>/node_modules/<包名>/ → profiles/node_modules/ → 全局 dsh/node_modules/
    ⚠️ 全程不读 dependencies——那个字段此时已是"被 pnpm 消化完的历史"
```

两组反事实钉死(均实机验证,§7.57/2026-09-15):

| 操作 | dsh 行为 | 结论 |
|---|---|---|
| 改 dependencies 但不跑 pnpm install | 重启后纹丝不动 | dependencies 不参与运行时解析 |
| 手工 cp 出 bundle 目录(dependencies 未登记) | 立即可加载 | dsh 只看 node_modules 现状;但下次谁跑 pnpm install 会把它 prune 掉(当天 `+1 -16` 现场演出),所以 install.sh 仍写 file: 条目登记 |

推论(与 memory `env-default-restart-required` 同族的"第二份快照不自动跟"陷阱):**改 `dependencies`/`bundles` 之外还得跑对的那一步**——改 bundles 只需重启(④ 本体即清单);改 dependencies 必须 pnpm install 才落地,再重启才生效。

## ⑤ `~/.dsh/.agent-presets/dsh-edge-agent/`(bundle 之外,web 场景近似必需)

**定位(接三件套比喻)**:①-④ 是"厨房的监控、灭火器、门禁"——进程级安全隐私设施,用户聊什么都得在跑;⑤ 是**菜单 + 菜谱**——客人(用户)点开的那个 AI 助手本身长什么样、会哪些手艺。

**preset 是什么**:webui/TUI 聊天界面里"选择助手"的下拉列表。本项目往里注册了一个条目 **Edge Agent**。两个文件各管一半:

### preset.yml — 菜单上的那一行(纯展示,不装任何零件)

全文只有 3 个字段:`name: Edge Agent`(列表显示字)、`description`(选中时的说明)、`order: 10`(排位)。没有它,下拉列表里就没有这个条目——bundle 装得再全,用户也选不到。

### agent.cordis.yml — 这道菜的完整菜谱(选中该 preset 开会话时现场执行)

dsh 按这份清单组装本次会话的 agent:配哪些工具、每个什么参数。真实分段:

| 段 | 装了什么 | 调料级细节举例 |
|---|---|---|
| shell | bash 工具 | Windows 上自动禁用(换 pwsh 行) |
| filesystem / skills / goals / todo / ask-user | 本地读写搜索、技能加载、目标、待办、反问 | — |
| plan mode | "先规划后动手"模式 | 整段规划纪律 prompt 原文 |
| compaction | 会话过长压缩历史 | 工具结果 >8192 字符掐头 4096 去尾 1024 |
| delegation | 子 agent / 工作流 / ralph 循环 | ralph 最多 64 轮;只开 spawn/fork provider |
| tool-web | 联网搜索 | **`fetch: false`(只许搜索不许抓网页)**、超时 60s |

菜谱是照 DSH 官方 `standard` 改的,文件头注释写明**三处外科手术**:① 不装 `persona` 行(宿主 `dsh-persona` 在 0.1.0-rc.7 有重复注册 bug,memory `dsh-preset-system` 同源);② subagent 只留本地 `spawn`(codex/claude-code provider 未随装,开会话会当场 throw);③ plan-mode 文案照抄(空 `section` 会被 schema 拒)。

### `group + isolate` 是干嘛的(小白版)

`compaction`、`delegation` 等几组被包进 `cordis:group` 并带 `isolate: {…}`。**因为菜谱是每个会话执行一遍的**:开 3 个聊天窗就有 3 个 agent。压缩状态、工作流引擎这类"有私有数据"的零件若不隔间,3 个会话共用一份会互相踩(甲的历史被乙压缩掉);`isolate` = 每个会话发一间独立工位。bash/fs 这种"只把手工具"没有私有状态,裸放即可。**服务行漏了 isolate,dsh 直接拒绝挂载**(文件头注释明规)。

### 为什么放 `~/.dsh/.agent-presets/` 而不跟 bundle 走

dsh 源码**写死**两个发现根:装机系统根 + `~/.dsh/.agent-presets/`(用户根);bundle 目录里放一份它不会去看。所以 install.sh Phase 2.5 用 `rsync -a --delete` 从 repo `agent-presets/` 拷到用户根——repo 是唯一真相源,部署侧手改下次安装即被抹掉。

### "bundle 之外,近似必需"的准确含义

没有 ⑤:①-④ 照常工作,脱敏/审计/路由**一条不缺**;但下拉列表无 Edge Agent 条目,会话组出来的是宿主标准 agent——工具集、压缩策略、plan 纪律都不是 edge 定制版。**安全在,体验不对。**

## package.json vs cordis.patch.yml 差异速记

| | package.json(花名册) | cordis.patch.yml(派工单) |
|---|---|---|
| 性质 | **目录/指针**——"谁在哪"(不含代码、不含行为) | **命令**——"谁来干活、什么参数、撤谁" |
| 谁读 | Node(模块解析)+ npm/dsh 工具链 | DSH/Cordis loader |
| 何时起作用 | 每次有 import 按子路径找人时(查表) | 启动组装一次 |
| 认不认识"插件" | 不认识——只见"包名/子路径 → 文件" | 认识——全插件图视角 |
| 没有它 | import 报 `ERR_PACKAGE_PATH_NOT_EXPORTED` | 指针在而 patch 文件缺 → boot 报 `failed to read overlay …ENOENT`;patch 文件被指针引到却想"整体不装",要靠 ④ bundles[] 摘除——那才是"躺在 node_modules 里的死 JS"(boot 正常零痕迹,唯一静默场景) |
| 写了 ≠ 会发生 | exports 列了 `./audit-log` **不代表它会上岗**,只保证"找得到" | insert 点了名但 exports 没有这条 → 查无此人,当场报错 |

一句话:**package.json 管"找不找得到",cordis.patch.yml 管"用不用、怎么用"。电话本里存了厨师号码,不代表今晚他做菜;菜单点了他的菜,电话本里没号码也点不了。**

## 一图流

```
profile package.json ──bundles[]──▶ ①嵌套package.json ──dsh.bundle.patch 数组──▶ ②顶层 patch + preset patch
      (④ 开关+顺序)                    │exports 路由(36 条 = 31 代码入口)          │宿主行覆盖 + 边缘模式的插件列表
                                       ▼                                            ▼
                                 ③ lib/**/*.js ◀──────────────── import specifier ── DSH 启动组装插件图
                                  (实现本体, apply/Config)
      ⑤ .agent-presets/{preset.yml, agent.cordis.yml} ──▶ 会话级 agent 组装(与插件图正交)
```

> **数的是谁**:顶层 patch(full 变体 `cordis.patch.yml`)= 49 行宿主行(8 config / 30 disable / 11 裸行)+ **insert 段 4 行**;
> 桌面变体 `cordis.desktop-safe.patch.yml` = 3 行宿主行(2 config / 1 disable)+ **insert 段 4 行**(同样 4 行);
> `presets/edge.patch.yml` = 1 个 insert 段,内含 1 行 `@deepseek-ai/dsh-agent-preset`,
> 其 `config.plugins` 是 **22 宿主标准行 + 17 本项目行**(桌面变体 22 + 15)。
> ⚠️ **极简线派工单已退役**(§7.170):`bundle-minimal/cordis.patch.yml` 曾是 1 个 insert 段
> **9 行**(file-logger + audit-log + 7 插件执法闭包)的独立 rig,与上面几张不同构;
> 它连同 rig 脚本、CI 漂移锁测试已成套删除,结论保留在 ② 节。

## 修订

- **§7.146（2026-10-29）**：全量审计时核对现役数字，改正三处过期——①`exports`
  29→36 条（31 代码入口 + 3 yml + 2 特例）、lib 下 `.js` 56→72 个（私有 27→41）；
  ②`dsh.bundle.patch` 由字符串变**数组**（§7.135），顶层 insert 段 16→**4 行**、
  config 覆盖 10→**8 行**（桌面变体 2 行）、disable 30→**30 行**（桌面变体 1 行），
  并补上「本项目行为插件行已全部迁进 preset」这一结构变化；③铁律 3 的 7 插件闭包
  补注「现在分居 preset 与宿主树两层」。
- **§7.170（2026-11-10）**：**极简线成套退役** —— `bundle-minimal/`（派工单 + 极简
  花名册 + realm 种子）、`scripts/minimal-bundle-rig.sh`、以及守它们与产品面同步性的
  CI 漂移锁测试一并删除。本文**保留结论**（② 节铁律 3 的 7 插件闭包推导、三层语义
  mount ≠ active ≠ enforced、缺件行为），但不再有可复跑的实证载体；历轮 boot 签名
  原样存档在 `docs/PROGRESS.md` §7.59 系列。另修一处失真：手工部署第 ⑤ 步原写
  「缺表 → tools 全部 fail-open」，实为缺表回落**代码内置 `DEFAULT_CONFIG`**（§7.150
  屏蔽 `get_goal`/`create_goal`/`update_goal`/`ask_user_question` +
  `defaultRealm: hidden`），**其余** tools 才 fail-open。
