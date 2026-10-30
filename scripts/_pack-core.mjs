// _pack-core.mjs — shared packaging core for the three platform scripts.
//
// Platform-independent by construction: everything here is plain Node
// (fs + child_process), so Windows / macOS / Linux produce byte-identical
// staging trees. The per-platform scripts only differ in:
//   - where the DSH runtime lives (App bundle vs PATH)
//   - how the tarball is produced (bsdtar vs GNU tar vs node tar)
//   - what the deployment target is (desktop profile vs CLI profile)
//
// This module owns:
//   1. locating a usable node / pnpm (array-based, so paths with spaces work)
//   2. staging the bundle variants into a temp dir
//   3. emitting the installable directories (dist/installable/<variant>/)
//   4. producing the tarballs (dist/<variant>.tar.gz)
//
// The two hard-won rules encoded here:
//
//   §A. A command is an ARRAY, never a string. "node pnpm.mjs" as one string
//       breaks on Windows, where BOTH paths contain spaces
//       ("C:\Program Files\…", "…\DeepSeek Harness\…"). bash word-splits
//       the unquoted expansion and tries to exec "/c/Program".
//
//   §B. The tarball's top-level directory must be named `package`
//       (npm/pnpm's expectation). GNU tar's --transform flag is not portable
//       across bsdtar / Git Bash tar, so the directory is renamed instead.
//
// Usage:
//   node scripts/_pack-core.mjs stage     # → staging dirs in a temp root
//   node scripts/_pack-core.mjs installable
//   node scripts/_pack-core.mjs tarball
//   node scripts/_pack-core.mjs all
//
// The CLI prints shell-friendly exports so a wrapper script can eval them:
//   NODE_BIN=...
//   PNPM_CMD=...

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BUNDLE_VARIANTS, bundlePatchDeclaration } from './_bundle-variants.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')

/* ── §A. Toolchain discovery (array-based) ─────────────────────────── */

/** Normalize a Windows-style path to forward slashes (Git Bash mangles LOCALAPPDATA). */
function slash(p) {
  return p.replace(/\\/g, '/')
}

function isFile(p) {
  try {
    if (!p) return false
    return statSync(p).isFile()
  } catch { return false }
}

function which(cmd) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8' })
  if (r.status !== 0) return undefined
  const first = (r.stdout ?? '').split(/\r?\n/u).map(s => s.trim()).filter(Boolean)[0]
  return first || undefined
}

/**
 * Find the `tar` executable.
 *
 * On Windows the Git-Bash tar lives in "/usr/bin/tar.exe" — a MSYS2 path
 * that Windows' `where` cannot see, and that Node cannot exec directly
 * (it is a PE binary, so it CAN — but only if the PATH entry is visible).
 * The build script always runs under Git Bash, whose PATH does include
 * /usr/bin, so plain `tar` resolves. The explicit candidates below are the
 * fallback for a Windows-native invocation (PowerShell / cmd), where the
 * only tar is the system bsdtar at C:\Windows\System32\tar.exe.
 */
export function findTar() {
  const candidates = [
    which('tar'),
    'C:/Windows/System32/tar.exe',
    'C:/Program Files/Git/usr/bin/tar.exe',
    '/usr/bin/tar',
    '/bin/tar',
  ].filter(Boolean)
  for (const c of candidates) {
    if (isFile(c)) return slash(c)
  }
  // Fall back to the bare name — PATH lookup at exec time.
  return 'tar'
}

/**
 * Find node. Order:
 *   1. explicit NODE_BIN
 *   2. PATH
 *   3. DSH App runtime (macOS .app bundle / Windows LOCALAPPDATA)
 *   4. ~/.dsh/dsh-runtimes/dsh-primary-runtime
 */
export function findNode() {
  if (process.env.NODE_BIN && isFile(process.env.NODE_BIN)) return slash(process.env.NODE_BIN)
  const onPath = which('node')
  if (onPath) return slash(onPath)

  const localAppData = slash(process.env.LOCALAPPDATA ?? '')
  const candidates = [
    `${localAppData}/Programs/DeepSeek Harness/resources/runtime/bin/node.exe`,
    `${localAppData}/Programs/DeepSeek Harness/resources/runtime/primary-runtime/dependencies/node/bin/node.exe`,
    '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/bin/node',
    `${homedir()}/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node`,
    `${homedir()}/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe`,
  ].filter(Boolean)
  for (const c of candidates) if (isFile(c)) return slash(c)
  return undefined
}

/**
 * Find pnpm as an argv ARRAY (never a string).
 * Order:
 *   1. explicit PNPM (must be an executable path — a "node script.mjs"
 *      two-word form is rejected: it is the source of the word-split bug)
 *   2. PATH
 *   3. DSH App runtime's bundled pnpm (node + pnpm.mjs as two argv items)
 *   4. ~/.dsh/dsh-runtimes
 */
export function findPnpm(nodeBin) {
  const explicit = process.env.PNPM
  if (explicit) {
    if (!isFile(explicit)) {
      throw new Error(`PNPM 覆盖值不是可执行文件：${explicit}`)
    }
    return [slash(explicit)]
  }

  const onPath = which('pnpm')
  if (onPath) {
    // Windows: `where pnpm` lists EVERY match, and npm writes an
    // extension-less POSIX shim (`…\npm\pnpm`) NEXT to `pnpm.cmd`. The shim
    // is not a PE binary, so CreateProcess cannot exec it — and the cmd.exe
    // route is unreliable under Node's own argument quoting (four different
    // quoting forms were measured failing on 2026-10-30).
    //
    // So on Windows, go straight for the REAL executable instead of the shim:
    //   · npm's global layout ships a native `pnpm.exe` under node_modules/pnpm/
    //   · older layouts ship a `bin/pnpm.mjs` we can run with node
    // Both are exec'able without cmd.exe, which is the whole point.
    if (process.platform === 'win32') {
      const dir = dirname(slash(onPath))
      const nativeExe = join(dir, 'node_modules', 'pnpm', 'pnpm.exe')
      if (isFile(nativeExe)) return [slash(nativeExe)]
      const mjs = join(dir, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs')
      if (isFile(mjs) && nodeBin) return [nodeBin, slash(mjs)]
    } else {
      return [slash(onPath)]
    }
  }

  const localAppData = slash(process.env.LOCALAPPDATA ?? '')
  const candidates = [
    `${localAppData}/Programs/DeepSeek Harness/resources/runtime/dependencies/pnpm/bin/pnpm.mjs`,
    `${localAppData}/Programs/DeepSeek Harness/resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs`,
    '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs',
    `${homedir()}/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs`,
  ].filter(Boolean)
  for (const c of candidates) {
    if (isFile(c) && nodeBin) return [nodeBin, slash(c)]
  }
  return []
}

/**
 * Run a command given as an argv array. Returns { status, stdout, stderr }.
 *
 * Windows: a `pnpm` resolved from PATH is a `pnpm.cmd` shim. CreateProcess
 * cannot exec a .cmd directly (EINVAL), and `shell:true` makes Node join
 * argv into a command line that cmd.exe then re-splits — a path with
 * spaces ("C:\Program Files\nodejs\node.exe") would break, with the child
 * trying to run "C:\Program".
 *
 * The reliable form on Windows is to run the shim THROUGH cmd.exe with
 * the whole command line quoted as one argument:
 *     cmd.exe /d /s /c "<quoted command line>"
 * where the inner line has each element double-quoted. cmd.exe's /s flag
 * strips the outer quotes and runs the rest verbatim.
 */
export function run(argv, opts = {}) {
  const [cmd, ...rawArgs] = argv
  const isWindows = process.platform === 'win32'
  const isCmdShim = isWindows && /\.(?:cmd|bat)$/iu.test(cmd)

  let file = cmd
  let args = rawArgs
  let shell = false
  let windowsVerbatimArguments = false
  if (isCmdShim) {
    file = process.env.ComSpec ?? 'cmd.exe'
    const inner = [cmd, ...rawArgs].map(quoteArg).join(' ')
    // cmd.exe's `/c` strips ONE pair of outer quotes before executing the
    // rest, so the command line has to carry a SECOND outer pair on top of
    // the per-argument quotes: `""C:\a b\x.cmd" "arg""`.
    //
    // `windowsVerbatimArguments: true` is what makes that possible: without
    // it Node re-quotes every argument that contains a space, and the two
    // layers of quoting no longer line up — measured on 2026-10-30, all four
    // quoting shapes failed with "is not recognized as an internal or
    // external command".
    args = ['/d', '/s', '/c', `""${inner}""`]
    shell = false
    windowsVerbatimArguments = true
  }

  const r = spawnSync(file, args, {
    cwd: opts.cwd ?? ROOT,
    encoding: 'utf8',
    stdio: opts.quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: { ...process.env, ...(opts.env ?? {}) },
    shell,
    windowsVerbatimArguments,
  })
  return {
    status: r.status ?? 1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  }
}

/**
 * Quote one argv element for a cmd.exe command line.
 *
 * Backslashes are only special when they immediately precede the closing
 * quote, so a trailing run of backslashes must be doubled; everything
 * else passes through. Embedded double quotes are escaped as \".
 */
function quoteArg(arg) {
  const str = String(arg)
  const trailing = /(\\*)$/u.exec(str)?.[1] ?? ''
  const body = str.slice(0, str.length - trailing.length).replace(/"/gu, '\\"')
  return `"${body}${trailing.replace(/\\/gu, '\\\\')}"`
}

/* ── Variant definitions ────────────────────────────────────────────── */

// §7.153: the variant table lives in _bundle-variants.mjs — the single
// source of truth. Four scripts used to declare it (and the `dsh.bundle.patch`
// value derived from it) independently, and three of them wrote the STRING
// form, which silently drops the Agent Preset layer ⇒ the 边缘模式 work mode
// was never registered in the desktop. `patch` is kept as an alias for
// `patchField` so the legacy readers below keep working.
export const VARIANTS = BUNDLE_VARIANTS.map((v) => ({ ...v, patch: v.patchField }))

/* ── Staging ────────────────────────────────────────────────────────── */

/**
 * Stage one variant into `destDir`.
 *
 * The variant's package.json drops `scripts` and `devDependencies`: a
 * directory dependency's `prepare` script runs on install, and the desktop
 * runtime has neither npm nor the devDeps needed to compile. The artifact
 * already carries a compiled lib/.
 *
 * `config/edge.json` handling DIFFERS by artifact — this is load-bearing:
 *
 *   - DISTRIBUTABLE (tarball, npm pack): EXCLUDES config/edge.json. That
 *     file holds the operator's real endpoints and API keys in plaintext and
 *     must never reach a distributable artifact.
 *
 *   - LOCAL INSTALLABLE DIR (link mode): KEEPS config/edge.json. The desktop
 *     profile mounts this directory through a junction/link:, and the
 *     plugin's FIRST config candidate is `<bundle>/config/edge.json`
 *     (edgeConfigCandidates() in edge-config.ts). Dropping it would push
 *     the desktop onto the example template or the ~/.dsh-edge-agent/
 *     fallback — the operator's live endpoints would silently stop being
 *     the ones in use.
 */
export function stageVariant(variant, destDir, { keepSecretConfig = false } = {}) {
  const base = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  mkdirSync(destDir, { recursive: true })

  const pkg = { ...base }
  pkg.version = `${base.version}${variant.versionSuffix}`
  pkg.description = variant.description
  delete pkg.scripts
  delete pkg.devDependencies
  pkg.files = ['lib', 'config', 'cordis.patch.yml', 'cordis.desktop-safe.patch.yml', 'cordis.yml', 'presets']
  // §7.153: the bundle carries TWO patch layers — the host-row overrides
  // (cordis patch) and the **Agent Preset** declaration (the 边缘模式 work
  // mode). The host's own dsh-web-app bundle uses the same list shape
  // (`"patch": ["./cordis.patch.yml", "./presets/standard.patch.yml", …]`).
  //
  // This line used to write the STRING form (`./cordis.desktop-safe.patch.yml`),
  // which the host accepts — and which silently drops the preset layer: the
  // `@deepseek-ai/dsh-agent-preset` row never loads, the 边缘模式 work mode is
  // never registered, and the desktop's work-mode selector shows nothing new
  // with no error anywhere. That is why the desktop build produced an
  // artifact without the 边缘模式 work mode at all.
  pkg.dsh = {
    ...(pkg.dsh ?? {}),
    bundle: { ...(pkg.dsh?.bundle ?? {}), patch: bundlePatchDeclaration(variant) },
  }

  writeFileSync(join(destDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
  cpSync(join(ROOT, 'lib'), join(destDir, 'lib'), { recursive: true })
  cpSync(join(ROOT, 'presets'), join(destDir, 'presets'), { recursive: true })
  for (const f of ['cordis.yml', 'cordis.patch.yml', 'cordis.desktop-safe.patch.yml']) {
    cpSync(join(ROOT, f), join(destDir, f), { recursive: true })
  }

  const configSrc = join(ROOT, 'config')
  if (existsSync(configSrc)) {
    mkdirSync(join(destDir, 'config'), { recursive: true })
    for (const f of readdirSync(configSrc)) {
      if (f === 'edge.json' && !keepSecretConfig) continue
      cpSync(join(configSrc, f), join(destDir, 'config', f), { recursive: true })
    }
  }
  return pkg
}

/* ── Installable directories (link-mode artifact) ───────────────────── */

/**
 * Rename with a short backoff for EPERM/EBUSY.
 *
 * Windows quirk: right after a write closes the handle, Defender/indexer
 * can hold the directory open for milliseconds — rename() then fails with
 * EPERM even though nothing is logically wrong. The lock clears on its own;
 * POSIX platforms never hit this path.
 */
function renameWithRetry(from, to, attempts = 3, delayMs = 300) {
  let lastCode
  for (let i = 0; i < attempts; i++) {
    if (i > 0) {
      const end = Date.now() + delayMs * i
      while (Date.now() < end) { /* spin-wait; the script is synchronous */ }
    }
    try {
      renameSync(from, to)
      return true
    } catch (err) {
      lastCode = err?.code
      if (lastCode !== 'EPERM' && lastCode !== 'EBUSY' && lastCode !== 'ENOTEMPTY') throw err
    }
  }
  console.warn(`  warning: rename still locked after ${attempts} attempts (${lastCode})`)
  return false
}

/**
 * Degraded path: overwrite the target entry-wise (the target does not move).
 * The `link:` install path must stay valid — that is the whole point of
 * the link mode. Entries missing from the staging dir are left alone
 * (harmless: the installable set is fully enumerated by files+patch+manifest).
 */
function syncEntriesInPlace(staging, target) {
  const failed = []
  for (const entry of readdirSync(staging)) {
    const dst = join(target, entry)
    try {
      rmSync(dst, { recursive: true, force: true })
      cpSync(join(staging, entry), dst, { recursive: true })
    } catch (err) {
      failed.push(`${entry} (${err?.code ?? err?.message})`)
    }
  }
  if (failed.length > 0) {
    console.warn(`  warning: ${failed.length} entries could not be synced in-place: ${failed.join(', ')}`)
    console.warn('           quit the app holding the directory and rerun for a clean atomic swap')
  }
}

/**
 * Rebuild dist/installable/<variant>/ for every variant.
 *
 * §7.103: the desktop profile installs this bundle as a pnpm `link:` pointing
 * at dist/installable/<variant>. Deleting that path (the old `rm -rf`)
 * breaks the link for as long as the rebuild takes — and pnpm's watcher
 * reacts by moving the installed package into node_modules/.ignored/,
 * i.e. the plugin silently disappears from the profile and the Edge tab
 * never appears. Building beside the target and renaming keeps the link
 * path continuously valid.
 *
 * §Windows: when the target is locked by a LIVE handle (the running desktop
 * App holding the `link:` install open — retry never clears it), degrade to
 * an entry-wise in-place sync instead of dying.
 */
export function buildInstallable() {
  if (!existsSync(join(ROOT, 'lib'))) {
    throw new Error('lib/ not found — run the compile step first')
  }
  const installableRoot = join(DIST, 'installable')
  mkdirSync(installableRoot, { recursive: true })

  for (const variant of VARIANTS) {
    const target = join(installableRoot, variant.dir)
    const staging = join(installableRoot, `.${variant.dir}.staging`)
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })

    stageVariant(variant, staging, { keepSecretConfig: true })

    const retired = join(installableRoot, `.${variant.dir}.retired`)
    rmSync(retired, { recursive: true, force: true })
    let inPlace = false
    if (existsSync(target) && !renameWithRetry(target, retired)) {
      console.warn(`  warning: ${variant.dir} is locked (running desktop App?) — in-place sync instead of atomic swap`)
      syncEntriesInPlace(staging, target)
      rmSync(staging, { recursive: true, force: true })
      inPlace = true
    }
    if (!inPlace) {
      renameSync(staging, target)
      rmSync(retired, { recursive: true, force: true })
    }
    console.log(`  built ${variant.dir} (patch=${variant.patchField}${inPlace ? ', in-place' : ''})`)
  }
}

/* ── Tarball (file-mode artifact) ───────────────────────────────────── */

/**
 * Create a .tar.gz whose single top-level entry is named `package`.
 *
 * Uses the system `tar` (GNU tar / bsdtar / Git Bash tar all accept this
 * form). `--no-xattrs` is a GNU-only flag — bsdtar rejects it — so it is
 * probed rather than assumed.
 *
 * §C: tar must NOT see an absolute Windows path.
 * GNU tar's host:path syntax makes a leading "C:" a REMOTE HOST name — it
 * then tries to reach a host called "C" ("Cannot connect to C: resolve
 * failed", exit 128). Git Bash's tar hits this on every absolute path.
 * The fix: give tar NO absolute paths at all — run it with cwd = the
 * staging dir and a relative operand, then move the result with Node
 * (which handles Windows paths correctly).
 */
export function makeTarball(variant, outFile) {
  const stageRoot = mkdtempSync(join(tmpdir(), 'dsh-edge-pack-'))
  try {
    const staged = join(stageRoot, variant.dir)
    stageVariant(variant, staged)

    // §B: npm/pnpm expect the tarball's top-level directory to be `package`.
    renameSync(staged, join(stageRoot, 'package'))

    const localTar = 'bundle.tar.gz'
    const tarBin = findTar()
    const noXattrs = tarSupportsNoXattrs(tarBin) ? ['--no-xattrs'] : []
    const r = run([tarBin, ...noXattrs, '-czf', localTar, 'package'], {
      cwd: stageRoot,
      // macOS: libarchive writes AppleDouble resource forks unless told not
      // to. Harmless elsewhere.
      env: { COPYFILE_DISABLE: '1' },
    })
    if (r.status !== 0) throw new Error(`tar failed (exit ${r.status}) for ${outFile}`)

    mkdirSync(dirname(outFile), { recursive: true })
    rmSync(outFile, { force: true })
    moveFile(join(stageRoot, localTar), outFile)

    writeChecksum(outFile)
    console.log(`  built ${outFile}`)
  } finally {
    rmSync(stageRoot, { recursive: true, force: true })
  }
}

/** Move a file, falling back to copy+unlink when it crosses devices (EXDEV). */
function moveFile(from, to) {
  try {
    renameSync(from, to)
  } catch (err) {
    if (err?.code !== 'EXDEV') throw err
    copyFileSync(from, to)
    rmSync(from, { force: true })
  }
}

/** bsdtar (macOS) does not know --no-xattrs; libarchive never writes xattrs anyway. */
function tarSupportsNoXattrs(tarBin) {
  if (process.platform === 'darwin') return false
  const r = run([tarBin, '--version'], { quiet: true })
  if (r.status !== 0) return false
  return !/bsdtar/iu.test(r.stdout ?? '')
}

/**
 * Write `<file>.sha256` next to the tarball.
 *
 * Computed with Node's crypto, not an external tool: on Git Bash `shasum`
 * is a perl script, and Windows' CreateProcess cannot exec a shebang
 * script — spawnSync on it fails with EINVAL. Node's crypto is present on
 * every platform and needs no PATH lookup.
 *
 * Format matches `shasum -a 256` / `sha256sum`: "<hex>  <basename>\n"
 * (two spaces, so `sha256sum -c` accepts it).
 */
function writeChecksum(file) {
  const hash = createHash('sha256')
  hash.update(readFileSync(file))
  const base = basename(file)
  writeFileSync(`${file}.sha256`, `${hash.digest('hex')}  ${base}\n`, 'utf8')
}

/* ── Compile ────────────────────────────────────────────────────────── */

/**
 * Produce both halves of the artifact set:
 *   lib/*.js        tsc output (host half)
 *   lib/client.js   esbuild bundle (Edge tab client)
 *
 * The second one is NOT produced by `pnpm run compile` — missing it makes
 * the tarball build fine but the Edge tab silently never appears (measured
 * 2026-10-24), so it is checked explicitly.
 *
 * The compile lives here rather than in the shell wrappers so the argv
 * array never has to cross a process boundary (marshalling "node pnpm.mjs"
 * back into a shell array is exactly where the word-split bug came back).
 */
export function compile() {
  const node = findNode()
  if (!node) throw new Error('找不到 node。设置 NODE_BIN=/path/to/node')
  const pnpm = findPnpm(node)
  if (pnpm.length === 0) throw new Error('找不到 pnpm。设置 PNPM=/path/to/pnpm')

  console.log(`==> node:  ${node} (${run([node, '-v'], { quiet: true }).stdout.trim()})`)
  console.log(`==> pnpm:  ${pnpm.join(' ')}`)

  const binDir = dirname(node)
  const env = { PATH: `${binDir}${delimiter()}${process.env.PATH ?? ''}` }
  const r = run([...pnpm, 'run', 'compile'], { cwd: ROOT, env })
  if (r.status !== 0) throw new Error(`pnpm run compile 失败（exit ${r.status}）`)

  const client = run([node, join(ROOT, 'scripts', 'build-client.mjs')], { cwd: ROOT, env })
  if (client.status !== 0) throw new Error(`build-client.mjs 失败（exit ${client.status}）`)

  if (!existsSync(join(ROOT, 'lib', 'index.js'))) throw new Error('lib/index.js 不存在')
  if (!existsSync(join(ROOT, 'lib', 'client.js'))) {
    throw new Error('lib/client.js 不存在（Edge tab 客户端 bundle，compile 不产它）')
  }
}

function delimiter() {
  return process.platform === 'win32' ? ';' : ':'
}

/* ── CLI ────────────────────────────────────────────────────────────── */

/**
 * Print the artifact paths in a form the CONSUMER can use directly.
 *
 * §D: on Windows the shell's `$DIST` is an MSYS2 path ("/c/Users/…"),
 * which the desktop App (a native Windows app) rejects with "a local
 * path must be absolute". Node's path.join produces the native form
 * ("C:\Users\…"), which is what the App and the dsh CLI both want.
 *
 * So the shell wrappers ask THIS module for the paths instead of
 * interpolating their own $DIST.
 */
export function artifactPaths() {
  const out = {
    installableDir: join(DIST, 'installable', 'dsh-edge-agent-desktop-safe'),
    installableDirFull: join(DIST, 'installable', 'dsh-edge-agent-full'),
    tarball: join(DIST, 'dsh-edge-agent-desktop-safe.tar.gz'),
    tarballFull: join(DIST, 'dsh-edge-agent-full.tar.gz'),
  }
  return out
}

// Run the CLI ONLY when this file is the entry point. Without the guard,
// importing the module (e.g. from a test) would execute the 'all' mode and
// rewrite dist/ as a side effect of the import.
const isEntryPoint = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isEntryPoint) {
  const MODE = process.argv[2] ?? 'all'
  try {
    if (MODE === 'compile') {
      compile()
    } else if (MODE === 'paths') {
      const p = artifactPaths()
      console.log(`INSTALLABLE_DIR=${p.installableDir}`)
      console.log(`INSTALLABLE_DIR_FULL=${p.installableDirFull}`)
      console.log(`TARBALL=${p.tarball}`)
      console.log(`TARBALL_FULL=${p.tarballFull}`)
    } else if (MODE === 'installable') {
      buildInstallable()
    } else if (MODE === 'tarball') {
      mkdirSync(DIST, { recursive: true })
      for (const v of VARIANTS) makeTarball(v, join(DIST, `${v.dir}.tar.gz`))
    } else if (MODE === 'all') {
      buildInstallable()
      mkdirSync(DIST, { recursive: true })
      for (const v of VARIANTS) makeTarball(v, join(DIST, `${v.dir}.tar.gz`))
    } else {
      console.error(`unknown mode: ${MODE}`)
      process.exit(2)
    }
  } catch (err) {
    console.error(`_pack-core: ${err?.message ?? String(err)}`)
    process.exit(1)
  }
}
