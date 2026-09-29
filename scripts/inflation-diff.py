#!/usr/bin/env python3
"""inflation-diff.py — 对比同一语料两次 etscli-tools-test 运行,量化词法虚高。

用法:
  python3 scripts/inflation-diff.py <基线out_dir> <干扰out_dir>
  # 例:python3 scripts/inflation-diff.py dist/infl-base dist/infl-d3

对齐键为 (case_id, lang)。CaseResult 按 case 聚合(trials 次计数),贪心解码下
同一 (query, tools) 输出确定,case 级比较即有效比较。

三类信号:
  - **被诱导改口**:基线 correct>0,加干扰后 correct 下降且 picked_distractor>0
    —— 强虚高证据(原本能答对的工具,被近义名字拽走)
  - **误处仍被诱导**:基线本就 0 对,干扰后仍 0 对但选中了干扰项 —— 与虚高无关,
    只说明它本来就错,错的方向恰好挨着干扰项
  - **噪声翻转**:基线错 → 干扰后对(prompt 变化引起的非能力波动)

虚高率口径:被诱导改口次数 / 基线正确次数(即基线分数里多少成分经不起同义干扰)。
退出码:0(纯报告);2 参数错误。
"""
from __future__ import annotations

import json
import sys


def load(out_dir: str) -> dict:
    with open(f"{out_dir}/results.json", encoding="utf-8") as f:
        blob = json.load(f)
    rows = {}
    for r in blob["results"]:
        if not r["expect_tools"]:
            continue  # 负例不注入干扰,不参与虚高
        rows[(r["case_id"], r["lang"])] = r
    return {"blob": blob, "rows": rows}


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    base, d3 = load(sys.argv[1]), load(sys.argv[2])
    print(f"基线: {sys.argv[1]} (distractors={base['blob'].get('distractors', 0)}, "
          f"trials={base['blob'].get('effectiveTrialsPerCase', '?')})")
    print(f"干扰: {sys.argv[2]} (distractors={d3['blob'].get('distractors', 0)}, "
          f"trials={d3['blob'].get('effectiveTrialsPerCase', '?')})")
    common = sorted(set(base["rows"]) & set(d3["rows"]))
    only = set(base["rows"]) ^ set(d3["rows"])
    if only:
        print(f"⚠ 语料不一致,{len(only)} 个 case 无法对齐")

    total_lured = total_base_correct = 0
    for lang in ("en", "cn"):
        keys = [k for k in common if k[1] == lang]
        b_ok = sum(base["rows"][k]["correct"] for k in keys)
        d_ok = sum(d3["rows"][k]["correct"] for k in keys)
        n = sum(base["rows"][k]["trials"] for k in keys)
        lured, lured_cases = [], []
        attracted_wrong, noise_right = 0, []
        for k in keys:
            b, d = base["rows"][k], d3["rows"][k]
            drop = b["correct"] - d["correct"]
            trap = d["picked_distractor"]
            if drop > 0 and trap > 0:
                lured.append(drop)
                lured_cases.append((k[0], trap, drop, b["correct"], d["correct"]))
            elif b["correct"] == 0 and trap > 0:
                attracted_wrong += trap
            if d["correct"] > b["correct"]:
                noise_right.append(k[0])
        print(f"\n── {lang} ──  ({n} 次正例试验)")
        print(f"  工具正确率:基线 {b_ok}/{n} ({b_ok/max(1,n):.0%}) → "
              f"干扰 {d_ok}/{n} ({d_ok/max(1,n):.0%})  Δ {(d_ok-b_ok)/max(1,n):+.0%}")
        print(f"  被诱导改口:{sum(lured)} 次试验(涉及 {len(lured_cases)} 个 case)")
        if lured_cases:
            print("    " + ", ".join(f"{c}(选干扰{t},对{bo}→{dc})"
                                     for c, t, _, bo, dc in lured_cases))
        print(f"  基线已错仍选中干扰项:{attracted_wrong} 次(非虚高,本就错)")
        print(f"  错→对(噪声):{len(noise_right)} 个 case"
              + (f" {','.join(noise_right)}" if noise_right else ""))
        total_lured += sum(lured)
        total_base_correct += b_ok

    print(f"\n== 虚高口径 == 基线共答对 {total_base_correct} 次,"
          f"其中 {total_lured} 次被同义干扰改口 → 基线分数的 "
          f"{total_lured/max(1,total_base_correct):.0%} 经不起词形近义考验"
          if total_base_correct else "\n== 基线正确 0 次,无虚高可测 ==")
    return 0


if __name__ == "__main__":
    sys.exit(main())
