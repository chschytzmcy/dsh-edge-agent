# Skills (canonical source)

This directory holds the canonical source for project-local Claude Code skills.
The runtime entry point `.claude/skills/<name>/SKILL.md` is gitignored (per
project policy: `.claude/` excludes everything except settings we explicitly
track elsewhere) — Claude Code picks it up via a symlink created by humans.

## Layout

| Path | Status | Purpose |
|---|---|---|
| `docs/skills/<name>.md` | **git-tracked** | canonical source — edit here |
| `.claude/skills/<name>/SKILL.md` | gitignored, local symlink → `../../../docs/skills/<name>.md` | Claude Code skill loader reads this |

## Setup for new clones

After cloning the repo, create the symlink so Claude Code can find each skill:

```bash
cd .claude/skills/deploy-dsh-edge-agent
ln -sf ../../../docs/skills/deploy-dsh-edge-agent.md SKILL.md
```

(One symlink per skill. Claude Code's skill loader resolves symlinks
transparently; the path under `.claude/skills/<name>/SKILL.md` is the only
contract the loader cares about.)

## Editing workflow

1. Edit `docs/skills/<name>.md` (canonical)
2. Commit `docs/skills/<name>.md` to git
3. Local symlink picks up changes immediately — no re-link step

If you ever need to verify the symlink resolved correctly:

```bash
readlink -f .claude/skills/<name>/SKILL.md
# expect: /abs/path/to/repo/docs/skills/<name>.md
diff .claude/skills/<name>/SKILL.md docs/skills/<name>.md
# expect: no diff
```

## Why this split

- `docs/skills/` is shared / version-controlled / reviewable
- `.claude/` stays local-only (settings.local.json with ANTHROPIC_AUTH_TOKEN,
  conversation caches, etc.) per project gitignore policy
- Skills contain no secrets, so they live in `docs/` with the rest of the
  user-facing documentation