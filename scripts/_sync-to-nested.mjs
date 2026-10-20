// scripts/_sync-to-nested.mjs
//
// §7.101.x fix #3: rsync the freshly-built `dist/installable/dsh-edge-agent-desktop-safe/`
// tree into the live desktop profile's nested install. The shell script
// install.sh does this through pnpm install hooks; where pnpm/bash are
// unavailable (or in sandboxes that block their child processes), this
// Node mirror does the equivalent copy on ANY platform (Windows/macOS/Linux).
//
// Path: dist/installable/dsh-edge-agent-desktop-safe/*
//    → ~/.dsh/profiles/desktop/node_modules/@deepseek-harness-edge-agent/dsh-edge-agent/*

import { cpSync, lstatSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STAGE = join(ROOT, 'dist', 'installable', 'dsh-edge-agent-desktop-safe')
// Cross-platform home resolution: USERPROFILE (Windows), HOME (macOS/Linux),
// then os.homedir() as the Node-native fallback. Never silently target an
// empty path — that would "sync" into a bogus relative directory.
const HOME = process.env.USERPROFILE || process.env.HOME || homedir()
if (!HOME) {
  console.error('cannot resolve home directory (USERPROFILE/HOME/homedir all empty)')
  process.exit(1)
}
const NESTED = join(HOME, '.dsh', 'profiles', 'desktop',
  'node_modules', '@deepseek-harness-edge-agent', 'dsh-edge-agent')

if (!statSync(STAGE, { throwIfNoEntry: false })) {
  console.error(`staged tree missing: ${STAGE}`)
  console.error('run: node scripts/_rebuild-installable.mjs first')
  process.exit(1)
}

console.log(`stage:   ${STAGE}`)
console.log(`nested:  ${NESTED}`)

// Guard: if the nested path is a symlink (pnpm `link:`/`file:` installs do
// this on macOS/Linux — and did here until a sandbox forced a physical copy),
// rmSync would delete the LINK TARGET's tree, not just the link. In that
// configuration the sync is unnecessary anyway: the link already points at
// dist/installable, so rebuilding installable IS the deploy.
let nestedStat = null
try {
  nestedStat = lstatSync(NESTED)
} catch { /* absent → plain copy below */ }
if (nestedStat?.isSymbolicLink()) {
  console.log()
  console.log('nested install is a SYMLINK to the staged tree — nothing to copy.')
  console.log('(rebuilding dist/installable above already deployed; restart DSH Desktop.)')
  process.exit(0)
}

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