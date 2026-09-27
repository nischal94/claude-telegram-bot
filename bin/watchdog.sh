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

# Stamp file used to suppress repeated OAuth-expiry alerts. The bot will sit
# silently in this state until a human runs /login, and we don't want a tick-
# every-30s notification storm. One alert per expiry event is enough.
OAUTH_ALERT_STAMP="$HOME/.claude/logs/.claudebot-oauth-alert-sent"

# Same idea for the folder-trust prompt: claude waits for a human to answer it,
# so restarting only brings the prompt back.
TRUST_ALERT_STAMP="$HOME/.claude/logs/.claudebot-trust-alert-sent"

# Consecutive restarts without a HEALTHY check in between. After MAX_RESTARTS
# the watchdog stops restarting and alerts once, so an unknown failure costs a
# handful of messages instead of one every 40s.
RESTART_COUNT_FILE="$HOME/.claude/logs/.claudebot-restart-count"
GIVE_UP_STAMP="$HOME/.claude/logs/.claudebot-give-up-alert-sent"
MAX_RESTARTS=5

mkdir -p "$(dirname "$LOG_FILE")"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [watchdog] $*" | tee -a "$LOG_FILE"
}

if [[ ! -x "$NOTIFY" ]]; then
    log "WARNING: notifier not found or not executable: $NOTIFY — notifications will be skipped"
fi

# Counts one more restart and returns 0 if the cap allows it. Otherwise alerts
# once and returns 1. Sets RESTART_COUNT for the caller's log line.
claim_restart() {
    local count
    count=$(cat "$RESTART_COUNT_FILE" 2>/dev/null || echo 0)
    [[ "$count" =~ ^[0-9]+$ ]] || count=0
    if [[ "$count" -ge "$MAX_RESTARTS" ]]; then
        if [[ ! -f "$GIVE_UP_STAMP" ]]; then
            log "ERROR: $count restarts without a healthy check — stopped restarting."
            "$NOTIFY" "🛑 Bot stopped restarting after $count failed attempts. Check: tmux attach -t $SESSION" || true
            touch "$GIVE_UP_STAMP"
        fi
        return 1
    fi
    RESTART_COUNT=$((count + 1))
    echo "$RESTART_COUNT" > "$RESTART_COUNT_FILE"
    return 0
}

mark_healthy() {
    rm -f "$RESTART_COUNT_FILE" "$GIVE_UP_STAMP" "$TRUST_ALERT_STAMP"
}

# ── Step 1: Find the bot's claude PID ────────────────────────────────────────
PIDS=()
while IFS= read -r pid; do
    [[ -n "$pid" ]] && PIDS+=("$pid")
done < <(pgrep -f "claude.*--channels plugin:telegram" 2>/dev/null || true)

if [[ ${#PIDS[@]} -eq 0 ]]; then
    # No claude --channels process. If the tmux session is still alive, the
    # wrapper is hung waiting on an empty session — kill the session so the
    # wrapper exits and launchd respawns it. Otherwise leave it for launchd.
    if tmux has-session -t "$SESSION" 2>/dev/null; then
        claim_restart || exit 0
        log "Stale tmux session with no claude process — killing to trigger relaunch ($RESTART_COUNT/$MAX_RESTARTS)"
        tmux kill-session -t "$SESSION" 2>/dev/null || true
        [[ -x "$NOTIFY" ]] && "$NOTIFY" "⚠️ Bot restarted — claude CLI died inside live tmux session" || true
    fi
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
    for (( i=1; i<=12; i++ )); do
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

# ── Step 1c: Detect OAuth expiry ─────────────────────────────────────────────
# When the OAuth session dies, the bot still runs and the bun plugin is still
# loaded — it just can't call the API. Symptom is a "Please run /login" or
# "Not logged in" string appearing in the tmux pane. We alert the user once
# (de-duped via stamp file) and let the bot sit until it gets re-authed.
PANE_TEXT=""
if tmux has-session -t "$SESSION" 2>/dev/null; then
    PANE_TEXT=$(tmux capture-pane -t "$SESSION" -p 2>/dev/null || true)
fi

if [[ -n "$PANE_TEXT" ]] && grep -qE 'Not logged in|Please run /login' <<< "$PANE_TEXT"; then
    if [[ ! -f "$OAUTH_ALERT_STAMP" ]]; then
        log "OAuth session expired — bot is alive but unauthenticated. Alerting user."
        "$NOTIFY" "🔐 Bot OAuth session expired. Run: ~/bin/claude-bot-relogin.sh" || true
        touch "$OAUTH_ALERT_STAMP"
    fi
    # Don't kill or restart — that won't fix auth. Let the human handle it.
    exit 0
fi

# Reset the alert stamp once we're past the unauthenticated state, so the next
# expiry will alert again.
[[ -f "$OAUTH_ALERT_STAMP" ]] && rm -f "$OAUTH_ALERT_STAMP"

# ── Step 2: Check for bun child (Telegram plugin) ────────────────────────────
check_healthy() {
    pgrep -P "$CLAUDE_PID" bun > /dev/null 2>&1
}

if check_healthy; then
    log "HEALTHY (context: ${CTX_PCT:-unknown}%)"
    mark_healthy
    exit 0
fi

# ── Step 3: Grace period — re-check after 5s to avoid acting on transient state
sleep 5

if check_healthy; then
    # Transient blip — back to healthy.
    log "HEALTHY (recovered from transient)"
    mark_healthy
    exit 0
fi

# ── Step 3b: Detect the folder-trust prompt ──────────────────────────────────
# Claude Code asks whether to trust the project folder before it loads project
# settings. Headless, nobody answers, so the telegram plugin never starts.
# Checked only once the plugin is confirmed dead: the pane also shows chat
# text, which can quote the prompt while the bot is healthy.
if [[ -n "$PANE_TEXT" ]] && grep -qE 'Yes, I trust this folder|Is this a project you (created or one you )?trust' <<< "$PANE_TEXT"; then
    if [[ ! -f "$TRUST_ALERT_STAMP" ]]; then
        log "Folder-trust prompt is blocking startup. Alerting user."
        "$NOTIFY" "🔒 Bot blocked by folder-trust prompt. Run: tmux attach -t $SESSION, choose 'Yes, I trust this folder', then Ctrl+b d" || true
        touch "$TRUST_ALERT_STAMP"
    fi
    exit 0
fi

# ── Step 4: Plugin confirmed dead — act, unless restarts keep failing ────────
claim_restart || exit 0
log "Telegram plugin dead (no bun child of PID $CLAUDE_PID). Restarting bot ($RESTART_COUNT/$MAX_RESTARTS)."
tmux kill-session -t "$SESSION" 2>/dev/null || true

# ── Step 5: Poll for recovery (claude process + bun child both present) ──────
RECOVERED=false
for (( i=1; i<=RECOVERY_ATTEMPTS; i++ )); do
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
