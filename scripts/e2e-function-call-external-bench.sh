#!/usr/bin/env bash
# ── e2e-function-call-external-bench.sh ───────────────────────────────────
# §7.93 Phase 8 bench:LOCAL intent chat latency + malformed tool_call
# 率对比,**baseline (FUNCTION_CALL_EXTERNAL_ENABLED=false) vs function-call-external-enabled (true)**。
#
# 用法:
#   bash scripts/e2e-function-call-external-bench.sh --iter 5          # 5 个 query × 2 轮 = 10 请求
#   bash scripts/e2e-function-call-external-bench.sh --only baseline   # 只跑 baseline
#   bash scripts/e2e-function-call-external-bench.sh --only function-call-external      # 只跑 function-call-external 启用
#   bash scripts/e2e-function-call-external-bench.sh --dry-run         # 只打印计划,不实际 POST
#
# 输出:$REPO_ROOT/dist/bench-fcx-${TS}/report.md + scores.json + traces/
#       (git-ignored)
#
# 设计参考:
#   scripts/e2e-ops-log-coverage.sh  (banner + arg parse + 颜色)
#   scripts/e2e-model-quality-bench.sh (bench 落盘到 dist/bench-*/)
#
# ⚠️ **Phase 9 前置**:同 e2e-function-call-external-zh-weather.sh —— 脚本要求
# function-call-external 已在 dsh boot 时挂载(查 [function-call-external] boot 行)。
# baseline 跑可独立(不需要 function-call-external 插件),function-call-external 跑需要 Phase 9 部署完成。

set -uo pipefail

# ── ANSI colors ─────────────────────────────────────────────────────
BLUE='\033[0;34m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_FILE="${LOG_FILE:-$HOME/.dsh-edge-agent/log/dsh-edge-agent.log}"
HTTP_API_PORT="${DSH_EDGE_HTTP_PORT:-21017}"
HTTP_API_URL="http://127.0.0.1:${HTTP_API_PORT}/v1/chat"
TIMEOUT="${E2E_TIMEOUT:-60}"

# ── config/edge.json 加载(§7.102:取代 .env) ─────────────────────────
if [ -z "${EDGE_API_KEY:-}" ]; then
  # shellcheck disable=SC1091
  source "$REPO_ROOT/scripts/edge-config-env.sh"
fi
AUTH_TOKEN="${DSH_EDGE_HTTP_TOKEN:-${EDGE_API_KEY:-test-secret-key}}"

# ── args ────────────────────────────────────────────────────────────
ITER=3
ONLY=""
DRY_RUN=0
QUERIES=(
  "Lagos 今天的天气怎么样?"
  "查 $HOME/work 下的所有 .md 文件"
  "本机 IP 是多少?"
  "当前 git 仓库上次 commit 是什么?"
  "查 Elon Musk 最近的一条新闻"
)
# §7.42 P0-1 malformed 检测:§7.42 修复路径下基本为 0;但某些弱 LLM
# (minicpm5-2b)在没有 function-call-external 辅助时仍会偶发。bench 量化这个率。
MALFORMED_PATTERNS=(
  'xml'             # XML fragment 残留
  '<function_call>' # 未关闭的 tag
  '<tool_call'      # 同上
  'finish_reason=tool_calls' # finish_reason 误报
)

while [ $# -gt 0 ]; do
  case "$1" in
    --iter=*) ITER="${1#*=}" ;;
    --iter)   shift; ITER="${1:-3}" ;;
    --only=*) ONLY="${1#*=}" ;;
    --only)   shift; ONLY="${1:-}" ;;
    --dry-run) DRY_RUN=1 ;;
    --help|-h) head -25 "$0" | tail -20; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
  shift
done

# ── Phase 9 prerequisite 探测(仅 function-call-external 模式需要) ──────────────────
FCX_BOOT_LINE=$(grep '\[function-call-external\] boot' "$LOG_FILE" 2>/dev/null | tail -1 || true)
FCX_AVAILABLE=0
if [ -n "$FCX_BOOT_LINE" ]; then
  FUNCTION_CALL_EXTERNAL_ENABLED=$(echo "$FCX_BOOT_LINE" | grep -oE 'enabled=[a-z]+' || echo "enabled=false")
  if [[ "$FUNCTION_CALL_EXTERNAL_ENABLED" == "enabled=true" ]]; then
    FCX_AVAILABLE=1
  fi
fi
if [ -z "$ONLY" ] && [ "$FCX_AVAILABLE" -eq 0 ]; then
  echo -e "${YELLOW}⚠ function-call-external 插件未在 dsh 启动时挂载(查 [function-call-external] boot 行无 enabled=true)。${NC}" >&2
  echo -e "${YELLOW}  function-call-external 模式将退化为 baseline(无 caller 介入)。Phase 9 部署完成后会自然生效。${NC}" >&2
  echo ""
fi

# ── 落盘目录 ────────────────────────────────────────────────────────
TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="$REPO_ROOT/dist/bench-fcx-$TS"
mkdir -p "$OUT_DIR/traces"

# ── 一轮请求:发 query,采 wall-clock + body ─────────────────────────
run_one() {
  local tag="$1" q="$2" idx="$3"
  local sid="bench-fcx-${tag}-${idx}-$$"
  local body resp_file http_code wall_ms start
  body=$(printf '{"message":"%s","sessionId":"%s"}' "$q" "$sid")
  resp_file="$OUT_DIR/traces/${tag}-${idx}.json"
  start=$(date +%s%3N)
  http_code=$(curl -s --max-time "$TIMEOUT" -X POST "$HTTP_API_URL" \
       -H "Authorization: Bearer $AUTH_TOKEN" \
       -H "Content-Type: application/json" \
       -d "$body" -o "$resp_file" -w "%{http_code}" 2>/dev/null || echo "000")
  wall_ms=$(( $(date +%s%3N) - start ))
  echo "$wall_ms|$http_code|$sid|$resp_file"
}

# ── malformed 计数(响应体里 grep 几个 P0-1 痕迹) ────────────────────
count_malformed() {
  local resp_file="$1" n=0
  [ -f "$resp_file" ] || { echo 0; return; }
  local p
  for p in "${MALFORMED_PATTERNS[@]}"; do
    if grep -qiF "$p" "$resp_file"; then n=$((n+1)); fi
  done
  echo "$n"
}

# ── 跑一轮 tag ───────────────────────────────────────────────────────
run_round() {
  local tag="$1"
  local csv="$OUT_DIR/${tag}.csv"
  echo "tag,idx,query_len,wall_ms,http_code,malformed_hits" > "$csv"
  for i in $(seq 1 "$ITER"); do
    for qi in "${!QUERIES[@]}"; do
      local q="${QUERIES[$qi]}"
      local r wall_ms http_code sid resp_file
      r=$(run_one "$tag" "$q" "$qi")
      wall_ms=$(echo "$r" | cut -d'|' -f1)
      http_code=$(echo "$r" | cut -d'|' -f2)
      sid=$(echo "$r" | cut -d'|' -f3)
      resp_file=$(echo "$r" | cut -d'|' -f4)
      local qlen=${#q}
      local malformed
      malformed=$(count_malformed "$resp_file")
      echo "$tag,$qi,$qlen,$wall_ms,$http_code,$malformed" >> "$csv"
    done
  done
}

# ── p50/p95 计算(bash awk 排序) ──────────────────────────────────────
compute_percentiles() {
  local csv="$1"
  # 抽 wall_ms 第 3 列,只算 http_code=200
  local vals
  vals=$(awk -F, 'NR>1 && $5=="200" {print $4}' "$csv" | sort -n)
  local n count p50 p95
  count=$(echo "$vals" | grep -c . || echo 0)
  if [ "$count" -eq 0 ]; then
    echo "0|0|0"
    return
  fi
  p50_idx=$(( (count + 1) / 2 ))
  p95_idx=$(( (count * 95 + 99) / 100 ))
  if [ "$p95_idx" -gt "$count" ]; then p95_idx=$count; fi
  p50=$(echo "$vals" | sed -n "${p50_idx}p")
  p95=$(echo "$vals" | sed -n "${p95_idx}p")
  echo "$p50|$p95|$count"
}

# ── malformed 总数 ───────────────────────────────────────────────────
count_malformed_total() {
  local csv="$1"
  awk -F, 'NR>1 {sum += $6} END {print sum+0}' "$csv"
}

# ── dry-run:仅打印计划 ──────────────────────────────────────────────
if [ "$DRY_RUN" = "1" ]; then
  echo -e "${CYAN}── dry-run plan ──${NC}"
  echo "  iter=$ITER queries=${#QUERIES[@]}"
  echo "  out=$OUT_DIR"
  echo "  needle_avail=$FCX_AVAILABLE (0=baseline-only fallback)"
  exit 0
fi

# ── 主路径 ──────────────────────────────────────────────────────────
echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  §7.93 Phase 8 function-call-external bench${NC}"
echo -e "${BLUE}  iter=$ITER queries=${#QUERIES[@]} out=$OUT_DIR${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
echo ""

if [ -z "$ONLY" ] || [ "$ONLY" = "baseline" ]; then
  echo -e "${CYAN}▶ baseline (FUNCTION_CALL_EXTERNAL_ENABLED=false,fall through to minicpm 自提取)${NC}"
  run_round "baseline"
  BASE_P=$(compute_percentiles "$OUT_DIR/baseline.csv")
  BASE_MAL=$(count_malformed_total "$OUT_DIR/baseline.csv")
  BASE_P50=$(echo "$BASE_P" | cut -d'|' -f1)
  BASE_P95=$(echo "$BASE_P" | cut -d'|' -f2)
  BASE_N=$(echo "$BASE_P" | cut -d'|' -f3)
  echo "  · baseline: n=$BASE_N p50=${BASE_P50}ms p95=${BASE_P95}ms malformed_total=$BASE_MAL"
  echo ""
fi

if [ -z "$ONLY" ] || [ "$ONLY" = "function-call-external" ]; then
  echo -e "${CYAN}▶ function-call-external-enabled (FUNCTION_CALL_EXTERNAL_ENABLED=true)${NC}"
  if [ "$FCX_AVAILABLE" -eq 0 ]; then
    echo -e "  ${YELLOW}· caller 插件未挂载,这次等同于 baseline(diagnostic)${NC}"
  fi
  run_round "function-call-external"
  FCX_P=$(compute_percentiles "$OUT_DIR/function-call-external.csv")
  FCX_MAL=$(count_malformed_total "$OUT_DIR/function-call-external.csv")
  NEEDLE_P50=$(echo "$NEEDLE_P" | cut -d'|' -f1)
  NEEDLE_P95=$(echo "$NEEDLE_P" | cut -d'|' -f2)
  FCX_N=$(echo "$NEEDLE_P" | cut -d'|' -f3)
  echo "  · function-call-external: n=$NEEDLE_N p50=${FCX_P50}ms p95=${FCX_P95}ms malformed_total=$NEEDLE_MAL"
  echo ""
fi

# ── 报告 ─────────────────────────────────────────────────────────────
REPORT="$OUT_DIR/report.md"
{
  echo "# §7.93 Phase 8 function-call-external bench report"
  echo ""
  echo "**timestamp**: $TS"
  echo "**iter × queries**: $ITER × ${#QUERIES[@]} = $(( ITER * ${#QUERIES[@]} ))"
  echo "**out**: \`$OUT_DIR\`"
  echo "**function-call-external available**: $FCX_AVAILABLE"
  echo ""
  echo "## results"
  echo ""
  echo "| tag | n | p50 (ms) | p95 (ms) | malformed_total |"
  echo "|-----|---|----------|----------|-----------------|"
  if [ -z "$ONLY" ] || [ "$ONLY" = "baseline" ]; then
    echo "| baseline | $BASE_N | $BASE_P50 | $BASE_P95 | $BASE_MAL |"
  fi
  if [ -z "$ONLY" ] || [ "$ONLY" = "function-call-external" ]; then
    echo "| function-call-external | $NEEDLE_N | $NEEDLE_P50 | $NEEDLE_P95 | $NEEDLE_MAL |"
  fi
  echo ""
  echo "## interpretation"
  echo ""
  echo "**Goal** (per §7.93.1 plan):function-call-external-enabled p50 < 1500ms, malformed_total → 0."
  echo ""
  echo "**Reality check** (per §7.93 Phase 4.5 dry-run):external caller engine currently"
  echo "degrades 25x (prefill 17-36 tok/s vs spec 436-491),timeout almost"
  echo "always hits at 1500ms. expect:"
  echo "- external circuit breaker OPENS within first request (timeout path)"
  echo "- subsequent requests short-circuit (0ms wall-clock) via"
  echo "  external.circuit_open_skip"
  echo "- if function-call-external 100% short-circuits:external p50 ≈ 0ms,malformed stays"
  echo "  at baseline rate(because LLM 自提取 path is unchanged)"
  echo ""
  echo "**When engine recovers** (post \`docker restart needle-http\` per"
  echo "dry-run #1):expect external p50 ≈ 400-600ms (per API.md §7 spec"
  echo "376-548ms /extract),malformed should drop to 0 for queries where"
  echo "external extracted ≥1 high-confidence call."
  echo ""
  echo "## malformed patterns tracked"
  echo ""
  for p in "${MALFORMED_PATTERNS[@]}"; do
    echo "- \`$p\`"
  done
} > "$REPORT"

echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  bench done — report at $REPORT${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
exit 0