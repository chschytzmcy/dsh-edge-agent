/**
 * Test environment sanitiser.
 *
 * §7.102 (2026-10-21) made config/edge.json the single source of runtime
 * configuration, and vitest.config.ts already neutralises the FILE layer
 * (DSH_EDGE_CONFIG_FILE=off) so the developer's real endpoints/keys cannot
 * leak into assertions.
 *
 * The ENV layer was still open: a developer's interactive shell exports the
 * whole DSH_EDGE_* set (the legacy .env.sh translation layer), and vitest
 * inherits it — so the suite's outcome depended on the machine it ran on:
 *
 *   - a test asserting "no local-LLM route without an endpoint" failed on a
 *     box with DSH_EDGE_LOCAL_LLM_BASEURL exported (route WAS registered);
 *   - a test asserting the hardcoded cloud fallback model 'deepseek-chat'
 *     failed with DSH_EDGE_MODEL exported (fallback became the exported id);
 *   - the delegate-vs-direct dispatch flipped on DSH_EDGE_CLOUD_LLM_BASEURL.
 *
 * CI never saw this (clean env), so the suite was green there and red
 * locally — the worst kind of drift.
 *
 * This file runs before every test file and clears the ambient DSH_EDGE_*
 * names, so the suite sees exactly what a fresh install with no config and
 * no shell exports would produce: the plugin Schema defaults.
 *
 * Tests that want to exercise an env override set it themselves inside the
 * test body (see http-api.test.ts / cloud-available.test.ts / …), which
 * happens after this file has run.
 */

// The file-layer opt-out must survive — it is what keeps config/edge.json
// (the developer's real file) out of the suite.
const KEEP = new Set(['DSH_EDGE_CONFIG_FILE'])

for (const key of Object.keys(process.env)) {
  if (key.startsWith('DSH_EDGE_') && !KEEP.has(key)) {
    delete process.env[key]
  }
}

process.env.DSH_EDGE_CONFIG_FILE = 'off'
