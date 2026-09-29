#!/usr/bin/env python3
"""
etscli-tools-test.py — etscli-as-tool 形态的 function-call caller 测试套件

与 `etscli-function-call-test.py`(bash 包装形态)配套,测的是**另一种工具形态**:

  | 套件                              | 工具形态                                    | 推理链 |
  |-----------------------------------|-------------------------------------------|--------|
  | etscli-function-call-test.py       | `bash`(描述里点名 etscli)+ `read` 干扰项  | 2 段:query → bash → 命令 |
  | **本脚本**                         | **45 个 etscli 工具直出**                 | 1 段:query → 工具 |

**为什么需要这一套**:

1. **更接近 dsh 真实形态** —— dsh 的 tool 注册表是具体工具(`glob`/`read`/`web_search`),
   不是"让你自己拼 shell 命令"。模型在 `etscli_auth_status` 这种细粒度工具上训练,
   验收时也该在同样形态上测,否则**测得跟训得不对齐**。
2. **错误更可诊断** —— 实测 needle 在 bash 形态下产出
   `read(file_path: "hello")` 这种浅层词汇幻觉;在 etscli 直出形态下产出
   `etscli_auth_logout`(选对了 service,错选了命令)。后者信息量大得多 ——
   能区分"不会选工具"和"选错子命令"。
3. **训练分布一致** —— user 终线要基于 etscli 训练端侧模型,工具直出是自然形态。

**语料** 从姊妹脚本 import(`etscli-function-call-test.py` 的 `CASES`,42 例),
保证两套套件的测试意图完全一致,便于横向比较两个形态下的表现差异。

**三层评分** 同姊妹套件:HTTP 成功 / 有效产出 / **工具选择正确率**。
判定从"命令前缀命中"改为"**工具名精确匹配**"—— 因为工具直出形态下
`etscli_auth_status` 与 `etscli_auth_logout` 是两个不同的工具,没有模糊空间。

**工具描述语言**:`--desc-lang cn|en|both`(默认 `cn`)。中文产品用中文描述是
现实选择;但若只用中文描述,英文 query 就额外承担了"跨语言读描述"的压力。
`both` 让中英测试公平对照(代价:payload 约翻倍)。

**用法**:
  python3 scripts/etscli-tools-test.py
  python3 scripts/etscli-tools-test.py --url http://127.0.0.1:9000 --desc-lang both
  python3 scripts/etscli-tools-test.py --langs cn --rounds 3
  python3 scripts/etscli-tools-test.py --render-only dist/etscli-tools-<ts>

**退出码**:0 全对 / 1 有 case 未全过 / 2 有契约违规 / 3 服务不可达。
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any

# ── 复用姊妹套件的语料与契约校验 ────────────────────────────────────────────
_HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location(
    "_etscli_fc", _HERE / "etscli-function-call-test.py")
_mod = importlib.util.module_from_spec(_spec)
# 必须先注册再 exec —— @dataclass 在解析字段类型时会回查 sys.modules[cls.__module__]
sys.modules["_etscli_fc"] = _mod
_spec.loader.exec_module(_mod)

CASES = _mod.CASES                      # 42 例(39 正例 + 3 负例)
Case = _mod.Case
check_conformance = _mod.check_conformance
classify_error = _mod.classify_error
Attempt = _mod.Attempt
LANG_LABEL = _mod.LANG_LABEL
LOCALES = _mod.LOCALES
DOMAIN_ORDER = _mod.DOMAIN_ORDER

# ── etscli 工具注册表 ───────────────────────────────────────────────────────
# 全部子命令核对自 `etscli <service> --help`(48 个可用,此处取 45 个)。
# 每项: (子命令, 中文描述, 英文描述, 参数 schema)
# 参数名尽量贴近 CLI 实际 flag(--keyword → keyword, --file-id → file_id)。

_TOOL_SPEC: list[tuple[str, str, str, dict[str, Any]]] = [
    # ── auth ──
    ("etscli_auth_status", "查看当前 profile 认证状态(含自动重新登录开关)",
     "show the authentication status of the current profile", {}),
    ("etscli_auth_list", "列出所有已保存的 profile",
     "list all saved login profiles", {}),
    ("etscli_auth_switch", "切换当前使用的 profile",
     "switch to another profile",
     {"name": {"type": "string", "description": "目标 profile 名"}}, ["name"]),
    ("etscli_auth_login", "账号登录并存储凭证",
     "log in with username and password",
     {"server": {"type": "string"}, "username": {"type": "string"},
      "password": {"type": "string"}, "profile": {"type": "string"},
      "password_stdin": {"type": "boolean"},
      "no_remember_password": {"type": "boolean"}},
     ["server", "username", "password"]),
    ("etscli_auth_logout", "登出并清除凭证",
     "log out and clear stored credentials",
     {"profile": {"type": "string"}}, []),
    ("etscli_auth_rename", "重命名一个已存在的 profile",
     "rename an existing profile",
     {"old": {"type": "string"}, "new": {"type": "string"}}, ["old", "new"]),
    # ── user ──
    ("etscli_user_list", "列出设备上的所有用户",
     "list all users on the box", {}),
    ("etscli_user_detail", "查看指定用户的详细信息",
     "show details of a specific user",
     {"uid": {"type": "string"}}, ["uid"]),
    ("etscli_user_register", "注册一个新用户",
     "register a new user",
     {"username": {"type": "string"}, "password": {"type": "string"}},
     ["username", "password"]),
    ("etscli_user_passwd", "修改指定用户的密码",
     "change the password of a user",
     {"uid": {"type": "string"}, "new_password": {"type": "string"}},
     ["uid", "new_password"]),
    ("etscli_user_delete", "删除指定用户",
     "delete a user",
     {"uid": {"type": "string"}}, ["uid"]),
    # ── chat ──
    ("etscli_chat_list", "列出群聊", "list group chats", {}),
    ("etscli_chat_messages", "查看群聊中的消息",
     "show messages in a group chat",
     {"chat_id": {"type": "string"}, "limit": {"type": "integer"}}, ["chat_id"]),
    ("etscli_chat_files", "查看群聊中的文件",
     "list files shared in a group chat",
     {"chat_id": {"type": "string"}}, ["chat_id"]),
    ("etscli_chat_send", "向群聊发送一条文字消息",
     "send a text message to a group chat",
     {"chat_id": {"type": "string"}, "text": {"type": "string"}},
     ["chat_id", "text"]),
    ("etscli_chat_send_file", "向群聊发送一个文件",
     "send a file to a group chat",
     {"chat_id": {"type": "string"}, "file": {"type": "string"}},
     ["chat_id", "file"]),
    # ── meeting ──
    ("etscli_meeting_list", "列出所有会议", "list all meetings", {}),
    ("etscli_meeting_detail", "查看指定会议的详细信息",
     "show details of a specific meeting",
     {"meeting_id": {"type": "string"}}, ["meeting_id"]),
    ("etscli_meeting_create", "创建一个新会议",
     "create a new meeting",
     {"name": {"type": "string"}}, ["name"]),
    ("etscli_meeting_finish", "结束一个进行中的会议",
     "finish an ongoing meeting",
     {"meeting_id": {"type": "string"}}, ["meeting_id"]),
    ("etscli_meeting_summary", "获取会议纪要",
     "get the summary of a meeting",
     {"meeting_id": {"type": "string"}}, ["meeting_id"]),
    # ── file(按 file id 操作)──
    ("etscli_file_search", "按关键字搜索密盒中的文件",
     "search box files by keyword",
     {"keyword": {"type": "string"}}, ["keyword"]),
    ("etscli_file_detail", "按 file id 查看文件详情",
     "show details of a box file by its file id",
     {"file_id": {"type": "string"}}, ["file_id"]),
    ("etscli_file_upload", "上传一个本地文件到密盒",
     "upload a single local file to the box",
     {"file": {"type": "string"}}, ["file"]),
    ("etscli_file_upload_dir", "上传一个本地目录到密盒",
     "upload a local directory to the box",
     {"dir": {"type": "string"}}, ["dir"]),
    ("etscli_file_download", "按 file id 下载文件到本地",
     "download a box file by its file id",
     {"file_id": {"type": "string"}, "output": {"type": "string"}},
     ["file_id", "output"]),
    ("etscli_file_delete", "按 file id 删除文件",
     "delete box files by their file ids",
     {"file_ids": {"type": "array", "items": {"type": "string"}}}, ["file_ids"]),
    # ── fs(按路径操作)──
    ("etscli_fs_ls", "列出指定目录下的文件",
     "list files in a directory",
     {"path": {"type": "string"}}, []),
    ("etscli_fs_mkdir", "创建一个目录",
     "create a directory",
     {"path": {"type": "string"}}, ["path"]),
    ("etscli_fs_stat", "查看文件的状态信息(stat)",
     "show stat info of a file",
     {"path": {"type": "string"}}, ["path"]),
    ("etscli_fs_stats", "查看目录的统计信息",
     "show statistics of a directory",
     {"path": {"type": "string"}}, ["path"]),
    ("etscli_fs_rm", "按路径删除文件或目录",
     "delete a file or directory by path",
     {"path": {"type": "string"}}, ["path"]),
    ("etscli_fs_mv", "按路径移动文件或目录",
     "move a file or directory by path",
     {"src": {"type": "string"}, "dst": {"type": "string"}}, ["src", "dst"]),
    ("etscli_fs_rename", "按路径重命名文件或目录",
     "rename a file or directory by path",
     {"src": {"type": "string"}, "dst": {"type": "string"}}, ["src", "dst"]),
    ("etscli_fs_search", "按名称在目录下搜索文件",
     "search files by name under a directory",
     {"path": {"type": "string"}, "name": {"type": "string"}}, []),
    ("etscli_fs_add", "把本地文件添加到密盒的指定目录",
     "add a local file into a box directory",
     {"local": {"type": "string"}, "remote": {"type": "string"}},
     ["local", "remote"]),
    # ── sharing ──
    ("etscli_sharing_list", "列出所有分享链接",
     "list all sharing links", {}),
    ("etscli_sharing_create", "为文件创建分享链接",
     "create a sharing link for a file",
     {"file_id": {"type": "string"}, "duration": {"type": "string"}},
     ["file_id"]),
    ("etscli_sharing_delete", "删除一个分享链接",
     "delete a sharing link",
     {"share_id": {"type": "string"}}, ["share_id"]),
    # ── system ──
    ("etscli_system_info", "查看设备的系统信息",
     "show system information of the box", {}),
    ("etscli_system_health", "查看设备的健康状态",
     "check the health of the box", {}),
    ("etscli_system_alarm_list", "列出设备上的告警",
     "list alarms on the box",
     {"limit": {"type": "integer"}}, []),
    # ── discover ──
    ("etscli_discover_scan", "扫描局域网中的密盒设备",
     "scan the local network for boxes",
     {"timeout": {"type": "integer"}}, []),
    # ── migrate ──
    ("etscli_migrate_session_login", "为迁移流程建立会话",
     "establish a session for migration", {}),
    ("etscli_migrate_transfer", "把旧设备的数据迁移到当前设备",
     "migrate data from an old box to the current box",
     {"all": {"type": "boolean"}, "dry_run": {"type": "boolean"}}, []),
    ("etscli_migrate_verify", "验证迁移结果",
     "verify the migration result", {}),
    ("etscli_migrate_record", "查看迁移记录",
     "show migration records", {}),
]

TOOL_NAMES = [t[0] for t in _TOOL_SPEC]


def build_tools(desc_lang: str = "cn") -> list[dict[str, Any]]:
    """按指定语言生成工具 schema(desc_lang: cn | en | both)。"""
    out = []
    for name, cn, en, props, *rest in _TOOL_SPEC:
        required = rest[0] if rest else []
        desc = {"cn": cn, "en": en, "both": f"{cn} / {en}"}[desc_lang]
        out.append({
            "name": name,
            "description": desc,
            "parameters": {
                "type": "object",
                "properties": props,
                **({"required": required} if required else {}),
            },
        })
    return out


# ── 期望工具映射 ────────────────────────────────────────────────────────────
# case.expect 形如 "etscli auth status" → 期望工具 "etscli_auth_status"
# 姊妹套件的 fs-stat / system-alarm 用 alt 表达"两可",这里映射成具体工具名。

def cmd_to_tool(cmd: str) -> str:
    """`etscli auth status` → `etscli_auth_status`(空格与连字符都归一为下划线)。"""
    return "_".join(cmd.strip().replace("-", " ").split())


#: 命令组 / 旧别名 → 工具直出形态下的真实工具名。
#: 姊妹套件里这些用 `alt` 表达"两可";在工具直出形态下它们不是两个工具,
#: 而是同一个工具(所以直接归一,不算歧义)。
_CMD_ALIAS = {
    "etscli system alarm": "etscli_system_alarm_list",
    "etscli fs stat": "etscli_fs_stats",
    "etscli file upload": "etscli_file_upload_dir",
}


def resolve_tool(cmd: str) -> str:
    return _CMD_ALIAS.get(cmd.strip(), cmd_to_tool(cmd))


def expected_tools(case: Case) -> list[str]:
    """返回该 case 可接受的工具名列表(空 = 负例,不应调用)。

    归一化后若不在工具注册表里则抛错 —— 语料与工具表不同步会**静默**把
    正确产出判成错误,必须让它在启动时就炸。
    """
    if case.expect is None:
        return []
    out = [resolve_tool(case.expect)]
    if case.alt:
        alt = resolve_tool(case.alt)
        if alt not in out:
            out.append(alt)
    known = set(TOOL_NAMES)
    for t in out:
        if t not in known:
            raise KeyError(
                f"case `{case.cid}` 的期望工具 `{t}` 不在工具注册表中。"
                f"语料与 _TOOL_SPEC 不同步 —— 请补工具或修 expect。"
            )
    return out


# ── 正确性判定:工具名精确匹配 ──────────────────────────────────────────────

def is_correct(calls: list[dict], allowed: list[str]) -> bool:
    """工具直出形态下判定"选对了工具"。

    - 负例(allowed 为空):不产生调用才算正确
    - 正例:任一调用的 name 命中 allowed 之一
    """
    names = [c.get("name") for c in calls if isinstance(c, dict)]
    if not allowed:
        return len(names) == 0
    return any(n in allowed for n in names)


# ── 单次调用 ────────────────────────────────────────────────────────────────

def one_attempt(url: str, query: str, locale: str, tools: list[dict],
                timeout: float) -> Attempt:
    body = json.dumps(
        {"query": query, "tools": tools,
         "system": f"date: 2026-09-28 Mon; locale: {locale}"},
        ensure_ascii=False,
    ).encode("utf-8")
    req = urllib.request.Request(f"{url}/extract", data=body,
                                 headers={"content-type": "application/json"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            try:
                d = json.loads(raw)
            except Exception as e:
                return Attempt(resp.status, False, [], None, round(time.time() - t0, 2),
                               f"响应体非 JSON:{str(e)[:120]}", "bad_json")
            calls = d.get("function_calls") if isinstance(d, dict) else None
            return Attempt(resp.status, True, calls if isinstance(calls, list) else [],
                           d.get("confidence") if isinstance(d, dict) else None,
                           round(time.time() - t0, 2), None,
                           contract_violations=check_conformance(d))
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            err = str(json.loads(raw).get("error", raw.decode("utf-8", "replace")))
        except Exception:
            err = raw.decode("utf-8", "replace")
        return Attempt(e.code, False, [], None, round(time.time() - t0, 2),
                       err[:200], classify_error(err))
    except Exception as ex:
        return Attempt(0, False, [], None, round(time.time() - t0, 2),
                       str(ex)[:200], "transport")


# ── test case ───────────────────────────────────────────────────────────────

@dataclass
class CaseResult:
    case_id: str
    lang: str
    domain: str
    expect_tools: list[str]
    trials: int
    passed: int
    failed: int
    correct: int
    failure_classes: dict[str, int] = field(default_factory=dict)
    latencies: list[float] = field(default_factory=list)
    calls_when_ok: list[int] = field(default_factory=list)
    confidences: list[float] = field(default_factory=list)
    contract_violations: dict[str, int] = field(default_factory=dict)
    sample_error: str | None = None
    sample_violation: str | None = None
    sample_call: str | None = None


def run_case(url: str, case: Case, lang: str, tools: list[dict],
             trials: int, timeout: float) -> CaseResult:
    allowed = expected_tools(case)
    res = CaseResult(case_id=case.cid, lang=lang, domain=case.domain,
                     expect_tools=allowed, trials=trials, passed=0, failed=0, correct=0)
    for _ in range(trials):
        a = one_attempt(url, getattr(case, lang), LOCALES[lang], tools, timeout)
        res.latencies.append(a.latency_s)
        for v in a.contract_violations:
            res.contract_violations[v] = res.contract_violations.get(v, 0) + 1
            if res.sample_violation is None:
                res.sample_violation = v
        if a.ok:
            res.passed += 1
            res.calls_when_ok.append(len(a.calls))
            if a.confidence is not None:
                res.confidences.append(a.confidence)
            if is_correct(a.calls, allowed):
                res.correct += 1
            elif res.sample_call is None:
                got = [c.get("name") for c in a.calls if isinstance(c, dict)]
                res.sample_call = (json.dumps(got, ensure_ascii=False) if got
                                   else "[] (未产出调用)")
        else:
            res.failed += 1
            cls = a.failure_class or "unknown"
            res.failure_classes[cls] = res.failure_classes.get(cls, 0) + 1
            if res.sample_error is None:
                res.sample_error = a.error
    return res


# ── 报告渲染 ────────────────────────────────────────────────────────────────

def render_report(results: list[CaseResult], url: str, trials: int, ts: str,
                  health: dict | None, desc_lang: str, n_tools: int) -> str:
    L: list[str] = []
    A = L.append
    en = [r for r in results if r.lang == "en"]
    cn = [r for r in results if r.lang == "cn"]

    def agg(g, a):
        return sum(getattr(r, a) for r in g)

    def tr(g):
        return sum(r.trials for r in g)

    def rate(g, a):
        return agg(g, a) / max(1, tr(g))

    pos_en = [r for r in en if r.expect_tools]
    pos_cn = [r for r in cn if r.expect_tools]
    neg_en = [r for r in en if not r.expect_tools]
    neg_cn = [r for r in cn if not r.expect_tools]
    viol = sum(sum(r.contract_violations.values()) for r in results)
    svc = (health or {}).get("version") or "未知"

    A("# etscli 直出工具形态 · function-call caller 测试报告")
    A("")
    A(f"- **生成时间**: {ts}")
    A(f"- **被测服务**: `{url}` —— {svc}")
    A(f"- **工具形态**: **{n_tools} 个 etscli 工具直出**(非 bash 包装),描述语言 `{desc_lang}`")
    A(f"- **每 case 试验次数**: {trials}")
    A("- **语料**: 与 `etscli-function-call-test.py` 共用 42 例(39 正例 + 3 负例)")
    A("")

    A("## 1. 判定")
    A("")
    A("| 指标 | English | Chinese |")
    A("|---|---|---|")
    A(f"| HTTP 200 | {rate(en,'passed'):.0%} | {rate(cn,'passed'):.0%} |")
    A(f"| 有效产出 | {rate(pos_en,'passed') and sum(sum(1 for c in r.calls_when_ok if c>0) for r in pos_en)/max(1,tr(pos_en)):.0%} "
      f"| {sum(sum(1 for c in r.calls_when_ok if c>0) for r in pos_cn)/max(1,tr(pos_cn)):.0%} |")
    A(f"| **工具选择正确率** | **{rate(pos_en,'correct'):.0%}** | **{rate(pos_cn,'correct'):.0%}** |")
    A(f"| 负例正确(未调用) | {rate(neg_en,'correct'):.0%} | {rate(neg_cn,'correct'):.0%} |")
    A(f"| 契约违规 | {sum(len(r.contract_violations) for r in en)} | {sum(len(r.contract_violations) for r in cn)} |")
    A("")
    A("> **工具直出形态下,`etscli_auth_status` 与 `etscli_auth_logout` 是两个不同工具**,")
    A("> 判定为精确匹配,没有模糊空间。")
    A(">")
    A("> 与 bash 包装形态的关键差异:错误更**可诊断**。bash 形态下模型可能产出")
    A("> `read(file_path: \"hello\")` 这种浅层幻觉(完全无关);直出形态下它至少")
    A("> 会产出某个 etscli 工具(选对 service、错选子命令),信息量高得多。")
    A("")

    A("### 1.1 过度触发(负例)")
    A("")
    A("| 语言 | 负例试验 | 正确(未调用) | 过度触发率 |")
    A("|---|---|---|---|")
    for label, g in (("English", neg_en), ("Chinese", neg_cn)):
        if g:
            A(f"| {label} | {tr(g)} | {agg(g,'correct')} | {1-agg(g,'correct')/max(1,tr(g)):.0%} |")
    A("")

    A("### 1.2 按 service 的正确率")
    A("")
    A("| service | English | Chinese |")
    A("|---|---|---|")
    for dom in DOMAIN_ORDER:
        e = [r for r in pos_en if r.domain == dom]
        c = [r for r in pos_cn if r.domain == dom]
        if not e and not c:
            continue

        def fmt(g):
            if not g:
                return "—"
            return f"{rate(g,'correct'):.0%} ({agg(g,'correct')}/{tr(g)})"

        A(f"| {dom} | {fmt(e)} | {fmt(c)} |")
    A("")

    A("## 2. 逐 case 明细")
    A("")
    A("| case | 语言 | 期望工具 | HTTP | 产出 | 正确 | 实际产出 |")
    A("|---|---|---|---|---|---|---|")
    for r in results:
        exp = " / ".join(f"`{t}`" for t in r.expect_tools) if r.expect_tools else "_不应调用_"
        got = r.sample_call or "—"
        if len(got) > 46:
            got = got[:46] + "…"
        A(f"| `{r.case_id}` | {LANG_LABEL[r.lang]} | {exp} "
          f"| {r.passed}/{r.trials} | {sum(1 for c in r.calls_when_ok if c>0)}/{r.passed or 0} "
          f"| {r.correct}/{r.trials} | {got} |")
    A("")

    A("## 3. 失败样本")
    A("")
    seen, printed = set(), False
    for r in results:
        for cls in r.failure_classes:
            if cls in seen or not r.sample_error:
                continue
            seen.add(cls)
            printed = True
            A(f"**`{cls}`**(`{r.case_id}`,{r.failure_classes[cls]}/{r.trials} 次):")
            A("")
            A("```")
            A(r.sample_error)
            A("```")
            A("")
    if not printed:
        A("无 HTTP 层失败。")
        A("")

    A("## 4. 工具集")
    A("")
    A(f"共 **{n_tools}** 个 etscli 工具,全部核对自 `etscli <service> --help`:")
    A("")
    A("| 工具 | 描述 | 参数 |")
    A("|---|---|---|")
    for name, cn, en, props, *rest in _TOOL_SPEC:
        req = rest[0] if rest else []
        A(f"| `{name}` | {cn} | {', '.join(req) if req else '—'} |")
    A("")

    A("## 5. 结论")
    A("")
    en_c, cn_c = rate(pos_en, "correct"), rate(pos_cn, "correct")
    A(f"- English 工具选择正确率 **{en_c:.0%}**,Chinese **{cn_c:.0%}**。")
    if cn_c >= 0.5 and en_c >= 0.7 and viol == 0:
        A("- ✅ 达到启用门槛(`EN ≥ 70%` / `CN ≥ 50%` / 契约零违规),可接入:")
        A("")
        A("```bash")
        A("FUNCTION_CALL_EXTERNAL_ENABLED=true")
        A(f"FUNCTION_CALL_EXTERNAL_URL={url}")
        A("```")
    else:
        A("- ❌ 未达门槛(`EN ≥ 70%` / `CN ≥ 50%` / 契约零违规),建议保持关闭。")
    A("")
    A("> 换用端侧模型后用同一命令复测,`--url` 指向新服务即可:")
    A("> `python3 scripts/etscli-tools-test.py --url <新模型> --rounds 3`")
    A("")
    return "\n".join(L)


def write_report(path: str, results: list[CaseResult], url: str, trials: int,
                 ts: str, health: dict | None, desc_lang: str, n_tools: int) -> int:
    rendered = render_report(results, url, trials, ts, health, desc_lang, n_tools)
    if len(rendered) < 500 or "## 1. 判定" not in rendered:
        raise RuntimeError(f"报告渲染异常(仅 {len(rendered)} 字节),拒绝落盘")
    with open(path, "w", encoding="utf-8") as f:
        f.write(rendered)
    return len(rendered)


# ── main ────────────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(
        description="etscli 直出工具形态的 function-call caller 测试")
    ap.add_argument("--url", default=os.environ.get("FUNCTION_CALL_EXTERNAL_URL",
                                                    "http://127.0.0.1:8081"))
    ap.add_argument("--trials", type=int, default=3)
    ap.add_argument("--rounds", type=int, default=1)
    ap.add_argument("--timeout", type=float, default=45.0)
    ap.add_argument("--out", default="")
    ap.add_argument("--langs", default="en,cn")
    ap.add_argument("--desc-lang", default="cn", choices=["cn", "en", "both"],
                    help="工具描述语言(默认 cn;both 让中英测试公平对照,代价 payload 翻倍)")
    ap.add_argument("--render-only", default="")
    args = ap.parse_args()

    if args.render_only:
        src = os.path.join(args.render_only, "results.json")
        with open(src, encoding="utf-8") as f:
            blob = json.load(f)
        rows = blob.get("results") or []
        if not rows:
            print("✗ results.json 中找不到结果行", file=sys.stderr)
            return 3
        results = [CaseResult(**c) for c in rows]
        n = write_report(os.path.join(args.out or args.render_only, "report.md"),
                         results, blob["service"],
                         blob.get("effectiveTrialsPerCase") or blob["trialsPerCase"],
                         blob["generatedAt"], blob.get("health"),
                         blob.get("descLang", "cn"), blob.get("toolCount", 0))
        print(f"  报告已重渲({n} 字节)")
        return 0

    ts = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    out_dir = args.out or f"dist/etscli-tools-{ts}"
    os.makedirs(out_dir, exist_ok=True)
    langs = [x.strip() for x in args.langs.split(",") if x.strip()]
    base_url = args.url.rstrip("/")
    tools = build_tools(args.desc_lang)

    try:
        with urllib.request.urlopen(f"{base_url}/health", timeout=5) as r:
            health = json.loads(r.read())
    except Exception as e:
        print(f"✗ [FATAL] {base_url}/health 不可达: {e}", file=sys.stderr)
        return 3

    eff = args.trials * args.rounds
    print("═══ etscli tools-form conformance test ═══")
    print(f"  service: {base_url}  ({health.get('version') or ''})".rstrip())
    print(f"  tools:   {len(tools)} etscli 工具直出, desc-lang={args.desc_lang}")
    print(f"  cases:   {len(CASES)} × {len(langs)} langs")
    print(f"  trials:  {args.trials} × {args.rounds} rounds = {eff}/case")
    print("")

    acc: dict[tuple[str, str], CaseResult] = {}
    total = len(CASES) * len(langs) * eff
    done = 0
    for rnd in range(args.rounds):
        for lang in langs:
            for case in CASES:
                r = run_case(base_url, case, lang, tools, args.trials, args.timeout)
                key = (case.cid, lang)
                if key not in acc:
                    acc[key] = r
                else:
                    a = acc[key]
                    a.passed += r.passed; a.failed += r.failed
                    a.correct += r.correct; a.trials += r.trials
                    a.latencies += r.latencies
                    a.calls_when_ok += r.calls_when_ok
                    a.confidences += r.confidences
                    for k, v in r.failure_classes.items():
                        a.failure_classes[k] = a.failure_classes.get(k, 0) + v
                    for k, v in r.contract_violations.items():
                        a.contract_violations[k] = a.contract_violations.get(k, 0) + v
                    a.sample_error = a.sample_error or r.sample_error
                    a.sample_violation = a.sample_violation or r.sample_violation
                    a.sample_call = a.sample_call or r.sample_call
                cur = acc[key]
                done += args.trials
                mark = "✓" if cur.correct == cur.trials else ("~" if cur.passed else "✗")
                print(f"  {mark} {cur.case_id:<18} {lang} http={cur.passed}/{cur.trials} "
                      f"correct={cur.correct}/{cur.trials}"
                      f"{'  ' + ','.join(cur.failure_classes) if cur.failure_classes else ''}"
                      f"   [r{rnd+1}/{args.rounds} {done}/{total}]")
                sys.stdout.flush()
    results = list(acc.values())

    print("")
    for lang in langs:
        g = [r for r in results if r.lang == lang]
        pos = [r for r in g if r.expect_tools]
        if not g:
            continue
        t = sum(r.trials for r in g)
        pt = sum(r.trials for r in pos)
        print(f"  {lang}: HTTP {sum(r.passed for r in g)/t:.0%}  "
              f"工具正确率 {sum(r.correct for r in pos)/max(1,pt):.0%}  "
              f"(n={pt})")
    viol = sum(sum(r.contract_violations.values()) for r in results)
    print(f"  契约违规: {viol}")

    with open(os.path.join(out_dir, "results.json"), "w", encoding="utf-8") as f:
        json.dump({
            "generatedAt": ts, "service": base_url, "health": health,
            "form": "etscli-tools-direct",
            "descLang": args.desc_lang, "toolCount": len(tools),
            "trialsPerCase": args.trials, "rounds": args.rounds,
            "effectiveTrialsPerCase": eff,
            "methodology": "45 个 etscli 工具直出;工具名精确匹配判定;"
                           "语料与 etscli-function-call-test.py 共用",
            "tools": tools,
            "results": [asdict(r) for r in results],
        }, f, ensure_ascii=False, indent=2)

    n = write_report(os.path.join(out_dir, "report.md"), results, base_url,
                     eff, ts, health, args.desc_lang, len(tools))
    print("")
    print(f"  报告: {out_dir}/report.md ({n} 字节)")
    if viol:
        return 2
    return 0 if all(r.correct == r.trials for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
