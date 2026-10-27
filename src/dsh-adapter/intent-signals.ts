/**
 * intent-signals — the STRATEGY DATA for the intent router.
 *
 * §7.123 (2026-10-27): these tables used to live inside `intent-router.ts`
 * (2923 lines), mixed with the decision LOGIC. Separating "what counts as a
 * public-web signal" (data) from "how the verdict is reached" (logic) means:
 *
 *   - a reviewer can audit the routing vocabulary without reading the
 *     classifier machinery;
 *   - the tables can be unit-tested directly (they used to be reachable
 *     only through a 2200-line class);
 *   - adding a domain (旅游攻略, 行情, …) touches ONE file instead of a
 *     130 KB module.
 *
 * These are BUILT-IN defaults. The operator-extensible surfaces live in
 * `config/privacy-policy.json` (`stages.intent.cloudKeywords` /
 * `localEntities` / `fallbackKeywords`) and in `config/edge.json`; the
 * built-ins are the last-resort / fast-path layer.
 *
 * @module dsh-edge-agent/intent-signals
 */

import type { IntentCategory } from './privacy-policy.js'

/** Built-in last-resort LOCAL keyword list (EN + CN). Used only when
 *  privacy-policy is absent / empty AND `config.fallbackKeywords` is unset.
 *  Users override via env `DSH_EDGE_INTENT_FALLBACK_KEYWORDS` (comma-sep). */
export const LOCAL_KEYWORDS_DEFAULT: readonly string[] = [
  '文件', '读', '写', '删除', '创建', '计算', '加减乘除',
  '本地', '设备', '系统', '磁盘', '目录', '文件夹',
  'file', 'read', 'write', 'delete', 'calculate', 'compute',
  'local', 'device', 'disk', 'directory', 'folder',
]

/** §7.47 (2026-09-12): Built-in CLOUD keyword list. Matched BEFORE
 *  fallbackKeywords in classifyWithRules so queries that obviously need
 *  web/search (新闻 / news / 最新 / latest / 今天 / today / 实时 / live /
 *  趋势 / trend / 排行榜 / ranking) go straight to CLOUD, without
 *  depending on the LLM classifier (which can hang on Qwen3-4B).
 *  Users extend via env `DSH_EDGE_INTENT_CLOUD_KEYWORDS` (comma-sep) —
 *  appended to built-in (NOT replaced). Lower priority than privacy-policy
 *  rules (which can REJECT) but higher than fallbackKeywords (which is
 *  LOCAL-only).
 *  §7.58 (2026-09-16): bare query VERBS (搜索/查询/查找/搜/查, search) were
 *  REMOVED from the built-in list. A verb is a query *action*, not an
 *  online-object signal — it fires on local questions too ("查询密盒登录状态"
 *  was mis-routed CLOUD by `rule-cloud-keyword:查询`, 2026-09-15 incident;
 *  any "检查一下设备" trips the single-char "查"). Verb-only queries now fall
 *  through to the LOCAL keyword list → defaultCategory (fail-closed,
 *  LOCAL as of §7.107), with the LLM classifier (when alive) doing the
 *  nuanced work. Online OBJECT nouns (新闻/最新/热搜/news/latest/…) stay
 *  as-is — they are the public-web signal that unlocks the cloud. */
export const CLOUD_KEYWORDS_DEFAULT: readonly string[] = [
  // 中文: 信息获取类信号词（§7.58: 只留对象/时间名词，不留裸动词）
  //
  // §7.107 (2026-10-23): this list is now the DEFINITION of "需要搜索公网上的
  // 信息" — the operator's ruling「只有需要搜索公网上的信息才需要用到
  // cloudllm」. It gates the classifier's CLOUD verdict (input-guard's
  // `cloud.blocked-no-web-need`), so a word in this list means "this may
  // leave the device" and a word NOT in it means "it may not".
  //
  // That made the ambiguous single words a liability: 「今天」("今天开会吗")
  // 「消息」("发个消息给张三") 「进展」「动态」("项目动态") are ordinary
  // device-side wording that used to cost a cloud round-trip. The specific
  // web readings survive through their companions — 最新消息 → 最新,
  // 今日新闻 → 新闻, 股市动态 → 行情.
  '新闻', '最新', '实时', '热搜', '趋势', '排行榜', '资讯',
  '网上', '互联网', '在线', '联网',
  '天气', '股价',
  // English: information-acquisition signals
  'news', 'latest', 'live', 'trending', 'ranking',
  'online', 'internet', 'web search', 'web',
  'weather', 'forecast', 'price',
]

/** §7.58 (2026-09-16): product/device entities that physically live behind
 *  LOCAL skills only (realm table: ets-* = LOCAL). Matched FIRST in
 *  classifyWithRules — above CLOUD strong keywords and the generic LOCAL
 *  fallback — and re-checked as a deterministic override after an
 *  LLM-classified non-LOCAL verdict (the qwen classifier answered CLOUD
 *  conf=1 for "查询共登陆了几个密盒": it cannot know which realms own
 *  which resources). CJK entries match as substrings; ASCII entries match
 *  with word boundaries so 'ets' cannot fire inside "assets". Extend via
 *  env `DSH_EDGE_INTENT_LOCAL_ENTITIES` (comma-sep) — appended to
 *  built-in, same semantics as cloudKeywords. */
export const LOCAL_ENTITY_KEYWORDS_DEFAULT: readonly string[] = [
  '密盒', 'ets', 'etscli',
  // 注：§7.106 曾把「归属地」加进本表以强制本地（当时认为全量脱敏会让号码
  // 归属查询任务失效）。操作者裁决 2026-10-23：这类查询**走云端是对的**——
  // 真正的问题是掩码粒度，改为号段部分脱敏（phone 保留前 7 位，policy
  // keepPrefix），云端拿到「号段+占位符」仍可查归属地。
]

/** §7.92.5 (2026-09-23): jev v0.3.0 hard cap on the `intents[]` payload
 *  field per `~/work/jev-branch/docs/api_reference.md §3.7`. ONNX model
 *  has `head_max_len=256`, which translates to ~16 intents × ~16
 *  description tokens. Source of truth is the upstream spec — bump this
 *  constant if jev ever relaxes the cap. */
export const JEV_MAX_INTENTS = 16

/** §7.92.3 (2026-09-23): hardcoded built-in fallback for the
 *  categories spec. Used ONLY when neither `config.categories` is set
 *  nor `ctx.privacyPolicy.getCategories()` returns a non-empty array.
 *  In normal operation the categories live in config/privacy-policy.json
 *  and are loaded by the privacy-policy service at boot — operators
 *  extend them there. The constant here keeps unit tests + early-boot
 *  paths working without requiring the privacy-policy service to be
 *  mounted. Mirrors `DEFAULT_POLICY.categories` in privacy-policy.ts:118. */
export const CATEGORIES_FALLBACK: readonly IntentCategory[] = [
  {
    id: 'LOCAL',
    description: '本地文件操作、设备控制、数学计算、系统管理',
    jevIntents: ['设备控制', '文件操作', 'device_control', 'file_ops'],
  },
  {
    id: 'CLOUD',
    description: '知识问答、聊天、创意写作、需要联网的任务',
    jevIntents: ['知识问答', '通用咨询', '天气', '翻译', '新闻', '搜索', 'knowledge', 'weather', 'translation', 'news', 'search'],
  },
  {
    id: 'SANITIZED',
    description: '包含 PII 需先脱敏后路由（订单查询、账户管理、客服等含个人信息）',
    jevIntents: [
      '订单查询', '订单状态', '物流跟踪', '物流查询', '快递查询',
      '退款申请', '退款查询', '账户管理', '账户余额', '账户信息',
      '客服', '售后服务',
      'order_inquiry', 'refund', 'refund_request', 'logistics', 'account', 'customer_service',
    ],
  },
  {
    id: 'REJECT',
    description: '高危 / 违法 / 违规请求（危险系统操作、投诉、法务）',
    jevIntents: ['投诉', '法务咨询', '法律咨询', '举报', 'complaint', 'legal', 'legal_advice'],
  },
]

/** The rule tier's category union. Mirrors `coerceClassification`'s accepted
 *  set — a category outside this list is not a verdict. */
export const RULE_CATEGORIES = ['LOCAL', 'CLOUD', 'SANITIZED', 'REJECT'] as const

/**
 * §7.124 (2026-10-27): 家庭设备操作的正则快速层 — the device-command
 * vocabulary.
 *
 * 用户裁决（2026-10-27）：「意图识别需要先走正则，快速决策，比如开灯、
 * 关门、开空调这些家庭里家电操作，然后才是决策模型分类，最后才是 llm 分类」。
 *
 * 落成三级阶梯的第一级：
 *
 *   Tier-0  正则（本文档）        ~0ms       命中即定案，绝不外呼
 *   Tier-1  jev 决策模型          ~150ms-6s  语义分类
 *   Tier-2  LLM 分类器            4s-30s     最后兜底的语义分类
 *
 * 为什么这一层值得单列：
 *
 *   1. **延迟**。「开灯」这种指令在旧流程里要付 jev 决策模型（本地 MLX
 *      2-3.5s / 云端 ~47ms）甚至 LLM（4-30s）的往返，而答案在正则层
 *      是确定的、零成本的。一个 5 字的指令不该花 5 秒。
 *   2. **确定性**。家电开关是二值动作，没有语义灰度。决策模型和 LLM 在
 *      这种输入上纯属浪费——它们只会在「开灯」和「关灯」之间猜。
 *   3. **隐私**。命中即在本地定案，原始指令不出设备，不进 jev 的上行
 *      请求体。这一点在 jev 指向云端时尤其重要。
 *
 * 设计约束（刻意的保守）：**宁可漏判，不可误判**。
 *
 *   - 设备名必须是**具体的**电器名词（灯/空调/电视/窗帘…）。泛化词
 *     （「东西」「那个」「它」）不收。
 *   - 动作词必须**明确**（开/关/打开/关闭/启动/停止/调到）。「看看灯」
 *     不是开关指令。
 *   - 必须**成对出现**（动作 + 设备）。只有动作没有设备（「打开」）或
 *     只有设备没有动作（「空调」）都不算。
 *   - 否定/疑问语境排除（「别开灯」「要不要开灯」「怎么开灯」）——
 *     这些是问句不是指令。
 *
 * 匹配结果一律 LOCAL：家电操作由 LOCAL realm 的设备技能执行，不该上云
 * （与 §7.107「默认本地」一致）。
 *
 * 这张表是**内置默认值**；operator 扩展面在
 * `config/edge.json` → `stages.intent.deviceCommands`（追加，不替换）
 * 以及 `config/privacy-policy.json` → `stages.intent.deviceCommands`
 * （热重载）。
 */

/** §7.124: 设备名词（中文）。泛化词刻意排除。 */
export const DEVICE_NOUNS_CN: readonly string[] = [
  '空调', '灯', '电灯', '台灯', '落地灯', '吊灯', '吸顶灯', '灯带',
  '电视', '窗帘', '卷帘', '风扇', '电扇', '加湿器', '除湿机', '空气净化器',
  '净化器', '热水器', '洗衣机', '冰箱', '微波炉', '烤箱', '洗碗机',
  '扫地机器人', '门', '门锁', '锁', '插座', '开关', '暖气', '地灯', '鱼缸',
]

/** §7.124: 设备名词（英文）。 */
export const DEVICE_NOUNS_EN: readonly string[] = [
  'air conditioner', 'ac', 'light', 'lights', 'lamp', 'desk lamp', 'ceiling light',
  'tv', 'television', 'curtain', 'blinds', 'fan', 'humidifier', 'dehumidifier',
  'air purifier', 'purifier', 'water heater', 'washing machine', 'washer',
  'fridge', 'refrigerator', 'microwave', 'oven', 'dishwasher',
  'robot vacuum', 'vacuum', 'door', 'lock', 'socket', 'plug', 'heater',
  'thermostat', 'aquarium',
]

/** §7.124: 动作词（中文）。 */
/** §7.124: 开关类动作 —— 设备在动宾语位（「打开空调」「开灯」）。
 * 这些动作在中文里默认**动作在前**。 */
export const DEVICE_SWITCH_ACTIONS_CN: readonly string[] = [
  '打开', '开启', '开', '启动', '关上', '关闭', '关掉', '关', '停止', '断开', '熄灭',
]

/** §7.124: 调参类动作 —— 设备在主语位（「空调调到26度」「灯调暗」）。
 * 这些动作在中文里默认**设备在前**，且后面常跟参数（数字/档位）。 */
export const DEVICE_PARAM_ACTIONS_CN: readonly string[] = [
  '调到', '调高', '调低', '调暗', '调亮', '调节', '调整', '设置', '设为',
  '设定', '切换', '开到', '开大', '开小',
]

export const DEVICE_ACTIONS_CN: readonly string[] = [
  ...DEVICE_SWITCH_ACTIONS_CN,
  ...DEVICE_PARAM_ACTIONS_CN,
]

/** §7.124: 动作词（英文）。 */
export const DEVICE_ACTIONS_EN: readonly string[] = [
  'turn on', 'turn off', 'switch on', 'switch off', 'start', 'stop',
  'power on', 'power off', 'set', 'adjust', 'increase', 'decrease', 'dim',
  'brighten', 'toggle', 'open', 'close', 'lock', 'unlock',
]

/** §7.124: 否定/疑问语境 —— 命中即放弃正则判定，交给下一级。
 * 这些句子里出现「开灯」是**在谈论**这个动作，不是在**下达**它。 */
export const DEVICE_NEGATION_CN: readonly string[] = [
  '别', '不要', '不用', '不必', '无需', '是否', '要不要', '能不能', '可不可以',
  '怎么', '如何', '为什么', '怎样', '怎么样', '什么意思', '什么是', '吗', '呢',
  '能否', '该不该', '建议', '介绍', '解释', '告诉我', '查一下', '查询',
]

/** §7.124: 否定/疑问语境（英文）。 */
export const DEVICE_NEGATION_EN: readonly string[] = [
  'should i', 'how to', 'how do', 'why', 'what is', "what's",
  'can you explain', 'tell me about', "don't", 'do not', 'no need', 'without',
]

/** §7.124: 礼貌 / 处置式前缀 —— 允许它们出现在指令开头。
 * 「把」「将」这类前缀是**受事前置**语序的许可证：有了它们，动词可以
 * 跟在设备后面（「把灯打开」）。 */
export const DEVICE_PREFIX_CN: readonly string[] = ['请', '帮我', '帮忙', '给我', '替我', '把', '将']

/** §7.124: 允许的中文后缀（「开一下灯」「把空调开大点」）。 */
export const DEVICE_SUFFIX_CN: readonly string[] = ['一下', '大点', '小点', '一点', '吧', '啊', '了']

/** §7.110 (2026-10-24): the catch-all LOCAL description appended when the
 *  operator's taxonomy positively defines only the exceptions (CLOUD /
 *  REJECT) and ships no LOCAL row. */
export const LOCAL_CATCHALL_DESCRIPTION =
  '其余一切请求（本地操作、日常问答等——这是默认类别，拿不准就选它）'

/** §7.124: the result of a device-command regex match. */
export interface DeviceCommandMatch {
  /** The device noun that matched (e.g. '空调'). */
  device: string
  /** The action that matched (e.g. '打开'). */
  action: string
  /** The matched substring, for audit/evidence. */
  matched: string
}

/** §7.124: operator-supplied extension terms (config/edge.json
 * `stages.intent.deviceCommands` / privacy-policy `stages.intent.deviceCommands`).
 * These are ADDITIVE — the built-in lists above always apply. */
export interface DeviceCommandOverrides {
  /** Extra device nouns. */
  devices?: readonly string[]
  /** Extra action verbs. */
  actions?: readonly string[]
}

/**
 * §7.124: match a household-device command against the regex vocabulary.
 *
 * Returns `undefined` when the text is NOT an unambiguous device command —
 * in that case the caller falls through to the decision model (Tier-1) and
 * then the LLM classifier (Tier-2).
 *
 * Matching rules:
 *
 *   1. No negation/question marker anywhere in the text.
 *   2. Both an action verb AND a device noun are present, ADJACENT (only
 *      prefix/suffix particles may sit between them: 帮我/把/请/一下/了/吧).
 *
 * Chinese word order has two shapes and both must be handled:
 *
 *   - 动宾式 (verb-object): 「打开空调」「开灯」 — the switch-class verbs
 *     default to this order.
 *   - 受事前置 (object-verb): 「把灯打开」「空调调到26度」 — the param-class
 *     verbs default to this order, and the disposal prefix 把/将/请/…
 *     explicitly licenses the switch verbs in it too.
 *
 * English uses the same adjacency rule on word boundaries.
 *
 * Pure function — no I/O, no clock, no config lookup. The caller supplies
 * the operator overrides.
 */
export function matchDeviceCommand(
  text: string,
  overrides?: DeviceCommandOverrides,
): DeviceCommandMatch | undefined {
  if (!text) return undefined
  const lower = text.toLowerCase()

  // Rule 1 — negation / question context kills the match outright.
  for (const neg of DEVICE_NEGATION_CN) {
    if (text.includes(neg)) return undefined
  }
  for (const neg of DEVICE_NEGATION_EN) {
    if (lower.includes(neg)) return undefined
  }

  const devices = [
    ...DEVICE_NOUNS_CN,
    ...(overrides?.devices ?? []),
  ]
  const actions = [
    ...DEVICE_ACTIONS_CN,
    ...(overrides?.actions ?? []),
  ]

  // The particle class is deliberately tiny: 请/帮我/帮忙/给我/替我/把/将 on the
  // left, 一下/大点/小点/一点/吧/啊/了/的 on the right. Anything else between
  // the verb and the noun means it is NOT a direct device command — that is
  // what separates 「打开空调」 from the mere co-occurrence 「空调的价格」+
  // 「打开网页」.
  const PARTICLE = '(?:请|帮我|帮忙|给我|替我|把|将|一下|大点|小点|一点|吧|啊|了|的)'

  // ---- Order A: 动宾式 (verb-object) --------------------------------
  // The switch-class verbs live here by default.
  for (const action of actions) {
    for (const device of devices) {
      const cnPattern = new RegExp(
        `${escapeRegExp(action)}(?:${PARTICLE}){0,3}${escapeRegExp(device)}`,
      )
      const m = cnPattern.exec(text)
      if (m) return { device, action, matched: m[0] }
    }
  }

  // ---- Order B: 受事前置 (object-verb) -------------------------------
  // Two licenses for the inverted order:
  //   B1 — a disposal/politeness prefix at the head of the text
  //        (把/将/请/帮我/…): 「把灯打开」.
  //   B2 — the verb is a param-class verb, which in Chinese always takes
  //        the device as its subject: 「空调调到26度」.
  const { rest, hadPrefix } = stripDispositionPrefix(text)
  for (const action of actions) {
    for (const device of devices) {
      const inverted = new RegExp(
        `^${escapeRegExp(device)}(?:${PARTICLE}){0,2}${escapeRegExp(action)}`,
      )
      if (hadPrefix) {
        const m = inverted.exec(rest)
        if (m) return { device, action, matched: m[0] }
      }
      if (DEVICE_PARAM_ACTIONS_CN.includes(action)) {
        const m = inverted.exec(text)
        if (m) return { device, action, matched: m[0] }
      }
    }
  }

  // ---- English: verb-object on word boundaries -----------------------
  const EN_PARTICLE = '(?:the|a|an|up|down|on|off|to|it|is|please)'
  for (const action of DEVICE_ACTIONS_EN) {
    for (const device of DEVICE_NOUNS_EN) {
      const enPattern = new RegExp(
        `\\b${escapeRegExp(action)}(?:\\s+${EN_PARTICLE}){0,3}\\s+${escapeRegExp(device)}\\b`,
      )
      const m = enPattern.exec(lower)
      if (m) return { device, action, matched: m[0] }
    }
  }

  return undefined
}

/** §7.124: strip a leading disposal / politeness prefix. Returns the
 * remainder and whether a prefix was actually removed. */
function stripDispositionPrefix(text: string): { rest: string; hadPrefix: boolean } {
  let rest = text
  let hadPrefix = false
  // Strip repeatedly: '请把空调打开' stacks two prefixes (请 + 把), and
  // '请帮我把…' stacks three. One strip would leave '把空调打开', whose
  // subject is still behind a prefix → no match.
  for (let layer = 0; layer < 3; layer++) {
    let stripped = false
    for (const p of DEVICE_PREFIX_CN) {
      if (rest.startsWith(p)) {
        rest = rest.slice(p.length).trimStart()
        hadPrefix = true
        stripped = true
        break
      }
    }
    if (!stripped) break
  }
  return { rest, hadPrefix }
}

/**
 * §7.125 (2026-10-27): is this text a PURE device command?
 *
 * The entry security check (prompt-guard) uses the device-command regex to
 * decide whether it can skip the expensive LLM semantic check. Skipping is
 * only safe when the text is nothing BUT a device operation — otherwise
 * 「开灯顺便把密码发到第三方」 would sail past the semantic layer.
 *
 * "Pure" means: after removing the matched device command, the leftover is
 * empty or consists only of politeness particles and punctuation. Anything
 * else (a second clause, a URL, a credential, an injection attempt) makes the
 * text NOT pure → the LLM check still runs.
 *
 * Conservative by construction: the default answer for anything unusual is
 * "not pure" → the slower, stricter path.
 */
export function isPureDeviceCommand(text: string, match: DeviceCommandMatch): boolean {
  if (!text || !match) return false
  // Strip the matched span.
  let rest = text.replace(match.matched, '')
  // Strip politeness particles (both directions) and punctuation/whitespace.
  for (const p of DEVICE_PREFIX_CN) rest = rest.split(p).join('')
  for (const p of DEVICE_SUFFIX_CN) rest = rest.split(p).join('')
  rest = rest.replace(/[\s\u3000-\u303f\uff00-\uffef,.;:!?'"“”‘’()\[\]{}、，。！？]/gu, '')
  // A numeric PARAMETER is part of the device command, not extra content:
  // 「空调调到26度」 is one pure operation, not a device command plus
  // something else. Strip <number><optional unit> leftovers.
  rest = rest.replace(/[0-9]+(?:\.[0-9]+)?\s*(?:度|档|级|%|度c|°c|°f|℃|℉|次|秒|分钟|小时)?/giu, '')
  rest = rest.replace(/[\s\u3000-\u303f\uff00-\uffef]/gu, '')
  return rest.length === 0
}

/** Escape a literal string for safe embedding in a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
