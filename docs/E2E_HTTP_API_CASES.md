# E2E HTTP API 用例清单

> **§7.86（2026-09-18）归档说明**: 本文档历史版本记录了 M1-M6 smoke、e2e-tui-live.sh、e2e-llm-classification.sh、e2e-model-detection.sh、e2e-privacy-precheck.sh、e2e-lark-skill.sh、e2e-web-search.sh 共 7 套 E2E 脚本的用例矩阵。这些脚本全部依赖已废除的 `edge-m1` / `dsh-tui` 独立 rig 或 M5 webui 阶段入口,全部已 `git rm`(commit 含本批)。**单 profile 架构(§7.69)+ M5+ work 没收尾**后,这些 E2E 无可执行宿主。
>
> **§7.145-D（2026-10-29）整理**: 原 `docs/E2E_TUI_CASES.md` 已删除 —— 它的正文只有一句
> 「详见本文档」+ 一张比本文档 §3 更小的历史脚本表,零独有信息。TUI 路径的历史脚本
> （`e2e-tui-live.sh` / `m1`~`m6-smoke` / `smoke.ts` 等）全部在下面 §3 这张表里。
>
> **当前唯一活跃 E2E** = `scripts/e2e-ops-log-coverage.sh`(3 重点用例 mibao/news/local-ip,21 节点 ops log 全链路覆盖)。

## 1. e2e-ops-log-coverage.sh —— 21 节点回归(3 重点用例)

| # | 用例 | sessionId | query | 覆盖节点 |
|---|------|-----------|-------|----------|
| 1 | mibao | `opslog-canary-mibao` | 查询密盒的登录状态 | 21 节点 + ets-auth skill 路由 + tool=bash 字段隔离 |
| 2 | news | `opslog-canary-news` | 查询最新的AI新闻 | 21 节点 + 35 次 web_search tool 调用 + cloud-llm-adapter LLM call 全链路 |
| 3 | local-ip | `opslog-canary-local-ip` | 查询本机的局域网IP | 21 节点 + LOCAL intent + 12 次 bash tool 调用 |

**入口**:`make e2e-coverage` / `bash scripts/e2e-ops-log-coverage.sh [--only mibao|news|local-ip]`

**前置**:dsh-edge HTTP API 已起(`bash install.sh --profile=dsh-edge`,端口 :21017)。

## 2. 启动探针(`GET /v1/health`,所有 e2e 阶段共用)

dsh-edge-agent 暴露 `/v1/health` 探针,E2E 启动前先验 200 OK,确认 19 个 plugin 已加载 + http-api listening + audit-log / sanitizer-pipeline / realm-bridge / input-guard 全在线。

## 3. 历史脚本(已 `git rm`,仅留档)

| 脚本 | 替代关系 |
|------|---------|
| `m1-smoke.ts` ~ `m6-smoke.ts` | 早期 milestone scaffold smoke,CLI `--config` 旗标已删;**已被单测 + e2e-ops-log-coverage 替代** |
| `m5-e2e-test.sh` / `m5-webui-smoke.sh` | M5 webui 阶段 E2E,webui 已卸(§7.33) |
| `m5-verify.ts` | M5 阶段手工 verify,profile 已不存在 |
| `e2e-tui-live.sh` | dsh-tui 独立 rig E2E,§7.69 单 profile 架构后 dsh-tui 不再独立部署 |
| `e2e-llm-classification.sh` | 依赖 edge-m1 profile;覆盖点(intent-router 11 测试组)由 e2e-ops-log-coverage news 用例 preflight intent 节点 + 单测覆盖 |
| `e2e-model-detection.sh` | 依赖 edge-m1 profile;覆盖点(prompt-guard 8 对抗 + 5 正常)由 §7.42 单测 + e2e-ops-log-coverage `prompt-guard` 节点覆盖 |
| `e2e-privacy-precheck.sh` | 依赖 edge-m1 profile;覆盖点(REJECT 19 用例)由 §7.22/§7.34 input-guard 单测 + 审计 `policy.reject` 事件覆盖 |
| `e2e-lark-skill.sh` | 依赖飞书凭证 + edge-m1 profile |
| `e2e-web-search.sh` | 依赖 edge-m1 profile;覆盖点(web_search 端到端 + PII 守卫 + rate-limit)由 §7.82 web-search-tavily-bocha 单测(8 个 fallback path)+ e2e-ops-log-coverage news 用例(web_search 35 次 + 0 http_error)覆盖 |

## 4. 维度 × 用例 计数

`e2e-ops-log-coverage.sh` 3 重点用例覆盖维度:
- intent 路由(LOCAL / CLOUD keyword 命中)
- realm 隔离(CLOUD realm 允许 web_search,LOCAL realm 不允许)
- LLM call 全链路(start / done / resultLen / finishKind)
- tool 执行(tool allow / tool result status)
- 审计完整性(21 节点 × ops log 字段 schema)
