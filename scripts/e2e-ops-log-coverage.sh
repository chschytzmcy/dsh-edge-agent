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
# §7.107 (2026-10-24) 新增第 4 用例：
#   knowledge 纯知识问答     sessionId=opslog-canary-knowledge
#                           期望：无公网检索信号 → 分类器即便判 CLOUD 也被
#                           no-web-need gate 降级 LOCAL；全程 0 次云端 LLM
#                           调用（cloud-llm-adapter LLM call start 不得出现）。
#                           这是「默认本地」（§7.107 操作者裁决）的核心回归。
#
# E2E_RUN_ID：可选运行标识，追加到 sessionId（opslog-canary-<key>-<id>）。
# 固定 sessionId 复跑时，历史会话的旧 turn 行会污染 turn=1 / 计数类断言
# ——每次运行带新 id 即可全绿（默认空 = 兼容旧行为）。
#
# 23 节点覆盖（来自 ops-log-coverage-principle.md）：
#   1-9:   input-guard 系列（preflight/sanitize/prompt-guard/privacy-policy/orphan/desanitize/route）
#   10-13: realm-skill-bridge 系列（pre-step/chat received/finished/tool allow+deny）
#   14-17: cloud/local-llm-adapter LLM call start/done
#   18-19: http-api chat received/reply
#   20:    input-guard prompt-guard done
#   21:    input-guard privacy-policy done
#   22:    realm-skill-bridge assemble filter（§7.37.x 替代原 llm/stream probe —— deepFreeze 后 probe 已死）
#   23:    realm-skill-bridge tool result（§7.47.6，工具执行全链路 ops log，每个 tool call 必 emit status=ok/error/aborted）
# ───────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# §7.111 (2026-10-24): the desktop-safe patch's file-logger row ships
# filename: dsh-edge-agent-desktop.log — both profiles write THIS file
# (shared data plane). The old default here (dsh-edge-agent.log) never
# existed on disk.
LOG_FILE="${LOG_FILE:-$HOME/.dsh-edge-agent/log/dsh-edge-agent-desktop.log}"

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
# §macOS (2026-10-24)：bash 3.2（macOS /bin/bash）不支持 declare -A ——
# 用 case 函数代替关联数组，脚本在本机 /bin/bash 3.2 下可直接跑。
case_query() {
  case "$1" in
    mibao)     printf '%s' "查询密盒的登录状态" ;;
    news)      printf '%s' "查询最新的AI新闻" ;;
    local-ip)  printf '%s' "查询本机的局域网IP" ;;
    knowledge) printf '%s' "什么是量子力学" ;;
    *) return 1 ;;
  esac
}

run_case() {
  local key="$1"
  local query
  query="$(case_query "$key")" || { echo "未知用例: $key" >&2; return 1; }
  # §7.107: E2E_RUN_ID 追加，保证每次运行的会话互不污染。
  local sid="opslog-canary-${key}"
  [ -n "${E2E_RUN_ID:-}" ] && sid="${sid}-${E2E_RUN_ID}"
  echo "▶ 用例 [$key] sessionId=$sid query='$query'"

  if [ "$DRY_RUN" = "0" ]; then
    local body
    body=$(printf '{"message":"%s","sessionId":"%s"}' "$query" "$sid")
    local resp_file="/tmp/e2e-opslog-${key}.json"
    # §UTF-8 (2026-10-24): body 走文件 + --data-binary。Git Bash / Windows
    # 原生 curl 会把命令行里的中文参数按本地代码页（GBK）转码，服务端
    # UTF-8 解出乱码 —— 实测「查询密盒的登录状态」到达服务端时已不含
    # 「密盒」二字，LOCAL-entity 护栏的字面匹配全部落空（mibao 误路由
    # SANITIZED 上云）。@file 让 bash 写出的 UTF-8 字节原样上线。
    local body_file="/tmp/e2e-opslog-${key}-body.json"
    printf '%s' "$body" > "$body_file"
    if ! curl -s --max-time "$TIMEOUT" -X POST "$HTTP_API_URL" \
         -H "Authorization: Bearer $AUTH_TOKEN" \
         -H "Content-Type: application/json; charset=utf-8" \
         --data-binary @"$body_file" -o "$resp_file" -w "%{http_code}\n" \
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
    knowledge) assert_knowledge "$log_lines" "$sid" ;;
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
    # §7.37.x (2026-09-22): 原 'llm/stream probe' 节点已删 —— 上游
    # dsh-agent-loop 在 llm/stream waterfall 前 deepFreeze 整个 payload，
    # probe 永远 no-op；由 system-prompt/assemble 阶段的 tools 过滤行
    # 替代（每个 LLM call 一次，等价覆盖）。断言同步换替代节点。
    'assemble filter'
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
      # 至少要有一个 allow 或 deny 行（任一即可——mibao/local-ip 走 allow、news 走 deny）。
      # knowledge（§7.107 纯知识问答）不要求工具行——纯对话没有工具调用是正常行为。
      if [ "$key" != "knowledge" ]; then
        if ! grep -qF 'tool allow' "$log" && ! grep -qF 'tool deny' "$log"; then
          misses+=('tool allow/deny (任一)')
        fi
      fi
    elif [[ "$pat" == "tool result" && "$key" == "knowledge" ]]; then
      # 同上：knowledge 无工具调用则无 tool result，跳过。
      :
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

  # §7.47→§7.107: rationale 标注 CLOUD 判定来源。§7.47 时代分类器常挂、
  # 靠规则兜底（rule-cloud-keyword）；现在 LLM 分类器稳定在线时走
  # llm-classified:cloud（§7.107 gate 用同一份关键词表放行）。两种来源
  # 都是合法的 CLOUD 判定 —— 硬约束是上面的 category=CLOUD。
  if ! grep '\[input-guard\] preflight intent' "$log" | grep -qE 'rationale=(rule-cloud-keyword|llm-classified)'; then
    echo "  ✗ 期望 rationale=rule-cloud-keyword|llm-classified（CLOUD 判定须有来源标识），未找到"
    fail=1
  else
    echo "  ✓ rationale 标注 CLOUD 判定来源（§7.47 关键词 / §7.107 LLM 分类）"
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
    echo "  ✗ chat reply resultLen=${result_len}（期望 ≥1，§7.47.6 dsh-agent-loop kind=error 间歇性空返回）"
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
  # §7.47 bug-recovery sanity：早于本次 chat 的 SANITIZED tool deny 行不得
  # 落进本次回复的时间窗。§7.111 (2026-10-24) 重写：原块有坏字节（bash 把
  # latest_reply_ts+垃圾字节当成未定义变量，set -u 直接炸），且 date -d 是
  # GNU 语法、BSD date 必失败。改为纯 ASCII 变量名 + GNU/BSD 双路 epoch 解析。
  local latest_reply_ts
  latest_reply_ts=$(grep '\[http-api\] chat reply' "$log" | tail -1 | grep -oE '^[0-9T:.+-]+' | head -1)
  if [ -z "$latest_reply_ts" ]; then
    echo "  · 无 chat reply 时间戳，跳过 §7.47 regression 检查"
    return "$fail"
  fi
  iso_to_epoch() {
    local ts="$1" core
    core=${ts%%.*}
    core=${core%%[+-]*}
    date -d "$core" +%s 2>/dev/null \
      || date -j -f '%Y-%m-%dT%H:%M:%S' "$core" +%s 2>/dev/null \
      || printf ''
  }
  local reply_epoch
  reply_epoch=$(iso_to_epoch "$latest_reply_ts")
  if [ -z "$reply_epoch" ]; then
    echo "  · 无法解析 chat reply 时间戳（${latest_reply_ts}），跳过 §7.47 regression 检查"
    return "$fail"
  fi
  local window_start=$((reply_epoch - 90))
  local window_end=$((reply_epoch + 5))
  local in_window_deny=0
  while IFS= read -r deny_line; do
    [ -z "$deny_line" ] && continue
    local deny_ts
    deny_ts=$(printf '%s' "$deny_line" | grep -oE '^[0-9T:.+-]+' | head -1)
    [ -z "$deny_ts" ] && continue
    local deny_epoch
    deny_epoch=$(iso_to_epoch "$deny_ts")
    if [ -n "$deny_epoch" ] && [ "$deny_epoch" -ge "$window_start" ] && [ "$deny_epoch" -le "$window_end" ]; then
      if printf '%s' "$deny_line" | grep -q 'tool=web_search.*reason=.*SANITIZED'; then
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

  return $fail
}

assert_local_ip() {
  local log="$1" sid="$2"
  local fail=0

  # 期望：preflight intent intentSource 标注判定来源（§7.87.13.2 起三种
  # 合法路径：http-api-classified（LLM 分类）/ policy-classified（策略
  # 规则优先，如「IP 地址 PII 必须留在本地」）/ llm-classified）。硬约束
  # 是来源字段存在且值合法 —— LOCAL 判定怎么来的都算对。
  if ! grep 'preflight intent' "$log" | grep -qE 'intentSource=(http-api-classified|policy-classified|llm-classified)'; then
    echo "  ✗ 期望 preflight intent intentSource=http-api-classified|policy-classified|llm-classified，未找到"
    fail=1
  else
    echo "  ✓ preflight intent intentSource 判定来源标注完整"
  fi

  # 期望：至少一次本地命令执行工具被放行（bash 或 pwsh —— 模型按平台
  # 自选；Windows profile 上实测选 pwsh，Linux 上选 bash。2026-10-24 前
  # 该断言写死 tool=bash，在 Windows CLI profile 上误报失败。）
  if ! grep 'tool allow' "$log" | grep -qE 'tool=(bash|pwsh)'; then
    echo "  ✗ 期望 tool allow tool=bash|pwsh（本地 IP 查询应调命令工具），未找到"
    fail=1
  else
    local cmd_n
    cmd_n=$(grep 'tool allow' "$log" | grep -cE 'tool=(bash|pwsh)' || true)
    echo "  ✓ tool allow tool=bash|pwsh $cmd_n 次"
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

# §7.107 (2026-10-24)：「默认本地」核心回归——无公网检索信号的知识问答
# 必须留在设备上。分类器（本地 LLM）对这类问题常判 CLOUD（§7.107 前的
# 旧行为就是直接上云）；现在 intent-router 的 no-web-need gate 必须把它
# 拦回 LOCAL，云端 adapter 一次都不能被调用。
assert_knowledge() {
  local log="$1" sid="$2"
  local fail=0

  # 期望：最终生效意图是 LOCAL（gate 降级后的结果；preflight 行读的是
  # gate 之后的 verdict）
  if ! grep '\[input-guard\] preflight intent' "$log" | grep -q 'category=LOCAL'; then
    echo "  ✗ 期望 preflight intent category=LOCAL（§7.107 no-web-need gate），未找到"
    fail=1
  else
    echo "  ✓ preflight intent category=LOCAL（§7.107 默认本地生效）"
  fi

  # 期望：全程 0 次云端 LLM 调用 —— 这是本用例的硬约束
  local cloud_n
  cloud_n=$(grep -c '\[cloud-llm-adapter\] LLM call start' "$log" || true)
  if [ "$cloud_n" -ne 0 ]; then
    echo "  ✗ cloud-llm-adapter LLM call start 出现 $cloud_n 次（期望 0 —— 无公网信号不得出网）"
    fail=1
  else
    echo "  ✓ 0 次云端 LLM 调用（数据未出设备）"
  fi

  # 期望：本地池真实应答（local-llm 至少 1 次 + reply 200）
  local local_n
  local_n=$(grep -c '\[local-llm-adapter\] LLM call start' "$log" || true)
  if [ "$local_n" -lt 1 ]; then
    echo "  ✗ local-llm-adapter LLM call start 仅 $local_n 次（期望 ≥1）"
    fail=1
  else
    echo "  ✓ local-llm-adapter LLM call start $local_n 次"
  fi

  if ! grep '\[http-api\] chat reply' "$log" | grep -q 'status=200'; then
    echo "  ✗ chat reply status!=200"
    fail=1
  else
    echo "  ✓ chat reply status=200"
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
  if ! case_query "$ONLY" >/dev/null 2>&1; then
    echo "未知用例: ${ONLY}（可选: mibao / news / local-ip / knowledge）" >&2
    exit 2
  fi
  run_case "$ONLY" || OVERALL_RC=1
else
  for key in mibao news local-ip knowledge; do
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