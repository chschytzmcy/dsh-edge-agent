#!/usr/bin/env bash
# scripts/verify-bundle-mounted-in-web.sh
# Diagnostic report — lists which DSH profiles currently mount the
# dsh-edge-agent bundle. Bundle is profile-agnostic (web / tui / any
# custom profile may host it), so this script NEVER fails: it just
# reports status. Useful for debugging "did install.sh actually wire
# the bundle into the right profile?" after deployment.
#
# 2026-09-03 (post-feedback): original "must be in web only" enforcement
# was overreach (bundle is profile-agnostic). Removed FAIL-on-non-web
# branch; renamed semantically to "verify-bundle-mounted" report.
#
# Run: bash scripts/verify-bundle-mounted-in-web.sh

set -uo pipefail

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
BUNDLE="@deepseek-harness-edge-agent/dsh-edge-agent"
PROFILES_DIR="$DSH_HOME/profiles"

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  bundle-mount report"
echo "  target: $BUNDLE"
echo "  dsh-home: $DSH_HOME"
echo "═══════════════════════════════════════════════════════════════"

# ── 1. Skip cleanly if no DSH install ──────────────────────────────────────
if [ ! -d "$PROFILES_DIR" ]; then
  echo "ℹ️  no DSH install at $PROFILES_DIR — nothing to report"
  exit 0
fi

PROFILES=$(find "$PROFILES_DIR" -maxdepth 2 -name 'package.json' -print 2>/dev/null \
  | xargs -n1 dirname 2>/dev/null | sort -u)
if [ -z "$PROFILES" ]; then
  echo "ℹ️  no profiles in $PROFILES_DIR — nothing to report"
  exit 0
fi

# ── 2. Walk profiles; for each, ask node whether dsh.profile.bundles ──────
#    contains the bundle.
MOUNTED_IN=""

for profile_dir in $PROFILES; do
  profile_name="$(basename "$profile_dir")"
  pkg_json="$profile_dir/package.json"
  [ -f "$pkg_json" ] || continue

  has_bundle=$(node -e '
    const fs = require("fs");
    const path = process.argv[1];
    const target = process.argv[2];
    try {
      const d = JSON.parse(fs.readFileSync(path, "utf8"));
      const bundles = (d.dsh && d.dsh.profile && d.dsh.profile.bundles) || [];
      process.stdout.write(bundles.includes(target) ? "yes" : "no");
    } catch (_) {
      process.stdout.write("error");
    }
  ' "$pkg_json" "$BUNDLE" 2>/dev/null || echo "error")

  if [ "$has_bundle" = "yes" ]; then
    MOUNTED_IN="$MOUNTED_IN $profile_name"
    echo "  ✅ mounted in: $profile_name"
  fi
done

# ── 3. Report ─────────────────────────────────────────────────────────────
echo ""
if [ -z "$MOUNTED_IN" ]; then
  echo "⚠️  bundle is not mounted in any profile"
  echo "       fix: ./install.sh --skip-pnpm    # installs into default PROFILE=dsh-tui"
  echo "             ./install.sh --to-profile <name> --skip-pnpm   # into a specific profile"
else
  echo "✅ bundle mounted in profile(s):$MOUNTED_IN"
  echo "       (profile-agnostic: web / tui / any profile may host this bundle)"
fi
echo "═══════════════════════════════════════════════════════════════"
exit 0
