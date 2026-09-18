# Model Quality Bench (§7.87)

评估本地 LLM 与本项目 (dsh-edge-agent) 的适配度。给单个模型跑 10 个 category、145 fixtures × 3 iter = 435 次 LLM 调用,输出每类分数 + 最终 0-100 分 + verdict 建议。

## 入口

```bash
# 跑全量(8-12 分钟)
bash scripts/e2e-model-quality-bench.sh --label qwen3.5-9b-lan

# 只跑某个 category
bash scripts/e2e-model-quality-bench.sh --only C1 --label smoke --iterations 1

# Strict 模式(任何 category < 阈值 → exit 1)
bash scripts/e2e-model-quality-bench.sh --label qwen3.5-9b --strict

# Makefile 入口
make e2e-benchmark LABEL=qwen3.5-9b-lan
```

## 配置来源

- `LOCAL_LLM_BASEURL` / `LOCAL_LLM_MODEL` —— `.env` 里已有
- `EDGE_API_KEY` —— `.env` 里已有
- 跑前会自动 source `$REPO_ROOT/.env`

## 输出

`dist/bench-${LABEL}-${TIMESTAMP}/`:

- `report.md` —— 人类可读报告(分数表 + verdict + 推荐/避免场景)
- `scores.json` —— 机器可读,所有 sub-metric,用于横向对比
- `traces/intrinsic/*.jsonl` —— 每次 LLM 调用的 request/response
- `traces/pipeline/*.json` —— 每次 dsh-edge /v1/chat 的完整记录

`dist/` 已在 .gitignore,只本地留档。

## 横向对比

跑 N 个不同 baseUrl 即可:

```bash
bash scripts/e2e-model-quality-bench.sh --label qwen3.5-9b
BASE_URL=http://192.168.66.195:8701/v1 MODEL=qwen3-4b bash scripts/e2e-model-quality-bench.sh --label qwen3-4b

# diff 两份报告
diff <(jq .final dist/bench-qwen3.5-9b-*/scores.json) \
     <(jq .final dist/bench-qwen3-4b-*/scores.json)
```

## 10 个 Category

| # | Category | 类型 | 用例数 | 阈值 |
|---|---------|------|-------|------|
| C1 | Intent classification | intrinsic | 30 | F1 ≥ 0.85 |
| C2 | Safety classification | intrinsic | 20 | recall ≥ 0.80, FP ≤ 0.20 |
| C3 | Chinese conversation quality | intrinsic | 15 | BLEU ≥ 0.25 |
| C4 | JSON structured output | intrinsic | 10 | schema ≥ 0.90, value ≥ 0.70 |
| C5 | PII detection recall | intrinsic | 20 | macro ≥ 0.80 |
| C6 | Tool calling reliability | intrinsic | 20 | acc ≥ 0.75 |
| C7 | E2E mibao | pipeline | 1(×3 iter) | pass |
| C8 | E2E news | pipeline | 1(×3 iter) | pass |
| C9 | E2E local-ip | pipeline | 1(×3 iter) | pass |
| C10 | Multi-turn context | pipeline | 5 conv × 5 turns | retention ≥ 0.70 |

**Intrinsic**(C1-C6)= 直连 `${BASE_URL}/chat/completions`,验证模型本身质量。
**Pipeline**(C7-C10)= 走 `POST /v1/chat`,验证与 dsh-edge 全链路联动。

## 评分公式

```
intrinsic_score = mean(C1..C6 scores)        # 50% 权重
pipeline_score  = mean(C7..C10 scores)        # 40% 权重
latency_score   = 100 - normalize(p95_lat)   # 10% 权重
final_score     = 0.50 × intrinsic + 0.40 × pipeline + 0.10 × latency

verdict:
  ≥ 85  → ✅ Production-ready
  70-84 → ⚠️  Conditional
  50-69 → ❌ Weak
  < 50  → 💀 Reject
```

权重 + 阈值在 `fixtures/scoring_rubric.json`,可通过 `--rubric` 覆盖。

## 加新 fixture

每个 category 一个 JSON 文件,格式见现有文件。原则:

- **PII 必须用占位符**(13800138000 / 110101199003078811 / 192.0.2.x / alice@example.com)— 真实 PII 禁止(memory `test-fixture-no-real-pii`)
- **fixture 数尽量 30+** 才有统计意义
- **expected 字段要明确**(category / tool / values),便于评分

加完后跑 `--only <新 category>` 单测验证。

## 故障排查

| 症状 | 排查 |
|------|------|
| `baseUrl unreachable` | 验证 `${BASE_URL}/models` 200 OK;firewall / VPN |
| `dsh-edge unreachable` | 验证 `${DSH_URL}/health` 200 OK;`install.sh --no-restart` 启服务 |
| `jieba not available` | `pip install jieba`(BLEU 退化为 char-level) |
| `scikit-learn not available` | `pip install scikit-learn`(F1 退化为 accuracy) |
| C7-C9 全部 fail | 检查 dsh-edge 是否跑;`EDGE_API_KEY` 是否正确;log file 路径 |
| 跑太久(>15min) | 减少 `--iterations` 到 1,或只跑 `--only C1,C7` |

## 与现有 E2E 的关系

| 脚本 | 用途 | 跑频 |
|------|------|------|
| `scripts/e2e-ops-log-coverage.sh` | **回归** — 验 dsh-edge 系统不 regress | 每次 PR(进 CI) |
| `scripts/e2e-model-quality-bench.sh` | **选型** — 验 model 是否适合本项目 | 手动跑(LAN 依赖) |

两者互补:回归测系统,bench 测模型。

## 不做

- 不进 CI(LAN 依赖 + 8-12 分钟太长)
- 不评估 cloud LLM(DeepSeek / MiniMax)— 那是 e2e-ops-log-coverage news 用例的活
- 不自动选最优模型 — verdict 只给建议,user 决定
- 不集成到 `/v1/benchmark` HTTP 路由(本期 standalone shell)
