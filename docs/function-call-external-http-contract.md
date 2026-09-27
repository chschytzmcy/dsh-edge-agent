# function-call-external HTTP 契约 v1.0

> §7.94 — `function-call-external` 的 HTTP 协议边界。任何实现 —— 包括
> cactus-needle、自训端侧 function-call 模型、第三方服务 —— 只需满足
> 下列契约,即可接入 dsh-edge-agent。

---

## 1. 端点

### 1.1 `GET /health`

| 状态码 | 含义 | plugin 行为 |
|---|---|---|
| 2xx | healthy | 关闭 breaker,记录 probeLatencyMs |
| 503 | loading / busy(模型未就绪或队列满)| 记录 + 维持 breaker |
| 其它 5xx | 引擎错误 | 记录 + 维持 breaker |
| timeout / 网络错 | 不可达 | 记录 + 维持 breaker |

**响应体**:任意文本,plugin 只看状态码。

### 1.2 `POST /extract`

#### 请求

```json
{
  "query": "string, 用户查询全文",
  "tools": [
    {
      "name": "string, 工具名",
      "description": "string, 工具描述",
      "parameters": { /* JSON Schema,任意深度 */ }
    }
  ],
  "system": "string?, 推荐传 'date: YYYY-MM-DD EEE; locale: zh-CN'"
}
```

**`system` 推荐**:传 `date: YYYY-MM-DD EEE; locale: zh-CN` 让小模型拿到日期 + locale
上下文(否则可能 confidence=1.0 但 function_calls=[] 报"没有可调工具"
——§7.93 Phase 9 amend 实测)。

#### 成功响应(2xx)

```json
{
  "type": "call" | "respond",
  "function_calls": [
    { "name": "string, 工具名", "arguments": { /* JSON object */ } }
  ],
  "confidence": 0.78,
  "validation": {
    "ungrounded": ["toolName.argName", "..."]
  }
}
```

| 字段 | 含义 |
|---|---|
| `type=call` | 有 function_calls 要执行 |
| `type=respond` | 不需调工具,直接由 LLM 合成回复 |
| `confidence` | 0-1,plugin 默认采纳阈值 0.5 |
| `validation.ungrounded` | 捏造的参数(`toolName.argName` 形式)。required 被捏造 → 不执行;非 required → 剥除后执行 |

#### 字段缺失容错

- 缺 `type` → 默认 `'respond'`
- 缺 `confidence` → 默认 0,低于阈值 → fall through
- 缺 `function_calls` 或类型错 → 当作空数组
- `function_calls[].name` 非 string → 跳过该 call
- `validation.ungrounded` 非数组 → 当作空数组

---

## 2. 失败语义(plugin 侧处理)

```
┌────────────────────────┬──────────┬──────────────┬──────────────┐
│ code + body            │ retry?   │ openBreaker? │ audit kind   │
├────────────────────────┼──────────┼──────────────┼──────────────┤
│ 422 invalid body       │    ❌    │      ❌      │ extract_failed
│ 503 + body 'loading'   │    ❌    │      ✅      │ extract_failed
│ 503 + body 'busy'      │ ✅ 200ms │ ✅ if retry  │ extract_retry → extract_failed
│ 502 engine             │ ✅ 200ms │ ✅ if retry  │ extract_retry → extract_failed
│ 408/504 timeout proxy  │    ❌    │      ✅      │ timeout_skip
│ 其它 5xx               │    ❌    │      ✅      │ extract_failed
│ AbortError(本地超时)   │    ❌    │      ✅      │ timeout_skip
│ 其它网络错             │    ❌    │      ✅      │ extract_failed
│ no fetcher             │    ❌    │      ✅      │ extract_failed
└────────────────────────┴──────────┴──────────────┴──────────────┘
```

**retry plan**:最多 1 次退避重试(200ms)。`retried: true` 字段标记第二次尝试。

**breaker**:打开后 TTL 默认 30s(`FUNCTION_CALL_EXTERNAL_BREAKER_TTL_MS`)。
期间 `isAvailable()` 返回 false,plugin 直接透传到 §7.42 P0-1 LLM
自提取路径,不做 extract 调用。

---

## 3. 配置

通过环境变量配置 URL,无需改 plugin 代码:

```bash
FUNCTION_CALL_EXTERNAL_URL=http://127.0.0.1:8081   # 默认值
FUNCTION_CALL_EXTERNAL_ENABLED=false                 # 默认关,显式启用
FUNCTION_CALL_EXTERNAL_TIMEOUT_MS=10000             # 单次 /extract 超时
FUNCTION_CALL_EXTERNAL_CONFIDENCE_THRESHOLD=0.5     # 采纳阈值
```

完整字段见 `cordis.patch.yml` §7.93 段 + `.env.example`。

---

## 4. audit / ops log

每个 `external.*` audit event 都携带 **`callerId`** 字段(§7.94 新增):

```
external.extract          { callerId: 'needle-http', durationMs: 423, ... }
external.circuit_open     { callerId: 'native-onnx-v1', reason: 'timeout', ... }
external.synthesis_injected { callerId: 'needle-http', toolCount: 2, ... }
```

callerId 在 caller 实现内硬编码(目前 `'needle-http'`),audit chain 通过
该字段区分不同实现。详见 `src/dsh-adapter/function-call-external.ts`
audit 章节。

---

## 5. 部署建议

### 5.1 HTTP over TCP

```bash
# needle-http 当前部署
FUNCTION_CALL_EXTERNAL_URL=http://127.0.0.1:8081
```

### 5.2 HTTP over Unix socket(端侧模型推荐)

避免 TCP overhead,Node 18+ `fetch` 支持 `unix://` URL:

```typescript
// custom fetch wrapper
const caller = new NeedleHttpCaller('unix:/var/run/needle.sock', ...)
// 自行实现 unix:// → net.connect + HTTP/1.1
```

或使用 `http_proxy` / `nginx` 等反代监听 Unix socket。

### 5.3 资源隔离

端侧模型部署时建议:
- 绑定 `127.0.0.1`,不暴露外部网络
- `FUNCTION_CALL_EXTERNAL_BREAKER_TTL_MS` 根据引擎 warmup 调整
- 定期重启避免内存泄漏(模型实例化工具链通常有 OOM 风险)

---

## 6. 端侧模型接入路径

```
1. 训练出 function-call 模型 v1
   ↓
2. 写一个 HTTP wrapper(任何语言)
   - 实现 GET /health(2xx / 503)
   - 实现 POST /extract(返回 type / function_calls / confidence / validation)
   ↓
3. 启动 wrapper,绑定 URL
   ↓
4. 改 .env:  FUNCTION_CALL_EXTERNAL_URL=http://127.0.0.1:<port>
              FUNCTION_CALL_EXTERNAL_ENABLED=true
   ↓
5. 重启 dsh,audit log 自动显示 callerId = '<your wrapper 自报 id>'
```

**plugin 主体零修改**。`ExternalToolCaller` interface 的 3 个新字段(`id` /
`kind` / `capabilities`)在 caller 实现内赋值即可。

---

## 7. 不在契约内的(扩展注意)

以下行为 plugin 不依赖,caller 自由实现:

| 项 | plugin 行为 |
|---|---|
| 鉴权(API key / mTLS) | 自接 reverse proxy / API gateway |
| rate limiting | caller 自管;plugin 不限速 |
| 流式返回(`text/event-stream`) | 当前契约一次性返回 JSON;流式 = Phase X |
| 多模态输入(图像 / 音频) | 当前契约只接 `query: string` |
| 工具 schema 富化(自动补 description)| caller 自实现;plugin 只透传 |
| 多语言 prompt 模板 | `system` 字段透传 |

需要扩展契约时,本文件同步更新 + §7.94.x PROGRESS 段记录。
