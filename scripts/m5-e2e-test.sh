#!/usr/bin/env bash
# M5 端到端测试脚本 — 基于真实 dsh 的完整验证
#
# 用法：
#   ./scripts/m5-e2e-test.sh              # 使用默认配置
#   DSH_EDGE_PROVIDER=cloud-deepseek-v4 ./scripts/m5-e2e-test.sh
#
# 环境变量：
#   DSH_EDGE_PROVIDER     - LLM provider (default: local-qwen3-4b-mock)
#   DSH_EDGE_HTTP_PORT    - HTTP 端口 (default: 21017)
#   EDGE_API_KEY          - API 密钥 (default: test-secret-key)
#   DEEPSEEK_API_KEY      - DeepSeek API key (cloud provider 必需)
#   SKIP_DSH_INSTALL      - 跳过 dsh 安装检查 (set to "true")
#   KEEP_SERVER_RUNNING   - 测试后保持服务器运行 (set to "true")

set -euo pipefail

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 配置
PROFILE="dsh-edge-agent"
PORT="${DSH_EDGE_HTTP_PORT:-21017}"
API_KEY="${EDGE_API_KEY:-test-secret-key}"
PROVIDER="${DSH_EDGE_PROVIDER:-local-qwen3-4b-mock}"
BASE_URL="http://127.0.0.1:$PORT"
SERVER_PID=""
TESTS_PASSED=0
TESTS_FAILED=0

# 日志函数
log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[PASS]${NC} $1"; }
log_error() { echo -e "${RED}[FAIL]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }

# 清理函数
cleanup() {
    if [ -n "$SERVER_PID" ] && [ "${KEEP_SERVER_RUNNING:-false}" != "true" ]; then
        log_info "停止 dsh 服务器 (PID: $SERVER_PID)..."
        kill "$SERVER_PID" 2>/dev/null || true
        wait "$SERVER_PID" 2>/dev/null || true
    fi
}

trap cleanup EXIT

# 测试函数
test_endpoint() {
    local name="$1"
    local method="$2"
    local endpoint="$3"
    local expected_status="$4"
    local auth="${5:-true}"
    local data="${6:-}"

    local curl_args=(-s -w "\n%{http_code}" -X "$method")

    if [ "$auth" = "true" ]; then
        curl_args+=(-H "Authorization: Bearer $API_KEY")
    fi

    if [ -n "$data" ]; then
        curl_args+=(-H "Content-Type: application/json" -d "$data")
    fi

    curl_args+=("$BASE_URL$endpoint")

    local response
    response=$(curl "${curl_args[@]}" 2>&1) || true

    local status_code
    status_code=$(echo "$response" | tail -n1)
    local body
    body=$(echo "$response" | sed '$d')

    if [ "$status_code" = "$expected_status" ]; then
        log_success "$name (HTTP $status_code)"
        ((TESTS_PASSED++))
        echo "$body"
        return 0
    else
        log_error "$name (期望 $expected_status, 实际 $status_code)"
        echo "响应: $body"
        ((TESTS_FAILED++))
        return 1
    fi
}

# 检查前置条件
check_prerequisites() {
    log_info "检查前置条件..."

    # 检查 dsh 命令
    if ! command -v dsh &> /dev/null; then
        log_error "dsh 命令未找到"
        echo ""
        echo "请安装 dsh:"
        echo "  npm install -g @deepseek-ai/dsh"
        echo ""
        echo "或设置 SKIP_DSH_INSTALL=true 跳过检查"
        exit 1
    fi

    log_success "dsh 已安装: $(dsh --version 2>&1 | head -1)"

    # 检查 curl
    if ! command -v curl &> /dev/null; then
        log_error "curl 未找到"
        exit 1
    fi

    log_success "curl 已安装"

    # 检查 jq (可选，用于格式化输出)
    if command -v jq &> /dev/null; then
        log_success "jq 已安装"
        HAS_JQ=true
    else
        log_warn "jq 未安装 (输出将未格式化)"
        HAS_JQ=false
    fi

    # 检查 profile
    local dsh_home="${DSH_HOME:-$HOME/.dsh}"
    local profile_dir="$dsh_home/profiles/$PROFILE"

    if [ ! -d "$profile_dir" ]; then
        log_warn "Profile '$PROFILE' 不存在，将自动创建"
    else
        log_success "Profile '$PROFILE' 已存在"
    fi

    # 检查 API key (cloud provider)
    if [ "$PROVIDER" = "cloud-deepseek-v4" ] && [ -z "${DEEPSEEK_API_KEY:-}" ]; then
        log_error "使用 cloud-deepseek-v4 需要设置 DEEPSEEK_API_KEY"
        exit 1
    fi

    echo ""
}

# 构建 dsh-edge-agent
build_edge_agent() {
    log_info "构建 dsh-edge-agent..."

    if ! npm run compile &> /dev/null; then
        log_error "构建失败"
        exit 1
    fi

    log_success "构建完成"
}

# 启动 dsh 服务器
start_server() {
    log_info "启动 dsh 服务器..."
    log_info "  Profile: $PROFILE"
    log_info "  Provider: $PROVIDER"
    log_info "  Port: $PORT"
    log_info "  API Key: ${API_KEY:0:3}***"

    # 设置环境变量
    export EDGE_API_KEY="$API_KEY"
    export DSH_EDGE_HTTP_PORT="$PORT"
    export DSH_EDGE_PROVIDER="$PROVIDER"

    # 启动 dsh (后台运行，不传 task 参数)
    dsh --profile "$PROFILE" > /tmp/dsh-m5-test.log 2>&1 &
    SERVER_PID=$!

    log_info "服务器 PID: $SERVER_PID"
    log_info "日志文件: /tmp/dsh-m5-test.log"

    # 等待服务器启动
    log_info "等待服务器启动..."
    local max_wait=30
    local waited=0

    while [ $waited -lt $max_wait ]; do
        if curl -s "$BASE_URL/v1/health" &> /dev/null; then
            log_success "服务器已启动 (${waited}s)"
            return 0
        fi

        # 检查进程是否还在
        if ! kill -0 "$SERVER_PID" 2>/dev/null; then
            log_error "服务器进程已退出"
            echo ""
            echo "日志输出:"
            tail -20 /tmp/dsh-m5-test.log
            exit 1
        fi

        sleep 1
        ((waited++))
    done

    log_error "服务器启动超时 (${max_wait}s)"
    echo ""
    echo "日志输出:"
    tail -20 /tmp/dsh-m5-test.log
    exit 1
}

# 运行测试
run_tests() {
    log_info "开始测试..."
    echo ""

    # 1. 健康检查
    echo "=== 公开端点 ==="
    test_endpoint "GET /v1/health" "GET" "/v1/health" "200" "false" | (if $HAS_JQ; then jq .; else cat; fi)
    echo ""

    test_endpoint "GET /v1/openapi.json" "GET" "/v1/openapi.json" "200" "false" | (if $HAS_JQ; then jq '.info'; else cat; fi)
    echo ""

    # 2. 鉴权测试
    echo "=== 鉴权测试 ==="
    test_endpoint "无 token (应 401)" "GET" "/v1/sessions" "401" "false" > /dev/null
    test_endpoint "错误 token (应 401)" "GET" "/v1/sessions" "401" "wrong-token" > /dev/null
    test_endpoint "正确 token (应 200)" "GET" "/v1/sessions" "200" "true" > /dev/null
    echo ""

    # 3. 会话管理
    echo "=== 会话管理 ==="
    test_endpoint "列出会话 (初始为空)" "GET" "/v1/sessions" "200" "true" | (if $HAS_JQ; then jq '.sessions | length'; else cat; fi)
    echo ""

    # 4. 同步聊天
    echo "=== 同步聊天 ==="
    local chat_response
    chat_response=$(test_endpoint "POST /v1/chat" "POST" "/v1/chat" "200" "true" '{"message":"你好，请用一句话介绍自己"}')

    local session_id
    if $HAS_JQ; then
        session_id=$(echo "$chat_response" | jq -r '.sessionId')
        echo "  Session ID: $session_id"
        echo "  Result: $(echo "$chat_response" | jq -r '.result' | head -c 100)..."
        echo "  Duration: $(echo "$chat_response" | jq -r '.duration')ms"
    else
        session_id=$(echo "$chat_response" | grep -o '"sessionId":"[^"]*"' | cut -d'"' -f4)
        echo "  Session ID: $session_id"
        echo "  Response: $chat_response"
    fi
    echo ""

    # 5. 会话复用
    echo "=== 会话复用 ==="
    test_endpoint "列出会话 (应有 1 个)" "GET" "/v1/sessions" "200" "true" | (if $HAS_JQ; then jq '.sessions | length'; else cat; fi)

    if [ -n "$session_id" ]; then
        test_endpoint "获取会话详情" "GET" "/v1/sessions/$session_id" "200" "true" | (if $HAS_JQ; then jq '{sessionId, createdAt}'; else cat; fi)

        test_endpoint "复用会话继续对话" "POST" "/v1/chat" "200" "true" "{\"sessionId\":\"$session_id\",\"message\":\"继续刚才的话题\"}" > /dev/null
    fi
    echo ""

    # 6. SSE 流式聊天
    echo "=== SSE 流式聊天 ==="
    log_info "测试 SSE 流式响应 (5 秒超时)..."

    local sse_output
    sse_output=$(timeout 5 curl -sN -X POST "$BASE_URL/v1/chat/stream" \
        -H "Authorization: Bearer $API_KEY" \
        -H "Content-Type: application/json" \
        -d '{"message":"用三个字描述天气"}' 2>&1 || true)

    local sse_lines
    sse_lines=$(echo "$sse_output" | grep -c "^data:" || true)

    if [ "$sse_lines" -gt 0 ]; then
        log_success "SSE 流式响应 ($sse_lines 个事件)"
        ((TESTS_PASSED++))
        echo "  前 3 个事件:"
        echo "$sse_output" | grep "^data:" | head -3 | sed 's/^/    /'
    else
        log_error "SSE 流式响应失败 (无数据)"
        ((TESTS_FAILED++))
    fi
    echo ""

    # 7. 删除会话
    echo "=== 清理 ==="
    if [ -n "$session_id" ]; then
        test_endpoint "删除会话" "DELETE" "/v1/sessions/$session_id" "204" "true" > /dev/null
        test_endpoint "获取已删除会话 (应 404)" "GET" "/v1/sessions/$session_id" "404" "true" > /dev/null
    fi
    echo ""
}

# 打印总结
print_summary() {
    echo "========================================"
    echo "测试总结"
    echo "========================================"
    echo -e "通过: ${GREEN}$TESTS_PASSED${NC}"
    echo -e "失败: ${RED}$TESTS_FAILED${NC}"
    echo "总计: $((TESTS_PASSED + TESTS_FAILED))"
    echo "========================================"

    if [ "$TESTS_FAILED" -eq 0 ]; then
        echo -e "${GREEN}✓ 所有测试通过！${NC}"
        return 0
    else
        echo -e "${RED}✗ 部分测试失败${NC}"
        return 1
    fi
}

# 主流程
main() {
    echo "========================================"
    echo "M5 端到端测试"
    echo "========================================"
    echo ""

    check_prerequisites
    build_edge_agent
    start_server

    echo ""
    run_tests
    print_summary

    local exit_code=$?

    if [ "${KEEP_SERVER_RUNNING:-false}" = "true" ]; then
        echo ""
        log_info "服务器保持运行 (PID: $SERVER_PID)"
        log_info "按 Ctrl+C 停止"
        wait "$SERVER_PID"
    fi

    exit $exit_code
}

main "$@"
