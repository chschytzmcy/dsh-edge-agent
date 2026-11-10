// scripts/verify-bundle-mounted.mjs
// Diagnostic report — lists which DSH profiles currently mount the
// dsh-edge-agent bundle.
//
// 2026-09-03 (post-feedback): the original "must be in web only"
// enforcement was overreach (the bundle is profile-agnostic). This has
// always been an informational report that NEVER fails; it just reports
// status. Useful for debugging "did install.sh actually wire the bundle
// into the right profile?" after deployment.
//
// 2026-10-21: ported from scripts/verify-bundle-mounted.sh to Node.
//
// Why the port was necessary (§7.102 cross-platform cleanup):
//
//   - The bash version ran `bash scripts/verify-bundle-mounted.sh` inside
//     `npm run verify:build`. On a default Windows + Git-for-Windows box
//     bash.exe is NOT on PATH (`C:\Program Files\Git\bin` is not added to
//     PATH by the installer) → the gate aborted the whole build chain with
//     "'bash' is not recognized as an internal or external command".
//   - Even with bash on PATH, the script misreported. It derived its paths
//     from `$HOME`, which PowerShell/cmd hand over in Windows form
//     (`C:\Users\<user>\`). GNU find treats the backslashes as escapes, so
//     the profile scan found nothing and the report said "bundle is not
//     mounted in any profile" while it plainly was.
//   - This Node port resolves the profile directory with node:fs, so the
//     result is identical on Windows, macOS and Linux.
//
// Run: node scripts/verify-bundle-mounted.mjs

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const BUNDLE = '@dsh-edge/dsh-edge-agent'
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const PROFILES_DIR = join(DSH_HOME, 'profiles')

const line = '═'.repeat(63)

console.log('')
console.log(line)
console.log('  bundle-mount report')
console.log(`  target: ${BUNDLE}`)
console.log(`  dsh-home: ${DSH_HOME}`)
console.log(line)

// ── 1. Skip cleanly if no DSH install ──────────────────────────────────────
if (!existsSync(PROFILES_DIR)) {
  console.log(`ℹ️  no DSH install at ${PROFILES_DIR} — nothing to report`)
  process.exit(0)
}

// ── 2. Walk the profile directories ────────────────────────────────────────
let profileDirs = []
try {
  profileDirs = readdirSync(PROFILES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(PROFILES_DIR, entry.name))
    .sort()
} catch {
  profileDirs = []
}

if (profileDirs.length === 0) {
  console.log(`ℹ️  no profiles in ${PROFILES_DIR} — nothing to report`)
  process.exit(0)
}

/** Does this profile's package.json list the bundle under dsh.profile.bundles? */
function bundlesOf(pkgJson) {
  try {
    const parsed = JSON.parse(readFileSync(pkgJson, 'utf8'))
    return (parsed.dsh?.profile?.bundles) ?? []
  } catch {
    return null
  }
}

const mountedIn = []

for (const profileDir of profileDirs) {
  const pkgJson = join(profileDir, 'package.json')
  if (!existsSync(pkgJson)) continue

  const profileName = profileDir.split(/[\\/]/u).pop() ?? profileDir
  const bundles = bundlesOf(pkgJson)

  if (bundles === null) {
    console.log(`  ⚠️  unreadable package.json: ${profileName}`)
    continue
  }
  if (bundles.includes(BUNDLE)) {
    mountedIn.push(profileName)
    console.log(`  ✅ mounted in: ${profileName}`)
  }
}

// ── 3. Report ──────────────────────────────────────────────────────────────
console.log('')
if (mountedIn.length === 0) {
  console.log('⚠️  bundle is not mounted in any profile')
  console.log('       fix: ./install.sh --skip-pnpm    # installs into default PROFILE=dsh-tui')
  console.log('             ./install.sh --to-profile <name> --skip-pnpm   # into a specific profile')
} else {
  console.log(`✅ bundle mounted in profile(s): ${mountedIn.join(' ')}`)
  console.log('       (profile-agnostic: web / tui / any profile may host this bundle)')
}
console.log(line)

// Informational report — never fails the build.
process.exit(0)
