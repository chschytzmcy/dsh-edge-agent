# qwen3-4b LAN 3-run median(2026-09-20)

**Server**:192.168.1.174:8911/v1(model id = `llm-a`,rknn backend)
**.env snapshot**:`docs/bench/snapshots/2026-09-20-qwen3-4b.env`(gitignored)

| Run | Intrinsic | Pipeline | Final | C1 | C2 | C3 | C4 | C5 | C6 | C7 | C8 | C9 | C10 |
|-----|-----------|----------|-------|----|----|----|----|----|----|----|----|----|-----|
| r1 (115440) | 100 | 100 | **90.0** | 0.899 | 1.0 | 0.104 | 0.94 | 1.0 | 1.0 | PASS(251) | PASS(1341) | PASS(133) | 0.833 |
| r2 (115918) | 100 | 100 | **90.0** | 0.899 | 1.0 | 0.104 | 0.94 | 1.0 | 1.0 | PASS(246) | PASS(1641) | PASS(133) | 0.833 |
| r3 (120350) | 100 | 100 | **90.0** | 0.899 | 1.0 | 0.104 | 0.94 | 1.0 | 1.0 | PASS(251) | PASS(2185) | PASS(133) | 0.833 |
| **median** | **100** | **100** | **90.0** ✅ Prod-ready | 0.899 | 1.0 | 0.104 | 0.94 | 1.0 | 1.0 | PASS | PASS | PASS | 0.833 |

**variance**:3 runs 0 variance — temperature=0 deterministic + server 极稳定。
**intrinsic 失分点**:C3=0.104(自由 Q&A ROUGE-L informational)、C1=0.899(conf_mae=0.148 微偏离)。
**C10 retention**:83.3(informational,跟上轮 qwen3.5-9b-llama.cpp 61.1 比好得多)。

