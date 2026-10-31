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
import { fileURLToPath } from 'node:url'

export default defineConfig({
  /**
   * §7.120（2026-10-31）：宿主 `@deepseek-ai/dsh-tools` 顶层 import
   * `@deepseek-ai/dsh-sandbox`，而本仓没依赖那个包 ⇒ 任何 import dsh-tools 的
   * 测试都会在**加载期**抛 `Cannot find package`。这里把它指到本地桩
   * （`tests/unit/stubs/dsh-sandbox.ts`）：只顶替三个**沙箱升级**相关的符号，
   * dsh-tools 的执行管道（pre-execute waterfall / guard / 拒绝物化）全是宿主
   * 原样代码。桩的边界写在它自己的文件头里。
   */
  resolve: {
    alias: {
      '@deepseek-ai/dsh-sandbox': fileURLToPath(new URL('./tests/unit/stubs/dsh-sandbox.ts', import.meta.url)),
    },
  },
  test: {
    /**
     * dsh-tools 必须**内联**处理（不能被 externalize 成 Node 直接 require）——
     * 否则它的 `@deepseek-ai/dsh-sandbox` import 由 Node 解析，绕过上面的
     * alias，测试在加载期就炸。
     */
    server: {
      deps: {
        inline: ['@deepseek-ai/dsh-tools'],
      },
    },
    env: {
      DSH_EDGE_CONFIG_FILE: 'off',
    },
    setupFiles: ['tests/unit/setup-env.ts'],
    /**
     * §7.123 (2026-10-27): real coverage measurement.
     *
     * Before this, the only "coverage" gate in CI was a raw test-count
     * floor (`TOTAL >= 600` in .github/workflows/ci.yml) — adding 600
     * empty `it()` calls passed the gate, and nothing measured whether
     * the shipped modules were exercised at all. Three test files even
     * asserted against RE-IMPLEMENTATIONS of the production code, so they
     * could not fail on a production regression.
     *
     * The thresholds below are per-directory floors, deliberately set at
     * the current measured level (not aspirational): they exist to make
     * coverage REGRESSIONS visible, so a new uncovered module or a
     * refactor that drops exercised lines fails CI instead of passing
     * silently. Raise them as coverage improves.
     */
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'lcov'],
      reportsDirectory: './coverage',
      include: [
        'src/dsh-adapter/**/*.ts',
        'src/client/**/*.{ts,tsx}',
      ],
      exclude: [
        'src/dsh-adapter/types.ts',
        'src/dsh-adapter/invariant.ts',
        'src/dsh-adapter/invariant-install.ts',
      ],
      thresholds: {
        'src/dsh-adapter/**/*.ts': {
          lines: 60,
          functions: 60,
          branches: 45,
          statements: 60,
        },
      },
    },
  },
})
