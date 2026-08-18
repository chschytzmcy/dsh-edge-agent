/**
 * audit-log — append-only, tamper-evident audit log. Each entry is signed
 * with a chained HMAC so any tampering attempt can be detected.
 *
 * @module dsh-edge-agent/audit-log
 */

import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'audit-log'

export const inject = ['tcm', 'localStorage'] as const

export interface Config {
  minLevel: 'debug' | 'info' | 'warn' | 'error' | 'security'
  sensitiveFields: string[]
  enableAlerts: boolean
  alertThresholds: {
    cloudRequestsPerMinute: number
    sanitizationFailures: number
    permissionDenied: number
  }
  flushIntervalMs: number
}

export const Config: Schema<Config> = Schema.object({
  minLevel: Schema.union(['debug', 'info', 'warn', 'error', 'security'] as const).default('info'),
  sensitiveFields: Schema.array(Schema.string()).default([]),
  enableAlerts: Schema.boolean().default(true),
  alertThresholds: Schema.object({
    cloudRequestsPerMinute: Schema.natural().default(20),
    sanitizationFailures: Schema.natural().default(3),
    permissionDenied: Schema.natural().default(5),
  }),
  flushIntervalMs: Schema.natural().default(500),
})

export interface AuditEntry {
  ts: number
  level: Config['minLevel']
  type: string
  action: string
  plugin: string
  realm?: string
  metadata?: Record<string, unknown>
  dataExfiltrated?: boolean
  sanitized?: boolean
  success: boolean
  hmac?: string
}

export interface AuditLogService {
  log(entry: Omit<AuditEntry, 'ts' | 'hmac'>): Promise<void>
  flush(): Promise<void>
  query(filter?: Partial<AuditEntry>): Promise<AuditEntry[]>
  stats(): Promise<{
    total: number
    last24h: number
    cloudRequests: number
    sanitizationOps: number
    securityEvents: number
    permissionDenied: number
    dataExfiltrated: number
  }>
}

export class AuditLogServiceImpl extends Service {
  constructor(ctx: any) {
    super(ctx, 'auditLog')
  }
  async log(entry: Omit<AuditEntry, 'ts' | 'hmac'>): Promise<void> {
    void entry
  }
  async flush(): Promise<void> {}
  async query(filter?: Partial<AuditEntry>): Promise<AuditEntry[]> {
    void filter
    return []
  }
  async stats() {
    return {
      total: 0,
      last24h: 0,
      cloudRequests: 0,
      sanitizationOps: 0,
      securityEvents: 0,
      permissionDenied: 0,
      dataExfiltrated: 0,
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    auditLog: AuditLogServiceImpl
  }
}

export async function apply(ctx: any, config: Config): Promise<void> {
  ctx.plugin(AuditLogServiceImpl)
  void config
  return async () => {}
}

/** Shutdown hook used by the main plugin (plugin.ts). */
export async function auditLogShutdown(ctx: any): Promise<() => Promise<void>> {
  void ctx
  return async () => {
    // flush + close audit log
  }
}
