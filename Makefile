# dsh-edge-agent Makefile
# 构建、打包工具链(本地部署归 install.sh,不在 Makefile 范围)

# 配置
# §7.55 (2026-09-15): tarball 命名带 semver 版本号 (vX.Y.Z)，
# 触发 release pipeline 时与 git tag 一致；本地构建 fallback HEAD。
VERSION  := $(shell node -p "require('./package.json').version" 2>/dev/null || echo "0.0.0-dev")
PACKAGE_NAME := dsh-edge-agent-v$(VERSION).tar.gz
SHA_NAME    := $(PACKAGE_NAME).sha256
PACKAGE_DIR := .deploy
# §7.77 (2026-09-18): 产物目录化 —— tarball + sha256 落 dist/ 而非 REPO_ROOT
# 顶层,不污染源码根,跟 `git status` 自然分开。
DIST_DIR    := dist
# §7.71 (2026-09-17): 删 `make install` —— 单一部署入口归 install.sh,
# Makefile 只负责 build + package(tarball 仅作 release 分发,本地部署走
# install.sh 直 rsync REPO_ROOT/lib/ 到 profile)。runtime channel
# (~/.dsh-edge-agent/{audit,log,sessions,storage,...}) 不归 make 管。

# 颜色输出
BLUE := \033[0;34m
GREEN := \033[0;32m
YELLOW := \033[1;33m
NC := \033[0m

.PHONY: help build test verify e2e-coverage e2e-tui e2e-benchmark package clean

# 默认目标
help:
	@echo "$(BLUE)dsh-edge-agent 构建与部署$(NC)"
	@echo ""
	@echo "用法:"
	@echo "  $(GREEN)make build$(NC)         - 构建 TypeScript 代码(只编译,不出 tarball)"
	@echo "  $(GREEN)make test$(NC)          - 运行单元测试"
	@echo "  $(GREEN)make verify$(NC)        - 运行构建验证"
	@echo "  $(GREEN)make e2e-coverage$(NC)  - ops log 21 节点覆盖回归（3 重点用例）"
	@echo "  $(GREEN)make e2e-benchmark$(NC) - local LLM 模型质量评分（10 category，145 fixtures×3 iter）"
	@echo "  $(GREEN)make e2e-tui$(NC)       - 生产 dsh-tui 实机 E2E（tmux+HTTP 双通道，逐用例日志分析）"
	@echo "  $(GREEN)make package$(NC)       - 构建 + 打 tarball → dist/(§7.77;install.sh 不读)"
	@echo "  $(GREEN)make clean$(NC)         - 清理构建产物 + tarball"
	@echo ""
	@echo "本地部署(§7.71:单一入口归 install.sh,内部 'make package' + 直 rsync):"
	@echo "  $(GREEN)./install.sh$(NC)                # 默认：make package + 部署 + 启 dsh-edge(:21017,§7.69)"
	@echo "  $(GREEN)./install.sh --profile=web$(NC)       # 切 web:杀 dsh-tui + dsh-edge,部署 + 启 web"
	@echo "  $(GREEN)./install.sh --profile=tui$(NC)       # 切 dsh-tui:杀 web + dsh-edge,部署 + 启 dsh-tui"
	@echo "  $(GREEN)./install.sh --profile=dsh-edge$(NC)  # 显式 dsh-edge(§7.61 headless,HTTP :21017 无 UI)"
	@echo "  $(GREEN)./install.sh --no-restart$(NC)        # 只编译 + 同步,不重启(改代码反复迭代用)"
	@echo ""
	@echo "Release 分发:"
	@echo "  $(GREEN)make release$(NC)      - test + verify + package(给 CI / 外部用户下载用)"

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

# §7.86(2026-09-18) 历史标记:e2e-tui-live.sh 已删除 —— dsh-tui 生产 rig
# 在 §7.69 单 profile 架构后不再独立部署,所有 e2e 入口统一走 dsh-edge。
# 保留 target 入口为兼容性(打印弃用说明 + 退出 0),不实际跑脚本。
e2e-tui:
	@echo "$(YELLOW)==> 弃用(§7.86):e2e-tui-live.sh 已删除 —— 单 profile 架构后 dsh-tui 不再独立部署。HTTP e2e 由 e2e-ops-log-coverage.sh 覆盖(对应原 H 臂)。$(NC)"

# §7.87(2026-09-18) Model Quality Bench — 评估 local LLM 跟本项目的适配度
# 145 fixtures × 3 iter = 435 次 LLM 调用,单跑 ~8-12 分钟(LAN 依赖)
# 不进 CI(LAN + 太慢);手动跑或 release 前跑。
# 用法:make e2e-benchmark LABEL=qwen3.5-9b-lan
# 报告落点:dist/bench-${LABEL}-*/(report.md + scores.json + traces/*)
# §7.87.8(2026-09-20)默认 NO_THINKING=1:mlx 服务器(qwen3.5-9b/minicpm5-2b)thinking 模式
# 会把 max_tokens 全烧在 reasoning content,bench 永远 0 分;rknn(qwen3-4b)chat_template_kwargs
# 被 server no-op 忽略,设了也无害。
e2e-benchmark:
	@echo "$(BLUE)==> 跑 Model Quality Bench (label=${LABEL:-bench}, no-thinking=$${NO_THINKING:-1})$(NC)"
	@export NO_THINKING=$${NO_THINKING:-1}; export LABEL=$${LABEL:-bench}; bash scripts/e2e-model-quality-bench.sh --label "$$LABEL"
	@echo "$(GREEN)✓ Model Quality Bench 完成(报告在 dist/bench-$${LABEL}-*/)$(NC)"

# 打包部署文件
# §7.55 (2026-09-15): 收紧打包内容
#   - 不打 .env（避免 DEEPSEEK_API_KEY 泄漏）
#   - 不打 profiles/node_modules/（252 symlink 指向开发机 /home/<user>/.npm-global）
#   - 不打 profiles/dsh-edge-agent/node_modules/（开发机 runtime，~30M）
#   - §7.73 (2026-09-17): 打 profiles/dsh-edge/ —— tarball 模式 install.sh §2.5
#     (cordis.patch.yml overlay) + §2.7 (skeleton bootstrap) 依赖 $REPO_ROOT/
#     profiles/$PROFILE/,只打 dsh-edge/(项目自有 profile 骨架 + skin);
#     legacy profiles/dsh-edge-agent/ + 顶层 profiles/node_modules/ 仍不打
#   - 不打 cordis.yml（legacy --config 模式入口，install.sh 不读）
#   - 打 install.sh + README.md + LICENSE（用户文档）
#   - 加 SHA256SUMS
# 预期 tarball 大小：~2MB（vs 之前 75MB，37× 缩减）
# §7.71 (2026-09-17): install.sh 内部调用此 target —— `make package` 是 install.sh
# 的 Phase 1,但 install.sh 自身不读 tarball(只读 tarball 准备好的 REPO_ROOT/lib/
# 镜像)。tarball 仅供 release 分发 / 外部用户下载。
# SKIP_BUILD=1:跳过 package 前置的 `build` 目标(编译)——调用方已经编好
# lib/ + 客户端 bundle 时用它,避免同一轮构建跑两次 tsc。
package: $(if $(SKIP_BUILD),,build)
	@echo "$(BLUE)==> 打包部署文件 v$(VERSION)$(NC)"
	# §7.87.8 (2026-09-20): 只清 PACKAGE_DIR,不清 DIST_DIR —— 保留 dist/bench-*
	# (历史 bench 报告落点,git-ignored 但 user 本地需要留存对比)。
	# tarball / sha 在 line 139-140 写入会覆盖旧的,无需预清。
	@rm -rf $(PACKAGE_DIR)
	@mkdir -p $(PACKAGE_DIR)/dsh-edge-agent-v$(VERSION)
	@mkdir -p $(DIST_DIR)

	@# 编译产物 + 配置
	@cp -r lib $(PACKAGE_DIR)/dsh-edge-agent-v$(VERSION)/
	@cp -r scripts $(PACKAGE_DIR)/dsh-edge-agent-v$(VERSION)/
	@cp -r presets $(PACKAGE_DIR)/dsh-edge-agent-v$(VERSION)/
	@cp package.json $(PACKAGE_DIR)/dsh-edge-agent-v$(VERSION)/
	@cp pnpm-lock.yaml $(PACKAGE_DIR)/dsh-edge-agent-v$(VERSION)/
	@cp cordis.patch.yml $(PACKAGE_DIR)/dsh-edge-agent-v$(VERSION)/
	@# §7.102 (2026-10-21): .env.sh / .env.example 已退役(配置统一到
	@# config/edge.json)。tarball 带 config/ —— 但**只带模板**:
	@# config/edge.json 是真配置(明文密钥),绝不能进分发包。整目录 cp
	@# 之后再删真配置,避免"以后新增文件"时被漏掉。
	@cp -r config $(PACKAGE_DIR)/dsh-edge-agent-v$(VERSION)/
	@rm -f $(PACKAGE_DIR)/dsh-edge-agent-v$(VERSION)/config/edge.json

	@# §7.73 (2026-09-17): profile 骨架 —— tarball 模式 install.sh §2.5 /
	@# §2.7 读 $REPO_ROOT/profiles/$PROFILE/。只打 dsh-edge/(项目自有 profile
	@# 的骨架 package.json + skin cordis.patch.yml),不打 profiles/node_modules/
	@# (252 symlink 指向开发机)也不打 profiles/dsh-edge-agent/(§7.61 退役
	@# 的 legacy profile + 自带 node_modules)。
	@# §7.107 (2026-10-24): dsh-edge-agent/ 是新的 HTTP profile 骨架
	@# (桌面那套 edge 逻辑 + 一层 http-api overlay),也一起打。
	@mkdir -p $(PACKAGE_DIR)/dsh-edge-agent-v$(VERSION)/profiles
	@cp -r profiles/dsh-edge $(PACKAGE_DIR)/dsh-edge-agent-v$(VERSION)/profiles/
	@cp -r profiles/dsh-edge-agent $(PACKAGE_DIR)/dsh-edge-agent-v$(VERSION)/profiles/
	@# profile 骨架只要 package.json(+ skin cordis.patch.yml)。骨架目录里如果
	@# 带着开发机 runtime(node_modules/,218M real files + 相对 symlink),
	@# 会被整棵打进 tarball —— 换机即失效,且把 tarball 从 ~2MB 撑到 75MB。
	@# 装的时候由 install.sh / dsh plugin 各自装依赖,不依赖这份拷贝。
	@rm -rf $(PACKAGE_DIR)/dsh-edge-agent-v$(VERSION)/profiles/*/node_modules
	@# 同理:python 字节码缓存不是发布产物。
	@rm -rf $(PACKAGE_DIR)/dsh-edge-agent-v$(VERSION)/scripts/__pycache__

	@# 用户文档 + 入口
	@cp install.sh $(PACKAGE_DIR)/dsh-edge-agent-v$(VERSION)/
	@cp uninstall.sh $(PACKAGE_DIR)/dsh-edge-agent-v$(VERSION)/
	@cp README.md $(PACKAGE_DIR)/dsh-edge-agent-v$(VERSION)/
	@cp LICENSE $(PACKAGE_DIR)/dsh-edge-agent-v$(VERSION)/

	@# 打包 + SHA256 → $(DIST_DIR)/(§7.77)
	@cd $(PACKAGE_DIR) && tar -czf ../$(DIST_DIR)/$(PACKAGE_NAME) dsh-edge-agent-v$(VERSION)
	@cd $(DIST_DIR) && sha256sum $(PACKAGE_NAME) | tee $(SHA_NAME)
	@rm -rf $(PACKAGE_DIR)

	@echo ""
	@SIZE=$$(du -h $(DIST_DIR)/$(PACKAGE_NAME) | cut -f1); \
	 echo "$(GREEN)✓ $(DIST_DIR)/$(PACKAGE_NAME)$(NC) ($$SIZE)"
	@echo "$(GREEN)✓ $(DIST_DIR)/$(SHA_NAME)$(NC)"

# 清理
clean:
	@echo "$(BLUE)==> 清理构建产物$(NC)"
	@rm -rf lib/
	@rm -rf $(PACKAGE_DIR)
	@rm -rf $(DIST_DIR)
	@echo "$(GREEN)✓ 清理完成$(NC)"

# 完整流程：构建 + 测试 + 验证 + 打包
release: test verify package
	@echo "$(GREEN)✓ Release 包准备完成: $(PACKAGE_NAME)$(NC)"