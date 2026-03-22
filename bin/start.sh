#!/usr/bin/env bash
# Wrapper script called by launchd.
# Kills any stale "claude-bot" tmux session, creates a fresh one,
# then blocks until the session exits so launchd can track liveness.
set -euo pipefail

EXPERIMENT_DIR="$HOME/projects/claude-telegram-bot"
SESSION="claude-bot"
LOG_DIR="$HOME/.claude/logs"

mkdir -p "$LOG_DIR"

# Load API key from secrets file (never store in plist — it ends up in backups).
ENV_FILE="$HOME/.claude/.env"
if [[ ! -f "$ENV_FILE" ]]; then
    echo "[claude-bot-start] secrets file not found: $ENV_FILE" >&2
    exit 1
fi
# shellcheck source=/dev/null
source "$ENV_FILE"

if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
    echo "[claude-bot-start] ANTHROPIC_API_KEY not set in $ENV_FILE" >&2
    exit 1
fi

# Preflight: ensure launch script exists before starting.
if [[ ! -x "$EXPERIMENT_DIR/deploy/launch_bot.sh" ]]; then
    echo "[claude-bot-start] launch_bot.sh not found or not executable: $EXPERIMENT_DIR/deploy/launch_bot.sh" >&2
    exit 1
fi

# Kill stale session if it exists (prevents duplicate pollers on restart).
if tmux kill-session -t "$SESSION" 2>/dev/null; then
    # Give tmux a moment to clean up.
    sleep 1
fi

# Start a new detached session running the launch script.
# Claude needs a real PTY for interactive (--channels) mode — do NOT pipe stdout
# through tee as that breaks TTY detection and causes --print mode to activate.
# Use tmux pipe-pane for logging instead.
BOT_PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
tmux new-session -d -s "$SESSION" \
    -e "PATH=$BOT_PATH" \
    -e "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" \
    "bash '$EXPERIMENT_DIR/deploy/launch_bot.sh'"

# Pipe tmux pane output to log file (non-blocking, doesn't affect PTY).
tmux pipe-pane -t "$SESSION" -o "cat >> '$LOG_DIR/claudebot.log'"

# Notify that the bot session has been launched.
"$HOME/bin/claude-bot-notify.sh" "✅ Bot started" || true

# Block here until the session exits.
# When the bot crashes/exits, this returns and launchd will restart us.
while tmux has-session -t "$SESSION" 2>/dev/null; do
    sleep 2
done
