---
name: deploy-dsh-edge-agent
version: 0.2.0
description: "dsh-edge-agent 部署 / 同步 / 重启 / 状态查询。触发关键词：deploy、部署、同步、sync、install、重启、restart、status、跟日志、查状态、更新代码"
metadata:
  requires:
    bins: ["bash", "ssh", "curl", "ps", "tar", "rsync"]
  cliHelp: "./install.sh --help  &&  ./deploy.sh && bash scripts/sync-bundle.sh --help"
---

# deploy-dsh-edge-agent

把本地 `src/`、`agent-presets/`、`cordis.patch.yml` 的改动同步到
**DSH 真正加载的位置**（`~/.dsh/profiles/<name>/node_modules/@deepseek-harness-edge-agent/dsh-edge-agent/`），
再重启对应的 `dsh` 进程。本 skill 覆盖本地同步、多 profile 同步、远端部署。

## 工作流索引

| 场景 | 命令 | 耗时 | 备注 |
|------|------|------|------|
| **改完代码同步到所有 profile** | `bash scripts/sync-bundle.sh` | ~2s | ⭐ **推荐，90% 场景用这个** |
| 同步 + 重启运行中 profile | `bash scripts/sync-bundle.sh --restart` | ~5s | 改完立即生效 |
| 只同步指定 profile | `bash scripts/sync-bundle.sh --profile=web` | ~2s | 单 profile 调试 |
| 本地首次 / 加新依赖 | `./install.sh` | 30-60s | 首次或改了 package.json |
| 装到指定 profile | `./install.sh --to-profile <name>` | 30-60s | 装到 web / tui / 自定义 |
| 强制重装本包 | `./install.sh --force-install` | 30-60s | 嵌套包坏了 |
| 仅编译 + 重启 | `bash scripts/dev-restart.sh` | 5-10s | 等价于 `--skip-pnpm` |
| 远端部署 | `./deploy.sh <user@host> [port]` | 1-3 min | 7 步流水线 |
| 查状态 | `ps` + `curl :3080/` | <1s | webui + http-api |
| 跟日志 | `tail -f ~/.dsh-edge-agent/log/...` | 长跑 | ops log + audit log 分开 |
| 健康检查 | `bash scripts/dsh-systemic-health.sh --all` | <1s | 跨 profile 系统性校验 |

## 多 Profile 同步（⭐ 核心工作流）

dsh-edge-agent bundle 同时装在 **web** 和 **tui** 两个 profile 里：

```
~/.dsh/profiles/
├── web/              bundles: [dsh-base, dsh-web-app, dsh-edge-agent]
│   └── node_modules/@deepseek-harness-edge-agent/dsh-edge-agent/
└── dsh-tui/          bundles: [dsh-base, dsh-tui, dsh-edge-agent]
    └── node_modules/@deepseek-harness-edge-agent/dsh-edge-agent/
```

### 改了 src/ 后同步到两个 profile

```bash
cd /home/etsme/cy/agent/dsh-edge-agent

# 1. 一键同步到所有已装 bundle 的 profile（自动发现 web + dsh-tui）
bash scripts/sync-bundle.sh

# 2. 同步 + 自动重启运行中的 profile
bash scripts/sync-bundle.sh --restart

# 3. 验证健康状态
bash scripts/dsh-systemic-health.sh --all
```

### sync-bundle.sh vs install.sh

| 维度 | sync-bundle.sh | install.sh |
|---|---|---|
| 用途 | 纯代码同步（已装 bundle 的 profile）| 首次安装 / 加依赖 |
| 速度 | ~2s（所有 profile）| ~5s（单 profile）|
| 编译 | ✓（每次都跑）| ✓ |
| pnpm install | ✗（跳过）| ✓ |
| 多 profile | ✓（自动发现）| ✗（单 profile）|
| 改 package.json | ✗（不处理）| ✓ |

**决策树**：
- 只改 `src/` / `cordis.patch.yml` / `agent-presets/` → **sync-bundle.sh**
- 改 `package.json`（加依赖）→ **install.sh --to-profile=<name>**
- 新 profile 首次部署 → **install.sh --to-profile=<name>**

## 当前部署状态（2026-09-04）

```
web profile:
  :3080  dsh-web-app webui
  :21017 http-api（2026-09-04 重新使能）

tui profile:
  :21017 http-api（TTY 启动时）
  TUI 界面（需要 TTY）
```

## 典型工作流

### 开发迭代
```bash
# 1. 改代码
vim src/dsh-adapter/xxx.ts

# 2. 同步到所有 profile + 重启
bash scripts/sync-bundle.sh --restart

# 3. 测试
curl http://127.0.0.1:21017/v1/health   # http-api
curl http://127.0.0.1:3080/              # webui

# 4. 健康检查
bash scripts/dsh-systemic-health.sh --all
```

### 升级 dsh 后
```bash
# 1. 升级
npm install -g @deepseek-ai/dsh@latest

# 2. 系统校验
bash scripts/dsh-systemic-health.sh --scenario=dsh-system

# 3. 重新部署每个 profile
./install.sh --to-profile=web
./install.sh --to-profile=dsh-tui

# 4. TUI 需要 trim @deepseek-ai/* 重复包（Symbol 双实例问题）
bash scripts/fix-profile-duplicates.sh --profile=dsh-tui

# 5. 健康校验
bash scripts/dsh-systemic-health.sh --all
```

### 远端部署
```bash
./deploy.sh user@host 22
# 7 步流水线：compile → pack → scp → untar → install → restart → verify
```

## 相关脚本

| 脚本 | 用途 |
|---|---|
| `scripts/sync-bundle.sh` | ⭐ 多 profile 同步（推荐）|
| `install.sh` | 单 profile 完整安装 |
| `deploy.sh` | 远端部署 |
| `scripts/dev-restart.sh` | 编译 + 重启（单 profile）|
| `scripts/fix-profile-duplicates.sh` | 修 TUI Symbol 双实例 |
| `scripts/dsh-systemic-health.sh` | 系统性健康检查 |
