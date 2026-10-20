/**
 * Main plugin entry — wires the dsh-edge-agent package together as a single
 * Cordis plugin that mounts the privacy stack into a host context.
 *
 * Plugin surface (consumer of `@deepseek-ai/*`):
 *   - name: 'dsh-edge-agent'
 *   - inject: NONE — this entry is only the bundle's host half bootstrap.
 *     apply() does NOT depend on `agents`/`llm`/`tools`/`sessions`/`invariants`
 *     at the bundle top level. Each subordinate plugin declares its own
 *     inject in its own file (e.g. `audit-log`, `intent-router`, ...).
 *     Declaring deps here used to force cordis 0.2.1-rc.2 to hang pending
 *     `invariants` (which the desktop webui profile does not provide) —
 *     documented in docs/dev-notes/cordis-rc021-patch-loader.md.
 *   - Config: full schemastery schema (matches cordis.yml row)
 *   - apply: bootstraps the privacy stack and exposes sub-plugin
 *     re-exports so the package root can be loaded as a single Cordis
 *     plugin that mounts every sub-plugin via its own cordis.yml row.
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dsh-edge-agent'

// Empty inject — see above. Subordinate plugins each declare their own
// deps in their own .ts files; the bundle's host-half bootstrap does
// not need any service to start. Mirrors dsh-context's pattern (its
// inject is `['sessionProjections']` because it does need a projection
// store; ours does not because we install our own ring buffer).
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
  //
    // All dsh-edge-agent plugins log through `ctx.logger.*`; without an
    // external exporter those calls only land in Cordis's 1000-entry
    // in-memory ring buffer and are lost on exit. We register a file
    // exporter here, BEFORE any other plugin can call `ctx.logger.*` so
    // the drift warning (next step) and every boot diagnostic land on
    // disk. See `./file-logger.ts` for the persistence + rotation logic.
  //
  // - Gated by DSH_EDGE_LOG_FILE !== 'false' (default ON; tests opt out).
  // - "First-wins" guard: if the DSH host already registered its own
  //   file exporter, ours would double-write — skip instead.
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

// Convenience: re-export the canonical subpath plugins so that consumers
// who `import '@deepseek-harness-edge-agent/dsh-edge-agent'` can also
// pull individual cordis rows out of the same module.
export * from './tcm.js'
export * from './local-storage.js'
export * from './sessions.js'
export * from './audit-log.js'
export * from './privacy-policy.js'
export * from './tools.js'
export * from './realm-skill-bridge.js'
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
export * from './voice-input.js'
export * from './plugin-host.js'
// http-api re-exports: skip `resolveRoute` — it collides with the canonical
// `resolveRoute` from model-router.js (TS2308). http-api's local copy is only
// exported for unit tests; consumers should use model-router's version.
export { name as httpApiName, inject as httpApiInject, Config as HttpApiConfig, HttpApiServiceImpl, apply as httpApiApply } from './http-api.js'
// `HttpApiService` is an interface, not a runtime value. It must be a
// type-only re-export; a value re-export makes `tsx`/esbuild throw
// "does not provide an export named 'HttpApiService'" when importing src/.
export type { HttpApiService } from './http-api.js'
export * from './llm-adapters.js'
// §7.101 v5: re-export edge-context-view so it is reachable from the package
// root (`@deepseek-harness-edge-agent/dsh-edge-agent`). The cordis patch row
// in cordis.desktop-safe.patch.yml points at this name (bare package name,
// matching dsh-context's pattern); without this re-export the package root
// has no apply() for the host plugin and Edge tab remains invisible.
export * from './edge-context-view.js'
