#!/usr/bin/env bash
# Send a Telegram message via Bot API.
# Usage: claude-bot-notify.sh "message text"
# Reads TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID from macOS Keychain.
# Always exits 0 — notification failure must never block callers.
set -uo pipefail

MSG="${1:-}"
if [[ -z "$MSG" ]]; then
    echo "[claude-bot-notify] no message provided" >&2
    exit 0
fi

TELEGRAM_BOT_TOKEN=$(security find-generic-password -s "telegram-bot-token-claudebot" -w 2>/dev/null || true)
TELEGRAM_CHAT_ID=$(security find-generic-password -s "telegram-chat-id-claudebot" -w 2>/dev/null || true)

if [[ -z "$TELEGRAM_BOT_TOKEN" || -z "$TELEGRAM_CHAT_ID" ]]; then
    echo "[claude-bot-notify] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing from Keychain" >&2
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

unset TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID
exit 0
