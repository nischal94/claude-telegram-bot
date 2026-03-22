# Telegram Plugin Watchdog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a watchdog that detects when the Telegram plugin subprocess dies inside the running bot, kills the tmux session to trigger a launchd restart, and sends a Telegram notification.

**Architecture:** A new launchd plist runs `~/bin/claude-bot-watchdog.sh` every ~30s. The script finds the `claude --channels plugin:telegram` process, checks for a `bun` child (the Telegram plugin), and kills the tmux session if the plugin is confirmed dead after a 5s grace period. A shared `~/bin/claude-bot-notify.sh` helper sends Bot API notifications. `claude-bot-start.sh` also calls the notifier on startup.

**Tech Stack:** bash, macOS launchd, tmux, `pgrep`, `curl` (Telegram Bot API)

---

### Task 1: Add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` to `~/.claude/.env`

**Files:**
- Modify: `~/.claude/.env`

- [ ] **Step 1: Check what's currently in the file**

```bash
cat ~/.claude/.env
```

- [ ] **Step 2: Add the two new variables**

Append to `~/.claude/.env` (do NOT overwrite — the file already contains `ANTHROPIC_API_KEY`):

```bash
TELEGRAM_BOT_TOKEN=<paste-your-bot-token-here>
TELEGRAM_CHAT_ID=<paste-your-numeric-chat-id-here>
```

To find your chat ID: in Telegram, message your bot, then open:
`https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
The `"id"` field under `"chat"` is your chat ID.

- [ ] **Step 3: Verify both variables are present**

```bash
grep -E "TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID" ~/.claude/.env
```
Expected: two lines, one for each variable, with values filled in (not placeholder text).

---

### Task 2: Create `~/bin/claude-bot-notify.sh`

**Files:**
- Create: `~/bin/claude-bot-notify.sh`

- [ ] **Step 1: Write the script**

```bash
cat > ~/bin/claude-bot-notify.sh << 'EOF'
#!/usr/bin/env bash
# Send a Telegram message via Bot API.
# Usage: claude-bot-notify.sh "message text"
# Reads TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID from ~/.claude/.env
# Always exits 0 — notification failure must never block callers.
set -uo pipefail

MSG="${1:-}"
if [[ -z "$MSG" ]]; then
    echo "[claude-bot-notify] no message provided" >&2
    exit 0
fi

ENV_FILE="$HOME/.claude/.env"
if [[ ! -f "$ENV_FILE" ]]; then
    echo "[claude-bot-notify] .env not found: $ENV_FILE" >&2
    exit 0
fi

set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a

if [[ -z "${TELEGRAM_BOT_TOKEN:-}" || -z "${TELEGRAM_CHAT_ID:-}" ]]; then
    echo "[claude-bot-notify] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set" >&2
    exit 0
fi

curl -s --max-time 10 -X POST \
    "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT_ID}" \
    -d "text=${MSG}" \
    > /dev/null 2>&1 || true

exit 0
EOF
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x ~/bin/claude-bot-notify.sh
```

- [ ] **Step 3: Verify syntax**

```bash
bash -n ~/bin/claude-bot-notify.sh && echo "syntax ok"
```
Expected: `syntax ok`

- [ ] **Step 4: Test it manually**

```bash
~/bin/claude-bot-notify.sh "🧪 watchdog notify test"
```
Expected: no errors; you should receive the message in Telegram within a few seconds.

- [ ] **Step 5: Commit**

```bash
git -C ~/.claude/experiments/telegram-prompt-opt add -A
git -C ~/.claude/experiments/telegram-prompt-opt commit -m "feat(watchdog): add claude-bot-notify.sh shared Telegram notifier"
```

---

### Task 3: Create `~/bin/claude-bot-watchdog.sh`

**Files:**
- Create: `~/bin/claude-bot-watchdog.sh`

- [ ] **Step 1: Write the script**

```bash
cat > ~/bin/claude-bot-watchdog.sh << 'EOF'
#!/usr/bin/env bash
# Watchdog for the Claude Telegram bot.
# Detects when the Telegram plugin (bun child process) has died inside a
# still-running claude process, and kills the tmux session to trigger a
# launchd restart.
set -uo pipefail

SESSION="claude-bot"
LOG_FILE="$HOME/.claude/logs/claudebot-watchdog.log"
NOTIFY="$HOME/bin/claude-bot-notify.sh"

mkdir -p "$(dirname "$LOG_FILE")"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [watchdog] $*" | tee -a "$LOG_FILE"
}

# ── Step 1: Find the bot's claude PID ────────────────────────────────────────
mapfile -t PIDS < <(pgrep -f "claude.*--channels plugin:telegram" 2>/dev/null || true)

if [[ ${#PIDS[@]} -eq 0 ]]; then
    # Bot not running — launchd will handle it.
    exit 0
fi

if [[ ${#PIDS[@]} -gt 1 ]]; then
    log "WARNING: multiple claude --channels processes found (${PIDS[*]}); skipping"
    exit 0
fi

CLAUDE_PID="${PIDS[0]}"

# ── Step 2: Check for bun child (Telegram plugin) ────────────────────────────
check_healthy() {
    pgrep -P "$CLAUDE_PID" bun > /dev/null 2>&1
}

if check_healthy; then
    # Healthy — nothing to do.
    exit 0
fi

# ── Step 3: Grace period — re-check after 5s to avoid acting on transient state
sleep 5

if check_healthy; then
    # Transient blip — back to healthy.
    exit 0
fi

# ── Step 4: Plugin confirmed dead — act ──────────────────────────────────────
log "Telegram plugin dead (no bun child of PID $CLAUDE_PID). Restarting bot."
tmux kill-session -t "$SESSION" 2>/dev/null || true

# ── Step 5: Poll for recovery (claude process + bun child both present) ──────
RECOVERED=false
for i in $(seq 1 12); do
    sleep 5
    mapfile -t NEW_PIDS < <(pgrep -f "claude.*--channels plugin:telegram" 2>/dev/null || true)
    if [[ ${#NEW_PIDS[@]} -eq 1 ]]; then
        NEW_PID="${NEW_PIDS[0]}"
        if pgrep -P "$NEW_PID" bun > /dev/null 2>&1; then
            RECOVERED=true
            break
        fi
    fi
done

# ── Step 6: Notify ───────────────────────────────────────────────────────────
if [[ "$RECOVERED" == true ]]; then
    log "Bot recovered successfully."
    "$NOTIFY" "⚠️ Bot restarted — Telegram plugin had died" || true
    exit 0
else
    log "ERROR: Bot did not recover within 60s — manual intervention needed."
    "$NOTIFY" "❌ Bot failed to recover after plugin death — manual intervention needed" || true
    exit 1
fi
EOF
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x ~/bin/claude-bot-watchdog.sh
```

- [ ] **Step 3: Verify syntax**

```bash
bash -n ~/bin/claude-bot-watchdog.sh && echo "syntax ok"
```
Expected: `syntax ok`

- [ ] **Step 4: Test healthy path — run watchdog while bot is running normally**

```bash
~/bin/claude-bot-watchdog.sh; echo "exit: $?"
```
Expected: no output, `exit: 0` (bot is healthy, bun child exists).

If the bot isn't currently running, expected output is also `exit: 0` (zero PIDs path).

- [ ] **Step 5: Commit**

```bash
git -C ~/.claude/experiments/telegram-prompt-opt add -A
git -C ~/.claude/experiments/telegram-prompt-opt commit -m "feat(watchdog): add claude-bot-watchdog.sh plugin health checker"
```

---

### Task 4: Create the watchdog launchd plist

**Files:**
- Create: `~/Library/LaunchAgents/com.nischal.claudebot-watchdog.plist`

- [ ] **Step 1: Write the plist**

```bash
cat > ~/Library/LaunchAgents/com.nischal.claudebot-watchdog.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nischal.claudebot-watchdog</string>

    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>/Users/nischal/bin/claude-bot-watchdog.sh</string>
    </array>

    <!-- ~/bin must be first so claude-bot-notify.sh is found -->
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/Users/nischal/bin:/Users/nischal/.local/bin:/Users/nischal/.npm-global/bin:/Users/nischal/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>/Users/nischal</string>
    </dict>

    <!-- Run approximately every 30s (waits for job to exit before counting) -->
    <key>StartInterval</key>
    <integer>30</integer>

    <!-- Logs -->
    <key>StandardOutPath</key>
    <string>/Users/nischal/.claude/logs/claudebot-watchdog-launchd.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/nischal/.claude/logs/claudebot-watchdog-launchd.log</string>
</dict>
</plist>
EOF
```

- [ ] **Step 2: Validate the plist**

```bash
plutil -lint ~/Library/LaunchAgents/com.nischal.claudebot-watchdog.plist && echo "plist ok"
```
Expected: `com.nischal.claudebot-watchdog.plist: OK` then `plist ok`

- [ ] **Step 3: Load the watchdog service**

```bash
launchctl load ~/Library/LaunchAgents/com.nischal.claudebot-watchdog.plist
```

- [ ] **Step 4: Verify it loaded**

```bash
launchctl list | grep claudebot-watchdog
```
Expected: a line like `-  0  com.nischal.claudebot-watchdog` (dash in PID column means it ran and exited; 0 = clean exit)

- [ ] **Step 5: Check the launchd log after ~35s**

```bash
sleep 35 && cat ~/.claude/logs/claudebot-watchdog-launchd.log
```
Expected: no output (healthy bot produces no log lines — the script exits 0 silently).

- [ ] **Step 6: Commit**

```bash
git -C ~/.claude/experiments/telegram-prompt-opt add -A
git -C ~/.claude/experiments/telegram-prompt-opt commit -m "feat(watchdog): add launchd plist for 30s watchdog interval"
```

---

### Task 5: Modify `~/bin/claude-bot-start.sh` to send startup notification

**Files:**
- Modify: `~/bin/claude-bot-start.sh` (lines 50-56)

- [ ] **Step 1: Read the current file to confirm line numbers**

```bash
cat -n ~/bin/claude-bot-start.sh
```

- [ ] **Step 2: Add the startup notification after the pipe-pane line (line 50)**

The file currently looks like:
```bash
# Pipe tmux pane output to log file (non-blocking, doesn't affect PTY).
tmux pipe-pane -t "$SESSION" -o "cat >> '$LOG_DIR/claudebot.log'"

# Block here until the session exits.
```

Replace with:
```bash
# Pipe tmux pane output to log file (non-blocking, doesn't affect PTY).
tmux pipe-pane -t "$SESSION" -o "cat >> '$LOG_DIR/claudebot.log'"

# Notify that the bot session has been launched.
"$HOME/bin/claude-bot-notify.sh" "✅ Bot started" || true

# Block here until the session exits.
```

- [ ] **Step 3: Verify syntax**

```bash
bash -n ~/bin/claude-bot-start.sh && echo "syntax ok"
```
Expected: `syntax ok`

- [ ] **Step 4: Commit**

```bash
git -C ~/.claude/experiments/telegram-prompt-opt add -A
git -C ~/.claude/experiments/telegram-prompt-opt commit -m "feat(watchdog): send startup notification from claude-bot-start.sh"
```

---

### Task 6: End-to-end test — simulate plugin death and verify recovery

- [ ] **Step 1: Confirm the bot is currently running and healthy**

```bash
pgrep -f "claude.*--channels plugin:telegram" && echo "claude running"
pgrep -P "$(pgrep -f 'claude.*--channels plugin:telegram')" bun && echo "bun child present"
```
Expected: both lines print a PID and their label.

- [ ] **Step 2: Kill only the bun child (simulate plugin death without killing claude)**

```bash
kill $(pgrep -P "$(pgrep -f 'claude.*--channels plugin:telegram')" bun)
```

- [ ] **Step 3: Confirm claude is still alive but bun is gone**

```bash
pgrep -f "claude.*--channels plugin:telegram" && echo "claude still alive"
pgrep -P "$(pgrep -f 'claude.*--channels plugin:telegram')" bun 2>/dev/null && echo "bun still there" || echo "bun gone — plugin dead"
```
Expected: `claude still alive` and `bun gone — plugin dead`

- [ ] **Step 4: Run the watchdog manually and watch it act**

```bash
~/bin/claude-bot-watchdog.sh; echo "watchdog exit: $?"
```
Expected: the watchdog logs the event, kills the tmux session, waits for recovery, sends a notification. You should see "⚠️ Bot restarted" in Telegram. Exit code 0.

- [ ] **Step 5: Verify bot recovered**

```bash
tmux list-sessions
pgrep -f "claude.*--channels plugin:telegram" && echo "claude running"
pgrep -P "$(pgrep -f 'claude.*--channels plugin:telegram')" bun && echo "bun child present"
```
Expected: `claude-bot` session exists, claude and bun are both running.

- [ ] **Step 6: Check the watchdog log**

```bash
cat ~/.claude/logs/claudebot-watchdog.log
```
Expected: timestamped lines recording the detection and recovery.

- [ ] **Step 7: Verify the automatic watchdog also runs cleanly now**

```bash
sleep 35 && launchctl list | grep claudebot-watchdog
```
Expected: `- 0 com.nischal.claudebot-watchdog` (clean exit, no output in launchd log since bot is healthy)

---

## Useful Commands Reference

```bash
# Check both services
launchctl list | grep claudebot

# Tail watchdog log
tail -f ~/.claude/logs/claudebot-watchdog.log

# Run watchdog manually (for debugging)
~/bin/claude-bot-watchdog.sh

# Test notifier manually
~/bin/claude-bot-notify.sh "test message"

# Unload watchdog (e.g. to edit plist)
launchctl unload ~/Library/LaunchAgents/com.nischal.claudebot-watchdog.plist

# Reload watchdog after edits
launchctl unload ~/Library/LaunchAgents/com.nischal.claudebot-watchdog.plist
launchctl load ~/Library/LaunchAgents/com.nischal.claudebot-watchdog.plist
```
