#!/usr/bin/env python3
"""etscli-minimal-pairs.py — 把端侧训练要补的 minimal pair(P0)导成 JSONL 训练样本。

数据源:`docs/bench/etscli-tools/minimal-pairs.md` 的 P0 三组,本脚本是**唯一真源**
(文档表格由 `--emit-md` 生成,勿手改)。错误证据来自 §7.94.9 错误模式分类
(`docs/bench/etscli-tools/match-d0/report.md` §1.3)。

产出:
  <out>/p0.jsonl        每行一个训练样本(messages + expected + hard_negatives)
  <out>/tools.json      47 工具 schema 侧车文件(en / cn 两套描述,match 口径)

用法:
  python3 scripts/etscli-minimal-pairs.py --out docs/bench/etscli-tools/train
  python3 scripts/etscli-minimal-pairs.py --with-tools     # 每行内联完整工具集
  python3 scripts/etscli-minimal-pairs.py --check          # 只校验不落盘
  python3 scripts/etscli-minimal-pairs.py --emit-md        # 打印 P0 表格(同步文档用)

样本字段:
  id            稳定 id,同一 query 只出现一次(被多组覆盖时 groups 里并列)
  groups        [{id, role}] —— 所属组与在该组里的方向:`a` / `b` / `-`(反弃答)
  lang          en / cn(query 与工具描述同语言,match 口径)
  cue           判别线索(人读的说明,不上 prompt)
  hard_negatives 与期望工具最像但不是正解的工具
  messages      OpenAI chat 形态
  expected      {tool, arguments}
  evidence      来自哪次实测的错误模式(人读)
  tools         仅 --with-tools 时内联

约定:
  - 每个对照对**双向**呈现(a 与 b 各一条):单向对教偏见不教分辨
  - 一对两条 query 句式逐字相同,只换名词 —— 改写句式会让模型学风格不学边界
  - `arguments` 只填 query 里字面出现的值;实体一律占位(§test-fixture-no-real-pii)
  - 训练集**不使用** alt 双可接受标签(语料里的 alt 是测试宽容,训练必须唯一 gold)
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location(
    "etscli_tools_test", _HERE / "etscli-tools-test.py")
_t = importlib.util.module_from_spec(_spec)
sys.modules["etscli_tools_test"] = _t
_spec.loader.exec_module(_t)

#: 工具名 → {props, required},用于校验 arguments
SPEC: dict[str, tuple[dict, list[str]]] = {
    name: (props, rest[0] if rest else [])
    for name, _cn, _en, props, *rest in _t._TOOL_SPEC
}

PW = "Pwd-demo-2026"   # 占位口令,非真实凭证
IP = "192.0.2.10"      # RFC 5737 文档地址段


def _q(tool: str, en: str, cn: str, args: dict, cue: str, evidence: str) -> dict:
    return {"tool": tool, "en": en, "cn": cn, "args": args, "cue": cue,
            "evidence": evidence}


# ── P0-A 同动词跨 service(14 对)──────────────────────────────────────────
# 根因:模型缺「query 里的名词 → service」绑定,不是不懂动词。
#
# 措辞纪律(§7.94.12):42 例验收语料是**判卷卷子**,P0 训练样本不得与它逐字相同或近重复,
# 否则训完再考就是背答案。`--check-corpus` 是硬闸。链式对照对(list 链、detail 链)
# 共用同一句式框架,组内只换名词 —— 链上 5 个工具各写各的会让"只换名词"的设计失效。
PAIRS_A = [
    ("01", _q("etscli_auth_list", "enumerate every saved login profile",
              "把已保存的登录配置都列一下", {}, "profile vs 账户",
              "auth_list→user_list"),
     _q("etscli_user_list", "enumerate every account on the device",
        "把设备上的账户都列一下", {}, "profile vs 账户",
        "auth_list→user_list")),
    ("02", _q("etscli_user_list", "enumerate every account on the device",
              "把设备上的账户都列一下", {}, "账户 vs 群聊", "user_list 塌缩"),
     _q("etscli_chat_list", "enumerate every group conversation I belong to",
        "把我参与的群聊都列一下", {}, "账户 vs 群聊", "user_list 塌缩")),
    ("03", _q("etscli_chat_list", "enumerate every group conversation I belong to",
              "把我参与的群聊都列一下", {}, "群聊 vs 会议", "cn 幻觉集中区"),
     _q("etscli_meeting_list", "enumerate every meeting scheduled on the device",
        "把设备上排的会议都列一下", {}, "群聊 vs 会议", "cn 幻觉集中区")),
    ("04", _q("etscli_meeting_list", "enumerate every meeting scheduled on the device",
              "把设备上排的会议都列一下", {}, "会议 vs 分享链接", "sharing-list→乱选"),
     _q("etscli_sharing_list", "enumerate every share link I generated",
        "我生成的分享链接都列一下", {}, "会议 vs 分享链接", "sharing-list→乱选")),
    ("05", _q("etscli_user_detail", "pull up everything recorded about user01",
              "把 user01 的情况都查出来", {"uid": "user01"}, "用户 vs 会议",
              "detail 塌缩"),
     _q("etscli_meeting_detail", "pull up everything recorded about meeting mtg001",
        "把会议 mtg001 的情况都查出来", {"meeting_id": "mtg001"},
        "用户 vs 会议", "detail 塌缩")),
    ("06", _q("etscli_user_detail", "pull up everything recorded about user01",
              "把 user01 的情况都查出来", {"uid": "user01"}, "用户 vs 密盒文件",
              "detail 塌缩"),
     _q("etscli_file_detail", "pull up everything recorded about box file f_12345",
        "把密盒文件 f_12345 的情况都查出来", {"file_id": "f_12345"},
        "用户 vs 密盒文件", "detail 塌缩")),
    ("07", _q("etscli_file_search",
              "look for anything named report anywhere on the device",
              "在整台设备上找一下名字是 report 的东西", {"keyword": "report"},
              "全设备 vs 指定目录", "**file↔fs 双向**"),
     _q("etscli_fs_search",
        "look for anything named report under the /photos directory",
        "在 /photos 目录里找一下名字是 report 的东西",
        {"path": "/photos", "name": "report"}, "全设备 vs 指定目录",
        "**file↔fs 双向**")),
    ("08", _q("etscli_meeting_create", "set up a new meeting called sprint review",
              "帮我建一个叫 sprint review 的会议吧", {"name": "sprint review"},
              "会议 vs 分享链接", "sharing_delete→sharing_create"),
     _q("etscli_sharing_create", "set up a new share link for box file f_12345",
        "帮我建一个 f_12345 的分享链接吧", {"file_id": "f_12345"},
        "会议 vs 分享链接", "sharing_delete→sharing_create")),
    ("09", _q("etscli_user_register", "set up a new account named bob on the device",
              "在设备上帮我建一个叫 bob 的账户吧",
              {"username": "bob", "password": PW}, "账户 vs 目录",
              "fs_mkdir 误选 5 次"),
     _q("etscli_fs_mkdir", "set up a new directory named backup on the device",
        "在设备上帮我建一个叫 backup 的目录吧", {"path": "/backup"},
        "账户 vs 目录", "fs_mkdir 误选 5 次")),
    ("10", _q("etscli_auth_rename", "profile office should be called company from now on",
              "office 这个配置以后就叫 company 了",
              {"old": "office", "new": "company"}, "配置名 vs 路径",
              "auth_rename→fs_rename"),
     _q("etscli_fs_rename",
        "box file /photos/a.jpg should be called /photos/b.jpg from now on",
        "密盒上的 /photos/a.jpg 以后就叫 /photos/b.jpg 了",
        {"src": "/photos/a.jpg", "dst": "/photos/b.jpg"}, "配置名 vs 路径",
        "auth_rename→fs_rename")),
    ("11", _q("etscli_auth_login", f"sign in to the device at {IP} using the account admin",
              f"用 admin 这个账号登录到 {IP} 这台设备",
              {"server": IP, "username": "admin", "password": PW},
              "账号凭证 vs 迁移会话", "**12 次误选,头号磁吸**"),
     _q("etscli_migrate_session_login",
        "open a session for the data migration workflow",
        "为数据迁移流程开一个会话", {}, "账号凭证 vs 迁移会话",
        "**12 次误选,头号磁吸**")),
    ("12", _q("etscli_migrate_transfer",
              "copy everything from the retired device onto the current one",
              "把退役设备上的东西都搬到当前这台", {}, "执行迁移 vs 确认结果",
              "transfer↔verify 互换"),
     _q("etscli_migrate_verify", "confirm the migration really did succeed",
        "确认迁移是不是真的成功了", {}, "执行迁移 vs 确认结果",
        "transfer↔verify 互换")),
    ("13", _q("etscli_file_delete", "wipe box file f_12345 for good",
              "把 f_12345 这个密盒文件彻底删掉", {"file_ids": ["f_12345"]},
              "密盒文件 vs 分享链接", "cn 误选落点"),
     _q("etscli_sharing_delete", "wipe share link sh_67890 for good",
        "把 sh_67890 这个分享链接彻底删掉", {"share_id": "sh_67890"},
        "密盒文件 vs 分享链接", "cn 误选落点")),
    ("14", _q("etscli_system_info", "give me the config overview of this device",
              "把这台设备的配置概况给我", {}, "配置 vs 健康", "health→幻觉 2 次"),
     _q("etscli_system_health", "give me the health overview of this device",
        "把这台设备的健康概况给我", {}, "配置 vs 健康", "health→幻觉 2 次")),
]

# ── P0-B 同 service 近义动词(3 对)─────────────────────────────────────────
PAIRS_B = [
    ("15", _q("etscli_chat_send",
              "post the text hello into group chat ch_001",
              "把 hello 这条文字发到群聊 ch_001 里",
              {"chat_id": "ch_001", "text": "hello"}, "文字 vs 文件",
              "chat_send_file→chat_send"),
     _q("etscli_chat_send_file", "post the file report.pdf into group chat ch_001",
        "把 report.pdf 这个文件发到群聊 ch_001 里",
        {"chat_id": "ch_001", "file": "report.pdf"}, "文字 vs 文件",
        "chat_send_file→chat_send")),
    ("16", _q("etscli_file_upload", "push my local report.pdf onto the device",
              "把我本地的 report.pdf 这个文件传到设备上", {"file": "report.pdf"},
              "单文件 vs 目录", "upload_dir→upload"),
     _q("etscli_file_upload_dir", "push my local /data/reports onto the device",
        "把我本地的 /data/reports 这个目录传到设备上", {"dir": "/data/reports"},
        "单文件 vs 目录", "upload_dir→upload")),
    ("17", _q("etscli_meeting_finish",
              "for meeting mtg001, close it down now",
              "会议 mtg001 这个,现在把它结束掉", {"meeting_id": "mtg001"},
              "结束 vs 取纪要", "cn finish→summary"),
     _q("etscli_meeting_summary", "for meeting mtg001, pull up the minutes",
        "会议 mtg001 这个,把它纪要调出来", {"meeting_id": "mtg001"},
        "结束 vs 取纪要", "cn finish→summary")),
]

PAIRS = ([(f"P0-A-{i}", a, b) for i, a, b in PAIRS_A] +
         [(f"P0-B-{i}", a, b) for i, a, b in PAIRS_B])

# ── P0-C 反弃答正例(5 条)─────────────────────────────────────────────────
# en 侧 5 个 200 空产出,query 是明确祈使句:空产出永远不是合法答案。
# query 与上方对照对重合的会自动合并(同一 query 只出一行,groups 里并列)。
ABSTAIN = [
    _q("etscli_auth_login", f"sign in to the device at {IP} using the account admin",
       f"用 admin 这个账号登录到 {IP} 这台设备",
       {"server": IP, "username": "admin", "password": PW},
       "祈使句 ⇒ 必有调用", "en 静默弃答 5 例之一"),
    _q("etscli_chat_send", "post the text hello into group chat ch_001",
       "把 hello 这条文字发到群聊 ch_001 里",
       {"chat_id": "ch_001", "text": "hello"}, "祈使句 ⇒ 必有调用",
       "en 静默弃答 5 例之一"),
    _q("etscli_meeting_finish", "for meeting mtg001, close it down now",
       "会议 mtg001 这个,现在把它结束掉", {"meeting_id": "mtg001"},
       "祈使句 ⇒ 必有调用", "en 静默弃答 5 例之一"),
    _q("etscli_file_delete", "wipe box file f_12345 for good",
       "把 f_12345 这个密盒文件彻底删掉", {"file_ids": ["f_12345"]},
       "祈使句 ⇒ 必有调用", "en 静默弃答 5 例之一"),
    _q("etscli_fs_add", "tuck my local report.pdf into /photos on the device",
       "把我本地的 report.pdf 塞到设备的 /photos 目录",
       {"local": "report.pdf", "remote": "/photos"}, "祈使句 ⇒ 必有调用",
       "en 静默弃答 5 例之一"),
]


def build_samples(with_tools: bool = False) -> list[dict]:
    """(lang, query) 去重后产出样本;被多个组覆盖时 groups 里并列各自的角色。"""
    out: dict[tuple[str, str], dict] = {}

    def put(lang: str, spec: dict, group: str, role: str, hard: str | None) -> None:
        key = (lang, spec[lang])
        s = out.get(key)
        if s is None:
            s = {
                "id": "",
                "groups": [],
                "lang": lang,
                "cue": spec["cue"],
                "hard_negatives": [],
                "messages": [{"role": "user", "content": spec[lang]}],
                "expected": {"tool": spec["tool"], "arguments": spec["args"]},
                "evidence": [],
            }
            out[key] = s
        # 同一 query 可能同时是多对的 a 侧与另一对的 b 侧(如 user_list 在 01 是 b、在 02 是 a)
        if not any(g["id"] == group for g in s["groups"]):
            s["groups"].append({"id": group, "role": role})
        if spec["evidence"] not in s["evidence"]:
            s["evidence"].append(spec["evidence"])
        if hard and hard not in s["hard_negatives"]:
            s["hard_negatives"].append(hard)

    for pid, a, b in PAIRS:
        for role, cur, other in (("a", a, b), ("b", b, a)):
            for lang in ("en", "cn"):
                put(lang, cur, pid, role, other["tool"])
    for spec in ABSTAIN:
        for lang in ("en", "cn"):
            put(lang, spec, "P0-C", "-", None)

    rows = sorted(out.values(),
                  key=lambda s: (s["groups"][0]["id"], s["lang"], s["id"]))
    for i, s in enumerate(rows, 1):
        s["id"] = f"p0-{i:03d}"
    if with_tools:
        by_lang = {"en": _t.build_tools("en"), "cn": _t.build_tools("cn")}
        for s in rows:
            s["tools"] = by_lang[s["lang"]]
    return rows


def check(rows: list[dict]) -> list[str]:
    """校验:工具存在 / arguments 键合法 / required 齐 / 对照对双向。"""
    errs: list[str] = []
    for s in rows:
        tool = s["expected"]["tool"]
        if tool not in SPEC:
            errs.append(f"{s['id']}: 未知工具 {tool}")
            continue
        props, required = SPEC[tool]
        args = s["expected"]["arguments"]
        for k in args:
            if k not in props:
                errs.append(f"{s['id']}/{tool}: 参数 {k} 不在 schema 里")
        for k in required:
            if k not in args:
                errs.append(f"{s['id']}/{tool}: 缺必填参数 {k}")
        if any(t not in SPEC for t in s["hard_negatives"]):
            errs.append(f"{s['id']}: hard_negative 不在工具集里")
    # 每个对照对的每个语言都必须 a、b 各一条
    for pid, _a, _b in PAIRS:
        for lang in ("en", "cn"):
            roles = {g["role"] for s in rows if s["lang"] == lang
                     for g in s["groups"] if g["id"] == pid}
            if roles != {"a", "b"}:
                errs.append(f"{pid}/{lang}: 方向不全 {sorted(roles)}")
    return errs


def emit_md() -> str:
    """打印 P0 三张表(md 文档的对应小节由此生成,勿手改)。"""
    L = ["### P0-A 同动词跨 service —— 14 对", "",
         "根因:模型缺「query 里的名词 → service」绑定,不是不懂动词。", "",
         "| # | A | B | 判别线索 | en 模板 | cn 模板 | 证据 |",
         "|---|---|---|---|---|---|---|"]
    for i, a, b in PAIRS_A:
        L.append(f"| {i} | `{a['tool'].removeprefix('etscli_')}` "
                 f"| `{b['tool'].removeprefix('etscli_')}` | {a['cue']} "
                 f"| {a['en']} / {b['en']} | {a['cn']} / {b['cn']} | {a['evidence']} |")
    L += ["", "### P0-B 同 service 近义动词 —— 3 对", "",
          "同一 service 内动词语义相邻,模型塌缩到高频那个。", "",
          "| # | A | B | 判别线索 | en 模板 | cn 模板 | 证据 |",
          "|---|---|---|---|---|---|---|"]
    for i, a, b in PAIRS_B:
        L.append(f"| {i} | `{a['tool'].removeprefix('etscli_')}` "
                 f"| `{b['tool'].removeprefix('etscli_')}` | {a['cue']} "
                 f"| {a['en']} / {b['en']} | {a['cn']} / {b['cn']} | {a['evidence']} |")
    L += ["", "### P0-C 「必须有调用」反弃答 —— 5 条", "",
          "en 侧 5 个 200 空产出,query 是明确祈使句:空产出永远不是合法答案。",
          "", "| 工具 | en query | cn query |", "|---|---|---|"]
    for s in ABSTAIN:
        L.append(f"| `{s['tool'].removeprefix('etscli_')}` | {s['en']} | {s['cn']} |")
    return "\n".join(L)


def corpus_overlap(rows: list[dict]) -> list[tuple[str, str, float]]:
    """P0 query 与 42 例验收语料的撞题检测。

    验收语料(`CASES`)是**新模型的判卷卷子**;训练样本若与卷子逐字相同或近重复,
    训完再考就是背答案,§7.94.8 的验收门槛会虚高。返回 [(样本 id, 撞上的 case, Jaccard)]。
    中文按 2-gram 切(整句当一个 token 会让任何两句相似度都是 0)。
    """
    import re

    def toks(s: str) -> set[str]:
        t = set(re.findall(r"[a-z_0-9]+", s.lower()))
        for run in re.findall(r"[一-鿿]+", s):
            t |= {run[i:i + 2] for i in range(len(run) - 1)} or {run}
        return t

    corpus = {(c.cid, lang): getattr(c, lang) for c in _t.CASES for lang in ("en", "cn")}
    hits = []
    for r in rows:
        q, lang = r["messages"][0]["content"], r["lang"]
        tq = toks(q)
        best, bj = "", 0.0
        for (cid, l), c in corpus.items():
            if l != lang:
                continue
            tc = toks(c)
            j = len(tq & tc) / max(1, len(tq | tc))
            if j > bj:
                best, bj = cid, j
        if bj >= 0.5:                      # 逐字相同 = 1.0,近重复阈值
            hits.append((r["id"], best, round(bj, 2)))
    return sorted(hits, key=lambda h: -h[2])


def main() -> int:
    ap = argparse.ArgumentParser(description="导出 P0 minimal pair 训练样本")
    ap.add_argument("--out", default="docs/bench/etscli-tools/train")
    ap.add_argument("--with-tools", action="store_true",
                    help="每行内联该语言的完整 47 工具集(自包含,体积 ×~40)")
    ap.add_argument("--check", action="store_true", help="只校验不落盘")
    ap.add_argument("--check-corpus", action="store_true",
                    help="撞题检测:训练样本 vs 42 例验收语料(逐字/近重复)")
    ap.add_argument("--emit-md", action="store_true", help="打印 P0 表格")
    args = ap.parse_args()

    if args.emit_md:
        print(emit_md())
        return 0

    rows = build_samples(args.with_tools)
    if args.check_corpus:
        hits = corpus_overlap(rows)
        exact = [h for h in hits if h[2] == 1.0]
        near = [h for h in hits if h[2] < 1.0]
        print(f"撞题检测:{len(rows)} 条样本 vs 42 例验收语料")
        print(f"  逐字相同 {len(exact)} 条({len(exact)/max(1,len(rows)):.0%})"
              f" · 近重复 J≥0.5 {len(near)} 条"
              f" · 独立 {len(rows)-len(hits)} 条({1-len(hits)/max(1,len(rows)):.0%})")
        for sid, cid, j in hits:
            print(f"  {'=' if j == 1.0 else '~'} {sid} vs {cid:<16} J={j}")
        return 1 if exact else 0
    errs = check(rows)
    # 撞题也进默认闸:验收语料是判卷卷子,P0 与它重叠会让验收门槛虚高(§7.94.12)
    for sid, cid, j in corpus_overlap(rows):
        errs.append(f"{sid}: 与验收语料 {cid} 撞题 J={j}"
                    + ("(逐字相同)" if j == 1.0 else "(近重复,阈值 0.5)"))
    if errs:
        for e in errs:
            print(f"✗ {e}", file=sys.stderr)
        return 2
    n_c = sum(1 for s in rows if any(g["id"] == "P0-C" for g in s["groups"]))
    print(f"✓ 校验通过:{len(rows)} 条样本(对照对 {len(rows) - n_c} 条 / "
          f"反弃答 {n_c} 条),P0-A {len(PAIRS_A)} 对 / "
          f"P0-B {len(PAIRS_B)} 对 / P0-C {len(ABSTAIN)} 条")
    if args.check:
        return 0

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    jl = out_dir / "p0.jsonl"
    with jl.open("w", encoding="utf-8") as f:
        for s in rows:
            f.write(json.dumps(s, ensure_ascii=False) + "\n")
    tj = out_dir / "tools.json"
    tools_side = {
        "note": "match 口径:en query 配 en 描述,cn query 配 cn 描述",
        "en": _t.build_tools("en"),
        "cn": _t.build_tools("cn"),
    }
    tj.write_text(json.dumps(tools_side, ensure_ascii=False, indent=2) + "\n",
                  encoding="utf-8")
    print(f"  {jl} ({jl.stat().st_size // 1024} KB)")
    print(f"  {tj} ({tj.stat().st_size // 1024} KB,47 工具 × en/cn)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
