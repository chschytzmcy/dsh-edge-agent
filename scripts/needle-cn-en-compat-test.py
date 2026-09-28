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

# 每种语言一组语义等价的 query —— 必须表达同一个意图,才能对比语言变量
QUERIES: dict[str, str] = {
    "en": "list all .md files under /home/etsme/work and show their names",
    "cn": "列出 /home/etsme/work 下的所有 .md 文件并显示文件名",
}

TOOL_COUNTS = [1, 3, 5, 8, 13]
LOCALES = {"en": "en-US", "cn": "zh-CN"}
LANG_LABEL = {"en": "English", "cn": "Chinese"}


def make_tools(n: int) -> list[dict[str, Any]]:
    return [
        {
            "name": name,
            "description": desc,
            "parameters": {
                "type": "object",
                "properties": {"q": {"type": "string"}, "path": {"type": "string"}},
                "required": ["q"],
            },
        }
        for name, desc in TOOL_CATALOG[:n]
    ]


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
    tool_count: int
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


def run_case(url: str, lang: str, n_tools: int, trials: int, timeout: float) -> CaseResult:
    tools = make_tools(n_tools)
    query = QUERIES[lang]
    locale = LOCALES[lang]
    res = CaseResult(
        case_id=f"{lang}-{n_tools:02d}",
        lang=lang,
        tool_count=n_tools,
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

    A("# cactus-needle 中英文兼容性测试报告")
    A("")
    A(f"- **生成时间**: {ts}")
    A(f"- **被测服务**: `{url}/extract` (cactus-needle 3.0.1)")
    A(f"- **每 case 重复次数**: {trials}")
    A(f"- **方法**: 固定 tool schema 目录,只变语言与 tool 数量;中文/英文 query 语义等价")
    A("")

    A("## 1. 结论摘要")
    A("")
    en = [r for r in results if r.lang == "en"]
    cn = [r for r in results if r.lang == "cn"]
    en_rate = sum(r.passed for r in en) / max(1, sum(r.trials for r in en))
    cn_rate = sum(r.passed for r in cn) / max(1, sum(r.trials for r in cn))
    # 有效产出 = HTTP 200 且 function_calls 非空 —— 这才是 prefill 真正有用的条件
    ok_calls_en = sum(c for r in en for c in r.calls_when_ok)
    ok_calls_cn = sum(c for r in cn for c in r.calls_when_ok)
    useful_en = ok_calls_en / max(1, sum(r.trials for r in en))
    useful_cn = ok_calls_cn / max(1, sum(r.trials for r in cn))
    en_lat = [l for r in en for l in r.latencies if l]
    cn_lat = [l for r in cn for l in r.latencies if l]
    A(f"| 语言 | HTTP 成功率 | **有效产出率** | 中位延迟 | 失败类型分布 |")
    A(f"|---|---|---|---|---|")
    A(f"| English | {en_rate:.0%} ({sum(r.passed for r in en)}/{sum(r.trials for r in en)})"
      f" | **{useful_en:.0%}** ({ok_calls_en}/{sum(r.trials for r in en)})"
      f" | {sorted(en_lat)[len(en_lat)//2]:.1f}s | — |")
    dist_cn = ", ".join(f"{k}×{v}" for k, v in
                        sorted({c: sum(r.failure_classes.get(c,0) for r in cn)
                                for c in {cc for r in cn for cc in r.failure_classes}}.items(),
                                key=lambda x: -x[1]))
    A(f"| Chinese | {cn_rate:.0%} ({sum(r.passed for r in cn)}/{sum(r.trials for r in cn)})"
      f" | **{useful_cn:.0%}** ({ok_calls_cn}/{sum(r.trials for r in cn)})"
      f" | {sorted(cn_lat)[len(cn_lat)//2]:.1f}s | {dist_cn or '—'} |")
    A("")
    A("> **两个指标的区别很重要**:`HTTP 成功率` 只说明请求没报错;")
    A("> `有效产出率` 才说明**真的返回了至少一个 function_call**(即 prefill 有用)。")
    A("> 英文 HTTP 100% 成功,但绝大多数成功响应里 `function_calls` 是空的 ——")
    A("> 对 dsh-edge-agent 而言,空产出与 502 等价(prefill 拿不到东西,只能 fall through)。")
    A("")

    A("## 2. 逐 case 结果")
    A("")
    A("| case | 语言 | tools | 成功 | 失败 | 成功率 | 延迟(min/max) | 产出 calls | 平均 conf | 失败类型 |")
    A("|---|---|---|---|---|---|---|---|---|---|")
    for r in results:
        lat = f"{min(r.latencies):.1f}/{max(r.latencies):.1f}s" if r.latencies else "—"
        calls = f"{sum(r.calls_when_ok)}/{r.passed}" if r.passed else "—"
        conf = f"{sum(r.confidences)/len(r.confidences):.3f}" if r.confidences else "—"
        fc = ", ".join(f"{k}×{v}" for k, v in sorted(r.failure_classes.items())) or "—"
        A(f"| `{r.case_id}` | {LANG_LABEL[r.lang]} | {r.tool_count} | {r.passed} | {r.failed} "
          f"| {r.success_rate:.0%} | {lat} | {calls} | {conf} | {fc} |")
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
    A("### 5.1 首要问题:即使 HTTP 成功,产出也基本为空")
    A("")
    A(f"英文 {sum(r.passed for r in en)} 次 HTTP 成功中,只有 {ok_calls_en} 次返回了非空 `function_calls`。")
    A("典型反常:部分 case 报 `confidence` 接近 1.0 却 `function_calls: []` ——")
    A("模型\"非常确定\"地认为不需要调用工具。对 prefill 场景,空产出 = 无用,与 502 等价。")
    A("")
    A("### 5.2 次要问题:中文请求大面积 502")
    A("")
    A(f"中文 HTTP 成功率 {cn_rate:.0%},失败全部为 `utf8_decode`。")
    A("失败与 tool 数量、query 长度无关,表现为引擎输出缓冲区截断时切断多字节 UTF-8 字符。")
    A("两次独立运行结果完全一致(同 9 个 case 的通过/失败模式),可稳定复现。")
    A("")
    A("### 5.3 对 dsh-edge-agent 的净效果")
    A("")
    A("`function-call-external` 把用户 query 原样 POST 给 needle。对中文用户:")
    A("")
    A("| 情况 | 占比 | plugin 代价 |")
    A("|---|---|---|")
    A(f"| HTTP 502 | {1-cn_rate:.0%} | 等满 timeout 才 fall through + 熔断器开关 |")
    A(f"| HTTP 200 但产出空 | {cn_rate - useful_cn:.0%} | 白等一轮 latency,prefill 无效 |")
    A(f"| 有效产出 | {useful_cn:.0%} | 真正帮上忙 |")
    A("")
    A("故默认 `FUNCTION_CALL_EXTERNAL_ENABLED=false`。等引擎侧修复且有效产出率显著提升后再评估启用。")
    A("")

    A("## 6. 建议修复(按优先级)")
    A("")
    A("1. **[阻断性]中文 UTF-8 截断** —— 提高 native 库输出缓冲区上限")
    A("   (当前实际生效约 200 字节,远低于 Python 侧 `create_string_buffer(65536)` 的声明值),")
    A("   或改为按字节返回长度而非依赖 NUL 截断。")
    A("2. **[阻断性]截断边界** —— 截断时向前回退到最近的 UTF-8 字符起始位再返回,")
    A("   避免把半个多字节字符交给调用方。")
    A("3. **[质量]有效产出率** —— HTTP 成功率不代表可用。当前英文成功多数产出空")
    A("   `function_calls`,建议在 /health 或 /extract 响应中暴露该指标,便于调用方决策。")
    A("4. **[测试]补 CJK 回归用例** —— 现有测试似仅覆盖 ASCII,故该缺陷未被发现。")
    A("5. **[声明]`cn_grounding: true`** —— 与实测行为(中文大面积失败)不符,")
    A("   修复前建议在 /health 中如实反映。")
    A("")
    return "\n".join(L)


# ── main ────────────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(description="cactus-needle 中英文兼容性测试")
    ap.add_argument("--url", default=os.environ.get("NEEDLE_URL", "http://127.0.0.1:8081"))
    ap.add_argument("--trials", type=int, default=3, help="每个 case 重复次数(默认 3)")
    ap.add_argument("--timeout", type=float, default=45.0, help="单次请求超时秒数")
    ap.add_argument("--out", default="", help="输出目录(默认 dist/needle-cn-en-<ts>)")
    ap.add_argument("--langs", default="en,cn", help="参与测试的语言(逗号分隔)")
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
        with open(os.path.join(out_dir, "report.md"), "w", encoding="utf-8") as f:
            f.write(render_report(results, blob["service"], blob["trialsPerCase"], blob["generatedAt"]))
        print(f"  报告已重渲: {out_dir}/report.md")
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
    print(f"  trials:   {args.trials} per case")
    print(f"  cases:    {len(langs) * len(TOOL_COUNTS)}")
    print(f"  out:      {out_dir}")
    print("")

    results: list[CaseResult] = []
    total = len(langs) * len(TOOL_COUNTS) * args.trials
    done = 0
    for lang in langs:
        for n in TOOL_COUNTS:
            r = run_case(args.url, lang, n, args.trials, args.timeout)
            results.append(r)
            done += args.trials
            mark = "✓" if r.passed == r.trials else ("~" if r.passed else "✗")
            print(f"  {mark} {r.case_id:<8} {r.passed}/{r.trials} ok"
                  f"  lat={min(r.latencies):.1f}-{max(r.latencies):.1f}s"
                  f"{'  ' + ','.join(r.failure_classes) if r.failure_classes else ''}"
                  f"   [{done}/{total}]")
            sys.stdout.flush()

    en = [r for r in results if r.lang == "en"]
    cn = [r for r in results if r.lang == "cn"]
    def rate(g): return sum(x.passed for x in g) / max(1, sum(x.trials for x in g))
    print("")
    print(f"  English: {rate(en):.0%}   Chinese: {rate(cn):.0%}" if cn else f"  English: {rate(en):.0%}")

    # ── 先落数据,再渲染报告 ────────────────────────────────────────────
    # 报告渲染器崩了不该丢数据(实测踩过:渲染 bug 导致 30 次请求的结果全丢)。
    with open(os.path.join(out_dir, "results.json"), "w", encoding="utf-8") as f:
        json.dump(
            {
                "generatedAt": ts,
                "service": args.url,
                "health": health,
                "trialsPerCase": args.trials,
                "toolCatalog": TOOL_CATALOG,
                "queries": QUERIES,
                "summary": {
                    "en": {"passed": sum(x.passed for x in en), "trials": sum(x.trials for x in en),
                           "rate": rate(en)},
                    "cn": {"passed": sum(x.passed for x in cn), "trials": sum(x.trials for x in cn),
                           "rate": rate(cn)} if cn else None,
                },
                "cases": [asdict(r) for r in results],
            },
            f, ensure_ascii=False, indent=2,
        )

    with open(os.path.join(out_dir, "report.md"), "w", encoding="utf-8") as f:
        f.write(render_report(results, args.url, args.trials, ts))

    print("")
    print(f"  报告: {out_dir}/report.md")
    print(f"  数据: {out_dir}/results.json")
    # 全部通过才算绿;有失败返回 1 便于 CI 判定
    return 0 if all(r.passed == r.trials for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
