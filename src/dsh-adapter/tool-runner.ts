/**
 * tool-runner — §7.93 Phase 3:needle 提取结果的 TS 执行边界。
 *
 * needle 只产文本 + function_calls(不执行、不碰 PII、不做 realm 决策,
 * user 终裁 #1)。本模块是 needle-produced tool_calls 的**唯一**执行入口,
 * 与 LLM-produced tool_calls 享受完全相同的执法链:
 *
 *   1. schema 面校验 —— call.name 必须 ∈ POST 给 needle 的同一份 schemas
 *      (getToolSchemasForNeedle 产物,单一真相源);幻觉工具名直接拒。
 *   2. ungrounded 处理(API.md v1.1 `validation.ungrounded`)——
 *      required 参数被捏造 → **不执行**(skipped + audit needle.fabricated_arg,
 *      留给 LOCAL LLM synthesis 阶段补);非 required 被捏造 → 从 arguments
 *      剥除后执行(drop),不带幻觉值进工具。
 *   3. realm 预检(defense-in-depth)—— 复用 realm-skill-bridge
 *      checkToolRealm(name, getAgentRealm(agent));deny → needle.realm_rejected
 *      (security 级),宿主管线都不进。
 *   4. 宿主执行 —— `ctx.tools.execute()`(dsh-tools ToolRuntime),自动跑完整
 *      pre-execute(Layer 3 权威 realm gate 再查一遍,零绕过)/ guards /
 *      around-dispatch / post-execute 管线。**caller 必须透传 payload 里的
 *      真 agent**:Layer 3 靠 agent.session.id 查 sessionRealms(input-guard
 *      在 classify 时注册),假 agent = getAgentRealm undefined = fail-open。
 *
 * 审计纪律(PII):audit payload 只有 metadata(名字/时长/长度/计数),
 * **绝不落 arguments 内容或 result 内容** —— 与 file-logger 两-channel
 * 分工一致(ops log = 过程流水 metadata only;audit = 安全账本 redacted)。
 *
 * 失败契约:execute()/executeAll() **永不 throw** —— 一切异常归一成
 * status:'error' outcome + needle.execution_failed audit,调用方
 * (needle-extractor Phase 5)拿 outcome 决定合成消息或 fall through。
 *
 * 并发:executeAll 是**顺序**执行(不是计划草稿里的 Promise.all)——
 * 并行调度是宿主 scheduler 的领地(isConcurrencySafe 门控),本边界不绕过;
 * needle 单轮典型 1-2 个 call,顺序执行的延迟差可忽略,且 tool-result 合成
 * 消息顺序确定。
 *
 * 本模块**不是 cordis plugin**(无 export const inject / apply):它是纯类,
 * 由 needle-extractor(Phase 4)构造并持有。类型全部结构化 loose-coupling
 * (不 import dsh-tools/dsh-llm 类型,与 realm-skill-bridge 同款纪律);
 * ToolCallId 在运行时就是普通 string(brand 只在类型层)。
 *
 * @module dsh-edge-agent/tool-runner
 */

// ─────────────────────────────────────────────────────────────────────────────
// Loose structural types (cross-package interop without tight coupling)
// ─────────────────────────────────────────────────────────────────────────────

/** 宿主 ToolRuntime(ctx.tools)的最小子集 —— 只用到 execute。 */
export interface ToolRuntimeLike {
  execute(input: {
    callId: string
    name: string
    arguments: unknown
    agent?: unknown
    signal: AbortSignal
  }): Promise<ToolExecutionResultLike>
}

/** dsh-tools ToolExecutionResult 的最小子集(success/failure 判别联合)。 */
export interface ToolExecutionResultLike {
  isError: boolean
  content?: ReadonlyArray<{ type?: string; text?: string; [k: string]: unknown }>
  error?: { message?: string; info?: { name?: string; code?: string } }
}

/** realm-skill-bridge 服务的最小子集 —— realm 预检二方法。 */
export interface RealmBridgeLike {
  getAgentRealm(agent: unknown): string | undefined
  checkToolRealm(toolName: string, agentRealm: string | undefined): string | undefined
}

/** audit-log 服务的最小子集(与 realm-skill-bridge AuditLogLike 同形)。 */
export interface AuditLogLike {
  log(entry: { level: string; kind: string; source: string; payload?: Record<string, unknown> }): void
}

/** Phase 2 产物:getToolSchemasForNeedle 返回的平面 wire schema。 */
export interface NeedleToolSchemaLike {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** needle /extract 返回的单个 function_call(API.md v1.1)。 */
export interface NeedleFunctionCall {
  name: string
  /** needle 已做 JSON 解析;防御性当 unknown 收,入口再校验。 */
  arguments?: unknown
}

// ─────────────────────────────────────────────────────────────────────────────
// Outcome types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * - `executed`  宿主管线跑完且 isError=false
 * - `denied`    realm 预检拒绝 / 幻觉工具名 / call 形状非法(宿主未进)
 * - `skipped`   required 参数被捏造(ungrounded)→ 不执行,留给 synthesis
 * - `error`     宿主执行失败(isError=true)或 execute() 抛异常
 */
export type ToolRunStatus = 'executed' | 'denied' | 'skipped' | 'error'

export interface ToolRunOutcome {
  status: ToolRunStatus
  name: string
  /** 运行时 callId(Phase 5 合成 assistant tool_call / tool_result 消息用)。 */
  callId: string
  /** 模型可读的结果文本(content text 块拼接);非 executed 时为 ''。 */
  text: string
  /** denied/skipped/error 的原因(人类可读);executed 时 undefined。 */
  reason?: string
  /** 实际递进宿主的 arguments(捏造的非 required 参数已剥除)。 */
  executedArguments?: Record<string, unknown>
  /** 被剥除(drop)或因之拒执行(skip)的捏造参数名。 */
  fabricatedArgs?: string[]
  durationMs: number
}

export interface ToolRunRequest {
  call: NeedleFunctionCall
  /**
   * payload 里的**真 agent**(带 session.id)。Layer 3 gate 与 realm 预检都靠
   * getAgentRealm(agent) → sessionRealms.get(session.id) 解析 realm;
   * 传假 agent = realm 执法静默失效(fail-open)。
   */
  agent: unknown
  sessionId?: string
  /** POST 给 needle 的同一份 schemas(单一真相源,幻觉名在此拒)。 */
  schemas: readonly NeedleToolSchemaLike[]
  /** needle `validation.ungrounded`,形如 ["send_message.text"];可空。 */
  ungrounded?: readonly string[]
  /** caller 的取消信号;缺省时 runner 自建 executeTimeoutMs 超时信号。 */
  signal?: AbortSignal
}

export interface ToolRunnerDeps {
  tools: ToolRuntimeLike
  realmSkillBridge: RealmBridgeLike
  auditLog?: AuditLogLike
  /** ops log(可选;与 http-api/realm-skill-bridge 同款 debug 通道)。 */
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void }
  /** audit source 字段;默认 'tool-runner'。 */
  source?: string
  /** 无 caller signal 时的自建超时;默认 60_000ms。 */
  executeTimeoutMs?: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers (pure, exported for tests)
// ─────────────────────────────────────────────────────────────────────────────

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** content 块里抽文本(text 块拼接;非 text 块跳过 —— 与 http-api 同款投影)。 */
export function extractResultText(content: ToolExecutionResultLike['content']): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: string; text: string } =>
      isPlainRecord(b) && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('')
}

/** schema.parameters.required 里的字符串数组(JSON Schema 语义,防御性抽取)。 */
export function requiredArgsOf(schema: NeedleToolSchemaLike | undefined): string[] {
  const req = schema?.parameters?.required
  if (!Array.isArray(req)) return []
  return req.filter((x): x is string => typeof x === 'string')
}

/**
 * 从 needle `validation.ungrounded`(dotted "toolName.argName")里挑出属于
 * 本 call 的条目,按 schema.required 分成 skip 集(required 被捏造 → 整个
 * call 不执行)与 drop 集(非 required → 从 arguments 剥除后照常执行)。
 */
export function partitionUngrounded(
  toolName: string,
  ungrounded: readonly string[] | undefined,
  schema: NeedleToolSchemaLike | undefined,
): { skip: string[]; drop: string[] } {
  const skip: string[] = []
  const drop: string[] = []
  if (!Array.isArray(ungrounded)) return { skip, drop }
  const required = new Set(requiredArgsOf(schema))
  const prefix = `${toolName}.`
  for (const entry of ungrounded) {
    if (typeof entry !== 'string' || !entry.startsWith(prefix)) continue
    const arg = entry.slice(prefix.length)
    if (arg === '') continue
    ;(required.has(arg) ? skip : drop).push(arg)
  }
  return { skip, drop }
}

// ─────────────────────────────────────────────────────────────────────────────
// ToolRunner
// ─────────────────────────────────────────────────────────────────────────────

export class ToolRunner {
  private readonly tools: ToolRuntimeLike
  private readonly bridge: RealmBridgeLike
  private readonly auditLog: AuditLogLike | undefined
  private readonly logger: ToolRunnerDeps['logger']
  private readonly source: string
  private readonly executeTimeoutMs: number
  /** callId 单调计数(同 ms 内多 call 不撞号)。 */
  private callSeq = 0

  constructor(deps: ToolRunnerDeps) {
    this.tools = deps.tools
    this.bridge = deps.realmSkillBridge
    this.auditLog = deps.auditLog
    this.logger = deps.logger
    this.source = deps.source ?? 'tool-runner'
    this.executeTimeoutMs = deps.executeTimeoutMs ?? 60_000
  }

  /**
   * 执行单个 needle function_call。永不 throw(失败契约见文件头)。
   */
  async execute(req: ToolRunRequest): Promise<ToolRunOutcome> {
    const start = Date.now()
    const rawName = req.call?.name
    const name = typeof rawName === 'string' ? rawName : ''
    const callId = this.nextCallId(req.sessionId)

    // ── 0. call 形状校验(name 非空 string;arguments 缺省 {}) ──────────
    if (name === '') {
      return this.finish({
        status: 'denied', text: '', name: name || String(rawName ?? ''), callId,
        reason: 'invalid_call: missing tool name',
        durationMs: Date.now() - start,
      }, undefined, req)
    }
    const argsIn = isPlainRecord(req.call.arguments) ? req.call.arguments : {}

    // ── 1. schema 面校验(幻觉工具名拒;与 POST 给 needle 的同一份) ──────
    const schema = req.schemas.find(s => s.name === name)
    if (!schema) {
      this.audit('warn', 'needle.unknown_tool', { name, callId, sessionId: req.sessionId, schemaCount: req.schemas.length })
      return this.finish({
        status: 'denied', text: '', name, callId,
        reason: 'unknown_tool: not in the schema set given to needle',
        durationMs: Date.now() - start,
      }, undefined, req)
    }

    // ── 2. ungrounded 处理(required 捏造 → skip;非 required → drop) ────
    const { skip, drop } = partitionUngrounded(name, req.ungrounded, schema)
    if (skip.length > 0) {
      this.audit('warn', 'needle.fabricated_arg', {
        action: 'skip', name, callId, sessionId: req.sessionId,
        fabricatedArgs: skip, ungroundedCount: (req.ungrounded ?? []).length,
      })
      return this.finish({
        status: 'skipped', text: '', name, callId,
        reason: `fabricated required argument(s): ${skip.join(', ')} — left for LLM synthesis`,
        fabricatedArgs: skip,
        durationMs: Date.now() - start,
      }, undefined, req)
    }
    let args = argsIn
    if (drop.length > 0) {
      args = { ...argsIn }
      for (const k of drop) delete args[k]
      this.audit('warn', 'needle.fabricated_arg', {
        action: 'drop', name, callId, sessionId: req.sessionId,
        fabricatedArgs: drop, ungroundedCount: (req.ungrounded ?? []).length,
      })
    }

    // ── 3. realm 预检(defense-in-depth;Layer 3 在宿主管线里还会再查) ────
    const agentRealm = this.bridge.getAgentRealm(req.agent)
    const denyReason = this.bridge.checkToolRealm(name, agentRealm)
    if (denyReason !== undefined) {
      this.audit('security', 'needle.realm_rejected', {
        name, callId, sessionId: req.sessionId,
        agentRealm: agentRealm ?? 'unknown', reason: denyReason,
      })
      return this.finish({
        status: 'denied', text: '', name, callId, reason: denyReason,
        durationMs: Date.now() - start,
      }, undefined, req)
    }

    // ── 4. 宿主执行(ctx.tools.execute → 完整 pre/guard/around/post 管线) ──
    try {
      const signal = req.signal ?? AbortSignal.timeout(this.executeTimeoutMs)
      const result = await this.tools.execute({
        callId, name, arguments: args, agent: req.agent, signal,
      })
      const durationMs = Date.now() - start
      if (result?.isError) {
        const message = result.error?.message ?? 'tool execution failed'
        this.audit('warn', 'needle.execution_failed', {
          name, callId, sessionId: req.sessionId, durationMs,
          errorCode: result.error?.info?.code, errorLen: message.length,
        })
        return this.finish({
          status: 'error', text: '', name, callId, reason: message,
          executedArguments: args, durationMs,
        }, undefined, req)
      }
      const text = extractResultText(result?.content)
      this.audit('info', 'needle.executed', {
        name, callId, sessionId: req.sessionId, durationMs,
        resultLen: text.length, droppedFabricated: drop.length,
      })
      return this.finish({
        status: 'executed', name, callId, text,
        executedArguments: args,
        fabricatedArgs: drop.length > 0 ? drop : undefined,
        durationMs,
      }, text, req)
    }
    catch (err) {
      // 宿主 execute 契约上不 throw(失败也 materialize 成 isError result),
      // 但 registry 未挂载 / cordis proxy trap(§7.92.2)等仍可能炸 —— 归一。
      const durationMs = Date.now() - start
      const message = err instanceof Error ? err.message : String(err)
      this.audit('warn', 'needle.execution_failed', {
        name, callId, sessionId: req.sessionId, durationMs,
        thrown: true, errorLen: message.length,
      })
      return this.finish({
        status: 'error', text: '', name, callId, reason: message,
        executedArguments: args, durationMs,
      }, undefined, req)
    }
  }

  /**
   * 顺序执行一组 calls(并发是宿主 scheduler 的领地,本边界不绕过 ——
   * 见文件头)。单个失败不中断后续:每个 outcome 独立归一。
   */
  async executeAll(
    calls: readonly NeedleFunctionCall[],
    shared: Omit<ToolRunRequest, 'call'>,
  ): Promise<ToolRunOutcome[]> {
    const out: ToolRunOutcome[] = []
    for (const call of calls ?? []) {
      out.push(await this.execute({ ...shared, call }))
    }
    return out
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private nextCallId(sessionId: string | undefined): string {
    this.callSeq += 1
    const sess = sessionId ? `-${sessionId.slice(0, 12)}` : ''
    return `needle${sess}-${Date.now().toString(36)}-${this.callSeq}`
  }

  /** ops log 一行(可观测性纪律 §7.46:每个关键环节都在 ops log 体现)。 */
  private finish(
    outcome: ToolRunOutcome,
    _text: string | undefined,
    req: ToolRunRequest,
  ): ToolRunOutcome {
    try {
      this.logger?.info?.(
        `[tool-runner] ${outcome.status} tool=${outcome.name} callId=${outcome.callId}` +
        ` sessionId=${req.sessionId ?? 'unknown'} durationMs=${outcome.durationMs}` +
        (outcome.reason ? ` reason=${outcome.reason}` : ''),
      )
    } catch { /* debug only */ }
    return outcome
  }

  /** audit 只落 metadata —— 绝不落 arguments/result 内容(PII 纪律)。 */
  private audit(level: string, kind: string, payload: Record<string, unknown>): void {
    try {
      this.auditLog?.log({ level, kind, source: this.source, payload })
    } catch { /* audit 失败不阻断执行链 */ }
  }
}
