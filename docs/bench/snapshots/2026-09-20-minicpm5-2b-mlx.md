# 2026-09-20 minicpm5-2b MLX 单次实测(§7.87.9)

## 结论先行

**minicpm5-2b-MLX @ 192.0.2.104:8080 不可用** — **C6 tool_call 0/17**。

| 维度 | vllm 67.0.0.5:28000 FP16(baseline) | **MLX 0.31.3 w4a16** | 差 |
|------|--------------------------------|---------------------|-----|
| Intrinsic | 77.8 | **41.5** | **-36.3** |
| Pipeline | 100 | **33.3** | **-66.7** |
| **Final** | **78.9 ⚠️** | **41.5 💀** | **-37.4** |
| C1 intent | 0.0(parse_rate 0) | 0.84(parse_rate 1.0) | **+0.84** ↑(意外提升)|
| C5 PII recall | 0.667 | 0.729 | +0.06 |
| **C6 tool_call** | **1.0(17/17)** | **0.0(0/17)** | **-1.0** 💀 |
| C7 mibao | 1.0 | 0.0 | fail |
| C9 localip | 1.0 | 0.0 | fail |
| C10 retention | 1.0 | 0.5 | -0.5 |

## 跑分数据

- 报告: `dist/bench-minicpm5-2b-mlx-debug-20260920-150418/report.md`
- scores: `dist/bench-minicpm5-2b-mlx-debug-20260920-150418/scores.json`
- traces: `dist/bench-minicpm5-2b-mlx-debug-20260920-150418/traces/{C1,C5,C6}.jsonl`
- 单次(no median):user 拍板"单次已够,直接结论:MLX minicpm5-2b 不适合"

## 测试动机

user 指令:"MiniCPM5-2B切换到 curl http://127.0.0.1:8080/v1/chat/completions -d '{\"model\": \"~/.cache/modelscope/models/OpenBMB--MiniCPM5-2B-MLX/snapshots/master\", ...}'，也是W4A16量化，这样统一了"

目标:让 size scaling comparison (9B > 4B > 2B) clean — 同 server (mlx @ 192.0.2.104:8080) 同 quantization (w4a16) 只有 model size 不同。

## 测试发现

### 1. Makefile env var 透传 bug

第一次跑(`make e2e-benchmark` 默认无 NO_THINKING=1)→ C1=0/C5=0.48/C6=0,所有 JSON 输出都跑到 `reasoning` 字段,`content` 永远空。

**根因**:Makefile recipe 用 `NO_THINKING=${NO_THINKING:-1}` 语法,Make 解析时认为 `NO_THINKING` 是 undefined var → 展开成空 → 传到 bash 子 shell 时 `NO_THINKING=` 被 unset,bench 默认 ON thinking mode。

**修法**(`Makefile:88-91`):改用 shell 风格 `export NO_THINKING=$${NO_THINKING:-1}` —— `$$` 透传给 shell,shell 才看到 `:-` 默认值。

### 2. NO_THINKING=1 修复后:C6 tool_call 仍然 0/17

修了 Makefile 之后重跑,C1=0.84(parse 正常),C5=0.729,但 C6 仍然是 0.0(0/17)。

**trace 关键观察**(`dist/.../traces/C6.jsonl` 全部 17 case):
- response.message 只有 `content`,**永远不出 `tool_calls` 数组**
- 同 server 上 qwen3.5-9b C6=1.0 → 不是 server bug
- 不是 prompt 强度问题(dashscope 同 prompt C6=0.938)

**推测根因**:
- vllm 0.29.0 FP16 path → 保留完整 model weights → tool_call classification head 正常
- mlx 4bit quantization (`bits:4, group_size:64, mode:affine`) → tool_call head 退化 → model 只学会出 prose 答案
- 这是 **model + quantization combo 失败**,不是 backup

### 3. Pipeline C7/C9 fail 是 cascading

- dsh-edge 路由正常(`intent=LOCAL`)
- 本地 LLM 不发 tool_call → bash 永远不跑 → log 里没 `tool=bash` → C9 assertion fail
- C7 同理:bash 不跑 → ets-auth skill 不触发 → "密盒登录状态" 无法查询 → result_len=69 不足 100

## Size Scaling 实际排名(更新)

| Rank | Model | Server | Quant | Final | Verdict |
|------|-------|--------|-------|-------|---------|
| 🥇 1 | dashscope-qwen3.7-plus | cloud | (内部) | 90.0 | ✅ |
| 🥇 1 | qwen3-4b (4B) | rknn | w4a16 | 90.0 | ✅ |
| 🥇 1 | qwen3.5-9b (9B) | mlx | w4a16 | 90.0 | ✅ |
| 4 | minicpm5-2b (2B) | vllm | FP16 | 78.9 | ⚠️ |
| 💀 5 | ~~minicpm5-2b (2B)~~ | ~~mlx~~ | ~~w4a16~~ | ~~41.5~~ | ~~💀 Reject~~ |

**Size scaling 验证状态**:**9B ≈ 4B ≥ 2B** — 4B rknn ≥ 9B mlx 是因为 Qwen3 系列强于 Qwen3.5;2B 必须在 FP16 (vllm) 才能勉强 Conditional;**2B MLX 量化不可用**。

## 行动

1. ✅ `.env.local-minicpm5-2b` **退回 vllm 67.0.0.5:28000**(78.9 ⚠️ 已确立 baseline)
2. ✅ `.env` 当前激活状态 snapshot 到 `docs/bench/snapshots/2026-09-20-minicpm5-2b-mlx.env`(gitignored)
3. ✅ `scripts/switch-local-llm.sh minicpm5-2b` 触发 dev-restart,dsh-edge up :21017
4. ✅ Makefile `e2e-benchmark` 加 NO_THINKING=1 默认 + Make→shell 透传修复
5. ❌ 不再尝试 MLX 量化 minicpm5-2b(同 server 同 quant 失败)
6. ✅ docs `test-case-design.md §5.2.7` 记录 + memory `bench-thinking-wire-body.md` 更新

## 教训(记 memory)

1. **Makefile env var 透传**:`${VAR:-default}` 是 shell 语法,Make recipe 里必须用 `$${VAR:-default}`(双 `$`)才能正确透传到子 shell
2. **MLX 量化兼容性是 model-specific**:不要假设"MLX 4bit 对所有 model 工作",换 model+quant combo 时必须先 C6 tool_call smoke test
3. **统一量化只对同一 model family 成立**:Qwen3.5 系列 mlx w4a16 工作良好,minicpm5-2b 在同 quant 下完全退化
4. **Pipeline 0 分 cascading**:本地 LLM 不发 tool_call → dsh-edge 路由正常 → bash 不跑 → log 缺 `tool=bash` → C7/C9 fail(假阴性)