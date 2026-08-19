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
export DSH_EDGE_LOCAL_LLM_MODE="${DSH_EDGE_LOCAL_LLM_MODE:-real}"
export DSH_EDGE_LOCAL_LLM_BASEURL="${DSH_EDGE_LOCAL_LLM_BASEURL:-http://192.168.66.195:8701/v1}"
export DSH_EDGE_LOCAL_LLM_MODEL="${DSH_EDGE_LOCAL_LLM_MODEL:-qwen3-4b-instruct-2507}"

echo "[.env.sh] loaded:"
echo "  EDGE_API_KEY=${EDGE_API_KEY:-<unset>}"
echo "  DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY:+***set***}"
echo "  DSH_EDGE_HTTP_PORT=$DSH_EDGE_HTTP_PORT"
echo "  DSH_EDGE_PROVIDER=$DSH_EDGE_PROVIDER"
echo "  DSH_EDGE_LOCAL_LLM_MODE=$DSH_EDGE_LOCAL_LLM_MODE"
echo "  DSH_EDGE_LOCAL_LLM_BASEURL=$DSH_EDGE_LOCAL_LLM_BASEURL"
echo "  DSH_EDGE_LOCAL_LLM_MODEL=$DSH_EDGE_LOCAL_LLM_MODEL"