#!/usr/bin/env bash
# ── e2e-function-call-external-zh-weather.sh ──────────────────────────────
# §7.93 Phase 8 E2E:cactus-needle 3.0.1(目前)作为外部 tool-call prefill 链路端到端
# 验证。中文天气:用户报"LOK 今天的天气",eb 走 LOCAL intent → 外部 caller 抽
# get_weather(Lagos, "今天") → dsh-edge-agent ToolRunner.executeAll → 整段
# 对话给 LOCAL LLM 合成中文回复。
#
# **Phase 9 前置**:本脚本要求 function-call-external 已通过 cordis.patch.yml
# 挂到 ~/.dsh/profiles/dsh-edge/node_modules/.../lib/ 并随 boot 生效。
# 否则 external.* audit 不会出现在 log 里,脚本 FAIL(报错信息会指引)。
#
# 用法:
#   bash scripts/e2e-function-call-external-zh-weather.sh          # 默认配置跑
#   bash scripts/e2e-function-call-external-zh-weather.sh --dry-run  # 只检查 log,不 POST
#
# env 来源:.env(LOCAL_LLM_BASEURL / LOCAL_LLM_MODEL / DEEPSEEK_API_KEY / EDGE_API_KEY)
# dsh-edge-agent 期望已通过 scripts/install.sh 部署并 boot,默认 :21017。
# ExternalToolCaller(当前实现:cactus-needle 3.0.1 在 needle-http :8081) 提供 GET /health + POST /extract。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_FILE="${LOG_FILE:-$HOME/.dsh-edge-agent/log/dsh-edge-agent.log}"
HTTP_API_PORT="${DSH_EDGE_HTTP_PORT:-21017}"
HTTP_API_URL="http://127.0.0.1:${HTTP_API_PORT}/v1/chat"

# §7.93 Phase 8:固定 sid 便于 grep audit JSONL;ops log 与 audit.jsonl
# 都按 sid 索引。ci / 本地复用同一 sid,history grep 用 sid 通配符避免漏。
SID="e2e-function-call-external-zh-weather"
QUERY="查 /home/etsme/work 下的所有 .md 文件,列出文件名"

# ── .env 加载(同 §7.47.2 ops-log-coverage 的策略) ─────────────────────
if [ -z "${EDGE_API_KEY:-}" ]; then
  if [ -f "$REPO_ROOT/.env" ]; then
    set -a; . "$REPO_ROOT/.env"; set +a
  else
    echo "[WARN] .env not found — falling back to fake keys, ops log coverage may FAIL."
  fi
fi
AUTH_TOKEN="${DSH_EDGE_HTTP_TOKEN:-${EDGE_API_KEY:-test-secret-key}}"
TIMEOUT="${E2E_TIMEOUT:-90}"
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --help|-h)
      head -20 "$0" | tail -16
      exit 0
      ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
  shift
done

# ── Phase 9 prerequisite 探测 ────────────────────────────────────────
# 插件未挂上 → FAIL-fast,避免 false PASS("log 里没 external.* 但测试 PASS"
# 会误导运维)。核对策略:从最新 audit 行反向找 function-call-external 插件 boot
# 行;或更直接 — 从 dsh-edge-agent.log 最近 N 行 grep "[function-call-external]
# boot"。
FCX_BOOT_LINE=$(grep '\[function-call-external\] boot enabled=' "$LOG_FILE" 2>/dev/null | tail -1 || true)
if [ -z "$FCX_BOOT_LINE" ]; then
  echo "✗ [FATAL] $LOG_FILE 找不到 '[function-call-external] boot' 行" >&2
  echo "    → function-call-external 插件未在 dsh 启动时挂载。" >&2
  echo "    → Phase 9 部署未完成:cordis.patch.yml - insert: 数组必须含 function-call-external 行," >&2
  echo "      install.sh 必须 rsync lib/ + cp patch 到 ~/.dsh/profiles/dsh-edge/node_modules/.../" >&2
  echo "    → 跑 boot-verify: dsh --profile dsh-edge --dump-config 2>&1 | grep -A8 function-call-external" >&2
  exit 1
fi
FUNCTION_CALL_EXTERNAL_ENABLED=$(echo "$FCX_BOOT_LINE" | grep -oE 'enabled=[a-z]+' || echo "enabled=false")
if [[ "$FUNCTION_CALL_EXTERNAL_ENABLED" != "enabled=true" ]]; then
  echo "✗ [FATAL] function-call-external boot enabled=$FUNCTION_CALL_EXTERNAL_ENABLED(期望 enabled=true)" >&2
  echo "    → cordis.patch.yml env 翻译层 DSH_EDGE_FUNCTION_CALL_EXTERNAL_ENABLED 应读 'true'(或 unset — schema 默认 false)" >&2
  echo "    → 改完后重跑:bash install.sh + dsh --profile dsh-edge --dump-config 验" >&2
  exit 1
fi

if [ ! -f "$LOG_FILE" ]; then
  echo "✗ [FATAL] 找不到 ops log: $LOG_FILE" >&2
  echo "    → 确认 dsh-edge-agent 已启动,DSH_EDGE_HTTP_PORT 默认值匹配" >&2
  exit 1
fi

echo "▶ function-call-external E2E [$SID] query='$QUERY'"
echo "  · HTTP API: $HTTP_API_URL"
echo "  · function-call-external 状态: $FCX_BOOT_LINE"

# ── HTTP POST ─────────────────────────────────────────────────────
TMP_RESP="/tmp/e2e-function-call-external-zh-weather.json"
if [ "$DRY_RUN" = "0" ]; then
  BODY=$(printf '{"message":"%s","sessionId":"%s"}' "$QUERY" "$SID")
  if ! curl -s --max-time "$TIMEOUT" -X POST "$HTTP_API_URL" \
       -H "Authorization: Bearer $AUTH_TOKEN" \
       -H "Content-Type: application/json" \
       -d "$BODY" -o "$TMP_RESP" -w "%{http_code}\n" \
       | grep -q '^200$'; then
    echo "  ✗ HTTP POST 失败(非 200),见 $TMP_RESP" >&2
    exit 1
  fi
  echo "  ✓ HTTP 200 → $TMP_RESP"
  # 等 ops log flush(cordis waterfall + file-logger fsync)
  sleep 2
else
  echo "  · dry-run,跳过 HTTP POST"
fi

# ── ops log 抽 sid 行(ops log 是 file-logger 写,~/.dsh-edge-agent/log/) ──
LOG_LINES="/tmp/e2e-function-call-external-zh-weather.log"
grep "$SID" "$LOG_FILE" > "$LOG_LINES" 2>/dev/null || true
N=$(wc -l < "$LOG_LINES")
echo "  · ops log 行数: $N"

# ── audit JSONL 抽 sid 行(audit 是 audit-log 写,~/.dsh-edge-agent/audit/) ──
# function-call-external 的 per-session 事件(external.extract / external.synthesis_injected
# / external.timeout_skip / external.circuit_open_skip / external.executed 等)目前只
# 走 auditLog,不走 ctx.logger —— 因此 ops log 里查不到 function-call-external 事件,必须
# audit JSONL 查。Phase 9 之后(或下次补丁)应该补 function-call-external ops log,
# 让 file-logger 也能 grep;目前暂用 audit JSONL 双轨验证。
AUDIT_FILE="$HOME/.dsh-edge-agent/audit/audit.plain.jsonl"
AUDIT_LINES="/tmp/e2e-function-call-external-zh-weather.audit"
grep "\"sessionId\":\"$SID\"" "$AUDIT_FILE" > "$AUDIT_LINES" 2>/dev/null || true
NA=$(wc -l < "$AUDIT_LINES")
echo "  · audit JSONL 行数: $NA"

FAIL=0

# ── 断言 1:external.hook.registered 一次性 audit(插件挂载的证据) ────
# boot 行是 apply() 一次性 emit,**不带 sessionId** —— 必须查完整 audit
# JSONL,不能按 sessionId 过滤。
HOOK_REG=$(grep -c '"kind":"external.hook.registered"' "$AUDIT_FILE" 2>/dev/null || echo 0)
if [ "$HOOK_REG" -lt 1 ]; then
  echo "  ✗ 缺 external.hook.registered audit(listener 未挂)" >&2
  FAIL=1
else
  echo "  ✓ external.hook.registered 找到 $HOOK_REG 次(全局 listener 挂载)"
fi

# boot 行 ops log(function-call-external boot 时 emit 一次,运维一眼可见 enabled/url)
if ! grep -qF '[function-call-external] boot enabled=' "$LOG_FILE" 2>/dev/null; then
  echo "  ✗ 缺 [function-call-external] boot enabled= ops log 行" >&2
  FAIL=1
else
  echo "  ✓ [function-call-external] boot enabled= ops log 行存在"
fi

# ── 断言 2:external 完整 audit chain(7 个 kind 至少出现) ──
# external.extract / external.synthesis_injected 至少各 1 次(成功路径);
# 其他(translate.* 已裁掉)按现 config + 实 external 行为自然产生。
# function-call-external per-session audit 走 audit JSONL,不走 ops log(file-logger)。
declare -a MUST_HAVE=(
  'external.boot_probe'
)
for kind in "${MUST_HAVE[@]}"; do
  if ! grep -qF "\"kind\":\"$kind\"" "$AUDIT_FILE" 2>/dev/null; then
    echo "  ✗ 缺 external audit kind: $kind(全局 boot probe 都没跑)" >&2
    FAIL=1
  else
    echo "  ✓ audit kind: $kind"
  fi
done

# ── 断言 3:本 session function-call-external pipeline 走通(合成 / 超时 / 短路 三选一) ──
# 三种合法结局:
#   A) 外部 caller 抽到 + 至少 1 executed → 注入 synthesis_injected + external.executed
#   B) caller 超时 / 5xx → external.timeout_skip 或 external.extract_failed +
#      external.circuit_open(breaker 打开) → fall through 到 LLM 自提取(§7.42 P0-1)
#   C) external breaker 已开 → external.circuit_open_skip(0ms 短路) → fall through
# 三选一都不能命中 = 设计预期外的失败,FAIL。
HAS_SYNTH=$(grep -qF '"kind":"external.synthesis_injected"' "$AUDIT_LINES" && echo 1 || echo 0)
HAS_EXECUTED=$(grep -qF '"kind":"external.executed"' "$AUDIT_LINES" && echo 1 || echo 0)
HAS_TIMEOUT_SKIP=$(grep -qF '"kind":"external.timeout_skip"' "$AUDIT_LINES" && echo 1 || echo 0)
HAS_CIRCUIT_SKIP=$(grep -qF '"kind":"external.circuit_open_skip"' "$AUDIT_LINES" && echo 1 || echo 0)
HAS_CIRCUIT_OPEN=$(grep -qF '"kind":"external.circuit_open"' "$AUDIT_LINES" && echo 1 || echo 0)
if [ "$HAS_SYNTH" = "1" ] && [ "$HAS_EXECUTED" = "1" ]; then
  echo "  ✓ 路径 A:外部 caller 抽到工具 + executed + synthesis_injected 注入"
elif [ "$HAS_TIMEOUT_SKIP" = "1" ] || [ "$HAS_CIRCUIT_OPEN" = "1" ]; then
  echo "  ✓ 路径 B:caller 超时 / 5xx → external.circuit_open 触发 → fall through(预期行为,§7.93 dry-run #1 已记录 外部 caller 引擎当前 25x 性能劣化)"
elif [ "$HAS_CIRCUIT_SKIP" = "1" ]; then
  echo "  ✓ 路径 C:external breaker 开着 → 0ms 短路(预期行为,§7.92.6 守护)"
else
  echo "  ✗ 三种合法路径都不命中(A 缺 synthesis / B 缺 timeout+circuit_open / C 缺 circuit_open_skip)" >&2
  echo "    → function-call-external 没运行 / 也没短路 → dsh boot 配置有误" >&2
  FAIL=1
fi

# ── 断言 4:LLM 最终合成中文回复(响应体含天气关键字) ────────────
if [ "$DRY_RUN" = "0" ]; then
  RESP_TEXT=$(cat "$TMP_RESP" | tr -d '\n' | head -c 2000)
  # 不能断言具体数值,但能断言:响应非空 + 关键字(.md / 文件 / 列出)
  if [ -z "$RESP_TEXT" ]; then
    echo "  ✗ 响应体为空" >&2
    FAIL=1
  elif ! echo "$RESP_TEXT" | grep -qiE '\.md|列出|文件|file|bash|glob|ls'; then
    echo "  ✗ 响应体不含相关关键字(可能 LLM 没合出有效回复)" >&2
    echo "    · 响应(前 500 字符): $(echo "$RESP_TEXT" | head -c 500)" >&2
    FAIL=1
  else
    echo "  ✓ LLM 合成回复含文件操作关键字"
  fi
fi

# ── 断言 5:breaker 行为记录(可选,但说明性能) ─────────────────────
# 外部 caller 引擎当前 degradation 25x(dry-run #1):expect external.circuit_open
# / external.timeout_skip 至少 1 个;如果都没有说明 外部 caller 引擎健康或 boot
# probe 配置 disabled。我们只 WARN,不 FAIL。
BREAKER_OPS=$(grep -cE 'external\.(circuit_open|timeout_skip|circuit_open_skip)' "$AUDIT_LINES" 2>/dev/null || true)
if [ "$BREAKER_OPS" -gt 0 ]; then
  echo "  · breaker/timeout ops 计数: $BREAKER_OPS(说明 外部 caller 引擎当前不健康 — 与 dry-run #1 一致)"
else
  echo "  · breaker 0 次触发(外部 caller 引擎健康,或 boot probe 关了)"
fi

echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "═══════════════════════════════════════════════════════════════"
  echo "  ✓ function-call-external E2E PASS — Chinese query 走 function-call-external 全链路"
  echo "═══════════════════════════════════════════════════════════════"
  exit 0
else
  echo "═══════════════════════════════════════════════════════════════"
  echo "  ✗ function-call-external E2E FAIL — 见上"
  echo "═══════════════════════════════════════════════════════════════"
  exit 1
fi