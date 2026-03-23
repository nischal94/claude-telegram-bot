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

TELEGRAM_BOT_TOKEN=$(grep -m1 '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
TELEGRAM_CHAT_ID=$(grep -m1 '^TELEGRAM_CHAT_ID=' "$ENV_FILE" | cut -d= -f2-)

if [[ -z "${TELEGRAM_BOT_TOKEN:-}" || -z "${TELEGRAM_CHAT_ID:-}" ]]; then
    echo "[claude-bot-notify] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set" >&2
    exit 0
fi

MAX_ATTEMPTS=3
DELAY=2
for i in $(seq 1 $MAX_ATTEMPTS); do
    if curl -s --max-time 10 -X POST \
        "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
        -d "chat_id=${TELEGRAM_CHAT_ID}" \
        --data-urlencode "text=${MSG}" \
        > /dev/null 2>&1; then
        break
    fi
    if [ "$i" -lt "$MAX_ATTEMPTS" ]; then
        sleep $DELAY
        DELAY=$((DELAY * 2))
    fi
done
exit 0
