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

export const name = 'input-guard'

export const inject = [
  'promptGuard',
  'privacyPolicy',
  'intentRouter',
  'sanitizer',
  'auditLog',
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
}

export const Config: Schema<Config> = Schema.object({
  enableInputGuard: Schema.boolean().default(true),
  sanitizeLocalTraffic: Schema.boolean().default(false),
  rejectOnPolicyViolation: Schema.boolean().default(true),
  downgradeOnSanitizeFailure: Schema.boolean().default(true),
  localProvider: Schema.string().default('local-qwen3-4b'),
  localModel: Schema.string().default('qwen3-4b-instruct-2507'),
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
interface StepSanitizationState {
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

  /** 读取 agent 上的 edge-route（由 http-api / 其他入口在 followup 前写入）。
   *  避免 input-guard 重复跑 intent-router.classify()（每次 ~0.5-1s）。*/
  private readEdgeRoute(agent: unknown): AgentEdgeRoute | undefined {
    const route = (agent as { _edgeRoute?: AgentEdgeRoute } | null | undefined)?._edgeRoute
    if (!route || typeof route !== 'object') return undefined
    if (typeof route.provider !== 'string' || typeof route.model !== 'string') return undefined
    if (!['LOCAL', 'CLOUD', 'SANITIZED'].includes(route.realm)) return undefined
    return route
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
    if (decision.kind === 'reject') return decision

    const sessionId = payload.agent.session.id ?? 'unknown'
    // 注意：next() 后 decision.messages 可能包含 dsh-agent-instructions 注入的
    // 运行上下文（user-role），会"覆盖"在真实用户消息之上。我们要处理的
    // 是原始 payload.messages 里的最后一条 user 消息。
    const originalLastUser = findLastUserText(payload.messages)
    if (!originalLastUser) return decision

    // 1. 攻击检测 — 最便宜、最先阻断
    if (this.promptGuard) {
      try {
        const attackCheck = await this.promptGuard.checkInput(originalLastUser.text, sessionId)
        if (!attackCheck.safe) {
          this.audit('security', 'input-guard.blocked.attack', {
            sessionId,
            reason: attackCheck.reason,
            riskLevel: attackCheck.riskLevel,
            preview: redact(originalLastUser.text),
          })
          if (this.config.rejectOnPolicyViolation) {
            return { kind: 'reject', reason: attackCheck.reason ?? 'attack-detected' }
          }
          // fail-open on policy: 审计 + 放行（不推荐）
          this.audit('warn', 'input-guard.attack.fail-open', {
            sessionId, reason: attackCheck.reason,
          })
        }
      } catch (err: any) {
        // prompt-guard 失败不阻断（fail-open）— 它是检测层，不是执行层
        this.audit('error', 'input-guard.prompt-guard.error', {
          sessionId, error: err?.message ?? String(err),
        })
      }
    }

    // 2. 策略判定 — privacy-policy REJECT
    if (this.privacyPolicy) {
      try {
        const routing = this.privacyPolicy.matchRouting(originalLastUser.text)
        if (routing?.realm === 'REJECT') {
          this.audit('security', 'input-guard.blocked.policy', {
            sessionId,
            confidence: routing.confidence,
            rationale: routing.rationale,
            preview: redact(originalLastUser.text),
          })
          if (this.config.rejectOnPolicyViolation) {
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
    let category: 'LOCAL' | 'CLOUD' | 'SANITIZED' | 'REJECT' = 'CLOUD'
    let edgeRouteUsed = false
    const edgeRoute = this.readEdgeRoute(payload.agent)
    if (edgeRoute) {
      category = edgeRoute.category === 'REJECT' ? 'CLOUD' : edgeRoute.category
      edgeRouteUsed = true
    } else if (this.intentRouter) {
      try {
        const intent = await this.intentRouter.classify(originalLastUser.text, { sessionId })
        category = intent.category
        if (category === 'REJECT') {
          this.audit('warn', 'input-guard.blocked.intent', {
            sessionId, confidence: intent.confidence, rationale: intent.rationale,
          })
          if (this.config.rejectOnPolicyViolation) {
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
    this.audit('debug', 'input-guard.routed', {
      sessionId, category, edgeRouteUsed,
    })

    // 4. 脱敏（仅 CLOUD 路径，或显式开启 LOCAL）
    const shouldSanitize = category === 'CLOUD' || category === 'SANITIZED' || this.config.sanitizeLocalTraffic
    if (!shouldSanitize || !this.sanitizer) {
      // 不脱敏：记录状态，让 llm/stream 知道不需要 desanitize
      this.stepState.set(sessionId, {
        sanitized: false, replacements: 0, sessionId, timestamp: Date.now(),
        originalProvider: edgeRoute?.provider,
        originalModel: edgeRoute?.model,
        originalRealm: edgeRoute?.realm,
      })
      return decision
    }

    try {
      const result = await this.sanitizer.sanitize(originalLastUser.text, { sessionId })
      const replacements = result.replacements.length
      if (replacements > 0) {
        // 替换 decision.messages 里 originalLastUser.index 位置的消息（不是最后一条 user，
        // 因为 dsh-agent-instructions 可能在末尾追加了 user-role 注入）。
        const newMessages = replaceAtUserIndex(decision.messages ?? payload.messages, originalLastUser.index, result.sanitizedText)
        this.stepState.set(sessionId, {
          sanitized: true, replacements, sessionId, timestamp: Date.now(),
          originalProvider: edgeRoute?.provider,
          originalModel: edgeRoute?.model,
          originalRealm: edgeRoute?.realm,
        })
        this.audit('info', 'input-guard.sanitized', {
          sessionId, replacementCount: replacements, category,
        })
        return { ...decision, messages: newMessages }
      }
      // 没替换：状态标记 sanitized=false
      this.stepState.set(sessionId, {
        sanitized: false, replacements: 0, sessionId, timestamp: Date.now(),
        originalProvider: edgeRoute?.provider,
        originalModel: edgeRoute?.model,
        originalRealm: edgeRoute?.realm,
      })
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
      this.audit('security', 'input-guard.sanitize.failed', {
        sessionId, error: reason, category,
      })

      if (!this.config.downgradeOnSanitizeFailure) {
        return { kind: 'reject', reason: 'sanitizer-failed' }
      }

      // 标记降级：让后续 agent/request 钩子把 route 改写到 LOCAL。
      // messages 不修改（保留原文，LOCAL LLM 不上云无需脱敏）。
      this.stepState.set(sessionId, {
        sanitized: false, replacements: 0, sessionId, timestamp: Date.now(),
        downgraded: true, downgradeReason: reason,
        originalProvider: edgeRoute?.provider,
        originalModel: edgeRoute?.model,
        originalRealm: edgeRoute?.realm,
      })
      this.audit('security', 'input-guard.sanitize.downgraded', {
        sessionId, error: reason, category,
        originalProvider: edgeRoute?.provider,
        originalModel: edgeRoute?.model,
        originalRealm: edgeRoute?.realm,
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
   *  seedConfig 是 agent-loop 根据 AgentOptions 算出的默认（http-api
   *  传入的 provider/model）。我们只在 downgraded 状态下覆盖。*/
  async handleAgentRequest(
    payload: { turn?: number; step?: number; signal?: AbortSignal; sessionId?: string },
    seedConfig: AgentRequestConfig,
    next: () => Promise<AgentRequestConfig>,
  ): Promise<AgentRequestConfig> {
    if (!this.config.enableInputGuard) return seedConfig

    // sessionId 来自上游调用方（agent-loop 在 buildRequest 里通过 session.id 传入）
    const sessionId = payload?.sessionId
    if (!sessionId) return seedConfig

    const state = this.stepState.get(sessionId)
    if (!state?.downgraded) return seedConfig

    // 改写 route 到 LOCAL。保留 reasoningEffort / maxTokens 等其他字段。
    const downgraded: AgentRequestConfig = {
      ...seedConfig,
      provider: this.config.localProvider,
      model: this.config.localModel,
    }
    this.audit('info', 'input-guard.route.overridden', {
      sessionId,
      from: { provider: seedConfig.provider, model: seedConfig.model },
      to: { provider: downgraded.provider, model: downgraded.model },
      reason: state.downgradeReason,
    })
    return downgraded
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
              if (restored.length > 0) yield { ...chunk, text: restored }
            } catch (err: any) {
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
                yield { ...chunk, block: { ...block, text: restored } }
              } catch (err: any) {
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
            yield { type: 'text-delta', text: tail } as StreamChunkLike
          } catch {
            yield { type: 'text-delta', text: streamingPlaceholderBuffer.value } as StreamChunkLike
          }
          streamingPlaceholderBuffer.value = ''
        }
      } finally {
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

export async function apply(ctx: Context, config: Config): Promise<() => Promise<void>> {
  const promptGuard = (ctx as unknown as { promptGuard?: PromptGuardLike }).promptGuard
  const privacyPolicy = (ctx as unknown as { privacyPolicy?: PrivacyPolicyLike }).privacyPolicy
  const intentRouter = (ctx as unknown as { intentRouter?: IntentRouterLike }).intentRouter
  const sanitizer = (ctx as unknown as { sanitizer?: SanitizerLike }).sanitizer
  const auditLog = (ctx as unknown as { auditLog?: AuditLogLike }).auditLog

  const service = new InputGuardServiceImpl(ctx, config, promptGuard, privacyPolicy, intentRouter, sanitizer, auditLog)

  // 类型安全的 ctx.on 访问（cordis 的 ctx.on 在类型上不一定暴露）
  const on = (ctx as unknown as { on?: <T extends (...args: any[]) => any>(event: string, handler: T, opts?: Record<string, unknown>) => () => void }).on

  const disposers: Array<() => void> = []

  if (on) {
    // 正向：agent/pre-step（全局，让它在所有 agent 上生效）
    const d1 = on('agent/pre-step', async (payload: any, next: any) => {
      return service.handlePreStep(payload, next)
    }, { global: true })
    if (d1) disposers.push(d1)

    // 反向：llm/stream（全局）
    // agent-loop 在 buildRequest 时把 sessionId 写到 GenerateOptions，
    // 我们直接从 options.sessionId 读，跨 hook 状态用 Map<string, state>
    // 维护（pre-step 的 session 对象和 llm/stream 的 sessionId 字符串不
    // 是同一个引用，WeakMap<object> 行不通）。
    const d2 = on('llm/stream', (options: any, next: any) => {
      return service.handleLlmStream(options, next)
    }, { global: true })
    if (d2) disposers.push(d2)

    // 路由改写：agent/request（全局）。
    // 当 handlePreStep 因 sanitize 失败标记了 stepState.downgraded，
    // 这里把 provider/model 从 CLOUD 改写到 LOCAL，原始 PII 不离开设备。
    // agent-loop 的 contract：waterfall handler 收到 (payload, seed, next)，
    // 返回最终 config。我们注册在 default 之前，确保先于其他 listener 改写。
    const d3 = on('agent/request', async (payload: any, seed: any, next: any) => {
      const result = await service.handleAgentRequest(payload ?? {}, seed ?? {}, async () => next())
      return result
    }, { global: true })
    if (d3) disposers.push(d3)
  }

  return async () => {
    for (const d of disposers) d()
  }
}
