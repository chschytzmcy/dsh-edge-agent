/**
 * needle-extractor — §7.93:cactus-needle 3.0.1 作为 LOCAL LLM 的 tool-call
 * prefill(解决 §7.42 P0-1 minicpm5-2b malformed tool-call)。
 *
 * **Phase 4 = 骨架**:config schema + audit 面 + stats + ToolRunner 装配。
 * **Phase 5 = waterfall listener**:agent/pre-step 上挂全局监听器,gates →
 * translate(zh→en,client 侧 LOCAL LLM,repair 实体保真)→ realmSkillBridge
 * .getToolSchemasForNeedle → POST /extract → adopt gate → ToolRunner
 * .executeAll → 合成 user-role message 注入 decision.messages → 让 LOCAL
 * LLM 只做 chat synthesis(§7.42 P0-1 malformed guard 留作 fallback)。
 *
 * 后续 Phase:
 *   - Phase 6:circuit breaker + boot probe + 周期恢复 probe(§7.92.6/§7.92.7
 *     jev 模板逐字复用,GET /health,**needle timeout 必须计入 breaker 失败**
 *     —— dry-run 实测 engine 当前 degradation 25x)。
 *   - Phase 7:失败路径细分(422 不重试 / 503 busy 退避 / 503 loading 走
 *     breaker / 502 降级)。
 *
 * 服务边界(user 终裁,needle-extractor-integration memory):
 *   - needle 服务端只提取,**不翻译不执行**;翻译在 client(本插件)由
 *     LOCAL LLM 执行(few-shot + 【】 实体保真 + repairEntities 兜底);
 *     执行走 tool-runner → ctx.tools.execute(realm/PII/audit 零绕过);
 *     最终整段对话给 LOCAL LLM 合成回复。
 *   - 一切失败(needle down / 超时 / 低置信 / 空 schemas / 翻译失败 / 0
 *     executed)fall through 到 LLM 自提取路径(§7.42 P0-1 patch 保留,
 *     是 fallback 不是被替代者)。
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
 *     needle.boot_probe              (Phase 6, info/warn)
 *     needle.probe                   (Phase 6, info)
 *     needle.translate               (info,每次翻译调用 metadata)
 *     needle.translate.timeout       (warn,AbortError)
 *     needle.translate.empty         (info,LLM 返回空文本)
 *     needle.translate.error         (warn,非 timeout 错误)
 *     needle.extract                 (info,每次 /extract 调用 metadata)
 *     needle.low_confidence_skip     (info,采纳门未过)
 *     needle.timeout_skip            (warn,extract 超时)
 *     needle.extract_failed          (warn,4xx/5xx)
 *     needle.circuit_open_skip       (Phase 6, info)
 *     needle.synthesis_injected      (info,合成 user-role 已注入)
 *     needle.realm_unset_skip        (info,realm 未注册跳过)
 *   tool-runner(source='tool-runner',Phase 3 已实现):
 *     needle.executed / needle.execution_failed / needle.realm_rejected /
 *     needle.fabricated_arg / needle.unknown_tool
 *   ⚠️ audit-log minLevel 会静默 drop 'debug'(memory:audit-log-minlevel-
 *   drop)—— 以上全部用 info 起步,运维必须看得见。
 *   ⚠️ PII 纪律:audit payload 只落 metadata(长度/计数/名字/延迟),
 *   绝不落 query/arguments/result 内容。
 *
 * inject(§7.92.2 proxy trap:读 ctx.X 前必须先列 inject):
 *   - llm               Phase 5 翻译走 local-llm provider
 *   - auditLog          审计
 *   - realmSkillBridge  getToolSchemasForNeedle + getSessionRealm
 *   - tools             宿主 ToolRuntime,ToolRunner 的执行面
 *   (计划草稿里的 privacyPolicy 已去掉:本插件不读 categories ——
 *   intent 判定归 intent-router + privacy-policy,needle 只在 verdict
 *   之后工作。intent-router 也不读:不依赖其 classification model。)
 *
 * @module dsh-edge-agent/needle-extractor
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { ToolRunner } from './tool-runner.js'

export const name = 'needle-extractor'

export const inject = ['llm', 'auditLog', 'realmSkillBridge', 'tools'] as const

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
  /** 翻译独立超时预算(ms)。LAN minicpm5-2b 实测 0.6-8s,3000ms 取
   *  1x-典型上限;**timeout → fall through 不进 needle**(避免中文原文
   *  二次浪费 extract 1.5s);非 timeout 错误 → 用原文试 extract。 */
  needleTranslateTimeoutMs?: number
  /** 采纳阈值:confidence < 此值 → fall through(实测 conf=0.99 也可能
   *  幻觉,threshold 不救翻译问题,但挡低置信噪声)。 */
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
  // 翻译独立预算:dry-run 实测 LAN 0.6-8s;3000ms 取典型上限,timeout
  // 直接 fall through(省二次 extract)。
  needleTranslateTimeoutMs: Schema.natural().default(3000),
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
  /** Phase 5:realm 未注册(undefined)跳过 + 非 LOCAL/SANITIZED 跳过。 */
  needleRealmUnsetSkip: number
  /** Phase 5:/extract 调用数 / 成功采纳数 / 低置信跳过 / 超时跳过。 */
  needleExtractCalls: number
  needleExtractOk: number
  needleLowConfSkip: number
  needleTimeoutSkip: number
  /** Phase 5:翻译调用数(fail → 原文直入,不阻断)。 */
  needleTranslateCalls: number
  needleTranslateTimeout: number
  needleTranslateError: number
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

/**
 * 实体保真兜底 —— §7.93 Phase 4.5 dry-run 发现 minicpm5-2b 翻译时
 * 会把 "/home/etsme/..." 错写成 "/home/etsween/..."(即便指令了
 * "preserve entities in 【】")。从原文抽 path / URL,若翻译结果里没
 * 出现原文形态,把翻译中第一个 【...】 段替成原文实体(假设翻译至少
 * 标记了第一个实体)。
 *
 * @param zh 原文(中文)
 * @param translated 翻译结果(英文,可能含 【】 标记或不含)
 * @returns 修复后的翻译;若原文没 path/URL,原样返回
 */
function repairEntities(zh: string, translated: string): string {
  if (!translated) return translated
  // 路径形态:以 / 开头,含 word/./-/_ 中的至少一个
  const entities: string[] = []
  const pathRe = /\/[\w./-]+/g
  const urlRe = /https?:\/\/\S+/g
  let m: RegExpExecArray | null
  while ((m = pathRe.exec(zh)) !== null) {
    if (m[0].length > 1) entities.push(m[0])
  }
  while ((m = urlRe.exec(zh)) !== null) {
    if (m[0].length > 7) entities.push(m[0])
  }
  if (entities.length === 0) return translated
  // dedup(保留顺序)
  const seen = new Set<string>()
  const unique = entities.filter(e => (seen.has(e) ? false : (seen.add(e), true)))
  let out = translated
  for (const ent of unique) {
    if (!out.includes(ent)) {
      // 翻译丢了实体:把第一个 【...】 段(若存在)替换为原文实体
      const bracketRe = /【[^】]+】/
      if (bracketRe.test(out)) {
        out = out.replace(bracketRe, `【${ent}】`)
      } else {
        // 没 【】 标记:无脑追加(保守,不破坏句子)
        out = `${out} (path: ${ent})`
      }
    }
  }
  return out
}

/**
 * 翻译 prompt(简洁版)。few-shot 在 §7.93 Phase 4.5 dry-run 有效但
 * 模型仍出错 → Phase 5 只取强指令 + repairEntities 兜底,避免 prompt
 * 膨胀拉高单次翻译耗时。
 */
const TRANSLATE_PROMPT =
  'Translate the following Chinese query to English. Preserve ALL file paths, URLs, ' +
  'and identifiers EXACTLY as written (wrap each in 【】 brackets). Return ONLY the ' +
  'translation, no explanations.\n\nQuery: '

// ── Service ────────────────────────────────────────────────────────────

export class NeedleExtractorServiceImpl extends Service {
  private readonly auditLog: AuditLike | undefined
  private readonly needleEnabled: boolean
  private readonly needleUrl: string
  private readonly needleTimeoutMs: number
  private readonly needleTranslateTimeoutMs: number
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
    this.needleTranslateTimeoutMs = config.needleTranslateTimeoutMs ?? 3000
    this.needleConfidenceThreshold = config.needleConfidenceThreshold ?? 0.7
    this.needleTranslateEnabled = config.needleTranslateEnabled ?? true
    this.needleTranslateProvider = typeof config.needleTranslateProvider === 'string' && config.needleTranslateProvider
      ? config.needleTranslateProvider
      : 'local-llm'
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
      needleTranslateCalls: 0,
      needleTranslateTimeout: 0,
      needleTranslateError: 0,
      needleExecuted: 0,
      needleErrors: 0,
      needleSynthesisInjected: 0,
      needleLatencyMsTotal: 0,
    }
  }

  // ── availability ──────────────────────────────────────────────────────

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
    needleTranslateTimeoutMs: number
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
      needleTranslateTimeoutMs: this.needleTranslateTimeoutMs,
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

  // ── lifecycle stubs(Phase 6 填实:boot probe + 周期恢复 probe)─────────

  /** Phase 6:fire boot probe(GET /health,fail → 预开 breaker)。 */
  start(): void {
    // 骨架期无副作用。boot probe 接线点见 §7.92.7 intent-router.start()。
    void this.needleBootProbeEnabled // 占位引用,防 Phase 6 前 unused 误删
  }

  /** Phase 6:等 boot probe settle + 清周期 interval。 */
  async stop(): Promise<void> {
    // 骨架期无副作用。
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

  /** lazy loose-read llm;未挂载时 translate 必然失败 → fall through。 */
  private llm(): { stream?: (opts: unknown) => unknown } | undefined {
    try {
      return (this.ctx as unknown as { llm?: { stream?: (opts: unknown) => unknown } }).llm
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

  // ── translate ─────────────────────────────────────────────────────────

  /**
   * zh → en 翻译。返回:
   *   - string: 翻译成功(或 translate=false 直通)的 query,可送 needle
   *   - null:   翻译失败(timeout / LLM 错误),调用方**直接 fall through**,
   *             **不进 needle**(避免 1.5s 二次浪费在 CJK 原文上;
   *             §7.93 Phase 4.5 实测 CJK 在 needle 上质量不稳定)
   *
   * 实现模板:intent-router.ts:1395-1455 的 classifyWithLlm stream 模式
   * (provider/model/messages/signal/sessionId;thenable 检查;text-delta
   * 收集;AbortController + setTimeout;timeout 与 error 区分审计)。
   *
   * ⚠️ 翻译模型名:**与 intent-router.classificationModel 对齐** ——
   * 同为 local-llm provider,同 LAN 部署,共用一个上游模型。默认
   * 'qwen3-4b'(intent-router schema default)。如果部署切换到不同的
   * local 模型,需同时调整 intent-router 与 needle 两侧(或 Phase 9
   * 通过 cordis.patch.yml 翻译层覆盖)。
   */
  private async translateQuery(
    text: string,
    sessionId: string | undefined,
    upstreamSignal: AbortSignal | undefined,
  ): Promise<{ query: string; ok: true } | { ok: false; reason: 'disabled' | 'no_llm' | 'timeout' | 'empty' | 'error' }> {
    if (!this.needleTranslateEnabled) return { query: text, ok: true }
    const llm = this.llm()
    if (!llm?.stream) return { ok: false, reason: 'no_llm' }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.needleTranslateTimeoutMs)
    if (upstreamSignal) {
      if (upstreamSignal.aborted) controller.abort()
      else upstreamSignal.addEventListener('abort', () => controller.abort(), { once: true })
    }

    this.stats.needleTranslateCalls += 1
    const start = Date.now()
    try {
      const userMessage = createUserMessage({
        content: [{ type: 'text', text: TRANSLATE_PROMPT + text }],
        source: { kind: 'user' },
      })
      const streamRaw = llm.stream({
        provider: this.needleTranslateProvider,
        model: 'qwen3-4b', // 与 intent-router.classificationModel 对齐;见 docstring
        messages: [userMessage],
        signal: controller.signal,
        ...(sessionId ? { sessionId } : {}),
      })
      // §7.37:llm.stream 可能返回 Promise<AsyncIterable>(dsh-llm 0.1.2-rc.1+)
      const stream = (streamRaw != null && typeof (streamRaw as { then?: unknown }).then === 'function')
        ? await (streamRaw as unknown as Promise<AsyncIterable<{ type: string; text?: string }>>)
        : streamRaw as AsyncIterable<{ type: string; text?: string }>

      let translated = ''
      for await (const chunk of stream) {
        if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          translated += chunk.text
        }
      }
      clearTimeout(timer)
      const durationMs = Date.now() - start
      const trimmed = translated.trim()
      if (!trimmed) {
        this.stats.needleTranslateError += 1
        this.audit('info', 'needle.translate.empty', {
          sessionId, durationMs, inputLen: text.length,
        })
        return { ok: false, reason: 'empty' }
      }
      const repaired = repairEntities(text, trimmed)
      this.audit('info', 'needle.translate', {
        sessionId, durationMs, inputLen: text.length, outputLen: trimmed.length,
        repaired: repaired !== trimmed,
      })
      return { query: repaired, ok: true }
    } catch (err: unknown) {
      clearTimeout(timer)
      const durationMs = Date.now() - start
      const isAbort = (err as { name?: string })?.name === 'AbortError' || controller.signal.aborted
      this.stats.needleTranslateTimeout += isAbort ? 1 : 0
      this.stats.needleTranslateError += isAbort ? 0 : 1
      this.audit('warn', isAbort ? 'needle.translate.timeout' : 'needle.translate.error', {
        sessionId, durationMs, error: (err as { message?: string })?.message ?? String(err),
      })
      return { ok: false, reason: isAbort ? 'timeout' : 'error' }
    }
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
        // 422 / 503 / 502 统一 fail through(Phase 7 会细分)
        const code = res.status
        const reason = code === 408 || code === 504 ? 'timeout_proxy' : `http_${code}`
        this.stats.needleTimeoutSkip += code === 408 || code === 504 ? 1 : 0
        this.audit('warn', code === 408 || code === 504 ? 'needle.timeout_skip' : 'needle.extract_failed', {
          sessionId, durationMs, status: code, reason,
        })
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
   *   ├─ translate → fail(reason)        → 透传(不进 needle)
   *   ├─ translate.ok(query)             → 继续
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
      // Gate 2:总开关关
      if (!this.isAvailable()) return decision
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

      // ── translate ──
      const tr = await this.translateQuery(lastUser.text, sessionId, payload.signal)
      if (!tr.ok) return decision

      // ── schemas → extract ──
      const schemas = bridge.getToolSchemasForNeedle(realm)
      if (schemas.length === 0) return decision
      const extract = await this.extractCalls(tr.query, schemas, sessionId, payload.signal)
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
      ` translate=${config.needleTranslateEnabled ?? true}/${config.needleTranslateProvider ?? 'local-llm'}` +
      ` translateTimeoutMs=${config.needleTranslateTimeoutMs ?? 3000}` +
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