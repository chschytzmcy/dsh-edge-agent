#!/usr/bin/env bash
# M5 webui 烟囱脚本 — webui (:21018) + http-api (:21017) 双入口活体检查
#
# 与 m5-e2e-test.sh 的区别：
#   - m5-e2e 跑完整 :21017 HTTP API（鉴权/会话/SSE/CRUD）—— 侧重后端协议
#   - m5-webui-smoke 只跑 :21018 SPA + 双入口"开门即通"探测 —— 侧重 web 入口存活
#   - CI 必跑，端口冲突时直接 fail，不接管运行中的 dsh 实例
#
# 用法：
#   ./scripts/m5-webui-smoke.sh
#
# 环境变量：
#   DSH_EDGE_WEB_PORT    - webui 端口 (default: 21018)
#   DSH_EDGE_HTTP_PORT   - http-api 端口 (default: 21017)
#   EDGE_API_KEY          - API 密钥 (default: test-secret-key)
#   KEEP_SERVER_RUNNING   - 测试后保持服务器运行 (set to "true")
#   SKIP_BUILD            - 跳过编译 (set to "true")
#
# 前置：DSH_EDGE_GUARD_MODEL=false (避免 prompt-guard 模型层在探针输入上误判)

set -uo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

WEB_PORT="${DSH_EDGE_WEB_PORT:-21018}"
HTTP_PORT="${DSH_EDGE_HTTP_PORT:-21017}"
API_KEY="${EDGE_API_KEY:-test-secret-key}"
PROFILE="web"
WEB_URL="http://127.0.0.1:$WEB_PORT"
HTTP_URL="http://127.0.0.1:$HTTP_PORT"
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

# ─── 端口冲突预检 ────────────────────────────────────────────
# 烟囱脚本不应接管已在跑的 dsh 实例；若端口被占用直接退出，让用户决定
# 是复用现成实例 (KEEP_SERVER_RUNNING=true 跳过启动) 还是先 kill。
check_port_conflict() {
    log_info "检查端口占用: :$WEB_PORT (webui) + :$HTTP_PORT (http-api)..."
    local conflict=0

    if command -v ss &>/dev/null; then
        if ss -ltn 2>/dev/null | grep -qE ":$WEB_PORT "; then
            log_warn ":$WEB_PORT 已被占用"
            conflict=1
        fi
        if ss -ltn 2>/dev/null | grep -qE ":$HTTP_PORT "; then
            log_warn ":$HTTP_PORT 已被占用"
            conflict=1
        fi
    elif command -v lsof &>/dev/null; then
        if lsof -i ":$WEB_PORT" &>/dev/null; then
            log_warn ":$WEB_PORT 已被占用"
            conflict=1
        fi
        if lsof -i ":$HTTP_PORT" &>/dev/null; then
            log_warn ":$HTTP_PORT 已被占用"
            conflict=1
        fi
    else
        log_warn "ss/lsof 都不可用，跳过端口预检"
    fi

    if [ "$conflict" -eq 1 ]; then
        log_fail "端口冲突 — 烟囱脚本不会复用现成实例，请先 kill 旧 dsh 或换端口"
        log_fail "  (export DSH_EDGE_WEB_PORT / DSH_EDGE_HTTP_PORT 后重试)"
        exit 1
    fi
    log_pass "端口空闲"
}

# ─── 前置检查 ───────────────────────────────────────────
check_prereqs() {
    log_info "检查前置条件..."

    local dsh_bin
    dsh_bin=$(command -v dsh 2>/dev/null || echo "/home/etsme/.npm-global/bin/dsh")
    if [ ! -x "$dsh_bin" ]; then
        log_fail "dsh 命令未找到 ($dsh_bin 不可执行)"
        exit 1
    fi
    log_info "dsh: $dsh_bin ($($dsh_bin --version 2>&1 | head -1))"

    if ! command -v curl &>/dev/null; then
        log_fail "curl 未找到"
        exit 1
    fi

    if [ "${SKIP_BUILD:-false}" != "true" ]; then
        log_info "编译 dsh-edge-agent..."
        if ! npm run compile > /dev/null 2>&1; then
            log_fail "编译失败"
            exit 1
        fi
        log_info "编译完成"
    else
        log_info "跳过编译 (SKIP_BUILD=true)"
    fi
}

# ─── 启动服务器 ───────────────────────────────────────────
start_server() {
    log_info "启动 dsh (profile: $PROFILE, webui: :$WEB_PORT, http-api: :$HTTP_PORT)..."

    export EDGE_API_KEY="$API_KEY"
    export DSH_EDGE_HTTP_PORT="$HTTP_PORT"
    export DSH_EDGE_WEB_PORT="$WEB_PORT"
    # 关掉 prompt-guard 模型层（探针输入简单，避免误判）
    export DSH_EDGE_GUARD_MODEL="${DSH_EDGE_GUARD_MODEL:-false}"

    local dsh_bin
    dsh_bin=$(command -v dsh 2>/dev/null || echo "/home/etsme/.npm-global/bin/dsh")

    "$dsh_bin" --profile "$PROFILE" > /tmp/dsh-webui-smoke.log 2>&1 &
    SERVER_PID=$!
    log_info "服务器 PID: $SERVER_PID, 日志: /tmp/dsh-webui-smoke.log"

    # 双入口轮询：webui SPA + http-api 健康检查
    local max_wait=60 web_ok=false api_ok=false waited=0
    while [ $waited -lt $max_wait ]; do
        if [ "$web_ok" = false ] && curl -s --max-time 2 -o /dev/null -w "%{http_code}" "$WEB_URL/" 2>/dev/null | grep -qE "^(200|301|302)"; then
            log_info "  webui ($WEB_URL/) 已响应 (${waited}s)"
            web_ok=true
        fi
        if [ "$api_ok" = false ] && curl -s --max-time 2 -o /dev/null -w "%{http_code}" "$HTTP_URL/v1/health" 2>/dev/null | grep -qE "^200$"; then
            log_info "  http-api ($HTTP_URL/v1/health) 已响应 (${waited}s)"
            api_ok=true
        fi
        if [ "$web_ok" = true ] && [ "$api_ok" = true ]; then
            log_pass "双入口就绪 (${waited}s)"
            return 0
        fi
        if ! kill -0 "$SERVER_PID" 2>/dev/null; then
            log_fail "服务器进程已退出"
            tail -30 /tmp/dsh-webui-smoke.log
            exit 1
        fi
        sleep 1
        waited=$((waited + 1))
    done

    log_fail "服务器启动超时 (${max_wait}s)"
    log_fail "  web_ok=$web_ok api_ok=$api_ok"
    tail -30 /tmp/dsh-webui-smoke.log
    exit 1
}

# ─── 测试用例 ────────────────────────────────────────────

# 期望状态码检查 + 计数
expect_status() {
    local name="$1" url="$2" expected="$3"
    local code
    code=$(curl -s -o /dev/null --max-time 5 -w "%{http_code}" "$url" 2>/dev/null || echo "000")
    if [ "$code" = "$expected" ]; then
        log_pass "$name (HTTP $code)"
        TESTS_PASSED=$((TESTS_PASSED + 1))
        return 0
    else
        log_fail "$name — 期望 $expected, 实际 $code ($url)"
        TESTS_FAILED=$((TESTS_FAILED + 1))
        return 1
    fi
}

run_group_webui_root() {
    echo ""
    echo "─── A 组: webui SPA 入口 ───"

    # A.1 SPA 根路径加载
    expect_status "A.1 :$WEB_PORT/ (SPA root)" "$WEB_URL/" "200"

    # A.2 web manifest 存在 — 表明 webserver 正确服务 SPA 静态资源
    expect_status "A.2 :$WEB_PORT/manifest.webmanifest" "$WEB_URL/manifest.webmanifest" "200"

    # A.3 SPA HTML 含主 JS bundle (Vite 构建的 index-*.js)
    # 2026-09-01 变更：移除 dsh-web-ui-all 后，原 A.3 标记不再适用；改为检查
    # SPA 主 bundle（assets/index-*.js），这是 DSH 官方 dsh-web-app /
    # dsh-web-frontend 提供的核心入口。bundle 缺失 = SPA 加载失败 = webui
    # 整体不可用。
    log_test "A.3 SPA HTML 含主 JS bundle"
    local html
    html=$(curl -s --max-time 5 "$WEB_URL/" 2>/dev/null || true)
    if echo "$html" | grep -qE 'assets/index-[^"]+\.js'; then
        log_pass "A.3 SPA 含主 JS bundle"
        TESTS_PASSED=$((TESTS_PASSED + 1))
    else
        log_fail "A.3 SPA 缺主 JS bundle (webui 加载失败)"
        TESTS_FAILED=$((TESTS_FAILED + 1))
    fi

    # A.4 SPA HTML 包含 dsh-im marker (IM 渠道标签页)
    if echo "$html" | grep -q "dsh-im"; then
        log_pass "A.4 SPA 含 dsh-im marker"
        TESTS_PASSED=$((TESTS_PASSED + 1))
    else
        log_warn "A.4 SPA 不含 dsh-im marker (IM bundle 未挂载)"
        TESTS_SKIPPED=$((TESTS_SKIPPED + 1))
    fi
    echo ""
}

run_group_http_api() {
    echo ""
    echo "─── B 组: http-api :$HTTP_PORT ───"

    # B.1 健康检查（无鉴权）
    expect_status "B.1 :$HTTP_PORT/v1/health (无鉴权)" "$HTTP_URL/v1/health" "200"

    # B.2 鉴权：缺失 token 应 401
    log_test "B.2 :$HTTP_PORT/v1/sessions 无 token 应 401"
    local no_auth_code
    no_auth_code=$(curl -s -o /dev/null --max-time 5 -w "%{http_code}" "$HTTP_URL/v1/sessions" 2>/dev/null || echo "000")
    if [ "$no_auth_code" = "401" ]; then
        log_pass "B.2 无 token → 401"
        TESTS_PASSED=$((TESTS_PASSED + 1))
    else
        log_fail "B.2 无 token 期望 401, 实际 $no_auth_code"
        TESTS_FAILED=$((TESTS_FAILED + 1))
    fi

    # B.3 鉴权：正确 token 列表应 200
    log_test "B.3 :$HTTP_PORT/v1/sessions bearer token 应 200"
    local with_auth_code
    with_auth_code=$(curl -s -o /dev/null --max-time 5 -w "%{http_code}" \
        -H "Authorization: Bearer $API_KEY" "$HTTP_URL/v1/sessions" 2>/dev/null || echo "000")
    if [ "$with_auth_code" = "200" ]; then
        log_pass "B.3 bearer token → 200"
        TESTS_PASSED=$((TESTS_PASSED + 1))
    else
        log_fail "B.3 bearer token 期望 200, 实际 $with_auth_code"
        TESTS_FAILED=$((TESTS_FAILED + 1))
    fi
    echo ""
}

run_group_isolation() {
    echo ""
    echo "─── C 组: webui 隔离断言 ───"
    echo "策略: webui 的会话/聊天走 apiproxy RPC, REST 路径上必须 404"
    echo "      若 webui 暴露 /api/sessions, 与 http-api 的 bearer/body-cap 防护分裂"

    # C.1 webui REST sessions 必须 404
    expect_status "C.1 :$WEB_PORT/api/sessions (必须 404)" "$WEB_URL/api/sessions" "404"

    # C.2 webui REST chat 必须 404
    expect_status "C.2 :$WEB_PORT/api/chat (必须 404)" "$WEB_URL/api/chat" "404"

    echo ""
}

# ─── 总结 ───────────────────────────────────────────────
print_summary() {
    echo "========================================================"
    echo "  M5 webui 烟囱脚本 — 总结"
    echo "========================================================"
    echo -e "  通过: ${GREEN}$TESTS_PASSED${NC}"
    echo -e "  失败: ${RED}$TESTS_FAILED${NC}"
    echo -e "  跳过: ${YELLOW}$TESTS_SKIPPED${NC}"
    echo "  总计: $((TESTS_PASSED + TESTS_FAILED + TESTS_SKIPPED))"
    echo "========================================================"

    if [ "$TESTS_FAILED" -eq 0 ]; then
        echo -e "  ${GREEN}✓ webui 双入口活体通过${NC}"
        echo "  (webui :$WEB_PORT  +  http-api :$HTTP_PORT)"
    else
        echo -e "  ${RED}✗ 部分断言失败 — webui 入口可能不可用${NC}"
    fi
    echo "========================================================"
}

# ─── 主流程 ─────────────────────────────────────────────
main() {
    echo "========================================================"
    echo "  M5 webui 烟囱 — :$WEB_PORT (webui) + :$HTTP_PORT (http-api)"
    echo "========================================================"
    echo ""

    check_port_conflict
    echo ""
    check_prereqs
    echo ""
    start_server
    echo ""

    run_group_webui_root
    run_group_http_api
    run_group_isolation

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
