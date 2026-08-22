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
#   6. 配置环境并启动服务

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
echo -e "${BLUE}[1/6] 测试 SSH 连接...${NC}"
if ! ssh $SSH_OPTS "$TARGET" "echo 'SSH 连接成功'" 2>/dev/null; then
    echo -e "${RED}错误: 无法连接到 $TARGET${NC}"
    exit 1
fi
echo -e "${GREEN}✓ SSH 连接正常${NC}"
echo ""

# Step 2: 在目标设备上安装系统依赖
echo -e "${BLUE}[2/6] 在目标设备上安装系统依赖...${NC}"
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
echo -e "${BLUE}[3/6] 本地构建和打包...${NC}"
make package
echo -e "${GREEN}✓ 打包完成${NC}"
echo ""

# Step 4: 传输到目标设备
echo -e "${BLUE}[4/6] 传输部署包到目标设备...${NC}"
scp -P $SSH_PORT -o StrictHostKeyChecking=no "$PACKAGE_NAME" "$TARGET:/tmp/"
echo -e "${GREEN}✓ 传输完成${NC}"
echo ""

# Step 5: 解压并安装项目依赖
echo -e "${BLUE}[5/6] 解压并安装项目依赖...${NC}"
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

# Step 6: 配置环境并启动
echo -e "${BLUE}[6/6] 配置环境并启动服务...${NC}"
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
