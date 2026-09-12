# dsh-edge-agent Makefile
# 构建、打包、部署工具链

# 配置
PACKAGE_NAME := dsh-edge-agent-deploy.tar.gz
PACKAGE_DIR := .deploy
INSTALL_DIR := /opt/dsh-edge-agent

# 颜色输出
BLUE := \033[0;34m
GREEN := \033[0;32m
YELLOW := \033[1;33m
NC := \033[0m

.PHONY: help build test verify e2e-coverage package install clean

# 默认目标
help:
	@echo "$(BLUE)dsh-edge-agent 构建与部署$(NC)"
	@echo ""
	@echo "用法:"
	@echo "  $(GREEN)make build$(NC)         - 构建 TypeScript 代码"
	@echo "  $(GREEN)make test$(NC)          - 运行单元测试"
	@echo "  $(GREEN)make verify$(NC)        - 运行构建验证"
	@echo "  $(GREEN)make e2e-coverage$(NC)  - ops log 21 节点覆盖回归（3 重点用例）"
	@echo "  $(GREEN)make package$(NC)       - 打包部署文件"
	@echo "  $(GREEN)make install$(NC)       - 安装到本地系统"
	@echo "  $(GREEN)make clean$(NC)         - 清理构建产物"
	@echo ""
	@echo "本地部署到 DSH profile:"
	@echo "  $(GREEN)./install.sh$(NC)                # 默认并存部署 dsh-tui + web"
	@echo "  $(GREEN)./install.sh --profiles=dsh-tui$(NC)   # 只部署 dsh-tui"
	@echo "  $(GREEN)./install.sh --profiles=web$(NC)       # 只部署 web"

# 构建
build:
	@echo "$(BLUE)==> 构建 TypeScript 代码$(NC)"
	@pnpm run compile
	@echo "$(GREEN)✓ 构建完成$(NC)"

# 测试
test:
	@echo "$(BLUE)==> 运行单元测试$(NC)"
	@pnpm test
	@echo "$(GREEN)✓ 测试完成$(NC)"

# 验证
verify:
	@echo "$(BLUE)==> 运行构建验证$(NC)"
	@pnpm run verify:build
	@echo "$(GREEN)✓ 验证完成$(NC)"

# E2E ops log 覆盖回归（21 节点 + 3 重点用例断言）
# 前置：dsh-edge-agent HTTP API 已起（web profile :21017 或 TUI :21018）
e2e-coverage:
	@echo "$(BLUE)==> 运行 ops log 覆盖回归（3 重点用例）$(NC)"
	@bash scripts/e2e-ops-log-coverage.sh
	@echo "$(GREEN)✓ ops log 覆盖回归通过$(NC)"

# 打包部署文件
package: build
	@echo "$(BLUE)==> 打包部署文件$(NC)"
	@rm -rf $(PACKAGE_DIR)
	@mkdir -p $(PACKAGE_DIR)/dsh-edge-agent

	@# 复制必要文件
	@cp -r lib $(PACKAGE_DIR)/dsh-edge-agent/
	@cp -r profiles $(PACKAGE_DIR)/dsh-edge-agent/
	@cp -r presets $(PACKAGE_DIR)/dsh-edge-agent/
	@cp -r scripts $(PACKAGE_DIR)/dsh-edge-agent/
	@cp package.json $(PACKAGE_DIR)/dsh-edge-agent/
	@cp pnpm-lock.yaml $(PACKAGE_DIR)/dsh-edge-agent/
	@cp cordis.patch.yml $(PACKAGE_DIR)/dsh-edge-agent/
	@cp cordis.yml $(PACKAGE_DIR)/dsh-edge-agent/
	@cp .env.sh $(PACKAGE_DIR)/dsh-edge-agent/
	@cp .env.example $(PACKAGE_DIR)/dsh-edge-agent/
	@# 复制 .env（如果存在）
	@test -f .env && cp .env $(PACKAGE_DIR)/dsh-edge-agent/ || echo "  .env 不存在，跳过"

	@# 打包
	@cd $(PACKAGE_DIR) && tar -czf ../$(PACKAGE_NAME) dsh-edge-agent
	@rm -rf $(PACKAGE_DIR)

	@echo "$(GREEN)✓ 打包完成: $(PACKAGE_NAME)$(NC)"
	@ls -lh $(PACKAGE_NAME)

# 安装到本地
install: package
	@echo "$(BLUE)==> 安装到本地系统 $(INSTALL_DIR)$(NC)"
	@sudo mkdir -p $(INSTALL_DIR)
	@sudo tar -xzf $(PACKAGE_NAME) -C /opt/
	@sudo rm -f $(INSTALL_DIR)/latest && sudo ln -s $(INSTALL_DIR) $(INSTALL_DIR)/latest
	@cd $(INSTALL_DIR) && sudo pnpm install --ignore-scripts
	@echo "$(GREEN)✓ 安装完成$(NC)"
	@echo ""
	@echo "下一步:"
	@echo "  1. 进入目录: cd $(INSTALL_DIR)"
	@echo "  2. 配置环境: cp .env.example .env && \$$EDITOR .env"
	@echo "  3. 启动服务: ./install.sh    # 默认并存启动 dsh-tui + web"

# 清理
clean:
	@echo "$(BLUE)==> 清理构建产物$(NC)"
	@rm -rf lib/
	@rm -rf $(PACKAGE_DIR)
	@rm -f $(PACKAGE_NAME)
	@echo "$(GREEN)✓ 清理完成$(NC)"

# 完整流程：构建 + 测试 + 验证 + 打包
release: test verify package
	@echo "$(GREEN)✓ Release 包准备完成: $(PACKAGE_NAME)$(NC)"