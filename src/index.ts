/**
 * dsh-edge-agent — package root (flat layout, matching dsh-context's pattern).
 *
 * The aggregate plugin (`name='dsh-edge-agent'`) that cordis 0.2.1-rc.2
 * mounts when the patch row uses the bare package name lives in
 * `./dsh-adapter/dsh-edge-agent.ts` so the adapter boundary holds:
 * `verify-adapter-boundary` only allows `@deepseek-ai/*` imports under
 * `src/dsh-adapter/`. This file stays as a thin re-export shell — it must
 * NOT import upstream packages directly, only re-export sub-plugin modules
 * and the aggregate bootstrap.
 *
 * For `cordis require('@scope/pkg')` to resolve to the aggregate plugin,
 * `package.json#main` → `lib/index.js` (this file compiled) AND the
 * `lib/` directory must hold `index.js` flat (no dotted `lib/types/` prefix).
 * The dotted layout silently misroutes cordis to `lib/types/<name>.js`,
 * which would cause the whole bundle to never mount — flat layout is
 * mandatory (see docs/dev-notes/cordis-rc021-patch-loader.md).
 *
 * Sub-plugin re-exports preserve the public API: a consumer can still do
 *   `import { auditLog } from '@scope/pkg/audit-log'`
 * because every adapter subpath is `export *`-ed here.
 */

export {
  name,
  inject,
  Config,
  apply,
  type Config as AggregatorConfig,
} from './dsh-adapter/dsh-edge-agent.js'

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