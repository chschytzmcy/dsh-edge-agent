/**
 * input-guard — 端侧隐私安全管线的编排器。
 *
 * 把安全/隐私/脱敏逻辑从 transport 层（http-api）上移到 Agent Loop 的
 * 事件链上，让所有入口（http-api / Web UI / CLI / SDK / 未来的 WebSocket
 * 或 gRPC）自动统一走同一套管线。谁也无法绕过。
 *
 * 正向（agent/pre-step）：攻击检测 → 策略判定 → 意图分类 → 脱敏
 * 反向（llm/stream）：对 text-delta chunk 流式反脱敏
 *
 * 设计详见：docs/input-guard-design.md
 *
 * @module dsh-edge-agent/input-guard
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

// §7.100: 复用 cloud-llm-adapter 的委托探针（同一条解析链，保证
// "input-guard 认为能不能上云" 与 "adapter stream 时实际找不找得到目标"
// 永不打架。adapter 侧 fail → 这里也会提前降级，不会出现"放行后静默空回复"。
import { probeCloudTarget } from './cloud-llm-adapter.js'
import { loadEdgeConfig, localPool } from './edge-config.js'

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
  // §7.101 (2026-10-21): 确认 local-llm 路由真的存在（local-llm 是 opt-in
  // 的：未配置端点时 adapter 不注册任何路由）。
  //
  // 刻意**不**把 modelRouter 放进 inject：
  //   - localAvailable() 已经用 try { ctx.get(...) } catch {} 做
  //     optional 访问 —— 拿不到就保持旧行为（legacy-no-router），不回归。
  //   - inject 是 cordis 的**硬依赖**：声明它 = cordis 必须等 model-router
  //     装载完才起 input-guard，还会把 model-router 拉进 bundle-minimal 的
  //     依赖闭包（那里根本没有 local-llm / cloud-llm，model-router 只是空
  //     catalog，查它没有意义）。
  //   - 同样刻意不 inject llm：那会让 cloudAvailable() 的 delegate 探针
  //     首次真正生效，改变云侧判定语义——不在本次修复范围内。
  //
  // NB: 不要在本注释里用单引号包 service 名 —— bundle-minimal 的 inject
  // 闭包检查用正则扫 inject 数组的原文，注释里的引号名会被误当成依赖。
] as const

export interface Config {
  /** 总开关。false 时所有 hook 都直接 pass-through（debug / 紧急回退用）。*/
  enableInputGuard: boolean
  /** LOCAL 路径是否也走脱敏（默认 false：LOCAL LLM 看到原文，不上云无需脱敏）。*/
  sanitizeLocalTraffic: boolean
  /** 攻击检测 / privacy-policy REJECT → 阻断 step（user 行为不端）。
   *  false = 仅审计 + 放行（fail-open on policy；不推荐）。*/
  rejectOnPolicyViolation: boolean
  /** Sanitize 失败 → 降级 LOCAL 路由（系统故障而非 user 错）。
   *  通过 agent/request hook 改写 provider/model，原始 PII 留在本地。
   *  false = REJECT step（user 看到空 result）。
   *  默认 true — 隐私优先 + 服务可用。*/
  downgradeOnSanitizeFailure: boolean
  /** 降级目标 provider / model。必须与本地 LLM adapter 注册名一致。*/
  localProvider: string
  localModel: string
  /** 2026-09-03 §7.35: Cloud adapter 读 key 的 env slot 名。
   *  与 cloud-llm-adapter.Config.apiKeyEnv 默认一致（'DEEPSEEK_API_KEY'），
   *  也尊重 cordis.patch.yml:41 的 DSH_EDGE_CLOUD_KEY_ENV 覆盖。
   *  当 category=CLOUD|SANITIZED 但该 env slot 为空时，input-guard 不会
   *  走 sanitize（避免 sanitize 完发现根本送不出去、浪费算力），而是直接
   *  标记 downgraded=true 让 handleAgentRequest 把路由改写到 LOCAL——
   *  与"脱敏失败降级 LOCAL"对称：都是"系统配置缺失/故障，绝不上云"。*/
  cloudApiKeyEnv: string
  /** 2026-09-07 §7.43 fix: TUI / dsh-web-app chat 入口不会写 agent._edgeRoute
   *  （只有 http-api 写），所以 handlePreStep 拿不到"如果没降级本来会路由到
   *  哪个 provider"。原来一直写 originalProvider=undefined，turn N+1 的
   *  handleAgentRequest 恢复分支因此不会触发，TUI 上 CLOUD→LOCAL→CLOUD 序列
   *  会被污染（session 20a78b87 turn 4 '查询英国最新的新闻' 实测）。
   *
   *  这里提供 fallback：env 镜像 cordis.patch.yml 的 DSH_EDGE_PROVIDER /
   *  DSH_EDGE_MODEL（与上游 agent-loop 的"current provider"默认一致），
   *  让 handlePreStep 即使没 _edgeRoute 也能写出一个可用的 originalProvider。
   *  优先级：edgeRoute?.provider > defaultCloudProvider（http-api 已知更具体）。*/
  defaultCloudProvider: string
  defaultCloudModel: string
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

/** Minimal sanitizer 接口。*/
interface SanitizerLike {
  sanitize(text: string, context?: { sessionId?: string }): Promise<{
    sanitizedText: string
    sessionId: string
    replacements: Array<{ type: string; original: string; token: string }>
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

declare module '@deepseek-ai/cordis' {
  interface Context {
    inputGuard: InputGuardServiceImpl
  }
}

/** Per-session 的"这一步做了脱敏"状态。WeakMap 让 session 被 dispose 后自动回收。*/
export interface StepSanitizationState {
  /** 当前 turn/step 是否做了脱敏。每次 agent/pre-step 入口重置。*/
  sanitized: boolean
  /** 替换次数（0 = 没替换，无需 desanitize）。*/
  replacements: number
  /** 触发脱敏时的 session id（冗余但便于审计）。*/
  sessionId: string
  /** 时间戳，便于陈旧检查。*/
  timestamp: number
  /** Sanitize 失败后通过 agent/request 降级到 LOCAL 时的标记。*/
  downgraded?: boolean
  /** 原始 CLOUD provider/model（用于审计 + 让 http-api 看到原始路由被替换）。*/
  originalProvider?: string
  originalModel?: string
  originalRealm?: string
  /** Sanitize 失败原因（审计 + 调试）。*/
  downgradeReason?: string
  /** 入口路径（'http-api' = _edgeRoute 已设；'webui' = 未设）。
   *  §7.34 修复：webui 路径也要按 intent=LOCAL 改写。*/
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
 *   - `agent/pre-step`（正向）：攻击 → 策略 → 分类 → 脱敏（含降级标记）
 *   - `agent/request`（路由改写）：sanitize 失败时把 CLOUD 改写为 LOCAL
 *   - `llm/stream`（反向）：对 text-delta chunk 流式反脱敏
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

  /** §7.35 (2026-09-03): 检查 cloud LLM adapter 的 API key 是否就位。
   *  缺失时不抛异常，而是让 handlePreStep 把 category=CLOUD|SANITIZED
   *  降级到 LOCAL——与"sanitize 失败降级 LOCAL"对称（系统侧故障/配置缺失
   *  永远不应让 user 的 PII 上云）。
   *  返回 false 表示"就算想上云也上不了"，调用方应降级到 LOCAL。*/
  private hasCloudCredentials(): boolean {
    const slot = this.config.cloudApiKeyEnv
    if (typeof slot !== 'string' || slot.length === 0) return false
    // §7.102: the credential may live in config/edge.json (secrets.*) rather
    // than in process.env — the desktop GUI has no .env chain. The slot name
    // is matched against the secrets map first, then the env slot.
    const fromConfig = (() => {
      try {
        const secrets = loadEdgeConfig(true).secrets as Record<string, unknown> | undefined
        const v = secrets?.[slot]
        return typeof v === 'string' ? v : undefined
      } catch { return undefined }
    })()
    if (fromConfig !== undefined && fromConfig.length > 0) return true
    if (typeof process === 'undefined' || !process.env) return false
    const value = process.env[slot]
    // ── §7.35 DEBUG (2026-09-03) ─────────────────────────────────────────
    // Surface runtime state so we can diagnose the false-positive TUI
    // downgrade (process.env had DEEPSEEK_API_KEY 35 chars / credentials
    // yaml also synced, but hasCloudCredentials still returned false).
    // Cheap info log, gated by plugin start (avoid noise on every pre-step).
    if (this.ctx) {
      const dsKeys = Object.keys(process.env).filter((k) => k.includes('DEEPSEEK'))
      const v = typeof value === 'string' ? value : undefined
      // Try reading via ctx.get('credentials') to compare env vs DSH creds store.
      // §7.100 fix: CredentialProvider 没有 .get(name)——§7.35 那次调试因此恒
      // 报 'no-get'。正确表面是 .describe(ref)（返回配置状态，secret 不出口）。
      const credsState = (() => {
        try {
          const creds = this.ctx.get?.('credentials') as { describe?: (k: string) => unknown } | undefined
          const d = creds?.describe?.(slot)
          return d && typeof d === 'object' ? 'described' : 'no-describe'
        } catch {
          return 'no-credentials-service'
        }
      })()
      this.ctx.logger?.info?.(
        `[input-guard] hasCloudCredentials: slot=${slot} envValueLen=${typeof v === 'string' ? v.length : 'undefined'} dsEnvKeys=[${dsKeys.join(',')}] credentialsService=${credsState}`,
      )
    }
    return typeof value === 'string' && value.length > 0
  }

  /**
   * §7.100: "云池现在到底可用吗" —— 取代单一 hasCloudCredentials，覆盖两种模式。
   *
   * 模式判定镜像 cordis.patch.yml cloud-llm-adapter 行的 baseUrl 链
   * (`DSH_EDGE_CLOUD_LLM_BASEURL || DEEPSEEK_BASE_URL || ''`)：
   *   - 非空 → DIRECT：行为与 §7.35 完全一致（env slot 有 key 才可用）。
   *   - 空   → DELEGATE：云池 = 宿主 profile 提供商，用 probeCloudTarget
   *     同一条链探一次（env override > agentDefaultModel selection > live
   *     route）。`DSH_EDGE_CLOUD_DELEGATE=false`（LOCAL-only 部署的显式开关）
   *     → 直接判不可用，恢复 §7.35"降级 LOCAL"语义。
   *   - 老上游（无 listProviders）→ 回退 DIRECT 的 key 检查，行为不回归。
   * 任何一档都不看 secret 内容——delegate 模式的凭据归宿主 adapter。
   */
  private cloudAvailable(): { ok: boolean; mode: 'direct' | 'delegate'; reason: string } {
    const directBaseUrl = (process.env.DSH_EDGE_CLOUD_LLM_BASEURL ?? '').trim().length > 0
      || (process.env.DEEPSEEK_BASE_URL ?? '').trim().length > 0
    if (directBaseUrl) {
      return this.hasCloudCredentials()
        ? { ok: true, mode: 'direct', reason: 'direct-key-present' }
        : { ok: false, mode: 'direct', reason: `cloud-key-missing:${this.config.cloudApiKeyEnv}` }
    }
    // DELEGATE 模式
    if ((process.env.DSH_EDGE_CLOUD_DELEGATE ?? '').trim() === 'false') {
      return { ok: false, mode: 'delegate', reason: 'cloud-delegate-disabled' }
    }
    let llm: unknown
    try {
      llm = this.ctx?.get?.('llm')
    } catch {
      llm = undefined
    }
    const llmAny = llm as {
      listProviders?(): Array<{ id: string }>
      stream?: unknown
      listModels?: unknown
    } | undefined
    if (!llmAny || typeof llmAny.listProviders !== 'function') {
      // 老上游 / fake ctx 没有 listProviders：回退 §7.35 key 检查（不崩、语义旧）。
      return this.hasCloudCredentials()
        ? { ok: true, mode: 'delegate', reason: 'legacy-fallback-key-present' }
        : { ok: false, mode: 'delegate', reason: 'cloud-unavailable:legacy-no-key-and-no-registry' }
    }
    let getAgentDefaultModel: () => any
    try {
      getAgentDefaultModel = () => (this.ctx?.get?.('agentDefaultModel') as any) ?? undefined
    } catch {
      getAgentDefaultModel = () => undefined
    }
    const target = probeCloudTarget(
      { llm: llmAny as any, getAgentDefaultModel },
      {
        providers: ['cloud-llm'],
        delegateProvider: process.env.DSH_EDGE_CLOUD_DELEGATE_PROVIDER ?? '',
        delegateModel: process.env.DSH_EDGE_CLOUD_DELEGATE_MODEL ?? '',
        delegateEnabled: true,
      },
    )
    return target
      ? { ok: true, mode: 'delegate', reason: `delegate-target:${target.provider}:${target.source}` }
      : { ok: false, mode: 'delegate', reason: 'cloud-unavailable:no-host-route-selected-or-live' }
  }

  /**
   * §7.101 (2026-10-21): "本地路由现在到底可用吗" —— local-llm 是 opt-in 的：
   * 未设置 DSH_EDGE_LOCAL_LLM_BASEURL 时 local-llm-adapter 不注册任何路由
   * （见 local-llm-adapter.apply）。intent=LOCAL 按隐私裁决必须走本地模型，
   * 所以在改写 provider 之前必须确认目标路由真的存在。
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
    this.stepState.set(sessionId, state)
  }

  /** Seed/override the session's last routed category. Tests drive the
   *  LOCAL-credential exemption with it; http-api could pre-seed a known
   *  route the same way. */
  setTurnCategory(sessionId: string, category: string): void {
    this.turnCategory.set(sessionId, category)
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

    /** 从一个消息 content 数组里抽所有 tool-result 的 id（dsh 字段名：toolCallId） */
    const collectResultIds = (content: unknown): Set<string> => {
      const ids = new Set<string>()
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
      const c = (m as { content?: unknown }).content
      for (const id of collectResultIds(c)) respondedAll.add(id)
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
        for (const id of collectResultIds((pass0[k] as { content?: unknown }).content)) {
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
   * §7.43 (2026-09-07): 解析"原始 provider/model/realm"，作为 stepState.originalProvider
   *  的值写入，供 turn N+1 handleAgentRequest 的 recovery 分支使用。
   *
   *  优先级：http-api 写入的 _edgeRoute（更具体，知道是哪个 cloud 模型）
   *          > TUI/webui 默认 fallback（mirror cordis.patch.yml 的 DSH_EDGE_PROVIDER）
   *
   *  没有 fallback 时，TUI 上的 CLOUD→LOCAL→CLOUD 序列会被污染：
   *    turn N  (LOCAL)   → handlePreStep 写 originalProvider=undefined
   *    turn N+1 (CLOUD)  → handleAgentRequest 看到 originalProvider=undefined，跳过恢复
   *                      → return seedConfig（已被 agent-loop 锁成 local）
   *                      → dispatch local-llm ❌
   *  用 fallback 后 turn N 写 originalProvider='cloud-llm'，
   *  turn N+1 恢复分支能正确识别并强制 restore 回 cloud-llm。
   *
   *  返回 source 字段用于审计 forensics —— 'edge-route' 表示 http-api 设过，
   *  'default-cloud-fallback' 表示我们用 config 默认值兜底（用户没明示偏好）。*/
  private resolveOriginalRoute(edgeRoute: AgentEdgeRoute | undefined): {
    provider: string | undefined
    model: string | undefined
    realm: AgentEdgeRoute['realm'] | undefined
    source: 'edge-route' | 'default-cloud-fallback'
  } {
    if (edgeRoute && typeof edgeRoute.provider === 'string' && typeof edgeRoute.model === 'string') {
      return { provider: edgeRoute.provider, model: edgeRoute.model, realm: edgeRoute.realm, source: 'edge-route' }
    }
    return {
      provider: this.config.defaultCloudProvider,
      model: this.config.defaultCloudModel,
      realm: undefined, // 没有 _edgeRoute 时无从知道"原 realm 是什么"；CLOUD 是合理推断但不强写
      source: 'default-cloud-fallback',
    }
  }

  /** 正向 hook：agent/pre-step handler。暴露给测试。*/
  async handlePreStep(
    payload: {
      agent: { session: object & { id?: string }; id?: string; _edgeRoute?: AgentEdgeRoute } & Record<string, unknown>
      messages: ReadonlyArray<Record<string, unknown>>
      step: number
      signal?: AbortSignal
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
    // 注意：next() 后 decision.messages 可能包含 dsh-agent-instructions 注入的
    // 运行上下文（user-role），会"覆盖"在真实用户消息之上。我们要处理的
    // 是原始 payload.messages 里的最后一条 user 消息。
    const originalLastUser = findLastUserText(payload.messages)
    if (!originalLastUser) return decision

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
    let category: 'LOCAL' | 'CLOUD' | 'SANITIZED' | 'REJECT' = 'CLOUD'
    let edgeRouteUsed = false
    let intentConfidence = 0
    let intentRationale: string | undefined
    let policyClassified = false
    let targetRealm: 'LOCAL' | 'CLOUD' = 'CLOUD'
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
        category = edgeRoute.category === 'REJECT' ? 'CLOUD' : edgeRoute.category
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
          // 分类失败用默认 CLOUD（fail-open）
        }
      }
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
    targetRealm = category === 'LOCAL' ? 'LOCAL' : (category === 'SANITIZED' ? 'LOCAL' : 'CLOUD')
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
    this.turnCategory.set(sessionId, category)

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
    // session 也能被 realm-skill-bridge 识别。REJECT 不注册（后续 turn 不跑）。
    // 失败/缺失时静默 no-op（realmSkillBridge 是可选依赖）。
    if (category !== 'REJECT') {
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
    }

    // §7.35 (2026-09-03): Cloud API key 缺失 → 降级 LOCAL，绝不抛 MISSING_CREDENTIAL。
    // 场景：TUI profile 没 source repo .env.sh → DEEPSEEK_API_KEY 空。
    // user 走 dsh-tui chat 触发意图分类（intent-router 不读 _edgeRoute，因为
    // dsh-tui 跟 dsh-web-app/dsh-web-ui 同源、不挂 _edgeRoute），如果分到 CLOUD
    // （含敏感问题 / 跨域查询等），cloud-llm-adapter 会在 stream 阶段抛
    // MISSING_CREDENTIAL → user 看到 error，体验断裂。
    //
    // 与"脱敏失败降级 LOCAL"对称：都属于"系统侧故障 / 配置缺失"，绝不让 user
    // 的 PII 上云（即便没 PII，强制上云也会失败）。这里把"key 缺失"视为
    // 与"sanitize 失败"等价的降级触发，category=CLOUD|SANITIZED 都走 LOCAL。
    //
    // 关键：早于 sanitize 执行——避免 sanitize 跑完一遍才发现根本送不出去，
    // 既浪费算力又让 user 看到延迟。降级后 messages 不动（LOCAL LLM 不上云，
    // 不需要脱敏），由 handleAgentRequest 改写 route。
    const cloudAvail = (category === 'CLOUD' || category === 'SANITIZED')
      ? this.cloudAvailable()
      : null
    if ((category === 'CLOUD' || category === 'SANITIZED') && cloudAvail && !cloudAvail.ok) {
      const hasRawEdgeRoute = typeof (payload.agent as { _edgeRoute?: unknown })?._edgeRoute !== 'undefined'
      const routeSource: 'http-api' | 'webui' = hasRawEdgeRoute ? 'http-api' : 'webui'
      const original = this.resolveOriginalRoute(edgeRoute) // §7.43: 用 fallback 让 TUI 也能写 originalProvider
      // §7.100: direct 模式保留原 event kind（历史 dashboard/grep 不破）；
      // delegate 模式用新 kind + mode/reason 字段，两步 grep 可定位。
      this.audit('security', cloudAvail.mode === 'direct' ? 'input-guard.cloud-key.missing' : 'input-guard.cloud.unavailable', {
        sessionId, category, mode: cloudAvail.mode, reason: cloudAvail.reason,
        envSlot: this.config.cloudApiKeyEnv,
        originalProvider: original.provider,
        originalModel: original.model,
        originalRealm: original.realm,
        originalProviderSource: original.source, // §7.43 forensics
        routeSource,
        targetProvider: this.config.localProvider,
        targetModel: this.config.localModel,
      })
      this.stepState.set(sessionId, {
        sanitized: false, replacements: 0, sessionId, timestamp: Date.now(),
        downgraded: true,
        downgradeReason: cloudAvail.reason,
        originalProvider: original.provider,
        originalModel: original.model,
        originalRealm: original.realm,
        routeSource,
      })
      return decision
    }

    // 4. 脱敏（仅 CLOUD 路径，或显式开启 LOCAL）
    const shouldSanitize = category === 'CLOUD' || category === 'SANITIZED' || this.config.sanitizeLocalTraffic
    if (!shouldSanitize || !this.sanitizer) {
      // 2026-09-03 §7.26 + 2026-09-03 §7.34 fix. intent=category=LOCAL means
      // the user's request is fully resolvable on-device (file/local/system
      // query) — PII must not egress. Two entry points feed into pre-step:
      //   - http-api: sets _edgeRoute (provider='cloud-llm', category='LOCAL').
      //     §7.26 covered this; wantsDowngradeToLocal=true → rewrite.
      //   - webui (dsh-web-app chat): does NOT set _edgeRoute; default provider
      //     is cloud-llm from cordis.patch.yml. Without §7.34 fix,
      //     intent=LOCAL only changes audit events but the actual LLM call still
      //     goes to cloud, leaking file content (observed: 9 cloud calls, 6841
      //     → 7419 promptLen for "查询密盒里有哪些文件", 2026-09-03).
      //
      // §7.34 fix: drop the `edgeRoute.provider.startsWith('cloud-')` guard.
      // intent=LOCAL is the authoritative verdict — when it fires, force LOCAL
      // regardless of how the request entered (http-api cached route / webui
      // direct chat / any future transport). If current provider is already
      // local, the rewrite in handleAgentRequest is idempotent (same provider/model).
      //
      // routeSource='http-api' when _edgeRoute was set on agent (even malformed;
      // raw presence = http-api wrote it). 'webui' when _edgeRoute absent.
      const wantsDowngradeToLocal = category === 'LOCAL'
      const hasRawEdgeRoute = typeof (payload.agent as { _edgeRoute?: unknown })?._edgeRoute !== 'undefined'
      const routeSource: 'http-api' | 'webui' = hasRawEdgeRoute ? 'http-api' : 'webui'
      const original = this.resolveOriginalRoute(edgeRoute) // §7.43: TUI 不设 _edgeRoute 时用 fallback
      this.stepState.set(sessionId, {
        sanitized: false, replacements: 0, sessionId, timestamp: Date.now(),
        downgraded: wantsDowngradeToLocal,
        downgradeReason: wantsDowngradeToLocal ? 'intent-local' : undefined,
        originalProvider: original.provider,
        originalModel: original.model,
        originalRealm: original.realm,
        routeSource,
      })
      if (wantsDowngradeToLocal) {
        this.audit('security', 'input-guard.intent.downgraded', {
          sessionId, category, reason: 'intent-local', routeSource,
          originalProvider: original.provider,
          originalModel: original.model,
          originalRealm: original.realm,
          originalProviderSource: original.source, // §7.43 forensics
          targetProvider: this.config.localProvider,
          targetModel: this.config.localModel,
        })
      }
      return decision
    }

    // §7.46.2 (2026-09-12): sanitize call ops log — 让"调了 sanitizer /
    // 替换了几个 PII / 多久 / 失败原因"在 ops log 里可见。start 在
    // `sanitizer.sanitize()` 之前 emit；done 在 success 分支 emit（含
    // replacementCount 和是否替换文本）；wireError 字段跟
    // cloud/local-llm-adapter §7.46.1 done 行对齐。失败/降级由外层
    // catch（handlePreStep 原结构）继续处理 sanitize-failed audit + 路由降级。
    const sanitizeStart = Date.now()
    try {
      this.ctx?.logger?.info?.(
        `[input-guard] sanitize start sessionId=${sessionId} category=${category} inputLen=${originalLastUser.text.length}`,
      )
    } catch { /* debug only */ }
    try {
      const result = await this.sanitizer.sanitize(originalLastUser.text, { sessionId })
      const replacements = result.replacements.length
      const original = this.resolveOriginalRoute(edgeRoute) // §7.43: TUI 不设 _edgeRoute 时用 fallback
      const sanitizeDurationMs = Date.now() - sanitizeStart
      if (replacements > 0) {
        // 替换 decision.messages 里 originalLastUser.index 位置的消息（不是最后一条 user，
        // 因为 dsh-agent-instructions 可能在末尾追加了 user-role 注入）。
        const newMessages = replaceAtUserIndex(decision.messages ?? payload.messages, originalLastUser.index, result.sanitizedText)
        this.stepState.set(sessionId, {
          sanitized: true, replacements, sessionId, timestamp: Date.now(),
          originalProvider: original.provider,
          originalModel: original.model,
          originalRealm: original.realm,
        })
        this.audit('info', 'input-guard.sanitized', {
          sessionId, replacementCount: replacements, category,
        })
        // §7.46.2: sanitize done 行 (success, replaced) — 跟 start 行配对
        try {
          this.ctx?.logger?.info?.(
            `[input-guard] sanitize done sessionId=${sessionId} category=${category} durationMs=${sanitizeDurationMs} replacementCount=${replacements} outcome=replaced`,
          )
        } catch { /* debug only */ }
        return { ...decision, messages: newMessages }
      }
      // 没替换：状态标记 sanitized=false
      this.stepState.set(sessionId, {
        sanitized: false, replacements: 0, sessionId, timestamp: Date.now(),
        originalProvider: original.provider,
        originalModel: original.model,
        originalRealm: original.realm,
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
      //   - downgradeOnSanitizeFailure=true (默认)：通过 agent/request 钩子
      //     把 provider/model 改写到 LOCAL，让原始 PII 留在本地。step 不被
      //     阻断，user 体验"路由悄悄切到本地"，可用性 + 隐私兼顾。
      //   - downgradeOnSanitizeFailure=false：REJECT step，user 看到空
      //     result（保守降级，配置可选）。
      const reason = err?.message ?? String(err)
      const sanitizeDurationMs = Date.now() - sanitizeStart
      // §7.46.2: sanitize failed 行 — 让 operator 在 ops log 看到失败原因 +
      // duration，外层 catch 仍按原逻辑处理 audit + 路由降级。
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

      // 标记降级：让后续 agent/request 钩子把 route 改写到 LOCAL。
      // messages 不修改（保留原文，LOCAL LLM 不上云无需脱敏）。
      const original = this.resolveOriginalRoute(edgeRoute) // §7.43: TUI 不设 _edgeRoute 时用 fallback
      this.stepState.set(sessionId, {
        sanitized: false, replacements: 0, sessionId, timestamp: Date.now(),
        downgraded: true, downgradeReason: reason,
        originalProvider: original.provider,
        originalModel: original.model,
        originalRealm: original.realm,
      })
      this.audit('security', 'input-guard.sanitize.downgraded', {
        sessionId, error: reason, category,
        originalProvider: original.provider,
        originalModel: original.model,
        originalRealm: original.realm,
        originalProviderSource: original.source, // §7.43 forensics
        targetProvider: this.config.localProvider,
        targetModel: this.config.localModel,
      })
      return decision
    }
  }

  /** 路由改写 hook：agent/request handler。
   *  在 agent-loop 的 buildRequest 阶段被调用，允许改写 provider/model。
   *  当 handlePreStep 因 sanitize 失败标记了 stepState.downgraded，
   *  本钩子把请求改写到本地 LLM，原始 PII 不会离开设备。
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
    if (!this.config.enableInputGuard) return seedConfig

    // sessionId 来自 fused wrapper 注入的 payload.agent.session.id
    const sessionId = payload?.agent?.session?.id
    if (!sessionId) return seedConfig

    const state = this.stepState.get(sessionId)
    if (state?.downgraded) {
      // §7.101 (2026-10-21): 改写前先确认本地路由存在。
      //
      // 背景：local-llm 是 opt-in 的（未设 DSH_EDGE_LOCAL_LLM_BASEURL 时
      // adapter 不注册路由）。intent=LOCAL 必须走本地模型（隐私裁决），
      // 但目标路由不存在时，把 provider 改写成 local-llm 只会得到一条
      // 必然失败的请求——实测是打到本机 8080 上一个无关的鉴权 daemon，
      // 报 HTTP 401 "Missing bearer token"，完全无法指导用户。
      //
      // 这里 fail-closed：本地路由缺失 → 明确报错并阻止上云。绝不放行到
      // 云端（那会把本地数据/PII 送出设备），也不伪造一条会 401 的路由。
      const local = this.localAvailable()
      if (!local.ok) {
        this.audit('security', 'input-guard.local.route-missing', {
          sessionId,
          reason: local.reason,
          targetProvider: this.config.localProvider,
          targetModel: this.config.localModel,
          downgradeReason: state.downgradeReason,
          originalProvider: state.originalProvider,
          originalModel: state.originalModel,
        })
        try {
          this.ctx?.logger?.error?.(
            `[input-guard] local route unavailable sessionId=${sessionId} provider=${this.config.localProvider} reason=${local.reason} — refusing to fall back to the cloud route`,
          )
        } catch { /* debug only */ }
        throw new Error(
          `input-guard: 本轮 intent 判定为 LOCAL，按隐私裁决必须使用本地模型，`
          + `但本地路由 "${this.config.localProvider}" 不可用（${local.reason}）。`
          + `为避免本地数据/PII 出境，已阻止本轮上云。`
          + `请配置本地 LLM 端点（设置 DSH_EDGE_LOCAL_LLM_BASEURL；若端点需要鉴权，`
          + `再用 DSH_EDGE_LOCAL_LLM_KEY_ENV 指定存放密钥的环境变量名）后重试。`,
        )
      }
      // 改写 route 到 LOCAL。maxTokens 等其他字段保留，但 §7.106 (2026-10-22)
      // 起剥离 reasoningEffort：ollama / OpenAI-compatible 本地模型不声明支持
      // 思考档位，把云端选择携带的 `high` 原样带进 local-llm，prepareCall 会
      // 直接抛 `provider "local-llm" model "qwen3.8:27b" does not support
      // reasoning effort "high"`，整轮失败（桌面实测）。LOCAL 语义本就是
      // "用本地能力答"，档位随本地服务端默认，无需继承云端意图。
      const { reasoningEffort: _droppedEffort, ...seedRest } = seedConfig
      const downgraded: AgentRequestConfig = {
        ...seedRest,
        provider: this.config.localProvider,
        model: this.config.localModel,
      }
      // §7.46.3 (2026-09-12): 路由改写在 ops log 留一行 — 让 operator
      // grep sessionId 就能看到 "原本 cloud-llm / cloud-deepseek
      // → 实际走 local-llm / qwen3-4b-instruct-2507 + reason"，不
      // 用翻 audit JSONL。配合 preflight intent 行的 routeSource +
      // category 形成完整 trace。
      try {
        this.ctx?.logger?.info?.(
          `[input-guard] route override sessionId=${sessionId} fromProvider=${seedConfig.provider} fromModel=${seedConfig.model} toProvider=${downgraded.provider} toModel=${downgraded.model} reason=${state.downgradeReason ?? 'unknown'}`,
        )
      } catch { /* debug only */ }
      this.audit('info', 'input-guard.route.overridden', {
        sessionId,
        from: { provider: seedConfig.provider, model: seedConfig.model },
        to: { provider: downgraded.provider, model: downgraded.model },
        reason: state.downgradeReason,
      })
      // §7.106 (2026-10-22): pre-step 写的 originalProvider 可能是回退占位
      // （'cloud-llm/deepseek-chat'，originalProviderSource=default-cloud-fallback）
      // ——webui 路径 pre-step 读不到 seed 的真实路由。seedConfig 才是用户此刻
      // 真实的选择，turn-end 的 selection-restore 只允许回写这个值：占位符在
      // 方案 A 后指向隐藏路由，restore 必失败（实测 restore-failed
      // "Select an available model"）。seed 本来就是 local 时不覆盖（无 restore 意义）。
      if (
        typeof seedConfig.provider === 'string'
        && seedConfig.provider.length > 0
        && seedConfig.provider !== this.config.localProvider
      ) {
        state.originalProvider = seedConfig.provider
        if (typeof seedConfig.model === 'string' && seedConfig.model.length > 0) {
          state.originalModel = seedConfig.model
        }
      }
      return downgraded
    }

    // §7.43 (2026-09-07): Recovery from a previous turn's downgrade.
    //
    // Background: handleAgentRequest is an `agent/request` waterfall listener.
    // The upstream agent-loop builds seedConfig by reading the agent's
    // "current provider" — which it persists across turns. When we returned
    // a downgraded config in a prior turn (e.g. turn N intent=LOCAL), that
    // downgraded provider stuck on the agent. On turn N+1 (intent=CLOUD),
    // handlePreStep correctly writes state.downgraded=false, but seedConfig
    // arriving here still has provider=localProvider. handleAgentRequest
    // would then return seedConfig unchanged → agent-loop dispatches the
    // CLOUD-classified query to the LOCAL LLM, where web_search is in a
    // different realm (and qwen3-4b often hallucinates empty replies when
    // asked for something it doesn't know how to fetch).
    //
    // Observed: session 20a78b87 turn 4 ('查询英国最新的新闻') was classified
    // CLOUD by intent-router (confidence 0.99), input-guard.session-realm
    // correctly registered CLOUD, but actual LLM call was local-llm
    // (audit shows `local-llm-adapter llm.local.start messageCount=26`,
    // no `route.overridden` event — confirming handleAgentRequest was a
    // pass-through with seedConfig.provider already stuck on local).
    //
    // Fix: when not downgrading THIS turn, AND we have a saved
    // originalProvider from a prior downgrade AND current seedConfig is
    // pointing at the local provider, restore to originalProvider. This is
    // the symmetric inverse of the override above.
    if (
      state?.originalProvider &&
      typeof state.originalProvider === 'string' &&
      state.originalProvider !== this.config.localProvider &&
      seedConfig.provider === this.config.localProvider
    ) {
      const restored: AgentRequestConfig = {
        ...seedConfig,
        provider: state.originalProvider,
        model: state.originalModel ?? seedConfig.model,
      }
      // §7.46.3: 路由恢复（前一 turn downgrade 后这一 turn 回到原始 cloud）
      try {
        this.ctx?.logger?.info?.(
          `[input-guard] route restore sessionId=${sessionId} fromProvider=${seedConfig.provider} fromModel=${seedConfig.model} toProvider=${restored.provider} toModel=${restored.model} reason=recovery-from-previous-downgrade`,
        )
      } catch { /* debug only */ }
      this.audit('info', 'input-guard.route.restored', {
        sessionId,
        from: { provider: seedConfig.provider, model: seedConfig.model },
        to: { provider: restored.provider, model: restored.model },
        reason: 'recovery-from-previous-downgrade',
        originalTurn: state.timestamp,
      })
      // Clear originalProvider after recovery so we don't keep restoring
      // even when the agent-loop itself has moved past the contamination.
      // Next downgrade will re-set it via handlePreStep.
      this.stepState.set(sessionId, {
        ...state,
        originalProvider: undefined,
        originalModel: undefined,
      })
      return restored
    }

    return seedConfig
  }

  /** 反向 hook：llm/stream handler。暴露给测试。*/
  handleLlmStream(
    options: { signal?: AbortSignal; sessionId?: string },
    next: () => AsyncIterable<StreamChunkLike>,
  ): AsyncIterable<StreamChunkLike> {
    const requestSessionId = options?.sessionId
    const state = requestSessionId ? this.stepState.get(requestSessionId) : undefined
    const stream = next()
    if (!this.config.enableInputGuard) return stream
    if (!requestSessionId || !this.sanitizer) return stream

    if (!state || !state.sanitized || state.replacements === 0) return stream

    const sanitizer = this.sanitizer
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
    let desanitizeCallCount = 0
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
function findLastUserText(
  messages: ReadonlyArray<Record<string, unknown>>,
): { text: string; index: number } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role !== 'user') continue
    const content = m.content
    if (typeof content === 'string' && content.length > 0) {
      return { text: content, index: i }
    }
    if (Array.isArray(content)) {
      const texts: string[] = []
      for (const block of content) {
        if (block && typeof block === 'object' && (block as any).type === 'text' && typeof (block as any).text === 'string') {
          texts.push((block as any).text)
        }
      }
      const joined = texts.join('')
      if (joined.length > 0) return { text: joined, index: i }
    }
  }
  return undefined
}

/** 替换 messages 数组里指定 index 的 user 消息文本（不可变，返回新数组）。*/
function replaceLastUserText(
  messages: ReadonlyArray<Record<string, unknown>>,
  newText: string,
): Array<Record<string, unknown>> {
  const found = findLastUserText(messages)
  if (!found) return [...messages]
  return replaceAtUserIndex(messages, found.index, newText)
}

/** 替换 messages 数组里指定 index 位置的消息的 user 文本（不可变，返回新数组）。
 *  用于 dsh-agent-instructions 在 decision.messages 末尾追加注入内容后，
 *  我们仍想替换"原始"用户消息（index 从 payload.messages 继承）的场景。*/
function replaceAtUserIndex(
  messages: ReadonlyArray<Record<string, unknown>>,
  index: number,
  newText: string,
): Array<Record<string, unknown>> {
  if (index < 0 || index >= messages.length) return [...messages]
  const result = [...messages]
  const original = result[index]
  const originalContent = original.content
  if (typeof originalContent === 'string') {
    result[index] = { ...original, content: newText }
  } else if (Array.isArray(originalContent)) {
    // 替换所有 text block 为单个合并的 text block
    const newContent: unknown[] = []
    let replaced = false
    for (const block of originalContent) {
      if (block && typeof block === 'object' && (block as any).type === 'text') {
        if (!replaced) {
          newContent.push({ type: 'text', text: newText })
          replaced = true
        }
        // 后续 text block 丢弃（已合并到 newText）
      } else {
        newContent.push(block)
      }
    }
    if (!replaced) newContent.unshift({ type: 'text', text: newText })
    result[index] = { ...original, content: newContent }
  }
  return result
}

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

/**
 * §7.106: decide what (if anything) to restore as the session's model
 * selection when a turn ends after an input-guard downgrade. The host
 * persists the effective request header as the user's "current model"
 * (session-controller/src/agent.ts: `picked` first, else `requestHeader()`),
 * so a rewrite to local-llm leaves the GUI stale — shown as `local-llm`
 * while the route was visible, blank after Option A hid it. A restore fires
 * only for a genuinely downgraded turn whose original route was a foreign
 * (non-local) provider/model pair; missing pieces or an already-local
 * original must not touch the selection.
 */
export function selectionRestoreTarget(
  state: StepSanitizationState | undefined,
  localProvider: string,
): { provider: string; model: string } | undefined {
  if (state?.downgraded !== true) return undefined
  const provider = state.originalProvider
  const model = state.originalModel
  if (typeof provider !== 'string' || provider.length === 0 || provider === localProvider) return undefined
  // §7.106 (2026-10-23): 'cloud-llm' is EDGE's own (now catalog-hidden) pool
  // route — both the pre-step default-cloud-fallback placeholder and a
  // policy route-applied rewrite can land there. Restoring it always fails
  // the catalog check ("Select an available model" — observed 09:49) and it
  // is never a genuine user selection, so skip instead of writing garbage.
  if (provider === 'cloud-llm') return undefined
  if (typeof model !== 'string' || model.length === 0) return undefined
  return { provider, model }
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
  // §7.102: the downgrade target model follows the LOCAL pool declared in
  // config/edge.json (llm.local.model). The file is the single source of
  // truth — the cordis patch row no longer carries local-LLM config.
  const localModel = localPool().model
  if (localModel && config.localModel !== localModel) {
    ctx.logger?.info?.(`[input-guard] localModel from config/edge.json: ${config.localModel} → ${localModel}`)
    ;(config as { localModel: string }).localModel = localModel
  }
  // §7.35 (2026-09-03): 运行时尊重 DSH_EDGE_CLOUD_KEY_ENV 覆盖。
  // Schema default 在模块加载时求值；如果用户在 apply() 之后才 export env，
  // 这里补一刀。跟 cordis.patch.yml:41 的 !!js 表达式保持一致。
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
    // 正向：agent/pre-step（全局，让它在所有 agent 上生效）
    const d1 = on('agent/pre-step', async (payload: any, next: any) => {
      return service.handlePreStep(payload, next)
    }, { global: true })
    void auditLog?.log?.({
      level: 'info',
      kind: 'input-guard.hook.registered',
      source: 'input-guard',
      payload: { event: 'agent/pre-step', global: true, disposerReturned: typeof d1 === 'function' },
    })
    if (d1) disposers.push(d1)

    // 反向：llm/stream（全局）
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

    // 路由改写：agent/request（全局）。
    // 当 handlePreStep 因 sanitize 失败标记了 stepState.downgraded，
    // 这里把 provider/model 从 CLOUD 改写到 LOCAL，原始 PII 不离开设备。
    // agent-loop 的 contract：监听器真实签名是 `(payload, next)`，
    // payload 由 dsh-agent 的 fused wrapper 注入了 `agent` 字段
    // （dispatch.js#agentEvents）。next() 返回 chain 默认的 seedConfig。
    // 我们必须先 await next() 拿到 seedConfig 再决定是否改写，不能跳过。
    const d3 = on('agent/request', async (payload: any, next: any) => {
      const seedConfig = await next()
      const result = await service.handleAgentRequest(payload ?? {}, seedConfig, async () => seedConfig)
      return result
    }, { global: true })
    void auditLog?.log?.({
      level: 'info',
      kind: 'input-guard.hook.registered',
      source: 'input-guard',
      payload: { event: 'agent/request', global: true, disposerReturned: typeof d3 === 'function' },
    })
    if (d3) disposers.push(d3)

    // §7.106 (2026-10-22): after a downgrade turn, restore the SESSION's model
    // selection. The host treats the last committed request header as the
    // user's current model (session-controller/src/agent.ts: `current` reads
    // `picked` first, else `session.requestHeader()`), so every rewrite to
    // local-llm leaves the GUI stale — it used to display `local-llm` (a
    // visible pollution) and, since Option A hid the edge plumbing routes,
    // the same stale seed renders as an empty "请选择模型". On turn/end of a
    // downgraded turn we call sessionController.selectModel with the original
    // user selection recorded in the step state: that installs an explicit
    // `picked` (which outranks the header fallback) and appends the durable
    // `model/selection` event. Execution routing is unaffected — the next
    // turn's pre-step re-decides from scratch.
    //
    // Deferred inject: headless profiles never compose the controller —
    // then the restore simply never fires (no GUI to pollute) and the §7.43
    // request-level restore keeps covering route stickiness.
    let sessionController: { selectModel?: (request: Record<string, unknown>) => Promise<unknown> } | undefined
    ctx.inject(['sessionController'], (raw: any) => {
      sessionController = raw?.sessionController
    })
    const d4 = on('session/event', (session: any, event: any) => {
      try {
        if (event?.type !== 'turn/end') return
        const sid = typeof session?.id === 'string' ? session.id : undefined
        if (sid === undefined) return
        const target = selectionRestoreTarget(service.getStepState(sid), config.localProvider)
        if (target === undefined) return
        const { provider, model } = target
        const select = sessionController?.selectModel
        if (typeof select !== 'function') return
        void Promise.resolve(select.call(sessionController, { sessionId: sid, provider, model }))
          .then(() => {
            void auditLog?.log?.({
              level: 'info',
              kind: 'input-guard.selection.restored',
              source: 'input-guard',
              payload: { sessionId: sid, provider, model },
            })
          })
          .catch((error: unknown) => {
            void auditLog?.log?.({
              level: 'warn',
              kind: 'input-guard.selection.restore-failed',
              source: 'input-guard',
              payload: { sessionId: sid, provider, model, error: String(error) },
            })
          })
      } catch { /* a failing restore must never touch event dispatch */ }
    })
    void auditLog?.log?.({
      level: 'info',
      kind: 'input-guard.hook.registered',
      source: 'input-guard',
      payload: { event: 'session/event(turn/end)', global: false, disposerReturned: typeof d4 === 'function' },
    })
    if (d4) disposers.push(d4)
  }

  return async () => {
    for (const d of disposers) d()
  }
}
