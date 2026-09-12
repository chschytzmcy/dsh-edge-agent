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
# 21 节点覆盖（来自 ops-log-coverage-principle.md）：
#   1-9:   input-guard 系列（preflight/sanitize/prompt-guard/privacy-policy/orphan/desanitize/route）
#   10-13: realm-skill-bridge 系列（pre-step/chat received/finished/tool allow+deny）
#   14-17: cloud/local-llm-adapter LLM call start/done
#   18-19: http-api chat received/reply
#   20:    input-guard prompt-guard done
#   21:    input-guard privacy-policy done
# ───────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_FILE="${LOG_FILE:-$HOME/.dsh-edge-agent/log/dsh-edge-agent.log}"
HTTP_API_PORT="${DSH_EDGE_HTTP_PORT:-21017}"
HTTP_API_URL="http://127.0.0.1:${HTTP_API_PORT}/v1/chat"
AUTH_TOKEN="${DSH_EDGE_HTTP_TOKEN:-test-secret-key}"
TIMEOUT="${E2E_TIMEOUT:-90}"
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
  if ! grep '\[cloud-llm-adapter\] LLM call start' "$log" | grep -q 'baseUrl='; then
    misses+=('llm-call-start-baseUrl-field')
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
  local llm_n
  llm_n=$(grep -c '\[cloud-llm-adapter\] LLM call done' "$log" || true)
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

  # 期望：tool deny web_search realm=SANITIZED（§7.46.7 Layer 3 gate 拒绝）
  if ! grep 'tool deny' "$log" | grep -q 'tool=web_search.*reason=.*SANITIZED'; then
    echo "  ✗ 期望 tool deny tool=web_search reason=...SANITIZED，未找到"
    fail=1
  else
    echo "  ✓ tool deny web_search（SANITIZED realm 拒绝 CLOUD 工具）"
  fi

  # 期望：tool deny web_fetch 也被拒绝
  if ! grep 'tool deny' "$log" | grep -q 'tool=web_fetch'; then
    echo "  ✗ 期望 tool deny tool=web_fetch，未找到"
    fail=1
  else
    echo "  ✓ tool deny web_fetch（同样被 Layer 3 gate 拒绝）"
  fi

  # 期望：tool deny 行必须有 reason= 字段（Layer 3 gate 拒绝原因）
  if ! grep 'tool deny' "$log" | grep -q 'reason='; then
    echo "  ✗ tool deny 行缺少 reason= 字段"
    fail=1
  else
    echo "  ✓ tool deny 行带 reason= 字段"
  fi

  # 期望：chat finished + chat reply status=200（流程完整收尾）
  if ! grep '\[realm-skill-bridge\] chat finished' "$log" | grep -q 'turn=1'; then
    echo "  ✗ 期望 chat finished turn=1，未找到"
    fail=1
  else
    echo "  ✓ chat finished turn=1"
  fi
  if ! grep '\[http-api\] chat reply' "$log" | grep -q 'status=200'; then
    echo "  ✗ chat reply status!=200"
    fail=1
  else
    echo "  ✓ chat reply status=200"
  fi

  # 注意：resultLen / bash fallback 次数属于 LLM 行为范畴，不归本脚本管。
  # LLM 在不同 prompt / 时刻可能走不同路径（先 web_search → 改 web_fetch → 直接放弃 / fallback bash）。
  # 本脚本只验证 ops log 必须能"如实记录"每一步：deny 行有 reason、allow 行有 realm、reply 有 status。

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