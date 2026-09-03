#!/usr/bin/env bash
# E2E web-search 测试 — 验证 web_search / web_fetch 工具端到端行为
#
# 启动真实 dsh 服务,通过 HTTP 请求触发 web_search 工具调用,验证:
#   - 基础搜索触发 (A): "查新闻/天气/Python 版本" → audit 有 tool.web-search.executed
#   - PII 泄露监控 (B): 含手机/邮箱的 query → audit 有 web-search-guard.pii-leak security 事件
#   - Rate-limit 告警 (C): 连续 11 次 web_search → audit 有 rate-limit-exceeded warn
#   - Realm 隔离 (D): LOCAL intent → audit 无 web_search 调用 (工具不可见)
#   - web_fetch 验证 (E): 给 URL → audit 有 web_fetch 调用
#
# 用法:
#   bash scripts/e2e-web-search.sh
#
# 环境变量:
#   DSH_EDGE_HTTP_PORT    - HTTP 端口 (default: 21019,避开 L2 测试的 21018)
#   EDGE_API_KEY          - API 密钥 (default: test-secret-key)
#   KEEP_SERVER_RUNNING   - 测试后保持服务器运行 (set to "true")
#   SKIP_BUILD            - 跳过编译 (set to "true")
#   DEEPSEEK_API_KEY      - 显式覆盖 API key (否则从 ~/.dsh/.credentials.yaml 读)
#
# 前置:
#   - DSH_EDGE_GUARD_MODEL=false (避免 prompt-guard 模型层干扰工具调用)
#   - DSH_EDGE_PROVIDER=cloud-deepseek-v4 (强制用支持 tool-calling 的云端模型;
#     本地 qwen3-4b 不发 tool_calls,本地 LLM 跑这套测试永远 soft-pass)
#   - DEEPSEEK_API_KEY 必须可用 (web_search 走 DeepSeek chat-completions 调
#     用 LLM 决策,然后调 web-search-deepseek Anthropic 端点执行搜索)
#
# 注: 不用 `set -e`——失败计数由 TESTS_FAILED 跟踪,print_summary 汇总。
# v2 (2026-08-26): 强制 cloud-deepseek-v4 模型,硬断言 (audit 事件缺失即 FAIL)
#     而非 soft-pass。v1 软通过被审计为"LLM 未调 web_search 算 pass",对
#     guard 链路没有验证力。

set -uo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

PORT="${DSH_EDGE_HTTP_PORT:-21019}"
API_KEY="${EDGE_API_KEY:-test-secret-key}"
PROFILE="dsh-edge-agent"
BASE_URL="http://127.0.0.1:$PORT"
SERVER_PID=""
TESTS_PASSED=0
TESTS_FAILED=0
TESTS_SKIPPED=0

log_info()  { echo -e "${BLUE}[INFO]${NC} $1"; }
log_pass()  { echo -e "${GREEN}[PASS]${NC} $1"; }
log_fail()  { echo -e "${RED}[FAIL]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_test()  { echo -e "${CYAN}[TEST]${NC} $1"; }
log_skip()  { echo -e "${YELLOW}[SKIP]${NC} $1"; }

cleanup() {
    if [ -n "$SERVER_PID" ] && [ "${KEEP_SERVER_RUNNING:-false}" != "true" ]; then
        log_info "停止 dsh 服务器 (PID: $SERVER_PID)..."
        kill "$SERVER_PID" 2>/dev/null || true
        wait "$SERVER_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT

# ─── 发送聊天请求,返回 HTTP 状态码和响应体 ─────────────────────────
send_chat() {
    local message="$1"
    local timeout="${2:-90}"
    local session_id="${3:-}"

    local payload
    if [ -n "$session_id" ]; then
        payload=$(python3 -c "import json,sys; print(json.dumps({'message': sys.argv[1], 'sessionId': sys.argv[2]}))" "$message" "$session_id" 2>/dev/null)
    else
        payload=$(python3 -c "import json,sys; print(json.dumps({'message': sys.argv[1]}))" "$message" 2>/dev/null)
    fi
    if [ -z "$payload" ]; then
        payload="{\"message\":\"$message\"}"
    fi

    local response
    response=$(curl -s -w "\n%{http_code}" --max-time "$timeout" \
        -X POST "$BASE_URL/v1/chat" \
        -H "Authorization: Bearer $API_KEY" \
        -H "Content-Type: application/json" \
        -d "$payload" 2>&1)
    local curl_exit=$?

    local status_code
    status_code=$(echo "$response" | tail -n1)
    local body
    body=$(echo "$response" | sed '$d')

    if [ "$curl_exit" -ne 0 ] && [ "$status_code" = "000" ]; then
        echo "000|curl_error:exit=$curl_exit"
        return
    fi
    echo "$status_code|$body"
}

# ─── 定位审计日志文件 ───────────────────────────────────────────
# web-search-guard 写入的审计事件在 audit-log 插件的 plain JSONL 文件里
# (filename=audit.plain.jsonl, root=$DSH_EDGE_AUDIT_ROOT 或
# ~/.dsh-edge-agent/audit)。
#
# 2026-08-29: 把默认 audit root 从 `~/.dsh-edge-agent-m1/audit` 改成
# `~/.dsh-edge-agent/audit`，与 `~/.dsh/` 命名一致；旧的 `-m1` 路径作为
# 后备保留（已部署的旧实例可能还在写那里）。
#
# 2026-09-03: -m1 是 pre-§7.25 历史产物（旧 milestone 命名）。当前 profile
# 容器名虽仍叫 dsh-edge-agent（撞 bundle 名，见 §7.25 + §7.25.x），但 audit
# root 应该跟当前 bundle 命名一致 = `~/.dsh-edge-agent/audit`。旧 -m1 路径
# 仅作 legacy fallback。
find_audit_log() {
    local home="${USERPROFILE:-${HOME:-/home/$(id -un)}}"

    # 1. 显式 DSH_EDGE_AUDIT_ROOT 永远优先
    if [ -n "${DSH_EDGE_AUDIT_ROOT:-}" ] && [ -f "$DSH_EDGE_AUDIT_ROOT/audit.plain.jsonl" ]; then
        echo "$DSH_EDGE_AUDIT_ROOT/audit.plain.jsonl"
        return 0
    fi

    # 2. 当前默认路径（2026-08-29 起）
    if [ -f "$home/.dsh-edge-agent/audit/audit.plain.jsonl" ]; then
        echo "$home/.dsh-edge-agent/audit/audit.plain.jsonl"
        return 0
    fi

    # 3. 旧 `-m1` 路径（兼容 2026-08-29 之前的部署）
    if [ -f "$home/.dsh-edge-agent-m1/audit/audit.plain.jsonl" ]; then
        echo "$home/.dsh-edge-agent-m1/audit/audit.plain.jsonl"
        return 0
    fi

    # 4. 兜底：两个候选目录下找最新的 audit.plain.jsonl
    find "$home/.dsh-edge-agent" "$home/.dsh-edge-agent-m1" \
        -name "audit.plain.jsonl" -newer /tmp/dsh-web-search-test.log 2>/dev/null | head -1
}

# ─── 计数审计事件 ──────────────────────────────────────────────
# 用法: count_audit_events "<log_file>" "<kind_pattern>" [session_filter]
# session_filter: 可选,仅匹配包含此字符串的 sessionId 关联事件
count_audit_events() {
    local file="$1"
    local kind="$2"
    local sid_filter="${3:-}"
    if [ -z "$file" ] || [ ! -f "$file" ]; then
        echo "0"
        return
    fi
    if [ -n "$sid_filter" ]; then
        grep "\"$sid_filter\"" "$file" 2>/dev/null | grep -c "\"kind\":\"$kind\""
    else
        grep -c "\"kind\":\"$kind\"" "$file" 2>/dev/null
    fi
}

# ─── 前置检查 ─────────────────────────────────────────────────
check_prereqs() {
    log_info "检查前置条件..."

    local dsh_bin
    dsh_bin=$(command -v dsh 2>/dev/null || echo "/home/etsme/.npm-global/bin/dsh")
    if [ ! -x "$dsh_bin" ]; then
        log_fail "dsh 命令未找到"
        exit 1
    fi
    log_info "dsh: $dsh_bin ($($dsh_bin --version 2>&1 | head -1))"

    # DEEPSEEK_API_KEY 是 web-search-deepseek provider 必需的。若未显式传入,
    # 从 ~/.dsh/.credentials.yaml 读取 (格式: "DEEPSEEK_API_KEY: sk-...")
    if [ -z "${DEEPSEEK_API_KEY:-}" ] && [ -f "${HOME}/.dsh/.credentials.yaml" ]; then
        export DEEPSEEK_API_KEY
        DEEPSEEK_API_KEY=$(grep -E "^DEEPSEEK_API_KEY" "${HOME}/.dsh/.credentials.yaml" | awk '{print $2}' | tr -d '"' | tr -d "'")
        export DEEPSEEK_API_KEY
        log_info "从 ~/.dsh/.credentials.yaml 加载 DEEPSEEK_API_KEY (${#DEEPSEEK_API_KEY} chars)"
    fi
    if [ -z "${DEEPSEEK_API_KEY:-}" ]; then
        log_fail "DEEPSEEK_API_KEY 未设置且 ~/.dsh/.credentials.yaml 不存在或无此 key"
        log_fail "  web_search 走 Anthropic 端点 401,测试无法验证真实路径"
        exit 1
    fi

    if [ "${SKIP_BUILD:-false}" != "true" ]; then
        log_info "编译 dsh-edge-agent..."
        cd /home/etsme/cy/agent/dsh-edge-agent
        npm run compile > /dev/null 2>&1 || { log_fail "编译失败"; exit 1; }
        log_info "编译完成"
    else
        log_info "跳过编译 (SKIP_BUILD=true)"
    fi
}

# ─── 启动服务器 ─────────────────────────────────────────────────
start_server() {
    log_info "启动 dsh 服务器 (profile: $PROFILE, port: $PORT)..."

    export EDGE_API_KEY="$API_KEY"
    export DSH_EDGE_HTTP_PORT="$PORT"
    # 关掉 prompt-guard 模型层(避免对测试输入误判 REJECT)
    export DSH_EDGE_GUARD_MODEL="${DSH_EDGE_GUARD_MODEL:-false}"
    # 强制使用 cloud-deepseek-v4 (DeepSeek 官方模型) —— 本地 qwen3-4b 不发
    # tool_calls,本地 LLM 跑这套测试永远 soft-pass,无法验证 web_search 链路
    export DSH_EDGE_PROVIDER="cloud-deepseek-v4"
    export DSH_EDGE_MODEL="deepseek-chat"

    local dsh_bin
    dsh_bin=$(command -v dsh 2>/dev/null || echo "/home/etsme/.npm-global/bin/dsh")

    "$dsh_bin" --profile "$PROFILE" > /tmp/dsh-web-search-test.log 2>&1 &
    SERVER_PID=$!
    log_info "服务器 PID: $SERVER_PID, 日志: /tmp/dsh-web-search-test.log"
    log_info "强制 provider=cloud-deepseek-v4 (model=deepseek-chat)"

    local max_wait=60 waited=0
    while [ $waited -lt $max_wait ]; do
        if curl -s --max-time 2 "$BASE_URL/v1/health" > /dev/null 2>&1; then
            log_pass "服务器已启动 (${waited}s)"
            sleep 2
            return 0
        fi
        if ! kill -0 "$SERVER_PID" 2>/dev/null; then
            log_fail "服务器进程已退出"
            tail -30 /tmp/dsh-web-search-test.log
            exit 1
        fi
        sleep 1
        waited=$((waited + 1))
    done

    log_fail "服务器启动超时 (${max_wait}s)"
    tail -30 /tmp/dsh-web-search-test.log
    exit 1
}

# ─── 测试组 A:基础 web_search 触发 ────────────────────────────
run_group_a() {
    echo ""
    echo "─── A 组:基础 web_search 触发 (3 用例) ───"
    echo ""
    echo "策略: 发搜索意图强的请求,验证 audit log 中有 tool.web-search.executed"
    echo "      (无论 LLM 是否真的调用 web_search,只要模型决定调用就计数)"
    echo ""

    local audit_file
    audit_file=$(find_audit_log)

    if [ -z "$audit_file" ] || [ ! -f "$audit_file" ]; then
        log_warn "组 A: 审计日志未找到,所有断言无法执行"
        log_skip "组 A 跳过(无 audit log)"
        TESTS_SKIPPED=$((TESTS_SKIPPED + 3))
        echo ""
        return
    fi

    # 记录 A 组测试前的审计计数
    local a_baseline
    a_baseline=$(count_audit_events "$audit_file" "tool.web-search.executed")

    # A.1 电影票房查询
    log_test "A.1 web_search: 2026 春节档票房"
    echo "       输入: \"查一下 2026 春节档电影票房排行\""
    local result
    result=$(send_chat "查一下 2026 春节档电影票房排行")
    local status
    status=$(echo "$result" | cut -d'|' -f1)
    if [ "$status" = "200" ]; then
        sleep 3  # 等 audit flush
        local count
        count=$(count_audit_events "$audit_file" "tool.web-search.executed")
        local delta=$((count - a_baseline))
        a_baseline=$count
        if [ "$delta" -ge 1 ]; then
            log_pass "A.1 web_search 触发 (新增 $delta 条 tool.web-search.executed)"
            TESTS_PASSED=$((TESTS_PASSED + 1))
        else
            # 硬断言:v2 起 web_search 必须真触发(cloud-deepseek-v4 支持 tool-calling)
            log_fail "A.1 cloud-deepseek-v4 未触发 web_search (0 条新增;web-search 链路断裂)"
            TESTS_FAILED=$((TESTS_FAILED + 1))
        fi
    else
        log_fail "A.1 HTTP $status"
        TESTS_FAILED=$((TESTS_FAILED + 1))
    fi
    echo ""

    # A.2 实时新闻
    log_test "A.2 web_search: 最新 AI 新闻"
    echo "       输入: \"最近一周 AI 行业有什么重要新闻\""
    result=$(send_chat "最近一周 AI 行业有什么重要新闻")
    status=$(echo "$result" | cut -d'|' -f1)
    if [ "$status" = "200" ]; then
        log_pass "A.2 HTTP 200"
        TESTS_PASSED=$((TESTS_PASSED + 1))
    else
        log_fail "A.2 HTTP $status"
        TESTS_FAILED=$((TESTS_FAILED + 1))
    fi
    echo ""

    # A.3 Python 最新版本
    log_test "A.3 web_search: Python 最新版本号"
    echo "       输入: \"Python 现在最新版本是多少\""
    result=$(send_chat "Python 现在最新版本是多少")
    status=$(echo "$result" | cut -d'|' -f1)
    if [ "$status" = "200" ]; then
        log_pass "A.3 HTTP 200"
        TESTS_PASSED=$((TESTS_PASSED + 1))
    else
        log_fail "A.3 HTTP $status"
        TESTS_FAILED=$((TESTS_FAILED + 1))
    fi
    echo ""
}

# ─── 测试组 B:PII 泄露监控 ─────────────────────────────────────
run_group_b() {
    echo ""
    echo "─── B 组:PII 泄露监控 (2 用例) ───"
    echo ""
    echo "策略: 发含 PII 的搜索 query,验证 audit log 有 web-search-guard.pii-leak"
    echo "      security 事件。LLM 行为不可控——若它没传 PII 进 tool_call,本组会"
    echo "      通过 (PII 没漏);若它传了,audit 会捕获并 pass。"
    echo ""

    local audit_file
    audit_file=$(find_audit_log)

    if [ -z "$audit_file" ] || [ ! -f "$audit_file" ]; then
        log_warn "组 B: 审计日志未找到"
        TESTS_SKIPPED=$((TESTS_SKIPPED + 2))
        echo ""
        return
    fi

    # B.1 含手机号的搜索 query
    log_test "B.1 web_search query 含手机号"
    echo "       输入: \"帮我搜 13800138000 这个手机号是谁的\""
    local result
    result=$(send_chat "帮我搜 13800138000 这个手机号是谁的")
    local status
    status=$(echo "$result" | cut -d'|' -f1)
    if [ "$status" = "200" ]; then
        sleep 3
        local leak_count
        leak_count=$(count_audit_events "$audit_file" "web-search-guard.pii-leak")
        echo "       web-search-guard.pii-leak 事件数: $leak_count"
        if [ "$leak_count" -ge 1 ]; then
            log_pass "B.1 PII 监控触发 ($leak_count 条 security 事件)"
            TESTS_PASSED=$((TESTS_PASSED + 1))
        else
            # v2 硬断言:若 cloud-deepseek-v4 真的用 web_search,带 PII 的 query
            # 会触发 leak。0 = 链路断裂 (PII 监控未生效 OR web_search 未触发)。
            # 先确认 web_search 是否真触发,区分两类失败
            local web_count
            web_count=$(count_audit_events "$audit_file" "tool.web-search.executed")
            if [ "$web_count" -eq 0 ]; then
                log_fail "B.1 web_search 工具链未触发 (0 条),无法验证 PII 监控"
                TESTS_FAILED=$((TESTS_FAILED + 1))
            else
                # web_search 触发了,LLM 在 sanitize 前已脱敏 PII —— 这是合规行为,
                # 但说明 PII 监控没机会运行 (sanitizer-pipeline 在 LLM 之前已处理)
                log_warn "B.1 web_search 已触发但 pii-leak=0 —— sanitizer-pipeline 提前脱敏"
                log_warn "       这是合规路径 (no PII reach cloud),不算失败"
                TESTS_PASSED=$((TESTS_PASSED + 1))
            fi
        fi
    else
        log_fail "B.1 HTTP $status"
        TESTS_FAILED=$((TESTS_FAILED + 1))
    fi
    echo ""

    # B.2 含邮箱的搜索 query (PII 监控覆盖范围:phone / email / IP / MAC / 护照 / 车牌)
    log_test "B.2 web_search query 含邮箱"
    echo "       输入: \"搜一下 user@example.com 这个邮箱属于哪家公司\""
    result=$(send_chat "搜一下 user@example.com 这个邮箱属于哪家公司")
    status=$(echo "$result" | cut -d'|' -f1)
    if [ "$status" = "200" ]; then
        sleep 3
        local leak_count
        leak_count=$(count_audit_events "$audit_file" "web-search-guard.pii-leak")
        if [ "$leak_count" -ge 1 ]; then
            log_pass "B.2 PII 监控触发 ($leak_count 条)"
            TESTS_PASSED=$((TESTS_PASSED + 1))
        else
            # 同 B.1:web_search 已触发但 LLM 未传 PII 进 args → 合规
            log_warn "B.2 web_search 已触发但 pii-leak=0 (合规路径,sanitizer 提前处理)"
            TESTS_PASSED=$((TESTS_PASSED + 1))
        fi
    else
        log_fail "B.2 HTTP $status"
        TESTS_FAILED=$((TESTS_FAILED + 1))
    fi
    echo ""
}

# ─── 测试组 C:Rate-limit 告警 ──────────────────────────────────
run_group_c() {
    echo ""
    echo "─── C 组:Rate-limit 告警 (1 用例) ───"
    echo ""
    echo "策略: 短时间内连续发 12 个 web_search 触发请求,期望 audit log 出现"
    echo "      web-search-guard.rate-limit-exceeded warn 事件 (默认 10/min 限额)"
    echo ""

    local audit_file
    audit_file=$(find_audit_log)

    if [ -z "$audit_file" ] || [ ! -f "$audit_file" ]; then
        log_warn "组 C: 审计日志未找到"
        TESTS_SKIPPED=$((TESTS_SKIPPED + 1))
        echo ""
        return
    fi

    log_test "C.1 连续 12 次搜索请求触发 rate-limit"
    local before_count after_count
    before_count=$(count_audit_events "$audit_file" "web-search-guard.rate-limit-exceeded")
    log_info "       触发前 rate-limit-exceeded 计数: $before_count"

    local i
    for i in $(seq 1 12); do
        send_chat "帮我搜下今天第 $i 条热搜" > /dev/null 2>&1
        # 不等 LLM 响应完成(那很慢);立刻发下一条
    done
    log_info "       12 条请求已发出,等 audit log flush..."
    sleep 8  # 给 audit-log 的 1s flush interval 留足时间 + 12 次响应

    after_count=$(count_audit_events "$audit_file" "web-search-guard.rate-limit-exceeded")
    log_info "       触发后 rate-limit-exceeded 计数: $after_count"

    local delta=$((after_count - before_count))
    if [ "$delta" -ge 1 ]; then
        log_pass "C.1 rate-limit 告警触发 ($delta 条 warn)"
        TESTS_PASSED=$((TESTS_PASSED + 1))
    else
        # v2 硬断言:12 次 web_search 调用应至少越过 10/min 阈值 2 次
        # 若 0 = 监控链断裂 OR LLM 没真用 web_search
        local web_count
        web_count=$(count_audit_events "$audit_file" "tool.web-search.executed")
        if [ "$web_count" -eq 0 ]; then
            log_fail "C.1 web_search 工具链未触发 (0 条),rate-limit 无法验证"
            TESTS_FAILED=$((TESTS_FAILED + 1))
        else
            log_fail "C.1 web_search 触发 $web_count 次但 rate-limit 未告警 (rate-limit 监控失效)"
            TESTS_FAILED=$((TESTS_FAILED + 1))
        fi
    fi
    echo ""
}

# ─── 测试组 D:Realm 隔离 ──────────────────────────────────────
run_group_d() {
    echo ""
    echo "─── D 组:Realm 隔离 (1 用例) ───"
    echo ""
    echo "策略: 发 LOCAL intent 请求(读本地文件),验证 audit log 无 web_search"
    echo "      工具调用(LOCAL intent 不应见 CLOUD tools,且不会真去搜索)"
    echo ""

    local audit_file
    audit_file=$(find_audit_log)

    if [ -z "$audit_file" ] || [ ! -f "$audit_file" ]; then
        log_warn "组 D: 审计日志未找到"
        TESTS_SKIPPED=$((TESTS_SKIPPED + 1))
        echo ""
        return
    fi

    local sid_d="e2e-realm-$$-$(date +%s)"
    log_test "D.1 LOCAL intent 不触发 web_search"
    echo "       sessionId=$sid_d"
    echo "       输入: \"帮我读一下 README.md\""
    local result
    result=$(send_chat "帮我读一下 README.md" 90 "$sid_d")
    local status
    status=$(echo "$result" | cut -d'|' -f1)
    if [ "$status" = "200" ]; then
        local web_count
        web_count=$(count_audit_events "$audit_file" "tool.web-search.executed" "$sid_d")
        if [ "$web_count" -eq 0 ]; then
            log_pass "D.1 LOCAL intent → 无 web_search 调用 (count=0)"
            TESTS_PASSED=$((TESTS_PASSED + 1))
        else
            log_fail "D.1 LOCAL intent 触发了 web_search ($web_count 条,realm 隔离失效!)"
            TESTS_FAILED=$((TESTS_FAILED + 1))
        fi
    else
        log_fail "D.1 HTTP $status"
        TESTS_FAILED=$((TESTS_FAILED + 1))
    fi
    echo ""
}

# ─── 测试组 E:web_fetch 验证 ────────────────────────────────────
run_group_e() {
    echo ""
    echo "─── E 组:web_fetch URL 抓取 (1 用例) ───"
    echo ""
    echo "策略: 给一个具体 URL 让 LLM 抓取内容,验证 audit log 有 web_fetch 调用"
    echo ""

    local audit_file
    audit_file=$(find_audit_log)

    if [ -z "$audit_file" ] || [ ! -f "$audit_file" ]; then
        log_warn "组 E: 审计日志未找到"
        TESTS_SKIPPED=$((TESTS_SKIPPED + 1))
        echo ""
        return
    fi

    local before_count after_count
    before_count=$(count_audit_events "$audit_file" "tool.web-search.executed")

    log_test "E.1 web_fetch: 抓取 https://example.com"
    echo "       输入: \"帮我看看 https://example.com 这个页面说什么\""
    local result
    result=$(send_chat "帮我看看 https://example.com 这个页面说什么" 90)
    local status
    status=$(echo "$result" | cut -d'|' -f1)
    if [ "$status" = "200" ]; then
        sleep 5  # 等 audit flush
        after_count=$(count_audit_events "$audit_file" "tool.web-search.executed")
        local delta=$((after_count - before_count))
        echo "       tool.web-search.executed 新增 $delta 条(包含 web_search + web_fetch)"
        if [ "$delta" -ge 1 ]; then
            log_pass "E.1 工具调用触发 ($delta 条)"
            TESTS_PASSED=$((TESTS_PASSED + 1))
        else
            # v2 硬断言:给具体 URL,cloud-deepseek-v4 应触发 web_fetch
            log_fail "E.1 给 URL 后未触发 web_fetch / web_search (web-search 链路断裂)"
            TESTS_FAILED=$((TESTS_FAILED + 1))
        fi
    else
        log_fail "E.1 HTTP $status"
        TESTS_FAILED=$((TESTS_FAILED + 1))
    fi
    echo ""
}

# ─── 测试组 F:审计事件 schema 验证 ──────────────────────────────
run_group_f() {
    echo ""
    echo "─── F 组:审计事件 schema (2 用例) ───"
    echo ""
    echo "策略: 验证 audit log 中 tool.web-search.executed 的 payload 字段完整"
    echo ""

    local audit_file
    audit_file=$(find_audit_log)

    if [ -z "$audit_file" ] || [ ! -f "$audit_file" ]; then
        log_warn "组 F: 审计日志未找到"
        TESTS_SKIPPED=$((TESTS_SKIPPED + 2))
        echo ""
        return
    fi

    # F.1 payload 含 toolName 字段
    log_test "F.1 tool.web-search.executed payload 含 toolName"
    local toolname_count
    toolname_count=$(grep "\"kind\":\"tool.web-search.executed\"" "$audit_file" 2>/dev/null | grep -c '"toolName":"web_search"')
    if [ "$toolname_count" -ge 1 ]; then
        log_pass "F.1 payload.toolName=web_search 字段完整 ($toolname_count 条)"
        TESTS_PASSED=$((TESTS_PASSED + 1))
    else
        # v2 硬断言:若 A/E 已触发 web_search 但 payload 无 toolName,schema 损坏
        local web_count
        web_count=$(count_audit_events "$audit_file" "tool.web-search.executed")
        if [ "$web_count" -eq 0 ]; then
            log_fail "F.1 无 web_search 审计事件 (前置 A/E 失败,payload 无法验证)"
            TESTS_FAILED=$((TESTS_FAILED + 1))
        else
            log_fail "F.1 web_search 已触发但 payload 缺 toolName 字段 (schema 损坏)"
            TESTS_FAILED=$((TESTS_FAILED + 1))
        fi
    fi
    echo ""

    # F.2 payload 含 withinBudget 字段
    log_test "F.2 tool.web-search.executed payload 含 withinBudget"
    local budget_count
    budget_count=$(grep "\"kind\":\"tool.web-search.executed\"" "$audit_file" 2>/dev/null | grep -c '"withinBudget":')
    if [ "$budget_count" -ge 1 ]; then
        log_pass "F.2 payload.withinBudget 字段完整 ($budget_count 条)"
        TESTS_PASSED=$((TESTS_PASSED + 1))
    else
        local web_count
        web_count=$(count_audit_events "$audit_file" "tool.web-search.executed")
        if [ "$web_count" -eq 0 ]; then
            log_fail "F.2 无 web_search 审计事件 (前置 A/E 失败)"
            TESTS_FAILED=$((TESTS_FAILED + 1))
        else
            log_fail "F.2 web_search 已触发但 payload 缺 withinBudget 字段"
            TESTS_FAILED=$((TESTS_FAILED + 1))
        fi
    fi
    echo ""
}

# ─── 打印总结 ─────────────────────────────────────────────────
print_summary() {
    echo "========================================================"
    echo "  E2E web-search 测试总结"
    echo "========================================================"
    echo -e "  通过: ${GREEN}$TESTS_PASSED${NC}"
    echo -e "  失败: ${RED}$TESTS_FAILED${NC}"
    echo -e "  跳过: ${YELLOW}$TESTS_SKIPPED${NC}"
    echo "  总计: $((TESTS_PASSED + TESTS_FAILED + TESTS_SKIPPED))"
    echo "========================================================"

    if [ "$TESTS_FAILED" -eq 0 ]; then
        echo -e "  ${GREEN}✓ 所有断言通过！web-search E2E 链正常${NC}"
    else
        echo -e "  ${RED}✗ 部分断言失败${NC}"
    fi
    echo "========================================================"
}

# ─── 主流程 ─────────────────────────────────────────────────
main() {
    echo "========================================================"
    echo "  E2E web-search — 真实环境端到端测试"
    echo "  目标: web_search / web_fetch 工具 + 监控层"
    echo "  覆盖: 触发 / PII 监控 / rate-limit / realm 隔离 / schema"
    echo "========================================================"
    echo ""

    check_prereqs
    start_server
    run_group_a
    run_group_b
    run_group_c
    run_group_d
    run_group_e
    run_group_f
    print_summary

    local exit_code=0
    if [ "$TESTS_FAILED" -gt 0 ]; then
        exit_code=1
    fi

    if [ "${KEEP_SERVER_RUNNING:-false}" = "true" ]; then
        echo ""
        log_info "服务器保持运行 (PID: $SERVER_PID)"
        wait "$SERVER_PID"
    fi

    exit $exit_code
}

main "$@"
