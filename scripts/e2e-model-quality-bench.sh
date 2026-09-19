#!/usr/bin/env bash
# §7.87(2026-09-18) Model Quality Bench — single-model E2E scoring harness
#
# 用途:给定一个 local LLM baseUrl,跑 10 个 category(共 145 fixtures × 3 iter = 435 次 LLM 调用),
#       输出每类分数 + 最终 0-100 分 + verdict 建议。每次跑 = 1 份报告;多次跑横向对比。
#
# 入口:
#   bash scripts/e2e-model-quality-bench.sh [--label NAME] [--only C1,C7] [--strict] [--dry-run]
#
# env 来源:.env(LOCAL_LLM_BASEURL / LOCAL_LLM_MODEL / EDGE_API_KEY)
#
# 落点:dist/bench-${LABEL}-${TS}/{report.md, scores.json, traces/*}  —— git-ignored
#
# 设计参考:scripts/e2e-ops-log-coverage.sh(banner/arg parse 风格)
# 评分主体:scripts/e2e-model-quality-bench/harness.py

set -euo pipefail

# ── ANSI colors ─────────────────────────────────────────────────────
BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

# ── Locate script directory + repo root ──────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# §7.87.1(2026-09-18):SCRIPT_DIR 是 scripts/,一层 .. 就回到 REPO_ROOT。
# 之前写 ../.. 导致 harness 把 dist/bench-* 写到 /home/etsme/cy/agent/dist/
# (repo root 之上的兄弟目录)而不是项目内 dist/。修一层即可。
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HARNESS="$SCRIPT_DIR/e2e-model-quality-bench/harness.py"
FIXTURES_DIR="$SCRIPT_DIR/e2e-model-quality-bench/fixtures"

# §7.87.1 防再犯:REPO_ROOT 必须包含 cordis.patch.yml + package.json,否则
# harness 会把 dist/bench-* 写到错误位置。fail-fast 不浪费 10 分钟。
if [[ ! -f "$REPO_ROOT/cordis.patch.yml" || ! -f "$REPO_ROOT/package.json" ]]; then
    echo "${RED}✗ REPO_ROOT sanity check failed: $REPO_ROOT${NC}" >&2
    echo "${RED}  期望含 cordis.patch.yml + package.json;实际没有 → REPO_ROOT 路径错了${NC}" >&2
    echo "${RED}  bench harness 会把输出写到错误位置。检查 SCRIPT_DIR/.. 深度(§7.87.1 教训)${NC}" >&2
    exit 2
fi

# ── Source .env if present (for LOCAL_LLM_BASEURL / LOCAL_LLM_MODEL / EDGE_API_KEY) ──
if [[ -f "$REPO_ROOT/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "$REPO_ROOT/.env"
    set +a
fi

# ── Defaults (overridable via CLI / env) ─────────────────────────────
LABEL="${BENCH_LABEL:-bench}"
# §7.87.4(2026-09-19)iterations 默认 1(temp=0 deterministic,3 iter 是浪费);
# latency 默认跳(latency 是 throughput 不是 quality)。
ITERATIONS="${BENCH_ITERATIONS:-1}"
SKIP_LATENCY="${BENCH_SKIP_LATENCY:-1}"  # §7.87.4 baseline 默认 skip
WITH_LATENCY=0
STRICT=0
DRY_RUN=0
ONLY=""
NO_THINKING=0  # §7.87.2(2026-09-18):thinking-model 关掉 reasoning
API_KEY="${DASHSCOPE_API_KEY:-${OPENAI_API_KEY:-}}"     # §7.87.2(2026-09-19):cloud LLM Bearer auth;§7.87.3 从 env 自动读,避免 key 进 ps cmdline
BASE_URL="${LOCAL_LLM_BASEURL:-http://127.0.0.1:8080/v1}"
MODEL="${LOCAL_LLM_MODEL:-unknown}"
DSH_URL="${DSH_EDGE_HTTP_URL:-http://127.0.0.1:21017/v1}"
DSH_TOKEN="${EDGE_API_KEY:-}"
LOG_FILE="${DSH_EDGE_LOG_FILE:-$HOME/.dsh-edge-agent/log/dsh-edge-agent.log}"

# ── Usage ──────────────────────────────────────────────────────────
usage() {
    cat <<EOF
${BLUE}═══ Model Quality Bench ═══${NC}

Usage:
  $(basename "$0") [options]

Options:
  --label NAME         Run label (default: bench). Used for output dir name.
  --model NAME         Model name (default: \$LOCAL_LLM_MODEL)
  --base-url URL       LLM base URL (default: \$LOCAL_LLM_BASEURL)
  --dsh-url URL        dsh-edge HTTP API URL (default: \$DSH_EDGE_HTTP_URL or :21017)
  --dsh-token TOKEN    Bearer token (default: \$EDGE_API_KEY)
  --iterations N       Iterations per case (default: 3)
  --only C1,C2,...     Run only specified categories (e.g. C1,C7,C10)
  --strict             Exit 1 if final score < threshold
  --dry-run            Validate setup + fixtures, don't run benchmarks
  --log-file PATH      dsh-edge log file for pipeline E2E assertions
  --api-key TOKEN      Bearer token for the LLM baseUrl (cloud LLMs).
                       If unset, no Authorization header sent.
  --no-thinking        Skip chain-of-thought (qwen3.5/QwQ/DeepSeek-R1). Passes
                       chat_template_kwargs={enable_thinking:False} to every LLM call.
  --c10-timeout SECS   Per-turn timeout for C10 multi-turn (default 180).
                       Increase to 600+ for thinking models.
  --skip-latency       Skip latency profiling (DEFAULT — latency is throughput, not quality).
  --with-latency       Force-enable latency profiling (overrides --skip-latency).
  --help               Show this help

Environment variables (auto-sourced from repo .env):
  LOCAL_LLM_BASEURL    LLM base URL (e.g. http://67.0.0.5:28001/v1)
  LOCAL_LLM_MODEL      Model name (e.g. qwen3.5-9b)
  EDGE_API_KEY         Bearer token for dsh-edge /v1/chat

Output:
  dist/bench-\${LABEL}-\${TIMESTAMP}/report.md   Human-readable report
  dist/bench-\${LABEL}-\${TIMESTAMP}/scores.json Machine-readable scores
  dist/bench-\${LABEL}-\${TIMESTAMP}/traces/*    Per-request LLM traces

Example:
  make e2e-benchmark LABEL=qwen3.5-9b-lan
  bash scripts/e2e-model-quality-bench.sh --label qwen3.5-9b --dry-run
  bash scripts/e2e-model-quality-bench.sh --only C1,C7 --iterations 1

Notes:
  - 默认信息输出(exit 0);--strict 才按阈值 fail-fast
  - 不进 CI(单跑 ~8-12 分钟 + LAN 依赖);手动跑
  - 多次跑不同 baseUrl 即横向对比(对比 diff 见 README.md)
EOF
    exit 0
}

# ── Arg parsing ────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --label)        LABEL="$2"; shift 2 ;;
        --model)        MODEL="$2"; shift 2 ;;
        --base-url)     BASE_URL="$2"; shift 2 ;;
        --dsh-url)      DSH_URL="$2"; shift 2 ;;
        --dsh-token)    DSH_TOKEN="$2"; shift 2 ;;
        --iterations)   ITERATIONS="$2"; shift 2 ;;
        --only)         ONLY="$2"; shift 2 ;;
        --strict)       STRICT=1; shift ;;
        --dry-run)      DRY_RUN=1; shift ;;
        --api-key)      API_KEY="$2"; shift 2 ;;
        --no-thinking)  NO_THINKING=1; shift ;;
        --c10-timeout)  HARNESS_ARGS+=(--c10-timeout "$2"); shift 2 ;;
        --skip-latency) SKIP_LATENCY=1; shift ;;
        --with-latency) WITH_LATENCY=1; SKIP_LATENCY=0; shift ;;
        --log-file)     LOG_FILE="$2"; shift 2 ;;
        --help|-h)      usage ;;
        *) echo "${RED}Unknown arg: $1${NC}" >&2; exit 2 ;;
    esac
done

# ── Pre-flight: harness + fixtures exist ──────────────────────────
if [[ ! -f "$HARNESS" ]]; then
    echo "${RED}✗ Harness not found: $HARNESS${NC}" >&2
    exit 1
fi
if [[ ! -d "$FIXTURES_DIR" ]]; then
    echo "${RED}✗ Fixtures dir not found: $FIXTURES_DIR${NC}" >&2
    exit 1
fi

# ── Pre-flight: python3 + optional deps ───────────────────────────
if ! command -v python3 >/dev/null 2>&1; then
    echo "${RED}✗ python3 not found${NC}" >&2
    exit 1
fi

PY_MISSING=()
python3 -c "import jieba" 2>/dev/null || PY_MISSING+=("jieba")
python3 -c "import sklearn" 2>/dev/null || PY_MISSING+=("scikit-learn")
python3 -c "import tiktoken" 2>/dev/null || PY_MISSING+=("tiktoken")
if [[ ${#PY_MISSING[@]} -gt 0 ]]; then
    echo "${YELLOW}⚠ Missing Python packages: ${PY_MISSING[*]}${NC}" >&2
    echo "${YELLOW}  Some scoring may fall back to stdlib (less accurate).${NC}" >&2
    echo "${YELLOW}  Install with: pip install ${PY_MISSING[*]}${NC}" >&2
fi

# ── Pre-flight: bash syntax self-check ─────────────────────────────
echo "${BLUE}═══ Model Quality Bench — ${LABEL} ═══${NC}"
echo "  Model    : ${MODEL}"
echo "  Base URL : ${BASE_URL}"
echo "  Dsh URL  : ${DSH_URL}"
echo "  Iter     : ${ITERATIONS}"
[[ -n "$ONLY" ]] && echo "  Only     : ${ONLY}"
[[ "$STRICT" -eq 1 ]] && echo "  Strict   : yes (threshold-based exit)"
[[ "$DRY_RUN" -eq 1 ]] && echo "  Dry-run  : yes"
echo ""

# ── Build harness args ─────────────────────────────────────────────
HARNESS_ARGS=(
    --base-url "$BASE_URL"
    --model "$MODEL"
    --label "$LABEL"
    --iterations "$ITERATIONS"
    --dsh-url "$DSH_URL"
    --dsh-token "$DSH_TOKEN"
    --log-file "$LOG_FILE"
)
[[ -n "$ONLY" ]] && HARNESS_ARGS+=(--only "$ONLY")
[[ "$STRICT" -eq 1 ]] && HARNESS_ARGS+=(--strict)
[[ "$DRY_RUN" -eq 1 ]] && HARNESS_ARGS+=(--dry-run)
[[ "$NO_THINKING" -eq 1 ]] && HARNESS_ARGS+=(--no-thinking)
[[ -n "$API_KEY" ]] && HARNESS_ARGS+=(--api-key "$API_KEY")
# §7.87.4(2026-09-19)latency 默认跳;--with-latency 显式开
if [[ "$SKIP_LATENCY" -eq 1 && "$WITH_LATENCY" -eq 0 ]]; then
    HARNESS_ARGS+=(--skip-latency)
fi

# ── Run harness ────────────────────────────────────────────────────
cd "$REPO_ROOT"
# §7.87.1:PYTHONUNBUFFERED=1 防 stdout 重定向到 file 后 Python 默认 buffered,
# 看实时进度必须 unbuffered(否则 8min 跑完才一次性 flush,operator 看不出卡哪)
PYTHONUNBUFFERED=1 python3 "$HARNESS" "${HARNESS_ARGS[@]}"
RC=$?

exit "$RC"
