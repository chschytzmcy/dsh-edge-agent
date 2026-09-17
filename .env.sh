#!/usr/bin/env bash
# .env.sh —— dsh-edge-agent 部署 wrapper（**无 hardcoded 默认值**）
#
# 设计原则（2026-09-17 §7.75，"统一下"）：
#   .env          = 2 个 LLM 池（CLOUD/LOCAL）+ 4 个 stage→provider 指针
#                   + 其他非 LLM 配置
#                   裸名（无 DSH_/XDG_/DYLD_/BASH_FUNC_ 前缀 —— 避开 DSH
#                   launcher 黑名单，dsh-app-boot/lib/index.js:933-1015）
#   .env.sh       = **反查逻辑** —— 读 .env 池 + 指针 → 展开成 DSH_EDGE_*
#                   命名空间的 stage 复合变量（PROVIDER+MODEL 配对）
#                   **不允许**任何 `${VAR:-hardcoded_default}` 形式的
#                   hardcoded fallback；fallback 全部下沉到 plugin Schema
#   plugin Schema = 默认值兜底（在源码里，已存在）
#
# 三层 fallback 链：
#   .env 真值（指针+池） → .env.sh 反查展开 → plugin Schema fallback
#
# 用法：
#   source .env.sh        # install.sh 启动 dsh 时自动 source
#   调试：set -a; . .env; set +a; . ./.env.sh
#
# 切换 profile（dsh-edge / web / tui）不重新 source —— env 已 inherit；
# §7.69 单 profile 架构下 profile 间只切进程不切 env。

_ENV_SH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)"

_ENV_FILE=""
if [ -f "./.env" ]; then
  _ENV_FILE="./.env"
elif [ -n "$_ENV_SH_DIR" ] && [ -f "$_ENV_SH_DIR/.env" ]; then
  _ENV_FILE="$_ENV_SH_DIR/.env"
fi

if [ -z "$_ENV_FILE" ]; then
  echo "[.env.sh] FATAL: .env not found (cwd=$(pwd), script_dir=$_ENV_SH_DIR)" >&2
  echo "             Run: cp .env.example .env && \$EDITOR .env" >&2
  return 1 2>/dev/null || exit 1
fi

# 1. 把 .env 的所有 KEY=VALUE 自动 export 到当前 shell（裸名）
set -a
. "$_ENV_FILE"
set +a

# 2. 校验：stage 指针必须 ∈ {cloud-llm, local-llm}
#    §7.75: 只剩 2 个 stage 指针（GUARD/INTENT）——
#    ROUTER_LOCAL_PROVIDER 已删（input-guard 降级路径硬编码 local-llm），
#    MAIN_PROVIDER / MODEL_ROUTER_DEFAULT 已删
for _stage_var in GUARD_PROVIDER INTENT_PROVIDER; do
  _stage_val="${!_stage_var}"
  case "$_stage_val" in
    cloud-llm|local-llm) ;;
    *)
      echo "[.env.sh] FATAL: $_stage_var='$_stage_val' (must be 'cloud-llm' or 'local-llm')" >&2
      return 1 2>/dev/null || exit 1
      ;;
  esac
done

# 3. 反查辅助：根据 provider 指针取对应的 model / baseurl / key_env
#    池数据已经在步骤 1 export 到当前 shell（裸名 CLOUD_LLM_* / LOCAL_LLM_*）
_resolve_model() {
  case "$1" in
    cloud-llm) echo "$CLOUD_LLM_MODEL" ;;
    local-llm) echo "$LOCAL_LLM_MODEL" ;;
    *) echo "[.env.sh] FATAL: unknown provider '$1' in _resolve_model" >&2; return 1 ;;
  esac
}
_resolve_baseurl() {
  case "$1" in
    cloud-llm) echo "$CLOUD_LLM_BASEURL" ;;
    local-llm) echo "$LOCAL_LLM_BASEURL" ;;
    *) echo "[.env.sh] FATAL: unknown provider '$1' in _resolve_baseurl" >&2; return 1 ;;
  esac
}
_resolve_key_env() {
  case "$1" in
    cloud-llm) echo "$CLOUD_LLM_KEY_ENV" ;;
    local-llm) echo "$LOCAL_LLM_KEY_ENV" ;;
    *) echo "[.env.sh] FATAL: unknown provider '$1' in _resolve_key_env" >&2; return 1 ;;
  esac
}

# ── HTTP API 入口 ──────────────────────────────────────────────────
export DSH_EDGE_HTTP_HOST="${HTTP_HOST}"
export DSH_EDGE_HTTP_PORT="${HTTP_PORT}"

# ============================================================
# LLM Stage 复合变量（cordis.patch.yml 期望 PROVIDER+MODEL 配对）
# ============================================================
# 反查：每个 stage 的 provider 指针 → 池里取对应 model/baseurl/key_env
#
# §7.75: agent-loop 的 agent-default-model row（cordis.patch.yml:82-85）
# 仍读 DSH_EDGE_PROVIDER / DSH_EDGE_MODEL，但**这两个值是 agent-loop 在
# 没有更具体 routing（意图分类 / modelRouter.resolve）时用的兜底**——
# 在 dsh-edge-agent 实际请求路径里 agent-loop 调用哪个 provider/model
# 由 **意图分类结果** 决定（intent=LOCAL → LOCAL 池 / LOCAL_LLM_MODEL，
# intent=CLOUD → CLOUD 池 / CLOUD_LLM_MODEL），不存在"主 LLM"或"路由
# 默认"环境变量选择。
#
# 因此 DSH_EDGE_PROVIDER / DSH_EDGE_MODEL 这里**硬编码**派生成 cloud-llm
# 池（CLOUD_LLM_MODEL）—— agent-loop 兜底路径按业界事实标准走大模型。
# 注：这是 .env.sh 唯一的 hardcoded default，仅用于"agent-default-model
# 孤儿 row"在 v0.1.x 启动时不能为空——真正的 routing 永远走意图分类。
_DEFAULT_FALLBACK_PROVIDER="cloud-llm"

# ── agent-default-model（agent-loop 孤儿 row，意图分类失败时 fallback） ─
export DSH_EDGE_PROVIDER="${_DEFAULT_FALLBACK_PROVIDER}"
export DSH_EDGE_MODEL="$(_resolve_model "$_DEFAULT_FALLBACK_PROVIDER")"

# ── Cloud LLM 池（cloud-llm-adapter config） ─────────────────────
# cloud-llm-adapter 永远在场（即便当前请求走 LOCAL 池，adapter 也注册着），
# 它的 baseurl / auth 由下面三个变量决定。
# §7.75 跟 local 池对称：CLOUD_LLM_BASEURL → DSH_EDGE_CLOUD_LLM_BASEURL
# （cordis.patch.yml:46,369 读它；DEEPSEEK_BASE_URL 仅作 inherited-env 兜底）
export DSH_EDGE_CLOUD_LLM_BASEURL="${CLOUD_LLM_BASEURL}"
export DSH_EDGE_CLOUD_KEY_ENV="${CLOUD_LLM_KEY_ENV}"

# ── Local LLM 池（local-llm-adapter config） ─────────────────────
export DSH_EDGE_LOCAL_LLM_BASEURL="${LOCAL_LLM_BASEURL}"
export DSH_EDGE_LOCAL_LLM_MODEL="${LOCAL_LLM_MODEL}"
export DSH_EDGE_LOCAL_LLM_KEY_ENV="${LOCAL_LLM_KEY_ENV}"

# ── prompt-guard 模型层（Stage 6） ────────────────────────────────
export DSH_EDGE_GUARD_MODEL="${GUARD_MODEL_ENABLED}"
export DSH_EDGE_GUARD_MODEL_PROVIDER="${GUARD_PROVIDER}"
export DSH_EDGE_GUARD_MODEL_MODEL="$(_resolve_model "$GUARD_PROVIDER")"
export DSH_EDGE_GUARD_MODEL_TIMEOUT_MS="${GUARD_MODEL_TIMEOUT_MS}"
export DSH_EDGE_GUARD_MODEL_MAX_INPUT="${GUARD_MODEL_MAX_INPUT}"

# ── 意图路由 ───────────────────────────────────────────────────────
export DSH_EDGE_INTENT_PROVIDER="${INTENT_PROVIDER}"
export DSH_EDGE_INTENT_MODEL="$(_resolve_model "$INTENT_PROVIDER")"
export DSH_EDGE_INTENT_LLM_TIMEOUT_MS="${INTENT_LLM_TIMEOUT_MS}"
export DSH_EDGE_INTENT_CONFIDENCE_THRESHOLD="${INTENT_CONFIDENCE_THRESHOLD}"
export DSH_EDGE_INTENT_MAX_INPUT="${INTENT_MAX_INPUT}"
export DSH_EDGE_INTENT_RECENT_LIMIT="${INTENT_RECENT_LIMIT}"
export DSH_EDGE_INTENT_CLOUD_KEYWORDS="${INTENT_CLOUD_KEYWORDS}"
export DSH_EDGE_INTENT_LOCAL_ENTITIES="${INTENT_LOCAL_ENTITIES}"
export DSH_EDGE_INTENT_FALLBACK_KEYWORDS="${INTENT_FALLBACK_KEYWORDS}"

# ── input-guard 降级路径（cloud-key 缺失 / intent=LOCAL / sanitize 失败）──
# §7.75: DSH_EDGE_LOCAL_MODEL **直接从 LOCAL_LLM 池派生**（不引入
# INPUT_GUARD_LOCAL_MODEL 变量）：
#   1) input-guard.ts:79 Schema default 'qwen3-4b-instruct-2507' 跟
#      LOCAL_LLM_MODEL='qwen3.7-plus' 错开，必须靠 .env 注入纠正
#   2) 注入值必须等于 LOCAL_LLM_MODEL（否则 ops log `route override
#      ... toModel=...` 跟 local-llm-adapter 实际发 model 错开）
#   3) 既然"必须等于"，就**直接派生**——不留 INPUT_GUARD_LOCAL_MODEL
#      覆盖项（用户改 LOCAL_LLM_MODEL 时自动跟随）
export DSH_EDGE_LOCAL_MODEL="${LOCAL_LLM_MODEL}"

# ── Agent persona ──────────────────────────────────────────────────
export DSH_EDGE_PERSONA="${PERSONA}"

# ── Input-Guard / Privacy-Policy / Realm-Bridge ─────────────────────
export DSH_EDGE_INPUT_GUARD="${INPUT_GUARD_ENABLED}"
export DSH_EDGE_REJECT_POLICY="${REJECT_POLICY_ENABLED}"
export DSH_EDGE_SANITIZE_DOWNGRADE="${SANITIZE_DOWNGRADE_ENABLED}"
export DSH_EDGE_REALM_HOT_RELOAD="${REALM_HOT_RELOAD}"
export DSH_EDGE_REALM_WATCH_MS="${REALM_WATCH_MS}"

# ── local-tools 写权限白名单 ───────────────────────────────────────
export DSH_EDGE_LOCAL_TOOLS_WRITABLE="${LOCAL_TOOLS_WRITABLE}"
export DSH_EDGE_LOCAL_TOOLS_ALLOWLIST="${LOCAL_TOOLS_ALLOWLIST}"

# ── 权限模式 ────────────────────────────────────────────────────────
export DSH_EDGE_PERMISSION_MODE="${PERMISSION_MODE}"

# ── Audit / Ops Log ────────────────────────────────────────────────
export DSH_EDGE_AUDIT_MIN_LEVEL="${AUDIT_MIN_LEVEL}"
export DSH_EDGE_AUDIT_FLUSH_MS="${AUDIT_FLUSH_MS}"
export DSH_EDGE_LOG_LEVEL="${LOG_LEVEL}"
export DSH_EDGE_LOG_MAX_AGE_DAYS="${LOG_MAX_AGE_DAYS}"
export DSH_EDGE_LOG_MAX_ROTATED="${LOG_MAX_ROTATED}"

# ── Session / Sanitizer 资源限制 ────────────────────────────────────
export DSH_EDGE_MAX_SESSIONS="${MAX_SESSIONS}"
export DSH_EDGE_MAX_BODY_BYTES="${MAX_BODY_BYTES}"
export DSH_EDGE_SESSION_IDLE_MS="${SESSION_IDLE_MS}"
export DSH_EDGE_SAN_MAX_SESSIONS="${SAN_MAX_SESSIONS}"
export DSH_EDGE_SAN_SWEEP_MS="${SAN_SWEEP_MS}"
export DSH_EDGE_SAN_TTL_MS="${SAN_TTL_MS}"

# ── TEE / Attestation ───────────────────────────────────────────────
export DSH_EDGE_TEE_TYPE="${TEE_TYPE}"

# 4. 打印加载清单（secret 脱敏；调试时一目了然）
echo "[.env.sh] loaded from $_ENV_FILE:"
echo "  EDGE_API_KEY=${EDGE_API_KEY:+***set***}"
echo "  DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY:+***set***}"
echo "  DASHSCOPE_API_KEY=${DASHSCOPE_API_KEY:+***set***}"
echo "  HTTP_HOST=${HTTP_HOST:-<unset>}  HTTP_PORT=${HTTP_PORT:-<unset>}"
echo ""
echo "  ┌─ LLM Pools ──────────────────────────────────────────"
echo "  │ CLOUD_LLM_BASEURL=${CLOUD_LLM_BASEURL:-<unset>}"
echo "  │ CLOUD_LLM_MODEL=${CLOUD_LLM_MODEL:-<unset>}"
echo "  │ CLOUD_LLM_KEY_ENV=${CLOUD_LLM_KEY_ENV:-<unset>}"
echo "  │ LOCAL_LLM_BASEURL=${LOCAL_LLM_BASEURL:-<unset>}"
echo "  │ LOCAL_LLM_MODEL=${LOCAL_LLM_MODEL:-<unset>}"
echo "  │ LOCAL_LLM_KEY_ENV=${LOCAL_LLM_KEY_ENV:-<unset>}"
echo "  │"
echo "  └─ Stage → Provider pointers ───────────────────────────"
echo "    GUARD_PROVIDER         = ${GUARD_PROVIDER}  → model=$(_resolve_model "$GUARD_PROVIDER")"
echo "    INTENT_PROVIDER        = ${INTENT_PROVIDER}  → model=$(_resolve_model "$INTENT_PROVIDER")"
echo ""
echo "  input-guard 降级路径: provider=local-llm (Schema default) / model=派生自 LOCAL_LLM"
echo ""
echo "  ※ 主对话 LLM 路由：不存在 MAIN_PROVIDER / MODEL_ROUTER_DEFAULT / ROUTER_LOCAL_PROVIDER；"
echo "      永远由 intent 分类结果决定（agent-default-model row 兜底 = CLOUD 池）"
echo "      intent=LOCAL      → local-llm / $LOCAL_LLM_MODEL"
echo "      intent=CLOUD      → cloud-llm / $CLOUD_LLM_MODEL"
echo "      intent=SANITIZED  → sanitize 后同上"
echo "      intent=REJECT     → 4xx 拒"
echo ""
echo "  PERSONA=${PERSONA:+***set***}"
echo "  AUDIT_MIN_LEVEL=${AUDIT_MIN_LEVEL:-<unset>}  LOG_LEVEL=${LOG_LEVEL:-<unset>}"
