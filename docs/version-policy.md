# 上游版本策略：不锁版本，跟随最新

> 2026-10-17 起生效。替代历史上“精确锁定 `0.1.2-rc.1`”的做法。

## 1. 原则

- `@deepseek-ai/dsh-*` **不在 `package.json` 里写死具体版本**。
- `peerDependencies` / `devDependencies` 使用开放下界，例如
  `>=0.2.1-rc.2`（框架包 `cordis >=4.0.5` / `schemastery >=3.18.5`）；
  允许安装更新版本，包括更新的 RC。
- `UPSTREAM_MIN_VERSION` 表示“代码仍然兼容的最老版本”，不是“推荐版本”。
  只有发生真实代码迁移时才上调它。
- `UPSTREAM_TESTED_VERSION` 记录最近一次跑过 compile + boot smoke 的版本，
  仅用于告警，不用来阻塞安装。

## 2. 两个发布通道

DSH 目前同时维护两个 npm dist-tag：

| 通道 | 当前指向 | 用途 |
|---|---|---|
| `latest` | `0.2.0-rc.2` | 相对稳定的 RC 线 |
| `next` | `0.2.1-rc.2` | 最新 RC 线（本项目默认跟随） |

本项目的 CI 应至少覆盖 `next`；如果上游 `latest` 落后，属于正常现象，不要求
两者一致。需要固定通道时，用环境变量覆盖，不要改源码里的精确版本号。

`.github/workflows/upstream-latest.yml` 每周一手动/定时跑一次
`pnpm update --latest` + compile + gates + test；它失败只说明“上游又 breaking
了”，不是发布门禁，但必须有人跟进 adapter 迁移。

```bash
# 跟随最新 RC
pnpm add -D @deepseek-ai/dsh-agent@next @deepseek-ai/dsh-llm@next ...

# 或只更新已有依赖
pnpm update --latest
```

## 3. 门禁语义

`pnpm run verify:contract` 不再比较“是否等于某个版本”，而是：

1. 任一核心包低于 `UPSTREAM_MIN_VERSION` → **失败**；
2. 核心包之间版本不一致（半升级）→ **失败**；
3. 高于 `UPSTREAM_TESTED_VERSION` → **警告**，继续；
4. 包缺失 → CI 门禁 **失败**（`pnpm install` 没装齐）；运行时
   `upstreamDrift()` 不把缺失当失败，因为宿主可能通过 hoist 提供。

这意味着“上游发新版”本身不会让 CI 红；只有真正的不兼容或半升级才会。

## 4. 上游升级时的实际动作

1. `pnpm install` / `pnpm update --latest`；
2. `pnpm run compile`；
3. `pnpm run verify:build`（至少 boundary / contract / patch-surface / plugin-spec）；
4. 启动一次真实 profile，跑 `/v1/health` + 一轮 `/v1/chat`；
5. 若有 hook/API 迁移，更新 `src/dsh-adapter/contract.ts` 的
   `UPSTREAM_MIN_VERSION` 和 `UPSTREAM_TESTED_VERSION`，并在
   `docs/PROGRESS.md` 追加一节（不改历史章节）。

## 5. 已知的 0.2.x 迁移点

- `session/event` 不再携带 `assistant/chunk`；实时文本改由
  `agent/assistant-stream` 的 `frame.type === 'chunk'` 提供。
  `http-api` 已改为监听后者，并按 `agent.session.id` 过滤，避免并发 SSE
  串流。
- `cordis.patch.yml` 里少数上游 row ID 在 0.2.1 的 `headless` 模板中不存在
  （`web-search`、`tool-str-replace-editor`、`tool-subagent-report` 等）。
  DSH loader 会打印 `entry not found` 警告并继续；这些 disable 属于“目标不存在
  就无操作”，不影响启动，但升级时需要重新核对是否真的还需要 disable。
- 因此 **patch 面不是版本无关的**。后续应增加一个 `verify:surface` 检查：
  用当前 `dsh --dump-default-config` 的 ID 集对比 `cordis.patch.yml`，把
  “上游改名/删除”从静默警告变成可见报告。

## 6. 关于 `pnpm-lock.yaml`

“不锁版本”指 **`package.json` 不写死上游版本**，不是删除 lockfile。
`pnpm-lock.yaml` 仍是某一次 CI 构建的可复现快照；跟随最新靠定期
`pnpm update` + latest/next 任务，而不是让每次安装都随机漂移。

## 7. 工具链例外

Node 与 pnpm 仍保留 `engines` / `packageManager` 约束。它们不是 DSH 上游
版本，放开会让 CI 与本地构建不可复现；如确需放开，单独评审。
