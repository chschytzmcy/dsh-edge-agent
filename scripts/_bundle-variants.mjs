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

/* ── §7.209：变体各自的出货文件集 ─────────────────────────────────────────── */

/**
 * 全部变体用到的补丁文件（每个变体的 cordis patch + preset patch）。
 *
 * @returns {string[]}
 */
export function allVariantPatchFiles() {
  const files = new Set()
  for (const v of BUNDLE_VARIANTS) {
    files.add(v.patchField)
    files.add(v.preset)
  }
  return [...files]
}

/**
 * **别的**变体的补丁文件 —— 本变体不该带它们。
 *
 * §7.209 的起因：两个变体的补丁是**互斥**的（safe = 不改写宿主默认值，
 * full = 改写宿主默认值），但出货文件集一直是**同一份** ⇒ safe 变体与 npm 包
 * 里都躺着 full 的补丁（实测 56,454 B，与仓库根 full 版**逐字节相同**）。
 *
 * 不会被自动应用（宿主按 `package.json#dsh.bundle.patch` 取文件）—— 但
 *   · 与「safe 不改写宿主默认值」的承诺**自相矛盾**（官方排障文档教的
 *     「手动 cp cordis.patch.yml 到嵌套包根」会让 safe 用户静默切到 full）；
 *   · npm 包还把它暴露成公共子路径（`./cordis.patch.yml`）。
 *
 * @param {(typeof BUNDLE_VARIANTS)[number]} variant
 * @returns {string[]}
 */
export function foreignPatchFiles(variant) {
  const mine = new Set([variant.patchField, variant.preset])
  return allVariantPatchFiles().filter((f) => !mine.has(f))
}

/**
 * 某变体的**出货文件清单**（写进它的 package.json#files 的那份）。
 *
 * 从根清单 `pkg.files` 派生，只做一件事：**去掉别的变体的补丁**。
 * 其余（含 `!` 否定项）原样保留 ——
 *   · `!config/edge.json` 等否定项**必须**留着：`pnpm add file:<dir>` 会按
 *     `files` 打这个目录 ⇒ 没有否定项 ⇒ 操作员的明文密钥会进 node_modules
 *     （§7.162 记的就是这件事）；
 *   · 否定项对**拷贝**无意义，只对**打包**有意义 ⇒ 拷贝时跳过。
 *
 * @param {{ files?: string[] }} pkg 根清单
 * @param {(typeof BUNDLE_VARIANTS)[number]} variant
 * @returns {string[]}
 */
export function variantFiles(pkg, variant) {
  const foreign = new Set(foreignPatchFiles(variant))
  const list = Array.isArray(pkg?.files) && pkg.files.length > 0 ? pkg.files : ['lib']
  return list.filter((entry) => !foreign.has(entry))
}

/**
 * 某变体的 `exports`：去掉**指向别的变体补丁**的条目。
 *
 * 两种都要去掉：
 *   · key 就是那个补丁（如 `./cordis.patch.yml`）；
 *   · key 指向别的补丁（v3 那个事故的形状：`"./cordis.desktop-safe.patch.yml":
 *     "./cordis.patch.yml"`）—— 留着它就是**指针在而文件缺** ⇒ 宿主启动时
 *     `failed to read overlay …ENOENT` ⇒ boot 硬失败
 *     （docs/dev-notes/cordis-rc021-patch-loader.md §Bug3）。
 *
 * @param {Record<string, unknown>} exportsMap 根清单的 exports
 * @param {(typeof BUNDLE_VARIANTS)[number]} variant
 * @returns {Record<string, unknown>}
 */
export function variantExports(exportsMap, variant) {
  const foreign = new Set(foreignPatchFiles(variant).map((f) => `./${f}`))
  const out = {}
  for (const [key, value] of Object.entries(exportsMap ?? {})) {
    if (foreign.has(key)) continue
    // 目标指向别的变体补丁 ⇒ 一并去掉（否则是「指针在而文件缺」）
    const targets = []
    if (typeof value === 'string') targets.push(value)
    else if (value && typeof value === 'object') {
      for (const cond of Object.values(value)) {
        if (typeof cond === 'string') targets.push(cond)
        else if (cond && typeof cond === 'object') {
          for (const inner of Object.values(cond)) {
            if (typeof inner === 'string') targets.push(inner)
          }
        }
      }
    }
    if (targets.some((t) => foreign.has(t))) continue
    out[key] = value
  }
  return out
}
