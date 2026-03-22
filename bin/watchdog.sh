#!/usr/bin/env bash
# Watchdog for the Claude Telegram bot.
# Detects when the Telegram plugin (bun child process) has died inside a
# still-running claude process, and kills the tmux session to trigger a
# launchd restart.
set -uo pipefail

SESSION="claude-bot"
LOG_FILE="$HOME/.claude/logs/claudebot-watchdog.log"
NOTIFY="$HOME/bin/claude-bot-notify.sh"
RECOVERY_INTERVAL=5
RECOVERY_ATTEMPTS=12

mkdir -p "$(dirname "$LOG_FILE")"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [watchdog] $*" | tee -a "$LOG_FILE"
}

if [[ ! -x "$NOTIFY" ]]; then
    log "WARNING: notifier not found or not executable: $NOTIFY — notifications will be skipped"
fi

# ── Step 1: Find the bot's claude PID ────────────────────────────────────────
PIDS=()
while IFS= read -r pid; do
    [[ -n "$pid" ]] && PIDS+=("$pid")
done < <(pgrep -f "claude.*--channels plugin:telegram" 2>/dev/null || true)

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
for (( _=1; _<=RECOVERY_ATTEMPTS; _++ )); do
    sleep "$RECOVERY_INTERVAL"
    NEW_PIDS=()
    while IFS= read -r pid; do
        [[ -n "$pid" ]] && NEW_PIDS+=("$pid")
    done < <(pgrep -f "claude.*--channels plugin:telegram" 2>/dev/null || true)
    if [[ ${#NEW_PIDS[@]} -ge 1 ]]; then
        NEW_PID="${NEW_PIDS[${#NEW_PIDS[@]}-1]}"  # use the last one (bash 3.2 safe)
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
    log "ERROR: Bot did not recover within $((RECOVERY_ATTEMPTS * RECOVERY_INTERVAL))s — manual intervention needed."
    "$NOTIFY" "❌ Bot failed to recover after plugin death — manual intervention needed" || true
    exit 1
fi
