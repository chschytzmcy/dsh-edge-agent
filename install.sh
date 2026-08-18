#!/bin/sh
# dsh-edge-agent 一键安装（npm 版）。
#
# 走官方 dsh CLI 的 profile 插件机制：`add` 自动初始化 profile（首层
# dsh-base），pnpm 安装后按 dsh.bundle.patch 元数据把本包追加为 bundle
# 层；本包的 patch 会一并 insert 全部 19 个核心插件。一条命令全部就绪。
# 无需 DSH 源码快照，无需 workspace 链接。
#
# 前置：
#   - dsh CLI 已安装（npm install -g @deepseek-ai/dsh）
#   - pnpm 已安装（npm install -g pnpm 或 corepack enable pnpm）
#
# 用法：
#   ./install.sh                       # 装到默认 profile dsh-edge-agent
#   DSH_EDGE_PROFILE=my-edge ./install.sh
set -eu

if ! command -v dsh >/dev/null 2>&1; then
  echo "未检测到 dsh CLI。先安装官方客户端：" >&2
  echo "  npm install -g @deepseek-ai/dsh" >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "未检测到 pnpm。dsh plugin 把安装转发给 pnpm，请先安装：" >&2
  echo "  npm install -g pnpm   （或启用 corepack：corepack enable pnpm）" >&2
  exit 1
fi

PROFILE="${DSH_EDGE_PROFILE:-dsh-edge-agent}"
echo "==> 在 profile '${PROFILE}' 中安装 @deepseek-harness-edge-agent/dsh-edge-agent"
dsh plugin --profile "${PROFILE}" add @deepseek-harness-edge-agent/dsh-edge-agent

cat <<'EOF'

安装完成。

启动方式：
  dsh-edge-agent                   # 全局安装后
  dsh --profile dsh-edge-agent     # 或直接调用 dsh CLI

可选环境变量（详见 README / docs/configuration.md）：
  DSH_EDGE_TEE_TYPE=trustzone|keystone|simulated  TEE 后端
  DSH_EDGE_STORAGE_ROOT=~/.dsh-edge-agent          加密存储根目录
  DSH_EDGE_POLICY_PATH=...                         隐私策略文件路径
  DSH_EDGE_DEFAULT_DATA_LEVEL=public|sanitized|internal
  DSH_EDGE_BRIDGE_MODE=ohttp|tls|auto             出站模式
  DSH_EDGE_PERMISSION_MODE=ask|workspace-write|danger-full-access

Windows 也可以用仓库根目录的 dsh-edge-agent.cmd（--resume 恢复上次会话）。

EOF