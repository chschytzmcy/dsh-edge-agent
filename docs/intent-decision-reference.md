# 意图判定三层决策参考手册（正则 · 决策模型 · LLM）

> **本文档是意图识别（含相关判定流程）三层决策机制的完整清单**——正则的原文、
> 决策模型收到的题目与响应、LLM 收到的 prompt 与判决格式，全部照录。
> 配套设计见 [intent-and-sanitization.md](intent-and-sanitization.md)（§7.107–7.115
> 演进史见 [PROGRESS.md](PROGRESS.md)）。数据与代码对齐于 2026-10-25（policy v1.9.0）。
>
> **执行顺序**（classify() 自上而下，先到先得）：
> REJECT 正则预检 → 缓存 → **决策模型**（jev 阶段，可配）→ **LLM 分类器**（可关）→
> **正则/关键词护栏**（规则层）→ 实体护栏 → 云闸（no-web-need / 语义解锁）→ 默认 LOCAL

## 0. 阈值速查表

| 阈值 | 默认值 | 配置面 | 含义 |
|---|---|---|---|
| jev 采纳门（非 LOCAL） | 0.85 | `jev.confidenceThreshold` | 决策模型置信度低于此 → skip 落 LLM |
| jev 采纳门（LOCAL 方向） | 0.50 | `jev.localAdoptFloor`（§7.115） | LOCAL 是 fail-safe 默认，低门直接采纳不落 LLM |
| jev 风险闸 | 0.70 | `jev.riskThreshold` | riskScore ≥ 此 → 直接 REJECT（riskScore = score/3） |
| LLM 采纳门 | 0.60 | `stages.intent.confidenceThreshold` | LLM 置信度低于此 → 落规则层 |
| 语义解锁门 | 0.75 | `stages.intent.semanticCloudMinConfidence`（§7.109） | LLM/jev 判 CLOUD 且 ≥ 此值 → 无需关键词即可出网 |
| jev 超时 | 6000ms（本地 MLX 实测调优） | `jev.timeoutMs` | 本地 choice+score 解码 2–3.5s；MaaS 47ms |
| LLM 超时 | 4000ms | `stages.intent.timeoutMs` | 本地 qwen/MiniMax 常态 2–4s |

## 1. 第一层：决策模型（`jev.provider: 'bailian-decision'`）

配置文件绑定的**外部 HTTP 服务**（§7.114）——同一契约两个部署皆可：

| 部署 | url | path | 实测延迟 |
|---|---|---|---|
| 百炼 MaaS（`llm-u1paw6uihtedaa2d`） | `https://llm-u1paw6uihtedaa2d.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` | `/systemone` | 43–47ms |
| 本机 MLX serve | `http://127.0.0.1:11017/compatible-mode/v1` | `/systemone` | 489ms（单问）–3.1s（三问） |

```jsonc
// edge.json jev.* 全量配置面
"jev": {
  "enabled": true,
  "provider": "bailian-decision",      // 'local'（ONNX /predict 契约）| 'bailian-decision'
  "url": "…/compatible-mode/v1",
  "path": "/systemone",                // 本地 MLX 同路径（§7.114 起支持 MaaS 原生路径）
  "model": "decision-model-preview",
  "apiKeyRef": "dashscopeApiKey",      // → secrets.*；raw=Authorization: <key>，bearer=Bearer 前缀
  "authScheme": "raw",
  "timeoutMs": 6000,
  "confidenceThreshold": 0.85,
  "localAdoptFloor": 0.5,
  "riskThreshold": 0.7
}
```

### 1.1 题目生成（POST {url}{path}，questions 从 policy `categories` 自动生成）

```jsonc
{
  "model": "decision-model-preview",
  "state": { "session_id": "<sid>", "content": "<用户原文>" },
  "questions": {
    "intent": {
      "type": "choice",
      "instructions": "这个用户请求应该路由到哪个处理域？只选一个最合适的。",
      "criteria": {
        "CLOUD":  "需要检索公网上信息的任务：新闻、天气、行情、搜索引擎，以及旅游攻略、景点推荐、行程规划等需要实时公网信息的任务",
        "REJECT": "高危 / 违法 / 违规请求（危险系统操作、破坏性命令、投诉、法务）"
        // ← categories 里有几行就生成几个 criteria（随 policy 热重载）
      }
    },
    "risk": {
      "type": "score",
      "instructions": "这个请求的危险程度如何？",
      "criteria": ["正常请求，无风险", "轻微可疑，需要留意", "明显危险操作", "高危/违法/破坏性请求"]
    }
  }
}
```

### 1.2 实测响应形状（2026-10-25，token-plan / llm-u1pa 两端点一致）

```jsonc
{
  "model": "decision-model-preview",
  "request_id": "…",
  "answers": {
    "intent": { "type": "choice", "choice": "CLOUD", "confidence": 0.983, "probabilities": { "CLOUD": 0.98, "LOCAL": 0.02 } },
    "risk":   { "type": "score", "score": 0.29, "legend": { "0": "正常请求，无风险", "…": "…" }, "confidence": 0.91 }
  },
  "usage": { "input_tokens": 125 },
  "latency_ms": 47.3
}
```

解析容错四种 envelope：canonical `answers` / DashScope native `output` /
chat-completions `choices[0].message.content`（内嵌 JSON）/ flat。解析失败 → skip 落 LLM。

### 1.3 判决映射与闸门（与本地 jev 语义逐条对齐）

| 步骤 | 规则 |
|---|---|
| 风险闸 | `riskScore = score/3` ≥ 0.70 → **REJECT**（security 审计，HTTP 403） |
| 方向分闸 | choice = LOCAL → 置信度 ≥ **0.50** 采纳；choice = 非 LOCAL → 置信度 ≥ **0.85** 才采纳（§7.115） |
| 幻觉防御 | choice 不在 categories 的 id 集合 → skip 落 LLM |
| 断路器 | 调用失败/超时 → 开 30s（TTL）；成功即关。MaaS 无 /health → 探针按 path 跳过；本地 MLX 有 /health → 探针恢复 |
| rationale | `jev-intent:<类别>`（Edge tab Intent 面板以此为采纳标记） |

实测能力：15 条金标 **93% 准确**（唯一误判被置信度门 + 实体护栏双层吸收）；
置信度自校准（清晰样本 0.89–1.0，模糊样本自报 0.60）。

## 2. 第二层：LLM 分类器（`stages.intent.llmFallback` 未关时）

配置：`classificationProvider`（默认 `local-llm` = MiniMax 本地路由，2–4s）+
`classificationModel`（跟随 `llm.local.model`）。

### 2.1 实际收到的 prompt（模板 + v1.9.0 类别行原文）

```text
判断以下用户请求属于哪类：
- CLOUD：需要检索公网上信息的任务：新闻、天气、行情、搜索引擎，以及旅游攻略、景点推荐、行程规划等需要实时公网信息的任务
- REJECT：高危 / 违法 / 违规请求（危险系统操作、破坏性命令、投诉、法务）
- LOCAL：其余一切请求（本地操作、日常问答等——这是默认类别，拿不准就选它）
[最近对话上下文（仅参考，不要分类历史消息本身）——CLOUD 轮次逐条先脱敏]

Respond ONLY with a single JSON object — no prose, no Markdown:
{ "category": CLOUD|REJECT|LOCAL, "confidence": <0.0-1.0> }

confidence 含义：
- 1.0 = 非常确定（请求明确属于该类别，无歧义）
- 0.7 = 较确定（请求大概率属于该类别，但有少许模糊）
- 0.5 = 不确定（请求模糊，可能是 LOCAL 也可能是 CLOUD）
- <0.5 = 完全不确定（无法判断类别）

用户请求：<用户原文（≤2000 字截断）>
```

说明：policy `categories` 只有 CLOUD/REJECT 两行（§7.110 默认本地）→ LOCAL 行由
代码自动补；`confidence` 的四档标定是给 qwen 类小模型的（否则恒答 0.98）。
parser 接受 LOCAL/CLOUD/SANITIZED/REJECT 全 4 值（SANITIZED 按 CLOUD 脱敏语义处理）。

### 2.2 判决后处理链（顺序固定）

1. **采纳门**：confidence ≥ 0.60，否则落规则层；
2. **实体护栏**：`密盒|ets|etscli` 在任何非 LOCAL 判决上强制压回 LOCAL（`override-local-entity:<词>`）；
3. **云闸（§7.107/§7.109）**：CLOUD 判决需满足其一才放行出网——
   a. **语义解锁**：confidence ≥ 0.75（`semanticCloudMinConfidence`，操作者对分类器的信任声明）；
   b. **关键词信号**：文本命中云关键词表（§3.2）；
   c. 调用方显式路由（`agent._edgeRoute`）。
   都不满足 → `no-web-need` 压回 LOCAL（审计 `intent.cloud.blocked-no-web-need`；
   语义放行审计 `intent.cloud.semantic-unlock`）。

## 3. 第三层：正则 / 关键词（护栏 + 零成本快路径）

### 3.1 policy 路由规则（`config/privacy-policy.json` routingRules，RegExp+i 逐条 test，首中即停，REJECT 优先）

```js
// REJECT —— 直接拒绝（classify 预检 + 规则层双覆盖）
"(导出|删除|清空|格式化).*(数据库|系统|磁盘|全部数据)"
"(drop\\s+table|rm\\s+-rf|format\\s+[a-z]:|del\\s+/[fs])"
// LOCAL —— 含 PII/本地操作的轮次不出设备（出错方向安全）
"(本地|local|文件|file|计算|calculate|读取|写入)"
"(密码|password|secret|密钥|private.?key|token)"
"(身份证号|id.?card|银行卡|bank.?card|信用卡|credit.?card)"
"(手机号|电话号码|手机.{0,5}号|phone.?number|mobile.?number)"
"(邮箱|电邮|email.?address|e-?mail)"
"(IP\\s*地址|服务器.{0,8}(IP|地址)|server\\s+IP|局域网.{0,8}(IP|地址))"
"(家庭住址|住址|home\\s+address|通信地址)"
// CLOUD —— 唯一保留的联网类正则（分类器不可用时的零成本快路径）
"(联网|上网|网上查|搜索引擎|搜索一下网上|web search|search the web|look up online|weather forecast|天气预报|实时行情|股价|汇率|current price)"
```

### 3.2 内置 CLOUD 关键词表（`cloudSignal`，小写化子串匹配；规则层与云闸共用）

```
中文（13）：新闻 最新 实时 热搜 趋势 排行榜 资讯 网上 互联网 在线 联网 天气 股价
英文（12）：news latest live trending ranking online internet "web search" web weather forecast price
可扩展面：edge.json stages.intent.cloudKeywords（追加，§7.108）；
         policy 文件 stages.intent.cloudKeywords（追加，热重载，默认空——
         §7.109 裁决：领域扩展交给语义层，正则子串易误命中）
```

### 3.3 LOCAL 兜底关键词表（仅 policy 缺失时启用；policy `stages.intent.fallbackKeywords` 非空则整体替换）

```
中文（13）：文件 读 写 删除 创建 计算 加减乘除 本地 设备 系统 磁盘 目录 文件夹
英文（11）：file read write delete calculate compute local device disk directory folder
rationale 格式：rule-keyword-match:<词>（§7.113 起携带命中词）
```

### 3.4 LOCAL 实体护栏（任何非 LOCAL 判决上强制压回；CJK 子串 / ASCII 词边界）

```
密盒  ets  etscli
可扩展面：stages.intent.localEntities / env DSH_EDGE_INTENT_LOCAL_ENTITIES（追加）
rationale 格式：override-local-entity:<词>
```

### 3.5 匹配语义

- 路由规则：`new RegExp(pattern, 'i').test(text)`，首中即停；
- 关键词表：`text.toLowerCase().includes(keyword.toLowerCase())`（**子串**——英文词
  也会命中子串，`web` 会进 webinar，这是 §7.109 把领域词撤出正则的原因）；
- 实体表：CJK 子串；ASCII 要求非字母数字边界（`ets` 不进 `assets`）。

## 4. 相邻判定流程的正则清单（同一份清单的延伸）

### 4.1 输入注入检测（prompt-guard，26 条，block=拦截 / warn=放行但审计）

<details><summary>全部 26 条模式（点击展开）</summary>

```js
// 直接注入（block）
ignore\s+(all\s+)?previous\s+instructions
忽略\s*(之前|上面|以上)\s*(的)?\s*(指令|指示|命令)
disregard\s+(all\s+)?(prior|previous|above)\s+(instructions|rules)
// Prompt 泄漏（block）
show\s+me\s+(your\s+)?system\s+prompt
(repeat|output|print|display)\s+(your|the|my)\s+(system\s+)?(prompt|instructions|rules|configuration)
(输出|显示|打印|告诉|说说)\s*(?:我|你)?(?:的)?\s*(你的|我的)?\s*(系统|初始)?\s*(提示词|指令|配置|prompt)
// 角色覆盖（warn —— 教育场景常见，非攻击）
you\s+are\s+now\s+(a|an)\s+    act\s+as\s+(a|an|if)\s+    pretend\s+(to\s+be|you(?:'re|\s+are))\s+
你(现在|立即)?\s*(是|变成|扮演|充当)\s*(一个|一名)?      假设\s*(你|你是|你是一?个)      从现在开始\s*(你|你就是|请你)
// 越狱/绕过/外传（block）
DAN\s*(mode|jailbreak|do\s+anything\s+now)
(无限制|不受限|越狱|解除限制|开发者模式)      (开发者模式|调试模式|diagnostic\s+mode)
(发送|上传|传输|外发).*(外部|外网|外部服务器|第三方)
// §7.63 中文变体十条（三件套防误报：攻击动词+限定词+紧名词类；block）
(?:忽略|无视|不遵守|不要遵守|不必遵守|不理会|不执行)\s*(?:(?:我的|你的|所有|全部|任何|每一条|每一个|以上|之前|以下|这些|那些|上述|上面|这条|那些)的?\s*){1,2}(?:指令|规则|约束|命令|限制)
(?:所有|全部|任何|每一条|每一个)\s*(?:指令|规则|约束|命令|限制)\s*(?:都|全部|统统)?\s*(?:忽略|无视|不遵守|作废|无效|废除|不要遵守|无需遵守|不理会)
(?:在(?:以下|接下来|之后|下面)的?(?:对话|回答|回复|会话|互动)中|从现在开始|从这一刻起).*?(?:忽略|无视|忘记|不遵守|不要遵守|跳过|作废|取消).*?(?:指令|规则|约束|限制|之前|上面|以上)
(?:(?:不要遵守|不必遵守|打破|违反|无视|忽略|废除|取消|作废).*?你的\s*(?:指令|规则|限制|约束|原则|设定))|(?:你的\s*(?:指令|规则|限制|约束|原则|设定).*?(?:不要遵守|不必遵守|打破|违反|无视|忽略|废除|取消|作废))
(?:没有任何|没有任何的|不存在|取消|去掉|关掉|删除|移除)\s*(?:所有|全部|我的|你的|这些|那些)?\s*(?:限制|约束|审查|过滤|安全规则)
(?:告诉我|说出|念出|念一下|列出|显示|给我看|给我|展示|把|将).*?你的\s*(?:规则|指令|限制|约束|原则|设定)
(?:把|给我看|给我|展示|显示|念出|输出|打印).*?(?:你的|系统的)?\s*(?:系统)?\s*(?:提示(?:词|语)|prompt)
(?:把|将)?(?:上面|之前|以下|之前说过的|前面|先前|以上|前文|刚才)的?(?:对话|回复|回答|历史|内容|消息|消息记录).*?(?:复制|粘贴|写下来|写出来|打出来|显示|打印|输出|发给我|贴出来|给我看)
// 弱化覆盖 + 身份警告（warn）
(?:违反|打破|跳过|绕过|回避|破坏)\s*(?:这条|那|这些|那些|所有|全部|任何|我的|你的|我们)?\s*(?:规则|约束|限制|要求|原则|设定)
(?:你是|你(?:就是)?是)\s*(?:一个|一名|只是|已经是)?\s*(?:没有(?:限制|规则|约束|审查|过滤)|不受(?:限制|约束)|无法(?:拒绝|限制))
```

</details>

语义补充层（Stage 6 模型辅助检测，`DSH_EDGE_GUARD_MODEL` 默认关）：system prompt
检测两类问题——SEMANTIC ATTACK PATTERNS（指令覆盖/越狱/提示词泄漏/数据外传/混淆
payload）+ DANGEROUS CONTENT（武器/暴力/违法/自残/未成年人）。本机 MLX 决策模型
是现成的本地端点候选（§7.115 后的下一个可迁移项）。

### 4.2 PII 识别（pii-utils `PII_PATTERNS`，脱敏/还原唯一事实源，10 类）

```js
'\\b[1-9]\\d{5}(?:19|20)\\d{2}(?:0[1-9]|[12]\\d|3[01])\\d{3}[\\dXx]\\b'   // 身份证（secret）
'\\b\\d{16,19}\\b'                                                        // 银行卡（secret）
'\\b1[3-9]\\d{9}\\b'                                                      // 手机号（confidential，keepPrefix 7）
'[\\w.-]+@[\\w.-]+\\.\\w+'                                                // 邮箱（confidential）
'(?:sk-(?:proj-|ant-|live-|test-|org-)?[a-zA-Z0-9]{20,}|key-[a-zA-Z0-9]{16,}|api[_-]?key[_-]?[a-zA-Z0-9]{16,})'  // API key（secret）
'(?:密码|口令|用户名|账号|账户|passwd|password|pwd|username|account|secret|access[ _-]?token|token|api[ _-]?key)["\\' 　]{0,2}(?:[:：=]|是|为|\\s+is\\s+)["\\' 　]?[^\\s"\\'，,;；<>（）()]{3,64}'  // 标签式凭据（secret）
'(?<![vV\\d.])(?:(?:25[0-5]|2[0-4]\\d|1\\d{2}|[1-9]?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|1\\d{2}|[1-9]?\\d)(?!\\.?\\d)'  // IP（confidential）
'(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}'                                 // MAC（confidential）
'\\b(?:E[0-9A-Z]\\d{7}|G\\d{8})\\b'                                       // 护照（secret）
'[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤川青藏琼][A-Z][A-HJ-NP-Z0-9]{5}'  // 车牌（confidential）
```

自由文本 PII（住址/人名/口述凭据）是正则的永久盲区——决策模型的潜在补充层（§7.112 探索项）。

## 5. Edge tab 呈现（§7.113）

`intent.classify.end` 行携带两个证据标量（safePayload 直传 + PII 扫描）：

- **`keyword`** —— 正则命中词：从 rationale 提取（`rule-cloud-keyword:<词>` /
  `rule-local-entity:<词>` / `override-local-entity:<词>` / `rule-keyword-match:<词>`）；
- **`semantic`** —— 语义那句话：所选类别在 policy `categories` 里的 description 原文
  （决策模型与 LLM 两条路径同格式），截断 60 字。

Intent 面板字段顺序：`category → keyword → semantic → targetRealm → confidence →
rationale → classifier → textLen`。

## 6. 默认值与调整入口速查

| 想调整 | 改哪里 | 热重载 |
|---|---|---|
| 决策模型端点/路径/模型/key | edge.json `jev.{url,path,model,apiKeyRef,authScheme}` | 需重启（apply 期捕获） |
| 决策模型采纳门/风险闸/超时 | edge.json `jev.{confidenceThreshold,riskThreshold,timeoutMs,localAdoptFloor}` | 需重启 |
| LLM 采纳门/超时/分类器路由 | edge.json `stages.intent.{confidenceThreshold,timeoutMs,provider}` | 需重启 |
| 语义解锁门 | edge.json `stages.intent.semanticCloudMinConfidence` | ✅ 热重载 |
| 类别定义/描述/jev 意图标签 | policy `categories[]`（喂 LLM prompt + jev + 决策模型 criteria） | ✅ 热重载 |
| 云关键词/实体/兜底词 | edge.json `stages.intent.{cloudKeywords,localEntities,fallbackKeywords}` / policy 同名段 | ✅ 热重载（关键词面） |
| LLM 兜底开关 | edge.json `stages.intent.llmFallback` | 需重启 |
| 路由正则/脱敏规则 | policy `routingRules` / `sanitizationRules` | ✅ 热重载 |
