#!/usr/bin/env bash
# 从 .env 中导出允许的变量，然后 export 必须的 DSH_EDGE_* 变量并启动 dsh。
# 使用: source .env.sh && dsh --profile dsh-edge-agent
#       或: . .env.sh && dsh --profile dsh-edge-agent

# 1. 从 .env 加载允许的变量（业务变量 + 第三方 API Key）
if [ -f .env ]; then
  set -a
  # 仅 source 不含 DSH_EDGE_ 前缀的行（DSH 禁止 .env 设置）
  while IFS='=' read -r key value; do
    # 跳过空行和注释
    [[ -z "$key" || "$key" =~ ^# ]] && continue
    # 跳过 DSH_EDGE_* 变量（DSH 会拒绝）
    [[ "$key" == DSH_EDGE_* ]] && continue
    export "$key=$value"
  done < <(grep -v '^[[:space:]]*#' .env | grep -v '^[[:space:]]*$')
  set +a
fi

# 2. 设置默认 DSH_EDGE_* 变量（如果未设置）
export DSH_EDGE_HTTP_PORT="${DSH_EDGE_HTTP_PORT:-21017}"
export DSH_EDGE_PROVIDER="${DSH_EDGE_PROVIDER:-cloud-deepseek-v4}"
export DSH_EDGE_MODEL="${DSH_EDGE_MODEL:-deepseek-chat}"
export DSH_EDGE_LOCAL_LLM_BASEURL="${DSH_EDGE_LOCAL_LLM_BASEURL:-http://192.168.66.195:8701/v1}"
export DSH_EDGE_LOCAL_LLM_MODEL="${DSH_EDGE_LOCAL_LLM_MODEL:-qwen3-4b-instruct-2507}"
# 意图分类专用 provider / model（默认走真实本地 LLM）
export DSH_EDGE_INTENT_PROVIDER="${DSH_EDGE_INTENT_PROVIDER:-local-qwen3-4b}"
export DSH_EDGE_INTENT_MODEL="${DSH_EDGE_INTENT_MODEL:-qwen3-4b-instruct-2507}"
# local-tools：启用文件写入（默认只读）+ allowList（多个路径用逗号分隔）
export DSH_EDGE_LOCAL_TOOLS_WRITABLE="${DSH_EDGE_LOCAL_TOOLS_WRITABLE:-true}"
export DSH_EDGE_LOCAL_TOOLS_ALLOWLIST="${DSH_EDGE_LOCAL_TOOLS_ALLOWLIST:-/tmp,/home/etsme/cy/agent/dsh-edge-agent}"
# DSH sandbox 权限模式（默认 workspace-write，安全）
export DSH_PERMISSION_MODE="${DSH_PERMISSION_MODE:-workspace-write}"
export DSH_EDGE_PERMISSION_MODE="${DSH_EDGE_PERMISSION_MODE:-workspace-write}"
# 调试：把审计日志级别降到 debug，便于观察 session 事件流
export DSH_EDGE_AUDIT_MIN_LEVEL="${DSH_EDGE_AUDIT_MIN_LEVEL:-info}"

echo "[.env.sh] loaded:"
echo "  EDGE_API_KEY=${EDGE_API_KEY:-<unset>}"
echo "  DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY:+***set***}"
echo "  DSH_EDGE_HTTP_PORT=$DSH_EDGE_HTTP_PORT"
echo "  DSH_EDGE_PROVIDER=$DSH_EDGE_PROVIDER"
echo "  DSH_EDGE_LOCAL_LLM_BASEURL=$DSH_EDGE_LOCAL_LLM_BASEURL"
echo "  DSH_EDGE_LOCAL_LLM_MODEL=$DSH_EDGE_LOCAL_LLM_MODEL"
echo "  DSH_EDGE_INTENT_PROVIDER=$DSH_EDGE_INTENT_PROVIDER"
echo "  DSH_EDGE_INTENT_MODEL=$DSH_EDGE_INTENT_MODEL"
echo "  DSH_EDGE_LOCAL_TOOLS_WRITABLE=$DSH_EDGE_LOCAL_TOOLS_WRITABLE"
echo "  DSH_EDGE_LOCAL_TOOLS_ALLOWLIST=$DSH_EDGE_LOCAL_TOOLS_ALLOWLIST"
echo "  DSH_PERMISSION_MODE=$DSH_PERMISSION_MODE"
echo "  DSH_EDGE_PERMISSION_MODE=$DSH_EDGE_PERMISSION_MODE"