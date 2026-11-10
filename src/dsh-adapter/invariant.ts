/**
 * Package-owned invariant companion. The harness exposes a `ctx.invariants`
 * registry on the root context; each plugin can attach its own runtime
 * assertions that the harness asserts during session lifecycle hooks.
 *
 * For dsh-edge-agent, the invariants we install ensure:
 *   - All SessionEvents marked as model-visible are present in the log
 *   - The privacy policy is loaded before any plugin reads it
 *   - The threat level is consulted before every LLM request
 */

import type { Context } from './types.js'

export const PACKAGE_NAME = '@dsh-edge/dsh-edge-agent'

export const name = 'dsh-edge-agent-invariant'

export const inject = ['invariants'] as const

export async function apply(ctx: Context): Promise<() => Promise<void>> {
  // Lazy-load the invariant registry to avoid pulling the runtime into
  // pure type-graph evaluation paths.
  const { installedRef } = await import('./invariant-install.js')
  const dispose = (ctx as any).invariants.register(PACKAGE_NAME, installedRef)
  return async () => {
    dispose()
  }
}
