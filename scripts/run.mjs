/**
 * run.mjs — package-manager-agnostic script runner.
 *
 * Why this exists (2026-10-23): every chain script in package.json used to
 * shell out to `npm run <other>`. The DSH desktop runtime ships **node +
 * pnpm but no npm** (`runtime/primary-runtime/dependencies/` = node, pnpm,
 * python — nothing else), so `pnpm run build` died at the first nested call
 * with `sh: npm: command not found`. The standalone `make package` /
 * `install.sh` path had the same hole: it shells out to `pnpm run compile`,
 * which then shelled out to `npm run clean`.
 *
 * This runner resolves script names straight from package.json#scripts and
 * executes them with the local shell. package.json refers to other scripts
 * as `node scripts/run.mjs <name>` — no package manager in the loop — so the
 * same tree builds under npm, under pnpm, or with neither installed.
 *
 * Usage:
 *   node scripts/run.mjs build
 *   node scripts/run.mjs verify:build
 *   node scripts/run.mjs compile verify:installable
 *
 * A script exits non-zero when any of the scripts it chains fails; the
 * failing step's output is already on the terminal (stdio is inherited).
 */

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BIN = resolve(ROOT, 'node_modules', '.bin')

const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'))
const scripts = pkg.scripts ?? {}

/** Run one script body in a shell, resolving to its exit code. */
function run(name) {
  const body = scripts[name]
  if (body === undefined) {
    console.error(`run: no such script "${name}" in package.json`)
    return Promise.resolve(1)
  }
  console.log(`> ${name}: ${body}`)
  return new Promise((done) => {
    const child = spawn(body, {
      cwd: ROOT,
      shell: true,
      stdio: 'inherit',
      env: {
        ...process.env,
        // tsc / vitest / esbuild live in node_modules/.bin. npm and pnpm put
        // that directory on PATH when they run a script; this runner may be
        // invoked from a bare shell, so it puts it there itself.
        PATH: `${BIN}${delimiter()}${process.env.PATH ?? ''}`,
      },
    })
    child.on('close', (code) => done(code ?? 1))
    child.on('error', (err) => {
      console.error(`run: ${name} failed to start: ${err.message}`)
      done(1)
    })
  })
}

function delimiter() {
  return process.platform === 'win32' ? ';' : ':'
}

const names = process.argv.slice(2)
if (names.length === 0) {
  console.error('usage: node scripts/run.mjs <script> [<script> ...]')
  process.exit(2)
}

for (const name of names) {
  const code = await run(name)
  if (code !== 0) process.exit(code)
}
