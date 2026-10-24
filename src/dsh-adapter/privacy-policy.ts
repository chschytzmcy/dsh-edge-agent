/**
 * privacy-policy — engine that loads, validates, and hot-reloads the
 * privacy policy file. The policy controls routing rules, sanitization
 * rules, data classifications, and global constraints.
 *
 * Phase 4 完整实现：
 * - 策略文件加载（JSON）
 * - 路由规则（LOCAL/CLOUD/SANITIZED/REJECT）
 * - 脱敏规则（PII 类型、策略、模板）
 * - 数据分类（public/internal/confidential/secret）
 * - 热更新（文件监控）
 * - 全局约束（云端请求限制等）
 *
 * @module dsh-edge-agent/privacy-policy
 */

import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { PII_PATTERNS, PII_ORDER, PII_DATA_CLASS } from './pii-utils.js'
import { edgeBundleRoot, edgeHome, loadEdgeConfig } from './edge-config.js'

export const name = 'privacy-policy'

export const inject = ['auditLog'] as const

export interface Config {
  policyPath: string
  hotReload: boolean
  watchIntervalMs: number
}

export const Config: Schema<Config> = Schema.object({
  // §7.102 "one config file": no defaults / no required — apply() fills
  // policyPath from config/edge.json (privacy.policyPath) or the
  // ~/.dsh-edge-agent default, and hotReload/watch from privacy.*.
  policyPath: Schema.string(),
  hotReload: Schema.boolean(),
  watchIntervalMs: Schema.natural(),
})

export interface RoutingRule {
  /** Regex pattern to match against user input. */
  pattern: string
  /** Target realm for matching requests. */
  realm: 'LOCAL' | 'CLOUD' | 'SANITIZED' | 'REJECT'
  /** Confidence threshold (0-1). */
  confidence: number
  /** Human-readable rationale. */
  rationale: string
}

export interface SanitizationRule {
  /** Regex pattern to match PII. */
  pattern: string
  /**
   * 可读的替换示例，仅用于文档与运维展示，**运行时不生效**。
   *
   * 可逆脱敏要求占位符在会话内唯一可还原，因此 `sanitizer-pipeline`
   * 一律自行生成 `[<PIITYPE>_<seq>]` 形式的占位符并忽略本字段。
   * 历史上本字段曾被误认为可配置（改了没有任何效果），现显式标记为
   * 可选 + 非生效（2026-08-30）。不可逆掩码走 `pii-utils.PII_MASKS`。
   */
  replacement?: string
  /** Data classification class. */
  dataClass: string
  /** PII type name (phone, email, etc.). */
  piiType: string
  /**
   * §7.106 (2026-10-23): keep the first N characters of the match in the
   * OUTBOUND text and mask only the tail. Rationale: when the PII *is* the
   * task payload, full masking cancels the task (measured 14:59: "query the
   * attribution of 17300969670" → cloud received `[PHONE_1]`, the model
   * replied "that is a placeholder", and re-sending the number re-masked it
   * forever). A phone's first 7 digits ARE the number band — they carry the
   * functional signal (province/city + carrier) while the last 4 are the
   * identity. Desanitize restores the tail exactly, so the user's own view
   * still shows the whole number.
   */
  keepPrefix?: number
}

export interface DataClassification {
  /** Classification class name. */
  class: 'public' | 'internal' | 'confidential' | 'secret'
  /** Default realm for this classification. */
  defaultRealm: 'LOCAL' | 'CLOUD' | 'SANITIZED'
  /** TTL in seconds for cached classifications. */
  ttlSeconds: number
}

export interface GlobalConstraints {
  /** Max cloud requests per minute. */
  maxCloudRequestsPerMinute: number
  /** Whether to require attestation for cloud requests. */
  requireAttestation: boolean
  /** Block all requests if TCB is compromised. */
  blockIfTcbCompromised: boolean
}

/** §7.108 (2026-10-24): intent-stage signal tables carried by the policy
 *  file (config/privacy-policy.json → stages.intent). All recognition
 *  surfaces — routing regex rules, jev intents, LLM categories AND the
 *  §7.107 no-web-need gate — merge these, so the operator teaches every
 *  tier about a new domain (e.g. 旅游攻略) by editing ONE file. */
export interface PolicyIntentStages {
  /** APPENDED to the built-in CLOUD keyword list (CLOUD_KEYWORDS_DEFAULT +
   *  patch config `stages.intent.cloudKeywords`). A word here means "this
   *  may leave the device" — it unlocks both the rules tier and the gate. */
  cloudKeywords?: string[]
  /** APPENDED to the built-in LOCAL entity list (密盒/ets/etscli…). */
  localEntities?: string[]
  /** Non-empty value REPLACES the LOCAL last-resort keyword list (same
   *  semantics as the `DSH_EDGE_INTENT_FALLBACK_KEYWORDS` env var). */
  fallbackKeywords?: string[]
  /** §7.109 (2026-10-24): semantic unlock threshold. When set, an LLM/jev
   *  CLOUD verdict at confidence >= this value passes the §7.107 gate
   *  WITHOUT a keyword/regex signal — the operator's declaration of trust
   *  in the classifier (semantic-level intent recognition, e.g.
   *  "规划黄山两日游怎么安排" needs public info but carries no keyword).
   *  Undefined (default) = keyword-only, §7.107 behaviour unchanged. The
   *  entity guardrail runs before the gate and still wins; every
   *  data-protection layer (sanitizer fail-closed, prompt-guard PII veto,
   *  td-bus rate limits) is untouched. */
  semanticCloudMinConfidence?: number
}

export interface PrivacyPolicy {
  version: string
  /** §7.92.3 (2026-09-23): Intent category specs. Single source of truth
   *  shared by:
   *  - intent-router.classifyWithLlm() → builds LLM prompt listing each
   *    category's `description` (replaces the hardcoded prompt block at
   *    intent-router.ts:1046-1048).
   *  - intent-router.classifyWithJev() → builds jev-intent → category map
   *    by iterating each category's `jevIntents` array (replaces the
   *    hardcoded JEV_INTENT_MAP_DEFAULT const).
   *  Operators extend by adding entries to either field; unknown jev-intent
   *  strings fall through to LLM (defensive). */
  categories?: IntentCategory[]
  /** §7.108 (2026-10-24): operator-configurable intent-stage signal tables
   *  (see PolicyIntentStages). Optional — policies predating v1.7.0 simply
   *  omit it and the built-in lists apply unchanged. Hot-reloadable. */
  stages?: { intent?: PolicyIntentStages }
  routingRules: RoutingRule[]
  sanitizationRules: SanitizationRule[]
  dataClassifications: DataClassification[]
  globalConstraints: GlobalConstraints
}

/** §7.92.3: One row per intent category. Used by both LLM (description)
 *  and jev (jevIntents) so they share a single taxonomy. */
export interface IntentCategory {
  /** Category id (matches Intent.category + RoutingRule.realm). */
  id: 'LOCAL' | 'CLOUD' | 'SANITIZED' | 'REJECT'
  /** Human-readable description used in the LLM classifier prompt
   *  (intent-router.classifyWithLlm). Replaces the previous hardcoded
   *  "本地文件操作..." / "知识问答..." block. */
  description: string
  /** Optional example queries — for human readability in the JSON file
   *  and future eval suites. NOT used at runtime. */
  examples?: string[]
  /** jev semantic intent labels that should map to this category.
   *  intent-router builds a flat `jevIntent → category` lookup at
   *  construction time by iterating every category's `jevIntents`. */
  jevIntents: string[]
}

export interface PrivacyPolicyService {
  reload(): Promise<void>
  get(): PrivacyPolicy
  getRoutingRules(): RoutingRule[]
  getSanitizationRules(): SanitizationRule[]
  getClassifications(): DataClassification[]
  getConstraints(): GlobalConstraints
  /** §7.92.3: returns the categories array (may be empty if the loaded
   *  policy predates v1.6.0). Callers must guard with a built-in
   *  fallback when the array is empty. */
  getCategories(): IntentCategory[]
  /** §7.108: the policy file's stages.intent section (undefined for
   *  policies predating v1.7.0). intent-router reads this LIVE per
   *  classify, so a hot-reload takes effect on the next turn. */
  getIntentStages(): PolicyIntentStages | undefined
  /** Match input against routing rules; returns first match or null. */
  matchRouting(text: string): RoutingRule | null
  /** Classify data based on patterns; returns classification class. */
  classifyData(text: string): string
  on(event: 'policy/loaded', listener: (policy: PrivacyPolicy) => void): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    privacyPolicy: PrivacyPolicyServiceImpl
  }
}

/**
 * Default policy used when no policy file exists or loading fails.
 */
const DEFAULT_POLICY: PrivacyPolicy = {
  // §7.92.3 (2026-09-23): bumped from '1.2.0' to '1.6.0' so the policy
  // file's getCategories() returns the new categories[] spec. The hardcoded
  // DEFAULT_POLICY below mirrors the v1.6.0 schema (categories added).
  version: '1.6.0',
  categories: [
    {
      id: 'LOCAL',
      description: '本地文件操作、设备控制、数学计算、系统管理',
      examples: ['帮我读一下文件', '看一下磁盘空间', '计算 1+1'],
      jevIntents: ['设备控制', '文件操作', 'device_control', 'file_ops'],
    },
    {
      id: 'CLOUD',
      description: '知识问答、聊天、创意写作、需要联网的任务',
      examples: ['今天北京天气', '翻译这段英文', '写一首诗'],
      jevIntents: ['知识问答', '通用咨询', '天气', '翻译', '新闻', '搜索', 'knowledge', 'weather', 'translation', 'news', 'search'],
    },
    {
      id: 'SANITIZED',
      description: '包含 PII 需先脱敏后路由（订单查询、账户管理、客服等含个人信息）',
      examples: ['查我的订单状态', '我的账户余额', '我要退款'],
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
      examples: ['rm -rf /', '我要投诉', '怎么告别人'],
      jevIntents: ['投诉', '法务咨询', '法律咨询', '举报', 'complaint', 'legal', 'legal_advice'],
    },
  ],
  routingRules: [
    // REJECT rules — must come first (first-match-wins)
    // Only business-dangerous operations; attack patterns handled by prompt-guard
    {
      pattern: '(导出|删除|清空|格式化).*(数据库|系统|磁盘|全部数据)',
      realm: 'REJECT',
      confidence: 0.9,
      rationale: 'Dangerous system operation',
    },
    {
      pattern: '(drop\\s+table|rm\\s+-rf|format\\s+[a-z]:|del\\s+/[fs])',
      realm: 'REJECT',
      confidence: 0.95,
      rationale: 'Destructive command pattern',
    },
    // LOCAL rules
    {
      pattern: '(本地|local|文件|file|计算|calculate|读取|写入)',
      realm: 'LOCAL',
      confidence: 0.8,
      rationale: 'Local operations stay on device',
    },
  ],
  sanitizationRules: PII_ORDER.map((piiType) => ({
    pattern: PII_PATTERNS[piiType],
    dataClass: PII_DATA_CLASS[piiType],
    piiType,
    // §7.106: band-style PII keeps its coarse prefix in the outbound text
    // (phone: 7-digit number band = attribution signal; id-card: 6-digit
    // region code), only the identifying tail becomes a placeholder.
    // Everything else stays fully masked — a partial prefix is only
    // meaningful for band-structured PII.
    ...(piiType === 'phone' ? { keepPrefix: 7 } : piiType === 'id-card' ? { keepPrefix: 6 } : {}),
  })),
  dataClassifications: [
    { class: 'public', defaultRealm: 'CLOUD', ttlSeconds: 3600 },
    { class: 'internal', defaultRealm: 'SANITIZED', ttlSeconds: 1800 },
    { class: 'confidential', defaultRealm: 'LOCAL', ttlSeconds: 900 },
    { class: 'secret', defaultRealm: 'LOCAL', ttlSeconds: 300 },
  ],
  globalConstraints: {
    maxCloudRequestsPerMinute: 20,
    requireAttestation: false,
    blockIfTcbCompromised: true,
  },
}

/** Policy change listener — variadic on purpose (emit passes per-event
 *  payloads); `any[]` keeps call-site variance permissive. */
export type PolicyListener = (...args: any[]) => unknown

export class PrivacyPolicyServiceImpl extends Service implements PrivacyPolicyService {
  private policy: PrivacyPolicy = DEFAULT_POLICY
  private lastMtime: number = 0
  private watchTimer: ReturnType<typeof setInterval> | undefined
  private listeners = new Map<string, Set<PolicyListener>>()
  /**
   * HMAC-SHA256 key for policy file signature verification. Read once at
   * construction from `DSH_EDGE_POLICY_HMAC_KEY`. When set, every reload
   * (initial + hot-reload) verifies `<policyPath>.sig` contains
   * `hex(hmac_sha256(policyBody, key))`. Empty/undefined disables the
   * check (dev/CI default) and emits `policy.signing.disabled` audit.
   */
  private readonly hmacKey: string | undefined

  constructor(
    ctx: any,
    private config: Config,
    private auditLog: any,
  ) {
    super(ctx, 'privacyPolicy')
    this.hmacKey = process.env.DSH_EDGE_POLICY_HMAC_KEY?.trim() || undefined
  }

  /** Start the policy loader and optional hot-reload watcher. */
  async start(): Promise<void> {
    await this.reload()
    if (this.config.hotReload) {
      this.watchTimer = setInterval(() => {
        void this.checkForUpdates()
      }, this.config.watchIntervalMs)
      if (typeof this.watchTimer.unref === 'function') this.watchTimer.unref()
    }
  }

  /** Stop the hot-reload watcher. */
  stop(): void {
    if (this.watchTimer) {
      clearInterval(this.watchTimer)
      this.watchTimer = undefined
    }
  }

  /** Reload the policy from disk. */
  async reload(): Promise<void> {
    const path = this.config.policyPath
    if (!existsSync(path)) {
      await this.audit('warn', 'policy.missing', { path })
      this.policy = DEFAULT_POLICY
      this.emit('policy/loaded', this.policy)
      return
    }
    try {
      const raw = await readFile(path, 'utf-8')

      // Signature verification (fail-closed on tamper). Only runs when
      // DSH_EDGE_POLICY_HMAC_KEY is set. On mismatch: keep the in-memory
      // policy, audit 'security', do NOT update lastMtime so the same
      // tampered mtime does not re-trigger every poll.
      if (this.hmacKey) {
        const sigPath = `${path}.sig`
        if (!existsSync(sigPath)) {
          await this.audit('security', 'policy.tamper-detected', {
            path, reason: 'signature-file-missing', sigPath,
          })
          return
        }
        let sigOk = false
        try {
          const sigRaw = await readFile(sigPath, 'utf-8')
          sigOk = this.verifySignature(raw, sigRaw)
        } catch (err: any) {
          await this.audit('security', 'policy.tamper-detected', {
            path, reason: 'signature-read-failed', error: err?.message ?? String(err),
          })
          return
        }
        if (!sigOk) {
          await this.audit('security', 'policy.tamper-detected', {
            path, reason: 'hmac-mismatch',
          })
          return
        }
      } else {
        // First time we observe the "signing disabled" state — emit once
        // so operators know the dev/CI default is in effect.
        if (!this.signingDisabledEmitted) {
          this.signingDisabledEmitted = true
          await this.audit('info', 'policy.signing.disabled', {
            hint: 'set DSH_EDGE_POLICY_HMAC_KEY to enable tamper detection',
          })
        }
      }

      const parsed = JSON.parse(raw) as PrivacyPolicy
      // Basic validation
      if (!parsed.version || !Array.isArray(parsed.routingRules)) {
        throw new Error('Invalid policy structure')
      }
      this.policy = parsed
      const stats = await stat(path)
      this.lastMtime = stats.mtimeMs
      await this.audit('info', 'policy.loaded', { path, version: parsed.version })
      this.emit('policy/loaded', this.policy)
    } catch (err: any) {
      await this.audit('error', 'policy.load-failed', { path, error: err.message })
      this.policy = DEFAULT_POLICY
      this.emit('policy/loaded', this.policy)
    }
  }

  /**
   * HMAC-SHA256 verification using `node:crypto.timingSafeEqual`.
   * Returns true iff `sigRaw` (hex) equals HMAC-SHA256(raw, hmacKey).
   * Lenient on whitespace / case in `sigRaw` to keep operator workflow
   * (`sha256sum policy.json | openssl dgst -hmac KEY -hex`) forgiving.
   */
  private verifySignature(raw: string, sigRaw: string): boolean {
    if (!this.hmacKey) return true
    const expected = createHmac('sha256', this.hmacKey).update(raw, 'utf-8').digest()
    const cleaned = sigRaw.trim().replace(/^0x/u, '').replace(/\s+/gu, '').toLowerCase()
    if (!/^[0-9a-f]+$/u.test(cleaned)) return false
    if (cleaned.length !== expected.length * 2) return false
    let actual: Buffer
    try {
      actual = Buffer.from(cleaned, 'hex')
    } catch {
      return false
    }
    try {
      return timingSafeEqual(expected, actual)
    } catch {
      return false
    }
  }

  /** Latch so the dev/CI "signing disabled" audit fires at most once. */
  private signingDisabledEmitted = false

  /** Check if the policy file has been modified and reload if needed. */
  private async checkForUpdates(): Promise<void> {
    const path = this.config.policyPath
    if (!existsSync(path)) return
    try {
      const stats = await stat(path)
      if (stats.mtimeMs > this.lastMtime) {
        await this.reload()
      }
    } catch {
      // Ignore stat errors
    }
  }

  get(): PrivacyPolicy {
    return this.policy
  }

  getRoutingRules(): RoutingRule[] {
    return this.policy.routingRules
  }

  getSanitizationRules(): SanitizationRule[] {
    return this.policy.sanitizationRules
  }

  getClassifications(): DataClassification[] {
    return this.policy.dataClassifications
  }

  getConstraints(): GlobalConstraints {
    return this.policy.globalConstraints
  }

  /** §7.92.3 (2026-09-23): returns the intent categories spec table.
   *  Falls back to [] when the loaded policy predates v1.6.0 — callers
   *  must guard with their own built-in defaults in that case. */
  getCategories(): IntentCategory[] {
    return this.policy.categories ?? []
  }

  /** §7.108: live view of the policy file's stages.intent section. */
  getIntentStages(): PolicyIntentStages | undefined {
    return this.policy?.stages?.intent
  }

  /** Match input against routing rules; returns first match or null. */
  matchRouting(text: string): RoutingRule | null {
    for (const rule of this.policy.routingRules) {
      try {
        const regex = new RegExp(rule.pattern, 'i')
        if (regex.test(text)) {
          return rule
        }
      } catch {
        // Invalid regex, skip
      }
    }
    return null
  }

  /** Classify data based on sanitization rules; returns the highest classification. */
  classifyData(text: string): string {
    const classOrder = ['public', 'internal', 'confidential', 'secret']
    let highest = 'public'
    for (const rule of this.policy.sanitizationRules) {
      try {
        const regex = new RegExp(rule.pattern, 'i')
        if (regex.test(text)) {
          const idx = classOrder.indexOf(rule.dataClass)
          const highestIdx = classOrder.indexOf(highest)
          if (idx > highestIdx) {
            highest = rule.dataClass
          }
        }
      } catch {
        // Invalid regex, skip
      }
    }
    return highest
  }

  on(event: string, listener: PolicyListener): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set())
    }
    this.listeners.get(event)!.add(listener)
  }

  private emit(event: string, ...args: any[]): void {
    const listeners = this.listeners.get(event)
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(...args)
        } catch {
          // Ignore listener errors
        }
      }
    }
  }

  private async audit(level: string, kind: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.auditLog?.log) return
    try {
      await this.auditLog.log({ level, kind, source: 'privacy-policy', payload })
    } catch {
      // Ignore audit errors
    }
  }
}

export async function apply(ctx: any, config: Config): Promise<() => Promise<void>> {
  // §7.102: fill unset fields from config/edge.json (privacy.*).
  const p = loadEdgeConfig().privacy
  const c = config as Partial<Config>
  if (c.policyPath === undefined) {
    // §7.107 (2026-10-23): the operator's copy under ~/.dsh-edge-agent/
    // wins, but a released bundle also ships its own config/privacy-policy
    // .json — without this fallback an npm/desktop install ran on the
    // 3-rule in-code DEFAULT_POLICY (no credential / PII-stays-local
    // routing rules) because nothing ever copied the shipped policy
    // there. The bundle's own copy is the shipped truth; the operator's
    // copy is the override.
    const operatorCopy = edgeHome('privacy-policy.json')
    const shippedCopy = join(edgeBundleRoot(), 'config', 'privacy-policy.json')
    c.policyPath = p?.policyPath && p.policyPath.length > 0
      ? p.policyPath
      : existsSync(operatorCopy) ? operatorCopy : shippedCopy
  }
  if (c.hotReload === undefined && p?.policyHotReload !== undefined) c.hotReload = p.policyHotReload
  if (c.watchIntervalMs === undefined && p?.policyWatchMs !== undefined) c.watchIntervalMs = p.policyWatchMs
  const auditLog = ctx.get('auditLog')
  const service = new PrivacyPolicyServiceImpl(ctx, config, auditLog)
  await service.start()
  return async () => {
    service.stop()
  }
}
