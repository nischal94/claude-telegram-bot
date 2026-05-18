#!/usr/bin/env bash
# Install (or reinstall) the github-trending launchd agents.
#
# Replaces the in-process node-cron scheduling that used to live in
# engine/src/jobs/register-trending-crons.ts. Each trending job now runs
# as its own native launchd agent — fully independent of the engine's
# lifecycle, so a stale or wedged engine can no longer suppress the
# Sunday/monthly digests.
#
# Idempotent: safe to re-run. Unloads any existing instance first.
#
# Credentials: the trending script reads TELEGRAM_BOT_TOKEN,
# TELEGRAM_CHAT_ID, and ANTHROPIC_API_KEY from macOS Keychain via
# engine/src/config.ts. Nothing credential-related happens here.
set -euo pipefail

REPO_DIR="$HOME/projects/claude-telegram-bot"
PLIST_SRC_DIR="$REPO_DIR/launchd"
PLIST_DEST_DIR="$HOME/Library/LaunchAgents"
UID_NUM="$(id -u)"
LOG_DIR="$HOME/.claude/logs"

AGENTS=(
    "com.nischal.github-trending-weekly"
    "com.nischal.github-trending-monthly"
)

mkdir -p "$PLIST_DEST_DIR" "$LOG_DIR"

for label in "${AGENTS[@]}"; do
    src="$PLIST_SRC_DIR/$label.plist"
    dest="$PLIST_DEST_DIR/$label.plist"

    if [[ ! -f "$src" ]]; then
        echo "[install-trending-launchd] source plist missing: $src" >&2
        exit 1
    fi

    # Unload any existing instance — ignore failures (agent may not be loaded).
    launchctl bootout "gui/$UID_NUM/$label" 2>/dev/null || true

    cp "$src" "$dest"

    launchctl bootstrap "gui/$UID_NUM" "$dest"

    echo "[install-trending-launchd] installed: $label"
done

echo "[install-trending-launchd] done. Verify with:"
echo "    launchctl list | grep github-trending"
echo "Trigger a job manually with:"
echo "    launchctl kickstart -k gui/$UID_NUM/com.nischal.github-trending-weekly"
