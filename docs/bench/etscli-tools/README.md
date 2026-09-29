# etscli 直出工具形态 · function-call 测试产物导航

**正式口径(§7.94.8 起)= `--desc-lang match`**(en 用例→纯英文工具描述 / cn 用例→纯中文描述)+ 干扰项判定虚高。

| 目录 | 命令 | 说明 |
|---|---|---|
| `match-d3/` | `--desc-lang match --distractors 3` | **新模型验收就看这个**(needle: en 31% / cn 3% / 着陆率 en 41%) |
| `match-d0/` | `--desc-lang match --distractors 0` | match 无干扰基线(needle: en 44% / cn 3%) |
| `report.md` `results.json` | `--desc-lang cn --distractors 0` | ⚠️ 历史口径(§7.94.6/7):全局中文描述,英文分数混跨语言负担(en 26%) |
| `inflation-d3/` | `--desc-lang cn --distractors 3` | 历史口径的虚高实测(73%,含重复发送混淆项的 payload,已由 match-d3 取代) |

复现:
```bash
python3 scripts/etscli-tools-test.py --trials 2 --out dist/x            # match+d0(默认)
python3 scripts/etscli-tools-test.py --trials 2 --distractors 3 --out dist/y   # match+d3
python3 scripts/inflation-diff.py dist/x dist/y                          # 虚高对照
```
