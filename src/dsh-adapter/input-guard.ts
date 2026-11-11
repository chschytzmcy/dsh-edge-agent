/**
 * input-guard — 端侧隐私安全管线的编排器。
 *
 * 把安全/隐私/脱敏逻辑从 transport 层（http-api）上移到 Agent Loop 的
 * 事件链上，让所有入口（http-api / Web UI / CLI / SDK / 未来的 WebSocket
 * 或 gRPC）自动统一走同一套管线。谁也无法绕过。
 *
 * 正向（agent/pre-step）：fail-closed 路由闸门 → 攻击检测 → 策略判定 →
 *   意图分类 → 脱敏
 * 反向（llm/stream）：对 text-delta chunk 流式反脱敏
 *
 * §7.175 (2026-11-11): 路由改写退役。input-guard 不在 agent/request 里改写
 * provider/model（宿主的 prepareRequest() 会对改写直接抛错）。
 *
 * §7.184 (2026-11-11，主人裁决「选择器完全不动，实际请求改道到本地池」）：
 *   - **会话选型不再被改写**（§7.176 的钉选 / §7.179 的补钉 / §7.183 的回钉全部
 *     退役）⇒ 宿主模型选择器保持主人选的那个，不跳。
 *   - 「本轮必须留在设备上」这条不变式改由**出网那一跳**保证：LOCAL 轮次的请求
 *     在 `llm/stream` 被换成 provider = 本地池（见 handleLlmStream）。
 *   - 旧口径（§7.175：判定 LOCAL 而选型不是本地 ⇒ 拒绝这一轮）随之退役 ——
 *     能改道就不必拒；改不动时仍然 fail-closed（抛错，绝不放行到云端）。
 *
 * 设计详见：docs/input-guard-design.md
 *
 * §7.123 (2026-10-27): the pure message-array helpers (find / replace user
 * turns) moved to `./input-guard-messages.ts` — they encode the
 * payload.messages vs decision.messages contract, which is the part of this
 * module that upstream keeps changing. This file keeps the hook LOGIC.
 *
 * @module dsh-edge-agent/input-guard
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

import {
  findLastUserText,
  findUserTexts,
  replaceAtUserIndex,
  replaceUserTextsAt,
} from './input-guard-messages.js'
import { assistantProviderHistogram } from './cloud-egress.js'

// §7.175 (2026-11-11): 路由改写退役后，input-guard 不再探云池
// （cloud-llm-adapter 的委托探针 probeCloudTarget 也就不再需要了）。
import { loadEdgeConfig, localPool } from './edge-config.js'
// §7.180: 「这一轮真正会跑哪个模型」的解析 —— 与 wire（adapter 的委托
// 解析链）、模型目录（listModels）共用同一份委托目标缓存 ⇒ 补钉下去的
// model id 就是真正会跑的那个（§7.176）。
import {
  resolveEffectiveLocalModelSync,
  resolveEffectiveLocalModelWith,
  type LocalPoolShape,
} from './effective-model.js'
import { containsCredential } from './pii-utils.js'
// §7.144: 宿主 provider 那一跳的 trace（delegate 出去的云池调用不在任何
// adapter 里，adapter 记不到它 —— 面板里会整条缺失）。
import { resolveLlmTraceConfig } from './llm-trace.js'
import type { LlmTraceConfig, TraceSink } from './llm-trace.js'
import { callIdFor, getTraceStore } from './llm-trace-store.js'
import {
  HostCallRecorder,
  OWN_POOL_PROVIDERS,
  isOwnPoolProvider,
} from './host-llm-trace.js'
import type { HostCallRequest } from './host-llm-trace.js'
// §7.151 (2026-10-29): 出网那一跳的「只带云段历史」守卫。桌面部署的 CLOUD
// 轮次走的是**宿主原生 provider**（桌面 GUI 选的模型），压根不进
// cloud-llm-adapter ⇒ adapter 里的 §7.131 裁剪一次都没跑过。守卫补在
// `llm/stream` waterfall 上 —— 真正的出网那一跳。
import { HostEgressGuard, isLocalPoolForward, type HostEgressPlan } from './host-egress-guard.js'
import { sessionIdField } from './session-attribution.js'

export const name = 'input-guard'

export const inject = [
  'promptGuard',
  'privacyPolicy',
  'intentRouter',
  'sanitizer',
  'auditLog',
  // §7.36 (2026-09-04): 必须 inject realmSkillBridge，否则 this.ctx.realmSkillBridge
  // 永远 undefined。Cordis Context 只暴露 inject 列出的依赖,setSessionRealm 块
  // 就被 if 跳过。Boot 顺序无死锁:realm-skill-bridge 在 cordis.patch.yml
  // 排在 http-api 之前(已确认 line 317),input-guard 同样靠后启动。
  'realmSkillBridge',
  // §7.171 (2026-11-10): 确认 local-llm 路由真的存在。
  //
  // local-llm 现在有两种上线方式：
  //   - 配置了 `llm.local.baseUrl` → 直连自有池（一直如此）；
  //   - 没配置 → **DELEGATE 模式**（转发宿主提供商），路由照样注册 ⇒
  //     `modelRouter.isAvailable('local-llm')` 为 true，与直连时无差别。
  // 只有 `llm.local.delegate=false`（kill switch）才回到「不注册任何路由」的
  // opt-in 语义 —— 那时 LOCAL 意图必须 fail-closed，不能改写到一条不存在的路由。
  //
  // 刻意**不**把 modelRouter 放进 inject：
  //   - localAvailable() 已经用 try { ctx.get(...) } catch {} 做
  //     optional 访问 —— 拿不到就保持旧行为（legacy-no-router），不回归。
  //   - inject 是 cordis 的**硬依赖**：声明它 = cordis 必须等 model-router
  //     装载完才起 input-guard，还会把 model-router 拉进最小部署形态的
  //     依赖闭包（那里根本没有 local-llm / cloud-llm，model-router 只是空
  //     catalog，查它没有意义）。
  //   - 同样刻意不 inject llm：宿主 llm registry 会让「云侧判定」多一条
  //     数据源，而边缘模式恒用本地模型（§7.175），云侧判定已退役。
  //
  // NB: 注释里不要用单引号包 service 名 —— 任何「扫 inject 数组原文」的
  // 依赖闭包检查都会把注释里的引号名误当成依赖。
] as const

export interface Config {
  /** 总开关。false 时所有 hook 都直接 pass-through（debug / 紧急回退用）。*/
  enableInputGuard: boolean
  /** LOCAL 路径是否也走脱敏（默认 false：LOCAL LLM 看到原文，不上云无需脱敏）。*/
  sanitizeLocalTraffic: boolean
  /** 攻击检测 / privacy-policy REJECT → 阻断 step（user 行为不端）。
   *  false = 仅审计 + 放行（fail-open on policy；不推荐）。*/
  rejectOnPolicyViolation: boolean
  /** Sanitize 失败 → 是否阻断本轮（系统故障而非 user 错）。
   *
   *  §7.175 (2026-11-11): 曾经这个开关表示「降级到 LOCAL 路由」——
   *  input-guard 在 agent/request 里改写 provider/model。**改写已经退役**
   *  （宿主的 prepareRequest() 会因为改写直接抛错），路由恒由宿主的
   *  modelSelection 决定。现在它只表示「脱敏失败要不要拦下这一轮」：
   *  false = REJECT step（user 看到空 result）；true = 放行。
   *  默认 true — 边缘模式恒走本地模型，原始 PII 不出境。*/
  downgradeOnSanitizeFailure: boolean
  /** 本地 provider 名。必须与本地 LLM adapter 注册名一致，也是 §7.175
   *  fail-closed 闸门认定的「本地」：宿主 modelSelection.provider 必须等于
   *  它，否则本轮被拒（绝不放行到可能上云的 provider）。*/
  localProvider: string
  localModel: string
  /** 2026-09-03 §7.35: Cloud adapter 读 key 的 env slot 名。
   *  与 cloud-llm-adapter.Config.apiKeyEnv 默认一致（'DEEPSEEK_API_KEY'），
   *  也尊重 cordis.patch.yml:41 的 DSH_EDGE_CLOUD_KEY_ENV 覆盖。
   *
   *  §7.175 (2026-11-11): **input-guard 不再消费本项**。边缘模式恒用本地
   *  模型（主人裁决），云池不参与任何路由判定；「云端不可用 → 降级 LOCAL」
   *  那条路径随路由改写一起退役。本项保留在 schema 里只是为了不破坏既有
   *  配置文件（cloud-llm-adapter 仍按自己的同名项读它）。*/
  cloudApiKeyEnv: string
  /** 2026-09-07 §7.43 fix: TUI / dsh-web-app chat 入口不会写 agent._edgeRoute
   *  （只有 http-api 写），所以 handlePreStep 拿不到"如果没降级本来会路由到
   *  哪个 provider"。曾用作「降级前原路由」的 fallback。
   *
   *  §7.175 (2026-11-11): 降级机制退役后本项**不再被 input-guard 读取**
   *  （路由恒由宿主的 modelSelection 决定）。保留在 schema 里只是为了不
   *  破坏既有配置文件。*/
  defaultCloudProvider: string
  defaultCloudModel: string
  /** §7.179 (2026-11-11): 本插件所在 preset 的 id。
   *
   *  用途：`agent-preset/selected` 事件是**全局**事件（宿主 registry 直接
   *  `ctx.emit('agent-preset/selected', session.id, presetId)`，不带 scope 载体）
   *  ⇒ 所有工作方式的监听器都收到 ⇒ 必须自己按 presetId 过滤，否则会给
   *  标准模式的会话也钉上 local-llm（那会改掉宿主的选择，违反 §7.140
   *  「标准模式零 edge 事件」）。
   *
   *  这个值必须与 preset yml 里的 `config.id` 一致 —— scripts/verify-preset-isolate.ts
   *  复核这一点（不一致即门禁失败），所以它不是「两份各写各的」，而是**被门禁
   *  锁住的一致量**。*/
  presetId: string
}

export const Config: Schema<Config> = Schema.object({
  enableInputGuard: Schema.boolean().default(true),
  sanitizeLocalTraffic: Schema.boolean().default(false),
  rejectOnPolicyViolation: Schema.boolean().default(true),
  downgradeOnSanitizeFailure: Schema.boolean().default(true),
  localProvider: Schema.string().default('local-llm'),
  // §7.102: the downgrade target model follows the LOCAL pool in
  // config/edge.json (llm.local.model). The Schema default stays only as a
  // last-resort fallback when no config file is present at all.
  localModel: Schema.string().default('qwen3-4b-instruct-2507'),
  cloudApiKeyEnv: Schema.string().default(
    // mirror cordis.patch.yml:41 的 !!js 表达式；apply() 里再尊重 DSH_EDGE_CLOUD_KEY_ENV 覆盖
    process.env.DSH_EDGE_CLOUD_KEY_ENV ?? 'DEEPSEEK_API_KEY',
  ),
  defaultCloudProvider: Schema.string().default(
    // §7.43: mirror cordis.patch.yml:82 的 !!js；agent-loop 也用同一个值作"current provider"默认
    process.env.DSH_EDGE_PROVIDER ?? 'cloud-llm',
  ),
  defaultCloudModel: Schema.string().default(
    process.env.DSH_EDGE_MODEL ?? 'deepseek-chat',
  ),
  // §7.179：与 preset yml 的 `config.id` 对齐（门禁复核）。
  presetId: Schema.string().default('edge'),
})

/** Minimal prompt-guard 接口（只暴露 input-guard 用到的方法）。*/
interface PromptGuardLike {
  checkInput(text: string, sessionId: string): Promise<{
    safe: boolean
    reason?: string
    riskLevel?: 'low' | 'medium' | 'high'
  }>
  checkOutput?(text: string, context?: { sanitized?: boolean }): Promise<{
    filtered: string
    redacted: Array<{ type: string; masked: string }>
  }>
}

/** Minimal privacy-policy 接口。*/
interface PrivacyPolicyLike {
  matchRouting(text: string): {
    realm?: string
    confidence?: number
    rationale?: string
  } | null | undefined
}

/** Minimal intent-router 接口。*/
interface IntentRouterLike {
  classify(text: string, context?: { recentMessages?: unknown[]; sessionId?: string }): Promise<{
    category: 'LOCAL' | 'CLOUD' | 'SANITIZED' | 'REJECT'
    confidence: number
    rationale?: string
  }>
}

/** Minimal sanitizer 接口。
 *  §7.123 (2026-10-27): the replacement shape was STALE here — it declared
 *  `{ type, original, token }` while sanitizer-pipeline's real `Replacement`
 *  is `{ original, placeholder, piiType, dataClass, keptPrefix? }`. The
 *  mismatch was invisible while input-guard only read `.length`; now that
 *  the audit records which PII types were hit, the interface must match
 *  the real contract. */
interface SanitizerLike {
  sanitize(text: string, context?: { sessionId?: string }): Promise<{
    sanitizedText: string
    sessionId: string
    replacements: Array<{
      original: string
      placeholder: string
      piiType: string
      dataClass: string
      keptPrefix?: string
    }>
  }>
  desanitize(text: string, sessionId: string): Promise<string>
}

/** Minimal audit-log 接口。*/
interface AuditLogLike {
  log(entry: {
    level: 'debug' | 'info' | 'warn' | 'error' | 'security'
    kind: string
    source: string
    payload: Record<string, unknown>
  }): Promise<unknown>
}

/** Minimal realm-skill-bridge 接口（§7.36,2026-09-04）。
 *  非 inject 依赖,通过 `this.ctx.realmSkillBridge` 取 ——
 *  cordis plugin 顺序未保证 realmSkillBridge 先于 inputGuard boot,
 *  缺失时 setSessionRealm 调用静默 no-op。*/
interface RealmSkillBridgeLike {
  setSessionRealm(
    sessionId: string,
    realm: 'LOCAL' | 'CLOUD' | 'SANITIZED',
  ): void
}

/** StreamChunk 形状（来自 @deepseek-ai/dsh-llm，避免深层依赖）。*/
interface StreamChunkLike {
  type: string
  text?: string
  [k: string]: unknown
}

/**
 * §7.163: 输出侧 PII 掩码的「尾部待定区」长度（字符）。
 *
 * 流式输出可能把一个 PII 切成多块（手机号断成两块时，两块单独看都匹配不
 * 上 11 位数字的正则），逐块掩码就会漏。所以保留尾部一段待定，只对更早的
 * 安全前缀做掩码。
 *
 * 128 覆盖了当前最长的一条 PII 规则：`credential`
 * （标签最长 `access[ _-]?token` = 17 字符 + 最多 2 个引号/空格 +
 * 分隔符 + 最多 2 个空格 + 64 位值 ≈ 90）。若将来新增更长的规则，
 * 这个数要跟着抬 —— 抬小的后果是「跨 chunk 的长 PII 漏出」。
 */
const PII_MASK_TAIL_CHARS = 128


declare module '@deepseek-ai/cordis' {
  interface Context {
    inputGuard: InputGuardServiceImpl
  }
}

/** Per-session 的"这一步做了脱敏"状态。按 sessionId 存在普通 Map 里
 *  （pre-step 的 session 引用与 llm/stream 的 sessionId 字符串不是同一
 *  对象，WeakMap 回收不了），靠 SESSION_STATE_CAP 的 LRU 淘汰兜住。*/
export interface StepSanitizationState {
  /** 当前 turn/step 是否做了脱敏。每次 agent/pre-step 入口重置。*/
  sanitized: boolean
  /** 替换次数（0 = 没替换，无需 desanitize）。*/
  replacements: number
  /** 触发脱敏时的 session id（冗余但便于审计）。*/
  sessionId: string
  /** 时间戳，便于陈旧检查。*/
  timestamp: number
  /** 入口路径（'http-api' = _edgeRoute 已设；'webui' = 未设）。
   *  §7.175 起它只描述「这一轮的路由决策从哪来」，不再用于改写路由。*/
  routeSource?: 'http-api' | 'webui'
}

/** 上一路由决策：被 input-guard 在 agent/pre-step 读取，避免重复 classify()。*/
interface AgentEdgeRoute {
  realm: 'LOCAL' | 'CLOUD' | 'SANITIZED'
  category: 'LOCAL' | 'CLOUD' | 'SANITIZED' | 'REJECT'
  provider: string
  model: string
  confidence: number
  rationale?: string
}

/**
 * input-guard 在 pre-step 拒收时挂到 agent 上的"为什么被拒"标签。
 *
 * agent-loop 把 `{ kind: 'reject' }` 转成 `turnEnds = { kind: 'blocked' }`
 * 时会把 input-guard 给出的 reason 字符串丢掉，导致 http-api 看到 blocked
 * 但不知道为何被拒、也无法给客户端返回有意义的 400。
 *
 * 这里把 `{ kind, reason, riskLevel }` 直接挂到 agent 上，让 http-api 在
 * 订阅 `session/event` 的 turn/end 监听器里读到。写入发生在 pre-step
 * 返回 reject 之前，读取发生在 turn/end 事件触发之后，顺序天然保证。
 *
 * 仅在 reject 时写入；正常 turn 不污染 agent 状态。
 */
interface AgentEdgeRejection {
  kind: 'attack' | 'policy' | 'intent' | 'sanitizer'
  reason: string
  riskLevel?: 'low' | 'medium' | 'high'
}

/** agent/request waterfall 返回的 config 形状（DSH agent-loop 的 contract）。*/
interface AgentRequestConfig {
  provider: string
  model: string
  reasoningEffort?: number
  maxTokens?: number
}


/**
 * input-guard 服务。
 *
 * 三个全局 hook：
 *   - `agent/pre-step`（正向）：**fail-closed 路由闸门** → 攻击 → 策略 →
 *     分类 → 脱敏
 *   - `agent/request`（只读放行）：§7.175 起**不再改写** provider/model
 *   - `llm/stream`（反向）：§7.184 起把 LOCAL 轮次的请求**改道**到本地池；
 *     并对 text-delta chunk 流式反脱敏
 *
 * 跨 hook 状态用 Map<sessionId, StepSanitizationState> 维护。
 */
export class InputGuardServiceImpl extends Service {
  private readonly config: Config
  private readonly promptGuard: PromptGuardLike | undefined
  private readonly privacyPolicy: PrivacyPolicyLike | undefined
  private readonly intentRouter: IntentRouterLike | undefined
  private readonly sanitizer: SanitizerLike | undefined
  private readonly auditLog: AuditLogLike | undefined

  /** sessionId → 当前 step 的脱敏状态。用 Map<string, state> 而不是 WeakMap<session>
   *  是因为 pre-step 的 session 引用和 llm/stream options 上的 sessionId
   *  对应的不是同一个对象（pre-step 拿到的是 agent 实例的 session，
   *  llm/stream 拿到的是 LLM request envelope 上的 sessionId 字符串）。*/
  private readonly stepState = new Map<string, StepSanitizationState>()
  /**
   * §7.106 (2026-10-23): last routed category per session. The attack-block
   * gate consults it: a LOCAL turn cannot egress anything, so credential-flavored
   * "leak" detections are the user operating their own device (密盒登录类),
   * which the operator ruled must pass — warn instead of block. Injection-class
   * reasons stay blocked even under LOCAL (injection can drive local tools).
   * The egress risk of the same credentials later riding session history into a
   * CLOUD turn is closed by the sanitizer's new `credential` PII class, not by
   * this exemption.
   */
  private readonly turnCategory = new Map<string, string>()

  /**
   * §7.144: LLM trace 的行为配置（`audit.llmTrace` 段）。
   *
   * 构造时读一次 —— 这是**观测**配置，不是路由配置，读一次足够；每次
   * 读盘会在每个 LLM 往返上多一次 IO。
   */
  private readonly traceConfig: LlmTraceConfig

  /**
   * §7.151: 出网守卫（宿主原生 provider 路径的 §7.131 裁剪）。
   *
   * 必须在**请求派发之前**裁 —— 而宿主把 LOOP 构建的请求 deep-frozen
   * 送来（监听器只读不改），所以裁完要**换掉请求体重新派发**。守卫自己
   * 持有「已裁过」的标记集合，避免重新派发时无限递归。
   */
  private readonly hostEgressGuard: HostEgressGuard

  /**
   * §7.175 (2026-11-11): 「云池现在到底可用吗」的探针（§7.35 / §7.100）随
   * 路由改写一起退役 —— 边缘模式恒用本地模型（主人裁决），云池不参与任何
   * 路由判定。留着它只会把「云端不可用」报成「路由缺失」。*/
  /**
   * §7.171 (2026-11-10): "本地路由现在到底可用吗" —— local-llm 有两种上线方式：
   * 配置了 `llm.local.baseUrl` → 直连自有池；没配置 → DELEGATE 模式（转发宿主
   * 提供商，见 local-llm-adapter.apply）。**两种情况下路由都是注册了的** ⇒
   * `modelRouter.isAvailable('local-llm')` 即可判据，与直连时完全一致。
   *
   * 只有 `llm.local.delegate=false`（kill switch）才会让路由不存在 —— 那时
   * intent=LOCAL 按隐私裁决必须走本地模型，在改写 provider 之前必须确认目标
   * 路由真的存在，否则会把「本地」意图发给一条不存在的路由。
   *
   * 旧上游 / fake ctx 没有 listProviders 时无法证伪 → 保持旧行为（照常改写），
   * 不让老环境因这次收紧而回归。
   */
  private localAvailable(): { ok: boolean; reason: string } {
    const provider = this.config.localProvider
    let router: { isAvailable?: (p: string) => boolean } | undefined
    try {
      router = this.ctx?.get?.('modelRouter') as { isAvailable?: (p: string) => boolean } | undefined
    } catch {
      router = undefined
    }
    if (!router || typeof router.isAvailable !== 'function') {
      // 老上游 / fake ctx：无法证伪 → 保持旧行为（照常改写），不回归。
      return { ok: true, reason: 'legacy-no-router' }
    }
    try {
      return router.isAvailable(provider)
        ? { ok: true, reason: `local-route-live:${provider}` }
        : { ok: false, reason: `local-route-missing:${provider}` }
    } catch {
      return { ok: true, reason: 'legacy-router-unreadable' }
    }
  }

  /**
   * §7.180: 本地池现状 —— 直连（配了 `llm.local.baseUrl`）还是 DELEGATE
   * （没配端点，转发宿主提供商，§7.171），连同 model / delegate 旋钮。
   *
   * 补钉用的 model id 由这份现状**推导**（而不是另读一份宿主选择）⇒ 与
   * wire、模型目录同源（见 §7.180）。
   *
   * protected 而不是 private：单测子类化覆写它，不必依赖机器上那份
   * `~/.dsh-edge-agent/edge.json` 的真实内容。
   */
  protected localPoolShape(): LocalPoolShape {
    try {
      return localPool()
    } catch {
      return {}
    }
  }

  /**
   * §7.184 (2026-11-11): 本轮判定 LOCAL 时，把实际请求**改道**到本地池。
   *
   * 背景（主人裁决 2026-11-11）：「选择器完全不动，实际请求改道到本地池」。
   *
   *   - 边缘模式的会话**不再改写选型**（§7.176 的钉选 / §7.179 的补钉 /
   *     §7.183 的回钉全部退役）⇒ 宿主模型选择器保持主人选的那个，不跳。
   *   - 但「本轮必须留在设备上」这条不变式**不能松** ⇒ 真正跑哪儿由**出网
   *     那一跳**决定：LOCAL 轮次的请求在 `llm/stream` 被换成 provider = 本地池。
   *
   * 为什么能在这一跳改：`llm/stream` 的 waterfall **默认处理**才是解析适配器的
   * 地方（dsh-llm `adapterStream()`：`registration = this.registration(options.provider)`）
   * ⇒ 换掉 `options.provider` 就换掉了真正发出去的适配器。
   * 而且 cordis 的 waterfall **不接受替换载荷**（`next()` 无参，载荷被闭包捕获）
   * ⇒ 只能换一个请求对象**重新派发**（与 §7.151 的出网裁剪同一个姿势）。
   *
   * 重新派发会再进一次 waterfall ⇒ 那趟的 provider 已是本地池 ⇒ 天然不再改道
   * （**防自锁**），且本地池按 §7.131 带**全部**历史（本地池不出网，不裁）。
   *
   * §7.191（2026-11-12）更正：上面那句「provider 已是本地池 ⇒ 天然不再改道」
   * **只在直连池下成立**。DELEGATE 池（§7.171）会把请求转给宿主的目标路由
   * ⇒ 回来那一趟的 provider 不是本地池 ⇒ 防自锁失效 ⇒ 无限乒乓 ⇒ OOM。
   * ⇒ 防自锁现在有**两个**判据：provider 名（直连池）+ 转发标记
   * （`LOCAL_POOL_FORWARD_MARKER`，DELEGATE 池）—— 见 `needsLocalReroute`。
   *
   * fail-closed：改不动（本地路由不存在 / 解析不到 model id / 宿主 LLM runtime
   * 不可用）⇒ **抛错**，绝不放行到可能上云的 provider。
   */

  /** §7.184: 这一通请求要不要改道到本地池？ */
  private needsLocalReroute(
    options: { provider?: unknown; [key: string]: unknown },
    state: StepSanitizationState,
  ): boolean {
    // §7.191（2026-11-12）：**本地池自己的 DELEGATE 转发**不改道。
    //
    // 上面那句注释「重新派发回来的那趟 provider 已是本地池 ⇒ 天然不再改道
    // （防自锁）」**只在直连池下成立**。DELEGATE 池（§7.171）会把请求转给
    // **宿主的目标路由**（如 `qwen-token-plan-cn`）⇒ 回来那一趟的 provider
    // 不是本地池 ⇒ 「provider !== localProvider」判据失效 ⇒ 改道 → 本地池 →
    // 再委托 → 再改道 ⇒ **无限乒乓**。
    //
    // 实测（2026-11-12 桌面版）：递归 123 万次，JS 堆 4GB 爆掉，整机
    // OOM abort；意图分类器的 LLM 调用 5 次全挂（0/5），安检 5/6 挂。
    //
    // 判据用**转发标记**（`LOCAL_POOL_FORWARD_MARKER`）而不是 provider 名：
    // 转发后 provider 是宿主的目标路由，与「用户直接选了那个模型」在
    // provider 维度无法区分 —— 唯一的区别在发起方。裁剪路径
    // （`hostEgressGuard.plan()`，§7.171）早就在用同一个标记。
    if (isLocalPoolForward(options)) return false
    // 只对「本轮必须留在设备上」的轮次改道。CLOUD / SANITIZED 轮次按设计就是
    // 要出网的（脱敏 + 只带云段历史），不改道。
    if (this.turnCategory.get(state.sessionId) !== 'LOCAL') return false
    const provider = typeof options.provider === 'string' ? options.provider : ''
    if (provider.length === 0) return false
    // 已经是本地池 ⇒ 不用改（重新派发回来的那趟也走这一支 ⇒ 防自锁）。
    return provider !== this.config.localProvider
  }

  /**
   * §7.184: 换掉请求对象**重新派发**到本地池（与 §7.151 的出网裁剪同一姿势）。
   *
   * 为什么不能就地改写：宿主契约明写 LOOP 构建的请求是 **deep-frozen**
   * （`markAgentLoopRequest` + `deepFreeze`），"listeners read it, never rewrite it"。
   */
  private async * dispatchRerouted(
    options: { provider?: unknown; model?: unknown; sessionId?: unknown; [key: string]: unknown },
    state: StepSanitizationState,
  ): AsyncIterable<StreamChunkLike> {
    const fromProvider = typeof options.provider === 'string' ? options.provider : ''
    const fromModel = typeof options.model === 'string' ? options.model : ''

    const local = this.localAvailable()
    if (!local.ok) {
      this.audit('security', 'input-guard.reroute.blocked', {
        ...sessionIdField(state.sessionId),
        provider: fromProvider,
        model: fromModel,
        reason: local.reason,
      })
      throw new Error(
        `input-guard: 本轮 intent 判定为 LOCAL（必须留在设备上），但本地路由 "${this.config.localProvider}" 不可用（${local.reason}）。`
        + `为避免本地数据/PII 出境，已阻止本轮上云。`
        // §7.159 门禁按**源码字面量**抽这段报错文案（verify-config-hints.mjs
        // 取文件里第一个「本轮 intent 判定为 LOCAL」所在的 throw）⇒ 这段配置
        // 指引必须字面写在这里，不能改成常量插值；内容与 pre-step 那段一致。
        + `请配置本地 LLM 端点：编辑 ~/.dsh-edge-agent/edge.json 的 llm.local 段，`
        + `填 baseUrl（OpenAI 兼容端点，必须含 /v1）与 model；`
        + `端点需要鉴权时，把密钥写进同一文件的 secrets 段，`
        + `并把 llm.local.keyRef 指向那个键名（keyRef 是 secrets 里的键名，不是环境变量名）。`,
      )
    }

    // 与 wire / 模型目录同源地解析「本地池真正会跑的那个 model id」（§7.180）。
    const shape = this.localPoolShape()
    let effective = resolveEffectiveLocalModelSync(
      this.ctx,
      shape,
      this.config.localModel,
      this.config.localProvider,
    )
    if (effective === undefined || effective.source === 'requested') {
      // 探针步没定 model ⇒ 需要一次 firstModelId 查询（异步）—— 这里能等。
      effective = await resolveEffectiveLocalModelWith(
        this.ctx,
        shape,
        this.config.localModel,
        this.config.localProvider,
      )
    }
    if (effective.source === 'requested' || effective.model.length === 0) {
      this.audit('security', 'input-guard.reroute.blocked', {
        ...sessionIdField(state.sessionId),
        provider: fromProvider,
        model: fromModel,
        reason: 'local-model-unresolved',
      })
      throw new Error(
        'input-guard: 本轮 intent 判定为 LOCAL（必须留在设备上），但解析不到本地池真正会跑的模型 —— 已阻止本轮上云。'
        + '请检查 ~/.dsh-edge-agent/edge.json 的 llm.local 段（baseUrl / model）与 secrets 段。',
      )
    }

    const rerouted = { ...options, provider: this.config.localProvider, model: effective.model }
    // §7.151: 取 LLM runtime **必须走 `ctx.get()`**（cordis 4.x 的 ctx 是 Proxy，
    // input-guard 的 inject 里没有 'llm' ⇒ 直取会抛）。
    const llm = (() => {
      try {
        return (this.ctx as unknown as {
          get?: (name: string) => unknown
        }).get?.('llm') as {
          stream?: (o: unknown) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>
        } | undefined
      } catch {
        return undefined
      }
    })()
    if (typeof llm?.stream !== 'function') {
      this.audit('security', 'input-guard.reroute.blocked', {
        ...sessionIdField(state.sessionId),
        provider: fromProvider,
        model: fromModel,
        reason: 'llm-runtime-unavailable',
      })
      throw new Error(
        'input-guard: 无法重新派发到本地池（宿主 LLM runtime 不可用）—— 已阻止本轮上云',
      )
    }

    // 审计行放在**真正派发之前**（runtime 不可用时上面的 blocked 已经抛了
    // ⇒ 不会出现「审计说改道了、其实没改」的假记录）。
        this.audit('info', 'input-guard.reroute.local', {
      ...sessionIdField(state.sessionId),
      from: { provider: fromProvider, model: fromModel },
      to: { provider: this.config.localProvider, model: effective.model },
      source: effective.source,
      ...(effective.via === undefined ? {} : { via: effective.via }),
      mode: shape.baseUrl ? 'direct' : 'delegate',
    })

    const raw = llm.stream.call(llm, rerouted)
    const resolved = (raw != null && typeof (raw as { then?: unknown }).then === 'function')
      ? await (raw as Promise<AsyncIterable<unknown>>)
      : raw as AsyncIterable<unknown>
    yield* resolved as AsyncIterable<StreamChunkLike>
  }

  constructor(
    ctx: Context,
    config: Config,
    promptGuard?: PromptGuardLike,
    privacyPolicy?: PrivacyPolicyLike,
    intentRouter?: IntentRouterLike,
    sanitizer?: SanitizerLike,
    auditLog?: AuditLogLike,
  ) {
    super(ctx, 'inputGuard')
    this.config = config
    this.promptGuard = promptGuard
    this.privacyPolicy = privacyPolicy
    this.intentRouter = intentRouter
    this.sanitizer = sanitizer
    this.auditLog = auditLog
    // §7.151: 出网守卫（纯逻辑，无外部依赖 —— 构造失败不该拖垮插件）。
    this.hostEgressGuard = new HostEgressGuard(ctx)
    // §7.144: trace 配置读一次（读盘失败也不该让 input-guard 起不来 ——
    // 观测配置坏了就退回出厂默认，主链路不受影响）。
    try {
      this.traceConfig = resolveLlmTraceConfig(loadEdgeConfig())
    } catch {
      this.traceConfig = resolveLlmTraceConfig(undefined)
    }
  }

  private audit(
    level: 'debug' | 'info' | 'warn' | 'error' | 'security',
    kind: string,
    payload: Record<string, unknown>,
  ): void {
    if (!this.auditLog) return
    void this.auditLog.log({ level, kind, source: 'input-guard', payload }).catch(() => {})
  }

  /** 当前 session 是否有活跃的脱敏状态（desanitize 用）。*/
  getStepState(sessionId: string): StepSanitizationState | undefined {
    return this.stepState.get(sessionId)
  }

  /** Exposed for tests: the step-state map the turn/end restore listener reads. */
  setStepState(sessionId: string, state: StepSanitizationState): void {
    this.putStepState(sessionId, state)
  }

  /** Seed/override the session's last routed category. Tests drive the
   *  LOCAL-credential exemption with it; http-api could pre-seed a known
   *  route the same way. */
  setTurnCategory(sessionId: string, category: string): void {
    this.putTurnCategory(sessionId, category)
  }

  /** 会话状态 Map 的 LRU 上限。活跃会话远小于此（http-api 默认
   *  maxActiveSessions=8），被淘汰的是早已结束的 session —— 这两个
   *  Map 曾经只增不减，长驻进程里随历史会话数无限增长。 */
  private static readonly SESSION_STATE_CAP = 512

  /** LRU 写入：delete-then-set 让最近路由的 session 排到队尾，超限
   *  淘汰队头（最久未访问的 session）。 */
  private putStepState(sessionId: string, state: StepSanitizationState): void {
    const map = this.stepState
    map.delete(sessionId)
    map.set(sessionId, state)
    this.evictOldestSessionState(map)
  }

  private putTurnCategory(sessionId: string, category: string): void {
    const map = this.turnCategory
    map.delete(sessionId)
    map.set(sessionId, category)
    this.evictOldestSessionState(map)
  }

  private evictOldestSessionState<V>(map: Map<string, V>): void {
    while (map.size > InputGuardServiceImpl.SESSION_STATE_CAP) {
      const oldest = map.keys().next().value
      if (oldest === undefined) break
      map.delete(oldest)
    }
  }

  /**
   * 清洗 messages 数组中的孤儿 tool_call。
   *
   * 背景（2026-08-31）：当 session 历史里残留一条 assistant 消息含
   * `tool_calls`，但后续没有匹配的 `role: tool` + `tool_call_id` 时，
   * OpenAI / DeepSeek API 会返回 400 invalid_request_error
   * "An assistant message with 'tool_calls' must be followed by tool
   *  messages responding to each 'tool_call_id'."
   *
   * 根因：webui 复用先前 http-api 创建的会话做 session.prompt，但
   * agent-loop 把整个 history 投影到 OpenAI 兼容 schema 时保留了
   * 没有 tool 响应的 tool_call。
   *
   * 修复策略：对每个 orphan tool_call，在 assistant 之后紧邻位置插入一条
   * 合成的 `{role:'user', content:[{type:'tool-result', toolCallId, content:'{\"error\":\"aborted\"}...'}]}`。
   * 这样：
   *   - assistant 消息被原样保留（tool-call 块不动）——必须保证 wire 端
   *     assistant.tool_calls 包含所有 ids，synthetic 才能与之匹配
   *   - wire 转换后 API 看到完整的 tool_calls ↔ tool 配对，校验通过
   *   - LLM 收到"之前那次工具调用被中止了"的信号，自然续写
   *
   * 关键：不要剥离 orphan tool-call 块（初版犯的错）。如果剥离，Case B
   * （assistant 同时含 responded + orphan ids）会让合成的 tool-result
   * 找不到匹配的 tool_call_id，wire 端再次 400。
   *
   * 副作用：上游 provider 可能继续推演被中止的工具调用（如果 LLM 智能
   * 不足）。优先级：先让请求能跑通，再考虑 LLM 行为。这是 input-guard
   * 的职责边界：保证 schema 合规，不保证 LLM 行为合理。
   *
   * §7.58 (2026-09-16) Pass 0——重复 tool_call id 唯一化：同一次 sanitize 内
   * 第 2..n 次出现的同 id tool-call 块（及其第 2..n 个配对 tool-result 块，
   * 含 message.source.callId）改名为 `${id}-dup${k}`，避免 DeepSeek 400
   * "Duplicate value for 'tool_call_id' … in message[N]"。来源：(a) 旧版
   * openai-sse.ts delta / block-end 索引错位使一次调用在一条 assistant 消息
   * 里落成两个同 id 块（已源头修复），修复前落盘的 session 历史仍在——
   * 2026-09-15 session 24303d6a turn 2 实锤；(b) 未来其他模型 / adapter 的
   * 同类重复输出。Pass 0 先于 orphan 扫描，保证后续 pass 看到全局唯一 id。
   *
   * 调用方：cloud-llm-adapter / local-llm-adapter 在 buildChatCompletionsBody
   * 前调用。如 input-guard 未启用（enableInputGuard=false）则跳过。
   */
  sanitizeOrphanToolCalls(
    messages: ReadonlyArray<Record<string, unknown>>,
    sessionId?: string,
  ): {
    messages: Array<Record<string, unknown>>
    orphanCount: number
    syntheticInjected: number
    /** §7.58 (2026-09-16): 本消息集内被改名的重复 tool-call 块数。 */
    duplicateCount: number
  } {
    if (!this.config.enableInputGuard) {
      // 不洗：保持原样
      return { messages: [...messages], orphanCount: 0, syntheticInjected: 0, duplicateCount: 0 }
    }
    const out: Array<Record<string, unknown>> = []
    let orphanCount = 0
    let syntheticInjected = 0

    /**
     * 2026-08-31: dsh 的消息不是 OpenAI 格式。tool_call 是 assistant content 数组
     * 里的 `{type:'tool-call', toolCallId, name, arguments}` 块，tool 响应是
     * 后续 user 消息 content 里的 `{type:'tool-result', toolCallId, content}` 块。
     * 上游 openai-sse.ts 的 buildChatCompletionsBody 把它们转成 OpenAI wire 格式
     * （assistant.tool_calls + role:'tool' 消息）。如果 assistant 里的 toolCallId
     * 在之后没有匹配 tool-result 块，wire 就会带悬空 tool_calls，DeepSeek 返 400。
     *
     * 因此清洗要直接操作 dsh 的 content 块：
     *   1. 收集本条 assistant content 里的所有 toolCallId
     *   2. 在后续所有消息（不限于 role）里找匹配的 tool-result 块
     *   3. 缺失则插入一条 user 消息携带合成 tool-result 块
     */

    /**
     * 从一条消息里抽所有 tool-result 的 id。
     *
     * §7.119 (2026-10-26)：要认**两种**形状。
     *
     * 1. 块级：content 里 `type==='tool-result'` 的块，id 在
     *    `toolCallId` / `callId` / `id` 三者之一。旧实现只认这一种。
     * 2. **消息级**：DSH 的规范形状 —— `{role:'tool', toolCallId:'call_x',
     *    source:{kind:'tool',callId:'call_x'}, content:[{type:'text',…}]}`。
     *    id 在**消息顶层**，content 里是结果文本块、没有 tool-result 块。
     *    上游 `createToolResultMessage()` 造的就是这个形状。
     *
     * 只认形状 1 时的后果（实测）：真实会话里 **100%** 的工具结果都是
     * 形状 2 → 每一个 tool_call 都被误判成 orphan → 每轮都注入合成的
     * "aborted" tool-result → 会话历史每轮 +3 条消息、无限增长
     * （实测 24 轮后 42 个假 orphan、111 条消息、111KB）。
     * 合成的那批反而能被 wire builder 正确识别，于是模型每轮都被告知
     * "上一个工具调用被中止了"，而**真实结果**被 §7.106 的配对守卫降级成
     * "[tool-result (unreferenced) lost its matching call; output:]" 的
     * user 文本。模型的工具语义全程是错的。
     */
    const collectResultIds = (message: unknown): Set<string> => {
      const ids = new Set<string>()
      if (!message || typeof message !== 'object') return ids
      const msg = message as { content?: unknown; toolCallId?: unknown; source?: { callId?: unknown; toolCallId?: unknown } }
      // 形状 2：消息级 id（role:'tool' 的规范形状）
      for (const candidate of [msg.toolCallId, msg.source?.callId, msg.source?.toolCallId]) {
        if (typeof candidate === 'string' && candidate !== '') ids.add(candidate)
      }
      // 形状 1：content 里的 tool-result 块
      const content = msg.content
      if (!Array.isArray(content)) return ids
      for (const block of content) {
        if (!block || typeof block !== 'object') continue
        const b = block as Record<string, unknown>
        if (b.type === 'tool-result') {
          const id = typeof b.toolCallId === 'string' ? b.toolCallId
            : typeof b.callId === 'string' ? b.callId
              : typeof b.id === 'string' ? b.id
                : undefined
          if (id) ids.add(id)
        }
      }
      return ids
    }

    /** 从 assistant content 数组里抽所有 tool-call 的 id（保持顺序） */
    const collectToolCallIds = (content: unknown): string[] => {
      const ids: string[] = []
      if (!Array.isArray(content)) return ids
      for (const block of content) {
        if (!block || typeof block !== 'object') continue
        const b = block as Record<string, unknown>
        if (b.type === 'tool-call') {
          const id = typeof b.toolCallId === 'string' ? b.toolCallId
            : typeof b.callId === 'string' ? b.callId
              : typeof b.id === 'string' ? b.id
                : undefined
          if (id) ids.push(id)
        }
      }
      return ids
    }

    // ── Pass 0（§7.58, 2026-09-16）：重复 tool_call id 唯一化 ─────────────
    // 按文档顺序对同一 id 的出现次序计数：同一 id 的第 k 次「调用」与第 k 次
    // 「结果」天然一一对应（call 恒在其 result 之前出现），第 1 次保留原 id，
    // 第 k≥2 次改名 `${id}-dup${k}`。RESULT 不自算新名，而是引用第 k 个 CALL
    // 改名后的 id（callIdsById 表）——若 result 自己走碰撞让位逻辑，会撞上
    // 刚给配对 call 起的名字而错位成 -dupNx（单测实测踩中）。消息与块一律
    // 浅拷贝——运行期 dsh-llm 对 payload deepFreeze，in-place 修改会炸。改名
    // 撞上历史已有 id 时再加 'x' 后缀（防御极端命名）。
    const blockIdOf = (b: Record<string, unknown>): string | undefined =>
      typeof b.toolCallId === 'string' ? b.toolCallId
        : typeof b.callId === 'string' ? b.callId
          : typeof b.id === 'string' ? b.id
            : undefined
    const takenIds = new Set<string>()
    for (const m of messages) {
      const c = (m as { content?: unknown }).content
      if (!Array.isArray(c)) continue
      for (const block of c as unknown[]) {
        if (!block || typeof block !== 'object') continue
        const b = block as Record<string, unknown>
        if (b.type !== 'tool-call' && b.type !== 'tool-result') continue
        const id = blockIdOf(b)
        if (id !== undefined) takenIds.add(id)
      }
    }
    const callOccurrence = new Map<string, number>()
    const resultOccurrence = new Map<string, number>()
    // 原 id → 其各次 call 改名后的 id（按出现顺序）。result 的第 k 次出现直接
    // 引用第 k 个 call 的落定 id，配对天然一致，不会互相让位错位。
    const callIdsById = new Map<string, string[]>()
    let duplicateCount = 0
    const pass0: Array<Record<string, unknown>> = []
    for (const m of messages) {
      const content = (m as { content?: unknown }).content
      if (!Array.isArray(content)) {
        pass0.push(m)
        continue
      }
      let touched = false
      let renameFrom: string | undefined
      let renameTo: string | undefined
      const blocks = (content as unknown[]).map((block) => {
        if (!block || typeof block !== 'object') return block
        const b = block as Record<string, unknown>
        if (b.type !== 'tool-call' && b.type !== 'tool-result') return block
        const id = blockIdOf(b)
        if (id === undefined) return block
        const isCall = b.type === 'tool-call'
        const occ = isCall
          ? (callOccurrence.get(id) ?? 0) + 1
          : (resultOccurrence.get(id) ?? 0) + 1
        if (isCall) callOccurrence.set(id, occ)
        else resultOccurrence.set(id, occ)
        let nextId: string
        if (isCall) {
          nextId = id
          if (occ > 1) {
            nextId = `${id}-dup${occ}`
            while (takenIds.has(nextId)) nextId = `${nextId}x`
            takenIds.add(nextId)
            duplicateCount++
          }
          const assigned = callIdsById.get(id)
          if (assigned) assigned.push(nextId)
          else callIdsById.set(id, [nextId])
        } else {
          const assigned = callIdsById.get(id)
          if (assigned !== undefined && assigned.length >= occ) {
            nextId = assigned[occ - 1] as string
          } else {
            // result 比 call 还多（上游另有问题的历史）：自算唯一名兜底，
            // 不指望配对，至少不再触发 DeepSeek 的 per-message id 去重 400。
            nextId = `${id}-dup${occ}`
            while (takenIds.has(nextId)) nextId = `${nextId}x`
            takenIds.add(nextId)
          }
        }
        if (nextId === id) return block
        if (!isCall) {
          renameFrom = id
          renameTo = nextId
        }
        touched = true
        const copy: Record<string, unknown> = { ...b }
        if (copy.toolCallId !== undefined) copy.toolCallId = nextId
        if (copy.callId !== undefined) copy.callId = nextId
        if (copy.id !== undefined) copy.id = nextId
        return copy
      })
      if (!touched) {
        pass0.push(m)
        continue
      }
      const msgCopy: Record<string, unknown> = { ...(m as Record<string, unknown>), content: blocks }
      // tool-result 消息的 source.callId 也指回 call id（dsh session 记录格式），
      // 同步改名保持配对；wire 构建不读它，但 desanitize / 审计路径会。
      const src = (msgCopy as { source?: unknown }).source
      if (
        renameTo !== undefined &&
        src !== null && typeof src === 'object' &&
        (src as Record<string, unknown>).callId === renameFrom
      ) {
        msgCopy.source = { ...(src as Record<string, unknown>), callId: renameTo }
      }
      pass0.push(msgCopy)
    }

    // 第一遍：扫描所有消息，构建 "所有出现过的 tool-result id" 集合
    // 我们不只盯紧跟 assistant 的"连续 tool 段"——因为 dsh 把 tool-result
    // 放在后续 user 消息的 content 块里，可能隔了几条消息。
    const respondedAll = new Set<string>()
    for (const m of pass0) {
      for (const id of collectResultIds(m)) respondedAll.add(id)
    }

    // 第二遍：扫 assistant 消息，遇到有 tool-call 的就补缺失响应
    for (let i = 0; i < pass0.length; i++) {
      const msg = pass0[i]
      const role = (msg as { role?: unknown }).role
      const content = (msg as { content?: unknown }).content

      // 复制消息（不可变）
      if (role !== 'assistant') {
        out.push(msg)
        continue
      }
      const tcIds = collectToolCallIds(content)
      if (tcIds.length === 0) {
        out.push(msg)
        continue
      }

      // 找出本 assistant 后尚未被响应的 id（在 respondedAll 里检查）
      // 注意：respondedAll 是全局的，可能包含更晚 assistant 的 tool-call
      // 需要的响应。所以只看本 assistant 之前的消息 + 本 assistant 自身。
      // 实际 dsh 行为：tool-result 块总是出现在对应的 assistant tool-call 之后，
      // 但不一定紧跟（中间可能有 user 消息）。所以扫描 i+1 之后所有消息即可。
      const respondedAfter = new Set<string>()
      for (let k = i + 1; k < pass0.length; k++) {
        for (const id of collectResultIds(pass0[k])) {
          respondedAfter.add(id)
        }
      }

      const missing: string[] = []
      for (const id of tcIds) {
        if (!respondedAfter.has(id)) missing.push(id)
      }

      if (missing.length === 0) {
        out.push(msg)
        continue
      }

      orphanCount += missing.length
      syntheticInjected += missing.length

      // 保留 assistant 消息的 content 原样（包括 orphan tool-call 块）——
      // 必须保证 wire 格式里 assistant.tool_calls 包含所有 ids，synthetic
      // tool-result 才能与之匹配。如果剥离 orphan tool-call，会留下悬空
      // tool-result 块（Case B：assistant 同时有 responded + orphan ids）。
      out.push(msg)

      // 为每个 missing id 插入一条 user 消息携带合成 tool-result 块
      for (const id of missing) {
        const synthetic: Record<string, unknown> = {
          role: 'user',
          content: [
            {
              type: 'tool-result',
              toolCallId: id,
              content: JSON.stringify({
                error: 'aborted',
                reason: 'previous tool call was aborted before completion',
                recovered_by: 'input-guard.sanitizeOrphanToolCalls',
              }),
            },
          ],
        }
        out.push(synthetic)
      }
    }

    if (duplicateCount > 0) {
      // §7.58: 重复 tool_call id 改名是"请求能跑通"级别的修复，warn 可见。
      try {
        this.ctx?.logger?.warn?.(
          `[input-guard] duplicate-tool-call-id summary sessionId=${sessionId ?? 'unknown'} renamedCalls=${duplicateCount} inputMessages=${messages.length}`,
        )
      } catch { /* debug only */ }
      this.audit('warn', 'input-guard.duplicate-tool-call-id.recovered', {
        sessionId,
        duplicateCount,
        originalMessageCount: messages.length,
      })
    }

    if (orphanCount > 0 || duplicateCount > 0 || process.env.DSH_EDGE_INPUT_GUARD_DEBUG === 'true') {
      // §7.46.2: orphan tool-call 清洗在 ops log 也开一行 — 跟主 sanitize
      // 路径不同，这是同步纯本地操作（不调 sanitizer），所以只 emit 一行
      // summary，不做 start/done 配对。orphanCount > 0 时输出，让 operator
      // 在 ops log 里能直接 grep 'orphan-tool-call summary' 看到修复量。
      try {
        this.ctx?.logger?.info?.(
          `[input-guard] orphan-tool-call summary sessionId=${sessionId ?? 'unknown'} orphanCount=${orphanCount} syntheticInjected=${syntheticInjected} duplicateRenamed=${duplicateCount} inputMessages=${messages.length} outputMessages=${out.length}`,
        )
      } catch { /* debug only */ }
      this.audit('warn', 'input-guard.orphan-tool-call.recovered', {
        sessionId,
        orphanCount,
        syntheticInjected,
        originalMessageCount: messages.length,
        recoveredMessageCount: out.length,
      })
    }

    return { messages: out, orphanCount, syntheticInjected, duplicateCount }
  }

  /**
   * 把拒收原因挂到 agent 对象上，供 http-api 在订阅 `session/event` 的
   * turn/end 监听器里读取（因为 agent-loop 把 `{ kind: 'reject' }` 翻译成
   * `turnEnds = { kind: 'blocked' }` 时会丢掉 reason 字符串）。
   *
   * 只在 reject 路径写入；正常 turn 不污染 agent 状态。
   */
  private attachRejection(
    agent: { _edgeRejection?: AgentEdgeRejection } & Record<string, unknown>,
    rejection: AgentEdgeRejection,
  ): void {
    agent._edgeRejection = rejection
  }

  /**
   * 读取 agent 上的 edge-route（由 http-api / 其他入口在 followup 前写入）。
   *  避免 input-guard 重复跑 intent-router.classify()（每次 ~0.5-1s）。*/
  private readEdgeRoute(agent: unknown): AgentEdgeRoute | undefined {
    const route = (agent as { _edgeRoute?: AgentEdgeRoute } | null | undefined)?._edgeRoute
    if (!route || typeof route !== 'object') return undefined
    if (typeof route.provider !== 'string' || typeof route.model !== 'string') return undefined
    if (!['LOCAL', 'CLOUD', 'SANITIZED'].includes(route.realm)) return undefined
    return route
  }

  /**
   * §7.175 (2026-11-11): 读宿主给本轮选的模型（agent/pre-step payload **顶层**
   *  的 `modelSelection`）。
   *
   *  宿主契约（dsh-agent-loop 0.2.2-rc.1，实测 app.asar）：
   *  `preStep` 里 `const selection = this.model.current()`，再以
   *  `waterfall('agent/pre-step', { messages, ...position, signal, modelSelection: selection })`
   *  派发 —— `modelSelection` 在 payload 顶层，形状 `{ provider, model, reasoningEffort? }`。
   *
   *  返回 undefined = **拿不到**（缺失 / 不是对象 / provider 不是非空字符串）
   *  ⇒ 无法证明本轮走本地 ⇒ 调用方必须 fail-closed。
   */
  private readModelSelection(payload: unknown): { provider: string; model?: string } | undefined {
    const raw = (payload as { modelSelection?: unknown } | null | undefined)?.modelSelection
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    const sel = raw as { provider?: unknown; model?: unknown }
    if (typeof sel.provider !== 'string' || sel.provider.length === 0) return undefined
    return {
      provider: sel.provider,
      model: typeof sel.model === 'string' ? sel.model : undefined,
    }
  }

  /** 正向 hook：agent/pre-step handler。暴露给测试。*/
  async handlePreStep(
    payload: {
      agent: { session: object & { id?: string }; id?: string; _edgeRoute?: AgentEdgeRoute } & Record<string, unknown>
      messages: ReadonlyArray<Record<string, unknown>>
      step: number
      signal?: AbortSignal
      /** §7.175: 宿主给本轮选的模型 —— payload **顶层**的
       *  `{ provider, model, reasoningEffort? }`（dsh-agent-loop 0.2.2-rc.1）。
       *  缺失 ⇒ 无法证明本轮走本地 ⇒ fail-closed 拒收。*/
      modelSelection?: unknown
    },
    next: () => Promise<{ kind: string; messages?: ReadonlyArray<Record<string, unknown>>; reason?: string }>,
  ): Promise<{ kind: string; messages?: ReadonlyArray<Record<string, unknown>>; reason?: string }> {
    // 默认 handler 先跑（组装 systemPrompt 段）
    const decision = await next()
    if (!this.config.enableInputGuard) return decision
    if (decision.kind === 'reject') {
      // 上游 hook 链已经拒了一次（多 hook 串联）。把上一家的 reason
      // 也透传到 _edgeRejection，让 http-api 看到 blocked 时能给客户端
      // 反馈原始原因。
      this.attachRejection(payload.agent, {
        kind: 'policy',
        reason: decision.reason ?? 'upstream-reject',
      })
      return decision
    }

    const sessionId = payload.agent.session.id ?? 'unknown'

    // §7.175 (2026-11-11): fail-closed 路由闸门挪到了**意图分类之后**（见下方
    // 「§7.175 fail-closed 闸门」注释块）—— 它要拿 category 当条件，而 category
    // 在这一段之后才定下来。
    //
    // 为什么不能放在分类之前：闸门的口径是「本轮判定为 LOCAL，却选了非本地
    // provider ⇒ 这一轮会把原文带出设备 ⇒ 拒收」。判定为 LOCAL 这件事本身
    // 要先分类才知道。
    //
    // 分类之前跑的东西都是**本地**的（prompt-guard 与 intent-router 的分类器
    // 都跑 local-llm-adapter，见 edge preset 的「Internal LLM stages never
    // target cloud-llm」），所以挪后不会让任何东西先出网。

    // 注意：next() 后 decision.messages 可能包含 dsh-agent-instructions 注入的
    // 运行上下文（user-role），会"覆盖"在真实用户消息之上。我们要处理的
    // 是原始 payload.messages 里的最后一条 user 消息。
    const originalLastUser = findLastUserText(payload.messages)
    if (!originalLastUser) return decision

    // §7.131 (2026-10-27): 消息来源观测 —— 纯审计，不改任何行为。
    //
    // 出网裁剪（cloud-egress）依赖「每条 assistant 消息的 source.provider」把
    // 会话历史切成「云段 / 本地段」。这个字段由宿主 dsh-llm 写（见
    // `ModelMessageSource extends AssistantProviderMetadata`），但值是运行时
    // 才有的 —— 静态读代码看不出来它到底填没填、填的是什么。
    //
    // 所以记一行分布：operator / 后续维护者能直接确认「这一段历史是本地
    // 池产生的还是云端产生的」，也就能验证裁剪的判据成立。
    //
    // 只在历史里**已有** assistant 消息时记 —— 首轮没有 assistant，分布是空
    // 的，记了也是噪音。审计只落 info/warn/security/error（debug 被过滤），
    // 所以这一行必须是 info。
    const assistantProviders = assistantProviderHistogram(payload.messages)
    if (Object.keys(assistantProviders).length > 0) {
      this.audit('info', 'input-guard.message-sources', {
        sessionId,
        messageCount: payload.messages.length,
        assistantProviders,
      })
    }

    // 1. 攻击检测 — 最便宜、最先阻断
    if (this.promptGuard) {
      // §7.46.6 (2026-09-12): prompt-guard checkInput 在 ops log 留一行 — 让
      // "prompt-guard 跑了没 / 多少 ms / safe 还是 unsafe" 在 ops log
      // 可见（之前只在 audit JSONL）。safe=true 时 summary 行；unsafe
      // 时单独发一行带 reason + riskLevel 便于 grep 排查。
      const pgStart = Date.now()
      let pgOutcome: 'safe' | 'unsafe' | 'error' = 'safe'
      let pgReason: string | undefined
      let pgRiskLevel: string | undefined
      try {
        const attackCheck = await this.promptGuard.checkInput(originalLastUser.text, sessionId)
        pgOutcome = attackCheck.safe ? 'safe' : 'unsafe'
        pgReason = attackCheck.reason
        pgRiskLevel = attackCheck.riskLevel
        try {
          this.ctx?.logger?.info?.(
            `[input-guard] prompt-guard done sessionId=${sessionId} durationMs=${Date.now() - pgStart} outcome=${pgOutcome}${pgReason ? ` reason=${pgReason}` : ''}${pgRiskLevel ? ` riskLevel=${pgRiskLevel}` : ''}`,
          )
        } catch { /* debug only */ }
        if (!attackCheck.safe) {
          // §7.106 operator ruling: LOCAL turn + credential-class detection
          // → warn and pass (nothing egresses; device-login credentials are
          // the user's own operation). Anything else keeps the block path.
          const localTurn = this.turnCategory.get(sessionId) === 'LOCAL'
          const credentialish = /credential|secret|password|passphrase|凭据|密码/iu.test(attackCheck.reason ?? '')
          if (localTurn && credentialish) {
            this.audit('warn', 'input-guard.attack.warned-local', {
              sessionId,
              reason: attackCheck.reason,
              riskLevel: attackCheck.riskLevel,
            })
          } else {
          this.audit('security', 'input-guard.blocked.attack', {
            sessionId,
            reason: attackCheck.reason,
            riskLevel: attackCheck.riskLevel,
            preview: redact(originalLastUser.text),
          })
          if (this.config.rejectOnPolicyViolation) {
            this.attachRejection(payload.agent, {
              kind: 'attack',
              reason: attackCheck.reason ?? 'attack-detected',
              riskLevel: attackCheck.riskLevel,
            })
            return { kind: 'reject', reason: attackCheck.reason ?? 'attack-detected' }
          }
          // fail-open on policy: 审计 + 放行（不推荐）
          this.audit('warn', 'input-guard.attack.fail-open', {
            sessionId, reason: attackCheck.reason,
          })
          }
        }
      } catch (err: any) {
        // prompt-guard 失败不阻断（fail-open）— 它是检测层，不是执行层
        this.audit('error', 'input-guard.prompt-guard.error', {
          sessionId, error: err?.message ?? String(err),
        })
      }
    }

    // 2. 策略判定 — privacy-policy REJECT
    // §7.87.13.2 (2026-09-21): hoisted ppRealm/ppConfidence/ppRationale/ppPattern
    // + edgeRoute to function scope so the §3 routing decision can use them
    // outside the if-block.
    let ppRealm: string | undefined
    let ppRationale: string | undefined
    let ppConfidence = 0
    let ppPattern = ''
    if (this.privacyPolicy) {
      // §7.46.6 (2026-09-12): privacy-policy matchRouting 在 ops log 留一行
      // — 让 "privacy-policy 跑没 / 多少 ms / realm=LOCAL|CLOUD|SANITIZED|REJECT"
      // 在 ops log 可见（之前只在 audit）。配合 preflight intent 让
      // operator 看 trace 知道 policy 路由分类（不是 LLM 分类 intent）。
      const ppStart = Date.now()
      try {
        const routing = this.privacyPolicy.matchRouting(originalLastUser.text)
        ppRealm = routing?.realm
        ppRationale = routing?.rationale
        ppConfidence = routing?.confidence ?? 0
        ppPattern = (routing as { pattern?: string } | null)?.pattern ?? ''
        try {
          this.ctx?.logger?.info?.(
            `[input-guard] privacy-policy done sessionId=${sessionId} durationMs=${Date.now() - ppStart} realm=${ppRealm ?? 'none'}${ppRationale ? ` rationale=${ppRationale}` : ''}`,
          )
        } catch { /* debug only */ }
        if (routing?.realm === 'REJECT') {
          this.audit('security', 'input-guard.blocked.policy', {
            sessionId,
            confidence: routing.confidence,
            rationale: routing.rationale,
            preview: redact(originalLastUser.text),
          })
          if (this.config.rejectOnPolicyViolation) {
            this.attachRejection(payload.agent, {
              kind: 'policy',
              reason: routing.rationale ?? 'privacy-policy-reject',
            })
            return { kind: 'reject', reason: routing.rationale ?? 'privacy-policy-reject' }
          }
          // fail-open on policy
          this.audit('warn', 'input-guard.policy.fail-open', {
            sessionId, rationale: routing.rationale,
          })
        }
      } catch (err: any) {
        this.audit('error', 'input-guard.privacy-policy.error', {
          sessionId, error: err?.message ?? String(err),
        })
      }
    }

    // 3. 意图分类 — 优先读 agent._edgeRoute（http-api 已分类），否则 fallback classify
    //
    // §7.87.13.2 (2026-09-21): privacy-policy matchRouting result is now
    // AUTHORITATIVE for non-REJECT routing, not just informational. When a
    // non-REJECT rule matches, use its realm directly and skip the LLM
    // classify step (edgeRoute + intentRouter). REJECT was already
    // authoritative; now LOCAL/SANITIZED/CLOUD are too. This makes
    // 身份证号/手机号/etc. keyword rules actually route to LOCAL, not
    // whatever the LLM picks (which would be CLOUD for any query also
    // containing "查天气" / "今天北京").
    //
    // Why this is safe:
    //   - REJECT path unchanged (block + fail-closed, already works).
    //   - LLM classify still used when no rule matches (most queries).
    //   - policy.confidence ≥ 0.7 gates the override (no low-quality rules).
    //   - intentSource + audit kind make the override observable.
    // §7.107 (2026-10-23, operator ruling「默认应该是本地，而不是云端」):
    // the fallback category used to be CLOUD ("分类失败用默认 CLOUD
    // (fail-open)"). An undecided turn now STAYS ON THE DEVICE — the cloud
    // is reached only through an explicit signal (the privacy-policy's
    // public-web rule, a CLOUD keyword, a confident classifier verdict that
    // names a web need, or a caller-supplied route). Everything else is
    // LOCAL, and LOCAL with no local endpoint fails closed with an
    // actionable error rather than silently egressing.
    let category: 'LOCAL' | 'CLOUD' | 'SANITIZED' | 'REJECT' = 'LOCAL'
    let edgeRouteUsed = false
    let intentConfidence = 0
    let intentRationale: string | undefined
    let policyClassified = false
    let targetRealm: 'LOCAL' | 'CLOUD' = 'LOCAL'
    // §7.87.13.2 (2026-09-21): edgeRoute hoisted to function scope so §4-5
    // (cloud-key-missing + sanitize-skip path) can still resolve it after
    // policyClassified short-circuits the if/else below.
    let edgeRoute: AgentEdgeRoute | undefined
    if (ppRealm && ppRealm !== 'REJECT' && ppConfidence >= 0.7) {
      // Privacy-policy override — non-REJECT rule wins over LLM/edgeRoute.
      category = ppRealm as 'LOCAL' | 'CLOUD' | 'SANITIZED'
      intentConfidence = ppConfidence
      intentRationale = ppRationale ?? `policy-rule:${ppRealm.toLowerCase()}`
      policyClassified = true
      this.audit('info', 'input-guard.policy.route-applied', {
        sessionId,
        policyRealm: ppRealm,
        policyConfidence: ppConfidence,
        policyRationale: ppRationale,
        policyPattern: ppPattern,
      })
    } else {
      edgeRoute = this.readEdgeRoute(payload.agent)
      if (edgeRoute) {
        if (edgeRoute.category === 'REJECT') {
          // §7.128: 调用方显式判了 REJECT —— 那是「拦下」的意思。此前这行
          // 是 `edgeRoute.category === 'REJECT' ? 'CLOUD' : edgeRoute.category`：
          // 把「拦下」静默升格成「上云」—— 本该拦下的原文反而送上云。
          // 今天走不到（http-api 的 REJECT 短路先于 _edgeRoute 写入，宿主
          // 也从不写它 —— app.asar 里 `_edgeRoute` 0 命中），所以是颗
          // **未引爆的地雷**：任何新增入口（fork / 新路由 / 宿主自己写）
          // 都会把「拦下」变成「上云」。按与 intentRouter REJECT 完全相同
          // 的语义处理：fail-closed 拦下，fail-open 交给下面的统一降级点。
          const reason = edgeRoute.rationale ?? 'edge-route-reject'
          this.audit('security', 'input-guard.blocked.edge-route', {
            sessionId, confidence: edgeRoute.confidence, rationale: edgeRoute.rationale,
          })
          if (this.config.rejectOnPolicyViolation) {
            this.attachRejection(payload.agent, { kind: 'intent', reason })
            return { kind: 'reject', reason }
          }
          this.audit('warn', 'input-guard.edge-route.fail-open', {
            sessionId, rationale: edgeRoute.rationale,
          })
        }
        category = edgeRoute.category
        edgeRouteUsed = true
        intentConfidence = edgeRoute.confidence ?? 0
        intentRationale = edgeRoute.rationale
      } else if (this.intentRouter) {
        try {
          const intent = await this.intentRouter.classify(originalLastUser.text, { sessionId })
          category = intent.category
          intentConfidence = intent.confidence ?? 0
          intentRationale = intent.rationale
          if (category === 'REJECT') {
            this.audit('warn', 'input-guard.blocked.intent', {
              sessionId, confidence: intent.confidence, rationale: intent.rationale,
            })
            if (this.config.rejectOnPolicyViolation) {
              this.attachRejection(payload.agent, {
                kind: 'intent',
                reason: intent.rationale ?? 'intent-reject',
              })
              return { kind: 'reject', reason: intent.rationale ?? 'intent-reject' }
            }
          }
        } catch (err: any) {
          this.audit('error', 'input-guard.intent-router.error', {
            sessionId, error: err?.message ?? String(err),
          })
          // 分类失败 → 保持默认 LOCAL（§7.107；此前是 CLOUD fail-open）
        }
        // §7.107: the public-web gate is NOT here — it is in the intent
        // router (`classify()` → `gateCloudVerdict`). The router's verdict
        // is read by two consumers (this hook and http-api's `_edgeRoute`),
        // and http-api hands it over as an EXPLICIT route that this hook
        // honours as-is — a gate here would have closed only this path.
        // A caller-supplied route stays honoured: it IS an explicit
        // statement of intent.
      }
    }
    // §7.128: **REJECT 绝不走 CLOUD。**
    // 走到这里说明 rejectOnPolicyViolation=false（fail-open）—— fail-closed
    // 的两条分支早已 return。REJECT 的意思是「这条别处理」，让它出网（哪怕
    // 去云池）恰恰是它说的反面：category='REJECT' 会让 shouldSanitize=false
    // 且 wantsDowngradeToLocal=false，于是原始路由（CLOUD）被原样保留 ——
    // 文本真的上云。统一在这里降级到 LOCAL：留在设备上继续。
    if (category === 'REJECT') {
      this.audit('warn', 'input-guard.reject.degraded-local', {
        sessionId, rationale: intentRationale,
      })
      category = 'LOCAL'
      intentRationale = intentRationale
        ? `${intentRationale}+reject-degraded-local`
        : 'reject-degraded-local'
    }
    // §7.106 (2026-10-23) 凭据粘性规则（操作者裁决：凭据交付不应走云端）：
    // 「用户名：X；密码：Y」这类消息是设备操作链（登录）的一环。上一轮被
    // 实体规则强制 LOCAL 时，交密码的后续轮必须留在 LOCAL——云端拿到的是
    // [CREDENTIAL_1] 占位符，编排出的登录命令必然失败（功能死路），而
    // 本地模型能拿真凭据完成 etscli auth login。方向与棘轮一致：只允许
    // 拧向更保守（LOCAL），绝不放宽。桌面实测驱动：13:03 minimax 轮把密码
    // 掩成占位符后询问「登录怎么做」，链路卡死。
    if (
      (category === 'CLOUD' || category === 'SANITIZED')
      && this.turnCategory.get(sessionId) === 'LOCAL'
      && containsCredential(originalLastUser.text)
    ) {
      this.audit('warn', 'input-guard.intent.sticky-local', {
        sessionId, from: category, to: 'LOCAL',
        rationale: 'credential-handoff-follows-local-context',
      })
      category = 'LOCAL'
      intentRationale = 'sticky-credential-local-context'
      intentConfidence = Math.max(intentConfidence, 0.9)
    }

    // §7.46 (2026-09-11): ops log 让"为什么路由到 SANITIZED/LOCAL/CLOUD"
    // 在每个 chat 都可见；TUI 路径之前只能靠 audit log 翻 JSONL，operator
    // 调 ops log 完全看不到 routing 决策。
    // §7.46.3 (2026-09-12): routeSource 字段加在 preflight 行 — 'http-api'
    // 表示 _edgeRoute 由 http-api 写入（含 category / confidence / rationale
    // 等已分类信息），'webui' 表示 dsh-web-app / dsh-tui chat 入口没写
    // _edgeRoute（intent-router fallback classify）。operator 看 ops log
    // 一眼区分这两种入口，便于排查"哪个入口配的路由决策"。
    // §7.46.7 (2026-09-12): intentSource 字段加在 preflight 行 — 区分
    // 意图分类的三条来源路径：(a) 'http-api-classified' _edgeRoute 由
    // http-api resolveRoute 写入；(b) 'llm-classified' intentRouter.classify()
    // 跑了 local-llm-adapter；(c) 'default-fallback' 两者都没跑（intentRouter
    // 抛错 / 不存在）。operator 一眼区分"intent 实际怎么来的"——
    // 之前只能靠 rationale 字段反推（default:sanitized / llm-classified:* /
    // http-api-classified:*），mibao trace 看到 default:sanitized 时 root cause
    // 不明显（是 local-llm hang fallback？还是 http-api resolveRoute 返回？）
    // §7.128: 映射写死「只有 CLOUD 才是 CLOUD」—— REJECT 永远不是 CLOUD。
    // 上一段已把 REJECT 降级为 LOCAL，这里是第二道保险：万一将来又有一条
    // 路径把 REJECT 塞进 category，它也不会被映射成出网。
    targetRealm = category === 'CLOUD' ? 'CLOUD' : 'LOCAL'

    // ── §7.175 (2026-11-11): fail-closed 路由闸门 ──────────────────────────
    //
    // 口径（主人裁决 2026-11-10「边缘模式恒用本地模型」，2026-11-11 补充
    // 「用哪个模型是用户自己的行为，别管」）：
    //
    //   · 本轮**判定为 LOCAL**（按端侧策略这一轮必须留在设备上），而宿主选的
    //     provider **不是本地 provider** ⇒ 这一轮会把原文带出设备 ⇒
    //     **reject**（fail-closed）。
    //     宿主选的 provider 来自 `agents.create({agentOptions.provider})`，
    //     改不了（宿主的 prepareRequest() 会对被改写的 provider/model 直接
    //     抛错，见 handleAgentRequest）⇒ 只能拒，不能改。
    //   · 反过来「判定要出网、但用户选的是本地模型」**不拦** —— 用哪个模型
    //     是用户自己的行为，input-guard 不替用户做这个决定（§7.174 字面口径：
    //     「本轮 realm 判 LOCAL 而 selection 不是本地模型 ⇒ reject」）。
    //   · modelSelection 拿不到 ⇒ 无法证明这一轮留在本地 ⇒ 按 fail-closed 拒
    //     （只在判定为 LOCAL 时才需要证明它）。
    //
    // 命中即 reject（绝不「放行到云端再说」），并把原因挂到
    // agent._edgeRejection —— agent-loop 翻译成 blocked 时会丢掉 reason
    // 字符串，http-api 只能靠这张小抄拿到原因（见 attachRejection）。
    //
    // §7.175: 读一次，后面两处都用它（闸门 + `intent.local` 审计行）。
    const selection = this.readModelSelection(payload)
    if (category === 'LOCAL') {
      // §7.184 (2026-11-11，主人裁决「选择器完全不动，实际请求改道到本地池」):
      // 会话选型**不再**决定这一轮放不放行。
      //
      // 旧口径（§7.175）：判定 LOCAL 而选型不是本地 provider ⇒ **拒绝这一轮**
      // （`model-selection-not-local`）。那时改不了路由（宿主的 prepareRequest()
      // 会对改写直接抛错），只能拒。现在能在**出网那一跳**改道（llm/stream 把
      // provider 换成本地池）⇒ 拒收没有意义：改道过去，这一轮就在本地跑。
      //
      // 旧口径里「用户明确选过云端模型 ⇒ 拒」其实与 §7.174「用哪个模型是用户
      // 自己的行为」相冲突 —— 现在两者都成立：选择器保持用户选的那个，
      // 而「本轮留在设备上」由改道保证。
      if (selection !== undefined && selection.provider !== this.config.localProvider) {
        this.audit('info', 'input-guard.reroute.planned', {
          sessionId,
          category,
          from: { provider: selection.provider, model: selection.model },
          to: this.config.localProvider,
          reason: 'edge-mode-local-intent',
        })
      }

      // 本地路由必须真的存在（§7.171）：宿主选了本地 provider，但路由没
      // 注册时这一轮必然失败。此时**不能**改写路由（宿主会抛错），也**不能**
      // 放行到云端 —— fail-closed：明确报错，并给出可操作的配置指引。
      //
      // 这一段只在「判定为 LOCAL」时跑 ⇒ 报错文案里那句「本轮 intent 判定为
      // LOCAL」是真的（§7.174 的门禁 verify-config-hints.mjs 也按这句字面量
      // 抽取本提示）。反向情形（判定为 CLOUD、但用户选了本地模型）不归这里管。
      const local = this.localAvailable()
      if (!local.ok) {
        this.audit('security', 'input-guard.local.route-missing', {
          sessionId,
          reason: local.reason,
          provider: this.config.localProvider,
        })
        try {
          this.ctx?.logger?.error?.(
            `[input-guard] local route unavailable sessionId=${sessionId} provider=${this.config.localProvider} reason=${local.reason} — refusing to fall back to a non-local route`,
          )
        } catch { /* debug only */ }
        throw new Error(
          `input-guard: 本轮 intent 判定为 LOCAL（宿主 modelSelection 指向 "${this.config.localProvider}"），按隐私裁决必须使用本地模型，`
          + `但本地路由 "${this.config.localProvider}" 不可用（${local.reason}）。`
          + `为避免本地数据/PII 出境，已阻止本轮上云。`
          // §7.159 (2026-10-30): the old hint pointed at DSH_EDGE_LOCAL_LLM_BASEURL
          // and called keyRef "an env-slot name". Both were wrong for the person
          // who actually hits this:
          //
          //   · the desktop GUI starts the host WITHOUT sourcing any .env, so
          //     process.env has no DSH_EDGE_* — the hint was unfollowable
          //     (measured on a clean Windows device: the operator set the env
          //     var and the route still did not register);
          //   · since §7.102 the pool lives in config/edge.json and `keyRef`
          //     is the LITERAL key under that file's `secrets` section, not the
          //     name of an environment variable.
          //
          // So: point at the file first, keep the env vars as the fallback
          // for headless profiles that CAN set them.
          + `请配置本地 LLM 端点：编辑 ~/.dsh-edge-agent/edge.json 的 llm.local 段，`
          + `填 baseUrl（OpenAI 兼容端点，必须含 /v1）与 model；`
          + `端点需要鉴权时，把密钥写进同一文件的 secrets 段，`
          + `并把 llm.local.keyRef 指向那个键名（keyRef 是 secrets 里的键名，不是环境变量名）。`
          + `若能设置进程环境变量，也可用 DSH_EDGE_LOCAL_LLM_BASEURL / DSH_EDGE_LOCAL_LLM_MODEL / `
          + `DSH_EDGE_LOCAL_LLM_KEY_ENV 覆盖，但桌面 GUI 启动的宿主读不到它们。`,
        )
      }
    }

    const routeSource: 'http-api' | 'webui' = edgeRouteUsed ? 'http-api' : 'webui'
    // §7.87.13.2 (2026-09-21): 'policy-classified' added — matchRouting result
    // overrode LLM/edgeRoute (see §7.87.13.2 comment block above). Distinct
    // from 'llm-classified' so ops log shows when privacy-policy is the source
    // of truth vs LLM fallback.
    const intentSource: 'policy-classified' | 'http-api-classified' | 'llm-classified' | 'default-fallback' =
      policyClassified
        ? 'policy-classified'
        : (edgeRouteUsed
          ? 'http-api-classified'
          : (this.intentRouter ? 'llm-classified' : 'default-fallback'))
    try {
      this.ctx.logger?.info?.(
        `[input-guard] preflight intent sessionId=${sessionId} category=${category} confidence=${intentConfidence} rationale=${intentRationale ?? 'n/a'} targetRealm=${targetRealm} routeSource=${routeSource} intentSource=${intentSource}`,
      )
    } catch { /* debug only */ }
    this.audit('info', 'input-guard.routed', {
      sessionId, category, edgeRouteUsed, routeSource,
    })
    // §7.106: remember the verdict for the next step's attack-block gate.
    this.putTurnCategory(sessionId, category)

    // §7.36 (2026-09-04): 注册 session realm 给 realm-skill-bridge,
    // 让 webui / tui / dsh-tui chat 入口也能被 Layer 3 tool-realm gating 守卫。
    //
    // 之前 setSessionRealm 只在 http-api 入口调用（http-api.ts:511 / 717）。
    // dsh-web-app / dsh-tui chat 入口走 dsh-agent-loop 时不挂 _edgeRoute,
    // realmSkillBridge.sessionRealms 没有这个 sessionId →
    // checkToolRealm 走 fail-open 分支（agentRealm === undefined）→
    // web_search / web_fetch 等 CLOUD tool 不被 deny,LOCAL LLM 自由上云搜。
    //
    // input-guard 在分类后立即补一次 setSessionRealm,使 webui/tui 入口的
    // session 也能被 realm-skill-bridge 识别。
    // §7.128: 此前这里是 `if (category !== 'REJECT')` —— REJECT 不注册 realm，
    // 因为那一轮不跑。但 §7.128 之后 REJECT 已被统一降级点改成 LOCAL
    // （fail-open 时），那一轮**会**跑：若仍不注册 realm，gating 又走
    // fail-open（agentRealm === undefined）→ 本地模型可以调 web_search 出网
    // —— 正好是 REJECT 要防的那件事。所以现在无条件注册（类型也随之收窄到
    // 'LOCAL' | 'CLOUD' | 'SANITIZED'，与 setSessionRealm 签名一致）。
    // 失败/缺失时静默 no-op（realmSkillBridge 是可选依赖）。
    const bridge = (this.ctx as unknown as { realmSkillBridge?: RealmSkillBridgeLike }).realmSkillBridge
    if (bridge && typeof bridge.setSessionRealm === 'function') {
      try {
        bridge.setSessionRealm(sessionId, category)
        this.audit('info', 'input-guard.session-realm.registered', {
          sessionId,
          category,
          edgeRouteUsed,
          routeSource: edgeRouteUsed ? 'http-api' : 'webui',
        })
      } catch (err: any) {
        this.audit('warn', 'input-guard.session-realm.failed', {
          sessionId, error: err?.message ?? String(err),
        })
      }
    }

    // §7.175 (2026-11-11): 「云端不可用 → 降级 LOCAL」这条路径退役了。
    //
    // 它当年唯一的用途是**改写路由**（agent/request 里把 provider 换成
    // local-llm）。现在路由由宿主的 modelSelection 决定、input-guard 不再
    // 改写，而且 §7.175 的 fail-closed 闸门已经把「本轮要派发到非本地
    // provider」的轮次全部拒掉 —— 能跑到这里的轮次，路由恒为本地。
    //
    // 所以云池通不通已经不影响本轮（它根本不会被用到），既不降级、也不
    // 跳过脱敏：`shouldSanitize` 仍按意图分类决定，下面照常脱敏。

    // 4. 脱敏（仅 CLOUD 路径，或显式开启 LOCAL）
    const shouldSanitize = category === 'CLOUD' || category === 'SANITIZED' || this.config.sanitizeLocalTraffic
    if (!shouldSanitize || !this.sanitizer) {
      // §7.175: 意图分类不再决定路由 —— 路由恒为宿主的 modelSelection
      // （本地，由上面的 fail-closed 闸门保证）。这里保留的只有两件事：
      // 记下这一轮的状态，以及把「意图判定为 LOCAL」记进审计。
      //
      // routeSource='http-api' when _edgeRoute was set on agent (even malformed;
      // raw presence = http-api wrote it). 'webui' when _edgeRoute absent.
      const hasRawEdgeRoute = typeof (payload.agent as { _edgeRoute?: unknown })?._edgeRoute !== 'undefined'
      const routeSource: 'http-api' | 'webui' = hasRawEdgeRoute ? 'http-api' : 'webui'
      this.putStepState(sessionId, {
        sanitized: false, replacements: 0, sessionId, timestamp: Date.now(),
        routeSource,
      })
      if (category === 'LOCAL') {
        this.audit('security', 'input-guard.intent.local', {
          sessionId, category, reason: 'intent-local', routeSource,
          provider: selection?.provider,
          model: selection?.model,
        })
      }
      return decision
    }

    // §7.46.2 (2026-09-12): sanitize call ops log — 让"调了 sanitizer /
    // 替换了几个 PII / 多久 / 失败原因"在 ops log 里可见。start 在
    // `sanitizer.sanitize()` 之前 emit；done 在 success 分支 emit（含
    // replacementCount 和是否替换文本）；wireError 字段跟
    // cloud/local-llm-adapter §7.46.1 done 行对齐。失败由外层
    // catch（handlePreStep 原结构）继续处理 sanitize-failed audit。
    const sanitizeStart = Date.now()
    // §7.123 (2026-10-27): sanitize EVERY user message, not just the last.
    // The agent loop ships the whole conversation to the model, so a PII
    // value typed in an earlier turn rode along in the history unredacted.
    // `userMessages` comes from payload.messages (the real user turns) —
    // decision.messages additionally carries synthetic user-role runtime
    // context injected by dsh-agent-instructions, which is not user content
    // and must not be rewritten.
    const userMessages = findUserTexts(payload.messages)
    try {
      this.ctx?.logger?.info?.(
        `[input-guard] sanitize start sessionId=${sessionId} category=${category} inputLen=${originalLastUser.text.length} userMessages=${userMessages.length}`,
      )
    } catch { /* debug only */ }
    try {
      // Sanitize each user turn independently. The sanitizer's mapping table
      // is session-scoped, so the same PII value across turns collapses onto
      // the same placeholder (and `maxReplacementsPerSession` still bounds
      // the session-wide total).
      const sanitizedByIndex = new Map<number, string>()
      const piiTypes = new Set<string>()
      let totalReplacements = 0
      for (const um of userMessages) {
        const result = await this.sanitizer.sanitize(um.text, { sessionId })
        if (result.replacements.length === 0) continue
        totalReplacements += result.replacements.length
        for (const r of result.replacements) piiTypes.add(r.piiType)
        sanitizedByIndex.set(um.index, result.sanitizedText)
      }
      const replacements = totalReplacements
      const sanitizeDurationMs = Date.now() - sanitizeStart
      if (replacements > 0) {
        // 用 index（来自 payload.messages）替换 decision.messages 里对应的
        // user 消息 —— 不是最后一条 user，因为 dsh-agent-instructions 可能在
        // 末尾追加了 user-role 注入。
        const newMessages = replaceUserTextsAt(decision.messages ?? payload.messages, sanitizedByIndex)
        this.putStepState(sessionId, {
          sanitized: true, replacements, sessionId, timestamp: Date.now(),
        })
        this.audit('info', 'input-guard.sanitized', {
          sessionId, replacementCount: replacements, category,
          // §7.123: how many user turns were rewritten — the "1" that used
          // to be implied by "only the last message" is now explicit.
          sanitizedMessages: sanitizedByIndex.size,
          userMessages: userMessages.length,
          piiTypes: [...piiTypes],
        })
        // §7.46.2: sanitize done 行 (success, replaced) — 跟 start 行配对
        try {
          this.ctx?.logger?.info?.(
            `[input-guard] sanitize done sessionId=${sessionId} category=${category} durationMs=${sanitizeDurationMs} replacementCount=${replacements} sanitizedMessages=${sanitizedByIndex.size} outcome=replaced`,
          )
        } catch { /* debug only */ }
        return { ...decision, messages: newMessages }
      }
      // 没替换：状态标记 sanitized=false
      this.putStepState(sessionId, {
        sanitized: false, replacements: 0, sessionId, timestamp: Date.now(),
      })
      // §7.46.2: sanitize done 行 (success, no replacement) — sanitizer 跑了一
      // 遍但没替换；区别 outcome=clean 跟 outcome=replaced
      try {
        this.ctx?.logger?.info?.(
          `[input-guard] sanitize done sessionId=${sessionId} category=${category} durationMs=${sanitizeDurationMs} replacementCount=0 outcome=clean`,
        )
      } catch { /* debug only */ }
      return decision
    } catch (err: any) {
      // ── sanitize 失败 ────────────────────────────────────────
      // 系统故障（不是 user 行为不端）。两条路径：
      //   - downgradeOnSanitizeFailure=true (默认)：放行本轮。§7.175 起
      //     这里**不再有「降级」** —— 路由恒为宿主的 modelSelection（本地，
      //     由 fail-closed 闸门保证），原始 PII 留在本地模型，不出境。
      //   - downgradeOnSanitizeFailure=false：REJECT step，user 看到空
      //     result（保守策略，配置可选）。
      const reason = err?.message ?? String(err)
      const sanitizeDurationMs = Date.now() - sanitizeStart
      // §7.46.2: sanitize failed 行 — 让 operator 在 ops log 看到失败原因 +
      // duration，外层 catch 仍按原逻辑处理 audit。
      try {
        this.ctx?.logger?.info?.(
          `[input-guard] sanitize failed sessionId=${sessionId} category=${category} durationMs=${sanitizeDurationMs} wireError=${reason}`,
        )
      } catch { /* debug only */ }
      this.audit('security', 'input-guard.sanitize.failed', {
        sessionId, error: reason, category,
      })

      if (!this.config.downgradeOnSanitizeFailure) {
        this.attachRejection(payload.agent, {
          kind: 'sanitizer',
          reason: 'sanitizer-failed',
        })
        return { kind: 'reject', reason: 'sanitizer-failed' }
      }

      // 放行：messages 不修改（保留原文）—— 本轮走本地模型，不出境。
      this.putStepState(sessionId, {
        sanitized: false, replacements: 0, sessionId, timestamp: Date.now(),
      })
      return decision
    }
  }

  /** `agent/request` handler —— §7.175 起**只放行，不改路由**。
   *
   *  为什么不再改写：宿主 dsh-agent-loop 的 prepareRequest() 会拿
   *  `proposedConfig` 与 `this.model.current()`（宿主给本轮选的模型）比对，
   *  provider / model / reasoningEffort 任一不同就**直接抛错**。所以在
   *  agent/request 里改写 provider/model 不是「降级到本地」，而是让整轮
   *  直接失败。
   *
   *  现在：路由恒由宿主的 modelSelection 决定，边缘模式恒为本地模型
   *  （主人裁决 2026-11-10）；「本该本地却可能上云」的判定与 fail-closed
   *  拦截都在 handlePreStep 里做（见那里的 modelSelection 闸门）。
   *
   *  这里保留这个 handler 只为把「不改路由」这条契约钉死：seedConfig 原样
   *  返回，一个字节都不改。
   *
   *  注意 DSH waterfall 契约：监听器真实签名是 `(payload, next)`，
   *  其中 `payload` 已被 dsh-agent 的 fused wrapper 注入 `agent` 字段
   *  （见 @deepseek-ai/dsh-agent/lib/types/dispatch.js#agentEvents）。
   *  上一层 apply() 必须先 `await next()` 取出 seedConfig 后再传进来，
   *  因为 next() 是 chain 的下一步，handler 不能跳过它直接返回。*/
  async handleAgentRequest(
    payload: { turn?: number; step?: number; signal?: AbortSignal; agent?: { session?: { id?: string } } },
    seedConfig: AgentRequestConfig,
    next: () => Promise<AgentRequestConfig>,
  ): Promise<AgentRequestConfig> {
    // §7.175: 不改路由。seedConfig 原样返回。
    return seedConfig
  }

  /**
   * §7.144: 宿主 provider 的调用要不要记？返回一个记录器，或 undefined。
   *
   * **不记**的三种情形：
   *
   *   1. provider 属于本项目自管池（`local-llm` / `cloud-llm`）—— adapter
   *      自己已经记过（REQ + RESP），这里再记一遍面板上就是同一通调用出现
   *      两条。
   *   2. `purpose` 非空 —— 宿主的内部用途（compaction / session-title），
   *      不是主人关心的「这一轮调用」，记了只给面板添噪音。
   *   3. provider 缺失 / trace 总开关关闭 / 任何异常 ⇒ 不记（观测路径永不
   *      拖垮主链路）。
   *
   * 记的那一类是**宿主自己的 provider**（delegate 出去的云池，如
   * `qwen-token-plan-cn`）—— 它不经过本项目任何 adapter，是面板里唯一
   * 「完全看不见」的一跳。
   */
  private hostCallRecorder(options: {
    provider?: unknown
    model?: unknown
    sessionId?: unknown
    messages?: unknown
    system?: unknown
    tools?: unknown
    purpose?: unknown
    temperature?: unknown
    maxTokens?: unknown
  }): HostCallRecorder | undefined {
    try {
      if (!this.traceConfig.enabled) return undefined
      const provider = typeof options?.provider === 'string' ? options.provider : ''
      if (provider.length === 0) return undefined
      const own = OWN_POOL_PROVIDERS.includes(this.config.localProvider)
        ? OWN_POOL_PROVIDERS
        : [...OWN_POOL_PROVIDERS, this.config.localProvider]
      if (isOwnPoolProvider(provider, own)) return undefined
      const purpose = typeof options?.purpose === 'string' ? options.purpose : ''
      if (purpose.length > 0) return undefined
      const sessionId = typeof options?.sessionId === 'string' ? options.sessionId : ''
      if (sessionId.length === 0) return undefined

      const request: HostCallRequest = {
        provider,
        model: typeof options?.model === 'string' ? options.model : '?',
        sessionId,
        messages: Array.isArray(options?.messages)
          ? options.messages as HostCallRequest['messages']
          : [],
      }
      if (typeof options?.system === 'string') request.system = options.system
      if (Array.isArray(options?.tools)) {
        request.tools = options.tools as HostCallRequest['tools']
      }
      const params: { temperature?: number; maxTokens?: number } = {}
      if (typeof options?.temperature === 'number') params.temperature = options.temperature
      if (typeof options?.maxTokens === 'number') params.maxTokens = options.maxTokens
      if (Object.keys(params).length > 0) request.params = params

      const sink: TraceSink = {
        log: (entry) => this.auditLog?.log(entry) ?? Promise.resolve(),
        store: getTraceStore(),
      }
      // §7.134: REQ 与 RESP 共用一个 callId ⇒ 面板上仍是「上请求、下响应」。
      // 键取 options 的对象身份：同一次往返拿到的是**同一个**引用。
      return new HostCallRecorder({
        sink,
        config: this.traceConfig,
        request,
        callId: callIdFor(options),
      })
    } catch {
      return undefined
    }
  }

  /**
   * §7.151 (2026-10-29): 换掉请求体**重新派发**这一通出网调用。
   *
   * 为什么不能就地改写：宿主契约明写 LOOP 构建的请求是 **deep-frozen**
   * （`markAgentLoopRequest` + `deepFreeze`），"listeners read it, never rewrite
   * it"。所以唯一能换掉请求体的姿势就是换一个请求对象再派发一次 ——
   * 与 `cloud-llm-adapter` 的 delegate 路径同一个姿势，宿主侧已验证可行。
   *
   * 重新派发会**再进一次 waterfall**：本方法给裁过的请求对象打标记
   * （`HostEgressGuard.markTrimmed`），守卫下一次看到它直接放行 ⇒ 不递归、
   * 不二次裁剪；那一趟里 trace 记录的是**真正发出去的那一份**。
   *
   * fail-closed：裁不动就不许出网 —— 放行等于把本地历史原样送上去。
   */
  private async * dispatchTrimmed(
    options: { signal?: AbortSignal; sessionId?: string; [key: string]: unknown },
    egress: HostEgressPlan,
    state: StepSanitizationState,
  ): AsyncIterable<StreamChunkLike> {
    const provider = typeof options.provider === 'string' ? options.provider : ''
    const model = typeof options.model === 'string' ? options.model : ''
    const trimmed = { ...options, messages: egress.messages }
    this.hostEgressGuard.markTrimmed(trimmed)

    this.audit('info', 'llm.cloud.egress', {
      ...sessionIdField(state.sessionId),
      provider,
      model,
      // via 字段区分是哪一跳裁的：'host-provider' = 宿主原生 provider（桌面
      // GUI 选的模型，本部署的常态）；cloud-llm-adapter 自己出的行没有此字段。
      via: 'host-provider',
      keptMessages: egress.messages.length,
      droppedLocalHistory: egress.droppedCount,
      replacements: state.replacements,
      // 本轮 pre-step 是否做过脱敏（脱敏在 pre-step 就完成了 —— 那里改的是
      // 会话日志里的用户消息，出网请求带的就是脱敏后的文本）。
      sanitized: state.sanitized,
      providerHistogram: egress.histogram,
    })

    // §7.151 (2026-10-29): 取 LLM runtime **必须走 `ctx.get()`**，不能直取
    // `ctx.llm` —— cordis 4.x 的 ctx 是 Proxy：input-guard 的 inject 是
    // `['promptGuard','privacyPolicy','intentRouter','sanitizer','auditLog',
    // 'realmSkillBridge']`，**没有 'llm'**，而本插件跑在边缘模式 preset 的
    // scope 里 ⇒ 直取 `ctx.llm` 会**直接抛**
    // `cannot get property "llm" without inject`（15:54 实机：整轮处理失败）。
    //
    // 同文件的 `localAvailable()` 用 `this.ctx.get?.('modelRouter')` 取 runtime
    // —— 这里跟它同款。
    const llm = (() => {
      try {
        return (this.ctx as unknown as {
          get?: (name: string) => unknown
        }).get?.('llm') as {
          stream?: (o: unknown) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>
        } | undefined
      } catch {
        return undefined
      }
    })()
    if (typeof llm?.stream !== 'function') {
      this.audit('security', 'llm.cloud.egress.blocked', {
        ...sessionIdField(state.sessionId),
        provider,
        model,
        reason: 'llm-runtime-unavailable',
        droppedLocalHistory: egress.droppedCount,
      })
      throw new Error(
        'input-guard: 出网裁剪无法重新派发（宿主 LLM runtime 不可用）—— 已阻止本轮出网',
      )
    }

    const raw = llm.stream.call(llm, trimmed)
    const resolved = (raw != null && typeof (raw as { then?: unknown }).then === 'function')
      ? await (raw as Promise<AsyncIterable<unknown>>)
      : raw as AsyncIterable<unknown>
    yield* resolved as AsyncIterable<StreamChunkLike>
  }

  /**
   * 反向 hook：llm/stream handler。暴露给测试。
   *
   * `options` 的索引签名是**如实描述**宿主的载荷：`llm/stream` 派发的是
   * 完整的 `GenerateOptions`（provider / model / messages / tools / …），
   * §7.144 的宿主调用记录正是从这些字段里取「发出去的那一坨」。
   */
  handleLlmStream(
    options: { signal?: AbortSignal; sessionId?: string; [key: string]: unknown },
    next: () => AsyncIterable<StreamChunkLike>,
  ): AsyncIterable<StreamChunkLike> {
    const requestSessionId = options?.sessionId
    const state = requestSessionId ? this.stepState.get(requestSessionId) : undefined
    if (!this.config.enableInputGuard) return next()
    if (!requestSessionId) return next()

    // §7.144: 非边缘会话（标准模式等）没有 pre-step 留下的 stepState ⇒
    // 直接直通、零记录。这条守住 §7.140 的不变式：标准模式会话的审计链
    // 里一条 edge 事件都不该有。
    if (!state) return next()

    // §7.184 (2026-11-11): 本轮判定 LOCAL ⇒ 实际请求**改道**到本地池。
    //
    // 位置要紧：改道排在**出网裁剪之前** —— 本地池按 §7.131 带**全部**历史
    // （本地池不出网，不裁）；要是先裁了再改道，本地池就只拿到「云段历史」，
    // 上下文凭空少一截。
    if (this.needsLocalReroute(options, state)) {
      return this.dispatchRerouted(options, state)
    }

    // §7.151 (2026-10-29): 出网裁剪（§7.131 口径：只带云段历史）。
    //
    // 这一跳在 **trace 记录之前**：被换掉的那通请求根本没出网，记它等于把
    // 「未裁剪的请求体」挂到面板上 —— 主人 10-29 看到的就是那个。
    // 裁完的那通会**重新进一次 waterfall**，那时才轮到 trace 记录 ⇒ 面板上
    // 显示的是真正发出去的那一份（只带云段历史）。
    //
    // 位置要紧：裁剪**不依赖 sanitizer**（脱敏栈关掉不等于可以带本地历史
    // 出网）—— 所以它排在 sanitizer 检查**之前**。
    //
    // §7.165：裁剪判断本身抛错时，**保留 fail-closed，但必须留下证据**。
    //
    // 抛错路径确实存在：`planCloudEgress` 遍历消息时会读 `message.role`，
    // 数组里混进 null / undefined 元素就会抛 TypeError。宿主契约下消息都是
    // 规范对象（不会混进 null），但「守卫不能被人为构造的载荷打穿」这条要
    // 守住 —— 实测确认：抛错发生在派发**之前**（`plan()` 在 waterfall 监听器
    // 里同步执行），⇒ 请求**根本没到 provider**（fail-closed，不会泄露）。
    //
    // 缺的是证据：原来这一路上没有任何审计行，面板上看起来像「什么都没发生」。
    // 本项目对面板的纪律是反的 ——「宁可漏显示，也不能显示一件没发生过的事」；
    // 这里恰恰相反：**发生了拦截却什么都不显示**。所以补一条审计行，并把
    // 异常原样抛出（fail-closed 语义一个字都不改）。
    let egress: HostEgressPlan | undefined
    try {
      egress = this.hostEgressGuard.plan(options)
    } catch (err) {
      this.audit('security', 'llm.cloud.egress.blocked', {
        ...sessionIdField(state.sessionId),
        provider: typeof options.provider === 'string' ? options.provider : '',
        model: typeof options.model === 'string' ? options.model : '',
        via: 'host-provider',
        reason: 'plan-error',
        error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
      })
      throw err
    }
    if (egress !== undefined) {
      return this.dispatchTrimmed(options, egress, state)
    }

    // §7.163: 只有「脱敏会话」需要 sanitizer 做 desanitize；未脱敏会话的
    // 输出掩码兜底不需要它。所以这个早退只挡「要 desanitize 却没 sanitizer」
    // 这一种情况 —— 否则掩码兜底会被 sanitizer 的存在与否绑住（生产里
    // 两者总是一起出现，但绑住没有道理）。
    const needsDesanitize = state.sanitized === true && state.replacements > 0
    if (needsDesanitize && !this.sanitizer) return next()

    let stream = next()

    // §7.144: 宿主 provider 那一跳的记录。必须接在下面「没脱敏就直通」的
    // 早退**之前** —— CLOUD 轮次常常一条 PII 都没有（sanitized=false），
    // 放到早退之后就永远记不到，面板里云端模型仍然整条缺失。
    //
    // 顺序有讲究：recorder 在**内**（先看到脱敏后的占位符原文），desanitize
    // 在**外**（把占位符还原给主人看）。于是 trace 记的是「云端真正收到 /
    // 返回的」—— 与发出去的请求一致，不掺还原后的原文。
    const hostRecorder = this.hostCallRecorder(options)
    if (hostRecorder !== undefined) {
      stream = hostRecorder.wrap(stream) as AsyncIterable<StreamChunkLike>
    }

    // §7.163 (2026-10-31): 输出侧 PII 掩码兜底。
    //
    // 背景：input-guard 迁移（eaec70b）时声明要把 http-api 的
    // prompt-guard.checkOutput 一起搬过来，但只搬了 desanitize —— 掩码侧
    // 留在 http-api 的旧位置，随后随 http-api 瘦身被删掉 ⇒ checkOutput
    // 成了死代码。后果：state.sanitized=false 的会话（LOCAL-only，或 CLOUD
    // 但本轮没命中任何 PII）的**输出**一路直通，不经任何掩码。
    //
    // 审计层（audit-log）与存储层（local-storage）另有 redactObject 兜底，
    // 但用户可见的输出（面板、客户端、SSE）没有 —— 这条缺口就是这里补的。
    //
    // 语义与迁移前一致：
    //   sanitized=true  → 本轮发生过 sanitizer 脱敏，输出里的 PII 是
    //                      desanitize **还原**出来的原文 ⇒ 跳过掩码，
    //                      否则会把刚还给用户的 PII 又遮掉。
    //   sanitized=false → 没有还原发生过 ⇒ 对输出做不可逆掩码。
    //
    // 跨 chunk：PII 可能被流式切成多块（手机号断成两块时各自都匹配不上），
    // 所以逐块掩码会漏。这里用「尾部待定区」策略：保留尾部
    // PII_MASK_TAIL_CHARS 个字符待定，只对更早的安全前缀做掩码。
    // 128 覆盖了最长的一条规则（credential：标签 + 分隔符 + 64 位值 ≈ 90）。
    //
    // 位置：必须在「没脱敏就直通」的早退**之后** —— 脱敏会话的输出要交给
    // desanitize 还原，不能走这条掩码路径。
    if (!needsDesanitize) {
      if (!this.promptGuard?.checkOutput) return stream

      const maskGuard = this.promptGuard
      const maskAudit = this.auditLog
      const maskSessionId = state.sessionId
      // 迁移前 http-api 的原始写法是 `wasSanitized = !!sanitizationInfo`，
      // 即「本轮发生过脱敏替换 ⇒ 输出里的 PII 是 desanitize 还原出来的
      // 原文 ⇒ 跳过掩码」。这里落在掩码分支里 ⇒ 恒为 false（没脱敏过）。
      const wasSanitized = false
      const maskBuffer = { value: '' }
      // 最近一个 text-delta 的 block index —— 补发待定区时要带上它，
      // 否则宿主 BlockAssembler 会把补发的文本算成另一个 block。
      let lastTextIndex: unknown = undefined
      /**
       * 掩码一段文本，并把「掩了几条、哪几类」记进审计。
       *
       * §7.163 实机复盘（10-31）：最初只在 text-delta 的 head 分支记审计，
       * 而实机上真正执行掩码的常常是 **block-end** 那条（短回复走不到 head
       * 分支）⇒ 面板上看不到任何掩码记录，事实与记录不符。现在三条路径
       * （delta head / block-end 的待定区 / block-end 的 block.text / 流尾
       * 补发）统一走这里。
       */
      const maskText = async (text: string): Promise<string> => {
        const filtered = await maskGuard.checkOutput!(text, { sanitized: wasSanitized })
        if (filtered.redacted.length > 0 && maskAudit) {
          void maskAudit.log({
            level: 'info',
            kind: 'input-guard.output.masked',
            source: 'input-guard',
            payload: {
              sessionId: maskSessionId,
              count: filtered.redacted.length,
              types: [...new Set(filtered.redacted.map((r) => r.type))],
            },
          }).catch(() => {})
        }
        return filtered.filtered
      }
      const masked = (async function* (): AsyncIterable<StreamChunkLike> {
        try {
          for await (const chunk of stream) {
            if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) {
              lastTextIndex = chunk.index
              maskBuffer.value += chunk.text
              // 待定区不足一个安全前缀长度时先攒着，避免把半个 PII 放出去。
              if (maskBuffer.value.length <= PII_MASK_TAIL_CHARS) continue
              const cut = maskBuffer.value.length - PII_MASK_TAIL_CHARS
              const head = maskBuffer.value.slice(0, cut)
              maskBuffer.value = maskBuffer.value.slice(cut)
              const maskedHead = await maskText(head)
              if (maskedHead.length > 0) {
                yield { ...chunk, text: maskedHead }
              }
              continue
            }
            if (chunk.type === 'block-end') {
              // block-end 带完整 block.text（宿主的 BlockAssembler 以它为准，
              // delta 只是增量路径）。所以待定区在 block-end 之前补发成
              // text-delta —— 只看 delta 的消费方才不会丢掉这一段 ——
              // 而 block.text 本身也整段过一遍掩码。
              const block = chunk.block as { type?: string; text?: string } | undefined
              const tail = maskBuffer.value
              maskBuffer.value = ''
              if (tail.length > 0) {
                try {
                  const maskedTail = await maskText(tail)
                  if (maskedTail.length > 0) {
                    yield { type: 'text-delta', index: lastTextIndex, text: maskedTail } as StreamChunkLike
                  }
                } catch {
                  yield { type: 'text-delta', index: lastTextIndex, text: tail } as StreamChunkLike
                }
              }
              if (block && typeof block.text === 'string' && block.text.length > 0) {
                try {
                  const maskedBlock = await maskText(block.text)
                  yield { ...chunk, block: { ...block, text: maskedBlock } }
                } catch {
                  yield chunk
                }
              } else {
                yield chunk
              }
              continue
            }
            yield chunk
          }
          // 流结束：把待定区最后一段也掩码后吐出（否则尾部 PII 永远不发出去）。
          if (maskBuffer.value.length > 0) {
            const tail = maskBuffer.value
            maskBuffer.value = ''
            try {
              const maskedTail = await maskText(tail)
              if (maskedTail.length > 0) {
                yield { type: 'text-delta', index: lastTextIndex, text: maskedTail } as StreamChunkLike
              }
            } catch {
              yield { type: 'text-delta', index: lastTextIndex, text: tail } as StreamChunkLike
            }
          }
        } catch (err: any) {
          // 掩码是兜底不是主防线：失败时放行原文并留审计，绝不阻断回复。
          if (maskAudit) {
            void maskAudit.log({
              level: 'error',
              kind: 'input-guard.output.mask-error',
              source: 'input-guard',
              payload: { sessionId: maskSessionId, error: err?.message ?? String(err) },
            }).catch(() => {})
          }
          yield { type: 'text-delta', index: lastTextIndex, text: maskBuffer.value } as StreamChunkLike
          maskBuffer.value = ''
        }
      })()
      return masked
    }

    // 走到这里说明 needsDesanitize 为真 ⇒ sanitizer 必然存在（上面早退过）。
    // 这个 if 只是为了让类型收窄，运行时不可达。
    const sanitizer = this.sanitizer
    if (!sanitizer) return stream
    const sessionId = state.sessionId
    const auditLog = this.auditLog

    // §7.46.3 (2026-09-12): desanitize ops log — 让"LLM reply 里把占位符
    // 还原回 PII"在 ops log 可见。operator 看到 reply 含 PII 时，ops log
    // 直接 grep sessionId 就能知道这是 desanitize 还原的结果（新泄漏 vs
    // 还原回原文）。每个 step 只 emit 一行 summary（不是 per-call）—
    // 因为 text-delta 阶段 desanitize 被 flushBuffer 拆成多次小调用，
    // per-call 会刷 spam；step 结束后汇总一次更合适。
    let desanitizeChunkCount = 0
    let desanitizeErrorCount = 0
    let desanitizeRestoredBytes = 0
    // §7.46.3: capture ctx logger 引用 — wrapped 是匿名 async generator
    // function，内部 this 不继承外层 class this，必须在外层拿到 logger
    // 再传进去；直接用 `this.ctx?.logger?.info?.(...)` 在 async generator
    // body 里 TS 报 'this' implicitly has type 'any'.
    const loggerForDesanitize = this.ctx?.logger

    // 包装 stream：对 text-delta 调 desanitize，其他 chunk 透传
    //
    // 注意：占位符（如 [PHONE_1]）可能被 LLM 流式输出时拆成多个 chunk
    // （如 `['[', 'PH', 'ONE', '_', '1]', ...]`）。每 chunk 单独 desanitize
    // 找不到完整占位符，导致还原失败。
    //
    // 解决：用 streamingPlaceholderBuffer 跨 chunk 累积文本。每收到新 chunk
    // 就把 buffer+chunk 合并、desanitize，然后 flush 掉所有"不可能是占位符
    // 前缀"的前缀部分，剩下的尾部（可能是不完整的 `[PHONE_`）留到下一 chunk。
    //
    // flush 策略：找出 buffer 中最后一个 `[` 之后的内容，若该 `[` 没有匹配的 `]`
    // 则保留从该 `[` 开始的所有文本作为新 buffer；前面的文本一定不含未完成的
    // 占位符，可以安全 desanitize 后 yield。
    const streamingPlaceholderBuffer = { value: '' }
    let chunkCount = 0
    let textDeltaCount = 0
    const desanitizeCallCount = 0
    const wrapped = (async function* (): AsyncIterable<StreamChunkLike> {
      try {
        for await (const chunk of stream) {
          chunkCount++
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) {
            textDeltaCount++
            try {
              const restored = await flushBuffer(sanitizer, sessionId, streamingPlaceholderBuffer, chunk.text)
              if (restored.length > 0) {
                desanitizeRestoredBytes += restored.length
                desanitizeChunkCount++
                yield { ...chunk, text: restored }
              }
            } catch (err: any) {
              desanitizeErrorCount++
              if (auditLog) {
                void auditLog.log({
                  level: 'error',
                  kind: 'input-guard.desanitize.error',
                  source: 'input-guard',
                  payload: { sessionId, error: err?.message ?? String(err) },
                }).catch(() => {})
              }
              yield chunk
            }
          } else if (chunk.type === 'block-end') {
            // block-end 带完整的最终 block.text（在 BlockAssembler 中会覆盖
            // 由 text-delta 累积的 partial.text）。我们必须在它到达前
            // 对完整 block.text 做一次 desanitize，否则还原后的 PII
            // 会被 block-end 里的原始占位符文本覆盖掉。
            const block = chunk.block as { type?: string; text?: string } | undefined
            if (block && typeof block.text === 'string' && block.text.length > 0) {
              try {
                const restored = await sanitizer.desanitize(block.text, sessionId)
                desanitizeRestoredBytes += restored.length
                desanitizeChunkCount++
                yield { ...chunk, block: { ...block, text: restored } }
              } catch (err: any) {
                desanitizeErrorCount++
                yield chunk
              }
            } else {
              yield chunk
            }
          } else {
            yield chunk
          }
        }
        // stream 结束：flush 残留 buffer（含可能未关闭的占位符，原样透传避免丢失内容）
        if (streamingPlaceholderBuffer.value.length > 0) {
          try {
            const tail = await sanitizer.desanitize(streamingPlaceholderBuffer.value, sessionId)
            desanitizeRestoredBytes += tail.length
            desanitizeChunkCount++
            yield { type: 'text-delta', text: tail } as StreamChunkLike
          } catch {
            desanitizeErrorCount++
            yield { type: 'text-delta', text: streamingPlaceholderBuffer.value } as StreamChunkLike
          }
          streamingPlaceholderBuffer.value = ''
        }
      } finally {
        // §7.46.3: step 结束 emit desanitize summary（仅在至少还原过一次
        // 时输出，避免无 PII 的 chat 也刷 spam；errorCount > 0 时也输出
        // 让 operator 立刻看到 desanitize 失败）。replacedCount 是
        // sanitize done 行 outcome=replaced 时的 N，配合 grep 能完整
        // 看到 "sanitize 替换 N → LLM 看到 N → desanitize 还原 N"。
        if (desanitizeChunkCount > 0 || desanitizeErrorCount > 0) {
          try {
            loggerForDesanitize?.info?.(
              `[input-guard] desanitize done sessionId=${sessionId} chunkCount=${desanitizeChunkCount} errorCount=${desanitizeErrorCount} restoredBytes=${desanitizeRestoredBytes}`,
            )
          } catch { /* debug only */ }
        }
        // step 结束，清除状态（避免下一 step 错配）
        // 注：agent-loop 在 step 完成后会再次进入 agent/pre-step，那里会重置状态
      }
    })()

    return wrapped
  }
}

/** 找 messages 数组里最后一条 user 消息的文本。*/
/** 审计日志用 redact：截取前 60 字符。不引入 pii-utils 循环依赖。*/
function redact(text: string): string {
  const slice = text.slice(0, 60)
  return slice.length < text.length ? `${slice}…[+${text.length - slice.length}]` : slice
}

/**
 * 流式反脱敏：把 incoming chunk 追加到 cross-chunk buffer 后，
 * 找出所有"确定无未关闭占位符"的前缀做 desanitize 并返回。
 * 剩下的尾部（可能是 `[PHONE_` 这种未关闭的前缀）保留在 buffer.value
 * 里，等下一个 chunk 进来再判断。
 *
 * 占位符规则：`[A-Z_]+_\d+`（如 `[PHONE_1]`、`[EMAIL_2]`）。所有占位符
 * 都用 `[` 开始、`]` 结束。flush 策略：保留从最后一个未配对的 `[` 起
 * 的所有文本，前面所有文本一定没有未关闭的占位符。
 */
async function flushBuffer(
  sanitizer: SanitizerLike,
  sessionId: string,
  buffer: { value: string },
  incoming: string,
): Promise<string> {
  buffer.value += incoming
  // 找最后一个未配对的 `[`：从尾部开始扫描 `]` 计数，遇 `[` 减 1；
  // 计数降到 -1 的位置就是未配对的 `[`，从此处开始保留。
  let unmatchedOpen = -1
  for (let i = buffer.value.length - 1; i >= 0; i--) {
    const c = buffer.value[i]
    if (c === ']') unmatchedOpen++
    else if (c === '[') {
      if (unmatchedOpen === 0) {
        unmatchedOpen = -1
        continue
      }
      unmatchedOpen--
      if (unmatchedOpen < 0) {
        unmatchedOpen = i
        break
      }
    }
  }
  let safePrefix: string
  let tail: string
  if (unmatchedOpen < 0) {
    safePrefix = buffer.value
    tail = ''
  } else {
    safePrefix = buffer.value.slice(0, unmatchedOpen)
    tail = buffer.value.slice(unmatchedOpen)
  }
  buffer.value = tail
  if (safePrefix.length === 0) return ''
  return await sanitizer.desanitize(safePrefix, sessionId)
}

export async function apply(ctx: Context, config: Config): Promise<() => Promise<void>> {
  // §7.102: the guard switches come from config/edge.json (privacy.*).
  // The cordis patch row no longer reads process.env — the desktop GUI
  // never had those variables.
  const privacy = loadEdgeConfig().privacy
  if (privacy) {
    if (privacy.inputGuardEnabled !== undefined) {
      ;(config as { enableInputGuard: boolean }).enableInputGuard = privacy.inputGuardEnabled
    }
    if (privacy.rejectPolicyEnabled !== undefined) {
      ;(config as { rejectOnPolicyViolation: boolean }).rejectOnPolicyViolation = privacy.rejectPolicyEnabled
    }
    if (privacy.sanitizeDowngradeEnabled !== undefined) {
      ;(config as { downgradeOnSanitizeFailure: boolean }).downgradeOnSanitizeFailure = privacy.sanitizeDowngradeEnabled
    }
  }
  // §7.102: the LOCAL pool's model follows config/edge.json (llm.local.model).
  // The file is the single source of truth — the cordis patch row no longer
  // carries local-LLM config.
  const localModel = localPool().model
  if (localModel && config.localModel !== localModel) {
    ctx.logger?.info?.(`[input-guard] localModel from config/edge.json: ${config.localModel} → ${localModel}`)
    ;(config as { localModel: string }).localModel = localModel
  }
  // §7.35 (2026-09-03): 运行时尊重 DSH_EDGE_CLOUD_KEY_ENV 覆盖。
  // Schema default 在模块加载时求值；如果用户在 apply() 之后才 export env，
  // 这里补一刀。跟 cordis.patch.yml:41 的 !!js 表达式保持一致。
  // §7.175: input-guard 已不再消费 cloudApiKeyEnv（云池不参与路由判定），
  // 这里只是把 schema 默认值同步成运行期的实际值，便于排查时看日志一致。
  if (process.env.DSH_EDGE_CLOUD_KEY_ENV && process.env.DSH_EDGE_CLOUD_KEY_ENV !== config.cloudApiKeyEnv) {
    ctx.logger?.info?.(`[input-guard] cloudApiKeyEnv override: ${config.cloudApiKeyEnv} → ${process.env.DSH_EDGE_CLOUD_KEY_ENV}`)
    ;(config as { cloudApiKeyEnv: string }).cloudApiKeyEnv = process.env.DSH_EDGE_CLOUD_KEY_ENV
  }
  const promptGuard = (ctx as unknown as { promptGuard?: PromptGuardLike }).promptGuard
  const privacyPolicy = (ctx as unknown as { privacyPolicy?: PrivacyPolicyLike }).privacyPolicy
  const intentRouter = (ctx as unknown as { intentRouter?: IntentRouterLike }).intentRouter
  const sanitizer = (ctx as unknown as { sanitizer?: SanitizerLike }).sanitizer
  const auditLog = (ctx as unknown as { auditLog?: AuditLogLike }).auditLog

  // 启动期 fail-fast：这些依赖缺失时，管线不会报错，而是每一条请求都在
  // 运行期抛出 → 被 catch → 静默降级 LOCAL。表面上"能用"，实际上云端
  // 能力整体失效且无人察觉。宁可在启动时就说清楚缺了谁。
  // （enableInputGuard=false 是显式关闭，不在此列。）
  if (config.enableInputGuard) {
    const missing: string[] = []
    if (!privacyPolicy) missing.push('privacyPolicy')
    if (!sanitizer) missing.push('sanitizer')
    if (!intentRouter) missing.push('intentRouter')
    if (!promptGuard) missing.push('promptGuard')
    if (missing.length > 0) {
      const detail = missing.join(', ')
      void auditLog?.log?.({
        level: 'security',
        kind: 'input-guard.dependency.missing',
        source: 'input-guard',
        payload: { missing, hint: 'check plugin boot order in cordis.yml' },
      })
      throw new Error(
        `input-guard: required services unavailable (${detail}) — check plugin boot order, ` +
          'or set DSH_EDGE_INPUT_GUARD=false to disable the guard explicitly',
      )
    }
  }

  const service = new InputGuardServiceImpl(ctx, config, promptGuard, privacyPolicy, intentRouter, sanitizer, auditLog)

  // 类型安全的 ctx.on 访问（cordis 的 ctx.on 在类型上不一定暴露）
  const on = (ctx as unknown as { on?: <T extends (...args: any[]) => any>(event: string, handler: T, opts?: Record<string, unknown>) => () => void }).on

  // 2026-09-03 §7.26 probe: log ctx.on reachability + each hook registration
  // outcome so we can tell from audit log whether hook registration failed
  // (no-ctx-on) vs hook registered but never dispatched (silent filter).
  // NOTE: level='info' because audit-log default minLevel is 'info' and 'debug'
  // entries are silently dropped at audit-log.ts:163.
  void auditLog?.log?.({
    level: 'info',
    kind: 'input-guard.boot.probe',
    source: 'input-guard',
    payload: {
      hasCtxOn: Boolean(on),
      ctxOnType: typeof on,
    },
  })

  const disposers: Array<() => void> = []

  if (on) {
    // 正向：agent/pre-step。
    //
    // §7.136（2026-10-28，主人裁决）：**去掉 `{ global: true }`**。
    //
    // 宿主的 scope 过滤（@deepseek-ai/dsh-scope lib/index.js#scopeTarget）：
    // agent 事件用 `agentCarrier(agent) = scopeTarget(agent, agent)` 派发，
    // 载体的 filter 规则是「监听器自己的 scope 必须是派发 scope 或其祖先」
    // （事件沿 scope 链向上流，不向下）。带 `{ global: true }` 会**绕过**这个
    // 过滤 —— 于是本 hook 在**任何**工作方式下都会触发，标准模式也照样被
    // 护栏改写。
    //
    // 本插件挂在**边缘模式 preset 的 scope** 里；绑定到该 preset 的 Agent 的
    // scope 链包含 preset scope ⇒ hook 生效；绑定到标准模式的 Agent 链上
    // 只有标准 preset 的 scope ⇒ hook 不触发 ⇒ 标准模式是纯宿主。
    //
    // 动态创建的 Agent（http-api 每次 followup 新建）同样经宿主工厂创建，
    // 注册表会把它 bind 到当前 preset ⇒ scope 链一样成立（§7.36 那条
    // 「per-agent 注册收不到动态 agent」的顾虑在 scope 语义下不成立）。
    const d1 = on('agent/pre-step', async (payload: any, next: any) => {
      return service.handlePreStep(payload, next)
    })
    void auditLog?.log?.({
      level: 'info',
      kind: 'input-guard.hook.registered',
      source: 'input-guard',
      payload: { event: 'agent/pre-step', scopedTo: 'agent-preset', disposerReturned: typeof d1 === 'function' },
    })
    if (d1) disposers.push(d1)

    // 反向：llm/stream。
    //
    // 这个事件由 @deepseek-ai/dsh-llm 派发，**不带 scope 载体**（宿主里
    // scopeTarget 只出现在 dsh-agent / dsh-tools / dsh-system-prompt 等），
    // 所以 scope 过滤对它不生效 —— 保留 global 以免改变既有行为。
    // 它本身是「无害的」：handleLlmStream 只在 pre-step 已经 sanitize 过
    // （stepState.sanitized）时才做事；pre-step 现在只在边缘模式触发 ⇒
    // 标准模式下这里恒等于直通。
    //
    // agent-loop 在 buildRequest 时把 sessionId 写到 GenerateOptions，
    // 我们直接从 options.sessionId 读，跨 hook 状态用 Map<string, state>
    // 维护（pre-step 的 session 对象和 llm/stream 的 sessionId 字符串不
    // 是同一个引用，WeakMap<object> 行不通）。
    const d2 = on('llm/stream', (options: any, next: any) => {
      return service.handleLlmStream(options, next)
    }, { global: true })
    void auditLog?.log?.({
      level: 'info',
      kind: 'input-guard.hook.registered',
      source: 'input-guard',
      payload: { event: 'llm/stream', global: true, disposerReturned: typeof d2 === 'function' },
    })
    if (d2) disposers.push(d2)

    // agent/request —— §7.175 起只放行，不改路由。
    //
    // 曾经这里把 provider/model 从 CLOUD 改写到 LOCAL（降级）。现在不行：
    // 宿主 dsh-agent-loop 的 prepareRequest() 会拿 proposedConfig 与
    // `this.model.current()` 比对，provider / model / reasoningEffort 任一
    // 不同就直接抛错 —— 改写不是「降级」，是让整轮失败。
    //
    // 路由恒由宿主的 modelSelection 决定（边缘模式恒为本地模型），「本该
    // 本地却可能上云」的 fail-closed 拦截在 handlePreStep 里做。
    //
    // agent-loop 的 contract：监听器真实签名是 `(payload, next)`，
    // payload 由 dsh-agent 的 fused wrapper 注入了 `agent` 字段
    // （dispatch.js#agentEvents）。next() 返回 chain 默认的 seedConfig。
    // 我们必须先 await next() 拿到 seedConfig 再传下去，不能跳过。
    //
    // §7.136：同 agent/pre-step —— 不带 global，靠 scope 过滤只在边缘模式生效。
    const d3 = on('agent/request', async (payload: any, next: any) => {
      const seedConfig = await next()
      const result = await service.handleAgentRequest(payload ?? {}, seedConfig, async () => seedConfig)
      return result
    })
    void auditLog?.log?.({
      level: 'info',
      kind: 'input-guard.hook.registered',
      source: 'input-guard',
      payload: { event: 'agent/request', scopedTo: 'agent-preset', disposerReturned: typeof d3 === 'function' },
    })
    if (d3) disposers.push(d3)

    // §7.175: §7.106 的「降级后恢复 GUI 模型选择」监听器退役 —— 它恢复的是
    // 「被改写掉的原路由」，而改写本身已经不存在了：路由恒由宿主的
    // modelSelection 决定，GUI 显示的就是用户真正选中的那个。

    // §7.176 / §7.179 / §7.183 的三个监听器（`agent/created` /
    // `agent-preset/selected` / `session/event`）**全部退役**：它们只为
    // 「把会话选型钉/回钉到本地池」而存在。
    //
    // §7.184（主人裁决「选择器完全不动，实际请求改道到本地池」）：边缘模式
    // **不再改写会话选型** ⇒ 宿主模型选择器保持主人选的那个。
    // 「本轮必须留在设备上」改由 `llm/stream` 上的改道保证（dispatchRerouted）。
  }

  return async () => {
    for (const d of disposers) d()
  }
}
