/**
 * needle-extractor — §7.93:cactus-needle 3.0.1 作为 LOCAL LLM 的 tool-call
 * prefill(解决 §7.42 P0-1 minicpm5-2b malformed tool-call)。
 *
 * **Phase 4 = 骨架**:config schema + audit 面 + stats 计数 + availability
 * stub + ToolRunner 装配。boot 无任何 waterfall 副作用;needle 一次都不调。
 *
 * 后续 Phase 路线图(本文件内按 §7.93 Phase N 注释锚点接线):
 *   - Phase 5:`agent/request` waterfall listener —— CLOUD intent 直接
 *     next();LOCAL/SANITIZED → (翻译 zh→en,client 侧 LOCAL LLM,few-shot
 *     + 【】实体保真)→ realmSkillBridge.getToolSchemasForNeedle(intent)
 *     → POST ${needleUrl}/extract(API.md v1.1)→ confidence ≥ 阈值 →
 *     ToolRunner.executeAll(真 agent 透传)→ 合成 assistant tool_call +
 *     tool_result 消息注入 payload.messages + payload.tools=[](deepFreeze
 *     前,waterfall 内)→ next() 让 LOCAL LLM 只做 chat synthesis。
 *   - Phase 6:circuit breaker + boot probe + 周期恢复 probe(§7.92.6/
 *     §7.92.7 jev 模板逐字复用;GET /health,503 = down)。
 *   - Phase 7:失败路径细分(422 不重试 / 503 busy 退避重试 / 503 loading
 *     走 breaker / 502 降级 LLM 自提取)。
 *
 * 服务边界(user 终裁,needle-extractor-integration memory):
 *   - needle 服务端只提取,不翻译不执行;翻译在 client(本插件)由 LOCAL
 *     LLM 执行;执行走 tool-runner → ctx.tools.execute(realm/PII/audit
 *     零绕过);最终整段对话给 LOCAL LLM 合成回复。
 *   - 一切失败(needle down/超时/低置信/空 schemas)fall through 到现行
 *     LLM 自提取路径(§7.42 P0-1 patch 保留,是 fallback 不是被替代者)。
 *
 * audit 面(source 区分归属):
 *   本插件(source='needle-extractor'):
 *     needle.boot_probe          (Phase 6, info/warn)
 *     needle.probe               (Phase 6, info,周期恢复探测)
 *     needle.extract             (Phase 5, info,每次 /extract 调用 metadata)
 *     needle.translate           (Phase 5, info,zh→en 翻译调用 metadata)
 *     needle.low_confidence_skip (Phase 5, info)
 *     needle.timeout_skip        (Phase 5, warn)
 *     needle.circuit_open_skip   (Phase 5/6, info)
 *     needle.extract_failed      (Phase 5/7, warn,坏 JSON/非 200)
 *   tool-runner(source='tool-runner',Phase 3 已实现):
 *     needle.executed / needle.execution_failed / needle.realm_rejected /
 *     needle.fabricated_arg / needle.unknown_tool
 *   ⚠️ audit-log minLevel 会静默 drop 'debug'(memory:audit-log-minlevel-
 *   drop)—— 以上全部用 info 起步,运维必须看得见。
 *   ⚠️ PII 纪律:audit payload 只落 metadata(长度/计数/名字/延迟),
 *   绝不落 query/arguments/result 内容。
 *
 * inject(§7.92.2 proxy trap:读 ctx.X 前必须先列 inject):
 *   - llm               Phase 5 翻译走 local-llm provider(NEEDLE_TRANSLATE_PROVIDER)
 *   - auditLog          审计
 *   - realmSkillBridge  Phase 2 getToolSchemasForNeedle + Phase 3 realm 预检
 *   - tools             宿主 ToolRuntime,ToolRunner 的执行面
 *   (计划草稿里的 privacyPolicy 已去掉:本插件不读 categories —— intent
 *   判定是 intent-router 的职责,needle 只在 verdict 之后工作。)
 *
 * @module dsh-edge-agent/needle-extractor
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { ToolRunner } from './tool-runner.js'

export const name = 'needle-extractor'

export const inject = ['llm', 'auditLog', 'realmSkillBridge', 'tools'] as const

/** Minimal interface for the audit-log service (same shape as intent-router). */
interface AuditLike {
  log(entry: { level: 'debug' | 'info' | 'warn' | 'error' | 'security'; kind: string; source: string; payload: Record<string, unknown> }): Promise<unknown>
}

export interface Config {
  /** 总开关。schema 默认 false("只有使能了才有效",user 终裁);生产
   *  cordis.patch.yml 用 env 翻译层给值(Phase 9)。false 时插件 boot 但
   *  isAvailable() 恒 false,Phase 5 listener 直接 next()。 */
  needleEnabled?: boolean
  /** needle-http 服务基址(API.md v1.1:GET /health + POST /extract;
   *  stateless,无需 /reset)。playground :7860 是 needle webui,本项目不走。 */
  needleUrl?: string
  /** 单次 POST /extract 超时(ms)。实测 376-548ms → 1500ms 有 3x 余量;
   *  超时 fall through 到 LLM 自提取(needleTimeoutSkip)。 */
  needleTimeoutMs?: number
  /** 采纳阈值:confidence < 此值 → fall through(Phase 1 实测中文直入
   *  conf 1.0 幻觉,阈值不救翻译问题,但挡住低置信噪声)。 */
  needleConfidenceThreshold?: number
  /** zh→en 翻译开关(client 侧 LOCAL LLM 执行;needle 服务端不翻译)。
   *  false 时 query 原文直入 /extract —— 仅英文 query 有意义。 */
  needleTranslateEnabled?: boolean
  /** 翻译用的 provider 路由 id(local-llm = LAN minicpm5-2b,§7.41
   *  FIFO 信号量自动生效)。 */
  needleTranslateProvider?: string
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
  needleTranslateEnabled: Schema.boolean().default(true),
  needleTranslateProvider: Schema.string().default('local-llm'),
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
  /** Phase 5:/extract 调用数 / 成功采纳数 / 低置信跳过 / 超时跳过。 */
  needleExtractCalls: number
  needleExtractOk: number
  needleLowConfSkip: number
  needleTimeoutSkip: number
  /** Phase 5:翻译调用数(fail → 原文直入,不阻断)。 */
  needleTranslateCalls: number
  /** Phase 3(tool-runner 归一的 outcome 计数,由 Phase 5 汇入)。 */
  needleExecuted: number
  needleDenied: number
  needleSkippedFabricated: number
  needleErrors: number
  /** /extract 累计延迟(取驱动决策的响应,均值 = total/calls)。 */
  needleLatencyMsTotal: number
}

export class NeedleExtractorServiceImpl extends Service {
  private readonly auditLog: AuditLike | undefined
  private readonly needleEnabled: boolean
  private readonly needleUrl: string
  private readonly needleTimeoutMs: number
  private readonly needleConfidenceThreshold: number
  private readonly needleTranslateEnabled: boolean
  private readonly needleTranslateProvider: string
  private readonly needleBreakerTtlMs: number
  private readonly needleBootProbeEnabled: boolean
  private readonly needleBootProbeTimeoutMs: number
  private readonly needleBreakerProbeMs: number
  private readonly needleProbeTimeoutMs: number

  private readonly stats: NeedleExtractorStats

  constructor(ctx: Context, config: Config, auditLog?: AuditLike) {
    super(ctx, 'needleExtractor')
    this.auditLog = auditLog
    this.needleEnabled = config.needleEnabled ?? false
    this.needleUrl = config.needleUrl ?? 'http://127.0.0.1:8081'
    this.needleTimeoutMs = config.needleTimeoutMs ?? 1500
    this.needleConfidenceThreshold = config.needleConfidenceThreshold ?? 0.7
    this.needleTranslateEnabled = config.needleTranslateEnabled ?? true
    this.needleTranslateProvider = config.needleTranslateProvider ?? 'local-llm'
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
      needleExtractCalls: 0,
      needleExtractOk: 0,
      needleLowConfSkip: 0,
      needleTimeoutSkip: 0,
      needleTranslateCalls: 0,
      needleExecuted: 0,
      needleDenied: 0,
      needleSkippedFabricated: 0,
      needleErrors: 0,
      needleLatencyMsTotal: 0,
    }
  }

  // ── availability ──────────────────────────────────────────────────────────

  /**
   * Phase 4 语义:总开关即可用性。Phase 6 叠加 breaker 后语义变为
   * `needleEnabled && !circuitOpen`(jev isJevAvailable 同款)。
   * Phase 5 的 waterfall listener 以此作第一道 gate:false → next()。
   */
  isAvailable(): boolean {
    return this.needleEnabled
  }

  /** 配置只读视图(ops 排查 + 测试断言;env 翻译层是否生效一眼可见)。 */
  getConfigView(): Readonly<{
    needleEnabled: boolean
    needleUrl: string
    needleTimeoutMs: number
    needleConfidenceThreshold: number
    needleTranslateEnabled: boolean
    needleTranslateProvider: string
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
      needleTranslateEnabled: this.needleTranslateEnabled,
      needleTranslateProvider: this.needleTranslateProvider,
      needleBreakerTtlMs: this.needleBreakerTtlMs,
      needleBootProbeEnabled: this.needleBootProbeEnabled,
      needleBootProbeTimeoutMs: this.needleBootProbeTimeoutMs,
      needleBreakerProbeMs: this.needleBreakerProbeMs,
      needleProbeTimeoutMs: this.needleProbeTimeoutMs,
    }
  }

  getStats(): NeedleExtractorStats {
    return { ...this.stats }
  }

  // ── lifecycle stubs(Phase 6 填实:boot probe + 周期恢复 probe)────────────

  /** Phase 6:fire boot probe(GET /health,fail → 预开 breaker)。 */
  start(): void {
    // 骨架期无副作用。boot probe 接线点见 §7.92.7 intent-router.start()。
    void this.needleBootProbeEnabled // 占位引用,防 Phase 6 前 unused 误删
  }

  /** Phase 6:等 boot probe settle + 清周期 interval。 */
  async stop(): Promise<void> {
    // 骨架期无副作用。
  }

  // ── ToolRunner 装配(Phase 3 边界的持有者)────────────────────────────────

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

  // ── audit ─────────────────────────────────────────────────────────────────

  /** audit 只落 metadata(PII 纪律,文件头);失败不阻断执行链。 */
  audit(level: 'debug' | 'info' | 'warn' | 'error' | 'security', kind: string, payload: Record<string, unknown>): void {
    if (!this.auditLog) return
    void this.auditLog.log({ level, kind, source: name, payload }).catch(() => {})
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
      ` translate=${config.needleTranslateEnabled ?? true}/${config.needleTranslateProvider ?? 'local-llm'}` +
      ` timeoutMs=${config.needleTimeoutMs ?? 1500} threshold=${config.needleConfidenceThreshold ?? 0.7}`,
    )
  } catch { /* debug only */ }
  service.start()
  return async () => {
    await service.stop()
  }
}
