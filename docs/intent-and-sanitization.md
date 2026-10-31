# 输入防御、意图识别与脱敏策略

> 本文描述**当前生效的策略**：每条用户消息如何被安检、如何定域、哪些数据可以出网。
> 配套的逐条判据（正则原文、prompt 全文）见 [意图判定决策参考手册](intent-decision-reference.md)。
> 配置文件清单见 [config-reference.md](config-reference.md)。
>
> 实现位置：`src/dsh-adapter/` 下的 `input-guard.ts`（编排）、`prompt-guard.ts`（输入防御）、
> `intent-router.ts`（意图识别）、`sanitizer-pipeline.ts` + `pii-utils.ts`（脱敏）、
> `privacy-policy.ts`（隐私策略）。

## 目录

- [一句话概括](#一句话概括)
- [全链路总览](#全链路总览)
- [第一章 输入防御（prompt-guard）](#第一章-输入防御prompt-guard)
- [第二章 隐私策略（privacy-policy）](#第二章-隐私策略privacy-policy)
- [第三章 意图识别（intent-router）](#第三章-意图识别intent-router)
- [第四章 脱敏（sanitizer + pii-utils）](#第四章-脱敏sanitizer--pii-utils)
- [第五章 编排层（input-guard）](#第五章-编排层input-guard)
- [阈值速查](#阈值速查)
- [配置速查](#配置速查)
- [审计事件速查](#审计事件速查)
- [已知边界](#已知边界)

## 一句话概括

一条消息进来，先过 **prompt-guard**（正则 + 频率 + PII 分级 + 可选本地模型，拦攻击）；
再过 **privacy-policy**（正则路由规则，判业务危险操作与 PII 护栏）；
然后由 **intent-router** 按「设备正则 → 决策模型 → LLM 分类器 → 规则层」四级阶梯定域，
并用**实体护栏**与**云闸**两道后处理闸收口；定到 CLOUD 之后，**sanitizer** 先把 PII
换成占位符再出网，回程再还原成原文。

**三条底线贯穿全程**：默认留在本地（未决轮次不出设备）、脱不了敏就不上云、
攻击与业务危险操作各自独立拦截。

## 全链路总览

```
用户消息
  │
  ├─[A] prompt-guard.checkInput()          ← 输入防御（零 token 正则层 + 可选模型）
  │     长度 → 全局频率 → session 频率 → 注入检测(26 条) → PII 分级 → [设备快速通道] → 模型检测
  │     命中 block → 拒收；warn → 放行并审计
  │
  ├─[B] privacy-policy.matchRouting()      ← 隐私策略（零 token，first-match-wins）
  │     REJECT → 直接拒绝；LOCAL/CLOUD 规则 → 作为路由输入
  │
  ├─[C] intent-router.classify()           ← 意图识别
  │     REJECT 预检 → 结果缓存 → Tier-0 设备正则
  │       → Tier-1 决策模型(jev) → Tier-2 LLM 分类器 → 规则层
  │     后处理：实体护栏 → 云闸
  │
  ├─[D] sanitizer.sanitize()               ← 脱敏（CLOUD 路径，逐条 user 消息）
  │     失败 → 降级 LOCAL（原始 PII 留本地）
  │
  ├─[E] 出网                                ← cloud-llm-adapter 再脱一次 + 出网裁剪
  │
  └─[F] 回程 desanitize()                   ← 占位符还原成原文
```

**四个组件的职责边界**：

| 组件 | 判定什么 | 判定者 | 拦截语义 |
|---|---|---|---|
| prompt-guard | 输入是否在**攻击 AI** | 正则 + 可选本地模型 | 攻击 → 拒收 |
| privacy-policy | 这个**操作该不该执行** | 纯正则 | REJECT → 拒绝；其余 → 路由建议 |
| intent-router | 该轮**落在哪个域** | 正则 / 决策模型 / LLM / 规则 | REJECT → 拒绝；其余 → 定域 |
| sanitizer | 哪些**字符不能出网** | 纯正则 | 失败 → 降级 LOCAL |

攻击检测与业务危险操作分开，是因为二者语义不同：`drop table` 可能是合法的运维请求，
「忽略之前的指令」一定是攻击。前者靠正则明文匹配，后者需要语义判断。

---

# 第一章 输入防御（prompt-guard）

`src/dsh-adapter/prompt-guard.ts`

## 1.1 检查阶段

`checkInput(text, sessionId)` 顺序执行六个编号阶段，外加一个未编号的设备指令快速通道：

| 阶段 | 检查 | 命中后果 | 耗时 |
|---|---|---|---|
| 1 | 长度 > `maxInputLength`（10000） | 拒收，risk `medium` | ~0ms |
| 2 | 全局频率 > `globalMaxRequestsPerMinute`（60/分钟） | 拒收 | ~0ms |
| 3 | session 频率 > `maxRequestsPerMinute`（20/分钟） | 拒收 | ~0ms |
| 4 | 注入模式库 26 条 | 按 action 分流（见下） | ~0ms |
| 5 | PII 数据分级 | **不拦截**，secret 级升 risk `high` + 审计 | ~0ms |
| — | 设备指令快速通道 | 纯设备指令 → 跳过模型检测 | ~0ms |
| 6 | 模型辅助检测 | 明确 `safe:false` → 拒收 | 1–3s |

**阶段 1–5 全是零 token 本地检查**，只有阶段 6 调用本地模型。已知攻击模式零延迟拦截，
未知/复杂攻击才走模型。

**阶段 5 不再拦截**：secret 级 PII 只做分级标记与审计（`input.secret-data`），
放行给下游处理——含身份证、银行卡的**合法**请求不应被整条 400。
真正的约束由 privacy-policy 的 PII 路由规则（→ LOCAL）与 sanitizer（→ 占位符）承担。

## 1.2 注入模式库

26 条内置规则（`DEFAULT_INJECTION_PATTERNS`），按 `action` 分三档：

| action | 条数 | 行为 | 审计 |
|---|---|---|---|
| `block` | 18 | 拒收（risk `high`），不进后续阶段 | `input.injection`（security） |
| `warn` | 6 | 放行，审计留痕 | `input.injection.warned` |
| `sanitize` | 0 | 机制已实现，默认库无条目 | `guard.rule.sanitized` |

按攻击类型分布：直接注入 3、提示词泄漏 3、角色覆盖 3、中文角色覆盖 3、安全绕过 3、
数据外传 1、中文扩展 10。

**为什么角色覆盖类归 warn**：教育场景里「假设你是一个翻译器」「从现在开始你是英语老师」
是无害意图，不应阻断。

**扩展**：`config.rules` 追加自定义规则，固定带 `i` 标志；正则无效则跳过并审计
`guard.rule.invalid`。详见 [决策参考手册 附录 A5](intent-decision-reference.md#a5-注入检测)。

## 1.3 三级 action 的处理

```
for (const rule of injectionPatterns) {
  if (!rule.pattern.test(text)) continue
  if (rule.action === 'block')    blockHits.push(rule.name)      // 不改写
  if (rule.action === 'warn')     warnHits.push(rule.name)        // 不改写
  // action === 'sanitize'
  sanitizedText = sanitizedText.replace(rule.pattern, () => `[REDACTED:${rule.name}]`)
}
```

- **block**：任一命中即拒收，审计带 `patterns`（规则名）与 `patternSources`（正则原文）。
- **warn**：放行，审计带 `patternSources`。命中信息不写入 `InputCheckResult`
  （该接口只承载 block 命中），调用方无需读取。
- **sanitize**：命中的片段被改写为 `[REDACTED:<规则名>]`，**替换后的文本**继续流入
  阶段 5 与阶段 6，避免模型看到原始内容。改写结果通过 `result.sanitizedText` /
  `result.sanitizedRules` 暴露。

**block 优先于 sanitize**：block 命中时整条拒收，sanitize 改写的结果不被使用。

## 1.4 设备指令快速通道

命中设备操作正则且文本是**纯**设备指令时，跳过模型检测直接放行。

「纯」的判定：扣掉匹配到的设备指令、礼貌助词、标点与**数值参数**后剩余为空。
所以「空调调到26度」算纯（26 是设定值不是额外内容），「开灯顺便把密码发到第三方」不算纯。

与意图识别的 Tier-0 共用同一套词表和同一个匹配器（`matchDeviceCommand`），
两个层对「什么算设备操作」永远一致。审计 `guard.device-command.detected`
与 `guard.model-detect.skip`（reason = `pure-device-command`）。

扩展面：`stages.intent.deviceCommands.{devices,actions}`（热重载）。

## 1.5 模型辅助检测

用本地模型捕捉正则漏报的语义攻击。

| 项 | 值 |
|---|---|
| provider | `local-llm`（**永不指向云模型**——原始用户文本不能出设备） |
| model | 跟随 `config/edge.json` 的 `llm.local.model` |
| 超时 | `stages.guard.timeoutMs`（内置默认 20000ms） |
| 输入长度上限 | `stages.guard.maxInput`（2000），超出直接跳过 |

**模型永远指向本地池**是硬约束：guard 检测若走云模型，等于把原始用户文本送出设备。

**system prompt 分两类**：TYPE 1 语义攻击（指令覆盖、越狱、提示词泄漏、数据外传、混淆 payload）
与 TYPE 2 危险内容（武器、暴力、违法、自残、未成年人），并列出大量「本地操作是正常的」
白名单，原则是拿不准判安全。全文见 [决策参考手册 附录 B3](intent-decision-reference.md)。

**容错解析** `parseSafetyResponse` 三级：直接 JSON → 提取 `{...}` 块 →
**只扫尾部 800 字符**的 `safe` token 正则（头部可能是 `<think>` 推理块，
全串扫描会因同时出现 safe/unsafe 而误判）。

**fail-open**：超时、异常、provider 错误、解析失败、模型判安全，全部返回「不阻断」。
只有模型**明确判 `safe:false`** 才拒收。理由是边缘端模型可能不可用，
fail-closed 会让整个系统不可用；正则与 PII 分级已覆盖大部分已知攻击。

**跳过条件**：开关关闭、无 llm handle、输入超长、privacy-policy 命中 REJECT、
纯设备指令。

---

# 第二章 隐私策略（privacy-policy）

`src/dsh-adapter/privacy-policy.ts`

## 2.1 职责

1. **路由规则匹配** `matchRouting()`：判断该轮的处理域
2. **数据分级** `classifyData()`：识别输入的敏感等级
3. **脱敏规则供给** `getSanitizationRules()`：向 sanitizer 提供规则表
4. **全局约束**：云端请求频率、TCB 证明等

## 2.2 策略文件

加载路径三级回退：

```
config/edge.json 的 privacy.policyPath
  → ~/.dsh-edge-agent/privacy-policy.json
  → <bundle>/config/privacy-policy.json   （随包发布，version 1.9.0）
```

- 文件不存在 → 审计 `policy.missing` → 回退内置 `DEFAULT_POLICY`
- 解析失败 → 审计 `policy.load-failed` → 回退内置 `DEFAULT_POLICY`
- 热重载：轮询文件 mtime（默认 5s），变更即重载

**HMAC 签名**：设置 `DSH_EDGE_POLICY_HMAC_KEY` 后，`<policyPath>.sig` 必须与
`HMAC-SHA256(policyBody, key)` 匹配（`timingSafeEqual` 比较）。签名缺失或不匹配时
审计 `policy.tamper-detected` 并**不加载新策略**，保留内存中的旧版本。
未设置密钥则不校验（首次审计 `policy.signing.disabled`）。

## 2.3 路由规则

发布策略含 **10 条**路由规则，`matchRouting()` 按数组顺序逐条正则匹配，
**首个命中即返回**（first-match-wins），因此 REJECT 规则必须排在前面：

| # | realm | confidence | 覆盖 |
|---|---|---|---|
| 1 | REJECT | 0.9 | 导出/删除/清空/格式化 数据库·系统·磁盘·全部数据 |
| 2 | REJECT | 0.95 | `drop table` / `rm -rf` / `format c:` / `del /f` |
| 3 | LOCAL | 0.8 | 本地操作（文件、计算、读写） |
| 4 | LOCAL | 0.9 | 凭据类（密码、密钥、token） |
| 5 | LOCAL | 0.95 | 金融身份（身份证、银行卡、信用卡） |
| 6 | LOCAL | 0.95 | 手机号 |
| 7 | LOCAL | 0.95 | 邮箱 |
| 8 | LOCAL | 0.9 | IP 地址 |
| 9 | LOCAL | 0.85 | 家庭住址 |
| 10 | CLOUD | 0.8 | 需要检索公网信息（联网、搜索引擎、天气、行情） |

正则原文见 [决策参考手册 附录 A1](intent-decision-reference.md#a1-意图路由规则)。

**回退保护**：内置 `DEFAULT_POLICY` 只有 3 条路由规则（2 条 REJECT + 1 条 LOCAL），
脱敏规则则是完整的 10 条。策略文件缺失时路由覆盖显著缩减——PII 关键词护栏不在回退集里，
这是回退状态的已知代价。

**规则的权威性**：confidence ≥ 0.7 的非 REJECT 规则**直接决定**该轮 category，
不再调用 LLM 分类器（省一次往返）；REJECT 规则则是硬拒绝。

## 2.4 数据分级

`classifyData()` 遍历脱敏规则，返回命中的**最高**敏感等级：

| 等级 | 默认域 | TTL | 覆盖的 PII 类 |
|---|---|---|---|
| `public` | CLOUD | 3600s | 无（默认起点） |
| `internal` | SANITIZED | 1800s | 无（仅默认表声明） |
| `confidential` | LOCAL | 900s | phone、email、ip-address、mac-address、license-plate |
| `secret` | LOCAL | 300s | id-card、bank-card、api-key、credential、passport |

分级与 sanitizer 的规则表**同源**（同一份 `PII_PATTERNS` 派生），所以分类结果
与实际脱敏行为不会漂移。

---

# 第三章 意图识别（intent-router）

`src/dsh-adapter/intent-router.ts`

## 3.1 判定阶梯

`classify()` 内按顺序执行，**先命中先定案**：

| 级 | 形态 | 耗时 | 命中后果 |
|---|---|---|---|
| 预检 | privacy-policy REJECT 规则 | ~0ms | 直接拒绝（403），零 token |
| 缓存 | 同文本 + 同上下文的已完成裁决 | ~0ms | 直接复用（TTL 60s，上限 128 条，LRU） |
| **Tier-0** | 家庭设备操作正则 | ~0ms | 定案 LOCAL（conf 0.95），**不外呼任何模型** |
| **Tier-1** | 决策模型（jev） | ~150ms–6s | 语义分类 |
| **Tier-2** | LLM 分类器 | 4s–30s | 语义分类 |
| 规则层 | 正则护栏 | ~0ms | 确定性兜底 |

规则层只在 Tier-1 skip 且 Tier-2 失败/超时/低置信（或 `llmFallback=false`）时到达。

**方向性置信门**：Tier-1 采纳门按方向区分——LOCAL 方向 0.50，非 LOCAL 方向 0.85。
数据可能出网时用严门；LOCAL 是安全默认，低门即采纳，省掉一次 LLM 往返。

## 3.2 Tier-0 设备正则

动作词与设备名词**相邻**命中即定案 LOCAL（confidence 0.95）。相邻是分界：
「打开空调」命中，「空调的价格」+「打开网页」不命中。中间只允许夹礼貌/处置助词。

支持中文两种语序：动宾式（打开空调）与受事前置（把灯打开、空调调到26度）。
英文按词边界匹配同一套规则。

否定/疑问语境（`怎么`/`如何`/`是否`/`how to`）命中即放弃本层，交给后续层。

判定一律 LOCAL：家电操作由本地技能兑现，不该上云。

## 3.3 Tier-1 决策模型

一次请求同时问两件事：**intent**（choice）与 **risk**（score）。

- **端点**：由 `jev.url` / `jev.path` / `jev.model` / `jev.apiKeyRef` 配置
- **题目**：`intent` 的 criteria 由 policy 的 `categories[]` 自动生成，改一处四面同源生效
- **风险闸**：`riskScore = risk.score / 3` ≥ `jev.riskThreshold`（0.70）→ 直接 REJECT
- **采纳门**：非 LOCAL 0.85，LOCAL 0.50

**决策模型是可跳过的加速器，永不造成行为回退**：HTTP 错误、超时、解析失败、
choice 不可映射、置信度不足——任何一种都只是 skip 到下一层，不会误判。
断路器在连续失败后开启 30s，期间直接 skip。

**置信度溯源**：若后端未上报数值 confidence，会用合成值 0.9 顶上并标记
`confidenceReported=false`。合成值**不能**用来满足云闸的语义解锁门。

## 3.4 Tier-2 LLM 分类器

纯 user message（无 system prompt），要求只输出 JSON：

```
{ "category": <CLOUD|REJECT|LOCAL|SANITIZED>, "confidence": <0.0-1.0> }
```

类别行来自 policy 的 `categories[]`；没有 LOCAL 行时自动补 catch-all 行。
**必须解释 confidence 语义**（1.0 非常确定 / 0.7 较确定 / 0.5 不确定 / <0.5 完全不确定），
否则小模型对所有请求都输出 0.98+，置信度门形同虚设。

**多轮上下文**：最多 `recentMessagesLimit`（默认 3）条，每条截 200 字符，
以「最近对话上下文（仅参考，不要分类历史消息本身）」插入。

采纳门 `confidenceThreshold`（0.6）。低于门限 → 降级到规则层。

## 3.5 规则层

五个顺序检查，首中即停：

| 序 | 检查 | category | confidence |
|---|---|---|---|
| R1 | privacy-policy 规则 | 按规则（REJECT 则拒绝） | 规则自带 |
| R2 | LOCAL 实体（密盒 / ets / etscli） | LOCAL | 0.9 |
| R3 | CLOUD 关键词（新闻 / 天气 / 最新…） | CLOUD | 0.8 |
| R4 | LOCAL 兜底关键词（文件 / 读取 / 计算…） | LOCAL | 0.7 |
| R5 | 全不中 | `defaultCategory`（LOCAL） | 0.5 |

**顺序有讲究**：R2 优先于 R3——本地实体只有本地技能能兑现，错判成云端就是隐私事故。
R3 优先于 R4：明确的公网信号比泛化的本地词更可信。

**默认 LOCAL**：未决的轮次留在设备上。代价是本地端点不可用时该轮无法作答
（fail-closed，审计 `input-guard.local.route-missing`），而不是悄悄退回云端。

## 3.6 后处理闸

判定层出结果之后、定案之前，两道闸依次生效：

**实体护栏**：verdict ≠ LOCAL 且文本命中 LOCAL 实体表 → 强制压回 LOCAL。
语义解锁也不例外。

**云闸**：verdict = CLOUD 时，出网需要满足其一：

1. 命中 CLOUD 关键词表（零成本快路径），或
2. 置信度 ≥ `semanticCloudMinConfidence`（0.95）**且该置信度是模型实测上报的**
   （`confidenceReported ≠ false`）

都不满足 → 压回 LOCAL（审计 `intent.cloud.blocked-no-web-need`）。

**分类器判 CLOUD 不等于出网许可**：没有公网信号就不出网。审计
`intent.cloud.semantic-unlock` 记录每一次语义解锁。

## 3.7 输出结构

```typescript
interface Intent {
  category: 'LOCAL' | 'CLOUD' | 'SANITIZED' | 'REJECT'
  confidence: number          // 0..1，可能是合成值
  targetRealm: string         // local | cloud | sanitized | rejected
  rationale: string           // 判定来源，带可读前缀
  confidenceReported?: boolean // false = 合成置信度
}
```

`rationale` 的取值即判定路径：`device-command:<动作>:<设备>`、`llm-classified:*`、
`jev-intent:*`、`rule-cloud-keyword:*`、`rule-local-entity:*`、`rule-keyword-match:*`、
`override-local-entity:*`、`default:*`、`no-web-need`、`policy-rule:*`。

---

# 第四章 脱敏（sanitizer + pii-utils）

## 4.1 两套机制

| | sanitizer-pipeline | pii-utils |
|---|---|---|
| 方式 | 占位符替换（PII → `[PHONE_1]`） | 不可逆掩码（`138****1234`） |
| 可逆 | ✅ 会话级内存映射 | ❌ |
| 用途 | 出网前脱敏，回程还原 | 日志 / 存储 / 输出安全网 |
| 调用方 | input-guard、intent-router、cloud-llm-adapter | audit-log、local-storage、intent-router 预览脱敏 |

**规则单一事实源**：`pii-utils.ts` 的 `PII_PATTERNS` 字典是唯一的正则出处，
`PII_RULES`、内置 `DEFAULT_POLICY.sanitizationRules` 都从它派生。
发布策略文件 `config/privacy-policy.json` 里的 10 条 pattern 是人工副本，
由 `tests/unit/pii-utils.test.ts` 的字符级一致性断言兜底（当前 10/10 一致）。

## 4.2 PII 类别

10 类（`PII_ORDER` 决定求值顺序，长规则优先）：

| piiType | 分级 | 识别内容 |
|---|---|---|
| `id-card` | secret | 18 位身份证（校验省份码、日期、校验位） |
| `bank-card` | secret | 16–19 位数字串 |
| `phone` | confidential | 中国大陆 11 位手机号 |
| `email` | confidential | 通用邮箱 |
| `api-key` | secret | `sk-` / `key-` / `api_key` 前缀 |
| `credential` | secret | 标签式凭据（密码 / 口令 / 账号 / token…） |
| `ip-address` | confidential | 合法八位组（排除版本号形态） |
| `mac-address` | confidential | 6 组十六进制 |
| `passport` | secret | 中国普通 / 港澳台护照号 |
| `license-plate` | confidential | 省份简称 + 字母 + 5 位 |

**没有「姓名」类别**——识别姓名需要 NER，当前未实现。

## 4.3 正向脱敏

```
normalizeForPII(text)        ← 预规范化：中文数字→阿拉伯；数字间空白丢弃
  → 逐条正则匹配 + 替换为 [PII_TYPE_N]
  → 记入会话映射（占位符 → 原文）
```

**预规范化**解决的是绕过：中「一三八一二三五六七八」与「138 1234 5678」
都会先归一化再匹配，同时用字符映射表把命中的子串反查回原文，避免规范化后
的下标错位。

**部分脱敏** `keepPrefix`：手机号保留前 7 位、身份证保留前 6 位，只占位化尾段。
此时映射表只存尾段——保留下来的号段本就在正文里，无需还原。

**会话映射**：`Map<sessionId, {counter, placeholders, byOriginal}>`。
同一 session 内同一取值始终映射到同一占位符（`byOriginal` 去重），
不会出现 `[PHONE_1]` 与 `[PHONE_2]` 指同一个号码。

**硬上限**：单 session 占位符数超 `maxReplacementsPerSession`（1024）时抛
`SanitizerLimitError`——**不能脱一半就放行**。审计 `sanitizer.limit-reached`。

## 4.4 反向还原

`desanitize()`（异步，带审计）/ `desanitizeSync()`（同步，用于流式 chunk）。
单次正则扫描 + 映射表查表，O(text)。

**容错原则**：还原失败时**不回退到原始 PII**，响应保持脱敏态。
最坏情况是用户看到 `[PHONE_1]` 占位符，而不是真实号码泄漏。

**流式跨 chunk**：占位符可能被切在两个 chunk 之间，流式路径用缓冲累积到
`]` 才还原。还原异常时原样 yield 原始 chunk 并审计 `input-guard.desanitize.error`。

## 4.5 脱敏调用点

| # | 位置 | 对象 | 失败后果 |
|---|---|---|---|
| 1 | intent-router 分类前 | 当前用户文本 | fail-closed → 降级规则层 |
| 2 | intent-router 分类前 | 每条历史消息 | 单条失败 → 跳过该条 |
| 3 | input-guard pre-step | 每条 user 消息 | 降级 LOCAL |
| 4 | cloud-llm-adapter 出网前 | 保留消息的每个字符串 | **不出网**，审计 `llm.cloud.egress.blocked` |

调用点 1–2 保护的是**分类器请求**（分类器可能落 CLOUD）；
调用点 3–4 保护的是**真正出网的载荷**。两层都在，缺一不可。

## 4.6 与 prompt-guard 的协调

- **输入侧**：prompt-guard 只做**分级**，sanitizer 才做**替换**，同一段原文各看各的，不冲突。
- **输出侧**：prompt-guard 的 `checkOutput()` 在 session 已被 sanitizer 管理时跳过自身掩码
  （否则会把刚还原的 PII 又遮住）。未管理的 session 走 pii-utils 掩码兜底。
- **审计侧**：所有审计 payload 落盘前还会再过一次 `redactObject`。

## 4.7 明文 PII 的释放

sanitizer 的映射表存的是**明文 PII**（还原必须用到），因此必须有明确释放路径：

1. 会话删除 / 过期 / LRU 淘汰 / 停机时主动 `purge`
2. TTL 惰性过期 + 定时清扫
3. `maxSessions` 上限触发 LRU 淘汰

---

# 第五章 编排层（input-guard）

`src/dsh-adapter/input-guard.ts`

## 5.1 位置

隐私管线挂在 **agent-loop 事件链**上，而不是某个 HTTP 入口里。
任何走 agent-loop 的入口（http-api、Web UI、dsh-im、CLI、SDK）自动覆盖，
新增入口零代码成本。

分层：

- **服务层**（叶子）：prompt-guard / privacy-policy / intent-router / sanitizer —— 各自单一职责
- **编排层**：input-guard —— 按序组合服务、维护跨 hook 状态、决定降级
- **传输层**：http-api / Web UI / dsh-im —— 只做协议适配

## 5.2 三个 hook

| Hook | 时机 | 作用域 | 内部动作 | 输出 |
|---|---|---|---|---|
| `agent/pre-step` | 每步进入 | 边缘模式 preset 的 scope | 攻击检测 → 策略预检 → 意图分类 → 脱敏 | decision（改写 messages 或 reject） |
| `agent/request` | 组装 LLM 请求 | 边缘模式 preset 的 scope | 检查降级标记，把 provider/model 改写到 LOCAL | AgentRequestConfig |
| `llm/stream` | 流式输出 text-delta | 全局 | 跨 chunk 累积占位符，flush 后还原 | 流式 chunk |

前两个是 **scope 绑定**：宿主按 scope 链向上派发，本插件的 scope 在边缘模式 preset 下，
标准模式的 Agent 收不到这些事件——标准模式是纯宿主行为。

`llm/stream` 保留全局：该事件不带 scope 载体，且无 pre-step 状态时恒直通。

**跨 hook 状态** `stepState: Map<sessionId, {...}>`。用 sessionId 字符串做键而不是
`WeakMap<Session>`：pre-step 拿到的是 agent 的 session 对象，llm/stream 拿到的是
请求信封上的 sessionId 字符串，不是同一个引用。

## 5.3 降级语义

**脱敏失败 → 降级 LOCAL**（`downgradeOnSanitizeFailure`，默认开启）：
标记 `downgraded`，不阻断 step，原始 PII 原样留在本地，`agent/request` 把路由改写到
本地模型。此时从一开始就没脱敏，也不存在需要还原的占位符。

关闭该开关时改为 fail-closed：直接 REJECT step，用户看到空结果。

**REJECT 绝不因 fail-open 而上云**：即便 `rejectOnPolicyViolation=false`，
REJECT 也会被降级到 LOCAL（审计 `input-guard.reject.degraded-local`）。

## 5.4 启动期检查

`enableInputGuard=true` 时，四个依赖服务（promptGuard / privacyPolicy / intentRouter /
sanitizer）任一缺失即**拒绝启动**——隐私管线缺组件时静默降级比不启动更危险。

---

# 阈值速查

| 阈值 | 默认值 | 配置面 |
|---|---|---|
| prompt-guard 输入长度上限 | 10000 | Schema（无配置面） |
| prompt-guard session 频率 | 20 / 分钟 | Schema |
| prompt-guard 全局频率 | 60 / 分钟 | 派生（session 上限 ×3，下限 60） |
| 模型检测超时 | 20000ms | `stages.guard.timeoutMs` |
| 模型检测输入上限 | 2000 | `stages.guard.maxInput` |
| Tier-1 采纳门（非 LOCAL） | 0.85 | `jev.confidenceThreshold` |
| Tier-1 采纳门（LOCAL 方向） | 0.50 | `jev.localAdoptFloor` |
| Tier-1 风险闸 | 0.70 | `jev.riskThreshold`（riskScore = score/3） |
| Tier-2 采纳门 | 0.60 | `stages.intent.confidenceThreshold` |
| 云闸语义解锁门 | 0.95 | `stages.intent.semanticCloudMinConfidence` |
| Tier-1 超时 | 2500ms | `jev.timeoutMs` |
| Tier-2 超时 | 30000ms | `stages.intent.timeoutMs` |
| 上下文条数 / 单条截断 | 3 条 / 200 字 | `stages.intent.recentLimit` |
| 分类器输入上限 | 2000 | `stages.intent.maxInput` |
| 结果缓存 | TTL 60s / 128 条 | 代码内 |
| sanitizer 占位符上限 | 1024 / session | Schema |
| sanitizer 会话 TTL | 900000ms（15min） | `privacy.sanTtlMs` |

> 配置优先级与生效值取决于部署现场是否有 `config/edge.json`；
> 仓库内只有 `config/edge.example.json` 模板。

---

# 配置速查

配置单一事实源是 `config/edge.json`（模板见 `config/edge.example.json`）。

```jsonc
{
  "stages": {
    "guard":  { "provider": "local-llm", "enabled": true, "timeoutMs": 20000, "maxInput": 2000 },
    "intent": {
      "provider": "local-llm", "timeoutMs": 30000, "confidenceThreshold": 0.6,
      "maxInput": 2000, "recentLimit": 3, "defaultCategory": "LOCAL",
      "cloudKeywords": [], "localEntities": [], "fallbackKeywords": [],
      "deviceCommands": { "devices": [], "actions": [] }
    }
  },
  "jev": {
    "enabled": true, "provider": "bailian-decision", "model": "decision-model-preview",
    "timeoutMs": 2500, "confidenceThreshold": 0.85, "riskThreshold": 0.7,
    "breakerTtlMs": 30000, "bootProbeEnabled": true
  },
  "privacy": {
    "inputGuardEnabled": true, "rejectPolicyEnabled": true, "sanitizeDowngradeEnabled": true,
    "policyHotReload": true, "policyWatchMs": 5000,
    "sanTtlMs": 900000, "sanMaxSessions": 1000, "sanSweepMs": 60000
  }
}
```

三个组件的关键配置：

| 组件 | 配置项 | 默认 | 位置 |
|---|---|---|---|
| prompt-guard | `enableModelDetection` | true | Schema |
| | `enableDeviceCommandFastPath` | true | Schema |
| | `modelDetectionProvider` | `local-llm` | Schema |
| | `modelDetectionModel` | 跟随 `llm.local.model` | 强制覆盖 |
| | `maxInputLength` / `maxRequestsPerMinute` | 10000 / 20 | Schema |
| | `rules` | `[]` | Schema |
| privacy-policy | `policyPath` | edge.json → `~/.dsh-edge-agent/` → bundle | 无 Schema 默认 |
| | `hotReload` / `watchIntervalMs` | true / 5000 | `privacy.*` |
| intent-router | `defaultCategory` | LOCAL | `stages.intent.*` |
| | `confidenceThreshold` | 0.6 | `stages.intent.*` |
| | `llmTimeoutMs` | 30000 | `stages.intent.timeoutMs` |
| | `recentMessagesLimit` | 3 | `stages.intent.recentLimit` |
| | `llmFallback` | true | `stages.intent.llmFallback` |
| | `jev*` | 见上表 | `jev.*` |
| sanitizer | `maxReplacementsPerSession` | 1024 | Schema（无外部覆盖） |
| | `sessionTtlMs` / `maxSessions` / `sweepIntervalMs` | 900000 / 1000 / 60000 | `privacy.san*` |
| | `enableAutoDetection` | true | 保留字段，当前无作用 |
| input-guard | `enableInputGuard` | true | `privacy.inputGuardEnabled` |
| | `sanitizeLocalTraffic` | false | Schema |
| | `rejectOnPolicyViolation` | true | `privacy.rejectPolicyEnabled` |
| | `downgradeOnSanitizeFailure` | true | `privacy.sanitizeDowngradeEnabled` |
| | `localProvider` / `localModel` | `local-llm` / 跟随 `llm.local.model` | 强制覆盖 |

**配置值的优先级**：部分键是「配置文件无条件覆盖」（如 `stages.intent.*`），
部分走 `fill()` 只在配置未定义时填（如 `jev.*`），部分由 Schema 兜底。
新增配置时确认落在哪一档，避免「配了不生效」。

---

# 审计事件速查

命名规律：`intent.<阶段>.<事件>` / `input-guard.<阶段>.<事件>` / `guard.<阶段>.<事件>`。

**security 级（SIEM 必须看到）**：

| 事件 | 含义 |
|---|---|
| `input.injection` | 命中 block 级注入规则 |
| `intent.rules.rejected` | REJECT 判定 |
| `intent.llm.sanitize-error` / `intent.llm.sanitize-unavailable` | 分类前脱敏失败（fail-closed） |
| `input-guard.sanitize.failed` / `input-guard.sanitize.downgraded` | 出网前脱敏失败 / 降级 |
| `input-guard.blocked.policy` / `.attack` / `.intent` | 拦截 |
| `llm.cloud.egress.blocked` | 出网前脱敏失败，不出网 |
| `policy.tamper-detected` | 策略文件签名校验失败 |

**计数（`getStats()`）**：意图识别 30 个计数器 + 10 桶置信度直方图，
覆盖各判定路径、失败归因、脱敏结果与决策模型健康度。
健康度判读：`parseFailure / (llmHit + lowConfidence + parseFailure + llmError)`
衡量分类器输出格式质量；`jevError` 上升是服务问题，`jevSkip` 上升是意图集不匹配。

---

# 已知边界

诚实记录当前**未实现或未接线**的部分，避免读者误以为有保护：

| 项 | 现状 |
|---|---|
| 姓名识别 | 未实现（需要 NER，当前只有正则） |
| `sanitize` 档注入规则 | 机制已实现，默认库 0 条；改写结果目前无跨组件消费方 |
| `checkOutput` 输出掩码 | 代码在，但当前无调用方 |
| `enableAutoDetection` | 保留字段，算法从不读取 |
| `replacement` 字段 | 保留在规则结构里，运行时忽略（占位符由 sanitizer 生成） |
| 回退策略的路由覆盖 | `DEFAULT_POLICY` 只有 3 条路由规则，PII 护栏不在其中 |
| `jev.localAdoptFloor` | 配置面已声明，但当前未接线到运行时 |
