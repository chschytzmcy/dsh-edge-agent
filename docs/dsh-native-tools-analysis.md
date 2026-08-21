# DSH 原生工具复用分析

> 生成时间: 2026-08-21  
> 分析 DSH 已提供的工具与 dsh-edge-agent 当前实现的重叠

---

## 0. 结论摘要

**DSH 已经提供了完整的工具集,dsh-edge-agent 应该直接复用,而不是重新实现。**

| 功能 | DSH 原生包 | dsh-edge-agent 当前实现 | 建议 |
|------|-----------|------------------------|------|
| **Bash 执行** | `@deepseek-ai/dsh-tool-bash` ✅ | 无(通过 local-tools 间接实现) | ✅ **直接用 DSH** |
| **文件读写** | `@deepseek-ai/dsh-tool-fs` ✅ | `local-tools.ts` 的 local_file_read/write | ✅ **直接用 DSH** |
| **数学计算** | DSH bash 工具可执行 | `local-tools.ts` 的 local_calculate | ⚠️ **可保留或移除**(DSH bash 更强) |
| **Web 搜索** | `@deepseek-ai/dsh-tool-web` + `dsh-web-search-deepseek` ✅ | `web-search.ts`(stub,返回空) | ✅ **直接用 DSH** |
| **Web 抓取** | `@deepseek-ai/dsh-tool-web` ✅ | 无 | ✅ **直接用 DSH** |

---

## 1. DSH 原生工具详解

### 1.1 Bash 工具 (`@deepseek-ai/dsh-tool-bash`)

**已提供的功能**:
- ✅ 完整的 bash 命令执行(`bash -c`)
- ✅ 工作目录管理(`workdir`,基于会话 cwd)
- ✅ 超时控制(`timeoutMs`)
- ✅ 后台执行(`run_in_background`,通过 `ctx.jobs`)
- ✅ 沙箱模式(`workspace-write` / `danger-full-access`)
- ✅ 权限升权(`ctx.approval`)
- ✅ 输出截断和 spill 文件
- ✅ 退出码、信号、超时标记
- ✅ 环境变量管理(`DSH_*` 托管变量)
- ✅ Job 管理(`job_output`, `job_list`, `job_kill`)

**安全特性**:
- 沙箱限制(Landlock/Windows ACL)
- 逐会话 cwd 隔离
- 环境变量清理(移除凭据和陈旧 `DSH_*`)
- 权限升权需要用户批准

**与 dsh-edge-agent 的关系**:
- ❌ **dsh-edge-agent 没有自己的 bash 实现**
- ✅ 当前测试中使用的 `bash` 工具就是 DSH 原生的
- ✅ 可以直接使用,无需任何修改

---

### 1.2 文件系统工具 (`@deepseek-ai/dsh-tool-fs`)

**已提供的功能**:
- ✅ `read` — 带行号的文件读取,分页支持
- ✅ `write` — 创建/覆盖文件
- ✅ `edit` — 字面量替换编辑
- ✅ `read_image` — 图像文件读取(PNG/JPEG/WebP/GIF)
- ✅ 流式读取(大文件)
- ✅ 读取窗口逻辑(`offset`, `limit`)
- ✅ 观察策略插件(`dsh-fs-observation-policy`)
- ✅ 沙箱限制和权限升权

**安全特性**:
- 路径解析基于会话 cwd
- 写入前需要观察(`fs/observed` 事件)
- 版本控制(防止并发冲突)
- 沙箱模式支持
- 文件大小限制(`readMaxBytes`, `readStreamMinSize`)

**与 dsh-edge-agent 的关系**:
- ⚠️ **dsh-edge-agent 的 `local_file_read`/`local_file_write` 是重复实现**
- ❌ 缺少 DSH 的编辑、图像读取、流式读取等功能
- ❌ 缺少观察策略和版本控制
- ✅ 应该用 DSH 的 `read`/`write`/`edit` 替代

---

### 1.3 Web 工具 (`@deepseek-ai/dsh-tool-web`)

**已提供的功能**:
- ✅ `web_search` — Web 搜索,返回答案和来源 URL
- ✅ `web_fetch` — 获取特定 URL,HTML→Markdown 渲染
- ✅ 结果数量上限(`searchMaxResults`,默认 8)
- ✅ 超时控制(`fetchTimeoutMs`, `searchTimeoutMs`)
- ✅ 输出大小限制(`fetchMaxOutputChars`,默认 200,000)
- ✅ UI 呈现卡片(`presentCall`, `presentResult`)
- ✅ 结构化错误处理(`WebError`)

**搜索提供者**:
- `@deepseek-ai/dsh-web-search-deepseek` — DeepSeek 的 Anthropic 兼容 API
- 调用 `POST {baseURL}/messages` 启用 `web_search_20250305` 服务器工具
- 解析 `web_search_tool_result` 块
- 去重、截断、来源关联

**与 dsh-edge-agent 的关系**:
- ⚠️ **dsh-edge-agent 的 `web-search.ts` 是 stub,返回空数组**
- ❌ 缺少实际的搜索实现
- ✅ 应该直接用 DSH 的 `web_search` 和 `web_fetch`

---

## 2. dsh-edge-agent 当前实现的问题

### 2.1 local-tools.ts — 重复造轮子

**当前实现**:
```typescript
// 3 个工具
local_file_read  → 读取文件
local_file_write → 写入文件
local_calculate  → 纯数学计算
```

**问题**:
1. **与 DSH 工具重叠** — DSH 已经有 `read`/`write`/`edit` 工具,功能更完整
2. **缺少高级功能**:
   - ❌ 没有编辑工具(`edit`)
   - ❌ 没有图像读取(`read_image`)
   - ❌ 没有流式读取
   - ❌ 没有观察策略(版本控制)
   - ❌ 没有沙箱限制
3. **Realm 标记是唯一的额外价值** — 但这可以通过配置 DSH 工具实现

**allowList 控制**:
- 当前实现有 `allowList` 白名单
- DSH 工具通过 `ctx.fs.resolve()` 和沙箱模式实现类似功能
- 可以通过配置 DSH 的沙箱策略达到相同效果

---

### 2.2 web-search.ts — Stub 实现

**当前实现**:
```typescript
async search(query: string, options?: { maxResults?: number }): Promise<WebSearchResult[]> {
  void query
  void options
  return []  // ← stub,没有实际搜索
}
```

**问题**:
1. **完全不可用** — 返回空数组,无法执行搜索
2. **DSH 已有完整实现** — `dsh-tool-web` + `dsh-web-search-deepseek` 提供了生产级搜索
3. **重复配置** — 当前配置 `backend: 'duckduckgo' | 'brave' | 'custom'` 都没有实现

**正确的做法**:
- 直接使用 DSH 的 `web_search` 和 `web_fetch` 工具
- 通过 `ctx.web` seam 自动选择提供者
- 配置 `dsh-web-search-deepseek` 的 API key 和端点

---

## 3. 推荐的改进方案

### 3.1 短期(立即可做)

#### ✅ 删除 local-tools.ts,使用 DSH 原生工具

**修改 cordis.yml**:
```yaml
# 移除 local-tools 插件
# - id: local-tools
#   name: '@deepseek-harness-edge-agent/dsh-edge-agent/local-tools'

# 确保 DSH 工具已加载
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
  config:
    readLimit: 2000
    readMaxBytes: 51200
- id: fs-local
  name: '@deepseek-ai/dsh-fs-local'
  config:
    cwd: /home/etsme/cy/agent/dsh-edge-agent
```

**好处**:
- ✅ 立即获得完整的文件系统工具(read/write/edit/read_image)
- ✅ 获得 bash 工具和 job 管理
- ✅ 减少维护成本
- ✅ 与 DSH 生态保持一致

#### ✅ 删除 web-search.ts,使用 DSH 原生工具

**修改 cordis.yml**:
```yaml
# 移除 web-search 插件
# - id: web-search
#   name: '@deepseek-harness-edge-agent/dsh-edge-agent/web-search'

# 加载 DSH web 工具
- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
  config:
    search: true
    fetch: true
    searchMaxResults: 8
    fetchTimeoutMs: 30000

- id: web-search-deepseek
  name: '@deepseek-ai/dsh-web-search-deepseek'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
    baseURL: https://api.deepseek.com/anthropic/v1
```

**好处**:
- ✅ 立即获得可用的 web 搜索
- ✅ 获得 web_fetch(URL 抓取)
- ✅ 使用 DeepSeek 的原生搜索能力
- ✅ 结构化搜索结果(URL、标题、snippet、引用)

---

### 3.2 中期(需要少量开发)

#### 🔧 为 DSH 工具添加 Realm 标记

**问题**: DSH 工具没有 LOCAL/CLOUD realm 概念

**解决方案**: 通过 Cordis 的 waterfall/middleware 机制注入

```typescript
// 创建新插件: realm-marker
export const name = 'realm-marker'
export const inject = ['tools', 'edgeTools'] as const

export async function apply(ctx: Context, config: Config) {
  // 监听工具注册,标记 realm
  ctx.on('tool/registered', (tool) => {
    if (['read', 'write', 'edit', 'bash'].includes(tool.name)) {
      ctx.edgeTools.setRealm(tool.name, 'LOCAL')
    }
    if (['web_search', 'web_fetch'].includes(tool.name)) {
      ctx.edgeTools.setRealm(tool.name, 'CLOUD')
    }
  })
}
```

**或者更简单**: 在 intent-router 中根据工具名称推断 realm

```typescript
// intent-router.ts 中
function getToolRealm(toolName: string): Realm {
  const localTools = ['read', 'write', 'edit', 'bash', 'local_calculate']
  const cloudTools = ['web_search', 'web_fetch']
  
  if (localTools.includes(toolName)) return 'LOCAL'
  if (cloudTools.includes(toolName)) return 'CLOUD'
  return 'SANITIZED'
}
```

---

#### 🔧 为 DSH 工具添加 allowList 控制

**问题**: DSH 工具使用沙箱模式,但没有 allowList 概念

**解决方案 1**: 使用 DSH 的沙箱配置

```yaml
- id: fs-local
  name: '@deepseek-ai/dsh-fs-local'
  config:
    cwd: /home/etsme/cy/agent/dsh-edge-agent
    # 通过沙箱策略限制访问范围
    sandboxMode: workspace-write
```

**解决方案 2**: 创建中间件拦截工具调用

```typescript
// allowlist-guard.ts
export const name = 'allowlist-guard'
export const inject = ['tools', 'edgeTools'] as const

export async function apply(ctx: Context, config: Config) {
  ctx.before('tool/execute', async (toolName, args) => {
    if (['read', 'write', 'edit'].includes(toolName)) {
      const path = args.file_path
      if (!isUnderAllowList(path, config.allowList)) {
        throw new Error(`Path ${path} not in allowList`)
      }
    }
  })
}
```

---

#### 🔧 集成 privacy-policy 和 audit-log

**问题**: DSH 工具没有隐私策略和审计集成

**解决方案**: 通过事件监听

```typescript
// privacy-audit-bridge.ts
export const name = 'privacy-audit-bridge'
export const inject = ['tools', 'privacyPolicy', 'auditLog'] as const

export async function apply(ctx: Context) {
  // 监听工具调用
  ctx.on('tool/executed', async (toolName, args, result) => {
    // 审计日志
    await ctx.auditLog.log({
      level: 'info',
      kind: 'tool.executed',
      source: toolName,
      payload: { args, resultLen: JSON.stringify(result).length }
    })
    
    // 隐私策略检查(异步,不阻塞)
    if (['web_search', 'web_fetch'].includes(toolName)) {
      await ctx.privacyPolicy.checkOutbound(args)
    }
  })
}
```

---

### 3.3 长期(架构优化)

#### 🎯 统一工具注册机制

**当前问题**: `ctx.tools` 和 `ctx.edgeTools` 两套注册机制

**建议**: 全部使用 `ctx.tools`,删除 `ctx.edgeTools`

```typescript
// 删除 tools.ts 中的 edgeTools 扩展
// 只在 DSH 的 ctx.tools 上添加 realm 元数据

ctx.tools.register({
  name: 'web_search',
  metadata: { realm: 'CLOUD' }  // ← 通过 metadata 传递 realm
}, handler)
```

---

#### 🎯 创建 Edge 工具配置层

**目标**: 让 DSH 工具感知 Edge 的安全需求

```typescript
// edge-tool-config.ts
export const name = 'edge-tool-config'
export const inject = ['tools', 'localStorage', 'privacyPolicy', 'secureBridge'] as const

export async function apply(ctx: Context) {
  // 配置 DSH 工具使用 Edge 的安全服务
  
  // 1. 文件系统工具使用加密存储
  ctx.configure('tool-fs', {
    storageBackend: ctx.localStorage  // ← 替换默认存储
  })
  
  // 2. Web 工具使用 secure-bridge
  ctx.configure('tool-web', {
    httpClient: ctx.secureBridge  // ← 替换默认 HTTP 客户端
  })
  
  // 3. Bash 工具使用 TEE 密钥
  ctx.configure('tool-bash', {
    envProvider: () => ({
      TEE_KEY: ctx.tcm.getKey('bash-env')
    })
  })
}
```

---

## 4. 迁移路线图

### Phase 1: 立即复用 DSH 工具 (1-2 天)

- [ ] 删除 `local-tools.ts` 插件
- [ ] 删除 `web-search.ts` 插件
- [ ] 更新 `cordis.yml` 加载 DSH 原生工具
- [ ] 配置 `dsh-web-search-deepseek` 的 API key
- [ ] 测试验证:
  - [ ] `read`/`write`/`edit` 工具正常工作
  - [ ] `bash` 工具正常工作
  - [ ] `web_search` 返回真实搜索结果
  - [ ] `web_fetch` 抓取 URL 成功

### Phase 2: 添加 Edge 安全层 (3-5 天)

- [ ] 创建 `realm-marker` 插件,标记工具 realm
- [ ] 创建 `allowlist-guard` 插件,拦截工具调用
- [ ] 创建 `privacy-audit-bridge` 插件,集成隐私策略和审计
- [ ] 更新 `intent-router` 根据 realm 路由请求

### Phase 3: 深度集成 (1-2 周)

- [ ] 配置 DSH 工具使用 `localStorage`(加密存储)
- [ ] 配置 DSH 工具使用 `secureBridge`(OHTTP)
- [ ] 创建 Edge 专属的工具配置层
- [ ] 完善隐私策略引擎与工具执行的集成

---

## 5. 成本收益分析

### 当前方案(重复实现)

**成本**:
- 🔴 维护 2 个插件(local-tools, web-search)
- 🔴 功能不完整(缺少 edit、image、stream、search)
- 🔴 与 DSH 生态脱节
- 🔴 需要自己处理沙箱、超时、错误

**收益**:
- 🟢 完全控制(但实际上 DSH 工具已经可配置)
- 🟢 Realm 标记(但可以通过配置实现)

### 推荐方案(复用 DSH)

**成本**:
- 🟡 需要添加少量 Edge 专属逻辑(realm、allowlist)
- 🟡 需要理解 DSH 工具的配置机制

**收益**:
- 🟢 立即获得完整功能(bash、fs、web_search、web_fetch)
- 🟢 减少维护成本(删除 2 个插件)
- 🟢 与 DSH 生态保持一致
- 🟢 自动获得 DSH 的更新和改进
- 🟢 更好的安全性(DSH 工具经过更严格的测试)

---

## 6. 总结

**你的质疑完全正确** — dsh-edge-agent 不应该重新实现 DSH 已经提供的工具。

### 核心观点

1. **DSH 工具已经非常完整** — bash、fs、web 工具都经过生产验证
2. **重复实现是浪费** — local-tools 和 web-search 的功能 DSH 都有
3. **Edge 的额外需求可以通过配置/中间件实现** — realm、allowlist、privacy、audit
4. **应该站在巨人的肩膀上** — 复用 DSH 工具,专注于 Edge 的独特价值(TEE、OHTTP、隐私策略)

### 立即行动

1. ✅ 删除 `local-tools.ts` 和 `web-search.ts`
2. ✅ 更新 `cordis.yml` 加载 DSH 原生工具
3. ✅ 配置 `dsh-web-search-deepseek` 使用 DEEPSEEK_API_KEY
4. ✅ 测试验证所有工具正常工作

### 后续优化

1. 🔧 创建 `realm-marker` 插件标记工具 realm
2. 🔧 创建 `allowlist-guard` 插件控制访问范围
3. 🔧 创建 `privacy-audit-bridge` 插件集成安全和审计
4. 🔧 深度集成 Edge 安全服务(localStorage、secureBridge、tcm)

---

**最终目标**: dsh-edge-agent 应该是一个**配置层**和**安全层**,而不是工具实现层。让 DSH 负责工具,Edge 负责安全。
