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

EXPERIMENT_DIR="$HOME/projects/claude-telegram-bot"
SESSION="claude-bot"
LOG_DIR="$HOME/.claude/logs"

mkdir -p "$LOG_DIR"

if [[ ! -x "$EXPERIMENT_DIR/deploy/launch_bot.sh" ]]; then
    echo "[claude-bot-start] launch_bot.sh not found or not executable: $EXPERIMENT_DIR/deploy/launch_bot.sh" >&2
    exit 1
fi

if tmux kill-session -t "$SESSION" 2>/dev/null; then
    sleep 1
fi

BOT_PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
tmux new-session -d -s "$SESSION" \
    -e "PATH=$BOT_PATH" \
    "bash '$EXPERIMENT_DIR/deploy/launch_bot.sh'"

tmux pipe-pane -t "$SESSION" -o "cat >> '$LOG_DIR/claudebot.log'"

"$HOME/bin/claude-bot-notify.sh" "✅ Bot started" || true

while tmux has-session -t "$SESSION" 2>/dev/null; do
    sleep 2
done
