#!/usr/bin/env bash
# Launch the Telegram bot with the current optimized system prompt.

set -euo pipefail

EXPERIMENT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROMPT_FILE="$EXPERIMENT_DIR/prompts/current.txt"

if [ ! -f "$PROMPT_FILE" ]; then
    echo "[deploy] ERROR: $PROMPT_FILE not found. Run the experiment first." >&2
    exit 1
fi

SYSTEM_PROMPT=$(cat "$PROMPT_FILE")
PROMPT_VERSION=$(readlink "$EXPERIMENT_DIR/prompts/current.txt" 2>/dev/null || echo "unknown")

echo "[deploy] Launching bot with prompt: $PROMPT_VERSION"
echo "[deploy] Preview (first 120 chars): ${SYSTEM_PROMPT:0:120}..."

exec claude \
    --append-system-prompt "$SYSTEM_PROMPT" \
    --channels plugin:telegram@claude-plugins-official
