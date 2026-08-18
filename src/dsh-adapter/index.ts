/**
 * Main plugin entry — wires the dsh-edge-agent package together as a single
 * Cordis plugin that mounts the privacy stack into a host context.
 *
 * Plugin surface (consumer of `@deepseek-ai/*`):
 *   - name: 'dsh-edge-agent'
 *   - inject: soft dependencies on core DSH services
 *   - Config: full schemastery schema (matches cordis.yml row)
 *   - apply: orchestrates the ordering of subordinate plugins (tcm,
 *     privacy-policy, intent-router, prompt-guard, td-bus, etc.)
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dsh-edge-agent'

export const inject = [
  'agents',
  'llm',
  'tools',
  'sessions',
  'invariants',
] as const

export interface Config {
  /** TEE backend preference. Platform-dependent; auto-detected when omitted. */
  teeType?: 'simulated' | 'trustzone' | 'keystone' | 'sgx'
  /** Path to the encrypted storage root. */
  storageRoot?: string
  /** Privacy policy file path. Hot-reloaded on change. */
  policyPath?: string
  /** Default privacy posture when the policy engine cannot classify. */
  defaultDataLevel?: 'public' | 'sanitized' | 'internal'
  /** Allow outbound OHTTP requests even when the relay is unreachable. */
  allowFallbackTls?: boolean
  /** Number of recent turns to keep in the conversation slice. */
  sessionWindowSize?: number
}

export const Config: Schema<Config> = Schema.object({
  teeType: Schema.union([
    'simulated',
    'trustzone',
    'keystone',
    'sgx',
  ] as const).description('TEE backend preference; auto-detected when omitted.'),
  storageRoot: Schema.string().description('Path to the encrypted storage root (resolved at runtime).'),
  policyPath: Schema.string().description('Privacy policy file path. Hot-reloaded on change.'),
  defaultDataLevel: Schema.union(['public', 'sanitized', 'internal'] as const)
    .description('Default privacy posture when the policy engine cannot classify.'),
  allowFallbackTls: Schema.boolean().description('Allow outbound OHTTP requests even when the relay is unreachable.'),
  sessionWindowSize: Schema.natural().description('Number of recent turns to keep in the conversation slice.'),
})

export async function apply(ctx: Context, config: Config): Promise<void> {
  // 1. Drift check — warn at boot when upstream DSH has moved.
  const { upstreamDrift } = await import('./contract.ts')
  for (const entry of await upstreamDrift()) {
    console.warn(`[dsh-edge-agent] upstream drift: ${entry.pkg} has ${entry.installed} (expected ${entry.expected})`)
  }

  // 2. Delegate to the real implementation under plugin.ts.
  const { apply: bootstrap } = await import('./plugin.ts')
  return bootstrap(ctx, config)
}

// Convenience: re-export the canonical subpath plugins so that consumers
// who `import '@deepseek-harness-edge-agent/dsh-edge-agent'` can also
// pull individual cordis rows out of the same module.
export * from './tcm.ts'
export * from './local-storage.ts'
export * from './sessions.ts'
export * from './audit-log.ts'
export * from './privacy-policy.ts'
export * from './tools.ts'
export * from './prompt-guard.ts'
export * from './intent-router.ts'
export * from './model-router.ts'
export * from './local-llm-adapter.ts'
export * from './cloud-llm-adapter.ts'
export * from './sanitizer-pipeline.ts'
export * from './ohttp-gateway.ts'
export * from './secure-bridge.ts'
export * from './attestation.ts'
export * from './td-bus.ts'
export * from './local-tools.ts'
export * from './web-search.ts'
export * from './voice-input.ts'
export * from './plugin-host.ts'
export * from './http-api.ts'
export * from './llm-adapters.ts'
