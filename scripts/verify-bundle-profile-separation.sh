#!/usr/bin/env bash
# scripts/verify-bundle-profile-separation.sh
# Architecture invariant (§7.25 + §7.25.x): the string `dsh-edge-agent`
# MUST only appear as npm-package-name / cordis-plugin-id context.
# It MUST NOT appear as profile-container-name context (PROFILE= default,
# hardcoded ~/.dsh/profiles/dsh-edge-agent path, "dsh-edge-agent profile"
# wording).
#
# Enforcement levels:
#   - Hard-fail: any new occurrence in code/config that looks like a
#     profile-container reference.
#   - Allow-listed: PROGRESS.md §7.25 / §7.25.x canonical mentions,
#     SKILL.md §10 terminology table, README install examples, package
#     metadata (name / bin), test fixture constants, channel-path
#     references (DSH_EDGE_*_ROOT).
#
# Exit non-zero on any violation. Wire into CI via `npm run verify:build`.

set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

FAIL=0

# ── 0. Self-exclusion: grep pattern + echo literals in this script ──
# Accept both `./scripts/...` and `scripts/...` forms (grep uses ./ from cwd).
SELF_PATTERN='^(\./)?scripts/verify-bundle-profile-separation\.sh:'

# ── 1. PROFILE default value = 'dsh-edge-agent' (hardcoded, not env-override) ──
# Allowed (legacy 列表 — 引用 install.sh:36 的默认值；远端 / 测试脚本依赖该默认值):
#   - install.sh:36
#   - bin/dsh-edge-agent.js:36
#   - scripts/dev-restart.sh:11-12
#   - deploy.sh:157（远端部署，依赖 install.sh 默认值）
#   - scripts/e2e-*.sh, scripts/m5-*.sh（测试脚本，引用默认值）
PROFILE_HITS=$(grep -rnE --binary-files=without-match \
  'PROFILE=.*dsh-edge-agent|PROFILE=.*:-dsh-edge-agent' \
  --include='*.sh' --include='*.js' --include='*.ts' \
  --exclude-dir=node_modules --exclude-dir=lib --exclude-dir=dist \
  --exclude-dir=.claude \
  . 2>/dev/null | grep -vE "$SELF_PATTERN" || true)
PROFILE_HITS_FILTERED=$(echo "$PROFILE_HITS" \
  | grep -vE '^(\./)?install\.sh:' \
  | grep -vE '^(\./)?bin/dsh-edge-agent\.js:' \
  | grep -vE '^(\./)?scripts/dev-restart\.sh:' \
  | grep -vE '^(\./)?deploy\.sh:15[0-9]:' \
  | grep -vE '^(\./)?scripts/(e2e|m5)-' || true)
if [ -n "$PROFILE_HITS_FILTERED" ]; then
  echo "❌ FAIL [P1]: PROFILE=.*dsh-edge-agent 在代码里硬编码（legacy 豁免点：install.sh:36 + bin/dsh-edge-agent.js:36 + dev-restart.sh:11-12 + deploy.sh:157 + scripts/e2e-*.sh + scripts/m5-*.sh）："
  echo "$PROFILE_HITS_FILTERED"
  FAIL=1
else
  echo "✅ PASS [P1]: 没有新增 PROFILE=dsh-edge-agent 硬编码"
fi

# ── 2. 'dsh-edge-agent profile' 字面（误把 bundle 当 profile 描述） ──
# Allowed:
#   - PROGRESS.md 整段（design doc 性质，所有讨论都是 bundle vs profile 元话语）
#   - SKILL.md §10 术语表（canonical terminology）
#   - README.md 安装说明
#   - memory/entrypoints.md 顶部澄清段
#   - verify script 自身
WORDING_HITS=$(grep -rnE --binary-files=without-match \
  'dsh-edge-agent profile' \
  --include='*.md' --include='*.ts' --include='*.sh' --include='*.js' \
  --exclude-dir=node_modules --exclude-dir=lib --exclude-dir=dist \
  --exclude-dir=.claude \
  . 2>/dev/null | grep -vE "$SELF_PATTERN" || true)
WORDING_HITS_FILTERED=$(echo "$WORDING_HITS" \
  | grep -vE 'docs/PROGRESS\.md:' \
  | grep -vE '\.claude/skills/deploy-dsh-edge-agent/SKILL\.md:' \
  | grep -vE '^(\./)?README\.md:' \
  | grep -vE 'memory/entrypoints\.md:' || true)
if [ -n "$WORDING_HITS_FILTERED" ]; then
  echo "❌ FAIL [P2]: 'dsh-edge-agent profile' 字面（仅 PROGRESS.md + SKILL §10 + README + memory + 本脚本豁免）："
  echo "$WORDING_HITS_FILTERED"
  FAIL=1
else
  echo "✅ PASS [P2]: 没有新增 'dsh-edge-agent profile' 字面"
fi

# ── 3. Hardcoded ~/.dsh/profiles/dsh-edge-agent 路径（非注释行） ──
# Allowed: 注释行豁免（讨论 bundle vs profile 必然要引用路径）；verify script 自身豁免。
PATH_HITS=$(grep -rnE --binary-files=without-match \
  '~?/?\.dsh/profiles/dsh-edge-agent' \
  --include='*.sh' --include='*.js' --include='*.ts' \
  --exclude-dir=node_modules --exclude-dir=lib --exclude-dir=dist \
  . 2>/dev/null | grep -vE "$SELF_PATTERN" || true)
# Filter comment-only lines (line starts with # or // after :line: prefix)
# AND env-overridable defaults (e.g. ${VAR:-$HOME/.dsh/profiles/dsh-edge-agent})
# — these mirror install.sh:36 PROFILE="${DSH_EDGE_PROFILE:-dsh-edge-agent}"
# (env-overridable default, not a hardcoded literal).
PATH_HITS_FILTERED=$(echo "$PATH_HITS" \
  | grep -vE ':[[:space:]]*#' \
  | grep -vE ':[[:space:]]*//' \
  | grep -vE ':-[^"]*\.dsh/profiles/dsh-edge-agent' \
  | grep -vE ':-[^"]*/\.dsh/profiles/dsh-edge-agent' || true)
if [ -n "$PATH_HITS_FILTERED" ]; then
  echo "❌ FAIL [P3]: hardcoded ~/.dsh/profiles/dsh-edge-agent 路径（非注释）："
  echo "$PATH_HITS_FILTERED"
  FAIL=1
else
  echo "✅ PASS [P3]: 没有新增 hardcoded ~/.dsh/profiles/dsh-edge-agent"
fi

# ── Summary ──
if [ $FAIL -ne 0 ]; then
  echo ""
  echo "═══════════════════════════════════════════════════════════════"
  echo "❌ verify-bundle-profile-separation FAILED"
  echo "   dsh-edge-agent 字符串被误用为 profile 容器名（违背 §7.25 + §7.25.x invariant）"
  echo "   修复: 用 '默认 headless profile 容器' 或 'dsh-edge-agent bundle' 替代"
  echo "═══════════════════════════════════════════════════════════════"
  exit 1
fi

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "✅ verify-bundle-profile-separation PASSED"
echo "   dsh-edge-agent 字符串用法符合 §7.25 + §7.25.x invariant"
echo "═══════════════════════════════════════════════════════════════"
exit 0
