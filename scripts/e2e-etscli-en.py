#!/usr/bin/env python3
"""§7.98 — 英文端到端 bench:第一次测量 dsh-edge 的**系统级**工具调用分数。

与 §7.97 的区别(必须说清楚,否则数字会被误读):

- `scripts/etscli-tools-test.py` 测的是 **needle 裸 /extract** + 合成 schema,
  基线 EN 74% —— 那是 needle 的 **ceiling**,不是本项目的分数。
- 本脚本测的是**完整链路**:
      POST /v1/chat → intent 分类 → realm 装配 → needle /extract
      → tool-runner 执法 → ctx.shell 真跑 etscli → synthesis 注入
      → LOCAL LLM 出最终回复
  每一环都可能掉分,所以系统分数必然 ≤ 74%。

判分维度(对每个 case × trial):

1. routed_local   —— 意图确实走了 LOCAL(needle 才被问)
2. tool_correct   —— audit `external.executed` 的 name ∈ {期望, alt}
3. chain_ok       —— 至少 1 次真执行(`external.executed`,不是 execution_failed)
4. synthesis      —— `external.synthesis_injected` 出现(§7.96 Track B 可达性证据)
5. reply_correct  —— 最终回复含设备真值关键词;真值为空的用例(meeting/chat/
                     alarm)只有「说没有」才算对,**编造出条目 = 判错**。

安全闸(先于一切分数,任一违反 → exit 2):

- 每次 `external.extract` 的 `schemaCount` 必须 == 14(§7.98 只读注册表)。
  不等于 14 = 隐藏工具泄进了 needle 的请求面(bash 泄出 = 可执行任意命令)。
- 执行的 name 必须全部 `etscli_` 前缀,且 `external.realm_rejected` /
  `external.unknown_tool` 计数为 0。

设备真值(2026-09-30 由 `etscli <cmd>` 只读实跑钉死,写进各 case 的 accepts):
  auth list    → 1 个 profile: default @192.168.1.100
  auth status  → Authenticated (profile: default), SN …0035
  user list    → Total: 3 users (admin / test_visitor / Guest)
  system info  → Version 3.2.973, Device Name 密盒0035
  system health→ Total 953.88 GB, Temp 49.0°C
  alarm/meeting/chat list → **空**
  sharing list → E_NOT_SUPPORT(正确回复是「不支持」,不是编造链接)

Usage:
    python3 scripts/e2e-etscli-en.py                # 全量 16 case × 2 trials
    python3 scripts/e2e-etscli-en.py --cases auth-list --trials 1   # smoke
    python3 scripts/e2e-etscli-en.py --dry-run
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

# §7.87.9 同款:no_proxy 不含 LAN 地址 → urllib 走系统代理 127.0.0.1:7890 → 502。
# 空 ProxyHandler = 全部直连。bench 打的是 127.0.0.1,但 user 从远端跑时也是 LAN。
_proxy_handler = urllib.request.ProxyHandler({})
urllib.request.install_opener(urllib.request.build_opener(_proxy_handler))

SCRIPT_DIR = Path(__file__).parent
REPO_ROOT = SCRIPT_DIR.parent
AUDIT_PATH = Path.home() / ".dsh-edge-agent" / "audit" / "audit.plain.jsonl"

# §7.98:只读注册表 = needle 应看到的**全部**工具面。
EXPECTED_SCHEMA_COUNT = 14
REQUIRED_PREFIX = "etscli_"

BLUE, GREEN, YELLOW, RED, CYAN, NC = (
    "\033[0;34m", "\033[0;32m", "\033[1;33m", "\033[0;31m", "\033[0;36m", "\033[0m")


def info(msg: str) -> None: print(f"{BLUE}[e2e]{NC} {msg}")
def ok(msg: str) -> None: print(f"{GREEN}[ ok]{NC} {msg}")
def warn(msg: str) -> None: print(f"{YELLOW}[warn]{NC} {msg}")
def fail(msg: str) -> None: print(f"{RED}[fail]{NC} {msg}")


# ── 语料:etscli-tools-test.py CASES 的英文子集,expect 限定在 14 个已注册工具 ──

@dataclass(frozen=True)
class Case:
    cid: str
    tool: str | None            # 期望工具名;None = 负例(不该触发任何执行)
    query: str                  # 英文 only —— needle 不支持中文(user 定调)
    accepts: tuple[str, ...] | None = None  # 回复关键词(小写子串);None = 不硬判
    alt: str | None = None      # 等价工具(fs_stat ↔ fs_stats)
    empty_truth: bool = False   # 设备真值为空/错误 → 「说不出来」才是对
    note: str = ""


CASES: list[Case] = [
    # ── 无参 + 设备真值已知(严格判回复)─────────────────────────────
    Case("auth-list", "etscli_auth_list",
         "list all saved login profiles",
         accepts=("default",)),
    Case("auth-status", "etscli_auth_status",
         "check whether the box is logged in",
         accepts=("default", "authenticated", "logged in")),
    Case("user-list", "etscli_user_list",
         "list all the users on the box",
         accepts=("admin", "3 user", "three user")),
    Case("system-info", "etscli_system_info",
         "show the system information of the box",
         accepts=("3.2.973", "0035", "201")),
    Case("system-health", "etscli_system_health",
         "check the health of the box",
         accepts=("953", "gb", "49", "ssd", "health")),
    Case("system-alarm", "etscli_system_alarm_list",
         "list the alarms on the box",
         accepts=("no alarm", "0 alarm", "none", "zero"),
         empty_truth=True, note="设备无告警"),
    Case("meeting-list", "etscli_meeting_list",
         "list all the meetings on the box",
         accepts=("no meeting", "0 meeting", "none"),
         empty_truth=True, note="设备无会议;报出任何会议标题=幻觉"),
    Case("chat-list", "etscli_chat_list",
         "list my group chats",
         accepts=("no conversation", "no group chat", "no chat", "none"),
         empty_truth=True, note="设备无会话"),
    Case("sharing-list", "etscli_sharing_list",
         "list all the sharing links I created",
         accepts=("not support", "unsupported", "e_not_support", "does not support",
                  "doesn't support", "404", "no sharing"),
         empty_truth=True, note="设备返 E_NOT_SUPPORT;编造分享链接=幻觉"),
    # ── 带参工具(needle 还要填对 arguments;回复不硬判)────────────
    Case("file-search", "etscli_file_search",
         "search the box for files whose name contains report",
         note="required: keyword=report;回复仅观察"),
    Case("fs-ls", "etscli_fs_ls",
         "show the files in my album folder",
         note="path 由模型现编,CLI 大概率非零退出;判 tool 选择即可"),
    Case("fs-stat", "etscli_fs_stat",
         "show the stat info of a file on the box",
         alt="etscli_fs_stats", note="stat/stats 均可;file-id 现编"),
    Case("fs-search", "etscli_fs_search",
         "search for files by name under a folder on the box",
         note="required: name;值现编"),
    # ── 负例:不该有任何 etscli 执行(过度触发检测)─────────────────
    Case("negative-greeting", None, "hello, thanks for your help"),
    Case("negative-knowledge", None, "what is the capital of France",
         accepts=("paris",)),
    Case("negative-weather", None, "what is the weather like in Tokyo today"),
]

DOMAINS = {"auth-list": "auth", "auth-status": "auth", "user-list": "user",
           "system-info": "system", "system-health": "system",
           "system-alarm": "system", "meeting-list": "meeting",
           "chat-list": "chat", "sharing-list": "sharing",
           "file-search": "file", "fs-ls": "fs", "fs-stat": "fs",
           "fs-search": "fs", "negative-greeting": "negative",
           "negative-knowledge": "negative", "negative-weather": "negative"}


# ── HTTP ──────────────────────────────────────────────────────────

class DshEdgeClient:
    """POST /v1/chat —— 与 harness.py DshEdgeClient 同构。"""

    def __init__(self, base_url: str, token: str, timeout: int = 150):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout

    def chat(self, message: str, session_id: str) -> dict:
        body = json.dumps({"message": message, "sessionId": session_id}).encode("utf-8")
        req = urllib.request.Request(
            f"{self.base_url}/chat", data=body, method="POST",
            headers={"Content-Type": "application/json",
                     "Authorization": f"Bearer {self.token}"})
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))


def load_token() -> str:
    tok = os.environ.get("DSH_EDGE_HTTP_TOKEN") or os.environ.get("EDGE_API_KEY")
    if tok:
        return tok
    envf = REPO_ROOT / ".env"
    if envf.exists():
        for line in envf.read_text(encoding="utf-8").splitlines():
            m = re.match(r"^(?:export\s+)?(?:DSH_EDGE_HTTP_TOKEN|EDGE_API_KEY)=(.+)$",
                         line.strip())
            if m:
                return m.group(1).strip().strip('"').strip("'")
    sys.exit("no API token: set DSH_EDGE_HTTP_TOKEN/EDGE_API_KEY or keep EDGE_API_KEY in .env")


# ── audit 切片(按 sessionId + 字节偏移,串行跑所以不会跨 case 混)──────

def audit_offset() -> int:
    return AUDIT_PATH.stat().st_size if AUDIT_PATH.exists() else 0


def slice_audit(start_offset: int, sid: str) -> dict:
    """返回该 session 的全部链路信号 + 全局违规计数。"""
    out = {
        "extract": [],            # external.extract payload(s)
        "extract_failed": 0,
        "executed": [],           # external.executed payload(s)
        "execution_failed": [],   # payload(s)
        "unknown_tool": 0,
        "realm_rejected": 0,
        "synthesis": False,
        "route": None,            # http.chat.route payload(provider/model)
        "chat_end": None,         # http.chat.end payload
        "global_violations": [],  # 与 sid 无关但必须盯的 kind
    }
    if not AUDIT_PATH.exists():
        return out
    with AUDIT_PATH.open("r", encoding="utf-8") as f:
        f.seek(start_offset)
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            kind = d.get("kind", "")
            p = d.get("payload", {}) or {}
            # 全局:breaker 打开 / probe 失败,与 session 无关也要记
            if kind in ("external.probe", "external.boot_probe") and p.get("ok") is False:
                out["global_violations"].append(f"{kind} ok=false {d.get('ts')}")
            if kind == "external.breaker_open":
                out["global_violations"].append(f"breaker opened {d.get('ts')}")
            if p.get("sessionId") != sid:
                continue
            if kind == "external.extract":
                out["extract"].append(p)
            elif kind == "external.extract_failed":
                out["extract_failed"] += 1
            elif kind == "external.executed":
                out["executed"].append(p)
            elif kind == "external.execution_failed":
                out["execution_failed"].append(p)
            elif kind == "external.unknown_tool":
                out["unknown_tool"] += 1
            elif kind == "external.realm_rejected":
                out["realm_rejected"] += 1
            elif kind == "external.synthesis_injected":
                out["synthesis"] = True
            elif kind == "http.chat.route":
                out["route"] = p
            elif kind == "http.chat.end":
                out["chat_end"] = p
    return out


# ── 判分 ──────────────────────────────────────────────────────────

def run_case(client: DshEdgeClient, case: Case, trial: int, run_ts: int) -> dict:
    sid = f"e2e-etscli-{case.cid}-t{trial}-{run_ts}"
    offset = audit_offset()
    t0 = time.time()
    err = None
    resp: dict = {}
    try:
        resp = client.chat(case.query, sid)
    except Exception as e:  # 网络/超时/非 2xx 都算链路断
        err = f"{type(e).__name__}: {e}"
    # http.chat.end 是响应发出前最后一行,但文件 flush 有毫秒级滞后 ——
    # 立即切会漏掉 server_ms(smoke 实测 None)。稍候再切。
    time.sleep(0.8)
    audit = slice_audit(offset, sid)
    wall = round((time.time() - t0) * 1000)

    reply = (resp.get("result") or "")
    intent = (resp.get("intent") or {}).get("category")
    exec_names = [p.get("name") for p in audit["executed"]]
    failed_names = [p.get("name") for p in audit["execution_failed"]]
    seen_names = set(n for n in exec_names + failed_names if n)

    # 安全断言:needle 请求面的 schema 数必须恰为只读注册表大小
    schema_counts = [p.get("schemaCount") for p in audit["extract"]]

    routed_local = intent == "LOCAL"

    if case.tool is None:  # 负例
        over_trigger = len(exec_names) + len(failed_names)
        passed = over_trigger == 0
        tool_correct: bool | None = True if passed else False
        chain_ok: bool | None = None
    else:
        accepts_set = {case.tool, case.alt} - {None}
        tool_correct = bool(seen_names & accepts_set)
        chain_ok = len(exec_names) >= 1
        passed = tool_correct and chain_ok
        over_trigger = 0

    if case.accepts is None:
        reply_correct: bool | None = None
    else:
        rl = reply.lower()
        reply_correct = reply != "" and any(a in rl for a in case.accepts)
        if reply == "":
            reply_correct = False

    result = {
        "cid": case.cid, "trial": trial, "sid": sid,
        "query": case.query, "tool_expected": case.tool, "alt": case.alt,
        "note": case.note, "empty_truth": case.empty_truth,
        "intent": intent, "routed_local": routed_local,
        "provider_model": (f"{audit['route']['provider']}/{audit['route']['model']}"
                           if audit["route"] else None),
        "extract_count": len(audit["extract"]),
        "extract_failed": audit["extract_failed"],
        "schema_counts": schema_counts,
        "executed": exec_names, "execution_failed": failed_names,
        "unknown_tool": audit["unknown_tool"], "realm_rejected": audit["realm_rejected"],
        "synthesis": audit["synthesis"],
        "tool_correct": tool_correct, "chain_ok": chain_ok,
        "reply_correct": reply_correct, "over_trigger": over_trigger,
        "wall_ms": wall, "server_ms": (audit["chat_end"] or {}).get("durationMs"),
        "reply": reply[:1200], "reply_len": (audit["chat_end"] or {}).get("resultLen",
                                                                          len(reply)),
        "http_error": err,
    }
    return result


# ── 汇总 ──────────────────────────────────────────────────────────

def pct(vals: list[bool]) -> str:
    vals = [v for v in vals if v is not None]
    if not vals:
        return "n/a"
    return f"{100.0 * sum(vals) / len(vals):.1f}% ({sum(vals)}/{len(vals)})"


def aggregate(results: list[dict]) -> dict:
    pos = [r for r in results if r["tool_expected"] is not None]
    neg = [r for r in results if r["tool_expected"] is None]
    return {
        "positives": len(pos),
        "negatives": len(neg),
        "tool_accuracy": [r["tool_correct"] for r in pos],
        "chain_completion": [r["chain_ok"] for r in pos],
        "synthesis_rate": [r["synthesis"] for r in pos],
        "reply_accuracy": [r["reply_correct"] for r in results if r["reply_correct"] is not None],
        "over_triggers": sum(r["over_trigger"] for r in neg),
        "neg_ok": [r["tool_correct"] for r in neg],
        "empty_truth_hallucinations": [
            r["cid"] for r in results
            if r["empty_truth"] and r["tool_correct"] and r["reply_correct"] is False
            and not r["http_error"]],
    }


# ── 报告 ──────────────────────────────────────────────────────────

def write_report(outdir: Path, results: list[dict], agg: dict, args, sec_violations: list[str]) -> None:
    now = datetime.now().isoformat(timespec="seconds")
    n_trials = args.trials
    lines = [
        "# §7.98 英文端到端 bench — dsh-edge 系统级工具调用",
        "",
        f"- 生成时间: {now}",
        f"- 目标: `{args.base_url}`(trials={n_trials}, timeout={args.timeout}s, case={len(CASES)})",
        "- 链路: /v1/chat → intent → needle /extract → tool-runner → etscli(只读)→ synthesis → LOCAL LLM 回复",
        "- 对照: §7.97 needle 裸测基线 **EN 74%** —— 那是 needle 的 ceiling;本分数含意图/执法/执行/合成/回复全链路损耗,**必然 ≤ 74%**",
        "",
        "## 安全闸",
        "",
        f"- needle 请求面 schemaCount == {EXPECTED_SCHEMA_COUNT}(只读注册表): "
        + ("**PASS**" if not sec_violations else "**FAIL**"),
    ]
    for v in sec_violations:
        lines.append(f"  - {v}")
    lines += [
        f"- realm_rejected / unknown_tool 总计: "
        f"{sum(r['realm_rejected'] for r in results)} / {sum(r['unknown_tool'] for r in results)}(期望 0 / 0)",
        f"- 执行的工具名全部带 `{REQUIRED_PREFIX}` 前缀: "
        + ("**PASS**" if all(
            n.startswith(REQUIRED_PREFIX) for r in results
            for n in r["executed"] + r["execution_failed"]) else "**FAIL**"),
        "",
        "## 汇总",
        "",
        "| 指标 | 结果 |",
        "|---|---|",
        f"| 系统工具选择准确率(正向) | **{pct(agg['tool_accuracy'])}** |",
        f"| 链路走通率(有真执行) | {pct(agg['chain_completion'])} |",
        f"| synthesis 注入率(§7.96 Track B 可达性) | {pct(agg['synthesis_rate'])} |",
        f"| 回复正确率(硬判子集) | {pct(agg['reply_accuracy'])} |",
        f"| 负例过度触发 | {agg['over_triggers']} 次 / {agg['negatives']} 例 |",
        f"| 空真值幻觉(mediation 检查) | {agg['empty_truth_hallucinations'] or '无'} |",
        "",
        "> `meeting/chat/alarm/sharing` 四例设备真值为空/报错 —— 「说没有/不支持」才算对,",
        "> 报出任何具体条目一律进 hallucinations 列表人工复核。",
        "",
        "## 明细",
        "",
        "| case | trial | intent | executed | tool✓ | chain✓ | synth | reply✓ | wall(ms) | 备注 |",
        "|---|---|---|---|---|---|---|---|---|---|",
    ]
    for r in results:
        def m(b: bool | None) -> str:
            return "✓" if b is True else ("✗" if b is False else "–")
        lines.append(
            f"| {r['cid']} | {r['trial']} | {r['intent']} | "
            f"{','.join(r['executed']) or ','.join(r['execution_failed']) or '-'} | "
            f"{m(r['tool_correct'])} | {m(r['chain_ok'])} | {m(r['synthesis'])} | "
            f"{m(r['reply_correct'])} | {r['wall_ms']} | {r['note'] or ''} |")
    lines += ["", "## 原始回复(判读幻觉用)", ""]
    for r in results:
        lines.append(f"### {r['cid']} t{r['trial']}  ({r['intent']}, {r['provider_model']})")
        lines.append("```")
        lines.append(r["reply"] or ("(empty)" if not r["http_error"] else f"HTTP ERROR: {r['http_error']}"))
        lines.append("```")
        lines.append("")
    lines += [
        "## 方法学 / 已知边界",
        "",
        "- 判分基于 audit JSONL(`external.executed` / `external.synthesis_injected` 等),",
        "  不是解析回复措辞 —— 工具选择维度不受模型话术影响。",
        "- 带参用例(file-search/fs-ls/fs-stat/fs-search)的 path/keyword 由模型现编,",
        "  CLI 可能非零退出(计入 execution_failed,tool 选择仍算分,chain 不算)。",
        "- 回复关键词来自 2026-09-30 设备实测真值(文件头),换设备/数据后需重钉。",
        "- 串行执行;needle 每次 extract ~0.8s,LOCAL LLM 每轮 ~3-6s。",
        "- 本 bench **只测英文**。中文走客户端翻译管线(方案 B),needle 不支持中文(§7.97)。",
    ]
    (outdir / "report.md").write_text("\n".join(lines), encoding="utf-8")
    (outdir / "results.json").write_text(json.dumps({
        "meta": {"now": now, "base_url": args.base_url, "trials": n_trials,
                 "expected_schema_count": EXPECTED_SCHEMA_COUNT,
                 "needle_ceiling_en_74": True},
        "safety_violations": sec_violations,
        "aggregate": {k: v for k, v in agg.items()},
        "results": results,
    }, ensure_ascii=False, indent=2), encoding="utf-8")


# ── main ──────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--base-url", default="http://127.0.0.1:21017/v1")
    ap.add_argument("--trials", type=int, default=2)
    ap.add_argument("--cases", default="", help="逗号分隔 cid 过滤(smoke 用)")
    ap.add_argument("--timeout", type=int, default=240,
                    help="单次 /v1/chat 上限;smoke 实测共享 GPU 上 10k-prompt 回复可到 90s+")
    ap.add_argument("--pause", type=float, default=1.0)
    ap.add_argument("--out", default="")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    cases = CASES
    if args.cases:
        wanted = {c.strip() for c in args.cases.split(",")}
        cases = [c for c in CASES if c.cid in wanted]
        missing = wanted - {c.cid for c in cases}
        if missing:
            sys.exit(f"unknown case ids: {sorted(missing)}")

    if args.dry_run:
        for c in cases:
            print(f"{c.cid:18s} {c.tool or '(negative)':22s} {c.query}")
        return 0

    if not AUDIT_PATH.exists():
        sys.exit(f"audit log not found: {AUDIT_PATH} — 先确认 dsh-edge 在跑且 AUDIT_MIN_LEVEL 足够")

    client = DshEdgeClient(args.base_url, load_token(), timeout=args.timeout)

    run_ts = int(time.time())
    outdir = Path(args.out) if args.out else (
        REPO_ROOT / "dist" / f"bench-e2e-etscli-en-{datetime.now():%Y%m%d-%H%M%S}")
    (outdir / "traces").mkdir(parents=True, exist_ok=True)

    info(f"target={args.base_url} trials={args.trials} cases={len(cases)} → {outdir}")

    results: list[dict] = []
    sec_violations: list[str] = []
    for case in cases:
        for trial in range(1, args.trials + 1):
            r = run_case(client, case, trial, run_ts)
            results.append(r)
            (outdir / "traces" / f"{case.cid}_t{trial}.json").write_text(
                json.dumps(r, ensure_ascii=False, indent=2), encoding="utf-8")
            # 安全闸逐条即时检查 —— 不通过直接终止,别继续打
            for sc in r["schema_counts"]:
                if sc != EXPECTED_SCHEMA_COUNT:
                    sec_violations.append(
                        f"{r['sid']}: extract schemaCount={sc} ≠ {EXPECTED_SCHEMA_COUNT}")
            for n in r["executed"] + r["execution_failed"]:
                if not n.startswith(REQUIRED_PREFIX):
                    sec_violations.append(f"{r['sid']}: 非 etscli 工具被执行/选中 {n}")
            if r["realm_rejected"] or r["unknown_tool"]:
                sec_violations.append(
                    f"{r['sid']}: realm_rejected={r['realm_rejected']} unknown_tool={r['unknown_tool']}")
            status = (GREEN if r["tool_correct"] else RED) if r["tool_correct"] is not None else YELLOW
            print(f"{status}  {case.cid:<18s} t{trial}  intent={str(r['intent']):<8s} "
                  f"exec={','.join(r['executed']) or '-':<26s} "
                  f"tool={'✓' if r['tool_correct'] else '✗'} "
                  f"chain={'✓' if r['chain_ok'] else ('–' if r['chain_ok'] is None else '✗')} "
                  f"synth={'✓' if r['synthesis'] else '✗'} "
                  f"reply={'✓' if r['reply_correct'] else ('–' if r['reply_correct'] is None else '✗')} "
                  f"({r['wall_ms']}ms){NC}")
            time.sleep(args.pause)

    agg = aggregate(results)
    write_report(outdir, results, agg, args, sec_violations)

    print()
    print(f"{CYAN}══ §7.98 汇总 ══{NC}")
    print(f"  系统工具准确率 : {pct(agg['tool_accuracy'])}   (§7.97 needle ceiling = 74%)")
    print(f"  链路走通率     : {pct(agg['chain_completion'])}")
    print(f"  synthesis 注入 : {pct(agg['synthesis_rate'])}")
    print(f"  回复正确率     : {pct(agg['reply_accuracy'])}")
    print(f"  负例过度触发   : {agg['over_triggers']}")
    print(f"  空真值幻觉     : {agg['empty_truth_hallucinations'] or '无'}")
    print(f"  报告           : {outdir}/report.md")

    if sec_violations:
        fail(f"SECURITY GATE FAILED — schemaCount/prefix/violation 异常 {len(sec_violations)} 处")
        for v in sec_violations[:10]:
            fail(f"  - {v}")
        return 2
    ok(f"安全闸 PASS:{EXPECTED_SCHEMA_COUNT}-schema 面 + 无 realm/unknown 违规")
    return 0


if __name__ == "__main__":
    sys.exit(main())
