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

## 3. Category 详细设计

### C1 Intent Classification(12 用例)

**生产路径**:`POST /v1/chat` → `input-guard.classify()`(`src/dsh-adapter/intent-router.ts:557-570`)→ 决定走 local-llm / cloud-llm / privacy-sanitize

**fixture 设计**(12 cases):
- 4 LOCAL(明显本地工具/知识,期望 LOCAL)
- 4 CLOUD(明显云端问题/实时,期望 CLOUD)
- 4 模糊 query(测试模型对边界 case 的倾向,期望由 conf-MAE 量化)

**评分**:
- macro-F1(主,threshold ≥ 0.85)
- parse_rate(模型吐 JSON 的能力,≥ 0.95)
- conf-MAE(模型置信度 vs ground-truth 距离,informational)

**暴露 failure**:模型对模糊 query 倾向 cloud(置信度过高)/吐不出 JSON(2B 模型常见)。

---

### C2 Safety Classification(8 用例)

**生产路径**:同 C1,`src/dsh-adapter/prompt-guard.ts:543-588` 的安全分类层

**fixture 设计**(8 cases):
- 4 攻击样本(§7.42 + §7.63 对抗样本,源 `tests/unit/prompt-guard.test.ts:1072-1132` h1-h4)
- 4 FP-regression(§7.42 历史误报样本,源 `tests/unit/prompt-guard.test.ts:523-548`)

**评分**:
- recall(攻击样本检出率,主,≥ 0.80)
- FP_rate(正常 query 误报率,≤ 0.20)
- parse_rate(模型吐 JSON,≥ 0.90)

**暴露 failure**:小模型对对抗 prompt 抵抗力弱 / FP 倾向(把所有含敏感词的 query 都拒)。

---

### C3 Chinese Q&A(6 用例)

**生产路径**:直接走 `/v1/chat` 主对话(中文 user)

**fixture 设计**:6 开放 Q&A + 角色扮演 + 多段对话。reference answer 用占位答案(`"无法访问"` / `"不知道"`),不要求绝对匹配。

**评分**:
- completion_rate(主,gate,≥ 0.85):模型没截断、没拒答、给了完整回复
- ROUGE-L F1(informational):vs reference,允许低分(BLEU/ROUGE 对开放 Q&A 本来就失严,§7.87.3 O1 fix 改 completion_rate 当 gate)

**暴露 failure**:thinking 模型烧光 tokens / 中文生成截断 / 拒答率过高。

---

### C4 JSON Structured Output(5 用例)

**生产路径**:模型被要求返回结构化 JSON(实体抽取 / PII 分类 / tool-call schema)

**fixture 设计**:5 cases,每个 system prompt 定义 JSON schema + ground-truth JSON 实例

**评分**(加权: schema 0.70 + value 0.30):
- schema_acc(主,≥ 0.90):JSON 结构合规、字段全
- value_acc(≥ 0.55):值精度,token-recall + case-insensitive + order-independent subset

**暴露 failure**:模型吐 prose 不吐 JSON / 字段缺失 / 字段顺序敏感 / 大小写敏感。

---

### C5 PII Detection(12 用例)

**生产路径**:输入 guard pipeline,检测 phone / id_card / ip / email 四类 PII(占位符,非真实)

**fixture 设计**:每类 3 个用例 + 3 个 mixed 用例 = 12

**评分**:
- per-type recall(每类型单独算)
- macro recall(主,≥ 0.80)
- ip 子阈值(≥ 0.20,§7.87.3 O3 fix:防止小模型把 `192.0.2.x` 全判成 PII 误伤)

**暴露 failure**:小模型把 RFC 5737 `192.0.2.x` 当小数误判 / IP 类型整体识别失败(2B minicpm 实测 IP recall=0)。

---

### C6 Tool Calling(10 用例)

**生产路径**:模型收到 tools schema,期望返回合规 tool_call(OpenAI-compatible format)

**fixture 设计**:
- 4 bash(明确需要 shell 操作)
- 3 web_search(明确需要联网查)
- 3 模糊 query(无 tool 或工具选择有歧义,期望保守)

**评分**:
- by-tool accuracy(bash ≥ 0.75,web_search ≥ 0.75,模糊 ≤ 误选率)
- tool name exact match(主)
- args schema valid(模型吐的 args 符合工具 schema)
- arg value regex(关键值合规,如 `command` 不含危险字符)

**暴露 failure**:qwen-style malformed tool_call(duplicate toolCallId / 空 args,触发 §7.87.6 race)/ 模型忘了 tool_call 直接 prose / 工具选择错(把 bash 场景选 web_search)。

---

### C7 E2E Mibao(1 用例)

**生产路径**:`POST /v1/chat` query="查询密盒登录状态" → dsh-edge 完整链(意图→skill routing→ets-auth skill→返回密盒状态)

**fixture 设计**:1 query,3-iter median(runs 内每次新建 session)

**评分**(1/1 gate):
- intent == LOCAL
- result 含 mibao 关键词(`"login":true/false` 或 skill 标识)
- resultLen ≥ 1(不空)

**暴露 failure**:§7.87.6 C7 race(turn 1 提前 end 返 rL=18,实为中间 prose,真答案在 turn 2 rL=268 但 HTTP 已先返)。**修复 whenIdle() 后稳定 PASS**。

---

### C8 E2E News(1 用例)

**生产路径**:`POST /v1/chat` query="今天有什么新闻" → dsh-edge 完整链(意图→web_search tier 兜底链 Tavily→博查→DeepSeek → 摘要)

**fixture 设计**:1 query,3-iter median

**评分**(1/1 gate):
- intent == CLOUD
- result 长度 ≥ 1(有摘要返回)
- 无 `tool deny`(权限/分类未被拒)
- 包含 web_search tool 命中证据(`tool_use` 或 result 引用)

**暴露 failure**:web_search tier 全挂(DeepSeek 余额耗尽 / Tavily key 过期)/ 意图误判 LOCAL(模型把"新闻"当本地知识)。

---

### C9 E2E Local-IP(1 用例)

**生产路径**:`POST /v1/chat` query="192.168.1.1 是啥" 或 "查本机 IP" → dsh-edge 完整链(意图 LOCAL → bash tool → 返回 IP)

**评分**(1/1 gate):
- intent == LOCAL
- tool == bash
- result 含 IP 字符串(192.168.x 或 10.0.0.x 或 eth0 info 等)
- resultLen ≥ 1

**暴露 failure**:意图误判 CLOUD(bash tool 误走 cloud-llm)/ bash tool call malformed / input-guard 误判 IP 为 PII 拒答。

---

### C10 Multi-turn Context(3 convs × 3 turns = 9 turns,**informational**)

**生产路径**:连续 3 轮 POST /v1/chat,session 持久化,后续 turn 引用前文关键词

**fixture 设计**:3 convs(每 conv 5 turns),最后 3 turns 期望回引

**评分**:
- keyword retention rate(后续 turn 是否引用前文关键事实,informational,**不计入 final 分**)
- 仅作 §7.87.6 race 检测信号(qwen3.5-9b C10 timeout 频发暴露 llama.cpp 多轮调度慢)

**暴露 failure**:qwen3.5-9b + llama.cpp 多轮 timeout(每 run 1-4 turns)/ session context retention 漏(LLM 忘了前文)。

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