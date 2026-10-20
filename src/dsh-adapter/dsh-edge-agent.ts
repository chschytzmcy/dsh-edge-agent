/**
 * dsh-edge-agent — host-half bootstrap plugin.
 *
 * The `name='dsh-edge-agent'` row is the aggregate plugin that cordis
 * 0.2.1-rc.2 mounts when the patch row uses the bare package name
 * `name: '@scope/pkg'`. The package root (`@scope/pkg`) must re-export
 * this module so `require('@scope/pkg')` resolves to it via `package.json#main`.
 *
 * Lives inside `src/dsh-adapter/` to keep the adapter boundary clean:
 * the package root (`src/index.ts`) must NOT import `@deepseek-ai/*` directly,
 * because `verify-adapter-boundary` restricts upstream-package imports to the
 * `src/dsh-adapter/` subtree only. The flat-layout move (commit `1d6b9a7`)
 * promoted this plugin from `src/dsh-adapter/index.ts` to the package root,
 * which immediately tripped the gate — moving the plugin body back into the
 * adapter subtree restores the invariant without changing the runtime layout
 * (`lib/index.js` is still the compiled package root, the plugin code just
 * lives in a different source file).
 *
 * Plugin surface (consumer of `@deepseek-ai/*`):
 *   - name:    'dsh-edge-agent'
 *   - inject:  ['auditLog', 'localStorage'] — required so `plugin.ts`
 *              can capture shutdown disposers via `auditLogShutdown(ctx)`
 *              / `storageShutdown(ctx)`. Subordinate plugins each declare
 *              their own inject in their own file.
 *   - Config:  full schemastery schema (matches cordis.yml row)
 *   - apply:   installFileLogger → upstreamDrift warning → plugin bootstrap
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dsh-edge-agent'

// The aggregator needs `auditLog` only. `plugin.ts#apply` reads
// `ctx.auditLog` (via `auditLogShutdown(ctx)`) and `ctx.localStorage` (via
// `storageShutdown(ctx)`), but both calls are wrapped in try/catch in
// `plugin.ts` itself, so we don't need to declare `localStorage` here.
// Declaring `localStorage` would make cordis hang waiting for a service
// the desktop-safe patch does not insert, producing the
// "pending (waiting for service: localStorage)" error.
export const inject = ['auditLog'] as const

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
  const { installFileLogger } = await import('./file-logger.js')
  installFileLogger(ctx)

  // 1. Drift check — warn at boot when upstream DSH has moved.
  const { upstreamDrift } = await import('./contract.js')
  for (const entry of await upstreamDrift()) {
    ctx.logger?.warn?.(`[dsh-edge-agent] upstream drift: ${entry.pkg} has ${entry.installed} (expected ${entry.expected})`)
  }

  // 2. Delegate to the real implementation under plugin.ts.
  const { apply: bootstrap } = await import('./plugin.js')
  return bootstrap(ctx, config)
}