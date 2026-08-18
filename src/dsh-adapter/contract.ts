/**
 * Upstream DSH contract — pins validated versions, declares the blessed
 * package list, and exposes drift detection for the verify-upstream-contract
 * gate.
 *
 * Policy: when the upstream DSH publsihes a new release candidate, run
 * `npm install <pkg>@<new-rc>` then bump `UPSTREAM_VALIDATED_VERSION` here,
 * regenerate `patch-surface.snapshot.json`, and audit boundary imports.
 */

/** The single version line we have validated against. */
export const UPSTREAM_VALIDATED_VERSION = '0.1.0-rc.6'

/** Framework packages compared by major version only. */
export const UPSTREAM_FRAMEWORK_MAJORS = {
  '@deepseek-ai/cordis': '^4.0.1',
  '@deepseek-ai/schemastery': '^3.18.1',
} as const

/**
 * Packages validated at the rc.6 line. The verify-upstream-contract script
 * reads each entry's installed version from the consuming package's
 * `node_modules` and fails if any drift is detected.
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

/**
 * Read installed versions by walking the consumer's `node_modules/<pkg>/package.json`.
 * Returns an empty map when the lookup fails — the verifier treats an empty
 * map as a warning, not a failure, since the package may be installed lazily.
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
      // not installed; skip silently
    }
  }
  return result
}

/** Drift entries: pkg names whose installed version does not match the validated rc. */
export async function upstreamDrift(): Promise<Array<{ pkg: string; installed: string; expected: string }>> {
  const installed = await installedUpstreamVersions()
  const drift: Array<{ pkg: string; installed: string; expected: string }> = []
  for (const pkg of UPSTREAM_BLESSED_PACKAGES) {
    const got = installed.get(pkg)
    if (got && got !== UPSTREAM_VALIDATED_VERSION) {
      drift.push({ pkg, installed: got, expected: UPSTREAM_VALIDATED_VERSION })
    }
  }
  return drift
}
