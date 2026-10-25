#!/usr/bin/env bash
# Launch the Telegram bot with the current optimized system prompt.

set -euo pipefail
# Files the bot and its child processes create are owner-only. The tmux
# server runs with umask 022 (see bin/start.sh), so set it here.
umask 077

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

# Build one prompt file: the main prompt, then the memory snapshot and the
# tool instructions when they exist. Passing it as a file keeps the prompt and
# the owner's memory out of the process list, which any local user can read.
ENGINE_DIR="$HOME/.claude/engine"
MEMORY_SNAPSHOT="$ENGINE_DIR/memory-snapshot.md"
MEMORY_INSTRUCTIONS="$EXPERIMENT_DIR/prompts/memory-tool-instructions.txt"
BOT_PROMPT="$ENGINE_DIR/bot-system-prompt.txt"

mkdir -p "$ENGINE_DIR"
chmod 700 "$ENGINE_DIR"
TMP_PROMPT=$(mktemp "$ENGINE_DIR/.bot-system-prompt.tmp.XXXXXX")
trap 'rm -f "$TMP_PROMPT"' EXIT
{
    printf '%s\n' "$SYSTEM_PROMPT"
    for part in "$MEMORY_SNAPSHOT" "$MEMORY_INSTRUCTIONS"; do
        if [ -f "$part" ]; then
            printf '\n'
            cat "$part"
        fi
    done
} > "$TMP_PROMPT"
mv -f "$TMP_PROMPT" "$BOT_PROMPT"

cd "$EXPERIMENT_DIR"
exec claude \
    --dangerously-skip-permissions \
    --append-system-prompt-file "$BOT_PROMPT" \
    --channels plugin:telegram@claude-plugins-official
