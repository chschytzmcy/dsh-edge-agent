/**
 * Upstream DSH compatibility contract.
 *
 * Policy (2026-10-17): **do not pin the upstream DSH release line.** The
 * project follows the newest published `@deepseek-ai/dsh-*` packages
 * (currently the `next` dist-tag), so `package.json` uses open-ended
 * lower bounds (`>=0.2.1-rc.2`) rather than exact versions.
 *
 * The contract gate therefore checks *compatibility*, not equality:
 *   - every blessed package must be installed;
 *   - every installed version must be >= `UPSTREAM_MIN_VERSION`;
 *   - all blessed packages must resolve to one consistent version line
 *     (mixed installs are the usual symptom of a partial upgrade);
 *   - versions newer than `UPSTREAM_TESTED_VERSION` are reported as a
 *     warning, never as a failure.
 *
 * `UPSTREAM_MIN_VERSION` is bumped only when an upstream change actually
 * requires a code change here (e.g. the 0.2.x `agent/assistant-stream`
 * replacement for `session/event assistant/chunk`).
 */

/**
 * Oldest upstream line this bundle is known to work with. Raise this only
 * together with a code migration, never just because a newer RC exists.
 */
export const UPSTREAM_MIN_VERSION = '0.2.1-rc.2'

/** Newest upstream line exercised by the repo's own compile/gate run. */
export const UPSTREAM_TESTED_VERSION = '0.2.1-rc.2'

/**
 * @deprecated Use `UPSTREAM_TESTED_VERSION` (or `UPSTREAM_MIN_VERSION` for
 * compatibility checks). Kept as an alias so external scripts that imported
 * the old name keep working.
 */
export const UPSTREAM_VALIDATED_VERSION = UPSTREAM_TESTED_VERSION

/** Framework packages compared by major/minor only. */
export const UPSTREAM_FRAMEWORK_MAJORS = {
  '@deepseek-ai/cordis': '>=4.0.5',
  '@deepseek-ai/schemastery': '>=3.18.5',
} as const

/**
 * Packages whose versions must move together. Keeping this list small is
 * deliberate: it covers the API surface this bundle imports directly.
 */
export const UPSTREAM_BLESSED_PACKAGES = [
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-scope',
] as const

export type BlessedPackage = (typeof UPSTREAM_BLESSED_PACKAGES)[number]

export interface UpstreamEntry {
  pkg: string
  installed: string
}

export interface UpstreamReport {
  /** False only for below-minimum or mixed installs. */
  ok: boolean
  minimum: string
  tested: string
  installed: Record<string, string>
  missing: string[]
  belowMinimum: UpstreamEntry[]
  mixed: UpstreamEntry[]
  newerThanTested: UpstreamEntry[]
  versions: string[]
}

function parseVersion(value: string): { parts: number[]; prerelease: string[] } {
  const [core = '', pre = ''] = value.split('-', 2)
  const parts = core.split('.').map((part) => {
    const n = Number.parseInt(part, 10)
    return Number.isFinite(n) ? n : 0
  })
  return { parts, prerelease: pre.length > 0 ? pre.split('.') : [] }
}

function comparePrerelease(a: readonly string[], b: readonly string[]): number {
  // A release sorts above any prerelease of the same core version.
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  const length = Math.max(a.length, b.length)
  for (let i = 0; i < length; i++) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    if (xNumeric && yNumeric) {
      const diff = Number(x) - Number(y)
      if (diff !== 0) return diff < 0 ? -1 : 1
    } else if (xNumeric) {
      return -1
    } else if (yNumeric) {
      return 1
    } else {
      const cmp = x.localeCompare(y)
      if (cmp !== 0) return cmp < 0 ? -1 : 1
    }
  }
  return 0
}

/** Semver-ish comparison that also understands `-rc.1` style prereleases. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  for (let i = 0; i < 3; i++) {
    const diff = (pa.parts[i] ?? 0) - (pb.parts[i] ?? 0)
    if (diff !== 0) return diff < 0 ? -1 : 1
  }
  return comparePrerelease(pa.prerelease, pb.prerelease)
}

export function versionAtLeast(value: string, minimum: string): boolean {
  return compareVersions(value, minimum) >= 0
}

/**
 * Read installed versions by walking the consumer's `node_modules/<pkg>/package.json`.
 * Missing packages are reported, not thrown: a host may provide them lazily.
 */
export async function installedUpstreamVersions(): Promise<Map<string, string>> {
  const { createRequire } = await import('node:module')
  const require = createRequire(import.meta.url)
  const result = new Map<string, string>()
  for (const pkg of UPSTREAM_BLESSED_PACKAGES) {
    try {
      const manifest = require(`${pkg}/package.json`) as { version: string }
      result.set(pkg, manifest.version)
    } catch {
      // not installed; reported as `missing`
    }
  }
  return result
}

/** Full compatibility report used by the CI gate and boot diagnostics. */
export async function upstreamReport(): Promise<UpstreamReport> {
  const installedMap = await installedUpstreamVersions()
  const installed: Record<string, string> = {}
  const missing: string[] = []
  const belowMinimum: UpstreamEntry[] = []
  const newerThanTested: UpstreamEntry[] = []

  for (const pkg of UPSTREAM_BLESSED_PACKAGES) {
    const version = installedMap.get(pkg)
    if (version === undefined) {
      missing.push(pkg)
      continue
    }
    installed[pkg] = version
    if (!versionAtLeast(version, UPSTREAM_MIN_VERSION)) {
      belowMinimum.push({ pkg, installed: version })
    }
    if (compareVersions(version, UPSTREAM_TESTED_VERSION) > 0) {
      newerThanTested.push({ pkg, installed: version })
    }
  }

  const versions = [...new Set(Object.values(installed))]
  let mixed: UpstreamEntry[] = []
  if (versions.length > 1) {
    // Report the outliers relative to the most common version line.
    const counts = new Map<string, number>()
    for (const version of Object.values(installed)) {
      counts.set(version, (counts.get(version) ?? 0) + 1)
    }
    const baseline = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    mixed = Object.entries(installed)
      .filter(([, version]) => version !== baseline)
      .map(([pkg, version]) => ({ pkg, installed: version }))
  }

  return {
    // Missing packages are a hard failure for the CI gate (the repo installs
    // them as devDependencies). Runtime consumers use `upstreamDrift()`, which
    // intentionally ignores `missing` because the host may provide them.
    ok: missing.length === 0 && belowMinimum.length === 0 && mixed.length === 0,
    minimum: UPSTREAM_MIN_VERSION,
    tested: UPSTREAM_TESTED_VERSION,
    installed,
    missing,
    belowMinimum,
    mixed,
    newerThanTested,
    versions,
  }
}

/**
 * Boot-time drift: only conditions that are actually incompatible.
 * A newer upstream (e.g. 0.3.x) is intentionally *not* drift.
 */
export async function upstreamDrift(): Promise<Array<{ pkg: string; installed: string; expected: string }>> {
  const report = await upstreamReport()
  return [
    ...report.belowMinimum.map((entry) => ({
      ...entry,
      expected: UPSTREAM_MIN_VERSION,
    })),
    ...report.mixed.map((entry) => ({
      ...entry,
      expected: 'one consistent upstream version line',
    })),
  ]
}
