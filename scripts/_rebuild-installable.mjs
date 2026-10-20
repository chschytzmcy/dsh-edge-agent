// scripts/_rebuild-installable.mjs
// Windows shim: re-run the same staging logic as build-desktop-bundle.sh's
// Node block to recreate dist/installable/{desktop-safe,full}/. The shell
// script itself uses bash features that aren't available on every
// Windows host, so the equivalent Node mirror is used here. Delete this
// once the shell script's staging block is moved into its own .mjs.
//
// Encoding note (Windows): fs.cpSync does not always preserve UTF-8 bytes
// when crossing mount points on Windows hosts; use the raw-buffer copyFile
// for the text patch files (which carry § and — characters in comments).

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')

const base = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

const variants = [
  {
    name: 'dsh-edge-agent-desktop-safe',
    version: `${base.version}-desktop-safe`,
    patch: './cordis.desktop-safe.patch.yml',
    description: 'dsh-edge-agent bundle — desktop-safe overlay (inserts the privacy stack, does NOT rewrite host defaults: model / persona / approval / sandbox / session root / http-api)',
  },
  {
    name: 'dsh-edge-agent-full',
    version: `${base.version}-full`,
    patch: './cordis.patch.yml',
    description: 'dsh-edge-agent bundle — full production patch (same behaviour as the standalone dsh-edge profile; rewrites host defaults)',
  },
]

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
  console.log(`staged ${v.name} -> ${v.patch}`)
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

// Also rebuild tarballs next to the existing ones (preserves file names).
console.log('(tarball refresh skipped — bash + tar are unavailable on this Windows host. Run `bash scripts/build-desktop-bundle.sh` on a unix-like host if you need tarballs.)')

console.log('installable directories refreshed.')