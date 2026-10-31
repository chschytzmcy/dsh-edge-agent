# 隐私策略：输入防御、意图识别、脱敏与配置

> 本文是 `dsh-edge-agent` 隐私链路的**单一权威文档**：当前生效的策略是什么、
> 每条判据的原文长什么样、每个配置项叫什么默认值。
>
> 实现位置：`src/dsh-adapter/` 下的 `input-guard.ts`（编排）、`prompt-guard.ts`
> （输入防御）、`intent-router.ts`（意图识别）、`sanitizer-pipeline.ts` +
> `pii-utils.ts`（脱敏）、`privacy-policy.ts`（隐私策略）、`edge-config.ts`（配置）。
>
> 架构全景见 [architecture.md](architecture.md)；部署见
> [deploy-github.md](deploy-github.md) / [deploy-npm.md](deploy-npm.md) /
> [deploy-tarball.md](deploy-tarball.md)；历史存档见 [PROGRESS.md](PROGRESS.md)。

## 目录

**策略**

- [一句话概括](#一句话概括)
- [全链路总览](#全链路总览)
- [第一章 输入防御（prompt-guard）](#第一章-输入防御prompt-guard)
- [第二章 隐私策略（privacy-policy）](#第二章-隐私策略privacy-policy)
- [第三章 意图识别（intent-router）](#第三章-意图识别intent-router)
- [第四章 脱敏（sanitizer + pii-utils）](#第四章-脱敏sanitizer--pii-utils)
- [第五章 编排层（input-guard）](#第五章-编排层input-guard)

**判据明细**

- [附录 A：判定表](#附录-a判定表)
- [附录 B：正则与词表全文](#附录-b正则与词表全文)
- [附录 C：语义决策语句](#附录-c语义决策语句)

**速查**

- [阈值速查](#阈值速查)
- [配置清单](#配置清单)
- [审计事件速查](#审计事件速查)
- [行为契约](#行为契约)
- [已知边界](#已知边界)

---

# 策略

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
数据外传 1、中文扩展 10。全文见 [附录 B1](#b1-注入检测规则)。

**为什么角色覆盖类归 warn**：教育场景里「假设你是一个翻译器」「从现在开始你是英语老师」
是无害意图，不应阻断。

**扩展**：`config.rules` 追加自定义规则，固定带 `i` 标志；正则无效则跳过并审计
`guard.rule.invalid`。

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
白名单，原则是拿不准判安全。全文见 [附录 C3](#c3-注入语义层-prompt-guard-stage-6)。

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

正则原文见 [附录 B1](#b1-意图路由规则)。

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
| 5 | input-guard llm/stream | 未脱敏会话的输出 | 掩码兜底（不可逆） |

调用点 1–2 保护的是**分类器请求**（分类器可能落 CLOUD）；
调用点 3–4 保护的是**真正出网的载荷**。两层都在，缺一不可。
调用点 5 覆盖**用户可见的输出**：未走过 sanitizer 的会话（LOCAL-only，
或 CLOUD 但本轮没命中 PII）的回复原先一路直通，现在由 `prompt-guard.checkOutput`
做不可逆掩码（§7.163 补上的缺口）。

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
| `llm/stream` | 流式输出 text-delta | 全局 | 脱敏会话还原占位符；未脱敏会话做输出掩码 | 流式 chunk |

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

# 附录 A：判定表

按一条消息的生命周期组织，每个阶段列出判据与三种去向之一：
🚫 **拦截**（不生成回复）/ ☁️ **云端**（脱敏后出网）/ 💻 **本地**（本地池 + 本地工具）。

```
消息到达
  │
  ▼
┌─────────────── 第一阶段：入口安检（prompt-guard / td-bus）───────────────┐
│ 限流 → 截断 → 注入判定(正则26条|语义) → PII分级 → 业务REJECT预检 → 威胁门禁  │
│ → 【设备操作正则层】 → 语义检测(LLM,可关)                                  │
│   ✗ 任一命中 → 🚫 拦截（429 / 400 / 403 / 503）                          │
└──────────────────────────────────────────────────────────────────────────┘
  │ 通过
  ▼
┌─────────────── 第二阶段：意图路由（intent-router）────────────────────────┐
│ REJECT预检 → 缓存 → 【设备操作正则层】                                    │
│ → 决策模型(语义:choice+score) → LLM分类器(语义,可关) → 规则层(正则)        │
│ → 实体护栏(正则) → 云闸(正则+语义)                                        │
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
│ desanitize(正则,可逆还原) / 输出掩码(未脱敏会话) → 云请求记账 → 收尾       │
└──────────────────────────────────────────────────────────────────────────┘
```

## A.1 第一阶段：入口安检

| # | 决策 | 决策者 | 判据 | 去向 |
|---|---|---|---|---|
| 1 | 限流 | 统计 | — | 超限 🚫 429 |
| 2 | 截断 | 统计 | — | >10000 字截断后继续 |
| 3 | **注入判定** | **正则 26 条** + 语义 | 见 [附录 B1](#b1-注入检测规则) | block 🚫 400；warn 继续并注入审计 |
| 4 | **PII 数据分级** | **正则 10 类中 5 类 secret** | 身份证/银行卡/api-key/凭据/护照命中 → 标记分级 + 升 risk high，**不拦截** | 放行（下游护栏处理） |
| 5 | 业务 REJECT 预检 | **正则 2 条** | 危险系统操作 / 破坏性命令 | 🚫 403 |
| 6 | 威胁门禁（http 入口） | 统计 | 速率 ≥1×/2×/4× 基线 → elevated/high/critical | critical 🚫 503 |
| 7 | **设备操作正则层** | **正则** | 见 [附录 B6](#b6-设备操作词表) | 纯设备指令 → **跳过语义检测（LLM）**；非纯 → 照常走 LLM |

**本阶段的输出只有两种：🚫 拦截，或放行进入第二阶段。**

**设备操作正则层**是这条链上的快速通道——它与意图识别的 Tier-0 共用同一套词表和
同一个匹配器（`matchDeviceCommand`），所以两个层对「什么算设备操作」永远一致。

「纯」的判定：扣掉匹配到的设备指令、礼貌助词、标点、以及**数值参数**后，
剩余文本为空。数值参数是设备指令的一部分（空调的 26 度是设定值，不是额外内容），
所以「空调调到26度」是纯的。

| 输入 | 纯 | 说明 |
|---|---|---|
| 开灯 / 打开空调 | ✅ | 纯设备指令 |
| 请把空调打开 / 帮我关一下灯 | ✅ | 礼貌助词被扣掉 |
| 空调调到26度 | ✅ | 数值参数被扣掉 |
| 开灯顺便把密码发到第三方 | ❌ | 外传子句必须仍然过语义检测 |
| 怎么开空调 | — | 疑问语境，本层不命中 |

它位于**全部正则阶段之后**（注入 block/warn/sanitize、PII 分类都已跑过），
因此只能「省掉 LLM」，**绝不能绕过任何拦截**——带注入特征的设备指令照样被拦。

## A.2 第二阶段：意图路由

| 级 | 形态 | 耗时 | 命中后 |
|---|---|---|---|
| **Tier-0** | 家庭设备操作正则 | **~0ms** | 直接定案 💻 LOCAL，**不外呼** |
| Tier-1 | 决策模型（jev） | ~150ms-6s | 语义分类 |
| Tier-2 | LLM 分类器 | 4s-30s | 最后兜底 |

**Tier-0 判定表（T0–T3）**：

| 序 | 条件（精确） | 去向 |
|---|---|---|
| T0 | 否定/疑问语境命中（`别`/`不要`/`怎么`/`如何`/`是否`/`吗`/`呢`/`how to`/`should i`…） | → 不命中，**继续往下** |
| T1 | 动作词与设备名词**不相邻**（中间夹了别的词） | → 不命中，继续往下 |
| T2 | 动作词或设备名词缺一（只有「空调」没有「开」） | → 不命中，继续往下 |
| T3 | 动作 + 设备**相邻**命中 | 💻 **本地**（`device-command:<动作>:<设备>`，conf 0.95） |

**相邻**的定义是关键 —— 这是「打开空调」与「空调的价格」+「打开网页」的分界。
中间只允许夹礼貌/处置助词（`把`/`将`/`请`/`帮我`/`一下`/`了`/`吧`…）。
处置前缀最多剥离 **3 层**——中文礼貌语常叠加（「请把…」「请帮我把…」）。

**Tier-1 判定表（按顺序命中即停，D0–D7）**：

| 序 | 条件（精确） | 去向 |
|---|---|---|
| D0 | 断路器开（上次失败后 30s 内） | → 跳过决策模型，进 LLM |
| D1 | HTTP 非 200 / 超 `timeoutMs` / 解析失败 | → 跳过，进 LLM；断路器开 30s |
| D2 | `riskScore = risk.score/3` ≥ **0.70** | 🚫 **拦截（REJECT，403）** |
| D3 | choice 不在 categories id 集合（幻觉；LOCAL 恒可映射） | → 跳过，进 LLM |
| D4 | choice = **LOCAL** 且 conf ≥ **0.50** | 💻 **本地**（→ 后处理 P1/P2） |
| D5 | choice = LOCAL 且 conf < 0.50 | → 跳过，进 LLM |
| D6 | choice = **非 LOCAL** 且 conf ≥ **0.85** | ☁️/🚫 按类别（→ 后处理 P1/P2） |
| D7 | choice = 非 LOCAL 且 conf < 0.85 | → 跳过，进 LLM |

判决说明：choice 的 criteria key 就是类别 id——CLOUD ☁️、REJECT 🚫、LOCAL 💻。

**Tier-2 判定表（L1–L2）**：

| 序 | 条件 | 去向 |
|---|---|---|
| L1 | HTTP/超 30s/解析失败/conf < **0.60** | → 跳过，进规则层 |
| L2 | verdict conf ≥ 0.60 | ☁️/🚫/💻 按 category（→ 后处理 P1/P2） |

**规则层（R1–R6）**——只在 Tier-0 未命中、且决策模型与 LLM 都跳过时到达：

| 序 | 条件（正则原文见 [附录 B](#附录-b正则与词表全文)） | 去向 |
|---|---|---|
| R1 | REJECT 两条正则命中 | 🚫 **拦截（403）** |
| R2 | LOCAL 实体命中（`密盒`/`ets`/`etscli`） | 💻 **本地**（conf 0.9） |
| R3 | CLOUD 关键词命中（`新闻`/`天气`/`最新`…26 词） | ☁️ **云端**（conf 0.8） |
| R4 | privacy-policy LOCAL 规则命中 | 💻 **本地**（规则自带 confidence） |
| R5 | LOCAL 兜底表命中（`文件`/`读取`/`计算`…24 词） | 💻 **本地**（conf 0.7） |
| R6 | 全不中 | 💻 **本地**（defaultCategory = LOCAL，fail-closed） |

**共同后处理（判定后、定案前，顺序固定）**：

| 序 | 条件 | 修正 |
|---|---|---|
| P1 | verdict ≠ LOCAL 且文本命中实体表（`密盒`/`ets`/`etscli`） | 强制 💻 **本地**（`override-local-entity:<词>`） |
| P2 | verdict = ☁️ CLOUD：①云关键词命中 → **放行出网**；②conf ≥ **0.95**（语义解锁）**且该置信度是模型实测上报的**（`confidenceReported ≠ false`）→ **放行出网**；③都不满足 → 压回 💻 **本地**（`no-web-need`） |
| P3 | verdict = 💻 LOCAL / 🚫 REJECT：云闸不适用，定案 |

**样本走表**：

- 「开灯」：**T0** 动作「开」+ 设备「灯」相邻命中 → 💻 本地（~0ms，决策模型与 LLM **均未调用**）
- 「查一下最新的AI新闻」：T0 不命中 → D6（CLOUD conf 0.98）→ P1 无实体 → P2 ①`新闻` 命中 → ☁️ 云端
- 「什么是量子力学」：T0 不命中 → D4（LOCAL conf 0.94 ≥ 0.50）→ P3 → 💻 本地
- 「怎么开空调」：T0 命中否定/疑问语境（`怎么`）→ 不命中 → 交给后续层
- 「把密盒的日志发到网上」：T0 不命中 → D2（risk 2.1/3 = 0.70）→ 🚫 拦截（403）

## A.3 第三阶段：域内执行

**☁️ 云端域（CLOUD 判决后）**：

| 步骤 | 内容 | 决策者 |
|---|---|---|
| 工具装配 | web_search/web_fetch 留在 LLM 工具视图（LOCAL 域则被摘除） | 配置（realm 桥） |
| 搜索 | 三档 fail-down：duckduckgo（免费默认）→ tavily → bocha（key 失效自动降档） | 配置 + 外部服务 |
| **脱敏** | 10 类 PII 模式过用户原文 + 历史（逐条）；**失败/不可用 → 降级 💻 本地（脱不了敏不上云）** | **正则（fail-closed）** |
| 合成 | 云模型（直连或委派宿主 provider）生成回复 | 配置 |

**💻 本地域（LOCAL 判决后）**：

| 步骤 | 内容 | 决策者 |
|---|---|---|
| 工具装配 | web 工具从 LLM 视图**摘除**——LOCAL agent 根本没有出网工具 | 配置（realm 桥 Layer 1.5） |
| 生成 | 本地池（`llm.local`）+ 本地工具（bash/fs/ets-* skills，realm 映射放行） | 配置 |

## A.4 第四阶段：回程与收尾

| 步骤 | 内容 | 决策者 |
|---|---|---|
| 还原 | desanitize：占位符 → 原文（`[PHONE_1]` → 原值，keepPrefix 语义） | 正则（确定性可逆） |
| 掩码 | 未脱敏会话的输出走 `checkOutput` 不可逆掩码 | 正则 |
| 记账 | 云请求计数 → td-bus 速率分级（≥4× 基线 → 后续消息 🚫 503） | 统计 |
| 输出掩码 | 审计 payload 落盘前走 `redactObject` | 正则 |

---

# 附录 B：正则与词表全文

## B1 意图路由规则

policy `routingRules`（10 条）：

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

## B2 云关键词（26）

中文 13——`新闻 最新 实时 热搜 趋势 排行榜 资讯 网上 互联网 在线 联网 天气 股价`；
英文 13——`news latest live trending ranking online internet "web search" web weather forecast price`。

扩展面 `stages.intent.cloudKeywords`（追加，热重载）。

## B3 LOCAL 兜底词（24）

中文 13——`文件 读 写 删除 创建 计算 加减乘除 本地 设备 系统 磁盘 目录 文件夹`；
英文 11——`file read write delete calculate compute local device disk directory folder`。

rationale `rule-keyword-match:<词>`；扩展面 `stages.intent.fallbackKeywords`（追加）。

## B4 实体护栏（3）

`密盒 ets etscli`（CJK 子串 / ASCII 词边界）；扩展面 `stages.intent.localEntities`。

## B5 注入检测规则（26）

**block（18 条）**——按攻击类型：

| 类型 | 规则 | 正则 |
|---|---|---|
| 直接注入 | `direct-injection` | `ignore\s+(all\s+)?previous\s+instructions` |
| | `direct-injection-zh` | `忽略\s*(之前\|上面\|以上)\s*(的)?\s*(指令\|指示\|命令)` |
| | `disregard-en` | `disregard\s+(all\s+)?(prior\|previous\|above)\s+(instructions\|rules)` |
| 提示词泄漏 | `prompt-leak` | `show\s+me\s+(your\s+)?system\s+prompt` |
| | `prompt-leak-2` | `(repeat\|output\|print\|display)\s+(your\|the\|my)\s+(system\s+)?(prompt\|instructions\|rules\|configuration)` |
| | `prompt-leak-zh` | `(输出\|显示\|打印\|告诉\|说说)\s*(?:我\|你)?(?:的)?\s*(你的\|我的)?\s*(系统\|初始)?\s*(提示词\|指令\|配置\|prompt)` |
| 安全绕过 | `bypass-dan` | `DAN\s*(mode\|jailbreak\|do\s+anything\s+now)` |
| | `无限制模式-zh` | `(无限制\|不受限\|越狱\|解除限制\|开发者模式)` |
| | `bypass-developer-zh` | `(开发者模式\|调试模式\|diagnostic\s+mode)` |
| 数据外传 | `data-exfiltration-zh` | `(发送\|上传\|传输\|外发).*(外部\|外网\|外部服务器\|第三方)` |
| 中文扩展 | `direct-injection-zh-2` | `(?:忽略\|无视\|不遵守\|不要遵守\|不必遵守\|不理会\|不执行\|不要执行)\s*(?:(?:我的\|你的\|我们的\|所有\|全部\|任何\|每一条\|每一个\|以上\|之前\|以下\|这些\|那些\|上述\|上面\|这条\|那些)的?\s*){1,2}(?:指令\|规则\|约束\|命令\|限制)` |
| | `direct-injection-zh-3` | `(?:所有\|全部\|任何\|每一条\|每一个)\s*(?:指令\|规则\|约束\|限制)\s*(?:都\|全部\|统统)?\s*(?:忽略\|无视\|不遵守\|作废\|无效\|废除\|不要遵守\|无需遵守\|不理会)` |
| | `jailbreak-preamble-zh` | `(?:在(?:以下\|接下来\|之后\|下面)的?(?:对话\|回答\|回复\|会话\|互动)中\|从现在开始\|从这一刻起).*?(?:忽略\|无视\|忘记\|不遵守\|不要遵守\|跳过\|作废\|取消).*?(?:指令\|规则\|约束\|限制\|之前\|上面\|以上)` |
| | `override-possessive-zh` | `(?:(?:不要遵守\|不必遵守\|打破\|违反\|无视\|忽略\|废除\|取消\|作废).*?你的\s*(?:指令\|规则\|限制\|约束\|原则\|设定))\|(?:你的\s*(?:指令\|规则\|限制\|约束\|原则\|设定).*?(?:不要遵守\|不必遵守\|打破\|违反\|无视\|忽略\|废除\|取消\|作废))` |
| | `safety-bypass-zh` | `(?:没有任何\|没有任何的\|不存在\|取消\|去掉\|关掉\|删除\|移除)\s*(?:所有\|全部\|我的\|你的\|这些\|那些)?\s*(?:限制\|约束\|审查\|过滤\|安全规则)` |
| | `leak-zh-2` | `(?:告诉我\|说出\|念出\|念一下\|列出\|显示\|给我看\|给我\|展示\|把\|将).*?你的\s*(?:规则\|指令\|限制\|约束\|原则\|设定)` |
| | `leak-zh-3` | `(?:把\|给我看\|给我\|展示\|显示\|念出\|输出\|打印).*?(?:你的\|系统的)?\s*(系统)?\s*(提示(?:词\|语)\|prompt)` |
| | `leak-zh-4` | `(?:把\|将)?(?:上面\|之前\|以下\|之前说过的\|前面\|先前\|以上\|前文\|刚才)的?(?:对话\|回复\|回答\|历史\|内容\|消息\|消息记录).*?(?:复制\|粘贴\|写下来\|写出来\|打出来\|显示\|打印\|输出\|发给我\|贴出来\|给我看)` |

**warn（8 条）**：

| 规则 | 正则 |
|---|---|
| `role-override` | `you\s+are\s+now\s+(a\|an)\s+` |
| `act-as` | `act\s+as\s+(a\|an\|if)\s+` |
| `pretend` | `pretend\s+(to\s+be\|you(?:'re\|\s+are))\s+` |
| `role-override-zh` | `你(现在\|立即)?\s*(是\|变成\|扮演\|充当)\s*(一个\|一名)?` |
| `假设-zh` | `假设\s*(你\|你是\|你是一?个)` |
| `从现在开始-zh` | `从现在开始\s*(你\|你就是\|请你)` |
| `override-weak-zh` | `(?:违反\|打破\|跳过\|绕过\|回避\|破坏)\s*(?:这条\|那\|这些\|那些\|所有\|全部\|任何\|我的\|你的\|我们)?\s*(?:规则\|约束\|限制\|要求\|原则\|设定)` |
| `identity-warn-zh` | `(?:你是\|你(?:就是)?是)\s*(?:一个\|一名\|只是\|已经是)?\s*(?:没有(?:限制\|规则\|约束\|审查\|过滤)\|不受(?:限制\|约束)\|无法(?:拒绝\|限制))` |

## B6 设备操作词表

入口安检 §A.1 与意图路由 Tier-0 共用；源码 `src/dsh-adapter/intent-signals.ts`。

- **设备名词**（65）：中文 32——`空调 灯 电灯 台灯 落地灯 吊灯 吸顶灯 灯带 电视 窗帘 卷帘 风扇 电扇 加湿器 除湿机 空气净化器 净化器 热水器 洗衣机 冰箱 微波炉 烤箱 洗碗机 扫地机器人 门 门锁 锁 插座 开关 暖气 地灯 鱼缸`；英文 33——`air conditioner ac light lights lamp desk lamp ceiling light tv television curtain blinds fan humidifier dehumidifier air purifier purifier water heater washing machine washer fridge refrigerator microwave oven dishwasher robot vacuum vacuum door lock socket plug heater thermostat aquarium`。
- **动作词**（44）：中文 25 = 开关类 11（`打开 开启 开 启动 关上 关闭 关掉 关 停止 断开 熄灭`）+ 调参类 14（`调到 调高 调低 调暗 调亮 调节 调整 设置 设为 设定 切换 开到 开大 开小`）；英文 19——`turn on turn off switch on switch off start stop power on power off set adjust increase decrease dim brighten toggle open close lock unlock`。
- **否定/疑问词**（37，命中即放弃 Tier-0）：中文 26——`别 不要 不用 不必 无需 是否 要不要 能不能 可不可以 怎么 如何 为什么 怎样 怎么样 什么意思 什么是 吗 呢 能否 该不该 建议 介绍 解释 告诉我 查一下 查询`；英文 11——`should i how to how do why what is what's can you explain tell me about don't do not no need without`。
- **助词**（14，中间只允许夹这些）：前缀 7——`请 帮我 帮忙 给我 替我 把 将`；后缀 7——`一下 大点 小点 一点 吧 啊 了`。
- **扩展面**：`stages.intent.deviceCommands.{devices,actions}`（edge.json + policy，热重载，追加不替换）。

## B7 PII 模式（10 类）

| piiType | 分级 | 正则 |
|---|---|---|
| `id-card` | secret | `\b[1-9]\d{5}(?:19\|20)\d{2}(?:0[1-9]\|1[0-2])(?:0[1-9]\|[12]\d\|3[01])\d{3}[\dXx]\b` |
| `bank-card` | secret | `\b\d{16,19}\b` |
| `phone` | confidential | `\b1[3-9]\d{9}\b`（keepPrefix 7） |
| `email` | confidential | `[\w.-]+@[\w.-]+\.\w+` |
| `api-key` | secret | `(?:sk-(?:proj-\|ant-\|live-\|test-\|org-)?[a-zA-Z0-9]{20,}\|key-[a-zA-Z0-9]{16,}\|api[_-]?key[_-]?[a-zA-Z0-9]{16,})` |
| `credential` | secret | `(?:密码\|口令\|用户名\|账号\|账户\|passwd\|password\|pwd\|username\|account\|secret\|access[ _-]?token\|token\|api[ _-]?key)["' 　]{0,2}(?:[:：=]\|是\|为\|\s+is\s+)["' 　]?[^\s"'，,;；<>（）()]{3,64}` |
| `ip-address` | confidential | `(?<![vV\d.])(?:(?:25[0-5]\|2[0-4]\d\|1\d{2}\|[1-9]?\d)\.){3}(?:25[0-5]\|2[0-4]\d\|1\d{2}\|[1-9]?\d)(?!\.?\d)` |
| `mac-address` | confidential | `(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}` |
| `passport` | secret | `\b(?:E[0-9A-Z]\d{7}\|G\d{8})\b` |
| `license-plate` | confidential | `[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤川青藏琼][A-Z][A-HJ-NP-Z0-9]{5}` |

---

# 附录 C：语义决策语句

## C1 决策模型题目（bailian-decision）

`intent` 的 criteria 由 policy `categories[]` 自动生成（`categories` 有几行生成几行；
无 LOCAL 行时代码自动补 catch-all 兜底）：

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

响应形状：

```jsonc
{
  "answers": {
    "intent": { "type": "choice", "choice": "CLOUD", "confidence": 0.983, "probabilities": { "…": "…" } },
    "risk":   { "type": "score", "score": 0.29, "legend": { "…": "…" }, "confidence": 0.91 }
  },
  "usage": { "input_tokens": 125 }, "latency_ms": 47.3
}
```

## C2 LLM 分类器 prompt（intent-router）

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

## C3 注入语义层 prompt（prompt-guard Stage 6）

system prompt 分两大类：

- **TYPE 1 语义攻击五类**：指令覆盖、越狱、提示词泄漏、数据外传、混淆 payload
- **TYPE 2 危险内容五类**：武器、暴力、违法、自残、未成年人
- **UNSAFE 五条** / **SAFE 白名单六条**（「查看系统信息」…「查询AI新闻」）
- **PRINCIPLE**：拿不准判 safe
- 判决格式 `{"safe",threats,dataClass,rationale}`

user 模板：`Classify the following user input…<<<…>>>`（`<<<` 分隔符隔离用户文本）。

## C4 本地 ONNX jev

`POST {jevUrl}/predict`（provider=`local`）：
`{query, lang:'zh', metadata, intents[]（categories.jevIntents 去重分批≤16），chitchat_intents:['闲聊','其他']}`。

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
| 输出掩码尾部待定区 | 128 字符 | 代码内（覆盖最长 PII 规则） |

> 配置优先级与生效值取决于部署现场是否有 `config/edge.json`；
> 仓库内只有 `config/edge.example.json` 模板。

---

# 配置清单

## 0. 配置归一

`dsh-edge-agent` 只通过**一个文件**配置 —— `config/edge.json`。旧的 `.env` /
`.env.sh` 两条链（裸名 env → `.env.sh` 派生 `DSH_EDGE_*` → cordis patch 读
`process.env`）已删除。

**查找顺序**（与 profile 无关，desktop / tui / web / edge 一致）：

```
1. <bundle>/config/edge.json     ← 仓库 checkout 或 bundle 自带副本
2. ~/.dsh-edge-agent/edge.json   ← install.sh 部署的用户副本（可改）
3. <bundle>/config/edge.example.json  ← shipped 模板（空 secret + 默认值）
```

模板见 [config/edge.example.json](../config/edge.example.json)（tracked）。
**切勿提交 `config/edge.json`** —— 它含明文 API key，已在 `.gitignore` 里。

> ⚠️ **桌面版的实际落位**：git / npm 装法都**不会**把 `config/edge.json` 带进包里
> ⇒ 装完要写 `~/.dsh-edge-agent/edge.json`（第 2 顺位）。只有「本地目录」装法
> （符号链接整个目录）才落在第 1 顺位。详见
> [`deploy-github.md` §4](deploy-github.md) 与
> [`deploy-npm.md` §9.1](deploy-npm.md)。

配置读取的唯一入口是 `src/dsh-adapter/edge-config.ts`。

## 1. Secret

`secrets` 段存明文 key，池通过 `keyRef` 指向它：

```jsonc
{
  "secrets": { "dashscopeApiKey": "sk-..." },
  "llm": { "local": { "baseUrl": "https://...", "model": "qwen3.6-flash", "keyRef": "dashscopeApiKey" } }
}
```

> **Secret 警告**：`config/edge.json` 含明文 API key，**绝不能提交到 git**。

## 2. 通用配置

| 变量 | 默认值 | 取值范围 | 说明 |
|---|---|---|---|
| `DSH_EDGE_LANG` | `zh` | `zh` / `en` | 启动器消息语言（不影响 agent 内容语言） |
| `DSH_EDGE_WORKSPACE` | 当前目录 | 任意路径 | 工作目录 |
| `DSH_EDGE_RESUME_SESSION` | — | session id | 通过 `--resume` 设置 |
| `DSH_EDGE_PERMISSION_MODE` | `workspace-write`（部署默认）/ `ask`（Schema 默认） | `ask` / `workspace-write` / `danger-full-access` | 权限模式 |

## 3. TEE 配置

| 变量 | 默认值 | 取值范围 | 说明 |
|---|---|---|---|
| `DSH_EDGE_TEE_TYPE` | `simulated` | `simulated` / `trustzone` / `keystone` / `sgx` | TEE 后端类型 |
| `DSH_EDGE_TEE_INFERENCE` | `false` | `true` / `false` | 是否在 TEE 内执行 LLM 推理 |
| `DSH_EDGE_SECURE_MEM` | `67108864` | 字节数 | 安全内存上限 |

`DSH_EDGE_TEE_TYPE` 取值：`simulated`（默认，纯 JS，仅开发/CI）、
`trustzone`（ARM，生产推荐）、`keystone`（RISC-V）、`sgx`（Intel，服务器测试）。

> ⚠️ TEE 相关能力目前是**桩实现**（crypto 返回零字节、网关恒返回 200），
> 尚未接入真实 TEE 与 RFC 9458 中继。**当前真正生效的隐私保证来自 Layer 2**
> （脱敏管线 + 策略引擎 + 审计链 + Realm 闸门）。分层状态表见
> [`architecture.md`](architecture.md)。

## 4. 存储配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_STORAGE_ROOT` | `~/.dsh-edge-agent/storage` | 存储根目录 |
| `DSH_EDGE_STORAGE_FILE` | `storage.plain.jsonl` | JSONL 存储文件名（未加密；AES-256-GCM 加密见 [Planned](PROGRESS.md#planned)） |

## 5. 策略配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_PRIVACY_POLICY_PATH` | `~/.dsh-edge-agent/privacy-policy.json` → 随包发布的 `config/privacy-policy.json` | 隐私策略文件路径（三级回退，见下） |
| `DSH_EDGE_REALM_HOT_RELOAD` | `true` | realm 配置热重载开关（不重载策略文件本身） |

策略文件按顺序回退，取第一个存在的：`config/edge.json` 的 `privacy.policyPath` →
`~/.dsh-edge-agent/privacy-policy.json`（运行员副本）→ 随包发布的
`config/privacy-policy.json`（version 1.9.0）。策略文件缺失或解析失败时回退到
代码内置的 `DEFAULT_POLICY`（3 条路由规则 + 完整 10 条脱敏规则）。

## 6. 路由与隐私栈配置

> **配置真相源是 `config/edge.json`**（模板见 `config/edge.example.json`）——
> 下面的环境变量只是它的 env 桥接面，且**只有列出的这些有实际消费方**。
> 未列出的变量设置了也不生效。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_INTENT_CONFIDENCE_THRESHOLD` | `0.6` | LLM 分类置信度门槛；低于此值降级到规则层 |
| `DSH_EDGE_GUARD_MODEL` | `true` | 是否启用 prompt-guard 模型辅助检测 |
| `DSH_EDGE_GUARD_MODEL_PROVIDER` | `local-llm` | 模型辅助检测 provider route（**不得指向云模型**） |
| `DSH_EDGE_GUARD_MODEL_MODEL` | 跟随 `llm.local.model` | 模型辅助检测 model id |
| `DSH_EDGE_GUARD_MODEL_TIMEOUT_MS` | `20000` | 模型辅助检测单次超时（毫秒） |
| `DSH_EDGE_GUARD_MODEL_MAX_INPUT` | `2000` | 超过此字符数则跳过模型检测（fail-open） |
| `DSH_EDGE_INTENT_PROVIDER` | `local-llm` | 意图分类 provider |
| `DSH_EDGE_INTENT_MODEL` | 跟随 `llm.local.model` | 意图分类 model id |
| `DSH_EDGE_INTENT_LLM_TIMEOUT_MS` | `30000` | 意图分类单次 LLM 超时（毫秒） |
| `DSH_EDGE_INTENT_RECENT_LIMIT` | `3` | 上下文 recent-messages 数量 |
| `DSH_EDGE_INTENT_MAX_INPUT` | `2000` | 超过此字符数则截断后再分类 |
| `DSH_EDGE_INTENT_FALLBACK_KEYWORDS` | （空） | LOCAL 兜底关键词追加（逗号分隔，追加不替换） |
| `DSH_EDGE_INTENT_JEV_CONFIDENCE_THRESHOLD` | `0.85` | 决策模型采纳门（非 LOCAL 方向） |
| `DSH_EDGE_INTENT_JEV_LOCAL_ADOPT_FLOOR` | `0.5` | 决策模型采纳门（LOCAL 方向） |
| `DSH_EDGE_INTENT_JEV_RISK_THRESHOLD` | `0.7` | 决策模型风险闸（riskScore = score/3） |
| `DSH_EDGE_INTENT_JEV_TIMEOUT_MS` | `2500` | 决策模型超时 |
| `DSH_EDGE_INTENT_JEV_BREAKER_TTL_MS` | `30000` | 决策模型断路器开启时长 |
| `DSH_EDGE_INTENT_JEV_BOOT_PROBE_ENABLED` | `true` | 启动健康探针 |
| `DSH_EDGE_INTENT_JEV_BOOT_PROBE_TIMEOUT_MS` | `2000` | 启动探针超时 |
| `DSH_EDGE_INTENT_JEV_BREAKER_PROBE_MS` | `5000` | 断路器恢复探针间隔 |
| `DSH_EDGE_INTENT_JEV_PROBE_TIMEOUT_MS` | `1000` | 恢复探针超时 |
| `DSH_EDGE_INPUT_GUARD` | `true` | 隐私管线总开关 |
| `DSH_EDGE_REJECT_POLICY` | `true` | 策略违规是否阻断 |
| `DSH_EDGE_SANITIZE_DOWNGRADE` | `true` | 脱敏失败降级 LOCAL（`false` 则 REJECT step） |
| `DSH_EDGE_SAN_TTL_MS` | `900000` | sanitizer 会话映射 TTL |
| `DSH_EDGE_SAN_MAX_SESSIONS` | `1000` | 同时保留的最大会话数（LRU 淘汰） |
| `DSH_EDGE_SAN_SWEEP_MS` | `60000` | 后台清扫间隔 |

## 7. 模型配置

模型池在 `config/edge.json` 的 `llm.local` / `llm.cloud` 段配置，无独立环境变量。

### 7.1 本地 LLM（`llm.local`）

| 字段 | 默认值 | 说明 |
|---|---|---|
| `llm.local.baseUrl` | （空 = 不注册） | OpenAI 兼容端点 URL，**必须含 `/v1`**（adapter 只追加 `/chat/completions`） |
| `llm.local.model` | `qwen3-4b` | 端点 model id |
| `llm.local.keyRef` | （空 = 不发 auth 头） | 指向 `secrets` 段里的键名 |
| `llm.local.stripTools` | `false` | 省略 `body.tools`（minicpm Jinja2 bug 规避） |
| `llm.local.enableThinking` | `false` | 关掉 thinking-model 的 chain-of-thought |
| `llm.local.reasoningEffortNone` | `false` | **ollama 池必开** —— 见下 |

`local-llm-adapter` 始终走真实 OpenAI 兼容端点。端点指向任一 llama.cpp /
vLLM / Ollama / DashScope 实例：

```jsonc
{
  "llm": {
    "local": {
      "baseUrl": "http://192.168.66.195:8701/v1",
      "model": "qwen3-4b-instruct-2507",
      "keyRef": "dashscopeApiKey"   // 指向 secrets 段里的键名；无鉴权则留空
    }
  }
}
```

> `llm.local.baseUrl` **留空 = 不注册本地 LLM 路由**（模型列表里不出现
> `local-llm`，意图分类 / prompt-guard 自动降级到关键词 / 正则规则档）。

> **ollama 用户注意**：ollama 的 `/v1` 兼容层**静默丢弃** `chat_template_kwargs`
> 和顶层 `think:false`，只有 `reasoning_effort:"none"` 生效。不开这个开关，
> thinking 会吃满 `max_tokens` → `content` 为空 → 攻击检测 json-parse-failed
> **静默落回正则档**（实测 24.6s → 6.5s）。
>
> ```json
> "local": {
>   "baseUrl": "http://<host>:11434/v1",
>   "model": "<ollama 里实际的 tag>",
>   "keyRef": "",
>   "reasoningEffortNone": true
> }
> ```
>
> 严格网关（OpenAI 官方风格）不认这个参数会返 400，保持 `false`。

> **改完要重启**：`baseUrl` / `model` / `reasoningEffortNone` 都在 adapter
> 构造时冻结，改配置文件不触发重新注册。桌面版需**完全退出 DSH App 进程**再打开。

### 7.2 云端 LLM（不配即 DELEGATE 到宿主 profile 提供商）

| 字段 | 默认值 | 说明 |
|---|---|---|
| `llm.cloud.baseUrl` | （空 = DELEGATE） | 自研直连的 OpenAI 兼容端点 |
| `llm.cloud.model` | （空） | 直连模式 model id |
| `llm.cloud.keyRef` | （空） | 指向 `secrets` 段里的键名 |
| `llm.cloud.delegate` | `true` | `false` 禁用委托：云不可用 → input-guard 降级 LOCAL（LOCAL-only 部署用） |
| `llm.cloud.delegateProvider` | （自动） | 显式锁定委托目标路由 id（如 `qwen-token-plan-cn`） |
| `llm.cloud.delegateModel` | （跟随宿主选择） | 委托 wire model override |

配置 `llm.cloud.baseUrl` 即切回自研直连。

## 8. 出站配置

| 变量 | 默认值 | 取值范围 | 说明 |
|---|---|---|---|
| `DSH_EDGE_BRIDGE_MODE` | `ohttp` | `ohttp` / `tls` / `auto` | 出站模式 |
| `DSH_EDGE_BRIDGE_ALLOW` | — | 域名列表 | 允许的域名（逗号分隔） |
| `DSH_EDGE_BRIDGE_DENY` | — | 域名列表 | 拒绝的域名（逗号分隔） |
| `DSH_EDGE_BRIDGE_TIMEOUT_MS` | `30000` | 毫秒数 | 请求超时 |

**OHTTP**：`DSH_EDGE_OHTTP_RELAY` / `_TARGET` / `_PUBKEY` / `_KEY_ID`，
以及 `DSH_EDGE_ALLOW_FALLBACK_TLS`（默认 `false`，OHTTP 不可用时是否允许回退到 TLS）。

## 9. 审计与威胁检测

**审计日志**

| 变量 | 默认值 | 取值范围 | 说明 |
|---|---|---|---|
| `DSH_EDGE_AUDIT_LEVEL` | `info` | `debug` / `info` / `warn` / `error` / `security` | 最小日志级别 |
| `DSH_EDGE_AUDIT_SENSITIVE_FIELDS` | — | 字段名列表 | 视为敏感的字段（逗号分隔） |
| `DSH_EDGE_AUDIT_ALERTS` | `true` | `true` / `false` | 是否启用告警 |
| `DSH_EDGE_AUDIT_CLOUD_RATE` | `20` | 数字 | 每分钟云端请求告警阈值 |
| `DSH_EDGE_AUDIT_SAN_FAIL` | `3` | 数字 | 脱敏失败告警阈值 |
| `DSH_EDGE_AUDIT_PERM_DENIED` | `5` | 数字 | 权限拒绝告警阈值 |
| `DSH_EDGE_AUDIT_FLUSH_MS` | `500` | 毫秒数 | 刷新间隔 |

**威胁检测**：`DSH_EDGE_TD_WINDOW`（60 秒）、`DSH_EDGE_TD_CLOUD_RATE`（20）、
`DSH_EDGE_TD_SAN`（3）、`DSH_EDGE_TD_PERM`（5）。

### 9.1 详细 LLM 追踪（写进 ops log）

ops log 默认只记 LLM 调用的**长度**。要看「到底发了什么、回了什么」，用这组配置把
**脱敏 + 截断后的**完整 request / response 写进 ops log：

```jsonc
{
  "audit": {
    "llmTrace": {
      "enabled": true,          // 总开关
      "includeRequest": true,   // 逐条 message 的角色 / 正文 / 工具回显
      "includeResponse": true,  // 正文 + tool calls + finish reason
      "maxChars": 2000,         // 单字段字符上限（溢出显式标注 …[+N chars]）
      "maxMessages": 12,        // 只保留最近 N 条 message
      "redactPii": true,        // 走 pii-utils 的 10 类 PII 规则
      "redactSecrets": true     // 盖住厂商前缀密钥（sk-cp- / sk-ws- / tvly- …）
    }
  }
}
```

> `redactSecrets` 不是多余的：pii-utils 的 api-key 规则**匹配不到**
> `sk-cp-…` / `sk-ws-…` / `tvly-…` 这类带厂商前缀的密钥。
>
> 改完 `config/edge.json` 即时生效（`loadEdgeConfig()` 带 mtime+size 指纹缓存），
> 不需要重启进程。

### 9.2 Edge 面板的原始判断数据

桌面版 Edge 标签把一轮判定拆成六个节点（攻击检测 → 意图判定 → PII 脱敏
→ 路由决策 → 答案出口 → 威胁监控）。每个节点除结论外都给出**原始依据**：

| 节点 | 原始依据 |
|---|---|
| 攻击检测 | 命中的注入规则名 + 该规则的**正则原文**；模型判「安全」的**理由原文**；不安全轮的**威胁类型** |
| 意图判定 | **本轮实际裁决者**（决策模型 / LLM 分类器 / 缓存 / 关键词规则）、命中**关键字**、语义说明、决策路径机器码、决策模型的原始 `intent` / `confidence` / `riskScore`、分类器的**真实落点**（含「本机 / 不在本机」标注） |
| PII 脱敏 | 命中的 **PII 规则类型**（phone / id-card / email …）+ 替换成的**占位符** |
| 路由决策 | 改写的**机器原因码**（译文与原码并列）、改写前的原路由来源 |
| 答案出口 | 真实出口的原始字段（route / durationMs / promptLen / resultLen）；**作答中**与**作答失败**是两个独立状态，不笼统写成「路由未定」 |
| 威胁监控 | 本轮检了多少条信号；限流时区分全局档 / 会话档 |

> 命中明细（规则名 / PII 类型 / 占位符）都是**规则标识符**，不含用户原文。
> PII 的原文永不进 audit —— 占位符是明文 PII 的映射键，值不落盘。

## 10. 工具配置

**本地工具**：`DSH_EDGE_LOCAL_TOOLS_ALLOW`（允许的路径前缀）、
`DSH_EDGE_LOCAL_TOOLS_WRITE`（`false`）、`DSH_EDGE_LOCAL_TOOLS_MAX`（10485760 字节）。

**Web 搜索**：`DSH_EDGE_WEB_BACKEND`（`duckduckgo` / `brave` / `custom`）、
`DSH_EDGE_WEB_MAX`（8）。

## 11. 语音输入

`DSH_EDGE_VOICE_MODEL`（`~/.dsh-edge-agent/models/whisper-tiny.bin`）、
`DSH_EDGE_VOICE_VAD`（0.6 秒）、`DSH_EDGE_VOICE_SR`（16000）。

## 12. 插件配置

`DSH_EDGE_PLUGINS_THIRD_PARTY`（`false`）—— 是否允许第三方插件。

## 13. HTTP API（可选）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_HTTP_HOST` | `0.0.0.0`（部署默认）/ `127.0.0.1`（Schema 默认） | HTTP 服务器绑定地址 |
| `DSH_EDGE_HTTP_PORT` | `21017` | HTTP 服务器端口 |
| `DSH_EDGE_HTTP_BEARER` | — | Bearer token（如不设则禁用） |
| `EDGE_API_KEY` | — | API 鉴权密钥（注入到 `DSH_EDGE_HTTP_BEARER`） |

## 14. 遥测

`DSH_EDGE_TELEMETRY`（`false`）—— 是否启用 DSH 遥测。

## 15. 会话

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_EDGE_SESSION_ROOT` | `~/.dsh-edge-agent/sessions` | 会话 JSONL 根目录 |
| `DSH_EDGE_SESSION_TTL` | `3600` | 默认 TTL（秒） |
| `DSH_EDGE_MAX_SESSIONS` | `8` | 最大并发会话数 |
| `DSH_EDGE_SESSION_WINDOW_SIZE` | `32` | 意图路由的会话窗口大小 |

## 16. Bash

`DSH_EDGE_BASH_TIMEOUT_MS`（`60000`）—— Bash 命令超时（毫秒）。

## 17. 通过 cordis.yml 覆盖

环境变量会设置默认值，但你可以通过 `cordis.patch.yml` 覆盖任何配置：

```yaml
- id: tcm
  config:
    teeType: trustzone
    keyStorePath: /opt/secure/keys
    teeInference: true
    secureMemoryLimit: 134217728  # 128 MiB
```

**优先级**：`cordis.yml` > 环境变量 > Schema 默认值

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

# 行为契约

以下几条是**行为契约**，配置改不了它们：

- **REJECT 永不出网**：策略规则或分类器判下的 REJECT 绝不会被改写成 CLOUD ——
  fail-closed（默认）直接拦下，fail-open 也只降级到 LOCAL 留在设备上继续，
  且仍会注册 session realm。
- **面板不得断言与数据相矛盾的事**：Tier-0 设备指令正则裁决的一轮显示
  「设备指令正则裁决」，不会谎称「LLM 裁决」（分类器压根没被调用）。
- **「是否出网」的判据是 category（哪个池），不是端点落在哪台机**：
  `category=LOCAL` 即**不算出公网** —— `llm.local` 池是 operator 自有设施，
  端点不在本机也照样不出网。
- **出网只带云段历史**：发往 `cloud-llm` 的请求**只携带之前所有上过 cloud-llm 的历史**；
  任何 local-llm 段的历史会话信息一律不带。`local-llm` 反过来携带**全部**历史。
  保留块出网前还会再脱敏一次（可逆占位符），脱敏失败则 fail-closed 不出网。
  分段依据是宿主给每条 assistant 消息打的 `source.provider`（路由 id）。
- **答案出口只认本对话的出网**：插件自己也调 LLM —— 入口安检、意图分类器、
  宿主的会话标题生成 —— 它们与主对话走**同一个** adapter，落**同样**的
  `llm.local.start` 审计行。出口审计行带 `internal` 与 `tools` 两个判别字段，
  面板据此把内部调用排除在「答案出口」之外。
- **LLM 调用记录按类别分组、请求响应成对**：Edge 标签页底部的「LLM 调用」板块按
  **攻击检测 / 意图判定 / 路由决策 / 宿主内部调用**分组，每次往返的**请求在上、
  响应在下**成对显示。配对靠 `callId`。

> **路由机制本身**（三层兜底 / 实体护栏 / DELEGATE 链 / 三档搜索 fail-down）
> 见 [`architecture.md`](architecture.md) 与本文档第二章、第三章。

---

# 已知边界

诚实记录当前**未实现或未接线**的部分，避免读者误以为有保护：

| 项 | 现状 |
|---|---|
| 姓名识别 | 未实现（需要 NER，当前只有正则） |
| `sanitize` 档注入规则 | 机制已实现，默认库 0 条；改写结果目前无跨组件消费方 |
| `enableAutoDetection` | 保留字段，算法从不读取 |
| `replacement` 字段 | 保留在规则结构里，运行时忽略（占位符由 sanitizer 生成） |
| 回退策略的路由覆盖 | `DEFAULT_POLICY` 只有 3 条路由规则，PII 护栏不在其中 |
| 策略文件签名 | 未设 `DSH_EDGE_POLICY_HMAC_KEY` 时不校验（开发/CI 默认） |
| 输出掩码的跨 chunk 边界 | 尾部待定区 128 字符；比这更长的单条 PII 理论上可能跨块漏检 |
| `model-selection` 历史通知 | 宿主在模型切换时往会话历史追加一条 `[model changed: …]`。LOCAL 轮因「路由改写 + 轮末选择还原」每轮触发一次 ⇒ **跨轮消息数每轮 +3**（第三条就是这条通知）。它只点名 provider/模型名，**不含任何对话内容**；出网裁剪守卫**不删**它（云端请求里会保留，按 §7.151 的说法属「陈述过时」而非泄露） |

---

# 相关文档

- [`architecture.md`](architecture.md) — 架构、Realm 模型、威胁模型、插件开发
- [`deploy-github.md`](deploy-github.md) — 从 GitHub 仓库地址安装（配置落位见 §4）
- [`deploy-npm.md`](deploy-npm.md) — 从 npm 包名安装（配置落位见 §9.1）
- [`deploy-tarball.md`](deploy-tarball.md) — 从 tarball 路径安装
- [`load-into-local-dsh.md`](load-into-local-dsh.md) — 装进本地 DSH
- [`plugin-mount-points.md`](plugin-mount-points.md) — 插件挂载点清单
- [`version-policy.md`](version-policy.md) — 上游版本策略
- [`PROGRESS.md`](PROGRESS.md) — 实施进度档案（§7.x 全量历史）
