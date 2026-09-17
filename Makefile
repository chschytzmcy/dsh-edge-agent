# dsh-edge-agent Makefile
# 构建、打包、部署工具链

# 配置
# §7.55 (2026-09-15): tarball 命名带 semver 版本号 (vX.Y.Z)，
# 触发 release pipeline 时与 git tag 一致；本地构建 fallback HEAD。
VERSION  := $(shell node -p "require('./package.json').version" 2>/dev/null || echo "0.0.0-dev")
PACKAGE_NAME := dsh-edge-agent-v$(VERSION).tar.gz
SHA_NAME    := $(PACKAGE_NAME).sha256
PACKAGE_DIR := .deploy
INSTALL_DIR := /opt/dsh-edge-agent

# 颜色输出
BLUE := \033[0;34m
GREEN := \033[0;32m
YELLOW := \033[1;33m
NC := \033[0m

.PHONY: help build test verify e2e-coverage e2e-tui package install clean

# 默认目标
help:
	@echo "$(BLUE)dsh-edge-agent 构建与部署$(NC)"
	@echo ""
	@echo "用法:"
	@echo "  $(GREEN)make build$(NC)         - 构建 TypeScript 代码"
	@echo "  $(GREEN)make test$(NC)          - 运行单元测试"
	@echo "  $(GREEN)make verify$(NC)        - 运行构建验证"
	@echo "  $(GREEN)make e2e-coverage$(NC)  - ops log 21 节点覆盖回归（3 重点用例）"
	@echo "  $(GREEN)make e2e-tui$(NC)       - 生产 dsh-tui 实机 E2E（tmux+HTTP 双通道，逐用例日志分析）"
	@echo "  $(GREEN)make package$(NC)       - 打包部署文件"
	@echo "  $(GREEN)make install$(NC)       - 安装到本地系统"
	@echo "  $(GREEN)make clean$(NC)         - 清理构建产物"
	@echo ""
	@echo "本地部署到 DSH profile:"
	@echo "  $(GREEN)./install.sh$(NC)                # 默认部署 + 重启 dsh-tui + web + dsh-edge（§7.66/§7.67）"
	@echo "  $(GREEN)./install.sh --profiles=dsh-tui$(NC)   # 只部署 + 重启 dsh-tui"
	@echo "  $(GREEN)./install.sh --profiles=web$(NC)       # 只部署 + 重启 web"
	@echo "  $(GREEN)./install.sh --profiles=dsh-edge$(NC)  # §7.61 headless（HTTP :21019，无 UI）"

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

# §7.60 生产 dsh-tui 实机 E2E（X0 + H1-H5 + K1-K2，双通道，逐用例日志分析）
# 前置：production dsh-tui 在跑（tmux 会话 dsh-tui + :21018）；只 attach 不拉起。
# 预期 ~4-6 分钟；期间勿手动 attach 抢输入焦点。
e2e-tui:
	@echo "$(BLUE)==> 生产 dsh-tui 实机 E2E（8 用例双通道）$(NC)"
	@bash scripts/e2e-tui-live.sh all
	@echo "$(GREEN)✓ dsh-tui 实机 E2E 通过$(NC)"

# 打包部署文件
# §7.55 (2026-09-15): 收紧打包内容
#   - 不打 .env（避免 DEEPSEEK_API_KEY 泄漏）
#   - 不打 profiles/node_modules/（252 symlink 指向开发机 /home/etsme/.npm-global）
#   - 不打 profiles/dsh-edge-agent/node_modules/（开发机 runtime，~30M）
#   - 不打 profiles/（.npmignore 整目录排除；§7.61 后仅剩 dsh-edge 部署骨架+皮肤，
#     是 install.sh 的输入而非产物，release 包内自带 install.sh 即可用）
#   - 不打 cordis.yml（legacy --config 模式入口，install.sh 不读）
#   - 打 install.sh + README.md + LICENSE（用户文档）
#   - 加 SHA256SUMS
# 预期 tarball 大小：~2MB（vs 之前 75MB，37× 缩减）
package: build
	@echo "$(BLUE)==> 打包部署文件 v$(VERSION)$(NC)"
	@rm -rf $(PACKAGE_DIR)
	@mkdir -p $(PACKAGE_DIR)/dsh-edge-agent-v$(VERSION)

	@# 编译产物 + 配置
	@cp -r lib $(PACKAGE_DIR)/dsh-edge-agent-v$(VERSION)/
	@cp -r scripts $(PACKAGE_DIR)/dsh-edge-agent-v$(VERSION)/
	@cp -r presets $(PACKAGE_DIR)/dsh-edge-agent-v$(VERSION)/
	@cp package.json $(PACKAGE_DIR)/dsh-edge-agent-v$(VERSION)/
	@cp pnpm-lock.yaml $(PACKAGE_DIR)/dsh-edge-agent-v$(VERSION)/
	@cp cordis.patch.yml $(PACKAGE_DIR)/dsh-edge-agent-v$(VERSION)/
	@cp .env.sh $(PACKAGE_DIR)/dsh-edge-agent-v$(VERSION)/
	@cp .env.example $(PACKAGE_DIR)/dsh-edge-agent-v$(VERSION)/

	@# 用户文档 + 入口
	@cp install.sh $(PACKAGE_DIR)/dsh-edge-agent-v$(VERSION)/
	@cp README.md $(PACKAGE_DIR)/dsh-edge-agent-v$(VERSION)/
	@cp LICENSE $(PACKAGE_DIR)/dsh-edge-agent-v$(VERSION)/

	@# 打包 + SHA256
	@cd $(PACKAGE_DIR) && tar -czf ../$(PACKAGE_NAME) dsh-edge-agent-v$(VERSION)
	@sha256sum $(PACKAGE_NAME) | tee $(SHA_NAME)
	@rm -rf $(PACKAGE_DIR)

	@echo ""
	@SIZE=$$(du -h $(PACKAGE_NAME) | cut -f1); \
	 echo "$(GREEN)✓ $(PACKAGE_NAME)$(NC) ($$SIZE)"
	@echo "$(GREEN)✓ $(SHA_NAME)$(NC)"

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
	@rm -f $(PACKAGE_NAME) $(SHA_NAME)
	@echo "$(GREEN)✓ 清理完成$(NC)"

# 完整流程：构建 + 测试 + 验证 + 打包
release: test verify package
	@echo "$(GREEN)✓ Release 包准备完成: $(PACKAGE_NAME)$(NC)"