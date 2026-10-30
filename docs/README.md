# docs/ 文档索引

> 本文件是 `docs/` 的**总入口**：每份文档都有归处、有一句说明、有状态标记。
> 2026-10-29（§7.146）全量审计后建立——此前 `docs/` 下没有索引，9 份文档
> 处于「文件存在但没有任何读者」的孤儿态（引用数 = 0），只能靠全库 grep
> 猜它们是否有用。
>
> **根 README 的「文档」表把本文件列为总索引**；根 README 本身只保留
> 「最基本的介绍与部署信息」（2026-10-30 §7.156 起；此前 README 有 937 行，
> 配置参考与安装细节都堆在里面）。本索引面向「进 `docs/` 目录找东西」的读者。

## 文档处置判据（§7.146 确立）

审计 `docs/` 时对每份文档用同一把尺子，**按此判据可复现**：

| 判据 | 处置 | 本轮实例 |
|---|---|---|
| **零独有信息** + 没有活着的读者（按路径统计引用数 = 0） | **删** | `E2E_TUI_CASES.md`（§7.145-D 已删） |
| 有独有信息，但**内容过期**（数字/状态与现役不符） | **刷新**（加状态头 / 刷数字，不删） | `edge-context-tab-plan.md`、`deploy-minimal-files.md` |
| **活的参考**（被代码/脚本引用）、**唯一证据**（实测数据，不可再生）、被引用的契约 | **留** | 见下表 |

两条执行纪律：

1. **引用统计按路径匹配**（不是按文件名）——`SKILL.md` / `report.md` 这类重名
   文件按名字统计会互判成假阳性（本轮实测：`SKILL.md` 按名统计 8 引用，
   按路径统计 **0**）。
2. **「零引用」不等于「零价值」**。bench 快照、被 `dist/` 清空后无法再生的
   实测报告、脚本的技能定义，都属于「引用数 0 但必须留」——处置看的是
   **独有信息 + 是否还有读者**，引用数只是「读者」的代理指标。

## 一、总览（按用途）

| 文档 | 一句话 | 状态 |
|---|---|---|
| [`architecture.md`](architecture.md) | 架构主文档：四层模型 / realm / cordis 插件机制 + 上游适配契约 + 威胁模型 + 插件开发 | 活（9 引用） |
| [`PROGRESS.md`](PROGRESS.md) | 实施进度档案（§7.x 全量历史）——**唯一存档点**，测试过程与 boot 签名逐字存这里 | 活（13 引用） |
| [`intent-and-sanitization.md`](intent-and-sanitization.md) | 意图判定 + PII 脱敏的详细设计 | 活（4 引用） |
| [`intent-decision-reference.md`](intent-decision-reference.md) | 三层决策参考手册（正则 / 决策模型 / LLM 全清单） | 活（2 引用） |
| [`desktop-troubleshooting.md`](desktop-troubleshooting.md) | 桌面版排障手册（起不来 / Edge tab 不见了 / 面板口径） | 活（3 引用） |
| [`TEST-REPORT.md`](TEST-REPORT.md) | 测试报告：单元测试 / 门禁 / eslint / 实机取证 | 活（2 引用） |
| [`deploy-minimal-files.md`](deploy-minimal-files.md) | 最小部署清单：每个文件装了什么、起什么作用 | 活（4 引用） |
| [`load-into-local-dsh.md`](load-into-local-dsh.md) | 装进本地 DSH 的部署指南（Linux / macOS / Windows 三条路）+ 本地目录通道的宿主契约 | 活（8 引用） |
| [`config-reference.md`](config-reference.md) | **完整配置清单**（16 类配置项 + 路由行为约定）——2026-10-30 从根 README 迁出 | 活（§7.156 新增） |
| [`deploy-github.md`](deploy-github.md) | 从 GitHub 仓库地址安装到桌面版（Plugins → Add plugin）：前置条件、构建授权、启用、配置落位 | 活（§7.155 新增） |
| [`deploy-npm.md`](deploy-npm.md) | 从 npm 包名安装到桌面版：宿主读 registry 的两次查询、版本语义、发布链环节与报错对照 | 活（§7.156 新增） |
| [`plugin-mount-points.md`](plugin-mount-points.md) | 插件挂载点清单（哪个插件挂在哪棵树） | 活（2 引用） |
| [`function-call-external-http-contract.md`](function-call-external-http-contract.md) | 外部 HTTP function call 的 wire 契约 | 活（4 引用） |
| [`version-policy.md`](version-policy.md) | 版本策略（宿主版本约束） | 活（2 引用） |
| [`E2E_HTTP_API_CASES.md`](E2E_HTTP_API_CASES.md) | HTTP API 的 E2E 用例清单 | 活（1 引用） |
| [`edge-context-tab-plan.md`](edge-context-tab-plan.md) | Edge tab 实施计划（v4，已实现）——**历史计划书 + 实测验收回填** | 已实现（5 引用） |

## 二、按目录

### `decisions/` —— 架构决策记录（ADR）

| 文档 | 内容 |
|---|---|
| [`0008-edge-context-view.md`](decisions/0008-edge-context-view.md) | ADR-0008：Edge 面板的取数方式（host+client 双半体 / audit-log 活体监听 / POST route pull） |

ADR 状态为 Accepted 的不删——它记录的是**为什么这么做**，代码里查不到。

### `dev-notes/` —— 踩坑记录

| 文档 | 内容 |
|---|---|
| [`cordis-rc021-patch-loader.md`](dev-notes/cordis-rc021-patch-loader.md) | cordis 0.2.1-rc.021 的 patch loader 行为（insert / 加载顺序 / 冲突消解）——**被 `src/index.ts` 等代码引用** |
| [`git-core-editor-trap.md`](dev-notes/git-core-editor-trap.md) | `git commit` 在 Windows 上调起编辑器的坑（core.editor 配置） |

### `notes/` —— 源码走读

| 文档 | 内容 |
|---|---|
| [`dsh-context-walkthrough.md`](notes/dsh-context-walkthrough.md) | dsh-context v0.73.3 的 host+client 双半体源码走读——**被 `src/client/index.ts` / `store.ts` 引用** |

### `skills/` —— 技能定义

| 文档 | 内容 |
|---|---|
| [`dsh-systemic-health/SKILL.md`](skills/dsh-systemic-health/SKILL.md) | `scripts/dsh-systemic-health.sh` 的技能定义（A–G 七类检查 + 已知陷阱备忘）——**配对脚本是活的** |

> 技能定义与配对脚本是**一对**，谁都不会单独删；脚本头部已加反向链接。

### `bench/` —— 评测与实测数据

| 文档 | 内容 |
|---|---|
| [`test-case-design.md`](bench/test-case-design.md) | 评测用例设计（C1–C10 分类、评分公式、hard fixtures） |
| [`etscli-tools/README.md`](bench/etscli-tools/README.md) | etscli 直出工具形态评测产物导航 |
| [`etscli-tools/minimal-pairs.md`](bench/etscli-tools/minimal-pairs.md) | 端侧训练要补的 minimal pair 清单（P0 18 对 / P1 14 对 / 兜底 8 例） |
| [`needle-cn-en/report.md`](bench/needle-cn-en/report.md) | 中英 needle 检索实测报告 |
| [`snapshots/README.md`](bench/snapshots/README.md) | §7.87 模型选型实测快照索引（2026-09-20 一批） |

`bench/` 下的 `results.json` / `report.md` / `diff.txt` 是**评测原始产物**，
不是文档——`report.md` 是人类可读版，`results.json` 是机器可读版，两者成对
保留。

## 三、已被删除的文档（留档，防复发）

| 文档 | 删除于 | 原因 |
|---|---|---|
| `E2E_TUI_CASES.md` | §7.145-D | 零独有信息（内容已被 `E2E_HTTP_API_CASES.md` 覆盖），引用改写后删除 |
| `docs/bench/etscli-tools/*/report.md`（**未删**） | — | 教训：按名统计引用会假阳性。三份 report.md 曾被误判为「0 引用可删」，实际是评测**唯一的人类可读报告**，现已由 `etscli-tools/README.md` 显式链接 |

## 四、维护约定

- **新增文档**必须在本索引登记一行，否则它会以「孤儿文档」形态存在——没有任何
  入口能找到它。
- **删除文档**在本节留一行，说明原因，避免同一个坑重踩。
- **刷新数字**的文档，数字旁标注核实日期；本轮已刷的：
  `deploy-minimal-files.md`（§7.146）、`edge-context-tab-plan.md`（§7.146）、
  `TEST-REPORT.md`（§7.146）、`bundle-minimal/README.md`（§7.146）。

### 门禁：`verify:doc-links`（§7.146 起接入 `verify:build`）

上面三条约定里有两条现在由**机器强制**，不再靠人记得：

```bash
node scripts/verify-doc-links.mjs            # 查当前树
node scripts/verify-doc-links.mjs --selftest # 自证 + 反向证伪（12 项断言）
```

两条不变量：

1. **链接不断** —— 任何 `.md` 里的相对链接，指向的文件必须真实存在。
2. **可达不孤儿** —— `docs/` 下每个文件（含 `results.json` / `diff.txt` 等数据
   产物）都必须能从某个**导航面**（`docs/` 下任一 `README.md` + 仓库根
   `README.md`）上的显式 markdown 链接**沿链接链走到**（传递闭包，不是只能
   一跳）。

门禁红了怎么办：输出会直接点名是哪个文件、哪条链接。按提示二选一——① 在
`docs/README.md` 对应表格补一行；② 确认它确实该删 ⇒ 删掉，并到本文件「已被
删除的文档」留一行档。

**为什么判据是「显式链接」而不是「字符串出现过」**：`PROGRESS.md` 里提到过一个
文件名，不等于读者能走到它。本轮审计用的也是同一判据（引用统计必须**按路径**
匹配，不按文件名）。
