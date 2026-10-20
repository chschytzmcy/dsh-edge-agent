/**
 * dsh-edge-agent — main entry (flat layout, matching dsh-context's pattern).
 *
 * The `name='dsh-edge-agent'` plugin is the host half that cordis 0.2.1-rc.2
 * patch loader mounts when `name: '@scope/pkg'` is used in cordis patch.
 * For the loader to find this file, `package.json#main` must point at it
 * AND its `lib/` directory must hold it directly (not under lib/types/).
 *
 * Per docs/dev-notes/cordis-rc021-patch-loader.md: cordis 0.2.1-rc.2
 * expects a flat `lib/index.js` layout (matches dsh-context); a dotted
 * `lib/types/index.js` layout (our previous shape) is silently misrouted
 * to `lib/types/dsh-adapter/<plugin>.js` — the loader treats lib/types/
 * as the plugin subdirectory, not the host-half container. The internal
 * adapter code still lives under `src/dsh-adapter/` and is compiled into
 * `lib/dsh-adapter/` so consumers can `import '@scope/pkg/audit-log'`
 * etc. — only the host-half bootstrap has been flattened to `lib/index.js`.
 *
 * Plugin surface (consumer of `@deepseek-ai/*`):
 *   - name: 'dsh-edge-agent'
 *   - inject: NONE — apply() only bootstraps the privacy stack; each
 *     subordinate plugin declares its own inject in its own file.
 *   - Config: full schemastery schema (matches cordis.yml row)
 *   - apply: installFileLogger + upstreamDrift + plugin bootstrap
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dsh-edge-agent'

// Empty inject — see header. The bundle's host-half bootstrap does not
// depend on any service at apply() time. Subordinate plugins each
// declare their own deps in their own .ts files. Mirrors dsh-context's
// pattern (its inject is `['sessionProjections']` because it needs a
// projection store; ours does not because we install our own ring buffer).
export const inject = [] as const

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
  // 0. Install the file-logger exporter (see ./file-logger.ts).
  const { installFileLogger } = await import('./dsh-adapter/file-logger.js')
  installFileLogger(ctx)

  // 1. Drift check — warn at boot when upstream DSH has moved.
  const { upstreamDrift } = await import('./dsh-adapter/contract.js')
  for (const entry of await upstreamDrift()) {
    ctx.logger?.warn?.(`[dsh-edge-agent] upstream drift: ${entry.pkg} has ${entry.installed} (expected ${entry.expected})`)
  }

  // 2. Delegate to the real implementation under plugin.ts.
  const { apply: bootstrap } = await import('./dsh-adapter/plugin.js')
  return bootstrap(ctx, config)
}

// Convenience: re-export the canonical subpath plugins so that consumers
// who `import '@deepseek-harness-edge-agent/dsh-edge-agent'` can also
// pull individual cordis rows out of the same module.
export * from './dsh-adapter/tcm.js'
export * from './dsh-adapter/local-storage.js'
export * from './dsh-adapter/sessions.js'
export * from './dsh-adapter/audit-log.js'
export * from './dsh-adapter/privacy-policy.js'
export * from './dsh-adapter/tools.js'
export * from './dsh-adapter/realm-skill-bridge.js'
export * from './dsh-adapter/prompt-guard.js'
export * from './dsh-adapter/intent-router.js'
export * from './dsh-adapter/model-router.js'
export * from './dsh-adapter/local-llm-adapter.js'
export * from './dsh-adapter/cloud-llm-adapter.js'
export * from './dsh-adapter/sanitizer-pipeline.js'
export * from './dsh-adapter/ohttp-gateway.js'
export * from './dsh-adapter/secure-bridge.js'
export * from './dsh-adapter/attestation.js'
export * from './dsh-adapter/td-bus.js'
export * from './dsh-adapter/voice-input.js'
export * from './dsh-adapter/plugin-host.js'
export { name as httpApiName, inject as httpApiInject, Config as HttpApiConfig, HttpApiServiceImpl, apply as httpApiApply } from './dsh-adapter/http-api.js'
export type { HttpApiService } from './dsh-adapter/http-api.js'
export * from './dsh-adapter/llm-adapters.js'
export * from './dsh-adapter/edge-context-view.js'