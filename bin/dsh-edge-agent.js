#!/usr/bin/env node
/**
 * dsh-edge-agent — one-shot launcher for the dsh-edge-agent bundle's
 * default standalone install (headless profile, :21017).
 *
 * Note: `dsh-edge-agent` is the bundle name (npm package
 * @deepseek-harness-edge-agent/dsh-edge-agent). The default profile
 * container is also named `dsh-edge-agent` for historical reasons
 * (install.sh:36 default). They are not the same thing — see PROGRESS
 * §7.25 + §7.25.x for the bundle-vs-profile invariant.
 *
 * After a global `npm install -g @deepseek-harness-edge-agent/dsh-edge-agent`,
 * this script gives you the `dsh-edge-agent` command so you don't have to
 * type `dsh --profile dsh-edge-agent` by hand:
 *
 *   1. Probe `dsh` (official DSH CLI). If missing, prompt to install it.
 *   2. Probe $DSH_HOME/profiles/dsh-edge-agent — if absent, bootstrap by
 *      running `dsh plugin --profile dsh-edge-agent add <PACKAGE>@<self-version>`.
 *      This auto-creates the profile and pulls in DSH base + every transitive
 *      dependency, including the @deepseek-ai/dsh-invariants peer.
 *   3. If installed version disagrees with the launcher (issue #183): refuse
 *      to boot when the profile is older (reverse skew — patch surface drift
 *      can crash at module resolution), warn when the profile is newer.
 *   4. Intercept `--resume` / `-c` / `--continue`: read the last session id
 *      from ~/.dsh-edge-agent/resume.txt and feed it through
 *      DSH_EDGE_RESUME_SESSION. The flag itself is NOT forwarded.
 *   5. Forward everything else to `dsh --profile dsh-edge-agent`.
 *
 * Bilingual message table (zh default, en via DSH_EDGE_LANG=en). Same contract
 * the in-app i18n uses; this script can't reuse src/i18n.ts because it runs
 * before the DSH app tree is alive.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const ownPkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
const ownVersion = ownPkg.version
const PACKAGE = ownPkg.name
const PROFILE = 'dsh-edge-agent'

// --- bilingual message table --------------------------------------------------
const lang = process.env.DSH_EDGE_LANG === 'en' ? 'en' : 'zh'
const MSG = {
  noDsh: {
    en: `[dsh-edge-agent] dsh CLI not found. Install the official client first:\n  npm install -g @deepseek-ai/dsh`,
    zh: `[dsh-edge-agent] 未检测到 dsh CLI。请先安装官方客户端：\n  npm install -g @deepseek-ai/dsh`,
  },
  noPnpm: {
    en: `[dsh-edge-agent] First-time setup needs pnpm (dsh plugin delegates installs to it):\n  npm install -g pnpm   (or via corepack: corepack enable pnpm)`,
    zh: `[dsh-edge-agent] 首次安装需要 pnpm（dsh plugin 会把安装转发给它）：\n  npm install -g pnpm   （或启用 corepack：corepack enable pnpm）`,
  },
  bootstrapStart: {
    en: `[dsh-edge-agent] First run — initializing the ${PROFILE} profile (${PACKAGE}@${ownVersion})…`,
    zh: `[dsh-edge-agent] 首次运行，正在初始化 ${PROFILE} profile（${PACKAGE}@${ownVersion}）…`,
  },
  installFailed: {
    en: `[dsh-edge-agent] Plugin install failed. Retry manually later:\n  dsh plugin --profile ${PROFILE} add ${PACKAGE}@${ownVersion}`,
    zh: `[dsh-edge-agent] 插件安装失败。可稍后手工重试：\n  dsh plugin --profile ${PROFILE} add ${PACKAGE}@${ownVersion}`,
  },
  versionMismatch: {
    en: (installed, own) =>
      `[dsh-edge-agent] note: profile runs v${installed} but launcher is v${own}.\n` +
      `  To update: dsh plugin --profile ${PROFILE} add ${PACKAGE}@latest`,
    zh: (installed, own) =>
      `[dsh-edge-agent] 提示：profile 内运行的是 v${installed}，而启动器是 v${own}。\n` +
      `  更新 profile：dsh plugin --profile ${PROFILE} add ${PACKAGE}@latest`,
  },
  // Reverse skew (issue #183): launcher newer than profile means the patch
  // surface references subpaths the older package doesn't export — boot
  // crashes opaquely (ERR_PACKAGE_PATH_NOT_EXPORTED) before any plugin code
  // runs. Fail loud with the fix instead.
  profileOlderThanLauncher: {
    en: (installed, own) =>
      `[dsh-edge-agent] cannot start: profile runs v${installed} but launcher is v${own}.\n` +
      `  Align the profile with the launcher:\n` +
      `  dsh plugin --profile ${PROFILE} add ${PACKAGE}@${own}`,
    zh: (installed, own) =>
      `[dsh-edge-agent] 无法启动：profile 内运行的是 v${installed}，而启动器是 v${own}。\n` +
      `  启动器的 patch 套到旧版 profile上时会缺子路径导出——启动会以模块解析错误崩溃。\n` +
      `  请让 profile 与启动器对齐：\n` +
      `  dsh plugin --profile ${PROFILE} add ${PACKAGE}@${own}`,
  },
  launchFailed: {
    en: (err) => `[dsh-edge-agent] Failed to launch: ${err.message}`,
    zh: (err) => `[dsh-edge-agent] 启动失败：${err.message}`,
  },
  profileExited: {
    en: (code) => `[dsh-edge-agent] dsh profile exited with code ${code}. Run it directly for diagnostics:\n  dsh --profile ${PROFILE}`,
    zh: (code) => `[dsh-edge-agent] dsh profile 已退出（退出码 ${code}）。可直接运行以下命令查看诊断：\n  dsh --profile ${PROFILE}`,
  },
}
const msg = (key, ...args) => MSG[key][lang](...args)

// --- 1. dsh CLI precheck ------------------------------------------------------
const probe = spawnSync('dsh', ['--version'], { stdio: 'pipe' })
if (probe.error || probe.status !== 0) {
  console.error(msg('noDsh'))
  process.exit(1)
}

// --- 2. profile bootstrap & version check -------------------------------------
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const profileDir = join(dshHome, 'profiles', PROFILE)
// Use the installed package.json's readability as the success criterion
// (a partial install shouldn't silently start).
let installedVersion
try {
  installedVersion = JSON.parse(
    readFileSync(join(profileDir, 'node_modules', PACKAGE, 'package.json'), 'utf8'),
  ).version
} catch {
  installedVersion = undefined
}

if (installedVersion === undefined) {
  const pnpmProbe = spawnSync('pnpm', ['--version'], { stdio: 'pipe' })
  if (pnpmProbe.error || pnpmProbe.status !== 0) {
    console.error(msg('noPnpm'))
    process.exit(1)
  }
  console.log(msg('bootstrapStart'))
  const add = spawnSync(
    'dsh',
    ['plugin', '--profile', PROFILE, 'add', `${PACKAGE}@${ownVersion}`],
    { stdio: ['inherit', 'inherit', 'inherit'] },
  )
  if (add.status !== 0) {
    console.error(msg('installFailed'))
    process.exit(add.status ?? 1)
  }
} else if (installedVersion !== ownVersion) {
  // Reverse skew is fatal; compare major+minor only (patch never moves the
  // patch surface).
  const majorMinor = (v) => v.split('-')[0].split('.').slice(0, 2).map(Number)
  const [iM, im] = majorMinor(installedVersion)
  const [oM, om] = majorMinor(ownVersion)
  if (iM < oM || (iM === oM && im < om)) {
    console.error(msg('profileOlderThanLauncher', installedVersion, ownVersion))
    process.exit(1)
  }
  console.error(msg('versionMismatch', installedVersion, ownVersion))
}

// --- 3. --resume interception -------------------------------------------------
const setResumeEnv = (sessionId) => {
  process.env.DSH_EDGE_RESUME_SESSION = sessionId
}
const readLastResumeTarget = () => {
  for (const dir of ['.dsh-edge-agent', '.dsh-cc']) {
    try {
      const sessionId = readFileSync(join(homedir(), dir, 'resume.txt'), 'utf8').trim()
      if (sessionId) return sessionId
    } catch {
      // no history to resume — silent skip.
    }
  }
  return ''
}
const args = []
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--resume' || a === '-c' || a === '--continue' || a.startsWith('--resume=')) {
    let sessionId = ''
    if (a.startsWith('--resume=')) {
      sessionId = a.slice('--resume='.length).trim()
    } else if (a === '--resume' && argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) {
      sessionId = argv[++i].trim()
    }
    if (!sessionId) sessionId = readLastResumeTarget()
    if (sessionId) setResumeEnv(sessionId)
  } else {
    args.push(a)
  }
}

// --- 4. launch ----------------------------------------------------------------
const child = spawn('dsh', ['--profile', PROFILE, ...args], {
  stdio: 'inherit',
  env: process.env,
})
child.on('error', (err) => {
  console.error(msg('launchFailed', err))
  process.exit(1)
})
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
  } else {
    if (code !== null && code !== 0) console.error(msg('profileExited', code))
    process.exit(code ?? 0)
  }
})