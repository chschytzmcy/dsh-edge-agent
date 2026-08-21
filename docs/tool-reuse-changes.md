# 工具复用变更总结

> 时间: 2026-08-21  
> 变更: 删除重复工具实现,切换到 DSH 原生工具

---

## 变更概览

### 删除的文件

1. **`src/dsh-adapter/local-tools.ts`** — 本地工具实现(local_file_read/write/calculate)
2. **`src/dsh-adapter/web-search.ts`** — Web 搜索 stub(返回空数组)
3. **`src/local-tools.ts`** — 顶层 re-export
4. **`src/web-search.ts`** — 顶层 re-export

### 修改的文件

1. **`cordis.yml`** — 添加 DSH 原生工具配置
2. **`src/dsh-adapter/index.ts`** — 移除 local-tools 和 web-search 的导出
3. **`src/dsh-adapter/plugin.ts`** — 更新启动顺序注释(21→19 个插件)
4. **`src/dsh-adapter/tools.ts`** — 更新注释,移除对 local-tools 的引用
5. **`package.json`** — 移除 local-tools 和 web-search 的导出路径

---

## 新增的 DSH 原生工具配置

### cordis.yml 新增条目

```yaml
# 文件系统工具
- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
  config:
    readLimit: 2000
    readMaxBytes: 51200

# Bash 工具
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  config:
    enableRunInBackground: false

# Web 工具
- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
  config:
    search: true
    fetch: true
    searchMaxResults: 8
    fetchTimeoutMs: 30000
    searchTimeoutMs: 30000

# DeepSeek 搜索提供者
- id: web-search-deepseek
  name: '@deepseek-ai/dsh-web-search-deepseek'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
    baseURL: https://api.deepseek.com/anthropic/v1
    model: deepseek-v4-flash
```

---

## 获得的功能

### ✅ 立即获得的完整工具集

| 工具 | 来源 | 功能 |
|------|------|------|
| **bash** | `dsh-tool-bash` | Bash 执行、沙箱、后台 jobs、工作目录隔离 |
| **read** | `dsh-tool-fs` | 文件读取、行号、分页、流式读取 |
| **write** | `dsh-tool-fs` | 文件创建/覆盖、观察策略、版本控制 |
| **edit** | `dsh-tool-fs` | 字面量替换编辑、唯一匹配检查 |
| **read_image** | `dsh-tool-fs` | 图像文件读取(PNG/JPEG/WebP/GIF) |
| **web_search** | `dsh-tool-web` + `dsh-web-search-deepseek` | DeepSeek 原生搜索、结构化结果 |
| **web_fetch** | `dsh-tool-web` | URL 抓取、HTML→Markdown 渲染 |

### 🎯 相比之前实现的优势

#### Bash 工具
- ✅ 沙箱模式(workspace-write/full-access)
- ✅ 权限升权(ctx.approval)
- ✅ 后台 jobs(job_output/list/kill)
- ✅ 工作目录隔离(逐会话 cwd)
- ✅ 环境变量管理(DSH_* 托管)
- ✅ 输出截断 + spill 文件

#### 文件系统工具
- ✅ 编辑工具(edit) — 之前没有
- ✅ 图像读取(read_image) — 之前没有
- ✅ 流式读取 — 之前没有
- ✅ 观察策略(版本控制) — 之前没有
- ✅ 沙箱限制 — 之前没有

#### Web 工具
- ✅ **可用的搜索** — 之前 web-search.ts 是 stub,返回空数组
- ✅ Web 抓取(web_fetch) — 之前没有
- ✅ DeepSeek 原生搜索 — 结构化结果(URL、标题、snippet、引用)
- ✅ 去重、截断、错误处理

---

## 下一步工作

### 可选:添加 Edge 安全层

如果需要保持原有的安全特性,可以创建以下插件:

#### 1. Realm 标记插件

```typescript
// realm-marker.ts
export const name = 'realm-marker'
export const inject = ['tools', 'edgeTools'] as const

export async function apply(ctx: Context) {
  ctx.on('tool/registered', (tool) => {
    const localTools = ['read', 'write', 'edit', 'bash']
    const cloudTools = ['web_search', 'web_fetch']
    
    if (localTools.includes(tool.name)) {
      ctx.edgeTools.setRealm(tool.name, 'LOCAL')
    }
    if (cloudTools.includes(tool.name)) {
      ctx.edgeTools.setRealm(tool.name, 'CLOUD')
    }
  })
}
```

#### 2. 隐私审计桥接插件

```typescript
// privacy-audit-bridge.ts
export const name = 'privacy-audit-bridge'
export const inject = ['tools', 'privacyPolicy', 'auditLog'] as const

export async function apply(ctx: Context) {
  ctx.on('tool/executed', async (toolName, args, result) => {
    await ctx.auditLog.log({
      level: 'info',
      kind: 'tool.executed',
      source: toolName,
      payload: { args, resultLen: JSON.stringify(result).length }
    })
  })
}
```

---

## 验证测试

重新编译后,需要测试:

```bash
# 1. 测试文件工具
curl -X POST http://127.0.0.1:21017/v1/chat \
  -d '{"message":"读取 package.json 的前 10 行"}'

# 2. 测试 bash 工具
curl -X POST http://127.0.0.1:21017/v1/chat \
  -d '{"message":"执行命令: ls -la"}'

# 3. 测试 web 搜索(需要 DEEPSEEK_API_KEY)
curl -X POST http://127.0.0.1:21017/v1/chat \
  -d '{"message":"搜索最新的 AI 新闻"}'

# 4. 测试 web 抓取
curl -X POST http://127.0.0.1:21017/v1/chat \
  -d '{"message":"抓取 https://example.com 的内容"}'
```

---

## 总结

### 核心观点

✅ **DSH 原生工具已经非常完整**,dsh-edge-agent 不需要重新实现  
✅ **删除了重复代码**,减少维护成本  
✅ **立即获得完整功能**,包括之前缺失的 edit、read_image、web_fetch  
✅ **Web 搜索从 stub 变为可用** — 使用 DeepSeek 原生搜索 API  

### 架构原则

**dsh-edge-agent 应该是一个配置层和安全层,而不是工具实现层。**

- ✅ DSH 负责工具(bash、fs、web)
- ✅ Edge 负责安全(TEE、OHTTP、privacy-policy、audit-log)
- ✅ 站在巨人的肩膀上,专注于 Edge 的独特价值

---

## 相关文档

- `docs/dsh-native-tools-analysis.md` — DSH 原生工具详细分析
- `docs/plugin-architecture.md` — 插件架构和 DSH 调用关系
