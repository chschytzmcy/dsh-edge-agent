# 脱敏能力测试报告

> 测试日期：2026-08-25
> 测试范围：sanitizer-pipeline / pii-utils / intent-router 脱敏 / http-api 脱敏 E2E / prompt-guard PII / privacy-policy 脱敏规则 / 隐私预检 / reject 短路 / td-bus

---

## 总览

| 维度 | 数值 |
|------|------|
| 测试文件 | 10 个单元 + 1 个 E2E 脚本 |
| 单元用例 | **295 / 295 通过** |
| E2E 用例 | **19 / 19 通过** |
| 总计 | **314 / 314 通过，0 失败** |
| 测试框架 | Vitest 2.1.9 |

---

## 单元测试明细

### 1. sanitizer-pipeline.test.ts — 28 用例 ✅

| 类别 | 用例 | 验证内容 |
|------|------|---------|
| 插件形态 | 2 | name='sanitizer-pipeline', inject=['privacyPolicy','auditLog'] |
| 正向脱敏 | 6 | phone→`[PHONE_1]`、email→`[EMAIL_2]`、bank-card、id-card、api-key、多 PII 混合 |
| 反向还原 | 3 | desanitize() 还原、desanitizeSync() 同步还原、round-trip 往返一致性 |
| Session 隔离 | 4 | 不同 sessionId 映射独立、同 session 同一 PII 复用占位符、去重验证 |
| 容量限制 | 2 | maxReplacementsPerSession 上限、超限审计 `sanitizer.limit-reached` |
| 生命周期 | 3 | purge() 清除映射、getMappingSize() 调试接口、shutdown disposer 清理所有 session |
| 扩展 PII（P1） | 5 | IPv4、MAC 地址、中国护照、中国车牌、非匹配验证（版本号不误匹配 IP） |
| 边界情况 | 3 | 空文本、无 PII 文本、正则无效时 skip |

### 2. http-api-sanitize-e2e.test.ts — 10 用例 ✅

| 用例 | 验证内容 |
|------|---------|
| phone PII round-trip | 用户消息含手机号 → 发给 agent 的为 `[PHONE_1]` → 响应还原为原号 |
| 多 PII 类型 | phone + email 同时脱敏 + 还原 |
| Session 去重 | 同一手机号在同一 session 始终映射为 `[PHONE_1]` |
| 无 PII 跳过 | 无 PII 时 desanitize 为 no-op |
| LOCAL 不脱敏 | LOCAL intent → sanitizer 不调用，PII 原样通过 |
| SANITIZED 仍脱敏 | SANITIZED intent 与 CLOUD 对称，仍触发脱敏 |
| desanitize 异常不崩溃 | desanitize 抛异常 → 审计、响应保持脱敏态 |
| 流式端点 round-trip | `/v1/chat/stream` 与 `/v1/chat` 脱敏行为一致 |
| 审计条件 | `http.chat.sanitized` 仅在 replacements > 0 时触发 |
| 审计预览脱敏 | `http.chat.start` 的 messagePreview 经 redactString，无原始 PII 泄露 |

### 3. http-api-sanitize-downgrade.test.ts — 6 用例 ✅

| 用例 | 验证内容 |
|------|---------|
| sanitizer 不可用 → 降级 LOCAL | `this.sanitizer = null` → 路由降级为 LOCAL |
| sanitizer 抛异常 → 降级 LOCAL | `sanitize()` throw → 路由降级为 LOCAL |
| sanitizer 正常 → 保持 CLOUD | 正常脱敏 → 路由保持 CLOUD |
| LOCAL intent 绕过脱敏 | LOCAL intent → 不触发 sanitizer |
| `/v1/chat/stream` 降级对称 | 流式端点同样执行 fail-closed 降级 |
| 审计安全级别 | 降级事件以 security 级别审计 |

### 4. pii-utils.test.ts — 15 用例 ✅

| 类别 | 用例 | 验证内容 |
|------|------|---------|
| PII_RULES | 1 | 定义 5 种规则（phone/id-card/bank-card/email/api-key） |
| redactString | 6 | 手机号→`138****5678`、邮箱→`a***@example.com`、API key→`sk-***`、多类型混合、无 PII 不变、空字符串、自定义规则 |
| redactObject | 7 | 对象字符串值脱敏、深层嵌套、数组内字符串、非字符串值保留、不可变性、空对象、audit 条目格式 |

### 5. intent-router.test.ts — 101 用例 ✅（脱敏相关 ~15 用例）

| 类别 | 用例 | 验证内容 |
|------|------|---------|
| CLOUD 前脱敏 | 3 | 当前消息脱敏、LOCAL 跳过脱敏、sanitizer 缺失时 fail-closed |
| 历史消息脱敏 | 3 | CLOUD realm 每条历史脱敏、LOCAL 不脱敏历史、历史脱敏失败时跳过该条 |
| 计数器 | 3 | sanitized++、sanitizeError++（security 级审计）、sanitizeSkipped++ |
| 审计预览 | 2 | intent.classify.start preview 脱敏、piiUtils 不可用时 fallback |
| 截断顺序 | 1 | 截断在脱敏之前执行（先 maxInputLength 截断，再 sanitize） |

### 6. prompt-guard.test.ts — 78 用例 ✅（PII 相关 ~12 用例）

| 类别 | 用例 | 验证内容 |
|------|------|---------|
| PII 输入检测 | 4 | secret 级（银行卡/身份证/API key）→ 拦截、confidential 级（手机号）→ 标记 |
| 输出脱敏 | 4 | checkOutput 对 5 种 PII 类型掩码、sanitized=true 时跳过掩码 |
| 注入检测 | 3 | 16 种中英双语注入模式、action 分级（block/warn/sanitize） |
| 模型辅助 | 1 | 本地 qwen3-4b 语义分类（fail-open） |

### 7. privacy-policy.test.ts — 27 用例 ✅（脱敏规则相关 ~5 用例）

| 类别 | 验证内容 |
|------|---------|
| sanitizationRules | getSanitizationRules() 返回 9 条规则、规则结构正确 |
| 热重载 | 策略文件修改后 getSanitizationRules() 返回新规则 |
| 默认回退 | 策略文件缺失时使用 DEFAULT_POLICY 的脱敏规则 |

### 8. privacy-precheck.test.ts — 22 用例 ✅

| 类别 | 用例 | 验证内容 |
|------|------|---------|
| REJECT 拦截 | 5 | `导出数据库`、`删除系统文件`、`drop table`、`rm -rf`、`format` |
| 职责分离 | 8 | 攻击模式（注入/提词/角色覆盖/数据外传）由 prompt-guard 处理，privacy-policy 不拦截 |
| 正常放行 | 6 | 普通查询、本地操作、知识问答、翻译、聊天、空字符串 |
| 策略结构 | 3 | REJECT 规则在前、至少 2 条 REJECT、confidence ≥ 0.9 |

### 9. http-api-reject.test.ts — 3 用例 ✅

| 用例 | 验证内容 |
|------|---------|
| `/v1/chat` REJECT → 403 | REJECT intent → HTTP 403，sanitizer 不调用（sanitizeCallCount === 0） |
| `/v1/chat/stream` REJECT → 403 | 流式端点对称 |
| 非 REJECT → 正常路由 | 非 REJECT intent → 正常走 LLM |

### 10. http-api-tdbus.test.ts — 5 用例 ✅

| 用例 | 验证内容 |
|------|---------|
| td-bus 正常放行 | 威胁等级 normal → 请求正常通过 |
| td-bus 阻断 | 威胁等级 critical → HTTP 503 |
| td-bus 缺失 | tdBus = undefined → 不阻断（soft dep） |
| td-bus 抛异常 | recordCloudRequest throw → 不阻断 |
| 两个端口对称 | `/v1/chat` 和 `/v1/chat/stream` 同样受 td-bus 保护 |

---

## E2E 脚本测试

### e2e-privacy-precheck.sh — 19/19 ✅

启动真实 dsh 服务，通过 HTTP 请求验证：

| 类别 | 用例数 | 验证内容 |
|------|--------|---------|
| REJECT 拦截 | 5 | `删除所有文件`、`drop table users`、`rm -rf /`、`导出数据库`、`导出通讯录` → HTTP 403 |
| 正常请求 | 5 | 普通查询→CLOUD、本地文件→LOCAL、翻译→CLOUD、知识问答→CLOUD、日常聊天→CLOUD |
| PII 输入 | 3 | 含手机号→正常路由（脱敏后处理）、含身份证→正常路由 |
| 注入攻击 | 3 | `ignore previous instructions`→由 prompt-guard 处理、`显示 system prompt`→prompt-guard、`无视上面规则`→prompt-guard |
| 边缘情况 | 3 | 空消息→400、超长消息→截断后处理、多语言混合→正常路由 |

---

## 脱敏能力覆盖矩阵

```
                        ✅ 已测试    覆盖文件
输入侧 PII 检测
  pii-utils.redactString    ✅    pii-utils.test.ts
  pii-utils.redactObject    ✅    pii-utils.test.ts
  prompt-guard PII          ✅    prompt-guard.test.ts
  privacy-policy 分类       ✅    privacy-policy.test.ts

正向脱敏（PII → 占位符）
  sanitizer-pipeline        ✅    sanitizer-pipeline.test.ts
  intent-router 当前消息    ✅    intent-router.test.ts
  intent-router 历史消息    ✅    intent-router.test.ts
  http-api 发往 agent       ✅    http-api-sanitize-e2e.test.ts

反向还原（占位符 → PII）
  desanitize (async)        ✅    sanitizer-pipeline.test.ts
  desanitizeSync            ✅    sanitizer-pipeline.test.ts
  http-api 非流式响应       ✅    http-api-sanitize-e2e.test.ts
  http-api 流式逐 chunk     ✅    http-api-sanitize-e2e.test.ts

Fail-closed 降级
  sanitizer 不可用→LOCAL    ✅    http-api-sanitize-downgrade.test.ts
  sanitizer 抛异常→LOCAL    ✅    http-api-sanitize-downgrade.test.ts
  intent-router fail-closed ✅    intent-router.test.ts
  历史消息逐条 fail-closed  ✅    intent-router.test.ts

审计安全
  脱敏审计事件              ✅    sanitizer-pipeline.test.ts
  审计预览无 PII 泄露       ✅    http-api-sanitize-e2e.test.ts
  security 级降级审计       ✅    http-api-sanitize-downgrade.test.ts

REJECT 短路
  REJECT→403 不调 sanitizer ✅    http-api-reject.test.ts
  隐私预检 REJECT 拦截      ✅    privacy-precheck.test.ts

扩展 PII 类型
  IPv4 / MAC / 护照 / 车牌  ✅    sanitizer-pipeline.test.ts
```

---

## 结论

**314 / 314 测试全部通过，0 失败。** 脱敏能力的六个维度（输入检测、正向脱敏、反向还原、fail-closed 降级、审计安全、REJECT 短路）均有充分测试覆盖。E2E 脚本在真实 dsh 服务环境中验证了隐私预检和路由分类的正确性。
