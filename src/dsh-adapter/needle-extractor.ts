/**
 * needle-extractor — §7.93:cactus-needle 3.0.1 作为 LOCAL LLM 的 tool-call
 * prefill(解决 §7.42 P0-1 minicpm5-2b malformed tool-call)。
 *
 * **Phase 4 = 骨架**:config schema + audit 面 + stats + ToolRunner 装配。
 * **Phase 5 = waterfall listener**:agent/pre-step 上挂全局监听器,gates →
 * realmSkillBridge.getToolSchemasForNeedle → POST /extract(user 原文直入,
 * 不翻译,不管什么语言)→ adopt gate → ToolRunner.executeAll → 合成
 * user-role message 注入 decision.messages → 让 LOCAL LLM 只做 chat
 * synthesis(§7.42 P0-1 malformed guard 留作 fallback)。
 *
 * 后续 Phase:
 *   - Phase 7:失败路径细分(422 不重试 / 503 busy 退避 / 503 loading 走
 *     breaker / 502 降级)。
 *
 * 服务边界(user 终裁,needle-extractor-integration memory):
 *   - needle 服务端只提取,**不翻译不执行**(P1 中文数字归一化是服务端内置
 *     cn_grounding.py,client 不管语种直接 POST query);执行走 tool-runner →
 *     ctx.tools.execute(realm/PII/audit 零绕过);最终整段对话给 LOCAL
 *     LLM 合成回复。
 *   - 一切失败(needle down / 超时 / 低置信 / 空 schemas / 0 executed)
 *     fall through 到 LLM 自提取路径(§7.42 P0-1 patch 保留,是 fallback
 *     不是被替代者)。
 *   - CLOUD intent 跳过 needle(云端 LLM 自带 native tool calling);REJECT
 *     intent input-guard 已拒、我们看不到 realm;undefined realm 跳过
 *     (稳健于启动时序:即使 apply 顺序出错也不会 crash,只是不优化)。
 *
 * **注入约束**(从 §7.93 Phase 4.5 + Phase 5 探索得到的关键修正,原计划
 * 草稿错误已纠正):
 *   1. `agent/request` waterfall 只携带 config(provider/model/reasoningEffort/
 *      maxTokens),**没有 messages** —— 原计划"agent/request payload.messages
 *      注入"在架构上不可能。注入真实点在 `agent/pre-step`(line 506 of
 *      dsh-agent-loop/lib/index.js:decision.messages → appended as
 *      user/message events → deriveMessages → request)。
 *   2. assembly.tools 在 pre-step 之前就由 systemPrompt.assemble 锁死
 *      (line 502);pre-step listener 拿不到改 tools 的钩子 —— 即使能
 *      改也可能弄坏 host schema。LLM 仍看到 tools,可能再 call。
 *      **接受这个**：合成 prompt 强指令"工具已执行,请勿再调用,直接
 *      综合结果合成" + 现有 §7.42 P0-1 patch + Layer 3 realm gate 兜底。
 *   3. decision.messages 全部以 user/message 事件 append(loop line 559),
 *      assistant tool_call role 注入在该 hook 不可达。**只追加 user-role
 *      message**(createUserMessage + 文本描述执行结果)。
 *   4. **插件 apply 顺序**:needle-extractor 必须在 input-guard **之前**
 *      apply(cordis.patch.yml - insert: 数组里 needle-extractor 在前)——
 *      cordis waterfall 注册顺序 = 执行顺序;needle 的 `await next()` 串到
 *      input-guard,input-guard classify + setSessionRealm 完成后才返回
 *      给 needle,needle 才看得到本 turn 的 realm(否则 needle 读到上一
 *      turn 的旧 realm 或 undefined,触发 CLOUD/REJECT 跳过路径)。
 *
 * audit 面(source 区分归属):
 *   本插件(source='needle-extractor'):
 *     needle.hook.registered         (info,apply 时一次性)
 *     needle.boot_probe              (info/warn,Phase 6 boot probe)
 *     needle.boot_probe.skipped      (info,配置关掉 boot probe)
 *     needle.boot_probe.unexpected   (error,probe 自己抛)
 *     needle.probe                   (info,Phase 6 周期 probe)
 *     needle.circuit_open            (warn,Phase 6,open-on-first-failure 触发)
 *     needle.circuit_open_skip       (info,Gate 2 短路计数)
 *     needle.recovered               (info,周期 probe 命中 2xx 关 breaker)
 *     needle.extract                 (info,每次 /extract 调用 metadata)
 *     needle.low_confidence_skip     (info,采纳门未过)
 *     needle.timeout_skip            (warn,extract 超时;同时触发 openBreaker)
 *     needle.extract_failed          (warn,4xx(不开)/5xx(开 breaker)/网络错(开))
 *     needle.synthesis_injected      (info,合成 user-role 已注入)
 *     needle.realm_unset_skip        (info,realm 未注册跳过)
 *     needle.listener.error          (error,handlePreStep 自身 catch 兜底)
 *   tool-runner(source='tool-runner',Phase 3 已实现):
 *     needle.executed / needle.execution_failed / needle.realm_rejected /
 *     needle.fabricated_arg / needle.unknown_tool
 *   ⚠️ audit-log minLevel 会静默 drop 'debug'(memory:audit-log-minlevel-
 *   drop)—— 以上全部用 info 起步,运维必须看得见。
 *   ⚠️ PII 纪律:audit payload 只落 metadata(长度/计数/名字/延迟),
 *   绝不落 query/arguments/result 内容。
 *
 * inject(§7.92.2 proxy trap:读 ctx.X 前必须先列 inject):
 *   - auditLog          审计
 *   - realmSkillBridge  getToolSchemasForNeedle + getSessionRealm
 *   - tools             宿主 ToolRuntime,ToolRunner 的执行面
 *   (原计划草稿里的 llm + privacyPolicy 已去掉:不依赖翻译 → 不读
 *   llm;不读 categories,intent 判定归 intent-router,needle 只在 verdict
 *   之后工作。)
 *
 * @module dsh-edge-agent/needle-extractor
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { ToolRunner } from './tool-runner.js'

export const name = 'needle-extractor'

export const inject = ['auditLog', 'realmSkillBridge', 'tools'] as const

/** Minimal interface for the audit-log service (same shape as intent-router). */
interface AuditLike {
  log(entry: { level: 'debug' | 'info' | 'warn' | 'error' | 'security'; kind: string; source: string; payload: Record<string, unknown> }): Promise<unknown>
}

/** Phase 5 TypeScript-loose re-shape of PreStepDecision(dynamic import avoidance)。 */
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
  needleEnabled?: boolean
  /** needle-http 服务基址(API.md v1.1:GET /health + POST /extract;
   *  stateless,无需 /reset)。playground :7860 是 needle webui,本项目不走。 */
  needleUrl?: string
  /** 单次 POST /extract 超时(ms)。实测 376-548ms → 1500ms 有 3x 余量;
   *  超时 fall through 到 LLM 自提取(needleTimeoutSkip)。 */
  needleTimeoutMs?: number
  /** 采纳阈值:confidence < 此值 → fall through(实测 conf=0.99 也可能
   *  幻觉,threshold 不救翻译问题,但挡低置信噪声)。 */
  needleConfidenceThreshold?: number
  /** breaker 打开后的 TTL(ms);期间 classify 跳过 needle 直走 LLM,
   *  省 needleTimeoutMs 的 worst-case wall-clock(§7.92.6 同款)。 */
  needleBreakerTtlMs?: number
  /** Phase 6:apply() 时 fire-and-forget GET /health;fail → 预开
   *  breaker,首次请求零 wall-clock penalty(§7.92.7 同款)。 */
  needleBootProbeEnabled?: boolean
  /** boot probe 超时(ms)。/health 暖机中回 503 = down。 */
  needleBootProbeTimeoutMs?: number
  /** breaker 打开期间的周期恢复 probe 间隔(ms)。 */
  needleBreakerProbeMs?: number
  /** 周期 probe 超时(ms)。 */
  needleProbeTimeoutMs?: number
}

export const Config: Schema<Config> = Schema.object({
  needleEnabled: Schema.boolean().default(false),
  needleUrl: Schema.string().default('http://127.0.0.1:8081'),
  // 实测 /extract 376-548ms(API.md §7);1.5s ≈ 3x P95 余量,又显著小于
  // LLM 自提取的 2-6s —— 超时了 fall through 也比等 needle 划算的上限。
  needleTimeoutMs: Schema.natural().default(1500),
  needleConfidenceThreshold: Schema.number().min(0).max(1).default(0.7),
  needleBreakerTtlMs: Schema.natural().default(30000),
  needleBootProbeEnabled: Schema.boolean().default(true),
  needleBootProbeTimeoutMs: Schema.natural().default(2000),
  needleBreakerProbeMs: Schema.natural().default(5000),
  needleProbeTimeoutMs: Schema.natural().default(1000),
})

/** In-memory counters exposed via getStats(). Pure observability. */
export interface NeedleExtractorStats {
  /** 配置快照:总开关(运维排查"为什么没走 needle"第一问)。 */
  needleEnabled: boolean
  /** Phase 6:boot probe 成功/失败(失败 = breaker 预开)。 */
  needleBootProbeOk: number
  needleBootProbeFail: number
  /** Phase 6:周期 probe 尝试/恢复(breaker 关闭)次数。 */
  needleProbeAttempts: number
  needleRecoveredProbe: number
  /** Phase 6:breaker 当前是否打开(getStats 时快照)。 */
  needleCircuitOpen: boolean
  /** Phase 5/6:因 breaker 打开跳过 needle 的请求数。 */
  needleCircuitSkip: number
  /** Phase 5:realm 未注册(undefined)跳过 + 非 LOCAL/SANITIZED 跳过。 */
  needleRealmUnsetSkip: number
  /** Phase 5:/extract 调用数 / 成功采纳数 / 低置信跳过 / 超时跳过。 */
  needleExtractCalls: number
  needleExtractOk: number
  needleLowConfSkip: number
  needleTimeoutSkip: number
  /** Phase 5:ToolRunner 汇总(needle.executed / denied / skipped / errors
   *  是 tool-runner 自己的 audit;这里只记 executedCount 用于合成 gate)。 */
  needleExecuted: number
  needleErrors: number
  /** Phase 5:≥1 executed → 注入合成 message 的次数。 */
  needleSynthesisInjected: number
  /** /extract 累计延迟(取驱动决策的响应,均值 = total/calls)。 */
  needleLatencyMsTotal: number
}

// ── helpers(纯函数,可单测)────────────────────────────────────────────

/**
 * 在 messages 数组里从后往前找**最近一条 user-role 且有文本**的消息。
 * 拷贝自 input-guard.findLastUserText(同款 §7.93 协作语义)。
 *
 * decision.messages 可能含 dsh-agent-instructions 注入的 user-role
 * 上下文,要查的是**原始 payload.messages** 里真用户的最后一条。
 */
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

// ── Service ────────────────────────────────────────────────────────────

export class NeedleExtractorServiceImpl extends Service {
  private readonly auditLog: AuditLike | undefined
  private readonly needleEnabled: boolean
  private readonly needleUrl: string
  private readonly needleTimeoutMs: number
  private readonly needleConfidenceThreshold: number
  private readonly needleBreakerTtlMs: number
  private readonly needleBootProbeEnabled: boolean
  private readonly needleBootProbeTimeoutMs: number
  private readonly needleBreakerProbeMs: number
  private readonly needleProbeTimeoutMs: number

  // ── Phase 6 runtime state:circuit breaker + boot probe + recovery probe ──
  /** §7.92.6 (2026-09-24): ms-epoch timestamp until which the breaker is
   *  open. 0 = closed. Mutable; reset on every successful extract /
   *  periodic /health probe.needle 引擎当前 degradation 25x(dry-run #1)
   *  → timeout 必须计入 breaker 失败 → open-on-first-failure 模式。 */
  private needleBreakerOpenUntil = 0
  /** §7.92.7: setInterval handle for the periodic recovery probe. null =
   *  no timer running(breaker closed 或 probe disabled)。 */
  private needleBreakerProbeTimer: ReturnType<typeof setInterval> | null = null
  /** §7.92.7: in-flight boot probe promise。track 让 stop() / dispose
   *  能 await 而不留下 dangling fetch racing constructor's first
   *  classify() call。 */
  private needleBootProbePromise: Promise<void> | null = null
  /** §7.92.7 helper:最近一次 periodic probe wall-clock,audit
   *  needle.recovered payload 用。 */
  private needleLastProbeLatencyMs = 0

  private readonly stats: NeedleExtractorStats

  constructor(ctx: Context, config: Config, auditLog?: AuditLike) {
    super(ctx, 'needleExtractor')
    this.auditLog = auditLog
    this.needleEnabled = config.needleEnabled ?? false
    this.needleUrl = config.needleUrl ?? 'http://127.0.0.1:8081'
    this.needleTimeoutMs = config.needleTimeoutMs ?? 1500
    this.needleConfidenceThreshold = config.needleConfidenceThreshold ?? 0.7
    this.needleBreakerTtlMs = config.needleBreakerTtlMs ?? 30000
    this.needleBootProbeEnabled = config.needleBootProbeEnabled ?? true
    this.needleBootProbeTimeoutMs = config.needleBootProbeTimeoutMs ?? 2000
    this.needleBreakerProbeMs = config.needleBreakerProbeMs ?? 5000
    this.needleProbeTimeoutMs = config.needleProbeTimeoutMs ?? 1000

    this.stats = {
      needleEnabled: this.needleEnabled,
      needleBootProbeOk: 0,
      needleBootProbeFail: 0,
      needleProbeAttempts: 0,
      needleRecoveredProbe: 0,
      needleCircuitOpen: false,
      needleCircuitSkip: 0,
      needleRealmUnsetSkip: 0,
      needleExtractCalls: 0,
      needleExtractOk: 0,
      needleLowConfSkip: 0,
      needleTimeoutSkip: 0,
      needleExecuted: 0,
      needleErrors: 0,
      needleSynthesisInjected: 0,
      needleLatencyMsTotal: 0,
    }
  }

  // ── availability ──────────────────────────────────────────────────────

  /**
   * §7.92.6 (2026-09-24):breaker-aware availability。
   *  - Phase 4 语义:needleEnabled。
   *  - Phase 6 叠加:`needleEnabled && Date.now() >= needleBreakerOpenUntil`
   *    (jev `isJevAvailable()` 同款语义)。Phase 5 listener Gate 2
   *    `if (!isAvailable()) return decision` 因此**自动**承担
   *    breaker-open short-circuit:0ms 短路,不付出 extract 1.5s 超时。
   *    audit `needle.circuit_open_skip` 由 Gate 2 显式落(见 handlePreStep)。
   */
  isAvailable(): boolean {
    return this.needleEnabled && Date.now() >= this.needleBreakerOpenUntil
  }

  /** 配置只读视图(ops 排查 + 测试断言;env 翻译层是否生效一眼可见)。 */
  getConfigView(): Readonly<{
    needleEnabled: boolean
    needleUrl: string
    needleTimeoutMs: number
    needleConfidenceThreshold: number
    needleBreakerTtlMs: number
    needleBootProbeEnabled: boolean
    needleBootProbeTimeoutMs: number
    needleBreakerProbeMs: number
    needleProbeTimeoutMs: number
  }> {
    return {
      needleEnabled: this.needleEnabled,
      needleUrl: this.needleUrl,
      needleTimeoutMs: this.needleTimeoutMs,
      needleConfidenceThreshold: this.needleConfidenceThreshold,
      needleBreakerTtlMs: this.needleBreakerTtlMs,
      needleBootProbeEnabled: this.needleBootProbeEnabled,
      needleBootProbeTimeoutMs: this.needleBootProbeTimeoutMs,
      needleBreakerProbeMs: this.needleBreakerProbeMs,
      needleProbeTimeoutMs: this.needleProbeTimeoutMs,
    }
  }

  getStats(): NeedleExtractorStats {
    // §7.92.6:needleCircuitOpen 在 snapshot 时即时计算(布尔 = 当前
    // breaker 是否打开);其他字段从 this.stats 浅拷。
    return {
      ...this.stats,
      needleCircuitOpen: Date.now() < this.needleBreakerOpenUntil,
    }
  }

  // ── lifecycle(Phase 6 填实:boot probe + 周期恢复 probe)──────────────

  /**
   * §7.92.7 (2026-09-24):fire-and-forget GET /health。fail → 预开
   * breaker(节省第一请求的 worst-case wall-clock = needleTimeoutMs);
   * 顺手启动周期恢复 probe,免得 needle 上线时还要等满 TTL。**总是
   * 返回 void**:probe 是 fire-and-forget,不让 apply() / cordis 等它。
   *
   * 模板直接抄自 intent-router.start() §7.92.7 jev。
   */
  start(): void {
    if (!this.needleEnabled) return
    if (!this.needleBootProbeEnabled) {
      this.audit('info', 'needle.boot_probe.skipped', {
        reason: 'disabled-by-config',
        needleUrl: this.needleUrl,
      })
      return
    }
    // Capture promise so stop() can await it on shutdown.
    this.needleBootProbePromise = this.probeNeedleHealth('boot', this.needleBootProbeTimeoutMs)
      .then((ok) => {
        if (!ok) {
          // Pre-open breaker AND start periodic recovery probe. 不然 needle
          // 上线时(boot 后 30s TTL 内)还要等满 TTL 才恢复 — 周期 probe
          // 命中 2xx 就会关掉断并 stop 自己,recovery 比通常延迟更短。
          this.openBreaker('transport')
        }
      })
      .catch((err: unknown) => {
        // Defensive — `probeNeedleHealth` swallows transport errors and
        // resolves false; reaching this branch means a bug in the probe
        // itself. Log and keep the breaker closed (fail-open for the
        // probe path)。
        this.audit('error', 'needle.boot_probe.unexpected', {
          error: (err as { message?: string })?.message ?? String(err),
        })
      })
      .finally(() => {
        this.needleBootProbePromise = null
      })
  }

  /**
   * §7.92.7 dispose hook。await boot probe(若有)+ 清周期 interval。
   * cordis / tests 在 plugin teardown 时调用。
   */
  async stop(): Promise<void> {
    this.stopBreakerProbe()
    if (this.needleBootProbePromise) {
      try { await this.needleBootProbePromise } catch { /* swallow */ }
    }
  }

  // ── §7.92.6/§7.92.7 breaker + probe 内部 ─────────────────────────────

  /**
   * §7.92.7:probe needle /health(GET)。returns true on HTTP 2xx,
   * false on anything else(网络错 / timeout / non-2xx)。always resolves
   * — never throws。`phase` 区分 boot vs periodic 让 audit kind 区分
   * (运维一眼能看出来 "boot 探 vs 周期探")。
   *
   * 与 jev 的 `probeJevHealth` 完全同构,只是 URL 走 needle 的
   * `${needleUrl}/health`(API.md v1.1 §4)。
   */
  private async probeNeedleHealth(
    phase: 'boot' | 'periodic',
    timeoutMs: number,
  ): Promise<boolean> {
    if (phase === 'periodic') this.stats.needleProbeAttempts++
    const probeStart = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let ok = false
    let httpStatus = 0
    let errorMsg = ''
    try {
      const fetcher = this.fetcher()
      if (!fetcher) {
        errorMsg = 'no_fetch_runtime'
      } else {
        const r = await fetcher(`${this.needleUrl}/health`, {
          method: 'GET',
          signal: controller.signal,
        })
        httpStatus = r.status
        ok = r.ok
        if (!ok) {
          try { await r.text() } catch { /* ignore */ }
        }
      }
    } catch (err: unknown) {
      errorMsg = (err as { message?: string })?.message ?? String(err)
    } finally {
      clearTimeout(timer)
    }
    const latencyMs = Date.now() - probeStart
    if (phase === 'boot') {
      if (ok) {
        this.stats.needleBootProbeOk++
        this.audit('info', 'needle.boot_probe', {
          needleUrl: this.needleUrl,
          httpStatus,
          latencyMs,
          ok: true,
        })
      } else {
        this.stats.needleBootProbeFail++
        this.audit('warn', 'needle.boot_probe', {
          needleUrl: this.needleUrl,
          httpStatus,
          latencyMs,
          ok: false,
          error: errorMsg,
        })
      }
    } else {
      // periodic probe (always inside an open-breaker window)
      this.needleLastProbeLatencyMs = latencyMs
      this.audit('info', 'needle.probe', {
        needleUrl: this.needleUrl,
        httpStatus,
        latencyMs,
        ok,
        error: ok ? undefined : errorMsg,
      })
    }
    return ok
  }

  /**
   * §7.92.7:启动周期 recovery probe。**idempotent** —— 已运行时返回。
   * unref 让 timer 不会独自撑住 process(file-logger.ts:220 同款)。
   *
   * setInterval 回调捕获 probeStart 但不清晰上浮 ——
   * needleLastProbeLatencyMs 实例字段辅助 audit 携带。
   */
  private startBreakerProbe(): void {
    if (this.needleBreakerProbeTimer !== null) return // already running
    this.needleBreakerProbeTimer = setInterval(() => {
      void this.probeNeedleHealth('periodic', this.needleProbeTimeoutMs)
        .then((ok) => {
          if (!ok) return
          // 2xx from /health → needle is back. Close breaker
          // and stop the timer.classify() calls now hit needle
          // normally; one of them may still trip the breaker
          // again if /extract is broken, but the breaker-restart
          // path is already covered by extractCalls()'s openBreaker
          // call.
          if (Date.now() < this.needleBreakerOpenUntil) {
            this.needleBreakerOpenUntil = 0
            this.stats.needleRecoveredProbe++
            this.audit('info', 'needle.recovered', {
              needleUrl: this.needleUrl,
              probeLatencyMs: this.needleLastProbeLatencyMs,
            })
          }
          this.stopBreakerProbe()
        })
        .catch(() => { /* probeNeedleHealth never throws; defensive */ })
    }, this.needleBreakerProbeMs)
    if (typeof this.needleBreakerProbeTimer.unref === 'function') {
      this.needleBreakerProbeTimer.unref()
    }
  }

  /** §7.92.7:clear the recovery probe setInterval。idempotent。 */
  private stopBreakerProbe(): void {
    if (this.needleBreakerProbeTimer === null) return
    clearInterval(this.needleBreakerProbeTimer)
    this.needleBreakerProbeTimer = null
  }

  /**
   * §7.92.6 (2026-09-24):open-on-first-failure 模式(jev 是 all-batches
   * 失败才开 —— needle 单 fetch 等价于"这一发失败")。**timeout 与 5xx 都
   * 计入**(dry-run #1:engine 当前 degradation 25x,1.5s 超时全中)。
   * 4xx(client error 比如 422 invalid body)不开 —— 不代表 engine down。
   * idempotent:已开则 no-op。
   */
  private openBreaker(reason: 'timeout' | 'http_5xx' | 'transport'): void {
    if (Date.now() < this.needleBreakerOpenUntil) return // already open
    this.needleBreakerOpenUntil = Date.now() + this.needleBreakerTtlMs
    this.audit('warn', 'needle.circuit_open', {
      reason,
      needleUrl: this.needleUrl,
      ttlMs: this.needleBreakerTtlMs,
      openUntilMs: this.needleBreakerOpenUntil,
    })
    this.startBreakerProbe()
  }

  /** §7.92.6:idempotent close。setInterval 在 startBreakerProbe 内部已 stop。 */
  private closeBreaker(): void {
    if (this.needleBreakerOpenUntil === 0) return // already closed
    this.needleBreakerOpenUntil = 0
  }

  // ── ToolRunner 装配(Phase 3 边界的持有者)───────────────────────────────

  /**
   * 惰性构造 ToolRunner。**调用时**才 loose-read ctx.tools /
   * ctx.realmSkillBridge(不在 constructor 里读)—— §7.92.2 cordis proxy
   * trap:服务未挂载时读 ctx.X 静默 throw,constructor 期读会把 boot 炸掉
   * 或拿到 undefined 缓存死。缺任一依赖 → undefined,调用方 fall through
   * 到 LLM 自提取(与 getToolSchemasForNeedle 返回 [] 同一失败契约)。
   */
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
    }
    catch {
      return undefined
    }
  }

  // ── audit ──────────────────────────────────────────────────────────────

  /** audit 只落 metadata(PII 纪律,文件头);失败不阻断执行链。 */
  audit(level: 'debug' | 'info' | 'warn' | 'error' | 'security', kind: string, payload: Record<string, unknown>): void {
    if (!this.auditLog) return
    void this.auditLog.log({ level, kind, source: name, payload }).catch(() => {})
  }

  // ── helpers(loose reads — §7.92.2 proxy trap safe)────────────────────

  /** lazy loose-read realmSkillBridge;未挂载时返回 undefined。 */
  private bridge(): {
    getSessionRealm?: (sid: string | undefined) => string | undefined
    getToolSchemasForNeedle?: (intent: 'LOCAL' | 'SANITIZED') => ReadonlyArray<{ name: string; description: string; parameters: Record<string, unknown> }>
  } | undefined {
    try {
      return (this.ctx as unknown as {
        realmSkillBridge?: {
          getSessionRealm?: (sid: string | undefined) => string | undefined
          getToolSchemasForNeedle?: (intent: 'LOCAL' | 'SANITIZED') => ReadonlyArray<{ name: string; description: string; parameters: Record<string, unknown> }>
        }
      }).realmSkillBridge
    } catch {
      return undefined
    }
  }

  /**
   * lazy loose-read fetch:tests 通过 ctx.fetch 注入 mock;生产用 global
   * fetch(node 18+ / undici)。未挂载 + global 不可用 → 返回 undefined,
   * 调用方把 extract 当作 'no fetch' 透传失败。
   */
  private fetcher(): ((url: string, init: unknown) => Promise<Response>) | undefined {
    try {
      const ctxFetch = (this.ctx as unknown as { fetch?: (url: string, init: unknown) => Promise<Response> }).fetch
      if (typeof ctxFetch === 'function') return ctxFetch
    } catch { /* §7.92.2 trap */ }
    try {
      const g = (globalThis as unknown as { fetch?: (url: string, init: unknown) => Promise<Response> }).fetch
      if (typeof g === 'function') return g
    } catch { /* nothing */ }
    return undefined
  }

  // ── extract ───────────────────────────────────────────────────────────

  /**
   * POST ${needleUrl}/extract(API.md v1.1 §4.5)。返回:
   *   - 解析成功的 {type, calls, confidence, validation, raw}
   *   - null:网络/超时/HTTP 非 2xx/JSON 解析失败(均 fail through)
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
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.needleTimeoutMs)
    if (upstreamSignal) {
      if (upstreamSignal.aborted) controller.abort()
      else upstreamSignal.addEventListener('abort', () => controller.abort(), { once: true })
    }
    this.stats.needleExtractCalls += 1
    const start = Date.now()
    const fetcher = this.fetcher()
    if (!fetcher) {
      this.audit('warn', 'needle.extract_failed', {
        sessionId, reason: 'no_fetch_runtime',
      })
      // §7.92.6:no fetch runtime → 视同 transport down → 开 breaker
      this.openBreaker('transport')
      return null
    }
    try {
      const res = await fetcher(`${this.needleUrl}/extract`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query,
          tools: schemas,
        }),
      })
      clearTimeout(timer)
      const durationMs = Date.now() - start
      this.stats.needleLatencyMsTotal += durationMs
      if (!res.ok) {
        // 422 / 503 / 502 统一 fail through(Phase 7 会细分)。
        // §7.92.6 + dry-run #1:5xx → 开 breaker(timeout proxy 4xx/5xx
        // 同样),4xx → 不开(client error,不代表 engine down)。
        const code = res.status
        const reason = code === 408 || code === 504 ? 'timeout_proxy' : `http_${code}`
        this.stats.needleTimeoutSkip += code === 408 || code === 504 ? 1 : 0
        this.audit('warn', code === 408 || code === 504 ? 'needle.timeout_skip' : 'needle.extract_failed', {
          sessionId, durationMs, status: code, reason,
        })
        if (code >= 500 || code === 408 || code === 504) {
          this.openBreaker('http_5xx')
        }
        return null
      }
      const raw = await res.json() as Record<string, unknown>
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
      // §7.92.6:success → 关 breaker(让后续请求不再短跳)。idempotent。
      this.closeBreaker()
      this.audit('info', 'needle.extract', {
        sessionId, durationMs, status: res.status,
        type, confidence, functionCallCount: calls.length,
        queryLen: query.length, schemaCount: schemas.length,
      })
      return {
        type,
        calls,
        confidence,
        validation: { ungrounded },
        raw,
      }
    } catch (err: unknown) {
      clearTimeout(timer)
      const durationMs = Date.now() - start
      const isAbort = (err as { name?: string })?.name === 'AbortError' || controller.signal.aborted
      this.stats.needleTimeoutSkip += isAbort ? 1 : 0
      this.stats.needleExtractCalls += 0 // 计入了 1,但 timeout 也算 1 次 extract 调用;不双重计数
      // §7.92.6 + dry-run #1:AbortError(本地 1.5s 超时)+ 其他网络错 → 开
      // breaker。生产 needle 引擎当前 degradation 25x(timeout 几乎全
      // 中),这是必要的设计应对。
      this.openBreaker(isAbort ? 'timeout' : 'transport')
      this.audit('warn', isAbort ? 'needle.timeout_skip' : 'needle.extract_failed', {
        sessionId, durationMs, thrown: true,
        error: (err as { message?: string })?.message ?? String(err),
      })
      return null
    }
  }

  // ── synthesis context builder ─────────────────────────────────────────

  /**
   * 构造合成 user-role message 的文本。**强指令**告知 LLM 工具已自动
   * 执行,请勿再调用,直接综合结果合成回复。
   *
   * 不注入 synthetic assistant tool_call / tool_result 消息(架构上
   * 不可达 —— dsh-agent-loop line 559 把 decision.messages 全部以
   * user/message append,assistant role 注入会污染 message accounting)。
   * LLM 读这段纯文本 + 现有 conversation history,自然给出 final reply。
   */
  private buildSynthesisContext(
    originalQuery: string,
    calls: ReadonlyArray<{ name: string; arguments: unknown }>,
    outcomes: ReadonlyArray<{ status: string; name: string; text?: string; reason?: string }>,
  ): string {
    const lines: string[] = []
    lines.push('[System — needle pre-execution summary]')
    lines.push('The following tool calls were already executed. Do NOT call them again. Answer the user directly based on these results.')
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

  /** PII 守卫:arguments 摘要只取 key + 类型,不落值。 */
  private safeArgSummary(args: unknown): string {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return ''
    return Object.entries(args as Record<string, unknown>)
      .map(([k, v]) => {
        const t = Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v
        return `${k}:${t}`
      })
      .join(', ')
  }

  // ── Phase 5 主路径:agent/pre-step listener ─────────────────────────────

  /**
   * agent/pre-step waterfall listener。**总是 await next() FIRST** ——
   * 让我们(needle)在 chain 中是 input-guard 的外层,input-guard 的
   * classify + setSessionRealm 完成后才返回到这里,我们才看得到本 turn
   * 的 realm。决策树(全 fail-open,永不 throw):
   *
   *   await next()
   *   ├─ decision.kind === 'reject'      → 透传(input-guard 已拒)
   *   ├─ !isAvailable()                  → 透传(总开关关)
   *   ├─ sessionId 缺失                → 透传
   *   ├─ realm 未注册 / 非 LOCAL|SANITIZED → needleRealmUnsetSkip++
   *   ├─ 用户最后一条文本为空           → 透传
   *   ├─ getToolSchemasForNeedle 空     → 透传
   *   ├─ extract → null                  → 透传
   *   ├─ adopt gate 未过                  → needleLowConfSkip++ / 透传
   *   ├─ createToolRunner undefined      → 透传(无法执行)
   *   ├─ outcomes ≥1 executed           → 注入 user-role synthesis message
   *   └─ 全 denied/skipped/error          → 透传(虽然跑了 ToolRunner 但没
   *                                          真实结果,不污染 conversation)
   *
   * 整个 body 包在 try/catch:任何意外 throw → 返回原 decision,绝不让
   * cordis waterfall dispatch 因为 needle 抛错而炸穿 turn。
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
    // decision 提到 try 外:catch 拿得到 → 真异常时透传(不污染 cordis
    // waterfall,不让 dispatch 因为 needle 抛错而炸穿 turn)。但
    // await next() 自身抛的情况拿不到 decision → 只好重抛。
    let decision: PreStepDecisionShape | undefined
    try {
      decision = await next()
      // Gate 1:上游拒了 → 透传
      if (decision.kind === 'reject') return decision
      // Gate 2:总开关关 或 breaker 打开(§7.92.6)。当 needleEnabled
      // 开但 breaker 开时,显式落 needle.circuit_open_skip audit 便于
      // 运维 grep "为什么 needle 不跑";needleEnabled=false 时静默
      // 透传(总开关没开,没必要 audit 噪声)。
      if (!this.isAvailable()) {
        if (this.needleEnabled && Date.now() < this.needleBreakerOpenUntil) {
          this.stats.needleCircuitSkip += 1
          this.audit('info', 'needle.circuit_open_skip', {
            sessionId: payload.agent?.session?.id,
            needleUrl: this.needleUrl,
            openUntilMs: this.needleBreakerOpenUntil,
            remainingMs: this.needleBreakerOpenUntil - Date.now(),
          })
        }
        return decision
      }
      // Gate 3:sessionId 缺失(框架未就绪) → 透传
      const sessionId = payload.agent?.session?.id
      if (!sessionId) return decision
      // Gate 4:realm 判定(needle 只为 LOCAL/SANITIZED 服务;CLOUD 自带
      // native tool calling,REJECT input-guard 已拒,undefined 是 realm
      // 未注册 — 保守跳过)
      const bridge = this.bridge()
      if (!bridge?.getSessionRealm || !bridge?.getToolSchemasForNeedle) return decision
      const realm = bridge.getSessionRealm(sessionId)
      if (realm !== 'LOCAL' && realm !== 'SANITIZED') {
        this.stats.needleRealmUnsetSkip += 1
        return decision
      }
      // Gate 5:真用户最后一条文本
      const lastUser = findLastUserText(payload.messages)
      if (!lastUser || !lastUser.text.trim()) return decision

      // ── schemas → extract(用户原文直入,不限语种,needle 自带
      //    cn_grounding.py 归一化中文数字)──
      const schemas = bridge.getToolSchemasForNeedle(realm)
      if (schemas.length === 0) return decision
      const extract = await this.extractCalls(lastUser.text, schemas, sessionId, payload.signal)
      if (!extract) return decision

      // ── adopt gate ──
      if (extract.type !== 'call' || extract.calls.length === 0
          || extract.confidence < this.needleConfidenceThreshold) {
        this.stats.needleLowConfSkip += 1
        this.audit('info', 'needle.low_confidence_skip', {
          sessionId,
          type: extract.type,
          callCount: extract.calls.length,
          confidence: extract.confidence,
          threshold: this.needleConfidenceThreshold,
        })
        return decision
      }
      this.stats.needleExtractOk += 1

      // ── execute ──
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
      this.stats.needleExecuted += executedCount
      this.stats.needleErrors += outcomes.filter(o => o.status === 'error').length

      if (executedCount === 0) return decision

      // ── inject synthesis message ──
      const text = this.buildSynthesisContext(lastUser.text, extract.calls, outcomes)
      const injected = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      })
      const baseMessages = decision.messages ?? payload.messages
      this.stats.needleSynthesisInjected += 1
      this.audit('info', 'needle.synthesis_injected', {
        sessionId,
        toolCount: outcomes.length,
        executedCount,
        skippedCount: outcomes.filter(o => o.status === 'skipped').length,
        deniedCount: outcomes.filter(o => o.status === 'denied').length,
        errorCount: outcomes.filter(o => o.status === 'error').length,
        originalQueryLen: lastUser.text.length,
        messageLen: text.length,
      })
      // ops-log 行(§7.46 纪律)
      try {
        this.ctx.logger?.info?.(
          `[needle-extractor] synthesis injected sessionId=${sessionId} toolCount=${outcomes.length}` +
          ` executedCount=${executedCount} skippedCount=${outcomes.filter(o => o.status === 'skipped').length}` +
          ` deniedCount=${outcomes.filter(o => o.status === 'denied').length}` +
          ` errorCount=${outcomes.filter(o => o.status === 'error').length}` +
          ` messageLen=${text.length}`,
        )
      } catch { /* debug only */ }
      return {
        ...decision,
        messages: [...baseMessages, injected],
      }
    } catch (err: unknown) {
      // 处理阶段出错 → 透传原 decision(dispatch 干净,turn 不炸)。
      // await next() 自身抛 → decision undefined → 重抛(让上游处理
      // 真基础设施错误,不静默吞)。
      this.audit('error', 'needle.listener.error', {
        sessionId: payload.agent?.session?.id,
        error: (err as { message?: string })?.message ?? String(err),
        hadDecision: decision !== undefined,
      })
      try {
        this.ctx.logger?.warn?.(
          `[needle-extractor] handlePreStep error: ${(err as { message?: string })?.message ?? String(err)}` +
          ` hadDecision=${decision !== undefined}`,
        )
      } catch { /* debug only */ }
      if (decision !== undefined) return decision
      throw err
    }
  }
}

/** Module augmentation: expose the service on ctx. */
declare module '@deepseek-ai/cordis' {
  interface Context {
    needleExtractor: NeedleExtractorServiceImpl
  }
}

export async function apply(ctx: Context, config: Config): Promise<() => Promise<void>> {
  const auditLog = (ctx as unknown as { auditLog?: AuditLike }).auditLog
  const service = new NeedleExtractorServiceImpl(ctx, config, auditLog)
  // §7.46 ops-log 纪律:boot 关键节点一行(metadata only,url/enabled 是
  // 配置不是 PII)。运维排查"needle 为什么没生效"第一眼看这行。
  try {
    ctx.logger?.info?.(
      `[needle-extractor] boot enabled=${service.isAvailable()} url=${config.needleUrl ?? 'http://127.0.0.1:8081'}` +
      ` timeoutMs=${config.needleTimeoutMs ?? 1500} threshold=${config.needleConfidenceThreshold ?? 0.7}`,
    )
  } catch { /* debug only */ }
  service.start()

  // ── Phase 5:agent/pre-step waterfall listener ──
  // **必须早于 input-guard apply**(cordis.patch.yml - insert: 数组里
  // needle-extractor 在 input-guard 之前)—— 我们 await next() 时才
  // 能让 input-guard 先 classify + setSessionRealm,然后我们拿 realm
  // 决策。§7.93 file header 里有详细分析。
  const on = (ctx as unknown as { on?: <T extends (...args: any[]) => any>(event: string, handler: T, opts?: Record<string, unknown>) => () => void }).on
  const disposers: Array<() => void> = []
  if (on) {
    const d1 = on('agent/pre-step', async (payload: any, next: any) => {
      return service.handlePreStep(payload, next)
    }, { global: true })
    void auditLog?.log?.({
      level: 'info',
      kind: 'needle.hook.registered',
      source: 'needle-extractor',
      payload: { event: 'agent/pre-step', global: true, disposerReturned: typeof d1 === 'function' },
    })
    if (typeof d1 === 'function') disposers.push(d1)
  } else {
    void auditLog?.log?.({
      level: 'warn',
      kind: 'needle.hook.skipped',
      source: 'needle-extractor',
      payload: { reason: 'ctx.on unavailable — listener not registered; needle will be a no-op' },
    })
  }

  return async () => {
    for (const d of disposers) {
      try { d() } catch { /* debug only */ }
    }
    await service.stop()
  }
}