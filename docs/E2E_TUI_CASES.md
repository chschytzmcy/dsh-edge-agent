# E2E TUI 用例清单

> **§7.86(2026-09-18)归档说明**: 本文档历史版本记录了 dsh-tui 实机 E2E(`e2e-tui-live.sh`)+ M1-M6 smoke + `smoke.ts` 三层 E2E 套件。这些全部依赖历史独立 rig(`dsh-tui` tmux + :21018 / `edge-m1` profile / M5 webui)。**§7.69 单 profile 架构 + §7.86 清理**后:
>
> - `dsh-tui` 不再独立部署 —— HTTP API 在 dsh-edge :21017 统一提供
> - `edge-m1` profile 早就被 §7.61 改名 `dsh-edge` + §7.69 单 profile 化
> - M5 webui 已卸(§7.33)
> - `smoke.ts` 引到 M5+ work 未完成的 `local-tools.js` 模块(ERR_MODULE_NOT_FOUND)
>
> **TUI 路径本身也不再有独立 E2E**:任何 TUI rig 入口的覆盖点都被吸收到 `e2e-ops-log-coverage.sh` 的 HTTP 入口(原 e2e-tui-live.sh 的 H 臂)。

## 1. 当前活跃 E2E

详见 `docs/E2E_HTTP_API_CASES.md` —— `scripts/e2e-ops-log-coverage.sh`(3 重点用例 mibao/news/local-ip)。

`make e2e-tui` 入口保留为弃用 stub(打印弃用说明 + 退出 0),不实际跑脚本,兼容外部 CI 脚本调用。

## 2. 历史脚本(已 `git rm`,仅留档)

| 脚本 | 状态 | 用途 | 替代关系 |
|------|------|------|---------|
| `e2e-tui-live.sh` | ☠️ **DEAD §7.86** | dsh-tui tmux + HTTP 双通道 8 用例 | 全部 H 臂用例由 e2e-ops-log-coverage 覆盖;K1/K2 专用 TUI channel 断言已不适用(无独立 TUI rig) |
| `m1-smoke.ts` | ☠️ **DEAD §7.61** | M1 手工 smoke —— DeepSeek API 全链路 | 已被单测 + e2e-ops-log-coverage 替代 |
| `m2-smoke.ts` | ☠️ **DEAD §7.61** | M2 tool-calling | 同上 |
| `m3-smoke.ts` | ☠️ **DEAD §7.61** | M3 持久化 | 同上 |
| `m4-smoke.ts` | ⚠️ **web-only §7.43** | M4 local/cloud LLM 双 adapter | 同上 |
| `m5-e2e-test.sh` | 📜 M5 历史 | M5 webui 阶段 E2E 入口 | webui 卸载,§7.33 取消 |
| `m5-verify.ts` | 📜 M5 历史 | M5 HTTP API 端点手工 verify | 已被 e2e-ops-log-coverage 替代 |
| `m5-webui-smoke.sh` | 📜 M5 历史 | M5 webui 静态 smoke | 同上 |
| `m6-smoke.ts` | ⚠️ **web-only §7.43** | M6 L0 model-assisted 对抗样本 | 已被 §7.42 prompt-guard 单测 + e2e-ops-log-coverage 节点覆盖 |
| `smoke.ts` | ⚠️ **broken §7.86** | Cordis plugin shape 冒烟 | 引到 M5+ work 未完成的 `local-tools.js`(ERR_MODULE_NOT_FOUND);插件 shape 回归保护由 `verify:plugin-spec` 闸门覆盖 |

## 3. 一句话定位

**TUI 入口的所有 e2e 覆盖点都已下沉到 HTTP 入口的 `e2e-ops-log-coverage.sh`**(原 H 臂平移)。`make e2e-tui` 入口弃用。`make e2e-coverage` 是当前唯一活跃 e2e target。
