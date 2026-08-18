# M5 测试指南

## 快速开始

### 一键测试（推荐）

```bash
cd /home/etsme/cy/agent/dsh-edge-agent

# 使用 mock provider（无需 API key）
./scripts/m5-e2e-test.sh

# 使用 cloud provider（需要 DEEPSEEK_API_KEY）
DEEPSEEK_API_KEY=your-key-here \
DSH_EDGE_PROVIDER=cloud-deepseek-v4 \
./scripts/m5-e2e-test.sh

# 保持服务器运行（手动测试）
KEEP_SERVER_RUNNING=true ./scripts/m5-e2e-test.sh
```

### 手动测试

#### 1. 安装 dsh

```bash
npm install -g @deepseek-ai/dsh
```

#### 2. 启动服务器

```bash
cd /home/etsme/cy/agent/dsh-edge-agent
npm run compile

export EDGE_API_KEY=test-secret-key
export DSH_EDGE_PROVIDER=local-qwen3-4b-mock

# 启动（不传 task，保持运行）
dsh --profile dsh-edge-agent &
```

#### 3. 测试端点

```bash
# 健康检查
curl http://127.0.0.1:3080/v1/health

# 同步聊天
curl -X POST http://127.0.0.1:3080/v1/chat \
  -H "Authorization: Bearer $EDGE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"message":"你好"}'

# SSE 流式
curl -N -X POST http://127.0.0.1:3080/v1/chat/stream \
  -H "Authorization: Bearer $EDGE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"message":"讲个笑话"}'
```

## 测试脚本说明

### m5-e2e-test.sh

完整的端到端测试脚本，包含：

- ✅ 前置条件检查（dsh、curl、jq）
- ✅ 自动构建项目
- ✅ 启动 dsh 服务器
- ✅ 测试所有端点（13 个测试）
- ✅ 自动清理
- ✅ 彩色输出
- ✅ 错误处理

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DSH_EDGE_PROVIDER` | `local-qwen3-4b-mock` | LLM provider |
| `DSH_EDGE_HTTP_PORT` | `3080` | HTTP 端口 |
| `EDGE_API_KEY` | `test-secret-key` | API 密钥 |
| `DEEPSEEK_API_KEY` | - | DeepSeek API key (cloud) |
| `KEEP_SERVER_RUNNING` | `false` | 测试后保持运行 |
| `SKIP_DSH_INSTALL` | `false` | 跳过安装检查 |

### 测试覆盖

1. **公开端点**
   - GET /v1/health
   - GET /v1/openapi.json

2. **鉴权**
   - 无 token → 401
   - 错误 token → 401
   - 正确 token → 200

3. **会话管理**
   - GET /v1/sessions
   - GET /v1/sessions/:id
   - DELETE /v1/sessions/:id

4. **聊天**
   - POST /v1/chat（同步）
   - POST /v1/chat/stream（SSE）

5. **会话复用**
   - 创建会话
   - 复用会话继续对话
   - 删除会话

## 故障排查

### 问题：dsh 命令未找到

```bash
# 安装 dsh
npm install -g @deepseek-ai/dsh

# 或从源码运行
cd /home/etsme/cy/agent/deepseek-harness
pnpm install
pnpm run build
export PATH="$PWD/packages/examples/agent-spine-demo/bin:$PATH"
```

### 问题：端口被占用

```bash
# 使用其他端口
DSH_EDGE_HTTP_PORT=3081 ./scripts/m5-e2e-test.sh

# 或杀掉占用进程
lsof -ti:3080 | xargs kill -9
```

### 问题：服务器启动失败

查看日志：

```bash
tail -f /tmp/dsh-m5-test.log
```

常见原因：
- LLM provider 配置错误
- 缺少 API key
- 本地 LLM 服务未启动

### 问题：SSE 流无数据

- 检查 agent 是否在生成响应
- 查看日志中的 `session/event` 事件
- 确认 LLM provider 正常工作

## 单元测试

```bash
cd /home/etsme/cy/agent/dsh-edge-agent
npx vitest run tests/unit/http-api.test.ts
```

## 验证脚本

轻量级验证（不包含构建和服务器启动）：

```bash
# 先手动启动服务器
dsh --profile dsh-edge-agent &

# 然后运行验证
EDGE_API_KEY=test-secret-key \
node --import tsx/esm scripts/m5-verify.ts
```

## CI/CD 集成

```yaml
# .github/workflows/m5-test.yml
name: M5 E2E Test

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - uses: actions/setup-node@v3
        with:
          node-version: '22'

      - name: Install dsh
        run: npm install -g @deepseek-ai/dsh

      - name: Build
        run: npm run compile

      - name: Run M5 tests
        run: ./scripts/m5-e2e-test.sh
        env:
          EDGE_API_KEY: test-key
          DSH_EDGE_PROVIDER: local-qwen3-4b-mock
```
