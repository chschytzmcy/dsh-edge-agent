// scripts/_sync-to-nested.mjs
//
// §7.101.x fix #3: rsync the freshly-built `dist/installable/dsh-edge-agent-desktop-safe/`
// tree into the live desktop profile's nested install. The shell script
// install.sh does this through pnpm install hooks; on Windows sandboxes
// without pnpm + bash, this Node mirror does the equivalent copy.
//
// Path: dist/installable/dsh-edge-agent-desktop-safe/*
//    → ~/.dsh/profiles/desktop/node_modules/@deepseek-harness-edge-agent/dsh-edge-agent/*
//
// Behaviour matches scripts/build-desktop-bundle.sh's staging block:
//   - the installable package.json replaces the nested one (already a
//     desktop-safe variant);
//   - lib/ + presets/ + cordis.*.yml are byte-copied.
//   - Scripts/devDependencies that ship in repo's package.json are stripped
//     by build-desktop-bundle.sh before staging — we copy the staged
//     tree directly, so the installed variant is already clean.

import { cpSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STAGE = join(ROOT, 'dist', 'installable', 'dsh-edge-agent-desktop-safe')
const NESTED = join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'desktop',
  'node_modules', '@deepseek-harness-edge-agent', 'dsh-edge-agent')

if (!statSync(STAGE, { throwIfNoEntry: false })) {
  console.error(`staged tree missing: ${STAGE}`)
  console.error('run: node scripts/_rebuild-installable.mjs first')
  process.exit(1)
}

console.log(`stage:   ${STAGE}`)
console.log(`nested:  ${NESTED}`)

// rmSync the nested directory tree then cpSync the staged one on top.
rmSync(NESTED, { recursive: true, force: true })
cpSync(STAGE, NESTED, { recursive: true })

// Report sizes for the affected files (so the user can see delta).
// §7.101.x layout fix (2026-10-20): the bundle is now flat (lib/index.js
// is the host-half plugin, lib/dsh-adapter/<x>.js is the sub-plugin
// family). The old lib/types/<x>.js paths are gone.
const interesting = [
  'package.json',
  'cordis.desktop-safe.patch.yml',
  'lib/client.js',
  'lib/index.js',
  'lib/dsh-adapter/index.js',
  'lib/dsh-adapter/edge-context-view.js',
]
console.log()
console.log('synced files:')
for (const f of interesting) {
  try {
    console.log(`  ✓ ${f.padEnd(48)} ${String(statSync(join(NESTED, f)).size).padStart(8)} bytes`)
  } catch {
    console.log(`  ✗ ${f.padEnd(48)} MISSING`)
  }
}

console.log()
console.log('next step: restart DSH Desktop (tray exit + reopen).')