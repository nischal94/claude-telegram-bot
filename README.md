# claude-telegram-bot

A personal AI assistant running via Telegram, powered by Claude Code with full tool access (calendar, web search, filesystem).

## What it does

- Receives messages from Telegram and replies via the Telegram Bot API
- Runs as a persistent launchd service — starts on login, auto-restarts on failure
- A watchdog monitors the Telegram plugin subprocess and restarts the bot if it dies silently

## Project structure

```
bin/
  start.sh       — launchd wrapper: starts tmux session, blocks until exit
  watchdog.sh    — checks for dead Telegram plugin every ~30s, triggers restart
  notify.sh      — sends Telegram notifications via Bot API (used by watchdog + start)
deploy/
  launch_bot.sh  — launches claude with the system prompt and Telegram channel plugin
prompts/
  current.txt          — your live system prompt (gitignored, personal)
  system-prompt.example.txt — template to get started
launchd/
  com.nischal.claudebot.plist          — reference copy of the bot launchd service
  com.nischal.claudebot-watchdog.plist — reference copy of the watchdog launchd service
docs/
  plans/  — implementation plans
  specs/  — design specs
```

## Setup

### Prerequisites
- macOS with launchd
- [Claude Code](https://claude.ai/code) installed (`claude` on PATH)
- Telegram bot token (from [@BotFather](https://t.me/BotFather))
- Anthropic API key

### 1. Clone and configure

```bash
git clone https://github.com/nischal94/claude-telegram-bot.git ~/projects/claude-telegram-bot
```

### 2. Create your system prompt

```bash
cp prompts/system-prompt.example.txt prompts/current.txt
# Edit prompts/current.txt to personalise
```

### 3. Set up secrets

Add to `~/.claude/.env` (create if it doesn't exist):

```
ANTHROPIC_API_KEY=sk-ant-...
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_CHAT_ID=your-numeric-chat-id
```

To find your chat ID: message your bot, then visit:
`https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`

### 4. Install scripts to `~/bin/`

```bash
mkdir -p ~/bin
ln -s ~/projects/claude-telegram-bot/bin/start.sh    ~/bin/claude-bot-start.sh
ln -s ~/projects/claude-telegram-bot/bin/watchdog.sh ~/bin/claude-bot-watchdog.sh
ln -s ~/projects/claude-telegram-bot/bin/notify.sh   ~/bin/claude-bot-notify.sh
```

### 5. Install and load launchd services

```bash
cp launchd/com.nischal.claudebot.plist          ~/Library/LaunchAgents/
cp launchd/com.nischal.claudebot-watchdog.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.nischal.claudebot.plist
launchctl load ~/Library/LaunchAgents/com.nischal.claudebot-watchdog.plist
```

### 6. Verify

```bash
# Check both services are running
launchctl list | grep claudebot

# Check the bot session
tmux attach -t claude-bot
```

## Useful commands

```bash
# Restart bot (e.g. after prompt change)
launchctl kickstart -k gui/$(id -u)/com.nischal.claudebot

# Tail logs
tail -f ~/.claude/logs/claudebot.log
tail -f ~/.claude/logs/claudebot-watchdog.log

# Run watchdog manually
~/bin/claude-bot-watchdog.sh

# Stop everything
launchctl unload ~/Library/LaunchAgents/com.nischal.claudebot.plist
launchctl unload ~/Library/LaunchAgents/com.nischal.claudebot-watchdog.plist
```
