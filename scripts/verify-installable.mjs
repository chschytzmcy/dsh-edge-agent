// Verify installable bundle directories under dist/installable.
//
// §7.101.x (2026-10-20): added after a real incident where the desktop GUI
// validator rejected an installable dir with ENOENT because the package.json
// bundle.patch field pointed at a file (cordis.patch.yml) that wasn't in the
// dir (we shipped only cordis.desktop-safe.patch.yml). npm pack treats the
// files field as the source of truth; the desktop GUI independently validates
// every file the manifest references. This script closes that gap pre-make.
//
// For each directory under dist/installable, every file path that the bundle
// package.json claims must exist on disk; the host entry point (lib/index.js
// since the 2026-10-20 flat-layout move; it used to be lib/types/index.js),
// the presets directory, and the cordis patch must all exist independently
// of the manifest.
//
// Note: keep backticks out of comments. Node 24 ESM lexer walks block-comment
// regions for template-string opening backticks; a stray backtick inside an
// open-close comment pair silently re-enters string-literal scanning and
// corrupts the parser.
//
// Run via: node scripts/verify-installable.mjs

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

import { bundlePatchDeclaration, variantByDir } from './_bundle-variants.mjs'
import { CONFIG_NEGATIONS, configShipViolations, describeConfigViolation } from './_config-ship-policy.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const INSTALLABLE = process.env.INSTALLABLE_DIR
  ? resolve(process.env.INSTALLABLE_DIR)
  : join(ROOT, 'dist', 'installable')

const REQUIRED_HOST_ENTRY = 'lib/index.js'

// The host's Agent Preset plugin. A preset patch declares ONE row with this
// name; the row's config is the work mode (id / name / order / plugins).
const AGENT_PRESET_PLUGIN = '@deepseek-ai/dsh-agent-preset'

// The preset patches carry "disabled: !!js process.platform === 'win32'".
// yaml v2 resolves unknown tags to null (with a warning); this tag keeps the
// raw expression so the parse stays lossless and warning-free.
const JS_TAG = {
  identify: () => false,
  tag: 'tag:yaml.org,2002:js',
  resolve: (str) => str,
  stringify: (item) => String(item),
}

/**
 * Collect every "insert" row from a cordis patch file.
 *
 * A patch file is a list of documents; each document may carry an "insert"
 * key whose value is the list of plugin rows to add.
 *
 * @param {string} text
 * @returns {Array<{ id?: string, name?: string, config?: Record<string, unknown> }>}
 */
function collectInsertRows(text) {
  const doc = parseYaml(text, { customTags: [JS_TAG] })
  const docs = Array.isArray(doc) ? doc : [doc]
  const rows = []
  for (const d of docs) {
    if (!d || typeof d !== 'object') continue
    for (const key of Object.keys(d)) {
      if (key !== 'insert') continue
      const value = d[key]
      if (Array.isArray(value)) rows.push(...value)
    }
  }
  return rows
}

/** Recursive directory walker. */
function walk(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

// Strip surrounding double quotes from a JSON-derived yaml path.
function unquote(value) {
  if (typeof value !== 'string') return value
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1)
  }
  return value
}

/** Single-bundle verification. Throws on first violation. */
function verifyBundle(dir) {
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) {
    throw new Error(`${relative(ROOT, dir)}: missing package.json`)
  }
  let pkg
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  } catch (e) {
    throw new Error(`${relative(ROOT, dir)}: package.json is not valid JSON (${e.message})`)
  }

  // 1. host half entry must exist (lib/index.js).
  const hostEntry = join(dir, REQUIRED_HOST_ENTRY)
  if (!existsSync(hostEntry)) {
    throw new Error(`${relative(ROOT, dir)}: missing host entry ${REQUIRED_HOST_ENTRY}`)
  }

  // 1b. §7.182 (2026-11-11): the bundle's config/ directory must ship the
  //     TEMPLATE + the policy — and must NOT ship the operator's live config.
  //
  //     The runtime's config lookup has exactly TWO candidates:
  //       1. <bundle>/config/edge.json  — the installed plugin's own config dir
  //                                      (where the user looks);
  //       2. ~/.dsh-edge-agent/edge.json — the operator's home copy.
  //     A BUILD OUTPUT is neither of those: it is a third copy of the
  //     plaintext keys, and §7.178 already deleted one such copy on purpose.
  //     The bundle's own config/ therefore holds only what the BUNDLE owns:
  //       · edge.example.json     — blank-secret template the operator copies
  //                                 from (the runtime's defaults live in
  //                                 DEFAULT_EDGE_CONFIG, §7.182);
  //       · privacy-policy.json   — the enforced policy itself.
  const configDir = join(dir, 'config')
  if (!existsSync(configDir)) {
    throw new Error(`${relative(ROOT, dir)}: missing config/ directory (edge.example.json + privacy-policy.json live there)`)
  }
  const edgeConfig = join(configDir, 'edge.json')
  const edgeExample = join(configDir, 'edge.example.json')
  // The template must always ship (it is the last-resort fallback).
  if (!existsSync(edgeExample)) {
    throw new Error(`${relative(ROOT, dir)}: missing config/edge.example.json (template)`)
  }
  // 1c. §7.182: the operator's live config must NOT travel with any artifact.
  //     The old rule was the opposite (the link-mode installable had to CARRY
  //     the repo's live config, because the runtime's candidate #1 read it).
  //     That candidate is gone ⇒ a bundled edge.json would be a plaintext
  //     credential file the runtime never reads.
  if (existsSync(edgeConfig)) {
    throw new Error(
      `${relative(ROOT, dir)}: config/edge.json 在产物里 `
      + '⇒ 产物是构建输出，不是运维的两个落点（插件目录 / ~/.dsh-edge-agent）之一；'
      + '带着它等于把明文 API key 打进第三份副本（§7.178 删过一份这样的）。'
      + 'stageVariant / rebuild-installable 都必须排除它。',
    )
  }
  // The operator's live config must not sit in the repo either — one place only.
  if (existsSync(join(ROOT, 'config', 'edge.json'))) {
    throw new Error(
      `${relative(ROOT, dir)}: 仓库里有 config/edge.json `
      + '⇒ §7.182 起仓库的配置目录不再作为活配置的落点（明文 API key 不该待在 git '
      + 'checkout 里）。运维配置写 ~/.dsh-edge-agent/edge.json（顺位 2），'
      + '或装好后写插件目录下的 config/edge.json（顺位 1）。',
    )
  }
  // 1d. §7.162 (2026-10-30): the manifest's `files` whitelist must be the
  //     repo root's own list, verbatim.
  //
  //     Why this is load-bearing rather than cosmetic: `files` decides what a
  //     PACK of this directory contains, and `pnpm add file:<dir>` packs the
  //     directory. So:
  //       · WITH "!config/edge.json" ⇒ the packed copy carries no plaintext
  //         API key into node_modules;
  //       · WITHOUT it ⇒ the operator's real key is copied into node_modules.
  //
  //     Two producers write this very directory —
  //     `scripts/rebuild-installable.mjs` and `scripts/_pack-core.mjs`
  //     (stageVariant) — and they used to disagree: the first carried the
  //     root list verbatim, the second hard-coded a list of its own that was
  //     missing the negation. Whichever ran last decided whether a
  //     `file:<dir>` install leaked the key. One list, both producers.
  const rootManifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const expectedFiles = rootManifest.files
  const actualFiles = pkg.files
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(
      `${relative(ROOT, dir)}: package.json#files 是 ${JSON.stringify(actualFiles)} `
      + `但仓库根 package.json#files 是 ${JSON.stringify(expectedFiles)} `
      + '⇒ 两条产出路径（rebuild-installable.mjs / _pack-core.mjs）的白名单漂移了。'
      + 'installable 目录必须原样沿用根的白名单（含 "!config/edge.json"）：'
      + '它决定 `pnpm add file:<目录>` 打出来的副本里会不会夹带明文 API key。',
    )
  }
  if (!Array.isArray(actualFiles) || !actualFiles.includes('!config/edge.json')) {
    throw new Error(
      `${relative(ROOT, dir)}: package.json#files 缺少 "!config/edge.json" 排除项 `
      + `（当前：${JSON.stringify(actualFiles)}）⇒ \`pnpm add file:<目录>\` 走 pack 路径时`
      + '会把本机 config/edge.json 里的明文 API key 拷进 node_modules。',
    )
  }
  // 1e. §7.189: the npm-side exclusions must be present too — the live
  //     config's BACKUP (`edge.json.bak-<timestamp>`, same plaintext keys) and
  //     editor junk slip past an exact-name negation. The npm channel and the
  //     local staging channel are two different file-list computations, so
  //     both need the rule.
  const missingNegations = CONFIG_NEGATIONS.filter((n) => !actualFiles.includes(n))
  if (missingNegations.length > 0) {
    throw new Error(
      `${relative(ROOT, dir)}: package.json#files 缺少排除项 `
      + `${missingNegations.join(' / ')}（当前：${JSON.stringify(actualFiles)}）`
      + '⇒ npm pack 通道会把活配置的备份（同一份明文 API key）与编辑器垃圾一起发出去。',
    )
  }
  // 1f. §7.189: the staged config/ directory must hold ONLY the allowlisted
  //     files — the installable directory is mounted by the desktop profile
  //     through a link:, so anything in here lands in the user's node_modules.
  {
    const stagedConfig = readdirSync(configDir)
    const violations = configShipViolations(stagedConfig.map((f) => `config/${f}`))
    if (violations.length > 0) {
      throw new Error(
        `${relative(ROOT, dir)}: config/ 里有不该出货的文件：`
        + `${violations.map((v) => describeConfigViolation(v)).join('；')} `
        + '⇒ 桌面 profile 通过 link: 挂载这个目录，它会直接进用户的 node_modules。',
      )
    }
  }
  // Whichever config is present must be valid JSON with the expected shape.
  for (const candidate of [edgeConfig, edgeExample]) {
    if (!existsSync(candidate)) continue
    let parsed
    try {
      parsed = JSON.parse(readFileSync(candidate, 'utf-8'))
    } catch (e) {
      throw new Error(`${relative(ROOT, candidate)}: invalid JSON (${e.message})`)
    }
    for (const section of ['llm', 'stages', 'privacy', 'resources']) {
      if (parsed[section] === undefined) {
        throw new Error(`${relative(ROOT, candidate)}: missing "${section}" section`)
      }
    }
  }

  // 2. bundle.patch path(s) must exist on disk.
  //    This is the failure mode that triggered §7.101.x.
  //
  //    §7.135: the field may be a STRING (one patch) or an ARRAY (several
  //    patch layers) — the host's own dsh-web-app bundle uses the array
  //    shape (`["./cordis.patch.yml", "./presets/standard.patch.yml", …]`).
  //    This bundle now ships two layers: the host-row overrides (cordis
  //    patch) and the **Agent Preset** declaration (the 边缘模式 work mode).
  const rawBundlePatch = pkg?.dsh?.bundle?.patch
  const bundlePatches = Array.isArray(rawBundlePatch)
    ? rawBundlePatch.map((p) => unquote(p))
    : [unquote(rawBundlePatch)]
  if (!rawBundlePatch || bundlePatches.length === 0 || bundlePatches.some((p) => !p)) {
    throw new Error(`${relative(ROOT, dir)}: package.json#dsh.bundle.patch missing`)
  }
  for (const dshBundlePatch of bundlePatches) {
    if (typeof dshBundlePatch !== 'string') {
      throw new Error(
        `${relative(ROOT, dir)}: package.json#dsh.bundle.patch entry is not a string: ${typeof dshBundlePatch}`,
      )
    }
    // Desktop forbids non-yaml patches: must end in .yml/.yaml.
    if (!/\.(ya?ml)$/i.test(dshBundlePatch)) {
      throw new Error(
        `${relative(ROOT, dir)}: dsh.bundle.patch must be a yaml file, got: ${dshBundlePatch}`,
      )
    }
    const patchAbs = join(dir, dshBundlePatch)
    if (!existsSync(patchAbs)) {
      throw new Error(
        `${relative(ROOT, dir)}: dsh.bundle.patch points at ` +
          `${dshBundlePatch} but the file is missing on disk`,
      )
    }
  }

  // 2b. §7.153: the bundle MUST declare the Agent Preset layer, and that
  //     layer MUST contain the work-mode row.
  //
  //     This is the gate that would have caught the desktop losing 边缘模式.
  //     The host reads package.json#dsh.bundle.patch as EITHER a string OR a
  //     list (@deepseek-ai/dsh-app-boot bundlePatchFiles) and applies every
  //     entry. A single string therefore "works" — the cordis patch loads,
  //     the Edge half mounts, the logs look healthy — while the preset patch
  //     is never read, the @deepseek-ai/dsh-agent-preset row never registers,
  //     and the work mode simply does not exist in the running desktop.
  //     Nothing errors; the mode is just missing.
  const presetLayers = bundlePatches.filter((p) => /(^|\/)presets\//.test(p))
  if (presetLayers.length === 0) {
    throw new Error(
      `${relative(ROOT, dir)}: package.json#dsh.bundle.patch declares no Agent Preset layer ` +
        `(declared: ${bundlePatches.join(', ')}) — the 边缘模式 work mode would never register. ` +
        'The host reads this field as a LIST of patch files; a single string silently drops the preset patch.',
    )
  }
  for (const layer of presetLayers) {
    const rows = collectInsertRows(readFileSync(join(dir, layer), 'utf-8'))
    const preset = rows.find((r) => r?.name === AGENT_PRESET_PLUGIN)
    if (!preset) {
      throw new Error(
        `${relative(ROOT, dir)}: ${layer} declares no ${AGENT_PRESET_PLUGIN} row — ` +
          'the Agent Preset layer is empty, so no work mode would register',
      )
    }
    const cfg = preset.config ?? {}
    if (!cfg.id || !cfg.name) {
      throw new Error(
        `${relative(ROOT, dir)}: ${layer} has an ${AGENT_PRESET_PLUGIN} row without ` +
          `config.id/config.name (got id=${JSON.stringify(cfg.id)}, name=${JSON.stringify(cfg.name)})`,
      )
    }
    if (!Array.isArray(cfg.plugins) || cfg.plugins.length === 0) {
      throw new Error(
        `${relative(ROOT, dir)}: ${layer} has an ${AGENT_PRESET_PLUGIN} row whose config.plugins is empty`,
      )
    }
  }

  // 2c. The declared list MUST equal the canonical declaration for this
  //     variant (scripts/_bundle-variants.mjs). Four scripts used to write
  //     this field independently and three of them wrote the string form; the
  //     gate now compares against the single source of truth so a new writer
  //     cannot reintroduce the drift.
  const variant = variantByDir(basename(dir))
  if (variant) {
    const expected = bundlePatchDeclaration(variant)
    if (bundlePatches.length !== expected.length || bundlePatches.some((p, i) => p !== expected[i])) {
      throw new Error(
        `${relative(ROOT, dir)}: package.json#dsh.bundle.patch is [${bundlePatches.join(', ')}] ` +
          `but the canonical declaration for ${variant.dir} is [${expected.join(', ')}] ` +
          '(scripts/_bundle-variants.mjs) — the packaging scripts and the canonical table have drifted',
      )
    }
  }

  // 3. dsh.client (optional). The webview module system requires the
  //    declaration shape { platform: 'web', inject?: [...], external?,
  //    immediately? } — `entry` is NOT a member and is ignored by the host
  //    (the bundle path comes from exports['./client']). A malformed or
  //    non-web declaration makes @deepseek-ai/dsh-client-modules skip the
  //    package entirely, so the client half never registers in the webview.
  const dshClient = pkg?.dsh?.client
  let clientNote = null
  if (dshClient !== void 0) {
    if (typeof dshClient !== 'object' || dshClient === null) {
      throw new Error(`${relative(ROOT, dir)}: dsh.client must be an object`)
    }
    if (dshClient.platform !== 'web') {
      throw new Error(
        `${relative(ROOT, dir)}: dsh.client.platform must be "web" (got ${JSON.stringify(dshClient.platform)})`,
      )
    }
    for (const key of ['inject', 'external']) {
      const value = dshClient[key]
      if (value !== void 0 && (!Array.isArray(value) || value.some((s) => typeof s !== 'string'))) {
        throw new Error(`${relative(ROOT, dir)}: dsh.client.${key} must be an array of strings`)
      }
    }
    if (dshClient.immediately !== void 0 && typeof dshClient.immediately !== 'boolean') {
      throw new Error(`${relative(ROOT, dir)}: dsh.client.immediately must be a boolean`)
    }
    const clientRel = typeof pkg.exports?.['./client'] === 'string' ? pkg.exports['./client'] : void 0
    if (clientRel === void 0) {
      throw new Error(`${relative(ROOT, dir)}: declares dsh.client but exports has no "./client" string entry`)
    }
    const clientAbs = join(dir, clientRel.replace(/^\.\//u, ''))
    if (!existsSync(clientAbs)) {
      throw new Error(
        `${relative(ROOT, dir)}: exports["./client"] points at ${clientRel} but the file is missing on disk`,
      )
    }
    clientNote = clientRel
  }

  // 4. presets/ must exist with at least one .json.
  const presetsDir = join(dir, 'presets')
  if (!existsSync(presetsDir)) {
    throw new Error(`${relative(ROOT, dir)}: missing presets/ directory`)
  }
  const presetFiles = readdirSync(presetsDir).filter((n) => n.endsWith('.json'))
  if (presetFiles.length === 0) {
    throw new Error(`${relative(ROOT, dir)}: presets/ contains no .json files`)
  }

  // 5. §7.208: package.json#exports 里指向**资源文件**（yml/json/md/txt）的条目，
  //    它的目标必须真的在这个目录里。
  //
  //    这条补的是 dev-notes/cordis-rc021-patch-loader.md §Bug3 记的那个真事故：
  //    v3 的 installable package.json 写着
  //      "./cordis.desktop-safe.patch.yml": "./cordis.patch.yml"
  //    而那个目录里**只有** cordis.desktop-safe.patch.yml ⇒ 桌面启动时
  //      failed to read overlay .../cordis.patch.yml: ENOENT
  //    ⇒ boot **硬失败**（不是「静默一个都不 mount」）。
  //
  //    当时只查了 `dsh.bundle.patch` 指向的文件在不在，**没查相邻的 export entry**
  //    ⇒ dev-note 里留了这条建议（"如再有精力的话"）一直没做。
  //    现在补上：凡是 exports 里指向非 JS 文件的条目，目标必须在盘上。
  //
  //    为什么只查非 JS 文件：exports 里的 30 多条代码入口指向 lib/ 下的 .js/.d.ts，
  //    那批由 `verify:package`（npm pack 视角）覆盖；而**资源文件**这一类
  //    （3 条 .yml + package.json）没有任何一道门禁管过 —— 正是出事的那些。
  {
    const missing = []
    for (const [key, value] of Object.entries(pkg.exports ?? {})) {
      const targets = []
      if (typeof value === 'string') {
        targets.push(value)
      } else if (value && typeof value === 'object') {
        for (const cond of Object.values(value)) {
          if (typeof cond === 'string') targets.push(cond)
          else if (cond && typeof cond === 'object') {
            for (const inner of Object.values(cond)) {
              if (typeof inner === 'string') targets.push(inner)
            }
          }
        }
      }
      for (const target of targets) {
        if (!/\.(?:ya?ml|json|md|txt)$/u.test(target)) continue
        const rel = target.replace(/^\.\//u, '')
        if (!existsSync(join(dir, rel))) missing.push(`${key} → ${target}`)
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `${relative(ROOT, dir)}: package.json#exports 指向的资源文件不在包里：\n`
        + missing.map((s) => `    - ${s}`).join('\n')
        + '\n  （dev-notes/cordis-rc021-patch-loader.md §Bug3：指针在而文件缺 = 宿主启动时'
        + ' "failed to read overlay …ENOENT" —— boot 硬失败，不是静默降级）',
      )
    }
  }

  return {
    bundle: pkg.name,
    version: pkg.version,
    // §7.135: several patch layers (host-row overrides + the Agent Preset).
    variant: bundlePatches.join(' + '),
    client: clientNote,
    presets: presetFiles.length,
  }
}

// §7.101 v6.1: every conditional exports entry must list a 'require' or
// 'default' condition. Node's CJS resolver will skip an entry that only
// declares 'import', producing ERR_PACKAGE_PATH_NOT_EXPORTED on
// require('@scope/pkg'). The desktop GUI loader uses CJS for many host
// paths, so missing require/default silently breaks mount.
function verifyExportsConditions(pkg, dirRel) {
  if (!pkg.exports || typeof pkg.exports !== 'object') return
  const missing = []
  for (const [key, value] of Object.entries(pkg.exports)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      continue
    }
    const conds = Object.keys(value)
    if (conds.length === 0) continue
    const hasFallback = conds.includes('require') || conds.includes('default')
    const hasImportish = conds.includes('import') || conds.includes('types')
    if (hasImportish && !hasFallback) {
      missing.push(key)
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `${dirRel}: exports entries missing 'require'/'default' fallback: ` +
        missing.join(', ') +
        ' (will ERR_PACKAGE_PATH_NOT_EXPORTED on require())',
    )
  }
}

let dirs
try {
  dirs = readdirSync(INSTALLABLE)
    .map((name) => join(INSTALLABLE, name))
    .filter((p) => statSync(p).isDirectory())
} catch {
  console.error(`installable dir not found: ${relative(ROOT, INSTALLABLE)}`)
  console.error('(run `make installable` or `npm run build` first)')
  process.exit(1)
}

if (dirs.length === 0) {
  console.error('no bundles under dist/installable/')
  process.exit(1)
}

const reports = []
for (const dir of dirs) {
  try {
    const r = verifyBundle(dir)
    // Cross-check exports condition keys against the package.json we just read.
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    verifyExportsConditions(pkg, relative(ROOT, dir))
    reports.push(r)
  } catch (e) {
    console.error(`verify-installable: ${e.message}`)
    process.exit(1)
  }
}

console.log(`verify-installable OK (${reports.length} bundles)`)
for (const r of reports) {
  const clientNote = r.client ? `client=${r.client}` : 'client=(none)'
  console.log(
    `  - ${r.bundle}@${r.version}: patch=${r.variant}, ${clientNote}, presets=${r.presets}`,
  )
}
