#!/usr/bin/env python3
"""
etscli-function-call-test.py — etscli 场景的 function-call caller 测试套件

dsh-edge-agent 的 `function-call-external` 插件通过 **HTTP 契约**调用外部
tool-call 提取服务(见 `docs/function-call-external-http-contract.md`)。任何
实现该契约的服务都可作为 caller 接入,只需改 `FUNCTION_CALL_EXTERNAL_URL`。

本套件以 **etscli**(ETS 平台命令行)的真实使用场景作为测试语料,一次跑完产出
**三层评分**:

  1. **HTTP 成功**   —— 服务没报错
  2. **有效产出**     —— 产出了至少一个 function_call(prefill 有用的前提)
  3. **调用正确**     —— 产出的调用里包含**期望的 etscli 命令**  ← 关键增量

第 3 层是本套件与通用套件的根本差别:etscli 是确定性 CLI,同一个意图**只有一个
正确命令**(`auth status` 不能写成 `auth list`)。因此可以断言"模型选对了命令",
而不仅仅是"模型说了句话"。这直接对应训练目标 —— 后续 function-call 模型就是
基于 etscli 训练的,选型指标应当是**命令正确率**,不是产出率。

**语料来源**:
  - 场景: `~/work/etsme/etscli/skills/*/SKILL.md`(11 个 skill 的命令表)
  - 命令: `etscli -h` 的 SERVICES / COMMANDS 段

**与被测实现解耦**:不硬编码任何具体 caller;服务名/版本从 `/health` 读取后原样
记入报告。同一套件可复用于验收任何 caller。

**用法**:
  python3 scripts/etscli-function-call-test.py
  python3 scripts/etscli-function-call-test.py --url http://127.0.0.1:9000
  python3 scripts/etscli-function-call-test.py --langs cn --rounds 5
  python3 scripts/etscli-function-call-test.py --render-only dist/etscli-fc-<ts>

**退出码**:全通过 0;有 case 未全过 1;有契约违规 2;服务不可达 3。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field, asdict
from typing import Any

# ── 契约定义(与 docs/function-call-external-http-contract.md 对齐)────────────

REQUIRED_RESPONSE_FIELDS: dict[str, type | tuple[type, ...]] = {
    "type": (str,),
    "function_calls": (list,),
    "confidence": (int, float),
}
TOLERATED_MISSING = {"type", "confidence"}   # 契约允许缺失,plugin 有兜底
VALID_TYPES = {"call", "respond"}


def check_conformance(payload: Any) -> list[str]:
    """按 HTTP 契约校验一次 2xx 响应体,返回违规描述列表(空 = 完全符合)。"""
    v: list[str] = []
    if not isinstance(payload, dict):
        return [f"响应体不是 JSON object(实际 {type(payload).__name__})"]
    for f, t in REQUIRED_RESPONSE_FIELDS.items():
        if f not in payload:
            if f in TOLERATED_MISSING:
                continue
            v.append(f"缺必填字段 `{f}`")
            continue
        val = payload[f]
        if t == (int, float) and isinstance(val, bool):
            v.append(f"字段 `{f}` 类型错误(bool,期望 number)")
        elif not isinstance(val, t):
            v.append(f"字段 `{f}` 类型错误({type(val).__name__},期望 "
                     f"{'/'.join(x.__name__ for x in t)})")
    tp = payload.get("type")
    if isinstance(tp, str) and tp not in VALID_TYPES:
        v.append(f"`type` 取值非法:`{tp}`(期望 {'/'.join(sorted(VALID_TYPES))})")
    cf = payload.get("confidence")
    if isinstance(cf, (int, float)) and not isinstance(cf, bool) and not 0.0 <= float(cf) <= 1.0:
        v.append(f"`confidence` 越界:{cf}(期望 0..1)")
    calls = payload.get("function_calls")
    if isinstance(calls, list):
        for i, c in enumerate(calls):
            if not isinstance(c, dict):
                v.append(f"function_calls[{i}] 不是 object")
                continue
            if "name" not in c:
                v.append(f"function_calls[{i}] 缺 `name`")
            if "arguments" not in c:
                v.append(f"function_calls[{i}] 缺 `arguments`")
    val = payload.get("validation")
    if isinstance(val, dict):
        un = val.get("ungrounded")
        if un is not None and not isinstance(un, list):
            v.append(f"`validation.ungrounded` 类型错误({type(un).__name__},期望 list)")
    return v


# ── 工具集 ──────────────────────────────────────────────────────────────────
# 刻意只给 `bash` + `read`:`bash` 执行 etscli,`read` 是干扰项 —— 模型必须选对
# 工具,而不是随手抓一个。多给工具会把"工具选择"和"命令正确性"两个变量混在一起。

TOOLS: list[dict[str, Any]] = [
    {
        "name": "bash",
        "description": "Execute a shell command in a persistent session and return "
                       "its output. Use etscli to manage the ETS box: auth, user, chat, "
                       "meeting, file, fs, migrate, sharing, system, discover.",
        "parameters": {
            "type": "object",
            "properties": {"command": {"type": "string"}},
            "required": ["command"],
        },
    },
    {
        "name": "read",
        "description": "Read a file from the local filesystem. Not for running commands.",
        "parameters": {
            "type": "object",
            "properties": {"file_path": {"type": "string"}},
            "required": ["file_path"],
        },
    },
]


# ── etscli 场景语料 ─────────────────────────────────────────────────────────
# 语料取自 etscli -h 的 11 个 service 与 skills/*/SKILL.md 的命令表。
# `expect` 为期望出现的 etscli 命令前缀(确定性 CLI,同一意图只有一个正确答案)。
# `negative=True` 的用例**不应**产生任何调用 —— 用于检测过度触发。

@dataclass(frozen=True)
class Case:
    cid: str
    domain: str
    expect: str | None      # 期望的 etscli 命令;None = 不该调工具
    en: str
    cn: str
    negative: bool = False
    alt: str | None = None  # 等价替代命令(如 file delete vs fs rm);命中任一即算对
    note: str = ""          # 歧义/注意事项,会印在报告里提醒判读


# 语料命令全部核对自 `etscli <service> --help`,未杜撰。
# 覆盖 10 个 service 共 48 个子命令中的 39 个。
CASES: list[Case] = [
    # ── auth (7 子命令,取 6)────────────────────────��─────────────────
    Case("auth-status", "auth", "etscli auth status",
         "check whether the box is logged in",
         "查询密盒的登录状态"),
    Case("auth-list", "auth", "etscli auth list",
         "list all saved login profiles",
         "列出所有已保存的 profile"),
    Case("auth-switch", "auth", "etscli auth switch",
         "switch to the office profile",
         "切换到 office 这个 profile"),
    Case("auth-rename", "auth", "etscli auth rename",
         "rename the office profile to company",
         "把 office 这个 profile 重命名为 company"),
    Case("auth-login", "auth", "etscli auth login",
         "log in to the box at 192.168.1.100 as admin",
         "登录到 192.168.1.100 的密盒,用户名 admin"),
    Case("auth-logout", "auth", "etscli auth logout",
         "log out of the current profile",
         "登出当前的 profile"),

    # ── user (5 子命令,取 4)─────────────────────────────────────────
    Case("user-list", "user", "etscli user list",
         "list all the users on the box",
         "列出密盒上的所有用户"),
    Case("user-detail", "user", "etscli user detail",
         "show the details of user user01",
         "查看 user01 的详细信息"),
    Case("user-register", "user", "etscli user register",
         "register a new user called bob",
         "注册一个名为 bob 的新用户"),
    Case("user-passwd", "user", "etscli user passwd",
         "change the password of user user01",
         "修改 user01 的密码"),

    # ── chat (5 子命令,取 4)──────────────────────────────────────────
    Case("chat-list", "chat", "etscli chat list",
         "list my group chats",
         "列出我的群聊列表"),
    Case("chat-messages", "chat", "etscli chat messages",
         "show the recent messages in a group chat",
         "查看某个群聊的最近消息"),
    Case("chat-send", "chat", "etscli chat send",
         "send a text message to a group chat",
         "往群聊里发一条文字消息"),
    Case("chat-send-file", "chat", "etscli chat send-file",
         "send a file to a group chat",
         "把文件发送到群聊里"),

    # ── meeting (6 子命令,取 5)───────────────────────────────────────
    Case("meeting-list", "meeting", "etscli meeting list",
         "list all the meetings on the box",
         "列出密盒上所有的会议"),
    Case("meeting-summary", "meeting", "etscli meeting summary",
         "get the summary of the latest meeting",
         "获取最近一次会议的纪要"),
    Case("meeting-detail", "meeting", "etscli meeting detail",
         "show the details of the meeting with id mtg001",
         "查看 id 为 mtg001 的会议详情"),
    Case("meeting-create", "meeting", "etscli meeting create",
         "create a new meeting called weekly sync",
         "创建一个名为 weekly sync 的新会议"),
    Case("meeting-finish", "meeting", "etscli meeting finish",
         "end the meeting that is currently running",
         "结束当前正在进行的会议"),

    # ── file (10 子命令,取 5)─────────────────────────────────────────
    Case("file-search", "file", "etscli file search",
         "search the box for files whose name contains report",
         "搜索密盒里名字包含报告的文件"),
    Case("file-detail", "file", "etscli file detail",
         "show the details of a box file given its file id",
         "查看指定 file id 的文件详情",
         note="按 file id 操作,应走 file 而非 fs"),
    Case("file-upload", "file", "etscli file upload",
         "upload a local file to the box",
         "把本地文件上传到密盒",
         alt="etscli file upload-dir",
         note="upload / upload-dir 均可接受"),
    Case("file-download", "file", "etscli file download",
         "download a file from the box by its file id",
         "按 file id 从密盒下载文件",
         note="按 file id 操作,应走 file 而非 fs"),
    Case("file-delete", "file", "etscli file delete",
         "delete a box file given its file id",
         "按 file id 删除密盒里的文件",
         alt="etscli fs rm",
         note="⚠ 歧义:fs rm 按路径删除同样说得通,两者皆可接受"),

    # ── fs (9 子命令,取 6)────────────────────────────────────────────
    Case("fs-ls", "fs", "etscli fs ls",
         "show the files in my album folder",
         "列出我的相册目录下的文件"),
    Case("fs-mkdir", "fs", "etscli fs mkdir",
         "create a new folder named backup on the box",
         "在密盒上新建一个名为 backup 的文件夹"),
    Case("fs-rm", "fs", "etscli fs rm",
         "delete a file on the box by its path",
         "按路径删除密盒上的文件",
         alt="etscli file delete",
         note="⚠ 歧义:file delete 按 id 删除同样说得通,两者皆可接受"),
    Case("fs-search", "fs", "etscli fs search",
         "search for files by name under a folder on the box",
         "在密盒上按文件名搜索文件"),
    Case("fs-stat", "fs", "etscli fs stat",
         "show the stat info of a file on the box",
         "查看密盒上某个文件的 stat 信息",
         alt="etscli fs stats",
         note="stat / stats 均可接受"),
    Case("fs-add", "fs", "etscli fs add",
         "add a local file into a folder on the box",
         "把本地文件添加到密盒的某个目录"),

    # ── sharing (3 子命令,全取)───────────────────────────────────────
    Case("sharing-list", "sharing", "etscli sharing list",
         "list all the sharing links I created",
         "列出我创建的所有分享链接"),
    Case("sharing-create", "sharing", "etscli sharing create",
         "create a sharing link for a box file",
         "为密盒里的某个文件创建分享链接"),
    Case("sharing-delete", "sharing", "etscli sharing delete",
         "delete a sharing link",
         "删除一个分享链接"),

    # ── system (3 子命令,全取)────────────────────────────────────────
    Case("system-info", "system", "etscli system info",
         "show the system information of the box",
         "显示密盒的系统信息"),
    Case("system-health", "system", "etscli system health",
         "check the health of the box",
         "检查密盒的健康状态"),
    Case("system-alarm", "system", "etscli system alarm",
         "list the alarms on the box",
         "列出密盒上的告警",
         alt="etscli system alarm list",
         note="alarm 及其子命令 list 均可接受"),

    # ── discover (1 子命令,全取)──────────────────────────────────────
    Case("discover-scan", "discover", "etscli discover scan",
         "scan the local network for boxes",
         "扫描局域网里的密盒设备"),

    # ── migrate (5 子命令,取 2)───────────────────────────────────────
    Case("migrate-transfer", "migrate", "etscli migrate transfer",
         "migrate the data from the old box to the new one",
         "把旧盒子的数据迁移到新盒子"),
    Case("migrate-verify", "migrate", "etscli migrate verify",
         "verify the migration result",
         "验证迁移的结果"),

    # ── 负例:不应触发任何调用(检测过度触发)─────────────────────────
    Case("negative-greeting", "negative", None,
         "hello, thanks for your help",
         "你好,谢谢你的帮助", negative=True),
    Case("negative-knowledge", "negative", None,
         "what is the capital of France",
         "法国的首都是哪里", negative=True),
    Case("negative-weather", "negative", None,
         "what is the weather like in Tokyo today",
         "今天东京的天气怎么样", negative=True),
]

DOMAIN_ORDER = ["auth", "user", "chat", "meeting", "file", "fs", "sharing",
                "system", "discover", "migrate", "negative"]
LOCALES = {"en": "en-US", "cn": "zh-CN"}
LANG_LABEL = {"en": "English", "cn": "Chinese"}


# ── 正确性判定 ──────────────────────────────────────────────────────────────

_WS = re.compile(r"\s+")


def _args_text(arguments: Any) -> str:
    """把 arguments 摊平成可搜索文本(兼容 dict / str / 嵌套)。"""
    if arguments is None:
        return ""
    if isinstance(arguments, str):
        return arguments
    try:
        return json.dumps(arguments, ensure_ascii=False)
    except Exception:
        return str(arguments)


def is_correct(calls: list[dict], expect: str | None, alt: str | None = None) -> bool:
    """判断产出的调用是否命中期望命令。

    - 负例(expect=None):不产生调用才算正确
    - 正例:任一调用的参数文本里出现 `etscli <service> <command>` 前缀即算命中。
      允许前置 `cd` / `&&` 等包装,只要求期望子命令完整出现。
    - `alt` 为语义等价的替代命令(如 `fs rm` vs `file delete`):
      命中任一即正确 —— 这类 case 属于本质歧义,不应因此判负。
    """
    produced = [(c.get("name"), _args_text(c.get("arguments"))) for c in calls
                if isinstance(c, dict)]
    if expect is None:
        return len(produced) == 0
    if not produced:
        return False
    targets = [_WS.sub(" ", t).lower() for t in (expect, alt) if t]
    for _name, text in produced:
        flat = _WS.sub(" ", text).lower()
        if any(t in flat for t in targets):
            return True
    return False


# ── 单次调用 ────────────────────────────────────────────────────────────────

@dataclass
class Attempt:
    http: int
    ok: bool
    calls: list
    confidence: float | None
    latency_s: float
    error: str | None
    failure_class: str | None = None
    contract_violations: list[str] = field(default_factory=list)


def classify_error(err: str) -> str:
    low = err.lower()
    if "utf-8" in low or "codec can't decode" in low or "unicode" in low:
        return "encoding"
    if "token budget" in low or "truncat" in low:
        return "truncated"
    if "busy" in low:
        return "busy"
    if "queue" in low or "loading" in low:
        return "overloaded"
    return "other"


def one_attempt(url: str, query: str, locale: str, timeout: float) -> Attempt:
    body = json.dumps(
        {"query": query, "tools": TOOLS, "system": f"date: 2026-09-28 Mon; locale: {locale}"},
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
    expect: str | None
    trials: int
    passed: int          # HTTP 200
    failed: int
    correct: int         # 命中期望命令(负例 = 未产生调用)
    failure_classes: dict[str, int] = field(default_factory=dict)
    latencies: list[float] = field(default_factory=list)
    calls_when_ok: list[int] = field(default_factory=list)
    confidences: list[float] = field(default_factory=list)
    contract_violations: dict[str, int] = field(default_factory=dict)
    sample_error: str | None = None
    sample_violation: str | None = None
    sample_call: str | None = None
    alt: str | None = None
    note: str = ""

    @property
    def success_rate(self) -> float:
        return self.passed / self.trials if self.trials else 0.0

    @property
    def correct_rate(self) -> float:
        return self.correct / self.trials if self.trials else 0.0


def run_case(url: str, case: Case, lang: str, trials: int, timeout: float) -> CaseResult:
    query = getattr(case, lang)
    locale = LOCALES[lang]
    res = CaseResult(case_id=case.cid, lang=lang, domain=case.domain, expect=case.expect,
                     trials=trials, passed=0, failed=0, correct=0,
                     alt=case.alt, note=case.note)
    for _ in range(trials):
        a = one_attempt(url, query, locale, timeout)
        res.latencies.append(a.latency_s)
        for viol in a.contract_violations:
            res.contract_violations[viol] = res.contract_violations.get(viol, 0) + 1
            if res.sample_violation is None:
                res.sample_violation = viol
        if a.ok:
            res.passed += 1
            res.calls_when_ok.append(len(a.calls))
            if a.confidence is not None:
                res.confidences.append(a.confidence)
            if is_correct(a.calls, case.expect, case.alt):
                res.correct += 1
            elif res.sample_call is None:
                res.sample_call = json.dumps(a.calls, ensure_ascii=False)[:200]
        else:
            res.failed += 1
            cls = a.failure_class or "unknown"
            res.failure_classes[cls] = res.failure_classes.get(cls, 0) + 1
            if res.sample_error is None:
                res.sample_error = a.error
    return res


# ── 报告渲染 ────────────────────────────────────────────────────────────────

def render_report(results: list[CaseResult], url: str, trials: int, ts: str,
                  health: dict | None = None,
                  conformance_measured: bool = True,
                  corpus: list[Case] | None = None) -> str:
    if corpus is None:
        corpus = CASES   # 回退到模块级(代码内运行时)
    L: list[str] = []
    A = L.append

    def group(lang):
        return [r for r in results if r.lang == lang]

    en, cn = group("en"), group("cn")

    def agg(g, attr):
        return sum(getattr(r, attr) for r in g)

    def trials_of(g):
        return sum(r.trials for r in g)

    def rate(g, attr):
        return agg(g, attr) / max(1, trials_of(g))

    en_lat = [x for r in en for x in r.latencies]
    cn_lat = [x for r in cn for x in r.latencies]
    viol_total = sum(sum(r.contract_violations.values()) for r in results)
    svc_name = (health or {}).get("name") or (health or {}).get("service") or "未自报"
    svc_ver = (health or {}).get("version") or ""

    A("# etscli 场景 function-call caller 测试报告")
    A("")
    A(f"- **生成时间**: {ts}")
    A(f"- **被测服务**: `{url}` —— 自报 `{svc_name}` {svc_ver}")
    A(f"- **语料**: etscli 真实场景,{len([c for c in CASES if not c.negative])} 正例 + "
      f"{len([c for c in CASES if c.negative])} 负例,覆盖 "
      f"{len([c for c in CASES if not c.negative] and set(c.domain for c in CASES))} 个 service")
    A(f"- **每 case 试验次数**: {trials}")
    A("- **工具集**: `bash`(执行 etscli)+ `read`(干扰项,测工具选择)")
    A("")

    # ── 1 判定 ──
    A("## 1. 判定")
    A("")
    A("| 指标 | English | Chinese |")
    A("|---|---|---|")
    A(f"| HTTP 成功 | {rate(en,'passed'):.0%} | {rate(cn,'passed'):.0%} |")
    A(f"| 有效产出(有调用) | {rate(en,'passed') and (sum(sum(1 for c in r.calls_when_ok if c>0) for r in en)/max(1,trials_of(en))):.0%} "
      f"| {sum(sum(1 for c in r.calls_when_ok if c>0) for r in cn)/max(1,trials_of(cn)):.0%} |")
    A(f"| **命令正确率** | **{rate(en,'correct'):.0%}** | **{rate(cn,'correct'):.0%}** |")
    A(f"| 中位延迟 | {sorted(en_lat)[len(en_lat)//2]:.1f}s | {sorted(cn_lat)[len(cn_lat)//2]:.1f}s |" if en_lat and cn_lat else "| 中位延迟 | — | — |")
    A("")
    A("> **三层评分的区别很重要:**")
    A(">")
    A("> - `HTTP 成功` —— 服务没报错")
    A("> - `有效产出` —— 产出了至少一个 `function_call`(prefill 有用的前提)")
    A("> - **`命令正确率`** —— 产出的调用里出现了**期望的 etscli 命令**")
    A(">")
    A("> etscli 是确定性 CLI,同一意图**只有一个正确命令**(`auth status` 不能写成")
    A("> `auth list`)。所以第三层才是真正的能力指标 —— 前两层通过但命令选错,")
    A("> 对智能体而言依然是失败。**选型应以命令正确率为准。**")
    A("")
    if conformance_measured:
        A(f"> **契约符合性:{viol_total} 次违规。** 0 次表示每次 2xx 响应的字段与类型")
        A("> 都符合 `docs/function-call-external-http-contract.md`。")
    else:
        A("> ⚠ **契约符合性未测量**(数据生成于该检查加入之前)。缺失数据 ≠ 零违规。")
    A("")

    # ── 1.1 负例 ──
    neg_en = [r for r in en if r.domain == "negative"]
    neg_cn = [r for r in cn if r.domain == "negative"]
    if neg_en or neg_cn:
        A("### 1.1 过度触发检测(负例)")
        A("")
        A("| 语言 | 负例 | 正确(未触发) | 过度触发率 |")
        A("|---|---|---|---|")
        for label, g in (("English", neg_en), ("Chinese", neg_cn)):
            if g:
                t = sum(r.trials for r in g)
                c = sum(r.correct for r in g)
                A(f"| {label} | {sum(r.trials for r in g)} | {c} | {1-c/max(1,t):.0%} |")
        A("")
        A("> 闲聊/知识问答**不该**产生 etscli 调用。过度触发会白白执行命令,")
        A("> 严重时产生非预期副作用(如 `fs rm`)。")
        A("")

    # ── 1.2 契约符合性 ──
    A("### 1.2 契约符合性明细")
    A("")
    if not conformance_measured:
        A("**未测量。** 本份数据生成于契约符合性检查加入之前。")
    elif viol_total == 0:
        A("全部 2xx 响应均通过契约校验:必填字段齐全、类型正确、`confidence ∈ [0,1]`、")
        A("`function_calls[]` 结构合法。")
    else:
        A("| 违规项 | 次数 |")
        A("|---|---|")
        agg_v: dict[str, int] = {}
        for r in results:
            for k, v in r.contract_violations.items():
                agg_v[k] = agg_v.get(k, 0) + v
        for k, v in sorted(agg_v.items(), key=lambda x: -x[1]):
            A(f"| {k} | {v} |")
    A("")

    # ── 2 逐 case ──
    A("## 2. 逐 case 明细")
    A("")
    A("| case | 语言 | 期望命令 | HTTP | 有效产出 | 正确 | conf | 失败类型 |")
    A("|---|---|---|---|---|---|---|---|")
    for r in results:
        if r.expect is None:
            exp = "_不应调用_"
        elif r.alt:
            exp = f"`{r.expect}`<br/>或 `{r.alt}`"
        else:
            exp = f"`{r.expect}`"
        useful = sum(1 for c in r.calls_when_ok if c > 0)
        cf = f"{r.confidences[0]:.2f}" if r.confidences else "—"
        fc = ", ".join(f"{k}×{v}" for k, v in sorted(r.failure_classes.items())) or "—"
        A(f"| `{r.case_id}` | {LANG_LABEL[r.lang]} | {exp} "
          f"| {r.passed}/{r.trials} | {useful}/{r.passed or 0} "
          f"| {r.correct}/{r.trials} | {cf} | {fc} |")
    A("")

    # ── 2.1 按 service ──
    A("### 2.1 按 service 的命令正确率")
    A("")
    A("| service | English 正确率 | Chinese 正确率 |")
    A("|---|---|---|")
    for dom in DOMAIN_ORDER:
        e = [r for r in en if r.domain == dom]
        c = [r for r in cn if r.domain == dom]
        if not e and not c:
            continue

        def fmt(g):
            if not g:
                return "—"
            t = sum(r.trials for r in g)
            return f"{sum(r.correct for r in g)/max(1,t):.0%} ({sum(r.correct for r in g)}/{t})"

        A(f"| {dom} | {fmt(e)} | {fmt(c)} |")
    A("")

    # ── 2.2 歧义 case ──
    ambig = [r for r in results if r.alt]
    if ambig:
        A("### 2.2 歧义 case(命中 `expect` 或 `alt` 都算对)")
        A("")
        A("| case | 语言 | 期望 | 也接受 |")
        A("|---|---|---|---|")
        seen_pairs = set()
        for r in ambig:
            key = (r.case_id, r.lang)
            if key in seen_pairs:
                continue
            seen_pairs.add(key)
            A(f"| `{r.case_id}` | {LANG_LABEL[r.lang]} | `{r.expect}` | `{r.alt}` |")
        A("")
        A("> 例:`fs-rm`(「按路径删除文件」)既可用 `etscli fs rm` 也可用")
        A("> `etscli file delete`(按 id 删除)。这类本质歧义不应让模型被扣分。")
        A("")

    # ── 3 错例样本 ──
    A("## 3. 错例样本")
    A("")
    wrong = [r for r in results if r.sample_call]
    if wrong:
        A("以下 case 产出了调用,但**命令不对** —— 这类错误比 502 更隐蔽:")
        A("")
        for r in wrong[:6]:
            A(f"**`{r.case_id}`**({LANG_LABEL[r.lang]},期望 `{r.expect or '不应调用'}`):")
            A("")
            A("```")
            A(r.sample_call)
            A("```")
            A("")
        if len(wrong) > 6:
            A(f"_另有 {len(wrong)-6} 条,见 results.json_")
            A("")
    else:
        A("无错例。")
        A("")
    seen: set[str] = set()
    printed = False
    for r in results:
        for cls in r.failure_classes:
            if cls in seen or not r.sample_error:
                continue
            seen.add(cls)
            printed = True
            A(f"**`{cls}`**(case `{r.case_id}`,{r.failure_classes[cls]}/{r.trials} 次):")
            A("")
            A("```")
            A(r.sample_error)
            A("```")
            A("")
    if not printed and not wrong:
        A("无失败。")
        A("")

    # ── 4 语料 ──
    A("## 4. 测试语料")
    A("")
    A("> 中英文**分表列出**而非并排 —— 并排时两列紧邻,长 query 容易被误读成")
    A("> 另一列的延续。两侧 query 语义等价,只用于对比语言维度。")
    A("")

    A("### 4.1 English")
    A("")
    A("| case | service | expect | alt | note | query |")
    A("|---|---|---|---|---|---|")
    for c in CASES:
        exp = f"`{c.expect}`" if c.expect else "_no call expected_"
        alt = f"`{c.alt}`" if c.alt else "—"
        note = c.note.replace("⚠", "**⚠**") if c.note else "—"
        A(f"| `{c.cid}` | {c.domain} | {exp} | {alt} | {note} | {c.en} |")
    A("")

    A("### 4.2 中文")
    A("")
    A("| case | service | 期望命令 | 也接受 | 备注 | query |")
    A("|---|---|---|---|---|---|")
    for c in CASES:
        exp = f"`{c.expect}`" if c.expect else "_不应调用_"
        alt = f"`{c.alt}`" if c.alt else "—"
        note = c.note.replace("⚠", "**⚠**") if c.note else "—"
        A(f"| `{c.cid}` | {c.domain} | {exp} | {alt} | {note} | {c.cn} |")
    A("")
    A("> 语料来源:`etscli <service> --help` 的 10 个 service + `~/work/etsme/etscli/skills/*/SKILL.md`")
    A("> 的命令表。每条期望命令都核对过子命令确实存在。")
    A("> `⚠` 标注的 case 存在本质歧义(如按路径 vs 按 id 删除),接受任一合理答案。")
    A("")

    # ── 5 影响 ──
    A("## 5. 对 dsh-edge-agent 的影响")
    A("")
    cn_correct = rate(cn, "correct")
    en_correct = rate(en, "correct")
    A(f"- 英文命令正确率 **{en_correct:.0%}** / 中文 **{cn_correct:.0%}**。")
    A(f"- dsh-edge-agent 是中文产品,**中文命令正确率是启用 `function-call-external` 的先决条件**。")
    A("")
    if cn_correct >= 0.8 and viol_total == 0:
        A("✅ 达到启用门槛,建议接入:")
        A("")
        A("```bash")
        A("FUNCTION_CALL_EXTERNAL_ENABLED=true")
        A(f"FUNCTION_CALL_EXTERNAL_URL={url}")
        A("```")
    else:
        A("❌ 未达启用门槛。开启会是净损耗(白等 latency + 熔断器反复开关),")
        A("建议保持 `FUNCTION_CALL_EXTERNAL_ENABLED=false`。")
    A("")

    # ── 6 建议 ──
    A("## 6. 建议")
    A("")
    if cn_correct < 0.8:
        A("**中文能力**(阻断性):")
        A(f"- 命令正确率仅 {cn_correct:.0%}。etscli 训练语料中中文样本的覆盖度是关键,")
        A("  中文 query → 英文命令的映射需要显式训练,而非依赖模型的中文理解力。")
        A("- 静默式错误(有调用但命令错)比报错更危险 —— 需在训练中强化命令精确性。")
        A("")
    if any(r.sample_call for r in results):
        A("**命令精确性**:错例集中在具体命令选择(`auth status` vs `auth list`)。")
        A("建议训练时以**完整命令序列**为监督目标,而非仅工具名。")
        A("")
    A("**通用**:")
    A("- 失败语义应可区分(过载 / 编码 / 截断),便于调用方决定重试与熔断。")
    A("- `/health` 声明的能力应与实际行为一致。")
    A("- 持续扩充语料 —— 当前 21 例覆盖 10 个 service,建议每 service ≥3 例。")
    A("")
    return "\n".join(L)


def write_report(path: str, results: list[CaseResult], url: str, trials: int, ts: str,
                 health: dict | None = None, conformance_measured: bool = True,
                 corpus: list[Case] | None = None) -> int:
    """渲染并落盘,返回字节数。

    显式校验非空 —— 踩过的坑:模板里 `for L in LENGTHS:` 覆盖了收集行的列表 `L`,
    `"\n".join(L)` join 的是字符串,报告只剩 7 字节而 exit code 仍 0。
    静默失败比崩溃更难发现,故在此兜底。
    """
    rendered = render_report(results, url, trials, ts, health, conformance_measured, corpus)
    if len(rendered) < 500 or "## 1. 判定" not in rendered:
        raise RuntimeError(f"报告渲染异常(仅 {len(rendered)} 字节),拒绝落盘")
    with open(path, "w", encoding="utf-8") as f:
        f.write(rendered)
    return len(rendered)


# ── main ────────────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(description="etscli 场景 function-call caller 测试")
    ap.add_argument("--url", default=os.environ.get("FUNCTION_CALL_EXTERNAL_URL",
                                                    "http://127.0.0.1:8081"))
    ap.add_argument("--trials", type=int, default=3)
    ap.add_argument("--rounds", type=int, default=1)
    ap.add_argument("--timeout", type=float, default=45.0)
    ap.add_argument("--out", default="")
    ap.add_argument("--langs", default="en,cn")
    ap.add_argument("--render-only", default="")
    args = ap.parse_args()

    if args.render_only:
        src = os.path.join(args.render_only, "results.json")
        with open(src, encoding="utf-8") as f:
            blob = json.load(f)
        rows = blob.get("results") or blob.get("cases_results")
        if not rows:
            print("✗ results.json 中找不到结果行(results / cases_results)", file=sys.stderr)
            return 3
        results = [CaseResult(**c) for c in rows]
        measured = any("contract_violations" in c for c in rows)
        # 优先用 json 里的语料(结果与当时语料一一对应);回退到模块级
        corpus_dicts = blob.get("corpus") or [
            {"cid": c.cid, "domain": c.domain, "expect": c.expect,
             "en": c.en, "cn": c.cn, "negative": c.negative,
             "alt": c.alt, "note": c.note} for c in CASES
        ]
        corpus = [Case(**{k: v for k, v in cd.items() if k in Case.__dataclass_fields__})
                  for cd in corpus_dicts]
        out_dir = args.out or args.render_only
        os.makedirs(out_dir, exist_ok=True)
        eff = blob.get("effectiveTrialsPerCase") or blob["trialsPerCase"]
        n = write_report(os.path.join(out_dir, "report.md"), results,
                         blob["service"], eff, blob["generatedAt"],
                         blob.get("health"), measured, corpus)
        print(f"  报告已重渲: {out_dir}/report.md ({n} 字节)")
        return 0

    ts = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    out_dir = args.out or f"dist/etscli-fc-{ts}"
    os.makedirs(out_dir, exist_ok=True)
    langs = [x.strip() for x in args.langs.split(",") if x.strip()]
    base_url = args.url.rstrip("/")

    try:
        with urllib.request.urlopen(f"{base_url}/health", timeout=5) as r:
            health = json.loads(r.read())
    except Exception as e:
        print(f"✗ [FATAL] {base_url}/health 不可达: {e}", file=sys.stderr)
        return 3

    eff_trials = args.trials * args.rounds
    print("═══ etscli function-call conformance test ═══")
    print(f"  service: {base_url}  ({health.get('name') or '未自报'} {health.get('version') or ''})".rstrip())
    print(f"  语料:    {len(CASES)} cases × {len(langs)} langs")
    print(f"  trials:  {args.trials} × {args.rounds} rounds = {eff_trials} per case")
    print(f"  out:     {out_dir}")
    print("")

    acc: dict[tuple[str, str], CaseResult] = {}
    total = len(CASES) * len(langs) * eff_trials
    done = 0
    for rnd in range(args.rounds):
        for lang in langs:
            for case in CASES:
                r = run_case(base_url, case, lang, args.trials, args.timeout)
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

    def pick(lang):
        return [r for r in results if r.lang == lang]

    def summarize(lang):
        g = pick(lang)
        t = sum(r.trials for r in g)
        if not t:
            return None
        return (f"{lang}: HTTP {sum(r.passed for r in g)/t:.0%}  "
                f"correct {sum(r.correct for r in g)/t:.0%}")

    print("")
    for lang in langs:
        s = summarize(lang)
        if s:
            print(f"  {s}")
    viol_total = sum(sum(r.contract_violations.values()) for r in results)
    print(f"  契约违规: {viol_total}")

    with open(os.path.join(out_dir, "results.json"), "w", encoding="utf-8") as f:
        json.dump({
            "generatedAt": ts, "service": base_url, "health": health,
            "trialsPerCase": args.trials, "rounds": args.rounds,
            "effectiveTrialsPerCase": eff_trials,
            "methodology": "etscli 真实场景;三层评分(HTTP/有效产出/命令正确率);"
                           "工具集固定为 bash+read",
            "contractDoc": "docs/function-call-external-http-contract.md",
            "corpusSource": "etscli -h + ~/work/etsme/etscli/skills/*/SKILL.md",
            "tools": TOOLS,
            "corpus": [{
                "cid": c.cid, "domain": c.domain, "expect": c.expect,
                "en": c.en, "cn": c.cn, "negative": c.negative,
                "alt": c.alt, "note": c.note,
            } for c in CASES],
            "summary": {lang: {
                "httpPassed": sum(r.passed for r in pick(lang)),
                "correct": sum(r.correct for r in pick(lang)),
                "trials": sum(r.trials for r in pick(lang)),
                "contractViolations": sum(sum(r.contract_violations.values())
                                         for r in pick(lang)),
            } for lang in langs},
            "results": [asdict(r) for r in results],
        }, f, ensure_ascii=False, indent=2)

    n = write_report(os.path.join(out_dir, "report.md"), results, base_url, eff_trials, ts, health)
    print("")
    print(f"  报告: {out_dir}/report.md ({n} 字节)")
    print(f"  数据: {out_dir}/results.json")
    if viol_total:
        return 2
    return 0 if all(r.correct == r.trials for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
