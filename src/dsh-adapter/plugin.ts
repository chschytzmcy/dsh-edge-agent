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
 *  17. voice-input   (depends on sessions, audit-log)
 *  18. plugin-host   (depends on agents, sessions)
 *  19. http-api      (depends on agents, sessions, audit-log)
 *
 * Note: local-tools and web-search have been removed. Use DSH native tools:
 *   - @deepseek-ai/dsh-tool-bash (bash execution)
 *   - @deepseek-ai/dsh-tool-fs (file read/write/edit)
 *   - @deepseek-ai/dsh-tool-web (web_search + web_fetch)
 *   - @deepseek-ai/dsh-web-search-deepseek (DeepSeek search provider)
 *   - @dsh-edge/dsh-edge-agent/web-search-tavily-bocha
 *     (§7.82 Phase 5: 3-tier Tavily → 博查 → DeepSeek fallback, replaces
 *     upstream DeepSeek provider as the default `searchProvider`)
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
import type { Config } from './index.js'

export async function apply(ctx: Context, config: Config): Promise<() => Promise<void>> {
  // The main plugin does not own state — it only:
  //  1. emits a single 'edge-agent/boot' event so dependent plugins
  //     can finalize their setup without circular imports.
  //  2. installs a soft shutdown hook that flushes pending audit logs
  //     and closes the encrypted storage handle.
  //
  // All actual work is performed by the sub-plugins; this main entry
  // exists only to give the package a single named surface that
  // `cordis.yml` can mount.

  // 2026-10-20 desktop fix: the host-half plugin declares `inject: []`,
  // so the cordis proxy throws `cannot get property "event" without
  // inject` when we touch ctx.event. The event has no subscribers (it
  // was scaffold-era signalling for cross-plugin setup that ended up
  // living in each plugin's own apply). Best-effort only: if the host
  // ever grows an `event` accessor the emit still fires; otherwise we
  // log and move on instead of killing the plugin mount.
  const ctxWithEvent = ctx as Context & { event?: { emit(name: string, payload: unknown): Promise<void> } }
  try {
    await ctxWithEvent.event?.emit('edge-agent/boot', { config })
  } catch {
    // expected on cordis 0.2.1-rc.2 (undeclared `event` service)
  }

  // Track disposers for ordered teardown.
  const disposers: Array<() => Promise<void> | void> = []

  // Hook shutdown to flush audit logs. Best-effort: `cordis 0.2.1-rc.2`
  // throws `cannot get property "x" without inject` when a service was not
  // declared. The aggregator declares `auditLog` but NOT `localStorage`
  // (the desktop-safe patch never inserts a `local-storage` row, and
  // declaring it would make the loader wait forever with
  // `pending (waiting for service: localStorage)`). Wrap both shutdown
  // captures so the host-half mounts cleanly under any patch composition.
  try {
    const { auditLogShutdown } = await import('./audit-log.js')
    disposers.push(await auditLogShutdown(ctx))
  } catch {
    // ctx.auditLog unavailable or threw on access; no-op disposer.
  }
  try {
    const { storageShutdown } = await import('./local-storage.js')
    disposers.push(await storageShutdown(ctx))
  } catch {
    // ctx.localStorage unavailable or threw on access; no-op disposer.
  }

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
