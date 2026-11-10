# Changelog

本文件的**唯一权威**是 [`docs/PROGRESS.md`](docs/PROGRESS.md) —— 那里逐条记着
每一次改动的根因、实证与裁决（§7.x 全量历史）。本文件是给**使用者**看的：装上之后
能得到什么、有什么边界、怎么排障。

格式：[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [0.1.1] — 2026-11-10

**首次发布到 npm registry。** 506 次提交、2026-08-18 → 2026-11-10。

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
  四级阶梯，实体护栏与云闸两道后处理闸收口；
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

### 配置

只有**一个文件**：`config/edge.json`。查找顺序
`<bundle>/config/edge.json` → `~/.dsh-edge-agent/edge.json` → shipped 模板。
`secrets` 段存明文 key，其他段按 `keyRef` 引用它。**`secrets` 与 `llm` 都不是必填**
—— 桌面版装法下空对象也能跑。

### 观测

- **审计链** —— 决策级事件，JSONL 落盘，Edge 面板按「意图 / 判定 / 路由决策 /
  LLM 调用」分栏；
- **ops log** —— 启动与运行期诊断；
- **Edge 标签页** —— 桌面右栏 4 个面板 + 会话摘要实时可视化；
- **LLM trace** —— 每次往返的请求/响应成对可查（凭据与 PII 脱敏）。

### 工程门禁

24 道门禁，验的是**产物**不是源码（`npm run build` 一条链跑完）：
构建链完整性、adapter 边界、上游契约、patch 面、preset 隔离、发布面、文档可达性、
安装包内容、tarball、CI 链不漂移……

### 已知边界

见 [`docs/privacy-policy.md`](docs/privacy-policy.md#已知边界) —— 那里逐条记着
「当前**未实现或未接线**」的部分（例如标准模式会话不做出网裁剪、本地池 delegate
模式下内部阶段会跑在宿主模型上）。

---

## 更早的版本

`0.1.0` 及更早只存在于 git 历史里，**从未发布到 registry**。
逐条实施记录见 [`docs/PROGRESS.md`](docs/PROGRESS.md)。
