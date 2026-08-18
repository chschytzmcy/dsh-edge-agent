/**
 * Main plugin runtime — orchestrates the privacy stack in dependency order.
 *
 * Boot order (topological):
 *   1. tcm           (no deps)
 *   2. local-storage (depends on tcm)
 *   3. audit-log     (depends on tcm, local-storage)
 *   4. sessions      (depends on tcm, local-storage)
 *   5. privacy-policy(depends on tcm, local-storage, audit-log)
 *   6. tools         (depends on audit-log)
 *   7. prompt-guard  (depends on tcm, privacy-policy, audit-log)
 *   8. ohttp-gateway (depends on tcm, audit-log)
 *   9. secure-bridge (depends on tcm, ohttp-gateway, privacy-policy, audit-log)
 *  10. attestation   (depends on tcm, audit-log)
 *  11. local-llm-adapter (registers on ctx.llm)
 *  12. cloud-llm-adapter (registers on ctx.llm, depends on secure-bridge)
 *  13. model-router  (depends on llm, privacy-policy, audit-log)
 *  14. td-bus        (depends on audit-log, privacy-policy)
 *  15. intent-router (depends on llm, prompt-guard, privacy-policy, sessions)
 *  16. sanitizer-pipeline (depends on local-storage, privacy-policy)
 *  17. local-tools   (depends on tools, local-storage)
 *  18. web-search    (depends on tools, secure-bridge, audit-log)
 *  19. voice-input   (depends on sessions, audit-log)
 *  20. plugin-host   (depends on agents, sessions)
 *  21. http-api      (depends on agents, sessions, audit-log)
 *
 * Each plugin's own `apply` declares its `inject` dependencies; the DSH
 * Loader activates them in topological order automatically. This file
 * exists only to host the wiring for the MAIN entry that orchestrates
 * initial setup and registers cross-cutting listeners.
 *
 * In v0.1.0 (scaffold), this is a thin delegator: each sub-plugin's
 * apply is invoked by the Loader directly via its own cordis.yml row.
 * Future versions may add inter-plugin event listeners here.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './index.ts'

export async function apply(ctx: Context, config: Config): Promise<void> {
  // The main plugin does not own state — it only:
  //  1. emits a single 'edge-agent/boot' event so dependent plugins
  //     can finalize their setup without circular imports.
  //  2. installs a soft shutdown hook that flushes pending audit logs
  //     and closes the encrypted storage handle.
  //
  // All actual work is performed by the sub-plugins; this main entry
  // exists only to give the package a single named surface that
  // `cordis.yml` can mount.

  const ctxWithEvent = ctx as Context & { event: { emit(name: string, payload: unknown): Promise<void> } }
  await ctxWithEvent.event.emit('edge-agent/boot', { config })

  // Track disposers for ordered teardown.
  const disposers: Array<() => Promise<void> | void> = []

  // Hook shutdown to flush audit logs.
  const { auditLogShutdown } = await import('./audit-log.ts')
  disposers.push(await auditLogShutdown(ctx))

  // Hook shutdown to close encrypted storage.
  const { storageShutdown } = await import('./local-storage.ts')
  disposers.push(await storageShutdown(ctx))

  return async () => {
    for (const dispose of disposers.reverse()) {
      try {
        await dispose()
      } catch {
        // swallow: teardown must be idempotent and tolerant of partial state
      }
    }
  }
}
