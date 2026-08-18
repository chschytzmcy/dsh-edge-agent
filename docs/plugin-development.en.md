# Plugin Development Guide

`dsh-edge-agent` is extensible through the Cordis plugin mechanism. This guide explains how to write new plugins.

## 📋 Plugin Specification

Every dsh-edge-agent plugin must follow this specification:

```typescript
// src/dsh-adapter/my-plugin.ts

export const name = 'my-plugin'  // kebab-case, must match filename

export const inject = ['tcm', 'sessions'] as const  // soft dependency list

export interface Config {
  // Configuration fields
  myOption: string
}

export const Config: Schema<Config> = Schema.object({
  myOption: Schema.string().required(),
})

export async function apply(ctx: Context, config: Config): Promise<void> {
  // 1. Register service
  ctx.plugin(MyService)

  // 2. Subscribe to events (optional)
  ctx.event.on('agent/pre-step', async (payload) => { ... })

  // 3. Register tools (optional)
  ctx.edgeTools.register({ ... }, async (args) => { ... })

  // 4. Return disposer
  return async () => {
    // cleanup logic
  }
}
```

## 🔧 Creating a Plugin

### Step 1: Create a file under `src/dsh-adapter/`

```sh
touch src/dsh-adapter/my-plugin.ts
```

The filename must match the `name` field (kebab-case).

### Step 2: Implement the plugin

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
    // your logic here
    return `processed: ${input}`
  }
}

// Declare ctx extension (optional)
declare module '@deepseek-ai/cordis' {
  interface Context {
    myService: MyServiceImpl
  }
}

export async function apply(ctx: any, config: Config): Promise<void> {
  ctx.plugin(MyServiceImpl)
  void config
  return async () => {
    // cleanup logic
  }
}
```

### Step 3: Add a shim in `src/`

```typescript
// src/my-plugin.ts
export * from './dsh-adapter/my-plugin.js'
export { default } from './dsh-adapter/my-plugin.js'
```

### Step 4: Register in `cordis.yml`

```yaml
- id: my-plugin
  name: '@deepseek-harness-edge-agent/dsh-edge-agent/my-plugin'
  inject: [tcm]
  config:
    enabled: true
    rateLimit: 100
```

### Step 5: Add a subpath export to `package.json`

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

### Step 6: Record in `patch-surface.snapshot.json`

```json
{
  "inserts": ["my-plugin", ...]
}
```

## 🔐 Realm Awareness

If your plugin handles data, declare its realm:

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
      realm: config.realm,  // important: declare realm
      description: '...',
      inputSchema: { ... },
    },
    async (args) => {
      // tool implementation
    },
  )
}
```

## 📡 Event Subscription

Plugins can subscribe to DSH agent-loop events:

```typescript
export async function apply(ctx: any, config: Config): Promise<void> {
  ctx.event.on('agent/pre-step', async (payload) => {
    // runs before each step
    console.log('pre-step', payload)
  })

  ctx.event.on('agent/request', async (payload) => {
    // before LLM call
  })

  ctx.event.on('agent/response', async (payload) => {
    // after LLM response
  })

  ctx.event.on('agent/post-step', async (payload) => {
    // after each step
  })

  return async () => {
    // cleanup event subscriptions
  }
}
```

## 🔌 Service Registration

Plugins can register a Cordis service:

```typescript
import { Service } from '@deepseek-ai/cordis'

export class MyService extends Service {
  constructor(ctx: any) {
    super(ctx, 'myService')
  }

  // service method
  async myMethod(): Promise<void> {
    // ...
  }
}

// Register in apply
export async function apply(ctx: any, config: Config): Promise<void> {
  ctx.plugin(MyService)
}
```

Other plugins can access via `ctx.myService`.

## 🧪 Testing Plugins

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

## 🔒 Security Best Practices

1. **Minimum privilege**: only declare true soft dependencies in `inject`
2. **Input validation**: validate all user input
3. **Output filtering**: filter sensitive info before returning
4. **Audit logging**: use `ctx.auditLog.log()` for important operations
5. **Error handling**: never swallow errors; at least record them
6. **Resource cleanup**: release all resources in the disposer

## 📦 Third-Party Plugins

If your plugin needs to be used by other projects, publish it as a standalone package:

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

In the user's `cordis.yml`:

```yaml
- id: my-foo-plugin
  name: '@my-org/dsh-edge-foo'
  inject: [tcm, sessions]
  config: { ... }
```

Enable third-party plugins:
```sh
export DSH_EDGE_PLUGINS_THIRD_PARTY=true
```

## 🔗 Related Documentation

- [Architecture](architecture.en.md#plugin-tree)
- [Configuration](configuration.en.md#plugin-configuration)
- [Threat Model](threat-model.en.md)