# §7.87 Model Quality Bench — 测试用例设计

**当前版本**:v15.ter(56 cases, ~3-5min runtime,2026-09-20)
**关联**:`PROGRESS.md §7.87` | `scripts/e2e-model-quality-bench/` | `dist/bench-*/report.md` | `docs/bench/snapshots/`

---

## 1. 设计哲学(两阶段相对评估)

bench 不是给 LLM 打绝对分,而是 **两阶段相对评估**:

| 阶段 | 测什么 | 模型 | 用途 |
|------|--------|------|------|
| **Phase 1 Cloud baseline** | dsh-edge 完整性 | 云端大模型(qwen3.7-plus 等)当 local-LLM | 锚定"无 bug"上限,**修 dsh-edge bug 直到 baseline 100** |
| **Phase 2 小模型相对损失率** | 小模型能力 | 端侧小模型(minicpm5-2b / qwen3.5-9b 等) | 横向比模型适配度,不用绝对分 |

**Why 两阶段**:跨模型绝对分不可比。cloud baseline 锁"代码完整性",小模型比损失率(80% threshold 即 production-ready for small model)。

---

## 2. 测试矩阵(10 类 × 56 cases)

| # | Category | cases | 入口 | 评分 | Pass 阈值 |
|---|----------|-------|------|------|-----------|
| **C1** | Intent Classification | 12 | 直连 baseUrl | macro-F1 + parse rate + conf-MAE | F1 ≥ 0.85 |
| **C2** | Safety Classification | 8 | 直连 baseUrl | recall + FP-rate + parse | recall ≥ 0.80, FP ≤ 0.20 |
| **C3** | Chinese Q&A | 6 | 直连 baseUrl | completion-rate(gate) + ROUGE-L F1(info) | completion ≥ 0.85 |
| **C4** | JSON Structured Output | 5 | 直连 baseUrl | schema_acc + value_acc | schema ≥ 0.90, value ≥ 0.55 |
| **C5** | PII Detection | 12 | 直连 baseUrl | per-type recall + macro | macro ≥ 0.80, IP ≥ 0.20 |
| **C6** | Tool Calling | 10 | 直连 baseUrl | bash / web_search by-tool acc | overall ≥ 0.75 |
| **C7** | E2E Mibao | 1 | dsh-edge `/v1/chat` | intent=LOCAL + result | 1/1 |
| **C8** | E2E News | 1 | dsh-edge `/v1/chat` | intent=CLOUD + result + 无 tool deny | 1/1 |
| **C9** | E2E Local-IP | 1 | dsh-edge `/v1/chat` | intent=LOCAL + tool=bash | 1/1 |
| **C10** | Multi-turn Context | 3 × 3 turns | dsh-edge `/v1/chat` | keyword retention | **informational** |

**两维度独立**:
- **intrinsic (C1-C6, 53 cases)** → 测"模型本身能力",直连 baseUrl 绕开 dsh-edge
- **pipeline (C7-C10, 3+9 cases)** → 测"dsh-edge 系统联动",走完整 `/v1/chat`

```
final = 0.50 × intrinsic + 0.40 × pipeline + 0.10 × latency
```

**Verdict 阈值**(`fixtures/scoring_rubric.json`):

| Final | Verdict |
|-------|---------|
| ≥ 85 | ✅ Production-ready |
| 70-84 | ⚠️ Conditional — works for current 3 cases |
| 50-69 | ❌ Weak — risk on multi-turn / PII / adversarial |
| < 50 | 💀 Reject — basic intent / safety failing |

---

## 3. Category 简述

| C# | 测什么 | prompt/fixture 来源 |
|----|--------|---------------------|
| C1 | intent-router 把 query 分到 LOCAL/CLOUD/REJECT | system prompt 复自 `src/dsh-adapter/intent-router.ts:557-570` |
| C2 | prompt-guard 安全分类(recall/FP/parse) | system prompt 复自 `src/dsh-adapter/prompt-guard.ts:543-588`;对抗用例源 `tests/unit/prompt-guard.test.ts:1072-1132` (h1-h4) |
| C3 | 中文 Q&A 完整回复 + 不截断 | fixtures 用占位符 PII(reference = "无法访问"等)|
| C4 | 系统 prompt 要求 JSON → 模型 schema 合规 + 值准确 | schema 0.70 / value 0.30 加权,token-recall + case-insensitive + order-independent subset |
| C5 | 占位符 PII 检测(phone / id_card / ip / email) | per-type recall,IP 子阈值 0.20 防误伤 |
| C6 | tool calling 结构稳定性(bash + web_search + 模糊) | tool name exact match + args schema valid + arg value regex |
| C7-C9 | dsh-edge `/v1/chat` 跑 mibao / news / local-ip 三个核心场景 | intent + resultLen + 工具命中,1/1 gate |
| C10 | 5-turn conversation 后续 turn 是否引用前文 | keyword retention rate,**不计入 final 分** |

---

## 4. 三阶段使用方式

**Phase 1 — 修 dsh-edge 直到 baseline 100**:
```bash
bash scripts/switch-local-llm.sh dashscope-qwen3.7-plus
bash scripts/e2e-model-quality-bench.sh --label cloud-baseline-r1
# 必须 intrinsic + pipeline 都 100 → dsh-edge 完整性 OK
```

**Phase 2 — 横向比小模型适配度**(同 baseline 归一化):
```bash
bash scripts/switch-local-llm.sh minicpm5-2b
bash scripts/e2e-model-quality-bench.sh --label mini-r1
# mini-X / baseline × 100% < 80% = not production-ready
```

**横向对比 workflow**(per `switch-local-llm.sh`):
```bash
bash scripts/switch-local-llm.sh <model-name>   # 自动 backup + cp + dev-restart
bash scripts/e2e-model-quality-bench.sh --label <run-label>
# 至少 3 次取 median (bench 单次 intrinsic variance ~7)
```

**固件**:`scripts/switch-local-llm.sh` + `.env.local-<model>`(git-ignored)→ 一键切模型不复 edit `.env`。

---

## 5. 当前 baseline(2026-09-20, §7.87.8 3-model 纵线对比)

| 模型 | Server | Intrinsic | Pipeline | **Final** | Tier |
|------|--------|-----------|----------|-----------|------|
| **dashscope-qwen3.7-plus** (cloud) | cloud | **100.0** | 100.0 | **90.0** | ✅ Production-ready |
| **minicpm5-2b** | vllm @ 28000 | 77.8 | 100.0 | 78.9 | ⚠️ Conditional |
| qwen3.5-9b | llama.cpp @ 28001 | 52.3 | 100.0 | 66.2 | ❌ Weak |

**核心结论**:
- **§7.87.6 `whenIdle()` fix 跨 3 模型 + 3 server 后端 + 3 模型规模全部泛化** —— Pipeline 100/100 无一例外
- **「小模型 + 好 server > 大模型 + 差 server」** —— minicpm (2B + vllm) 78.9 > qwen3.5-9b (9B + llama.cpp) 66.2
- **dashscope 是首个 cloud baseline intrinsic+pipeline 双 100/100**(latency 0 是 bench 跳过 latency module,非模型问题)
- **minicpm 失败根因**:C1 intent-F1=0(2B 模型对"输出 JSON"指令不稳定)+ C5 IP-recall=0(2B 误判 `192.0.2.x` 为小数)—— 这是**模型能力天花板**,不是 dsh-edge 损失
- **qwen3.5-9b 失败根因**:llama.cpp 偶发 malformed tool_call 触发旧 C7 race(§7.87.6 已修),intrinsic 直连路径另受 server 端 chat-template 处理影响

**bench 单次 variance**:dashscope 0 / minicpm 0(2026-09-20 clean re-run 6/6 都 0)/ qwen3.5-9b 0(§7.87.7 3-run 全 52.3);早期 minicpm ±7 是 §7.87.6 fix 前的 qwen-style malformed race 残留,fix 后稳定。

**数据备份**:6 个 clean bench 的 `dist/bench-*` 因 §7.87.8 之前 `make package` wipe bug 被清,完整 per-run 表落 `docs/bench/snapshots/2026-09-20-3model-vertical.md`。

---

## 6. fixture 维护约定

- **占位符 PII**(`memory/test-fixture-no-real-pii`):
  - phone=`138xxxxxxxx`,id_card=`110101...`,email=`alice@example.com`
  - IP=`10.0.0.50 / 8.8.8.8 / 1.1.1.1 / 114.114.114.114`(常见真实 IP,非生产用户 IP)
  - ~~`192.0.2.x / 198.51.100.x / 203.0.113.x`~~(§7.87.3 O3 删除 — IANA 文档示例保留段,不是 PII,误标)
- **新增 fixture**:`--dry-run` 验证 schema;改 `fixtures/scoring_rubric.json` 阈值时**同时更新本文档**
- **fixture 调整**:改 fixture 必须配 bench 跑分,确认分数变化方向(↑↓→ 都要标注原因)
- **精简规则**(`§7.87.4`):54-56 cases 是当前 sweet spot;新增 case 必须能"暴露新 failure mode"

---

## 7. bench 流程稳定性(已知坑)

**坑 1:并发 bench 任务 `.env` race**
- `switch-local-llm.sh` 写共享 `.env`;两个 bench 任务并行会互踩 → 上次 dashscope-r2 跑出"Model=MiniCPM5-2B @ 28000"的污染数据
- **防御**:bench 重跑前 `TaskStop` 所有旧 task + `cp .env.local-*.env` 干净起点 + kill dsh-edge
- **永久规则**:横向对比永远单 task 顺序执行,绝不开并行

**坑 2:`make package` wipe `dist/bench-*`**(§7.87.8 修)
- 位置:`Makefile:110` 旧 `@rm -rf $(PACKAGE_DIR) $(DIST_DIR)` 把整个 `dist/` 清掉
- bench 任务 Phase 3 restore dashscope → `make package` → 6 个 `dist/bench-*` 全消失
- **修法**:Makefile:110 改只 `rm -rf $(PACKAGE_DIR)`,不清 `$(DIST_DIR)`(tarball/sha 在 line 139-140 写入覆盖旧的)
- **临时保护**:bench 数据落 `docs/bench/snapshots/<date>-<label>.md` 做 git-track 备份

**坑 3:env default restart required**(`memory/env-default-restart-required`)
- `.env` 改值不重启进程不 pick up
- **解决**:`scripts/switch-local-llm.sh` 内部调 `bash scripts/dev-restart.sh` 自动重启

---

## 8. 不做的事

- 不进 CI(LAN 依赖 + 5min runtime)—— user 手动 `make e2e-benchmark`
- 不自动选最优模型—— verdict 只给建议,user 决定
- 不评估 cloud LLM(DeepSeek / MiniMax)—— 本 bench 是 local LLM 适配度,cloud 是另一码事(已有 `e2e-ops-log-coverage.sh` 实测 news 用例)
- 不自动生成 fixture—— 维护靠 PR,跟现有 `tests/fixtures/` 同节奏
- 不集成 `/v1/benchmark` HTTP 路由—— standalone shell 即可

---

## 9. 关联文件

- **入口**:`scripts/e2e-model-quality-bench.sh` → `scripts/e2e-model-quality-bench/harness.py`
- **fixtures**:`scripts/e2e-model-quality-bench/fixtures/{intent,safety,chinese,json_output,pii,tools,multiturn,scoring_rubric}.json`
- **模型切换**:`scripts/switch-local-llm.sh` + `.env.local-<model>`(git-ignored)
- **Makefile**:`make e2e-benchmark` / `make package`(注意 §7 坑 2)
- **历史演进**:PROGRESS.md §7.87(从 v6 96.5→ v15 66.7 fix→ v15.ter 跨模型 100/100)