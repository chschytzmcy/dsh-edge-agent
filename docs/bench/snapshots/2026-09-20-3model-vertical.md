# §7.87.7 + §7.87.8 3-Model Vertical Comparison Snapshot
# Date: 2026-09-20 10:00:50 - 10:17:50 (CST)
# Total: 17 minutes (6 fresh runs)

**Note**: original `dist/bench-*` dirs were wiped by `make package` during Phase 3
restore (Makefile line 110 `rm -rf $(DIST_DIR)` bug). Data preserved here from
background task `bi63nlhhb` output. See PROGRESS §7.87.7 for full context.

## dashscope-qwen3.7-plus (cloud baseline)
**Base URL**: https://coding.dashscope.aliyuncs.com/v1
**Model**: qwen3.7-plus

| Run | Start | End | Duration | Intrinsic | Pipeline | Latency | C10 | Final | Verdict |
|-----|-------|-----|----------|-----------|----------|---------|-----|-------|---------|
| r1  | 10:00:50 | 10:05:37 | 4m47s | 100.0 | 100.0 | 0 | 100 | **90.0** | ✅ |
| r2  | 10:05:37 | 10:09:25 | 3m48s | 100.0 | 100.0 | 0 | 100 | **90.0** | ✅ |
| r3  | 10:09:25 | 10:12:58 | 3m33s | 100.0 | 100.0 | 0 | 100 | **90.0** | ✅ |
| **median** | | | | **100.0** | **100.0** | 0 | **100** | **90.0** | ✅ Prod-ready |

dashscope per-category (all 3 runs identical):
- C1 intent-F1: 1.0 (parse_rate=1.0, conf_mae≈0.12)
- C2 safety: 1.0 (parse_rate=1.0, recall=1.0, fp_rate=0.0)
- C3 chinese: 0.055-0.064 (completion_rate=1.0) — BLEU low because CLOUD baseline 参考答案太短
- C4 JSON-schema: 0.94 (schema_acc=1, value_acc=0.8)
- C5 PII-recall: 1.0 (per_type all = 1.0)
- C6 tool-call: 0.9 (bash=1.0, web_search=0.75)
- C7 mibao: 1.0 (intent=LOCAL, result_len=227-322)
- C8 news: 1.0 (intent=CLOUD, result_len=1274-2431)
- C9 local-ip: 1.0 (intent=LOCAL, result_len=101-180)
- C10 multi-turn: 1.0 (perfect retention)

## minicpm5-2b (vllm @ 67.0.0.5:28000)
**Base URL**: http://67.0.0.5:28000/v1
**Model**: models/MiniCPM5-2B

| Run | Start | End | Duration | Intrinsic | Pipeline | Latency | C10 | Final | Verdict |
|-----|-------|-----|----------|-----------|----------|---------|-----|-------|---------|
| r1  | 10:13:24 | 10:15:04 | 1m40s | 77.8 | 100.0 | 0 | 100 | **78.9** | ⚠️ |
| r2  | 10:15:04 | 10:16:28 | 1m24s | 77.8 | 100.0 | 0 | 100 | **78.9** | ⚠️ |
| r3  | 10:16:29 | 10:17:50 | 1m21s | 77.8 | 100.0 | 0 | 100 | **78.9** | ⚠️ |
| **median** | | | | **77.8** | **100.0** | 0 | **100** | **78.9** | ⚠️ Conditional |

minicpm per-category (all 3 runs identical):
- C1 intent-F1: **0.0** (parse_rate=0.0) — 2B model can't emit JSON for intent
- C2 safety: 1.0 (parse_rate=0.5-0.625, recall=1.0, fp_rate=0.0)
- C3 chinese: 0.08-0.093 (completion_rate=1.0)
- C4 JSON-schema: 0.94 (schema_acc=1, value_acc=0.8)
- C5 PII-recall: **0.667** (phone=0.667, id=1, **ip=0**, email=1) — IP类型全漏
- C6 tool-call: 0.9 (bash=1.0, web_search=0.75)
- C7 mibao: 1.0 (intent=LOCAL, result_len=186-345)
- C8 news: 1.0 (intent=CLOUD, result_len=1423-1936)
- C9 local-ip: 1.0 (intent=LOCAL, result_len=180-302)
- C10 multi-turn: 1.0 (perfect retention)

## qwen3.5-9b (llama.cpp @ 67.0.0.5:28001) — HISTORICAL from §7.87.7
**median**: Intrinsic 52.3 / Pipeline 100 / Final 66.2 ❌ Weak

## Cross-Model Median Comparison

| Model | Intrinsic | Pipeline | Final | Verdict |
|-------|-----------|----------|-------|---------|
| dashscope-qwen3.7-plus (cloud) | **100.0** | 100.0 | **90.0** | ✅ Prod-ready |
| minicpm5-2b (vllm) | 77.8 | 100.0 | 78.9 | ⚠️ Conditional |
| qwen3.5-9b (llama.cpp) [historical] | 52.3 | 100.0 | 66.2 | ❌ Weak |

## Key Insights

1. **§7.87.6 whenIdle fix 跨 3 模型泛化** — Pipeline 100/100 在所有测试模型上稳定
2. **variance 显著降低 vs §7.87.7** — 6 个 run 中 5 个 0 variance（dashscope 3/3, minicpm 3/3），
   早期 minicpm 4-run ±7 variance 主因是 qwen-style malformed tool_call race，
   §7.87.6 fix + vllm 干净 tool_call 生成双管齐下
3. **intrinsic gap 22.2**（dashscope vs minicpm）— 主因 C1 (intent JSON parse) + C5 (IP recall)
4. **最终 gap 11.1** — intrinsic 差距被 50% 权重稀释 + pipeline 都 100/100 持平
5. **「小模型 + 好 server > 大模型 + 差 server」复验**：
   minicpm (2B+vllm) 78.9 > qwen3.5-9b (9B+llama.cpp) 66.2
6. **dashscope-r3 是首个 cloud baseline 100/100/100 intrinsic+pipeline**（latency=0 是
   bench script 没实现 latency module,非模型问题,见 §7.87.4 latency 公式 0-30s 线性）

## Debug Findings (从这次重跑)

### A. race condition between parallel bench tasks
- 早 09:30 启了 b476nxqif (3-model sweep) + bdl0o8ug1 (2-model sweep) 同时跑
- 都通过 `scripts/switch-local-llm.sh` 改 `.env` → race
- 表现：dashscope-r2 报"模型 MiniCPM5-2B @ 28000"，其实是 minicpm 污染
- 修：所有 bench 重跑前必须 kill 旧 task + cp 干净 snapshot + 验证 dsh-edge 进程
- 隔离：3 个污染目录移 `dist/bench-raced-20260920-0958/` + README 记录

### B. `make package` wipes dist/bench-* (BUG)
- Makefile:110 `@rm -rf $(PACKAGE_DIR) $(DIST_DIR)` 把整个 dist/ 清掉
- Phase 3 restore dashscope 时 `make package` → bench-* 全部消失
- 临时保护：把 bench 数据落到 `docs/bench/snapshots/`
- 待修：改 Makefile 让 `make package` 只清 `dist/*.tar.gz` + `dist/*.sha256`，保留 bench-*

