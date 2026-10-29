// scripts/_rebuild-installable.mjs
// Platform-neutral Node mirror of build-desktop-bundle.sh's staging block:
// re-stage dist/installable/{desktop-safe,full}/ from the repo root. Use
// this when bash/pnpm are unavailable (Windows hosts, constrained sandboxes)
// or when only package.json/patch yml changed and the shell script's tarball
// step is not needed. Works identically on Windows/macOS/Linux.
//
// Encoding note: text patch files carry § and — characters; copy them with
// raw buffers (copyFile) rather than string round-trips so UTF-8 bytes stay
// byte-exact on every platform.

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BUNDLE_VARIANTS, bundlePatchDeclaration } from './_bundle-variants.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')

const base = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

// §7.153: the variant table + the `dsh.bundle.patch` declaration come from
// the shared module. This script used to write the STRING form, which
// silently drops the Agent Preset layer ⇒ the 边缘模式 work mode was never
// registered in the desktop.
const variants = BUNDLE_VARIANTS.map((v) => ({
  name: v.dir,
  version: `${base.version}${v.versionSuffix}`,
  description: v.description,
  patch: bundlePatchDeclaration(v),
}))

const stageRoot = mkdtempSync(join(tmpdir(), 'dsh-edge-bundle-'))

for (const v of variants) {
  const dir = join(stageRoot, v.name)
  mkdirSync(dir, { recursive: true })

  const pkg = { ...base }
  pkg.version = v.version
  pkg.description = v.description
  delete pkg.scripts
  delete pkg.devDependencies
  pkg.files = ['lib', 'cordis.patch.yml', 'cordis.desktop-safe.patch.yml', 'cordis.yml', 'presets']
  pkg.dsh = { ...(pkg.dsh || {}), bundle: { ...(pkg.dsh.bundle || {}), patch: v.patch } }

  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
  cpSync(join(ROOT, 'lib'), join(dir, 'lib'), { recursive: true })
  cpSync(join(ROOT, 'presets'), join(dir, 'presets'), { recursive: true })
  // Buffer-copy text patch files to preserve UTF-8 bytes on Windows.
  for (const f of ['cordis.yml', 'cordis.patch.yml', 'cordis.desktop-safe.patch.yml']) {
    await copyFile(join(ROOT, f), join(dir, f))
  }
  console.log(`staged ${v.name} -> ${v.patch.join(' + ')}`)
}

mkdirSync(join(DIST, 'installable'), { recursive: true })
for (const v of variants) {
  const src = join(stageRoot, v.name)
  const dest = join(DIST, 'installable', v.name)
  rmSync(dest, { recursive: true, force: true })
  cpSync(src, dest, { recursive: true })
  console.log(`==> ${dest}`)
}

rmSync(stageRoot, { recursive: true, force: true })

// Tarballs are only produced by scripts/build-desktop-bundle.sh (needs bash +
// tar). On hosts without them this Node mirror refreshes the installable
// directories only — re-run the shell script on a unix-like host if you need
// the tarball artifacts.
console.log('(tarball step belongs to scripts/build-desktop-bundle.sh; run it on a bash host if tarballs are needed.)')

console.log('installable directories refreshed.')