# 上游适配契约（ADAPTER）

> 本文档描述 dsh-edge-agent 与上游 DSH (DeepSeek Harness) 的版本与边界合约。

## 🎯 目的

`dsh-edge-agent` 严格隔离上游 DSH API，确保：

1. **升级可控**：DSH rc 版本升级时只影响一处（`src/dsh-adapter/`）
2. **边界可验证**：通过 `verify-adapter-boundary.ts` 在 CI 中强制检查
3. **类型可追溯**：所有上游类型从 `src/dsh-adapter/types.ts` 单一来源导出
4. **版本可锁定**：通过 `UPSTREAM_VALIDATED_VERSION` 锁定已验证的 DSH 版本线

## 📐 边界规则

### 1. 唯一允许 `@deepseek-ai/*` 的目录

```sh
src/dsh-adapter/    ✅ 允许
src/dsh-adapter/*    ✅ 允许（所有子文件）
src/<其他>.ts        ❌ 禁止
src/<子目录>/        ❌ 禁止
```

**违反后果**：CI 中 `pnpm run verify:boundary` 失败。

### 2. 类型导入必须经过 types.ts

```typescript
// ✅ 正确
import type { Context, Service } from './dsh-adapter/types.js'

// ❌ 错误
import { Context } from '@deepseek-ai/cordis'
```

**理由**：
- 集中上游类型 re-export，便于升级
- 减少 `@deepseek-ai/*` 直接依赖数量
- 加快 TypeScript 编译速度

### 3. 运行时导入必须经过 services

```typescript
// ✅ 正确（在 dsh-adapter 内）
const tcm = ctx.tcm
const llm = ctx.llm
const sessions = ctx.sessions

// ❌ 错误（直接调用上游 SDK）
import { Context } from '@deepseek-ai/cordis'
const ctx = new Context()
```

**理由**：
- 上游 SDK 可能在版本升级时改变 API
- dsh-edge-agent 通过 `interface Context` 增强类型提供稳定门面

### 4. Service 通过 `declare module` 扩展

```typescript
// src/dsh-adapter/tcm.ts
import { Service } from '@deepseek-ai/cordis'

export class TcmService extends Service {
  // ...
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tcm: TcmService
  }
}
```

**理由**：
- 类型合并让 `ctx.tcm` 在所有文件中可用
- 不需要 `as any` 强制转换

## 📦 已验证的版本线

```typescript
// src/dsh-adapter/contract.ts
export const UPSTREAM_VALIDATED_VERSION = '0.1.0-rc.6'

export const UPSTREAM_FRAMEWORK_MAJORS = {
  '@deepseek-ai/cordis': '^4.0.1',
  '@deepseek-ai/schemastery': '^3.18.1',
} as const

export const UPSTREAM_BLESSED_PACKAGES = [
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-events',
  '@deepseek-ai/dsh-scope',
  '@deepseek-ai/dsh-scope-disk',
] as const
```

**为什么是 `0.1.0-rc.6`？**

1. **DSH 团队已发布**：经过 DeepSeek Harness 团队验证的稳定预发布版本
2. **与 dsh-TUI 对齐**：确保生态兼容性
3. **schema 稳定**：所有必需的服务接口已稳定

## 🔍 验证脚本

### `verify:boundary`

```sh
node --import tsx/esm scripts/verify-adapter-boundary.ts
```

扫描所有 `src/**/*.ts`，确保 `@deepseek-ai/*` 只在 `src/dsh-adapter/` 内出现。

### `verify:contract`

```sh
node --import tsx/esm scripts/verify-upstream-contract.ts
```

读取 `package.json` 中的 `@deepseek-ai/*` 版本，与 `UPSTREAM_FRAMEWORK_MAJORS` 比对。不匹配时失败。

### `verify:build`

```sh
pnpm run verify:build
# = verify:boundary
# + verify:contract
# + verify:patch-surface
# + verify:plugin-spec
# + verify:package
```

串联所有验证脚本，CI 必须全部通过。

## 📈 升级流程

当 DSH 发布新版本（如 `0.1.0`）时：

### Step 1: 更新 `UPSTREAM_VALIDATED_VERSION`

```typescript
// src/dsh-adapter/contract.ts
-export const UPSTREAM_VALIDATED_VERSION = '0.1.0-rc.6'
+export const UPSTREAM_VALIDATED_VERSION = '0.1.0'
```

### Step 2: 更新 `package.json`

```json
{
  "devDependencies": {
    "@deepseek-ai/dsh-agent": "^0.1.0",
    "@deepseek-ai/dsh-llm": "^0.1.0",
    ...
  }
}
```

### Step 3: 运行 `pnpm install`

### Step 4: 修复破坏性变更

```sh
pnpm run compile
```

根据 TypeScript 错误逐个修复（应该都在 `src/dsh-adapter/` 内）。

### Step 5: 运行所有验证

```sh
pnpm run verify:build
pnpm test
```

### Step 6: 升级 patch-surface.snapshot

```sh
node --import tsx/esm scripts/verify-patch-surface.ts --snapshot
```

### Step 7: 更新测试和文档

确保所有测试通过，文档反映新版本。

### Step 8: 提交

```sh
git commit -m "chore: upgrade DSH to 0.1.0"
git tag v0.X.0
```

## 🛡️ Invariant Companion

dsh-edge-agent 提供一个 invariant companion 插件：

```typescript
// src/dsh-adapter/invariant.ts
export const name = 'dsh-edge-agent-invariant'

export const inject = ['invariants'] as const

export interface Config {
  // no config
}

export const Config: Schema<Config> = Schema.object({})

export async function apply(ctx: Context, config: Config): Promise<void> {
  // 检查关键不变量：
  // 1. ctx.tcm 已注册
  // 2. ctx.localStorage 已注册
  // 3. ctx.privacyPolicy 已加载
  // 4. ctx.auditLog 已启用

  ctx.effect(() => {
    if (!ctx.tcm) throw new Error('invariant: tcm must be mounted')
    if (!ctx.localStorage) throw new Error('invariant: local-storage must be mounted')
    if (!ctx.privacyPolicy) throw new Error('invariant: privacy-policy must be mounted')
    if (!ctx.auditLog) throw new Error('invariant: audit-log must be mounted')
  })

  return async () => {}
}
```

**作用**：
- 在所有关键插件挂载完成后运行
- 断言核心不变量已建立
- 失败时阻止 agent loop 启动

## 📚 相关文件

- `src/dsh-adapter/contract.ts` — 上游版本合约
- `src/dsh-adapter/types.ts` — 上游类型 re-export
- `src/dsh-adapter/invariant.ts` — 不变量 companion
- `src/dsh-adapter/index.ts` — 主插件
- `src/dsh-adapter/plugin.ts` — 主插件运行时
- `scripts/verify-adapter-boundary.ts` — 边界检查
- `scripts/verify-upstream-contract.ts` — 版本线校验