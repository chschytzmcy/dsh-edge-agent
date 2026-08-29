#!/bin/bash
# deploy.sh — 部署 dsh-edge-agent 到远程设备
#
# 用法:
#   ./deploy.sh <user@host> [ssh_port]
#
# 示例:
#   ./deploy.sh rockchip@192.168.1.121
#   ./deploy.sh root@192.168.1.100 2222
#
# 流程:
#   1. 测试 SSH 连接
#   2. 在目标设备上安装系统依赖（Node.js 22, pnpm, dsh CLI）
#   3. 本地构建和打包（make package）
#   4. 传输部署包到目标设备
#   5. 解压并安装项目依赖
#   6. 同步到 DSH profile home（dsh 真正加载的 ~/.dsh/profiles/<name>/）
#   7. 配置环境并启动服务

set -e

# 颜色
BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# 配置
REMOTE_PATH="/home/rockchip/dsh-edge-agent"
PACKAGE_NAME="dsh-edge-agent-deploy.tar.gz"

# 参数检查
if [ -z "$1" ]; then
    echo -e "${RED}错误: 缺少目标主机${NC}"
    echo ""
    echo "用法: $0 <user@host> [ssh_port]"
    echo ""
    echo "示例:"
    echo "  $0 rockchip@192.168.1.121"
    echo "  $0 root@192.168.1.100 2222"
    exit 1
fi

TARGET="$1"
SSH_PORT="${2:-22}"
SSH_OPTS="-p $SSH_PORT -o StrictHostKeyChecking=no"

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  dsh-edge-agent 远程部署工具${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo "目标主机: $TARGET"
echo "SSH 端口: $SSH_PORT"
echo "部署路径: $REMOTE_PATH"
echo ""

# Step 1: 测试 SSH 连接
echo -e "${BLUE}[1/7] 测试 SSH 连接...${NC}"
if ! ssh $SSH_OPTS "$TARGET" "echo 'SSH 连接成功'" 2>/dev/null; then
    echo -e "${RED}错误: 无法连接到 $TARGET${NC}"
    exit 1
fi
echo -e "${GREEN}✓ SSH 连接正常${NC}"
echo ""

# Step 2: 在目标设备上安装系统依赖
echo -e "${BLUE}[2/7] 在目标设备上安装系统依赖...${NC}"
ssh $SSH_OPTS "$TARGET" bash <<'REMOTE_SCRIPT'
set -e

echo "==> 检查并安装 Node.js 22..."
if ! command -v node &> /dev/null; then
    echo "  安装 Node.js 22..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
elif ! node --version | grep -q "v22\."; then
    echo "  升级 Node.js 到 v22..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
else
    echo "  Node.js $(node --version) 已安装"
fi

echo "==> 检查并安装 pnpm..."
if ! command -v pnpm &> /dev/null; then
    echo "  安装 pnpm..."
    sudo npm install -g pnpm
else
    echo "  pnpm $(pnpm --version) 已安装"
fi

echo "==> 检查并安装 DSH CLI..."
if ! command -v dsh &> /dev/null; then
    echo "  安装 @deepseek-ai/dsh..."
    sudo npm install -g @deepseek-ai/dsh
else
    echo "  DSH CLI 已安装"
fi

echo "✓ 系统依赖安装完成"
REMOTE_SCRIPT

echo -e "${GREEN}✓ 系统依赖安装完成${NC}"
echo ""

# Step 3: 本地构建和打包
echo -e "${BLUE}[3/7] 本地构建和打包...${NC}"
make package
echo -e "${GREEN}✓ 打包完成${NC}"
echo ""

# Step 4: 传输到目标设备
echo -e "${BLUE}[4/7] 传输部署包到目标设备...${NC}"
scp -P $SSH_PORT -o StrictHostKeyChecking=no "$PACKAGE_NAME" "$TARGET:/tmp/"
echo -e "${GREEN}✓ 传输完成${NC}"
echo ""

# Step 5: 解压并安装项目依赖
echo -e "${BLUE}[5/7] 解压并安装项目依赖...${NC}"
ssh $SSH_OPTS "$TARGET" bash <<REMOTE_SCRIPT
set -e

# 创建目标目录
sudo mkdir -p $(dirname $REMOTE_PATH)

# 解压
cd $(dirname $REMOTE_PATH)
sudo rm -rf dsh-edge-agent
sudo tar -xzf /tmp/$PACKAGE_NAME
sudo rm /tmp/$PACKAGE_NAME

# 修复权限
sudo chown -R \$(whoami):\$(whoami) dsh-edge-agent

# 安装项目依赖
cd dsh-edge-agent
pnpm install --ignore-scripts

echo "✓ 项目部署完成"
REMOTE_SCRIPT

echo -e "${GREEN}✓ 项目安装完成${NC}"
echo ""

# Step 6: 同步到 DSH profile home（DSH 实际从这里加载）
#
# 为什么需要这一步：DSH 不会从 \$REMOTE_PATH（解压目录）读配置，
# 它从 \$DSH_HOME/profiles/<name>/ 加载。deploy.sh 只把代码放到
# 解压目录是不够的；必须把编译产物、profile patch、.env 同步到
# ~/.dsh/profiles/dsh-edge-agent/，并确保嵌套包已通过
# `dsh plugin add` 初始化。
echo -e "${BLUE}[6/7] 同步到 DSH profile home...${NC}"
ssh $SSH_OPTS "$TARGET" bash <<REMOTE_SCRIPT
set -e

PROFILE="dsh-edge-agent"
DSH_HOME="\${DSH_HOME:-\$HOME/.dsh}"
PROFILE_DIR="\$DSH_HOME/profiles/\$PROFILE"
NESTED_PKG="\$PROFILE_DIR/node_modules/@deepseek-harness-edge-agent/dsh-edge-agent"

# 首次部署：profile 还没初始化时，调用 dsh plugin add
# 后续部署：跳过（pnpm 会重复跑依赖树，浪费时间）
if [ ! -d "\$NESTED_PKG/lib" ]; then
    echo "  -> dsh plugin add (bootstrap profile + nested package)"
    dsh plugin --profile "\$PROFILE" add @deepseek-harness-edge-agent/dsh-edge-agent
fi

# 把编译产物同步到 DSH profile 的嵌套包
mkdir -p "\$PROFILE_DIR"
rsync -a --delete "$REMOTE_PATH/lib/" "\$NESTED_PKG/lib/"

# 同步 profile 的 cordis.patch.yml（含 tool-web / web-search-guard 等插件挂载）
if [ -f "$REMOTE_PATH/profiles/\$PROFILE/cordis.patch.yml" ]; then
    cp "$REMOTE_PATH/profiles/\$PROFILE/cordis.patch.yml" "\$PROFILE_DIR/cordis.patch.yml"
fi

# 注意：不同步 profiles/\$PROFILE/package.json — `dsh plugin add` 已经
# 生成了正确的 package.json（bundles + deps 都指向 npm 包）。
# 项目级的 package.json 用 file:../../ 引用本地源码，远程设备上不存在。

# 同步 .env（业务变量 + API key），让 profile home 也有
if [ -f "$REMOTE_PATH/.env" ]; then
    cp "$REMOTE_PATH/.env" "\$PROFILE_DIR/.env"
fi

# 同步 privacy-policy.json（privacy-policy 插件的热加载策略文件）
if [ -f "$REMOTE_PATH/profiles/\$PROFILE/privacy-policy.json" ]; then
    cp "$REMOTE_PATH/profiles/\$PROFILE/privacy-policy.json" "\$PROFILE_DIR/privacy-policy.json"
fi

# 安装上游 web search + skill 包。
# web search 链：dsh-tool-web → web_search / web_fetch 工具
#               dsh-web → ctx.web 服务
#               dsh-web-search-deepseek → DeepSeek 搜索 provider
# skill 链：  dsh-skill → ctx.skills 注册表
#             dsh-tool-skill → model-facing skill 工具 + catalog 注入
#             dsh-skill-filesystem → ~/.agents/skills/ 自动发现
# web UI：   dsh-host-webserver → node:http 服务 web UI 前端 (端口 21018)
#             dsh-web-app → 浏览器 surface bundle + runtime glue
#             dsh-web-frontend → Vite 构建的 SPA 静态资源
#             dsh-web-ui-all → task-board/git-graph/pet/skin-center 全家桶
#             @xmanrui/dsh-im → IM 通道网关（飞书/微信/钉钉/企微/QQ/
#                              Slack/Telegram/Discord/WhatsApp + AI Office）；
#                              不开新端口，依赖 webserver 的 connection /
#                              apiProxy 服务，自动过 input-guard 隐私管线
# 缺任何一个都会导致对应功能不可用。`dsh plugin add` 是幂等的。
echo "  -> install upstream web-search + skill + web-ui + im packages"
for _pkg in \\
    @deepseek-ai/dsh-agent-loop \\
    @deepseek-ai/dsh-tool-web \\
    @deepseek-ai/dsh-web \\
    @deepseek-ai/dsh-web-search-deepseek \\
    @deepseek-ai/dsh-skill \\
    @deepseek-ai/dsh-tool-skill \\
    @deepseek-ai/dsh-skill-filesystem \\
    @deepseek-ai/dsh-host-webserver \\
    @deepseek-ai/dsh-web-app \\
    @deepseek-ai/dsh-web-frontend \\
    @linxin666/dsh-web-ui-all \\
    @xmanrui/dsh-im; do
    dsh plugin --profile "\$PROFILE" add "\$_pkg" >/dev/null 2>&1 || {
        echo "  warning: failed to add \$_pkg" >&2
    }
done

echo "✓ 已同步到 \$PROFILE_DIR"
REMOTE_SCRIPT

echo -e "${GREEN}✓ DSH profile 同步完成${NC}"
echo ""

# Step 7: 配置环境并启动
echo -e "${BLUE}[7/7] 配置环境并启动服务...${NC}"
ssh $SSH_OPTS "$TARGET" bash <<REMOTE_SCRIPT
cd $REMOTE_PATH

# 创建 .env 文件（如果不存在）
if [ ! -f .env ]; then
    cp .env.example .env
    echo "  已创建 .env 文件，请编辑配置"
fi

# 停止旧服务（如果有）
pkill -f 'dsh --profile dsh-edge-agent' 2>/dev/null || true
sleep 2

# 启动服务
source .env.sh
setsid bash -c 'source .env.sh && dsh --profile dsh-edge-agent' > /tmp/dsh.log 2>&1 < /dev/null &
sleep 3

# 验证
if curl -s http://127.0.0.1:21017/v1/health | grep -q '"status":"ok"'; then
    echo "✓ 服务启动成功"
else
    echo "⚠ 服务可能未完全启动，请检查日志: tail -f /tmp/dsh.log"
fi
REMOTE_SCRIPT

echo -e "${GREEN}✓ 部署完成${NC}"
echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}  部署成功!${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo "后续步骤:"
echo "  1. SSH 到设备: ssh $TARGET"
echo "  2. 进入目录: cd $REMOTE_PATH"
echo "  3. 编辑配置: \$EDITOR .env"
echo "  4. 重启服务: pkill -f 'dsh --profile' && source .env.sh && dsh --profile dsh-edge-agent &"
echo ""
echo "验证服务:"
echo "  ssh $TARGET 'curl http://127.0.0.1:21017/v1/health'"
echo ""

# 清理本地打包文件
rm -f "$PACKAGE_NAME"
