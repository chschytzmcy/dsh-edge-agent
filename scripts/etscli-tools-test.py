#!/usr/bin/env python3
"""
etscli-tools-test.py — etscli-as-tool 形态的 function-call caller 测试套件

**为什么用直出形态而非 bash 包装**:dsh 真实的 tool 注册表是细粒度具体工具
(`glob`/`read`/`web_search`),不是"让模型自己拼 shell 命令"。bash 包装形态下,
描述里只列了 10 个 service 名、**没有任何子命令**,模型要答对需凭空生成
`etscli auth status -p office` —— 那测的是"模型是否已知道 etscli"(预训练知识),
而非 function call 能力,对未训过 etscli 的端侧模型不公平。直出形态把
子命令和 flag 全部写进 schema,才是可验收的形态。

**三层评分**:HTTP 成功 / 有效产出 / **工具选择正确率**。
判定从"命令前缀命中"改为"**工具名精确匹配**"—— 因为工具直出形态下
`etscli_auth_status` 与 `etscli_auth_logout` 是两个不同的工具,没有模糊空间。

**工具描述语言**:`--desc-lang cn|en|both`(默认 `cn`)。中文产品用中文描述是
现实选择;但若只用中文描述,英文 query 就额外承担了"跨语言读描述"的压力。
`both` 让中英测试公平对照(代价:payload 约翻倍)。

**虚高检测(`--distractors N`)**:工具直出形态下,工具名本身是强词法线索
(`etscli_auth_status` ↔「登录状态」),词法匹配可能蒙对而未真正理解。
每个正例 case 追加 N 个**近义干扰工具**(优先易混对 + 后缀变体,描述与期望
工具几乎同义、名字只差后缀,如 `etscli_file_search_raw`),期望工具不变。
报告统计"选了干扰项"的比例。与 `--distractors 0` 基线对比,正确率的下降
幅度就是**词法虚高幅度**。负例不注入干扰(期望本就是"不调用")。

**用法**:
  python3 scripts/etscli-tools-test.py
  python3 scripts/etscli-tools-test.py --url http://127.0.0.1:9000 --desc-lang both
  python3 scripts/etscli-tools-test.py --langs cn --rounds 3
  python3 scripts/etscli-tools-test.py --distractors 3 --out dist/etscli-tools-d3
  python3 scripts/etscli-tools-test.py --render-only dist/etscli-tools-<ts>

**退出码**:0 全对 / 1 有 case 未全过 / 2 有契约违规 / 3 服务不可达。
"""
from __future__ import annotations


import argparse
import json
import os
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

LANG_LABEL = {"en": "English", "cn": "Chinese"}
LOCALES = {"en": "en-US", "cn": "zh-CN"}


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


# ── 干扰项:量化"词法匹配虚高" ──────────────────────────────────────────────
# 直出形态下,工具名本身就是强词法线索(`etscli_auth_status` 直接对上"登录状态")。
# 词法匹配型模型可能在无干扰时靠"名字像 query"蒙对,而**没有真正理解**意图。
#
# 检测方法:给每个 case 注入 N 个**针对其期望工具**的近义兄弟,再测一次。
#   正确率大幅下降 → 原来的分数主要是词法匹配(虚高)
#   正确率基本不变   → 模型是真的在做语义区分
#
# 干扰项刻意设计成"名字极像、语义不是正解",模拟真实工具集里的同族命令
# (如 `file_detail` vs `file_detail_raw` —— 后者不是真答案)。

_DISTRACTOR_SUFFIX = [
    ("_raw", "原始(未格式化)输出,不含摘要字段"),
    ("_export", "导出为外部格式(CSV/JSON),不做展示"),
    ("_history", "历史记录查询,仅返回归档条目"),
    ("_preview", "生成预览,不落库不返回完整结果"),
    ("_batch", "批量版本,要求显式提供条目列表"),
    ("_verbose", "详细模式,额外返回调试字段"),
]

#: 跨 service 的天然混淆对 —— 真实产品里 file(按 id)与 fs(按路径)职责相近,
#: 是最容易被选错的组合。命中其中之一即视为选错。
_CONFUSABLE_PAIRS = [
    ("etscli_file_search", "etscli_fs_search"),
    ("etscli_file_detail", "etscli_fs_stat"),
    ("etscli_file_delete", "etscli_fs_rm"),
    ("etscli_file_download", "etscli_fs_ls"),
]


def build_distractors(case: Case, n: int, desc_lang: str) -> list[dict[str, Any]]:
    """为单个 case 生成 n 个近义干扰工具。"""
    if n <= 0 or case.expect is None:
        return []
    base = expected_tools(case)[0]
    known = set(TOOL_NAMES)
    out: list[dict[str, Any]] = []

    # 先放跨 service 混淆项(若该 case 的期望工具有天然对手)
    for real, other in _CONFUSABLE_PAIRS:
        if real == base and other in known and len(out) < n:
            src = next(t for t in _TOOL_SPEC if t[0] == other)
            out.append(_mk_tool(src, desc_lang))
            break

    # 再补同族近义兄弟
    i = 0
    while len(out) < n and i < len(_DISTRACTOR_SUFFIX):
        suffix, desc = _DISTRACTOR_SUFFIX[i]
        name = f"{base}{suffix}"
        if name not in known:
            out.append({
                "name": name,
                "description": desc if desc_lang == "cn" else
                               f"({desc}) - not the canonical command, do not use for normal queries",
                "parameters": {"type": "object", "properties": {}},
            })
        i += 1
    return out[:n]


def _mk_tool(spec: tuple, desc_lang: str) -> dict[str, Any]:
    name, cn, en, props, *rest = spec
    return {
        "name": name,
        "description": {"cn": cn, "en": en, "both": f"{cn} / {en}"}[desc_lang],
        "parameters": {"type": "object", "properties": props},
    }


# ── 期望工具映射 ────────────────────────────────────────────────────────────
# case.expect 形如 "etscli auth status" → 期望工具 "etscli_auth_status"
# 语料的 fs-stat / system-alarm 用 alt 表达"两可",这里映射成具体工具名。

def cmd_to_tool(cmd: str) -> str:
    """`etscli auth status` → `etscli_auth_status`(空格与连字符都归一为下划线)。"""
    return "_".join(cmd.strip().replace("-", " ").split())


#: 命令组 / 旧别名 → 工具直出形态下的真实工具名。
#: 语料里两可(用 `alt` 表达)的 case:在工具直出形态下它们不是两个工具,
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
    distractors: list[str] = field(default_factory=list)
    picked_distractor: int = 0   # 选了干扰项的次数(被诱导,区别于"本来就乱选")


def run_case(url: str, case: Case, lang: str, tools: list[dict],
             trials: int, timeout: float, n_distractors: int = 0,
             desc_lang: str = "cn") -> CaseResult:
    allowed = expected_tools(case)
    distractors = build_distractors(case, n_distractors, desc_lang)
    sent_tools = tools + distractors
    res = CaseResult(case_id=case.cid, lang=lang, domain=case.domain,
                     expect_tools=allowed, trials=trials, passed=0, failed=0, correct=0,
                     distractors=[d["name"] for d in distractors])
    trap_names = {d["name"] for d in distractors}
    for _ in range(trials):
        a = one_attempt(url, getattr(case, lang), LOCALES[lang], sent_tools, timeout)
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
            got = [c.get("name") for c in a.calls if isinstance(c, dict)]
            if is_correct(a.calls, allowed):
                res.correct += 1
            elif got and any(n in trap_names for n in got):
                res.picked_distractor += 1
            if res.sample_call is None:
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
                  health: dict | None, desc_lang: str, n_tools: int,
                  n_distractors: int = 0) -> str:
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
    if n_distractors > 0:
        A(f"- **干扰项注入**: 每个正例 case 追加 **{n_distractors}** 个近义工具"
          f"(词法虚高检测,期望工具不变)")
    A(f"- **每 case 试验次数**: {trials}")
    A(f"- **语料**: 42 例(39 正例 + 3 负例),源自 `etscli <service> --help` "
      f"与 `~/work/etsme/etscli/skills/*/SKILL.md` 的真实命令表")
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
    A("> **但直出形态有虚高风险**:工具名本身是强词法线索")
    A("> (`etscli_auth_status` 直接对上「登录状态」),词法匹配型模型可能靠")
    A("> \"名字像 query\"蒙对而未真正理解。`--distractors N` 用于量化这一虚高。")
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

    # ── 1.3 虚高检测 ──
    if n_distractors > 0:
        trapped = sum(r.picked_distractor for r in pos_en) + \
                  sum(r.picked_distractor for r in pos_cn)
        pos_t_all = tr(pos_en) + tr(pos_cn)
        corr_all = agg(pos_en, "correct") + agg(pos_cn, "correct")
        A("### 1.3 虚高检测(已注入干扰项)")
        A("")
        A(f"每个 case 注入了 **{n_distractors}** 个近义干扰工具。干扰项分两类:")
        A("")
        A("1. **跨 service 混淆** —— 如 `file_search` vs `fs_search`、`file_delete` vs")
        A("   `fs_rm`(按 id 操作 vs 按路径操作,是真实产品里最易混的一对)")
        A("2. **同族近义兄弟** —— `<期望工具>_raw` / `_export` / `_history` / `_preview` ...")
        A("")
        A("| 指标 | English | Chinese |")
        A("|---|---|---|")
        en_t, cn_t = tr(pos_en), tr(pos_cn)
        en_trap = sum(r.picked_distractor for r in pos_en)
        cn_trap = sum(r.picked_distractor for r in pos_cn)
        A(f"| 工具正确率 | {rate(pos_en,'correct'):.0%} ({agg(pos_en,'correct')}/{en_t}) "
          f"| {rate(pos_cn,'correct'):.0%} ({agg(pos_cn,'correct')}/{cn_t}) |")
        A(f"| **选了干扰项** | {en_trap}/{en_t} ({en_trap/max(1,en_t):.0%}) "
          f"| {cn_trap}/{cn_t} ({cn_trap/max(1,cn_t):.0%}) |")
        A(f"| 其他错误(选别的/不调用/HTTP 失败) | "
          f"{en_t-agg(pos_en,'correct')-en_trap}/{en_t} "
          f"| {cn_t-agg(pos_cn,'correct')-cn_trap}/{cn_t} |")
        A("")
        A(f"> 合计被诱导 **{trapped}** / {pos_t_all} 次。同族后缀变体与期望工具描述几乎")
        A(f"> 同义、只差名字;跨 service 混淆对(file/fs)则是真实产品里最易混的一组。")
        A(f"> 被诱导的次数越多,基线分数里「词形匹配」的成分越重。")
        A("")
        A("> **读法**:「选了干扰项」= 模型被近义兄弟**诱导**走了。")
        A("> 这与「本来就乱选」是两回事 —— 前者说明分数主要来自词法匹配(虚高),")
        A("> 后者说明模型连大致方向都没有。")
        A(">")
        A("> 判读:与无干扰基线(`--distractors 0`)对比,正确率下降幅度即为**虚高幅度**。")
        A("> 两组都跑一遍即可量化。")
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
                 ts: str, health: dict | None, desc_lang: str, n_tools: int,
                 n_distractors: int = 0) -> int:
    rendered = render_report(results, url, trials, ts, health, desc_lang, n_tools,
                             n_distractors)
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
    ap.add_argument("--distractors", type=int, default=0, metavar="N",
                    help="每个 case 注入 N 个近义干扰工具(默认 0)。"
                         "用于量化'词法匹配虚高' —— 加干扰后正确率的下降幅度即为虚高")
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
                         blob.get("descLang", "cn"), blob.get("toolCount", 0),
                         blob.get("distractors", 0))
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
                r = run_case(base_url, case, lang, tools, args.trials, args.timeout,
                             args.distractors, args.desc_lang)
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
            "distractors": args.distractors,
            "trialsPerCase": args.trials, "rounds": args.rounds,
            "effectiveTrialsPerCase": eff,
            "methodology": f"{len(tools)} 个 etscli 工具直出;工具名精确匹配判定;"
                           "语料源自 `etscli <service> --help` 真实命令表;"
                           f"干扰项 {args.distractors}/case",
            "tools": tools,
            "results": [asdict(r) for r in results],
        }, f, ensure_ascii=False, indent=2)

    n = write_report(os.path.join(out_dir, "report.md"), results, base_url,
                     eff, ts, health, args.desc_lang, len(tools), args.distractors)
    print("")
    print(f"  报告: {out_dir}/report.md ({n} 字节)")
    if viol:
        return 2
    return 0 if all(r.correct == r.trials for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
