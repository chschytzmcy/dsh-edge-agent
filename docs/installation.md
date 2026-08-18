# 安装指南

## 📋 系统要求

| 组件 | 最低版本 | 推荐版本 |
|---|---|---|
| Node.js | ^22.19 或 >=24 | >=22.20 |
| pnpm | ^10 或 ^11 | ^11.7.0 |
| 操作系统 | Linux / macOS / Windows | Linux |
| 架构 | x64 / arm64 | arm64 (for TEE) |

## 🔧 前置依赖

### 1. 安装官方 DSH CLI

```sh
npm install -g @deepseek-ai/dsh
```

验证：

```sh
dsh --version
```

### 2. 安装 pnpm

```sh
npm install -g pnpm
# 或
corepack enable pnpm
```

验证：

```sh
pnpm --version
```

### 3. （可选）安装 TEE 开发环境

如果需要在真实 TEE 上运行（推荐生产环境）：

- **ARM TrustZone**：需要在支持 TrustZone 的设备上编译 OP-TEE
- **RISC-V Keystone**：需要 RISC-V 工具链
- **Intel SGX**：需要 Intel SGX SDK

脚手架阶段可使用 `simulated` 后端，无需真实 TEE。

## 📦 安装 dsh-edge-agent

### 方式一：从 npm 全局安装（推荐用户）

```sh
npm install -g @deepseek-harness-edge-agent/dsh-edge-agent
dsh plugin --profile dsh-edge-agent add @deepseek-harness-edge-agent/dsh-edge-agent
dsh-edge-agent
```

### 方式二：从源码构建（推荐开发者）

```sh
# 克隆仓库
git clone https://github.com/chschytzmcy/dsh-edge-agent.git
cd dsh-edge-agent

# 安装依赖
pnpm install

# 编译
pnpm run compile

# 引导 profile（首次运行）
./install.sh

# 启动
dsh-edge-agent
```

### 方式三：Windows

```cmd
:: 在 PowerShell 或 cmd 中
dsh plugin --profile dsh-edge-agent add @deepseek-harness-edge-agent/dsh-edge-agent

:: 启动（仓库根目录的 .cmd shim 处理 --resume 兼容）
dsh-edge-agent.cmd
```

## 🚀 首次启动

首次运行会执行以下步骤：

1. **检测 dsh CLI**：确认 `@deepseek-ai/dsh` 已安装
2. **创建 profile**：在 `$DSH_HOME/profiles/dsh-edge-agent/` 创建独立 profile
3. **安装依赖**：通过 pnpm 安装所有 DSH 依赖
4. **应用 patch**：根据 `cordis.patch.yml` 注入 dsh-edge-agent 插件
5. **创建存储目录**：默认 `~/.dsh-edge-agent/`
6. **加载默认策略**：`~/.dsh-edge-agent/policy.json`

完成上述步骤后，agent loop 启动，等待用户输入。

## 🔍 验证安装

```sh
# 检查 profile 是否就绪
ls $DSH_HOME/profiles/dsh-edge-agent/

# 检查插件是否挂载
dsh --profile dsh-edge-agent --dump-config | grep -E "dsh-edge-agent|tcm|ohttp"

# 运行冒烟测试
cd dsh-edge-agent
pnpm run smoke
```

## 🐛 故障排查

### "未检测到 dsh CLI"

```sh
npm install -g @deepseek-ai/dsh
hash -r   # 刷新 shell 缓存
```

### "未检测到 pnpm"

```sh
npm install -g pnpm
# 或
corepack enable pnpm
```

### "profile runs v0.0.X but launcher is v0.1.0"

profile 比启动器旧，可能导致启动崩溃。对齐：

```sh
dsh plugin --profile dsh-edge-agent add @deepseek-harness-edge-agent/dsh-edge-agent@latest
```

### "adapter boundary violated"

源码中 `src/dsh-adapter/` 之外有 `@deepseek-ai/*` 的导入。修复方法：

1. 将 import 移到 `src/dsh-adapter/` 内
2. 或通过 `src/dsh-adapter/types.ts` 重新导出

### "upstream contract violated"

DSH 依赖版本与 `UPSTREAM_VALIDATED_VERSION`（`0.1.0-rc.6`）不匹配。修复方法：

```sh
pnpm install
# 或
pnpm update @deepseek-ai/dsh-agent @deepseek-ai/dsh-llm ...
```

## 🗑️ 卸载

```sh
# 移除 profile
dsh plugin --profile dsh-edge-agent remove @deepseek-harness-edge-agent/dsh-edge-agent

# 移除存储（注意：这会删除所有会话和加密数据！）
rm -rf ~/.dsh-edge-agent/

# 移除全局包（如适用）
npm uninstall -g @deepseek-harness-edge-agent/dsh-edge-agent
```

## 🔗 下一步

- [配置参考](configuration.md)
- [架构设计](architecture.md)
- [插件开发](plugin-development.md)