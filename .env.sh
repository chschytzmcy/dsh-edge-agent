#!/usr/bin/env bash
# .env 加载器：把 .env 里所有 KEY=VALUE export 到当前 shell。
# 所有 secret 都在 .env 里。本脚本默认 DSH_EDGE_* 配置为空 export，
# 由调用方在调用前 export 具体配置，或者由 plugin Schema 用默认值。
#
# 用法:
#   source .env.sh                              # 只加载 .env 的 secret（plugin 用默认配置）
#   DSH_EDGE_LOCAL_LLM_BASEURL=... source .env.sh  # 在 source 前 export 覆盖
#   或在 .env.sh 里直接改下方 export（推荐，只改一处）
#
# §7.43: 默认 profile = dsh-tui（mandatory primary）

# 解析脚本自身位置（兼容 source 和 bash 直接调用）
_ENV_SH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)"

# .env 查找顺序：cwd > 脚本所在目录
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

# 1. 把 .env 的 secret 自动 export 到当前 shell
set -a
. "$_ENV_FILE"
set +a

# 2. DSH_EDGE_* 配置（默认值在这里，想换 local LLM 模型就改这一段）
#    ↓↓↓ 当前：阿里云 DashScope qwen3.7-plus（2026-09-11 切换） ↓↓↓
#    切回本地 llama.cpp 时改 LOCAL_LLM_BASEURL/MODEL，KEY_ENV 留空。
export DSH_EDGE_HTTP_PORT="${DSH_EDGE_HTTP_PORT:-21017}"
export DSH_EDGE_PROVIDER="${DSH_EDGE_PROVIDER:-cloud-llm}"
export DSH_EDGE_MODEL="${DSH_EDGE_MODEL:-deepseek-chat}"
export DSH_EDGE_LOCAL_LLM_BASEURL="${DSH_EDGE_LOCAL_LLM_BASEURL:-https://coding.dashscope.aliyuncs.com/v1}"
export DSH_EDGE_LOCAL_LLM_MODEL="${DSH_EDGE_LOCAL_LLM_MODEL:-qwen3.7-plus}"
export DSH_EDGE_LOCAL_LLM_KEY_ENV="${DSH_EDGE_LOCAL_LLM_KEY_ENV:-DASHSCOPE_API_KEY}"
export DSH_EDGE_INTENT_PROVIDER="${DSH_EDGE_INTENT_PROVIDER:-local-llm}"
# §7.52 (2026-09-13): default now matches DSH_EDGE_LOCAL_LLM_MODEL
# (qwen3.7-plus, 2026-09-11 switch). Pre-§7.52 default was the stale
# "qwen3-4b-instruct-2507" string — when DSH_EDGE_INTENT_MODEL wasn't
# explicitly exported, llm/stream probe logs showed model=Qwen3-4B-Instruct-2507
# even though the real intent classifier was actually calling
# qwen3.7-plus. Now the two stay in sync by default.
export DSH_EDGE_INTENT_MODEL="${DSH_EDGE_INTENT_MODEL:-qwen3.7-plus}"
# §7.52 (2026-09-13): input-guard's `localModel` is read from
# DSH_EDGE_LOCAL_MODEL (NOT DSH_EDGE_INTENT_MODEL — see
# cordis.patch.yml:527). Without this export, the patch's
# `process.env.DSH_EDGE_LOCAL_MODEL ?? 'qwen3-4b-instruct-2507'`
# always falls back to the stale string, and prompt-guard /
# privacy-policy llm/stream probe logs show
# model=qwen3-4b-instruct-2507 even though the real call goes
# through qwen3.7-plus. Mirror DSH_EDGE_LOCAL_LLM_MODEL so the
# three naming paths (intent / llm / input-guard downgrade)
# converge by default.
export DSH_EDGE_LOCAL_MODEL="${DSH_EDGE_LOCAL_MODEL:-${DSH_EDGE_LOCAL_LLM_MODEL:-qwen3.7-plus}}"
# §7.52 (2026-09-13): prompt-guard's modelDetectionModel (the LLM
# call used to detect "is user asking me to claim a different
# identity?") reads DSH_EDGE_GUARD_MODEL_MODEL (yes, the name has
# a duplicated "MODEL" — cordis.patch.yml:458). Without this
# export, prompt-guard falls back to the stale
# 'Qwen3-4B-Instruct-2507' string and guard.model-detect.start
# events show model=Qwen3-4B-Instruct-2507 even though the real
# LLM call goes through qwen3.7-plus. Mirror DSH_EDGE_LOCAL_LLM_MODEL
# so the local classifier naming paths converge.
export DSH_EDGE_GUARD_MODEL_MODEL="${DSH_EDGE_GUARD_MODEL_MODEL:-${DSH_EDGE_LOCAL_LLM_MODEL:-qwen3.7-plus}}"
# §7.54.4 (2026-09-14): bump default timeout for synchronous LLM calls.
# Pre-§7.54.4 default was 4000ms — intent-router classify (345-char Chinese
# prompt) was being aborted at 4s on DashScope's streaming API; prompt-guard
# model detection (124-char English safety prompt) was OK at ~2.7s but had
# no headroom.
# §7.54.5 (2026-09-14): DashScope qwen3.7-plus streaming 限流时 server 保持
# 连接但不发 chunk，10s/8s 仍 abort（2 次 chat 中 1 次 abort）。user 决定
# 再延：intent-router 30000ms，prompt-guard 15000ms。Worst case 增加 ~20s
# latency，但 fail-open safe 仍兜底。
# §7.54.6 (2026-09-14): TUI 实测 prompt-guard 仍 15s abort（15004ms 撞墙），
# intent-router 9.2s 成功（30s budget 内）。prompt-guard 15000→20000ms，给
# DashScope 限流更多 headroom；intent-router 30s 不动。Override by exporting
# these env vars before `source .env.sh`.
export DSH_EDGE_GUARD_MODEL_TIMEOUT_MS="${DSH_EDGE_GUARD_MODEL_TIMEOUT_MS:-20000}"
export DSH_EDGE_INTENT_LLM_TIMEOUT_MS="${DSH_EDGE_INTENT_LLM_TIMEOUT_MS:-30000}"
export DSH_EDGE_LOCAL_TOOLS_WRITABLE="${DSH_EDGE_LOCAL_TOOLS_WRITABLE:-true}"
export DSH_EDGE_LOCAL_TOOLS_ALLOWLIST="${DSH_EDGE_LOCAL_TOOLS_ALLOWLIST:-/tmp,/home/etsme/cy/agent/dsh-edge-agent}"
export DSH_PERMISSION_MODE="${DSH_PERMISSION_MODE:-workspace-write}"
export DSH_EDGE_PERMISSION_MODE="${DSH_EDGE_PERMISSION_MODE:-workspace-write}"
export DSH_EDGE_AUDIT_MIN_LEVEL="${DSH_EDGE_AUDIT_MIN_LEVEL:-info}"
# 2026-09-11: ops log 默认 info，过滤 LLM body debug calls（LLM_REQUEST/MESSAGES/RESPONSE/RESPONSE_TEXT）。
# 调试时手动 export DSH_EDGE_LOG_LEVEL=debug 打开 body capture。详情见 PROGRESS §7.XX。
export DSH_EDGE_LOG_LEVEL="${DSH_EDGE_LOG_LEVEL:-info}"
# DEEPSEEK_BASE_URL 是 DSH 黑名单变量（launching environment only），不放 .env。
# 如果要改 base URL，在 export 行直接写：export DEEPSEEK_BASE_URL=https://...

# 3. 打印已加载变量（secret 脱敏）
echo "[.env.sh] loaded from $_ENV_FILE:"
echo "  EDGE_API_KEY=${EDGE_API_KEY:-<unset>}"
echo "  DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY:+***set***}"
echo "  DASHSCOPE_API_KEY=${DASHSCOPE_API_KEY:+***set***}"
echo "  DSH_EDGE_HTTP_PORT=${DSH_EDGE_HTTP_PORT:-<unset>}"
echo "  DSH_EDGE_PROVIDER=${DSH_EDGE_PROVIDER:-<unset>}"
echo "  DSH_EDGE_MODEL=${DSH_EDGE_MODEL:-<unset>}"
echo "  DSH_EDGE_LOCAL_LLM_BASEURL=${DSH_EDGE_LOCAL_LLM_BASEURL:-<unset>}"
echo "  DSH_EDGE_LOCAL_LLM_MODEL=${DSH_EDGE_LOCAL_LLM_MODEL:-<unset>}"
echo "  DSH_EDGE_LOCAL_LLM_KEY_ENV=${DSH_EDGE_LOCAL_LLM_KEY_ENV:-<unset>}"
echo "  DSH_EDGE_INTENT_PROVIDER=${DSH_EDGE_INTENT_PROVIDER:-<unset>}"
echo "  DSH_EDGE_INTENT_MODEL=${DSH_EDGE_INTENT_MODEL:-<unset>}"
echo "  DSH_EDGE_LOCAL_MODEL=${DSH_EDGE_LOCAL_MODEL:-<unset>}"
echo "  DSH_EDGE_GUARD_MODEL_MODEL=${DSH_EDGE_GUARD_MODEL_MODEL:-<unset>}"
echo "  DSH_EDGE_GUARD_MODEL_TIMEOUT_MS=${DSH_EDGE_GUARD_MODEL_TIMEOUT_MS:-<unset>}"
echo "  DSH_EDGE_INTENT_LLM_TIMEOUT_MS=${DSH_EDGE_INTENT_LLM_TIMEOUT_MS:-<unset>}"
