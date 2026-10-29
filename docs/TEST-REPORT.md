# 测试报告（dsh-edge-agent）

> 本文档承接原 README 的手动测试 / 自动化测试章节（2026-10-24 README 瘦身迁出），
> 并补充 §7.107 全链路 E2E 实测记录。日常跑法速查：
>
> ```bash
> pnpm test                    # 单元测试（vitest）
> pnpm run verify:build        # 15 项构建门禁
> pnpm run lint                # eslint（0 error 基线）
> bash scripts/e2e-ops-log-coverage.sh   # E2E：ops log 4 用例（需 profile 已起）
> ```

## 目录

- [最近一次全量结果](#最近一次全量结果)
- [Webui smoke](#webui-smoke)
- [Tui smoke](#tui-smoke)
- [http-api 手动测试](#http-api-手动测试)
- [自动化测试](#自动化测试)

## 最近一次全量结果

**2026-10-29（§7.145，Windows 实机 + 桌面版 r16）**：

| 项 | 结果 |
|---|---|
| 单元测试 | **70 文件 1424 passed / 2 skipped / 0 failed**（含 §7.145 新增：cookie janitor 23 例 + 未绑定会话口径 22 例） |
| eslint | **0 error**（58 个 unused-vars warning 非阻断） |
| `tsc --noEmit`（`tsconfig.json` + `tsconfig.client.json`） | 均 exit 0 |
| 构建门禁 `verify:build` | **15 项全过**（boundary / contract / patch-surface / preset-isolate / patch-row-shape / plugin-spec / env-bridge / bundle-mount / installable / installable-edge / host-mount / client-mount / desktop-auth-cookies / session-audit / package） |
| 桌面版实机（宿主 `127.0.0.1:62248`） | ① cookie janitor 两条防线日志在（`maxHeaderSize raised → 65536` / `auth=1 removed=1 projected=600B`）；② Edge 面板在未绑定会话时显示「尚未绑定会话」且**无**「轮次 / 本轮 / 五节点流程 / LLM 调用」 |

### 上一轮全量结果（§7.107 全链路，Windows 实机 + 真实 LLM 端点，2026-10-24）

| 项 | 结果 |
|---|---|
| 单元测试 | **52 文件 1042 passed / 2 skipped / 0 failed**（含修复 §7.107 翻转遗留的 10 个既有失败） |
| eslint | **0 error**（59 个 unused-vars warning 非阻断） |
| `tsc --noEmit`（noImplicitAny 开启后） | 通过 |
| 构建门禁 `verify:build` | **11 项全过**（boundary / contract / patch-surface / patch-row-shape / plugin-spec / env-bridge / bundle-mount / installable ×2 / host-mount / client-mount） |
| **E2E ops log（真实 profile + 真实 LLM）** | **4/4 全绿**：mibao（ets-auth skill 真调用）/ news（真实云往返 + web_search 1 次，resultLen 1054-1361）/ local-ip（pwsh+skill 真实扫出局域网密盒）/ knowledge（§7.107 no-web-need gate 生效，0 次云端调用） |

E2E 环境要点（复跑时照抄）：

```bash
export LOG_FILE="$HOME/.dsh-edge-agent/log/dsh-edge-agent-desktop.log"
export DSH_EDGE_HTTP_TOKEN=<edge.json secrets.edgeApiKey>
export E2E_RUN_ID=<每次运行换新 id>   # 会话隔离，防历史 turn 污染断言
bash scripts/e2e-ops-log-coverage.sh
```

E2E 三条 Windows 实测注意（详见 [load-into-local-dsh.md §8.2.1](load-into-local-dsh.md)）：
① Git Bash curl 中文 body 会按 GBK 转码——脚本已改 `--data-binary @file`；
② 文本 ops log 需 `DSH_EDGE_LOG_FILE=force` 启动 profile；
③ 命令断言接受 `bash|pwsh`（Windows 模型合理选 pwsh）。

## Webui smoke

（推荐，web profile 默认已装并启动）

```bash
# 0. §7.43: 默认 --all 已装 web profile；如未装：
./install.sh --profiles=web

# 1. web 默认已在 :21017 listen；UI 在 :3080
# （如需手动启动：cd ~/.dsh/profiles/web && setsid nohup dsh --profile web > run.log 2>&1 < /dev/null & disown）

# 2. 等 5-10s（webui 首次加载慢）
sleep 10

# 3. 浏览器访问 http://127.0.0.1:3080/
#    应看到 DSH 官方 Web UI（chat / task-board / pet / IM机器人）

# 4. 验证 dsh-edge-agent bundle plugin 已挂载（input-guard / intent-router / sanitizer）
curl -s http://127.0.0.1:3080/ | head -3
# 期望：HTML 含 dsh / webui 字样

# 5. 跟 audit log 验证 input-guard hook 注册
tail -10 ~/.dsh-edge-agent-web/audit/audit.plain.jsonl \
  | jq -c 'select(.kind | test("registered|loaded"))' | head -5
# 期望：input-guard.hook.registered 等事件

# 6. http-api 应 disabled（§7.33）
curl -s --max-time 3 http://127.0.0.1:21017/v1/health
# 期望：连接拒绝
```

## Tui smoke

（§7.43 primary；**默认就装**）

```bash
# 1. 启动 dsh-tui（install.sh 默认装；并存启动 dsh-tui + web）
cd ~/.dsh/profiles/dsh-tui
setsid nohup dsh --profile dsh-tui > run.log 2>&1 < /dev/null &
disown

# 2. 等 3-5s
sleep 5

# 3. 验证 dsh-tui 进程在跑
pgrep -f 'dsh --profile dsh-tui'   # 期望：返回 PID

# 4. 跟 audit log 验证 input-guard hook 注册
tail -10 ~/.dsh-edge-agent-dsh-tui/audit/audit.plain.jsonl \
  | jq -c 'select(.kind | test("registered|loaded"))' | head -5
# 期望：input-guard.hook.registered 等事件
```

## http-api 手动测试

> ⚠️ §7.33 后 http-api 在 web/tui profile 默认 disabled。要跑以下示例，先按
> README「重新启用 http-api」启用，或使用 §7.107 的 `dsh-edge-agent` profile
> （其 overlay 自带 http-api，推荐）。
> Windows 注意：中文 body 用 `--data-binary @file`（curl 命令行中文会被
> GBK 转码，实测导致实体护栏失效）。

假设服务运行在 `http://127.0.0.1:21017`，API Key 为 `test-secret-key`。

### 启动服务

```bash
# 方式 1: 使用启动脚本（推荐；§7.43 默认 dsh-tui）
./scripts/launch-dev.sh

# 方式 2: 手动启动（配置读 config/edge.json，§7.102）
dsh --profile dsh-tui

# 方式 3: 后台运行
setsid bash -c 'dsh --profile dsh-tui' > /tmp/dsh.log 2>&1 < /dev/null &
```

### Health Check

```bash
curl http://127.0.0.1:21017/v1/health
```

```json
{"status":"ok"}
```

### 认证测试

```bash
# 无 Token → 401
curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:21017/v1/chat \
  -H "Content-Type: application/json" -d '{"message":"hi"}'

# 错误 Token → 401
curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:21017/v1/chat \
  -H "Authorization: Bearer wrong-key" \
  -H "Content-Type: application/json" -d '{"message":"hi"}'

# 正确 Token → 200
curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:21017/v1/chat \
  -H "Authorization: Bearer test-secret-key" \
  -H "Content-Type: application/json" -d '{"message":"hi"}'
```

### Chat 同步

**LOCAL Intent**（本地处理 — 文件操作、计算；§7.107 起含全部无公网检索需求的普通请求）

```bash
curl -X POST http://127.0.0.1:21017/v1/chat \
  -H "Authorization: Bearer test-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"message":"帮我读取文件","sessionId":"test-local"}'
```

```json
{
  "sessionId": "test-local",
  "result": "请提供您想要我读取的文件路径，以便我帮您获取其内容。",
  "intent": {
    "category": "LOCAL",
    "targetRealm": "local",
    "confidence": 0.7,
    "rationale": "rule-keyword-match"
  },
  "duration": 940
}
```

> LOCAL intent 路由到本地 LLM（`local-llm`），直连真实 OpenAI 兼容端点（不消耗云端 API 配额）。

**CLOUD Intent**（云端处理 — **§7.107 起仅限需要检索公网信息**的请求）

```bash
curl -X POST http://127.0.0.1:21017/v1/chat \
  -H "Authorization: Bearer test-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"message":"查一下最新的AI新闻","sessionId":"test-cloud"}'
```

```json
{
  "sessionId": "test-cloud",
  "result": "……（真实新闻内容，resultLen > 1000）",
  "intent": {
    "category": "CLOUD",
    "targetRealm": "cloud",
    "confidence": 0.85,
    "rationale": "llm-classified:cloud"
  },
  "duration": 1575
}
```

> 无公网信号的普通问句（"用一句话介绍量子力学"）在 §7.107 后走 **LOCAL**
> （审计 `intent.cloud.blocked-no-web-need`），见 e2e knowledge 用例。

### 工具调用测试

dsh-edge-agent 使用 DSH 原生工具，所有工具都通过模型自动调用。

**Bash 工具**（本地命令执行）

```bash
curl -X POST http://127.0.0.1:21017/v1/chat \
  -H "Authorization: Bearer test-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"message":"帮我计算 17*23","sessionId":"test-bash"}'
```

模型会调用 `bash` 工具执行 `echo $((17*23))`，返回计算结果。

**文件工具**（读/写/编辑）

```bash
# 读取文件
curl -X POST http://127.0.0.1:21017/v1/chat \
  -H "Authorization: Bearer test-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"message":"读取 /tmp/test.txt 文件内容","sessionId":"test-file-read"}'

# 写入文件
curl -X POST http://127.0.0.1:21017/v1/chat \
  -H "Authorization: Bearer test-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"message":"在 /tmp 创建 hello.txt，内容是 Hello World","sessionId":"test-file-write"}'

# 编辑文件
curl -X POST http://127.0.0.1:21017/v1/chat \
  -H "Authorization: Bearer test-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"message":"将 /tmp/hello.txt 中的 Hello 改为 Hi","sessionId":"test-file-edit"}'
```

**Web 搜索工具**（§7.107 三档 fail-down 链：Tavily → 博查 → DeepSeek）

```bash
curl -X POST http://127.0.0.1:21017/v1/chat \
  -H "Authorization: Bearer test-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"message":"搜索 DeepSeek V4 模型的最新消息","sessionId":"test-web-search"}'
```

模型会调用 `web_search` 工具，返回搜索结果摘要。

**Web 获取工具**（抓取网页内容）

```bash
curl -X POST http://127.0.0.1:21017/v1/chat \
  -H "Authorization: Bearer test-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"message":"获取 https://example.com 的网页内容","sessionId":"test-web-fetch"}'
```

模型会调用 `web_fetch` 工具，返回网页内容摘要。

### Intent 分类规则

| 关键词触发 LOCAL | 默认 / 知识类 → §7.107 同样 LOCAL（no-web-need gate） |
|---|---|
| 文件、读取、写入、删除、计算、加减乘除 | 解释、什么是、如何、为什么（无公网信号 → 留在设备） |
| 本地、设备、系统、磁盘、目录、文件夹 | 你好、介绍、帮我写 |
| file, read, write, delete, calculate | 量子、相对论、Python |
| **→ CLOUD 仅当**：新闻/最新/实时/热搜/天气/股价、web search 等公网检索信号 | |

分类流程：先用本地 LLM 判断 → CLOUD 判决须带公网信号词（`cloudSignal`），
否则 gate 降级 LOCAL；LLM 失败时降级到关键词规则。密盒/ets/etscli 等
LOCAL 实体词确定性压回 LOCAL（§7.58 实体护栏）。

### Chat 流式（SSE）

```bash
curl -N -X POST http://127.0.0.1:21017/v1/chat/stream \
  -H "Authorization: Bearer test-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"message":"1+1等于几","sessionId":"test-002"}'
```

```
data: {"type":"intent","intent":{"category":"LOCAL","targetRealm":"local","confidence":0.85,"rationale":"llm-classified:local"}}

data: {"type":"text","text":"1"}

data: {"type":"text","text":"+1"}

data: {"type":"text","text":"=2"}

data: {"type":"done"}
```

> SSE 流式响应。帧类型：
> - `intent` — 首帧，携带意图分类结果
> - `text` — 文本增量片段
> - `done` — 结束帧

### 会话管理

```bash
# 列出所有会话
curl http://127.0.0.1:21017/v1/sessions \
  -H "Authorization: Bearer test-secret-key"

# 获取特定会话
curl http://127.0.0.1:21017/v1/sessions/test-001 \
  -H "Authorization: Bearer test-secret-key"

# 删除会话
curl -X DELETE http://127.0.0.1:21017/v1/sessions/test-001 \
  -H "Authorization: Bearer test-secret-key"
```

### OpenAPI Spec

```bash
curl http://127.0.0.1:21017/v1/openapi.json | jq .
```

## 自动化测试

### 单元测试

（2026-10-24 实测：**52 文件 1044 用例，1042 passed / 2 skipped / 0 failed**；
§7.107 同步修复了 10 个既有失败——9 个 intent-router + 1 个 input-guard，
均为「默认本地」翻转后测试未更新的遗留）

```bash
pnpm test        # Windows 上 npm run test 同效
```

覆盖 52 个测试文件，包括：

- 插件形状验证（name/inject/Config/apply）
- SSE 解析、JSONL 持久化、HTTP 路由
- 意图分类（LLM + 规则兜底 + §7.107 gate + 结果缓存）
- 会话管理、审计日志、存储层（append 模式 / 队列防中毒）
- input-guard 全 hook（脱敏降级 / 实体护栏 / 孤儿 tool-call 恢复）

### 构建验证

```bash
pnpm run verify:build
```

包含 11 个验证脚本（2026-10-24 全过）：

| 门禁 | 检查内容 |
|---|---|
| `verify:boundary` | 适配器边界（`@deepseek-ai/*` 仅存在于 `src/dsh-adapter/`） |
| `verify:contract` | 上游兼容性（最低 `0.2.1-rc.2`，跟随最新 RC） |
| `verify:patch-surface` / `verify:patch-row-shape` | 补丁面一致性 + 行形状 |
| `verify:plugin-spec` | 插件规范（name+inject+Config+apply） |
| `verify:env-bridge` | env 桥接契约两半一致 |
| `verify:bundle-mount` / `verify:installable` ×2 | bundle 挂载 + 可安装产物 |
| `verify:host-mount` / `verify:client-mount` | 宿主/客户端半体挂载模拟 |

### Lint

```bash
pnpm run lint    # 2026-10-24 起进 CI（error 级门禁，0 error 基线）
```
