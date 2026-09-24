#!/usr/bin/env bash
# ── e2e-needle-extractor-zh-weather.sh ──────────────────────────────
# §7.93 Phase 8 E2E:cactus-needle 3.0.1 的 tool-call prefill 链路端到端
# 验证。中文天气:用户报"LOK 今天的天气",eb 走 LOCAL intent → needle 抽
# get_weather(Lagos, "今天") → dsh-edge-agent ToolRunner.executeAll → 整段
# 对话给 LOCAL LLM 合成中文回复。
#
# **Phase 9 前置**:本脚本要求 needle-extractor 已通过 cordis.patch.yml
# 挂到 ~/.dsh/profiles/dsh-edge/node_modules/.../lib/ 并随 boot 生效。
# 否则 needle.* audit 不会出现在 log 里,脚本 FAIL(报错信息会指引)。
#
# 用法:
#   bash scripts/e2e-needle-extractor-zh-weather.sh          # 默认配置跑
#   bash scripts/e2e-needle-extractor-zh-weather.sh --dry-run  # 只检查 log,不 POST
#
# env 来源:.env(LOCAL_LLM_BASEURL / LOCAL_LLM_MODEL / DEEPSEEK_API_KEY / EDGE_API_KEY)
# dsh-edge-agent 期望已通过 scripts/install.sh 部署并 boot,默认 :21017。
# needle-http 期望已在 :8081 提供 GET /health + POST /extract。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_FILE="${LOG_FILE:-$HOME/.dsh-edge-agent/log/dsh-edge-agent.log}"
HTTP_API_PORT="${DSH_EDGE_HTTP_PORT:-21017}"
HTTP_API_URL="http://127.0.0.1:${HTTP_API_PORT}/v1/chat"

# §7.93 Phase 8:固定 sid 便于 grep audit JSONL;ops log 与 audit.jsonl
# 都按 sid 索引。ci / 本地复用同一 sid,history grep 用 sid 通配符避免漏。
SID="e2e-needle-zh-weather"
QUERY="Lagos 今天的天气怎么样?"

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
# 插件未挂上 → FAIL-fast,避免 false PASS("log 里没 needle.* 但测试 PASS"
# 会误导运维)。核对策略:从最新 audit 行反向找 needle-extractor 插件 boot
# 行;或更直接 — 从 dsh-edge-agent.log 最近 N 行 grep "[needle-extractor]
# boot"。
NEEDLE_BOOT_LINE=$(grep '\[needle-extractor\] boot' "$LOG_FILE" 2>/dev/null | tail -1 || true)
if [ -z "$NEEDLE_BOOT_LINE" ]; then
  echo "✗ [FATAL] $LOG_FILE 找不到 '[needle-extractor] boot' 行" >&2
  echo "    → needle-extractor 插件未在 dsh 启动时挂载。" >&2
  echo "    → Phase 9 部署未完成:cordis.patch.yml - insert: 数组必须含 needle-extractor 行," >&2
  echo "      install.sh 必须 rsync lib/ + cp patch 到 ~/.dsh/profiles/dsh-edge/node_modules/.../" >&2
  echo "    → 跑 boot-verify: dsh --profile dsh-edge --dump-config 2>&1 | grep -A8 needle-extractor" >&2
  exit 1
fi
NEEDLE_ENABLED=$(echo "$NEEDLE_BOOT_LINE" | grep -oE 'enabled=[a-z]+' || echo "enabled=false")
if [[ "$NEEDLE_ENABLED" != "enabled=true" ]]; then
  echo "✗ [FATAL] needle-extractor boot enabled=$NEEDLE_ENABLED(期望 enabled=true)" >&2
  echo "    → cordis.patch.yml env 翻译层 DSH_EDGE_NEEDLE_ENABLED 应读 'true'(或 unset — schema 默认 false)" >&2
  echo "    → 改完后重跑:bash install.sh + dsh --profile dsh-edge --dump-config 验" >&2
  exit 1
fi

if [ ! -f "$LOG_FILE" ]; then
  echo "✗ [FATAL] 找不到 ops log: $LOG_FILE" >&2
  echo "    → 确认 dsh-edge-agent 已启动,DSH_EDGE_HTTP_PORT 默认值匹配" >&2
  exit 1
fi

echo "▶ needle-extractor E2E [$SID] query='$QUERY'"
echo "  · HTTP API: $HTTP_API_URL"
echo "  · needle 状态: $NEEDLE_BOOT_LINE"

# ── HTTP POST ─────────────────────────────────────────────────────
TMP_RESP="/tmp/e2e-needle-zh-weather.json"
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

# ── ops log 抽 sid 行 ──────────────────────────────────────────────
LOG_LINES="/tmp/e2e-needle-zh-weather.log"
grep "$SID" "$LOG_FILE" > "$LOG_LINES" 2>/dev/null || true
N=$(wc -l < "$LOG_LINES")
echo "  · ops log 行数: $N"

FAIL=0

# ── 断言 1:needle.hook.registered 一次性 audit(插件挂载的证据) ────
if ! grep -qF '[needle-extractor] boot' "$LOG_LINES"; then
  echo "  ✗ 缺 needle-extractor boot 行(可能 listener 未挂)" >&2
  FAIL=1
fi

# ── 断言 2:needle.extractor 完整 audit chain(7 个 kind 至少出现) ──
# needle.extract / needle.synthesis_injected 至少各 1 次(成功路径);
# 其他(translate.* 已裁掉)按现 config + 实 needle 行为自然产生。
declare -a MUST_HAVE=(
  'needle.boot_probe'
  'needle.extract'
  'needle.synthesis_injected'
)
for kind in "${MUST_HAVE[@]}"; do
  if ! grep -qF "$kind" "$LOG_LINES"; then
    echo "  ✗ 缺 needle audit kind: $kind" >&2
    FAIL=1
  else
    echo "  ✓ audit kind: $kind"
  fi
done

# ── 断言 3:tool execution path 走通(tool-runner audit: needle.executed) ──
# needle 抽到工具 → ToolRunner.executeAll → 宿主 tools.execute → audit
# needle.executed(source='needle-extractor')。如果 needle 没抽到(call
# count=0)或 confidence 太低,会跳 synthesis,这条也 missing。
if ! grep -qF 'needle.executed' "$LOG_LINES"; then
  echo "  ✗ 缺 needle.executed(tool-runner 没跑 — 可能 needle 没抽到工具)" >&2
  echo "    → 排查:audit needle.extract 看 confidence / callCount" >&2
  echo "    → 也可能是 breaker 打开(查 needle.circuit_open_skip 行数 == needle.extract 行数 ⇒ 全短路)" >&2
  FAIL=1
else
  echo "  ✓ tool execution 走通(needle.executed 出现)"
fi

# ── 断言 4:LLM 最终合成中文回复(响应体含天气关键字) ────────────
if [ "$DRY_RUN" = "0" ]; then
  RESP_TEXT=$(cat "$TMP_RESP" | tr -d '\n' | head -c 2000)
  # 不能断言具体数值,但能断言:响应非空 + 含 "Lagos" / 关键字
  if [ -z "$RESP_TEXT" ]; then
    echo "  ✗ 响应体为空" >&2
    FAIL=1
  elif ! echo "$RESP_TEXT" | grep -qiE 'lagos|weather|天气|cloud|雨|晴|temperature|°|°c|°f'; then
    echo "  ✗ 响应体不含天气相关关键字(可能 LLM 没合出有效回复)" >&2
    echo "    · 响应(前 500 字符): $(echo "$RESP_TEXT" | head -c 500)" >&2
    FAIL=1
  else
    echo "  ✓ LLM 合成回复含天气关键字"
  fi
fi

# ── 断言 5:breaker 行为记录(可选,但说明性能) ─────────────────────
# needle 引擎当前 degradation 25x(dry-run #1):expect needle.circuit_open
# / needle.timeout_skip 至少 1 个;如果都没有说明 needle 引擎健康或 boot
# probe 配置 disabled。我们只 WARN,不 FAIL。
BREAKER_OPS=$(grep -cE 'needle\.(circuit_open|timeout_skip|circuit_open_skip)' "$LOG_LINES" || true)
if [ "$BREAKER_OPS" -gt 0 ]; then
  echo "  · breaker/timeout ops 计数: $BREAKER_OPS(说明 needle 引擎当前不健康 — 与 dry-run #1 一致)"
else
  echo "  · breaker 0 次触发(needle 引擎健康,或 boot probe 关了)"
fi

echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "═══════════════════════════════════════════════════════════════"
  echo "  ✓ needle-extractor E2E PASS — Chinese query 走 needle 全链路"
  echo "═══════════════════════════════════════════════════════════════"
  exit 0
else
  echo "═══════════════════════════════════════════════════════════════"
  echo "  ✗ needle-extractor E2E FAIL — 见上"
  echo "═══════════════════════════════════════════════════════════════"
  exit 1
fi