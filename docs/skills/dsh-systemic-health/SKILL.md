---
name: dsh-systemic-health
version: 0.1.0
description: "dsh 系统性健康检查。触发关键词：health、检查、诊断、兼容性、symbol 重复、unscoped、版本 skew、audit-log、bundle 状态"
metadata:
  requires:
    bins: ["bash", "dsh", "pnpm", "python3"]
  cliHelp: "bash scripts/dsh-systemic-health.sh --help"
---

# dsh-systemic-health

诊断 dsh 跨 profile 的系统性兼容问题。覆盖已知陷阱：

| 检查项 | 类别 | 触发症状 |
|---|---|---|
| **[A] @deepseek-ai/* 重复包** | 严重 | `agent-presets: refusing to compose an unscoped context` |
| **[A.2] Symbol 实例数** | 严重 | 同上（[A] 的物理证据）|
| **[B] 包版本 skew** | 警告 | profile 里 `@deepseek-ai/*` 与 dsh 全局版本不一致 |
| **[C] Session API 迁移** | 警告 | 源码里还有 `session.events`（应为 `snapshotEvents()`）|
| **[D] Bundle 完整性** | 严重 | dsh-edge-agent 插件不加载、21017 不 listen |
| **[E] audit-log minLevel** | 警告 | audit 0 事件（debug level 被静默 drop）|
| **[F] cordis.patch.yml 同步** | 警告 | bundle 改了 patch 但没 rsync 到 bundle 内 |
| **[G] Upstream 版本一致性** | 严重 | contract.ts vs dsh --version 不符 |

## 用法

```bash
# 默认检查 dsh-tui profile
bash scripts/dsh-systemic-health.sh

# 检查 web profile
bash scripts/dsh-systemic-health.sh --profile=web

# 扫描所有 profile
bash scripts/dsh-systemic-health.sh --all

# 自动修可修项（strip @deepseek-ai/*）
bash scripts/dsh-systemic-health.sh --all --fix
```

## 典型工作流

### 升级 dsh 后
```bash
# 1. 升级
npm install -g @deepseek-ai/dsh@latest

# 2. 重跑 install.sh（会重新引入重复包）
./install.sh --to-profile=dsh-tui

# 3. 健康检查
bash scripts/dsh-systemic-health.sh --all

# 4. 自动修
bash scripts/dsh-systemic-health.sh --all --fix

# 5. 重启
bash scripts/dev-restart.sh
```

### TUI 启动崩溃 `unscoped context`
```bash
# 一键诊断 + 修
bash scripts/fix-profile-duplicates.sh --profile=dsh-tui
# 或更全面的检查
bash scripts/dsh-systemic-health.sh --profile=dsh-tui
```

### Audit 0 事件
```bash
bash scripts/dsh-systemic-health.sh --profile=web
# 看 [E] 段的 minLevel 警告
```

## 输出示例

```
╔════════════════════════════════════════════════════════════╗
║          DSH 系统性健康检查 · 2026-09-04 11:30:00          ║
╚════════════════════════════════════════════════════════════╝

dsh 全局版本:     0.1.2-rc.1
项目验证版本:     0.1.2-rc.1
扫描 profiles:    dsh-tui

═══ [G] Upstream 版本一致性 ═══
  ✓ 项目 contract.ts (0.1.2-rc.1) = dsh 全局 (0.1.2-rc.1)

═══════════════════════════════════════════════════════════
  Profile: dsh-tui
═══════════════════════════════════════════════════════════

  ── [A] @deepseek-ai/* 重复包 ──
    ✓ 无重复
    ✓ dsh-scope 实例数 = 0

  ── [B] 包版本 skew ──
    ✓ 所有 @deepseek-ai/* 版本一致

  ── [C] Session API 迁移 ──
    ✓ bundle 源码无直接 session.events 调用

  ── [D] dsh-edge-agent bundle 完整性 ──
    ✓ lib/ 存在
    ✓ package.json 存在
    ✓ cordis.patch.yml 存在
    ✓ bundle lib 是最新

  ── [E] audit-log minLevel 配置 ──
    ✓ audit-log minLevel = info

  ── [F] cordis.patch.yml 同步 ──
    ✓ bundle patch = repo patch

╔════════════════════════════════════════════════════════════╗
║                      检查汇总                            ║
╚════════════════════════════════════════════════════════════╝

  严重问题:  0
  警告:      0

  ✓ 所有检查通过
```

## 相关脚本

| 脚本 | 用途 |
|---|---|
| `scripts/fix-profile-duplicates.sh` | 专门修 [A] 类问题（strip @deepseek-ai/*）|
| `scripts/dsh-systemic-health.sh` | 本脚本，全面检查 A-G 类问题 |
| `install.sh` | 部署 bundle（会引入重复包，需后续 trim）|

## 已知陷阱备忘

- **dsh-scope 双实例**：dsh 全局二进制内嵌 @deepseek-ai/*，profile 装同名包 → 两个 `Symbol('dsh.scope')` → preset 系统崩
  - **web profile 没事**：harness 不走 `roster.mount()`，重复包是预期
  - **tui / 自定义 profile 会崩**：用 preset 系统（`presets.mount()`），必须 strip 重复
- **Session.events 移除**：dsh 0.1.2-rc.1 改 `session.snapshotEvents()`；直接 `.events` 会 SyntaxError
- **audit-log debug 静默 drop**：`audit-log.ts:163` minLevel=debug 时所有事件被 drop，看起来像 audit 没工作
- **bundle lib 不同步**：改了 src 但没跑 install.sh --skip-pnpm，运行时还是旧代码
- **cordis.patch.yml 双层**：repo 根（bundle-level）+ profile 根（profile-level），install.sh §3.5 只同步前者

## 输出解读

### ✓ 全部通过（理想状态）
```
严重问题:  0
警告:      0
✓ 所有检查通过
```

### ℹ 信息项（web profile 预期）
```
[A] @deepseek-ai/* 重复包
    ℹ 15 个 @deepseek-ai/*（web profile 预期，harness 不走 roster.mount）
    ℹ dsh-scope 实例数 = 1（web profile 预期，不影响运行）
```
**不需要修**。web harness 直接 import @deepseek-ai/*，不走 preset 系统，不会触发 symbol  mismatch。

### ⚠ 警告项（建议关注）
```
[D] bundle lib 过时（repo 编译产物更新）
    → 跑 ./install.sh --skip-pnpm 同步
```
**不影响启动**，但 bundle 里的代码不是最新。跑一次 `./install.sh --skip-pnpm` 同步。

### ✗ 严重问题（必须修）
```
[A] @deepseek-ai/* 重复包
    ⚠ 7 个重复（会制造 Symbol 双实例，触发 unscoped context 崩溃）
```
**必须 strip**，否则 profile 启动崩溃：
```bash
bash scripts/fix-profile-duplicates.sh --profile=<name>
```
