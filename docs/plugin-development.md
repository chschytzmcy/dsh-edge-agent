# 插件开发指南

dsh-edge-agent 通过 Cordis 插件机制实现可扩展性。本指南介绍如何编写新的插件。

## 📋 插件规范

每个 dsh-edge-agent 插件必须遵循以下规范：

```typescript
// src/dsh-adapter/my-plugin.ts

export const name = 'my-plugin'  // kebab-case，必须与文件名一致

export const inject = ['tcm', 'sessions'] as const  // 软依赖列表

export interface Config {
  // 配置字段
  myOption: string
}

export const Config: Schema<Config> = Schema.object({
  myOption: Schema.string().required(),
})

export async function apply(ctx: Context, config: Config): Promise<void> {
  // 1. 注册服务
  ctx.plugin(MyService)

  // 2. 订阅事件（可选）
  ctx.event.on('agent/pre-step', async (payload) => { ... })

  // 3. 注册工具（可选）
  ctx.edgeTools.register({ ... }, async (args) => { ... })

  // 4. 返回 disposer
  return async () => {
    // 清理逻辑
  }
}
```

## 🔧 创建插件的步骤

### Step 1: 在 `src/dsh-adapter/` 创建文件

```sh
touch src/dsh-adapter/my-plugin.ts
```

文件名必须与 `name` 字段一致（kebab-case）。

### Step 2: 实现插件

```typescript
// src/dsh-adapter/my-plugin.ts
import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'my-plugin'

export const inject = ['tcm'] as const

export interface Config {
  enabled: boolean
  rateLimit: number
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true),
  rateLimit: Schema.natural().default(100),
})

export interface MyService {
  doSomething(input: string): Promise<string>
}

export class MyServiceImpl extends Service {
  constructor(ctx: any) {
    super(ctx, 'myService')
  }

  async doSomething(input: string): Promise<string> {
    // 实现你的逻辑
    return `processed: ${input}`
  }
}

// 声明 ctx 扩展（可选）
declare module '@deepseek-ai/cordis' {
  interface Context {
    myService: MyServiceImpl
  }
}

export async function apply(ctx: any, config: Config): Promise<void> {
  ctx.plugin(MyServiceImpl)
  void config
  return async () => {
    // 清理逻辑
  }
}
```

### Step 3: 在 `src/` 添加 shim

```typescript
// src/my-plugin.ts
export * from './dsh-adapter/my-plugin.js'
export { default } from './dsh-adapter/my-plugin.js'
```

### Step 4: 在 `cordis.yml` 注册

```yaml
- id: my-plugin
  name: '@deepseek-harness-edge-agent/dsh-edge-agent/my-plugin'
  inject: [tcm]
  config:
    enabled: true
    rateLimit: 100
```

### Step 5: 在 `package.json` 添加 subpath export

```json
{
  "exports": {
    "./my-plugin": {
      "types": "./lib/types/my-plugin.d.ts",
      "import": "./lib/types/my-plugin.js"
    }
  }
}
```

### Step 6: 在 `patch-surface.snapshot.json` 记录

```json
{
  "inserts": ["my-plugin", ...]
}
```

## 🔐 Realm 感知

如果你的插件涉及数据处理，建议声明 realm：

```typescript
export const name = 'my-plugin'

export const inject = ['tools'] as const

export interface Config {
  realm: 'LOCAL' | 'CLOUD' | 'SANITIZED'
}

export async function apply(ctx: any, config: Config): Promise<void> {
  const tools = ctx.edgeTools
  tools.register(
    {
      name: 'my_tool',
      realm: config.realm,  // 重要：声明 realm
      description: '...',
      inputSchema: { ... },
    },
    async (args) => {
      // 工具实现
    },
  )
}
```

## 📡 事件订阅

插件可以订阅 DSH agent loop 的事件：

```typescript
export async function apply(ctx: any, config: Config): Promise<void> {
  ctx.event.on('agent/pre-step', async (payload) => {
    // 在每一步前执行
    console.log('pre-step', payload)
  })

  ctx.event.on('agent/request', async (payload) => {
    // LLM 调用前
  })

  ctx.event.on('agent/response', async (payload) => {
    // LLM 响应后
  })

  ctx.event.on('agent/post-step', async (payload) => {
    // 每一步后
  })

  return async () => {
    // 清理事件订阅
  }
}
```

## 🔌 服务注册

插件可以注册 Cordis service：

```typescript
import { Service } from '@deepseek-ai/cordis'

export class MyService extends Service {
  constructor(ctx: any) {
    super(ctx, 'myService')
  }

  // 服务方法
  async myMethod(): Promise<void> {
    // ...
  }
}

// 在 apply 中注册
export async function apply(ctx: any, config: Config): Promise<void> {
  ctx.plugin(MyService)
}
```

其他插件可以通过 `ctx.myService` 访问。

## 🧪 测试插件

```ts
// tests/unit/my-plugin.test.ts
import assert from 'node:assert/strict'
import { default as myPlugin } from '../../src/dsh-adapter/my-plugin.ts'

describe('my-plugin', () => {
  it('exports the canonical plugin shape', () => {
    assert.equal(myPlugin.name, 'my-plugin')
    assert.deepEqual([...myPlugin.inject], ['tcm'])
    assert.equal(typeof myPlugin.apply, 'function')
  })

  it('default apply returns a disposer', async () => {
    const fakeCtx = { plugin: () => undefined } as never
    const dispose = await myPlugin.apply(fakeCtx, {
      enabled: true,
      rateLimit: 100,
    })
    assert.equal(typeof dispose, 'function')
    await dispose()
  })
})
```

## 🔒 安全最佳实践

1. **最小权限**：只在 `inject` 中声明真正需要的依赖
2. **输入验证**：对所有用户输入进行验证
3. **输出过滤**：在返回前过滤敏感信息
4. **审计日志**：使用 `ctx.auditLog.log()` 记录重要操作
5. **错误处理**：不要吞掉错误，至少要记录
6. **资源清理**：在 disposer 中释放所有资源

## 📦 第三方插件

如果你的插件需要被其他项目使用，可以发布为独立包：

```json
// third-party-plugin/package.json
{
  "name": "@my-org/dsh-edge-foo",
  "version": "0.1.0",
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-harness-edge-agent/dsh-edge-agent": "^0.1.0"
  }
}
```

在用户的 `cordis.yml` 中挂载：

```yaml
- id: my-foo-plugin
  name: '@my-org/dsh-edge-foo'
  inject: [tcm, sessions]
  config: { ... }
```

启用第三方插件：
```sh
export DSH_EDGE_PLUGINS_THIRD_PARTY=true
```

## 🔗 相关文档

- [架构设计](architecture.md#插件树)
- [配置参考](configuration.md#插件配置)
- [威胁模型](threat-model.md)