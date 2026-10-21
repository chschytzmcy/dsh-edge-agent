/**
 * function-call-external — §7.93.1(2026-09-25 通用化重构):
 * 通用 tool-call 外置小模型能力,client 负责把 user query + tool schemas POST 给
 * 一个外部 HTTP service,让该 service 返回 function_calls 结构化结果。
 * 完整 pipeline(8 fail-open gate + circuit breaker + boot probe + 周期
 * recovery + ToolRunner 执行 + 合成 user-role message 注入 decision.messages)
 * 是 §7.93 已验证的,本文件不重做设计,只重命名 + 抽出 provider 接口。
 *
 * **Phase 路线**(沿用 §7.93):
 *   - §7.93 Phase 4=骨架;5=waterfall listener;6=breaker+probe;7=失败路径
 *     细分;8=E2E+bench;9=部署+boot-verify
 *   - §7.93.1(本次)=generic 化:
 *     - 名字脱离"needle":plugin / config / env / audit / ops log 全 generic
 *     - 抽出 `ExternalToolCaller` interface;当前实现 = `NeedleHttpCaller`
 *       (cactus-needle 3.0.1,API.md v1.1 契约,GET /health + POST /extract)
 *     - 后续替换 = 新增一个 class implements `ExternalToolCaller`,改
 *       `apply()` 里一行 `new XxxCaller(...)` 即可
 *
 * **架构(沿用 §7.93)**:user query + tool schemas → ExternalToolCaller →
 * 拿回 function_calls → TS tool-runner 执行(realm/PII/audit 零绕过)→
 * 整段对话给 LOCAL LLM 合成回复。所有失败 fall through 到 §7.42 P0-1
 * LLM 自提取路径(本插件是 prefill 不是替代)。
 *
 * **服务边界**:
 *   - 一切失败(caller down / 超时 / 低置信 / 空 schemas / 0 executed)
 *     fall through 到 LLM 自提取路径(§7.42 P0-1 patch 保留作 fallback)
 *   - CLOUD intent 跳过(云端 LLM 自带 native tool calling);REJECT intent
 *     input-guard 已拒、我们看不到 realm;undefined realm 跳过(稳健于启动
 *     时序:即使 apply 顺序出错也不会 crash,只是不优化)
 *
 * **注入约束**(沿用 §7.93 Phase 4.5 + Phase 5 关键修正):
 *   1. `agent/request` waterfall 只携带 config,**没有 messages** ——
 *      真实注入点 `agent/pre-step`(decision.messages → appended as
 *      user/message events → deriveMessages)
 *   2. assembly.tools 在 pre-step 之前就锁死 — pre-step listener 改不了;
 *      强指令 + §7.42 P0-1 + Layer 3 realm gate 兜底
 *   3. decision.messages 全部以 user/message append;assistant tool_call
 *      role 在该 hook 不可达 → 只追加 user-role message
 *   4. **插件 apply 顺序**:必须在 input-guard **之前**(cordis waterfall
 *      注册顺序 = 执行顺序;await next() 串到 input-guard,等 classify +
 *      setSessionRealm 完成后才看得到本 turn 的 realm)
 *
 * audit 面(source='function-call-external'):
 *   external.hook.registered        (info,apply 时一次性)
 *   external.boot_probe             (info/warn,Phase 6)
 *   external.boot_probe.skipped     (info,配置关掉 boot probe)
 *   external.boot_probe.unexpected  (error,probe 自己抛)
 *   external.probe                  (info,Phase 6 周期 probe)
 *   external.circuit_open           (warn,Phase 6)
 *   external.circuit_open_skip      (info,Gate 2 短路)
 *   external.recovered              (info,周期 probe 命中 2xx 关 breaker)
 *   external.extract                (info,/extract 调用 metadata)
 *   external.extract_retry          (warn,Phase 7 退避重试 503/502)
 *   external.extract_failed         (warn,4xx/5xx/网络错)
 *   external.low_confidence_skip    (info,采纳门未过)
 *   external.timeout_skip           (warn,extract 超时)
 *   external.synthesis_injected     (info,合成 user-role 已注入)
 *   external.realm_unset_skip       (info,realm 未注册跳过)
 *   external.listener.error         (error,handlePreStep 自身 catch 兜底)
 * tool-runner(source='tool-runner',Phase 3):
 *   external.executed / .execution_failed / .realm_rejected /
 *   external.fabricated_arg / .unknown_tool
 *
 * inject(§7.92.2 proxy trap:读 ctx.X 前必须先列 inject):
 *   - auditLog          审计
 *   - realmSkillBridge  getToolSchemasForExternal + getSessionRealm
 *   - tools             宿主 ToolRuntime,ToolRunner 的执行面
 *
 * @module dsh-edge-agent/function-call-external
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { ToolRunner } from './tool-runner.js'
import { loadEdgeConfig } from './edge-config.js'

export const name = 'function-call-external'

export const inject = ['auditLog', 'realmSkillBridge', 'tools'] as const

/** Minimal interface for the audit-log service (same shape as intent-router). */
interface AuditLike {
  log(entry: { level: 'debug' | 'info' | 'warn' | 'error' | 'security'; kind: string; source: string; payload: Record<string, unknown> }): Promise<unknown>
}

/** ── Provider abstraction (§7.93.1 + §7.94) ────────────────────────────────
 *  ExternalToolCaller:把 HTTP 协议层隔离开。Plugin 持有 caller,所有 HTTP/JSON
 *  逻辑都在 caller 里。Plugin 只关心:
 *    - caller.healthCheck(signal) → 是否能用
 *    - caller.extract({query, tools, signal, system?}) → 是否成功 + 原始响应
 *
 *  §7.94:HTTP 契约即接口边界(详见 docs/function-call-external-http-contract.md)。
 *  当前实现 = `NeedleHttpCaller`(cactus-needle 3.0.1,API.md v1.1 §4)。
 *  未来端侧模型 = 自暴露 GET /health + POST /extract,改
 *  `FUNCTION_CALL_EXTERNAL_URL` 即可,plugin 零改动。
 *
 *  3 个只读元数据(`id` / `kind` / `capabilities`)纯可观测,无新行为:
 *    - `id`:稳定标识,audit/ops log 携带('needle-http' / 未来 'native-onnx-v1')
 *    - `kind`:transport 类型(HTTP / IPC / in-process),影响 ops log 字段
 *    - `capabilities`:能力声明(maxTools / maxQueryLen / supportsUngrounded)
 */
export interface ExternalToolCaller {
  /** §7.94:稳定标识 —— audit/ops log 通过 callerId 索引 */
  readonly id: string
  /** §7.94:transport 类型 */
  readonly kind: 'http' | 'ipc' | 'in-process'
  /** §7.94:能力声明 —— maxTools / maxQueryLen / supportsUngrounded */
  readonly capabilities: Readonly<{
    /** 单次请求支持的 max tools(schema context 上限) */
    maxTools?: number
    /** 单次请求支持的 max query 长度(字符) */
    maxQueryLen?: number
    /** 是否支持 validation.ungrounded 字段 */
    supportsUngrounded?: boolean
  }>

  /** /health probe. throws on transport error. ok=false on non-2xx. */
  healthCheck(signal: AbortSignal): Promise<{
    ok: boolean
    httpStatus: number
    latencyMs: number
    error?: string
  }>
  /** /extract call. throws on transport error. ok=false on non-2xx (caller
   *  decides retry/breaker based on status). On 2xx, raw is parsed JSON. */
  extract(req: {
    query: string
    tools: ReadonlyArray<{ name: string; description: string; parameters: Record<string, unknown> }>
    signal: AbortSignal
    system?: string
  }): Promise<{
    ok: boolean
    status: number
    body: string
    raw?: unknown
  }>
}

/** ── Default impl: cactus-needle 3.0.1 (API.md v1.1 §4) ───────────────────
 *  - GET /health    → 2xx healthy, 503 loading/queue-busy
 *  - POST /extract  → {type, function_calls, confidence, validation, ...}
 *  - 系统 prompt: API.md v1.1 推荐传 `date: YYYY-MM-DD EEE; locale: zh-CN`
 *    让 needle 拿到日期 + locale 上下文(否则只 confidence=1.0 但
 *    function_calls=[] 报"没有 file management tool"——见 §7.93 Phase 9 amend
 *    实测)。
 *  - 替换实现时,这个 class 可以整个删掉,写新 caller 即可。 */
class NeedleHttpCaller implements ExternalToolCaller {
  // ── §7.94:只读元数据(纯可观测,无新行为)────────────────────────────
  readonly id = 'needle-http'
  readonly kind = 'http' as const
  readonly capabilities: Readonly<{
    maxTools: number
    maxQueryLen: number
    supportsUngrounded: boolean
  }> = {
    maxTools: 64,
    maxQueryLen: 8192,
    supportsUngrounded: true,
  }

  constructor(
    private readonly url: string,
    private readonly auditLog: AuditLike | undefined,
    private readonly logger: { info?: (m: string) => void; warn?: (m: string) => void } | undefined,
    /** Optional fetch override (used by tests; production uses globalThis.fetch).
     *  §7.92.2 proxy trap safe — global fetch fallback only when undefined. */
    private readonly fetchImpl?: (url: string, init: RequestInit) => Promise<Response>,
  ) {}

  /** Pick override fetch if set, else globalThis.fetch (§7.92.2 proxy trap safe). */
  private async _fetchImpl(url: string, init: RequestInit): Promise<Response> {
    if (this.fetchImpl) return this.fetchImpl(url, init)
    try {
      const g = (globalThis as unknown as { fetch?: (url: string, init: RequestInit) => Promise<Response> }).fetch
      if (typeof g === 'function') return g(url, init)
    } catch { /* nothing */ }
    throw new Error('no_fetch_runtime')
  }

  async healthCheck(signal: AbortSignal) {
    const start = Date.now()
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
    let ok = false
    let httpStatus = 0
    let errorMsg = ''
    try {
      const r = await this._fetchImpl(`${this.url}/health`, { method: 'GET', signal: controller.signal })
      httpStatus = r.status
      ok = r.ok
      if (!ok) { try { await r.text() } catch { /* ignore */ } }
    } catch (err: unknown) {
      errorMsg = (err as { message?: string })?.message ?? String(err)
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
    return { ok, httpStatus, latencyMs: Date.now() - start, ...(errorMsg ? { error: errorMsg } : {}) }
  }

  async extract(req: {
    query: string
    tools: ReadonlyArray<{ name: string; description: string; parameters: Record<string, unknown> }>
    signal: AbortSignal
    system?: string
  }) {
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    if (req.signal.aborted) controller.abort()
    else req.signal.addEventListener('abort', onAbort, { once: true })
    let ok = false
    let status = 0
    let body = ''
    let raw: unknown
    let r: Response
    try {
      r = await this._fetchImpl(`${this.url}/extract`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: req.query, tools: req.tools, ...(req.system ? { system: req.system } : {}) }),
      })
      status = r.status
      ok = r.ok
      body = await r.text()
      if (ok) {
        try { raw = JSON.parse(body) } catch { /* ignore — raw stays undefined */ }
      }
    } catch (err: unknown) {
      // Transport error (fetch threw — typically AbortError on timeout, or network down).
      // Re-throw so the orchestrator's attemptExtractOnce catches it and routes to
      // the `transport` kind branch (which knows about AbortError for TimeoutSkip).
      // §7.93.1: caller.extract is just an HTTP wrapper — transport semantics
      // belong to the orchestrator, not the caller.
      throw err
    }
    req.signal.removeEventListener('abort', onAbort)
    return { ok, status, body, ...(raw !== undefined ? { raw } : {}) }
  }
}

/** Build a "date: ... ; locale: ..." system prompt for extract (Phase 9 amend). */
function buildDefaultSystemPrompt(locale: string = 'zh-CN'): string {
  const now = new Date()
  const weekday = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][now.getDay()]
  const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return `date: ${iso} ${weekday}; locale: ${locale}`
}

// ──────────────────────────────────────────────────────────────────────────

/** Phase 5 TypeScript-loose re-shape of PreStepDecision (dynamic import avoidance)。 */
interface PreStepDecisionShape {
  kind: 'enter' | 'reject'
  messages?: ReadonlyArray<Record<string, unknown>>
  reason?: string
  startsRequestSeries?: true
  /** Phase 5 doesn't override this; input-guard pattern preserves it as-is. */
  assembly?: unknown
}

export interface Config {
  /** 总开关。schema 默认 false;生产 cordis.patch.yml 用 env 翻译层给值
   *  (Phase 9)。false 时 boot 但 isAvailable() 恒 false,Phase 5 listener
   *  直接 next() 透传。 */
  functionCallExternalEnabled?: boolean
  /** HTTP 服务基址。当前实现 = cactus-needle 3.0.1 (needle-http :8081);
   *  后续替换 = 改这个 URL + apply() 里一行构造新 caller。 */
  functionCallExternalUrl?: string
  /** 单次 POST 超时(ms)。实测 needle 引擎 4-7s(dry-run #1 spec 376-548ms 是
   *  理想值,实际 25-30x degradation);默认 10s 给单请求 1x 余量。 */
  functionCallExternalTimeoutMs?: number
  /** 采纳阈值:confidence < 此值 → fall through(实测 needle 报
   *  0.5-0.7 区间合理);0.5 让多数有 tool match 的提取通过 adopt gate。 */
  functionCallExternalConfidenceThreshold?: number
  /** breaker 打开后的 TTL(ms);期间 classify 跳过 caller 直走 LLM。 */
  functionCallExternalBreakerTtlMs?: number
  /** Phase 6:apply() 时 fire-and-forGET /health;fail → 预开 breaker。 */
  functionCallExternalBootProbeEnabled?: boolean
  /** boot probe 超时(ms)。 */
  functionCallExternalBootProbeTimeoutMs?: number
  /** breaker 打开期间的周期恢复 probe 间隔(ms)。 */
  functionCallExternalBreakerProbeMs?: number
  /** 周期 probe 超时(ms)。 */
  functionCallExternalProbeTimeoutMs?: number
}

// §7.102: every field is **optional without a Schema default** on purpose.
//
// Schemastery fills Schema defaults into the config object before apply()
// runs, so a defaulted field can no longer be told apart from "the operator
// did not configure it". The new precedence is
//
//   explicit cordis value  →  config/edge.json  →  the literal below
//
// and the literal below only applies when neither of the first two provided
// a value. Keeping the defaults out of the Schema is what makes the middle
// tier reachable: a cordis patch row that sets nothing leaves the field
// undefined, and the plugin then consults config/edge.json.
export const Config: Schema<Config> = Schema.object({
  functionCallExternalEnabled: Schema.boolean(),
  functionCallExternalUrl: Schema.string(),
  // 实测 cactus-needle /extract LAN 当前引擎下需 4-7s(dry-run #1 标
  // 376-548ms 是 spec 理想值,实际 25-30x degradation);10s 给单请求 1x 余量。
  // 后续引擎恢复 < 1s 时再调低。
  functionCallExternalTimeoutMs: Schema.natural(),
  // 0.7 太严(实测 needle 报 confidence 0.5-0.7 区间) → 0.5 让多数有
  // tool match 的提取通过 adopt gate;后续模型升级再调高。
  functionCallExternalConfidenceThreshold: Schema.number().min(0).max(1),
  functionCallExternalBreakerTtlMs: Schema.natural(),
  functionCallExternalBootProbeEnabled: Schema.boolean(),
  functionCallExternalBootProbeTimeoutMs: Schema.natural(),
  functionCallExternalBreakerProbeMs: Schema.natural(),
  functionCallExternalProbeTimeoutMs: Schema.natural(),
})

/** In-memory counters exposed via getStats(). Pure observability; the audit
 *  log already carries every per-call kind, but counters give operators an
 *  O(1) read for dashboards / alerts (rate of timeouts, % sanitized, etc.)
 *  without parsing JSONL. */
export interface FunctionCallExternalStats {
  /** 配置快照:总开关(运维排查"为什么没走 external"第一问)。 */
  functionCallExternalEnabled: boolean
  /** Phase 6:boot probe 成功/失败(失败 = breaker 预开)。 */
  functionCallExternalBootProbeOk: number
  functionCallExternalBootProbeFail: number
  /** Phase 6:周期 probe 尝试/恢复(breaker 关闭)次数。 */
  functionCallExternalProbeAttempts: number
  functionCallExternalRecoveredProbe: number
  /** Phase 6:breaker 当前是否打开(getStats 时快照)。 */
  functionCallExternalCircuitOpen: boolean
  /** Phase 5/6:因 breaker 打开跳过 caller 的请求数。 */
  functionCallExternalCircuitSkip: number
  /** Phase 5:realm 未注册(undefined)跳过 + 非 LOCAL/SANITIZED 跳过。 */
  functionCallExternalRealmUnsetSkip: number
  /** Phase 5:/extract 调用数 / 成功采纳数 / 低置信跳过 / 超时跳过。 */
  functionCallExternalExtractCalls: number
  functionCallExternalExtractOk: number
  functionCallExternalLowConfSkip: number
  functionCallExternalTimeoutSkip: number
  /** Phase 3(tool-runner 归一的 outcome 计数,由 Phase 5 汇入)。 */
  functionCallExternalExecuted: number
  functionCallExternalErrors: number
  /** Phase 5:≥1 executed → 注入合成 message 的次数。 */
  functionCallExternalSynthesisInjected: number
  /** /extract 累计延迟(取驱动决策的响应,均值 = total/calls)。 */
  functionCallExternalLatencyMsTotal: number
  /** Phase 7:503/502 退避重试的尝试次数(不算首次);一次 logical extract
   *  call 最多 +1。 */
  functionCallExternalRetryAttempts: number
}

export class FunctionCallExternalServiceImpl extends Service {
  private readonly auditLog: AuditLike | undefined
  private readonly functionCallExternalEnabled: boolean
  private readonly functionCallExternalUrl: string
  private readonly functionCallExternalTimeoutMs: number
  private readonly functionCallExternalConfidenceThreshold: number
  private readonly functionCallExternalBreakerTtlMs: number
  private readonly functionCallExternalBootProbeEnabled: boolean
  private readonly functionCallExternalBootProbeTimeoutMs: number
  private readonly functionCallExternalBreakerProbeMs: number
  private readonly functionCallExternalProbeTimeoutMs: number

  /** Provider abstraction(§7.93.1):所有 HTTP 走 caller。Plugin 不直接
   *  fetch。替换 = 改 apply() 里的构造,plugin 代码不变。 */
  private readonly caller: ExternalToolCaller

  // ── Phase 6 runtime state:circuit breaker + boot probe + periodic probe ──
  /** §7.92.6:ms-epoch timestamp until which the breaker is open.
   *  0 = closed. openBreaker() sets it; closeBreaker() resets it. */
  private functionCallExternalBreakerOpenUntil = 0
  /** §7.92.7:setInterval handle for the periodic recovery probe. */
  private functionCallExternalBreakerProbeTimer: ReturnType<typeof setInterval> | null = null
  /** §7.92.7:in-flight boot probe promise。track 让 stop() / dispose
   *  能 await 而不留下 dangling fetch racing constructor's first
   *  classify() call. */
  private functionCallExternalBootProbePromise: Promise<void> | null = null
  /** §7.92.7 helper:最近一次 periodic probe wall-clock。 */
  private functionCallExternalLastProbeLatencyMs = 0

  private readonly stats: FunctionCallExternalStats

  constructor(ctx: Context, config: Config, auditLog?: AuditLike, caller?: ExternalToolCaller) {
    super(ctx, 'functionCallExternal')
    this.auditLog = auditLog
    this.functionCallExternalEnabled = config.functionCallExternalEnabled ?? false
    this.functionCallExternalUrl = config.functionCallExternalUrl ?? 'http://127.0.0.1:8081'
    this.functionCallExternalTimeoutMs = config.functionCallExternalTimeoutMs ?? 10000
    this.functionCallExternalConfidenceThreshold = config.functionCallExternalConfidenceThreshold ?? 0.5
    this.functionCallExternalBreakerTtlMs = config.functionCallExternalBreakerTtlMs ?? 30000
    this.functionCallExternalBootProbeEnabled = config.functionCallExternalBootProbeEnabled ?? true
    this.functionCallExternalBootProbeTimeoutMs = config.functionCallExternalBootProbeTimeoutMs ?? 2000
    this.functionCallExternalBreakerProbeMs = config.functionCallExternalBreakerProbeMs ?? 5000
    this.functionCallExternalProbeTimeoutMs = config.functionCallExternalProbeTimeoutMs ?? 2000

    this.caller = caller ?? new NeedleHttpCaller(
      this.functionCallExternalUrl,
      this.auditLog,
      this.ctx.logger,
      // ctx.fetch: optional override for tests. In production, ctx is a
      // cordis proxy and `fetch` isn't in `inject:`, so this access throws
      // (§7.92.2 proxy trap). Swallow + fall through to globalThis.fetch.
      this.tryFetchOverride(),
    )

    this.stats = {
      functionCallExternalEnabled: this.functionCallExternalEnabled,
      functionCallExternalBootProbeOk: 0,
      functionCallExternalBootProbeFail: 0,
      functionCallExternalProbeAttempts: 0,
      functionCallExternalRecoveredProbe: 0,
      functionCallExternalCircuitOpen: false,
      functionCallExternalCircuitSkip: 0,
      functionCallExternalRealmUnsetSkip: 0,
      functionCallExternalExtractCalls: 0,
      functionCallExternalExtractOk: 0,
      functionCallExternalLowConfSkip: 0,
      functionCallExternalTimeoutSkip: 0,
      functionCallExternalExecuted: 0,
      functionCallExternalErrors: 0,
      functionCallExternalSynthesisInjected: 0,
      functionCallExternalLatencyMsTotal: 0,
      functionCallExternalRetryAttempts: 0,
    }
  }

  // ── availability ──────────────────────────────────────────────────────

  /**
   * §7.92.6 (2026-09-24):breaker-aware availability。
   * Phase 4 语义:enabled。Phase 6 叠加:enabled && Date.now() >= breakerOpenUntil
   * (jev `isJevAvailable()` 同款语义)。Phase 5 listener Gate 2
   * `if (!isAvailable()) return decision` 因此自动承担 short-circuit:
   * 0ms 短路,不付出 extract 1.5s 超时。audit `external.circuit_open_skip`
   * 由 Gate 2 显式落(见 handlePreStep)。
   */
  isAvailable(): boolean {
    return this.functionCallExternalEnabled && Date.now() >= this.functionCallExternalBreakerOpenUntil
  }

  /** ctx.fetch access — production ctx is a cordis proxy and throws if the
   *  key isn't in `inject:` (§7.92.2). Tests use a plain object ctx and
   *  set `fetch` directly. Swallow the cordis proxy throw + fall through
   *  to NeedleHttpCaller's globalThis.fetch fallback. */
  private tryFetchOverride(): ((url: string, init: RequestInit) => Promise<Response>) | undefined {
    try {
      const f = (this.ctx as unknown as { fetch?: (url: string, init: RequestInit) => Promise<Response> }).fetch
      return typeof f === 'function' ? f : undefined
    } catch {
      return undefined
    }
  }

  /** 配置只读视图(ops 排查 + 测试断言;env 翻译层是否生效一眼可见)。 */
  getConfigView(): Readonly<{
    functionCallExternalEnabled: boolean
    functionCallExternalUrl: string
    functionCallExternalTimeoutMs: number
    functionCallExternalConfidenceThreshold: number
    functionCallExternalBreakerTtlMs: number
    functionCallExternalBootProbeEnabled: boolean
    functionCallExternalBootProbeTimeoutMs: number
    functionCallExternalBreakerProbeMs: number
    functionCallExternalProbeTimeoutMs: number
  }> {
    return {
      functionCallExternalEnabled: this.functionCallExternalEnabled,
      functionCallExternalUrl: this.functionCallExternalUrl,
      functionCallExternalTimeoutMs: this.functionCallExternalTimeoutMs,
      functionCallExternalConfidenceThreshold: this.functionCallExternalConfidenceThreshold,
      functionCallExternalBreakerTtlMs: this.functionCallExternalBreakerTtlMs,
      functionCallExternalBootProbeEnabled: this.functionCallExternalBootProbeEnabled,
      functionCallExternalBootProbeTimeoutMs: this.functionCallExternalBootProbeTimeoutMs,
      functionCallExternalBreakerProbeMs: this.functionCallExternalBreakerProbeMs,
      functionCallExternalProbeTimeoutMs: this.functionCallExternalProbeTimeoutMs,
    }
  }

  getStats(): FunctionCallExternalStats {
    return {
      ...this.stats,
      functionCallExternalCircuitOpen: Date.now() < this.functionCallExternalBreakerOpenUntil,
    }
  }

  // ── lifecycle(Phase 6 填实:boot probe + 周期 recovery probe)─────────

  start(): void {
    if (!this.functionCallExternalEnabled) return
    if (!this.functionCallExternalBootProbeEnabled) {
      this.audit('info', 'external.boot_probe.skipped', {
        callerId: this.caller.id,
        reason: 'disabled-by-config',
        url: this.functionCallExternalUrl,
      })
      return
    }
    this.functionCallExternalBootProbePromise = this.probeHealth('boot', this.functionCallExternalBootProbeTimeoutMs)
      .then((ok) => {
        if (!ok) {
          // Pre-open breaker AND start periodic recovery probe
          this.openBreaker('transport')
        }
      })
      .catch((err: unknown) => {
        this.audit('error', 'external.boot_probe.unexpected', {
          callerId: this.caller.id,
          error: (err as { message?: string })?.message ?? String(err),
        })
      })
      .finally(() => {
        this.functionCallExternalBootProbePromise = null
      })
  }

  async stop(): Promise<void> {
    this.stopBreakerProbe()
    if (this.functionCallExternalBootProbePromise) {
      try { await this.functionCallExternalBootProbePromise } catch { /* swallow */ }
    }
  }

  // ── §7.92.6/§7.92.7:probe + breaker ──────────────────────────────────

  /**
   * §7.92.7:probe caller /health.returns true on 2xx, false on anything else
   * (transport error, timeout, non-2xx). Always resolves — never throws.
   */
  private async probeHealth(phase: 'boot' | 'periodic', timeoutMs: number): Promise<boolean> {
    if (phase === 'periodic') this.stats.functionCallExternalProbeAttempts++
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let ok = false
    let httpStatus = 0
    let errorMsg = ''
    let latencyMs = 0
    try {
      const r = await this.caller.healthCheck(controller.signal)
      ok = r.ok
      httpStatus = r.httpStatus
      latencyMs = r.latencyMs
      if (!ok) errorMsg = r.error ?? 'no_response'
    } catch (err: unknown) {
      errorMsg = (err as { message?: string })?.message ?? String(err)
    } finally {
      clearTimeout(timer)
    }
    if (phase === 'boot') {
      if (ok) {
        this.stats.functionCallExternalBootProbeOk++
        this.audit('info', 'external.boot_probe', {
          callerId: this.caller.id,
          url: this.functionCallExternalUrl, httpStatus, latencyMs, ok: true,
        })
        this.opsLog('boot probe', `ok=true latencyMs=${latencyMs}ms httpStatus=${httpStatus}`)
      } else {
        this.stats.functionCallExternalBootProbeFail++
        this.audit('warn', 'external.boot_probe', {
          callerId: this.caller.id,
          url: this.functionCallExternalUrl, httpStatus, latencyMs, ok: false, error: errorMsg,
        })
        this.opsLog('boot probe', `ok=false latencyMs=${latencyMs}ms httpStatus=${httpStatus} error=${errorMsg || 'none'}`)
      }
    } else {
      this.functionCallExternalLastProbeLatencyMs = latencyMs
      this.audit('info', 'external.probe', {
        callerId: this.caller.id,
        url: this.functionCallExternalUrl, httpStatus, latencyMs, ok,
        error: ok ? undefined : errorMsg,
      })
      this.opsLog('periodic probe', `ok=${ok} latencyMs=${latencyMs}ms httpStatus=${httpStatus}${ok ? '' : ` error=${errorMsg || 'none'}`}`)
    }
    return ok
  }

  /**
   * §7.92.7:启动周期 recovery probe。idempotent。
   */
  private startBreakerProbe(): void {
    if (this.functionCallExternalBreakerProbeTimer !== null) return
    this.functionCallExternalBreakerProbeTimer = setInterval(() => {
      void this.probeHealth('periodic', this.functionCallExternalProbeTimeoutMs)
        .then((ok) => {
          if (!ok) return
          if (Date.now() < this.functionCallExternalBreakerOpenUntil) {
            this.functionCallExternalBreakerOpenUntil = 0
            this.stats.functionCallExternalRecoveredProbe++
            this.audit('info', 'external.recovered', {
              callerId: this.caller.id,
              url: this.functionCallExternalUrl,
              probeLatencyMs: this.functionCallExternalLastProbeLatencyMs,
            })
            this.opsLog('circuit recovered', `probeLatencyMs=${this.functionCallExternalLastProbeLatencyMs}ms`)
          }
          this.stopBreakerProbe()
        })
        .catch(() => { /* probeHealth never throws; defensive */ })
    }, this.functionCallExternalBreakerProbeMs)
    if (typeof this.functionCallExternalBreakerProbeTimer.unref === 'function') {
      this.functionCallExternalBreakerProbeTimer.unref()
    }
  }

  private stopBreakerProbe(): void {
    if (this.functionCallExternalBreakerProbeTimer === null) return
    clearInterval(this.functionCallExternalBreakerProbeTimer)
    this.functionCallExternalBreakerProbeTimer = null
  }

  /**
   * §7.92.6:open-on-first-failure(jev 是 all-batches 失败才开,这里
   * 单 fetch 等价于"这一发失败")。timeout 与 5xx 都计入(§7.93 dry-run #1
   * 验证 needle 引擎当前 25x degradation,1.5s timeout 几乎全中)。
   * 4xx 不开(client error ≠ engine down)。idempotent:已开则 no-op。
   */
  private openBreaker(reason: 'timeout' | 'http_5xx' | 'transport'): void {
    if (Date.now() < this.functionCallExternalBreakerOpenUntil) return
    this.functionCallExternalBreakerOpenUntil = Date.now() + this.functionCallExternalBreakerTtlMs
    this.audit('warn', 'external.circuit_open', {
      callerId: this.caller.id,
      reason,
      url: this.functionCallExternalUrl,
      ttlMs: this.functionCallExternalBreakerTtlMs,
      openUntilMs: this.functionCallExternalBreakerOpenUntil,
    })
    this.opsLog('circuit open', `reason=${reason} openUntilMs=${this.functionCallExternalBreakerOpenUntil} ttlMs=${this.functionCallExternalBreakerTtlMs}`)
    this.startBreakerProbe()
  }

  private closeBreaker(): void {
    if (this.functionCallExternalBreakerOpenUntil === 0) return
    this.functionCallExternalBreakerOpenUntil = 0
  }

  // ── ToolRunner 装配(Phase 3 边界的持有者)───────────────────────────

  createToolRunner(): ToolRunner | undefined {
    try {
      const c = this.ctx as unknown as {
        tools?: { execute?: unknown }
        realmSkillBridge?: { getAgentRealm?: unknown; checkToolRealm?: unknown }
        logger?: { info?: (m: string) => void; warn?: (m: string) => void }
      }
      const tools = c.tools
      const bridge = c.realmSkillBridge
      if (!tools || typeof tools.execute !== 'function') return undefined
      if (!bridge || typeof bridge.getAgentRealm !== 'function' || typeof bridge.checkToolRealm !== 'function') return undefined
      return new ToolRunner({
        tools: tools as never,
        realmSkillBridge: bridge as never,
        auditLog: this.auditLog as never,
        logger: c.logger,
        source: name,
      })
    } catch {
      return undefined
    }
  }

  // ── audit / ops log helpers ──────────────────────────────────────────

  audit(level: 'debug' | 'info' | 'warn' | 'error' | 'security', kind: string, payload: Record<string, unknown>): void {
    if (!this.auditLog) return
    void this.auditLog.log({ level, kind, source: name, payload }).catch(() => {})
  }

  /**
   * §7.46 ops-log-coverage-principle 双轨(file-logger + audit-log)。
   * audit 走 JSONL 解析器;ops log 走 file-logger 运维 grep。
   * 两者 metadata only,绝不落 query/arguments/result 内容(PII 纪律)。
   */
  opsLog(event: string, fields: string): void {
    try {
      this.ctx.logger?.info?.(`[function-call-external] ${event} ${fields}`)
    } catch { /* debug only */ }
  }

  // ── loose reads(§7.92.2 proxy trap safe)────────────────────────────

  private bridge(): {
    getSessionRealm?: (sid: string | undefined) => string | undefined
    getToolSchemasForExternal?: (intent: 'LOCAL' | 'SANITIZED') => ReadonlyArray<{ name: string; description: string; parameters: Record<string, unknown> }>
  } | undefined {
    try {
      return (this.ctx as unknown as {
        realmSkillBridge?: {
          getSessionRealm?: (sid: string | undefined) => string | undefined
          getToolSchemasForExternal?: (intent: 'LOCAL' | 'SANITIZED') => ReadonlyArray<{ name: string; description: string; parameters: Record<string, unknown> }>
        }
      }).realmSkillBridge
    } catch {
      return undefined
    }
  }

  // ── extract(Phase 7 失败路径细分)─────────────────────────────────────

  /**
   * POST /extract(caller.extract)。失败路径细分(沿用 §7.93 Phase 7):
   *   422 invalid body       → 不重试,不开 breaker
   *   503 + body 'loading'   → 不重试,开 breaker
   *   503 + body 'busy'      → 重试 1 次 200ms,二次仍 503 → 开 breaker
   *   502 engine internal    → 重试 1 次 200ms,二次仍 502 → 开 breaker
   *   408/504 timeout proxy  → 不重试,开 breaker
   *   其他 5xx               → 不重试,开 breaker
   *   AbortError(本地超时)   → 不重试,开 breaker
   *   其它网络错             → 不重试,开 breaker
   *   no fetcher             → 不重试,开 breaker
   */
  private async extractCalls(
    query: string,
    schemas: ReadonlyArray<{ name: string; description: string; parameters: Record<string, unknown> }>,
    sessionId: string | undefined,
    upstreamSignal: AbortSignal | undefined,
  ): Promise<{
    type: 'call' | 'respond'
    calls: ReadonlyArray<{ name: string; arguments: unknown }>
    confidence: number
    validation: { ungrounded: readonly string[] }
    raw: Record<string, unknown>
  } | null> {
    const retryPlan = [
      { delayMs: 0, isRetry: false },
      { delayMs: 200, isRetry: true },
    ] as const
    this.stats.functionCallExternalExtractCalls += 1

    for (const attempt of retryPlan) {
      if (attempt.delayMs > 0) {
        await new Promise<void>(r => setTimeout(r, attempt.delayMs))
        this.stats.functionCallExternalRetryAttempts += 1
      }

      const r = await this.attemptExtractOnce(query, schemas, sessionId, upstreamSignal)

      if (r.kind === 'fatal_422') {
        this.audit('warn', 'external.extract_failed', {
          callerId: this.caller.id,
          sessionId, durationMs: r.durationMs, status: 422,
          reason: 'invalid_body_422',
          bodyPreview: r.body.slice(0, 80),
          retried: attempt.isRetry,
        })
        this.opsLog('extract invalid_body_422', `sessionId=${sessionId ?? 'unknown'} durationMs=${r.durationMs} retried=${attempt.isRetry}`)
        return null
      }

      if (r.kind === 'transport') {
        const isAbort = (r.err as { name?: string })?.name === 'AbortError'
        if (isAbort) this.stats.functionCallExternalTimeoutSkip += 1
        this.openBreaker(isAbort ? 'timeout' : 'transport')
        this.audit('warn', isAbort ? 'external.timeout_skip' : 'external.extract_failed', {
          callerId: this.caller.id,
          sessionId, durationMs: r.durationMs, thrown: true,
          error: (r.err as { message?: string })?.message ?? String(r.err),
        })
        this.opsLog(isAbort ? 'extract timeout_skip' : 'extract failed',
          `sessionId=${sessionId ?? 'unknown'} durationMs=${r.durationMs} thrown=true reason=${isAbort ? 'timeout' : 'transport'}`)
        return null
      }

      if (r.kind === 'http') {
        const code = r.code
        const isTimeoutProxy = code === 408 || code === 504
        const isLoading503 = code === 503 && r.body.includes('loading')
        const isRetryable503or502 = !isLoading503 && !isTimeoutProxy && (code === 503 || code === 502) && !attempt.isRetry

        if (isRetryable503or502) {
          this.audit('warn', 'external.extract_retry', {
            callerId: this.caller.id,
            sessionId, status: code, durationMs: r.durationMs,
            bodyPreview: r.body.slice(0, 80),
          })
          this.opsLog('extract retry', `sessionId=${sessionId ?? 'unknown'} status=${code} durationMs=${r.durationMs}`)
          continue
        }

        const reason = isTimeoutProxy ? 'timeout_proxy'
                     : code === 503 && r.body.includes('loading') ? '503_loading'
                     : code === 503 ? '503_busy'
                     : `http_${code}`
        if (isTimeoutProxy) this.stats.functionCallExternalTimeoutSkip += 1
        this.openBreaker(isTimeoutProxy ? 'timeout' : 'http_5xx')
        this.audit('warn', isTimeoutProxy ? 'external.timeout_skip' : 'external.extract_failed', {
          callerId: this.caller.id,
          sessionId, durationMs: r.durationMs, status: code, reason,
          retried: attempt.isRetry,
          bodyPreview: r.body.slice(0, 80),
        })
        this.opsLog(isTimeoutProxy ? 'extract timeout_skip' : 'extract failed',
          `sessionId=${sessionId ?? 'unknown'} durationMs=${r.durationMs} status=${code} reason=${reason} retried=${attempt.isRetry}`)
        return null
      }

      // r.kind === 'success'
      this.closeBreaker()
      this.audit('info', 'external.extract', {
        callerId: this.caller.id,
        sessionId, durationMs: r.durationMs, status: r.status,
        type: r.parsed.type, confidence: r.parsed.confidence,
        functionCallCount: r.parsed.calls.length,
        queryLen: query.length, schemaCount: schemas.length,
        retried: attempt.isRetry,
      })
      this.opsLog('extract',
        `sessionId=${sessionId ?? 'unknown'} durationMs=${r.durationMs} status=${r.status} type=${r.parsed.type} callCount=${r.parsed.calls.length} confidence=${r.parsed.confidence.toFixed(2)} retried=${attempt.isRetry}`)
      return r.parsed
    }
    return null
  }

  /** Single attempt:thin wrapper around caller.extract + AbortSignal composition. */
  private async attemptExtractOnce(
    query: string,
    schemas: ReadonlyArray<{ name: string; description: string; parameters: Record<string, unknown> }>,
    sessionId: string | undefined,
    upstreamSignal: AbortSignal | undefined,
  ): Promise<
    | { kind: 'success'; status: number; durationMs: number; parsed: {
        type: 'call' | 'respond'
        calls: ReadonlyArray<{ name: string; arguments: unknown }>
        confidence: number
        validation: { ungrounded: readonly string[] }
        raw: Record<string, unknown>
      } }
    | { kind: 'fatal_422'; durationMs: number; body: string }
    | { kind: 'http'; code: number; durationMs: number; body: string }
    | { kind: 'transport'; err: unknown; durationMs: number }
  > {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.functionCallExternalTimeoutMs)
    if (upstreamSignal) {
      if (upstreamSignal.aborted) controller.abort()
      else upstreamSignal.addEventListener('abort', () => controller.abort(), { once: true })
    }
    const start = Date.now()
    let res: Awaited<ReturnType<ExternalToolCaller['extract']>>
    try {
      res = await this.caller.extract({
        query,
        tools: schemas,
        system: buildDefaultSystemPrompt('zh-CN'),
        signal: controller.signal,
      })
    } catch (err: unknown) {
      clearTimeout(timer)
      const durationMs = Date.now() - start
      return { kind: 'transport', err, durationMs }
    }
    clearTimeout(timer)
    const durationMs = Date.now() - start
    this.stats.functionCallExternalLatencyMsTotal += durationMs
    if (res.ok) {
      return {
        kind: 'success',
        status: res.status,
        durationMs,
        parsed: this.parseExtractResponse((res.raw ?? {}) as Record<string, unknown>),
      }
    }
    if (res.status === 422) {
      return { kind: 'fatal_422', durationMs, body: res.body }
    }
    return { kind: 'http', code: res.status, durationMs, body: res.body }
  }

  /** Parse 200 response fields(API.md v1.1 §4.5 contract). */
  private parseExtractResponse(raw: Record<string, unknown>): {
    type: 'call' | 'respond'
    calls: ReadonlyArray<{ name: string; arguments: unknown }>
    confidence: number
    validation: { ungrounded: readonly string[] }
    raw: Record<string, unknown>
  } {
    const type = raw.type === 'call' || raw.type === 'respond' ? raw.type : 'respond'
    const confidence = typeof raw.confidence === 'number' ? raw.confidence : 0
    const validation = (raw.validation && typeof raw.validation === 'object')
      ? raw.validation as Record<string, unknown>
      : {}
    const ungrounded = Array.isArray(validation.ungrounded)
      ? validation.ungrounded.filter((x): x is string => typeof x === 'string')
      : []
    const callsRaw = Array.isArray(raw.function_calls) ? raw.function_calls : []
    const calls = callsRaw
      .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
      .map(c => ({
        name: typeof c.name === 'string' ? c.name : '',
        arguments: c.arguments,
      }))
    return { type, calls, confidence, validation: { ungrounded }, raw }
  }

  // ── synthesis context builder ────────────────────────────────────────

  private buildSynthesisContext(
    originalQuery: string,
    calls: ReadonlyArray<{ name: string; arguments: unknown }>,
    outcomes: ReadonlyArray<{ status: string; name: string; text?: string; reason?: string }>,
  ): string {
    const lines: string[] = []
    lines.push('[System — function-call-external pre-execution summary]')
    lines.push('The following tool calls were already executed. Do NOT call them again. Answer the user directly based on these results.')
    lines.push('')
    // ── §7.96 Track B: synthesis few-shot + clarification rules ────────
    // 教 LOCAL LLM 在 needle 抽错工具/漏抽参数时如何合成更智能的回复。
    // 关键原则:**澄清优先于猜测** — 当工具结果与用户意图不匹配时,
    // 优先向用户澄清,而非盲目传回错误结果。
    lines.push('### 澄清规则(Clarification rules)')
    lines.push('1. 若某个 tool 被 SKIPPED(参数缺失),向用户请求缺少的参数,不要自己猜。')
    lines.push('2. 若某个 tool 已执行但结果与用户 query 明显不匹配(如用户问账户却拿到登录状态),')
    lines.push('   不要盲传结果 — 向用户澄清他们想做什么。')
    lines.push('3. 优先使用「是 X 还是 Y?」形式,而不是「请告诉我 X」,给用户选择比索要信息更易回答。')
    lines.push('4. 中文 query 用中文回复,英文 query 用英文回复。')
    lines.push('')
    lines.push('### 例:工具 SKIPPED 缺参数 → 请求澄清')
    lines.push('User: "切换到 office profile"')
    lines.push('Tool result: etscli_auth_switch() → SKIPPED: missing required argument(s): name')
    lines.push('Good response: "您想切到哪个 profile?常见的有:office、home、work。"')
    lines.push('')
    lines.push('### 例:工具错选(auth_list vs user_list)→ 澄清')
    lines.push('User: "把设备上的账户都列一下"')
    lines.push('Tool result: etscli_auth_list() → 返回 3 个 login profile 列表')
    lines.push('Good response: "设备上有 3 个登录 profile 已列出。您是想看设备上的用户账户,还是登录 profile?"')
    lines.push('  如果是用户账户,我可以用 user-list 查询。"')
    lines.push('')
    lines.push('### 例:工具错选(auth_switch vs fs_stat)→ 澄清')
    lines.push('User: "切换到 /tmp 目录"')
    lines.push('Tool result: etscli_auth_switch(name="/tmp") → 错误:没有叫 /tmp 的 profile')
    lines.push('Good response: "/tmp 不是 profile 名,看起来您想切工作目录。需要我用 bash 工具 `cd /tmp` 吗?"')
    lines.push('')
    lines.push('### 例:多工具部分失败 → 传成功的,为失败的澄清')
    lines.push('User: "创建会议并分享链接"')
    lines.push('Tool results:')
    lines.push('  - etscli_meeting_create(name="sync") → meeting_id=123 已创建')
    lines.push('  - etscli_sharing_create() → SKIPPED: missing required argument(s): file_id')
    lines.push('Good response: "会议 sync 已创建(id=123)。分享链接需要指定文件 — 您要分享哪个文件?"')
    lines.push('')
    lines.push('---')
    lines.push('')
    lines.push(`Original query: ${originalQuery}`)
    lines.push('')
    for (let i = 0; i < outcomes.length; i++) {
      const o = outcomes[i]
      const call = calls[i]
      const argStr = call ? this.safeArgSummary(call.arguments) : ''
      if (o.status === 'executed') {
        lines.push(`- ${o.name}(${argStr}) → ${o.text ?? '(no text content)'}`)
      } else if (o.status === 'skipped') {
        lines.push(`- ${o.name}(${argStr}) → SKIPPED: ${o.reason ?? 'fabricated required argument'}`)
      } else if (o.status === 'denied') {
        lines.push(`- ${o.name}(${argStr}) → DENIED: ${o.reason ?? 'realm/precheck'}`)
      } else if (o.status === 'error') {
        lines.push(`- ${o.name}(${argStr}) → ERROR: ${o.reason ?? 'execution failed'}`)
      } else {
        lines.push(`- ${o.name}(${argStr}) → unknown status=${o.status}`)
      }
    }
    return lines.join('\n')
  }

  private safeArgSummary(args: unknown): string {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return ''
    return Object.entries(args as Record<string, unknown>)
      .map(([k, v]) => {
        const t = Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v
        return `${k}:${t}`
      })
      .join(', ')
  }

  // ── Phase 5 主路径:agent/pre-step listener ──────────────────────────

  /**
   * agent/pre-step waterfall listener. **总是 await next() FIRST** ——
   * 让我们(plugin)在 chain 中是 input-guard 的外层,input-guard 的
   * classify + setSessionRealm 完成后才返回到这里,我们才看得到本 turn
   * 的 realm。决策树(全 fail-open,永不 throw):
   *
   *   await next()
   *   ├─ decision.kind === 'reject'      → 透传(input-guard 已拒)
   *   ├─ !isAvailable()                  → 透传(总开关关 / breaker 开)
   *   ├─ sessionId 缺失                → 透传
   *   ├─ realm 未注册 / 非 LOCAL|SANITIZED → 透传
   *   ├─ 用户最后一条文本为空           → 透传
   *   ├─ getToolSchemasForExternal 空  → 透传
   *   ├─ caller.extract 失败(非 retryable)→ 透传
   *   ├─ adopt gate 未过                  → 透传
   *   ├─ createToolRunner undefined      → 透传
   *   ├─ outcomes ≥1 executed           → 注入 user-role synthesis message
   *   └─ 全 denied/skipped/error          → 透传(0 executed 不污染)
   *
   * 整个 body 包 try/catch,decision 提到 try 外:catch 拿到 decision → 透传
   * (不污染 cordis dispatch);catch 没 decision(await next() 自身抛)→ 重抛
   * (让上层处理真基础设施错)。
   */
  async handlePreStep(
    payload: {
      agent?: { session?: { id?: string } & Record<string, unknown> } & Record<string, unknown>
      messages: ReadonlyArray<Record<string, unknown>>
      step?: number
      signal?: AbortSignal
    },
    next: () => Promise<PreStepDecisionShape>,
  ): Promise<PreStepDecisionShape> {
    let decision: PreStepDecisionShape | undefined
    try {
      decision = await next()
      if (decision.kind === 'reject') return decision
      if (!this.isAvailable()) {
        if (this.functionCallExternalEnabled && Date.now() < this.functionCallExternalBreakerOpenUntil) {
          this.stats.functionCallExternalCircuitSkip += 1
          this.audit('info', 'external.circuit_open_skip', {
            callerId: this.caller.id,
            sessionId: payload.agent?.session?.id,
            url: this.functionCallExternalUrl,
            openUntilMs: this.functionCallExternalBreakerOpenUntil,
            remainingMs: this.functionCallExternalBreakerOpenUntil - Date.now(),
          })
          this.opsLog('circuit open skip',
            `sessionId=${payload.agent?.session?.id ?? 'unknown'} remainingMs=${this.functionCallExternalBreakerOpenUntil - Date.now()}`)
        }
        return decision
      }
      const sessionId = payload.agent?.session?.id
      if (!sessionId) return decision
      const bridge = this.bridge()
      if (!bridge?.getSessionRealm || !bridge?.getToolSchemasForExternal) return decision
      const realm = bridge.getSessionRealm(sessionId)
      if (realm !== 'LOCAL' && realm !== 'SANITIZED') {
        this.stats.functionCallExternalRealmUnsetSkip += 1
        return decision
      }
      const lastUser = this.findLastUserText(payload.messages)
      if (!lastUser || !lastUser.text.trim()) return decision

      const schemas = bridge.getToolSchemasForExternal(realm)
      if (schemas.length === 0) return decision
      const extract = await this.extractCalls(lastUser.text, schemas, sessionId, payload.signal)
      if (!extract) return decision

      if (extract.type !== 'call' || extract.calls.length === 0
          || extract.confidence < this.functionCallExternalConfidenceThreshold) {
        this.stats.functionCallExternalLowConfSkip += 1
        this.audit('info', 'external.low_confidence_skip', {
          callerId: this.caller.id,
          sessionId,
          type: extract.type,
          callCount: extract.calls.length,
          confidence: extract.confidence,
          threshold: this.functionCallExternalConfidenceThreshold,
        })
        this.opsLog('low confidence skip',
          `sessionId=${sessionId ?? 'unknown'} type=${extract.type} callCount=${extract.calls.length} confidence=${extract.confidence.toFixed(2)} threshold=${this.functionCallExternalConfidenceThreshold}`)
        return decision
      }
      this.stats.functionCallExternalExtractOk += 1

      const runner = this.createToolRunner()
      if (!runner) return decision
      const outcomes = await runner.executeAll(extract.calls, {
        agent: payload.agent,
        sessionId,
        schemas,
        ungrounded: extract.validation.ungrounded,
        signal: payload.signal,
      })
      const executedCount = outcomes.filter(o => o.status === 'executed').length
      this.stats.functionCallExternalExecuted += executedCount
      this.stats.functionCallExternalErrors += outcomes.filter(o => o.status === 'error').length

      if (executedCount === 0) return decision

      const text = this.buildSynthesisContext(lastUser.text, extract.calls, outcomes)
      const injected = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      })
      const baseMessages = decision.messages ?? payload.messages
      this.stats.functionCallExternalSynthesisInjected += 1
      this.audit('info', 'external.synthesis_injected', {
        callerId: this.caller.id,
        sessionId,
        toolCount: outcomes.length,
        executedCount,
        skippedCount: outcomes.filter(o => o.status === 'skipped').length,
        deniedCount: outcomes.filter(o => o.status === 'denied').length,
        errorCount: outcomes.filter(o => o.status === 'error').length,
        originalQueryLen: lastUser.text.length,
        messageLen: text.length,
      })
      this.opsLog('synthesis injected',
        `sessionId=${sessionId ?? 'unknown'} toolCount=${outcomes.length}` +
        ` executedCount=${executedCount} skippedCount=${outcomes.filter(o => o.status === 'skipped').length}` +
        ` deniedCount=${outcomes.filter(o => o.status === 'denied').length}` +
        ` errorCount=${outcomes.filter(o => o.status === 'error').length}` +
        ` messageLen=${text.length}`)
      return {
        ...decision,
        messages: [...baseMessages, injected],
      }
    } catch (err: unknown) {
      this.audit('error', 'external.listener.error', {
        callerId: this.caller?.id ?? 'unknown',
        sessionId: payload.agent?.session?.id,
        error: (err as { message?: string })?.message ?? String(err),
        hadDecision: decision !== undefined,
      })
      this.opsLog('handlePreStep error',
        `${(err as { message?: string })?.message ?? String(err)} hadDecision=${decision !== undefined}`)
      if (decision !== undefined) return decision
      throw err
    }
  }

  /** Last user-role text message(沿用 input-guard.findLastUserText 模式)。 */
  private findLastUserText(
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
}

/** Module augmentation: expose the service on ctx. */
declare module '@deepseek-ai/cordis' {
  interface Context {
    functionCallExternal: FunctionCallExternalServiceImpl
  }
}

export async function apply(ctx: Context, config: Config): Promise<() => Promise<void>> {
  // §7.102: the external-caller knobs come from config/edge.json
  // (functionCallExternal.*). The cordis patch row no longer reads
  // process.env — the desktop GUI never had those variables.
  //
  // Precedence: explicit cordis value > config/edge.json > the literal
  // fallback in FunctionCallExternalServiceImpl. The Config schema carries
  // no defaults on purpose (see the Config schema comment), so a field left
  // unset by the patch row stays `undefined` here and the file can fill it.
  const fce = loadEdgeConfig().functionCallExternal
  if (fce) {
    const c = config as Record<string, unknown>
    const fill = (key: string, value: unknown): void => {
      if (value !== undefined && c[key] === undefined) c[key] = value
    }
    fill('functionCallExternalEnabled', fce.enabled)
    fill('functionCallExternalUrl', fce.url)
    fill('functionCallExternalTimeoutMs', fce.timeoutMs)
    fill('functionCallExternalConfidenceThreshold', fce.confidenceThreshold)
    fill('functionCallExternalBreakerTtlMs', fce.breakerTtlMs)
    fill('functionCallExternalBootProbeEnabled', fce.bootProbeEnabled)
    fill('functionCallExternalBootProbeTimeoutMs', fce.bootProbeTimeoutMs)
    fill('functionCallExternalBreakerProbeMs', fce.breakerProbeMs)
    fill('functionCallExternalProbeTimeoutMs', fce.probeTimeoutMs)
  }
  const auditLog = (ctx as unknown as { auditLog?: AuditLike }).auditLog
  const service = new FunctionCallExternalServiceImpl(ctx, config, auditLog)
  // §7.46 ops-log-coverage-principle:boot 关键节点一行(metadata only,
  // url/enabled 是配置不是 PII)。运维排查"为什么没生效"第一眼看这行。
  try {
    ctx.logger?.info?.(
      `[function-call-external] boot enabled=${service.isAvailable()} url=${config.functionCallExternalUrl ?? 'http://127.0.0.1:8081'}` +
      ` timeoutMs=${config.functionCallExternalTimeoutMs ?? 10000} threshold=${config.functionCallExternalConfidenceThreshold ?? 0.5}`,
    )
  } catch { /* debug only */ }
  service.start()

  // ── Phase 5:agent/pre-step waterfall listener ──
  // **必须早于 input-guard apply**(cordis.patch.yml - insert: 数组里
  // function-call-external 在前)—— cordis waterfall 注册顺序 = 执行顺序;
  // 我们的 `await next()` 串到 input-guard,等 input-guard 的 classify +
  // setSessionRealm 完成后才返回给我们,我们才看得到本 turn 的 realm。
  // §7.93.1 §7.93 file header 里有详细分析。
  const on = (ctx as unknown as { on?: <T extends (...args: any[]) => any>(event: string, handler: T, opts?: Record<string, unknown>) => () => void }).on
  const disposers: Array<() => void> = []
  if (on) {
    const d1 = on('agent/pre-step', async (payload: any, next: any) => {
      return service.handlePreStep(payload, next)
    }, { global: true })
    void auditLog?.log?.({
      level: 'info',
      kind: 'external.hook.registered',
      source: 'function-call-external',
      payload: { event: 'agent/pre-step', global: true, disposerReturned: typeof d1 === 'function' },
    })
    if (typeof d1 === 'function') disposers.push(d1)
  } else {
    void auditLog?.log?.({
      level: 'warn',
      kind: 'external.hook.skipped',
      source: 'function-call-external',
      payload: { reason: 'ctx.on unavailable — listener not registered; external will be a no-op' },
    })
  }

  return async () => {
    for (const d of disposers) {
      try { d() } catch { /* debug only */ }
    }
    await service.stop()
  }
}
