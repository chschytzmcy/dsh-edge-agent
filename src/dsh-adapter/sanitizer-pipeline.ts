/**
 * sanitizer-pipeline — forward sanitization (PII → placeholders) and
 * reverse desanitization (placeholders → PII) for SANITIZED-realm
 * sessions. The mapping table is per-session and stored in memory.
 *
 * Phase 4 完整实现：
 * - 正向脱敏（PII → 占位符）
 * - 反向还原（占位符 → PII）
 * - 会话级映射表（带 TTL + 容量上限，见下）
 * - 与 privacy-policy 联动（获取脱敏规则）
 *
 * ## 内存中的映射表就是明文 PII
 *
 * `sessionMappings` 持有的是**用户原始 PII 明文**（还原时必须用到）。
 * 因此它必须有明确的生命周期，不能只靠调用方记得调 `purge()`：
 *   1. `http-api.dropSessionBuffer()` 在会话删除/过期/LRU 淘汰/停机时
 *      主动调用 `purge()`（首选路径）
 *   2. 本模块自身按 `sessionTtlMs` 惰性 + 定时清扫（兜底，防止调用方漏调）
 *   3. `maxSessions` 上限触发 LRU 淘汰（兜底，防止会话 id 爆炸）
 *
 * @module dsh-edge-agent/sanitizer-pipeline
 */

import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { PrivacyPolicyServiceImpl } from './privacy-policy.js'

export const name = 'sanitizer-pipeline'

export const inject = ['privacyPolicy', 'auditLog'] as const

export interface Config {
  /** 单会话占位符上限。超限时 sanitize 抛错（见 SanitizerLimitError）。 */
  maxReplacementsPerSession: number
  /** 会话映射表存活时长（毫秒），自最后一次访问算起。0 = 不过期。 */
  sessionTtlMs: number
  /** 同时保留的最大会话数，超出按最近访问时间 LRU 淘汰。0 = 不限。 */
  maxSessions: number
  /** 后台清扫间隔（毫秒）。0 = 关闭定时清扫，仅惰性清扫。 */
  sweepIntervalMs: number
  /** 保留字段：是否启用自动检测（当前恒为规则驱动）。 */
  enableAutoDetection: boolean
}

export const Config: Schema<Config> = Schema.object({
  maxReplacementsPerSession: Schema.natural().default(1024),
  sessionTtlMs: Schema.natural().default(900_000), // 15 min，对齐 confidential 档
  maxSessions: Schema.natural().default(1000),
  sweepIntervalMs: Schema.natural().default(60_000),
  enableAutoDetection: Schema.boolean().default(true),
})

/**
 * 占位符字面量形态：`[<PIITYPE>_<seq>]`，PIITYPE 为大写且可含连字符
 * （如 `[ID-CARD_1]`、`[PHONE_2]`）。反向还原与防碰撞计数都依赖它。
 */
const PLACEHOLDER_RE = /\[([A-Z][A-Z0-9-]*)_(\d+)\]/g

/**
 * 单会话占位符数超过 `maxReplacementsPerSession` 时抛出。
 *
 * 不能"脱一半就放行"——剩余未替换的 PII 会随 prompt 直接上云。抛错让
 * input-guard 走 `downgradeOnSanitizeFailure` 分支降级到 LOCAL，符合
 * "脱不了敏就不上云"。
 */
export class SanitizerLimitError extends Error {
  readonly code = 'sanitizer-limit-exceeded'
  constructor(sessionId: string, limit: number) {
    super(`sanitizer: session ${sessionId} exceeded ${limit} placeholders`)
    this.name = 'SanitizerLimitError'
  }
}

export interface Replacement {
  original: string
  placeholder: string
  piiType: string
  dataClass: string
}

export interface SanitizationResult {
  sanitizedText: string
  sessionId: string
  replacements: Replacement[]
}

export interface SanitizerService {
  sanitize(text: string, context?: { sessionId?: string }): Promise<SanitizationResult>
  desanitize(text: string, sessionId: string): Promise<string>
  desanitizeSync(text: string, sessionId: string): string
  purge(sessionId: string): Promise<void>
  getMappingSize(sessionId: string): number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sanitizer: SanitizerServiceImpl
  }
}

/**
 * Per-session mapping table.
 *
 * `byOriginal` 是 `placeholders` 的反向索引，纯粹为了让去重查找从
 * O(mappings) 降到 O(1)——正向脱敏里每个 match 都要查一次，线性扫描
 * 会让整体退化成 O(n²)。两张表必须同步写入。
 */
interface SessionMapping {
  counter: number
  placeholders: Map<string, string> // placeholder → original
  byOriginal: Map<string, string> // original → placeholder
  lastAccess: number
}

export class SanitizerServiceImpl extends Service implements SanitizerService {
  private sessionMappings = new Map<string, SessionMapping>()
  private readonly maxReplacementsPerSession: number
  private readonly sessionTtlMs: number
  private readonly maxSessions: number
  private sweepTimer: ReturnType<typeof setInterval> | undefined

  constructor(
    ctx: any,
    config: Config,
    private privacyPolicy: PrivacyPolicyServiceImpl,
    private auditLog: any,
  ) {
    super(ctx, 'sanitizer')
    this.maxReplacementsPerSession = config.maxReplacementsPerSession ?? 1024
    this.sessionTtlMs = config.sessionTtlMs ?? 900_000
    this.maxSessions = config.maxSessions ?? 1000
    const interval = config.sweepIntervalMs ?? 60_000
    if (interval > 0 && this.sessionTtlMs > 0) {
      this.sweepTimer = setInterval(() => {
        void this.sweepExpired()
      }, interval)
      // 不要因为这个兜底定时器把进程钉住
      if (typeof this.sweepTimer.unref === 'function') this.sweepTimer.unref()
    }
  }

  /** 停止后台清扫并清空所有会话映射（明文 PII 一并释放）。 */
  async stop(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = undefined
    }
    for (const sessionId of [...this.sessionMappings.keys()]) {
      await this.purge(sessionId)
    }
  }

  /**
   * Forward sanitization: replace PII with placeholders.
   * Returns the sanitized text and the list of replacements made.
   *
   * @throws {SanitizerLimitError} 当本会话占位符数将超过上限时。调用方
   *   （input-guard）应据此降级到 LOCAL，而不是发送半脱敏文本。
   */
  async sanitize(
    text: string,
    context?: { sessionId?: string },
  ): Promise<SanitizationResult> {
    const sessionId = context?.sessionId ?? 'default'
    await this.sweepExpired()
    const mapping = this.touchSession(sessionId)

    // 防碰撞：若用户输入里本就含有 `[PHONE_7]` 这种占位符形状的字面量，
    // 把计数器推过它，确保后续新铸造的占位符永远不会与之重号——否则
    // 反向还原会把用户的普通文本替换成别人的 PII。
    this.bumpCounterPastLiterals(mapping, text)

    const rules = this.privacyPolicy.getSanitizationRules()
    let sanitizedText = text
    const replacements: Replacement[] = []

    for (const rule of rules) {
      let regex: RegExp
      try {
        regex = new RegExp(rule.pattern, 'gi')
      } catch {
        continue // 无效正则，跳过该规则
      }
      // 累进匹配：在上一条规则的产出上继续匹配，规则顺序（长优先）才有意义
      const hits = sanitizedText.match(regex)
      if (!hits) continue

      // 同一取值在文本中出现多次时只处理一次（split/join 已全量替换），
      // 避免 replacements 计数虚高。
      for (const match of new Set(hits)) {
        let placeholder = mapping.byOriginal.get(match)
        if (!placeholder) {
          // 先判上限再铸造：`>=` 后置检查会允许越界一个，且原先的 break
          // 只跳出内层循环，外层规则照常继续铸造（限流形同虚设）。
          if (
            this.maxReplacementsPerSession > 0 &&
            mapping.placeholders.size >= this.maxReplacementsPerSession
          ) {
            await this.audit('warn', 'sanitizer.limit-reached', {
              sessionId,
              limit: this.maxReplacementsPerSession,
            })
            throw new SanitizerLimitError(sessionId, this.maxReplacementsPerSession)
          }
          mapping.counter++
          const piiType = rule.piiType || 'PII'
          placeholder = `[${piiType.toUpperCase()}_${mapping.counter}]`
          mapping.placeholders.set(placeholder, match)
          mapping.byOriginal.set(match, placeholder)
        }
        sanitizedText = sanitizedText.split(match).join(placeholder)
        replacements.push({
          original: match,
          placeholder,
          piiType: rule.piiType,
          dataClass: rule.dataClass,
        })
      }
    }

    if (replacements.length > 0) {
      await this.audit('info', 'sanitizer.sanitized', {
        sessionId,
        replacementCount: replacements.length,
        totalMappings: mapping.placeholders.size,
      })
    }

    return { sanitizedText, sessionId, replacements }
  }

  /**
   * Reverse restoration: replace placeholders back to original PII.
   */
  async desanitize(text: string, sessionId: string): Promise<string> {
    const restoredText = this.desanitizeSync(text, sessionId)
    if (restoredText !== text) {
      await this.audit('debug', 'sanitizer.desanitized', {
        sessionId,
        restored: true,
      })
    }
    return restoredText
  }

  /**
   * Synchronous variant of desanitize — no audit log, for use in streaming
   * event callbacks where async is not available.
   *
   * 单次正则扫描 + 查表，复杂度 O(text)。此前的实现对**每一条**映射做一次
   * 全文 split/join（O(mappings × text)），而流式路径每个 chunk 都会调一次，
   * 长会话下是明确的热点（2026-08-30 修复）。
   */
  desanitizeSync(text: string, sessionId: string): string {
    const mapping = this.sessionMappings.get(sessionId)
    if (!mapping || mapping.placeholders.size === 0) return text
    mapping.lastAccess = Date.now()
    PLACEHOLDER_RE.lastIndex = 0
    return text.replace(PLACEHOLDER_RE, (whole) =>
      mapping.placeholders.get(whole) ?? whole,
    )
  }

  /**
   * Purge all mappings for a session (e.g., when session is deleted).
   */
  async purge(sessionId: string): Promise<void> {
    const mapping = this.sessionMappings.get(sessionId)
    if (mapping) {
      const size = mapping.placeholders.size
      mapping.placeholders.clear()
      mapping.byOriginal.clear()
      this.sessionMappings.delete(sessionId)
      await this.audit('info', 'sanitizer.purged', { sessionId, purgedMappings: size })
    }
  }

  /**
   * Get the number of mappings for a session (for debugging/testing).
   */
  getMappingSize(sessionId: string): number {
    return this.sessionMappings.get(sessionId)?.placeholders.size ?? 0
  }

  /** 当前活跃会话数（用于观测与测试）。 */
  getSessionCount(): number {
    return this.sessionMappings.size
  }

  /** 取出会话映射（不存在则新建），并刷新访问时间 + 施加容量上限。 */
  private touchSession(sessionId: string): SessionMapping {
    let mapping = this.sessionMappings.get(sessionId)
    if (!mapping) {
      this.evictIfOverCapacity()
      mapping = {
        counter: 0,
        placeholders: new Map(),
        byOriginal: new Map(),
        lastAccess: Date.now(),
      }
    } else {
      mapping.lastAccess = Date.now()
      // 重新插入以维持 Map 的插入序 ≈ 最近访问序，便于 LRU 淘汰
      this.sessionMappings.delete(sessionId)
    }
    this.sessionMappings.set(sessionId, mapping)
    return mapping
  }

  /** 超出 maxSessions 时淘汰最久未访问的会话。 */
  private evictIfOverCapacity(): void {
    if (this.maxSessions <= 0) return
    while (this.sessionMappings.size >= this.maxSessions) {
      const oldest = this.sessionMappings.keys().next()
      if (oldest.done) break
      const victim = this.sessionMappings.get(oldest.value)
      victim?.placeholders.clear()
      victim?.byOriginal.clear()
      this.sessionMappings.delete(oldest.value)
      void this.audit('warn', 'sanitizer.session-evicted', {
        sessionId: oldest.value,
        reason: 'max-sessions',
        maxSessions: this.maxSessions,
      })
    }
  }

  /** 清除超过 TTL 未访问的会话映射，释放其中的明文 PII。 */
  private async sweepExpired(): Promise<void> {
    if (this.sessionTtlMs <= 0) return
    const cutoff = Date.now() - this.sessionTtlMs
    const expired: string[] = []
    for (const [sessionId, mapping] of this.sessionMappings) {
      if (mapping.lastAccess < cutoff) expired.push(sessionId)
    }
    for (const sessionId of expired) {
      const mapping = this.sessionMappings.get(sessionId)
      const size = mapping?.placeholders.size ?? 0
      mapping?.placeholders.clear()
      mapping?.byOriginal.clear()
      this.sessionMappings.delete(sessionId)
      await this.audit('info', 'sanitizer.session-expired', {
        sessionId,
        purgedMappings: size,
        ttlMs: this.sessionTtlMs,
      })
    }
  }

  /**
   * 把会话计数器推过输入中出现的任何占位符形状字面量的序号。
   *
   * 残留风险（已知且可接受）：用户若在后续轮次原样回显上一轮**本会话**
   * 铸造过的占位符，还原时会被替换回该会话自己的 PII——不构成跨会话泄漏。
   */
  private bumpCounterPastLiterals(mapping: SessionMapping, text: string): void {
    PLACEHOLDER_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = PLACEHOLDER_RE.exec(text)) !== null) {
      const seq = Number.parseInt(m[2], 10)
      if (Number.isFinite(seq) && seq > mapping.counter) mapping.counter = seq
    }
  }

  private async audit(level: string, kind: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.auditLog?.log) return
    try {
      await this.auditLog.log({ level, kind, source: 'sanitizer-pipeline', payload })
    } catch {
      // Ignore audit errors
    }
  }
}

export async function apply(ctx: any, config: Config): Promise<() => Promise<void>> {
  const privacyPolicy = ctx.get('privacyPolicy')
  if (!privacyPolicy || typeof privacyPolicy.getSanitizationRules !== 'function') {
    // 启动期 fail-fast：缺了它 sanitize() 会在每次请求时抛错，表现为
    // "每条请求都静默降级到 LOCAL"，排查成本极高。宁可起不来。
    throw new Error(
      'sanitizer-pipeline: privacyPolicy service unavailable — check plugin boot order',
    )
  }
  const auditLog = ctx.get('auditLog')
  const service = new SanitizerServiceImpl(ctx, config, privacyPolicy, auditLog)
  return async () => {
    await service.stop()
  }
}
