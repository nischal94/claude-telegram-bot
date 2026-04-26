#!/usr/bin/env bash
# Wrapper script called by launchd.
# Kills any stale "claude-bot" tmux session, creates a fresh one,
# then blocks until the session exits so launchd can track liveness.
#
# Secrets come from macOS Keychain (service names below). The ANTHROPIC_API_KEY
# is injected into the tmux session via a transient env file (mode 600) that is
# sourced and deleted before the bot exec — never via `tmux -e`, which would
# expose the value in the session's command-line arguments.
set -euo pipefail

EXPERIMENT_DIR="$HOME/projects/claude-telegram-bot"
SESSION="claude-bot"
LOG_DIR="$HOME/.claude/logs"
KEYCHAIN_SERVICE_ANTHROPIC="anthropic-api-claudebot"

mkdir -p "$LOG_DIR"

ANTHROPIC_API_KEY=$(security find-generic-password -s "$KEYCHAIN_SERVICE_ANTHROPIC" -w 2>/dev/null || true)
if [[ -z "$ANTHROPIC_API_KEY" ]]; then
    echo "[claude-bot-start] ANTHROPIC_API_KEY not found in Keychain (service: $KEYCHAIN_SERVICE_ANTHROPIC)" >&2
    exit 1
fi

if [[ ! -x "$EXPERIMENT_DIR/deploy/launch_bot.sh" ]]; then
    echo "[claude-bot-start] launch_bot.sh not found or not executable: $EXPERIMENT_DIR/deploy/launch_bot.sh" >&2
    exit 1
fi

if tmux kill-session -t "$SESSION" 2>/dev/null; then
    sleep 1
fi

# Write the key to a transient mode-600 file under the user's runtime dir.
# tmux will source and delete this file before exec'ing the bot. The key never
# appears in any process's argv.
ENV_TMP=$(mktemp "${TMPDIR:-/tmp}/claudebot-env.XXXXXX")
chmod 600 "$ENV_TMP"
printf 'export ANTHROPIC_API_KEY=%q\n' "$ANTHROPIC_API_KEY" > "$ENV_TMP"
unset ANTHROPIC_API_KEY

BOT_PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
tmux new-session -d -s "$SESSION" \
    -e "PATH=$BOT_PATH" \
    "bash -c 'source \"$ENV_TMP\" && rm -f \"$ENV_TMP\" && exec bash \"$EXPERIMENT_DIR/deploy/launch_bot.sh\"'"

tmux pipe-pane -t "$SESSION" -o "cat >> '$LOG_DIR/claudebot.log'"

"$HOME/bin/claude-bot-notify.sh" "✅ Bot started" || true

while tmux has-session -t "$SESSION" 2>/dev/null; do
    sleep 2
done
