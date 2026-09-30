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
PAIRS_A = [
    ("01", _q("etscli_auth_list", "list all saved login profiles",
              "列出所有已保存的 profile", {}, "profile vs 用户",
              "auth_list→user_list"),
     _q("etscli_user_list", "list all the users on the box",
        "列出密盒上的所有用户", {}, "profile vs 用户",
        "auth_list→user_list")),
    ("02", _q("etscli_user_list", "list all the users on the box",
              "列出密盒上的所有用户", {}, "用户 vs 群聊", "user_list 塌缩"),
     _q("etscli_chat_list", "list my group chats", "列出我的群聊列表", {},
        "用户 vs 群聊", "user_list 塌缩")),
    ("03", _q("etscli_chat_list", "list my group chats", "列出我的群聊列表", {},
              "群聊 vs 会议", "cn 幻觉集中区"),
     _q("etscli_meeting_list", "list all the meetings on the box",
        "列出密盒上所有的会议", {}, "群聊 vs 会议", "cn 幻觉集中区")),
    ("04", _q("etscli_meeting_list", "list all the meetings on the box",
              "列出密盒上所有的会议", {}, "会议 vs 分享链接", "sharing-list→乱选"),
     _q("etscli_sharing_list", "list all the sharing links I created",
        "列出我创建的所有分享链接", {}, "会议 vs 分享链接", "sharing-list→乱选")),
    ("05", _q("etscli_user_detail", "show the details of user user01",
              "查看 user01 的详细信息", {"uid": "user01"}, "用户 id vs 会议 id",
              "detail 塌缩"),
     _q("etscli_meeting_detail", "show the details of the meeting with id mtg001",
        "查看 id 为 mtg001 的会议详情", {"meeting_id": "mtg001"},
        "用户 id vs 会议 id", "detail 塌缩")),
    ("06", _q("etscli_user_detail", "show the details of user user01",
              "查看 user01 的详细信息", {"uid": "user01"}, "uid vs file id",
              "detail 塌缩"),
     _q("etscli_file_detail", "show the details of the box file with id f_12345",
        "查看 id 为 f_12345 的密盒文件详情", {"file_id": "f_12345"},
        "uid vs file id", "detail 塌缩")),
    ("07", _q("etscli_file_search", "search the box for files whose name contains report",
              "搜索密盒里名字包含报告的文件", {"keyword": "report"},
              "关键字全局 vs 目录下按名", "**file↔fs 双向**"),
     _q("etscli_fs_search", "search for a file named report under the folder /photos",
        "在密盒的 /photos 目录下搜索名为 report 的文件",
        {"path": "/photos", "name": "report"}, "关键字全局 vs 目录下按名",
        "**file↔fs 双向**")),
    ("08", _q("etscli_meeting_create", "create a new meeting called weekly sync",
              "创建一个名为 weekly sync 的新会议", {"name": "weekly sync"},
              "会议 vs 分享链接", "sharing_delete→sharing_create"),
     _q("etscli_sharing_create", "create a sharing link for the box file with id f_12345",
        "为 id 为 f_12345 的密盒文件创建分享链接", {"file_id": "f_12345"},
        "会议 vs 分享链接", "sharing_delete→sharing_create")),
    ("09", _q("etscli_user_register", "register a new user called bob on the box",
              "在密盒上注册一个名为 bob 的新用户",
              {"username": "bob", "password": PW}, "用户 vs 目录",
              "fs_mkdir 误选 5 次"),
     _q("etscli_fs_mkdir", "create a new folder named backup on the box",
        "在密盒上新建一个名为 backup 的文件夹", {"path": "/backup"},
        "用户 vs 目录", "fs_mkdir 误选 5 次")),
    ("10", _q("etscli_auth_rename", "rename the office profile to company",
              "把 office 这个 profile 重命名为 company",
              {"old": "office", "new": "company"}, "profile vs 路径",
              "auth_rename→fs_rename"),
     _q("etscli_fs_rename", "rename the box file /photos/a.jpg to /photos/b.jpg",
        "把密盒上的文件 /photos/a.jpg 重命名为 /photos/b.jpg",
        {"src": "/photos/a.jpg", "dst": "/photos/b.jpg"}, "profile vs 路径",
        "auth_rename→fs_rename")),
    ("11", _q("etscli_auth_login", f"log in to the box at {IP} as admin",
              f"登录到 {IP} 的密盒,用户名 admin",
              {"server": IP, "username": "admin", "password": PW},
              "账号凭证 vs 迁移流程", "**12 次误选,头号磁吸**"),
     _q("etscli_migrate_session_login", "establish a session for the migration",
        "为迁移流程建立会话", {}, "账号凭证 vs 迁移流程",
        "**12 次误选,头号磁吸**")),
    ("12", _q("etscli_migrate_transfer",
              "migrate the data from the old box to the new one",
              "把旧盒子的数据迁移到新盒子", {}, "执行迁移 vs 校验结果",
              "transfer↔verify 互换"),
     _q("etscli_migrate_verify", "verify the migration result", "验证迁移的结果", {},
        "执行迁移 vs 校验结果", "transfer↔verify 互换")),
    ("13", _q("etscli_file_delete", "delete the box file with id f_12345",
              "删除 id 为 f_12345 的密盒文件", {"file_ids": ["f_12345"]},
              "密盒文件 vs 分享链接", "cn 误选落点"),
     _q("etscli_sharing_delete", "delete the sharing link with id sh_67890",
        "删除 id 为 sh_67890 的分享链接", {"share_id": "sh_67890"},
        "密盒文件 vs 分享链接", "cn 误选落点")),
    ("14", _q("etscli_system_info", "show the system information of the box",
              "显示密盒的系统信息", {}, "配置信息 vs 健康状态", "health→幻觉 2 次"),
     _q("etscli_system_health", "check the health of the box", "检查密盒的健康状态",
        {}, "配置信息 vs 健康状态", "health→幻觉 2 次")),
]

# ── P0-B 同 service 近义动词(3 对)─────────────────────────────────────────
PAIRS_B = [
    ("15", _q("etscli_chat_send",
              "send a text message to the group chat ch_001 saying hello",
              "往群聊 ch_001 里发一条文字消息 hello",
              {"chat_id": "ch_001", "text": "hello"}, "文字(text)vs 文件(file)",
              "chat_send_file→chat_send"),
     _q("etscli_chat_send_file",
        "send the file report.pdf to the group chat ch_001",
        "把文件 report.pdf 发送到群聊 ch_001",
        {"chat_id": "ch_001", "file": "report.pdf"}, "文字(text)vs 文件(file)",
        "chat_send_file→chat_send")),
    ("16", _q("etscli_file_upload", "upload the local file report.pdf to the box",
              "把本地文件 report.pdf 上传到密盒", {"file": "report.pdf"},
              "单文件(file)vs 目录(dir)", "upload_dir→upload"),
     _q("etscli_file_upload_dir", "upload the local directory /data/reports to the box",
        "把本地目录 /data/reports 上传到密盒", {"dir": "/data/reports"},
        "单文件(file)vs 目录(dir)", "upload_dir→upload")),
    ("17", _q("etscli_meeting_finish",
              "end the meeting with id mtg001 that is currently running",
              "结束 id 为 mtg001 的、当前正在进行的会议", {"meeting_id": "mtg001"},
              "结束 vs 取纪要", "cn finish→summary"),
     _q("etscli_meeting_summary", "get the summary of the meeting with id mtg001",
        "获取 id 为 mtg001 的会议纪要", {"meeting_id": "mtg001"},
        "结束 vs 取纪要", "cn finish→summary")),
]

PAIRS = ([(f"P0-A-{i}", a, b) for i, a, b in PAIRS_A] +
         [(f"P0-B-{i}", a, b) for i, a, b in PAIRS_B])

# ── P0-C 反弃答正例(5 条)─────────────────────────────────────────────────
# en 侧 5 个 200 空产出,query 是明确祈使句:空产出永远不是合法答案。
# query 与上方对照对重合的会自动合并(同一 query 只出一行,groups 里并列)。
ABSTAIN = [
    _q("etscli_auth_login", f"log in to the box at {IP} as admin",
       f"登录到 {IP} 的密盒,用户名 admin",
       {"server": IP, "username": "admin", "password": PW},
       "祈使句 ⇒ 必有调用", "en 静默弃答 5 例之一"),
    _q("etscli_chat_send", "send a text message to the group chat ch_001 saying hello",
       "往群聊 ch_001 里发一条文字消息 hello",
       {"chat_id": "ch_001", "text": "hello"}, "祈使句 ⇒ 必有调用",
       "en 静默弃答 5 例之一"),
    _q("etscli_meeting_finish",
       "end the meeting with id mtg001 that is currently running",
       "结束 id 为 mtg001 的、当前正在进行的会议", {"meeting_id": "mtg001"},
       "祈使句 ⇒ 必有调用", "en 静默弃答 5 例之一"),
    _q("etscli_file_delete", "delete the box file with id f_12345",
       "删除 id 为 f_12345 的密盒文件", {"file_ids": ["f_12345"]},
       "祈使句 ⇒ 必有调用", "en 静默弃答 5 例之一"),
    _q("etscli_fs_add", "add the local file report.pdf into the folder /photos on the box",
       "把本地文件 report.pdf 添加到密盒的 /photos 目录",
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


def main() -> int:
    ap = argparse.ArgumentParser(description="导出 P0 minimal pair 训练样本")
    ap.add_argument("--out", default="docs/bench/etscli-tools/train")
    ap.add_argument("--with-tools", action="store_true",
                    help="每行内联该语言的完整 47 工具集(自包含,体积 ×~40)")
    ap.add_argument("--check", action="store_true", help="只校验不落盘")
    ap.add_argument("--emit-md", action="store_true", help="打印 P0 表格")
    args = ap.parse_args()

    if args.emit_md:
        print(emit_md())
        return 0

    rows = build_samples(args.with_tools)
    errs = check(rows)
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
