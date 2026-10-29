// _bundle-variants.mjs — THE single source of truth for the bundle variants
// and for the `dsh.bundle.patch` declaration each variant ships.
//
// ## Why this file exists (§7.153)
//
// The shipped bundle declares TWO patch layers:
//
//   1. the **cordis patch** — the host-row overrides
//      (cordis.desktop-safe.patch.yml / cordis.patch.yml)
//   2. the **Agent Preset patch** — the 边缘模式 work mode
//      (presets/edge.desktop-safe.patch.yml / presets/edge.patch.yml)
//
// The host reads them from `package.json#dsh.bundle.patch`, and that field
// accepts a STRING or a LIST of strings
// (@deepseek-ai/dsh-app-boot `bundlePatchFiles`:
//
//     const declared = typeof bundle.patch === "string" ? [bundle.patch] : bundle.patch
//     if (!Array.isArray(declared) || !declared.every(f => typeof f === "string"))
//       throw new Error("dsh.bundle.patch must be a file path or a list of file paths")
//
// The host's own bundle ships the list form
// (@deepseek-ai/dsh-web-app: ["./cordis.patch.yml", "./presets/standard.patch.yml", …]).
//
// **A string form silently drops the preset layer** ⇒ the
// `@deepseek-ai/dsh-agent-preset` row never loads ⇒ the 边缘模式 work mode is
// never registered ⇒ the desktop's work-mode selector shows nothing new, with
// no error anywhere.
//
// ## The bug this file closes
//
// FOUR scripts used to write that field independently:
//
//   scripts/_pack-core.mjs          → string   ❌ (the desktop build path!)
//   scripts/build-desktop-bundle.sh → string   ❌ (the tarball staging)
//   scripts/_rebuild-installable.mjs → string   ❌ (the Node mirror)
//   scripts/rebuild-installable.mjs  → list     ✅ (the only correct one)
//
// `scripts/build-macos.sh` (the macOS desktop build) goes through
// `_pack-core.mjs`, so the desktop artifact it produced carried the string
// form — the preset layer was never shipped, and the 边缘模式 work mode simply
// did not exist in the running desktop.
//
// A single string that is correct in one place and wrong in another is not a
// bug that survives review; it is a bug that waits for the next writer. Hence:
// ONE table, ONE helper, every writer imports it.
//
// ## The contract this module guarantees
//
//   bundlePatchDeclaration(variant) ⇒ ["./<cordis patch>", "./<preset patch>"]
//
// `scripts/verify-installable.mjs` asserts the property that actually matters
// downstream: the shipped bundle must declare a preset layer AND that preset
// file must contain an `@deepseek-ai/dsh-agent-preset` row.

/**
 * The bundle variants. Every field here is used by the packaging scripts:
 *
 *   dir           — the installable directory name under dist/installable/
 *   patchField    — the cordis patch (host-row overrides) for this variant
 *   preset        — the Agent Preset patch (the 边缘模式 work mode)
 *   versionSuffix — appended to package.json#version
 *   description   — package.json#description
 */
export const BUNDLE_VARIANTS = [
  {
    dir: 'dsh-edge-agent-desktop-safe',
    patchField: 'cordis.desktop-safe.patch.yml',
    preset: 'presets/edge.desktop-safe.patch.yml',
    versionSuffix: '-desktop-safe',
    description:
      'dsh-edge-agent bundle — desktop-safe overlay (inserts the privacy stack, does NOT rewrite host defaults: model / persona / approval / sandbox / session root / http-api)',
  },
  {
    dir: 'dsh-edge-agent-full',
    patchField: 'cordis.patch.yml',
    preset: 'presets/edge.patch.yml',
    versionSuffix: '-full',
    description:
      'dsh-edge-agent bundle — full production patch (same behaviour as the standalone dsh-edge profile; rewrites host defaults)',
  },
]

/**
 * The `dsh.bundle.patch` declaration for a variant: the cordis patch FIRST
 * (host-row overrides win), then the preset patch (the 边缘模式 work mode).
 *
 * @param {{ patchField: string, preset: string }} variant
 * @returns {string[]} the list form the host expects
 */
export function bundlePatchDeclaration(variant) {
  return [`./${variant.patchField}`, `./${variant.preset}`]
}

/**
 * Look a variant up by its installable directory name.
 *
 * @param {string} dir
 * @returns {(typeof BUNDLE_VARIANTS)[number] | undefined}
 */
export function variantByDir(dir) {
  return BUNDLE_VARIANTS.find((v) => v.dir === dir)
}
