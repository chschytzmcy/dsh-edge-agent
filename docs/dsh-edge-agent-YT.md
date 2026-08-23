# dsh-edge-agent 意图识别路由（intent-router）原理

> 整理自 dsh-edge-agent-design-v6 讨论结论

## 实现状态（2026-08-23 校准）

本文档与 `main` 分支实现的**逐项匹配度约 35-40%**。下面列出每节实现状态，**实现以代码为准**，本文档保留为设计愿景参考。

**说明**：✅ = 已实现 · ⚠ = 简化（机制不同但目标相近）· ❌ = 未实现（保留为后续阶段目标）

| 节 | 状态 | 备注 |
|---|---|---|
| 一句话概括 | ⚠ | 安检 + 分流思想成立，但实装是**命令式直调**而非事件协议 |
| 核心问题：为什么需要意图路由 | ✅ | Realm 路由思想正确实现 |
| 三层分类机制（规则→模型→置信度）| ❌ | 实装是**LLM-first → rules fallback**，顺序反了 |
| 4 类 category（LOCAL/CLOUD/SANITIZED/REJECT）| ⚠ | REJECT 缺失（与 prompt-guard unsafe 重叠）；SANITIZED 从 category 降级为 boolean flag |
| 第1层 prompt-guard 安全检查 | ✅ | http-api.ts:228-245 实现，6 道闸（长度/限流×2/正则/PII/LLM） |
| prompt-guard 配置 schema（inputRules/outputRules + action）| ⚠ | 简化为统一 `rules[]`，无 action 分级（见 Phase C 计划） |
| 第2层规则匹配（含 REJECT 短路）| ❌ | 无 REJECT 规则概念 |
| 第3层 LLM 分类（0.6 fail-closed 阈值）| ⚠ | LLM 路径实现但**无置信度门槛**（见 Phase B 计划）|
| Realm 映射表 | ⚠ | LOCAL/CLOUD 路由成立；SANITIZED 通过 flag 触发而非 category |
| agent/pre-step 事件监听器 | ❌ | 实装是命令式编排，无事件协议 |
| td-bus 联动 | ❌ | td-bus 独立运行未接入主链路（见 Phase D 计划）|
| 4-action 规则体系（block/warn/sanitize/redact）| ⚠ | 仅 high-risk block 一种动作，缺 warn/sanitize 分级（见 Phase C） |
| addInputRule 热更新 | ❌ | 未实现 |
| 完整命运示例 | ⚠ | 顺序与触发机制不同 |

**补齐路径**：详见 `/home/etsme/.claude/plans/serialized-squishing-pike.md` 的 Phase B / C / D。Phase A（本文档校正）已完成；Phase B（intent-router 置信度门槛）+ Phase C（prompt-guard action 分级）+ Phase D（td-bus 主链路接入）正在按计划落地。

---

## 一句话概括

intent-router 是 dsh-edge-agent 的"安检 + 分流"插件：用户每条消息进来，先做安全检查，再按"规则匹配 → 本地小模型分类 → 置信度裁决"三层逻辑，判断这条消息该走本地、云端、还是脱敏后上云——相当于给每句话贴一个"安全标签"再放行。

## 核心问题：为什么需要意图路由

每条消息落在哪个处理域（Realm），直接决定隐私安全：

* 读本地通讯录 → 绝对不能上云 → **LOCAL**
* 查今天天气 → 公开信息可上云 → **CLOUD**
* 查张三的公司 → 涉隐私但需公网 → **SANITIZED**（脱敏后上云）
* 导出数据库 → 危险操作 → **REJECT**（直接拒绝）

路由错了 = 隐私泄漏或安全事故。意图路由是隐私防线的"总开关"。

## 三层分类机制

```
用户输入
  ↓
第1层：安全检查（prompt-guard）
  ├─ unsafe → 直接 REJECT（置信度 0.99）【短路】
  └─ safe → 进第2层
  ↓
第2层：规则匹配（matchByRules，配置驱动正则）
  ├─ 命中 REJECT 规则（0.99 > 0.95）→ 直接 REJECT【短路】
  ├─ 命中其他规则（0.85 ≤ 0.95）→ 进第3层（模型确认）
  └─ 未命中（0.3）→ 进第3层（模型判断）
  ↓
第3层：本地小模型分类（qwen3-4b，终点）
  ├─ 置信度 ≥ 0.6 → 采用该意图
  └─ 置信度 < 0.6 → 强制 REJECT（fail-closed）
```

**设计哲学：能省则省（规则）、拿不准就上模型、还不确定就拒绝。**

## 层间流转规则（关键）

| **层** | **判断结果**     | **置信度**      | **进下一层？** | **去向** |
| ----- | ------------ | ------------ | --------- | ------ |
| 第1层   | unsafe       | —            | ❌ 短路      | REJECT |
| 第1层   | safe         | —            | ✅         | 进第2层   |
| 第2层   | 命中 REJECT 规则 | 0.99 (>0.95) | ❌ 短路      | REJECT |
| 第2层   | 命中其他规则       | 0.85 (≤0.95) | ✅         | 进第3层   |
| 第2层   | 未命中          | 0.3          | ✅         | 进第3层   |
| 第3层   | 模型分类         | ≥0.6         | 终点        | 采用意图   |
| 第3层   | 模型分类         | \<0.6        | 终点        | REJECT |

> 每层"通过"的含义不同：第1层通过 = 确认安全；第2层通过 = 规则没把握、交给模型；第3层通过 = 最终裁决。第2层进第3层不是"被放行"，而是"判断力不足、向上求助"。

## 第1层：prompt-guard 安全检查

### 规则形态：配置驱动的正则表（cordis.yml）

```yaml
prompt-guard:
  inputRules:
    - id: "ignore-previous"
      pattern: "(忽略|无视|忘记).*(之前|上面).*(指令|规则|提示)"
      action: "block"        # 阻止忽略指令攻击
    - id: "system-prompt-extract"
      pattern: "(输出|显示|打印).*(系统|system).*(提示|prompt|指令)"
      action: "block"        # 阻止提取系统提示词
    - id: "role-override"
      pattern: "你现在(是|扮演|假装是)"
      action: "warn"         # 角色覆盖尝试（只警告）
    - id: "data-exfil-instruction"
      pattern: "(把|将).*(数据|信息|内容).*(发送|传输|上传)到"
      action: "block"        # 阻止数据外传指令
  outputRules:
    - id: "phone-leak"
      pattern: "(?<!\d)1[3-9]\d{9}(?!\d)"
      action: "redact"       # 输出手机号打码
    - id: "id-card-leak"
      pattern: "(?<!\d)[1-9]\d{5}(18|19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)"
      action: "redact"       # 输出身份证号打码
  enableModelDetection: true     # 是否启用模型辅助检测
  modelDetectionName: qwen3-4b
```

### 三种 action

| **action** | **输入场景** | **输出场景** | **含义**   |
| ---------- | -------- | -------- | -------- |
| block      | ✅        | —        | 拦截（严重度高） |
| warn       | ✅        | ✅        | 放行但记录    |
| sanitize   | ✅        | —        | 改写文本后放行  |
| redact     | —        | ✅        | 输出打码     |

### checkInput 执行逻辑（三道检查）

```
① 正则规则匹配（主力，毫秒级）：遍历 inputRules，RegExp.test()
② 模型辅助检测（兜底，可开关）：本地 qwen3-4b 语义级注入判断
③ privacy-policy 联动：classifyData 判为 secret 级（姓名/身份证/手机号等）→ 直接 block
决策：有 block → 拦截 + 记审计 input-blocked
      只有 warn → 放行但记录
      全过 → 放行
```

### 关键点

* 规则不是代码硬编码，是 cordis.yml 配置，可动态 addInputRule 扩展
* 模型辅助检测也用本地小模型（分类/检查请求本身含隐私，不能上云）
* 不只防攻击，还防隐私数据出端（secret 级一票否决）

## Realm 映射（意图 → 处理域）

| **category** | **targetRealm** | **路由到**                       | **数据去向**      |
| ------------ | --------------- | ----------------------------- | ------------- |
| LOCAL        | local           | local-llm-provider            | 不出端           |
| CLOUD        | cloud           | cloud-llm-provider            | 上云（公开）        |
| SANITIZED    | sanitized       | sanitizer-pipeline 脱敏 → cloud | 脱敏后上云，云端只见占位符 |
| REJECT       | —               | 不路由，直接拒绝                      | 不动            |

## agent/pre-step 事件拦截（intent-router 监听器）

```typescript
ctx.event.on('agent/pre-step', async (payload) => {
  // ① 威胁等级检查（td-bus）
  const threat = await ctx['td-bus'].getThreatLevel()
  if (threat === 'critical') return { kind: 'reject', reason: 'threat' }

  // ② 输入安全检查（prompt-guard）
  const safe = await ctx['prompt-guard'].checkInput(payload.input)
  if (!safe.safe) return { kind: 'reject', reason: safe.reason }

  // ③ 意图分类（三层机制）
  const intent = await this.classify(payload.input, payload.context)
  payload.intent = intent

  // ④ 脱敏标记
  if (intent.category === 'SANITIZED') {
    payload.requiresSanitization = true
  }

  return { kind: 'enter' }   // 返回决策对象，不 throw
})
```

## 一条消息的完整命运（示例）

用户："帮我查一下张三的公司信息"

```
① agent/pre-step
   威胁检查 → 正常；注入检查 → 安全
   classify：规则命中 "查.*公司" → SANITIZED(0.85) → 本地模型确认(0.92) → 采用
   payload.intent = { category: 'SANITIZED', confidence: 0.92 }
   payload.requiresSanitization = true

② agent/request：Realm 校验，SANITIZED 允许走云端（必须脱敏）

③ sanitizer-pipeline.sanitize("张三") → "[用户A]"

④ LLM：model-router 选云端模型 → OHTTP 加密上云 → 云端只见 "[用户A]"

⑤ 响应回来：desanitize("[用户A]") → "张三" → 用户看到完整答案
```

## 设计要点总结

| **设计**      | **为什么**                   |
| ----------- | ------------------------- |
| 规则先行，模型兜底   | 规则命中零成本，模型分类 \<1s         |
| 分类用本地模型     | 分类请求本身含隐私，不能上云（防分类泄漏）     |
| 置信度阈值 0.6   | fail-closed：不确定就当危险       |
| 规则外置可热更新    | policy.json 改即生效，不改代码     |
| REJECT 优先   | 安全规则（0.99）直接生效，不给模型翻案机会   |
| 结果挂 payload | intent 是"通行证上的印章"，后续关卡都读它 |

## 结论

intent-router 原理 = "安检 + 三层分流"：prompt-guard 先一票否决危险输入；规则匹配（外置可热更新正则）快速给出方向，REJECT 规则直接生效，其他规则交本地 qwen3-4b 小模型确认（分类请求本身不上云防泄漏）；置信度不足 0.6 一律 REJECT。分类结果作为"安全标签"写在 payload 上，决定消息走 LOCAL / CLOUD / SANITIZED，后续 Realm 校验、模型路由、脱敏管线全部按标签执行。每一环都是 fail-closed，隐私安全靠"不确定就拒绝"兜底。
