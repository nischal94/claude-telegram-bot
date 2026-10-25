#!/usr/bin/env bash
# Wrapper script called by launchd.
# Kills any stale "claude-bot" tmux session, creates a fresh one,
# then blocks until the session exits so launchd can track liveness.
#
# Authentication: Claude Code reads ANTHROPIC_API_KEY via the apiKeyHelper
# configured in ~/projects/claude-telegram-bot/.claude/settings.json. The
# helper script (~/.claude/scripts/anthropic-api-key-helper.sh) pulls the
# key from macOS Keychain. This script does not handle the Anthropic key
# directly — keeps it out of argv and out of any temp file on disk.
set -euo pipefail
# Files this script creates are owner-only, and so are files from a tmux
# server it starts. A tmux server that is already running keeps its own
# umask, which is why the bot log is also set to 0600 below.
umask 077

EXPERIMENT_DIR="$HOME/projects/claude-telegram-bot"
SESSION="claude-bot"
# "=" makes tmux match the session name exactly. Pane commands take "=name:".
TARGET="=$SESSION"
LOG_DIR="$HOME/.claude/logs"
BOT_LOG="$LOG_DIR/claudebot.log"

mkdir -p "$LOG_DIR"
# The log holds the bot's whole screen, chat included. Logs created before
# the umask above keep their old modes, so make the folder owner-only (which
# keeps every log in it private) and the bot log 0600. Each step runs on its
# own, so one failure does not skip the other. A failure is reported but does
# not stop the bot from starting.
if ! chmod 700 "$LOG_DIR"; then
    echo "[claude-bot-start] could not make $LOG_DIR owner-only" >&2
fi
if ! { touch "$BOT_LOG" && chmod 600 "$BOT_LOG"; }; then
    echo "[claude-bot-start] could not make $BOT_LOG owner-only" >&2
fi

if [[ ! -x "$EXPERIMENT_DIR/deploy/launch_bot.sh" ]]; then
    echo "[claude-bot-start] launch_bot.sh not found or not executable: $EXPERIMENT_DIR/deploy/launch_bot.sh" >&2
    exit 1
fi

if tmux kill-session -t "$TARGET" 2>/dev/null; then
    sleep 1
fi

BOT_PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
tmux new-session -d -s "$SESSION" \
    -e "PATH=$BOT_PATH" \
    "bash '$EXPERIMENT_DIR/deploy/launch_bot.sh'"

tmux pipe-pane -t "$TARGET:" -o "cat >> '$BOT_LOG'"

"$HOME/bin/claude-bot-notify.sh" "✅ Bot started" || true

while tmux has-session -t "$TARGET" 2>/dev/null; do
    sleep 2
done
