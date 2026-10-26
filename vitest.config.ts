/**
 * Vitest configuration.
 *
 * §7.102 (2026-10-21): the runtime configuration moved to config/edge.json
 * (a developer's local file with real endpoints and real API keys). Without
 * an opt-out, that file leaks into the unit suite and the assertions depend
 * on the machine they run on — a test expecting "no local-LLM route" would
 * pass or fail depending on whether the developer happened to configure an
 * endpoint.
 *
 * DSH_EDGE_CONFIG_FILE=off makes edge-config.ts skip every file candidate,
 * so the suite sees only the env override layer and the plugin Schema
 * defaults — the same state a fresh install with no config would produce.
 *
 * The ENV layer needed the same treatment (tests/unit/setup-env.ts): a
 * developer's shell exports the whole DSH_EDGE_* set, and vitest inherits
 * it — assertions then depended on the machine (CI was green, the dev box
 * red). The setup file clears the ambient names before each test file.
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    env: {
      DSH_EDGE_CONFIG_FILE: 'off',
    },
    setupFiles: ['tests/unit/setup-env.ts'],
  },
})
