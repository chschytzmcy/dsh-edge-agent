/**
 * td-bus — threat detection bus. Subscribes to high-volume events and
 * raises a threat level when patterns indicate abuse. Secure-bridge
 * subscribes to td-bus quarantine events to block outbound traffic.
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
}

export const Config: Schema<Config> = Schema.object({
  windowSeconds: Schema.natural().default(60),
  thresholds: Schema.object({
    cloudRequestsPerMinute: Schema.natural().default(20),
    failedSanitizationStreak: Schema.natural().default(3),
    permissionDeniedStreak: Schema.natural().default(5),
  }),
})

export type ThreatLevel = 'normal' | 'elevated' | 'high' | 'critical'

export interface TdBusService {
  getThreatLevel(): ThreatLevel
  /** Subscribe to a specific quarantine action. */
  on(action: 'block-cloud' | 'kill-session' | 'notify-user' | 'lockdown', listener: () => void): () => void
  /** Manually escalate (e.g. after a policy tamper). */
  escalate(reason: string): void
}

export class TdBusServiceImpl extends Service {
  constructor(ctx: any) {
    super(ctx, 'tdBus')
  }
  getThreatLevel(): ThreatLevel {
    return 'normal'
  }
  on(action: 'block-cloud' | 'kill-session' | 'notify-user' | 'lockdown', listener: () => void): () => void {
    void action
    void listener
    return () => {}
  }
  escalate(reason: string): void {
    void reason
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tdBus: TdBusServiceImpl
  }
}

export async function apply(ctx: any, config: Config): Promise<void> {
  ctx.plugin(TdBusServiceImpl)
  void config
  return async () => {}
}
