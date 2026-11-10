# §7.87 模型选型实测快照（2026-09-20）

> **本目录为什么存在**：`make package` 有一行 `@rm -rf $(PACKAGE_DIR) $(DIST_DIR)`
> 会把整个 `dist/` 清空，而 §7.87 的 bench 产物（`dist/bench-*/`）当时正好落在
> `dist/` 里 —— 一次打包就把三轮实测数据全擦了。§7.87.3 的修法是**把结论
> 快照落进 `docs/bench/snapshots/`**，这里就是那份存档。
>
> **这些数据不可再生**：当时的端点（`67.0.0.5:28000/28001`、
> `192.0.2.104:8080`、`192.0.2.103:8911`）是当时的内网机器，云端模型
> `dashscope-qwen3.7-plus` 早已换代。**快照不是「过期的报告」，是「一次性的
> 观测」**——重跑得到的是另一批数据，不能覆盖它们。

## 快照清单

| 文件 | 章节 | 内容 | 结论 |
|---|---|---|---|
| [`2026-09-20-3model-vertical.md`](2026-09-20-3model-vertical.md) | §7.87.7 + §7.87.8 | 3 模型纵向对比（dashscope / minicpm5-2b / qwen3.5-9b），各 3 run | 「小模型 + 好 server > 大模型 + 差 server」复验：minicpm 78.9 > qwen3.5-9b 66.2 |
| [`2026-09-20-qwen3.8-27b-3runs.md`](2026-09-20-qwen3.8-27b-3runs.md) | §7.87.10 | Qwen3.8-27B（llama.cpp Q4_K_M）3-run median | **90.0 ✅ Prod-ready**，C5 PII 完美（IP 不漏）、C6 tool_call 完美、0 variance |
| [`2026-09-20-qwen3-4b-lan-3runs.md`](2026-09-20-qwen3-4b-lan-3runs.md) | §7.87.11 | qwen3-4b（rknn w4a16）3-run median | **90.0 ✅ Prod-ready**，3 run 0 variance |
| [`2026-09-20-qwen3.5-9b-mlx-3runs.md`](2026-09-20-qwen3.5-9b-mlx-3runs.md) | §7.87.11 | qwen3.5-9b（mlx w4a16）3-run median | **90.0 ✅ Prod-ready**，C5 IP 子集偶发漏（0.875），C10 retention 满分 |
| [`2026-09-20-minicpm5-2b-mlx.md`](2026-09-20-minicpm5-2b-mlx.md) | §7.87.9 | minicpm5-2b 在 MLX w4a16 量化下的单次实测 | **41.5 💀 Reject** —— C6 tool_call 0/17（量化后 tool_call head 退化） |
| [`2026-09-20-v3-c1-c10-4model-report.md`](2026-09-20-v3-c1-c10-4model-report.md) | §7.87.11 | Bench v3 下 4 模型 C1–C10 完整分数 + 评分公式 v3 | v3 评分把「4 模型全 90.0 平局」打破成 87.7 / 87.9 / 83.0 / 74.0 |
| [`2026-09-20-v3-scoring-4model.md`](2026-09-20-v3-scoring-4model.md) | §7.87.11 | 评分公式升级（4 处改动）+ 12 个 hard fixtures + 4 模型 v3 子分数 | 90.0 ceiling 破除；size scaling 现形 cloud ≥ 27B > 4B > 9B |

## 模型选型最终口径（由上面 7 份快照共同支撑）

| Rank | 模型 | Server | 量化 | Final | Verdict |
|---|---|---|---|---|---|
| 🥇 1 | dashscope-qwen3.7-plus | cloud | — | 87.7（v3）/ 90.0（v2） | ✅ gate baseline |
| 🥇 1 | Qwen3.8-27B | llama.cpp | Q4_K_M | 87.9（v3）/ 90.0（v2） | ✅ Prod-ready |
| 3 | qwen3-4b | rknn | w4a16 | 83.0（v3）/ 90.0（v2） | ⚠️ Conditional |
| 4 | qwen3.5-9b | mlx | w4a16 | 74.0（v3）/ 90.0（v2） | ⚠️ Conditional |
| 💀 | minicpm5-2b | vllm / mlx | FP16 / w4a16 | 78.9 / 41.5 | ⚠️ Conditional / 💀 Reject |

三条跨快照的教训（各自在对应文件里有完整取证）：

1. **量化兼容性是 model-specific** —— 换 model+quant 组合前必须先做 C6 tool_call
   冒烟（minicpm5-2b 在 mlx 4bit 下彻底退化，同族 Qwen3.5 却正常）。
2. **同一量化只对同一 model family 成立** —— 不能假设「MLX 4bit 对所有模型都work」。
3. **bench harness 必须显式绕过系统 HTTP_PROXY** —— `no_proxy` 默认不含 LAN IP，
   `urllib.request` 会走 `127.0.0.1:7890` 导致 LAN 端点全 502。

## 相关

- 评测用例设计与评分公式：[`../test-case-design.md`](../test-case-design.md)
- 复现脚本：[`scripts/etscli-tools-test.py`](../../../scripts/etscli-tools-test.py)、
  [`scripts/e2e-model-quality-bench.sh`](../../../scripts/e2e-model-quality-bench.sh)
- 完整过程逐字存档：[`../../PROGRESS.md`](../../PROGRESS.md) §7.87 系列
