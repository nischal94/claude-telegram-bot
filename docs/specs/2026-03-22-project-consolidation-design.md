# Project Consolidation — Design Spec

**Date:** 2026-03-22
**Status:** Approved

---

## Problem

The Claude Telegram bot infrastructure is scattered across three locations with no single source of truth:

- `~/.claude/experiments/telegram-prompt-opt/` — deploy scripts, prompts, docs (a repo originally created for prompt optimization, not bot infrastructure)
- `~/bin/` — runtime scripts (`claude-bot-start.sh`, `claude-bot-watchdog.sh`, `claude-bot-notify.sh`), untracked by any git repo
- `~/Library/LaunchAgents/` — launchd plists, untracked

This makes it hard to understand, maintain, or share the bot setup.

---

## Solution

Create `~/projects/claude-telegram-bot/` as a proper standalone git repo. Move all bot-related files into it. Symlink `~/bin/` → project `bin/` so launchd PATH resolution continues to work without changing the plists. Leave `claude-autotune` and `.claude/.env` untouched.

---

## New Project Structure

```
~/projects/claude-telegram-bot/
├── bin/
│   ├── start.sh          (was ~/bin/claude-bot-start.sh)
│   ├── watchdog.sh       (was ~/bin/claude-bot-watchdog.sh)
│   └── notify.sh         (was ~/bin/claude-bot-notify.sh)
├── deploy/
│   └── launch_bot.sh     (was telegram-prompt-opt/deploy/launch_bot.sh)
├── prompts/
│   ├── current.txt       ← gitignored (personal system prompt)
│   └── system-prompt.example.txt  ← committed template with placeholders
├── launchd/
│   ├── com.nischal.claudebot.plist          ← reference copy
│   └── com.nischal.claudebot-watchdog.plist ← reference copy
├── docs/
│   └── (plans + specs from telegram-prompt-opt/docs/superpowers/)
├── .gitignore
└── README.md
```

---

## Components

### 1. `~/projects/claude-telegram-bot/` (new git repo)
Initialised with `git init`. All bot files committed. Pushed to GitHub as `nischal94/claude-telegram-bot`.

### 2. `bin/` scripts
Three scripts moved from `~/bin/` into `bin/`. Renamed to drop the `claude-bot-` prefix (redundant inside the project):
- `claude-bot-start.sh` → `bin/start.sh`
- `claude-bot-watchdog.sh` → `bin/watchdog.sh`
- `claude-bot-notify.sh` → `bin/notify.sh`

**Path updates required:**
- `start.sh`: `EXPERIMENT_DIR` updated from `$HOME/.claude/experiments/telegram-prompt-opt` to `$HOME/projects/claude-telegram-bot`
- `watchdog.sh`: no path changes needed (references only `SESSION`, `LOG_FILE`, `NOTIFY` — none point to telegram-prompt-opt)
- `notify.sh`: no path changes needed (reads from `~/.claude/.env` which stays in place)

**Verification before restart:** After updating paths, run `bash -n bin/start.sh && echo ok` and manually check `EXPERIMENT_DIR` points to the new location.

### 3. `~/bin/` symlinks
After moving, create symlinks using **absolute paths** so launchd (which calls `~/bin/claude-bot-start.sh`) still works without plist changes:
```bash
ln -s /Users/nischal/projects/claude-telegram-bot/bin/start.sh    ~/bin/claude-bot-start.sh
ln -s /Users/nischal/projects/claude-telegram-bot/bin/watchdog.sh ~/bin/claude-bot-watchdog.sh
ln -s /Users/nischal/projects/claude-telegram-bot/bin/notify.sh   ~/bin/claude-bot-notify.sh
```

### 4. `prompts/`
- `current.txt` — moved from `telegram-prompt-opt/prompts/current.txt`. Gitignored. This is the live system prompt read by `deploy/launch_bot.sh`.
- `system-prompt.example.txt` — new file, template version of `current.txt` with `<YOUR_NAME>` and `<YOUR_CONTEXT>` placeholders. Committed. Setup instruction: `cp prompts/system-prompt.example.txt prompts/current.txt` then edit to personalise.

**Note:** `~/.claude/.env` is NOT moving — it stays at `~/.claude/.env`. `notify.sh` already reads from there. No `.env` file belongs inside the project.

### 5. `launchd/`
Reference copies of both plists for documentation and reinstallation. The live copies stay in `~/Library/LaunchAgents/` — launchd requires them there.

### 6. `docs/`
Plans and specs moved from `telegram-prompt-opt/docs/superpowers/` into `docs/`. The `.md` files contain references to `telegram-prompt-opt` in path examples — these are historical implementation notes, not runtime paths, so they do not need updating (they document where files used to be, which is useful context).

### 7. `.gitignore`
```
prompts/current.txt
prompts/*.txt
!prompts/system-prompt.example.txt
*.env
.env*
*.log
__pycache__/
*.pyc
```

### 8. `README.md`
New README explaining: what the project is, directory structure, setup instructions (clone → create `prompts/current.txt` from example → populate `.env` → run `launchctl load`).

---

## What Changes

| Item | Change |
|------|--------|
| `~/bin/claude-bot-start.sh` | Replaced by symlink → `bin/start.sh` |
| `~/bin/claude-bot-watchdog.sh` | Replaced by symlink → `bin/watchdog.sh` |
| `~/bin/claude-bot-notify.sh` | Replaced by symlink → `bin/notify.sh` |
| `start.sh` `EXPERIMENT_DIR` | Updated to `$HOME/projects/claude-telegram-bot` |
| `telegram-prompt-opt/deploy/launch_bot.sh` | Moved to `deploy/launch_bot.sh` |
| `telegram-prompt-opt/prompts/current.txt` | Moved to `prompts/current.txt` (gitignored) |
| `telegram-prompt-opt/docs/superpowers/` | Moved to `docs/` |
| `~/Library/LaunchAgents/*.plist` | Unchanged (live copies stay) |
| `claude-autotune` repo | Untouched |
| `~/.claude/.env` | Untouched |

---

## Migration Safety

- The bot must remain running throughout. Migration steps:
  1. Create project, copy all files, commit
  2. Update `EXPERIMENT_DIR` in `start.sh`
  3. Verify syntax: `bash -n ~/projects/claude-telegram-bot/bin/start.sh`
  4. Replace `~/bin/` real files with symlinks (atomic: `rm` then `ln -s`)
  5. Test manually: `bash ~/bin/claude-bot-start.sh` in foreground briefly to catch any path errors before handing back to launchd
  6. Restart via launchd: `launchctl kickstart -k gui/$(id -u)/com.nischal.claudebot`
  7. Verify bot is running with bun child present
  8. Only then remove old `deploy/` and `prompts/` from `telegram-prompt-opt`

- No launchd plist changes needed — symlinks preserve the old paths.

- No launchd plist changes needed — symlinks make the old paths work.

---

## Out of Scope

- Migrating `claude-autotune` prompt optimization scripts
- Changing launchd plist paths
- Modifying `~/.claude/.env`
