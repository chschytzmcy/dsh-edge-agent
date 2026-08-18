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

export async function apply(ctx: Context, config: Config): Promise<() => Promise<void>> {
  // 1. Drift check — warn at boot when upstream DSH has moved.
  const { upstreamDrift } = await import('./contract.js')
  for (const entry of await upstreamDrift()) {
    console.warn(`[dsh-edge-agent] upstream drift: ${entry.pkg} has ${entry.installed} (expected ${entry.expected})`)
  }

  // 2. Delegate to the real implementation under plugin.ts.
  const { apply: bootstrap } = await import('./plugin.js')
  return bootstrap(ctx, config)
}

// Convenience: re-export the canonical subpath plugins so that consumers
// who `import '@deepseek-harness-edge-agent/dsh-edge-agent'` can also
// pull individual cordis rows out of the same module.
export * from './tcm.js'
export * from './local-storage.js'
export * from './sessions.js'
export * from './audit-log.js'
export * from './privacy-policy.js'
export * from './tools.js'
export * from './prompt-guard.js'
export * from './intent-router.js'
export * from './model-router.js'
export * from './local-llm-adapter.js'
export * from './cloud-llm-adapter.js'
export * from './sanitizer-pipeline.js'
export * from './ohttp-gateway.js'
export * from './secure-bridge.js'
export * from './attestation.js'
export * from './td-bus.js'
export * from './local-tools.js'
export * from './web-search.js'
export * from './voice-input.js'
export * from './plugin-host.js'
export * from './http-api.js'
export * from './llm-adapters.js'
