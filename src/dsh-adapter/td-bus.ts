/**
 * td-bus — threat detection bus.
 *
 * Phase D: real threat-level state machine. Subscribes to high-volume
 * audit events and raises a threat level when patterns indicate abuse.
 * The http-api plugin reads `getThreatLevel()` and blocks incoming
 * `/v1/chat` requests when the level reaches the configured block
 * threshold (default: 'critical', env DSH_EDGE_TD_BLOCK_LEVEL).
 *
 * Phase D decision matrix (frequency-driven):
 *   requests/min in window   threat level
 *   ≥ thresholds.cloud...    elevated
 *   ≥ 2 × thresholds...      high
 *   ≥ 4 × thresholds...      critical  ← blockLevel default
 *
 * Other streams (failed-sanitization streak, permission-denied streak)
 * are reserved for future escalation; Phase D only ships the cloud-
 * requests-per-minute counter.
 *
 * @module dsh-edge-agent/td-bus
 */

import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { loadEdgeConfig } from './edge-config.js'

export const name = 'td-bus'

export const inject = ['auditLog', 'privacyPolicy'] as const

export interface Config {
  windowSeconds: number
  thresholds: {
    /** §7.102: unset → filled from config/edge.json (threat.cloudRate),
     *  else the constructor literal 20. */
    cloudRequestsPerMinute?: number
    failedSanitizationStreak: number
    permissionDeniedStreak: number
  }
  /** Phase D: threat level at which the bus asks upstream plugins to
   *  block (e.g. http-api returns 503). §7.102: unset → edge.json
   *  (threat.blockLevel), else the constructor literal 'critical'. */
  blockLevel?: 'elevated' | 'high' | 'critical'
}

export const Config: Schema<Config> = Schema.object({
  windowSeconds: Schema.natural().default(60),
  // §7.102: cloudRequestsPerMinute / blockLevel carry no Schema default so
  // apply()'s config/edge.json (threat.*) fill can tell "row omitted it"
  // from "row pinned it" (the full patch pins 8 deliberately). The
  // constructor keeps the ?? 20 / ?? 'critical' literals as last resort.
  thresholds: Schema.object({
    cloudRequestsPerMinute: Schema.natural(),
    failedSanitizationStreak: Schema.natural().default(3),
    permissionDeniedStreak: Schema.natural().default(5),
  }),
  blockLevel: Schema.union(['elevated', 'high', 'critical'] as const),
})

export type ThreatLevel = 'normal' | 'elevated' | 'high' | 'critical'

export interface TdBusService {
  getThreatLevel(): ThreatLevel
  /** Subscribe to a specific quarantine action. */
  on(action: 'block-cloud' | 'kill-session' | 'notify-user' | 'lockdown', listener: () => void): () => void
  /** Manually escalate (e.g. after a policy tamper). */
  escalate(reason: string): void
  /** Operator-facing解除 sticky 升级：escalate() 曾把等级永久钉死在
   *  critical（Phase D 无 reset 路径）。清空 sticky 与滑动窗口，回落
   *  normal；新流量按窗口重新累计。 */
  reset(reason: string): void
  /** Phase D: ingest one cloud-bypass event (called by http-api / upstream). */
  recordCloudRequest(): void
}

export class TdBusServiceImpl extends Service {
  private readonly windowMs: number
  private readonly cloudThreshold: number
  // Concrete union: the constructor's `?? 'critical'` guarantees a value
  // even though the Config field is optional (§7.102 fill chain).
  private readonly blockLevel: 'elevated' | 'high' | 'critical'
  private currentLevel: ThreatLevel = 'normal'
  /** When set, recomputeLevel() will not drop below this floor. Set by
   *  escalate(); cleared only when the sliding window fully decays. */
  private stickyLevel: ThreatLevel | null = null
  /** Sliding-window timestamps of cloud requests. */
  private readonly cloudHits: number[] = []
  private readonly listeners = new Map<TdBusService extends never ? never : Parameters<TdBusService['on']>[0], Set<() => void>>()

  constructor(ctx: any, config?: Config) {
    super(ctx, 'tdBus')
    this.windowMs = (config?.windowSeconds ?? 60) * 1000
    this.cloudThreshold = config?.thresholds.cloudRequestsPerMinute ?? 20
    this.blockLevel = config?.blockLevel ?? 'critical'
  }

  /** Recompute threat level from the current window. Called after each
   *  recordCloudRequest() and from getThreatLevel(). Decay: cloudHits
   *  older than windowMs are shifted out first, so the count reflects
   *  only fresh events. */
  private recomputeLevel(): void {
    const now = Date.now()
    while (this.cloudHits.length > 0 && now - this.cloudHits[0]! > this.windowMs) {
      this.cloudHits.shift()
    }
    const count = this.cloudHits.length
    let next: ThreatLevel = 'normal'
    if (count >= this.cloudThreshold * 4) next = 'critical'
    else if (count >= this.cloudThreshold * 2) next = 'high'
    else if (count >= this.cloudThreshold) next = 'elevated'

    // Honor a manual sticky escalation: don't drop below it until the
    // operator explicitly resets (no API for reset in Phase D).
    if (this.stickyLevel) {
      const order: Record<ThreatLevel, number> = { normal: 0, elevated: 1, high: 2, critical: 3 }
      if (order[this.stickyLevel] > order[next]) next = this.stickyLevel
    }

    if (next !== this.currentLevel) {
      const prev = this.currentLevel
      this.currentLevel = next
      try {
        const auditLog = (this.ctx as any)?.auditLog
        auditLog?.log?.({
          level: next === 'critical' ? 'security' : 'warn',
          kind: 'td-bus.escalated',
          source: 'td-bus',
          payload: { from: prev, to: next, count, threshold: this.cloudThreshold },
        })?.catch?.(() => {})
      } catch { /* ignore */ }
    }
  }

  getThreatLevel(): ThreatLevel {
    // Each call triggers a re-decay so level reflects current window even
    // when no fresh traffic has come in (e.g. 60s after a burst).
    this.recomputeLevel()
    return this.currentLevel
  }

  on(action: 'block-cloud' | 'kill-session' | 'notify-user' | 'lockdown', listener: () => void): () => void {
    let set = this.listeners.get(action)
    if (!set) { set = new Set(); this.listeners.set(action, set) }
    set.add(listener)
    return () => { set!.delete(listener) }
  }

  escalate(reason: string): void {
    const prev = this.currentLevel
    this.currentLevel = 'critical'
    this.stickyLevel = 'critical'
    // Fire all registered listeners on manual escalation — operators
    // explicitly want upstream plugins (secure-bridge, http-api) to react.
    for (const set of this.listeners.values()) {
      for (const fn of set) { try { fn() } catch { /* ignore listener faults */ } }
    }
    try {
      const auditLog = (this.ctx as any)?.auditLog
      auditLog?.log?.({
        level: 'security',
        kind: 'td-bus.escalated',
        source: 'td-bus',
        payload: { from: prev, to: 'critical', reason },
      })?.catch?.(() => {})
    } catch { /* ignore */ }
  }

  recordCloudRequest(): void {
    this.cloudHits.push(Date.now())
    this.recomputeLevel()
  }

  reset(reason: string): void {
    const prev = this.currentLevel
    this.stickyLevel = null
    this.cloudHits.length = 0
    this.currentLevel = 'normal'
    try {
      const auditLog = (this.ctx as any)?.auditLog
      auditLog?.log?.({
        level: 'info',
        kind: 'td-bus.reset',
        source: 'td-bus',
        payload: { from: prev, to: 'normal', reason },
      })?.catch?.(() => {})
    } catch { /* ignore */ }
  }

  /** Phase D: helper for http-api to decide whether to deny the request.
   *  Returns true iff current level is at or above the configured blockLevel. */
  shouldBlock(): boolean {
    const order: Record<ThreatLevel, number> = { normal: 0, elevated: 1, high: 2, critical: 3 }
    return order[this.getThreatLevel()] >= order[this.blockLevel]
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tdBus: TdBusServiceImpl
  }
}

export async function apply(ctx: any, config: Config): Promise<() => Promise<void>> {
  // §7.102: the thresholds come from config/edge.json (threat.*). The
  // cordis patch row no longer reads process.env — the desktop GUI never
  // had those variables.
  // Fill-only-if-absent: a profile row may pin a deliberate value (the
  // full patch runs cloudRequestsPerMinute=8, tighter than the shared
  // file default) and that explicit wiring must win over edge.json.
  const threat = loadEdgeConfig().threat
  if (threat) {
    const thresholds = (config as { thresholds?: { cloudRequestsPerMinute?: number } }).thresholds
    if (thresholds && thresholds.cloudRequestsPerMinute === undefined && threat.cloudRate !== undefined) {
      thresholds.cloudRequestsPerMinute = threat.cloudRate
    }
    if ((config as { blockLevel?: string }).blockLevel === undefined && threat.blockLevel !== undefined) {
      (config as { blockLevel: 'elevated' | 'high' | 'critical' }).blockLevel =
        threat.blockLevel as 'elevated' | 'high' | 'critical'
    }
  }
  const service = new TdBusServiceImpl(ctx, config)
  // Register the instance on ctx so other plugins can resolve it via
  // ctx.get('tdBus') (Cordis convention for subpath services).
  ;(ctx as any).tdBus = service
  void config
  // 惯例对齐：其余插件的 apply 都返回真 dispose。这里原先返回空函数 —
  // 插件 reload 后旧 service 既不注销、属性也悬空。
  return async () => {
    try { (service as unknown as { dispose?: () => void }).dispose?.() } catch { /* best-effort */ }
    if ((ctx as any).tdBus === service) (ctx as any).tdBus = undefined
  }
}