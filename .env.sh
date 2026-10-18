#!/usr/bin/env bash
# .env.sh —— dsh-edge-agent 部署 wrapper（**无 hardcoded 默认值**）
#
# 设计原则（2026-09-17 §7.75 "统一下"；2026-10-18 §7.100 收敛为"只配 LOCAL"）：
#   .env          = LOCAL_LLM_* （唯一必配）
#                   CLOUD_LLM_* （可选：配了=自研直连云池；不配=cloud-llm
#                   路由 delegate 到宿主 profile 已配置的模型提供商）
#                   + 可选 stage→provider 指针 + 其他非 LLM 配置
#                   裸名（无 DSH_/XDG_/DYLD_/BASH_FUNC_ 前缀 —— 避开 DSH
#                   launcher 黑名单，dsh-app-boot/lib/index.js:933-1015）
#   .env.sh       = **反查逻辑** —— 读 .env 池 + 指针 → 展开成 DSH_EDGE_*
#                   命名空间的 stage 复合变量（PROVIDER+MODEL 配对）
#                   **不允许**任何 `${VAR:-hardcoded_default}` 形式的
#                   hardcoded fallback；fallback 全部下沉到 plugin Schema
#                   §7.100: **空值一律不导出**（_export_if）——旧写法
#                   export X="${UNSET}" 产生空串，而 patch 消费端全部用
#                   `??`（只跳 undefined 不跳空串），"未配置"被当成"配置成
#                   空"破坏兜底链（云池未配时 baseUrl:'' 就是这条洞）。
#   plugin Schema = 默认值兜底（在源码里，已存在）
#
# 三层 fallback 链：
#   .env 真值（指针+池） → .env.sh 反查展开（空=跳过，保持 unset） → plugin Schema fallback
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

# ── §7.100 条件导出 ─────────────────────────────────────────────────
# 空值（未配置）保持 **unset**，让 cordis.patch.yml 的 `??` / `||` 链
# 落到 plugin Schema 默认。历史写法 `export X="${UNSET}"` 会把"未配置"
# 变成"配置成空串"，在 `??` 消费端等效于合法值 —— 云池 baseUrl:''
# 事故（§7.98 部署假阴性的同族根因）就是这么来的。
_export_if() {
  _ei_name="$1"; _ei_value="$2"
  if [ -n "$_ei_value" ]; then
    export "${_ei_name}=${_ei_value}"
  fi
  return 0
}

# 2. 校验：stage 指针必须 ∈ {cloud-llm, local-llm}
#    §7.75: 只剩 2 个 stage 指针（GUARD/INTENT）——
#    ROUTER_LOCAL_PROVIDER 已删（input-guard 降级路径硬编码 local-llm），
#    MAIN_PROVIDER / MODEL_ROUTER_DEFAULT 已删
#    §7.100: 空指针 = 不注入（跳过），落 plugin Schema 默认
#    （guard/intent 默认 local-llm）。配置面收敛为"只配 LOCAL_LLM_*"。
for _stage_var in GUARD_PROVIDER INTENT_PROVIDER; do
  _stage_val="${!_stage_var}"
  if [ -z "$_stage_val" ]; then
    continue
  fi
  case "$_stage_val" in
    cloud-llm|local-llm) ;;
    *)
      echo "[.env.sh] FATAL: $_stage_var='$_stage_val' (must be 'cloud-llm' or 'local-llm', or empty for schema default)" >&2
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
_export_if DSH_EDGE_HTTP_HOST "${HTTP_HOST}"
_export_if DSH_EDGE_HTTP_PORT "${HTTP_PORT}"

# ============================================================
# LLM Stage 复合变量（cordis.patch.yml 期望 PROVIDER+MODEL 配对）
# ============================================================
# 反查：每个 stage 的 provider 指针 → 池里取对应 model/baseurl/key_env
#
# §7.75 语义保留：DSH_EDGE_PROVIDER / DSH_EDGE_MODEL 是 agent-loop 在
# 没有更具体 routing（意图分类 / modelRouter.resolve）时用的兜底；实际
# 请求路径的 provider/model 由 **意图分类结果** 决定。
# §7.100 变更：agent-default-model override row 已删（宿主选择直接生效）；
# 云池从"必配"变为"可选"——不配 CLOUD_LLM_BASEURL 时 cloud-llm 路由
# delegate 到宿主 profile 提供商，DSH_EDGE_MODEL 保持 unset（plugin
# Schema 'deepseek-chat' 仅余 input-guard 取证镜像一个消费方）。
_DEFAULT_FALLBACK_PROVIDER="cloud-llm"

# ── agent-loop 兜底指针（意图分类失败时 fallback；§7.100: model 可选） ─
export DSH_EDGE_PROVIDER="${_DEFAULT_FALLBACK_PROVIDER}"
_export_if DSH_EDGE_MODEL "$(_resolve_model "$_DEFAULT_FALLBACK_PROVIDER")"

# ── Cloud LLM 池（cloud-llm-adapter DIRECT 模式 config；§7.100 可选） ─
# 三个都不配 → adapter baseUrl='' → DELEGATE 模式：cloud-llm 路由转发到
# 宿主 profile 已配置的模型提供商（GUI selection > live 宿主路由），
# key/凭据归宿主 adapter（edge 侧不碰任何 secret）。
# 配置了 CLOUD_LLM_BASEURL → 自研直连（行为与 §7.83 完全一致）。
_export_if DSH_EDGE_CLOUD_LLM_BASEURL "${CLOUD_LLM_BASEURL}"
_export_if DSH_EDGE_CLOUD_KEY_ENV "${CLOUD_LLM_KEY_ENV}"
# delegate 旋钮（全可选，直接透传 DSH_EDGE_* —— 这两个本来就带前缀的
# 可选 override 由 .env 裸名镜像提供，保持"配置单源在 .env"的习惯）
_export_if DSH_EDGE_CLOUD_DELEGATE "${CLOUD_DELEGATE}"
_export_if DSH_EDGE_CLOUD_DELEGATE_PROVIDER "${CLOUD_DELEGATE_PROVIDER}"
_export_if DSH_EDGE_CLOUD_DELEGATE_MODEL "${CLOUD_DELEGATE_MODEL}"

# ── Local LLM 池（local-llm-adapter config；§7.100 唯一必配的池） ─
_export_if DSH_EDGE_LOCAL_LLM_BASEURL "${LOCAL_LLM_BASEURL}"
_export_if DSH_EDGE_LOCAL_LLM_MODEL "${LOCAL_LLM_MODEL}"
_export_if DSH_EDGE_LOCAL_LLM_KEY_ENV "${LOCAL_LLM_KEY_ENV}"
if [ -z "${LOCAL_LLM_BASEURL}" ]; then
  echo "[.env.sh] WARN: LOCAL_LLM_BASEURL 未配置 —— §7.100 后它是唯一必配项。" >&2
  echo "             LOCAL-intent / input-guard 降级路径会打到 patch 兜底端点，" >&2
  echo "             连接失败将显式报错（502 / error 帧），不再是静默空回复。" >&2
fi
# §7.4? (2026-09-17) opt-in workaround for LAN minicpm5-2b server
# Jinja2 `tojson(ensure_ascii)` bug. .env 必须显式给 LOCAL_LLM_STRIP_TOOLS
# (false / true),不允许 fallback —— 跟 header "不允许 ${VAR:-default}" 原则
# 对齐(plugin Schema 的 default(false) 兜底)。
_export_if DSH_EDGE_LOCAL_LLM_STRIP_TOOLS "${LOCAL_LLM_STRIP_TOOLS}"
# §7.87.5 (2026-09-19): thinking-model 兼容 — 默认关掉 qwen3.5/QwQ/DeepSeek-R1
# 的 chain-of-thought;开不开由 .env LOCAL_LLM_ENABLE_THINKING 决定(false=关)。
_export_if DSH_EDGE_LOCAL_LLM_ENABLE_THINKING "${LOCAL_LLM_ENABLE_THINKING}"

# ── prompt-guard 模型层（Stage 6） ────────────────────────────────
# §7.100: 指针空 = 整段跳过（provider/model 落 Schema 默认 local-llm）。
_export_if DSH_EDGE_GUARD_MODEL "${GUARD_MODEL_ENABLED}"
if [ -n "${GUARD_PROVIDER}" ]; then
  _export_if DSH_EDGE_GUARD_MODEL_PROVIDER "${GUARD_PROVIDER}"
  _export_if DSH_EDGE_GUARD_MODEL_MODEL "$(_resolve_model "$GUARD_PROVIDER")"
fi
_export_if DSH_EDGE_GUARD_MODEL_TIMEOUT_MS "${GUARD_MODEL_TIMEOUT_MS}"
_export_if DSH_EDGE_GUARD_MODEL_MAX_INPUT "${GUARD_MODEL_MAX_INPUT}"

# ── 意图路由 ───────────────────────────────────────────────────────
if [ -n "${INTENT_PROVIDER}" ]; then
  _export_if DSH_EDGE_INTENT_PROVIDER "${INTENT_PROVIDER}"
  _export_if DSH_EDGE_INTENT_MODEL "$(_resolve_model "$INTENT_PROVIDER")"
fi
_export_if DSH_EDGE_INTENT_LLM_TIMEOUT_MS "${INTENT_LLM_TIMEOUT_MS}"
_export_if DSH_EDGE_INTENT_CONFIDENCE_THRESHOLD "${INTENT_CONFIDENCE_THRESHOLD}"
_export_if DSH_EDGE_INTENT_MAX_INPUT "${INTENT_MAX_INPUT}"
_export_if DSH_EDGE_INTENT_RECENT_LIMIT "${INTENT_RECENT_LIMIT}"
_export_if DSH_EDGE_INTENT_CLOUD_KEYWORDS "${INTENT_CLOUD_KEYWORDS}"
_export_if DSH_EDGE_INTENT_LOCAL_ENTITIES "${INTENT_LOCAL_ENTITIES}"
_export_if DSH_EDGE_INTENT_FALLBACK_KEYWORDS "${INTENT_FALLBACK_KEYWORDS}"
# §7.92.3 (2026-09-23): jev HTTP intent recognizer (toggle, opt-in).
# Default OFF; toggle=true 把 jev 插到 classify() 流水线里 LLM 之前。
# jev 不可达/低置信/无映射 → fall through 到 LLM,行为不回归。
# 意图分类 spec（描述 + jev intent 列表）从 config/privacy-policy.json#categories 读,
# 不需要单独 env:运维人员直接编辑 JSON 文件(privacy-policy 服务热加载 pick up)。
_export_if DSH_EDGE_INTENT_JEV_ENABLED "${INTENT_JEV_ENABLED}"
_export_if DSH_EDGE_INTENT_JEV_URL "${INTENT_JEV_URL}"
_export_if DSH_EDGE_INTENT_JEV_TIMEOUT_MS "${INTENT_JEV_TIMEOUT_MS}"
_export_if DSH_EDGE_INTENT_JEV_CONFIDENCE_THRESHOLD "${INTENT_JEV_CONFIDENCE_THRESHOLD}"
_export_if DSH_EDGE_INTENT_JEV_RISK_THRESHOLD "${INTENT_JEV_RISK_THRESHOLD}"
# §7.92.6 (2026-09-24): circuit breaker — when all 3 jev batches fail,
# skip jev entirely for this many ms to avoid 7500ms wasted wall-clock.
_export_if DSH_EDGE_INTENT_JEV_BREAKER_TTL_MS "${INTENT_JEV_BREAKER_TTL_MS}"
# §7.92.7 (2026-09-24): boot probe + 周期 recovery probe. boot probe
# 在 apply() 时 fire-and-forget ping /health;失败即预开 breaker 让首次
# classify 直接 short-circuit(不付 3×timeoutMs)。周期 probe 在 breaker
# 开着期间每 N ms 探一次,2xx 即关 breaker(不必等 TTL 到期)。
_export_if DSH_EDGE_INTENT_JEV_BOOT_PROBE_ENABLED "${INTENT_JEV_BOOT_PROBE_ENABLED}"
_export_if DSH_EDGE_INTENT_JEV_BOOT_PROBE_TIMEOUT_MS "${INTENT_JEV_BOOT_PROBE_TIMEOUT_MS}"
_export_if DSH_EDGE_INTENT_JEV_BREAKER_PROBE_MS "${INTENT_JEV_BREAKER_PROBE_MS}"
_export_if DSH_EDGE_INTENT_JEV_PROBE_TIMEOUT_MS "${INTENT_JEV_PROBE_TIMEOUT_MS}"

# ── §7.93.1(2026-09-25 通用化)function-call-external prefill（全部默认 OFF，使能才生效） ────────
# ExternalToolCaller 由外部启动维护（current: cactus-needle 3.0.1 在 needle-http **:8081**，契约 GET /health +
# POST /extract，stateless 无需 /reset；playground 是外部 webui，本项目不走），**只做意图/工具调用提取，
# 服务端不翻译**（user 仲裁 v2）。
# client（function-call-external plugin）视角链路：
#   LOCAL/SANITIZED intent
#     → POST /extract {原文 query（中文直入，外部 caller 自带 cn_grounding 归一化数字），英文 tool schemas} → function_calls
#     → TS tool-runner 执行（realm/PII/audit 不绕过）
#     → **整个对话（user + tool_calls + 执行结果）给 LOCAL LLM 输出最终回复**
# CLOUD intent 不走 caller；caller down/低置信 fall through 到现有 LLM 自提取。
# §7.93 Phase 5 末 user 终裁：管什么语种 caller 直接用；NEEDLE_TRANSLATE_* 三个 env 在 §7.93.5
# 全部删除（原 12 字段 → 9 字段），
export DSH_EDGE_FUNCTION_CALL_EXTERNAL_ENABLED="${FUNCTION_CALL_EXTERNAL_ENABLED:-false}"
export DSH_EDGE_FUNCTION_CALL_EXTERNAL_URL="${FUNCTION_CALL_EXTERNAL_URL:-http://127.0.0.1:8081}"
export DSH_EDGE_FUNCTION_CALL_EXTERNAL_TIMEOUT_MS="${FUNCTION_CALL_EXTERNAL_TIMEOUT_MS:-10000}"
export DSH_EDGE_FUNCTION_CALL_EXTERNAL_CONFIDENCE_THRESHOLD="${FUNCTION_CALL_EXTERNAL_CONFIDENCE_THRESHOLD:-0.5}"
export DSH_EDGE_FUNCTION_CALL_EXTERNAL_BREAKER_TTL_MS="${FUNCTION_CALL_EXTERNAL_BREAKER_TTL_MS:-30000}"
export DSH_EDGE_FUNCTION_CALL_EXTERNAL_BOOT_PROBE_ENABLED="${FUNCTION_CALL_EXTERNAL_BOOT_PROBE_ENABLED:-true}"
export DSH_EDGE_FUNCTION_CALL_EXTERNAL_BOOT_PROBE_TIMEOUT_MS="${FUNCTION_CALL_EXTERNAL_BOOT_PROBE_TIMEOUT_MS:-2000}"
export DSH_EDGE_FUNCTION_CALL_EXTERNAL_BREAKER_PROBE_MS="${FUNCTION_CALL_EXTERNAL_BREAKER_PROBE_MS:-5000}"
export DSH_EDGE_FUNCTION_CALL_EXTERNAL_PROBE_TIMEOUT_MS="${FUNCTION_CALL_EXTERNAL_PROBE_TIMEOUT_MS:-2000}"

# ── input-guard 降级路径（cloud-key 缺失 / intent=LOCAL / sanitize 失败）──
# §7.75: DSH_EDGE_LOCAL_MODEL **直接从 LOCAL_LLM 池派生**（不引入
# INPUT_GUARD_LOCAL_MODEL 变量）：
#   1) input-guard.ts:79 Schema default 'qwen3-4b-instruct-2507' 跟
#      LOCAL_LLM_MODEL='qwen3.7-plus' 错开，必须靠 .env 注入纠正
#   2) 注入值必须等于 LOCAL_LLM_MODEL（否则 ops log `route override
#      ... toModel=...` 跟 local-llm-adapter 实际发 model 错开）
#   3) 既然"必须等于"，就**直接派生**——不留 INPUT_GUARD_LOCAL_MODEL
#      覆盖项（用户改 LOCAL_LLM_MODEL 时自动跟随）
_export_if DSH_EDGE_LOCAL_MODEL "${LOCAL_LLM_MODEL}"

# ── Agent persona ──────────────────────────────────────────────────
_export_if DSH_EDGE_PERSONA "${PERSONA}"

# ── Input-Guard / Privacy-Policy / Realm-Bridge ─────────────────────
_export_if DSH_EDGE_INPUT_GUARD "${INPUT_GUARD_ENABLED}"
_export_if DSH_EDGE_REJECT_POLICY "${REJECT_POLICY_ENABLED}"
_export_if DSH_EDGE_SANITIZE_DOWNGRADE "${SANITIZE_DOWNGRADE_ENABLED}"
_export_if DSH_EDGE_REALM_HOT_RELOAD "${REALM_HOT_RELOAD}"
_export_if DSH_EDGE_REALM_WATCH_MS "${REALM_WATCH_MS}"

# ── local-tools 写权限白名单 ───────────────────────────────────────
_export_if DSH_EDGE_LOCAL_TOOLS_WRITABLE "${LOCAL_TOOLS_WRITABLE}"
_export_if DSH_EDGE_LOCAL_TOOLS_ALLOWLIST "${LOCAL_TOOLS_ALLOWLIST}"

# ── 权限模式 ────────────────────────────────────────────────────────
_export_if DSH_EDGE_PERMISSION_MODE "${PERMISSION_MODE}"

# ── Audit / Ops Log ────────────────────────────────────────────────
_export_if DSH_EDGE_AUDIT_MIN_LEVEL "${AUDIT_MIN_LEVEL}"
_export_if DSH_EDGE_AUDIT_FLUSH_MS "${AUDIT_FLUSH_MS}"
_export_if DSH_EDGE_LOG_LEVEL "${LOG_LEVEL}"
_export_if DSH_EDGE_LOG_MAX_AGE_DAYS "${LOG_MAX_AGE_DAYS}"
_export_if DSH_EDGE_LOG_MAX_ROTATED "${LOG_MAX_ROTATED}"

# ── Session / Sanitizer 资源限制 ────────────────────────────────────
_export_if DSH_EDGE_MAX_SESSIONS "${MAX_SESSIONS}"
_export_if DSH_EDGE_MAX_BODY_BYTES "${MAX_BODY_BYTES}"
_export_if DSH_EDGE_SESSION_IDLE_MS "${SESSION_IDLE_MS}"
_export_if DSH_EDGE_SAN_MAX_SESSIONS "${SAN_MAX_SESSIONS}"
_export_if DSH_EDGE_SAN_SWEEP_MS "${SAN_SWEEP_MS}"
_export_if DSH_EDGE_SAN_TTL_MS "${SAN_TTL_MS}"

# ── TEE / Attestation ───────────────────────────────────────────────
_export_if DSH_EDGE_TEE_TYPE "${TEE_TYPE}"

# 4. 打印加载清单（secret 脱敏；调试时一目了然）
echo "[.env.sh] loaded from $_ENV_FILE:"
echo "  EDGE_API_KEY=${EDGE_API_KEY:+***set***}"
echo "  DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY:+***set***}"
echo "  DASHSCOPE_API_KEY=${DASHSCOPE_API_KEY:+***set***}"
echo "  HTTP_HOST=${HTTP_HOST:-<unset>}  HTTP_PORT=${HTTP_PORT:-<unset>}"
echo ""
echo "  ┌─ LLM Pools ──────────────────────────────────────────"
if [ -n "${CLOUD_LLM_BASEURL:-}" ]; then
  echo "  │ CLOUD_LLM_BASEURL=${CLOUD_LLM_BASEURL}  (DIRECT 模式)"
  echo "  │ CLOUD_LLM_MODEL=${CLOUD_LLM_MODEL:-<unset>}  CLOUD_LLM_KEY_ENV=${CLOUD_LLM_KEY_ENV:-<unset>}"
else
  echo "  │ CLOUD_LLM_BASEURL=<unset>  → §7.100 DELEGATE: cloud-llm = 宿主 profile 提供商"
fi
echo "  │ LOCAL_LLM_BASEURL=${LOCAL_LLM_BASEURL:-<unset>}"
echo "  │ LOCAL_LLM_MODEL=${LOCAL_LLM_MODEL:-<unset>}  LOCAL_LLM_KEY_ENV=${LOCAL_LLM_KEY_ENV:-<unset>}"
echo "  │"
echo "  └─ Stage → Provider pointers ───────────────────────────"
if [ -n "${GUARD_PROVIDER:-}" ]; then
  echo "    GUARD_PROVIDER         = ${GUARD_PROVIDER}  → model=$(_resolve_model "${GUARD_PROVIDER}")"
else
  echo "    GUARD_PROVIDER         = <unset>  → Schema default (local-llm)"
fi
if [ -n "${INTENT_PROVIDER:-}" ]; then
  echo "    INTENT_PROVIDER        = ${INTENT_PROVIDER}  → model=$(_resolve_model "${INTENT_PROVIDER}")"
else
  echo "    INTENT_PROVIDER        = <unset>  → Schema default (local-llm)"
fi
echo ""
echo "  input-guard 降级路径: provider=local-llm (Schema default) / model=派生自 LOCAL_LLM"
echo ""
echo "  ※ 主对话 LLM 路由：永远由 intent 分类结果决定"
echo "      intent=LOCAL      → local-llm / ${LOCAL_LLM_MODEL:-<schema default>}"
echo "      intent=CLOUD      → cloud-llm / ${CLOUD_LLM_MODEL:-<delegate: 宿主选择>}  (§7.100)"
echo "      intent=SANITIZED  → sanitize 后同上"
echo "      intent=REJECT     → 4xx 拒"
echo ""
echo "  PERSONA=${PERSONA:+***set***}"
echo "  AUDIT_MIN_LEVEL=${AUDIT_MIN_LEVEL:-<unset>}  LOG_LEVEL=${LOG_LEVEL:-<unset>}"
