# Project Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all Claude Telegram bot files from their scattered locations into a single `~/projects/claude-telegram-bot/` git repo and push it to GitHub.

**Architecture:** Create the new repo, copy files in, update the one hardcoded path in `start.sh`, create `~/bin/` symlinks so launchd continues to work without plist changes, restart the bot to verify, then clean up the old locations.

**Tech Stack:** bash, git, macOS launchd, GitHub (`gh` CLI)

---

## File Map

| Source | Destination | Action |
|--------|-------------|--------|
| `~/bin/claude-bot-start.sh` | `bin/start.sh` | Copy → symlink back |
| `~/bin/claude-bot-watchdog.sh` | `bin/watchdog.sh` | Copy → symlink back |
| `~/bin/claude-bot-notify.sh` | `bin/notify.sh` | Copy → symlink back |
| `telegram-prompt-opt/deploy/launch_bot.sh` | `deploy/launch_bot.sh` | Copy (leave original for now) |
| `telegram-prompt-opt/prompts/current.txt` | `prompts/current.txt` | Copy (gitignored) |
| `telegram-prompt-opt/docs/superpowers/plans/` | `docs/plans/` | Copy |
| `telegram-prompt-opt/docs/superpowers/specs/` | `docs/specs/` |  Copy |
| `~/Library/LaunchAgents/com.nischal.claudebot.plist` | `launchd/com.nischal.claudebot.plist` | Copy (reference only) |
| `~/Library/LaunchAgents/com.nischal.claudebot-watchdog.plist` | `launchd/com.nischal.claudebot-watchdog.plist` | Copy (reference only) |

New files created: `.gitignore`, `README.md`, `prompts/system-prompt.example.txt`

---

### Task 1: Initialise the git repo and create `.gitignore`

**Files:**
- Working dir: `~/projects/claude-telegram-bot/` (already exists as empty dir)
- Create: `~/projects/claude-telegram-bot/.gitignore`

- [ ] **Step 1: Initialise git**

```bash
git -C ~/projects/claude-telegram-bot init
```
Expected: `Initialized empty Git repository in /Users/nischal/projects/claude-telegram-bot/.git/`

- [ ] **Step 2: Write `.gitignore`**

```bash
cat > ~/projects/claude-telegram-bot/.gitignore << 'EOF'
# Personal system prompt — never commit
prompts/current.txt
prompts/*.txt
!prompts/system-prompt.example.txt

# Secrets
*.env
.env*

# Logs
*.log

# Python
__pycache__/
*.pyc
EOF
```

- [ ] **Step 3: Verify**

```bash
cat ~/projects/claude-telegram-bot/.gitignore
```
Expected: file shows the 4 sections above.

- [ ] **Step 4: Commit**

```bash
git -C ~/projects/claude-telegram-bot add .gitignore
git -C ~/projects/claude-telegram-bot commit -m "chore: initialise repo with .gitignore"
```

---

### Task 2: Copy and commit `bin/` scripts

**Files:**
- Create: `~/projects/claude-telegram-bot/bin/start.sh`
- Create: `~/projects/claude-telegram-bot/bin/watchdog.sh`
- Create: `~/projects/claude-telegram-bot/bin/notify.sh`

- [ ] **Step 1: Create `bin/` and copy scripts**

```bash
mkdir -p ~/projects/claude-telegram-bot/bin
cp ~/bin/claude-bot-start.sh    ~/projects/claude-telegram-bot/bin/start.sh
cp ~/bin/claude-bot-watchdog.sh ~/projects/claude-telegram-bot/bin/watchdog.sh
cp ~/bin/claude-bot-notify.sh   ~/projects/claude-telegram-bot/bin/notify.sh
```

- [ ] **Step 2: Preserve executable permissions**

```bash
chmod +x ~/projects/claude-telegram-bot/bin/start.sh
chmod +x ~/projects/claude-telegram-bot/bin/watchdog.sh
chmod +x ~/projects/claude-telegram-bot/bin/notify.sh
```

- [ ] **Step 3: Update `EXPERIMENT_DIR` in `start.sh`**

Open `~/projects/claude-telegram-bot/bin/start.sh` and change line:
```bash
EXPERIMENT_DIR="$HOME/.claude/experiments/telegram-prompt-opt"
```
To:
```bash
EXPERIMENT_DIR="$HOME/projects/claude-telegram-bot"
```

- [ ] **Step 4: Verify the path change**

```bash
grep "EXPERIMENT_DIR" ~/projects/claude-telegram-bot/bin/start.sh
```
Expected: `EXPERIMENT_DIR="$HOME/projects/claude-telegram-bot"`

- [ ] **Step 5: Verify syntax on all three scripts**

```bash
bash -n ~/projects/claude-telegram-bot/bin/start.sh && echo "start.sh ok"
bash -n ~/projects/claude-telegram-bot/bin/watchdog.sh && echo "watchdog.sh ok"
bash -n ~/projects/claude-telegram-bot/bin/notify.sh && echo "notify.sh ok"
```
Expected: three `ok` lines.

- [ ] **Step 6: Commit**

```bash
git -C ~/projects/claude-telegram-bot add bin/
git -C ~/projects/claude-telegram-bot commit -m "feat: add bin/ scripts (start, watchdog, notify)"
```

---

### Task 3: Copy `deploy/`, `prompts/`, `launchd/`, `docs/`

**Files:**
- Create: `~/projects/claude-telegram-bot/deploy/launch_bot.sh`
- Create: `~/projects/claude-telegram-bot/prompts/current.txt` (gitignored)
- Create: `~/projects/claude-telegram-bot/prompts/system-prompt.example.txt`
- Create: `~/projects/claude-telegram-bot/launchd/com.nischal.claudebot.plist`
- Create: `~/projects/claude-telegram-bot/launchd/com.nischal.claudebot-watchdog.plist`
- Create: `~/projects/claude-telegram-bot/docs/` (plans + specs)

- [ ] **Step 1: Copy `deploy/`**

```bash
mkdir -p ~/projects/claude-telegram-bot/deploy
cp ~/.claude/experiments/telegram-prompt-opt/deploy/launch_bot.sh \
   ~/projects/claude-telegram-bot/deploy/launch_bot.sh
chmod +x ~/projects/claude-telegram-bot/deploy/launch_bot.sh
```

- [ ] **Step 2: Copy `prompts/`**

```bash
mkdir -p ~/projects/claude-telegram-bot/prompts
cp ~/.claude/experiments/telegram-prompt-opt/prompts/current.txt \
   ~/projects/claude-telegram-bot/prompts/current.txt
```

- [ ] **Step 3: Create `system-prompt.example.txt`**

```bash
cat > ~/projects/claude-telegram-bot/prompts/system-prompt.example.txt << 'EOF'
You are a personal AI assistant accessible via Telegram. The user is <YOUR_NAME>, your owner.

## Your Context
- You run inside Claude Code with full tool access (calendar, filesystem, web, etc.)
- Messages arrive from Telegram. Everything <YOUR_NAME> sees must go through the reply tool.
- You have no persistent memory between sessions.

## Behavior Rules

**1. Calendar queries — future only**
Only show events from today onward. Never show past events.

**2. Brevity — Telegram is mobile**
Short paragraphs or bullets. No walls of text.

**3. Tool transparency**
Say one brief status line before presenting results ("checking your calendar…", "searching now…").

**4. Memory honesty**
You have no cross-session memory. Never claim to have saved a preference — no tool was called, nothing was stored.

## Tone
Direct, capable, low-fluff. Trusted tool, not a chatty assistant.
EOF
```

- [ ] **Step 4: Copy `launchd/` reference plists**

```bash
mkdir -p ~/projects/claude-telegram-bot/launchd
cp ~/Library/LaunchAgents/com.nischal.claudebot.plist \
   ~/projects/claude-telegram-bot/launchd/com.nischal.claudebot.plist
cp ~/Library/LaunchAgents/com.nischal.claudebot-watchdog.plist \
   ~/projects/claude-telegram-bot/launchd/com.nischal.claudebot-watchdog.plist
```

- [ ] **Step 5: Copy `docs/`**

```bash
mkdir -p ~/projects/claude-telegram-bot/docs/plans \
         ~/projects/claude-telegram-bot/docs/specs
cp ~/.claude/experiments/telegram-prompt-opt/docs/superpowers/plans/*.md \
   ~/projects/claude-telegram-bot/docs/plans/
cp ~/.claude/experiments/telegram-prompt-opt/docs/superpowers/specs/*.md \
   ~/projects/claude-telegram-bot/docs/specs/
```

- [ ] **Step 6: Verify `current.txt` is gitignored**

```bash
git -C ~/projects/claude-telegram-bot status
```
Expected: `prompts/current.txt` does NOT appear in untracked files. `system-prompt.example.txt` DOES appear.

- [ ] **Step 7: Commit everything except `current.txt`**

```bash
git -C ~/projects/claude-telegram-bot add deploy/ prompts/system-prompt.example.txt launchd/ docs/
git -C ~/projects/claude-telegram-bot commit -m "feat: add deploy, prompts example, launchd reference plists, docs"
```

---

### Task 4: Write `README.md`

**Files:**
- Create: `~/projects/claude-telegram-bot/README.md`

- [ ] **Step 1: Write the README**

```bash
cat > ~/projects/claude-telegram-bot/README.md << 'EOF'
# claude-telegram-bot

A personal AI assistant running via Telegram, powered by Claude Code with full tool access (calendar, web search, filesystem).

## What it does

- Receives messages from Telegram and replies via the Telegram Bot API
- Runs as a persistent launchd service — starts on login, auto-restarts on failure
- A watchdog monitors the Telegram plugin subprocess and restarts the bot if it dies silently

## Project structure

```
bin/
  start.sh       — launchd wrapper: starts tmux session, blocks until exit
  watchdog.sh    — checks for dead Telegram plugin every ~30s, triggers restart
  notify.sh      — sends Telegram notifications via Bot API (used by watchdog + start)
deploy/
  launch_bot.sh  — launches claude with the system prompt and Telegram channel plugin
prompts/
  current.txt          — your live system prompt (gitignored, personal)
  system-prompt.example.txt — template to get started
launchd/
  com.nischal.claudebot.plist          — reference copy of the bot launchd service
  com.nischal.claudebot-watchdog.plist — reference copy of the watchdog launchd service
docs/
  plans/  — implementation plans
  specs/  — design specs
```

## Setup

### Prerequisites
- macOS with launchd
- [Claude Code](https://claude.ai/code) installed (`claude` on PATH)
- Telegram bot token (from [@BotFather](https://t.me/BotFather))
- Anthropic API key

### 1. Clone and configure

```bash
git clone https://github.com/nischal94/claude-telegram-bot.git ~/projects/claude-telegram-bot
```

### 2. Create your system prompt

```bash
cp prompts/system-prompt.example.txt prompts/current.txt
# Edit prompts/current.txt to personalise
```

### 3. Set up secrets

Add to `~/.claude/.env` (create if it doesn't exist):

```
ANTHROPIC_API_KEY=sk-ant-...
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_CHAT_ID=your-numeric-chat-id
```

To find your chat ID: message your bot, then visit:
`https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`

### 4. Install scripts to `~/bin/`

```bash
mkdir -p ~/bin
ln -s ~/projects/claude-telegram-bot/bin/start.sh    ~/bin/claude-bot-start.sh
ln -s ~/projects/claude-telegram-bot/bin/watchdog.sh ~/bin/claude-bot-watchdog.sh
ln -s ~/projects/claude-telegram-bot/bin/notify.sh   ~/bin/claude-bot-notify.sh
```

### 5. Install and load launchd services

```bash
cp launchd/com.nischal.claudebot.plist          ~/Library/LaunchAgents/
cp launchd/com.nischal.claudebot-watchdog.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.nischal.claudebot.plist
launchctl load ~/Library/LaunchAgents/com.nischal.claudebot-watchdog.plist
```

### 6. Verify

```bash
# Check both services are running
launchctl list | grep claudebot

# Check the bot session
tmux attach -t claude-bot
```

## Useful commands

```bash
# Restart bot (e.g. after prompt change)
launchctl kickstart -k gui/$(id -u)/com.nischal.claudebot

# Tail logs
tail -f ~/.claude/logs/claudebot.log
tail -f ~/.claude/logs/claudebot-watchdog.log

# Run watchdog manually
~/bin/claude-bot-watchdog.sh

# Stop everything
launchctl unload ~/Library/LaunchAgents/com.nischal.claudebot.plist
launchctl unload ~/Library/LaunchAgents/com.nischal.claudebot-watchdog.plist
```
EOF
```

- [ ] **Step 2: Commit**

```bash
git -C ~/projects/claude-telegram-bot add README.md
git -C ~/projects/claude-telegram-bot commit -m "docs: add README with setup instructions"
```

---

### Task 5: Replace `~/bin/` scripts with symlinks and restart bot

**This is the live migration step. Do it carefully in order.**

- [ ] **Step 1: Verify the new `start.sh` looks correct before switching**

```bash
grep "EXPERIMENT_DIR\|PROMPT_FILE" ~/projects/claude-telegram-bot/bin/start.sh ~/projects/claude-telegram-bot/deploy/launch_bot.sh
```
Expected:
- `start.sh`: `EXPERIMENT_DIR="$HOME/projects/claude-telegram-bot"`
- `launch_bot.sh`: `PROMPT_FILE="$EXPERIMENT_DIR/prompts/current.txt"` (uses the variable, not hardcoded)

- [ ] **Step 2: Verify `prompts/current.txt` exists in new location**

```bash
ls -la ~/projects/claude-telegram-bot/prompts/current.txt
```
Expected: file exists and is non-empty.

- [ ] **Step 3: Replace `~/bin/` real files with symlinks**

```bash
rm ~/bin/claude-bot-start.sh
ln -s /Users/nischal/projects/claude-telegram-bot/bin/start.sh ~/bin/claude-bot-start.sh

rm ~/bin/claude-bot-watchdog.sh
ln -s /Users/nischal/projects/claude-telegram-bot/bin/watchdog.sh ~/bin/claude-bot-watchdog.sh

rm ~/bin/claude-bot-notify.sh
ln -s /Users/nischal/projects/claude-telegram-bot/bin/notify.sh ~/bin/claude-bot-notify.sh
```

- [ ] **Step 4: Verify symlinks are correct**

```bash
ls -la ~/bin/claude-bot-*.sh
```
Expected: each shows `-> /Users/nischal/projects/claude-telegram-bot/bin/...`

- [ ] **Step 5: Restart bot via launchd**

```bash
launchctl kickstart -k gui/$(id -u)/com.nischal.claudebot
```

- [ ] **Step 6: Wait and verify bot recovered**

```bash
sleep 15 && tmux list-sessions
pgrep -f "claude.*--channels plugin:telegram" && echo "claude running"
pgrep -P "$(pgrep -f 'claude.*--channels plugin:telegram')" bun && echo "bun child present"
```
Expected: `claude-bot` session exists, both process checks pass.

- [ ] **Step 7: Send a test message to the bot on Telegram**

Expected: bot responds normally.

---

### Task 6: Push to GitHub and clean up old locations

- [ ] **Step 1: Create GitHub repo**

```bash
gh repo create nischal94/claude-telegram-bot --public --description "Personal AI assistant via Telegram, powered by Claude Code" --source ~/projects/claude-telegram-bot --push
```
Expected: repo created and pushed at `https://github.com/nischal94/claude-telegram-bot`

- [ ] **Step 2: Verify repo on GitHub**

```bash
gh repo view nischal94/claude-telegram-bot
```
Expected: shows repo with correct description.

- [ ] **Step 3: Remove `deploy/` and `prompts/` from `telegram-prompt-opt`**

These are now canonical in the new repo. Remove from the old location:

```bash
git -C ~/.claude/experiments/telegram-prompt-opt rm -r deploy/ prompts/
git -C ~/.claude/experiments/telegram-prompt-opt commit -m "chore: remove deploy/ and prompts/ — moved to claude-telegram-bot repo"
```

- [ ] **Step 4: Verify bot still running after cleanup**

```bash
pgrep -f "claude.*--channels plugin:telegram" && echo "still running"
```
Expected: process still alive (deploy/ removal doesn't affect the running bot).

- [ ] **Step 5: Final status check**

```bash
launchctl list | grep claudebot
tmux list-sessions
cat ~/.claude/logs/claudebot-watchdog.log | tail -5
```
Expected: both launchd services showing clean exits, `claude-bot` tmux session exists, watchdog log shows no errors.
