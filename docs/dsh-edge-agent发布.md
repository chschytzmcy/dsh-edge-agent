# dsh-edge-agent 发布后部署到 web profile

> 场景：dsh-edge-agent 以单包 bundle（`dsh.bundle.patch` 声明 + 多行 `cordis.patch.yml` 编排）发布到 npm 后，部署进 web profile 的操作与产物说明。

## 部署命令

前置（首次才需要）：官方 CLI + pnpm

```bash
npm install -g @deepseek-ai/dsh
npm install -g pnpm
```

部署：装进 web profile（-w = npm 来源，dsh-im 同款）

```bash
dsh plugin --profile web add -w @deepseek-harness-edge-agent/dsh-edge-agent
```

重启生效并验证

```bash
dsh web
dsh --profile web --dump-config   # 确认 19 插件 + http-api 在装配树
```

核心命令只有一条：`dsh plugin --profile web add -w <包名>`。不需要 sudo、不需要建目录、不需要手动改配置——web profile 已存在，add 只做"装包 + 并入 patch 行"两件事。

## 部署完成后文件落点（3 个位置）

| **位置**                  | **性质**     | **谁写入**            |
| ----------------------- | ---------- | ------------------ |
| ① npm 全局 node\_modules/ | 分发代码       | npm install -g     |
| ② \~/.dsh/profiles/web/ | 装配层（唯一变化点） | dsh plugin ... add |
| ③ \~/.dsh/ 数据区          | DSH 运行数据   | dsh 运行时            |

### ① npm 全局（代码分发）

```
.../node_modules/@deepseek-harness-edge-agent/dsh-edge-agent/
├── package.json          # "dsh": {"bundle": {"patch": "./cordis.patch.yml"}}
├── cordis.patch.yml      # 多行编排：19 插件 + http-api + disabled 策略
└── lib/                  # 插件实现
```

用途：只读分发物。升级 = update 或重装，用户不手改。

### ② \~/.dsh/profiles/web/（装配层，重点）

```
├── node_modules/
│   ├── @deepseek-harness-edge-agent/dsh-edge-agent/   # bundle 包本体
│   └── .pnpm/ + 各传递依赖
├── package.json          # web profile 清单：记录装了哪些包
├── cordis.patch.yml      # 装配树：edge-agent 的 patch 行被并入这里
└── plugin-config.json    # 插件参数（http-api 端口等）
```

用途：

* node\_modules 里的 bundle 包 = 运行时落点
* cordis.patch.yml = 装配事实，启动时按它展开插件树，--dump-config 输出即其投影
* plugin-config.json = 调参入口

### ③ \~/.dsh/ 数据区（DSH 自有，非部署产物）

会话权威日志（append-only 事件流，唯一真相源），由 DSH 管理。部署者只需知道会话在这、--resume 靠它。

## 一句话总结

部署命令只有一条 `dsh plugin --profile web add -w <包名>`，它做的事 = 代码进①全局、包进②web profile 的 node\_modules、patch 行并入②的 cordis.patch.yml。启动后装配树按②展开，会话数据进③。没有独立目录、没有日志文件、没有配置残留——这就是纯 bundle 挂载的干净形态。

***

## 项目结构与发布方式

### 项目结构

**定位**：基于 DSH 插件机制的端侧私密安全 Agent —— 19 个核心插件 + 1 个可选 http-api 插件，完全不修改 DSH 核心，隐私优先、零信任通信、可验证安全。

**分层**：

* L1 插件代码：packages/\<plugin>/，19 个专用插件按职责分（输入安全、请求组装、LLM 路由、工具执行、结果写回）
* L2 配置层：cordis.yml / patch 行，装配在此
* L3 测试设施：独立

**安全核心**（intent-router 五层防御，顺序流水线）：

`td-bus 威胁门禁 → prompt-guard 输入防护 → 隐私策略预检 → 本地 LLM 分类 → 规则兜底`（云侧脱敏失败 fail-closed 禁上云；模型不确定 fail-open 降级规则）

**合规铁律**：

* `git diff dsh/` 与 `git diff node_modules/@deepseek-ai/` 为空
* 扩展仅以标准事件拦截 + 适配器路由注入（Consumer 角色、事件返回决策对象）
* Waterfall 契约 + Epoch 热重载；`disabled: true` 解耦内置形态

**运行形态**：多入口单 agent —— web/TUI 作人机入口 + http-api（8080）作对外接口，同一 profile 共享五层防御；HTTP 暴露到网络时才拆独立 profile/进程（攻击面隔离）。

### 发布方式

| **项** | **设计**                                                                                             |
| ----- | -------------------------------------------------------------------------------------------------- |
| 分发格式  | 单包 + dsh.bundle.patch 声明（社区标准）：package.json 中 `"dsh": {"bundle": {"patch": "./cordis.patch.yml"}}` |
| 装配    | cordis.patch.yml 多行编排：insert 19 插件 + http-api + disabled 策略                                        |
| 宿主    | 随 web/tui 宿主（多入口单 agent）；HTTP 对外暴露时拆独立 profile                                                     |
| 数据    | 无独立 \~/.dsh-edge-agent；策略进 patch 配置、凭据进 DSH 受保护存储、业务数据走 dsh-storage                                |
| 安装    | dsh plugin --profile \<宿主> add（npm 发布后按包名，dsh-im 同款 -w）                                            |

***

## 演进路线（分阶段实现）

### 目标形态

单进程多入口：一个 dsh 进程内 WEB / TUI / HTTP 三入口并存，请求都经过 edge-agent 五层防御。防御不挂在入口层而在 agent 层（Input Guard / Intent Router 位于 Agent Loop 之前），入口只是传输通道，所以多入口天然共享防御。

### 第一阶段：edge-agent 作为宿主 profile 的 bundle（寄生）

* edge-agent 装进现有 web / tui / 任意自定义 profile，作为其安全层
* **当前默认 + primary 宿主 = web profile**（自带 DSH 上游 webui / IM，验证案例最完整）
* **profile-agnostic**（user 反馈 2026-09-03）：tui / 任意自定义 profile 也支持同款模式——`install.sh --to-profile <任意名>` 接受任意 profile 名
* http-api（21017，§7.33 起）默认 **disabled**（user 显式"先关掉"；代码保留，未来可手动启用）— 这与 Phase 1 原 spec "http-api 对外提供接口" 有偏差，是 user 决策
* 部署：`dsh plugin --profile web add -w @deepseek-harness-edge-agent/dsh-edge-agent`，然后 `dsh web`
* **验证目标：安全逻辑本身**（五层防御有效性、策略热重载、fail-closed 行为）
* 价值：用最便宜的载体验证核心逻辑——宿主兜底、可回退；避免等独立 profile 基建全搭好才暴露防御缺陷

**当前阶段实施状态（2026-09-03）**：✅ Phase 1 已完成。

- ✅ bundle 装在 web profile（默认 + primary）；`dsh plugin --profile web add -w` 部署；`dsh web` 启 webui
- ✅ 18 个 bundle plugins 全部 enabled：input-guard / intent-router / sanitizer / privacy-policy / file-logger / audit-log / td-bus / local-storage / sessions / model-router / local-llm-adapter / cloud-llm-adapter / tools / secure-bridge / ohttp-gateway / attestation / tcm / realm-skill-bridge
- ✅ 五层防御（input-guard / intent-router / sanitizer / privacy-policy / audit-log）端到端打通
- ⚠️ http-api 默认 disabled（与 Phase 1 spec 偏离；user 决策；code 保留）
- ✅ channel root 6 个全部 redirect 到 `~/.dsh-edge-agent-web/<channel>`（env override + SESSION_ROOT singular fix）

**profile-agnostic 部署**（2026-09-03 后允许）：

```bash
# 默认（web）
./install.sh
# 装到 tui（如有）
./install.sh --to-profile tui
# 装到任意自定义 profile
./install.sh --to-profile my-edge
# 等价环境变量写法
DSH_EDGE_PROFILE=my-edge ./install.sh
```

`scripts/verify-bundle-mounted-in-web.sh` 是 informational report（不 fail）——列出 bundle 当前装入哪些 profile，**不做 host profile 白名单**（2026-09-03 user 反馈撤回 "web only" 收紧）。

### 第二阶段：edge-agent 独立成 profile

* 自己装配、自己启动、也对外提供 http 接口 → 独立产品形态
* 部署：`dsh plugin --profile dsh-edge-agent add @deepseek-harness-edge-agent/dsh-edge-agent`，然后 `dsh --profile dsh-edge-agent`
* 与第一阶段差异：装配基线由自己锁定（无宿主插件混入）；可加 bin 启动器 / systemd 产品化
* 不推翻第一阶段：edge-agent 始终是"可被任何 profile 引用的安全 bundle"，独立 profile 只是其中一种宿主

**当前状态（2026-09-03 §7.33）**：❌ Phase 2 **未实施**——headless `profiles/dsh-edge-agent/` 容器 + `bin/dsh-edge-agent.js` 启动器在 §7.33 删除（user 授权"旧数据可丢"）。如果未来需要独立 profile 形态，需从零搭：

1. 重新创建 headless `~/.dsh/profiles/dsh-edge-agent/` 容器
2. 写回 `bin/dsh-edge-agent.js` 启动器（或 systemd unit）
3. 决定是否独立监听 http-api `:21017`（vs 仅 webui）
4. 接受独立 profile 与 web profile 之间的 channel root / credential 隔离成本

**§7.33 决策依据**：bundle 形态（Phase 1）覆盖 dsh-edge-agent 90% 用例（增强任何宿主 profile 的隐私 / 输入防护），独立 profile 形态（Phase 2）增加运维 / 升级成本而无明显收益。user 决策"先不做 Phase 2"。

### 关键设计约束

* **Phase 1 + Phase 2 共享同一份 cordis.patch.yml 插件行**，插件代码与 patch 原样复用
* **patch 参数化**：端口与 disabled 策略由宿主 config 决定（是否带 UI 入口），不写死——同一 bundle 多种宿主零改动切换
* **bundle profile-agnostic**（2026-09-03 user feedback）：installer / verifier 不做 host profile 白名单；web / tui / 任何自定义 profile 同款支持
* 单 profile 收编 web（dsh-web-app）可行：官方架构即 bundle 引用设计
* TUI 纳入同一 profile 有风险：dsh-TUI 是"补位形态"（patch 约 50 行覆盖重排 base、可能抢 UI 宿主服务名），需实测；冲突则 TUI 走外挂客户端（经 http/ACP 通道接同一 agent）
