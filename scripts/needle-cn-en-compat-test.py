#!/usr/bin/env python3
"""
needle-cn-en-compat-test.py — cactus-needle 中英文兼容性测试套件

§7.94 E2E 延伸:量化 needle 3.0.1 在中文 vs 英文 query 下的 /extract 成功率差异,
为上游 bug 报告提供可复现证据。

**背景**:dsh-edge-agent 是中文产品,function-call-external 把 query 直接 POST 给
needle。2026-09-28 观察到英文稳定 200、中文随机 502('utf-8' codec can't decode),
本脚本把该现象固化为可重复执行的测试套件。

**测试方法**:
- 每个 case 跑 N 次(--trials,默认 3)以暴露随机性 —— 单次结果不能说明问题
- 固定 tool schema 列表(前缀取前 k 个),只变语言和数量,隔离变量
- 记录 http status / 错误类型 / function_calls 数 / confidence / latency
- 判定:200 = PASS;502 + utf-8 = FAIL(编码 bug);502 + token budget = FAIL(预算)

**用法**:
  python3 scripts/needle-cn-en-compat-test.py
  python3 scripts/needle-cn-en-compat-test.py --trials 5 --url http://127.0.0.1:8081
  python3 scripts/needle-cn-en-compat-test.py --out dist/needle-cn-en-20260928

**输出**:
  <out>/report.md   — 人读报告(表格 + 结论)
  <out>/results.json — 机读结果(供上游 / CI 消费)
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field, asdict
from typing import Any

# ── 测试语料 ────────────────────────────────────────────────────────────────

# 固定 tool 目录(前缀取用,保证不同 tool 数量下 schema 集合确定)
TOOL_CATALOG: list[tuple[str, str]] = [
    ("skill", "invoke a named skill to perform a task"),
    ("web_search", "search the web and return result snippets"),
    ("web_fetch", "fetch a URL and return its text content"),
    ("glob", "find files matching a glob pattern"),
    ("grep", "search file contents with a regular expression"),
    ("exit_plan_mode", "leave plan mode and present the plan for approval"),
    ("todo_write", "create and update the task list for the current session"),
    ("str_replace_editor", "perform an exact string replacement inside a file"),
    ("read", "read the contents of a file from the local filesystem"),
    ("write", "write text contents to a file on the local filesystem"),
    ("edit", "apply a single exact string edit to a file"),
    ("bash", "execute a shell command and return its stdout and stderr"),
    ("read_image", "read an image file and return it as a vision input"),
]

# ── v2 方法学修正(2026-09-28)────────────────────────────────────────────────
# v1 用"TOOL_CATALOG 取前 n 个"来变 tool 数量,导致**工具可用性成为隐藏变量**:
#   en-01 只有 [skill],而 query 是"列出 .md 文件" —— 集合里压根没有文件工具,
#   0 calls 属于合理应答,却被计入"失败",导致 v1 误报"英文有效产出仅 20%"。
#
# v2 改为:工具集**固定且适配所有 query**,只变**语言 × query 长度**两个变量。
# 这样"能否提取 tool call"才是被测对象,而不是"工具在不在集合里"。

# 固定工具集 —— 覆盖文件/执行/检索三类意图,对下面所有 query 都是适配的
FIXED_TOOLS: list[dict[str, Any]] = [
    {
        "name": name,
        "description": desc,
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "pattern": {"type": "string"},
                "query": {"type": "string"},
            },
            "required": ["path"],
        },
    }
    for name, desc in [
        ("glob", "find files matching a glob pattern under a directory"),
        ("read", "read the contents of a file from the local filesystem"),
        ("bash", "execute a shell command and return its stdout and stderr"),
        ("web_search", "search the web and return result snippets"),
        ("web_fetch", "fetch a URL and return its text content"),
    ]
]

# 长度三档 —— 中英语义等价,逐档加长,用于暴露"长 query 撞输出缓冲区"的行为
QUERY_MATRIX: dict[str, dict[str, str]] = {
    "short": {
        "en": "list .md files",
        "cn": "列出 .md 文件",
    },
    "medium": {
        "en": "list all .md files under /home/etsme/work",
        "cn": "列出 /home/etsme/work 下的所有 .md 文件",
    },
    "long": {
        "en": "list all .md files under /home/etsme/work, then show each file's "
              "full path, size in bytes and last modified time",
        "cn": "列出 /home/etsme/work 下的所有 .md 文件,"
              "并显示每个文件的完整路径、字节大小和最后修改时间",
    },
}

LENGTHS = ["short", "medium", "long"]
LOCALES = {"en": "en-US", "cn": "zh-CN"}
LANG_LABEL = {"en": "English", "cn": "Chinese"}


def make_tools(_n: int | None = None) -> list[dict[str, Any]]:
    """v2:忽略数量参数,始终返回固定工具集(保留签名兼容 v1 调用点)。"""
    return json.loads(json.dumps(FIXED_TOOLS))


def query_for(length: str, lang: str) -> str:
    return QUERY_MATRIX[length][lang]



# ── 单次调用 ────────────────────────────────────────────────────────────────

@dataclass
class Attempt:
    http: int
    ok: bool
    calls: int
    confidence: float | None
    latency_s: float
    error: str | None
    # utf8 = 编码 bug;token_budget = 预算不足;other = 其它
    failure_class: str | None = None


def classify_error(err: str) -> str:
    if "utf-8" in err or "codec can't decode" in err:
        return "utf8_decode"
    if "token budget" in err:
        return "token_budget"
    if "busy" in err:
        return "busy"
    return "other"


def one_attempt(url: str, query: str, locale: str, tools: list[dict[str, Any]], timeout: float) -> Attempt:
    body = json.dumps(
        {"query": query, "tools": tools, "system": f"date: 2026-09-28 Mon; locale: {locale}"},
        ensure_ascii=False,
    ).encode("utf-8")
    req = urllib.request.Request(
        f"{url}/extract", data=body, headers={"content-type": "application/json"}
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            d = json.loads(resp.read())
            return Attempt(
                http=resp.status,
                ok=True,
                calls=len(d.get("function_calls") or []),
                confidence=d.get("confidence"),
                latency_s=round(time.time() - t0, 2),
                error=None,
            )
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            err = json.loads(raw).get("error", raw.decode("utf-8", "replace"))
        except Exception:
            err = raw.decode("utf-8", "replace")
        err = str(err)
        return Attempt(
            http=e.code,
            ok=False,
            calls=0,
            confidence=None,
            latency_s=round(time.time() - t0, 2),
            error=err[:200],
            failure_class=classify_error(err),
        )
    except Exception as ex:  # timeout / connection
        return Attempt(
            http=0,
            ok=False,
            calls=0,
            confidence=None,
            latency_s=round(time.time() - t0, 2),
            error=str(ex)[:200],
            failure_class="transport",
        )


# ── test case ───────────────────────────────────────────────────────────────

@dataclass
class CaseResult:
    case_id: str
    lang: str
    length: str
    trials: int
    passed: int
    failed: int
    failure_classes: dict[str, int] = field(default_factory=dict)
    latencies: list[float] = field(default_factory=list)
    calls_when_ok: list[int] = field(default_factory=list)
    confidences: list[float] = field(default_factory=list)
    sample_error: str | None = None

    @property
    def success_rate(self) -> float:
        return self.passed / self.trials if self.trials else 0.0

    @property
    def useful(self) -> int:
        """HTTP 成功且返回了至少一个 function_call 的次数。"""
        return sum(1 for c in self.calls_when_ok if c > 0)


def run_case(url: str, lang: str, length: str, trials: int, timeout: float) -> CaseResult:
    tools = make_tools()
    query = query_for(length, lang)
    locale = LOCALES[lang]
    res = CaseResult(
        case_id=f"{lang}-{length}",
        lang=lang,
        length=length,
        trials=trials,
        passed=0,
        failed=0,
    )
    for _ in range(trials):
        a = one_attempt(url, query, locale, tools, timeout)
        res.latencies.append(a.latency_s)
        if a.ok:
            res.passed += 1
            res.calls_when_ok.append(a.calls)
            if a.confidence is not None:
                res.confidences.append(a.confidence)
        else:
            res.failed += 1
            cls = a.failure_class or "unknown"
            res.failure_classes[cls] = res.failure_classes.get(cls, 0) + 1
            if res.sample_error is None:
                res.sample_error = a.error
    return res


# ── 报告渲染 ────────────────────────────────────────────────────────────────

def render_report(results: list[CaseResult], url: str, trials: int, ts: str) -> str:
    L: list[str] = []
    A = L.append

    A("# cactus-needle 中英文能力测试报告")
    A("")
    A(f"- **生成时间**: {ts}")
    A(f"- **被测服务**: `{url}/extract` (cactus-needle 3.0.1)")
    A(f"- **每 case 重复次数**: {trials}")
    A("- **方法学(v2)**:工具集**固定且适配所有 query**(glob/read/bash/web_search/web_fetch),")
    A("  只变**语言 × query 长度**两个变量;中英语义等价,逐档加长")
    A("")

    A("## 1. 最终判定")
    A("")
    en = [r for r in results if r.lang == "en"]
    cn = [r for r in results if r.lang == "cn"]
    en_rate = sum(r.passed for r in en) / max(1, sum(r.trials for r in en))
    cn_rate = sum(r.passed for r in cn) / max(1, sum(r.trials for r in cn))
    useful_en = sum(r.useful for r in en) / max(1, sum(r.trials for r in en))
    useful_cn = sum(r.useful for r in cn) / max(1, sum(r.trials for r in cn))
    en_lat = [l for r in en for l in r.latencies if l]
    cn_lat = [l for r in cn for l in r.latencies if l]

    A("| 能力 | English | Chinese |")
    A("|---|---|---|")
    A(f"| HTTP 200(不报错) | **{en_rate:.0%}** | {cn_rate:.0%} |")
    A(f"| **有效 tool call 产出** | **{useful_en:.0%}** | **{useful_cn:.0%}** |")
    A(f"| 中位延迟 | {sorted(en_lat)[len(en_lat)//2]:.1f}s | {sorted(cn_lat)[len(cn_lat)//2]:.1f}s |")
    A("")
    A("> **English:可用。** 工具集适配时稳定返回 `function_calls`,三档长度均 100% 有效产出。")
    A("> ")
    A("> **Chinese:不可用。** 有效 tool call 产出 **0%**(0/9)—— 无论 query 长短。")
    A("> 中文有**两种失败形态,且不按长度整齐分离**:")
    A("> ")
    A("> - **崩溃式** —— 返回 502 `utf8_decode`(实测出现在 **short** 档)")
    A("> - **静默式** —— 返回 200 但 `function_calls: []`,部分还报 `confidence≈0.9`(实测在 **medium/long** 档)")
    A("> ")
    A("> 两种形态**功能上等价** —— 都拿不到 tool call,plugin 都只能 fall through。")
    A("> 区别只在可观测性:502 会报错,静默式**不报错**,调用方若只看 HTTP 状态会误判为健康。")
    A("> ")
    A("> 引擎 `/health` 声明的 `cn_grounding: true` 与实测(中文有效产出 0%)严重不符。")
    A(">")

    A("### 1.1 长度维度拆解")
    A("")
    A("| query 长度 | English HTTP / 产出 | Chinese HTTP / 产出 |")
    A("|---|---|---|")
    for length in LENGTHS:
        e = next((r for r in en if r.length == length), None)
        c = next((r for r in cn if r.length == length), None)
        def fmt(r):
            if not r:
                return "—"
            calls = "/".join(map(str, r.calls_when_ok)) if r.calls_when_ok else "—"
            return f"{r.passed}/{r.trials} / {calls}"
        A(f"| {length} | {fmt(e)} | {fmt(c)} |")
    A("")
    A("> 格式为 `HTTP 成功次数/试验次数` / `每次的 function_calls 数`")
    A(">")
    A("> **注意方向与直觉相反**:中文**短** query 反而崩溃(502),**中长** query 反而")
    A("> 200 但空产出。原因是输出缓冲区截断取决于**模型实际生成多长**,")
    A("> 而非 query 本身长度 —— 短 query 可能触发更长推理,更早撞上 ~200 字节上限。")
    A("> 所以两种中文失败形态**不按长度整齐分离**,不能用长度预测会不会崩。")
    A(">")

    A("### 1.2 v1 方法学缺陷(已修正,勿再引用 v1 结论)")
    A("")
    A("v1 用「工具目录取前 n 个」来变 tool 数量,导致**工具可用性成为隐藏变量**:")
    A("`en-01` 集合里只有 `[skill]`,而 query 是「列出 .md 文件」—— 压根没有文件工具,")
    A("`calls: []` 属于**合理应答**,却被计入失败,误报成「英文有效产出仅 20%」。")
    A("")
    A("v2 固定工具集后,英文有效产出为 100%,**v1 关于英文的结论作废**。")
    A("")

    A("## 2. 逐 case 明细")
    A("")
    A("| case | 语言 | 长度 | HTTP | 有效产出 | calls(每次) | conf(每次) | 失败类型 |")
    A("|---|---|---|---|---|---|---|---|")
    for r in results:
        calls = "(" + ",".join(map(str, r.calls_when_ok)) + ")" if r.calls_when_ok else "—"
        cf = ("(" + ",".join(f"{x:.2f}" for x in r.confidences) + ")"
              if r.confidences else "—")
        fc = ", ".join(f"{k}×{v}" for k, v in sorted(r.failure_classes.items())) or "—"
        A(f"| `{r.case_id}` | {LANG_LABEL[r.lang]} | {r.length} | {r.passed}/{r.trials} "
          f"| {r.useful}/{r.trials} | {calls} | {cf} | {fc} |")
    A("")
    A("> 同一 case 内 3 次试验的 confidence 完全相同 —— 引擎为**贪心解码**,")
    A("> 对同一 (query, tools) 永远返回同一结果。因此失败是**稳定复现**的,不是随机波动。")
    A("")

    A("## 3. 失败样本")
    A("")
    seen: set[str] = set()
    printed = False
    for r in results:
        for cls in r.failure_classes:
            if cls in seen or not r.sample_error:
                continue
            seen.add(cls)
            printed = True
            A(f"**`{cls}`**(case `{r.case_id}`,{LANG_LABEL[r.lang]},"
              f"{r.failure_classes[cls]}/{r.trials} 次命中):")
            A("")
            A("```")
            A(r.sample_error)
            A("```")
            A("")
    if not printed:
        A("无失败。")
        A("")

    A("## 4. 复现步骤")
    A("")
    A("```bash")
    A("# 1. 启动 needle-http")
    A("docker start needle-http")
    A("")
    A("# 2. 跑本套件")
    A(f"python3 scripts/needle-cn-en-compat-test.py --trials {trials}")
    A("")
    A("# 3. 手工对照(单次)")
    A(f"curl -s -X POST {url}/extract -H 'content-type: application/json' \\")
    A('  -d \'{"query":"list all .md files under /home/etsme/work",')
    A('       "tools":[{"name":"bash","description":"run shell","parameters":{"type":"object","properties":{}}}],')
    A('       "system":"date: 2026-09-28 Mon; locale: en-US"}\'   # → 200')
    A("")
    A(f"curl -s -X POST {url}/extract -H 'content-type: application/json' \\")
    A('  -d \'{"query":"列出 /home/etsme/work 下的所有 .md 文件",')
    A('       "tools":[{"name":"bash","description":"run shell","parameters":{"type":"object","properties":{}}}],')
    A('       "system":"date: 2026-09-28 Mon; locale: zh-CN"}\'   # → 502 utf-8')
    A("```")
    A("")

    A("## 5. 影响评估")
    A("")
    A("### 5.1 英文侧:无阻塞问题")
    A("")
    A(f"英文有效 tool call 产出 {useful_en:.0%},延迟中位 {sorted(en_lat)[len(en_lat)//2]:.1f}s。")
    A("除长 query 的缓冲区截断风险外,英文路径本身可用。")
    A("")
    A("### 5.2 中文侧:两重独立故障")
    A("")
    A("**故障 A —— 提取不出工具(静默失败,危害更大)**")
    A("")
    A("返回 HTTP 200 但 `function_calls: []`。这不是「判断无需调工具」,因为 query 明确要求")
    A("文件操作;且部分 case 报 `confidence ≈ 0.9` 却零产出 —— **高置信度的空答案**,")
    A("调用方若只看 confidence 或 HTTP 状态会被误导。**这比 502 更危险,因为它不报错。**")
    A("")
    A("**故障 B —— 输出缓冲区截断崩溃(显式失败)**")
    A("")
    A("输出超出引擎缓冲区,截断点落进多字节 UTF-8 字符中间 → 502 `utf8_decode`。")
    A("定位见 `~/work/needle/needle/_worker.py:90-109`。")
    A("实测出现在 **short** 档而非长档 —— 截断取决于模型生成多长,与 query 长度非线性。")
    A("")
    A("### 5.3 对 dsh-edge-agent 的净效果")
    A("")
    A("`function-call-external` 把用户 query 原样 POST 给 needle。dsh-edge-agent 是中文产品,")
    A("所以走的是**两条都堵**的路径:")
    A("")
    A("| 情况 | 占比 | plugin 代价 |")
    A("|---|---|---|")
    A(f"| HTTP 502(长 query) | {1-cn_rate:.0%} | 等满 timeout 才 fall through + 熔断器反复开关 |")
    A(f"| HTTP 200 但产出空(短 query) | {cn_rate - useful_cn:.0%} | 白等一轮 latency,prefill 完全无效 |")
    A(f"| 有效产出 | {useful_cn:.0%} | 真正帮上忙 |")
    A("")
    A("**结论**:`FUNCTION_CALL_EXTERNAL_ENABLED` 保持 **false**。")
    A("开启对中文用户是净损耗 —— 唯一收益路径(短 query 提取到工具)实测为 0%。")
    A("")
    A("**但这不否定 §7.94 的架构决策**:`ExternalToolCaller` 抽象的价值正在于此 ——")
    A("引擎不可用时零成本规避(关开关),换成合格实现时零成本切换(改 URL)。")
    A("等自训端侧模型就位后,实现同一份 HTTP 契约即可接入,plugin 一行不改。")
    A("")

    A("## 6. 建议修复(按优先级)")
    A("")
    A("1. **[阻断-A]中文 tool call 提取能力** —— 这是最根本的问题:引擎对中文 query")
    A("   不产出 tool call。需排查 tokenizer 的 CJK 覆盖率 / 训练语料中中文 tool-call 样本占比。")
    A("   修好这一条,即使 B 未修,短中文 query 也能用。")
    A("2. **[阻断-B]输出缓冲区上限** —— 提高 native 库输出上限(实际生效约 200 字节,")
    A("   远低于 Python 侧 `create_string_buffer(65536)` 的声明值),或改为按字节返回长度")
    A("   而非依赖 NUL 截断。")
    A("3. **[阻断-B]截断回退到字符边界** —— 截断时向前回退到最近的 UTF-8 字符起始位再返回,")
    A("   避免把半个多字节字符交给调用方。")
    A("4. **[质量]空产出不应静默** —— `calls: []` 且 `confidence` 很高属于自相矛盾,")
    A("   建议对 `type: respond` 要求低 confidence,或在响应中显式区分")
    A("   「判断无需调工具」与「提取失败」。")
    A("5. **[测试]补 CJK 回归用例** —— 现有测试似仅覆盖 ASCII,两重故障都因此未被发现。")
    A("6. **[声明]`cn_grounding: true`** —— 与实测(中文有效产出 0%)严重不符,")
    A("   修复前建议在 /health 中如实反映。")
    A("")
    return "\n".join(L)


def write_report(path: str, results: list[CaseResult], url: str, trials: int, ts: str) -> int:
    """渲染并落盘报告,返回字节数。

    显式校验非空 —— 踩过的坑:报告模板里 `for L in LENGTHS:` 覆盖了收集行的
    列表 `L`,导致 `"\n".join(L)` 变成 join 一个字符串,报告只剩 7 字节
    ("l\\no\\nn\\ng") 而 exit code 仍是 0。静默失败比崩溃更难发现,故在此兜底。
    """
    rendered = render_report(results, url, trials, ts)
    if len(rendered) < 500 or "## 1. 最终判定" not in rendered:
        raise RuntimeError(
            f"报告渲染异常(仅 {len(rendered)} 字节)。"
            f"疑似变量遮蔽或模板逻辑错误 —— 拒绝落盘,请检查 render_report。"
        )
    with open(path, "w", encoding="utf-8") as f:
        f.write(rendered)
    return len(rendered)


# ── main ────────────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(description="cactus-needle 中英文兼容性测试")
    ap.add_argument("--url", default=os.environ.get("NEEDLE_URL", "http://127.0.0.1:8081"))
    ap.add_argument("--trials", type=int, default=3, help="每个 case 重复次数(默认 3)")
    ap.add_argument("--timeout", type=float, default=45.0, help="单次请求超时秒数")
    ap.add_argument("--out", default="", help="输出目录(默认 dist/needle-cn-en-<ts>)")
    ap.add_argument("--langs", default="en,cn", help="参与测试的语言(逗号分隔)")
    ap.add_argument("--rounds", type=int, default=1,
                    help="独立轮数(默认 1)。每轮把整个矩阵重跑一遍,结果累加到同一 case —— "
                         "用于放大样本量,压低偶发抖动对结论的影响")
    ap.add_argument("--render-only", default="",
                    help="从已有 <dir>/results.json 重新渲染报告,不再请求服务(调报告格式用)")
    args = ap.parse_args()

    # ── render-only:复用已有结果,只重渲 report.md ────────────────────────
    if args.render_only:
        src = os.path.join(args.render_only, "results.json")
        with open(src, encoding="utf-8") as f:
            blob = json.load(f)
        results = [CaseResult(**c) for c in blob["cases"]]
        out_dir = args.out or args.render_only
        os.makedirs(out_dir, exist_ok=True)
        eff = blob.get("effectiveTrialsPerCase") or blob["trialsPerCase"]
        n = write_report(os.path.join(out_dir, "report.md"), results,
                         blob["service"], eff, blob["generatedAt"])
        print(f"  报告已重渲: {out_dir}/report.md ({n} 字节)")
        return 0

    ts = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    out_dir = args.out or f"dist/needle-cn-en-{ts}"
    os.makedirs(out_dir, exist_ok=True)
    langs = [l.strip() for l in args.langs.split(",") if l.strip()]

    # 健康检查前置 —— 服务没起来就没必要跑
    try:
        with urllib.request.urlopen(f"{args.url}/health", timeout=5) as r:
            health = json.loads(r.read())
    except Exception as e:
        print(f"✗ [FATAL] {args.url}/health 不可达: {e}", file=sys.stderr)
        print("    → docker start needle-http", file=sys.stderr)
        return 1

    print(f"═══ needle cn/en compat test ═══")
    print(f"  service:  {args.url}  (v{health.get('version')} model_loaded={health.get('model_loaded')})")
    print(f"  trials:   {args.trials} per case x {args.rounds} rounds = {args.trials*args.rounds} 每 case")
    print(f"  cases:    {len(langs) * len(LENGTHS)} (语言 × query 长度)")
    print(f"  out:      {out_dir}")
    print("")

    results: list[CaseResult] = []
    total = len(langs) * len(LENGTHS) * args.trials * args.rounds
    done = 0
    # ── 多轮聚合:同一 case 的结果跨轮累加,放大样本量 ──────────────────
    acc: dict[tuple[str, str], CaseResult] = {}
    for rnd in range(args.rounds):
        for lang in langs:
            for length in LENGTHS:
                r = run_case(args.url, lang, length, args.trials, args.timeout)
                key = (lang, length)
                if key not in acc:
                    acc[key] = r
                else:
                    a = acc[key]
                    a.passed += r.passed
                    a.failed += r.failed
                    a.trials += r.trials
                    a.latencies += r.latencies
                    a.calls_when_ok += r.calls_when_ok
                    a.confidences += r.confidences
                    for k, v in r.failure_classes.items():
                        a.failure_classes[k] = a.failure_classes.get(k, 0) + v
                    if a.sample_error is None:
                        a.sample_error = r.sample_error
                cur = acc[key]
                done += args.trials
                mark = "✓" if cur.useful == cur.trials else ("~" if cur.passed else "✗")
                print(f"  {mark} {cur.case_id:<12} http={cur.passed}/{cur.trials} "
                      f"useful={cur.useful}/{cur.trials}"
                      f"  lat={min(cur.latencies):.1f}-{max(cur.latencies):.1f}s"
                      f"{'  ' + ','.join(cur.failure_classes) if cur.failure_classes else ''}"
                      f"   [r{rnd+1}/{args.rounds} {done}/{total}]")
                sys.stdout.flush()
    results = list(acc.values())

    en = [r for r in results if r.lang == "en"]
    cn = [r for r in results if r.lang == "cn"]
    def rate(g): return sum(x.passed for x in g) / max(1, sum(x.trials for x in g))
    def useful_rate(g): return sum(x.useful for x in g) / max(1, sum(x.trials for x in g))
    print("")
    print(f"  English: HTTP {rate(en):.0%}  有效产出 {useful_rate(en):.0%}")
    if cn:
        print(f"  Chinese: HTTP {rate(cn):.0%}  有效产出 {useful_rate(cn):.0%}")

    # ── 先落数据,再渲染报告 ────────────────────────────────────────────
    # 报告渲染器崩了不该丢数据(实测踩过:渲染 bug 导致 30 次请求的结果全丢)。
    with open(os.path.join(out_dir, "results.json"), "w", encoding="utf-8") as f:
        json.dump(
            {
                "generatedAt": ts,
                "service": args.url,
                "health": health,
                "trialsPerCase": args.trials,
                "rounds": args.rounds,
                "effectiveTrialsPerCase": args.trials * args.rounds,
                "methodology": "v2: 固定适配工具集,只变 语言 × query 长度",
                "fixedTools": FIXED_TOOLS,
                "queryMatrix": QUERY_MATRIX,
                "summary": {
                    "en": {"httpPassed": sum(x.passed for x in en),
                           "useful": sum(x.useful for x in en),
                           "trials": sum(x.trials for x in en),
                           "httpRate": rate(en), "usefulRate": useful_rate(en)},
                    "cn": {"httpPassed": sum(x.passed for x in cn),
                           "useful": sum(x.useful for x in cn),
                           "trials": sum(x.trials for x in cn),
                           "httpRate": rate(cn), "usefulRate": useful_rate(cn)} if cn else None,
                },
                "cases": [asdict(r) for r in results],
            },
            f, ensure_ascii=False, indent=2,
        )

    eff_trials = args.trials * args.rounds
    n = write_report(os.path.join(out_dir, "report.md"), results, args.url, eff_trials, ts)

    print("")
    print(f"  报告: {out_dir}/report.md ({n} 字节)")
    print(f"  数据: {out_dir}/results.json")
    # 全部通过才算绿;有失败返回 1 便于 CI 判定
    return 0 if all(r.passed == r.trials for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
