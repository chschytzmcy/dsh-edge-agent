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

export const name = 'td-bus'

export const inject = ['auditLog', 'privacyPolicy'] as const

export interface Config {
  windowSeconds: number
  thresholds: {
    cloudRequestsPerMinute: number
    failedSanitizationStreak: number
    permissionDeniedStreak: number
  }
  /** Phase D: threat level at which the bus asks upstream plugins to
   *  block (e.g. http-api returns 503). Default 'critical'. */
  blockLevel: 'elevated' | 'high' | 'critical'
}

export const Config: Schema<Config> = Schema.object({
  windowSeconds: Schema.natural().default(60),
  thresholds: Schema.object({
    cloudRequestsPerMinute: Schema.natural().default(20),
    failedSanitizationStreak: Schema.natural().default(3),
    permissionDeniedStreak: Schema.natural().default(5),
  }),
  blockLevel: Schema.union(['elevated', 'high', 'critical'] as const)
    .default('critical'),
})

export type ThreatLevel = 'normal' | 'elevated' | 'high' | 'critical'

export interface TdBusService {
  getThreatLevel(): ThreatLevel
  /** Subscribe to a specific quarantine action. */
  on(action: 'block-cloud' | 'kill-session' | 'notify-user' | 'lockdown', listener: () => void): () => void
  /** Manually escalate (e.g. after a policy tamper). */
  escalate(reason: string): void
  /** Phase D: ingest one cloud-bypass event (called by http-api / upstream). */
  recordCloudRequest(): void
}

export class TdBusServiceImpl extends Service {
  private readonly windowMs: number
  private readonly cloudThreshold: number
  private readonly blockLevel: Config['blockLevel']
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
  const service = new TdBusServiceImpl(ctx, config)
  // Register the instance on ctx so other plugins can resolve it via
  // ctx.get('tdBus') (Cordis convention for subpath services).
  ;(ctx as any).tdBus = service
  void config
  return async () => {}
}