/**
 * CI gate for the upstream compatibility contract.
 *
 * This is intentionally NOT a version lock: the project follows the newest
 * published `@deepseek-ai/dsh-*` line. The gate fails only when:
 *   - a blessed package is below `UPSTREAM_MIN_VERSION`, or
 *   - blessed packages resolve to mixed version lines (partial upgrade).
 *
 * Installing a newer upstream than `UPSTREAM_TESTED_VERSION` prints a
 * warning and passes; a scheduled `latest` job is expected to exercise it.
 *
 * Run via `node --import tsx/esm scripts/verify-upstream-contract.ts`.
 */
const { upstreamReport } = await import('../src/dsh-adapter/contract.js')

const report = await upstreamReport()
const installedSummary = report.versions.length > 0 ? report.versions.join(', ') : '(none found)'

for (const pkg of report.missing) {
  console.error(`upstream error: ${pkg} is not installed (run pnpm install)`)
}
for (const entry of report.newerThanTested) {
  console.warn(
    `upstream warning: ${entry.pkg}@${entry.installed} is newer than tested ` +
    `${report.tested} — run a boot smoke before shipping`,
  )
}

if (!report.ok) {
  console.error(
    `upstream contract violated (minimum: ${report.minimum}, installed: ${installedSummary}):`,
  )
  for (const entry of report.belowMinimum) {
    console.error(`  - ${entry.pkg}@${entry.installed} is below minimum ${report.minimum}`)
  }
  for (const entry of report.mixed) {
    console.error(
      `  - ${entry.pkg}@${entry.installed} does not match the rest of the upstream line ` +
      `(${installedSummary})`,
    )
  }
  process.exit(1)
}

console.log(
  `upstream contract OK (minimum: ${report.minimum}, tested: ${report.tested}, ` +
  `installed: ${installedSummary})`,
)
