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
CONTEXT_THRESHOLD=80   # trigger /compact when context % exceeds this

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

# ── Step 1b: Check context window usage ──────────────────────────────────────
CTX_PCT=""
if tmux has-session -t "$SESSION" 2>/dev/null; then
    CTX_PCT=$(tmux capture-pane -t "$SESSION" -p 2>/dev/null \
        | grep -oE '[0-9]+% / [0-9]+(k|m)' \
        | head -1 \
        | grep -oE '^[0-9]+')
fi

if [[ -n "$CTX_PCT" ]] && [[ "$CTX_PCT" -gt "$CONTEXT_THRESHOLD" ]] 2>/dev/null; then
    log "Context window at ${CTX_PCT}% (threshold: ${CONTEXT_THRESHOLD}%). Sending /compact."
    tmux send-keys -t "$SESSION" "/compact" Enter
    # Wait up to 60s for context % to drop below threshold
    COMPACTED=false
    for (( _=1; _<=12; _++ )); do
        sleep 5
        NEW_PCT=$(tmux capture-pane -t "$SESSION" -p 2>/dev/null \
            | grep -oE '[0-9]+% / [0-9]+(k|m)' \
            | head -1 \
            | grep -oE '^[0-9]+')
        if [[ -n "$NEW_PCT" ]] && [[ "$NEW_PCT" -lt "$CTX_PCT" ]]; then
            COMPACTED=true
            break
        fi
    done
    if [[ "$COMPACTED" == true ]]; then
        log "Compact completed — context now ${NEW_PCT}%."
        "$NOTIFY" "♻️ Bot context compacted (was ${CTX_PCT}%, now ${NEW_PCT}%)" || true
    else
        log "Compact did not reduce context within 60s — forcing restart."
        tmux kill-session -t "$SESSION" 2>/dev/null || true
        "$NOTIFY" "⚠️ Bot restarted — /compact failed to clear context (was ${CTX_PCT}% full)" || true
    fi
    exit 0
fi

# ── Step 2: Check for bun child (Telegram plugin) ────────────────────────────
check_healthy() {
    pgrep -P "$CLAUDE_PID" bun > /dev/null 2>&1
}

if check_healthy; then
    # Healthy — nothing to do.
    log "HEALTHY (context: ${CTX_PCT:-unknown}%)"
    exit 0
fi

# ── Step 3: Grace period — re-check after 5s to avoid acting on transient state
sleep 5

if check_healthy; then
    # Transient blip — back to healthy.
    log "HEALTHY (recovered from transient)"
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
