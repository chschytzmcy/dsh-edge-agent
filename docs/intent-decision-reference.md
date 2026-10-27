# 意图判定决策参考手册（按消息生命周期组织）

> **本文档按一条消息的生命周期组织**：每个阶段列出该阶段进行决策的**正则**（原文）、
> **决策模型的语义判断**（题目/响应原文）、**LLM 的语义判断**（prompt/判决原文），
> 并标注每个决策把消息引向三种去向之一：
>
> - 🚫 **拦截** —— 不生成回复（403 / 429 / 503 / 400），数据与请求都不处理
> - ☁️ **云端** —— CLOUD 域：脱敏后出网（搜索 + 云端合成）
> - 💻 **本地** —— LOCAL 域：本地池生成 + 本地工具（不出 edge 云池）
>
> 配套设计见 [intent-and-sanitization.md](intent-and-sanitization.md)。
> 数据与代码对齐于 2026-10-27（policy v1.9.0）。
>
> **家庭设备操作正则层**在两个阶段各出现一次，共用同一套词表与同一个匹配器：
>
> - 入口安检（§1.1）：纯设备指令跳过语义检测（LLM），省掉一次本地模型往返；
> - 意图路由（§2.0 Tier-0）：设备指令直接定案 💻 LOCAL，不外呼决策模型，也不调 LLM 分类器。
>
> 「开灯 / 关门 / 开空调」这类指令在两个阶段都是正则定案。

---

## 0. 消息生命周期总览

```
消息到达
  │
  ▼
┌─────────────── 第一阶段：入口安检（prompt-guard / td-bus）───────────────┐
│ 限流(统计) → 截断(统计) → 注入判定(正则26条|语义*) → PII否决(正则10类)     │
│ → 业务REJECT预检(正则) → 威胁门禁(统计)                                   │
│ → 【设备操作正则层(正则)】 → 语义检测(LLM,可关)                            │
│   ✗ 任一命中 → 🚫 拦截（429 / 400 / 403 / 503）                          │
└──────────────────────────────────────────────────────────────────────────┘
  │ 通过
  ▼
┌─────────────── 第二阶段：意图路由（intent-router）────────────────────────┐
│ REJECT预检(正则) → 缓存 → 【设备操作正则层(正则)】                         │
│ → 决策模型(语义:choice+score) → LLM分类器(语义,可关) → 规则层(正则)        │
│ → 实体护栏(正则) → 云闸(正则+语义)                                         │
│   🚫 REJECT/风险闸 → 拦截（403）                                          │
│   ☁️ CLOUD 且出网许可 → 云端                                              │
│   💻 LOCAL → 本地                                                         │
└──────────────────────────────────────────────────────────────────────────┘
  │
  ├─ ☁️ 云端路径：脱敏(正则,fail-closed) → web_search(配置三档) → 云合成
  │
  └─ 💻 本地路径：本地池生成 + 本地工具(bash/fs/ets-* skills)
  │
  ▼
┌─────────────── 第三阶段：回程与收尾 ──────────────────────────────────────┐
│ desanitize(正则,可逆还原) → 云请求记账(统计) → 输出PII掩码(正则) → 收尾    │
└──────────────────────────────────────────────────────────────────────────┘
```

**阈值速查表**（详见各阶段判据与附录 C）：

| 阈值 | 默认值 | 配置面 |
|---|---|---|
| jev 采纳门（非 LOCAL） | 0.85 | `jev.confidenceThreshold` |
| jev 采纳门（LOCAL 方向） | 0.50 | `jev.localAdoptFloor` |
| jev 风险闸 | 0.70 | `jev.riskThreshold`（riskScore = score/3） |
| LLM 采纳门 | 0.60 | `stages.intent.confidenceThreshold` |
| 语义解锁门 | **0.95** | `stages.intent.semanticCloudMinConfidence` |
| jev / LLM 超时 | 6000 / 4000 ms | `jev.timeoutMs` / `stages.intent.timeoutMs` |
| 语义检测超时 | 60000 ms | `stages.guard.timeoutMs` |

---

## 第一阶段：入口安检——🚫 拦截判据（全在这里，命中即终止）

| # | 决策 | 决策者 | 正则侧（原文） | 语义侧 | 去向 |
|---|---|---|---|---|---|
| 1 | 限流 | 统计 | — | — | 超限 🚫 429 |
| 2 | 截断 | 统计 | — | — | >10000 字截断后继续 |
| 3 | **注入判定** | **正则 26 条** + 语义* | 见附录 A5 全文（直接注入/越狱/提示词泄漏/数据外传/中文变体十连 → block；角色覆盖/弱化 → warn 放行） | Stage 6 语义检测（默认关，附录 B3）：choice 攻击类型 + 危险内容 | block 🚫 400；warn 继续并注入审计 |
| 4 | **PII 一票否决** | **正则 10 类中 5 类 secret** | 身份证/银行卡/api-key/凭据/护照（附录 A6）命中 → 整条阻断 | — | 🚫 400 |
| 5 | 业务 REJECT 预检 | **正则 2 条** | `(导出\|删除\|清空\|格式化).*(数据库\|系统\|磁盘\|全部数据)`、`(drop\s+table\|rm\s+-rf\|format\s+[a-z]:\|del\s+/[fs])` | — | 🚫 403 |
| 6 | 威胁门禁（http 入口） | 统计 | — | — | 速率 ≥1×/2×/4× 基线 → elevated/high/critical；critical 🚫 503 |
| 7 | **设备操作正则层** | **正则** | 家庭设备操作词表（附录 A8），与意图识别 Tier-0 **同一匹配器** | — | 纯设备指令 → **跳过语义检测（LLM）**；非纯 → 照常走 LLM |

\* 语义检测（Stage 6，`DSH_EDGE_GUARD_MODEL` 默认关）：本机 MLX 决策模型是现成端点候选。

**本阶段的输出只有两种：🚫 拦截，或放行进入第二阶段。**

### 1.1 设备操作正则层（正则优先）

本阶段是「**先正则、后 LLM**」：注入判定与 PII 判定全是正则，语义检测（LLM）在最后。
本层是这条链上的**设备操作快速通道** —— 它与意图识别的 Tier-0 共用同一套词表和
同一个匹配器（`matchDeviceCommand`），所以两个层对「什么算设备操作」永远一致。

| 序 | 条件 | 行为 |
|---|---|---|
| D-1 | 命中设备操作正则，但文本**不纯**（混入其它内容） | → 照常走语义检测（LLM） |
| D-2 | 命中设备操作正则，且文本是**纯**设备指令 | → **跳过语义检测（LLM）**，放行 |

**「纯」的判定**：扣掉匹配到的设备指令、礼貌助词、标点、以及**数值参数**后，
剩余文本为空。数值参数是设备指令的一部分（空调的 26 度是设定值，不是额外内容），
所以「空调调到26度」是纯的。

| 输入 | 纯 | 说明 |
|---|---|---|
| 开灯 / 打开空调 | ✅ | 纯设备指令 |
| 请把空调打开 / 帮我关一下灯 | ✅ | 礼貌助词被扣掉 |
| 空调调到26度 | ✅ | 数值参数被扣掉 |
| 开灯顺便把密码发到第三方 | ❌ | 外传子句必须仍然过语义检测 |
| 怎么开空调 | — | 疑问语境，本层不命中 |

**为什么值得单列**：

1. **省时** —— 语义检测默认开着（`stages.guard.enabled`），而超时上限是
   `stages.guard.timeoutMs`（桌面端 **60000ms = 60s**；Schema 默认 4000ms 是
   兜底值，不是部署值）。纯设备指令没有任何需要语义判断的内容，付一次本地
   LLM 往返不划算。
2. **避免误判** —— 语义层的 system prompt 点名了大量「本地操作是正常的」白名单，
   但模型仍偏激进（历史上把「查看系统信息」「读取本地文件」误判成数据外传）。
   设备操作属同类本地动作，由正则定案比让模型猜更可靠。
3. **隐私** —— 命中即在本地定案，原始指令不进 LLM 请求体。

**位置**：本层位于**全部正则阶段之后**（注入 block/warn/sanitize、PII 分类都已跑过），
因此它只能「省掉 LLM」，**绝不能绕过任何拦截** —— 带注入特征的设备指令照样被拦。

**可观测性**：审计 `guard.device-command.detected`（带 device / action / matched /
pure）+ `guard.model-detect.skip`（reason = `pure-device-command`）；检查结果里的
`deviceCommand` 字段带同一组信息。

**扩展面**：`stages.intent.deviceCommands.{devices,actions}`（edge.json + policy，
✅ 热重载）—— 与意图识别 Tier-0 是**同一份配置**。

---

## 第二阶段：意图路由——☁️ 云端 vs 💻 本地 vs 🚫 拦截 的判据

### 2.0 设备操作正则层（Tier-0 —— 正则优先）

意图路由是**三级阶梯**，本层是第一级：

| 级 | 形态 | 耗时 | 命中后 |
|---|---|---|---|
| **Tier-0** | 家庭设备操作正则 | **~0ms** | 直接定案 💻 LOCAL，**不外呼** |
| Tier-1 | 决策模型（jev） | ~150ms-6s | 语义分类 |
| Tier-2 | LLM 分类器 | 4s-30s | 最后兜底 |

**位置**：`classify()` 内，**缓存之后、决策模型之前**。缓存命中本身是 ~0ms
且语义等价，因此缓存先查；但本层必须在决策模型之前 —— 这正是「正则优先」的含义。

**判定表（T0–T3）**：

| 序 | 条件（精确） | 去向 |
|---|---|---|
| T0 | 否定/疑问语境命中（`别`/`不要`/`怎么`/`如何`/`是否`/`吗`/`呢`/`how to`/`should i`…） | → 不命中，**继续往下** |
| T1 | 动作词与设备名词**不相邻**（中间夹了别的词） | → 不命中，继续往下 |
| T2 | 动作词或设备名词缺一（只有「空调」没有「开」） | → 不命中，继续往下 |
| T3 | 动作 + 设备**相邻**命中 | 💻 **本地**（`device-command:<动作>:<设备>`，conf 0.95） |

**相邻**的定义是关键 —— 这是「打开空调」与「空调的价格」+「打开网页」的分界。
中间只允许夹礼貌/处置助词（`把`/`将`/`请`/`帮我`/`一下`/`了`/`吧`…）。

处置前缀最多剥离 **3 层** —— 中文礼貌语常叠加（「请把…」「请帮我把…」），只剥一层
的话「请把空调打开」会剩下「把空调打开」，主语仍藏在前缀后面，匹配不上。

**中文两种语序都支持**：

| 语序 | 例子 | 许可条件 |
|---|---|---|
| 动宾式（动作在前） | 打开空调、开灯、关电视 | 开关类动词的默认语序 |
| 受事前置（设备在前） | 把灯打开 | 处置前缀（把/将/请/帮我…）许可 |
| 受事前置（设备在前） | 空调调到26度、灯调暗 | 调参类动词（调到/调低/设置…）许可 |

英文按词边界匹配同一套规则（`turn on the light` / `switch off the ac` /
`open the door`）。

**本层的设计理由**：

1. **延迟** —— 5 个字的指令不该花 5 秒。
2. **确定性** —— 家电开关是二值动作，没有语义灰度；决策模型和 LLM 只会在
   「开灯」和「关灯」之间猜。
3. **隐私** —— 命中即在本地定案，原始指令不出设备、不进决策模型的上行请求体
   （决策模型指向云端时尤其重要）。

**判定一律 💻 LOCAL** —— 家电操作由本地 realm 的设备技能执行，不该上云
（与「默认本地」原则一致）。

**可观测性**：审计 `intent.device-command.hit`（带 device / action / matched）+
`intent.classify.end` 的 `path: 'device-command'`；计数
`getStats().deviceCommandHit`（每次命中省下一次决策模型往返）；置信度标记
`confidenceReported: true` —— 正则裁决是**实测**的，不是模型自报的。

**扩展面**（都是**追加**，不替换内置词表）：

- `config/edge.json` → `stages.intent.deviceCommands.{devices,actions}`
- `config/privacy-policy.json` → `stages.intent.deviceCommands.{devices,actions}`
  （**✅ 热重载**，每轮 classify 实时读取）

加一个新电器名只改一行 JSON，不用改代码。内置词表见
[附录 A8](#a8-设备操作词表)。

### 2.1 决策模型阶段（`jev.provider: 'bailian-decision'`，语义优先主判定）

**发送的语义判断（题目，从 policy `categories` 自动生成）**：

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
        "REJECT": "高危 / 违法 / 违规请求（危险系统操作、破坏性命令、投诉、法务）",
        "LOCAL":  "其余一切请求（本地操作、日常问答等——这是默认类别，拿不准就选它）"
        // categories 有几行生成几行（热重载）；无 LOCAL 行 → 代码自动补 catch-all 兜底
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

**收到的响应（实测形状）**：

```jsonc
{
  "answers": {
    "intent": { "type": "choice", "choice": "CLOUD", "confidence": 0.983, "probabilities": { "…": "…" } },
    "risk":   { "type": "score", "score": 0.29, "legend": { "…": "…" }, "confidence": 0.91 }
  },
  "usage": { "input_tokens": 125 }, "latency_ms": 47.3
}
```

**判定表（按顺序命中即停，D0–D7）**：

| 序 | 条件（精确） | 去向 |
|---|---|---|
| D0 | 断路器开（上次失败后 30s 内） | → 跳过决策模型，进 LLM |
| D1 | HTTP 非 200 / 超 `timeoutMs` / 解析失败 | → 跳过，进 LLM；断路器开 30s |
| D2 | `riskScore = risk.score/3` ≥ **0.70** | 🚫 **拦截（REJECT，403）** |
| D3 | choice 不在 categories id 集合（幻觉；LOCAL 恒可映射） | → 跳过，进 LLM |
| D4 | choice = **LOCAL** 且 conf ≥ **0.50** | 💻 **本地**（→ 后处理 2.4） |
| D5 | choice = LOCAL 且 conf < 0.50 | → 跳过，进 LLM |
| D6 | choice = **非 LOCAL** 且 conf ≥ **0.85** | ☁️/🚫 按类别（→ 后处理 2.4） |
| D7 | choice = 非 LOCAL 且 conf < 0.85 | → 跳过，进 LLM |

**判决说明**：choice 的 criteria key 就是类别 id——CLOUD ☁️、REJECT 🚫、LOCAL 💻；
实测金标 15 条 93%（唯一误判被 D5 置信门 + 实体护栏双层吸收）；置信度自校准
（清晰样本 0.89–1.0，模糊样本自报 0.60 诚实低于门限）。

### 2.2 LLM 分类器阶段（Tier-0 未命中、决策模型 skip 且 `stages.intent.llmFallback ≠ false`；=false 则直接进 2.3）

**发送的语义判断（prompt，v1.9.0 类别行原文）**：

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

**判定表（L1–L2）**：

| 序 | 条件 | 去向 |
|---|---|---|
| L1 | HTTP/超 4s/解析失败/conf < **0.60** | → 跳过，进规则层 |
| L2 | verdict conf ≥ 0.60 | ☁️/🚫/💻 按 category（→ 后处理 2.4） |

### 2.3 规则层（正则护栏，优先级从高到低首中即停，R1–R6）

> 本层是 **Tier-0（2.0）未命中**、且决策模型与 LLM 都跳过（LLM 失败或关兜底）时
> 才到达的**最后兜底**。T0 命中的设备指令不会走到这里。

| 序 | 条件（正则原文见附录 A） | 去向 |
|---|---|---|
| R1 | REJECT 两条正则命中 | 🚫 **拦截（403）** |
| R2 | PII LOCAL 七条正则命中（`密码…`/`身份证号…`/`手机号…`/`邮箱…`/`IP 地址…`/`住址…`/`本地…`） | 💻 **本地** |
| R3 | CLOUD 联网正则命中（`联网\|上网\|…\|天气预报\|股价…`） | ☁️ **云端** |
| R4 | 云关键词表命中（`新闻`/`天气`/`最新`…25 词） | ☁️ **云端** |
| R5 | LOCAL 兜底表命中（`文件`/`读取`/`计算`…24 词） | 💻 **本地** |
| R6 | 全不中 | 💻 **本地**（defaultCategory = LOCAL，fail-closed） |

### 2.4 共同后处理（决策模型/LLM 采纳后、定案前，顺序固定）

| 序 | 条件 | 修正 |
|---|---|---|
| P1 | verdict ≠ LOCAL 且文本命中实体表（`密盒\|ets\|etscli`） | 强制 💻 **本地**（`override-local-entity:<词>`） |
| P2 | verdict = ☁️ CLOUD：①云关键词命中 → **放行出网**；②conf ≥ **0.95**（语义解锁）**且该置信度是模型实测上报的**（`confidenceReported ≠ false`）→ **放行出网**；③都不满足 → 压回 💻 **本地**（`no-web-need`） |
| P3 | verdict = 💻 LOCAL / 🚫 REJECT：云闸不适用，定案 |

### 2.5 阶段二出口汇总

| 出口 | 条件（完整枚举） |
|---|---|
| 🚫 拦截 | D2 风险闸；或（任一层的）REJECT 判决最终生效 |
| ☁️ 云端 | CLOUD 判决采纳 且 P2 出网许可（关键词 ∨ 语义解锁 ≥0.95 且置信度为实测） |
| 💻 本地 | **T0 设备正则命中**；或 LOCAL 判决采纳（D4/L2）；或 CLOUD 被云闸压回；或规则层 R2/R5/R6 |

**样本走表**：
- 「开灯」：**T0** 动作「开」+ 设备「灯」相邻命中 → 💻 本地（~0ms，决策模型与 LLM
  **均未调用**）；
- 「查一下最新的AI新闻」：T0 不命中（无设备名词）→ D6（CLOUD conf 0.98）→ P1 无实体
  → P2 ①`新闻` 命中且 ②0.98≥0.95 → ☁️ 云端；
- 「什么是量子力学」：T0 不命中 → D4（LOCAL conf 0.94 ≥ 0.50）→ P3 → 💻 本地；
- 「怎么开空调」：T0 命中否定/疑问语境（`怎么`）→ 不命中 → 交给后续层；
- 「把密盒的日志发到网上」：T0 不命中 → D2（risk 2.1/3 = 0.70）→ 🚫 拦截（403）。

---

## 第三阶段：域内执行——☁️ 云端做什么 / 💻 本地做什么

### ☁️ 云端域（CLOUD 判决后）

| 步骤 | 内容 | 决策者 | 去向 |
|---|---|---|---|
| 工具装配 | web_search/web_fetch 留在 LLM 工具视图（LOCAL 域则被摘除） | 配置（realm 桥） | — |
| 搜索 | 三档 fail-down：duckduckgo（免费默认）→ tavily → bocha（key 失效自动降档） | 配置 + 外部服务 | — |
| **脱敏** | 10 类 PII 模式过用户原文 + 历史（逐条）；**失败/不可用 → 降级 💻 本地（脱不了敏不上云）** | **正则（fail-closed）** | ☁️/💻 再分流 |
| 合成 | 云模型（直连 MiniMax 或委派宿主 provider）生成回复 | 配置 | ☁️ |

### 💻 本地域（LOCAL 判决后）

| 步骤 | 内容 | 决策者 |
|---|---|---|
| 工具装配 | web 工具从 LLM 视图**摘除**——LOCAL agent 根本没有出网工具 | 配置（realm 桥 Layer 1.5） |
| 生成 | 本地池（`llm.local`，当前 MiniMax 路由）+ 本地工具（bash/fs/ets-* skills，realm 映射放行） | 配置 |

---

## 第四阶段：回程与收尾

| 步骤 | 内容 | 决策者 |
|---|---|---|
| 还原 | desanitize：占位符 → 尾段（`[PHONE_1]` → 尾 4 位；keepPrefix 语义） | 正则（确定性可逆） |
| 记账 | 云请求计数 → td-bus 速率分级（≥4× 基线 → 后续消息 🚫 503） | 统计 |
| 输出掩码 | 非 sanitizer 管理的 session 走 prompt-guard 输出 PII 掩码 | 正则 |

---

## 附录 A：全量正则清单（7 组 + 杂项 2）

**A1 意图路由规则**（policy `routingRules`，10 条，§2.3 R1–R3 引用）：

```js
// REJECT
"(导出|删除|清空|格式化).*(数据库|系统|磁盘|全部数据)"
"(drop\\s+table|rm\\s+-rf|format\\s+[a-z]:|del\\s+/[fs])"
// LOCAL（PII/本地操作）
"(本地|local|文件|file|计算|calculate|读取|写入)"
"(密码|password|secret|密钥|private.?key|token)"
"(身份证号|id.?card|银行卡|bank.?card|信用卡|credit.?card)"
"(手机号|电话号码|手机.{0,5}号|phone.?number|mobile.?number)"
"(邮箱|电邮|email.?address|e-?mail)"
"(IP\\s*地址|服务器.{0,8}(IP|地址)|server\\s+IP|局域网.{0,8}(IP|地址))"
"(家庭住址|住址|home\\s+address|通信地址)"
// CLOUD
"(联网|上网|网上查|搜索引擎|搜索一下网上|web search|search the web|look up online|weather forecast|天气预报|实时行情|股价|汇率|current price)"
```

**A2 云关键词**（26，§2.3 R4）：中文 13——`新闻 最新 实时 热搜 趋势 排行榜 资讯 网上 互联网 在线 联网 天气 股价`；英文 13——`news latest live trending ranking online internet "web search" web weather forecast price`；扩展面 `stages.intent.cloudKeywords`（追加，热重载）。

**A3 LOCAL 兜底词**（24，§2.3 R5）：中文 13——`文件 读 写 删除 创建 计算 加减乘除 本地 设备 系统 磁盘 目录 文件夹`；英文 11——`file read write delete calculate compute local device disk directory folder`；rationale `rule-keyword-match:<词>`；替换面 `stages.intent.fallbackKeywords`。

**A4 实体护栏**（3，§2.4 P1）：`密盒 ets etscli`（CJK 子串 / ASCII 词边界）；扩展面 `stages.intent.localEntities`。

**A5 注入检测**（26，第一阶段 #3）：block——`ignore\s+(all\s+)?previous\s+instructions`、`忽略\s*(之前|上面|以上)\s*(的)?\s*(指令|指示|命令)`、`disregard\s+(all\s+)?(prior|previous|above)\s+(instructions|rules)`、`show\s+me\s+(your\s+)?system\s+prompt`、`(repeat|output|print|display)\s+(your|the|my)\s+(system\s+)?(prompt|instructions|rules|configuration)`、`(输出|显示|打印|告诉|说说)…(提示词|指令|配置|prompt)`、`DAN\s*(mode|jailbreak|do\s+anything\s+now)`、`(无限制|不受限|越狱|解除限制|开发者模式)`、`(开发者模式|调试模式|diagnostic\s+mode)`、`(发送|上传|传输|外发).*(外部|外网|外部服务器|第三方)`、中文变体十条（攻击动词+限定词+紧名词三件套，源码 `DEFAULT_INJECTION_PATTERNS`）；warn——`you\s+are\s+now\s+(a|an)`、`act\s+as\s+(a|an|if)`、`pretend\s+(to\s+be…)`、`你(现在|立即)?(是|变成|扮演|充当)`、`假设\s*(你|你是…)`、`从现在开始\s*(你|你就是|请你)`、`(违反|打破|跳过|绕过…)…(规则|约束|限制…)`、`(你是…)(没有限制|不受约束…)`。

**A6 PII 模式**（10，第一阶段 #4 + 云端域脱敏）：身份证 `\b[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b`（secret）、银行卡 `\b\d{16,19}\b`（secret）、手机号 `\b1[3-9]\d{9}\b`（confidential，keepPrefix 7）、邮箱 `[\w.-]+@[\w.-]+\.\w+`（confidential）、api-key（secret）、凭据 `(?:密码|口令|用户名|账号|账户|passwd|password|pwd|username|account|secret|access[ _-]?token|token|api[ _-]?key)…`（secret）、IP（confidential）、MAC（confidential）、护照 `\b(?:E[0-9A-Z]\d{7}|G\d{8})\b`（secret）、车牌 `[京津沪渝…][A-Z][A-HJ-NP-Z0-9]{5}`（confidential）。

**A7 杂项**（2）：input-guard `/credential|secret|password|passphrase|凭据|密码/iu`（审计分级）；sanitizer 占位符解析（内部机制，非决策）。

**A8 设备操作词表**（入口安检 §1.1 与意图路由 Tier-0 共用；源码 `src/dsh-adapter/intent-signals.ts`）：

- **设备名词**（65）：中文 32——`空调 灯 电灯 台灯 落地灯 吊灯 吸顶灯 灯带 电视 窗帘 卷帘 风扇 电扇 加湿器 除湿机 空气净化器 净化器 热水器 洗衣机 冰箱 微波炉 烤箱 洗碗机 扫地机器人 门 门锁 锁 插座 开关 暖气 地灯 鱼缸`；英文 33——`air conditioner ac light lights lamp desk lamp ceiling light tv television curtain blinds fan humidifier dehumidifier air purifier purifier water heater washing machine washer fridge refrigerator microwave oven dishwasher robot vacuum vacuum door lock socket plug heater thermostat aquarium`。
- **动作词**（44）：中文 25 = 开关类 11（`打开 开启 开 启动 关上 关闭 关掉 关 停止 断开 熄灭`）+ 调参类 14（`调到 调高 调低 调暗 调亮 调节 调整 设置 设为 设定 切换 开到 开大 开小`）；英文 19——`turn on turn off switch on switch off start stop power on power off set adjust increase decrease dim brighten toggle open close lock unlock`。
- **否定/疑问词**（37，命中即放弃 Tier-0）：中文 26——`别 不要 不用 不必 无需 是否 要不要 能不能 可不可以 怎么 如何 为什么 怎样 怎么样 什么意思 什么是 吗 呢 能否 该不该 建议 介绍 解释 告诉我 查一下 查询`；英文 11——`should i how to how do why what is what's can you explain tell me about don't do not no need without`。
- **助词**（14，中间只允许夹这些）：前缀 7——`请 帮我 帮忙 给我 替我 把 将`；后缀 7——`一下 大点 小点 一点 吧 啊 了`。
- **扩展面**：`stages.intent.deviceCommands.{devices,actions}`（edge.json + policy，热重载，追加不替换）。

## 附录 B：全量语义决策语句（4 组）

| 组 | 发给谁 | 内容 | 明细 |
|---|---|---|---|
| B1 决策模型 | bailian-decision / 本地 MLX `/systemone` | §2.1 题目全文（intent choice + risk score） | 本文 2.1 |
| B2 LLM 分类器 | local-llm（MiniMax） | §2.2 prompt 全文 | 本文 2.2 |
| B3 注入语义层 | prompt-guard Stage 6（默认关） | system prompt 逐字：TYPE 1 语义攻击五类（指令覆盖/越狱/提示词泄漏/数据外传/混淆 payload）+ TYPE 2 危险内容五类（武器/暴力/违法/自残/未成年人）+ UNSAFE 五条 + SAFE 白名单六条（"查看系统信息"…"查询AI新闻"）+ PRINCIPLE（拿不准判 safe）+ 判决格式 `{"safe",threats,dataClass,rationale}`；user 模板 `Classify the following user input…<<<…>>>` | `src/dsh-adapter/prompt-guard.ts` |
| B4 本地 ONNX jev | `POST {jevUrl}/predict`（provider='local'） | `{query, lang:'zh', metadata, intents[]（categories.jevIntents 去重分批≤16，每条带类别描述）, chitchat_intents:['闲聊','其他']}` | `src/dsh-adapter/intent-router.ts` |

## 附录 C：调整入口速查（热重载）

| 想调整 | 改哪里 | 热重载 |
|---|---|---|
| 决策模型端点/路径/模型/key | edge.json `jev.{url,path,model,apiKeyRef,authScheme}` | 需重启 |
| 决策模型采纳门/风险闸/超时/方向门 | edge.json `jev.{confidenceThreshold,riskThreshold,timeoutMs,localAdoptFloor}` | 需重启 |
| LLM 采纳门/超时/路由/兜底开关 | edge.json `stages.intent.{confidenceThreshold,timeoutMs,provider,llmFallback}` | 需重启 |
| 语义解锁门 | edge.json `stages.intent.semanticCloudMinConfidence` | ✅ 热重载 |
| 设备操作词表（设备名/动作词） | edge.json 或 policy `stages.intent.deviceCommands.{devices,actions}` | ✅ 热重载 |
| 入口安检的设备操作快速通道开关 | cordis patch 行 `prompt-guard` → `enableDeviceCommandFastPath` | 需重启 |
| 类别定义/描述（喂三层） | policy `categories[]` | ✅ 热重载 |
| 云关键词/实体/兜底词 | edge.json 或 policy `stages.intent.{cloudKeywords,localEntities,fallbackKeywords}` | ✅ 热重载（关键词面） |
| 路由正则/脱敏规则 | policy `routingRules` / `sanitizationRules` | ✅ 热重载 |
| 本地 MLX 切换 | `jev.url=http://127.0.0.1:11017/compatible-mode/v1` + `path=/systemone` | 需重启 |

## 附录 D：Edge tab 呈现

`intent.classify.end` 行携带 `keyword`（正则命中词，从 rationale 提取）与 `semantic`
（所选类别 description 原文，决策模型与 LLM 两路径同格式）；Intent 面板字段顺序
`category → keyword → semantic → targetRealm → confidence → rationale → classifier → textLen`。

**`path: 'device-command'` 的呈现**：该路径不在面板的分支里
（`jev-adopt*` / `llm*` / `cache` / `rules-*` / `gate-no-web-need`），
按「宁可显示机器码原文，也不要显示一个会误导的『分类器 X』」的原则，
「裁决者」一行会显示**机器码 `device-command`**（而非「未知路径」—— 后者只在
path 为空串时才出现）。

该路径的 `keyword` 字段**为空**（`classifyEvidence` 的正则只认
`rule-cloud-keyword` / `rule-local-entity` / `override-local-entity` /
`rule-keyword-match` 四种 rationale 前缀，`device-command:` 不在其中）。
设备/动作信息在 `rationale` 里，形如 `device-command:开:灯`，另有独立的
`intent.device-command.hit` 审计行带 `device` / `action` / `matched` 三字段。
