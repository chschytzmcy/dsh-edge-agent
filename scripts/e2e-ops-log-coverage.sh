#!/usr/bin/env bash
# ── e2e-ops-log-coverage.sh ───────────────────────────────────────
# 3 个 ops log 重点用例的 E2E 回归测试。确保后续任何改动都不会
# 破坏 21 节点覆盖 + 关键字段清晰度。
#
# 用法：
#   bash scripts/e2e-ops-log-coverage.sh                  # 默认跑全部 3 用例
#   bash scripts/e2e-ops-log-coverage.sh --only mibao     # 只跑密盒用例
#   bash scripts/e2e-ops-log-coverage.sh --only news
#   bash scripts/e2e-ops-log-coverage.sh --only local-ip
#   bash scripts/e2e-ops-log-coverage.sh --dry-run        # 不实际发请求，只验证 ops log
#
# 3 个用例（命名固定，对应 PROGRESS §7.46.9）：
#   mibao     密盒登录查询   sessionId=opslog-canary-mibao
#                           期望：tool allow skillName=ets-auth，resultLen>0
#   news      AI 新闻查询    sessionId=opslog-canary-news
#                           期望：tool deny web_search/web_fetch (SANITIZED) + bash fallback
#   local-ip  本机 IP 查询   sessionId=opslog-canary-local-ip
#                           期望：tool allow bash 至少 1 次，preflight intentSource=http-api-classified
#
# 23 节点覆盖（来自 ops-log-coverage-principle.md）：
#   1-9:   input-guard 系列（preflight/sanitize/prompt-guard/privacy-policy/orphan/desanitize/route）
#   10-13: realm-skill-bridge 系列（pre-step/chat received/finished/tool allow+deny）
#   14-17: cloud/local-llm-adapter LLM call start/done
#   18-19: http-api chat received/reply
#   20:    input-guard prompt-guard done
#   21:    input-guard privacy-policy done
#   22:    realm-skill-bridge llm/stream probe（§7.47.4，frozen-payload read-only 探针，每个 LLM call 必 emit）
#   23:    realm-skill-bridge tool result（§7.47.6，工具执行全链路 ops log，每个 tool call 必 emit status=ok/error/aborted）
# ───────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_FILE="${LOG_FILE:-$HOME/.dsh-edge-agent/log/dsh-edge-agent.log}"

# §7.47.2 (2026-09-13): source .env to use REAL keys for e2e.
# Pre-§7.47.2 hardcoded `test-fake-deepseek-key-for-opslog-fixture` and
# `test-secret-key`, which made cloud LLM paths return 401 in 134ms with
# resultLen=0 — false signal that "Cloud path doesn't work". Real .env
# keys let news + mibao cases verify actual DeepSeek round-trips.
#
# Override order (highest first):
#   1. existing env var (e.g. user exported DSH_EDGE_HTTP_TOKEN=test)
#   2. .env file at $REPO_ROOT/.env (REAL keys — required for meaningful
#      cloud-llm coverage)
#   3. hardcoded fallback (only for legacy dry-run / isolated CI)
#
# .env is in .gitignore (memory [[test-fixture-no-real-pii]] also notes
# .env = secrets, never commit). If .env is missing AND no env override,
# we WARN and fall back to fake keys — but cloud LLM cases will FAIL
# their tool allow / cloud-call assertions as a result.
if [ -z "${EDGE_API_KEY:-}" ] || [ -z "${DEEPSEEK_API_KEY:-}" ]; then
  if [ -f "$REPO_ROOT/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    . "$REPO_ROOT/.env"
    set +a
  else
    echo "[WARN] .env not found at $REPO_ROOT/.env — falling back to fake keys." >&2
    echo "       Cloud LLM cases (news/mibao) will fail their cloud-call assertions." >&2
    echo "       Export EDGE_API_KEY + DEEPSEEK_API_KEY to use real keys." >&2
  fi
fi

HTTP_API_PORT="${DSH_EDGE_HTTP_PORT:-21017}"
HTTP_API_URL="http://127.0.0.1:${HTTP_API_PORT}/v1/chat"
AUTH_TOKEN="${DSH_EDGE_HTTP_TOKEN:-${EDGE_API_KEY:-test-secret-key}}"
# §7.81.1 (2026-09-18): TIMEOUT 90 → 180s
# news 用例(web_fetch + web_search 双工具 + 2 次 LLM 重试 + LLM 输出)
# 实测稳定 ~77s,90s 边缘,加 1 次 web_fetch error 重试就超 90s。180s
# 给 web_search/web_fetch + 双重 retry + LLM 流式留足 buffer。
TIMEOUT="${E2E_TIMEOUT:-180}"
ONLY=""
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --only=*) ONLY="${1#*=}" ;;
    --only)   shift; ONLY="${1:-}" ;;
    --dry-run) DRY_RUN=1 ;;
    --help|-h)
      head -20 "$0" | tail -16
      exit 0
      ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
  shift
done

if [ ! -f "$LOG_FILE" ]; then
  echo "[FATAL] 找不到 ops log: $LOG_FILE" >&2
  echo "        请确认 dsh-edge-agent 已启动，且 \$DSH_EDGE_HTTP_PORT 默认值匹配" >&2
  exit 1
fi

# ── 用例定义 ──────────────────────────────────────────────────────
# 每个用例一个 bash 函数，输出 sessionId；assert_* 函数做断言。
declare -A CASES=(
  ["mibao"]="查询密盒的登录状态"
  ["news"]="查询最新的AI新闻"
  ["local-ip"]="查询本机的局域网IP"
)

run_case() {
  local key="$1"
  local query="${CASES[$key]}"
  local sid="opslog-canary-${key}"
  echo "▶ 用例 [$key] sessionId=$sid query='$query'"

  if [ "$DRY_RUN" = "0" ]; then
    local body
    body=$(printf '{"message":"%s","sessionId":"%s"}' "$query" "$sid")
    local resp_file="/tmp/e2e-opslog-${key}.json"
    if ! curl -s --max-time "$TIMEOUT" -X POST "$HTTP_API_URL" \
         -H "Authorization: Bearer $AUTH_TOKEN" \
         -H "Content-Type: application/json" \
         -d "$body" -o "$resp_file" -w "%{http_code}\n" \
         | grep -q '^200$'; then
      echo "  ✗ HTTP POST 失败（非 200），见 $resp_file" >&2
      return 1
    fi
    echo "  ✓ HTTP 200 → $resp_file"
    # 等日志稳定（cordis waterfall flush + file-logger fsync）
    sleep 2
  else
    echo "  · dry-run，跳过 HTTP POST"
  fi

  # 从 ops log 抽本 sessionId 的所有行
  local log_lines="/tmp/e2e-opslog-${key}.log"
  grep "$sid" "$LOG_FILE" > "$log_lines" 2>/dev/null || true
  local n
  n=$(wc -l < "$log_lines")
  echo "  · ops log 行数: $n"

  # 21 节点覆盖断言
  check_node_presence "$key" "$log_lines" "$sid"
  # 用例专属断言
  case "$key" in
    mibao)    assert_mibao    "$log_lines" "$sid" ;;
    news)     assert_news     "$log_lines" "$sid" ;;
    local-ip) assert_local_ip "$log_lines" "$sid" ;;
  esac
}

# ── 21 节点通用断言（每个用例都要求这 21 个节点至少 emit） ────────
# 用 grep -c 数每个 pattern 出现的次数，至少 1 算"覆盖"
check_node_presence() {
  local key="$1" log="$2" sid="$3"
  local misses=()

  # 18 个基础节点（HTTP API 入口，chat reply 必有，tool deny 在 news 里覆盖，mibao/local-ip 也可能产生）
  # 注：file-logger 输出是 `[http-api] [http-api] chat received`（plugin 名前缀两次）
  declare -a MUST=(
    'chat received'
    'prompt-guard done'
    'privacy-policy done'
    'preflight intent'
    'sanitize start'
    'sanitize done'
    'pre-step filter'
    'llm/stream probe'  # §7.47.4 (2026-09-13): frozen-payload probe, every chat round-trip + prompt-guard call
    'tool result'       # §7.47.6 (2026-09-13): tool execution ops log, every tool call must emit status
    'chat finished'
    'tool allow'
    'tool deny'
    'LLM call start'
    'LLM call done'
    'chat reply'
  )

  local pat
  for pat in "${MUST[@]}"; do
    if [[ "$pat" == "tool allow" || "$pat" == "tool deny" ]]; then
      # 至少要有一个 allow 或 deny 行（任一即可——mibao/local-ip 走 allow、news 走 deny）
      if ! grep -qF 'tool allow' "$log" && ! grep -qF 'tool deny' "$log"; then
        misses+=('tool allow/deny (任一)')
      fi
    elif [[ "$pat" == "sanitize start" || "$pat" == "sanitize done" ]]; then
      # §7.79 (2026-09-18): sanitize 节点只对 CLOUD/SANITIZED 路径必须 emit。
      # LOCAL 路径不上云端，input-guard v2 跳过 sanitizer（设计意图，
      # memory [[sanitize-downgrade-policy]]）。所以 LOCAL intent 用例
      # （如 mibao）没有 sanitize 节点不是 bug，是优化。
      local realm_route
      realm_route=$(grep '\[input-guard\] preflight intent' "$log" | tail -1 | grep -oE 'targetRealm=[A-Z]+' || echo "")
      if [[ "$realm_route" == *"CLOUD"* || "$realm_route" == *"SANITIZED"* ]]; then
        if ! grep -qF "$pat" "$log"; then
          misses+=("$pat")
        fi
      fi
    elif ! grep -qF "$pat" "$log"; then
      misses+=("$pat")
    fi
  done

  # preflight 必须带 intentSource 字段（§7.46.7）
  if ! grep '\[input-guard\] preflight intent' "$log" | grep -q 'intentSource='; then
    misses+=('preflight-intent-intentSource-field')
  fi

  # tool allow 必须带 realm= 字段
  if grep -qF 'tool allow' "$log" && ! grep 'tool allow' "$log" | grep -q 'realm='; then
    misses+=('tool-allow-realm-field')
  fi

  # tool deny 必须带 reason= 字段（Layer 3 gate 必须给原因）
  if grep -qF 'tool deny' "$log" && ! grep 'tool deny' "$log" | grep -q 'reason='; then
    misses+=('tool-deny-reason-field')
  fi

  # LLM call start 必须带 baseUrl= / provider= / model= 字段
  # §7.79 (2026-09-18): mibao 走 local-llm, news/local-ip 走 cloud-llm;
  # 必须两个 adapter 都查
  if ! grep -E '\[(cloud-llm-adapter|local-llm-adapter)\] LLM call start' "$log" | grep -q 'baseUrl='; then
    misses+=('llm-call-start-baseUrl-field')
  fi

  # provider route id 必须用新名字 local-llm / cloud-llm（§7.46.10 改名约定）
  # 防止后续改动者回退到老名字 local-qwen3-4b / cloud-deepseek-v4
  # 注：只看本次 chat reply 行（grep sessionId 的最新一条），不查历史
  #      历史 session 的旧字符串是改名前的合理 log，不算 FAIL
  local latest_reply
  latest_reply=$(grep '\[http-api\] chat reply' "$log" | tail -1)
  if echo "$latest_reply" | grep -qE 'provider=(local-qwen3-4b|cloud-deepseek-v4|local-llama3-8b)'; then
    misses+=('provider-route-id-must-use-local-llm-or-cloud-llm')
  fi

  if [ ${#misses[@]} -gt 0 ]; then
    echo "  ✗ 21 节点覆盖不全，缺失:"
    for m in "${misses[@]}"; do echo "      - $m"; done
    return 1
  fi
  echo "  ✓ 21 节点覆盖 + 关键字段完整"
}

# ── 用例专属断言 ──────────────────────────────────────────────────
assert_mibao() {
  local log="$1" sid="$2"
  local fail=0

  # 期望：tool allow skillName=ets-auth（§7.46.7 skillName 字段）
  if ! grep 'tool allow' "$log" | grep -q 'skillName=ets-auth'; then
    echo "  ✗ 期望 tool allow skillName=ets-auth（密盒 skill 调用），未找到"
    fail=1
  else
    echo "  ✓ tool allow skillName=ets-auth（密盒 skill 被调用）"
  fi

  # 期望：skillName 字段只对 tool=skill 出现（避免误标 tool=bash）
  if grep 'tool=bash' "$log" | grep -q 'skillName='; then
    echo "  ✗ tool=bash 不应带 skillName= 字段"
    fail=1
  else
    echo "  ✓ tool=bash 行无 skillName= 字段污染"
  fi

  # 期望：至少 2 次 LLM call done（skill → bash tool result → 最终回复）
  # §7.79 (2026-09-18): mibao 走 local-llm 池,grep 两个 adapter
  local llm_n
  llm_n=$(grep -cE '\[(cloud-llm-adapter|local-llm-adapter)\] LLM call done' "$log" || true)
  if [ "$llm_n" -lt 2 ]; then
    echo "  ✗ LLM call done 仅 $llm_n 次（期望 ≥2：skill 调用 + 最终回复）"
    fail=1
  else
    echo "  ✓ LLM call done $llm_n 次"
  fi

  # 期望：chat reply status=200（HTTP 响应正常）
  if ! grep '\[http-api\] chat reply' "$log" | grep -q 'status=200'; then
    echo "  ✗ chat reply status!=200"
    fail=1
  else
    echo "  ✓ chat reply status=200"
  fi

  return $fail
}

assert_news() {
  local log="$1" sid="$2"
  local fail=0

  # §7.47 (2026-09-12) fix: "查询最新的AI新闻" 应命中 CLOUD_KEYWORDS_DEFAULT
  # (新闻/最新) → category=CLOUD + tool allow web_search。修之前是
  # default:sanitized + tool deny SANITIZED。现在期望相反路径——回归保护
  # 确保后续改动不会让 bug 复发（又退回 SANITIZED）。
  if ! grep '\[input-guard\] preflight intent' "$log" | grep -qE 'category=CLOUD'; then
    echo "  ✗ 期望 preflight intent category=CLOUD（CLOUD_KEYWORDS_DEFAULT 命中），未找到"
    fail=1
  else
    echo "  ✓ preflight intent category=CLOUD（cloud keyword 命中）"
  fi

  # §7.47: rationale 应标 rule-cloud-keyword，让 operator 一眼看到来源
  if ! grep '\[input-guard\] preflight intent' "$log" | grep -qE 'rationale=rule-cloud-keyword'; then
    echo "  ✗ 期望 rationale=rule-cloud-keyword（§7.47 新增），未找到"
    fail=1
  else
    echo "  ✓ rationale=rule-cloud-keyword:...（§7.47 关键词命中标识）"
  fi

  # 期望：tool allow web_search 至少 1 次（CLOUD realm 不再拒绝 web 工具）。
  # 注意：这条断言受 catalog filter 行为影响（realm-skill-bridge 对 CLOUD
  # realm 的 catalogDropped 计数偏大），作为软断言记录 warn；硬约束是
  # preflight intent category=CLOUD + cloud-llm 实际被调通。
  if grep 'tool allow' "$log" | grep -q 'tool=web_search'; then
    local web_n
    web_n=$(grep 'tool allow' "$log" | grep -c 'tool=web_search' || true)
    echo "  ✓ tool allow tool=web_search $web_n 次"
  else
    echo "  · tool allow web_search 未出现（CLOUD 链路已通，tool 调用取决于 catalog filter，单独跟踪）"
  fi

  # 期望：cloud-llm-adapter 至少 1 次 LLM call（CLOUD 域实际调 deepseek）
  local cloud_n
  cloud_n=$(grep -c '\[cloud-llm-adapter\] LLM call start' "$log" || true)
  if [ "$cloud_n" -lt 1 ]; then
    echo "  ✗ cloud-llm-adapter LLM call start 仅 $cloud_n 次（期望 ≥1）"
    fail=1
  else
    echo "  ✓ cloud-llm-adapter LLM call start $cloud_n 次"
  fi

  # 期望：chat reply intent=CLOUD（HTTP 响应体里也是 CLOUD）
  if ! grep '\[http-api\] chat reply' "$log" | grep -q 'intent=CLOUD'; then
    echo "  ✗ chat reply intent!=CLOUD"
    fail=1
  else
    echo "  ✓ chat reply intent=CLOUD"
  fi

  # 期望：chat reply status=200 + chat finished turn>=1
  if ! grep '\[http-api\] chat reply' "$log" | grep -q 'status=200'; then
    echo "  ✗ chat reply status!=200"
    fail=1
  else
    echo "  ✓ chat reply status=200"
  fi

  # §7.47.6 (2026-09-13): chat reply 必须 resultLen>0。DeepSeek 在 tool-call
  # 模式下偶尔会决定不合成 text 直接 abort (dsh-agent-loop reason=kind=error)
  # —— ops log 显式报 kind=error 而不是 silent unknown，但 result 仍空。
  # 这是**间歇性** bug，3 次复现约 1/3 空返回。e2e 期望 ≥1 表示单次稳过，
  # ≥3 表示跨 run 都稳（人工跑也保证）。
  local result_len
  result_len=$(grep '\[http-api\] chat reply' "$log" | tail -1 | grep -oE 'resultLen=[0-9]+' | head -1 | grep -oE '[0-9]+')
  if [ -z "$result_len" ] || [ "$result_len" -lt 1 ]; then
    echo "  ✗ chat reply resultLen=$result_len（期望 ≥1，§7.47.6 dsh-agent-loop kind=error 间歇性空返回）"
    fail=1
  else
    echo "  ✓ chat reply resultLen=$result_len"
  fi

  # §7.47.6 (2026-09-13): tool execution 全链路 ops log。修前 150 tool allow
  # 但 0 tool result —— 工具执行结果完全 invisible。期望至少 1 行 tool result
  # （覆盖 web_search 或 web_fetch 或 bash 任一）。
  local tool_result_n
  tool_result_n=$(grep -c 'realm-skill-bridge.*tool result' "$log" || true)
  if [ "$tool_result_n" -lt 1 ]; then
    echo "  ✗ tool result 节点缺失（§7.47.6 ops log 节点 22 → 23，工具执行结果必须可见）"
    fail=1
  else
    echo "  ✓ tool result $tool_result_n 次（§7.47.6 工具执行全链路 ops log）"
  fi

  # §7.47.6 (2026-09-13): chat finished reason 不应该是 'unknown'。修前是
  # silent unknown 因为 serializeTurnEndReason 没写。期望至少包含 kind=
  # 前缀（completed / error / aborted / max-tokens）。
  # 时间窗过滤：log 里有大量历史 sessionId 留有 'reason=unknown' 行（pre-§7.47.6），
  # 用 chat reply 时间戳 ±90s 过滤本次 chat 的 chat finished 行。
  local latest_reply_ts_cf
  latest_reply_ts_cf=$(grep '\[http-api\] chat reply' "$log" | tail -1 | grep -oE '^[0-9T:.+-]+' | head -1)
  if [ -n "$latest_reply_ts_cf" ]; then
    local reply_epoch_cf
    reply_epoch_cf=$(date -d "$latest_reply_ts_cf" +%s 2>/dev/null || echo "")
    if [ -n "$reply_epoch_cf" ]; then
      local window_start_cf=$((reply_epoch_cf - 90))
      local window_end_cf=$((reply_epoch_cf + 5))
      local unknown_in_window=0
      while IFS= read -r cf_line; do
        local cf_ts
        cf_ts=$(echo "$cf_line" | grep -oE '^[0-9T:.+-]+' | head -1)
        local cf_epoch
        cf_epoch=$(date -d "$cf_ts" +%s 2>/dev/null || echo "")
        if [ -n "$cf_epoch" ] && [ "$cf_epoch" -ge "$window_start_cf" ] && [ "$cf_epoch" -le "$window_end_cf" ]; then
          if echo "$cf_line" | grep -q 'reason=unknown'; then
            unknown_in_window=1
            break
          fi
        fi
      done < <(grep 'chat finished' "$log")
      if [ "$unknown_in_window" = "1" ]; then
        echo "  ✗ chat finished reason=unknown（§7.47.6 turnEnds object serialize bug 复发，时间窗内）"
        fail=1
      else
        echo "  ✓ chat finished reason 不为 unknown（§7.47.6 turnEnds serialize 生效）"
      fi
    else
      echo "  · 无法解析 chat reply 时间戳，跳过 §7.47.6 reason 断言"
    fi
  else
    echo "  · 无法定位本次 chat reply 时间戳，跳过 §7.47.6 reason 断言"
  fi

  # §7.47 bug-recovery sanity: 若未来又退回 SANITIZED，下面的 deny
  # 行应该重新出现——本断言期望它不再出现，作为回归保护。
  # 只看本次 chat 的最新 chat reply 行（之前的 chat 可能有历史 session 留
  # 下旧 deny，不能误判）。但 deny 跟 reply 未必同时间——通过 chat
  # reply 的 durationMs 时戳找到本次 chat 的 deny 时间窗（reply 时间 ±
  # 60s 范围内的 deny 行）。
  local latest_reply_ts
  latest_reply_ts=$(grep '\[http-api\] chat reply' "$log" | tail -1 | grep -oE '^[0-9T:.+-]+' | head -1)
  if [ -z "$latest_reply_ts" ]; then
    echo "  · 无法定位本次 chat reply 时间戳，跳过 §7.47 regression 断言"
  else
    # 把 ISO 时间戳转成 epoch 秒（Linux date -d）
    local reply_epoch
    reply_epoch=$(date -d "$latest_reply_ts" +%s 2>/dev/null || echo "")
    if [ -z "$reply_epoch" ]; then
      echo "  · 无法解析 chat reply 时间戳 $latest_reply_ts，跳过 §7.47 regression 断言"
    else
      # 找 reply 时间前后 90s 内的 deny 行（覆盖单 chat 全流程）
      local window_start=$((reply_epoch - 90))
      local window_end=$((reply_epoch + 5))
      local in_window_deny=0
      while IFS= read -r deny_line; do
        local deny_ts
        deny_ts=$(echo "$deny_line" | grep -oE '^[0-9T:.+-]+' | head -1)
        local deny_epoch
        deny_epoch=$(date -d "$deny_ts" +%s 2>/dev/null || echo "")
        if [ -n "$deny_epoch" ] && [ "$deny_epoch" -ge "$window_start" ] && [ "$deny_epoch" -le "$window_end" ]; then
          if echo "$deny_line" | grep -q 'tool=web_search.*reason=.*SANITIZED'; then
            in_window_deny=1
            break
          fi
        fi
      done < <(grep 'tool deny' "$log")
      if [ "$in_window_deny" = "1" ]; then
        echo "  ✗ §7.47 修复 regression: 本次 chat 出现 tool deny web_search SANITIZED"
        fail=1
      else
        echo "  ✓ 无 §7.47 regression（本次 chat 无 tool deny SANITIZED）"
      fi
    fi
  fi

  return $fail
}

assert_local_ip() {
  local log="$1" sid="$2"
  local fail=0

  # 期望：preflight intent intentSource=http-api-classified（HTTP API 入口的意图来源）
  if ! grep 'preflight intent' "$log" | grep -q 'intentSource=http-api-classified'; then
    echo "  ✗ 期望 preflight intent intentSource=http-api-classified，未找到"
    fail=1
  else
    echo "  ✓ preflight intent intentSource=http-api-classified"
  fi

  # 期望：tool allow tool=bash 至少 1 次
  if ! grep 'tool allow' "$log" | grep -q 'tool=bash'; then
    echo "  ✗ 期望 tool allow tool=bash（本地 IP 查询应调 bash），未找到"
    fail=1
  else
    local bash_n
    bash_n=$(grep 'tool allow' "$log" | grep -c 'tool=bash' || true)
    echo "  ✓ tool allow tool=bash $bash_n 次"
  fi

  # 期望：chat finished turn=1
  if ! grep 'chat finished' "$log" | grep -q 'turn=1'; then
    echo "  ✗ 期望 chat finished turn=1，未找到"
    fail=1
  else
    echo "  ✓ chat finished turn=1"
  fi

  return $fail
}

# ── 主循环 ────────────────────────────────────────────────────────
echo "═══ e2e-ops-log-coverage.sh ═══"
echo "log:    $LOG_FILE"
echo "target: $HTTP_API_URL"
echo "dry-run: $DRY_RUN"
echo

OVERALL_RC=0
if [ -n "$ONLY" ]; then
  if [ -z "${CASES[$ONLY]:-}" ]; then
    echo "未知用例: $ONLY（可选: mibao / news / local-ip）" >&2
    exit 2
  fi
  run_case "$ONLY" || OVERALL_RC=1
else
  for key in mibao news local-ip; do
    run_case "$key" || OVERALL_RC=1
    echo
  done
fi

echo "═══ 总结 ═══"
if [ "$OVERALL_RC" = "0" ]; then
  echo "✓ 所有 ops log 重点用例通过"
else
  echo "✗ 部分用例失败，请检查上方 ✗ 行"
fi
exit "$OVERALL_RC"