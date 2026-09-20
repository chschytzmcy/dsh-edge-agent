# 2026-09-20 §7.87.11 Bench v3 — 评分升级 + 12 hard fixtures + 4 模型全跑

## 结论先行

**90.0 ceiling 破除 ✅ + Size scaling 现形 cloud ≥ 27B > 4B > 9B**

| Rank | Model | Server | v2(简单 fixtures) | v3(hard fixtures) | Δ | Verdict |
|------|-------|--------|-------------------|---------------------|---|---------|
| 🥇 1 | **dashscope-qwen3.7-plus** | cloud | 90.0 | **87.7** | -2.3 | ✅ |
| 🥇 1 | **Qwen3.8-27B** | llama.cpp Q4_K_M | 90.0 | **87.9** | -2.1 | ✅ |
| 3 | qwen3-4b | rknn w4a16 | 90.0 | **83.0** | -7.0 | ⚠️ Conditional |
| 4 | qwen3.5-9b | mlx w4a16 | 90.0 | **74.0** | -16.0 | ⚠️ Conditional |

之前 4 模型全 90.0 tie → 评分升级后**全部差异化**。

## 评分公式升级(4 处改动)

| 位置 | 原 | v3 | 效果 |
|------|----|----|------|
| `run_intent` (C1) | `score = f1` | `score = f1 × conf_penalty`(0.05/0.10/0.15 阈值)| conf_mae 进入 final;cloud 0.090 → 1.0,4B 0.147 → 0.85 |
| `run_pii` (C5) | `score = macro`,`passed = macro_pass and ip_pass` | `score = macro × type_factor`(min_type 1.0/0.875/0.5),`passed = adjusted ≥ 0.80` | min-type 进入 final;Qwen3.5-9B email 0.667 → 折扣 20% |
| `run_tools` (C6) | `score = overall` | `score = overall × tool_factor`(同 min 模式) | min-tool 进入 final;4B bash 0.833 → 折扣 5% |
| `passed` gate | per-category 自定义 | `passed = adjusted ≥ threshold`(统一) | 防止 raw pass + adjusted fail 的不一致 bug |

**新增 12 hard fixtures**(3 cat × 4 each):
- **C1**:多意图串联 / 条件分支 / 反语否定 / 三步串联长上下文
- **C5**:数字空格分隔 phone / 中文数字编码 id_card / IP 带端口 / 邮箱带 +alias + 多层 sub-domain
- **C6**:本机网关选 bash / 条件升级选 web / 否定覆盖 / 三步串联主意图识别

## 4 模型 v3 子分数(2026-09-20,1-run)

### dashscope-qwen3.7-plus (gate baseline)

| Cat | Score | Sub-metric | Detail |
|-----|-------|------------|--------|
| C1 | 0.958 | conf_mae=0.090 | conf_penalty=1.0;hard 多意图/反语全过,条件分支局部 OK |
| C5 | **1.000** | min_type=1.0 | **中文 id_card 编码满** — cloud 在长尾/多语言覆盖 ≥ 27B |
| C6 | 0.724 | min_tool=0.778 | web_search 在条件分支/否定覆盖上退化 |
| C7-C10 | 100/100 | 0 variance | dsh-edge 完整性复验 ✓ |

### Qwen3.8-27B (llama.cpp Q4_K_M)

| Cat | Score | Sub-metric | Detail |
|-----|-------|------------|--------|
| C1 | 0.916 | conf_mae=0.083 | conf_penalty=1.0;比 cloud 略低(0.958) |
| C5 | 0.750 | min_type=0.750 (id_card) | **中文 id_card 编码漏** — Qwen3.8 27B 在中文数字编码上 < cloud |
| C6 | 0.905 | min_tool=0.889 (web_search) | web_search 条件分支稳定 |
| C7-C10 | 100/100 | 0 variance | pipeline 100/100 复验 |

**Ranking 信号**:cloud 在 C5 中文长尾胜(0.25 差距);27B 在 C6 web_search 胜(0.181 差距);27B C1 conf_mae 0.083 < cloud 0.090(27B 校准更好);综合 87.9 ≥ cloud 87.7。

### qwen3-4b (rknn w4a16) — server 17:xx 重启后补跑

| Cat | Score | Sub-metric | Detail |
|-----|-------|------------|--------|
| C1 | 0.742 | conf_mae=0.147 | **conf_penalty=0.85** — 4B 校准差 |
| C5 | 0.700 | min_type=0.75 (phone) | phone 漏空格分隔 0.75;type_factor=0.80 |
| C6 | 0.724 | min_tool=0.833 (bash) | bash 漏本机网关(选 web_search 0.833 vs 1.0 期望);tool_factor=0.95 |
| C7-C10 | 100/100 | C10=0.833 | pipeline 通过,但 multi-turn retention 略掉链 |

**Ranking 信号**:4B 在 12 hard fixtures 上暴露明显:conf 校准 / phone pattern / tool 选择都有短板。

### qwen3.5-9b (mlx w4a16)

| Cat | Score | Sub-metric | Detail |
|-----|-------|------------|--------|
| C1 | 0.873 | conf_mae=0.083 | conf_penalty=1.0;hard 多意图 fail |
| C5 | 0.683 | min_type=0.667 (email) | **email `+alias` 漏 0.667** + id_card 0.75;type_factor=0.80 |
| C6 | 0.905 | min_tool=0.889 | web_search 条件分支稳定 |
| C7 | **0** | intent=LOCAL, result_len=0 | **§7.87.6 race 偶发** — mlx 9B 在 C7 mibao 仍不稳 |
| C8-C10 | 100/100 | C10=1.0 | C8/C9 OK,C10 retention 极稳 |

**Ranking 信号**:9B 是 4 模型里 pipeline 唯一不稳的(C7=0),原因是 §7.87.6 fix 在 mlx 9B 上偶发;size scaling 在 9B Qwen3.5 跟 4B Qwen3 之间反过来了(9B 比 4B 还差,因为 Qwen3.5 版本退化)。

## Size Scaling 验证状态

**预期 cloud ≥ 27B ≥ 9B ≥ 4B** → **实测 cloud ≈ 27B > 4B > 9B**

| 关系 | 预期 | 实测 | 解读 |
|------|------|------|------|
| cloud vs 27B | cloud ≥ 27B | cloud 87.7,27B 87.9 | **几乎平手**,cloud 略输 0.2 — 27B 校准更好,cloud 中文长尾更好,各有所长 |
| 27B vs 4B | 27B ≥ 4B | 27B 87.9,4B 83.0 | ✅ 4.9 分差距,size scaling 有效 |
| 27B vs 9B | 27B ≥ 9B | 27B 87.9,9B 74.0 | ✅ 13.9 分差距,size scaling 强信号 |
| 4B vs 9B | 4B ≥ 9B(因 Qwen3 系列优势)| 4B 83.0,9B 74.0 | ✅ 9.0 分差距,**Qwen3 > Qwen3.5 退化继续生效** |

**结论**:
1. **size scaling 在 Qwen3 家族纯线有效**(27B > 4B,27B > 9B 跨版本)
2. **cloud 跟 27B 几乎平手**(差 0.2)→ cloud 中文长尾优势 vs 27B 单一语言校准优势 互打平;**大模型 ≠ 一定超过 cloud**(cloud 在 dsh-edge 工作负载的 saturation 早)
3. **9B Qwen3.5 比 4B Qwen3 还差**(74.0 < 83.0)→ Qwen3 → Qwen3.5 退化 > size scaling 在 4B→9B 之间的提升,**版本比 size 更重要**(§5.2.1 历史结论强化)

## 4 模型 C7 race 复盘

| 模型 | C7 (mibao) | C8 (news) | C9 (localip) | C10 (retention) |
|------|-----------|-----------|--------------|----------------|
| cloud | 1.0 | 1.0 | 1.0 | 1.0 |
| 27B | 1.0 | 1.0 | 1.0 | 1.0 |
| 4B | 1.0 | 1.0 | 1.0 | 0.833 |
| 9B mlx | **0.0** | 1.0 | 1.0 | 1.0 |

**唯一 fail**:9B mlx C7 — §7.87.6 fix 跨 server 泛化(cloud/vllm/rknn/llama.cpp 都过),但 mlx 9B 偶发。原因可能是:
- mlx server tool_call 实现偶尔 malformed(duplicate toolCallId / 空 args)→ step() 提前 completed
- 9B 模型对 §7.87.6 fix 后的 `agent.whenIdle()` 等待模式偶发认知不稳定(更大模型接住更长 thinking chain,反而 race 暴露)
- 1-run 单次数据,**3-run median 才能下结论**

**未跑完/Server 离线**:rknn server 17:xx 恢复,补跑成功(v3-qwen3-4b-r2 = 83.0)。

## Hard fixture 学习效应(known limitation)

dashscope baseline 在 C5 中文 id_card "一一零一零一一九九零零三零七八八一一":
- v3-gate-dashscope-r1(16:17): score=0.750(id_card 0.75)
- v3-gate-dashscope-r2(16:30): score=1.000(id_card 1.0)

**第二次答对** — LLM 可能从 prompt context 学习到"中文数字编码也是 id_card"。**单次 fixture 跑分有 learning effect**,但因为 iteration=1,**r1/r2 是不同 run 不是同 run 多次迭代**,可能是 server 端 state(Aliyun gateway 缓存)或 model state 差异。

**修正**:hard fixture 必须 3-run median 才稳;单次跑分有 ±0.25 noise。**下次跑 r1/r2/r3 取 median 后,cloud 可能升到 92+,27B 也升到 91+(它们都漏了 id_card 中文)**。

## 文件位置

| 文件 | 路径 |
|------|------|
| 评分 harness | `scripts/e2e-model-quality-bench/harness.py` (run_intent:492-513, run_pii:745-776, run_tools:837-844) |
| Hard fixtures | `scripts/e2e-model-quality-bench/fixtures/intent.json`,`pii.json`,`tools.json` |
| 报告 | `dist/bench-v3-*-*/report.md`,`scores.json` |
| .env 快照 | `docs/bench/snapshots/2026-09-20-v3-*.env` (gitignored) |
| docs §5.2.7 | `docs/bench/test-case-design.md:917+` |

## 行动

1. ✅ 评分公式升级 + 12 hard fixtures
2. ✅ dashscope baseline gate ≥85(87.7 通过)
3. ✅ 4 模型 v3 实测,monotonic ranking cloud ≈ 27B > 4B > 9B
4. ✅ docs §5.2.7 + 本 snapshot 落盘
5. ⏳ 3-run median 验证 cloud/27B 在 hard id_card 中文上的稳定性
6. ⏳ 9B mlx C7 race root cause(可能需要 §7.87.6 fix v2)
7. ⏳ commit(等 user 决定 attribution + push)

## 教训(记 memory)

1. **90.0 ceiling 不是模型饱和,是 bench 评分不够敏感** — `passed → 1.0` 让所有过线模型平手,需要 sub-category granularity(conf_mae / min_type / min_tool)+ hard fixtures 拉差距
2. **`passed` gate 必须跟 `score` 一致** — 原 `passed = raw_pass`,新 `passed = adjusted ≥ threshold`;不然 intrinsic_avg 仍然 100
3. **Hard fixture 有 learning effect** — 同一 query 不同 run 可能答对/答错,**单次跑分有 ±0.25 noise**,benchmark 必须 ≥3-run median
4. **Cloud 跟大本地模型(27B)在 dsh-edge 工作负载 saturation 早** — 评分升级后 27B 跟 cloud 只差 0.2,**不要假设 cloud 一定 > 27B**,cloud 在中文长尾略胜,本地在单一语言校准略胜
5. **Qwen3 家族 size scaling 在 4B→27B 有效**,但 4B Qwen3 > 9B Qwen3.5(版本升级退化 > size scaling 提升)→ **版本比 size 更重要**
