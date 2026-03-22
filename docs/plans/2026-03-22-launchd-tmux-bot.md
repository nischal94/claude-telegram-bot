# launchd-managed tmux Claude Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace manual tmux bot startup with a launchd service that automatically starts, supervises, and restarts the Claude Telegram bot on login.

**Architecture:** launchd runs a wrapper script (`~/bin/claude-bot-start.sh`) that kills any stale tmux session then creates a fresh one running `deploy/launch_bot.sh`. The wrapper blocks until the tmux session exits, so when the bot crashes launchd restarts the wrapper (and thus the bot) automatically. This guarantees single-instance operation and removes the need for the fragile `pgrep` duplicate-killer.

**Tech Stack:** macOS launchd (plist), tmux, bash, claude CLI (`/Users/nischal/.local/bin/claude`)

---

### Task 1: Create `~/bin` and the wrapper script

**Files:**
- Create: `~/bin/claude-bot-start.sh`

- [ ] **Step 1: Create `~/bin` directory**

```bash
mkdir -p ~/bin
```

- [ ] **Step 2: Write `~/bin/claude-bot-start.sh`**

```bash
#!/usr/bin/env bash
# Wrapper script called by launchd.
# Kills any stale "claude-bot" tmux session, creates a fresh one,
# then blocks until the session exits so launchd can track liveness.
set -euo pipefail

EXPERIMENT_DIR="$HOME/.claude/experiments/telegram-prompt-opt"
SESSION="claude-bot"
LOG_DIR="$HOME/.claude/logs"

mkdir -p "$LOG_DIR"

# Kill stale session if it exists (prevents duplicate pollers on restart).
tmux kill-session -t "$SESSION" 2>/dev/null || true

# Give tmux a moment to clean up.
sleep 1

# Start a new detached session running the launch script.
tmux new-session -d -s "$SESSION" \
    -e "PATH=/Users/nischal/.local/bin:/Users/nischal/.npm-global/bin:/Users/nischal/.bun/bin:/usr/local/bin:/usr/bin:/bin" \
    "bash '$EXPERIMENT_DIR/deploy/launch_bot.sh' 2>&1 | tee -a '$LOG_DIR/claudebot.log'"

# Block here until the session exits.
# When the bot crashes/exits, this returns and launchd will restart us.
while tmux has-session -t "$SESSION" 2>/dev/null; do
    sleep 2
done
```

- [ ] **Step 3: Make it executable**

```bash
chmod +x ~/bin/claude-bot-start.sh
```

- [ ] **Step 4: Verify the script is syntactically valid**

```bash
bash -n ~/bin/claude-bot-start.sh && echo "syntax ok"
```
Expected: `syntax ok`

- [ ] **Step 5: Commit**

```bash
git -C ~/.claude/experiments/telegram-prompt-opt add docs/
git -C ~/.claude/experiments/telegram-prompt-opt commit -m "docs: add launchd-tmux bot implementation plan"
```

---

### Task 2: Simplify `deploy/launch_bot.sh`

Remove the fragile `pgrep` duplicate-killer and the 3-second countdown — launchd + wrapper already guarantee single instance, and no human watches the launch.

**Files:**
- Modify: `~/.claude/experiments/telegram-prompt-opt/deploy/launch_bot.sh`

- [ ] **Step 1: Read current file**

```bash
cat ~/.claude/experiments/telegram-prompt-opt/deploy/launch_bot.sh
```

- [ ] **Step 2: Remove the pgrep block and sleep 3**

Replace the section between the `PROMPT_VERSION=` line and the `exec claude` line with just:

```bash
echo "[deploy] Launching bot with prompt: $PROMPT_VERSION"
echo "[deploy] Preview (first 120 chars): ${SYSTEM_PROMPT:0:120}..."
```

So the full file becomes:

```bash
#!/usr/bin/env bash
# Launch the Telegram bot with the current optimized system prompt.

set -euo pipefail

EXPERIMENT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROMPT_FILE="$EXPERIMENT_DIR/prompts/current.txt"

if [ ! -f "$PROMPT_FILE" ]; then
    echo "[deploy] ERROR: $PROMPT_FILE not found. Run the experiment first." >&2
    exit 1
fi

SYSTEM_PROMPT=$(cat "$PROMPT_FILE")
PROMPT_VERSION=$(readlink "$EXPERIMENT_DIR/prompts/current.txt" 2>/dev/null || echo "unknown")

echo "[deploy] Launching bot with prompt: $PROMPT_VERSION"
echo "[deploy] Preview (first 120 chars): ${SYSTEM_PROMPT:0:120}..."

exec claude \
    --append-system-prompt "$SYSTEM_PROMPT" \
    --channels plugin:telegram@claude-plugins-official
```

- [ ] **Step 3: Verify syntax**

```bash
bash -n ~/.claude/experiments/telegram-prompt-opt/deploy/launch_bot.sh && echo "syntax ok"
```
Expected: `syntax ok`

- [ ] **Step 4: Commit**

```bash
git -C ~/.claude/experiments/telegram-prompt-opt add deploy/launch_bot.sh
git -C ~/.claude/experiments/telegram-prompt-opt commit -m "refactor(deploy): remove pgrep duplicate-killer and countdown — launchd handles this"
```

---

### Task 3: Create the launchd plist

**Files:**
- Create: `~/Library/LaunchAgents/com.nischal.claudebot.plist`

- [ ] **Step 1: Write the plist**

```bash
cat > ~/Library/LaunchAgents/com.nischal.claudebot.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nischal.claudebot</string>

    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>/Users/nischal/bin/claude-bot-start.sh</string>
    </array>

    <!-- Environment — launchd does NOT inherit your shell env -->
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/Users/nischal/.local/bin:/Users/nischal/.npm-global/bin:/Users/nischal/.bun/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>/Users/nischal</string>
        <key>ANTHROPIC_API_KEY</key>
        <string>REPLACE_WITH_YOUR_KEY</string>
    </dict>

    <!-- Start on login -->
    <key>RunAtLoad</key>
    <true/>

    <!-- Restart on exit -->
    <key>KeepAlive</key>
    <true/>

    <!-- Wait 10s between restarts to prevent crash loops -->
    <key>ThrottleInterval</key>
    <integer>10</integer>

    <!-- Logs -->
    <key>StandardOutPath</key>
    <string>/Users/nischal/.claude/logs/claudebot-launchd.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/nischal/.claude/logs/claudebot-launchd.log</string>
</dict>
</plist>
EOF
```

- [ ] **Step 2: Insert the real ANTHROPIC_API_KEY**

Read the key from `~/.zshrc` and substitute it:

```bash
KEY=$(grep 'ANTHROPIC_API_KEY=' ~/.zshrc | head -1 | sed 's/.*ANTHROPIC_API_KEY=//' | tr -d '"' | tr -d "'")
sed -i '' "s|REPLACE_WITH_YOUR_KEY|$KEY|" ~/Library/LaunchAgents/com.nischal.claudebot.plist
```

- [ ] **Step 2b: Verify the key was actually substituted**

```bash
grep -q 'REPLACE_WITH_YOUR_KEY' ~/Library/LaunchAgents/com.nischal.claudebot.plist \
    && echo "ERROR: key not substituted — edit the plist manually" \
    || echo "key substituted ok"
```
Expected: `key substituted ok`
If you see the error, open the plist and manually replace `REPLACE_WITH_YOUR_KEY` with your `ANTHROPIC_API_KEY` value.

- [ ] **Step 3: Validate the plist**

```bash
plutil -lint ~/Library/LaunchAgents/com.nischal.claudebot.plist && echo "plist ok"
```
Expected: `com.nischal.claudebot.plist: OK` then `plist ok`

- [ ] **Step 4: Create the log directory**

```bash
mkdir -p ~/.claude/logs
```

---

### Task 4: Load and verify the launchd service

- [ ] **Step 1: Load the service**

```bash
launchctl load ~/Library/LaunchAgents/com.nischal.claudebot.plist
```

- [ ] **Step 2: Verify it started**

```bash
launchctl list | grep com.nischal.claudebot
```
Expected: a line like `97XXX  0  com.nischal.claudebot` (PID in first column, 0 exit code in second)

- [ ] **Step 3: Verify the tmux session was created**

```bash
sleep 5 && tmux list-sessions
```
Expected: `claude-bot: 1 windows (created ...)`

- [ ] **Step 4: Verify the bot is polling**

```bash
sleep 5 && tmux capture-pane -t claude-bot -p | tail -5
```
Expected: output containing `Listening for channel messages from: plugin:telegram`

- [ ] **Step 5: Tail the log**

```bash
tail -20 ~/.claude/logs/claudebot.log
```
Expected: launch script output and `telegram channel: polling as @<botname>`

- [ ] **Step 6: Send a test message on Telegram and verify it appears in the tmux pane**

```bash
tmux capture-pane -t claude-bot -p -S -50
```
Expected: `← telegram · <username>: <your test message>`

---

### Task 5: Verify restart behavior

- [ ] **Step 1: Kill the tmux session to simulate a crash**

```bash
tmux kill-session -t claude-bot
```

- [ ] **Step 2: Wait for launchd to restart it**

```bash
sleep 15 && tmux list-sessions
```
Expected: `claude-bot` session exists again

- [ ] **Step 3: Verify bot is running in the new session**

```bash
tmux capture-pane -t claude-bot -p | tail -5
```
Expected: polling message again

---

## Useful Commands Reference

```bash
# Attach to the bot session
tmux attach -t claude-bot

# Tail combined logs
tail -f ~/.claude/logs/claudebot.log

# Restart bot (e.g. after prompt change)
launchctl kickstart -k gui/$(id -u)/com.nischal.claudebot

# Stop bot permanently
launchctl unload ~/Library/LaunchAgents/com.nischal.claudebot.plist

# Re-enable bot
launchctl load ~/Library/LaunchAgents/com.nischal.claudebot.plist

# Check launchd status
launchctl list | grep com.nischal.claudebot
```
