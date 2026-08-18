/**
 * Stub invariant installer for dsh-edge-agent v0.1.0 scaffold.
 *
 * Real implementation will register concrete invariants against
 * `ctx.invariants` for: SessionEvent coverage, privacy-policy
 * load-before-use, threat-level-before-llm-request, etc.
 *
 * v0.1.0 ships an empty reference; future versions expand the set.
 *
 * @module dsh-edge-agent/invariant-install
 */

export const installedRef = Object.freeze({
  packageName: '@deepseek-harness-edge-agent/dsh-edge-agent',
  invariants: [] as ReadonlyArray<string>,
})