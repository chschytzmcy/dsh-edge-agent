# etscli 直出工具形态 · function-call 测试产物导航

**正式口径(§7.94.8 起)= `--desc-lang match`**(en 用例→纯英文工具描述 / cn 用例→纯中文描述)+ 干扰项判定虚高。

| 目录 | 产物 | 命令 | 说明 |
|---|---|---|---|
| [`match-d3/`](match-d3/) | [`report.md`](match-d3/report.md) · [`results.json`](match-d3/results.json) · [`diff.txt`](match-d3/diff.txt) | `--desc-lang match --distractors 3` | **新模型验收就看这个**(needle: en 31% / cn 3% / 着陆率 en 41%) |
| [`match-d0/`](match-d0/) | [`report.md`](match-d0/report.md) · [`results.json`](match-d0/results.json) | `--desc-lang match --distractors 0` | match 无干扰基线(needle: en 44% / cn 3%) |
| [根目录](.) | [`report.md`](report.md) · [`results.json`](results.json) | `--desc-lang cn --distractors 0` | ⚠️ 历史口径(§7.94.6/7):全局中文描述,英文分数混跨语言负担(en 26%) |
| [`inflation-d3/`](inflation-d3/) | [`report.md`](inflation-d3/report.md) · [`results.json`](inflation-d3/results.json) · [`diff.txt`](inflation-d3/diff.txt) | `--desc-lang cn --distractors 3` | 历史口径的虚高实测(73%,含重复发送混淆项的 payload,已由 match-d3 取代) |

每个目录里成对存着两份产物，**都要保留**：

| 文件 | 角色 |
|---|---|
| `report.md` | **人类可读版**——结论、错误模式分类、needle 命中率表。评测结果的唯一可读载体 |
| `results.json` | **机器可读版**——逐 trial 的原始判定，供脚本/训练管线消费 |
| `diff.txt` | 仅 `inflation-d3/` / `match-d3/` 有:与 match-d0 的差异对照(虚高来源) |

> `report.md` 曾因「按文件名统计引用数 = 0」被误判为孤儿文档(§7.146 审计)。教训:
> 引用统计必须**按路径**匹配——本目录三个 `report.md` 同名,按名统计会互判成
> 假阳性。评测原始产物**不按「没人引用」删**。
> 现在本文件是这些产物的**导航面**,每个文件都有显式链接——
> `scripts/verify-doc-links.mjs` 门禁会检查「每个 docs/ 产物都能从某个导航面到达」。

复现:
```bash
python3 scripts/etscli-tools-test.py --trials 2 --out dist/x            # match+d0(默认)
python3 scripts/etscli-tools-test.py --trials 2 --distractors 3 --out dist/y   # match+d3
python3 scripts/inflation-diff.py dist/x dist/y                          # 虚高对照
```

## 训练用产物

| 文档 | 说明 |
|---|---|
| [`minimal-pairs.md`](minimal-pairs.md) | 端侧训练要补的 minimal pair 清单(P0 18 对 / P1 14 对 / 兜底 8 例,≈142 条),由 match-d0/d3 的错误模式分类反推 |
| [`train/p0.jsonl`](train/p0.jsonl) | P0 优先级的最小对训练样本(jsonl) |
| [`train/tools.json`](train/tools.json) | 训练用工具集定义(工具描述 / 参数 schema) |
